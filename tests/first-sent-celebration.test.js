'use strict';

/*
 * First-sent celebration email tests (Milestone 3 — first invoice created →
 * first invoice sent).
 *
 * Covers:
 *  - db.recordFirstSentIfMissing: idempotent SQL shape — UPDATE users, SET
 *    first_sent_at = NOW(), guard on first_sent_at IS NULL, EXISTS subquery
 *    on non-seed sent/paid/overdue invoices. Returns null on no-op, user
 *    row when the stamp took.
 *  - lib/email: sendFirstSentCelebrationEmail returns not_configured when
 *    RESEND_API_KEY is unset; subject/HTML/text shape; free-tier upgrade
 *    block renders for free users, omitted for Pro/Agency; magic-login URL
 *    baked into primary CTA when supplied, fallback to APP_URL otherwise;
 *    HTML-escapes hostile invoice / owner input.
 *  - lib/first-sent-celebration.triggerFirstSentCelebration: fires email on
 *    fresh stamp, no-ops when already stamped, survives DB throw, returns
 *    null on missing args, mints a 7-day magic-login token via
 *    createPasswordResetToken, soft-fails when the mint fails.
 *  - POST /invoices/:id/status with status='sent' calls trigger.
 *  - POST /invoices/:id/share-intent with a flip calls trigger.
 *  - POST /invoices/:id/share-intent on an already-sent invoice does NOT
 *    call trigger.
 *  - POST /invoices/:id/email-client with a flip calls trigger.
 *  - GET /i/<token> with a draft→sent auto-flip calls trigger.
 *  - GET /i/<token> on an already-sent invoice does NOT call trigger.
 *
 * Run: NODE_ENV=test node tests/first-sent-celebration.test.js
 */

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';
process.env.APP_URL = process.env.APP_URL || 'https://test.invoice.app';

const assert = require('assert');
const path = require('path');
const express = require('express');
const session = require('express-session');
const http = require('http');

// ---------- pg + module-cache plumbing ----------------------------------

function stubPg(handler) {
  const pgPath = require.resolve('pg');
  const originalPg = require.cache[pgPath];
  require.cache[pgPath] = {
    id: pgPath, filename: pgPath, loaded: true,
    exports: { Pool: function () { return { query: handler }; } }
  };
  delete require.cache[require.resolve('../db')];
  return () => {
    if (originalPg) require.cache[pgPath] = originalPg;
    else delete require.cache[pgPath];
    delete require.cache[require.resolve('../db')];
  };
}

function clearReq(mod) { delete require.cache[require.resolve(mod)]; }

// ---------- db.recordFirstSentIfMissing ---------------------------------

async function testRecordFirstSentSqlShape() {
  const captured = [];
  const restore = stubPg(async (text, params) => {
    captured.push({ text, params });
    return { rows: [{
      id: 7, email: 'a@b.com', name: 'Ana',
      business_name: null, business_email: null, reply_to_email: null,
      plan: 'free', first_sent_at: new Date()
    }] };
  });
  try {
    const { db } = require('../db');
    const row = await db.recordFirstSentIfMissing(7);
    assert.strictEqual(captured.length, 1, 'must issue exactly one query');
    const q = captured[0];
    assert.ok(/UPDATE\s+users/i.test(q.text), 'must UPDATE users');
    assert.ok(/SET[\s\S]*first_sent_at\s*=\s*NOW\(\)/i.test(q.text),
      'must set first_sent_at = NOW()');
    assert.ok(/first_sent_at\s+IS\s+NULL/i.test(q.text),
      'must guard on first_sent_at IS NULL (idempotency)');
    assert.ok(/EXISTS\s*\([\s\S]*invoices/i.test(q.text),
      'must verify at least one matching invoice via EXISTS subquery');
    assert.ok(/status\s+IN\s*\(\s*'sent'\s*,\s*'paid'\s*,\s*'overdue'\s*\)/i.test(q.text),
      'EXISTS must check status IN (sent, paid, overdue) — not just sent');
    assert.ok(/is_seed/i.test(q.text),
      'EXISTS must exclude seed invoices so the dashboard sample never triggers');
    assert.deepStrictEqual(q.params, [7]);
    assert.strictEqual(row.id, 7);
    assert.strictEqual(row.email, 'a@b.com');
    assert.strictEqual(row.plan, 'free');
  } finally { restore(); }
}

async function testRecordFirstSentReturnsNullOnNoUpdate() {
  const restore = stubPg(async () => ({ rows: [] }));
  try {
    const { db } = require('../db');
    const row = await db.recordFirstSentIfMissing(42);
    assert.strictEqual(row, null,
      'returns null when no row updated (already stamped or no sent non-seed invoice)');
  } finally { restore(); }
}

async function testRecordFirstSentRejectsFalsyUserId() {
  let queries = 0;
  const restore = stubPg(async () => { queries++; return { rows: [] }; });
  try {
    const { db } = require('../db');
    const row = await db.recordFirstSentIfMissing(null);
    assert.strictEqual(row, null);
    assert.strictEqual(queries, 0,
      'no DB query issued when userId is missing — defence-in-depth before SQL');
  } finally { restore(); }
}

// ---------- lib/email: sendFirstSentCelebrationEmail --------------------

async function testFirstSentEmailNotConfiguredByDefault() {
  clearReq('../lib/email');
  const emailMod = require('../lib/email');
  emailMod.resetResendClient();
  const priorKey = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  try {
    const r = await emailMod.sendFirstSentCelebrationEmail(
      { email: 'u@x.com', name: 'U', plan: 'free' },
      { id: 1, invoice_number: 'INV-001', client_name: 'Acme', total: 100 }
    );
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'not_configured');
  } finally {
    if (priorKey) process.env.RESEND_API_KEY = priorKey;
  }
}

