'use strict';

/*
 * Automated payment reminders (INTERNAL_TODO #16).
 *
 * Daily cron picks up Pro/Business/Agency invoices that are status='sent',
 * past their due date, and haven't been reminded in the last 3 days. For each
 * one we email the client a friendly "your invoice is overdue" nudge, then
 * stamp `last_reminder_sent_at` so the next pass skips it.
 *
 * Design:
 *   - `processOverdueReminders({ db, sendEmail, now, log })` is the pure
 *     orchestrator: dependency-injected, no module-level state, no cron
 *     reference. Returns a structured summary { found, sent, skipped, errors }
 *     so tests can assert against it directly.
 *   - `startReminderJob(opts)` schedules the orchestrator with node-cron. It
 *     never crashes the server: a require('node-cron') failure (or any other
 *     setup error) is logged and swallowed. The reminder feature degrading
 *     gracefully is preferable to taking down the web server.
 *   - The email send is plan-gated at the SQL layer (`u.plan IN ('pro',
 *     'business', 'agency')`) AND re-checked in JS (`PAID_PLANS.has`) so a
 *     bad join can't accidentally email a free user's clients. Defence in
 *     depth.
 *   - When `RESEND_API_KEY` is unset, lib/email.sendEmail returns
 *     { ok:false, reason:'not_configured' }. We treat that as a clean skip
 *     (no DB stamp, the next run retries) so the job is a safe no-op until
 *     Master provisions the key. See TODO_MASTER.
 */

const { db: realDb } = require('../db');
const { sendEmail: realSendEmail } = require('../lib/email');

const DEFAULT_COOLDOWN_DAYS = 3;
const DEFAULT_SCHEDULE = '0 9 * * *'; // 09:00 UTC daily
const PAID_PLANS = new Set(['pro', 'business', 'agency']);

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatMoney(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '$0.00';
  return `$${n.toFixed(2)}`;
}

function formatDate(d) {
  if (!d) return '';
  try {
    return new Date(d).toISOString().slice(0, 10);
  } catch (_) {
    return '';
  }
}

function ownerSenderName(row) {
  return row.owner_business_name || row.owner_name || row.owner_email || 'QuickInvoice';
}

function ownerReplyTo(row) {
  return row.owner_reply_to_email || row.owner_business_email || row.owner_email || null;
}

function daysOverdue(row, now = new Date()) {
  if (!row.due_date) return 0;
  const due = new Date(row.due_date).getTime();
  if (!Number.isFinite(due)) return 0;
  const diff = now.getTime() - due;
  return Math.max(0, Math.floor(diff / 86400000));
}

function buildReminderSubject(row) {
  return `Friendly reminder: Invoice ${row.invoice_number || ''} is overdue`;
}

function buildReminderHtml(row, now = new Date()) {
  const sender = ownerSenderName(row);
  const total = formatMoney(row.total);
  const due = formatDate(row.due_date);
  const overdue = daysOverdue(row, now);
  const overdueLine = overdue > 0
    ? `<p style="color:#b91c1c;margin:4px 0;"><strong>${overdue} day${overdue === 1 ? '' : 's'} overdue.</strong></p>`
    : '';
  const payButton = row.payment_link_url
    ? `<p style="margin:24px 0;"><a href="${escapeHtml(row.payment_link_url)}" style="background:#4f46e5;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px;display:inline-block;">Pay invoice ${escapeHtml(row.invoice_number || '')}</a></p>`
    : '';

  return `<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#222;background:#f7f7f9;margin:0;padding:24px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #eaeaea;">
  <tr><td style="padding:24px 28px;">
    <h2 style="margin:0 0 8px 0;color:#111;">Quick reminder about invoice ${escapeHtml(row.invoice_number || '')}</h2>
    <p style="color:#555;margin:4px 0;">From <strong>${escapeHtml(sender)}</strong></p>
    <p style="color:#555;margin:16px 0 4px 0;">Hi ${escapeHtml(row.client_name || 'there')},</p>
    <p style="color:#555;margin:4px 0 16px 0;">Just a friendly nudge — invoice <strong>${escapeHtml(row.invoice_number || '')}</strong> for <strong>${escapeHtml(total)}</strong> was due on <strong>${escapeHtml(due)}</strong> and is now past due.</p>
    ${overdueLine}
    <p style="color:#555;margin:4px 0;">If you've already sent payment, please ignore this message — and thank you. Otherwise, you can settle up using the link below.</p>
    ${payButton}
    <p style="color:#999;font-size:12px;margin-top:24px;">Sent automatically by QuickInvoice on behalf of ${escapeHtml(sender)}. Reply to this email to reach them directly.</p>
  </td></tr>
</table>
</body></html>`;
}

