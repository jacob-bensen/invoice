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
// 7 days. Used for tokens baked into one-shot triggered emails (welcome) that
// the recipient may not click for days. Tighter than a refresh-cookie horizon,
// loose enough that a user who reads the welcome email next weekend still
// auto-signs-in.
const WELCOME_TTL_MINUTES = 7 * 24 * 60;

// Strict allow-list of paths the /auth/magic/:token consume route is willing
// to redirect to. Anything not on this list (including absolute URLs,
// protocol-relative `//evil.com`, `javascript:`, paths with embedded CR/LF, or
// unknown app routes) falls back to /dashboard. Kept deliberately small —
// every entry must be a logged-in landing page that a freshly-signed-in user
// can sensibly arrive at from an email CTA.
const NEXT_ALLOW_LIST = new Set([
  '/dashboard',
  '/invoices',
  '/invoices/new',
  '/invoices/quick',
  '/billing/upgrade',
  '/settings'
]);

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

/*
 * Mint a fresh magic-login token for a known user id without sending an
 * email. Used by triggered emails that bake the auto-sign-in URL into their
 * own CTA (welcome email — Milestone 1). The caller knows the user already,
 * so this skips the enumeration-resistance dance that requestMagicLink does
 * around lookup-by-email.
 *
 * Soft-fails on every error path so the caller (e.g. welcome flow) can
 * gracefully fall back to a plain non-magic URL if minting blows up — never
 * blocks the email send.
 *
 * Returns { ok, url, token, expires_at } on success; { ok:false, reason } on
 * any soft failure. The TTL defaults to DEFAULT_TTL_MINUTES (30); pass
 * opts.ttlMinutes to override (e.g. WELCOME_TTL_MINUTES for welcome use).
 */
async function mintMagicLoginToken(db, userId, opts = {}) {
  if (!db || typeof db.createPasswordResetToken !== 'function') {
    return { ok: false, reason: 'db_unavailable' };
  }
  if (!userId) {
    return { ok: false, reason: 'no_user' };
  }
  const ttlMinutes = Number.isFinite(opts.ttlMinutes) && opts.ttlMinutes > 0
    ? Math.floor(opts.ttlMinutes)
    : DEFAULT_TTL_MINUTES;
  const token = generateToken();
  const tokenHash = hashToken(token);
  let row;
  try {
    row = await db.createPasswordResetToken(userId, tokenHash, ttlMinutes, 'login');
  } catch (err) {
    console.error('mintMagicLoginToken persist failed:', err && err.message);
    return { ok: false, reason: 'db_error', error: err && err.message };
  }
  if (!row) {
    return { ok: false, reason: 'persist_failed' };
  }
  return {
    ok: true,
    token,
    url: buildMagicLoginUrl(token),
    expires_at: row.expires_at,
    ttlMinutes
  };
}

/*
 * Validate a post-consume redirect target ("?next=") against the strict
 * NEXT_ALLOW_LIST. Returns the path itself when safe, or null otherwise.
 *
 * Defence-in-depth: the route must NOT pass `next` directly through to
 * res.redirect() without this filter, or an attacker can craft a welcome-email
 * URL like `/auth/magic/<valid-token>?next=https://evil.com/login` and ride
 * the user's just-consumed session straight off-site. The allow-list also
 * stops control characters (CR/LF for response splitting) reaching the
 * Location header — anything outside the list is rejected wholesale.
 */
function safeNextPath(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Reject any control chars (\r, \n, \t, NUL etc.) before allow-list check.
  if (/[\x00-\x1f\x7f]/.test(trimmed)) return null;
  // Reject protocol-relative URLs (//evil.com) and absolute URLs (anything
  // with a scheme like https: or javascript:). Allow-list also enforces this
  // but the explicit check makes the intent obvious to a reader.
  if (trimmed.startsWith('//')) return null;
  if (!trimmed.startsWith('/')) return null;
  return NEXT_ALLOW_LIST.has(trimmed) ? trimmed : null;
}

module.exports = {
  requestMagicLink,
  mintMagicLoginToken,
  generateToken,
  hashToken,
  buildMagicLoginUrl,
  safeNextPath,
  DEFAULT_TTL_MINUTES,
  WELCOME_TTL_MINUTES,
  NEXT_ALLOW_LIST
};
