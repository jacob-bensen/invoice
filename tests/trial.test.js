'use strict';

/*
 * 7-day Pro free trial integration tests.
 *
 * Covers the no-card-required Pro trial flow:
 *  - POST /billing/create-checkout includes subscription_data.trial_period_days = 7
 *    on both monthly and annual billing cycles.
 *  - checkout.session.completed webhook reads sub.trial_end and persists
 *    trial_ends_at on the user row.
 *  - checkout.session.completed without a trial_end clears any prior
 *    trial_ends_at (paid signup overwrites a stale trial countdown).
 *  - Dashboard renders the trial banner when days_left_in_trial > 0.
 *  - Dashboard omits the trial banner when trial_ends_at is null.
 *  - Dashboard omits the trial banner when trial_ends_at is in the past.
 *  - Pricing CTA copy reads "Start 7-day free trial" with no-card subtext.
 *  - Upgrade modal CTA copy reads "Start 7-day free trial" with no-card subtext.
 *
 * Stripe and ../db are stubbed — no real network calls.
 *
 * Run: node tests/trial.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const http = require('http');
const ejs = require('ejs');

// ---------- Mutable test state ------------------------------------------

const checkoutSessionCalls = [];
const updateUserCalls = [];
const poolQueries = [];

let subscriptionRetrieveImpl = null;
let constructEventImpl = null;
let customerUserId = '42';

function reset() {
  checkoutSessionCalls.length = 0;
  updateUserCalls.length = 0;
  poolQueries.length = 0;
  subscriptionRetrieveImpl = null;
  constructEventImpl = null;
  customerUserId = '42';
}

// ---------- Stubs -------------------------------------------------------

const dbStub = {
  pool: {
    query: async (sql, params) => {
      poolQueries.push({ sql: sql.trim(), params });
      return { rows: [] };
    }
  },
  db: {
    async getUserById(id) {
      return { id, email: 'u@test.io', name: 'U', plan: 'free', stripe_customer_id: 'cus_existing' };
    },
    async updateUser(id, fields) {
      updateUserCalls.push({ id, fields });
      return { id, ...fields };
    },
    async markInvoicePaidByPaymentLinkId() { return null; }
  }
};

require.cache[require.resolve('../db')] = {
  id: require.resolve('../db'),
  filename: require.resolve('../db'),
  loaded: true,
  exports: dbStub
};

const mockStripeClient = {
  webhooks: {
    constructEvent(body, sig, secret) {
      if (!constructEventImpl) throw new Error('constructEventImpl not set for this test');
      return constructEventImpl(body, sig, secret);
    }
  },
  customers: {
    async create() { return { id: 'cus_new' }; },
    async retrieve() { return { metadata: { user_id: customerUserId } }; }
  },
  checkout: {
    sessions: {
      async create(params) {
        checkoutSessionCalls.push(params);
        return { id: 'cs_test', url: 'https://checkout.stripe.com/test' };
      }
    }
  },
  billingPortal: {
    sessions: {
      async create() { return { url: 'https://billing.stripe.com/portal' }; }
    }
  },
  subscriptions: {
    async retrieve(subId) {
      if (subscriptionRetrieveImpl) return subscriptionRetrieveImpl(subId);
      return { id: subId, trial_end: null };
    }
  }
};

require.cache[require.resolve('stripe')] = {
  id: require.resolve('stripe'),
  filename: require.resolve('stripe'),
  loaded: true,
  exports: () => mockStripeClient
};

process.env.STRIPE_PRO_PRICE_ID = 'price_monthly_TEST';
process.env.STRIPE_PRO_ANNUAL_PRICE_ID = 'price_annual_TEST';
process.env.APP_URL = 'https://test.invoice.app';
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';

function clearReq(mod) { delete require.cache[require.resolve(mod)]; }
clearReq('../routes/billing');
const billingRoutes = require('../routes/billing');

// ---------- App builders ------------------------------------------------

function buildBillingApp(sessionUser) {
  const app = express();
  app.use('/billing/webhook', express.raw({ type: 'application/json' }));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, _res, next) => {
    if (sessionUser) req.session.user = sessionUser;
    next();
  });
  app.use('/billing', billingRoutes);
  return app;
}

// ---------- HTTP helpers -------------------------------------------------

function postCheckout(app, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const bodyStr = new URLSearchParams(body || {}).toString();
      const headers = {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(bodyStr)
      };
      const req = http.request(
        { hostname: '127.0.0.1', port, path: '/billing/create-checkout', method: 'POST', headers },
        res => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => server.close(() => resolve({ status: res.statusCode, body: data })));
        }
      );
      req.on('error', err => { server.close(); reject(err); });
      req.write(bodyStr);
      req.end();
    });
  });
}

function postWebhook(app, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const bodyStr = JSON.stringify(body);
      const bodyBuf = Buffer.from(bodyStr);
      const headers = {
        'Content-Type': 'application/json',
        'Content-Length': bodyBuf.length,
        'stripe-signature': 'valid-sig'
      };
      const req = http.request(
        { hostname: '127.0.0.1', port, path: '/billing/webhook', method: 'POST', headers },
        res => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => server.close(() => resolve({ status: res.statusCode, body: data })));
        }
      );
      req.on('error', err => { server.close(); reject(err); });
      req.write(bodyBuf);
      req.end();
    });
  });
}

// ---------- Tests -------------------------------------------------------

async function testCheckoutMonthlyIncludesTrial() {
  reset();
  const app = buildBillingApp({ id: 1 });
  const res = await postCheckout(app, { billing_cycle: 'monthly' });
  assert.strictEqual(res.status, 303, 'checkout must 303 redirect to Stripe');
  assert.strictEqual(checkoutSessionCalls.length, 1);
  const call = checkoutSessionCalls[0];
  assert.ok(call.subscription_data, 'checkout must pass subscription_data to Stripe');
  assert.strictEqual(call.subscription_data.trial_period_days, 7,
    'monthly checkout must include 7-day trial');
}

async function testCheckoutAnnualIncludesTrial() {
  reset();
  const app = buildBillingApp({ id: 1 });
  const res = await postCheckout(app, { billing_cycle: 'annual' });
  assert.strictEqual(res.status, 303);
  const call = checkoutSessionCalls[0];
  assert.strictEqual(call.subscription_data.trial_period_days, 7,
    'annual checkout must include 7-day trial (no card required at signup)');
  assert.strictEqual(call.line_items[0].price, 'price_annual_TEST',
    'annual cycle must still use the annual price (trial does not break price selection)');
}

async function testWebhookTrialPersistsTrialEndsAt() {
  reset();
  customerUserId = '77';
  const trialEndUnix = Math.floor(Date.now() / 1000) + 7 * 86400;
  subscriptionRetrieveImpl = (subId) => ({ id: subId, trial_end: trialEndUnix });

  const event = {
    type: 'checkout.session.completed',
    data: { object: { mode: 'subscription', customer: 'cus_abc', subscription: 'sub_trial_xyz' } }
  };
  constructEventImpl = () => event;

  const app = buildBillingApp(null);
  const res = await postWebhook(app, event);
  assert.strictEqual(res.status, 200, 'webhook must return 200');

  await new Promise(r => setImmediate(r));

  const call = updateUserCalls.find(c => c.fields.plan === 'pro');
  assert.ok(call, 'user must be upgraded to pro');
  assert.strictEqual(call.id, 77);
  assert.strictEqual(call.fields.stripe_subscription_id, 'sub_trial_xyz');
  assert.ok(call.fields.trial_ends_at instanceof Date,
    'trial_ends_at must be persisted as a Date when subscription has trial_end');
  const persistedMs = call.fields.trial_ends_at.getTime();
  assert.strictEqual(persistedMs, trialEndUnix * 1000,
    'persisted trial_ends_at must equal Stripe trial_end converted to ms');
}

async function testWebhookNoTrialClearsTrialEndsAt() {
  reset();
  customerUserId = '88';
  // No trial_end on the subscription (paid signup, not a trial conversion).
  subscriptionRetrieveImpl = (subId) => ({ id: subId, trial_end: null });

  const event = {
    type: 'checkout.session.completed',
    data: { object: { mode: 'subscription', customer: 'cus_paid', subscription: 'sub_paid_zzz' } }
  };
  constructEventImpl = () => event;

  const app = buildBillingApp(null);
  const res = await postWebhook(app, event);
  assert.strictEqual(res.status, 200);

  await new Promise(r => setImmediate(r));

  const call = updateUserCalls.find(c => c.fields.plan === 'pro');
  assert.ok(call, 'user must still be upgraded to pro on a paid (non-trial) subscription');
  assert.strictEqual(call.fields.trial_ends_at, null,
    'trial_ends_at must be cleared (set to null) on a non-trial subscription so a stale countdown does not linger');
}

async function testWebhookSubscriptionRetrieveErrorStillUpgrades() {
  reset();
  customerUserId = '55';
  subscriptionRetrieveImpl = () => { throw new Error('Stripe API down'); };

  const event = {
    type: 'checkout.session.completed',
    data: { object: { mode: 'subscription', customer: 'cus_x', subscription: 'sub_x' } }
  };
  constructEventImpl = () => event;

  const app = buildBillingApp(null);
  const res = await postWebhook(app, event);
  assert.strictEqual(res.status, 200, 'webhook must return 200 even when subscription fetch fails');

  await new Promise(r => setImmediate(r));

  const call = updateUserCalls.find(c => c.fields.plan === 'pro');
  assert.ok(call, 'user must still be upgraded to pro when stripe.subscriptions.retrieve throws');
  assert.strictEqual(call.fields.stripe_subscription_id, 'sub_x');
  // trial_ends_at is omitted (not present in fields object) when retrieve fails —
  // the existing user value is left untouched.
  assert.ok(!('trial_ends_at' in call.fields),
    'trial_ends_at must be left unchanged when Stripe subscription fetch fails');
}

async function testDashboardRendersTrialBannerWhenDaysLeftPositive() {
  const tpl = fs.readFileSync(path.join(__dirname, '..', 'views', 'dashboard.ejs'), 'utf8');
  const html = ejs.render(tpl, {
    user: { plan: 'pro', invoice_count: 0, subscription_status: null, trial_ends_at: new Date(Date.now() + 5 * 86400000) },
    invoices: [],
    flash: null,
    days_left_in_trial: 5,
    title: 'Dashboard'
  }, { views: [path.join(__dirname, '..', 'views')], filename: path.join(__dirname, '..', 'views', 'dashboard.ejs') });

  assert.ok(/data-testid=["']trial-banner["']/.test(html),
    'dashboard must render trial-banner element when days_left_in_trial > 0');
  assert.ok(/Pro trial.*5 days left/.test(html),
    'banner must display the correct day count');
  assert.ok(/Add payment method/.test(html),
    'banner must include the Add-payment-method CTA');
  assert.ok(/action=["']\/billing\/portal["']/.test(html),
    'banner CTA must POST to /billing/portal');
}

async function testDashboardLastDayUrgentBanner() {
  // #45 — when days_left_in_trial === 1, swap to red/urgent styling
  // and last-day copy so the highest-converting cohort sees urgency on
  // the same surface that the day-3 nudge email (#29) lands them on.
  const tpl = fs.readFileSync(path.join(__dirname, '..', 'views', 'dashboard.ejs'), 'utf8');
  const html = ejs.render(tpl, {
    user: { plan: 'pro', invoice_count: 0, subscription_status: null },
    invoices: [],
    flash: null,
    days_left_in_trial: 1,
    title: 'Dashboard'
  }, { views: [path.join(__dirname, '..', 'views')], filename: path.join(__dirname, '..', 'views', 'dashboard.ejs') });

  assert.ok(/data-testid=["']trial-banner["']/.test(html),
    'urgent banner must still render with the trial-banner test id');
  assert.ok(/data-trial-urgent=["']true["']/.test(html),
    'banner must mark itself as urgent on the last day');
  assert.ok(/Last day of your Pro trial/.test(html),
    'banner must use the urgent "Last day" copy on day 1');
  assert.ok(/bg-red-50/.test(html),
    'banner container must use red urgency background on day 1');
  assert.ok(/border-red-200/.test(html),
    'banner container must use red urgency border on day 1');
  assert.ok(/bg-red-600/.test(html),
    'CTA button must use red urgency colour on day 1');
  assert.ok(/role=["']alert["']/.test(html),
    'banner must escalate to role="alert" on the last day');
  // No leakage of the calm-state copy or styling into the urgent branch.
  assert.ok(!/bg-blue-50/.test(html),
    'banner must not retain blue calm-state background on the urgent branch');
  assert.ok(!/1 days left/.test(html),
    'must not render the broken "1 days left" plural');
  assert.ok(!/1 day left/.test(html),
    'must not fall back to the calm "1 day left" copy on day 1 (urgent branch must override)');
  // CTA path unchanged — same Stripe portal redirect, no funnel divergence.
  assert.ok(/action=["']\/billing\/portal["']/.test(html),
    'urgent banner CTA must POST to the same /billing/portal handler');
}

async function testDashboardLastDayUrgentBannerHasAnnualSavingsPill() {
  // #133 — the day-1 urgent banner must additionally surface the annual
  // savings pill so the trial-end conversion moment frames the higher-margin
  // annual price rather than the implicit monthly default.
  const tpl = fs.readFileSync(path.join(__dirname, '..', 'views', 'dashboard.ejs'), 'utf8');
  const html = ejs.render(tpl, {
    user: { plan: 'pro', invoice_count: 0, subscription_status: null },
    invoices: [],
    flash: null,
    days_left_in_trial: 1,
    title: 'Dashboard'
  }, { views: [path.join(__dirname, '..', 'views')], filename: path.join(__dirname, '..', 'views', 'dashboard.ejs') });

  assert.ok(/data-testid=["']trial-urgent-annual-pill["']/.test(html),
    'day-1 urgent banner must render the annual-savings pill (data-testid=trial-urgent-annual-pill) for #133');
  assert.ok(/\$99\/year/.test(html),
    'pill copy must include the concrete $99/year price anchor');
  assert.ok(/3 months free/.test(html),
    'pill copy must include the "3 months free" framing (matches the canonical #101 pattern)');
  // Pill uses the canonical green-100 bg + green-700 text styling shipped on
  // /settings + the upgrade-modal in cycle 15 (#101). Visual continuity
  // between the trial-end touchpoint and the existing pricing surfaces is
  // the entire point — assert the styling tokens so a future refactor that
  // accidentally swaps to a different colour family fails loudly.
  assert.ok(/bg-green-100[^"]*text-green-700|text-green-700[^"]*bg-green-100/.test(html),
    'pill must use the canonical green-100 bg + green-700 text styling (matches #101 settings/upgrade-modal pattern)');
  assert.ok(/rounded-full/.test(html),
    'pill must use rounded-full to match the canonical pill component');
  // Accessibility: the emoji prefix is decorative — the textual content
  // ("Lock in $99/year — 3 months free") carries the meaning. Without
  // aria-hidden, screen readers announce "money bag emoji Lock in..."
  // which adds noise without information. The canonical pattern in
  // settings.ejs + upgrade-modal.ejs wraps the emoji in
  // <span aria-hidden="true">; pin that contract here too.
  assert.ok(/<span aria-hidden=["']true["']>[^<]*&#128176/.test(html),
    'decorative 💰 emoji must be wrapped in <span aria-hidden="true"> for screen-reader cleanliness (matches canonical settings/upgrade-modal pattern)');
}

async function testDashboardCalmBannerOnEarlierDays() {
  // Regression guard — the urgent branch must NOT fire on day 2+, the
  // calm-state styling and copy must persist for the rest of the trial.
  const tpl = fs.readFileSync(path.join(__dirname, '..', 'views', 'dashboard.ejs'), 'utf8');
  for (const days of [2, 3, 5, 7]) {
    const html = ejs.render(tpl, {
      user: { plan: 'pro', invoice_count: 0, subscription_status: null },
      invoices: [],
      flash: null,
      days_left_in_trial: days,
      title: 'Dashboard'
    }, { views: [path.join(__dirname, '..', 'views')], filename: path.join(__dirname, '..', 'views', 'dashboard.ejs') });

    assert.ok(/data-trial-urgent=["']false["']/.test(html),
      `day ${days} banner must NOT mark itself urgent`);
    assert.ok(/bg-blue-50/.test(html),
      `day ${days} banner must use calm blue styling`);
    assert.ok(!/Last day of your Pro trial/.test(html),
      `day ${days} banner must not show "Last day" copy`);
    assert.ok(new RegExp(`${days} days left`).test(html),
      `day ${days} banner must read "${days} days left"`);
    // #133 — pill is urgent-branch-only; calm days must NOT render it.
    // Differentiation between the calm and urgent banners is the whole
    // reason we kept the calm copy minimal — leaking the pill across all
    // 7 trial days would dilute the day-1 urgency signal.
    assert.ok(!/data-testid=["']trial-urgent-annual-pill["']/.test(html),
      `day ${days} banner must NOT render the urgent-branch annual-savings pill (#133)`);
  }
}

async function testDashboardOmitsBannerWhenNoTrial() {
  const tpl = fs.readFileSync(path.join(__dirname, '..', 'views', 'dashboard.ejs'), 'utf8');

  const htmlNoTrial = ejs.render(tpl, {
    user: { plan: 'free', invoice_count: 0, subscription_status: null },
    invoices: [], flash: null, days_left_in_trial: 0, title: 'Dashboard'
  }, { views: [path.join(__dirname, '..', 'views')], filename: path.join(__dirname, '..', 'views', 'dashboard.ejs') });
  assert.ok(!/data-testid=["']trial-banner["']/.test(htmlNoTrial),
    'no trial banner when days_left_in_trial = 0');

  // Locals omitted entirely — banner must still be hidden.
  const htmlNoLocal = ejs.render(tpl, {
    user: { plan: 'free', invoice_count: 0, subscription_status: null },
    invoices: [], flash: null, title: 'Dashboard'
  }, { views: [path.join(__dirname, '..', 'views')], filename: path.join(__dirname, '..', 'views', 'dashboard.ejs') });
  assert.ok(!/data-testid=["']trial-banner["']/.test(htmlNoLocal),
    'no trial banner when days_left_in_trial local is undefined');
}

async function testPricingCtaCopyMentionsTrial() {
  const tpl = fs.readFileSync(path.join(__dirname, '..', 'views', 'pricing.ejs'), 'utf8');
  const html = ejs.render(tpl, { user: { plan: 'free' }, title: 'Upgrade', flash: null }, {
    views: [path.join(__dirname, '..', 'views')],
    filename: path.join(__dirname, '..', 'views', 'pricing.ejs')
  });
  assert.ok(/Start 7-day free trial/.test(html),
    'pricing CTA must read "Start 7-day free trial"');
  assert.ok(/No credit card required/i.test(html),
    'pricing must reassure visitors no credit card is required');
}

async function testUpgradeModalCtaCopyMentionsTrial() {
  const tpl = fs.readFileSync(path.join(__dirname, '..', 'views', 'partials', 'upgrade-modal.ejs'), 'utf8');
  const html = ejs.render(tpl, {}, {});
  assert.ok(/Start 7-day free trial/.test(html),
    'upgrade modal CTA must read "Start 7-day free trial"');
  assert.ok(/No credit card required/i.test(html),
    'modal must reassure visitors no credit card is required');
}

// ---------- Runner ------------------------------------------------------

async function run() {
  const tests = [
    ['Checkout: monthly cycle includes trial_period_days=7', testCheckoutMonthlyIncludesTrial],
    ['Checkout: annual cycle includes trial_period_days=7', testCheckoutAnnualIncludesTrial],
    ['Webhook: trial subscription persists trial_ends_at', testWebhookTrialPersistsTrialEndsAt],
    ['Webhook: non-trial subscription clears trial_ends_at', testWebhookNoTrialClearsTrialEndsAt],
    ['Webhook: subscription fetch error → still upgrades, no trial_ends_at write', testWebhookSubscriptionRetrieveErrorStillUpgrades],
    ['Dashboard: renders trial banner when days_left_in_trial > 0', testDashboardRendersTrialBannerWhenDaysLeftPositive],
    ['Dashboard: last-day urgent banner copy + red styling on day 1 (#45)', testDashboardLastDayUrgentBanner],
    ['Dashboard: last-day urgent banner surfaces annual-savings pill (#133)', testDashboardLastDayUrgentBannerHasAnnualSavingsPill],
    ['Dashboard: calm banner persists for days 2-7 (regression guard for #45 + #133)', testDashboardCalmBannerOnEarlierDays],
    ['Dashboard: omits trial banner when no trial / 0 days left', testDashboardOmitsBannerWhenNoTrial],
    ['Pricing: CTA reads "Start 7-day free trial"', testPricingCtaCopyMentionsTrial],
    ['Modal: CTA reads "Start 7-day free trial"', testUpgradeModalCtaCopyMentionsTrial]
  ];

  let pass = 0, fail = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ok  ${name}`);
      pass++;
    } catch (err) {
      console.error(`  FAIL ${name}`);
      console.error(err && err.stack ? err.stack : err);
      fail++;
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run().catch(err => { console.error(err); process.exit(1); });
