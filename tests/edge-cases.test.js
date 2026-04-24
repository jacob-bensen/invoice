'use strict';

/*
 * Edge-cases tests — income-critical paths and bug regressions.
 *
 *  1. POST /invoices/:id/edit DB error → redirect back to edit page (no 500).
 *  2. POST /billing/webhook-url Agency plan → URL saved (parity with Pro, $49/mo tier).
 *  3. POST /billing/webhook-url DB error in save → flash error + redirect to settings.
 *  4. POST /auth/register with authenticated session → redirectIfAuth 302 /dashboard.
 *  5. POST /auth/login with authenticated session → redirectIfAuth 302 /dashboard.
 *  6. GET /invoices/new when db.getUserById returns null → redirect, no crash.
 *  7. POST /invoices/new when db.getUserById returns null → redirect, no crash.
 *
 * Tests 6 and 7 are regression guards for the null-dereference bug fixed in
 * routes/invoices.js: without the `if (!user) return res.redirect(...)` guard,
 * both handlers dereference `user.plan` before any try/catch, producing an
 * unhandled 500 when a session references a deleted account.
 *
 * Run: node tests/edge-cases.test.js
 */

const assert = require('assert');
const path = require('path');
const express = require('express');
const http = require('http');
const session = require('express-session');

function clearReq(mod) { delete require.cache[require.resolve(mod)]; }

// ---------- bcrypt stub (fast, deterministic) ------------------------------

require.cache[require.resolve('bcrypt')] = {
  id: require.resolve('bcrypt'),
  filename: require.resolve('bcrypt'),
  loaded: true,
  exports: {
    hash: async (pw) => `hashed:${pw}`,
    compare: async (pw, hash) => hash === `hashed:${pw}`
  }
};

// ---------- Mutable test state ---------------------------------------------

let dbGetUserByIdImpl = null;   // override per-test; null = use in-memory map
let dbUpdateUserShouldThrow = false;
let dbUpdateInvoiceShouldThrow = false;

const users = new Map();
const invoices = new Map();
let nextId = 1;
const updateUserCalls = [];

function resetStore() {
  users.clear();
  invoices.clear();
  nextId = 1;
  updateUserCalls.length = 0;
  dbGetUserByIdImpl = null;
  dbUpdateUserShouldThrow = false;
  dbUpdateInvoiceShouldThrow = false;
}

// ---------- DB stub --------------------------------------------------------

const dbStub = {
  pool: { query: async () => ({ rows: [] }) },
  db: {
    async getUserById(id) {
      if (dbGetUserByIdImpl !== null) return dbGetUserByIdImpl(id);
      return users.get(id) || null;
    },
    async getUserByEmail(email) {
      for (const u of users.values()) { if (u.email === email) return u; }
      return null;
    },
    async createUser({ email, password_hash, name }) {
      const id = nextId++;
      const user = { id, email, password_hash, name, plan: 'free', invoice_count: 0 };
      users.set(id, user);
      return user;
    },
    async updateUser(id, fields) {
      if (dbUpdateUserShouldThrow) throw new Error('DB write error');
      updateUserCalls.push({ id, fields });
      const u = users.get(id);
      if (u) Object.assign(u, fields);
      return u || null;
    },
    async getInvoicesByUser(userId) {
      return [...invoices.values()].filter(i => i.user_id === userId);
    },
    async getInvoiceById(id, userId) {
      const inv = invoices.get(parseInt(id, 10));
      if (!inv || inv.user_id !== userId) return null;
      return inv;
    },
    async updateInvoice(id, userId, data) {
      if (dbUpdateInvoiceShouldThrow) throw new Error('DB update error');
      const inv = invoices.get(parseInt(id, 10));
      if (!inv || inv.user_id !== userId) return null;
      Object.assign(inv, data);
      return inv;
    },
    async updateInvoiceStatus(id, userId, status) {
      const inv = invoices.get(parseInt(id, 10));
      if (!inv || inv.user_id !== userId) return null;
      inv.status = status;
      return inv;
    },
    async setInvoicePaymentLink(id, userId, url, linkId) {
      const inv = invoices.get(parseInt(id, 10));
      if (!inv || inv.user_id !== userId) return null;
      inv.payment_link_url = url;
      inv.payment_link_id = linkId;
      return inv;
    },
    async markInvoicePaidByPaymentLinkId() { return null; },
    async deleteInvoice(id) { invoices.delete(parseInt(id, 10)); return { id }; },
    async createInvoice(data) {
      const id = nextId++;
      const inv = { id, ...data, status: 'draft', payment_link_url: null, payment_link_id: null };
      invoices.set(id, inv);
      return inv;
    },
    async getNextInvoiceNumber() { return 'INV-2026-0001'; }
  }
};

