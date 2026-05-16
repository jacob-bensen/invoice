'use strict';

/*
 * Public read-only invoice URL `/i/:token` tests (#43).
 *
 * Covers:
 *   - db.getOrCreatePublicToken: SELECT-then-UPDATE shape, idempotent return
 *     of the existing token, 23505 retry on UNIQUE collision, scope by
 *     user_id, missing-invoice + missing-args short-circuits.
 *   - db.getInvoiceByPublicToken: hex-format pre-validation (no SQL on
 *     garbage), JOIN to users shape, returns null on miss.
 *   - lib/share-link.buildPublicInvoiceUrl: absolute URL when APP_URL set,
 *     relative fallback when unset, empty string for bad tokens.
 *   - lib/share-link.isValidPublicToken: hex 8-32 contract.
 *   - POST /invoices/:id/share: 401 unauth, 404 missing invoice, 200 +
 *     {url, token} for every plan (free, Pro, Agency).
 *   - GET /i/:token: 404 on bad-format token (no SQL), 404 on miss, 200 +
 *     full invoice + payment-now CTA only when owner is Pro/Agency, no
 *     owner-only edit/delete UI, noindex meta.
 *   - views/invoice-public.ejs: standalone render with payment link / without,
 *     HTML-escape of hostile owner / client / line-item fields,
 *     Powered-by-DecentInvoice attribution.
 *   - views/invoice-view.ejs: every plan surfaces public-share-section;
 *     free additionally surfaces a missing-Pay-button upgrade nudge;
 *     Pro/Agency does NOT see that nudge.
 *
 * Run: NODE_ENV=test node tests/public-share-link.test.js
 */

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
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

// ---------- db.getOrCreatePublicToken ------------------------------------

async function testGetOrCreatePublicTokenReturnsExisting() {
  const queries = [];
  const restore = stubPg(async (text, params) => {
    queries.push({ text, params });
    return { rows: [{ public_token: 'cafef00ddeadbeef' }] };
  });
  try {
    const { db } = require('../db');
    const t = await db.getOrCreatePublicToken(42, 7);
    assert.strictEqual(t, 'cafef00ddeadbeef');
    assert.strictEqual(queries.length, 1,
      'existing-token path issues exactly one SELECT — no UPDATE');
    assert.ok(/SELECT\s+public_token\s+FROM\s+invoices/i.test(queries[0].text),
      'must SELECT the existing token first');
    assert.ok(/WHERE\s+id\s*=\s*\$1\s+AND\s+user_id\s*=\s*\$2/i.test(queries[0].text),
      'lookup must be scoped by both invoice id and user_id');
    assert.deepStrictEqual(queries[0].params, [42, 7]);
  } finally { restore(); }
}

async function testGetOrCreatePublicTokenGeneratesWhenMissing() {
  const queries = [];
  const restore = stubPg(async (text, params) => {
    queries.push({ text, params });
    if (/^\s*SELECT/i.test(text)) return { rows: [{ public_token: null }] };
    return { rows: [{ public_token: params[2] }] };
  });
  try {
    const { db } = require('../db');
    const t = await db.getOrCreatePublicToken(99, 3);
    assert.ok(/^[a-f0-9]{16}$/.test(t),
      `generated token must be 16 hex chars, got "${t}"`);
    assert.strictEqual(queries.length, 2,
      'generate path issues one SELECT + one UPDATE');
    const update = queries[1];
    assert.ok(/UPDATE\s+invoices[\s\S]*SET[\s\S]*public_token/i.test(update.text),
      'must UPDATE invoices.public_token');
    assert.ok(/public_token\s+IS\s+NULL/i.test(update.text),
      'UPDATE must guard on public_token IS NULL for concurrency safety');
    assert.ok(/user_id\s*=\s*\$2/i.test(update.text),
      'UPDATE must be scoped by user_id so a caller cannot mint a token on someone else\'s invoice');
  } finally { restore(); }
}

