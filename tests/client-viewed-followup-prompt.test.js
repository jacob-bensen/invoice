'use strict';

/*
 * Client-viewed follow-up prompt — dashboard banner that fires when the
 * user has a sent/overdue invoice whose client opened the public link
 * 48+ hours ago. The in-app analog of jobs/client-viewed-followup.js
 * (the 48h email cron): closes the gap between cron firings and gives
 * the freelancer an in-app nudge action at exactly the highest-converting
 * moment.
 *
 * Layers:
 *  1. db.getOldestClientViewedUnpaid SQL contract — status filter,
 *     is_seed=false, first_viewed_at IS NOT NULL + age predicate,
 *     ORDER ASC, LIMIT 1, params, default minAgeHours=48.
 *  2. routes/invoices.loadOldestClientViewedUnpaid — soft-fails on
 *     DB throw, on missing method, on null userId.
 *  3. routes/invoices.buildClientViewedFollowupPrompt — null user /
 *     missing invoice / missing first_viewed_at paths; happy-path shape;
 *     daysAgo computation; viewCount coercion.
 *  4. views/dashboard.ejs — banner renders when prompt set, omits
 *     otherwise; copy carries client + invoice + total + daysAgo +
 *     viewCount; CTA deep-links; mark-as-paid form POSTs status=paid
 *     with CSRF; hostile client_name escaped.
 *
 * Run: node tests/client-viewed-followup-prompt.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ---- Layer 1: db.getOldestClientViewedUnpaid SQL contract ---------------

function loadRealDb() {
  delete require.cache[require.resolve('../db')];
  return require('../db');
}

test('db.getOldestClientViewedUnpaid: SQL filters on status IN (\'sent\',\'overdue\') AND is_seed=false', async () => {
  let captured = null;
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };
  };
  try {
    await real.db.getOldestClientViewedUnpaid(42);
    assert.ok(captured, 'query was issued');
    assert.match(captured.sql, /status\s+IN\s*\(\s*'sent'\s*,\s*'overdue'\s*\)/i,
      'must filter on sent OR overdue (draft + paid excluded)');
    assert.match(captured.sql, /is_seed\s*=\s*false/i,
      'must exclude seed sample (is_seed=true) — banner is for real invoices only');
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.getOldestClientViewedUnpaid: SQL requires first_viewed_at IS NOT NULL + age predicate', async () => {
  let captured = null;
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };
  };
  try {
    await real.db.getOldestClientViewedUnpaid(42, 48);
    assert.match(captured.sql, /first_viewed_at\s+IS\s+NOT\s+NULL/i,
      'must require first_viewed_at IS NOT NULL — the client demonstrably opened the link');
    assert.match(captured.sql, /first_viewed_at\s*<=\s*NOW\(\)\s*-\s*\(\$\d+\s*\*\s*INTERVAL\s*'1\s*hour'\)/i,
      'must compare first_viewed_at to NOW() - ($n * INTERVAL \'1 hour\')');
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.getOldestClientViewedUnpaid: SQL orders by first_viewed_at ASC LIMIT 1 (oldest viewed)', async () => {
  let captured = null;
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };
  };
  try {
    await real.db.getOldestClientViewedUnpaid(42);
    assert.match(captured.sql, /ORDER\s+BY\s+first_viewed_at\s+ASC/i,
      'oldest-viewed first — peak conversion-likelihood ordering');
    assert.match(captured.sql, /LIMIT\s+1/i, 'one prompt at a time');
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.getOldestClientViewedUnpaid: params are [userId, hours]; default hours=48', async () => {
  let captured = null;
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };
  };
  try {
    await real.db.getOldestClientViewedUnpaid(99);
    assert.strictEqual(captured.params[0], 99, 'userId is first param');
    assert.strictEqual(captured.params[1], 48, 'hours defaults to 48 — matches client-viewed-followup email cron window');
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.getOldestClientViewedUnpaid: explicit fractional hours floored to int', async () => {
  let captured = null;
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };
  };
  try {
    await real.db.getOldestClientViewedUnpaid(7, 72.9);
    assert.strictEqual(captured.params[1], 72);
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.getOldestClientViewedUnpaid: returns null and skips DB on falsy userId', async () => {
  let queried = false;
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async () => { queried = true; return { rows: [] }; };
  try {
    const out = await real.db.getOldestClientViewedUnpaid(null);
    assert.strictEqual(out, null);
    assert.strictEqual(queried, false, 'no DB round-trip on falsy userId');
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.getOldestClientViewedUnpaid: returns null when no rows match', async () => {
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async () => ({ rows: [] });
  try {
    const out = await real.db.getOldestClientViewedUnpaid(42);
    assert.strictEqual(out, null);
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.getOldestClientViewedUnpaid: returns first row with id/number/client/total/first_viewed_at/view_count/status', async () => {
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async () => ({
    rows: [{
      id: 88,
      invoice_number: 'INV-2026-0099',
      client_name: 'Big Client Co.',
      total: '2500.00',
      first_viewed_at: '2026-05-15T12:00:00Z',
      view_count: 3,
      status: 'sent'
    }]
  });
  try {
    const out = await real.db.getOldestClientViewedUnpaid(42);
    assert.strictEqual(out.id, 88);
    assert.strictEqual(out.invoice_number, 'INV-2026-0099');
    assert.strictEqual(out.client_name, 'Big Client Co.');
    assert.strictEqual(out.view_count, 3);
    assert.strictEqual(out.status, 'sent');
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.getOldestClientViewedUnpaid: SELECT projection includes first_viewed_at and view_count', async () => {
  let captured = null;
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };
  };
  try {
    await real.db.getOldestClientViewedUnpaid(42);
    assert.match(captured.sql, /first_viewed_at/, 'must project first_viewed_at for the daysAgo calc');
    assert.match(captured.sql, /view_count/, 'must project view_count for the "opened N times" line');
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.getOldestClientViewedUnpaid: SELECT projects public_token, client_email, due_date (share-intent inputs)', async () => {
  // The inline WhatsApp/SMS/Email/Copy share-intent row on the dashboard
  // banner is built from buildShareSurfaceForInvoice(row), which needs
  // public_token (url), client_email (mailto recipient), and due_date
  // (overdue framing in the follow-up body). Pre-share-intents this query
  // didn't project them; locking in the projection guards against a future
  // maintenance edit silently dropping the surface.
  let captured = null;
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };
  };
  try {
    await real.db.getOldestClientViewedUnpaid(42);
    assert.match(captured.sql, /public_token/, 'must project public_token for the share URL');
    assert.match(captured.sql, /client_email/, 'must project client_email for the mailto: deep-link');
    assert.match(captured.sql, /due_date/, 'must project due_date for the "(now overdue)" follow-up framing');
  } finally {
    real.pool.query = originalQuery;
  }
});

// ---- Layer 2: loadOldestClientViewedUnpaid soft-fail paths --------------

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

let dbStubInvoice = null;
let dbStubThrows = false;
let dbStubMethodPresent = true;
let dbStubMintCalls = [];
let dbStubMintReturn = null;
let dbStubMintThrows = false;

const dbStub = {
  pool: { query: async () => ({ rows: [] }) },
  db: {
    getUserById: async () => null,
    getRecentRevenueStats: async () => ({ days: 30, totalPaid: 0, invoiceCount: 0, clientCount: 0, unpaidCount: 0 }),
    getOldestStaleDraft: async () => null,
    getOrCreatePublicToken: async (invoiceId, userId) => {
      dbStubMintCalls.push({ invoiceId, userId });
      if (dbStubMintThrows) throw new Error('mint boom');
      return dbStubMintReturn;
    }
  }
};

function installDbStub() {
  dbStubMintCalls = [];
  if (dbStubMethodPresent) {
    dbStub.db.getOldestClientViewedUnpaid = async () => {
      if (dbStubThrows) throw new Error('boom');
      return dbStubInvoice;
    };
  } else {
    delete dbStub.db.getOldestClientViewedUnpaid;
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

test('loadOldestClientViewedUnpaid: returns the db row on happy path', async () => {
  dbStubInvoice = { id: 88, invoice_number: 'X', client_name: 'A', total: 100, first_viewed_at: new Date().toISOString(), view_count: 2, status: 'sent' };
  dbStubThrows = false;
  dbStubMethodPresent = true;
  const routes = installDbStub();
  const result = await routes.loadOldestClientViewedUnpaid(1);
  assert.strictEqual(result.id, 88);
});

test('loadOldestClientViewedUnpaid: returns null when no userId (no DB call)', async () => {
  dbStubMethodPresent = true;
  const routes = installDbStub();
  const result = await routes.loadOldestClientViewedUnpaid(null);
  assert.strictEqual(result, null);
});

test('loadOldestClientViewedUnpaid: soft-fails to null on DB throw', async () => {
  dbStubInvoice = null;
  dbStubThrows = true;
  dbStubMethodPresent = true;
  const routes = installDbStub();
  const origErr = console.error;
  console.error = () => {};
  try {
    const result = await routes.loadOldestClientViewedUnpaid(1);
    assert.strictEqual(result, null,
      'dashboard render must never be blocked by a client-viewed lookup failure');
  } finally {
    console.error = origErr;
    dbStubThrows = false;
  }
});

test('loadOldestClientViewedUnpaid: returns null when db method missing (legacy stub)', async () => {
  dbStubMethodPresent = false;
  const routes = installDbStub();
  const result = await routes.loadOldestClientViewedUnpaid(1);
  assert.strictEqual(result, null);
  dbStubMethodPresent = true;
});

test('loadOldestClientViewedUnpaid: lazy-mints public_token when the row lands without one', async () => {
  // Defence-in-depth — sent/overdue invoices are almost always eager-minted
  // at send time, but a legacy row or a token-mint failure on the send path
  // would otherwise strand the inline share-intent surface. One mint round-
  // trip closes the gap so cohort coverage is 100%.
  dbStubInvoice = { id: 17, invoice_number: 'INV-2026-0042', client_name: 'A', total: 50,
    first_viewed_at: new Date(Date.now() - 3 * 86400000).toISOString(), view_count: 2,
    status: 'sent', public_token: null };
  dbStubThrows = false;
  dbStubMethodPresent = true;
  dbStubMintReturn = 'a1b2c3d4e5f60718';
  dbStubMintThrows = false;
  const routes = installDbStub();
  const result = await routes.loadOldestClientViewedUnpaid(99);
  assert.ok(result, 'row returned');
  assert.strictEqual(result.public_token, 'a1b2c3d4e5f60718', 'minted token landed on row');
  assert.strictEqual(dbStubMintCalls.length, 1, 'mint called exactly once');
  assert.deepStrictEqual(dbStubMintCalls[0], { invoiceId: 17, userId: 99 },
    'mint called with row id + caller userId');
});

test('loadOldestClientViewedUnpaid: skips lazy-mint when row already has a public_token', async () => {
  // Fast path — the dominant cohort already has an eager-minted token from
  // the send-time path. No extra round-trip on the hot path.
  dbStubInvoice = { id: 1, invoice_number: 'X', client_name: 'A', total: 1,
    first_viewed_at: new Date(Date.now() - 3 * 86400000).toISOString(), view_count: 1,
    status: 'sent', public_token: 'deadbeef12345678' };
  dbStubMintReturn = 'should-not-be-used';
  const routes = installDbStub();
  const result = await routes.loadOldestClientViewedUnpaid(1);
  assert.strictEqual(result.public_token, 'deadbeef12345678', 'pre-existing token preserved');
  assert.strictEqual(dbStubMintCalls.length, 0, 'mint NOT called when token already present');
});

test('loadOldestClientViewedUnpaid: soft-fails to keep the row when mint throws (banner still renders)', async () => {
  // A mint hiccup MUST NOT block the banner. The user still gets
  // Mark-as-paid / Open-invoice as the fallback path; only the inline
  // share-intent row degrades cleanly.
  dbStubInvoice = { id: 7, invoice_number: 'X', client_name: 'A', total: 1,
    first_viewed_at: new Date(Date.now() - 3 * 86400000).toISOString(), view_count: 1,
    status: 'sent', public_token: null };
  dbStubMintReturn = null;
  dbStubMintThrows = true;
  const routes = installDbStub();
  const origErr = console.error;
  console.error = () => {};
  try {
    const result = await routes.loadOldestClientViewedUnpaid(1);
    assert.ok(result, 'row still returned despite mint throw');
    assert.strictEqual(result.id, 7);
    assert.ok(!result.public_token, 'token remains absent after a mint throw');
  } finally {
    console.error = origErr;
    dbStubMintThrows = false;
  }
});

// ---- Layer 3: buildClientViewedFollowupPrompt shape contract -----------

test('buildClientViewedFollowupPrompt: returns null when user missing', () => {
  const routes = installDbStub();
  assert.strictEqual(
    routes.buildClientViewedFollowupPrompt(null, { id: 1, first_viewed_at: new Date() }),
    null
  );
});

test('buildClientViewedFollowupPrompt: returns null when invoice missing', () => {
  const routes = installDbStub();
  assert.strictEqual(routes.buildClientViewedFollowupPrompt({ id: 1 }, null), null);
});

test('buildClientViewedFollowupPrompt: returns null when invoice has no id', () => {
  const routes = installDbStub();
  assert.strictEqual(
    routes.buildClientViewedFollowupPrompt({ id: 1 }, { invoice_number: 'X', first_viewed_at: new Date() }),
    null
  );
});

test('buildClientViewedFollowupPrompt: returns null when first_viewed_at missing (defence-in-depth)', () => {
  const routes = installDbStub();
  assert.strictEqual(
    routes.buildClientViewedFollowupPrompt({ id: 1 }, { id: 17, first_viewed_at: null }),
    null
  );
});

test('buildClientViewedFollowupPrompt: returns null when first_viewed_at is unparseable', () => {
  const routes = installDbStub();
  assert.strictEqual(
    routes.buildClientViewedFollowupPrompt({ id: 1 }, { id: 17, first_viewed_at: 'not-a-date' }),
    null
  );
});

test('buildClientViewedFollowupPrompt: happy-path shape (id, invoiceNumber, clientName, total, daysAgo, viewCount, status)', () => {
  const routes = installDbStub();
  const threeDaysAgo = new Date(Date.now() - 3 * 86400000);
  const out = routes.buildClientViewedFollowupPrompt(
    { id: 1 },
    { id: 88, invoice_number: 'INV-2026-0099', client_name: 'Acme Co.', total: '2500.00',
      first_viewed_at: threeDaysAgo, view_count: 4, status: 'sent' }
  );
  assert.strictEqual(out.id, 88);
  assert.strictEqual(out.invoiceNumber, 'INV-2026-0099');
  assert.strictEqual(out.clientName, 'Acme Co.');
  assert.strictEqual(out.total, 2500);
  assert.strictEqual(out.daysAgo, 3);
  assert.strictEqual(out.viewCount, 4);
  assert.strictEqual(out.status, 'sent');
});

test('buildClientViewedFollowupPrompt: daysAgo floor is 1 (never "0 days ago")', () => {
  const routes = installDbStub();
  const halfHourAgo = new Date(Date.now() - 1800 * 1000);
  const out = routes.buildClientViewedFollowupPrompt(
    { id: 1 },
    { id: 1, first_viewed_at: halfHourAgo }
  );
  assert.strictEqual(out.daysAgo, 1, 'sub-day windows clamp to 1 — copy stays grammatical');
});

test('buildClientViewedFollowupPrompt: viewCount defaults to 1 when missing/zero/garbage', () => {
  const routes = installDbStub();
  const threeDaysAgo = new Date(Date.now() - 3 * 86400000);
  const out1 = routes.buildClientViewedFollowupPrompt({ id: 1 }, { id: 1, first_viewed_at: threeDaysAgo });
  assert.strictEqual(out1.viewCount, 1, 'missing view_count → 1');
  const out2 = routes.buildClientViewedFollowupPrompt({ id: 1 }, { id: 1, first_viewed_at: threeDaysAgo, view_count: 0 });
  assert.strictEqual(out2.viewCount, 1, 'zero view_count → 1');
  const out3 = routes.buildClientViewedFollowupPrompt({ id: 1 }, { id: 1, first_viewed_at: threeDaysAgo, view_count: 'garbage' });
  assert.strictEqual(out3.viewCount, 1, 'non-numeric view_count → 1');
});

test('buildClientViewedFollowupPrompt: stringy total parses to Number', () => {
  const routes = installDbStub();
  const threeDaysAgo = new Date(Date.now() - 3 * 86400000);
  const out = routes.buildClientViewedFollowupPrompt(
    { id: 1 },
    { id: 1, first_viewed_at: threeDaysAgo, total: '799.99' }
  );
  assert.strictEqual(out.total, 799.99);
});

test('buildClientViewedFollowupPrompt: empty client_name passes through as empty string', () => {
  const routes = installDbStub();
  const threeDaysAgo = new Date(Date.now() - 3 * 86400000);
  const out = routes.buildClientViewedFollowupPrompt(
    { id: 1 },
    { id: 1, first_viewed_at: threeDaysAgo, client_name: '' }
  );
  assert.strictEqual(out.clientName, '', 'view layer handles the empty-name fallback copy');
});

test('buildClientViewedFollowupPrompt: followUpIntents is null when no public_token', () => {
  // Cohort-degrade path — without a token the inline share-intent row hides
  // and the view falls back cleanly to the deep-link CTA.
  const routes = installDbStub();
  const threeDaysAgo = new Date(Date.now() - 3 * 86400000);
  const out = routes.buildClientViewedFollowupPrompt(
    { id: 1 },
    { id: 88, first_viewed_at: threeDaysAgo, client_name: 'Acme', total: '500.00' }
  );
  assert.strictEqual(out.followUpIntents, null);
});

test('buildClientViewedFollowupPrompt: derives followUpIntents when public_token present', () => {
  // The cohort that already has an eager-minted token (status='sent'/'overdue'
  // dominant path). Body must read as a polite check-in, NOT a first-send —
  // the client already opened the invoice; "here's invoice X" would feel
  // tone-deaf at this point. "just checking in" is the established framing.
  const routes = installDbStub();
  const threeDaysAgo = new Date(Date.now() - 3 * 86400000);
  const out = routes.buildClientViewedFollowupPrompt(
    { id: 1 },
    {
      id: 88,
      invoice_number: 'INV-7',
      client_name: 'Acme',
      total: '500.00',
      first_viewed_at: threeDaysAgo,
      public_token: 'a1b2c3d4e5f6a7b8'
    }
  );
  assert.ok(out.followUpIntents, 'followUpIntents derived');
  assert.ok(out.followUpIntents.url, 'url present');
  assert.match(out.followUpIntents.whatsapp, /^https:\/\/wa\.me\//);
  assert.match(out.followUpIntents.sms, /^sms:/);
  assert.match(out.followUpIntents.body, /Acme/, 'body greets the client');
  assert.match(out.followUpIntents.body, /checking in/i,
    'follow-up framing (NOT first-send "here\'s invoice X")');
});

test('buildClientViewedFollowupPrompt: followUpIntents.mailto carries percent-encoded client_email', () => {
  // Email is the dominant follow-up channel for desktop / B2B freelancers
  // chasing payment 48h+ after a viewed invoice. Recipient must be percent-
  // encoded (defence vs `victim@x.com?cc=attacker` mailto-param injection).
  const routes = installDbStub();
  const threeDaysAgo = new Date(Date.now() - 3 * 86400000);
  const out = routes.buildClientViewedFollowupPrompt(
    { id: 1 },
    {
      id: 88,
      invoice_number: 'INV-7',
      client_name: 'Acme',
      client_email: 'ap@acme.example',
      total: '500.00',
      first_viewed_at: threeDaysAgo,
      public_token: 'a1b2c3d4e5f6a7b8'
    }
  );
  assert.ok(out.followUpIntents, 'followUpIntents derived');
  assert.ok(typeof out.followUpIntents.mailto === 'string'
    && out.followUpIntents.mailto.startsWith('mailto:'),
    'mailto: deep-link present');
  assert.ok(out.followUpIntents.mailto.indexOf(encodeURIComponent('ap@acme.example')) !== -1,
    'recipient is the percent-encoded client_email');
  assert.ok(out.followUpIntents.mailto.indexOf('subject=') !== -1, 'subject param present');
  assert.ok(out.followUpIntents.mailto.indexOf('body=') !== -1, 'body param present');
});

test('buildClientViewedFollowupPrompt: malformed public_token yields null followUpIntents', () => {
  // Defence against a non-hex / wrong-length token slipping through —
  // surface must NOT render a clickable garbage URL.
  const routes = installDbStub();
  const threeDaysAgo = new Date(Date.now() - 3 * 86400000);
  const out = routes.buildClientViewedFollowupPrompt(
    { id: 1 },
    { id: 88, first_viewed_at: threeDaysAgo, public_token: 'not-hex-junk' }
  );
  assert.strictEqual(out.followUpIntents, null);
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
    clientViewedFollowupPrompt: null,
    firstRealInvoicePrompt: null,
    pendingQuickInvoice: null,
    ...locals
  }, {
    views: [path.join(__dirname, '..', 'views')],
    filename: dashboardTplPath
  });
}

test('view: banner is OMITTED when clientViewedFollowupPrompt is null', () => {
  const html = renderDashboard({ clientViewedFollowupPrompt: null });
  assert.doesNotMatch(html, /data-testid="client-viewed-followup-prompt"/);
});

test('view: banner RENDERS when prompt is set', () => {
  const html = renderDashboard({
    clientViewedFollowupPrompt: {
      id: 88, invoiceNumber: 'INV-2026-0099', clientName: 'Acme Co.',
      total: 2500, daysAgo: 3, hoursAgo: 72, viewCount: 4, status: 'sent'
    }
  });
  assert.match(html, /data-testid="client-viewed-followup-prompt"/);
});

test('view: banner shows client name, invoice number, total, daysAgo, viewCount', () => {
  const html = renderDashboard({
    clientViewedFollowupPrompt: {
      id: 88, invoiceNumber: 'INV-2026-0099', clientName: 'Acme Co.',
      total: 2500, daysAgo: 3, hoursAgo: 72, viewCount: 4, status: 'sent'
    }
  });
  assert.match(html, /Acme Co\./, 'client name visible');
  assert.match(html, /INV-2026-0099/, 'invoice number visible');
  assert.match(html, /\$<span[^>]*>2500\.00<\/span>/, 'total formatted to 2 decimals');
  assert.match(html, /<span[^>]*data-testid="client-viewed-followup-days-ago"[^>]*>3<\/span>\s*days?\s*ago/, 'daysAgo surface visible');
  assert.match(html, /opened\s*<span[^>]*>4<\/span>\s*times/, 'view-count line surfaces when >1');
});

test('view: viewCount=1 hides the "opened N times" line (grammar)', () => {
  const html = renderDashboard({
    clientViewedFollowupPrompt: {
      id: 88, invoiceNumber: 'X', clientName: 'A', total: 100, daysAgo: 2, hoursAgo: 48, viewCount: 1, status: 'sent'
    }
  });
  assert.doesNotMatch(html, /opened\s*<span[^>]*>1<\/span>\s*times/,
    'never render "opened 1 times" — that line is for repeat opens only');
});

test('view: empty client name falls back to "Your client opened your invoice"', () => {
  const html = renderDashboard({
    clientViewedFollowupPrompt: {
      id: 88, invoiceNumber: 'X', clientName: '', total: 100, daysAgo: 2, hoursAgo: 48, viewCount: 1, status: 'sent'
    }
  });
  assert.match(html, /Your client opened your invoice/);
});

test('view: CTA deep-links to /invoices/:id', () => {
  const html = renderDashboard({
    clientViewedFollowupPrompt: {
      id: 88, invoiceNumber: 'X', clientName: 'A', total: 100, daysAgo: 2, hoursAgo: 48, viewCount: 1, status: 'sent'
    }
  });
  assert.match(html, /href="\/invoices\/88"[^>]*data-testid="client-viewed-followup-cta"/);
});

test('view: Mark-as-Paid form POSTs to /invoices/:id/status with status=paid + CSRF', () => {
  const html = renderDashboard({
    clientViewedFollowupPrompt: {
      id: 88, invoiceNumber: 'X', clientName: 'A', total: 100, daysAgo: 2, hoursAgo: 48, viewCount: 1, status: 'sent'
    }
  });
  const formMatch = html.match(
    /<form\s+action="\/invoices\/88\/status"\s+method="POST"[^>]*>[\s\S]*?data-testid="client-viewed-followup-mark-paid"/
  );
  assert.ok(formMatch, 'mark-as-paid form must POST to /invoices/88/status');
  assert.match(formMatch[0], /name="_csrf"\s+value="TEST_CSRF"/, 'CSRF token wired');
  assert.match(formMatch[0], /name="status"\s+value="paid"/, 'status=paid hidden field');
});

test('view: hostile client_name is HTML-escaped (XSS guard)', () => {
  const html = renderDashboard({
    clientViewedFollowupPrompt: {
      id: 1, invoiceNumber: 'INV-X', clientName: '<script>alert(1)</script>',
      total: 100, daysAgo: 2, hoursAgo: 48, viewCount: 1, status: 'sent'
    }
  });
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/,
    'raw script must NOT appear — EJS <%= must escape');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/,
    'escaped form must appear instead');
});

test('view: banner sits BELOW the stale-draft prompt (positional contract)', () => {
  // Stale-draft is a more urgent surface (the invoice never reached the
  // client AT ALL). The client-viewed prompt is for a sent-and-viewed
  // invoice — the client has it, just hasn't paid. Visual ordering
  // reflects urgency.
  const html = renderDashboard({
    staleDraftPrompt: { id: 5, invoiceNumber: 'INV-D', clientName: 'D', total: 50, hoursOld: 30 },
    clientViewedFollowupPrompt: {
      id: 88, invoiceNumber: 'X', clientName: 'A', total: 100, daysAgo: 2, hoursAgo: 48, viewCount: 1, status: 'sent'
    }
  });
  const stalePromptIdx = html.indexOf('data-testid="stale-draft-prompt"');
  const followupIdx = html.indexOf('data-testid="client-viewed-followup-prompt"');
  assert.ok(stalePromptIdx !== -1 && followupIdx !== -1,
    'both banners present in render');
  assert.ok(stalePromptIdx < followupIdx,
    'stale-draft prompt must render BEFORE client-viewed follow-up');
});

test('view: banner sits ABOVE the invoice-limit-progress block (positional contract)', () => {
  const html = renderDashboard({
    clientViewedFollowupPrompt: {
      id: 88, invoiceNumber: 'X', clientName: 'A', total: 100, daysAgo: 2, hoursAgo: 48, viewCount: 1, status: 'sent'
    },
    invoiceLimitProgress: { used: 1, max: 3, percent: 33, remaining: 2, atLimit: false, nearLimit: false },
    user: { plan: 'free', invoice_count: 1 }
  });
  const followupIdx = html.indexOf('data-testid="client-viewed-followup-prompt"');
  const limitIdx = html.indexOf('data-testid="invoice-limit-progress"');
  assert.ok(followupIdx !== -1, 'follow-up banner present');
  assert.ok(limitIdx !== -1, 'limit-progress block present');
  assert.ok(followupIdx < limitIdx,
    'client-viewed follow-up must render BEFORE invoice-limit-progress');
});

test('view: data attributes expose invoice-id, days-ago, view-count for hooks', () => {
  const html = renderDashboard({
    clientViewedFollowupPrompt: {
      id: 88, invoiceNumber: 'X', clientName: 'A', total: 100, daysAgo: 3, hoursAgo: 72, viewCount: 4, status: 'sent'
    }
  });
  assert.match(html, /data-invoice-id="88"/);
  assert.match(html, /data-days-ago="3"/);
  assert.match(html, /data-view-count="4"/);
});

test('view: share-intent buttons OMITTED when followUpIntents is null', () => {
  const html = renderDashboard({
    clientViewedFollowupPrompt: {
      id: 88, invoiceNumber: 'X', clientName: 'A', total: 100,
      daysAgo: 3, hoursAgo: 72, viewCount: 1, status: 'sent', followUpIntents: null
    }
  });
  assert.doesNotMatch(html, /data-testid="client-viewed-followup-share-intents"/);
});

test('view: share-intent buttons RENDER (whatsapp + sms + copy) when followUpIntents present', () => {
  const html = renderDashboard({
    clientViewedFollowupPrompt: {
      id: 88, invoiceNumber: 'X', clientName: 'A', total: 100,
      daysAgo: 3, hoursAgo: 72, viewCount: 1, status: 'sent',
      followUpIntents: {
        url: 'https://example.com/i/abc123',
        whatsapp: 'https://wa.me/?text=Hi+A',
        sms: 'sms:?&body=Hi+A',
        body: 'Hi A, just checking in...',
        subject: 'Quick check-in: Invoice X'
      }
    }
  });
  assert.match(html, /data-testid="client-viewed-followup-share-intents"/);
  assert.match(html, /data-testid="client-viewed-followup-share-whatsapp"/);
  assert.match(html, /data-testid="client-viewed-followup-share-sms"/);
  assert.match(html, /data-testid="client-viewed-followup-share-copy"/);
  assert.match(html, /href="https:\/\/wa\.me\/\?text=Hi\+A"/, 'whatsapp href verbatim');
  assert.match(html, /href="sms:\?&amp;body=Hi\+A"/, 'sms href HTML-attr escaped');
});

test('view: each share button POSTs /share-intent with the correct intent kind + CSRF', () => {
  const html = renderDashboard({
    clientViewedFollowupPrompt: {
      id: 88, invoiceNumber: 'X', clientName: 'A', total: 100,
      daysAgo: 3, hoursAgo: 72, viewCount: 1, status: 'sent',
      followUpIntents: {
        url: 'https://example.com/i/abc123',
        whatsapp: 'https://wa.me/?text=x',
        sms: 'sms:?&body=x'
      }
    }
  });
  const waMatch = html.match(/data-testid="client-viewed-followup-share-whatsapp"[^>]*onclick="([^"]+)"/);
  assert.ok(waMatch, 'whatsapp onclick wired');
  assert.match(waMatch[1], /\/invoices\/88\/share-intent/, 'whatsapp POSTs to /share-intent');
  assert.match(waMatch[1], /intent:\s*'whatsapp'/, 'whatsapp intent kind');
  assert.match(waMatch[1], /TEST_CSRF/, 'CSRF token threaded');
  const smsMatch = html.match(/data-testid="client-viewed-followup-share-sms"[^>]*onclick="([^"]+)"/);
  assert.match(smsMatch[1], /intent:\s*'sms'/, 'sms intent kind');
  const copyMatch = html.match(/data-testid="client-viewed-followup-share-copy"[^>]*onclick="([^"]+)"/);
  assert.match(copyMatch[1], /intent:\s*'copy'/, 'copy intent kind');
  assert.match(copyMatch[1], /navigator\.clipboard/, 'copy writes to clipboard');
});

test('view: Email button RENDERS when followUpIntents.mailto is set (mailto: href + intent=email POST)', () => {
  const html = renderDashboard({
    clientViewedFollowupPrompt: {
      id: 88, invoiceNumber: 'X', clientName: 'A', total: 100,
      daysAgo: 3, hoursAgo: 72, viewCount: 1, status: 'sent',
      followUpIntents: {
        url: 'https://example.com/i/abc123',
        whatsapp: 'https://wa.me/?text=x',
        sms: 'sms:?&body=x',
        mailto: 'mailto:ap%40acme.example?subject=Check-in&body=hi'
      }
    }
  });
  assert.match(html, /data-testid="client-viewed-followup-share-email"/, 'Email button renders');
  assert.match(html,
    /href="mailto:ap%40acme\.example\?subject=Check-in&amp;body=hi"/,
    'mailto href surfaces with EJS HTML attribute escaping');
  const emailBlock = html.match(/data-testid="client-viewed-followup-share-email"[\s\S]*?<\/a>/);
  assert.ok(emailBlock, 'Email anchor block renders');
  assert.match(emailBlock[0], /\/invoices\/88\/share-intent/,
    'Email click posts to /invoices/88/share-intent');
  assert.match(emailBlock[0], /intent:\s*'email'/, 'intent kind is email');
  assert.match(emailBlock[0], /TEST_CSRF/, 'CSRF wired');
  assert.doesNotMatch(emailBlock[0], /target="_blank"/,
    'mailto: anchors must not declare target=_blank (no extra tab)');
});

test('view: Email button OMITTED when followUpIntents.mailto is missing', () => {
  // Partial-deploy / legacy-row fallback — captured client_email is the
  // gating signal in lib/share-link, so the row's mailto can be absent
  // while whatsapp/sms/copy remain present.
  const html = renderDashboard({
    clientViewedFollowupPrompt: {
      id: 88, invoiceNumber: 'X', clientName: 'A', total: 100,
      daysAgo: 3, hoursAgo: 72, viewCount: 1, status: 'sent',
      followUpIntents: {
        url: 'https://example.com/i/abc123',
        whatsapp: 'https://wa.me/?text=x',
        sms: 'sms:?&body=x'
      }
    }
  });
  assert.doesNotMatch(html, /data-testid="client-viewed-followup-share-email"/);
  assert.match(html, /data-testid="client-viewed-followup-share-whatsapp"/);
  assert.match(html, /data-testid="client-viewed-followup-share-sms"/);
  assert.match(html, /data-testid="client-viewed-followup-share-copy"/);
});

test('view: hostile share-url is HTML-attribute-escaped', () => {
  const html = renderDashboard({
    clientViewedFollowupPrompt: {
      id: 1, invoiceNumber: 'X', clientName: 'A', total: 100,
      daysAgo: 3, hoursAgo: 72, viewCount: 1, status: 'sent',
      followUpIntents: {
        url: 'https://x/" onerror=alert(1) x="',
        whatsapp: 'https://wa.me/?text=x',
        sms: 'sms:?&body=x'
      }
    }
  });
  assert.doesNotMatch(html, /data-share-url="https:\/\/x\/" onerror=alert\(1\)/,
    'hostile attribute breakout must be neutralised');
});

test('view: banner print:hidden (printed invoice artifact stays clean)', () => {
  const html = renderDashboard({
    clientViewedFollowupPrompt: {
      id: 88, invoiceNumber: 'X', clientName: 'A', total: 100, daysAgo: 2, hoursAgo: 48, viewCount: 1, status: 'sent'
    }
  });
  const blockMatch = html.match(
    /data-testid="client-viewed-followup-prompt"[\s\S]{0,400}/
  );
  assert.ok(blockMatch, 'banner block located');
  assert.match(blockMatch[0], /print:hidden/);
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
  console.log(`\n${passed} passed, ${failed} failed (client-viewed-followup-prompt.test.js)`);
  if (failed > 0) process.exit(1);
})();
