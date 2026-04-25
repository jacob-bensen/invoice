'use strict';

/*
 * Checkout (new-customer path) + /billing/success session refresh +
 * POST /billing/webhook-url CRUD + invoice delete success-path tests.
 *
 * Paths covered (8 new assertions, 0 previously in suite):
 *
 *  1. POST /billing/create-checkout — no existing stripe_customer_id:
 *       creates Stripe customer, stores customer_id in DB via db.updateUser,
 *       passes the new customer_id to checkout.sessions.create, 303-redirects
 *       to the Stripe checkout URL. This is the first-time subscriber path —
 *       every new paying user exercises this branch exactly once.
 *
 *  2. GET /billing/success — session plan refreshed from DB:
 *       after the Stripe webhook runs and writes plan='pro' to the DB, the
 *       user lands on /billing/success. The route fetches the fresh DB row and
 *       writes plan:'pro' back to req.session.user so the user sees Pro
 *       features on the very next request without logging out and back in.
 *       Verified via a sequential-request / cookie-jar approach identical to
 *       the auth.test.js session tests.
 *
 *  3. POST /billing/webhook-url — free plan gate:
 *       a free-plan user must be rejected with an error flash and no DB write.
 *
 *  4. POST /billing/webhook-url — agency plan passes gate:
 *       agency is a superset of Pro; webhook URLs must be accepted.
 *
 *  5. POST /billing/webhook-url — valid URL saved:
 *       Pro user + URL that passes isValidWebhookUrl → db.updateUser called
 *       with the exact trimmed URL, success flash, redirect.
 *
 *  6. POST /billing/webhook-url — empty body clears webhook:
 *       whitespace-only URL → db.updateUser(id, { webhook_url: null }),
 *       "Webhook removed." flash, redirect.
 *
 *  7. POST /billing/webhook-url — invalid URL rejected (SSRF defence):
 *       URL that fails isValidWebhookUrl (e.g. cloud metadata endpoint) →
 *       error flash, no DB write.
 *
 *  8. POST /invoices/:id/delete — owner success path:
 *       owner deletes their own invoice → db.deleteInvoice called, invoice
 *       removed from store, redirect to /dashboard.
 *
 * All external I/O (Stripe, pg, DNS) is stubbed — no network calls.
 *
 * Run: node tests/checkout-and-webhook-url.test.js
 */

const assert = require('assert');
const path = require('path');
const express = require('express');
const session = require('express-session');
const http = require('http');

function clearReq(mod) { delete require.cache[require.resolve(mod)]; }

// ── Mutable test state ────────────────────────────────────────────────────

const updateUserCalls = [];
const customerCreateCalls = [];
const checkoutCreateCalls = [];
let isValidWebhookUrlImpl = async () => true;
let userById = {};    // id → user record (number key)
const invoiceStore = {};  // id → invoice record

function reset() {
  updateUserCalls.length = 0;
  customerCreateCalls.length = 0;
  checkoutCreateCalls.length = 0;
  isValidWebhookUrlImpl = async () => true;
  Object.keys(userById).forEach(k => delete userById[k]);
  Object.keys(invoiceStore).forEach(k => delete invoiceStore[k]);
}

// ── Stubs ─────────────────────────────────────────────────────────────────