async function testGetOrCreatePublicTokenRetriesOn23505() {
  let updateCalls = 0;
  const restore = stubPg(async (text, params) => {
    if (/^\s*SELECT/i.test(text)) return { rows: [{ public_token: null }] };
    updateCalls++;
    if (updateCalls === 1) {
      const err = new Error('duplicate key value violates unique constraint');
      err.code = '23505';
      throw err;
    }
    return { rows: [{ public_token: params[2] }] };
  });
  try {
    const { db } = require('../db');
    const t = await db.getOrCreatePublicToken(1, 1);
    assert.ok(/^[a-f0-9]{16}$/.test(t), 'eventually returns a valid token after retry');
    assert.strictEqual(updateCalls, 2, 'must retry exactly once after a 23505');
  } finally { restore(); }
}

async function testGetOrCreatePublicTokenReturnsNullForMissingInvoice() {
  const restore = stubPg(async () => ({ rows: [] }));
  try {
    const { db } = require('../db');
    const t = await db.getOrCreatePublicToken(123, 7);
    assert.strictEqual(t, null,
      'returns null when SELECT finds no row owned by this user');
  } finally { restore(); }
}

async function testGetOrCreatePublicTokenShortCircuitsOnBadArgs() {
  const calls = [];
  const restore = stubPg(async (text, params) => { calls.push({ text, params }); return { rows: [] }; });
  try {
    const { db } = require('../db');
    assert.strictEqual(await db.getOrCreatePublicToken(null, 7), null);
    assert.strictEqual(await db.getOrCreatePublicToken(0, 7), null);
    assert.strictEqual(await db.getOrCreatePublicToken(1, null), null);
    assert.strictEqual(await db.getOrCreatePublicToken(undefined, undefined), null);
    assert.strictEqual(calls.length, 0,
      'bad-args paths issue zero DB queries');
  } finally { restore(); }
}

// ---------- db.getInvoiceByPublicToken -----------------------------------

async function testGetInvoiceByPublicTokenSqlShape() {
  const captured = [];
  const restore = stubPg(async (text, params) => {
    captured.push({ text, params });
    return { rows: [{
      id: 5, invoice_number: 'INV-2026-0001', client_name: 'Acme',
      items: [], subtotal: '100', total: '100', tax_rate: '0', tax_amount: '0',
      status: 'sent', payment_link_url: 'https://buy.stripe.com/x',
      owner_business_name: 'My LLC', owner_plan: 'pro'
    }] };
  });
  try {
    const { db } = require('../db');
    const row = await db.getInvoiceByPublicToken('cafef00ddeadbeef');
    assert.strictEqual(captured.length, 1);
    const q = captured[0];
    assert.ok(/FROM\s+invoices\s+i\s+JOIN\s+users\s+u\s+ON\s+u\.id\s*=\s*i\.user_id/i.test(q.text),
      'must JOIN invoices to users so a single round-trip returns owner branding');
    assert.ok(/WHERE\s+i\.public_token\s*=\s*\$1/i.test(q.text),
      'must look up by public_token');
    assert.ok(/owner_business_name/i.test(q.text),
      'must select the owner branding fields needed by the public template');
    assert.ok(/owner_plan/i.test(q.text),
      'must select owner plan so the template can gate the Pay-now CTA');
    assert.deepStrictEqual(q.params, ['cafef00ddeadbeef']);
    assert.strictEqual(row.invoice_number, 'INV-2026-0001');
  } finally { restore(); }
}

async function testGetInvoiceByPublicTokenRejectsBadFormatBeforeSql() {
  const calls = [];
  const restore = stubPg(async (text, params) => { calls.push({ text, params }); return { rows: [] }; });
  try {
    const { db } = require('../db');
    assert.strictEqual(await db.getInvoiceByPublicToken(null), null);
    assert.strictEqual(await db.getInvoiceByPublicToken(''), null);
    assert.strictEqual(await db.getInvoiceByPublicToken('abc'), null,
      'too-short rejected without SQL');
    assert.strictEqual(await db.getInvoiceByPublicToken('not-hex!!'), null,
      'punctuation rejected without SQL');
    assert.strictEqual(await db.getInvoiceByPublicToken('<script>'), null,
      'angle brackets rejected without SQL');
    assert.strictEqual(await db.getInvoiceByPublicToken('a'.repeat(40)), null,
      'too-long rejected without SQL');
    assert.strictEqual(calls.length, 0,
      'no DB query is issued for bad-format tokens');
  } finally { restore(); }
}

