'use strict';

/*
 * Stale-Draft Email Reminder.
 *
 * Fires once per user per cooldown window when they have a real draft invoice
 * that has been sitting unsent for 24h+. This is the email counterpart to the
 * in-app stale-draft dashboard prompt — it closes the activation gap for users
 * who never come back to the app on their own.
 *
 * Design mirrors jobs/trial-nudge.js and jobs/reminders.js:
 *   - `processStaleDraftEmails({ db, sendEmail, now, log })` is the pure
 *     orchestrator. Dependency-injected, no module state. Returns a structured
 *     summary { found, sent, skipped, errors, notConfigured } so tests can
 *     assert against it directly.
 *   - `startStaleDraftEmailJob(opts)` schedules via node-cron. A cron failure
 *     is logged and swallowed — a broken cron must never crash the web.
 *   - `RESEND_API_KEY` unset → sendEmail returns
 *     { ok:false, reason:'not_configured' } and we treat it as a clean skip
 *     (no DB stamp, next pass retries) so the job is safe to deploy before
 *     Master provisions the key.
 *   - Idempotency is enforced at the SQL layer:
 *     `stale_draft_email_sent_at IS NULL OR < NOW() - $cooldownDays days`
 *     means each user receives at most one email per cooldown window.
 *   - The query gates on `welcome_email_sent_at IS NOT NULL`, so a new signup
 *     gets the welcome email before any stale-draft nudge.
 */

const { db: realDb } = require('../db');
const { sendEmail: realSendEmail } = require('../lib/email');
const { escapeHtml, formatMoney } = require('../lib/html');

const DEFAULT_MIN_AGE_HOURS = 24;
const DEFAULT_COOLDOWN_DAYS = 7;
const DEFAULT_SCHEDULE = '0 11 * * *'; // 11:00 UTC daily (after trial-nudge at 10:00)

function hoursOld(draftCreatedAt, now = new Date()) {
  if (!draftCreatedAt) return 0;
  const created = new Date(draftCreatedAt).getTime();
  if (!Number.isFinite(created)) return 0;
  const diff = now.getTime() - created;
  return Math.max(0, Math.floor(diff / 3600000));
}

function greetingName(row) {
  return row.name || row.business_name || 'there';
}

function resolveReplyTo(row) {
  if (!row) return null;
  return row.reply_to_email || row.business_email || row.email || null;
}

function ctaUrl(row) {
  const base = (process.env.APP_URL || '').replace(/\/+$/, '');
  if (!base || !row || row.invoice_id == null) return '';
  return `${base}/invoices/${row.invoice_id}`;
}

function buildStaleDraftSubject(row, now = new Date()) {
  const number = (row && row.invoice_number) || 'your invoice';
  const hours = hoursOld(row && row.draft_created_at, now);
  // Bucket hours into "24+", "48+", etc — the actual number drifts every
  // minute and we don't want minute-precision in a subject line.
  const bucket = hours >= 48 ? Math.floor(hours / 24) * 24 : 24;
  return `${number} has been a draft for ${bucket}+ hours — send it?`;
}

function buildStaleDraftHtml(row, now = new Date()) {
  const number = (row && row.invoice_number) || '';
  const clientName = (row && row.client_name) || 'your client';
  const total = formatMoney(row && row.invoice_total);
  const hours = hoursOld(row && row.draft_created_at, now);
  const greeting = greetingName(row);
  const url = ctaUrl(row);
  const ctaButton = url
    ? `<p style="margin:24px 0;"><a href="${escapeHtml(url)}" style="background:#4f46e5;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px;display:inline-block;">Open draft &amp; send</a></p>`
    : '';

  return `<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#222;background:#f7f7f9;margin:0;padding:24px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #eaeaea;">
  <tr><td style="padding:24px 28px;">
    <h2 style="margin:0 0 8px 0;color:#111;">Your invoice ${escapeHtml(number)} is still a draft</h2>
    <p style="color:#222;margin:8px 0;font-size:16px;">Hi ${escapeHtml(greeting)},</p>
    <p style="color:#222;margin:8px 0;font-size:16px;">Invoice <strong>${escapeHtml(number)}</strong> for <strong>${escapeHtml(clientName)}</strong> (<strong>${escapeHtml(total)}</strong>) has been sitting in your drafts for <strong>${hours} hours</strong>. Until you send it, your client can't see it — and you can't get paid for it.</p>
    <p style="color:#222;margin:8px 0;font-size:16px;">It's one click away from being on its way:</p>
    <ul style="color:#222;margin:8px 0 16px 20px;font-size:15px;line-height:1.6;">
      <li>Open the draft</li>
      <li>Double-check the line items + total</li>
      <li>Mark it Sent — your client receives the link, and you've started the get-paid clock</li>
    </ul>
    ${ctaButton}
    <p style="color:#999;font-size:12px;margin-top:24px;">Sent automatically by DecentInvoice. If you've already sent this invoice another way, mark it Sent on the dashboard and we'll stop reminding you.</p>
  </td></tr>
</table>
</body></html>`;
}

