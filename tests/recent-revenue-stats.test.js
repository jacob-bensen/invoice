'use strict';

/*
 * Recent paid-revenue dashboard card tests (INTERNAL_TODO #107).
 *
 * Covers:
 *  - buildRecentRevenueCard() pure logic: hides on missing user, hides on
 *    free plan, hides when stats lookup failed (null), hides when zero paid
 *    invoices in the window, returns sanitised + numeric-coerced fields
 *    when there is paid revenue to celebrate.
 *  - dashboard.ejs renders the green emerald-50 card with three stat tiles
 *    when locals.recentRevenue is populated and invoices.length > 0.
 *  - The card is omitted from the empty-state branch (no invoices) and
 *    from print rendering (print:hidden class is on the card root).
 *  - Money is formatted with thousand separators and 2 decimal places.
 *  - The card sits above the existing 3-card Total/Collected/Outstanding
 *    grid (its `data-testid="recent-revenue"` appears earlier in the
 *    rendered HTML than the existing "Outstanding" stat label).
 *  - Free users never see the card even when stats are present (defence
 *    against a future regression that would query stats for free users).
 *
 * Run: node tests/recent-revenue-stats.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');

// Stub db before requiring routes/invoices.js — we only need the pure
// helper export, so a minimal stub is enough.
const dbStub = {
  pool: { query: async () => ({ rows: [] }) },
  db: {}
};
require.cache[require.resolve('../db')] = {
  id: require.resolve('../db'),
  filename: require.resolve('../db'),
  loaded: true,
  exports: dbStub
};

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

delete require.cache[require.resolve('../routes/invoices')];
const { buildRecentRevenueCard } = require('../routes/invoices');

const dashboardTplPath = path.join(__dirname, '..', 'views', 'dashboard.ejs');
const dashboardTpl = fs.readFileSync(dashboardTplPath, 'utf8');

function renderDashboard(locals) {
  return ejs.render(dashboardTpl, {
    title: 'Dashboard',
    flash: null,
    days_left_in_trial: 0,
    csrfToken: 'TEST_CSRF',
    invoices: [
      { id: 1, invoice_number: 'INV-2026-0001', client_name: 'Acme', issued_date: '2026-04-01', total: 500, status: 'paid' }
    ],
    user: { plan: 'pro', invoice_count: 5, subscription_status: null },
    onboarding: null,
    invoiceLimitProgress: null,
    recentRevenue: null,
    ...locals
  }, {
    views: [path.join(__dirname, '..', 'views')],
    filename: dashboardTplPath
  });
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ---------- buildRecentRevenueCard pure logic --------------------------

test('buildRecentRevenueCard returns null when user is missing', () => {
  assert.strictEqual(buildRecentRevenueCard(null, { totalPaid: 100, invoiceCount: 1, clientCount: 1, days: 30 }), null);
});

test('buildRecentRevenueCard returns null for free plan users', () => {
  const card = buildRecentRevenueCard(
    { plan: 'free' },
    { totalPaid: 100, invoiceCount: 1, clientCount: 1, days: 30 }
  );
  assert.strictEqual(card, null);
});

test('buildRecentRevenueCard returns null when stats lookup failed (null)', () => {
  const card = buildRecentRevenueCard({ plan: 'pro' }, null);
  assert.strictEqual(card, null);
});

test('buildRecentRevenueCard returns null when stats is not an object', () => {
  assert.strictEqual(buildRecentRevenueCard({ plan: 'pro' }, 'oops'), null);
  assert.strictEqual(buildRecentRevenueCard({ plan: 'pro' }, 0), null);
});

test('buildRecentRevenueCard returns null when zero paid invoices in window', () => {
  const card = buildRecentRevenueCard(
    { plan: 'pro' },
    { totalPaid: 0, invoiceCount: 0, clientCount: 0, days: 30 }
  );
  assert.strictEqual(card, null);
});

test('buildRecentRevenueCard returns populated card for pro user with paid invoices', () => {
  const card = buildRecentRevenueCard(
    { plan: 'pro' },
    { totalPaid: 1234.56, invoiceCount: 4, clientCount: 2, days: 30 }
  );
  assert.deepStrictEqual(card, { days: 30, totalPaid: 1234.56, invoiceCount: 4, clientCount: 2 });
});

test('buildRecentRevenueCard works for agency plan users too', () => {
  const card = buildRecentRevenueCard(
    { plan: 'agency' },
    { totalPaid: 999, invoiceCount: 1, clientCount: 1, days: 30 }
  );
  assert.ok(card);
  assert.strictEqual(card.invoiceCount, 1);
});

test('buildRecentRevenueCard works for business plan users too', () => {
  const card = buildRecentRevenueCard(
    { plan: 'business' },
    { totalPaid: 50, invoiceCount: 1, clientCount: 1, days: 30 }
  );
  assert.ok(card);
});

test('buildRecentRevenueCard coerces stringy stats to numbers', () => {
  const card = buildRecentRevenueCard(
    { plan: 'pro' },
    { totalPaid: '500.50', invoiceCount: '3', clientCount: '2', days: '30' }
  );
  assert.strictEqual(card.totalPaid, 500.5);
  assert.strictEqual(card.invoiceCount, 3);
  assert.strictEqual(card.clientCount, 2);
  assert.strictEqual(card.days, 30);
});

test('buildRecentRevenueCard handles NaN totalPaid by zeroing it', () => {
  const card = buildRecentRevenueCard(
    { plan: 'pro' },
    { totalPaid: NaN, invoiceCount: 1, clientCount: 1, days: 30 }
  );
  // invoiceCount=1 means we still want to render the card (paid happened)
  // but the dollar figure should not surface as "$NaN".
  assert.strictEqual(card.totalPaid, 0);
});

// ---------- dashboard.ejs render ---------------------------------------

test('dashboard renders the recent-revenue card with all 3 stat tiles', () => {
  const html = renderDashboard({
    recentRevenue: { days: 30, totalPaid: 1234.56, invoiceCount: 4, clientCount: 2 }
  });
  assert.match(html, /data-testid="recent-revenue"/);
  // Span-tolerant: the days number is wrapped in <span x-text="days">30</span>
  // so Alpine can re-render it on toggle (#117). User-visible text is still
  // "Last 30 days".
  assert.match(html, /Last\s*(?:<span[^>]*>\s*)?30(?:\s*<\/span>)?\s*days/);
  assert.match(html, /data-testid="recent-revenue-total"[^>]*>[\s\S]*?\$1,234\.56/);
  assert.match(html, /data-testid="recent-revenue-clients"[^>]*>[\s\S]*?2/);
  assert.match(html, /data-testid="recent-revenue-invoices"[^>]*>[\s\S]*?4/);
});

test('dashboard formats large dollar amounts with thousand separators', () => {
  const html = renderDashboard({
    recentRevenue: { days: 30, totalPaid: 12345.6, invoiceCount: 10, clientCount: 5 }
  });
  assert.match(html, /\$12,345\.60/);
});

test('dashboard omits the card when recentRevenue is null', () => {
  const html = renderDashboard({ recentRevenue: null });
  assert.doesNotMatch(html, /data-testid="recent-revenue"/);
});

test('dashboard omits the card when recentRevenue local is undefined', () => {
  // Render with an explicitly-undefined recentRevenue (locals.recentRevenue
  // path) — guards against a future caller that drops the local entirely.
  const html = renderDashboard({ recentRevenue: undefined });
  assert.doesNotMatch(html, /data-testid="recent-revenue"/);
});

test('dashboard recent-revenue card carries print:hidden', () => {
  const html = renderDashboard({
    recentRevenue: { days: 30, totalPaid: 100, invoiceCount: 1, clientCount: 1 }
  });
  // Find the card markup specifically and capture its opening <div tag —
  // the class list is the next attribute after data-days.
  const match = html.match(/<div[\s\S]{0,200}?data-testid="recent-revenue"[\s\S]{0,500}?>/);
  assert.ok(match, 'should find recent-revenue card opening tag');
  assert.match(match[0], /print:hidden/);
});

test('dashboard recent-revenue card sits above the existing 3-card stats row', () => {
  const html = renderDashboard({
    recentRevenue: { days: 30, totalPaid: 100, invoiceCount: 1, clientCount: 1 }
  });
  const recentIdx = html.indexOf('data-testid="recent-revenue"');
  const totalInvoicedIdx = html.indexOf('Total Invoiced');
  assert.ok(recentIdx >= 0, 'recent-revenue card should render');
  assert.ok(totalInvoicedIdx >= 0, 'existing stats row should render');
  assert.ok(recentIdx < totalInvoicedIdx, 'recent-revenue should come before Total Invoiced');
});

test('dashboard omits the card on the empty-state branch (no invoices)', () => {
  const html = renderDashboard({
    invoices: [],
    recentRevenue: { days: 30, totalPaid: 100, invoiceCount: 1, clientCount: 1 }
  });
  // Empty state path renders "Send your first invoice today" and skips the
  // <else> block where recent-revenue lives.
  assert.match(html, /Send your first invoice today/);
  assert.doesNotMatch(html, /data-testid="recent-revenue"/);
});

test('dashboard exposes data-days attribute for analytics', () => {
  const html = renderDashboard({
    recentRevenue: { days: 30, totalPaid: 100, invoiceCount: 1, clientCount: 1 }
  });
  assert.match(html, /data-testid="recent-revenue"[^>]*data-days="30"/);
});

test('dashboard handles zero clientCount edge case (single anonymous payer)', () => {
  // A paid invoice with no client_name and no client_email would dedupe
  // to a single null bucket — clientCount could be 0 or 1 depending on
  // the SQL. Render must not crash on either.
  const html = renderDashboard({
    recentRevenue: { days: 30, totalPaid: 50, invoiceCount: 1, clientCount: 0 }
  });
  assert.match(html, /data-testid="recent-revenue-clients"[^>]*>\s*0\s*</);
});

// ---------- db.getRecentRevenueStats SQL contract ------------------------
// These exercise the real db.js helper against a fake pg pool — guards the
// SQL string + parameter shape, which the pure-fn tests don't cover.
// Earlier tests in this file stub `../db` to bypass DB connection; we need
// the real module here, so reload it with a clean require cache.

function loadRealDb() {
  delete require.cache[require.resolve('../db')];
  const real = require('../db');
  // Restore stubbed copy after this section so any later tests still see it.
  return real;
}

test('db.getRecentRevenueStats issues parameterised SQL and parses pg DECIMAL strings', async () => {
  const calls = [];
  const real = loadRealDb();
  const realPool = real.pool;
  const db = real.db;
  const originalQuery = realPool.query.bind(realPool);
  realPool.query = async (text, params) => {
    calls.push({ text, params });
    return { rows: [{ total_paid: '2400.00', invoice_count: 3, client_count: 2 }] };
  };
  try {
    const stats = await db.getRecentRevenueStats(42, 30);
    assert.strictEqual(calls.length, 1);
    // Parameterised — userId + days are bound, never interpolated.
    assert.deepStrictEqual(calls[0].params, [42, 30]);
    // SQL must filter on status='paid' and use updated_at as the time-window
    // proxy + cast SUM/COUNTs to text/int so pg returns parsed numbers.
    assert.match(calls[0].text, /FROM invoices/i);
    assert.match(calls[0].text, /status\s*=\s*'paid'/);
    assert.match(calls[0].text, /updated_at\s*>=\s*NOW\(\)\s*-\s*\(\$2\s*\*\s*INTERVAL\s*'1 day'\)/);
    assert.match(calls[0].text, /COUNT\(DISTINCT/);
    // Return shape is parsed numeric, not string.
    assert.strictEqual(stats.totalPaid, 2400);
    assert.strictEqual(stats.invoiceCount, 3);
    assert.strictEqual(stats.clientCount, 2);
    assert.strictEqual(stats.days, 30);
  } finally {
    realPool.query = originalQuery;
  }
});

test('db.getRecentRevenueStats clamps the days arg to [1, 365]', async () => {
  const calls = [];
  const real = loadRealDb();
  const realPool = real.pool;
  const db = real.db;
  const originalQuery = realPool.query.bind(realPool);
  realPool.query = async (text, params) => {
    calls.push(params);
    return { rows: [{ total_paid: '0', invoice_count: 0, client_count: 0 }] };
  };
  try {
    await db.getRecentRevenueStats(1, 9999);
    assert.strictEqual(calls[0][1], 365, 'days arg above 365 should be clamped to 365');
    await db.getRecentRevenueStats(1, 0);
    // 0 is falsy → falls back to default 30 (which is in-range so unclamped).
    assert.strictEqual(calls[1][1], 30, 'days arg of 0 falls back to default 30');
    await db.getRecentRevenueStats(1, -10);
    assert.strictEqual(calls[2][1], 1, 'negative days arg should be clamped up to 1');
    await db.getRecentRevenueStats(1, 'garbage');
    assert.strictEqual(calls[3][1], 30, 'non-numeric days arg falls back to default 30');
  } finally {
    realPool.query = originalQuery;
  }
});

test('db.getRecentRevenueStats handles empty result row gracefully', async () => {
  const real = loadRealDb();
  const realPool = real.pool;
  const db = real.db;
  const originalQuery = realPool.query.bind(realPool);
  realPool.query = async () => ({ rows: [] });
  try {
    const stats = await db.getRecentRevenueStats(1, 30);
    assert.deepStrictEqual(stats, { days: 30, totalPaid: 0, invoiceCount: 0, clientCount: 0 });
  } finally {
    realPool.query = originalQuery;
  }
});

test('db.getRecentRevenueStats COALESCEs SUM(total) NULL to 0 (no paid invoices)', async () => {
  const real = loadRealDb();
  const realPool = real.pool;
  const db = real.db;
  const originalQuery = realPool.query.bind(realPool);
  realPool.query = async () => ({
    rows: [{ total_paid: '0', invoice_count: 0, client_count: 0 }]
  });
  try {
    const stats = await db.getRecentRevenueStats(1, 30);
    assert.strictEqual(stats.totalPaid, 0);
    assert.strictEqual(typeof stats.totalPaid, 'number');
  } finally {
    realPool.query = originalQuery;
  }
});

test('db.getRecentRevenueStats SQL filters by user_id (no cross-tenant leak)', async () => {
  let captured = null;
  const real = loadRealDb();
  const realPool = real.pool;
  const db = real.db;
  const originalQuery = realPool.query.bind(realPool);
  realPool.query = async (text, params) => {
    captured = { text, params };
    return { rows: [{ total_paid: '0', invoice_count: 0, client_count: 0 }] };
  };
  try {
    await db.getRecentRevenueStats(7, 30);
    assert.match(captured.text, /WHERE\s+user_id\s*=\s*\$1/);
    assert.strictEqual(captured.params[0], 7);
  } finally {
    realPool.query = originalQuery;
  }
});

// ---------- Run ---------------------------------------------------------

(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log(`  ✓ ${t.name}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${t.name}`);
      console.error(`    ${err.message}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed (recent-revenue-stats.test.js)`);
  if (failed > 0) process.exit(1);
})();
