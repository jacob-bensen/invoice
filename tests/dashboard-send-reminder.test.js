'use strict';

/*
 * Server-sent payment-reminder — POST /invoices/:id/send-reminder
 * (Milestone 4 — first invoice sent → first payment received).
 *
 * The dashboard's existing chase clusters all use mailto:/sms:/whatsapp:
 * deep-links that hand off to the user's local mail/SMS client. On mobile,
 * especially iOS without a configured mail account, those handoffs
 * frequently dead-end. This ship adds a server-sent reminder fired from
 * our Resend infrastructure: works on every device, every time.
 *
 * Layers exercised:
 *   1. lib/email: buildPaymentReminderSubject / Html / Text + the
 *      sendPaymentReminderEmail send path. XSS escape, formatted total,
 *      public URL inclusion (when APP_URL set + public_token set), past-
 *      due framing flip, recipient = invoice.client_email, reply-to =
 *      freelancer, "behalf of" disclaimer.
 *   2. db.markInvoiceReminderSent — atomic UPDATE with status filter,
 *      cooldown predicate, user_id scope, return shape.
 *   3. routes/invoices.js POST /:id/send-reminder — happy path, status
 *      gate, no client_email, cooldown 429, send failure 502, not_configured
 *      503, cross-tenant 404, unauthorized 401, no plan gate (free OK),
 *      seed invoice 400, unstamp on send failure so retry works.
 *   4. routes/invoices.buildOverduePrompt — clientEmail surfaced on the
 *      prompt payload when present, omitted when missing/blank.
 *   5. views/dashboard.ejs overdue prompt — server-sent reminder button
 *      renders when clientEmail set, omitted when blank; carries the right
 *      data-* attributes + inline POST handler with CSRF.
 *
 * Run: NODE_ENV=test node tests/dashboard-send-reminder.test.js
 */

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';
process.env.APP_URL = process.env.APP_URL || 'https://decentinvoice.test';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');
const express = require('express');
const session = require('express-session');
const http = require('http');

const VIEWS = path.join(__dirname, '..', 'views');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function clearReq(p) {
  try { delete require.cache[require.resolve(p)]; } catch (_) { /* noop */ }
}

// ---- Layer 1: lib/email builders + sendPaymentReminderEmail -------------

test('lib: buildPaymentReminderSubject includes invoice number + "Reminder" framing', () => {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const subj = email.buildPaymentReminderSubject({ invoice_number: 'INV-2026-0099' });
  assert.ok(/Reminder/i.test(subj), 'subject leads with Reminder');
  assert.ok(subj.includes('INV-2026-0099'), 'subject carries the invoice number');
  assert.ok(/unpaid/i.test(subj), 'subject names the unpaid state');
});

test('lib: buildPaymentReminderSubject falls back gracefully when number missing', () => {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const subj = email.buildPaymentReminderSubject({});
  assert.ok(/invoice/i.test(subj), 'subject still mentions invoice');
  assert.ok(!subj.includes('undefined'), 'no "undefined" leak');
});

