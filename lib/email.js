'use strict';

/*
 * Transactional email wrapper around Resend (https://resend.com).
 *
 * Design goals:
 *   - Graceful degradation. If RESEND_API_KEY is unset (local dev, or before
 *     Master provisions an API key in production), every send becomes a
 *     no-op that returns { ok: false, reason: 'not_configured' } instead of
 *     throwing. Callers should treat email as fire-and-forget.
 *   - Errors never bubble. Resend SDK rejections are caught and returned as
 *     { ok: false, reason: 'error', error }. The status-update redirect must
 *     not fail because SMTP is down.
 *   - Test seam. setResendClient(client) lets tests inject a fake without
 *     touching the network — same pattern as lib/outbound-webhook.js's
 *     setHostnameResolver.
 *   - Pure formatters. buildInvoiceHtml / buildInvoiceSubject are pure
 *     functions over (invoice, owner) so HTML and subject can be asserted
 *     in tests independently of the transport.
 */

let _client = null;
let _clientResolved = false;

function getClient() {
  if (_clientResolved) return _client;
  _clientResolved = true;
  if (!process.env.RESEND_API_KEY) {
    _client = null;
    return null;
  }
  try {
    const { Resend } = require('resend');
    _client = new Resend(process.env.RESEND_API_KEY);
  } catch (err) {
    console.error('Resend SDK init failed:', err && err.message);
    _client = null;
  }
  return _client;
}

// Test seam — inject a fake { emails: { send: async () => ({ data: { id } }) } }.
function setResendClient(client) {
  _client = client;
  _clientResolved = true;
}

function resetResendClient() {
  _client = null;
  _clientResolved = false;
}

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatMoney(amount, currency) {
  const code = (currency || 'usd').toLowerCase();
  const symbols = { usd: '$', eur: '€', gbp: '£', cad: 'CA$', aud: 'A$', chf: 'CHF ', jpy: '¥', nzd: 'NZ$' };
  const symbol = symbols[code] || '';
  const num = Number(amount);
  if (!Number.isFinite(num)) return `${symbol}0.00`;
  return `${symbol}${num.toFixed(2)}`;
}

function senderName(owner) {
  return (owner && (owner.business_name || owner.name || owner.business_email || owner.email)) || 'QuickInvoice';
}

function buildInvoiceSubject(invoice, owner) {
  const number = (invoice && invoice.invoice_number) || 'invoice';
  const from = senderName(owner);
  return `Invoice ${number} from ${from}`;
}