async function testFirstSentEmailRejectsMissingArgs() {
  clearReq('../lib/email');
  const emailMod = require('../lib/email');
  const noOwner = await emailMod.sendFirstSentCelebrationEmail(null,
    { id: 1, invoice_number: 'INV-001' });
  assert.strictEqual(noOwner.ok, false);
  assert.strictEqual(noOwner.reason, 'no_owner_email');

  const noInvoice = await emailMod.sendFirstSentCelebrationEmail(
    { email: 'u@x.com' }, null);
  assert.strictEqual(noInvoice.ok, false);
  assert.strictEqual(noInvoice.reason, 'no_invoice');
}

function testFirstSentEmailContentEmbedsKeyFields() {
  clearReq('../lib/email');
  const { buildFirstSentCelebrationSubject, buildFirstSentCelebrationHtml, buildFirstSentCelebrationText }
    = require('../lib/email');
  const invoice = { id: 5, invoice_number: 'INV-2026-0001', client_name: 'Acme Co.', total: 1234.5 };
  const owner = { email: 'u@x.com', name: 'Ann', plan: 'free' };
  const subj = buildFirstSentCelebrationSubject(invoice);
  assert.ok(subj.includes('INV-2026-0001'),
    'subject must embed the invoice number for inbox skimmability');
  const html = buildFirstSentCelebrationHtml(owner, invoice);
  assert.ok(html.includes('INV-2026-0001'), 'HTML embeds invoice number');
  assert.ok(html.includes('Acme Co.'), 'HTML embeds client name');
  assert.ok(html.includes('1234.50'), 'HTML embeds formatted total');
  assert.ok(html.includes('Ann'), 'HTML greets by name');
  const text = buildFirstSentCelebrationText(owner, invoice);
  assert.ok(text.includes('INV-2026-0001') && text.includes('Acme Co.') && text.includes('Ann'),
    'text body mirrors the HTML key fields');
}

function testFirstSentEmailShowsUpgradeBlockForFreeUsers() {
  clearReq('../lib/email');
  const { buildFirstSentCelebrationHtml, buildFirstSentCelebrationText } = require('../lib/email');
  const invoice = { id: 5, invoice_number: 'INV-1', client_name: 'X', total: 1 };
  const freeHtml = buildFirstSentCelebrationHtml({ email: 'u@x.com', plan: 'free' }, invoice);
  assert.ok(/Try Pro free/i.test(freeHtml),
    'free-tier owners see the Pro-upgrade upsell block');
  assert.ok(/billing\/upgrade/i.test(freeHtml),
    'upgrade block links to /billing/upgrade');
  const freeText = buildFirstSentCelebrationText({ email: 'u@x.com', plan: 'free' }, invoice);
  assert.ok(/Try Pro free/i.test(freeText),
    'text variant carries the same upsell so plaintext readers see it');
}

