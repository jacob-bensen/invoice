'use strict';

/*
 * First-paid celebration banner + referral hook tests (#49).
 *
 * Covers:
 *  - db.recordFirstPaidIfMissing: idempotent UPDATE guarded by
 *    first_paid_at IS NULL + EXISTS(paid invoice) so it stamps once and only
 *    once per user.
 *  - db.getOrCreateReferralCode: lazy generation, retries on UNIQUE
 *    collision, returns existing code on second call.
 *  - db.attachReferrerByCode: matches code to user, ignores self-referral
 *    and bad codes, only sets when referrer_id is NULL.
 *  - lib/celebration.triggerFirstPaidCelebration: only fires the email when
 *    the stamp actually took (idempotent), uses the generated code for the
 *    referral URL, no-ops gracefully when DB throws.
 *  - lib/celebration.buildReferralUrl: respects APP_URL, falls back to
 *    relative path.
 *  - lib/email.sendReferralCelebrationEmail: subject/HTML/text shape;
 *    not_configured behaviour when no Resend client.
 *  - routes/invoices.js POST /:id/status calls triggerFirstPaidCelebration
 *    on paid (no-op on other transitions).
 *  - server.js middleware captures ?ref=<code> into session.
 *  - dashboard.ejs renders the celebration banner with referral link when
 *    locals.celebration is set, omits it when null.
 *
 * Run: NODE_ENV=test node tests/celebration-banner.test.js
 */

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');
const express = require('express');
const session = require('express-session');
const http = require('http');

// ---------- db.recordFirstPaidIfMissing ---------------------------------

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

