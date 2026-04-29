'use strict';

/*
 * #117 — Recent-revenue window toggle (7d / 30d / 90d) tests.
 *
 * Two layers of coverage:
 *
 *  1. JSON API endpoint contract — `GET /invoices/api/recent-revenue?days=N`.
 *     Lives in routes/invoices.js. Reuses the existing buildRecentRevenueCard
 *     helper so render decisions (free → null, no paid → null) carry over
 *     identically. We exercise the route handler in-process (no supertest)
 *     by stubbing db + Express req/res shapes.
 *
 *     Risks guarded:
 *       - Days arg must be whitelisted to [7, 30, 90] — anything else
 *         (negative, zero, NaN, missing, far-future) silently falls back
 *         to 30. Without this guard, a client could pass days=99999 and
 *         hit the 365 clamp inside db.getRecentRevenueStats — not a leak,
 *         but the surface should be predictable.
 *       - Free-plan users get a 200 with `card: null`. Regression-prevents
 *         a future change that would leak the card to free users.
 *       - Pro users with no paid invoices in the window get `card: null`
 *         (graceful — same as SSR).
 *       - DB failure returns a 500 with `card: null` (not unhandled).
 *       - Response carries `Cache-Control: no-store` so the browser doesn't
 *         re-show stale data on toggle.
 *       - The route is mounted before /:id (so 'api' isn't matched as an
 *         invoice id). We can't test mount order from here directly, but
 *         we assert the registered route path string.
 *
 *  2. Dashboard view toggle render — the Alpine x-data scope, button row,
 *     ARIA, fetch wiring. Pure regex assertions on the rendered EJS.
 *
 *     Risks guarded:
 *       - Toggle row carries 3 buttons (7d / 30d / 90d) with @click bindings.
 *       - aria-pressed attribute is reactive (`:aria-pressed`).
 *       - Loading + errored flags exist + drive UI (opacity dim + status line).
 *       - The fetch URL points at /invoices/api/recent-revenue (matches the
 *         route mount) — drift between view and route surfaces here.
 *       - The Alpine init seed is JSON-encoded (so EJS tag-injection in
 *         days/totalPaid values can't escape into the attribute).
 *
 * Run: node tests/recent-revenue-window-toggle.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');

// ---- Stub db (in-memory) before requiring the route module --------------

let mockUserById = { id: 1, plan: 'pro' };
let mockStats = { days: 30, totalPaid: 1234.56, invoiceCount: 4, clientCount: 2 };
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
const router = invoiceRoutes; // express.Router instance + extra exports

// ---- Locate the API route layer in the router stack --------------------

const apiLayer = (router.stack || []).find((l) =>
  l.route && l.route.path === '/api/recent-revenue'
);

// ---- Test harness -------------------------------------------------------

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// Minimal mock req/res. Captures status, headers, body via res.json|status|set.
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
  return {
    query,
    session: { user: sessionUser }
  };
}

// Fire the route handler directly. requireAuth simply checks
// req.session.user and calls next() when present — our mock satisfies it,
// so we skip the middleware iteration and invoke the final handler
// directly (it's the last layer on the route stack). Awaiting the return
// guarantees res.json has fired before assertions run.
async function fireApiHandler(req, res) {
  const stack = apiLayer.route.stack;
  const finalLayer = stack[stack.length - 1];
  await finalLayer.handle(req, res, () => {});
}

// ---- Layer 1: API endpoint contract -------------------------------------

test('API: route registered at /api/recent-revenue (mount-order regression guard)', () => {
  assert.ok(apiLayer, 'route /api/recent-revenue must exist on the router stack');
  assert.ok(apiLayer.route.methods.get, 'route must accept GET');
  // Find the index of /api/recent-revenue and the index of /:id; api MUST come
  // first or Express will route 'api' as an invoice id.
  const stackPaths = (router.stack || []).filter((l) => l.route).map((l) => l.route.path);
  const apiIdx = stackPaths.indexOf('/api/recent-revenue');
  const idIdx = stackPaths.indexOf('/:id');
  assert.ok(apiIdx >= 0, '/api/recent-revenue route missing');
  assert.ok(idIdx >= 0, '/:id route missing');
  assert.ok(apiIdx < idIdx, '/api/recent-revenue must be mounted BEFORE /:id');
});

test('API: days=7 returns the 7-day card for a Pro user with paid invoices', async () => {
  mockUserById = { id: 1, plan: 'pro' };
  mockStats = { totalPaid: 500, invoiceCount: 2, clientCount: 1 };
  const req = mockRequest({ days: '7' });
  const res = mockResponse();
  await fireApiHandler(req, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.days, 7);
  assert.ok(res.body.card, 'card must be populated');
  assert.strictEqual(res.body.card.days, 7);
  assert.strictEqual(res.body.card.totalPaid, 500);
});

test('API: days=30 (default) is returned when query is missing', async () => {
  mockUserById = { id: 1, plan: 'pro' };
  mockStats = { totalPaid: 100, invoiceCount: 1, clientCount: 1 };
  const req = mockRequest({});
  const res = mockResponse();
  await fireApiHandler(req, res);
  assert.strictEqual(res.body.days, 30);
});

test('API: days=90 is accepted (whitelist member)', async () => {
  mockUserById = { id: 1, plan: 'pro' };
  mockStats = { totalPaid: 9000, invoiceCount: 12, clientCount: 5 };
  const req = mockRequest({ days: '90' });
  const res = mockResponse();
  await fireApiHandler(req, res);
  assert.strictEqual(res.body.days, 90);
  assert.strictEqual(res.body.card.days, 90);
});

test('API: out-of-whitelist days fall back to 30 (60d, 1d, 365d, 99999d, "garbage", -1, 0)', async () => {
  mockUserById = { id: 1, plan: 'pro' };
  mockStats = { totalPaid: 100, invoiceCount: 1, clientCount: 1 };
  for (const bad of ['60', '1', '365', '99999', 'garbage', '-1', '0', '', null]) {
    const req = mockRequest({ days: bad });
    const res = mockResponse();
    await fireApiHandler(req, res);
    assert.strictEqual(res.body.days, 30, `days=${JSON.stringify(bad)} must clamp to 30`);
  }
});

test('API: free-plan user gets card=null even with paid stats (defence-in-depth)', async () => {
  mockUserById = { id: 1, plan: 'free' };
  mockStats = { totalPaid: 100, invoiceCount: 1, clientCount: 1 };
  const req = mockRequest({ days: '7' });
  const res = mockResponse();
  await fireApiHandler(req, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.card, null, 'free plan must never receive a populated card');
});

test('API: Pro user with zero paid invoices in window returns card=null', async () => {
  mockUserById = { id: 1, plan: 'pro' };
  mockStats = { totalPaid: 0, invoiceCount: 0, clientCount: 0 };
  const req = mockRequest({ days: '7' });
  const res = mockResponse();
  await fireApiHandler(req, res);
  assert.strictEqual(res.body.card, null);
});

test('API: response carries Cache-Control: no-store', async () => {
  mockUserById = { id: 1, plan: 'pro' };
  mockStats = { totalPaid: 100, invoiceCount: 1, clientCount: 1 };
  const req = mockRequest({ days: '7' });
  const res = mockResponse();
  await fireApiHandler(req, res);
  assert.strictEqual(res.headers['cache-control'], 'no-store');
});

test('API: stats DB throw is caught internally — still returns 200 with card=null (graceful, never crashes)', async () => {
  mockUserById = { id: 1, plan: 'pro' };
  mockStatsThrows = true;
  // Silence the expected console.error from loadRecentRevenueStats.
  const origErr = console.error;
  console.error = () => {};
  try {
    const req = mockRequest({ days: '30' });
    const res = mockResponse();
    await fireApiHandler(req, res);
    // loadRecentRevenueStats internally catches getRecentRevenueStats throws
    // and returns null; the API surface returns 200 (not 500) with card=null
    // — graceful degradation, the dashboard toggle reverts to last-known.
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.card, null);
    assert.strictEqual(res.body.days, 30);
  } finally {
    console.error = origErr;
    mockStatsThrows = false;
  }
});

test('API: top-level DB error (getUserById throws) returns 500 with card=null', async () => {
  // Force the outer try/catch by making getUserById itself throw — there's
  // no inner wrapper around getUserById, so a throw bubbles to the route's
  // outer catch and produces 500 + error: 'lookup_failed'.
  const orig = dbStub.db.getUserById;
  dbStub.db.getUserById = async () => { throw new Error('pg connection refused'); };
  const origErr = console.error;
  console.error = () => {};
  try {
    const req = mockRequest({ days: '30' });
    const res = mockResponse();
    await fireApiHandler(req, res);
    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(res.body.card, null);
    assert.strictEqual(res.body.error, 'lookup_failed');
    assert.strictEqual(res.body.days, 30);
  } finally {
    dbStub.db.getUserById = orig;
    console.error = origErr;
  }
});

test('API: agency plan is treated like Pro (not blocked)', async () => {
  mockUserById = { id: 1, plan: 'agency' };
  mockStats = { totalPaid: 8000, invoiceCount: 9, clientCount: 4 };
  const req = mockRequest({ days: '90' });
  const res = mockResponse();
  await fireApiHandler(req, res);
  assert.ok(res.body.card, 'agency must receive a populated card');
});

test('API: missing user (deleted account, dangling session) returns card=null', async () => {
  mockUserById = null;
  mockStats = { totalPaid: 100, invoiceCount: 1, clientCount: 1 };
  const req = mockRequest({ days: '7' });
  const res = mockResponse();
  await fireApiHandler(req, res);
  assert.strictEqual(res.body.card, null);
});

test('API: RECENT_REVENUE_WINDOWS export matches the values the toggle UI uses', () => {
  assert.deepStrictEqual(invoiceRoutes.RECENT_REVENUE_WINDOWS, [7, 30, 90]);
});

// ---- Layer 2: Dashboard view toggle render ------------------------------

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
    recentRevenue: { days: 30, totalPaid: 1234.56, invoiceCount: 4, clientCount: 2 },
    ...locals
  }, {
    views: [path.join(__dirname, '..', 'views')],
    filename: dashboardTplPath
  });
}

test('view: toggle renders 3 buttons (7d / 30d / 90d)', () => {
  const html = renderDashboard({});
  // The toggle uses an Alpine template iterating over [7, 30, 90] — assert
  // the literal array literal appears in the script source so a future
  // edit can't silently change the offered windows.
  assert.match(html, /\[7,\s*30,\s*90\]/);
  // Toggle wrapper carries the data-testid so tests / analytics can hook in.
  assert.match(html, /data-testid="recent-revenue-toggle"/);
  // Role + aria for screen readers.
  assert.match(html, /role="group"/);
  assert.match(html, /aria-label="Choose revenue window"/);
});

test('view: toggle binds @click to a select() Alpine method', () => {
  const html = renderDashboard({});
  assert.match(html, /@click="select\(opt\)"/);
});

test('view: toggle exposes :aria-pressed reactive to the active window', () => {
  const html = renderDashboard({});
  assert.match(html, /:aria-pressed="days === opt \? 'true' : 'false'"/);
});

test('view: toggle disables buttons during in-flight fetch (no double-click race)', () => {
  const html = renderDashboard({});
  assert.match(html, /:disabled="loading"/);
});

test('view: x-data init seeds days/totalPaid/invoiceCount/clientCount from server', () => {
  const html = renderDashboard({
    recentRevenue: { days: 30, totalPaid: 2400, invoiceCount: 6, clientCount: 3 }
  });
  // The init JSON is HTML-escaped by EJS via JSON.stringify -> attribute. The
  // reasonable shape check: the seed contains the days + totalPaid figures.
  assert.match(html, /x-data='recentRevenueCard\(\{[^']*"days":\s*30/);
  assert.match(html, /"totalPaid":\s*2400/);
  assert.match(html, /"invoiceCount":\s*6/);
  assert.match(html, /"clientCount":\s*3/);
});

test('view: tile values are rendered via x-text (so Alpine can re-render them)', () => {
  const html = renderDashboard({});
  assert.match(html, /x-text="formatMoney\(totalPaid\)"/);
  assert.match(html, /x-text="invoiceCount"/);
  assert.match(html, /x-text="clientCount"/);
});

test('view: SSR fallback values still render before Alpine boots', () => {
  // Even without JS, the user must see real numbers (graceful degradation).
  const html = renderDashboard({
    recentRevenue: { days: 30, totalPaid: 1234.56, invoiceCount: 4, clientCount: 2 }
  });
  // Inside the x-text="formatMoney(totalPaid)" element we still SSR'd
  // $1,234.56 as the placeholder content.
  assert.match(html, /\$1,234\.56/);
  // The tile counts SSR-render too.
  assert.match(html, /data-testid="recent-revenue-invoices"[^>]*>[\s\S]*?4/);
  assert.match(html, /data-testid="recent-revenue-clients"[^>]*>[\s\S]*?2/);
});

test('view: fetch URL matches the registered API route path', () => {
  const html = renderDashboard({});
  // The toggle JS posts at /invoices/api/recent-revenue?days=N — drift between
  // view and route surfaces here.
  assert.match(html, /\/invoices\/api\/recent-revenue\?days=/);
});

test('view: error fallback line is present (x-show="errored") for graceful failure', () => {
  const html = renderDashboard({});
  assert.match(html, /x-show="errored"/);
  assert.match(html, /role="status"/);
  assert.match(html, /data-testid="recent-revenue-error"/);
});

test('view: loading dim class fires only during fetch (opacity-60)', () => {
  const html = renderDashboard({});
  assert.match(html, /:class="loading \? 'opacity-60 transition-opacity' : ''"/);
});

test('view: toggle is hidden from print (carried by parent print:hidden)', () => {
  const html = renderDashboard({});
  // The toggle row sits inside the parent card div which has print:hidden.
  // We assert the parent class still includes print:hidden (regression guard
  // — the toggle MUST NOT escape the print:hidden boundary).
  const cardOpenMatch = html.match(/<div\s+x-data='recentRevenueCard[\s\S]*?class="([^"]+)"/);
  assert.ok(cardOpenMatch, 'card root div with x-data must exist');
  assert.match(cardOpenMatch[1], /print:hidden/);
});

test('view: toggle is omitted on free-plan dashboard (recentRevenue is null)', () => {
  const html = renderDashboard({
    user: { plan: 'free', invoice_count: 1, subscription_status: null },
    recentRevenue: null
  });
  assert.doesNotMatch(html, /data-testid="recent-revenue-toggle"/);
});

// ---- Run ---------------------------------------------------------------

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
  console.log(`\n${passed} passed, ${failed} failed (recent-revenue-window-toggle.test.js)`);
  if (failed > 0) process.exit(1);
})();
