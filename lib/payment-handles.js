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

// Zelle: the freelancer's Zelle handle is the email address or US phone
// number their bank has registered for Zelle. Unlike Venmo / Cash App /
// PayPal, Zelle has no public profile URLs (it lives entirely inside
// bank apps) and therefore no universal-link / deep-link standard. The
// public-page surface for Zelle is therefore a tap-to-copy handle plus
// a "Open your bank app's Zelle section" hint — we still validate the
// handle so a typo can't ship to the client's screen.
//
// Email rule: a "good enough" email regex restricted to the printable
// ASCII characters real-world bank Zelle registrations use. We
// deliberately don't enforce full RFC 5322 grammar (over-restrictive)
// but DO exclude `<`, `>`, `"`, `'`, `&`, and other chars that would
// otherwise let a hostile input survive normalization and land in the
// JS-clipboard-write attribute on the public render. Zelle itself
// validates the handle when the client pastes it into their bank app,
// so this regex is the freelancer-side gate, not the cryptographic
// truth. Length cap of 254 chars matches RFC 5321 SMTP envelope max.
const ZELLE_EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

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

// Normalize a Zelle handle — accepts either an email or a phone number
// (the only two registration shapes Zelle supports). Email → lowercased
// canonical form; phone → digits-only with optional leading `+` (E.164
// shape, same contract as lib/phone.js#normalizeClientPhone). Returns
// null for anything that's not a plausible email or phone. The leading
// `@` strip from the other normalizers is preserved here for paste-error
// tolerance even though Zelle handles never start with `@` — a user who
// typed `@user@example.com` clearly meant `user@example.com`.
function normalizeZelleHandle(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  if (s.startsWith('@')) s = s.slice(1).trim();
  if (!s) return null;
  if (s.length > 254) return null;
  // Email path — must contain a single `@` followed by a domain with `.`.
  if (s.includes('@')) {
    const lower = s.toLowerCase();
    if (!ZELLE_EMAIL_RE.test(lower)) return null;
    return lower;
  }
  // Phone path — strip non-digits, preserve leading `+`, accept 7-15
  // digits (E.164 envelope). Mirrors lib/phone.js#normalizeClientPhone
  // but kept inline so this module stays a pure leaf (no cross-lib
  // dependency).
  const hasPlus = s.charAt(0) === '+';
  const digits = s.replace(/\D+/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return hasPlus ? `+${digits}` : digits;
}

// Build a Zelle surface object for the public page render. Unlike the
// three universal-link rails above, Zelle has no deep-link — the client
// has to open their bank app and type the handle in. So instead of a
// `<X>PayUrl()` builder that returns a URL, we return a small descriptor
// the template uses to render a tap-to-copy button + a "use your bank
// app" hint. Returns null when the handle is missing/invalid so the
// template doesn't render a broken card.
//
//   handle:  canonical normalized handle (string used by the copy button)
//   kind:    'email' | 'phone' — drives the icon + label
//   display: human-readable form (the phone gets pretty-printed for the
//            US 10/11-digit common case; email is shown verbatim)
function buildZelleSurface({ handle }) {
  const normalized = normalizeZelleHandle(handle);
  if (!normalized) return null;
  if (normalized.includes('@')) {
    return { handle: normalized, kind: 'email', display: normalized };
  }
  // Phone display: only auto-pretty-print US-shaped numbers; everything
  // else (international / non-standard length) shows the digit string
  // verbatim so we don't mis-format and confuse the client.
  const digits = normalized.replace(/^\+/, '');
  let display = normalized;
  if (!normalized.startsWith('+') && digits.length === 10) {
    display = `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  } else if (normalized.startsWith('+1') && digits.length === 11) {
    display = `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return { handle: normalized, kind: 'phone', display };
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

// PayPal.me accepts an optional `/<amount><currency>` suffix where the
// currency is a 3-letter ISO-4217 code. The freelancer's resolved
// currency (per-invoice override → user default → 'USD') drives the
// suffix so a non-US freelancer's client lands on the PayPal compose
// screen pre-filled in the right currency. Invalid / missing currency
// falls back to 'USD' rather than emitting a broken URL.
function paypalPayUrl({ handle, amount, currency }) {
  const h = normalizePaypalHandle(handle);
  if (!h) return null;
  const amt = formatAmount(amount);
  const code = (typeof currency === 'string' && /^[A-Za-z]{3}$/.test(currency.trim()))
    ? currency.trim().toUpperCase()
    : 'USD';
  return amt
    ? `https://paypal.me/${encodeURIComponent(h)}/${amt}${code}`
    : `https://paypal.me/${encodeURIComponent(h)}`;
}

// Convenience for the public-page render: takes a row with the four owner
// handles + the invoice's amount + number, returns the three universal-
// link URLs and the Zelle surface descriptor (each value can be null when
// the handle isn't set). Lets the template iterate once instead of four
// independent `<% if %>` blocks. `currency` is threaded into the PayPal
// URL builder only — Venmo and Cash App deep-links don't accept a
// currency parameter (both are USD-only in practice).
function buildPayLinks({ venmo, cashapp, paypal, zelle, amount, invoiceNumber, currency }) {
  return {
    venmo: venmoPayUrl({ handle: venmo, amount, invoiceNumber }),
    cashapp: cashappPayUrl({ handle: cashapp, amount }),
    paypal: paypalPayUrl({ handle: paypal, amount, currency }),
    zelle: buildZelleSurface({ handle: zelle })
  };
}

module.exports = {
  normalizeVenmoHandle,
  normalizeCashappHandle,
  normalizePaypalHandle,
  normalizeZelleHandle,
  venmoPayUrl,
  cashappPayUrl,
  paypalPayUrl,
  buildZelleSurface,
  buildPayLinks,
  formatAmount,
  stripUrlChrome
};