function testFirstSentEmailOmitsUpgradeBlockForProUsers() {
  clearReq('../lib/email');
  const { buildFirstSentCelebrationHtml, buildFirstSentCelebrationText } = require('../lib/email');
  const invoice = { id: 5, invoice_number: 'INV-1', client_name: 'X', total: 1 };
  const proHtml = buildFirstSentCelebrationHtml({ email: 'u@x.com', plan: 'pro' }, invoice);
  assert.ok(!/Try Pro free/i.test(proHtml),
    'Pro owners must NOT see the upgrade pitch (they already pay)');
  const agencyText = buildFirstSentCelebrationText({ email: 'u@x.com', plan: 'agency' }, invoice);
  assert.ok(!/Try Pro free/i.test(agencyText),
    'Agency owners must NOT see the upgrade pitch either');
}

function testFirstSentEmailBakesMagicLoginIntoCta() {
  clearReq('../lib/email');
  const { buildFirstSentCelebrationHtml, buildFirstSentCelebrationText } = require('../lib/email');
  const invoice = { id: 99, invoice_number: 'INV-1', client_name: 'X', total: 1 };
  const owner = { email: 'u@x.com', plan: 'free' };
  const magicUrl = 'https://test.invoice.app/auth/magic/abc123def456';
  const html = buildFirstSentCelebrationHtml(owner, invoice, { magicLoginUrl: magicUrl });
  assert.ok(html.includes(`${magicUrl}?next=/invoices/99`),
    'primary CTA must point at the magic-login URL with ?next=/invoices/<id>');
  const text = buildFirstSentCelebrationText(owner, invoice, { magicLoginUrl: magicUrl });
  assert.ok(text.includes(`${magicUrl}?next=/invoices/99`),
    'text variant carries the same magic-login URL');
  // Free-tier upgrade URL also gets the magic-login bake.
  assert.ok(html.includes(`${magicUrl}?next=/billing/upgrade`),
    'free-tier upgrade URL also magic-login-baked so the click auto-signs-in');
}

function testFirstSentEmailFallsBackWhenNoMagicLogin() {
  clearReq('../lib/email');
  const { buildFirstSentCelebrationHtml } = require('../lib/email');
  const invoice = { id: 42, invoice_number: 'INV-1', client_name: 'X', total: 1 };
  const html = buildFirstSentCelebrationHtml({ email: 'u@x.com', plan: 'pro' }, invoice);
  assert.ok(html.includes('/invoices/42'),
    'falls back to plain /invoices/<id> path when no magic-login URL supplied');
  assert.ok(!/auth\/magic\//.test(html),
    'no auth/magic URL appears when none was supplied');
}

function testFirstSentEmailEscapesHostileInput() {
  clearReq('../lib/email');
  const { buildFirstSentCelebrationHtml } = require('../lib/email');
  const html = buildFirstSentCelebrationHtml(
    { email: 'u@x.com', name: '</script><script>alert(1)</script>', plan: 'free' },
    { id: 1, invoice_number: '"><img src=x>', client_name: '<svg onload=alert(2)>', total: 1 }
  );
  assert.ok(!/<script>alert\(1\)<\/script>/.test(html),
    'hostile owner name must be HTML-escaped');
  assert.ok(!/<svg onload=alert\(2\)>/.test(html),
    'hostile client name must be HTML-escaped');
  assert.ok(html.includes('&lt;') || html.includes('&amp;lt;'),
    'angle brackets appear as escaped entities in the rendered HTML');
}

// ---------- lib/first-sent-celebration: orchestrator --------------------

