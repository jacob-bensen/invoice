'use strict';

/*
 * Second Pending Quick-Invoice Nudge — 7-day post-first-pending-nudge follow-up.
 *
 * Closes the activation-funnel gap on Milestone 2 (first dashboard re-entry →
 * first real invoice created) for the highest-intent silent cohort:
 *
 *   - The user autosaved typed data on /invoices/quick (we still hold their
 *     client_name / description / amount in pending_quick_invoice).
 *   - The 24h pending-quick-invoice nudge (jobs/pending-quick-invoice-nudge.js)
 *     fired once and did not move them.
 *   - The generic 7-day second-no-invoice cron EXCLUDES users with
 *     pending_invoice_nudge_sent_at IS NOT NULL, so this cohort gets nothing
 *     else despite having the strongest first-invoice intent signal we capture.
 *
 * This second pass fires 7+ days after pending_invoice_nudge_sent_at with
 * empathetic "still want to send it?" framing on the same magic-login →
 * /invoices/quick CTA so the click auto-signs-in onto the form with the
 * autosaved fields restored (routes/invoices.js GET /quick reads
 * pending_quick_invoice and pre-fills the inputs).
 *
 * Design mirrors jobs/pending-quick-invoice-nudge.js + the second-stamp
 * pattern from jobs/second-no-invoice-nudge.js:
 *   - processSecondPendingQuickInvoiceNudges({ db, sendEmail, ... }) is the
 *     pure dependency-injected orchestrator. Returns a structured summary.
 *   - startSecondPendingQuickInvoiceNudgeJob(opts) schedules via node-cron at
 *     09:30 UTC daily (30 min after the first pending nudge at 09:00, so the
 *     first and second can never race within one cron day).
 *   - RESEND_API_KEY unset → not_configured → clean skip, no stamp, retry
 *     next tick.
 *   - Idempotency at the SQL layer: second_pending_invoice_nudge_sent_at
 *     IS NULL gates one-shot per user. A user silent after two pending
 *     nudges isn't moved by a third.
 */

const { db: realDb } = require('../db');
const { sendEmail: realSendEmail } = require('../lib/email');
const { escapeHtml } = require('../lib/html');
const { mintMagicLoginToken: realMintMagicLoginToken } = require('../lib/magic-login');
const { resolveUnsubscribeUrlForRow } = require('../lib/unsubscribe');
const {
  parsePendingPayload,
  formatAmountDisplay
} = require('./pending-quick-invoice-nudge');

const DEFAULT_MIN_INNER_GAP_DAYS = 7;
const DEFAULT_SCHEDULE = '30 9 * * *'; // 09:30 UTC daily (30 min after first pending nudge at 09:00)
// 7-day TTL matches the first pending nudge — the click window for a
// "you started something" reminder is "later today through end-of-week" and
// a token that rotates beyond that is the right safety horizon.
const NUDGE_TTL_MINUTES = 7 * 24 * 60;

function greetingName(row) {
  return (row && (row.name || row.business_name)) || 'there';
}

function resolveReplyTo(row) {
  if (!row) return null;
  return row.reply_to_email || row.business_email || row.email || null;
}

