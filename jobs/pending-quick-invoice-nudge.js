'use strict';

/*
 * Pending Quick-Invoice Nudge — 24h post-autosave re-engagement email.
 *
 * Closes the activation-funnel gap on Milestone 2 (first dashboard re-entry →
 * first real invoice created) for the highest-conversion-signal sub-cohort:
 * users who started typing on /invoices/quick (autosave fired, pending row
 * exists) but bounced before submitting. The generic 48h `no-invoice-nudge`
 * cron already covers the never-typed cohort with generic copy. This job
 * targets the never-finished cohort with copy that names what they were
 * working on (e.g. "Your $500 invoice for Acme Corp is half-typed — finish
 * in 60 seconds?"), which converts higher than generic re-engagement.
 *
 * Cohort gates (db.getUsersForPendingQuickInvoiceNudge):
 *   - pending_quick_invoice IS NOT NULL
 *   - invoice_count = 0 (no real invoice created since the autosave)
 *   - welcome_email_sent_at IS NOT NULL (activation ordering)
 *   - pending_invoice_nudge_sent_at IS NULL (one-shot)
 *   - no_invoice_nudge_sent_at IS NULL  ┐ exclude users who already got the
 *   - second_no_invoice_nudge_sent_at IS NULL  ┘ generic nudge — one email max
 *   - pending_quick_invoice_updated_at <= NOW() - minAgeHours
 *
 * Pair gates on the generic no-invoice-nudge queries exclude users who already
 * got THIS pending nudge, so a user receives exactly one signup→first-invoice
 * activation email regardless of which cron fires first.
 *
 * Magic-login bake-in: 7-day token + ?next=/invoices/quick so the click
 * auto-signs-in straight back into the pre-filled form. The route's existing
 * `readPendingQuickInvoice` then surfaces the same fields the user was typing.
 *
 * Design mirrors jobs/no-invoice-nudge.js + jobs/second-no-invoice-nudge.js:
 *   - processPendingQuickInvoiceNudges({ db, sendEmail, ... }) is the pure
 *     dependency-injected orchestrator. Returns a structured summary.
 *   - startPendingQuickInvoiceNudgeJob(opts) schedules via node-cron at 09:00
 *     UTC daily (strictly before stale-draft at 11:00, no-invoice at 12:00,
 *     second-no-invoice at 13:00 — earliest in the morning batch since this
 *     is the strongest-signal email and should land first).
 *   - RESEND_API_KEY unset → not_configured → clean skip, no stamp, retry
 *     next tick.
 *   - Idempotency at the SQL layer: pending_invoice_nudge_sent_at IS NULL
 *     guarantees one-shot per user.
 */

const { db: realDb } = require('../db');
const { sendEmail: realSendEmail } = require('../lib/email');
const { escapeHtml } = require('../lib/html');
const { mintMagicLoginToken: realMintMagicLoginToken } = require('../lib/magic-login');
const { resolveUnsubscribeUrlForRow } = require('../lib/unsubscribe');

const DEFAULT_MIN_AGE_HOURS = 24;
const DEFAULT_SCHEDULE = '0 9 * * *'; // 09:00 UTC daily (before all other re-engagement crons)
// 7-day TTL matches every other re-engagement email — the click window for
// a "you started something" reminder is "later today through end-of-week".
const NUDGE_TTL_MINUTES = 7 * 24 * 60;

// Display caps. The pending JSONB is already clamped at write time (500 char
// strings, 32 char amount) but the email body should stay readable, so we
// truncate further before rendering. Long client names and descriptions get
// an ellipsis; the amount is preserved verbatim up to its existing cap.
const CLIENT_DISPLAY_MAX = 60;
const DESCRIPTION_DISPLAY_MAX = 80;

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
 * Parses pending_quick_invoice into a normalized display payload.
 *
 * The column is JSONB. pg's default driver returns it as a parsed object, but
 * tolerate stringified values (test stubs, legacy drivers). Strings are
 * trimmed, oversize values truncated with an ellipsis. The amount field
 * surfaces a leading "$" only when the value looks numeric; otherwise the
 * raw trimmed string passes through (the autosave route already clamps it).
 *
 * Returns null when the payload is missing, malformed, or all-empty — the
 * caller treats that as "no displayable signal, skip this row" defence-in-
 * depth even though the SQL gate already excludes empty pending rows.
 */
function parsePendingPayload(raw) {
  if (raw == null) return null;
  let obj = raw;
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj); } catch (e) { return null; }
  }
  if (!obj || typeof obj !== 'object') return null;
  const pickStr = (v) => (typeof v === 'string' ? v.trim() : '');
  const clientName = pickStr(obj.client_name);
  const description = pickStr(obj.description);
  const amount = pickStr(obj.amount);
  if (!clientName && !description && !amount) return null;
  return {
    clientName: clientName.length > CLIENT_DISPLAY_MAX
      ? `${clientName.slice(0, CLIENT_DISPLAY_MAX).trimEnd()}…`
      : clientName,
    description: description.length > DESCRIPTION_DISPLAY_MAX
      ? `${description.slice(0, DESCRIPTION_DISPLAY_MAX).trimEnd()}…`
      : description,
    amount
  };
}

