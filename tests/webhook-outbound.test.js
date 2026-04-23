'use strict';

/*
 * Zapier / Outbound Webhook tests (INTERNAL_TODO #7).
 *
 * Covers:
 *  1.  lib/outbound-webhook: isValidWebhookUrl accepts http/https, rejects others.
 *  2.  lib/outbound-webhook: buildPaidPayload produces the documented JSON shape.
 *  3.  lib/outbound-webhook: firePaidWebhook POSTs JSON to the configured URL with
 *      application/json Content-Type and a User-Agent header.
 *  4.  lib/outbound-webhook: firePaidWebhook returns ok=false on invalid URL
 *      without throwing (graceful degradation).
 *  5.  POST /billing/webhook-url — Pro user saves URL → db.updateUser called with
 *      webhook_url.
 *  6.  POST /billing/webhook-url — Pro user empties URL → db.updateUser called
 *      with webhook_url:null (clear).
 *  7.  POST /billing/webhook-url — Pro user submits malformed URL → NOT saved,
 *      error flash.
 *  8.  POST /billing/webhook-url — Free user → NOT saved (plan-gated), error
 *      flash.
 *  9.  POST /invoices/:id/status=paid — Pro user with webhook_url → outbound
 *      fire triggered with correct payload (event, invoice_id, amount, …).
 * 10.  POST /invoices/:id/status=paid — Pro user WITHOUT webhook_url → no fire.
 * 11.  POST /invoices/:id/status=paid — Free user WITH webhook_url → no fire
 *      (plan-gated: webhooks are a Pro feature).
 * 12.  POST /invoices/:id/status=sent — Pro user with webhook_url → no
 *      paid-webhook fire (fire happens on paid transition only).
 * 13.  POST /invoices/:id/status=paid — outbound fire that rejects does NOT
 *      block the redirect (fire-and-forget).
 * 14.  settings.ejs — Pro user renders editable webhook form with existing URL
 *      prefilled.
 * 15.  settings.ejs — Free user renders locked "Upgrade to Pro" placeholder.
 *
 * All external I/O (pg, stripe, http) is stubbed — no real network calls.
 *
 * Run: node tests/webhook-outbound.test.js
 */

const assert = require('assert');
const path = require('path');
const ejs = require('ejs');
const express = require('express');
const http = require('http');

function clearReq(mod) { delete require.cache[require.resolve(mod)]; }

// ---------- Stub ../db -----------------------------------------------------

const users = new Map();
const invoices = new Map();
let nextInvoiceId = 1;
const updateUserCalls = [];

function resetStore() {
  users.clear();
  invoices.clear();
  nextInvoiceId = 1;
  updateUserCalls.length = 0;
}

