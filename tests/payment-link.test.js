'use strict';

/*
 * Integration tests for Stripe Payment Links on Invoices.
 *
 * Harness:
 *  - Stubs `../db` with an in-memory store so the invoices.js route can run
 *    without PostgreSQL.
 *  - Stubs `../lib/stripe-payment-link` to avoid real Stripe API calls.
 *  - Drives the feature via an express app mounted with real middleware.
 *
 * Run: node tests/payment-link.test.js
 */

const assert = require('assert');
const path = require('path');
const ejs = require('ejs');
const express = require('express');
const http = require('http');

// ---------- Stub module cache ------------------------------------------------

function clearReq(mod) {
  delete require.cache[require.resolve(mod)];
}

const users = new Map();
const invoices = new Map();
let nextInvoiceId = 1;

function resetStore() {
  users.clear();
  invoices.clear();
  nextInvoiceId = 1;
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
      inv.updated_at = new Date();
      return inv;
    },
    async setInvoicePaymentLink(id, userId, url, linkId) {
      const inv = invoices.get(parseInt(id, 10));
      if (!inv || inv.user_id !== userId) return null;
      inv.payment_link_url = url;
      inv.payment_link_id = linkId;
      return inv;
    },
    async markInvoicePaidByPaymentLinkId(linkId) {
      for (const inv of invoices.values()) {
        if (inv.payment_link_id === linkId && inv.status !== 'paid') {
          inv.status = 'paid';
          return inv;
        }
      }
      return null;
    },
    async getNextInvoiceNumber() { return 'INV-2026-0001'; },
    async createInvoice() { throw new Error('not used in these tests'); },
    async updateInvoice() { throw new Error('not used in these tests'); },
    async deleteInvoice() { throw new Error('not used in these tests'); },
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

// Intercept `require('../db')` from routes/invoices.js (and billing.js).
require.cache[require.resolve('../db')] = {
  id: require.resolve('../db'),
  filename: require.resolve('../db'),
  loaded: true,
  exports: dbStub
};

// Track Payment Link calls from the stub.
const createdLinks = [];
require.cache[require.resolve('../lib/stripe-payment-link')] = {
  id: require.resolve('../lib/stripe-payment-link'),
  filename: require.resolve('../lib/stripe-payment-link'),
  loaded: true,
  exports: {
    createInvoicePaymentLink: async (invoice, user) => {
      createdLinks.push({ invoice_id: invoice.id, user_id: user.id, total: invoice.total });
      return {
        id: `plink_test_${invoice.id}`,
        url: `https://buy.stripe.com/test_${invoice.id}`
      };
    }
  }
};

// Load the routes AFTER stubbing.
clearReq('../routes/invoices');
const invoiceRoutes = require('../routes/invoices');

// ---------- Test helpers -----------------------------------------------------

function buildApp(sessionUser) {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { user: sessionUser };
    next();
  });
  app.use('/invoices', invoiceRoutes);
  return app;
}

function request(app, method, url, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const payload = body ? new URLSearchParams(body).toString() : '';
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: url,
        method,
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

// ---------- Tests ------------------------------------------------------------

async function testProUserSentCreatesPaymentLink() {
  resetStore();
  createdLinks.length = 0;
  users.set(7, { id: 7, plan: 'pro', name: 'Test', email: 't@x.com' });
  const invoice = {
    id: nextInvoiceId++,
    user_id: 7,
    invoice_number: 'INV-2026-0001',
    client_name: 'Client',
    total: 250.00,
    status: 'draft',
    payment_link_url: null,
    payment_link_id: null,
    items: []
  };
  invoices.set(invoice.id, invoice);

  const app = buildApp({ id: 7, plan: 'pro' });
  const res = await request(app, 'POST', `/invoices/${invoice.id}/status`, { status: 'sent' });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.location, `/invoices/${invoice.id}`);

  assert.strictEqual(createdLinks.length, 1, 'exactly one Payment Link created');
  assert.strictEqual(createdLinks[0].invoice_id, invoice.id);
  assert.strictEqual(invoice.status, 'sent');
  assert.strictEqual(invoice.payment_link_url, `https://buy.stripe.com/test_${invoice.id}`);
  assert.strictEqual(invoice.payment_link_id, `plink_test_${invoice.id}`);
}

