'use strict';

/*
 * /invoices/quick + action=create_and_sms (Milestone 3 — first invoice
 * created → first invoice sent).
 *
 * Parallel to the existing action=create_and_whatsapp shortcut, but the
 * redirect target is the sms: deep link. The US/Canada/UK freelancer
 * cohort runs most client comms over SMS, not WhatsApp — leaving them
 * with only the WhatsApp shortcut means they had no one-tap send path
 * on /quick and had to round-trip through /invoices/:id to reach the
 * SMS button on the draft-send-banner.
 *
 * Implementation pattern matches create_and_whatsapp exactly:
 *   1. Build SMS share-intent URL from public_token via buildShareSurfaceForInvoice
 *   2. Atomically flip draft → sent via markInvoiceSentFromShareIntent
 *   3. Fire the first-sent celebration (idempotent at the SQL layer)
 *   4. 302-redirect to sms:?&body=... so the user lands in Messages
 *
 * Plan-agnostic for the same reason as create_and_whatsapp — the action
 * only marks-sent + redirects to an sms: deep link, both of which the
 * existing /share-intent endpoint already exposes to every plan.
 *
 * Layers:
 *   - Layer 1: route — happy path 302 → sms:, flip fires, celebration fires
 *   - Layer 2: route — flash names the invoice_number + Messages
 *   - Layer 3: route — token-mint failure falls back to /:id with error flash
 *   - Layer 4: route — Pro forged action is plan-agnostic
 *   - Layer 5: view — free user sees the SMS button alongside WhatsApp
 *   - Layer 6: view — Pro/Agency do NOT see the SMS button
 *   - Layer 7: route — sms: URL carries the message body with the public URL
 *
 * Run: NODE_ENV=test node tests/invoice-quick-create-and-sms.test.js
 */

const assert = require('assert');
const path = require('path');
const ejs = require('ejs');
const express = require('express');
const http = require('http');

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

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

// ============================================================================
// Layer 1 — route: happy path, free user
// ============================================================================

async function testCreateAndSmsFreeHappyPath() {
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  process.env.APP_URL = 'https://decentinvoice.example';
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 0 }, routes);

  const res = await request(app, 'POST', '/invoices/quick', {
    client_name: 'Acme Corp',
    description: 'Brand consultation',
    amount: '500',
    action: 'create_and_sms'
  });

  assert.strictEqual(res.status, 302, 'create_and_sms must redirect (302)');
  assert.ok(/^sms:/.test(res.headers.location),
    `must redirect to sms: deep link, got ${res.headers.location}`);
  // Public URL must appear in the encoded body so the SMS recipient gets the
  // tap-to-pay link — that's the whole point.
  const decoded = decodeURIComponent(res.headers.location.split('body=')[1] || '');
  assert.ok(decoded.includes('https://decentinvoice.example/i/abc1234567890def'),
    `sms: body must embed the public /i/<token> URL, got: ${decoded}`);
  assert.ok(/invoice INV-2026-0001/i.test(decoded) || /invoice/i.test(decoded),
    'sms: body must reference the invoice');
  assert.strictEqual(createCalls.length, 1, 'createInvoice called exactly once');
  assert.strictEqual(markSentCalls.length, 1,
    'markInvoiceSentFromShareIntent flips draft → sent atomically');
  assert.strictEqual(markSentCalls[0].userId, 1,
    'mark-sent carries the session user id (defence against cross-tenant flip)');
}

// ============================================================================
// Layer 2 — route: flash naming
// ============================================================================

