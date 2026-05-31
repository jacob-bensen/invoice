'use strict';

/*
 * Per-user default_currency end-to-end (every Milestone — the public
 * /i/<token> share page is the surface every client sees, so the wrong
 * currency symbol on the totals is an activation tax on every non-US
 * freelancer's first-sent invoice). Eight ISO-4217 codes
 * (USD/EUR/GBP/CAD/AUD/NZD/CHF/JPY) supported, with the canonical
 * whitelist + symbol map in `lib/currency.js` (which re-exports
 * `formatMoney` from `lib/html.js`).
 *
 * Covers:
 *  1. lib/currency: SUPPORTED_CURRENCIES shape + length + frozen + each
 *     code present in html.js CURRENCY_SYMBOLS.
 *  2. lib/currency: normalizeCurrencyCode accept + reject matrix
 *     (case-insensitive, whitespace, unknown codes, non-strings).
 *  3. lib/currency: resolveInvoiceCurrency precedence
 *     (invoice.currency > invoice.owner_default_currency > owner.default_currency > 'USD').
 *  4. lib/payment-handles: paypalPayUrl honours the currency suffix
 *     (USD/EUR/GBP), defaults to USD on invalid/missing.
 *  5. lib/payment-handles: buildPayLinks threads currency into paypal
 *     only — venmo + cashapp + zelle unaffected by currency.
 *  6. db/schema.sql: ALTER TABLE users default_currency CHAR(3) NOT NULL
 *     DEFAULT 'USD' is present and idempotent.
 *  7. db.getInvoiceByPublicToken SQL projects u.default_currency AS
 *     owner_default_currency (one-call public-page contract).
 *  8. routes/billing POST /settings persists a valid currency.
 *  9. routes/billing POST /settings rejects an unknown currency with a
 *     flash and zero updateUser writes.
 * 10. routes/billing POST /settings: missing key preserves stored value
 *     (no key in updateFields).
 * 11. routes/billing POST /settings: empty string defaults to 'USD' (so
 *     the NOT NULL column never gets NULL).
 * 12. views/settings.ejs: renders the <select> with the user's currency
 *     pre-selected, all 8 codes as options, stable testid.
 * 13. views/invoice-public.ejs: line items + subtotal + total render with
 *     the resolved currency symbol (EUR €, GBP £, JPY ¥) instead of
 *     hardcoded `$`.
 * 14. views/invoice-public.ejs: Stripe Pay CTA and Zelle hint label both
 *     pick up the resolved currency.
 * 15. views/invoice-public.ejs: legacy callers (no invoiceCurrency /
 *     formatMoney render locals) still produce the historical `$X.XX`
 *     shape — backwards-compat regression guard.
 *
 * Run: NODE_ENV=test node tests/multi-currency.test.js
 */

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const express = require('express');
const session = require('express-session');
const http = require('http');

const VIEWS = path.join(__dirname, '..', 'views');

function clearReq(mod) {
  try { delete require.cache[require.resolve(mod)]; } catch (_) { /* noop */ }
}

const currency = require('../lib/currency');
const html = require('../lib/html');

// ---------- 1. SUPPORTED_CURRENCIES shape -------------------------------