function formatAmountDisplay(amount) {
  if (!amount) return '';
  const trimmed = String(amount).trim();
  if (!trimmed) return '';
  // Common patterns: "500", "500.00", "1,234.50", "$500". Surface a leading
  // "$" when the value parses as a positive number AND doesn't already carry
  // a currency prefix — otherwise pass the raw string through (user typed
  // "TBD" or similar; we don't want to render "$TBD").
  if (/^[$£€¥]/.test(trimmed)) return trimmed;
  const numericish = trimmed.replace(/[,_\s]/g, '');
  if (/^-?\d+(\.\d+)?$/.test(numericish)) {
    const n = parseFloat(numericish);
    if (Number.isFinite(n) && n > 0) return `$${trimmed}`;
  }
  return trimmed;
}

/*
 * Headline assembly. Adapts to which fields are populated:
 *   client + amount        → "Your $X for <client> is half-typed"
 *   client only            → "You started an invoice for <client>"
 *   amount only            → "Your $X invoice is half-typed"
 *   description only       → "Your invoice for <description> is half-typed"
 *   client + description   → "Your invoice for <client> (<description>) is half-typed"
 *
 * Always grammatical, always under inbox-preview budget. No exclamation marks
 * (they read as marketing-y), no emoji (mid-cohort retention surfaces feel
 * spammier with them).
 */
function buildHeadline(payload) {
  if (!payload) return 'Pick up where you left off';
  const amount = formatAmountDisplay(payload.amount);
  const hasClient = !!payload.clientName;
  const hasAmount = !!amount;
  const hasDesc = !!payload.description;

  if (hasClient && hasAmount) {
    return `Your ${amount} invoice for ${payload.clientName} is half-typed`;
  }
  if (hasClient && hasDesc) {
    return `Your invoice for ${payload.clientName} (${payload.description}) is half-typed`;
  }
  if (hasClient) {
    return `You started an invoice for ${payload.clientName}`;
  }
  if (hasAmount) {
    return `Your ${amount} invoice is half-typed`;
  }
  if (hasDesc) {
    return `Your invoice for ${payload.description} is half-typed`;
  }
  return 'Pick up where you left off';
}

function buildPendingQuickInvoiceNudgeSubject(row, _now, opts) {
  // Subject is the headline directly — most inbox lists truncate after ~60
  // chars on mobile, and the headline is already tuned to fit. No emoji.
  const payload = opts && opts.payload ? opts.payload : parsePendingPayload(row && row.pending_quick_invoice);
  return buildHeadline(payload);
}

