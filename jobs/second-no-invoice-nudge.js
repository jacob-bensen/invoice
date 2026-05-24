'use strict';

/*
 * Second No-Invoice Nudge — 7-day post-signup re-engagement email.
 *
 * Closes the cohort gap left by the one-shot 48h nudge in
 * jobs/no-invoice-nudge.js: a user who didn't act on the first nudge (or
 * never received it, e.g. RESEND_API_KEY unset on that day's tick) is
 * otherwise lost forever, since the first nudge stamps and never repeats.
 * This second pass fires 7+ days after signup for users still at
 * invoice_count = 0, with sharper "is anything specific blocking you?"
 * framing and the same magic-login → /invoices/quick CTA.
 *
 * Design mirrors jobs/no-invoice-nudge.js:
 *   - processSecondNoInvoiceNudges({ db, sendEmail, ... }) is the
 *     dependency-injected orchestrator; returns a structured summary.
 *   - startSecondNoInvoiceNudgeJob(opts) schedules via node-cron at 13:00
 *     UTC daily (after the 48h nudge at 12:00, so first/second can never
 *     race on the same row within one cron day).
 *   - RESEND_API_KEY unset → sendEmail returns not_configured → clean skip,
 *     no stamp written, next pass retries.
 *   - Idempotent at the SQL layer: second_no_invoice_nudge_sent_at IS NULL
 *     in db.getUsersForSecondNoInvoiceNudge gates one-shot per user.
 */

const { db: realDb } = require('../db');
const { sendEmail: realSendEmail } = require('../lib/email');
const { escapeHtml } = require('../lib/html');
const { mintMagicLoginToken: realMintMagicLoginToken } = require('../lib/magic-login');
const { resolveUnsubscribeUrlForRow } = require('../lib/unsubscribe');

const DEFAULT_MIN_AGE_HOURS = 168; // 7 days
const DEFAULT_SCHEDULE = '0 13 * * *'; // 13:00 UTC daily (after no-invoice-nudge at 12:00)
// 7-day TTL matches the first nudge — the click window for this email is
// "later today through end-of-week" and a token that rotates beyond that is
// the right safety horizon for a re-engagement send.
const NUDGE_TTL_MINUTES = 7 * 24 * 60;

function greetingName(row) {
  return (row && (row.name || row.business_name)) || 'there';
}

function resolveReplyTo(row) {
  if (!row) return null;
  return row.reply_to_email || row.business_email || row.email || null;
}

function newInvoiceUrl(opts) {
  const magicLoginUrl = opts && typeof opts.magicLoginUrl === 'string'
    ? opts.magicLoginUrl.trim() : '';
  if (magicLoginUrl) {
    return `${magicLoginUrl}?next=/invoices/quick`;
  }
  const base = (process.env.APP_URL || '').replace(/\/+$/, '');
  return base ? `${base}/invoices/quick` : '';
}

function dashboardUrl() {
  const base = (process.env.APP_URL || '').replace(/\/+$/, '');
  return base ? `${base}/dashboard` : '';
}

function buildSecondNoInvoiceNudgeSubject() {
  // No PII so the inbox-preview line doesn't leak the cohort to anyone
  // glancing at the recipient's screen.
  return "Anything blocking your first invoice? Hit reply.";
}

