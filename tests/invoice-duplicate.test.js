'use strict';

/*
 * One-click invoice-duplicate tests.
 *
 * The duplicate feature lets a freelancer clone the seed sample (Milestone 2)
 * or any past invoice (Milestone 3/4 repeat-client speed-up) as a fresh draft
 * with all the items / notes / tax / client info already filled in. Cuts the
 * blank-form friction that drops a meaningful chunk of activation cohort at
 * "create your first real invoice".
 *
 * Coverage (3 layers):
 *
 *  - db.duplicateInvoice
 *      * SQL contract: INSERT…SELECT shape, hardcoded status='draft' +
 *        is_seed=false in the SELECT projection (so a duplicate of a seed
 *        becomes a real invoice), owner gate (WHERE user_id = $2), parameter
 *        positions, transactional wrapping (BEGIN…COMMIT on hit, ROLLBACK on
 *        miss), invoice_count bump in the same transaction.
 *      * Owner gate at the JS level: a cross-tenant id returns null and the
 *        outer caller never sees a row.
 *      * Falsy-arg short-circuit.
 *
 *  - POST /invoices/:id/duplicate
 *      * Happy path: pro user posts, db.duplicateInvoice is called with the
 *        correct args (next invoice_number, today's issued_date, +30d due_date),
 *        302 to /invoices/<newId>/edit, session.user.invoice_count bumped.
 *      * Cross-tenant: wrong user → /dashboard, no duplicate call.
 *      * Free-tier at limit: invoice_count=3 free user → /invoices?limit_hit=1
 *        and no duplicate.
 *      * Free-tier below limit: invoice_count=2 free user → succeeds (and
 *        seed source still works — duplicating a seed when the user has no
 *        real invoices is the headline Milestone 2 surface).
 *      * Source not found: /dashboard, no duplicate call.
 *      * Cross-tenant safety relies on db.getInvoiceById returning null when
 *        userId doesn't match.
 *
 *  - views/invoice-view.ejs
 *      * Duplicate button surfaces in the action bar on all owner-side
 *        invoice statuses (draft/sent/paid/overdue) for all plans.
 *      * Form action is POST /invoices/<id>/duplicate.
 *      * CSRF hidden input present.
 *      * data-testid hooks present.
 *      * Seed source surfaces the "as draft" copy tweak so the user knows
 *        the clone is a real invoice (not another seed).
 *
 * Run: NODE_ENV=test node tests/invoice-duplicate.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');
const express = require('express');
const http = require('http');

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

// ============================================================================
// Layer 1 — db.duplicateInvoice SQL contract (pg.Pool mocked)
// ============================================================================

async function testDuplicateInvoiceSqlContractHappy() {
  const captured = [];
  const pgPath = require.resolve('pg');
  const originalPg = require.cache[pgPath];
  let released = 0;
  require.cache[pgPath] = {
    id: pgPath, filename: pgPath, loaded: true,
    exports: {
      Pool: function () {
        return {
          query: async () => ({ rows: [] }),
          connect: async () => ({
            query: async (text, params) => {
              captured.push({ text, params });
              if (/^BEGIN|^COMMIT|^ROLLBACK/i.test(text.trim())) return { rows: [] };
              if (/INSERT INTO invoices/i.test(text)) {
                return { rows: [{ id: 9001, invoice_number: params[2], is_seed: false, status: 'draft', user_id: params[1] }] };
              }
              if (/UPDATE users/i.test(text)) return { rows: [] };
              return { rows: [] };
            },
            release: () => { released++; }
          })
        };
      }
    }
  };
  delete require.cache[require.resolve('../db')];
  const { db } = require('../db');
  try {
    const row = await db.duplicateInvoice(123, 42, {
      invoice_number: 'INV-2026-0007',
      issued_date: '2026-05-19',
      due_date: '2026-06-18'
    });
    assert.ok(row, 'duplicateInvoice must return the new row when the source matched');
    assert.strictEqual(row.id, 9001, 'duplicateInvoice must return the inserted row');

    const stmts = captured.map(c => c.text.trim().split('\n')[0]);
    assert.ok(stmts.some(s => /^BEGIN$/i.test(s)), 'must open a transaction with BEGIN');
    assert.ok(stmts.some(s => /^COMMIT$/i.test(s)), 'happy path must end with COMMIT');
    assert.ok(!stmts.some(s => /^ROLLBACK$/i.test(s)), 'happy path must NOT issue ROLLBACK');

    const insert = captured.find(c => /INSERT INTO invoices/i.test(c.text));
    assert.ok(insert, 'must issue an INSERT INTO invoices statement');
    assert.ok(/INSERT INTO invoices/i.test(insert.text), 'must INSERT into invoices');
    assert.ok(/SELECT/i.test(insert.text), 'must use INSERT…SELECT to copy in a single round-trip');
    assert.ok(/FROM invoices/i.test(insert.text), 'must SELECT FROM invoices');
    assert.ok(/WHERE id = \$1 AND user_id = \$2/i.test(insert.text),
      'owner gate must be WHERE id=$1 AND user_id=$2 (cross-tenant returns null without write)');
    assert.ok(/'draft'/i.test(insert.text),
      'INSERT must hardcode status=\'draft\' so duplicate of a paid/overdue invoice starts as a fresh draft');
    assert.ok(/\bfalse\b/i.test(insert.text),
      'INSERT must hardcode is_seed=false so duplicating the seed makes a real invoice');
    assert.ok(/RETURNING \*/i.test(insert.text),
      'INSERT must RETURNING * so the caller has the new row id without a second SELECT');
    // public_token, view_count, payment_link_url, payment_claimed_at, sent_via_*
    // are NOT named in the column list — they fall back to schema defaults (NULL
    // / 0), which is the correct clean state for a fresh draft.
    const colList = insert.text.match(/\(([\s\S]+?)\)\s*SELECT/);
    assert.ok(colList, 'INSERT column list must be parseable');
    assert.ok(!/public_token/.test(colList[1]),
      'public_token must NOT be in the duplicate INSERT column list (fresh draft mints its own on share)');
    assert.ok(!/view_count|first_viewed_at|last_viewed_at/.test(colList[1]),
      'view-tracking columns must NOT be copied (a duplicate is unviewed)');
    assert.ok(!/payment_link_url|payment_link_id/.test(colList[1]),
      'payment_link_* must NOT be copied (Stripe Pay Link is per-invoice)');
    assert.ok(!/payment_claim/.test(colList[1]),
      'payment_claim_* must NOT be copied (a duplicate has no pending claim)');
    assert.ok(!/sent_via_share/.test(colList[1]),
      'sent_via_share_*_at must NOT be copied (a duplicate has not been sent yet)');
    assert.ok(!/last_reminder_sent_at/.test(colList[1]),
      'last_reminder_sent_at must NOT be copied (a fresh draft has no reminder history)');

    // Param order: sourceId=$1, userId=$2, invoice_number=$3, issued_date=$4, due_date=$5.
    assert.strictEqual(insert.params[0], 123, '$1 must be the source invoice id');
    assert.strictEqual(insert.params[1], 42, '$2 must be the session user id');
    assert.strictEqual(insert.params[2], 'INV-2026-0007', '$3 must be the new invoice_number');
    assert.strictEqual(insert.params[3], '2026-05-19', '$4 must be the new issued_date');
    assert.strictEqual(insert.params[4], '2026-06-18', '$5 must be the new due_date');

    const bump = captured.find(c => /UPDATE users.*invoice_count.*\+\s*1/i.test(c.text));
    assert.ok(bump, 'must bump users.invoice_count in the same transaction (real invoice)');
    assert.deepStrictEqual(bump.params, [42],
      'invoice_count bump must scope to the session user_id, not the source invoice owner');

    assert.strictEqual(released, 1, 'pg client must be released exactly once on success');
  } finally {
    if (originalPg) require.cache[pgPath] = originalPg;
    else delete require.cache[pgPath];
    delete require.cache[require.resolve('../db')];
  }
}

