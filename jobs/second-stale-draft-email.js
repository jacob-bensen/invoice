'use strict';

/*
 * Second Stale-Draft Email — terminal follow-up on a still-unsent draft.
 *
 * Cohort: users whose first stale-draft email fired at least 7 days ago
 * (`stale_draft_email_sent_at <= NOW() - 7d`) and STILL have a real draft
 * invoice sitting unsent (`invoices.status='draft' AND is_seed=false AND
 * created_at <= NOW() - 24h`). Pre-this-job the original stale-draft cron
 * would re-send the same copy every 7 days forever. This second pass
 * replaces the repetition with a single, sharper "is anything specific
 * stopping you? hit reply" email and then stops. Original stale-draft is
 * suppressed for these users via the matching
 * `AND second_stale_draft_email_sent_at IS NULL` gate on its query, so a
 * recipient gets at most one first nudge + one terminal second nudge for
 * their draft and then drops off the email-cohort entirely.
 *
 * Design mirrors jobs/stale-draft-email.js + jobs/second-no-invoice-nudge.js:
 *   - processSecondStaleDraftEmails({ db, sendEmail, ... }) is the pure
 *     dependency-injected orchestrator. Returns a structured summary.
 *   - startSecondStaleDraftEmailJob(opts) schedules via node-cron at 11:30
 *     UTC daily (30 minutes after the first stale-draft at 11:00 UTC — same
 *     morning slot, never both fire for the same row since each cohort row
 *     matches exactly one of the two queries).
 *   - RESEND_API_KEY unset → not_configured → clean skip, no stamp, retry
 *     next tick.
 *   - Magic-login bake-in: 7-day token + ?next=/invoices/<id> so the click
 *     auto-signs-in and lands directly on the draft, regardless of whether
 *     the recipient's original session expired.
 *   - Idempotency at the SQL layer: second_stale_draft_email_sent_at IS NULL
 *     guarantees one-shot per user.
 */

const { db: realDb } = require('../db');
const { sendEmail: realSendEmail } = require('../lib/email');
const { escapeHtml, formatMoney } = require('../lib/html');
const { mintMagicLoginToken: realMintMagicLoginToken } = require('../lib/magic-login');

const DEFAULT_MIN_AGE_HOURS = 24;
const DEFAULT_FIRST_SENT_GAP_DAYS = 7;
const DEFAULT_SCHEDULE = '30 11 * * *'; // 11:30 UTC daily (30 min after first stale-draft at 11:00)
// 7-day TTL matches every other re-engagement email — the click window for
// a "is something stopping you?" reminder is "later today through end-of-week".
const NUDGE_TTL_MINUTES = 7 * 24 * 60;

function hoursOld(draftCreatedAt, now) {
  if (!draftCreatedAt) return 0;
  const created = new Date(draftCreatedAt).getTime();
  if (!Number.isFinite(created)) return 0;
  const ref = (now instanceof Date && !isNaN(now.getTime())) ? now : new Date();
  const diff = ref.getTime() - created;
  return Math.max(0, Math.floor(diff / 3600000));
}

function daysOld(draftCreatedAt, now) {
  const h = hoursOld(draftCreatedAt, now);
  return Math.max(1, Math.floor(h / 24));
}

function greetingName(row) {
  return (row && (row.name || row.business_name)) || 'there';
}

function resolveReplyTo(row) {
  if (!row) return null;
  return row.reply_to_email || row.business_email || row.email || null;
}

function ctaUrl(row, opts) {
  if (!row || row.invoice_id == null) return '';
  const magicLoginUrl = opts && typeof opts.magicLoginUrl === 'string'
    ? opts.magicLoginUrl.trim() : '';
  if (magicLoginUrl) {
    return `${magicLoginUrl}?next=/invoices/${row.invoice_id}`;
  }
  const base = (process.env.APP_URL || '').replace(/\/+$/, '');
  if (!base) return '';
  return `${base}/invoices/${row.invoice_id}`;
}

function buildSecondStaleDraftSubject() {
  // No PII in the subject — the inbox preview doesn't leak the cohort to
  // anyone glancing at the screen. Distinguishable from the first nudge's
  // "X has been a draft for 24+ hours — send it?" via the empathetic ask.
  return "Anything blocking that invoice? Hit reply.";
}

