'use strict';

/*
 * Sent-not-viewed prompt — dashboard banner that fires when the user has
 * a sent/overdue invoice they shared via share-intent 72+ hours ago, but
 * the client never opened the public link. The in-app analog of
 * jobs/sent-not-viewed-nudge.js (the 72h silent-failure email cron):
 * closes the gap between cron firings and gives the freelancer an in-app
 * "try another channel" surface the moment they return to the dashboard.
 *
 * Layers:
 *  1. db.getOldestSentNotViewed SQL contract — status filter,
 *     is_seed=false, first_viewed_at IS NULL + sent_via_share_intent_at
 *     anchor + age predicate, ORDER ASC, LIMIT 1, params, default 72.
 *  2. routes/invoices.loadOldestSentNotViewed — soft-fails on
 *     DB throw, on missing method, on null userId.
 *  3. routes/invoices.buildSentNotViewedPrompt — null user /
 *     missing invoice / missing sent_via_share_intent_at paths;
 *     happy-path shape; daysAgo computation.
 *  4. views/dashboard.ejs — banner renders when prompt set, omits
 *     otherwise; copy carries client + invoice + total + daysAgo;
 *     CTA deep-links; mark-as-paid form POSTs status=paid with CSRF;
 *     hostile client_name escaped.
 *
 * Run: node tests/sent-not-viewed-prompt.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ---- Layer 1: db.getOldestSentNotViewed SQL contract --------------------

function loadRealDb() {
  delete require.cache[require.resolve('../db')];
  return require('../db');
}

test('db.getOldestSentNotViewed: SQL filters on status IN (\'sent\',\'overdue\') AND is_seed=false', async () => {
  let captured = null;
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };
  };
  try {
    await real.db.getOldestSentNotViewed(42);
    assert.ok(captured, 'query was issued');
    assert.match(captured.sql, /status\s+IN\s*\(\s*'sent'\s*,\s*'overdue'\s*\)/i,
      'must filter on sent OR overdue (draft + paid excluded)');
    assert.match(captured.sql, /is_seed\s*=\s*false/i,
      'must exclude seed sample — banner is for real invoices only');
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.getOldestSentNotViewed: SQL requires first_viewed_at IS NULL (silent-failure cohort)', async () => {
  let captured = null;
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };
  };
  try {
    await real.db.getOldestSentNotViewed(42);
    assert.match(captured.sql, /first_viewed_at\s+IS\s+NULL/i,
      'must require first_viewed_at IS NULL — viewed-but-unpaid is the other cohort (client-viewed-followup)');
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.getOldestSentNotViewed: SQL anchors on sent_via_share_intent_at NOT NULL + age predicate', async () => {
  let captured = null;
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };
  };
  try {
    await real.db.getOldestSentNotViewed(42, 72);
    assert.match(captured.sql, /sent_via_share_intent_at\s+IS\s+NOT\s+NULL/i,
      'must require sent_via_share_intent_at IS NOT NULL — only invoices with unambiguous freelancer-side share gesture');
    assert.match(captured.sql, /sent_via_share_intent_at\s*<=\s*NOW\(\)\s*-\s*\(\$\d+\s*\*\s*INTERVAL\s*'1\s*hour'\)/i,
      'must compare sent_via_share_intent_at to NOW() - ($n * INTERVAL \'1 hour\')');
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.getOldestSentNotViewed: SQL orders by sent_via_share_intent_at ASC LIMIT 1 (oldest share)', async () => {
  let captured = null;
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };
  };
  try {
    await real.db.getOldestSentNotViewed(42);
    assert.match(captured.sql, /ORDER\s+BY\s+sent_via_share_intent_at\s+ASC/i,
      'oldest-shared first — peak silent-failure detection priority');
    assert.match(captured.sql, /LIMIT\s+1/i, 'one prompt at a time');
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.getOldestSentNotViewed: params are [userId, hours]; default hours=72', async () => {
  let captured = null;
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };
  };
  try {
    await real.db.getOldestSentNotViewed(99);
    assert.strictEqual(captured.params[0], 99, 'userId is first param');
    assert.strictEqual(captured.params[1], 72, 'hours defaults to 72 — matches sent-not-viewed-nudge email cron window');
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.getOldestSentNotViewed: explicit fractional hours floored to int', async () => {
  let captured = null;
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };
  };
  try {
    await real.db.getOldestSentNotViewed(7, 96.9);
    assert.strictEqual(captured.params[1], 96);
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.getOldestSentNotViewed: returns null and skips DB on falsy userId', async () => {
  let queried = false;
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async () => { queried = true; return { rows: [] }; };
  try {
    const out = await real.db.getOldestSentNotViewed(null);
    assert.strictEqual(out, null);
    assert.strictEqual(queried, false, 'no DB round-trip on falsy userId');
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.getOldestSentNotViewed: returns null when no rows match', async () => {
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async () => ({ rows: [] });
  try {
    const out = await real.db.getOldestSentNotViewed(42);
    assert.strictEqual(out, null);
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.getOldestSentNotViewed: returns first row with id/number/client/total/sent_via_share_intent_at/status', async () => {
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async () => ({
    rows: [{
      id: 88,
      invoice_number: 'INV-2026-0099',
      client_name: 'Big Client Co.',
      total: '2500.00',
      sent_via_share_intent_at: '2026-05-15T12:00:00Z',
      status: 'sent'
    }]
  });
  try {
    const out = await real.db.getOldestSentNotViewed(42);
    assert.strictEqual(out.id, 88);
    assert.strictEqual(out.invoice_number, 'INV-2026-0099');
    assert.strictEqual(out.client_name, 'Big Client Co.');
    assert.strictEqual(out.status, 'sent');
    assert.ok(out.sent_via_share_intent_at, 'must project sent_via_share_intent_at for the daysAgo calc');
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.getOldestSentNotViewed: SELECT projection includes sent_via_share_intent_at', async () => {
  let captured = null;
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };
  };
  try {
    await real.db.getOldestSentNotViewed(42);
    assert.match(captured.sql, /sent_via_share_intent_at/, 'must project sent_via_share_intent_at for the daysAgo calc');
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.getOldestSentNotViewed: SELECT projects public_token, client_email, due_date (share-intent inputs)', async () => {
  let captured = null;
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };
  };
  try {
    await real.db.getOldestSentNotViewed(42);
    assert.match(captured.sql, /public_token/,
      'must project public_token — input to buildShareSurfaceForInvoice for inline share intents');
    assert.match(captured.sql, /client_email/,
      'must project client_email — input to buildPublicShareIntents mailto recipient');
    assert.match(captured.sql, /due_date/,
      'must project due_date — input to buildShareSurfaceForInvoice daysOverdue calc');
  } finally {
    real.pool.query = originalQuery;
  }
});

// ---- Layer 2: loadOldestSentNotViewed soft-fail paths --------------------

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
    getOldestClientViewedUnpaid: async () => null
  }
};

function installDbStub() {
  if (dbStubMethodPresent) {
    dbStub.db.getOldestSentNotViewed = async () => {
      if (dbStubThrows) throw new Error('boom');
      return dbStubInvoice;
    };
  } else {
    delete dbStub.db.getOldestSentNotViewed;
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

test('loadOldestSentNotViewed: returns the db row on happy path', async () => {
  dbStubInvoice = { id: 88, invoice_number: 'X', client_name: 'A', total: 100, sent_via_share_intent_at: new Date().toISOString(), status: 'sent' };
  dbStubThrows = false;
  dbStubMethodPresent = true;
  const routes = installDbStub();
  const result = await routes.loadOldestSentNotViewed(1);
  assert.strictEqual(result.id, 88);
});

test('loadOldestSentNotViewed: returns null when no userId (no DB call)', async () => {
  dbStubMethodPresent = true;
  const routes = installDbStub();
  const result = await routes.loadOldestSentNotViewed(null);
  assert.strictEqual(result, null);
});

test('loadOldestSentNotViewed: soft-fails to null on DB throw', async () => {
  dbStubInvoice = null;
  dbStubThrows = true;
  dbStubMethodPresent = true;
  const routes = installDbStub();
  const origErr = console.error;
  console.error = () => {};
  try {
    const result = await routes.loadOldestSentNotViewed(1);
    assert.strictEqual(result, null,
      'dashboard render must never be blocked by a sent-not-viewed lookup failure');
  } finally {
    console.error = origErr;
    dbStubThrows = false;
  }
});

test('loadOldestSentNotViewed: returns null when db method missing (legacy stub)', async () => {
  dbStubMethodPresent = false;
  const routes = installDbStub();
  const result = await routes.loadOldestSentNotViewed(1);
  assert.strictEqual(result, null);
  dbStubMethodPresent = true;
});

test('loadOldestSentNotViewed: lazy-mints public_token when absent (legacy row)', async () => {
  dbStubInvoice = { id: 88, invoice_number: 'X', client_name: 'A', total: 100,
    sent_via_share_intent_at: new Date().toISOString(), status: 'sent', public_token: null };
  dbStubThrows = false;
  dbStubMethodPresent = true;
  let mintCalls = 0;
  dbStub.db.getOrCreatePublicToken = async (invoiceId, userId) => {
    mintCalls++;
    assert.strictEqual(invoiceId, 88, 'mint called with the loaded row id');
    assert.strictEqual(userId, 7, 'mint called with the session user id');
    return 'abcdef0123456789';
  };
  try {
    const routes = installDbStub();
    const result = await routes.loadOldestSentNotViewed(7);
    assert.strictEqual(mintCalls, 1, 'mint called exactly once');
    assert.strictEqual(result.public_token, 'abcdef0123456789', 'token grafted onto row');
  } finally {
    delete dbStub.db.getOrCreatePublicToken;
  }
});

test('loadOldestSentNotViewed: skips lazy-mint when public_token already present', async () => {
  dbStubInvoice = { id: 88, invoice_number: 'X', client_name: 'A', total: 100,
    sent_via_share_intent_at: new Date().toISOString(), status: 'sent', public_token: 'deadbeefcafe1234' };
  dbStubThrows = false;
  dbStubMethodPresent = true;
  let mintCalls = 0;
  dbStub.db.getOrCreatePublicToken = async () => { mintCalls++; return 'mismatch'; };
  try {
    const routes = installDbStub();
    const result = await routes.loadOldestSentNotViewed(7);
    assert.strictEqual(mintCalls, 0, 'mint NOT called when token already present');
    assert.strictEqual(result.public_token, 'deadbeefcafe1234', 'original token preserved');
  } finally {
    delete dbStub.db.getOrCreatePublicToken;
  }
});

test('loadOldestSentNotViewed: soft-fails to keep the row when mint throws', async () => {
  dbStubInvoice = { id: 88, invoice_number: 'X', client_name: 'A', total: 100,
    sent_via_share_intent_at: new Date().toISOString(), status: 'sent', public_token: null };
  dbStubThrows = false;
  dbStubMethodPresent = true;
  dbStub.db.getOrCreatePublicToken = async () => { throw new Error('mint exploded'); };
  const origErr = console.error;
  console.error = () => {};
  try {
    const routes = installDbStub();
    const result = await routes.loadOldestSentNotViewed(7);
    assert.ok(result, 'row STILL returned — banner falls back to CTA + Mark-as-paid only');
    assert.strictEqual(result.id, 88);
    assert.strictEqual(result.public_token, null, 'token stays null on mint throw');
  } finally {
    console.error = origErr;
    delete dbStub.db.getOrCreatePublicToken;
  }
});

// ---- Layer 3: buildSentNotViewedPrompt shape contract -------------------

test('buildSentNotViewedPrompt: returns null when user missing', () => {
  const routes = installDbStub();
  assert.strictEqual(
    routes.buildSentNotViewedPrompt(null, { id: 1, sent_via_share_intent_at: new Date() }),
    null
  );
});

test('buildSentNotViewedPrompt: returns null when invoice missing', () => {
  const routes = installDbStub();
  assert.strictEqual(routes.buildSentNotViewedPrompt({ id: 1 }, null), null);
});

test('buildSentNotViewedPrompt: returns null when invoice has no id', () => {
  const routes = installDbStub();
  assert.strictEqual(
    routes.buildSentNotViewedPrompt({ id: 1 }, { invoice_number: 'X', sent_via_share_intent_at: new Date() }),
    null
  );
});

test('buildSentNotViewedPrompt: returns null when sent_via_share_intent_at missing (defence-in-depth)', () => {
  const routes = installDbStub();
  assert.strictEqual(
    routes.buildSentNotViewedPrompt({ id: 1 }, { id: 17, sent_via_share_intent_at: null }),
    null
  );
});

test('buildSentNotViewedPrompt: returns null when sent_via_share_intent_at is unparseable', () => {
  const routes = installDbStub();
  assert.strictEqual(
    routes.buildSentNotViewedPrompt({ id: 1 }, { id: 17, sent_via_share_intent_at: 'not-a-date' }),
    null
  );
});

test('buildSentNotViewedPrompt: happy-path shape (id, invoiceNumber, clientName, total, daysAgo, status)', () => {
  const routes = installDbStub();
  const fourDaysAgo = new Date(Date.now() - 4 * 86400000);
  const out = routes.buildSentNotViewedPrompt(
    { id: 1 },
    { id: 88, invoice_number: 'INV-2026-0099', client_name: 'Acme Co.', total: '2500.00',
      sent_via_share_intent_at: fourDaysAgo, status: 'sent' }
  );
  assert.strictEqual(out.id, 88);
  assert.strictEqual(out.invoiceNumber, 'INV-2026-0099');
  assert.strictEqual(out.clientName, 'Acme Co.');
  assert.strictEqual(out.total, 2500);
  assert.strictEqual(out.daysAgo, 4);
  assert.strictEqual(out.status, 'sent');
});

test('buildSentNotViewedPrompt: daysAgo floor is 1 (never "0 days ago")', () => {
  const routes = installDbStub();
  const halfHourAgo = new Date(Date.now() - 1800 * 1000);
  const out = routes.buildSentNotViewedPrompt(
    { id: 1 },
    { id: 1, sent_via_share_intent_at: halfHourAgo }
  );
  assert.strictEqual(out.daysAgo, 1, 'sub-day windows clamp to 1 — copy stays grammatical');
});

test('buildSentNotViewedPrompt: stringy total parses to Number', () => {
  const routes = installDbStub();
  const threeDaysAgo = new Date(Date.now() - 3 * 86400000);
  const out = routes.buildSentNotViewedPrompt(
    { id: 1 },
    { id: 1, sent_via_share_intent_at: threeDaysAgo, total: '799.99' }
  );
  assert.strictEqual(out.total, 799.99);
});

test('buildSentNotViewedPrompt: empty client_name passes through as empty string', () => {
  const routes = installDbStub();
  const threeDaysAgo = new Date(Date.now() - 3 * 86400000);
  const out = routes.buildSentNotViewedPrompt(
    { id: 1 },
    { id: 1, sent_via_share_intent_at: threeDaysAgo, client_name: '' }
  );
  assert.strictEqual(out.clientName, '', 'view layer handles the empty-name fallback copy');
});

test('buildSentNotViewedPrompt: status defaults to "sent" when missing', () => {
  const routes = installDbStub();
  const threeDaysAgo = new Date(Date.now() - 3 * 86400000);
  const out = routes.buildSentNotViewedPrompt(
    { id: 1 },
    { id: 1, sent_via_share_intent_at: threeDaysAgo }
  );
  assert.strictEqual(out.status, 'sent');
});

test('buildSentNotViewedPrompt: shareIntents=null when public_token missing (legacy row)', () => {
  const routes = installDbStub();
  const threeDaysAgo = new Date(Date.now() - 3 * 86400000);
  const out = routes.buildSentNotViewedPrompt(
    { id: 1 },
    { id: 88, invoice_number: 'INV-X', client_name: 'A', total: 100,
      sent_via_share_intent_at: threeDaysAgo, public_token: null }
  );
  assert.strictEqual(out.shareIntents, null, 'view degrades cleanly to Open-invoice + Mark-as-paid');
});

test('buildSentNotViewedPrompt: shareIntents=null when public_token is malformed', () => {
  const routes = installDbStub();
  const threeDaysAgo = new Date(Date.now() - 3 * 86400000);
  const out = routes.buildSentNotViewedPrompt(
    { id: 1 },
    { id: 88, invoice_number: 'INV-X', client_name: 'A', total: 100,
      sent_via_share_intent_at: threeDaysAgo, public_token: 'not-a-hex-token!' }
  );
  assert.strictEqual(out.shareIntents, null);
});

test('buildSentNotViewedPrompt: shareIntents derived from public_token uses first-send body (not "checking in")', () => {
  const routes = installDbStub();
  const threeDaysAgo = new Date(Date.now() - 3 * 86400000);
  const out = routes.buildSentNotViewedPrompt(
    { id: 1 },
    { id: 88, invoice_number: 'INV-2026-0099', client_name: 'Acme Co.',
      client_email: 'pay@acme.co', total: '500.00',
      sent_via_share_intent_at: threeDaysAgo,
      public_token: 'abcdef0123456789' }
  );
  assert.ok(out.shareIntents, 'shareIntents derived when token present');
  assert.ok(out.shareIntents.whatsapp.startsWith('https://wa.me/?text='),
    'whatsapp deep-link');
  assert.ok(out.shareIntents.sms.startsWith('sms:?&body='), 'sms deep-link');
  assert.ok(out.shareIntents.mailto.startsWith('mailto:pay%40acme.co'),
    'mailto recipient percent-encoded');
  assert.ok(out.shareIntents.url.endsWith('/i/abcdef0123456789'),
    'shareable public URL');
  // first-send body shape — "here's invoice X", NOT "just checking in"
  const decodedBody = decodeURIComponent(out.shareIntents.whatsapp.replace('https://wa.me/?text=', ''));
  assert.match(decodedBody, /here's invoice INV-2026-0099/i,
    'first-send body — client never opened so no "checking in" assumption');
  assert.doesNotMatch(decodedBody, /checking in/i,
    'must NOT use follow-up "checking in" framing — that\'s for viewed cohort');
});

test('buildSentNotViewedPrompt: shareIntents.mailto omitted when client_email missing (other 3 channels intact)', () => {
  const routes = installDbStub();
  const threeDaysAgo = new Date(Date.now() - 3 * 86400000);
  const out = routes.buildSentNotViewedPrompt(
    { id: 1 },
    { id: 88, invoice_number: 'X', client_name: 'A', total: 100,
      sent_via_share_intent_at: threeDaysAgo,
      public_token: 'abcdef0123456789', client_email: null }
  );
  assert.ok(out.shareIntents, 'whatsapp+sms+copy still surface without an email address');
  // buildPublicShareIntents always returns mailto (without recipient), so we
  // assert the structural shape rather than absence — the view template
  // gates the Email button on the presence of a meaningful recipient.
  assert.ok(out.shareIntents.url, 'url still present for copy + sms/whatsapp');
  assert.match(out.shareIntents.mailto, /^mailto:\?/, 'mailto has no recipient when client_email missing');
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
    firstRealInvoicePrompt: null,
    pendingQuickInvoice: null,
    ...locals
  }, {
    views: [path.join(__dirname, '..', 'views')],
    filename: dashboardTplPath
  });
}

test('view: banner is OMITTED when sentNotViewedPrompt is null', () => {
  const html = renderDashboard({ sentNotViewedPrompt: null });
  assert.doesNotMatch(html, /data-testid="sent-not-viewed-prompt"/);
});

test('view: banner RENDERS when prompt is set', () => {
  const html = renderDashboard({
    sentNotViewedPrompt: {
      id: 88, invoiceNumber: 'INV-2026-0099', clientName: 'Acme Co.',
      total: 2500, daysAgo: 4, hoursAgo: 96, status: 'sent'
    }
  });
  assert.match(html, /data-testid="sent-not-viewed-prompt"/);
});

test('view: banner shows client name, invoice number, total, daysAgo', () => {
  const html = renderDashboard({
    sentNotViewedPrompt: {
      id: 88, invoiceNumber: 'INV-2026-0099', clientName: 'Acme Co.',
      total: 2500, daysAgo: 4, hoursAgo: 96, status: 'sent'
    }
  });
  assert.match(html, /Acme Co\./, 'client name visible');
  assert.match(html, /INV-2026-0099/, 'invoice number visible');
  assert.match(html, /\$<span[^>]*>2500\.00<\/span>/, 'total formatted to 2 decimals');
  assert.match(html, /<span[^>]*data-testid="sent-not-viewed-days-ago"[^>]*>4<\/span>\s*days?\s*ago/, 'daysAgo surface visible');
});

test('view: copy includes "zero opens" framing (distinct from client-viewed-followup)', () => {
  const html = renderDashboard({
    sentNotViewedPrompt: {
      id: 88, invoiceNumber: 'X', clientName: 'A', total: 100, daysAgo: 4, hoursAgo: 96, status: 'sent'
    }
  });
  assert.match(html, /zero opens/i,
    'silent-failure framing must say "zero opens" — distinguishes from "they opened it" follow-up cohort');
});

test('view: empty client name falls back to "Your client hasn\'t opened your invoice"', () => {
  const html = renderDashboard({
    sentNotViewedPrompt: {
      id: 88, invoiceNumber: 'X', clientName: '', total: 100, daysAgo: 4, hoursAgo: 96, status: 'sent'
    }
  });
  assert.match(html, /Your client hasn't opened your invoice/);
});

test('view: CTA deep-links to /invoices/:id', () => {
  const html = renderDashboard({
    sentNotViewedPrompt: {
      id: 88, invoiceNumber: 'X', clientName: 'A', total: 100, daysAgo: 4, hoursAgo: 96, status: 'sent'
    }
  });
  assert.match(html, /href="\/invoices\/88"[^>]*data-testid="sent-not-viewed-cta"/);
});

test('view: Mark-as-Paid form POSTs to /invoices/:id/status with status=paid + CSRF', () => {
  const html = renderDashboard({
    sentNotViewedPrompt: {
      id: 88, invoiceNumber: 'X', clientName: 'A', total: 100, daysAgo: 4, hoursAgo: 96, status: 'sent'
    }
  });
  const formMatch = html.match(
    /<form\s+action="\/invoices\/88\/status"\s+method="POST"[^>]*>[\s\S]*?data-testid="sent-not-viewed-mark-paid"/
  );
  assert.ok(formMatch, 'mark-as-paid form must POST to /invoices/88/status');
  assert.match(formMatch[0], /name="_csrf"\s+value="TEST_CSRF"/, 'CSRF token wired');
  assert.match(formMatch[0], /name="status"\s+value="paid"/, 'status=paid hidden field');
});

test('view: hostile client_name is HTML-escaped (XSS guard)', () => {
  const html = renderDashboard({
    sentNotViewedPrompt: {
      id: 1, invoiceNumber: 'INV-X', clientName: '<script>alert(1)</script>',
      total: 100, daysAgo: 4, hoursAgo: 96, status: 'sent'
    }
  });
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/,
    'raw script must NOT appear — EJS <%= must escape');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/,
    'escaped form must appear instead');
});

test('view: banner sits BELOW the client-viewed-followup prompt (positional contract)', () => {
  // The client-viewed cohort is "good news, just needs a nudge" (emerald
  // tone, higher conversion likelihood). The silent-failure cohort
  // (orange) is "bad news, the channel may have failed." Visual ordering
  // surfaces the highest-conversion-likelihood prompt first.
  const html = renderDashboard({
    clientViewedFollowupPrompt: {
      id: 5, invoiceNumber: 'INV-D', clientName: 'D', total: 50, daysAgo: 3, hoursAgo: 72, viewCount: 1, status: 'sent'
    },
    sentNotViewedPrompt: {
      id: 88, invoiceNumber: 'X', clientName: 'A', total: 100, daysAgo: 4, hoursAgo: 96, status: 'sent'
    }
  });
  const viewedIdx = html.indexOf('data-testid="client-viewed-followup-prompt"');
  const sentIdx = html.indexOf('data-testid="sent-not-viewed-prompt"');
  assert.ok(viewedIdx !== -1 && sentIdx !== -1,
    'both banners present in render');
  assert.ok(viewedIdx < sentIdx,
    'client-viewed-followup must render BEFORE sent-not-viewed (higher-conversion cohort first)');
});

test('view: banner sits ABOVE the invoice-limit-progress block (positional contract)', () => {
  const html = renderDashboard({
    sentNotViewedPrompt: {
      id: 88, invoiceNumber: 'X', clientName: 'A', total: 100, daysAgo: 4, hoursAgo: 96, status: 'sent'
    },
    invoiceLimitProgress: { used: 1, max: 3, percent: 33, remaining: 2, atLimit: false, nearLimit: false },
    user: { plan: 'free', invoice_count: 1 }
  });
  const sentIdx = html.indexOf('data-testid="sent-not-viewed-prompt"');
  const limitIdx = html.indexOf('data-testid="invoice-limit-progress"');
  assert.ok(sentIdx !== -1, 'sent-not-viewed banner present');
  assert.ok(limitIdx !== -1, 'limit-progress block present');
  assert.ok(sentIdx < limitIdx,
    'sent-not-viewed must render BEFORE invoice-limit-progress');
});

test('view: data attributes expose invoice-id and days-ago for hooks', () => {
  const html = renderDashboard({
    sentNotViewedPrompt: {
      id: 88, invoiceNumber: 'X', clientName: 'A', total: 100, daysAgo: 4, hoursAgo: 96, status: 'sent'
    }
  });
  assert.match(html, /data-invoice-id="88"/);
  assert.match(html, /data-days-ago="4"/);
});

test('view: banner print:hidden (printed invoice artifact stays clean)', () => {
  const html = renderDashboard({
    sentNotViewedPrompt: {
      id: 88, invoiceNumber: 'X', clientName: 'A', total: 100, daysAgo: 4, hoursAgo: 96, status: 'sent'
    }
  });
  const blockMatch = html.match(
    /data-testid="sent-not-viewed-prompt"[\s\S]{0,400}/
  );
  assert.ok(blockMatch, 'banner block located');
  assert.match(blockMatch[0], /print:hidden/);
});

test('view: share-intents row OMITTED when shareIntents=null (legacy degrade)', () => {
  const html = renderDashboard({
    sentNotViewedPrompt: {
      id: 88, invoiceNumber: 'X', clientName: 'A', total: 100,
      daysAgo: 4, hoursAgo: 96, status: 'sent', shareIntents: null
    }
  });
  assert.doesNotMatch(html, /data-testid="sent-not-viewed-share-intents"/,
    'no share-intent row when token missing — fallback CTAs still render');
});

test('view: share-intents row RENDERS 4 buttons when shareIntents set', () => {
  const html = renderDashboard({
    sentNotViewedPrompt: {
      id: 88, invoiceNumber: 'X', clientName: 'A', total: 100,
      daysAgo: 4, hoursAgo: 96, status: 'sent',
      shareIntents: {
        whatsapp: 'https://wa.me/?text=hi',
        sms: 'sms:?&body=hi',
        mailto: 'mailto:c@example.com?subject=Invoice&body=hi',
        url: 'https://app.example.com/i/abcdef0123456789'
      }
    }
  });
  assert.match(html, /data-testid="sent-not-viewed-share-intents"/);
  assert.match(html, /data-testid="sent-not-viewed-share-whatsapp"/);
  assert.match(html, /data-testid="sent-not-viewed-share-sms"/);
  assert.match(html, /data-testid="sent-not-viewed-share-email"/);
  assert.match(html, /data-testid="sent-not-viewed-share-copy"/);
});

test('view: each share-intent button POSTs /share-intent with matching intent + CSRF token', () => {
  const html = renderDashboard({
    sentNotViewedPrompt: {
      id: 88, invoiceNumber: 'X', clientName: 'A', total: 100,
      daysAgo: 4, hoursAgo: 96, status: 'sent',
      shareIntents: {
        whatsapp: 'https://wa.me/?text=hi',
        sms: 'sms:?&body=hi',
        mailto: 'mailto:c@example.com?subject=I&body=h',
        url: 'https://app.example.com/i/abcdef0123456789'
      }
    }
  });
  for (const intent of ['whatsapp', 'sms', 'email', 'copy']) {
    const btnRe = new RegExp(
      `data-testid="sent-not-viewed-share-${intent}"[\\s\\S]*?` +
      `/invoices/88/share-intent[\\s\\S]*?` +
      `'X-CSRF-Token': 'TEST_CSRF'[\\s\\S]*?` +
      `JSON.stringify\\(\\{ intent: '${intent}' \\}\\)`
    );
    assert.match(html, btnRe, `${intent} button posts /share-intent with intent='${intent}' + CSRF`);
  }
});

test('view: WhatsApp button opens in new tab (target=_blank rel=noopener)', () => {
  const html = renderDashboard({
    sentNotViewedPrompt: {
      id: 88, invoiceNumber: 'X', clientName: 'A', total: 100,
      daysAgo: 4, hoursAgo: 96, status: 'sent',
      shareIntents: {
        whatsapp: 'https://wa.me/?text=hi', sms: 'sms:?&body=hi',
        mailto: 'mailto:c@example.com?subject=I&body=h',
        url: 'https://app.example.com/i/abcdef0123456789'
      }
    }
  });
  const waMatch = html.match(
    /<a[^>]*data-testid="sent-not-viewed-share-whatsapp"[^>]*>/
  );
  assert.ok(waMatch, 'whatsapp anchor present');
  assert.match(waMatch[0], /target="_blank"/);
  assert.match(waMatch[0], /rel="noopener"/);
});

test('view: Email button omitted when shareIntents.mailto absent (no client_email)', () => {
  const html = renderDashboard({
    sentNotViewedPrompt: {
      id: 88, invoiceNumber: 'X', clientName: 'A', total: 100,
      daysAgo: 4, hoursAgo: 96, status: 'sent',
      shareIntents: {
        whatsapp: 'https://wa.me/?text=hi',
        sms: 'sms:?&body=hi',
        mailto: '',
        url: 'https://app.example.com/i/abcdef0123456789'
      }
    }
  });
  assert.doesNotMatch(html, /data-testid="sent-not-viewed-share-email"/,
    'Email button gated on mailto presence — other 3 still render');
  assert.match(html, /data-testid="sent-not-viewed-share-whatsapp"/);
  assert.match(html, /data-testid="sent-not-viewed-share-sms"/);
  assert.match(html, /data-testid="sent-not-viewed-share-copy"/);
});

test('view: hostile share URL is HTML-attribute-escaped on the Copy button data-share-url', () => {
  const html = renderDashboard({
    sentNotViewedPrompt: {
      id: 88, invoiceNumber: 'X', clientName: 'A', total: 100,
      daysAgo: 4, hoursAgo: 96, status: 'sent',
      shareIntents: {
        whatsapp: 'https://wa.me/?text=hi', sms: 'sms:?&body=hi',
        mailto: 'mailto:c@example.com?subject=I&body=h',
        url: 'https://x.com/i/abc"><script>alert(1)</script>'
      }
    }
  });
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/,
    'raw script must NOT escape the data-share-url attribute');
  assert.match(html, /&#34;|&quot;/, 'quote must be HTML-attribute-escaped');
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
  console.log(`\n${passed} passed, ${failed} failed (sent-not-viewed-prompt.test.js)`);
  if (failed > 0) process.exit(1);
})();
