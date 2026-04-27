'use strict';

/*
 * Shared HTML/format helpers used across email-render code paths.
 *
 * Promoted from byte-identical (or near-identical) copies in
 * lib/email.js, jobs/reminders.js, and jobs/trial-nudge.js so that a future
 * change to escaping or money formatting lands once instead of drifting.
 *
 * Pure functions only — no IO, no module state. Safe to require from any
 * layer.
 */

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const CURRENCY_SYMBOLS = {
  usd: '$',
  eur: '€',
  gbp: '£',
  cad: 'CA$',
  aud: 'A$',
  chf: 'CHF ',
  jpy: '¥',
  nzd: 'NZ$'
};

function formatMoney(amount, currency) {
  const code = (currency || 'usd').toLowerCase();
  const symbol = Object.prototype.hasOwnProperty.call(CURRENCY_SYMBOLS, code)
    ? CURRENCY_SYMBOLS[code]
    : '';
  const num = Number(amount);
  if (!Number.isFinite(num)) return `${symbol}0.00`;
  return `${symbol}${num.toFixed(2)}`;
}

module.exports = {
  escapeHtml,
  formatMoney,
  CURRENCY_SYMBOLS
};