async function testGetInvoiceByPublicTokenReturnsNullOnMiss() {
  const restore = stubPg(async () => ({ rows: [] }));
  try {
    const { db } = require('../db');
    const row = await db.getInvoiceByPublicToken('deadbeefcafef00d');
    assert.strictEqual(row, null,
      'returns null when the token does not match any invoice');
  } finally { restore(); }
}

// ---------- lib/share-link ------------------------------------------------

function testBuildPublicInvoiceUrlRespectsAppUrl() {
  delete require.cache[require.resolve('../lib/share-link')];
  const prior = process.env.APP_URL;
  process.env.APP_URL = 'https://decentinvoice.com/';
  try {
    const { buildPublicInvoiceUrl } = require('../lib/share-link');
    assert.strictEqual(buildPublicInvoiceUrl('cafef00ddeadbeef'),
      'https://decentinvoice.com/i/cafef00ddeadbeef');
  } finally {
    if (prior == null) delete process.env.APP_URL;
    else process.env.APP_URL = prior;
  }
}

function testBuildPublicInvoiceUrlFallsBackToRelative() {
  delete require.cache[require.resolve('../lib/share-link')];
  const prior = process.env.APP_URL;
  delete process.env.APP_URL;
  try {
    const { buildPublicInvoiceUrl } = require('../lib/share-link');
    assert.strictEqual(buildPublicInvoiceUrl('cafef00ddeadbeef'), '/i/cafef00ddeadbeef',
      'falls back to /i/<token> when APP_URL is unset');
  } finally {
    if (prior) process.env.APP_URL = prior;
  }
}

function testBuildPublicInvoiceUrlRejectsBadTokens() {
  delete require.cache[require.resolve('../lib/share-link')];
  const { buildPublicInvoiceUrl } = require('../lib/share-link');
  assert.strictEqual(buildPublicInvoiceUrl(null), '');
  assert.strictEqual(buildPublicInvoiceUrl(''), '');
  assert.strictEqual(buildPublicInvoiceUrl('abc'), '',
    'too-short token returns empty string');
  assert.strictEqual(buildPublicInvoiceUrl('<script>'), '',
    'hostile input returns empty string');
}

function testIsValidPublicTokenContract() {
  const { isValidPublicToken } = require('../lib/share-link');
  assert.ok(isValidPublicToken('abcdef0123456789'));
  assert.ok(isValidPublicToken('ABCDEF0123456789'));
  assert.ok(!isValidPublicToken('abc'));
  assert.ok(!isValidPublicToken('abcdef0123456789xyz'),
    'non-hex characters rejected');
  assert.ok(!isValidPublicToken('a'.repeat(40)),
    'lengths over 32 rejected');
  assert.ok(!isValidPublicToken(null));
  assert.ok(!isValidPublicToken(42));
}

// ---------- POST /invoices/:id/share -------------------------------------

function buildShareApp({ userPlan, invoiceRow, token }) {
  const dbStub = {
    pool: { query: async () => ({ rows: [] }) },
    db: {
      async getUserById() { return { id: 7, plan: userPlan }; },
      async getInvoiceById(id, uid) {
        if (!invoiceRow) return null;
        return Object.assign({ user_id: uid }, invoiceRow);
      },
      async getOrCreatePublicToken() { return token; },
      async getInvoicesByUser() { return []; },
      async getRecentRevenueStats() { return null; },
      async getNextInvoiceNumber() { return 'INV-2026-0001'; }
    }
  };
  require.cache[require.resolve('../db')] = {
    id: require.resolve('../db'), filename: require.resolve('../db'),
    loaded: true, exports: dbStub
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
    if (req.headers['x-test-anon'] !== '1') req.session.user = { id: 7, plan: userPlan };
    next();
  });
  app.use('/invoices', invoiceRoutes);
  return app;
}

function postShare(app, id, anonymous) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
      if (anonymous) headers['x-test-anon'] = '1';
      const req = http.request({
        hostname: '127.0.0.1', port, path: `/invoices/${id}/share`, method: 'POST', headers
      }, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => server.close(() => resolve({ status: res.statusCode, body: data })));
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.end();
    });
  });
}