const dbStub = {
  pool: { query: async () => ({ rows: [] }) },
  db: {
    async getUserById(id) {
      // Accept both numeric and string IDs (express-session may coerce).
      return userById[id] !== undefined ? userById[id]
           : (userById[parseInt(id, 10)] || null);
    },
    async updateUser(id, fields) {
      updateUserCalls.push({ id, fields });
      const numId = typeof id === 'string' ? parseInt(id, 10) : id;
      const u = userById[numId];
      if (u) Object.assign(u, fields);
      return userById[numId] || null;
    },
    async markInvoicePaidByPaymentLinkId() { return null; },
    async getInvoicesByUser() { return []; },
    async getNextInvoiceNumber() { return 'INV-2026-0001'; },
    async getInvoiceById(id, userId) {
      const inv = invoiceStore[parseInt(id, 10)];
      if (!inv || inv.user_id !== userId) return null;
      return inv;
    },
    async deleteInvoice(id, userId) {
      const inv = invoiceStore[parseInt(id, 10)];
      if (!inv || inv.user_id !== userId) return null;
      delete invoiceStore[parseInt(id, 10)];
      return { id: parseInt(id, 10) };
    },
    // Stubs required by invoice routes
    async updateInvoiceStatus(id, userId, status) {
      const inv = invoiceStore[parseInt(id, 10)];
      if (!inv || inv.user_id !== userId) return null;
      inv.status = status;
      return inv;
    },
    async setInvoicePaymentLink() { return null; },
    async dismissOnboarding() { return null; }
  }
};

require.cache[require.resolve('../db')] = {
  id: require.resolve('../db'),
  filename: require.resolve('../db'),
  loaded: true,
  exports: dbStub
};

// isValidWebhookUrl is configurable per-test so we can simulate both
// SSRF-blocked and valid-public-host scenarios without real DNS lookups.
require.cache[require.resolve('../lib/outbound-webhook')] = {
  id: require.resolve('../lib/outbound-webhook'),
  filename: require.resolve('../lib/outbound-webhook'),
  loaded: true,
  exports: {
    isValidWebhookUrl: async (url) => isValidWebhookUrlImpl(url),
    firePaidWebhook: async () => ({ ok: true }),
    buildPaidPayload: () => ({})
  }
};

const mockStripeClient = {
  webhooks: { constructEvent: () => { throw new Error('not used in these tests'); } },
  customers: {
    async create(params) {
      customerCreateCalls.push(params);
      return { id: 'cus_brand_new' };
    },
    async retrieve() { return { metadata: { user_id: '1' } }; }
  },
  checkout: {
    sessions: {
      async create(params) {
        checkoutCreateCalls.push(params);
        return { id: 'cs_test', url: 'https://checkout.stripe.com/pay/cs_test' };
      }
    }
  },
  billingPortal: {
    sessions: { async create() { return { url: 'https://billing.stripe.com/portal/test' }; } }
  },
  subscriptions: {
    async retrieve(id) { return { id, trial_end: null }; }
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

// Load billing routes with stubs already in place.
clearReq('../routes/billing');
const billingRoutes = require('../routes/billing');

// Stub invoice route dependencies before loading invoices.js.
require.cache[require.resolve('../lib/stripe-payment-link')] = {
  id: require.resolve('../lib/stripe-payment-link'),
  filename: require.resolve('../lib/stripe-payment-link'),
  loaded: true,
  exports: {
    createInvoicePaymentLink: async () => ({ id: 'plink_test', url: 'https://buy.stripe.com/test' })
  }
};
require.cache[require.resolve('../lib/email')] = {
  id: require.resolve('../lib/email'),
  filename: require.resolve('../lib/email'),
  loaded: true,
  exports: { sendInvoiceEmail: async () => ({ ok: true }) }
};
clearReq('../routes/invoices');
const invoiceRoutes = require('../routes/invoices');

// ── App builders ──────────────────────────────────────────────────────────

// Standard billing app — session user injected on every request.
// Suitable for tests that don't need session-mutation visibility.
function buildBillingApp(sessionUser) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, _res, next) => { if (sessionUser) req.session.user = sessionUser; next(); });
  app.use((req, res, next) => { res.locals.user = sessionUser || null; next(); });
  app.use('/billing', billingRoutes);
  return app;
}

