const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { db, pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { isValidWebhookUrl, firePaidWebhook, buildPaidPayload } = require('../lib/outbound-webhook');
const { sendPaidNotificationEmail } = require('../lib/email');
const { getCompetitorPricing } = require('../lib/competitor-pricing');
const { triggerFirstPaidCelebration } = require('../lib/celebration');
const { creditReferrerForSubscription } = require('../lib/referral');

const router = express.Router();

router.get('/upgrade', requireAuth, (req, res) => {
  const flash = req.session.flash;
  delete req.session.flash;
  res.render('pricing', {
    title: 'Upgrade to Pro',
    flash,
    competitorPricing: getCompetitorPricing(),
    ogTitle: 'DecentInvoice Pro — Unlimited invoices, payment links, $12/mo',
    ogDescription: 'Upgrade to Pro for unlimited invoices, Stripe payment links, automated reminders, and custom branding. 7-day free trial, no credit card.',
    ogPath: '/billing/upgrade'
  });
});

function resolvePriceId(billingCycle) {
  const cycle = billingCycle === 'annual' ? 'annual' : 'monthly';
  if (cycle === 'annual') {
    // Fall back to monthly price if annual is not configured yet, so the
    // checkout flow never breaks for users who select annual before Master
    // has created the Stripe price.
    return {
      cycle,
      priceId: process.env.STRIPE_PRO_ANNUAL_PRICE_ID || process.env.STRIPE_PRO_PRICE_ID
    };
  }
  return { cycle, priceId: process.env.STRIPE_PRO_PRICE_ID };
}

router.post('/create-checkout', requireAuth, async (req, res) => {
  try {
    const user = await db.getUserById(req.session.user.id);
    if (!user) return res.redirect('/auth/login');
    let customerId = user.stripe_customer_id;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: user.name || user.email,
        metadata: { user_id: String(user.id) }
      });
      customerId = customer.id;
      await db.updateUser(user.id, { stripe_customer_id: customerId });
    }

    const { cycle, priceId } = resolvePriceId(req.body && req.body.billing_cycle);

    // Stripe Tax is opt-in: until Master flips STRIPE_AUTOMATIC_TAX_ENABLED in
    // production env (after activating Stripe Tax in the Dashboard), the call
    // ships with automatic_tax.enabled=false so checkout never breaks. The env
    // gate makes the deploy safe + reversible.
    const automaticTaxEnabled = process.env.STRIPE_AUTOMATIC_TAX_ENABLED === 'true';

    // Referral redemption (#50): if this user arrived via a ?ref=<code>
    // link, attach the operator-provisioned coupon so their first Pro
    // charge after the trial is 100% off. Stripe disallows
    // allow_promotion_codes alongside discounts on the same session, so we
    // surface the promo-code link only when no auto-coupon is being
    // applied — referred users trade promo-code stacking for guaranteed
    // free-month redemption.
    const attachReferralCoupon = Boolean(
      user.referrer_id && process.env.STRIPE_REFERRAL_COUPON_ID
    );

    const metadata = { billing_cycle: cycle, user_id: String(user.id) };
    if (user.referrer_id) metadata.referrer_id = String(user.referrer_id);

    const sessionParams = {
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{
        price: priceId,
        quantity: 1
      }],
      mode: 'subscription',
      // 7-day no-card-required Pro trial. Stripe auto-cancels via
      // customer.subscription.deleted if no payment method is added by day 8.
      subscription_data: { trial_period_days: 7 },
      // Surface a "Add promotion code" link on the Stripe Checkout page so
      // every coupon Master creates (Product Hunt PH50, AppSumo, newsletter
      // sponsorships, Agency cold-email 100%-off-first-month) is reachable.
      // Excluded when a referral coupon is auto-attached — see above.
      allow_promotion_codes: !attachReferralCoupon,
      automatic_tax: { enabled: automaticTaxEnabled },
      metadata,
      success_url: `${process.env.APP_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.APP_URL}/billing/upgrade`
    };

    if (attachReferralCoupon) {
      sessionParams.discounts = [{ coupon: process.env.STRIPE_REFERRAL_COUPON_ID }];
    }

    // Stripe Tax requires a billing address for jurisdiction lookup. Auto-
    // capture address and name onto the customer record so subsequent
    // invoices and tax calculations stay consistent.
    if (automaticTaxEnabled) {
      sessionParams.customer_update = { address: 'auto', name: 'auto' };
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    res.redirect(303, session.url);
  } catch (err) {
    console.error('Stripe checkout error:', err);
    req.session.flash = { type: 'error', message: 'Could not start checkout. Please try again.' };
    res.redirect('/billing/upgrade');
  }
});

