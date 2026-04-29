'use strict';

/*
 * Tests for INTERNAL_TODO #41 — Stripe Payment Link payment-method
 * configuration via STRIPE_PAYMENT_METHODS env var. Covers:
 *  - parsePaymentMethods() pure helper (allowlist, normalisation, defaults).
 *  - createInvoicePaymentLink() forwards the parsed list to Stripe.
 *  - invoice-view template renders the human-readable method copy.
 */

const assert = require('assert');
const path = require('path');
const ejs = require('ejs');

function clearReq(mod) { delete require.cache[require.resolve(mod)]; }

// ---------- parsePaymentMethods --------------------------------------------

async function testParseDefaultsToCardWhenUnset() {
  clearReq('../lib/stripe-payment-link');
  const { parsePaymentMethods } = require('../lib/stripe-payment-link');
  assert.deepStrictEqual(parsePaymentMethods(undefined), ['card']);
  assert.deepStrictEqual(parsePaymentMethods(''), ['card']);
  assert.deepStrictEqual(parsePaymentMethods(null), ['card']);
}

async function testParseHandlesMultipleMethods() {
  const { parsePaymentMethods } = require('../lib/stripe-payment-link');
  assert.deepStrictEqual(
    parsePaymentMethods('card,us_bank_account,sepa_debit'),
    ['card', 'us_bank_account', 'sepa_debit']
  );
}

async function testParseTrimsAndLowercases() {
  const { parsePaymentMethods } = require('../lib/stripe-payment-link');
  assert.deepStrictEqual(
    parsePaymentMethods('  card , US_BANK_ACCOUNT , SePa_Debit '),
    ['card', 'us_bank_account', 'sepa_debit']
  );
}

async function testParseRejectsUnknownValues() {
  const { parsePaymentMethods } = require('../lib/stripe-payment-link');
  // Unknown methods are silently dropped — defence against typos and against
  // future Stripe-introduced methods that we have not yet validated.
  assert.deepStrictEqual(
    parsePaymentMethods('card,paypal,bitcoin,us_bank_account'),
    ['card', 'us_bank_account']
  );
  // All-unknown input falls back to card-only — never returns an empty list,
  // which would cause Stripe to reject the paymentLinks.create() call.
  assert.deepStrictEqual(parsePaymentMethods('paypal,venmo'), ['card']);
}

async function testParseDeduplicates() {
  const { parsePaymentMethods } = require('../lib/stripe-payment-link');
  assert.deepStrictEqual(
    parsePaymentMethods('card,CARD,us_bank_account,card'),
    ['card', 'us_bank_account']
  );
}

// ---------- createInvoicePaymentLink ---------------------------------------

async function testHelperPassesDefaultCardOnly() {
  clearReq('../lib/stripe-payment-link');
  delete process.env.STRIPE_PAYMENT_METHODS;
  const { createInvoicePaymentLink } = require('../lib/stripe-payment-link');

  const calls = [];
  const stripeClient = {
    products: { create: async () => ({ id: 'prod_x' }) },
    prices: { create: async () => ({ id: 'price_x' }) },
    paymentLinks: { create: async (o) => { calls.push(o); return { id: 'plink_x', url: 'https://buy.stripe.com/test_x' }; } }
  };
  await createInvoicePaymentLink(
    { id: 1, invoice_number: 'INV-1', total: '500.00' },
    { id: 1 },
    stripeClient
  );
  assert.deepStrictEqual(calls[0].payment_method_types, ['card']);
}

async function testHelperPassesMultipleMethodsFromEnv() {
  clearReq('../lib/stripe-payment-link');
  process.env.STRIPE_PAYMENT_METHODS = 'card,us_bank_account,sepa_debit';
  const { createInvoicePaymentLink } = require('../lib/stripe-payment-link');

  const calls = [];
  const stripeClient = {
    products: { create: async () => ({ id: 'prod_x' }) },
    prices: { create: async () => ({ id: 'price_x' }) },
    paymentLinks: { create: async (o) => { calls.push(o); return { id: 'plink_x', url: 'u' }; } }
  };
  await createInvoicePaymentLink(
    { id: 2, invoice_number: 'INV-2', total: '2000.00' },
    { id: 1 },
    stripeClient
  );
  assert.deepStrictEqual(
    calls[0].payment_method_types,
    ['card', 'us_bank_account', 'sepa_debit']
  );
  delete process.env.STRIPE_PAYMENT_METHODS;
}