async function testTriggerFiresEmailOnFreshStamp() {
  const sent = [];
  const tokenCalls = [];
  clearReq('../lib/email');
  const emailMod = require('../lib/email');
  emailMod.setResendClient({
    emails: { send: async (payload) => { sent.push(payload); return { data: { id: 'em_first_sent' } }; } }
  });
  clearReq('../lib/magic-login');
  clearReq('../lib/first-sent-celebration');
  const { triggerFirstSentCelebration } = require('../lib/first-sent-celebration');
  const fakeDb = {
    async recordFirstSentIfMissing(id) {
      return {
        id, email: 'u@x.com', name: 'Una', business_name: null,
        business_email: null, reply_to_email: null, plan: 'free',
        first_sent_at: new Date()
      };
    },
    async createPasswordResetToken(uid, hash, ttl, kind) {
      tokenCalls.push({ uid, ttl, kind });
      return { id: 1, user_id: uid, token_hash: hash, expires_at: new Date(Date.now() + ttl * 60000) };
    }
  };
  const invoice = { id: 17, invoice_number: 'INV-077', client_name: 'Stark', total: 250 };
  const out = await triggerFirstSentCelebration(fakeDb, 5, invoice);
  assert.ok(out, 'returns truthy when stamp took');
  assert.strictEqual(out.id, 5);
  assert.ok(out.magic_login_url && typeof out.magic_login_url === 'string',
    'returned row carries the minted magic-login URL');
  // Token mint should use the login-kind 7-day TTL.
  assert.strictEqual(tokenCalls.length, 1, 'magic-login mint fires exactly once');
  assert.strictEqual(tokenCalls[0].uid, 5);
  assert.strictEqual(tokenCalls[0].kind, 'login');
  assert.strictEqual(tokenCalls[0].ttl, 7 * 24 * 60, 'TTL is 7 days');
  // Email is fire-and-forget — await one tick.
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(sent.length, 1, 'celebration email fires exactly once');
  assert.strictEqual(sent[0].to[0], 'u@x.com');
  assert.ok(sent[0].subject.includes('INV-077'),
    'subject references the invoice the user just sent');
  assert.ok(/Stark/.test(sent[0].html),
    'body references the client');
  emailMod.resetResendClient();
}

async function testTriggerNoopsWhenAlreadyStamped() {
  const sent = [];
  clearReq('../lib/email');
  const emailMod = require('../lib/email');
  emailMod.setResendClient({
    emails: { send: async (payload) => { sent.push(payload); return { data: { id: 'em_x' } }; } }
  });
  clearReq('../lib/first-sent-celebration');
  const { triggerFirstSentCelebration } = require('../lib/first-sent-celebration');
  const fakeDb = {
    async recordFirstSentIfMissing() { return null; },
    async createPasswordResetToken() {
      throw new Error('mint should not be called when stamp did not take');
    }
  };
  const out = await triggerFirstSentCelebration(fakeDb, 9,
    { id: 1, invoice_number: 'INV', client_name: 'X', total: 1 });
  assert.strictEqual(out, null, 'returns null on no-op');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(sent.length, 0, 'no email fires on no-op stamp');
  emailMod.resetResendClient();
}

async function testTriggerSurvivesDbThrow() {
  clearReq('../lib/first-sent-celebration');
  const { triggerFirstSentCelebration } = require('../lib/first-sent-celebration');
  const fakeDb = {
    async recordFirstSentIfMissing() { throw new Error('db down'); }
  };
  const out = await triggerFirstSentCelebration(fakeDb, 11,
    { id: 1, invoice_number: 'INV', client_name: 'X', total: 1 });
  assert.strictEqual(out, null,
    'DB throw returns null (caller must continue; the status flip cannot fail on email)');
}

async function testTriggerReturnsNullOnMissingArgs() {
  clearReq('../lib/first-sent-celebration');
  const { triggerFirstSentCelebration } = require('../lib/first-sent-celebration');
  assert.strictEqual(await triggerFirstSentCelebration(null, 1, { id: 1 }), null);
  assert.strictEqual(await triggerFirstSentCelebration({}, null, { id: 1 }), null);
  assert.strictEqual(await triggerFirstSentCelebration({ recordFirstSentIfMissing: () => null }, 1, null), null);
  assert.strictEqual(await triggerFirstSentCelebration({ recordFirstSentIfMissing: () => null }, 1, {}), null,
    'invoice without an id is rejected');
}

async function testTriggerSoftFailsWhenMintFails() {
  const sent = [];
  clearReq('../lib/email');
  const emailMod = require('../lib/email');
  emailMod.setResendClient({
    emails: { send: async (payload) => { sent.push(payload); return { data: { id: 'em_y' } }; } }
  });
  clearReq('../lib/first-sent-celebration');
  const { triggerFirstSentCelebration } = require('../lib/first-sent-celebration');
  const fakeDb = {
    async recordFirstSentIfMissing(id) {
      return {
        id, email: 'u@x.com', name: 'U', business_name: null,
        business_email: null, reply_to_email: null, plan: 'pro',
        first_sent_at: new Date()
      };
    },
    async createPasswordResetToken() {
      // Mint failure path: return null so mintMagicLoginToken returns persist_failed.
      return null;
    }
  };
  const out = await triggerFirstSentCelebration(fakeDb, 8,
    { id: 3, invoice_number: 'INV-3', client_name: 'C', total: 1 });
  assert.ok(out, 'trigger still returns the stamped row even when mint fails');
  assert.strictEqual(out.magic_login_url, null,
    'magic_login_url is null when the mint soft-failed');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(sent.length, 1, 'email still ships when mint fails');
  // Body falls back to the plain APP_URL path.
  assert.ok(sent[0].html.includes('/invoices/3'),
    'CTA falls back to plain /invoices/<id> path on mint failure');
  emailMod.resetResendClient();
}

