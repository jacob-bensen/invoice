'use strict';

/*
 * Annual billing integration tests.
 *
 * Covers the new Monthly / Annual billing-cycle selector:
 *  - POST /billing/create-checkout without billing_cycle defaults to monthly price.
 *  - POST /billing/create-checkout with billing_cycle=monthly passes monthly price.
 *  - POST /billing/create-checkout with billing_cycle=annual passes annual price.
 *  - Annual cycle falls back to monthly price when STRIPE_PRO_ANNUAL_PRICE_ID is not set
 *    (avoids breaking checkout before Master has created the Stripe price).
 *  - Unknown billing_cycle value is normalised to monthly (never undefined/bogus to Stripe).
 *  - checkout.sessions.create receives metadata.billing_cycle for downstream visibility.
 *  - Pricing and settings pages include the cycle selector + billing_cycle hidden input.
 *  - Upgrade modal partial includes the cycle selector + billing_cycle hidden input.
 *
 * Stripe and ../db are stubbed — no real network calls.
 *
 * Run: node tests/annual-billing.test.js
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
const customerCreateCalls = [];
const updateUserCalls = [];

function reset() {
  checkoutSessionCalls.length = 0;
  customerCreateCalls.length = 0;
  updateUserCalls.length = 0;
}

// ---------- Stubs -------------------------------------------------------

const dbStub = {
  pool: { query: async () => ({ rows: [] }) },
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
    constructEvent: () => { throw new Error('not used in these tests'); }
  },
  customers: {
    async create(params) { customerCreateCalls.push(params); return { id: 'cus_new' }; },
    async retrieve() { return { metadata: { user_id: '42' } }; }
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
  }
};

require.cache[require.resolve('stripe')] = {
  id: require.resolve('stripe'),
  filename: require.resolve('stripe'),
  loaded: true,
  exports: () => mockStripeClient
};

// Force the env vars we assert against to known values.
process.env.STRIPE_PRO_PRICE_ID = 'price_monthly_TEST';
process.env.STRIPE_PRO_ANNUAL_PRICE_ID = 'price_annual_TEST';
process.env.APP_URL = 'https://test.invoice.app';
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';

// Load billing routes AFTER all stubs and env vars are installed.
function clearReq(mod) { delete require.cache[require.resolve(mod)]; }
clearReq('../routes/billing');
const billingRoutes = require('../routes/billing');

// ---------- App builder -------------------------------------------------

function buildApp(sessionUser) {
  const app = express();
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

// ---------- HTTP helper (form-url-encoded body) -------------------------

function post(app, body) {
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
          res.on('end', () => {
            server.close(() => resolve({ status: res.statusCode, location: res.headers.location, body: data }));
          });
        }
      );
      req.on('error', err => { server.close(); reject(err); });
      req.write(bodyStr);
      req.end();
    });
  });
}

// ---------- Tests -------------------------------------------------------

async function testNoCycleDefaultsToMonthly() {
  reset();
  const app = buildApp({ id: 1 });
  const res = await post(app, {});
  assert.strictEqual(res.status, 303, 'checkout should 303 redirect to Stripe');
  assert.strictEqual(checkoutSessionCalls.length, 1);
  const call = checkoutSessionCalls[0];
  assert.strictEqual(call.line_items[0].price, 'price_monthly_TEST',
    'missing billing_cycle must default to the monthly Stripe price');
  assert.strictEqual(call.metadata.billing_cycle, 'monthly',
    'metadata.billing_cycle must record the effective cycle');
  assert.strictEqual(call.mode, 'subscription', 'must remain a recurring subscription');
}

async function testMonthlyCycleUsesMonthlyPrice() {
  reset();
  const app = buildApp({ id: 2 });
  const res = await post(app, { billing_cycle: 'monthly' });
  assert.strictEqual(res.status, 303);
  const call = checkoutSessionCalls[0];
  assert.strictEqual(call.line_items[0].price, 'price_monthly_TEST',
    'billing_cycle=monthly must use the monthly Stripe price');
  assert.strictEqual(call.metadata.billing_cycle, 'monthly');
}

async function testAnnualCycleUsesAnnualPrice() {
  reset();
  const app = buildApp({ id: 3 });
  const res = await post(app, { billing_cycle: 'annual' });
  assert.strictEqual(res.status, 303);
  const call = checkoutSessionCalls[0];
  assert.strictEqual(call.line_items[0].price, 'price_annual_TEST',
    'billing_cycle=annual must use the annual Stripe price');
  assert.strictEqual(call.metadata.billing_cycle, 'annual',
    'metadata must record annual cycle for downstream analytics');
}

async function testAnnualCycleFallsBackWhenAnnualPriceMissing() {
  reset();
  const original = process.env.STRIPE_PRO_ANNUAL_PRICE_ID;
  delete process.env.STRIPE_PRO_ANNUAL_PRICE_ID;
  try {
    // Reload billing route module so it picks up the env change at the time
    // resolvePriceId reads process.env (it reads it per-request, so no reload
    // strictly needed — but do it for safety).
    const app = buildApp({ id: 4 });
    const res = await post(app, { billing_cycle: 'annual' });
    assert.strictEqual(res.status, 303);
    const call = checkoutSessionCalls[0];
    assert.strictEqual(call.line_items[0].price, 'price_monthly_TEST',
      'annual selection must fall back to monthly when STRIPE_PRO_ANNUAL_PRICE_ID is unset');
    assert.strictEqual(call.metadata.billing_cycle, 'annual',
      'metadata must still reflect the user-selected cycle');
  } finally {
    process.env.STRIPE_PRO_ANNUAL_PRICE_ID = original;
  }
}

async function testUnknownCycleNormalisesToMonthly() {
  reset();
  const app = buildApp({ id: 5 });
  const res = await post(app, { billing_cycle: 'bogus' });
  assert.strictEqual(res.status, 303);
  const call = checkoutSessionCalls[0];
  assert.strictEqual(call.line_items[0].price, 'price_monthly_TEST',
    'unknown cycle must normalise to monthly (never pass a bogus value to Stripe)');
  assert.strictEqual(call.metadata.billing_cycle, 'monthly');
}

async function testPricingPageIncludesCycleToggleAndHiddenInput() {
  const tpl = fs.readFileSync(path.join(__dirname, '..', 'views', 'pricing.ejs'), 'utf8');
  const html = ejs.render(tpl, { user: { plan: 'free' }, title: 'Upgrade', flash: null }, {
    views: [path.join(__dirname, '..', 'views')],
    filename: path.join(__dirname, '..', 'views', 'pricing.ejs')
  });
  assert.ok(/cycle\s*=\s*'annual'/.test(html), 'pricing page must reference annual cycle');
  assert.ok(/cycle\s*=\s*'monthly'/.test(html), 'pricing page must reference monthly cycle');
  assert.ok(/name=['"]billing_cycle['"]/.test(html),
    'pricing page must POST a billing_cycle hidden input');
  assert.ok(/\$99/.test(html), 'pricing page must display the $99 annual price');
  assert.ok(/\$12/.test(html), 'pricing page must still display the $12 monthly price');
}

async function testSettingsPageIncludesCycleToggleForFreeUsers() {
  const tpl = fs.readFileSync(path.join(__dirname, '..', 'views', 'settings.ejs'), 'utf8');
  const html = ejs.render(tpl, {
    user: { plan: 'free', email: 'u@test.io', name: 'U', invoice_count: 1 },
    title: 'Settings',
    flash: null
  }, { views: [path.join(__dirname, '..', 'views')], filename: path.join(__dirname, '..', 'views', 'settings.ejs') });
  assert.ok(/name=['"]billing_cycle['"]/.test(html),
    'settings page must expose billing_cycle hidden input for upgrade');
  assert.ok(/\$99\/yr/.test(html), 'settings page must show the annual $99/yr option');
  assert.ok(/\$12\/mo/.test(html), 'settings page must show the monthly $12/mo option');
}

async function testSettingsPageHidesUpgradeSelectorForProUsers() {
  const tpl = fs.readFileSync(path.join(__dirname, '..', 'views', 'settings.ejs'), 'utf8');
  const html = ejs.render(tpl, {
    user: { plan: 'pro', email: 'u@test.io', name: 'U', invoice_count: 42 },
    title: 'Settings',
    flash: null
  }, { views: [path.join(__dirname, '..', 'views')], filename: path.join(__dirname, '..', 'views', 'settings.ejs') });
  assert.ok(!/name=['"]billing_cycle['"]/.test(html),
    'Pro users must not see the Upgrade selector with billing_cycle');
  assert.ok(/Manage subscription/.test(html),
    'Pro users must see Manage subscription link');
}

async function testUpgradeModalPartialIncludesCycleSelector() {
  const tpl = fs.readFileSync(path.join(__dirname, '..', 'views', 'partials', 'upgrade-modal.ejs'), 'utf8');
  // Render the partial directly — it references no required locals beyond the Alpine component.
  const html = ejs.render(tpl, {}, {});
  assert.ok(/name=['"]billing_cycle['"]/.test(html),
    'upgrade modal must POST a billing_cycle hidden input');
  assert.ok(/cycle\s*=\s*'annual'/.test(html),
    'upgrade modal must offer annual selection');
  assert.ok(/\$99\/year/.test(html),
    'upgrade modal must show the annual $99/year offer');
}

// ---------- Runner ------------------------------------------------------

async function run() {
  const tests = [
    ['Checkout: no billing_cycle → monthly price', testNoCycleDefaultsToMonthly],
    ['Checkout: billing_cycle=monthly → monthly price', testMonthlyCycleUsesMonthlyPrice],
    ['Checkout: billing_cycle=annual → annual price + metadata', testAnnualCycleUsesAnnualPrice],
    ['Checkout: annual falls back to monthly when annual price unset', testAnnualCycleFallsBackWhenAnnualPriceMissing],
    ['Checkout: unknown billing_cycle normalises to monthly', testUnknownCycleNormalisesToMonthly],
    ['Pricing: cycle toggle + billing_cycle hidden input rendered', testPricingPageIncludesCycleToggleAndHiddenInput],
    ['Settings: free user sees cycle toggle + billing_cycle input', testSettingsPageIncludesCycleToggleForFreeUsers],
    ['Settings: pro user does NOT see upgrade selector', testSettingsPageHidesUpgradeSelectorForProUsers],
    ['Modal: upgrade modal includes cycle selector + billing_cycle input', testUpgradeModalPartialIncludesCycleSelector]
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
