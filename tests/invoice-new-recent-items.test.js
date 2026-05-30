'use strict';

/*
 * "Recent items" quick-pick dropdown on /invoices/new (Milestone 2 — first
 * dashboard re-entry → first real invoice created).
 *
 * The /invoices/quick form has the recent-items dropdown shipped earlier
 * (description + amount per line). The advanced form at /invoices/new — the
 * high-LTV cohort with line items, quantity, unit price, and tax — only had
 * recent-clients and forced repeat typing of every line. This file locks in
 * the parity surface:
 *
 *   - Route GET /invoices/new threads `recentItems` via a Promise.all with
 *     the existing recent-clients lookup; a single helper failure must NOT
 *     strand the other dropdown.
 *   - The validation-error and try/catch render paths also thread recentItems
 *     (so a failed POST does not lose the dropdown).
 *   - The view layer renders the dropdown ONLY for the new-flow (not edit)
 *     and ONLY when the filtered list is non-empty.
 *   - The Alpine factory exposes a fillFromRecentItem() method that fills
 *     the FIRST empty trailing line OR appends a new line, populating the
 *     full description + quantity + unit_price triple (not the collapsed
 *     `amount` /quick uses). Bad picks no-op silently.
 *   - The dropdown is hidden on edit-flow even when recentItems is provided.
 *
 * Run: NODE_ENV=test node tests/invoice-new-recent-items.test.js
 */

const assert = require('assert');
const path = require('path');
const vm = require('vm');
const fs = require('fs');
const ejs = require('ejs');
const express = require('express');
const http = require('http');

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

// ---------------------------------------------------------------------------
// Test store + db stub
// ---------------------------------------------------------------------------

const users = new Map();
const recentClientsCalls = [];
const recentItemsCalls = [];
let recentClientsImpl = async () => [];
let recentItemsImpl = async () => [];
let nextInvoiceId = 800;

function resetStore() {
  users.clear();
  recentClientsCalls.length = 0;
  recentItemsCalls.length = 0;
  recentClientsImpl = async () => [];
  recentItemsImpl = async () => [];
  nextInvoiceId = 800;
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
      async getRecentClientsForUser(userId, limit) {
        recentClientsCalls.push({ userId, limit });
        return recentClientsImpl(userId, limit);
      },
      async getRecentItemsForUser(userId, limit) {
        recentItemsCalls.push({ userId, limit });
        return recentItemsImpl(userId, limit);
      },
      async createInvoice(data) {
        const id = nextInvoiceId++;
        const u = users.get(data.user_id);
        if (u) u.invoice_count = (u.invoice_count || 0) + 1;
        return Object.assign({ id, status: 'draft', is_seed: false }, data);
      },
      async getOrCreatePublicToken() { return 'tok_recent_items'; },
      async updateUser(id, fields) {
        const u = users.get(id);
        if (u) Object.assign(u, fields);
        return u;
      },
      async clearPendingQuickInvoice() {},
      async getOldestStaleDraft() { return null; },
      async getRecentRevenueStats() { return null; },
      async markInvoiceSentFromShareIntent() { return null; },
      async recordFirstSentIfMissing() { return null; }
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
// Layer 1 — Route GET /invoices/new threads recentItems
// ---------------------------------------------------------------------------

async function testGetNewLoadsRecentItems() {
  resetStore();
  users.set(1, { id: 1, plan: 'pro', invoice_count: 6, name: 'Alice', email: 'a@x.com' });
  recentItemsImpl = async () => ([
    { description: 'Logo design', amount: 500, unit_price: 500, quantity: 1 },
    { description: 'Hourly rate', amount: 300, unit_price: 75, quantity: 4 }
  ]);
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'pro', invoice_count: 6 }, routes);

  const res = await request(app, 'GET', '/invoices/new');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(recentItemsCalls.length, 1,
    'db.getRecentItemsForUser must be called exactly once on GET /invoices/new');
  assert.strictEqual(recentItemsCalls[0].userId, 1,
    'lookup uses the session user id');
  assert.ok(res.body.includes('data-testid="invoice-new-recent-items"'),
    'dropdown wrapper renders when items are returned');
  assert.ok(res.body.includes('Logo design'),
    'first option description renders');
  assert.ok(res.body.includes('Hourly rate'),
    'second option description renders');
  assert.ok(res.body.includes('qty 4'),
    'quantity surfaces in the option label (so the freelancer sees the breakdown)');
  assert.ok(res.body.includes('$75.00'),
    'unit_price surfaces in the option label with 2-decimal formatting');
}