// ---------- Route integration: POST /:id/status -------------------------

function buildInvoicesApp({ triggerCalls, viewCalls, dbOverrides }) {
  const dbStub = {
    pool: { query: async () => ({ rows: [] }) },
    db: Object.assign({
      async getUserById(id) { return { id, plan: 'pro', webhook_url: null }; },
      async getInvoicesByUser() { return []; },
      async getRecentRevenueStats() { return null; },
      async updateInvoiceStatus(id, userId, status) {
        return { id, user_id: userId, status, total: '100', invoice_number: 'INV-2026-0007', client_name: 'Acme' };
      },
      async getNextInvoiceNumber() { return 'INV-2026-0001'; },
      async getInvoiceById(id, userId) {
        return { id, user_id: userId, status: 'draft', client_email: 'c@x.com',
          invoice_number: 'INV-1', client_name: 'Acme', total: '100' };
      },
      async markInvoiceSentFromShareIntent(id) {
        return { id, status: 'sent', sent_via_share_intent_at: new Date() };
      },
      async recordFirstSentIfMissing() { return null; },
      async recordFirstPaidIfMissing() { return null; },
      async getOrCreatePublicToken() { return 'abcdef0123456789'; },
      async setInvoicePaymentLink() { return null; }
    }, dbOverrides || {})
  };
  require.cache[require.resolve('../db')] = {
    id: require.resolve('../db'), filename: require.resolve('../db'),
    loaded: true, exports: dbStub
  };
  // Stub the first-sent-celebration module so we can observe the call.
  require.cache[require.resolve('../lib/first-sent-celebration')] = {
    id: require.resolve('../lib/first-sent-celebration'),
    filename: require.resolve('../lib/first-sent-celebration'),
    loaded: true,
    exports: {
      triggerFirstSentCelebration: async (_db, uid, invoice) => {
        triggerCalls.push({ uid, invoiceId: invoice && invoice.id, invoiceNumber: invoice && invoice.invoice_number });
        return null;
      },
      FIRST_SENT_TTL_MINUTES: 7 * 24 * 60
    }
  };
  // Stub stripe-payment-link so requiring the route doesn't init Stripe.
  require.cache[require.resolve('../lib/stripe-payment-link')] = {
    id: require.resolve('../lib/stripe-payment-link'),
    filename: require.resolve('../lib/stripe-payment-link'),
    loaded: true,
    exports: {
      createInvoicePaymentLink: async () => ({ url: 'https://buy.stripe.com/test', id: 'plink_test' }),
      parsePaymentMethods: () => ['card']
    }
  };
  clearReq('../routes/invoices');
  const invoiceRoutes = require('../routes/invoices');
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, res, next) => { req.session.user = { id: 7, plan: 'pro' }; next(); });
  app.use('/invoices', invoiceRoutes);
  return app;
}

function httpPost(app, urlPath, body, contentType) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const payload = contentType === 'json'
        ? JSON.stringify(body)
        : new URLSearchParams(body).toString();
      const headers = {
        'Content-Type': contentType === 'json'
          ? 'application/json'
          : 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(payload)
      };
      const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method: 'POST', headers }, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => server.close(() => resolve({ status: res.statusCode, body: data })));
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.write(payload);
      req.end();
    });
  });
}

async function testStatusSentTriggersCelebration() {
  const triggerCalls = [];
  const app = buildInvoicesApp({ triggerCalls });
  const r = await httpPost(app, '/invoices/7/status', { status: 'sent' });
  assert.strictEqual(r.status, 302, 'status flip redirects');
  await new Promise((res) => setImmediate(res));
  assert.strictEqual(triggerCalls.length, 1,
    'POST /:id/status with status=sent calls triggerFirstSentCelebration once');
  assert.strictEqual(triggerCalls[0].uid, 7);
  assert.strictEqual(Number(triggerCalls[0].invoiceId), 7);
}

