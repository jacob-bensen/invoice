'use strict';

/*
 * Stale-draft "send your invoice" prompt — dashboard banner that fires
 * when the user has a real (non-seed) draft invoice 24+ hours old.
 *
 * This is the activation surface between milestones "first invoice
 * created" and "first invoice sent" — the single biggest drop-off point
 * in the trial→paid funnel. Tests cover four layers:
 *
 *  1. db.getOldestStaleDraft SQL contract — status='draft', is_seed=false,
 *     age filter, ORDER ASC, LIMIT 1; param positions; null-userId short
 *     circuit; default minAgeHours.
 *  2. routes/invoices.loadOldestStaleDraft — soft-fails on DB throw and
 *     when the helper is missing on the db stub.
 *  3. routes/invoices.buildStaleDraftPrompt — null user / missing draft
 *     paths; happy-path shape; hours-old computation; numeric coercion.
 *  4. views/dashboard.ejs — banner renders when prompt is set, omits
 *     otherwise; copy carries invoice number, client name, total, hours;
 *     Mark-as-Sent form POSTs the right route with CSRF + status=sent;
 *     hostile client_name is HTML-escaped.
 *
 * Run: node tests/stale-draft-prompt.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ---- Layer 1: db.getOldestStaleDraft SQL contract ----------------------

function loadRealDb() {
  delete require.cache[require.resolve('../db')];
  return require('../db');
}

test('db.getOldestStaleDraft: SQL filters on status=\'draft\' AND is_seed=false', async () => {
  let captured = null;
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };
  };
  try {
    await real.db.getOldestStaleDraft(42);
    assert.ok(captured, 'query was issued');
    assert.match(captured.sql, /status\s*=\s*'draft'/i, 'must filter on draft status');
    assert.match(captured.sql, /is_seed\s*=\s*false/i,
      'must exclude the signup seed sample (is_seed=true) — the banner is for real drafts only');
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.getOldestStaleDraft: SQL has age predicate on created_at with interval-hour units', async () => {
  let captured = null;
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };
  };
  try {
    await real.db.getOldestStaleDraft(42, 24);
    assert.match(captured.sql, /created_at\s*<=\s*NOW\(\)\s*-\s*\(\$\d+\s*\*\s*INTERVAL\s*'1\s*hour'\)/i,
      'must compare created_at to NOW() - ($n * INTERVAL \'1 hour\') so the threshold is parameterized');
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.getOldestStaleDraft: SQL orders by created_at ASC LIMIT 1 (oldest one)', async () => {
  let captured = null;
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };
  };
  try {
    await real.db.getOldestStaleDraft(42, 24);
    assert.match(captured.sql, /ORDER\s+BY\s+created_at\s+ASC/i,
      'ASC orders so the OLDEST stale draft surfaces (most urgent to nudge)');
    assert.match(captured.sql, /LIMIT\s+1/i, 'only one prompt at a time');
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.getOldestStaleDraft: params are [userId, hours] in order; default hours=24', async () => {
  let captured = null;
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };
  };
  try {
    await real.db.getOldestStaleDraft(99);
    assert.strictEqual(captured.params[0], 99, 'userId is first param');
    assert.strictEqual(captured.params[1], 24, 'hours defaults to 24');
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.getOldestStaleDraft: explicit minAgeHours is floored to int and passed through', async () => {
  let captured = null;
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };
  };
  try {
    await real.db.getOldestStaleDraft(7, 48.9);
    assert.strictEqual(captured.params[1], 48, 'fractional hours are floored to int');
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.getOldestStaleDraft: returns null and short-circuits with no userId (no SQL round-trip)', async () => {
  let queried = false;
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async () => { queried = true; return { rows: [] }; };
  try {
    const out = await real.db.getOldestStaleDraft(null);
    assert.strictEqual(out, null, 'returns null on null userId');
    assert.strictEqual(queried, false, 'must not hit the DB when userId is falsy');
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.getOldestStaleDraft: returns null when no rows match', async () => {
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async () => ({ rows: [] });
  try {
    const out = await real.db.getOldestStaleDraft(42);
    assert.strictEqual(out, null);
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.getOldestStaleDraft: returns first row when matches exist', async () => {
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async () => ({
    rows: [{ id: 17, invoice_number: 'INV-2026-0042', client_name: 'Acme Co.', total: '1500.00', created_at: '2026-05-10T00:00:00Z' }]
  });
  try {
    const out = await real.db.getOldestStaleDraft(42);
    assert.strictEqual(out.id, 17);
    assert.strictEqual(out.invoice_number, 'INV-2026-0042');
    assert.strictEqual(out.client_name, 'Acme Co.');
  } finally {
    real.pool.query = originalQuery;
  }
});

// ---- Layer 2: loadOldestStaleDraft soft-fail paths ---------------------

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

let dbStubDraft = null;
let dbStubThrows = false;
let dbStubMethodPresent = true;

const dbStub = {
  pool: { query: async () => ({ rows: [] }) },
  db: {
    getUserById: async () => null,
    getRecentRevenueStats: async () => ({ days: 30, totalPaid: 0, invoiceCount: 0, clientCount: 0, unpaidCount: 0 })
  }
};

function installDbStub() {
  if (dbStubMethodPresent) {
    dbStub.db.getOldestStaleDraft = async () => {
      if (dbStubThrows) throw new Error('boom');
      return dbStubDraft;
    };
  } else {
    delete dbStub.db.getOldestStaleDraft;
  }
  require.cache[require.resolve('../db')] = {
    id: require.resolve('../db'),
    filename: require.resolve('../db'),
    loaded: true,
    exports: dbStub
  };
  delete require.cache[require.resolve('../routes/invoices')];
  return require('../routes/invoices');
}

test('loadOldestStaleDraft: returns the db row on happy path', async () => {
  dbStubDraft = { id: 1, invoice_number: 'INV-2026-0009', client_name: 'A', total: 50, created_at: new Date().toISOString() };
  dbStubThrows = false;
  dbStubMethodPresent = true;
  const routes = installDbStub();
  const result = await routes.loadOldestStaleDraft(1);
  assert.strictEqual(result.id, 1);
});

test('loadOldestStaleDraft: returns null when no userId (no DB call)', async () => {
  dbStubMethodPresent = true;
  const routes = installDbStub();
  const result = await routes.loadOldestStaleDraft(null);
  assert.strictEqual(result, null);
});

test('loadOldestStaleDraft: soft-fails to null when DB throws', async () => {
  dbStubDraft = null;
  dbStubThrows = true;
  dbStubMethodPresent = true;
  const routes = installDbStub();
  const origErr = console.error;
  console.error = () => {};
  try {
    const result = await routes.loadOldestStaleDraft(1);
    assert.strictEqual(result, null,
      'dashboard render must NEVER be blocked by a stale-draft lookup failure');
  } finally {
    console.error = origErr;
    dbStubThrows = false;
  }
});

test('loadOldestStaleDraft: returns null when db.getOldestStaleDraft is missing (legacy DB stub)', async () => {
  dbStubMethodPresent = false;
  const routes = installDbStub();
  const result = await routes.loadOldestStaleDraft(1);
  assert.strictEqual(result, null);
  dbStubMethodPresent = true;
});

// ---- Layer 3: buildStaleDraftPrompt shape contract ---------------------

test('buildStaleDraftPrompt: returns null when user is missing', () => {
  const routes = installDbStub();
  assert.strictEqual(
    routes.buildStaleDraftPrompt(null, { id: 1, invoice_number: 'X', client_name: 'A', total: 1, created_at: new Date() }),
    null
  );
});

test('buildStaleDraftPrompt: returns null when draft is missing', () => {
  const routes = installDbStub();
  assert.strictEqual(routes.buildStaleDraftPrompt({ id: 1 }, null), null);
});

test('buildStaleDraftPrompt: returns null when draft has no id', () => {
  const routes = installDbStub();
  assert.strictEqual(
    routes.buildStaleDraftPrompt({ id: 1 }, { invoice_number: 'X', client_name: 'A' }),
    null
  );
});

test('buildStaleDraftPrompt: happy-path shape (id, invoiceNumber, clientName, total, hoursOld)', () => {
  const routes = installDbStub();
  const fourHoursAgo = new Date(Date.now() - 4 * 3600000);
  const out = routes.buildStaleDraftPrompt(
    { id: 1 },
    { id: 17, invoice_number: 'INV-2026-0042', client_name: 'Acme Co.', total: '1500.00', created_at: fourHoursAgo }
  );
  assert.strictEqual(out.id, 17);
  assert.strictEqual(out.invoiceNumber, 'INV-2026-0042');
  assert.strictEqual(out.clientName, 'Acme Co.');
  assert.strictEqual(out.total, 1500);
  assert.strictEqual(out.hoursOld, 4);
});

test('buildStaleDraftPrompt: hoursOld is floored to int, never negative', () => {
  const routes = installDbStub();
  const future = new Date(Date.now() + 60 * 1000);
  const out = routes.buildStaleDraftPrompt(
    { id: 1 },
    { id: 1, invoice_number: 'X', client_name: 'A', total: 1, created_at: future }
  );
  assert.strictEqual(out.hoursOld, 0, 'clock-skew futures clamp to 0, not negative');
});

test('buildStaleDraftPrompt: missing created_at gives hoursOld=0 (no NaN crash)', () => {
  const routes = installDbStub();
  const out = routes.buildStaleDraftPrompt(
    { id: 1 },
    { id: 1, invoice_number: 'X', client_name: 'A', total: 1, created_at: null }
  );
  assert.strictEqual(out.hoursOld, 0);
});

test('buildStaleDraftPrompt: stringy total parses to Number', () => {
  const routes = installDbStub();
  const out = routes.buildStaleDraftPrompt(
    { id: 1 },
    { id: 1, invoice_number: 'X', client_name: 'A', total: '299.50', created_at: new Date() }
  );
  assert.strictEqual(out.total, 299.5);
});

// ---- Layer 4: dashboard.ejs renders the banner -------------------------

const dashboardTplPath = path.join(__dirname, '..', 'views', 'dashboard.ejs');
const dashboardTpl = fs.readFileSync(dashboardTplPath, 'utf8');

function renderDashboard(locals) {
  return ejs.render(dashboardTpl, {
    title: 'Dashboard',
    flash: null,
    days_left_in_trial: 0,
    csrfToken: 'TEST_CSRF',
    invoices: [
      { id: 1, invoice_number: 'INV-2026-0001', client_name: 'Acme', issued_date: '2026-04-01', total: 500, status: 'draft', is_seed: false }
    ],
    user: { plan: 'pro', invoice_count: 1, subscription_status: null },
    onboarding: null,
    invoiceLimitProgress: null,
    recentRevenue: null,
    annualUpgradePrompt: null,
    socialProof: null,
    celebration: null,
    staleDraftPrompt: null,
    ...locals
  }, {
    views: [path.join(__dirname, '..', 'views')],
    filename: dashboardTplPath
  });
}

test('view: banner is OMITTED when staleDraftPrompt is null', () => {
  const html = renderDashboard({ staleDraftPrompt: null });
  assert.doesNotMatch(html, /data-testid="stale-draft-prompt"/);
});

test('view: banner RENDERS when staleDraftPrompt is set', () => {
  const html = renderDashboard({
    staleDraftPrompt: { id: 17, invoiceNumber: 'INV-2026-0042', clientName: 'Acme Co.', total: 1500, hoursOld: 26 }
  });
  assert.match(html, /data-testid="stale-draft-prompt"/);
});

test('view: banner shows invoice number, client name, total ($X.XX), and hours-old', () => {
  const html = renderDashboard({
    staleDraftPrompt: { id: 17, invoiceNumber: 'INV-2026-0042', clientName: 'Acme Co.', total: 1500, hoursOld: 26 }
  });
  assert.match(html, /INV-2026-0042/, 'invoice number visible');
  assert.match(html, /Acme Co\./, 'client name visible');
  assert.match(html, /\$<span[^>]*>1500\.00<\/span>/, 'total formatted to 2 decimals');
  assert.match(html, /26\+\s+hours/, 'hours-old surface visible');
});

test('view: Mark-as-Sent form POSTs to /invoices/:id/status with status=sent + CSRF', () => {
  const html = renderDashboard({
    staleDraftPrompt: { id: 17, invoiceNumber: 'INV-2026-0042', clientName: 'A', total: 50, hoursOld: 30 }
  });
  // The mark-sent form is the only action on the banner that mutates state —
  // it MUST hit the same /invoices/:id/status endpoint as the invoice-view
  // page and carry the CSRF token under the locals.csrfToken contract.
  const formMatch = html.match(
    /<form\s+action="\/invoices\/17\/status"\s+method="POST"[^>]*>[\s\S]*?data-testid="stale-draft-mark-sent"/
  );
  assert.ok(formMatch, 'Mark-as-Sent form must POST to /invoices/17/status');
  assert.match(formMatch[0], /name="_csrf"\s+value="TEST_CSRF"/, 'CSRF token wired');
  assert.match(formMatch[0], /name="status"\s+value="sent"/, 'status=sent hidden field');
});

test('view: "Open invoice" link deep-links to /invoices/:id', () => {
  const html = renderDashboard({
    staleDraftPrompt: { id: 17, invoiceNumber: 'X', clientName: 'A', total: 1, hoursOld: 24 }
  });
  assert.match(html, /href="\/invoices\/17"[^>]*data-testid="stale-draft-view-link"/);
});

test('view: hostile client_name is HTML-escaped (XSS guard)', () => {
  const html = renderDashboard({
    staleDraftPrompt: {
      id: 1,
      invoiceNumber: 'INV-2026-0001',
      clientName: '<script>alert(1)</script>',
      total: 100,
      hoursOld: 30
    }
  });
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/,
    'raw script tag must NOT appear — EJS <%= must escape');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/,
    'escaped form must appear instead');
});

test('view: banner sits BELOW the celebration banner include (positional contract)', () => {
  // The celebration banner is the highest-priority surface — first-paid
  // celebration must win over a stuck-draft nudge if both fire on the
  // same render. Lock the visual order in.
  const html = renderDashboard({
    staleDraftPrompt: { id: 1, invoiceNumber: 'X', clientName: 'A', total: 1, hoursOld: 24 }
  });
  const celebrationIdx = html.indexOf('data-testid="celebration-banner"');
  const stalePromptIdx = html.indexOf('data-testid="stale-draft-prompt"');
  // celebration partial may render nothing (no celebration locals) — in
  // that case the indices are -1 / >0 and the ordering check is moot.
  // When both appear, celebration must precede.
  if (celebrationIdx !== -1 && stalePromptIdx !== -1) {
    assert.ok(celebrationIdx < stalePromptIdx,
      'celebration banner must render BEFORE the stale-draft prompt');
  }
});

test('view: banner sits ABOVE the invoice-limit-progress block (positional contract)', () => {
  // Stale-draft is more actionable than the limit progress bar for a user
  // who hasn't sent their first real invoice — put it higher in the visual
  // stack so the user sees it before scrolling past the limit meter.
  const html = renderDashboard({
    staleDraftPrompt: { id: 1, invoiceNumber: 'X', clientName: 'A', total: 1, hoursOld: 24 },
    invoiceLimitProgress: { used: 1, max: 3, percent: 33, remaining: 2, atLimit: false, nearLimit: false },
    user: { plan: 'free', invoice_count: 1 }
  });
  const stalePromptIdx = html.indexOf('data-testid="stale-draft-prompt"');
  const limitProgressIdx = html.indexOf('data-testid="invoice-limit-progress"');
  assert.ok(stalePromptIdx !== -1, 'stale-draft banner present');
  assert.ok(limitProgressIdx !== -1, 'limit-progress block present');
  assert.ok(stalePromptIdx < limitProgressIdx,
    'stale-draft prompt must render BEFORE invoice-limit-progress');
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
  console.log(`\n${passed} passed, ${failed} failed (stale-draft-prompt.test.js)`);
  if (failed > 0) process.exit(1);
})();
