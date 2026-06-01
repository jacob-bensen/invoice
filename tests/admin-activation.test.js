'use strict';

/*
 * Activation funnel report (BACKLOG: operator activation funnel at
 * /admin/activation). Covers:
 *
 *   - lib/activation-funnel:
 *       parseDateRange defaults to the trailing 30 days
 *       parseDateRange accepts a YYYY-MM-DD pair
 *       parseDateRange rejects malformed dates / out-of-order / >365-day spans
 *       loadFunnelCounts issues the right SQL params and parses string ints
 *       loadFunnelByDay issues a GROUP BY day SQL + parses string ints + DESC
 *       loadFunnelByDay tolerates empty + null rows and throws on missing args
 *       buildDailyRows shape + sentRate; zero-signup day yields null; non-array → []
 *       buildStageRows computes from-previous and from-cohort ratios
 *       buildStageRows yields null ratios on a zero cohort (no NaN leak)
 *       formatPct renders 12.3% / — for null
 *       isOperator gates on OPERATOR_EMAIL (env unset → false; mismatch → false;
 *         exact + case-insensitive match → true)
 *       buildReport returns { error } on bad input without throwing
 *       buildReport returns the cohort + stages payload on the happy path
 *
 *   - routes/admin (integration via in-memory db stub):
 *       GET /admin/activation       404 when no session
 *       GET /admin/activation       404 when OPERATOR_EMAIL unset (operator gate closed)
 *       GET /admin/activation       404 when session user mismatches OPERATOR_EMAIL
 *       GET /admin/activation       200 + HTML report for operator
 *       GET /admin/activation.json  200 + JSON for operator
 *       GET /admin/activation.json  404 + JSON error for non-operator
 *       GET /admin/activation       400 for invalid date input
 *       GET /admin/activation       500 surfaces a SQL throw without crashing the route
 *       robots.txt blocks /admin/
 *
 * Run: NODE_ENV=test node tests/admin-activation.test.js
 */

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

const assert = require('assert');
const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');

function clearReq(mod) { delete require.cache[require.resolve(mod)]; }

// ---------- Lib-level tests -------------------------------------------------

function isoDate(d) { return d.toISOString().slice(0, 10); }
function addDays(d, n) {
  const out = new Date(d.getTime());
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}

async function testParseDateRangeDefaultsToTrailing30Days() {
  clearReq('../lib/activation-funnel');
  const { parseDateRange } = require('../lib/activation-funnel');
  const now = new Date('2026-05-16T12:34:56Z');
  const r = parseDateRange({}, now);
  assert.strictEqual(r.error, undefined, 'no error on empty query');
  assert.strictEqual(r.toIso, '2026-05-16', 'default `to` is today');
  assert.strictEqual(r.fromIso, '2026-04-17', 'default `from` is today - 29 days (30-day window inclusive)');
  assert.strictEqual(r.spanDays, 30);
  // toExclusive is the day AFTER `to` so SQL < toExclusive includes the full
  // calendar day named in `to`.
  assert.strictEqual(isoDate(r.toExclusive), '2026-05-17');
}

async function testParseDateRangeAcceptsValidPair() {
  clearReq('../lib/activation-funnel');
  const { parseDateRange } = require('../lib/activation-funnel');
  const r = parseDateRange({ from: '2026-05-01', to: '2026-05-10' }, new Date('2026-05-16T00:00:00Z'));
  assert.strictEqual(r.error, undefined);
  assert.strictEqual(r.fromIso, '2026-05-01');
  assert.strictEqual(r.toIso, '2026-05-10');
  assert.strictEqual(r.spanDays, 10);
}

async function testParseDateRangeRejectsBadFormat() {
  clearReq('../lib/activation-funnel');
  const { parseDateRange } = require('../lib/activation-funnel');
  assert.strictEqual(
    parseDateRange({ from: '05/01/2026', to: '2026-05-10' }, new Date()).error,
    'invalid_from'
  );
  assert.strictEqual(
    parseDateRange({ from: '2026-05-01', to: 'tomorrow' }, new Date()).error,
    'invalid_to'
  );
  assert.strictEqual(
    parseDateRange({ from: '2026-02-31', to: '2026-05-10' }, new Date()).error,
    'invalid_from',
    'Feb 31 must be rejected (rolls over silently in JS Date)'
  );
}

async function testParseDateRangeRejectsOutOfOrder() {
  clearReq('../lib/activation-funnel');
  const { parseDateRange } = require('../lib/activation-funnel');
  assert.strictEqual(
    parseDateRange({ from: '2026-05-10', to: '2026-05-01' }, new Date()).error,
    'range_out_of_order'
  );
}

async function testParseDateRangeRejectsTooWide() {
  clearReq('../lib/activation-funnel');
  const { parseDateRange } = require('../lib/activation-funnel');
  // 367-day span > 365 cap
  assert.strictEqual(
    parseDateRange({ from: '2025-05-15', to: '2026-05-16' }, new Date()).error,
    'range_too_wide'
  );
  // Exactly 365 days is OK
  assert.strictEqual(
    parseDateRange({ from: '2025-05-16', to: '2026-05-15' }, new Date()).error,
    undefined,
    '365-day window must be allowed (cap is inclusive)'
  );
}

async function testLoadFunnelCountsIssuesRightSql() {
  clearReq('../lib/activation-funnel');
  const { loadFunnelCounts, parseDateRange } = require('../lib/activation-funnel');
  const range = parseDateRange({ from: '2026-05-01', to: '2026-05-10' }, new Date());
  const calls = [];
  const fakeDb = {
    async query(sql, params) {
      calls.push({ sql, params });
      return {
        rows: [{
          signed_up: '7',
          welcomed: '6',
          returned: '5',
          created_real: '4',
          sent_one: 3,
          got_paid: 1
        }]
      };
    }
  };
  const counts = await loadFunnelCounts(fakeDb, range);
  assert.strictEqual(calls.length, 1, 'must hit the DB exactly once');
  assert.ok(/FROM users/i.test(calls[0].sql), 'SQL must scan users');
  assert.ok(/created_at >= \$1 AND created_at < \$2/.test(calls[0].sql),
    'WHERE clause must bound by created_at on parameterised range');
  assert.ok(/welcome_email_sent_at IS NOT NULL/.test(calls[0].sql),
    'must aggregate welcomed via welcome_email_sent_at');
  assert.ok(/last_login_at IS NOT NULL/.test(calls[0].sql),
    'must aggregate returned via last_login_at (the post-signup re-entry stamp)');
  assert.ok(/invoice_count > 0/.test(calls[0].sql),
    'must aggregate created_real via invoice_count (seed inserts skip the bump)');
  assert.ok(/status IN \('sent','paid','overdue'\)/.test(calls[0].sql),
    'sent_one must subquery invoices for any post-draft status');
  assert.ok(/first_paid_at IS NOT NULL/.test(calls[0].sql),
    'got_paid must aggregate via first_paid_at (idempotent stamp)');
  assert.strictEqual(calls[0].params.length, 2, 'must pass exactly 2 SQL params (from, toExclusive)');
  assert.strictEqual(isoDate(calls[0].params[0]), '2026-05-01', 'param 1 is inclusive `from`');
  assert.strictEqual(isoDate(calls[0].params[1]), '2026-05-11', 'param 2 is exclusive (to + 1 day)');
  assert.deepStrictEqual(counts, {
    signed_up: 7, welcomed: 6, returned: 5, created_real: 4, sent_one: 3, got_paid: 1
  });
}

