'use strict';

/*
 * Unit tests for lib/html.js (INTERNAL_TODO H14).
 *
 * H14 promoted the duplicated `escapeHtml` and `formatMoney` helpers
 * (previously copy-pasted across lib/email.js, jobs/reminders.js, and
 * jobs/trial-nudge.js) into a single shared module. These tests assert the
 * canonical behaviour of the consolidated helpers so any future drift in
 * escaping rules or money formatting is caught at the source.
 *
 * Run: NODE_ENV=test node tests/html-helpers.test.js
 */

const assert = require('assert');

const { escapeHtml, formatMoney, CURRENCY_SYMBOLS } = require('../lib/html');

let pass = 0;
let fail = 0;

function run(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`  FAIL ${name}`);
    console.log(`        ${err && err.message}`);
  }
}

// ---------- escapeHtml ----------------------------------------------------

run('escapeHtml: null returns empty string', () => {
  assert.strictEqual(escapeHtml(null), '');
});

run('escapeHtml: undefined returns empty string', () => {
  assert.strictEqual(escapeHtml(undefined), '');
});

run('escapeHtml: empty string returns empty string', () => {
  assert.strictEqual(escapeHtml(''), '');
});

run('escapeHtml: numbers are coerced to strings', () => {
  assert.strictEqual(escapeHtml(42), '42');
  assert.strictEqual(escapeHtml(0), '0');
});

run('escapeHtml: ampersand → &amp;', () => {
  assert.strictEqual(escapeHtml('A & B'), 'A &amp; B');
});

run('escapeHtml: < and > → &lt;/&gt;', () => {
  assert.strictEqual(escapeHtml('<script>'), '&lt;script&gt;');
});

run('escapeHtml: double-quote → &quot;', () => {
  assert.strictEqual(escapeHtml('say "hi"'), 'say &quot;hi&quot;');
});

run("escapeHtml: single-quote → &#39;", () => {
  assert.strictEqual(escapeHtml("it's"), 'it&#39;s');
});

run('escapeHtml: ampersand escapes first (no double-encoding)', () => {
  // & must run first or "&lt;" would become "&amp;lt;"
  assert.strictEqual(escapeHtml('<a&b>'), '&lt;a&amp;b&gt;');
});

run('escapeHtml: full XSS payload is neutralised', () => {
  const payload = `<script>alert('x')</script>`;
  const safe = escapeHtml(payload);
  assert.ok(!safe.includes('<script>'), 'literal <script> must not survive');
  assert.ok(!safe.includes('</script>'), 'literal </script> must not survive');
  assert.strictEqual(safe, '&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;');
});

run('escapeHtml: idempotent on already-escaped input (intentional double-encode)', () => {
  // We re-encode &amp; -> &amp;amp; on purpose; callers must escape once.
  assert.strictEqual(escapeHtml('&amp;'), '&amp;amp;');
});

// ---------- formatMoney ---------------------------------------------------

run('formatMoney: default currency (no arg) is USD', () => {
  assert.strictEqual(formatMoney(10), '$10.00');
});

run('formatMoney: USD code matches default behaviour', () => {
  assert.strictEqual(formatMoney(10, 'usd'), '$10.00');
});

run('formatMoney: uppercase currency code is normalised', () => {
  assert.strictEqual(formatMoney(10, 'USD'), '$10.00');
  assert.strictEqual(formatMoney(10, 'EUR'), '€10.00');
});

run('formatMoney: two decimal places are always emitted', () => {
  assert.strictEqual(formatMoney(10.1), '$10.10');
  assert.strictEqual(formatMoney(10.005), '$10.01'); // standard JS rounding
  assert.strictEqual(formatMoney(0), '$0.00');
});

run('formatMoney: NaN/null/undefined coerce to 0.00 (no throw)', () => {
  assert.strictEqual(formatMoney('not-a-number'), '$0.00');
  assert.strictEqual(formatMoney(null), '$0.00');
  assert.strictEqual(formatMoney(undefined), '$0.00');
  assert.strictEqual(formatMoney(NaN), '$0.00');
});

