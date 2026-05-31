'use strict';

/*
 * Owner-facing currency display end-to-end. The per-user default_currency
 * already drove the client-facing public share page and outbound emails
 * (multi-currency.test.js + bcc-invoice-emails.test.js). What it did NOT
 * drive — until now — was the freelancer's own surfaces: their per-invoice
 * /invoices/:id view, the printed PDF at /invoices/:id/print, the new
 * /invoices/new and /invoices/quick form totals + recent-items option
 * labels. So a freelancer who picked EUR on /billing/settings was handing
 * clients a € share link while staring at $ everywhere on their own
 * dashboard and printed copy.
 *
 * Covers:
 *  1. lib/currency: getCurrencySymbol resolves the known codes + falls back
 *     to '$' on unknown / non-string.
 *  2. invoice-view.ejs: line item unit price + line amount + subtotal +
 *     tax + total all render through formatMoney(amount, currency).
 *  3. invoice-view.ejs: USD-defaulted user keeps the legacy '$' shape
 *     (backwards-compat regression guard).
 *  4. invoice-print.ejs: same five money cells render with the resolved
 *     currency symbol; EUR + GBP + JPY exercised.
 *  5. invoice-form.ejs: recent-items option label + service-presets
 *     option label use the resolved symbol (the freelancer reading "qty
 *     4 × €75.00" picks the EUR-priced row, not a $-prefixed one that
 *     contradicts their currency choice).
 *  6. invoice-form.ejs: Alpine factory's currencySymbol field defaults
 *     from the new constructor arg; x-text expressions use it so the
 *     live subtotal / tax / total tick over in the right symbol as the
 *     freelancer types.
 *  7. invoice-quick.ejs: amount-input prefix glyph + the "Amount (XXX)"
 *     label code + recent-items option label all reflect the user's
 *     default currency.
 */

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const VIEWS = path.join(__dirname, '..', 'views');
const currency = require('../lib/currency');

// ---------- 1. getCurrencySymbol ---------------------------------------

function testGetCurrencySymbolKnownCodes() {
  assert.strictEqual(currency.getCurrencySymbol('USD'), '$');
  assert.strictEqual(currency.getCurrencySymbol('EUR'), '€');
  assert.strictEqual(currency.getCurrencySymbol('GBP'), '£');
  assert.strictEqual(currency.getCurrencySymbol('JPY'), '¥');
  assert.strictEqual(currency.getCurrencySymbol('CAD'), 'CA$');
  assert.strictEqual(currency.getCurrencySymbol('AUD'), 'A$');
  assert.strictEqual(currency.getCurrencySymbol('NZD'), 'NZ$');
  assert.strictEqual(currency.getCurrencySymbol('CHF'), 'CHF ');
  // Case-insensitive — lib/currency normalises, but getCurrencySymbol
  // should also tolerate a lowercase pass-through (defence-in-depth so a
  // caller threading a stored-lowercased code never blanks the symbol).
  assert.strictEqual(currency.getCurrencySymbol('eur'), '€',
    'case-insensitive');
  assert.strictEqual(currency.getCurrencySymbol('  GBP  '), '£',
    'whitespace tolerated');
}

function testGetCurrencySymbolFallsBackOnUnknown() {
  assert.strictEqual(currency.getCurrencySymbol('XYZ'), '$',
    'unknown code falls back to $ — never strands a money render with bare digits');
  assert.strictEqual(currency.getCurrencySymbol(''), '$', 'empty → $');
  assert.strictEqual(currency.getCurrencySymbol(null), '$', 'null → $');
  assert.strictEqual(currency.getCurrencySymbol(undefined), '$', 'undefined → $');
  assert.strictEqual(currency.getCurrencySymbol(123), '$', 'non-string → $');
  assert.strictEqual(currency.getCurrencySymbol({}), '$', 'object → $');
}

// ---------- 2-3. views/invoice-view.ejs --------------------------------