async function testCreateAndSmsFlashNamesInvoice() {
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  process.env.APP_URL = 'https://decentinvoice.example';
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 0 }, routes);

  await request(app, 'POST', '/invoices/quick', {
    client_name: 'Acme',
    description: 'Work',
    amount: '100',
    action: 'create_and_sms'
  });

  const flash = app._sessionRef.flash;
  assert.ok(flash, 'flash must be set so the user sees it when they return from Messages');
  assert.strictEqual(flash.type, 'success',
    'success flash type — invoice was atomically marked sent');
  assert.ok(/INV-2026-0001/.test(flash.message),
    `flash must name the invoice_number so user knows what was sent, got: ${flash.message}`);
  assert.ok(/Messages/i.test(flash.message),
    'flash must reference Messages so the user remembers the action they took');
  assert.ok(/marked as sent|sent/i.test(flash.message),
    'flash must confirm the sent status');
}

// ============================================================================
// Layer 3 — route: first-sent celebration fires
// ============================================================================

async function testCreateAndSmsFiresCelebration() {
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  process.env.APP_URL = 'https://decentinvoice.example';
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 0 }, routes);

  await request(app, 'POST', '/invoices/quick', {
    client_name: 'Acme',
    description: 'Work',
    amount: '100',
    action: 'create_and_sms'
  });

  await new Promise(r => setImmediate(r));

  assert.strictEqual(recordFirstSentCalls.length, 1,
    'triggerFirstSentCelebration → recordFirstSentIfMissing called exactly once on first sent invoice');
  assert.strictEqual(recordFirstSentCalls[0], 1,
    'first-sent stamp carries the correct user id');
}

// ============================================================================
// Layer 4 — token-mint failure fallback
// ============================================================================

async function testCreateAndSmsTokenMintFailureFallsBackToInvoiceView() {
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  mintTokenImpl = async () => null;
  process.env.APP_URL = 'https://decentinvoice.example';
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 0 }, routes);

  const res = await request(app, 'POST', '/invoices/quick', {
    client_name: 'Acme',
    description: 'Work',
    amount: '100',
    action: 'create_and_sms'
  });

  assert.strictEqual(res.status, 302,
    'still redirects even when sms: URL cannot be built (graceful degrade)');
  assert.ok(/^\/invoices\/\d+$/.test(res.headers.location),
    `must fall through to /invoices/:id so user can tap SMS from draft-send-banner, got ${res.headers.location}`);
  assert.strictEqual(createCalls.length, 1, 'invoice still created');
  assert.strictEqual(markSentCalls.length, 0,
    'no flip when sms: cannot be built — dashboard truthfully shows draft so user can retry from /:id');

  const flash = app._sessionRef.flash;
  assert.ok(flash, 'flash must be set on the fallback path');
  assert.strictEqual(flash.type, 'error',
    'fallback uses error flash so the user knows something went sideways');
  assert.ok(/SMS/i.test(flash.message),
    'fallback flash mentions SMS so the user knows where to tap next');
}

// ============================================================================
// Layer 5 — Pro forged action is plan-agnostic
// ============================================================================

async function testCreateAndSmsWorksForProToo() {
  resetStore();
  users.set(1, { id: 1, plan: 'pro', invoice_count: 0, name: 'Bob', email: 'b@x.com' });
  process.env.APP_URL = 'https://decentinvoice.example';
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'pro', invoice_count: 0 }, routes);

  const res = await request(app, 'POST', '/invoices/quick', {
    client_name: 'Acme',
    description: 'Work',
    amount: '100',
    action: 'create_and_sms'
  });

  assert.strictEqual(res.status, 302, 'Pro user can also use the SMS shortcut');
  assert.ok(/^sms:/.test(res.headers.location),
    'Pro user sees the same sms: redirect as a free user — plan-agnostic');
  assert.strictEqual(markSentCalls.length, 1, 'Pro also gets the atomic flip');
}

// ============================================================================
// Layer 6 — view: free user sees the SMS button alongside WhatsApp
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