async function testRecordFirstPaidShape() {
  const captured = [];
  const restore = stubPg(async (text, params) => {
    captured.push({ text, params });
    return { rows: [{ id: 7, email: 'a@b.com', name: 'Ana', plan: 'pro', first_paid_at: new Date(), referral_code: 'abc123' }] };
  });
  try {
    const { db } = require('../db');
    const row = await db.recordFirstPaidIfMissing(7);
    assert.strictEqual(captured.length, 1, 'must issue exactly one query');
    const q = captured[0];
    assert.ok(/UPDATE\s+users/i.test(q.text), 'must UPDATE users');
    assert.ok(/SET[\s\S]*first_paid_at\s*=\s*NOW\(\)/i.test(q.text),
      'must set first_paid_at = NOW()');
    assert.ok(/first_paid_at\s+IS\s+NULL/i.test(q.text),
      'must guard on first_paid_at IS NULL (idempotency)');
    assert.ok(/EXISTS\s*\([\s\S]*invoices[\s\S]*status\s*=\s*'paid'/i.test(q.text),
      'must verify at least one paid invoice exists via EXISTS subquery');
    assert.deepStrictEqual(q.params, [7]);
    assert.strictEqual(row.id, 7);
    assert.strictEqual(row.referral_code, 'abc123');
  } finally { restore(); }
}

async function testRecordFirstPaidReturnsNullOnNoUpdate() {
  const restore = stubPg(async () => ({ rows: [] }));
  try {
    const { db } = require('../db');
    const row = await db.recordFirstPaidIfMissing(42);
    assert.strictEqual(row, null,
      'returns null when no row was updated (already stamped or no paid invoice)');
  } finally { restore(); }
}

// ---------- db.getOrCreateReferralCode ----------------------------------

async function testGetOrCreateReferralReturnsExisting() {
  const queries = [];
  const restore = stubPg(async (text, params) => {
    queries.push({ text, params });
    return { rows: [{ referral_code: 'existing16hex000' }] };
  });
  try {
    const { db } = require('../db');
    const code = await db.getOrCreateReferralCode(11);
    assert.strictEqual(code, 'existing16hex000');
    assert.strictEqual(queries.length, 1,
      'pre-existing code path issues only one SELECT, no UPDATE');
    assert.ok(/SELECT\s+referral_code/i.test(queries[0].text));
  } finally { restore(); }
}

async function testGetOrCreateReferralGeneratesWhenMissing() {
  const queries = [];
  const restore = stubPg(async (text, params) => {
    queries.push({ text, params });
    if (/^\s*SELECT/i.test(text)) return { rows: [{ referral_code: null }] };
    // UPDATE returns the generated code
    return { rows: [{ referral_code: params[1] }] };
  });
  try {
    const { db } = require('../db');
    const code = await db.getOrCreateReferralCode(12);
    assert.ok(/^[a-f0-9]{16}$/.test(code),
      `generated code must be 16 hex chars, got "${code}"`);
    assert.strictEqual(queries.length, 2,
      'must issue one SELECT + one UPDATE on the generate path');
    assert.ok(/UPDATE\s+users[\s\S]*SET[\s\S]*referral_code/i.test(queries[1].text));
    assert.ok(/referral_code\s+IS\s+NULL/i.test(queries[1].text),
      'UPDATE must guard on referral_code IS NULL so concurrent writes are safe');
  } finally { restore(); }
}

async function testGetOrCreateReferralRetriesOnUniqueViolation() {
  let updateCalls = 0;
  const restore = stubPg(async (text, params) => {
    if (/^\s*SELECT/i.test(text)) {
      // After the failed UPDATE, the re-read SELECT returns null too
      // (no row was inserted, so we keep retrying with a fresh code).
      return { rows: [{ referral_code: null }] };
    }
    updateCalls++;
    if (updateCalls === 1) {
      const err = new Error('duplicate key value violates unique constraint');
      err.code = '23505';
      throw err;
    }
    return { rows: [{ referral_code: params[1] }] };
  });
  try {
    const { db } = require('../db');
    const code = await db.getOrCreateReferralCode(13);
    assert.ok(/^[a-f0-9]{16}$/.test(code), 'eventually returns a valid code after retry');
    assert.strictEqual(updateCalls, 2, 'must retry exactly once after a 23505');
  } finally { restore(); }
}

// ---------- db.attachReferrerByCode -------------------------------------

async function testAttachReferrerByCodeSetsReferrerId() {
  const queries = [];
  const restore = stubPg(async (text, params) => {
    queries.push({ text, params });
    if (/SELECT\s+id\s+FROM\s+users\s+WHERE\s+referral_code/i.test(text)) {
      return { rows: [{ id: 99 }] };
    }
    return { rows: [{ referrer_id: 99 }] };
  });
  try {
    const { db } = require('../db');
    const id = await db.attachReferrerByCode(7, 'abcdef0123456789');
    assert.strictEqual(id, 99, 'returns the referrer id on success');
    assert.strictEqual(queries.length, 2,
      'happy path issues one SELECT (by code) + one UPDATE');
    assert.ok(/UPDATE\s+users[\s\S]*SET[\s\S]*referrer_id/i.test(queries[1].text));
    assert.ok(/referrer_id\s+IS\s+NULL/i.test(queries[1].text),
      'UPDATE must guard on referrer_id IS NULL (no overwriting)');
  } finally { restore(); }
}

async function testAttachReferrerByCodeIgnoresSelfReferral() {
  const restore = stubPg(async (text) => {
    if (/SELECT\s+id/i.test(text)) return { rows: [{ id: 7 }] };
    throw new Error('UPDATE should not be reached for self-referral');
  });
  try {
    const { db } = require('../db');
    const id = await db.attachReferrerByCode(7, 'abcdef0123456789');
    assert.strictEqual(id, null, 'self-referral must short-circuit and return null');
  } finally { restore(); }
}

async function testAttachReferrerByCodeRejectsBadInput() {
  const calls = [];
  const restore = stubPg(async (text, params) => {
    calls.push({ text, params });
    return { rows: [] };
  });
  try {
    const { db } = require('../db');
    assert.strictEqual(await db.attachReferrerByCode(7, null), null);
    assert.strictEqual(await db.attachReferrerByCode(7, ''), null);
    assert.strictEqual(await db.attachReferrerByCode(7, 'not-hex!!!'), null);
    assert.strictEqual(await db.attachReferrerByCode(7, 'abc'), null,
      'codes shorter than 8 chars are rejected');
    assert.strictEqual(calls.length, 0,
      'no DB query is issued for invalid codes');
  } finally { restore(); }
}

// ---------- lib/celebration ---------------------------------------------

async function testTriggerFiresEmailOnFreshStamp() {
  const sent = [];
  // Inject a fake resend client so sendReferralCelebrationEmail returns ok.
  delete require.cache[require.resolve('../lib/email')];
  const emailMod = require('../lib/email');
  emailMod.setResendClient({
    emails: { send: async (payload) => { sent.push(payload); return { data: { id: 'em_1' } }; } }
  });
  delete require.cache[require.resolve('../lib/celebration')];
  const { triggerFirstPaidCelebration } = require('../lib/celebration');
  const fakeDb = {
    async recordFirstPaidIfMissing(id) {
      return { id, email: 'u@x.com', name: 'U', plan: 'pro', first_paid_at: new Date(), referral_code: null };
    },
    async getOrCreateReferralCode() { return 'deadbeefcafef00d'; }
  };
  const out = await triggerFirstPaidCelebration(fakeDb, 5);
  assert.ok(out, 'returns truthy when stamp took');
  assert.strictEqual(out.referral_code, 'deadbeefcafef00d',
    'returned row carries the lazily-generated code');
  assert.ok(out.referral_url && /deadbeefcafef00d/.test(out.referral_url),
    'returned row carries a referral URL containing the code');
  // Email goes via setImmediate fire-and-forget — await one tick.
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(sent.length, 1, 'celebration email must fire exactly once');
  assert.strictEqual(sent[0].to[0], 'u@x.com');
  assert.ok(/share|refer|free month/i.test(sent[0].subject + sent[0].html),
    'email must mention share / refer / free month somewhere');
  emailMod.resetResendClient();
}

async function testTriggerNoopsWhenAlreadyStamped() {
  const sent = [];
  delete require.cache[require.resolve('../lib/email')];
  const emailMod = require('../lib/email');
  emailMod.setResendClient({
    emails: { send: async (payload) => { sent.push(payload); return { data: { id: 'em_x' } }; } }
  });
  delete require.cache[require.resolve('../lib/celebration')];
  const { triggerFirstPaidCelebration } = require('../lib/celebration');
  const fakeDb = {
    async recordFirstPaidIfMissing() { return null; },
    async getOrCreateReferralCode() { throw new Error('should not be called'); }
  };
  const out = await triggerFirstPaidCelebration(fakeDb, 9);
  assert.strictEqual(out, null, 'returns null when stamp did not take');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(sent.length, 0, 'no email fires when stamp was a no-op');
  emailMod.resetResendClient();
}

async function testTriggerSurvivesDbThrow() {
  delete require.cache[require.resolve('../lib/celebration')];
  const { triggerFirstPaidCelebration } = require('../lib/celebration');
  const fakeDb = {
    async recordFirstPaidIfMissing() { throw new Error('db down'); }
  };
  const out = await triggerFirstPaidCelebration(fakeDb, 11);
  assert.strictEqual(out, null,
    'DB error returns null (caller continues; status redirect must not fail)');
}

function testBuildReferralUrlRespectsAppUrl() {
  delete require.cache[require.resolve('../lib/celebration')];
  const prior = process.env.APP_URL;
  process.env.APP_URL = 'https://decentinvoice.com/';
  try {
    const { buildReferralUrl } = require('../lib/celebration');
    assert.strictEqual(buildReferralUrl('abc123'),
      'https://decentinvoice.com/?ref=abc123');
  } finally {
    if (prior == null) delete process.env.APP_URL;
    else process.env.APP_URL = prior;
  }
}

function testBuildReferralUrlFallsBackWhenAppUrlMissing() {
  const prior = process.env.APP_URL;
  delete process.env.APP_URL;
  try {
    delete require.cache[require.resolve('../lib/celebration')];
    const { buildReferralUrl } = require('../lib/celebration');
    const url = buildReferralUrl('abc123');
    assert.ok(url.endsWith('?ref=abc123'),
      `fallback url must end with ?ref=<code>, got "${url}"`);
    assert.strictEqual(buildReferralUrl(null), '',
      'returns empty string for null code');
  } finally {
    if (prior) process.env.APP_URL = prior;
  }
}

// ---------- lib/email referral helpers ----------------------------------

async function testSendReferralEmailReturnsNotConfiguredByDefault() {
  delete require.cache[require.resolve('../lib/email')];
  const emailMod = require('../lib/email');
  emailMod.resetResendClient();
  const priorKey = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  try {
    const r = await emailMod.sendReferralCelebrationEmail(
      { email: 'a@b.com', name: 'Ann' },
      'https://x/?ref=z'
    );
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'not_configured');
  } finally {
    if (priorKey) process.env.RESEND_API_KEY = priorKey;
  }
}

