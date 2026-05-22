'use strict';

/*
 * Payment-claim dashboard prompt — the freelancer-facing action banner that
 * fires when their client has clicked "I've sent payment" on the public
 * /i/<token> share page (routes/share.js → db.recordPaymentClaim stamps
 * payment_claimed_at) but the invoice has not yet been flipped to paid.
 *
 * This is the highest-converting Milestone 4 cohort — the client has
 * explicitly signalled "I paid you", so one click ("Confirm & mark paid")
 * closes the loop and fires the entire downstream conversion stack
 * (first-paid celebration, referral CTA, annual-upgrade prompt, activation-
 * funnel "got paid" stage). Today's only surface is a tiny row badge in
 * the dashboard invoice table + a fire-and-forget Resend email that can be
 * eaten by an API outage. The banner makes the claim the first thing the
 * freelancer sees on their next dashboard load.
 *
 * Layers:
 *  1. db.getOldestPendingPaymentClaim SQL contract — status<>'paid',
 *     is_seed=false, payment_claimed_at IS NOT NULL, ORDER ASC LIMIT 1,
 *     params, SELECT projection.
 *  2. routes/invoices.loadOldestPendingPaymentClaim — soft-fails on DB
 *     throw, missing method, null userId.
 *  3. routes/invoices.buildPaymentClaimPrompt — null user / missing
 *     invoice / missing payment_claimed_at / paid-status paths;
 *     happy-path shape (method whitelist, methodLabel, reference/note
 *     trimming, daysAgo/hoursAgo).
 *  4. Suppression — buildClientViewedFollowupPrompt and
 *     buildOverduePrompt suppress when payment-claim targets the same id.
 *  5. views/dashboard.ejs — banner renders when prompt set, omits
 *     otherwise; copy carries client + invoice + total + method + ref +
 *     note; mark-as-paid form POSTs status=paid with CSRF; positional
 *     ordering above other M4 prompts; XSS escaped.
 *
 * Run: node tests/payment-claim-prompt.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ---- Layer 1: db.getOldestPendingPaymentClaim SQL contract --------------

function loadRealDb() {
  delete require.cache[require.resolve('../db')];
  return require('../db');
}

test('db.getOldestPendingPaymentClaim: SQL filters on status <> \'paid\'', async () => {
  let captured = null;
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };
  };
  try {
    await real.db.getOldestPendingPaymentClaim(42);
    assert.ok(captured, 'query was issued');
    assert.match(captured.sql, /status\s*<>\s*'paid'/i,
      'must exclude already-paid invoices — banner is for the pre-confirm window');
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.getOldestPendingPaymentClaim: SQL excludes is_seed=true', async () => {
  let captured = null;
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };
  };
  try {
    await real.db.getOldestPendingPaymentClaim(42);
    assert.match(captured.sql, /is_seed\s*=\s*false/i,
      'must exclude seed sample — banner is for real invoices only');
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.getOldestPendingPaymentClaim: SQL anchors on payment_claimed_at IS NOT NULL', async () => {
  let captured = null;
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };
  };
  try {
    await real.db.getOldestPendingPaymentClaim(42);
    assert.match(captured.sql, /payment_claimed_at\s+IS\s+NOT\s+NULL/i,
      'must require payment_claimed_at IS NOT NULL — the cohort signal');
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.getOldestPendingPaymentClaim: SQL orders by payment_claimed_at ASC LIMIT 1', async () => {
  let captured = null;
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };
  };
  try {
    await real.db.getOldestPendingPaymentClaim(42);
    assert.match(captured.sql, /ORDER\s+BY\s+payment_claimed_at\s+ASC/i,
      'oldest-claim first — most-stale unconfirmed claim has highest urgency');
    assert.match(captured.sql, /LIMIT\s+1/i, 'one prompt at a time');
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.getOldestPendingPaymentClaim: params are [userId]', async () => {
  let captured = null;
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };
  };
  try {
    await real.db.getOldestPendingPaymentClaim(99);
    assert.strictEqual(captured.params.length, 1, 'single param: userId');
    assert.strictEqual(captured.params[0], 99, 'userId is first param');
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.getOldestPendingPaymentClaim: returns null and skips DB on falsy userId', async () => {
  let queried = false;
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async () => { queried = true; return { rows: [] }; };
  try {
    const out = await real.db.getOldestPendingPaymentClaim(null);
    assert.strictEqual(out, null);
    assert.strictEqual(queried, false, 'no DB round-trip on falsy userId');
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.getOldestPendingPaymentClaim: returns null when no rows match', async () => {
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async () => ({ rows: [] });
  try {
    const out = await real.db.getOldestPendingPaymentClaim(42);
    assert.strictEqual(out, null);
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.getOldestPendingPaymentClaim: SELECT projects claim columns + total/status/client', async () => {
  let captured = null;
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };
  };
  try {
    await real.db.getOldestPendingPaymentClaim(42);
    assert.match(captured.sql, /payment_claimed_at/, 'projects payment_claimed_at');
    assert.match(captured.sql, /payment_claim_method/, 'projects payment_claim_method');
    assert.match(captured.sql, /payment_claim_reference/, 'projects payment_claim_reference');
    assert.match(captured.sql, /payment_claim_note/, 'projects payment_claim_note');
    assert.match(captured.sql, /invoice_number/, 'projects invoice_number');
    assert.match(captured.sql, /client_name/, 'projects client_name');
    assert.match(captured.sql, /total/, 'projects total');
    assert.match(captured.sql, /status/, 'projects status');
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.getOldestPendingPaymentClaim: returns first row with claim fields', async () => {
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async () => ({
    rows: [{
      id: 77,
      invoice_number: 'INV-2026-0077',
      client_name: 'Pending Co.',
      total: '1250.00',
      status: 'sent',
      due_date: '2026-06-01',
      payment_claimed_at: '2026-05-20T10:00:00Z',
      payment_claim_method: 'venmo',
      payment_claim_reference: '@payer-handle',
      payment_claim_note: 'Sent earlier today',
      first_viewed_at: '2026-05-15T12:00:00Z'
    }]
  });
  try {
    const out = await real.db.getOldestPendingPaymentClaim(42);
    assert.strictEqual(out.id, 77);
    assert.strictEqual(out.payment_claim_method, 'venmo');
    assert.strictEqual(out.payment_claim_reference, '@payer-handle');
  } finally {
    real.pool.query = originalQuery;
  }
});

// ---- Layer 2: loadOldestPendingPaymentClaim soft-fail paths -------------

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
    getOldestSentNotViewed: async () => null,
    getOldestOverdueInvoice: async () => null
  }
};

function installDbStub() {
  if (dbStubMethodPresent) {
    dbStub.db.getOldestPendingPaymentClaim = async () => {
      if (dbStubThrows) throw new Error('boom');
      return dbStubInvoice;
    };
  } else {
    delete dbStub.db.getOldestPendingPaymentClaim;
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

test('loadOldestPendingPaymentClaim: returns the db row on happy path', async () => {
  dbStubInvoice = { id: 77, invoice_number: 'X', client_name: 'A', total: 100, payment_claimed_at: new Date().toISOString(), payment_claim_method: 'venmo', status: 'sent' };
  dbStubThrows = false;
  dbStubMethodPresent = true;
  const routes = installDbStub();
  const result = await routes.loadOldestPendingPaymentClaim(1);
  assert.strictEqual(result.id, 77);
});

test('loadOldestPendingPaymentClaim: returns null when no userId (no DB call)', async () => {
  dbStubMethodPresent = true;
  const routes = installDbStub();
  const result = await routes.loadOldestPendingPaymentClaim(null);
  assert.strictEqual(result, null);
});

test('loadOldestPendingPaymentClaim: soft-fails to null on DB throw', async () => {
  dbStubInvoice = null;
  dbStubThrows = true;
  dbStubMethodPresent = true;
  const routes = installDbStub();
  const origErr = console.error;
  console.error = () => {};
  try {
    const result = await routes.loadOldestPendingPaymentClaim(1);
    assert.strictEqual(result, null,
      'dashboard render must never be blocked by a payment-claim lookup failure');
  } finally {
    console.error = origErr;
    dbStubThrows = false;
  }
});

test('loadOldestPendingPaymentClaim: returns null when db method missing (legacy stub)', async () => {
  dbStubMethodPresent = false;
  const routes = installDbStub();
  const result = await routes.loadOldestPendingPaymentClaim(1);
  assert.strictEqual(result, null);
  dbStubMethodPresent = true;
});

// ---- Layer 3: buildPaymentClaimPrompt shape contract --------------------

test('buildPaymentClaimPrompt: returns null when user missing', () => {
  const routes = installDbStub();
  assert.strictEqual(
    routes.buildPaymentClaimPrompt(null, { id: 1, payment_claimed_at: new Date().toISOString() }),
    null
  );
});

test('buildPaymentClaimPrompt: returns null when invoice missing', () => {
  const routes = installDbStub();
  assert.strictEqual(routes.buildPaymentClaimPrompt({ id: 1 }, null), null);
});

test('buildPaymentClaimPrompt: returns null when invoice has no id', () => {
  const routes = installDbStub();
  assert.strictEqual(
    routes.buildPaymentClaimPrompt({ id: 1 }, { invoice_number: 'X', payment_claimed_at: new Date().toISOString() }),
    null
  );
});

test('buildPaymentClaimPrompt: returns null when payment_claimed_at missing', () => {
  const routes = installDbStub();
  assert.strictEqual(
    routes.buildPaymentClaimPrompt({ id: 1 }, { id: 17, payment_claimed_at: null }),
    null
  );
});

test('buildPaymentClaimPrompt: returns null when payment_claimed_at unparseable', () => {
  const routes = installDbStub();
  assert.strictEqual(
    routes.buildPaymentClaimPrompt({ id: 1 }, { id: 17, payment_claimed_at: 'not-a-date' }),
    null
  );
});

test('buildPaymentClaimPrompt: returns null when invoice is already paid (defence-in-depth)', () => {
  const routes = installDbStub();
  const out = routes.buildPaymentClaimPrompt(
    { id: 1 },
    { id: 17, payment_claimed_at: new Date().toISOString(), status: 'paid' }
  );
  assert.strictEqual(out, null,
    'paid invoice never surfaces the confirm-paid banner — SQL filters this but defence-in-depth at the builder');
});

test('buildPaymentClaimPrompt: happy-path shape (id, invoiceNumber, clientName, total, method, methodLabel, status)', () => {
  const routes = installDbStub();
  const fourHoursAgo = new Date(Date.now() - 4 * 3600000);
  const out = routes.buildPaymentClaimPrompt(
    { id: 1 },
    {
      id: 77, invoice_number: 'INV-2026-0077', client_name: 'Pending Co.',
      total: '1250.00', status: 'sent',
      payment_claimed_at: fourHoursAgo.toISOString(),
      payment_claim_method: 'venmo',
      payment_claim_reference: '@payer-handle',
      payment_claim_note: 'Sent earlier today'
    }
  );
  assert.strictEqual(out.id, 77);
  assert.strictEqual(out.invoiceNumber, 'INV-2026-0077');
  assert.strictEqual(out.clientName, 'Pending Co.');
  assert.strictEqual(out.total, 1250);
  assert.strictEqual(out.method, 'venmo');
  assert.strictEqual(out.methodLabel, 'Venmo');
  assert.strictEqual(out.reference, '@payer-handle');
  assert.strictEqual(out.note, 'Sent earlier today');
  assert.strictEqual(out.status, 'sent');
});

test('buildPaymentClaimPrompt: method whitelist labels (cash/check/venmo/zelle/bank_transfer/paypal)', () => {
  const routes = installDbStub();
  const claimedAt = new Date(Date.now() - 3600000).toISOString();
  const expected = {
    cash: 'Cash',
    check: 'Cheque',
    venmo: 'Venmo',
    zelle: 'Zelle',
    bank_transfer: 'Bank transfer',
    paypal: 'PayPal'
  };
  Object.entries(expected).forEach(([method, label]) => {
    const out = routes.buildPaymentClaimPrompt(
      { id: 1 },
      { id: 1, payment_claimed_at: claimedAt, payment_claim_method: method }
    );
    assert.strictEqual(out.method, method, `method=${method} preserved`);
    assert.strictEqual(out.methodLabel, label, `label for ${method} is "${label}"`);
  });
});

test('buildPaymentClaimPrompt: off-whitelist method coerces to "other"', () => {
  const routes = installDbStub();
  const out = routes.buildPaymentClaimPrompt(
    { id: 1 },
    { id: 1, payment_claimed_at: new Date().toISOString(), payment_claim_method: 'crypto' }
  );
  assert.strictEqual(out.method, 'other', 'unrecognized methods coerce to other');
  assert.strictEqual(out.methodLabel, 'Other');
});

test('buildPaymentClaimPrompt: null/empty method coerces to "other"', () => {
  const routes = installDbStub();
  const out = routes.buildPaymentClaimPrompt(
    { id: 1 },
    { id: 1, payment_claimed_at: new Date().toISOString(), payment_claim_method: null }
  );
  assert.strictEqual(out.method, 'other');
  assert.strictEqual(out.methodLabel, 'Other');
});

test('buildPaymentClaimPrompt: method comparison is case-insensitive (defence against legacy rows)', () => {
  const routes = installDbStub();
  const out = routes.buildPaymentClaimPrompt(
    { id: 1 },
    { id: 1, payment_claimed_at: new Date().toISOString(), payment_claim_method: 'Venmo' }
  );
  assert.strictEqual(out.method, 'venmo');
  assert.strictEqual(out.methodLabel, 'Venmo');
});

test('buildPaymentClaimPrompt: empty/whitespace reference becomes null', () => {
  const routes = installDbStub();
  const out = routes.buildPaymentClaimPrompt(
    { id: 1 },
    { id: 1, payment_claimed_at: new Date().toISOString(), payment_claim_method: 'venmo',
      payment_claim_reference: '   ' }
  );
  assert.strictEqual(out.reference, null,
    'whitespace-only reference becomes null so view skips the "ref:" surface');
});

test('buildPaymentClaimPrompt: empty/whitespace note becomes null', () => {
  const routes = installDbStub();
  const out = routes.buildPaymentClaimPrompt(
    { id: 1 },
    { id: 1, payment_claimed_at: new Date().toISOString(), payment_claim_method: 'venmo',
      payment_claim_note: '\n\n  ' }
  );
  assert.strictEqual(out.note, null);
});

test('buildPaymentClaimPrompt: non-string reference/note safely become null', () => {
  const routes = installDbStub();
  const out = routes.buildPaymentClaimPrompt(
    { id: 1 },
    { id: 1, payment_claimed_at: new Date().toISOString(), payment_claim_method: 'venmo',
      payment_claim_reference: 12345, payment_claim_note: { x: 1 } }
  );
  assert.strictEqual(out.reference, null);
  assert.strictEqual(out.note, null);
});

test('buildPaymentClaimPrompt: daysAgo and hoursAgo computed from payment_claimed_at', () => {
  const routes = installDbStub();
  const threeDaysAgo = new Date(Date.now() - 3 * 86400000);
  const out = routes.buildPaymentClaimPrompt(
    { id: 1 },
    { id: 1, payment_claimed_at: threeDaysAgo.toISOString(), payment_claim_method: 'venmo' }
  );
  assert.strictEqual(out.daysAgo, 3);
  assert.strictEqual(out.hoursAgo, 72);
});

test('buildPaymentClaimPrompt: fresh claim (minutes ago) → hoursAgo=0 daysAgo=0', () => {
  const routes = installDbStub();
  const fiveMinAgo = new Date(Date.now() - 5 * 60000);
  const out = routes.buildPaymentClaimPrompt(
    { id: 1 },
    { id: 1, payment_claimed_at: fiveMinAgo.toISOString(), payment_claim_method: 'venmo' }
  );
  assert.strictEqual(out.hoursAgo, 0, 'sub-hour claims are still surfaced (hoursAgo=0)');
  assert.strictEqual(out.daysAgo, 0);
});

test('buildPaymentClaimPrompt: stringy total parses to Number', () => {
  const routes = installDbStub();
  const out = routes.buildPaymentClaimPrompt(
    { id: 1 },
    { id: 1, payment_claimed_at: new Date().toISOString(), payment_claim_method: 'venmo', total: '799.99' }
  );
  assert.strictEqual(out.total, 799.99);
});

test('buildPaymentClaimPrompt: empty client_name passes through as empty string', () => {
  const routes = installDbStub();
  const out = routes.buildPaymentClaimPrompt(
    { id: 1 },
    { id: 1, payment_claimed_at: new Date().toISOString(), payment_claim_method: 'venmo', client_name: '' }
  );
  assert.strictEqual(out.clientName, '', 'view layer handles the empty-name fallback copy');
});

// ---- Layer 4: cross-prompt suppression ----------------------------------

test('suppression: buildClientViewedFollowupPrompt is suppressed when payment-claim targets the SAME invoice id', () => {
  const routes = installDbStub();
  const out = routes.buildClientViewedFollowupPrompt(
    { id: 1 },
    { id: 88, first_viewed_at: new Date(Date.now() - 3 * 86400000).toISOString(),
      invoice_number: 'X', client_name: 'A', total: 100, view_count: 1, status: 'sent' },
    { paymentClaimPrompt: { id: 88 } }
  );
  assert.strictEqual(out, null,
    'avoid double-banner: payment-claim is more action-specific (client already said paid)');
});

test('suppression: buildClientViewedFollowupPrompt still fires on a DIFFERENT invoice id', () => {
  const routes = installDbStub();
  const out = routes.buildClientViewedFollowupPrompt(
    { id: 1 },
    { id: 88, first_viewed_at: new Date(Date.now() - 3 * 86400000).toISOString(),
      invoice_number: 'X', client_name: 'A', total: 100, view_count: 1, status: 'sent' },
    { paymentClaimPrompt: { id: 5 } }
  );
  assert.ok(out, 'distinct invoices: client-viewed-followup still fires');
  assert.strictEqual(out.id, 88);
});

test('suppression: buildClientViewedFollowupPrompt id comparison is string-safe (numeric vs stringy)', () => {
  const routes = installDbStub();
  const out = routes.buildClientViewedFollowupPrompt(
    { id: 1 },
    { id: 88, first_viewed_at: new Date(Date.now() - 3 * 86400000).toISOString(),
      invoice_number: 'X', client_name: 'A', total: 100, view_count: 1, status: 'sent' },
    { paymentClaimPrompt: { id: '88' } }
  );
  assert.strictEqual(out, null,
    '"88" === 88 — string-safe collision check');
});

test('suppression: buildClientViewedFollowupPrompt missing otherPrompts does not throw', () => {
  const routes = installDbStub();
  // Backward-compat: existing callers may still pass only (user, invoice).
  const out = routes.buildClientViewedFollowupPrompt(
    { id: 1 },
    { id: 88, first_viewed_at: new Date(Date.now() - 3 * 86400000).toISOString(),
      invoice_number: 'X', client_name: 'A', total: 100, view_count: 1, status: 'sent' }
  );
  assert.ok(out, 'no other-prompts param: client-viewed-followup still fires');
  assert.strictEqual(out.id, 88);
});

test('suppression: buildOverduePrompt is suppressed when payment-claim targets the SAME invoice id', () => {
  const routes = installDbStub();
  const threeDaysAgo = new Date(Date.now() - 3 * 86400000);
  const out = routes.buildOverduePrompt(
    { id: 1 },
    { id: 88, due_date: threeDaysAgo.toISOString(), client_name: 'A', total: 100 },
    { paymentClaimPrompt: { id: 88 } }
  );
  assert.strictEqual(out, null,
    'avoid double-banner: payment-claim is more action-specific than overdue');
});

test('suppression: buildOverduePrompt still fires when payment-claim targets a DIFFERENT id', () => {
  const routes = installDbStub();
  const threeDaysAgo = new Date(Date.now() - 3 * 86400000);
  const out = routes.buildOverduePrompt(
    { id: 1 },
    { id: 88, due_date: threeDaysAgo.toISOString(), client_name: 'A', total: 100 },
    { paymentClaimPrompt: { id: 5 } }
  );
  assert.ok(out, 'distinct invoices: overdue still fires');
  assert.strictEqual(out.id, 88);
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
    paymentClaimPrompt: null,
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

test('view: banner is OMITTED when paymentClaimPrompt is null', () => {
  const html = renderDashboard({ paymentClaimPrompt: null });
  assert.doesNotMatch(html, /data-testid="payment-claim-prompt"/);
});

test('view: banner RENDERS when prompt is set', () => {
  const html = renderDashboard({
    paymentClaimPrompt: {
      id: 77, invoiceNumber: 'INV-2026-0077', clientName: 'Pending Co.',
      total: 1250, method: 'venmo', methodLabel: 'Venmo',
      reference: '@payer-handle', note: 'Sent earlier today',
      hoursAgo: 4, daysAgo: 0, status: 'sent'
    }
  });
  assert.match(html, /data-testid="payment-claim-prompt"/);
});

test('view: banner shows client name, invoice number, total, methodLabel, reference, note', () => {
  const html = renderDashboard({
    paymentClaimPrompt: {
      id: 77, invoiceNumber: 'INV-2026-0077', clientName: 'Pending Co.',
      total: 1250, method: 'venmo', methodLabel: 'Venmo',
      reference: '@payer-handle', note: 'Sent earlier today',
      hoursAgo: 4, daysAgo: 0, status: 'sent'
    }
  });
  assert.match(html, /Pending Co\./, 'client name visible');
  assert.match(html, /INV-2026-0077/, 'invoice number visible');
  assert.match(html, /\$<span[^>]*>1250\.00<\/span>/, 'total formatted to 2 decimals');
  assert.match(html, /<strong[^>]*data-testid="payment-claim-method-label"[^>]*>Venmo<\/strong>/, 'method label rendered');
  assert.match(html, /data-testid="payment-claim-reference"[^>]*>@payer-handle</, 'reference rendered');
  assert.match(html, /data-testid="payment-claim-note"[^>]*>Sent earlier today</, 'note rendered');
});

test('view: copy includes "sent payment" framing (distinct from view / share / overdue cohorts)', () => {
  const html = renderDashboard({
    paymentClaimPrompt: {
      id: 77, invoiceNumber: 'X', clientName: 'A', total: 100,
      method: 'venmo', methodLabel: 'Venmo', reference: null, note: null,
      hoursAgo: 4, daysAgo: 0, status: 'sent'
    }
  });
  assert.match(html, /says they sent payment/i,
    'payment-claim framing must say "sent payment" — distinguishes from "opened" / "past due" / "zero opens"');
});

test('view: empty client name falls back to "Your client says they sent payment"', () => {
  const html = renderDashboard({
    paymentClaimPrompt: {
      id: 77, invoiceNumber: 'X', clientName: '', total: 100,
      method: 'venmo', methodLabel: 'Venmo', reference: null, note: null,
      hoursAgo: 4, daysAgo: 0, status: 'sent'
    }
  });
  assert.match(html, /Your client says they sent payment/);
});

test('view: Mark-as-Paid form POSTs to /invoices/:id/status with status=paid + CSRF', () => {
  const html = renderDashboard({
    paymentClaimPrompt: {
      id: 77, invoiceNumber: 'X', clientName: 'A', total: 100,
      method: 'venmo', methodLabel: 'Venmo', reference: null, note: null,
      hoursAgo: 4, daysAgo: 0, status: 'sent'
    }
  });
  const formMatch = html.match(
    /<form\s+action="\/invoices\/77\/status"\s+method="POST"[^>]*>[\s\S]*?data-testid="payment-claim-mark-paid"/
  );
  assert.ok(formMatch, 'mark-as-paid form must POST to /invoices/77/status');
  assert.match(formMatch[0], /name="_csrf"\s+value="TEST_CSRF"/, 'CSRF token wired');
  assert.match(formMatch[0], /name="status"\s+value="paid"/, 'status=paid hidden field');
});

test('view: Open-invoice secondary CTA deep-links to /invoices/:id', () => {
  const html = renderDashboard({
    paymentClaimPrompt: {
      id: 77, invoiceNumber: 'X', clientName: 'A', total: 100,
      method: 'venmo', methodLabel: 'Venmo', reference: null, note: null,
      hoursAgo: 4, daysAgo: 0, status: 'sent'
    }
  });
  assert.match(html, /href="\/invoices\/77"[^>]*data-testid="payment-claim-open-invoice"/);
});

test('view: omits reference surface when reference is null', () => {
  const html = renderDashboard({
    paymentClaimPrompt: {
      id: 77, invoiceNumber: 'INV-X', clientName: 'A', total: 100,
      method: 'cash', methodLabel: 'Cash', reference: null, note: null,
      hoursAgo: 4, daysAgo: 0, status: 'sent'
    }
  });
  assert.doesNotMatch(html, /payment-claim-reference/,
    'null reference must not render the reference surface');
});

test('view: omits note surface when note is null', () => {
  const html = renderDashboard({
    paymentClaimPrompt: {
      id: 77, invoiceNumber: 'INV-X', clientName: 'A', total: 100,
      method: 'cash', methodLabel: 'Cash', reference: null, note: null,
      hoursAgo: 4, daysAgo: 0, status: 'sent'
    }
  });
  assert.doesNotMatch(html, /payment-claim-note-line/,
    'null note must not render the note line');
});

test('view: hostile client_name + reference + note are HTML-escaped (XSS guard)', () => {
  const html = renderDashboard({
    paymentClaimPrompt: {
      id: 77, invoiceNumber: 'INV-X', clientName: '<script>alert(1)</script>',
      total: 100, method: 'other', methodLabel: 'Other',
      reference: '"><img src=x onerror=alert(2)>',
      note: '<svg/onload=alert(3)>',
      hoursAgo: 4, daysAgo: 0, status: 'sent'
    }
  });
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/,
    'raw script in client_name must NOT appear');
  assert.doesNotMatch(html, /<img src=x onerror=/,
    'raw <img> tag in reference must NOT appear — angle brackets escaped');
  assert.doesNotMatch(html, /<svg\/onload=alert\(3\)>/,
    'raw svg/onload in note must NOT appear');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/,
    'escaped script form must appear in rendered HTML');
  assert.match(html, /&lt;img src=x onerror=alert\(2\)&gt;/,
    'escaped img form must appear in rendered HTML');
});

test('view: banner sits ABOVE the client-viewed-followup prompt (positional contract)', () => {
  // The payment-claim is the most action-specific cohort (client already
  // claimed they paid). One click closes the loop. Must surface first.
  const html = renderDashboard({
    paymentClaimPrompt: {
      id: 77, invoiceNumber: 'INV-A', clientName: 'A', total: 100,
      method: 'venmo', methodLabel: 'Venmo', reference: null, note: null,
      hoursAgo: 4, daysAgo: 0, status: 'sent'
    },
    clientViewedFollowupPrompt: {
      id: 88, invoiceNumber: 'INV-B', clientName: 'B', total: 200,
      daysAgo: 3, hoursAgo: 72, viewCount: 2, status: 'sent'
    }
  });
  const claimIdx = html.indexOf('data-testid="payment-claim-prompt"');
  const viewedIdx = html.indexOf('data-testid="client-viewed-followup-prompt"');
  assert.ok(claimIdx !== -1 && viewedIdx !== -1, 'both banners present');
  assert.ok(claimIdx < viewedIdx,
    'payment-claim must render BEFORE client-viewed-followup (highest action priority)');
});

test('view: banner sits ABOVE the overdue prompt (positional contract)', () => {
  const html = renderDashboard({
    paymentClaimPrompt: {
      id: 77, invoiceNumber: 'INV-A', clientName: 'A', total: 100,
      method: 'venmo', methodLabel: 'Venmo', reference: null, note: null,
      hoursAgo: 4, daysAgo: 0, status: 'sent'
    },
    overduePrompt: {
      id: 88, invoiceNumber: 'INV-B', clientName: 'B', total: 200,
      daysPastDue: 7, status: 'overdue'
    }
  });
  const claimIdx = html.indexOf('data-testid="payment-claim-prompt"');
  const overdueIdx = html.indexOf('data-testid="overdue-prompt"');
  assert.ok(claimIdx !== -1 && overdueIdx !== -1, 'both banners present');
  assert.ok(claimIdx < overdueIdx,
    'payment-claim must render BEFORE overdue (highest action priority)');
});

test('view: data attributes expose invoice-id, claim method, and hours-ago for hooks', () => {
  const html = renderDashboard({
    paymentClaimPrompt: {
      id: 77, invoiceNumber: 'INV-X', clientName: 'A', total: 100,
      method: 'zelle', methodLabel: 'Zelle', reference: null, note: null,
      hoursAgo: 6, daysAgo: 0, status: 'sent'
    }
  });
  assert.match(html, /data-invoice-id="77"/);
  assert.match(html, /data-claim-method="zelle"/);
  assert.match(html, /data-hours-ago="6"/);
});

test('view: banner print:hidden (printed invoice artifact stays clean)', () => {
  const html = renderDashboard({
    paymentClaimPrompt: {
      id: 77, invoiceNumber: 'INV-X', clientName: 'A', total: 100,
      method: 'cash', methodLabel: 'Cash', reference: null, note: null,
      hoursAgo: 4, daysAgo: 0, status: 'sent'
    }
  });
  const blockMatch = html.match(/data-testid="payment-claim-prompt"[\s\S]{0,400}/);
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
  console.log(`\n${passed} passed, ${failed} failed (payment-claim-prompt.test.js)`);
  if (failed > 0) process.exit(1);
})();