function testSupportedCurrenciesShape() {
  assert.ok(Array.isArray(currency.SUPPORTED_CURRENCIES),
    'SUPPORTED_CURRENCIES must be an array');
  assert.strictEqual(currency.SUPPORTED_CURRENCIES.length, 8,
    'eight supported currencies — USD/EUR/GBP/CAD/AUD/NZD/CHF/JPY');
  assert.ok(Object.isFrozen(currency.SUPPORTED_CURRENCIES),
    'outer array must be frozen to prevent runtime mutation');
  const codes = currency.SUPPORTED_CURRENCIES.map(c => c.code);
  assert.deepStrictEqual(
    new Set(codes).size, codes.length,
    'no duplicate codes'
  );
  currency.SUPPORTED_CURRENCIES.forEach((entry) => {
    assert.ok(Object.isFrozen(entry), `entry ${entry.code} must be frozen`);
    assert.ok(/^[A-Z]{3}$/.test(entry.code),
      `${entry.code} must be a 3-letter uppercase ISO-4217 code`);
    assert.ok(typeof entry.symbol === 'string' && entry.symbol.length > 0,
      `${entry.code} must have a non-empty symbol`);
    assert.ok(typeof entry.label === 'string' && entry.label.includes(entry.code),
      `${entry.code} label must include the code`);
    // Every supported code must have a symbol in html.js — otherwise
    // formatMoney would emit a bare number with no currency hint.
    assert.ok(
      Object.prototype.hasOwnProperty.call(html.CURRENCY_SYMBOLS, entry.code.toLowerCase()),
      `${entry.code} must be in html.js CURRENCY_SYMBOLS for formatMoney to emit a symbol`
    );
  });
}

// ---------- 2. normalizeCurrencyCode accept + reject -------------------

function testNormalizeCurrencyCodeAccepts() {
  assert.strictEqual(currency.normalizeCurrencyCode('USD'), 'USD');
  assert.strictEqual(currency.normalizeCurrencyCode('usd'), 'USD',
    'case-insensitive — lowercase normalises to upper');
  assert.strictEqual(currency.normalizeCurrencyCode('  EUR  '), 'EUR',
    'whitespace trimmed');
  assert.strictEqual(currency.normalizeCurrencyCode('GBP'), 'GBP');
  assert.strictEqual(currency.normalizeCurrencyCode('JPY'), 'JPY');
  assert.strictEqual(currency.normalizeCurrencyCode('CHF'), 'CHF');
}

function testNormalizeCurrencyCodeRejects() {
  assert.strictEqual(currency.normalizeCurrencyCode(null), null);
  assert.strictEqual(currency.normalizeCurrencyCode(undefined), null);
  assert.strictEqual(currency.normalizeCurrencyCode(''), null);
  assert.strictEqual(currency.normalizeCurrencyCode('   '), null);
  assert.strictEqual(currency.normalizeCurrencyCode('XYZ'), null,
    'unknown code rejected — no silent fallback');
  assert.strictEqual(currency.normalizeCurrencyCode('US'), null,
    'two letters not a valid ISO-4217 code');
  assert.strictEqual(currency.normalizeCurrencyCode('USDD'), null,
    'four letters not a valid ISO-4217 code');
  assert.strictEqual(currency.normalizeCurrencyCode(123), null,
    'non-string input rejected');
  assert.strictEqual(currency.normalizeCurrencyCode({ code: 'USD' }), null,
    'object input rejected');
  // BTC isn't ISO-4217 fiat — the whitelist excludes crypto by design
  // (PayPal.me doesn't accept crypto suffixes, totals can't reasonably
  // round to 2 decimals on satoshis, etc.).
  assert.strictEqual(currency.normalizeCurrencyCode('BTC'), null);
}

// ---------- 3. resolveInvoiceCurrency precedence -----------------------

function testResolveInvoiceCurrencyPrecedence() {
  // 3a. Per-invoice override wins over owner default.
  assert.strictEqual(
    currency.resolveInvoiceCurrency(
      { currency: 'EUR', owner_default_currency: 'GBP' },
      { default_currency: 'JPY' }
    ),
    'EUR',
    'invoice.currency must win over both owner sources'
  );
  // 3b. owner_default_currency on invoice row wins when no invoice.currency.
  assert.strictEqual(
    currency.resolveInvoiceCurrency(
      { owner_default_currency: 'GBP' },
      { default_currency: 'JPY' }
    ),
    'GBP',
    'invoice.owner_default_currency must win over owner arg when invoice.currency is missing'
  );
  // 3c. Owner arg used when invoice has neither.
  assert.strictEqual(
    currency.resolveInvoiceCurrency({}, { default_currency: 'CHF' }),
    'CHF',
    'owner.default_currency used when invoice carries neither override nor owner col'
  );
  // 3d. Falls through to 'USD' when nothing is set anywhere.
  assert.strictEqual(
    currency.resolveInvoiceCurrency({}, {}),
    'USD',
    'final fallback is USD — never NULL, never undefined'
  );
  assert.strictEqual(
    currency.resolveInvoiceCurrency(null, null),
    'USD',
    'null arguments still resolve to USD — never throws'
  );
  // 3e. Invalid invoice.currency falls through to next source (doesn't 'win').
  assert.strictEqual(
    currency.resolveInvoiceCurrency(
      { currency: 'XYZ' },
      { default_currency: 'EUR' }
    ),
    'EUR',
    'invalid invoice.currency falls through — no silent garbage'
  );
}