router.get('/success', requireAuth, async (req, res) => {
  req.session.flash = { type: 'success', message: 'Welcome to Pro! Unlimited invoices are now unlocked.' };
  const user = await db.getUserById(req.session.user.id);
  if (!user) return res.redirect('/auth/login');
  req.session.user = { ...req.session.user, plan: user.plan };
  res.redirect('/dashboard');
});

router.post('/switch-to-annual', requireAuth, async (req, res) => {
  try {
    const user = await db.getUserById(req.session.user.id);
    if (!user) return res.redirect('/auth/login');
    if (user.plan !== 'pro' || !user.stripe_subscription_id) {
      req.session.flash = { type: 'error', message: 'Only paying Pro subscribers can switch to annual.' };
      return res.redirect('/invoices');
    }
    if (user.billing_cycle === 'annual') {
      req.session.flash = { type: 'success', message: 'You\'re already on annual billing.' };
      return res.redirect('/invoices');
    }
    const annualPriceId = process.env.STRIPE_PRO_ANNUAL_PRICE_ID;
    if (!annualPriceId) {
      // Annual price not yet configured in Stripe — graceful fallback so the
      // CTA never produces an opaque 500. Operator action lives in
      // MASTER_ACTIONS.md ("Create annual Pro price").
      req.session.flash = { type: 'error', message: 'Annual billing is not available yet — please contact support.' };
      return res.redirect('/invoices');
    }
    const sub = await stripe.subscriptions.retrieve(user.stripe_subscription_id);
    const itemId = sub && sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].id;
    if (!itemId) {
      req.session.flash = { type: 'error', message: 'Could not locate your subscription. Please try again from the customer portal.' };
      return res.redirect('/invoices');
    }
    await stripe.subscriptions.update(user.stripe_subscription_id, {
      items: [{ id: itemId, price: annualPriceId }],
      proration_behavior: 'create_prorations'
    });
    await db.updateUser(user.id, { billing_cycle: 'annual' });
    req.session.flash = { type: 'success', message: 'Switched to annual billing — you\'ll save $45/year. Prorated credit applied.' };
    res.redirect('/invoices');
  } catch (err) {
    console.error('Switch to annual error:', err && err.message);
    req.session.flash = { type: 'error', message: 'Could not switch to annual billing. Please try again.' };
    res.redirect('/invoices');
  }
});

// #145 — Conversion-intelligence capture from the upgrade-modal "What's
// missing?" widget. Whitelists reason + source so a hostile client cannot
// pollute the table with arbitrary buckets; trims/caps message length on
// the way in (db.recordFeedbackSignal also caps at 1000 as defence-in-
// depth). Returns 200 JSON on success — the widget flips to a thanks
// state. Anonymous submissions (logged-out user on /billing/upgrade) are
// allowed; user_id stores null.
const FEEDBACK_REASONS = new Set([
  'too_expensive',
  'missing_feature',
  'not_ready',
  'still_evaluating',
  'other'
]);
const FEEDBACK_SOURCES = new Set(['upgrade-modal', 'pricing-page']);
const FEEDBACK_CYCLES = new Set(['monthly', 'annual']);

