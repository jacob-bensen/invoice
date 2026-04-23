'use strict';

/*
 * Invoice CRUD integration tests.
 *
 * Covers paths that were absent from the existing suite:
 *  - POST /invoices/new success: creates invoice, redirects to invoice view
 *  - POST /invoices/new validation: blank client_name → 200 + error message
 *  - GET  /invoices/:id/edit owner: 200 (edit form loads)
 *  - GET  /invoices/:id/edit IDOR: wrong user → 302 /dashboard
 *  - POST /invoices/:id/edit owner: redirects to invoice view
 *  - POST /invoices/:id/edit IDOR: db.updateInvoice called with session user_id (DB-level guard)
 *  - GET  /invoices/:id/print IDOR: wrong user → 302 /dashboard
 *  - POST /invoices/:id/status: redirects back to invoice view
 *
 * Run: node tests/invoice-crud.test.js
 */

const assert = require('assert');
const path = require('path');
const express = require('express');
const http = require('http');

// ---------- Stubs -------------------------------------------------------

const users = new Map();
const invoices = new Map();
let nextInvoiceId = 1;
const createInvoiceCalls = [];
const updateInvoiceCalls = [];

function resetStore() {
  users.clear();
  invoices.clear();
  nextInvoiceId = 1;
  createInvoiceCalls.length = 0;
  updateInvoiceCalls.length = 0;
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
    async getNextInvoiceNumber() { return 'INV-2026-0001'; },
    async createInvoice(data) {
      const id = nextInvoiceId++;
      const inv = { id, ...data, status: 'draft', payment_link_url: null, payment_link_id: null };
      invoices.set(id, inv);
      createInvoiceCalls.push(inv);
      return inv;
    },
    async updateInvoice(id, userId, data) {
      updateInvoiceCalls.push({ id: parseInt(id, 10), userId, data });
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
    createInvoicePaymentLink: async (invoice) => ({
      id: `plink_test_${invoice.id}`,
      url: `https://buy.stripe.com/test_${invoice.id}`
    })
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

async function testCreateInvoiceSuccess() {
  resetStore();
  users.set(1, { id: 1, plan: 'pro', invoice_count: 5, name: 'Alice', email: 'alice@x.com' });
  const app = buildApp({ id: 1, plan: 'pro', invoice_count: 5 });

  const res = await request(app, 'POST', '/invoices/new', {
    client_name: 'Acme Corp',
    client_email: 'billing@acme.com',
    invoice_number: 'INV-2026-0006',
    items: JSON.stringify([{ description: 'Consulting', quantity: 1, rate: 500, amount: 500 }]),
    subtotal: '500',
    tax_rate: '0',
    tax_amount: '0',
    total: '500',
    issued_date: '2026-04-23',
    due_date: '2026-05-23'
  });

  assert.strictEqual(res.status, 302, 'successful invoice creation must redirect');
  assert.ok(res.headers.location.includes('/invoices/'), 'must redirect to the new invoice view');
  assert.strictEqual(createInvoiceCalls.length, 1, 'db.createInvoice must be called exactly once');
  assert.strictEqual(createInvoiceCalls[0].client_name, 'Acme Corp', 'client_name must be persisted');
  assert.strictEqual(createInvoiceCalls[0].total, 500, 'invoice total must be persisted correctly');
}

async function testCreateInvoiceValidationError() {
  resetStore();
  users.set(2, { id: 2, plan: 'pro', invoice_count: 2, name: 'Bob', email: 'bob@x.com' });
  const app = buildApp({ id: 2, plan: 'pro', invoice_count: 2 });

  const res = await request(app, 'POST', '/invoices/new', {
    client_name: '   ',  // blank after trim — fails notEmpty
    items: JSON.stringify([]),
    subtotal: '0', tax_rate: '0', tax_amount: '0', total: '0'
  });

  assert.strictEqual(res.status, 200, 'validation error must re-render form (200), not redirect');
  assert.ok(res.body.includes('Client name is required'),
    'validation error message must appear in the rendered response');
  assert.strictEqual(createInvoiceCalls.length, 0,
    'db.createInvoice must NOT be called when validation fails');
}

async function testEditFormOwnerAccess() {
  resetStore();
  users.set(3, { id: 3, plan: 'pro', name: 'Carol', email: 'carol@x.com' });
  const inv = {
    id: nextInvoiceId++, user_id: 3, invoice_number: 'INV-1',
    client_name: 'Client A', total: 100, status: 'draft', items: [],
    issued_date: new Date('2026-04-23'), due_date: null
  };
  invoices.set(inv.id, inv);
  const app = buildApp({ id: 3, plan: 'pro' });

  const res = await request(app, 'GET', `/invoices/${inv.id}/edit`);
  assert.strictEqual(res.status, 200, 'invoice owner must be able to load the edit form');
}

async function testEditFormIDOR() {
  resetStore();
  // Invoice belongs to user 10; requesting as user 20.
  const inv = {
    id: nextInvoiceId++, user_id: 10, invoice_number: 'INV-2',
    client_name: 'Other Client', total: 200, status: 'draft', items: []
  };
  invoices.set(inv.id, inv);
  users.set(20, { id: 20, plan: 'pro', name: 'Eve', email: 'eve@x.com' });
  const app = buildApp({ id: 20, plan: 'pro' });

  const res = await request(app, 'GET', `/invoices/${inv.id}/edit`);
  assert.strictEqual(res.status, 302, 'accessing another user\'s edit form must redirect');
  assert.ok(res.headers.location.includes('/dashboard'),
    'IDOR on GET /edit must redirect to /dashboard');
}

async function testPostEditOwnerRedirects() {
  resetStore();
  users.set(4, { id: 4, plan: 'pro', name: 'Dave', email: 'dave@x.com' });
  const inv = {
    id: nextInvoiceId++, user_id: 4, invoice_number: 'INV-3',
    client_name: 'Old Name', total: 300, status: 'draft', items: []
  };
  invoices.set(inv.id, inv);
  const app = buildApp({ id: 4, plan: 'pro' });

  const res = await request(app, 'POST', `/invoices/${inv.id}/edit`, {
    client_name: 'New Name',
    client_email: '',
    client_address: '',
    items: JSON.stringify([]),
    subtotal: '300', tax_rate: '0', tax_amount: '0', total: '300',
    issued_date: '2026-04-23',
    status: 'draft'
  });

  assert.strictEqual(res.status, 302, 'successful edit must redirect');
  assert.ok(res.headers.location.includes(`/invoices/${inv.id}`),
    'edit redirect must target the invoice view');
  const call = updateInvoiceCalls.find(c => c.userId === 4);
  assert.ok(call, 'db.updateInvoice must be called with the session user\'s ID');
  assert.strictEqual(call.data.client_name, 'New Name', 'updated client_name must reach the db');
}

async function testPostEditIDOR() {
  resetStore();
  // Invoice belongs to user 10; request comes from user 30.
  const inv = {
    id: nextInvoiceId++, user_id: 10, invoice_number: 'INV-4',
    client_name: 'Protected', total: 400, status: 'draft', items: []
  };
  invoices.set(inv.id, inv);
  users.set(30, { id: 30, plan: 'pro', name: 'Frank', email: 'frank@x.com' });
  const app = buildApp({ id: 30, plan: 'pro' });

  await request(app, 'POST', `/invoices/${inv.id}/edit`, {
    client_name: 'Hijacked',
    items: JSON.stringify([]),
    subtotal: '0', tax_rate: '0', tax_amount: '0', total: '0',
    issued_date: '2026-04-23', status: 'draft'
  });

  // The route always calls db.updateInvoice with the session user's id (not the invoice owner's).
  // The DB query enforces ownership via WHERE user_id=$2 — so the update silently no-ops.
  const call = updateInvoiceCalls.find(c => c.id === inv.id);
  assert.ok(call, 'db.updateInvoice must be attempted');
  assert.strictEqual(call.userId, 30,
    'db.updateInvoice must receive the session user\'s ID, not the invoice owner\'s ID');
  assert.strictEqual(inv.client_name, 'Protected',
    'invoice data must remain unchanged when the session user does not own it (DB-level IDOR protection)');
}

async function testPrintViewIDOR() {
  resetStore();
  // Invoice belongs to user 10; requesting as user 40.
  const inv = {
    id: nextInvoiceId++, user_id: 10, invoice_number: 'INV-5',
    client_name: 'Secret Client', total: 500, status: 'sent', items: []
  };
  invoices.set(inv.id, inv);
  users.set(40, { id: 40, plan: 'pro', name: 'Grace', email: 'grace@x.com' });
  const app = buildApp({ id: 40, plan: 'pro' });

  const res = await request(app, 'GET', `/invoices/${inv.id}/print`);
  assert.strictEqual(res.status, 302,
    'requesting another user\'s print view must redirect (IDOR guard)');
  assert.ok(res.headers.location.includes('/dashboard'),
    'IDOR on GET /print must redirect to /dashboard');
}

async function testStatusUpdateRedirectsToInvoice() {
  resetStore();
  users.set(5, { id: 5, plan: 'free', name: 'Heidi', email: 'heidi@x.com' });
  const inv = {
    id: nextInvoiceId++, user_id: 5, invoice_number: 'INV-6',
    client_name: 'Test Client', total: 150, status: 'draft',
    payment_link_url: null, payment_link_id: null, items: []
  };
  invoices.set(inv.id, inv);
  const app = buildApp({ id: 5, plan: 'free' });

  const res = await request(app, 'POST', `/invoices/${inv.id}/status`, { status: 'sent' });
  assert.strictEqual(res.status, 302, 'status update must redirect');
  assert.ok(res.headers.location.includes(`/invoices/${inv.id}`),
    'status update must redirect back to the invoice view, not to dashboard or elsewhere');
}

// ---------- Runner ------------------------------------------------------

async function run() {
  const tests = [
    ['Create invoice: valid data → creates record + redirects to invoice view', testCreateInvoiceSuccess],
    ['Create invoice: blank client_name → 200 with validation error (form re-render)', testCreateInvoiceValidationError],
    ['Edit invoice: GET /edit owner → 200', testEditFormOwnerAccess],
    ['Edit invoice: GET /edit IDOR — wrong user → 302 /dashboard', testEditFormIDOR],
    ['Edit invoice: POST /edit owner → 302 to invoice view + db.updateInvoice called', testPostEditOwnerRedirects],
    ['Edit invoice: POST /edit IDOR — db.updateInvoice called with session user_id (DB-level guard)', testPostEditIDOR],
    ['Print view: GET /print IDOR — wrong user → 302 /dashboard', testPrintViewIDOR],
    ['Status update: POST /status → 302 back to invoice view', testStatusUpdateRedirectsToInvoice]
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