function buildPendingQuickInvoiceNudgeHtml(row, _now, opts) {
  const greeting = greetingName(row);
  const url = continueUrl(opts);
  const dashUrl = dashboardUrl();
  const payload = opts && opts.payload ? opts.payload : parsePendingPayload(row && row.pending_quick_invoice);
  const headline = buildHeadline(payload);

  // Detail block: surface whatever the user typed. Each line is suppressed
  // when its field is empty. The detail block is a soft confirmation that
  // we have their data, which both reassures the cohort (we didn't lose it)
  // and makes the email feel personal vs. the generic 48h nudge.
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
    <h2 style="margin:0 0 8px 0;color:#111;">${escapeHtml(headline)}</h2>
    <p style="color:#222;margin:8px 0;font-size:16px;">Hi ${escapeHtml(greeting)},</p>
    <p style="color:#222;margin:8px 0;font-size:16px;">You started filling out an invoice yesterday but didn't quite finish. We saved what you typed so you can pick it up in one click:</p>
    ${detailBlock}
    <p style="color:#222;margin:8px 0;font-size:15px;">Tap below to land back on the form with your fields pre-filled. From there it's one more tap to share with your client.</p>
    ${ctaButton}
    ${dashLine}
    <p style="color:#999;font-size:12px;margin-top:24px;">Sent automatically by DecentInvoice. Reply to this email if anything's blocking you — we read every reply.</p>
  </td></tr>
</table>
</body></html>`;
}

function buildPendingQuickInvoiceNudgeText(row, _now, opts) {
  const greeting = greetingName(row);
  const url = continueUrl(opts);
  const dashUrl = dashboardUrl();
  const payload = opts && opts.payload ? opts.payload : parsePendingPayload(row && row.pending_quick_invoice);
  const headline = buildHeadline(payload);
  const amount = payload ? formatAmountDisplay(payload.amount) : '';

  const lines = [
    headline,
    '',
    `Hi ${greeting},`,
    '',
    "You started filling out an invoice yesterday but didn't quite finish. We saved what you typed so you can pick it up in one click:"
  ];
  if (payload && payload.clientName) lines.push(`  - Client: ${payload.clientName}`);
  if (payload && payload.description) lines.push(`  - What you did: ${payload.description}`);
  if (amount) lines.push(`  - Amount: ${amount}`);
  lines.push('', "Tap below to land back on the form with your fields pre-filled. From there it's one more tap to share with your client.");
  if (url) lines.push('', `Finish your invoice: ${url}`);
  if (dashUrl) lines.push('', `Or open your dashboard: ${dashUrl}`);
  lines.push('', "Reply to this email if anything's blocking you — we read every reply.");
  return lines.join('\n');
}

async function processPendingQuickInvoiceNudges(opts = {}) {
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
    rows = await db.getUsersForPendingQuickInvoiceNudge(minAgeHours);
  } catch (err) {
    log.error && log.error('pending-quick-invoice-nudge query failed:', err && err.message);
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
    // or a future schema drift shouldn't fire a "Pick up where you left off"
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
        log.warn && log.warn(`pending-quick-invoice-nudge magic-link mint skipped for user ${row.id}: ${mint.reason}`);
      }
    } catch (err) {
      log.warn && log.warn(`pending-quick-invoice-nudge magic-link mint threw for user ${row.id}:`, err && err.message);
    }
    const buildOpts = { payload };
    if (magicLoginUrl) buildOpts.magicLoginUrl = magicLoginUrl;

    const unsubscribeUrl = await resolveUnsubscribeUrlForRow(db, row);

    let result;
    try {
      result = await sendEmail({
        to: row.email,
        subject: buildPendingQuickInvoiceNudgeSubject(row, now, buildOpts),
        html: buildPendingQuickInvoiceNudgeHtml(row, now, buildOpts),
        text: buildPendingQuickInvoiceNudgeText(row, now, buildOpts),
        replyTo: resolveReplyTo(row),
        unsubscribeUrl: unsubscribeUrl || undefined
      });
    } catch (err) {
      log.error && log.error(`pending-quick-invoice-nudge send threw for user ${row.id}:`, err && err.message);
      summary.errors += 1;
      continue;
    }

    if (!result || result.ok !== true) {
      if (result && result.reason === 'not_configured') {
        summary.notConfigured += 1;
      } else {
        summary.errors += 1;
        log.warn && log.warn(`pending-quick-invoice-nudge for user ${row.id} failed:`,
          (result && (result.reason || result.error)) || 'unknown');
      }
      continue;
    }

    try {
      await db.markPendingQuickInvoiceNudgeSent(row.id);
      summary.sent += 1;
    } catch (err) {
      log.error && log.error(`failed to stamp pending_invoice_nudge_sent_at for user ${row.id}:`, err && err.message);
      summary.errors += 1;
    }
  }

  return summary;
}

let _scheduledTask = null;

function startPendingQuickInvoiceNudgeJob(opts = {}) {
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
    console.error('node-cron not available; pending-quick-invoice-nudge job disabled:', err && err.message);
    return { ok: false, reason: 'cron_unavailable' };
  }

  const schedule = opts.schedule || process.env.PENDING_QUICK_INVOICE_NUDGE_CRON_SCHEDULE || DEFAULT_SCHEDULE;
  const log = opts.log || console;

  try {
    _scheduledTask = cron.schedule(schedule, async () => {
      try {
        const summary = await processPendingQuickInvoiceNudges(opts);
        log.log && log.log(
          `[pending-quick-invoice-nudge] found=${summary.found} sent=${summary.sent} skipped=${summary.skipped} `
          + `errors=${summary.errors} notConfigured=${summary.notConfigured}`
        );
      } catch (err) {
        log.error && log.error('pending-quick-invoice-nudge cron tick failed:', err && err.message);
      }
    }, { timezone: 'UTC' });
  } catch (err) {
    console.error('failed to schedule pending-quick-invoice-nudge cron:', err && err.message);
    return { ok: false, reason: 'schedule_failed', error: err && err.message };
  }

  return { ok: true, schedule };
}

function stopPendingQuickInvoiceNudgeJob() {
  if (_scheduledTask && typeof _scheduledTask.stop === 'function') {
    try { _scheduledTask.stop(); } catch (_) { /* ignore */ }
  }
  _scheduledTask = null;
}

module.exports = {
  processPendingQuickInvoiceNudges,
  startPendingQuickInvoiceNudgeJob,
  stopPendingQuickInvoiceNudgeJob,
  buildPendingQuickInvoiceNudgeSubject,
  buildPendingQuickInvoiceNudgeHtml,
  buildPendingQuickInvoiceNudgeText,
  buildHeadline,
  parsePendingPayload,
  formatAmountDisplay,
  DEFAULT_MIN_AGE_HOURS,
  DEFAULT_SCHEDULE,
  NUDGE_TTL_MINUTES,
  _internal: { escapeHtml, greetingName, resolveReplyTo, continueUrl, dashboardUrl }
};
