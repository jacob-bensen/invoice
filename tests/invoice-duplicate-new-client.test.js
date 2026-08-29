'use strict';

/*
 * Duplicate-for-a-new-client tests.
 *
 * Extends the existing invoice-duplicate flow with a second action that
 * clones items / notes / tax but leaves the client fields blank so a
 * freelancer duplicating a template (or the seed sample "Sample Client
 * (edit this)") for a DIFFERENT client doesn't have to erase the old
 * client_name / client_email / client_address before typing the new one.
 *
 * Coverage (3 layers):
 *
 *   - db.duplicateInvoice(clearClient: true)
 *       * INSERT projection swaps client_name/client_email/client_address
 *         for `'', NULL, NULL` so the new row starts with a blank client.
 *       * All other columns (items/notes/tax/totals) still copy across.
 *       * Same-client path is preserved when clearClient is absent /
 *         falsy / non-boolean (defence-in-depth against a URL-tampered
 *         upstream value).
 *
 *   - POST /invoices/:id/duplicate with body { client_scope: 'new_client' }
 *       * Threads clearClient=true down to the db call.
 *       * Any other body value (missing / 'same' / 'garbage') threads
 *         clearClient=false so a URL-tampered POST can only lose the
 *         client-blank flag, never gain it.
 *       * Cross-tenant + free-tier limit gates still apply (regression).
 *       * Flash message pivots to the new-client copy so the freelancer
 *         knows to fill the client fields in.
 *
 *   - views/invoice-view.ejs
 *       * Second duplicate form + button render on every status + plan.
 *       * client_scope hidden input carries value="new_client".
 *       * Distinct data-testid so the two duplicate buttons don't collide.
 *       * CSRF hidden input present on both forms.
 *
 * Run: NODE_ENV=test node tests/invoice-duplicate-new-client.test.js
 */

const assert = require('assert');
const path = require('path');
const ejs = require('ejs');
const express = require('express');
const http = require('http');

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

// ============================================================================
// Layer 1 — db.duplicateInvoice({clearClient: true}) SQL projection swap
// ============================================================================

async function testDbDuplicateClearsClientProjection() {
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
            query: async (text, params) => {
              captured.push({ text, params });
              if (/^BEGIN|^COMMIT|^ROLLBACK/i.test(text.trim())) return { rows: [] };
              if (/INSERT INTO invoices/i.test(text)) {
                return { rows: [{ id: 9002, invoice_number: params[2], is_seed: false, status: 'draft', client_name: '', client_email: null, client_address: null }] };
              }
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
    const row = await db.duplicateInvoice(500, 42, {
      invoice_number: 'INV-2026-0099',
      issued_date: '2026-08-29',
      due_date: '2026-09-28',
      clearClient: true
    });
    assert.ok(row, 'duplicateInvoice(clearClient) must return the new row');
    const insert = captured.find(c => /INSERT INTO invoices/i.test(c.text));
    assert.ok(insert, 'must issue an INSERT INTO invoices');
    // The SELECT projection for client_* must be the blank triple literal
    // rather than the source columns.
    assert.ok(/SELECT\s+user_id,\s*\$3,\s*'',\s*NULL,\s*NULL/i.test(insert.text),
      'clearClient=true SELECT must project ("", NULL, NULL) for the client_* triple, got:\n' + insert.text);
    assert.ok(!/SELECT\s+user_id,\s*\$3,\s*client_name/i.test(insert.text),
      'clearClient=true must NOT project the source client_name column');
    // Items/notes/tax MUST still copy from the source — only the client
    // triple gets nulled.
    assert.ok(/items,\s*subtotal,\s*tax_rate,\s*tax_amount,\s*total,\s*notes/i.test(insert.text),
      'clearClient=true must still copy items/subtotal/tax_rate/tax_amount/total/notes from the source');
    // Params must NOT swell — the projection change is inline SQL, no new $N.
    assert.strictEqual(insert.params.length, 5,
      'clearClient=true must not add a bound parameter (inline SQL literal only)');
  } finally {
    if (originalPg) require.cache[pgPath] = originalPg;
    else delete require.cache[pgPath];
    delete require.cache[require.resolve('../db')];
  }
}