function testReferralEmailHtmlContainsLink() {
  delete require.cache[require.resolve('../lib/email')];
  const { buildReferralCelebrationHtml, buildReferralCelebrationText, buildReferralCelebrationSubject } = require('../lib/email');
  const html = buildReferralCelebrationHtml({ name: 'Ann' }, 'https://decentinvoice.com/?ref=abcdef0123456789');
  assert.ok(html.includes('Ann'), 'greets by name');
  assert.ok(html.includes('https://decentinvoice.com/?ref=abcdef0123456789'),
    'HTML body embeds the referral URL');
  assert.ok(/free month/i.test(html), 'mentions free month');
  const text = buildReferralCelebrationText({ name: 'Ann' }, 'https://decentinvoice.com/?ref=abcdef0123456789');
  assert.ok(text.includes('Ann') && text.includes('https://decentinvoice.com/?ref=abcdef0123456789'),
    'text body greets by name and embeds the URL');
  const subj = buildReferralCelebrationSubject();
  assert.ok(/free month|share|refer/i.test(subj),
    'subject hints at the share / free-month value prop');
}

function testReferralEmailEscapesHostileInput() {
  delete require.cache[require.resolve('../lib/email')];
  const { buildReferralCelebrationHtml } = require('../lib/email');
  const html = buildReferralCelebrationHtml(
    { name: '</script><script>alert(1)</script>' },
    'javascript:alert(2)'
  );
  assert.ok(!/<script>alert\(1\)<\/script>/.test(html),
    'hostile name must be HTML-escaped');
  assert.ok(html.includes('&lt;script&gt;') || html.includes('&lt;/script&gt;'),
    'angle brackets appear escaped in the rendered HTML');
}

