'use strict';

/*
 * Client-Viewed-But-Unpaid Follow-up Email (Milestone 4 — first invoice sent
 * → first payment received).
 *
 * Fires once per invoice when a client has demonstrably opened the public
 * /i/<token> share link 48h+ ago but the invoice still isn't paid. This is
 * the peak conversion moment that's otherwise un-nudged today:
 *
 *   - sendClientViewedEmail (lib/email.js) fires the INSTANT of first open
 *     and stops. A client who slept on it and forgot doesn't get a second
 *     real-time signal.
 *   - jobs/overdue-freelancer-digest only fires AFTER due_date passes —
 *     typically weeks later, well past the highest-converting window.
 *
 * Works for ALL plans — free users get the freelancer-side push (their only
 * automated nudge, since the Pro client-side reminder cron is plan-gated);
 * Pro users get the same nudge because the conversion lift is independent of
 * plan tier.
 *
 * Magic-login bake-in: for each cohort row we mint a 7-day magic-login
 * token and bake the auto-sign-in URL into the "Open invoice & send a
 * follow-up" CTA with ?next=/invoices/<invoice_id>. A user who clicks the
 * reminder hours or days later — likely on a different device or with an
 * expired session — lands signed-in directly on the invoice's own page
 * where the share-intent buttons + mark-as-paid live, instead of bouncing
 * at /auth/login. Mint failures soft-fail to the plain APP_URL CTA; the
 * email is never sacrificed to a mint hiccup.
 *
 * Design mirrors jobs/stale-draft-email.js:
 *   - processClientViewedFollowup({ db, sendEmail, now, log }) is the pure
 *     orchestrator. Dependency-injected, no module state. Returns a
 *     structured summary { found, sent, skipped, errors, notConfigured }.
 *   - startClientViewedFollowupJob(opts) schedules via node-cron. Cron
 *     failure is logged + swallowed; a broken cron must never crash the web.
 *   - RESEND_API_KEY unset → sendEmail returns
 *     { ok:false, reason:'not_configured' } → clean skip (no DB stamp,
 *     next pass retries) so the job is safe to deploy before the key lands.
 *   - Idempotency at the SQL layer: client_viewed_followup_sent_at IS NULL
 *     gates one-shot per invoice. The stamping UPDATE in
 *     markClientViewedFollowupSent additionally re-asserts the NULL guard
 *     so concurrent ticks can't double-send.
 */

const { db: realDb } = require('../db');
const {
  sendEmail: realSendEmail,
  buildClientViewedFollowupSubject,
  buildClientViewedFollowupHtml,
  buildClientViewedFollowupText
} = require('../lib/email');
const { mintMagicLoginToken: realMintMagicLoginToken } = require('../lib/magic-login');
const { resolveUnsubscribeUrlForRow } = require('../lib/unsubscribe');

const DEFAULT_MIN_HOURS = 48;
const DEFAULT_MAX_DAYS = 14;
const DEFAULT_SCHEDULE = '0 14 * * *'; // 14:00 UTC daily (after overdue-digest at 13:00)
// 7 days — matches the welcome / stale-draft / no-invoice-nudge magic-login
// TTLs. The nudge fires 2-14 days after first view; the recipient may not
// click for several more days, especially over a weekend. A 7-day window
// is loose enough to still auto-sign-in then, tight enough that the token
// rotates well before any practical mailbox-leak horizon.
const FOLLOWUP_TTL_MINUTES = 7 * 24 * 60;

function resolveReplyTo(row) {
  if (!row) return null;
  return row.reply_to_email || row.business_email || row.email || null;
}