function renderInvoiceView(opts) {
  const locals = Object.assign({
    title: 't',
    invoice: opts.invoice,
    user: opts.user || { plan: 'free' },
    flash: null,
    paymentMethods: ['card'],
    prefetchedShare: null,
    noindex: true
  }, opts.passLocals === false ? {} : {
    currency: opts.currency || 'USD',
    currencySymbol: currency.getCurrencySymbol(opts.currency || 'USD'),
    formatMoney: currency.formatMoney
  });
  return ejs.renderFile(path.join(VIEWS, 'invoice-view.ejs'), locals,
    { views: [VIEWS] });
}

const sampleInvoice = {
  id: 1, invoice_number: 'INV-100', client_name: 'C', client_email: 'c@x.com',
  client_address: null, status: 'sent', is_seed: false,
  items: [
    { description: 'Logo work', quantity: 4, unit_price: 75 }
  ],
  subtotal: 300, tax_rate: 10, tax_amount: 30, total: 330,
  notes: null, issued_date: new Date('2026-05-01'),
  due_date: new Date('2026-05-31'),
  payment_link_url: null, public_token: 'cafef00ddeadbeef'
};

async function testInvoiceViewRendersEurOnAllMoneyCells() {
  const html = await renderInvoiceView({
    invoice: sampleInvoice,
    user: { plan: 'free', business_name: 'Studio Pierre', default_currency: 'EUR' },
    currency: 'EUR'
  });
  // Subtotal, tax, total — three named cells with stable testids.
  assert.ok(/data-testid="invoice-view-subtotal"[^>]*>€300\.00</.test(html),
    'subtotal must render with the € symbol when user.default_currency=EUR');
  assert.ok(/data-testid="invoice-view-tax"[^>]*>€30\.00</.test(html),
    'tax amount must render with € for EUR');
  assert.ok(/data-testid="invoice-view-total"[^>]*>€330\.00</.test(html),
    'total must render with € for EUR');
  // Line item unit price and line amount.
  assert.ok(html.includes('€75.00'),
    'line-item unit price (qty 4 × €75.00) must use € for EUR');
  assert.ok(html.includes('€300.00'),
    'line-item amount (4 × 75 = €300.00) must use € for EUR');
  // No leaked $ on a money-shaped substring for the EUR invoice.
  assert.ok(!/\$75\.00/.test(html), 'no $75.00 anywhere — invoice is EUR-priced');
  assert.ok(!/\$300\.00/.test(html), 'no $300.00 — invoice is EUR-priced');
  assert.ok(!/\$330\.00/.test(html), 'no $330.00 — invoice is EUR-priced');
}

async function testInvoiceViewDefaultsToDollarForUsdUser() {
  const html = await renderInvoiceView({
    invoice: sampleInvoice,
    user: { plan: 'free', business_name: 'US Studio', default_currency: 'USD' },
    currency: 'USD'
  });
  assert.ok(/data-testid="invoice-view-total"[^>]*>\$330\.00</.test(html),
    'USD user still sees $330.00 — regression guard');
  assert.ok(/data-testid="invoice-view-subtotal"[^>]*>\$300\.00</.test(html));
  assert.ok(/data-testid="invoice-view-tax"[^>]*>\$30\.00</.test(html));
}

async function testInvoiceViewLegacyCallerStillRenders() {
  // Legacy caller (test fixtures, ad-hoc renders) that doesn't thread the
  // new `currency` + `formatMoney` locals must not throw and must produce
  // the historical $X.XX shape on every money cell.
  const html = await renderInvoiceView({
    invoice: sampleInvoice,
    user: { plan: 'free', business_name: 'Studio' },
    passLocals: false
  });
  assert.ok(/data-testid="invoice-view-total"[^>]*>\$330\.00</.test(html),
    'legacy render path produces $330.00 — backwards-compat regression guard');
  assert.ok(html.includes('$75.00'),
    'legacy render line-item unit price falls back to $');
}

// ---------- 4. views/invoice-print.ejs ---------------------------------

function renderInvoicePrint(opts) {
  return ejs.renderFile(path.join(VIEWS, 'invoice-print.ejs'), {
    title: 't',
    invoice: opts.invoice,
    user: opts.user || { plan: 'free' },
    currency: opts.currency || 'USD',
    currencySymbol: currency.getCurrencySymbol(opts.currency || 'USD'),
    formatMoney: currency.formatMoney,
    noindex: true
  }, { views: [VIEWS] });
}