// Session-preserving app for verifying that /billing/success mutates
// req.session.user.plan. Uses a MemoryStore that outlives individual HTTP
// connections so the updated session is readable by a subsequent request on
// the same app instance.
function buildSessionTestApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: true, saveUninitialized: true }));

  // Seed the session with a free-plan user on the very first request so that
  // requireAuth passes and the route has something to update. A flag prevents
  // re-seeding on subsequent requests, which would overwrite the mutation
  // we are trying to observe.
  let seeded = false;
  app.use((req, _res, next) => {
    if (!seeded && !req.session.user) {
      req.session.user = { id: 7, plan: 'free', name: 'U', email: 'u@x.com' };
      seeded = true;
    }
    next();
  });

  // Test-only route: read back whatever is currently in the session.
  app.get('/test/read-session', (req, res) => {
    res.json(req.session.user || null);
  });

  app.use((req, res, next) => { res.locals.user = req.session.user || null; next(); });
  app.use('/billing', billingRoutes);
  return app;
}

// Invoice app for the delete test.
function buildInvoiceApp(sessionUser) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { user: sessionUser, flash: null }; next(); });
  app.use((req, res, next) => { res.locals.user = sessionUser || null; next(); });
  app.use('/invoices', invoiceRoutes);
  return app;
}

// ── HTTP helper ───────────────────────────────────────────────────────────

