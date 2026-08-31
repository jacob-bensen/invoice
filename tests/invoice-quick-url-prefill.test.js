'use strict';

/*
 * GET /invoices/quick URL-prefill (Milestone 2 → Milestone 3). The
 * dashboard "Invoice a recent client" quick-picker chips link here with
 * ?client_name=&client_email=&client_phone= in the URL; the form must
 * pre-fill those fields on the initial render so the freelancer taps
 * once and lands on a partially-completed form.
 *
 * Contract:
 *   - Query params: client_name, client_email, client_phone.
 *   - Each is string-only, clamped to 500 chars (per-field). Anything else
 *     is dropped to ''.
 *   - An autosaved pending draft ALWAYS wins over URL params (never stomp
 *     the freelancer's saved in-progress work).
 *   - No query params (or all-empty) → form renders empty (behaviour
 *     unchanged from before this ship).
 *
 * Run: NODE_ENV=test node tests/invoice-quick-url-prefill.test.js
 */

const assert = require('assert');
const path = require('path');
const http = require('http');
const express = require('express');

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

// ---- test-store + db stub ----------------------------------------------

const users = new Map();

function resetStore() { users.clear(); }

function buildDbStub() {
  return {
    pool: { query: async () => ({ rows: [] }) },
    db: {
      async getUserById(id) { return users.get(id) || null; },
      async getInvoicesByUser() { return []; },
      async getNextInvoiceNumber() { return 'INV-2026-0001'; },
      async getRecentClientsForUser() { return []; },
      async getRecentItemsForUser() { return []; },
      async createInvoice() { throw new Error('not used'); },
      async markInvoiceSentFromShareIntent() { throw new Error('not used'); },
      async updateUser() { return null; },
      async clearPendingQuickInvoice() {},
      async getOrCreatePublicToken() { return null; },
      async getOldestStaleDraft() { return null; },
      async getRecentRevenueStats() { return null; }
    }
  };
}

function installDbStub() {
  const stub = buildDbStub();
  require.cache[require.resolve('../db')] = {
    id: require.resolve('../db'),
    filename: require.resolve('../db'),
    loaded: true,
    exports: stub
  };
  require.cache[require.resolve('../lib/stripe-payment-link')] = {
    id: require.resolve('../lib/stripe-payment-link'),
    filename: require.resolve('../lib/stripe-payment-link'),
    loaded: true,
    exports: {
      createInvoicePaymentLink: async () => null,
      parsePaymentMethods: () => ['card']
    }
  };
  delete require.cache[require.resolve('../lib/email')];
  delete require.cache[require.resolve('../routes/invoices')];
  return require('../routes/invoices');
}

function buildApp(sessionUser, invoiceRoutes) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = req.session || { user: sessionUser, flash: null };
    req.session.user = sessionUser ? Object.assign({}, sessionUser) : null;
    next();
  });
  app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    res.locals.csrfToken = 'test-csrf';
    next();
  });
  app.use('/invoices', invoiceRoutes);
  return app;
}

function request(app, method, url) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const req = http.request({
        hostname: '127.0.0.1', port, path: url, method
      }, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, headers: res.headers, body: data }); });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.end();
    });
  });
}

function attrValue(html, name, testid) {
  // Extracts `<input name="…" testid=…  value="X">` — value attribute
  // regardless of attribute order. The test relies on double-quoted attrs
  // (the EJS template's convention).
  const inputRe = new RegExp(`<input[^>]*name="${name}"[^>]*>`, 'g');
  const inputs = html.match(inputRe) || [];
  for (const input of inputs) {
    if (!input.includes(`data-testid="${testid}"`)) continue;
    const vm = input.match(/\bvalue="([^"]*)"/);
    return vm ? vm[1] : null;
  }
  return null;
}

// ---- Test setup ---------------------------------------------------------

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// The invoice-quick.ejs template renders three separate inputs — client_name,
// client_email, client_phone. We locate them by their stable testids so
// this test doesn't couple to unrelated attribute ordering.

const CLIENT_NAME_TESTID = 'invoice-quick-client-name';
const CLIENT_EMAIL_TESTID = 'invoice-quick-client-email';
const CLIENT_PHONE_TESTID = 'invoice-quick-client-phone-input';

// ---- Route tests --------------------------------------------------------

