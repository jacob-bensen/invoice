'use strict';

/*
 * Billing settings + post-checkout integration tests.
 *
 * Covers paths absent from the existing suite:
 *  - GET  /billing/success: redirects to /dashboard after Stripe checkout
 *  - POST /billing/portal:  no stripe_customer_id → redirect to /billing/upgrade
 *  - POST /billing/portal:  valid customer → 303 to Stripe portal URL
 *  - GET  /billing/settings: renders 200 for authenticated user
 *  - POST /billing/settings: calls db.updateUser with correct fields, redirects to /billing/settings
 *  - POST /billing/settings: reply_to_email valid → persisted via updateUser
 *  - POST /billing/settings: reply_to_email blank → persisted as NULL (clearing path)
 *  - POST /billing/settings: reply_to_email malformed → error flash, no DB write
 *  - POST /billing/settings: reply_to_email > 255 chars → error flash, no DB write
 *
 * Stripe SDK and ../db are stubbed — no network calls.
 *
 * Run: node tests/billing-settings.test.js
 */

const assert = require('assert');
const path = require('path');
const express = require('express');
const session = require('express-session');
const http = require('http');

// ---------- Mutable test state ------------------------------------------

const updateUserCalls = [];

function reset() {
  updateUserCalls.length = 0;
}

// ---------- Stubs -------------------------------------------------------

let userStore = {};

const dbStub = {
  pool: { query: async () => ({ rows: [] }) },
  db: {
    async getUserById(id) { return userStore[id] || null; },
    async updateUser(id, fields) {
      updateUserCalls.push({ id, fields });
      const u = userStore[id];
      if (!u) return null;
      Object.assign(u, fields);
      return u;
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
    async create() { return { id: 'cus_new' }; },
    async retrieve() { return { metadata: { user_id: '1' } }; }
  },
  checkout: {
    sessions: {
      async create() { return { id: 'cs_test', url: 'https://checkout.stripe.com/test' }; }
    }
  },
  billingPortal: {
    sessions: {
      async create() { return { url: 'https://billing.stripe.com/portal/test' }; }
    }
  }
};

require.cache[require.resolve('stripe')] = {
  id: require.resolve('stripe'),
  filename: require.resolve('stripe'),
  loaded: true,
  exports: () => mockStripeClient
};

process.env.APP_URL = process.env.APP_URL || 'https://test.invoice.app';
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

function clearReq(mod) { delete require.cache[require.resolve(mod)]; }
clearReq('../routes/billing');
const billingRoutes = require('../routes/billing');

// ---------- App builder -------------------------------------------------

function buildApp(sessionUser) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, _res, next) => {
    if (sessionUser) req.session.user = sessionUser;
    next();
  });
  // Provide res.locals.user so EJS partials (nav.ejs) that reference `user` render correctly.
  app.use((req, res, next) => { res.locals.user = sessionUser || null; next(); });
  app.use('/billing', billingRoutes);
  return app;
}

// ---------- HTTP helper -------------------------------------------------

