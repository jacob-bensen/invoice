'use strict';

/*
 * Zelle tap-to-pay surface on the public /i/<token> page (Milestone 4 —
 * first invoice sent → first payment received). Zelle is the dominant
 * US bank-to-bank P2P rail (Bank of America, Chase, Wells, US Bank,
 * Citi, plus hundreds of credit unions all bundle it for free) but
 * unlike Venmo / Cash App / PayPal it has no public profile URLs and
 * no universal-link / deep-link standard — it lives entirely inside
 * each bank's own app. So the surface is a tap-to-copy handle + an
 * "open your bank app's Zelle section" hint, normalized + validated
 * server-side so a typo can't ship to the client's screen.
 *
 * Covers:
 *   - normalizeZelleHandle email + phone accept/reject matrix
 *   - buildZelleSurface returns {handle, kind, display} or null
 *   - buildPayLinks() threads `zelle` through alongside the 3 universal
 *     links (back-compat: missing `zelle` arg returns null, doesn't crash)
 *   - schema.sql ALTER for users.zelle_handle
 *   - db.getInvoiceByPublicToken projects u.zelle_handle AS owner_zelle_handle
 *   - POST /billing/settings persists email + phone, rejects invalid,
 *     clears on empty
 *   - settings.ejs surfaces the input pre-filled
 *   - invoice-public.ejs renders the Zelle surface with the copy button
 *     scoped to the panel x-data, suppressed on paid + when handle unset
 *
 * Run: NODE_ENV=test node tests/zelle-tap-to-pay.test.js
 */

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';
process.env.APP_URL = process.env.APP_URL || 'https://test.invoice.app';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');
const express = require('express');
const session = require('express-session');
const http = require('http');

const VIEWS = path.join(__dirname, '..', 'views');

const {
  normalizeZelleHandle,
  buildZelleSurface,
  buildPayLinks
} = require('../lib/payment-handles');

function clearReq(mod) {
  try { delete require.cache[require.resolve(mod)]; } catch (_) { /* noop */ }
}

let pass = 0, fail = 0;
function run(name, fn) {
  try { const r = fn(); if (r && typeof r.then === 'function') return r.then(() => { console.log(`  ok  ${name}`); pass++; }, (e) => { console.error(`  FAIL ${name}`); console.error(e && e.stack ? e.stack : e); fail++; }); console.log(`  ok  ${name}`); pass++; }
  catch (err) { console.error(`  FAIL ${name}`); console.error(err && err.stack ? err.stack : err); fail++; }
}

// ---------- normalizeZelleHandle: email --------------------------------

run('zelle: plain email passes', () => {
  assert.strictEqual(normalizeZelleHandle('jordan@example.com'), 'jordan@example.com');
});

run('zelle: email uppercased input is canonicalised to lowercase', () => {
  assert.strictEqual(normalizeZelleHandle('Jordan@Example.COM'), 'jordan@example.com');
});

run('zelle: email with surrounding whitespace stripped', () => {
  assert.strictEqual(normalizeZelleHandle('  jordan@example.com  '), 'jordan@example.com');
});

run('zelle: email with leading @ accidental prefix is forgiven', () => {
  // Paste-error tolerance — the other normalizers strip a leading `@`,
  // and Zelle handle inputs sit next to those, so users who paste
  // "@user@bank.com" should still get the intended email.
  assert.strictEqual(normalizeZelleHandle('@jordan@example.com'), 'jordan@example.com');
});

run('zelle: email with + alias accepted (real-world bank-aliased addresses)', () => {
  assert.strictEqual(normalizeZelleHandle('jordan+zelle@example.com'), 'jordan+zelle@example.com');
});

run('zelle: email rejects HTML / quote injection chars in local part', () => {
  // Defence in depth — the public template renders the handle inside a
  // JS-string literal (the @click copy handler). The normalizer must
  // reject hostile chars before they reach the template, even though
  // EJS would HTML-escape them.
  assert.strictEqual(normalizeZelleHandle("evil'@example.com"), null);
  assert.strictEqual(normalizeZelleHandle('evil"@example.com'), null);
  assert.strictEqual(normalizeZelleHandle('<script>@example.com'), null);
  assert.strictEqual(normalizeZelleHandle('a&b@example.com'), null);
});

run('zelle: email rejects missing TLD / no dot in domain', () => {
  assert.strictEqual(normalizeZelleHandle('jordan@example'), null);
  assert.strictEqual(normalizeZelleHandle('jordan@.com'), null);
});

run('zelle: email rejects multiple @ signs', () => {
  // After the single leading-@-strip pass, a second @ in the body is invalid.
  assert.strictEqual(normalizeZelleHandle('a@b@c.com'), null);
});