async function testGetNewOmitsDropdownForBrandNewUser() {
  resetStore();
  users.set(2, { id: 2, plan: 'free', invoice_count: 0, name: 'New', email: 'n@x.com' });
  recentItemsImpl = async () => [];
  const routes = installDbStub();
  const app = buildApp({ id: 2, plan: 'free', invoice_count: 0 }, routes);

  const res = await request(app, 'GET', '/invoices/new');
  assert.strictEqual(res.status, 200);
  assert.ok(!res.body.includes('data-testid="invoice-new-recent-items"'),
    'dropdown omitted when no past items — day-zero account never sees an empty <select>');
  assert.ok(res.body.includes('Line Items'),
    'rest of form still renders');
}

async function testGetNewSurvivesRecentItemsDbFailure() {
  resetStore();
  users.set(3, { id: 3, plan: 'pro', invoice_count: 8, name: 'Bob', email: 'b@x.com' });
  recentItemsImpl = async () => { throw new Error('pg timeout'); };
  const routes = installDbStub();
  const app = buildApp({ id: 3, plan: 'pro', invoice_count: 8 }, routes);

  const origErr = console.error;
  console.error = () => {};
  try {
    const res = await request(app, 'GET', '/invoices/new');
    assert.strictEqual(res.status, 200,
      'recent-items DB throw must NOT 500 the form');
    assert.ok(!res.body.includes('data-testid="invoice-new-recent-items"'),
      'soft-fail hides the dropdown');
    assert.ok(res.body.includes('Line Items'),
      'core form still renders');
  } finally {
    console.error = origErr;
  }
}

async function testGetNewBothDropdownLookupsConcurrent() {
  resetStore();
  users.set(4, { id: 4, plan: 'pro', invoice_count: 4, name: 'Cara', email: 'c@x.com' });
  recentClientsImpl = async () => ([{ client_name: 'X', client_email: 'x@x', client_address: null }]);
  recentItemsImpl = async () => ([{ description: 'Audit', amount: 250, unit_price: 250, quantity: 1 }]);
  const routes = installDbStub();
  const app = buildApp({ id: 4, plan: 'pro', invoice_count: 4 }, routes);

  const res = await request(app, 'GET', '/invoices/new');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(recentClientsCalls.length, 1, 'recent clients lookup fires');
  assert.strictEqual(recentItemsCalls.length, 1, 'recent items lookup fires');
  assert.ok(res.body.includes('data-recent-clients'), 'both dropdowns appear');
  assert.ok(res.body.includes('data-testid="invoice-new-recent-items"'),
    'both dropdowns appear');
}

async function testGetNewClientsFailureDoesNotStrandItemsDropdown() {
  resetStore();
  users.set(5, { id: 5, plan: 'pro', invoice_count: 7, name: 'Dave', email: 'd@x.com' });
  recentClientsImpl = async () => { throw new Error('pg pool exhausted'); };
  recentItemsImpl = async () => ([{ description: 'Strategy session', amount: 400, unit_price: 400, quantity: 1 }]);
  const routes = installDbStub();
  const app = buildApp({ id: 5, plan: 'pro', invoice_count: 7 }, routes);

  const origErr = console.error;
  console.error = () => {};
  try {
    const res = await request(app, 'GET', '/invoices/new');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.includes('data-testid="invoice-new-recent-items"'),
      'items dropdown still renders when ONLY the clients helper threw');
    assert.ok(res.body.includes('Strategy session'),
      'items option label renders');
  } finally {
    console.error = origErr;
  }
}

async function testValidationErrorPathPreservesRecentItems() {
  resetStore();
  users.set(6, { id: 6, plan: 'pro', invoice_count: 3, name: 'Eve', email: 'e@x.com' });
  recentItemsImpl = async () => ([{ description: 'Workshop', amount: 800, unit_price: 200, quantity: 4 }]);
  const routes = installDbStub();
  const app = buildApp({ id: 6, plan: 'pro', invoice_count: 3 }, routes);

  // Trigger validation error — empty client_name + items
  const res = await request(app, 'POST', '/invoices/new', {
    invoice_number: 'INV-2026-0004',
    client_name: '',
    items: '',
    subtotal: '0', tax_rate: '0', tax_amount: '0', total: '0'
  });
  assert.strictEqual(res.status, 200,
    'validation error re-renders the form (no redirect)');
  assert.ok(res.body.includes('data-testid="invoice-new-recent-items"'),
    'validation re-render must still surface the dropdown — user does not lose their typed context');
  assert.ok(res.body.includes('Workshop'),
    'option labels survive the validation re-render');
  assert.strictEqual(recentItemsCalls.length, 1,
    'validation re-render fires the items lookup exactly once');
}

