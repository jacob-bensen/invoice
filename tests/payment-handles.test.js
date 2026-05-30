'use strict';

/*
 * Pure-unit tests for lib/payment-handles.js — the validators + URL
 * builders behind the tap-to-pay buttons on the public /i/<token> page
 * (Milestone 4 — first invoice sent → first payment received). These
 * functions are wired into POST /billing/settings (rejects invalid input)
 * and into views/invoice-public.ejs (renders the deep-link URLs); both
 * paths share the same pure module so the validation rules can't drift.
 *
 * Run: NODE_ENV=test node tests/payment-handles.test.js
 */

const assert = require('assert');
const {
  normalizeVenmoHandle,
  normalizeCashappHandle,
  normalizePaypalHandle,
  venmoPayUrl,
  cashappPayUrl,
  paypalPayUrl,
  buildPayLinks,
  formatAmount
} = require('../lib/payment-handles');

function test(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
    return true;
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error('       ' + (err && err.message));
    return false;
  }
}

let pass = 0, fail = 0;
function run(name, fn) { (test(name, fn) ? pass++ : fail++); }

// ---------- normalizeVenmoHandle ---------------------------------------

run('venmo: plain handle passes through', () => {
  assert.strictEqual(normalizeVenmoHandle('johndoe'), 'johndoe');
});

run('venmo: leading @ stripped', () => {
  assert.strictEqual(normalizeVenmoHandle('@johndoe'), 'johndoe');
});

run('venmo: surrounding whitespace stripped', () => {
  assert.strictEqual(normalizeVenmoHandle('  johndoe  '), 'johndoe');
});

run('venmo: full URL pasted — extracts last path segment', () => {
  assert.strictEqual(normalizeVenmoHandle('https://venmo.com/johndoe'), 'johndoe');
  assert.strictEqual(normalizeVenmoHandle('https://account.venmo.com/u/johndoe'), 'johndoe');
  assert.strictEqual(normalizeVenmoHandle('venmo.com/johndoe?txn=pay'), 'johndoe');
});

run('venmo: rejects empty / whitespace-only', () => {
  assert.strictEqual(normalizeVenmoHandle(''), null);
  assert.strictEqual(normalizeVenmoHandle('   '), null);
  assert.strictEqual(normalizeVenmoHandle(null), null);
  assert.strictEqual(normalizeVenmoHandle(undefined), null);
});

run('venmo: rejects handles with spaces or special chars', () => {
  assert.strictEqual(normalizeVenmoHandle('john doe'), null);
  assert.strictEqual(normalizeVenmoHandle('john!doe'), null);
  assert.strictEqual(normalizeVenmoHandle('john/doe'), null);
});

run('venmo: rejects oversized handle (>30 chars)', () => {
  assert.strictEqual(normalizeVenmoHandle('a'.repeat(31)), null);
  assert.strictEqual(normalizeVenmoHandle('a'.repeat(30)), 'a'.repeat(30));
});

run('venmo: allows dot, underscore, hyphen (legacy + modern handles)', () => {
  assert.strictEqual(normalizeVenmoHandle('john.doe'), 'john.doe');
  assert.strictEqual(normalizeVenmoHandle('john_doe'), 'john_doe');
  assert.strictEqual(normalizeVenmoHandle('john-doe'), 'john-doe');
});

// ---------- normalizeCashappHandle -------------------------------------

run('cashapp: plain cashtag passes through', () => {
  assert.strictEqual(normalizeCashappHandle('johndoe'), 'johndoe');
});

run('cashapp: leading $ stripped', () => {
  assert.strictEqual(normalizeCashappHandle('$johndoe'), 'johndoe');
});

run('cashapp: full URL pasted', () => {
  assert.strictEqual(normalizeCashappHandle('https://cash.app/$johndoe'), 'johndoe');
});

run('cashapp: rejects cashtag starting with digit', () => {
  assert.strictEqual(normalizeCashappHandle('123abc'), null);
});

