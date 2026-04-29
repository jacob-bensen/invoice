'use strict';

/*
 * Agency-plan coverage for the outbound (Zapier-style) paid webhook.
 *
 * Why this file exists (Test Examiner gap closure):
 *   The existing `tests/webhook-outbound.test.js` and
 *   `tests/webhook-outbound-from-stripe.test.js` together cover the Pro plan
 *   path comprehensively. Both call sites — `routes/invoices.js POST /:id/status`
 *   (manual mark-paid) and `routes/billing.js POST /webhook` (Stripe-driven
 *   payment_link checkout) — gate the outbound fire on
 *   `(user.plan === 'pro' || user.plan === 'agency') && user.webhook_url`.
 *   The 'agency' branch was previously asserted only inline in a Pro test
 *   comment, never exercised. With H5 (DONE 2026-04-25) widening the
 *   `users_plan_check` constraint to include 'agency' the path is now
 *   reachable in production — and the Agency tier ($49/mo) is the
 *   highest-ARPU plan, so a silent regression on this branch would
 *   disproportionately hit the most income-critical customers.
 *
 * Tests in this file:
 *   1. POST /invoices/:id/status=paid by an Agency-plan owner with a webhook
 *      URL fires the outbound webhook with the correct payload (manual path).
 *   2. POST /billing/webhook (Stripe checkout.session.completed for a
 *      payment_link) by an Agency-plan owner with a webhook URL fires the
 *      outbound webhook (Stripe-driven path).
 *   3. POST /invoices/:id/status=paid by an Agency-plan owner WITHOUT a
 *      webhook URL skips the fire (parity with the Pro behaviour — webhook is
 *      opt-in per user).
 *
 * Run: NODE_ENV=test node tests/webhook-outbound-agency.test.js
 */

const assert = require('assert');
const express = require('express');
const http = require('http');

function clearReq(mod) { delete require.cache[require.resolve(mod)]; }

// ---------- Stubs --------------------------------------------------------

const users = new Map();
const invoices = new Map();
const fireCalls = [];
let constructEventImpl = null;

function reset() {
  users.clear();
  invoices.clear();
  fireCalls.length = 0;
  constructEventImpl = null;
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
    async markInvoicePaidByPaymentLinkId(linkId) {
      for (const inv of invoices.values()) {
        if (inv.payment_link_id === linkId && inv.status !== 'paid') {
          inv.status = 'paid';
          return inv;
        }
      }
      return null;
    },
    async getNextInvoiceNumber() { return 'INV-2026-9999'; },
    async getUserByEmail() { return null; },
    async updateUser(id, fields) {
      const u = users.get(id);
      if (u) Object.assign(u, fields);
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

// Spy on the outbound-webhook helper so we capture every fire attempt.
require.cache[require.resolve('../lib/outbound-webhook')] = {
  id: require.resolve('../lib/outbound-webhook'),
  filename: require.resolve('../lib/outbound-webhook'),
  loaded: true,
  exports: {
    isValidWebhookUrl: async () => true,
    firePaidWebhook: async (url, payload) => {
      fireCalls.push({ url, payload });
      return { ok: true, status: 200 };
    },
    buildPaidPayload: (invoice) => ({
      event: 'invoice.paid',
      invoice_id: invoice.id,
      amount: invoice.total,
      client_name: invoice.client_name,
      paid_at: new Date().toISOString()
    })
  }
};

// Stripe payment-link helper — never reached on a `mark as paid` transition,
// but the route imports it eagerly so we still have to provide a stub.
require.cache[require.resolve('../lib/stripe-payment-link')] = {
  id: require.resolve('../lib/stripe-payment-link'),
  filename: require.resolve('../lib/stripe-payment-link'),
  loaded: true,
  exports: {
    createInvoicePaymentLink: async () => ({ id: 'plink_unused', url: 'https://buy.stripe.com/unused' }),
    parsePaymentMethods: () => ['card']
  }
};

// Stripe SDK stub for the billing webhook path.
require.cache[require.resolve('stripe')] = {
  id: require.resolve('stripe'),
  filename: require.resolve('stripe'),
  loaded: true,
  exports: () => ({
    customers: { create: async () => ({ id: 'cus_x' }), retrieve: async () => ({ metadata: {} }) },
    checkout: { sessions: { create: async () => ({ id: 'cs_x', url: 'https://stripe' }) } },
    billingPortal: { sessions: { create: async () => ({ url: 'https://portal' }) } },
    subscriptions: { retrieve: async () => ({ trial_end: null }) },
    webhooks: {
      constructEvent: (raw, sig, secret) => {
        if (!constructEventImpl) throw new Error('constructEventImpl not set for this test');
        return constructEventImpl(raw, sig, secret);
      }
    }
  })
};

// Suppress the paid-notification email path — orthogonal to this file.
require.cache[require.resolve('../lib/email')] = {
  id: require.resolve('../lib/email'),
  filename: require.resolve('../lib/email'),
  loaded: true,
  exports: {
    sendPaidNotificationEmail: async () => ({ ok: false, reason: 'not_configured' }),
    sendInvoiceEmail: async () => ({ ok: false, reason: 'not_configured' })
  }
};

clearReq('../routes/invoices');
clearReq('../routes/billing');
const invoiceRoutes = require('../routes/invoices');
const billingRoutes = require('../routes/billing');

// ---------- App builders -------------------------------------------------

function buildInvoiceApp(sessionUser) {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { user: sessionUser, flash: null }; next(); });
  app.use('/invoices', invoiceRoutes);
  return app;
}