async function testFreeUserSentDoesNotCreatePaymentLink() {
  resetStore();
  createdLinks.length = 0;
  users.set(8, { id: 8, plan: 'free', name: 'Free', email: 'f@x.com' });
  const invoice = {
    id: nextInvoiceId++,
    user_id: 8,
    invoice_number: 'INV-2026-0002',
    client_name: 'Client',
    total: 100.00,
    status: 'draft',
    payment_link_url: null,
    payment_link_id: null
  };
  invoices.set(invoice.id, invoice);

  const app = buildApp({ id: 8, plan: 'free' });
  const res = await request(app, 'POST', `/invoices/${invoice.id}/status`, { status: 'sent' });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(createdLinks.length, 0, 'free user must NOT get a Payment Link');
  assert.strictEqual(invoice.status, 'sent');
  assert.strictEqual(invoice.payment_link_url, null);
}

async function testProUserAlreadyHasLinkDoesNotDuplicate() {
  resetStore();
  createdLinks.length = 0;
  users.set(9, { id: 9, plan: 'pro' });
  const invoice = {
    id: nextInvoiceId++,
    user_id: 9,
    invoice_number: 'INV-2026-0003',
    client_name: 'C',
    total: 500,
    status: 'draft',
    payment_link_url: 'https://buy.stripe.com/existing',
    payment_link_id: 'plink_existing'
  };
  invoices.set(invoice.id, invoice);

  const app = buildApp({ id: 9, plan: 'pro' });
  await request(app, 'POST', `/invoices/${invoice.id}/status`, { status: 'sent' });
  assert.strictEqual(createdLinks.length, 0, 'should not re-create if URL already present');
  assert.strictEqual(invoice.payment_link_url, 'https://buy.stripe.com/existing');
}

async function testMarkPaidSkipsPaymentLinkCreation() {
  resetStore();
  createdLinks.length = 0;
  users.set(10, { id: 10, plan: 'pro' });
  const invoice = {
    id: nextInvoiceId++,
    user_id: 10,
    invoice_number: 'INV-2026-0004',
    client_name: 'C',
    total: 500,
    status: 'sent',
    payment_link_url: null,
    payment_link_id: null
  };
  invoices.set(invoice.id, invoice);

  const app = buildApp({ id: 10, plan: 'pro' });
  await request(app, 'POST', `/invoices/${invoice.id}/status`, { status: 'paid' });
  assert.strictEqual(createdLinks.length, 0, 'no Payment Link on paid transition');
  assert.strictEqual(invoice.status, 'paid');
}

async function testWebhookMarksInvoicePaid() {
  resetStore();
  users.set(11, { id: 11, plan: 'pro' });
  const invoice = {
    id: nextInvoiceId++,
    user_id: 11,
    invoice_number: 'INV-2026-0005',
    client_name: 'C',
    total: 750,
    status: 'sent',
    payment_link_url: 'https://buy.stripe.com/test_X',
    payment_link_id: 'plink_webhook_test'
  };
  invoices.set(invoice.id, invoice);

  const updated = await dbStub.db.markInvoicePaidByPaymentLinkId('plink_webhook_test');
  assert.ok(updated, 'webhook lookup should find invoice');
  assert.strictEqual(updated.status, 'paid');
  assert.strictEqual(invoice.status, 'paid');

  // Second call is idempotent — already paid, returns null.
  const second = await dbStub.db.markInvoicePaidByPaymentLinkId('plink_webhook_test');
  assert.strictEqual(second, null, 'idempotent: already-paid invoice not returned');
}