async function testDuplicateInvoiceRollsBackOnMiss() {
  // Source not owned by this user (or doesn't exist): INSERT…SELECT returns 0 rows,
  // duplicate must ROLLBACK and return null without bumping invoice_count.
  const captured = [];
  const pgPath = require.resolve('pg');
  const originalPg = require.cache[pgPath];
  require.cache[pgPath] = {
    id: pgPath, filename: pgPath, loaded: true,
    exports: {
      Pool: function () {
        return {
          query: async () => ({ rows: [] }),
          connect: async () => ({
            query: async (text /*, params */) => {
              captured.push({ text });
              if (/INSERT INTO invoices/i.test(text)) return { rows: [] };
              return { rows: [] };
            },
            release: () => {}
          })
        };
      }
    }
  };
  delete require.cache[require.resolve('../db')];
  const { db } = require('../db');
  try {
    const row = await db.duplicateInvoice(123, 999 /* wrong user */, {
      invoice_number: 'INV-2026-0007',
      issued_date: '2026-05-19',
      due_date: '2026-06-18'
    });
    assert.strictEqual(row, null, 'cross-tenant duplicate must return null');
    const stmts = captured.map(c => c.text.trim().split('\n')[0]);
    assert.ok(stmts.some(s => /^BEGIN$/i.test(s)), 'must open transaction');
    assert.ok(stmts.some(s => /^ROLLBACK$/i.test(s)), 'on miss must ROLLBACK (no partial write)');
    assert.ok(!stmts.some(s => /^COMMIT$/i.test(s)), 'on miss must NOT COMMIT');
    assert.ok(!stmts.some(s => /UPDATE users/i.test(s)),
      'must NOT bump invoice_count when source was missed (cross-tenant or deleted)');
  } finally {
    if (originalPg) require.cache[pgPath] = originalPg;
    else delete require.cache[pgPath];
    delete require.cache[require.resolve('../db')];
  }
}