test('lib: buildPaymentReminderHtml escapes hostile client_name + sender (XSS guard)', () => {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const html = email.buildPaymentReminderHtml(
    {
      invoice_number: 'INV-1',
      total: '250.00',
      currency: 'usd',
      client_name: '<script>alert(1)</script>',
      public_token: 'abcdef0123456789'
    },
    { name: '<b>Sender</b>', business_name: '<b>Sender</b>', email: 'sender@x.com' }
  );
  assert.ok(!html.includes('<script>alert(1)</script>'),
    'raw client_name must not appear unescaped');
  assert.ok(!/<b>Sender<\/b>/.test(html.replace(/<b style="[^"]*">/g, '')),
    'raw business name must not appear unescaped');
  assert.ok(/&lt;script&gt;/.test(html), 'client_name html-escaped');
});

test('lib: buildPaymentReminderHtml includes formatted total, invoice number, "view" CTA when APP_URL+token set', () => {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const html = email.buildPaymentReminderHtml(
    {
      invoice_number: 'INV-2026-0042',
      total: '1500.00',
      currency: 'usd',
      client_name: 'Acme',
      public_token: 'abcdef0123456789'
    },
    { name: 'Sam', business_name: 'Sam Co', email: 'sam@sam.co' }
  );
  assert.ok(/INV-2026-0042/.test(html), 'invoice number rendered');
  assert.ok(/\$1500\.00/.test(html), 'total rendered with $ symbol + 2 decimals (formatMoney contract): ' + html.slice(0, 200));
  assert.ok(/decentinvoice\.test\/i\/abcdef0123456789/.test(html),
    'public share URL rendered');
  assert.ok(/View.{1,15}pay invoice/i.test(html), 'CTA button label');
  assert.ok(/behalf of/i.test(html), '"behalf of" disclaimer included');
});

test('lib: buildPaymentReminderHtml flips header to "Past due" when due_date is in the past', () => {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const pastDue = new Date(Date.now() - 7 * 86400000).toISOString();
  const html = email.buildPaymentReminderHtml(
    {
      invoice_number: 'INV-1',
      total: '250.00',
      currency: 'usd',
      client_name: 'Acme',
      public_token: 'abcdef0123456789',
      due_date: pastDue
    },
    { name: 'Sam', business_name: 'Sam Co', email: 'sam@sam.co' }
  );
  assert.ok(/Past due/i.test(html), 'past-due header when due_date is in the past');
  assert.ok(/past due/i.test(html), 'past-due softener somewhere in body');
});

test('lib: buildPaymentReminderHtml uses "Friendly reminder" when not yet overdue', () => {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const future = new Date(Date.now() + 7 * 86400000).toISOString();
  const html = email.buildPaymentReminderHtml(
    {
      invoice_number: 'INV-1',
      total: '250.00',
      currency: 'usd',
      client_name: 'Acme',
      public_token: 'abcdef0123456789',
      due_date: future
    },
    { name: 'Sam', business_name: 'Sam Co', email: 'sam@sam.co' }
  );
  assert.ok(/Friendly reminder/i.test(html), 'friendly tone for not-yet-overdue');
});

test('lib: buildPaymentReminderHtml omits "View" CTA when APP_URL is unset', () => {
  clearReq('../lib/email');
  const prev = process.env.APP_URL;
  delete process.env.APP_URL;
  const email = require('../lib/email');
  const html = email.buildPaymentReminderHtml(
    { invoice_number: 'INV-1', total: '250.00', client_name: 'X', public_token: 'abc' },
    { name: 'Sam', email: 'sam@x.com' }
  );
  if (prev === undefined) delete process.env.APP_URL; else process.env.APP_URL = prev;
  assert.ok(!/View.{1,15}pay invoice/i.test(html),
    'no CTA when APP_URL is missing (link would be relative + broken)');
});

test('lib: buildPaymentReminderText includes URL + total + reply hint', () => {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const text = email.buildPaymentReminderText(
    { invoice_number: 'INV-2026-0099', total: '500.00', currency: 'usd', client_name: 'Acme', public_token: 'abcdef0123456789' },
    { name: 'Sam', business_name: 'Sam Co', email: 'sam@sam.co' }
  );
  assert.ok(/INV-2026-0099/.test(text), 'number');
  assert.ok(/500/.test(text), 'total');
  assert.ok(/decentinvoice\.test\/i\/abcdef0123456789/.test(text), 'public URL');
  assert.ok(/reply to this email/i.test(text), '"reply to this email" hint');
});

test('lib: sendPaymentReminderEmail short-circuits on missing args / missing client_email', async () => {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const sends = [];
  email.setResendClient({
    emails: { send: async (p) => { sends.push(p); return { data: { id: 'x' } }; } }
  });
  let r = await email.sendPaymentReminderEmail(null, { email: 'x@x.com' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'invalid_args');
  r = await email.sendPaymentReminderEmail({ id: 1 }, null);
  assert.strictEqual(r.reason, 'invalid_args');
  r = await email.sendPaymentReminderEmail({ id: 1, client_email: null }, { email: 'x@x.com' });
  assert.strictEqual(r.reason, 'no_client_email');
  assert.strictEqual(sends.length, 0, 'no send attempted under skip conditions');
  email.resetResendClient();
});

test('lib: sendPaymentReminderEmail happy path → recipient=client, reply-to=freelancer', async () => {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const sends = [];
  email.setResendClient({
    emails: { send: async (p) => { sends.push(p); return { data: { id: 'em_reminder' } }; } }
  });
  const r = await email.sendPaymentReminderEmail(
    {
      id: 5, invoice_number: 'INV-1', total: '500', currency: 'usd',
      client_email: 'acme@x.example', client_name: 'Acme', public_token: 'abcdef0123456789'
    },
    { id: 1, email: 'sam@sam.co', name: 'Sam', business_name: 'Sam Co', reply_to_email: 'replies@sam.co' }
  );
  assert.strictEqual(r.ok, true);
  assert.strictEqual(sends.length, 1);
  assert.deepStrictEqual(sends[0].to, ['acme@x.example'],
    'recipient must be the CLIENT, never the owner');
  assert.strictEqual(sends[0].reply_to, 'replies@sam.co',
    'reply-to bounces back to the freelancer so "I already paid" lands in their inbox');
  email.resetResendClient();
});

test('lib: exported public API includes the new reminder builders + sender', () => {
  clearReq('../lib/email');
  const email = require('../lib/email');
  assert.strictEqual(typeof email.sendPaymentReminderEmail, 'function');
  assert.strictEqual(typeof email.buildPaymentReminderSubject, 'function');
  assert.strictEqual(typeof email.buildPaymentReminderHtml, 'function');
  assert.strictEqual(typeof email.buildPaymentReminderText, 'function');
});

// ---- Layer 2: db.markInvoiceReminderSent SQL contract -------------------

function loadRealDb() { clearReq('../db'); return require('../db'); }

test('db.markInvoiceReminderSent: atomic UPDATE with status + cooldown + user_id predicates', async () => {
  let captured = null;
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [{ id: 5, last_reminder_email_at: new Date().toISOString() }] };
  };
  try {
    const out = await real.db.markInvoiceReminderSent(5, 7);
    assert.ok(captured, 'query issued');
    assert.match(captured.sql, /UPDATE\s+invoices/i, 'UPDATE invoices');
    assert.match(captured.sql, /SET\s+last_reminder_email_at\s*=\s*NOW\(\)/i, 'stamps the column');
    assert.match(captured.sql, /WHERE[\s\S]*id\s*=\s*\$1[\s\S]*user_id\s*=\s*\$2/i, 'id + user_id scoped');
    assert.match(captured.sql, /status\s+IN\s*\(\s*'sent'\s*,\s*'overdue'\s*\)/i,
      'status filter — never reminds draft/paid invoices');
    assert.match(captured.sql, /is_seed\s*=\s*false/i, 'seed invoice never stamps');
    assert.match(captured.sql, /last_reminder_email_at\s+IS\s+NULL/i, 'cooldown predicate (null branch)');
    assert.match(captured.sql, /last_reminder_email_at\s*<=\s*NOW\(\)\s*-\s*\(\$3\s*\*\s*INTERVAL/i,
      'cooldown predicate (interval branch) parameterised on $3');
    assert.match(captured.sql, /RETURNING\s+id,\s+last_reminder_email_at/i, 'returns id + stamp');
    assert.deepStrictEqual(captured.params, [5, 7, 48], 'default cooldown 48h');
    assert.strictEqual(out.id, 5);
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.markInvoiceReminderSent: cooldown parameter is honoured', async () => {
  let captured = null;
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async (sql, params) => { captured = { sql, params }; return { rows: [] }; };
  try {
    await real.db.markInvoiceReminderSent(5, 7, 24);
    assert.deepStrictEqual(captured.params, [5, 7, 24], 'custom cooldown passed through');
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.markInvoiceReminderSent: invalid args short-circuit without query', async () => {
  let queried = 0;
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async () => { queried++; return { rows: [] }; };
  try {
    assert.strictEqual(await real.db.markInvoiceReminderSent(0, 7), null);
    assert.strictEqual(await real.db.markInvoiceReminderSent(5, 0), null);
    assert.strictEqual(await real.db.markInvoiceReminderSent(null, 7), null);
    assert.strictEqual(await real.db.markInvoiceReminderSent('abc', 7), null);
    assert.strictEqual(queried, 0, 'no DB call under invalid args');
  } finally {
    real.pool.query = originalQuery;
  }
});

test('db.markInvoiceReminderSent: empty rows → null (cooldown active or not found)', async () => {
  const real = loadRealDb();
  const originalQuery = real.pool.query.bind(real.pool);
  real.pool.query = async () => ({ rows: [] });
  try {
    const out = await real.db.markInvoiceReminderSent(5, 7);
    assert.strictEqual(out, null,
      'no rows updated → null; route layer treats as 429 cooldown');
  } finally {
    real.pool.query = originalQuery;
  }
});

// ---- Layer 3: POST /invoices/:id/send-reminder --------------------------

let sendImpl = async () => ({ ok: true, id: 'em_route' });
let sendCalls = [];
function setSendImpl(fn) { sendImpl = fn; sendCalls = []; }

function buildInvoiceApp({ user, invoiceRow, markImpl, unstampCalls }) {
  const calls = { userById: [], invoiceById: [], mark: [], unstamp: [] };
  const dbStub = {
    pool: {
      query: async () => ({ rows: [] })
    },
    db: {
      async query(sql, params) {
        if (unstampCalls) unstampCalls.push({ sql, params });
        calls.unstamp.push({ sql, params });
        return { rows: [] };
      },
      async getUserById(id) {
        calls.userById.push(id);
        if (!user) return null;
        if (Number(user.id) !== Number(id)) return null;
        return user;
      },
      async getInvoiceById(id, uid) {
        calls.invoiceById.push({ id, uid });
        if (!invoiceRow) return null;
        if (Number(invoiceRow.user_id) !== Number(uid)) return null;
        if (Number(invoiceRow.id) !== Number(id)) return null;
        return invoiceRow;
      },
      async markInvoiceReminderSent(id, uid, hours) {
        calls.mark.push({ id, uid, hours });
        if (markImpl) return markImpl(id, uid, hours);
        return { id, last_reminder_email_at: new Date().toISOString() };
      },
      async getInvoicesByUser() { return []; },
      async getRecentRevenueStats() { return null; }
    }
  };
  require.cache[require.resolve('../db')] = {
    id: require.resolve('../db'), filename: require.resolve('../db'),
    loaded: true, exports: dbStub
  };

  const realEmailLib = (() => { clearReq('../lib/email'); return require('../lib/email'); })();
  const emailStub = {
    ...realEmailLib,
    sendPaymentReminderEmail: async (invoice, owner) => {
      sendCalls.push({ invoice, owner });
      return sendImpl(invoice, owner);
    }
  };
  require.cache[require.resolve('../lib/email')] = {
    id: require.resolve('../lib/email'), filename: require.resolve('../lib/email'),
    loaded: true, exports: emailStub
  };

  require.cache[require.resolve('../lib/outbound-webhook')] = {
    id: require.resolve('../lib/outbound-webhook'),
    filename: require.resolve('../lib/outbound-webhook'),
    loaded: true,
    exports: {
      isValidWebhookUrl: async () => true,
      buildPaidPayload: () => ({}),
      firePaidWebhook: async () => ({ ok: true }),
      setHostnameResolver: () => {}
    }
  };

  clearReq('../routes/invoices');
  const invoiceRoutes = require('../routes/invoices');
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', VIEWS);
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, res, next) => {
    req.session.user = { id: 7, plan: user ? user.plan : 'free' };
    next();
  });
  app.use('/invoices', invoiceRoutes);
  return { app, calls };
}

function postReminder(app, id) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const req = http.request({
        hostname: '127.0.0.1', port, path: `/invoices/${id}/send-reminder`,
        method: 'POST',
        headers: { 'Accept': 'application/json' }
      }, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => server.close(() => resolve({
          status: res.statusCode, body: data, headers: res.headers
        })));
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.end();
    });
  });
}

