'use strict';

/*
 * Public /i/<token> view-tracking tests (Milestone 4 — sent → paid).
 *
 * Covers:
 *   - db.recordPublicInvoiceView: single UPDATE that increments view_count,
 *     COALESCE-sets first_viewed_at (so concurrent first opens both
 *     resolve to the earliest server NOW()), always advances
 *     last_viewed_at, and returns the new row. Bad-id short-circuit.
 *   - lib/client-view.isLikelyBotUserAgent: well-known bot/preview UAs
 *     are excluded; real browser UAs pass through; missing/empty UA
 *     is treated as bot (a real browser never sends an empty UA).
 *   - lib/client-view.formatViewedAgo: "just now" / "Xm ago" / "Xh ago"
 *     for single views; "Viewed N× (last …)" for N > 1; returns null
 *     when first_viewed_at is absent.
 *   - GET /i/<token>: a successful render fires recordPublicInvoiceView
 *     exactly once with the invoice id; a bot UA suppresses the call;
 *     a missing-invoice / bad-token 404 path issues zero record calls;
 *     a DB error inside recordPublicInvoiceView never breaks the
 *     render the client sees.
 *   - views/dashboard.ejs: renders the "👀 Viewed Xh ago" badge for
 *     non-seed rows with a first_viewed_at; suppresses for seed rows
 *     (the seed sample is never shared by link, so it should never
 *     surface the badge even if a column value somehow lands on it);
 *     suppresses for rows with no first_viewed_at; surfaces the
 *     view-count multiplier when view_count > 1.
 *
 * Run: NODE_ENV=test node tests/public-invoice-view-tracking.test.js
 */

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');
const express = require('express');
const http = require('http');

const VIEWS = path.join(__dirname, '..', 'views');

// ---------- pg stub plumbing ---------------------------------------------

function stubPg(handler) {
  const pgPath = require.resolve('pg');
  const originalPg = require.cache[pgPath];
  require.cache[pgPath] = {
    id: pgPath, filename: pgPath, loaded: true,
    exports: {
      Pool: function () { return { query: handler }; }
    }
  };
  delete require.cache[require.resolve('../db')];
  return () => {
    if (originalPg) require.cache[pgPath] = originalPg;
    else delete require.cache[pgPath];
    delete require.cache[require.resolve('../db')];
  };
}

// ---------- db.recordPublicInvoiceView -----------------------------------

async function testRecordPublicInvoiceViewSqlShape() {
  const captured = [];
  const restore = stubPg(async (text, params) => {
    captured.push({ text, params });
    return {
      rows: [{
        id: 42, view_count: 1,
        first_viewed_at: new Date('2026-05-17T12:00:00Z'),
        last_viewed_at: new Date('2026-05-17T12:00:00Z')
      }]
    };
  });
  try {
    const { db } = require('../db');
    const row = await db.recordPublicInvoiceView(42);
    assert.strictEqual(captured.length, 1, 'fires exactly one UPDATE');
    const q = captured[0];
    assert.ok(/^\s*UPDATE\s+invoices/i.test(q.text),
      'must be a single UPDATE statement on invoices');
    assert.ok(/view_count\s*=\s*COALESCE\(\s*view_count\s*,\s*0\s*\)\s*\+\s*1/i.test(q.text),
      'view_count must increment via COALESCE so a null legacy row still bumps to 1');
    assert.ok(/first_viewed_at\s*=\s*COALESCE\(\s*first_viewed_at\s*,\s*NOW\(\)\s*\)/i.test(q.text),
      'first_viewed_at must be COALESCE-set so first hit wins on races');
    assert.ok(/last_viewed_at\s*=\s*NOW\(\)/i.test(q.text),
      'last_viewed_at must always advance to NOW()');
    assert.ok(/WHERE\s+id\s*=\s*\$1/i.test(q.text),
      'must target a single invoice row by id');
    assert.ok(/RETURNING\s+id,\s*view_count,\s*first_viewed_at,\s*last_viewed_at/i.test(q.text),
      'must RETURN the updated stats so caller can detect first-view events');
    assert.deepStrictEqual(q.params, [42]);
    assert.strictEqual(row.view_count, 1);
  } finally { restore(); }
}