function request(app, method, url, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const payload = body ? new URLSearchParams(body).toString() : '';
      const headers = {};
      if (payload) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        headers['Content-Length'] = Buffer.byteLength(payload);
      }
      const req = http.request(
        { hostname: '127.0.0.1', port, path: url, method, headers },
        res => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => {
            server.close(() => resolve({ status: res.statusCode, headers: res.headers, body: data }));
          });
        }
      );
      req.on('error', err => { server.close(); reject(err); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

// ---------- Tests -------------------------------------------------------

async function testSuccessRedirectsToDashboard() {
  reset();
  userStore = {
    1: { id: 1, email: 'u@test.io', name: 'U', plan: 'pro', stripe_customer_id: 'cus_123' }
  };
  const app = buildApp({ id: 1, plan: 'free', name: 'U', email: 'u@test.io' });

  const res = await request(app, 'GET', '/billing/success');
  assert.strictEqual(res.status, 302, 'GET /billing/success must redirect');
  assert.ok(res.headers.location.includes('/dashboard'),
    'post-checkout success must redirect to /dashboard');
}

async function testPortalNoCustomerIdRedirectsToUpgrade() {
  reset();
  userStore = {
    2: { id: 2, email: 'u@test.io', name: 'U', plan: 'free', stripe_customer_id: null }
  };
  const app = buildApp({ id: 2, plan: 'free', name: 'U', email: 'u@test.io' });

  const res = await request(app, 'POST', '/billing/portal', {});
  assert.strictEqual(res.status, 302, 'portal with no customer must redirect');
  assert.ok(res.headers.location.includes('/billing/upgrade'),
    'missing stripe_customer_id must redirect to /billing/upgrade, not crash');
}

async function testPortalWithCustomerRedirectsToStripe() {
  reset();
  userStore = {
    3: { id: 3, email: 'u@test.io', name: 'U', plan: 'pro', stripe_customer_id: 'cus_real_abc' }
  };
  const app = buildApp({ id: 3, plan: 'pro', name: 'U', email: 'u@test.io' });

  const res = await request(app, 'POST', '/billing/portal', {});
  assert.strictEqual(res.status, 303, 'portal with valid customer must 303 redirect to Stripe');
  assert.ok(res.headers.location && res.headers.location.includes('billing.stripe.com'),
    'redirect must target the Stripe billing portal URL');
}

async function testSettingsPageRendersFor200() {
  reset();
  userStore = {
    4: {
      id: 4, email: 'alice@x.com', name: 'Alice', plan: 'pro',
      business_name: 'Alice Design', business_address: '1 Main St',
      business_phone: null, business_email: null,
      stripe_customer_id: 'cus_4', invoice_count: 7
    }
  };
  const app = buildApp({ id: 4, plan: 'pro', name: 'Alice', email: 'alice@x.com' });

  const res = await request(app, 'GET', '/billing/settings');
  assert.strictEqual(res.status, 200, 'GET /billing/settings must render 200 for authenticated user');
  assert.ok(res.body.includes('Settings') || res.body.includes('Account'),
    'settings page must include recognisable settings content');
}

async function testSettingsPostPersistsBusinessInfo() {
  reset();
  userStore = {
    5: {
      id: 5, email: 'bob@x.com', name: 'Bob', plan: 'free',
      business_name: null, business_address: null, business_phone: null, business_email: null
    }
  };
  const app = buildApp({ id: 5, plan: 'free', name: 'Bob', email: 'bob@x.com' });

  const res = await request(app, 'POST', '/billing/settings', {
    name: 'Bob Updated',
    business_name: 'Bob LLC',
    business_address: '123 Main St, Springfield',
    business_phone: '555-1234',
    business_email: 'billing@bob.com'
  });

  assert.strictEqual(res.status, 302, 'settings POST must redirect on success');
  assert.ok(res.headers.location.includes('/billing/settings'),
    'must redirect back to /billing/settings after saving');
  assert.ok(updateUserCalls.length >= 1, 'db.updateUser must be called');
  const call = updateUserCalls[0];
  assert.strictEqual(call.id, 5, 'must update the authenticated user, not another');
  assert.strictEqual(call.fields.name, 'Bob Updated', 'name change must be sent to db');
  assert.strictEqual(call.fields.business_name, 'Bob LLC', 'business_name must be persisted');
  assert.strictEqual(call.fields.business_address, '123 Main St, Springfield',
    'business_address must be persisted');
}

// reply_to_email validation paths — gates Pro outbound email Reply-To header.
// A bug here (accepting malformed values) would surface as Resend rejecting
// the send, breaking the Pro feature silently. A bug in the inverse direction
// (rejecting valid values) blocks the user from configuring the feature.

async function testSettingsPostReplyToValid() {
  reset();
  userStore = {
    6: {
      id: 6, email: 'carol@x.com', name: 'Carol', plan: 'pro',
      business_name: 'Carol Co', reply_to_email: null
    }
  };
  const app = buildApp({ id: 6, plan: 'pro', name: 'Carol', email: 'carol@x.com' });

  const res = await request(app, 'POST', '/billing/settings', {
    name: 'Carol',
    business_name: 'Carol Co',
    reply_to_email: 'invoices@carol.studio'
  });

  assert.strictEqual(res.status, 302, 'valid reply_to_email must redirect on success');
  assert.ok(res.headers.location.includes('/billing/settings'),
    'must redirect back to /billing/settings after saving');
  assert.strictEqual(updateUserCalls.length, 1, 'db.updateUser must be called exactly once');
  assert.strictEqual(updateUserCalls[0].fields.reply_to_email, 'invoices@carol.studio',
    'valid reply_to_email must be persisted verbatim');
}

async function testSettingsPostReplyToBlankClearsField() {
  reset();
  userStore = {
    7: {
      id: 7, email: 'dan@x.com', name: 'Dan', plan: 'pro',
      reply_to_email: 'old@dan.io'
    }
  };
  const app = buildApp({ id: 7, plan: 'pro', name: 'Dan', email: 'dan@x.com' });

  const res = await request(app, 'POST', '/billing/settings', {
    name: 'Dan',
    business_name: '',
    reply_to_email: '   '   // whitespace-only must trim to empty → null
  });

  assert.strictEqual(res.status, 302, 'blank reply_to_email must succeed (clearing path)');
  assert.strictEqual(updateUserCalls.length, 1, 'db.updateUser must be called');
  assert.strictEqual(updateUserCalls[0].fields.reply_to_email, null,
    'whitespace-only reply_to_email must be persisted as NULL (lets Pro user clear the field)');
}

async function testSettingsPostReplyToMalformedRejected() {
  reset();
  userStore = {
    8: {
      id: 8, email: 'eve@x.com', name: 'Eve', plan: 'pro',
      reply_to_email: 'safe@eve.com'
    }
  };
  const app = buildApp({ id: 8, plan: 'pro', name: 'Eve', email: 'eve@x.com' });

  const res = await request(app, 'POST', '/billing/settings', {
    name: 'Eve',
    business_name: 'Eve LLC',
    reply_to_email: 'not-an-email'
  });

  assert.strictEqual(res.status, 302, 'malformed reply_to_email must redirect (with error flash)');
  assert.ok(res.headers.location.includes('/billing/settings'),
    'must redirect back to settings page so the user sees the error flash');
  assert.strictEqual(updateUserCalls.length, 0,
    'malformed reply_to_email must NOT trigger a db.updateUser call ' +
    '(prevents corrupt Reply-To header from landing on outbound mail)');
}

async function testSettingsPostReplyToTooLongRejected() {
  reset();
  userStore = {
    9: {
      id: 9, email: 'frank@x.com', name: 'Frank', plan: 'pro',
      reply_to_email: null
    }
  };
  const app = buildApp({ id: 9, plan: 'pro', name: 'Frank', email: 'frank@x.com' });

  // Construct a >255-char address that still passes the regex shape check
  // (local@host.tld) so the test isolates the length guard.
  const longLocal = 'a'.repeat(260);
  const longEmail = `${longLocal}@x.io`; // 260 + "@x.io" = 265 chars
  assert.ok(longEmail.length > 255, 'fixture must be > 255 chars to trigger length guard');

  const res = await request(app, 'POST', '/billing/settings', {
    name: 'Frank',
    business_name: 'Frank Co',
    reply_to_email: longEmail
  });

  assert.strictEqual(res.status, 302, 'over-length reply_to_email must redirect (with error flash)');
  assert.strictEqual(updateUserCalls.length, 0,
    'over-length reply_to_email must NOT trigger a db.updateUser call ' +
    '(DB column is VARCHAR(255); writing > 255 chars would crash the Postgres insert)');
}

// ---------- Runner ------------------------------------------------------

async function run() {
  const tests = [
    ['GET /billing/success: redirects to /dashboard after Stripe checkout', testSuccessRedirectsToDashboard],
    ['POST /billing/portal: no stripe_customer_id → 302 to /billing/upgrade', testPortalNoCustomerIdRedirectsToUpgrade],
    ['POST /billing/portal: valid customer → 303 to Stripe billing portal', testPortalWithCustomerRedirectsToStripe],
    ['GET /billing/settings: renders 200 for authenticated user', testSettingsPageRendersFor200],
    ['POST /billing/settings: saves business info + redirects to /billing/settings', testSettingsPostPersistsBusinessInfo],
    ['POST /billing/settings: valid reply_to_email is persisted verbatim', testSettingsPostReplyToValid],
    ['POST /billing/settings: blank/whitespace reply_to_email persists as NULL', testSettingsPostReplyToBlankClearsField],
    ['POST /billing/settings: malformed reply_to_email is rejected (no DB write)', testSettingsPostReplyToMalformedRejected],
    ['POST /billing/settings: > 255-char reply_to_email is rejected (length guard)', testSettingsPostReplyToTooLongRejected]
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
