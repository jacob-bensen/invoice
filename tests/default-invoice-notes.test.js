'use strict';

/*
 * Default invoice notes / footer per user (Milestones 2 + 3 — first dashboard
 * re-entry → first real invoice created, and first invoice created → first
 * invoice sent). The notes textarea on /invoices/new and the invoice.notes
 * JSON field on /invoices/quick are empty by default — every new invoice
 * asks the freelancer to retype the same boilerplate ("Net 30. Late fee
 * 1.5%/mo. Thanks!") or leave it blank. users.default_invoice_notes stores
 * a per-user default that:
 *   - pre-fills the notes textarea on /invoices/new for new invoices
 *     (not edits — invoice.notes wins),
 *   - is written verbatim to invoice.notes by POST /invoices/quick at
 *     create time.
 *
 * Covers:
 *  1. Settings route: POST /billing/settings with default_invoice_notes=<copy>
 *     persists the trimmed value via db.updateUser.
 *  2. Settings route: POST /billing/settings with default_invoice_notes='' (or
 *     whitespace) persists null — explicit clear signal.
 *  3. Settings route: POST /billing/settings with > 2000 chars rejects with an
 *     error flash and does NOT call db.updateUser at all.
 *  4. Settings view: renders the textarea with the user's saved value
 *     populated, including the stable data-testid for downstream tests.
 *  5. Settings view: renders the textarea empty when default_invoice_notes is
 *     null.
 *  6. /invoices/quick route: createInvoice receives notes=<user.default> when
 *     the user has default_invoice_notes set.
 *  7. /invoices/quick route: createInvoice receives notes=null when the user
 *     has default_invoice_notes unset (back-compat — no regression on
 *     existing users who never visit settings).
 *  8. /invoices/new view: notes textarea pre-filled from user.default_invoice_notes
 *     on new-invoice render.
 *  9. /invoices/new view: notes textarea empty when user.default_invoice_notes
 *     is null on new-invoice render.
 * 10. /invoices/new view (edit flow): invoice.notes wins — the user's default
 *     never stomps an existing invoice's own notes on edit.
 * 11. db/schema.sql carries the idempotent ALTER TABLE migration.
 *
 * Run: NODE_ENV=test node tests/default-invoice-notes.test.js
 */

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const express = require('express');
const session = require('express-session');
const http = require('http');

function clearReq(mod) {
  try { delete require.cache[require.resolve(mod)]; } catch (_) { /* noop */ }
}

// ---------- Settings route tests ----------------------------------------

const users = new Map();
const updateUserCalls = [];

function resetSettingsStores() {
  users.clear();
  updateUserCalls.length = 0;
}

const billingDbStub = {
  pool: { query: async () => ({ rows: [] }) },
  db: {
    async getUserByEmail() { return null; },
    async getUserById(id) { return users.get(id) || null; },
    async updateUser(id, fields) {
      updateUserCalls.push({ id, fields });
      const u = users.get(id);
      if (u) Object.assign(u, fields);
      return u || null;
    }
  }
};

require.cache[require.resolve('../db')] = {
  id: require.resolve('../db'),
  filename: require.resolve('../db'),
  loaded: true,
  exports: billingDbStub
};

require.cache[require.resolve('stripe')] = {
  id: require.resolve('stripe'),
  filename: require.resolve('stripe'),
  loaded: true,
  exports: () => ({
    checkout: { sessions: { create: async () => ({ url: 'https://x' }) } },
    billingPortal: { sessions: { create: async () => ({ url: 'https://x' }) } },
    webhooks: { constructEvent: () => ({}) },
    customers: { update: async () => ({}) },
    paymentLinks: { create: async () => ({ id: 'p', url: 'https://x' }) }
  })
};

clearReq('../routes/billing');
const billingRoutes = require('../routes/billing');

function buildBillingApp(sessionUser) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, _res, next) => {
    if (sessionUser) req.session.user = sessionUser;
    next();
  });
  app.use((req, res, next) => { res.locals.user = sessionUser || null; next(); });
  app.use('/billing', billingRoutes);
  return app;
}