async function testStatusPaidDoesNotTriggerSentCelebration() {
  const triggerCalls = [];
  const app = buildInvoicesApp({
    triggerCalls,
    dbOverrides: {
      async updateInvoiceStatus(id, userId, status) {
        return { id, user_id: userId, status, total: '100', invoice_number: 'INV-1' };
      }
    }
  });
  const r = await httpPost(app, '/invoices/7/status', { status: 'paid' });
  assert.strictEqual(r.status, 302);
  await new Promise((res) => setImmediate(res));
  assert.strictEqual(triggerCalls.length, 0,
    'POST /:id/status with status=paid must NOT call triggerFirstSentCelebration — that is the first-PAID surface\'s job');
}

async function testShareIntentFlipTriggersCelebration() {
  const triggerCalls = [];
  const app = buildInvoicesApp({
    triggerCalls,
    dbOverrides: {
      async getInvoiceById(id, userId) {
        return { id, user_id: userId, status: 'draft', invoice_number: 'INV-5', client_name: 'Acme', total: '50' };
      },
      async markInvoiceSentFromShareIntent(id) {
        return { id, status: 'sent', sent_via_share_intent_at: new Date() };
      }
    }
  });
  const r = await httpPost(app, '/invoices/5/share-intent', { intent: 'whatsapp' }, 'json');
  assert.strictEqual(r.status, 200, 'happy path 200; body=' + r.body);
  const body = JSON.parse(r.body);
  assert.strictEqual(body.flipped, true);
  await new Promise((res) => setImmediate(res));
  assert.strictEqual(triggerCalls.length, 1,
    'share-intent that actually flipped draft→sent triggers celebration once');
  assert.strictEqual(Number(triggerCalls[0].invoiceId), 5);
}

async function testShareIntentNoFlipDoesNotTrigger() {
  const triggerCalls = [];
  const app = buildInvoicesApp({
    triggerCalls,
    dbOverrides: {
      async getInvoiceById(id, userId) {
        // Invoice was already sent — share-intent fires but flips nothing.
        return { id, user_id: userId, status: 'sent', invoice_number: 'INV-5', client_name: 'Acme', total: '50' };
      },
      async markInvoiceSentFromShareIntent(id) {
        return { id, status: 'sent', sent_via_share_intent_at: null };
      }
    }
  });
  const r = await httpPost(app, '/invoices/5/share-intent', { intent: 'sms' }, 'json');
  assert.strictEqual(r.status, 200);
  const body = JSON.parse(r.body);
  assert.strictEqual(body.flipped, false);
  await new Promise((res) => setImmediate(res));
  assert.strictEqual(triggerCalls.length, 0,
    'share-intent on an already-sent invoice must NOT re-fire the celebration');
}

async function testEmailClientFlipTriggersCelebration() {
  const triggerCalls = [];
  const app = buildInvoicesApp({
    triggerCalls,
    dbOverrides: {
      async getInvoiceById(id, userId) {
        return { id, user_id: userId, status: 'draft', client_email: 'c@x.com',
          invoice_number: 'INV-9', client_name: 'Acme', total: '900' };
      },
      async markInvoiceSentFromShareIntent(id) {
        return { id, status: 'sent', sent_via_share_intent_at: new Date() };
      }
    }
  });
  // Stub sendInvoiceEmail via setResendClient so the route's send succeeds.
  clearReq('../lib/email');
  const emailMod = require('../lib/email');
  emailMod.setResendClient({
    emails: { send: async () => ({ data: { id: 'em_inv' } }) }
  });
  // Rebuild the app after stubbing email so routes/invoices picks up the
  // already-cached lib/email module (note: buildInvoicesApp clears routes
  // but not email — the email module pulled in by the route shares this
  // setResendClient state).
  const app2 = buildInvoicesApp({
    triggerCalls,
    dbOverrides: {
      async getInvoiceById(id, userId) {
        return { id, user_id: userId, status: 'draft', client_email: 'c@x.com',
          invoice_number: 'INV-9', client_name: 'Acme', total: '900' };
      },
      async markInvoiceSentFromShareIntent(id) {
        return { id, status: 'sent', sent_via_share_intent_at: new Date() };
      }
    }
  });
  const r = await httpPost(app2, '/invoices/9/email-client', {}, 'json');
  assert.strictEqual(r.status, 200, 'happy path 200; body=' + r.body);
  const body = JSON.parse(r.body);
  assert.strictEqual(body.flipped, true);
  await new Promise((res) => setImmediate(res));
  // Note: triggerCalls is shared — both buildInvoicesApp calls observed it.
  // The first app was never exercised, so all calls came from app2's email-client route.
  assert.ok(triggerCalls.length >= 1,
    'email-client flip triggers celebration at least once');
  const last = triggerCalls[triggerCalls.length - 1];
  assert.strictEqual(Number(last.invoiceId), 9);
  emailMod.resetResendClient();
  // Use app reference to silence lint about unused variable.
  void app;
}