async function testDuplicateInvoiceFalsyArgShortCircuit() {
  // No DB call at all when sourceId/userId/invoice_number are falsy.
  let calls = 0;
  const pgPath = require.resolve('pg');
  const originalPg = require.cache[pgPath];
  require.cache[pgPath] = {
    id: pgPath, filename: pgPath, loaded: true,
    exports: {
      Pool: function () {
        return {
          query: async () => { calls++; return { rows: [] }; },
          connect: async () => { calls++; return { query: async () => { calls++; return { rows: [] }; }, release: () => {} }; }
        };
      }
    }
  };
  delete require.cache[require.resolve('../db')];
  const { db } = require('../db');
  try {
    assert.strictEqual(await db.duplicateInvoice(null, 1, { invoice_number: 'X' }), null,
      'null sourceId must short-circuit');
    assert.strictEqual(await db.duplicateInvoice(1, null, { invoice_number: 'X' }), null,
      'null userId must short-circuit');
    assert.strictEqual(await db.duplicateInvoice(1, 2, { invoice_number: '' }), null,
      'empty invoice_number must short-circuit');
    assert.strictEqual(calls, 0, 'no DB calls when args are falsy');
  } finally {
    if (originalPg) require.cache[pgPath] = originalPg;
    else delete require.cache[pgPath];
    delete require.cache[require.resolve('../db')];
  }
}

// ============================================================================
// Layer 2 — POST /invoices/:id/duplicate route
// ============================================================================

const users = new Map();
const invoices = new Map();
const duplicateCalls = [];
let nextInvoiceId = 100;

function resetStore() {
  users.clear();
  invoices.clear();
  duplicateCalls.length = 0;
  nextInvoiceId = 100;
}

