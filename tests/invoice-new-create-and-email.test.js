'use strict';

/*
 * "Create & email to client" combined action on /invoices/new
 * (Milestone 3 — first invoice created → first invoice sent).
 *
 * /invoices/quick already collapses the create → land on /:id → tap Send
 * three-step into one submit for Pro/Agency users (action=create_and_email).
 * The advanced form at /invoices/new is the activation path for users with
 * multi-line work, tax, custom dates, notes, or custom invoice numbers —
 * exactly the high-LTV billing pattern Pro is built for. Until this ship,
 * Pro/Agency users on the advanced form still faced the three-step path:
 * one extra round-trip = one more activation drop-off opportunity.
 *
 * This file mirrors the layered coverage of tests/invoice-quick.test.js
 * (Layer 2b + Layer 3) against POST /invoices/new and views/invoice-form.ejs.
 *
 * Coverage:
 *
 *  - Layer 1: view invoice-form.ejs render shape
 *      * Pro user (new-flow): dual "Save as draft" + "Create & email" buttons.
 *      * Agency user (new-flow): parity with Pro.
 *      * Free user (new-flow): single primary button — no email path.
 *      * Trial user (new-flow): single primary button — trials are Pro-feature
 *        scoped but the gating here is plan === 'pro' || 'agency', and trial
 *        plan strings are 'free' on this codepath (trials persist as plan=free
 *        with a trial_ends_at column). Document via assertion.
 *      * Edit-flow (`invoice` set, any plan): single "Save changes" button —
 *        the user is past activation by then.
 *      * Alpine `:disabled` binding on the create+email button ties to
 *        `clientEmail` (the invoiceEditor scope name) so the button stays
 *        disabled until an email is typed.
 *
 *  - Layer 2: route POST /invoices/new with action=create_and_email
 *      * Pro happy path: send fires, status flips, celebration triggered,
 *        success flash names recipient, redirect to /invoices/:id.
 *      * Agency parity.
 *      * Free user defence-in-depth: forged action=create_and_email does NOT
 *        trigger send or flip.
 *      * Missing client_email: no send (short-circuit), no flip, still create.
 *      * action=create_only with email present: explicit opt-out path —
 *        creates draft, no send, no flip.
 *      * Default (action absent): backwards-compatible — no send, no flip.
 *      * Send failure (not_configured): create succeeds, draft preserved,
 *        error flash explains why.
 *      * Send failure (generic): create succeeds, draft preserved, error
 *        flash points at the share buttons.
 *
 * Run: NODE_ENV=test node tests/invoice-new-create-and-email.test.js
 */

const assert = require('assert');
const path = require('path');
const ejs = require('ejs');
const express = require('express');
const http = require('http');

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

// ---------------------------------------------------------------------------
// Test store + db stub
// ---------------------------------------------------------------------------

const users = new Map();
const createCalls = [];
const markSentCalls = [];
const emailSendCalls = [];
const mintTokenCalls = [];
const firstSentStampCalls = [];
let nextInvoiceId = 700;
let emailSendImpl = async () => ({ ok: true, id: 'em_new_ok' });
let firstSentStampImpl = null;