const dbStub = {
  pool: { query: async () => ({ rows: [] }) },
  db: {
    async getUserById(id) { return users.get(id) || null; },
    async getUserByEmail() { return null; },
    async createUser() { throw new Error('unused'); },
    async updateUser(id, fields) {
      updateUserCalls.push({ id, fields });
      const u = users.get(id);
      if (u) Object.assign(u, fields);
      return u;
    },
    async getInvoicesByUser(userId) {
      return [...invoices.values()].filter(i => i.user_id === userId);
    },
    async getInvoiceById(id, userId) {
      const inv = invoices.get(parseInt(id, 10));
      if (!inv || inv.user_id !== userId) return null;
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
    async getNextInvoiceNumber() { return 'INV-2026-0001'; },
    async markInvoicePaidByPaymentLinkId() { return null; }
  }
};

require.cache[require.resolve('../db')] = {
  id: require.resolve('../db'),
  filename: require.resolve('../db'),
  loaded: true,
  exports: dbStub
};

// Stripe Payment Link stub (unused in most tests here but needs to be safe).
require.cache[require.resolve('../lib/stripe-payment-link')] = {
  id: require.resolve('../lib/stripe-payment-link'),
  filename: require.resolve('../lib/stripe-payment-link'),
  loaded: true,
  exports: { createInvoicePaymentLink: async () => null }
};

// Track outbound-webhook fires by replacing the module in the cache.
const outboundFires = [];
let outboundFireImpl = async () => ({ ok: true, status: 200 });
const { buildPaidPayload: realBuildPaidPayload, isValidWebhookUrl: realIsValidWebhookUrl } =
  require('../lib/outbound-webhook');
const outboundStub = {
  isValidWebhookUrl: realIsValidWebhookUrl,
  buildPaidPayload: realBuildPaidPayload,
  firePaidWebhook: async (url, payload) => {
    outboundFires.push({ url, payload });
    return outboundFireImpl(url, payload);
  }
};
require.cache[require.resolve('../lib/outbound-webhook')] = {
  id: require.resolve('../lib/outbound-webhook'),
  filename: require.resolve('../lib/outbound-webhook'),
  loaded: true,
  exports: outboundStub
};

clearReq('../routes/invoices');
clearReq('../routes/billing');
const invoiceRoutes = require('../routes/invoices');
const billingRoutes = require('../routes/billing');

// ---------- Test helpers ---------------------------------------------------

function buildApp(sessionUser) {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { user: sessionUser };
    next();
  });
  app.use('/invoices', invoiceRoutes);
  app.use('/billing', billingRoutes);
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
        res.on('end', () => server.close(() => resolve({
          status: res.statusCode, headers: res.headers, body: data
        })));
      });
      req.on('error', err => { server.close(); reject(err); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

// ---------- Tests ----------------------------------------------------------

async function testIsValidWebhookUrl() {
  const { isValidWebhookUrl } = require('../lib/outbound-webhook');
  assert.strictEqual(isValidWebhookUrl('https://hooks.zapier.com/hooks/catch/123/abc'), true);
  assert.strictEqual(isValidWebhookUrl('http://localhost:3000/hook'), true);
  assert.strictEqual(isValidWebhookUrl('ftp://example.com/x'), false,
    'non-http(s) protocols must be rejected');
  assert.strictEqual(isValidWebhookUrl('javascript:alert(1)'), false,
    'javascript: URLs must be rejected — XSS guard');
  assert.strictEqual(isValidWebhookUrl('not a url'), false);
  assert.strictEqual(isValidWebhookUrl(''), false);
  assert.strictEqual(isValidWebhookUrl(null), false);
  assert.strictEqual(isValidWebhookUrl(undefined), false);
}

async function testBuildPaidPayload() {
  const { buildPaidPayload } = require('../lib/outbound-webhook');
  const invoice = {
    id: 42,
    invoice_number: 'INV-2026-0042',
    total: '500.00',
    currency: null,
    client_name: 'Acme Corp',
    client_email: 'billing@acme.com'
  };
  const payload = buildPaidPayload(invoice);
  assert.strictEqual(payload.event, 'invoice.paid');
  assert.strictEqual(payload.invoice_id, 42);
  assert.strictEqual(payload.invoice_number, 'INV-2026-0042');
  assert.strictEqual(payload.amount, 500);
  assert.strictEqual(payload.currency, 'usd',
    'currency must default to usd when unset');
  assert.strictEqual(payload.client_name, 'Acme Corp');
  assert.strictEqual(payload.client_email, 'billing@acme.com');
  assert.ok(typeof payload.paid_at === 'string' && payload.paid_at.length > 10,
    'paid_at must be an ISO timestamp');
}

async function testFirePaidWebhookPostsJson() {
  // Load the real module (bypass the route-facing stub).
  clearReq('../lib/outbound-webhook');
  const real = require('../lib/outbound-webhook');

  const receivedHeaders = {};
  let receivedBody = '';
  const fakeHttpClient = {
    request(opts, cb) {
      receivedHeaders.headers = opts.headers;
      receivedHeaders.method = opts.method;
      receivedHeaders.path = opts.path;
      receivedHeaders.hostname = opts.hostname;
      const fakeReq = {
        _body: '',
        write(b) { this._body += b.toString('utf8'); },
        end() {
          receivedBody = this._body;
          const fakeRes = {
            statusCode: 200,
            _handlers: {},
            on(evt, h) {
              this._handlers[evt] = h;
              if (evt === 'end') setImmediate(h);
            }
          };
          cb(fakeRes);
        },
        on() {},
        destroy() {}
      };
      return fakeReq;
    }
  };

  const result = await real.firePaidWebhook(
    'https://hooks.zapier.com/hooks/catch/1/abc',
    { event: 'invoice.paid', invoice_id: 7 },
    { httpClient: fakeHttpClient }
  );

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.status, 200);
  assert.strictEqual(receivedHeaders.method, 'POST');
  assert.strictEqual(receivedHeaders.hostname, 'hooks.zapier.com');
  assert.strictEqual(receivedHeaders.path, '/hooks/catch/1/abc');
  assert.strictEqual(receivedHeaders.headers['Content-Type'], 'application/json');
  assert.ok(receivedHeaders.headers['User-Agent'].includes('QuickInvoice'),
    'User-Agent must identify the sender');
  const parsed = JSON.parse(receivedBody);
  assert.strictEqual(parsed.event, 'invoice.paid');
  assert.strictEqual(parsed.invoice_id, 7);

  // Restore the route-facing stub so subsequent tests see the outboundFires log.
  require.cache[require.resolve('../lib/outbound-webhook')] = {
    id: require.resolve('../lib/outbound-webhook'),
    filename: require.resolve('../lib/outbound-webhook'),
    loaded: true,
    exports: outboundStub
  };
}

async function testFirePaidWebhookGracefulOnInvalidUrl() {
  clearReq('../lib/outbound-webhook');
  const real = require('../lib/outbound-webhook');
  const result = await real.firePaidWebhook('not a url', { event: 'invoice.paid' });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'invalid_url');

  // Restore stub.
  require.cache[require.resolve('../lib/outbound-webhook')] = {
    id: require.resolve('../lib/outbound-webhook'),
    filename: require.resolve('../lib/outbound-webhook'),
    loaded: true,
    exports: outboundStub
  };
}