function request(app, method, url, body, jar) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const payload = body ? new URLSearchParams(body).toString() : '';
      const headers = {};
      if (payload) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        headers['Content-Length'] = Buffer.byteLength(payload);
      }
      if (jar && jar.cookie) headers['Cookie'] = jar.cookie;

      const req = http.request(
        { hostname: '127.0.0.1', port, path: url, method, headers },
        res => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => {
            if (jar && res.headers['set-cookie']) {
              jar.cookie = res.headers['set-cookie'][0].split(';')[0];
            }
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

// ── Tests ─────────────────────────────────────────────────────────────────

// 1. First-time subscriber: checkout creates a Stripe customer and stores the ID.
async function testCheckoutCreatesNewStripeCustomer() {
  reset();
  userById[1] = {
    id: 1, email: 'new@example.com', name: 'New User',
    plan: 'free', stripe_customer_id: null
  };
  const app = buildBillingApp({ id: 1, plan: 'free', name: 'New User', email: 'new@example.com' });

  const res = await request(app, 'POST', '/billing/create-checkout', { billing_cycle: 'monthly' });
  await new Promise(r => setImmediate(r));

  assert.strictEqual(customerCreateCalls.length, 1,
    'stripe.customers.create must be called when user has no stripe_customer_id — ' +
    'every first-time subscriber exercises this path exactly once');
  assert.strictEqual(customerCreateCalls[0].email, 'new@example.com',
    'Stripe customer must be created with the authenticated user\'s email');

  const storeCall = updateUserCalls.find(c => c.fields && c.fields.stripe_customer_id);
  assert.ok(storeCall,
    'db.updateUser must be called to persist the new stripe_customer_id — ' +
    'without this the next checkout attempt creates a second orphaned Stripe customer');
  assert.strictEqual(storeCall.fields.stripe_customer_id, 'cus_brand_new',
    'the Stripe-returned customer ID must be stored verbatim');

  assert.strictEqual(checkoutCreateCalls.length, 1,
    'stripe.checkout.sessions.create must be called once');
  assert.strictEqual(checkoutCreateCalls[0].customer, 'cus_brand_new',
    'checkout session must use the newly created customer ID, not null or the old value');

  assert.strictEqual(res.status, 303, 'must 303-redirect to the Stripe checkout page');
  assert.ok(res.headers.location && res.headers.location.includes('checkout.stripe.com'),
    'redirect must target the Stripe checkout URL returned by the mock');
}

// 2. /billing/success refreshes req.session.user.plan from the DB.
//    The Stripe checkout.session.completed webhook typically fires before the
//    user is redirected to /billing/success, so the DB already has plan='pro'
//    by the time this route runs. Without the session refresh, the user would
//    still see plan='free' in their session until they log out and back in.
async function testSuccessRefreshesSessionPlan() {
  reset();
  userById[7] = {
    id: 7, email: 'u@x.com', name: 'U',
    plan: 'pro', stripe_customer_id: 'cus_existing'
  };

  const app = buildSessionTestApp();
  const jar = { cookie: null };

  // First request: seeds session with plan='free' (via the app middleware),
  // then the /billing/success handler fetches the DB row (plan='pro') and
  // writes it back to req.session.user. The cookie is captured by jar.
  await request(app, 'GET', '/billing/success', null, jar);

  // Second request: reads the session back from the MemoryStore using the
  // same cookie. The session must now carry plan='pro'.
  const readRes = await request(app, 'GET', '/test/read-session', null, jar);
  const sessionUser = JSON.parse(readRes.body);

  assert.ok(sessionUser, 'session user must still exist after /billing/success');
  assert.strictEqual(sessionUser.plan, 'pro',
    '/billing/success must update req.session.user.plan from the DB so the user ' +
    'sees Pro features immediately after checkout without logging out and back in');
}

// 3. Free-plan user can not save a webhook URL.
async function testWebhookUrlFreePlanRejected() {
  reset();
  userById[2] = { id: 2, plan: 'free', email: 'u@x.com', name: 'U' };
  const app = buildBillingApp({ id: 2, plan: 'free', email: 'u@x.com', name: 'U' });

  const res = await request(app, 'POST', '/billing/webhook-url',
    { webhook_url: 'https://hooks.example.com/paid' });

  assert.strictEqual(res.status, 302, 'free user must be redirected');
  assert.ok(res.headers.location && res.headers.location.includes('/billing/settings'),
    'must redirect to /billing/settings with the error flash');
  const dbWrite = updateUserCalls.find(c => c.fields && 'webhook_url' in c.fields);
  assert.strictEqual(dbWrite, undefined,
    'free plan must NOT write a webhook_url to the DB (gate must fire before db.updateUser)');
}

// 4. Agency plan passes the Pro/Agency gate (agency is a superset of Pro).
async function testWebhookUrlAgencyAllowed() {
  reset();
  isValidWebhookUrlImpl = async () => true;
  userById[3] = { id: 3, plan: 'agency', email: 'u@x.com', name: 'U' };
  const app = buildBillingApp({ id: 3, plan: 'agency', email: 'u@x.com', name: 'U' });

  await request(app, 'POST', '/billing/webhook-url',
    { webhook_url: 'https://hooks.example.com/agency' });
  await new Promise(r => setImmediate(r));

  const dbWrite = updateUserCalls.find(c => c.fields && c.fields.webhook_url);
  assert.ok(dbWrite,
    'agency plan must be allowed to save a webhook URL (agency inherits all Pro features)');
  assert.strictEqual(dbWrite.fields.webhook_url, 'https://hooks.example.com/agency',
    'exact URL must reach the DB');
}

// 5. Valid URL saved with success flash.
async function testWebhookUrlValidUrlSaved() {
  reset();
  isValidWebhookUrlImpl = async () => true;
  userById[4] = { id: 4, plan: 'pro', email: 'u@x.com', name: 'U' };
  const app = buildBillingApp({ id: 4, plan: 'pro', email: 'u@x.com', name: 'U' });

  const res = await request(app, 'POST', '/billing/webhook-url',
    { webhook_url: '  https://hooks.example.com/paid  ' });
  await new Promise(r => setImmediate(r));

  assert.strictEqual(res.status, 302, 'valid URL save must redirect');
  assert.ok(res.headers.location && res.headers.location.includes('/billing/settings'),
    'must redirect to /billing/settings after saving');
  const dbWrite = updateUserCalls.find(c => c.fields && c.fields.webhook_url);
  assert.ok(dbWrite, 'db.updateUser must be called to persist the webhook URL');
  assert.strictEqual(dbWrite.fields.webhook_url, 'https://hooks.example.com/paid',
    'URL must be trimmed before DB write (leading/trailing whitespace stripped)');
}

// 6. Empty / whitespace-only URL clears the webhook.
async function testWebhookUrlEmptyClears() {
  reset();
  userById[5] = {
    id: 5, plan: 'pro', email: 'u@x.com', name: 'U',
    webhook_url: 'https://old.example.com/hook'
  };
  const app = buildBillingApp({ id: 5, plan: 'pro', email: 'u@x.com', name: 'U' });

  const res = await request(app, 'POST', '/billing/webhook-url', { webhook_url: '   ' });
  await new Promise(r => setImmediate(r));

  assert.strictEqual(res.status, 302, 'clearing webhook URL must redirect');
  const dbWrite = updateUserCalls.find(c => c.id === 5 && 'webhook_url' in c.fields);
  assert.ok(dbWrite, 'db.updateUser must be called to clear the old webhook_url');
  assert.strictEqual(dbWrite.fields.webhook_url, null,
    'empty/whitespace URL must write webhook_url=null, not an empty string or raw spaces');
}

// 7. URL that fails SSRF-validation is rejected; no DB write.
async function testWebhookUrlInvalidRejected() {
  reset();
  isValidWebhookUrlImpl = async () => false;
  userById[6] = { id: 6, plan: 'pro', email: 'u@x.com', name: 'U' };
  const app = buildBillingApp({ id: 6, plan: 'pro', email: 'u@x.com', name: 'U' });

  const res = await request(app, 'POST', '/billing/webhook-url',
    { webhook_url: 'http://169.254.169.254/latest/meta-data' });
  await new Promise(r => setImmediate(r));

  assert.strictEqual(res.status, 302, 'invalid URL must redirect');
  assert.ok(res.headers.location && res.headers.location.includes('/billing/settings'),
    'must redirect back to settings with an error flash (not a 500 or blank page)');
  const dbWrite = updateUserCalls.find(c => c.fields && 'webhook_url' in c.fields);
  assert.strictEqual(dbWrite, undefined,
    'an SSRF-blocked URL must NOT be written to the DB ' +
    '(the route must check isValidWebhookUrl before calling db.updateUser)');
}

// 8. Invoice delete — owner successfully deletes their own invoice.
async function testInvoiceDeleteOwnerSuccess() {
  reset();
  const owner = { id: 10, plan: 'pro', name: 'Owner', email: 'o@x.com' };
  userById[10] = owner;
  invoiceStore[99] = {
    id: 99, user_id: 10, invoice_number: 'INV-2026-0099',
    client_name: 'Delete Me Corp', total: 1000, status: 'draft', items: []
  };

  const app = buildInvoiceApp({ id: 10, plan: 'pro', name: 'Owner', email: 'o@x.com' });

  const res = await request(app, 'POST', '/invoices/99/delete');

  assert.strictEqual(res.status, 302, 'successful delete must redirect');
  assert.ok(res.headers.location && res.headers.location.includes('/dashboard'),
    'delete must redirect to /dashboard, not back to the invoice or to an error page');
  assert.strictEqual(invoiceStore[99], undefined,
    'invoice must be removed from the store after a successful owner-initiated delete');
}

// ── Runner ────────────────────────────────────────────────────────────────

async function run() {
  const tests = [
    ['POST /billing/create-checkout: no existing customer → creates Stripe customer + stores stripe_customer_id', testCheckoutCreatesNewStripeCustomer],
    ['GET /billing/success: session plan refreshed from DB (free→pro without re-login)', testSuccessRefreshesSessionPlan],
    ['POST /billing/webhook-url: free plan → error flash, no DB write', testWebhookUrlFreePlanRejected],
    ['POST /billing/webhook-url: agency plan → allowed (agency has all Pro features)', testWebhookUrlAgencyAllowed],
    ['POST /billing/webhook-url: valid URL → trimmed + saved to DB + redirect', testWebhookUrlValidUrlSaved],
    ['POST /billing/webhook-url: empty URL → clears webhook_url to null', testWebhookUrlEmptyClears],
    ['POST /billing/webhook-url: SSRF-blocked URL → rejected, no DB write', testWebhookUrlInvalidRejected],
    ['POST /invoices/:id/delete: owner → invoice removed from store + redirect to /dashboard', testInvoiceDeleteOwnerSuccess]
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
