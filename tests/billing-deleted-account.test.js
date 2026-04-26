'use strict';

/*
 * Coverage gap closer (Test Examiner cycle 2026-04-26 PM):
 *
 *   The H7 health audit (CHANGELOG 2026-04-24 PM) added `if (!user) return
 *   res.redirect('/auth/login')` guards to `routes/billing.js` so a session
 *   carrying a deleted-account user_id no longer triggers a 500 by
 *   dereferencing `null.stripe_customer_id` / `null.plan`. The fix shipped
 *   without dedicated regression tests — the audit note explicitly deferred
 *   them ("adding billing-side regression tests is folded into H11 below").
 *   H11 has not yet landed and the deferred tests are still missing.
 *
 *   This file closes the gap directly: each guard must produce a clean
 *   302 redirect to /auth/login (NOT a 500) when db.getUserById returns
 *   null. Income-critical because every covered route is on the
 *   subscription-upgrade hot path.
 */

const assert = require('assert');
const express = require('express');
const http = require('http');

function clearReq(mod) { delete require.cache[require.resolve(mod)]; }

// ---------- DB stub ---------------------------------------------------------

const userStore = {};

const dbStub = {
  pool: { query: async () => ({ rows: [] }) },
  db: {
    async getUserById(id) { return userStore[id] || null; },
    async updateUser(id, fields) {
      const u = userStore[id];
      if (!u) return null;
      Object.assign(u, fields);
      return u;
    },
    async getUserByEmail() { return null; },
    async createUser() { throw new Error('not used'); },
    async markInvoicePaidByPaymentLinkId() { return null; }
  }
};

require.cache[require.resolve('../db')] = {
  id: require.resolve('../db'),
  filename: require.resolve('../db'),
  loaded: true,
  exports: dbStub
};

// Stub Stripe so we can prove the route returns BEFORE any Stripe call
// would have been made (which would have crashed with `null.stripe_customer_id`
// before the H7 fix).
const stripeCalls = [];
require.cache[require.resolve('stripe')] = {
  id: require.resolve('stripe'),
  filename: require.resolve('stripe'),
  loaded: true,
  exports: () => ({
    customers: {
      create: async (...a) => { stripeCalls.push(['customers.create', a]); return { id: 'cus_X' }; },
      retrieve: async () => ({ metadata: {} })
    },
    checkout: { sessions: { create: async (...a) => { stripeCalls.push(['checkout.create', a]); return { url: 'https://stripe.test/session' }; } } },
    billingPortal: { sessions: { create: async (...a) => { stripeCalls.push(['portal.create', a]); return { url: 'https://stripe.test/portal' }; } } },
    webhooks: { constructEvent: () => ({ type: 'noop' }) },
    subscriptions: { retrieve: async () => ({ trial_end: null }) }
  })
};

clearReq('../routes/billing');
const billingRoutes = require('../routes/billing');

// ---------- Test harness ----------------------------------------------------

function buildApp(sessionUser) {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { user: sessionUser };
    next();
  });
  app.use('/billing', billingRoutes);
  return app;
}

function request(app, method, url, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const payload = body ? new URLSearchParams(body).toString() : '';
      const req = http.request({
        hostname: '127.0.0.1', port, path: url, method,
        headers: body
          ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(payload) }
          : {}
      }, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, headers: res.headers, body: data }); });
      });
      req.on('error', err => { server.close(); reject(err); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

function reset() {
  for (const k of Object.keys(userStore)) delete userStore[k];
  stripeCalls.length = 0;
}

// ---------- Tests -----------------------------------------------------------

async function testCreateCheckoutDeletedAccountRedirects() {
  reset();
  // Session refers to user_id 99 but DB has no such row — simulates a
  // session carrying a deleted-account id.
  const app = buildApp({ id: 99, plan: 'free' });
  const res = await request(app, 'POST', '/billing/create-checkout', { billing_cycle: 'monthly' });

  assert.strictEqual(res.status, 302, 'must redirect, not 500');
  assert.strictEqual(res.headers.location, '/auth/login',
    'deleted-account session must be bounced to login');
  assert.strictEqual(stripeCalls.length, 0,
    'must NOT touch Stripe before the null-user guard fires');
}

async function testGetSuccessDeletedAccountRedirects() {
  reset();
  const app = buildApp({ id: 99, plan: 'free' });
  const res = await request(app, 'GET', '/billing/success?session_id=cs_test');

  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.location, '/auth/login',
    'deleted-account /billing/success must redirect to login (no null.plan deref)');
}

async function testPostPortalDeletedAccountRedirects() {
  reset();
  const app = buildApp({ id: 99, plan: 'free' });
  const res = await request(app, 'POST', '/billing/portal', {});

  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.location, '/auth/login',
    'deleted-account /billing/portal must redirect to login (no null.stripe_customer_id deref)');
  assert.strictEqual(stripeCalls.length, 0,
    'must NOT touch Stripe billingPortal API before the null-user guard fires');
}

async function testCreateCheckoutValidUserStillWorks() {
  // Regression guard: the null-user guards must not break the happy path.
  reset();
  userStore[42] = {
    id: 42, email: 'real@x.com', name: 'Real', plan: 'free',
    stripe_customer_id: 'cus_existing'
  };
  const app = buildApp({ id: 42, plan: 'free' });
  const res = await request(app, 'POST', '/billing/create-checkout', { billing_cycle: 'monthly' });

  assert.strictEqual(res.status, 303, 'happy path must reach Stripe (303 to checkout.url)');
  assert.ok(stripeCalls.some(([n]) => n === 'checkout.create'),
    'happy path must reach checkout.sessions.create');
}

// ---------- Runner ----------------------------------------------------------

async function run() {
  const tests = [
    ['POST /billing/create-checkout: deleted-account session → /auth/login (no Stripe call)', testCreateCheckoutDeletedAccountRedirects],
    ['GET /billing/success: deleted-account session → /auth/login', testGetSuccessDeletedAccountRedirects],
    ['POST /billing/portal: deleted-account session → /auth/login (no Stripe call)', testPostPortalDeletedAccountRedirects],
    ['POST /billing/create-checkout: valid user reaches Stripe (regression guard)', testCreateCheckoutValidUserStillWorks]
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