async function testRecordPublicInvoiceViewRejectsBadArgs() {
  const calls = [];
  const restore = stubPg(async (text, params) => {
    calls.push({ text, params });
    return { rows: [] };
  });
  try {
    const { db } = require('../db');
    assert.strictEqual(await db.recordPublicInvoiceView(null), null);
    assert.strictEqual(await db.recordPublicInvoiceView(0), null);
    assert.strictEqual(await db.recordPublicInvoiceView(-3), null);
    assert.strictEqual(await db.recordPublicInvoiceView('not-an-id'), null);
    assert.strictEqual(await db.recordPublicInvoiceView({}), null);
    assert.strictEqual(calls.length, 0, 'bad-arg paths issue zero DB queries');
  } finally { restore(); }
}

async function testRecordPublicInvoiceViewReturnsNullWhenInvoiceMissing() {
  const restore = stubPg(async () => ({ rows: [] }));
  try {
    const { db } = require('../db');
    const row = await db.recordPublicInvoiceView(9999);
    assert.strictEqual(row, null,
      'UPDATE-with-no-match returns null rather than throwing');
  } finally { restore(); }
}

// ---------- lib/client-view.isLikelyBotUserAgent -------------------------

function testIsLikelyBotUserAgentMatchesKnownBots() {
  const { isLikelyBotUserAgent } = require('../lib/client-view');
  const bots = [
    'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
    'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
    'Twitterbot/1.0',
    'WhatsApp/2.21.4.18 A',
    'TelegramBot (like TwitterBot)',
    'facebookexternalhit/1.1',
    'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)',
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)',
    'curl/7.79.1',
    'python-requests/2.28.1',
    'Go-http-client/1.1',
    'Mozilla/5.0 AppleWebKit/537.36 HeadlessChrome/120.0.0.0'
  ];
  bots.forEach((ua) => {
    assert.ok(isLikelyBotUserAgent(ua),
      `must classify "${ua}" as a bot`);
  });
}

function testIsLikelyBotUserAgentLetsRealBrowsersThrough() {
  const { isLikelyBotUserAgent } = require('../lib/client-view');
  const browsers = [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0'
  ];
  browsers.forEach((ua) => {
    assert.strictEqual(isLikelyBotUserAgent(ua), false,
      `real browser UA "${ua}" must pass through`);
  });
}

function testIsLikelyBotUserAgentTreatsMissingAsBot() {
  const { isLikelyBotUserAgent } = require('../lib/client-view');
  // A real browser ALWAYS sends a non-empty UA. Missing/empty UA is overwhelmingly
  // automation — playing it safe avoids polluting the freelancer's signal.
  assert.ok(isLikelyBotUserAgent(undefined));
  assert.ok(isLikelyBotUserAgent(null));
  assert.ok(isLikelyBotUserAgent(''));
  assert.ok(isLikelyBotUserAgent('   '));
  assert.ok(isLikelyBotUserAgent(42));
}

// ---------- lib/client-view.formatViewedAgo ------------------------------

function testFormatViewedAgoSingleViewBuckets() {
  const { formatViewedAgo } = require('../lib/client-view');
  const now = new Date('2026-05-17T12:00:00Z');
  assert.strictEqual(
    formatViewedAgo({ firstViewedAt: new Date('2026-05-17T11:59:30Z'), viewCount: 1 }, now),
    'Viewed just now',
    'sub-minute deltas collapse to "just now"'
  );
  assert.strictEqual(
    formatViewedAgo({ firstViewedAt: new Date('2026-05-17T11:45:00Z'), viewCount: 1 }, now),
    'Viewed 15m ago'
  );
  assert.strictEqual(
    formatViewedAgo({ firstViewedAt: new Date('2026-05-17T09:00:00Z'), viewCount: 1 }, now),
    'Viewed 3h ago'
  );
  assert.strictEqual(
    formatViewedAgo({ firstViewedAt: new Date('2026-05-15T12:00:00Z'), viewCount: 1 }, now),
    'Viewed 2d ago'
  );
}

function testFormatViewedAgoMultipleViewsSurfacesCount() {
  const { formatViewedAgo } = require('../lib/client-view');
  const now = new Date('2026-05-17T12:00:00Z');
  // The freelancer cares MORE about repeat opens — "they looked twice" is a
  // stronger they're-considering-it signal than a single open. The badge
  // promotes the count to the eye.
  const out = formatViewedAgo({
    firstViewedAt: new Date('2026-05-17T08:00:00Z'),
    lastViewedAt: new Date('2026-05-17T11:55:00Z'),
    viewCount: 3
  }, now);
  assert.strictEqual(out, 'Viewed 3× (last 5m ago)');
}

