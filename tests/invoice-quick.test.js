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
const markSentCalls = [];
const emailSendCalls = [];
let nextInvoiceId = 100;
let emailSendImpl = async () => ({ ok: true, id: 'em_quick' });

function resetStore() {
  users.clear();
  createCalls.length = 0;
  markSentCalls.length = 0;
  emailSendCalls.length = 0;
  nextInvoiceId = 100;
  emailSendImpl = async () => ({ ok: true, id: 'em_quick' });
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
      async markInvoiceSentFromShareIntent(invoiceId, userId) {
        markSentCalls.push({ invoiceId, userId });
        return { id: invoiceId, status: 'sent', sent_via_share_intent_at: new Date() };
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
  // Real email lib first, then proxy sendInvoiceEmail through a test-controlled
  // impl so we can assert call shape + simulate ok / not_configured / failure.
  delete require.cache[require.resolve('../lib/email')];
  const realEmail = require('../lib/email');
  require.cache[require.resolve('../lib/email')] = {
    id: require.resolve('../lib/email'),
    filename: require.resolve('../lib/email'),
    loaded: true,
    exports: Object.assign({}, realEmail, {
      sendInvoiceEmail: async (invoice, owner) => {
        emailSendCalls.push({ invoice, owner });
        return emailSendImpl(invoice, owner);
      }
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
// Layer 2b — POST /invoices/quick with action=create_and_email (Pro/Agency)
// ============================================================================
//
// Collapses the create → land on /:id → click "Send by email" two-step into a
// single submit. Hard-gated on Pro/Agency plan + present client_email; free
// users tampering with the form payload fall through to the create-only path
// without an email send (defence-in-depth against the view-side hide).

async function testPostCreateAndEmailProHappyPath() {
  resetStore();
  users.set(1, { id: 1, plan: 'pro', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  emailSendImpl = async () => ({ ok: true, id: 'em_happy' });
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'pro', invoice_count: 0 }, routes);

  const res = await request(app, 'POST', '/invoices/quick', {
    client_name: 'Acme',
    client_email: 'pay@acme.com',
    description: 'Brand work',
    amount: '500',
    action: 'create_and_email'
  });
  assert.strictEqual(res.status, 302, 'create_and_email must redirect');
  assert.ok(/^\/invoices\/\d+$/.test(res.headers.location),
    `must redirect to /invoices/<id>, got ${res.headers.location}`);
  assert.strictEqual(createCalls.length, 1, 'createInvoice still fires');
  assert.strictEqual(emailSendCalls.length, 1, 'sendInvoiceEmail fires exactly once on create_and_email');
  assert.strictEqual(emailSendCalls[0].invoice.client_email, 'pay@acme.com',
    'sendInvoiceEmail receives the just-created invoice with the typed email');
  assert.strictEqual(emailSendCalls[0].owner.id, 1, 'sendInvoiceEmail receives the owner user');
  assert.strictEqual(markSentCalls.length, 1,
    'markInvoiceSentFromShareIntent flips draft → sent after a successful send');
  assert.strictEqual(markSentCalls[0].userId, 1,
    'flip carries the session user id (defence vs cross-tenant flip)');
}

async function testPostCreateAndEmailFlashOnSuccess() {
  resetStore();
  users.set(1, { id: 1, plan: 'pro', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  emailSendImpl = async () => ({ ok: true, id: 'em_ok' });
  const routes = installDbStub();
  // Capture the session flash by attaching middleware that exposes it.
  const sessionCaptured = { user: { id: 1, plan: 'pro', invoice_count: 0 }, flash: null };
  const customApp = express();
  customApp.set('view engine', 'ejs');
  customApp.set('views', path.join(__dirname, '..', 'views'));
  customApp.use(express.urlencoded({ extended: true }));
  customApp.use(express.json());
  customApp.use((req, _res, next) => { req.session = sessionCaptured; next(); });
  customApp.use((req, res, next) => { res.locals.csrfToken = 'tkn'; next(); });
  customApp.use('/invoices', routes);

  await request(customApp, 'POST', '/invoices/quick', {
    client_name: 'Acme',
    client_email: 'pay@acme.com',
    description: 'Brand work',
    amount: '500',
    action: 'create_and_email'
  });
  assert.ok(sessionCaptured.flash, 'session flash must be set on success');
  assert.strictEqual(sessionCaptured.flash.type, 'success', 'success flash on create+email happy path');
  assert.ok(/pay@acme\.com/.test(sessionCaptured.flash.message),
    'success flash must name the email address the invoice was sent to');
  assert.ok(/emailed/i.test(sessionCaptured.flash.message),
    'success flash must say "emailed" so the user knows it actually shipped');
}

async function testPostCreateAndEmailFreeUserDefenceInDepth() {
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 0 }, routes);

  const res = await request(app, 'POST', '/invoices/quick', {
    client_name: 'Acme',
    client_email: 'pay@acme.com',
    description: 'Brand work',
    amount: '500',
    action: 'create_and_email'
  });
  assert.strictEqual(res.status, 302, 'free user must still get the invoice created');
  assert.strictEqual(createCalls.length, 1, 'createInvoice still fires');
  assert.strictEqual(emailSendCalls.length, 0,
    'free user MUST NOT trigger an email send even if action=create_and_email is forged in the payload');
  assert.strictEqual(markSentCalls.length, 0,
    'free user MUST NOT have the invoice auto-flipped to sent');
}

async function testPostCreateAndEmailMissingEmailNoSend() {
  resetStore();
  users.set(1, { id: 1, plan: 'pro', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'pro', invoice_count: 0 }, routes);

  const res = await request(app, 'POST', '/invoices/quick', {
    client_name: 'Acme',
    client_email: '',
    description: 'Brand work',
    amount: '500',
    action: 'create_and_email'
  });
  assert.strictEqual(res.status, 302, 'invoice still creates on missing email');
  assert.strictEqual(createCalls.length, 1);
  assert.strictEqual(emailSendCalls.length, 0,
    'no client_email → no email send (sendInvoiceEmail would return no_client_email but we short-circuit earlier)');
  assert.strictEqual(markSentCalls.length, 0, 'no email send → no draft→sent flip');
}

async function testPostCreateAndEmailNotConfiguredKeepsDraft() {
  resetStore();
  users.set(1, { id: 1, plan: 'pro', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  emailSendImpl = async () => ({ ok: false, reason: 'not_configured' });
  const routes = installDbStub();
  const sessionCaptured = { user: { id: 1, plan: 'pro', invoice_count: 0 }, flash: null };
  const customApp = express();
  customApp.set('view engine', 'ejs');
  customApp.set('views', path.join(__dirname, '..', 'views'));
  customApp.use(express.urlencoded({ extended: true }));
  customApp.use(express.json());
  customApp.use((req, _res, next) => { req.session = sessionCaptured; next(); });
  customApp.use((req, res, next) => { res.locals.csrfToken = 'tkn'; next(); });
  customApp.use('/invoices', routes);

  const res = await request(customApp, 'POST', '/invoices/quick', {
    client_name: 'Acme',
    client_email: 'pay@acme.com',
    description: 'Brand work',
    amount: '500',
    action: 'create_and_email'
  });
  assert.strictEqual(res.status, 302, 'still redirect to /invoices/:id even on email send failure');
  assert.strictEqual(createCalls.length, 1, 'invoice still created on send failure (graceful degrade)');
  assert.strictEqual(emailSendCalls.length, 1, 'send was attempted');
  assert.strictEqual(markSentCalls.length, 0,
    'failed send must NOT flip status (dashboard truthfully shows draft so the user retries)');
  assert.ok(sessionCaptured.flash, 'flash must be set');
  assert.strictEqual(sessionCaptured.flash.type, 'error',
    'send failure must surface as an error flash, not a silent fallback');
  assert.ok(/configured|not yet/i.test(sessionCaptured.flash.message),
    'flash copy must explain the not-configured cause so the user knows why');
}

async function testPostCreateAndEmailGenericFailureKeepsDraft() {
  resetStore();
  users.set(1, { id: 1, plan: 'pro', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  emailSendImpl = async () => ({ ok: false, reason: 'error', error: 'boom' });
  const routes = installDbStub();
  const sessionCaptured = { user: { id: 1, plan: 'pro', invoice_count: 0 }, flash: null };
  const customApp = express();
  customApp.set('view engine', 'ejs');
  customApp.set('views', path.join(__dirname, '..', 'views'));
  customApp.use(express.urlencoded({ extended: true }));
  customApp.use(express.json());
  customApp.use((req, _res, next) => { req.session = sessionCaptured; next(); });
  customApp.use((req, res, next) => { res.locals.csrfToken = 'tkn'; next(); });
  customApp.use('/invoices', routes);

  await request(customApp, 'POST', '/invoices/quick', {
    client_name: 'Acme',
    client_email: 'pay@acme.com',
    description: 'Brand work',
    amount: '500',
    action: 'create_and_email'
  });
  assert.strictEqual(createCalls.length, 1, 'invoice still created on Resend send error');
  assert.strictEqual(markSentCalls.length, 0, 'no status flip on send error');
  assert.strictEqual(sessionCaptured.flash.type, 'error', 'error flash');
  assert.ok(/share buttons/i.test(sessionCaptured.flash.message),
    'flash must point user at the share buttons as a fallback path');
}

async function testPostCreateOnlyExplicitActionDoesNotSend() {
  resetStore();
  users.set(1, { id: 1, plan: 'pro', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'pro', invoice_count: 0 }, routes);

  await request(app, 'POST', '/invoices/quick', {
    client_name: 'Acme',
    client_email: 'pay@acme.com',
    description: 'Brand work',
    amount: '500',
    action: 'create_only'
  });
  assert.strictEqual(createCalls.length, 1);
  assert.strictEqual(emailSendCalls.length, 0,
    'create_only must NOT trigger email even when client_email is present');
  assert.strictEqual(markSentCalls.length, 0, 'create_only leaves status as draft');
}

async function testPostAgencyParity() {
  resetStore();
  users.set(1, { id: 1, plan: 'agency', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  emailSendImpl = async () => ({ ok: true, id: 'em_agency' });
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'agency', invoice_count: 0 }, routes);

  await request(app, 'POST', '/invoices/quick', {
    client_name: 'Acme',
    client_email: 'pay@acme.com',
    description: 'Brand work',
    amount: '500',
    action: 'create_and_email'
  });
  assert.strictEqual(emailSendCalls.length, 1, 'agency plan gets create+email parity with pro');
  assert.strictEqual(markSentCalls.length, 1, 'agency plan gets the auto-flip too');
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

async function testViewRendersEmailButtonForPro() {
  const html = await renderQuickView({
    user: { id: 1, plan: 'pro', invoice_count: 0, name: 'Alice', email: 'a@x.com' }
  });
  assert.ok(html.includes('data-testid="invoice-quick-submit-draft"'),
    'pro user must see the "Save as draft" secondary button');
  assert.ok(html.includes('data-action="create_and_email"'),
    'pro user must see the create_and_email button');
  assert.ok(html.includes('value="create_and_email"'),
    'create_and_email button must POST action=create_and_email');
  assert.ok(html.includes('value="create_only"'),
    'draft button must POST action=create_only');
  assert.ok(html.includes('data-testid="invoice-quick-email-hint"'),
    'pro user must see the one-tap email hint');
  // Alpine binding gates the email button on a non-empty client_email
  // (now lives under the shared autosave-scope as fields.client_email)
  assert.ok(/:disabled="!fields\.client_email/.test(html),
    'email button must disable when client_email is empty (Alpine binding)');
}

async function testViewHidesEmailButtonForFree() {
  const html = await renderQuickView({
    user: { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com' }
  });
  assert.ok(!html.includes('value="create_and_email"'),
    'free user MUST NOT see the create_and_email button (server hard-rejects anyway)');
  assert.ok(!html.includes('data-testid="invoice-quick-submit-draft"'),
    'free user sees a single "Create invoice" button, not the dual draft/email pair');
  assert.ok(!html.includes('data-testid="invoice-quick-email-hint"'),
    'free user must not see the Pro-only "email to client" hint');
  assert.ok(html.includes('data-testid="invoice-quick-submit"'),
    'free user still gets the primary submit button');
}

async function testViewRendersEmailButtonForAgency() {
  const html = await renderQuickView({
    user: { id: 1, plan: 'agency', invoice_count: 0, name: 'Alice', email: 'a@x.com' }
  });
  assert.ok(html.includes('value="create_and_email"'),
    'agency users get parity with pro on the create+email surface');
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
    ['POST /invoices/quick: action=create_and_email (Pro+email) → send + flip', testPostCreateAndEmailProHappyPath],
    ['POST /invoices/quick: action=create_and_email success flash names the recipient', testPostCreateAndEmailFlashOnSuccess],
    ['POST /invoices/quick: action=create_and_email (Free) → no send, no flip (defence-in-depth)', testPostCreateAndEmailFreeUserDefenceInDepth],
    ['POST /invoices/quick: action=create_and_email without email → no send, no flip', testPostCreateAndEmailMissingEmailNoSend],
    ['POST /invoices/quick: action=create_and_email, Resend not configured → draft kept + error flash', testPostCreateAndEmailNotConfiguredKeepsDraft],
    ['POST /invoices/quick: action=create_and_email, Resend generic failure → draft kept + error flash', testPostCreateAndEmailGenericFailureKeepsDraft],
    ['POST /invoices/quick: action=create_only on Pro with email → invoice only, no send', testPostCreateOnlyExplicitActionDoesNotSend],
    ['POST /invoices/quick: action=create_and_email (Agency) → send + flip parity with Pro', testPostAgencyParity],
    ['view: invoice-quick.ejs form shape', testViewFormShape],
    ['view: flash message renders when supplied', testViewFlashRenders],
    ['view: flash container omitted when null', testViewOmitsFlashWhenNull],
    ['view: submitted values re-populate sticky form', testViewRepopulatesSubmitted],
    ['view: Pro sees the "Create & email to client" button + draft + hint', testViewRendersEmailButtonForPro],
    ['view: Free user does NOT see the create_and_email surface', testViewHidesEmailButtonForFree],
    ['view: Agency sees the "Create & email to client" button (parity with Pro)', testViewRendersEmailButtonForAgency],
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
