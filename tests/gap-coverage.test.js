'use strict';

/*
 * Gap-coverage tests for income-critical paths not yet exercised.
 *
 * Paths covered (10 new tests):
 *  1.  billing.js checkout.session.completed (payment_link) → firePaidWebhook fires
 *      for Pro owner — the Stripe-paid path was only tested for markInvoicePaidByPaymentLinkId,
 *      never for the downstream outbound webhook call.
 *  2.  Same billing.js path but with an Agency-plan owner — Agency gets all Pro features.
 *  3.  billing.js payment_link checkout → no outbound fire when owner has no webhook_url.
 *  4.  invoices.js POST /:id/status=paid with Agency-plan user → outbound webhook fires
 *      (existing webhook-outbound.test.js only tests Pro; agency branch is untested).
 *  5.  GET /invoices/ dashboard refreshes session.user.plan from DB — the mechanism
 *      that makes Stripe dunning webhooks visible without re-login.
 *  6.  POST /invoices/new when db.createInvoice throws → form re-rendered with error,
 *      no unhandled 500.
 *  7.  GET /billing/upgrade → 200 with pricing content (route exists, never hit in tests).
 *  8.  GET /invoices/:id when db.getInvoiceById throws → redirect to /dashboard, no 500.
 *  9.  GET /invoices/:id/print when db.getInvoiceById throws → redirect to /dashboard,
 *      no 500.
 * 10.  POST /invoices/:id/status when db.updateInvoiceStatus throws → redirect, no 500.
 *
 * All external I/O (pg, Stripe, http) is stubbed — no real network calls.
 *
 * Run: node tests/gap-coverage.test.js
 */

const assert = require('assert');
const path = require('path');
const express = require('express');
const http = require('http');

function clearReq(mod) { delete require.cache[require.resolve(mod)]; }

// ---------- Control flags (declared before the stub so closures see them) --

let dbCreateInvoiceShouldThrow = false;
let dbUpdateStatusShouldThrow = false;
let dbGetInvoiceByIdShouldThrow = false;
let markPaidResult = null; // null | fn(linkId) => invoice

// ---------- In-memory store -----------------------------------------------

const users = new Map();
const invoices = new Map();
let nextInvoiceId = 1;
const outboundFires = [];
const poolQueries = [];

function resetStore() {
  users.clear();
  invoices.clear();
  nextInvoiceId = 1;
  outboundFires.length = 0;
  poolQueries.length = 0;
  markPaidResult = null;
  dbCreateInvoiceShouldThrow = false;
  dbUpdateStatusShouldThrow = false;
  dbGetInvoiceByIdShouldThrow = false;
}

// ---------- DB Stub --------------------------------------------------------

