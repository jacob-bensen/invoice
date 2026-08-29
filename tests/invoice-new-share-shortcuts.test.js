'use strict';

/*
 * /invoices/new + action=create_and_{whatsapp,sms,mailto} — free-tier
 * one-tap share shortcuts (Milestone 3 — first invoice created → first
 * invoice sent).
 *
 * /invoices/quick already collapses the "create → land on /:id → tap a
 * share button" three-step into a single submit for free-tier users via
 * three sibling action buttons (mailto / SMS / WhatsApp). The advanced
 * form at /invoices/new — the activation path for freelancers with
 * multiple line items, tax, custom due dates, notes, or custom invoice
 * numbers — had NO one-tap send lane at all for the free cohort: they
 * could only Save-as-draft, then bounce to /invoices/:id and click a
 * share button from there. That extra round-trip is exactly the "biggest
 * single drop-off" PLAN.md names on this milestone.
 *
 * This file mirrors tests/invoice-quick-create-and-{whatsapp,sms,mailto}
 * against POST /invoices/new + views/invoice-form.ejs so the same shape
 * of guarantees pinned on the quick form applies to the advanced form.
 *
 * Layered coverage:
 *   - Layer 1: view invoice-form.ejs render shape
 *       * Free user (new-flow): draft + mailto + SMS + WhatsApp buttons
 *       * Free user: share-hint copy present
 *       * Free user: mailto button is Alpine x-show-gated on clientEmail
 *       * Pro user (new-flow): shortcuts NOT rendered — keeps create_and_email
 *       * Agency user (new-flow): parity with Pro
 *       * Edit-flow (invoice set): single "Save changes" button, no shortcuts
 *   - Layer 2: route POST /invoices/new
 *       * create_and_whatsapp happy path → 302 wa.me/…, flip, celebration
 *       * create_and_sms happy path → 302 sms:…, flip, celebration
 *       * create_and_mailto happy path → 302 mailto:<client>, flip, celebration
 *       * create_and_mailto missing client_email → fallback to /:id, no flip
 *       * token-mint failure on whatsapp → fallback to /:id with error flash
 *       * absent action defaults to create-only (no flip, no send)
 *       * flash names invoice_number + confirms sent status
 *       * SMS / WhatsApp URL body contains the public /i/<token> URL
 *
 * Run: NODE_ENV=test node tests/invoice-new-share-shortcuts.test.js
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
const recordFirstSentCalls = [];
const mintTokenCalls = [];
let nextInvoiceId = 800;
let mintTokenImpl = null;

function resetStore() {
  users.clear();
  createCalls.length = 0;
  markSentCalls.length = 0;
  recordFirstSentCalls.length = 0;
  mintTokenCalls.length = 0;
  nextInvoiceId = 800;
  mintTokenImpl = null;
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
        const row = Object.assign({ id, status: 'draft', is_seed: false }, data);
        const u = users.get(data.user_id);
        if (u) u.invoice_count = (u.invoice_count || 0) + 1;
        return row;
      },
      async markInvoiceSentFromShareIntent(invoiceId, userId) {
        markSentCalls.push({ invoiceId, userId });
        return { id: invoiceId, status: 'sent', sent_via_share_intent_at: new Date() };
      },
      async recordFirstSentIfMissing(userId) {
        recordFirstSentCalls.push(userId);
        const u = users.get(userId);
        if (u && !u._firstSentStamped) {
          u._firstSentStamped = true;
          return Object.assign({}, u, { first_sent_at: new Date() });
        }
        return null;
      },
      async updateUser(id, fields) {
        const u = users.get(id);
        if (u) Object.assign(u, fields);
        return u || null;
      },
      async clearPendingQuickInvoice() {},
      async getOrCreatePublicToken(invoiceId, userId) {
        mintTokenCalls.push({ invoiceId, userId });
        if (mintTokenImpl) return mintTokenImpl(invoiceId, userId);
        return 'abc1234567890def';
      },
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
  delete require.cache[require.resolve('../lib/email')];
  delete require.cache[require.resolve('../lib/magic-login')];
  delete require.cache[require.resolve('../lib/first-sent-celebration')];
  delete require.cache[require.resolve('../routes/invoices')];
  return require('../routes/invoices');
}

function buildApp(sessionUser, invoiceRoutes) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  const sessionRef = { user: sessionUser ? Object.assign({}, sessionUser) : null, flash: null };
  app.use((req, _res, next) => {
    req.session = sessionRef;
    next();
  });
  app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    res.locals.csrfToken = 'test-csrf';
    next();
  });
  app.use('/invoices', invoiceRoutes);
  app._sessionRef = sessionRef;
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
    client_name: 'Acme Corp',
    client_email: 'billing@acme.com',
    client_phone: '+14155551234',
    client_address: '',
    items: JSON.stringify([
      { description: 'Brand work', quantity: 1, unit_price: 500 }
    ]),
    subtotal: '500',
    tax_rate: '0',
    tax_amount: '0',
    total: '500',
    notes: ''
  }, extra || {});
}

// ============================================================================
// Layer 1 — view invoice-form.ejs render shape
// ============================================================================

async function renderForm(opts) {
  const viewsDir = path.join(__dirname, '..', 'views');
  return ejs.renderFile(path.join(viewsDir, 'invoice-form.ejs'),
    Object.assign({
      title: 'New Invoice',
      invoice: null,
      invoiceNumber: 'INV-2026-0001',
      recentClients: [],
      user: { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com', business_name: 'Acme Studio', payment_instructions: null },
      flash: null,
      csrfToken: 'tkn'
    }, opts || {}),
    { views: [viewsDir] });
}

async function testViewFreeRendersAllThreeShortcuts() {
  const html = await renderForm({
    user: { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com', business_name: 'Acme Studio' }
  });
  assert.ok(html.includes('data-testid="invoice-new-submit-draft"'),
    'free user must still see the "Save as draft" secondary button');
  assert.ok(html.includes('value="create_only"'),
    'draft button submits action=create_only');
  assert.ok(html.includes('data-testid="invoice-new-submit-mailto"'),
    'free user must see the Create & open Email shortcut');
  assert.ok(html.includes('value="create_and_mailto"'),
    'mailto button submits action=create_and_mailto');
  assert.ok(html.includes('data-testid="invoice-new-submit-sms"'),
    'free user must see the Create & open SMS shortcut');
  assert.ok(html.includes('value="create_and_sms"'),
    'sms button submits action=create_and_sms');
  assert.ok(html.includes('data-testid="invoice-new-submit-whatsapp"'),
    'free user must see the Create & open WhatsApp shortcut');
  assert.ok(html.includes('value="create_and_whatsapp"'),
    'whatsapp button submits action=create_and_whatsapp');
  // Single-primary fallback button must NOT render when the shortcuts row is on.
  assert.ok(!html.includes('data-testid="invoice-new-submit"'),
    'free user with shortcuts row must NOT see the fallback single-primary button');
  // Pro-only Create & email button must NOT render for a free user.
  assert.ok(!html.includes('value="create_and_email"'),
    'free user MUST NOT see the Pro-only create_and_email button');
}

async function testViewFreeRendersShareHint() {
  const html = await renderForm({
    user: { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com', business_name: 'Acme Studio' }
  });
  assert.ok(html.includes('data-testid="invoice-new-share-hint"'),
    'free user sees the share-hint copy below the buttons');
  assert.ok(/Open Email.*Open SMS.*Open WhatsApp/s.test(html),
    'share-hint copy names all three channels so the user knows what each button does');
  assert.ok(/marks this as sent/i.test(html),
    'share-hint copy explains the atomic flip so the user is not surprised by the sent status');
}

async function testViewFreeMailtoButtonIsGatedOnClientEmail() {
  const html = await renderForm({
    user: { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com', business_name: 'Acme Studio' }
  });
  // The Alpine x-show binding hides the mailto button when the client-email
  // field is empty — otherwise the free-tier form would show a "Create &
  // open Email" button that produces a mailto: with no recipient. Pin the
  // exact expression so a future refactor cannot silently drop the gate.
  const gate = 'x-show="clientEmail && clientEmail.trim()"';
  assert.ok(html.includes(gate),
    `mailto button must be Alpine-gated on the invoiceEditor scope's clientEmail field; expected ${gate}, got HTML that lacks it`);
}

async function testViewProDoesNotRenderShortcuts() {
  const html = await renderForm({
    user: { id: 1, plan: 'pro', invoice_count: 0, name: 'Bob', email: 'b@x.com', business_name: 'Acme Studio' }
  });
  assert.ok(!html.includes('value="create_and_mailto"'),
    'Pro user MUST NOT see the free-tier mailto shortcut');
  assert.ok(!html.includes('value="create_and_sms"'),
    'Pro user MUST NOT see the free-tier SMS shortcut');
  assert.ok(!html.includes('value="create_and_whatsapp"'),
    'Pro user MUST NOT see the free-tier WhatsApp shortcut');
  assert.ok(!html.includes('data-testid="invoice-new-share-hint"'),
    'Pro user does not see the free-tier share hint copy');
  // Pro keeps its own dual-CTA pair (untouched by this ship).
  assert.ok(html.includes('value="create_and_email"'),
    'Pro user MUST still see the create_and_email button');
}

async function testViewAgencyDoesNotRenderShortcuts() {
  const html = await renderForm({
    user: { id: 1, plan: 'agency', invoice_count: 0, name: 'Bob', email: 'b@x.com', business_name: 'Acme Studio' }
  });
  assert.ok(!html.includes('value="create_and_mailto"'),
    'Agency user MUST NOT see the free-tier mailto shortcut');
  assert.ok(!html.includes('value="create_and_sms"'),
    'Agency user MUST NOT see the free-tier SMS shortcut');
  assert.ok(!html.includes('value="create_and_whatsapp"'),
    'Agency user MUST NOT see the free-tier WhatsApp shortcut');
  assert.ok(html.includes('value="create_and_email"'),
    'Agency user keeps parity with Pro on create_and_email');
}

async function testViewEditFlowDoesNotRenderShortcuts() {
  // Edit-flow on a non-draft invoice (sent / paid / overdue) is past-
  // activation for the freelancer AND the create_and_* semantics don't
  // make sense on an already-existing invoice (use POST /:id/share-intent
  // or /:id/email-client for that). The single "Save changes" button is
  // the right affordance. (Draft-edit has its own update_and_* shortcuts
  // covered by tests/invoice-edit-share-shortcuts.test.js.)
  const html = await renderForm({
    invoice: {
      id: 42,
      invoice_number: 'INV-2026-0042',
      client_name: 'Acme',
      client_email: 'pay@acme.com',
      client_address: null,
      client_phone: null,
      issued_date: new Date('2026-05-01'),
      due_date: new Date('2026-05-31'),
      items: [{ description: 'Work', quantity: 1, unit_price: 500 }],
      tax_rate: 0,
      notes: null,
      status: 'sent'
    },
    user: { id: 1, plan: 'free', invoice_count: 5, name: 'Alice', email: 'a@x.com', business_name: 'Acme Studio' }
  });
  assert.ok(!html.includes('value="create_and_mailto"'),
    'sent-invoice edit-flow MUST NOT render the free-tier mailto shortcut');
  assert.ok(!html.includes('value="create_and_sms"'),
    'sent-invoice edit-flow MUST NOT render the free-tier SMS shortcut');
  assert.ok(!html.includes('value="create_and_whatsapp"'),
    'sent-invoice edit-flow MUST NOT render the free-tier WhatsApp shortcut');
  assert.ok(!html.includes('value="update_and_mailto"'),
    'sent-invoice edit-flow MUST NOT render the update_and_* trio — those only apply to drafts');
  assert.ok(html.includes('Save changes'),
    'sent-invoice edit-flow keeps the "Save changes" label on the single submit button');
  assert.ok(html.includes('data-testid="invoice-new-submit"'),
    'sent-invoice edit-flow uses the single primary submit button');
}

// ============================================================================
// Layer 2 — route POST /invoices/new
// ============================================================================

async function testPostCreateAndWhatsappHappyPath() {
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  process.env.APP_URL = 'https://decentinvoice.example';
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 0 }, routes);

  const res = await request(app, 'POST', '/invoices/new',
    postBody({ action: 'create_and_whatsapp' }));

  assert.strictEqual(res.status, 302,
    'create_and_whatsapp must redirect (302)');
  assert.ok(/^https:\/\/wa\.me\//.test(res.headers.location),
    `must redirect to wa.me deep link, got ${res.headers.location}`);
  assert.ok(res.headers.location.includes('14155551234'),
    'wa.me URL must embed the normalised client phone');
  const bodyPart = res.headers.location.split('text=')[1] || '';
  const decoded = decodeURIComponent(bodyPart);
  assert.ok(decoded.includes('https://decentinvoice.example/i/abc1234567890def'),
    `whatsapp body must embed the public /i/<token> URL, got: ${decoded}`);
  assert.strictEqual(createCalls.length, 1, 'createInvoice fired exactly once');
  assert.strictEqual(markSentCalls.length, 1,
    'markInvoiceSentFromShareIntent flips draft → sent atomically');
  assert.strictEqual(markSentCalls[0].userId, 1,
    'flip carries the session user id (defence vs cross-tenant flip)');
}

async function testPostCreateAndSmsHappyPath() {
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  process.env.APP_URL = 'https://decentinvoice.example';
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 0 }, routes);

  const res = await request(app, 'POST', '/invoices/new',
    postBody({ action: 'create_and_sms' }));

  assert.strictEqual(res.status, 302,
    'create_and_sms must redirect (302)');
  assert.ok(/^sms:/.test(res.headers.location),
    `must redirect to sms: deep link, got ${res.headers.location}`);
  const bodyPart = res.headers.location.split('body=')[1] || '';
  const decoded = decodeURIComponent(bodyPart);
  assert.ok(decoded.includes('https://decentinvoice.example/i/abc1234567890def'),
    `sms body must embed the public /i/<token> URL, got: ${decoded}`);
  assert.strictEqual(createCalls.length, 1);
  assert.strictEqual(markSentCalls.length, 1,
    'markInvoiceSentFromShareIntent flips draft → sent atomically');
}

async function testPostCreateAndMailtoHappyPath() {
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  process.env.APP_URL = 'https://decentinvoice.example';
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 0 }, routes);

  const res = await request(app, 'POST', '/invoices/new',
    postBody({ action: 'create_and_mailto' }));

  assert.strictEqual(res.status, 302,
    'create_and_mailto must redirect (302)');
  assert.ok(/^mailto:/.test(res.headers.location),
    `must redirect to mailto: deep link, got ${res.headers.location}`);
  assert.ok(res.headers.location.includes(encodeURIComponent('billing@acme.com')),
    `mailto: URL must embed the client email as recipient, got: ${res.headers.location}`);
  const bodyPart = res.headers.location.split('body=')[1] || '';
  const decoded = decodeURIComponent(bodyPart);
  assert.ok(decoded.includes('https://decentinvoice.example/i/abc1234567890def'),
    `mailto body must embed the public /i/<token> URL, got: ${decoded}`);
  assert.strictEqual(createCalls.length, 1);
  assert.strictEqual(markSentCalls.length, 1,
    'markInvoiceSentFromShareIntent flips draft → sent atomically');
}

async function testPostCreateAndMailtoMissingClientEmailFallsBack() {
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  process.env.APP_URL = 'https://decentinvoice.example';
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 0 }, routes);

  const res = await request(app, 'POST', '/invoices/new',
    postBody({ action: 'create_and_mailto', client_email: '' }));

  assert.strictEqual(res.status, 302,
    'redirects even with no client_email (graceful degrade)');
  assert.ok(/^\/invoices\/\d+$/.test(res.headers.location),
    `no client_email → fall through to /:id so user can add one and retry, got ${res.headers.location}`);
  assert.strictEqual(createCalls.length, 1,
    'invoice still created — the draft is a real save, not lost');
  assert.strictEqual(markSentCalls.length, 0,
    'no flip when client_email is missing — mailto: with empty recipient defeats the shortcut');
  const flash = app._sessionRef.flash;
  assert.ok(flash, 'flash must be set on the fallback path');
  assert.strictEqual(flash.type, 'error',
    'missing-email fallback uses error flash');
  assert.ok(/Email/i.test(flash.message),
    'fallback flash mentions Email so the user knows where to tap next');
}

async function testPostCreateAndWhatsappTokenMintFailureFallsBack() {
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  mintTokenImpl = async () => null;
  process.env.APP_URL = 'https://decentinvoice.example';
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 0 }, routes);

  const res = await request(app, 'POST', '/invoices/new',
    postBody({ action: 'create_and_whatsapp' }));

  assert.strictEqual(res.status, 302,
    'still redirects even when share URL cannot be built (graceful degrade)');
  assert.ok(/^\/invoices\/\d+$/.test(res.headers.location),
    `must fall through to /invoices/:id so user can tap WhatsApp from draft-send-banner, got ${res.headers.location}`);
  assert.strictEqual(createCalls.length, 1, 'invoice still created');
  assert.strictEqual(markSentCalls.length, 0,
    'no flip when share URL cannot be built — dashboard truthfully shows draft so user can retry');
  const flash = app._sessionRef.flash;
  assert.ok(flash, 'flash must be set on the fallback path');
  assert.strictEqual(flash.type, 'error',
    'fallback uses error flash so the user knows something went sideways');
  assert.ok(/WhatsApp/i.test(flash.message),
    'fallback flash mentions WhatsApp so the user knows where to tap next');
}

async function testPostNoActionDefaultsToCreateOnly() {
  // Backwards-compatibility guard: absent action field MUST still create +
  // redirect to /:id, with no send and no flip. A future refactor that
  // defaulted action='create_and_whatsapp' would silently auto-send every
  // draft submission.
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 0 }, routes);

  const body = postBody({});
  delete body.action;
  const res = await request(app, 'POST', '/invoices/new', body);
  assert.strictEqual(res.status, 302);
  assert.ok(/^\/invoices\/\d+$/.test(res.headers.location),
    'absent action → redirect to /:id (no share deep link)');
  assert.strictEqual(createCalls.length, 1, 'createInvoice still fires');
  assert.strictEqual(markSentCalls.length, 0,
    'absent action MUST NOT flip status — draft persists for user to send later');
}

async function testPostCreateAndSmsFiresCelebration() {
  // The first-sent celebration is the reward loop that keeps freelancers
  // returning to the app after their first send. Lock in the trigger on
  // the /new shortcut path so a future refactor that drops the call
  // doesn't silently skip celebrating this cohort.
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  process.env.APP_URL = 'https://decentinvoice.example';
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 0 }, routes);

  await request(app, 'POST', '/invoices/new',
    postBody({ action: 'create_and_sms' }));

  await new Promise(r => setImmediate(r));

  assert.strictEqual(recordFirstSentCalls.length, 1,
    'first-sent celebration → recordFirstSentIfMissing called exactly once on first sent invoice via /new SMS shortcut');
  assert.strictEqual(recordFirstSentCalls[0], 1,
    'first-sent stamp carries the correct user id');
}

async function testPostCreateAndMailtoFlashNamesInvoiceAndRecipient() {
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  process.env.APP_URL = 'https://decentinvoice.example';
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 0 }, routes);

  await request(app, 'POST', '/invoices/new',
    postBody({ action: 'create_and_mailto', invoice_number: 'INV-2026-0007' }));

  const flash = app._sessionRef.flash;
  assert.ok(flash, 'flash must be set so the user sees it when they return from their mail client');
  assert.strictEqual(flash.type, 'success',
    'success flash type — invoice was atomically marked sent');
  assert.ok(/INV-2026-0007/.test(flash.message),
    `flash must name the invoice_number, got: ${flash.message}`);
  assert.ok(/billing@acme\.com/.test(flash.message),
    `flash must name the recipient email the mailto: was pre-addressed to, got: ${flash.message}`);
  assert.ok(/marked as sent/i.test(flash.message),
    'flash must confirm the sent status');
}

// ============================================================================
// Runner
// ============================================================================

async function run() {
  const tests = [
    ['view: free-tier renders draft + mailto + SMS + WhatsApp buttons', testViewFreeRendersAllThreeShortcuts],
    ['view: free-tier renders the share-hint copy', testViewFreeRendersShareHint],
    ['view: mailto button is Alpine x-show-gated on clientEmail', testViewFreeMailtoButtonIsGatedOnClientEmail],
    ['view: Pro user does NOT render the free-tier shortcuts', testViewProDoesNotRenderShortcuts],
    ['view: Agency user does NOT render the free-tier shortcuts', testViewAgencyDoesNotRenderShortcuts],
    ['view: edit-flow does NOT render the shortcuts', testViewEditFlowDoesNotRenderShortcuts],
    ['route: create_and_whatsapp → 302 wa.me/<phone> with public URL embedded', testPostCreateAndWhatsappHappyPath],
    ['route: create_and_sms → 302 sms:<phone> with public URL embedded', testPostCreateAndSmsHappyPath],
    ['route: create_and_mailto → 302 mailto:<client> with public URL embedded', testPostCreateAndMailtoHappyPath],
    ['route: create_and_mailto missing client_email falls back to /:id (no flip)', testPostCreateAndMailtoMissingClientEmailFallsBack],
    ['route: create_and_whatsapp token-mint failure falls back to /:id with error flash', testPostCreateAndWhatsappTokenMintFailureFallsBack],
    ['route: absent action defaults to create-only (no flip, no share URL)', testPostNoActionDefaultsToCreateOnly],
    ['route: create_and_sms fires first-sent celebration on atomic flip', testPostCreateAndSmsFiresCelebration],
    ['route: create_and_mailto flash names invoice_number + recipient', testPostCreateAndMailtoFlashNamesInvoiceAndRecipient]
  ];
  let passed = 0, failed = 0;
  for (const [label, fn] of tests) {
    try {
      await fn();
      console.log(`  ok  ${label}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL ${label}`);
      console.error('       ', err && (err.stack || err.message || err));
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