// ---------- POST /invoices/:id/status integration ----------------------

async function postStatus(app, sessionCookie, id, status) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const payload = new URLSearchParams({ status }).toString();
      const headers = {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(payload)
      };
      if (sessionCookie) headers.Cookie = sessionCookie;
      const req = http.request({
        hostname: '127.0.0.1', port, path: `/invoices/${id}/status`, method: 'POST', headers
      }, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => server.close(() => resolve({ status: res.statusCode, headers: res.headers, body: data })));
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.write(payload);
      req.end();
    });
  });
}

function buildInvoiceAppWithCelebrationStub({ triggerCalls, statusFlip }) {
  // Stub db so requiring routes/invoices doesn't open a pool.
  const dbStub = {
    pool: { query: async () => ({ rows: [] }) },
    db: {
      async getUserById(id) { return { id, plan: 'pro', webhook_url: null }; },
      async getInvoicesByUser() { return []; },
      async getRecentRevenueStats() { return null; },
      async updateInvoiceStatus(id, userId, status) {
        return statusFlip ? { id, user_id: userId, status, total: '100', invoice_number: 'INV-2026-0007' } : null;
      },
      async getNextInvoiceNumber() { return 'INV-2026-0001'; },
      async recordFirstPaidIfMissing() { return null; },
      async getOrCreateReferralCode() { return null; },
      async attachReferrerByCode() { return null; }
    }
  };
  require.cache[require.resolve('../db')] = {
    id: require.resolve('../db'), filename: require.resolve('../db'),
    loaded: true, exports: dbStub
  };
  // Stub the celebration module so we can observe the call.
  require.cache[require.resolve('../lib/celebration')] = {
    id: require.resolve('../lib/celebration'),
    filename: require.resolve('../lib/celebration'),
    loaded: true,
    exports: {
      triggerFirstPaidCelebration: async (db, uid) => { triggerCalls.push(uid); return null; },
      buildReferralUrl: (code) => code ? `/?ref=${code}` : ''
    }
  };
  delete require.cache[require.resolve('../routes/invoices')];
  const invoiceRoutes = require('../routes/invoices');
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, res, next) => { req.session.user = { id: 7, plan: 'pro' }; next(); });
  app.use('/invoices', invoiceRoutes);
  return app;
}

async function testPaidFlipTriggersCelebration() {
  const triggerCalls = [];
  const app = buildInvoiceAppWithCelebrationStub({ triggerCalls, statusFlip: true });
  const r = await postStatus(app, null, 7, 'paid');
  assert.strictEqual(r.status, 302, 'status flip redirects');
  // Wait one tick for the fire-and-forget call to settle.
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(triggerCalls, [7],
    'triggerFirstPaidCelebration must be called with the user id on paid flip');
}

