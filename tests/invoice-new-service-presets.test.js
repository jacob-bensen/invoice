'use strict';

/*
 * "Suggested services" presets dropdown on /invoices/new (Milestone 2 —
 * first dashboard re-entry → first real invoice created).
 *
 * The recent-items dropdown only renders when the freelancer has at least
 * one non-seed line item in history. A day-zero account has zero history,
 * so the Line Items section stays a blank set of fields — the highest-
 * friction beat for a brand-new user trying to ship their first real
 * invoice. This file locks in the parallel surface:
 *
 *   - lib/service-presets.js exports a frozen SERVICE_PRESETS array with a
 *     stable shape ({ description, quantity, unit_price }) re-usable as a
 *     fill source by the same Alpine factory pattern.
 *   - Route GET /invoices/new + POST validation/catch paths thread the
 *     presets array down to the view, exactly like recentItems.
 *   - The view layer renders the presets dropdown ONLY for the new-flow,
 *     ONLY when recentItems is empty (mutually exclusive — no double
 *     pickers), and ONLY when servicePresets has at least one valid row.
 *   - The Alpine factory exposes fillFromServicePreset() that mirrors
 *     fillFromRecentItem() semantics (replace empty last row vs append).
 *   - Edit-flow hides the presets dropdown unconditionally.
 *   - Bad picks (out-of-range, NaN, non-positive values) no-op silently.
 *
 * Run: NODE_ENV=test node tests/invoice-new-service-presets.test.js
 */

const assert = require('assert');
const path = require('path');
const vm = require('vm');
const fs = require('fs');
const ejs = require('ejs');
const express = require('express');
const http = require('http');

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

const { SERVICE_PRESETS } = require('../lib/service-presets');

// ---------------------------------------------------------------------------
// Test store + db stub
// ---------------------------------------------------------------------------

const users = new Map();
let recentItemsImpl = async () => [];
let nextInvoiceId = 900;

function resetStore() {
  users.clear();
  recentItemsImpl = async () => [];
  nextInvoiceId = 900;
}

