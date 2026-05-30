'use strict';

/*
 * "Continue your draft invoice" autosave + recovery tests (Milestone 2).
 *
 * The /invoices/quick form autosaves any in-progress fields server-side on
 * every debounced keystroke so a user who starts typing then bounces can
 * pick up where they left off — via both the form pre-fill on next GET
 * /invoices/quick AND a dashboard "Continue your draft invoice" banner.
 *
 * Coverage:
 *
 *  - Layer 1: route POST /invoices/quick/autosave
 *      * Valid payload calls db.setPendingQuickInvoice with the
 *        4-field normalized shape; returns { ok:true, stored:true }.
 *      * All-empty payload calls db.clearPendingQuickInvoice (no set)
 *        and returns { ok:true, stored:false } — prevents the banner
 *        from firing on a phantom draft after the user backspaces.
 *      * Unknown fields are stripped; oversize fields are clamped.
 *      * Non-string field types (numbers, nulls) coerce to empty string
 *        or stringified scalar — no crash.
 *
 *  - Layer 2: route GET /invoices/quick pre-fills from pending row
 *      * User with non-empty user.pending_quick_invoice → form inputs
 *        carry the saved values AND the restored banner renders.
 *      * User with null pending → no restored banner, blank form.
 *      * Pending row that is all-empty strings → treated as no pending
 *        (defence against a stale write).
 *
 *  - Layer 3: route POST /invoices/quick clears pending on successful create
 *      * Happy path → clearPendingQuickInvoice is called for the user.
 *      * Clear failure does NOT block the redirect (best-effort try/catch).
 *
 *  - Layer 4: dashboard banner
 *      * pendingQuickInvoice prop set → banner with client name + the
 *        Continue CTA pointing at /invoices/quick.
 *      * pendingQuickInvoice null → no banner.
 *      * buildPendingQuickInvoiceBanner helper: pure-gate tests across
 *        null user, null column, all-empty payload, stringified JSONB,
 *        unknown/nonstring fields.
 *
 * Run: NODE_ENV=test node tests/quick-invoice-autosave.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');
const express = require('express');
const http = require('http');

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

// ============================================================================
// Test-store + db stub
// ============================================================================

const users = new Map();
const setPendingCalls = [];
const clearPendingCalls = [];
const createCalls = [];
let nextInvoiceId = 100;
let clearPendingImpl = async () => {};

function resetStore() {
  users.clear();
  setPendingCalls.length = 0;
  clearPendingCalls.length = 0;
  createCalls.length = 0;
  nextInvoiceId = 100;
  clearPendingImpl = async () => {};
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
      async createInvoice(data) {
        createCalls.push(data);
        const id = nextInvoiceId++;
        const u = users.get(data.user_id);
        if (u) u.invoice_count = (u.invoice_count || 0) + 1;
        return Object.assign({ id }, data, { status: 'draft', is_seed: false });
      },
      async markInvoiceSentFromShareIntent(invoiceId, userId) {
        return { id: invoiceId, status: 'sent' };
      },
      async setPendingQuickInvoice(userId, payload) {
        setPendingCalls.push({ userId, payload });
        const u = users.get(userId);
        if (u) u.pending_quick_invoice = payload;
      },
      async clearPendingQuickInvoice(userId) {
        clearPendingCalls.push({ userId });
        const u = users.get(userId);
        if (u) u.pending_quick_invoice = null;
        return clearPendingImpl(userId);
      },
      async getOrCreatePublicToken() { return null; },
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
  delete require.cache[require.resolve('../lib/email')];
  const realEmail = require('../lib/email');
  require.cache[require.resolve('../lib/email')] = {
    id: require.resolve('../lib/email'),
    filename: require.resolve('../lib/email'),
    loaded: true,
    exports: Object.assign({}, realEmail, {
      sendInvoiceEmail: async () => ({ ok: true, id: 'em_test' })
    })
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

function request(app, method, url, body, { json = false } = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      let payload = '';
      let contentType = '';
      if (body) {
        if (json) {
          payload = JSON.stringify(body);
          contentType = 'application/json';
        } else {
          payload = new URLSearchParams(body).toString();
          contentType = 'application/x-www-form-urlencoded';
        }
      }
      const req = http.request({
        hostname: '127.0.0.1', port, path: url, method,
        headers: payload
          ? { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(payload) }
          : {}
      }, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => server.close(() => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: data
        })));
      });
      req.on('error', err => { server.close(); reject(err); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

// ============================================================================
// Layer 1 — POST /invoices/quick/autosave
// ============================================================================

async function testAutosaveStoresValidPayload() {
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 0 }, routes);

  const res = await request(app, 'POST', '/invoices/quick/autosave', {
    client_name: 'Acme Corp',
    client_email: 'pay@acme.com',
    description: 'Brand identity',
    amount: '1200'
  }, { json: true });

  assert.strictEqual(res.status, 200, 'autosave with valid payload returns 200');
  const parsed = JSON.parse(res.body);
  assert.strictEqual(parsed.ok, true, 'response carries ok:true');
  assert.strictEqual(parsed.stored, true, 'stored:true when payload has content');
  assert.strictEqual(setPendingCalls.length, 1, 'setPendingQuickInvoice called once');
  assert.strictEqual(clearPendingCalls.length, 0, 'clearPendingQuickInvoice NOT called when content present');
  assert.strictEqual(setPendingCalls[0].userId, 1, 'userId propagated from session');
  assert.deepStrictEqual(setPendingCalls[0].payload, {
    client_name: 'Acme Corp',
    client_email: 'pay@acme.com',
    client_phone: '',
    description: 'Brand identity',
    amount: '1200'
  }, 'payload normalized to the 5-field shape (incl. client_phone), strings preserved');
}

async function testAutosaveAllEmptyClears() {
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 0 });
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 0 }, routes);

  const res = await request(app, 'POST', '/invoices/quick/autosave', {
    client_name: '',
    client_email: '   ',
    description: '',
    amount: ''
  }, { json: true });

  assert.strictEqual(res.status, 200, 'all-empty autosave returns 200 (no error)');
  const parsed = JSON.parse(res.body);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.stored, false, 'stored:false on all-empty');
  assert.strictEqual(setPendingCalls.length, 0, 'setPendingQuickInvoice NOT called on all-empty');
  assert.strictEqual(clearPendingCalls.length, 1, 'clearPendingQuickInvoice called once on all-empty');
  assert.strictEqual(clearPendingCalls[0].userId, 1, 'clear propagated to the session user');
}

async function testAutosaveStripsUnknownFields() {
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 0 });
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 0 }, routes);

  await request(app, 'POST', '/invoices/quick/autosave', {
    client_name: 'A',
    client_email: 'b@c',
    description: 'd',
    amount: '10',
    plan: 'agency',
    user_id: 999,
    pending_quick_invoice: { malicious: true }
  }, { json: true });

  assert.strictEqual(setPendingCalls.length, 1, 'autosave fires for valid payload');
  // Defence-in-depth: only the five known keys survive normalization.
  assert.deepStrictEqual(Object.keys(setPendingCalls[0].payload).sort(),
    ['amount', 'client_email', 'client_name', 'client_phone', 'description'],
    'unknown fields stripped — payload exposes only the five expected keys (incl. client_phone)');
}

async function testAutosaveClampsOversizeFields() {
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 0 });
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 0 }, routes);

  const longString = 'A'.repeat(2000);
  await request(app, 'POST', '/invoices/quick/autosave', {
    client_name: longString,
    client_email: longString,
    description: longString,
    amount: longString
  }, { json: true });

  assert.strictEqual(setPendingCalls.length, 1);
  const p = setPendingCalls[0].payload;
  assert.ok(p.client_name.length <= 500, `client_name clamped (got len ${p.client_name.length})`);
  assert.ok(p.client_email.length <= 500, `client_email clamped (got len ${p.client_email.length})`);
  assert.ok(p.description.length <= 500, `description clamped (got len ${p.description.length})`);
  assert.ok(p.amount.length <= 32, `amount clamped (got len ${p.amount.length})`);
}

async function testAutosaveCoercesNonStringTypes() {
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 0 });
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 0 }, routes);

  // JSON allows numbers, nulls, booleans, arrays — all must safely coerce.
  await request(app, 'POST', '/invoices/quick/autosave', {
    client_name: 'OK',
    client_email: null,
    description: ['arr'],
    amount: 500
  }, { json: true });

  assert.strictEqual(setPendingCalls.length, 1, 'crash-free under heterogeneous types');
  const p = setPendingCalls[0].payload;
  assert.strictEqual(p.client_name, 'OK');
  assert.strictEqual(p.client_email, '', 'null coerces to empty string');
  assert.strictEqual(p.description, '', 'array coerces to empty string');
  assert.strictEqual(p.amount, '500', 'numeric amount coerces to its string form');
}

// ============================================================================
// Layer 2 — GET /invoices/quick pre-fills from pending row
// ============================================================================

async function testGetQuickPrefillsFromPending() {
  resetStore();
  users.set(1, {
    id: 1, plan: 'free', invoice_count: 0,
    pending_quick_invoice: {
      client_name: 'Globex',
      client_email: 'ap@globex.com',
      description: 'Q3 retainer',
      amount: '2400'
    }
  });
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 0 }, routes);

  const res = await request(app, 'GET', '/invoices/quick');
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.includes('data-testid="invoice-quick-restored"'),
    'restored banner must render when pending row exists');
  assert.ok(res.body.includes('value="Globex"'),
    'client_name input must be pre-filled');
  assert.ok(res.body.includes('value="ap@globex.com"'),
    'client_email input must be pre-filled');
  assert.ok(res.body.includes('value="Q3 retainer"'),
    'description input must be pre-filled');
  assert.ok(res.body.includes('value="2400"'),
    'amount input must be pre-filled');
}

async function testGetQuickNoBannerWhenNoPending() {
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 0, pending_quick_invoice: null });
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 0 }, routes);

  const res = await request(app, 'GET', '/invoices/quick');
  assert.strictEqual(res.status, 200);
  assert.ok(!res.body.includes('data-testid="invoice-quick-restored"'),
    'restored banner must NOT render when pending row is null');
}

async function testGetQuickIgnoresAllEmptyPending() {
  resetStore();
  users.set(1, {
    id: 1, plan: 'free', invoice_count: 0,
    pending_quick_invoice: { client_name: '', client_email: '', description: '', amount: '' }
  });
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 0 }, routes);

  const res = await request(app, 'GET', '/invoices/quick');
  assert.strictEqual(res.status, 200);
  assert.ok(!res.body.includes('data-testid="invoice-quick-restored"'),
    'all-empty pending row must NOT trigger the restored banner');
}

// ============================================================================
// Layer 3 — POST /invoices/quick clears pending on successful create
// ============================================================================

async function testPostQuickClearsPendingOnSuccess() {
  resetStore();
  users.set(1, {
    id: 1, plan: 'free', invoice_count: 0,
    pending_quick_invoice: { client_name: 'X', client_email: '', description: 'Y', amount: '50' }
  });
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 0 }, routes);

  const res = await request(app, 'POST', '/invoices/quick', {
    client_name: 'X',
    description: 'Y',
    amount: '50'
  });

  assert.strictEqual(res.status, 302, 'happy-path create must redirect');
  assert.strictEqual(createCalls.length, 1, 'createInvoice fired once');
  assert.strictEqual(clearPendingCalls.length, 1,
    'clearPendingQuickInvoice fired exactly once after successful create');
  assert.strictEqual(clearPendingCalls[0].userId, 1);
}

async function testPostQuickClearPendingFailureDoesNotBlockRedirect() {
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 0 });
  clearPendingImpl = async () => { throw new Error('boom'); };
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 0 }, routes);

  const res = await request(app, 'POST', '/invoices/quick', {
    client_name: 'X',
    description: 'Y',
    amount: '50'
  });

  assert.strictEqual(res.status, 302,
    'clear-pending failure must NOT block the post-create redirect (best-effort)');
  assert.strictEqual(createCalls.length, 1, 'create still fired');
}

// ============================================================================
// Layer 4 — Dashboard banner
// ============================================================================

const dashboardTplPath = path.join(__dirname, '..', 'views', 'dashboard.ejs');
const dashboardTpl = fs.readFileSync(dashboardTplPath, 'utf8');

function renderDashboard(locals) {
  return ejs.render(dashboardTpl, {
    title: 'Dashboard',
    flash: null,
    days_left_in_trial: 0,
    csrfToken: 'TEST_CSRF',
    invoices: [],
    user: { plan: 'free', invoice_count: 0, subscription_status: null },
    onboarding: null,
    invoiceLimitProgress: null,
    recentRevenue: null,
    annualUpgradePrompt: null,
    socialProof: null,
    celebration: null,
    staleDraftPrompt: null,
    firstRealInvoicePrompt: null,
    pendingQuickInvoice: null,
    ...locals
  }, {
    views: [path.join(__dirname, '..', 'views')],
    filename: dashboardTplPath
  });
}

function testDashboardRendersPendingBanner() {
  const html = renderDashboard({
    pendingQuickInvoice: {
      clientName: 'Globex',
      description: 'Q3 retainer',
      amount: '2400'
    }
  });
  assert.ok(html.includes('data-testid="pending-quick-invoice-banner"'),
    'pending banner must render when pendingQuickInvoice is set');
  assert.ok(html.includes('data-testid="pending-quick-invoice-client"'),
    'banner must include the client name span');
  assert.ok(/data-testid="pending-quick-invoice-client">Globex</.test(html),
    'banner must show the client name');
  assert.ok(/data-testid="pending-quick-invoice-description">Q3 retainer</.test(html),
    'banner must show the description');
  assert.ok(/data-testid="pending-quick-invoice-amount">2400</.test(html),
    'banner must show the amount');
  assert.ok(/<a\s[^>]*href="\/invoices\/quick"[^>]*data-testid="pending-quick-invoice-cta"/.test(html),
    'banner CTA must link to /invoices/quick with the testid hook');
}

function testDashboardHidesPendingBannerWhenNull() {
  const html = renderDashboard({ pendingQuickInvoice: null });
  assert.ok(!html.includes('data-testid="pending-quick-invoice-banner"'),
    'banner must be absent when pendingQuickInvoice is null');
}

function testDashboardPendingBannerWithoutClientName() {
  // A user who typed only an amount before bouncing still gets the
  // banner — the "Continue invoice →" CTA is the value, even without
  // a client name to address it to.
  const html = renderDashboard({
    pendingQuickInvoice: {
      clientName: '',
      description: '',
      amount: '500'
    }
  });
  assert.ok(html.includes('data-testid="pending-quick-invoice-banner"'),
    'banner must render even when only amount is populated');
  assert.ok(/data-testid="pending-quick-invoice-amount">500</.test(html),
    'amount must surface in the secondary line');
  assert.ok(!html.includes('data-testid="pending-quick-invoice-client"'),
    'client name span must be omitted when clientName is empty');
}

// ---------- buildPendingQuickInvoiceBanner — pure-gate tests --------------

function loadRouteHelpers() {
  require.cache[require.resolve('../db')] = {
    id: require.resolve('../db'),
    filename: require.resolve('../db'),
    loaded: true,
    exports: { pool: { query: async () => ({ rows: [] }) }, db: {} }
  };
  delete require.cache[require.resolve('../routes/invoices')];
  return require('../routes/invoices');
}

function testBannerHelperNullUser() {
  const { buildPendingQuickInvoiceBanner } = loadRouteHelpers();
  assert.strictEqual(buildPendingQuickInvoiceBanner(null), null,
    'null user must return null');
  assert.strictEqual(buildPendingQuickInvoiceBanner(undefined), null,
    'undefined user must return null');
}

function testBannerHelperNullColumn() {
  const { buildPendingQuickInvoiceBanner } = loadRouteHelpers();
  assert.strictEqual(
    buildPendingQuickInvoiceBanner({ id: 1, pending_quick_invoice: null }),
    null,
    'null column must return null');
  assert.strictEqual(
    buildPendingQuickInvoiceBanner({ id: 1 }),
    null,
    'missing column must return null');
}

function testBannerHelperAllEmptyPayload() {
  const { buildPendingQuickInvoiceBanner } = loadRouteHelpers();
  assert.strictEqual(
    buildPendingQuickInvoiceBanner({
      id: 1,
      pending_quick_invoice: { client_name: '', client_email: '  ', description: '', amount: '' }
    }),
    null,
    'all-empty payload must collapse to null (no phantom banner)');
}

function testBannerHelperAcceptsStringifiedJsonb() {
  // Older pg drivers / test stubs may hand back JSONB as a string. The
  // helper must tolerate both shapes without falling over.
  const { buildPendingQuickInvoiceBanner } = loadRouteHelpers();
  const result = buildPendingQuickInvoiceBanner({
    id: 1,
    pending_quick_invoice: JSON.stringify({ client_name: 'S', description: 'd', amount: '1', client_email: '' })
  });
  assert.ok(result, 'stringified JSONB must parse');
  assert.strictEqual(result.clientName, 'S');
  assert.strictEqual(result.description, 'd');
  assert.strictEqual(result.amount, '1');
}

function testBannerHelperIgnoresNonStringFields() {
  const { buildPendingQuickInvoiceBanner } = loadRouteHelpers();
  const result = buildPendingQuickInvoiceBanner({
    id: 1,
    pending_quick_invoice: {
      client_name: 'OK',
      client_email: null,
      description: 42,
      amount: ['nope']
    }
  });
  assert.ok(result, 'one valid string field is enough to surface the banner');
  assert.strictEqual(result.clientName, 'OK',
    'string field passes through');
  assert.strictEqual(result.description, '',
    'non-string description coerces to empty');
  assert.strictEqual(result.amount, '',
    'non-string amount coerces to empty');
}

function testBannerHelperReturnsTrimmedFields() {
  const { buildPendingQuickInvoiceBanner } = loadRouteHelpers();
  const result = buildPendingQuickInvoiceBanner({
    id: 1,
    pending_quick_invoice: {
      client_name: '  Acme  ',
      client_email: '',
      description: '  brand work  ',
      amount: '  100  '
    }
  });
  assert.strictEqual(result.clientName, 'Acme', 'clientName trimmed for clean banner copy');
  assert.strictEqual(result.description, 'brand work', 'description trimmed');
  assert.strictEqual(result.amount, '100', 'amount trimmed');
}

// ============================================================================
// Runner
// ============================================================================

async function run() {
  const tests = [
    // Layer 1 — autosave route
    ['autosave: valid payload → setPendingQuickInvoice', testAutosaveStoresValidPayload],
    ['autosave: all-empty payload → clearPendingQuickInvoice', testAutosaveAllEmptyClears],
    ['autosave: unknown fields are stripped', testAutosaveStripsUnknownFields],
    ['autosave: oversize fields are clamped', testAutosaveClampsOversizeFields],
    ['autosave: non-string field types safely coerce', testAutosaveCoercesNonStringTypes],
    // Layer 2 — GET /quick pre-fill
    ['GET /quick pre-fills from pending row + shows restored banner', testGetQuickPrefillsFromPending],
    ['GET /quick — no banner when pending is null', testGetQuickNoBannerWhenNoPending],
    ['GET /quick — all-empty pending row treated as no pending', testGetQuickIgnoresAllEmptyPending],
    // Layer 3 — POST /quick clears pending
    ['POST /quick clears pending on successful create', testPostQuickClearsPendingOnSuccess],
    ['POST /quick — clear-pending failure does NOT block redirect', testPostQuickClearPendingFailureDoesNotBlockRedirect],
    // Layer 4 — dashboard view
    ['dashboard renders pending banner with all fields', testDashboardRendersPendingBanner],
    ['dashboard hides banner when pendingQuickInvoice is null', testDashboardHidesPendingBannerWhenNull],
    ['dashboard renders banner even when only amount is populated', testDashboardPendingBannerWithoutClientName],
    // Helper gate
    ['helper: null user → null', testBannerHelperNullUser],
    ['helper: null column → null', testBannerHelperNullColumn],
    ['helper: all-empty payload → null', testBannerHelperAllEmptyPayload],
    ['helper: accepts stringified JSONB', testBannerHelperAcceptsStringifiedJsonb],
    ['helper: ignores non-string fields', testBannerHelperIgnoresNonStringFields],
    ['helper: returns trimmed fields', testBannerHelperReturnsTrimmedFields]
  ];

  let passed = 0;
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ ${name}`);
      console.error(`    ${err && err.message}`);
      if (err && err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch(err => { console.error(err); process.exit(1); });
