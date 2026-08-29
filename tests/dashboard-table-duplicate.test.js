'use strict';

/*
 * Per-row "Duplicate" inline button on the dashboard invoices table.
 *
 * Advances the 7-day activation window in PLAN.md's "Done means" — the
 * freelancer's second-invoice-onward velocity for a returning-client
 * cohort compounds with every downstream send/pay surface (celebration,
 * trial-urgency, referral, tap-to-pay).
 *
 * The existing single-target repeat-client-prompt banner surfaces exactly
 * ONE candidate at a time; the /invoices/:id invoice-view page carries the
 * Duplicate action but requires a navigation away from the dashboard. A
 * freelancer clearing out repeat work for three prior clients had to open
 * each source invoice, click Duplicate, bounce to /edit, save, come back.
 * This per-row surface collapses that path to one click per row from the
 * table view.
 *
 * Coverage (two layers):
 *
 *  - Layer 1 (view): The button renders on every non-draft, non-seed row
 *    (sent / paid / overdue) for both free and Pro / Agency users, hides
 *    on draft rows (the Send-now cluster already owns those), hides on the
 *    seed sample (its own /:id/duplicate button is the anchor for the
 *    empty-state path), and hides on free-tier accounts at the 3/3 free
 *    limit (the invoiceLimitProgress banner two rows up is the upgrade CTA
 *    for that cohort — a Duplicate button that guarantees a bounce is
 *    worse than no button at all). Form contract: action, method, CSRF
 *    hidden input, stopPropagation on click.
 *
 *  - Layer 2 (route regression): The existing POST /invoices/:id/duplicate
 *    still 302s to /invoices/<newId>/edit and bumps invoice_count — the
 *    contract this ship depends on is untouched.
 *
 * Run: NODE_ENV=test node tests/dashboard-table-duplicate.test.js
 */

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';
process.env.APP_URL = process.env.APP_URL || 'https://test.invoice.app';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');
const express = require('express');
const session = require('express-session');
const http = require('http');

const VIEWS = path.join(__dirname, '..', 'views');
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ---- Layer 1: view rendering matrix ------------------------------------

const dashboardTplPath = path.join(VIEWS, 'dashboard.ejs');
const dashboardTpl = fs.readFileSync(dashboardTplPath, 'utf8');

function tableRow(extra) {
  return Object.assign({
    id: 41,
    invoice_number: 'INV-2026-0041',
    client_name: 'Acme Corp',
    issued_date: '2026-05-20T00:00:00Z',
    total: '500.00',
    status: 'sent',
    is_seed: false,
    public_token: 'a1b2c3d4e5f6a1b2',
    first_viewed_at: null,
    payment_claimed_at: null,
    payment_link_url: null
  }, extra || {});
}