function request(app, method, url, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const payload = body ? new URLSearchParams(body).toString() : '';
      const headers = {};
      if (payload) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        headers['Content-Length'] = Buffer.byteLength(payload);
      }
      const req = http.request(
        { hostname: '127.0.0.1', port, path: url, method, headers },
        res => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => server.close(() => resolve({
            status: res.statusCode, headers: res.headers, body: data
          })));
        }
      );
      req.on('error', err => { server.close(); reject(err); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

async function testSettingsSavesDefaultInvoiceNotes() {
  resetSettingsStores();
  users.set(30, {
    id: 30, email: 'me@x.com', name: 'M', plan: 'free',
    default_invoice_notes: null
  });
  const app = buildBillingApp({ id: 30, plan: 'free' });
  const res = await request(app, 'POST', '/billing/settings', {
    name: 'M',
    default_invoice_notes: '  Net 30. Late fee 1.5%/month.\nThanks!  '
  });
  assert.strictEqual(res.status, 302, 'settings save must redirect');
  assert.ok(updateUserCalls.length >= 1, 'db.updateUser must be called');
  const call = updateUserCalls[updateUserCalls.length - 1];
  assert.strictEqual(
    call.fields.default_invoice_notes,
    'Net 30. Late fee 1.5%/month.\nThanks!',
    'trimmed default_invoice_notes must persist as the typed value (whitespace stripped)'
  );
}

async function testSettingsSavesEmptyDefaultInvoiceNotesAsNull() {
  resetSettingsStores();
  users.set(31, {
    id: 31, email: 'me@x.com', name: 'M', plan: 'free',
    default_invoice_notes: 'old value'
  });
  const app = buildBillingApp({ id: 31, plan: 'free' });
  const res = await request(app, 'POST', '/billing/settings', {
    name: 'M',
    default_invoice_notes: '   '
  });
  assert.strictEqual(res.status, 302);
  assert.ok(updateUserCalls.length >= 1);
  const call = updateUserCalls[updateUserCalls.length - 1];
  assert.strictEqual(call.fields.default_invoice_notes, null,
    'whitespace-only must persist as NULL — explicit clear signal');
}

async function testSettingsRejectsOversizeDefaultInvoiceNotes() {
  resetSettingsStores();
  users.set(32, {
    id: 32, email: 'me@x.com', name: 'M', plan: 'free',
    default_invoice_notes: null
  });
  const app = buildBillingApp({ id: 32, plan: 'free' });
  const res = await request(app, 'POST', '/billing/settings', {
    name: 'M',
    default_invoice_notes: 'a'.repeat(2001)
  });
  assert.strictEqual(res.status, 302, 'oversize input redirects (back to settings)');
  assert.strictEqual(updateUserCalls.length, 0,
    'db.updateUser must NOT be called when default_invoice_notes exceeds the 2000-char cap — user keeps whatever they had');
}

async function testSettingsViewRendersSavedDefaultInvoiceNotes() {
  const html = await ejs.renderFile(
    path.join(__dirname, '..', 'views', 'settings.ejs'),
    {
      title: 'Settings',
      user: {
        email: 'me@x.com', name: 'M', plan: 'free',
        business_name: null, business_address: null,
        business_email: null, business_phone: null,
        webhook_url: null, invoice_count: 0,
        reply_to_email: null, payment_instructions: null,
        bcc_invoice_emails: false,
        default_invoice_notes: 'Net 30. Thanks!'
      },
      flash: null
    },
    { rmWhitespace: false }
  );
  assert.ok(html.includes('name="default_invoice_notes"'),
    'settings view must render the default_invoice_notes textarea');
  assert.ok(html.includes('data-testid="settings-default-invoice-notes"'),
    'textarea must carry a stable data-testid for downstream tests');
  assert.ok(html.includes('Net 30. Thanks!'),
    'saved value must appear inside the textarea body');
  assert.ok(/Default invoice notes/i.test(html),
    'settings view must label the field so users understand its purpose');
}

async function testSettingsViewRendersEmptyDefaultInvoiceNotes() {
  const html = await ejs.renderFile(
    path.join(__dirname, '..', 'views', 'settings.ejs'),
    {
      title: 'Settings',
      user: {
        email: 'me@x.com', name: 'M', plan: 'free',
        business_name: null, business_address: null,
        business_email: null, business_phone: null,
        webhook_url: null, invoice_count: 0,
        reply_to_email: null, payment_instructions: null,
        bcc_invoice_emails: false,
        default_invoice_notes: null
      },
      flash: null
    },
    { rmWhitespace: false }
  );
  assert.ok(html.includes('name="default_invoice_notes"'),
    'textarea is always rendered (state is opt-in, not feature-gated)');
  // Confirm the textarea body is empty between the tags.
  const m = html.match(/<textarea[^>]*name="default_invoice_notes"[^>]*>([\s\S]*?)<\/textarea>/);
  assert.ok(m, 'textarea element must be present');
  assert.strictEqual(m[1].trim(), '',
    'textarea body must be empty when default_invoice_notes is null');
}

// ---------- /invoices/quick route tests ---------------------------------

const quickUsers = new Map();
const quickCreateCalls = [];
let quickInvoiceIdNext = 100;

function resetQuickStore() {
  quickUsers.clear();
  quickCreateCalls.length = 0;
  quickInvoiceIdNext = 100;
}

function buildQuickDbStub() {
  return {
    pool: { query: async () => ({ rows: [] }) },
    db: {
      async getUserById(id) { return quickUsers.get(id) || null; },
      async getInvoiceById() { return null; },
      async getInvoicesByUser() { return []; },
      async getNextInvoiceNumber(userId) {
        const u = quickUsers.get(userId);
        const n = (u && (u.invoice_count || 0)) + 1;
        return `INV-2026-${String(n).padStart(4, '0')}`;
      },
      async getRecentClientsForUser() { return []; },
      async getRecentItemsForUser() { return []; },
      async createInvoice(data) {
        quickCreateCalls.push(data);
        const id = quickInvoiceIdNext++;
        const u = quickUsers.get(data.user_id);
        if (u) u.invoice_count = (u.invoice_count || 0) + 1;
        return Object.assign({ id, status: 'draft', is_seed: false }, data);
      },
      async markInvoiceSentFromShareIntent(invoiceId) {
        return { id: invoiceId, status: 'sent', sent_via_share_intent_at: new Date() };
      },
      async recordFirstSentIfMissing() { return null; },
      async updateUser(id, fields) {
        const u = quickUsers.get(id);
        if (u) Object.assign(u, fields);
        return u || null;
      },
      async clearPendingQuickInvoice() {},
      async getOrCreatePublicToken() { return 'abc1234567890def'; },
      async getOldestStaleDraft() { return null; },
      async getRecentRevenueStats() { return null; }
    }
  };
}

function installQuickStub() {
  const stub = buildQuickDbStub();
  require.cache[require.resolve('../db')] = {
    id: require.resolve('../db'),
    filename: require.resolve('../db'),
    loaded: true, exports: stub
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
  clearReq('../lib/email');
  clearReq('../lib/magic-login');
  clearReq('../lib/first-sent-celebration');
  clearReq('../routes/invoices');
  return require('../routes/invoices');
}

function buildQuickApp(sessionUser, invoiceRoutes) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  const sessionRef = { user: sessionUser ? Object.assign({}, sessionUser) : null, flash: null };
  app.use((req, _res, next) => { req.session = sessionRef; next(); });
  app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    res.locals.csrfToken = 'test-csrf';
    next();
  });
  app.use('/invoices', invoiceRoutes);
  return app;
}

