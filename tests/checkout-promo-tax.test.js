'use strict';

/*
 * Stripe Checkout — promotion codes + automatic tax tests (INTERNAL_TODO #35).
 *
 * Covers:
 *  - allow_promotion_codes is always true (unlocks every coupon Master creates)
 *  - automatic_tax.enabled reflects the STRIPE_AUTOMATIC_TAX_ENABLED env var
 *  - When automatic_tax is enabled, customer_update.address/name are set 'auto'
 *  - In test env (no env var) Stripe Tax is DISABLED and customer_update is absent
 *  - Promo + tax flags ride alongside the existing trial_period_days:7 (no regression)
 *
 * Stripe and ../db are stubbed — no real network calls.
 *
 * Run: NODE_ENV=test node tests/checkout-promo-tax.test.js
 */

const assert = require('assert');
const express = require('express');
const session = require('express-session');
const http = require('http');

// ---------- Mutable test state ------------------------------------------

const checkoutSessionCalls = [];

function reset() {
  checkoutSessionCalls.length = 0;
}

// ---------- Stubs -------------------------------------------------------

const dbStub = {
  pool: { query: async () => ({ rows: [] }) },
  db: {
    async getUserById(id) {
      return { id, email: 'u@test.io', name: 'U', plan: 'free', stripe_customer_id: 'cus_existing' };
    },
    async updateUser(id, fields) { return { id, ...fields }; },
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
  webhooks: { constructEvent: () => { throw new Error('not used'); } },
  customers: {
    async create() { return { id: 'cus_new' }; },
    async retrieve() { return { metadata: { user_id: '1' } }; }
  },
  checkout: {
    sessions: {
      async create(params) {
        checkoutSessionCalls.push(params);
        return { id: 'cs_test', url: 'https://checkout.stripe.com/test' };
      }
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

// Important: clear the env var before loading billing routes so the default
// "tax disabled" behaviour is exercised. Tests that need it on flip the var
// per-call (the route reads process.env at request time, not at load time).
delete process.env.STRIPE_AUTOMATIC_TAX_ENABLED;

function clearReq(mod) { delete require.cache[require.resolve(mod)]; }
clearReq('../routes/billing');
const billingRoutes = require('../routes/billing');

// ---------- App builder + HTTP helper -----------------------------------

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

function post(app, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const bodyStr = new URLSearchParams(body || {}).toString();
      const req = http.request(
        {
          hostname: '127.0.0.1', port, path: '/billing/create-checkout', method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(bodyStr)
          }
        },
        res => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => { server.close(() => resolve({ status: res.statusCode, body: data })); });
        }
      );
      req.on('error', err => { server.close(); reject(err); });
      req.write(bodyStr);
      req.end();
    });
  });
}

// ---------- Tests -------------------------------------------------------

async function testAllowPromotionCodesAlwaysTrue() {
  // Promotion codes are unconditionally enabled — no env gate, no per-cycle
  // toggle. Every Stripe Checkout the app launches must surface the "Add
  // promotion code" link so any coupon Master creates is reachable.
  reset();
  const app = buildApp({ id: 1 });
  const res = await post(app, {});
  assert.strictEqual(res.status, 303, 'checkout should 303 redirect to Stripe');
  assert.strictEqual(checkoutSessionCalls.length, 1);
  const call = checkoutSessionCalls[0];
  assert.strictEqual(call.allow_promotion_codes, true,
    'allow_promotion_codes must be true so coupon flows (PH50, AppSumo, newsletter, agency cold email) work');
}

async function testAllowPromotionCodesOnAnnualToo() {
  // Defence in depth: the annual cycle takes a different code branch (the
  // resolvePriceId call); confirm the promo flag rides through unchanged.
  reset();
  const app = buildApp({ id: 2 });
  const res = await post(app, { billing_cycle: 'annual' });
  assert.strictEqual(res.status, 303);
  const call = checkoutSessionCalls[0];
  assert.strictEqual(call.allow_promotion_codes, true,
    'annual cycle must also surface promotion codes');
  assert.strictEqual(call.line_items[0].price, 'price_annual_TEST',
    'sanity: annual price still selected');
}

