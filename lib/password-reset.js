'use strict';

/*
 * Password-reset / magic-link sign-in orchestrator (Milestone 1 of the
 * activation funnel — signup → first dashboard re-entry).
 *
 * The login page's old "email support@... to reset" hint was a dead end —
 * any user who lost their session bounced for good, taking every downstream
 * conversion surface (trial-urgency stack, exit-intent, celebration banner,
 * referral loop, locked-feature upsells) with them. This module is the
 * self-serve recovery path that closes that hole.
 *
 * Security posture:
 *   - The raw token is 32 random bytes (hex-encoded, 64 chars).
 *   - Only the SHA-256 hash is persisted in `password_resets.token_hash`;
 *     a database leak does NOT yield active reset links.
 *   - One-shot: `consumed_at` is stamped atomically with the password
 *     rotation inside a single SQL round-trip (`consumePasswordResetAndSetPassword`).
 *   - Time-boxed: default TTL is 60 minutes.
 *   - No email-enumeration: `requestPasswordReset` returns ok:true for any
 *     input shape (existing/unknown email, db error, send error) so callers
 *     can render a single generic success message. Diagnostic detail is
 *     surfaced in the optional `reason` field for tests/logging only.
 *
 * Resend graceful-degradation: when RESEND_API_KEY is unset, sendEmail
 * returns reason='not_configured' and this orchestrator surfaces it as
 * ok:true reason:'not_configured' — the user-facing flow still renders
 * the generic success message (operator action tracked in MASTER_ACTIONS).
 */

const crypto = require('crypto');
const { sendPasswordResetEmail } = require('./email');

const DEFAULT_TTL_MINUTES = 60;

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

function buildResetUrl(token) {
  if (!token) return '';
  const base = (process.env.APP_URL || '').replace(/\/+$/, '');
  // Relative fallback works in dev — webmail opens the link against whatever
  // host the user happens to be on. The absolute form is preferred in prod
  // so a forwarded email still resolves correctly.
  const path = `/auth/reset/${encodeURIComponent(token)}`;
  return base ? `${base}${path}` : path;
}

/*
 * POST /auth/forgot handler entry. Looks up the user, generates a token,
 * persists the hash, and fires the email. Always resolves with ok:true
 * (the route renders the same generic success page regardless) so the
 * surface gives no signal about whether an account exists for that email.
 *
 * The send is awaited so a Resend rejection is captured into the result
 * object for logging/tests; the user-visible response is unaffected either
 * way.
 */
async function requestPasswordReset(db, rawEmail, opts = {}) {
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
    console.error('Password reset lookup failed:', err && err.message);
    return { ok: true, reason: 'db_error', error: err && err.message };
  }
  if (!user) {
    return { ok: true, reason: 'unknown_email' };
  }
  const token = generateToken();
  const tokenHash = hashToken(token);
  try {
    await db.createPasswordResetToken(user.id, tokenHash, ttlMinutes);
  } catch (err) {
    console.error('Password reset token persist failed:', err && err.message);
    return { ok: true, reason: 'db_error', error: err && err.message };
  }
  const resetUrl = buildResetUrl(token);
  let sendResult;
  try {
    sendResult = await sendPasswordResetEmail(user, resetUrl, ttlMinutes);
  } catch (err) {
    console.error('Password reset email send threw:', err && err.message);
    return { ok: true, reason: 'send_error', error: err && err.message };
  }
  if (!sendResult || !sendResult.ok) {
    return { ok: true, reason: (sendResult && sendResult.reason) || 'send_failed' };
  }
  return { ok: true, sent: true, id: sendResult.id };
}

module.exports = {
  requestPasswordReset,
  generateToken,
  hashToken,
  buildResetUrl,
  DEFAULT_TTL_MINUTES
};
