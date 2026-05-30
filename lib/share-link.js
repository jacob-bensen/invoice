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

const { normalizeClientPhone, formatForSms, formatForWhatsApp } = require('./phone');

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
  const { invoiceNumber, total, clientName, clientEmail, clientPhone, url } = opts;
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
  // Pre-fill the SMS / WhatsApp recipient when the freelancer captured a
  // phone for this client (Milestone 3 — created → sent). Normalised through
  // the same whitelist on every call so a malformed DB value or a forged
  // payload can never inject anything past digits + a leading "+". A null
  // result leaves the recipient slot empty (same shape as before — the
  // native app prompts for a contact).
  const phone = normalizeClientPhone(clientPhone);
  const smsRecipient = phone ? formatForSms(phone) : '';
  const waRecipient = phone ? formatForWhatsApp(phone) : '';
  return {
    body,
    subject,
    whatsapp: `https://wa.me/${waRecipient}?text=${encodeURIComponent(body)}`,
    sms: `sms:${smsRecipient}?&body=${encodeURIComponent(body)}`,
    mailto: `mailto:${safeRecipient}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
  };
}

/*
 * Follow-up share-intent URLs (Milestone 4 — first sent → first payment).
 * Counterpart to buildPublicShareIntents for the case where the freelancer
 * already shared the invoice once (status='sent' or 'overdue') and wants to
 * nudge the client. The pivot is the message body: instead of "here's
 * invoice X" the body reads as a polite check-in that doesn't assume the
 * recipient missed the original — common-cause failure mode is "I saw it
 * but forgot", not "I never got it", so the copy avoids accusation.
 *
 * `daysOverdue` (optional, number) softens the wording further when the
 * invoice is past due, surfacing "now overdue" without naming a specific
 * number of days. Callers compute it from (now - due_date). Negative or
 * zero values are treated as "not overdue" — same body shape as the
 * pre-due-date nudge.
 *
 * Returns null if no `url` is given so the route can gate the response
 * shape without throwing.
 */
function buildFollowUpShareIntents(opts) {
  if (!opts || typeof opts !== 'object') return null;
  const { invoiceNumber, total, clientName, clientEmail, clientPhone, url, daysOverdue } = opts;
  if (!url || typeof url !== 'string') return null;
  const num = invoiceNumber ? String(invoiceNumber) : '';
  const amount = (() => {
    const n = Number(total);
    if (!Number.isFinite(n)) return '';
    return '$' + n.toFixed(2);
  })();
  const greeting = clientName ? `Hi ${clientName},` : 'Hi,';
  const overdueDays = Number(daysOverdue);
  const isOverdue = Number.isFinite(overdueDays) && overdueDays > 0;
  const noun = num ? `invoice ${num}` : 'the invoice I sent';
  const amountClause = amount ? ` for ${amount}` : '';
  const statusClause = isOverdue ? ' (now overdue)' : '';
  // Body kept short to fit the SMS 160-char preview window; URL is last so
  // a truncated SMS preview still surfaces the click target.
  const body = `${greeting} just checking in on ${noun}${amountClause}${statusClause}. Let me know if you have any questions: ${url}`;
  const subject = num
    ? (isOverdue
        ? `Reminder: Invoice ${num}${amount ? ' — ' + amount : ''} is overdue`
        : `Quick check-in: Invoice ${num}${amount ? ' — ' + amount : ''}`)
    : (isOverdue ? 'Reminder: invoice overdue' : 'Quick check-in on your invoice');
  // Same percent-encoding defence as buildPublicShareIntents — a malformed
  // client_email like `victim@x.com?cc=attacker@evil.com` must not be able
  // to inject extra mailto: query params from the user's mail client.
  const safeRecipient = clientEmail ? encodeURIComponent(clientEmail) : '';
  // Same phone pre-fill behaviour as the first-send intents. A client we've
  // already sent to almost certainly has a stored phone (the original send
  // captured it), so the follow-up's SMS / WhatsApp links are usually fully
  // pre-filled — one tap from "Send reminder" to a delivered message.
  const phone = normalizeClientPhone(clientPhone);
  const smsRecipient = phone ? formatForSms(phone) : '';
  const waRecipient = phone ? formatForWhatsApp(phone) : '';
  return {
    body,
    subject,
    overdue: isOverdue,
    whatsapp: `https://wa.me/${waRecipient}?text=${encodeURIComponent(body)}`,
    sms: `sms:${smsRecipient}?&body=${encodeURIComponent(body)}`,
    mailto: `mailto:${safeRecipient}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
  };
}

/*
 * One-call helper used by both POST /invoices/:id/share AND the GET
 * /invoices/:id prefetch path. Takes an invoice row that already has a
 * `public_token` and returns the same `{ url, shareIntents, followUpIntents }`
 * shape the JSON response carries — keeps the encoding contract a single
 * source of truth so the prefetched render and the (legacy) fetch-on-click
 * path produce byte-identical share intents.
 *
 * Returns null when the token is missing or syntactically bad (so an
 * invoice without a minted token short-circuits cleanly).
 *
 * `now` (optional Date) is the clock used to compute `daysOverdue` from
 * invoice.due_date — passed through so callers in the route layer can keep
 * their per-request determinism and tests can pin the clock.
 */
function buildShareSurfaceForInvoice(invoice, opts) {
  if (!invoice || typeof invoice !== 'object') return null;
  const token = invoice.public_token;
  if (!isValidPublicToken(token)) return null;
  const url = buildPublicInvoiceUrl(token);
  if (!url) return null;
  const shareIntents = buildPublicShareIntents({
    invoiceNumber: invoice.invoice_number,
    total: invoice.total,
    clientName: invoice.client_name,
    clientEmail: invoice.client_email,
    clientPhone: invoice.client_phone,
    url
  });
  const now = (opts && opts.now instanceof Date) ? opts.now : new Date();
  const dueDate = invoice.due_date ? new Date(invoice.due_date) : null;
  const daysOverdue = (dueDate && Number.isFinite(dueDate.getTime()))
    ? Math.floor((now.getTime() - dueDate.getTime()) / 86400000)
    : 0;
  const followUpIntents = buildFollowUpShareIntents({
    invoiceNumber: invoice.invoice_number,
    total: invoice.total,
    clientName: invoice.client_name,
    clientEmail: invoice.client_email,
    clientPhone: invoice.client_phone,
    url,
    daysOverdue
  });
  return { url, shareIntents, followUpIntents };
}

module.exports = {
  buildPublicInvoiceUrl,
  isValidPublicToken,
  buildPublicShareIntents,
  buildFollowUpShareIntents,
  buildShareSurfaceForInvoice,
  PUBLIC_TOKEN_PATH,
  TOKEN_REGEX
};