const dbStub = {
  pool: {
    query: async (sql, params) => {
      poolQueries.push({ sql, params });
      return { rows: [] };
    }
  },
  db: {
    async getUserById(id) { return users.get(id) || null; },
    async getUserByEmail() { return null; },
    async createUser() { throw new Error('not used'); },
    async updateUser(id, fields) {
      const u = users.get(id);
      if (u) Object.assign(u, fields);
      return u || null;
    },
    async getInvoicesByUser(userId) {
      return [...invoices.values()].filter(i => i.user_id === userId);
    },
    async getInvoiceById(id, userId) {
      if (dbGetInvoiceByIdShouldThrow) throw new Error('DB connection lost');
      const inv = invoices.get(parseInt(id, 10));
      if (!inv || inv.user_id !== userId) return null;
      return inv;
    },
    async createInvoice(data) {
      if (dbCreateInvoiceShouldThrow) throw new Error('DB insert error');
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
      if (dbUpdateStatusShouldThrow) throw new Error('DB status update error');
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
      return markPaidResult ? markPaidResult(linkId) : null;
    },
    async deleteInvoice(id, userId) {
      const inv = invoices.get(parseInt(id, 10));
      if (!inv || inv.user_id !== userId) return null;
      invoices.delete(parseInt(id, 10));
      return { id };
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
// Load the real module first to reuse isValidWebhookUrl and buildPaidPayload,
// then replace the cache entry with a stub that records fires.

const { buildPaidPayload: realBuildPaidPayload, isValidWebhookUrl: realIsValidWebhookUrl } =
  require('../lib/outbound-webhook');

const outboundStub = {
  isValidWebhookUrl: realIsValidWebhookUrl,
  buildPaidPayload: realBuildPaidPayload,
  firePaidWebhook: async (url, payload) => {
    outboundFires.push({ url, payload });
    return { ok: true, status: 200 };
  }
};

require.cache[require.resolve('../lib/outbound-webhook')] = {
  id: require.resolve('../lib/outbound-webhook'),
  filename: require.resolve('../lib/outbound-webhook'),
  loaded: true,
  exports: outboundStub
};

// ---------- Stripe Payment Link stub (safe no-op) -------------------------

require.cache[require.resolve('../lib/stripe-payment-link')] = {
  id: require.resolve('../lib/stripe-payment-link'),
  filename: require.resolve('../lib/stripe-payment-link'),
  loaded: true,
  exports: { createInvoicePaymentLink: async () => null }
};

// ---------- Stripe SDK stub -----------------------------------------------

let constructEventImpl = null;

const mockStripeClient = {
  webhooks: {
    constructEvent(body, sig, secret) {
      if (!constructEventImpl) throw new Error('constructEventImpl not set for this test');
      return constructEventImpl(body, sig, secret);
    }
  },
  customers: {
    async retrieve() { return { metadata: { user_id: '1' } }; }
  },
  checkout: {
    sessions: {
      async create() { return { url: 'https://checkout.stripe.com/pay/test' }; }
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

// ---------- Load routes (after all stubs installed) -----------------------

clearReq('../routes/invoices');
clearReq('../routes/billing');
const invoiceRoutes = require('../routes/invoices');
const billingRoutes = require('../routes/billing');

// ---------- App builders --------------------------------------------------

function buildApp(sessionUser) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { user: sessionUser ? { ...sessionUser } : null };
    next();
  });
  // Mirror server.js global middleware: set res.locals.user from session.
  app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    next();
  });
  app.use('/invoices', invoiceRoutes);
  app.use('/billing', billingRoutes);
  return app;
}

function buildWebhookApp() {
  const app = express();
  // Webhook route must receive raw body — mirror server.js setup.
  app.use('/billing/webhook', express.raw({ type: 'application/json' }));
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { user: null }; next(); });
  app.use('/billing', billingRoutes);
  return app;
}

// ---------- HTTP helpers --------------------------------------------------

function request(app, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const payload = body ? new URLSearchParams(body).toString() : '';
      const req = http.request({
        hostname: '127.0.0.1', port, path: urlPath, method,
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

function webhookRequest(body, sig) {
  const app = buildWebhookApp();
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const bodyBuf = Buffer.from(JSON.stringify(body));
      const req = http.request({
        hostname: '127.0.0.1', port,
        path: '/billing/webhook', method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': bodyBuf.length,
          'stripe-signature': sig || 'valid-sig'
        }
      }, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => server.close(() => resolve({ status: res.statusCode, body: data })));
      });
      req.on('error', err => { server.close(); reject(err); });
      req.write(bodyBuf);
      req.end();
    });
  });
}

// ---------- Tests ---------------------------------------------------------