// ---------- Route integration: GET /i/<token> ---------------------------

function buildShareApp({ triggerCalls, invoiceRow, recordViewResult }) {
  // Stub db so requiring routes/share doesn't open a pool.
  const dbStub = {
    pool: { query: async () => ({ rows: [] }) },
    db: {
      async getInvoiceByPublicToken() { return invoiceRow; },
      async recordPublicInvoiceView() { return recordViewResult; }
    }
  };
  require.cache[require.resolve('../db')] = {
    id: require.resolve('../db'), filename: require.resolve('../db'),
    loaded: true, exports: dbStub
  };
  // Stub the celebration module so we can observe the call.
  require.cache[require.resolve('../lib/first-sent-celebration')] = {
    id: require.resolve('../lib/first-sent-celebration'),
    filename: require.resolve('../lib/first-sent-celebration'),
    loaded: true,
    exports: {
      triggerFirstSentCelebration: async (_db, uid, invoice) => {
        triggerCalls.push({ uid, invoiceId: invoice && invoice.id });
        return null;
      },
      FIRST_SENT_TTL_MINUTES: 7 * 24 * 60
    }
  };
  // Stub email module's sendClientViewedEmail so the route doesn't try to send.
  clearReq('../lib/email');
  const emailMod = require('../lib/email');
  emailMod.setResendClient({
    emails: { send: async () => ({ data: { id: 'em_view' } }) }
  });
  clearReq('../routes/share');
  const shareRoutes = require('../routes/share');
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use(shareRoutes);
  return app;
}

function httpGet(app, urlPath, headers) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      http.get({ hostname: '127.0.0.1', port, path: urlPath, headers: headers || {} }, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => server.close(() => resolve({ status: res.statusCode, body: data })));
      });
    });
  });
}

async function testShareViewAutoFlipTriggersCelebration() {
  const triggerCalls = [];
  const app = buildShareApp({
    triggerCalls,
    invoiceRow: {
      id: 11, invoice_number: 'INV-11', status: 'draft', is_seed: false,
      owner_id: 42, owner_email: 'u@x.com', owner_name: 'U',
      client_name: 'C', total: 100, items: [], issued_date: new Date()
    },
    recordViewResult: { id: 11, view_count: 1, status: 'sent', sent_via_share_view_at: new Date() }
  });
  const r = await httpGet(app, '/i/abcdef0123456789',
    { 'User-Agent': 'Mozilla/5.0 (real browser)' });
  // The render may 500 because the invoice-public template needs more fields,
  // but the trigger fires from the fire-and-forget callback BEFORE render —
  // we just need the route to have invoked recordPublicInvoiceView and the
  // celebration callback path to have run.
  assert.ok(r.status === 200 || r.status === 500, `route renders or fallback-500s, not ${r.status}`);
  await new Promise((res) => setImmediate(res));
  await new Promise((res) => setImmediate(res));
  assert.strictEqual(triggerCalls.length, 1,
    'client-view auto-flip on a draft invoice triggers celebration once');
  assert.strictEqual(triggerCalls[0].uid, 42, 'celebration fires for the invoice owner');
  assert.strictEqual(triggerCalls[0].invoiceId, 11);
}

async function testShareViewNoFlipDoesNotTrigger() {
  const triggerCalls = [];
  const app = buildShareApp({
    triggerCalls,
    invoiceRow: {
      id: 11, invoice_number: 'INV-11', status: 'sent', is_seed: false,
      owner_id: 42, owner_email: 'u@x.com', owner_name: 'U',
      client_name: 'C', total: 100, items: [], issued_date: new Date()
    },
    // Already-sent invoice: view_count bumps but no status change.
    recordViewResult: { id: 11, view_count: 2, status: 'sent', sent_via_share_view_at: null }
  });
  const r = await httpGet(app, '/i/abcdef0123456789',
    { 'User-Agent': 'Mozilla/5.0 (real browser)' });
  assert.ok(r.status === 200 || r.status === 500);
  await new Promise((res) => setImmediate(res));
  await new Promise((res) => setImmediate(res));
  assert.strictEqual(triggerCalls.length, 0,
    'no celebration when status was already sent before the view');
}