async function testInvoicePrintRendersGbpOnAllMoneyCells() {
  const html = await renderInvoicePrint({
    invoice: sampleInvoice,
    user: { plan: 'free', default_currency: 'GBP' },
    currency: 'GBP'
  });
  assert.ok(/data-testid="invoice-print-subtotal"[^>]*>£300\.00</.test(html),
    'print subtotal renders with £ for GBP');
  assert.ok(/data-testid="invoice-print-tax"[^>]*>£30\.00</.test(html),
    'print tax renders with £ for GBP');
  assert.ok(/data-testid="invoice-print-total"[^>]*>£330\.00</.test(html),
    'print total renders with £ for GBP');
  assert.ok(html.includes('£75.00'),
    'line-item unit price uses £ for GBP — the freelancer hands this PDF to the client');
  // The line-item amount table row must also use £.
  assert.ok(html.includes('£300.00'), 'line-item amount uses £');
  // No leaked $ on the printed money cells.
  assert.ok(!/\$330\.00/.test(html), 'no $330.00 on a GBP print');
}

async function testInvoicePrintLegacyCallerStillRenders() {
  // Legacy caller (e.g. tests/payment-link.test.js) that renders the print
  // view without `currency` + `formatMoney` locals must not throw. Falls
  // back to $X.XX for backwards-compat.
  const html = await ejs.renderFile(path.join(VIEWS, 'invoice-print.ejs'), {
    title: 't',
    invoice: sampleInvoice,
    user: { plan: 'free' },
    noindex: true
  }, { views: [VIEWS] });
  assert.ok(/data-testid="invoice-print-total"[^>]*>\$330\.00</.test(html),
    'legacy print render emits $330.00 — backwards-compat regression guard');
}

async function testInvoicePrintRendersJpyOnTotal() {
  const yenInvoice = Object.assign({}, sampleInvoice, {
    items: [{ description: 'Translation', quantity: 1, unit_price: 50000 }],
    subtotal: 50000, tax_rate: 0, tax_amount: 0, total: 50000
  });
  const html = await renderInvoicePrint({
    invoice: yenInvoice,
    user: { plan: 'free', default_currency: 'JPY' },
    currency: 'JPY'
  });
  assert.ok(/data-testid="invoice-print-total"[^>]*>¥50000\.00</.test(html),
    'JPY total renders with ¥');
  assert.ok(html.includes('¥50000.00'), 'JPY line-item amount also uses ¥');
}

// ---------- 5-6. views/invoice-form.ejs --------------------------------

function renderInvoiceForm(opts) {
  return ejs.renderFile(path.join(VIEWS, 'invoice-form.ejs'), {
    title: 't',
    invoice: opts.invoice || null,
    invoiceNumber: opts.invoiceNumber || 'INV-NEW',
    recentClients: opts.recentClients || [],
    recentItems: opts.recentItems || [],
    servicePresets: opts.servicePresets || [],
    user: opts.user || { plan: 'free', default_currency: 'USD' },
    flash: null,
    currency: opts.currency || 'USD',
    currencySymbol: currency.getCurrencySymbol(opts.currency || 'USD'),
    noindex: true
  }, { views: [VIEWS] });
}

async function testInvoiceFormRecentItemsLabelUsesUserCurrency() {
  const html = await renderInvoiceForm({
    invoice: null,
    recentItems: [
      { description: 'Hourly retainer', quantity: 4, unit_price: 150, amount: 600 }
    ],
    user: { plan: 'free', default_currency: 'EUR' },
    currency: 'EUR'
  });
  // The recent-items option label embeds qty × unit_price — must use €
  // so the freelancer never picks a row that contradicts their currency.
  assert.ok(/Hourly retainer[^<]*qty 4[^<]*&times; €150\.00/.test(html),
    'recent-items option label must use € for EUR — embeds qty × unit_price');
  assert.ok(!/Hourly retainer[^<]*qty 4[^<]*&times; \$150/.test(html),
    'no $ on the recent-items label for an EUR-default user');
}

