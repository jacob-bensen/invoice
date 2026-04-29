'use strict';

/*
 * INTERNAL_TODO H12: whitelist `status` in POST /invoices/:id/status before
 * the DB CHECK constraint sees it.
 *
 * Before this commit `req.body.status` was passed straight to
 * db.updateInvoiceStatus; the Postgres CHECK constraint (`status IN ('draft',
 * 'sent', 'paid', 'overdue')`) rejected bad values with error code 23514, the
 * try/catch logged `console.error('Status update error:', err)` and silently
 * redirected to the invoice page. Effect: a junk POST yielded a noisy log
 * line, no flash, and an opaque redirect, complicating incident triage and
 * obscuring real DB errors.
 *
 * After this commit the route checks against `ALLOWED_INVOICE_STATUSES` and
 * short-circuits with a flash error before any DB write. The DB CHECK
 * constraint remains the last line of defence — but it is no longer the only
 * one.
 *
 * Tests:
 *  1. Valid status ('sent') → DB write happens, flash success, redirect to invoice.
 *  2. Invalid status ('garbage') → no DB write, flash error, redirect to invoice.
 *  3. Empty status → no DB write, flash error, redirect to invoice (defends
 *     against a missing form field).
 *  4. Invalid status with whitespace ('paid '; trailing space) → no DB write,
 *     flash error (strict equality, not trimmed — matches DB CHECK semantics).
 *  5. SQL-injection-shaped status ('paid; DROP TABLE invoices') → no DB write,
 *     flash error. Parameterised queries already protect us; the whitelist is
 *     defence-in-depth.
 *  6. Status injection blocks the side-effects too: an invalid status must
 *     not fire the outbound webhook (paid→webhook) or create a Stripe Payment
 *     Link (sent→link), regardless of plan.
 *  7. ALLOWED_INVOICE_STATUSES export shape (4 entries, in canonical order).
 *  8. Each of the 4 valid statuses ('draft','sent','paid','overdue') passes
 *     through to db.updateInvoiceStatus.
 *
 * Run: node tests/status-whitelist.test.js
 */

const assert = require('assert');
const path = require('path');
const express = require('express');
const http = require('http');

// ---------- Mutable test state ---------------------------------------------

const users = new Map();
const invoices = new Map();
let nextInvoiceId = 1;
const updateStatusCalls = [];
const paymentLinkCalls = [];
const webhookFires = [];

function resetStore() {
  users.clear();
  invoices.clear();
  nextInvoiceId = 1;
  updateStatusCalls.length = 0;
  paymentLinkCalls.length = 0;
  webhookFires.length = 0;
}

// ---------- DB stub --------------------------------------------------------

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
      updateStatusCalls.push({ id, userId, status });
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
    async getNextInvoiceNumber() { return 'INV-2026-0001'; },
    async createInvoice() { throw new Error('not used'); },
    async updateInvoice() { throw new Error('not used'); },
    async deleteInvoice() { throw new Error('not used'); },
    async markInvoicePaidByPaymentLinkId() { return null; },
    async getUserByEmail() { return null; },
    async createUser() { throw new Error('not used'); },
    async updateUser(id, fields) {
      const u = users.get(id);
      if (!u) return null;
      Object.assign(u, fields);
      return u;
    },
    async dismissOnboarding() { return null; }
  }
};

require.cache[require.resolve('../db')] = {
  id: require.resolve('../db'),
  filename: require.resolve('../db'),
  loaded: true,
  exports: dbStub
};

// ---------- Stripe Payment Link stub --------------------------------------

require.cache[require.resolve('../lib/stripe-payment-link')] = {
  id: require.resolve('../lib/stripe-payment-link'),
  filename: require.resolve('../lib/stripe-payment-link'),
  loaded: true,
  exports: {
    async createInvoicePaymentLink(invoice, user) {
      paymentLinkCalls.push({ invoice_id: invoice.id, user_id: user.id });
      return { id: `plink_${invoice.id}`, url: `https://buy.stripe.com/test_${invoice.id}` };
    }
  }
};

// ---------- Outbound webhook stub -----------------------------------------

require.cache[require.resolve('../lib/outbound-webhook')] = {
  id: require.resolve('../lib/outbound-webhook'),
  filename: require.resolve('../lib/outbound-webhook'),
  loaded: true,
  exports: {
    isValidWebhookUrl: async () => true,
    buildPaidPayload: (inv) => ({
      event: 'invoice.paid', invoice_id: inv.id, amount: inv.total,
      client_name: inv.client_name, paid_at: new Date().toISOString()
    }),
    firePaidWebhook: async (url, payload) => {
      webhookFires.push({ url, payload });
      return { ok: true, status: 200 };
    },
    setHostnameResolver: () => {}
  }
};

// ---------- Email stub ----------------------------------------------------