run('zelle: email rejects > 254 chars (RFC 5321 envelope cap)', () => {
  const tooLong = 'a'.repeat(245) + '@x.com'; // 251 chars total — under cap
  assert.ok(normalizeZelleHandle(tooLong));
  const overflowed = 'a'.repeat(250) + '@x.com'; // 256 chars
  assert.strictEqual(normalizeZelleHandle(overflowed), null);
});

// ---------- normalizeZelleHandle: phone --------------------------------

run('zelle: bare 10-digit US phone passes through', () => {
  assert.strictEqual(normalizeZelleHandle('5551234567'), '5551234567');
});

run('zelle: punctuated US phone normalises to digits', () => {
  assert.strictEqual(normalizeZelleHandle('(555) 123-4567'), '5551234567');
});

run('zelle: E.164 phone preserves the +', () => {
  assert.strictEqual(normalizeZelleHandle('+1 555 123 4567'), '+15551234567');
  assert.strictEqual(normalizeZelleHandle('+15551234567'), '+15551234567');
});

run('zelle: phone too short → null', () => {
  assert.strictEqual(normalizeZelleHandle('12345'), null);
});

run('zelle: phone too long → null', () => {
  assert.strictEqual(normalizeZelleHandle('1234567890123456'), null);
});

// ---------- normalizeZelleHandle: misc ---------------------------------

run('zelle: empty / null / non-string rejected', () => {
  assert.strictEqual(normalizeZelleHandle(''), null);
  assert.strictEqual(normalizeZelleHandle('   '), null);
  assert.strictEqual(normalizeZelleHandle(null), null);
  assert.strictEqual(normalizeZelleHandle(undefined), null);
});

run('zelle: arbitrary text that is neither email nor phone → null', () => {
  assert.strictEqual(normalizeZelleHandle('venmo handle'), null);
  assert.strictEqual(normalizeZelleHandle('zelle'), null);
});

// ---------- buildZelleSurface ------------------------------------------

run('buildZelleSurface: email → kind=email, display=lowercased', () => {
  const s = buildZelleSurface({ handle: 'JORDAN@EXAMPLE.COM' });
  assert.deepStrictEqual(s, {
    handle: 'jordan@example.com',
    kind: 'email',
    display: 'jordan@example.com'
  });
});

run('buildZelleSurface: 10-digit US phone → pretty-printed display', () => {
  const s = buildZelleSurface({ handle: '5551234567' });
  assert.strictEqual(s.kind, 'phone');
  assert.strictEqual(s.handle, '5551234567');
  assert.strictEqual(s.display, '(555) 123-4567');
});

run('buildZelleSurface: +1 US phone → pretty-printed with +1 prefix', () => {
  const s = buildZelleSurface({ handle: '+15551234567' });
  assert.strictEqual(s.kind, 'phone');
  assert.strictEqual(s.handle, '+15551234567');
  assert.strictEqual(s.display, '+1 (555) 123-4567');
});

run('buildZelleSurface: international phone shown verbatim (no false-positive US formatting)', () => {
  const s = buildZelleSurface({ handle: '+447911123456' });
  assert.strictEqual(s.kind, 'phone');
  assert.strictEqual(s.handle, '+447911123456');
  assert.strictEqual(s.display, '+447911123456'); // not coerced to a US shape
});

run('buildZelleSurface: invalid handle → null (no broken surface)', () => {
  assert.strictEqual(buildZelleSurface({ handle: 'not-an-email' }), null);
  assert.strictEqual(buildZelleSurface({ handle: '' }), null);
  assert.strictEqual(buildZelleSurface({}), null);
});

// ---------- buildPayLinks: Zelle threading -----------------------------

run('buildPayLinks: zelle arg threads through to result.zelle', () => {
  const r = buildPayLinks({
    venmo: null, cashapp: null, paypal: null,
    zelle: 'pay@bank.com',
    amount: 50, invoiceNumber: 'INV-1'
  });
  assert.strictEqual(r.zelle.handle, 'pay@bank.com');
  assert.strictEqual(r.zelle.kind, 'email');
});

run('buildPayLinks: missing zelle arg → result.zelle is null (back-compat)', () => {
  // Older test fixtures and the EJS template both rely on result.zelle
  // being well-defined when no handle is set — must be null, not undefined,
  // so the template's `if (tapToPay.zelle)` gate is unambiguous.
  const r = buildPayLinks({
    venmo: null, cashapp: null, paypal: null,
    amount: 50, invoiceNumber: 'INV-1'
  });
  assert.strictEqual(r.zelle, null);
});

