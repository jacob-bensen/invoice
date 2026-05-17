'use strict';

/*
 * Client-view formatting + bot exclusion for the public /i/<token> share
 * link (Milestone 4 — sent → paid). Two pure functions; no I/O.
 *
 *   isLikelyBotUserAgent(ua) — true when the request is from a known
 *     crawler/preview-fetcher whose visit should NOT be counted as the
 *     client opening the invoice. Slackbot, Discordbot, Twitterbot,
 *     WhatsApp, Telegram, Facebook external hits, plus generic
 *     googlebot/bingbot UAs and a no-UA short-circuit. Conservative on
 *     purpose: a false-negative (we count a bot) erodes signal trust
 *     slowly; a false-positive (we skip a real client) breaks the
 *     feature outright. The classifier therefore only matches well-
 *     known automated UA substrings.
 *
 *   formatViewedAgo({ firstViewedAt, lastViewedAt, viewCount }, now) —
 *     dashboard-safe short string like "Viewed 3h ago", "Viewed 2×
 *     (last 5m ago)" or null when never viewed. `now` is injectable
 *     so tests stay deterministic. Times below 60s collapse to "just
 *     now". Counts > 1 surface the count to reward the freelancer for
 *     a forward-the-email follow-through (multiple opens = the client
 *     looked twice, a strong "they're considering it" signal).
 */

const BOT_UA_SUBSTRINGS = [
  'bot', 'spider', 'crawler', 'crawl',
  'slackbot', 'discordbot', 'twitterbot', 'linkedinbot',
  'facebookexternalhit', 'whatsapp', 'telegrambot', 'skypeuripreview',
  'redditbot', 'pinterest', 'embedly', 'curl/', 'wget/', 'python-requests',
  'go-http-client', 'okhttp', 'httpclient', 'headlesschrome', 'phantomjs',
  'preview', 'fetcher', 'monitor', 'uptimerobot', 'pingdom', 'site24x7'
];

function isLikelyBotUserAgent(ua) {
  if (!ua || typeof ua !== 'string') return true;
  const trimmed = ua.trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  for (const needle of BOT_UA_SUBSTRINGS) {
    if (lower.indexOf(needle) !== -1) return true;
  }
  return false;
}

function relativeAgo(deltaMs) {
  if (!Number.isFinite(deltaMs) || deltaMs < 0) deltaMs = 0;
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mon = Math.floor(day / 30);
  if (mon < 12) return `${mon}mo ago`;
  const yr = Math.floor(day / 365);
  return `${yr}y ago`;
}

function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v : null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

function formatViewedAgo(stats, now) {
  if (!stats || typeof stats !== 'object') return null;
  const first = toDate(stats.firstViewedAt || stats.first_viewed_at);
  if (!first) return null;
  const last = toDate(stats.lastViewedAt || stats.last_viewed_at) || first;
  const count = Number(stats.viewCount || stats.view_count || 1) || 1;
  const ref = now instanceof Date ? now : new Date();
  const lastAgo = relativeAgo(ref.getTime() - last.getTime());
  if (count <= 1) return `Viewed ${lastAgo}`;
  return `Viewed ${count}× (last ${lastAgo})`;
}

module.exports = {
  isLikelyBotUserAgent,
  formatViewedAgo,
  BOT_UA_SUBSTRINGS
};