async function testBuildStageRowsComputesRatios() {
  clearReq('../lib/activation-funnel');
  const { buildStageRows } = require('../lib/activation-funnel');
  const rows = buildStageRows({
    signed_up: 100, welcomed: 80, returned: 60, created_real: 40, sent_one: 30, got_paid: 10
  });
  assert.strictEqual(rows.length, 6, 'returned stage adds a 6th row between welcomed and created_real');
  assert.strictEqual(rows[0].key, 'signed_up');
  assert.strictEqual(rows[0].count, 100);
  assert.strictEqual(rows[0].conversionFromPrev, null,
    'first stage has no previous-stage ratio');
  assert.strictEqual(rows[0].conversionFromCohort, null,
    'first stage is the cohort definition — ratio to itself omitted');

  assert.strictEqual(rows[1].key, 'welcomed');
  assert.strictEqual(rows[1].conversionFromPrev, 0.8, 'welcomed/signed_up = 80/100');
  assert.strictEqual(rows[1].conversionFromCohort, 0.8);

  assert.strictEqual(rows[2].key, 'returned');
  assert.strictEqual(rows[2].conversionFromPrev, 0.75, 'returned/welcomed = 60/80');
  assert.strictEqual(rows[2].conversionFromCohort, 0.6);

  assert.strictEqual(rows[3].key, 'created_real');
  assert.ok(Math.abs(rows[3].conversionFromPrev - (40 / 60)) < 1e-9,
    'created_real/returned = 40/60');
  assert.strictEqual(rows[3].conversionFromCohort, 0.4);

  assert.strictEqual(rows[4].key, 'sent_one');
  assert.strictEqual(rows[4].conversionFromPrev, 0.75, 'sent_one/created_real = 30/40');
  assert.strictEqual(rows[4].conversionFromCohort, 0.3);

  assert.strictEqual(rows[5].key, 'got_paid');
  assert.ok(Math.abs(rows[5].conversionFromPrev - 0.3333333333333333) < 1e-9,
    'got_paid/sent_one = 10/30');
  assert.strictEqual(rows[5].conversionFromCohort, 0.1);
}

async function testBuildStageRowsZeroCohortNoNaN() {
  clearReq('../lib/activation-funnel');
  const { buildStageRows } = require('../lib/activation-funnel');
  const rows = buildStageRows({
    signed_up: 0, welcomed: 0, returned: 0, created_real: 0, sent_one: 0, got_paid: 0
  });
  for (const r of rows) {
    assert.strictEqual(r.count, 0);
    assert.strictEqual(r.conversionFromPrev === null || r.conversionFromPrev === undefined, true,
      `${r.key} must have null conversionFromPrev on zero cohort (got ${r.conversionFromPrev})`);
    assert.strictEqual(r.conversionFromCohort === null || r.conversionFromCohort === undefined, true,
      `${r.key} must have null conversionFromCohort on zero cohort`);
  }
}

async function testReturnedStageOrderAndMilestoneLabel() {
  clearReq('../lib/activation-funnel');
  const { STAGE_DEFS } = require('../lib/activation-funnel');
  // Lock in the canonical 6-stage order so a future edit that re-orders
  // (e.g. accidentally moves returned after created_real) fails loudly.
  assert.deepStrictEqual(
    STAGE_DEFS.map((s) => s.key),
    ['signed_up', 'welcomed', 'returned', 'created_real', 'sent_one', 'got_paid'],
    'STAGE_DEFS must match the PLAN.md "Done means" ordering: signups → welcomed → re-entered → created → sent → paid'
  );
  const returnedDef = STAGE_DEFS.find((s) => s.key === 'returned');
  assert.ok(returnedDef, 'returned stage must be present');
  assert.strictEqual(returnedDef.label, 'Returned to app',
    'human-readable label is what shows on the operator report');
  assert.strictEqual(returnedDef.milestone, 'Milestone 1',
    'returned advances Milestone 1 (signup → first dashboard re-entry)');
}

async function testFormatPct() {
  clearReq('../lib/activation-funnel');
  const { formatPct } = require('../lib/activation-funnel');
  assert.strictEqual(formatPct(0.1234), '12.3%');
  assert.strictEqual(formatPct(1), '100.0%');
  assert.strictEqual(formatPct(0), '0.0%');
  assert.strictEqual(formatPct(null), '—');
  assert.strictEqual(formatPct(undefined), '—');
  assert.strictEqual(formatPct(NaN), '—');
}

async function testIsOperator() {
  clearReq('../lib/activation-funnel');
  const old = process.env.OPERATOR_EMAIL;
  delete process.env.OPERATOR_EMAIL;
  const { isOperator } = require('../lib/activation-funnel');
  assert.strictEqual(
    isOperator({ email: 'anyone@x.com' }), false,
    'env unset → gate closed even for an existing session'
  );
  process.env.OPERATOR_EMAIL = 'op@x.com';
  assert.strictEqual(isOperator(null), false, 'null user → false');
  assert.strictEqual(isOperator({}), false, 'user with no email → false');
  assert.strictEqual(isOperator({ email: 'someone@x.com' }), false, 'mismatch → false');
  assert.strictEqual(isOperator({ email: 'op@x.com' }), true, 'exact match → true');
  assert.strictEqual(isOperator({ email: 'OP@X.COM' }), true, 'case-insensitive match');
  assert.strictEqual(isOperator({ email: '  op@x.com  ' }), true, 'trims whitespace');
  process.env.OPERATOR_EMAIL = '  OP@X.com  ';
  assert.strictEqual(isOperator({ email: 'op@x.com' }), true, 'env value normalised too');
  if (old === undefined) delete process.env.OPERATOR_EMAIL; else process.env.OPERATOR_EMAIL = old;
}

async function testBuildReportErrorPath() {
  clearReq('../lib/activation-funnel');
  const { buildReport } = require('../lib/activation-funnel');
  const fakeDb = { query: async () => { throw new Error('should not be called'); } };
  const r = await buildReport(fakeDb, { from: 'bad' }, new Date());
  assert.strictEqual(r.error, 'invalid_from');
  assert.strictEqual(r.stages, undefined, 'no stages on error');
}

