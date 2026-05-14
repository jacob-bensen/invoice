'use strict';

/*
 * #145 — Upgrade-modal "What's missing?" feedback widget.
 *
 * Three layers of coverage:
 *
 *   1. Data layer — db.recordFeedbackSignal(): trims + caps message length,
 *      coerces empty fields to null, persists the canonical fields the
 *      route forwards (user_id, source, reason, message, cycle).
 *
 *   2. Route — POST /billing/feedback:
 *      - 200 + row written for authed user with valid reason
 *      - 200 + user_id=null for anonymous submission
 *      - non-whitelisted reason falls through to null (still 200 if message)
 *      - bad source coerced to default 'upgrade-modal'
 *      - missing reason AND missing message → 400 (no row written)
 *      - cycle whitelisted ('monthly'/'annual'); other values → null
 *      - CSRF protection enforced (POST without token → 403, no row written)
 *
 *   3. View — partials/upgrade-modal.ejs:
 *      - <details data-feedback-widget> markup is present in dashboard.ejs
 *      - all five reason radios (too_expensive, missing_feature,
 *        not_ready, still_evaluating, other) render with the expected
 *        radio name + value contract
 *      - submit + thanks + error testids are present so the contract
 *        survives future markup rearrangement
 *      - CSRF token forwarded into the widget
 *      - the widget exists on the invoice-form page too (every gated
 *        surface that includes upgrade-modal must include the widget)
 *
 * Run: node tests/upgrade-feedback-widget.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');
const http = require('http');
const express = require('express');
const session = require('express-session');

// ---------- Mutable test state ------------------------------------------

const recordCalls = [];
let recordReturn = { id: 7, created_at: new Date('2026-05-14T12:00:00Z') };
let recordThrows = false;

function reset() {
  recordCalls.length = 0;
  recordReturn = { id: 7, created_at: new Date('2026-05-14T12:00:00Z') };
  recordThrows = false;
}

// ---------- DB stub -----------------------------------------------------
//
// We let the real db.js module load, then monkey-patch the methods the
// route uses. This keeps the actual recordFeedbackSignal trim/cap logic
// reachable for layer-1 tests via a separate code path that mocks pool.

const realDbModule = require('../db');

const poolStub = {
  queries: [],
  nextResult: { rows: [{ id: 7, created_at: new Date('2026-05-14T12:00:00Z') }] },
  query(text, params) {
    this.queries.push({ text, params });
    return Promise.resolve(this.nextResult);
  }
};

// Capture the real implementation BEFORE we patch the export the route
// will call. Layer-1 tests invoke the real function through a pool stub;
// layer-2 tests invoke the patched stub via HTTP.
const originalRecord = realDbModule.db.recordFeedbackSignal;
const originalPoolQuery = realDbModule.pool.query.bind(realDbModule.pool);

// Layer-1 helper: invoke the real recordFeedbackSignal via a fresh pool stub.
async function callRecordWithPoolStub(input) {
  poolStub.queries.length = 0;
  poolStub.nextResult = { rows: [{ id: 99, created_at: new Date('2026-05-14T13:00:00Z') }] };
  realDbModule.pool.query = poolStub.query.bind(poolStub);
  try {
    return await originalRecord.call(realDbModule.db, input);
  } finally {
    realDbModule.pool.query = originalPoolQuery;
  }
}

// Patch only the method the route under test calls.
realDbModule.db.recordFeedbackSignal = async (input) => {
  recordCalls.push(input);
  if (recordThrows) throw new Error('boom');
  return recordReturn;
};

// Stripe must be stubbed so requiring the billing routes doesn't try to
// open a real client.
require.cache[require.resolve('stripe')] = {
  id: require.resolve('stripe'),
  filename: require.resolve('stripe'),
  loaded: true,
  exports: () => ({
    customers: { create: async () => ({ id: 'cus' }), retrieve: async () => ({}) },
    subscriptions: { retrieve: async () => ({}), update: async () => ({}) },
    checkout: { sessions: { create: async () => ({ url: 'x' }) } },
    billingPortal: { sessions: { create: async () => ({ url: 'x' }) } },
    webhooks: { constructEvent: () => ({ type: 'noop' }) }
  })
};
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';

// Force a clean require of the route so it picks up our patched db.
delete require.cache[require.resolve('../routes/billing')];
const billingRoutes = require('../routes/billing');

const { csrfProtection } = require('../middleware/csrf');

// ---------- App builder -------------------------------------------------

function buildApp({ user, csrf } = {}) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: true }));
  app.use((req, _res, next) => {
    if (user) req.session.user = user;
    if (csrf) req.session.csrfToken = csrf;
    next();
  });
  app.use(csrfProtection);
  app.use('/billing', billingRoutes);
  return app;
}

function postJson(app, p, body, headers) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const bodyStr = JSON.stringify(body);
      const baseHeaders = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        ...(headers || {})
      };
      const req = http.request(
        { hostname: '127.0.0.1', port, path: p, method: 'POST', headers: baseHeaders },
        res => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => server.close(() => {
            let json = null;
            try { json = JSON.parse(data); } catch (e) { /* not json */ }
            resolve({ status: res.statusCode, body: data, json });
          }));
        }
      );
      req.on('error', err => { server.close(); reject(err); });
      req.write(bodyStr);
      req.end();
    });
  });
}

