'use strict';

/*
 * #127 — Quiet-window recovery CTA on the recent-revenue card.
 *
 * Three layers of coverage:
 *
 *  1. db.getRecentRevenueStats SQL contract — the new unpaidCount field
 *     comes from a single round-trip query that uses FILTER aggregates
 *     so paid-window stats AND not-windowed unpaid count come back
 *     together. We assert: the SQL captures both filters; the unpaid
 *     count is NOT bounded by the trailing window (so the CTA reflects
 *     all open follow-up-able invoices, not just ones opened recently);
 *     stats fields parse to integers; missing-row paths return 0/0/0/0.
 *
 *  2. buildRecentRevenueCard helper — threads unpaidCount through.
 *     Card stays null for free users + zero-invoiceCount; populated
 *     card includes unpaidCount as an integer.
 *
 *  3. GET /invoices/api/recent-revenue — surfaces unpaidCount at the
 *     top level of the response so the client can drive the CTA even
 *     when card===null (zero paid in window, but open unpaid invoices
 *     still need follow-ups).
 *
 *  4. views/dashboard.ejs — renders the reactive CTA block, the
 *     pluralized count, the deep-link anchor target, and the new
 *     id="invoices-table" on the table wrapper.
 *
 * Run: node tests/recent-revenue-quiet-window-cta.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');

// ---- Layer 1: db.getRecentRevenueStats SQL contract --------------------

function loadRealDb() {
  delete require.cache[require.resolve('../db')];
  return require('../db');
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('db.getRecentRevenueStats: SQL contains a FILTER for status IN (\'sent\',\'overdue\') (unpaid count)', async () => {
  let captured = null;
  const real = loadRealDb();
  const realPool = real.pool;
  const db = real.db;
  const originalQuery = realPool.query.bind(realPool);
  realPool.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [{ total_paid: '0', invoice_count: 0, client_count: 0, unpaid_count: 0 }] };
  };
  try {
    await db.getRecentRevenueStats(1, 30);
    assert.ok(captured, 'query was issued');
    // The unpaid-count aggregate must FILTER on status IN ('sent','overdue')
    // — otherwise the CTA would either count too few (drafts excluded already
    // — correct) or too many (paid-included — wrong).
    assert.match(
      captured.sql,
      /FILTER\s*\(\s*WHERE\s+status\s+IN\s*\(\s*'sent'\s*,\s*'overdue'\s*\)\s*\)/i,
      'unpaid-count FILTER must scope to status IN (\'sent\',\'overdue\')'
    );
    // The paid-window aggregates retain their `status='paid' AND updated_at >= ...` filter.
    assert.match(
      captured.sql,
      /FILTER\s*\(\s*WHERE\s+status\s*=\s*'paid'/i,
      'paid-aggregate FILTERs must remain in the SQL'
    );
  } finally {
    realPool.query = originalQuery;
  }
});

test('db.getRecentRevenueStats: unpaid_count is NOT bounded by the trailing window', async () => {
  let captured = null;
  const real = loadRealDb();
  const realPool = real.pool;
  const db = real.db;
  const originalQuery = realPool.query.bind(realPool);
  realPool.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [{ total_paid: '0', invoice_count: 0, client_count: 0, unpaid_count: 7 }] };
  };
  try {
    const stats = await db.getRecentRevenueStats(1, 7);
    // The unpaid-count FILTER must NOT include `updated_at >= ...` — the CTA
    // is about ALL open invoices, not just ones modified recently. Capture
    // the unpaid-count FILTER and assert no updated_at predicate.
    const unpaidFilterMatch = captured.sql.match(
      /COUNT\(\*\)\s+FILTER\s*\(\s*WHERE\s+status\s+IN\s*\(\s*'sent'\s*,\s*'overdue'\s*\)\s*\)/i
    );
    assert.ok(unpaidFilterMatch, 'unpaid-count FILTER must exist as a standalone clause');
    // The match captures only the FILTER clause; an updated_at predicate
    // would have made the regex fail (since it's `WHERE status IN (...) )`).
    assert.strictEqual(stats.unpaidCount, 7);
  } finally {
    realPool.query = originalQuery;
  }
});

test('db.getRecentRevenueStats: unpaidCount parses to integer from pg int column', async () => {
  const real = loadRealDb();
  const realPool = real.pool;
  const db = real.db;
  const originalQuery = realPool.query.bind(realPool);
  realPool.query = async () => ({
    rows: [{ total_paid: '0', invoice_count: 0, client_count: 0, unpaid_count: 12 }]
  });
  try {
    const stats = await db.getRecentRevenueStats(1, 30);
    assert.strictEqual(stats.unpaidCount, 12);
    assert.strictEqual(typeof stats.unpaidCount, 'number');
  } finally {
    realPool.query = originalQuery;
  }
});

test('db.getRecentRevenueStats: missing unpaid_count falls back to 0', async () => {
  const real = loadRealDb();
  const realPool = real.pool;
  const db = real.db;
  const originalQuery = realPool.query.bind(realPool);
  realPool.query = async () => ({
    rows: [{ total_paid: '500', invoice_count: 1, client_count: 1 /* unpaid_count omitted */ }]
  });
  try {
    const stats = await db.getRecentRevenueStats(1, 30);
    assert.strictEqual(stats.unpaidCount, 0);
  } finally {
    realPool.query = originalQuery;
  }
});