// ---------- schema.sql -------------------------------------------------

run('schema.sql: idempotent ALTER for users.zelle_handle', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  assert.ok(
    /ALTER\s+TABLE\s+users\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+zelle_handle\s+VARCHAR/i.test(sql),
    'schema.sql must carry an idempotent ALTER for users.zelle_handle'
  );
});

// ---------- db.getInvoiceByPublicToken: projection ---------------------

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

async function testPublicTokenQueryProjectsZelleHandle() {
  const captured = [];
  const restore = stubPg(async (text, params) => {
    captured.push({ text, params });
    return { rows: [{ id: 5, owner_zelle_handle: 'pay@bank.com' }] };
  });
  try {
    const { db } = require('../db');
    const row = await db.getInvoiceByPublicToken('cafef00ddeadbeef');
    assert.strictEqual(captured.length, 1);
    assert.ok(/u\.zelle_handle\s+AS\s+owner_zelle_handle/i.test(captured[0].text),
      'public-page SELECT must project users.zelle_handle AS owner_zelle_handle');
    assert.strictEqual(row.owner_zelle_handle, 'pay@bank.com');
  } finally { restore(); }
}

// ---------- POST /billing/settings: Zelle round-trip --------------------

const updateUserCalls = [];
let userStore = {};

function installSettingsStubs() {
  const dbStub = {
    pool: { query: async () => ({ rows: [] }) },
    db: {
      async getUserById(id) { return userStore[id] || null; },
      async updateUser(id, fields) {
        updateUserCalls.push({ id, fields });
        const u = userStore[id];
        if (!u) return null;
        Object.assign(u, fields);
        return u;
      },
      async markInvoicePaidByPaymentLinkId() { return null; }
    }
  };
  require.cache[require.resolve('../db')] = {
    id: require.resolve('../db'),
    filename: require.resolve('../db'),
    loaded: true,
    exports: dbStub
  };
  const stripePath = require.resolve('stripe');
  require.cache[stripePath] = {
    id: stripePath, filename: stripePath, loaded: true,
    exports: () => ({
      webhooks: { constructEvent: () => { throw new Error('not used'); } },
      customers: { async create() { return { id: 'cus_x' }; }, async retrieve() { return { metadata: {} }; } },
      checkout: { sessions: { async create() { return { url: '' }; } } },
      billingPortal: { sessions: { async create() { return { url: '' }; } } }
    })
  };
  clearReq('../routes/billing');
  return require('../routes/billing');
}

function buildSettingsApp(sessionUser) {
  const billingRoutes = installSettingsStubs();
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', VIEWS);
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, _res, next) => { if (sessionUser) req.session.user = sessionUser; next(); });
  app.use((req, res, next) => { res.locals.user = sessionUser || null; next(); });
  app.use('/billing', billingRoutes);
  return app;
}

function postForm(app, url, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const payload = new URLSearchParams(body).toString();
      const req = http.request({
        hostname: '127.0.0.1', port, path: url, method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => server.close(() => resolve({ status: res.statusCode, headers: res.headers, body: data })));
      });
      req.on('error', e => { server.close(); reject(e); });
      req.write(payload);
      req.end();
    });
  });
}

function getPath(app, url) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      http.get({ hostname: '127.0.0.1', port, path: url }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => server.close(() => resolve({ status: res.statusCode, body: data })));
      }).on('error', e => { server.close(); reject(e); });
    });
  });
}

async function testSettingsPersistsEmailZelleHandle() {
  updateUserCalls.length = 0;
  userStore = { 41: { id: 41, email: 'g@x.com', name: 'G', plan: 'free' } };
  const app = buildSettingsApp({ id: 41, plan: 'free', name: 'G', email: 'g@x.com' });
  const res = await postForm(app, '/billing/settings', {
    name: 'G',
    zelle_handle: '  Jordan@Bank.COM  '
  });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(updateUserCalls.length, 1);
  assert.strictEqual(updateUserCalls[0].fields.zelle_handle, 'jordan@bank.com',
    'zelle_handle must persist lowercased + trimmed');
}

async function testSettingsPersistsPhoneZelleHandle() {
  updateUserCalls.length = 0;
  userStore = { 42: { id: 42, email: 'h@x.com', name: 'H', plan: 'free' } };
  const app = buildSettingsApp({ id: 42, plan: 'free', name: 'H', email: 'h@x.com' });
  const res = await postForm(app, '/billing/settings', {
    name: 'H',
    zelle_handle: '+1 (555) 123-4567'
  });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(updateUserCalls.length, 1);
  assert.strictEqual(updateUserCalls[0].fields.zelle_handle, '+15551234567',
    'punctuated +1 phone must persist as bare E.164 digits with leading +');
}