async function testSaveWebhookUrlProUser() {
  resetStore();
  users.set(1, { id: 1, plan: 'pro', email: 'p@x.com' });
  const app = buildApp({ id: 1, plan: 'pro' });
  const res = await request(app, 'POST', '/billing/webhook-url', {
    webhook_url: 'https://hooks.zapier.com/hooks/catch/111/abc'
  });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.location, '/billing/settings');
  const call = updateUserCalls.find(c => 'webhook_url' in c.fields);
  assert.ok(call, 'db.updateUser must be called with webhook_url');
  assert.strictEqual(call.id, 1);
  assert.strictEqual(call.fields.webhook_url, 'https://hooks.zapier.com/hooks/catch/111/abc');
}

async function testClearWebhookUrlWhenEmpty() {
  resetStore();
  users.set(2, { id: 2, plan: 'pro', webhook_url: 'https://old.example.com/hook' });
  const app = buildApp({ id: 2, plan: 'pro' });
  const res = await request(app, 'POST', '/billing/webhook-url', { webhook_url: '' });
  assert.strictEqual(res.status, 302);
  const call = updateUserCalls.find(c => 'webhook_url' in c.fields);
  assert.ok(call);
  assert.strictEqual(call.fields.webhook_url, null,
    'empty submission must clear webhook_url to null');
}

async function testRejectInvalidWebhookUrl() {
  resetStore();
  users.set(3, { id: 3, plan: 'pro' });
  const app = buildApp({ id: 3, plan: 'pro' });
  const res = await request(app, 'POST', '/billing/webhook-url', {
    webhook_url: 'javascript:alert(1)'
  });
  assert.strictEqual(res.status, 302);
  const call = updateUserCalls.find(c => 'webhook_url' in c.fields);
  assert.strictEqual(call, undefined,
    'malformed URL must NOT be persisted');
}

async function testFreeUserCannotSaveWebhook() {
  resetStore();
  users.set(4, { id: 4, plan: 'free' });
  const app = buildApp({ id: 4, plan: 'free' });
  const res = await request(app, 'POST', '/billing/webhook-url', {
    webhook_url: 'https://hooks.zapier.com/hooks/catch/444/xyz'
  });
  assert.strictEqual(res.status, 302);
  const call = updateUserCalls.find(c => 'webhook_url' in c.fields);
  assert.strictEqual(call, undefined,
    'free user must NOT be able to save webhook — Pro gate');
}

