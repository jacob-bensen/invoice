'use strict';

/*
 * Shared HTML/format helpers used across email-render code paths.
 *
 * Promoted from byte-identical (or near-identical) copies in
 * lib/email.js, jobs/reminders.js, and jobs/trial-nudge.js so that a future
 * change to escaping or money formatting lands once instead of drifting.
 *
 * Pure functions only — no IO, no module state. Safe to require from any
 * layer.
 */

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const CURRENCY_SYMBOLS = {
  usd: '$',
  eur: '€',
  gbp: '£',
  cad: 'CA$',
  aud: 'A$',
  chf: 'CHF ',
  jpy: '¥',
  nzd: 'NZ$'
};

function formatMoney(amount, currency) {
  const code = (currency || 'usd').toLowerCase();
  const symbol = Object.prototype.hasOwnProperty.call(CURRENCY_SYMBOLS, code)
    ? CURRENCY_SYMBOLS[code]
    : '';
  const num = Number(amount);
  if (!Number.isFinite(num)) return `${symbol}0.00`;
  return `${symbol}${num.toFixed(2)}`;
}

/*
 * formatTrialCountdown(trialEndsAt, now) — INTERNAL_TODO #106 + #138
 *
 * Given a trial expiration timestamp (Date | string | number), return a small
 * shape used by the global-nav trial-countdown pill, or `null` when no pill
 * should render. Rendering the pill in views/partials/nav.ejs surfaces trial
 * urgency on every authed page (not just the dashboard banner).
 *
 *   { days, hours, minutes, label, urgentLabel, urgent }
 *
 *   - days:        whole days remaining (>= 0)
 *   - hours:       remaining hours after subtracting whole days (0..23)
 *   - minutes:     remaining minutes after subtracting whole hours (0..59)
 *   - label:       user-facing string ("Xd Yh left" / "Yh left" / "<1h left")
 *   - urgentLabel: H:M-precision string used by the day-1 nav-pill (#138):
 *                  "Xh Ym left" when hours >= 1, "Ym left" in the final hour.
 *                  Only populated when urgent === true; null otherwise.
 *   - urgent:      true when < 24 hours remain (drives a red-pill style)
 *
 * Returns null when trialEndsAt is missing/invalid or already in the past.
 */
function formatTrialCountdown(trialEndsAt, now) {
  if (!trialEndsAt) return null;
  const ends = new Date(trialEndsAt).getTime();
  if (!Number.isFinite(ends)) return null;
  const ref = typeof now === 'number' ? now : Date.now();
  const diffMs = ends - ref;
  if (diffMs <= 0) return null;
  const days = Math.floor(diffMs / 86400000);
  const hours = Math.floor((diffMs % 86400000) / 3600000);
  const minutes = Math.floor((diffMs % 3600000) / 60000);
  let label;
  if (days >= 1) {
    label = hours > 0 ? `${days}d ${hours}h left` : `${days}d left`;
  } else if (hours >= 1) {
    label = `${hours}h left`;
  } else {
    label = '<1h left';
  }
  const urgent = days < 1;
  // urgentLabel matches the dashboard banner #134 H:M precision so the
  // nav-pill reinforces the same concrete-time anchor on every authed page.
  let urgentLabel = null;
  if (urgent) {
    urgentLabel = hours >= 1
      ? `${hours}h ${minutes}m left`
      : `${minutes}m left`;
  }
  return { days, hours, minutes, label, urgentLabel, urgent };
}

module.exports = {
  escapeHtml,
  formatMoney,
  formatTrialCountdown,
  CURRENCY_SYMBOLS
};
