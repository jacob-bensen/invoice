'use strict';

/*
 * Per-user invoice-number customization (Milestone 3 — first invoice
 * created → first invoice sent). Until this ship, getNextInvoiceNumber
 * hardcoded "INV-YYYY-<pad(count+1,4)>" for every account. Two changes
 * matter to activation-side conversion:
 *   (a) Freelancers can now set a custom prefix ("ACME-", "JB-", etc.)
 *       so the invoice their client sees matches the freelancer's brand
 *       instead of a generic SaaS default — reduces the "am I really
 *       just a customer of an invoicing app?" friction beat that on
 *       high-value clients materially delays payment.
 *   (b) A starting-number bump (100, 1000) means a first-run
 *       freelancer's invoice #1 doesn't literally read "INV-2026-0001"
 *       — a legitimacy signal at exactly the surface where legitimacy
 *       matters most (invoice #1 → payment #1).
 *
 * Run: NODE_ENV=test node tests/invoice-number-prefix.test.js
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

// ---------- Pure lib/invoice-number tests -------------------------------

const {
  PREFIX_MAX_LEN,
  START_MIN,
  START_MAX,
  SEQUENCE_PAD,
  defaultPrefix,
  sanitizePrefix,
  sanitizeStart,
  formatInvoiceNumber
} = require('../lib/invoice-number');

async function testConstantsExposed() {
  assert.strictEqual(PREFIX_MAX_LEN, 20, 'PREFIX_MAX_LEN is the schema-side VARCHAR(20) cap');
  assert.strictEqual(START_MIN, 1);
  assert.strictEqual(START_MAX, 999999);
  assert.strictEqual(SEQUENCE_PAD, 4);
}

async function testDefaultPrefixResolvesYear() {
  const p = defaultPrefix(new Date('2027-03-14T12:00:00Z'));
  assert.strictEqual(p, 'INV-2027-',
    'defaultPrefix must render the year passed via the now arg (not just the process clock)');
  const p2 = defaultPrefix();
  assert.ok(/^INV-\d{4}-$/.test(p2),
    'defaultPrefix() with no arg must render INV-<current-year>-');
}

async function testSanitizePrefixAcceptsCommonShapes() {
  assert.strictEqual(sanitizePrefix('ACME-'), 'ACME-');
  assert.strictEqual(sanitizePrefix('  ACME-  '), 'ACME-', 'must trim whitespace');
  assert.strictEqual(sanitizePrefix('ACME-2026-'), 'ACME-2026-');
  assert.strictEqual(sanitizePrefix('2026-'), '2026-');
  assert.strictEqual(sanitizePrefix('JB.'), 'JB.', 'periods allowed');
  assert.strictEqual(sanitizePrefix('JB/'), 'JB/', 'slashes allowed');
  assert.strictEqual(sanitizePrefix('#'), '#', 'symbols allowed');
}

async function testSanitizePrefixRejectsInvalid() {
  assert.strictEqual(sanitizePrefix(null), null);
  assert.strictEqual(sanitizePrefix(undefined), null);
  assert.strictEqual(sanitizePrefix(''), null);
  assert.strictEqual(sanitizePrefix('   '), null, 'whitespace-only collapses to null');
  assert.strictEqual(sanitizePrefix(123), null, 'non-string collapses to null');
  assert.strictEqual(sanitizePrefix({}), null);
  assert.strictEqual(sanitizePrefix([]), null);
  assert.strictEqual(sanitizePrefix('A'.repeat(21)), null,
    'over-length (21) rejected; VARCHAR(20) column would silently truncate without this guard');
  assert.strictEqual(sanitizePrefix('A\nB-'), null, 'newline (control char 0x0A) rejected');
  assert.strictEqual(sanitizePrefix('A\tB-'), null, 'tab (control char 0x09) rejected');
  assert.strictEqual(sanitizePrefix('A\x7FB-'), null, 'DEL (0x7F) rejected');
  assert.strictEqual(sanitizePrefix('A\x00B-'), null, 'NUL (0x00) rejected');
}

async function testSanitizeStartAcceptsRange() {
  assert.strictEqual(sanitizeStart(1), 1);
  assert.strictEqual(sanitizeStart('100'), 100, 'string digit input accepted');
  assert.strictEqual(sanitizeStart('  100  '), 100, 'trims whitespace');
  assert.strictEqual(sanitizeStart(999999), 999999, 'inclusive max');
  assert.strictEqual(sanitizeStart('1'), 1, 'inclusive min');
}

async function testSanitizeStartRejectsInvalid() {
  assert.strictEqual(sanitizeStart(null), null);
  assert.strictEqual(sanitizeStart(undefined), null);
  assert.strictEqual(sanitizeStart(''), null);
  assert.strictEqual(sanitizeStart(0), null, 'zero rejected — no invoice #0');
  assert.strictEqual(sanitizeStart(-5), null, 'negative rejected');
  assert.strictEqual(sanitizeStart(1000000), null, 'over max rejected');
  assert.strictEqual(sanitizeStart('1.5'), null, 'fractional rejected — regex requires digits only');
  assert.strictEqual(sanitizeStart('one'), null, 'non-numeric rejected');
  assert.strictEqual(sanitizeStart('1e3'), null, 'scientific notation rejected');
  assert.strictEqual(sanitizeStart('-1'), null, 'signed rejected — regex has no sign');
}

async function testFormatDefaultsWhenPrefixIsNull() {
  const s = formatInvoiceNumber({
    existingCount: 0,
    prefix: null,
    startAt: null,
    now: new Date('2026-06-01T00:00:00Z')
  });
  assert.strictEqual(s, 'INV-2026-0001',
    'null prefix + start ⇒ historical default INV-YYYY-0001 (regression guard)');
}

async function testFormatUsesCustomPrefix() {
  const s = formatInvoiceNumber({
    existingCount: 0,
    prefix: 'ACME-',
    startAt: null,
    now: new Date('2026-06-01T00:00:00Z')
  });
  assert.strictEqual(s, 'ACME-0001',
    'custom prefix replaces the default entirely — user opts out of the year segment by omitting it');
}

async function testFormatUsesCustomStart() {
  const s = formatInvoiceNumber({
    existingCount: 0,
    prefix: null,
    startAt: 100,
    now: new Date('2026-06-01T00:00:00Z')
  });
  assert.strictEqual(s, 'INV-2026-0100',
    'startAt=100 with existingCount=0 emits the 100th number as the first invoice');
}

async function testFormatCombinesPrefixAndStart() {
  const s = formatInvoiceNumber({
    existingCount: 5,
    prefix: 'ACME-',
    startAt: 1000,
    now: new Date('2026-06-01T00:00:00Z')
  });
  assert.strictEqual(s, 'ACME-1005',
    'existingCount 5 + start 1000 ⇒ sequence 1005 with the custom prefix; both settings compose');
}

async function testFormatFallsBackOnCorruptPrefix() {
  const s = formatInvoiceNumber({
    existingCount: 0,
    prefix: '   ',
    startAt: 1,
    now: new Date('2026-06-01T00:00:00Z')
  });
  assert.strictEqual(s, 'INV-2026-0001',
    'whitespace-only prefix falls back to the default — a corrupt DB row must never produce a leading-space invoice number');
}

async function testFormatFallsBackOnCorruptStart() {
  const s = formatInvoiceNumber({
    existingCount: 0,
    prefix: null,
    startAt: 0,
    now: new Date('2026-06-01T00:00:00Z')
  });
  assert.strictEqual(s, 'INV-2026-0001',
    'zero startAt (corrupt) falls back to START_MIN=1 — defence in depth against direct-DB writes');
  const s2 = formatInvoiceNumber({
    existingCount: 0,
    prefix: null,
    startAt: 999999999,
    now: new Date('2026-06-01T00:00:00Z')
  });
  assert.strictEqual(s2, 'INV-2026-0001',
    'over-max startAt falls back to START_MIN=1 — never leak an out-of-range sequence into the invoice number');
}

async function testFormatCoercesNegativeExistingCount() {
  const s = formatInvoiceNumber({
    existingCount: -3,
    prefix: null,
    startAt: null,
    now: new Date('2026-06-01T00:00:00Z')
  });
  assert.strictEqual(s, 'INV-2026-0001',
    'existingCount < 0 (impossible from COUNT but defensive) collapses to 0 ⇒ sequence 1');
}

async function testFormatPadsLargeSequence() {
  const s = formatInvoiceNumber({
    existingCount: 500,
    prefix: null,
    startAt: 1000,
    now: new Date('2026-06-01T00:00:00Z')
  });
  assert.strictEqual(s, 'INV-2026-1500',
    'sequence 1500 padded to 4 digits (already 4 wide) — no additional padding');
  const s2 = formatInvoiceNumber({
    existingCount: 500,
    prefix: null,
    startAt: 99500,
    now: new Date('2026-06-01T00:00:00Z')
  });
  assert.strictEqual(s2, 'INV-2026-100000',
    'sequence 100000 (5 wide) preserved without truncation — padStart never shrinks');
}

// ---------- Schema tests -----------------------------------------------

async function testSchemaCarriesMigrations() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  assert.ok(
    /ALTER TABLE users ADD COLUMN IF NOT EXISTS invoice_number_prefix VARCHAR\(20\)/i.test(sql),
    'schema.sql must carry an idempotent ALTER for users.invoice_number_prefix VARCHAR(20)'
  );
  assert.ok(
    /ALTER TABLE users ADD COLUMN IF NOT EXISTS invoice_number_start INTEGER NOT NULL DEFAULT 1/i.test(sql),
    'schema.sql must carry an idempotent ALTER for users.invoice_number_start INTEGER NOT NULL DEFAULT 1'
  );
}

// ---------- Settings route round-trip tests ----------------------------

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

async function testSettingsSavesCustomPrefix() {
  resetSettingsStores();
  users.set(200, { id: 200, email: 'me@x.com', name: 'M', plan: 'free', invoice_number_prefix: null, invoice_number_start: 1 });
  const app = buildBillingApp({ id: 200, plan: 'free' });
  const res = await request(app, 'POST', '/billing/settings', {
    name: 'M', invoice_number_prefix: 'ACME-'
  });
  assert.strictEqual(res.status, 302);
  const call = updateUserCalls[updateUserCalls.length - 1];
  assert.strictEqual(call.fields.invoice_number_prefix, 'ACME-',
    'ACME- must persist verbatim');
}

async function testSettingsSavesCustomStart() {
  resetSettingsStores();
  users.set(201, { id: 201, email: 'me@x.com', name: 'M', plan: 'free', invoice_number_prefix: null, invoice_number_start: 1 });
  const app = buildBillingApp({ id: 201, plan: 'free' });
  const res = await request(app, 'POST', '/billing/settings', {
    name: 'M', invoice_number_start: '100'
  });
  assert.strictEqual(res.status, 302);
  const call = updateUserCalls[updateUserCalls.length - 1];
  assert.strictEqual(call.fields.invoice_number_start, 100,
    'start=100 must persist as an integer');
}

async function testSettingsEmptyPrefixPersistsAsNull() {
  resetSettingsStores();
  users.set(202, { id: 202, email: 'me@x.com', name: 'M', plan: 'free', invoice_number_prefix: 'ACME-', invoice_number_start: 1 });
  const app = buildBillingApp({ id: 202, plan: 'free' });
  const res = await request(app, 'POST', '/billing/settings', {
    name: 'M', invoice_number_prefix: ''
  });
  assert.strictEqual(res.status, 302);
  const call = updateUserCalls[updateUserCalls.length - 1];
  assert.strictEqual(call.fields.invoice_number_prefix, null,
    'empty submission clears the prefix back to NULL — reverts to the historical INV-YYYY- default on the next getNextInvoiceNumber call');
}

async function testSettingsEmptyStartResetsToOne() {
  resetSettingsStores();
  users.set(203, { id: 203, email: 'me@x.com', name: 'M', plan: 'free', invoice_number_prefix: null, invoice_number_start: 500 });
  const app = buildBillingApp({ id: 203, plan: 'free' });
  const res = await request(app, 'POST', '/billing/settings', {
    name: 'M', invoice_number_start: ''
  });
  assert.strictEqual(res.status, 302);
  const call = updateUserCalls[updateUserCalls.length - 1];
  assert.strictEqual(call.fields.invoice_number_start, 1,
    'empty submission resets to 1 (NOT NULL DEFAULT) — never writes NULL into a NOT NULL column');
}

async function testSettingsRejectsOversizePrefix() {
  resetSettingsStores();
  users.set(204, { id: 204, email: 'me@x.com', name: 'M', plan: 'free', invoice_number_prefix: null, invoice_number_start: 1 });
  const app = buildBillingApp({ id: 204, plan: 'free' });
  const res = await request(app, 'POST', '/billing/settings', {
    name: 'M', invoice_number_prefix: 'X'.repeat(21)
  });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(updateUserCalls.length, 0,
    '> 20 chars rejected — no updateUser call so other fields are preserved');
}

async function testSettingsRejectsPrefixControlChars() {
  resetSettingsStores();
  users.set(205, { id: 205, email: 'me@x.com', name: 'M', plan: 'free', invoice_number_prefix: null, invoice_number_start: 1 });
  const app = buildBillingApp({ id: 205, plan: 'free' });
  const res = await request(app, 'POST', '/billing/settings', {
    name: 'M', invoice_number_prefix: 'ACME\n-'
  });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(updateUserCalls.length, 0,
    'newline / control-char prefix rejected — no updateUser call');
}

async function testSettingsRejectsStartZero() {
  resetSettingsStores();
  users.set(206, { id: 206, email: 'me@x.com', name: 'M', plan: 'free', invoice_number_prefix: null, invoice_number_start: 1 });
  const app = buildBillingApp({ id: 206, plan: 'free' });
  const res = await request(app, 'POST', '/billing/settings', {
    name: 'M', invoice_number_start: '0'
  });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(updateUserCalls.length, 0,
    'start=0 rejected — no invoice #0 makes sense');
}

async function testSettingsRejectsStartNegative() {
  resetSettingsStores();
  users.set(207, { id: 207, email: 'me@x.com', name: 'M', plan: 'free', invoice_number_prefix: null, invoice_number_start: 1 });
  const app = buildBillingApp({ id: 207, plan: 'free' });
  const res = await request(app, 'POST', '/billing/settings', {
    name: 'M', invoice_number_start: '-5'
  });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(updateUserCalls.length, 0,
    'negative start rejected at the regex layer');
}

async function testSettingsRejectsStartOverMax() {
  resetSettingsStores();
  users.set(208, { id: 208, email: 'me@x.com', name: 'M', plan: 'free', invoice_number_prefix: null, invoice_number_start: 1 });
  const app = buildBillingApp({ id: 208, plan: 'free' });
  const res = await request(app, 'POST', '/billing/settings', {
    name: 'M', invoice_number_start: '1000000'
  });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(updateUserCalls.length, 0,
    'start > 999999 rejected — cap keeps the invoice-number column comfortably within VARCHAR(50) even with a 20-char prefix + year');
}

async function testSettingsRejectsStartNonNumeric() {
  resetSettingsStores();
  users.set(209, { id: 209, email: 'me@x.com', name: 'M', plan: 'free', invoice_number_prefix: null, invoice_number_start: 1 });
  const app = buildBillingApp({ id: 209, plan: 'free' });
  const res = await request(app, 'POST', '/billing/settings', {
    name: 'M', invoice_number_start: 'one hundred'
  });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(updateUserCalls.length, 0,
    'non-numeric start rejected — no parseInt accidentally writing NaN');
}

// ---------- Settings view rendering tests ------------------------------

const currentYear = new Date().getFullYear();

async function testSettingsViewRendersInputs() {
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
        default_tax_rate: 0,
        invoice_number_prefix: 'ACME-',
        invoice_number_start: 100
      },
      flash: null
    },
    { rmWhitespace: false }
  );
  assert.ok(html.includes('name="invoice_number_prefix"'),
    'settings view must render the invoice_number_prefix input');
  assert.ok(html.includes('data-testid="settings-invoice-number-prefix"'),
    'prefix input must carry a stable data-testid');
  const prefixInput = html.match(/<input[^>]*name="invoice_number_prefix"[^>]*>/);
  assert.ok(prefixInput, 'prefix input element must be present');
  assert.ok(/value="ACME-"/.test(prefixInput[0]),
    'prefix input value must reflect the saved ACME-, not empty');
  assert.ok(/maxlength="20"/.test(prefixInput[0]),
    'prefix input must carry maxlength=20 client-side guard');

  assert.ok(html.includes('name="invoice_number_start"'),
    'settings view must render the invoice_number_start input');
  assert.ok(html.includes('data-testid="settings-invoice-number-start"'),
    'start input must carry a stable data-testid');
  const startInput = html.match(/<input[^>]*name="invoice_number_start"[^>]*>/);
  assert.ok(startInput, 'start input element must be present');
  assert.ok(/value="100"/.test(startInput[0]),
    'start input value must reflect the saved 100');
  assert.ok(/min="1"/.test(startInput[0]) && /max="999999"/.test(startInput[0]),
    'start input must carry min=1 + max=999999 client-side guards');
  assert.ok(/step="1"/.test(startInput[0]),
    'start input must carry step=1 (integer-only)');
}

async function testSettingsViewFallsBackToDefaults() {
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
        default_tax_rate: 0,
        invoice_number_prefix: null,
        invoice_number_start: null
      },
      flash: null
    },
    { rmWhitespace: false }
  );
  const prefixInput = html.match(/<input[^>]*name="invoice_number_prefix"[^>]*>/);
  assert.ok(prefixInput, 'prefix input must render even on null');
  assert.ok(/value=""/.test(prefixInput[0]),
    'null prefix renders as empty input (placeholder shows the default)');
  assert.ok(new RegExp(`placeholder="INV-${currentYear}-"`).test(prefixInput[0]),
    'placeholder must surface the historical INV-YYYY- default so the user knows what "empty" resolves to');
  const startInput = html.match(/<input[^>]*name="invoice_number_start"[^>]*>/);
  assert.ok(startInput, 'start input must render even on null');
  assert.ok(/value="1"/.test(startInput[0]),
    'null start value falls back to 1 — the schema default — so the input is never empty');
}

async function testSettingsViewCorruptValueDefencesInDepth() {
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
        default_tax_rate: 0,
        // Hostile / corrupt values that could only exist via a direct DB
        // write. View must NEVER project them into rendered attributes.
        invoice_number_prefix: '  ',
        invoice_number_start: 9999999
      },
      flash: null
    },
    { rmWhitespace: false }
  );
  const prefixInput = html.match(/<input[^>]*name="invoice_number_prefix"[^>]*>/);
  assert.ok(/value=""/.test(prefixInput[0]),
    'whitespace-only corrupt prefix collapses to empty in the rendered value');
  const startInput = html.match(/<input[^>]*name="invoice_number_start"[^>]*>/);
  assert.ok(/value="1"/.test(startInput[0]),
    'out-of-range corrupt start falls back to 1 in the rendered value');
}

// ---------- Contract: db.getNextInvoiceNumber wires to the lib ---------

async function testDbGetNextInvoiceNumberDelegates() {
  // Read the db.js source and confirm the getNextInvoiceNumber helper
  // delegates to lib/invoice-number.formatInvoiceNumber. A future
  // refactor that inlined a hardcoded "INV-" prefix or drop the lib
  // import would defeat every route + view surface above without
  // failing any of the tests that stub getNextInvoiceNumber directly.
  const src = fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8');
  assert.ok(
    /require\(['"]\.\/lib\/invoice-number['"]\)/.test(src),
    'db.js must require lib/invoice-number (single source of truth for the number shape)'
  );
  assert.ok(
    /formatInvoiceNumber\s*\(\s*{[\s\S]*?existingCount:[\s\S]*?prefix:[\s\S]*?startAt:/.test(src),
    'db.getNextInvoiceNumber must call formatInvoiceNumber({ existingCount, prefix, startAt })'
  );
  assert.ok(
    /invoice_number_prefix\s+AS\s+prefix/i.test(src),
    'db.getNextInvoiceNumber SQL must select invoice_number_prefix AS prefix'
  );
  assert.ok(
    /invoice_number_start\s+AS\s+start_at/i.test(src),
    'db.getNextInvoiceNumber SQL must select invoice_number_start AS start_at'
  );
}

async function run() {
  const tests = [
    ['lib — constants exposed', testConstantsExposed],
    ['lib — defaultPrefix(now) resolves the passed year', testDefaultPrefixResolvesYear],
    ['lib — sanitizePrefix accepts ACME-, 2026-, trimmed, punctuation', testSanitizePrefixAcceptsCommonShapes],
    ['lib — sanitizePrefix rejects null/empty/over-length/control chars', testSanitizePrefixRejectsInvalid],
    ['lib — sanitizeStart accepts 1..999999 (string + number, trimmed)', testSanitizeStartAcceptsRange],
    ['lib — sanitizeStart rejects 0/negative/over-max/fractional/non-numeric', testSanitizeStartRejectsInvalid],
    ['lib — formatInvoiceNumber(null, null) ⇒ historical INV-YYYY-0001', testFormatDefaultsWhenPrefixIsNull],
    ['lib — formatInvoiceNumber(ACME-, null) ⇒ ACME-0001', testFormatUsesCustomPrefix],
    ['lib — formatInvoiceNumber(null, 100) ⇒ INV-YYYY-0100', testFormatUsesCustomStart],
    ['lib — formatInvoiceNumber composes prefix + start + count', testFormatCombinesPrefixAndStart],
    ['lib — formatInvoiceNumber falls back on corrupt prefix (whitespace-only)', testFormatFallsBackOnCorruptPrefix],
    ['lib — formatInvoiceNumber falls back on corrupt start (0, > max)', testFormatFallsBackOnCorruptStart],
    ['lib — formatInvoiceNumber coerces negative existingCount to 0', testFormatCoercesNegativeExistingCount],
    ['lib — formatInvoiceNumber pads short seq, preserves long seq', testFormatPadsLargeSequence],
    ['db/schema.sql — idempotent ALTERs for both columns', testSchemaCarriesMigrations],
    ['POST /billing/settings — custom prefix "ACME-" persists', testSettingsSavesCustomPrefix],
    ['POST /billing/settings — custom start=100 persists as integer', testSettingsSavesCustomStart],
    ['POST /billing/settings — empty prefix persists as NULL', testSettingsEmptyPrefixPersistsAsNull],
    ['POST /billing/settings — empty start resets to 1 (NOT NULL default)', testSettingsEmptyStartResetsToOne],
    ['POST /billing/settings — > 20-char prefix rejected (no updateUser)', testSettingsRejectsOversizePrefix],
    ['POST /billing/settings — prefix with control chars rejected', testSettingsRejectsPrefixControlChars],
    ['POST /billing/settings — start=0 rejected (no updateUser)', testSettingsRejectsStartZero],
    ['POST /billing/settings — negative start rejected', testSettingsRejectsStartNegative],
    ['POST /billing/settings — start > 999999 rejected', testSettingsRejectsStartOverMax],
    ['POST /billing/settings — non-numeric start rejected', testSettingsRejectsStartNonNumeric],
    ['views/settings.ejs — renders both inputs with saved values + testids + guards', testSettingsViewRendersInputs],
    ['views/settings.ejs — nulls fall back to empty prefix + start=1 + placeholder shows INV-YYYY-', testSettingsViewFallsBackToDefaults],
    ['views/settings.ejs — corrupt values fall back safely in the rendered inputs', testSettingsViewCorruptValueDefencesInDepth],
    ['db.getNextInvoiceNumber contract: delegates to lib/invoice-number', testDbGetNextInvoiceNumberDelegates]
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
