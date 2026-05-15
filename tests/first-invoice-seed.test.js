'use strict';

/*
 * First-invoice seed-on-signup tests (#39).
 *
 * Covers:
 *  - db.createSeedInvoice SQL shape: writes a draft row with is_seed=true,
 *    a single sensible line item, default INV-<year>-0001 number, and
 *    crucially does NOT bump users.invoice_count (the seed is a free 4th
 *    slot above the 3-invoice free-tier limit).
 *  - routes/auth.js POST /register calls db.createSeedInvoice with the new
 *    user's id, even when the seed insert throws (registration MUST NOT
 *    fail just because the welcome sample row didn't land).
 *  - buildOnboardingState excludes is_seed invoices from "create / send /
 *    paid" progress, so the onboarding checklist stays accurate.
 *  - views/dashboard.ejs renders the seed-invoice-hint banner + Example
 *    badge when the only invoice on screen is the seed, and omits both
 *    once the user creates a real invoice.
 *
 * Run: NODE_ENV=test node tests/first-invoice-seed.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');
const express = require('express');
const session = require('express-session');
const http = require('http');

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

// ---------- db.createSeedInvoice -- SQL-shape tests ---------------------

async function testCreateSeedInvoiceQueryShape() {
  const captured = [];
  // Mock pg's Pool so requiring ../db gives us a fake pool we can inspect.
  const pgPath = require.resolve('pg');
  const originalPg = require.cache[pgPath];
  require.cache[pgPath] = {
    id: pgPath,
    filename: pgPath,
    loaded: true,
    exports: {
      Pool: function () {
        return {
          query: async (text, params) => {
            captured.push({ text, params });
            return { rows: [{ id: 555, is_seed: true, invoice_number: params[1] }] };
          }
        };
      }
    }
  };
  delete require.cache[require.resolve('../db')];
  const { db } = require('../db');
  try {
    const row = await db.createSeedInvoice({ user_id: 42 });
    assert.strictEqual(captured.length, 1,
      'createSeedInvoice must issue exactly one query (no users.invoice_count UPDATE)');
    const q = captured[0];
    assert.ok(/INSERT INTO invoices/i.test(q.text), 'must be an INSERT into invoices');
    assert.ok(/is_seed/.test(q.text), 'INSERT must mention is_seed column');
    assert.ok(/\btrue\b/.test(q.text), 'INSERT must hard-code is_seed=true');
    // Param positions: user_id, invoice_number, client_name, client_email,
    // client_address, items (JSON), subtotal, tax_rate, tax_amount, total,
    // notes, due_date, issued_date.
    assert.strictEqual(q.params[0], 42, 'user_id must be the first param');
    assert.ok(/^INV-\d{4}-0001$/.test(q.params[1]),
      `invoice_number must default to INV-<year>-0001, got "${q.params[1]}"`);
    assert.ok(/sample|example|edit/i.test(q.params[2]),
      'client_name must read as a sample/edit-me prompt, not a real client');
    const items = JSON.parse(q.params[5]);
    assert.ok(Array.isArray(items) && items.length >= 1,
      'items JSON must contain at least one line item');
    assert.ok(items[0].description && items[0].quantity > 0 && items[0].unit_price > 0,
      'seed line item must carry a description, positive quantity, positive unit_price');
    assert.strictEqual(parseFloat(q.params[6]), parseFloat(q.params[9]),
      'subtotal must equal total when tax_rate=0');
    assert.strictEqual(parseFloat(q.params[7]), 0, 'tax_rate must default to 0');
    assert.ok(q.params[11] instanceof Date, 'due_date must be a Date');
    assert.ok(q.params[12] instanceof Date, 'issued_date must be a Date');
    const dueOffsetDays = (q.params[11].getTime() - q.params[12].getTime()) / 86400000;
    assert.ok(dueOffsetDays >= 29 && dueOffsetDays <= 31,
      `due_date should be ~30 days after issued_date, got ${dueOffsetDays}`);
    assert.strictEqual(row.id, 555);
    assert.strictEqual(row.is_seed, true);
  } finally {
    // Restore pg module cache so later tests using the real client work.
    if (originalPg) require.cache[pgPath] = originalPg;
    else delete require.cache[pgPath];
    delete require.cache[require.resolve('../db')];
  }
}

async function testCreateSeedInvoiceDoesNotBumpInvoiceCount() {
  const captured = [];
  const pgPath = require.resolve('pg');
  const originalPg = require.cache[pgPath];
  require.cache[pgPath] = {
    id: pgPath,
    filename: pgPath,
    loaded: true,
    exports: {
      Pool: function () {
        return {
          query: async (text, params) => {
            captured.push(text);
            return { rows: [{ id: 1 }] };
          }
        };
      }
    }
  };
  delete require.cache[require.resolve('../db')];
  const { db } = require('../db');
  try {
    await db.createSeedInvoice({ user_id: 1 });
    const bumped = captured.some((q) => /UPDATE\s+users\s+SET\s+invoice_count/i.test(q));
    assert.strictEqual(bumped, false,
      'seed insert must NOT issue UPDATE users SET invoice_count — the sample row is a free slot');
  } finally {
    if (originalPg) require.cache[pgPath] = originalPg;
    else delete require.cache[pgPath];
    delete require.cache[require.resolve('../db')];
  }
}

// ---------- routes/auth POST /register integration ----------------------

function buildAuthAppWithStub(seedFn) {
  // bcrypt stub
  require.cache[require.resolve('bcrypt')] = {
    id: require.resolve('bcrypt'),
    filename: require.resolve('bcrypt'),
    loaded: true,
    exports: {
      hash: async (pw) => `hashed:${pw}`,
      compare: async (pw, hash) => hash === `hashed:${pw}`
    }
  };
  let nextId = 200;
  const usersByEmail = new Map();
  const usersById = new Map();
  const dbStub = {
    pool: { query: async () => ({ rows: [] }) },
    db: {
      async getUserByEmail(email) { return usersByEmail.get(email) || null; },
      async getUserById(id) { return usersById.get(id) || null; },
      async createUser({ email, password_hash, name }) {
        const u = { id: nextId++, email, password_hash, name, plan: 'free', invoice_count: 0 };
        usersByEmail.set(email, u);
        usersById.set(u.id, u);
        return u;
      },
      createSeedInvoice: seedFn,
      async updateUser() { return null; }
    }
  };
  require.cache[require.resolve('../db')] = {
    id: require.resolve('../db'),
    filename: require.resolve('../db'),
    loaded: true,
    exports: dbStub
  };
  delete require.cache[require.resolve('../routes/auth')];
  const authRoutes = require('../routes/auth');

  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, res, next) => { res.locals.user = req.session.user || null; next(); });
  app.use('/auth', authRoutes);
  return { app, dbStub };
}

function postRegister(app, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const payload = new URLSearchParams(body).toString();
      const req = http.request({
        hostname: '127.0.0.1', port, path: '/auth/register', method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => server.close(() => resolve({ status: res.statusCode, headers: res.headers, body: data })));
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.write(payload);
      req.end();
    });
  });
}

async function testRegisterCallsCreateSeedInvoice() {
  const calls = [];
  const seedFn = async (arg) => { calls.push(arg); return { id: 1, is_seed: true }; };
  const { app } = buildAuthAppWithStub(seedFn);
  const res = await postRegister(app, { name: 'Alice', email: 'seed1@x.com', password: 'password123' });
  assert.strictEqual(res.status, 302, 'register must redirect on success');
  assert.strictEqual(calls.length, 1, 'createSeedInvoice must be called exactly once');
  assert.ok(calls[0] && typeof calls[0].user_id === 'number',
    `createSeedInvoice must receive { user_id: <new user id> }, got ${JSON.stringify(calls[0])}`);
}

async function testRegisterSurvivesSeedFailure() {
  let seedCalls = 0;
  const seedFn = async () => { seedCalls++; throw new Error('db down'); };
  const { app } = buildAuthAppWithStub(seedFn);
  const res = await postRegister(app, { name: 'Bob', email: 'seed2@x.com', password: 'password123' });
  assert.strictEqual(res.status, 302, 'register MUST still redirect even when seed throws');
  assert.ok(res.headers.location.includes('/dashboard'), 'redirect target is /dashboard');
  assert.strictEqual(seedCalls, 1, 'seed was attempted exactly once');
}

async function testRegisterToleratesMissingSeedMethod() {
  // Older db modules (or partial deploys) may not yet expose createSeedInvoice.
  // The route guards on typeof so registration must still succeed.
  const { app } = buildAuthAppWithStub(undefined);
  const res = await postRegister(app, { name: 'Cara', email: 'seed3@x.com', password: 'password123' });
  assert.strictEqual(res.status, 302, 'register MUST redirect even when seed method is undefined');
}

// ---------- buildOnboardingState seed-exclusion -------------------------

function loadOnboardingHelpers() {
  // Stub db so requiring routes/invoices doesn't open a pool.
  require.cache[require.resolve('../db')] = {
    id: require.resolve('../db'),
    filename: require.resolve('../db'),
    loaded: true,
    exports: { pool: { query: async () => ({ rows: [] }) }, db: {} }
  };
  delete require.cache[require.resolve('../routes/invoices')];
  return require('../routes/invoices');
}

function testOnboardingIgnoresSeedInvoiceForCreatedStep() {
  const { buildOnboardingState } = loadOnboardingHelpers();
  const user = { id: 1, onboarding_dismissed: false, business_name: null };
  const state = buildOnboardingState(user, [
    { id: 99, status: 'draft', is_seed: true }
  ]);
  assert.ok(state, 'onboarding state must render');
  const create = state.steps.find((s) => s.key === 'create');
  assert.strictEqual(create.done, false,
    'a seed-only invoice list must NOT mark "create your first invoice" as done');
}

function testOnboardingCountsRealInvoiceEvenAlongsideSeed() {
  const { buildOnboardingState } = loadOnboardingHelpers();
  const user = { id: 1, onboarding_dismissed: false, business_name: null };
  const state = buildOnboardingState(user, [
    { id: 99, status: 'draft', is_seed: true },
    { id: 100, status: 'sent', is_seed: false }
  ]);
  const create = state.steps.find((s) => s.key === 'create');
  const send = state.steps.find((s) => s.key === 'send');
  assert.strictEqual(create.done, true, 'a real draft alongside a seed must mark create=true');
  assert.strictEqual(send.done, true, 'a sent real invoice must mark send=true');
}

function testOnboardingIgnoresSeedSentStatus() {
  // Defence-in-depth: if a seed somehow gets its status flipped to 'sent'
  // (e.g. a future code path), the onboarding checklist still requires a
  // non-seed sent invoice before the "send an invoice" step closes.
  const { buildOnboardingState } = loadOnboardingHelpers();
  const user = { id: 1, onboarding_dismissed: false, business_name: null };
  const state = buildOnboardingState(user, [
    { id: 99, status: 'sent', is_seed: true }
  ]);
  const send = state.steps.find((s) => s.key === 'send');
  assert.strictEqual(send.done, false,
    'a seed marked sent must NOT close the "send an invoice" onboarding step');
}

// ---------- dashboard.ejs rendering -------------------------------------

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
    ...locals
  }, {
    views: [path.join(__dirname, '..', 'views')],
    filename: dashboardTplPath
  });
}

function makeSeedInvoice(over) {
  return {
    id: 1,
    invoice_number: 'INV-2026-0001',
    client_name: 'Sample Client (edit this)',
    total: '300.00',
    issued_date: new Date(),
    status: 'draft',
    is_seed: true,
    ...over
  };
}

function makeRealInvoice(over) {
  return {
    id: 2,
    invoice_number: 'INV-2026-0002',
    client_name: 'Real Client LLC',
    total: '500.00',
    issued_date: new Date(),
    status: 'sent',
    is_seed: false,
    ...over
  };
}

function testDashboardRendersSeedHintWhenOnlySeedExists() {
  const html = renderDashboard({ invoices: [makeSeedInvoice()] });
  assert.ok(html.includes('data-testid="seed-invoice-hint"'),
    'seed-invoice-hint banner must render when invoices list is a single seed');
  assert.ok(/sample invoice/i.test(html), 'hint copy must mention "sample invoice"');
  assert.ok(html.includes('data-testid="seed-invoice-badge"'),
    'Example badge must render in the seed invoice row');
  assert.ok(html.includes('data-is-seed="true"'),
    'seed row must carry data-is-seed="true" for client-side hooks');
}

function testDashboardOmitsSeedHintWhenRealInvoiceExists() {
  const html = renderDashboard({ invoices: [makeSeedInvoice(), makeRealInvoice()] });
  assert.ok(!html.includes('data-testid="seed-invoice-hint"'),
    'seed-invoice-hint must NOT render once the user has any non-seed invoice');
  // Badge should still render for the seed row.
  assert.ok(html.includes('data-testid="seed-invoice-badge"'),
    'Example badge stays on the seed row even when a real invoice is present');
  assert.ok(html.includes('data-is-seed="false"'),
    'real invoice row carries data-is-seed="false"');
}

function testDashboardOmitsSeedHintWhenInvoicesEmpty() {
  const html = renderDashboard({ invoices: [] });
  assert.ok(!html.includes('data-testid="seed-invoice-hint"'),
    'empty-state path must NOT render the seed-invoice-hint');
  assert.ok(/Send your first invoice today/.test(html),
    'empty-state copy must still render for zero-invoice users');
}

function testDashboardSeedRowDoesNotShowExampleBadgeForRealRow() {
  const html = renderDashboard({ invoices: [makeRealInvoice()] });
  assert.ok(!html.includes('data-testid="seed-invoice-badge"'),
    'Example badge must NOT render on a real-only invoice list');
}

// ---------- Runner ------------------------------------------------------

async function run() {
  const tests = [
    ['db.createSeedInvoice: SQL shape carries is_seed=true + sane line item', testCreateSeedInvoiceQueryShape],
    ['db.createSeedInvoice: does not bump users.invoice_count', testCreateSeedInvoiceDoesNotBumpInvoiceCount],
    ['POST /auth/register: calls createSeedInvoice with new user_id', testRegisterCallsCreateSeedInvoice],
    ['POST /auth/register: succeeds when createSeedInvoice throws', testRegisterSurvivesSeedFailure],
    ['POST /auth/register: succeeds when createSeedInvoice is missing', testRegisterToleratesMissingSeedMethod],
    ['buildOnboardingState: seed-only list keeps "create" step open', testOnboardingIgnoresSeedInvoiceForCreatedStep],
    ['buildOnboardingState: real invoice alongside seed closes create+send', testOnboardingCountsRealInvoiceEvenAlongsideSeed],
    ['buildOnboardingState: seed marked sent does NOT close send step', testOnboardingIgnoresSeedSentStatus],
    ['dashboard: renders seed-invoice-hint when only seed exists', testDashboardRendersSeedHintWhenOnlySeedExists],
    ['dashboard: omits seed-invoice-hint when a real invoice exists', testDashboardOmitsSeedHintWhenRealInvoiceExists],
    ['dashboard: omits seed-invoice-hint on empty invoice list', testDashboardOmitsSeedHintWhenInvoicesEmpty],
    ['dashboard: no Example badge when no seed invoices present', testDashboardSeedRowDoesNotShowExampleBadgeForRealRow]
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

run().catch((err) => { console.error(err); process.exit(1); });
