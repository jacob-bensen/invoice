'use strict';

/*
 * Terminal Client-Viewed-But-Unpaid Follow-up Email (Milestone 4 — first
 * invoice sent → first payment received).
 *
 * Cohort: invoices whose first client_viewed_followup_sent_at fired at least
 * `firstSentGapDays` (default 7) days ago and are STILL in 'sent' / 'overdue'
 * status. Bounded to `first_viewed_at > NOW() - maxDays` (default 30) so we
 * never overlap the overdue-digest cohort on the older end. Without this
 * terminal pass, a viewed-but-unpaid invoice gets exactly ONE nudge and then
 * silence until due_date — for net-30 invoicing that's the full chase
 * window. This second pass injects a single, empathetic terminal nudge into
 * that quiet stretch and then drops the invoice off the cohort.
 *
 * Design mirrors jobs/second-stale-draft-email.js + jobs/client-viewed-followup.js:
 *   - processSecondClientViewedFollowup({ db, sendEmail, ... }) is the pure
 *     dependency-injected orchestrator. Returns a structured summary.
 *   - startSecondClientViewedFollowupJob(opts) schedules via node-cron at
 *     14:30 UTC daily (30 minutes after the first client-viewed-followup at
 *     14:00 UTC, so each cohort row matches exactly one of the two queries).
 *   - RESEND_API_KEY unset → not_configured → clean skip, no stamp, retry
 *     next tick.
 *   - Magic-login bake-in: 7-day token + ?next=/invoices/<id>.
 *   - Idempotency at the SQL layer: second_client_viewed_followup_sent_at
 *     IS NULL guarantees one-shot per invoice. The stamping UPDATE in
 *     markSecondClientViewedFollowupSent re-asserts the NULL guard so
 *     concurrent ticks can't double-send.
 */

const { db: realDb } = require('../db');
const {
  sendEmail: realSendEmail,
  buildSecondClientViewedFollowupSubject,
  buildSecondClientViewedFollowupHtml,
  buildSecondClientViewedFollowupText
} = require('../lib/email');
const { mintMagicLoginToken: realMintMagicLoginToken } = require('../lib/magic-login');
const { resolveUnsubscribeUrlForRow } = require('../lib/unsubscribe');

const DEFAULT_FIRST_SENT_GAP_DAYS = 7;
const DEFAULT_MAX_DAYS = 30;
const DEFAULT_SCHEDULE = '30 14 * * *'; // 14:30 UTC daily (30 min after first follow-up at 14:00)
// 7-day TTL — same as every other re-engagement email in the cohort. The
// terminal nudge fires 7+ days after the first follow-up; the recipient may
// click days later. 7-day window keeps auto-sign-in tractable while rotating
// the token well before any practical mailbox-leak horizon.
const FOLLOWUP_TTL_MINUTES = 7 * 24 * 60;

function resolveReplyTo(row) {
  if (!row) return null;
  return row.reply_to_email || row.business_email || row.email || null;
}

async function processSecondClientViewedFollowup(opts = {}) {
  const db = opts.db || realDb;
  const sendEmail = opts.sendEmail || realSendEmail;
  const mintMagicLoginToken = opts.mintMagicLoginToken || realMintMagicLoginToken;
  const now = opts.now || new Date();
  const firstSentGapDays = opts.firstSentGapDays || DEFAULT_FIRST_SENT_GAP_DAYS;
  const maxDays = opts.maxDays || DEFAULT_MAX_DAYS;
  const ttlMinutes = Number.isFinite(opts.ttlMinutes) && opts.ttlMinutes > 0
    ? Math.floor(opts.ttlMinutes)
    : FOLLOWUP_TTL_MINUTES;
  const log = opts.log || console;

  const summary = { found: 0, sent: 0, skipped: 0, errors: 0, notConfigured: 0 };

  let rows;
  try {
    rows = await db.getInvoicesForSecondClientViewedFollowup(firstSentGapDays, maxDays);
  } catch (err) {
    log.error && log.error('second-client-viewed-followup query failed:', err && err.message);
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
          `second-client-viewed-followup magic-link mint skipped for user ${row.user_id}: ${mint.reason}`
        );
      }
    } catch (err) {
      log.warn && log.warn(
        `second-client-viewed-followup magic-link mint threw for user ${row.user_id}:`,
        err && err.message
      );
    }
    const buildOpts = magicLoginUrl ? { magicLoginUrl } : undefined;

    const unsubscribeUrl = await resolveUnsubscribeUrlForRow(db, { id: row.user_id, unsubscribe_token: row.unsubscribe_token });

    let result;
    try {
      result = await sendEmail({
        to: row.email,
        subject: buildSecondClientViewedFollowupSubject(row),
        html: buildSecondClientViewedFollowupHtml(row, now, buildOpts),
        text: buildSecondClientViewedFollowupText(row, now, buildOpts),
        replyTo: resolveReplyTo(row),
        unsubscribeUrl: unsubscribeUrl || undefined
      });
    } catch (err) {
      log.error && log.error(
        `second-client-viewed-followup send threw for invoice ${row.invoice_id}:`,
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
          `second-client-viewed-followup for invoice ${row.invoice_id} failed:`,
          (result && (result.reason || result.error)) || 'unknown'
        );
      }
      continue;
    }

    try {
      await db.markSecondClientViewedFollowupSent(row.invoice_id);
      summary.sent += 1;
    } catch (err) {
      log.error && log.error(
        `failed to stamp second_client_viewed_followup_sent_at for invoice ${row.invoice_id}:`,
        err && err.message
      );
      summary.errors += 1;
    }
  }

  return summary;
}

let _scheduledTask = null;

function startSecondClientViewedFollowupJob(opts = {}) {
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
      'node-cron not available; second-client-viewed-followup job disabled:',
      err && err.message
    );
    return { ok: false, reason: 'cron_unavailable' };
  }

  const schedule = opts.schedule
    || process.env.SECOND_CLIENT_VIEWED_FOLLOWUP_CRON_SCHEDULE
    || DEFAULT_SCHEDULE;
  const log = opts.log || console;

  try {
    _scheduledTask = cron.schedule(schedule, async () => {
      try {
        const summary = await processSecondClientViewedFollowup(opts);
        log.log && log.log(
          `[second-client-viewed-followup] found=${summary.found} sent=${summary.sent} `
          + `skipped=${summary.skipped} errors=${summary.errors} `
          + `notConfigured=${summary.notConfigured}`
        );
      } catch (err) {
        log.error && log.error(
          'second-client-viewed-followup cron tick failed:',
          err && err.message
        );
      }
    }, { timezone: 'UTC' });
  } catch (err) {
    console.error('failed to schedule second-client-viewed-followup cron:', err && err.message);
    return { ok: false, reason: 'schedule_failed', error: err && err.message };
  }

  return { ok: true, schedule };
}

function stopSecondClientViewedFollowupJob() {
  if (_scheduledTask && typeof _scheduledTask.stop === 'function') {
    try { _scheduledTask.stop(); } catch (_) { /* ignore */ }
  }
  _scheduledTask = null;
}

module.exports = {
  processSecondClientViewedFollowup,
  startSecondClientViewedFollowupJob,
  stopSecondClientViewedFollowupJob,
  DEFAULT_FIRST_SENT_GAP_DAYS,
  DEFAULT_MAX_DAYS,
  DEFAULT_SCHEDULE,
  FOLLOWUP_TTL_MINUTES,
  _internal: { resolveReplyTo }
};
