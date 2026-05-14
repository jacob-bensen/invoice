'use strict';

/*
 * Monthly → Annual upgrade prompt (#47).
 *
 * Covers:
 *  - buildAnnualUpgradePrompt eligibility (Pro + monthly + not dunning +
 *    past-trial + has stripe_subscription_id).
 *  - dashboard.ejs renders the banner only when the prompt is non-null.
 *  - POST /billing/switch-to-annual: free users / annual users / no-sub
 *    are no-ops; eligible monthly Pro users call stripe.subscriptions.update
 *    with the annual price + create_prorations and the DB is updated to
 *    billing_cycle='annual'.
 *  - POST /billing/switch-to-annual gracefully no-ops when
 *    STRIPE_PRO_ANNUAL_PRICE_ID is unset (never crashes).
 *  - Stripe webhook (checkout.session.completed) writes
 *    billing_cycle from session.metadata.billing_cycle for both
 *    'monthly' and 'annual' cycles.
 *
 * Stripe + ../db are stubbed; no real network calls.
 *
 * Run: node tests/annual-upgrade-prompt.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const http = require('http');
const ejs = require('ejs');

// ---------- Mutable test state ------------------------------------------

const updateUserCalls = [];
const subUpdateCalls = [];
const subRetrieveCalls = [];
const customerRetrieveCalls = [];
const checkoutSessionCalls = [];

let currentUser = null;
let subscriptionFixture = {
  id: 'sub_default',
  items: { data: [{ id: 'si_default' }] },
  trial_end: null
};
let customerFixture = { metadata: { user_id: '42' } };
let constructEventImpl = null;

function reset() {
  updateUserCalls.length = 0;
  subUpdateCalls.length = 0;
  subRetrieveCalls.length = 0;
  customerRetrieveCalls.length = 0;
  checkoutSessionCalls.length = 0;
  currentUser = null;
  subscriptionFixture = { id: 'sub_default', items: { data: [{ id: 'si_default' }] }, trial_end: null };
  customerFixture = { metadata: { user_id: '42' } };
  constructEventImpl = null;
}

// ---------- Stubs -------------------------------------------------------

const dbStub = {
  pool: { query: async () => ({ rows: [] }) },
  db: {
    async getUserById(id) {
      if (currentUser) return { ...currentUser, id };
      return null;
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
      if (!constructEventImpl) throw new Error('constructEventImpl not set');
      return constructEventImpl(body, sig, secret);
    }
  },
  customers: {
    async create(params) { return { id: 'cus_new' }; },
    async retrieve(id) { customerRetrieveCalls.push(id); return customerFixture; }
  },
  subscriptions: {
    async retrieve(id) { subRetrieveCalls.push(id); return { ...subscriptionFixture, id }; },
    async update(id, params) { subUpdateCalls.push({ id, params }); return { id, ...params }; }
  },
  checkout: {
    sessions: {
      async create(params) { checkoutSessionCalls.push(params); return { id: 'cs', url: 'https://checkout.stripe.com/x' }; }
    }
  },
  billingPortal: { sessions: { async create() { return { url: 'https://billing.stripe.com/portal' }; } } }
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
clearReq('../routes/invoices');
const billingRoutes = require('../routes/billing');
const invoicesRoutes = require('../routes/invoices');
const { buildAnnualUpgradePrompt } = invoicesRoutes;

// ---------- App builder -------------------------------------------------

function buildApp(sessionUser) {
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

function post(app, p, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const bodyStr = new URLSearchParams(body || {}).toString();
      const headers = {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(bodyStr)
      };
      const req = http.request(
        { hostname: '127.0.0.1', port, path: p, method: 'POST', headers },
        res => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => server.close(() => resolve({ status: res.statusCode, location: res.headers.location, body: data })));
        }
      );
      req.on('error', err => { server.close(); reject(err); });
      req.write(bodyStr);
      req.end();
    });
  });
}

function webhook(body, sig) {
  const app = buildApp(null);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const bodyStr = JSON.stringify(body);
      const bodyBuf = Buffer.from(bodyStr);
      const headers = {
        'Content-Type': 'application/json',
        'Content-Length': bodyBuf.length,
        'stripe-signature': sig || 'valid-sig'
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

// ---------- Eligibility helper tests ------------------------------------

function testHelperFreeUserIsIneligible() {
  const out = buildAnnualUpgradePrompt({ plan: 'free', billing_cycle: 'monthly', stripe_subscription_id: 'sub_x' });
  assert.strictEqual(out, null, 'free user must never see the annual prompt');
}

function testHelperProAnnualUserIsIneligible() {
  const out = buildAnnualUpgradePrompt({ plan: 'pro', billing_cycle: 'annual', stripe_subscription_id: 'sub_x' });
  assert.strictEqual(out, null, 'user already on annual must not see the prompt');
}

function testHelperProMonthlyWithoutSubscriptionIsIneligible() {
  const out = buildAnnualUpgradePrompt({ plan: 'pro', billing_cycle: 'monthly', stripe_subscription_id: null });
  assert.strictEqual(out, null, 'we cannot switch a subscription we do not have an ID for');
}

function testHelperProMonthlyInTrialIsIneligible() {
  const futureTrial = new Date(Date.now() + 3 * 86400000).toISOString();
  const out = buildAnnualUpgradePrompt({
    plan: 'pro', billing_cycle: 'monthly', stripe_subscription_id: 'sub_x',
    trial_ends_at: futureTrial
  });
  assert.strictEqual(out, null, 'trialing users get the trial banner, not the annual upsell');
}

function testHelperProMonthlyPastDueIsIneligible() {
  const out = buildAnnualUpgradePrompt({
    plan: 'pro', billing_cycle: 'monthly', stripe_subscription_id: 'sub_x',
    subscription_status: 'past_due'
  });
  assert.strictEqual(out, null, 'never stack an upsell on top of dunning');
}

function testHelperProMonthlyPausedIsIneligible() {
  const out = buildAnnualUpgradePrompt({
    plan: 'pro', billing_cycle: 'monthly', stripe_subscription_id: 'sub_x',
    subscription_status: 'paused'
  });
  assert.strictEqual(out, null, 'paused subs do not get an upsell');
}

function testHelperEligibleProMonthlyPostTrial() {
  const pastTrial = new Date(Date.now() - 86400000).toISOString();
  const out = buildAnnualUpgradePrompt({
    plan: 'pro', billing_cycle: 'monthly', stripe_subscription_id: 'sub_x',
    trial_ends_at: pastTrial, subscription_status: 'active'
  });
  assert.ok(out, 'post-trial active monthly Pro user must be eligible');
  assert.strictEqual(out.monthlyPrice, 12);
  assert.strictEqual(out.annualPrice, 99);
  assert.strictEqual(out.savingsPerYear, 45);
}

function testHelperEligibleProMonthlyNoTrial() {
  const out = buildAnnualUpgradePrompt({
    plan: 'pro', billing_cycle: 'monthly', stripe_subscription_id: 'sub_x',
    trial_ends_at: null, subscription_status: 'active'
  });
  assert.ok(out, 'paid-direct (no trial) monthly Pro user must be eligible');
}

function testHelperLegacyProWithoutCycleIsIneligible() {
  const out = buildAnnualUpgradePrompt({
    plan: 'pro', billing_cycle: null, stripe_subscription_id: 'sub_x',
    subscription_status: 'active'
  });
  assert.strictEqual(out, null, 'legacy Pro users without a recorded billing_cycle do not see the banner');
}

// ---------- Dashboard view-render tests ---------------------------------

function renderDashboard(locals) {
  const tpl = fs.readFileSync(path.join(__dirname, '..', 'views', 'dashboard.ejs'), 'utf8');
  const defaults = {
    title: 'My Invoices',
    invoices: [],
    user: { plan: 'pro', billing_cycle: 'monthly' },
    flash: null,
    days_left_in_trial: 0,
    onboarding: null,
    invoiceLimitProgress: null,
    recentRevenue: null,
    annualUpgradePrompt: null,
    csrfToken: 'csrf-test',
    noindex: true,
    trialCountdown: null
  };
  return ejs.render(tpl, { ...defaults, ...locals }, {
    views: [path.join(__dirname, '..', 'views')],
    filename: path.join(__dirname, '..', 'views', 'dashboard.ejs')
  });
}

function testDashboardRendersBannerWhenPromptIsSet() {
  const html = renderDashboard({
    annualUpgradePrompt: { monthlyPrice: 12, annualPrice: 99, savingsPerYear: 45 }
  });
  assert.ok(/data-testid="annual-upgrade-banner"/.test(html),
    'banner must render when annualUpgradePrompt is non-null');
  assert.ok(/Save \$45\/year/.test(html), 'banner must show the savings copy');
  assert.ok(/\$99\/yr/.test(html), 'banner must surface the annual price in the CTA');
  assert.ok(/action="\/billing\/switch-to-annual"/.test(html),
    'banner CTA must POST to /billing/switch-to-annual');
  assert.ok(/name="_csrf"\s+value="csrf-test"/.test(html), 'banner form must carry the CSRF token');
}

function testDashboardSuppressesBannerWhenPromptIsNull() {
  const html = renderDashboard({ annualUpgradePrompt: null });
  assert.ok(!/data-testid="annual-upgrade-banner"/.test(html),
    'banner must not render when annualUpgradePrompt is null');
}

// ---------- Switch-to-annual route tests --------------------------------

async function testSwitchRouteFreeUserIsRejected() {
  reset();
  currentUser = { plan: 'free', stripe_subscription_id: null };
  const app = buildApp({ id: 7 });
  const res = await post(app, '/billing/switch-to-annual', { _csrf: 'x' });
  // CSRF middleware not mounted in this test app — the route handler runs.
  assert.strictEqual(res.status, 302);
  assert.strictEqual(subUpdateCalls.length, 0, 'free user must not trigger Stripe subscription update');
}

async function testSwitchRouteAlreadyAnnualIsNoOp() {
  reset();
  currentUser = { plan: 'pro', billing_cycle: 'annual', stripe_subscription_id: 'sub_a' };
  const app = buildApp({ id: 8 });
  const res = await post(app, '/billing/switch-to-annual', {});
  assert.strictEqual(res.status, 302);
  assert.strictEqual(subUpdateCalls.length, 0, 'annual user must not trigger another Stripe update');
}

async function testSwitchRouteEligibleMonthlyUpdatesSubscriptionAndDB() {
  reset();
  currentUser = { plan: 'pro', billing_cycle: 'monthly', stripe_subscription_id: 'sub_real' };
  subscriptionFixture = {
    id: 'sub_real',
    items: { data: [{ id: 'si_real_item', price: { id: 'price_monthly_TEST' } }] }
  };
  const app = buildApp({ id: 9 });
  const res = await post(app, '/billing/switch-to-annual', {});
  assert.strictEqual(res.status, 302);
  assert.strictEqual(subRetrieveCalls.length, 1, 'must retrieve the subscription to find the item ID');
  assert.strictEqual(subRetrieveCalls[0], 'sub_real');
  assert.strictEqual(subUpdateCalls.length, 1, 'must call subscriptions.update exactly once');
  const call = subUpdateCalls[0];
  assert.strictEqual(call.id, 'sub_real');
  assert.deepStrictEqual(call.params.items, [{ id: 'si_real_item', price: 'price_annual_TEST' }],
    'must swap the subscription item to the annual price');
  assert.strictEqual(call.params.proration_behavior, 'create_prorations',
    'must request prorations so the customer gets the unused-month credit');
  const dbCall = updateUserCalls.find(c => c.fields.billing_cycle === 'annual');
  assert.ok(dbCall, 'db.updateUser must record billing_cycle=annual after the Stripe update succeeds');
  assert.strictEqual(dbCall.id, 9);
}

async function testSwitchRouteFallsBackWhenAnnualPriceUnset() {
  reset();
  const original = process.env.STRIPE_PRO_ANNUAL_PRICE_ID;
  delete process.env.STRIPE_PRO_ANNUAL_PRICE_ID;
  try {
    currentUser = { plan: 'pro', billing_cycle: 'monthly', stripe_subscription_id: 'sub_real' };
    const app = buildApp({ id: 10 });
    const res = await post(app, '/billing/switch-to-annual', {});
    assert.strictEqual(res.status, 302);
    assert.strictEqual(subUpdateCalls.length, 0,
      'must not call Stripe when annual price is unset — fail closed');
    const dbCall = updateUserCalls.find(c => c.fields.billing_cycle === 'annual');
    assert.ok(!dbCall, 'db must not be updated when Stripe call was not made');
  } finally {
    process.env.STRIPE_PRO_ANNUAL_PRICE_ID = original;
  }
}

// ---------- Webhook billing_cycle persistence ---------------------------

async function testWebhookCapturesMonthlyBillingCycle() {
  reset();
  customerFixture = { metadata: { user_id: '77' } };
  const event = {
    type: 'checkout.session.completed',
    data: {
      object: {
        mode: 'subscription',
        customer: 'cus_abc',
        subscription: 'sub_xyz',
        metadata: { billing_cycle: 'monthly' }
      }
    }
  };
  constructEventImpl = () => event;
  const res = await webhook(event);
  assert.strictEqual(res.status, 200);
  await new Promise(r => setImmediate(r));
  const call = updateUserCalls.find(c => c.fields.plan === 'pro');
  assert.ok(call, 'user must be upgraded to pro');
  assert.strictEqual(call.fields.billing_cycle, 'monthly',
    'webhook must persist billing_cycle=monthly from session.metadata');
}

async function testWebhookCapturesAnnualBillingCycle() {
  reset();
  customerFixture = { metadata: { user_id: '88' } };
  const event = {
    type: 'checkout.session.completed',
    data: {
      object: {
        mode: 'subscription',
        customer: 'cus_abc',
        subscription: 'sub_xyz',
        metadata: { billing_cycle: 'annual' }
      }
    }
  };
  constructEventImpl = () => event;
  const res = await webhook(event);
  assert.strictEqual(res.status, 200);
  await new Promise(r => setImmediate(r));
  const call = updateUserCalls.find(c => c.fields.plan === 'pro');
  assert.ok(call, 'user must be upgraded to pro');
  assert.strictEqual(call.fields.billing_cycle, 'annual',
    'webhook must persist billing_cycle=annual from session.metadata');
}

async function testWebhookIgnoresUnknownBillingCycle() {
  reset();
  customerFixture = { metadata: { user_id: '99' } };
  const event = {
    type: 'checkout.session.completed',
    data: {
      object: {
        mode: 'subscription',
        customer: 'cus_abc',
        subscription: 'sub_xyz',
        metadata: { billing_cycle: 'lifetime' }
      }
    }
  };
  constructEventImpl = () => event;
  const res = await webhook(event);
  assert.strictEqual(res.status, 200);
  await new Promise(r => setImmediate(r));
  const call = updateUserCalls.find(c => c.fields.plan === 'pro');
  assert.ok(call, 'user must still be upgraded to pro');
  assert.ok(!('billing_cycle' in call.fields),
    'unknown billing_cycle values must not be persisted (whitelist guard)');
}

// ---------- Runner ------------------------------------------------------

async function run() {
  const tests = [
    ['Helper: free user is ineligible', testHelperFreeUserIsIneligible],
    ['Helper: Pro+annual user is ineligible', testHelperProAnnualUserIsIneligible],
    ['Helper: Pro+monthly without subscription ID is ineligible', testHelperProMonthlyWithoutSubscriptionIsIneligible],
    ['Helper: Pro+monthly in trial is ineligible', testHelperProMonthlyInTrialIsIneligible],
    ['Helper: Pro+monthly past_due is ineligible', testHelperProMonthlyPastDueIsIneligible],
    ['Helper: Pro+monthly paused is ineligible', testHelperProMonthlyPausedIsIneligible],
    ['Helper: Pro+monthly post-trial active is eligible', testHelperEligibleProMonthlyPostTrial],
    ['Helper: Pro+monthly no-trial paid-direct is eligible', testHelperEligibleProMonthlyNoTrial],
    ['Helper: legacy Pro without billing_cycle is ineligible', testHelperLegacyProWithoutCycleIsIneligible],
    ['Dashboard: banner renders when prompt is set', testDashboardRendersBannerWhenPromptIsSet],
    ['Dashboard: banner suppressed when prompt is null', testDashboardSuppressesBannerWhenPromptIsNull],
    ['Route: /switch-to-annual rejects free users', testSwitchRouteFreeUserIsRejected],
    ['Route: /switch-to-annual is a no-op for annual users', testSwitchRouteAlreadyAnnualIsNoOp],
    ['Route: /switch-to-annual swaps Stripe item + persists billing_cycle', testSwitchRouteEligibleMonthlyUpdatesSubscriptionAndDB],
    ['Route: /switch-to-annual fails closed when annual price unset', testSwitchRouteFallsBackWhenAnnualPriceUnset],
    ['Webhook: captures billing_cycle=monthly from metadata', testWebhookCapturesMonthlyBillingCycle],
    ['Webhook: captures billing_cycle=annual from metadata', testWebhookCapturesAnnualBillingCycle],
    ['Webhook: ignores unknown billing_cycle values', testWebhookIgnoresUnknownBillingCycle]
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