async function testAutomaticTaxDisabledByDefault() {
  // Without STRIPE_AUTOMATIC_TAX_ENABLED set (the default until Master
  // activates Stripe Tax in the Dashboard), automatic_tax.enabled is false
  // and customer_update is NOT sent — Stripe rejects customer_update on
  // sessions where automatic_tax is off, so omitting it is required.
  reset();
  delete process.env.STRIPE_AUTOMATIC_TAX_ENABLED;
  const app = buildApp({ id: 3 });
  const res = await post(app, {});
  assert.strictEqual(res.status, 303);
  const call = checkoutSessionCalls[0];
  assert.ok(call.automatic_tax, 'automatic_tax param must be set');
  assert.strictEqual(call.automatic_tax.enabled, false,
    'automatic_tax must default to disabled when env var is unset');
  assert.strictEqual(call.customer_update, undefined,
    'customer_update must be omitted when automatic_tax is disabled (Stripe rejects it otherwise)');
}

async function testAutomaticTaxEnabledViaEnvVar() {
  // When Master flips STRIPE_AUTOMATIC_TAX_ENABLED=true (after activating
  // Stripe Tax in the Dashboard), the flag rides through and the required
  // customer_update.address='auto' + customer_update.name='auto' are sent.
  reset();
  process.env.STRIPE_AUTOMATIC_TAX_ENABLED = 'true';
  try {
    const app = buildApp({ id: 4 });
    const res = await post(app, {});
    assert.strictEqual(res.status, 303);
    const call = checkoutSessionCalls[0];
    assert.strictEqual(call.automatic_tax.enabled, true,
      'STRIPE_AUTOMATIC_TAX_ENABLED=true must enable automatic_tax');
    assert.deepStrictEqual(call.customer_update, { address: 'auto', name: 'auto' },
      'customer_update must capture address+name auto for tax-jurisdiction lookup');
  } finally {
    delete process.env.STRIPE_AUTOMATIC_TAX_ENABLED;
  }
}

async function testAutomaticTaxOnlyAcceptsLiteralTrue() {
  // Defensive check: the env-var value must be the literal string "true".
  // "TRUE", "1", "yes" are NOT honoured — those would silently break the
  // "off by default" property if a future ops mistake sets a typo'd value.
  reset();
  process.env.STRIPE_AUTOMATIC_TAX_ENABLED = '1';
  try {
    const app = buildApp({ id: 5 });
    const res = await post(app, {});
    assert.strictEqual(res.status, 303);
    const call = checkoutSessionCalls[0];
    assert.strictEqual(call.automatic_tax.enabled, false,
      '"1" must NOT enable automatic_tax — only the literal "true" string flips it');
  } finally {
    delete process.env.STRIPE_AUTOMATIC_TAX_ENABLED;
  }
}

async function testTrialAndPromoCoexist() {
  // Regression guard: the trial_period_days:7 setting from #19 must coexist
  // with the new allow_promotion_codes + automatic_tax fields. A future edit
  // that drops one shouldn't go unnoticed.
  reset();
  const app = buildApp({ id: 6 });
  const res = await post(app, {});
  assert.strictEqual(res.status, 303);
  const call = checkoutSessionCalls[0];
  assert.ok(call.subscription_data, 'subscription_data must still be set');
  assert.strictEqual(call.subscription_data.trial_period_days, 7,
    '7-day trial must coexist with promo codes and automatic_tax');
  assert.strictEqual(call.allow_promotion_codes, true,
    'allow_promotion_codes must coexist with trial_period_days');
  assert.strictEqual(call.mode, 'subscription', 'must remain a recurring subscription');
}

// ---------- Runner ------------------------------------------------------

async function run() {
  const tests = [
    ['Checkout: allow_promotion_codes is always true', testAllowPromotionCodesAlwaysTrue],
    ['Checkout: allow_promotion_codes also true on annual cycle', testAllowPromotionCodesOnAnnualToo],
    ['Checkout: automatic_tax disabled by default + no customer_update', testAutomaticTaxDisabledByDefault],
    ['Checkout: STRIPE_AUTOMATIC_TAX_ENABLED=true enables tax + customer_update', testAutomaticTaxEnabledViaEnvVar],
    ['Checkout: only literal "true" enables automatic_tax', testAutomaticTaxOnlyAcceptsLiteralTrue],
    ['Checkout: trial + promo + tax-flag coexist (regression guard)', testTrialAndPromoCoexist]
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
