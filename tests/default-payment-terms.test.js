'use strict';

/*
 * Per-user default payment-terms window in days (Milestones 3 + 4 —
 * first invoice created → first invoice sent, and first invoice sent →
 * first payment received). Until this ship, three new-invoice surfaces
 * hardcoded a 30-day due-date offset (POST /invoices/quick, POST
 * /invoices/:id/duplicate, the GET /invoices/new form default).
 * Freelancers who bill Net 7 / 14 / 15 / 45 / 60 had to hand-edit the
 * due_date on every invoice — and the unedited 30 silently miscalibrates
 * the overdue cron (which fires off the column the freelancer never
 * noticed was wrong). The new `users.default_payment_terms_days` column
 * (INTEGER NOT NULL DEFAULT 30, bounded 1-365 at the settings route)
 * drives the offset on all three surfaces.
 *
 * Run: NODE_ENV=test node tests/default-payment-terms.test.js
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

async function testSettingsSavesDefaultPaymentTermsDays() {
  resetSettingsStores();
  users.set(40, {
    id: 40, email: 'me@x.com', name: 'M', plan: 'free',
    default_payment_terms_days: 30
  });
  const app = buildBillingApp({ id: 40, plan: 'free' });
  const res = await request(app, 'POST', '/billing/settings', {
    name: 'M',
    default_payment_terms_days: '14'
  });
  assert.strictEqual(res.status, 302, 'settings save must redirect');
  assert.ok(updateUserCalls.length >= 1, 'db.updateUser must be called');
  const call = updateUserCalls[updateUserCalls.length - 1];
  assert.strictEqual(
    call.fields.default_payment_terms_days, 14,
    'Net 14 must persist as the integer 14'
  );
}

async function testSettingsAcceptsMaxBoundary() {
  resetSettingsStores();
  users.set(41, { id: 41, email: 'me@x.com', name: 'M', plan: 'free', default_payment_terms_days: 30 });
  const app = buildBillingApp({ id: 41, plan: 'free' });
  const res = await request(app, 'POST', '/billing/settings', {
    name: 'M', default_payment_terms_days: '365'
  });
  assert.strictEqual(res.status, 302);
  const call = updateUserCalls[updateUserCalls.length - 1];
  assert.strictEqual(call.fields.default_payment_terms_days, 365, '365 (year-long) is the inclusive max');
}

async function testSettingsAcceptsMinBoundary() {
  resetSettingsStores();
  users.set(42, { id: 42, email: 'me@x.com', name: 'M', plan: 'free', default_payment_terms_days: 30 });
  const app = buildBillingApp({ id: 42, plan: 'free' });
  const res = await request(app, 'POST', '/billing/settings', {
    name: 'M', default_payment_terms_days: '1'
  });
  assert.strictEqual(res.status, 302);
  const call = updateUserCalls[updateUserCalls.length - 1];
  assert.strictEqual(call.fields.default_payment_terms_days, 1, '1 (due-tomorrow) is the inclusive min');
}

async function testSettingsRejectsZero() {
  resetSettingsStores();
  users.set(43, { id: 43, email: 'me@x.com', name: 'M', plan: 'free', default_payment_terms_days: 30 });
  const app = buildBillingApp({ id: 43, plan: 'free' });
  const res = await request(app, 'POST', '/billing/settings', {
    name: 'M', default_payment_terms_days: '0'
  });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(updateUserCalls.length, 0,
    'zero must be rejected (a same-day-due default makes every invoice insta-overdue)');
}

async function testSettingsRejectsNegative() {
  resetSettingsStores();
  users.set(44, { id: 44, email: 'me@x.com', name: 'M', plan: 'free', default_payment_terms_days: 30 });
  const app = buildBillingApp({ id: 44, plan: 'free' });
  const res = await request(app, 'POST', '/billing/settings', {
    name: 'M', default_payment_terms_days: '-5'
  });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(updateUserCalls.length, 0,
    'negative must be rejected — sign-rejection is in the regex, not just the range check');
}

async function testSettingsRejectsOverMax() {
  resetSettingsStores();
  users.set(45, { id: 45, email: 'me@x.com', name: 'M', plan: 'free', default_payment_terms_days: 30 });
  const app = buildBillingApp({ id: 45, plan: 'free' });
  const res = await request(app, 'POST', '/billing/settings', {
    name: 'M', default_payment_terms_days: '366'
  });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(updateUserCalls.length, 0,
    '> 365 must be rejected — a year is the longest defensible default');
}

async function testSettingsRejectsFractional() {
  resetSettingsStores();
  users.set(46, { id: 46, email: 'me@x.com', name: 'M', plan: 'free', default_payment_terms_days: 30 });
  const app = buildBillingApp({ id: 46, plan: 'free' });
  const res = await request(app, 'POST', '/billing/settings', {
    name: 'M', default_payment_terms_days: '14.5'
  });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(updateUserCalls.length, 0,
    'fractional days must be rejected — the column is INTEGER, the DB would silently truncate without this guard');
}

async function testSettingsRejectsNonNumeric() {
  resetSettingsStores();
  users.set(47, { id: 47, email: 'me@x.com', name: 'M', plan: 'free', default_payment_terms_days: 30 });
  const app = buildBillingApp({ id: 47, plan: 'free' });
  const res = await request(app, 'POST', '/billing/settings', {
    name: 'M', default_payment_terms_days: 'thirty'
  });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(updateUserCalls.length, 0,
    'non-numeric input rejected (no parseInt accidentally writing NaN/0)');
}

async function testSettingsEmptyStringPersistsDefault() {
  resetSettingsStores();
  users.set(48, { id: 48, email: 'me@x.com', name: 'M', plan: 'free', default_payment_terms_days: 60 });
  const app = buildBillingApp({ id: 48, plan: 'free' });
  const res = await request(app, 'POST', '/billing/settings', {
    name: 'M', default_payment_terms_days: ''
  });
  assert.strictEqual(res.status, 302);
  const call = updateUserCalls[updateUserCalls.length - 1];
  assert.strictEqual(call.fields.default_payment_terms_days, 30,
    'empty submission resets to the column NOT NULL default of 30 (never writes NULL into a NOT NULL column)');
}

async function testSettingsViewRendersSavedValue() {
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
        default_invoice_notes: null,
        default_currency: 'USD',
        default_payment_terms_days: 14
      },
      flash: null
    },
    { rmWhitespace: false }
  );
  assert.ok(html.includes('name="default_payment_terms_days"'),
    'settings view must render the default_payment_terms_days input');
  assert.ok(html.includes('data-testid="settings-default-payment-terms-days"'),
    'input must carry a stable data-testid');
  // Must surface the saved 14 as the input's value.
  const m = html.match(/<input[^>]*name="default_payment_terms_days"[^>]*>/);
  assert.ok(m, 'input element must be present');
  assert.ok(/value="14"/.test(m[0]),
    'input value must reflect the saved 14, not the historical 30 default');
  assert.ok(/min="1"/.test(m[0]) && /max="365"/.test(m[0]),
    'input must carry min=1 + max=365 client-side guards');
}

async function testSettingsViewFallsBackToThirty() {
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
        default_invoice_notes: null,
        default_currency: 'USD',
        default_payment_terms_days: null
      },
      flash: null
    },
    { rmWhitespace: false }
  );
  const m = html.match(/<input[^>]*name="default_payment_terms_days"[^>]*>/);
  assert.ok(m, 'input must render even on null (back-compat with users who never set the field)');
  assert.ok(/value="30"/.test(m[0]),
    'null value must fall back to 30 — the historical default — so the input is never empty');
}

// ---------- /invoices/quick + /invoices/:id/duplicate route tests --------

const quickUsers = new Map();
const quickInvoices = new Map();
const quickCreateCalls = [];
const quickDuplicateCalls = [];
let quickInvoiceIdNext = 100;

function resetQuickStore() {
  quickUsers.clear();
  quickInvoices.clear();
  quickCreateCalls.length = 0;
  quickDuplicateCalls.length = 0;
  quickInvoiceIdNext = 100;
}

function buildQuickDbStub() {
  return {
    pool: { query: async () => ({ rows: [] }) },
    db: {
      async getUserById(id) { return quickUsers.get(id) || null; },
      async getInvoiceById(id, userId) {
        const inv = quickInvoices.get(parseInt(id, 10));
        if (!inv || inv.user_id !== userId) return null;
        return inv;
      },
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
      async duplicateInvoice(sourceId, userId, fields) {
        quickDuplicateCalls.push({ sourceId, userId, fields });
        const id = quickInvoiceIdNext++;
        const u = quickUsers.get(userId);
        if (u) u.invoice_count = (u.invoice_count || 0) + 1;
        return Object.assign({ id, status: 'draft', user_id: userId }, fields);
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

function daysBetween(isoA, isoB) {
  const a = new Date(isoA + 'T00:00:00Z').getTime();
  const b = new Date(isoB + 'T00:00:00Z').getTime();
  return Math.round((b - a) / 86400000);
}

async function testQuickCreateUsesUserTermsDays() {
  resetQuickStore();
  quickUsers.set(1, {
    id: 1, plan: 'free', invoice_count: 0,
    name: 'Alice', email: 'a@x.com',
    default_payment_terms_days: 14
  });
  const routes = installQuickStub();
  const app = buildQuickApp({ id: 1, plan: 'free', invoice_count: 0 }, routes);
  const res = await request(app, 'POST', '/invoices/quick', {
    client_name: 'Acme', description: 'Brand work', amount: '500'
  });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(quickCreateCalls.length, 1);
  const call = quickCreateCalls[0];
  const offset = daysBetween(call.issued_date, call.due_date);
  assert.strictEqual(offset, 14,
    'due_date must be issued_date + user.default_payment_terms_days (14), not the legacy hardcoded 30');
}

async function testQuickCreateFallsBackToThirtyWhenUnset() {
  resetQuickStore();
  quickUsers.set(2, {
    id: 2, plan: 'free', invoice_count: 0,
    name: 'Bob', email: 'b@x.com',
    default_payment_terms_days: null
  });
  const routes = installQuickStub();
  const app = buildQuickApp({ id: 2, plan: 'free', invoice_count: 0 }, routes);
  const res = await request(app, 'POST', '/invoices/quick', {
    client_name: 'Acme', description: 'Work', amount: '100'
  });
  assert.strictEqual(res.status, 302);
  const call = quickCreateCalls[0];
  const offset = daysBetween(call.issued_date, call.due_date);
  assert.strictEqual(offset, 30,
    'null setting falls back to 30 — every existing user without the column set sees the historical default');
}

async function testQuickCreateFallsBackOnCorruptValue() {
  resetQuickStore();
  // Defence-in-depth: even though the settings route rejects bad input, a
  // future migration / direct DB write could land an out-of-range value.
  // The /quick path must NEVER emit a 0-day or negative-day due_date.
  quickUsers.set(3, {
    id: 3, plan: 'free', invoice_count: 0,
    name: 'Carol', email: 'c@x.com',
    default_payment_terms_days: 0
  });
  const routes = installQuickStub();
  const app = buildQuickApp({ id: 3, plan: 'free', invoice_count: 0 }, routes);
  const res = await request(app, 'POST', '/invoices/quick', {
    client_name: 'Acme', description: 'Work', amount: '100'
  });
  assert.strictEqual(res.status, 302);
  const call = quickCreateCalls[0];
  const offset = daysBetween(call.issued_date, call.due_date);
  assert.strictEqual(offset, 30,
    'zero/corrupt value must fall back to 30 — never emit a same-day due_date that auto-flips to overdue');
}

async function testQuickCreateHonoursNet60() {
  resetQuickStore();
  quickUsers.set(4, {
    id: 4, plan: 'pro', invoice_count: 5,
    name: 'Dan', email: 'd@x.com',
    default_payment_terms_days: 60
  });
  const routes = installQuickStub();
  const app = buildQuickApp({ id: 4, plan: 'pro', invoice_count: 5 }, routes);
  const res = await request(app, 'POST', '/invoices/quick', {
    client_name: 'Acme', description: 'Retainer', amount: '2000'
  });
  assert.strictEqual(res.status, 302);
  const call = quickCreateCalls[0];
  assert.strictEqual(daysBetween(call.issued_date, call.due_date), 60,
    'Net 60 (agency / large-client norm) honoured on the fast-path /quick form');
}

async function testDuplicateUsesUserTermsDays() {
  resetQuickStore();
  quickUsers.set(5, {
    id: 5, plan: 'pro', invoice_count: 3,
    name: 'Eve', email: 'e@x.com',
    default_payment_terms_days: 7
  });
  quickInvoices.set(900, {
    id: 900, user_id: 5,
    invoice_number: 'INV-2026-0001',
    client_name: 'Acme', client_email: 'a@x.com',
    items: [{ description: 'Work', quantity: 1, unit_price: 100 }],
    subtotal: 100, tax_rate: 0, tax_amount: 0, total: 100,
    status: 'paid',
    issued_date: new Date('2026-01-01'),
    due_date: new Date('2026-01-31')
  });
  const routes = installQuickStub();
  const app = buildQuickApp({ id: 5, plan: 'pro', invoice_count: 3 }, routes);
  const res = await request(app, 'POST', '/invoices/900/duplicate', {});
  assert.strictEqual(res.status, 302, 'duplicate must redirect on success');
  assert.strictEqual(quickDuplicateCalls.length, 1);
  const call = quickDuplicateCalls[0];
  const offset = daysBetween(call.fields.issued_date, call.fields.due_date);
  assert.strictEqual(offset, 7,
    'duplicate must use the user\'s current default_payment_terms_days, not the source invoice\'s due-date offset and not the legacy 30');
}

// ---------- /invoices/new view tests ------------------------------------

async function testInvoiceFormDueDatePrefilledFromUserDefault() {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
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
        payment_instructions: null,
        default_invoice_notes: null,
        default_payment_terms_days: 14
      },
      flash: null,
      noindex: true
    },
    { rmWhitespace: false }
  );
  const m = html.match(/<input[^>]*name="due_date"[^>]*>/);
  assert.ok(m, 'due_date input must be present on /invoices/new');
  const vm = m[0].match(/value="(\d{4}-\d{2}-\d{2})"/);
  assert.ok(vm, 'due_date must carry a YYYY-MM-DD value');
  const expectedMs = Date.now() + 14 * 86400000;
  const expectedIso = new Date(expectedMs).toISOString().split('T')[0];
  // Allow a 1-day drift to cover the test running at the UTC midnight tick.
  const observed = vm[1];
  const drift = Math.abs(daysBetween(expectedIso, observed));
  assert.ok(drift <= 1,
    `due_date must be Date.now() + 14 days (got ${observed}, expected ~${expectedIso}, drift=${drift})`);
  assert.ok(/defaults to 14 days/.test(html),
    'label hint must surface the per-user value (14), not the legacy "30"');
}

async function testInvoiceFormDueDateFallsBackToThirty() {
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
        payment_instructions: null,
        default_invoice_notes: null,
        default_payment_terms_days: null
      },
      flash: null,
      noindex: true
    },
    { rmWhitespace: false }
  );
  assert.ok(/defaults to 30 days/.test(html),
    'null setting falls back to 30 in the label hint (back-compat with users who never set the field)');
  const m = html.match(/<input[^>]*name="due_date"[^>]*value="(\d{4}-\d{2}-\d{2})"/);
  assert.ok(m, 'due_date input must carry a YYYY-MM-DD value');
  const expectedIso = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
  assert.ok(Math.abs(daysBetween(expectedIso, m[1])) <= 1,
    `null default falls back to 30 days from today (got ${m[1]})`);
}

async function testInvoiceFormEditFlowKeepsInvoiceDueDate() {
  // Edit-flow: the invoice already has its own due_date — that wins over
  // the user's default. A user who changed their default since creating an
  // old invoice must not have that old invoice's due_date silently
  // rewritten by the form pre-fill.
  const html = await ejs.renderFile(
    path.join(__dirname, '..', 'views', 'invoice-form.ejs'),
    {
      title: 'Edit Invoice',
      invoice: {
        id: 7,
        client_name: 'Acme', client_email: 'a@x.com', client_address: '',
        items: [{ description: 'Work', quantity: 1, unit_price: 100 }],
        subtotal: 100, tax_rate: 0, tax_amount: 0, total: 100,
        notes: null,
        issued_date: new Date('2026-05-01'),
        due_date: new Date('2026-05-08'),  // Net 7 on this specific invoice
        status: 'draft', invoice_number: 'INV-2026-0007'
      },
      invoiceNumber: 'INV-2026-0007',
      recentClients: [],
      recentItems: [],
      user: {
        id: 1, email: 'me@x.com', name: 'M', plan: 'free',
        business_name: 'My Studio', invoice_count: 5,
        payment_instructions: null,
        default_invoice_notes: null,
        default_payment_terms_days: 60  // different from the existing invoice
      },
      flash: null,
      noindex: true
    },
    { rmWhitespace: false }
  );
  const m = html.match(/<input[^>]*name="due_date"[^>]*value="(\d{4}-\d{2}-\d{2})"/);
  assert.ok(m, 'due_date input must be present on edit');
  assert.strictEqual(m[1], '2026-05-08',
    'invoice.due_date must win over user.default_payment_terms_days on edit — the per-invoice value is sacred');
}

async function testInvoiceFormOutOfRangeFallsBackToThirty() {
  // Defence-in-depth: even though the settings route rejects out-of-range
  // values, a corrupt DB row (or a future direct write) could land a > 365
  // or negative value. The view must NEVER project that into the rendered
  // due_date input.
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
        payment_instructions: null,
        default_invoice_notes: null,
        default_payment_terms_days: 99999  // hostile / corrupt
      },
      flash: null,
      noindex: true
    },
    { rmWhitespace: false }
  );
  assert.ok(/defaults to 30 days/.test(html),
    'out-of-range value falls back to 30 in the label hint');
  const m = html.match(/<input[^>]*name="due_date"[^>]*value="(\d{4}-\d{2}-\d{2})"/);
  assert.ok(m, 'due_date input must still carry a sane YYYY-MM-DD value');
  const expectedIso = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
  assert.ok(Math.abs(daysBetween(expectedIso, m[1])) <= 1,
    `out-of-range falls back to 30 days (got ${m[1]})`);
}

async function testSchemaIncludesPaymentTermsMigration() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  assert.ok(
    /ALTER TABLE users ADD COLUMN IF NOT EXISTS default_payment_terms_days INTEGER NOT NULL DEFAULT 30/i.test(sql),
    'schema.sql must carry an idempotent ALTER for users.default_payment_terms_days INTEGER NOT NULL DEFAULT 30'
  );
}

// ---------- Runner -------------------------------------------------------

async function run() {
  const tests = [
    ['POST /billing/settings — Net 14 persists as integer 14', testSettingsSavesDefaultPaymentTermsDays],
    ['POST /billing/settings — max boundary 365 accepted', testSettingsAcceptsMaxBoundary],
    ['POST /billing/settings — min boundary 1 accepted', testSettingsAcceptsMinBoundary],
    ['POST /billing/settings — zero rejected (no updateUser)', testSettingsRejectsZero],
    ['POST /billing/settings — negative rejected (no updateUser)', testSettingsRejectsNegative],
    ['POST /billing/settings — > 365 rejected (no updateUser)', testSettingsRejectsOverMax],
    ['POST /billing/settings — fractional (14.5) rejected (no updateUser)', testSettingsRejectsFractional],
    ['POST /billing/settings — non-numeric ("thirty") rejected (no updateUser)', testSettingsRejectsNonNumeric],
    ['POST /billing/settings — empty submission resets to 30 (NOT NULL default)', testSettingsEmptyStringPersistsDefault],
    ['views/settings.ejs — renders saved value with min/max/testid', testSettingsViewRendersSavedValue],
    ['views/settings.ejs — null value falls back to 30 in the rendered input', testSettingsViewFallsBackToThirty],
    ['POST /invoices/quick — due_date = today + user.default_payment_terms_days', testQuickCreateUsesUserTermsDays],
    ['POST /invoices/quick — null setting falls back to 30', testQuickCreateFallsBackToThirtyWhenUnset],
    ['POST /invoices/quick — corrupt 0 value falls back to 30 (defence-in-depth)', testQuickCreateFallsBackOnCorruptValue],
    ['POST /invoices/quick — Net 60 honoured', testQuickCreateHonoursNet60],
    ['POST /invoices/:id/duplicate — due_date offset honours user default (not source\'s)', testDuplicateUsesUserTermsDays],
    ['views/invoice-form.ejs — new-invoice render pre-fills due_date from user default', testInvoiceFormDueDatePrefilledFromUserDefault],
    ['views/invoice-form.ejs — null user default falls back to 30 in the view', testInvoiceFormDueDateFallsBackToThirty],
    ['views/invoice-form.ejs — edit-flow keeps invoice.due_date (default never stomps)', testInvoiceFormEditFlowKeepsInvoiceDueDate],
    ['views/invoice-form.ejs — out-of-range corrupt value falls back to 30 in the view', testInvoiceFormOutOfRangeFallsBackToThirty],
    ['db/schema.sql — idempotent ALTER for users.default_payment_terms_days INTEGER NOT NULL DEFAULT 30', testSchemaIncludesPaymentTermsMigration]
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
