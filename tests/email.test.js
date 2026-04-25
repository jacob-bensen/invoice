'use strict';

/*
 * Email delivery tests (INTERNAL_TODO #13).
 *
 * Covers:
 *  1.  lib/email: sendEmail returns { ok:false, reason:'not_configured' } when
 *      no Resend client is present (graceful degradation, no throw).
 *  2.  lib/email: sendEmail returns { ok:false, reason:'invalid_args' } when
 *      required fields are missing.
 *  3.  lib/email: sendEmail with an injected client posts the expected
 *      payload (from, to, subject, html, reply_to) and returns ok:true.
 *  4.  lib/email: sendEmail catches client throws and returns ok:false (never
 *      bubbles errors to the caller).
 *  5.  lib/email: buildInvoiceSubject includes invoice number + business
 *      name.
 *  6.  lib/email: buildInvoiceHtml escapes user input (XSS guard) and renders
 *      the payment link button when a URL is set.
 *  7.  lib/email: resolveReplyTo prefers reply_to_email > business_email > email.
 *  8.  lib/email: sendInvoiceEmail short-circuits with no_client_email when
 *      client_email is missing.
 *  9.  POST /invoices/:id/status=sent for a Pro user with a client_email →
 *      sendInvoiceEmail is called with the correct invoice + owner.
 * 10.  POST /invoices/:id/status=sent for a Free user → email is NOT sent
 *      (plan-gated behind Pro/Agency).
 * 11.  POST /invoices/:id/status=sent for a Pro invoice without a
 *      client_email → email is NOT sent (no recipient).
 * 12.  POST /invoices/:id/status=sent — a sendInvoiceEmail rejection does NOT
 *      block the redirect (fire-and-forget guarantee).
 * 13.  POST /billing/settings — accepts a valid reply_to_email and persists
 *      it via db.updateUser; rejects an invalid email with a flash and no
 *      DB write.
 * 14.  views/settings.ejs — renders the reply-to email input field with the
 *      stored value pre-filled.
 *
 * Run: NODE_ENV=test node tests/email.test.js
 */

const assert = require('assert');
const path = require('path');
const ejs = require('ejs');
const express = require('express');
const session = require('express-session');
const http = require('http');

function clearReq(mod) { delete require.cache[require.resolve(mod)]; }

// ---------- Lib-level (no HTTP) tests ------------------------------------

async function testSendEmailNotConfigured() {
  // Force a clean require + ensure no API key + no injected client.
  clearReq('../lib/email');
  delete process.env.RESEND_API_KEY;
  const email = require('../lib/email');
  email.resetResendClient();
  const r = await email.sendEmail({ to: 'x@y.com', subject: 's', html: '<p>h</p>' });
  assert.strictEqual(r.ok, false, 'must not be ok when not configured');
  assert.strictEqual(r.reason, 'not_configured',
    'must report not_configured (graceful degradation, never throw)');
}

async function testSendEmailInvalidArgs() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  email.setResendClient({ emails: { send: async () => ({ data: { id: 'x' } }) } });
  const r1 = await email.sendEmail({});
  assert.strictEqual(r1.ok, false);
  assert.strictEqual(r1.reason, 'invalid_args');
  const r2 = await email.sendEmail({ to: 'x@y.com', subject: 's' });
  assert.strictEqual(r2.ok, false, 'must require html or text');
  assert.strictEqual(r2.reason, 'invalid_args');
  email.resetResendClient();
}

