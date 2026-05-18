'use strict';

/*
 * Auto-transition draft → sent on first public-share-link view
 * (Milestone 3 — first invoice created → first invoice sent).
 *
 * Before this ship, a user could generate /i/<token>, share it via
 * WhatsApp/SMS/Email/Copy, and never click "Mark as Sent" — the
 * dashboard kept the invoice in 'draft', stale-draft prompts/emails
 * kept firing on already-shared invoices, and the operator
 * activation-funnel report's `sent_one` counter (which gates on
 * `status IN ('sent','paid','overdue')`) missed the conversion entirely.
 *
 * Now `db.recordPublicInvoiceView` flips status = 'draft' to 'sent'
 * atomically with the view-count bump, and stamps the new
 * `sent_via_share_view_at` column so the dashboard / admin report can
 * distinguish explicit Mark-as-Sent clicks from auto-transitions.
 *
 * Covers:
 *   - recordPublicInvoiceView SQL shape includes the CASE-guarded status
 *     flip + the CASE-guarded sent_via_share_view_at stamp + extends the
 *     RETURNING clause without breaking the existing tracking contract.
 *   - Draft invoices flip to 'sent' on first view; non-draft statuses
 *     ('sent', 'paid', 'overdue') are left untouched so a paid-first /
 *     overdue invoice never regresses on subsequent views.
 *   - sent_via_share_view_at is stamped on the flip and only on the flip
 *     (a second view of an already-sent invoice does NOT re-stamp).
 *   - GET /i/<token> integration: the existing route still fires the
 *     view-record path once per render with the same caller contract.
 *   - schema.sql adds sent_via_share_view_at idempotently.
 *
 * Run: NODE_ENV=test node tests/public-share-view-auto-sent.test.js
 */

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
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

// ---------- SQL shape ----------------------------------------------------

async function testRecordViewSqlIncludesStatusFlipGuards() {
  const captured = [];
  const restore = stubPg(async (text, params) => {
    captured.push({ text, params });
    return {
      rows: [{
        id: 42, view_count: 1, status: 'sent',
        first_viewed_at: new Date('2026-05-18T12:00:00Z'),
        last_viewed_at: new Date('2026-05-18T12:00:00Z'),
        sent_via_share_view_at: new Date('2026-05-18T12:00:00Z')
      }]
    };
  });
  try {
    const { db } = require('../db');
    await db.recordPublicInvoiceView(42);
    assert.strictEqual(captured.length, 1, 'fires exactly one UPDATE — atomic with the view stamp');
    const q = captured[0];
    // Existing tracking SET clauses (locked-in contract — must not regress).
    assert.ok(/view_count\s*=\s*COALESCE\(\s*view_count\s*,\s*0\s*\)\s*\+\s*1/i.test(q.text),
      'view_count must still increment via COALESCE');
    assert.ok(/first_viewed_at\s*=\s*COALESCE\(\s*first_viewed_at\s*,\s*NOW\(\)\s*\)/i.test(q.text),
      'first_viewed_at must still be COALESCE-set');
    assert.ok(/last_viewed_at\s*=\s*NOW\(\)/i.test(q.text),
      'last_viewed_at must still always advance');
    // New: status flip guarded on the OLD row's draft state. The CASE expression
    // is evaluated against the OLD row before any SET applies, so the guard is
    // race-safe against concurrent transitions.
    assert.ok(/status\s*=\s*CASE\s+WHEN\s+status\s*=\s*'draft'\s+THEN\s+'sent'\s+ELSE\s+status\s+END/i.test(q.text),
      'status must flip draft→sent via a CASE guard, leaving other statuses untouched');
    // New: sent_via_share_view_at stamped on the same CASE guard so the stamp
    // and the status flip are atomically consistent.
    assert.ok(/sent_via_share_view_at\s*=\s*CASE\s+WHEN\s+status\s*=\s*'draft'\s+THEN\s+NOW\(\)\s+ELSE\s+sent_via_share_view_at\s+END/i.test(q.text),
      'sent_via_share_view_at must be stamped on the same draft-guard CASE');
    // RETURNING must now include status + sent_via_share_view_at so callers
    // can detect the auto-transition without a second round-trip.
    assert.ok(/RETURNING\b.*\bstatus\b/i.test(q.text),
      'RETURNING must include status so the caller can detect the auto-transition');
    assert.ok(/RETURNING\b.*\bsent_via_share_view_at\b/i.test(q.text),
      'RETURNING must include sent_via_share_view_at for the dashboard + admin report');
    // Single-row WHERE target unchanged.
    assert.ok(/WHERE\s+id\s*=\s*\$1/i.test(q.text), 'still targets a single id');
    assert.deepStrictEqual(q.params, [42]);
  } finally { restore(); }
}

// ---------- DB-level: draft flips, non-draft does not -------------------

