'use strict';

/*
 * Client-phone capture on the advanced /invoices/new form (and edit-flow
 * /invoices/:id/edit). Milestone 3 — first invoice created → first invoice
 * sent.
 *
 * The /quick form already captures client_phone (shipped 2026-05-30) and
 * threads it through the SMS / WhatsApp share-intent URLs as the recipient,
 * collapsing "tap → pick contact → confirm → send" into "tap → confirm →
 * send" on mobile. The /quick form is the free-cohort express path; the
 * advanced /new form is the Pro/Agency creation path. Until this ship, every
 * /new invoice has client_phone = NULL — so every downstream SMS/WhatsApp
 * share rail on those invoices (the per-row dashboard follow-up, the per-
 * invoice share-intent buttons, the public-share rails) opened the contact
 * picker. Pro/Agency users had to hand-pick the client on every send.
 *
 * Coverage:
 *
 *  - Layer 1 — view invoice-form.ejs render shape
 *      * client_phone input renders with name="client_phone", type="tel",
 *        inputmode="tel", testid hook.
 *      * Edit-flow (`invoice` set with `client_phone`) pre-fills the
 *        Alpine factory's initialClient.phone via the JSON.stringify wire.
 *      * Edit-flow with no phone leaves initialClient.phone empty.
 *      * invoiceEditor() factory declares `clientPhone` as an x-model field.
 *      * x-model="clientPhone" appears on the input (reactivity guard).
 *      * fillFromRecent() populates clientPhone from c.client_phone.
 *
 *  - Layer 2 — route POST /invoices/new
 *      * Valid phone → createInvoice receives the normalised value.
 *      * Punctuated phone normalises to digits+optional-leading-plus.
 *      * Too-short phone → createInvoice receives null (soft optional field).
 *      * Empty / missing phone → createInvoice receives null.
 *      * Hostile phone with script tags / spaces → null or digits only.
 *
 *  - Layer 3 — route POST /invoices/:id/edit
 *      * Valid phone → updateInvoice receives the normalised value.
 *      * Invalid / empty phone → updateInvoice receives null.
 *
 * Run: NODE_ENV=test node tests/invoice-new-client-phone.test.js
 */

const assert = require('assert');
const path = require('path');
const ejs = require('ejs');
const express = require('express');
const http = require('http');

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

// ---------------------------------------------------------------------------
// Test store + db stub
// ---------------------------------------------------------------------------

const users = new Map();
const invoices = new Map();
const createCalls = [];
const updateInvoiceCalls = [];
let nextInvoiceId = 700;

function resetStore() {
  users.clear();
  invoices.clear();
  createCalls.length = 0;
  updateInvoiceCalls.length = 0;
  nextInvoiceId = 700;
}

function buildDbStub() {
  return {
    pool: { query: async () => ({ rows: [] }) },
    db: {
      async getUserById(id) { return users.get(id) || null; },
      async getInvoiceById(id, userId) {
        const inv = invoices.get(parseInt(id, 10));
        if (!inv) return null;
        if (userId != null && inv.user_id !== userId) return null;
        return inv;
      },
      async getInvoicesByUser() { return []; },
      async getNextInvoiceNumber(userId) {
        const u = users.get(userId);
        const n = (u && (u.invoice_count || 0)) + 1;
        return `INV-2026-${String(n).padStart(4, '0')}`;
      },
      async getRecentClientsForUser() { return []; },
      async getRecentItemsForUser() { return []; },
      async createInvoice(data) {
        createCalls.push(data);
        const id = nextInvoiceId++;
        const u = users.get(data.user_id);
        if (u) u.invoice_count = (u.invoice_count || 0) + 1;
        const row = Object.assign({ id, status: 'draft', is_seed: false }, data);
        invoices.set(id, row);
        return row;
      },
      async updateInvoice(id, userId, data) {
        updateInvoiceCalls.push({ id: parseInt(id, 10), userId, data });
        const inv = invoices.get(parseInt(id, 10));
        if (!inv) return null;
        if (inv.user_id !== userId) return null;
        Object.assign(inv, data);
        return inv;
      },
      async updateUser() {},
      async getOrCreatePublicToken() { return 'abc1234567890def'; },
      async clearPendingQuickInvoice() {},
      async getOldestStaleDraft() { return null; },
      async getRecentRevenueStats() { return null; }
    }
  };
}

