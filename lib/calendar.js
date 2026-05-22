'use strict';

/*
 * .ics calendar generator for the public invoice share page (Milestone 4 —
 * first invoice sent → first payment received). When a client opens
 * /i/<token> they see the invoice + due date but nothing nudges them to
 * actually act before the due date. An "Add to calendar" download produces
 * an RFC 5545 .ics file that pins the due date in their native calendar —
 * iOS / macOS Calendar, Google Calendar (via .ics import), Outlook, etc.
 * — and the OS handles the day-before reminder via a default VALARM.
 *
 * RFC 5545 compliance highlights:
 *   - All-day event via VALUE=DATE on DTSTART/DTEND; DTEND is exclusive so a
 *     single-day "Invoice due" event has DTSTART=YYYYMMDD and DTEND=next day.
 *   - PRODID identifies the generator.
 *   - UID is deterministic (per-invoice + per-token + APP_URL) so importing
 *     the same .ics twice updates the existing event instead of duplicating.
 *   - DTSTAMP is UTC; per spec, this is the time the .ics was generated.
 *   - Text fields are escaped per RFC 5545 §3.3.11 (comma, semicolon,
 *     backslash, CRLF). HTML is NOT permitted in TEXT fields.
 *   - Lines are joined with CRLF (\r\n) as required by §3.1.
 *   - One default VALARM at -P0DT12H (12h before midnight of the due day, so
 *     it fires around noon the day before in most timezones — the canonical
 *     "you have a thing due tomorrow" prompt).
 *
 * Returns null when the invoice has no due_date (the entire feature is the
 * due-date reminder; without one, there's nothing to add to a calendar) or
 * when due_date is unparseable. The route then 404s rather than serving an
 * empty .ics file.
 */

const { escapeHtml: _unused } = require('./html'); // unused — keeps file aligned with other lib/* modules

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

// Format a Date as YYYYMMDD (DATE value type per RFC 5545 §3.3.4).
// Uses UTC components so the all-day event lands on the same calendar date
// for every viewer regardless of their local timezone — exactly what a
// freelancer's "Due May 31" intent means: the wall-clock day, not a moment.
function formatIcsDate(date) {
  if (!date) return null;
  const d = (date instanceof Date) ? date : new Date(date);
  const t = d.getTime();
  if (!Number.isFinite(t)) return null;
  return d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate());
}

// Format a Date as YYYYMMDDTHHMMSSZ for the DTSTAMP field (DATE-TIME UTC).
function formatIcsDateTime(date) {
  if (!date) return null;
  const d = (date instanceof Date) ? date : new Date(date);
  const t = d.getTime();
  if (!Number.isFinite(t)) return null;
  return d.getUTCFullYear()
    + pad2(d.getUTCMonth() + 1)
    + pad2(d.getUTCDate())
    + 'T'
    + pad2(d.getUTCHours())
    + pad2(d.getUTCMinutes())
    + pad2(d.getUTCSeconds())
    + 'Z';
}