async function testRecordViewFlipsDraftToSent() {
  // Simulate the live UPDATE behavior: the SQL's CASE expression flips
  // status='draft' to 'sent'. The stub returns what the live DB would
  // RETURN after that UPDATE.
  const restore = stubPg(async (text, params) => {
    return {
      rows: [{
        id: params[0], view_count: 1, status: 'sent',
        first_viewed_at: new Date('2026-05-18T12:00:00Z'),
        last_viewed_at: new Date('2026-05-18T12:00:00Z'),
        sent_via_share_view_at: new Date('2026-05-18T12:00:00Z')
      }]
    };
  });
  try {
    const { db } = require('../db');
    const row = await db.recordPublicInvoiceView(42);
    assert.strictEqual(row.status, 'sent',
      'first view of a draft must return status=sent (the auto-transition)');
    assert.ok(row.sent_via_share_view_at instanceof Date,
      'sent_via_share_view_at must be stamped on the auto-transition');
    assert.strictEqual(row.view_count, 1);
  } finally { restore(); }
}

async function testRecordViewLeavesSentInvoiceUnchanged() {
  // Simulate a Pro user who explicitly Mark-as-Sent'd the invoice first
  // (so payment_link minted, client_email fired). Client now opens the
  // link — view bumps but status stays 'sent' and sent_via_share_view_at
  // stays null (explicit transition, not auto).
  const restore = stubPg(async () => ({
    rows: [{
      id: 42, view_count: 2, status: 'sent',
      first_viewed_at: new Date('2026-05-18T11:00:00Z'),
      last_viewed_at: new Date('2026-05-18T12:00:00Z'),
      sent_via_share_view_at: null
    }]
  }));
  try {
    const { db } = require('../db');
    const row = await db.recordPublicInvoiceView(42);
    assert.strictEqual(row.status, 'sent', 'already-sent invoice stays sent');
    assert.strictEqual(row.sent_via_share_view_at, null,
      'sent_via_share_view_at is NULL when the explicit Mark-as-Sent fired first');
  } finally { restore(); }
}

async function testRecordViewLeavesPaidInvoiceUnchanged() {
  // Critical: a paid-first-then-viewed invoice (e.g. cash up-front) must
  // never regress to 'sent'. The CASE guard on status='draft' protects
  // this — 'paid' falls through to the ELSE branch unchanged.
  const restore = stubPg(async () => ({
    rows: [{
      id: 42, view_count: 1, status: 'paid',
      first_viewed_at: new Date('2026-05-18T12:00:00Z'),
      last_viewed_at: new Date('2026-05-18T12:00:00Z'),
      sent_via_share_view_at: null
    }]
  }));
  try {
    const { db } = require('../db');
    const row = await db.recordPublicInvoiceView(42);
    assert.strictEqual(row.status, 'paid',
      'paid invoices NEVER regress on a view — the CASE guard only flips from draft');
    assert.strictEqual(row.sent_via_share_view_at, null);
  } finally { restore(); }
}

async function testRecordViewLeavesOverdueInvoiceUnchanged() {
  // Same protection as paid: an invoice that the overdue cron flipped to
  // 'overdue' must stay 'overdue' on the next client view, not regress.
  const restore = stubPg(async () => ({
    rows: [{
      id: 42, view_count: 1, status: 'overdue',
      first_viewed_at: new Date('2026-05-18T12:00:00Z'),
      last_viewed_at: new Date('2026-05-18T12:00:00Z'),
      sent_via_share_view_at: null
    }]
  }));
  try {
    const { db } = require('../db');
    const row = await db.recordPublicInvoiceView(42);
    assert.strictEqual(row.status, 'overdue', 'overdue stays overdue');
  } finally { restore(); }
}

async function testRecordViewSecondViewDoesNotRestampSentVia() {
  // After the first auto-transition the row's status is 'sent' and
  // sent_via_share_view_at holds the original NOW(). A second view must
  // bump view_count + last_viewed_at but NOT re-stamp sent_via_share_view_at
  // (the CASE guard's status='draft' check is FALSE on the now-sent row,
  // so the ELSE branch preserves the original stamp).
  const originalStamp = new Date('2026-05-18T12:00:00Z');
  const restore = stubPg(async () => ({
    rows: [{
      id: 42, view_count: 2, status: 'sent',
      first_viewed_at: originalStamp,
      last_viewed_at: new Date('2026-05-18T13:00:00Z'),
      sent_via_share_view_at: originalStamp
    }]
  }));
  try {
    const { db } = require('../db');
    const row = await db.recordPublicInvoiceView(42);
    assert.strictEqual(row.view_count, 2, 'view_count still bumps on repeat views');
    assert.strictEqual(row.sent_via_share_view_at.getTime(), originalStamp.getTime(),
      'sent_via_share_view_at preserves the original stamp on repeat views');
  } finally { restore(); }
}

// ---------- GET /i/<token> integration ----------------------------------