function renderDashboard(locals) {
  return ejs.render(dashboardTpl, Object.assign({
    title: 'Dashboard',
    flash: null,
    days_left_in_trial: 0,
    csrfToken: 'TEST_CSRF',
    invoices: [],
    user: { plan: 'pro', invoice_count: 5, subscription_status: 'active' },
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
    views: [VIEWS],
    filename: dashboardTplPath
  });
}

test('view: Duplicate button RENDERS on a sent row (Pro)', () => {
  const html = renderDashboard({ invoices: [tableRow({ id: 41, status: 'sent' })] });
  assert.match(html, /data-testid="table-duplicate-41"/, 'button testid must render');
  assert.match(html, /data-testid="table-duplicate-form-41"/, 'form testid must render');
});

test('view: Duplicate button RENDERS on a paid row', () => {
  const html = renderDashboard({ invoices: [tableRow({ id: 42, status: 'paid' })] });
  assert.match(html, /data-testid="table-duplicate-42"/);
});

test('view: Duplicate button RENDERS on an overdue row', () => {
  const html = renderDashboard({ invoices: [tableRow({ id: 43, status: 'overdue' })] });
  assert.match(html, /data-testid="table-duplicate-43"/);
});

test('view: Duplicate button OMITTED on a draft row (Send-now cluster owns drafts)', () => {
  const html = renderDashboard({ invoices: [tableRow({ id: 44, status: 'draft' })] });
  assert.doesNotMatch(html, /data-testid="table-duplicate-44"/);
});

test('view: Duplicate button OMITTED on the seed sample invoice', () => {
  // The seed's /invoices/:id page carries its own "Duplicate as draft" CTA
  // and the firstRealInvoicePrompt banner anchors the empty-state path.
  const html = renderDashboard({ invoices: [tableRow({ id: 45, status: 'sent', is_seed: true })] });
  assert.doesNotMatch(html, /data-testid="table-duplicate-45"/);
});

test('view: Duplicate button OMITTED on free-tier row at the 3/3 limit', () => {
  // The route bounces to /invoices?limit_hit=1 for a free user at cap.
  // A button that guarantees a bounce is worse than no button — the
  // invoiceLimitProgress banner two rows up already carries the upgrade CTA.
  const html = renderDashboard({
    user: { plan: 'free', invoice_count: 3, subscription_status: null },
    invoiceLimitProgress: { used: 3, max: 3, remaining: 0, percent: 100, atLimit: true, nearLimit: false },
    invoices: [tableRow({ id: 46, status: 'sent' })]
  });
  assert.doesNotMatch(html, /data-testid="table-duplicate-46"/);
});

test('view: Duplicate button RENDERS on free-tier row below the 3/3 limit', () => {
  const html = renderDashboard({
    user: { plan: 'free', invoice_count: 2, subscription_status: null },
    invoiceLimitProgress: { used: 2, max: 3, remaining: 1, percent: 66.67, atLimit: false, nearLimit: true },
    invoices: [tableRow({ id: 47, status: 'sent' })]
  });
  assert.match(html, /data-testid="table-duplicate-47"/);
});

test('view: Duplicate button RENDERS on Agency plan on a sent row', () => {
  const html = renderDashboard({
    user: { plan: 'agency', invoice_count: 999, subscription_status: 'active' },
    invoices: [tableRow({ id: 48, status: 'sent' })]
  });
  assert.match(html, /data-testid="table-duplicate-48"/);
});

test('view: Duplicate button RENDERS on sent row with a pending payment-claim', () => {
  // The freelancer's typical next-action on a claim row is verify + mark
  // paid, but "invoice this client again for the next job" is a valid
  // parallel action; the button must not be suppressed by the claim badge.
  const html = renderDashboard({
    invoices: [tableRow({
      id: 49, status: 'sent',
      payment_claimed_at: '2026-05-27T10:00:00Z',
      payment_claim_method: 'venmo'
    })]
  });
  assert.match(html, /data-testid="client-payment-claim-49"/, 'claim badge renders');
  assert.match(html, /data-testid="table-duplicate-49"/, 'duplicate still renders');
});

test('view: form posts to /invoices/:id/duplicate with CSRF hidden input', () => {
  const html = renderDashboard({ invoices: [tableRow({ id: 51, status: 'paid' })] });
  const form = html.match(/<form\s[^>]*data-testid="table-duplicate-form-51"[^>]*>[\s\S]{0,800}<\/form>/);
  assert.ok(form, 'duplicate form located in markup');
  assert.match(form[0], /action="\/invoices\/51\/duplicate"/);
  assert.match(form[0], /method="POST"/);
  assert.match(form[0], /name="_csrf"\s+value="TEST_CSRF"/);
});

test('view: form click does NOT bubble to the row navigation handler', () => {
  // The <tr> carries onclick="window.location='/invoices/<id>'" — a click
  // on the duplicate form must POST without first navigating away.
  const html = renderDashboard({ invoices: [tableRow({ id: 52, status: 'overdue' })] });
  const form = html.match(/<form\s[^>]*data-testid="table-duplicate-form-52"[^>]*>/);
  assert.ok(form);
  assert.match(form[0], /onclick="event\.stopPropagation\(\)"/);
});

test('view: form carries print:hidden so it does not leak into print/PDF', () => {
  const html = renderDashboard({ invoices: [tableRow({ id: 53, status: 'sent' })] });
  const form = html.match(/<form\s[^>]*data-testid="table-duplicate-form-53"[^>]*>/);
  assert.ok(form);
  assert.match(form[0], /print:hidden/);
});

test('view: multiple non-draft rows each get their own Duplicate form; drafts and seed do not', () => {
  const html = renderDashboard({
    invoices: [
      tableRow({ id: 61, status: 'sent', invoice_number: 'INV-A' }),
      tableRow({ id: 62, status: 'overdue', invoice_number: 'INV-B' }),
      tableRow({ id: 63, status: 'paid', invoice_number: 'INV-C' }),
      tableRow({ id: 64, status: 'draft', invoice_number: 'INV-D' }),
      tableRow({ id: 65, status: 'sent', is_seed: true, invoice_number: 'INV-SEED' })
    ]
  });
  assert.match(html, /data-testid="table-duplicate-61"/, 'sent row has button');
  assert.match(html, /data-testid="table-duplicate-62"/, 'overdue row has button');
  assert.match(html, /data-testid="table-duplicate-63"/, 'paid row has button');
  assert.doesNotMatch(html, /data-testid="table-duplicate-64"/, 'draft row omitted');
  assert.doesNotMatch(html, /data-testid="table-duplicate-65"/, 'seed row omitted');
});

test('view: button copy names the action for accessibility (label + title tooltip)', () => {
  const html = renderDashboard({ invoices: [tableRow({ id: 71, status: 'sent' })] });
  const button = html.match(/<button\s[^>]*data-testid="table-duplicate-71"[^>]*>[\s\S]{0,300}<\/button>/);
  assert.ok(button, 'duplicate button located in markup');
  assert.match(button[0], /Duplicate/, 'visible label reads Duplicate');
  assert.match(button[0], /title="[^"]*fresh draft/i, 'tooltip explains the outcome');
});