// ---------------------------------------------------------------------------
// Layer 2 — view invoice-form.ejs render shape
// ---------------------------------------------------------------------------

async function renderForm(opts) {
  const viewsDir = path.join(__dirname, '..', 'views');
  return ejs.renderFile(path.join(viewsDir, 'invoice-form.ejs'),
    Object.assign({
      title: 'New Invoice',
      invoice: null,
      invoiceNumber: 'INV-2026-0001',
      recentClients: [],
      recentItems: [],
      user: { id: 1, plan: 'pro', invoice_count: 5, name: 'Alice', email: 'a@x.com', business_name: 'Acme', payment_instructions: null },
      flash: null,
      csrfToken: 'tkn'
    }, opts || {}),
    { views: [viewsDir] });
}

async function testViewRendersDropdownWithOptions() {
  const html = await renderForm({
    recentItems: [
      { description: 'Logo design', unit_price: 500, quantity: 1, amount: 500 },
      { description: 'Hourly rate', unit_price: 75.5, quantity: 4, amount: 302 },
      { description: 'Photography', unit_price: 1200, quantity: 1, amount: 1200 }
    ]
  });
  assert.ok(html.includes('data-testid="invoice-new-recent-items"'),
    'dropdown wrapper renders');
  assert.ok(html.includes('data-testid="invoice-new-recent-items-select"'),
    'select element carries testid');
  assert.ok(/x-model="pickedItem"/.test(html),
    'select binds pickedItem via x-model');
  assert.ok(/@change="fillFromRecentItem\(\)"/.test(html),
    'select calls fillFromRecentItem() on @change');
  assert.ok(html.includes('Logo design'),
    'first option description renders');
  assert.ok(html.includes('$500.00'),
    'integer unit_price formats to 2 decimals');
  assert.ok(html.includes('$75.50'),
    'decimal unit_price formats to 2 decimals');
  assert.ok(html.includes('qty 4'),
    'quantity surfaces in option label');
}

async function testViewOmitsDropdownWhenAbsent() {
  const html = await renderForm({ recentItems: undefined });
  assert.ok(!html.includes('data-testid="invoice-new-recent-items"'),
    'missing recentItems → dropdown omitted');
}

async function testViewOmitsDropdownWhenNonArray() {
  for (const bad of [null, 'oops', 42, { rows: [] }, true]) {
    const html = await renderForm({ recentItems: bad });
    assert.ok(!html.includes('data-testid="invoice-new-recent-items"'),
      `non-array recentItems (${typeof bad}) → dropdown omitted`);
  }
}

async function testViewFiltersMalformedRecentItems() {
  const html = await renderForm({
    recentItems: [
      { description: 'Good item', unit_price: 200, quantity: 1, amount: 200 },
      { description: '', unit_price: 50, quantity: 1, amount: 50 },
      { description: '   ', unit_price: 50, quantity: 1, amount: 50 },
      { description: 'Zero unit', unit_price: 0, quantity: 5, amount: 0 },
      { description: 'Negative unit', unit_price: -50, quantity: 1, amount: -50 },
      { description: 'NaN unit', unit_price: 'not-a-number', quantity: 1, amount: 0 },
      { description: null, unit_price: 100, quantity: 1, amount: 100 },
      { description: 'Another good', unit_price: 300, quantity: 1, amount: 300 }
    ]
  });
  assert.ok(html.includes('Good item'), 'valid first item renders');
  assert.ok(html.includes('Another good'), 'valid last item renders');
  assert.ok(!html.includes('Zero unit'), 'zero unit_price filtered out');
  assert.ok(!html.includes('Negative unit'), 'negative unit_price filtered out');
  assert.ok(!html.includes('NaN unit'), 'NaN unit_price filtered out');
}

async function testViewTruncatesLongDescription() {
  const longDesc = 'A very long line item description '.repeat(10);
  const html = await renderForm({
    recentItems: [{ description: longDesc, unit_price: 200, quantity: 1, amount: 200 }]
  });
  assert.ok(!html.includes(longDesc),
    'oversize description truncated before render');
  assert.ok(html.includes('A very long line item description'),
    'leading chars still render');
}