function resetStore() {
  users.clear();
  createCalls.length = 0;
  markSentCalls.length = 0;
  emailSendCalls.length = 0;
  mintTokenCalls.length = 0;
  firstSentStampCalls.length = 0;
  nextInvoiceId = 700;
  emailSendImpl = async () => ({ ok: true, id: 'em_new_ok' });
  firstSentStampImpl = null;
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
      async getRecentItemsForUser() { return []; },
      async createInvoice(data) {
        createCalls.push(data);
        const id = nextInvoiceId++;
        const u = users.get(data.user_id);
        if (u) u.invoice_count = (u.invoice_count || 0) + 1;
        return Object.assign({ id, status: 'draft', is_seed: false }, data);
      },
      async markInvoiceSentFromShareIntent(invoiceId, userId) {
        markSentCalls.push({ invoiceId, userId });
        return { id: invoiceId, status: 'sent', sent_via_share_intent_at: new Date() };
      },
      async updateUser(id, fields) {
        const u = users.get(id);
        if (u) Object.assign(u, fields);
        return u;
      },
      async getOrCreatePublicToken(invoiceId, userId) {
        mintTokenCalls.push({ invoiceId, userId });
        return 'tok_new_create_email';
      },
      async recordFirstSentIfMissing(userId) {
        firstSentStampCalls.push({ userId });
        if (firstSentStampImpl) return firstSentStampImpl(userId);
        // Mimic the real helper's contract: returns the stamped user row on
        // the first call (so the celebration email mints), null on
        // subsequent calls (idempotent at the SQL layer).
        const u = users.get(userId);
        if (!u) return null;
        return Object.assign({}, u, { first_sent_at: new Date() });
      },
      async clearPendingQuickInvoice() {},
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
  // Replace sendInvoiceEmail with a test-controlled proxy so we can assert
  // call shape + simulate ok / not_configured / failure outcomes.
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

function buildApp(sessionUser, invoiceRoutes, sessionRef) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use((req, _res, next) => {
    if (sessionRef) {
      req.session = sessionRef;
    } else {
      req.session = req.session || { user: sessionUser, flash: null };
      req.session.user = sessionUser ? Object.assign({}, sessionUser) : null;
    }
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

function postBody(extra) {
  return Object.assign({
    invoice_number: 'INV-2026-0001',
    issued_date: '2026-05-29',
    due_date: '2026-06-28',
    client_name: 'Acme Co',
    client_email: 'billing@acme.com',
    client_address: '',
    items: JSON.stringify([
      { description: 'Brand work', quantity: 1, unit_price: 500 },
      { description: 'Revisions', quantity: 2, unit_price: 75 }
    ]),
    subtotal: '650',
    tax_rate: '0',
    tax_amount: '0',
    total: '650',
    notes: ''
  }, extra || {});
}

// ---------------------------------------------------------------------------
// Layer 1 — invoice-form.ejs render shape
// ---------------------------------------------------------------------------

async function renderForm(opts) {
  const viewsDir = path.join(__dirname, '..', 'views');
  return ejs.renderFile(path.join(viewsDir, 'invoice-form.ejs'),
    Object.assign({
      title: 'New Invoice',
      invoice: null,
      invoiceNumber: 'INV-2026-0001',
      recentClients: [],
      user: { id: 1, plan: 'pro', invoice_count: 0, name: 'Alice', email: 'a@x.com', business_name: 'Acme Studio', payment_instructions: null },
      flash: null,
      csrfToken: 'tkn'
    }, opts || {}),
    { views: [viewsDir] });
}

async function testViewRendersDualButtonsForPro() {
  const html = await renderForm({
    user: { id: 1, plan: 'pro', invoice_count: 0, name: 'Alice', email: 'a@x.com', business_name: 'Acme Studio' }
  });
  assert.ok(html.includes('data-testid="invoice-new-submit-draft"'),
    'Pro user must see the "Save as draft" secondary button');
  assert.ok(html.includes('data-testid="invoice-new-submit-email"'),
    'Pro user must see the "Create & email to client" primary button');
  assert.ok(html.includes('data-action="create_and_email"'),
    'create+email button is tagged with data-action="create_and_email"');
  assert.ok(html.includes('value="create_and_email"'),
    'create+email button submits action=create_and_email');
  assert.ok(html.includes('value="create_only"'),
    'draft button submits action=create_only');
  assert.ok(html.includes('data-testid="invoice-new-email-hint"'),
    'Pro user sees the one-tap email hint copy');
  assert.ok(!html.includes('data-testid="invoice-new-submit"'),
    'single primary button is replaced by the dual-CTA pair for Pro');
}

async function testViewDisabledBindingTiesToClientEmail() {
  const html = await renderForm({
    user: { id: 1, plan: 'pro', invoice_count: 0, name: 'Alice', email: 'a@x.com', business_name: 'Acme Studio' }
  });
  // The Alpine binding must reference the invoiceEditor scope's `clientEmail`
  // field — that's the field the existing client-email input is x-model'd on
  // (line 136 of invoice-form.ejs). Without this, the button can't reactively
  // enable when the user types an email.
  assert.ok(/:disabled="!clientEmail/.test(html),
    'create+email button must disable when clientEmail is empty (Alpine binding)');
  assert.ok(/Add client email to send/.test(html),
    'placeholder label nudges the user to type an email when the button is disabled');
  assert.ok(/Create &amp; email to client/.test(html) || /Create & email to client/.test(html),
    'active label promises the combined action');
}

async function testViewRendersDualButtonsForAgency() {
  const html = await renderForm({
    user: { id: 1, plan: 'agency', invoice_count: 0, name: 'Alice', email: 'a@x.com', business_name: 'Acme Studio' }
  });
  assert.ok(html.includes('value="create_and_email"'),
    'agency users get parity with Pro on the create+email surface');
  assert.ok(html.includes('data-testid="invoice-new-submit-email"'),
    'agency: dual-CTA pair renders');
}

async function testViewHidesDualButtonsForFree() {
  const html = await renderForm({
    user: { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com', business_name: 'Acme Studio' }
  });
  assert.ok(!html.includes('value="create_and_email"'),
    'free user MUST NOT see the Pro-only create+email button (server hard-rejects anyway)');
  assert.ok(!html.includes('data-testid="invoice-new-email-hint"'),
    'free user does not see the Pro-only email hint copy');
  // Free users now see the one-tap share shortcuts row (mailto / SMS /
  // WhatsApp) shipped in the free-tier /invoices/new activation ladder —
  // separate from the Pro create_and_email dual-CTA. Coverage for the
  // shortcuts row itself lives in tests/invoice-new-share-shortcuts.test.js.
  assert.ok(!html.includes('data-testid="invoice-new-submit"'),
    'free user with the shortcuts row must NOT see the fallback single-primary submit button');
}

async function testViewHidesDualButtonsForTrial() {
  // Trials are persisted as plan='free' (free + trial_ends_at). The plan-gate
  // string is the source of truth, so trial users see the same single-button
  // form as free users. Document the behaviour with an explicit assertion
  // so a future refactor that conflates trial as "pro-like" doesn't silently
  // unlock the email send for free-tier emails.
  const html = await renderForm({
    user: { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com', business_name: 'Acme Studio', trial_ends_at: new Date(Date.now() + 86400000) }
  });
  assert.ok(!html.includes('value="create_and_email"'),
    'trial (persisted as plan=free) MUST NOT surface the create+email button');
}

async function testViewSingleButtonOnEditFlow() {
  // Non-draft edit-flow (sent / paid / overdue) keeps the single "Save
  // changes" button — the create_and_email semantics don't make sense for
  // an already-sent invoice (use POST /:id/email-client for that). Draft-
  // edit gets its own update_and_email surface (covered by
  // tests/invoice-edit-share-shortcuts.test.js).
  const html = await renderForm({
    invoice: {
      id: 42,
      invoice_number: 'INV-2026-0042',
      client_name: 'Acme',
      client_email: 'pay@acme.com',
      client_address: null,
      issued_date: new Date('2026-05-01'),
      due_date: new Date('2026-05-31'),
      items: [{ description: 'Work', quantity: 1, unit_price: 500 }],
      tax_rate: 0,
      notes: null,
      status: 'sent'
    },
    user: { id: 1, plan: 'pro', invoice_count: 5, name: 'Alice', email: 'a@x.com', business_name: 'Acme Studio' }
  });
  assert.ok(!html.includes('value="create_and_email"'),
    'edit-flow MUST NOT render the create+email button (even for Pro)');
  assert.ok(!html.includes('value="update_and_email"'),
    'sent-invoice edit-flow MUST NOT render the update_and_email button — the shortcut only fires on drafts');
  assert.ok(html.includes('Save changes'),
    'sent-invoice edit-flow keeps the "Save changes" label on the single submit button');
  assert.ok(html.includes('data-testid="invoice-new-submit"'),
    'sent-invoice edit-flow uses the single primary submit button');
}

// ---------------------------------------------------------------------------
// Layer 2 — POST /invoices/new with action=create_and_email
// ---------------------------------------------------------------------------

async function testPostCreateAndEmailProHappyPath() {
  resetStore();
  users.set(1, { id: 1, plan: 'pro', invoice_count: 0, name: 'Alice', email: 'a@x.com', business_name: 'Acme Studio' });
  emailSendImpl = async () => ({ ok: true, id: 'em_pro_happy' });
  const routes = installDbStub();
  const session = { user: { id: 1, plan: 'pro', invoice_count: 0 }, flash: null };
  const app = buildApp(null, routes, session);

  const res = await request(app, 'POST', '/invoices/new',
    postBody({ action: 'create_and_email', client_email: 'pay@acme.com' }));
  assert.strictEqual(res.status, 302, 'create_and_email must redirect to /invoices/:id');
  assert.ok(/^\/invoices\/\d+$/.test(res.headers.location),
    `must redirect to /invoices/<id>, got ${res.headers.location}`);
  assert.strictEqual(createCalls.length, 1, 'createInvoice still fires');
  assert.strictEqual(emailSendCalls.length, 1, 'sendInvoiceEmail fires exactly once');
  assert.strictEqual(emailSendCalls[0].invoice.client_email, 'pay@acme.com',
    'sendInvoiceEmail receives the just-created invoice with the typed email');
  assert.strictEqual(emailSendCalls[0].owner.id, 1,
    'sendInvoiceEmail receives the owner user');
  assert.strictEqual(markSentCalls.length, 1,
    'markInvoiceSentFromShareIntent flips draft → sent after a successful send');
  assert.strictEqual(markSentCalls[0].userId, 1,
    'flip carries the session user id (defence vs cross-tenant flip)');
  assert.ok(session.flash, 'session flash must be set on success');
  assert.strictEqual(session.flash.type, 'success',
    'success flash on create+email happy path');
  assert.ok(/pay@acme\.com/.test(session.flash.message),
    'success flash must name the recipient address');
  assert.ok(/emailed/i.test(session.flash.message),
    'success flash must say "emailed" so the user knows it actually shipped');
}

async function testPostCreateAndEmailTriggersFirstSentCelebration() {
  // The first-sent-celebration helper stamps users.first_sent_at the first
  // time a non-seed invoice is sent. Advanced-form Pro users hitting the
  // combined action ARE the first-sent cohort the celebration was built
  // for (line-items + tax often correlate with higher-LTV sends). Lock in
  // the trigger so a future refactor that drops the call doesn't silently
  // skip the celebration on this codepath.
  resetStore();
  users.set(1, { id: 1, plan: 'pro', invoice_count: 0, name: 'Alice', email: 'a@x.com', business_name: 'Acme Studio' });
  emailSendImpl = async () => ({ ok: true, id: 'em_celebration' });
  const routes = installDbStub();
  const session = { user: { id: 1, plan: 'pro', invoice_count: 0 }, flash: null };
  const app = buildApp(null, routes, session);

  await request(app, 'POST', '/invoices/new',
    postBody({ action: 'create_and_email' }));

  // Allow the celebration .catch chain to flush (it's fire-and-forget after
  // the markSent stamp). A microtask tick suffices because the test stub
  // resolves synchronously.
  await new Promise(r => setImmediate(r));
  assert.strictEqual(firstSentStampCalls.length, 1,
    'first-sent celebration helper called exactly once on a successful create+email');
  assert.strictEqual(firstSentStampCalls[0].userId, 1,
    'celebration stamps the session user id');
}

async function testPostCreateAndEmailAgencyParity() {
  resetStore();
  users.set(1, { id: 1, plan: 'agency', invoice_count: 0, name: 'Alice', email: 'a@x.com', business_name: 'Acme Studio' });
  emailSendImpl = async () => ({ ok: true, id: 'em_agency_new' });
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'agency', invoice_count: 0 }, routes);

  await request(app, 'POST', '/invoices/new',
    postBody({ action: 'create_and_email' }));
  assert.strictEqual(emailSendCalls.length, 1,
    'agency plan gets create+email parity with Pro');
  assert.strictEqual(markSentCalls.length, 1,
    'agency plan gets the auto-flip too');
}

async function testPostCreateAndEmailFreeUserDefenceInDepth() {
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com', business_name: 'Acme Studio' });
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 0 }, routes);

  const res = await request(app, 'POST', '/invoices/new',
    postBody({ action: 'create_and_email' }));
  assert.strictEqual(res.status, 302, 'free user must still get the invoice created');
  assert.strictEqual(createCalls.length, 1, 'createInvoice still fires');
  assert.strictEqual(emailSendCalls.length, 0,
    'free user MUST NOT trigger an email send even if action=create_and_email is forged in the payload');
  assert.strictEqual(markSentCalls.length, 0,
    'free user MUST NOT have the invoice auto-flipped to sent');
}

async function testPostCreateAndEmailMissingEmailNoSend() {
  resetStore();
  users.set(1, { id: 1, plan: 'pro', invoice_count: 0, name: 'Alice', email: 'a@x.com', business_name: 'Acme Studio' });
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'pro', invoice_count: 0 }, routes);

  const res = await request(app, 'POST', '/invoices/new',
    postBody({ action: 'create_and_email', client_email: '' }));
  assert.strictEqual(res.status, 302, 'invoice still creates on missing email');
  assert.strictEqual(createCalls.length, 1);
  assert.strictEqual(emailSendCalls.length, 0,
    'no client_email → no email send (we short-circuit before calling sendInvoiceEmail)');
  assert.strictEqual(markSentCalls.length, 0,
    'no email send → no draft→sent flip');
}