async function testQuickCreatePrefillsNotesFromUserDefault() {
  resetQuickStore();
  quickUsers.set(1, {
    id: 1, plan: 'free', invoice_count: 0,
    name: 'Alice', email: 'a@x.com',
    default_invoice_notes: 'Net 14. Late fee 1.5%/mo. Thanks!'
  });
  const routes = installQuickStub();
  const app = buildQuickApp({ id: 1, plan: 'free', invoice_count: 0 }, routes);

  const res = await request(app, 'POST', '/invoices/quick', {
    client_name: 'Acme',
    description: 'Brand work',
    amount: '500'
  });
  assert.strictEqual(res.status, 302, 'quick create must succeed (302)');
  assert.strictEqual(quickCreateCalls.length, 1, 'createInvoice called exactly once');
  assert.strictEqual(
    quickCreateCalls[0].notes,
    'Net 14. Late fee 1.5%/mo. Thanks!',
    'invoice.notes must be populated from user.default_invoice_notes — the whole point of the feature'
  );
}

async function testQuickCreateLeavesNotesNullWhenNoDefault() {
  resetQuickStore();
  quickUsers.set(2, {
    id: 2, plan: 'free', invoice_count: 0,
    name: 'Bob', email: 'b@x.com',
    default_invoice_notes: null
  });
  const routes = installQuickStub();
  const app = buildQuickApp({ id: 2, plan: 'free', invoice_count: 0 }, routes);

  const res = await request(app, 'POST', '/invoices/quick', {
    client_name: 'Acme',
    description: 'Work',
    amount: '100'
  });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(quickCreateCalls.length, 1);
  assert.strictEqual(quickCreateCalls[0].notes, null,
    'invoice.notes must remain null for users who never set a default — back-compat with every existing user');
}