async function testPaidFiresOutboundWebhookForProUser() {
  resetStore();
  outboundFires.length = 0;
  outboundFireImpl = async () => ({ ok: true, status: 200 });
  users.set(5, {
    id: 5, plan: 'pro',
    webhook_url: 'https://hooks.zapier.com/hooks/catch/555/abc'
  });
  const inv = {
    id: nextInvoiceId++, user_id: 5,
    invoice_number: 'INV-2026-0010',
    client_name: 'Client Five',
    client_email: 'five@x.com',
    total: 250,
    status: 'sent',
    payment_link_url: null, payment_link_id: null
  };
  invoices.set(inv.id, inv);

  const app = buildApp({ id: 5, plan: 'pro' });
  const res = await request(app, 'POST', `/invoices/${inv.id}/status`, { status: 'paid' });
  assert.strictEqual(res.status, 302);

  // Fire-and-forget — let the event loop flush the microtask.
  await new Promise(r => setImmediate(r));

  assert.strictEqual(outboundFires.length, 1, 'exactly one outbound webhook fire');
  assert.strictEqual(outboundFires[0].url, 'https://hooks.zapier.com/hooks/catch/555/abc');
  const p = outboundFires[0].payload;
  assert.strictEqual(p.event, 'invoice.paid');
  assert.strictEqual(p.invoice_id, inv.id);
  assert.strictEqual(p.invoice_number, 'INV-2026-0010');
  assert.strictEqual(p.amount, 250);
  assert.strictEqual(p.client_name, 'Client Five');
  assert.strictEqual(p.client_email, 'five@x.com');
}

async function testPaidSkipsWebhookIfNoUrlConfigured() {
  resetStore();
  outboundFires.length = 0;
  users.set(6, { id: 6, plan: 'pro', webhook_url: null });
  const inv = {
    id: nextInvoiceId++, user_id: 6, invoice_number: 'INV-2026-0011',
    client_name: 'C', total: 100, status: 'sent'
  };
  invoices.set(inv.id, inv);
  const app = buildApp({ id: 6, plan: 'pro' });
  await request(app, 'POST', `/invoices/${inv.id}/status`, { status: 'paid' });
  await new Promise(r => setImmediate(r));
  assert.strictEqual(outboundFires.length, 0,
    'no webhook_url → no outbound fire');
}

async function testPaidSkipsWebhookForFreeUser() {
  resetStore();
  outboundFires.length = 0;
  // webhook_url exists on the row (e.g. user downgraded after configuring it)
  // but the feature is Pro-gated on fire too — defence in depth.
  users.set(7, {
    id: 7, plan: 'free',
    webhook_url: 'https://hooks.zapier.com/hooks/catch/777/abc'
  });
  const inv = {
    id: nextInvoiceId++, user_id: 7, invoice_number: 'INV-2026-0012',
    client_name: 'C', total: 50, status: 'sent'
  };
  invoices.set(inv.id, inv);
  const app = buildApp({ id: 7, plan: 'free' });
  await request(app, 'POST', `/invoices/${inv.id}/status`, { status: 'paid' });
  await new Promise(r => setImmediate(r));
  assert.strictEqual(outboundFires.length, 0,
    'free plan must NOT fire outbound webhook — Pro feature');
}

async function testSentDoesNotFirePaidWebhook() {
  resetStore();
  outboundFires.length = 0;
  users.set(8, {
    id: 8, plan: 'pro',
    webhook_url: 'https://hooks.zapier.com/hooks/catch/888/abc'
  });
  const inv = {
    id: nextInvoiceId++, user_id: 8, invoice_number: 'INV-2026-0013',
    client_name: 'C', total: 300, status: 'draft',
    payment_link_url: 'https://buy.stripe.com/existing' // prevents Stripe call
  };
  invoices.set(inv.id, inv);
  const app = buildApp({ id: 8, plan: 'pro' });
  await request(app, 'POST', `/invoices/${inv.id}/status`, { status: 'sent' });
  await new Promise(r => setImmediate(r));
  assert.strictEqual(outboundFires.length, 0,
    'sent transition must not fire the paid webhook');
}