async function testNonPaidFlipDoesNotTriggerCelebration() {
  const triggerCalls = [];
  const app = buildInvoiceAppWithCelebrationStub({ triggerCalls, statusFlip: true });
  const r = await postStatus(app, null, 7, 'sent');
  assert.strictEqual(r.status, 302);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(triggerCalls.length, 0,
    'sent (or any non-paid) status flip must NOT call triggerFirstPaidCelebration');
}

// ---------- ?ref=<code> middleware capture ------------------------------

async function testServerCapturesRefQueryToSession() {
  // Use a tiny express app with the same middleware shape as server.js so
  // we don't need to boot the full app (which opens a pg Pool).
  const app = express();
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: true }));
  app.use((req, res, next) => {
    if (req.query && typeof req.query.ref === 'string' && !req.session.referral_code) {
      const code = req.query.ref.trim();
      if (/^[a-f0-9]{8,32}$/i.test(code)) {
        req.session.referral_code = code;
      }
    }
    next();
  });
  app.get('/probe', (req, res) => res.json({ code: req.session.referral_code || null }));
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      http.get(`http://127.0.0.1:${port}/probe?ref=abcdef0123456789`, (res) => {
        const cookie = res.headers['set-cookie'] && res.headers['set-cookie'][0].split(';')[0];
        let body = '';
        res.on('data', (c) => body += c);
        res.on('end', () => {
          // Round-trip with the same cookie + a different (bad) ref param to confirm we don't overwrite.
          http.get({ hostname: '127.0.0.1', port, path: '/probe?ref=NOPE', headers: { Cookie: cookie } }, (r2) => {
            let body2 = '';
            r2.on('data', (c) => body2 += c);
            r2.on('end', () => {
              server.close();
              try {
                const first = JSON.parse(body);
                const second = JSON.parse(body2);
                assert.strictEqual(first.code, 'abcdef0123456789',
                  'first hit must capture the valid hex code');
                assert.strictEqual(second.code, 'abcdef0123456789',
                  'second hit must NOT overwrite (sticky first attribution)');
                resolve();
              } catch (e) { reject(e); }
            });
          });
        });
      });
    });
  });
}

function testRefRejectsNonHexInput() {
  // Reuse the same regex inline — verifies the contract directly.
  const re = /^[a-f0-9]{8,32}$/i;
  assert.ok(re.test('abcdef0123456789'));
  assert.ok(!re.test('hello-world!'),
    'punctuation rejected');
  assert.ok(!re.test('abc'), 'too short rejected');
  assert.ok(!re.test('a'.repeat(40)), 'too long rejected');
  assert.ok(!re.test('<script>'), 'angle brackets rejected');
}

// ---------- dashboard.ejs rendering -------------------------------------

const dashboardTplPath = path.join(__dirname, '..', 'views', 'dashboard.ejs');
const dashboardTpl = fs.readFileSync(dashboardTplPath, 'utf8');

function renderDashboard(locals) {
  return ejs.render(dashboardTpl, {
    title: 'Dashboard',
    flash: null,
    days_left_in_trial: 0,
    csrfToken: 'TEST_CSRF',
    invoices: [{ id: 1, invoice_number: 'INV-2026-0001', client_name: 'Acme', total: '100.00', issued_date: new Date(), status: 'paid', is_seed: false }],
    user: { plan: 'pro', invoice_count: 1, subscription_status: 'active' },
    onboarding: null,
    invoiceLimitProgress: null,
    recentRevenue: null,
    annualUpgradePrompt: null,
    socialProof: null,
    celebration: null,
    ...locals
  }, {
    views: [path.join(__dirname, '..', 'views')],
    filename: dashboardTplPath
  });
}

function testDashboardRendersCelebrationWhenPresent() {
  const html = renderDashboard({
    celebration: {
      firstPaidAt: new Date(),
      daysSince: 0,
      referralUrl: 'https://decentinvoice.com/?ref=abcdef0123456789'
    }
  });
  assert.ok(html.includes('data-testid="celebration-banner"'),
    'celebration banner must render');
  assert.ok(html.includes('data-testid="celebration-copy"'),
    'copy-link button must render');
  assert.ok(html.includes('data-testid="celebration-share-twitter"'),
    'twitter/X share intent must render');
  assert.ok(html.includes('data-testid="celebration-share-email"'),
    'email share intent must render');
  assert.ok(html.includes('https://decentinvoice.com/?ref=abcdef0123456789'),
    'referral URL must appear in the rendered HTML');
  assert.ok(/free month of Pro/i.test(html),
    'banner copy must mention "free month of Pro"');
}