test('GET /quick with no query params: all three client fields are empty', async () => {
  resetStore();
  users.set(1, { id: 1, email: 'u@a.co', plan: 'pro', invoice_count: 0 });
  const routes = installDbStub();
  const app = buildApp({ id: 1 }, routes);
  const res = await request(app, 'GET', '/invoices/quick');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(attrValue(res.body, 'client_name', CLIENT_NAME_TESTID), '');
  assert.strictEqual(attrValue(res.body, 'client_email', CLIENT_EMAIL_TESTID), '');
  assert.strictEqual(attrValue(res.body, 'client_phone', CLIENT_PHONE_TESTID), '');
});

test('GET /quick?client_name=Acme&client_email=ap@acme.co&client_phone=555-1234 pre-fills all three fields', async () => {
  resetStore();
  users.set(1, { id: 1, email: 'u@a.co', plan: 'pro', invoice_count: 0 });
  const routes = installDbStub();
  const app = buildApp({ id: 1 }, routes);
  const res = await request(app, 'GET', '/invoices/quick?client_name=Acme&client_email=ap%40acme.co&client_phone=555-1234');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(attrValue(res.body, 'client_name', CLIENT_NAME_TESTID), 'Acme');
  assert.strictEqual(attrValue(res.body, 'client_email', CLIENT_EMAIL_TESTID), 'ap@acme.co');
  assert.strictEqual(attrValue(res.body, 'client_phone', CLIENT_PHONE_TESTID), '555-1234');
});

test('GET /quick pre-fill works with only client_name (email + phone stay empty)', async () => {
  resetStore();
  users.set(1, { id: 1, email: 'u@a.co', plan: 'pro', invoice_count: 0 });
  const routes = installDbStub();
  const app = buildApp({ id: 1 }, routes);
  const res = await request(app, 'GET', '/invoices/quick?client_name=Solo');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(attrValue(res.body, 'client_name', CLIENT_NAME_TESTID), 'Solo');
  assert.strictEqual(attrValue(res.body, 'client_email', CLIENT_EMAIL_TESTID), '');
  assert.strictEqual(attrValue(res.body, 'client_phone', CLIENT_PHONE_TESTID), '');
});

test('GET /quick pre-fill: whitespace-only query params behave like no query (empty form)', async () => {
  resetStore();
  users.set(1, { id: 1, email: 'u@a.co', plan: 'pro', invoice_count: 0 });
  const routes = installDbStub();
  const app = buildApp({ id: 1 }, routes);
  const res = await request(app, 'GET', '/invoices/quick?client_name=%20%20&client_email=%20');
  assert.strictEqual(res.status, 200);
  // Whitespace-only prefill collapses to null via readClientPrefillFromQuery
  // (all trimmed values are empty) — form renders empty on first paint.
  assert.strictEqual(attrValue(res.body, 'client_name', CLIENT_NAME_TESTID), '');
  assert.strictEqual(attrValue(res.body, 'client_email', CLIENT_EMAIL_TESTID), '');
  assert.strictEqual(attrValue(res.body, 'client_phone', CLIENT_PHONE_TESTID), '');
});