test('route: happy path → 200, sent_to, message_id, no-store', async () => {
  setSendImpl(async () => ({ ok: true, id: 'em_happy' }));
  const { app, calls } = buildInvoiceApp({
    user: { id: 7, plan: 'free', email: 'sam@x.com', name: 'Sam' },
    invoiceRow: {
      id: 5, user_id: 7, status: 'overdue',
      invoice_number: 'INV-1', client_email: 'acme@x.example',
      client_name: 'Acme', total: '500.00', public_token: 'abc',
      is_seed: false
    }
  });
  const r = await postReminder(app, 5);
  assert.strictEqual(r.status, 200, 'happy path 200; got ' + r.status + ' body=' + r.body);
  const body = JSON.parse(r.body);
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.sent_to, 'acme@x.example',
    'sent_to echoes client email — server confirms which mailbox it landed in');
  assert.strictEqual(body.message_id, 'em_happy');
  assert.strictEqual(sendCalls.length, 1, 'exactly one send fired');
  assert.strictEqual(sendCalls[0].invoice.client_email, 'acme@x.example');
  assert.strictEqual(sendCalls[0].owner.id, 7);
  assert.ok(/no-store/i.test(r.headers['cache-control'] || ''),
    'Cache-Control: no-store; got ' + r.headers['cache-control']);
});

