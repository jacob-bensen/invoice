'use strict';

/*
 * Last-login stamping (Milestone 1 — signup → first dashboard re-entry).
 *
 * Two surfaces:
 *
 *   - `stampLastLogin(db, userId)` — fire-and-forget wrapper called at the
 *     explicit re-entry points (POST /auth/login, GET /auth/magic/<token>,
 *     POST /auth/reset/<token>). Issues an unconditional UPDATE, swallows DB
 *     errors so a transient outage never blocks the redirect that follows.
 *
 *   - `bumpLastLoginMiddleware({ db, staleAfterMinutes })` — per-request
 *     Express middleware. For every authenticated request (req.session.user
 *     present) it calls db.bumpLastLoginIfStale, which only UPDATEs when the
 *     existing stamp is NULL or older than `staleAfterMinutes`. Throttling
 *     happens at the SQL layer so concurrent requests collapse cleanly. The
 *     middleware never blocks the request: the DB call is fire-and-forget,
 *     errors are caught and logged so a slow/down DB cannot stall every
 *     authenticated page load.
 *
 * Why both: the explicit-point stamp is the unambiguous "just signed in"
 * signal; the middleware catches users with still-valid sessions who return
 * via direct URL or a non-magic-link inbound link (e.g. a bookmarked
 * /dashboard). Without the middleware, a power user who never logs out would
 * have their last_login_at frozen at first signup forever, silently lying to
 * the activation-funnel report.
 *
 * We deliberately do NOT stamp during POST /auth/register's auto-signin —
 * registration is the signup itself, not a re-entry; the funnel's `returned`
 * stage must not collapse to "did the user complete signup?". The
 * middleware's stale-window threshold (default 4 hours) is wide enough that
 * the immediate post-signup dashboard load doesn't satisfy a "returned" gate
 * either: the user has to come back at least 4 hours later for the stamp to
 * bump, which matches the operator's intuition of "returned to the app".
 */

async function stampLastLogin(db, userId) {
  if (!db || typeof db.markLastLogin !== 'function') return { ok: false, reason: 'invalid_db' };
  if (!userId) return { ok: false, reason: 'invalid_user_id' };
  try {
    const row = await db.markLastLogin(userId);
    return { ok: true, row };
  } catch (err) {
    return { ok: false, reason: 'db_error', error: err && err.message };
  }
}

function bumpLastLoginMiddleware(opts) {
  const db = opts && opts.db;
  const staleAfterMinutes = opts && Number.isFinite(opts.staleAfterMinutes) && opts.staleAfterMinutes > 0
    ? Math.floor(opts.staleAfterMinutes)
    : 240;
  const log = (opts && opts.log) || console;
  return function (req, _res, next) {
    try {
      const user = req && req.session && req.session.user;
      if (user && user.id != null && db && typeof db.bumpLastLoginIfStale === 'function') {
        // Fire-and-forget. Never await — a slow DB must not block the request.
        db.bumpLastLoginIfStale(user.id, staleAfterMinutes)
          .catch((err) => {
            if (log && log.warn) log.warn('bumpLastLoginIfStale failed:', err && err.message);
          });
      }
    } catch (err) {
      if (log && log.warn) log.warn('bumpLastLoginMiddleware error:', err && err.message);
    }
    next();
  };
}

module.exports = {
  stampLastLogin,
  bumpLastLoginMiddleware,
  DEFAULT_STALE_AFTER_MINUTES: 240
};
