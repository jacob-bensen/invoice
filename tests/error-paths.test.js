'use strict';

/*
 * Error-path and edge-case tests for income-critical routes.
 *
 * Covers untested failure and boundary paths:
 *  - POST /billing/create-checkout  Stripe error → flash + redirect to /billing/upgrade
 *  - POST /billing/create-checkout  no stripe_customer_id → auto-creates customer, saves to DB
 *  - POST /billing/portal           Stripe error → redirect to /dashboard (no crash)
 *  - POST /billing/settings         db.updateUser throws → flash error + redirect
 *  - POST /auth/register            db.createUser throws → renders "Something went wrong"
 *  - POST /auth/login               db.getUserByEmail throws → renders "Something went wrong"
 *  - Webhook: checkout.session.completed subscription, customer.metadata.user_id missing
 *             → db.updateUser must NOT be called (prevents NaN user-id writes)
 *
 * Stripe SDK and ../db are stubbed — no real network calls.
 *
 * Run: node tests/error-paths.test.js
 */

const assert = require('assert');
const path = require('path');
const express = require('express');
const session = require('express-session');
const http = require('http');

// ---------- Mutable test state ------------------------------------------

const updateUserCalls = [];
const customerCreateCalls = [];
const checkoutSessionCalls = [];

function reset() {
  updateUserCalls.length = 0;
  customerCreateCalls.length = 0;
  checkoutSessionCalls.length = 0;
}

// ---------- Shared per-test control flags --------------------------------

let stripeCheckoutShouldThrow = false;
let stripePortalShouldThrow = false;
let dbUpdateUserShouldThrow = false;
let dbGetUserByEmailShouldThrow = false;
let dbCreateUserShouldThrow = false;
let stripeConstructEventImpl = null;

// ---------- DB Stub (billing) -------------------------------------------

let billingUserStore = {};

const billingDbStub = {
  pool: { query: async () => ({ rows: [] }) },
  db: {
    async getUserById(id) { return billingUserStore[id] || null; },
    async updateUser(id, fields) {
      if (dbUpdateUserShouldThrow) throw new Error('DB write error');
      updateUserCalls.push({ id, fields });
      const u = billingUserStore[id];
      if (!u) return null;
      Object.assign(u, fields);
      return u;
    },
    async markInvoicePaidByPaymentLinkId() { return null; }
  }
};

// ---------- Stripe Stub (billing) ----------------------------------------

const mockStripeClient = {
  webhooks: {
    constructEvent(body, sig, secret) {
      if (!stripeConstructEventImpl) throw new Error('constructEventImpl not set');
      return stripeConstructEventImpl(body, sig, secret);
    }
  },
  customers: {
    async create(params) {
      customerCreateCalls.push(params);
      return { id: 'cus_brand_new' };
    },
    async retrieve() { return { metadata: {} }; } // no user_id by default
  },
  checkout: {
    sessions: {
      async create(params) {
        if (stripeCheckoutShouldThrow) throw new Error('Stripe API error');
        checkoutSessionCalls.push(params);
        return { id: 'cs_test', url: 'https://checkout.stripe.com/pay/test' };
      }
    }
  },
  billingPortal: {
    sessions: {
      async create(params) {
        if (stripePortalShouldThrow) throw new Error('Portal unavailable');
        return { url: 'https://billing.stripe.com/portal/test' };
      }
    }
  }
};

require.cache[require.resolve('../db')] = {
  id: require.resolve('../db'),
  filename: require.resolve('../db'),
  loaded: true,
  exports: billingDbStub
};

require.cache[require.resolve('stripe')] = {
  id: require.resolve('stripe'),
  filename: require.resolve('stripe'),
  loaded: true,
  exports: () => mockStripeClient
};

process.env.STRIPE_PRO_PRICE_ID = 'price_monthly_TEST';
process.env.APP_URL = 'https://test.invoice.app';
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';

function clearReq(mod) { delete require.cache[require.resolve(mod)]; }

