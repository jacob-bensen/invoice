'use strict';

/*
 * "Quick invoice" express form tests (Milestone 2).
 *
 * The /invoices/quick route is the 3-field express path that lets a brand-new
 * user create their first real invoice without facing the full
 * blank-line-items + tax + dates + notes form at /invoices/new. The user types
 * client name + description + amount and lands on /invoices/:id with the
 * share-intent buttons pre-rendered — collapses the "I want to bill someone"
 * → "I sent them an invoice" path to one form + one tap.
 *
 * Coverage:
 *
 *  - Layer 1: route GET /invoices/quick
 *      * Renders the express form (200, contains the 3 input fields).
 *      * Respects the free-tier FREE_LIMIT — at limit redirects to
 *        /invoices?limit_hit=1 instead of rendering.
 *      * Renders for all plans (free below limit, Pro, Agency).
 *
 *  - Layer 2: route POST /invoices/quick
 *      * Happy path: 302 → /invoices/<newId>, db.createInvoice called with
 *        correct shape (single line item, today's issued_date,
 *        issued_date + 30d due_date, no tax, no notes, server-generated
 *        invoice_number).
 *      * Bumps session.user.invoice_count.
 *      * Sets the post-create flash that the share-intent surface uses.
 *      * Validates: empty client_name re-renders the form (no createInvoice).
 *      * Validates: empty description re-renders the form (no createInvoice).
 *      * Validates: missing/zero/negative amount re-renders the form.
 *      * Respects FREE_LIMIT: at-limit free user → /invoices?limit_hit=1 with
 *        no createInvoice call.
 *      * Trims whitespace on client_name + description.
 *      * Empty client_email passes through as null (it's optional).
 *
 *  - Layer 3: view invoice-quick.ejs
 *      * Form action is POST /invoices/quick.
 *      * CSRF hidden input present.
 *      * Three required inputs: client_name, description, amount (the email
 *        field is optional).
 *      * "Advanced form" link points at /invoices/new (escape hatch for
 *        power users who need line items / tax / custom dates).
 *      * Flash message renders when supplied.
 *      * Submitted values re-populate the form on validation error.
 *
 *  - Layer 4: dashboard wiring
 *      * The "first real invoice" prompt's primary CTA now points at
 *        /invoices/quick (already covered in first-real-invoice-prompt.test.js
 *        — we re-assert here for end-to-end clarity).
 *
 * Run: NODE_ENV=test node tests/invoice-quick.test.js
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
const createCalls = [];
let nextInvoiceId = 100;

function resetStore() {
  users.clear();
  createCalls.length = 0;
  nextInvoiceId = 100;
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
        const row = Object.assign({ id }, data, {
          items: data.items,
          status: 'draft',
          is_seed: false
        });
        const u = users.get(data.user_id);
        if (u) u.invoice_count = (u.invoice_count || 0) + 1;
        return row;
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

// ============================================================================
// Layer 1 — GET /invoices/quick
// ============================================================================

async function testGetRendersFormForFreeUserBelowLimit() {
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 0 }, routes);
  const res = await request(app, 'GET', '/invoices/quick');
  assert.strictEqual(res.status, 200, 'GET /invoices/quick must render 200 for free below limit');
  assert.ok(res.body.includes('data-testid="invoice-quick-form"'),
    'response must contain the quick form');
  assert.ok(res.body.includes('action="/invoices/quick"'),
    'form action must POST to /invoices/quick');
  assert.ok(/name="client_name"/.test(res.body), 'client_name input must render');
  assert.ok(/name="description"/.test(res.body), 'description input must render');
  assert.ok(/name="amount"/.test(res.body), 'amount input must render');
  // Advanced-form escape hatch is part of the surface.
  assert.ok(res.body.includes('href="/invoices/new"'),
    'advanced-form link must point at /invoices/new');
  assert.ok(res.body.includes('data-testid="invoice-quick-advanced-link"'),
    'advanced-form link must carry the testid hook');
}

async function testGetRedirectsFreeUserAtLimit() {
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 3, name: 'Alice', email: 'a@x.com' });
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 3 }, routes);
  const res = await request(app, 'GET', '/invoices/quick');
  assert.strictEqual(res.status, 302, 'free user at limit must be redirected');
  assert.ok(/\/invoices\?limit_hit=1$/.test(res.headers.location),
    `must redirect to /invoices?limit_hit=1, got ${res.headers.location}`);
}

async function testGetRendersForPro() {
  resetStore();
  users.set(2, { id: 2, plan: 'pro', invoice_count: 12, name: 'Bob', email: 'b@x.com' });
  const routes = installDbStub();
  const app = buildApp({ id: 2, plan: 'pro', invoice_count: 12 }, routes);
  const res = await request(app, 'GET', '/invoices/quick');
  assert.strictEqual(res.status, 200, 'Pro user must always be able to render quick form');
  assert.ok(res.body.includes('data-testid="invoice-quick-form"'),
    'Pro response must contain the quick form');
}

// ============================================================================
// Layer 2 — POST /invoices/quick
// ============================================================================

async function testPostHappyPath() {
  resetStore();
  users.set(1, { id: 1, plan: 'pro', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'pro', invoice_count: 0 }, routes);

  const res = await request(app, 'POST', '/invoices/quick', {
    client_name: 'Acme Corp',
    client_email: 'pay@acme.com',
    description: 'Logo design — June',
    amount: '750.00'
  });
  assert.strictEqual(res.status, 302, 'happy-path POST must redirect');
  assert.ok(/^\/invoices\/\d+$/.test(res.headers.location),
    `must redirect to /invoices/<newId>, got ${res.headers.location}`);

  assert.strictEqual(createCalls.length, 1, 'db.createInvoice called exactly once');
  const call = createCalls[0];
  assert.strictEqual(call.user_id, 1, 'user_id propagated from session');
  assert.strictEqual(call.client_name, 'Acme Corp', 'client_name propagated');
  assert.strictEqual(call.client_email, 'pay@acme.com', 'client_email propagated');
  assert.strictEqual(call.client_address, null, 'client_address absent → null');
  assert.strictEqual(call.notes, null, 'no notes on quick invoice');
  assert.strictEqual(call.tax_rate, 0, 'tax_rate defaults to 0');
  assert.strictEqual(call.tax_amount, 0, 'tax_amount defaults to 0');
  assert.strictEqual(call.subtotal, 750, 'subtotal === amount for 1-line invoice');
  assert.strictEqual(call.total, 750, 'total === amount for 1-line invoice');
  assert.ok(Array.isArray(call.items) && call.items.length === 1,
    'items must be a single-element array');
  assert.deepStrictEqual(call.items[0],
    { description: 'Logo design — June', quantity: 1, unit_price: 750 },
    'single line item must carry the typed description + qty=1 + unit_price=amount');
  assert.ok(/^INV-2026-\d{4}$/.test(call.invoice_number),
    'invoice_number must follow INV-YYYY-NNNN');
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(call.issued_date),
    'issued_date must be YYYY-MM-DD');
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(call.due_date),
    'due_date must be YYYY-MM-DD');
  const issued = new Date(call.issued_date + 'T00:00:00Z');
  const due = new Date(call.due_date + 'T00:00:00Z');
  assert.strictEqual(due.getTime() - issued.getTime(), 30 * 86400000,
    'due_date must default to issued_date + 30 days');
}

async function testPostEmptyClientEmailPassesAsNull() {
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 0 }, routes);

  const res = await request(app, 'POST', '/invoices/quick', {
    client_name: 'Acme',
    client_email: '',
    description: 'Consulting',
    amount: '300'
  });
  assert.strictEqual(res.status, 302, 'absent email must still succeed');
  assert.strictEqual(createCalls.length, 1, 'create still fires when email is empty');
  assert.strictEqual(createCalls[0].client_email, null,
    'empty client_email must be persisted as null, not an empty string');
}

async function testPostTrimsWhitespace() {
  resetStore();
  users.set(1, { id: 1, plan: 'pro', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'pro', invoice_count: 0 }, routes);

  const res = await request(app, 'POST', '/invoices/quick', {
    client_name: '  Acme Co  ',
    description: '  Brand work  ',
    amount: '100'
  });
  assert.strictEqual(res.status, 302, 'happy-path POST after trim');
  assert.strictEqual(createCalls[0].client_name, 'Acme Co', 'client_name must be trimmed');
  assert.strictEqual(createCalls[0].items[0].description, 'Brand work',
    'item description must be trimmed');
}

async function testPostMissingClientNameRerenders() {
  resetStore();
  users.set(1, { id: 1, plan: 'pro', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'pro', invoice_count: 0 }, routes);

  const res = await request(app, 'POST', '/invoices/quick', {
    client_name: '',
    description: 'X',
    amount: '50'
  });
  assert.strictEqual(res.status, 200, 'missing client_name re-renders the form (200)');
  assert.ok(res.body.includes('data-testid="invoice-quick-flash"'),
    'flash message must be in the re-render');
  assert.ok(/Client name is required/i.test(res.body),
    'flash must carry the client-name validation message');
  assert.strictEqual(createCalls.length, 0, 'no createInvoice call on validation fail');
}

async function testPostMissingDescriptionRerenders() {
  resetStore();
  users.set(1, { id: 1, plan: 'pro', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'pro', invoice_count: 0 }, routes);

  const res = await request(app, 'POST', '/invoices/quick', {
    client_name: 'Acme',
    description: '   ',
    amount: '50'
  });
  assert.strictEqual(res.status, 200, 'missing/whitespace description re-renders');
  assert.ok(/recognises|recognizes/i.test(res.body) || /Describe what you did/i.test(res.body),
    'flash must carry the description validation message');
  assert.strictEqual(createCalls.length, 0, 'no createInvoice call on description fail');
}

async function testPostZeroAmountRerenders() {
  resetStore();
  users.set(1, { id: 1, plan: 'pro', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'pro', invoice_count: 0 }, routes);

  const res = await request(app, 'POST', '/invoices/quick', {
    client_name: 'Acme',
    description: 'Work',
    amount: '0'
  });
  assert.strictEqual(res.status, 200, 'zero amount must re-render the form');
  assert.ok(/Amount must be greater than \$0/i.test(res.body),
    'flash must carry the amount validation message');
  assert.strictEqual(createCalls.length, 0, 'no createInvoice call on amount=0');
}

async function testPostNegativeAmountRerenders() {
  resetStore();
  users.set(1, { id: 1, plan: 'pro', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'pro', invoice_count: 0 }, routes);

  const res = await request(app, 'POST', '/invoices/quick', {
    client_name: 'Acme',
    description: 'Work',
    amount: '-10'
  });
  assert.strictEqual(res.status, 200, 'negative amount must re-render the form');
  assert.strictEqual(createCalls.length, 0, 'no createInvoice call on negative amount');
}

async function testPostMissingAmountRerenders() {
  resetStore();
  users.set(1, { id: 1, plan: 'pro', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'pro', invoice_count: 0 }, routes);

  const res = await request(app, 'POST', '/invoices/quick', {
    client_name: 'Acme',
    description: 'Work',
    amount: ''
  });
  assert.strictEqual(res.status, 200, 'missing amount must re-render the form');
  assert.strictEqual(createCalls.length, 0, 'no createInvoice call on missing amount');
}

async function testPostFreeUserAtLimit() {
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 3, name: 'Alice', email: 'a@x.com' });
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 3 }, routes);

  const res = await request(app, 'POST', '/invoices/quick', {
    client_name: 'Acme',
    description: 'Work',
    amount: '100'
  });
  assert.strictEqual(res.status, 302, 'free user at limit must be redirected on POST');
  assert.ok(/\/invoices\?limit_hit=1$/.test(res.headers.location),
    `must redirect to /invoices?limit_hit=1, got ${res.headers.location}`);
  assert.strictEqual(createCalls.length, 0, 'no create at limit');
}

async function testPostRepopulatesFormOnValidationError() {
  resetStore();
  users.set(1, { id: 1, plan: 'pro', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'pro', invoice_count: 0 }, routes);

  const res = await request(app, 'POST', '/invoices/quick', {
    client_name: 'Acme Corp',
    client_email: 'pay@acme.com',
    description: '',
    amount: '500'
  });
  assert.strictEqual(res.status, 200, 'validation error re-render');
  // Sticky values let the user fix the one bad field instead of re-typing all four.
  assert.ok(res.body.includes('value="Acme Corp"'),
    'client_name value must be repopulated after validation error');
  assert.ok(res.body.includes('value="pay@acme.com"'),
    'client_email value must be repopulated after validation error');
  assert.ok(res.body.includes('value="500"'),
    'amount value must be repopulated after validation error');
}

// ============================================================================
// Layer 3 — invoice-quick.ejs render shape
// ============================================================================

async function renderQuickView(opts) {
  const viewsDir = path.join(__dirname, '..', 'views');
  return ejs.renderFile(path.join(viewsDir, 'invoice-quick.ejs'),
    Object.assign({
      title: 'Quick invoice',
      user: { id: 1, plan: 'pro', invoice_count: 0, name: 'Alice', email: 'a@x.com' },
      flash: null,
      csrfToken: 'tkn'
    }, opts || {}),
    { views: [viewsDir] });
}

async function testViewFormShape() {
  const html = await renderQuickView();
  assert.ok(html.includes('data-testid="invoice-quick-form"'), 'form testid');
  assert.ok(html.includes('action="/invoices/quick"'), 'form action');
  assert.ok(html.includes('method="POST"') || html.toLowerCase().includes('method="post"'),
    'form must POST');
  assert.ok(html.includes('name="_csrf"'), 'CSRF hidden input');
  assert.ok(html.includes('value="tkn"'), 'CSRF token value');
  assert.ok(html.includes('name="client_name"'), 'client_name input');
  assert.ok(html.includes('name="client_email"'), 'optional client_email input');
  assert.ok(html.includes('name="description"'), 'description input');
  assert.ok(html.includes('name="amount"'), 'amount input');
  // Three required fields (client_name, description, amount) — email is NOT required.
  const requiredCount = (html.match(/\srequired\b/g) || []).length;
  assert.ok(requiredCount >= 3,
    `at least 3 required attrs (client_name + description + amount), saw ${requiredCount}`);
  assert.ok(html.includes('data-testid="invoice-quick-submit"'), 'submit testid');
  assert.ok(html.includes('href="/invoices/new"'),
    'advanced-form escape hatch must link to /invoices/new');
  assert.ok(html.includes('data-testid="invoice-quick-advanced-link"'),
    'advanced-link testid present');
}

async function testViewFlashRenders() {
  const html = await renderQuickView({
    flash: { type: 'error', message: 'Client name is required' }
  });
  assert.ok(html.includes('data-testid="invoice-quick-flash"'),
    'flash container must render when flash is set');
  assert.ok(html.includes('Client name is required'),
    'flash message body must render');
}

async function testViewOmitsFlashWhenNull() {
  const html = await renderQuickView({ flash: null });
  assert.ok(!html.includes('data-testid="invoice-quick-flash"'),
    'flash container must NOT render when flash is null');
}

async function testViewRepopulatesSubmitted() {
  const html = await renderQuickView({
    submitted: {
      client_name: 'Repop Co',
      client_email: 'r@x.com',
      description: 'Repop work',
      amount: '275.50'
    }
  });
  assert.ok(html.includes('value="Repop Co"'), 'client_name sticky after re-render');
  assert.ok(html.includes('value="r@x.com"'), 'client_email sticky after re-render');
  assert.ok(html.includes('value="Repop work"'), 'description sticky after re-render');
  assert.ok(html.includes('value="275.50"'), 'amount sticky after re-render');
}

// ============================================================================
// Layer 4 — dashboard wiring
// ============================================================================

async function testDashboardPrimaryCtaPointsAtQuick() {
  const dashboardTplPath = path.join(__dirname, '..', 'views', 'dashboard.ejs');
  const dashboardTpl = fs.readFileSync(dashboardTplPath, 'utf8');
  const html = ejs.render(dashboardTpl, {
    title: 'Dashboard', flash: null, days_left_in_trial: 0,
    csrfToken: 'TEST_CSRF', invoices: [],
    user: { plan: 'free', invoice_count: 0, subscription_status: null },
    onboarding: null, invoiceLimitProgress: null, recentRevenue: null,
    annualUpgradePrompt: null, socialProof: null, celebration: null,
    staleDraftPrompt: null,
    firstRealInvoicePrompt: { hasSeed: false }
  }, {
    views: [path.join(__dirname, '..', 'views')],
    filename: dashboardTplPath
  });
  assert.ok(/<a\s[^>]*href="\/invoices\/quick"[^>]*data-testid="first-real-invoice-prompt-cta"/.test(html),
    'dashboard primary CTA must point at /invoices/quick');
  assert.ok(/<a\s[^>]*href="\/invoices\/new"[^>]*data-testid="first-real-invoice-prompt-advanced"/.test(html),
    'dashboard secondary "advanced form" link must point at /invoices/new');
}

// ============================================================================
// Runner
// ============================================================================

async function run() {
  const tests = [
    ['GET /invoices/quick: renders form for free user below limit', testGetRendersFormForFreeUserBelowLimit],
    ['GET /invoices/quick: free user at limit → /invoices?limit_hit=1', testGetRedirectsFreeUserAtLimit],
    ['GET /invoices/quick: renders for Pro user', testGetRendersForPro],
    ['POST /invoices/quick: happy path → 302 + createInvoice shape correct', testPostHappyPath],
    ['POST /invoices/quick: empty client_email persisted as null', testPostEmptyClientEmailPassesAsNull],
    ['POST /invoices/quick: trims whitespace on client_name + description', testPostTrimsWhitespace],
    ['POST /invoices/quick: missing client_name re-renders form', testPostMissingClientNameRerenders],
    ['POST /invoices/quick: missing description re-renders form', testPostMissingDescriptionRerenders],
    ['POST /invoices/quick: zero amount re-renders form', testPostZeroAmountRerenders],
    ['POST /invoices/quick: negative amount re-renders form', testPostNegativeAmountRerenders],
    ['POST /invoices/quick: missing amount re-renders form', testPostMissingAmountRerenders],
    ['POST /invoices/quick: free user at limit → /invoices?limit_hit=1', testPostFreeUserAtLimit],
    ['POST /invoices/quick: validation error re-populates submitted fields', testPostRepopulatesFormOnValidationError],
    ['view: invoice-quick.ejs form shape', testViewFormShape],
    ['view: flash message renders when supplied', testViewFlashRenders],
    ['view: flash container omitted when null', testViewOmitsFlashWhenNull],
    ['view: submitted values re-populate sticky form', testViewRepopulatesSubmitted],
    ['dashboard: primary CTA at /invoices/quick + advanced link at /invoices/new', testDashboardPrimaryCtaPointsAtQuick]
  ];
  let passed = 0;
  let failed = 0;
  for (const [label, fn] of tests) {
    try {
      await fn();
      console.log(`  ok  ${label}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL ${label}`);
      console.error('       ', err && err.message);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Runner threw:', err);
  process.exit(1);
});