// ---------- /invoices/new view tests ------------------------------------

async function testInvoiceFormPrefillsNotesFromUserDefault() {
  const html = await ejs.renderFile(
    path.join(__dirname, '..', 'views', 'invoice-form.ejs'),
    {
      title: 'New Invoice',
      invoice: null,
      invoiceNumber: 'INV-2026-0001',
      recentClients: [],
      recentItems: [],
      user: {
        id: 1, email: 'me@x.com', name: 'M', plan: 'free',
        business_name: 'My Studio', invoice_count: 0,
        payment_instructions: 'Venmo @me',
        default_invoice_notes: 'Net 30. Thanks for your business!'
      },
      flash: null,
      noindex: true
    },
    { rmWhitespace: false }
  );
  const m = html.match(/<textarea[^>]*name="notes"[^>]*>([\s\S]*?)<\/textarea>/);
  assert.ok(m, 'notes textarea must be present on /invoices/new');
  assert.strictEqual(m[1], 'Net 30. Thanks for your business!',
    'notes textarea body must be pre-filled from user.default_invoice_notes on new-invoice render');
  assert.ok(html.includes('data-testid="invoice-form-notes"'),
    'notes textarea must carry a stable data-testid for downstream tests');
}

async function testInvoiceFormEmptyNotesWhenNoUserDefault() {
  const html = await ejs.renderFile(
    path.join(__dirname, '..', 'views', 'invoice-form.ejs'),
    {
      title: 'New Invoice',
      invoice: null,
      invoiceNumber: 'INV-2026-0001',
      recentClients: [],
      recentItems: [],
      user: {
        id: 1, email: 'me@x.com', name: 'M', plan: 'free',
        business_name: 'My Studio', invoice_count: 0,
        payment_instructions: 'Venmo @me',
        default_invoice_notes: null
      },
      flash: null,
      noindex: true
    },
    { rmWhitespace: false }
  );
  const m = html.match(/<textarea[^>]*name="notes"[^>]*>([\s\S]*?)<\/textarea>/);
  assert.ok(m, 'notes textarea must be present');
  assert.strictEqual(m[1], '',
    'notes textarea must be empty for new invoices when user has no default — no surprise text');
}

