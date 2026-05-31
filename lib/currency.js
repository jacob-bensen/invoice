'use strict';

/*
 * Per-user / per-invoice currency support. Every consumer that renders a
 * money amount — the public /i/<token> share page (line items, subtotal,
 * tax, total, Stripe Pay CTA, Zelle hint, "Pay with X" buttons) and the
 * PayPal.me deep-link suffix — reads through `resolveInvoiceCurrency()`
 * and `formatMoney()` so a single source of truth controls the symbol +
 * formatting across the codebase. The eight supported ISO-4217 codes match
 * the symbol map in `lib/html.js#CURRENCY_SYMBOLS`; adding a code here
 * requires adding the symbol there.
 *
 * Three pure functions, no I/O, no DB coupling — safe to require from any
 * layer (route handler, EJS view via render local, test).
 */

const { CURRENCY_SYMBOLS, formatMoney } = require('./html');

const SUPPORTED_CURRENCIES = Object.freeze([
  Object.freeze({ code: 'USD', symbol: '$',    label: 'US Dollar (USD $)' }),
  Object.freeze({ code: 'EUR', symbol: '€',    label: 'Euro (EUR €)' }),
  Object.freeze({ code: 'GBP', symbol: '£',    label: 'British Pound (GBP £)' }),
  Object.freeze({ code: 'CAD', symbol: 'CA$',  label: 'Canadian Dollar (CAD CA$)' }),
  Object.freeze({ code: 'AUD', symbol: 'A$',   label: 'Australian Dollar (AUD A$)' }),
  Object.freeze({ code: 'NZD', symbol: 'NZ$',  label: 'New Zealand Dollar (NZD NZ$)' }),
  Object.freeze({ code: 'CHF', symbol: 'CHF ', label: 'Swiss Franc (CHF)' }),
  Object.freeze({ code: 'JPY', symbol: '¥',    label: 'Japanese Yen (JPY ¥)' })
]);

const SUPPORTED_CODE_SET = new Set(SUPPORTED_CURRENCIES.map((c) => c.code));

const DEFAULT_CURRENCY = 'USD';

// Accept either case, strip whitespace, validate against the whitelist.
// Returns the canonical uppercase code or null when the input isn't a
// supported currency. NULL / non-string / unknown code all collapse to
// null so the resolver can fall through to the next source.
function normalizeCurrencyCode(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toUpperCase();
  if (!trimmed) return null;
  return SUPPORTED_CODE_SET.has(trimmed) ? trimmed : null;
}

// Precedence — invoice's own `currency` override wins (reserved for a
// future per-invoice picker), else the owner's stored default, else the
// global default USD. Accepts `owner_default_currency` directly on the
// invoice row (the shape `db.getInvoiceByPublicToken` projects) so the
// public-page caller doesn't have to thread two arguments.
function resolveInvoiceCurrency(invoice, owner) {
  if (invoice && typeof invoice === 'object') {
    const fromInvoice = normalizeCurrencyCode(invoice.currency);
    if (fromInvoice) return fromInvoice;
    const fromInvoiceOwner = normalizeCurrencyCode(invoice.owner_default_currency);
    if (fromInvoiceOwner) return fromInvoiceOwner;
  }
  if (owner && typeof owner === 'object') {
    const fromOwner = normalizeCurrencyCode(owner.default_currency);
    if (fromOwner) return fromOwner;
  }
  return DEFAULT_CURRENCY;
}

// Resolve the user-facing symbol for an already-normalised currency code.
// Falls back to '$' for an unknown code so an owner-side render never
// produces a symbol-less amount on a future code that ships in the DB
// before the symbol map is updated.
function getCurrencySymbol(code) {
  if (typeof code !== 'string') return '$';
  const lower = code.trim().toLowerCase();
  if (!lower) return '$';
  return Object.prototype.hasOwnProperty.call(CURRENCY_SYMBOLS, lower)
    ? CURRENCY_SYMBOLS[lower]
    : '$';
}

module.exports = {
  SUPPORTED_CURRENCIES,
  SUPPORTED_CODE_SET,
  DEFAULT_CURRENCY,
  normalizeCurrencyCode,
  resolveInvoiceCurrency,
  formatMoney,
  getCurrencySymbol,
  CURRENCY_SYMBOLS
};