async function testSettingsRejectsInvalidZelleHandle() {
  updateUserCalls.length = 0;
  userStore = { 43: { id: 43, email: 'i@x.com', name: 'I', plan: 'free', zelle_handle: 'previous@bank.com' } };
  const app = buildSettingsApp({ id: 43, plan: 'free', name: 'I', email: 'i@x.com' });
  const res = await postForm(app, '/billing/settings', {
    name: 'I',
    zelle_handle: 'definitely not valid'
  });
  assert.strictEqual(res.status, 302);
  assert.ok(res.headers.location.includes('/billing/settings'));
  assert.strictEqual(updateUserCalls.length, 0,
    'invalid Zelle handle must NOT trigger updateUser — user keeps the previous value');
}

async function testSettingsClearsZelleHandleOnEmpty() {
  updateUserCalls.length = 0;
  userStore = { 44: { id: 44, email: 'k@x.com', name: 'K', plan: 'free', zelle_handle: 'old@bank.com' } };
  const app = buildSettingsApp({ id: 44, plan: 'free', name: 'K', email: 'k@x.com' });
  const res = await postForm(app, '/billing/settings', { name: 'K', zelle_handle: '' });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(updateUserCalls.length, 1);
  assert.strictEqual(updateUserCalls[0].fields.zelle_handle, null,
    'empty zelle_handle persists as NULL so the public button stops rendering');
}

async function testSettingsViewRendersZelleInput() {
  userStore = {
    45: { id: 45, email: 'l@x.com', name: 'L', plan: 'free', invoice_count: 0,
          zelle_handle: 'saved@bank.com' }
  };
  const app = buildSettingsApp({ id: 45, plan: 'free', name: 'L', email: 'l@x.com' });
  const res = await getPath(app, '/billing/settings');
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.includes('data-testid="settings-zelle-handle"'),
    'settings page must surface the Zelle input by stable testid');
  assert.ok(res.body.includes('value="saved@bank.com"'),
    'saved Zelle handle must be pre-filled');
}

// ---------- invoice-public.ejs: Zelle render ---------------------------

function buildSampleInvoiceRow(overrides) {
  return Object.assign({
    id: 5,
    invoice_number: 'INV-2026-0042',
    client_name: 'Acme Co.',
    client_email: 'pay@acme.com',
    client_address: '',
    items: [{ description: 'Design consultation', quantity: 4, unit_price: 75 }],
    subtotal: 300, tax_rate: 0, tax_amount: 0, total: 300, notes: null,
    status: 'sent',
    issued_date: new Date('2026-05-01'),
    due_date: new Date('2026-05-31'),
    payment_link_url: null,
    public_token: 'cafef00ddeadbeef',
    owner_id: 11,
    owner_name: 'Jordan Pine',
    owner_email: 'jordan@example.com',
    owner_business_name: 'Pine Studio',
    owner_business_address: '123 Maple St',
    owner_business_email: 'hi@pinestudio.com',
    owner_business_phone: '555-0100',
    owner_payment_instructions: null,
    owner_venmo_handle: null,
    owner_cashapp_handle: null,
    owner_paypal_me_handle: null,
    owner_zelle_handle: null,
    owner_plan: 'free'
  }, overrides || {});
}

function renderPublic(invoice) {
  return ejs.renderFile(
    path.join(VIEWS, 'invoice-public.ejs'),
    {
      invoice,
      title: 't',
      tapToPayLinks: buildPayLinks({
        venmo: invoice.owner_venmo_handle,
        cashapp: invoice.owner_cashapp_handle,
        paypal: invoice.owner_paypal_me_handle,
        zelle: invoice.owner_zelle_handle,
        amount: invoice.total,
        invoiceNumber: invoice.invoice_number
      })
    },
    { views: [VIEWS] }
  );
}

async function testPublicViewRendersZelleSurfaceWithEmailHandle() {
  const html = await renderPublic(buildSampleInvoiceRow({
    status: 'sent',
    total: 300,
    owner_zelle_handle: 'pay@pinestudio.com'
  }));
  assert.ok(html.includes('data-testid="public-tap-to-pay"'),
    'tap-to-pay card must render when Zelle handle alone is set');
  assert.ok(html.includes('data-testid="public-tap-to-pay-zelle"'),
    'Zelle panel must render');
  assert.ok(html.includes('data-testid="public-tap-to-pay-zelle-copy"'),
    'tap-to-copy button must render');
  assert.ok(html.includes('pay@pinestudio.com'),
    'rendered handle must appear verbatim for the client to copy');
  assert.ok(html.includes("writeText('pay@pinestudio.com')"),
    'clipboard.writeText call must embed the canonical handle');
  assert.ok(/Send \$300\.00 to/.test(html),
    'panel must surface the specific invoice amount so the client types it correctly');
}