router.post('/feedback', async (req, res) => {
  try {
    const body = req.body || {};
    const source = typeof body.source === 'string' && FEEDBACK_SOURCES.has(body.source)
      ? body.source
      : 'upgrade-modal';
    const reason = typeof body.reason === 'string' && FEEDBACK_REASONS.has(body.reason)
      ? body.reason
      : null;
    const cycle = typeof body.cycle === 'string' && FEEDBACK_CYCLES.has(body.cycle)
      ? body.cycle
      : null;
    const message = typeof body.message === 'string' ? body.message : null;
    if (!reason && (!message || !message.trim())) {
      return res.status(400).json({ ok: false, error: 'missing_reason_or_message' });
    }
    const userId = req.session && req.session.user ? req.session.user.id : null;
    const row = await db.recordFeedbackSignal({
      user_id: userId,
      source,
      reason,
      message,
      cycle
    });
    res.json({ ok: true, id: row && row.id });
  } catch (err) {
    console.error('Feedback signal error:', err && err.message);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

router.post('/portal', requireAuth, async (req, res) => {
  try {
    const user = await db.getUserById(req.session.user.id);
    if (!user) return res.redirect('/auth/login');
    if (!user.stripe_customer_id) return res.redirect('/billing/upgrade');

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: `${process.env.APP_URL}/dashboard`
    });
    res.redirect(303, portalSession.url);
  } catch (err) {
    console.error('Portal error:', err);
    res.redirect('/dashboard');
  }
});

// Stripe webhook — must use raw body
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.mode === 'subscription') {
          const customer = await stripe.customers.retrieve(session.customer);
          const userId = customer.metadata.user_id;
          if (userId) {
            // If the subscription started in a trial (no card required)
            // capture trial_ends_at so the dashboard can show the countdown
            // banner. Stripe gives us trial_end as Unix-seconds when present.
            const updates = {
              plan: 'pro',
              stripe_subscription_id: session.subscription
            };
            const metaCycle = session.metadata && session.metadata.billing_cycle;
            if (metaCycle === 'monthly' || metaCycle === 'annual') {
              updates.billing_cycle = metaCycle;
            }
            try {
              const sub = await stripe.subscriptions.retrieve(session.subscription);
              if (sub && sub.trial_end) {
                updates.trial_ends_at = new Date(sub.trial_end * 1000);
              } else {
                // Paid signup (no trial) — clear any prior trial countdown.
                updates.trial_ends_at = null;
              }
            } catch (e) {
              console.warn('Could not fetch subscription for trial_end:', e && e.message);
            }
            await db.updateUser(parseInt(userId, 10), updates);
            // Referral redemption (#50). Idempotent one-shot — the
            // `referral_credited_at` guard inside db.creditReferrerIfMissing
            // ensures Stripe webhook retries never grant the referrer more
            // than one free month per referred user. Errors are swallowed
            // (logged inside the helper) so a Stripe API hiccup never
            // blocks the 200-OK we owe Stripe.
            creditReferrerForSubscription(stripe, db, parseInt(userId, 10))
              .catch(e => console.error('Referral credit error:', e && e.message));
          }
        } else if (session.mode === 'payment' && session.payment_link) {
          // Invoice Payment Link was paid — mark the invoice as paid.
          const updated = await db.markInvoicePaidByPaymentLinkId(session.payment_link);
          if (!updated) {
            console.warn(`No invoice found for payment_link ${session.payment_link}`);
          } else {
            const owner = await db.getUserById(updated.user_id);
            // Fire the outbound Zapier-style webhook for Pro/Agency users.
            if (owner && (owner.plan === 'pro' || owner.plan === 'agency') && owner.webhook_url) {
              firePaidWebhook(owner.webhook_url, buildPaidPayload(updated))
                .then(r => { if (!r.ok) console.warn(`webhook ${owner.webhook_url} failed:`, r.reason || r.status); })
                .catch(e => console.error('Outbound webhook error:', e && e.message));
            }
            // The "cha-ching" moment — email the freelancer the instant the
            // client's payment cleared. Fire-and-forget so a Resend outage
            // never blocks the webhook 200 response. `not_configured` is a
            // safe no-op until the Resend API key is provisioned.
            if (owner && owner.email) {
              sendPaidNotificationEmail(updated, owner)
                .then(r => {
                  if (!r.ok && r.reason !== 'not_configured') {
                    console.warn(`Paid notification to ${owner.email} failed:`, r.reason || r.error);
                  }
                })
                .catch(e => console.error('Paid notification error:', e && e.message));
            }
            // First-paid celebration (#49). Same idempotent one-shot the
            // manual mark-paid flow uses — fires the referral email exactly
            // once on the user's very first paid invoice.
            if (owner) {
              triggerFirstPaidCelebration(db, owner.id)
                .catch(e => console.error('First-paid celebration error:', e && e.message));
            }
          }
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const { rows } = await pool.query(
          'UPDATE users SET plan=$1, stripe_subscription_id=NULL, subscription_status=NULL WHERE stripe_subscription_id=$2',
          ['free', sub.id]
        );
        break;
      }
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        // Dunning + Smart Retries: past_due and paused restrict Pro features
        // without destroying the user's subscription link, so the Customer
        // Portal can restore them the moment a retry succeeds.
        const plan = sub.status === 'active' || sub.status === 'trialing' ? 'pro' : 'free';
        await pool.query(
          'UPDATE users SET plan=$1, subscription_status=$3 WHERE stripe_subscription_id=$2',
          [plan, sub.id, sub.status]
        );
        break;
      }
    }
  } catch (err) {
    console.error('Webhook handler error:', err);
  }

  res.json({ received: true });
});