// ---------- 4. paypalPayUrl currency suffix ----------------------------

const { paypalPayUrl, buildPayLinks } = require('../lib/payment-handles');

function testPaypalPayUrlCurrencySuffix() {
  // 4a. USD default (no currency arg) — preserves legacy contract.
  assert.strictEqual(
    paypalPayUrl({ handle: 'joe', amount: 100 }),
    'https://paypal.me/joe/100.00USD',
    'no currency arg defaults to USD — backwards-compat'
  );
  // 4b. EUR suffix.
  assert.strictEqual(
    paypalPayUrl({ handle: 'joe', amount: 100, currency: 'EUR' }),
    'https://paypal.me/joe/100.00EUR',
    'EUR currency surfaces in the PayPal.me suffix'
  );
  // 4c. GBP suffix.
  assert.strictEqual(
    paypalPayUrl({ handle: 'joe', amount: 100, currency: 'GBP' }),
    'https://paypal.me/joe/100.00GBP'
  );
  // 4d. Lowercase normalises to uppercase in URL.
  assert.strictEqual(
    paypalPayUrl({ handle: 'joe', amount: 100, currency: 'eur' }),
    'https://paypal.me/joe/100.00EUR',
    'lowercase currency normalised to uppercase in URL'
  );
  // 4e. Invalid currency falls back to USD (never emits garbage).
  assert.strictEqual(
    paypalPayUrl({ handle: 'joe', amount: 100, currency: '!!!' }),
    'https://paypal.me/joe/100.00USD',
    'non-3-letter currency falls back to USD'
  );
  // 4f. Missing amount → no suffix even with currency set.
  assert.strictEqual(
    paypalPayUrl({ handle: 'joe', amount: 0, currency: 'EUR' }),
    'https://paypal.me/joe',
    'zero amount → no suffix (currency irrelevant when amount is missing)'
  );
}

function testBuildPayLinksThreadsCurrencyOnlyToPaypal() {
  const result = buildPayLinks({
    venmo: 'jdoe',
    cashapp: 'jdoe',
    paypal: 'jdoe',
    zelle: 'joe@example.com',
    amount: 250,
    invoiceNumber: 'INV-1',
    currency: 'EUR'
  });
  // Venmo + Cash App are USD-only on the wire — currency arg is ignored.
  assert.ok(result.venmo.startsWith('https://venmo.com/jdoe?'),
    'venmo URL unaffected by currency arg');
  assert.ok(!/EUR|GBP|currency/i.test(result.venmo),
    'venmo URL must not embed currency anywhere');
  assert.strictEqual(result.cashapp, 'https://cash.app/$jdoe/250.00',
    'cashapp URL unaffected by currency arg');
  assert.strictEqual(result.paypal, 'https://paypal.me/jdoe/250.00EUR',
    'paypal URL embeds the EUR currency code');
  // Zelle surface is a descriptor (not a URL) — currency irrelevant.
  assert.ok(result.zelle && result.zelle.handle === 'joe@example.com',
    'zelle surface preserved');
}

// ---------- 6. schema.sql migration ------------------------------------

function testSchemaIncludesDefaultCurrencyMigration() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  assert.ok(
    /ALTER\s+TABLE\s+users\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+default_currency\s+CHAR\(3\)\s+NOT\s+NULL\s+DEFAULT\s+'USD'/i.test(sql),
    'schema.sql must carry an idempotent ALTER for users.default_currency CHAR(3) NOT NULL DEFAULT \'USD\''
  );
}