// Add `days` to a Date and return a new Date, preserving UTC wall-clock day.
function addDaysUtc(date, days) {
  const d = (date instanceof Date) ? new Date(date.getTime()) : new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

// RFC 5545 §3.3.11: TEXT escape — backslash, comma, semicolon, CRLF.
function escapeIcsText(s) {
  if (s == null) return '';
  const str = String(s);
  return str
    .replace(/\\/g, '\\\\')
    .replace(/\r\n/g, '\\n')
    .replace(/\r/g, '\\n')
    .replace(/\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

// RFC 5545 §3.1 line folding: any content line longer than 75 octets must be
// split with a CRLF + single white-space continuation. Most clients tolerate
// long lines, but Outlook is strict — fold defensively.
function foldLine(line) {
  if (typeof line !== 'string') return '';
  if (line.length <= 75) return line;
  const parts = [];
  let i = 0;
  // First segment is 75 chars; subsequent segments are 74 (leading space).
  parts.push(line.slice(0, 75));
  i = 75;
  while (i < line.length) {
    parts.push(' ' + line.slice(i, i + 74));
    i += 74;
  }
  return parts.join('\r\n');
}

function formatMoneySimple(amount, currency) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '';
  const code = (typeof currency === 'string' && currency.trim())
    ? currency.trim().toUpperCase() : 'USD';
  // No locale-specific symbol — the calendar event SUMMARY/DESCRIPTION is
  // plain text consumed by every locale's calendar app. "USD 300.00" is
  // unambiguous across Outlook, Apple Calendar, Google Calendar.
  return code + ' ' + n.toFixed(2);
}

function senderLabel(invoice) {
  return (invoice && (
    invoice.owner_business_name
    || invoice.owner_name
    || invoice.owner_business_email
    || invoice.owner_email
  )) || 'DecentInvoice';
}

/*
 * Build the .ics body for an invoice. Returns null if there's nothing to
 * remind about (no due_date / unparseable). The caller is responsible for
 * the HTTP transport headers.
 *
 * opts:
 *   - now (Date)     — override for DTSTAMP; deterministic across tests.
 *   - appUrl (string) — used in UID + DESCRIPTION URL line; falls back to
 *                       APP_URL env var, then a placeholder.
 */
function buildInvoiceIcs(invoice, opts) {
  if (!invoice || typeof invoice !== 'object') return null;
  if (!invoice.due_date) return null;
  const dueStart = formatIcsDate(invoice.due_date);
  if (!dueStart) return null;
  // DTEND is exclusive per RFC 5545 §3.6.1 — for a single-day all-day event,
  // DTEND is the day after DTSTART.
  const dueEnd = formatIcsDate(addDaysUtc(invoice.due_date, 1));
  if (!dueEnd) return null;

  const now = (opts && opts.now instanceof Date) ? opts.now : new Date();
  const dtstamp = formatIcsDateTime(now) || formatIcsDateTime(new Date());

  const appUrl = (opts && typeof opts.appUrl === 'string' && opts.appUrl.trim())
    ? opts.appUrl.trim().replace(/\/+$/, '')
    : ((process.env.APP_URL || '').replace(/\/+$/, '') || '');

  const invoiceNumber = invoice.invoice_number || ('INV-' + (invoice.id || ''));
  const sender = senderLabel(invoice);
  const totalLabel = formatMoneySimple(invoice.total, invoice.currency);
  const publicToken = (invoice.public_token && typeof invoice.public_token === 'string')
    ? invoice.public_token : '';
  // Deterministic UID: re-importing the same .ics updates the existing event
  // instead of creating a duplicate. We anchor on the public_token (which
  // doesn't change for the lifetime of the share link) + the invoice id.
  const uidHost = appUrl ? appUrl.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9.-]/g, '') : 'decentinvoice';
  const uid = `invoice-${invoice.id || 'x'}-${publicToken || 'no-token'}@${uidHost || 'decentinvoice'}`;

  const summary = `Invoice ${invoiceNumber} due — ${sender}`;
  const descLines = [`Invoice ${invoiceNumber} from ${sender} is due.`];
  if (totalLabel) descLines.push(`Amount: ${totalLabel}`);
  if (appUrl && publicToken) {
    descLines.push(`View invoice: ${appUrl}/i/${publicToken}`);
  }
  const description = descLines.join('\n');

  // URL property — points at the public invoice page so calendar apps that
  // surface the URL field (Google Calendar event modal, Apple Calendar's
  // "URL" row) one-click the client back to the live invoice.
  const urlLine = (appUrl && publicToken) ? `${appUrl}/i/${publicToken}` : '';

  const rawLines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//DecentInvoice//Invoice Reminder 1.0//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART;VALUE=DATE:${dueStart}`,
    `DTEND;VALUE=DATE:${dueEnd}`,
    `SUMMARY:${escapeIcsText(summary)}`,
    `DESCRIPTION:${escapeIcsText(description)}`,
    urlLine ? `URL:${urlLine}` : null,
    'STATUS:CONFIRMED',
    'TRANSP:TRANSPARENT',
    'BEGIN:VALARM',
    // -P0DT12H: 12 hours before midnight of the due day, so the OS fires
    // the reminder around noon the day before. The canonical "due
    // tomorrow" prompt that lands at the front of the day's work window.
    'TRIGGER:-P0DT12H',
    'ACTION:DISPLAY',
    `DESCRIPTION:${escapeIcsText(summary)}`,
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR'
  ].filter((s) => s != null);

  return rawLines.map(foldLine).join('\r\n') + '\r\n';
}

/*
 * Build a sensible Content-Disposition filename for the .ics — the file the
 * client downloads is named after the invoice so it doesn't land in their
 * Downloads folder as a stack of identical `calendar.ics` files. ASCII-only
 * (HTTP header constraint); any non-ASCII chars in the invoice number fall
 * back to "invoice".
 */
function buildIcsFilename(invoice) {
  const num = (invoice && invoice.invoice_number) || '';
  const safe = /^[\x20-\x7E]+$/.test(num) ? num.replace(/[^A-Za-z0-9._-]/g, '_') : '';
  const base = safe || 'invoice';
  return `${base}-due.ics`;
}

module.exports = {
  buildInvoiceIcs,
  buildIcsFilename,
  formatIcsDate,
  formatIcsDateTime,
  escapeIcsText,
  foldLine,
  addDaysUtc
};