// ---------- Layer 1: db.recordFeedbackSignal ----------------------------

async function testRecordPersistsCanonicalFields() {
  const out = await callRecordWithPoolStub({
    user_id: 42,
    source: 'upgrade-modal',
    reason: 'too_expensive',
    message: '  rent eats my budget  ',
    cycle: 'annual'
  });
  assert.strictEqual(poolStub.queries.length, 1, 'one INSERT issued');
  const q = poolStub.queries[0];
  assert.match(q.text, /INSERT INTO feedback_signals/);
  assert.deepStrictEqual(q.params, [42, 'upgrade-modal', 'too_expensive', 'rent eats my budget', 'annual']);
  assert.strictEqual(out.id, 99);
}

async function testRecordTrimsAndCapsMessageAt1000Chars() {
  const long = 'x'.repeat(1500);
  await callRecordWithPoolStub({
    user_id: 1, source: 'upgrade-modal', reason: 'other',
    message: long, cycle: null
  });
  const message = poolStub.queries[0].params[3];
  assert.strictEqual(message.length, 1000, 'message capped at 1000 chars');
  assert.strictEqual(message, 'x'.repeat(1000));
}

async function testRecordEmptyMessageStoredAsNull() {
  await callRecordWithPoolStub({
    user_id: 1, source: 'upgrade-modal', reason: 'too_expensive',
    message: '   ', cycle: 'monthly'
  });
  assert.strictEqual(poolStub.queries[0].params[3], null,
    'whitespace-only message must be stored as null');
}

async function testRecordAnonymousUserIdIsNull() {
  await callRecordWithPoolStub({
    user_id: null, source: 'pricing-page', reason: 'still_evaluating',
    message: null, cycle: null
  });
  assert.strictEqual(poolStub.queries[0].params[0], null);
  assert.strictEqual(poolStub.queries[0].params[2], 'still_evaluating');
}

// ---------- Layer 2: POST /billing/feedback -----------------------------

async function testFeedbackAuthedUserWritesRowWithUserId() {
  reset();
  const app = buildApp({ user: { id: 17 }, csrf: 'TEST' });
  const r = await postJson(app, '/billing/feedback',
    { source: 'upgrade-modal', reason: 'too_expensive', message: 'too pricey', cycle: 'monthly' },
    { 'X-CSRF-Token': 'TEST' });
  assert.strictEqual(r.status, 200, 'authed POST must succeed');
  assert.strictEqual(r.json.ok, true);
  assert.strictEqual(recordCalls.length, 1);
  assert.deepStrictEqual(recordCalls[0], {
    user_id: 17,
    source: 'upgrade-modal',
    reason: 'too_expensive',
    message: 'too pricey',
    cycle: 'monthly'
  });
}