async function testInvoiceFormEditFlowKeepsInvoiceNotes() {
  // Edit-flow: the invoice already has its own notes — those win over the
  // user's default. A user who updated their default since creating an old
  // invoice must not have that old invoice's notes silently rewritten by the
  // edit form pre-fill.
  const html = await ejs.renderFile(
    path.join(__dirname, '..', 'views', 'invoice-form.ejs'),
    {
      title: 'Edit Invoice',
      invoice: {
        id: 7,
        client_name: 'Acme', client_email: 'a@x.com', client_address: '',
        items: [{ description: 'Work', quantity: 1, unit_price: 100 }],
        subtotal: 100, tax_rate: 0, tax_amount: 0, total: 100,
        notes: 'Specific note on THIS invoice — Net 7, no late fee for Acme',
        issued_date: new Date('2026-05-01'),
        due_date: new Date('2026-05-08'),
        status: 'draft', invoice_number: 'INV-2026-0007'
      },
      invoiceNumber: 'INV-2026-0007',
      recentClients: [],
      recentItems: [],
      user: {
        id: 1, email: 'me@x.com', name: 'M', plan: 'free',
        business_name: 'My Studio', invoice_count: 5,
        payment_instructions: 'Venmo @me',
        default_invoice_notes: 'Net 30. Thanks!'  // different from invoice.notes
      },
      flash: null,
      noindex: true
    },
    { rmWhitespace: false }
  );
  const m = html.match(/<textarea[^>]*name="notes"[^>]*>([\s\S]*?)<\/textarea>/);
  assert.ok(m, 'notes textarea must be present on edit');
  assert.strictEqual(
    m[1],
    'Specific note on THIS invoice — Net 7, no late fee for Acme',
    'invoice.notes must win over user.default_invoice_notes on edit — the per-invoice override is sacred'
  );
}

async function testSchemaIncludesDefaultInvoiceNotesMigration() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  assert.ok(
    /ALTER TABLE users ADD COLUMN IF NOT EXISTS default_invoice_notes TEXT/i.test(sql),
    'schema.sql must carry an idempotent ALTER for users.default_invoice_notes TEXT'
  );
}

// ---------- Runner -------------------------------------------------------

async function run() {
  const tests = [
    ['POST /billing/settings — default_invoice_notes persists trimmed', testSettingsSavesDefaultInvoiceNotes],
    ['POST /billing/settings — empty/whitespace default_invoice_notes persists null', testSettingsSavesEmptyDefaultInvoiceNotesAsNull],
    ['POST /billing/settings — oversize default_invoice_notes rejected (no updateUser)', testSettingsRejectsOversizeDefaultInvoiceNotes],
    ['views/settings.ejs — renders saved default_invoice_notes in the textarea', testSettingsViewRendersSavedDefaultInvoiceNotes],
    ['views/settings.ejs — renders empty textarea when default_invoice_notes is null', testSettingsViewRendersEmptyDefaultInvoiceNotes],
    ['POST /invoices/quick — invoice.notes pre-filled from user.default_invoice_notes', testQuickCreatePrefillsNotesFromUserDefault],
    ['POST /invoices/quick — invoice.notes stays null when user has no default', testQuickCreateLeavesNotesNullWhenNoDefault],
    ['views/invoice-form.ejs — new-invoice render pre-fills notes from user.default_invoice_notes', testInvoiceFormPrefillsNotesFromUserDefault],
    ['views/invoice-form.ejs — new-invoice render leaves notes empty when no user default', testInvoiceFormEmptyNotesWhenNoUserDefault],
    ['views/invoice-form.ejs — edit-flow keeps invoice.notes (default never stomps existing)', testInvoiceFormEditFlowKeepsInvoiceNotes],
    ['db/schema.sql — idempotent ALTER for users.default_invoice_notes TEXT', testSchemaIncludesDefaultInvoiceNotesMigration]
  ];
  let pass = 0, fail = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ok  ${name}`);
      pass++;
    } catch (err) {
      console.error(`  FAIL ${name}`);
      console.error('       ' + (err && err.message));
      console.error('       ' + (err && err.stack && err.stack.split('\n').slice(1, 4).join('\n       ')));
      fail++;
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run().catch(err => { console.error(err); process.exit(1); });