async function testSendEmailHappyPath() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const sends = [];
  email.setResendClient({
    emails: {
      async send(payload) {
        sends.push(payload);
        return { data: { id: 'em_abc123' }, error: null };
      }
    }
  });

  const r = await email.sendEmail({
    to: 'client@acme.com',
    subject: 'Hi',
    html: '<p>hello</p>',
    text: 'hello',
    replyTo: 'reply@me.com',
    from: 'me@me.com'
  });

  assert.strictEqual(r.ok, true, 'must return ok=true');
  assert.strictEqual(r.id, 'em_abc123', 'must surface the Resend message id');
  assert.strictEqual(sends.length, 1, 'must call the Resend client exactly once');
  const payload = sends[0];
  assert.strictEqual(payload.from, 'me@me.com');
  assert.deepStrictEqual(payload.to, ['client@acme.com'], 'to must be normalised to array');
  assert.strictEqual(payload.subject, 'Hi');
  assert.strictEqual(payload.html, '<p>hello</p>');
  assert.strictEqual(payload.text, 'hello');
  assert.strictEqual(payload.reply_to, 'reply@me.com',
    'reply_to is the Resend SDK key (snake_case)');
  email.resetResendClient();
}

async function testSendEmailSwallowsThrows() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  email.setResendClient({
    emails: {
      async send() { throw new Error('SMTP exploded'); }
    }
  });
  const r = await email.sendEmail({ to: 'x@y.com', subject: 's', html: '<p>h</p>' });
  assert.strictEqual(r.ok, false, 'thrown errors must surface as ok:false');
  assert.strictEqual(r.reason, 'error');
  assert.ok(r.error && r.error.includes('SMTP exploded'),
    'error message must propagate so the caller can log it');
  email.resetResendClient();
}

async function testBuildInvoiceSubject() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const subject = email.buildInvoiceSubject(
    { invoice_number: 'INV-2026-0007' },
    { business_name: 'Acme Studio', email: 'a@b.c' }
  );
  assert.ok(subject.includes('INV-2026-0007'), 'subject must include invoice number');
  assert.ok(subject.includes('Acme Studio'), 'subject must include business name');
}

async function testBuildInvoiceHtmlEscapesAndRendersPayLink() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const html = email.buildInvoiceHtml(
    {
      invoice_number: 'INV-2026-0008',
      total: '250.00',
      currency: 'usd',
      client_name: '<script>alert(1)</script>',
      due_date: '2026-05-01',
      items: [{ description: 'Logo "design"', quantity: 2, unit_price: 100 }],
      payment_link_url: 'https://buy.stripe.com/test_abc'
    },
    { business_name: 'Acme & Co', email: 'a@b.c' }
  );
  assert.ok(!html.includes('<script>alert(1)</script>'),
    'raw client_name must not appear unescaped (XSS guard)');
  assert.ok(html.includes('&lt;script&gt;'),
    'client_name must appear HTML-escaped');
  assert.ok(html.includes('Acme &amp; Co'),
    'ampersand in business_name must be escaped');
  assert.ok(html.includes('Logo &quot;design&quot;'),
    'item description quotes must be escaped');
  assert.ok(html.includes('https://buy.stripe.com/test_abc'),
    'payment link URL must be rendered as a Pay button');
  assert.ok(html.includes('$250.00'), 'total must include currency symbol');
}

async function testResolveReplyToPrecedence() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  assert.strictEqual(
    email.resolveReplyTo({ reply_to_email: 'a@x.com', business_email: 'b@x.com', email: 'c@x.com' }),
    'a@x.com',
    'reply_to_email wins'
  );
  assert.strictEqual(
    email.resolveReplyTo({ reply_to_email: null, business_email: 'b@x.com', email: 'c@x.com' }),
    'b@x.com',
    'business_email is the second-choice'
  );
  assert.strictEqual(
    email.resolveReplyTo({ reply_to_email: null, business_email: null, email: 'c@x.com' }),
    'c@x.com',
    'account email is the final fallback'
  );
  assert.strictEqual(email.resolveReplyTo(null), null, 'null owner must yield null reply-to');
}

async function testSendInvoiceEmailNoClientEmail() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const r = await email.sendInvoiceEmail(
    { invoice_number: 'INV-1', total: '10', client_email: null },
    { email: 'me@x.com' }
  );
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no_client_email',
    'no client_email must short-circuit before calling Resend');
}

// ---------- HTTP-level tests (route integration) -------------------------

const users = new Map();
const invoices = new Map();
const updateUserCalls = [];
const sendInvoiceEmailCalls = [];
let sendInvoiceEmailImpl = async () => ({ ok: true, id: 'em_x' });

