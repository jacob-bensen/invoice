'use strict';

/*
 * Draft-backlog bulk send on the dashboard invoices table (BACKLOG item —
 * Milestone 3: first invoice created → first invoice sent). Coverage across
 * two layers:
 *
 * Layer 1 — routes/invoices.js: POST /invoices/bulk-share-intent.
 *   Accepts { ids: [...], intent } and, for each id, applies the same
 *   ownership + non-seed + draft-only + has-public-token gate as the
 *   per-row /:id/share-intent route before running its atomic
 *   markInvoiceSentFromShareIntent flip. Returns a per-id results row so
 *   the UI can render partial success ("copied 3 of 4"). Non-qualifying
 *   ids come back with an error string, never mutate state, and never
 *   leak cross-tenant data. First-sent celebration fires once for the
 *   whole batch (idempotent at the SQL layer).
 *
 * Layer 2 — views/dashboard.ejs: bulk-select bar + per-row checkbox.
 *   Only draft rows the server flagged bulk-eligible (via tableSendIntents)
 *   render a checkbox; the floating action bar is x-show gated on
 *   selectedIds.length; the Copy button POSTs to
 *   /invoices/bulk-share-intent with the selected ids + intent=copy and
 *   the CSRF token. The Alpine bulkDraftSelector factory ships inline.
 *
 * Run: NODE_ENV=test node tests/bulk-share-intent.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');
const express = require('express');
const http = require('http');

process.env.APP_URL = process.env.APP_URL || 'https://decentinvoice.test';
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

// ---------- Stub the db layer ---------------------------------------------

function clearReq(mod) { delete require.cache[require.resolve(mod)]; }

const users = new Map();
const invoicesStore = new Map();
const shareIntentFlips = [];  // audit log — every db.markInvoiceSentFromShareIntent call
const celebrations = [];       // audit log — every firstSentCelebration invocation

function resetStore() {
  users.clear();
  invoicesStore.clear();
  shareIntentFlips.length = 0;
  celebrations.length = 0;
}

const dbStub = {
  pool: { query: async () => ({ rows: [] }) },
  db: {
    async getUserById(id) { return users.get(id) || null; },
    async getInvoiceById(id, userId) {
      const inv = invoicesStore.get(parseInt(id, 10));
      if (!inv || inv.user_id !== userId) return null;
      // Return a fresh shallow copy — production returns fresh rows from
      // SQL, and the route relies on the pre-flip snapshot for its
      // `flipped` computation (invoice.status must still be 'draft'
      // even after the UPDATE row comes back 'sent').
      return Object.assign({}, inv);
    },
    async markInvoiceSentFromShareIntent(id, userId) {
      const inv = invoicesStore.get(parseInt(id, 10));
      if (!inv || inv.user_id !== userId) return null;
      shareIntentFlips.push({ id: inv.id, userId, priorStatus: inv.status });
      if (inv.status === 'draft') inv.status = 'sent';
      return Object.assign({}, inv);
    },
    async getUserByEmail() { return null; },
    async createUser() { throw new Error('unused'); },
    async updateUser() { throw new Error('unused'); },
    async getInvoicesByUser() { throw new Error('unused'); },
    async updateInvoiceStatus() { throw new Error('unused'); },
    async setInvoicePaymentLink() { throw new Error('unused'); },
    async markInvoicePaidByPaymentLinkId() { throw new Error('unused'); },
    async getNextInvoiceNumber() { return 'INV-2026-9999'; },
    async createInvoice() { throw new Error('unused'); },
    async updateInvoice() { throw new Error('unused'); },
    async deleteInvoice() { throw new Error('unused'); },
    async triggerFirstSentCelebration() { return { fired: true }; }
  }
};

require.cache[require.resolve('../db')] = {
  id: require.resolve('../db'),
  filename: require.resolve('../db'),
  loaded: true,
  exports: dbStub
};

// Stub the celebration lib so we can verify the batch fires it ONCE and not
// per-flip. The real implementation is DB-idempotent but we still want the
// batch to make exactly one call, not N.
require.cache[require.resolve('../lib/first-sent-celebration')] = {
  id: require.resolve('../lib/first-sent-celebration'),
  filename: require.resolve('../lib/first-sent-celebration'),
  loaded: true,
  exports: {
    triggerFirstSentCelebration: async (_db, userId, invoice) => {
      celebrations.push({ userId, invoice_id: invoice ? invoice.id : null });
      return { fired: true };
    }
  }
};

// Stripe stub so requiring the module doesn't hit the wire.
require.cache[require.resolve('stripe')] = {
  id: require.resolve('stripe'),
  filename: require.resolve('stripe'),
  loaded: true,
  exports: () => ({
    checkout: { sessions: { create: async () => ({ id: 's_test' }) } },
    customers: { create: async () => ({ id: 'cus_test' }), retrieve: async () => ({ id: 'cus_test' }) },
    subscriptions: { retrieve: async () => ({ id: 'sub_test' }) },
    webhooks: { constructEvent: () => ({ type: 'ignored' }) }
  })
};

clearReq('../routes/invoices');
const invoiceRoutes = require('../routes/invoices');

// ---------- App + request helper ------------------------------------------

function buildApp(sessionUser) {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { user: sessionUser }; next(); });
  app.use('/invoices', invoiceRoutes);
  return app;
}

function request(app, method, url, jsonBody) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const body = jsonBody != null ? JSON.stringify(jsonBody) : '';
      const headers = jsonBody != null
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        : {};
      const req = http.request({ hostname: '127.0.0.1', port, path: url, method, headers }, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          server.close();
          let parsed = null;
          try { parsed = data ? JSON.parse(data) : null; } catch (_e) { parsed = data; }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw: data });
        });
      });
      req.on('error', err => { server.close(); reject(err); });
      if (body) req.write(body);
      req.end();
    });
  });
}

function seedInvoice(overrides) {
  const inv = Object.assign({
    id: 100,
    user_id: 7,
    invoice_number: 'INV-2026-0100',
    client_name: 'Acme Corp',
    client_email: 'ap@acme.example',
    total: 250.00,
    status: 'draft',
    is_seed: false,
    public_token: 'a1b2c3d4e5f6a1b2',
    due_date: '2026-06-15T00:00:00Z',
    items: []
  }, overrides || {});
  invoicesStore.set(inv.id, inv);
  return inv;
}

function seedUser() {
  users.set(7, { id: 7, plan: 'pro', name: 'Test', email: 't@x.com' });
}

// ---------- Test runner ---------------------------------------------------

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ---- Layer 1: POST /invoices/bulk-share-intent ---------------------------

test('bulk-share-intent: rejects unknown intent (400 invalid_intent)', async () => {
  resetStore(); seedUser(); seedInvoice();
  const app = buildApp({ id: 7, plan: 'pro' });
  const res = await request(app, 'POST', '/invoices/bulk-share-intent', { ids: [100], intent: 'not-a-real-kind' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'invalid_intent');
  assert.strictEqual(shareIntentFlips.length, 0, 'no state mutation');
});

test('bulk-share-intent: rejects missing intent (400)', async () => {
  resetStore(); seedUser(); seedInvoice();
  const app = buildApp({ id: 7, plan: 'pro' });
  const res = await request(app, 'POST', '/invoices/bulk-share-intent', { ids: [100] });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'invalid_intent');
});

test('bulk-share-intent: rejects missing/empty ids (400 no_ids)', async () => {
  resetStore(); seedUser();
  const app = buildApp({ id: 7, plan: 'pro' });
  const noIds = await request(app, 'POST', '/invoices/bulk-share-intent', { intent: 'copy' });
  assert.strictEqual(noIds.status, 400);
  assert.strictEqual(noIds.body.error, 'no_ids');

  const emptyIds = await request(app, 'POST', '/invoices/bulk-share-intent', { intent: 'copy', ids: [] });
  assert.strictEqual(emptyIds.status, 400);
  assert.strictEqual(emptyIds.body.error, 'no_ids');
});

test('bulk-share-intent: caps ids array at 25 (400 too_many_ids)', async () => {
  resetStore(); seedUser();
  const app = buildApp({ id: 7, plan: 'pro' });
  const ids = [];
  for (let i = 1; i <= 26; i++) ids.push(i);
  const res = await request(app, 'POST', '/invoices/bulk-share-intent', { intent: 'copy', ids });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'too_many_ids');
  assert.strictEqual(res.body.limit, 25);
});

test('bulk-share-intent: rejects when every id is non-numeric (400 no_valid_ids)', async () => {
  resetStore(); seedUser();
  const app = buildApp({ id: 7, plan: 'pro' });
  const res = await request(app, 'POST', '/invoices/bulk-share-intent', { intent: 'copy', ids: ['abc', '', 0, -3, null] });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'no_valid_ids');
});

test('bulk-share-intent: happy path — two draft rows flip to sent, URLs come back', async () => {
  resetStore(); seedUser();
  seedInvoice({ id: 101, invoice_number: 'INV-A', total: 100, status: 'draft' });
  seedInvoice({ id: 102, invoice_number: 'INV-B', total: 200, status: 'draft' });
  const app = buildApp({ id: 7, plan: 'pro' });
  const res = await request(app, 'POST', '/invoices/bulk-share-intent', { intent: 'copy', ids: [101, 102] });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.ok, true);
  assert.strictEqual(res.body.count, 2);
  assert.strictEqual(res.body.flipped_count, 2);
  assert.strictEqual(res.body.intent, 'copy');
  assert.strictEqual(res.body.results.length, 2);
  for (const r of res.body.results) {
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.flipped, true);
    assert.strictEqual(r.status, 'sent');
    assert.ok(r.url && r.url.startsWith('https://decentinvoice.test/i/'));
    assert.ok(typeof r.invoice_number === 'string');
    assert.ok(typeof r.total === 'number');
  }
  assert.strictEqual(invoicesStore.get(101).status, 'sent');
  assert.strictEqual(invoicesStore.get(102).status, 'sent');
});

test('bulk-share-intent: fires firstSentCelebration exactly ONCE for a multi-flip batch', async () => {
  resetStore(); seedUser();
  seedInvoice({ id: 201 });
  seedInvoice({ id: 202 });
  seedInvoice({ id: 203 });
  const app = buildApp({ id: 7, plan: 'pro' });
  await request(app, 'POST', '/invoices/bulk-share-intent', { intent: 'copy', ids: [201, 202, 203] });
  // Async fire-and-forget — wait a tick.
  await new Promise(r => setTimeout(r, 20));
  assert.strictEqual(celebrations.length, 1, 'exactly one celebration call per batch — not per flipped row');
});

test('bulk-share-intent: never fires celebration when nothing flipped (all excluded)', async () => {
  resetStore(); seedUser();
  seedInvoice({ id: 301, status: 'sent' });
  seedInvoice({ id: 302, is_seed: true });
  const app = buildApp({ id: 7, plan: 'pro' });
  const res = await request(app, 'POST', '/invoices/bulk-share-intent', { intent: 'copy', ids: [301, 302] });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.flipped_count, 0);
  await new Promise(r => setTimeout(r, 20));
  assert.strictEqual(celebrations.length, 0, 'no flip → no celebration');
});

test('bulk-share-intent: cross-tenant id returns per-id error (not_found), zero mutation', async () => {
  resetStore(); seedUser();
  seedInvoice({ id: 401 });
  // A different tenant's invoice — same store, different user_id.
  invoicesStore.set(999, {
    id: 999,
    user_id: 99, // NOT session user 7
    invoice_number: 'INV-OTHER',
    total: 500,
    status: 'draft',
    is_seed: false,
    public_token: 'ff11ee22dd33ff11',
    items: []
  });
  const app = buildApp({ id: 7, plan: 'pro' });
  const res = await request(app, 'POST', '/invoices/bulk-share-intent', { intent: 'copy', ids: [401, 999] });
  assert.strictEqual(res.status, 200);
  const byId = Object.fromEntries(res.body.results.map(r => [r.id, r]));
  assert.strictEqual(byId[401].ok, true);
  assert.strictEqual(byId[401].flipped, true);
  assert.strictEqual(byId[999].ok, false);
  assert.strictEqual(byId[999].error, 'not_found', 'foreign-user id must 404 as per-id, never as 500 or state-leak');
  assert.strictEqual(invoicesStore.get(999).status, 'draft', 'foreign invoice must NOT be mutated');
});

test('bulk-share-intent: excludes seed / non-draft / no-public-token per-id', async () => {
  resetStore(); seedUser();
  seedInvoice({ id: 501, status: 'draft' });                          // ✓ ok
  seedInvoice({ id: 502, status: 'sent' });                            // ✗ not_draft
  seedInvoice({ id: 503, status: 'draft', is_seed: true });            // ✗ is_seed
  seedInvoice({ id: 504, status: 'draft', public_token: null });       // ✗ no_public_token
  seedInvoice({ id: 505, status: 'draft', public_token: 'nope!' });    // ✗ no_share_url (invalid token)
  const app = buildApp({ id: 7, plan: 'pro' });
  const res = await request(app, 'POST', '/invoices/bulk-share-intent', { intent: 'copy', ids: [501, 502, 503, 504, 505] });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.flipped_count, 1);
  const byId = Object.fromEntries(res.body.results.map(r => [r.id, r]));
  assert.strictEqual(byId[501].ok, true);
  assert.strictEqual(byId[502].ok, false); assert.strictEqual(byId[502].error, 'not_draft');
  assert.strictEqual(byId[503].ok, false); assert.strictEqual(byId[503].error, 'is_seed');
  assert.strictEqual(byId[504].ok, false); assert.strictEqual(byId[504].error, 'no_public_token');
  assert.strictEqual(byId[505].ok, false); assert.strictEqual(byId[505].error, 'no_share_url');
  // The four excluded rows must NOT have been flipped.
  assert.strictEqual(invoicesStore.get(502).status, 'sent');   // was already sent
  assert.strictEqual(invoicesStore.get(503).status, 'draft');
  assert.strictEqual(invoicesStore.get(504).status, 'draft');
  assert.strictEqual(invoicesStore.get(505).status, 'draft');
});

test('bulk-share-intent: duplicate ids in the request are de-duped', async () => {
  resetStore(); seedUser();
  seedInvoice({ id: 601 });
  const app = buildApp({ id: 7, plan: 'pro' });
  const res = await request(app, 'POST', '/invoices/bulk-share-intent', { intent: 'copy', ids: [601, 601, 601, '601'] });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.count, 1, 'dupes collapsed to one result');
  assert.strictEqual(shareIntentFlips.length, 1, 'only one flip attempted despite 4 ids in payload');
});

// ---- Layer 2: view rendering of the bulk-send bar + checkboxes ----------

const dashboardTplPath = path.join(__dirname, '..', 'views', 'dashboard.ejs');
const dashboardTpl = fs.readFileSync(dashboardTplPath, 'utf8');

function tableRow(extra) {
  return Object.assign({
    id: 11,
    invoice_number: 'INV-2026-0011',
    client_name: 'Acme Corp',
    issued_date: '2026-05-20T00:00:00Z',
    total: '500.00',
    status: 'draft',
    is_seed: false,
    public_token: 'a1b2c3d4e5f6a1b2',
    first_viewed_at: null,
    payment_claimed_at: null,
    payment_link_url: null
  }, extra || {});
}

function sendEntry(extra) {
  const url = 'https://decentinvoice.test/i/a1b2c3d4e5f6a1b2';
  return Object.assign({
    url,
    shareIntents: {
      body: "Hi Acme Corp, here's invoice INV-2026-0011 for $500.00. View it here: " + url,
      subject: 'Invoice INV-2026-0011 — $500.00',
      whatsapp: 'https://wa.me/?text=Hi%20Acme%20Corp',
      sms: 'sms:?&body=Hi%20Acme%20Corp',
      mailto: 'mailto:ap%40acme.example?subject=Invoice&body=Hi%20Acme%20Corp',
      url
    },
    directEmail: false,
    clientEmail: 'ap@acme.example'
  }, extra || {});
}

function renderDashboard(locals) {
  return ejs.render(dashboardTpl, Object.assign({
    title: 'Dashboard',
    flash: null,
    days_left_in_trial: 0,
    csrfToken: 'TEST_CSRF',
    invoices: [],
    user: { plan: 'free', invoice_count: 5, subscription_status: null },
    onboarding: null,
    invoiceLimitProgress: null,
    recentRevenue: null,
    annualUpgradePrompt: null,
    socialProof: null,
    celebration: null,
    staleDraftPrompt: null,
    paymentClaimPrompt: null,
    recentViewPrompt: null,
    clientViewedFollowupPrompt: null,
    sentNotViewedPrompt: null,
    overduePrompt: null,
    firstRealInvoicePrompt: null,
    freshDraftPrompt: null,
    repeatClientPrompt: null,
    pendingQuickInvoice: null,
    tableFollowUpIntents: {},
    tableSendIntents: {}
  }, locals), {
    views: [path.join(__dirname, '..', 'views')],
    filename: dashboardTplPath
  });
}

test('view: bulk-select bar wrapper is Alpine-scoped with bulkDraftSelector + csrfToken', () => {
  const html = renderDashboard({
    invoices: [tableRow()],
    tableSendIntents: { '11': sendEntry() }
  });
  assert.match(html, /data-testid="invoices-table-scope"/,
    'the invoices-table wrapper carries the bulk-select data-testid');
  assert.match(html, /x-data="bulkDraftSelector\('TEST_CSRF'\)"/,
    'wrapper is bound to the bulkDraftSelector factory with the request CSRF token');
});

test('view: bulk-action bar rendered inline (x-show gated on selectedIds.length)', () => {
  const html = renderDashboard({
    invoices: [tableRow()],
    tableSendIntents: { '11': sendEntry() }
  });
  assert.match(html, /data-testid="bulk-draft-send-bar"/,
    'floating action bar element is present in the DOM');
  assert.match(html, /data-testid="bulk-draft-send-copy"/,
    'Copy N links button present');
  assert.match(html, /data-testid="bulk-draft-send-clear"/,
    'Clear button present');
  // Bar must be hidden by default — assert the x-show gate is on selectedIds.length.
  const bar = html.match(/<div[^]*?data-testid="bulk-draft-send-bar"[^]*?<\/div>/);
  assert.ok(bar, 'bar block found');
  // The wrapper x-show must gate on selectedIds.length so the bar hides at 0.
  const wrapperFragment = html.slice(0, html.indexOf('data-testid="bulk-draft-send-bar"'));
  const lastXShow = wrapperFragment.lastIndexOf('x-show=');
  assert.ok(lastXShow !== -1);
  const gate = wrapperFragment.slice(lastXShow, lastXShow + 80);
  assert.ok(/selectedIds\.length\s*>\s*0/.test(gate),
    'bar is gated on selectedIds.length > 0');
});

test('view: bulk-eligible draft rows render a per-row checkbox', () => {
  const html = renderDashboard({
    invoices: [tableRow({ id: 11 }), tableRow({ id: 12, invoice_number: 'INV-2026-0012' })],
    tableSendIntents: { '11': sendEntry(), '12': sendEntry() }
  });
  assert.match(html, /data-testid="bulk-draft-select-11"/);
  assert.match(html, /data-testid="bulk-draft-checkbox-11"/);
  assert.match(html, /data-testid="bulk-draft-select-12"/);
  assert.match(html, /data-testid="bulk-draft-checkbox-12"/);
});

test('view: non-eligible rows (sent / seed / no-token) DO NOT render a checkbox', () => {
  const html = renderDashboard({
    invoices: [
      tableRow({ id: 20, status: 'sent' }),
      tableRow({ id: 21, is_seed: true }),
      tableRow({ id: 22, public_token: null }),
      tableRow({ id: 23, status: 'draft' }) // eligible — control
    ],
    tableSendIntents: { '23': sendEntry() } // server only flags the eligible row
  });
  assert.doesNotMatch(html, /data-testid="bulk-draft-checkbox-20"/, 'sent row: no checkbox');
  assert.doesNotMatch(html, /data-testid="bulk-draft-checkbox-21"/, 'seed row: no checkbox');
  assert.doesNotMatch(html, /data-testid="bulk-draft-checkbox-22"/, 'no-token row: no checkbox');
  assert.match(html, /data-testid="bulk-draft-checkbox-23"/, 'eligible draft: checkbox present (control)');
});

test('view: checkbox click stops propagation (row navigation must not fire)', () => {
  const html = renderDashboard({
    invoices: [tableRow()],
    tableSendIntents: { '11': sendEntry() }
  });
  const label = html.match(/data-testid="bulk-draft-select-11"[^]*?<\/label>/);
  assert.ok(label, 'checkbox label block located');
  // The <label> must carry onclick="event.stopPropagation()" AND the
  // inner <input> must carry Alpine's @click.stop — both are needed
  // because label + input both fire click events on a row-level onclick.
  const labelOpen = html.match(/<label[^>]*data-testid="bulk-draft-select-11"[^>]*>/);
  assert.ok(labelOpen, 'label open tag located');
  assert.match(labelOpen[0], /onclick="event\.stopPropagation\(\)"/,
    'label must stop propagation so the row onclick nav does not fire');
  assert.match(label[0], /@click\.stop/,
    'inner input must also stop-click at the Alpine layer');
});

test('view: Copy button wires to Alpine copyAllLinks() (which POSTs the bulk endpoint)', () => {
  const html = renderDashboard({
    invoices: [tableRow()],
    tableSendIntents: { '11': sendEntry() }
  });
  const copyBtn = html.match(/<button[^>]*data-testid="bulk-draft-send-copy"[^>]*>/);
  assert.ok(copyBtn, 'copy button located');
  assert.match(copyBtn[0], /@click="copyAllLinks\(\)"/,
    'copy button click handler wired to Alpine method');
});

test('view: Clear button calls Alpine clearSelection()', () => {
  const html = renderDashboard({
    invoices: [tableRow()],
    tableSendIntents: { '11': sendEntry() }
  });
  const clearBtn = html.match(/<button[^>]*data-testid="bulk-draft-send-clear"[^>]*>/);
  assert.ok(clearBtn, 'clear button located');
  assert.match(clearBtn[0], /@click="clearSelection\(\)"/,
    'clear button wired to Alpine clearSelection');
});

test('view: bulkDraftSelector factory ships inline with copy/clear/toggle/isSelected methods', () => {
  const html = renderDashboard({
    invoices: [tableRow()],
    tableSendIntents: { '11': sendEntry() }
  });
  // The factory literal must be present in a <script> tag so Alpine can call it.
  assert.match(html, /function\s+bulkDraftSelector\s*\(/,
    'bulkDraftSelector factory declared');
  // Method surface — regression guard against a refactor that renames these.
  assert.match(html, /toggle\s*\(/, 'toggle method');
  assert.match(html, /isSelected\s*\(/, 'isSelected method');
  assert.match(html, /copyAllLinks\s*\(/, 'copyAllLinks method');
  assert.match(html, /clearSelection\s*\(/, 'clearSelection method');
  // The Copy handler must POST to /invoices/bulk-share-intent with intent copy.
  assert.match(html, /fetch\('\/invoices\/bulk-share-intent'/,
    'copyAllLinks fires the bulk endpoint');
  // The payload object literal in the factory uses an unquoted `intent:` key,
  // so the regex allows either quoted or bare keys.
  assert.match(html, /(?:['"])?intent(?:['"])?\s*:\s*['"]copy['"]/,
    'intent=copy is sent on the bulk payload');
});

test('view: legacy locals (no tableSendIntents key at all) do not crash the render', () => {
  const html = renderDashboard({
    invoices: [tableRow()],
    tableSendIntents: undefined
  });
  // The wrapper still renders (bar is x-show gated) but no checkboxes appear.
  assert.match(html, /data-testid="invoices-table-scope"/);
  assert.doesNotMatch(html, /data-testid="bulk-draft-checkbox-11"/);
});

// ---------- Runner --------------------------------------------------------

(async function run() {
  let passed = 0, failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ok  ${t.name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error(err && err.stack ? err.stack : err);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed (bulk-share-intent.test.js)`);
  if (failed > 0) process.exit(1);
})();
