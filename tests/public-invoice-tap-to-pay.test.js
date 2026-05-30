'use strict';

/*
 * Tap-to-pay deep-link buttons on the public /i/<token> page (Milestone 4
 * — first invoice sent → first payment received). Three structured
 * handle columns (venmo_handle, cashapp_handle, paypal_me_handle) get
 * surfaced as one-tap universal-link buttons with the invoice's amount +
 * number pre-filled. Replaces the manual "copy handle → app-switch →
 * paste → re-type amount" friction the plain-text "How to pay" panel
 * still leaves clients with.
 *
 * Covers:
 *   1. schema.sql carries the idempotent ALTERs for the 3 new columns.
 *   2. db.getInvoiceByPublicToken SQL projects all 3 owner_* aliases so
 *      the template renders without a second round-trip.
 *   3. POST /billing/settings persists valid handles (with leading
 *      @/$ stripped, surrounding whitespace trimmed).
 *   4. POST /billing/settings rejects invalid handles per-field with a
 *      flash + zero db.updateUser calls.
 *   5. POST /billing/settings persists empty input as NULL (lets the
 *      user remove a stale handle).
 *   6. settings.ejs surfaces the 3 inputs with the right testids.
 *   7. invoice-public.ejs renders the tap-to-pay card with the right
 *      hrefs (amount + invoice number embedded), one button per set
 *      handle, suppressed on paid status, suppressed when all 3 unset.
 *
 * Run: NODE_ENV=test node tests/public-invoice-tap-to-pay.test.js
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

const { buildPayLinks } = require('../lib/payment-handles');

// Compose the same locals the live GET /i/:token route emits. The template
// reads tapToPayLinks (built from the invoice's 3 handle columns + total +
// invoice_number) — keeping this helper in lockstep with routes/share.js
// is the whole point of the integration test layer here.
function renderPublic(invoice) {
  return ejs.renderFile(
    path.join(VIEWS, 'invoice-public.ejs'),
    {
      invoice,
      title: 't',
      tapToPayLinks: buildPayLinks({
        venmo: invoice.owner_venmo_handle,
        cashapp: invoice.owner_cashapp_handle,
        paypal: invoice.owner_paypal_me_handle,
        amount: invoice.total,
        invoiceNumber: invoice.invoice_number
      })
    },
    { views: [VIEWS] }
  );
}

function clearReq(mod) {
  try { delete require.cache[require.resolve(mod)]; } catch (_) { /* noop */ }
}

// ---------- 1. schema.sql migration -------------------------------------

function testSchemaIncludesTapToPayMigrations() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  assert.ok(
    /ALTER\s+TABLE\s+users\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+venmo_handle\s+VARCHAR/i.test(sql),
    'schema.sql must carry an idempotent ALTER for users.venmo_handle'
  );
  assert.ok(
    /ALTER\s+TABLE\s+users\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+cashapp_handle\s+VARCHAR/i.test(sql),
    'schema.sql must carry an idempotent ALTER for users.cashapp_handle'
  );
  assert.ok(
    /ALTER\s+TABLE\s+users\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+paypal_me_handle\s+VARCHAR/i.test(sql),
    'schema.sql must carry an idempotent ALTER for users.paypal_me_handle'
  );
}

// ---------- 2. db.getInvoiceByPublicToken SQL projection ----------------

function stubPg(handler) {
  const pgPath = require.resolve('pg');
  const originalPg = require.cache[pgPath];
  require.cache[pgPath] = {
    id: pgPath, filename: pgPath, loaded: true,
    exports: {
      Pool: function () { return { query: handler }; }
    }
  };
  delete require.cache[require.resolve('../db')];
  return () => {
    if (originalPg) require.cache[pgPath] = originalPg;
    else delete require.cache[pgPath];
    delete require.cache[require.resolve('../db')];
  };
}

