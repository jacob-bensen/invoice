'use strict';

/*
 * Overdue-Invoice Freelancer Digest — daily email back to the freelancer
 * when their sent invoices have gone past their due_date.
 *
 * Closes the freelancer-side gap on Milestone 4 (first invoice sent → first
 * payment received). The existing jobs/reminders.js emails the CLIENT
 * (Pro-only, gated on client_email). This job emails the FREELANCER:
 *   - works for ALL plans — free users have no automated client reminder,
 *     so this is their only nudge to chase the open invoice;
 *   - complements client-side reminders for Pro users when client_email is
 *     missing (a chunk of the Pro cohort, where reminders.js silently skips);
 *   - pulls the freelancer back into the dashboard, re-exposing them to the
 *     trial-urgency stack, upgrade modal, and celebration banner — every
 *     return-to-app event is upstream of the conversion stack.
 *
 * Magic-login bake-in (Milestone 4 friction-removal): for each cohort row
 * we mint a 7-day magic-login token (lib/magic-login.mintMagicLoginToken)
 * and bake the auto-sign-in URL into the "Open your dashboard →" CTA with
 * `?next=/invoices`. A user reading the digest on mobile or a fresh device
 * with an expired session lands signed-in directly on the dashboard where
 * they can chase the invoice, instead of bouncing at /auth/login (the
 * cohort hit hardest by login-friction is the same cohort least likely to
 * remember a six-month-old password). Mint failures soft-fall back to the
 * plain APP_URL CTA; the digest is never sacrificed to a mint hiccup.
 *
 * Design mirrors jobs/no-invoice-nudge.js / jobs/stale-draft-email.js:
 *   - `processOverdueDigest({ db, sendEmail, now, cooldownDays, log })` is
 *     the pure orchestrator. Dependency-injected, no module state. Returns a
 *     structured summary { found, sent, skipped, errors, notConfigured }.
 *   - `startOverdueDigestJob(opts)` schedules via node-cron. Cron failures
 *     log-and-swallow; a broken cron must never crash the web process.
 *   - `RESEND_API_KEY` unset → sendEmail returns
 *     { ok:false, reason:'not_configured' }. Treated as a clean skip
 *     (no DB stamp, next pass retries).
 *   - Cooldown enforced at the SQL layer: `overdue_digest_sent_at IS NULL`
 *     OR last-stamp > 7 days ago. A user with a chronic backlog gets at most
 *     one digest per cooldown window.
 */

const { db: realDb } = require('../db');
const { sendEmail: realSendEmail } = require('../lib/email');
const { escapeHtml, formatMoney } = require('../lib/html');
const { mintMagicLoginToken: realMintMagicLoginToken } = require('../lib/magic-login');
const { resolveUnsubscribeUrlForRow } = require('../lib/unsubscribe');

const DEFAULT_COOLDOWN_DAYS = 7;
const DEFAULT_SCHEDULE = '0 13 * * *'; // 13:00 UTC daily (after no-invoice at 12:00)
// 7 days — matches the welcome / stale-draft / no-invoice-nudge magic-login
// TTLs. The digest fires daily on a 7-day cooldown; the recipient may not
// click for several more days, especially over a weekend. A 7-day window is
// loose enough to still auto-sign-in then, tight enough that the token
// rotates well before any practical mailbox-leak horizon.
const DIGEST_TTL_MINUTES = 7 * 24 * 60;

function greetingName(row) {
  return (row && (row.name || row.business_name)) || 'there';
}

function resolveReplyTo(row) {
  if (!row) return null;
  return row.reply_to_email || row.business_email || row.email || null;
}

function dashboardUrl(opts) {
  // When a one-shot magic-login URL is supplied (processOverdueDigest mints
  // one per cohort row), bake it into the CTA with ?next=/invoices so the
  // click auto-signs-in and lands directly on the dashboard. Falls back to
  // the plain APP_URL path when no magic URL is available (mint failed, no
  // DB, etc.) so the digest is still actionable — the user just has to
  // authenticate manually first.
  const magicLoginUrl = opts && typeof opts.magicLoginUrl === 'string'
    ? opts.magicLoginUrl.trim() : '';
  if (magicLoginUrl) {
    return `${magicLoginUrl}?next=/invoices`;
  }
  const base = (process.env.APP_URL || '').replace(/\/+$/, '');
  return base ? `${base}/invoices` : '';
}

