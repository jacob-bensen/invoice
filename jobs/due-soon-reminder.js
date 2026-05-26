'use strict';

/*
 * Pre-due-date "Heads up — invoice X is due in N days" client reminder cron
 * (Milestone 4 — first invoice sent → first payment received).
 *
 * Existing jobs/reminders.js fires ONLY after due_date passes (overdue).
 * This job catches the cohort one step upstream: a sent invoice that's
 * 1–2 days from due_date but not yet overdue. Single fire per invoice
 * via due_soon_reminder_sent_at; the SQL window-then-IS-NULL gate makes
 * a missed cron tick recoverable on the next day.
 *
 * Design mirrors jobs/reminders.js:
 *   - `processDueSoonReminders({ db, sendEmail, now, log })` is the pure
 *     orchestrator. Returns { found, sent, skipped, errors, notConfigured }.
 *   - `startDueSoonReminderJob(opts)` schedules with node-cron, swallows
 *     setup errors so a broken cron never takes down the web process.
 *   - SQL-layer + JS-layer plan gate (`pro|business|agency`). Free-plan
 *     never emails the client.
 *   - `RESEND_API_KEY` unset → `not_configured` → clean skip (no DB stamp,
 *     next tick retries) so the job is a safe no-op until ops provisions
 *     Resend.
 */

const { db: realDb } = require('../db');
const { sendEmail: realSendEmail } = require('../lib/email');
const { escapeHtml, formatMoney } = require('../lib/html');

const DEFAULT_DAYS_AHEAD = 2;
const DEFAULT_SCHEDULE = '0 10 * * *'; // 10:00 UTC daily (1h after reminders.js)
const PAID_PLANS = new Set(['pro', 'business', 'agency']);

function formatDate(d) {
  if (!d) return '';
  try {
    return new Date(d).toISOString().slice(0, 10);
  } catch (_) {
    return '';
  }
}

function ownerSenderName(row) {
  return row.owner_business_name || row.owner_name || row.owner_email || 'DecentInvoice';
}

function ownerReplyTo(row) {
  return row.owner_reply_to_email || row.owner_business_email || row.owner_email || null;
}

/*
 * Days until due, floored. 0 means "due today". Negative values are
 * clamped to 0 — an already-overdue row shouldn't reach this orchestrator
 * (the SQL gate excludes due_date < CURRENT_DATE) but we defend in depth.
 */
function daysUntilDue(row, now = new Date()) {
  if (!row.due_date) return 0;
  const due = new Date(row.due_date).getTime();
  if (!Number.isFinite(due)) return 0;
  // Anchor both ends to UTC midnight so server-TZ drift can't flip an
  // invoice from "due tomorrow" to "due today" mid-tick.
  const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dueUTC = Date.UTC(
    new Date(due).getUTCFullYear(),
    new Date(due).getUTCMonth(),
    new Date(due).getUTCDate()
  );
  const diff = dueUTC - todayUTC;
  return Math.max(0, Math.floor(diff / 86400000));
}

function buildDueSoonSubject(row, now = new Date()) {
  const days = daysUntilDue(row, now);
  const num = row.invoice_number || '';
  if (days === 0) {
    return `Heads up: invoice ${num} is due today`.trim();
  }
  if (days === 1) {
    return `Heads up: invoice ${num} is due tomorrow`.trim();
  }
  return `Heads up: invoice ${num} is due in ${days} days`.trim();
}

function dueClauseText(row, now) {
  const days = daysUntilDue(row, now);
  const due = formatDate(row.due_date);
  if (days === 0) return `is due today (${due})`;
  if (days === 1) return `is due tomorrow (${due})`;
  return `is due in ${days} days (on ${due})`;
}

function buildDueSoonHtml(row, now = new Date()) {
  const sender = ownerSenderName(row);
  const total = formatMoney(row.total);
  const dueClause = dueClauseText(row, now);
  const payButton = row.payment_link_url
    ? `<p style="margin:24px 0;"><a href="${escapeHtml(row.payment_link_url)}" style="background:#4f46e5;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px;display:inline-block;">Pay invoice ${escapeHtml(row.invoice_number || '')}</a></p>`
    : '';

  return `<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#222;background:#f7f7f9;margin:0;padding:24px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #eaeaea;">
  <tr><td style="padding:24px 28px;">
    <h2 style="margin:0 0 8px 0;color:#111;">A quick heads up about invoice ${escapeHtml(row.invoice_number || '')}</h2>
    <p style="color:#555;margin:4px 0;">From <strong>${escapeHtml(sender)}</strong></p>
    <p style="color:#555;margin:16px 0 4px 0;">Hi ${escapeHtml(row.client_name || 'there')},</p>
    <p style="color:#555;margin:4px 0 16px 0;">Just a friendly heads up — invoice <strong>${escapeHtml(row.invoice_number || '')}</strong> for <strong>${escapeHtml(total)}</strong> ${escapeHtml(dueClause)}.</p>
    <p style="color:#555;margin:4px 0;">If you've already sent payment, please ignore this message — and thank you. Otherwise, here's a one-click way to settle up before the due date.</p>
    ${payButton}
    <p style="color:#999;font-size:12px;margin-top:24px;">Sent automatically by DecentInvoice on behalf of ${escapeHtml(sender)}. Reply to this email to reach them directly.</p>
  </td></tr>
</table>
</body></html>`;
}