async function testBuildReportHappyPath() {
  clearReq('../lib/activation-funnel');
  const { buildReport } = require('../lib/activation-funnel');
  const fakeDb = {
    async query(sql) {
      if (/signup_source/i.test(sql)) {
        return { rows: [
          { source: 'google',        signed_up: 18, welcomed: 14, returned: 11, created_real: 7, sent_one: 5, got_paid: 2 },
          { source: 'direct',        signed_up: 12, welcomed: 10, returned: 7,  created_real: 4, sent_one: 2, got_paid: 1 },
          { source: 'appsumo',       signed_up: 0,  welcomed: 0,  returned: 0,  created_real: 0, sent_one: 0, got_paid: 0 }
        ] };
      }
      if (/GROUP BY/i.test(sql)) {
        return { rows: [
          { day: '2026-05-10', signed_up: 30, welcomed: 22, returned: 18, created_real: 12, sent_one: 9, got_paid: 3 },
          { day: '2026-05-09', signed_up: 20, welcomed: 18, returned: 12, created_real: 8,  sent_one: 6, got_paid: 2 }
        ] };
      }
      return { rows: [{
        signed_up: 50, welcomed: 40, returned: 30, created_real: 20, sent_one: 15, got_paid: 5
      }] };
    }
  };
  const r = await buildReport(
    fakeDb,
    { from: '2026-05-01', to: '2026-05-10' },
    new Date('2026-05-16T00:00:00Z')
  );
  assert.strictEqual(r.error, undefined);
  assert.strictEqual(r.range.from, '2026-05-01');
  assert.strictEqual(r.range.to, '2026-05-10');
  assert.strictEqual(r.range.days, 10);
  assert.strictEqual(r.cohortSize, 50);
  assert.strictEqual(r.stages.length, 6);
  assert.strictEqual(r.stages[0].count, 50);
  assert.strictEqual(r.stages[2].key, 'returned');
  assert.strictEqual(r.stages[2].count, 30);
  assert.strictEqual(r.stages[5].count, 5);
  assert.ok(typeof r.generatedAt === 'string' && r.generatedAt.endsWith('Z'),
    'generatedAt must be ISO');
  assert.ok(Array.isArray(r.daily), 'report.daily must be an array');
  assert.strictEqual(r.daily.length, 2, 'two daily rows');
  assert.strictEqual(r.daily[0].day, '2026-05-10');
  assert.strictEqual(r.daily[0].signed_up, 30);
  assert.ok(Math.abs(r.daily[0].sentRate - (9 / 30)) < 1e-9,
    'sentRate computed per-day from sent_one / signed_up');
  assert.ok(Array.isArray(r.bySource), 'report.bySource must be an array');
  assert.strictEqual(r.bySource.length, 3);
  assert.strictEqual(r.bySource[0].source, 'google');
  assert.strictEqual(r.bySource[0].signed_up, 18);
  assert.ok(Math.abs(r.bySource[0].sentRate - (5 / 18)) < 1e-9,
    'sentRate per source = sent_one / signed_up');
  assert.strictEqual(r.bySource[2].sentRate, null,
    'zero-signup source row → null sentRate (no NaN)');
}

async function testLoadFunnelByDaySqlContract() {
  clearReq('../lib/activation-funnel');
  const { loadFunnelByDay, parseDateRange } = require('../lib/activation-funnel');
  const range = parseDateRange({ from: '2026-05-01', to: '2026-05-10' }, new Date());
  const calls = [];
  const fakeDb = {
    async query(sql, params) {
      calls.push({ sql, params });
      return {
        rows: [
          { day: '2026-05-10', signed_up: '3', welcomed: '2', returned: '1', created_real: '1', sent_one: 0, got_paid: 0 },
          { day: '2026-05-09', signed_up: 1,   welcomed: 1,   returned: 0,   created_real: 0,   sent_one: 0, got_paid: 0 }
        ]
      };
    }
  };
  const rows = await loadFunnelByDay(fakeDb, range);
  assert.strictEqual(calls.length, 1, 'one SQL round-trip for the per-day breakdown');
  const sql = calls[0].sql;
  assert.ok(/FROM users/i.test(sql), 'SQL must scan users');
  assert.ok(/GROUP BY/i.test(sql), 'must GROUP BY for per-day aggregation');
  assert.ok(/DATE_TRUNC\('day', created_at AT TIME ZONE 'UTC'\)/.test(sql),
    'must truncate to UTC day so buckets are TZ-stable');
  assert.ok(/to_char/i.test(sql),
    'must to_char the bucket so the result is a stable YYYY-MM-DD string regardless of pg client config');
  assert.ok(/ORDER BY .* DESC/i.test(sql),
    'must order newest-first so the operator eye lands on the latest cohort');
  assert.ok(/welcome_email_sent_at IS NOT NULL/.test(sql),
    'must aggregate welcomed (drift-guard: same six stages as loadFunnelCounts)');
  assert.ok(/last_login_at IS NOT NULL/.test(sql), 'must aggregate returned');
  assert.ok(/invoice_count > 0/.test(sql), 'must aggregate created_real');
  assert.ok(/status IN \('sent','paid','overdue'\)/.test(sql), 'must subquery invoices for sent_one');
  assert.ok(/first_paid_at IS NOT NULL/.test(sql), 'must aggregate got_paid');
  assert.strictEqual(calls[0].params.length, 2, 'two SQL params (from, toExclusive)');
  assert.strictEqual(isoDate(calls[0].params[0]), '2026-05-01');
  assert.strictEqual(isoDate(calls[0].params[1]), '2026-05-11');
  assert.deepStrictEqual(rows, [
    { day: '2026-05-10', signed_up: 3, welcomed: 2, returned: 1, created_real: 1, sent_one: 0, got_paid: 0 },
    { day: '2026-05-09', signed_up: 1, welcomed: 1, returned: 0, created_real: 0, sent_one: 0, got_paid: 0 }
  ]);
}

async function testLoadFunnelByDayHandlesEmptyAndNullRows() {
  clearReq('../lib/activation-funnel');
  const { loadFunnelByDay, parseDateRange } = require('../lib/activation-funnel');
  const range = parseDateRange({ from: '2026-05-01', to: '2026-05-10' }, new Date());
  // pg returns rows=[] when GROUP BY has no signups; the helper must
  // tolerate that (the route still renders, the view shows "no signups").
  const empty = await loadFunnelByDay({ async query() { return { rows: [] }; } }, range);
  assert.deepStrictEqual(empty, [], 'empty cohort returns empty array');
  // Null-rows defence-in-depth — a future pg driver upgrade that returns
  // { rows: null } shouldn't crash the report.
  const nullRows = await loadFunnelByDay({ async query() { return { rows: null }; } }, range);
  assert.deepStrictEqual(nullRows, []);
  // Missing range + missing db both throw — fail loud, not silent zeros.
  await assert.rejects(() => loadFunnelByDay(null, range), /requires a db/);
  await assert.rejects(() => loadFunnelByDay({ async query() {} }, null), /requires a parsed range/);
}

async function testLoadFunnelBySourceSqlContract() {
  clearReq('../lib/activation-funnel');
  const { loadFunnelBySource, parseDateRange } = require('../lib/activation-funnel');
  const range = parseDateRange({ from: '2026-05-01', to: '2026-05-10' }, new Date());
  const calls = [];
  const fakeDb = {
    async query(sql, params) {
      calls.push({ sql, params });
      return {
        rows: [
          { source: 'google',  signed_up: '5', welcomed: '4', returned: '3', created_real: '2', sent_one: '1', got_paid: '0' },
          { source: 'direct',  signed_up: 3,   welcomed: 2,   returned: 2,   created_real: 1,   sent_one: 1,   got_paid: 0 }
        ]
      };
    }
  };
  const rows = await loadFunnelBySource(fakeDb, range);
  assert.strictEqual(calls.length, 1, 'one SQL round-trip for the per-source breakdown');
  const sql = calls[0].sql;
  assert.ok(/FROM users/i.test(sql), 'SQL must scan users');
  assert.ok(/GROUP BY/i.test(sql), 'must GROUP BY for per-source aggregation');
  assert.ok(/COALESCE\(signup_source,\s*'direct'\)/.test(sql),
    "must COALESCE NULL signup_source to 'direct' so unattributed signups fold into one bucket");
  assert.ok(/ORDER BY signed_up DESC/i.test(sql),
    'must order by signup count DESC so the largest-volume source surfaces first');
  // Drift-guard: the same six stage aggregates that loadFunnelCounts uses
  // — a future stage addition to loadFunnelCounts must be added here too,
  // or the breakdown lies about the funnel.
  assert.ok(/welcome_email_sent_at IS NOT NULL/.test(sql), 'must aggregate welcomed');
  assert.ok(/last_login_at IS NOT NULL/.test(sql), 'must aggregate returned');
  assert.ok(/invoice_count > 0/.test(sql), 'must aggregate created_real');
  assert.ok(/status IN \('sent','paid','overdue'\)/.test(sql), 'must subquery invoices for sent_one');
  assert.ok(/first_paid_at IS NOT NULL/.test(sql), 'must aggregate got_paid');
  assert.strictEqual(calls[0].params.length, 2, 'two SQL params (from, toExclusive)');
  assert.strictEqual(isoDate(calls[0].params[0]), '2026-05-01');
  assert.strictEqual(isoDate(calls[0].params[1]), '2026-05-11');
  assert.deepStrictEqual(rows, [
    { source: 'google', signed_up: 5, welcomed: 4, returned: 3, created_real: 2, sent_one: 1, got_paid: 0 },
    { source: 'direct', signed_up: 3, welcomed: 2, returned: 2, created_real: 1, sent_one: 1, got_paid: 0 }
  ]);
}

