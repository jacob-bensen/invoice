'use strict';

/*
 * /invoices/quick + action=create_and_mailto (Milestone 3 — first invoice
 * created → first invoice sent).
 *
 * Parallel to the existing action=create_and_sms + create_and_whatsapp
 * shortcuts, but the redirect target is the mailto: deep link. The
 * email-first freelancer cohort (accountants, lawyers, consultants, US
 * remote services) bills over email; the SMS + WhatsApp shortcuts leave
 * them with no one-tap send path on the free/business tier so they must
 * save-as-draft, bounce to /:id, and click mailto from the draft-send-
 * banner. This shortcut collapses that to one tap.
 *
 * Implementation pattern matches create_and_sms exactly:
 *   1. Build mailto: share-intent URL from public_token via buildShareSurfaceForInvoice
 *   2. Atomically flip draft → sent via markInvoiceSentFromShareIntent
 *   3. Fire the first-sent celebration (idempotent at the SQL layer)
 *   4. 302-redirect to mailto:<client>?subject=...&body=... so the user
 *      lands in their own mail client with the public URL pre-filled
 *
 * Extra gate vs. create_and_sms: client_email must be present. An empty
 * mailto: with no recipient defeats the purpose — server falls back to
 * /:id with an error flash so the user can retry with a filled email.
 *
 * Layers:
 *   - Layer 1: route — happy path 302 → mailto:<client>, flip fires, celebration fires
 *   - Layer 2: route — flash names the invoice_number + the client email
 *   - Layer 3: route — first-sent celebration fires
 *   - Layer 4: route — token-mint failure falls back to /:id with error flash
 *   - Layer 5: route — missing client_email falls back to /:id with error flash
 *   - Layer 6: view — free user sees the Email button when client_email is filled
 *   - Layer 7: view — Pro/Agency do NOT see the mailto button
 *   - Layer 8: view — mailto button is x-show-gated on fields.client_email
 *   - Layer 9: route — mailto: URL carries the message body + subject + client_email
 *
 * Run: NODE_ENV=test node tests/invoice-quick-create-and-mailto.test.js
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

async function testCreateAndMailtoFreeHappyPath() {
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  process.env.APP_URL = 'https://decentinvoice.example';
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 0 }, routes);

  const res = await request(app, 'POST', '/invoices/quick', {
    client_name: 'Acme Corp',
    client_email: 'billing@acme.com',
    description: 'Brand consultation',
    amount: '500',
    action: 'create_and_mailto'
  });

  assert.strictEqual(res.status, 302, 'create_and_mailto must redirect (302)');
  assert.ok(/^mailto:/.test(res.headers.location),
    `must redirect to mailto: deep link, got ${res.headers.location}`);
  // Recipient slot must carry the client email so the mail client opens pre-addressed.
  assert.ok(res.headers.location.includes(encodeURIComponent('billing@acme.com')),
    `mailto: URL must embed the client email as recipient, got: ${res.headers.location}`);
  // Public URL must appear in the encoded body so the recipient gets the share link.
  const bodyPart = res.headers.location.split('body=')[1] || '';
  const decoded = decodeURIComponent(bodyPart);
  assert.ok(decoded.includes('https://decentinvoice.example/i/abc1234567890def'),
    `mailto: body must embed the public /i/<token> URL, got: ${decoded}`);
  assert.strictEqual(createCalls.length, 1, 'createInvoice called exactly once');
  assert.strictEqual(markSentCalls.length, 1,
    'markInvoiceSentFromShareIntent flips draft → sent atomically');
  assert.strictEqual(markSentCalls[0].userId, 1,
    'mark-sent carries the session user id (defence against cross-tenant flip)');
}

// ============================================================================
// Layer 2 — route: flash names invoice + client email
// ============================================================================

async function testCreateAndMailtoFlashNamesInvoice() {
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  process.env.APP_URL = 'https://decentinvoice.example';
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 0 }, routes);

  await request(app, 'POST', '/invoices/quick', {
    client_name: 'Acme',
    client_email: 'billing@acme.com',
    description: 'Work',
    amount: '100',
    action: 'create_and_mailto'
  });

  const flash = app._sessionRef.flash;
  assert.ok(flash, 'flash must be set so the user sees it when they return from their mail client');
  assert.strictEqual(flash.type, 'success',
    'success flash type — invoice was atomically marked sent');
  assert.ok(/INV-2026-0001/.test(flash.message),
    `flash must name the invoice_number so user knows what was sent, got: ${flash.message}`);
  assert.ok(/billing@acme.com/.test(flash.message),
    `flash must name the client email the mailto: was pre-addressed to, got: ${flash.message}`);
  assert.ok(/marked as sent|sent/i.test(flash.message),
    'flash must confirm the sent status');
}

// ============================================================================
// Layer 3 — route: first-sent celebration fires
// ============================================================================

async function testCreateAndMailtoFiresCelebration() {
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  process.env.APP_URL = 'https://decentinvoice.example';
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 0 }, routes);

  await request(app, 'POST', '/invoices/quick', {
    client_name: 'Acme',
    client_email: 'billing@acme.com',
    description: 'Work',
    amount: '100',
    action: 'create_and_mailto'
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

async function testCreateAndMailtoTokenMintFailureFallsBackToInvoiceView() {
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  mintTokenImpl = async () => null;
  process.env.APP_URL = 'https://decentinvoice.example';
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 0 }, routes);

  const res = await request(app, 'POST', '/invoices/quick', {
    client_name: 'Acme',
    client_email: 'billing@acme.com',
    description: 'Work',
    amount: '100',
    action: 'create_and_mailto'
  });

  assert.strictEqual(res.status, 302,
    'still redirects even when mailto: URL cannot be built (graceful degrade)');
  assert.ok(/^\/invoices\/\d+$/.test(res.headers.location),
    `must fall through to /invoices/:id so user can tap Email from draft-send-banner, got ${res.headers.location}`);
  assert.strictEqual(createCalls.length, 1, 'invoice still created');
  assert.strictEqual(markSentCalls.length, 0,
    'no flip when mailto: cannot be built — dashboard truthfully shows draft so user can retry from /:id');

  const flash = app._sessionRef.flash;
  assert.ok(flash, 'flash must be set on the fallback path');
  assert.strictEqual(flash.type, 'error',
    'fallback uses error flash so the user knows something went sideways');
  assert.ok(/Email/i.test(flash.message),
    'fallback flash mentions Email so the user knows where to tap next');
}

// ============================================================================
// Layer 5 — missing client_email fallback
// ============================================================================

async function testCreateAndMailtoMissingClientEmailFallsBack() {
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  process.env.APP_URL = 'https://decentinvoice.example';
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 0 }, routes);

  const res = await request(app, 'POST', '/invoices/quick', {
    client_name: 'Acme',
    description: 'Work',
    amount: '100',
    action: 'create_and_mailto'
  });

  assert.strictEqual(res.status, 302,
    'redirects even with no client_email (graceful degrade)');
  assert.ok(/^\/invoices\/\d+$/.test(res.headers.location),
    `no client_email → fall through to /:id so user can add one and retry, got ${res.headers.location}`);
  assert.strictEqual(createCalls.length, 1,
    'invoice still created — the draft is a real save, not lost');
  assert.strictEqual(markSentCalls.length, 0,
    'no flip when client_email is missing — mailto: with empty recipient defeats the shortcut');
}

// ============================================================================
// Layer 6 — view: free user sees the Email button
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

async function testViewFreeUserSeesMailtoButton() {
  const html = await renderQuickView({
    user: { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com' }
  });
  assert.ok(html.includes('value="create_and_mailto"'),
    'free user must see the create_and_mailto button (M3 primary CTA — email-first cohort)');
  assert.ok(html.includes('data-action="create_and_mailto"'),
    'create_and_mailto button must carry the data-action hook');
  assert.ok(html.includes('data-testid="invoice-quick-submit-mailto"'),
    'create_and_mailto button must carry the data-testid hook');
  // Sibling send buttons still present — the shortcut is additive, not a replacement.
  assert.ok(html.includes('value="create_and_sms"'),
    'create_and_sms button must still be present');
  assert.ok(html.includes('value="create_and_whatsapp"'),
    'create_and_whatsapp button must still be present');
  assert.ok(html.includes('data-testid="invoice-quick-submit-draft"'),
    'free user must still see the secondary "Save as draft" button');
  assert.ok(/Open Email/.test(html),
    'button label must reference Email so the freelancer knows what tapping does');
}

// ============================================================================
// Layer 7 — view: Pro / Agency users do NOT see the mailto button
// ============================================================================

async function testViewProUserDoesNotSeeMailtoButton() {
  const html = await renderQuickView({
    user: { id: 1, plan: 'pro', invoice_count: 0, name: 'Bob', email: 'b@x.com' }
  });
  assert.ok(!html.includes('value="create_and_mailto"'),
    'Pro user must NOT see the mailto button — their primary CTA is server-side create_and_email');
  assert.ok(!html.includes('data-testid="invoice-quick-submit-mailto"'),
    'Pro user must not see the mailto testid hook');
  assert.ok(html.includes('value="create_and_email"'),
    'Pro user must keep seeing the create_and_email button (untouched)');
}

async function testViewAgencyUserDoesNotSeeMailtoButton() {
  const html = await renderQuickView({
    user: { id: 1, plan: 'agency', invoice_count: 0, name: 'Bob', email: 'b@x.com' }
  });
  assert.ok(!html.includes('value="create_and_mailto"'),
    'Agency user keeps email parity with Pro — no mailto button');
  assert.ok(html.includes('value="create_and_email"'),
    'Agency user must still see create_and_email');
}

// ============================================================================
// Layer 8 — view: mailto button is Alpine x-show-gated on fields.client_email
// ============================================================================

async function testViewMailtoButtonIsGatedOnClientEmail() {
  const html = await renderQuickView({
    user: { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com' }
  });
  // The x-show expression is what hides the mailto button when the client
  // email field is empty. Without this the free-tier form would show a
  // "Create & open Email" button that produces a mailto: with no recipient
  // — confusing UX. Pin the exact expression so a future refactor can't
  // silently drop the gate.
  const gate = 'x-show="fields.client_email && fields.client_email.trim()"';
  assert.ok(html.includes(gate),
    `mailto button must be Alpine-gated on fields.client_email being filled; expected ${gate}, got HTML that lacks it`);
}

// ============================================================================
// Layer 9 — mailto: URL message body composition
// ============================================================================

async function testCreateAndMailtoBodyShape() {
  resetStore();
  users.set(1, { id: 1, plan: 'free', invoice_count: 0, name: 'Alice', email: 'a@x.com' });
  process.env.APP_URL = 'https://decentinvoice.example';
  const routes = installDbStub();
  const app = buildApp({ id: 1, plan: 'free', invoice_count: 0 }, routes);

  const res = await request(app, 'POST', '/invoices/quick', {
    client_name: 'Acme Corp',
    client_email: 'billing@acme.com',
    description: 'Brand consultation',
    amount: '500',
    action: 'create_and_mailto'
  });

  assert.strictEqual(res.status, 302);
  // mailto: URL shape is `mailto:<recipient>?subject=...&body=...` per lib/share-link.js
  assert.ok(res.headers.location.startsWith('mailto:'),
    `must start with mailto: prefix, got ${res.headers.location}`);
  assert.ok(res.headers.location.includes('subject='),
    'mailto: URL must carry an encoded subject so the freelancer\'s draft has a subject line');
  const subjectPart = res.headers.location.split('subject=')[1].split('&')[0];
  const decodedSubject = decodeURIComponent(subjectPart);
  assert.ok(/Invoice INV-2026-0001/i.test(decodedSubject),
    `mailto: subject must name the invoice_number, got: ${decodedSubject}`);
  const bodyPart = res.headers.location.split('body=')[1] || '';
  const decoded = decodeURIComponent(bodyPart);
  assert.ok(/Hi Acme Corp,/i.test(decoded),
    `mailto: body must greet the typed client name, got: ${decoded}`);
  assert.ok(decoded.includes('$500.00'),
    `mailto: body must include the formatted amount, got: ${decoded}`);
  assert.ok(decoded.endsWith('https://decentinvoice.example/i/abc1234567890def'),
    `mailto: body must end with public URL so the recipient sees the click target, got: ${decoded}`);
}

// ============================================================================
// Runner
// ============================================================================

async function run() {
  const tests = [
    ['route: free user happy path → 302 to mailto:<client> with public URL embedded', testCreateAndMailtoFreeHappyPath],
    ['route: flash names the invoice_number + client email', testCreateAndMailtoFlashNamesInvoice],
    ['route: first-sent celebration fires on the atomic flip', testCreateAndMailtoFiresCelebration],
    ['route: public-token mint failure falls back to /:id with error flash', testCreateAndMailtoTokenMintFailureFallsBackToInvoiceView],
    ['route: missing client_email falls back to /:id (no empty-recipient mailto)', testCreateAndMailtoMissingClientEmailFallsBack],
    ['view: free user sees the Email button alongside SMS + WhatsApp', testViewFreeUserSeesMailtoButton],
    ['view: Pro user does NOT see the mailto button (keeps server-side email)', testViewProUserDoesNotSeeMailtoButton],
    ['view: Agency user does NOT see the mailto button (parity with Pro)', testViewAgencyUserDoesNotSeeMailtoButton],
    ['view: mailto button is Alpine x-show-gated on fields.client_email', testViewMailtoButtonIsGatedOnClientEmail],
    ['route: mailto: subject names invoice_number + body greets client + has URL', testCreateAndMailtoBodyShape]
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