// 1. billing.js: Stripe payment_link checkout → outbound webhook fires for Pro owner.
// This is a different code path than invoices.js — billing.js receives the
// checkout.session.completed event from Stripe and must also notify the user's
// Zapier/webhook URL, not just mark the invoice paid.
async function testStripePaymentLinkWebhookFiresOutboundForPro() {
  resetStore();
  users.set(10, {
    id: 10, plan: 'pro',
    webhook_url: 'https://hooks.zapier.com/hooks/catch/10/pro-billing'
  });
  const invoice = {
    id: 50, user_id: 10,
    invoice_number: 'INV-2026-0050',
    client_name: 'Billing Webhook Client',
    client_email: 'bwc@x.com',
    total: 500,
    status: 'sent',
    payment_link_id: 'plink_paid_123'
  };
  markPaidResult = () => invoice;

  const event = {
    type: 'checkout.session.completed',
    data: { object: { mode: 'payment', payment_link: 'plink_paid_123' } }
  };
  constructEventImpl = () => event;

  const res = await webhookRequest(event);
  assert.strictEqual(res.status, 200, 'webhook endpoint must return 200');

  // Fire-and-forget — flush the microtask queue.
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));

  assert.strictEqual(outboundFires.length, 1,
    'firePaidWebhook must be called once when Stripe payment_link checkout completes ' +
    'and the invoice owner is Pro with a webhook_url');
  assert.strictEqual(outboundFires[0].url,
    'https://hooks.zapier.com/hooks/catch/10/pro-billing');
  assert.strictEqual(outboundFires[0].payload.event, 'invoice.paid');
  assert.strictEqual(outboundFires[0].payload.invoice_id, 50);
}

// 2. billing.js: Same Stripe-paid path but with an Agency-plan owner.
// Agency plan includes all Pro features — outbound webhook must fire for them too.
async function testStripePaymentLinkWebhookFiresOutboundForAgency() {
  resetStore();
  users.set(11, {
    id: 11, plan: 'agency',
    webhook_url: 'https://hooks.zapier.com/hooks/catch/11/agency-billing'
  });
  const invoice = {
    id: 51, user_id: 11,
    invoice_number: 'INV-2026-0051',
    client_name: 'Agency Billing Client',
    client_email: 'abc@x.com',
    total: 1200,
    status: 'sent',
    payment_link_id: 'plink_agency_456'
  };
  markPaidResult = () => invoice;

  const event = {
    type: 'checkout.session.completed',
    data: { object: { mode: 'payment', payment_link: 'plink_agency_456' } }
  };
  constructEventImpl = () => event;

  const res = await webhookRequest(event);
  assert.strictEqual(res.status, 200);

  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));

  assert.strictEqual(outboundFires.length, 1,
    'Agency plan must trigger outbound webhook on Stripe payment_link checkout — Agency includes all Pro features');
  assert.strictEqual(outboundFires[0].payload.invoice_id, 51);
}

// 3. billing.js: Stripe payment_link checkout → no outbound fire when owner
// has no webhook_url configured.  Invoice is still marked paid; fire is silently skipped.
async function testStripePaymentLinkWebhookNoFireWhenNoWebhookUrl() {
  resetStore();
  users.set(12, { id: 12, plan: 'pro', webhook_url: null });
  const invoice = {
    id: 52, user_id: 12,
    invoice_number: 'INV-2026-0052',
    client_name: 'No Hook',
    total: 250,
    status: 'sent',
    payment_link_id: 'plink_no_hook'
  };
  markPaidResult = () => invoice;

  const event = {
    type: 'checkout.session.completed',
    data: { object: { mode: 'payment', payment_link: 'plink_no_hook' } }
  };
  constructEventImpl = () => event;

  await webhookRequest(event);
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));

  assert.strictEqual(outboundFires.length, 0,
    'no outbound fire when the Pro owner has no webhook_url configured');
}

// 4. invoices.js: Agency-plan user's invoice marked paid via status route →
// outbound webhook fires.  The existing webhook-outbound.test.js only tests
// plan='pro'; this verifies the `plan === 'agency'` branch of the same condition.
async function testAgencyPlanFiresOutboundWebhookOnStatusPaid() {
  resetStore();
  users.set(20, {
    id: 20, plan: 'agency',
    webhook_url: 'https://hooks.example.com/agency-hook'
  });
  const inv = {
    id: nextInvoiceId++, user_id: 20,
    invoice_number: 'INV-2026-0020',
    client_name: 'Agency Co',
    client_email: 'pay@agency.com',
    total: 3000,
    status: 'sent',
    // pre-existing link prevents Stripe link creation from interfering.
    payment_link_url: 'https://buy.stripe.com/existing',
    payment_link_id: 'plink_existing',
    items: []
  };
  invoices.set(inv.id, inv);

  const app = buildApp({ id: 20, plan: 'agency' });
  const res = await request(app, 'POST', `/invoices/${inv.id}/status`, { status: 'paid' });
  assert.strictEqual(res.status, 302, 'status update must redirect');

  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));

  assert.strictEqual(outboundFires.length, 1,
    'Agency plan must fire outbound webhook on paid transition — Agency includes all Pro features');
  assert.strictEqual(outboundFires[0].payload.amount, 3000,
    'outbound payload must carry the correct invoice amount');
}

