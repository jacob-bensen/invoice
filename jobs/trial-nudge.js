'use strict';

/*
 * Trial End Day-3 Nudge Email (INTERNAL_TODO #29).
 *
 * Fires once per trial, on day 3-5 of the user's 7-day Pro trial. Industry
 * benchmarks: a single well-timed trial nudge moves trial-to-paid conversion
 * by 30-50%. Without it, users who signed up but never returned to add a card
 * silently lapse on day 7.
 *
 * Design mirrors jobs/reminders.js (#16):
 *   - `processTrialNudges({ db, sendEmail, now, log })` is the pure
 *     orchestrator. Dependency-injected, no module state, no cron reference.
 *     Returns { found, sent, skipped, errors, notConfigured } so tests can
 *     assert against the structured summary directly.
 *   - `startTrialNudgeJob(opts)` schedules the orchestrator with node-cron.
 *     A failure to require('node-cron') logs and swallows: a broken cron
 *     must never crash the web process.
 *   - When `RESEND_API_KEY` is unset, `lib/email.sendEmail` returns
 *     { ok:false, reason:'not_configured' }. We treat that as a clean skip
 *     (no DB stamp, the next pass retries) so the job is a safe no-op
 *     until Master provisions the key. See TODO_MASTER #18.
 *   - Idempotency is enforced at the SQL layer: `trial_nudge_sent_at IS NULL`
 *     means each user receives at most one nudge per trial.
 */

const { db: realDb } = require('../db');
const { sendEmail: realSendEmail } = require('../lib/email');

const DEFAULT_SCHEDULE = '0 10 * * *'; // 10:00 UTC daily

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function daysLeft(trialEndsAt, now = new Date()) {
  if (!trialEndsAt) return 0;
  const end = new Date(trialEndsAt).getTime();
  if (!Number.isFinite(end)) return 0;
  const diff = end - now.getTime();
  return Math.max(0, Math.ceil(diff / 86400000));
}

function ctaUrl() {
  const base = (process.env.APP_URL || '').replace(/\/+$/, '');
  return base ? `${base}/dashboard` : '';
}

function greetingName(user) {
  return user.name || user.business_name || 'there';
}

function buildTrialNudgeSubject(user, now = new Date()) {
  const days = daysLeft(user.trial_ends_at, now);
  const word = days === 1 ? 'day' : 'days';
  return `Your Pro trial ends in ${days} ${word} — don't lose your data`;
}

function buildTrialNudgeHtml(user, now = new Date()) {
  const days = daysLeft(user.trial_ends_at, now);
  const word = days === 1 ? 'day' : 'days';
  const greeting = greetingName(user);
  const invoiceCount = Number(user.invoice_count) || 0;
  const url = ctaUrl();
  const ctaButton = url
    ? `<p style="margin:24px 0;"><a href="${escapeHtml(url)}" style="background:#4f46e5;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px;display:inline-block;">Keep Pro → Add payment method</a></p>`
    : '';
  const invoiceLine = invoiceCount > 0
    ? `, and you've already created <strong>${invoiceCount} invoice${invoiceCount === 1 ? '' : 's'}</strong>`
    : '';

  return `<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#222;background:#f7f7f9;margin:0;padding:24px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #eaeaea;">
  <tr><td style="padding:24px 28px;">
    <h2 style="margin:0 0 8px 0;color:#111;">Your Pro trial ends in ${days} ${word}</h2>
    <p style="color:#222;margin:8px 0;font-size:16px;">Hi ${escapeHtml(greeting)},</p>
    <p style="color:#222;margin:8px 0;font-size:16px;">You're ${days} ${word} away from the end of your free Pro trial${invoiceLine}. Add a payment method now and keep:</p>
    <ul style="color:#222;margin:12px 0 16px 20px;font-size:15px;line-height:1.6;">
      <li>Stripe Payment Links on every invoice — clients pay in one click</li>
      <li>Automated overdue reminders so you don't have to chase late payers</li>
      <li>Custom branding (logo, business name, reply-to email)</li>
      <li>Instant "you got paid" notifications the moment a client checks out</li>
    </ul>
    <p style="color:#444;margin:8px 0;font-size:15px;">If you don't add a card, your account will revert to the Free plan when the trial ends — your invoices stay, but Pro features turn off.</p>
    ${ctaButton}
    <p style="color:#999;font-size:12px;margin-top:24px;">Sent automatically by DecentInvoice. Reply to this email if you have any questions.</p>
  </td></tr>
</table>
</body></html>`;
}