async function testLoadFunnelBySourceHandlesEmptyAndNullRows() {
  clearReq('../lib/activation-funnel');
  const { loadFunnelBySource, parseDateRange } = require('../lib/activation-funnel');
  const range = parseDateRange({ from: '2026-05-01', to: '2026-05-10' }, new Date());
  const empty = await loadFunnelBySource({ async query() { return { rows: [] }; } }, range);
  assert.deepStrictEqual(empty, [], 'zero-cohort window returns empty array');
  const nullRows = await loadFunnelBySource({ async query() { return { rows: null }; } }, range);
  assert.deepStrictEqual(nullRows, []);
  await assert.rejects(() => loadFunnelBySource(null, range), /requires a db/);
  await assert.rejects(() => loadFunnelBySource({ async query() {} }, null), /requires a parsed range/);
}

async function testBuildSourceRowsShapeAndSentRate() {
  clearReq('../lib/activation-funnel');
  const { buildSourceRows } = require('../lib/activation-funnel');
  const rows = buildSourceRows([
    { source: 'google',  signed_up: 10, welcomed: 8, returned: 6, created_real: 4, sent_one: 2, got_paid: 1 },
    { source: 'appsumo', signed_up: 0,  welcomed: 0, returned: 0, created_real: 0, sent_one: 0, got_paid: 0 }
  ]);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].source, 'google');
  assert.strictEqual(rows[0].signed_up, 10);
  assert.strictEqual(rows[0].sentRate, 0.2, '2/10 = 0.2 sent rate for google');
  assert.strictEqual(rows[1].sentRate, null,
    'zero-signup source must yield null sentRate (no NaN — view renders em-dash)');
  assert.deepStrictEqual(buildSourceRows(null), []);
  assert.deepStrictEqual(buildSourceRows(undefined), []);
  assert.deepStrictEqual(buildSourceRows('not-an-array'), []);
}

async function testBuildDailyRowsShapeAndSentRate() {
  clearReq('../lib/activation-funnel');
  const { buildDailyRows } = require('../lib/activation-funnel');
  const rows = buildDailyRows([
    { day: '2026-05-10', signed_up: 10, welcomed: 8, returned: 6, created_real: 4, sent_one: 2, got_paid: 1 },
    { day: '2026-05-09', signed_up: 0,  welcomed: 0, returned: 0, created_real: 0, sent_one: 0, got_paid: 0 }
  ]);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].day, '2026-05-10');
  assert.strictEqual(rows[0].signed_up, 10);
  assert.strictEqual(rows[0].sent_one, 2);
  assert.strictEqual(rows[0].sentRate, 0.2, '2/10 = 0.2');
  assert.strictEqual(rows[1].signed_up, 0);
  assert.strictEqual(rows[1].sentRate, null,
    'zero-signup day must yield null sentRate so the view renders an em-dash, not NaN');
  // Non-array input is tolerated (returns []) — defence against a future
  // refactor that hands the helper a malformed payload.
  assert.deepStrictEqual(buildDailyRows(null), []);
  assert.deepStrictEqual(buildDailyRows(undefined), []);
  assert.deepStrictEqual(buildDailyRows('not-an-array'), []);
}

// ---------- Route integration tests -----------------------------------------

// In-memory query stub. The buildReport() helper issues TWO queries — one
// aggregate (loadFunnelCounts, no GROUP BY) + one per-day (loadFunnelByDay,
// GROUP BY DATE_TRUNC). The stub branches on the SQL so each test can set
// the aggregate row(s) AND the daily row(s) independently. `nextError`
// throws on the FIRST query (covers both helpers' error paths).
let nextRows = [];
let nextDailyRows = [];
let nextSourceRows = [];
let nextError = null;
const queryCalls = [];

function resetDbStub() {
  nextRows = [{
    signed_up: 12, welcomed: 9, returned: 7, created_real: 5, sent_one: 3, got_paid: 1
  }];
  nextDailyRows = [
    { day: '2026-05-15', signed_up: 7, welcomed: 6, returned: 5, created_real: 3, sent_one: 2, got_paid: 1 },
    { day: '2026-05-14', signed_up: 5, welcomed: 3, returned: 2, created_real: 2, sent_one: 1, got_paid: 0 }
  ];
  nextSourceRows = [
    { source: 'google', signed_up: 6, welcomed: 5, returned: 4, created_real: 3, sent_one: 2, got_paid: 1 },
    { source: 'direct', signed_up: 4, welcomed: 3, returned: 2, created_real: 1, sent_one: 0, got_paid: 0 },
    { source: 'twitter', signed_up: 2, welcomed: 1, returned: 1, created_real: 1, sent_one: 1, got_paid: 0 }
  ];
  nextError = null;
  queryCalls.length = 0;
}

const fakeDbModule = {
  pool: { query: async () => ({ rows: [] }) },
  db: {
    async query(sql, params) {
      queryCalls.push({ sql, params });
      if (nextError) throw nextError;
      if (/signup_source/i.test(sql)) return { rows: nextSourceRows };
      if (/GROUP BY/i.test(sql)) return { rows: nextDailyRows };
      return { rows: nextRows };
    }
  }
};

require.cache[require.resolve('../db')] = {
  id: require.resolve('../db'),
  filename: require.resolve('../db'),
  loaded: true,
  exports: fakeDbModule
};

clearReq('../lib/activation-funnel');
clearReq('../routes/admin');
const adminRoutes = require('../routes/admin');

function buildApp(preloadedSessionUser) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  if (preloadedSessionUser !== undefined) {
    app.use((req, _res, next) => { req.session.user = preloadedSessionUser; next(); });
  }
  app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    res.locals.csrfToken = 'test-csrf';
    next();
  });
  app.use('/admin', adminRoutes);
  return app;
}

function request(app, method, url) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const req = http.request({ hostname: '127.0.0.1', port, path: url, method }, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          server.close(() => resolve({ status: res.statusCode, headers: res.headers, body: data }));
        });
      });
      req.on('error', err => { server.close(); reject(err); });
      req.end();
    });
  });
}

async function testRoute404WithoutSession() {
  resetDbStub();
  process.env.OPERATOR_EMAIL = 'op@x.com';
  const app = buildApp();  // no preloaded user
  const res = await request(app, 'GET', '/admin/activation');
  assert.strictEqual(res.status, 404,
    'no session → 404 (the operator surface stays invisible)');
  assert.strictEqual(queryCalls.length, 0, 'no SQL must be issued for a closed gate');
}