async function testPublicTokenQueryProjectsAllThreeHandles() {
  const captured = [];
  const restore = stubPg(async (text, params) => {
    captured.push({ text, params });
    return { rows: [{
      id: 5, invoice_number: 'INV-1',
      owner_venmo_handle: 'joe',
      owner_cashapp_handle: 'joecash',
      owner_paypal_me_handle: 'joepaypal'
    }] };
  });
  try {
    const { db } = require('../db');
    const row = await db.getInvoiceByPublicToken('cafef00ddeadbeef');
    assert.strictEqual(captured.length, 1);
    const sql = captured[0].text;
    assert.ok(/u\.venmo_handle\s+AS\s+owner_venmo_handle/i.test(sql),
      'public-page SELECT must project users.venmo_handle AS owner_venmo_handle');
    assert.ok(/u\.cashapp_handle\s+AS\s+owner_cashapp_handle/i.test(sql),
      'public-page SELECT must project users.cashapp_handle AS owner_cashapp_handle');
    assert.ok(/u\.paypal_me_handle\s+AS\s+owner_paypal_me_handle/i.test(sql),
      'public-page SELECT must project users.paypal_me_handle AS owner_paypal_me_handle');
    assert.strictEqual(row.owner_venmo_handle, 'joe');
    assert.strictEqual(row.owner_cashapp_handle, 'joecash');
    assert.strictEqual(row.owner_paypal_me_handle, 'joepaypal');
  } finally { restore(); }
}

// ---------- 3-5. POST /billing/settings round-trip ----------------------

const updateUserCalls = [];
let userStore = {};

function installSettingsStubs() {
  const dbStub = {
    pool: { query: async () => ({ rows: [] }) },
    db: {
      async getUserById(id) { return userStore[id] || null; },
      async updateUser(id, fields) {
        updateUserCalls.push({ id, fields });
        const u = userStore[id];
        if (!u) return null;
        Object.assign(u, fields);
        return u;
      },
      async markInvoicePaidByPaymentLinkId() { return null; }
    }
  };
  require.cache[require.resolve('../db')] = {
    id: require.resolve('../db'),
    filename: require.resolve('../db'),
    loaded: true,
    exports: dbStub
  };
  const stripePath = require.resolve('stripe');
  require.cache[stripePath] = {
    id: stripePath, filename: stripePath, loaded: true,
    exports: () => ({
      webhooks: { constructEvent: () => { throw new Error('not used'); } },
      customers: { async create() { return { id: 'cus_x' }; }, async retrieve() { return { metadata: {} }; } },
      checkout: { sessions: { async create() { return { url: '' }; } } },
      billingPortal: { sessions: { async create() { return { url: '' }; } } }
    })
  };
  clearReq('../routes/billing');
  return require('../routes/billing');
}

function buildSettingsApp(sessionUser) {
  const billingRoutes = installSettingsStubs();
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', VIEWS);
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, _res, next) => { if (sessionUser) req.session.user = sessionUser; next(); });
  app.use((req, res, next) => { res.locals.user = sessionUser || null; next(); });
  app.use('/billing', billingRoutes);
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

function getPath(app, url) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      http.get({ hostname: '127.0.0.1', port, path: url }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => server.close(() => resolve({ status: res.statusCode, body: data })));
      }).on('error', e => { server.close(); reject(e); });
    });
  });
}

async function testSettingsPostPersistsAllThreeHandles() {
  updateUserCalls.length = 0;
  userStore = {
    21: { id: 21, email: 'g@x.com', name: 'G', plan: 'free' }
  };
  const app = buildSettingsApp({ id: 21, plan: 'free', name: 'G', email: 'g@x.com' });
  // Mix of @-prefixed, $-prefixed, and full-URL pasted values — all
  // must normalize to bare canonical handles.
  const res = await postForm(app, '/billing/settings', {
    name: 'G',
    venmo_handle: '@gretchen',
    cashapp_handle: '$gretchencash',
    paypal_me_handle: 'https://paypal.me/gretchenpay'
  });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(updateUserCalls.length, 1, 'db.updateUser must be called once');
  const fields = updateUserCalls[0].fields;
  assert.strictEqual(fields.venmo_handle, 'gretchen',
    'venmo_handle must persist as bare handle (leading @ stripped)');
  assert.strictEqual(fields.cashapp_handle, 'gretchencash',
    'cashapp_handle must persist as bare cashtag (leading $ stripped)');
  assert.strictEqual(fields.paypal_me_handle, 'gretchenpay',
    'paypal_me_handle must persist as bare handle (URL prefix stripped)');
}

