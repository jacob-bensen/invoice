'use strict';

/*
 * Browser Accept-Language → default_currency derivation for new signups
 * (Milestone 2 — first dashboard re-entry → first real invoice created).
 *
 * Until a user touches /billing/settings, every owner-facing money render
 * (`/invoices/quick` amount prefix, `/invoices/new` line-item totals,
 * `/invoices/:id` view + print) and every client-facing money render on
 * `/i/<token>` reads through `lib/currency.resolveInvoiceCurrency`, which
 * falls back to `users.default_currency`. A Berlin freelancer who signs up
 * today gets `default_currency='USD'` and immediately sees `$` on the very
 * first line-item they type — friction at the exact moment we're trying to
 * collapse signup into a sent invoice.
 *
 * The browser already tells us the locale on the signup POST. Mapping the
 * highest-q-weighted tag's region to one of the eight supported currency
 * codes lets the right symbol land on every form a non-US signup sees, and
 * propagates correctly to the public share page their client opens — zero
 * additional input from the user.
 *
 * Pure: no I/O, no DB coupling, no module state. Returns one of the eight
 * supported ISO-4217 codes in `lib/currency.SUPPORTED_CURRENCIES`, defaulting
 * to 'USD' on any unrecognised, malformed, missing, or unsupported input.
 */

const DEFAULT_CURRENCY = 'USD';

// Eurozone ISO 3166-1 alpha-2 codes (currently in monetary union).
const EURO_REGIONS = new Set([
  'AT', 'BE', 'CY', 'DE', 'EE', 'ES', 'FI', 'FR', 'GR',
  'HR', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PT', 'SI', 'SK'
]);

const REGION_TO_CURRENCY = Object.freeze({
  US: 'USD',
  GB: 'GBP',
  CA: 'CAD',
  AU: 'AUD',
  NZ: 'NZD',
  JP: 'JPY',
  CH: 'CHF'
});

// Language-only fallbacks when no region subtag is present. We bias toward
// the country that's the dominant speaker base for the language AND whose
// currency is in our supported set:
//   - 'de' → Germany (EUR). Switzerland always sends de-CH.
//   - 'fr' → France (EUR). Canada always sends fr-CA.
//   - 'it' / 'nl' / 'pt' → Italy / Netherlands / Portugal (EUR).
//   - 'ja' → Japan (JPY).
//   - 'es' is intentionally NOT mapped because the dominant Spanish-speaking
//     bases (Mexico, Argentina, Colombia, Spain) split across MXN/ARS/COP/EUR
//     and the bare 'es' tag rarely fires on real-world signups.
//   - 'en' is intentionally NOT mapped — defaults to USD.
const LANGUAGE_TO_CURRENCY = Object.freeze({
  de: 'EUR',
  fr: 'EUR',
  it: 'EUR',
  nl: 'EUR',
  pt: 'EUR',
  ja: 'JPY'
});

function regionToCurrency(region) {
  if (typeof region !== 'string') return null;
  const code = region.trim().toUpperCase();
  if (!code) return null;
  if (Object.prototype.hasOwnProperty.call(REGION_TO_CURRENCY, code)) {
    return REGION_TO_CURRENCY[code];
  }
  if (EURO_REGIONS.has(code)) return 'EUR';
  return null;
}

function languageToCurrency(language) {
  if (typeof language !== 'string') return null;
  const code = language.trim().toLowerCase();
  if (!code) return null;
  return Object.prototype.hasOwnProperty.call(LANGUAGE_TO_CURRENCY, code)
    ? LANGUAGE_TO_CURRENCY[code]
    : null;
}

// Parse a single Accept-Language tag into `{ language, region, quality }`,
// or null if the tag is empty / malformed. Per RFC 7231, a missing
// quality value implies q=1.
function parseTag(rawTag) {
  if (typeof rawTag !== 'string') return null;
  const tag = rawTag.trim();
  if (!tag) return null;
  const parts = tag.split(';').map((p) => p.trim());
  const langTag = parts[0];
  if (!langTag) return null;
  // Wildcard: treat as no signal.
  if (langTag === '*') return null;
  // Language subtag must be ASCII letters; otherwise reject the tag.
  const subtags = langTag.split('-');
  const language = subtags[0];
  if (!language || !/^[A-Za-z]{1,8}$/.test(language)) return null;
  // Region subtag (if present): the first subtag after the language that's
  // exactly 2 letters or 3 digits per RFC 5646. We only need the 2-letter
  // alpha form to look up in our region map.
  let region = null;
  for (let i = 1; i < subtags.length; i++) {
    if (/^[A-Za-z]{2}$/.test(subtags[i])) {
      region = subtags[i];
      break;
    }
  }
  let quality = 1;
  for (let i = 1; i < parts.length; i++) {
    const param = parts[i];
    const eq = param.indexOf('=');
    if (eq === -1) continue;
    const key = param.slice(0, eq).trim().toLowerCase();
    if (key !== 'q') continue;
    const raw = param.slice(eq + 1).trim();
    const parsed = parseFloat(raw);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) {
      quality = parsed;
    }
  }
  return { language, region, quality, original: tag };
}

/*
 * Derive the most-likely default currency for a brand-new signup from the
 * request's Accept-Language header. Defaults to USD for missing / malformed
 * / unrecognised input — the same value the DB column defaults to, so the
 * fall-back path is indistinguishable from the no-header path downstream.
 *
 * Algorithm:
 *   1. Split on commas, parse each tag, drop nulls and q=0 tags.
 *   2. Sort by quality descending, preserving input order on ties.
 *   3. Walk the sorted list, return the first tag whose region (or, if no
 *      region, whose language) maps to a supported currency.
 *   4. Fall through to USD.
 */
function currencyFromAcceptLanguage(header) {
  if (typeof header !== 'string') return DEFAULT_CURRENCY;
  const trimmed = header.trim();
  if (!trimmed) return DEFAULT_CURRENCY;
  // Defensive cap: a hostile client could send a multi-kilobyte header.
  // Real Accept-Language headers are well under 256 bytes; clip to keep the
  // split + parse work bounded.
  const safe = trimmed.length > 1024 ? trimmed.slice(0, 1024) : trimmed;
  const rawTags = safe.split(',');
  const tags = [];
  for (let i = 0; i < rawTags.length; i++) {
    const parsed = parseTag(rawTags[i]);
    if (!parsed) continue;
    if (parsed.quality === 0) continue;
    parsed.order = i;
    tags.push(parsed);
  }
  if (!tags.length) return DEFAULT_CURRENCY;
  tags.sort((a, b) => {
    if (b.quality !== a.quality) return b.quality - a.quality;
    return a.order - b.order;
  });
  for (const tag of tags) {
    const regionCurrency = regionToCurrency(tag.region);
    if (regionCurrency) return regionCurrency;
    const languageCurrency = languageToCurrency(tag.language);
    if (languageCurrency) return languageCurrency;
  }
  return DEFAULT_CURRENCY;
}

module.exports = {
  DEFAULT_CURRENCY,
  EURO_REGIONS,
  REGION_TO_CURRENCY,
  LANGUAGE_TO_CURRENCY,
  currencyFromAcceptLanguage,
  regionToCurrency,
  languageToCurrency
};
