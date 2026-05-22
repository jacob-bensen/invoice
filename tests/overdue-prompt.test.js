'use strict';

/*
 * Overdue prompt — dashboard banner that fires when the user has an
 * unpaid invoice whose due_date has passed. In-app analog of the daily
 * jobs/overdue-freelancer-digest.js email cron (which enforces a 7-day
 * per-user cooldown). The in-app surface closes the cooldown gap and gives
 * the freelancer an immediate "open & chase" surface the moment they return
 * to the dashboard.
 *
 * Layers:
 *  1. db.getOldestOverdueInvoice SQL contract — status filter,
 *     is_seed=false, due_date < CURRENT_DATE, ORDER ASC, LIMIT 1, params,
 *     SELECT projection.
 *  2. routes/invoices.loadOldestOverdueInvoice — soft-fails on DB throw,
 *     on missing method, on null userId.
 *  3. routes/invoices.buildOverduePrompt — null user / missing invoice /
 *     missing due_date paths; happy-path shape; daysPastDue computation;
 *     suppression when other M4 prompts already target the same invoice id.
 *  4. views/dashboard.ejs — banner renders when prompt set, omits
 *     otherwise; copy carries client + invoice + total + daysPastDue;
 *     CTA deep-links; mark-as-paid form POSTs status=paid with CSRF;
 *     hostile client_name escaped; positional ordering.
 *
 * Run: node tests/overdue-prompt.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ---- Layer 1: db.getOldestOverdueInvoice SQL contract -------------------

function loadRealDb() {
  delete require.cache[require.resolve('../db')];
  return require('../db');
}

test('db.getOldestOverdueInvoice: SQL filters on status IN (\'sent\',\'overdue\')', async () => {
  let captured = null;
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };
  };
  try {
    await real.db.getOldestOverdueInvoice(42);
    assert.ok(captured, 'query was issued');
    assert.match(captured.sql, /status\s+IN\s*\(\s*'sent'\s*,\s*'overdue'\s*\)/i,
      'must filter on sent OR overdue (paid + draft excluded)');
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.getOldestOverdueInvoice: SQL excludes is_seed=true', async () => {
  let captured = null;
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };
  };
  try {
    await real.db.getOldestOverdueInvoice(42);
    assert.match(captured.sql, /is_seed\s*=\s*false/i,
      'must exclude seed sample — banner is for real invoices only');
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.getOldestOverdueInvoice: SQL anchors on due_date < CURRENT_DATE', async () => {
  let captured = null;
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };
  };
  try {
    await real.db.getOldestOverdueInvoice(42);
    assert.match(captured.sql, /due_date\s+IS\s+NOT\s+NULL/i,
      'must require due_date IS NOT NULL — null due_date can\'t be past due');
    assert.match(captured.sql, /due_date\s*<\s*CURRENT_DATE/i,
      'must compare due_date to CURRENT_DATE — the contractual late signal');
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.getOldestOverdueInvoice: SQL orders by due_date ASC LIMIT 1 (most overdue first)', async () => {
  let captured = null;
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };
  };
  try {
    await real.db.getOldestOverdueInvoice(42);
    assert.match(captured.sql, /ORDER\s+BY\s+due_date\s+ASC/i,
      'oldest-due first — most-overdue invoice is highest priority to chase');
    assert.match(captured.sql, /LIMIT\s+1/i, 'one prompt at a time');
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.getOldestOverdueInvoice: params are [userId]', async () => {
  let captured = null;
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };
  };
  try {
    await real.db.getOldestOverdueInvoice(99);
    assert.strictEqual(captured.params.length, 1, 'single param: userId');
    assert.strictEqual(captured.params[0], 99, 'userId is first param');
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.getOldestOverdueInvoice: returns null and skips DB on falsy userId', async () => {
  let queried = false;
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async () => { queried = true; return { rows: [] }; };
  try {
    const out = await real.db.getOldestOverdueInvoice(null);
    assert.strictEqual(out, null);
    assert.strictEqual(queried, false, 'no DB round-trip on falsy userId');
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.getOldestOverdueInvoice: returns null when no rows match', async () => {
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async () => ({ rows: [] });
  try {
    const out = await real.db.getOldestOverdueInvoice(42);
    assert.strictEqual(out, null);
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.getOldestOverdueInvoice: returns first row with id/number/client/total/due_date/status', async () => {
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async () => ({
    rows: [{
      id: 88,
      invoice_number: 'INV-2026-0099',
      client_name: 'Big Client Co.',
      total: '2500.00',
      due_date: '2026-05-01',
      status: 'sent',
      first_viewed_at: null,
      sent_via_share_intent_at: null
    }]
  });
  try {
    const out = await real.db.getOldestOverdueInvoice(42);
    assert.strictEqual(out.id, 88);
    assert.strictEqual(out.invoice_number, 'INV-2026-0099');
    assert.strictEqual(out.client_name, 'Big Client Co.');
    assert.strictEqual(out.status, 'sent');
    assert.ok(out.due_date, 'must project due_date for the daysPastDue calc');
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.getOldestOverdueInvoice: SELECT projection includes due_date + suppression keys', async () => {
  let captured = null;
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };
  };
  try {
    await real.db.getOldestOverdueInvoice(42);
    assert.match(captured.sql, /due_date/, 'must project due_date for the daysPastDue calc');
    // first_viewed_at + sent_via_share_intent_at present so the builder can
    // log / future-extend the suppression logic if needed.
    assert.match(captured.sql, /first_viewed_at/, 'projects first_viewed_at');
    assert.match(captured.sql, /sent_via_share_intent_at/, 'projects sent_via_share_intent_at');
  } finally {
    real.pool.query = originalQuery;
  }
});

// ---- Layer 2: loadOldestOverdueInvoice soft-fail paths ------------------

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

let dbStubInvoice = null;
let dbStubThrows = false;
let dbStubMethodPresent = true;

const dbStub = {
  pool: { query: async () => ({ rows: [] }) },
  db: {
    getUserById: async () => null,
    getRecentRevenueStats: async () => ({ days: 30, totalPaid: 0, invoiceCount: 0, clientCount: 0, unpaidCount: 0 }),
    getOldestStaleDraft: async () => null,
    getOldestClientViewedUnpaid: async () => null,
    getOldestSentNotViewed: async () => null
  }
};

function installDbStub() {
  if (dbStubMethodPresent) {
    dbStub.db.getOldestOverdueInvoice = async () => {
      if (dbStubThrows) throw new Error('boom');
      return dbStubInvoice;
    };
  } else {
    delete dbStub.db.getOldestOverdueInvoice;
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

test('loadOldestOverdueInvoice: returns the db row on happy path', async () => {
  dbStubInvoice = { id: 88, invoice_number: 'X', client_name: 'A', total: 100, due_date: '2026-04-01', status: 'sent' };
  dbStubThrows = false;
  dbStubMethodPresent = true;
  const routes = installDbStub();
  const result = await routes.loadOldestOverdueInvoice(1);
  assert.strictEqual(result.id, 88);
});

test('loadOldestOverdueInvoice: returns null when no userId (no DB call)', async () => {
  dbStubMethodPresent = true;
  const routes = installDbStub();
  const result = await routes.loadOldestOverdueInvoice(null);
  assert.strictEqual(result, null);
});

test('loadOldestOverdueInvoice: soft-fails to null on DB throw', async () => {
  dbStubInvoice = null;
  dbStubThrows = true;
  dbStubMethodPresent = true;
  const routes = installDbStub();
  const origErr = console.error;
  console.error = () => {};
  try {
    const result = await routes.loadOldestOverdueInvoice(1);
    assert.strictEqual(result, null,
      'dashboard render must never be blocked by an overdue lookup failure');
  } finally {
    console.error = origErr;
    dbStubThrows = false;
  }
});

test('loadOldestOverdueInvoice: returns null when db method missing (legacy stub)', async () => {
  dbStubMethodPresent = false;
  const routes = installDbStub();
  const result = await routes.loadOldestOverdueInvoice(1);
  assert.strictEqual(result, null);
  dbStubMethodPresent = true;
});

// ---- Layer 3: buildOverduePrompt shape contract -------------------------

test('buildOverduePrompt: returns null when user missing', () => {
  const routes = installDbStub();
  assert.strictEqual(
    routes.buildOverduePrompt(null, { id: 1, due_date: '2026-04-01' }),
    null
  );
});

test('buildOverduePrompt: returns null when invoice missing', () => {
  const routes = installDbStub();
  assert.strictEqual(routes.buildOverduePrompt({ id: 1 }, null), null);
});

test('buildOverduePrompt: returns null when invoice has no id', () => {
  const routes = installDbStub();
  assert.strictEqual(
    routes.buildOverduePrompt({ id: 1 }, { invoice_number: 'X', due_date: '2026-04-01' }),
    null
  );
});

test('buildOverduePrompt: returns null when due_date missing (defence-in-depth)', () => {
  const routes = installDbStub();
  assert.strictEqual(
    routes.buildOverduePrompt({ id: 1 }, { id: 17, due_date: null }),
    null
  );
});

test('buildOverduePrompt: returns null when due_date is unparseable', () => {
  const routes = installDbStub();
  assert.strictEqual(
    routes.buildOverduePrompt({ id: 1 }, { id: 17, due_date: 'not-a-date' }),
    null
  );
});

test('buildOverduePrompt: happy-path shape (id, invoiceNumber, clientName, total, daysPastDue, status)', () => {
  const routes = installDbStub();
  const fiveDaysAgo = new Date(Date.now() - 5 * 86400000);
  const out = routes.buildOverduePrompt(
    { id: 1 },
    { id: 88, invoice_number: 'INV-2026-0099', client_name: 'Acme Co.', total: '2500.00',
      due_date: fiveDaysAgo.toISOString(), status: 'sent' }
  );
  assert.strictEqual(out.id, 88);
  assert.strictEqual(out.invoiceNumber, 'INV-2026-0099');
  assert.strictEqual(out.clientName, 'Acme Co.');
  assert.strictEqual(out.total, 2500);
  assert.strictEqual(out.daysPastDue, 5);
  assert.strictEqual(out.status, 'sent');
});

test('buildOverduePrompt: daysPastDue floor is 1 (never "0 days past due")', () => {
  const routes = installDbStub();
  // Due just barely (an hour ago): sub-day windows clamp to 1.
  const oneHourAgo = new Date(Date.now() - 3600 * 1000);
  const out = routes.buildOverduePrompt(
    { id: 1 },
    { id: 1, due_date: oneHourAgo.toISOString() }
  );
  assert.strictEqual(out.daysPastDue, 1, 'sub-day windows clamp to 1 — copy stays grammatical');
});

test('buildOverduePrompt: stringy total parses to Number', () => {
  const routes = installDbStub();
  const threeDaysAgo = new Date(Date.now() - 3 * 86400000);
  const out = routes.buildOverduePrompt(
    { id: 1 },
    { id: 1, due_date: threeDaysAgo.toISOString(), total: '799.99' }
  );
  assert.strictEqual(out.total, 799.99);
});

test('buildOverduePrompt: empty client_name passes through as empty string', () => {
  const routes = installDbStub();
  const threeDaysAgo = new Date(Date.now() - 3 * 86400000);
  const out = routes.buildOverduePrompt(
    { id: 1 },
    { id: 1, due_date: threeDaysAgo.toISOString(), client_name: '' }
  );
  assert.strictEqual(out.clientName, '', 'view layer handles the empty-name fallback copy');
});

test('buildOverduePrompt: status defaults to "sent" when missing', () => {
  const routes = installDbStub();
  const threeDaysAgo = new Date(Date.now() - 3 * 86400000);
  const out = routes.buildOverduePrompt(
    { id: 1 },
    { id: 1, due_date: threeDaysAgo.toISOString() }
  );
  assert.strictEqual(out.status, 'sent');
});

test('buildOverduePrompt: suppressed when clientViewedFollowupPrompt targets the SAME invoice id', () => {
  const routes = installDbStub();
  const threeDaysAgo = new Date(Date.now() - 3 * 86400000);
  const out = routes.buildOverduePrompt(
    { id: 1 },
    { id: 88, due_date: threeDaysAgo.toISOString(), client_name: 'A', total: 100 },
    { clientViewedFollowupPrompt: { id: 88 }, sentNotViewedPrompt: null }
  );
  assert.strictEqual(out, null,
    'avoid double-banner on the same invoice — clientViewedFollowup wins (more action-specific copy)');
});

test('buildOverduePrompt: suppressed when sentNotViewedPrompt targets the SAME invoice id', () => {
  const routes = installDbStub();
  const threeDaysAgo = new Date(Date.now() - 3 * 86400000);
  const out = routes.buildOverduePrompt(
    { id: 1 },
    { id: 88, due_date: threeDaysAgo.toISOString(), client_name: 'A', total: 100 },
    { clientViewedFollowupPrompt: null, sentNotViewedPrompt: { id: 88 } }
  );
  assert.strictEqual(out, null,
    'avoid double-banner on the same invoice — sentNotViewed wins (more action-specific copy)');
});

test('buildOverduePrompt: NOT suppressed when other prompts target a DIFFERENT invoice id', () => {
  const routes = installDbStub();
  const threeDaysAgo = new Date(Date.now() - 3 * 86400000);
  const out = routes.buildOverduePrompt(
    { id: 1 },
    { id: 88, due_date: threeDaysAgo.toISOString(), client_name: 'A', total: 100 },
    { clientViewedFollowupPrompt: { id: 5 }, sentNotViewedPrompt: { id: 7 } }
  );
  assert.ok(out, 'distinct invoices: overdue prompt still fires');
  assert.strictEqual(out.id, 88);
});

test('buildOverduePrompt: id comparison is string-safe (numeric vs stringy ids)', () => {
  const routes = installDbStub();
  const threeDaysAgo = new Date(Date.now() - 3 * 86400000);
  const out = routes.buildOverduePrompt(
    { id: 1 },
    { id: 88, due_date: threeDaysAgo.toISOString(), client_name: 'A', total: 100 },
    { clientViewedFollowupPrompt: { id: '88' }, sentNotViewedPrompt: null }
  );
  assert.strictEqual(out, null,
    '"88" === 88 — Set<string> collapses numeric/string forms');
});

test('buildOverduePrompt: missing otherPrompts argument does not throw', () => {
  const routes = installDbStub();
  const threeDaysAgo = new Date(Date.now() - 3 * 86400000);
  const out = routes.buildOverduePrompt(
    { id: 1 },
    { id: 88, due_date: threeDaysAgo.toISOString(), client_name: 'A', total: 100 }
  );
  assert.ok(out, 'no other-prompts param: still fires');
  assert.strictEqual(out.id, 88);
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
      { id: 1, invoice_number: 'INV-2026-0001', client_name: 'Acme', issued_date: '2026-04-01', total: 500, status: 'sent', is_seed: false, first_viewed_at: null, sent_via_share_intent_at: new Date().toISOString() }
    ],
    user: { plan: 'pro', invoice_count: 1, subscription_status: null },
    onboarding: null,
    invoiceLimitProgress: null,
    recentRevenue: null,
    annualUpgradePrompt: null,
    socialProof: null,
    celebration: null,
    staleDraftPrompt: null,
    clientViewedFollowupPrompt: null,
    sentNotViewedPrompt: null,
    overduePrompt: null,
    firstRealInvoicePrompt: null,
    pendingQuickInvoice: null,
    ...locals
  }, {
    views: [path.join(__dirname, '..', 'views')],
    filename: dashboardTplPath
  });
}

test('view: banner is OMITTED when overduePrompt is null', () => {
  const html = renderDashboard({ overduePrompt: null });
  assert.doesNotMatch(html, /data-testid="overdue-prompt"/);
});

test('view: banner RENDERS when prompt is set', () => {
  const html = renderDashboard({
    overduePrompt: {
      id: 88, invoiceNumber: 'INV-2026-0099', clientName: 'Acme Co.',
      total: 2500, daysPastDue: 5, status: 'sent'
    }
  });
  assert.match(html, /data-testid="overdue-prompt"/);
});

test('view: banner shows client name, invoice number, total, daysPastDue', () => {
  const html = renderDashboard({
    overduePrompt: {
      id: 88, invoiceNumber: 'INV-2026-0099', clientName: 'Acme Co.',
      total: 2500, daysPastDue: 5, status: 'sent'
    }
  });
  assert.match(html, /Acme Co\./, 'client name visible');
  assert.match(html, /INV-2026-0099/, 'invoice number visible');
  assert.match(html, /\$<span[^>]*>2500\.00<\/span>/, 'total formatted to 2 decimals');
  assert.match(html, /<span[^>]*data-testid="overdue-days-past-due"[^>]*>5<\/span>\s*days?\s*past\s*due/, 'daysPastDue surface visible');
});

test('view: copy includes "past due" framing (distinct from view/share cohorts)', () => {
  const html = renderDashboard({
    overduePrompt: {
      id: 88, invoiceNumber: 'X', clientName: 'A', total: 100, daysPastDue: 5, status: 'sent'
    }
  });
  assert.match(html, /past due/i,
    'overdue framing must say "past due" — distinguishes from "opened" / "zero opens" cohorts');
});

test('view: empty client name falls back to "Your invoice is past due"', () => {
  const html = renderDashboard({
    overduePrompt: {
      id: 88, invoiceNumber: 'X', clientName: '', total: 100, daysPastDue: 5, status: 'sent'
    }
  });
  assert.match(html, /Your invoice is past due/);
});

test('view: CTA deep-links to /invoices/:id', () => {
  const html = renderDashboard({
    overduePrompt: {
      id: 88, invoiceNumber: 'X', clientName: 'A', total: 100, daysPastDue: 5, status: 'sent'
    }
  });
  assert.match(html, /href="\/invoices\/88"[^>]*data-testid="overdue-cta"/);
});

test('view: Mark-as-Paid form POSTs to /invoices/:id/status with status=paid + CSRF', () => {
  const html = renderDashboard({
    overduePrompt: {
      id: 88, invoiceNumber: 'X', clientName: 'A', total: 100, daysPastDue: 5, status: 'sent'
    }
  });
  const formMatch = html.match(
    /<form\s+action="\/invoices\/88\/status"\s+method="POST"[^>]*>[\s\S]*?data-testid="overdue-mark-paid"/
  );
  assert.ok(formMatch, 'mark-as-paid form must POST to /invoices/88/status');
  assert.match(formMatch[0], /name="_csrf"\s+value="TEST_CSRF"/, 'CSRF token wired');
  assert.match(formMatch[0], /name="status"\s+value="paid"/, 'status=paid hidden field');
});

test('view: hostile client_name is HTML-escaped (XSS guard)', () => {
  const html = renderDashboard({
    overduePrompt: {
      id: 1, invoiceNumber: 'INV-X', clientName: '<script>alert(1)</script>',
      total: 100, daysPastDue: 5, status: 'sent'
    }
  });
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/,
    'raw script must NOT appear — EJS <%= must escape');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/,
    'escaped form must appear instead');
});

test('view: banner sits BELOW the sent-not-viewed prompt (positional contract)', () => {
  // sent-not-viewed is the silent-failure cohort (channel may have failed).
  // overdue is the contractual-late cohort. Channel-failure is the more
  // urgent action (without it, the client has no chance to pay at all),
  // so it surfaces above the overdue prompt.
  const html = renderDashboard({
    sentNotViewedPrompt: {
      id: 5, invoiceNumber: 'INV-D', clientName: 'D', total: 50, daysAgo: 4, hoursAgo: 96, status: 'sent'
    },
    overduePrompt: {
      id: 88, invoiceNumber: 'X', clientName: 'A', total: 100, daysPastDue: 5, status: 'sent'
    }
  });
  const sentIdx = html.indexOf('data-testid="sent-not-viewed-prompt"');
  const overdueIdx = html.indexOf('data-testid="overdue-prompt"');
  assert.ok(sentIdx !== -1 && overdueIdx !== -1,
    'both banners present in render');
  assert.ok(sentIdx < overdueIdx,
    'sent-not-viewed must render BEFORE overdue (higher-action-priority cohort first)');
});

test('view: banner sits ABOVE the invoice-limit-progress block (positional contract)', () => {
  const html = renderDashboard({
    overduePrompt: {
      id: 88, invoiceNumber: 'X', clientName: 'A', total: 100, daysPastDue: 5, status: 'sent'
    },
    invoiceLimitProgress: { used: 1, max: 3, percent: 33, remaining: 2, atLimit: false, nearLimit: false },
    user: { plan: 'free', invoice_count: 1 }
  });
  const overdueIdx = html.indexOf('data-testid="overdue-prompt"');
  const limitIdx = html.indexOf('data-testid="invoice-limit-progress"');
  assert.ok(overdueIdx !== -1, 'overdue banner present');
  assert.ok(limitIdx !== -1, 'limit-progress block present');
  assert.ok(overdueIdx < limitIdx,
    'overdue must render BEFORE invoice-limit-progress');
});

test('view: data attributes expose invoice-id and days-past-due for hooks', () => {
  const html = renderDashboard({
    overduePrompt: {
      id: 88, invoiceNumber: 'X', clientName: 'A', total: 100, daysPastDue: 5, status: 'sent'
    }
  });
  assert.match(html, /data-invoice-id="88"/);
  assert.match(html, /data-days-past-due="5"/);
});

test('view: banner print:hidden (printed invoice artifact stays clean)', () => {
  const html = renderDashboard({
    overduePrompt: {
      id: 88, invoiceNumber: 'X', clientName: 'A', total: 100, daysPastDue: 5, status: 'sent'
    }
  });
  const blockMatch = html.match(
    /data-testid="overdue-prompt"[\s\S]{0,400}/
  );
  assert.ok(blockMatch, 'banner block located');
  assert.match(blockMatch[0], /print:hidden/);
});

test('view: daysPastDue=1 uses singular "day" (not "days")', () => {
  const html = renderDashboard({
    overduePrompt: {
      id: 88, invoiceNumber: 'X', clientName: 'A', total: 100, daysPastDue: 1, status: 'sent'
    }
  });
  const blockMatch = html.match(
    /data-testid="overdue-prompt"[\s\S]{0,900}/
  );
  assert.ok(blockMatch, 'banner block located');
  assert.match(blockMatch[0], />1<\/span>\s*day\s+past\s+due/i,
    'singular "day past due" copy on daysPastDue=1');
  assert.doesNotMatch(blockMatch[0], />1<\/span>\s*days\s+past\s+due/i,
    'must NOT pluralize on daysPastDue=1');
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
  console.log(`\n${passed} passed, ${failed} failed (overdue-prompt.test.js)`);
  if (failed > 0) process.exit(1);
})();
