'use strict';

/*
 * Welcome-email orchestrator. Wraps the idempotent `markWelcomeEmailSent`
 * DB stamp + the Resend send so callers (routes/auth.js POST /register) get
 * a single fire-and-forget call. The DB stamp lands first, mirroring the
 * first-paid celebration trigger (#49): if the email send fails after the
 * stamp lands the user is not re-sent on subsequent calls, which matches
 * the deliverability tradeoff — better to under-send than to spam.
 *
 * Magic-login bake-in (Milestone 1 — signup → first dashboard re-entry):
 * after the idempotency stamp lands the orchestrator mints a 7-day magic-
 * login token (via lib/magic-login.mintMagicLoginToken) and passes the URL
 * into sendWelcomeEmail as `opts.magicLoginUrl`. The email's "Create your
 * first invoice →" and "Start your free Pro trial" CTAs then carry the
 * auto-sign-in URL with `?next=/invoices/new` / `?next=/billing/upgrade`,
 * so a user who clicks the welcome email hours or days later lands
 * already-authenticated on the target page instead of bouncing at the
 * login form.
 *
 * Mint failures (db_unavailable / persist_failed / db_error) soft-fail —
 * the welcome email still ships with the plain APP_URL paths as the CTA
 * targets. We never sacrifice a welcome send to a token-mint hiccup.
 *
 * Soft-fails on every error path (missing db method, db throw, send throw,
 * Resend not configured) so account creation never breaks on a welcome-email
 * failure. Returns a structured { ok, reason } so tests can assert which
 * branch was taken without inspecting console output.
 */

const { sendWelcomeEmail } = require('./email');
const { mintMagicLoginToken, WELCOME_TTL_MINUTES } = require('./magic-login');
const { resolveUnsubscribeUrlForRow } = require('./unsubscribe');

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
  // Best-effort: mint a 7-day magic-login URL so the CTA buttons in the
  // welcome email auto-sign-in. Any failure falls back to the plain links.
  let magicLoginUrl = '';
  try {
    const mint = await mintMagicLoginToken(db, user.id, { ttlMinutes: WELCOME_TTL_MINUTES });
    if (mint && mint.ok && mint.url) {
      magicLoginUrl = mint.url;
    } else if (mint && !mint.ok) {
      console.warn(`Welcome magic-link mint skipped for user ${user.id}: ${mint.reason}`);
    }
  } catch (err) {
    // Defence-in-depth: mintMagicLoginToken already catches internally, but
    // a future refactor that lets it throw must NEVER take down the welcome
    // email send. Log and proceed with the plain CTA URLs.
    console.warn('Welcome magic-link mint threw, falling back to plain CTAs:', err && err.message);
  }
  // Best-effort: resolve the user's unsubscribe URL so the welcome email
  // carries a visible footer link + RFC 8058 List-Unsubscribe header. A
  // mint hiccup falls back to a footer-less send (still legally fine —
  // welcome is also the first opt-in event — but we always try).
  const unsubscribeUrl = await resolveUnsubscribeUrlForRow(db, user);
  try {
    const sendOpts = {};
    if (magicLoginUrl) sendOpts.magicLoginUrl = magicLoginUrl;
    if (unsubscribeUrl) sendOpts.unsubscribeUrl = unsubscribeUrl;
    const r = await sendWelcomeEmail(user, Object.keys(sendOpts).length ? sendOpts : undefined);
    if (!r || !r.ok) {
      return { ok: false, reason: (r && r.reason) || 'send_failed', user };
    }
    return {
      ok: true,
      id: r.id,
      user,
      magicLoginUrl: magicLoginUrl || null,
      unsubscribeUrl: unsubscribeUrl || null
    };
  } catch (err) {
    return { ok: false, reason: 'send_error', error: err && err.message, user };
  }
}

module.exports = { triggerWelcomeEmail };