async function testRoute404WhenOperatorEmailUnset() {
  resetDbStub();
  delete process.env.OPERATOR_EMAIL;
  const app = buildApp({ id: 1, email: 'op@x.com' });
  const res = await request(app, 'GET', '/admin/activation');
  assert.strictEqual(res.status, 404,
    'OPERATOR_EMAIL unset → no one is an operator → 404');
  assert.strictEqual(queryCalls.length, 0);
}

async function testRoute404OnSessionEmailMismatch() {
  resetDbStub();
  process.env.OPERATOR_EMAIL = 'op@x.com';
  const app = buildApp({ id: 1, email: 'someone-else@x.com' });
  const res = await request(app, 'GET', '/admin/activation');
  assert.strictEqual(res.status, 404, 'mismatched session email → 404');
  assert.strictEqual(queryCalls.length, 0,
    'must short-circuit before any SQL on a closed gate');
}

async function testRouteRendersHtmlForOperator() {
  resetDbStub();
  process.env.OPERATOR_EMAIL = 'op@x.com';
  const app = buildApp({ id: 1, email: 'op@x.com' });
  const res = await request(app, 'GET', '/admin/activation');
  assert.strictEqual(res.status, 200);
  assert.ok(/text\/html/.test(res.headers['content-type']),
    'HTML route must respond with text/html');
  assert.ok(res.body.includes('data-testid="admin-activation-report"'),
    'page must carry the testid hook for the report container');
  assert.ok(res.body.includes('data-testid="admin-activation-cohort-size"'),
    'cohort-size field must render');
  assert.ok(/data-testid="admin-activation-stage-signed_up"/.test(res.body),
    'stage rows must render with per-stage testid');
  assert.ok(/data-testid="admin-activation-stage-returned"/.test(res.body),
    'new "Returned to app" stage row must render with its testid hook');
  assert.ok(/data-testid="admin-activation-stage-got_paid"/.test(res.body),
    'last stage (got_paid) must render');
  assert.ok(/Returned to app/.test(res.body),
    'human-readable label for the new stage must appear in the table');
  assert.ok(res.body.includes('12'),
    'cohort size 12 must appear in the body');
  assert.ok(res.body.includes('noindex'),
    'admin pages must opt out of indexing');
  assert.strictEqual(queryCalls.length, 3,
    'three SQL queries per render: aggregate + per-day GROUP BY + per-source GROUP BY');
  // Per-day cohort card surfaces with one row per signup day.
  assert.ok(res.body.includes('data-testid="admin-activation-daily-card"'),
    'per-day cohort card must render below the aggregate stages table');
  assert.ok(res.body.includes('data-testid="admin-activation-daily-row-2026-05-15"'),
    'most-recent daily-row testid must render');
  assert.ok(res.body.includes('data-testid="admin-activation-daily-row-2026-05-14"'),
    'older daily-row testid must render too');
  assert.ok(/Daily signup cohorts/.test(res.body),
    'daily card heading must appear');
  // Per-source breakdown card surfaces with one row per acquisition channel.
  assert.ok(res.body.includes('data-testid="admin-activation-source-card"'),
    'per-source breakdown card must render');
  assert.ok(res.body.includes('data-testid="admin-activation-source-row-google"'),
    'google source row testid must render');
  assert.ok(res.body.includes('data-testid="admin-activation-source-row-direct"'),
    'direct (unattributed) source row testid must render');
  assert.ok(/By signup source/.test(res.body),
    'source card heading must appear');
}

async function testRouteRendersJsonForOperator() {
  resetDbStub();
  process.env.OPERATOR_EMAIL = 'op@x.com';
  const app = buildApp({ id: 1, email: 'op@x.com' });
  const res = await request(app, 'GET', '/admin/activation.json?from=2026-04-01&to=2026-04-30');
  assert.strictEqual(res.status, 200);
  assert.ok(/application\/json/.test(res.headers['content-type']),
    'JSON route must respond with application/json');
  const body = JSON.parse(res.body);
  assert.strictEqual(body.range.from, '2026-04-01');
  assert.strictEqual(body.range.to, '2026-04-30');
  assert.strictEqual(body.cohortSize, 12);
  assert.strictEqual(body.stages.length, 6);
  assert.strictEqual(body.stages[0].key, 'signed_up');
  assert.strictEqual(body.stages[0].count, 12);
  assert.strictEqual(body.stages[2].key, 'returned',
    'returned stage sits 3rd in the canonical order');
  assert.strictEqual(body.stages[2].count, 7);
  assert.strictEqual(body.stages[5].key, 'got_paid');
  assert.strictEqual(body.stages[5].count, 1);
  assert.strictEqual(body.stages[1].conversionFromCohort, 9 / 12);
  // Per-day cohort breakdown surfaces in JSON too — operator scripts /
  // dashboards consuming this endpoint get a machine-readable per-day signal
  // without having to scrape the HTML.
  assert.ok(Array.isArray(body.daily), 'JSON must include a daily[] array');
  assert.strictEqual(body.daily.length, 2, 'two daily rows seeded in stub');
  assert.strictEqual(body.daily[0].day, '2026-05-15', 'newest day comes first');
  assert.strictEqual(body.daily[0].signed_up, 7);
  assert.strictEqual(body.daily[0].sent_one, 2);
  assert.ok(Math.abs(body.daily[0].sentRate - (2 / 7)) < 1e-9,
    'sentRate = sent_one / signed_up — the PLAN.md terminal funnel conversion');
  assert.strictEqual(body.daily[1].day, '2026-05-14');
  // Per-source breakdown lands in JSON too — operator scripts get a
  // machine-readable acquisition-channel signal without HTML scraping.
  assert.ok(Array.isArray(body.bySource), 'JSON must include a bySource[] array');
  assert.strictEqual(body.bySource.length, 3, 'three source rows seeded in stub');
  assert.strictEqual(body.bySource[0].source, 'google', 'largest-volume source first');
  assert.strictEqual(body.bySource[0].signed_up, 6);
  assert.strictEqual(body.bySource[0].sent_one, 2);
  assert.ok(Math.abs(body.bySource[0].sentRate - (2 / 6)) < 1e-9,
    'sentRate per source = sent_one / signed_up');
}

async function testJsonRoute404ForNonOperator() {
  resetDbStub();
  process.env.OPERATOR_EMAIL = 'op@x.com';
  const app = buildApp({ id: 1, email: 'nope@x.com' });
  const res = await request(app, 'GET', '/admin/activation.json');
  assert.strictEqual(res.status, 404);
  // JSON route returns JSON shape even on the 404 so callers can branch.
  const body = JSON.parse(res.body);
  assert.strictEqual(body.error, 'not_found');
}

async function testRoute400OnInvalidDate() {
  resetDbStub();
  process.env.OPERATOR_EMAIL = 'op@x.com';
  const app = buildApp({ id: 1, email: 'op@x.com' });
  const res = await request(app, 'GET', '/admin/activation?from=garbage');
  assert.strictEqual(res.status, 400,
    'invalid date input must surface as 400 (not 500, not silent zeros)');
  assert.ok(res.body.includes('data-testid="admin-activation-error"'),
    'error banner must render with its testid hook');
  assert.ok(/YYYY-MM-DD/.test(res.body),
    'error message must explain the expected date format');
  assert.strictEqual(queryCalls.length, 0,
    'malformed input must short-circuit before SQL');
}