async function testDbDuplicateFalsyClearClientPreservesSameClientProjection() {
  // Verifies the strict `=== true` whitelist: any falsy or non-boolean
  // value threads the same-client projection so a URL-tampered upstream
  // (`clearClient: '1'`, `'true'`, `1`) cannot escalate.
  const cases = [undefined, null, false, 0, '', '1', 'true', 1, 'new_client', {}];
  for (const clearClient of cases) {
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
              query: async (text, params) => {
                captured.push({ text, params });
                if (/^BEGIN|^COMMIT|^ROLLBACK/i.test(text.trim())) return { rows: [] };
                if (/INSERT INTO invoices/i.test(text)) {
                  return { rows: [{ id: 9003, invoice_number: params[2] }] };
                }
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
      await db.duplicateInvoice(1, 1, {
        invoice_number: 'INV-2026-0001',
        issued_date: '2026-08-29',
        due_date: '2026-09-28',
        clearClient
      });
      const insert = captured.find(c => /INSERT INTO invoices/i.test(c.text));
      assert.ok(insert, `case ${JSON.stringify(clearClient)}: INSERT must have run`);
      assert.ok(/SELECT\s+user_id,\s*\$3,\s*client_name,\s*client_email,\s*client_address/i.test(insert.text),
        `clearClient=${JSON.stringify(clearClient)} must fall back to the same-client projection, got:\n` + insert.text);
      assert.ok(!/'',\s*NULL,\s*NULL/i.test(insert.text),
        `clearClient=${JSON.stringify(clearClient)} must NOT project the blank triple`);
    } finally {
      if (originalPg) require.cache[pgPath] = originalPg;
      else delete require.cache[pgPath];
      delete require.cache[require.resolve('../db')];
    }
  }
}

// ============================================================================
// Layer 2 — POST /invoices/:id/duplicate wiring of client_scope=new_client
// ============================================================================

const users = new Map();
const invoices = new Map();
const duplicateCalls = [];
let nextInvoiceId = 1000;

function resetStore() {
  users.clear();
  invoices.clear();
  duplicateCalls.length = 0;
  nextInvoiceId = 1000;
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
          client_name: opts.clearClient === true ? '' : source.client_name,
          client_email: opts.clearClient === true ? null : source.client_email,
          client_address: opts.clearClient === true ? null : source.client_address,
          items: source.items,
          subtotal: source.subtotal,
          tax_rate: source.tax_rate,
          tax_amount: source.tax_amount,
          total: source.total,
          notes: source.notes,
          issued_date: opts.issued_date,
          due_date: opts.due_date,
          status: 'draft',
          is_seed: false
        };
        invoices.set(id, dup);
        const u = users.get(userId);
        if (u) u.invoice_count = (u.invoice_count || 0) + 1;
        return dup;
      },
      async getOrCreatePublicToken() { return null; },
      async getInvoiceCount() { return 0; }
    }
  };
}