async function testShareEndpointProReturnsUrl() {
  process.env.APP_URL = 'https://decentinvoice.com';
  delete require.cache[require.resolve('../lib/share-link')];
  const app = buildShareApp({
    userPlan: 'pro',
    invoiceRow: { id: 5, invoice_number: 'INV-2026-0001' },
    token: 'cafef00ddeadbeef'
  });
  const r = await postShare(app, 5);
  assert.strictEqual(r.status, 200);
  const body = JSON.parse(r.body);
  assert.strictEqual(body.token, 'cafef00ddeadbeef');
  assert.strictEqual(body.url, 'https://decentinvoice.com/i/cafef00ddeadbeef');
  delete process.env.APP_URL;
}

async function testShareEndpointAgencyReturnsUrl() {
  const app = buildShareApp({
    userPlan: 'agency',
    invoiceRow: { id: 5, invoice_number: 'INV-2026-0001' },
    token: 'beefbeefbeefbeef'
  });
  const r = await postShare(app, 5);
  assert.strictEqual(r.status, 200,
    'Agency plan must succeed exactly like Pro');
  const body = JSON.parse(r.body);
  assert.strictEqual(body.token, 'beefbeefbeefbeef');
}

async function testShareEndpointFreeMintsUrl() {
  // Free users get the share URL too — it's the activation funnel's only
  // in-app way to deliver an invoice to a client (no email-send, no
  // Stripe payment link). The Pro upgrade pressure rides the share
  // surface itself (no Pay button on the public page) instead of a 403.
  const app = buildShareApp({
    userPlan: 'free',
    invoiceRow: { id: 5, invoice_number: 'INV-2026-0001' },
    token: 'cafef00ddeadbeef'
  });
  const r = await postShare(app, 5);
  assert.strictEqual(r.status, 200,
    'free users must succeed — the share URL is the only delivery path on the free tier');
  const body = JSON.parse(r.body);
  assert.strictEqual(body.token, 'cafef00ddeadbeef');
  assert.ok(body.url && /\/i\/cafef00ddeadbeef$/.test(body.url),
    'response must carry the /i/<token> URL just like the Pro path');
}

async function testShareEndpointAuthRequired() {
  const app = buildShareApp({
    userPlan: 'pro',
    invoiceRow: { id: 5 },
    token: 'cafef00ddeadbeef'
  });
  const r = await postShare(app, 5, true);
  assert.strictEqual(r.status, 302,
    'unauth POST redirects through requireAuth to /auth/login');
}

async function testShareEndpoint404OnMissingInvoice() {
  const app = buildShareApp({
    userPlan: 'pro',
    invoiceRow: null,
    token: 'cafef00ddeadbeef'
  });
  const r = await postShare(app, 999);
  assert.strictEqual(r.status, 404);
}

// ---------- GET /i/:token ------------------------------------------------

function buildShareViewApp({ invoiceRow }) {
  const dbStub = {
    pool: { query: async () => ({ rows: [] }) },
    db: {
      async getInvoiceByPublicToken(token) {
        if (!/^[a-f0-9]{8,32}$/i.test(token || '')) return null;
        return invoiceRow;
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
  return app;
}

function getPath(app, urlPath) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      http.get({ hostname: '127.0.0.1', port, path: urlPath }, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => server.close(() => resolve({ status: res.statusCode, body: data })));
      }).on('error', (e) => { server.close(); reject(e); });
    });
  });
}

function buildSampleInvoiceRow(overrides) {
  return Object.assign({
    id: 5,
    invoice_number: 'INV-2026-0042',
    client_name: 'Acme Co.',
    client_email: 'pay@acme.com',
    client_address: '',
    items: [
      { description: 'Design consultation', quantity: 4, unit_price: 75 }
    ],
    subtotal: 300,
    tax_rate: 0,
    tax_amount: 0,
    total: 300,
    notes: null,
    status: 'sent',
    issued_date: new Date('2026-05-01'),
    due_date: new Date('2026-05-31'),
    payment_link_url: 'https://buy.stripe.com/test_link',
    public_token: 'cafef00ddeadbeef',
    owner_id: 11,
    owner_name: 'Jordan Pine',
    owner_email: 'jordan@example.com',
    owner_business_name: 'Pine Studio',
    owner_business_address: '123 Maple St',
    owner_business_email: 'hi@pinestudio.com',
    owner_business_phone: '555-0100',
    owner_plan: 'pro'
  }, overrides || {});
}