async function testRoute500OnSqlThrow() {
  resetDbStub();
  nextError = new Error('connection terminated');
  process.env.OPERATOR_EMAIL = 'op@x.com';
  const app = buildApp({ id: 1, email: 'op@x.com' });
  const res = await request(app, 'GET', '/admin/activation');
  assert.strictEqual(res.status, 500,
    'SQL throw must surface as 500 (not silently render an empty report)');
  assert.ok(res.body.includes('data-testid="admin-activation-error"'),
    'error banner must render on SQL failure');
}

async function testJsonRoute500OnSqlThrow() {
  resetDbStub();
  nextError = new Error('boom');
  process.env.OPERATOR_EMAIL = 'op@x.com';
  const app = buildApp({ id: 1, email: 'op@x.com' });
  const res = await request(app, 'GET', '/admin/activation.json');
  assert.strictEqual(res.status, 500);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.error, 'report_failed');
}

async function testRouteEmptyDailyShowsHintNotTable() {
  resetDbStub();
  // Force aggregate to a zero-cohort + empty daily rows — simulates a date
  // range with no signups. The view should render the empty-state hint
  // instead of an empty table.
  nextRows = [{ signed_up: 0, welcomed: 0, returned: 0, created_real: 0, sent_one: 0, got_paid: 0 }];
  nextDailyRows = [];
  nextSourceRows = [];
  process.env.OPERATOR_EMAIL = 'op@x.com';
  const app = buildApp({ id: 1, email: 'op@x.com' });
  const res = await request(app, 'GET', '/admin/activation');
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.includes('data-testid="admin-activation-daily-empty"'),
    'empty-cohort window must surface the hint testid');
  assert.ok(!/data-testid="admin-activation-daily-card"/.test(res.body),
    'daily card must NOT render on zero-cohort window (no empty table shipped to operator)');
  assert.ok(res.body.includes('data-testid="admin-activation-source-empty"'),
    'empty-cohort window must surface the source-empty hint too');
  assert.ok(!/data-testid="admin-activation-source-card"/.test(res.body),
    'source card must NOT render on zero-cohort window');
}

// ---------- CSV export tests ------------------------------------------------

async function testCsvEscape() {
  clearReq('../lib/activation-funnel');
  const { csvEscape } = require('../lib/activation-funnel');
  // Plain ASCII passes through unchanged.
  assert.strictEqual(csvEscape('google'), 'google',
    'plain alphanumerics never need quoting');
  assert.strictEqual(csvEscape(42), '42', 'finite numbers stringify');
  assert.strictEqual(csvEscape(0), '0', 'zero must render (not empty)');
  assert.strictEqual(csvEscape(0.3333), '0.3333');
  // Empty + nullish render as the empty cell.
  assert.strictEqual(csvEscape(''), '');
  assert.strictEqual(csvEscape(null), '');
  assert.strictEqual(csvEscape(undefined), '');
  // Non-finite numbers do NOT leak NaN/Infinity into the file.
  assert.strictEqual(csvEscape(NaN), '');
  assert.strictEqual(csvEscape(Infinity), '');
  // RFC 4180 quoting: comma, quote, CR, LF all force the quote-wrap.
  assert.strictEqual(csvEscape('hello, world'), '"hello, world"',
    'commas must force quote-wrapping or the row splits');
  assert.strictEqual(csvEscape('he said "hi"'), '"he said ""hi"""',
    'embedded double-quotes must be doubled');
  assert.strictEqual(csvEscape('line1\nline2'), '"line1\nline2"');
  assert.strictEqual(csvEscape('line1\r\nline2'), '"line1\r\nline2"');
  // Booleans render as their lowercase string (defence-in-depth: future
  // boolean stage flags would otherwise stringify as a localised string).
  assert.strictEqual(csvEscape(true), 'true');
  assert.strictEqual(csvEscape(false), 'false');
}

async function testBuildReportCsvShape() {
  clearReq('../lib/activation-funnel');
  const { buildReportCsv } = require('../lib/activation-funnel');
  const report = {
    range: { from: '2026-05-01', to: '2026-05-10', days: 10 },
    cohortSize: 100,
    stages: [
      { key: 'signed_up',    label: 'Signed up',                  milestone: 'cohort',      count: 100, conversionFromPrev: null, conversionFromCohort: null },
      { key: 'welcomed',     label: 'Welcome email sent',         milestone: 'Milestone 1', count: 80,  conversionFromPrev: 0.8,  conversionFromCohort: 0.8  },
      { key: 'returned',     label: 'Returned to app',            milestone: 'Milestone 1', count: 60,  conversionFromPrev: 0.75, conversionFromCohort: 0.6  },
      { key: 'created_real', label: 'Created a real invoice',     milestone: 'Milestone 2', count: 40,  conversionFromPrev: 2/3,  conversionFromCohort: 0.4  },
      { key: 'sent_one',     label: 'Sent at least one invoice',  milestone: 'Milestone 3', count: 30,  conversionFromPrev: 0.75, conversionFromCohort: 0.3  },
      { key: 'got_paid',     label: 'Received first payment',     milestone: 'Milestone 4', count: 10,  conversionFromPrev: 1/3,  conversionFromCohort: 0.1  }
    ],
    daily: [
      { day: '2026-05-10', signed_up: 30, welcomed: 22, returned: 18, created_real: 12, sent_one: 9, got_paid: 3, sentRate: 9 / 30 },
      { day: '2026-05-09', signed_up: 20, welcomed: 18, returned: 12, created_real: 8,  sent_one: 6, got_paid: 2, sentRate: 6 / 20 }
    ],
    bySource: [
      { source: 'google',  signed_up: 18, welcomed: 14, returned: 11, created_real: 7, sent_one: 5, got_paid: 2, sentRate: 5 / 18 },
      { source: 'direct',  signed_up: 12, welcomed: 10, returned: 7,  created_real: 4, sent_one: 2, got_paid: 1, sentRate: 2 / 12 },
      { source: 'appsumo', signed_up: 0,  welcomed: 0,  returned: 0,  created_real: 0, sent_one: 0, got_paid: 0, sentRate: null }
    ],
    generatedAt: '2026-05-16T12:34:56.000Z'
  };
  const csv = buildReportCsv(report);

  // RFC 4180: every line ends in CRLF + trailing CRLF.
  assert.ok(csv.endsWith('\r\n'),
    'CSV payload must end with CRLF so Excel reads the last line cleanly');
  const lines = csv.split('\r\n');
  // Cohort header.
  assert.strictEqual(lines[0], '# DecentInvoice activation funnel');
  assert.strictEqual(lines[1], 'window_from,window_to,window_days,cohort_size,generated_at');
  assert.strictEqual(lines[2], '2026-05-01,2026-05-10,10,100,2026-05-16T12:34:56.000Z',
    'cohort header row must carry the window + size + timestamp');
  assert.strictEqual(lines[3], '', 'blank line separates sections so each block parses as its own table');
  // Stages section.
  assert.strictEqual(lines[4], '# Stages');
  assert.strictEqual(lines[5],
    'stage_key,stage_label,milestone,users,conversion_from_prev,conversion_from_cohort');
  // signed_up has null ratios — render as empty cells, not '—', so a
  // spreadsheet parses the column as a number.
  assert.strictEqual(lines[6], 'signed_up,Signed up,cohort,100,,',
    'first stage carries empty ratio cells (not em-dash) so spreadsheets treat the column as numeric');
  // welcomed renders 0.8000 ratios.
  assert.strictEqual(lines[7], 'welcomed,Welcome email sent,Milestone 1,80,0.8000,0.8000');
  // returned matches new stage.
  assert.strictEqual(lines[8], 'returned,Returned to app,Milestone 1,60,0.7500,0.6000');
  // Spot-check the last stage too.
  const gotPaidLine = lines.find(l => l.startsWith('got_paid,'));
  assert.ok(gotPaidLine, 'got_paid row must appear');
  assert.ok(/^got_paid,Received first payment,Milestone 4,10,0\.3333,0\.1000$/.test(gotPaidLine),
    'got_paid row must carry truncated 4-dp ratios');

  // Daily section.
  const dailyHeaderIdx = lines.indexOf('# Daily signup cohorts');
  assert.ok(dailyHeaderIdx > 0, 'daily section header must appear');
  assert.strictEqual(lines[dailyHeaderIdx + 1],
    'day,signed_up,welcomed,returned,created_real,sent_one,got_paid,sent_rate');
  // Newest day first — same as the HTML report ordering.
  assert.strictEqual(lines[dailyHeaderIdx + 2], '2026-05-10,30,22,18,12,9,3,0.3000');
  assert.strictEqual(lines[dailyHeaderIdx + 3], '2026-05-09,20,18,12,8,6,2,0.3000');

  // By-source section, including the zero-cohort source whose null sentRate
  // must render as an empty cell.
  const sourceHeaderIdx = lines.indexOf('# By signup source');
  assert.ok(sourceHeaderIdx > 0, 'source section header must appear');
  assert.strictEqual(lines[sourceHeaderIdx + 1],
    'source,signed_up,welcomed,returned,created_real,sent_one,got_paid,sent_rate');
  const appsumoLine = lines.find(l => l.startsWith('appsumo,'));
  assert.ok(appsumoLine, 'appsumo row must appear');
  assert.strictEqual(appsumoLine, 'appsumo,0,0,0,0,0,0,',
    'zero-signup source row → empty sentRate cell (last column blank, 8 cells / 7 commas)');
}