// ---------- 7. db.getInvoiceByPublicToken SQL projection ---------------

function stubPg(handler) {
  const pgPath = require.resolve('pg');
  const originalPg = require.cache[pgPath];
  require.cache[pgPath] = {
    id: pgPath, filename: pgPath, loaded: true,
    exports: { Pool: function () { return { query: handler }; } }
  };
  delete require.cache[require.resolve('../db')];
  return () => {
    if (originalPg) require.cache[pgPath] = originalPg;
    else delete require.cache[pgPath];
    delete require.cache[require.resolve('../db')];
  };
}

async function testPublicTokenSqlProjectsOwnerDefaultCurrency() {
  const captured = [];
  const restore = stubPg(async (text, _params) => {
    captured.push({ text });
    return { rows: [{ id: 1, owner_default_currency: 'EUR' }] };
  });
  try {
    const { db } = require('../db');
    const row = await db.getInvoiceByPublicToken('cafef00ddeadbeef');
    assert.strictEqual(captured.length, 1);
    assert.ok(
      /u\.default_currency\s+AS\s+owner_default_currency/i.test(captured[0].text),
      'public-page SELECT must project users.default_currency AS owner_default_currency'
    );
    assert.strictEqual(row.owner_default_currency, 'EUR',
      'projected alias surfaces on the returned row');
  } finally { restore(); }
}

// ---------- 8-11. POST /billing/settings round-trip --------------------

const settingsUsers = new Map();
const settingsUpdateCalls = [];

function resetSettingsStore() {
  settingsUsers.clear();
  settingsUpdateCalls.length = 0;
}

function installBillingStub() {
  const stub = {
    pool: { query: async () => ({ rows: [] }) },
    db: {
      async getUserByEmail() { return null; },
      async getUserById(id) { return settingsUsers.get(id) || null; },
      async updateUser(id, fields) {
        settingsUpdateCalls.push({ id, fields });
        const u = settingsUsers.get(id);
        if (u) Object.assign(u, fields);
        return u || null;
      }
    }
  };
  require.cache[require.resolve('../db')] = {
    id: require.resolve('../db'), filename: require.resolve('../db'),
    loaded: true, exports: stub
  };
  require.cache[require.resolve('stripe')] = {
    id: require.resolve('stripe'), filename: require.resolve('stripe'),
    loaded: true,
    exports: () => ({
      checkout: { sessions: { create: async () => ({ url: 'x' }) } },
      billingPortal: { sessions: { create: async () => ({ url: 'x' }) } },
      webhooks: { constructEvent: () => ({}) },
      customers: { update: async () => ({}) },
      paymentLinks: { create: async () => ({ id: 'p', url: 'https://x' }) }
    })
  };
  clearReq('../routes/billing');
  return require('../routes/billing');
}

function buildBillingApp(sessionUser, billingRoutes) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', VIEWS);
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(session({ secret: 's', resave: false, saveUninitialized: false }));
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

async function testSettingsPersistsValidCurrency() {
  resetSettingsStore();
  settingsUsers.set(50, {
    id: 50, email: 'me@x.com', name: 'M', plan: 'free',
    default_currency: 'USD'
  });
  const routes = installBillingStub();
  const app = buildBillingApp({ id: 50, plan: 'free' }, routes);
  const res = await request(app, 'POST', '/billing/settings', {
    name: 'M',
    default_currency: 'EUR'
  });
  assert.strictEqual(res.status, 302, 'settings save redirects');
  assert.ok(settingsUpdateCalls.length >= 1, 'updateUser called');
  const lastCall = settingsUpdateCalls[settingsUpdateCalls.length - 1];
  assert.strictEqual(lastCall.fields.default_currency, 'EUR',
    'valid currency persists in the updateUser payload');
}

