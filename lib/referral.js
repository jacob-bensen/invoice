'use strict';

/*
 * Referral redemption helper (#50).
 *
 * Closes the loop on the first-paid celebration email's "share DecentInvoice,
 * both get a free Pro month" promise. The referred user's first Pro charge
 * already had `STRIPE_REFERRAL_COUPON_ID` applied at checkout-session
 * creation (see routes/billing.js POST /create-checkout); this helper runs
 * on the matching `checkout.session.completed` webhook to apply the same
 * coupon to the *referrer's* existing Stripe subscription — taking their
 * next billing cycle to $0 via the 100%-off / duration=once coupon
 * provisioned by the operator (MASTER_ACTIONS.md → Stripe configuration).
 *
 * Idempotency is owned by db.creditReferrerIfMissing — that UPDATE stamps
 * users.referral_credited_at exactly once per referred user. If Stripe
 * retries the webhook (up to 16 attempts over 3 days), the second call
 * returns null and this helper is a no-op.
 *
 * Failure modes are all soft. Missing coupon env, referrer without a
 * stripe_subscription_id, or a Stripe API throw never propagate — they
 * return a structured `{ applied: false, reason }` shape so the webhook
 * handler can keep returning 200 to Stripe.
 */

async function creditReferrerForSubscription(stripeClient, db, referredUserId) {
  if (!referredUserId) return null;
  if (!db || typeof db.creditReferrerIfMissing !== 'function') return null;

  let credited;
  try {
    credited = await db.creditReferrerIfMissing(referredUserId);
  } catch (err) {
    console.error('Referral credit DB error:', err && err.message);
    return null;
  }
  if (!credited) return null;

  const couponId = process.env.STRIPE_REFERRAL_COUPON_ID;
  if (!couponId) {
    return { ...credited, applied: false, reason: 'no_coupon_configured' };
  }
  if (!credited.referrer_subscription_id) {
    return { ...credited, applied: false, reason: 'referrer_no_subscription' };
  }
  if (!stripeClient || !stripeClient.subscriptions || typeof stripeClient.subscriptions.update !== 'function') {
    return { ...credited, applied: false, reason: 'no_stripe_client' };
  }

  try {
    await stripeClient.subscriptions.update(credited.referrer_subscription_id, {
      discounts: [{ coupon: couponId }]
    });
    return { ...credited, applied: true };
  } catch (err) {
    console.error('Referral coupon application error:', err && err.message);
    return { ...credited, applied: false, reason: 'stripe_error', error: err && err.message };
  }
}

module.exports = { creditReferrerForSubscription };
