'use strict';

/*
 * /invoices/quick + action=create_and_whatsapp (Milestone 3 — first invoice
 * created → first invoice sent).
 *
 * The free-tier analog of Pro/Agency's action=create_and_email shortcut.
 * Collapses the brand-new free user's three-step send flow
 *   (fill /quick → click "Create" → land on /:id → tap "WhatsApp")
 * into one submit. The server creates the invoice, eagerly mints the public
 * token (already covered upstream), then for this action:
 *
 *   1. Builds the WhatsApp share-intent URL from the public_token.
 *   2. Atomically flips draft → sent via markInvoiceSentFromShareIntent
 *      (same race-safe helper the /share-intent endpoint uses).
 *   3. Fires the first-sent celebration (idempotent at the SQL layer).
 *   4. 302-redirects directly to wa.me/?text=... so the user lands in
 *      WhatsApp with the message pre-filled and picks a contact.
 *
 * No plan gate — the action only marks-sent + redirects to a wa.me/ deep
 * link, both of which the existing /share-intent endpoint already exposes
 * to every plan. View-side, the button is shown to free users only (Pro's
 * preferred path is the server-side email send) but a forged action from a
 * Pro user is a benign no-op equivalent to the existing /share-intent flow.
 *
 * Layers:
 *   - Layer 1: route — happy path 302 → wa.me/, flip fires, celebration fires,
 *     flash names the invoice number.
 *   - Layer 2: route — token-mint failure falls back to /:id with error flash.
 *   - Layer 3: route — Pro forged action also works (plan-agnostic).
 *   - Layer 4: view — free user sees dual buttons (draft + WhatsApp).
 *   - Layer 5: view — Pro/Agency still see the email button, NOT the WA button.
 *   - Layer 6: route — flash names the invoice_number so the user knows
 *     what was sent on return from WhatsApp.
 *   - Layer 7: route — wa.me URL carries the message body with the public URL.
 *
 * Run: NODE_ENV=test node tests/invoice-quick-create-and-whatsapp.test.js
 */

const assert = require('assert');
const path = require('path');
const ejs = require('ejs');
const express = require('express');
const http = require('http');

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

// ============================================================================
// Test-store + db stub (mirrors tests/invoice-quick.test.js shape)
// ============================================================================

const users = new Map();
const createCalls = [];
const markSentCalls = [];
const recordFirstSentCalls = [];
const mintTokenCalls = [];
let nextInvoiceId = 100;
let mintTokenImpl = null;

function resetStore() {
  users.clear();
  createCalls.length = 0;
  markSentCalls.length = 0;
  recordFirstSentCalls.length = 0;
  mintTokenCalls.length = 0;
  nextInvoiceId = 100;
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
        const row = Object.assign({ id }, data, {
          items: data.items, status: 'draft', is_seed: false
        });
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
        // First-sent only fires the first time. Subsequent calls return null.
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
  // Real email lib — the celebration path goes through it, but in this
  // suite the in-test recordFirstSentIfMissing returns a stamped row with a
  // mocked user, so the fire-and-forget send will attempt and quietly
  // not_configured (no RESEND_API_KEY in test env). We don't assert against
  // the email send itself here.
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

// ============================================================================
// Layer 1 — route: happy path, free user, plan-agnostic
// ============================================================================

async function testCreateAndWhatsappFreeHappyPath() {
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  process.env.APP_URL = 'https://decentinvoice.example';
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 0 }, routes);

  const res = await request(app, 'POST', '/invoices/quick', {
    client_name: 'Acme Corp',
    description: 'Brand consultation',
    amount: '500',
    action: 'create_and_whatsapp'
  });

  assert.strictEqual(res.status, 302, 'create_and_whatsapp must redirect (302)');
  assert.ok(/^https:\/\/wa\.me\/\?text=/.test(res.headers.location),
    `must redirect to wa.me/?text=..., got ${res.headers.location}`);
  // Public URL must appear in the encoded body so the WA recipient gets the
  // tap-to-pay link — that's the whole point.
  const decoded = decodeURIComponent(res.headers.location.split('?text=')[1] || '');
  assert.ok(decoded.includes('https://decentinvoice.example/i/abc1234567890def'),
    `wa.me body must embed the public /i/<token> URL, got: ${decoded}`);
  assert.ok(/invoice INV-2026-0001/i.test(decoded) || /invoice/i.test(decoded),
    'wa.me body must reference the invoice');
  assert.strictEqual(createCalls.length, 1, 'createInvoice called exactly once');
  assert.strictEqual(markSentCalls.length, 1,
    'markInvoiceSentFromShareIntent flips draft → sent atomically (matches /share-intent semantics)');
  assert.strictEqual(markSentCalls[0].userId, 1,
    'mark-sent carries the session user id (defence against cross-tenant flip)');
}

