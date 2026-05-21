'use strict';

/*
 * Sent-but-never-viewed nudge cron (Milestone 4 — first invoice sent → first
 * payment received).
 *
 * Fires once per invoice 72h+ after the freelancer fires a share-intent
 * button (WhatsApp/SMS/Email/Copy) on /invoices/:id when the client has
 * never opened the public /i/<token> link. This is the silent-failure
 * cohort that today's surfaces miss entirely:
 *
 *   - client-viewed-followup is gated on first_viewed_at IS NOT NULL —
 *     won't fire when the client never opens.
 *   - overdue-freelancer-digest waits for due_date — typically weeks later.
 *   - reminders.js is Pro-only AND emails the CLIENT — irrelevant when the
 *     client never received the link in the first place.
 *
 * Works for ALL plans. Free-tier users especially benefit: a freelancer who
 * shared via WhatsApp to a stale number has zero recourse today; this cron
 * surfaces the failure within 72h while the relationship is still warm.
 *
 * Anchor: sent_via_share_intent_at (the unambiguous freelancer-side "I sent
 * this" stamp). We deliberately skip manual Mark-as-Sent invoices because
 * updated_at drifts on every edit and we can't reliably window the nudge.
 *
 * Magic-login bake-in: for each cohort row we mint a 7-day magic-login
 * token and bake the auto-sign-in URL into the "Open invoice & re-share"
 * CTA with ?next=/invoices/<invoice_id> so the click lands the freelancer
 * directly on the invoice page where the share-intent buttons live.
 *
 * Design mirrors jobs/client-viewed-followup.js:
 *   - processSentNotViewedNudge({ db, sendEmail, now, log }) is the pure
 *     orchestrator. Dependency-injected, no module state. Returns a
 *     structured summary { found, sent, skipped, errors, notConfigured }.
 *   - startSentNotViewedNudgeJob(opts) schedules via node-cron. Cron
 *     failure is logged + swallowed; a broken cron must never crash the web.
 *   - RESEND_API_KEY unset → sendEmail returns
 *     { ok:false, reason:'not_configured' } → clean skip (no DB stamp,
 *     next pass retries) so the job is safe to deploy before the key lands.
 *   - Idempotency at the SQL layer: sent_not_viewed_nudge_sent_at IS NULL
 *     gates one-shot per invoice. The stamping UPDATE re-asserts the NULL
 *     guard so concurrent ticks can't double-send.
 */

const { db: realDb } = require('../db');
const {
  sendEmail: realSendEmail,
  buildSentNotViewedNudgeSubject,
  buildSentNotViewedNudgeHtml,
  buildSentNotViewedNudgeText
} = require('../lib/email');
const { mintMagicLoginToken: realMintMagicLoginToken } = require('../lib/magic-login');

const DEFAULT_MIN_HOURS = 72;
const DEFAULT_MAX_DAYS = 14;
const DEFAULT_SCHEDULE = '0 15 * * *'; // 15:00 UTC daily (after client-viewed-followup at 14:00)
// 7 days — matches every other auto-login URL in the cron stack.
const NUDGE_TTL_MINUTES = 7 * 24 * 60;

function resolveReplyTo(row) {
  if (!row) return null;
  return row.reply_to_email || row.business_email || row.email || null;
}