async function testPostCreateOnlyDoesNotSend() {
  resetStore();
  users.set(1, { id: 1, plan: 'pro', invoice_count: 0, name: 'Alice', email: 'a@x.com', business_name: 'Acme Studio' });
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'pro', invoice_count: 0 }, routes);

  await request(app, 'POST', '/invoices/new',
    postBody({ action: 'create_only' }));
  assert.strictEqual(createCalls.length, 1);
  assert.strictEqual(emailSendCalls.length, 0,
    'create_only must NOT trigger email even when client_email is present');
  assert.strictEqual(markSentCalls.length, 0,
    'create_only leaves status as draft');
}

async function testPostNoActionFieldDefaultsToCreateOnly() {
  // Backwards-compatibility guard: pre-this-ship clients that don't post any
  // action field MUST still create + redirect, with no send. A future
  // refactor that defaulted action='create_and_email' would silently flip
  // every advanced-form Pro create into an auto-send.
  resetStore();
  users.set(1, { id: 1, plan: 'pro', invoice_count: 0, name: 'Alice', email: 'a@x.com', business_name: 'Acme Studio' });
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'pro', invoice_count: 0 }, routes);

  const body = postBody({});
  delete body.action;
  await request(app, 'POST', '/invoices/new', body);
  assert.strictEqual(createCalls.length, 1);
  assert.strictEqual(emailSendCalls.length, 0,
    'absent action field MUST default to create-only (no auto-send)');
  assert.strictEqual(markSentCalls.length, 0);
}