async function testInvoiceViewRendersPayButtonForPro() {
  const tpl = path.join(__dirname, '..', 'views', 'invoice-view.ejs');
  const html = await ejs.renderFile(tpl, {
    title: 't',
    invoice: {
      id: 42,
      invoice_number: 'INV-2026-0042',
      client_name: 'C',
      client_email: '',
      client_address: '',
      items: [],
      subtotal: '100.00',
      tax_rate: '0',
      tax_amount: '0',
      total: '100.00',
      status: 'sent',
      issued_date: '2026-04-23',
      due_date: null,
      notes: '',
      payment_link_url: 'https://buy.stripe.com/test_42',
      payment_link_id: 'plink_42'
    },
    user: { id: 1, plan: 'pro', name: 'U', email: 'u@x.com' },
    flash: null
  }, { views: [path.join(__dirname, '..', 'views')] });

  // The owner-facing pay-link surface is consolidated into the dedicated
  // "Payment Link" copy-card: a readonly URL input + Copy button + a
  // "Preview ↗" anchor that opens the Stripe page in a new tab. The
  // earlier action-bar "Preview Pay Link" button was redundant with the
  // copy-card and was removed in the U4 UX consolidation.
  assert.ok(html.includes('Payment Link'),
    'Payment Link card must render for Pro user with a payment_link_url');
  assert.ok(html.includes('Preview ↗'),
    'Preview anchor must render alongside Copy in the Payment Link card');
  assert.ok(!html.includes('💳 Preview Pay Link'),
    'Old action-bar "Preview Pay Link" button must NOT render (consolidated into card)');
  // Both the readonly input value and the Preview anchor href use the URL,
  // so it should appear at least twice in the rendered HTML.
  const occurrences = html.split('https://buy.stripe.com/test_42').length - 1;
  assert.ok(occurrences >= 2,
    `Payment URL must appear in the readonly input AND the Preview anchor (got ${occurrences} occurrences)`);
}

async function testInvoiceViewHidesPayButtonForFree() {
  const tpl = path.join(__dirname, '..', 'views', 'invoice-view.ejs');
  const html = await ejs.renderFile(tpl, {
    title: 't',
    invoice: {
      id: 43,
      invoice_number: 'INV-2026-0043',
      client_name: 'C',
      client_email: '', client_address: '', items: [],
      subtotal: '100.00', tax_rate: '0', tax_amount: '0', total: '100.00',
      status: 'sent', issued_date: '2026-04-23', due_date: null, notes: '',
      payment_link_url: null, payment_link_id: null
    },
    user: { id: 1, plan: 'free', name: 'U', email: 'u@x.com' },
    flash: null
  }, { views: [path.join(__dirname, '..', 'views')] });

  assert.ok(!html.includes('💳 Pay Now'), 'Pay Now button must NOT render for free users');
}

async function testInvoicePrintRendersQRForPro() {
  const tpl = path.join(__dirname, '..', 'views', 'invoice-print.ejs');
  const html = await ejs.renderFile(tpl, {
    title: 't',
    invoice: {
      id: 51,
      invoice_number: 'INV-2026-0051',
      client_name: 'C', client_email: '', client_address: '',
      items: [], subtotal: '100.00', tax_rate: '0', tax_amount: '0', total: '100.00',
      status: 'sent', issued_date: '2026-04-23', due_date: null, notes: '',
      payment_link_url: 'https://buy.stripe.com/test_51',
      payment_link_id: 'plink_51'
    },
    user: { id: 1, plan: 'pro', name: 'U', email: 'u@x.com' }
  }, { views: [path.join(__dirname, '..', 'views')] });

  assert.ok(html.includes('Pay this invoice online'), 'print view must include payment section');
  assert.ok(html.includes('https://buy.stripe.com/test_51'), 'print URL must render');
  assert.ok(html.includes('invoice-qr'), 'QR placeholder div present');
  assert.ok(html.includes('qrcode@1.5.3'), 'QR client library loaded');
}