function buildSecondNoInvoiceNudgeHtml(row, _now, opts) {
  const greeting = greetingName(row);
  const newUrl = newInvoiceUrl(opts);
  const dashUrl = dashboardUrl();
  const newButton = newUrl
    ? `<p style="margin:24px 0;"><a href="${escapeHtml(newUrl)}" style="background:#4f46e5;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px;display:inline-block;">Send your first invoice (60 seconds) →</a></p>`
    : '';
  const dashLine = dashUrl
    ? `<p style="color:#666;margin:8px 0;font-size:14px;">Or open the sample invoice on your dashboard and tweak it: <a href="${escapeHtml(dashUrl)}" style="color:#4f46e5;">${escapeHtml(dashUrl)}</a></p>`
    : '';

  return `<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#222;background:#f7f7f9;margin:0;padding:24px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #eaeaea;">
  <tr><td style="padding:24px 28px;">
    <h2 style="margin:0 0 8px 0;color:#111;">Anything blocking your first invoice?</h2>
    <p style="color:#222;margin:8px 0;font-size:16px;">Hi ${escapeHtml(greeting)},</p>
    <p style="color:#222;margin:8px 0;font-size:16px;">It's been about a week since you signed up for DecentInvoice, and the first invoice never went out. That's normal — most freelancers who get stuck here are stuck on one of these:</p>
    <ul style="color:#222;margin:8px 0 16px 20px;font-size:15px;line-height:1.6;">
      <li>No current client to invoice yet — you're between gigs.</li>
      <li>Not sure how to word the description or what to charge.</li>
      <li>Worried about how the invoice will look to the client.</li>
    </ul>
    <p style="color:#222;margin:8px 0;font-size:15px;">If any of those ring a bell, just hit reply — we read every one and most folks are unblocked in a single back-and-forth. We've seen it all.</p>
    <p style="color:#222;margin:8px 0;font-size:15px;">If you're ready to just send the thing, the express form takes 60 seconds (client name, what you did, amount):</p>
    ${newButton}
    ${dashLine}
    <p style="color:#999;font-size:12px;margin-top:24px;">Sent automatically by DecentInvoice. You'll only get this follow-up once — we won't keep poking.</p>
  </td></tr>
</table>
</body></html>`;
}

function buildSecondNoInvoiceNudgeText(row, _now, opts) {
  const greeting = greetingName(row);
  const newUrl = newInvoiceUrl(opts);
  const dashUrl = dashboardUrl();
  const lines = [
    `Hi ${greeting},`,
    '',
    "It's been about a week since you signed up for DecentInvoice, and the first invoice never went out. That's normal — most freelancers who get stuck here are stuck on one of these:",
    '',
    "  - No current client to invoice yet — you're between gigs.",
    '  - Not sure how to word the description or what to charge.',
    '  - Worried about how the invoice will look to the client.',
    '',
    'If any of those ring a bell, just hit reply — we read every one and most folks are unblocked in a single back-and-forth.',
    '',
    "If you're ready to just send the thing, the express form takes 60 seconds (client name, what you did, amount):"
  ];
  if (newUrl) {
    lines.push('', `Send your first invoice: ${newUrl}`);
  }
  if (dashUrl) {
    lines.push('', `Or open the sample on your dashboard: ${dashUrl}`);
  }
  lines.push('', "You'll only get this follow-up once — we won't keep poking.");
  return lines.join('\n');
}

