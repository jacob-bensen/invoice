'use strict';

/*
 * Recent-view prompt — dashboard banner that fires when an unpaid invoice
 * was viewed by the client within the last 60 minutes. The single highest
 * payment-intent signal we can surface: the client is actively considering
 * the invoice right now. Inline follow-up share intents (WhatsApp/SMS/Copy)
 * give the freelancer a one-tap polite check-in path while the client's
 * tab is still open.
 *
 * Layers:
 *  1. db.getMostRecentlyViewedUnpaid SQL contract — status filter,
 *     is_seed=false, last_viewed_at IS NOT NULL + within-window predicate,
 *     ORDER DESC, LIMIT 1, params, default withinMinutes=60.
 *  2. routes/invoices.loadMostRecentlyViewedUnpaid — soft-fails on
 *     DB throw, on missing method, on null userId.
 *  3. routes/invoices.buildRecentViewPrompt — null user / missing invoice /
 *     missing last_viewed_at paths; happy-path shape; minutesAgo computation;
 *     paymentClaimPrompt suppression; follow-up share intents derivation;
 *     stale-row defence-in-depth window check.
 *  4. clientViewedFollowupPrompt suppression — when recentViewPrompt
 *     targets the same invoice id, the 48h follow-up suppresses.
 *  5. views/dashboard.ejs — banner renders when prompt set, omits otherwise;
 *     copy carries client + invoice + total + minutesAgo + viewCount; CTA
 *     deep-links; mark-as-paid form POSTs status=paid with CSRF; share intents
 *     render when followUpIntents present; hostile client_name escaped;
 *     positional contract above clientViewedFollowupPrompt.
 *
 * Run: node tests/recent-view-prompt.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ---- Layer 1: db.getMostRecentlyViewedUnpaid SQL contract ----------------

function loadRealDb() {
  delete require.cache[require.resolve('../db')];
  return require('../db');
}

test('db.getMostRecentlyViewedUnpaid: SQL filters on status IN (\'sent\',\'overdue\') AND is_seed=false', async () => {
  let captured = null;
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };
  };
  try {
    await real.db.getMostRecentlyViewedUnpaid(42);
    assert.ok(captured, 'query was issued');
    assert.match(captured.sql, /status\s+IN\s*\(\s*'sent'\s*,\s*'overdue'\s*\)/i,
      'must filter on sent OR overdue (draft + paid excluded)');
    assert.match(captured.sql, /is_seed\s*=\s*false/i,
      'must exclude seed sample — banner is for real invoices only');
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.getMostRecentlyViewedUnpaid: SQL requires last_viewed_at IS NOT NULL + within-window predicate', async () => {
  let captured = null;
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };
  };
  try {
    await real.db.getMostRecentlyViewedUnpaid(42, 60);
    assert.match(captured.sql, /last_viewed_at\s+IS\s+NOT\s+NULL/i,
      'must require last_viewed_at IS NOT NULL — the client demonstrably opened the link');
    assert.match(captured.sql, /last_viewed_at\s*>=\s*NOW\(\)\s*-\s*\(\$\d+\s*\*\s*INTERVAL\s*'1\s*minute'\)/i,
      'must compare last_viewed_at to NOW() - ($n * INTERVAL \'1 minute\')');
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.getMostRecentlyViewedUnpaid: SQL orders by last_viewed_at DESC LIMIT 1 (most recent)', async () => {
  let captured = null;
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };
  };
  try {
    await real.db.getMostRecentlyViewedUnpaid(42);
    assert.match(captured.sql, /ORDER\s+BY\s+last_viewed_at\s+DESC/i,
      'most-recent first — freshest live signal');
    assert.match(captured.sql, /LIMIT\s+1/i, 'one prompt at a time');
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.getMostRecentlyViewedUnpaid: params are [userId, minutes]; default minutes=60', async () => {
  let captured = null;
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };
  };
  try {
    await real.db.getMostRecentlyViewedUnpaid(99);
    assert.strictEqual(captured.params[0], 99, 'userId is first param');
    assert.strictEqual(captured.params[1], 60, 'minutes defaults to 60');
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.getMostRecentlyViewedUnpaid: explicit fractional minutes floored', async () => {
  let captured = null;
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };
  };
  try {
    await real.db.getMostRecentlyViewedUnpaid(7, 90.7);
    assert.strictEqual(captured.params[1], 90);
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.getMostRecentlyViewedUnpaid: invalid minutes (zero/negative/garbage) falls back to default', async () => {
  let captured = null;
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };
  };
  try {
    await real.db.getMostRecentlyViewedUnpaid(7, -5);
    assert.strictEqual(captured.params[1], 60, 'negative → default 60');
    await real.db.getMostRecentlyViewedUnpaid(7, 0);
    assert.strictEqual(captured.params[1], 60, 'zero → default 60');
    await real.db.getMostRecentlyViewedUnpaid(7, 'abc');
    assert.strictEqual(captured.params[1], 60, 'garbage → default 60');
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.getMostRecentlyViewedUnpaid: returns null and skips DB on falsy userId', async () => {
  let queried = false;
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async () => { queried = true; return { rows: [] }; };
  try {
    const out = await real.db.getMostRecentlyViewedUnpaid(null);
    assert.strictEqual(out, null);
    assert.strictEqual(queried, false, 'no DB round-trip on falsy userId');
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.getMostRecentlyViewedUnpaid: returns null when no rows match', async () => {
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async () => ({ rows: [] });
  try {
    const out = await real.db.getMostRecentlyViewedUnpaid(42);
    assert.strictEqual(out, null);
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.getMostRecentlyViewedUnpaid: SELECT projection includes last_viewed_at, view_count, public_token (for share intents)', async () => {
  let captured = null;
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };
  };
  try {
    await real.db.getMostRecentlyViewedUnpaid(42);
    assert.match(captured.sql, /last_viewed_at/, 'must project last_viewed_at for the minutesAgo calc');
    assert.match(captured.sql, /view_count/, 'must project view_count for the "opened N times" line');
    assert.match(captured.sql, /public_token/, 'must project public_token so the builder can derive follow-up share intents');
    assert.match(captured.sql, /due_date/, 'must project due_date so the follow-up subject can flag overdue');
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.getMostRecentlyViewedUnpaid: returns first row with id/number/client/total/last_viewed_at/view_count/status/public_token', async () => {
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async () => ({
    rows: [{
      id: 88,
      invoice_number: 'INV-2026-0099',
      client_name: 'Big Client Co.',
      total: '2500.00',
      first_viewed_at: '2026-05-20T12:00:00Z',
      last_viewed_at: '2026-05-25T08:30:00Z',
      view_count: 4,
      status: 'sent',
      public_token: 'a1b2c3d4e5f6a7b8',
      client_email: 'pay@bigclient.com',
      due_date: '2026-05-30'
    }]
  });
  try {
    const out = await real.db.getMostRecentlyViewedUnpaid(42);
    assert.strictEqual(out.id, 88);
    assert.strictEqual(out.invoice_number, 'INV-2026-0099');
    assert.strictEqual(out.client_name, 'Big Client Co.');
    assert.strictEqual(out.view_count, 4);
    assert.strictEqual(out.status, 'sent');
    assert.strictEqual(out.public_token, 'a1b2c3d4e5f6a7b8');
  } finally {
    real.pool.query = originalQuery;
  }
});

// ---- Layer 2: loadMostRecentlyViewedUnpaid soft-fail paths --------------

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

let dbStubInvoice = null;
let dbStubThrows = false;
let dbStubMethodPresent = true;

const dbStub = {
  pool: { query: async () => ({ rows: [] }) },
  db: {
    getUserById: async () => null,
    getRecentRevenueStats: async () => ({ days: 30, totalPaid: 0, invoiceCount: 0, clientCount: 0, unpaidCount: 0 }),
    getOldestStaleDraft: async () => null
  }
};

function installDbStub() {
  if (dbStubMethodPresent) {
    dbStub.db.getMostRecentlyViewedUnpaid = async () => {
      if (dbStubThrows) throw new Error('boom');
      return dbStubInvoice;
    };
  } else {
    delete dbStub.db.getMostRecentlyViewedUnpaid;
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

test('loadMostRecentlyViewedUnpaid: returns the db row on happy path', async () => {
  dbStubInvoice = { id: 88, invoice_number: 'X', client_name: 'A', total: 100, last_viewed_at: new Date().toISOString(), view_count: 2, status: 'sent' };
  dbStubThrows = false;
  dbStubMethodPresent = true;
  const routes = installDbStub();
  const result = await routes.loadMostRecentlyViewedUnpaid(1);
  assert.strictEqual(result.id, 88);
});

test('loadMostRecentlyViewedUnpaid: returns null when no userId (no DB call)', async () => {
  dbStubMethodPresent = true;
  const routes = installDbStub();
  const result = await routes.loadMostRecentlyViewedUnpaid(null);
  assert.strictEqual(result, null);
});

test('loadMostRecentlyViewedUnpaid: soft-fails to null on DB throw', async () => {
  dbStubInvoice = null;
  dbStubThrows = true;
  dbStubMethodPresent = true;
  const routes = installDbStub();
  const origErr = console.error;
  console.error = () => {};
  try {
    const result = await routes.loadMostRecentlyViewedUnpaid(1);
    assert.strictEqual(result, null,
      'dashboard render must never be blocked by a recent-view lookup failure');
  } finally {
    console.error = origErr;
    dbStubThrows = false;
  }
});

test('loadMostRecentlyViewedUnpaid: returns null when db method missing (legacy stub)', async () => {
  dbStubMethodPresent = false;
  const routes = installDbStub();
  const result = await routes.loadMostRecentlyViewedUnpaid(1);
  assert.strictEqual(result, null);
  dbStubMethodPresent = true;
});

// ---- Layer 3: buildRecentViewPrompt shape contract ----------------------

test('buildRecentViewPrompt: returns null when user missing', () => {
  const routes = installDbStub();
  assert.strictEqual(
    routes.buildRecentViewPrompt(null, { id: 1, last_viewed_at: new Date() }),
    null
  );
});

test('buildRecentViewPrompt: returns null when invoice missing', () => {
  const routes = installDbStub();
  assert.strictEqual(routes.buildRecentViewPrompt({ id: 1 }, null), null);
});

test('buildRecentViewPrompt: returns null when invoice has no id', () => {
  const routes = installDbStub();
  assert.strictEqual(
    routes.buildRecentViewPrompt({ id: 1 }, { invoice_number: 'X', last_viewed_at: new Date() }),
    null
  );
});

test('buildRecentViewPrompt: returns null when last_viewed_at missing', () => {
  const routes = installDbStub();
  assert.strictEqual(
    routes.buildRecentViewPrompt({ id: 1 }, { id: 17, last_viewed_at: null }),
    null
  );
});

test('buildRecentViewPrompt: returns null when last_viewed_at is unparseable', () => {
  const routes = installDbStub();
  assert.strictEqual(
    routes.buildRecentViewPrompt({ id: 1 }, { id: 17, last_viewed_at: 'not-a-date' }),
    null
  );
});

test('buildRecentViewPrompt: defence-in-depth — returns null when last_viewed_at is older than 60min', () => {
  const routes = installDbStub();
  const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
  assert.strictEqual(
    routes.buildRecentViewPrompt({ id: 1 }, { id: 17, last_viewed_at: twoHoursAgo }),
    null,
    'stale row (clock skew, replication lag) must not paint as live'
  );
});

test('buildRecentViewPrompt: happy-path shape (id, invoiceNumber, clientName, total, minutesAgo, viewCount, status, followUpIntents)', () => {
  const routes = installDbStub();
  const tenMinutesAgo = new Date(Date.now() - 10 * 60000);
  const out = routes.buildRecentViewPrompt(
    { id: 1 },
    { id: 88, invoice_number: 'INV-2026-0099', client_name: 'Acme Co.', total: '2500.00',
      last_viewed_at: tenMinutesAgo, view_count: 3, status: 'sent' }
  );
  assert.strictEqual(out.id, 88);
  assert.strictEqual(out.invoiceNumber, 'INV-2026-0099');
  assert.strictEqual(out.clientName, 'Acme Co.');
  assert.strictEqual(out.total, 2500);
  assert.strictEqual(out.minutesAgo, 10);
  assert.strictEqual(out.viewCount, 3);
  assert.strictEqual(out.status, 'sent');
  assert.strictEqual(out.followUpIntents, null, 'no public_token → no share intents');
});

test('buildRecentViewPrompt: minutesAgo is 0 for sub-60s windows', () => {
  const routes = installDbStub();
  const justNow = new Date(Date.now() - 30 * 1000);
  const out = routes.buildRecentViewPrompt(
    { id: 1 },
    { id: 1, last_viewed_at: justNow }
  );
  assert.strictEqual(out.minutesAgo, 0, 'view layer renders "just now"');
});

test('buildRecentViewPrompt: viewCount defaults to 1 when missing/zero/garbage', () => {
  const routes = installDbStub();
  const fiveMin = new Date(Date.now() - 5 * 60000);
  const out1 = routes.buildRecentViewPrompt({ id: 1 }, { id: 1, last_viewed_at: fiveMin });
  assert.strictEqual(out1.viewCount, 1, 'missing view_count → 1');
  const out2 = routes.buildRecentViewPrompt({ id: 1 }, { id: 1, last_viewed_at: fiveMin, view_count: 0 });
  assert.strictEqual(out2.viewCount, 1, 'zero view_count → 1');
  const out3 = routes.buildRecentViewPrompt({ id: 1 }, { id: 1, last_viewed_at: fiveMin, view_count: 'garbage' });
  assert.strictEqual(out3.viewCount, 1, 'non-numeric view_count → 1');
});

test('buildRecentViewPrompt: stringy total parses to Number', () => {
  const routes = installDbStub();
  const fiveMin = new Date(Date.now() - 5 * 60000);
  const out = routes.buildRecentViewPrompt(
    { id: 1 },
    { id: 1, last_viewed_at: fiveMin, total: '799.99' }
  );
  assert.strictEqual(out.total, 799.99);
});

test('buildRecentViewPrompt: empty client_name passes through as empty string', () => {
  const routes = installDbStub();
  const fiveMin = new Date(Date.now() - 5 * 60000);
  const out = routes.buildRecentViewPrompt(
    { id: 1 },
    { id: 1, last_viewed_at: fiveMin, client_name: '' }
  );
  assert.strictEqual(out.clientName, '', 'view layer handles the empty-name fallback copy');
});

test('buildRecentViewPrompt: SUPPRESSED when paymentClaimPrompt targets the same invoice id', () => {
  const routes = installDbStub();
  const fiveMin = new Date(Date.now() - 5 * 60000);
  const out = routes.buildRecentViewPrompt(
    { id: 1 },
    { id: 88, last_viewed_at: fiveMin },
    { paymentClaimPrompt: { id: 88 } }
  );
  assert.strictEqual(out, null, 'payment-claim is a stronger signal — let it own the surface');
});

test('buildRecentViewPrompt: paymentClaimPrompt on a DIFFERENT invoice does not suppress', () => {
  const routes = installDbStub();
  const fiveMin = new Date(Date.now() - 5 * 60000);
  const out = routes.buildRecentViewPrompt(
    { id: 1 },
    { id: 88, last_viewed_at: fiveMin },
    { paymentClaimPrompt: { id: 99 } }
  );
  assert.ok(out && out.id === 88, 'unrelated payment-claim on a different invoice has no effect');
});

test('buildRecentViewPrompt: derives follow-up share intents when public_token is present', () => {
  const routes = installDbStub();
  const fiveMin = new Date(Date.now() - 5 * 60000);
  const out = routes.buildRecentViewPrompt(
    { id: 1 },
    {
      id: 88,
      invoice_number: 'INV-7',
      client_name: 'Acme',
      total: '500.00',
      last_viewed_at: fiveMin,
      public_token: 'a1b2c3d4e5f6a7b8'
    }
  );
  assert.ok(out.followUpIntents, 'share intents derived from public_token');
  assert.ok(out.followUpIntents.url, 'url present');
  assert.match(out.followUpIntents.whatsapp, /^https:\/\/wa\.me\//);
  assert.match(out.followUpIntents.sms, /^sms:/);
  assert.match(out.followUpIntents.body, /Acme/, 'body greets the client');
  assert.match(out.followUpIntents.body, /checking in/i, 'follow-up framing (not first-send)');
});

test('buildRecentViewPrompt: malformed public_token yields null followUpIntents (no clickable garbage)', () => {
  const routes = installDbStub();
  const fiveMin = new Date(Date.now() - 5 * 60000);
  const out = routes.buildRecentViewPrompt(
    { id: 1 },
    {
      id: 88, last_viewed_at: fiveMin,
      public_token: 'not-hex-junk'
    }
  );
  assert.strictEqual(out.followUpIntents, null);
});

// ---- Layer 4: clientViewedFollowupPrompt suppression contract ----------

test('clientViewedFollowupPrompt: SUPPRESSED when recentViewPrompt targets the same invoice id', () => {
  const routes = installDbStub();
  const threeDaysAgo = new Date(Date.now() - 3 * 86400000);
  const out = routes.buildClientViewedFollowupPrompt(
    { id: 1 },
    { id: 88, first_viewed_at: threeDaysAgo, view_count: 5 },
    { recentViewPrompt: { id: 88 } }
  );
  assert.strictEqual(out, null,
    'live recent-view banner owns the same-invoice surface — no double-render');
});

test('clientViewedFollowupPrompt: recentViewPrompt on DIFFERENT invoice does NOT suppress', () => {
  const routes = installDbStub();
  const threeDaysAgo = new Date(Date.now() - 3 * 86400000);
  const out = routes.buildClientViewedFollowupPrompt(
    { id: 1 },
    { id: 88, first_viewed_at: threeDaysAgo, view_count: 2 },
    { recentViewPrompt: { id: 7 } }
  );
  assert.ok(out && out.id === 88,
    'unrelated recent-view on a different invoice does not suppress the 48h follow-up');
});

// ---- Layer 5: dashboard.ejs renders the banner -------------------------

const dashboardTplPath = path.join(__dirname, '..', 'views', 'dashboard.ejs');
const dashboardTpl = fs.readFileSync(dashboardTplPath, 'utf8');

function renderDashboard(locals) {
  return ejs.render(dashboardTpl, {
    title: 'Dashboard',
    flash: null,
    days_left_in_trial: 0,
    csrfToken: 'TEST_CSRF',
    invoices: [
      { id: 1, invoice_number: 'INV-2026-0001', client_name: 'Acme', issued_date: '2026-04-01', total: 500, status: 'sent', is_seed: false, first_viewed_at: new Date().toISOString() }
    ],
    user: { plan: 'pro', invoice_count: 1, subscription_status: null },
    onboarding: null,
    invoiceLimitProgress: null,
    recentRevenue: null,
    annualUpgradePrompt: null,
    socialProof: null,
    celebration: null,
    staleDraftPrompt: null,
    paymentClaimPrompt: null,
    recentViewPrompt: null,
    clientViewedFollowupPrompt: null,
    sentNotViewedPrompt: null,
    overduePrompt: null,
    firstRealInvoicePrompt: null,
    freshDraftPrompt: null,
    repeatClientPrompt: null,
    pendingQuickInvoice: null,
    ...locals
  }, {
    views: [path.join(__dirname, '..', 'views')],
    filename: dashboardTplPath
  });
}

test('view: banner is OMITTED when recentViewPrompt is null', () => {
  const html = renderDashboard({ recentViewPrompt: null });
  assert.doesNotMatch(html, /data-testid="recent-view-prompt"/);
});

test('view: banner RENDERS when prompt is set', () => {
  const html = renderDashboard({
    recentViewPrompt: {
      id: 88, invoiceNumber: 'INV-2026-0099', clientName: 'Acme Co.',
      total: 2500, minutesAgo: 5, viewCount: 4, status: 'sent', followUpIntents: null
    }
  });
  assert.match(html, /data-testid="recent-view-prompt"/);
});

test('view: banner shows client name, invoice number, total, minutesAgo, viewCount', () => {
  const html = renderDashboard({
    recentViewPrompt: {
      id: 88, invoiceNumber: 'INV-2026-0099', clientName: 'Acme Co.',
      total: 2500, minutesAgo: 5, viewCount: 4, status: 'sent', followUpIntents: null
    }
  });
  assert.match(html, /Acme Co\./, 'client name visible');
  assert.match(html, /INV-2026-0099/, 'invoice number visible');
  assert.match(html, /\$<span[^>]*>2500\.00<\/span>/, 'total formatted to 2 decimals');
  assert.match(html, /<span[^>]*data-testid="recent-view-minutes-ago"[^>]*>5m ago<\/span>/, 'minutesAgo surface visible');
  assert.match(html, /opened\s*<span[^>]*>4<\/span>\s*times/, 'view-count line surfaces when >1');
});

test('view: minutesAgo <=1 collapses to "just now"', () => {
  const html = renderDashboard({
    recentViewPrompt: {
      id: 88, invoiceNumber: 'X', clientName: 'A', total: 100,
      minutesAgo: 0, viewCount: 1, status: 'sent', followUpIntents: null
    }
  });
  assert.match(html, /<span[^>]*data-testid="recent-view-minutes-ago"[^>]*>just now<\/span>/);
});

test('view: viewCount=1 hides the "opened N times total" line (grammar)', () => {
  const html = renderDashboard({
    recentViewPrompt: {
      id: 88, invoiceNumber: 'X', clientName: 'A', total: 100,
      minutesAgo: 5, viewCount: 1, status: 'sent', followUpIntents: null
    }
  });
  assert.doesNotMatch(html, /opened\s*<span[^>]*>1<\/span>\s*times/,
    'never render "opened 1 times" — that line is for repeat opens only');
});

test('view: empty client name falls back to "Your client is looking at your invoice"', () => {
  const html = renderDashboard({
    recentViewPrompt: {
      id: 88, invoiceNumber: 'X', clientName: '', total: 100,
      minutesAgo: 5, viewCount: 1, status: 'sent', followUpIntents: null
    }
  });
  assert.match(html, /Your client is looking at your invoice right now/);
});

test('view: CTA deep-links to /invoices/:id', () => {
  const html = renderDashboard({
    recentViewPrompt: {
      id: 88, invoiceNumber: 'X', clientName: 'A', total: 100,
      minutesAgo: 5, viewCount: 1, status: 'sent', followUpIntents: null
    }
  });
  assert.match(html, /href="\/invoices\/88"[^>]*data-testid="recent-view-open-link"/);
});

test('view: Mark-as-Paid form POSTs to /invoices/:id/status with status=paid + CSRF', () => {
  const html = renderDashboard({
    recentViewPrompt: {
      id: 88, invoiceNumber: 'X', clientName: 'A', total: 100,
      minutesAgo: 5, viewCount: 1, status: 'sent', followUpIntents: null
    }
  });
  const formMatch = html.match(
    /<form\s+action="\/invoices\/88\/status"\s+method="POST"[^>]*>[\s\S]*?data-testid="recent-view-mark-paid"/
  );
  assert.ok(formMatch, 'mark-as-paid form must POST to /invoices/88/status');
  assert.match(formMatch[0], /name="_csrf"\s+value="TEST_CSRF"/, 'CSRF token wired');
  assert.match(formMatch[0], /name="status"\s+value="paid"/, 'status=paid hidden field');
});

test('view: share-intent buttons OMITTED when followUpIntents is null', () => {
  const html = renderDashboard({
    recentViewPrompt: {
      id: 88, invoiceNumber: 'X', clientName: 'A', total: 100,
      minutesAgo: 5, viewCount: 1, status: 'sent', followUpIntents: null
    }
  });
  assert.doesNotMatch(html, /data-testid="recent-view-share-intents"/);
});

test('view: share-intent buttons RENDER when followUpIntents present', () => {
  const html = renderDashboard({
    recentViewPrompt: {
      id: 88, invoiceNumber: 'X', clientName: 'A', total: 100,
      minutesAgo: 5, viewCount: 1, status: 'sent',
      followUpIntents: {
        url: 'https://example.com/i/abc123',
        whatsapp: 'https://wa.me/?text=Hi+Acme',
        sms: 'sms:?&body=Hi+Acme',
        body: 'Hi Acme, just checking in...',
        subject: 'Quick check-in: Invoice X'
      }
    }
  });
  assert.match(html, /data-testid="recent-view-share-intents"/);
  assert.match(html, /data-testid="recent-view-share-whatsapp"/);
  assert.match(html, /data-testid="recent-view-share-sms"/);
  assert.match(html, /data-testid="recent-view-share-copy"/);
  assert.match(html, /href="https:\/\/wa\.me\/\?text=Hi\+Acme"/, 'whatsapp href verbatim');
  assert.match(html, /href="sms:\?&amp;body=Hi\+Acme"/, 'sms href escaped');
});

test('view: each share button fires POST /share-intent with correct intent kind + CSRF', () => {
  const html = renderDashboard({
    recentViewPrompt: {
      id: 88, invoiceNumber: 'X', clientName: 'A', total: 100,
      minutesAgo: 5, viewCount: 1, status: 'sent',
      followUpIntents: {
        url: 'https://example.com/i/abc123',
        whatsapp: 'https://wa.me/?text=x',
        sms: 'sms:?&body=x'
      }
    }
  });
  const waMatch = html.match(/data-testid="recent-view-share-whatsapp"[^>]*onclick="([^"]+)"/);
  assert.ok(waMatch, 'whatsapp onclick wired');
  assert.match(waMatch[1], /\/invoices\/88\/share-intent/, 'whatsapp POSTs to /share-intent');
  assert.match(waMatch[1], /intent:\s*'whatsapp'/, 'whatsapp intent kind');
  assert.match(waMatch[1], /TEST_CSRF/, 'CSRF token threaded');
  const smsMatch = html.match(/data-testid="recent-view-share-sms"[^>]*onclick="([^"]+)"/);
  assert.match(smsMatch[1], /intent:\s*'sms'/, 'sms intent kind');
  const copyMatch = html.match(/data-testid="recent-view-share-copy"[^>]*onclick="([^"]+)"/);
  assert.match(copyMatch[1], /intent:\s*'copy'/, 'copy intent kind');
  assert.match(copyMatch[1], /navigator\.clipboard/, 'copy writes to clipboard');
});

test('view: hostile client_name is HTML-escaped (XSS guard)', () => {
  const html = renderDashboard({
    recentViewPrompt: {
      id: 1, invoiceNumber: 'INV-X', clientName: '<script>alert(1)</script>',
      total: 100, minutesAgo: 5, viewCount: 1, status: 'sent', followUpIntents: null
    }
  });
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/,
    'raw script must NOT appear — EJS <%= must escape');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/,
    'escaped form must appear instead');
});

test('view: hostile share-url is HTML-attribute-escaped', () => {
  const html = renderDashboard({
    recentViewPrompt: {
      id: 1, invoiceNumber: 'X', clientName: 'A', total: 100,
      minutesAgo: 5, viewCount: 1, status: 'sent',
      followUpIntents: {
        url: 'https://x/" onerror=alert(1) x="',
        whatsapp: 'https://wa.me/?text=x',
        sms: 'sms:?&body=x'
      }
    }
  });
  // data-share-url attribute should encode quotes
  assert.doesNotMatch(html, /data-share-url="https:\/\/x\/" onerror=alert\(1\)/,
    'hostile attribute breakout must be neutralised');
});

test('view: banner sits ABOVE the clientViewedFollowupPrompt (positional contract — live wins)', () => {
  const html = renderDashboard({
    recentViewPrompt: {
      id: 88, invoiceNumber: 'X', clientName: 'A', total: 100,
      minutesAgo: 5, viewCount: 1, status: 'sent', followUpIntents: null
    },
    clientViewedFollowupPrompt: {
      id: 99, invoiceNumber: 'Y', clientName: 'B', total: 200,
      daysAgo: 3, hoursAgo: 72, viewCount: 1, status: 'sent'
    }
  });
  const recentIdx = html.indexOf('data-testid="recent-view-prompt"');
  const followupIdx = html.indexOf('data-testid="client-viewed-followup-prompt"');
  assert.ok(recentIdx !== -1 && followupIdx !== -1, 'both banners present');
  assert.ok(recentIdx < followupIdx,
    'recent-view banner must render BEFORE the 48h follow-up — live signal wins visual priority');
});

test('view: banner sits BELOW the paymentClaimPrompt (positional contract — paid-claim wins)', () => {
  const html = renderDashboard({
    paymentClaimPrompt: {
      id: 7, invoiceNumber: 'Z', clientName: 'C', total: 300,
      hoursAgo: 1, daysAgo: 0, method: 'venmo', methodLabel: 'Venmo',
      reference: null, note: null, status: 'sent'
    },
    recentViewPrompt: {
      id: 88, invoiceNumber: 'X', clientName: 'A', total: 100,
      minutesAgo: 5, viewCount: 1, status: 'sent', followUpIntents: null
    }
  });
  const claimIdx = html.indexOf('data-testid="payment-claim-prompt"');
  const recentIdx = html.indexOf('data-testid="recent-view-prompt"');
  assert.ok(claimIdx !== -1 && recentIdx !== -1, 'both banners present');
  assert.ok(claimIdx < recentIdx,
    'paymentClaim must render BEFORE recent-view — client says-they-paid is even higher intent');
});

test('view: data attributes expose invoice-id, minutes-ago, view-count for hooks', () => {
  const html = renderDashboard({
    recentViewPrompt: {
      id: 88, invoiceNumber: 'X', clientName: 'A', total: 100,
      minutesAgo: 12, viewCount: 4, status: 'sent', followUpIntents: null
    }
  });
  assert.match(html, /data-invoice-id="88"/);
  assert.match(html, /data-minutes-ago="12"/);
  assert.match(html, /data-view-count="4"/);
});

test('view: banner print:hidden (printed invoice artifact stays clean)', () => {
  const html = renderDashboard({
    recentViewPrompt: {
      id: 88, invoiceNumber: 'X', clientName: 'A', total: 100,
      minutesAgo: 5, viewCount: 1, status: 'sent', followUpIntents: null
    }
  });
  const blockMatch = html.match(
    /data-testid="recent-view-prompt"[\s\S]{0,500}/
  );
  assert.ok(blockMatch, 'banner block located');
  assert.match(blockMatch[0], /print:hidden/);
});

test('view: live dot indicator renders when client name is present', () => {
  const html = renderDashboard({
    recentViewPrompt: {
      id: 88, invoiceNumber: 'X', clientName: 'Acme', total: 100,
      minutesAgo: 5, viewCount: 1, status: 'sent', followUpIntents: null
    }
  });
  assert.match(html, /data-testid="recent-view-live-dot"/,
    'pulsing live-dot visual indicator surfaces the "right now" signal');
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
  console.log(`\n${passed} passed, ${failed} failed (recent-view-prompt.test.js)`);
  if (failed > 0) process.exit(1);
})();
