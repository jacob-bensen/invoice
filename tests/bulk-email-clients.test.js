'use strict';

/*
 * Bulk "Email now" on the dashboard invoices table (Pro/Agency — Milestone 3:
 * first invoice created → first invoice sent). Coverage across two layers:
 *
 * Layer 1 — routes/invoices.js: POST /invoices/bulk-email-clients.
 *   Pro/Agency-gated batch that, per selected id, applies the same
 *   ownership + non-seed + draft-only gate as /:id/email-client before
 *   calling sendInvoiceEmail() and then atomically flipping draft → sent.
 *   Per-id `no_client_email` returns a per-id error rather than aborting
 *   the batch. Ids capped at 25. First-sent celebration fires once for
 *   the whole batch (idempotent at the SQL layer).
 *
 * Layer 2 — views/dashboard.ejs: bulk-select bar "Email N clients now"
 *   button (Pro/Agency-only) + bulkDraftSelector.emailAllClients() Alpine
 *   method that POSTs the batch to /invoices/bulk-email-clients.
 *
 * Run: NODE_ENV=test node tests/bulk-email-clients.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');
const express = require('express');
const http = require('http');

process.env.APP_URL = process.env.APP_URL || 'https://decentinvoice.test';
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

// ---------- Stub the db + email + celebration modules --------------------

function clearReq(mod) { delete require.cache[require.resolve(mod)]; }

const users = new Map();
const invoicesStore = new Map();
const shareIntentFlips = [];
const celebrations = [];
const emailSendCalls = [];
let emailSendImpl = async () => ({ ok: true, id: 'em_ok' });

function resetStore() {
  users.clear();
  invoicesStore.clear();
  shareIntentFlips.length = 0;
  celebrations.length = 0;
  emailSendCalls.length = 0;
  emailSendImpl = async () => ({ ok: true, id: 'em_ok' });
}

const dbStub = {
  pool: { query: async () => ({ rows: [] }) },
  db: {
    async getUserById(id) { return users.get(id) || null; },
    async getInvoiceById(id, userId) {
      const inv = invoicesStore.get(parseInt(id, 10));
      if (!inv || inv.user_id !== userId) return null;
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
    async deleteInvoice() { throw new Error('unused'); }
  }
};

require.cache[require.resolve('../db')] = {
  id: require.resolve('../db'),
  filename: require.resolve('../db'),
  loaded: true,
  exports: dbStub
};

// Load the real email lib once, then wrap sendInvoiceEmail with a spy that
// delegates to the current emailSendImpl. Other exports (subject/html/text
// builders) stay real so the route can still reference them if needed.
clearReq('../lib/email');
const realEmailLib = require('../lib/email');
const emailStub = Object.assign({}, realEmailLib, {
  sendInvoiceEmail: async (invoice, owner) => {
    emailSendCalls.push({ invoice_id: invoice ? invoice.id : null, owner_id: owner ? owner.id : null, to: invoice ? invoice.client_email : null });
    return emailSendImpl(invoice, owner);
  }
});
require.cache[require.resolve('../lib/email')] = {
  id: require.resolve('../lib/email'),
  filename: require.resolve('../lib/email'),
  loaded: true,
  exports: emailStub
};

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

function seedProUser() {
  users.set(7, { id: 7, plan: 'pro', name: 'Test', email: 't@x.com' });
}

function seedAgencyUser() {
  users.set(7, { id: 7, plan: 'agency', name: 'Test', email: 't@x.com' });
}

function seedFreeUser() {
  users.set(7, { id: 7, plan: 'free', name: 'Test', email: 't@x.com' });
}

// ---------- Test runner ---------------------------------------------------

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ---- Layer 1: POST /invoices/bulk-email-clients --------------------------

test('bulk-email-clients: 401 when getUserById returns null', async () => {
  resetStore();
  const app = buildApp({ id: 999 }); // no user seeded
  const res = await request(app, 'POST', '/invoices/bulk-email-clients', { ids: [100] });
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.body.error, 'unauthorized');
  assert.strictEqual(emailSendCalls.length, 0, 'no email attempted for unknown user');
});

test('bulk-email-clients: 402 plan_locked for free users (no side effects)', async () => {
  resetStore(); seedFreeUser(); seedInvoice({ id: 100 });
  const app = buildApp({ id: 7 });
  const res = await request(app, 'POST', '/invoices/bulk-email-clients', { ids: [100] });
  assert.strictEqual(res.status, 402);
  assert.strictEqual(res.body.error, 'plan_locked');
  assert.strictEqual(emailSendCalls.length, 0,
    'free plan must NOT trigger any email — Resend quota is not for free tier');
  assert.strictEqual(shareIntentFlips.length, 0,
    'free plan must NOT flip any invoice status');
  assert.strictEqual(invoicesStore.get(100).status, 'draft');
});

test('bulk-email-clients: 400 no_ids when body has no ids array', async () => {
  resetStore(); seedProUser();
  const app = buildApp({ id: 7 });
  const missing = await request(app, 'POST', '/invoices/bulk-email-clients', {});
  assert.strictEqual(missing.status, 400);
  assert.strictEqual(missing.body.error, 'no_ids');
  const empty = await request(app, 'POST', '/invoices/bulk-email-clients', { ids: [] });
  assert.strictEqual(empty.status, 400);
  assert.strictEqual(empty.body.error, 'no_ids');
});

test('bulk-email-clients: caps ids at 25 (400 too_many_ids)', async () => {
  resetStore(); seedProUser();
  const app = buildApp({ id: 7 });
  const ids = [];
  for (let i = 1; i <= 26; i++) ids.push(i);
  const res = await request(app, 'POST', '/invoices/bulk-email-clients', { ids });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'too_many_ids');
  assert.strictEqual(res.body.limit, 25);
  assert.strictEqual(emailSendCalls.length, 0);
});

test('bulk-email-clients: rejects when every id is non-numeric (400 no_valid_ids)', async () => {
  resetStore(); seedProUser();
  const app = buildApp({ id: 7 });
  const res = await request(app, 'POST', '/invoices/bulk-email-clients', { ids: ['abc', '', 0, -3, null] });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'no_valid_ids');
});

test('bulk-email-clients: happy path — two Pro drafts email-sent + flipped to sent', async () => {
  resetStore(); seedProUser();
  seedInvoice({ id: 101, invoice_number: 'INV-A', total: 100, client_email: 'a@x.example', status: 'draft' });
  seedInvoice({ id: 102, invoice_number: 'INV-B', total: 200, client_email: 'b@x.example', status: 'draft' });
  emailSendImpl = async () => ({ ok: true, id: 'em_happy' });
  const app = buildApp({ id: 7 });
  const res = await request(app, 'POST', '/invoices/bulk-email-clients', { ids: [101, 102] });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.ok, true);
  assert.strictEqual(res.body.count, 2);
  assert.strictEqual(res.body.sent_count, 2);
  assert.strictEqual(res.body.flipped_count, 2);
  assert.strictEqual(res.body.results.length, 2);
  const byId = Object.fromEntries(res.body.results.map(r => [r.id, r]));
  assert.strictEqual(byId[101].ok, true);
  assert.strictEqual(byId[101].flipped, true);
  assert.strictEqual(byId[101].status, 'sent');
  assert.strictEqual(byId[101].sent_to, 'a@x.example');
  assert.strictEqual(byId[101].message_id, 'em_happy');
  assert.strictEqual(byId[102].sent_to, 'b@x.example');
  assert.strictEqual(emailSendCalls.length, 2, 'sendInvoiceEmail fires exactly once per id');
  assert.strictEqual(invoicesStore.get(101).status, 'sent');
  assert.strictEqual(invoicesStore.get(102).status, 'sent');
  assert.ok(/no-store/i.test(res.headers['cache-control'] || ''),
    'response carries Cache-Control: no-store');
});

test('bulk-email-clients: Agency parity — plan=agency also accepted', async () => {
  resetStore(); seedAgencyUser();
  seedInvoice({ id: 111, client_email: 'x@x.example' });
  emailSendImpl = async () => ({ ok: true, id: 'em_ag' });
  const app = buildApp({ id: 7 });
  const res = await request(app, 'POST', '/invoices/bulk-email-clients', { ids: [111] });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.sent_count, 1);
  assert.strictEqual(res.body.flipped_count, 1);
  assert.strictEqual(emailSendCalls.length, 1);
});

test('bulk-email-clients: fires firstSentCelebration exactly ONCE for a multi-flip batch', async () => {
  resetStore(); seedProUser();
  seedInvoice({ id: 201, client_email: 'a@x.example' });
  seedInvoice({ id: 202, client_email: 'b@x.example' });
  seedInvoice({ id: 203, client_email: 'c@x.example' });
  const app = buildApp({ id: 7 });
  await request(app, 'POST', '/invoices/bulk-email-clients', { ids: [201, 202, 203] });
  await new Promise(r => setTimeout(r, 20));
  assert.strictEqual(celebrations.length, 1,
    'exactly one celebration call per batch, not per flipped row');
  assert.strictEqual(celebrations[0].invoice_id, 201,
    'celebration fires on the first-flipped invoice of the batch');
});

test('bulk-email-clients: never fires celebration when nothing flipped (all excluded)', async () => {
  resetStore(); seedProUser();
  seedInvoice({ id: 301, status: 'sent', client_email: 'a@x.example' });
  seedInvoice({ id: 302, is_seed: true, client_email: 'b@x.example' });
  const app = buildApp({ id: 7 });
  const res = await request(app, 'POST', '/invoices/bulk-email-clients', { ids: [301, 302] });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.flipped_count, 0);
  assert.strictEqual(res.body.sent_count, 0);
  await new Promise(r => setTimeout(r, 20));
  assert.strictEqual(celebrations.length, 0, 'no flip → no celebration');
  assert.strictEqual(emailSendCalls.length, 0,
    'excluded rows must NOT waste Resend quota');
});

test('bulk-email-clients: cross-tenant id returns per-id not_found — no email, no leak', async () => {
  resetStore(); seedProUser();
  seedInvoice({ id: 401, client_email: 'me@x.example' });
  invoicesStore.set(999, {
    id: 999,
    user_id: 99, // NOT session user 7
    invoice_number: 'INV-OTHER',
    client_email: 'other@x.example',
    total: 500,
    status: 'draft',
    is_seed: false,
    public_token: 'ff11ee22dd33ff11',
    items: []
  });
  const app = buildApp({ id: 7 });
  const res = await request(app, 'POST', '/invoices/bulk-email-clients', { ids: [401, 999] });
  assert.strictEqual(res.status, 200);
  const byId = Object.fromEntries(res.body.results.map(r => [r.id, r]));
  assert.strictEqual(byId[401].ok, true);
  assert.strictEqual(byId[999].ok, false);
  assert.strictEqual(byId[999].error, 'not_found');
  assert.strictEqual(invoicesStore.get(999).status, 'draft',
    'foreign invoice must NOT be mutated');
  // Only the owned invoice may hit sendInvoiceEmail.
  assert.strictEqual(emailSendCalls.length, 1);
  assert.strictEqual(emailSendCalls[0].invoice_id, 401);
});

test('bulk-email-clients: excludes seed / non-draft / no-client-email per-id', async () => {
  resetStore(); seedProUser();
  seedInvoice({ id: 501, status: 'draft', client_email: 'a@x.example' });     // ✓ ok
  seedInvoice({ id: 502, status: 'sent', client_email: 'b@x.example' });      // ✗ not_draft
  seedInvoice({ id: 503, status: 'draft', is_seed: true, client_email: 'c@x.example' }); // ✗ is_seed
  seedInvoice({ id: 504, status: 'draft', client_email: null });              // ✗ no_client_email
  seedInvoice({ id: 505, status: 'draft', client_email: '' });                // ✗ no_client_email
  const app = buildApp({ id: 7 });
  const res = await request(app, 'POST', '/invoices/bulk-email-clients', { ids: [501, 502, 503, 504, 505] });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.sent_count, 1);
  assert.strictEqual(res.body.flipped_count, 1);
  const byId = Object.fromEntries(res.body.results.map(r => [r.id, r]));
  assert.strictEqual(byId[501].ok, true);
  assert.strictEqual(byId[502].ok, false); assert.strictEqual(byId[502].error, 'not_draft');
  assert.strictEqual(byId[503].ok, false); assert.strictEqual(byId[503].error, 'is_seed');
  assert.strictEqual(byId[504].ok, false); assert.strictEqual(byId[504].error, 'no_client_email');
  assert.strictEqual(byId[505].ok, false); assert.strictEqual(byId[505].error, 'no_client_email');
  assert.strictEqual(invoicesStore.get(502).status, 'sent');
  assert.strictEqual(invoicesStore.get(503).status, 'draft');
  assert.strictEqual(invoicesStore.get(504).status, 'draft');
  assert.strictEqual(invoicesStore.get(505).status, 'draft');
  assert.strictEqual(emailSendCalls.length, 1,
    'only the eligible row triggers sendInvoiceEmail — excluded rows must not consume Resend quota');
});

test('bulk-email-clients: duplicate ids collapse to one send + one flip', async () => {
  resetStore(); seedProUser();
  seedInvoice({ id: 601, client_email: 'a@x.example' });
  const app = buildApp({ id: 7 });
  const res = await request(app, 'POST', '/invoices/bulk-email-clients', { ids: [601, 601, 601, '601'] });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.count, 1);
  assert.strictEqual(res.body.sent_count, 1);
  assert.strictEqual(emailSendCalls.length, 1);
  assert.strictEqual(shareIntentFlips.length, 1);
});

test('bulk-email-clients: send failure is per-id (send_failed) — status NOT flipped', async () => {
  resetStore(); seedProUser();
  seedInvoice({ id: 701, client_email: 'ok@x.example' });
  seedInvoice({ id: 702, client_email: 'bad@x.example' });
  emailSendImpl = async (invoice) => {
    if (invoice.id === 702) return { ok: false, reason: 'not_configured' };
    return { ok: true, id: 'em_ok_701' };
  };
  const app = buildApp({ id: 7 });
  const res = await request(app, 'POST', '/invoices/bulk-email-clients', { ids: [701, 702] });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.sent_count, 1);
  assert.strictEqual(res.body.flipped_count, 1);
  const byId = Object.fromEntries(res.body.results.map(r => [r.id, r]));
  assert.strictEqual(byId[701].ok, true);
  assert.strictEqual(byId[701].flipped, true);
  assert.strictEqual(byId[702].ok, false);
  assert.strictEqual(byId[702].error, 'not_configured',
    'send-lib reason propagates as the per-id error string');
  assert.strictEqual(invoicesStore.get(701).status, 'sent');
  assert.strictEqual(invoicesStore.get(702).status, 'draft',
    'a failed send must NOT flip status — the client never got the email');
});

test('bulk-email-clients: throwing sendInvoiceEmail is caught per-id and does not abort batch', async () => {
  resetStore(); seedProUser();
  seedInvoice({ id: 801, client_email: 'ok@x.example' });
  seedInvoice({ id: 802, client_email: 'boom@x.example' });
  seedInvoice({ id: 803, client_email: 'ok3@x.example' });
  emailSendImpl = async (invoice) => {
    if (invoice.id === 802) throw new Error('network down');
    return { ok: true, id: 'em_x' };
  };
  const app = buildApp({ id: 7 });
  const res = await request(app, 'POST', '/invoices/bulk-email-clients', { ids: [801, 802, 803] });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.sent_count, 2,
    'the throwing row is skipped, but the batch continues to the next id');
  const byId = Object.fromEntries(res.body.results.map(r => [r.id, r]));
  assert.strictEqual(byId[801].ok, true);
  assert.strictEqual(byId[802].ok, false);
  assert.strictEqual(byId[802].error, 'send_failed');
  assert.strictEqual(byId[803].ok, true);
  assert.strictEqual(invoicesStore.get(802).status, 'draft');
});

test('bulk-email-clients: idempotent re-send — already-sent invoice returns not_draft (no double flip)', async () => {
  resetStore(); seedProUser();
  seedInvoice({ id: 901, status: 'sent', client_email: 'a@x.example' });
  const app = buildApp({ id: 7 });
  const res = await request(app, 'POST', '/invoices/bulk-email-clients', { ids: [901] });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.flipped_count, 0);
  assert.strictEqual(res.body.sent_count, 0);
  const byId = Object.fromEntries(res.body.results.map(r => [r.id, r]));
  assert.strictEqual(byId[901].ok, false);
  assert.strictEqual(byId[901].error, 'not_draft',
    'sent invoices excluded — bulk-email is the create→sent transition, not a "re-send" surface');
  assert.strictEqual(byId[901].status, 'sent');
});

test('bulk-email-clients: BULK_EMAIL_CLIENTS_MAX constant is exported (regression guard)', () => {
  assert.strictEqual(invoiceRoutes.BULK_EMAIL_CLIENTS_MAX, 25,
    'the cap is a named export so ops tooling / tests can see it');
});

// ---- Layer 2: view rendering of the "Email N clients" button ------------

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
    directEmail: true,
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
    user: { plan: 'pro', invoice_count: 5, subscription_status: null },
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

test('view: Pro user sees the "Email N clients now" button in the bulk-select bar', () => {
  const html = renderDashboard({
    user: { plan: 'pro', invoice_count: 5, subscription_status: null },
    invoices: [tableRow()],
    tableSendIntents: { '11': sendEntry() }
  });
  assert.match(html, /data-testid="bulk-draft-send-email"/,
    'the Email button is rendered for Pro users');
  const btn = html.match(/<button[^>]*data-testid="bulk-draft-send-email"[^>]*>/);
  assert.ok(btn, 'button open tag located');
  assert.match(btn[0], /@click="emailAllClients\(\)"/,
    'button click handler wired to Alpine emailAllClients()');
  assert.match(btn[0], /x-bind:disabled="busy"/,
    'button is disabled while busy so re-clicks do not double-fire');
});

test('view: Agency user also sees the "Email N clients now" button (parity with Pro)', () => {
  const html = renderDashboard({
    user: { plan: 'agency', invoice_count: 5, subscription_status: null },
    invoices: [tableRow()],
    tableSendIntents: { '11': sendEntry() }
  });
  assert.match(html, /data-testid="bulk-draft-send-email"/,
    'the Email button also renders for Agency users');
});

test('view: free user does NOT see the "Email N clients" button (Copy button still present)', () => {
  const html = renderDashboard({
    user: { plan: 'free', invoice_count: 5, subscription_status: null },
    invoices: [tableRow()],
    tableSendIntents: { '11': sendEntry() }
  });
  assert.doesNotMatch(html, /data-testid="bulk-draft-send-email"/,
    'free tier must NOT see the pro/agency-gated Email button');
  // Sanity check: the free-tier copy-link button IS still rendered.
  assert.match(html, /data-testid="bulk-draft-send-copy"/,
    'the Copy button is plan-agnostic and still renders for free users');
});

test('view: bulkDraftSelector factory carries the emailAllClients method + emailed flag', () => {
  const html = renderDashboard({
    user: { plan: 'pro', invoice_count: 5, subscription_status: null },
    invoices: [tableRow()],
    tableSendIntents: { '11': sendEntry() }
  });
  assert.match(html, /emailAllClients\s*\(/, 'emailAllClients method declared');
  assert.match(html, /emailed\s*:\s*false/, 'emailed reactive flag initialised in factory');
  assert.match(html, /fetch\('\/invoices\/bulk-email-clients'/,
    'emailAllClients POSTs the bulk email endpoint');
});

test('view: emailAllClients POST payload carries the selected ids AND the CSRF token', () => {
  const html = renderDashboard({
    user: { plan: 'pro', invoice_count: 5, subscription_status: null },
    invoices: [tableRow()],
    tableSendIntents: { '11': sendEntry() }
  });
  // The @click="emailAllClients()" attribute appears first in the DOM;
  // locate the actual factory method definition inside the <script> block
  // by searching after the bulkDraftSelector factory declaration.
  const factoryStart = html.indexOf('function bulkDraftSelector');
  assert.ok(factoryStart !== -1, 'bulkDraftSelector factory declaration found');
  const factory = html.slice(factoryStart);
  const methodStart = factory.indexOf('emailAllClients(');
  assert.ok(methodStart !== -1, 'emailAllClients method found inside the factory');
  const tail = factory.slice(methodStart, methodStart + 2200);
  assert.match(tail, /'X-CSRF-Token'\s*:\s*self\.csrfToken/,
    'CSRF token header attached (matches copyAllLinks pattern)');
  assert.match(tail, /ids\s*:\s*this\.selectedIds\.slice\(\)/,
    'payload carries a slice of selectedIds so the request is a stable snapshot');
  assert.match(tail, /fetch\('\/invoices\/bulk-email-clients'/,
    'method still targets the bulk-email-clients endpoint from inside the factory');
});

test('view: legacy locals (free plan, no tableSendIntents) render without crashing + without the Email button', () => {
  const html = renderDashboard({
    user: { plan: 'free', invoice_count: 5, subscription_status: null },
    invoices: [tableRow()],
    tableSendIntents: undefined
  });
  assert.match(html, /data-testid="invoices-table-scope"/);
  assert.doesNotMatch(html, /data-testid="bulk-draft-send-email"/);
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
  console.log(`\n${passed} passed, ${failed} failed (bulk-email-clients.test.js)`);
  if (failed > 0) process.exit(1);
})();
