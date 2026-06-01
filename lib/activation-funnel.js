'use strict';

/*
 * Activation funnel — the observable signal that the Primary Objective in
 * master/PLAN.md ("maximize signup → first-sent-invoice activation rate") is
 * moving. Builds the cohort over a date window of signups and counts how many
 * have progressed to each downstream stage:
 *
 *   1. signed_up          users.created_at within window
 *   2. welcomed           welcome_email_sent_at IS NOT NULL
 *   3. returned           last_login_at IS NOT NULL — the user came back to
 *                         the app after signup (PLAN.md "Done means" names
 *                         this stage explicitly). last_login_at is stamped
 *                         on explicit re-entry (login / magic-link consume /
 *                         password-reset consume) and via a throttled
 *                         per-request middleware (4h stale window) so users
 *                         with still-valid sessions returning via direct URL
 *                         also count.
 *   4. created_real       invoice_count > 0 (the seed insert skips this bump
 *                         on purpose, so this counts users who created at
 *                         least one NON-seed invoice via /invoices/new)
 *   5. sent_one           has any invoice with status IN ('sent','paid','overdue')
 *   6. got_paid           first_paid_at IS NOT NULL
 *
 * One SQL round-trip per call — six COUNT(*) FILTER aggregates over a
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
  { key: 'returned',     label: 'Returned to app',            milestone: 'Milestone 1' },
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
       COUNT(*) FILTER (WHERE last_login_at IS NOT NULL)::int                           AS returned,
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
    returned:     parseInt(r.returned,     10) || 0,
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
 * Per-day signup-cohort breakdown. PLAN.md "Done means" names "positive
 * day-over-day flow at every step" as the observable signal — the
 * window-aggregate stages view can't surface that, since a cohort with an
 * older bias would mask a recent activation regression (or vice versa).
 * This helper runs one extra SQL round-trip that GROUPs the same six
 * filtered aggregates by `DATE_TRUNC('day', created_at AT TIME ZONE 'UTC')`,
 * yielding one row per signup day in the range. The UTC truncation pins
 * the day boundary to a stable wall-clock regardless of server timezone.
 * Returns rows ordered newest-first so the operator's eye lands on the
 * latest cohort.
 */
async function loadFunnelByDay(db, range) {
  if (!db || typeof db.query !== 'function') {
    throw new Error('loadFunnelByDay requires a db with a query() method');
  }
  if (!range || !range.from || !range.toExclusive) {
    throw new Error('loadFunnelByDay requires a parsed range');
  }
  const { rows } = await db.query(
    `SELECT
       to_char(DATE_TRUNC('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD')        AS day,
       COUNT(*)::int                                                                   AS signed_up,
       COUNT(*) FILTER (WHERE welcome_email_sent_at IS NOT NULL)::int                  AS welcomed,
       COUNT(*) FILTER (WHERE last_login_at IS NOT NULL)::int                          AS returned,
       COUNT(*) FILTER (WHERE invoice_count > 0)::int                                  AS created_real,
       COUNT(*) FILTER (WHERE id IN (
         SELECT user_id FROM invoices WHERE status IN ('sent','paid','overdue')
       ))::int                                                                         AS sent_one,
       COUNT(*) FILTER (WHERE first_paid_at IS NOT NULL)::int                          AS got_paid
       FROM users
      WHERE created_at >= $1 AND created_at < $2
      GROUP BY 1
      ORDER BY 1 DESC`,
    [range.from, range.toExclusive]
  );
  return (rows || []).map((r) => ({
    day:          typeof r.day === 'string' ? r.day : '',
    signed_up:    parseInt(r.signed_up,    10) || 0,
    welcomed:     parseInt(r.welcomed,     10) || 0,
    returned:     parseInt(r.returned,     10) || 0,
    created_real: parseInt(r.created_real, 10) || 0,
    sent_one:     parseInt(r.sent_one,     10) || 0,
    got_paid:     parseInt(r.got_paid,     10) || 0
  }));
}

/*
 * Fold raw per-day rows into render-ready shapes with the
 * sent_one/signed_up ratio (the Primary Objective's terminal funnel
 * conversion) precomputed. Days with zero signups still surface as rows
 * (defence-in-depth — the SQL GROUP BY skips zero days but a future query
 * change could surface them).
 */