function buildBillingApp() {
  const app = express();
  // /billing/webhook needs raw body — billingRoutes wires this internally.
  app.use('/billing', billingRoutes);
  return app;
}

// ---------- HTTP helper --------------------------------------------------

function postForm(app, url, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const payload = body ? new URLSearchParams(body).toString() : '';
      const req = http.request({
        hostname: '127.0.0.1', port, path: url, method: 'POST',
        headers: payload
          ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(payload) }
          : {}
      }, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => server.close(() => resolve({ status: res.statusCode, headers: res.headers, body: data })));
      });
      req.on('error', err => { server.close(); reject(err); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

function postRawJson(app, url, jsonString) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const req = http.request({
        hostname: '127.0.0.1', port, path: url, method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(jsonString),
          'stripe-signature': 'test-sig'
        }
      }, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => server.close(() => resolve({ status: res.statusCode, headers: res.headers, body: data })));
      });
      req.on('error', err => { server.close(); reject(err); });
      req.write(jsonString);
      req.end();
    });
  });
}

// ---------- Tests --------------------------------------------------------

async function testAgencyManualMarkPaidFiresOutbound() {
  reset();
  users.set(101, {
    id: 101, plan: 'agency', email: 'a@x.com',
    webhook_url: 'https://hooks.example.com/agency-zap'
  });
  invoices.set(900, {
    id: 900, user_id: 101, invoice_number: 'INV-2026-0900', client_name: 'BigCo',
    total: 4500, status: 'sent',
    payment_link_url: 'https://buy.stripe.com/test_900',
    payment_link_id: 'plink_900', items: []
  });

  const app = buildInvoiceApp({ id: 101, plan: 'agency' });
  await postForm(app, '/invoices/900/status', { status: 'paid' });
  await new Promise(r => setImmediate(r));

  assert.strictEqual(fireCalls.length, 1,
    'Agency-plan owner with webhook_url must fire exactly one outbound webhook on manual mark-paid');
  assert.strictEqual(fireCalls[0].url, 'https://hooks.example.com/agency-zap',
    'outbound URL must be the owner\'s configured webhook_url');
  assert.strictEqual(fireCalls[0].payload.invoice_id, 900,
    'payload must reference the paid invoice');
  assert.strictEqual(fireCalls[0].payload.amount, 4500,
    'payload must carry the correct amount');
  assert.strictEqual(fireCalls[0].payload.client_name, 'BigCo',
    'payload must carry the client_name');
}

async function testAgencyStripeWebhookFiresOutbound() {
  reset();
  users.set(102, {
    id: 102, plan: 'agency', email: 'b@x.com',
    webhook_url: 'https://hooks.example.com/agency-stripe'
  });
  invoices.set(901, {
    id: 901, user_id: 102, invoice_number: 'INV-2026-0901', client_name: 'BigCo Stripe',
    total: 7500, status: 'sent',
    payment_link_url: 'https://buy.stripe.com/test_901',
    payment_link_id: 'plink_901', items: []
  });

  // Build the Stripe event the webhook constructEvent would normally produce
  // from the raw body + signature. Our stub returns this object verbatim.
  constructEventImpl = () => ({
    id: 'evt_agency_test',
    type: 'checkout.session.completed',
    data: { object: { mode: 'payment', payment_link: 'plink_901' } }
  });

  const app = buildBillingApp();
  const res = await postRawJson(app, '/billing/webhook', JSON.stringify({ type: 'checkout.session.completed' }));
  await new Promise(r => setImmediate(r));

  assert.strictEqual(res.status, 200,
    'Stripe webhook must respond 200 even when outbound fire is in flight (fire-and-forget)');
  assert.strictEqual(fireCalls.length, 1,
    'Agency-plan owner with webhook_url must fire exactly one outbound webhook on Stripe-driven payment');
  assert.strictEqual(fireCalls[0].url, 'https://hooks.example.com/agency-stripe',
    'outbound URL must be the owner\'s configured webhook_url');
  assert.strictEqual(fireCalls[0].payload.invoice_id, 901);
  assert.strictEqual(invoices.get(901).status, 'paid',
    'invoice status must flip to paid via markInvoicePaidByPaymentLinkId');
}

async function testAgencyWithoutWebhookUrlSkipsOutbound() {
  reset();
  // Agency owner without webhook_url — webhook is opt-in per user.
  users.set(103, { id: 103, plan: 'agency', email: 'c@x.com', webhook_url: null });
  invoices.set(902, {
    id: 902, user_id: 103, invoice_number: 'INV-2026-0902', client_name: 'NoHook',
    total: 1000, status: 'sent',
    payment_link_url: 'https://buy.stripe.com/test_902',
    payment_link_id: 'plink_902', items: []
  });

  const app = buildInvoiceApp({ id: 103, plan: 'agency' });
  await postForm(app, '/invoices/902/status', { status: 'paid' });
  await new Promise(r => setImmediate(r));

  assert.strictEqual(fireCalls.length, 0,
    'Agency owner without webhook_url must NOT fire any outbound webhook ' +
    '(plan gate is necessary but not sufficient — webhook_url is also required)');
}

// ---------- Runner -------------------------------------------------------

async function run() {
  const tests = [
    ['Agency manual mark-paid → outbound fires with correct payload', testAgencyManualMarkPaidFiresOutbound],
    ['Agency Stripe webhook (payment_link checkout) → outbound fires', testAgencyStripeWebhookFiresOutbound],
    ['Agency owner without webhook_url → outbound skipped', testAgencyWithoutWebhookUrlSkipsOutbound]
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
