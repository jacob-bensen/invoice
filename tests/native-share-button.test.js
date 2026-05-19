'use strict';

/*
 * Native Web Share API button on /invoices/:id (Milestone 3 — first
 * invoice created → first invoice sent).
 *
 * The existing WhatsApp/SMS/Email share intents cover ~80% of consumer
 * messaging in North America + much of Europe, but exclude the targets
 * that dominate other freelancer markets and B2B agency comms: Telegram
 * (large in Europe, MENA, Asia), Signal (privacy-conscious clients),
 * Slack / Teams (B2B agencies), Facebook Messenger / Instagram DMs
 * (small-business clients), Discord (creator clients), and the OS-level
 * AirDrop / nearby-share for in-person hand-offs. navigator.share() —
 * the Web Share API — lifts a single button that opens the device's
 * native share sheet, letting the freelancer pick whatever installed
 * app makes sense. Supported on iOS Safari 12.2+, Android Chrome 75+,
 * desktop Safari, Edge, Opera; gracefully hidden on Firefox (no support).
 *
 * The button fires the same /share-intent endpoint as the other share
 * targets so the existing draft → sent auto-flip continues to fire on
 * activation-funnel `sent_one` for users who pick a non-WhatsApp/SMS/
 * Email target. Intent kind 'native' is added to SHARE_INTENT_KINDS.
 *
 * Run: NODE_ENV=test node tests/native-share-button.test.js
 */

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

const assert = require('assert');
const path = require('path');
const ejs = require('ejs');
const express = require('express');
const session = require('express-session');
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

// ---------- Route layer: SHARE_INTENT_KINDS accepts 'native' ------------

function buildInvoiceApp({ invoiceRow, markResult }) {
  const calls = { mark: [] };
  const restorePg = stubPg(async () => ({ rows: [], rowCount: 0 }));
  // routes/invoices.js: `const { db } = require('../db');`
  const dbApi = {
    async getInvoiceById(id, uid) {
      if (!invoiceRow) return null;
      if (Number(invoiceRow.user_id) !== Number(uid)) return null;
      if (Number(invoiceRow.id) !== Number(id)) return null;
      return invoiceRow;
    },
    async markInvoiceSentFromShareIntent(id, uid) {
      calls.mark.push({ id, uid });
      return markResult;
    },
    async getInvoicesByUser() { return []; },
    async getRecentRevenueStats() { return null; },
    async getNextInvoiceNumber() { return 'INV-2026-0001'; },
    async getOrCreatePublicToken() { return 'tokentokentoken'; }
  };
  require.cache[require.resolve('../db')] = {
    id: require.resolve('../db'), filename: require.resolve('../db'),
    loaded: true, exports: { db: dbApi, pool: { query: async () => ({ rows: [], rowCount: 0 }) } }
  };
  delete require.cache[require.resolve('../routes/invoices')];
  const invoiceRoutes = require('../routes/invoices');
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', VIEWS);
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, res, next) => {
    req.session.user = { id: 7, plan: 'free' };
    next();
  });
  app.use('/invoices', invoiceRoutes);
  app.__restore = restorePg;
  return { app, calls };
}

function postIntent(app, id, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const payload = JSON.stringify(body);
      const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      };
      const req = http.request({
        hostname: '127.0.0.1', port, path: `/invoices/${id}/share-intent`,
        method: 'POST', headers
      }, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => server.close(() => resolve({ status: res.statusCode, body: data, headers: res.headers })));
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.write(payload);
      req.end();
    });
  });
}

async function testRouteAcceptsNativeIntent() {
  const { app, calls } = buildInvoiceApp({
    invoiceRow: { id: 5, user_id: 7, status: 'draft', invoice_number: 'INV-1' },
    markResult: { id: 5, status: 'sent', sent_via_share_intent_at: new Date() }
  });
  const r = await postIntent(app, 5, { intent: 'native' });
  assert.strictEqual(r.status, 200, 'native intent accepted; got ' + r.status + ' body=' + r.body);
  const body = JSON.parse(r.body);
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.intent, 'native');
  assert.strictEqual(body.flipped, true, 'draft flips to sent on native share');
  assert.strictEqual(body.status, 'sent');
  assert.deepStrictEqual(calls.mark, [{ id: 5, uid: 7 }],
    'mark helper runs once with the invoice id + session user id');
  app.__restore();
}

async function testRouteNativeIntentIdempotentOnAlreadySent() {
  const { app } = buildInvoiceApp({
    invoiceRow: { id: 5, user_id: 7, status: 'sent', invoice_number: 'INV-1' },
    markResult: { id: 5, status: 'sent', sent_via_share_intent_at: null }
  });
  const r = await postIntent(app, 5, { intent: 'native' });
  assert.strictEqual(r.status, 200, 'replay of native share on already-sent stays 200');
  const body = JSON.parse(r.body);
  assert.strictEqual(body.flipped, false, 'flipped=false on already-sent native replay');
  assert.strictEqual(body.status, 'sent');
  app.__restore();
}