function buildDailyRows(rawDays) {
  const list = Array.isArray(rawDays) ? rawDays : [];
  return list.map((r) => {
    const signups = r.signed_up || 0;
    const sentOne = r.sent_one || 0;
    return {
      day:          r.day || '',
      signed_up:    signups,
      welcomed:     r.welcomed     || 0,
      returned:     r.returned     || 0,
      created_real: r.created_real || 0,
      sent_one:     sentOne,
      got_paid:     r.got_paid     || 0,
      sentRate:     signups > 0 ? sentOne / signups : null
    };
  });
}

/*
 * Per-source signup-cohort breakdown. The aggregate stages + per-day rows
 * answer "what's the funnel and is it moving day-over-day", but they
 * can't answer "which acquisition channel produces converting users vs.
 * tire-kickers" — a question the operator needs to lift activation by
 * doubling down on high-converting sources and pulling spend / SEO
 * effort from low-converting ones. This helper runs one SQL round-trip
 * GROUPing the same six FILTER aggregates by `COALESCE(signup_source,
 * 'direct')` so unattributed signups (direct typing of the URL, expired
 * referrer header, blocked utm capture) fold into a single `'direct'`
 * bucket instead of producing a noisy NULL row. Rows are ordered by
 * signup count DESC so the largest-volume source surfaces first.
 */
async function loadFunnelBySource(db, range) {
  if (!db || typeof db.query !== 'function') {
    throw new Error('loadFunnelBySource requires a db with a query() method');
  }
  if (!range || !range.from || !range.toExclusive) {
    throw new Error('loadFunnelBySource requires a parsed range');
  }
  const { rows } = await db.query(
    `SELECT
       COALESCE(signup_source, 'direct')                                                AS source,
       COUNT(*)::int                                                                    AS signed_up,
       COUNT(*) FILTER (WHERE welcome_email_sent_at IS NOT NULL)::int                   AS welcomed,
       COUNT(*) FILTER (WHERE last_login_at IS NOT NULL)::int                           AS returned,
       COUNT(*) FILTER (WHERE invoice_count > 0)::int                                   AS created_real,
       COUNT(*) FILTER (WHERE id IN (
         SELECT user_id FROM invoices WHERE status IN ('sent','paid','overdue')
       ))::int                                                                          AS sent_one,
       COUNT(*) FILTER (WHERE first_paid_at IS NOT NULL)::int                           AS got_paid
       FROM users
      WHERE created_at >= $1 AND created_at < $2
      GROUP BY 1
      ORDER BY signed_up DESC, source ASC`,
    [range.from, range.toExclusive]
  );
  return (rows || []).map((r) => ({
    source:       typeof r.source === 'string' ? r.source : 'direct',
    signed_up:    parseInt(r.signed_up,    10) || 0,
    welcomed:     parseInt(r.welcomed,     10) || 0,
    returned:     parseInt(r.returned,     10) || 0,
    created_real: parseInt(r.created_real, 10) || 0,
    sent_one:     parseInt(r.sent_one,     10) || 0,
    got_paid:     parseInt(r.got_paid,     10) || 0
  }));
}

/*
 * Fold raw per-source rows into render-ready shapes. Precomputes the
 * `sentRate = sent_one / signed_up` per source (the Primary Objective's
 * terminal funnel conversion) so the operator can scan a single column
 * to rank sources by activation. Zero-signup rows surface `sentRate=null`
 * so the view renders an em-dash rather than NaN. Non-array input is
 * tolerated (returns []) so a transient SQL failure on the source query
 * can't 500 the whole report.
 */
function buildSourceRows(rawSources) {
  const list = Array.isArray(rawSources) ? rawSources : [];
  return list.map((r) => {
    const signups = r.signed_up || 0;
    const sentOne = r.sent_one || 0;
    return {
      source:       r.source || 'direct',
      signed_up:    signups,
      welcomed:     r.welcomed     || 0,
      returned:     r.returned     || 0,
      created_real: r.created_real || 0,
      sent_one:     sentOne,
      got_paid:     r.got_paid     || 0,
      sentRate:     signups > 0 ? sentOne / signups : null
    };
  });
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
  const rawDays = await loadFunnelByDay(db, range);
  const daily = buildDailyRows(rawDays);
  const rawSources = await loadFunnelBySource(db, range);
  const bySource = buildSourceRows(rawSources);
  return {
    range: {
      from: range.fromIso,
      to:   range.toIso,
      days: range.spanDays
    },
    cohortSize: counts.signed_up,
    stages,
    daily,
    bySource,
    generatedAt: (now || new Date()).toISOString()
  };
}

