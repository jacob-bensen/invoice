'use strict';

/*
 * No-Invoice Nudge — 48h-after-signup re-engagement email.
 *
 * Closes the activation-funnel gap on Milestone 2 (first dashboard re-entry →
 * first real invoice created) for the cohort that gets neither the
 * stale-draft email (only fires when a real draft exists) nor the trial-nudge
 * (only fires for trial users on day 3-5, and is about adding a card). The
 * user got the welcome at signup, has been silent for 48+ hours, and still
 * has `invoice_count = 0` — i.e. they have never created a real invoice (the
 * seed sample we insert at signup deliberately skips the counter bump, so
 * this gate is exact regardless of whether the seed is still around, edited,
 * or deleted).
 *
 * Magic-login bake-in (Milestone 1 + Milestone 2): for each cohort row we
 * mint a 7-day magic-login token (lib/magic-login.mintMagicLoginToken) and
 * bake the auto-sign-in URL into the "Create your first invoice →" CTA with
 * `?next=/invoices/quick`. A user who clicks the nudge 2-7 days after signup
 * — likely on a different device or with an expired session — lands
 * signed-in straight on the 3-field express form instead of bouncing at
 * /auth/login. Mint failures soft-fail to the plain APP_URL CTA; the email
 * is never sacrificed to a mint hiccup.
 *
 * Design mirrors jobs/stale-draft-email.js and jobs/trial-nudge.js:
 *   - `processNoInvoiceNudges({ db, sendEmail, now, log })` is the pure
 *     orchestrator. Dependency-injected, no module state. Returns a
 *     structured summary { found, sent, skipped, errors, notConfigured } so
 *     tests can assert directly.
 *   - `startNoInvoiceNudgeJob(opts)` schedules via node-cron. Cron failures
 *     log-and-swallow; a broken cron must never crash the web process.
 *   - `RESEND_API_KEY` unset → sendEmail returns
 *     { ok:false, reason:'not_configured' } and we treat it as a clean skip
 *     (no DB stamp, next pass retries) so the job is safe to deploy before
 *     Master provisions the key.
 *   - Idempotency is enforced at the SQL layer:
 *     `no_invoice_nudge_sent_at IS NULL` means each user receives at most
 *     one nudge ever. We do NOT repeat on a cooldown — a user who ignores
 *     the first nudge will not be moved by a second.
 */

const { db: realDb } = require('../db');
const { sendEmail: realSendEmail } = require('../lib/email');
const { escapeHtml } = require('../lib/html');
const { mintMagicLoginToken: realMintMagicLoginToken } = require('../lib/magic-login');

const DEFAULT_MIN_AGE_HOURS = 48;
const DEFAULT_SCHEDULE = '0 12 * * *'; // 12:00 UTC daily (after stale-draft at 11:00, trial-nudge at 10:00)
// 7 days — matches WELCOME_TTL_MINUTES. The nudge fires 48h+ after signup on
// a quiet user; they may not click for several more days, especially over a
// weekend. A 7-day window is loose enough to still auto-sign-in then, tight
// enough that the token rotates well before any practical mailbox-leak horizon.
const NUDGE_TTL_MINUTES = 7 * 24 * 60;

function greetingName(row) {
  return (row && (row.name || row.business_name)) || 'there';
}

function resolveReplyTo(row) {
  if (!row) return null;
  return row.reply_to_email || row.business_email || row.email || null;
}