// 5. GET /invoices/ dashboard refreshes session.user.plan from the DB on every load.
// This is the key mechanism that makes Stripe dunning webhooks visible to the user
// on their next page view without requiring a logout/re-login.
async function testDashboardRefreshesSessionPlanFromDb() {
  resetStore();
  // DB has the user upgraded to Pro (e.g. after a successful Stripe Smart Retry).
  users.set(30, {
    id: 30, plan: 'pro', name: 'Upgraded',
    email: 'up@x.com', invoice_count: 0, subscription_status: 'active'
  });
  // Session still carries the stale 'free' plan from before the webhook fired.
  const app = buildApp({ id: 30, plan: 'free', name: 'Upgraded', email: 'up@x.com' });

  const res = await request(app, 'GET', '/invoices/');
  assert.strictEqual(res.status, 200, 'dashboard must return 200');
  // dashboard.ejs: "Pro plan · Unlimited invoices" when user.plan !== 'free'.
  // The rendered `user` variable comes from db.getUserById(), not req.session.user,
  // so the DB-authoritative plan overrides the stale session value.
  assert.ok(res.body.includes('Pro plan'),
    'dashboard must render the DB-authoritative plan ("Pro plan") even when ' +
    'the session still shows the old plan — ensures dunning changes are visible on next load');
}

// 6. POST /invoices/new: db.createInvoice throws → re-renders form with error flash,
// no unhandled 500.  The validation-error path is tested elsewhere; this covers the
// DB error path that occurs after validation passes.
async function testCreateInvoiceDbErrorRendersFormGracefully() {
  resetStore();
  dbCreateInvoiceShouldThrow = true;
  users.set(40, { id: 40, plan: 'pro', name: 'Creator', email: 'c@x.com', invoice_count: 0 });
  const app = buildApp({ id: 40, plan: 'pro' });

  const res = await request(app, 'POST', '/invoices/new', {
    client_name: 'Client A',
    items: JSON.stringify([{ description: 'Work', quantity: 1, rate: 100, amount: 100 }]),
    subtotal: '100',
    tax_rate: '0',
    tax_amount: '0',
    total: '100',
    invoice_number: 'INV-2026-9999',
    issued_date: '2026-04-23'
  });

  assert.ok(res.status === 200 || res.status === 302,
    'POST /invoices/new DB error must not produce an unhandled 500; got ' + res.status);
  if (res.status === 200) {
    assert.ok(
      res.body.includes('Failed') || res.body.includes('error') ||
      res.body.includes('again') || res.body.includes('Error'),
      'rendered page must include an error message when invoice DB creation fails'
    );
  }
}

// 7. GET /billing/upgrade renders 200 with pricing content.
// This route exists (billing.js line 9) but was never exercised in the test suite —
// only the pricing.ejs template was rendered directly via EJS in annual-billing tests.
async function testGetBillingUpgradeRenders200() {
  resetStore();
  users.set(50, { id: 50, plan: 'free', email: 'u@x.com', name: 'U' });
  const app = buildApp({ id: 50, plan: 'free' });

  const res = await request(app, 'GET', '/billing/upgrade');
  assert.strictEqual(res.status, 200, 'GET /billing/upgrade must return 200');
  assert.ok(res.body.includes('Upgrade to Pro') || res.body.includes('Pro'),
    'upgrade page must render pricing content');
}