async function testRouteRejectsUnknownIntentStillWorks() {
  // Belt-and-braces — adding 'native' must not accidentally relax the
  // whitelist for arbitrary strings.
  const { app, calls } = buildInvoiceApp({
    invoiceRow: { id: 5, user_id: 7, status: 'draft' },
    markResult: null
  });
  const r = await postIntent(app, 5, { intent: 'airdrop' });
  assert.strictEqual(r.status, 400, 'unknown intent kind still rejected');
  assert.ok(r.body.includes('invalid_intent'),
    'rejection names the failure mode; got: ' + r.body);
  assert.strictEqual(calls.mark.length, 0,
    'DB write must NOT fire on unknown intent kind');
  app.__restore();
}

// ---------- View wiring -------------------------------------------------

async function renderInvoiceView({ userPlan, payment_link_url }) {
  return ejs.renderFile(path.join(VIEWS, 'invoice-view.ejs'), {
    title: 'Invoice',
    user: { plan: userPlan, email: 'me@example.com', name: 'Me', business_name: null },
    invoice: {
      id: 5,
      invoice_number: 'INV-2026-0001',
      status: 'draft',
      issued_date: new Date('2026-05-01'),
      due_date: new Date('2026-05-31'),
      client_name: 'Acme',
      client_email: 'acme@x.example',
      client_address: '',
      items: [{ description: 'Work', quantity: 1, unit_price: 100 }],
      subtotal: 100, tax_rate: 0, tax_amount: 0, total: 100,
      notes: null,
      payment_link_url: payment_link_url || null
    },
    paymentMethods: ['card'],
    csrfToken: 'test-csrf-token',
    flash: null
  }, { views: [VIEWS] });
}