function buildInvoiceHtml(invoice, owner) {
  const number = invoice.invoice_number || '';
  const from = senderName(owner);
  const total = formatMoney(invoice.total, invoice.currency);
  const due = invoice.due_date ? new Date(invoice.due_date).toISOString().slice(0, 10) : '';
  const clientName = invoice.client_name || 'there';
  const payUrl = invoice.payment_link_url || '';

  let items = [];
  if (Array.isArray(invoice.items)) {
    items = invoice.items;
  } else if (typeof invoice.items === 'string') {
    try { items = JSON.parse(invoice.items) || []; } catch (_) { items = []; }
  }

  const itemRows = items.slice(0, 50).map(it => {
    const desc = escapeHtml(it && it.description ? it.description : '');
    const qty = escapeHtml(it && it.quantity != null ? it.quantity : '');
    const unit = formatMoney(it && it.unit_price, invoice.currency);
    const lineTotal = formatMoney(
      Number(it && it.quantity) * Number(it && it.unit_price),
      invoice.currency
    );
    return `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;">${desc}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">${qty}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">${escapeHtml(unit)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">${escapeHtml(lineTotal)}</td>
    </tr>`;
  }).join('');

  const payButton = payUrl
    ? `<p style="margin:24px 0;"><a href="${escapeHtml(payUrl)}" style="background:#4f46e5;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px;display:inline-block;">Pay invoice ${escapeHtml(number)}</a></p>`
    : '';

  const dueLine = due
    ? `<p style="color:#555;margin:4px 0;">Due <strong>${escapeHtml(due)}</strong>.</p>`
    : '';

  return `<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#222;background:#f7f7f9;margin:0;padding:24px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #eaeaea;">
  <tr><td style="padding:24px 28px;">
    <h2 style="margin:0 0 8px 0;color:#111;">Invoice ${escapeHtml(number)}</h2>
    <p style="color:#555;margin:4px 0;">From <strong>${escapeHtml(from)}</strong></p>
    <p style="color:#555;margin:16px 0 4px 0;">Hi ${escapeHtml(clientName)},</p>
    <p style="color:#555;margin:4px 0 16px 0;">Please find your invoice below. Total amount: <strong>${escapeHtml(total)}</strong>.</p>
    ${dueLine}
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:16px 0;border-top:1px solid #eee;">
      <thead>
        <tr style="background:#fafafa;">
          <th align="left" style="padding:8px 12px;border-bottom:1px solid #eee;font-size:12px;color:#888;text-transform:uppercase;">Item</th>
          <th align="right" style="padding:8px 12px;border-bottom:1px solid #eee;font-size:12px;color:#888;text-transform:uppercase;">Qty</th>
          <th align="right" style="padding:8px 12px;border-bottom:1px solid #eee;font-size:12px;color:#888;text-transform:uppercase;">Unit</th>
          <th align="right" style="padding:8px 12px;border-bottom:1px solid #eee;font-size:12px;color:#888;text-transform:uppercase;">Total</th>
        </tr>
      </thead>
      <tbody>${itemRows}</tbody>
      <tfoot>
        <tr><td colspan="3" align="right" style="padding:12px;font-weight:600;">Total</td>
        <td align="right" style="padding:12px;font-weight:600;">${escapeHtml(total)}</td></tr>
      </tfoot>
    </table>
    ${payButton}
    <p style="color:#999;font-size:12px;margin-top:24px;">Sent via QuickInvoice. Reply to this email to reach ${escapeHtml(from)} directly.</p>
  </td></tr>
</table>
</body></html>`;
}

function buildInvoiceText(invoice, owner) {
  const number = invoice.invoice_number || '';
  const from = senderName(owner);
  const total = formatMoney(invoice.total, invoice.currency);
  const payUrl = invoice.payment_link_url || '';
  const due = invoice.due_date ? new Date(invoice.due_date).toISOString().slice(0, 10) : '';
  const lines = [
    `Invoice ${number} from ${from}`,
    `Total: ${total}`
  ];
  if (due) lines.push(`Due: ${due}`);
  if (payUrl) lines.push(`Pay online: ${payUrl}`);
  lines.push('', `Reply to this email to reach ${from}.`);
  return lines.join('\n');
}

function resolveReplyTo(owner) {
  if (!owner) return null;
  return owner.reply_to_email || owner.business_email || owner.email || null;
}

function resolveFrom(owner) {
  if (process.env.EMAIL_FROM) return process.env.EMAIL_FROM;
  // Resend requires a verified sending domain; fall back to the no-reply
  // helper they keep registered for sandbox/dev accounts.
  return 'QuickInvoice <onboarding@resend.dev>';
}

async function sendEmail({ to, subject, html, text, replyTo, from } = {}) {
  if (!to || !subject || (!html && !text)) {
    return { ok: false, reason: 'invalid_args' };
  }
  const client = getClient();
  if (!client) {
    return { ok: false, reason: 'not_configured' };
  }
  try {
    const payload = {
      from: from || resolveFrom(),
      to: Array.isArray(to) ? to : [to],
      subject,
      html: html || undefined,
      text: text || undefined
    };
    if (replyTo) payload.reply_to = replyTo;
    const result = await client.emails.send(payload);
    if (result && result.error) {
      console.error('Resend send error:', result.error);
      return { ok: false, reason: 'error', error: result.error };
    }
    const id = (result && result.data && result.data.id) || (result && result.id) || null;
    return { ok: true, id };
  } catch (err) {
    console.error('Resend send threw:', err && err.message);
    return { ok: false, reason: 'error', error: err && err.message };
  }
}