require.cache[require.resolve('../lib/email')] = {
  id: require.resolve('../lib/email'),
  filename: require.resolve('../lib/email'),
  loaded: true,
  exports: {
    sendInvoiceEmail: async () => ({ ok: false, reason: 'not_configured' }),
    sendEmail: async () => ({ ok: false, reason: 'not_configured' }),
    setResendClient: () => {}
  }
};

function clearReq(mod) { delete require.cache[require.resolve(mod)]; }
clearReq('../routes/invoices');
const invoiceRoutes = require('../routes/invoices');

// ---------- App builder ---------------------------------------------------

function buildApp(sessionUser) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  // Capture flashes into a closure on the request lifecycle so tests can read
  // back what was set (production stores flash on req.session and clears on
  // next render — here the redirect short-circuits before render).
  app.use((req, res, next) => {
    const _flash = { current: null };
    req.session = {
      user: sessionUser ? { ...sessionUser } : null,
      get flash() { return _flash.current; },
      set flash(v) { _flash.current = v; }
    };
    res.locals.user = sessionUser || null;
    res.on('finish', () => {
      // Echo the flash back to the test via a header so it can assert without
      // wiring up a follow-up GET.
      // (Set-via-on-finish is too late for the response; the helper below
      // accesses req.session directly via app.locals instead.)
    });
    app.locals._lastFlash = _flash;
    next();
  });
  app.use('/invoices', invoiceRoutes);
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
          res.on('end', () => {
            const flash = app.locals._lastFlash ? app.locals._lastFlash.current : null;
            server.close(() => resolve({
              status: res.statusCode, headers: res.headers, body: data, flash
            }));
          });
        }
      );
      req.on('error', err => { server.close(); reject(err); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

function seedInvoice(userId, plan) {
  users.set(userId, {
    id: userId, plan, name: 'Test User', email: `u${userId}@x.com`,
    business_name: 'Co', webhook_url: 'https://hooks.example.com/test'
  });
  const id = nextInvoiceId++;
  invoices.set(id, {
    id, user_id: userId, invoice_number: `INV-2026-${String(id).padStart(4, '0')}`,
    client_name: 'Acme Corp', client_email: 'client@acme.com',
    total: 500, status: 'draft', items: [],
    payment_link_url: null, payment_link_id: null
  });
  return id;
}

// ---------- Tests ---------------------------------------------------------

// 1. Valid status passes through to the DB.
async function testValidStatusUpdates() {
  resetStore();
  const invId = seedInvoice(1, 'pro');
  const app = buildApp({ id: 1, plan: 'pro' });

  const res = await request(app, 'POST', `/invoices/${invId}/status`, { status: 'sent' });

  assert.strictEqual(res.status, 302, 'valid status must redirect 302');
  assert.ok(res.headers.location && res.headers.location.includes(`/invoices/${invId}`),
    'must redirect back to the invoice page');
  assert.strictEqual(updateStatusCalls.length, 1,
    'valid status MUST call db.updateInvoiceStatus exactly once');
  assert.strictEqual(updateStatusCalls[0].status, 'sent',
    'forwarded status must equal the (validated) request body');
  assert.ok(res.flash && res.flash.type === 'success',
    'valid status must produce a success flash, got: ' + JSON.stringify(res.flash));
}

// 2. Junk status — the headline H12 case.
async function testJunkStatusRejected() {
  resetStore();
  const invId = seedInvoice(2, 'pro');
  const app = buildApp({ id: 2, plan: 'pro' });

  const res = await request(app, 'POST', `/invoices/${invId}/status`, { status: 'garbage' });

  assert.strictEqual(res.status, 302, 'invalid status must still redirect (no 500)');
  assert.ok(res.headers.location && res.headers.location.includes(`/invoices/${invId}`),
    'invalid status must redirect to the invoice page (not /dashboard, not error page)');
  assert.strictEqual(updateStatusCalls.length, 0,
    'invalid status MUST NOT reach db.updateInvoiceStatus — whitelist short-circuits before DB');
  assert.ok(res.flash && res.flash.type === 'error',
    'invalid status must produce an error flash, got: ' + JSON.stringify(res.flash));
  assert.ok(/invalid/i.test(res.flash.message),
    'flash message must mention "invalid", got: ' + res.flash.message);
  // Invoice remains in original state — no silent state mutation.
  assert.strictEqual(invoices.get(invId).status, 'draft',
    'invoice status must not mutate when the request is rejected');
}

// 3. Empty status (form field missing).
async function testEmptyStatusRejected() {
  resetStore();
  const invId = seedInvoice(3, 'pro');
  const app = buildApp({ id: 3, plan: 'pro' });

  const res = await request(app, 'POST', `/invoices/${invId}/status`, { status: '' });

  assert.strictEqual(res.status, 302, 'empty status must redirect, not 500');
  assert.strictEqual(updateStatusCalls.length, 0,
    'empty status MUST NOT reach the DB');
  assert.ok(res.flash && res.flash.type === 'error',
    'empty status must produce an error flash');
}

// 4. Status with a trailing whitespace — strict equality, not trimmed.
async function testWhitespaceStatusRejected() {
  resetStore();
  const invId = seedInvoice(4, 'pro');
  const app = buildApp({ id: 4, plan: 'pro' });

  const res = await request(app, 'POST', `/invoices/${invId}/status`, { status: 'paid ' });

  assert.strictEqual(res.status, 302);
  assert.strictEqual(updateStatusCalls.length, 0,
    '"paid " (trailing space) must not bypass the whitelist — DB CHECK is strict and so is the gate');
  assert.ok(res.flash && res.flash.type === 'error');
}

// 5. SQL-injection shape — defence-in-depth check.
async function testInjectionShapeRejected() {
  resetStore();
  const invId = seedInvoice(5, 'pro');
  const app = buildApp({ id: 5, plan: 'pro' });

  const res = await request(app, 'POST', `/invoices/${invId}/status`, {
    status: "paid'; DROP TABLE invoices;--"
  });

  assert.strictEqual(res.status, 302);
  assert.strictEqual(updateStatusCalls.length, 0,
    'injection-shaped status must not reach the DB; whitelist is defence-in-depth atop parameterised queries');
  assert.ok(res.flash && res.flash.type === 'error');
}

// 6. Side-effects (Stripe link, outbound webhook) MUST NOT fire on rejection.
async function testInvalidStatusDoesNotFireSideEffects() {
  resetStore();
  // Pro user with webhook_url set — would normally fire on paid→webhook.
  const invId = seedInvoice(6, 'pro');
  const app = buildApp({ id: 6, plan: 'pro' });

  // Send junk status that contains "paid" — must not match.
  const res = await request(app, 'POST', `/invoices/${invId}/status`, { status: 'paid_in_full' });

  assert.strictEqual(res.status, 302);
  assert.strictEqual(updateStatusCalls.length, 0, 'no DB write on rejected status');
  assert.strictEqual(paymentLinkCalls.length, 0,
    'no Stripe Payment Link must be created when the status is rejected — even if it contains the substring "sent"/"paid"');
  assert.strictEqual(webhookFires.length, 0,
    'no outbound webhook must fire when the status is rejected');
}

// 7. ALLOWED_INVOICE_STATUSES export contract.
async function testAllowedStatusesExport() {
  assert.ok(Array.isArray(invoiceRoutes.ALLOWED_INVOICE_STATUSES),
    'ALLOWED_INVOICE_STATUSES must be exported as an array (re-used by tests + future code)');
  assert.deepStrictEqual(invoiceRoutes.ALLOWED_INVOICE_STATUSES,
    ['draft', 'sent', 'paid', 'overdue'],
    'ALLOWED_INVOICE_STATUSES must match the Postgres CHECK constraint exactly, in canonical order');
}

// 8. Each of the 4 valid statuses passes through.
async function testEachValidStatusPasses() {
  const ALLOWED = ['draft', 'sent', 'paid', 'overdue'];
  for (const status of ALLOWED) {
    resetStore();
    const userId = 100 + ALLOWED.indexOf(status);
    // Free plan to skip Stripe/webhook side-effects (Pro→sent creates a link;
    // Pro→paid fires a webhook). Status whitelist is plan-agnostic.
    const invId = seedInvoice(userId, 'free');
    const app = buildApp({ id: userId, plan: 'free' });

    const res = await request(app, 'POST', `/invoices/${invId}/status`, { status });
    assert.strictEqual(res.status, 302, `status='${status}' must redirect`);
    assert.strictEqual(updateStatusCalls.length, 1,
      `status='${status}' must reach db.updateInvoiceStatus`);
    assert.strictEqual(updateStatusCalls[0].status, status,
      `status='${status}' must be forwarded verbatim`);
    assert.ok(res.flash && res.flash.type === 'success',
      `status='${status}' must produce a success flash`);
  }
}

// ---------- Runner --------------------------------------------------------

async function run() {
  const tests = [
    ['Valid status (sent) → DB write, success flash, redirect to invoice', testValidStatusUpdates],
    ['Junk status (garbage) → no DB write, error flash, no state mutation', testJunkStatusRejected],
    ['Empty status (missing field) → no DB write, error flash', testEmptyStatusRejected],
    ['Whitespace status (paid<space>) → no DB write, error flash (strict equality)', testWhitespaceStatusRejected],
    ['SQL-injection shape → no DB write, error flash (defence-in-depth)', testInjectionShapeRejected],
    ['Invalid status → no Stripe link, no outbound webhook (side-effects gated on whitelist)', testInvalidStatusDoesNotFireSideEffects],
    ['ALLOWED_INVOICE_STATUSES export = [draft,sent,paid,overdue] in canonical order', testAllowedStatusesExport],
    ['Each of 4 valid statuses (draft/sent/paid/overdue) passes through to DB', testEachValidStatusPasses]
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