function buildDbStub() {
  return {
    pool: { query: async () => ({ rows: [] }) },
    db: {
      async getUserById(id) { return users.get(id) || null; },
      async getInvoiceById() { return null; },
      async getInvoicesByUser() { return []; },
      async getNextInvoiceNumber() { return 'INV-2026-0001'; },
      async getRecentClientsForUser() { return []; },
      async getRecentItemsForUser(userId, limit) {
        return recentItemsImpl(userId, limit);
      },
      async createInvoice(data) {
        const id = nextInvoiceId++;
        const u = users.get(data.user_id);
        if (u) u.invoice_count = (u.invoice_count || 0) + 1;
        return Object.assign({ id, status: 'draft', is_seed: false }, data);
      },
      async getOrCreatePublicToken() { return 'tok_service_presets'; },
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
// Layer 1 — SERVICE_PRESETS shape contract
// ---------------------------------------------------------------------------

function testPresetsAreFrozenNonEmpty() {
  assert.ok(Array.isArray(SERVICE_PRESETS), 'SERVICE_PRESETS must be an array');
  assert.ok(SERVICE_PRESETS.length >= 6,
    'SERVICE_PRESETS must seed a reasonable starter list (>=6 categories)');
  assert.ok(Object.isFrozen(SERVICE_PRESETS),
    'top-level array frozen — accidental mutation by a route handler must throw in strict mode');
  for (const p of SERVICE_PRESETS) {
    assert.ok(p && typeof p === 'object', 'preset row must be an object');
    assert.ok(Object.isFrozen(p), 'preset row frozen — defence-in-depth against mutation');
    assert.strictEqual(typeof p.description, 'string', 'description string');
    assert.ok(p.description.trim().length > 0, 'description non-empty');
    assert.ok(Number.isFinite(p.quantity) && p.quantity > 0,
      'quantity positive number');
    assert.ok(Number.isFinite(p.unit_price) && p.unit_price > 0,
      'unit_price positive number — preset must never zero-bill a freelancer');
  }
}

// ---------------------------------------------------------------------------
// Layer 2 — Route GET /invoices/new threads servicePresets
// ---------------------------------------------------------------------------

async function testGetNewRendersPresetsForBrandNewUser() {
  resetStore();
  users.set(10, { id: 10, plan: 'free', invoice_count: 0, name: 'New', email: 'n@x.com' });
  recentItemsImpl = async () => []; // brand-new — no history
  const routes = installDbStub();
  const app = buildApp({ id: 10, plan: 'free', invoice_count: 0 }, routes);

  const res = await request(app, 'GET', '/invoices/new');
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.includes('data-testid="invoice-new-service-presets"'),
    'brand-new account with zero recent items must see the presets dropdown');
  assert.ok(res.body.includes('data-testid="invoice-new-service-presets-select"'),
    'select element carries its own testid');
  assert.ok(res.body.includes(SERVICE_PRESETS[0].description),
    'first preset description renders in an option');
  assert.ok(!res.body.includes('data-testid="invoice-new-recent-items"'),
    'recent-items dropdown stays hidden — mutually exclusive surface');
}

async function testGetNewHidesPresetsWhenRecentItemsPresent() {
  resetStore();
  users.set(11, { id: 11, plan: 'pro', invoice_count: 4, name: 'Repeat', email: 'r@x.com' });
  recentItemsImpl = async () => ([
    { description: 'Past work', amount: 200, unit_price: 200, quantity: 1 }
  ]);
  const routes = installDbStub();
  const app = buildApp({ id: 11, plan: 'pro', invoice_count: 4 }, routes);

  const res = await request(app, 'GET', '/invoices/new');
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.includes('data-testid="invoice-new-recent-items"'),
    'recent-items dropdown renders when user has history');
  assert.ok(!res.body.includes('data-testid="invoice-new-service-presets"'),
    'presets dropdown must NOT compete with recent items — repeat user already has a relevant picker');
}

async function testValidationErrorPathPreservesPresets() {
  resetStore();
  users.set(12, { id: 12, plan: 'free', invoice_count: 0, name: 'Eve', email: 'e@x.com' });
  recentItemsImpl = async () => [];
  const routes = installDbStub();
  const app = buildApp({ id: 12, plan: 'free', invoice_count: 0 }, routes);

  const res = await request(app, 'POST', '/invoices/new', {
    invoice_number: 'INV-2026-0001',
    client_name: '',
    items: '',
    subtotal: '0', tax_rate: '0', tax_amount: '0', total: '0'
  });
  assert.strictEqual(res.status, 200,
    'validation error re-renders the form (no redirect)');
  assert.ok(res.body.includes('data-testid="invoice-new-service-presets"'),
    'validation re-render must still surface the presets dropdown — brand-new user does not lose their fill source');
}

// ---------------------------------------------------------------------------
// Layer 3 — view invoice-form.ejs render shape
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
      servicePresets: SERVICE_PRESETS,
      user: { id: 1, plan: 'free', invoice_count: 0, name: 'New', email: 'n@x.com', business_name: 'Acme', payment_instructions: 'Venmo @x' },
      flash: null,
      csrfToken: 'tkn'
    }, opts || {}),
    { views: [viewsDir] });
}

async function testViewRendersPresetsWithFormattedOptions() {
  const html = await renderForm({});
  assert.ok(html.includes('data-testid="invoice-new-service-presets"'),
    'wrapper renders');
  assert.ok(html.includes('data-testid="invoice-new-service-presets-select"'),
    'select carries testid');
  assert.ok(/x-model="pickedPreset"/.test(html),
    'select binds pickedPreset via x-model');
  assert.ok(/@change="fillFromServicePreset\(\)"/.test(html),
    'select calls fillFromServicePreset() on @change');
  // First preset option present with 2-decimal $ price
  const first = SERVICE_PRESETS[0];
  assert.ok(html.includes(first.description),
    'first preset description renders');
  assert.ok(html.includes('$' + first.unit_price.toFixed(2)),
    'first preset unit_price formats to 2 decimals in option label');
}

