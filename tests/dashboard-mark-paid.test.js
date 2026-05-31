'use strict';

/*
 * Per-row "Mark paid" inline button on the dashboard invoices table
 * (Milestone 4 — first invoice sent → first payment received).
 *
 * The existing single-banner prompt stack (recentView /
 * clientViewedFollowup / sentNotViewed / overdue / paymentClaim) only
 * surfaces ONE qualifying invoice at a time — the oldest in each cohort.
 * Freelancers with multiple open unpaid invoices had to navigate into
 * /invoices/:id to mark each one paid. This ship adds a per-row "✓ Mark
 * paid" button on every non-seed sent/overdue row so they can chain
 * mark-paid actions straight from the dashboard. Each flip fires the
 * paid-receipt email to the client + first-paid celebration + outbound
 * webhook (close-the-loop event for M4).
 *
 * `return_to=/invoices` keeps the freelancer on the dashboard after the
 * flip; the route-side regex is the same shape as the
 * /billing/payment-instructions return_to whitelist (defence-in-depth
 * against open-redirect tampering).
 *
 * Run: NODE_ENV=test node tests/dashboard-mark-paid.test.js
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

// ---- Layer 1: view renders the inline form on qualifying rows ----------

const dashboardTplPath = path.join(VIEWS, 'dashboard.ejs');
const dashboardTpl = fs.readFileSync(dashboardTplPath, 'utf8');

function tableRow(extra) {
  return Object.assign({
    id: 11,
    invoice_number: 'INV-2026-0011',
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
    tableFollowUpIntents: {}
  }, locals), {
    views: [VIEWS],
    filename: dashboardTplPath
  });
}

test('view: Mark paid button RENDERS on a sent row', () => {
  const html = renderDashboard({ invoices: [tableRow({ id: 11, status: 'sent' })] });
  assert.match(html, /data-testid="table-mark-paid-11"/);
  assert.match(html, /data-testid="table-mark-paid-form-11"/);
});

test('view: Mark paid button RENDERS on an overdue row', () => {
  const html = renderDashboard({ invoices: [tableRow({ id: 12, status: 'overdue' })] });
  assert.match(html, /data-testid="table-mark-paid-12"/);
});

test('view: Mark paid button RENDERS on a sent row with a pending payment-claim (highest-leverage case)', () => {
  // When the client has clicked "I've sent payment" on the public page,
  // the row carries the amber "Client reports paid via Venmo" badge —
  // the freelancer's typical next action is verify + mark paid. The
  // reminder cluster is suppressed on showClaim rows; the mark-paid
  // button is NOT, because mark-paid is exactly the right next action.
  const html = renderDashboard({
    invoices: [tableRow({
      id: 13, status: 'sent',
      payment_claimed_at: '2026-05-27T10:00:00Z',
      payment_claim_method: 'venmo'
    })]
  });
  assert.match(html, /data-testid="client-payment-claim-13"/, 'claim badge renders');
  assert.match(html, /data-testid="table-mark-paid-13"/, 'mark-paid still renders');
});

test('view: Mark paid button OMITTED on a draft row', () => {
  const html = renderDashboard({ invoices: [tableRow({ id: 14, status: 'draft' })] });
  assert.doesNotMatch(html, /data-testid="table-mark-paid-14"/);
});

test('view: Mark paid button OMITTED on a paid row', () => {
  const html = renderDashboard({ invoices: [tableRow({ id: 15, status: 'paid' })] });
  assert.doesNotMatch(html, /data-testid="table-mark-paid-15"/);
});

test('view: Mark paid button OMITTED on the seed sample invoice', () => {
  // The seed invoice never participates in the activation funnel — it's
  // a tutorial row, not a real unpaid invoice. Marking it paid would
  // fire the paid-receipt email to whatever stub address the seed
  // carries (none, today), which is a footgun we'd rather not arm.
  const html = renderDashboard({ invoices: [tableRow({ id: 16, status: 'sent', is_seed: true })] });
  assert.doesNotMatch(html, /data-testid="table-mark-paid-16"/);
});

test('view: form posts to /invoices/:id/status with CSRF + status=paid + return_to=/invoices', () => {
  const html = renderDashboard({ invoices: [tableRow({ id: 17, status: 'sent' })] });
  // Capture the form element opening tag — attributes can be in any order.
  const form = html.match(/<form\s[^>]*data-testid="table-mark-paid-form-17"[^>]*>[\s\S]{0,800}<\/form>/);
  assert.ok(form, 'mark-paid form located in markup');
  assert.match(form[0], /action="\/invoices\/17\/status"/);
  assert.match(form[0], /method="POST"/);
  assert.match(form[0], /name="_csrf"\s+value="TEST_CSRF"/);
  assert.match(form[0], /name="status"\s+value="paid"/);
  assert.match(form[0], /name="return_to"\s+value="\/invoices"/);
});

test('view: form click does NOT bubble to the row navigation handler', () => {
  // The <tr> carries onclick="window.location='/invoices/<id>'"; a click
  // on the mark-paid form must NOT navigate the user away before the
  // POST fires. The form carries onclick="event.stopPropagation()" so
  // the browser's <tr> handler never sees the click.
  const html = renderDashboard({ invoices: [tableRow({ id: 18, status: 'sent' })] });
  const form = html.match(/<form\s[^>]*data-testid="table-mark-paid-form-18"[^>]*>/);
  assert.ok(form);
  assert.match(form[0], /onclick="event\.stopPropagation\(\)"/);
});

test('view: form carries print:hidden so it does not leak into print/PDF', () => {
  const html = renderDashboard({ invoices: [tableRow({ id: 19, status: 'sent' })] });
  const form = html.match(/<form\s[^>]*data-testid="table-mark-paid-form-19"[^>]*>/);
  assert.ok(form);
  assert.match(form[0], /print:hidden/);
});

test('view: multiple sent rows each get their own mark-paid form', () => {
  const html = renderDashboard({
    invoices: [
      tableRow({ id: 21, status: 'sent', invoice_number: 'INV-A' }),
      tableRow({ id: 22, status: 'overdue', invoice_number: 'INV-B' }),
      tableRow({ id: 23, status: 'paid', invoice_number: 'INV-C' })
    ]
  });
  assert.match(html, /data-testid="table-mark-paid-21"/);
  assert.match(html, /data-testid="table-mark-paid-22"/);
  assert.doesNotMatch(html, /data-testid="table-mark-paid-23"/, 'paid row never gets the button');
});

// ---- Layer 2: route — return_to handling, paid-flip side-effects -------

// In-memory stores.
let userStore = {};
let invoiceStore = {};
let paidCelebrationCalls = [];
let paidReceiptCalls = [];
let webhookCalls = [];

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
      async updateInvoiceStatus(id, userId, status) {
        const inv = invoiceStore[parseInt(id, 10)];
        if (!inv || inv.user_id !== userId) return null;
        inv.status = status;
        return inv;
      },
      async setInvoicePaymentLink() { return null; },
      async markInvoicePaidByPaymentLinkId() { return null; }
    }
  };
  require.cache[require.resolve('../db')] = {
    id: require.resolve('../db'),
    filename: require.resolve('../db'),
    loaded: true,
    exports: stub
  };
  require.cache[require.resolve('../lib/outbound-webhook')] = {
    id: require.resolve('../lib/outbound-webhook'),
    filename: require.resolve('../lib/outbound-webhook'),
    loaded: true,
    exports: {
      isValidWebhookUrl: async () => true,
      buildPaidPayload: () => ({}),
      firePaidWebhook: async (url, payload) => { webhookCalls.push({ url, payload }); return { ok: true }; },
      setHostnameResolver: () => {}
    }
  };
  require.cache[require.resolve('../lib/celebration')] = {
    id: require.resolve('../lib/celebration'),
    filename: require.resolve('../lib/celebration'),
    loaded: true,
    exports: {
      triggerFirstPaidCelebration: async (db, userId) => { paidCelebrationCalls.push(userId); return null; },
      buildReferralUrl: () => 'https://example.test/r/x'
    }
  };
  require.cache[require.resolve('../lib/paid-receipt')] = {
    id: require.resolve('../lib/paid-receipt'),
    filename: require.resolve('../lib/paid-receipt'),
    loaded: true,
    exports: {
      triggerPaidReceipt: async (db, invoice, user) => { paidReceiptCalls.push({ invoiceId: invoice.id, userId: user.id }); return null; }
    }
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
      const payload = new URLSearchParams(body).toString();
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
  paidCelebrationCalls = [];
  paidReceiptCalls = [];
  webhookCalls = [];
}

test('route: status=paid with return_to=/invoices redirects back to dashboard (not /:id)', async () => {
  resetRouteStores();
  userStore[7] = { id: 7, email: 'a@x.com', name: 'A', plan: 'free' };
  invoiceStore[5] = {
    id: 5, user_id: 7, invoice_number: 'INV-1', client_name: 'Acme',
    client_email: 'acme@x.example', total: '500.00', status: 'sent',
    is_seed: false, public_token: 'tok', items: []
  };
  const app = buildInvoiceApp({ id: 7, plan: 'free' });
  const r = await postForm(app, '/invoices/5/status', { status: 'paid', return_to: '/invoices' });
  assert.strictEqual(r.status, 302);
  assert.strictEqual(r.headers.location, '/invoices',
    'mark-paid with return_to=/invoices must round-trip on the redirect — the freelancer stays on the dashboard');
  assert.strictEqual(invoiceStore[5].status, 'paid', 'status flipped to paid');
});

test('route: status=paid with NO return_to falls back to /invoices/:id (backward compat)', async () => {
  resetRouteStores();
  userStore[7] = { id: 7, email: 'a@x.com', name: 'A', plan: 'free' };
  invoiceStore[6] = {
    id: 6, user_id: 7, invoice_number: 'INV-2', client_name: 'Beta',
    client_email: 'beta@x.example', total: '300.00', status: 'sent',
    is_seed: false, public_token: 'tok2', items: []
  };
  const app = buildInvoiceApp({ id: 7, plan: 'free' });
  const r = await postForm(app, '/invoices/6/status', { status: 'paid' });
  assert.strictEqual(r.status, 302);
  assert.strictEqual(r.headers.location, '/invoices/6',
    'legacy single-page mark-paid (no return_to) still lands on /:id');
});

test('route: status=paid with return_to=/invoices/<id> still works (regression guard)', async () => {
  resetRouteStores();
  userStore[7] = { id: 7, email: 'a@x.com', name: 'A', plan: 'free' };
  invoiceStore[8] = {
    id: 8, user_id: 7, invoice_number: 'INV-3', client_name: 'Gamma',
    client_email: 'g@x.example', total: '200.00', status: 'sent',
    is_seed: false, public_token: 'tok3', items: []
  };
  const app = buildInvoiceApp({ id: 7, plan: 'free' });
  const r = await postForm(app, '/invoices/8/status', { status: 'paid', return_to: '/invoices/8' });
  assert.strictEqual(r.status, 302);
  assert.strictEqual(r.headers.location, '/invoices/8');
});

test('route: hostile return_to values all fall back to /invoices/:id (open-redirect defence)', async () => {
  const hostile = [
    '/invoices/',
    '/invoices/edit',
    '/invoices/0',
    '/invoices/abc',
    '/invoices/-1',
    '/invoices?foo=bar',
    'https://evil.example.com/invoices',
    '//evil.example.com/invoices',
    '/admin',
    '/',
    '',
    'javascript:alert(1)'
  ];
  for (const bad of hostile) {
    resetRouteStores();
    userStore[7] = { id: 7, email: 'a@x.com', name: 'A', plan: 'free' };
    invoiceStore[9] = {
      id: 9, user_id: 7, invoice_number: 'INV-4', client_name: 'Delta',
      client_email: 'd@x.example', total: '100.00', status: 'sent',
      is_seed: false, public_token: 'tok4', items: []
    };
    const app = buildInvoiceApp({ id: 7, plan: 'free' });
    const r = await postForm(app, '/invoices/9/status', { status: 'paid', return_to: bad });
    assert.strictEqual(r.status, 302, `hostile return_to ${JSON.stringify(bad)} must 302`);
    assert.strictEqual(r.headers.location, '/invoices/9',
      `hostile return_to ${JSON.stringify(bad)} must fall back to /invoices/:id; got ${r.headers.location}`);
  }
});

test('route: status=paid triggers the paid-receipt + first-paid celebration side-effects', async () => {
  // Each mark-paid flip is a Milestone 4 close-the-loop event:
  // 1. paid-receipt email to the client (confirms the value the client got)
  // 2. first-paid celebration to the freelancer (closes the trial-paid
  //    activation arc + mints the referral code)
  // Both must fire regardless of which return_to surface called the flip.
  resetRouteStores();
  userStore[7] = { id: 7, email: 'a@x.com', name: 'A', plan: 'free' };
  invoiceStore[10] = {
    id: 10, user_id: 7, invoice_number: 'INV-5', client_name: 'Epsilon',
    client_email: 'e@x.example', total: '750.00', status: 'overdue',
    is_seed: false, public_token: 'tok5', items: []
  };
  const app = buildInvoiceApp({ id: 7, plan: 'free' });
  await postForm(app, '/invoices/10/status', { status: 'paid', return_to: '/invoices' });
  // Allow fire-and-forget .catch chains to settle.
  await new Promise(resolve => setImmediate(resolve));
  assert.deepStrictEqual(paidCelebrationCalls, [7],
    'triggerFirstPaidCelebration fires with the owning user id');
  assert.strictEqual(paidReceiptCalls.length, 1, 'triggerPaidReceipt fires once');
  assert.strictEqual(paidReceiptCalls[0].invoiceId, 10);
  assert.strictEqual(paidReceiptCalls[0].userId, 7);
});

test('route: invalid status with return_to=/invoices still honours the dashboard return path', async () => {
  // Defence-in-depth: even on the error branch the freelancer should
  // land back where they came from, with a flash explaining what went
  // wrong. A hard redirect to /invoices/:id on every error would force
  // them out of the dashboard for a server-side validation hiccup.
  resetRouteStores();
  userStore[7] = { id: 7, email: 'a@x.com', name: 'A', plan: 'free' };
  invoiceStore[11] = {
    id: 11, user_id: 7, invoice_number: 'INV-6', status: 'sent',
    is_seed: false, public_token: 'tok6', items: []
  };
  const app = buildInvoiceApp({ id: 7, plan: 'free' });
  const r = await postForm(app, '/invoices/11/status', { status: 'bogus', return_to: '/invoices' });
  assert.strictEqual(r.status, 302);
  assert.strictEqual(r.headers.location, '/invoices');
  assert.strictEqual(invoiceStore[11].status, 'sent', 'invalid status never persisted');
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
  console.log(`\n${passed} passed, ${failed} failed (dashboard-mark-paid.test.js)`);
  if (failed > 0) process.exit(1);
})();
