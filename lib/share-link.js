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

/*
 * One-tap share-intent URLs for the public /i/<token> invoice page —
 * WhatsApp / SMS / mailto: deep-links that open the user's native compose
 * window with the body + URL pre-filled. Mirrors the Pro pay-link share
 * intents on `views/invoice-view.ejs` (lines 263-285) but pivots on the
 * tokenized public page instead of the Stripe payment link, so the free
 * tier — which has no pay-link — also gets the friction-collapse on
 * milestones 3-4 (created → sent → paid). Returns null if no URL is given
 * so the route can gate the response shape without throwing.
 */
function buildPublicShareIntents(opts) {
  if (!opts || typeof opts !== 'object') return null;
  const { invoiceNumber, total, clientName, clientEmail, url } = opts;
  if (!url || typeof url !== 'string') return null;
  const num = invoiceNumber ? String(invoiceNumber) : '';
  const amount = (() => {
    const n = Number(total);
    if (!Number.isFinite(n)) return '';
    return '$' + n.toFixed(2);
  })();
  const greeting = clientName ? `Hi ${clientName},` : 'Hi,';
  const facts = [];
  if (num) facts.push(`invoice ${num}`);
  if (amount) facts.push(`for ${amount}`);
  const factLine = facts.length ? `here's ${facts.join(' ')}` : "here's your invoice";
  // Body kept short to fit the SMS 160-char preview window; URL is last so
  // a truncated SMS preview still surfaces the click target.
  const body = `${greeting} ${factLine}. View it here: ${url}`;
  const subject = num ? `Invoice ${num}${amount ? ' — ' + amount : ''}` : 'Your invoice';
  // Percent-encode the mailto recipient (same defence as the Pro pay-link
  // path on `views/invoice-view.ejs` line 282): a malformed client_email
  // containing `?` or `&` could otherwise inject extra mailto: query
  // params (e.g. silent CC to a third party from the user's mail client).
  const safeRecipient = clientEmail ? encodeURIComponent(clientEmail) : '';
  return {
    body,
    subject,
    whatsapp: `https://wa.me/?text=${encodeURIComponent(body)}`,
    sms: `sms:?&body=${encodeURIComponent(body)}`,
    mailto: `mailto:${safeRecipient}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
  };
}

module.exports = {
  buildPublicInvoiceUrl,
  isValidPublicToken,
  buildPublicShareIntents,
  PUBLIC_TOKEN_PATH,
  TOKEN_REGEX
};
