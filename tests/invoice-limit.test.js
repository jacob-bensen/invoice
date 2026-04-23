'use strict';

/*
 * Invoice route integration tests.
 *
 * Covers:
 *  - Free-plan invoice limit enforcement (redirect to ?limit_hit=1)
 *  - Plan-gating for Stripe Payment Links (pro + agency get links; solo does not)
 *  - IDOR guard: fetching another user's invoice redirects
 *  - DELETE /:id redirects to /dashboard
 *
 * Run: node tests/invoice-limit.test.js
 */

const assert = require('assert');
const path = require('path');
const express = require('express');
const http = require('http');

// ---------- Stubs -------------------------------------------------------

const users = new Map();
const invoices = new Map();
let nextInvoiceId = 1;
const createdLinks = [];

function resetStore() {
  users.clear();
  invoices.clear();
  nextInvoiceId = 1;
  createdLinks.length = 0;
}

const dbStub = {
  pool: { query: async () => ({ rows: [] }) },
  db: {
    async getUserById(id) { return users.get(id) || null; },
    async getInvoiceById(id, userId) {
      const inv = invoices.get(parseInt(id, 10));
      if (!inv || inv.user_id !== userId) return null;
      return inv;
    },
    async getInvoicesByUser(userId) {
      return [...invoices.values()].filter(i => i.user_id === userId);
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
    async getNextInvoiceNumber() { return 'INV-2026-0001'; },
    async createInvoice(data) {
      const id = nextInvoiceId++;
      const inv = { id, ...data, status: 'draft', payment_link_url: null, payment_link_id: null };
      invoices.set(id, inv);
      return inv;
    },
    async updateInvoice() { return null; },
    async deleteInvoice(id, userId) {
      const inv = invoices.get(parseInt(id, 10));
      if (!inv || inv.user_id !== userId) return null;
      invoices.delete(parseInt(id, 10));
      return { id };
    },
    async getUserByEmail() { return null; },
    async createUser() { throw new Error('not used'); },
    async updateUser(id, fields) {
      const u = users.get(id);
      if (!u) return null;
      Object.assign(u, fields);
      return u;
    }
  }
};

require.cache[require.resolve('../db')] = {
  id: require.resolve('../db'),
  filename: require.resolve('../db'),
  loaded: true,
  exports: dbStub
};

require.cache[require.resolve('../lib/stripe-payment-link')] = {
  id: require.resolve('../lib/stripe-payment-link'),
  filename: require.resolve('../lib/stripe-payment-link'),
  loaded: true,
  exports: {
    createInvoicePaymentLink: async (invoice, user) => {
      createdLinks.push({ invoice_id: invoice.id, plan: user.plan });
      return { id: `plink_test_${invoice.id}`, url: `https://buy.stripe.com/test_${invoice.id}` };
    }
  }
};

function clearReq(mod) { delete require.cache[require.resolve(mod)]; }
clearReq('../routes/invoices');
const invoiceRoutes = require('../routes/invoices');

// ---------- App builder -------------------------------------------------

function buildApp(sessionUser) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { user: sessionUser, flash: null };
    next();
  });
  app.use((req, res, next) => { res.locals.user = sessionUser || null; next(); });
  app.use('/invoices', invoiceRoutes);
  return app;
}

// ---------- HTTP helper -------------------------------------------------

function request(app, method, url, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const payload = body ? new URLSearchParams(body).toString() : '';
      const req = http.request({
        hostname: '127.0.0.1', port, path: url, method,
        headers: payload
          ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(payload) }
          : {}
      }, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          server.close(() => resolve({ status: res.statusCode, headers: res.headers, body: data }));
        });
      });
      req.on('error', err => { server.close(); reject(err); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

// ---------- Tests -------------------------------------------------------

async function testGetNewInvoiceFreeLimitHit() {
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 3, name: 'U', email: 'u@x.com' });
  const app = buildApp({ id: 1, plan: 'free' });
  const res = await request(app, 'GET', '/invoices/new');
  assert.strictEqual(res.status, 302, 'free user at limit must redirect');
  assert.ok(res.headers.location.includes('limit_hit=1'),
    'redirect must include limit_hit=1 query param');
}

async function testPostNewInvoiceFreeLimitHit() {
  resetStore();
  users.set(2, { id: 2, plan: 'free', invoice_count: 3, name: 'U', email: 'u@x.com' });
  const app = buildApp({ id: 2, plan: 'free' });
  const res = await request(app, 'POST', '/invoices/new',
    { client_name: 'Client', items: '[]' });
  assert.strictEqual(res.status, 302, 'free user at limit must redirect on POST too');
  assert.ok(res.headers.location.includes('limit_hit=1'),
    'redirect must include limit_hit=1 query param');
}

async function testGetNewInvoiceFreeUnderLimit() {
  resetStore();
  users.set(3, { id: 3, plan: 'free', invoice_count: 2, name: 'U', email: 'u@x.com' });
  const app = buildApp({ id: 3, plan: 'free' });
  const res = await request(app, 'GET', '/invoices/new');
  assert.strictEqual(res.status, 200, 'free user under limit must be allowed to create invoice');
}

