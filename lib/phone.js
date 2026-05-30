'use strict';

/*
 * Client-phone normalization for SMS / WhatsApp share-intent URLs.
 *
 * Inputs we accept from the freelancer typing into the /invoices/quick form:
 *   "+1 (555) 123-4567" → "+15551234567"
 *   "(555) 123-4567"    → "5551234567"
 *   "555-123-4567"      → "5551234567"
 *   "555.123.4567"      → "5551234567"
 *   "+15551234567"      → "+15551234567"
 *
 * Output contract:
 *   - leading "+" preserved when present (signals E.164 / international)
 *   - all other non-digits stripped
 *   - 7–15 digits total (E.164 max is 15; below 7 isn't a real phone)
 *   - else returns null (caller treats null as "no phone, fall back to
 *     pickerless sms:?&body=... and wa.me/?text=...")
 *
 * `formatForSms()` returns the normalized phone as-is — iOS Messages and
 * Android Messages both accept `sms:+15551234567?body=...` and the bare
 * `sms:5551234567?body=...` (the latter is treated as a local-formatted
 * number by the OS).
 *
 * `formatForWhatsApp()` strips the "+" — WhatsApp's wa.me URL spec is
 * strict: digits only, no plus, no leading zeros. A number without a "+"
 * is passed through digits-only, which WhatsApp will treat as international
 * (so a US user typing "5551234567" without the country code gets a
 * wa.me/5551234567 URL that won't resolve — but the same is true of
 * typing the bare number into WhatsApp directly, so we don't second-guess).
 */

const MIN_DIGITS = 7;
const MAX_DIGITS = 15;

function normalizeClientPhone(input) {
  if (input == null) return null;
  const s = typeof input === 'string' ? input : String(input);
  const trimmed = s.trim();
  if (!trimmed) return null;
  const hasPlus = trimmed.charAt(0) === '+';
  const digits = trimmed.replace(/\D+/g, '');
  if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) return null;
  return hasPlus ? `+${digits}` : digits;
}

function formatForSms(normalized) {
  if (typeof normalized !== 'string' || !normalized) return '';
  return normalized;
}

function formatForWhatsApp(normalized) {
  if (typeof normalized !== 'string' || !normalized) return '';
  return normalized.replace(/^\+/, '');
}

module.exports = {
  normalizeClientPhone,
  formatForSms,
  formatForWhatsApp,
  MIN_DIGITS,
  MAX_DIGITS
};