test('route: free plan ALLOWED (M4 closer must not be Pro-gated)', async () => {
  setSendImpl(async () => ({ ok: true, id: 'em_free' }));
  const { app } = buildInvoiceApp({
    user: { id: 7, plan: 'free', email: 'sam@x.com' },
    invoiceRow: {
      id: 5, user_id: 7, status: 'sent', invoice_number: 'INV-1',
      client_email: 'acme@x.example', client_name: 'Acme', total: '500',
      public_token: 'abc', is_seed: false
    }
  });
  const r = await postReminder(app, 5);
  assert.strictEqual(r.status, 200,
    'free plan must be allowed (activation surface — pay-rate matters for everyone)');
});

test('route: draft status → 400 wrong_status (never remind a draft)', async () => {
  setSendImpl(async () => { throw new Error('should not be called'); });
  const { app, calls } = buildInvoiceApp({
    user: { id: 7, plan: 'free', email: 'sam@x.com' },
    invoiceRow: {
      id: 5, user_id: 7, status: 'draft', invoice_number: 'INV-1',
      client_email: 'acme@x.example', client_name: 'Acme', total: '500',
      public_token: 'abc', is_seed: false
    }
  });
  const r = await postReminder(app, 5);
  assert.strictEqual(r.status, 400);
  const body = JSON.parse(r.body);
  assert.strictEqual(body.error, 'wrong_status');
  assert.strictEqual(body.status, 'draft',
    'response carries the actual status so the UI can explain why the click failed');
  assert.strictEqual(sendCalls.length, 0);
  assert.strictEqual(calls.mark.length, 0, 'never stamp on a wrong-status reject');
});