async function testGetNewInvoiceProAlwaysAllowed() {
  resetStore();
  users.set(4, { id: 4, plan: 'pro', invoice_count: 100, name: 'U', email: 'u@x.com' });
  const app = buildApp({ id: 4, plan: 'pro' });
  const res = await request(app, 'GET', '/invoices/new');
  assert.strictEqual(res.status, 200, 'pro user must never hit invoice limit');
}

async function testSoloPlanDoesNotGetPaymentLink() {
  resetStore();
  createdLinks.length = 0;
  users.set(5, { id: 5, plan: 'solo', name: 'U', email: 'u@x.com' });
  const inv = {
    id: nextInvoiceId++, user_id: 5, invoice_number: 'INV-1', client_name: 'C',
    total: 300, status: 'draft', payment_link_url: null, payment_link_id: null, items: []
  };
  invoices.set(inv.id, inv);

  const app = buildApp({ id: 5, plan: 'solo' });
  await request(app, 'POST', `/invoices/${inv.id}/status`, { status: 'sent' });
  assert.strictEqual(createdLinks.length, 0,
    'solo plan ($9/mo) must not create Payment Links — that is a Pro/Agency feature');
  assert.strictEqual(inv.payment_link_url, null);
}

async function testAgencyPlanGetsPaymentLink() {
  resetStore();
  createdLinks.length = 0;
  users.set(6, { id: 6, plan: 'agency', name: 'U', email: 'u@x.com' });
  const inv = {
    id: nextInvoiceId++, user_id: 6, invoice_number: 'INV-2', client_name: 'C',
    total: 1200, status: 'draft', payment_link_url: null, payment_link_id: null, items: []
  };
  invoices.set(inv.id, inv);

  const app = buildApp({ id: 6, plan: 'agency' });
  await request(app, 'POST', `/invoices/${inv.id}/status`, { status: 'sent' });
  // Agency is "All Pro" — payment links must be created.
  assert.strictEqual(createdLinks.length, 1,
    'agency plan ($49/mo includes all Pro features) must create Payment Links');
  assert.strictEqual(inv.payment_link_url, `https://buy.stripe.com/test_${inv.id}`);
}

async function testGetInvoiceWrongUserRedirects() {
  resetStore();
  // Invoice belongs to user 10, but request is made by user 11.
  users.set(11, { id: 11, plan: 'pro', name: 'U', email: 'u@x.com' });
  const inv = {
    id: nextInvoiceId++, user_id: 10, invoice_number: 'INV-3',
    client_name: 'C', total: 100, status: 'draft', items: []
  };
  invoices.set(inv.id, inv);

  const app = buildApp({ id: 11, plan: 'pro' });
  const res = await request(app, 'GET', `/invoices/${inv.id}`);
  assert.strictEqual(res.status, 302, 'accessing another user\'s invoice must redirect (IDOR guard)');
  assert.ok(res.headers.location.includes('/dashboard'),
    'redirect should return user to their dashboard');
}

async function testDeleteInvoiceRedirectsToDashboard() {
  resetStore();
  users.set(7, { id: 7, plan: 'pro', name: 'U', email: 'u@x.com' });
  const inv = {
    id: nextInvoiceId++, user_id: 7, invoice_number: 'INV-4',
    client_name: 'C', total: 500, status: 'draft', items: []
  };
  invoices.set(inv.id, inv);

  const app = buildApp({ id: 7, plan: 'pro' });
  const res = await request(app, 'POST', `/invoices/${inv.id}/delete`);
  assert.strictEqual(res.status, 302, 'delete must redirect');
  assert.ok(res.headers.location.includes('/dashboard'),
    'after delete user should be sent to dashboard');
  assert.ok(!invoices.has(inv.id), 'invoice must be removed from store');
}

// ---------- Runner ------------------------------------------------------

async function run() {
  const tests = [
    ['Free limit: GET /invoices/new at limit redirects with ?limit_hit=1', testGetNewInvoiceFreeLimitHit],
    ['Free limit: POST /invoices/new at limit redirects with ?limit_hit=1', testPostNewInvoiceFreeLimitHit],
    ['Free limit: GET /invoices/new under limit renders form (200)', testGetNewInvoiceFreeUnderLimit],
    ['Free limit: pro user is never blocked regardless of invoice count', testGetNewInvoiceProAlwaysAllowed],
    ['Plan gate: solo plan does NOT create Payment Link', testSoloPlanDoesNotGetPaymentLink],
    ['Plan gate: agency plan DOES create Payment Link (All-Pro feature)', testAgencyPlanGetsPaymentLink],
    ['IDOR: GET /invoices/:id for another user\'s invoice redirects', testGetInvoiceWrongUserRedirects],
    ['Delete: POST /invoices/:id/delete redirects to /dashboard', testDeleteInvoiceRedirectsToDashboard]
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