test('db.getRecentRevenueStats: empty result row returns unpaidCount=0', async () => {
  const real = loadRealDb();
  const realPool = real.pool;
  const db = real.db;
  const originalQuery = realPool.query.bind(realPool);
  realPool.query = async () => ({ rows: [] });
  try {
    const stats = await db.getRecentRevenueStats(1, 30);
    assert.strictEqual(stats.unpaidCount, 0);
  } finally {
    realPool.query = originalQuery;
  }
});

// ---- Layer 2: buildRecentRevenueCard threading -------------------------

let mockUserById = { id: 1, plan: 'pro' };
let mockStats = { days: 30, totalPaid: 1234.56, invoiceCount: 4, clientCount: 2, unpaidCount: 0 };
let mockStatsThrows = false;

const dbStub = {
  pool: { query: async () => ({ rows: [] }) },
  db: {
    getUserById: async () => mockUserById,
    getRecentRevenueStats: async (userId, days) => {
      if (mockStatsThrows) throw new Error('boom');
      return { ...mockStats, days };
    }
  }
};

require.cache[require.resolve('../db')] = {
  id: require.resolve('../db'),
  filename: require.resolve('../db'),
  loaded: true,
  exports: dbStub
};

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';
delete require.cache[require.resolve('../routes/invoices')];
const invoiceRoutes = require('../routes/invoices');
const buildRecentRevenueCard = invoiceRoutes.buildRecentRevenueCard;

test('buildRecentRevenueCard: threads unpaidCount through to the populated card', () => {
  const card = buildRecentRevenueCard(
    { plan: 'pro' },
    { days: 30, totalPaid: 100, invoiceCount: 1, clientCount: 1, unpaidCount: 3 }
  );
  assert.ok(card);
  assert.strictEqual(card.unpaidCount, 3);
});

test('buildRecentRevenueCard: missing unpaidCount on stats becomes 0 on card (legacy-stat resilience)', () => {
  const card = buildRecentRevenueCard(
    { plan: 'pro' },
    { days: 30, totalPaid: 100, invoiceCount: 1, clientCount: 1 /* unpaidCount missing */ }
  );
  assert.ok(card);
  assert.strictEqual(card.unpaidCount, 0);
});

test('buildRecentRevenueCard: stringy unpaidCount is parsed to integer', () => {
  const card = buildRecentRevenueCard(
    { plan: 'pro' },
    { days: 30, totalPaid: 100, invoiceCount: 1, clientCount: 1, unpaidCount: '5' }
  );
  assert.strictEqual(card.unpaidCount, 5);
});

test('buildRecentRevenueCard: free-plan + populated unpaidCount still returns null (defence-in-depth)', () => {
  // unpaidCount must NOT be a back-door to leak the card to free users —
  // free users don't see the card under any circumstance.
  const card = buildRecentRevenueCard(
    { plan: 'free' },
    { days: 30, totalPaid: 100, invoiceCount: 1, clientCount: 1, unpaidCount: 50 }
  );
  assert.strictEqual(card, null);
});

test('buildRecentRevenueCard: invoiceCount=0 still returns null even if unpaidCount > 0', () => {
  // The card itself is gated on having paid at least one invoice in the
  // window — without that, the SSR card wouldn't render at all on the
  // dashboard. The CTA layer activates only inside an existing card.
  const card = buildRecentRevenueCard(
    { plan: 'pro' },
    { days: 30, totalPaid: 0, invoiceCount: 0, clientCount: 0, unpaidCount: 5 }
  );
  assert.strictEqual(card, null);
});