async function testPublicViewRendersZelleSurfaceWithPhoneHandle() {
  const html = await renderPublic(buildSampleInvoiceRow({
    status: 'sent',
    total: 250.5,
    owner_zelle_handle: '5551234567'
  }));
  assert.ok(html.includes('data-testid="public-tap-to-pay-zelle"'),
    'Zelle panel must render with phone handle');
  assert.ok(html.includes('(555) 123-4567'),
    'pretty-printed display form must surface to the client');
  assert.ok(html.includes("writeText('5551234567')"),
    'copy button must put the bare digits on the clipboard (not the pretty form)');
}

async function testPublicViewSuppressesZelleSurfaceOnInvalidStoredHandle() {
  // Defence in depth: a malformed handle that somehow lands in the DB
  // (older migration, manual SQL edit) must NOT produce a copy button
  // that ships the bad value to the client's clipboard.
  const html = await renderPublic(buildSampleInvoiceRow({
    status: 'sent',
    owner_zelle_handle: 'not-a-real-handle'
  }));
  assert.ok(!html.includes('data-testid="public-tap-to-pay-zelle"'),
    'invalid stored Zelle handle must not produce a copy surface');
  assert.ok(!html.includes('data-testid="public-tap-to-pay"'),
    'no other handle set → no tap-to-pay card either');
}

async function testPublicViewSuppressesZelleSurfaceOnPaid() {
  const html = await renderPublic(buildSampleInvoiceRow({
    status: 'paid',
    owner_zelle_handle: 'pay@pinestudio.com'
  }));
  assert.ok(!html.includes('data-testid="public-tap-to-pay"'),
    'tap-to-pay card (including Zelle) must NOT render on paid invoices');
}

async function testPublicViewZelleCoexistsWithUniversalLinkRails() {
  const html = await renderPublic(buildSampleInvoiceRow({
    status: 'sent',
    owner_venmo_handle: 'jpine',
    owner_zelle_handle: 'pay@pinestudio.com'
  }));
  assert.ok(html.includes('data-testid="public-tap-to-pay-venmo"'),
    'Venmo button must render alongside Zelle');
  assert.ok(html.includes('data-testid="public-tap-to-pay-zelle"'),
    'Zelle panel must render alongside Venmo');
}

// ---------- runner -------------------------------------------------------

async function main() {
  const asyncTests = [
    ['db.getInvoiceByPublicToken: SELECT projects users.zelle_handle AS owner_zelle_handle', testPublicTokenQueryProjectsZelleHandle],
    ['POST /billing/settings: persists Zelle email (lowercased + trimmed)', testSettingsPersistsEmailZelleHandle],
    ['POST /billing/settings: persists Zelle phone (digits-only, leading + preserved)', testSettingsPersistsPhoneZelleHandle],
    ['POST /billing/settings: invalid Zelle handle rejected (no updateUser)', testSettingsRejectsInvalidZelleHandle],
    ['POST /billing/settings: empty Zelle input persists as NULL (clear signal)', testSettingsClearsZelleHandleOnEmpty],
    ['settings.ejs: renders Zelle input pre-filled with saved value', testSettingsViewRendersZelleInput],
    ['invoice-public.ejs: renders Zelle panel + copy button with email handle', testPublicViewRendersZelleSurfaceWithEmailHandle],
    ['invoice-public.ejs: renders Zelle panel with phone handle (pretty-printed display, digits-only on copy)', testPublicViewRendersZelleSurfaceWithPhoneHandle],
    ['invoice-public.ejs: invalid stored Zelle handle suppresses the surface (defence in depth)', testPublicViewSuppressesZelleSurfaceOnInvalidStoredHandle],
    ['invoice-public.ejs: paid invoice suppresses the Zelle surface', testPublicViewSuppressesZelleSurfaceOnPaid],
    ['invoice-public.ejs: Zelle surface coexists with Venmo / Cash App / PayPal rails', testPublicViewZelleCoexistsWithUniversalLinkRails]
  ];
  for (const [name, fn] of asyncTests) {
    try { await fn(); console.log(`  ok  ${name}`); pass++; }
    catch (err) { console.error(`  FAIL ${name}`); console.error(err && err.stack ? err.stack : err); fail++; }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