test('GET /quick pre-fill escapes HTML in the pre-filled value', async () => {
  resetStore();
  users.set(1, { id: 1, email: 'u@a.co', plan: 'pro', invoice_count: 0 });
  const routes = installDbStub();
  const app = buildApp({ id: 1 }, routes);
  const hostile = encodeURIComponent('"><script>alert(1)</script>');
  const res = await request(app, 'GET', '/invoices/quick?client_name=' + hostile);
  assert.strictEqual(res.status, 200);
  // EJS <%= %> escapes the value; the raw string must not appear
  // as an unescaped attribute-breaking payload.
  assert.doesNotMatch(res.body, /"><script>alert\(1\)<\/script>/);
  // The escaped, safely-embedded form of the value should still round-trip
  // back into the value attribute.
  const val = attrValue(res.body, 'client_name', CLIENT_NAME_TESTID);
  // The DOM-parsed value would be '"><script>alert(1)</script>' — in the
  // raw HTML we assert the sequence has been HTML-encoded rather than
  // pattern-matching the browser-decoded form.
  assert.notStrictEqual(val, null);
  assert.match(res.body, /value="&#34;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;"/);
});

test('GET /quick pre-fill: pending autosave draft WINS over URL params', async () => {
  resetStore();
  users.set(1, {
    id: 1, email: 'u@a.co', plan: 'pro', invoice_count: 0,
    pending_quick_invoice: {
      client_name: 'FromAutosave',
      client_email: 'autosave@x.co',
      client_phone: '999',
      description: 'saved desc',
      amount: '250'
    }
  });
  const routes = installDbStub();
  const app = buildApp({ id: 1 }, routes);
  const res = await request(app, 'GET', '/invoices/quick?client_name=FromURL&client_email=url@x.co&client_phone=111');
  assert.strictEqual(res.status, 200);
  // Autosave draft wins — a fresh dashboard-chip navigation must NEVER
  // stomp the freelancer's saved in-progress work.
  assert.strictEqual(attrValue(res.body, 'client_name', CLIENT_NAME_TESTID), 'FromAutosave');
  assert.strictEqual(attrValue(res.body, 'client_email', CLIENT_EMAIL_TESTID), 'autosave@x.co');
  assert.strictEqual(attrValue(res.body, 'client_phone', CLIENT_PHONE_TESTID), '999');
});

test('GET /quick pre-fill clamps oversize input at 500 chars', async () => {
  resetStore();
  users.set(1, { id: 1, email: 'u@a.co', plan: 'pro', invoice_count: 0 });
  const routes = installDbStub();
  const app = buildApp({ id: 1 }, routes);
  const long = 'A'.repeat(600);
  const res = await request(app, 'GET', '/invoices/quick?client_name=' + long);
  assert.strictEqual(res.status, 200);
  const val = attrValue(res.body, 'client_name', CLIENT_NAME_TESTID);
  assert.strictEqual(val.length, 500);
  assert.match(val, /^A+$/);
});

test('GET /quick pre-fill: array-valued query params (client_name=a&client_name=b) drop to empty (defence-in-depth)', async () => {
  resetStore();
  users.set(1, { id: 1, email: 'u@a.co', plan: 'pro', invoice_count: 0 });
  const routes = installDbStub();
  const app = buildApp({ id: 1 }, routes);
  // Express parses ?a=1&a=2 as ['1','2']; readClientPrefillFromQuery
  // only accepts strings and drops arrays/objects to ''.
  const res = await request(app, 'GET', '/invoices/quick?client_name=a&client_name=b');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(attrValue(res.body, 'client_name', CLIENT_NAME_TESTID), '');
});

// ---- readClientPrefillFromQuery pure helper -----------------------------

test('helper: readClientPrefillFromQuery returns null for undefined / non-object', () => {
  const routes = installDbStub();
  assert.strictEqual(routes.readClientPrefillFromQuery(undefined), null);
  assert.strictEqual(routes.readClientPrefillFromQuery(null), null);
  assert.strictEqual(routes.readClientPrefillFromQuery('a=b'), null);
});

test('helper: readClientPrefillFromQuery returns null when every field trims to empty', () => {
  const routes = installDbStub();
  assert.strictEqual(routes.readClientPrefillFromQuery({}), null);
  assert.strictEqual(
    routes.readClientPrefillFromQuery({ client_name: '   ', client_email: '', client_phone: '\t' }),
    null
  );
});

test('helper: readClientPrefillFromQuery projects only the whitelisted three fields', () => {
  const routes = installDbStub();
  const out = routes.readClientPrefillFromQuery({
    client_name: 'Acme',
    client_email: 'ap@acme.co',
    client_phone: '555',
    description: 'IGNORED',
    amount: '999',
    extra: 'IGNORED'
  });
  assert.ok(out);
  assert.strictEqual(out.client_name, 'Acme');
  assert.strictEqual(out.client_email, 'ap@acme.co');
  assert.strictEqual(out.client_phone, '555');
  // description + amount are always empty from URL prefill — the freelancer
  // still writes fresh line details for each new job.
  assert.strictEqual(out.description, '');
  assert.strictEqual(out.amount, '');
});

test('helper: readClientPrefillFromQuery drops non-string values silently', () => {
  const routes = installDbStub();
  const out = routes.readClientPrefillFromQuery({
    client_name: 'Acme',
    client_email: 42,
    client_phone: { x: 1 }
  });
  assert.ok(out);
  assert.strictEqual(out.client_email, '');
  assert.strictEqual(out.client_phone, '');
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
      if (err.stack) console.error(err.stack.split('\n').slice(0, 4).join('\n'));
    }
  }
  console.log(`\n${passed} passed, ${failed} failed (invoice-quick-url-prefill.test.js)`);
  if (failed > 0) process.exit(1);
})();