run('cashapp: rejects empty / whitespace-only', () => {
  assert.strictEqual(normalizeCashappHandle(''), null);
  assert.strictEqual(normalizeCashappHandle('   '), null);
  assert.strictEqual(normalizeCashappHandle(null), null);
});

run('cashapp: rejects oversized cashtag (>20 chars)', () => {
  assert.strictEqual(normalizeCashappHandle('a' + '1'.repeat(20)), null);
  assert.strictEqual(normalizeCashappHandle('a' + '1'.repeat(19)), 'a' + '1'.repeat(19));
});

run('cashapp: rejects cashtag with hyphen (Cash App disallows)', () => {
  assert.strictEqual(normalizeCashappHandle('john-doe'), null);
});

// ---------- normalizePaypalHandle --------------------------------------

run('paypal: plain handle passes through', () => {
  assert.strictEqual(normalizePaypalHandle('johndoe'), 'johndoe');
});

run('paypal: leading @ stripped (common paste habit)', () => {
  assert.strictEqual(normalizePaypalHandle('@johndoe'), 'johndoe');
});

run('paypal: full URL pasted', () => {
  assert.strictEqual(normalizePaypalHandle('https://paypal.me/johndoe'), 'johndoe');
  assert.strictEqual(normalizePaypalHandle('paypal.me/johndoe/50'), 'johndoe');
});

run('paypal: rejects empty', () => {
  assert.strictEqual(normalizePaypalHandle(''), null);
  assert.strictEqual(normalizePaypalHandle('   '), null);
});

run('paypal: rejects oversized (>20 chars)', () => {
  assert.strictEqual(normalizePaypalHandle('a'.repeat(21)), null);
  assert.strictEqual(normalizePaypalHandle('a'.repeat(20)), 'a'.repeat(20));
});

run('paypal: rejects underscore (PayPal.me disallows)', () => {
  assert.strictEqual(normalizePaypalHandle('john_doe'), null);
});

// ---------- formatAmount -----------------------------------------------

run('formatAmount: integers → two-decimal string', () => {
  assert.strictEqual(formatAmount(45), '45.00');
});

run('formatAmount: one-decimal → padded to two', () => {
  assert.strictEqual(formatAmount(45.5), '45.50');
});

run('formatAmount: three-decimal → rounded to two', () => {
  // toFixed(2) collapses three-decimal inputs into two. The exact
  // half-rounding behaviour is platform-dependent (45.555 hits an
  // IEEE-754 edge case), so the assertion uses a non-edge fraction.
  assert.strictEqual(formatAmount(45.567), '45.57');
  assert.strictEqual(formatAmount(45.564), '45.56');
});

run('formatAmount: string numeric input parsed', () => {
  assert.strictEqual(formatAmount('100'), '100.00');
  assert.strictEqual(formatAmount('100.25'), '100.25');
});

run('formatAmount: non-positive / non-finite → null', () => {
  assert.strictEqual(formatAmount(0), null);
  assert.strictEqual(formatAmount(-5), null);
  assert.strictEqual(formatAmount(NaN), null);
  assert.strictEqual(formatAmount(Infinity), null);
  assert.strictEqual(formatAmount('abc'), null);
  assert.strictEqual(formatAmount(null), null);
  assert.strictEqual(formatAmount(undefined), null);
});

// ---------- venmoPayUrl -------------------------------------------------

run('venmoPayUrl: builds full deep-link with amount + note', () => {
  const url = venmoPayUrl({ handle: 'johndoe', amount: 45.50, invoiceNumber: 'INV-2026-0001' });
  assert.ok(url.startsWith('https://venmo.com/johndoe?'), 'URL must use venmo.com and the canonical handle');
  assert.ok(url.includes('txn=pay'), 'must set txn=pay');
  assert.ok(url.includes('amount=45.50'), 'amount must be two-decimal formatted');
  assert.ok(/note=Invoice(\+|%20)INV-2026-0001/.test(url), 'note must reference the invoice number');
});