// ---- Layer 3: GET /invoices/api/recent-revenue surfaces unpaidCount ----

const apiLayer = (invoiceRoutes.stack || []).find((l) =>
  l.route && l.route.path === '/api/recent-revenue'
);

function mockResponse() {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    json(payload) { this.body = payload; return this; }
  };
  return res;
}

function mockRequest(query = {}, sessionUser = { id: 1 }) {
  return { query, session: { user: sessionUser } };
}

async function fireApiHandler(req, res) {
  const stack = apiLayer.route.stack;
  const finalLayer = stack[stack.length - 1];
  await finalLayer.handle(req, res, () => {});
}

test('API: unpaidCount is surfaced at the top level of the response (Pro user, populated card)', async () => {
  mockUserById = { id: 1, plan: 'pro' };
  mockStats = { totalPaid: 100, invoiceCount: 1, clientCount: 1, unpaidCount: 4 };
  const req = mockRequest({ days: '30' });
  const res = mockResponse();
  await fireApiHandler(req, res);
  assert.strictEqual(res.body.unpaidCount, 4);
  assert.ok(res.body.card, 'card must be populated');
  assert.strictEqual(res.body.card.unpaidCount, 4, 'card payload also carries unpaidCount');
});

test('API: unpaidCount is surfaced at the top level even when card===null (zero paid in window)', async () => {
  // Critical: this is the exact case the #127 CTA was built for. The user
  // toggled to a window with no paid invoices (card returns null per
  // buildRecentRevenueCard's invoiceCount===0 gate) but they still have
  // open unpaid invoices to follow up on. The top-level unpaidCount lets
  // the client drive the CTA without a populated card.
  mockUserById = { id: 1, plan: 'pro' };
  mockStats = { totalPaid: 0, invoiceCount: 0, clientCount: 0, unpaidCount: 6 };
  const req = mockRequest({ days: '7' });
  const res = mockResponse();
  await fireApiHandler(req, res);
  assert.strictEqual(res.body.card, null);
  assert.strictEqual(res.body.unpaidCount, 6, 'unpaidCount must survive the card===null path');
});

test('API: unpaidCount falls back to 0 when stats lookup throws (graceful)', async () => {
  mockUserById = { id: 1, plan: 'pro' };
  mockStatsThrows = true;
  const origErr = console.error;
  console.error = () => {};
  try {
    const req = mockRequest({ days: '30' });
    const res = mockResponse();
    await fireApiHandler(req, res);
    // loadRecentRevenueStats catches the throw and returns null;
    // the route reads stats?.unpaidCount and falls back to 0.
    assert.strictEqual(res.body.unpaidCount, 0);
    assert.strictEqual(res.body.card, null);
    assert.strictEqual(res.statusCode, 200);
  } finally {
    console.error = origErr;
    mockStatsThrows = false;
  }
});

test('API: free-plan user gets unpaidCount surfaced (informational) but card=null', async () => {
  // Free users don't have a card but the top-level unpaidCount is harmless
  // (no leak; just a count of their own invoices). Documents the surface
  // shape — if a future change wants to gate unpaidCount on plan, this
  // assertion must move.
  mockUserById = { id: 1, plan: 'free' };
  mockStats = { totalPaid: 0, invoiceCount: 0, clientCount: 0, unpaidCount: 2 };
  const req = mockRequest({ days: '30' });
  const res = mockResponse();
  await fireApiHandler(req, res);
  assert.strictEqual(res.body.card, null);
  assert.strictEqual(res.body.unpaidCount, 2);
});

// ---- Layer 4: dashboard.ejs view renders the CTA correctly -------------

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
    recentRevenue: { days: 30, totalPaid: 1234.56, invoiceCount: 4, clientCount: 2, unpaidCount: 3 },
    ...locals
  }, {
    views: [path.join(__dirname, '..', 'views')],
    filename: dashboardTplPath
  });
}

test('view: invoice table wrapper carries id="invoices-table" (CTA deep-link target)', () => {
  const html = renderDashboard({});
  assert.match(html, /id="invoices-table"/);
});

test('view: CTA block exists with x-show="totalPaid === 0 && unpaidCount > 0"', () => {
  const html = renderDashboard({});
  assert.match(html, /x-show="totalPaid === 0 && unpaidCount > 0"/);
  assert.match(html, /data-testid="recent-revenue-quiet-cta"/);
});