async function testHelperIgnoresUnknownMethodsFromEnv() {
  clearReq('../lib/stripe-payment-link');
  process.env.STRIPE_PAYMENT_METHODS = 'card,paypal';
  const { createInvoicePaymentLink } = require('../lib/stripe-payment-link');

  const calls = [];
  const stripeClient = {
    products: { create: async () => ({ id: 'p' }) },
    prices: { create: async () => ({ id: 'pr' }) },
    paymentLinks: { create: async (o) => { calls.push(o); return { id: 'pl', url: 'u' }; } }
  };
  await createInvoicePaymentLink(
    { id: 3, invoice_number: 'INV-3', total: '100.00' },
    { id: 1 },
    stripeClient
  );
  assert.deepStrictEqual(calls[0].payment_method_types, ['card']);
  delete process.env.STRIPE_PAYMENT_METHODS;
}

// ---------- invoice-view template tooltip ----------------------------------

async function testInvoiceViewRendersMethodTooltip() {
  const tpl = path.join(__dirname, '..', 'views', 'invoice-view.ejs');
  const html = await ejs.renderFile(tpl, {
    title: 't',
    invoice: {
      id: 91, invoice_number: 'INV-91',
      client_name: 'C', client_email: '', client_address: '',
      items: [], subtotal: '500.00', tax_rate: '0', tax_amount: '0', total: '500.00',
      status: 'sent', issued_date: '2026-04-26', due_date: null, notes: '',
      payment_link_url: 'https://buy.stripe.com/test_91',
      payment_link_id: 'plink_91'
    },
    user: { id: 1, plan: 'pro', name: 'U', email: 'u@x.com' },
    flash: null,
    paymentMethods: ['card', 'us_bank_account']
  }, { views: [path.join(__dirname, '..', 'views')] });

  assert.ok(
    html.includes('US bank transfer (ACH)'),
    'invoice view must surface ACH copy when us_bank_account is enabled'
  );
  assert.ok(html.includes('Clients can pay via'), 'tooltip prefix must render');
}

async function testInvoiceViewDefaultsToCardOnlyTooltip() {
  const tpl = path.join(__dirname, '..', 'views', 'invoice-view.ejs');
  const html = await ejs.renderFile(tpl, {
    title: 't',
    invoice: {
      id: 92, invoice_number: 'INV-92',
      client_name: 'C', client_email: '', client_address: '',
      items: [], subtotal: '100.00', tax_rate: '0', tax_amount: '0', total: '100.00',
      status: 'sent', issued_date: '2026-04-26', due_date: null, notes: '',
      payment_link_url: 'https://buy.stripe.com/test_92',
      payment_link_id: 'plink_92'
    },
    user: { id: 1, plan: 'pro', name: 'U', email: 'u@x.com' },
    flash: null,
    paymentMethods: ['card']
  }, { views: [path.join(__dirname, '..', 'views')] });

  assert.ok(
    html.includes('Clients can pay via card.'),
    'card-only label renders when no bank methods are enabled'
  );
  assert.ok(
    !html.includes('US bank transfer'),
    'card-only setup must NOT mention bank transfer'
  );
}

// ---------- Runner ---------------------------------------------------------

async function run() {
  const tests = [
    ['parsePaymentMethods defaults to ["card"]', testParseDefaultsToCardWhenUnset],
    ['parsePaymentMethods handles multiple methods', testParseHandlesMultipleMethods],
    ['parsePaymentMethods trims/lowercases', testParseTrimsAndLowercases],
    ['parsePaymentMethods drops unknown values + falls back to card', testParseRejectsUnknownValues],
    ['parsePaymentMethods deduplicates', testParseDeduplicates],
    ['createInvoicePaymentLink defaults to card-only', testHelperPassesDefaultCardOnly],
    ['createInvoicePaymentLink reads STRIPE_PAYMENT_METHODS', testHelperPassesMultipleMethodsFromEnv],
    ['createInvoicePaymentLink ignores unknown env values', testHelperIgnoresUnknownMethodsFromEnv],
    ['invoice-view renders ACH tooltip when us_bank_account enabled', testInvoiceViewRendersMethodTooltip],
    ['invoice-view defaults to card-only tooltip', testInvoiceViewDefaultsToCardOnlyTooltip]
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