async function testFeedbackAnonymousSubmissionUserIdIsNull() {
  reset();
  const app = buildApp({ csrf: 'TEST' });
  const r = await postJson(app, '/billing/feedback',
    { source: 'pricing-page', reason: 'still_evaluating' },
    { 'X-CSRF-Token': 'TEST' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(recordCalls[0].user_id, null);
  assert.strictEqual(recordCalls[0].source, 'pricing-page');
}

async function testFeedbackInvalidReasonCoercedToNullStillAcceptedWithMessage() {
  reset();
  const app = buildApp({ user: { id: 1 }, csrf: 'TEST' });
  const r = await postJson(app, '/billing/feedback',
    { source: 'upgrade-modal', reason: 'haxxor_bucket', message: 'I want X' },
    { 'X-CSRF-Token': 'TEST' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(recordCalls[0].reason, null,
    'unknown reason must be coerced to null, not stored as the attacker-supplied string');
  assert.strictEqual(recordCalls[0].message, 'I want X');
}

async function testFeedbackBadSourceCoercedToDefault() {
  reset();
  const app = buildApp({ user: { id: 1 }, csrf: 'TEST' });
  await postJson(app, '/billing/feedback',
    { source: 'attacker-source', reason: 'too_expensive' },
    { 'X-CSRF-Token': 'TEST' });
  assert.strictEqual(recordCalls[0].source, 'upgrade-modal',
    'unknown source must be coerced to the default "upgrade-modal"');
}

async function testFeedbackMissingReasonAndMessageReturns400() {
  reset();
  const app = buildApp({ user: { id: 1 }, csrf: 'TEST' });
  const r = await postJson(app, '/billing/feedback',
    { source: 'upgrade-modal' },
    { 'X-CSRF-Token': 'TEST' });
  assert.strictEqual(r.status, 400, 'empty submission must be rejected');
  assert.strictEqual(recordCalls.length, 0, 'no DB row may be written for empty submission');
}

async function testFeedbackCycleWhitelisted() {
  reset();
  const app = buildApp({ user: { id: 1 }, csrf: 'TEST' });
  await postJson(app, '/billing/feedback',
    { reason: 'too_expensive', cycle: 'lifetime' },
    { 'X-CSRF-Token': 'TEST' });
  assert.strictEqual(recordCalls[0].cycle, null,
    'cycle outside the monthly|annual whitelist must be null');
  reset();
  await postJson(app, '/billing/feedback',
    { reason: 'too_expensive', cycle: 'annual' },
    { 'X-CSRF-Token': 'TEST' });
  assert.strictEqual(recordCalls[0].cycle, 'annual');
}

async function testFeedbackCsrfEnforced() {
  reset();
  const app = buildApp({ user: { id: 1 }, csrf: 'TEST' });
  const r = await postJson(app, '/billing/feedback',
    { reason: 'too_expensive' },
    { /* no x-csrf-token header */ });
  assert.strictEqual(r.status, 403, 'missing CSRF must produce a 403');
  assert.strictEqual(recordCalls.length, 0, 'no row written when CSRF rejected');
}

async function testFeedbackDbErrorReturns500() {
  reset();
  recordThrows = true;
  const app = buildApp({ user: { id: 1 }, csrf: 'TEST' });
  const r = await postJson(app, '/billing/feedback',
    { reason: 'too_expensive' },
    { 'X-CSRF-Token': 'TEST' });
  assert.strictEqual(r.status, 500);
  assert.strictEqual(r.json.ok, false);
  recordThrows = false;
}

// ---------- Layer 3: view source assertions -----------------------------

const VIEWS = path.join(__dirname, '..', 'views');

function renderDashboard() {
  return ejs.renderFile(path.join(VIEWS, 'dashboard.ejs'), {
    title: 'Dashboard',
    user: { id: 1, plan: 'free', name: 'Test' },
    invoices: [],
    total: 0,
    paid: 0,
    outstanding: 0,
    flash: null,
    csrfToken: 'CSRF_TOK',
    trialCountdown: null,
    onboarding: null,
    recentRevenue: null,
    recentRevenueWindow: 30,
    annualUpgradePrompt: null
  }, { views: [VIEWS], filename: path.join(VIEWS, 'dashboard.ejs') });
}

async function testWidgetMarkupOnDashboard() {
  const html = await renderDashboard();
  assert.match(html, /data-feedback-widget/,
    'feedback widget must render inside the dashboard upgrade modal');
  assert.match(html, /<summary[^>]*>[\s\S]*?Tell us what's missing[\s\S]*?<\/summary>/,
    'disclosure summary text must be present');
}

async function testWidgetReasonRadios() {
  const html = await renderDashboard();
  for (const value of [
    'too_expensive', 'missing_feature', 'not_ready', 'still_evaluating', 'other'
  ]) {
    const re = new RegExp(`name="reason"[^>]*value="${value}"`);
    assert.match(html, re, `radio for reason="${value}" must be present`);
  }
}

async function testWidgetTestidsAndCsrf() {
  const html = await renderDashboard();
  assert.match(html, /data-testid="upgrade-feedback-form"/);
  assert.match(html, /data-testid="upgrade-feedback-submit"/);
  assert.match(html, /data-testid="upgrade-feedback-thanks"/);
  assert.match(html, /data-testid="upgrade-feedback-error"/);
  // CSRF token forwarded inside the widget form
  const widgetStart = html.indexOf('data-feedback-widget');
  const widgetEnd = html.indexOf('</details>', widgetStart);
  const widgetHtml = html.slice(widgetStart, widgetEnd);
  assert.match(widgetHtml, /name="_csrf"\s+value="CSRF_TOK"/);
  assert.match(widgetHtml, /name="source"\s+value="upgrade-modal"/);
}

async function testWidgetOnInvoiceFormToo() {
  // The invoice-form page also includes the upgrade modal — the widget
  // must travel with it so a user who hits the limit while creating an
  // invoice gets the same close-without-upgrade capture surface.
  const formHtml = await ejs.renderFile(path.join(VIEWS, 'invoice-form.ejs'), {
    title: 'New Invoice',
    user: { id: 1, plan: 'free', name: 'Test' },
    invoice: null,
    invoiceNumber: 'INV-2026-0001',
    flash: null,
    csrfToken: 'CSRF_TOK',
    trialCountdown: null,
    recentClients: []
  }, { views: [VIEWS], filename: path.join(VIEWS, 'invoice-form.ejs') });
  assert.match(formHtml, /data-feedback-widget/,
    'feedback widget must travel with upgrade-modal onto invoice-form');
}

// ---------- Runner ------------------------------------------------------

const tests = [
  ['db: recordFeedbackSignal persists canonical fields', testRecordPersistsCanonicalFields],
  ['db: message capped at 1000 chars', testRecordTrimsAndCapsMessageAt1000Chars],
  ['db: whitespace-only message stored as null', testRecordEmptyMessageStoredAsNull],
  ['db: anonymous (user_id=null) writes null', testRecordAnonymousUserIdIsNull],
  ['route: authed POST writes row with user_id', testFeedbackAuthedUserWritesRowWithUserId],
  ['route: anonymous POST writes user_id=null', testFeedbackAnonymousSubmissionUserIdIsNull],
  ['route: invalid reason coerced to null, accepted with message', testFeedbackInvalidReasonCoercedToNullStillAcceptedWithMessage],
  ['route: bad source coerced to default upgrade-modal', testFeedbackBadSourceCoercedToDefault],
  ['route: missing reason+message → 400, no row', testFeedbackMissingReasonAndMessageReturns400],
  ['route: cycle whitelisted, others coerced to null', testFeedbackCycleWhitelisted],
  ['route: CSRF enforced (no header → 403, no row)', testFeedbackCsrfEnforced],
  ['route: db error → 500 ok:false', testFeedbackDbErrorReturns500],
  ['view: widget markup renders on dashboard', testWidgetMarkupOnDashboard],
  ['view: all 5 reason radios render', testWidgetReasonRadios],
  ['view: testids + CSRF forwarded in widget', testWidgetTestidsAndCsrf],
  ['view: widget travels onto invoice-form', testWidgetOnInvoiceFormToo]
];

async function run() {
  let passed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ ${name}`);
      console.error(err);
      process.exitCode = 1;
    }
  }
  console.log(`\nupgrade-feedback-widget.test.js: ${passed}/${tests.length} passed`);
}

run();