test('view: CTA block carries role="status" + aria-live="polite" for screen-reader announcement', () => {
  // The CTA appears reactively after a toggle changes the window — without
  // the live-region announcement, screen-reader users miss the new action
  // option. role=status alone is implicitly polite in modern AT, but pairing
  // with aria-live=polite makes the contract explicit (regression guard
  // against future class refactors that could strip role).
  const html = renderDashboard({});
  const m = html.match(/<p\s+x-show="totalPaid === 0 && unpaidCount > 0"[^>]*?>/);
  assert.ok(m, 'CTA <p> must exist');
  assert.match(m[0], /role="status"/);
  assert.match(m[0], /aria-live="polite"/);
});

test('view: CTA anchor links to #invoices-table (deep-link contract)', () => {
  const html = renderDashboard({});
  assert.match(html, /data-testid="recent-revenue-quiet-cta-link"[^>]*\bhref="#invoices-table"|href="#invoices-table"[^>]*data-testid="recent-revenue-quiet-cta-link"/);
});

test('view: CTA copy contains "Send", a count placeholder, and "follow-up" with reactive plural', () => {
  const html = renderDashboard({});
  assert.match(html, /Send\s+<span\s+x-text="unpaidCount">/);
  assert.match(html, /follow-up/);
  // Plural "s" appears under x-show="unpaidCount !== 1" so 1 follow-up
  // doesn't render "Send 1 follow-ups".
  assert.match(html, /x-show="unpaidCount !== 1"/);
});

test('view: x-data init seeds unpaidCount alongside the existing fields', () => {
  const html = renderDashboard({
    recentRevenue: { days: 30, totalPaid: 0, invoiceCount: 1, clientCount: 1, unpaidCount: 5 }
  });
  // The Alpine factory's seed payload must include unpaidCount so the CTA
  // can fire on first paint without waiting for a fetch.
  assert.match(html, /"unpaidCount":\s*5/);
});

test('view: SSR fallback content for the CTA count uses the threaded recentRevenue.unpaidCount', () => {
  const html = renderDashboard({
    recentRevenue: { days: 30, totalPaid: 1234.56, invoiceCount: 4, clientCount: 2, unpaidCount: 7 }
  });
  // Inside the x-text="unpaidCount" element we still SSR'd 7 as fallback
  // content — meaningful before Alpine hydrates.
  assert.match(html, /<span\s+x-text="unpaidCount">\s*7\s*<\/span>/);
});

test('view: CTA is x-cloak-gated to prevent first-paint flash on cards with paid revenue', () => {
  const html = renderDashboard({});
  // The CTA's <p> must carry x-cloak so that a card with totalPaid > 0
  // doesn't briefly render the link before Alpine evaluates the x-show.
  // Capture the CTA <p> and check its attributes.
  const m = html.match(/<p\s+x-show="totalPaid === 0 && unpaidCount > 0"[^>]*?>/);
  assert.ok(m, 'CTA <p> must exist');
  assert.match(m[0], /x-cloak/, 'CTA <p> must carry x-cloak');
});

test('view: select() update path reads card.unpaidCount AND falls back to top-level data.unpaidCount', () => {
  const html = renderDashboard({});
  // Both client paths must exist — card branch:
  assert.match(html, /data\.card\.unpaidCount/);
  // And the card===null branch:
  assert.match(html, /data\.unpaidCount/);
});

test('view: factory state object includes unpaidCount as an initial reactive field', () => {
  const html = renderDashboard({});
  // The factory return literal must declare unpaidCount as a reactive prop
  // (so x-show / x-text bindings see updates after select()).
  assert.match(html, /unpaidCount:\s*Number\(initial\.unpaidCount\)\s*\|\|\s*0/);
});

test('view: deep-link target sits ON the table wrapper (not inside the table) for accurate scroll', () => {
  const html = renderDashboard({});
  // Capture the wrapper opening tag — it must have id="invoices-table".
  // The id MUST be on the wrapper (not <table>) so the rounded border + padding
  // are part of the scroll target and the user lands at the visual top of the
  // card, not at the first <tr>.
  const wrapper = html.match(/<div\s+id="invoices-table"\s+[^>]*>\s*<table/);
  assert.ok(wrapper, 'id="invoices-table" must be on the <div> wrapper that immediately precedes <table>');
});

// ---- Run ----------------------------------------------------------------

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
      if (err.stack) console.error(err.stack.split('\n').slice(0, 3).join('\n'));
    }
  }
  console.log(`\n${passed} passed, ${failed} failed (recent-revenue-quiet-window-cta.test.js)`);
  if (failed > 0) process.exit(1);
})();
