const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { db, pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { isValidWebhookUrl, firePaidWebhook, buildPaidPayload } = require('../lib/outbound-webhook');

const router = express.Router();

router.get('/upgrade', requireAuth, (req, res) => {
  const flash = req.session.flash;
  delete req.session.flash;
  res.render('pricing', { title: 'Upgrade to Pro', flash });
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

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{
        price: priceId,
        quantity: 1
      }],
      mode: 'subscription',
      metadata: { billing_cycle: cycle, user_id: String(user.id) },
      success_url: `${process.env.APP_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.APP_URL}/billing/upgrade`
    });

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
  req.session.user = { ...req.session.user, plan: user.plan };
  res.redirect('/dashboard');
});

router.post('/portal', requireAuth, async (req, res) => {
  try {
    const user = await db.getUserById(req.session.user.id);
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
            await db.updateUser(parseInt(userId), {
              plan: 'pro',
              stripe_subscription_id: session.subscription
            });
          }
        } else if (session.mode === 'payment' && session.payment_link) {
          // Invoice Payment Link was paid — mark the invoice as paid.
          const updated = await db.markInvoicePaidByPaymentLinkId(session.payment_link);
          if (!updated) {
            console.warn(`No invoice found for payment_link ${session.payment_link}`);
          } else {
            // Fire the outbound Zapier-style webhook for Pro/Agency users.
            const owner = await db.getUserById(updated.user_id);
            if (owner && (owner.plan === 'pro' || owner.plan === 'agency') && owner.webhook_url) {
              firePaidWebhook(owner.webhook_url, buildPaidPayload(updated))
                .then(r => { if (!r.ok) console.warn(`webhook ${owner.webhook_url} failed:`, r.reason || r.status); })
                .catch(e => console.error('Outbound webhook error:', e && e.message));
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
  const flash = req.session.flash;
  delete req.session.flash;
  res.render('settings', { title: 'Account Settings', user, flash });
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
    const updated = await db.updateUser(req.session.user.id, {
      name: req.body.name,
      business_name: req.body.business_name || null,
      business_address: req.body.business_address || null,
      business_phone: req.body.business_phone || null,
      business_email: req.body.business_email || null
    });
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