test('route: paid status → 400 wrong_status (no nudging paid invoices)', async () => {
  const { app } = buildInvoiceApp({
    user: { id: 7, plan: 'free', email: 'sam@x.com' },
    invoiceRow: {
      id: 5, user_id: 7, status: 'paid', invoice_number: 'INV-1',
      client_email: 'acme@x.example', client_name: 'Acme', total: '500',
      public_token: 'abc', is_seed: false
    }
  });
  const r = await postReminder(app, 5);
  assert.strictEqual(r.status, 400);
  assert.strictEqual(JSON.parse(r.body).error, 'wrong_status');
  assert.strictEqual(sendCalls.length, 0);
});

test('route: seed invoice → 400 is_seed (defence-in-depth)', async () => {
  const { app } = buildInvoiceApp({
    user: { id: 7, plan: 'free', email: 'sam@x.com' },
    invoiceRow: {
      id: 5, user_id: 7, status: 'sent', invoice_number: 'INV-1',
      client_email: 'acme@x.example', client_name: 'Acme', total: '500',
      public_token: 'abc', is_seed: true
    }
  });
  const r = await postReminder(app, 5);
  assert.strictEqual(r.status, 400);
  assert.strictEqual(JSON.parse(r.body).error, 'is_seed');
  assert.strictEqual(sendCalls.length, 0);
});

test('route: missing client_email → 400 no_client_email', async () => {
  const { app, calls } = buildInvoiceApp({
    user: { id: 7, plan: 'free', email: 'sam@x.com' },
    invoiceRow: {
      id: 5, user_id: 7, status: 'sent', invoice_number: 'INV-1',
      client_email: null, client_name: 'Acme', total: '500',
      public_token: 'abc', is_seed: false
    }
  });
  const r = await postReminder(app, 5);
  assert.strictEqual(r.status, 400);
  assert.strictEqual(JSON.parse(r.body).error, 'no_client_email');
  assert.strictEqual(sendCalls.length, 0);
  assert.strictEqual(calls.mark.length, 0, 'never stamp without a recipient');
});

test('route: cooldown still active → 429 cooldown (no send, no double-stamp)', async () => {
  setSendImpl(async () => { throw new Error('should not be called'); });
  const { app, calls } = buildInvoiceApp({
    user: { id: 7, plan: 'free', email: 'sam@x.com' },
    invoiceRow: {
      id: 5, user_id: 7, status: 'sent', invoice_number: 'INV-1',
      client_email: 'acme@x.example', client_name: 'Acme', total: '500',
      public_token: 'abc', is_seed: false
    },
    markImpl: async () => null // simulate cooldown active
  });
  const r = await postReminder(app, 5);
  assert.strictEqual(r.status, 429);
  assert.strictEqual(JSON.parse(r.body).error, 'cooldown');
  assert.strictEqual(sendCalls.length, 0);
  assert.strictEqual(calls.mark.length, 1, 'stamp attempted exactly once');
});

