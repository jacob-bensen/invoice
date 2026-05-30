'use strict';

/*
 * Tap-to-pay deep-link builders for the three peer-to-peer payment apps
 * the free-tier cohort uses most often (Milestone 4 — first invoice sent →
 * first payment received). The freelancer's existing payment_instructions
 * textarea on /billing/settings renders verbatim on the public /i/<token>
 * page as a plain-text "How to pay" panel — informative, but the client
 * must manually copy the Venmo handle and re-type it in the Venmo app.
 * Adding structured handles (one per app) lets the public page render a
 * universal-link button per app with the invoice's amount and number
 * pre-filled, collapsing 4-5 steps into one tap on the dominant mobile
 * cohort.
 *
 * Each app gets a `normalize<X>Handle(input)` (returns the canonical handle
 * string or null when invalid) plus a `<X>PayUrl({ handle, amount, note })`
 * (returns the universal link or null when the handle is missing/invalid
 * or the amount is non-positive). Both are pure functions — no I/O, no
 * Express/DB coupling — so the validation can be reused on POST /settings
 * and the URL construction can be reused on the public render path.
 */

// Venmo: usernames are 5-30 chars, alphanumeric + `_` + `-` (per Venmo's
// signup rules circa 2024+). The legacy `.` is no longer allowed on new
// accounts but a handful of pre-2018 handles still carry it, so we accept
// it on the validation pass to avoid breaking the long tail. Leading `@`
// is the most common paste-error and is silently stripped.
const VENMO_RE = /^[A-Za-z0-9_.-]{1,30}$/;

// Cash App cashtag: 1-20 chars, must start with a letter (Cash App's own
// rule), alphanumeric + `_`. Case-insensitive on the wire but we preserve
// the input case for display fidelity. Leading `$` is silently stripped.
const CASHAPP_RE = /^[A-Za-z][A-Za-z0-9_]{0,19}$/;

// PayPal.me: 1-20 chars, alphanumeric only (no `-`, no `_` per PayPal.me's
// own constraints). Some old accounts have `-`; we accept it to match the
// long tail. Leading `@` is silently stripped (some users instinctively
// prefix it).
const PAYPAL_RE = /^[A-Za-z0-9-]{1,20}$/;

// Normalize any raw user input — strip whitespace + URL prefixes the user
// may have pasted (e.g. "https://venmo.com/foo"). Returns the trailing
// path segment or the original trimmed string, whichever applies.
function stripUrlChrome(raw) {
  if (raw == null) return '';
  let s = String(raw).trim();
  if (!s) return '';
  // Pull off scheme + host if a full URL was pasted, then take the first
  // path segment (handles like "venmo.com/me/foo?bar=1" → "foo").
  const m = s.match(/^(?:https?:\/\/)?(?:www\.)?(?:account\.)?(?:venmo\.com|cash\.app|paypal\.me)\/(?:u\/)?(.+)$/i);
  if (m) {
    s = m[1].split(/[?#/]/)[0];
  }
  return s.trim();
}

function normalizeVenmoHandle(raw) {
  let s = stripUrlChrome(raw);
  if (!s) return null;
  if (s.startsWith('@')) s = s.slice(1);
  if (!VENMO_RE.test(s)) return null;
  return s;
}

function normalizeCashappHandle(raw) {
  let s = stripUrlChrome(raw);
  if (!s) return null;
  if (s.startsWith('$')) s = s.slice(1);
  if (!CASHAPP_RE.test(s)) return null;
  return s;
}

function normalizePaypalHandle(raw) {
  let s = stripUrlChrome(raw);
  if (!s) return null;
  if (s.startsWith('@')) s = s.slice(1);
  if (!PAYPAL_RE.test(s)) return null;
  return s;
}

// Coerce the invoice total to a `\d+(\.\d{1,2})?` string. The deep-link
// URLs are sensitive to amount format: Venmo and Cash App both reject
// non-numeric / oversized-fraction inputs by falling back to "amount not
// set" inside the app, which defeats the one-tap value-prop. Returns null
// on non-positive / non-finite inputs so the caller can render a plain
// "open Venmo" link without the prefilled amount (or skip rendering).
function formatAmount(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  // Two-decimal fixed string — `45` → `45.00`, `45.5` → `45.50`,
  // `45.555` → `45.56` (banker's rounding via toFixed).
  return n.toFixed(2);
}

// Build the URL-encoded payment note. Venmo's `note` query param is
// rendered verbatim in the recipient's transaction history, so a stable
// "Invoice <number>" string gives the freelancer a paper trail without
// any manual labelling on their end. Returns an empty string when the
// invoice number is missing (rather than a literal `undefined`).
function buildNote(invoiceNumber) {
  if (!invoiceNumber) return '';
  return `Invoice ${String(invoiceNumber)}`;
}

function venmoPayUrl({ handle, amount, invoiceNumber }) {
  const h = normalizeVenmoHandle(handle);
  if (!h) return null;
  const amt = formatAmount(amount);
  const params = new URLSearchParams();
  params.set('txn', 'pay');
  if (amt) params.set('amount', amt);
  const note = buildNote(invoiceNumber);
  if (note) params.set('note', note);
  return `https://venmo.com/${encodeURIComponent(h)}?${params.toString()}`;
}

function cashappPayUrl({ handle, amount }) {
  const h = normalizeCashappHandle(handle);
  if (!h) return null;
  const amt = formatAmount(amount);
  // Cash App's cashtag URL accepts an optional `/amount` suffix that opens
  // the app with the amount pre-filled. Without an amount, the URL still
  // works — it just opens the cashtag profile and the client types the
  // amount themselves.
  return amt
    ? `https://cash.app/$${encodeURIComponent(h)}/${amt}`
    : `https://cash.app/$${encodeURIComponent(h)}`;
}

function paypalPayUrl({ handle, amount }) {
  const h = normalizePaypalHandle(handle);
  if (!h) return null;
  const amt = formatAmount(amount);
  // PayPal.me accepts an optional `/<amount><currency>` suffix. We default
  // to USD because that's the only currency the rest of the app supports
  // (the invoice total has no currency column). When PayPal supports
  // multi-currency in the invoice schema, the suffix becomes dynamic.
  return amt
    ? `https://paypal.me/${encodeURIComponent(h)}/${amt}USD`
    : `https://paypal.me/${encodeURIComponent(h)}`;
}

// Convenience for the public-page render: takes a row with the three owner
// handles + the invoice's amount + number, returns the three URLs (any
// can be null). Lets the template iterate once instead of three
// independent `<% if %>` blocks.
function buildPayLinks({ venmo, cashapp, paypal, amount, invoiceNumber }) {
  return {
    venmo: venmoPayUrl({ handle: venmo, amount, invoiceNumber }),
    cashapp: cashappPayUrl({ handle: cashapp, amount }),
    paypal: paypalPayUrl({ handle: paypal, amount })
  };
}

module.exports = {
  normalizeVenmoHandle,
  normalizeCashappHandle,
  normalizePaypalHandle,
  venmoPayUrl,
  cashappPayUrl,
  paypalPayUrl,
  buildPayLinks,
  formatAmount,
  stripUrlChrome
};
