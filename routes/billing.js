const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { db, pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/upgrade', requireAuth, (req, res) => {
  const flash = req.session.flash;
  delete req.session.flash;
  res.render('pricing', { title: 'Upgrade to Pro', flash });
});

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

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{
        price: process.env.STRIPE_PRO_PRICE_ID,
        quantity: 1
      }],
      mode: 'subscription',
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
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const { rows } = await pool.query(
          'UPDATE users SET plan=$1, stripe_subscription_id=NULL WHERE stripe_subscription_id=$2',
          ['free', sub.id]
        );
        break;
      }
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const plan = sub.status === 'active' ? 'pro' : 'free';
        await pool.query(
          'UPDATE users SET plan=$1 WHERE stripe_subscription_id=$2',
          [plan, sub.id]
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