run('formatMoney: Infinity coerces to 0.00', () => {
  assert.strictEqual(formatMoney(Infinity), '$0.00');
  assert.strictEqual(formatMoney(-Infinity), '$0.00');
});

run('formatMoney: known currency symbols render correctly', () => {
  assert.strictEqual(formatMoney(1, 'eur'), '€1.00');
  assert.strictEqual(formatMoney(1, 'gbp'), '£1.00');
  assert.strictEqual(formatMoney(1, 'cad'), 'CA$1.00');
  assert.strictEqual(formatMoney(1, 'aud'), 'A$1.00');
  assert.strictEqual(formatMoney(1, 'chf'), 'CHF 1.00');
  assert.strictEqual(formatMoney(1, 'jpy'), '¥1.00');
  assert.strictEqual(formatMoney(1, 'nzd'), 'NZ$1.00');
});

run('formatMoney: unknown currency falls back to bare number (no symbol)', () => {
  assert.strictEqual(formatMoney(5, 'xyz'), '5.00');
});

run('formatMoney: negative amounts keep the sign in front of digits', () => {
  // Number.toFixed handles the leading "-" naturally.
  assert.strictEqual(formatMoney(-3.5), '$-3.50');
});

run('formatMoney: large amounts render without thousand separators (intentional)', () => {
  // Email clients render reliably on plain digit groups; locale-grouped
  // strings can break alignment in monospace receipts.
  assert.strictEqual(formatMoney(1234567.89), '$1234567.89');
});

run('formatMoney: prototype-pollution guard — __proto__ is not a currency', () => {
  // Object.prototype.hasOwnProperty check guards against an accidental hit on
  // inherited keys like __proto__ or constructor.
  assert.strictEqual(formatMoney(1, '__proto__'), '1.00');
  assert.strictEqual(formatMoney(1, 'constructor'), '1.00');
  assert.strictEqual(formatMoney(1, 'toString'), '1.00');
});

run('formatMoney: numeric strings are accepted', () => {
  assert.strictEqual(formatMoney('15.5'), '$15.50');
  assert.strictEqual(formatMoney('0'), '$0.00');
});

// ---------- Module shape --------------------------------------------------

run('module exports escapeHtml + formatMoney + CURRENCY_SYMBOLS', () => {
  assert.strictEqual(typeof escapeHtml, 'function');
  assert.strictEqual(typeof formatMoney, 'function');
  assert.strictEqual(typeof CURRENCY_SYMBOLS, 'object');
  assert.ok(CURRENCY_SYMBOLS.usd === '$', 'USD must map to $');
  assert.ok(Object.keys(CURRENCY_SYMBOLS).length >= 8,
    'at least the 8 commonly used currencies are pre-registered');
});

// ---------- Cross-module consistency --------------------------------------
// The whole point of H14: every consumer must reach the same canonical
// implementation, not a private copy.

run('lib/email re-uses the shared helpers (no private copy)', () => {
  delete require.cache[require.resolve('../lib/email')];
  const email = require('../lib/email');
  assert.strictEqual(email._internal.escapeHtml, escapeHtml,
    'email.escapeHtml must be the same identity as html.escapeHtml');
  assert.strictEqual(email._internal.formatMoney, formatMoney,
    'email.formatMoney must be the same identity as html.formatMoney');
});

run('jobs/reminders re-uses the shared helpers (no private copy)', () => {
  delete require.cache[require.resolve('../jobs/reminders')];
  const reminders = require('../jobs/reminders');
  assert.strictEqual(reminders._internal.escapeHtml, escapeHtml,
    'reminders.escapeHtml must be the same identity as html.escapeHtml');
  assert.strictEqual(reminders._internal.formatMoney, formatMoney,
    'reminders.formatMoney must be the same identity as html.formatMoney');
});

run('jobs/trial-nudge re-uses the shared escapeHtml (no private copy)', () => {
  delete require.cache[require.resolve('../jobs/trial-nudge')];
  const trial = require('../jobs/trial-nudge');
  assert.strictEqual(trial._internal.escapeHtml, escapeHtml,
    'trial-nudge.escapeHtml must be the same identity as html.escapeHtml');
});

console.log(`\nhtml-helpers.test.js: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