async function testPublicViewRenders200WithInvoiceFields() {
  const app = buildShareViewApp({ invoiceRow: buildSampleInvoiceRow() });
  const r = await getPath(app, '/i/cafef00ddeadbeef');
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.includes('INV-2026-0042'), 'must show invoice number');
  assert.ok(r.body.includes('Pine Studio'), 'must show owner business name');
  assert.ok(r.body.includes('Acme Co.'), 'must show client name');
  assert.ok(r.body.includes('$300.00'), 'must show formatted total');
  assert.ok(r.body.includes('data-testid="public-invoice"'),
    'must include the public-invoice container testid');
}

async function testPublicViewRendersPayCtaForProOwner() {
  const app = buildShareViewApp({ invoiceRow: buildSampleInvoiceRow() });
  const r = await getPath(app, '/i/cafef00ddeadbeef');
  assert.ok(r.body.includes('data-testid="public-pay-cta"'),
    'Pro owner with payment_link_url must surface the Pay-now CTA');
  assert.ok(r.body.includes('https://buy.stripe.com/test_link'),
    'Pay-now href must be the Stripe payment link URL');
}

async function testPublicViewSuppressesPayCtaWhenStatusIsPaid() {
  const app = buildShareViewApp({
    invoiceRow: buildSampleInvoiceRow({ status: 'paid' })
  });
  const r = await getPath(app, '/i/cafef00ddeadbeef');
  assert.ok(!r.body.includes('data-testid="public-pay-cta"'),
    'a paid invoice should not surface a Pay-now CTA');
  assert.ok(r.body.includes('data-testid="public-paid-banner"'),
    'paid invoices show the "Paid" thanks banner instead');
}

async function testPublicViewSuppressesPayCtaForFreeOwner() {
  const app = buildShareViewApp({
    invoiceRow: buildSampleInvoiceRow({ owner_plan: 'free', payment_link_url: null })
  });
  const r = await getPath(app, '/i/cafef00ddeadbeef');
  assert.ok(!r.body.includes('data-testid="public-pay-cta"'),
    'free owner has no Stripe payment link, so no Pay-now CTA');
}

async function testPublicViewSuppressesOwnerOnlyActions() {
  const app = buildShareViewApp({ invoiceRow: buildSampleInvoiceRow() });
  const r = await getPath(app, '/i/cafef00ddeadbeef');
  assert.ok(!/Mark as Sent/.test(r.body),
    'public view must NOT carry the Mark-as-Sent button');
  assert.ok(!/Mark as Paid/.test(r.body),
    'public view must NOT carry the Mark-as-Paid button');
  assert.ok(!/href="\/invoices\/5\/edit"/.test(r.body),
    'public view must NOT carry an Edit link');
  assert.ok(!/action="\/invoices\/5\/delete"/.test(r.body),
    'public view must NOT carry a Delete form');
}

async function testPublicViewIsNoindex() {
  const app = buildShareViewApp({ invoiceRow: buildSampleInvoiceRow() });
  const r = await getPath(app, '/i/cafef00ddeadbeef');
  assert.ok(/<meta[^>]*name="robots"[^>]*noindex/i.test(r.body),
    'tokenised public URLs must opt out of search indexing');
}

async function testPublicViewIncludesPoweredByAttribution() {
  const app = buildShareViewApp({ invoiceRow: buildSampleInvoiceRow() });
  const r = await getPath(app, '/i/cafef00ddeadbeef');
  assert.ok(r.body.includes('data-testid="public-powered-by"'),
    'public view must include the Powered-by-DecentInvoice attribution (sets up #48)');
  assert.ok(r.body.includes('data-testid="public-attribution"'),
    'public view must include the footer attribution + signup CTA');
}