async function testInvoiceFormServicePresetsLabelUsesUserCurrency() {
  const html = await renderInvoiceForm({
    invoice: null,
    recentItems: [], // empty → presets surface for the brand-new user
    servicePresets: [
      { description: 'Logo design', quantity: 1, unit_price: 250 },
      { description: 'Hourly consulting', quantity: 1, unit_price: 100 }
    ],
    user: { plan: 'free', default_currency: 'GBP' },
    currency: 'GBP'
  });
  assert.ok(/Logo design[^<]*&middot; £250\.00/.test(html),
    'service-preset option label must use £ for GBP');
  assert.ok(/Hourly consulting[^<]*&middot; £100\.00/.test(html),
    'service-preset option label must use £ for GBP');
  assert.ok(!/Logo design[^<]*&middot; \$250/.test(html),
    'no $ on the service-preset label for a GBP-default user');
}

async function testInvoiceFormAlpineXTextUsesCurrencySymbol() {
  const html = await renderInvoiceForm({
    invoice: null,
    recentItems: [],
    servicePresets: [],
    user: { plan: 'free', default_currency: 'EUR' },
    currency: 'EUR'
  });
  // The Alpine factory's x-text expressions must reference currencySymbol
  // (the new factory field) and NOT a hardcoded '$'. The live line-item
  // total, subtotal, tax, and total all need to tick over in the user's
  // currency as they type.
  assert.ok(/x-text="currencySymbol \+ \(item\.quantity \* item\.unit_price\)/.test(html),
    'live line-item total uses currencySymbol — not a literal $');
  assert.ok(/x-text="currencySymbol \+ subtotal\.toFixed\(2\)"/.test(html),
    'live subtotal uses currencySymbol');
  assert.ok(/x-text="currencySymbol \+ taxAmount\.toFixed\(2\)"/.test(html),
    'live tax amount uses currencySymbol');
  assert.ok(/x-text="currencySymbol \+ total\.toFixed\(2\)"/.test(html),
    'live total uses currencySymbol');
  // The factory must accept a 6th constructor arg AND that arg must be
  // threaded from the EJS x-data binding. EJS `<%= JSON.stringify(...) %>`
  // emits `&#34;€&#34;` (HTML-escaped quotes) inside the x-data attribute.
  assert.ok(/function invoiceEditor\([^)]*initialCurrencySymbol\)/.test(html),
    'invoiceEditor factory must accept the new initialCurrencySymbol arg');
  assert.ok(html.includes('&#34;€&#34;'),
    'EJS must thread the symbol into the x-data binding (HTML-escaped JSON string)');
}

async function testInvoiceFormFallsBackWhenLocalsOmitted() {
  // A legacy caller that doesn't thread currency/currencySymbol must still
  // render the form sanely (without throwing) — and the live totals fall
  // back to the historical $ shape.
  const html = await ejs.renderFile(path.join(VIEWS, 'invoice-form.ejs'), {
    title: 't', invoice: null, invoiceNumber: 'INV-LEG',
    recentClients: [], recentItems: [], servicePresets: [],
    user: { plan: 'free' }, flash: null, noindex: true
  }, { views: [VIEWS] });
  // x-data passes "$" as the JSON-stringified default currencySymbol;
  // EJS escapes the quotes to &#34; inside the x-data attribute.
  assert.ok(html.includes('&#34;$&#34;'),
    'legacy caller without currencySymbol falls back to "$" — Alpine factory still gets a symbol');
}

// ---------- 7. views/invoice-quick.ejs ---------------------------------

function renderInvoiceQuick(opts) {
  return ejs.renderFile(path.join(VIEWS, 'invoice-quick.ejs'), {
    title: 't',
    user: opts.user || { plan: 'free', default_currency: 'USD' },
    flash: null,
    submitted: opts.submitted || null,
    pendingRestored: false,
    recentClients: [],
    recentItems: opts.recentItems || [],
    currency: opts.currency || 'USD',
    currencySymbol: currency.getCurrencySymbol(opts.currency || 'USD'),
    welcome: false,
    noindex: true
  }, { views: [VIEWS] });
}