function buildSecondStaleDraftHtml(row, now = new Date(), opts) {
  const number = (row && row.invoice_number) || '';
  const clientName = (row && row.client_name) || 'your client';
  const total = formatMoney(row && row.invoice_total);
  const days = daysOld(row && row.draft_created_at, now);
  const greeting = greetingName(row);
  const url = ctaUrl(row, opts);
  const ctaButton = url
    ? `<p style="margin:24px 0;"><a href="${escapeHtml(url)}" style="background:#4f46e5;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px;display:inline-block;">Open draft &amp; send</a></p>`
    : '';

  return `<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#222;background:#f7f7f9;margin:0;padding:24px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #eaeaea;">
  <tr><td style="padding:24px 28px;">
    <h2 style="margin:0 0 8px 0;color:#111;">Is anything stopping you sending this?</h2>
    <p style="color:#222;margin:8px 0;font-size:16px;">Hi ${escapeHtml(greeting)},</p>
    <p style="color:#222;margin:8px 0;font-size:16px;">Your draft invoice <strong>${escapeHtml(number)}</strong> for <strong>${escapeHtml(clientName)}</strong> (<strong>${escapeHtml(total)}</strong>) has been waiting for <strong>${days} days</strong>. We sent you a nudge a week ago and it's still sitting there — usually that means one of these:</p>
    <ul style="color:#222;margin:8px 0 16px 20px;font-size:15px;line-height:1.6;">
      <li>You're not sure the total is right yet (still waiting on a final number from the client).</li>
      <li>Something about how the email/share will look to the client is making you hesitate.</li>
      <li>The job isn't actually done yet and you're holding the invoice until it is.</li>
      <li>You already invoiced this client another way and forgot to mark this one Sent.</li>
    </ul>
    <p style="color:#222;margin:8px 0;font-size:15px;">If any of those ring a bell, just hit reply — we read every one and most folks are unblocked in a single back-and-forth.</p>
    <p style="color:#222;margin:8px 0;font-size:15px;">If it's ready to ship and you just need a one-click in, here it is:</p>
    ${ctaButton}
    <p style="color:#999;font-size:12px;margin-top:24px;">Sent automatically by DecentInvoice. This is the last reminder we'll send about this draft — if you've already sent the invoice another way, open it on the dashboard and mark it Sent.</p>
  </td></tr>
</table>
</body></html>`;
}

function buildSecondStaleDraftText(row, now = new Date(), opts) {
  const number = (row && row.invoice_number) || '';
  const clientName = (row && row.client_name) || 'your client';
  const total = formatMoney(row && row.invoice_total);
  const days = daysOld(row && row.draft_created_at, now);
  const greeting = greetingName(row);
  const url = ctaUrl(row, opts);
  const lines = [
    `Hi ${greeting},`,
    '',
    `Your draft invoice ${number} for ${clientName} (${total}) has been waiting for ${days} days. `
      + "We sent you a nudge a week ago and it's still sitting there — usually that means one of these:",
    '',
    "  - You're not sure the total is right yet.",
    '  - Something about how the share/email will look is making you hesitate.',
    "  - The job isn't actually done yet and you're holding the invoice.",
    '  - You already invoiced this client another way and forgot to mark this one Sent.',
    '',
    'If any of those ring a bell, just hit reply — we read every one and most folks are unblocked in a single back-and-forth.',
    '',
    'If it\'s ready to ship and you just need a one-click in:'
  ];
  if (url) {
    lines.push('', url);
  }
  lines.push('', "This is the last reminder we'll send about this draft.");
  return lines.join('\n');
}

