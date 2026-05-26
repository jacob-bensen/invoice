'use strict';

/*
 * Per-invoice OpenGraph metadata helper for the public /i/<token> share
 * page (Milestone 4 — first invoice sent → first payment received).
 *
 * Returns { title, description } describing the invoice in a form suitable
 * for the og:title / og:description tags. The head partial passes both
 * values through EJS's `<%= %>` which HTML-escapes them inside the meta
 * attribute, so callers may pass raw strings — no upstream escaping is
 * required.
 *
 * Privacy: client_name is deliberately omitted from both fields. The link
 * preview tile renders on whatever device or chat the freelancer forwards
 * the URL through (their phone, their other chats, sometimes the client's
 * forwarded reply chain) — surfacing the client's name to those audiences
 * would leak the business relationship.
 *
 * Pure function — no IO, no module state. Returns null when given a
 * falsy / non-object invoice so callers can apply their own fallbacks
 * cleanly.
 */

const DEFAULT_DESCRIPTION = 'Tap to view and pay this invoice.';

function formatTotal(total) {
  const n = Number(total);
  if (!Number.isFinite(n)) return '';
  return '$' + n.toFixed(2);
}

function formatDueDate(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return '';
  // Use UTC slots so the same due_date string formats identically in every
  // server timezone. Long-form month avoids locale-ambiguity ("05/06" can
  // be May-6 or Jun-5; "May 6, 2026" cannot).
  const MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

function startOfUtcDay(date) {
  const d = new Date(date.getTime());
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function buildPublicInvoiceOg(invoice, opts) {
  if (!invoice || typeof invoice !== 'object') return null;
  const number = invoice.invoice_number != null
    ? String(invoice.invoice_number).trim() : '';
  const business = (typeof invoice.owner_business_name === 'string'
      && invoice.owner_business_name.trim())
    || (typeof invoice.owner_name === 'string' && invoice.owner_name.trim())
    || '';
  const amount = formatTotal(invoice.total);
  const status = typeof invoice.status === 'string' ? invoice.status : '';

  const numLabel = number ? `Invoice ${number}` : 'Invoice';
  const fromLabel = business ? ` from ${business}` : '';
  const amountLabel = amount ? ` — ${amount}` : '';
  const title = `${numLabel}${fromLabel}${amountLabel}`;

  let description;
  if (status === 'paid') {
    description = amount
      ? `Paid — ${amount}. Tap to view the receipt.`
      : 'Paid. Tap to view the receipt.';
  } else {
    const dueRaw = invoice.due_date ? new Date(invoice.due_date) : null;
    const validDue = dueRaw && Number.isFinite(dueRaw.getTime()) ? dueRaw : null;
    const now = (opts && opts.now instanceof Date) ? opts.now : new Date();
    const isOverdue = validDue
      && startOfUtcDay(validDue).getTime() < startOfUtcDay(now).getTime();
    const amountClause = amount ? ` ${amount}` : '';
    if (isOverdue) {
      description = `Now overdue. Tap to view and pay${amountClause}.`;
    } else if (validDue) {
      description = `Due ${formatDueDate(validDue)}. Tap to view and pay${amountClause}.`;
    } else {
      description = `Tap to view and pay${amountClause}.`;
    }
  }

  return { title, description };
}

module.exports = {
  buildPublicInvoiceOg,
  PUBLIC_INVOICE_OG_DEFAULT_DESCRIPTION: DEFAULT_DESCRIPTION
};
