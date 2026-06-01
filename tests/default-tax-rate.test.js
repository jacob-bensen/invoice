'use strict';

/*
 * Per-user default tax rate (Milestone 2 — first dashboard re-entry →
 * first real invoice created). Until this ship the GET /invoices/new
 * form's Tax % input rendered 0 on every fresh-invoice render, forcing
 * every VAT / GST / sales-tax freelancer to retype their rate on every
 * invoice (and silently under-invoicing the moment they forgot). The
 * new `users.default_tax_rate` column (NUMERIC(5,2) NOT NULL DEFAULT 0,
 * bounded 0-100 with up to 2 decimals at the settings route) is the
 * single source of truth.
 *
 * Run: NODE_ENV=test node tests/default-tax-rate.test.js
 */

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const express = require('express');
const session = require('express-session');
const http = require('http');

function clearReq(mod) {
  try { delete require.cache[require.resolve(mod)]; } catch (_) { /* noop */ }
}

// ---------- Settings route tests ----------------------------------------

const users = new Map();
const updateUserCalls = [];

function resetSettingsStores() {
  users.clear();
  updateUserCalls.length = 0;
}

const billingDbStub = {
  pool: { query: async () => ({ rows: [] }) },
  db: {
    async getUserByEmail() { return null; },
    async getUserById(id) { return users.get(id) || null; },
    async updateUser(id, fields) {
      updateUserCalls.push({ id, fields });
      const u = users.get(id);
      if (u) Object.assign(u, fields);
      return u || null;
    }
  }
};

require.cache[require.resolve('../db')] = {
  id: require.resolve('../db'),
  filename: require.resolve('../db'),
  loaded: true,
  exports: billingDbStub
};

require.cache[require.resolve('stripe')] = {
  id: require.resolve('stripe'),
  filename: require.resolve('stripe'),
  loaded: true,
  exports: () => ({
    checkout: { sessions: { create: async () => ({ url: 'https://x' }) } },
    billingPortal: { sessions: { create: async () => ({ url: 'https://x' }) } },
    webhooks: { constructEvent: () => ({}) },
    customers: { update: async () => ({}) },
    paymentLinks: { create: async () => ({ id: 'p', url: 'https://x' }) }
  })
};

clearReq('../routes/billing');
const billingRoutes = require('../routes/billing');

function buildBillingApp(sessionUser) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, _res, next) => {
    if (sessionUser) req.session.user = sessionUser;
    next();
  });
  app.use((req, res, next) => { res.locals.user = sessionUser || null; next(); });
  app.use('/billing', billingRoutes);
  return app;
}

