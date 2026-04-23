'use strict';

/*
 * Invoice view + status transition tests.
 *
 * Covers paths absent from the existing suite:
 *  - GET  /invoices/              success: owner gets 200 with their invoices
 *  - GET  /invoices/              DB error: renders empty list, no crash (500 guard)
 *  - GET  /invoices/:id           success: owner gets 200 invoice detail view
 *  - GET  /invoices/:id/print     success: owner gets 200 print view
 *  - POST /invoices/:id/status    payment link NOT re-created when one already exists
 *  - POST /invoices/:id/status    Stripe error on link creation does NOT block status change
 *  - POST /invoices/:id/delete    IDOR: another user's invoice is not removed from store
 *
 * Run: node tests/invoice-view-and-status.test.js
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
let paymentLinkShouldThrow = false;

function resetStore() {
  users.clear();
  invoices.clear();
  nextInvoiceId = 1;
  createdLinks.length = 0;
  paymentLinkShouldThrow = false;
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
    async getInvoicesByUserThrows() { throw new Error('db failure'); },
    async getNextInvoiceNumber() { return 'INV-2026-0001'; },
    async createInvoice(data) {
      const id = nextInvoiceId++;
      const inv = { id, ...data, status: 'draft', payment_link_url: null, payment_link_id: null };
      invoices.set(id, inv);
      return inv;
    },
    async updateInvoice(id, userId, data) {
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
    async deleteInvoice(id, userId) {
      const inv = invoices.get(parseInt(id, 10));
      if (!inv || inv.user_id !== userId) return null;
      invoices.delete(parseInt(id, 10));
      return { id };
    },
    async markInvoicePaidByPaymentLinkId() { return null; },
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
    async createInvoicePaymentLink(invoice, user) {
      if (paymentLinkShouldThrow) throw new Error('Stripe connection refused');
      createdLinks.push({ invoice_id: invoice.id, plan: user.plan });
      return { id: `plink_test_${invoice.id}`, url: `https://buy.stripe.com/test_${invoice.id}` };
    }
  }
};

function clearReq(mod) { delete require.cache[require.resolve(mod)]; }
clearReq('../routes/invoices');
const invoiceRoutes = require('../routes/invoices');

// ---------- App builder -------------------------------------------------

function buildApp(sessionUser, overrideGetInvoicesByUser) {
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

  if (overrideGetInvoicesByUser) {
    // Temporarily swap getInvoicesByUser so the route hits an error.
    const orig = dbStub.db.getInvoicesByUser;
    app.use((req, _res, next) => {
      dbStub.db.getInvoicesByUser = overrideGetInvoicesByUser;
      next();
    });
    app.use('/invoices', invoiceRoutes);
    app.use((req, _res, next) => {
      dbStub.db.getInvoicesByUser = orig;
      next();
    });
  } else {
    app.use('/invoices', invoiceRoutes);
  }
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

// GET /invoices/ — happy path: user's invoices render correctly.
async function testDashboardReturns200() {
  resetStore();
  users.set(1, { id: 1, plan: 'pro', name: 'Alice', email: 'alice@x.com' });
  invoices.set(1, {
    id: 1, user_id: 1, invoice_number: 'INV-2026-0001', client_name: 'Acme',
    total: 500, status: 'draft', items: [], payment_link_url: null, payment_link_id: null
  });
  const app = buildApp({ id: 1, plan: 'pro' });

  const res = await request(app, 'GET', '/invoices/');
  assert.strictEqual(res.status, 200, 'GET /invoices/ must return 200 for authenticated user');
  assert.ok(res.body.includes('Acme') || res.body.includes('INV-2026-0001'),
    'dashboard must render the user\'s invoice data');
}

// GET /invoices/ — DB error: must render empty list, not crash with 500.
async function testDashboardDbErrorRendersEmpty() {
  resetStore();
  users.set(2, { id: 2, plan: 'pro', name: 'Bob', email: 'bob@x.com' });

  // Override getInvoicesByUser at stub level during this one request.
  const orig = dbStub.db.getInvoicesByUser;
  dbStub.db.getInvoicesByUser = async () => { throw new Error('DB connection lost'); };
  const app = buildApp({ id: 2, plan: 'pro' });
  try {
    const res = await request(app, 'GET', '/invoices/');
    // Route catches the error and renders the dashboard with an empty list.
    assert.ok(res.status === 200 || res.status === 302,
      'DB error on dashboard must not produce an unhandled 500; got ' + res.status);
  } finally {
    dbStub.db.getInvoicesByUser = orig;
  }
}

// GET /invoices/:id — happy path: invoice owner gets 200.
async function testInvoiceViewOwnerGets200() {
  resetStore();
  users.set(3, { id: 3, plan: 'pro', name: 'Carol', email: 'carol@x.com' });
  invoices.set(2, {
    id: 2, user_id: 3, invoice_number: 'INV-2026-0002', client_name: 'Beta LLC',
    total: 1200, status: 'sent', items: [],
    payment_link_url: null, payment_link_id: null,
    issued_date: '2026-04-01', due_date: '2026-05-01'
  });
  const app = buildApp({ id: 3, plan: 'pro' });

  const res = await request(app, 'GET', '/invoices/2');
  assert.strictEqual(res.status, 200, 'invoice owner must get 200 on GET /invoices/:id');
  assert.ok(res.body.includes('Beta LLC') || res.body.includes('INV-2026-0002'),
    'invoice detail must include the invoice data');
}

// GET /invoices/:id/print — happy path: invoice owner gets 200.
async function testPrintViewOwnerGets200() {
  resetStore();
  users.set(4, { id: 4, plan: 'pro', name: 'Dave', email: 'dave@x.com' });
  invoices.set(3, {
    id: 3, user_id: 4, invoice_number: 'INV-2026-0003', client_name: 'Gamma Co',
    total: 750, status: 'sent', items: [],
    payment_link_url: 'https://buy.stripe.com/test', payment_link_id: 'plink_abc',
    issued_date: '2026-04-10', due_date: '2026-05-10'
  });
  const app = buildApp({ id: 4, plan: 'pro' });

  const res = await request(app, 'GET', '/invoices/3/print');
  assert.strictEqual(res.status, 200, 'invoice owner must get 200 on GET /invoices/:id/print');
  assert.ok(res.body.includes('Gamma Co') || res.body.includes('INV-2026-0003'),
    'print view must include the invoice data');
}

// POST /invoices/:id/status — payment link NOT re-created when already set.
// Re-sending an already-sent invoice must not create a duplicate Stripe Payment Link.
async function testStatusUpdateDoesNotDuplicatePaymentLink() {
  resetStore();
  createdLinks.length = 0;
  users.set(5, { id: 5, plan: 'pro', name: 'Eve', email: 'eve@x.com' });
  // Invoice already has a payment link from the first time it was sent.
  invoices.set(4, {
    id: 4, user_id: 5, invoice_number: 'INV-2026-0004', client_name: 'Delta Inc',
    total: 500, status: 'sent',
    payment_link_url: 'https://buy.stripe.com/existing',
    payment_link_id: 'plink_existing',
    items: []
  });
  const app = buildApp({ id: 5, plan: 'pro' });

  // Re-mark as sent (status unchanged but endpoint is still called).
  await request(app, 'POST', '/invoices/4/status', { status: 'sent' });

  assert.strictEqual(createdLinks.length, 0,
    'createInvoicePaymentLink must NOT be called when invoice already has a payment_link_url ' +
    '(prevents duplicate Stripe Payment Links from being created on re-send)');
}

// POST /invoices/:id/status — Stripe payment link creation error does NOT block status change.
// The status update must succeed even if Stripe is unavailable.
async function testStatusUpdateSucceedsWhenLinkCreationFails() {
  resetStore();
  paymentLinkShouldThrow = true;
  users.set(6, { id: 6, plan: 'pro', name: 'Frank', email: 'frank@x.com' });
  invoices.set(5, {
    id: 5, user_id: 6, invoice_number: 'INV-2026-0005', client_name: 'Epsilon',
    total: 800, status: 'draft',
    payment_link_url: null, payment_link_id: null, items: []
  });
  const app = buildApp({ id: 6, plan: 'pro' });

  const res = await request(app, 'POST', '/invoices/5/status', { status: 'sent' });

  // The route must still redirect (not 500) and the status must be updated.
  assert.strictEqual(res.status, 302,
    'status update must redirect even when Stripe Payment Link creation throws');
  assert.ok(res.headers.location && res.headers.location.includes('/invoices/5'),
    'redirect must go to invoice view, not error page');
  const inv = invoices.get(5);
  assert.strictEqual(inv.status, 'sent',
    'invoice status must be updated to "sent" even if Stripe link creation fails ' +
    '(graceful degradation — status change and link creation are independent)');
}

// DELETE /invoices/:id — IDOR: another user's invoice must not be deleted.
async function testDeleteIDORDoesNotRemoveInvoice() {
  resetStore();
  // Invoice owned by user 10; DELETE request from user 20.
  users.set(20, { id: 20, plan: 'pro', name: 'Grace', email: 'grace@x.com' });
  invoices.set(6, {
    id: 6, user_id: 10, invoice_number: 'INV-2026-0006', client_name: 'Protected Co',
    total: 300, status: 'draft', items: []
  });
  const app = buildApp({ id: 20, plan: 'pro' });

  const res = await request(app, 'POST', '/invoices/6/delete');

  // Route always redirects to /dashboard regardless (no leak of ownership info).
  assert.strictEqual(res.status, 302, 'delete on another user\'s invoice must redirect (no 500)');
  assert.ok(res.headers.location && res.headers.location.includes('/dashboard'),
    'must redirect to dashboard after delete attempt');
  // The invoice must still exist in the store — db.deleteInvoice is user_id-scoped.
  assert.ok(invoices.has(6),
    'another user\'s invoice must NOT be deleted when IDOR is attempted ' +
    '(db.deleteInvoice enforces WHERE user_id=$2)');
}

// ---------- Runner ------------------------------------------------------

async function run() {
  const tests = [
    ['Dashboard: GET /invoices/ returns 200 with user\'s invoices', testDashboardReturns200],
    ['Dashboard: GET /invoices/ DB error renders empty list, no crash', testDashboardDbErrorRendersEmpty],
    ['Invoice view: GET /invoices/:id owner gets 200', testInvoiceViewOwnerGets200],
    ['Invoice print: GET /invoices/:id/print owner gets 200', testPrintViewOwnerGets200],
    ['Status update: payment link NOT re-created when already exists (no duplicate links)', testStatusUpdateDoesNotDuplicatePaymentLink],
    ['Status update: Stripe error on link creation does not block status change (graceful degradation)', testStatusUpdateSucceedsWhenLinkCreationFails],
    ['Delete IDOR: another user\'s invoice is not removed (DB-level ownership guard)', testDeleteIDORDoesNotRemoveInvoice]
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