async function testSettingsPostRejectsInvalidVenmoHandle() {
  updateUserCalls.length = 0;
  userStore = {
    22: { id: 22, email: 'h@x.com', name: 'H', plan: 'free', venmo_handle: 'safe' }
  };
  const app = buildSettingsApp({ id: 22, plan: 'free', name: 'H', email: 'h@x.com' });
  const res = await postForm(app, '/billing/settings', {
    name: 'H',
    venmo_handle: 'has spaces in it!'
  });
  assert.strictEqual(res.status, 302, 'must redirect (with error flash)');
  assert.ok(res.headers.location.includes('/billing/settings'),
    'must redirect back to settings so the user sees the error');
  assert.strictEqual(updateUserCalls.length, 0,
    'db.updateUser must NOT fire on invalid Venmo handle — user keeps the previous value');
}

async function testSettingsPostRejectsInvalidCashappHandle() {
  updateUserCalls.length = 0;
  userStore = {
    23: { id: 23, email: 'i@x.com', name: 'I', plan: 'free', cashapp_handle: 'safe' }
  };
  const app = buildSettingsApp({ id: 23, plan: 'free', name: 'I', email: 'i@x.com' });
  // Cashtag starting with a digit is rejected by Cash App itself.
  const res = await postForm(app, '/billing/settings', {
    name: 'I',
    cashapp_handle: '123starts-with-digit'
  });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(updateUserCalls.length, 0,
    'invalid cashtag must not trigger updateUser');
}

async function testSettingsPostRejectsInvalidPaypalHandle() {
  updateUserCalls.length = 0;
  userStore = {
    24: { id: 24, email: 'j@x.com', name: 'J', plan: 'free', paypal_me_handle: 'safe' }
  };
  const app = buildSettingsApp({ id: 24, plan: 'free', name: 'J', email: 'j@x.com' });
  // PayPal.me disallows underscore.
  const res = await postForm(app, '/billing/settings', {
    name: 'J',
    paypal_me_handle: 'john_doe'
  });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(updateUserCalls.length, 0,
    'invalid PayPal.me handle must not trigger updateUser');
}

async function testSettingsPostClearsHandlesOnEmpty() {
  updateUserCalls.length = 0;
  userStore = {
    25: {
      id: 25, email: 'k@x.com', name: 'K', plan: 'free',
      venmo_handle: 'old', cashapp_handle: 'old', paypal_me_handle: 'old'
    }
  };
  const app = buildSettingsApp({ id: 25, plan: 'free', name: 'K', email: 'k@x.com' });
  const res = await postForm(app, '/billing/settings', {
    name: 'K',
    venmo_handle: '',
    cashapp_handle: '   ',
    paypal_me_handle: ''
  });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(updateUserCalls.length, 1);
  const fields = updateUserCalls[0].fields;
  assert.strictEqual(fields.venmo_handle, null,
    'empty venmo_handle persists as NULL (lets user remove a stale handle)');
  assert.strictEqual(fields.cashapp_handle, null,
    'whitespace-only cashapp_handle persists as NULL');
  assert.strictEqual(fields.paypal_me_handle, null,
    'empty paypal_me_handle persists as NULL');
}

// ---------- 6. settings.ejs surfaces all 3 inputs -----------------------

async function testSettingsViewRendersThreeHandleInputs() {
  userStore = {
    26: {
      id: 26, email: 'l@x.com', name: 'L', plan: 'free',
      invoice_count: 0,
      venmo_handle: 'savedvenmo',
      cashapp_handle: 'savedcash',
      paypal_me_handle: 'savedpaypal'
    }
  };
  const app = buildSettingsApp({ id: 26, plan: 'free', name: 'L', email: 'l@x.com' });
  const res = await getPath(app, '/billing/settings');
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.includes('data-testid="settings-venmo-handle"'),
    'settings page must surface the Venmo input by stable testid');
  assert.ok(res.body.includes('data-testid="settings-cashapp-handle"'),
    'settings page must surface the Cash App input by stable testid');
  assert.ok(res.body.includes('data-testid="settings-paypal-me-handle"'),
    'settings page must surface the PayPal.me input by stable testid');
  assert.ok(res.body.includes('value="savedvenmo"'),
    'saved Venmo handle must be pre-filled');
  assert.ok(res.body.includes('value="savedcash"'),
    'saved Cash App handle must be pre-filled');
  assert.ok(res.body.includes('value="savedpaypal"'),
    'saved PayPal.me handle must be pre-filled');
}