async function testViewHidesPresetsWhenRecentItemsNonEmpty() {
  const html = await renderForm({
    recentItems: [
      { description: 'Logo design', unit_price: 500, quantity: 1, amount: 500 }
    ]
  });
  assert.ok(html.includes('data-testid="invoice-new-recent-items"'),
    'recent items dropdown renders');
  assert.ok(!html.includes('data-testid="invoice-new-service-presets"'),
    'presets hidden — recent items already covers the fill role');
}

async function testViewHidesPresetsOnEditFlow() {
  const html = await renderForm({
    invoice: {
      id: 42, invoice_number: 'INV-2026-0042', status: 'draft',
      client_name: 'Client', client_email: '', client_address: '',
      items: [{ description: 'Work', quantity: 1, unit_price: 100 }],
      tax_rate: 0, notes: '',
      issued_date: new Date('2026-05-01'),
      due_date: new Date('2026-05-31')
    },
    recentItems: []
  });
  assert.ok(!html.includes('data-testid="invoice-new-service-presets"'),
    'edit-flow MUST NOT show the presets dropdown');
}

async function testViewHidesPresetsWhenAbsentOrMalformed() {
  for (const bad of [undefined, null, 'oops', 42, true, { rows: [] }]) {
    const html = await renderForm({ servicePresets: bad });
    assert.ok(!html.includes('data-testid="invoice-new-service-presets"'),
      `non-array servicePresets (${typeof bad}) → dropdown omitted`);
  }
}

async function testViewFiltersMalformedPresets() {
  const html = await renderForm({
    servicePresets: [
      { description: 'Good preset', quantity: 1, unit_price: 100 },
      { description: '', quantity: 1, unit_price: 50 },
      { description: 'Zero unit', quantity: 1, unit_price: 0 },
      { description: 'Negative unit', quantity: 1, unit_price: -10 },
      { description: 'NaN unit', quantity: 1, unit_price: 'oops' },
      { description: 'Another good', quantity: 2, unit_price: 200 }
    ]
  });
  assert.ok(html.includes('Good preset'), 'valid first preset renders');
  assert.ok(html.includes('Another good'), 'valid last preset renders');
  assert.ok(!html.includes('Zero unit'), 'zero unit_price filtered');
  assert.ok(!html.includes('Negative unit'), 'negative unit_price filtered');
  assert.ok(!html.includes('NaN unit'), 'non-numeric unit_price filtered');
}

async function testViewHostilePresetDescriptionEscaped() {
  const html = await renderForm({
    servicePresets: [
      { description: '"><img src=x onerror=alert(1)>', quantity: 1, unit_price: 99 }
    ]
  });
  assert.ok(!html.includes('"><img src=x onerror=alert(1)>'),
    'raw hostile string must NOT appear in output (EJS auto-escapes)');
}

// ---------------------------------------------------------------------------
// Layer 4 — invoiceEditor factory: fillFromServicePreset behaviour
// ---------------------------------------------------------------------------

function extractInvoiceEditorFactory() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'views', 'invoice-form.ejs'), 'utf8');
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

function makeFactoryInstance(initialItems, servicePresets) {
  const src = extractInvoiceEditorFactory();
  const ctx = { module: { exports: {} } };
  vm.createContext(ctx);
  vm.runInContext(src + '\n; module.exports = invoiceEditor;', ctx);
  return ctx.module.exports(
    initialItems,
    [],
    { name: '', email: '', address: '' },
    [], // recentItems empty so the test isolates preset behaviour
    servicePresets
  );
}