test('route: cross-tenant invoice → 404 not_found (never leaks)', async () => {
  setSendImpl(async () => { throw new Error('should not be called'); });
  const { app, calls } = buildInvoiceApp({
    user: { id: 7, plan: 'free', email: 'sam@x.com' },
    invoiceRow: {
      id: 5, user_id: 999, // different owner
      status: 'sent', invoice_number: 'INV-1',
      client_email: 'acme@x.example', client_name: 'Acme', total: '500',
      public_token: 'abc', is_seed: false
    }
  });
  const r = await postReminder(app, 5);
  assert.strictEqual(r.status, 404);
  assert.strictEqual(JSON.parse(r.body).error, 'not_found');
  assert.strictEqual(sendCalls.length, 0);
  assert.strictEqual(calls.mark.length, 0);
});

test('route: unknown invoice id → 404 not_found', async () => {
  const { app } = buildInvoiceApp({
    user: { id: 7, plan: 'free', email: 'sam@x.com' },
    invoiceRow: null
  });
  const r = await postReminder(app, 999);
  assert.strictEqual(r.status, 404);
  assert.strictEqual(JSON.parse(r.body).error, 'not_found');
});

test('route: unauthenticated (getUserById null) → 401 unauthorized', async () => {
  setSendImpl(async () => { throw new Error('should not be called'); });
  const { app } = buildInvoiceApp({
    user: null,
    invoiceRow: {
      id: 5, user_id: 7, status: 'sent', invoice_number: 'INV-1',
      client_email: 'acme@x.example', client_name: 'Acme', total: '500',
      public_token: 'abc', is_seed: false
    }
  });
  const r = await postReminder(app, 5);
  assert.strictEqual(r.status, 401);
  assert.strictEqual(JSON.parse(r.body).error, 'unauthorized');
});

test('route: Resend not_configured → 503 + unstamp (so a future retry can fire)', async () => {
  setSendImpl(async () => ({ ok: false, reason: 'not_configured' }));
  const unstampCalls = [];
  const { app } = buildInvoiceApp({
    user: { id: 7, plan: 'free', email: 'sam@x.com' },
    invoiceRow: {
      id: 5, user_id: 7, status: 'sent', invoice_number: 'INV-1',
      client_email: 'acme@x.example', client_name: 'Acme', total: '500',
      public_token: 'abc', is_seed: false
    },
    unstampCalls
  });
  const r = await postReminder(app, 5);
  assert.strictEqual(r.status, 503);
  assert.strictEqual(JSON.parse(r.body).error, 'not_configured');
  assert.ok(unstampCalls.length >= 1, 'unstamp UPDATE issued after the failed send');
  assert.match(unstampCalls[0].sql, /UPDATE\s+invoices\s+SET\s+last_reminder_email_at\s*=\s*NULL/i,
    'unstamp clears the stamp');
  assert.match(unstampCalls[0].sql, /WHERE\s+id\s*=\s*\$1\s+AND\s+user_id\s*=\s*\$2/i,
    'unstamp scoped to the same id + user');
  assert.deepStrictEqual(unstampCalls[0].params, [5, 7]);
});

test('route: generic Resend failure → 502 + unstamp', async () => {
  setSendImpl(async () => ({ ok: false, reason: 'error', error: 'resend boom' }));
  const unstampCalls = [];
  const { app } = buildInvoiceApp({
    user: { id: 7, plan: 'free', email: 'sam@x.com' },
    invoiceRow: {
      id: 5, user_id: 7, status: 'sent', invoice_number: 'INV-1',
      client_email: 'acme@x.example', client_name: 'Acme', total: '500',
      public_token: 'abc', is_seed: false
    },
    unstampCalls
  });
  const r = await postReminder(app, 5);
  assert.strictEqual(r.status, 502);
  assert.strictEqual(JSON.parse(r.body).error, 'error');
  assert.ok(unstampCalls.length >= 1, 'unstamp after generic failure too');
});

test('route: send throws → 502 + unstamp (no unhandled rejection)', async () => {
  setSendImpl(async () => { throw new Error('network is down'); });
  const unstampCalls = [];
  const { app } = buildInvoiceApp({
    user: { id: 7, plan: 'free', email: 'sam@x.com' },
    invoiceRow: {
      id: 5, user_id: 7, status: 'sent', invoice_number: 'INV-1',
      client_email: 'acme@x.example', client_name: 'Acme', total: '500',
      public_token: 'abc', is_seed: false
    },
    unstampCalls
  });
  const r = await postReminder(app, 5);
  assert.strictEqual(r.status, 502, 'thrown error is caught and surfaced as 502');
  assert.ok(unstampCalls.length >= 1, 'unstamp on throw');
});

