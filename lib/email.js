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

const { escapeHtml, formatMoney } = require('./html');

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

function senderName(owner) {
  return (owner && (owner.business_name || owner.name || owner.business_email || owner.email)) || 'DecentInvoice';
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
    <p style="color:#999;font-size:12px;margin-top:24px;">Sent via DecentInvoice. Reply to this email to reach ${escapeHtml(from)} directly.</p>
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
  return 'DecentInvoice <onboarding@resend.dev>';
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
    <p style="color:#999;font-size:12px;margin-top:24px;">Sent automatically by DecentInvoice the moment your client's payment cleared via Stripe.</p>
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

/*
 * Paid-receipt email to the CLIENT (Milestone 4 — close-the-loop). Fires
 * the moment an invoice flips to paid, whether via the freelancer's manual
 * Mark-as-Paid action or a Stripe Payment Link webhook. Closes the silent
 * "did they actually receive my money?" gap — without this the client only
 * sees the new status if they happen to revisit the /i/<token> share page.
 *
 * Recipient is the CLIENT, not the freelancer (that's sendPaidNotificationEmail).
 * reply-to points back at the freelancer so a client reply lands in the
 * freelancer's inbox. The body builds trust (formal confirmation), drives
 * repeat-business momentum (the freelancer's name + business front-and-centre),
 * and offers the public /i/<token> share URL as a permanent record.
 *
 * Idempotency is enforced at the DB layer via markClientPaidReceiptSent; this
 * function is pure email — it sends every time it's called. Callers must
 * stamp first (or after a successful send, to avoid stamping on send-fail).
 */
function buildPaidReceiptSubject(invoice) {
  const number = (invoice && invoice.invoice_number) || 'invoice';
  return `Paid: Invoice ${number} — thank you`;
}

function publicInvoiceUrl(invoice) {
  if (!invoice || !invoice.public_token) return '';
  const base = (process.env.APP_URL || '').replace(/\/+$/, '');
  if (!base) return '';
  return `${base}/i/${invoice.public_token}`;
}

function buildPaidReceiptHtml(invoice, owner) {
  const number = (invoice && invoice.invoice_number) || '';
  const total = formatMoney(invoice && invoice.total, invoice && invoice.currency);
  const clientName = (invoice && invoice.client_name) || 'there';
  const sender = senderName(owner);
  const url = publicInvoiceUrl(invoice);
  const viewButton = url
    ? `<p style="margin:24px 0;"><a href="${escapeHtml(url)}" style="background:#16a34a;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px;display:inline-block;">View receipt</a></p>`
    : '';
  return `<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#222;background:#f7f7f9;margin:0;padding:24px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #eaeaea;">
  <tr><td style="padding:24px 28px;">
    <h2 style="margin:0 0 8px 0;color:#16a34a;">Paid — thank you</h2>
    <p style="color:#222;margin:8px 0;font-size:16px;">Hi ${escapeHtml(clientName)},</p>
    <p style="color:#222;margin:8px 0;font-size:16px;">This is a confirmation that <strong>${escapeHtml(sender)}</strong> has marked invoice <strong>${escapeHtml(number)}</strong> for <strong>${escapeHtml(total)}</strong> as paid. Thanks for the prompt settlement.</p>
    ${viewButton}
    <p style="color:#555;font-size:13px;margin:16px 0 0 0;">Keep this email for your records. The invoice page above will continue to show the paid status if you need to revisit it.</p>
    <p style="color:#999;font-size:12px;margin-top:24px;">Sent automatically by DecentInvoice on behalf of ${escapeHtml(sender)}. Reply to this email to reach them directly.</p>
  </td></tr>
</table>
</body></html>`;
}

function buildPaidReceiptText(invoice, owner) {
  const number = (invoice && invoice.invoice_number) || '';
  const total = formatMoney(invoice && invoice.total, invoice && invoice.currency);
  const clientName = (invoice && invoice.client_name) || 'there';
  const sender = senderName(owner);
  const url = publicInvoiceUrl(invoice);
  const lines = [
    `Hi ${clientName},`,
    '',
    `This is a confirmation that ${sender} has marked invoice ${number} for ${total} as paid. Thanks for the prompt settlement.`
  ];
  if (url) lines.push('', `View receipt: ${url}`);
  lines.push('', `Sent automatically by DecentInvoice on behalf of ${sender}. Reply to this email to reach them directly.`);
  return lines.join('\n');
}

async function sendPaidReceiptEmail(invoice, owner) {
  if (!invoice || !owner) return { ok: false, reason: 'invalid_args' };
  const to = invoice.client_email;
  if (!to) return { ok: false, reason: 'no_client_email' };
  return sendEmail({
    to,
    subject: buildPaidReceiptSubject(invoice),
    html: buildPaidReceiptHtml(invoice, owner),
    text: buildPaidReceiptText(invoice, owner),
    replyTo: resolveReplyTo(owner)
  });
}

/*
 * First-paid celebration + referral email (#49). Sent once per user the
 * moment their first invoice flips to paid. Rides the dopamine of "I just
 * got paid" to turn the freelancer into a referrer — the referral link
 * embeds their unique code so we can attribute new signups arriving via
 * `?ref=<code>` back to them. The body promises a free Pro month to both
 * sides; the actual coupon mechanism is provisioned by the operator (see
 * MASTER_ACTIONS.md → Stripe configuration) and the cookie attribution +
 * referral_code generation is already wired here, so once the coupon is
 * created and `STRIPE_REFERRAL_COUPON_ID` is set, the loop closes without
 * a code change to this surface.
 */
function buildReferralCelebrationSubject() {
  return 'You just got paid — share DecentInvoice, get a free month';
}

function buildReferralCelebrationHtml(owner, referralUrl) {
  const firstName = owner && (owner.name || owner.business_name) || 'there';
  const url = referralUrl || '';
  const button = url
    ? `<p style="margin:24px 0;"><a href="${escapeHtml(url)}" style="background:#16a34a;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px;display:inline-block;">Share your referral link</a></p>`
    : '';
  return `<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#222;background:#f7f7f9;margin:0;padding:24px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #eaeaea;">
  <tr><td style="padding:24px 28px;">
    <h2 style="margin:0 0 8px 0;color:#16a34a;">You just got paid 🎉</h2>
    <p style="color:#222;margin:8px 0;font-size:16px;">Hi ${escapeHtml(firstName)},</p>
    <p style="color:#222;margin:8px 0;font-size:16px;">First paid invoice on DecentInvoice — that's the moment it stops being a side-project tool and starts being part of how you get paid.</p>
    <p style="color:#222;margin:8px 0;font-size:16px;">Know another freelancer who'd benefit? Share your link below — when they sign up, <strong>both of you get a free month of Pro</strong>.</p>
    ${button}
    ${url ? `<p style="color:#555;font-size:13px;margin:8px 0;word-break:break-all;">Or copy this link: <code style="background:#f3f4f6;padding:2px 6px;border-radius:4px;">${escapeHtml(url)}</code></p>` : ''}
    <p style="color:#999;font-size:12px;margin-top:24px;">You'll see this celebration on your dashboard for the next 7 days.</p>
  </td></tr>
</table>
</body></html>`;
}

function buildReferralCelebrationText(owner, referralUrl) {
  const firstName = owner && (owner.name || owner.business_name) || 'there';
  const url = referralUrl || '';
  const lines = [
    `Hi ${firstName},`,
    '',
    'You just got paid on DecentInvoice — congrats on the first one.',
    '',
    'Know another freelancer who\'d benefit? Share your link below.',
    'When they sign up, both of you get a free month of Pro.'
  ];
  if (url) lines.push('', url);
  return lines.join('\n');
}

async function sendReferralCelebrationEmail(owner, referralUrl) {
  if (!owner || !owner.email) return { ok: false, reason: 'no_owner_email' };
  return sendEmail({
    to: owner.email,
    subject: buildReferralCelebrationSubject(),
    html: buildReferralCelebrationHtml(owner, referralUrl),
    text: buildReferralCelebrationText(owner, referralUrl),
    replyTo: resolveReplyTo(owner)
  });
}

/*
 * Welcome email — fires once at signup. Drives new users back into the app
 * to create their first real invoice (the activation gate that determines
 * whether any of the trial-conversion surfaces ever get a chance to fire).
 * Body surfaces the no-card 7-day Pro trial CTA so users who arrived
 * intending to try Pro features see the path immediately without having to
 * re-discover /pricing. The first-invoice CTA points at /invoices/quick (the
 * 3-field express form — client name + description + amount — which is the
 * lowest-friction Milestone 2 path; the seed invoice already lives on the
 * dashboard for users who click /invoices instead). APP_URL drives absolute
 * links; in dev when APP_URL is unset, the absolute URLs degrade to relative
 * paths that still resolve once the recipient opens them in a browser via
 * webmail.
 */
function buildWelcomeSubject(user) {
  const firstName = (user && (user.name || user.business_name) || '').trim();
  if (firstName) {
    return `Welcome to DecentInvoice, ${firstName} — your first invoice is one click away`;
  }
  return `Welcome to DecentInvoice — your first invoice is one click away`;
}

function welcomeUrls(opts) {
  const base = (process.env.APP_URL || '').replace(/\/+$/, '');
  const prefix = base || '';
  // When a one-shot magic-login URL is supplied (lib/welcome mints one per
  // signup), bake it into the activation CTAs so the click auto-signs-in and
  // lands at the target path via ?next=. Falls back to the plain APP_URL path
  // if no magic URL is available (mint failed, no DB, etc.) so the email is
  // still actionable — the user just has to authenticate manually first.
  const magicLoginUrl = opts && typeof opts.magicLoginUrl === 'string'
    ? opts.magicLoginUrl.trim() : '';
  const quickInvoiceDirect = `${prefix}/invoices/quick`;
  const pricingDirect = `${prefix}/billing/upgrade`;
  const dashboardDirect = `${prefix}/invoices`;
  return {
    newInvoice: magicLoginUrl
      ? `${magicLoginUrl}?next=/invoices/quick`
      : quickInvoiceDirect,
    pricing: magicLoginUrl
      ? `${magicLoginUrl}?next=/billing/upgrade`
      : pricingDirect,
    dashboard: dashboardDirect,
    // Keep the plain paths available too so the renderer can fall back to
    // them for visible link text / footer copy where appropriate.
    quickInvoiceDirect,
    pricingDirect,
    magicLoginUsed: Boolean(magicLoginUrl)
  };
}

function buildWelcomeHtml(user, opts) {
  const firstName = (user && (user.name || user.business_name) || 'there');
  const urls = welcomeUrls(opts);
  return `<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#222;background:#f7f7f9;margin:0;padding:24px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #eaeaea;">
  <tr><td style="padding:24px 28px;">
    <h2 style="margin:0 0 8px 0;color:#111;">Welcome, ${escapeHtml(firstName)} 👋</h2>
    <p style="color:#222;margin:8px 0;font-size:16px;">Thanks for signing up to DecentInvoice. You're set up to send professional invoices and get paid in one click.</p>
    <p style="color:#222;margin:16px 0 8px 0;font-size:16px;"><strong>Send your first invoice in 60 seconds</strong> — three fields (client, what you did, how much), one tap to share with your client. Your client gets a clean web invoice with a Stripe Pay button.</p>
    <p style="margin:24px 0;"><a href="${escapeHtml(urls.newInvoice)}" style="background:#4f46e5;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px;display:inline-block;">Create your first invoice →</a></p>
    <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
    <h3 style="margin:0 0 4px 0;color:#111;font-size:16px;">Want the Pro features?</h3>
    <p style="color:#555;margin:4px 0 8px 0;font-size:14px;">Pro unlocks unlimited invoices, Stripe Payment Links on every invoice, email-to-client sending, payment reminders, and Slack/Discord notifications. <strong>Start a 7-day free trial — no card required.</strong></p>
    <p style="margin:16px 0;"><a href="${escapeHtml(urls.pricing)}" style="background:#fff;color:#4f46e5;border:1px solid #4f46e5;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:8px;display:inline-block;">Start your free Pro trial</a></p>
    <p style="color:#999;font-size:12px;margin-top:24px;">Reply to this email if anything's unclear — we read every message.</p>
  </td></tr>
</table>
</body></html>`;
}

function buildWelcomeText(user, opts) {
  const firstName = (user && (user.name || user.business_name) || 'there');
  const urls = welcomeUrls(opts);
  return [
    `Hi ${firstName},`,
    '',
    'Thanks for signing up to DecentInvoice. You\'re set up to send professional invoices and get paid in one click.',
    '',
    'Send your first invoice in 60 seconds — three fields (client, what you did, how much), one tap to share with your client. Your client gets a clean web invoice with a Stripe Pay button.',
    '',
    `Create your first invoice: ${urls.newInvoice}`,
    '',
    'Want the Pro features? Pro unlocks unlimited invoices, Stripe Payment Links on every invoice, email-to-client sending, payment reminders, and Slack/Discord notifications.',
    '',
    `Start a 7-day free trial (no card required): ${urls.pricing}`,
    '',
    'Reply to this email if anything\'s unclear — we read every message.'
  ].join('\n');
}

/*
 * Password-reset / magic-link sign-in email (Milestone 1 — signup → first
 * dashboard re-entry). The login page's old "email support to reset" path
 * was a dead end for any user who lost their session — they bounced. This
 * email is the entire self-serve recovery surface: the reset URL is a
 * one-shot, time-boxed link that lets the recipient set a new password
 * (and is auto-logged-in on the same hop). resetUrl is built by the caller
 * with the raw (un-hashed) token; this builder only renders.
 */
function buildPasswordResetSubject() {
  return 'Reset your DecentInvoice password';
}

function buildPasswordResetHtml(user, resetUrl, ttlMinutes) {
  const firstName = (user && (user.name || user.business_name) || 'there');
  const url = resetUrl || '';
  const ttl = Number.isFinite(ttlMinutes) && ttlMinutes > 0 ? Math.floor(ttlMinutes) : 60;
  const button = url
    ? `<p style="margin:24px 0;"><a href="${escapeHtml(url)}" style="background:#4f46e5;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px;display:inline-block;">Reset your password</a></p>`
    : '';
  return `<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#222;background:#f7f7f9;margin:0;padding:24px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #eaeaea;">
  <tr><td style="padding:24px 28px;">
    <h2 style="margin:0 0 8px 0;color:#111;">Reset your password</h2>
    <p style="color:#222;margin:8px 0;font-size:16px;">Hi ${escapeHtml(firstName)},</p>
    <p style="color:#222;margin:8px 0;font-size:16px;">We received a request to reset the password for your DecentInvoice account. Click the button below to choose a new password — you'll be signed in straight away.</p>
    ${button}
    ${url ? `<p style="color:#555;font-size:13px;margin:8px 0;word-break:break-all;">Or copy this link into your browser: <code style="background:#f3f4f6;padding:2px 6px;border-radius:4px;">${escapeHtml(url)}</code></p>` : ''}
    <p style="color:#555;font-size:13px;margin:16px 0 4px 0;">This link expires in <strong>${ttl} minutes</strong> and can only be used once.</p>
    <p style="color:#999;font-size:12px;margin-top:24px;">If you didn't request this, you can safely ignore this email — your password won't change.</p>
  </td></tr>
</table>
</body></html>`;
}

function buildPasswordResetText(user, resetUrl, ttlMinutes) {
  const firstName = (user && (user.name || user.business_name) || 'there');
  const url = resetUrl || '';
  const ttl = Number.isFinite(ttlMinutes) && ttlMinutes > 0 ? Math.floor(ttlMinutes) : 60;
  const lines = [
    `Hi ${firstName},`,
    '',
    'We received a request to reset the password for your DecentInvoice account.',
    'Open the link below to choose a new password — you\'ll be signed in straight away.'
  ];
  if (url) lines.push('', url);
  lines.push('', `This link expires in ${ttl} minutes and can only be used once.`);
  lines.push('', 'If you didn\'t request this, you can ignore this email — your password won\'t change.');
  return lines.join('\n');
}

async function sendPasswordResetEmail(user, resetUrl, ttlMinutes) {
  if (!user || !user.email) return { ok: false, reason: 'no_recipient' };
  if (!resetUrl) return { ok: false, reason: 'no_reset_url' };
  return sendEmail({
    to: user.email,
    subject: buildPasswordResetSubject(),
    html: buildPasswordResetHtml(user, resetUrl, ttlMinutes),
    text: buildPasswordResetText(user, resetUrl, ttlMinutes),
    replyTo: resolveReplyTo(user)
  });
}

/*
 * Magic-link sign-in email (Milestone 1 — signup → first dashboard re-entry).
 * Counterpart to the password-reset email: one-tap re-entry to the seeded
 * dashboard with no password to type. The loginUrl resolves a single-use,
 * 30-minute token via GET /auth/magic/:token; the route consumes the token
 * atomically and writes the session. The user lands on /dashboard without
 * any intermediate password choice.
 */
function buildMagicLoginSubject() {
  return 'Your DecentInvoice sign-in link';
}

function buildMagicLoginHtml(user, loginUrl, ttlMinutes) {
  const firstName = (user && (user.name || user.business_name) || 'there');
  const url = loginUrl || '';
  const ttl = Number.isFinite(ttlMinutes) && ttlMinutes > 0 ? Math.floor(ttlMinutes) : 30;
  const button = url
    ? `<p style="margin:24px 0;"><a href="${escapeHtml(url)}" style="background:#4f46e5;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px;display:inline-block;">Sign in to DecentInvoice</a></p>`
    : '';
  return `<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#222;background:#f7f7f9;margin:0;padding:24px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #eaeaea;">
  <tr><td style="padding:24px 28px;">
    <h2 style="margin:0 0 8px 0;color:#111;">Sign in to DecentInvoice</h2>
    <p style="color:#222;margin:8px 0;font-size:16px;">Hi ${escapeHtml(firstName)},</p>
    <p style="color:#222;margin:8px 0;font-size:16px;">Click the button below to sign in. No password needed — you'll land straight on your dashboard.</p>
    ${button}
    ${url ? `<p style="color:#555;font-size:13px;margin:8px 0;word-break:break-all;">Or copy this link into your browser: <code style="background:#f3f4f6;padding:2px 6px;border-radius:4px;">${escapeHtml(url)}</code></p>` : ''}
    <p style="color:#555;font-size:13px;margin:16px 0 4px 0;">This link expires in <strong>${ttl} minutes</strong> and can only be used once.</p>
    <p style="color:#999;font-size:12px;margin-top:24px;">If you didn't request this, you can safely ignore this email — no one can sign in without clicking the link.</p>
  </td></tr>
</table>
</body></html>`;
}

function buildMagicLoginText(user, loginUrl, ttlMinutes) {
  const firstName = (user && (user.name || user.business_name) || 'there');
  const url = loginUrl || '';
  const ttl = Number.isFinite(ttlMinutes) && ttlMinutes > 0 ? Math.floor(ttlMinutes) : 30;
  const lines = [
    `Hi ${firstName},`,
    '',
    'Click the link below to sign in to DecentInvoice.',
    "No password needed — you'll land straight on your dashboard."
  ];
  if (url) lines.push('', url);
  lines.push('', `This link expires in ${ttl} minutes and can only be used once.`);
  lines.push('', "If you didn't request this, you can ignore this email — no one can sign in without clicking the link.");
  return lines.join('\n');
}

async function sendMagicLoginEmail(user, loginUrl, ttlMinutes) {
  if (!user || !user.email) return { ok: false, reason: 'no_recipient' };
  if (!loginUrl) return { ok: false, reason: 'no_login_url' };
  return sendEmail({
    to: user.email,
    subject: buildMagicLoginSubject(),
    html: buildMagicLoginHtml(user, loginUrl, ttlMinutes),
    text: buildMagicLoginText(user, loginUrl, ttlMinutes),
    replyTo: resolveReplyTo(user)
  });
}

async function sendWelcomeEmail(user, opts) {
  if (!user || !user.email) return { ok: false, reason: 'no_recipient' };
  return sendEmail({
    to: user.email,
    subject: buildWelcomeSubject(user),
    html: buildWelcomeHtml(user, opts),
    text: buildWelcomeText(user, opts),
    replyTo: resolveReplyTo(user)
  });
}

/*
 * Client-viewed notification (Milestone 4 — sent → paid). Fires once, the
 * moment a non-bot human first opens the freelancer's /i/<token> share link.
 * Recipient is the FREELANCER (invoice.owner_email), not the client. The
 * email pulls the freelancer back into the app at the moment of peak
 * payment-likelihood: the client has demonstrably opened the invoice and is
 * therefore deciding whether to pay it. A well-timed follow-up message
 * ("just checking you got my invoice — let me know if you have any
 * questions") at this exact instant lifts pay-through rates materially.
 *
 * The owner row carries the joined `owner_*` fields from
 * getInvoiceByPublicToken so the caller doesn't have to issue a second
 * query. resolveReplyTo handles the legacy `email`/`business_email`
 * /`reply_to_email` precedence — the join exposes `owner_reply_to_email`
 * so this builder reads it directly.
 */
function buildClientViewedSubject(invoice) {
  const number = (invoice && invoice.invoice_number) || 'invoice';
  const clientName = (invoice && invoice.client_name) || 'Your client';
  return `${clientName} just opened invoice ${number}`;
}

function buildClientViewedHtml(invoice, owner) {
  const number = (invoice && invoice.invoice_number) || '';
  const clientName = (invoice && invoice.client_name) || 'Your client';
  const total = formatMoney(invoice && invoice.total, invoice && invoice.currency);
  const ownerFirstName = (owner && (owner.name || owner.business_name)) || 'there';
  const url = ownerInvoiceUrl(invoice);
  const viewButton = url
    ? `<p style="margin:24px 0;"><a href="${escapeHtml(url)}" style="background:#4f46e5;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px;display:inline-block;">Send a follow-up →</a></p>`
    : '';
  return `<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#222;background:#f7f7f9;margin:0;padding:24px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #eaeaea;">
  <tr><td style="padding:24px 28px;">
    <h2 style="margin:0 0 8px 0;color:#111;">👀 Your client just opened your invoice</h2>
    <p style="color:#222;margin:8px 0;font-size:16px;">Hi ${escapeHtml(ownerFirstName)},</p>
    <p style="color:#222;margin:8px 0;font-size:16px;"><strong>${escapeHtml(clientName)}</strong> just opened invoice <strong>${escapeHtml(number)}</strong> for <strong>${escapeHtml(total)}</strong>.</p>
    <p style="color:#222;margin:8px 0;font-size:16px;">Now's a great moment to send a quick follow-up — a short "just checking you got this — let me know if you have any questions" lands far higher when the invoice is fresh in their inbox.</p>
    ${viewButton}
    <p style="color:#999;font-size:12px;margin-top:24px;">You'll only get this notification on the first open per invoice. Repeat opens still surface on your dashboard.</p>
  </td></tr>
</table>
</body></html>`;
}

function buildClientViewedText(invoice) {
  const number = (invoice && invoice.invoice_number) || '';
  const clientName = (invoice && invoice.client_name) || 'Your client';
  const total = formatMoney(invoice && invoice.total, invoice && invoice.currency);
  const url = ownerInvoiceUrl(invoice);
  const lines = [
    `Your client just opened your invoice.`,
    ``,
    `${clientName} opened invoice ${number} for ${total}.`,
    ``,
    `Now's a great moment to send a quick follow-up.`
  ];
  if (url) {
    lines.push('', `Open the invoice: ${url}`);
  }
  return lines.join('\n');
}

async function sendClientViewedEmail(invoice, owner) {
  if (!invoice || !owner) return { ok: false, reason: 'invalid_args' };
  const to = owner.email;
  if (!to) return { ok: false, reason: 'no_owner_email' };
  return sendEmail({
    to,
    subject: buildClientViewedSubject(invoice),
    html: buildClientViewedHtml(invoice, owner),
    text: buildClientViewedText(invoice),
    replyTo: resolveReplyTo(owner)
  });
}

/*
 * Payment-claim email (Milestone 4 — first invoice sent → first payment
 * received). Fires the moment a client clicks "I've sent payment" on the
 * public /i/<token> page. Recipient is the FREELANCER, not the client.
 * Closes the out-of-band payment loop: a free-tier user (no Stripe Payment
 * Link) gets pulled back into the app the instant their client claims to
 * have paid via Venmo/Zelle/wire/etc., where they can one-click Mark-as-Paid
 * after verifying the funds landed. The method + optional reference give the
 * freelancer everything they need to match the claim against their bank
 * statement / payment app.
 *
 * The label map is rendered verbatim — `method` is the small whitelist the
 * route enforces (cash|check|venmo|zelle|bank_transfer|paypal|other), so we
 * never see hostile input here. Reference and note are HTML-escaped on the
 * way through.
 */
const PAYMENT_METHOD_LABELS = {
  cash: 'Cash',
  check: 'Cheque / Check',
  venmo: 'Venmo',
  zelle: 'Zelle',
  bank_transfer: 'Bank transfer / ACH',
  paypal: 'PayPal',
  other: 'Other'
};

function paymentMethodLabel(method) {
  const key = (method || '').toString().trim().toLowerCase();
  return PAYMENT_METHOD_LABELS[key] || 'Other';
}

function buildPaymentClaimedSubject(invoice) {
  const number = (invoice && invoice.invoice_number) || 'invoice';
  const clientName = (invoice && invoice.client_name) || 'Your client';
  return `${clientName} reports payment sent for invoice ${number}`;
}

function buildPaymentClaimedHtml(invoice, owner, claim) {
  const number = (invoice && invoice.invoice_number) || '';
  const clientName = (invoice && invoice.client_name) || 'Your client';
  const total = formatMoney(invoice && invoice.total, invoice && invoice.currency);
  const ownerFirstName = (owner && (owner.name || owner.business_name)) || 'there';
  const method = paymentMethodLabel(claim && claim.method);
  const reference = (claim && claim.reference) ? String(claim.reference).slice(0, 200) : '';
  const note = (claim && claim.note) ? String(claim.note).slice(0, 1000) : '';
  const url = ownerInvoiceUrl(invoice);
  const viewButton = url
    ? `<p style="margin:24px 0;"><a href="${escapeHtml(url)}" style="background:#16a34a;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px;display:inline-block;">Confirm receipt &amp; mark paid &rarr;</a></p>`
    : '';
  const refLine = reference
    ? `<p style="color:#222;margin:8px 0;font-size:15px;"><strong>Reference:</strong> ${escapeHtml(reference)}</p>`
    : '';
  const noteLine = note
    ? `<p style="color:#555;margin:8px 0;font-size:14px;white-space:pre-line;border-left:3px solid #d1d5db;padding:4px 12px;">${escapeHtml(note)}</p>`
    : '';
  return `<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#222;background:#f7f7f9;margin:0;padding:24px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #eaeaea;">
  <tr><td style="padding:24px 28px;">
    <h2 style="margin:0 0 8px 0;color:#111;">💸 Your client reports payment sent</h2>
    <p style="color:#222;margin:8px 0;font-size:16px;">Hi ${escapeHtml(ownerFirstName)},</p>
    <p style="color:#222;margin:8px 0;font-size:16px;"><strong>${escapeHtml(clientName)}</strong> just reported sending payment for invoice <strong>${escapeHtml(number)}</strong> (<strong>${escapeHtml(total)}</strong>).</p>
    <p style="color:#222;margin:8px 0;font-size:15px;"><strong>Method:</strong> ${escapeHtml(method)}</p>
    ${refLine}
    ${noteLine}
    <p style="color:#555;margin:12px 0;font-size:14px;">Verify the funds landed in your account, then click below to mark the invoice paid in DecentInvoice — your client will see the &ldquo;Paid&rdquo; banner on their copy of the link.</p>
    ${viewButton}
    <p style="color:#999;font-size:12px;margin-top:24px;">DecentInvoice cannot verify whether the payment actually cleared — this is your client&rsquo;s self-report. Always confirm against your bank / payment app before marking the invoice paid.</p>
  </td></tr>
</table>
</body></html>`;
}

function buildPaymentClaimedText(invoice, owner, claim) {
  const number = (invoice && invoice.invoice_number) || '';
  const clientName = (invoice && invoice.client_name) || 'Your client';
  const total = formatMoney(invoice && invoice.total, invoice && invoice.currency);
  const method = paymentMethodLabel(claim && claim.method);
  const reference = (claim && claim.reference) ? String(claim.reference).slice(0, 200) : '';
  const note = (claim && claim.note) ? String(claim.note).slice(0, 1000) : '';
  const url = ownerInvoiceUrl(invoice);
  const lines = [
    `Your client reports payment sent.`,
    ``,
    `${clientName} reported sending payment for invoice ${number} (${total}).`,
    `Method: ${method}`
  ];
  if (reference) lines.push(`Reference: ${reference}`);
  if (note) {
    lines.push('', `Note from your client:`, note);
  }
  lines.push('', 'Verify the funds landed, then mark the invoice paid:');
  if (url) lines.push(url);
  lines.push('', 'DecentInvoice cannot verify whether the payment actually cleared — this is your client\'s self-report.');
  return lines.join('\n');
}

async function sendPaymentClaimedEmail(invoice, owner, claim) {
  if (!invoice || !owner) return { ok: false, reason: 'invalid_args' };
  const to = owner.email;
  if (!to) return { ok: false, reason: 'no_owner_email' };
  return sendEmail({
    to,
    subject: buildPaymentClaimedSubject(invoice),
    html: buildPaymentClaimedHtml(invoice, owner, claim || {}),
    text: buildPaymentClaimedText(invoice, owner, claim || {}),
    replyTo: resolveReplyTo(owner)
  });
}

/*
 * First-sent celebration email (Milestone 3 — first invoice created → first
 * invoice sent). One-shot transactional message that confirms the freelancer's
 * very first non-seed invoice has crossed into status='sent' (whether via
 * manual Mark-as-Sent, share-intent click, server-side Pro email send, the
 * quick-invoice create+email shortcut, or the public /i/<token> client-view
 * auto-flip). Reinforces the activation event, sets a "most clients pay
 * within 1–2 weeks" expectation, surfaces the Pro Pay-Link upsell to free
 * users so the get-paid moment is one decision away, and bakes in a magic-
 * login URL straight to the invoice the freelancer just sent so re-entry is
 * one tap. Sent exactly once per user lifetime — gated by
 * users.first_sent_at + lib/first-sent-celebration's race-safe UPDATE.
 */
function buildFirstSentCelebrationSubject(invoice) {
  const number = (invoice && invoice.invoice_number) || 'Your invoice';
  return `${number} is on its way — here's what happens next`;
}

function firstSentInvoiceUrl(invoice, opts) {
  if (!invoice || invoice.id == null) return '';
  const magicLoginUrl = opts && typeof opts.magicLoginUrl === 'string'
    ? opts.magicLoginUrl.trim() : '';
  if (magicLoginUrl) {
    return `${magicLoginUrl}?next=/invoices/${invoice.id}`;
  }
  const base = (process.env.APP_URL || '').replace(/\/+$/, '');
  if (!base) return `/invoices/${invoice.id}`;
  return `${base}/invoices/${invoice.id}`;
}

function firstSentUpgradeUrl(opts) {
  const magicLoginUrl = opts && typeof opts.magicLoginUrl === 'string'
    ? opts.magicLoginUrl.trim() : '';
  if (magicLoginUrl) {
    return `${magicLoginUrl}?next=/billing/upgrade`;
  }
  const base = (process.env.APP_URL || '').replace(/\/+$/, '');
  if (!base) return '/billing/upgrade';
  return `${base}/billing/upgrade`;
}

function buildFirstSentCelebrationHtml(owner, invoice, opts) {
  const number = (invoice && invoice.invoice_number) || '';
  const clientName = (invoice && invoice.client_name) || 'your client';
  const total = formatMoney(invoice && invoice.total);
  const greeting = (owner && (owner.name || owner.business_name)) || 'there';
  const url = firstSentInvoiceUrl(invoice, opts);
  const upgradeUrl = firstSentUpgradeUrl(opts);
  const isFree = !owner || owner.plan === 'free' || !owner.plan;
  const primaryButton = url
    ? `<p style="margin:24px 0;"><a href="${escapeHtml(url)}" style="background:#16a34a;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px;display:inline-block;">Open invoice ${escapeHtml(number)}</a></p>`
    : '';
  const upgradeBlock = isFree
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:16px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;">
        <tr><td style="padding:14px 16px;">
          <p style="margin:0 0 6px 0;color:#166534;font-size:14px;font-weight:600;">Want one-click payment for the next one?</p>
          <p style="margin:0 0 10px 0;color:#166534;font-size:13px;">Pro adds a Stripe Pay button to every share — your client pays by card in seconds instead of typing bank details into Venmo.</p>
          <p style="margin:0;"><a href="${escapeHtml(upgradeUrl)}" style="color:#15803d;font-weight:600;text-decoration:underline;font-size:13px;">Try Pro free for 7 days &rarr;</a></p>
        </td></tr>
       </table>`
    : '';
  return `<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#222;background:#f7f7f9;margin:0;padding:24px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #eaeaea;">
  <tr><td style="padding:24px 28px;">
    <h2 style="margin:0 0 8px 0;color:#16a34a;">Your first invoice is out the door &#127881;</h2>
    <p style="color:#222;margin:8px 0;font-size:16px;">Hi ${escapeHtml(greeting)},</p>
    <p style="color:#222;margin:8px 0;font-size:16px;">Invoice <strong>${escapeHtml(number)}</strong> for <strong>${escapeHtml(clientName)}</strong> (<strong>${escapeHtml(total)}</strong>) is now on its way. That's your first sent invoice on DecentInvoice &mdash; the moment it stops being a side-project tool and starts being part of how you get paid.</p>
    <p style="color:#222;margin:8px 0;font-size:16px;">What happens next:</p>
    <ul style="color:#222;margin:8px 0 16px 20px;font-size:15px;line-height:1.6;">
      <li>Most freelancers get paid within <strong>1&ndash;2 weeks</strong>. Your dashboard tracks when the client opens the link.</li>
      <li>If they haven't paid by the due date, you can fire a one-tap WhatsApp / SMS / email follow-up straight from the invoice page.</li>
      <li>The minute the payment lands, hit <em>Mark as paid</em> and we'll celebrate.</li>
    </ul>
    ${primaryButton}
    ${upgradeBlock}
    <p style="color:#999;font-size:12px;margin-top:24px;">Sent once, the first time you send an invoice. Future sends won't trigger this.</p>
  </td></tr>
</table>
</body></html>`;
}

function buildFirstSentCelebrationText(owner, invoice, opts) {
  const number = (invoice && invoice.invoice_number) || '';
  const clientName = (invoice && invoice.client_name) || 'your client';
  const total = formatMoney(invoice && invoice.total);
  const greeting = (owner && (owner.name || owner.business_name)) || 'there';
  const url = firstSentInvoiceUrl(invoice, opts);
  const upgradeUrl = firstSentUpgradeUrl(opts);
  const isFree = !owner || owner.plan === 'free' || !owner.plan;
  const lines = [
    `Hi ${greeting},`,
    '',
    `Invoice ${number} for ${clientName} (${total}) is now on its way. `
      + 'That\'s your first sent invoice on DecentInvoice.',
    '',
    'What happens next:',
    '- Most freelancers get paid within 1–2 weeks. Your dashboard tracks when the client opens the link.',
    '- If they haven\'t paid by the due date, fire a one-tap WhatsApp / SMS / email follow-up from the invoice page.',
    '- The minute the payment lands, mark it paid and we\'ll celebrate.'
  ];
  if (url) lines.push('', `Open invoice ${number}: ${url}`);
  if (isFree) {
    lines.push(
      '',
      'Want one-click payment for the next one? Pro adds a Stripe Pay button to every share.',
      `Try Pro free for 7 days: ${upgradeUrl}`
    );
  }
  lines.push('', 'Sent once, the first time you send an invoice. Future sends won\'t trigger this.');
  return lines.join('\n');
}

async function sendFirstSentCelebrationEmail(owner, invoice, opts) {
  if (!owner || !owner.email) return { ok: false, reason: 'no_owner_email' };
  if (!invoice) return { ok: false, reason: 'no_invoice' };
  const buildOpts = opts && typeof opts.magicLoginUrl === 'string' && opts.magicLoginUrl
    ? { magicLoginUrl: opts.magicLoginUrl } : undefined;
  return sendEmail({
    to: owner.email,
    subject: buildFirstSentCelebrationSubject(invoice),
    html: buildFirstSentCelebrationHtml(owner, invoice, buildOpts),
    text: buildFirstSentCelebrationText(owner, invoice, buildOpts),
    replyTo: resolveReplyTo(owner)
  });
}

/*
 * Client-viewed-but-unpaid follow-up email (Milestone 4 — sent → paid).
 * Fires 48h+ after a client has demonstrably opened the public /i/<token>
 * share link but hasn't paid yet. Recipient is the FREELANCER, not the
 * client — the action the freelancer takes from the invoice page (share-
 * intent buttons, mark-as-paid, edit due date, etc.) is what converts the
 * "viewed" state into a "paid" state. Distinct from:
 *
 *   - sendClientViewedEmail: fires the instant of first open. Captures the
 *     real-time peak; this follow-up captures the "they saw it, slept on
 *     it, and need a nudge" peak that happens 2-5 days later.
 *   - overdue-freelancer-digest: fires only after due_date passes, often
 *     weeks later. This nudge gets ahead of that — most invoices have a
 *     30-day due date but the conversion window is much shorter.
 *
 * The CTA bakes in a magic-login URL with ?next=/invoices/<id> so the
 * freelancer lands signed-in on the invoice's own page where the share-
 * intent buttons + mark-as-paid live. Mint failure soft-falls back to the
 * plain /invoices/<id> path; the email is never sacrificed.
 */
function buildClientViewedFollowupSubject(row) {
  const number = (row && row.invoice_number) || 'your invoice';
  const clientName = (row && row.client_name) || 'your client';
  return `${clientName} opened ${number} but hasn't paid yet — send a nudge?`;
}

function clientViewedFollowupCtaUrl(row, opts) {
  if (!row || row.invoice_id == null) return '';
  const magicLoginUrl = opts && typeof opts.magicLoginUrl === 'string'
    ? opts.magicLoginUrl.trim() : '';
  if (magicLoginUrl) {
    return `${magicLoginUrl}?next=/invoices/${row.invoice_id}`;
  }
  const base = (process.env.APP_URL || '').replace(/\/+$/, '');
  if (!base) return '';
  return `${base}/invoices/${row.invoice_id}`;
}

function daysSinceViewed(firstViewedAt, now = new Date()) {
  if (!firstViewedAt) return 0;
  const seen = new Date(firstViewedAt).getTime();
  if (!Number.isFinite(seen)) return 0;
  const diff = now.getTime() - seen;
  return Math.max(0, Math.floor(diff / 86400000));
}

function buildClientViewedFollowupHtml(row, now = new Date(), opts) {
  const number = (row && row.invoice_number) || '';
  const clientName = (row && row.client_name) || 'your client';
  const total = formatMoney(row && row.invoice_total);
  const greeting = (row && (row.name || row.business_name)) || 'there';
  const days = daysSinceViewed(row && row.first_viewed_at, now);
  const url = clientViewedFollowupCtaUrl(row, opts);
  const viewCount = parseInt(row && row.view_count, 10) || 0;
  const viewLine = viewCount > 1
    ? `<p style="color:#555;margin:4px 0;font-size:14px;">They've opened it <strong>${viewCount} times</strong> — clearly considering it.</p>`
    : '';
  const ctaButton = url
    ? `<p style="margin:24px 0;"><a href="${escapeHtml(url)}" style="background:#4f46e5;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px;display:inline-block;">Open invoice &amp; send a follow-up</a></p>`
    : '';
  const dayLabel = days <= 1 ? '2 days' : `${days} days`;

  return `<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#222;background:#f7f7f9;margin:0;padding:24px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #eaeaea;">
  <tr><td style="padding:24px 28px;">
    <h2 style="margin:0 0 8px 0;color:#111;">${escapeHtml(clientName)} opened your invoice but hasn't paid</h2>
    <p style="color:#222;margin:8px 0;font-size:16px;">Hi ${escapeHtml(greeting)},</p>
    <p style="color:#222;margin:8px 0;font-size:16px;"><strong>${escapeHtml(clientName)}</strong> opened invoice <strong>${escapeHtml(number)}</strong> for <strong>${escapeHtml(total)}</strong> about <strong>${escapeHtml(dayLabel)} ago</strong> &mdash; but the payment hasn't landed yet.</p>
    ${viewLine}
    <p style="color:#222;margin:8px 0;font-size:16px;">A short, friendly nudge at this exact moment is the single highest-converting action you can take. Open the invoice and fire a one-tap WhatsApp / SMS / Email follow-up: something like &ldquo;Hey &mdash; just checking you got my invoice. Let me know if you have any questions.&rdquo;</p>
    ${ctaButton}
    <p style="color:#999;font-size:12px;margin-top:24px;">Sent automatically when a client opens an invoice but doesn't pay within 48 hours. You'll only get this once per invoice.</p>
  </td></tr>
</table>
</body></html>`;
}

function buildClientViewedFollowupText(row, now = new Date(), opts) {
  const number = (row && row.invoice_number) || '';
  const clientName = (row && row.client_name) || 'your client';
  const total = formatMoney(row && row.invoice_total);
  const greeting = (row && (row.name || row.business_name)) || 'there';
  const days = daysSinceViewed(row && row.first_viewed_at, now);
  const url = clientViewedFollowupCtaUrl(row, opts);
  const viewCount = parseInt(row && row.view_count, 10) || 0;
  const dayLabel = days <= 1 ? '2 days' : `${days} days`;
  const lines = [
    `Hi ${greeting},`,
    '',
    `${clientName} opened invoice ${number} for ${total} about ${dayLabel} ago — `
      + 'but the payment hasn\'t landed yet.'
  ];
  if (viewCount > 1) {
    lines.push('', `They've opened it ${viewCount} times — clearly considering it.`);
  }
  lines.push(
    '',
    'A short, friendly nudge at this moment is the single highest-converting action you can take. '
      + 'Open the invoice and fire a one-tap WhatsApp / SMS / Email follow-up.'
  );
  if (url) {
    lines.push('', `Open invoice & send a follow-up: ${url}`);
  }
  lines.push('', 'Sent once per invoice when a client opens it but doesn\'t pay within 48 hours.');
  return lines.join('\n');
}

async function sendClientViewedFollowupEmail(row, opts) {
  if (!row || !row.email) return { ok: false, reason: 'no_recipient' };
  const buildOpts = opts && typeof opts.magicLoginUrl === 'string' && opts.magicLoginUrl
    ? { magicLoginUrl: opts.magicLoginUrl } : undefined;
  const now = (opts && opts.now) || new Date();
  return sendEmail({
    to: row.email,
    subject: buildClientViewedFollowupSubject(row),
    html: buildClientViewedFollowupHtml(row, now, buildOpts),
    text: buildClientViewedFollowupText(row, now, buildOpts),
    replyTo: resolveReplyTo(row)
  });
}

/*
 * Sent-but-never-viewed nudge (Milestone 4 — sent → paid). Recipient is the
 * FREELANCER. Fires 72h+ after a share-intent click when the client has not
 * opened the public link. Distinct framing from client-viewed-followup: this
 * email's hypothesis is silent delivery failure ("the message probably never
 * landed"), not procrastination ("they saw it, sleep on it"). The CTA pushes
 * the freelancer to re-share through a different channel rather than fire a
 * polite follow-up.
 *
 * The CTA bakes in a magic-login URL with ?next=/invoices/<id> so the
 * freelancer lands signed-in on the invoice page where the share-intent
 * buttons live. Mint failure soft-falls to the plain /invoices/<id> path.
 */
function buildSentNotViewedNudgeSubject(row) {
  const number = (row && row.invoice_number) || 'your invoice';
  const clientName = (row && row.client_name) || 'your client';
  return `${clientName} hasn't opened ${number} yet — try another channel?`;
}

function sentNotViewedNudgeCtaUrl(row, opts) {
  if (!row || row.invoice_id == null) return '';
  const magicLoginUrl = opts && typeof opts.magicLoginUrl === 'string'
    ? opts.magicLoginUrl.trim() : '';
  if (magicLoginUrl) {
    return `${magicLoginUrl}?next=/invoices/${row.invoice_id}`;
  }
  const base = (process.env.APP_URL || '').replace(/\/+$/, '');
  if (!base) return '';
  return `${base}/invoices/${row.invoice_id}`;
}

function daysSinceSent(sentAt, now = new Date()) {
  if (!sentAt) return 0;
  const sent = new Date(sentAt).getTime();
  if (!Number.isFinite(sent)) return 0;
  const diff = now.getTime() - sent;
  return Math.max(0, Math.floor(diff / 86400000));
}

function buildSentNotViewedNudgeHtml(row, now = new Date(), opts) {
  const number = (row && row.invoice_number) || '';
  const clientName = (row && row.client_name) || 'your client';
  const total = formatMoney(row && row.invoice_total);
  const greeting = (row && (row.name || row.business_name)) || 'there';
  const days = daysSinceSent(row && row.sent_at, now);
  const url = sentNotViewedNudgeCtaUrl(row, opts);
  // Cohort gate is 72h+ so floor at "3 days" — never "0 days" / "1 day".
  const dayLabel = days <= 2 ? '3 days' : `${days} days`;
  const ctaButton = url
    ? `<p style="margin:24px 0;"><a href="${escapeHtml(url)}" style="background:#4f46e5;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px;display:inline-block;">Open invoice &amp; re-share</a></p>`
    : '';

  return `<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#222;background:#f7f7f9;margin:0;padding:24px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #eaeaea;">
  <tr><td style="padding:24px 28px;">
    <h2 style="margin:0 0 8px 0;color:#111;">${escapeHtml(clientName)} hasn't opened your invoice yet</h2>
    <p style="color:#222;margin:8px 0;font-size:16px;">Hi ${escapeHtml(greeting)},</p>
    <p style="color:#222;margin:8px 0;font-size:16px;">You sent invoice <strong>${escapeHtml(number)}</strong> for <strong>${escapeHtml(total)}</strong> to <strong>${escapeHtml(clientName)}</strong> about <strong>${escapeHtml(dayLabel)} ago</strong>, but our share link still shows zero opens.</p>
    <p style="color:#222;margin:8px 0;font-size:16px;">That usually means one of three things:</p>
    <ul style="color:#222;margin:8px 0 16px 20px;font-size:15px;line-height:1.6;">
      <li>The message went to spam or got buried</li>
      <li>You sent it to a stale phone number / email</li>
      <li>Your client opened the message but didn't tap the link</li>
    </ul>
    <p style="color:#222;margin:8px 0;font-size:16px;">A re-share through a different channel (WhatsApp instead of email, or vice versa) is usually all it takes:</p>
    ${ctaButton}
    <p style="color:#999;font-size:12px;margin-top:24px;">Sent once per invoice when a share goes unopened for 72+ hours. You'll only get this once per invoice.</p>
  </td></tr>
</table>
</body></html>`;
}

function buildSentNotViewedNudgeText(row, now = new Date(), opts) {
  const number = (row && row.invoice_number) || '';
  const clientName = (row && row.client_name) || 'your client';
  const total = formatMoney(row && row.invoice_total);
  const greeting = (row && (row.name || row.business_name)) || 'there';
  const days = daysSinceSent(row && row.sent_at, now);
  const url = sentNotViewedNudgeCtaUrl(row, opts);
  const dayLabel = days <= 2 ? '3 days' : `${days} days`;
  const lines = [
    `Hi ${greeting},`,
    '',
    `You sent invoice ${number} for ${total} to ${clientName} about ${dayLabel} ago, `
      + 'but the share link still shows zero opens.',
    '',
    'That usually means one of three things:',
    '  - The message went to spam or got buried',
    '  - You sent it to a stale phone number / email',
    '  - Your client opened the message but didn\'t tap the link',
    '',
    'A re-share through a different channel (WhatsApp instead of email, or vice versa) is usually all it takes.'
  ];
  if (url) {
    lines.push('', `Open invoice & re-share: ${url}`);
  }
  lines.push('', 'Sent once per invoice when a share goes unopened for 72+ hours.');
  return lines.join('\n');
}

async function sendSentNotViewedNudgeEmail(row, opts) {
  if (!row || !row.email) return { ok: false, reason: 'no_recipient' };
  const buildOpts = opts && typeof opts.magicLoginUrl === 'string' && opts.magicLoginUrl
    ? { magicLoginUrl: opts.magicLoginUrl } : undefined;
  const now = (opts && opts.now) || new Date();
  return sendEmail({
    to: row.email,
    subject: buildSentNotViewedNudgeSubject(row),
    html: buildSentNotViewedNudgeHtml(row, now, buildOpts),
    text: buildSentNotViewedNudgeText(row, now, buildOpts),
    replyTo: resolveReplyTo(row)
  });
}

module.exports = {
  sendEmail,
  sendInvoiceEmail,
  sendPaidNotificationEmail,
  sendReferralCelebrationEmail,
  buildInvoiceSubject,
  buildInvoiceHtml,
  buildInvoiceText,
  buildPaidNotificationSubject,
  buildPaidNotificationHtml,
  buildPaidNotificationText,
  sendPaidReceiptEmail,
  buildPaidReceiptSubject,
  buildPaidReceiptHtml,
  buildPaidReceiptText,
  buildReferralCelebrationSubject,
  buildReferralCelebrationHtml,
  buildReferralCelebrationText,
  sendWelcomeEmail,
  buildWelcomeSubject,
  buildWelcomeHtml,
  buildWelcomeText,
  sendPasswordResetEmail,
  buildPasswordResetSubject,
  buildPasswordResetHtml,
  buildPasswordResetText,
  sendMagicLoginEmail,
  buildMagicLoginSubject,
  buildMagicLoginHtml,
  buildMagicLoginText,
  sendClientViewedEmail,
  buildClientViewedSubject,
  buildClientViewedHtml,
  buildClientViewedText,
  sendPaymentClaimedEmail,
  buildPaymentClaimedSubject,
  buildPaymentClaimedHtml,
  buildPaymentClaimedText,
  sendFirstSentCelebrationEmail,
  buildFirstSentCelebrationSubject,
  buildFirstSentCelebrationHtml,
  buildFirstSentCelebrationText,
  sendClientViewedFollowupEmail,
  buildClientViewedFollowupSubject,
  buildClientViewedFollowupHtml,
  buildClientViewedFollowupText,
  sendSentNotViewedNudgeEmail,
  buildSentNotViewedNudgeSubject,
  buildSentNotViewedNudgeHtml,
  buildSentNotViewedNudgeText,
  daysSinceViewed,
  daysSinceSent,
  paymentMethodLabel,
  PAYMENT_METHOD_LABELS,
  resolveReplyTo,
  resolveFrom,
  setResendClient,
  resetResendClient,
  // Exported for unit tests; not part of the stable public API.
  _internal: { escapeHtml, formatMoney, senderName }
};