async function testInvoicePrintSkipsPayForFree() {
  const tpl = path.join(__dirname, '..', 'views', 'invoice-print.ejs');
  const html = await ejs.renderFile(tpl, {
    title: 't',
    invoice: {
      id: 52, invoice_number: 'INV-2026-0052', client_name: 'C',
      client_email: '', client_address: '', items: [],
      subtotal: '100.00', tax_rate: '0', tax_amount: '0', total: '100.00',
      status: 'sent', issued_date: '2026-04-23', due_date: null, notes: '',
      payment_link_url: null, payment_link_id: null
    },
    user: { id: 1, plan: 'free', name: 'U', email: 'u@x.com' }
  }, { views: [path.join(__dirname, '..', 'views')] });

  assert.ok(!html.includes('Pay this invoice online'), 'free plan must not show pay section');
}

async function testStripePaymentLinkHelperBuildsCorrectCalls() {
  // Load the real helper with a stubbed stripe client.
  clearReq('../lib/stripe-payment-link');
  const { createInvoicePaymentLink } = require('../lib/stripe-payment-link');

  const calls = [];
  const stripeClient = {
    products: { create: async (o) => { calls.push(['products.create', o]); return { id: 'prod_x' }; } },
    prices:   { create: async (o) => { calls.push(['prices.create', o]);   return { id: 'price_x' }; } },
    paymentLinks: { create: async (o) => { calls.push(['paymentLinks.create', o]); return { id: 'plink_x', url: 'https://buy.stripe.com/test_x' }; } }
  };

  const out = await createInvoicePaymentLink(
    { id: 99, invoice_number: 'INV-2026-0099', total: '321.50' },
    { id: 5 },
    stripeClient
  );

  assert.deepStrictEqual(out, { id: 'plink_x', url: 'https://buy.stripe.com/test_x' });
  assert.strictEqual(calls[0][0], 'products.create');
  assert.strictEqual(calls[0][1].name, 'Invoice INV-2026-0099');
  assert.strictEqual(calls[1][0], 'prices.create');
  assert.strictEqual(calls[1][1].unit_amount, 32150, 'unit_amount is dollars * 100, rounded');
  assert.strictEqual(calls[1][1].currency, 'usd');
  assert.strictEqual(calls[2][0], 'paymentLinks.create');
  assert.strictEqual(calls[2][1].line_items[0].price, 'price_x');
  assert.strictEqual(calls[2][1].metadata.invoice_id, '99');
}

async function testStripePaymentLinkRejectsBelowMinimum() {
  clearReq('../lib/stripe-payment-link');
  const { createInvoicePaymentLink } = require('../lib/stripe-payment-link');
  const stripeClient = {
    products: { create: async () => ({ id: 'p' }) },
    prices: { create: async () => ({ id: 'pr' }) },
    paymentLinks: { create: async () => ({ id: 'pl', url: 'u' }) }
  };
  await assert.rejects(
    createInvoicePaymentLink({ id: 1, invoice_number: 'x', total: '0.10' }, { id: 1 }, stripeClient),
    /below Stripe minimum/i
  );
}

// ---------- Runner -----------------------------------------------------------

async function run() {
  const tests = [
    ['Pro user: POST /status sent creates Payment Link', testProUserSentCreatesPaymentLink],
    ['Free user: POST /status sent skips Payment Link', testFreeUserSentDoesNotCreatePaymentLink],
    ['Pro user with existing link: no duplicate', testProUserAlreadyHasLinkDoesNotDuplicate],
    ['Transition to paid: no Payment Link created', testMarkPaidSkipsPaymentLinkCreation],
    ['Webhook: markInvoicePaidByPaymentLinkId is idempotent', testWebhookMarksInvoicePaid],
    ['View: Pro renders Pay Now button', testInvoiceViewRendersPayButtonForPro],
    ['View: Free hides Pay Now button', testInvoiceViewHidesPayButtonForFree],
    ['Print: Pro renders QR + URL', testInvoicePrintRendersQRForPro],
    ['Print: Free has no pay section', testInvoicePrintSkipsPayForFree],
    ['Helper: Stripe calls use correct params', testStripePaymentLinkHelperBuildsCorrectCalls],
    ['Helper: rejects totals below $0.50', testStripePaymentLinkRejectsBelowMinimum]
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