function testFormatViewedAgoReturnsNullWhenNeverViewed() {
  const { formatViewedAgo } = require('../lib/client-view');
  assert.strictEqual(formatViewedAgo(null), null);
  assert.strictEqual(formatViewedAgo({}), null);
  assert.strictEqual(formatViewedAgo({ firstViewedAt: null, viewCount: 0 }), null);
}

function testFormatViewedAgoAcceptsSnakeCaseDbRow() {
  // The dashboard hands the raw pg row in — fields are snake_case (first_viewed_at,
  // last_viewed_at, view_count). The formatter must accept both naming styles so
  // callers don't have to remap.
  const { formatViewedAgo } = require('../lib/client-view');
  const now = new Date('2026-05-17T12:00:00Z');
  const out = formatViewedAgo({
    first_viewed_at: new Date('2026-05-17T11:50:00Z'),
    last_viewed_at: new Date('2026-05-17T11:50:00Z'),
    view_count: 1
  }, now);
  assert.strictEqual(out, 'Viewed 10m ago');
}

// ---------- GET /i/<token> fires recordPublicInvoiceView -----------------

function buildShareApp({ invoiceRow, recordImpl, recordCalls }) {
  const dbStub = {
    pool: { query: async () => ({ rows: [] }) },
    db: {
      async getInvoiceByPublicToken(token) {
        if (!/^[a-f0-9]{8,32}$/i.test(token || '')) return null;
        return invoiceRow;
      },
      recordPublicInvoiceView: recordImpl || (async (id) => {
        recordCalls.push(id);
        return { id, view_count: 1, first_viewed_at: new Date(), last_viewed_at: new Date() };
      })
    }
  };
  require.cache[require.resolve('../db')] = {
    id: require.resolve('../db'), filename: require.resolve('../db'),
    loaded: true, exports: dbStub
  };
  delete require.cache[require.resolve('../routes/share')];
  const shareRoutes = require('../routes/share');
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', VIEWS);
  app.use('/', shareRoutes);
  return app;
}

function getPath(app, urlPath, headers) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      http.get({ hostname: '127.0.0.1', port, path: urlPath, headers: headers || {} }, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => server.close(() => resolve({ status: res.statusCode, body: data })));
      }).on('error', (e) => { server.close(); reject(e); });
    });
  });
}

function sampleInvoiceRow(overrides) {
  return Object.assign({
    id: 88,
    invoice_number: 'INV-2026-0042',
    client_name: 'Acme Co.',
    client_email: 'pay@acme.com',
    client_address: '',
    items: [{ description: 'Design', quantity: 1, unit_price: 100 }],
    subtotal: 100, tax_rate: 0, tax_amount: 0, total: 100,
    notes: null, status: 'sent',
    issued_date: new Date('2026-05-01'), due_date: new Date('2026-05-31'),
    payment_link_url: 'https://buy.stripe.com/x', public_token: 'cafef00ddeadbeef',
    owner_id: 11, owner_name: 'Jordan', owner_email: 'jordan@x.com',
    owner_business_name: 'Pine Studio', owner_business_address: '',
    owner_business_email: 'hi@pinestudio.com', owner_business_phone: '',
    owner_plan: 'pro'
  }, overrides || {});
}

const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function testGetIFiresRecordOncePerRender() {
  const recordCalls = [];
  const app = buildShareApp({ invoiceRow: sampleInvoiceRow(), recordCalls });
  const r = await getPath(app, '/i/cafef00ddeadbeef', { 'User-Agent': CHROME_UA });
  assert.strictEqual(r.status, 200);
  // Best-effort fire-and-forget — give the async catch a tick to settle.
  await new Promise((res) => setImmediate(res));
  assert.deepStrictEqual(recordCalls, [88],
    'a successful public render must call recordPublicInvoiceView(invoice.id) exactly once');
}

async function testGetISuppressesRecordForBotUA() {
  const recordCalls = [];
  const app = buildShareApp({ invoiceRow: sampleInvoiceRow(), recordCalls });
  const r = await getPath(app, '/i/cafef00ddeadbeef', {
    'User-Agent': 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)'
  });
  assert.strictEqual(r.status, 200);
  await new Promise((res) => setImmediate(res));
  assert.strictEqual(recordCalls.length, 0,
    'bot UAs must not contaminate the client-view signal');
}