async function processSecondStaleDraftEmails(opts = {}) {
  const db = opts.db || realDb;
  const sendEmail = opts.sendEmail || realSendEmail;
  const mintMagicLoginToken = opts.mintMagicLoginToken || realMintMagicLoginToken;
  const now = opts.now || new Date();
  const minAgeHours = opts.minAgeHours || DEFAULT_MIN_AGE_HOURS;
  const firstSentGapDays = opts.firstSentGapDays || DEFAULT_FIRST_SENT_GAP_DAYS;
  const ttlMinutes = Number.isFinite(opts.ttlMinutes) && opts.ttlMinutes > 0
    ? Math.floor(opts.ttlMinutes)
    : NUDGE_TTL_MINUTES;
  const log = opts.log || console;

  const summary = { found: 0, sent: 0, skipped: 0, errors: 0, notConfigured: 0 };

  let rows;
  try {
    rows = await db.getUsersForSecondStaleDraftEmail(minAgeHours, firstSentGapDays);
  } catch (err) {
    log.error && log.error('second-stale-draft-email query failed:', err && err.message);
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

    let magicLoginUrl = '';
    try {
      const mint = await mintMagicLoginToken(db, row.user_id, { ttlMinutes });
      if (mint && mint.ok && mint.url) {
        magicLoginUrl = mint.url;
      } else if (mint && !mint.ok) {
        log.warn && log.warn(`second-stale-draft magic-link mint skipped for user ${row.user_id}: ${mint.reason}`);
      }
    } catch (err) {
      log.warn && log.warn(`second-stale-draft magic-link mint threw for user ${row.user_id}:`, err && err.message);
    }
    const buildOpts = magicLoginUrl ? { magicLoginUrl } : undefined;

    let result;
    try {
      result = await sendEmail({
        to: row.email,
        subject: buildSecondStaleDraftSubject(row, now),
        html: buildSecondStaleDraftHtml(row, now, buildOpts),
        text: buildSecondStaleDraftText(row, now, buildOpts),
        replyTo: resolveReplyTo(row)
      });
    } catch (err) {
      log.error && log.error(`second-stale-draft email send threw for user ${row.user_id}:`, err && err.message);
      summary.errors += 1;
      continue;
    }

    if (!result || result.ok !== true) {
      if (result && result.reason === 'not_configured') {
        summary.notConfigured += 1;
      } else {
        summary.errors += 1;
        log.warn && log.warn(`second-stale-draft email for user ${row.user_id} failed:`,
          (result && (result.reason || result.error)) || 'unknown');
      }
      continue;
    }

    try {
      await db.markSecondStaleDraftEmailSent(row.user_id);
      summary.sent += 1;
    } catch (err) {
      log.error && log.error(`failed to stamp second_stale_draft_email_sent_at for user ${row.user_id}:`, err && err.message);
      summary.errors += 1;
    }
  }

  return summary;
}

let _scheduledTask = null;

function startSecondStaleDraftEmailJob(opts = {}) {
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
    console.error('node-cron not available; second-stale-draft-email job disabled:', err && err.message);
    return { ok: false, reason: 'cron_unavailable' };
  }

  const schedule = opts.schedule || process.env.SECOND_STALE_DRAFT_EMAIL_CRON_SCHEDULE || DEFAULT_SCHEDULE;
  const log = opts.log || console;

  try {
    _scheduledTask = cron.schedule(schedule, async () => {
      try {
        const summary = await processSecondStaleDraftEmails(opts);
        log.log && log.log(
          `[second-stale-draft-email] found=${summary.found} sent=${summary.sent} skipped=${summary.skipped} `
          + `errors=${summary.errors} notConfigured=${summary.notConfigured}`
        );
      } catch (err) {
        log.error && log.error('second-stale-draft-email cron tick failed:', err && err.message);
      }
    }, { timezone: 'UTC' });
  } catch (err) {
    console.error('failed to schedule second-stale-draft-email cron:', err && err.message);
    return { ok: false, reason: 'schedule_failed', error: err && err.message };
  }

  return { ok: true, schedule };
}

function stopSecondStaleDraftEmailJob() {
  if (_scheduledTask && typeof _scheduledTask.stop === 'function') {
    try { _scheduledTask.stop(); } catch (_) { /* ignore */ }
  }
  _scheduledTask = null;
}

module.exports = {
  processSecondStaleDraftEmails,
  startSecondStaleDraftEmailJob,
  stopSecondStaleDraftEmailJob,
  buildSecondStaleDraftSubject,
  buildSecondStaleDraftHtml,
  buildSecondStaleDraftText,
  hoursOld,
  daysOld,
  DEFAULT_MIN_AGE_HOURS,
  DEFAULT_FIRST_SENT_GAP_DAYS,
  DEFAULT_SCHEDULE,
  NUDGE_TTL_MINUTES,
  _internal: { escapeHtml, formatMoney, greetingName, resolveReplyTo, ctaUrl }
};