async function testViewDropdownHiddenOnEditFlow() {
  // Edit-flow ("invoice" set) must NOT surface the recent-items dropdown —
  // the user is editing an existing invoice and quick-picking a new line
  // doesn't fit the surface. Same contract as the business_name +
  // payment_instructions captures.
  const html = await renderForm({
    invoice: {
      id: 42, invoice_number: 'INV-2026-0042', status: 'draft',
      client_name: 'Client', client_email: '', client_address: '',
      items: [{ description: 'Work', quantity: 1, unit_price: 100 }],
      tax_rate: 0, notes: '',
      issued_date: new Date('2026-05-01'),
      due_date: new Date('2026-05-31')
    },
    recentItems: [
      { description: 'Logo design', unit_price: 500, quantity: 1, amount: 500 }
    ]
  });
  assert.ok(!html.includes('data-testid="invoice-new-recent-items"'),
    'edit-flow MUST NOT show the recent-items dropdown');
}

async function testViewHostileDescriptionEscaped() {
  // XSS defence — a malicious past invoice description should not break out
  // of the option label.
  const html = await renderForm({
    recentItems: [{
      description: '"><img src=x onerror=alert(1)>',
      unit_price: 99, quantity: 1, amount: 99
    }]
  });
  assert.ok(!html.includes('"><img src=x onerror=alert(1)>'),
    'raw hostile string must NOT appear in output (EJS auto-escapes)');
  // Confirm escaped representation IS present
  assert.ok(/&#34;|&quot;/.test(html) || html.includes('&gt;'),
    'EJS-escaped form of hostile chars present');
}

// ---------------------------------------------------------------------------
// Layer 3 — invoiceEditor factory: fillFromRecentItem behaviour
// ---------------------------------------------------------------------------