async function testSettingsRejectsUnknownCurrency() {
  resetSettingsStore();
  settingsUsers.set(51, {
    id: 51, email: 'me@x.com', name: 'M', plan: 'free',
    default_currency: 'USD'
  });
  const routes = installBillingStub();
  const app = buildBillingApp({ id: 51, plan: 'free' }, routes);
  const res = await request(app, 'POST', '/billing/settings', {
    name: 'M',
    default_currency: 'XYZ'
  });
  assert.strictEqual(res.status, 302, 'still redirects');
  assert.strictEqual(settingsUpdateCalls.length, 0,
    'updateUser MUST NOT be called when currency is invalid — user keeps stored value');
}

async function testSettingsMissingKeyPreservesStoredCurrency() {
  resetSettingsStore();
  settingsUsers.set(52, {
    id: 52, email: 'me@x.com', name: 'M', plan: 'free',
    default_currency: 'GBP'
  });
  const routes = installBillingStub();
  const app = buildBillingApp({ id: 52, plan: 'free' }, routes);
  const res = await request(app, 'POST', '/billing/settings', {
    name: 'M'
    // No default_currency in the submission — legacy form posts.
  });
  assert.strictEqual(res.status, 302);
  assert.ok(settingsUpdateCalls.length >= 1);
  const lastCall = settingsUpdateCalls[settingsUpdateCalls.length - 1];
  assert.ok(!('default_currency' in lastCall.fields),
    'updateUser payload MUST NOT include default_currency when the form omits it — legacy callers preserve stored value');
}

async function testSettingsEmptyCurrencyDefaultsToUsd() {
  resetSettingsStore();
  settingsUsers.set(53, {
    id: 53, email: 'me@x.com', name: 'M', plan: 'free',
    default_currency: 'EUR'
  });
  const routes = installBillingStub();
  const app = buildBillingApp({ id: 53, plan: 'free' }, routes);
  const res = await request(app, 'POST', '/billing/settings', {
    name: 'M',
    default_currency: ''
  });
  assert.strictEqual(res.status, 302);
  assert.ok(settingsUpdateCalls.length >= 1);
  const lastCall = settingsUpdateCalls[settingsUpdateCalls.length - 1];
  assert.strictEqual(lastCall.fields.default_currency, 'USD',
    'empty submission defaults to USD — column is NOT NULL, never write null');
}

// ---------- 12. views/settings.ejs renders the <select> ----------------

async function testSettingsViewRendersCurrencySelect() {
  const html = await ejs.renderFile(
    path.join(VIEWS, 'settings.ejs'),
    {
      title: 'Settings',
      user: {
        email: 'me@x.com', name: 'M', plan: 'free',
        business_name: null, business_address: null,
        business_email: null, business_phone: null,
        webhook_url: null, invoice_count: 0,
        reply_to_email: null, payment_instructions: null,
        bcc_invoice_emails: false, default_invoice_notes: null,
        default_currency: 'EUR'
      },
      flash: null,
      supportedCurrencies: currency.SUPPORTED_CURRENCIES
    },
    { rmWhitespace: false }
  );
  assert.ok(html.includes('name="default_currency"'),
    'settings view must render the default_currency <select>');
  assert.ok(html.includes('data-testid="settings-default-currency"'),
    'select must carry a stable data-testid for downstream tests');
  // All 8 currency codes must be present as options.
  ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'CHF', 'JPY'].forEach((code) => {
    assert.ok(
      html.includes(`value="${code}"`),
      `select must include <option value="${code}"> for every supported currency`
    );
  });
  // The user's stored currency (EUR) must be the selected option.
  assert.ok(
    /<option\s+value="EUR"\s+selected\b/i.test(html),
    'user.default_currency=EUR must be the selected option'
  );
  // USD (the non-stored option) must NOT be selected.
  assert.ok(
    !/<option\s+value="USD"\s+selected\b/i.test(html),
    'USD must NOT be selected when user has EUR stored'
  );
}

// ---------- 13-15. views/invoice-public.ejs currency-aware render -----