async function testPublicShareSectionRendersNativeButton() {
  const html = await renderInvoiceView({ userPlan: 'free' });
  const sectionStart = html.indexOf('data-testid="public-share-section"');
  assert.ok(sectionStart >= 0, 'public-share-section present');
  const sectionEnd = html.indexOf('<!-- Payment Link', sectionStart);
  const section = html.slice(sectionStart, sectionEnd > 0 ? sectionEnd : html.length);

  assert.ok(/data-testid="public-share-native"/.test(section),
    'native share button rendered in public-share-section');
  // Gated on nativeShareSupported so unsupported browsers (Firefox) never
  // surface a dead-end button.
  assert.ok(/x-show="nativeShareSupported"[\s\S]{0,400}data-testid="public-share-native"|data-testid="public-share-native"[\s\S]{0,400}x-show="nativeShareSupported"/.test(section)
    || /data-testid="public-share-native"[\s\S]*?x-show="nativeShareSupported"/.test(section)
    || /x-show="nativeShareSupported"[\s\S]*?data-testid="public-share-native"/.test(section),
    'native share button must be gated by x-show="nativeShareSupported" so Firefox / older browsers do not render a dead-end button');
  // Auto-flip wired via fireIntent('native').
  assert.ok(/data-testid="public-share-native"[\s\S]{0,500}fireIntent\(['"]native['"]\)/.test(section),
    'native share button must call fireIntent("native") so draft → sent flips even when the user picks a non-WhatsApp/SMS/Email target');
  // navigator.share called via the nativeShare() helper.
  assert.ok(/data-testid="public-share-native"[\s\S]{0,500}nativeShare\(/.test(section),
    'native share button must call nativeShare(...) so the OS share sheet actually opens');
  // Carries data-share="native" to mirror the data-share convention.
  assert.ok(/data-share="native"[\s\S]{0,500}data-testid="public-share-native"|data-testid="public-share-native"[\s\S]{0,500}data-share="native"/.test(section),
    'native share button must carry data-share="native"');
}

async function testPublicShareSectionDetectsNativeShareInInit() {
  const html = await renderInvoiceView({ userPlan: 'free' });
  const sectionStart = html.indexOf('data-testid="public-share-section"');
  assert.ok(sectionStart >= 0);
  const sectionEnd = html.indexOf('<!-- Payment Link', sectionStart);
  const section = html.slice(sectionStart, sectionEnd > 0 ? sectionEnd : html.length);
  // The x-data declaration includes the default false state.
  assert.ok(/nativeShareSupported:\s*false/.test(section),
    'nativeShareSupported defaults to false so the button stays hidden until init proves support');
  // The x-init expression flips the flag when navigator.share exists.
  assert.ok(/navigator\.share[\s\S]{0,200}nativeShareSupported\s*=\s*true|nativeShareSupported\s*=\s*true[\s\S]{0,400}navigator\.share/.test(section),
    'x-init must flip nativeShareSupported to true when navigator.share is a function');
}

async function testPublicShareNativeUsesPrefetchedIntents() {
  // The button must pass the prefilled subject/body/url from the prefetched
  // intents object to navigator.share so the share sheet target receives a
  // ready-to-send payload (matches the WhatsApp/SMS/Email parity contract).
  const html = await renderInvoiceView({ userPlan: 'free' });
  const sectionStart = html.indexOf('data-testid="public-share-native"');
  const window = html.slice(sectionStart, sectionStart + 700);
  assert.ok(/nativeShare\(\s*\{[\s\S]{0,300}title:\s*\(?intents/.test(window),
    'nativeShare() must read title from the prefetched intents.subject');
  assert.ok(/nativeShare\(\s*\{[\s\S]{0,300}text:\s*\(?intents/.test(window),
    'nativeShare() must read text from the prefetched intents.body');
  assert.ok(/nativeShare\(\s*\{[\s\S]{0,300}url:\s*url/.test(window),
    'nativeShare() must pass the share url straight through');
}

async function testProPayLinkSectionRendersNativeButton() {
  const html = await renderInvoiceView({
    userPlan: 'pro',
    payment_link_url: 'https://buy.stripe.com/test_xyz'
  });
  const sectionStart = html.indexOf('Payment Link');
  assert.ok(sectionStart >= 0, 'Pro pay-link section present');
  const section = html.slice(sectionStart);
  assert.ok(/data-testid="pay-link-share-native"/.test(section),
    'native share button rendered in Pro pay-link section');
  assert.ok(/data-testid="pay-link-share-native"[\s\S]{0,800}fireIntent\(['"]native['"]\)/.test(section),
    'Pro pay-link native button must call fireIntent("native")');
  assert.ok(/data-testid="pay-link-share-native"[\s\S]{0,800}nativeShare\(/.test(section),
    'Pro pay-link native button must call nativeShare(...)');
  // The Stripe URL must reach the share sheet so the recipient gets a
  // working pay link, not the public /i/<token> URL (Pro share parity).
  assert.ok(/data-testid="pay-link-share-native"[\s\S]{0,800}buy\.stripe\.com\/test_xyz/.test(section),
    'Pro pay-link native button must pass the Stripe payment link URL to navigator.share');
}

async function testProPayLinkDetectsNativeShareInInit() {
  const html = await renderInvoiceView({
    userPlan: 'pro',
    payment_link_url: 'https://buy.stripe.com/test_xyz'
  });
  const sectionStart = html.indexOf('Payment Link');
  const section = html.slice(sectionStart);
  assert.ok(/nativeShareSupported:\s*false/.test(section),
    'Pro pay-link nativeShareSupported defaults to false');
  assert.ok(/navigator\.share[\s\S]{0,200}nativeShareSupported\s*=\s*true/.test(section),
    'Pro pay-link x-init must flip nativeShareSupported on navigator.share present');
}

async function testNativeShareHelperSwallowsErrors() {
  // navigator.share() rejects when the user cancels the share sheet (and
  // on a few other DOMExceptions). That rejection must NOT bubble up as
  // an unhandled promise — wrap with .catch() the same way fireIntent's
  // fetch is wrapped.
  const html = await renderInvoiceView({ userPlan: 'free' });
  assert.ok(/nativeShare\(data\)[\s\S]{0,400}navigator\.share\(data\)[\s\S]{0,200}\.catch\(/.test(html),
    'nativeShare helper must .catch() the navigator.share() promise so user-cancel never surfaces an unhandled rejection');
}

async function testNativeShareHelperGuardsOnFeatureDetection() {
  // The helper must double-check navigator.share is a function before
  // calling it — a browser-extension shim that defined navigator.share
  // as a non-function value (boolean true, an object, etc) would otherwise
  // throw when invoked.
  const html = await renderInvoiceView({ userPlan: 'free' });
  assert.ok(/nativeShare\(data\)[\s\S]{0,300}typeof\s+navigator\.share\s*===\s*['"]function['"]/.test(html),
    'nativeShare helper must guard on typeof navigator.share === "function" before invoking');
}

// ---------- runner ------------------------------------------------------

async function run() {
  const tests = [
    ['route: native intent flips draft → sent + returns ok', testRouteAcceptsNativeIntent],
    ['route: native intent idempotent on already-sent', testRouteNativeIntentIdempotentOnAlreadySent],
    ['route: whitelist still rejects unknown intents', testRouteRejectsUnknownIntentStillWorks],
    ['view: public-share-section renders the native button', testPublicShareSectionRendersNativeButton],
    ['view: public-share-section detects navigator.share in x-init', testPublicShareSectionDetectsNativeShareInInit],
    ['view: public-share native button passes prefetched intents to nativeShare', testPublicShareNativeUsesPrefetchedIntents],
    ['view: Pro pay-link section renders the native button', testProPayLinkSectionRendersNativeButton],
    ['view: Pro pay-link detects navigator.share in x-init', testProPayLinkDetectsNativeShareInInit],
    ['view: nativeShare helper .catch()es promise rejections', testNativeShareHelperSwallowsErrors],
    ['view: nativeShare helper guards on typeof navigator.share', testNativeShareHelperGuardsOnFeatureDetection]
  ];
  let passed = 0;
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log('  ok  ' + name);
      passed++;
    } catch (e) {
      console.error('  FAIL  ' + name);
      console.error('    ' + (e && e.stack ? e.stack : e));
      failed++;
    }
  }
  console.log('');
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch(e => { console.error(e); process.exit(1); });