async function processSecondNoInvoiceNudges(opts = {}) {
  const db = opts.db || realDb;
  const sendEmail = opts.sendEmail || realSendEmail;
  const mintMagicLoginToken = opts.mintMagicLoginToken || realMintMagicLoginToken;
  const now = opts.now || new Date();
  const minAgeHours = opts.minAgeHours || DEFAULT_MIN_AGE_HOURS;
  const ttlMinutes = Number.isFinite(opts.ttlMinutes) && opts.ttlMinutes > 0
    ? Math.floor(opts.ttlMinutes)
    : NUDGE_TTL_MINUTES;
  const log = opts.log || console;

  const summary = { found: 0, sent: 0, skipped: 0, errors: 0, notConfigured: 0 };

  let rows;
  try {
    rows = await db.getUsersForSecondNoInvoiceNudge(minAgeHours);
  } catch (err) {
    log.error && log.error('second-no-invoice-nudge query failed:', err && err.message);
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
      const mint = await mintMagicLoginToken(db, row.id, { ttlMinutes });
      if (mint && mint.ok && mint.url) {
        magicLoginUrl = mint.url;
      } else if (mint && !mint.ok) {
        log.warn && log.warn(`second-no-invoice-nudge magic-link mint skipped for user ${row.id}: ${mint.reason}`);
      }
    } catch (err) {
      log.warn && log.warn(`second-no-invoice-nudge magic-link mint threw for user ${row.id}:`, err && err.message);
    }
    const buildOpts = magicLoginUrl ? { magicLoginUrl } : undefined;

    const unsubscribeUrl = await resolveUnsubscribeUrlForRow(db, row);

    let result;
    try {
      result = await sendEmail({
        to: row.email,
        subject: buildSecondNoInvoiceNudgeSubject(row, now),
        html: buildSecondNoInvoiceNudgeHtml(row, now, buildOpts),
        text: buildSecondNoInvoiceNudgeText(row, now, buildOpts),
        replyTo: resolveReplyTo(row),
        unsubscribeUrl: unsubscribeUrl || undefined
      });
    } catch (err) {
      log.error && log.error(`second-no-invoice-nudge send threw for user ${row.id}:`, err && err.message);
      summary.errors += 1;
      continue;
    }

    if (!result || result.ok !== true) {
      if (result && result.reason === 'not_configured') {
        summary.notConfigured += 1;
      } else {
        summary.errors += 1;
        log.warn && log.warn(`second-no-invoice-nudge for user ${row.id} failed:`,
          (result && (result.reason || result.error)) || 'unknown');
      }
      continue;
    }

    try {
      await db.markSecondNoInvoiceNudgeSent(row.id);
      summary.sent += 1;
    } catch (err) {
      log.error && log.error(`failed to stamp second_no_invoice_nudge_sent_at for user ${row.id}:`, err && err.message);
      summary.errors += 1;
    }
  }

  return summary;
}

let _scheduledTask = null;

function startSecondNoInvoiceNudgeJob(opts = {}) {
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
    console.error('node-cron not available; second-no-invoice-nudge job disabled:', err && err.message);
    return { ok: false, reason: 'cron_unavailable' };
  }

  const schedule = opts.schedule || process.env.SECOND_NO_INVOICE_NUDGE_CRON_SCHEDULE || DEFAULT_SCHEDULE;
  const log = opts.log || console;

  try {
    _scheduledTask = cron.schedule(schedule, async () => {
      try {
        const summary = await processSecondNoInvoiceNudges(opts);
        log.log && log.log(
          `[second-no-invoice-nudge] found=${summary.found} sent=${summary.sent} skipped=${summary.skipped} `
          + `errors=${summary.errors} notConfigured=${summary.notConfigured}`
        );
      } catch (err) {
        log.error && log.error('second-no-invoice-nudge cron tick failed:', err && err.message);
      }
    }, { timezone: 'UTC' });
  } catch (err) {
    console.error('failed to schedule second-no-invoice-nudge cron:', err && err.message);
    return { ok: false, reason: 'schedule_failed', error: err && err.message };
  }

  return { ok: true, schedule };
}

function stopSecondNoInvoiceNudgeJob() {
  if (_scheduledTask && typeof _scheduledTask.stop === 'function') {
    try { _scheduledTask.stop(); } catch (_) { /* ignore */ }
  }
  _scheduledTask = null;
}

module.exports = {
  processSecondNoInvoiceNudges,
  startSecondNoInvoiceNudgeJob,
  stopSecondNoInvoiceNudgeJob,
  buildSecondNoInvoiceNudgeSubject,
  buildSecondNoInvoiceNudgeHtml,
  buildSecondNoInvoiceNudgeText,
  DEFAULT_MIN_AGE_HOURS,
  DEFAULT_SCHEDULE,
  NUDGE_TTL_MINUTES,
  _internal: { escapeHtml, greetingName, resolveReplyTo, newInvoiceUrl, dashboardUrl }
};