function buildDbStub() {
  return {
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
      async getNextInvoiceNumber(userId) {
        const count = [...invoices.values()].filter(i => i.user_id === userId).length + 1;
        return `INV-2026-${String(count).padStart(4, '0')}`;
      },
      async duplicateInvoice(sourceId, userId, opts) {
        duplicateCalls.push({ sourceId, userId, opts });
        const source = invoices.get(parseInt(sourceId, 10));
        if (!source || source.user_id !== userId) return null;
        const id = nextInvoiceId++;
        const dup = {
          id,
          user_id: userId,
          invoice_number: opts.invoice_number,
          client_name: source.client_name,
          client_email: source.client_email,
          client_address: source.client_address,
          items: source.items,
          subtotal: source.subtotal,
          tax_rate: source.tax_rate,
          tax_amount: source.tax_amount,
          total: source.total,
          notes: source.notes,
          issued_date: opts.issued_date,
          due_date: opts.due_date,
          status: 'draft',
          is_seed: false,
          payment_link_url: null,
          payment_link_id: null,
          public_token: null
        };
        invoices.set(id, dup);
        const u = users.get(userId);
        if (u) u.invoice_count = (u.invoice_count || 0) + 1;
        return dup;
      },
      // The route also touches these on the request — return innocuous defaults.
      async getOrCreatePublicToken() { return null; },
      async getInvoiceCount() { return 0; }
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
  // share-link prefetch lib calls getOrCreatePublicToken via the stub — stable.
  // Stripe payment link can also be touched; stub it out.
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

async function testDuplicateHappyPathPro() {
  resetStore();
  users.set(1, { id: 1, plan: 'pro', invoice_count: 2, name: 'Alice', email: 'a@x.com' });
  const src = {
    id: 50, user_id: 1, invoice_number: 'INV-2026-0001',
    client_name: 'Acme Corp', client_email: 'pay@acme.com', client_address: '1 St',
    items: [{ description: 'Design', quantity: 4, unit_price: 75 }],
    subtotal: 300, tax_rate: 0, tax_amount: 0, total: 300,
    notes: 'Thanks!', status: 'paid', is_seed: false
  };
  invoices.set(50, src);

  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'pro', invoice_count: 2 }, routes);

  const res = await request(app, 'POST', '/invoices/50/duplicate');
  assert.strictEqual(res.status, 302, 'pro user duplicate must redirect');
  assert.ok(/\/invoices\/\d+\/edit$/.test(res.headers.location),
    `must redirect to /invoices/<newId>/edit, got ${res.headers.location}`);

  assert.strictEqual(duplicateCalls.length, 1, 'db.duplicateInvoice called exactly once');
  const call = duplicateCalls[0];
  assert.strictEqual(call.sourceId, 50, 'source id passed correctly');
  assert.strictEqual(call.userId, 1, 'session user id passed correctly');
  assert.ok(/^INV-2026-\d{4}$/.test(call.opts.invoice_number),
    'new invoice_number must follow the INV-YYYY-NNNN pattern');
  assert.notStrictEqual(call.opts.invoice_number, src.invoice_number,
    'new invoice_number must NOT collide with the source\'s number');
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(call.opts.issued_date),
    'issued_date must be YYYY-MM-DD');
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(call.opts.due_date),
    'due_date must be YYYY-MM-DD');
  // due_date must be 30 days after issued_date — the freelancer's default cycle.
  const issued = new Date(call.opts.issued_date + 'T00:00:00Z');
  const due = new Date(call.opts.due_date + 'T00:00:00Z');
  assert.strictEqual(due.getTime() - issued.getTime(), 30 * 86400000,
    'due_date must default to issued_date + 30 days');
}

async function testDuplicateCrossTenantNoCall() {
  resetStore();
  // Invoice belongs to user 5; request comes from user 99.
  invoices.set(77, {
    id: 77, user_id: 5, invoice_number: 'INV-2026-0001',
    client_name: 'Other', items: [], subtotal: 0, tax_rate: 0, tax_amount: 0, total: 0,
    status: 'sent', is_seed: false
  });
  users.set(99, { id: 99, plan: 'pro', invoice_count: 0, name: 'Eve', email: 'e@x.com' });

  const routes = installDbStub();
  const app = buildApp({ id: 99, plan: 'pro', invoice_count: 0 }, routes);

  const res = await request(app, 'POST', '/invoices/77/duplicate');
  assert.strictEqual(res.status, 302, 'cross-tenant duplicate must redirect');
  assert.ok(/\/dashboard$/.test(res.headers.location),
    `cross-tenant POST must redirect to /dashboard, got ${res.headers.location}`);
  assert.strictEqual(duplicateCalls.length, 0,
    'db.duplicateInvoice must NOT be called when getInvoiceById gates the cross-tenant access');
}

async function testDuplicateFreeUserAtLimit() {
  resetStore();
  // Free user with 3 real invoices (at the limit). The seed exists but doesn't bump count.
  users.set(7, { id: 7, plan: 'free', invoice_count: 3, name: 'Bob', email: 'b@x.com' });
  invoices.set(1, { id: 1, user_id: 7, invoice_number: 'INV-1', items: [], subtotal: 0, tax_rate: 0, tax_amount: 0, total: 0, status: 'paid', is_seed: false });

  const routes = installDbStub();
  const app = buildApp({ id: 7, plan: 'free', invoice_count: 3 }, routes);

  const res = await request(app, 'POST', '/invoices/1/duplicate');
  assert.strictEqual(res.status, 302, 'free-tier limit redirect');
  assert.ok(/\/invoices\?limit_hit=1$/.test(res.headers.location),
    `at-limit free user must be redirected to /invoices?limit_hit=1, got ${res.headers.location}`);
  assert.strictEqual(duplicateCalls.length, 0,
    'duplicate must NOT be called when the free-tier limit is hit');
}

