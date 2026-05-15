'use strict';

/*
 * Public invoice share link helper (#43). The Pro/Agency "Share link" button
 * on the invoice view surfaces a tokenized /i/<token> URL the freelancer can
 * paste into an email or DM so the client views the invoice (and the Stripe
 * payment link) without needing a DecentInvoice account.
 *
 * APP_URL drives the absolute origin in production; when unset (dev / tests)
 * the helper falls back to a relative path so a render still produces a
 * clickable link.
 */

const PUBLIC_TOKEN_PATH = '/i/';
const TOKEN_REGEX = /^[a-f0-9]{8,32}$/i;

function buildPublicInvoiceUrl(token) {
  if (!token || typeof token !== 'string') return '';
  const trimmed = token.trim();
  if (!TOKEN_REGEX.test(trimmed)) return '';
  const base = (process.env.APP_URL || '').replace(/\/+$/, '');
  return base ? `${base}${PUBLIC_TOKEN_PATH}${trimmed}` : `${PUBLIC_TOKEN_PATH}${trimmed}`;
}

function isValidPublicToken(token) {
  return typeof token === 'string' && TOKEN_REGEX.test(token.trim());
}

module.exports = {
  buildPublicInvoiceUrl,
  isValidPublicToken,
  PUBLIC_TOKEN_PATH,
  TOKEN_REGEX
};