function extractInvoiceEditorFactory() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'views', 'invoice-form.ejs'), 'utf8');
  // Replace the EJS `<%= invoice ? Number(invoice.tax_rate) : 0 %>` with 0
  // so the extracted source is plain JS.
  const cleaned = html.replace(/<%=\s*invoice\s*\?\s*Number\(invoice\.tax_rate\)\s*:\s*0\s*%>/g, '0');
  const fnStart = cleaned.indexOf('function invoiceEditor');
  assert.ok(fnStart >= 0, 'invoiceEditor factory must be extractable');
  let depth = 0;
  let i = cleaned.indexOf('{', fnStart);
  for (; i < cleaned.length; i++) {
    if (cleaned[i] === '{') depth++;
    else if (cleaned[i] === '}') {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  return cleaned.slice(fnStart, i);
}

function makeFactoryInstance(initialItems, recentItems) {
  const src = extractInvoiceEditorFactory();
  const ctx = { module: { exports: {} } };
  vm.createContext(ctx);
  vm.runInContext(src + '\n; module.exports = invoiceEditor;', ctx);
  return ctx.module.exports(
    initialItems,
    [],
    { name: '', email: '', address: '' },
    recentItems
  );
}

function testFactoryReplacesEmptyLine() {
  const inst = makeFactoryInstance([], [
    { description: 'Logo design', quantity: 1, unit_price: 500, amount: 500 }
  ]);
  inst.init();
  // Default state: one empty starter row.
  assert.strictEqual(inst.items.length, 1);
  assert.strictEqual(inst.items[0].description, '');
  inst.pickedItem = '0';
  inst.fillFromRecentItem();
  assert.strictEqual(inst.items.length, 1,
    'picking into an empty starter row REPLACES it (does not append a second row)');
  assert.strictEqual(inst.items[0].description, 'Logo design');
  assert.strictEqual(inst.items[0].quantity, 1);
  assert.strictEqual(inst.items[0].unit_price, 500);
  assert.strictEqual(inst.subtotal, 500, 'recalculate() ran after fill');
  assert.strictEqual(inst.pickedItem, '',
    'pickedItem resets so next pick is clean');
}

function testFactoryAppendsWhenLastLineIsFilled() {
  const inst = makeFactoryInstance([
    { description: 'Existing work', quantity: 2, unit_price: 100 }
  ], [
    { description: 'Logo design', quantity: 1, unit_price: 500, amount: 500 }
  ]);
  inst.init();
  assert.strictEqual(inst.items.length, 1);
  inst.pickedItem = '0';
  inst.fillFromRecentItem();
  assert.strictEqual(inst.items.length, 2,
    'picking with a filled last line APPENDS a new line');
  assert.strictEqual(inst.items[1].description, 'Logo design');
  assert.strictEqual(inst.items[1].quantity, 1);
  assert.strictEqual(inst.items[1].unit_price, 500);
  // Existing line is untouched
  assert.strictEqual(inst.items[0].description, 'Existing work');
  assert.strictEqual(inst.items[0].quantity, 2);
  assert.strictEqual(inst.items[0].unit_price, 100);
  assert.strictEqual(inst.subtotal, 200 + 500,
    'recalculate sums BOTH lines');
}

function testFactoryQuantityPreserved() {
  // The whole point of unit_price + quantity (vs the /quick `amount`
  // collapse) is that a "Hourly rate · qty=4 · $150/hr" row populates BOTH
  // fields — not "qty=1 · $600/hr".
  const inst = makeFactoryInstance([], [
    { description: 'Hourly rate', quantity: 4, unit_price: 150, amount: 600 }
  ]);
  inst.init();
  inst.pickedItem = '0';
  inst.fillFromRecentItem();
  assert.strictEqual(inst.items[0].quantity, 4,
    'quantity from the past invoice line carries forward');
  assert.strictEqual(inst.items[0].unit_price, 150,
    'unit_price from the past invoice line carries forward');
  assert.strictEqual(inst.subtotal, 600,
    'line total = qty * unit_price = 4 * 150');
}

function testFactoryBadPicksNoOp() {
  const startItems = [{ description: 'Initial', quantity: 1, unit_price: 100 }];
  const inst = makeFactoryInstance(startItems, [
    { description: 'Logo design', quantity: 1, unit_price: 500, amount: 500 }
  ]);
  inst.init();
  const snapshot = JSON.stringify(inst.items);
  for (const bad of ['', '-1', 'abc', '99', null, undefined]) {
    inst.pickedItem = bad;
    inst.fillFromRecentItem();
    assert.strictEqual(JSON.stringify(inst.items), snapshot,
      `bad pickedItem (${JSON.stringify(bad)}) must NOT mutate items`);
  }
}

function testFactoryRejectsNonPositiveValues() {
  // A row whose unit_price/quantity arrived as 0 (defence-in-depth against a
  // view-side filter miss) must NOT populate the line — a freelancer
  // accidentally shipping a $0 line item is a billing-correctness bug.
  const inst = makeFactoryInstance([], [
    { description: 'Zero unit', quantity: 1, unit_price: 0, amount: 0 },
    { description: 'Zero qty', quantity: 0, unit_price: 100, amount: 0 }
  ]);
  inst.init();
  const before = JSON.stringify(inst.items);
  inst.pickedItem = '0';
  inst.fillFromRecentItem();
  assert.strictEqual(JSON.stringify(inst.items), before,
    'zero unit_price recent-item pick must no-op');
  inst.pickedItem = '1';
  inst.fillFromRecentItem();
  assert.strictEqual(JSON.stringify(inst.items), before,
    'zero quantity recent-item pick must no-op');
}

function testFactoryNonArrayRecentItemsCoerces() {
  // Defence-in-depth: a future caller passing a non-array third arg should
  // not throw at construction.
  const inst = makeFactoryInstance([], null);
  inst.init();
  assert.ok(Array.isArray(inst.recentItems), 'non-array coerces to []');
  assert.strictEqual(inst.recentItems.length, 0);
  // fillFromRecentItem on empty list no-ops cleanly.
  inst.pickedItem = '0';
  inst.fillFromRecentItem();
  // Still has the default empty starter row.
  assert.strictEqual(inst.items.length, 1);
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function run() {
  const tests = [
    testGetNewLoadsRecentItems,
    testGetNewOmitsDropdownForBrandNewUser,
    testGetNewSurvivesRecentItemsDbFailure,
    testGetNewBothDropdownLookupsConcurrent,
    testGetNewClientsFailureDoesNotStrandItemsDropdown,
    testValidationErrorPathPreservesRecentItems,
    testViewRendersDropdownWithOptions,
    testViewOmitsDropdownWhenAbsent,
    testViewOmitsDropdownWhenNonArray,
    testViewFiltersMalformedRecentItems,
    testViewTruncatesLongDescription,
    testViewDropdownHiddenOnEditFlow,
    testViewHostileDescriptionEscaped,
    testFactoryReplacesEmptyLine,
    testFactoryAppendsWhenLastLineIsFilled,
    testFactoryQuantityPreserved,
    testFactoryBadPicksNoOp,
    testFactoryRejectsNonPositiveValues,
    testFactoryNonArrayRecentItemsCoerces
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