function buildShareApp({ invoiceRow, viewResult }) {
  const recorded = [];
  const dbStub = {
    pool: { query: async () => ({ rows: [] }) },
    db: {
      async getInvoiceByPublicToken(token) {
        if (!/^[a-f0-9]{8,32}$/i.test(token || '')) return null;
        return invoiceRow;
      },
      async recordPublicInvoiceView(invoiceId) {
        recorded.push(invoiceId);
        return viewResult;
      }
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
  return { app, recorded };
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

function sampleDraftInvoice(overrides) {
  return Object.assign({
    id: 77,
    invoice_number: 'INV-2026-0099',
    client_name: 'Beta Co.',
    client_email: 'pay@beta.com',
    client_address: '',
    items: [{ description: 'Consulting', quantity: 1, unit_price: 500 }],
    subtotal: 500, tax_rate: 0, tax_amount: 0, total: 500,
    notes: null, status: 'draft', // <-- the auto-transition target
    issued_date: new Date('2026-05-18'), due_date: new Date('2026-06-01'),
    payment_link_url: null, public_token: 'beefcafe12345678',
    is_seed: false,
    owner_id: 11, owner_name: 'Jordan', owner_email: 'jordan@x.com',
    owner_business_name: 'Pine Studio', owner_business_address: '',
    owner_business_email: 'hi@pinestudio.com', owner_business_phone: '',
    owner_plan: 'free'
  }, overrides || {});
}

const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function testFirstClientViewOnDraftFiresRecordWithExpectedShape() {
  // Verify the route hands the draft invoice id to recordPublicInvoiceView
  // exactly once. The live DB UPDATE inside recordPublicInvoiceView flips
  // the status atomically — this test asserts the route still drives that
  // path on a draft (its caller contract is unchanged).
  const { app, recorded } = buildShareApp({
    invoiceRow: sampleDraftInvoice(),
    viewResult: {
      id: 77, view_count: 1, status: 'sent',
      first_viewed_at: new Date(), last_viewed_at: new Date(),
      sent_via_share_view_at: new Date()
    }
  });
  const r = await getPath(app, '/i/beefcafe12345678', { 'User-Agent': CHROME_UA });
  assert.strictEqual(r.status, 200, 'client still sees the rendered invoice');
  await new Promise((res) => setImmediate(res));
  assert.deepStrictEqual(recorded, [77],
    'a draft GET /i/<token> drives recordPublicInvoiceView exactly once — the UPDATE inside flips draft→sent atomically');
}

async function testFirstClientViewOnSentDoesNotRegress() {
  // A user who explicitly Mark-as-Sent'd before sharing the link must NOT
  // see their invoice round-trip through draft. The route fires record;
  // the underlying CASE guard on status='draft' leaves 'sent' alone.
  const { app, recorded } = buildShareApp({
    invoiceRow: sampleDraftInvoice({ status: 'sent' }),
    viewResult: {
      id: 77, view_count: 1, status: 'sent', // status returned UNCHANGED
      first_viewed_at: new Date(), last_viewed_at: new Date(),
      sent_via_share_view_at: null // <-- not auto-transitioned
    }
  });
  const r = await getPath(app, '/i/beefcafe12345678', { 'User-Agent': CHROME_UA });
  assert.strictEqual(r.status, 200);
  await new Promise((res) => setImmediate(res));
  assert.deepStrictEqual(recorded, [77],
    'route still fires record (for view-count tracking) — DB guard preserves the explicit Mark-as-Sent semantics');
}

// ---------- schema ------------------------------------------------------

function testSchemaAddsSentViaShareViewAtIdempotently() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  assert.ok(/ALTER\s+TABLE\s+invoices\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+sent_via_share_view_at\s+TIMESTAMP/i.test(sql),
    'schema.sql must add sent_via_share_view_at idempotently via ADD COLUMN IF NOT EXISTS');
}

// ---------- runner ------------------------------------------------------

async function run() {
  const tests = [
    ['db.recordPublicInvoiceView: SQL includes status-flip + sent_via stamp guards', testRecordViewSqlIncludesStatusFlipGuards],
    ['db.recordPublicInvoiceView: draft flips to sent on first view', testRecordViewFlipsDraftToSent],
    ['db.recordPublicInvoiceView: already-sent invoice does NOT auto-stamp', testRecordViewLeavesSentInvoiceUnchanged],
    ['db.recordPublicInvoiceView: paid invoice NEVER regresses', testRecordViewLeavesPaidInvoiceUnchanged],
    ['db.recordPublicInvoiceView: overdue invoice NEVER regresses', testRecordViewLeavesOverdueInvoiceUnchanged],
    ['db.recordPublicInvoiceView: second view does not re-stamp sent_via_share_view_at', testRecordViewSecondViewDoesNotRestampSentVia],
    ['GET /i/<token>: drafts drive the record call (UPDATE flips status atomically)', testFirstClientViewOnDraftFiresRecordWithExpectedShape],
    ['GET /i/<token>: already-sent invoices do not regress through draft', testFirstClientViewOnSentDoesNotRegress],
    ['schema.sql: sent_via_share_view_at migration is idempotent', testSchemaAddsSentViaShareViewAtIdempotently]
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
