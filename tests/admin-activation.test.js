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
    signed_up: 7, welcomed: 6, created_real: 4, sent_one: 3, got_paid: 1
  });
}

async function testBuildStageRowsComputesRatios() {
  clearReq('../lib/activation-funnel');
  const { buildStageRows } = require('../lib/activation-funnel');
  const rows = buildStageRows({
    signed_up: 100, welcomed: 80, created_real: 40, sent_one: 30, got_paid: 10
  });
  assert.strictEqual(rows.length, 5);
  assert.strictEqual(rows[0].key, 'signed_up');
  assert.strictEqual(rows[0].count, 100);
  assert.strictEqual(rows[0].conversionFromPrev, null,
    'first stage has no previous-stage ratio');
  assert.strictEqual(rows[0].conversionFromCohort, null,
    'first stage is the cohort definition — ratio to itself omitted');

  assert.strictEqual(rows[1].key, 'welcomed');
  assert.strictEqual(rows[1].conversionFromPrev, 0.8, 'welcomed/signed_up = 80/100');
  assert.strictEqual(rows[1].conversionFromCohort, 0.8);

  assert.strictEqual(rows[2].key, 'created_real');
  assert.strictEqual(rows[2].conversionFromPrev, 0.5, 'created_real/welcomed = 40/80');
  assert.strictEqual(rows[2].conversionFromCohort, 0.4);

  assert.strictEqual(rows[3].key, 'sent_one');
  assert.strictEqual(rows[3].conversionFromPrev, 0.75, 'sent_one/created_real = 30/40');
  assert.strictEqual(rows[3].conversionFromCohort, 0.3);

  assert.strictEqual(rows[4].key, 'got_paid');
  assert.ok(Math.abs(rows[4].conversionFromPrev - 0.3333333333333333) < 1e-9,
    'got_paid/sent_one = 10/30');
  assert.strictEqual(rows[4].conversionFromCohort, 0.1);
}

async function testBuildStageRowsZeroCohortNoNaN() {
  clearReq('../lib/activation-funnel');
  const { buildStageRows } = require('../lib/activation-funnel');
  const rows = buildStageRows({
    signed_up: 0, welcomed: 0, created_real: 0, sent_one: 0, got_paid: 0
  });
  for (const r of rows) {
    assert.strictEqual(r.count, 0);
    assert.strictEqual(r.conversionFromPrev === null || r.conversionFromPrev === undefined, true,
      `${r.key} must have null conversionFromPrev on zero cohort (got ${r.conversionFromPrev})`);
    assert.strictEqual(r.conversionFromCohort === null || r.conversionFromCohort === undefined, true,
      `${r.key} must have null conversionFromCohort on zero cohort`);
  }
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
    async query() {
      return { rows: [{
        signed_up: 50, welcomed: 40, created_real: 20, sent_one: 15, got_paid: 5
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
  assert.strictEqual(r.stages.length, 5);
  assert.strictEqual(r.stages[0].count, 50);
  assert.strictEqual(r.stages[4].count, 5);
  assert.ok(typeof r.generatedAt === 'string' && r.generatedAt.endsWith('Z'),
    'generatedAt must be ISO');
}

// ---------- Route integration tests -----------------------------------------

// In-memory query stub: each test sets `nextRows` to drive the response, and
// `nextError` to force a SQL throw.
let nextRows = [];
let nextError = null;
const queryCalls = [];

function resetDbStub() {
  nextRows = [{
    signed_up: 12, welcomed: 9, created_real: 5, sent_one: 3, got_paid: 1
  }];
  nextError = null;
  queryCalls.length = 0;
}

const fakeDbModule = {
  pool: { query: async () => ({ rows: [] }) },
  db: {
    async query(sql, params) {
      queryCalls.push({ sql, params });
      if (nextError) throw nextError;
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
  assert.ok(/data-testid="admin-activation-stage-got_paid"/.test(res.body),
    'last stage (got_paid) must render');
  assert.ok(res.body.includes('12'),
    'cohort size 12 must appear in the body');
  assert.ok(res.body.includes('noindex'),
    'admin pages must opt out of indexing');
  assert.strictEqual(queryCalls.length, 1,
    'one SQL query per render (no N+1)');
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
  assert.strictEqual(body.stages.length, 5);
  assert.strictEqual(body.stages[0].key, 'signed_up');
  assert.strictEqual(body.stages[0].count, 12);
  assert.strictEqual(body.stages[4].key, 'got_paid');
  assert.strictEqual(body.stages[4].count, 1);
  assert.strictEqual(body.stages[1].conversionFromCohort, 9 / 12);
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
    ['buildStageRows computes from-prev / from-cohort', testBuildStageRowsComputesRatios],
    ['buildStageRows yields null ratios on zero cohort (no NaN)', testBuildStageRowsZeroCohortNoNaN],
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
