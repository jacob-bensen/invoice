'use strict';

/*
 * First-sent celebration trigger (Milestone 3 — first invoice created → first
 * invoice sent).
 *
 * Idempotent fire-and-forget wrapper around:
 *   1. db.recordFirstSentIfMissing(userId) — race-safe single UPDATE that
 *      stamps users.first_sent_at the first time the user has any non-seed
 *      invoice in status IN ('sent','paid','overdue'). The WHERE guard +
 *      EXISTS subquery mean concurrent flips (manual mark-sent + share-intent
 *      click + client-view auto-flip arriving milliseconds apart on the same
 *      user's first invoice) collapse to exactly one RETURNING row.
 *   2. lib/magic-login.mintMagicLoginToken with a 7-day TTL — baked into the
 *      celebration email's primary CTA via ?next=/invoices/<id> so the
 *      freelancer clicks straight back into their just-sent invoice without
 *      bouncing at the login form.
 *   3. lib/email.sendFirstSentCelebrationEmail — fire-and-forget; a Resend
 *      outage must never block the calling status-flip redirect or webhook
 *      200 response.
 *
 * Safe to invoke from every send-flip site (POST /:id/status, POST
 * /:id/share-intent, POST /:id/email-client, POST /invoices/quick with
 * create_and_email, GET /i/<token> auto-flip). The SQL guard means only one
 * concurrent caller actually sends — the rest no-op silently with null
 * returned. Callers do NOT await the email send.
 *
 * Returns the stamped user row (plus magic-login URL) when the celebration
 * just fired, or null when the user was already stamped / has no non-seed
 * sent invoice yet. Callers may log the non-null return; they must not
 * branch on it for correctness (the email is fired internally either way).
 */

const { sendFirstSentCelebrationEmail } = require('./email');
const { mintMagicLoginToken } = require('./magic-login');

// 7 days — matches the welcome / stale-draft / no-invoice-nudge magic-login
// TTLs. The celebration email is transactional (fires within seconds of the
// activation event) but the recipient may not click for several days,
// especially over a weekend. A 7-day window is loose enough to still auto-
// sign-in then, tight enough that the token rotates well before any
// practical mailbox-leak horizon.
const FIRST_SENT_TTL_MINUTES = 7 * 24 * 60;

async function triggerFirstSentCelebration(db, userId, invoice) {
  if (!db || !userId) return null;
  if (typeof db.recordFirstSentIfMissing !== 'function') return null;
  if (!invoice || invoice.id == null) return null;

  let stamped;
  try {
    stamped = await db.recordFirstSentIfMissing(userId);
  } catch (err) {
    console.error('First-sent stamp failed:', err && err.message);
    return null;
  }
  if (!stamped) return null;

  // Best-effort magic-login mint. Any failure falls back to the plain
  // APP_URL path so the email is still actionable — the user just has to
  // authenticate manually first.
  let magicLoginUrl = '';
  try {
    const mint = await mintMagicLoginToken(db, userId, { ttlMinutes: FIRST_SENT_TTL_MINUTES });
    if (mint && mint.ok && mint.url) {
      magicLoginUrl = mint.url;
    } else if (mint && !mint.ok) {
      console.warn(`First-sent magic-link mint skipped for user ${userId}: ${mint.reason}`);
    }
  } catch (err) {
    // Defence-in-depth: mintMagicLoginToken catches internally, but a future
    // refactor that lets it throw must NEVER drop the celebration email.
    console.warn(`First-sent magic-link mint threw for user ${userId}:`, err && err.message);
  }

  const sendOpts = magicLoginUrl ? { magicLoginUrl } : undefined;
  sendFirstSentCelebrationEmail(stamped, invoice, sendOpts)
    .then((r) => {
      if (r && !r.ok && r.reason !== 'not_configured') {
        console.warn(`First-sent celebration email to ${stamped.email} failed:`, r.reason || r.error);
      }
    })
    .catch((e) => console.error('First-sent celebration email error:', e && e.message));

  return { ...stamped, magic_login_url: magicLoginUrl || null };
}

module.exports = {
  triggerFirstSentCelebration,
  FIRST_SENT_TTL_MINUTES
};