async function testOutboundFailureDoesNotBlockRedirect() {
  resetStore();
  outboundFires.length = 0;
  // Simulate the outbound HTTP rejecting — the route MUST still redirect.
  outboundFireImpl = async () => { throw new Error('network down'); };
  users.set(9, {
    id: 9, plan: 'pro',
    webhook_url: 'https://hooks.zapier.com/hooks/catch/999/abc'
  });
  const inv = {
    id: nextInvoiceId++, user_id: 9, invoice_number: 'INV-2026-0014',
    client_name: 'C', total: 75, status: 'sent'
  };
  invoices.set(inv.id, inv);
  const app = buildApp({ id: 9, plan: 'pro' });
  const res = await request(app, 'POST', `/invoices/${inv.id}/status`, { status: 'paid' });
  // Redirect returned even though the outbound call blew up.
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.location, `/invoices/${inv.id}`);
  assert.strictEqual(inv.status, 'paid',
    'invoice status must still transition to paid despite webhook failure');
  // Flush the rejected promise so unhandled-rejection doesn't leak into the next test.
  await new Promise(r => setImmediate(r));
  outboundFireImpl = async () => ({ ok: true, status: 200 });
}

async function testSettingsRendersWebhookFormForPro() {
  const tpl = path.join(__dirname, '..', 'views', 'settings.ejs');
  const html = await ejs.renderFile(tpl, {
    title: 'Settings',
    user: {
      id: 1, plan: 'pro', email: 'p@x.com', name: 'P',
      webhook_url: 'https://hooks.zapier.com/hooks/catch/5/abc',
      invoice_count: 0
    },
    flash: null
  }, { views: [path.join(__dirname, '..', 'views')] });

  assert.ok(html.includes('Zapier / Webhook'),
    'section heading must render');
  assert.ok(html.includes('action="/billing/webhook-url"'),
    'form must post to /billing/webhook-url');
  assert.ok(html.includes('name="webhook_url"'),
    'input must be named webhook_url');
  assert.ok(html.includes('https://hooks.zapier.com/hooks/catch/5/abc'),
    'existing URL must be prefilled');
}

async function testSettingsShowsLockedPlaceholderForFree() {
  const tpl = path.join(__dirname, '..', 'views', 'settings.ejs');
  const html = await ejs.renderFile(tpl, {
    title: 'Settings',
    user: { id: 2, plan: 'free', email: 'f@x.com', name: 'F', invoice_count: 0 },
    flash: null
  }, { views: [path.join(__dirname, '..', 'views')] });

  assert.ok(html.includes('Zapier / Webhook'),
    'section heading must still render (drives Pro upgrade intent)');
  assert.ok(html.includes('Upgrade to Pro'),
    'free users must see an upgrade CTA, not an input');
  assert.ok(!html.includes('action="/billing/webhook-url"'),
    'free users must NOT see the save form');
  assert.ok(!html.includes('name="webhook_url"'),
    'free users must not have an input to submit');
}

// ---------- Runner ---------------------------------------------------------

async function run() {
  const tests = [
    ['isValidWebhookUrl accepts http/https, rejects others', testIsValidWebhookUrl],
    ['buildPaidPayload returns documented shape', testBuildPaidPayload],
    ['firePaidWebhook POSTs JSON with headers', testFirePaidWebhookPostsJson],
    ['firePaidWebhook graceful on invalid URL', testFirePaidWebhookGracefulOnInvalidUrl],
    ['POST /billing/webhook-url: Pro saves webhook_url', testSaveWebhookUrlProUser],
    ['POST /billing/webhook-url: empty input clears to null', testClearWebhookUrlWhenEmpty],
    ['POST /billing/webhook-url: invalid URL rejected, not saved', testRejectInvalidWebhookUrl],
    ['POST /billing/webhook-url: Free user blocked (Pro gate)', testFreeUserCannotSaveWebhook],
    ['POST /invoices/:id/status=paid: Pro+webhook → fires outbound', testPaidFiresOutboundWebhookForProUser],
    ['POST /invoices/:id/status=paid: Pro+no-webhook → no fire', testPaidSkipsWebhookIfNoUrlConfigured],
    ['POST /invoices/:id/status=paid: Free plan never fires', testPaidSkipsWebhookForFreeUser],
    ['POST /invoices/:id/status=sent: does NOT fire paid webhook', testSentDoesNotFirePaidWebhook],
    ['Outbound failure does not block the redirect', testOutboundFailureDoesNotBlockRedirect],
    ['settings.ejs: Pro user sees editable form with existing URL', testSettingsRendersWebhookFormForPro],
    ['settings.ejs: Free user sees locked upgrade placeholder', testSettingsShowsLockedPlaceholderForFree]
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