async function testGetISuppressesRecordOn404() {
  const recordCalls = [];
  // invoiceRow = null forces the route into the 404 branch.
  const app = buildShareApp({ invoiceRow: null, recordCalls });
  const r = await getPath(app, '/i/cafef00ddeadbeef', { 'User-Agent': CHROME_UA });
  assert.strictEqual(r.status, 404);
  await new Promise((res) => setImmediate(res));
  assert.strictEqual(recordCalls.length, 0,
    'a 404 must not record a view (no invoice to stamp)');
}

async function testGetIBadTokenDoesNotRecord() {
  const recordCalls = [];
  const app = buildShareApp({ invoiceRow: sampleInvoiceRow(), recordCalls });
  const r = await getPath(app, '/i/not-hex!', { 'User-Agent': CHROME_UA });
  assert.strictEqual(r.status, 404);
  await new Promise((res) => setImmediate(res));
  assert.strictEqual(recordCalls.length, 0,
    'bad-format tokens short-circuit before the record call');
}

async function testGetIRecordErrorDoesNotBreakRender() {
  // Critical: a transient pool blip on the record-view UPDATE must NEVER deny
  // the client the actual invoice render. The client SEEING the invoice is the
  // entire point of the share link; tracking is a bonus signal.
  const app = buildShareApp({
    invoiceRow: sampleInvoiceRow(),
    recordImpl: async () => { throw new Error('pool exhausted'); }
  });
  const r = await getPath(app, '/i/cafef00ddeadbeef', { 'User-Agent': CHROME_UA });
  assert.strictEqual(r.status, 200, 'render still succeeds even if recording fails');
  assert.ok(r.body.includes('INV-2026-0042'),
    'the invoice content is still in the response body');
}

// ---------- Dashboard badge rendering ------------------------------------

const dashboardTplPath = path.join(VIEWS, 'dashboard.ejs');
const dashboardTpl = fs.readFileSync(dashboardTplPath, 'utf8');

function renderDashboard(locals) {
  return ejs.render(dashboardTpl, Object.assign({
    title: 'Dashboard',
    flash: null,
    days_left_in_trial: 0,
    csrfToken: 'TEST_CSRF',
    invoices: [],
    user: { plan: 'pro', invoice_count: 4, subscription_status: 'active' },
    onboarding: null,
    invoiceLimitProgress: null
  }, locals || {}), {
    views: [VIEWS],
    filename: dashboardTplPath
  });
}

function makeInvoiceRow(overrides) {
  return Object.assign({
    id: 11,
    invoice_number: 'INV-0001',
    client_name: 'Acme',
    issued_date: '2026-05-10',
    total: '300.00',
    status: 'sent',
    is_seed: false,
    payment_link_url: null,
    first_viewed_at: null,
    last_viewed_at: null,
    view_count: 0
  }, overrides || {});
}

function testDashboardRendersViewedBadgeWhenFirstViewed() {
  const now = new Date();
  const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);
  const html = renderDashboard({
    invoices: [makeInvoiceRow({
      id: 11, status: 'sent',
      first_viewed_at: fiveMinAgo,
      last_viewed_at: fiveMinAgo,
      view_count: 1
    })]
  });
  assert.ok(html.includes('data-testid="client-viewed-11"'),
    'sent invoice with a first_viewed_at must surface the client-viewed badge');
  assert.ok(/Viewed (just now|\dm ago)/.test(html),
    'badge body must use the formatViewedAgo helper output');
}

function testDashboardSuppressesViewedBadgeForUnviewed() {
  const html = renderDashboard({
    invoices: [makeInvoiceRow({ id: 12, first_viewed_at: null })]
  });
  assert.ok(!/data-testid="client-viewed-12"/.test(html),
    'an unviewed row must NOT render the badge');
}

function testDashboardSuppressesViewedBadgeForSeedInvoice() {
  // The seed sample exists locally for the new user and is never shared with
  // a real client — surfacing "Viewed by client" on it would be a confusing
  // false positive that erodes trust in the badge.
  const html = renderDashboard({
    invoices: [makeInvoiceRow({
      id: 13, is_seed: true,
      first_viewed_at: new Date(), last_viewed_at: new Date(), view_count: 1
    })]
  });
  assert.ok(!/data-testid="client-viewed-13"/.test(html),
    'seed invoices must NEVER surface the client-viewed badge');
}

function testDashboardSurfacesViewCountWhenMultiple() {
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const twoMinAgo = new Date(now.getTime() - 2 * 60 * 1000);
  const html = renderDashboard({
    invoices: [makeInvoiceRow({
      id: 14, status: 'sent',
      first_viewed_at: oneHourAgo,
      last_viewed_at: twoMinAgo,
      view_count: 4
    })]
  });
  assert.ok(html.includes('data-testid="client-viewed-14"'));
  assert.ok(html.includes('data-view-count="4"'),
    'view_count must surface as a data attribute for downstream test/qa hooks');
  assert.ok(/Viewed 4×/.test(html),
    'multi-view badge text must surface the count');
}