async function sendInvoiceEmail(invoice, owner) {
  if (!invoice || !invoice.client_email) {
    return { ok: false, reason: 'no_client_email' };
  }
  return sendEmail({
    to: invoice.client_email,
    subject: buildInvoiceSubject(invoice, owner),
    html: buildInvoiceHtml(invoice, owner),
    text: buildInvoiceText(invoice, owner),
    replyTo: resolveReplyTo(owner)
  });
}

/*
 * Paid-notification email — the "cha-ching" moment. Fired the instant a
 * client completes a Stripe Payment Link checkout for one of the
 * freelancer's invoices. Recipient is the freelancer (invoice owner), not
 * the client — this is the freelancer-facing notification that drives the
 * emotional resonance of "I just got paid."
 */
function buildPaidNotificationSubject(invoice) {
  const number = (invoice && invoice.invoice_number) || 'invoice';
  const total = formatMoney(invoice && invoice.total, invoice && invoice.currency);
  return `Invoice ${number} was just paid — ${total}`;
}

function ownerInvoiceUrl(invoice) {
  const base = (process.env.APP_URL || '').replace(/\/+$/, '');
  if (!base || !invoice || invoice.id == null) return '';
  return `${base}/invoices/${invoice.id}`;
}

function buildPaidNotificationHtml(invoice, owner) {
  const number = invoice.invoice_number || '';
  const total = formatMoney(invoice.total, invoice.currency);
  const clientName = invoice.client_name || 'Your client';
  const ownerFirstName = owner && (owner.name || owner.business_name) || 'there';
  const url = ownerInvoiceUrl(invoice);
  const viewButton = url
    ? `<p style="margin:24px 0;"><a href="${escapeHtml(url)}" style="background:#16a34a;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px;display:inline-block;">View invoice ${escapeHtml(number)}</a></p>`
    : '';
  return `<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#222;background:#f7f7f9;margin:0;padding:24px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #eaeaea;">
  <tr><td style="padding:24px 28px;">
    <h2 style="margin:0 0 8px 0;color:#16a34a;">You just got paid</h2>
    <p style="color:#222;margin:8px 0;font-size:16px;">Hi ${escapeHtml(ownerFirstName)},</p>
    <p style="color:#222;margin:8px 0;font-size:16px;">Great news — <strong>${escapeHtml(clientName)}</strong> just paid invoice <strong>${escapeHtml(number)}</strong> for <strong>${escapeHtml(total)}</strong>.</p>
    ${viewButton}
    <p style="color:#999;font-size:12px;margin-top:24px;">Sent automatically by QuickInvoice the moment your client's payment cleared via Stripe.</p>
  </td></tr>
</table>
</body></html>`;
}

function buildPaidNotificationText(invoice) {
  const number = invoice.invoice_number || '';
  const total = formatMoney(invoice.total, invoice.currency);
  const clientName = invoice.client_name || 'Your client';
  const url = ownerInvoiceUrl(invoice);
  const lines = [
    `You just got paid.`,
    ``,
    `${clientName} paid invoice ${number} for ${total}.`
  ];
  if (url) {
    lines.push('', `View invoice: ${url}`);
  }
  return lines.join('\n');
}

async function sendPaidNotificationEmail(invoice, owner) {
  if (!invoice || !owner) return { ok: false, reason: 'invalid_args' };
  const to = owner.email;
  if (!to) return { ok: false, reason: 'no_owner_email' };
  return sendEmail({
    to,
    subject: buildPaidNotificationSubject(invoice),
    html: buildPaidNotificationHtml(invoice, owner),
    text: buildPaidNotificationText(invoice),
    replyTo: resolveReplyTo(owner)
  });
}

module.exports = {
  sendEmail,
  sendInvoiceEmail,
  sendPaidNotificationEmail,
  buildInvoiceSubject,
  buildInvoiceHtml,
  buildInvoiceText,
  buildPaidNotificationSubject,
  buildPaidNotificationHtml,
  buildPaidNotificationText,
  resolveReplyTo,
  resolveFrom,
  setResendClient,
  resetResendClient,
  // Exported for unit tests; not part of the stable public API.
  _internal: { escapeHtml, formatMoney, senderName }
};
