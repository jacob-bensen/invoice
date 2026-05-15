'use strict';

/*
 * Welcome-email orchestrator. Wraps the idempotent `markWelcomeEmailSent`
 * DB stamp + the Resend send so callers (routes/auth.js POST /register) get
 * a single fire-and-forget call. The DB stamp lands first, mirroring the
 * first-paid celebration trigger (#49): if the email send fails after the
 * stamp lands the user is not re-sent on subsequent calls, which matches
 * the deliverability tradeoff — better to under-send than to spam.
 *
 * Soft-fails on every error path (missing db method, db throw, send throw,
 * Resend not configured) so account creation never breaks on a welcome-email
 * failure. Returns a structured { ok, reason } so tests can assert which
 * branch was taken without inspecting console output.
 */

const { sendWelcomeEmail } = require('./email');

async function triggerWelcomeEmail(db, userId) {
  if (!db || typeof db.markWelcomeEmailSent !== 'function') {
    return { ok: false, reason: 'db_unavailable' };
  }
  if (!userId) {
    return { ok: false, reason: 'no_user' };
  }
  let user;
  try {
    user = await db.markWelcomeEmailSent(userId);
  } catch (err) {
    return { ok: false, reason: 'db_error', error: err && err.message };
  }
  if (!user) {
    return { ok: false, reason: 'already_sent' };
  }
  try {
    const r = await sendWelcomeEmail(user);
    if (!r || !r.ok) {
      return { ok: false, reason: (r && r.reason) || 'send_failed', user };
    }
    return { ok: true, id: r.id, user };
  } catch (err) {
    return { ok: false, reason: 'send_error', error: err && err.message, user };
  }
}

module.exports = { triggerWelcomeEmail };