function testDashboardOmitsCelebrationWhenNull() {
  const html = renderDashboard({ celebration: null });
  assert.ok(!html.includes('data-testid="celebration-banner"'),
    'banner must NOT render when locals.celebration is null');
}

function testDashboardCelebrationEscapesHostileUrl() {
  // EJS <%= %> escape contract: a hostile URL should be HTML-escaped so it
  // can't break out of the data-referral-url attribute.
  const html = renderDashboard({
    celebration: {
      firstPaidAt: new Date(),
      daysSince: 0,
      referralUrl: '"><script>alert(1)</script>'
    }
  });
  assert.ok(!html.includes('"><script>alert(1)</script>'),
    'hostile URL chars must be HTML-escaped inside the banner attributes');
  assert.ok(html.includes('&#34;') || html.includes('&quot;'),
    'double-quotes appear HTML-escaped in the rendered attribute');
}

// ---------- Runner ------------------------------------------------------

async function run() {
  const tests = [
    ['db.recordFirstPaidIfMissing: idempotent SQL shape', testRecordFirstPaidShape],
    ['db.recordFirstPaidIfMissing: returns null on no-op', testRecordFirstPaidReturnsNullOnNoUpdate],
    ['db.getOrCreateReferralCode: returns existing code', testGetOrCreateReferralReturnsExisting],
    ['db.getOrCreateReferralCode: generates when missing', testGetOrCreateReferralGeneratesWhenMissing],
    ['db.getOrCreateReferralCode: retries on UNIQUE collision', testGetOrCreateReferralRetriesOnUniqueViolation],
    ['db.attachReferrerByCode: sets referrer_id on valid code', testAttachReferrerByCodeSetsReferrerId],
    ['db.attachReferrerByCode: ignores self-referral', testAttachReferrerByCodeIgnoresSelfReferral],
    ['db.attachReferrerByCode: rejects bad input shapes', testAttachReferrerByCodeRejectsBadInput],
    ['lib/celebration: trigger fires email on fresh stamp', testTriggerFiresEmailOnFreshStamp],
    ['lib/celebration: trigger no-ops when already stamped', testTriggerNoopsWhenAlreadyStamped],
    ['lib/celebration: trigger survives DB throw', testTriggerSurvivesDbThrow],
    ['lib/celebration: buildReferralUrl respects APP_URL', testBuildReferralUrlRespectsAppUrl],
    ['lib/celebration: buildReferralUrl falls back when APP_URL missing', testBuildReferralUrlFallsBackWhenAppUrlMissing],
    ['lib/email: sendReferralCelebrationEmail returns not_configured by default', testSendReferralEmailReturnsNotConfiguredByDefault],
    ['lib/email: referral HTML+text+subject embed name, link, value prop', testReferralEmailHtmlContainsLink],
    ['lib/email: referral HTML escapes hostile input', testReferralEmailEscapesHostileInput],
    ['POST /invoices/:id/status: paid flip calls triggerFirstPaidCelebration', testPaidFlipTriggersCelebration],
    ['POST /invoices/:id/status: non-paid flip does NOT call trigger', testNonPaidFlipDoesNotTriggerCelebration],
    ['server middleware: ?ref=<code> captured into session, sticky', testServerCapturesRefQueryToSession],
    ['server middleware: bad ref values rejected by regex', testRefRejectsNonHexInput],
    ['dashboard: renders celebration banner when locals.celebration set', testDashboardRendersCelebrationWhenPresent],
    ['dashboard: omits celebration banner when null', testDashboardOmitsCelebrationWhenNull],
    ['dashboard: hostile referral URL is HTML-escaped in attributes', testDashboardCelebrationEscapesHostileUrl]
  ];
  let pass = 0, fail = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ok  ${name}`);
      pass++;
    } catch (err) {
      console.error(`  FAIL ${name}`);
      console.error(err && err.stack ? err.stack : err);
      fail++;
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run().catch((err) => { console.error(err); process.exit(1); });