function testFactoryReplacesEmptyLineWithPreset() {
  const inst = makeFactoryInstance([], [
    { description: 'Logo design', quantity: 1, unit_price: 250 }
  ]);
  inst.init();
  assert.strictEqual(inst.items.length, 1);
  assert.strictEqual(inst.items[0].description, '');
  inst.pickedPreset = '0';
  inst.fillFromServicePreset();
  assert.strictEqual(inst.items.length, 1,
    'picking into the empty starter row REPLACES it');
  assert.strictEqual(inst.items[0].description, 'Logo design');
  assert.strictEqual(inst.items[0].quantity, 1);
  assert.strictEqual(inst.items[0].unit_price, 250);
  assert.strictEqual(inst.subtotal, 250, 'recalculate() ran after preset fill');
  assert.strictEqual(inst.pickedPreset, '',
    'pickedPreset resets so next pick is clean');
}

function testFactoryAppendsPresetWhenLastLineFilled() {
  const inst = makeFactoryInstance([
    { description: 'Initial work', quantity: 1, unit_price: 100 }
  ], [
    { description: 'Hourly consulting', quantity: 1, unit_price: 100 }
  ]);
  inst.init();
  assert.strictEqual(inst.items.length, 1);
  inst.pickedPreset = '0';
  inst.fillFromServicePreset();
  assert.strictEqual(inst.items.length, 2,
    'picking with a filled last line APPENDS a new line');
  assert.strictEqual(inst.items[1].description, 'Hourly consulting');
  assert.strictEqual(inst.items[0].description, 'Initial work',
    'pre-existing line untouched');
  assert.strictEqual(inst.subtotal, 200, 'recalculate sums both lines');
}

function testFactoryBadPresetPicksNoOp() {
  const inst = makeFactoryInstance([], [
    { description: 'Logo design', quantity: 1, unit_price: 250 }
  ]);
  inst.init();
  const snapshot = JSON.stringify(inst.items);
  for (const bad of ['', '-1', 'abc', '99', null, undefined]) {
    inst.pickedPreset = bad;
    inst.fillFromServicePreset();
    assert.strictEqual(JSON.stringify(inst.items), snapshot,
      `bad pickedPreset (${JSON.stringify(bad)}) must NOT mutate items`);
  }
}

function testFactoryRejectsNonPositivePresetValues() {
  const inst = makeFactoryInstance([], [
    { description: 'Zero unit', quantity: 1, unit_price: 0 },
    { description: 'Zero qty', quantity: 0, unit_price: 100 }
  ]);
  inst.init();
  const before = JSON.stringify(inst.items);
  inst.pickedPreset = '0';
  inst.fillFromServicePreset();
  assert.strictEqual(JSON.stringify(inst.items), before,
    'zero unit_price preset pick must no-op');
  inst.pickedPreset = '1';
  inst.fillFromServicePreset();
  assert.strictEqual(JSON.stringify(inst.items), before,
    'zero quantity preset pick must no-op');
}

function testFactoryNonArrayPresetsCoerces() {
  const inst = makeFactoryInstance([], null);
  inst.init();
  assert.ok(Array.isArray(inst.servicePresets), 'non-array coerces to []');
  assert.strictEqual(inst.servicePresets.length, 0);
  inst.pickedPreset = '0';
  inst.fillFromServicePreset();
  assert.strictEqual(inst.items.length, 1,
    'fillFromServicePreset on empty list cleanly no-ops');
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function run() {
  const tests = [
    testPresetsAreFrozenNonEmpty,
    testGetNewRendersPresetsForBrandNewUser,
    testGetNewHidesPresetsWhenRecentItemsPresent,
    testValidationErrorPathPreservesPresets,
    testViewRendersPresetsWithFormattedOptions,
    testViewHidesPresetsWhenRecentItemsNonEmpty,
    testViewHidesPresetsOnEditFlow,
    testViewHidesPresetsWhenAbsentOrMalformed,
    testViewFiltersMalformedPresets,
    testViewHostilePresetDescriptionEscaped,
    testFactoryReplacesEmptyLineWithPreset,
    testFactoryAppendsPresetWhenLastLineFilled,
    testFactoryBadPresetPicksNoOp,
    testFactoryRejectsNonPositivePresetValues,
    testFactoryNonArrayPresetsCoerces
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