function continueUrl(opts) {
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

/*
 * Subject line. Empathetic + first-person-plural framing distinct from the
 * first pending nudge's headline-of-the-typed-data shape. No PII so the
 * inbox-preview line doesn't leak the cohort to anyone glancing at the
 * recipient's screen — "your invoice" is generic.
 */
function buildSecondPendingQuickInvoiceNudgeSubject() {
  return 'Still want to send that invoice? We can help.';
}

function buildSecondPendingQuickInvoiceNudgeHtml(row, _now, opts) {
  const greeting = greetingName(row);
  const url = continueUrl(opts);
  const dashUrl = dashboardUrl();
  const payload = opts && opts.payload ? opts.payload : parsePendingPayload(row && row.pending_quick_invoice);

  const amount = payload ? formatAmountDisplay(payload.amount) : '';
  const detailLines = [];
  if (payload && payload.clientName) {
    detailLines.push(`<li><strong>Client:</strong> ${escapeHtml(payload.clientName)}</li>`);
  }
  if (payload && payload.description) {
    detailLines.push(`<li><strong>What you did:</strong> ${escapeHtml(payload.description)}</li>`);
  }
  if (amount) {
    detailLines.push(`<li><strong>Amount:</strong> ${escapeHtml(amount)}</li>`);
  }
  const detailBlock = detailLines.length
    ? `<ul style="color:#222;margin:8px 0 16px 20px;font-size:15px;line-height:1.7;">${detailLines.join('')}</ul>`
    : '';

  const ctaButton = url
    ? `<p style="margin:24px 0;"><a href="${escapeHtml(url)}" style="background:#4f46e5;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px;display:inline-block;">Finish your invoice (60 seconds) →</a></p>`
    : '';

  const dashLine = dashUrl
    ? `<p style="color:#666;margin:8px 0;font-size:14px;">Or open your dashboard: <a href="${escapeHtml(dashUrl)}" style="color:#4f46e5;">${escapeHtml(dashUrl)}</a></p>`
    : '';

  return `<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#222;background:#f7f7f9;margin:0;padding:24px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #eaeaea;">
  <tr><td style="padding:24px 28px;">
    <h2 style="margin:0 0 8px 0;color:#111;">Still want to send that invoice?</h2>
    <p style="color:#222;margin:8px 0;font-size:16px;">Hi ${escapeHtml(greeting)},</p>
    <p style="color:#222;margin:8px 0;font-size:16px;">A week or so ago you started typing an invoice and we saved what you wrote. It's still here, waiting for one more tap:</p>
    ${detailBlock}
    <p style="color:#222;margin:8px 0;font-size:16px;">If you got stuck, the most common reasons we see are:</p>
    <ul style="color:#222;margin:8px 0 16px 20px;font-size:15px;line-height:1.6;">
      <li>The gig fell through and the invoice no longer applies.</li>
      <li>You weren't sure what to charge, or how to word it.</li>
      <li>You're waiting on something from the client first.</li>
    </ul>
    <p style="color:#222;margin:8px 0;font-size:15px;">Hit reply if any of those ring a bell — we read every reply and can usually unblock you in one back-and-forth. Or if you're ready to just send it, tap below to land back on the form with your fields pre-filled:</p>
    ${ctaButton}
    ${dashLine}
    <p style="color:#999;font-size:12px;margin-top:24px;">Sent automatically by DecentInvoice. This is our last note about this draft — we won't keep poking.</p>
  </td></tr>
</table>
</body></html>`;
}

function buildSecondPendingQuickInvoiceNudgeText(row, _now, opts) {
  const greeting = greetingName(row);
  const url = continueUrl(opts);
  const dashUrl = dashboardUrl();
  const payload = opts && opts.payload ? opts.payload : parsePendingPayload(row && row.pending_quick_invoice);
  const amount = payload ? formatAmountDisplay(payload.amount) : '';

  const lines = [
    `Hi ${greeting},`,
    '',
    "A week or so ago you started typing an invoice and we saved what you wrote. It's still here, waiting for one more tap:"
  ];
  if (payload && payload.clientName) lines.push(`  - Client: ${payload.clientName}`);
  if (payload && payload.description) lines.push(`  - What you did: ${payload.description}`);
  if (amount) lines.push(`  - Amount: ${amount}`);
  lines.push(
    '',
    'If you got stuck, the most common reasons we see are:',
    '',
    '  - The gig fell through and the invoice no longer applies.',
    "  - You weren't sure what to charge, or how to word it.",
    "  - You're waiting on something from the client first.",
    '',
    "Hit reply if any of those ring a bell — we read every reply and can usually unblock you in one back-and-forth. Or if you're ready to just send it:"
  );
  if (url) lines.push('', `Finish your invoice: ${url}`);
  if (dashUrl) lines.push('', `Or open your dashboard: ${dashUrl}`);
  lines.push('', "This is our last note about this draft — we won't keep poking.");
  return lines.join('\n');
}

async function processSecondPendingQuickInvoiceNudges(opts = {}) {
  const db = opts.db || realDb;
  const sendEmail = opts.sendEmail || realSendEmail;
  const mintMagicLoginToken = opts.mintMagicLoginToken || realMintMagicLoginToken;
  const now = opts.now || new Date();
  const minInnerGapDays = opts.minInnerGapDays || DEFAULT_MIN_INNER_GAP_DAYS;
  const ttlMinutes = Number.isFinite(opts.ttlMinutes) && opts.ttlMinutes > 0
    ? Math.floor(opts.ttlMinutes)
    : NUDGE_TTL_MINUTES;
  const log = opts.log || console;

  const summary = { found: 0, sent: 0, skipped: 0, errors: 0, notConfigured: 0 };

  let rows;
  try {
    rows = await db.getUsersForSecondPendingQuickInvoiceNudge(minInnerGapDays);
  } catch (err) {
    log.error && log.error('second-pending-quick-invoice-nudge query failed:', err && err.message);
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

    // Defence-in-depth: skip rows whose pending JSON is unparseable or
    // all-empty. The SQL gate excludes NULL, but a stringified-JSON corruption
    // or a future schema drift shouldn't fire a "still want to send it?"
    // email with no actual fields to surface — that reads as broken.
    const payload = parsePendingPayload(row.pending_quick_invoice);
    if (!payload) {
      summary.skipped += 1;
      continue;
    }

    let magicLoginUrl = '';
    try {
      const mint = await mintMagicLoginToken(db, row.id, { ttlMinutes });
      if (mint && mint.ok && mint.url) {
        magicLoginUrl = mint.url;
      } else if (mint && !mint.ok) {
        log.warn && log.warn(`second-pending-quick-invoice-nudge magic-link mint skipped for user ${row.id}: ${mint.reason}`);
      }
    } catch (err) {
      log.warn && log.warn(`second-pending-quick-invoice-nudge magic-link mint threw for user ${row.id}:`, err && err.message);
    }
    const buildOpts = { payload };
    if (magicLoginUrl) buildOpts.magicLoginUrl = magicLoginUrl;

    const unsubscribeUrl = await resolveUnsubscribeUrlForRow(db, row);

    let result;
    try {
      result = await sendEmail({
        to: row.email,
        subject: buildSecondPendingQuickInvoiceNudgeSubject(row, now, buildOpts),
        html: buildSecondPendingQuickInvoiceNudgeHtml(row, now, buildOpts),
        text: buildSecondPendingQuickInvoiceNudgeText(row, now, buildOpts),
        replyTo: resolveReplyTo(row),
        unsubscribeUrl: unsubscribeUrl || undefined
      });
    } catch (err) {
      log.error && log.error(`second-pending-quick-invoice-nudge send threw for user ${row.id}:`, err && err.message);
      summary.errors += 1;
      continue;
    }

    if (!result || result.ok !== true) {
      if (result && result.reason === 'not_configured') {
        summary.notConfigured += 1;
      } else {
        summary.errors += 1;
        log.warn && log.warn(`second-pending-quick-invoice-nudge for user ${row.id} failed:`,
          (result && (result.reason || result.error)) || 'unknown');
      }
      continue;
    }

    try {
      await db.markSecondPendingQuickInvoiceNudgeSent(row.id);
      summary.sent += 1;
    } catch (err) {
      log.error && log.error(`failed to stamp second_pending_invoice_nudge_sent_at for user ${row.id}:`, err && err.message);
      summary.errors += 1;
    }
  }

  return summary;
}

let _scheduledTask = null;

function startSecondPendingQuickInvoiceNudgeJob(opts = {}) {
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
    console.error('node-cron not available; second-pending-quick-invoice-nudge job disabled:', err && err.message);
    return { ok: false, reason: 'cron_unavailable' };
  }

  const schedule = opts.schedule || process.env.SECOND_PENDING_QUICK_INVOICE_NUDGE_CRON_SCHEDULE || DEFAULT_SCHEDULE;
  const log = opts.log || console;

  try {
    _scheduledTask = cron.schedule(schedule, async () => {
      try {
        const summary = await processSecondPendingQuickInvoiceNudges(opts);
        log.log && log.log(
          `[second-pending-quick-invoice-nudge] found=${summary.found} sent=${summary.sent} skipped=${summary.skipped} `
          + `errors=${summary.errors} notConfigured=${summary.notConfigured}`
        );
      } catch (err) {
        log.error && log.error('second-pending-quick-invoice-nudge cron tick failed:', err && err.message);
      }
    }, { timezone: 'UTC' });
  } catch (err) {
    console.error('failed to schedule second-pending-quick-invoice-nudge cron:', err && err.message);
    return { ok: false, reason: 'schedule_failed', error: err && err.message };
  }

  return { ok: true, schedule };
}

function stopSecondPendingQuickInvoiceNudgeJob() {
  if (_scheduledTask && typeof _scheduledTask.stop === 'function') {
    try { _scheduledTask.stop(); } catch (_) { /* ignore */ }
  }
  _scheduledTask = null;
}

module.exports = {
  processSecondPendingQuickInvoiceNudges,
  startSecondPendingQuickInvoiceNudgeJob,
  stopSecondPendingQuickInvoiceNudgeJob,
  buildSecondPendingQuickInvoiceNudgeSubject,
  buildSecondPendingQuickInvoiceNudgeHtml,
  buildSecondPendingQuickInvoiceNudgeText,
  DEFAULT_MIN_INNER_GAP_DAYS,
  DEFAULT_SCHEDULE,
  NUDGE_TTL_MINUTES,
  _internal: { escapeHtml, greetingName, resolveReplyTo, continueUrl, dashboardUrl }
};