async function processSentNotViewedNudge(opts = {}) {
  const db = opts.db || realDb;
  const sendEmail = opts.sendEmail || realSendEmail;
  const mintMagicLoginToken = opts.mintMagicLoginToken || realMintMagicLoginToken;
  const now = opts.now || new Date();
  const minHours = opts.minHours || DEFAULT_MIN_HOURS;
  const maxDays = opts.maxDays || DEFAULT_MAX_DAYS;
  const ttlMinutes = Number.isFinite(opts.ttlMinutes) && opts.ttlMinutes > 0
    ? Math.floor(opts.ttlMinutes)
    : NUDGE_TTL_MINUTES;
  const log = opts.log || console;

  const summary = { found: 0, sent: 0, skipped: 0, errors: 0, notConfigured: 0 };

  let rows;
  try {
    rows = await db.getInvoicesForSentNotViewedNudge(minHours, maxDays);
  } catch (err) {
    log.error && log.error('sent-not-viewed-nudge query failed:', err && err.message);
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
        log.warn && log.warn(
          `sent-not-viewed-nudge magic-link mint skipped for user ${row.user_id}: ${mint.reason}`
        );
      }
    } catch (err) {
      log.warn && log.warn(
        `sent-not-viewed-nudge magic-link mint threw for user ${row.user_id}:`,
        err && err.message
      );
    }
    const buildOpts = magicLoginUrl ? { magicLoginUrl } : undefined;

    let result;
    try {
      result = await sendEmail({
        to: row.email,
        subject: buildSentNotViewedNudgeSubject(row),
        html: buildSentNotViewedNudgeHtml(row, now, buildOpts),
        text: buildSentNotViewedNudgeText(row, now, buildOpts),
        replyTo: resolveReplyTo(row)
      });
    } catch (err) {
      log.error && log.error(
        `sent-not-viewed-nudge send threw for invoice ${row.invoice_id}:`,
        err && err.message
      );
      summary.errors += 1;
      continue;
    }

    if (!result || result.ok !== true) {
      if (result && result.reason === 'not_configured') {
        summary.notConfigured += 1;
      } else {
        summary.errors += 1;
        log.warn && log.warn(
          `sent-not-viewed-nudge for invoice ${row.invoice_id} failed:`,
          (result && (result.reason || result.error)) || 'unknown'
        );
      }
      continue;
    }

    try {
      await db.markSentNotViewedNudgeSent(row.invoice_id);
      summary.sent += 1;
    } catch (err) {
      log.error && log.error(
        `failed to stamp sent_not_viewed_nudge_sent_at for invoice ${row.invoice_id}:`,
        err && err.message
      );
      summary.errors += 1;
    }
  }

  return summary;
}

let _scheduledTask = null;

function startSentNotViewedNudgeJob(opts = {}) {
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
    console.error(
      'node-cron not available; sent-not-viewed-nudge job disabled:',
      err && err.message
    );
    return { ok: false, reason: 'cron_unavailable' };
  }

  const schedule = opts.schedule
    || process.env.SENT_NOT_VIEWED_NUDGE_CRON_SCHEDULE
    || DEFAULT_SCHEDULE;
  const log = opts.log || console;

  try {
    _scheduledTask = cron.schedule(schedule, async () => {
      try {
        const summary = await processSentNotViewedNudge(opts);
        log.log && log.log(
          `[sent-not-viewed-nudge] found=${summary.found} sent=${summary.sent} `
          + `skipped=${summary.skipped} errors=${summary.errors} `
          + `notConfigured=${summary.notConfigured}`
        );
      } catch (err) {
        log.error && log.error(
          'sent-not-viewed-nudge cron tick failed:',
          err && err.message
        );
      }
    }, { timezone: 'UTC' });
  } catch (err) {
    console.error('failed to schedule sent-not-viewed-nudge cron:', err && err.message);
    return { ok: false, reason: 'schedule_failed', error: err && err.message };
  }

  return { ok: true, schedule };
}

function stopSentNotViewedNudgeJob() {
  if (_scheduledTask && typeof _scheduledTask.stop === 'function') {
    try { _scheduledTask.stop(); } catch (_) { /* ignore */ }
  }
  _scheduledTask = null;
}

module.exports = {
  processSentNotViewedNudge,
  startSentNotViewedNudgeJob,
  stopSentNotViewedNudgeJob,
  DEFAULT_MIN_HOURS,
  DEFAULT_MAX_DAYS,
  DEFAULT_SCHEDULE,
  NUDGE_TTL_MINUTES,
  _internal: { resolveReplyTo }
};