test('view: Mark paid form still renders on the same sent row (no cluster regression)', () => {
  // Defence-in-depth: the new Duplicate block sits directly below the
  // Mark-paid form for sent/overdue rows. A future refactor that
  // accidentally swallows the mark-paid form would silently regress M4.
  const html = renderDashboard({ invoices: [tableRow({ id: 72, status: 'sent' })] });
  assert.match(html, /data-testid="table-mark-paid-72"/, 'mark-paid still renders');
  assert.match(html, /data-testid="table-duplicate-72"/, 'duplicate renders too');
});

// ---- Layer 2: route regression -----------------------------------------

// In-memory stores keyed for the duplicate route's dependencies.
let userStore = {};
let invoiceStore = {};
let duplicateCalls = [];
let nextInvoiceIdCounter = 200;

function installInvoiceStubs() {
  const stub = {
    pool: { query: async () => ({ rows: [] }) },
    db: {
      async getUserById(id) { return userStore[id] || null; },
      async getInvoiceById(id, userId) {
        const inv = invoiceStore[parseInt(id, 10)];
        if (!inv || inv.user_id !== userId) return null;
        return inv;
      },
      async getInvoicesByUser(userId) {
        return Object.values(invoiceStore).filter(i => i.user_id === userId);
      },
      async getNextInvoiceNumber() {
        return 'INV-2026-0099';
      },
      async duplicateInvoice(sourceId, userId, opts) {
        duplicateCalls.push({ sourceId, userId, opts });
        const src = invoiceStore[parseInt(sourceId, 10)];
        if (!src || src.user_id !== userId) return null;
        const id = ++nextInvoiceIdCounter;
        const dup = { ...src, id, status: 'draft', is_seed: false,
          invoice_number: opts.invoice_number,
          issued_date: opts.issued_date, due_date: opts.due_date };
        invoiceStore[id] = dup;
        return dup;
      }
    }
  };
  require.cache[require.resolve('../db')] = {
    id: require.resolve('../db'),
    filename: require.resolve('../db'),
    loaded: true,
    exports: stub
  };
  delete require.cache[require.resolve('../routes/invoices')];
  return require('../routes/invoices');
}

function buildInvoiceApp(sessionUser) {
  const invoiceRoutes = installInvoiceStubs();
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', VIEWS);
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, _res, next) => { if (sessionUser) req.session.user = sessionUser; next(); });
  app.use((req, res, next) => { res.locals.user = sessionUser || null; next(); });
  app.use('/invoices', invoiceRoutes);
  return app;
}

function postForm(app, url, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const payload = new URLSearchParams(body || {}).toString();
      const req = http.request({
        hostname: '127.0.0.1', port, path: url, method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => server.close(() => resolve({ status: res.statusCode, headers: res.headers, body: data })));
      });
      req.on('error', e => { server.close(); reject(e); });
      req.write(payload);
      req.end();
    });
  });
}

function resetRouteStores() {
  userStore = {};
  invoiceStore = {};
  duplicateCalls = [];
  nextInvoiceIdCounter = 200;
}

test('route: happy path — POST /:id/duplicate on a sent row 302s to /invoices/:newId/edit', async () => {
  resetRouteStores();
  userStore[7] = { id: 7, email: 'a@x.com', name: 'A', plan: 'pro', invoice_count: 12 };
  invoiceStore[81] = {
    id: 81, user_id: 7, invoice_number: 'INV-9', client_name: 'Acme',
    client_email: 'acme@x.example', total: '750.00', status: 'sent',
    is_seed: false, public_token: 'tok81', items: []
  };
  const app = buildInvoiceApp({ id: 7, plan: 'pro', invoice_count: 12 });
  const r = await postForm(app, '/invoices/81/duplicate', {});
  assert.strictEqual(r.status, 302);
  assert.match(r.headers.location, /^\/invoices\/\d+\/edit$/,
    'duplicate must 302 to the new draft edit page');
  assert.strictEqual(duplicateCalls.length, 1, 'duplicateInvoice called once');
  assert.strictEqual(duplicateCalls[0].sourceId, invoiceStore[81].id);
  assert.strictEqual(duplicateCalls[0].userId, 7);
});

test('route: free-tier at cap bounces to /invoices?limit_hit=1 and does NOT call duplicate', async () => {
  resetRouteStores();
  userStore[7] = { id: 7, plan: 'free', invoice_count: 3 };
  invoiceStore[82] = {
    id: 82, user_id: 7, invoice_number: 'INV-10', client_name: 'Beta',
    total: '200.00', status: 'paid', is_seed: false, items: []
  };
  const app = buildInvoiceApp({ id: 7, plan: 'free', invoice_count: 3 });
  const r = await postForm(app, '/invoices/82/duplicate', {});
  assert.strictEqual(r.status, 302);
  assert.strictEqual(r.headers.location, '/invoices?limit_hit=1');
  assert.strictEqual(duplicateCalls.length, 0, 'free-tier cap must short-circuit before duplicate call');
});

// ---- Run ----------------------------------------------------------------

(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log(`  ok  ${t.name}`);
    } catch (err) {
      failed++;
      console.error(`  FAIL ${t.name}`);
      console.error(err && err.stack ? err.stack : err);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed (dashboard-table-duplicate.test.js)`);
  if (failed > 0) process.exit(1);
})();