async function testViewFreeUserSeesSmsButton() {
  const html = await renderQuickView({
    user: { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com' }
  });
  assert.ok(html.includes('value="create_and_sms"'),
    'free user must see the create_and_sms button (M3 primary CTA — US/Canada/UK cohort)');
  assert.ok(html.includes('data-action="create_and_sms"'),
    'create_and_sms button must carry the data-action hook');
  assert.ok(html.includes('data-testid="invoice-quick-submit-sms"'),
    'create_and_sms button must carry the data-testid hook');
  assert.ok(html.includes('value="create_and_whatsapp"'),
    'create_and_whatsapp button must still be present (the global cohort still uses it)');
  assert.ok(html.includes('data-testid="invoice-quick-submit-draft"'),
    'free user must still see the secondary "Save as draft" button');
  assert.ok(/Open SMS|SMS/.test(html),
    'button label must reference SMS so the freelancer knows what tapping does');
}

async function testViewProUserDoesNotSeeSmsButton() {
  const html = await renderQuickView({
    user: { id: 1, plan: 'pro', invoice_count: 0, name: 'Bob', email: 'b@x.com' }
  });
  assert.ok(!html.includes('value="create_and_sms"'),
    'Pro user must NOT see the SMS button — their primary CTA is server-side email');
  assert.ok(!html.includes('data-testid="invoice-quick-submit-sms"'),
    'Pro user must not see the SMS testid hook');
  assert.ok(html.includes('value="create_and_email"'),
    'Pro user must keep seeing the create_and_email button (untouched)');
}

async function testViewAgencyUserDoesNotSeeSmsButton() {
  const html = await renderQuickView({
    user: { id: 1, plan: 'agency', invoice_count: 0, name: 'Bob', email: 'b@x.com' }
  });
  assert.ok(!html.includes('value="create_and_sms"'),
    'Agency user keeps email parity with Pro — no SMS button');
  assert.ok(html.includes('value="create_and_email"'),
    'Agency user must still see create_and_email');
}

// ============================================================================
// Layer 7 — sms: URL message body composition
// ============================================================================

async function testCreateAndSmsBodyShape() {
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  process.env.APP_URL = 'https://decentinvoice.example';
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 0 }, routes);

  const res = await request(app, 'POST', '/invoices/quick', {
    client_name: 'Acme Corp',
    description: 'Brand consultation',
    amount: '500',
    action: 'create_and_sms'
  });

  assert.strictEqual(res.status, 302);
  // sms: URL shape is `sms:?&body=<encoded>` per lib/share-link.js
  assert.ok(res.headers.location.startsWith('sms:?'),
    `must start with sms:? prefix, got ${res.headers.location}`);
  const decoded = decodeURIComponent(res.headers.location.split('body=')[1] || '');
  assert.ok(/Hi Acme Corp,/i.test(decoded),
    `sms: body must greet the typed client name, got: ${decoded}`);
  assert.ok(decoded.includes('$500.00'),
    `sms: body must include the formatted amount, got: ${decoded}`);
  assert.ok(decoded.endsWith('https://decentinvoice.example/i/abc1234567890def'),
    `sms: body must end with public URL so SMS preview shows the click target, got: ${decoded}`);
}

// ============================================================================
// Runner
// ============================================================================

async function run() {
  const tests = [
    ['route: free user happy path → 302 to sms: with public URL embedded', testCreateAndSmsFreeHappyPath],
    ['route: flash names the invoice_number + references Messages', testCreateAndSmsFlashNamesInvoice],
    ['route: first-sent celebration fires on the atomic flip', testCreateAndSmsFiresCelebration],
    ['route: public-token mint failure falls back to /:id with error flash', testCreateAndSmsTokenMintFailureFallsBackToInvoiceView],
    ['route: Pro forged action is plan-agnostic — still redirects to sms:', testCreateAndSmsWorksForProToo],
    ['view: free user sees the SMS button alongside the WhatsApp button', testViewFreeUserSeesSmsButton],
    ['view: Pro user does NOT see the SMS button (keeps the email surface)', testViewProUserDoesNotSeeSmsButton],
    ['view: Agency user does NOT see the SMS button (parity with Pro)', testViewAgencyUserDoesNotSeeSmsButton],
    ['route: sms: body greets client_name, includes $amount, ends with public URL', testCreateAndSmsBodyShape]
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
