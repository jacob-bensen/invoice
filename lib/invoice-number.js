'use strict';

/*
 * Per-user invoice-number customization (Milestone 3 — first invoice
 * created → first invoice sent). Freelancers routinely want:
 *   - their own prefix ("ACME-", "JB-", "2026-INV-") in place of the
 *     historical "INV-YYYY-" default, so the number their client sees
 *     matches their brand rather than a SaaS-default string, and
 *   - a starting number bump (100, 1000, ...) so a first-run freelancer's
 *     invoice #1 doesn't literally read "INV-2026-0001" — a signal to
 *     the client that this is their very first invoicing customer,
 *     which quietly lowers perceived legitimacy at the exact moment
 *     legitimacy matters most (invoice #1 → payment #1).
 *
 * Both are stored on the users table as nullable / defaulted columns and
 * resolved here into the final invoice-number string. All validation is
 * defence-in-depth: the settings route also validates, but a corrupt DB
 * row or direct-write must never produce a malformed number.
 */

const PREFIX_MAX_LEN = 20;
const START_MIN = 1;
const START_MAX = 999999;
const SEQUENCE_PAD = 4;

function defaultPrefix(now) {
  const d = now instanceof Date ? now : new Date();
  return `INV-${d.getFullYear()}-`;
}

/*
 * Normalises a raw prefix input into the canonical stored string or null.
 * Trims whitespace, enforces the 20-char cap, and rejects control
 * characters (ASCII 0-31 + 127) — those would corrupt display and could
 * inject line breaks into logs / headers. Non-string / empty / too-long /
 * control-char inputs all collapse to null, which downstream is treated
 * as "use the historical INV-YYYY- default".
 */
function sanitizePrefix(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > PREFIX_MAX_LEN) return null;
  if (/[\x00-\x1F\x7F]/.test(trimmed)) return null;
  return trimmed;
}

/*
 * Normalises a raw start-at input into an integer in [1, 999999] or null.
 * Accepts strings and numbers; rejects empty, non-digit, fractional,
 * negative, zero, and out-of-range. Null is the "no custom start" signal
 * — the caller substitutes the historical START_MIN default.
 */
function sanitizeStart(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s.length === 0) return null;
  if (!/^[0-9]+$/.test(s)) return null;
  const n = parseInt(s, 10);
  if (!Number.isFinite(n) || n < START_MIN || n > START_MAX) return null;
  return n;
}

/*
 * Builds the final invoice-number string from the user's stored prefix +
 * start-at + the current invoice count on their account. Every input
 * runs through the same sanitizers used by the settings route so a
 * corrupt row (out-of-range integer, hostile prefix, missing column)
 * silently falls back to the historical default rather than producing
 * a malformed value.
 */
function formatInvoiceNumber({ existingCount, prefix, startAt, now }) {
  const count = Number.isFinite(existingCount) && existingCount >= 0
    ? Math.floor(existingCount)
    : 0;
  const cleanStart = sanitizeStart(startAt);
  const start = cleanStart != null ? cleanStart : START_MIN;
  const cleanPrefix = sanitizePrefix(prefix);
  const effectivePrefix = cleanPrefix != null ? cleanPrefix : defaultPrefix(now);
  const seq = count + start;
  return `${effectivePrefix}${String(seq).padStart(SEQUENCE_PAD, '0')}`;
}

module.exports = {
  PREFIX_MAX_LEN,
  START_MIN,
  START_MAX,
  SEQUENCE_PAD,
  defaultPrefix,
  sanitizePrefix,
  sanitizeStart,
  formatInvoiceNumber
};