function renderPublic(opts) {
  const invoice = opts.invoice;
  const passLocals = opts.passLocals !== false;
  return ejs.renderFile(
    path.join(VIEWS, 'invoice-public.ejs'),
    Object.assign({
      title: 't',
      invoice,
      tapToPayLinks: opts.tapToPayLinks || null
    }, passLocals ? {
      invoiceCurrency: opts.invoiceCurrency || 'USD',
      formatMoney: currency.formatMoney
    } : {}),
    { views: [VIEWS] }
  );
}

async function testPublicViewRendersEurSymbolOnTotals() {
  const html = await renderPublic({
    invoice: {
      id: 1, invoice_number: 'INV-EUR-1', public_token: 'cafef00ddeadbeef',
      client_name: 'C', status: 'sent',
      items: [{ description: 'Logo work', quantity: 4, unit_price: 75 }],
      subtotal: 300, tax_rate: 0, tax_amount: 0, total: 300,
      issued_date: new Date('2026-05-01'),
      owner_business_name: 'Studio Pierre', owner_email: 'p@x.com',
      owner_default_currency: 'EUR'
    },
    invoiceCurrency: 'EUR'
  });
  // Total renders with the EUR symbol, not the dollar sign.
  assert.ok(/data-testid="public-invoice-total"[^>]*>€300\.00</.test(html),
    'public-invoice-total must render with the € symbol for EUR currency');
  // Line item amount also uses EUR.
  assert.ok(html.includes('€75.00'), 'line-item unit price must use € for EUR');
  assert.ok(html.includes('€300.00'), 'line-item amount + subtotal must use € for EUR');
  // Critically — no rogue $ on a money line for an EUR invoice.
  // (The $ may appear in copy elsewhere, so we anchor on the money cells.)
  assert.ok(!/\$300\.00/.test(html), 'no $300.00 anywhere — invoice is EUR-priced');
}

async function testPublicViewStripeCtaAndZellePickUpCurrency() {
  const html = await renderPublic({
    invoice: {
      id: 2, invoice_number: 'INV-GBP-1', public_token: 'cafef00ddeadbeef',
      client_name: 'C', status: 'sent',
      items: [{ description: 'Project', quantity: 1, unit_price: 500 }],
      subtotal: 500, tax_rate: 0, tax_amount: 0, total: 500,
      issued_date: new Date('2026-05-01'),
      owner_business_name: 'UK Studio', owner_email: 'p@x.com',
      owner_default_currency: 'GBP',
      payment_link_url: 'https://buy.stripe.com/test',
      owner_plan: 'pro',
      owner_zelle_handle: null
    },
    tapToPayLinks: {
      venmo: null, cashapp: null, paypal: null,
      zelle: { handle: 'me@x.com', kind: 'email', display: 'me@x.com' }
    },
    invoiceCurrency: 'GBP'
  });
  // Stripe Pay CTA shows GBP, not USD.
  assert.ok(/Pay £500\.00 to/.test(html),
    'Stripe Pay CTA text must show £500.00');
  assert.ok(/Pay £500\.00 →/.test(html),
    'Stripe Pay CTA button must show £500.00 →');
  // Zelle hint copy uses GBP.
  assert.ok(/send £500\.00 to this email/.test(html),
    'Zelle hint must show £500.00 in the freelancer-set currency');
}