// ---------- Load billing routes -----------------------------------------

clearReq('../routes/billing');
const billingRoutes = require('../routes/billing');

// ---------- App builders ------------------------------------------------

function buildBillingApp(sessionUser) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use('/billing/webhook', express.raw({ type: 'application/json' }));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, _res, next) => {
    if (sessionUser) req.session.user = sessionUser;
    next();
  });
  app.use((req, res, next) => { res.locals.user = sessionUser || null; next(); });
  app.use('/billing', billingRoutes);
  return app;
}

// ---------- HTTP helper (form body) -------------------------------------

function request(app, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const payload = body ? new URLSearchParams(body).toString() : '';
      const headers = payload
        ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(payload) }
        : {};
      const req = http.request(
        { hostname: '127.0.0.1', port, path: urlPath, method, headers },
        res => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => server.close(() => resolve({ status: res.statusCode, headers: res.headers, body: data })));
        }
      );
      req.on('error', err => { server.close(); reject(err); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

function webhookRequest(app, body, sig) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const bodyBuf = Buffer.from(JSON.stringify(body));
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

// ---------- Auth stubs + app --------------------------------------------

let authUsersByEmail = {};
let authUsersById = {};

// bcrypt stub (re-use same approach as auth.test.js).
require.cache[require.resolve('bcrypt')] = {
  id: require.resolve('bcrypt'),
  filename: require.resolve('bcrypt'),
  loaded: true,
  exports: {
    hash: async (pw) => `hashed:${pw}`,
    compare: async (pw, hash) => hash === `hashed:${pw}`
  }
};

const authDbStub = {
  db: {
    async getUserByEmail(email) {
      if (dbGetUserByEmailShouldThrow) throw new Error('DB connection lost');
      return authUsersByEmail[email] || null;
    },
    async getUserById(id) { return authUsersById[id] || null; },
    async createUser({ email, password_hash, name }) {
      if (dbCreateUserShouldThrow) throw new Error('DB insert error');
      const user = { id: 999, email, password_hash, name, plan: 'free', invoice_count: 0 };
      authUsersByEmail[email] = user;
      authUsersById[999] = user;
      return user;
    },
    async updateUser() { return null; }
  },
  pool: { query: async () => ({ rows: [] }) }
};

// Auth routes need their own db stub load.
// We load them separately after swapping the cached module.
require.cache[require.resolve('../db')] = {
  id: require.resolve('../db'),
  filename: require.resolve('../db'),
  loaded: true,
  exports: authDbStub
};

clearReq('../routes/auth');
const authRoutes = require('../routes/auth');

function buildAuthApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, res, next) => { res.locals.user = null; next(); });
  app.use('/auth', authRoutes);
  return app;
}

// Restore billing db stub for billing tests after auth routes loaded.
require.cache[require.resolve('../db')] = {
  id: require.resolve('../db'),
  filename: require.resolve('../db'),
  loaded: true,
  exports: billingDbStub
};

// ---------- Tests -------------------------------------------------------

// POST /billing/create-checkout — Stripe error: route must flash and redirect, not crash.
async function testCheckoutStripeErrorRedirectsToUpgrade() {
  reset();
  stripeCheckoutShouldThrow = true;
  billingUserStore = {
    1: { id: 1, email: 'u@x.com', name: 'U', plan: 'free', stripe_customer_id: 'cus_exists' }
  };
  const app = buildBillingApp({ id: 1 });

  const res = await request(app, 'POST', '/billing/create-checkout', { billing_cycle: 'monthly' });
  stripeCheckoutShouldThrow = false;

  assert.strictEqual(res.status, 302,
    'Stripe checkout error must redirect (302), not throw an unhandled 500');
  assert.ok(res.headers.location && res.headers.location.includes('/billing/upgrade'),
    'on Stripe error the user must be redirected back to /billing/upgrade');
}