router.get('/settings', requireAuth, async (req, res) => {
  const user = await db.getUserById(req.session.user.id);
  if (!user) return res.redirect('/auth/login');
  const flash = req.session.flash;
  delete req.session.flash;
  res.render('settings', { title: 'Account Settings', user, flash, noindex: true });
});

router.post('/webhook-url', requireAuth, async (req, res) => {
  try {
    const user = await db.getUserById(req.session.user.id);
    if (!user || (user.plan !== 'pro' && user.plan !== 'agency')) {
      req.session.flash = { type: 'error', message: 'Webhooks are a Pro feature. Upgrade to enable.' };
      return res.redirect('/billing/settings');
    }
    const raw = (req.body && req.body.webhook_url) || '';
    const trimmed = String(raw).trim();
    if (trimmed.length === 0) {
      await db.updateUser(user.id, { webhook_url: null });
      req.session.flash = { type: 'success', message: 'Webhook removed.' };
      return res.redirect('/billing/settings');
    }
    if (!(await isValidWebhookUrl(trimmed))) {
      req.session.flash = { type: 'error', message: 'Webhook URL must be http(s) and point to a public host.' };
      return res.redirect('/billing/settings');
    }
    await db.updateUser(user.id, { webhook_url: trimmed });
    req.session.flash = { type: 'success', message: 'Webhook saved. We\'ll POST an event to this URL when any invoice is marked paid.' };
    res.redirect('/billing/settings');
  } catch (err) {
    console.error('Webhook URL save error:', err);
    req.session.flash = { type: 'error', message: 'Could not save webhook URL.' };
    res.redirect('/billing/settings');
  }
});

router.post('/settings', requireAuth, async (req, res) => {
  try {
    const replyToRaw = (req.body.reply_to_email || '').trim();
    // Light email-shape validation. The DB column is VARCHAR(255); we also
    // reject anything that doesn't have the basic local@host structure so a
    // bad value doesn't silently land on outbound mail headers.
    let replyTo = null;
    if (replyToRaw.length > 0) {
      const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyToRaw) && replyToRaw.length <= 255;
      if (!ok) {
        req.session.flash = { type: 'error', message: 'Reply-to email is not a valid address.' };
        return res.redirect('/billing/settings');
      }
      replyTo = replyToRaw;
    }
    const updated = await db.updateUser(req.session.user.id, {
      name: req.body.name,
      business_name: req.body.business_name || null,
      business_address: req.body.business_address || null,
      business_phone: req.body.business_phone || null,
      business_email: req.body.business_email || null,
      reply_to_email: replyTo
    });
    if (!updated) return res.redirect('/auth/login');
    req.session.user = { ...req.session.user, name: updated.name };
    req.session.flash = { type: 'success', message: 'Settings saved.' };
    res.redirect('/billing/settings');
  } catch (err) {
    console.error('Settings error:', err);
    req.session.flash = { type: 'error', message: 'Could not save settings.' };
    res.redirect('/billing/settings');
  }
});

module.exports = router;
