'use strict';

/*
 * Activation funnel — the observable signal that the Primary Objective in
 * master/PLAN.md ("maximize signup → first-sent-invoice activation rate") is
 * moving. Builds the cohort over a date window of signups and counts how many
 * have progressed to each downstream stage:
 *
 *   1. signed_up          users.created_at within window
 *   2. welcomed           welcome_email_sent_at IS NOT NULL
 *   3. created_real       invoice_count > 0 (the seed insert skips this bump
 *                         on purpose, so this counts users who created at
 *                         least one NON-seed invoice via /invoices/new)
 *   4. sent_one           has any invoice with status IN ('sent','paid','overdue')
 *   5. got_paid           first_paid_at IS NOT NULL
 *
 * One SQL round-trip per call — five COUNT(*) FILTER aggregates over a
 * single signup-cohort scan + one EXISTS subquery against invoices for the
 * "sent_one" stage. The conversion ratios are computed in JS so the SQL
 * stays tight and we can unit-test the percentage logic without a DB.
 *
 * Date-range contract:
 *   - parseDateRange(query) -> { fromIso, toIso, from: Date, to: Date }
 *   - defaults to the trailing 30 days when both/either bounds are absent
 *   - validates strict YYYY-MM-DD; rejects out-of-order or >365-day spans
 *   - upper bound is INCLUSIVE — fromDate <= created_at < toDate + 1 day
 *
 * The route gates on OPERATOR_EMAIL (env). When unset, the route 404s. When
 * the session user's email doesn't match (case-insensitive), the route 404s.
 * No /admin link is exposed in the nav — operator types the URL directly.
 */

const MAX_RANGE_DAYS = 365;
const DEFAULT_RANGE_DAYS = 30;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const STAGE_DEFS = [
  { key: 'signed_up',    label: 'Signed up',                  milestone: 'cohort'      },
  { key: 'welcomed',     label: 'Welcome email sent',         milestone: 'Milestone 1' },
  { key: 'created_real', label: 'Created a real invoice',     milestone: 'Milestone 2' },
  { key: 'sent_one',     label: 'Sent at least one invoice',  milestone: 'Milestone 3' },
  { key: 'got_paid',     label: 'Received first payment',     milestone: 'Milestone 4' }
];