test('route: whitespace-only client_email → 400 no_client_email', async () => {
  const { app, calls } = buildInvoiceApp({
    user: { id: 7, plan: 'free', email: 'sam@x.com' },
    invoiceRow: {
      id: 5, user_id: 7, status: 'sent', invoice_number: 'INV-1',
      client_email: '   ', client_name: 'Acme', total: '500',
      public_token: 'abc', is_seed: false
    }
  });
  const r = await postReminder(app, 5);
  assert.strictEqual(r.status, 400);
  assert.strictEqual(JSON.parse(r.body).error, 'no_client_email');
  assert.strictEqual(calls.mark.length, 0);
});

// ---- Layer 4: buildOverduePrompt surfaces clientEmail -------------------

function buildPromptHelper() {
  clearReq('../routes/invoices');
  return require('../routes/invoices');
}

test('buildOverduePrompt: surfaces clientEmail when present + non-blank', () => {
  const routes = buildPromptHelper();
  const due = new Date(Date.now() - 5 * 86400000).toISOString();
  const prompt = routes.buildOverduePrompt(
    { id: 1 },
    {
      id: 7, due_date: due, invoice_number: 'INV-1',
      client_name: 'Acme', client_email: 'acme@x.com', total: '500',
      status: 'overdue', public_token: 'abcdef0123456789'
    },
    {}
  );
  assert.strictEqual(prompt.clientEmail, 'acme@x.com',
    'overdue prompt threads clientEmail when present');
});

test('buildOverduePrompt: trims whitespace on clientEmail', () => {
  const routes = buildPromptHelper();
  const due = new Date(Date.now() - 5 * 86400000).toISOString();
  const prompt = routes.buildOverduePrompt(
    { id: 1 },
    {
      id: 7, due_date: due, invoice_number: 'INV-1',
      client_name: 'Acme', client_email: '  acme@x.com  ', total: '500',
      status: 'overdue', public_token: 'abcdef0123456789'
    },
    {}
  );
  assert.strictEqual(prompt.clientEmail, 'acme@x.com');
});

test('buildOverduePrompt: clientEmail is empty string when invoice has none', () => {
  const routes = buildPromptHelper();
  const due = new Date(Date.now() - 5 * 86400000).toISOString();
  const prompt = routes.buildOverduePrompt(
    { id: 1 },
    {
      id: 7, due_date: due, invoice_number: 'INV-1',
      client_name: 'Acme', client_email: null, total: '500',
      status: 'overdue', public_token: 'abcdef0123456789'
    },
    {}
  );
  assert.strictEqual(prompt.clientEmail, '',
    'empty string (not null) so the view can do a falsy check uniformly');
});

// ---- Layer 5: dashboard.ejs renders the send-reminder button ------------

const dashboardTplPath = path.join(__dirname, '..', 'views', 'dashboard.ejs');
const dashboardTpl = fs.readFileSync(dashboardTplPath, 'utf8');

function renderDashboard(locals) {
  return ejs.render(dashboardTpl, Object.assign({
    title: 'Dashboard',
    flash: null,
    days_left_in_trial: 0,
    csrfToken: 'TEST_CSRF',
    invoices: [],
    user: { plan: 'free', invoice_count: 5, subscription_status: null },
    onboarding: null,
    invoiceLimitProgress: null,
    recentRevenue: null,
    annualUpgradePrompt: null,
    socialProof: null,
    celebration: null,
    staleDraftPrompt: null,
    paymentClaimPrompt: null,
    recentViewPrompt: null,
    clientViewedFollowupPrompt: null,
    sentNotViewedPrompt: null,
    overduePrompt: null,
    firstRealInvoicePrompt: null,
    freshDraftPrompt: null,
    repeatClientPrompt: null,
    pendingQuickInvoice: null,
    tableFollowUpIntents: {}
  }, locals), {
    views: [path.join(__dirname, '..', 'views')],
    filename: dashboardTplPath
  });
}

function overduePromptFixture(extra) {
  return Object.assign({
    id: 7,
    invoiceNumber: 'INV-2026-0007',
    clientName: 'Acme',
    clientEmail: 'acme@x.example',
    total: 500,
    daysPastDue: 5,
    status: 'overdue',
    followUpIntents: {
      body: 'b', subject: 's', overdue: true,
      whatsapp: 'https://wa.me/?text=x',
      sms: 'sms:?&body=x',
      mailto: 'mailto:acme%40x.example?subject=x&body=x',
      url: 'https://decentinvoice.test/i/abc'
    }
  }, extra || {});
}

