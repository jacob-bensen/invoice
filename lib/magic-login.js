'use strict';

/*
 * Magic-link sign-in orchestrator (Milestone 1 of the activation funnel —
 * signup → first dashboard re-entry).
 *
 * The password-reset path (lib/password-reset.js) already gives users a way
 * back in, but forces them to choose a new password on the same hop. For
 * users who haven't forgotten their password and just want one-tap re-entry
 * (mobile users especially), the friction of "pick a new password" is real
 * and turns the "I'll come back to this later" cohort into a permanent
 * bounce. This module is the password-less counterpart: same token-hash
 * pattern, same TTL bounds, same enumeration-resistant POST response, but
 * the consume path is a no-rotation atomic UPDATE that signs the user in
 * and redirects to /dashboard.
 *
 * Security posture (parity with password-reset.js):
 *   - Raw token is 32 random bytes (hex-encoded, 64 chars).
 *   - Only the SHA-256 hash is persisted in password_resets.token_hash
 *     with kind='login'; a database leak does NOT yield active links.
 *   - One-shot: consumed_at is stamped atomically inside
 *     consumeMagicLoginToken — concurrent double-click consumes once.
 *   - Time-boxed: default TTL is 30 minutes (tighter than password-reset's
 *     60 — a magic-link is a hot-path live re-entry, not a cold reset).
 *   - No email-enumeration: requestMagicLink returns ok:true for any input
 *     shape so callers can render a single generic success message.
 *   - Kind isolation: magic-login tokens are stored with kind='login' and
 *     the consume path filters on kind='login'; a leaked password-reset
 *     hash cannot be replayed against the magic-login route (or vice
 *     versa). This is defence-in-depth — the routes are URL-distinct, but
 *     the kind filter blocks a future code path that misroutes a hash.
 *
 * Resend graceful-degradation: when RESEND_API_KEY is unset, sendEmail
 * returns reason='not_configured' and this orchestrator surfaces it as
 * ok:true reason:'not_configured' — the user-facing flow still renders
 * the generic success page (operator action tracked in MASTER_ACTIONS).
 */

const crypto = require('crypto');
const { sendMagicLoginEmail } = require('./email');

const DEFAULT_TTL_MINUTES = 30;

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

function buildMagicLoginUrl(token) {
  if (!token) return '';
  const base = (process.env.APP_URL || '').replace(/\/+$/, '');
  const path = `/auth/magic/${encodeURIComponent(token)}`;
  return base ? `${base}${path}` : path;
}

/*
 * POST /auth/magic handler entry. Looks up the user, generates a token,
 * persists the hash with kind='login', and fires the email. Always resolves
 * with ok:true (the route renders the same generic success regardless) so
 * the surface gives no signal about whether an account exists for that
 * email.
 *
 * The send is awaited so a Resend rejection is captured into the result
 * object for logging/tests; the user-visible response is unaffected.
 */
async function requestMagicLink(db, rawEmail, opts = {}) {
  const ttlMinutes = Number.isFinite(opts.ttlMinutes) && opts.ttlMinutes > 0
    ? Math.floor(opts.ttlMinutes)
    : DEFAULT_TTL_MINUTES;
  const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
  if (!email) {
    return { ok: true, reason: 'no_email' };
  }
  if (!db || typeof db.getUserByEmail !== 'function'
      || typeof db.createPasswordResetToken !== 'function') {
    return { ok: true, reason: 'db_unavailable' };
  }
  let user;
  try {
    user = await db.getUserByEmail(email);
  } catch (err) {
    console.error('Magic-link lookup failed:', err && err.message);
    return { ok: true, reason: 'db_error', error: err && err.message };
  }
  if (!user) {
    return { ok: true, reason: 'unknown_email' };
  }
  const token = generateToken();
  const tokenHash = hashToken(token);
  try {
    await db.createPasswordResetToken(user.id, tokenHash, ttlMinutes, 'login');
  } catch (err) {
    console.error('Magic-link token persist failed:', err && err.message);
    return { ok: true, reason: 'db_error', error: err && err.message };
  }
  const loginUrl = buildMagicLoginUrl(token);
  let sendResult;
  try {
    sendResult = await sendMagicLoginEmail(user, loginUrl, ttlMinutes);
  } catch (err) {
    console.error('Magic-link email send threw:', err && err.message);
    return { ok: true, reason: 'send_error', error: err && err.message };
  }
  if (!sendResult || !sendResult.ok) {
    return { ok: true, reason: (sendResult && sendResult.reason) || 'send_failed' };
  }
  return { ok: true, sent: true, id: sendResult.id };
}

module.exports = {
  requestMagicLink,
  generateToken,
  hashToken,
  buildMagicLoginUrl,
  DEFAULT_TTL_MINUTES
};