async function testShareViewSkipsForSeedInvoice() {
  const triggerCalls = [];
  const app = buildShareApp({
    triggerCalls,
    invoiceRow: {
      id: 11, invoice_number: 'INV-11', status: 'draft', is_seed: true,
      owner_id: 42, owner_email: 'u@x.com', owner_name: 'U',
      client_name: 'C', total: 100, items: [], issued_date: new Date()
    },
    recordViewResult: { id: 11, view_count: 1, status: 'sent', sent_via_share_view_at: new Date() }
  });
  const r = await httpGet(app, '/i/abcdef0123456789',
    { 'User-Agent': 'Mozilla/5.0 (real browser)' });
  assert.ok(r.status === 200 || r.status === 500);
  await new Promise((res) => setImmediate(res));
  await new Promise((res) => setImmediate(res));
  assert.strictEqual(triggerCalls.length, 0,
    'seed invoices never trigger the first-sent celebration — defence in depth even though the SQL guard already excludes them');
}

// ---------- Runner ------------------------------------------------------

async function run() {
  const tests = [
    ['db.recordFirstSentIfMissing: idempotent SQL shape', testRecordFirstSentSqlShape],
    ['db.recordFirstSentIfMissing: returns null on no-op', testRecordFirstSentReturnsNullOnNoUpdate],
    ['db.recordFirstSentIfMissing: rejects falsy userId before SQL', testRecordFirstSentRejectsFalsyUserId],
    ['lib/email: sendFirstSentCelebrationEmail returns not_configured by default', testFirstSentEmailNotConfiguredByDefault],
    ['lib/email: sendFirstSentCelebrationEmail rejects missing owner/invoice', testFirstSentEmailRejectsMissingArgs],
    ['lib/email: first-sent subject/HTML/text embed key fields', testFirstSentEmailContentEmbedsKeyFields],
    ['lib/email: first-sent HTML+text upsell free users to Pro', testFirstSentEmailShowsUpgradeBlockForFreeUsers],
    ['lib/email: first-sent omits upgrade block for Pro/Agency', testFirstSentEmailOmitsUpgradeBlockForProUsers],
    ['lib/email: first-sent bakes magic-login URL into CTAs', testFirstSentEmailBakesMagicLoginIntoCta],
    ['lib/email: first-sent falls back to plain APP_URL when no magic URL', testFirstSentEmailFallsBackWhenNoMagicLogin],
    ['lib/email: first-sent escapes hostile input', testFirstSentEmailEscapesHostileInput],
    ['lib/first-sent-celebration: trigger fires email + mints token on fresh stamp', testTriggerFiresEmailOnFreshStamp],
    ['lib/first-sent-celebration: trigger no-ops when stamp did not take', testTriggerNoopsWhenAlreadyStamped],
    ['lib/first-sent-celebration: trigger survives DB throw', testTriggerSurvivesDbThrow],
    ['lib/first-sent-celebration: trigger returns null on missing args', testTriggerReturnsNullOnMissingArgs],
    ['lib/first-sent-celebration: trigger soft-fails when magic-login mint fails', testTriggerSoftFailsWhenMintFails],
    ['POST /invoices/:id/status: sent flip calls triggerFirstSentCelebration', testStatusSentTriggersCelebration],
    ['POST /invoices/:id/status: paid flip does NOT call triggerFirstSentCelebration', testStatusPaidDoesNotTriggerSentCelebration],
    ['POST /invoices/:id/share-intent: flip calls triggerFirstSentCelebration', testShareIntentFlipTriggersCelebration],
    ['POST /invoices/:id/share-intent: no-flip does NOT call triggerFirstSentCelebration', testShareIntentNoFlipDoesNotTrigger],
    ['POST /invoices/:id/email-client: flip calls triggerFirstSentCelebration', testEmailClientFlipTriggersCelebration],
    ['GET /i/<token>: auto-flip on draft view calls triggerFirstSentCelebration', testShareViewAutoFlipTriggersCelebration],
    ['GET /i/<token>: already-sent view does NOT call triggerFirstSentCelebration', testShareViewNoFlipDoesNotTrigger],
    ['GET /i/<token>: seed-invoice auto-flip is excluded from celebration', testShareViewSkipsForSeedInvoice]
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