function installDbStub() {
  const stub = buildDbStub();
  require.cache[require.resolve('../db')] = {
    id: require.resolve('../db'), filename: require.resolve('../db'),
    loaded: true, exports: stub
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

async function testRouteNewClientVariantThreadsClearClientTrue() {
  resetStore();
  users.set(1, { id: 1, plan: 'pro', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  invoices.set(50, {
    id: 50, user_id: 1, invoice_number: 'INV-2026-0001',
    client_name: 'Sample Client (edit this)',
    client_email: 'client@example.com',
    client_address: '1 Sample St',
    items: [{ description: 'Design consultation (4 hrs)', quantity: 4, unit_price: 75 }],
    subtotal: 300, tax_rate: 0, tax_amount: 0, total: 300,
    notes: 'Thanks for your business!', status: 'draft', is_seed: true
  });

  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'pro', invoice_count: 0 }, routes);

  const res = await request(app, 'POST', '/invoices/50/duplicate', { client_scope: 'new_client' });
  assert.strictEqual(res.status, 302, 'new-client duplicate must redirect');
  assert.ok(/\/invoices\/\d+\/edit$/.test(res.headers.location),
    `must redirect to /invoices/<newId>/edit, got ${res.headers.location}`);
  assert.strictEqual(duplicateCalls.length, 1, 'duplicate called exactly once');
  assert.strictEqual(duplicateCalls[0].opts.clearClient, true,
    'client_scope=new_client must thread clearClient=true to db.duplicateInvoice');

  // The stub-created row must have blank client fields but preserved items/notes.
  const newId = parseInt(res.headers.location.match(/\/invoices\/(\d+)\/edit/)[1], 10);
  const dup = invoices.get(newId);
  assert.ok(dup, 'duplicated invoice must exist');
  assert.strictEqual(dup.client_name, '', 'new-client duplicate must blank client_name');
  assert.strictEqual(dup.client_email, null, 'new-client duplicate must NULL client_email');
  assert.strictEqual(dup.client_address, null, 'new-client duplicate must NULL client_address');
  assert.deepStrictEqual(dup.items,
    [{ description: 'Design consultation (4 hrs)', quantity: 4, unit_price: 75 }],
    'new-client duplicate must still copy items across');
  assert.strictEqual(dup.notes, 'Thanks for your business!',
    'new-client duplicate must still copy notes across');
  assert.strictEqual(dup.tax_rate, 0, 'new-client duplicate must still copy tax_rate');
  assert.strictEqual(dup.total, 300, 'new-client duplicate must still copy total');
}

async function testRouteAbsentBodyThreadsClearClientFalse() {
  // Regression guard: the classic same-client button (no client_scope in the
  // body) still threads clearClient=false, and the duplicated row keeps the
  // source client_name.
  resetStore();
  users.set(2, { id: 2, plan: 'pro', invoice_count: 1, name: 'Bob', email: 'b@x.com' });
  invoices.set(60, {
    id: 60, user_id: 2, invoice_number: 'INV-2026-0001',
    client_name: 'Repeat Client Inc', client_email: 'pay@repeat.com', client_address: '2 Repeat Rd',
    items: [{ description: 'Retainer', quantity: 1, unit_price: 500 }],
    subtotal: 500, tax_rate: 0, tax_amount: 0, total: 500,
    notes: '', status: 'paid', is_seed: false
  });

  const routes = installDbStub();
  const app = buildApp({ id: 2, plan: 'pro', invoice_count: 1 }, routes);

  const res = await request(app, 'POST', '/invoices/60/duplicate');
  assert.strictEqual(res.status, 302);
  assert.strictEqual(duplicateCalls.length, 1);
  assert.strictEqual(duplicateCalls[0].opts.clearClient, false,
    'absent client_scope must thread clearClient=false');
  const newId = parseInt(res.headers.location.match(/\/invoices\/(\d+)\/edit/)[1], 10);
  const dup = invoices.get(newId);
  assert.strictEqual(dup.client_name, 'Repeat Client Inc',
    'same-client duplicate must preserve source client_name');
  assert.strictEqual(dup.client_email, 'pay@repeat.com',
    'same-client duplicate must preserve source client_email');
}

async function testRouteTamperedClientScopeCoercesToFalse() {
  // Any value that isn't exactly 'new_client' must coerce to the safe
  // same-client default. This prevents a subtle bug where a form value
  // like 'new-client' (dash vs underscore) or an empty string silently
  // escalated the caller.
  const bogusValues = ['same', 'new-client', 'NEW_CLIENT', '', 'true', '1'];
  for (const client_scope of bogusValues) {
    resetStore();
    users.set(3, { id: 3, plan: 'pro', invoice_count: 0, name: 'Carol', email: 'c@x.com' });
    invoices.set(70, {
      id: 70, user_id: 3, invoice_number: 'INV-2026-0001',
      client_name: 'Kept Client', client_email: 'k@k.com', client_address: '',
      items: [], subtotal: 0, tax_rate: 0, tax_amount: 0, total: 0,
      notes: '', status: 'sent', is_seed: false
    });
    const routes = installDbStub();
    const app = buildApp({ id: 3, plan: 'pro', invoice_count: 0 }, routes);
    const res = await request(app, 'POST', '/invoices/70/duplicate', { client_scope });
    assert.strictEqual(res.status, 302, `client_scope=${JSON.stringify(client_scope)}: 302`);
    assert.strictEqual(duplicateCalls.length, 1,
      `client_scope=${JSON.stringify(client_scope)}: duplicate fires once`);
    assert.strictEqual(duplicateCalls[0].opts.clearClient, false,
      `client_scope=${JSON.stringify(client_scope)} must coerce to clearClient=false (strict === 'new_client' whitelist)`);
    const newId = parseInt(res.headers.location.match(/\/invoices\/(\d+)\/edit/)[1], 10);
    const dup = invoices.get(newId);
    assert.strictEqual(dup.client_name, 'Kept Client',
      `client_scope=${JSON.stringify(client_scope)}: same-client fallback preserves source client_name`);
  }
}

async function testRouteFreeTierAtLimitRejectsNewClientVariantToo() {
  // The free-tier gate must fire before the new-client branch runs, so a
  // 3-of-3 free user posting client_scope=new_client is still bounced to
  // /invoices?limit_hit=1 (regression guard vs. a refactor that swapped
  // the check order).
  resetStore();
  users.set(9, { id: 9, plan: 'free', invoice_count: 3, name: 'Free', email: 'f@x.com' });
  invoices.set(80, {
    id: 80, user_id: 9, invoice_number: 'INV-1',
    client_name: 'X', items: [], subtotal: 0, tax_rate: 0, tax_amount: 0, total: 0,
    status: 'paid', is_seed: false
  });
  const routes = installDbStub();
  const app = buildApp({ id: 9, plan: 'free', invoice_count: 3 }, routes);
  const res = await request(app, 'POST', '/invoices/80/duplicate', { client_scope: 'new_client' });
  assert.strictEqual(res.status, 302);
  assert.ok(/\/invoices\?limit_hit=1$/.test(res.headers.location),
    `free-tier at-limit must bounce to /invoices?limit_hit=1 even on new-client variant, got ${res.headers.location}`);
  assert.strictEqual(duplicateCalls.length, 0,
    'duplicate must NOT be called when the free-tier limit is hit');
}

async function testRouteCrossTenantNewClientVariantRejected() {
  // Cross-tenant new-client duplicate must 302 /dashboard and NEVER touch
  // db.duplicateInvoice — the getInvoiceById gate fires first.
  resetStore();
  users.set(99, { id: 99, plan: 'pro', invoice_count: 0, name: 'Eve', email: 'e@x.com' });
  invoices.set(88, {
    id: 88, user_id: 5, invoice_number: 'INV-2026-0001',
    client_name: 'Other Owner', items: [], subtotal: 0, tax_rate: 0, tax_amount: 0, total: 0,
    status: 'sent', is_seed: false
  });
  const routes = installDbStub();
  const app = buildApp({ id: 99, plan: 'pro', invoice_count: 0 }, routes);
  const res = await request(app, 'POST', '/invoices/88/duplicate', { client_scope: 'new_client' });
  assert.strictEqual(res.status, 302);
  assert.ok(/\/dashboard$/.test(res.headers.location),
    `cross-tenant new-client POST must redirect to /dashboard, got ${res.headers.location}`);
  assert.strictEqual(duplicateCalls.length, 0,
    'cross-tenant new-client duplicate must NOT reach db.duplicateInvoice');
}

// ============================================================================
// Layer 3 — views/invoice-view.ejs render surface
// ============================================================================

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

async function renderInvoiceView(opts) {
  const viewsDir = path.join(__dirname, '..', 'views');
  return ejs.renderFile(path.join(viewsDir, 'invoice-view.ejs'),
    Object.assign({ title: 'Invoice' }, opts),
    { views: [viewsDir] });
}

async function testViewNewClientDuplicateButtonRenders() {
  const html = await renderInvoiceView({
    invoice: invoiceFixture(),
    user: userFixture(),
    flash: null,
    paymentMethods: ['card'],
    prefetchedShare: null,
    csrfToken: 'tkn'
  });
  // The new-client button lives in its own <form> so the classic button's
  // testid is not overloaded. Both forms POST to the same route.
  assert.ok(html.includes('data-testid="invoice-duplicate-new-client-form"'),
    'new-client duplicate form must be in the rendered HTML');
  assert.ok(html.includes('data-testid="invoice-duplicate-new-client-button"'),
    'new-client duplicate button must be in the rendered HTML');
  // Distinguishable testid so tests can target each button independently.
  assert.ok(html.includes('data-testid="invoice-duplicate-form"'),
    'classic same-client duplicate form must still render alongside');
  assert.ok(html.includes('data-testid="invoice-duplicate-button"'),
    'classic same-client duplicate button must still render alongside');
  // Both forms must POST to /invoices/<id>/duplicate.
  const dupForms = html.match(/action="\/invoices\/42\/duplicate"/g) || [];
  assert.strictEqual(dupForms.length, 2,
    'both duplicate forms must POST to /invoices/42/duplicate (found ' + dupForms.length + ')');
  // The hidden input is the flag that pivots the route's behaviour — it
  // MUST carry value="new_client" verbatim (the route uses a strict
  // === 'new_client' whitelist).
  assert.ok(/name="client_scope"\s+value="new_client"/.test(html),
    'new-client form must include hidden input client_scope="new_client"');
  // CSRF present on both forms.
  const csrfInputs = html.match(/name="_csrf"\s+value="tkn"/g) || [];
  assert.ok(csrfInputs.length >= 2,
    'CSRF hidden input must be present on both duplicate forms (found ' + csrfInputs.length + ')');
}

async function testViewNewClientButtonRendersOnEveryStatus() {
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
    assert.ok(html.includes('data-testid="invoice-duplicate-new-client-button"'),
      `${status}: new-client duplicate button must render`);
    assert.ok(/name="client_scope"\s+value="new_client"/.test(html),
      `${status}: client_scope hidden input must carry "new_client"`);
  }
}

async function testViewNewClientButtonRendersOnFreePlanAndSeed() {
  // Free-tier + seed source is the headline Milestone 2 case: the sample
  // invoice's placeholder client "Sample Client (edit this)" is exactly
  // what the new-client duplicate exists to erase in one click.
  const html = await renderInvoiceView({
    invoice: invoiceFixture({ is_seed: true, client_name: 'Sample Client (edit this)' }),
    user: userFixture({ plan: 'free', subscription_status: null, stripe_subscription_id: null }),
    flash: null,
    paymentMethods: ['card'],
    prefetchedShare: null,
    csrfToken: 'tkn'
  });
  assert.ok(html.includes('data-testid="invoice-duplicate-new-client-button"'),
    'new-client duplicate button must render for free-tier user on the seed sample (the headline M2 use case)');
  assert.ok(/name="client_scope"\s+value="new_client"/.test(html),
    'free-tier seed: client_scope hidden input carries "new_client"');
}

// ============================================================================
// Runner
// ============================================================================

async function run() {
  const tests = [
    ['db.duplicateInvoice(clearClient=true): SELECT projects ("", NULL, NULL) for client_*', testDbDuplicateClearsClientProjection],
    ['db.duplicateInvoice(falsy clearClient): strict-boolean whitelist preserves same-client projection', testDbDuplicateFalsyClearClientPreservesSameClientProjection],
    ['POST /:id/duplicate {client_scope:new_client}: threads clearClient=true + blanks client fields', testRouteNewClientVariantThreadsClearClientTrue],
    ['POST /:id/duplicate (absent body): threads clearClient=false + preserves source client', testRouteAbsentBodyThreadsClearClientFalse],
    ['POST /:id/duplicate (tampered client_scope): strict === "new_client" whitelist coerces to false', testRouteTamperedClientScopeCoercesToFalse],
    ['POST /:id/duplicate {client_scope:new_client}: free-tier limit still fires (regression)', testRouteFreeTierAtLimitRejectsNewClientVariantToo],
    ['POST /:id/duplicate {client_scope:new_client}: cross-tenant rejected (regression)', testRouteCrossTenantNewClientVariantRejected],
    ['views/invoice-view.ejs: new-client duplicate form + CSRF + hidden client_scope render', testViewNewClientDuplicateButtonRenders],
    ['views/invoice-view.ejs: new-client duplicate button surfaces on every status', testViewNewClientButtonRendersOnEveryStatus],
    ['views/invoice-view.ejs: new-client duplicate button surfaces on free-tier seed sample', testViewNewClientButtonRendersOnFreePlanAndSeed]
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