function daysOverdue(oldest, now = new Date()) {
  if (!oldest) return 0;
  const due = new Date(oldest).getTime();
  if (!Number.isFinite(due)) return 0;
  const diff = now.getTime() - due;
  return Math.max(0, Math.floor(diff / 86400000));
}

function buildOverdueDigestSubject(row) {
  const n = parseInt(row && row.overdue_count, 10) || 0;
  if (n <= 1) {
    return 'You have an overdue invoice — time to follow up';
  }
  return `You have ${n} overdue invoices — time to follow up`;
}

function buildOverdueDigestHtml(row, now = new Date(), opts) {
  const greeting = greetingName(row);
  const n = parseInt(row && row.overdue_count, 10) || 0;
  const total = formatMoney(row && row.overdue_total);
  const oldest = daysOverdue(row && row.oldest_due_date, now);
  const dashUrl = dashboardUrl(opts);
  const dashButton = dashUrl
    ? `<p style="margin:24px 0;"><a href="${escapeHtml(dashUrl)}" style="background:#b91c1c;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px;display:inline-block;">Open your dashboard →</a></p>`
    : '';
  const noun = n === 1 ? 'invoice' : 'invoices';
  const oldestLine = oldest > 0
    ? `<p style="color:#b91c1c;margin:4px 0;"><strong>Oldest is ${oldest} day${oldest === 1 ? '' : 's'} past due.</strong></p>`
    : '';

  return `<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#222;background:#f7f7f9;margin:0;padding:24px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #eaeaea;">
  <tr><td style="padding:24px 28px;">
    <h2 style="margin:0 0 8px 0;color:#111;">Time to chase ${n === 1 ? 'an' : 'a few'} overdue ${noun}</h2>
    <p style="color:#222;margin:8px 0;font-size:16px;">Hi ${escapeHtml(greeting)},</p>
    <p style="color:#222;margin:8px 0;font-size:16px;">You have <strong>${n} overdue ${noun}</strong> worth <strong>${escapeHtml(total)}</strong> in DecentInvoice — sent to your client${n === 1 ? '' : 's'} but not yet paid.</p>
    ${oldestLine}
    <p style="color:#555;margin:8px 0;font-size:15px;line-height:1.5;">A quick personal message tends to do most of the work. From the dashboard you can:</p>
    <ul style="color:#555;margin:8px 0 16px 20px;font-size:15px;line-height:1.6;">
      <li>Re-send the public link to your client</li>
      <li>Mark anything that was paid out-of-band</li>
      <li>Update the due date or add payment instructions</li>
    </ul>
    ${dashButton}
    <p style="color:#999;font-size:12px;margin-top:24px;">Sent automatically by DecentInvoice. Reply to this email if you want to mute future overdue digests.</p>
  </td></tr>
</table>
</body></html>`;
}

function buildOverdueDigestText(row, now = new Date(), opts) {
  const greeting = greetingName(row);
  const n = parseInt(row && row.overdue_count, 10) || 0;
  const total = formatMoney(row && row.overdue_total);
  const oldest = daysOverdue(row && row.oldest_due_date, now);
  const dashUrl = dashboardUrl(opts);
  const noun = n === 1 ? 'invoice' : 'invoices';
  const lines = [
    `Hi ${greeting},`,
    '',
    `You have ${n} overdue ${noun} worth ${total} in DecentInvoice — `
      + `sent to your client${n === 1 ? '' : 's'} but not yet paid.`
  ];
  if (oldest > 0) {
    lines.push('', `Oldest is ${oldest} day${oldest === 1 ? '' : 's'} past due.`);
  }
  lines.push(
    '',
    'A quick personal message tends to do most of the work. From the dashboard you can:',
    '',
    '  - Re-send the public link to your client',
    '  - Mark anything that was paid out-of-band',
    '  - Update the due date or add payment instructions'
  );
  if (dashUrl) {
    lines.push('', `Open your dashboard: ${dashUrl}`);
  }
  lines.push('', 'Reply to this email if you want to mute future overdue digests.');
  return lines.join('\n');
}