async function testBuildReportCsvRejectsErrorReport() {
  clearReq('../lib/activation-funnel');
  const { buildReportCsv } = require('../lib/activation-funnel');
  assert.throws(() => buildReportCsv(null), /requires a successful report/);
  assert.throws(() => buildReportCsv({}), /requires a successful report/);
  assert.throws(() => buildReportCsv({ error: 'invalid_from' }), /requires a successful report/,
    'must not silently render an empty CSV when the underlying report is an error');
}

async function testBuildReportCsvEscapesHostileFields() {
  clearReq('../lib/activation-funnel');
  const { buildReportCsv } = require('../lib/activation-funnel');
  // A source name with a comma + a stage label with embedded quotes must
  // both round-trip through RFC 4180 quoting without breaking column count.
  const csv = buildReportCsv({
    range: { from: '2026-05-01', to: '2026-05-10', days: 10 },
    cohortSize: 3,
    stages: [
      { key: 'signed_up', label: 'Signed "up"', milestone: 'cohort', count: 3, conversionFromPrev: null, conversionFromCohort: null }
    ],
    daily: [],
    bySource: [
      { source: 'plausible, utm', signed_up: 3, welcomed: 2, returned: 1, created_real: 1, sent_one: 1, got_paid: 0, sentRate: 1/3 }
    ],
    generatedAt: '2026-05-16T12:34:56.000Z'
  });
  assert.ok(csv.includes('signed_up,"Signed ""up""",cohort,3,,'),
    'embedded double-quotes in stage label must be doubled per RFC 4180');
  assert.ok(csv.includes('"plausible, utm",3,2,1,1,1,0,0.3333'),
    'comma in source name must force the cell to be quote-wrapped');
}

async function testCsvRoute200ForOperator() {
  resetDbStub();
  process.env.OPERATOR_EMAIL = 'op@x.com';
  const app = buildApp({ id: 1, email: 'op@x.com' });
  const res = await request(app, 'GET', '/admin/activation.csv?from=2026-04-01&to=2026-04-30');
  assert.strictEqual(res.status, 200);
  assert.ok(/text\/csv/.test(res.headers['content-type']),
    'CSV route must respond with text/csv (Content-Type)');
  assert.ok(/charset=utf-8/i.test(res.headers['content-type']),
    'CSV route must declare UTF-8 charset so non-ASCII source names render');
  assert.ok(/attachment/.test(res.headers['content-disposition'] || ''),
    'CSV must serve as an attachment so the browser downloads it');
  assert.ok(/filename="decentinvoice-activation-2026-04-01_2026-04-30\.csv"/.test(
    res.headers['content-disposition'] || ''),
    'CSV filename must carry the window dates for at-a-glance filing');
  assert.ok(/^# DecentInvoice activation funnel\r\n/.test(res.body),
    'body must lead with the cohort header');
  // Same three SQL queries as the HTML/JSON paths (drift-guard).
  assert.strictEqual(queryCalls.length, 3,
    'CSV path must issue exactly three SQL queries — aggregate + per-day + per-source');
  // Stages section must contain the cohort size + a known stage row.
  assert.ok(/window_from,window_to,window_days,cohort_size,generated_at/.test(res.body),
    'cohort header row must appear');
  assert.ok(/2026-04-01,2026-04-30,30,12,/.test(res.body),
    'cohort row must surface the seeded cohortSize=12 + window');
  assert.ok(/# Stages\r\nstage_key,stage_label,milestone,users,conversion_from_prev,conversion_from_cohort\r\n/.test(res.body),
    'stages section header + column header row must appear');
  assert.ok(/returned,Returned to app,Milestone 1,7,/.test(res.body),
    'returned stage row must render with the seeded count=7');
  // Daily + source sections.
  assert.ok(/# Daily signup cohorts/.test(res.body),
    'daily section must appear');
  assert.ok(/2026-05-15,7,6,5,3,2,1,/.test(res.body),
    'newest daily row must render with the seeded counts');
  assert.ok(/# By signup source/.test(res.body),
    'by-source section must appear');
  assert.ok(/google,6,5,4,3,2,1,/.test(res.body),
    'google source row must render');
  // No-cache header so an intermediate proxy can't serve a stale CSV.
  const cacheControl = res.headers['cache-control'] || '';
  assert.ok(/no-store/.test(cacheControl),
    'CSV must carry no-store so a proxy never serves a stale trend snapshot');
}

async function testCsvRoute404WithoutSession() {
  resetDbStub();
  process.env.OPERATOR_EMAIL = 'op@x.com';
  const app = buildApp();  // no preloaded user
  const res = await request(app, 'GET', '/admin/activation.csv');
  assert.strictEqual(res.status, 404,
    'no session → 404 (the operator surface stays invisible on CSV too)');
  assert.strictEqual(queryCalls.length, 0, 'no SQL on a closed gate');
}

async function testCsvRoute404WhenOperatorEmailUnset() {
  resetDbStub();
  delete process.env.OPERATOR_EMAIL;
  const app = buildApp({ id: 1, email: 'op@x.com' });
  const res = await request(app, 'GET', '/admin/activation.csv');
  assert.strictEqual(res.status, 404,
    'OPERATOR_EMAIL unset → CSV route also 404s');
  assert.strictEqual(queryCalls.length, 0);
}