function resetStores() {
  users.clear();
  invoices.clear();
  updateUserCalls.length = 0;
  sendInvoiceEmailCalls.length = 0;
}

const dbStub = {
  pool: { query: async () => ({ rows: [] }) },
  db: {
    async getUserByEmail() { return null; },
    async getUserById(id) { return users.get(id) || null; },
    async createUser() { throw new Error('unused'); },
    async updateUser(id, fields) {
      updateUserCalls.push({ id, fields });
      const u = users.get(id);
      if (u) Object.assign(u, fields);
      return u || null;
    },
    async getInvoicesByUser(userId) {
      return [...invoices.values()].filter(i => i.user_id === userId);
    },
    async getInvoiceById(id, userId) {
      const inv = invoices.get(parseInt(id, 10));
      if (!inv || inv.user_id !== userId) return null;
      return inv;
    },
    async updateInvoiceStatus(id, userId, status) {
      const inv = invoices.get(parseInt(id, 10));
      if (!inv || inv.user_id !== userId) return null;
      inv.status = status;
      return inv;
    },
    async setInvoicePaymentLink(id, userId, url, linkId) {
      const inv = invoices.get(parseInt(id, 10));
      if (!inv || inv.user_id !== userId) return null;
      inv.payment_link_url = url;
      inv.payment_link_id = linkId;
      return inv;
    },
    async markInvoicePaidByPaymentLinkId() { return null; },
    async getNextInvoiceNumber() { return 'INV-2026-0001'; }
  }
};

require.cache[require.resolve('../db')] = {
  id: require.resolve('../db'),
  filename: require.resolve('../db'),
  loaded: true,
  exports: dbStub
};

// Stripe Payment Link stub — never hit a real Stripe API in tests.
require.cache[require.resolve('../lib/stripe-payment-link')] = {
  id: require.resolve('../lib/stripe-payment-link'),
  filename: require.resolve('../lib/stripe-payment-link'),
  loaded: true,
  exports: { createInvoicePaymentLink: async () => ({ id: 'plink_x', url: 'https://buy.stripe.com/x' }) }
};

// Stub the email lib at the module-cache level so routes/invoices.js
// imports our spy instead of the real Resend wrapper.
const realEmailLib = (() => {
  // Force a clean require so the lib state is pristine.
  clearReq('../lib/email');
  return require('../lib/email');
})();
const emailStub = {
  ...realEmailLib,
  sendInvoiceEmail: async (invoice, owner) => {
    sendInvoiceEmailCalls.push({ invoice, owner });
    return sendInvoiceEmailImpl(invoice, owner);
  }
};
require.cache[require.resolve('../lib/email')] = {
  id: require.resolve('../lib/email'),
  filename: require.resolve('../lib/email'),
  loaded: true,
  exports: emailStub
};

// Outbound webhook stub — unrelated to email but invoices.js still imports it.
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
clearReq('../routes/billing');
const invoiceRoutes = require('../routes/invoices');
const billingRoutes = require('../routes/billing');