async function testPostCreateAndEmailNotConfiguredKeepsDraft() {
  resetStore();
  users.set(1, { id: 1, plan: 'pro', invoice_count: 0, name: 'Alice', email: 'a@x.com', business_name: 'Acme Studio' });
  emailSendImpl = async () => ({ ok: false, reason: 'not_configured' });
  const routes = installDbStub();
  const session = { user: { id: 1, plan: 'pro', invoice_count: 0 }, flash: null };
  const app = buildApp(null, routes, session);

  const res = await request(app, 'POST', '/invoices/new',
    postBody({ action: 'create_and_email' }));
  assert.strictEqual(res.status, 302,
    'still redirect to /invoices/:id even on email send failure');
  assert.strictEqual(createCalls.length, 1,
    'invoice still created on send failure (graceful degrade)');
  assert.strictEqual(emailSendCalls.length, 1, 'send was attempted');
  assert.strictEqual(markSentCalls.length, 0,
    'failed send MUST NOT flip status (dashboard truthfully shows draft so the user retries)');
  assert.ok(session.flash, 'flash must be set');
  assert.strictEqual(session.flash.type, 'error',
    'send failure must surface as an error flash, not a silent fallback');
  assert.ok(/configured|not yet/i.test(session.flash.message),
    'flash copy must explain the not-configured cause so the user knows why');
}

