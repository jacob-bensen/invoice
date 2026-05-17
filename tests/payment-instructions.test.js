'use strict';

/*
 * "How to pay" payment instructions on the public /i/<token> page
 * (Milestone 4 — first invoice sent → first payment received).
 *
 * Covers:
 *   - db.getInvoiceByPublicToken SQL projects u.payment_instructions AS
 *     owner_payment_instructions (so the public template can render it
 *     without a second query).
 *   - schema.sql ships the idempotent ALTER for users.payment_instructions.
 *   - POST /billing/settings persists payment_instructions, trims
 *     whitespace, clears with empty input, rejects > 2000 chars without
 *     mutating the DB.
 *   - views/invoice-public.ejs renders the block when set + unpaid,
 *     suppresses on paid, suppresses when null/empty, escapes hostile
 *     input, and preserves newlines via whitespace-pre-line.
 *   - views/settings.ejs surfaces the textarea + pre-fills existing value.
 *
 * Run: NODE_ENV=test node tests/payment-instructions.test.js
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

// ---------- pg stub plumbing (mirrors public-share-link.test.js) ---------

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

// ---------- db.getInvoiceByPublicToken: SQL projection --------------------

async function testGetInvoiceByPublicTokenProjectsPaymentInstructions() {
  const captured = [];
  const restore = stubPg(async (text, params) => {
    captured.push({ text, params });
    return { rows: [{
      id: 5, invoice_number: 'INV-2026-0001',
      owner_payment_instructions: 'Venmo @joe\nZelle: joe@bank.com'
    }] };
  });
  try {
    const { db } = require('../db');
    const row = await db.getInvoiceByPublicToken('cafef00ddeadbeef');
    assert.strictEqual(captured.length, 1);
    assert.ok(/u\.payment_instructions\s+AS\s+owner_payment_instructions/i.test(captured[0].text),
      'public-page SELECT must project users.payment_instructions as owner_payment_instructions ' +
      'so the template can render it without a second round-trip');
    assert.strictEqual(row.owner_payment_instructions, 'Venmo @joe\nZelle: joe@bank.com',
      'the projected column must flow through to the returned row verbatim');
  } finally { restore(); }
}

// ---------- schema.sql ----------------------------------------------------

function testSchemaIncludesPaymentInstructionsMigration() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  assert.ok(/ALTER\s+TABLE\s+users\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+payment_instructions\s+TEXT/i.test(sql),
    'schema.sql must carry an idempotent ALTER for users.payment_instructions TEXT');
}

// ---------- POST /billing/settings persistence ---------------------------

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
  delete require.cache[require.resolve('../routes/billing')];
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

async function testSettingsPostPersistsPaymentInstructions() {
  updateUserCalls.length = 0;
  userStore = {
    11: { id: 11, email: 'g@x.com', name: 'G', plan: 'free', payment_instructions: null }
  };
  const app = buildSettingsApp({ id: 11, plan: 'free', name: 'G', email: 'g@x.com' });
  const res = await postForm(app, '/billing/settings', {
    name: 'G',
    payment_instructions: 'Venmo @gretchen\nZelle: gretchen@bank.com'
  });
  assert.strictEqual(res.status, 302, 'valid payment_instructions must redirect on success');
  assert.strictEqual(updateUserCalls.length, 1, 'db.updateUser must be called once');
  assert.strictEqual(
    updateUserCalls[0].fields.payment_instructions,
    'Venmo @gretchen\nZelle: gretchen@bank.com',
    'payment_instructions must be persisted verbatim (newlines preserved)');
}

async function testSettingsPostTrimsAndClearsWhitespacePaymentInstructions() {
  updateUserCalls.length = 0;
  userStore = {
    12: { id: 12, email: 'h@x.com', name: 'H', plan: 'free', payment_instructions: 'old text' }
  };
  const app = buildSettingsApp({ id: 12, plan: 'free', name: 'H', email: 'h@x.com' });
  const res = await postForm(app, '/billing/settings', {
    name: 'H',
    payment_instructions: '   '
  });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(updateUserCalls.length, 1);
  assert.strictEqual(updateUserCalls[0].fields.payment_instructions, null,
    'whitespace-only payment_instructions must be persisted as NULL ' +
    '(lets the user clear the field once their bank details change)');
}

async function testSettingsPostRejectsOverLengthPaymentInstructions() {
  updateUserCalls.length = 0;
  userStore = {
    13: { id: 13, email: 'i@x.com', name: 'I', plan: 'free', payment_instructions: 'safe text' }
  };
  const app = buildSettingsApp({ id: 13, plan: 'free', name: 'I', email: 'i@x.com' });
  const huge = 'x'.repeat(2001);
  const res = await postForm(app, '/billing/settings', {
    name: 'I',
    payment_instructions: huge
  });
  assert.strictEqual(res.status, 302, 'over-length payment_instructions must redirect (with error flash)');
  assert.ok(res.headers.location.includes('/billing/settings'),
    'must redirect back to settings page so user sees the error');
  assert.strictEqual(updateUserCalls.length, 0,
    'over-length payment_instructions must NOT trigger a db.updateUser call ' +
    '(rejecting rather than truncating prevents silent loss of the user\'s bank details tail)');
}

// ---------- views/settings.ejs surfaces the textarea ---------------------

async function testSettingsViewRendersPaymentInstructionsTextarea() {
  // Render the settings page through the GET route so the full layout
  // partials (nav, head) initialise correctly.
  userStore = {
    14: {
      id: 14, email: 'j@x.com', name: 'J', plan: 'free',
      payment_instructions: 'Venmo @j',
      invoice_count: 0
    }
  };
  const app = buildSettingsApp({ id: 14, plan: 'free', name: 'J', email: 'j@x.com' });
  const res = await getPath(app, '/billing/settings');
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.includes('data-testid="settings-payment-instructions"'),
    'settings page must surface the payment-instructions textarea by testid');
  assert.ok(res.body.includes('Venmo @j'),
    'existing payment_instructions value must be pre-filled into the textarea');
  assert.ok(/name="payment_instructions"/.test(res.body),
    'textarea must POST under the payment_instructions name');
}

// ---------- views/invoice-public.ejs renders the block -------------------

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
    owner_plan: 'free'
  }, overrides || {});
}

async function testPublicViewRendersInstructionsWhenSetAndUnpaid() {
  const html = await ejs.renderFile(
    path.join(VIEWS, 'invoice-public.ejs'),
    { invoice: buildSampleInvoiceRow({
        status: 'sent',
        owner_payment_instructions: 'Venmo @joe\nZelle: joe@bank.com\nBank wire: ABA 021000021 / acct 12345'
      }), title: 't' },
    { views: [VIEWS] }
  );
  assert.ok(html.includes('data-testid="public-payment-instructions"'),
    'free-tier sent invoice with owner_payment_instructions set must surface the "How to pay" block — ' +
    'this is the only payment path on the public page for free users');
  assert.ok(/How to pay/i.test(html),
    '"How to pay" heading must be present so the client can find it');
  assert.ok(html.includes('Venmo @joe'),
    'instructions must render verbatim');
  assert.ok(html.includes('Zelle: joe@bank.com'),
    'multi-line instructions must all render (whitespace-pre-line)');
  assert.ok(/whitespace-pre-line/.test(html),
    'instructions container must apply whitespace-pre-line so the user\'s newlines survive');
}

async function testPublicViewSuppressesInstructionsWhenPaid() {
  const html = await ejs.renderFile(
    path.join(VIEWS, 'invoice-public.ejs'),
    { invoice: buildSampleInvoiceRow({
        status: 'paid',
        owner_payment_instructions: 'Venmo @joe'
      }), title: 't' },
    { views: [VIEWS] }
  );
  assert.ok(!html.includes('data-testid="public-payment-instructions"'),
    'a paid invoice must NOT show the "How to pay" block — once settled it\'s noise');
  assert.ok(html.includes('data-testid="public-paid-banner"'),
    'paid banner still renders so the client confirms the invoice is settled');
}

async function testPublicViewSuppressesInstructionsWhenUnset() {
  const html = await ejs.renderFile(
    path.join(VIEWS, 'invoice-public.ejs'),
    { invoice: buildSampleInvoiceRow({
        status: 'sent',
        owner_payment_instructions: null
      }), title: 't' },
    { views: [VIEWS] }
  );
  assert.ok(!html.includes('data-testid="public-payment-instructions"'),
    'no owner_payment_instructions means no "How to pay" block');
}

async function testPublicViewRendersInstructionsAlongsideProPayButton() {
  // Pro user with a Stripe payment link + filled instructions: the Pay-now
  // CTA carries the card path; the instructions block carries the
  // bank/ACH/cheque fallback. Both must coexist so a client who can't or
  // won't pay by card still has a path forward.
  const html = await ejs.renderFile(
    path.join(VIEWS, 'invoice-public.ejs'),
    { invoice: buildSampleInvoiceRow({
        status: 'sent',
        owner_plan: 'pro',
        payment_link_url: 'https://buy.stripe.com/test',
        owner_payment_instructions: 'Prefer ACH? Bank: Chase, routing 021000021, acct 1234567890'
      }), title: 't' },
    { views: [VIEWS] }
  );
  assert.ok(html.includes('data-testid="public-pay-cta"'),
    'Pro Pay-now CTA must still render');
  assert.ok(html.includes('data-testid="public-payment-instructions"'),
    'instructions block must coexist with the Pay-now CTA — it\'s the fallback for card-averse clients');
  assert.ok(html.includes('Prefer ACH?'),
    'instructions text must render verbatim');
}

async function testPublicViewEscapesHostilePaymentInstructions() {
  const hostile = '"><script>alert("xss")</script>';
  const html = await ejs.renderFile(
    path.join(VIEWS, 'invoice-public.ejs'),
    { invoice: buildSampleInvoiceRow({
        status: 'sent',
        owner_payment_instructions: hostile
      }), title: 't' },
    { views: [VIEWS] }
  );
  assert.ok(!html.includes('<script>alert("xss")</script>'),
    'hostile payment_instructions must be HTML-escaped — owner-controlled text but rendered to ' +
    'every client opening the share link, so an XSS here lands on every client browser');
  assert.ok(/&lt;script&gt;/.test(html) || /&lt;\/script&gt;/.test(html),
    'angle brackets in instructions must appear escaped in the rendered HTML');
}

// ---------- runner -------------------------------------------------------

async function run() {
  const tests = [
    ['db.getInvoiceByPublicToken: SELECT projects u.payment_instructions AS owner_payment_instructions', testGetInvoiceByPublicTokenProjectsPaymentInstructions],
    ['schema.sql: idempotent ALTER for users.payment_instructions TEXT', testSchemaIncludesPaymentInstructionsMigration],
    ['POST /billing/settings: payment_instructions persists verbatim with newlines', testSettingsPostPersistsPaymentInstructions],
    ['POST /billing/settings: whitespace-only payment_instructions persists as NULL', testSettingsPostTrimsAndClearsWhitespacePaymentInstructions],
    ['POST /billing/settings: > 2000-char payment_instructions rejected (no DB write)', testSettingsPostRejectsOverLengthPaymentInstructions],
    ['settings.ejs: renders payment_instructions textarea pre-filled', testSettingsViewRendersPaymentInstructionsTextarea],
    ['invoice-public.ejs: renders "How to pay" block when set + unpaid', testPublicViewRendersInstructionsWhenSetAndUnpaid],
    ['invoice-public.ejs: suppresses "How to pay" block on paid invoice', testPublicViewSuppressesInstructionsWhenPaid],
    ['invoice-public.ejs: suppresses "How to pay" block when owner_payment_instructions is null', testPublicViewSuppressesInstructionsWhenUnset],
    ['invoice-public.ejs: instructions block coexists with Pro Pay-now CTA (fallback path)', testPublicViewRendersInstructionsAlongsideProPayButton],
    ['invoice-public.ejs: HTML-escapes hostile payment_instructions', testPublicViewEscapesHostilePaymentInstructions]
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