function request(app, method, url, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const payload = body ? new URLSearchParams(body).toString() : '';
      const headers = {};
      if (payload) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        headers['Content-Length'] = Buffer.byteLength(payload);
      }
      const req = http.request(
        { hostname: '127.0.0.1', port, path: url, method, headers },
        res => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => server.close(() => resolve({
            status: res.statusCode, headers: res.headers, body: data
          })));
        }
      );
      req.on('error', err => { server.close(); reject(err); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

async function testSettingsSavesDefaultTaxRate() {
  resetSettingsStores();
  users.set(40, { id: 40, email: 'me@x.com', name: 'M', plan: 'free', default_tax_rate: 0 });
  const app = buildBillingApp({ id: 40, plan: 'free' });
  const res = await request(app, 'POST', '/billing/settings', {
    name: 'M', default_tax_rate: '19'
  });
  assert.strictEqual(res.status, 302, 'settings save must redirect');
  assert.ok(updateUserCalls.length >= 1, 'db.updateUser must be called');
  const call = updateUserCalls[updateUserCalls.length - 1];
  assert.strictEqual(call.fields.default_tax_rate, 19,
    'DE VAT 19% must persist as the number 19');
}

async function testSettingsAcceptsFractionalRate() {
  resetSettingsStores();
  users.set(41, { id: 41, email: 'me@x.com', name: 'M', plan: 'free', default_tax_rate: 0 });
  const app = buildBillingApp({ id: 41, plan: 'free' });
  const res = await request(app, 'POST', '/billing/settings', {
    name: 'M', default_tax_rate: '8.875'  // 3 decimals — must reject
  });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(updateUserCalls.length, 0,
    'more than 2 decimals must be rejected — NUMERIC(5,2) would silently truncate without this guard');
}

async function testSettingsAcceptsTwoDecimals() {
  resetSettingsStores();
  users.set(42, { id: 42, email: 'me@x.com', name: 'M', plan: 'free', default_tax_rate: 0 });
  const app = buildBillingApp({ id: 42, plan: 'free' });
  const res = await request(app, 'POST', '/billing/settings', {
    name: 'M', default_tax_rate: '8.88'  // NYC sales tax rounded — must accept
  });
  assert.strictEqual(res.status, 302);
  const call = updateUserCalls[updateUserCalls.length - 1];
  assert.strictEqual(call.fields.default_tax_rate, 8.88,
    'two-decimal rate (8.88% — NYC sales-tax norm) must persist with full precision');
}

async function testSettingsAcceptsMaxBoundary() {
  resetSettingsStores();
  users.set(43, { id: 43, email: 'me@x.com', name: 'M', plan: 'free', default_tax_rate: 0 });
  const app = buildBillingApp({ id: 43, plan: 'free' });
  const res = await request(app, 'POST', '/billing/settings', {
    name: 'M', default_tax_rate: '100'
  });
  assert.strictEqual(res.status, 302);
  const call = updateUserCalls[updateUserCalls.length - 1];
  assert.strictEqual(call.fields.default_tax_rate, 100, '100% is the inclusive max');
}

async function testSettingsAcceptsMinBoundary() {
  resetSettingsStores();
  users.set(44, { id: 44, email: 'me@x.com', name: 'M', plan: 'free', default_tax_rate: 19 });
  const app = buildBillingApp({ id: 44, plan: 'free' });
  const res = await request(app, 'POST', '/billing/settings', {
    name: 'M', default_tax_rate: '0'
  });
  assert.strictEqual(res.status, 302);
  const call = updateUserCalls[updateUserCalls.length - 1];
  assert.strictEqual(call.fields.default_tax_rate, 0,
    '0 is the inclusive min — turning off a previously-saved rate must persist as 0, not silently keep 19');
}

async function testSettingsRejectsNegative() {
  resetSettingsStores();
  users.set(45, { id: 45, email: 'me@x.com', name: 'M', plan: 'free', default_tax_rate: 0 });
  const app = buildBillingApp({ id: 45, plan: 'free' });
  const res = await request(app, 'POST', '/billing/settings', {
    name: 'M', default_tax_rate: '-5'
  });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(updateUserCalls.length, 0,
    'negative rate rejected — sign rejection is in the regex, not just the range check');
}

async function testSettingsRejectsOverMax() {
  resetSettingsStores();
  users.set(46, { id: 46, email: 'me@x.com', name: 'M', plan: 'free', default_tax_rate: 0 });
  const app = buildBillingApp({ id: 46, plan: 'free' });
  const res = await request(app, 'POST', '/billing/settings', {
    name: 'M', default_tax_rate: '150'
  });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(updateUserCalls.length, 0,
    '> 100 rejected — no tax jurisdiction on earth has a > 100% rate');
}

async function testSettingsRejectsNonNumeric() {
  resetSettingsStores();
  users.set(47, { id: 47, email: 'me@x.com', name: 'M', plan: 'free', default_tax_rate: 0 });
  const app = buildBillingApp({ id: 47, plan: 'free' });
  const res = await request(app, 'POST', '/billing/settings', {
    name: 'M', default_tax_rate: 'nineteen'
  });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(updateUserCalls.length, 0,
    'non-numeric rejected (no parseFloat accidentally writing NaN)');
}

async function testSettingsRejectsLeadingDot() {
  resetSettingsStores();
  users.set(48, { id: 48, email: 'me@x.com', name: 'M', plan: 'free', default_tax_rate: 0 });
  const app = buildBillingApp({ id: 48, plan: 'free' });
  const res = await request(app, 'POST', '/billing/settings', {
    name: 'M', default_tax_rate: '.5'  // leading-dot form must be rejected
  });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(updateUserCalls.length, 0,
    'leading-dot ".5" rejected — the regex requires at least one digit before the decimal');
}

async function testSettingsEmptyStringResetsToZero() {
  resetSettingsStores();
  users.set(49, { id: 49, email: 'me@x.com', name: 'M', plan: 'free', default_tax_rate: 20 });
  const app = buildBillingApp({ id: 49, plan: 'free' });
  const res = await request(app, 'POST', '/billing/settings', {
    name: 'M', default_tax_rate: ''
  });
  assert.strictEqual(res.status, 302);
  const call = updateUserCalls[updateUserCalls.length - 1];
  assert.strictEqual(call.fields.default_tax_rate, 0,
    'empty submission resets to 0 (NOT NULL default) — never writes NULL into a NOT NULL column');
}

async function testSettingsViewRendersSavedRate() {
  const html = await ejs.renderFile(
    path.join(__dirname, '..', 'views', 'settings.ejs'),
    {
      title: 'Settings',
      user: {
        email: 'me@x.com', name: 'M', plan: 'free',
        business_name: null, business_address: null,
        business_email: null, business_phone: null,
        webhook_url: null, invoice_count: 0,
        reply_to_email: null, payment_instructions: null,
        bcc_invoice_emails: false,
        default_invoice_notes: null,
        default_currency: 'EUR',
        default_payment_terms_days: 30,
        default_tax_rate: 19
      },
      flash: null
    },
    { rmWhitespace: false }
  );
  assert.ok(html.includes('name="default_tax_rate"'),
    'settings view must render the default_tax_rate input');
  assert.ok(html.includes('data-testid="settings-default-tax-rate"'),
    'input must carry a stable data-testid');
  const m = html.match(/<input[^>]*name="default_tax_rate"[^>]*>/);
  assert.ok(m, 'input element must be present');
  assert.ok(/value="19"/.test(m[0]),
    'input value must reflect the saved 19, not the default 0');
  assert.ok(/min="0"/.test(m[0]) && /max="100"/.test(m[0]),
    'input must carry min=0 + max=100 client-side guards');
  assert.ok(/step="0\.01"/.test(m[0]),
    'input must carry step=0.01 so 8.875%-style rates can be typed cleanly');
}

async function testSettingsViewFallsBackToZero() {
  const html = await ejs.renderFile(
    path.join(__dirname, '..', 'views', 'settings.ejs'),
    {
      title: 'Settings',
      user: {
        email: 'me@x.com', name: 'M', plan: 'free',
        business_name: null, business_address: null,
        business_email: null, business_phone: null,
        webhook_url: null, invoice_count: 0,
        reply_to_email: null, payment_instructions: null,
        bcc_invoice_emails: false,
        default_invoice_notes: null,
        default_currency: 'USD',
        default_payment_terms_days: 30,
        default_tax_rate: null
      },
      flash: null
    },
    { rmWhitespace: false }
  );
  const m = html.match(/<input[^>]*name="default_tax_rate"[^>]*>/);
  assert.ok(m, 'input must render even when default_tax_rate is null');
  assert.ok(/value="0"/.test(m[0]),
    'null value falls back to 0 — the historical "no tax" default — so the input is never empty');
}

// ---------- /invoices/new view tests ------------------------------------

async function testInvoiceFormTaxRatePrefilledFromUserDefault() {
  const html = await ejs.renderFile(
    path.join(__dirname, '..', 'views', 'invoice-form.ejs'),
    {
      title: 'New Invoice',
      invoice: null,
      invoiceNumber: 'INV-2026-0001',
      recentClients: [],
      recentItems: [],
      user: {
        id: 1, email: 'me@x.com', name: 'M', plan: 'free',
        business_name: 'My Studio', invoice_count: 0,
        payment_instructions: null,
        default_invoice_notes: null,
        default_payment_terms_days: 30,
        default_tax_rate: 19  // DE freelancer
      },
      flash: null,
      noindex: true
    },
    { rmWhitespace: false }
  );
  // The Alpine factory's initial taxRate must seed from the user's default.
  assert.ok(/taxRate:\s*19/.test(html),
    'Alpine x-data factory must seed taxRate from user.default_tax_rate (19), not the hardcoded 0');
  // The under-totals hint must surface the saved rate so the user knows
  // where it came from and how to change it.
  assert.ok(/Defaulting to your saved 19% rate/.test(html),
    'under-totals hint must surface the saved rate so the user knows it came from settings');
  assert.ok(/data-testid="invoice-form-tax-default-hint"/.test(html),
    'hint must carry a stable data-testid');
  // Hint links to settings so the change-path is one click away.
  assert.ok(/href="\/billing\/settings"/.test(html),
    'hint must link to /billing/settings');
}

async function testInvoiceFormTaxHintHiddenWhenDefaultIsZero() {
  const html = await ejs.renderFile(
    path.join(__dirname, '..', 'views', 'invoice-form.ejs'),
    {
      title: 'New Invoice',
      invoice: null,
      invoiceNumber: 'INV-2026-0001',
      recentClients: [],
      recentItems: [],
      user: {
        id: 1, email: 'me@x.com', name: 'M', plan: 'free',
        business_name: 'My Studio', invoice_count: 0,
        payment_instructions: null,
        default_invoice_notes: null,
        default_payment_terms_days: 30,
        default_tax_rate: 0  // US service freelancer, no sales tax
      },
      flash: null,
      noindex: true
    },
    { rmWhitespace: false }
  );
  assert.ok(/taxRate:\s*0/.test(html),
    'taxRate must default to 0 when user.default_tax_rate is 0 — the historical behaviour');
  assert.ok(!/Defaulting to your saved/.test(html),
    'hint must NOT render when default is 0 — no useful information, just visual noise');
  assert.ok(!/data-testid="invoice-form-tax-default-hint"/.test(html),
    'hint testid must be absent when default is 0');
}

async function testInvoiceFormEditFlowKeepsInvoiceTaxRate() {
  // Edit-flow: the invoice already has its own tax_rate — that wins over
  // the user's default. A user who changed their default tax rate since
  // creating an old invoice must not have that old invoice silently
  // overwritten by the form pre-fill.
  const html = await ejs.renderFile(
    path.join(__dirname, '..', 'views', 'invoice-form.ejs'),
    {
      title: 'Edit Invoice',
      invoice: {
        id: 7,
        client_name: 'Acme', client_email: 'a@x.com', client_address: '',
        items: [{ description: 'Work', quantity: 1, unit_price: 100 }],
        subtotal: 100, tax_rate: 7, tax_amount: 7, total: 107,
        notes: null,
        issued_date: new Date('2026-05-01'),
        due_date: new Date('2026-05-31'),
        status: 'draft', invoice_number: 'INV-2026-0007'
      },
      invoiceNumber: 'INV-2026-0007',
      recentClients: [],
      recentItems: [],
      user: {
        id: 1, email: 'me@x.com', name: 'M', plan: 'free',
        business_name: 'My Studio', invoice_count: 5,
        payment_instructions: null,
        default_invoice_notes: null,
        default_payment_terms_days: 30,
        default_tax_rate: 19  // user later switched defaults to 19
      },
      flash: null,
      noindex: true
    },
    { rmWhitespace: false }
  );
  // taxRate must come from the existing invoice (7), not the user's
  // default (19). The per-invoice value is sacred on edit.
  assert.ok(/taxRate:\s*7/.test(html),
    'edit-flow taxRate must come from invoice.tax_rate (7), not user.default_tax_rate (19)');
  // The under-totals hint also suppresses on edit — the field is already
  // populated from the invoice, the user doesn't need a settings-defaults
  // explainer.
  assert.ok(!/data-testid="invoice-form-tax-default-hint"/.test(html),
    'hint must NOT render on edit — the invoice already has its own tax_rate');
}

async function testInvoiceFormOutOfRangeFallsBackToZero() {
  // Defence-in-depth: even though the settings route rejects out-of-range
  // values, a corrupt DB row could land a > 100 value. The view must
  // NEVER project that into the rendered tax_rate input.
  const html = await ejs.renderFile(
    path.join(__dirname, '..', 'views', 'invoice-form.ejs'),
    {
      title: 'New Invoice',
      invoice: null,
      invoiceNumber: 'INV-2026-0001',
      recentClients: [],
      recentItems: [],
      user: {
        id: 1, email: 'me@x.com', name: 'M', plan: 'free',
        business_name: 'My Studio', invoice_count: 0,
        payment_instructions: null,
        default_invoice_notes: null,
        default_payment_terms_days: 30,
        default_tax_rate: 9999  // hostile / corrupt
      },
      flash: null,
      noindex: true
    },
    { rmWhitespace: false }
  );
  assert.ok(/taxRate:\s*0/.test(html),
    'out-of-range default falls back to 0 in the Alpine factory seed');
  assert.ok(!/Defaulting to your saved 9999/.test(html),
    'hint must NOT echo the hostile value — the resolver collapses to 0 (no hint rendered)');
}

async function testInvoiceFormFractionalTaxDefaultSeeded() {
  // NYC sales-tax freelancer: 8.875% (settings route rejects 3-decimal
  // input, but a 2-decimal 8.88 round must seed cleanly).
  const html = await ejs.renderFile(
    path.join(__dirname, '..', 'views', 'invoice-form.ejs'),
    {
      title: 'New Invoice',
      invoice: null,
      invoiceNumber: 'INV-2026-0001',
      recentClients: [],
      recentItems: [],
      user: {
        id: 1, email: 'me@x.com', name: 'M', plan: 'free',
        business_name: 'My Studio', invoice_count: 0,
        payment_instructions: null,
        default_invoice_notes: null,
        default_payment_terms_days: 30,
        default_tax_rate: 8.88
      },
      flash: null,
      noindex: true
    },
    { rmWhitespace: false }
  );
  assert.ok(/taxRate:\s*8\.88/.test(html),
    'fractional default (8.88%) must seed the Alpine factory at full precision');
  assert.ok(/Defaulting to your saved 8\.88% rate/.test(html),
    'fractional default must surface in the hint at full precision');
}

async function testSchemaIncludesTaxRateMigration() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  assert.ok(
    /ALTER TABLE users ADD COLUMN IF NOT EXISTS default_tax_rate NUMERIC\(5,2\) NOT NULL DEFAULT 0/i.test(sql),
    'schema.sql must carry an idempotent ALTER for users.default_tax_rate NUMERIC(5,2) NOT NULL DEFAULT 0'
  );
}

async function run() {
  const tests = [
    ['POST /billing/settings — 19% (DE VAT) persists as the number 19', testSettingsSavesDefaultTaxRate],
    ['POST /billing/settings — 3 decimals (8.875) rejected (NUMERIC(5,2) would truncate)', testSettingsAcceptsFractionalRate],
    ['POST /billing/settings — 2 decimals (8.88, NYC sales tax) accepted', testSettingsAcceptsTwoDecimals],
    ['POST /billing/settings — max boundary 100 accepted', testSettingsAcceptsMaxBoundary],
    ['POST /billing/settings — min boundary 0 accepted (turn-off path)', testSettingsAcceptsMinBoundary],
    ['POST /billing/settings — negative rejected (no updateUser)', testSettingsRejectsNegative],
    ['POST /billing/settings — > 100 rejected (no updateUser)', testSettingsRejectsOverMax],
    ['POST /billing/settings — non-numeric rejected (no updateUser)', testSettingsRejectsNonNumeric],
    ['POST /billing/settings — leading-dot ".5" rejected (regex requires digit before decimal)', testSettingsRejectsLeadingDot],
    ['POST /billing/settings — empty submission resets to 0 (NOT NULL default)', testSettingsEmptyStringResetsToZero],
    ['views/settings.ejs — renders saved rate with min/max/step/testid', testSettingsViewRendersSavedRate],
    ['views/settings.ejs — null value falls back to 0 in the rendered input', testSettingsViewFallsBackToZero],
    ['views/invoice-form.ejs — new-invoice render seeds taxRate from user default + surfaces hint', testInvoiceFormTaxRatePrefilledFromUserDefault],
    ['views/invoice-form.ejs — zero default suppresses the hint (no visual noise)', testInvoiceFormTaxHintHiddenWhenDefaultIsZero],
    ['views/invoice-form.ejs — edit-flow keeps invoice.tax_rate (default never stomps)', testInvoiceFormEditFlowKeepsInvoiceTaxRate],
    ['views/invoice-form.ejs — out-of-range corrupt value falls back to 0 (no hint)', testInvoiceFormOutOfRangeFallsBackToZero],
    ['views/invoice-form.ejs — fractional default (8.88%) seeds at full precision', testInvoiceFormFractionalTaxDefaultSeeded],
    ['db/schema.sql — idempotent ALTER for users.default_tax_rate NUMERIC(5,2) NOT NULL DEFAULT 0', testSchemaIncludesTaxRateMigration]
  ];
  let pass = 0, fail = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ok  ${name}`);
      pass++;
    } catch (err) {
      console.error(`  FAIL ${name}`);
      console.error('       ' + (err && err.message));
      console.error('       ' + (err && err.stack && err.stack.split('\n').slice(1, 4).join('\n       ')));
      fail++;
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run().catch((err) => { console.error(err); process.exit(1); });