/*
 * RFC 4180 CSV cell escape. Quote-wraps cells that contain a comma, a
 * double-quote, a CR, or an LF; doubles any embedded double-quotes. Numbers
 * pass through stringified. null/undefined render as an empty cell.
 *
 * This is the entire safety surface for the CSV export — a future stage
 * addition whose label or source name contains a comma (e.g. "Plausible,
 * UTM") must not silently break the column count.
 */
function csvEscape(value) {
  if (value === null || value === undefined) return '';
  let s;
  if (typeof value === 'number') {
    s = Number.isFinite(value) ? String(value) : '';
  } else if (typeof value === 'boolean') {
    s = value ? 'true' : 'false';
  } else {
    s = String(value);
  }
  if (s === '') return '';
  if (/[",\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/*
 * Render a built report (the same shape `buildReport` returns) as a single
 * CSV payload covering all three sections — stages, daily, bySource —
 * separated by blank lines so an operator pasting into a spreadsheet sees
 * the headings + cohort context once and then three labelled tables they
 * can split into sheets.
 *
 * Ratios that are null (zero-cohort / first-stage rows) render as empty
 * cells rather than '—' so spreadsheets parse the column as a number type.
 * The cohort header (window + cohortSize + generatedAt) sits at the very
 * top so a saved CSV doesn't lose the date-range context when filed away.
 */
function ratioCell(r) {
  if (r === null || r === undefined || !Number.isFinite(r)) return '';
  return r.toFixed(4);
}

function buildReportCsv(report) {
  if (!report || report.error || !report.range) {
    throw new Error('buildReportCsv requires a successful report');
  }
  const lines = [];
  lines.push('# DecentInvoice activation funnel');
  lines.push('window_from,window_to,window_days,cohort_size,generated_at');
  lines.push([
    csvEscape(report.range.from),
    csvEscape(report.range.to),
    csvEscape(report.range.days),
    csvEscape(report.cohortSize),
    csvEscape(report.generatedAt)
  ].join(','));
  lines.push('');

  // Section 1 — stage rollup (one row per pipeline stage).
  lines.push('# Stages');
  lines.push('stage_key,stage_label,milestone,users,conversion_from_prev,conversion_from_cohort');
  for (const s of (report.stages || [])) {
    lines.push([
      csvEscape(s.key),
      csvEscape(s.label),
      csvEscape(s.milestone),
      csvEscape(s.count),
      ratioCell(s.conversionFromPrev),
      ratioCell(s.conversionFromCohort)
    ].join(','));
  }
  lines.push('');

  // Section 2 — per-day cohort breakdown (the PLAN.md "positive day-over-
  // day flow" signal). Newest day first matches the HTML report ordering.
  lines.push('# Daily signup cohorts');
  lines.push('day,signed_up,welcomed,returned,created_real,sent_one,got_paid,sent_rate');
  for (const d of (report.daily || [])) {
    lines.push([
      csvEscape(d.day),
      csvEscape(d.signed_up),
      csvEscape(d.welcomed),
      csvEscape(d.returned),
      csvEscape(d.created_real),
      csvEscape(d.sent_one),
      csvEscape(d.got_paid),
      ratioCell(d.sentRate)
    ].join(','));
  }
  lines.push('');

  // Section 3 — by-source breakdown (acquisition channel ranking).
  lines.push('# By signup source');
  lines.push('source,signed_up,welcomed,returned,created_real,sent_one,got_paid,sent_rate');
  for (const r of (report.bySource || [])) {
    lines.push([
      csvEscape(r.source),
      csvEscape(r.signed_up),
      csvEscape(r.welcomed),
      csvEscape(r.returned),
      csvEscape(r.created_real),
      csvEscape(r.sent_one),
      csvEscape(r.got_paid),
      ratioCell(r.sentRate)
    ].join(','));
  }

  // RFC 4180 says lines end in CRLF. Many spreadsheets accept LF, but
  // Windows Excel still prefers CRLF — emitting both keeps both happy.
  return lines.join('\r\n') + '\r\n';
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
  loadFunnelByDay,
  loadFunnelBySource,
  buildStageRows,
  buildDailyRows,
  buildSourceRows,
  buildReport,
  buildReportCsv,
  csvEscape,
  formatPct,
  isOperator,
  STAGE_DEFS,
  MAX_RANGE_DAYS,
  DEFAULT_RANGE_DAYS
};