function buildStaleDraftText(row, now = new Date()) {
  const number = (row && row.invoice_number) || '';
  const clientName = (row && row.client_name) || 'your client';
  const total = formatMoney(row && row.invoice_total);
  const hours = hoursOld(row && row.draft_created_at, now);
  const greeting = greetingName(row);
  const url = ctaUrl(row);
  const lines = [
    `Hi ${greeting},`,
    '',
    `Invoice ${number} for ${clientName} (${total}) has been a draft for ${hours} hours. `
      + 'Until you send it, your client can\'t see it — and you can\'t get paid for it.',
    '',
    'One-click to open the draft, double-check it, and mark it Sent:'
  ];
  if (url) {
    lines.push('', url);
  }
  lines.push('', 'If you\'ve already sent this invoice another way, mark it Sent on the dashboard and we\'ll stop reminding you.');
  return lines.join('\n');
}

async function processStaleDraftEmails(opts = {}) {
  const db = opts.db || realDb;
  const sendEmail = opts.sendEmail || realSendEmail;
  const now = opts.now || new Date();
  const minAgeHours = opts.minAgeHours || DEFAULT_MIN_AGE_HOURS;
  const cooldownDays = opts.cooldownDays || DEFAULT_COOLDOWN_DAYS;
  const log = opts.log || console;

  const summary = { found: 0, sent: 0, skipped: 0, errors: 0, notConfigured: 0 };

  let rows;
  try {
    rows = await db.getUsersWithStaleDraftForEmail(minAgeHours, cooldownDays);
  } catch (err) {
    log.error && log.error('stale-draft-email query failed:', err && err.message);
    summary.errors += 1;
    return summary;
  }
  rows = rows || [];
  summary.found = rows.length;

  for (const row of rows) {
    if (!row.email) {
      summary.skipped += 1;
      continue;
    }

    let result;
    try {
      result = await sendEmail({
        to: row.email,
        subject: buildStaleDraftSubject(row, now),
        html: buildStaleDraftHtml(row, now),
        text: buildStaleDraftText(row, now),
        replyTo: resolveReplyTo(row)
      });
    } catch (err) {
      log.error && log.error(`stale-draft email send threw for user ${row.user_id}:`, err && err.message);
      summary.errors += 1;
      continue;
    }

    if (!result || result.ok !== true) {
      if (result && result.reason === 'not_configured') {
        summary.notConfigured += 1;
      } else {
        summary.errors += 1;
        log.warn && log.warn(`stale-draft email for user ${row.user_id} failed:`,
          (result && (result.reason || result.error)) || 'unknown');
      }
      continue;
    }

    try {
      await db.markStaleDraftEmailSent(row.user_id);
      summary.sent += 1;
    } catch (err) {
      log.error && log.error(`failed to stamp stale_draft_email_sent_at for user ${row.user_id}:`, err && err.message);
      summary.errors += 1;
    }
  }

  return summary;
}

let _scheduledTask = null;

function startStaleDraftEmailJob(opts = {}) {
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
    console.error('node-cron not available; stale-draft-email job disabled:', err && err.message);
    return { ok: false, reason: 'cron_unavailable' };
  }

  const schedule = opts.schedule || process.env.STALE_DRAFT_EMAIL_CRON_SCHEDULE || DEFAULT_SCHEDULE;
  const log = opts.log || console;

  try {
    _scheduledTask = cron.schedule(schedule, async () => {
      try {
        const summary = await processStaleDraftEmails(opts);
        log.log && log.log(
          `[stale-draft-email] found=${summary.found} sent=${summary.sent} skipped=${summary.skipped} `
          + `errors=${summary.errors} notConfigured=${summary.notConfigured}`
        );
      } catch (err) {
        log.error && log.error('stale-draft-email cron tick failed:', err && err.message);
      }
    }, { timezone: 'UTC' });
  } catch (err) {
    console.error('failed to schedule stale-draft-email cron:', err && err.message);
    return { ok: false, reason: 'schedule_failed', error: err && err.message };
  }

  return { ok: true, schedule };
}

function stopStaleDraftEmailJob() {
  if (_scheduledTask && typeof _scheduledTask.stop === 'function') {
    try { _scheduledTask.stop(); } catch (_) { /* ignore */ }
  }
  _scheduledTask = null;
}

module.exports = {
  processStaleDraftEmails,
  startStaleDraftEmailJob,
  stopStaleDraftEmailJob,
  buildStaleDraftSubject,
  buildStaleDraftHtml,
  buildStaleDraftText,
  hoursOld,
  DEFAULT_MIN_AGE_HOURS,
  DEFAULT_COOLDOWN_DAYS,
  DEFAULT_SCHEDULE,
  _internal: { escapeHtml, formatMoney, greetingName, resolveReplyTo, ctaUrl }
};