async function processClientViewedFollowup(opts = {}) {
  const db = opts.db || realDb;
  const sendEmail = opts.sendEmail || realSendEmail;
  const mintMagicLoginToken = opts.mintMagicLoginToken || realMintMagicLoginToken;
  const now = opts.now || new Date();
  const minHours = opts.minHours || DEFAULT_MIN_HOURS;
  const maxDays = opts.maxDays || DEFAULT_MAX_DAYS;
  const ttlMinutes = Number.isFinite(opts.ttlMinutes) && opts.ttlMinutes > 0
    ? Math.floor(opts.ttlMinutes)
    : FOLLOWUP_TTL_MINUTES;
  const log = opts.log || console;

  const summary = { found: 0, sent: 0, skipped: 0, errors: 0, notConfigured: 0 };

  let rows;
  try {
    rows = await db.getInvoicesForClientViewedFollowup(minHours, maxDays);
  } catch (err) {
    log.error && log.error('client-viewed-followup query failed:', err && err.message);
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

    // Best-effort: mint a magic-login URL so the CTA auto-signs-in the user
    // and deep-links to the invoice page. Any failure falls back to the
    // plain APP_URL path — we never sacrifice the email send to a mint hiccup.
    let magicLoginUrl = '';
    try {
      const mint = await mintMagicLoginToken(db, row.user_id, { ttlMinutes });
      if (mint && mint.ok && mint.url) {
        magicLoginUrl = mint.url;
      } else if (mint && !mint.ok) {
        log.warn && log.warn(
          `client-viewed-followup magic-link mint skipped for user ${row.user_id}: ${mint.reason}`
        );
      }
    } catch (err) {
      // Defence-in-depth: mintMagicLoginToken catches internally, but a
      // future refactor that lets it throw must NEVER drop the reminder.
      log.warn && log.warn(
        `client-viewed-followup magic-link mint threw for user ${row.user_id}:`,
        err && err.message
      );
    }
    const buildOpts = magicLoginUrl ? { magicLoginUrl } : undefined;

    const unsubscribeUrl = await resolveUnsubscribeUrlForRow(db, { id: row.user_id, unsubscribe_token: row.unsubscribe_token });

    let result;
    try {
      result = await sendEmail({
        to: row.email,
        subject: buildClientViewedFollowupSubject(row),
        html: buildClientViewedFollowupHtml(row, now, buildOpts),
        text: buildClientViewedFollowupText(row, now, buildOpts),
        replyTo: resolveReplyTo(row),
        unsubscribeUrl: unsubscribeUrl || undefined
      });
    } catch (err) {
      log.error && log.error(
        `client-viewed-followup send threw for invoice ${row.invoice_id}:`,
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
          `client-viewed-followup for invoice ${row.invoice_id} failed:`,
          (result && (result.reason || result.error)) || 'unknown'
        );
      }
      continue;
    }

    try {
      await db.markClientViewedFollowupSent(row.invoice_id);
      summary.sent += 1;
    } catch (err) {
      log.error && log.error(
        `failed to stamp client_viewed_followup_sent_at for invoice ${row.invoice_id}:`,
        err && err.message
      );
      summary.errors += 1;
    }
  }

  return summary;
}

let _scheduledTask = null;

function startClientViewedFollowupJob(opts = {}) {
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
      'node-cron not available; client-viewed-followup job disabled:',
      err && err.message
    );
    return { ok: false, reason: 'cron_unavailable' };
  }

  const schedule = opts.schedule
    || process.env.CLIENT_VIEWED_FOLLOWUP_CRON_SCHEDULE
    || DEFAULT_SCHEDULE;
  const log = opts.log || console;

  try {
    _scheduledTask = cron.schedule(schedule, async () => {
      try {
        const summary = await processClientViewedFollowup(opts);
        log.log && log.log(
          `[client-viewed-followup] found=${summary.found} sent=${summary.sent} `
          + `skipped=${summary.skipped} errors=${summary.errors} `
          + `notConfigured=${summary.notConfigured}`
        );
      } catch (err) {
        log.error && log.error(
          'client-viewed-followup cron tick failed:',
          err && err.message
        );
      }
    }, { timezone: 'UTC' });
  } catch (err) {
    console.error('failed to schedule client-viewed-followup cron:', err && err.message);
    return { ok: false, reason: 'schedule_failed', error: err && err.message };
  }

  return { ok: true, schedule };
}

function stopClientViewedFollowupJob() {
  if (_scheduledTask && typeof _scheduledTask.stop === 'function') {
    try { _scheduledTask.stop(); } catch (_) { /* ignore */ }
  }
  _scheduledTask = null;
}

module.exports = {
  processClientViewedFollowup,
  startClientViewedFollowupJob,
  stopClientViewedFollowupJob,
  DEFAULT_MIN_HOURS,
  DEFAULT_MAX_DAYS,
  DEFAULT_SCHEDULE,
  FOLLOWUP_TTL_MINUTES,
  _internal: { resolveReplyTo }
};