// ---------- 7. invoice-public.ejs renders the buttons -------------------

function buildSampleInvoiceRow(overrides) {
  return Object.assign({
    id: 5,
    invoice_number: 'INV-2026-0042',
    client_name: 'Acme Co.',
    client_email: 'pay@acme.com',
    client_address: '',
    items: [{ description: 'Design consultation', quantity: 4, unit_price: 75 }],
    subtotal: 300, tax_rate: 0, tax_amount: 0, total: 300, notes: null,
    status: 'sent',
    issued_date: new Date('2026-05-01'),
    due_date: new Date('2026-05-31'),
    payment_link_url: null,
    public_token: 'cafef00ddeadbeef',
    owner_id: 11,
    owner_name: 'Jordan Pine',
    owner_email: 'jordan@example.com',
    owner_business_name: 'Pine Studio',
    owner_business_address: '123 Maple St',
    owner_business_email: 'hi@pinestudio.com',
    owner_business_phone: '555-0100',
    owner_payment_instructions: null,
    owner_venmo_handle: null,
    owner_cashapp_handle: null,
    owner_paypal_me_handle: null,
    owner_plan: 'free'
  }, overrides || {});
}

async function testPublicViewRendersAllThreeButtonsWhenSet() {
  const html = await renderPublic(buildSampleInvoiceRow({
    status: 'sent',
    total: 300,
    invoice_number: 'INV-2026-0042',
    owner_venmo_handle: 'jpine',
    owner_cashapp_handle: 'jpinecash',
    owner_paypal_me_handle: 'jpinepay'
  }));
  assert.ok(html.includes('data-testid="public-tap-to-pay"'),
    'tap-to-pay card must render when any handle is set');
  // Venmo
  assert.ok(html.includes('data-testid="public-tap-to-pay-venmo"'),
    'Venmo button must render');
  assert.ok(html.includes('href="https://venmo.com/jpine?'),
    'Venmo href must use canonical handle');
  assert.ok(html.includes('amount=300.00'),
    'Venmo href must include the two-decimal amount');
  assert.ok(/note=Invoice(\+|%20)INV-2026-0042/.test(html),
    'Venmo href must include the invoice number in the note');
  // Cash App
  assert.ok(html.includes('data-testid="public-tap-to-pay-cashapp"'),
    'Cash App button must render');
  assert.ok(html.includes('href="https://cash.app/$jpinecash/300.00"'),
    'Cash App href must include the cashtag and amount');
  // PayPal
  assert.ok(html.includes('data-testid="public-tap-to-pay-paypal"'),
    'PayPal button must render');
  assert.ok(html.includes('href="https://paypal.me/jpinepay/300.00USD"'),
    'PayPal href must include handle, amount, and USD currency suffix');
}

async function testPublicViewRendersOnlyTheSetButton() {
  const html = await renderPublic(buildSampleInvoiceRow({
    status: 'sent',
    owner_venmo_handle: 'onlyvenmo',
    owner_cashapp_handle: null,
    owner_paypal_me_handle: null
  }));
  assert.ok(html.includes('data-testid="public-tap-to-pay-venmo"'),
    'Venmo button must render when only venmo_handle is set');
  assert.ok(!html.includes('data-testid="public-tap-to-pay-cashapp"'),
    'Cash App button must NOT render when cashapp_handle is null');
  assert.ok(!html.includes('data-testid="public-tap-to-pay-paypal"'),
    'PayPal button must NOT render when paypal_me_handle is null');
}

async function testPublicViewSuppressesCardWhenAllUnset() {
  const html = await renderPublic(buildSampleInvoiceRow({ status: 'sent' }));
  assert.ok(!html.includes('data-testid="public-tap-to-pay"'),
    'tap-to-pay card must NOT render when all three handles are unset');
}