function installDbStub() {
  const stub = buildDbStub();
  require.cache[require.resolve('../db')] = {
    id: require.resolve('../db'),
    filename: require.resolve('../db'),
    loaded: true,
    exports: stub
  };
  require.cache[require.resolve('../lib/stripe-payment-link')] = {
    id: require.resolve('../lib/stripe-payment-link'),
    filename: require.resolve('../lib/stripe-payment-link'),
    loaded: true,
    exports: {
      createInvoicePaymentLink: async () => null,
      parsePaymentMethods: () => ['card']
    }
  };
  delete require.cache[require.resolve('../routes/invoices')];
  return require('../routes/invoices');
}

function buildApp(sessionUser, invoiceRoutes) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = req.session || { user: sessionUser, flash: null };
    req.session.user = sessionUser ? Object.assign({}, sessionUser) : null;
    next();
  });
  app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    res.locals.csrfToken = 'test-csrf';
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
        hostname: '127.0.0.1', port, path: url, method,
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

// ---------------------------------------------------------------------------
// Layer 1 — view shape
// ---------------------------------------------------------------------------

async function renderForm(opts) {
  const viewsDir = path.join(__dirname, '..', 'views');
  return ejs.renderFile(path.join(viewsDir, 'invoice-form.ejs'),
    Object.assign({
      title: 'New Invoice',
      invoice: null,
      invoiceNumber: 'INV-2026-0001',
      recentClients: [],
      user: { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com' },
      flash: null,
      csrfToken: 'tkn'
    }, opts || {}),
    { views: [viewsDir] });
}

async function testViewClientPhoneInputRenders() {
  const html = await renderForm();
  assert.ok(html.includes('data-testid="invoice-new-client-phone-input"'),
    'the phone input renders with the documented testid hook');
  assert.ok(/name="client_phone"/.test(html),
    'input posts under name="client_phone"');
  assert.ok(/type="tel"/.test(html),
    'input is type="tel" for mobile keypad routing');
  assert.ok(/inputmode="tel"/.test(html),
    'input declares inputmode="tel" for desktop browsers');
}

async function testViewClientPhoneEditFlowPrefills() {
  const html = await renderForm({
    invoice: {
      id: 42, invoice_number: 'INV-2026-0042', status: 'draft',
      client_name: 'Acme Co', client_email: 'c@a.com', client_address: '',
      client_phone: '+15551234567',
      items: [{ description: 'Work', quantity: 1, unit_price: 100 }],
      tax_rate: 0, notes: '',
      issued_date: new Date('2026-05-01'),
      due_date: new Date('2026-05-31')
    }
  });
  // EJS `<%= JSON.stringify(...) %>` HTML-escapes the quotes, so the on-page
  // JSON reads &#34;phone&#34;:&#34;+15551234567&#34; — Alpine un-escapes when
  // parsing the x-data attribute, but the rendered HTML carries the entities.
  assert.ok(html.includes('&#34;phone&#34;:&#34;+15551234567&#34;'),
    'initialClient.phone is wired into the Alpine x-data JSON payload for edit-flow');
}

async function testViewClientPhoneEditFlowEmptyWhenAbsent() {
  const html = await renderForm({
    invoice: {
      id: 42, invoice_number: 'INV-2026-0042', status: 'draft',
      client_name: 'Acme Co', client_email: 'c@a.com', client_address: '',
      client_phone: null,
      items: [{ description: 'Work', quantity: 1, unit_price: 100 }],
      tax_rate: 0, notes: '',
      issued_date: new Date('2026-05-01'),
      due_date: new Date('2026-05-31')
    }
  });
  assert.ok(html.includes('&#34;phone&#34;:&#34;&#34;'),
    'edit-flow with null client_phone collapses to empty string in the JSON payload');
}

async function testViewClientPhoneAlpineModelWired() {
  const html = await renderForm();
  assert.ok(/x-model="clientPhone"/.test(html),
    'the phone input is x-model="clientPhone" so typing updates the factory state');
  assert.ok(/clientPhone:\s*typeof c\.phone === 'string' \? c\.phone : ''/.test(html),
    'invoiceEditor() declares clientPhone as an initialClient-derived reactive field');
}

async function testViewFillFromRecentPopulatesPhone() {
  const html = await renderForm({
    recentClients: [{ client_name: 'A', client_email: 'a@x.com', client_address: '', client_phone: '+15555550100' }]
  });
  // The factory's fillFromRecent() body must assign from c.client_phone.
  assert.ok(/this\.clientPhone\s*=\s*c\.client_phone\s*\|\|\s*''/.test(html),
    'fillFromRecent() assigns from c.client_phone (one-tap pick-existing-client now carries phone too)');
}

// ---------------------------------------------------------------------------
// Layer 2 — POST /invoices/new
// ---------------------------------------------------------------------------

function postBody(extra) {
  return Object.assign({
    invoice_number: 'INV-2026-0001',
    issued_date: '2026-05-28',
    due_date: '2026-06-27',
    client_name: 'Acme Co',
    client_email: '',
    client_address: '',
    items: JSON.stringify([{ description: 'Work', quantity: 1, unit_price: 500 }]),
    subtotal: '500',
    tax_rate: '0',
    tax_amount: '0',
    total: '500',
    notes: ''
  }, extra || {});
}

async function testPostNewPersistsValidPhone() {
  resetStore();
  users.set(1, { id: 1, plan: 'pro', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'pro', invoice_count: 0 }, routes);

  const res = await request(app, 'POST', '/invoices/new',
    postBody({ client_phone: '+15551234567' }));
  assert.strictEqual(res.status, 302, 'happy-path POST redirects');
  assert.strictEqual(createCalls.length, 1, 'invoice created');
  assert.strictEqual(createCalls[0].client_phone, '+15551234567',
    'E.164-shaped phone passes through normalizer intact');
}

async function testPostNewNormalizesPunctuatedPhone() {
  resetStore();
  users.set(1, { id: 1, plan: 'pro', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'pro', invoice_count: 0 }, routes);

  await request(app, 'POST', '/invoices/new',
    postBody({ client_phone: '+1 (555) 123-4567' }));
  assert.strictEqual(createCalls.length, 1);
  assert.strictEqual(createCalls[0].client_phone, '+15551234567',
    'punctuated US phone normalises to E.164');
}

async function testPostNewPersistsBareDigits() {
  resetStore();
  users.set(1, { id: 1, plan: 'pro', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'pro', invoice_count: 0 }, routes);

  await request(app, 'POST', '/invoices/new',
    postBody({ client_phone: '5551234567' }));
  assert.strictEqual(createCalls.length, 1);
  assert.strictEqual(createCalls[0].client_phone, '5551234567',
    'bare 10-digit phone preserved as digits (WhatsApp wa.me path strips the + anyway)');
}

async function testPostNewRejectsTooShortPhone() {
  resetStore();
  users.set(1, { id: 1, plan: 'pro', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'pro', invoice_count: 0 }, routes);

  const res = await request(app, 'POST', '/invoices/new',
    postBody({ client_phone: '12345' }));
  assert.strictEqual(res.status, 302, 'bad phone never blocks invoice creation (soft optional)');
  assert.strictEqual(createCalls.length, 1);
  assert.strictEqual(createCalls[0].client_phone, null,
    'too-short phone normalises to null so downstream share rails fall back cleanly');
}

async function testPostNewEmptyPhoneIsNull() {
  resetStore();
  users.set(1, { id: 1, plan: 'pro', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'pro', invoice_count: 0 }, routes);

  await request(app, 'POST', '/invoices/new', postBody({ client_phone: '' }));
  assert.strictEqual(createCalls.length, 1);
  assert.strictEqual(createCalls[0].client_phone, null,
    'empty input → null (every existing invoice flow keeps working without phone)');
}

async function testPostNewMissingPhoneIsNull() {
  resetStore();
  users.set(1, { id: 1, plan: 'pro', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'pro', invoice_count: 0 }, routes);

  await request(app, 'POST', '/invoices/new', postBody({}));
  assert.strictEqual(createCalls.length, 1);
  assert.strictEqual(createCalls[0].client_phone, null,
    'absent client_phone → null (backwards-compatible default for clients that never POST the field)');
}

async function testPostNewHostilePhoneFails() {
  resetStore();
  users.set(1, { id: 1, plan: 'pro', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'pro', invoice_count: 0 }, routes);

  await request(app, 'POST', '/invoices/new',
    postBody({ client_phone: '<script>alert(1)</script>' }));
  assert.strictEqual(createCalls.length, 1);
  assert.strictEqual(createCalls[0].client_phone, null,
    'hostile non-digit input rejected at the normalizer boundary (defence in depth)');
}

// ---------------------------------------------------------------------------
// Layer 3 — POST /invoices/:id/edit
// ---------------------------------------------------------------------------

function editBody(extra) {
  return Object.assign({
    client_name: 'Acme Co',
    client_email: '',
    client_address: '',
    items: JSON.stringify([{ description: 'Work', quantity: 1, unit_price: 500 }]),
    subtotal: '500',
    tax_rate: '0',
    tax_amount: '0',
    total: '500',
    notes: '',
    issued_date: '2026-05-28',
    due_date: '2026-06-27',
    status: 'draft'
  }, extra || {});
}

async function testPostEditPersistsValidPhone() {
  resetStore();
  users.set(1, { id: 1, plan: 'pro', invoice_count: 1, name: 'Alice', email: 'a@x.com' });
  const inv = {
    id: 4242, user_id: 1, invoice_number: 'INV-1',
    client_name: 'Acme Co', client_email: '', client_phone: null,
    items: [], status: 'draft', total: 500
  };
  invoices.set(inv.id, inv);
  const routes = installDbStub();
  // re-seed the stub's store with our invoice (installDbStub clobbers via require cache).
  // The stub above already references the module-level `invoices` Map, so this is fine.
  const app = buildApp({ id: 1, plan: 'pro' }, routes);

  await request(app, 'POST', `/invoices/${inv.id}/edit`,
    editBody({ client_phone: '+44 20 7946 0958' }));
  const call = updateInvoiceCalls.find(c => c.id === inv.id);
  assert.ok(call, 'updateInvoice must be invoked');
  assert.strictEqual(call.data.client_phone, '+442079460958',
    'UK international phone normalises to E.164 on edit');
}

async function testPostEditRejectsInvalidPhone() {
  resetStore();
  users.set(1, { id: 1, plan: 'pro', invoice_count: 1, name: 'Alice', email: 'a@x.com' });
  const inv = {
    id: 4243, user_id: 1, invoice_number: 'INV-2',
    client_name: 'Acme Co', client_email: '', client_phone: '+15551234567',
    items: [], status: 'draft', total: 500
  };
  invoices.set(inv.id, inv);
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'pro' }, routes);

  await request(app, 'POST', `/invoices/${inv.id}/edit`,
    editBody({ client_phone: 'not a phone' }));
  const call = updateInvoiceCalls.find(c => c.id === inv.id);
  assert.ok(call, 'updateInvoice still invoked (other fields update)');
  assert.strictEqual(call.data.client_phone, null,
    'invalid phone normalises to null — caller treats the freelancer typing garbage as "clear it"');
}

