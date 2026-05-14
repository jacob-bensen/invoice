'use strict';

/*
 * Cached "active Pro subscribers" count for the trial-urgent banner
 * social-proof anchor (#135). The dashboard banner renders once per
 * dashboard load per trial user; without a cache the COUNT(*) query
 * would fire on every dashboard render. The cache is process-local
 * (no Redis dependency) with a 1-hour TTL — fresh-enough for a
 * social-proof line whose magnitude moves slowly, cheap enough that
 * a single Heroku dyno restart is the only invalidation path needed.
 *
 * Threshold rule: the "Join N freelancers on Pro" anchor is only
 * persuasive once N is large enough to feel like a crowd. Below
 * SOCIAL_PROOF_THRESHOLD the helper returns { count: null,
 * fallback: '<static copy>' } so the view renders a static-copy
 * variant instead of a small, anti-persuasive number. The same
 * fallback fires when the DB lookup throws — we never want a
 * count-display failure to take down the dashboard banner.
 */

const ONE_HOUR_MS = 60 * 60 * 1000;
const SOCIAL_PROOF_THRESHOLD = 50;
const STATIC_FALLBACK_COPY = 'Join the freelancers who locked in Pro this week';

const state = {
  count: null,
  fetchedAt: 0,
  inFlight: null
};

function shouldRefresh(now) {
  if (state.count === null) return true;
  return now - state.fetchedAt > ONE_HOUR_MS;
}

async function loadProSubscriberCount(db, now) {
  const ref = typeof now === 'number' ? now : Date.now();
  if (!shouldRefresh(ref)) {
    return buildShape(state.count);
  }
  if (state.inFlight) {
    try { await state.inFlight; } catch (_) { /* swallow — handled below */ }
    return buildShape(state.count);
  }
  state.inFlight = (async () => {
    try {
      const n = await db.countActiveProSubscribers();
      state.count = Number.isFinite(n) ? n : 0;
      state.fetchedAt = ref;
    } catch (err) {
      console.error('Pro subscriber count lookup failed:', err && err.message);
      // Leave state.count alone — a previously-cached value beats a
      // null after a transient DB blip. If state.count was already null
      // (first-ever load), buildShape(null) returns the static fallback.
    } finally {
      state.inFlight = null;
    }
  })();
  await state.inFlight;
  return buildShape(state.count);
}

function buildShape(count) {
  if (!Number.isFinite(count) || count < SOCIAL_PROOF_THRESHOLD) {
    return { count: null, fallback: STATIC_FALLBACK_COPY };
  }
  return { count, fallback: null };
}

function _resetForTests() {
  state.count = null;
  state.fetchedAt = 0;
  state.inFlight = null;
}

module.exports = {
  loadProSubscriberCount,
  SOCIAL_PROOF_THRESHOLD,
  STATIC_FALLBACK_COPY,
  ONE_HOUR_MS,
  _resetForTests
};