async function testPublicViewSuppressesCardOnPaid() {
  const html = await renderPublic(buildSampleInvoiceRow({
    status: 'paid',
    owner_venmo_handle: 'jpine'
  }));
  assert.ok(!html.includes('data-testid="public-tap-to-pay"'),
    'tap-to-pay card must NOT render on paid invoices (no remaining payment action)');
  assert.ok(html.includes('data-testid="public-paid-banner"'),
    'paid banner still renders so the client confirms settlement');
}

async function testPublicViewIgnoresInvalidStoredHandles() {
  // Defence in depth: if a malformed handle somehow lands in the DB
  // (older migration, manual SQL edit), the public template must NOT
  // emit a broken href — the URL builder returns null for invalid
  // handles, so the button just doesn't render.
  const html = await renderPublic(buildSampleInvoiceRow({
    status: 'sent',
    owner_venmo_handle: 'has spaces',
    owner_cashapp_handle: '123digit-start',
    owner_paypal_me_handle: 'has_underscore'
  }));
  assert.ok(!html.includes('data-testid="public-tap-to-pay"'),
    'invalid stored handles must not produce a tap-to-pay card with broken hrefs');
}

async function testPublicViewCardCoexistsWithStripePayCta() {
  // Pro user with both a Stripe payment link AND a P2P handle: both
  // surfaces render. Clients have payment-method preferences (some
  // refuse card, some refuse P2P apps), so the more rails surfaced
  // in one place, the higher the chance a tap lands.
  const html = await renderPublic(buildSampleInvoiceRow({
    status: 'sent',
    owner_plan: 'pro',
    payment_link_url: 'https://buy.stripe.com/test',
    owner_venmo_handle: 'jpine'
  }));
  assert.ok(html.includes('data-testid="public-pay-cta"'),
    'Pro Stripe Pay-now CTA must still render');
  assert.ok(html.includes('data-testid="public-tap-to-pay"'),
    'tap-to-pay card must coexist with Stripe — different rails, different client preferences');
}

// ---------- runner -------------------------------------------------------

async function run() {
  const tests = [
    ['schema.sql: idempotent ALTERs for venmo_handle / cashapp_handle / paypal_me_handle', testSchemaIncludesTapToPayMigrations],
    ['db.getInvoiceByPublicToken: SELECT projects all three owner_* handle columns', testPublicTokenQueryProjectsAllThreeHandles],
    ['POST /billing/settings: persists all three handles (normalized, @/$/URL stripped)', testSettingsPostPersistsAllThreeHandles],
    ['POST /billing/settings: invalid Venmo handle rejected (no updateUser)', testSettingsPostRejectsInvalidVenmoHandle],
    ['POST /billing/settings: invalid Cash App cashtag rejected (no updateUser)', testSettingsPostRejectsInvalidCashappHandle],
    ['POST /billing/settings: invalid PayPal.me handle rejected (no updateUser)', testSettingsPostRejectsInvalidPaypalHandle],
    ['POST /billing/settings: empty/whitespace handle inputs persist as NULL (clear signal)', testSettingsPostClearsHandlesOnEmpty],
    ['settings.ejs: renders all three handle inputs pre-filled with saved values', testSettingsViewRendersThreeHandleInputs],
    ['invoice-public.ejs: renders all three buttons with correct hrefs when set', testPublicViewRendersAllThreeButtonsWhenSet],
    ['invoice-public.ejs: renders only buttons whose handle is set (partial config)', testPublicViewRendersOnlyTheSetButton],
    ['invoice-public.ejs: suppresses tap-to-pay card when no handles set', testPublicViewSuppressesCardWhenAllUnset],
    ['invoice-public.ejs: suppresses tap-to-pay card on paid invoices', testPublicViewSuppressesCardOnPaid],
    ['invoice-public.ejs: ignores invalid stored handles (defence in depth)', testPublicViewIgnoresInvalidStoredHandles],
    ['invoice-public.ejs: tap-to-pay card coexists with Stripe Pay-now CTA on Pro accounts', testPublicViewCardCoexistsWithStripePayCta]
  ];

  let pass = 0, fail = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ok  ${name}`);
      pass++;
    } catch (err) {
      console.error(`  FAIL ${name}`);
      console.error(err && err.stack ? err.stack : err);
      fail++;
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run().catch(err => { console.error(err); process.exit(1); });