function testDashboardBadgeAlsoRendersOnPaidStatus() {
  // A "paid" invoice with view stamps is the most-rewarding case for the
  // freelancer — both they and the client saw the path through. Don't gate
  // the badge on status; gate only on the presence of a view stamp.
  const now = new Date();
  const html = renderDashboard({
    invoices: [makeInvoiceRow({
      id: 15, status: 'paid',
      first_viewed_at: new Date(now.getTime() - 30 * 60 * 1000),
      last_viewed_at: new Date(now.getTime() - 30 * 60 * 1000),
      view_count: 2
    })]
  });
  assert.ok(html.includes('data-testid="client-viewed-15"'),
    'paid invoices with a view stamp also surface the badge');
}

// ---------- Schema sanity ------------------------------------------------

function testSchemaContainsIdempotentMigrations() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  assert.ok(/ADD COLUMN IF NOT EXISTS view_count INTEGER DEFAULT 0/.test(sql),
    'schema must add view_count idempotently');
  assert.ok(/ADD COLUMN IF NOT EXISTS first_viewed_at TIMESTAMP/.test(sql),
    'schema must add first_viewed_at idempotently');
  assert.ok(/ADD COLUMN IF NOT EXISTS last_viewed_at TIMESTAMP/.test(sql),
    'schema must add last_viewed_at idempotently');
}

// ---------- runner -------------------------------------------------------

async function run() {
  const tests = [
    ['db.recordPublicInvoiceView: single UPDATE shape', testRecordPublicInvoiceViewSqlShape],
    ['db.recordPublicInvoiceView: bad args short-circuit', testRecordPublicInvoiceViewRejectsBadArgs],
    ['db.recordPublicInvoiceView: missing invoice returns null', testRecordPublicInvoiceViewReturnsNullWhenInvoiceMissing],
    ['lib/client-view.isLikelyBotUserAgent: known bots', testIsLikelyBotUserAgentMatchesKnownBots],
    ['lib/client-view.isLikelyBotUserAgent: real browsers pass', testIsLikelyBotUserAgentLetsRealBrowsersThrough],
    ['lib/client-view.isLikelyBotUserAgent: empty/missing UA treated as bot', testIsLikelyBotUserAgentTreatsMissingAsBot],
    ['lib/client-view.formatViewedAgo: single-view time buckets', testFormatViewedAgoSingleViewBuckets],
    ['lib/client-view.formatViewedAgo: multi-view count surfaces', testFormatViewedAgoMultipleViewsSurfacesCount],
    ['lib/client-view.formatViewedAgo: null when never viewed', testFormatViewedAgoReturnsNullWhenNeverViewed],
    ['lib/client-view.formatViewedAgo: accepts snake_case', testFormatViewedAgoAcceptsSnakeCaseDbRow],
    ['GET /i/<token>: fires recordPublicInvoiceView once on success', testGetIFiresRecordOncePerRender],
    ['GET /i/<token>: bot UA suppresses record', testGetISuppressesRecordForBotUA],
    ['GET /i/<token>: 404 path does not record', testGetISuppressesRecordOn404],
    ['GET /i/<token>: bad token short-circuits before record', testGetIBadTokenDoesNotRecord],
    ['GET /i/<token>: record error does not break render', testGetIRecordErrorDoesNotBreakRender],
    ['dashboard.ejs: renders client-viewed badge', testDashboardRendersViewedBadgeWhenFirstViewed],
    ['dashboard.ejs: no badge when never viewed', testDashboardSuppressesViewedBadgeForUnviewed],
    ['dashboard.ejs: no badge on seed invoice', testDashboardSuppressesViewedBadgeForSeedInvoice],
    ['dashboard.ejs: multi-view surfaces count', testDashboardSurfacesViewCountWhenMultiple],
    ['dashboard.ejs: badge renders on paid status too', testDashboardBadgeAlsoRendersOnPaidStatus],
    ['schema.sql: idempotent migrations present', testSchemaContainsIdempotentMigrations]
  ];
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log('  ✓', name);
    } catch (err) {
      failed++;
      console.error('  ✗', name);
      console.error(err.stack || err.message);
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log(`\nAll ${tests.length} tests passed`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
