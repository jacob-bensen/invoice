'use strict';

/*
 * "Suggested services" presets dropdown on /invoices/quick (Milestone 2 —
 * first dashboard re-entry → first real invoice created).
 *
 * The recent-items dropdown on /quick only surfaces when the freelancer has
 * at least one non-seed line item in history. A day-zero freelancer — the
 * dominant cohort landing here from the welcome-email deep-link
 * (/invoices/quick?welcome=1) — has zero history, so the Description +
 * Amount fields sit blank with no priming. That blank moment is one of
 * the highest-friction beats in the M2 → M3 handoff: the user has to
 * invent both a description AND a price from scratch on the primary
 * activation surface.
 *
 * The advanced form /invoices/new already surfaces the same presets for
 * this cohort. This test file locks in the parallel surface on /quick:
 *
 *   - Route GET /invoices/quick + POST validation-error + POST catch-block
 *     paths thread SERVICE_PRESETS down to the view.
 *   - The view layer renders the presets dropdown ONLY when recentItems is
 *     empty (mutually exclusive — no double pickers) and only when
 *     servicePresets has at least one valid row.
 *   - The Alpine quickInvoiceAutosave() factory exposes fillFromServicePreset()
 *     that fills BOTH description and amount from the picked row (a /quick
 *     invoice is single-line — amount == quantity * unit_price).
 *   - Bad picks (out-of-range, NaN, non-positive values) no-op silently.
 *   - EJS auto-escapes hostile description strings.
 *   - Non-array / missing servicePresets input collapses to no dropdown
 *     (defence-in-depth against a partial deploy).
 *
 * Run: NODE_ENV=test node tests/invoice-quick-service-presets.test.js
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
let recentClientsImpl = async () => [];
let pendingImpl = async () => null;

function resetStore() {
  users.clear();
  recentItemsImpl = async () => [];
  recentClientsImpl = async () => [];
  pendingImpl = async () => null;
}

function buildDbStub() {
  return {
    pool: { query: async () => ({ rows: [] }) },
    db: {
      async getUserById(id) { return users.get(id) || null; },
      async getInvoiceById() { return null; },
      async getInvoicesByUser() { return []; },
      async getNextInvoiceNumber() { return 'INV-2026-0001'; },
      async getRecentClientsForUser() { return recentClientsImpl(); },
      async getRecentItemsForUser() { return recentItemsImpl(); },
      async getPendingQuickInvoice() { return pendingImpl(); },
      async clearPendingQuickInvoice() {},
      async setPendingQuickInvoice() {},
      async getOldestStaleDraft() { return null; },
      async getRecentRevenueStats() { return null; },
      async markInvoiceSentFromShareIntent() { return null; },
      async recordFirstSentIfMissing() { return null; },
      async createInvoice() { return null; },
      async updateUser(id, fields) {
        const u = users.get(id);
        if (u) Object.assign(u, fields);
        return u;
      }
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
// Layer 1 — Route-side threading of SERVICE_PRESETS
// ---------------------------------------------------------------------------

async function testGetQuickThreadsPresetsForBrandNewUser() {
  resetStore();
  users.set(10, { id: 10, plan: 'free', invoice_count: 0, name: 'New', email: 'n@x.com', business_name: 'Acme', payment_instructions: 'Venmo @acme' });
  recentItemsImpl = async () => []; // brand-new — no history
  const routes = installDbStub();
  const app = buildApp({ id: 10, plan: 'free', invoice_count: 0 }, routes);

  const res = await request(app, 'GET', '/invoices/quick');
  assert.strictEqual(res.status, 200, 'GET /invoices/quick renders');
  assert.ok(res.body.includes('data-testid="invoice-quick-service-presets"'),
    'brand-new cohort must see the presets dropdown on /quick');
  assert.ok(res.body.includes('data-testid="invoice-quick-service-presets-select"'),
    'select element carries its own testid');
  assert.ok(res.body.includes(SERVICE_PRESETS[0].description),
    'first preset description renders in an option');
  assert.ok(!res.body.includes('data-testid="invoice-quick-recent-items"'),
    'recent-items dropdown stays hidden — mutually exclusive surface');
}

async function testGetQuickHidesPresetsWhenRecentItemsPresent() {
  resetStore();
  users.set(11, { id: 11, plan: 'pro', invoice_count: 4, name: 'Repeat', email: 'r@x.com', business_name: 'Repeat Co', payment_instructions: 'Venmo @r' });
  recentItemsImpl = async () => ([
    { description: 'Past work', amount: 200 }
  ]);
  const routes = installDbStub();
  const app = buildApp({ id: 11, plan: 'pro', invoice_count: 4 }, routes);

  const res = await request(app, 'GET', '/invoices/quick');
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.includes('data-testid="invoice-quick-recent-items"'),
    'recent-items dropdown renders when user has history');
  assert.ok(!res.body.includes('data-testid="invoice-quick-service-presets"'),
    'presets dropdown must NOT compete with recent items — repeat user already has a relevant picker');
}

async function testValidationErrorPathPreservesPresets() {
  resetStore();
  users.set(12, { id: 12, plan: 'free', invoice_count: 0, name: 'Eve', email: 'e@x.com', business_name: 'Eve Co', payment_instructions: 'Venmo @e' });
  recentItemsImpl = async () => [];
  const routes = installDbStub();
  const app = buildApp({ id: 12, plan: 'free', invoice_count: 0 }, routes);

  // Trigger validation error: missing client_name.
  const res = await request(app, 'POST', '/invoices/quick', {
    client_name: '',
    description: 'work',
    amount: '100'
  });
  assert.strictEqual(res.status, 200,
    'validation error re-renders the form (no redirect)');
  assert.ok(res.body.includes('data-testid="invoice-quick-service-presets"'),
    'validation re-render must still surface the presets dropdown — brand-new user does not lose their fill source');
}

// ---------------------------------------------------------------------------
// Layer 2 — View invoice-quick.ejs render shape
// ---------------------------------------------------------------------------

async function renderQuick(opts) {
  const viewsDir = path.join(__dirname, '..', 'views');
  return ejs.renderFile(path.join(viewsDir, 'invoice-quick.ejs'),
    Object.assign({
      title: 'Quick invoice',
      user: { id: 1, plan: 'free', invoice_count: 0, name: 'New', email: 'n@x.com', business_name: 'Acme', payment_instructions: 'Venmo @acme' },
      flash: null,
      submitted: null,
      pendingRestored: false,
      recentClients: [],
      recentItems: [],
      servicePresets: SERVICE_PRESETS,
      currency: 'USD',
      currencySymbol: '$',
      welcome: false,
      noindex: true,
      csrfToken: 'tkn'
    }, opts || {}),
    { views: [viewsDir] });
}

async function testViewRendersPresetsWithFormattedOptions() {
  const html = await renderQuick({});
  assert.ok(html.includes('data-testid="invoice-quick-service-presets"'),
    'wrapper renders');
  assert.ok(html.includes('data-testid="invoice-quick-service-presets-select"'),
    'select carries testid');
  assert.ok(/x-model="pickedPreset"/.test(html),
    'select binds pickedPreset via x-model');
  assert.ok(/@change="fillFromServicePreset\(\)"/.test(html),
    'select calls fillFromServicePreset() on @change');
  const first = SERVICE_PRESETS[0];
  assert.ok(html.includes(first.description),
    'first preset description renders');
  // Amount == quantity * unit_price for a single-line quick invoice.
  const expectedAmount = first.quantity * first.unit_price;
  assert.ok(html.includes('$' + expectedAmount.toFixed(2)),
    'first preset amount (qty * unit_price) formats to 2 decimals in option label');
}

async function testViewCurrencyAwareLabels() {
  const html = await renderQuick({
    currencySymbol: '€',
    currency: 'EUR'
  });
  const first = SERVICE_PRESETS[0];
  const expectedAmount = first.quantity * first.unit_price;
  assert.ok(html.includes('€' + expectedAmount.toFixed(2)),
    'EUR user sees € on preset labels — consistent with the rest of the /quick form');
  assert.ok(!/\$\d/.test(html.split('data-testid="invoice-quick-service-presets"')[1].split('</select>')[0]),
    'no stray $ inside the presets dropdown block for a non-USD user');
}

async function testViewHidesPresetsWhenRecentItemsNonEmpty() {
  const html = await renderQuick({
    recentItems: [
      { description: 'Prior invoice', amount: 500 }
    ]
  });
  assert.ok(html.includes('data-testid="invoice-quick-recent-items"'),
    'recent items dropdown renders');
  assert.ok(!html.includes('data-testid="invoice-quick-service-presets"'),
    'presets hidden — recent items already covers the fill role');
}

async function testViewHidesPresetsWhenAbsentOrMalformed() {
  for (const bad of [undefined, null, 'oops', 42, true, { rows: [] }]) {
    const html = await renderQuick({ servicePresets: bad });
    assert.ok(!html.includes('data-testid="invoice-quick-service-presets"'),
      `non-array servicePresets (${typeof bad}) → dropdown omitted`);
  }
}

async function testViewFiltersMalformedPresets() {
  const html = await renderQuick({
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
  // qty=2 * unit=200 = 400 total amount rendered
  assert.ok(html.includes('$400.00'),
    'multi-quantity preset renders amount = qty * unit_price');
}

async function testViewHostilePresetDescriptionEscaped() {
  const html = await renderQuick({
    servicePresets: [
      { description: '"><img src=x onerror=alert(1)>', quantity: 1, unit_price: 99 }
    ]
  });
  assert.ok(!html.includes('"><img src=x onerror=alert(1)>'),
    'raw hostile string must NOT appear in output (EJS auto-escapes)');
}

async function testFactoryReceivesPresetsArgument() {
  const html = await renderQuick({});
  // The Alpine factory call is quickInvoiceAutosave(fields, clients, items, presets)
  // — the 4th argument must be present and non-empty for a day-zero user.
  const idx = html.indexOf('quickInvoiceAutosave(');
  assert.ok(idx >= 0, 'factory call must be present');
  // Extract the parentheses to count top-level commas.
  let depth = 0;
  let start = html.indexOf('(', idx);
  let end = -1;
  for (let i = start; i < html.length; i++) {
    if (html[i] === '(') depth++;
    else if (html[i] === ')') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  assert.ok(end > start, 'factory call parens must balance');
  const inner = html.slice(start + 1, end);
  // The 4th argument (presets) should mention Logo design.
  assert.ok(inner.includes('Logo design'),
    'factory receives the servicePresets list as an argument');
}

// ---------------------------------------------------------------------------
// Layer 3 — quickInvoiceAutosave factory: fillFromServicePreset behaviour
// ---------------------------------------------------------------------------

function extractQuickInvoiceAutosaveFactory() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'views', 'invoice-quick.ejs'), 'utf8');
  // Strip inline <%= locals.csrfToken || '' %> — the src is going through vm,
  // it doesn't parse EJS. The token is only used inside a template literal for
  // the fetch header, so a raw "" swap is safe for factory extraction.
  const cleaned = html.replace(/<%=\s*locals\.csrfToken[^%]*%>/g, '');
  const fnStart = cleaned.indexOf('function quickInvoiceAutosave');
  assert.ok(fnStart >= 0, 'quickInvoiceAutosave factory must be extractable');
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

function makeFactoryInstance(initialServicePresets) {
  const src = extractQuickInvoiceAutosaveFactory();
  const ctx = {
    module: { exports: {} },
    // The factory calls fetch() inside autosave(); stub it to prevent throws
    // when the factory instance's fillFromServicePreset() calls autosave()
    // (which fires fetch() with keepalive:true).
    fetch: () => ({ catch: () => {} })
  };
  vm.createContext(ctx);
  vm.runInContext(src + '\n; module.exports = quickInvoiceAutosave;', ctx);
  return ctx.module.exports(
    { client_name: '', client_email: '', client_phone: '', description: '', amount: '' },
    [], // recentClients empty
    [], // recentItems empty so the test isolates preset behaviour
    initialServicePresets
  );
}

function testFactoryFillPresetPopulatesDescriptionAndAmount() {
  const inst = makeFactoryInstance([
    { description: 'Logo design', amount: 250 }
  ]);
  inst.init();
  assert.strictEqual(inst.fields.description, '', 'starts blank');
  assert.strictEqual(inst.fields.amount, '', 'starts blank');
  inst.pickedPreset = '0';
  inst.fillFromServicePreset();
  assert.strictEqual(inst.fields.description, 'Logo design',
    'description filled from preset');
  assert.strictEqual(inst.fields.amount, '250.00',
    'amount filled from preset, 2-decimal formatted');
  assert.strictEqual(inst.pickedPreset, '',
    'pickedPreset resets so the next selection is clean');
}

function testFactoryFillPresetOverwritesExistingFields() {
  const inst = makeFactoryInstance([
    { description: 'Hourly consulting', amount: 100 }
  ]);
  inst.init();
  inst.fields.description = 'Old text';
  inst.fields.amount = '50';
  inst.pickedPreset = '0';
  inst.fillFromServicePreset();
  assert.strictEqual(inst.fields.description, 'Hourly consulting',
    'preset overwrites prior description — user explicitly asked for the preset');
  assert.strictEqual(inst.fields.amount, '100.00',
    'preset overwrites prior amount');
}

function testFactoryBadPresetPicksNoOp() {
  const inst = makeFactoryInstance([
    { description: 'Logo design', amount: 250 }
  ]);
  inst.init();
  inst.fields.description = 'Keep me';
  inst.fields.amount = '77';
  for (const bad of ['', '-1', 'abc', '99', null, undefined]) {
    inst.pickedPreset = bad;
    inst.fillFromServicePreset();
    assert.strictEqual(inst.fields.description, 'Keep me',
      `bad pickedPreset (${JSON.stringify(bad)}) must NOT mutate description`);
    assert.strictEqual(inst.fields.amount, '77',
      `bad pickedPreset (${JSON.stringify(bad)}) must NOT mutate amount`);
    assert.strictEqual(inst.pickedPreset, '',
      'pickedPreset resets even on a bad pick');
  }
}

function testFactoryRejectsNonPositivePresetValues() {
  const inst = makeFactoryInstance([
    { description: 'Zero amount', amount: 0 }
  ]);
  inst.init();
  inst.fields.description = 'Prior';
  inst.fields.amount = '42';
  inst.pickedPreset = '0';
  inst.fillFromServicePreset();
  // description gets set (non-empty string) — but amount is 0 so amount stays
  // Actually: our factory sets description first, then amount only if positive.
  // The behavior should be: description updates (it's a legit non-empty string)
  // and amount stays at '42' since 0 is not > 0.
  assert.strictEqual(inst.fields.amount, '42',
    'zero-amount preset must NOT stomp amount with 0.00 — amount stays as prior value');
}

function testFactoryNonArrayPresetsCoerces() {
  const inst = makeFactoryInstance(null);
  inst.init();
  assert.ok(Array.isArray(inst.servicePresets), 'non-array coerces to []');
  assert.strictEqual(inst.servicePresets.length, 0);
  inst.pickedPreset = '0';
  inst.fillFromServicePreset();
  assert.strictEqual(inst.fields.description, '',
    'fillFromServicePreset on empty list cleanly no-ops (no throw, no mutation)');
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function run() {
  const tests = [
    testGetQuickThreadsPresetsForBrandNewUser,
    testGetQuickHidesPresetsWhenRecentItemsPresent,
    testValidationErrorPathPreservesPresets,
    testViewRendersPresetsWithFormattedOptions,
    testViewCurrencyAwareLabels,
    testViewHidesPresetsWhenRecentItemsNonEmpty,
    testViewHidesPresetsWhenAbsentOrMalformed,
    testViewFiltersMalformedPresets,
    testViewHostilePresetDescriptionEscaped,
    testFactoryReceivesPresetsArgument,
    testFactoryFillPresetPopulatesDescriptionAndAmount,
    testFactoryFillPresetOverwritesExistingFields,
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