async function testCsvRoute404OnSessionEmailMismatch() {
  resetDbStub();
  process.env.OPERATOR_EMAIL = 'op@x.com';
  const app = buildApp({ id: 1, email: 'someone-else@x.com' });
  const res = await request(app, 'GET', '/admin/activation.csv');
  assert.strictEqual(res.status, 404, 'mismatched session email → 404 on CSV too');
  assert.strictEqual(queryCalls.length, 0, 'must short-circuit before SQL on a closed gate');
}

async function testCsvRoute400OnInvalidDate() {
  resetDbStub();
  process.env.OPERATOR_EMAIL = 'op@x.com';
  const app = buildApp({ id: 1, email: 'op@x.com' });
  const res = await request(app, 'GET', '/admin/activation.csv?from=garbage');
  assert.strictEqual(res.status, 400,
    'invalid date input must surface as 400 (not 500, not an empty CSV)');
  assert.ok(/invalid_from/.test(res.body),
    'error body must name the validation reason');
  assert.strictEqual(queryCalls.length, 0,
    'malformed input must short-circuit before any SQL');
}

async function testCsvRoute500OnSqlThrow() {
  resetDbStub();
  nextError = new Error('connection terminated');
  process.env.OPERATOR_EMAIL = 'op@x.com';
  const app = buildApp({ id: 1, email: 'op@x.com' });
  const res = await request(app, 'GET', '/admin/activation.csv');
  assert.strictEqual(res.status, 500,
    'SQL throw on the CSV path must surface as 500');
  assert.ok(/report_failed/.test(res.body),
    'error body must name the failure mode');
}

async function testHtmlReportSurfacesCsvLink() {
  resetDbStub();
  process.env.OPERATOR_EMAIL = 'op@x.com';
  const app = buildApp({ id: 1, email: 'op@x.com' });
  const res = await request(app, 'GET', '/admin/activation?from=2026-04-01&to=2026-04-30');
  assert.strictEqual(res.status, 200);
  assert.ok(/data-testid="admin-activation-csv-link"/.test(res.body),
    'HTML report must expose the CSV download link via its testid hook');
  // EJS <%= %> HTML-escapes the `&` between query params, so the rendered
  // href reads `&amp;` rather than `&`. Either form is a valid URL once
  // parsed; the assertion locks in whatever the EJS template emits.
  assert.ok(/href="\/admin\/activation\.csv\?from=2026-04-01&amp;to=2026-04-30"/.test(res.body),
    'CSV link must forward the operator-chosen date window to the download URL');
}

async function testRobotsTxtBlocksAdminPath() {
  // server.js renders robots.txt inline; load it through a minimal app build.
  const serverModulePath = require.resolve('../server.js');
  delete require.cache[serverModulePath];
  // server.js calls app.listen(); we don't want a listening server. Read the
  // string instead.
  const fs = require('fs');
  const robotsSource = fs.readFileSync(serverModulePath, 'utf8');
  assert.ok(/Disallow: \/admin\//.test(robotsSource),
    'server.js robots.txt must disallow /admin/');
}

// ---------- Runner ----------------------------------------------------------

async function run() {
  console.log('admin-activation tests');
  const tests = [
    ['parseDateRange defaults to trailing 30 days', testParseDateRangeDefaultsToTrailing30Days],
    ['parseDateRange accepts a valid pair', testParseDateRangeAcceptsValidPair],
    ['parseDateRange rejects bad formats / impossible dates', testParseDateRangeRejectsBadFormat],
    ['parseDateRange rejects out-of-order ranges', testParseDateRangeRejectsOutOfOrder],
    ['parseDateRange rejects > 365-day spans (365 OK)', testParseDateRangeRejectsTooWide],
    ['loadFunnelCounts issues the right SQL + params', testLoadFunnelCountsIssuesRightSql],
    ['loadFunnelByDay SQL contract (GROUP BY day + same 6 stages + DESC)', testLoadFunnelByDaySqlContract],
    ['loadFunnelByDay tolerates empty/null rows + throws on missing args', testLoadFunnelByDayHandlesEmptyAndNullRows],
    ['buildDailyRows computes sentRate; zero-signup day → null; non-array → []', testBuildDailyRowsShapeAndSentRate],
    ['loadFunnelBySource SQL contract (COALESCE direct + ORDER BY signed_up DESC + same 6 stages)', testLoadFunnelBySourceSqlContract],
    ['loadFunnelBySource tolerates empty/null rows + throws on missing args', testLoadFunnelBySourceHandlesEmptyAndNullRows],
    ['buildSourceRows computes sentRate; zero-signup → null; non-array → []', testBuildSourceRowsShapeAndSentRate],
    ['buildStageRows computes from-prev / from-cohort', testBuildStageRowsComputesRatios],
    ['buildStageRows yields null ratios on zero cohort (no NaN)', testBuildStageRowsZeroCohortNoNaN],
    ['STAGE_DEFS canonical order + returned stage label/milestone', testReturnedStageOrderAndMilestoneLabel],
    ['formatPct (12.3% / 100.0% / —)', testFormatPct],
    ['isOperator (env unset → false; match → true)', testIsOperator],
    ['buildReport short-circuits on bad input without SQL', testBuildReportErrorPath],
    ['buildReport happy path returns range + cohort + stages', testBuildReportHappyPath],
    ['route 404 without session', testRoute404WithoutSession],
    ['route 404 when OPERATOR_EMAIL unset', testRoute404WhenOperatorEmailUnset],
    ['route 404 on session email mismatch', testRoute404OnSessionEmailMismatch],
    ['route 200 renders HTML for operator', testRouteRendersHtmlForOperator],
    ['route 200 renders JSON for operator', testRouteRendersJsonForOperator],
    ['JSON route 404 for non-operator (with JSON error body)', testJsonRoute404ForNonOperator],
    ['route 400 on invalid date input', testRoute400OnInvalidDate],
    ['route 500 surfaces SQL throw (HTML)', testRoute500OnSqlThrow],
    ['route 500 surfaces SQL throw (JSON)', testJsonRoute500OnSqlThrow],
    ['route empty daily window renders hint, not an empty table', testRouteEmptyDailyShowsHintNotTable],
    ['csvEscape RFC 4180 quoting + nullish + non-finite numbers', testCsvEscape],
    ['buildReportCsv renders cohort header + 3 sections with CRLF rows', testBuildReportCsvShape],
    ['buildReportCsv rejects error/null reports (no silent empty CSV)', testBuildReportCsvRejectsErrorReport],
    ['buildReportCsv escapes commas + embedded quotes per RFC 4180', testBuildReportCsvEscapesHostileFields],
    ['CSV route 200 for operator + headers + body sections', testCsvRoute200ForOperator],
    ['CSV route 404 without session', testCsvRoute404WithoutSession],
    ['CSV route 404 when OPERATOR_EMAIL unset', testCsvRoute404WhenOperatorEmailUnset],
    ['CSV route 404 on session email mismatch', testCsvRoute404OnSessionEmailMismatch],
    ['CSV route 400 on invalid date input', testCsvRoute400OnInvalidDate],
    ['CSV route 500 on SQL throw', testCsvRoute500OnSqlThrow],
    ['HTML report surfaces the CSV download link with the window forwarded', testHtmlReportSurfacesCsvLink],
    ['robots.txt disallows /admin/', testRobotsTxtBlocksAdminPath]
  ];

  let pass = 0, fail = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ok  ${name}`);
      pass++;
    } catch (err) {
      console.error(`  FAIL ${name}`);
      console.error(err && err.stack ? err.stack : err);
      fail++;
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run().catch(err => { console.error(err); process.exit(1); });