async function testDuplicateFreeUserBelowLimitWithSeedOnly() {
  // Headline Milestone 2 case: free user has only the seed (invoice_count=0)
  // and duplicates it to create their first real invoice.
  resetStore();
  users.set(8, { id: 8, plan: 'free', invoice_count: 0, name: 'Carol', email: 'c@x.com' });
  invoices.set(900, {
    id: 900, user_id: 8, invoice_number: 'INV-2026-0001',
    client_name: 'Sample Client (edit this)', client_email: 'client@example.com',
    items: [{ description: 'Design consultation (4 hrs)', quantity: 4, unit_price: 75 }],
    subtotal: 300, tax_rate: 0, tax_amount: 0, total: 300,
    notes: 'Thanks for your business!', status: 'draft', is_seed: true
  });

  const routes = installDbStub();
  const app = buildApp({ id: 8, plan: 'free', invoice_count: 0 }, routes);

  const res = await request(app, 'POST', '/invoices/900/duplicate');
  assert.strictEqual(res.status, 302, 'seed duplicate must redirect');
  assert.ok(/\/invoices\/\d+\/edit$/.test(res.headers.location),
    `seed duplicate must land on edit page, got ${res.headers.location}`);
  assert.strictEqual(duplicateCalls.length, 1, 'duplicate fires once');

  // The duplicated row in the stub must be a real (non-seed) draft, distinct id.
  const newId = parseInt(res.headers.location.match(/\/invoices\/(\d+)\/edit/)[1], 10);
  const dup = invoices.get(newId);
  assert.ok(dup, 'duplicated invoice must exist in the stub store');
  assert.notStrictEqual(dup.id, 900, 'duplicated invoice must have a new id');
  assert.strictEqual(dup.is_seed, false, 'duplicated invoice must NOT be a seed');
  assert.strictEqual(dup.status, 'draft', 'duplicated invoice must start as a draft');
  assert.deepStrictEqual(dup.items, [{ description: 'Design consultation (4 hrs)', quantity: 4, unit_price: 75 }],
    'line items must be copied across verbatim');
  assert.strictEqual(dup.notes, 'Thanks for your business!', 'notes must be copied across');
}

async function testDuplicateSourceNotFound() {
  resetStore();
  users.set(11, { id: 11, plan: 'pro', invoice_count: 0, name: 'Dee', email: 'd@x.com' });
  const routes = installDbStub();
  const app = buildApp({ id: 11, plan: 'pro', invoice_count: 0 }, routes);

  const res = await request(app, 'POST', '/invoices/99999/duplicate');
  assert.strictEqual(res.status, 302, 'missing-source duplicate still redirects');
  assert.ok(/\/dashboard$/.test(res.headers.location),
    `missing-source POST must redirect to /dashboard, got ${res.headers.location}`);
  assert.strictEqual(duplicateCalls.length, 0,
    'db.duplicateInvoice must NOT be called when the source is not loadable');
}

// ============================================================================
// Layer 3 — views/invoice-view.ejs button surface
// ============================================================================

async function renderInvoiceView(opts) {
  const viewsDir = path.join(__dirname, '..', 'views');
  return ejs.renderFile(path.join(viewsDir, 'invoice-view.ejs'),
    Object.assign({ title: 'Invoice' }, opts),
    { views: [viewsDir] });
}

function invoiceFixture(overrides) {
  return Object.assign({
    id: 42, invoice_number: 'INV-2026-0001',
    client_name: 'Sample Co', client_email: 'pay@sample.co', client_address: '',
    items: [], subtotal: 100, tax_rate: 0, tax_amount: 0, total: 100,
    notes: '', status: 'draft', is_seed: false,
    issued_date: new Date('2026-05-19'), due_date: new Date('2026-06-18'),
    payment_link_url: null, payment_link_id: null,
    public_token: null, view_count: 0, first_viewed_at: null, last_viewed_at: null,
    sent_via_share_view_at: null, sent_via_share_intent_at: null,
    payment_claimed_at: null, payment_claim_method: null,
    payment_claim_reference: null, payment_claim_note: null,
    last_reminder_sent_at: null, created_at: new Date(), updated_at: new Date()
  }, overrides || {});
}

function userFixture(overrides) {
  return Object.assign({
    id: 1, name: 'Alice', email: 'alice@x.com',
    business_name: 'Alice & Co', business_email: 'biz@alice.com',
    plan: 'pro', subscription_status: 'active', trial_ends_at: null,
    payment_instructions: '', stripe_subscription_id: 'sub_x'
  }, overrides || {});
}