// 8. GET /invoices/:id: db.getInvoiceById throws → redirect to /dashboard, no 500.
// Existing tests cover the IDOR guard (null return) but not the DB error (throw).
async function testInvoiceViewDbErrorRedirects() {
  resetStore();
  dbGetInvoiceByIdShouldThrow = true;
  users.set(60, { id: 60, plan: 'pro', name: 'E', email: 'e@x.com' });
  const app = buildApp({ id: 60, plan: 'pro' });

  const res = await request(app, 'GET', '/invoices/99');

  assert.strictEqual(res.status, 302,
    'GET /invoices/:id DB error must redirect (302), not produce an unhandled 500');
  assert.ok(res.headers.location && res.headers.location.includes('/dashboard'),
    'on DB error in invoice view, user must be redirected to /dashboard');
}

// 9. GET /invoices/:id/print: db.getInvoiceById throws → redirect to /dashboard, no 500.
async function testInvoicePrintDbErrorRedirects() {
  resetStore();
  dbGetInvoiceByIdShouldThrow = true;
  users.set(61, { id: 61, plan: 'pro', name: 'F', email: 'f@x.com' });
  const app = buildApp({ id: 61, plan: 'pro' });

  const res = await request(app, 'GET', '/invoices/99/print');

  assert.strictEqual(res.status, 302,
    'GET /invoices/:id/print DB error must redirect (302), not produce an unhandled 500');
  assert.ok(res.headers.location && res.headers.location.includes('/dashboard'),
    'on DB error in print view, user must be redirected to /dashboard');
}

// 10. POST /invoices/:id/status: db.updateInvoiceStatus throws → redirect, no 500.
// All other paths through this handler are tested; only the DB throw case was missing.
async function testStatusUpdateDbErrorRedirects() {
  resetStore();
  dbUpdateStatusShouldThrow = true;
  users.set(70, { id: 70, plan: 'pro', name: 'G', email: 'g@x.com' });
  const inv = {
    id: nextInvoiceId++, user_id: 70,
    invoice_number: 'INV-2026-0070',
    client_name: 'Client G',
    total: 100,
    status: 'draft',
    payment_link_url: null, payment_link_id: null, items: []
  };
  invoices.set(inv.id, inv);
  const app = buildApp({ id: 70, plan: 'pro' });

  const res = await request(app, 'POST', `/invoices/${inv.id}/status`, { status: 'sent' });

  assert.strictEqual(res.status, 302,
    'POST /invoices/:id/status DB error must redirect (302), not produce an unhandled 500');
  assert.ok(
    res.headers.location && res.headers.location.includes(`/invoices/${inv.id}`),
    'on status update DB error, must redirect back to the invoice view (not an error page)'
  );
}

// ---------- Runner ----------------------------------------------------------

async function run() {
  const tests = [
    ['Billing webhook (payment_link): outbound webhook fires for Pro owner (billing.js)', testStripePaymentLinkWebhookFiresOutboundForPro],
    ['Billing webhook (payment_link): outbound webhook fires for Agency owner', testStripePaymentLinkWebhookFiresOutboundForAgency],
    ['Billing webhook (payment_link): no outbound fire when owner has no webhook_url', testStripePaymentLinkWebhookNoFireWhenNoWebhookUrl],
    ['Invoice status route: Agency plan fires outbound webhook on paid transition', testAgencyPlanFiresOutboundWebhookOnStatusPaid],
    ['Dashboard: session.user.plan refreshed from DB (dunning visible without re-login)', testDashboardRefreshesSessionPlanFromDb],
    ['POST /invoices/new: DB error renders form gracefully (no unhandled 500)', testCreateInvoiceDbErrorRendersFormGracefully],
    ['GET /billing/upgrade: renders pricing page (200)', testGetBillingUpgradeRenders200],
    ['GET /invoices/:id: DB error redirects to /dashboard (no crash)', testInvoiceViewDbErrorRedirects],
    ['GET /invoices/:id/print: DB error redirects to /dashboard (no crash)', testInvoicePrintDbErrorRedirects],
    ['POST /invoices/:id/status: DB error redirects (no crash)', testStatusUpdateDbErrorRedirects]
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
