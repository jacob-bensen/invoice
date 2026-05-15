'use strict';

/*
 * First-paid celebration helper (#49).
 *
 * Both the manual mark-paid flow (routes/invoices.js POST /invoices/:id/status)
 * and the Stripe Payment Link webhook (routes/billing.js POST /billing/webhook
 * checkout.session.completed) must:
 *   1. Stamp users.first_paid_at the very first time the user has any paid
 *      invoice — idempotent so concurrent flips don't double-fire.
 *   2. Lazily generate the user's referral_code if they don't have one.
 *   3. Send the one-shot referral celebration email (fire-and-forget; a
 *      Resend outage must never block the redirect or webhook 200).
 *
 * The trigger returns the stamped row (so callers can log or test the
 * one-shot signal) or null when nothing was stamped (already-stamped users
 * or users without a paid invoice yet).
 */

const { sendReferralCelebrationEmail } = require('./email');

function buildReferralUrl(code) {
  if (!code) return '';
  const base = (process.env.APP_URL || '').replace(/\/+$/, '');
  const qs = `?ref=${encodeURIComponent(code)}`;
  return base ? `${base}/${qs}` : `/${qs}`;
}

/*
 * Idempotent one-shot. Calls db.recordFirstPaidIfMissing — when the UPDATE
 * actually took (i.e. user just crossed the first-paid threshold), we lazily
 * generate the referral code and fire the email. When the user was already
 * stamped (or has no paid invoice yet) we return null and do nothing.
 *
 * Email send is fire-and-forget; this function awaits only the SQL ops so
 * the calling redirect/webhook stays fast. Email failures are logged and
 * swallowed inside lib/email.js's not_configured / error branches.
 */
async function triggerFirstPaidCelebration(db, userId) {
  if (!db || !userId) return null;
  if (typeof db.recordFirstPaidIfMissing !== 'function') return null;
  let stamped;
  try {
    stamped = await db.recordFirstPaidIfMissing(userId);
  } catch (err) {
    console.error('First-paid stamp failed:', err && err.message);
    return null;
  }
  if (!stamped) return null;
  let code = stamped.referral_code;
  if (!code && typeof db.getOrCreateReferralCode === 'function') {
    try {
      code = await db.getOrCreateReferralCode(userId);
    } catch (err) {
      console.error('Referral code generation failed:', err && err.message);
    }
  }
  const referralUrl = buildReferralUrl(code);
  sendReferralCelebrationEmail(stamped, referralUrl)
    .then((r) => {
      if (!r.ok && r.reason !== 'not_configured') {
        console.warn(`Referral celebration email to ${stamped.email} failed:`, r.reason || r.error);
      }
    })
    .catch((e) => console.error('Referral celebration email error:', e && e.message));
  return { ...stamped, referral_code: code, referral_url: referralUrl };
}

module.exports = {
  triggerFirstPaidCelebration,
  buildReferralUrl
};