async function processOverdueDigest(opts = {}) {
  const db = opts.db || realDb;
  const sendEmail = opts.sendEmail || realSendEmail;
  const mintMagicLoginToken = opts.mintMagicLoginToken || realMintMagicLoginToken;
  const now = opts.now || new Date();
  const cooldownDays = opts.cooldownDays || DEFAULT_COOLDOWN_DAYS;
  const ttlMinutes = Number.isFinite(opts.ttlMinutes) && opts.ttlMinutes > 0
    ? Math.floor(opts.ttlMinutes)
    : DIGEST_TTL_MINUTES;
  const log = opts.log || console;

  const summary = { found: 0, sent: 0, skipped: 0, errors: 0, notConfigured: 0 };

  let rows;
  try {
    rows = await db.getUsersWithOverdueInvoicesForDigest(cooldownDays);
  } catch (err) {
    log.error && log.error('overdue-digest query failed:', err && err.message);
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
    // and lands on the dashboard. Any failure falls back to the plain
    // APP_URL path — we never sacrifice the digest send to a mint hiccup.
    let magicLoginUrl = '';
    try {
      const mint = await mintMagicLoginToken(db, row.user_id, { ttlMinutes });
      if (mint && mint.ok && mint.url) {
        magicLoginUrl = mint.url;
      } else if (mint && !mint.ok) {
        log.warn && log.warn(
          `overdue-digest magic-link mint skipped for user ${row.user_id}: ${mint.reason}`
        );
      }
    } catch (err) {
      // Defence-in-depth: mintMagicLoginToken catches internally, but a
      // future refactor that lets it throw must NEVER drop the digest.
      log.warn && log.warn(
        `overdue-digest magic-link mint threw for user ${row.user_id}:`,
        err && err.message
      );
    }
    const buildOpts = magicLoginUrl ? { magicLoginUrl } : undefined;

    const unsubscribeUrl = await resolveUnsubscribeUrlForRow(db, { id: row.user_id, unsubscribe_token: row.unsubscribe_token });

    let result;
    try {
      result = await sendEmail({
        to: row.email,
        subject: buildOverdueDigestSubject(row, now),
        html: buildOverdueDigestHtml(row, now, buildOpts),
        text: buildOverdueDigestText(row, now, buildOpts),
        replyTo: resolveReplyTo(row),
        unsubscribeUrl: unsubscribeUrl || undefined
      });
    } catch (err) {
      log.error && log.error(`overdue-digest send threw for user ${row.user_id}:`, err && err.message);
      summary.errors += 1;
      continue;
    }

    if (!result || result.ok !== true) {
      if (result && result.reason === 'not_configured') {
        summary.notConfigured += 1;
      } else {
        summary.errors += 1;
        log.warn && log.warn(`overdue-digest for user ${row.user_id} failed:`,
          (result && (result.reason || result.error)) || 'unknown');
      }
      continue;
    }

    try {
      await db.markOverdueDigestSent(row.user_id);
      summary.sent += 1;
    } catch (err) {
      log.error && log.error(`failed to stamp overdue_digest_sent_at for user ${row.user_id}:`, err && err.message);
      summary.errors += 1;
    }
  }

  return summary;
}

let _scheduledTask = null;

function startOverdueDigestJob(opts = {}) {
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
    console.error('node-cron not available; overdue-digest job disabled:', err && err.message);
    return { ok: false, reason: 'cron_unavailable' };
  }

  const schedule = opts.schedule || process.env.OVERDUE_DIGEST_CRON_SCHEDULE || DEFAULT_SCHEDULE;
  const log = opts.log || console;

  try {
    _scheduledTask = cron.schedule(schedule, async () => {
      try {
        const summary = await processOverdueDigest(opts);
        log.log && log.log(
          `[overdue-digest] found=${summary.found} sent=${summary.sent} skipped=${summary.skipped} `
          + `errors=${summary.errors} notConfigured=${summary.notConfigured}`
        );
      } catch (err) {
        log.error && log.error('overdue-digest cron tick failed:', err && err.message);
      }
    }, { timezone: 'UTC' });
  } catch (err) {
    console.error('failed to schedule overdue-digest cron:', err && err.message);
    return { ok: false, reason: 'schedule_failed', error: err && err.message };
  }

  return { ok: true, schedule };
}

function stopOverdueDigestJob() {
  if (_scheduledTask && typeof _scheduledTask.stop === 'function') {
    try { _scheduledTask.stop(); } catch (_) { /* ignore */ }
  }
  _scheduledTask = null;
}

module.exports = {
  processOverdueDigest,
  startOverdueDigestJob,
  stopOverdueDigestJob,
  buildOverdueDigestSubject,
  buildOverdueDigestHtml,
  buildOverdueDigestText,
  daysOverdue,
  DEFAULT_COOLDOWN_DAYS,
  DEFAULT_SCHEDULE,
  DIGEST_TTL_MINUTES,
  _internal: { escapeHtml, formatMoney, greetingName, resolveReplyTo, dashboardUrl }
};
