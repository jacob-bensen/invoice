'use strict';

/*
 * Inactive-user re-engagement cron (Milestone 1 — signup → first dashboard
 * re-entry, for the activated-but-silent cohort).
 *
 * The full activation/conversion cron stack (no-invoice-nudge x2, stale-draft
 * email x2, pending-quick-invoice-nudge, sent-not-viewed-nudge, client-viewed-
 * followup x2, overdue-freelancer-digest, pending-payment-claim-followup,
 * due-soon-reminder) fires on invoice-state cohorts. A user who already
 * activated once (`invoice_count > 0`) and then went silent for 14+ days
 * falls through every existing job: the no-invoice gates require
 * invoice_count = 0, the draft gates require an open draft, and the sent-side
 * gates require recent invoice activity. This cron picks up exactly that
 * cohort with a friendly "anything new to bill?" magic-login CTA back to
 * /invoices/quick. Every return re-arms the full Milestone 2-4 cascade for
 * any new invoice the user creates, which compounds with each cycle.
 *
 * Design mirrors jobs/no-invoice-nudge.js and jobs/second-no-invoice-nudge.js:
 *   - `processInactiveReengagement({ db, sendEmail, mintMagicLoginToken,
 *     now, log, minInactiveHours, ttlMinutes })` is the pure orchestrator.
 *     Dependency-injected, no module state. Returns
 *     { found, sent, skipped, errors, notConfigured }.
 *   - `startInactiveReengagementJob(opts)` schedules via node-cron. Cron
 *     failures log-and-swallow.
 *   - `RESEND_API_KEY` unset → sendEmail returns
 *     { ok:false, reason:'not_configured' } and we treat it as a clean skip
 *     (no DB stamp, next pass retries).
 *   - Idempotency at SQL: `inactive_reengagement_sent_at IS NULL`. One-shot
 *     per user — a user silent after one re-engagement nudge isn't moved by
 *     a second.
 *   - Lifecycle opt-out honoured via the query.
 */

const { db: realDb } = require('../db');
const { sendEmail: realSendEmail } = require('../lib/email');
const { mintMagicLoginToken: realMintMagicLoginToken } = require('../lib/magic-login');
const { resolveUnsubscribeUrlForRow } = require('../lib/unsubscribe');

const DEFAULT_MIN_INACTIVE_HOURS = 14 * 24;
// 15:00 UTC — slots in after the existing daily activation/Milestone-4 crons
// (10:00 trial-nudge, 11:00 stale-draft, 12:00 no-invoice, 13:00 pending-
// quick, 13:30 second-no-invoice, 14:00 client-viewed-followup, 14:30
// second-client-viewed-followup) so a single Heroku tick spreads SMTP load.
const DEFAULT_SCHEDULE = '0 15 * * *';
// 14-day magic-login TTL. The cohort is inactive by definition; a click may
// be days later. 14 days is loose enough to still auto-sign-in then, tight
// enough to rotate well before any practical mailbox-leak horizon.
const REENGAGEMENT_TTL_MINUTES = 14 * 24 * 60;

function resolveReplyTo(row) {
  if (!row) return null;
  return row.reply_to_email || row.business_email || row.email || null;
}

async function processInactiveReengagement(opts = {}) {
  const db = opts.db || realDb;
  const sendEmail = opts.sendEmail || realSendEmail;
  const mintMagicLoginToken = opts.mintMagicLoginToken || realMintMagicLoginToken;
  const now = opts.now || new Date();
  const minInactiveHours = opts.minInactiveHours || DEFAULT_MIN_INACTIVE_HOURS;
  const ttlMinutes = Number.isFinite(opts.ttlMinutes) && opts.ttlMinutes > 0
    ? Math.floor(opts.ttlMinutes)
    : REENGAGEMENT_TTL_MINUTES;
  const log = opts.log || console;

  const { buildInactiveReengagementSubject, buildInactiveReengagementHtml,
          buildInactiveReengagementText } = require('../lib/email');

  const summary = { found: 0, sent: 0, skipped: 0, errors: 0, notConfigured: 0 };

  let rows;
  try {
    rows = await db.getUsersForInactiveReengagement(minInactiveHours);
  } catch (err) {
    log.error && log.error('inactive-reengagement query failed:', err && err.message);
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
        log.warn && log.warn(`inactive-reengagement magic-link mint skipped for user ${row.id}: ${mint.reason}`);
      }
    } catch (err) {
      log.warn && log.warn(`inactive-reengagement magic-link mint threw for user ${row.id}:`, err && err.message);
    }
    const buildOpts = magicLoginUrl ? { magicLoginUrl, now } : { now };

    const unsubscribeUrl = await resolveUnsubscribeUrlForRow(db, row);

    let result;
    try {
      result = await sendEmail({
        to: row.email,
        subject: buildInactiveReengagementSubject(row, now),
        html: buildInactiveReengagementHtml(row, now, buildOpts),
        text: buildInactiveReengagementText(row, now, buildOpts),
        replyTo: resolveReplyTo(row),
        unsubscribeUrl: unsubscribeUrl || undefined
      });
    } catch (err) {
      log.error && log.error(`inactive-reengagement send threw for user ${row.id}:`, err && err.message);
      summary.errors += 1;
      continue;
    }

    if (!result || result.ok !== true) {
      if (result && result.reason === 'not_configured') {
        summary.notConfigured += 1;
      } else {
        summary.errors += 1;
        log.warn && log.warn(`inactive-reengagement for user ${row.id} failed:`,
          (result && (result.reason || result.error)) || 'unknown');
      }
      continue;
    }

    try {
      await db.markInactiveReengagementSent(row.id);
      summary.sent += 1;
    } catch (err) {
      log.error && log.error(`failed to stamp inactive_reengagement_sent_at for user ${row.id}:`, err && err.message);
      summary.errors += 1;
    }
  }

  return summary;
}

let _scheduledTask = null;

function startInactiveReengagementJob(opts = {}) {
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
    console.error('node-cron not available; inactive-reengagement job disabled:', err && err.message);
    return { ok: false, reason: 'cron_unavailable' };
  }

  const schedule = opts.schedule || process.env.INACTIVE_REENGAGEMENT_CRON_SCHEDULE || DEFAULT_SCHEDULE;
  const log = opts.log || console;

  try {
    _scheduledTask = cron.schedule(schedule, async () => {
      try {
        const summary = await processInactiveReengagement(opts);
        log.log && log.log(
          `[inactive-reengagement] found=${summary.found} sent=${summary.sent} skipped=${summary.skipped} `
          + `errors=${summary.errors} notConfigured=${summary.notConfigured}`
        );
      } catch (err) {
        log.error && log.error('inactive-reengagement cron tick failed:', err && err.message);
      }
    }, { timezone: 'UTC' });
  } catch (err) {
    console.error('failed to schedule inactive-reengagement cron:', err && err.message);
    return { ok: false, reason: 'schedule_failed', error: err && err.message };
  }

  return { ok: true, schedule };
}

function stopInactiveReengagementJob() {
  if (_scheduledTask && typeof _scheduledTask.stop === 'function') {
    try { _scheduledTask.stop(); } catch (_) { /* ignore */ }
  }
  _scheduledTask = null;
}

module.exports = {
  processInactiveReengagement,
  startInactiveReengagementJob,
  stopInactiveReengagementJob,
  DEFAULT_MIN_INACTIVE_HOURS,
  DEFAULT_SCHEDULE,
  REENGAGEMENT_TTL_MINUTES,
  _internal: { resolveReplyTo }
};