run('venmoPayUrl: returns null for invalid handle', () => {
  assert.strictEqual(venmoPayUrl({ handle: 'bad handle!', amount: 50, invoiceNumber: 'X' }), null);
  assert.strictEqual(venmoPayUrl({ handle: '', amount: 50, invoiceNumber: 'X' }), null);
});

run('venmoPayUrl: still works without amount (txn=pay link only)', () => {
  const url = venmoPayUrl({ handle: 'johndoe', amount: 0, invoiceNumber: 'INV-1' });
  assert.ok(url.startsWith('https://venmo.com/johndoe?'));
  assert.ok(url.includes('txn=pay'));
  assert.ok(!url.includes('amount='), 'no amount param when amount is zero/invalid');
});

run('venmoPayUrl: strips leading @ from handle input', () => {
  const url = venmoPayUrl({ handle: '@johndoe', amount: 10, invoiceNumber: 'X' });
  assert.ok(url.startsWith('https://venmo.com/johndoe?'),
    'normalized handle is used (no @ in the URL path)');
});

// ---------- cashappPayUrl ----------------------------------------------

run('cashappPayUrl: builds full deep-link with amount', () => {
  const url = cashappPayUrl({ handle: 'johndoe', amount: 45.50 });
  assert.strictEqual(url, 'https://cash.app/$johndoe/45.50');
});

run('cashappPayUrl: works without amount (cashtag profile)', () => {
  const url = cashappPayUrl({ handle: 'johndoe', amount: 0 });
  assert.strictEqual(url, 'https://cash.app/$johndoe');
});

run('cashappPayUrl: returns null for invalid handle', () => {
  assert.strictEqual(cashappPayUrl({ handle: '123abc', amount: 50 }), null);
  assert.strictEqual(cashappPayUrl({ handle: '', amount: 50 }), null);
});

// ---------- paypalPayUrl -----------------------------------------------

run('paypalPayUrl: builds full deep-link with amount + currency', () => {
  const url = paypalPayUrl({ handle: 'johndoe', amount: 45.50 });
  assert.strictEqual(url, 'https://paypal.me/johndoe/45.50USD');
});

run('paypalPayUrl: works without amount', () => {
  const url = paypalPayUrl({ handle: 'johndoe', amount: 0 });
  assert.strictEqual(url, 'https://paypal.me/johndoe');
});

run('paypalPayUrl: returns null for invalid handle', () => {
  assert.strictEqual(paypalPayUrl({ handle: 'bad_handle', amount: 50 }), null);
});

// ---------- buildPayLinks -----------------------------------------------

run('buildPayLinks: all three set → all three URLs returned', () => {
  const result = buildPayLinks({
    venmo: 'jdoe', cashapp: 'jdoe', paypal: 'jdoe',
    amount: 100, invoiceNumber: 'INV-1'
  });
  assert.ok(result.venmo.startsWith('https://venmo.com/jdoe?'));
  assert.strictEqual(result.cashapp, 'https://cash.app/$jdoe/100.00');
  assert.strictEqual(result.paypal, 'https://paypal.me/jdoe/100.00USD');
});

run('buildPayLinks: only one set → other two null', () => {
  const result = buildPayLinks({
    venmo: 'jdoe', cashapp: null, paypal: undefined,
    amount: 100, invoiceNumber: 'INV-1'
  });
  assert.ok(result.venmo);
  assert.strictEqual(result.cashapp, null);
  assert.strictEqual(result.paypal, null);
});

run('buildPayLinks: all empty → all null', () => {
  const result = buildPayLinks({
    venmo: null, cashapp: null, paypal: null,
    amount: 100, invoiceNumber: 'INV-1'
  });
  assert.strictEqual(result.venmo, null);
  assert.strictEqual(result.cashapp, null);
  assert.strictEqual(result.paypal, null);
});

// ---------- Final report -----------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