async function testCreateAndWhatsappFlashNamesInvoice() {
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  process.env.APP_URL = 'https://decentinvoice.example';
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 0 }, routes);

  await request(app, 'POST', '/invoices/quick', {
    client_name: 'Acme',
    description: 'Work',
    amount: '100',
    action: 'create_and_whatsapp'
  });

  const flash = app._sessionRef.flash;
  assert.ok(flash, 'flash must be set so the user sees it when they return from WhatsApp');
  assert.strictEqual(flash.type, 'success',
    'success flash type — invoice was atomically marked sent');
  assert.ok(/INV-2026-0001/.test(flash.message),
    `flash must name the invoice_number so user knows what was sent, got: ${flash.message}`);
  assert.ok(/WhatsApp/i.test(flash.message),
    'flash must reference WhatsApp so the user remembers the action they took');
  assert.ok(/marked as sent|sent/i.test(flash.message),
    'flash must confirm the sent status');
}

async function testCreateAndWhatsappFiresCelebration() {
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  process.env.APP_URL = 'https://decentinvoice.example';
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 0 }, routes);

  await request(app, 'POST', '/invoices/quick', {
    client_name: 'Acme',
    description: 'Work',
    amount: '100',
    action: 'create_and_whatsapp'
  });

  // The celebration is fire-and-forget at the call site — it's not awaited.
  // Give the microtask queue one tick to flush the synchronous DB call inside
  // triggerFirstSentCelebration (recordFirstSentIfMissing).
  await new Promise(r => setImmediate(r));

  assert.strictEqual(recordFirstSentCalls.length, 1,
    'triggerFirstSentCelebration → recordFirstSentIfMissing called exactly once on the first sent invoice');
  assert.strictEqual(recordFirstSentCalls[0], 1,
    'first-sent stamp carries the correct user id');
}

// ============================================================================
// Layer 2 — token-mint failure fallback
// ============================================================================

async function testCreateAndWhatsappTokenMintFailureFallsBackToInvoiceView() {
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  mintTokenImpl = async () => null; // simulate DB hiccup on the eager mint
  process.env.APP_URL = 'https://decentinvoice.example';
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 0 }, routes);

  const res = await request(app, 'POST', '/invoices/quick', {
    client_name: 'Acme',
    description: 'Work',
    amount: '100',
    action: 'create_and_whatsapp'
  });

  assert.strictEqual(res.status, 302,
    'still redirects even when wa.me URL cannot be built (graceful degrade)');
  assert.ok(/^\/invoices\/\d+$/.test(res.headers.location),
    `must fall through to /invoices/:id so user can tap WhatsApp from the draft-send-banner, got ${res.headers.location}`);
  assert.strictEqual(createCalls.length, 1, 'invoice still created');
  assert.strictEqual(markSentCalls.length, 0,
    'no flip when wa.me cannot be built — dashboard truthfully shows draft so the user can retry from /:id');

  const flash = app._sessionRef.flash;
  assert.ok(flash, 'flash must be set on the fallback path');
  assert.strictEqual(flash.type, 'error',
    'fallback uses error flash so the user knows something went sideways');
  assert.ok(/WhatsApp/i.test(flash.message),
    'fallback flash mentions WhatsApp so the user knows where to tap next');
}

// ============================================================================
// Layer 3 — Pro forged action is plan-agnostic (benign no-op equivalent to
// /share-intent). No hard plan-gate needed.
// ============================================================================

async function testCreateAndWhatsappWorksForProToo() {
  resetStore();
  users.set(1, { id: 1, plan: 'pro', invoice_count: 0, name: 'Bob', email: 'b@x.com' });
  process.env.APP_URL = 'https://decentinvoice.example';
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'pro', invoice_count: 0 }, routes);

  const res = await request(app, 'POST', '/invoices/quick', {
    client_name: 'Acme',
    description: 'Work',
    amount: '100',
    action: 'create_and_whatsapp'
  });

  assert.strictEqual(res.status, 302, 'Pro user can also use the WA shortcut');
  assert.ok(/^https:\/\/wa\.me\/\?text=/.test(res.headers.location),
    'Pro user sees the same wa.me redirect as a free user — plan-agnostic');
  assert.strictEqual(markSentCalls.length, 1, 'Pro also gets the atomic flip');
}

// ============================================================================
// Layer 4-5 — view-side button presence
// ============================================================================