async function testViewDuplicateButtonOnAllStatuses() {
  const statuses = ['draft', 'sent', 'paid', 'overdue'];
  for (const status of statuses) {
    const html = await renderInvoiceView({
      invoice: invoiceFixture({ status }),
      user: userFixture(),
      flash: null,
      paymentMethods: ['card'],
      prefetchedShare: null,
      csrfToken: 'tkn'
    });
    assert.ok(html.includes('data-testid="invoice-duplicate-form"'),
      `${status}: duplicate form must be in the rendered HTML`);
    assert.ok(html.includes('data-testid="invoice-duplicate-button"'),
      `${status}: duplicate button must be in the rendered HTML`);
    assert.ok(html.includes('action="/invoices/42/duplicate"'),
      `${status}: form action must POST to /invoices/<id>/duplicate`);
    assert.ok(html.includes('name="_csrf"') && html.includes('value="tkn"'),
      `${status}: CSRF hidden input must be present with token`);
    assert.ok(html.includes('method="POST"') || html.toLowerCase().includes('method="post"'),
      `${status}: duplicate form must use POST`);
  }
}

async function testViewDuplicateButtonOnFreePlan() {
  // Plan-agnostic surface: free users see the button too (it's the primary
  // Milestone 2 lever for them — clone the seed).
  const html = await renderInvoiceView({
    invoice: invoiceFixture({ is_seed: true, client_name: 'Sample Client (edit this)' }),
    user: userFixture({ plan: 'free', subscription_status: null, stripe_subscription_id: null }),
    flash: null,
    paymentMethods: ['card'],
    prefetchedShare: null,
    csrfToken: 'tkn'
  });
  assert.ok(html.includes('data-testid="invoice-duplicate-button"'),
    'duplicate button must render for free-tier users on the seed invoice');
  assert.ok(html.includes('action="/invoices/42/duplicate"'),
    'duplicate form action correct on free plan');
  // Seed-specific copy nudge tells the user the clone will be a real draft.
  assert.ok(/Duplicate.*as draft/i.test(html) || /as draft/i.test(html),
    'seed invoice surfaces an "as draft" copy hint on the duplicate button');
}

async function testViewDuplicateButtonNonSeedOmitsSeedCopy() {
  const html = await renderInvoiceView({
    invoice: invoiceFixture({ is_seed: false, status: 'paid' }),
    user: userFixture(),
    flash: null,
    paymentMethods: ['card'],
    prefetchedShare: null,
    csrfToken: 'tkn'
  });
  assert.ok(html.includes('data-testid="invoice-duplicate-button"'),
    'duplicate button renders on a real (non-seed) invoice');
  assert.ok(!/Duplicate.*as draft/i.test(html),
    'real (non-seed) invoice button must NOT carry the "as draft" suffix');
}

// ============================================================================
// Runner
// ============================================================================

async function run() {
  const tests = [
    ['db.duplicateInvoice: INSERT…SELECT SQL contract + transactional BEGIN/COMMIT + invoice_count bump', testDuplicateInvoiceSqlContractHappy],
    ['db.duplicateInvoice: source-not-found → ROLLBACK + return null + no invoice_count bump', testDuplicateInvoiceRollsBackOnMiss],
    ['db.duplicateInvoice: falsy-arg short-circuit (no DB call)', testDuplicateInvoiceFalsyArgShortCircuit],
    ['POST /invoices/:id/duplicate: pro user happy path → 302 to /edit with copied args', testDuplicateHappyPathPro],
    ['POST /invoices/:id/duplicate: cross-tenant → 302 /dashboard + no duplicate call', testDuplicateCrossTenantNoCall],
    ['POST /invoices/:id/duplicate: free-tier at limit → 302 /invoices?limit_hit=1', testDuplicateFreeUserAtLimit],
    ['POST /invoices/:id/duplicate: free-tier below limit on seed → 302 /edit + dup is non-seed draft', testDuplicateFreeUserBelowLimitWithSeedOnly],
    ['POST /invoices/:id/duplicate: source not found → 302 /dashboard + no duplicate call', testDuplicateSourceNotFound],
    ['views/invoice-view.ejs: duplicate button + CSRF + action URL on all statuses', testViewDuplicateButtonOnAllStatuses],
    ['views/invoice-view.ejs: duplicate button surfaces for free-tier seed (as-draft copy)', testViewDuplicateButtonOnFreePlan],
    ['views/invoice-view.ejs: non-seed invoice omits the "as draft" suffix', testViewDuplicateButtonNonSeedOmitsSeedCopy]
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