function buildApp(sessionUser) {
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
  app.use('/invoices', invoiceRoutes);
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

async function testStatusSentProUserSendsEmail() {
  resetStores();
  sendInvoiceEmailImpl = async () => ({ ok: true, id: 'em_42' });
  users.set(7, {
    id: 7, email: 'pro@x.com', name: 'P', plan: 'pro',
    business_name: 'Pro Studio', business_email: 'billing@pro.com',
    reply_to_email: 'replies@pro.com'
  });
  invoices.set(100, {
    id: 100, user_id: 7, invoice_number: 'INV-2026-0100',
    client_name: 'Acme', client_email: 'ap@acme.com',
    items: [], subtotal: 100, total: 100, status: 'draft',
    payment_link_url: null, payment_link_id: null
  });
  const app = buildApp({ id: 7, plan: 'pro' });

  const res = await request(app, 'POST', '/invoices/100/status', { status: 'sent' });
  assert.strictEqual(res.status, 302, 'must redirect after status update');
  // Allow any pending fire-and-forget promises to resolve.
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  assert.strictEqual(sendInvoiceEmailCalls.length, 1,
    'Pro user marking invoice sent must call sendInvoiceEmail once');
  const call = sendInvoiceEmailCalls[0];
  assert.strictEqual(call.invoice.id, 100);
  assert.strictEqual(call.invoice.client_email, 'ap@acme.com');
  assert.strictEqual(call.owner.id, 7);
  assert.strictEqual(call.owner.reply_to_email, 'replies@pro.com');
}

async function testStatusSentFreeUserDoesNotSendEmail() {
  resetStores();
  users.set(8, { id: 8, email: 'free@x.com', plan: 'free', name: 'F' });
  invoices.set(101, {
    id: 101, user_id: 8, invoice_number: 'INV-2026-0101',
    client_name: 'C', client_email: 'c@example.com',
    items: [], subtotal: 50, total: 50, status: 'draft',
    payment_link_url: null
  });
  const app = buildApp({ id: 8, plan: 'free' });

  const res = await request(app, 'POST', '/invoices/101/status', { status: 'sent' });
  assert.strictEqual(res.status, 302);
  await new Promise(r => setImmediate(r));
  assert.strictEqual(sendInvoiceEmailCalls.length, 0,
    'Free-plan invoices must not trigger Pro email sending');
}

async function testStatusSentProInvoiceNoClientEmail() {
  resetStores();
  users.set(9, { id: 9, email: 'pro@x.com', plan: 'pro', name: 'P' });
  invoices.set(102, {
    id: 102, user_id: 9, invoice_number: 'INV-2026-0102',
    client_name: 'C', client_email: null,
    items: [], subtotal: 50, total: 50, status: 'draft',
    payment_link_url: 'https://buy.stripe.com/old'
  });
  const app = buildApp({ id: 9, plan: 'pro' });

  const res = await request(app, 'POST', '/invoices/102/status', { status: 'sent' });
  assert.strictEqual(res.status, 302);
  await new Promise(r => setImmediate(r));
  assert.strictEqual(sendInvoiceEmailCalls.length, 0,
    'invoices without client_email must skip the Pro email send');
}

async function testStatusSentEmailRejectionDoesNotBlock() {
  resetStores();
  let sendStarted = false, sendResolved = false;
  // Hold the send pending past the redirect — proves the route doesn't await it.
  sendInvoiceEmailImpl = async () => {
    sendStarted = true;
    await new Promise(r => setTimeout(r, 30));
    sendResolved = true;
    throw new Error('upstream Resend 503');
  };
  users.set(10, { id: 10, email: 'pro@x.com', plan: 'pro', name: 'P' });
  invoices.set(103, {
    id: 103, user_id: 10, invoice_number: 'INV-2026-0103',
    client_name: 'C', client_email: 'c@example.com',
    items: [], subtotal: 75, total: 75, status: 'draft',
    payment_link_url: 'https://buy.stripe.com/x'
  });
  const app = buildApp({ id: 10, plan: 'pro' });

  const t0 = Date.now();
  const res = await request(app, 'POST', '/invoices/103/status', { status: 'sent' });
  const elapsed = Date.now() - t0;
  assert.strictEqual(res.status, 302, 'redirect must succeed even if email is failing');
  assert.ok(elapsed < 50, `redirect must not await the send (took ${elapsed}ms)`);
  assert.strictEqual(sendStarted, true, 'the send must have been initiated');
  // Now wait for the rejection to settle and confirm nothing crashes.
  await new Promise(r => setTimeout(r, 60));
  assert.strictEqual(sendResolved, true, 'the rejection must have fired');
}

async function testSettingsAcceptsValidReplyToEmail() {
  resetStores();
  users.set(11, {
    id: 11, email: 'b@x.com', name: 'B', plan: 'free',
    business_name: null, business_email: null, business_phone: null, business_address: null,
    reply_to_email: null
  });
  const app = buildApp({ id: 11, plan: 'free', name: 'B', email: 'b@x.com' });

  const res = await request(app, 'POST', '/billing/settings', {
    name: 'B',
    business_name: 'B Inc',
    business_address: '',
    business_phone: '',
    business_email: '',
    reply_to_email: 'replies@b.com'
  });
  assert.strictEqual(res.status, 302);
  assert.ok(updateUserCalls.length >= 1, 'db.updateUser must be called');
  const call = updateUserCalls[updateUserCalls.length - 1];
  assert.strictEqual(call.fields.reply_to_email, 'replies@b.com',
    'valid reply_to_email must be persisted');
}

async function testSettingsRejectsInvalidReplyToEmail() {
  resetStores();
  users.set(12, {
    id: 12, email: 'b@x.com', name: 'B', plan: 'free',
    reply_to_email: null
  });
  const app = buildApp({ id: 12, plan: 'free', name: 'B', email: 'b@x.com' });

  const res = await request(app, 'POST', '/billing/settings', {
    name: 'B',
    reply_to_email: 'not-an-email'
  });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(updateUserCalls.length, 0,
    'invalid reply_to_email must NOT trigger a DB write');
}

async function testSettingsViewRendersReplyToField() {
  // Render the EJS view directly with a stub user.
  const html = await ejs.renderFile(
    path.join(__dirname, '..', 'views', 'settings.ejs'),
    {
      title: 'Settings',
      user: {
        email: 'b@x.com', name: 'B', plan: 'free',
        business_name: 'B Inc', business_address: null,
        business_email: null, business_phone: null,
        webhook_url: null, invoice_count: 0,
        reply_to_email: 'replies@b.com'
      },
      flash: null
    },
    { rmWhitespace: false }
  );
  assert.ok(html.includes('name="reply_to_email"'),
    'settings view must render the reply_to_email input');
  assert.ok(html.includes('value="replies@b.com"'),
    'stored reply_to_email must be pre-filled');
  assert.ok(/Reply-to email/i.test(html),
    'settings view must label the field for users');
}

// ---------- Runner -------------------------------------------------------

async function run() {
  const tests = [
    ['lib/email: sendEmail not_configured when API key absent', testSendEmailNotConfigured],
    ['lib/email: sendEmail rejects invalid args without throwing', testSendEmailInvalidArgs],
    ['lib/email: sendEmail happy path posts expected payload', testSendEmailHappyPath],
    ['lib/email: sendEmail swallows client throws', testSendEmailSwallowsThrows],
    ['lib/email: buildInvoiceSubject includes invoice number + business name', testBuildInvoiceSubject],
    ['lib/email: buildInvoiceHtml escapes XSS + renders pay-link button', testBuildInvoiceHtmlEscapesAndRendersPayLink],
    ['lib/email: resolveReplyTo precedence (reply_to_email > business_email > email)', testResolveReplyToPrecedence],
    ['lib/email: sendInvoiceEmail short-circuits when client_email is missing', testSendInvoiceEmailNoClientEmail],
    ['POST /invoices/:id/status=sent (Pro) → sendInvoiceEmail invoked', testStatusSentProUserSendsEmail],
    ['POST /invoices/:id/status=sent (Free) → no email', testStatusSentFreeUserDoesNotSendEmail],
    ['POST /invoices/:id/status=sent (Pro, no client_email) → no email', testStatusSentProInvoiceNoClientEmail],
    ['POST /invoices/:id/status=sent (Pro) — email rejection does not block redirect', testStatusSentEmailRejectionDoesNotBlock],
    ['POST /billing/settings → valid reply_to_email persisted', testSettingsAcceptsValidReplyToEmail],
    ['POST /billing/settings → invalid reply_to_email rejected, no DB write', testSettingsRejectsInvalidReplyToEmail],
    ['views/settings.ejs renders the reply-to email input with stored value', testSettingsViewRendersReplyToField]
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

run().catch(err => { console.error(err); process.exit(1); });