require.cache[require.resolve('../db')] = {
  id: require.resolve('../db'),
  filename: require.resolve('../db'),
  loaded: true,
  exports: dbStub
};

// ---------- Outbound webhook stub -----------------------------------------
// isValidWebhookUrl accepts any http/https URL — no real DNS calls in tests.

require.cache[require.resolve('../lib/outbound-webhook')] = {
  id: require.resolve('../lib/outbound-webhook'),
  filename: require.resolve('../lib/outbound-webhook'),
  loaded: true,
  exports: {
    isValidWebhookUrl: async (url) =>
      typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://')),
    buildPaidPayload: (inv) => ({
      event: 'invoice.paid', invoice_id: inv.id, amount: inv.total,
      client_name: inv.client_name, paid_at: new Date().toISOString()
    }),
    firePaidWebhook: async () => ({ ok: true, status: 200 }),
    setHostnameResolver: () => {}
  }
};

// ---------- Stripe Payment Link stub --------------------------------------

require.cache[require.resolve('../lib/stripe-payment-link')] = {
  id: require.resolve('../lib/stripe-payment-link'),
  filename: require.resolve('../lib/stripe-payment-link'),
  loaded: true,
  exports: { createInvoicePaymentLink: async () => null }
};

// ---------- Stripe SDK stub -----------------------------------------------

require.cache[require.resolve('stripe')] = {
  id: require.resolve('stripe'),
  filename: require.resolve('stripe'),
  loaded: true,
  exports: () => ({
    webhooks: { constructEvent: () => { throw new Error('not used in these tests'); } },
    customers: {
      create: async (data) => ({ id: 'cus_test', ...data }),
      retrieve: async () => ({ metadata: {} })
    },
    checkout: { sessions: { create: async () => ({ url: 'https://checkout.stripe.com/test' }) } },
    billingPortal: { sessions: { create: async () => ({ url: 'https://billing.stripe.com/test' }) } }
  })
};

// ---------- Load routes (after all stubs) ---------------------------------

clearReq('../routes/invoices');
clearReq('../routes/billing');
clearReq('../routes/auth');
clearReq('../middleware/auth');

const invoiceRoutes = require('../routes/invoices');
const billingRoutes = require('../routes/billing');
const authRoutes = require('../routes/auth');
const { requireAuth } = require('../middleware/auth');

// ---------- App builders --------------------------------------------------

function buildInvoiceApp(sessionUser) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { user: sessionUser ? { ...sessionUser } : null };
    next();
  });
  app.use((req, res, next) => { res.locals.user = req.session.user || null; next(); });
  app.use('/invoices', invoiceRoutes);
  return app;
}

function buildBillingApp(sessionUser) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { user: sessionUser ? { ...sessionUser } : null };
    next();
  });
  app.use((req, res, next) => { res.locals.user = req.session.user || null; next(); });
  app.use('/billing', billingRoutes);
  return app;
}

function buildAuthApp(preloadedSessionUser) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  if (preloadedSessionUser !== undefined) {
    app.use((req, _res, next) => { req.session.user = preloadedSessionUser; next(); });
  }
  app.use((req, res, next) => { res.locals.user = req.session.user || null; next(); });
  app.use('/auth', authRoutes);
  app.get('/dashboard', requireAuth, (_req, res) => res.send('dashboard'));
  return app;
}

// ---------- HTTP helper ---------------------------------------------------

