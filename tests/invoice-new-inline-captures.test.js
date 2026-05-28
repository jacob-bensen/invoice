'use strict';

/*
 * Inline business_name + payment_instructions captures on /invoices/new
 * (Milestones 3+4 — first invoice created → first invoice sent → first
 * payment received).
 *
 * The /invoices/quick route already captures these inline for the 3-field
 * express activation path. /invoices/new is the advanced form for users
 * with multi-line work, tax, custom dates — but for a brand-new user
 * (clicked through the "Need line items, tax or custom dates?" advanced-
 * form link, or the onboarding-checklist "Create your first invoice"
 * step) it's the activation surface too. Without these captures, the
 * first share lands with a "Your Business" header and (for free-plan
 * owners) no payment path on the share link.
 *
 * Coverage:
 *
 *  - Layer 1: view invoice-form.ejs
 *      * business_name block renders on the new-flow when user has no
 *        business_name (plan-agnostic).
 *      * business_name block hidden on edit-flow (`invoice` set).
 *      * business_name block hidden when user already has a brand.
 *      * payment_instructions block renders on the new-flow when
 *        user.plan === 'free' AND no existing instructions.
 *      * payment_instructions block hidden for Pro/Agency.
 *      * payment_instructions block hidden when already set.
 *      * payment_instructions block hidden on edit-flow.
 *      * Submitted values re-populate on validation re-render.
 *
 *  - Layer 2: route POST /invoices/new
 *      * Persists business_name when user has none (write-once gate).
 *      * Persists business_name for any plan (plan-agnostic).
 *      * Does NOT persist when user already has a brand (forged-payload
 *        guard).
 *      * Does NOT persist whitespace-only or oversize business_name.
 *      * Persists payment_instructions for free user with none.
 *      * Does NOT persist payment_instructions for Pro (plan gate).
 *      * Does NOT persist when user already has instructions.
 *      * updateUser failure does NOT block the /invoices/:id redirect.
 *
 * Run: NODE_ENV=test node tests/invoice-new-inline-captures.test.js
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
const createCalls = [];
const updateUserCalls = [];
const mintTokenCalls = [];
let nextInvoiceId = 500;
let updateUserImpl = null;
let mintTokenImpl = null;

function resetStore() {
  users.clear();
  createCalls.length = 0;
  updateUserCalls.length = 0;
  mintTokenCalls.length = 0;
  nextInvoiceId = 500;
  updateUserImpl = null;
  mintTokenImpl = null;
}

function buildDbStub() {
  return {
    pool: { query: async () => ({ rows: [] }) },
    db: {
      async getUserById(id) { return users.get(id) || null; },
      async getInvoiceById() { return null; },
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
        return Object.assign({ id, status: 'draft', is_seed: false }, data);
      },
      async updateUser(id, fields) {
        updateUserCalls.push({ id, fields });
        if (updateUserImpl) return updateUserImpl(id, fields);
        const u = users.get(id);
        if (!u) return null;
        Object.assign(u, fields);
        return u;
      },
      async getOrCreatePublicToken(invoiceId, userId) {
        mintTokenCalls.push({ invoiceId, userId });
        if (mintTokenImpl) return mintTokenImpl(invoiceId, userId);
        return 'abc1234567890def';
      },
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
// Layer 1 — invoice-form.ejs render shape
// ---------------------------------------------------------------------------

async function renderForm(opts) {
  const viewsDir = path.join(__dirname, '..', 'views');
  return ejs.renderFile(path.join(viewsDir, 'invoice-form.ejs'),
    Object.assign({
      title: 'New Invoice',
      invoice: null,
      invoiceNumber: 'INV-2026-0001',
      recentClients: [],
      user: { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com', business_name: null, payment_instructions: null },
      flash: null,
      csrfToken: 'tkn'
    }, opts || {}),
    { views: [viewsDir] });
}

async function testViewBusinessNameBlockRendersOnNewWhenEmpty() {
  const html = await renderForm({
    user: { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com', business_name: null }
  });
  assert.ok(html.includes('data-testid="invoice-new-business-name-block"'),
    'new-flow user with no business_name sees the capture block');
  assert.ok(html.includes('data-testid="invoice-new-business-name-input"'),
    'the input is rendered with the testid hook');
  assert.ok(/name="business_name"/.test(html),
    'input posts under name="business_name"');
  assert.ok(/maxlength="255"/.test(html),
    'maxlength matches the 255-char server cap');
}

async function testViewBusinessNameBlockRendersForProToo() {
  const html = await renderForm({
    user: { id: 1, plan: 'pro', invoice_count: 0, name: 'Alice', email: 'a@x.com', business_name: null }
  });
  assert.ok(html.includes('data-testid="invoice-new-business-name-block"'),
    'Pro user with no business_name sees the block (plan-agnostic gap)');
}

async function testViewBusinessNameBlockHiddenWhenAlreadySet() {
  const html = await renderForm({
    user: { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com', business_name: 'Acme Studio' }
  });
  assert.ok(!html.includes('data-testid="invoice-new-business-name-block"'),
    'user with existing business_name does not see the block');
}

async function testViewBusinessNameBlockHiddenOnEditFlow() {
  const html = await renderForm({
    invoice: {
      id: 42, invoice_number: 'INV-2026-0042', status: 'draft',
      client_name: 'Client', client_email: '', client_address: '',
      items: [{ description: 'Work', quantity: 1, unit_price: 100 }],
      tax_rate: 0, notes: '',
      issued_date: new Date('2026-05-01'),
      due_date: new Date('2026-05-31')
    },
    user: { id: 1, plan: 'free', invoice_count: 5, name: 'Alice', email: 'a@x.com', business_name: null }
  });
  assert.ok(!html.includes('data-testid="invoice-new-business-name-block"'),
    'edit-flow MUST NOT surface the capture block (past activation by then)');
}

async function testViewPaymentInstructionsBlockRendersForFree() {
  const html = await renderForm({
    user: { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com', payment_instructions: null }
  });
  assert.ok(html.includes('data-testid="invoice-new-payment-instructions-block"'),
    'free new-flow user without instructions sees the block');
  assert.ok(html.includes('data-testid="invoice-new-payment-instructions-input"'),
    'textarea testid hook present');
  assert.ok(/name="payment_instructions"/.test(html),
    'textarea posts under name="payment_instructions"');
  assert.ok(/maxlength="2000"/.test(html),
    'maxlength matches the 2000-char server cap');
}

async function testViewPaymentInstructionsBlockHiddenForPro() {
  const html = await renderForm({
    user: { id: 1, plan: 'pro', invoice_count: 0, name: 'Alice', email: 'a@x.com', payment_instructions: null }
  });
  assert.ok(!html.includes('data-testid="invoice-new-payment-instructions-block"'),
    'Pro user has a Stripe Pay Link — must NOT see the free-plan block');
}

async function testViewPaymentInstructionsBlockHiddenWhenAlreadySet() {
  const html = await renderForm({
    user: { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com', payment_instructions: 'Venmo @existing' }
  });
  assert.ok(!html.includes('data-testid="invoice-new-payment-instructions-block"'),
    'free user who already saved instructions must NOT see the block');
}

async function testViewPaymentInstructionsBlockHiddenOnEditFlow() {
  const html = await renderForm({
    invoice: {
      id: 42, invoice_number: 'INV-2026-0042', status: 'draft',
      client_name: 'Client', client_email: '', client_address: '',
      items: [{ description: 'Work', quantity: 1, unit_price: 100 }],
      tax_rate: 0, notes: '',
      issued_date: new Date('2026-05-01'),
      due_date: new Date('2026-05-31')
    },
    user: { id: 1, plan: 'free', invoice_count: 5, name: 'Alice', email: 'a@x.com', payment_instructions: null }
  });
  assert.ok(!html.includes('data-testid="invoice-new-payment-instructions-block"'),
    'edit-flow MUST NOT surface the payment-instructions block');
}

async function testViewSubmittedRepopulatesCaptures() {
  const html = await renderForm({
    user: { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com', business_name: null, payment_instructions: null },
    submitted: {
      business_name: 'Acme Studio',
      payment_instructions: 'Venmo @alice'
    }
  });
  assert.ok(html.includes('value="Acme Studio"'),
    'business_name sticky after re-render');
  assert.ok(html.includes('Venmo @alice'),
    'payment_instructions sticky after re-render');
}

// ---------------------------------------------------------------------------
// Layer 2 — POST /invoices/new captures
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

async function testPostPersistsBusinessNameWhenUserHasNone() {
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com', business_name: null });
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 0 }, routes);

  const res = await request(app, 'POST', '/invoices/new',
    postBody({ business_name: '  Acme Studio  ' }));
  assert.strictEqual(res.status, 302, 'happy-path POST must redirect');
  assert.strictEqual(createCalls.length, 1, 'invoice created');
  assert.strictEqual(updateUserCalls.length, 1,
    'free user with no existing business_name: updateUser called exactly once');
  assert.deepStrictEqual(updateUserCalls[0].fields, { business_name: 'Acme Studio' },
    'business_name is trimmed and saved alone');
}

async function testPostPersistsBusinessNameForPro() {
  resetStore();
  users.set(1, { id: 1, plan: 'pro', invoice_count: 0, name: 'Alice', email: 'a@x.com', business_name: null });
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'pro', invoice_count: 0 }, routes);

  await request(app, 'POST', '/invoices/new',
    postBody({ business_name: 'Acme Studio' }));
  assert.strictEqual(updateUserCalls.length, 1,
    'Pro plan business-name capture must still persist (plan-agnostic gap)');
  assert.deepStrictEqual(updateUserCalls[0].fields, { business_name: 'Acme Studio' });
}

async function testPostSkipsBusinessNameWhenUserAlreadyHasOne() {
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com', business_name: 'Existing Studio' });
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 0 }, routes);

  await request(app, 'POST', '/invoices/new',
    postBody({ business_name: 'Try to overwrite' }));
  assert.strictEqual(updateUserCalls.length, 0,
    'existing business_name MUST NOT be overwritten via the new form (forged-payload guard)');
}

async function testPostSkipsBusinessNameWhenWhitespace() {
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com', business_name: null });
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 0 }, routes);

  await request(app, 'POST', '/invoices/new',
    postBody({ business_name: '   ' }));
  assert.strictEqual(createCalls.length, 1, 'invoice still created');
  assert.strictEqual(updateUserCalls.length, 0,
    'whitespace-only business_name must NOT call updateUser');
}

async function testPostSkipsOversizeBusinessName() {
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com', business_name: null });
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 0 }, routes);

  const res = await request(app, 'POST', '/invoices/new',
    postBody({ business_name: 'x'.repeat(256) }));
  assert.strictEqual(res.status, 302, 'oversize business_name must NOT block invoice creation');
  assert.strictEqual(createCalls.length, 1, 'invoice still created');
  assert.strictEqual(updateUserCalls.length, 0,
    'oversize business_name silently ignored at save layer');
}

async function testPostPersistsPaymentInstructionsForFree() {
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com', payment_instructions: null });
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 0 }, routes);

  await request(app, 'POST', '/invoices/new',
    postBody({ payment_instructions: '  Venmo @alice\nZelle: alice@bank.com  ' }));
  assert.strictEqual(updateUserCalls.length, 1,
    'free user with no instructions: updateUser called exactly once');
  assert.deepStrictEqual(updateUserCalls[0].fields,
    { payment_instructions: 'Venmo @alice\nZelle: alice@bank.com' },
    'payment_instructions is trimmed and saved');
}

async function testPostSkipsPaymentInstructionsForPro() {
  resetStore();
  users.set(1, { id: 1, plan: 'pro', invoice_count: 0, name: 'Alice', email: 'a@x.com', payment_instructions: null });
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'pro', invoice_count: 0 }, routes);

  await request(app, 'POST', '/invoices/new',
    postBody({ payment_instructions: 'Venmo @alice' }));
  assert.strictEqual(updateUserCalls.length, 0,
    'Pro plan tampering with payment_instructions must NOT call updateUser');
}

async function testPostSkipsPaymentInstructionsWhenAlreadySet() {
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com', payment_instructions: 'Existing' });
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 0 }, routes);

  await request(app, 'POST', '/invoices/new',
    postBody({ payment_instructions: 'Try to overwrite' }));
  assert.strictEqual(updateUserCalls.length, 0,
    'existing payment_instructions MUST NOT be overwritten');
}

async function testPostUpdateUserFailureDoesNotBlockRedirect() {
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com', business_name: null });
  updateUserImpl = async () => { throw new Error('pg down'); };
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 0 }, routes);

  const res = await request(app, 'POST', '/invoices/new',
    postBody({ business_name: 'Acme Studio' }));
  assert.strictEqual(res.status, 302,
    'invoice redirect must still fire on a business_name save failure');
  assert.ok(/^\/invoices\/\d+$/.test(res.headers.location),
    'redirect target is the just-created invoice');
  assert.strictEqual(createCalls.length, 1, 'invoice still created');
  assert.strictEqual(updateUserCalls.length, 1, 'updateUser was attempted exactly once');
}

async function testPostBothCapturesFireInSamePost() {
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com', business_name: null, payment_instructions: null });
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 0 }, routes);

  await request(app, 'POST', '/invoices/new',
    postBody({ business_name: 'Acme Studio', payment_instructions: 'Venmo @alice' }));
  assert.strictEqual(updateUserCalls.length, 2,
    'both captures persist in independent updateUser calls when both are present');
  const fieldsSeen = updateUserCalls.map((c) => Object.keys(c.fields)[0]).sort();
  assert.deepStrictEqual(fieldsSeen, ['business_name', 'payment_instructions'],
    'one call per field — neither stomps the other');
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function run() {
  const tests = [
    testViewBusinessNameBlockRendersOnNewWhenEmpty,
    testViewBusinessNameBlockRendersForProToo,
    testViewBusinessNameBlockHiddenWhenAlreadySet,
    testViewBusinessNameBlockHiddenOnEditFlow,
    testViewPaymentInstructionsBlockRendersForFree,
    testViewPaymentInstructionsBlockHiddenForPro,
    testViewPaymentInstructionsBlockHiddenWhenAlreadySet,
    testViewPaymentInstructionsBlockHiddenOnEditFlow,
    testViewSubmittedRepopulatesCaptures,
    testPostPersistsBusinessNameWhenUserHasNone,
    testPostPersistsBusinessNameForPro,
    testPostSkipsBusinessNameWhenUserAlreadyHasOne,
    testPostSkipsBusinessNameWhenWhitespace,
    testPostSkipsOversizeBusinessName,
    testPostPersistsPaymentInstructionsForFree,
    testPostSkipsPaymentInstructionsForPro,
    testPostSkipsPaymentInstructionsWhenAlreadySet,
    testPostUpdateUserFailureDoesNotBlockRedirect,
    testPostBothCapturesFireInSamePost
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