test('view: send-reminder button RENDERS when overduePrompt.clientEmail is set', () => {
  const html = renderDashboard({ overduePrompt: overduePromptFixture() });
  assert.match(html, /data-testid="overdue-send-reminder"/, 'button rendered');
  assert.match(html, /data-testid="overdue-send-reminder-status"/, 'status line rendered');
  const tag = html.match(/<button[^>]*data-testid="overdue-send-reminder"[^>]*>/);
  assert.ok(tag, 'button tag located');
  assert.match(tag[0], /data-invoice-id="7"/, 'data-invoice-id wired');
  assert.match(tag[0], /data-csrf="TEST_CSRF"/, 'CSRF token threaded');
  assert.match(tag[0], /data-client-email="acme@x\.example"/, 'recipient email surfaced for the success label');
});

test('view: send-reminder button OMITTED when clientEmail missing', () => {
  const html = renderDashboard({ overduePrompt: overduePromptFixture({ clientEmail: '' }) });
  assert.doesNotMatch(html, /data-testid="overdue-send-reminder"/,
    'no button when there is no recipient — the route would 400 anyway');
  assert.match(html, /data-testid="overdue-prompt"/, 'the rest of the overdue prompt still renders');
});

test('view: button label includes the client email so the user knows where it will land', () => {
  const html = renderDashboard({ overduePrompt: overduePromptFixture() });
  assert.match(html, /Send reminder via DecentInvoice \(to acme@x\.example\)/,
    'label carries the recipient address visibly — no surprise about where the email lands');
});

test('view: inline onclick handler POSTs to /invoices/:id/send-reminder with CSRF', () => {
  const html = renderDashboard({ overduePrompt: overduePromptFixture() });
  // Capture the entire onclick attribute value (which contains the handler
  // body) via a double-quoted attribute match. A naive `<button[^>]*>` regex
  // would stop at the first `>` inside the onclick string literal.
  const onclick = html.match(/data-testid="overdue-send-reminder"[\s\S]*?onclick="([\s\S]*?)"/);
  assert.ok(onclick, 'onclick handler located');
  const handler = onclick[1];
  assert.match(handler, /\/send-reminder/, 'POSTs to /send-reminder');
  assert.match(handler, /X-CSRF-Token/, 'sends X-CSRF-Token header');
  assert.match(handler, /method:\s*'POST'/, 'POST');
  assert.match(handler, /btn\.disabled\s*=\s*true/,
    'button disabled before issuing fetch (no panicked double-tap blasting two reminders)');
});

test('view: status <p> starts hidden until handler updates it', () => {
  const html = renderDashboard({ overduePrompt: overduePromptFixture() });
  const p = html.match(/<p[^>]*data-testid="overdue-send-reminder-status"[^>]*>/);
  assert.ok(p, 'status p located');
  assert.match(p[0], /\shidden(?:>|\s|=)/,
    'status p starts hidden — only revealed once the user clicks');
});

test('view: button class carries disabled styling for the post-send 48h locked state', () => {
  const html = renderDashboard({ overduePrompt: overduePromptFixture() });
  const tag = html.match(/<button[^>]*data-testid="overdue-send-reminder"[^>]*>/);
  assert.match(tag[0], /disabled:opacity-50/,
    'Tailwind disabled-state class — the handler sets btn.disabled after a success');
});

test('view: send-reminder cluster lives inside the overdue prompt (no leak to other prompts)', () => {
  const html = renderDashboard({
    overduePrompt: overduePromptFixture(),
    repeatClientPrompt: {
      sourceId: 99,
      invoiceNumber: 'INV-99',
      clientName: 'Other',
      total: 100,
      daysAgo: 2
    }
  });
  // The button is nested inside the overdue prompt's wrapper. Capture from the
  // overdue prompt wrapper start to the next prompt's wrapper start.
  const overdueBlock = html.match(/data-testid="overdue-prompt"[\s\S]*?data-testid="(?:repeat-client-prompt|fresh-draft-prompt|invoices-table)/);
  assert.ok(overdueBlock, 'overdue block bounded');
  assert.match(overdueBlock[0], /data-testid="overdue-send-reminder"/,
    'button lives in the overdue prompt wrapper');
});

// ---- Runner -------------------------------------------------------------

(async function run() {
  let passed = 0, failed = 0;
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
  console.log(`\n${passed} passed, ${failed} failed (dashboard-send-reminder.test.js)`);
  if (failed > 0) process.exit(1);
})();