async function testPostCreateAndEmailGenericFailureKeepsDraft() {
  resetStore();
  users.set(1, { id: 1, plan: 'pro', invoice_count: 0, name: 'Alice', email: 'a@x.com', business_name: 'Acme Studio' });
  emailSendImpl = async () => ({ ok: false, reason: 'error', error: 'boom' });
  const routes = installDbStub();
  const session = { user: { id: 1, plan: 'pro', invoice_count: 0 }, flash: null };
  const app = buildApp(null, routes, session);

  await request(app, 'POST', '/invoices/new',
    postBody({ action: 'create_and_email' }));
  assert.strictEqual(createCalls.length, 1,
    'invoice still created on Resend send error');
  assert.strictEqual(markSentCalls.length, 0,
    'no status flip on send error');
  assert.strictEqual(session.flash.type, 'error', 'error flash');
  assert.ok(/share buttons/i.test(session.flash.message),
    'flash must point user at the share buttons as a fallback path');
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function run() {
  const tests = [
    testViewRendersDualButtonsForPro,
    testViewDisabledBindingTiesToClientEmail,
    testViewRendersDualButtonsForAgency,
    testViewHidesDualButtonsForFree,
    testViewHidesDualButtonsForTrial,
    testViewSingleButtonOnEditFlow,
    testPostCreateAndEmailProHappyPath,
    testPostCreateAndEmailTriggersFirstSentCelebration,
    testPostCreateAndEmailAgencyParity,
    testPostCreateAndEmailFreeUserDefenceInDepth,
    testPostCreateAndEmailMissingEmailNoSend,
    testPostCreateOnlyDoesNotSend,
    testPostNoActionFieldDefaultsToCreateOnly,
    testPostCreateAndEmailNotConfiguredKeepsDraft,
    testPostCreateAndEmailGenericFailureKeepsDraft
  ];
  let failed = 0;
  for (const fn of tests) {
    try {
      await fn();
      console.log(`  ✓ ${fn.name}`);
    } catch (err) {
      failed += 1;
      console.error(`  ✗ ${fn.name}`);
      console.error(err && err.stack ? err.stack : err);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