async function testPostEditEmptyPhoneClears() {
  resetStore();
  users.set(1, { id: 1, plan: 'pro', invoice_count: 1, name: 'Alice', email: 'a@x.com' });
  const inv = {
    id: 4244, user_id: 1, invoice_number: 'INV-3',
    client_name: 'Acme Co', client_email: '', client_phone: '+15551234567',
    items: [], status: 'draft', total: 500
  };
  invoices.set(inv.id, inv);
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'pro' }, routes);

  await request(app, 'POST', `/invoices/${inv.id}/edit`,
    editBody({ client_phone: '' }));
  const call = updateInvoiceCalls.find(c => c.id === inv.id);
  assert.ok(call);
  assert.strictEqual(call.data.client_phone, null,
    'empty phone field on edit clears the stored value');
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function run() {
  const tests = [
    testViewClientPhoneInputRenders,
    testViewClientPhoneEditFlowPrefills,
    testViewClientPhoneEditFlowEmptyWhenAbsent,
    testViewClientPhoneAlpineModelWired,
    testViewFillFromRecentPopulatesPhone,
    testPostNewPersistsValidPhone,
    testPostNewNormalizesPunctuatedPhone,
    testPostNewPersistsBareDigits,
    testPostNewRejectsTooShortPhone,
    testPostNewEmptyPhoneIsNull,
    testPostNewMissingPhoneIsNull,
    testPostNewHostilePhoneFails,
    testPostEditPersistsValidPhone,
    testPostEditRejectsInvalidPhone,
    testPostEditEmptyPhoneClears
  ];
  let failed = 0;
  for (const fn of tests) {
    try {
      await fn();
      console.log(`  ✓ ${fn.name}`);
    } catch (err) {
      failed += 1;
      console.error(`  ✗ ${fn.name}`);
      console.error(err && err.stack ? err.stack : err);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