async function testInvoiceQuickAmountPrefixUsesUserCurrency() {
  const html = await renderInvoiceQuick({
    user: { plan: 'free', default_currency: 'EUR' },
    currency: 'EUR'
  });
  assert.ok(/data-testid="invoice-quick-amount-symbol"[^>]*>€</.test(html),
    'amount input prefix glyph must be € for EUR — replaces the hardcoded $');
  assert.ok(/Amount \(EUR\)/.test(html),
    'amount label must name the currency code — Amount (EUR), not Amount (USD)');
  assert.ok(!/Amount \(USD\)/.test(html),
    'no Amount (USD) label on an EUR-default user');
}

async function testInvoiceQuickRecentItemsLabelUsesUserCurrency() {
  const html = await renderInvoiceQuick({
    user: { plan: 'free', default_currency: 'GBP' },
    currency: 'GBP',
    recentItems: [
      { description: 'Retainer Apr', amount: 1000 }
    ]
  });
  assert.ok(/Retainer Apr · £1000\.00/.test(html),
    'quick-form recent-items label must use £ for GBP');
  assert.ok(!/Retainer Apr · \$1000\.00/.test(html),
    'no $ on the quick-form recent-items label for a GBP user');
}

async function testInvoiceQuickDefaultsToUsdWhenLocalsOmitted() {
  // Legacy caller without currency locals — input prefix should still
  // render the $ glyph (defence-in-depth fallback, not a throw).
  const html = await ejs.renderFile(path.join(VIEWS, 'invoice-quick.ejs'), {
    title: 't', user: { plan: 'free' }, flash: null,
    submitted: null, pendingRestored: false,
    recentClients: [], recentItems: [],
    welcome: false, noindex: true
  }, { views: [VIEWS] });
  assert.ok(/data-testid="invoice-quick-amount-symbol"[^>]*>\$</.test(html),
    'legacy caller renders the $ glyph');
  assert.ok(/Amount \(USD\)/.test(html), 'legacy caller renders Amount (USD)');
}

// ---------- Runner -----------------------------------------------------

const TESTS = [
  ['lib/currency: getCurrencySymbol resolves known codes', testGetCurrencySymbolKnownCodes],
  ['lib/currency: getCurrencySymbol falls back to $ on unknown', testGetCurrencySymbolFallsBackOnUnknown],
  ['invoice-view.ejs: EUR renders on line items + subtotal + tax + total', testInvoiceViewRendersEurOnAllMoneyCells],
  ['invoice-view.ejs: USD user keeps $ shape (regression guard)', testInvoiceViewDefaultsToDollarForUsdUser],
  ['invoice-view.ejs: legacy caller (no formatMoney local) falls back to $', testInvoiceViewLegacyCallerStillRenders],
  ['invoice-print.ejs: legacy caller (no formatMoney local) falls back to $', testInvoicePrintLegacyCallerStillRenders],
  ['invoice-print.ejs: GBP renders on every money cell', testInvoicePrintRendersGbpOnAllMoneyCells],
  ['invoice-print.ejs: JPY ¥ renders on total + line item', testInvoicePrintRendersJpyOnTotal],
  ['invoice-form.ejs: recent-items label uses user currency', testInvoiceFormRecentItemsLabelUsesUserCurrency],
  ['invoice-form.ejs: service-presets label uses user currency', testInvoiceFormServicePresetsLabelUsesUserCurrency],
  ['invoice-form.ejs: Alpine x-text uses currencySymbol (live totals)', testInvoiceFormAlpineXTextUsesCurrencySymbol],
  ['invoice-form.ejs: legacy caller falls back to $ symbol', testInvoiceFormFallsBackWhenLocalsOmitted],
  ['invoice-quick.ejs: amount prefix + label use user currency', testInvoiceQuickAmountPrefixUsesUserCurrency],
  ['invoice-quick.ejs: recent-items label uses user currency', testInvoiceQuickRecentItemsLabelUsesUserCurrency],
  ['invoice-quick.ejs: legacy caller defaults to $ + Amount (USD)', testInvoiceQuickDefaultsToUsdWhenLocalsOmitted]
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
