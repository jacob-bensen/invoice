'use strict';

/*
 * /invoices/:id/edit + action=update_and_{email,mailto,sms,whatsapp} — edit-
 * path one-tap send shortcuts (Milestone 3 — first invoice created → first
 * invoice sent).
 *
 * POST /invoices/new already collapses create → land on /:id → tap-send into
 * a single submit via action=create_and_{email,mailto,sms,whatsapp}. Editing
 * an existing draft (a stale-draft return path, or a "let me fix the price
 * first" beat) had the same drop-off: "Save changes → land on /:id → tap the
 * draft-send banner". Every extra tap at the point of maximum abandon costs
 * activation. This ship mirrors the /new shortcut shape into POST /:id/edit
 * so an editing freelancer never has to leave the edit form to send.
 *
 * Layered coverage:
 *   - Layer 1: view invoice-form.ejs render shape on edit path
 *       * Free draft-edit: draft + mailto + SMS + WhatsApp buttons + hint
 *       * Free draft-edit: mailto button is Alpine x-show-gated on clientEmail
 *       * Pro draft-edit: update_and_email button + hint (no free shortcuts)
 *       * Agency draft-edit: parity with Pro
 *       * Sent invoice edit: single "Save changes" button (no shortcuts)
 *       * Paid invoice edit: single "Save changes" button (no shortcuts)
 *       * New-flow (no invoice) unchanged: create_and_* still render
 *   - Layer 2: route POST /invoices/:id/edit
 *       * update_and_whatsapp on draft → 302 wa.me/…, flip, celebration
 *       * update_and_sms on draft → 302 sms:…, flip, celebration
 *       * update_and_mailto on draft → 302 mailto:<client>, flip, celebration
 *       * update_and_email on Pro draft → sendInvoiceEmail + flip + celebration
 *       * update_and_email on free draft → NO send (plan hard-gate), no flip
 *       * update_and_mailto missing client_email → fallback to /:id, no flip
 *       * token-mint failure on whatsapp → fallback to /:id with error flash
 *       * update_and_* against sent invoice → no flip (status guard)
 *       * absent action → legacy behavior: update + redirect, no flip, no send
 *       * SMS URL body contains the public /i/<token> URL
 *       * requestedStatus pinned to draft even if form submitted status='paid'
 *
 * Run: NODE_ENV=test node tests/invoice-edit-share-shortcuts.test.js
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
const invoicesById = new Map();
const updateCalls = [];
const markSentCalls = [];
const recordFirstSentCalls = [];
const mintTokenCalls = [];
const emailCalls = [];
let mintTokenImpl = null;
let emailImpl = null;

function resetStore() {
  users.clear();
  invoicesById.clear();
  updateCalls.length = 0;
  markSentCalls.length = 0;
  recordFirstSentCalls.length = 0;
  mintTokenCalls.length = 0;
  emailCalls.length = 0;
  mintTokenImpl = null;
  emailImpl = null;
}

function seedInvoice(row) {
  invoicesById.set(row.id, row);
  return row;
}

function buildDbStub() {
  return {
    pool: { query: async () => ({ rows: [] }) },
    db: {
      async getUserById(id) { return users.get(id) || null; },
      async getInvoiceById(id, userId) {
        const inv = invoicesById.get(Number(id));
        if (!inv) return null;
        if (Number(inv.user_id) !== Number(userId)) return null;
        return Object.assign({}, inv);
      },
      async getInvoicesByUser() { return []; },
      async getRecentClientsForUser() { return []; },
      async getRecentItemsForUser() { return []; },
      async updateInvoice(id, userId, data) {
        updateCalls.push({ id, userId, data });
        const inv = invoicesById.get(Number(id));
        if (!inv || Number(inv.user_id) !== Number(userId)) return null;
        Object.assign(inv, data, { id: Number(id), user_id: Number(userId) });
        return Object.assign({}, inv);
      },
      async markInvoiceSentFromShareIntent(invoiceId, userId) {
        markSentCalls.push({ invoiceId, userId });
        const inv = invoicesById.get(Number(invoiceId));
        if (!inv || Number(inv.user_id) !== Number(userId)) return null;
        if (inv.status === 'draft') {
          inv.status = 'sent';
          inv.sent_via_share_intent_at = new Date();
        }
        return { id: inv.id, status: inv.status, sent_via_share_intent_at: inv.sent_via_share_intent_at };
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
      async getOrCreatePublicToken(invoiceId, userId) {
        mintTokenCalls.push({ invoiceId, userId });
        if (mintTokenImpl) return mintTokenImpl(invoiceId, userId);
        const inv = invoicesById.get(Number(invoiceId));
        if (inv && inv.public_token) return inv.public_token;
        if (inv) inv.public_token = 'ed7f1234567890ab';
        return 'ed7f1234567890ab';
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
  // Stub the email lib so update_and_email doesn't touch Resend at test time.
  // Every path that awaits sendInvoiceEmail records the call; a per-test
  // override via emailImpl lets us simulate success / not_configured / throws.
  require.cache[require.resolve('../lib/email')] = {
    id: require.resolve('../lib/email'),
    filename: require.resolve('../lib/email'),
    loaded: true,
    exports: {
      sendInvoiceEmail: async (invoice, user) => {
        emailCalls.push({ invoiceId: invoice && invoice.id, userId: user && user.id });
        if (emailImpl) return emailImpl(invoice, user);
        return { ok: true };
      },
      sendWelcomeEmail: async () => ({ ok: true }),
      sendPasswordResetEmail: async () => ({ ok: true }),
      sendMagicLoginEmail: async () => ({ ok: true }),
      sendPaymentReminderEmail: async () => ({ ok: true }),
      sendFirstSentCelebrationEmail: async () => ({ ok: true })
    }
  };
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
    invoice_number: 'INV-2026-0042',
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
    notes: '',
    status: 'draft'
  }, extra || {});
}

function seedDraft(overrides) {
  return seedInvoice(Object.assign({
    id: 42,
    user_id: 1,
    invoice_number: 'INV-2026-0042',
    client_name: 'Acme Corp',
    client_email: 'billing@acme.com',
    client_phone: '+14155551234',
    client_address: '',
    items: [{ description: 'Brand work', quantity: 1, unit_price: 500 }],
    subtotal: 500,
    tax_rate: 0,
    tax_amount: 0,
    total: 500,
    notes: '',
    issued_date: new Date('2026-05-29'),
    due_date: new Date('2026-06-28'),
    status: 'draft',
    is_seed: false,
    public_token: null
  }, overrides || {}));
}

// ============================================================================
// Layer 1 — view invoice-form.ejs render shape on edit path
// ============================================================================

async function renderForm(opts) {
  const viewsDir = path.join(__dirname, '..', 'views');
  return ejs.renderFile(path.join(viewsDir, 'invoice-form.ejs'),
    Object.assign({
      title: 'Edit Invoice',
      invoice: null,
      invoiceNumber: 'INV-2026-0042',
      recentClients: [],
      user: { id: 1, plan: 'free', invoice_count: 5, name: 'Alice', email: 'a@x.com', business_name: 'Acme Studio', payment_instructions: 'Venmo @acme' },
      flash: null,
      csrfToken: 'tkn'
    }, opts || {}),
    { views: [viewsDir] });
}

function draftInvoiceLocal(overrides) {
  return Object.assign({
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
    status: 'draft'
  }, overrides || {});
}

async function testViewFreeDraftEditRendersAllShortcuts() {
  const html = await renderForm({
    invoice: draftInvoiceLocal(),
    user: { id: 1, plan: 'free', invoice_count: 5, name: 'Alice', email: 'a@x.com', business_name: 'Acme Studio', payment_instructions: 'Venmo @acme' }
  });
  assert.ok(html.includes('data-testid="invoice-edit-submit-draft"'),
    'free draft-edit must see the "Save changes" secondary button');
  assert.ok(html.includes('value="update_only"'),
    'save-changes button on edit-path submits action=update_only');
  assert.ok(html.includes('data-testid="invoice-edit-submit-mailto"'),
    'free draft-edit must see the Update & open Email shortcut');
  assert.ok(html.includes('value="update_and_mailto"'),
    'mailto button submits action=update_and_mailto');
  assert.ok(html.includes('data-testid="invoice-edit-submit-sms"'),
    'free draft-edit must see the Update & open SMS shortcut');
  assert.ok(html.includes('value="update_and_sms"'),
    'sms button submits action=update_and_sms');
  assert.ok(html.includes('data-testid="invoice-edit-submit-whatsapp"'),
    'free draft-edit must see the Update & open WhatsApp shortcut');
  assert.ok(html.includes('value="update_and_whatsapp"'),
    'whatsapp button submits action=update_and_whatsapp');
  assert.ok(html.includes('data-testid="invoice-edit-share-hint"'),
    'free draft-edit sees the edit-path share-hint copy below the buttons');
  assert.ok(/Update.*Email.*SMS.*WhatsApp/s.test(html),
    'edit-path share-hint names the three channels the buttons cover');
  assert.ok(!html.includes('data-testid="invoice-new-submit"'),
    'free draft-edit with shortcuts row must NOT show the fallback single-primary button');
}

async function testViewFreeDraftEditMailtoGatedOnClientEmail() {
  const html = await renderForm({
    invoice: draftInvoiceLocal(),
    user: { id: 1, plan: 'free', invoice_count: 5, name: 'Alice', email: 'a@x.com', business_name: 'Acme Studio', payment_instructions: 'Venmo @acme' }
  });
  const gate = 'x-show="clientEmail && clientEmail.trim()"';
  const idx = html.indexOf('data-testid="invoice-edit-submit-mailto"');
  assert.ok(idx > 0, 'mailto edit button must render');
  // Assert the gate expression appears somewhere in the mailto button block
  // (the exact same x-show contract the new-flow mailto button carries).
  const after = html.slice(idx, idx + 400);
  assert.ok(after.includes(gate),
    `mailto button on edit path must be Alpine-gated on clientEmail; expected ${gate}`);
}

async function testViewProDraftEditRendersEmailShortcut() {
  const html = await renderForm({
    invoice: draftInvoiceLocal(),
    user: { id: 1, plan: 'pro', invoice_count: 5, name: 'Bob', email: 'b@x.com', business_name: 'Acme Studio', payment_instructions: null }
  });
  assert.ok(html.includes('data-testid="invoice-edit-submit-draft"'),
    'Pro draft-edit must see the "Save changes" secondary button');
  assert.ok(html.includes('data-testid="invoice-edit-submit-email"'),
    'Pro draft-edit must see the Update & email to client shortcut');
  assert.ok(html.includes('value="update_and_email"'),
    'email button submits action=update_and_email');
  assert.ok(html.includes('data-testid="invoice-edit-email-hint"'),
    'Pro draft-edit sees the edit-path email-hint copy');
  // Pro draft-edit MUST NOT render the free-tier mailto/SMS/WhatsApp trio.
  assert.ok(!html.includes('value="update_and_mailto"'),
    'Pro draft-edit MUST NOT render the free-tier mailto shortcut');
  assert.ok(!html.includes('value="update_and_sms"'),
    'Pro draft-edit MUST NOT render the free-tier SMS shortcut');
  assert.ok(!html.includes('value="update_and_whatsapp"'),
    'Pro draft-edit MUST NOT render the free-tier WhatsApp shortcut');
  // Non-edit-path buttons must not appear on the edit path.
  assert.ok(!html.includes('value="create_and_email"'),
    'edit-path MUST NOT render the /new create_and_email button');
}

async function testViewAgencyDraftEditParityWithPro() {
  const html = await renderForm({
    invoice: draftInvoiceLocal(),
    user: { id: 1, plan: 'agency', invoice_count: 5, name: 'Bob', email: 'b@x.com', business_name: 'Acme Studio', payment_instructions: null }
  });
  assert.ok(html.includes('data-testid="invoice-edit-submit-email"'),
    'Agency draft-edit keeps parity with Pro on the update_and_email shortcut');
  assert.ok(!html.includes('value="update_and_mailto"'),
    'Agency draft-edit MUST NOT render the free-tier mailto shortcut');
}

async function testViewSentInvoiceEditKeepsSingleButton() {
  const html = await renderForm({
    invoice: draftInvoiceLocal({ status: 'sent' }),
    user: { id: 1, plan: 'free', invoice_count: 5, name: 'Alice', email: 'a@x.com', business_name: 'Acme Studio', payment_instructions: 'Venmo @acme' }
  });
  // A sent invoice edit is a different flow (correct a typo, adjust the
  // amount). The one-tap send affordances don't apply — sending an already-
  // sent invoice is a resend, handled elsewhere.
  assert.ok(!html.includes('value="update_and_mailto"'),
    'sent invoice edit MUST NOT render the shortcut trio');
  assert.ok(!html.includes('value="update_and_sms"'),
    'sent invoice edit MUST NOT render the SMS shortcut');
  assert.ok(!html.includes('value="update_and_email"'),
    'sent invoice edit MUST NOT render the email shortcut');
  assert.ok(html.includes('data-testid="invoice-new-submit"'),
    'sent invoice edit falls back to the single primary submit button');
  assert.ok(html.includes('Save changes'),
    'sent invoice edit label is "Save changes"');
}

async function testViewPaidInvoiceEditKeepsSingleButton() {
  const html = await renderForm({
    invoice: draftInvoiceLocal({ status: 'paid' }),
    user: { id: 1, plan: 'pro', invoice_count: 5, name: 'Bob', email: 'b@x.com', business_name: 'Acme Studio', payment_instructions: null }
  });
  assert.ok(!html.includes('value="update_and_email"'),
    'paid invoice edit MUST NOT render the Pro update_and_email shortcut');
  assert.ok(html.includes('data-testid="invoice-new-submit"'),
    'paid invoice edit falls back to the single primary submit button');
}

async function testViewNewFlowUnchanged() {
  // Regression guard: /invoices/new (invoice=null) still renders the
  // create_and_* buttons — the edit-path additions must not break the new
  // flow's send shortcuts.
  const html = await renderForm({
    invoice: null,
    user: { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com', business_name: 'Acme Studio' }
  });
  assert.ok(html.includes('value="create_and_mailto"'),
    '/new free flow still renders create_and_mailto');
  assert.ok(html.includes('value="create_and_sms"'),
    '/new free flow still renders create_and_sms');
  assert.ok(html.includes('value="create_and_whatsapp"'),
    '/new free flow still renders create_and_whatsapp');
  assert.ok(!html.includes('value="update_and_mailto"'),
    '/new flow (no invoice) must NOT render edit-path shortcuts');
}

// ============================================================================
// Layer 2 — route POST /invoices/:id/edit
// ============================================================================

async function testPostUpdateAndWhatsappHappyPath() {
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 5, name: 'Alice', email: 'a@x.com' });
  seedDraft();
  process.env.APP_URL = 'https://decentinvoice.example';
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 5 }, routes);

  const res = await request(app, 'POST', '/invoices/42/edit',
    postBody({ action: 'update_and_whatsapp' }));

  assert.strictEqual(res.status, 302,
    'update_and_whatsapp must redirect (302)');
  assert.ok(/^https:\/\/wa\.me\//.test(res.headers.location),
    `must redirect to wa.me deep link, got ${res.headers.location}`);
  assert.ok(res.headers.location.includes('14155551234'),
    'wa.me URL must embed the normalised client phone');
  const bodyPart = res.headers.location.split('text=')[1] || '';
  const decoded = decodeURIComponent(bodyPart);
  assert.ok(decoded.includes('https://decentinvoice.example/i/ed7f1234567890ab'),
    `whatsapp body must embed the public /i/<token> URL, got: ${decoded}`);
  assert.strictEqual(updateCalls.length, 1, 'updateInvoice fired exactly once');
  assert.strictEqual(markSentCalls.length, 1,
    'markInvoiceSentFromShareIntent flips draft → sent atomically');
  assert.strictEqual(markSentCalls[0].userId, 1,
    'flip carries the session user id (defence vs cross-tenant flip)');
}

async function testPostUpdateAndSmsHappyPath() {
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 5, name: 'Alice', email: 'a@x.com' });
  seedDraft();
  process.env.APP_URL = 'https://decentinvoice.example';
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 5 }, routes);

  const res = await request(app, 'POST', '/invoices/42/edit',
    postBody({ action: 'update_and_sms' }));

  assert.strictEqual(res.status, 302, 'update_and_sms must redirect (302)');
  assert.ok(/^sms:/.test(res.headers.location),
    `must redirect to sms: deep link, got ${res.headers.location}`);
  const bodyPart = res.headers.location.split('body=')[1] || '';
  const decoded = decodeURIComponent(bodyPart);
  assert.ok(decoded.includes('https://decentinvoice.example/i/ed7f1234567890ab'),
    `sms body must embed the public /i/<token> URL, got: ${decoded}`);
  assert.strictEqual(updateCalls.length, 1);
  assert.strictEqual(markSentCalls.length, 1);
}

async function testPostUpdateAndMailtoHappyPath() {
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 5, name: 'Alice', email: 'a@x.com' });
  seedDraft();
  process.env.APP_URL = 'https://decentinvoice.example';
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 5 }, routes);

  const res = await request(app, 'POST', '/invoices/42/edit',
    postBody({ action: 'update_and_mailto' }));

  assert.strictEqual(res.status, 302, 'update_and_mailto must redirect (302)');
  assert.ok(/^mailto:/.test(res.headers.location),
    `must redirect to mailto: deep link, got ${res.headers.location}`);
  assert.ok(res.headers.location.includes(encodeURIComponent('billing@acme.com')),
    `mailto: URL must embed the client email as recipient, got: ${res.headers.location}`);
  const bodyPart = res.headers.location.split('body=')[1] || '';
  const decoded = decodeURIComponent(bodyPart);
  assert.ok(decoded.includes('https://decentinvoice.example/i/ed7f1234567890ab'),
    `mailto body must embed the public /i/<token> URL, got: ${decoded}`);
  assert.strictEqual(updateCalls.length, 1);
  assert.strictEqual(markSentCalls.length, 1);
}

async function testPostUpdateAndEmailProHappyPath() {
  resetStore();
  users.set(1, { id: 1, plan: 'pro', invoice_count: 5, name: 'Bob', email: 'b@x.com' });
  seedDraft();
  process.env.APP_URL = 'https://decentinvoice.example';
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'pro', invoice_count: 5 }, routes);

  const res = await request(app, 'POST', '/invoices/42/edit',
    postBody({ action: 'update_and_email' }));

  assert.strictEqual(res.status, 302, 'update_and_email redirects (302)');
  assert.strictEqual(res.headers.location, '/invoices/42',
    'Pro update_and_email lands the user back on /:id after server-side send');
  assert.strictEqual(updateCalls.length, 1);
  assert.strictEqual(emailCalls.length, 1,
    'sendInvoiceEmail must fire exactly once for Pro update_and_email');
  assert.strictEqual(emailCalls[0].invoiceId, 42,
    'email carries the correct invoice id');
  assert.strictEqual(markSentCalls.length, 1,
    'atomic draft → sent flip must fire after a successful send');
  const flash = app._sessionRef.flash;
  assert.ok(flash && flash.type === 'success', 'success flash on happy path');
  assert.ok(/INV-2026-0042/.test(flash.message),
    `success flash must name the invoice_number, got: ${flash.message}`);
  assert.ok(/billing@acme\.com/.test(flash.message),
    `success flash must name the recipient, got: ${flash.message}`);
}

async function testPostUpdateAndEmailFreeUserBlocked() {
  // Defence-in-depth against forged action payload: view hides this button
  // for free but the route must still hard-gate on plan. A free user sending
  // action=update_and_email should get the update saved, no send, no flip.
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 5, name: 'Alice', email: 'a@x.com' });
  seedDraft();
  process.env.APP_URL = 'https://decentinvoice.example';
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 5 }, routes);

  const res = await request(app, 'POST', '/invoices/42/edit',
    postBody({ action: 'update_and_email' }));

  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.location, '/invoices/42',
    'free user update_and_email lands back on /:id (no send)');
  assert.strictEqual(updateCalls.length, 1, 'update still saved');
  assert.strictEqual(emailCalls.length, 0,
    'free-tier forgery MUST NOT trigger sendInvoiceEmail');
  assert.strictEqual(markSentCalls.length, 0,
    'free-tier forgery MUST NOT flip draft → sent (no delivery = no sent status)');
}

async function testPostUpdateAndMailtoMissingClientEmailFallsBack() {
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 5, name: 'Alice', email: 'a@x.com' });
  seedDraft();
  process.env.APP_URL = 'https://decentinvoice.example';
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 5 }, routes);

  const res = await request(app, 'POST', '/invoices/42/edit',
    postBody({ action: 'update_and_mailto', client_email: '' }));

  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.location, '/invoices/42',
    'no client_email → fall through to /:id');
  assert.strictEqual(updateCalls.length, 1, 'update still saved');
  assert.strictEqual(markSentCalls.length, 0,
    'no flip when client_email is missing — mailto: with empty recipient defeats the shortcut');
  const flash = app._sessionRef.flash;
  assert.ok(flash && flash.type === 'error',
    'missing-email fallback uses error flash');
  assert.ok(/Email/i.test(flash.message),
    'fallback flash mentions Email');
}

async function testPostUpdateAndWhatsappTokenMintFailureFallsBack() {
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 5, name: 'Alice', email: 'a@x.com' });
  seedDraft();
  mintTokenImpl = async () => null;
  process.env.APP_URL = 'https://decentinvoice.example';
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 5 }, routes);

  const res = await request(app, 'POST', '/invoices/42/edit',
    postBody({ action: 'update_and_whatsapp' }));

  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.location, '/invoices/42',
    'must fall through to /invoices/:id when the share URL cannot be built');
  assert.strictEqual(updateCalls.length, 1, 'update still saved');
  assert.strictEqual(markSentCalls.length, 0,
    'no flip when share URL cannot be built');
  const flash = app._sessionRef.flash;
  assert.ok(flash && flash.type === 'error');
  assert.ok(/WhatsApp/i.test(flash.message),
    'fallback flash mentions WhatsApp');
}

async function testPostUpdateAndSentInvoiceIgnored() {
  // Status guard: forging action=update_and_whatsapp against an already-sent
  // invoice must NOT re-flip or re-celebrate. The invoice is past the M3
  // flow — this route is edit-only, not resend.
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 5, name: 'Alice', email: 'a@x.com' });
  seedDraft({ status: 'sent', public_token: 'existing-token-abc' });
  process.env.APP_URL = 'https://decentinvoice.example';
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 5 }, routes);

  const res = await request(app, 'POST', '/invoices/42/edit',
    postBody({ action: 'update_and_whatsapp', status: 'sent' }));

  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.location, '/invoices/42',
    'sent invoice edit lands back on /:id (no share deep link)');
  assert.strictEqual(updateCalls.length, 1,
    'update still saves the edited fields');
  assert.strictEqual(markSentCalls.length, 0,
    'sent → sent MUST NOT re-fire markInvoiceSentFromShareIntent');
  assert.strictEqual(mintTokenCalls.length, 0,
    'no send lane → no token mint on this path');
}

async function testPostNoActionDefaultsToLegacyBehaviour() {
  // Backwards-compatibility guard: absent action MUST still update + redirect
  // to /:id, with no send and no flip — matches the pre-ship contract for
  // POST /:id/edit so a plain "Save changes" submit is unchanged.
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 5, name: 'Alice', email: 'a@x.com' });
  seedDraft();
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 5 }, routes);

  const body = postBody({});
  delete body.action;
  const res = await request(app, 'POST', '/invoices/42/edit', body);
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.location, '/invoices/42',
    'absent action → redirect to /:id (no share deep link)');
  assert.strictEqual(updateCalls.length, 1);
  assert.strictEqual(markSentCalls.length, 0,
    'absent action MUST NOT flip status');
}

async function testPostUpdateAndSmsFiresCelebration() {
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 5, name: 'Alice', email: 'a@x.com' });
  seedDraft();
  process.env.APP_URL = 'https://decentinvoice.example';
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 5 }, routes);

  await request(app, 'POST', '/invoices/42/edit',
    postBody({ action: 'update_and_sms' }));

  await new Promise(r => setImmediate(r));
  assert.strictEqual(recordFirstSentCalls.length, 1,
    'first-sent celebration → recordFirstSentIfMissing called exactly once on edit-path SMS shortcut');
  assert.strictEqual(recordFirstSentCalls[0], 1,
    'first-sent stamp carries the correct user id');
}

async function testPostUpdateAndMailtoPinsStatusToDraft() {
  // A user picking "Update & open Email" while the form's status dropdown is
  // still on 'paid' (someone was mid-edit) must not first mark the invoice
  // paid and then flip it to sent. The send-shortcut must pin the update's
  // status to 'draft' so the atomic flip below is the sole source of truth.
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 5, name: 'Alice', email: 'a@x.com' });
  seedDraft();
  process.env.APP_URL = 'https://decentinvoice.example';
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 5 }, routes);

  await request(app, 'POST', '/invoices/42/edit',
    postBody({ action: 'update_and_mailto', status: 'paid' }));

  assert.strictEqual(updateCalls.length, 1);
  assert.strictEqual(updateCalls[0].data.status, 'draft',
    'send-shortcut submit MUST pin persisted status to draft — atomic markInvoiceSentFromShareIntent below is the single flip authority');
  assert.strictEqual(markSentCalls.length, 1,
    'the atomic flip must fire');
}

async function testPostUpdateAndEmailNotConfiguredFallsBack() {
  resetStore();
  users.set(1, { id: 1, plan: 'pro', invoice_count: 5, name: 'Bob', email: 'b@x.com' });
  seedDraft();
  emailImpl = async () => ({ ok: false, reason: 'not_configured' });
  process.env.APP_URL = 'https://decentinvoice.example';
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'pro', invoice_count: 5 }, routes);

  const res = await request(app, 'POST', '/invoices/42/edit',
    postBody({ action: 'update_and_email' }));

  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.location, '/invoices/42');
  assert.strictEqual(emailCalls.length, 1, 'send attempted once');
  assert.strictEqual(markSentCalls.length, 0,
    'send-failure MUST NOT flip status — invoice must truthfully remain a draft');
  const flash = app._sessionRef.flash;
  assert.ok(flash && flash.type === 'error');
  assert.ok(/not configured/i.test(flash.message),
    `not_configured flash names the missing config, got: ${flash.message}`);
}

// ============================================================================
// Runner
// ============================================================================

async function run() {
  const tests = [
    ['view: free draft-edit renders draft + mailto + SMS + WhatsApp buttons + hint', testViewFreeDraftEditRendersAllShortcuts],
    ['view: free draft-edit mailto button is Alpine x-show-gated on clientEmail', testViewFreeDraftEditMailtoGatedOnClientEmail],
    ['view: Pro draft-edit renders update_and_email shortcut + hint (no free trio)', testViewProDraftEditRendersEmailShortcut],
    ['view: Agency draft-edit keeps parity with Pro', testViewAgencyDraftEditParityWithPro],
    ['view: sent invoice edit falls back to single "Save changes" button', testViewSentInvoiceEditKeepsSingleButton],
    ['view: paid invoice edit falls back to single "Save changes" button', testViewPaidInvoiceEditKeepsSingleButton],
    ['view: /new flow (no invoice) unchanged — create_and_* still render', testViewNewFlowUnchanged],
    ['route: update_and_whatsapp on draft → 302 wa.me with public URL embedded', testPostUpdateAndWhatsappHappyPath],
    ['route: update_and_sms on draft → 302 sms: with public URL embedded', testPostUpdateAndSmsHappyPath],
    ['route: update_and_mailto on draft → 302 mailto:<client> with public URL', testPostUpdateAndMailtoHappyPath],
    ['route: update_and_email on Pro draft → sendInvoiceEmail + flip + celebration', testPostUpdateAndEmailProHappyPath],
    ['route: update_and_email on free draft → hard-gated, no send, no flip', testPostUpdateAndEmailFreeUserBlocked],
    ['route: update_and_mailto missing client_email → fallback /:id, no flip', testPostUpdateAndMailtoMissingClientEmailFallsBack],
    ['route: update_and_whatsapp token-mint failure → fallback /:id with error flash', testPostUpdateAndWhatsappTokenMintFailureFallsBack],
    ['route: update_and_whatsapp against sent invoice → no flip (status guard)', testPostUpdateAndSentInvoiceIgnored],
    ['route: absent action → legacy update + redirect, no flip, no send', testPostNoActionDefaultsToLegacyBehaviour],
    ['route: update_and_sms fires first-sent celebration on atomic flip', testPostUpdateAndSmsFiresCelebration],
    ['route: update_and_mailto pins persisted status to draft (form status ignored)', testPostUpdateAndMailtoPinsStatusToDraft],
    ['route: update_and_email not_configured → error flash, no flip', testPostUpdateAndEmailNotConfiguredFallsBack]
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