async function renderQuickView(opts) {
  const viewsDir = path.join(__dirname, '..', 'views');
  return ejs.renderFile(path.join(viewsDir, 'invoice-quick.ejs'),
    Object.assign({
      title: 'Quick invoice',
      flash: null,
      submitted: null,
      pendingRestored: false,
      user: { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com' },
      recentClients: [],
      recentItems: [],
      welcome: false,
      csrfToken: 'test-csrf',
      noindex: true
    }, opts || {}),
    { views: [viewsDir] });
}

async function testViewFreeUserSeesWhatsappButton() {
  const html = await renderQuickView({
    user: { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com' }
  });
  assert.ok(html.includes('value="create_and_whatsapp"'),
    'free user must see the create_and_whatsapp button (M3 primary CTA)');
  assert.ok(html.includes('data-action="create_and_whatsapp"'),
    'create_and_whatsapp button must carry the data-action hook');
  assert.ok(html.includes('data-testid="invoice-quick-submit-draft"'),
    'free user must see the secondary "Save as draft" button (action=create_only)');
  assert.ok(html.includes('value="create_only"'),
    '"Save as draft" must POST action=create_only');
  assert.ok(html.includes('data-testid="invoice-quick-whatsapp-hint"'),
    'free user must see the WhatsApp explainer hint');
  assert.ok(/WhatsApp/i.test(html),
    'button label must reference WhatsApp so the freelancer knows what tapping does');
}

async function testViewProUserDoesNotSeeWhatsappButton() {
  const html = await renderQuickView({
    user: { id: 1, plan: 'pro', invoice_count: 0, name: 'Bob', email: 'b@x.com' }
  });
  assert.ok(!html.includes('value="create_and_whatsapp"'),
    'Pro user must NOT see the WhatsApp button — their primary CTA is server-side email');
  assert.ok(html.includes('value="create_and_email"'),
    'Pro user must keep seeing the create_and_email button (untouched)');
  assert.ok(!html.includes('data-testid="invoice-quick-whatsapp-hint"'),
    'Pro user must not see the WhatsApp explainer hint');
}

async function testViewAgencyUserDoesNotSeeWhatsappButton() {
  const html = await renderQuickView({
    user: { id: 1, plan: 'agency', invoice_count: 0, name: 'Bob', email: 'b@x.com' }
  });
  assert.ok(!html.includes('value="create_and_whatsapp"'),
    'Agency user keeps email parity with Pro — no WhatsApp button');
  assert.ok(html.includes('value="create_and_email"'),
    'Agency user must still see create_and_email');
}

// ============================================================================
// Layer 6 — wa.me URL message body composition
// ============================================================================

async function testCreateAndWhatsappBodyShape() {
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  process.env.APP_URL = 'https://decentinvoice.example';
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 0 }, routes);

  const res = await request(app, 'POST', '/invoices/quick', {
    client_name: 'Acme Corp',
    description: 'Brand consultation',
    amount: '500',
    action: 'create_and_whatsapp'
  });

  assert.strictEqual(res.status, 302);
  const decoded = decodeURIComponent(res.headers.location.split('?text=')[1] || '');
  assert.ok(/Hi Acme Corp,/i.test(decoded),
    `WA body must greet the typed client name, got: ${decoded}`);
  assert.ok(decoded.includes('$500.00'),
    `WA body must include the formatted amount, got: ${decoded}`);
  assert.ok(decoded.endsWith('https://decentinvoice.example/i/abc1234567890def'),
    `WA body must end with the public URL so the SMS preview shows the click target, got: ${decoded}`);
}

// ============================================================================
// Layer 7 — guardrails: action=create_only baseline keeps redirecting to /:id
// (i.e. our new branch doesn't regress the existing default).
// ============================================================================

async function testCreateOnlyStillRedirectsToInvoiceView() {
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  process.env.APP_URL = 'https://decentinvoice.example';
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 0 }, routes);

  const res = await request(app, 'POST', '/invoices/quick', {
    client_name: 'Acme',
    description: 'Work',
    amount: '100',
    action: 'create_only'
  });

  assert.strictEqual(res.status, 302);
  assert.ok(/^\/invoices\/\d+$/.test(res.headers.location),
    `action=create_only must still redirect to /invoices/:id (untouched default), got ${res.headers.location}`);
  assert.strictEqual(markSentCalls.length, 0,
    'create_only must NOT auto-flip — draft stays as draft');
}

// ============================================================================
// Runner
// ============================================================================

async function run() {
  const tests = [
    ['route: free user happy path → 302 to wa.me/?text=... with public URL embedded', testCreateAndWhatsappFreeHappyPath],
    ['route: flash names the invoice_number + references WhatsApp', testCreateAndWhatsappFlashNamesInvoice],
    ['route: first-sent celebration fires on the atomic flip', testCreateAndWhatsappFiresCelebration],
    ['route: public-token mint failure falls back to /:id with error flash', testCreateAndWhatsappTokenMintFailureFallsBackToInvoiceView],
    ['route: Pro forged action is plan-agnostic — still redirects to wa.me/', testCreateAndWhatsappWorksForProToo],
    ['view: free user sees the dual "Save as draft" + "Create & open WhatsApp" buttons', testViewFreeUserSeesWhatsappButton],
    ['view: Pro user does NOT see the WhatsApp button (keeps the email surface)', testViewProUserDoesNotSeeWhatsappButton],
    ['view: Agency user does NOT see the WhatsApp button (parity with Pro)', testViewAgencyUserDoesNotSeeWhatsappButton],
    ['route: wa.me body greets client_name, includes $amount, ends with public URL', testCreateAndWhatsappBodyShape],
    ['route: action=create_only baseline still redirects to /:id (no regression)', testCreateOnlyStillRedirectsToInvoiceView]
  ];
  let passed = 0, failed = 0;
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