function buildReminderText(row, now = new Date()) {
  const sender = ownerSenderName(row);
  const total = formatMoney(row.total);
  const due = formatDate(row.due_date);
  const overdue = daysOverdue(row, now);
  const lines = [
    `Hi ${row.client_name || 'there'},`,
    '',
    `Friendly reminder that invoice ${row.invoice_number || ''} for ${total} from ${sender} `
      + `was due on ${due}${overdue > 0 ? ` (${overdue} day${overdue === 1 ? '' : 's'} overdue)` : ''}.`,
  ];
  if (row.payment_link_url) {
    lines.push('', `Pay online: ${row.payment_link_url}`);
  }
  lines.push('', `Reply to this email to reach ${sender} directly.`);
  return lines.join('\n');
}

async function processOverdueReminders(opts = {}) {
  const db = opts.db || realDb;
  const sendEmail = opts.sendEmail || realSendEmail;
  const now = opts.now || new Date();
  const cooldownDays = opts.cooldownDays || DEFAULT_COOLDOWN_DAYS;
  const log = opts.log || console;

  const summary = { found: 0, sent: 0, skipped: 0, errors: 0, notConfigured: 0 };

  let rows;
  try {
    rows = await db.getOverdueInvoicesForReminders(cooldownDays);
  } catch (err) {
    log.error && log.error('reminder query failed:', err && err.message);
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
        subject: buildReminderSubject(row),
        html: buildReminderHtml(row, now),
        text: buildReminderText(row, now),
        replyTo: ownerReplyTo(row)
      });
    } catch (err) {
      log.error && log.error(`reminder send threw for invoice ${row.invoice_id}:`, err && err.message);
      summary.errors += 1;
      continue;
    }

    if (!result || result.ok !== true) {
      // not_configured = Resend API key absent. Don't stamp the DB so the
      // next pass retries once Master provisions the key.
      if (result && result.reason === 'not_configured') {
        summary.notConfigured += 1;
      } else {
        summary.errors += 1;
        log.warn && log.warn(`reminder for invoice ${row.invoice_id} failed:`,
          (result && (result.reason || result.error)) || 'unknown');
      }
      continue;
    }

    try {
      await db.markInvoiceReminderSent(row.invoice_id);
      summary.sent += 1;
    } catch (err) {
      log.error && log.error(`failed to stamp last_reminder_sent_at for invoice ${row.invoice_id}:`, err && err.message);
      summary.errors += 1;
    }
  }

  return summary;
}

let _scheduledTask = null;

function startReminderJob(opts = {}) {
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
    console.error('node-cron not available; reminder job disabled:', err && err.message);
    return { ok: false, reason: 'cron_unavailable' };
  }

  const schedule = opts.schedule || process.env.REMINDER_CRON_SCHEDULE || DEFAULT_SCHEDULE;
  const log = opts.log || console;

  try {
    _scheduledTask = cron.schedule(schedule, async () => {
      try {
        const summary = await processOverdueReminders(opts);
        log.log && log.log(
          `[reminders] found=${summary.found} sent=${summary.sent} skipped=${summary.skipped} `
          + `errors=${summary.errors} notConfigured=${summary.notConfigured}`
        );
      } catch (err) {
        log.error && log.error('reminder cron tick failed:', err && err.message);
      }
    }, { timezone: 'UTC' });
  } catch (err) {
    console.error('failed to schedule reminder cron:', err && err.message);
    return { ok: false, reason: 'schedule_failed', error: err && err.message };
  }

  return { ok: true, schedule };
}

function stopReminderJob() {
  if (_scheduledTask && typeof _scheduledTask.stop === 'function') {
    try { _scheduledTask.stop(); } catch (_) { /* ignore */ }
  }
  _scheduledTask = null;
}

module.exports = {
  processOverdueReminders,
  startReminderJob,
  stopReminderJob,
  buildReminderSubject,
  buildReminderHtml,
  buildReminderText,
  daysOverdue,
  DEFAULT_COOLDOWN_DAYS,
  DEFAULT_SCHEDULE,
  PAID_PLANS,
  _internal: { escapeHtml, formatMoney, formatDate, ownerSenderName, ownerReplyTo }
};