async function testPublic404OnBadTokenFormat() {
  const calls = [];
  const dbStub = {
    pool: { query: async () => ({ rows: [] }) },
    db: {
      async getInvoiceByPublicToken() {
        calls.push('called');
        return null;
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
  const r = await getPath(app, '/i/not-hex!');
  assert.strictEqual(r.status, 404);
  assert.strictEqual(calls.length, 0,
    'bad-format tokens must short-circuit before any DB lookup');
}

async function testPublic404OnMissingToken() {
  const app = buildShareViewApp({ invoiceRow: null });
  const r = await getPath(app, '/i/cafef00ddeadbeef');
  assert.strictEqual(r.status, 404,
    'valid-format but unknown token returns 404, not 500');
}

// ---------- views/invoice-public.ejs direct render -----------------------

async function testPublicViewRendersWithoutPaymentLink() {
  const html = await ejs.renderFile(path.join(VIEWS, 'invoice-public.ejs'),
    { invoice: buildSampleInvoiceRow({ payment_link_url: null }), title: 't' },
    { views: [VIEWS] });
  assert.ok(html.includes('INV-2026-0042'));
  assert.ok(!html.includes('data-testid="public-pay-cta"'),
    'no payment_link_url means no Pay-now CTA — the invoice still renders');
}

async function testPublicViewEscapesHostileInput() {
  const hostile = '"><script>alert(1)</script>';
  const html = await ejs.renderFile(path.join(VIEWS, 'invoice-public.ejs'),
    { invoice: buildSampleInvoiceRow({
        owner_business_name: hostile,
        client_name: hostile,
        items: [{ description: hostile, quantity: 1, unit_price: 50 }],
        notes: hostile
      }), title: 't' },
    { views: [VIEWS] });
  assert.ok(!html.includes('<script>alert(1)</script>'),
    'hostile business / client / line-item / notes input must be HTML-escaped');
  assert.ok(html.includes('&lt;script&gt;') || html.includes('&lt;/script&gt;'),
    'angle brackets appear escaped in the rendered HTML');
}

async function testPublicViewFallsBackWhenBusinessNameMissing() {
  const html = await ejs.renderFile(path.join(VIEWS, 'invoice-public.ejs'),
    { invoice: buildSampleInvoiceRow({
        owner_business_name: null,
        owner_name: 'Solo Freelancer'
      }), title: 't' },
    { views: [VIEWS] });
  assert.ok(html.includes('Solo Freelancer'),
    'falls back to owner_name when owner_business_name is missing');
}

// ---------- views/invoice-view.ejs wiring --------------------------------

function makeInvoiceForView(overrides) {
  return Object.assign({
    id: 1,
    invoice_number: 'INV-2026-0001',
    status: 'draft',
    issued_date: new Date('2026-05-01'),
    due_date: new Date('2026-05-31'),
    client_name: 'Acme',
    client_email: 'acme@x.com',
    client_address: '',
    items: [{ description: 'x', quantity: 1, unit_price: 100 }],
    subtotal: 100, tax_rate: 0, tax_amount: 0, total: 100,
    notes: null,
    payment_link_url: null
  }, overrides || {});
}

async function testInvoiceViewExposesPublicShareSectionForPro() {
  const html = await ejs.renderFile(path.join(VIEWS, 'invoice-view.ejs'), {
    title: 'Invoice',
    user: { plan: 'pro', email: 'pro@x.com', name: 'Pro', business_name: null },
    invoice: makeInvoiceForView({ payment_link_url: 'https://buy.stripe.com/test' }),
    paymentMethods: ['card'],
    csrfToken: 'csrf-share',
    flash: null
  }, { views: [VIEWS] });
  assert.ok(html.includes('data-testid="public-share-section"'),
    'Pro user must see the public-share section in the invoice view');
  assert.ok(html.includes('data-testid="public-share-generate"'),
    'generate-link button must be present so the Pro user can mint a token');
  assert.ok(/\/invoices\/1\/share/.test(html),
    'generate button must POST to /invoices/:id/share with the right id');
  assert.ok(/X-CSRF-Token[\s\S]*csrf-share/.test(html),
    'fetch() must forward the CSRF token in the X-CSRF-Token header');
}

async function testInvoiceViewExposesPublicShareSectionForAgency() {
  const html = await ejs.renderFile(path.join(VIEWS, 'invoice-view.ejs'), {
    title: 'Invoice',
    user: { plan: 'agency', email: 'agency@x.com', name: 'Agency', business_name: null },
    invoice: makeInvoiceForView({ status: 'draft', payment_link_url: null }),
    csrfToken: 'csrf-share',
    flash: null
  }, { views: [VIEWS] });
  assert.ok(html.includes('data-testid="public-share-section"'),
    'Agency user must see the public-share section');
}

async function testInvoiceViewExposesPublicShareSectionForFree() {
  // Free users see the live share-link UI — it's the activation funnel's
  // only in-app delivery path. The share_link pro-lock card no longer
  // exists at all; the upgrade pressure rides a tailored sub-line inside
  // the share section that names the missing Pay button.
  const html = await ejs.renderFile(path.join(VIEWS, 'invoice-view.ejs'), {
    title: 'Invoice',
    user: { plan: 'free', email: 'free@x.com', name: 'Free', business_name: null },
    invoice: makeInvoiceForView(),
    csrfToken: 'csrf-share',
    flash: null
  }, { views: [VIEWS] });
  assert.ok(html.includes('data-testid="public-share-section"'),
    'free user must see the live share-link UI');
  assert.ok(/data-owner-plan="free"/.test(html),
    'share section must tag the owner plan so the rendered copy is verifiable');
  assert.ok(html.includes('data-testid="public-share-generate"'),
    'free user gets the same Generate-link button as Pro');
  assert.ok(/\/invoices\/1\/share/.test(html),
    'free user generate button must POST to the same /invoices/:id/share endpoint');
  assert.ok(html.includes('data-testid="public-share-free-nudge"'),
    'free user must see the missing-Pay-button upgrade nudge inside the share section');
  assert.ok(/name="source"\s+value="share-link-pay-nudge"/.test(html),
    'free-nudge form must tag its source for conversion attribution');
  assert.ok(/action="\/billing\/create-checkout"/.test(html),
    'free-nudge upgrade CTA must POST straight into the checkout flow');
  assert.ok(!/data-pro-lock="share_link"/.test(html),
    'the old share_link pro-lock card must be removed; the share section replaces it');
}

async function testInvoiceViewSuppressesFreeNudgeForPro() {
  // Pro users must NOT see the free-tier upgrade nudge inside the share
  // section — they have the live Pay-link UI right below it.
  const html = await ejs.renderFile(path.join(VIEWS, 'invoice-view.ejs'), {
    title: 'Invoice',
    user: { plan: 'pro', email: 'pro@x.com', name: 'Pro', business_name: null },
    invoice: makeInvoiceForView({ payment_link_url: 'https://buy.stripe.com/test' }),
    paymentMethods: ['card'],
    csrfToken: 'csrf-share',
    flash: null
  }, { views: [VIEWS] });
  assert.ok(!html.includes('data-testid="public-share-free-nudge"'),
    'Pro user must NOT see the free-tier upgrade nudge inside the share section');
  assert.ok(/data-owner-plan="paid"/.test(html),
    'share section must tag the owner plan as paid for Pro users');
  assert.ok(!/data-pro-lock="share_link"/.test(html),
    'the share_link pro-lock card no longer exists for any plan');
}

// ---------- schema migration --------------------------------------------

function testSchemaIncludesPublicTokenMigration() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  assert.ok(/ALTER\s+TABLE\s+invoices[\s\S]*public_token\s+VARCHAR\(32\)\s+UNIQUE/i.test(sql),
    'schema.sql must carry an idempotent ALTER for invoices.public_token VARCHAR(32) UNIQUE');
}

// ---------- runner -------------------------------------------------------

async function run() {
  const tests = [
    ['db.getOrCreatePublicToken: returns existing token without UPDATE', testGetOrCreatePublicTokenReturnsExisting],
    ['db.getOrCreatePublicToken: generates 16-hex on missing, scoped by user_id', testGetOrCreatePublicTokenGeneratesWhenMissing],
    ['db.getOrCreatePublicToken: retries on 23505 UNIQUE collision', testGetOrCreatePublicTokenRetriesOn23505],
    ['db.getOrCreatePublicToken: returns null when invoice not owned by user', testGetOrCreatePublicTokenReturnsNullForMissingInvoice],
    ['db.getOrCreatePublicToken: short-circuits on bad args, no SQL', testGetOrCreatePublicTokenShortCircuitsOnBadArgs],
    ['db.getInvoiceByPublicToken: JOIN users SQL shape with owner branding fields', testGetInvoiceByPublicTokenSqlShape],
    ['db.getInvoiceByPublicToken: rejects bad-format tokens before SQL', testGetInvoiceByPublicTokenRejectsBadFormatBeforeSql],
    ['db.getInvoiceByPublicToken: returns null on miss', testGetInvoiceByPublicTokenReturnsNullOnMiss],
    ['lib/share-link: buildPublicInvoiceUrl respects APP_URL', testBuildPublicInvoiceUrlRespectsAppUrl],
    ['lib/share-link: buildPublicInvoiceUrl falls back to relative', testBuildPublicInvoiceUrlFallsBackToRelative],
    ['lib/share-link: buildPublicInvoiceUrl rejects bad tokens', testBuildPublicInvoiceUrlRejectsBadTokens],
    ['lib/share-link: isValidPublicToken accepts 8-32 hex only', testIsValidPublicTokenContract],
    ['POST /invoices/:id/share: Pro returns {url,token} JSON', testShareEndpointProReturnsUrl],
    ['POST /invoices/:id/share: Agency returns {url,token} JSON', testShareEndpointAgencyReturnsUrl],
    ['POST /invoices/:id/share: free returns {url,token} JSON', testShareEndpointFreeMintsUrl],
    ['POST /invoices/:id/share: requires auth', testShareEndpointAuthRequired],
    ['POST /invoices/:id/share: 404 when invoice not found', testShareEndpoint404OnMissingInvoice],
    ['GET /i/:token: renders 200 with invoice fields', testPublicViewRenders200WithInvoiceFields],
    ['GET /i/:token: renders Pay-now CTA for Pro owner', testPublicViewRendersPayCtaForProOwner],
    ['GET /i/:token: suppresses Pay-now CTA when status=paid (shows paid banner)', testPublicViewSuppressesPayCtaWhenStatusIsPaid],
    ['GET /i/:token: suppresses Pay-now CTA for free owner', testPublicViewSuppressesPayCtaForFreeOwner],
    ['GET /i/:token: never renders owner-only edit/delete/status UI', testPublicViewSuppressesOwnerOnlyActions],
    ['GET /i/:token: emits noindex meta tag', testPublicViewIsNoindex],
    ['GET /i/:token: includes Powered-by + footer attribution', testPublicViewIncludesPoweredByAttribution],
    ['GET /i/:token: 404 on bad-format token without hitting DB', testPublic404OnBadTokenFormat],
    ['GET /i/:token: 404 on valid-format but unknown token', testPublic404OnMissingToken],
    ['invoice-public.ejs: renders without payment link', testPublicViewRendersWithoutPaymentLink],
    ['invoice-public.ejs: HTML-escapes hostile owner/client/items/notes', testPublicViewEscapesHostileInput],
    ['invoice-public.ejs: falls back to owner_name when business_name missing', testPublicViewFallsBackWhenBusinessNameMissing],
    ['invoice-view.ejs: Pro user sees public-share-section', testInvoiceViewExposesPublicShareSectionForPro],
    ['invoice-view.ejs: Agency user sees public-share-section', testInvoiceViewExposesPublicShareSectionForAgency],
    ['invoice-view.ejs: free user sees public-share-section + upgrade nudge', testInvoiceViewExposesPublicShareSectionForFree],
    ['invoice-view.ejs: Pro user does NOT see free-tier upgrade nudge', testInvoiceViewSuppressesFreeNudgeForPro],
    ['schema.sql: idempotent ALTER for invoices.public_token', testSchemaIncludesPublicTokenMigration]
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