function buildTrialNudgeText(user, now = new Date()) {
  const days = daysLeft(user.trial_ends_at, now);
  const word = days === 1 ? 'day' : 'days';
  const greeting = greetingName(user);
  const invoiceCount = Number(user.invoice_count) || 0;
  const url = ctaUrl();
  const lines = [
    `Hi ${greeting},`,
    '',
    `Your Pro trial ends in ${days} ${word}.${invoiceCount > 0 ? ` You've created ${invoiceCount} invoice${invoiceCount === 1 ? '' : 's'} so far.` : ''}`,
    '',
    'Add a payment method now and keep:',
    '  - Stripe Payment Links on every invoice',
    '  - Automated overdue reminders',
    '  - Custom branding (logo, business name, reply-to email)',
    '  - Instant "you got paid" notifications',
    '',
    'If you don\'t add a card, your account will revert to Free when the trial ends.'
  ];
  if (url) {
    lines.push('', `Add payment method: ${url}`);
  }
  return lines.join('\n');
}

async function processTrialNudges(opts = {}) {
  const db = opts.db || realDb;
  const sendEmail = opts.sendEmail || realSendEmail;
  const now = opts.now || new Date();
  const log = opts.log || console;

  const summary = { found: 0, sent: 0, skipped: 0, errors: 0, notConfigured: 0 };

  let users;
  try {
    users = await db.getTrialUsersNeedingNudge();
  } catch (err) {
    log.error && log.error('trial-nudge query failed:', err && err.message);
    summary.errors += 1;
    return summary;
  }
  users = users || [];
  summary.found = users.length;

  for (const user of users) {
    if (!user.email) {
      summary.skipped += 1;
      continue;
    }

    let result;
    try {
      result = await sendEmail({
        to: user.email,
        subject: buildTrialNudgeSubject(user, now),
        html: buildTrialNudgeHtml(user, now),
        text: buildTrialNudgeText(user, now)
      });
    } catch (err) {
      log.error && log.error(`trial nudge send threw for user ${user.id}:`, err && err.message);
      summary.errors += 1;
      continue;
    }

    if (!result || result.ok !== true) {
      if (result && result.reason === 'not_configured') {
        summary.notConfigured += 1;
      } else {
        summary.errors += 1;
        log.warn && log.warn(`trial nudge for user ${user.id} failed:`,
          (result && (result.reason || result.error)) || 'unknown');
      }
      continue;
    }

    try {
      await db.markTrialNudgeSent(user.id);
      summary.sent += 1;
    } catch (err) {
      log.error && log.error(`failed to stamp trial_nudge_sent_at for user ${user.id}:`, err && err.message);
      summary.errors += 1;
    }
  }

  return summary;
}

let _scheduledTask = null;

function startTrialNudgeJob(opts = {}) {
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
    console.error('node-cron not available; trial-nudge job disabled:', err && err.message);
    return { ok: false, reason: 'cron_unavailable' };
  }

  const schedule = opts.schedule || process.env.TRIAL_NUDGE_CRON_SCHEDULE || DEFAULT_SCHEDULE;
  const log = opts.log || console;

  try {
    _scheduledTask = cron.schedule(schedule, async () => {
      try {
        const summary = await processTrialNudges(opts);
        log.log && log.log(
          `[trial-nudge] found=${summary.found} sent=${summary.sent} skipped=${summary.skipped} `
          + `errors=${summary.errors} notConfigured=${summary.notConfigured}`
        );
      } catch (err) {
        log.error && log.error('trial-nudge cron tick failed:', err && err.message);
      }
    }, { timezone: 'UTC' });
  } catch (err) {
    console.error('failed to schedule trial-nudge cron:', err && err.message);
    return { ok: false, reason: 'schedule_failed', error: err && err.message };
  }

  return { ok: true, schedule };
}

function stopTrialNudgeJob() {
  if (_scheduledTask && typeof _scheduledTask.stop === 'function') {
    try { _scheduledTask.stop(); } catch (_) { /* ignore */ }
  }
  _scheduledTask = null;
}

module.exports = {
  processTrialNudges,
  startTrialNudgeJob,
  stopTrialNudgeJob,
  buildTrialNudgeSubject,
  buildTrialNudgeHtml,
  buildTrialNudgeText,
  daysLeft,
  DEFAULT_SCHEDULE,
  _internal: { escapeHtml, ctaUrl, greetingName }
};