function request(app, method, urlPath, body) {
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
        { hostname: '127.0.0.1', port, path: urlPath, method, headers },
        res => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () =>
            server.close(() => resolve({ status: res.statusCode, headers: res.headers, body: data }))
          );
        }
      );
      req.on('error', err => { server.close(); reject(err); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

// ---------- Tests ---------------------------------------------------------

// 1. POST /invoices/:id/edit DB error → redirect back to edit page (no 500).
// routes/invoices.js POST /:id/edit has a try/catch that redirects on any DB error;
// previously no test reached this branch.
async function testEditInvoiceDbErrorRedirects() {
  resetStore();
  dbUpdateInvoiceShouldThrow = true;
  users.set(1, { id: 1, plan: 'pro', name: 'A', email: 'a@x.com' });
  const inv = {
    id: nextId++, user_id: 1,
    invoice_number: 'INV-2026-0001', client_name: 'Client A',
    total: 100, status: 'draft', payment_link_url: null, payment_link_id: null, items: []
  };
  invoices.set(inv.id, inv);

  const app = buildInvoiceApp({ id: 1, plan: 'pro' });
  const res = await request(app, 'POST', `/invoices/${inv.id}/edit`, {
    client_name: 'Updated', items: '[]',
    subtotal: '100', tax_rate: '0', tax_amount: '0', total: '100',
    issued_date: '2026-04-24'
  });

  assert.strictEqual(res.status, 302,
    'POST /invoices/:id/edit DB error must redirect (302), not produce a 500');
  assert.ok(
    res.headers.location && res.headers.location.includes(`/invoices/${inv.id}`),
    'on edit DB error, must redirect back to the invoice page'
  );
}

// 2. POST /billing/webhook-url Agency plan → URL saved (parity with Pro).
// The route checks `plan !== 'pro' && plan !== 'agency'` but existing tests
// only exercise plan='pro'. Agency users pay $49/mo — silent breakage here
// is the highest-cost regression possible.
async function testWebhookUrlAgencyPlanAllowed() {
  resetStore();
  users.set(2, { id: 2, plan: 'agency', email: 'agency@x.com', name: 'Agency Co' });

  const app = buildBillingApp({ id: 2, plan: 'agency' });
  const res = await request(app, 'POST', '/billing/webhook-url', {
    webhook_url: 'https://hooks.zapier.com/hooks/catch/agency/test'
  });

  assert.strictEqual(res.status, 302,
    'Agency plan POST /billing/webhook-url must redirect 302 (not 403/500)');
  const call = updateUserCalls.find(c => c.fields && c.fields.webhook_url);
  assert.ok(call, 'db.updateUser must be called with webhook_url for Agency plan');
  assert.strictEqual(
    call.fields.webhook_url, 'https://hooks.zapier.com/hooks/catch/agency/test',
    'webhook_url must be persisted for Agency plan — all Pro features apply'
  );
}

// 3. POST /billing/webhook-url DB error in save → flash error + redirect.
// The outer try/catch in POST /billing/webhook-url flashes an error on any
// unexpected exception; this branch was never exercised.
async function testWebhookUrlDbErrorFlashesError() {
  resetStore();
  users.set(3, { id: 3, plan: 'pro', email: 'pro@x.com', name: 'Pro User' });
  dbUpdateUserShouldThrow = true;

  const app = buildBillingApp({ id: 3, plan: 'pro' });
  const res = await request(app, 'POST', '/billing/webhook-url', {
    webhook_url: 'https://hooks.example.com/valid-url'
  });

  assert.strictEqual(res.status, 302,
    'POST /billing/webhook-url DB error must redirect (302), not 500');
  assert.ok(
    res.headers.location && res.headers.location.includes('/billing/settings'),
    'must redirect back to /billing/settings on DB error'
  );
}

// 4. POST /auth/register with authenticated session → redirectIfAuth 302 /dashboard.
// redirectIfAuth is applied to both GET and POST /auth/register; only the GET
// was previously tested, leaving the POST path uncovered.
async function testRegisterPostRedirectsIfAuthenticated() {
  const app = buildAuthApp({ id: 10, plan: 'free', name: 'U', email: 'u@x.com' });
  const res = await request(app, 'POST', '/auth/register', {
    name: 'New User', email: 'new@x.com', password: 'password123'
  });

  assert.strictEqual(res.status, 302,
    'authenticated POST /auth/register must redirect 302 via redirectIfAuth');
  assert.ok(
    res.headers.location && res.headers.location.includes('/dashboard'),
    'redirectIfAuth on POST /auth/register must target /dashboard, not attempt registration'
  );
}

// 5. POST /auth/login with authenticated session → redirectIfAuth 302 /dashboard.
// Same as above for POST /auth/login — only GET was tested previously.
async function testLoginPostRedirectsIfAuthenticated() {
  const app = buildAuthApp({ id: 11, plan: 'free', name: 'U', email: 'u@x.com' });
  const res = await request(app, 'POST', '/auth/login', {
    email: 'u@x.com', password: 'pw123'
  });

  assert.strictEqual(res.status, 302,
    'authenticated POST /auth/login must redirect 302 via redirectIfAuth');
  assert.ok(
    res.headers.location && res.headers.location.includes('/dashboard'),
    'redirectIfAuth on POST /auth/login must target /dashboard, not attempt login'
  );
}

// 6. GET /invoices/new when db.getUserById returns null → redirect, no crash.
// Bug fixed in routes/invoices.js: without the null guard, `user.plan` threw
// a TypeError before any try/catch when a session referenced a deleted user,
// producing an unhandled 500. Now guarded with `if (!user) redirect('/auth/login')`.
async function testGetNewInvoiceNullUserRedirects() {
  resetStore();
  dbGetUserByIdImpl = () => null;

  const app = buildInvoiceApp({ id: 99, plan: 'free' });
  const res = await request(app, 'GET', '/invoices/new');

  assert.ok(res.status !== 500,
    'GET /invoices/new must not produce an unhandled 500 when db.getUserById returns null; ' +
    'got ' + res.status);
  assert.strictEqual(res.status, 302,
    'GET /invoices/new must redirect when user row is missing from DB');
}

// 7. POST /invoices/new when db.getUserById returns null → redirect, no crash.
// Same null-dereference bug in the POST handler — `user.plan` at line ~57
// executes before the inner try/catch, so the fix must live before that check.
async function testPostNewInvoiceNullUserRedirects() {
  resetStore();
  dbGetUserByIdImpl = () => null;

  const app = buildInvoiceApp({ id: 99, plan: 'free' });
  const res = await request(app, 'POST', '/invoices/new', {
    client_name: 'Test Client',
    items: JSON.stringify([{ description: 'Work', quantity: 1, rate: 100, amount: 100 }]),
    subtotal: '100', tax_rate: '0', tax_amount: '0', total: '100',
    invoice_number: 'INV-2026-0001', issued_date: '2026-04-24'
  });

  assert.ok(res.status !== 500,
    'POST /invoices/new must not produce an unhandled 500 when db.getUserById returns null; ' +
    'got ' + res.status);
  assert.strictEqual(res.status, 302,
    'POST /invoices/new must redirect when user row is missing from DB');
}

// ---------- Runner --------------------------------------------------------

async function run() {
  const tests = [
    ['POST /invoices/:id/edit DB error → redirect to edit page (no 500)', testEditInvoiceDbErrorRedirects],
    ['POST /billing/webhook-url Agency plan → URL saved (parity with Pro, $49/mo)', testWebhookUrlAgencyPlanAllowed],
    ['POST /billing/webhook-url DB error in save → flash + redirect to /billing/settings', testWebhookUrlDbErrorFlashesError],
    ['POST /auth/register authenticated user → redirectIfAuth 302 /dashboard', testRegisterPostRedirectsIfAuthenticated],
    ['POST /auth/login authenticated user → redirectIfAuth 302 /dashboard', testLoginPostRedirectsIfAuthenticated],
    ['GET /invoices/new null DB user → redirect, no crash (null.plan bug fix)', testGetNewInvoiceNullUserRedirects],
    ['POST /invoices/new null DB user → redirect, no crash (null.plan bug fix)', testPostNewInvoiceNullUserRedirects]
  ];

  let pass = 0, fail = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ok  ${name}`);
      pass++;
    } catch (err) {
      console.error(`  FAIL  ${name}`);
      console.error(err && err.stack ? err.stack : err);
      fail++;
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run().catch(err => { console.error(err); process.exit(1); });