function buildDueSoonText(row, now = new Date()) {
  const sender = ownerSenderName(row);
  const total = formatMoney(row.total);
  const dueClause = dueClauseText(row, now);
  const lines = [
    `Hi ${row.client_name || 'there'},`,
    '',
    `Friendly heads up — invoice ${row.invoice_number || ''} for ${total} from ${sender} ${dueClause}.`,
  ];
  if (row.payment_link_url) {
    lines.push('', `Pay online: ${row.payment_link_url}`);
  }
  lines.push('', `Reply to this email to reach ${sender} directly.`);
  return lines.join('\n');
}

async function processDueSoonReminders(opts = {}) {
  const db = opts.db || realDb;
  const sendEmail = opts.sendEmail || realSendEmail;
  const now = opts.now || new Date();
  const daysAhead = opts.daysAhead || DEFAULT_DAYS_AHEAD;
  const log = opts.log || console;

  const summary = { found: 0, sent: 0, skipped: 0, errors: 0, notConfigured: 0 };

  let rows;
  try {
    rows = await db.getSentInvoicesDueSoon(daysAhead);
  } catch (err) {
    log.error && log.error('due-soon query failed:', err && err.message);
    summary.errors += 1;
    return summary;
  }
  rows = rows || [];
  summary.found = rows.length;

  for (const row of rows) {
    if (!PAID_PLANS.has((row.owner_plan || '').toLowerCase())) {
      summary.skipped += 1;
      continue;
    }
    if (!row.client_email) {
      summary.skipped += 1;
      continue;
    }

    let result;
    try {
      result = await sendEmail({
        to: row.client_email,
        subject: buildDueSoonSubject(row, now),
        html: buildDueSoonHtml(row, now),
        text: buildDueSoonText(row, now),
        replyTo: ownerReplyTo(row)
      });
    } catch (err) {
      log.error && log.error(`due-soon send threw for invoice ${row.invoice_id}:`, err && err.message);
      summary.errors += 1;
      continue;
    }

    if (!result || result.ok !== true) {
      if (result && result.reason === 'not_configured') {
        summary.notConfigured += 1;
      } else {
        summary.errors += 1;
        log.warn && log.warn(`due-soon for invoice ${row.invoice_id} failed:`,
          (result && (result.reason || result.error)) || 'unknown');
      }
      continue;
    }

    try {
      await db.markInvoiceDueSoonReminderSent(row.invoice_id);
      summary.sent += 1;
    } catch (err) {
      log.error && log.error(`failed to stamp due_soon_reminder_sent_at for invoice ${row.invoice_id}:`, err && err.message);
      summary.errors += 1;
    }
  }

  return summary;
}

let _scheduledTask = null;

function startDueSoonReminderJob(opts = {}) {
  if (process.env.NODE_ENV === 'test' && !opts.force) {
    return { ok: false, reason: 'test_env' };
  }
  if (_scheduledTask) {
    return { ok: false, reason: 'already_running' };
  }

  let cron;
  try {
    cron = opts.cron || require('node-cron');
  } catch (err) {
    console.error('node-cron not available; due-soon reminder job disabled:', err && err.message);
    return { ok: false, reason: 'cron_unavailable' };
  }

  const schedule = opts.schedule || process.env.DUE_SOON_REMINDER_CRON_SCHEDULE || DEFAULT_SCHEDULE;
  const log = opts.log || console;

  try {
    _scheduledTask = cron.schedule(schedule, async () => {
      try {
        const summary = await processDueSoonReminders(opts);
        log.log && log.log(
          `[due-soon-reminder] found=${summary.found} sent=${summary.sent} skipped=${summary.skipped} `
          + `errors=${summary.errors} notConfigured=${summary.notConfigured}`
        );
      } catch (err) {
        log.error && log.error('due-soon cron tick failed:', err && err.message);
      }
    }, { timezone: 'UTC' });
  } catch (err) {
    console.error('failed to schedule due-soon reminder cron:', err && err.message);
    return { ok: false, reason: 'schedule_failed', error: err && err.message };
  }

  return { ok: true, schedule };
}

function stopDueSoonReminderJob() {
  if (_scheduledTask && typeof _scheduledTask.stop === 'function') {
    try { _scheduledTask.stop(); } catch (_) { /* ignore */ }
  }
  _scheduledTask = null;
}

module.exports = {
  processDueSoonReminders,
  startDueSoonReminderJob,
  stopDueSoonReminderJob,
  buildDueSoonSubject,
  buildDueSoonHtml,
  buildDueSoonText,
  daysUntilDue,
  DEFAULT_DAYS_AHEAD,
  DEFAULT_SCHEDULE,
  PAID_PLANS,
  _internal: { escapeHtml, formatMoney, formatDate, ownerSenderName, ownerReplyTo, dueClauseText }
};