// POST /billing/create-checkout — new user (no stripe_customer_id): customer is auto-created
// and the new ID is saved to the DB before checkout proceeds.
async function testCheckoutAutoCreatesStripeCustomer() {
  reset();
  stripeCheckoutShouldThrow = false;
  billingUserStore = {
    2: { id: 2, email: 'new@x.com', name: 'New User', plan: 'free', stripe_customer_id: null }
  };
  const app = buildBillingApp({ id: 2 });

  const res = await request(app, 'POST', '/billing/create-checkout', { billing_cycle: 'monthly' });

  // A new Stripe customer must have been created.
  assert.strictEqual(customerCreateCalls.length, 1,
    'stripe.customers.create must be called when user has no stripe_customer_id');
  assert.strictEqual(customerCreateCalls[0].email, 'new@x.com',
    'new customer must be created with the user\'s email');

  // The new customer ID must be saved to the DB.
  const savedCustomer = updateUserCalls.find(c => c.fields.stripe_customer_id === 'cus_brand_new');
  assert.ok(savedCustomer,
    'db.updateUser must be called with the new stripe_customer_id so future checkouts skip creation');
  assert.strictEqual(savedCustomer.id, 2, 'must update the correct user');

  // Checkout must proceed to Stripe.
  assert.strictEqual(res.status, 303, 'after customer creation checkout must redirect 303 to Stripe');
  assert.ok(checkoutSessionCalls.length >= 1, 'stripe.checkout.sessions.create must be called');
}

// POST /billing/portal — Stripe portal throws: must redirect to /dashboard, not crash.
async function testPortalStripeErrorRedirectsToDashboard() {
  reset();
  stripePortalShouldThrow = true;
  billingUserStore = {
    3: { id: 3, email: 'u@x.com', name: 'U', plan: 'pro', stripe_customer_id: 'cus_valid' }
  };
  const app = buildBillingApp({ id: 3 });

  const res = await request(app, 'POST', '/billing/portal', {});
  stripePortalShouldThrow = false;

  assert.strictEqual(res.status, 302,
    'Stripe portal error must redirect (302), not produce an unhandled 500');
  assert.ok(res.headers.location && res.headers.location.includes('/dashboard'),
    'on Stripe portal error the user must be redirected to /dashboard');
}

// POST /billing/settings — db.updateUser throws: must flash error and redirect, not crash.
async function testSettingsDbErrorFlashesAndRedirects() {
  reset();
  dbUpdateUserShouldThrow = true;
  billingUserStore = {
    4: { id: 4, email: 'u@x.com', name: 'U', plan: 'free' }
  };
  const app = buildBillingApp({ id: 4, plan: 'free', name: 'U', email: 'u@x.com' });

  const res = await request(app, 'POST', '/billing/settings', {
    name: 'Updated Name',
    business_name: 'My Co'
  });
  dbUpdateUserShouldThrow = false;

  assert.strictEqual(res.status, 302,
    'settings save error must redirect (302), not throw an unhandled 500');
  assert.ok(res.headers.location && res.headers.location.includes('/billing/settings'),
    'on settings save error the user must be redirected back to /billing/settings');
}

// POST /auth/register — db.createUser throws: route must render "Something went wrong", not crash.
async function testRegisterDbErrorRendersGracefully() {
  authUsersByEmail = {};
  authUsersById = {};
  dbCreateUserShouldThrow = true;
  dbGetUserByEmailShouldThrow = false;

  // Restore auth db stub.
  require.cache[require.resolve('../db')] = {
    id: require.resolve('../db'),
    filename: require.resolve('../db'),
    loaded: true,
    exports: authDbStub
  };

  const app = buildAuthApp();

  const res = await request(app, 'POST', '/auth/register', {
    name: 'Alice',
    email: 'alice@x.com',
    password: 'password123'
  });
  dbCreateUserShouldThrow = false;

  // Restore billing db stub.
  require.cache[require.resolve('../db')] = {
    id: require.resolve('../db'),
    filename: require.resolve('../db'),
    loaded: true,
    exports: billingDbStub
  };

  assert.strictEqual(res.status, 200,
    'DB error on register must re-render the form (200), not crash with 500');
  assert.ok(
    res.body.includes('wrong') || res.body.includes('error') ||
    res.body.includes('Error') || res.body.includes('again'),
    'rendered page must contain an error message when registration fails'
  );
}