function isIsoDate(s) {
  if (typeof s !== 'string' || !ISO_DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  // Reject 2026-02-31 etc. — Date silently rolls over to 2026-03-03.
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(d, n) {
  const out = new Date(d.getTime());
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}

/*
 * Parse the query-string date window. Defaults to the trailing 30 days
 * (today inclusive). On any validation failure returns { error: '<reason>' }
 * so the route can render a friendly form-error message without throwing.
 *
 * The `to` bound is INCLUSIVE on the calendar (a user typing `to=2026-05-16`
 * means "include all signups from May 16"), so we translate it to a strict
 * `< (to + 1 day)` upper-bound at the SQL layer.
 */
function parseDateRange(query, now) {
  const today = now || new Date();
  const todayIso = isoDate(today);
  const q = query || {};
  const fromRaw = typeof q.from === 'string' ? q.from.trim() : '';
  const toRaw = typeof q.to === 'string' ? q.to.trim() : '';

  let fromIso, toIso;
  if (!fromRaw && !toRaw) {
    toIso = todayIso;
    fromIso = isoDate(addDays(today, -(DEFAULT_RANGE_DAYS - 1)));
  } else if (fromRaw && !toRaw) {
    if (!isIsoDate(fromRaw)) return { error: 'invalid_from' };
    fromIso = fromRaw;
    toIso = todayIso;
  } else if (!fromRaw && toRaw) {
    if (!isIsoDate(toRaw)) return { error: 'invalid_to' };
    toIso = toRaw;
    fromIso = isoDate(addDays(new Date(toRaw + 'T00:00:00Z'), -(DEFAULT_RANGE_DAYS - 1)));
  } else {
    if (!isIsoDate(fromRaw)) return { error: 'invalid_from' };
    if (!isIsoDate(toRaw)) return { error: 'invalid_to' };
    fromIso = fromRaw;
    toIso = toRaw;
  }

  const fromDate = new Date(fromIso + 'T00:00:00Z');
  const toDate = new Date(toIso + 'T00:00:00Z');
  if (toDate.getTime() < fromDate.getTime()) return { error: 'range_out_of_order' };
  const spanDays = Math.floor((toDate.getTime() - fromDate.getTime()) / 86400000) + 1;
  if (spanDays > MAX_RANGE_DAYS) return { error: 'range_too_wide' };

  return {
    fromIso,
    toIso,
    from: fromDate,
    // Upper bound is exclusive at the SQL layer: < (to + 1 day) so the full
    // calendar day named in `to` is included.
    toExclusive: addDays(toDate, 1),
    spanDays
  };
}

/*
 * Run the funnel query against the supplied db (or a stub that exposes
 * `query`). Returns the raw stage counts in the same shape the report
 * renderer consumes.
 */
async function loadFunnelCounts(db, range) {
  if (!db || typeof db.query !== 'function') {
    throw new Error('loadFunnelCounts requires a db with a query() method');
  }
  if (!range || !range.from || !range.toExclusive) {
    throw new Error('loadFunnelCounts requires a parsed range');
  }
  const { rows } = await db.query(
    `SELECT
       COUNT(*)::int                                                                    AS signed_up,
       COUNT(*) FILTER (WHERE welcome_email_sent_at IS NOT NULL)::int                   AS welcomed,
       COUNT(*) FILTER (WHERE invoice_count > 0)::int                                   AS created_real,
       COUNT(*) FILTER (WHERE id IN (
         SELECT user_id FROM invoices WHERE status IN ('sent','paid','overdue')
       ))::int                                                                          AS sent_one,
       COUNT(*) FILTER (WHERE first_paid_at IS NOT NULL)::int                           AS got_paid
       FROM users
      WHERE created_at >= $1 AND created_at < $2`,
    [range.from, range.toExclusive]
  );
  const r = rows[0] || {};
  return {
    signed_up:    parseInt(r.signed_up,    10) || 0,
    welcomed:     parseInt(r.welcomed,     10) || 0,
    created_real: parseInt(r.created_real, 10) || 0,
    sent_one:     parseInt(r.sent_one,     10) || 0,
    got_paid:     parseInt(r.got_paid,     10) || 0
  };
}

/*
 * Turn raw counts into stage rows with conversion ratios. The first ratio
 * column is "from previous stage" (so welcomed/signed_up, then
 * created_real/welcomed, etc.) and the second is "from cohort"
 * (everything / signed_up). When signed_up is zero, ratios are null.
 */
function buildStageRows(counts) {
  const signups = counts.signed_up || 0;
  let prev = signups;
  return STAGE_DEFS.map((def, idx) => {
    const value = counts[def.key] || 0;
    const fromPrev = idx === 0 ? null : (prev > 0 ? value / prev : null);
    const fromCohort = idx === 0 ? null : (signups > 0 ? value / signups : null);
    const row = {
      key: def.key,
      label: def.label,
      milestone: def.milestone,
      count: value,
      conversionFromPrev: fromPrev,
      conversionFromCohort: fromCohort
    };
    prev = value;
    return row;
  });
}

function formatPct(ratio) {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—';
  return (ratio * 100).toFixed(1) + '%';
}

/*
 * High-level helper used by the route. Returns the data payload the JSON
 * and HTML responders both consume. Throws on SQL failure so the route can
 * render a 500 with context (no silent zero-row display).
 */
async function buildReport(db, query, now) {
  const range = parseDateRange(query, now);
  if (range.error) return { error: range.error };
  const counts = await loadFunnelCounts(db, range);
  const stages = buildStageRows(counts);
  return {
    range: {
      from: range.fromIso,
      to:   range.toIso,
      days: range.spanDays
    },
    cohortSize: counts.signed_up,
    stages,
    generatedAt: (now || new Date()).toISOString()
  };
}

/*
 * Operator-gate: returns true only when OPERATOR_EMAIL is set and the
 * supplied user has that email (case-insensitive). When the env var is
 * unset, EVERY request is rejected — the report stays invisible until an
 * operator explicitly opts in.
 */
function isOperator(user) {
  const expected = (process.env.OPERATOR_EMAIL || '').trim().toLowerCase();
  if (!expected) return false;
  const actual = user && typeof user.email === 'string' ? user.email.trim().toLowerCase() : '';
  if (!actual) return false;
  return actual === expected;
}

module.exports = {
  parseDateRange,
  loadFunnelCounts,
  buildStageRows,
  buildReport,
  formatPct,
  isOperator,
  STAGE_DEFS,
  MAX_RANGE_DAYS,
  DEFAULT_RANGE_DAYS
};