function newInvoiceUrl(opts) {
  // When a one-shot magic-login URL is supplied (processNoInvoiceNudges mints
  // one per cohort row), bake it into the primary CTA so the click auto-signs-
  // in and lands on /invoices/quick. Falls back to the plain APP_URL path if
  // no magic URL is available (mint failed, no DB, etc.) so the email is still
  // actionable — the user just has to authenticate manually first.
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

function buildNoInvoiceNudgeSubject() {
  return 'Your first invoice is one click away — need a hand?';
}

function buildNoInvoiceNudgeHtml(row, _now, opts) {
  const greeting = greetingName(row);
  const newUrl = newInvoiceUrl(opts);
  const dashUrl = dashboardUrl();
  const newButton = newUrl
    ? `<p style="margin:24px 0;"><a href="${escapeHtml(newUrl)}" style="background:#4f46e5;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px;display:inline-block;">Create your first invoice →</a></p>`
    : '';
  const dashLine = dashUrl
    ? `<p style="color:#666;margin:8px 0;font-size:14px;">Or open the sample we made for you and edit it: <a href="${escapeHtml(dashUrl)}" style="color:#4f46e5;">${escapeHtml(dashUrl)}</a></p>`
    : '';

  return `<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#222;background:#f7f7f9;margin:0;padding:24px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #eaeaea;">
  <tr><td style="padding:24px 28px;">
    <h2 style="margin:0 0 8px 0;color:#111;">Ready to send your first invoice?</h2>
    <p style="color:#222;margin:8px 0;font-size:16px;">Hi ${escapeHtml(greeting)},</p>
    <p style="color:#222;margin:8px 0;font-size:16px;">You signed up for DecentInvoice a couple of days ago but haven't created your first real invoice yet. It takes under 60 seconds — three fields (client, what you did, how much), one tap to share with your client:</p>
    <ul style="color:#222;margin:8px 0 16px 20px;font-size:15px;line-height:1.6;">
      <li>Type your client's name</li>
      <li>One line for what you did + the price</li>
      <li>Tap to share — your client gets the link, and you're on the get-paid clock</li>
    </ul>
    <p style="color:#222;margin:8px 0;font-size:15px;">If you want to see the finished shape first, the dashboard has a sample invoice you can edit and reuse.</p>
    ${newButton}
    ${dashLine}
    <p style="color:#999;font-size:12px;margin-top:24px;">Sent automatically by DecentInvoice. Reply to this email if anything's blocking you — we read every reply.</p>
  </td></tr>
</table>
</body></html>`;
}

function buildNoInvoiceNudgeText(row, _now, opts) {
  const greeting = greetingName(row);
  const newUrl = newInvoiceUrl(opts);
  const dashUrl = dashboardUrl();
  const lines = [
    `Hi ${greeting},`,
    '',
    'You signed up for DecentInvoice a couple of days ago but haven\'t created your first real invoice yet. It takes under 60 seconds — three fields (client, what you did, how much), one tap to share with your client:',
    '',
    '  - Type your client\'s name',
    '  - One line for what you did + the price',
    '  - Tap to share — your client gets the link, and you\'re on the get-paid clock',
    '',
    'If you want to see the finished shape first, the dashboard has a sample invoice you can edit and reuse.'
  ];
  if (newUrl) {
    lines.push('', `Create your first invoice: ${newUrl}`);
  }
  if (dashUrl) {
    lines.push('', `Or open the sample we made for you: ${dashUrl}`);
  }
  lines.push('', 'Reply to this email if anything\'s blocking you — we read every reply.');
  return lines.join('\n');
}

async function processNoInvoiceNudges(opts = {}) {
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
    rows = await db.getUsersForNoInvoiceNudge(minAgeHours);
  } catch (err) {
    log.error && log.error('no-invoice-nudge query failed:', err && err.message);
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

    // Best-effort: mint a magic-login URL so the CTA auto-signs-in the user.
    // Any failure falls back to the plain APP_URL path — we never sacrifice
    // the email send to a mint hiccup.
    let magicLoginUrl = '';
    try {
      const mint = await mintMagicLoginToken(db, row.id, { ttlMinutes });
      if (mint && mint.ok && mint.url) {
        magicLoginUrl = mint.url;
      } else if (mint && !mint.ok) {
        log.warn && log.warn(`no-invoice-nudge magic-link mint skipped for user ${row.id}: ${mint.reason}`);
      }
    } catch (err) {
      // Defence-in-depth: mintMagicLoginToken already catches internally,
      // but a future refactor that lets it throw must NEVER drop the nudge.
      log.warn && log.warn(`no-invoice-nudge magic-link mint threw for user ${row.id}:`, err && err.message);
    }
    const buildOpts = magicLoginUrl ? { magicLoginUrl } : undefined;

    let result;
    try {
      result = await sendEmail({
        to: row.email,
        subject: buildNoInvoiceNudgeSubject(row, now),
        html: buildNoInvoiceNudgeHtml(row, now, buildOpts),
        text: buildNoInvoiceNudgeText(row, now, buildOpts),
        replyTo: resolveReplyTo(row)
      });
    } catch (err) {
      log.error && log.error(`no-invoice-nudge send threw for user ${row.id}:`, err && err.message);
      summary.errors += 1;
      continue;
    }

    if (!result || result.ok !== true) {
      if (result && result.reason === 'not_configured') {
        summary.notConfigured += 1;
      } else {
        summary.errors += 1;
        log.warn && log.warn(`no-invoice-nudge for user ${row.id} failed:`,
          (result && (result.reason || result.error)) || 'unknown');
      }
      continue;
    }

    try {
      await db.markNoInvoiceNudgeSent(row.id);
      summary.sent += 1;
    } catch (err) {
      log.error && log.error(`failed to stamp no_invoice_nudge_sent_at for user ${row.id}:`, err && err.message);
      summary.errors += 1;
    }
  }

  return summary;
}

let _scheduledTask = null;

function startNoInvoiceNudgeJob(opts = {}) {
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
    console.error('node-cron not available; no-invoice-nudge job disabled:', err && err.message);
    return { ok: false, reason: 'cron_unavailable' };
  }

  const schedule = opts.schedule || process.env.NO_INVOICE_NUDGE_CRON_SCHEDULE || DEFAULT_SCHEDULE;
  const log = opts.log || console;

  try {
    _scheduledTask = cron.schedule(schedule, async () => {
      try {
        const summary = await processNoInvoiceNudges(opts);
        log.log && log.log(
          `[no-invoice-nudge] found=${summary.found} sent=${summary.sent} skipped=${summary.skipped} `
          + `errors=${summary.errors} notConfigured=${summary.notConfigured}`
        );
      } catch (err) {
        log.error && log.error('no-invoice-nudge cron tick failed:', err && err.message);
      }
    }, { timezone: 'UTC' });
  } catch (err) {
    console.error('failed to schedule no-invoice-nudge cron:', err && err.message);
    return { ok: false, reason: 'schedule_failed', error: err && err.message };
  }

  return { ok: true, schedule };
}

function stopNoInvoiceNudgeJob() {
  if (_scheduledTask && typeof _scheduledTask.stop === 'function') {
    try { _scheduledTask.stop(); } catch (_) { /* ignore */ }
  }
  _scheduledTask = null;
}

module.exports = {
  processNoInvoiceNudges,
  startNoInvoiceNudgeJob,
  stopNoInvoiceNudgeJob,
  buildNoInvoiceNudgeSubject,
  buildNoInvoiceNudgeHtml,
  buildNoInvoiceNudgeText,
  DEFAULT_MIN_AGE_HOURS,
  DEFAULT_SCHEDULE,
  NUDGE_TTL_MINUTES,
  _internal: { escapeHtml, greetingName, resolveReplyTo, newInvoiceUrl, dashboardUrl }
};