// POST /auth/login — db.getUserByEmail throws: route must render gracefully, not crash.
async function testLoginDbErrorRendersGracefully() {
  authUsersByEmail = {};
  authUsersById = {};
  dbGetUserByEmailShouldThrow = true;

  require.cache[require.resolve('../db')] = {
    id: require.resolve('../db'),
    filename: require.resolve('../db'),
    loaded: true,
    exports: authDbStub
  };

  const app = buildAuthApp();

  const res = await request(app, 'POST', '/auth/login', {
    email: 'anyone@x.com',
    password: 'anypassword1'
  });
  dbGetUserByEmailShouldThrow = false;

  require.cache[require.resolve('../db')] = {
    id: require.resolve('../db'),
    filename: require.resolve('../db'),
    loaded: true,
    exports: billingDbStub
  };

  assert.strictEqual(res.status, 200,
    'DB error on login must re-render the login form (200), not crash with 500');
  assert.ok(
    res.body.includes('wrong') || res.body.includes('error') ||
    res.body.includes('Error') || res.body.includes('again'),
    'rendered page must contain an error message when login DB lookup fails'
  );
}

// Webhook: checkout.session.completed subscription mode, customer has no user_id metadata.
// db.updateUser must NOT be called — prevents a write with parseInt(undefined) = NaN.
async function testWebhookMissingUserIdSkipsDbUpdate() {
  reset();
  stripeCheckoutShouldThrow = false;

  // Customer retrieve returns empty metadata (no user_id).
  const savedRetrieve = mockStripeClient.customers.retrieve;
  mockStripeClient.customers.retrieve = async () => ({ metadata: {} });

  const event = {
    type: 'checkout.session.completed',
    data: { object: { mode: 'subscription', customer: 'cus_no_meta', subscription: 'sub_xyz' } }
  };
  stripeConstructEventImpl = () => event;

  // Use the billing routes that were loaded against billingDbStub.
  const app = buildBillingApp(null);

  const res = await webhookRequest(app, event);
  assert.strictEqual(res.status, 200, 'webhook must still return 200 even with missing user_id');

  // Give async handler a tick to complete.
  await new Promise(r => setImmediate(r));

  const planUpdateCall = updateUserCalls.find(c => c.fields && c.fields.plan === 'pro');
  assert.ok(!planUpdateCall,
    'db.updateUser with plan=pro must NOT be called when customer metadata has no user_id ' +
    '(prevents overwriting a random/NaN user record)');

  // Restore.
  mockStripeClient.customers.retrieve = savedRetrieve;
  stripeConstructEventImpl = null;
}

// ---------- Runner ------------------------------------------------------

async function run() {
  const tests = [
    ['Checkout: Stripe error → flash + redirect to /billing/upgrade (no crash)', testCheckoutStripeErrorRedirectsToUpgrade],
    ['Checkout: no stripe_customer_id → auto-creates customer and saves ID to DB', testCheckoutAutoCreatesStripeCustomer],
    ['Portal: Stripe error → redirect to /dashboard (no crash)', testPortalStripeErrorRedirectsToDashboard],
    ['Settings: db.updateUser error → flash error + redirect to /billing/settings', testSettingsDbErrorFlashesAndRedirects],
    ['Register: db.createUser throws → renders error gracefully (no 500)', testRegisterDbErrorRendersGracefully],
    ['Login: db.getUserByEmail throws → renders error gracefully (no 500)', testLoginDbErrorRendersGracefully],
    ['Webhook: checkout subscription with missing customer user_id → no db.updateUser call', testWebhookMissingUserIdSkipsDbUpdate]
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