async function testPublicViewLegacyCallerStillRendersDollarShape() {
  // Backwards-compat: a render that doesn't thread `invoiceCurrency` or
  // `formatMoney` must still produce `$300.00` (the historical shape).
  const html = await renderPublic({
    invoice: {
      id: 3, invoice_number: 'INV-LEG-1', public_token: 'cafef00ddeadbeef',
      client_name: 'C', status: 'sent',
      items: [{ description: 'Logo work', quantity: 4, unit_price: 75 }],
      subtotal: 300, tax_rate: 0, tax_amount: 0, total: 300,
      issued_date: new Date('2026-05-01'),
      owner_business_name: 'Studio', owner_email: 'p@x.com'
      // no owner_default_currency on the invoice row
    },
    passLocals: false
  });
  assert.ok(/data-testid="public-invoice-total"[^>]*>\$300\.00</.test(html),
    'legacy render path (no formatMoney local) must still emit $300.00 — backwards-compat regression guard');
  assert.ok(!/€|£|¥/.test(html.replace(/'/g, '')),
    'no foreign currency symbols leak when neither invoice nor locals carry a currency');
}

async function testPublicViewLineItemsUseJpyForJapaneseYen() {
  const html = await renderPublic({
    invoice: {
      id: 4, invoice_number: 'INV-JPY-1', public_token: 'cafef00ddeadbeef',
      client_name: 'C', status: 'sent',
      items: [{ description: 'Translation', quantity: 1, unit_price: 50000 }],
      subtotal: 50000, tax_rate: 0, tax_amount: 0, total: 50000,
      issued_date: new Date('2026-05-01'),
      owner_business_name: 'Tokyo Studio', owner_email: 'p@x.com',
      owner_default_currency: 'JPY'
    },
    invoiceCurrency: 'JPY'
  });
  assert.ok(/¥50000\.00/.test(html),
    'JPY currency surfaces with the ¥ symbol on amounts');
  assert.ok(!/\$50000\.00/.test(html),
    'no $ on a JPY-priced invoice');
}

// ---------- Runner -----------------------------------------------------

const TESTS = [
  ['lib/currency: SUPPORTED_CURRENCIES shape', testSupportedCurrenciesShape],
  ['lib/currency: normalizeCurrencyCode accepts known codes', testNormalizeCurrencyCodeAccepts],
  ['lib/currency: normalizeCurrencyCode rejects unknown / non-string', testNormalizeCurrencyCodeRejects],
  ['lib/currency: resolveInvoiceCurrency precedence', testResolveInvoiceCurrencyPrecedence],
  ['lib/payment-handles: paypalPayUrl honours currency suffix', testPaypalPayUrlCurrencySuffix],
  ['lib/payment-handles: buildPayLinks threads currency only to paypal', testBuildPayLinksThreadsCurrencyOnlyToPaypal],
  ['schema.sql: ALTER for users.default_currency CHAR(3) NOT NULL DEFAULT USD', testSchemaIncludesDefaultCurrencyMigration],
  ['db.getInvoiceByPublicToken projects u.default_currency AS owner_default_currency', testPublicTokenSqlProjectsOwnerDefaultCurrency],
  ['POST /billing/settings persists a valid currency', testSettingsPersistsValidCurrency],
  ['POST /billing/settings rejects unknown currency (no updateUser)', testSettingsRejectsUnknownCurrency],
  ['POST /billing/settings missing key preserves stored currency', testSettingsMissingKeyPreservesStoredCurrency],
  ['POST /billing/settings empty currency defaults to USD', testSettingsEmptyCurrencyDefaultsToUsd],
  ['views/settings.ejs renders the currency <select> with user pre-selected', testSettingsViewRendersCurrencySelect],
  ['views/invoice-public.ejs renders EUR symbol on line items + total', testPublicViewRendersEurSymbolOnTotals],
  ['views/invoice-public.ejs Stripe Pay + Zelle hint pick up resolved currency', testPublicViewStripeCtaAndZellePickUpCurrency],
  ['views/invoice-public.ejs legacy caller still renders $X.XX shape', testPublicViewLegacyCallerStillRendersDollarShape],
  ['views/invoice-public.ejs JPY renders with ¥ symbol', testPublicViewLineItemsUseJpyForJapaneseYen]
];

(async () => {
  let failed = 0;
  for (const [name, fn] of TESTS) {
    try {
      await fn();
      console.log('  ✓', name);
    } catch (err) {
      failed++;
      console.error('  ✗', name);
      console.error(err);
    }
  }
  if (failed) {
    console.error(`\n${failed} test(s) failed.`);
    process.exit(1);
  }
  console.log(`\n${TESTS.length} test(s) passed.`);
})();
