'use strict';

/*
 * Paid-notification email tests (INTERNAL_TODO #30).
 *
 * Covers:
 *  1. lib/email: buildPaidNotificationSubject — includes invoice number + total.
 *  2. lib/email: buildPaidNotificationHtml — escapes hostile client_name (XSS),
 *     includes the formatted total, and renders the View-invoice button when
 *     APP_URL is set.
 *  3. lib/email: sendPaidNotificationEmail short-circuits with no_owner_email
 *     when the owner row has no email (defensive — should never happen).
 *  4. lib/email: sendPaidNotificationEmail — happy path uses the owner's email
 *     as the recipient (NOT the client) and sets reply_to via resolveReplyTo.
 *  5. routes/billing.js webhook (payment_link mode) — sendPaidNotificationEmail
 *     is called once with the right invoice + owner.
 *  6. routes/billing.js webhook (payment_link mode) — a paid notification
 *     rejection does NOT roll back the invoice's marked-paid state nor a
 *     `not_configured` send: the webhook still returns 200 (fire-and-forget
 *     guarantee).
 *  7. routes/billing.js webhook (subscription mode, NOT payment_link) — does
 *     NOT trigger a paid-notification (guard on session.mode === 'payment').
 *
 * Run: NODE_ENV=test node tests/paid-notification.test.js
 */

const assert = require('assert');
const express = require('express');
const http = require('http');

function clearReq(mod) { delete require.cache[require.resolve(mod)]; }

// ---------- Lib-level (no HTTP) tests ------------------------------------

async function testBuildSubject() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const subject = email.buildPaidNotificationSubject({
    invoice_number: 'INV-2026-0042',
    total: '1250.00',
    currency: 'usd'
  });
  assert.ok(subject.includes('INV-2026-0042'),
    'subject must include the invoice number');
  assert.ok(subject.includes('$1250.00'),
    'subject must include the formatted total with currency symbol');
  assert.ok(/just paid/i.test(subject),
    'subject must communicate the "just paid" event for emotional impact');
}

async function testBuildHtmlOmitsButtonWhenAppUrlUnset() {
  clearReq('../lib/email');
  const prev = process.env.APP_URL;
  delete process.env.APP_URL;
  const email = require('../lib/email');
  const html = email.buildPaidNotificationHtml(
    { id: 12, invoice_number: 'INV-X', total: '5.00', currency: 'usd', client_name: 'Acme' },
    { name: 'Sam', email: 'sam@x.com' }
  );
  if (prev !== undefined) process.env.APP_URL = prev;

  // No `<a href=` button block when we can't build a canonical URL.
  assert.ok(!/href="https?:\/\//.test(html),
    'no View-invoice button must render when APP_URL is not set (no canonical host)');
  // The body still renders — the rest of the message is informative on its own.
  assert.ok(html.includes('INV-X'), 'invoice number still appears');
  assert.ok(html.includes('$5.00'), 'total still appears');
  assert.ok(html.includes('Acme'), 'client name still appears');
}

async function testBuildTextIncludesAllFactsAndUrl() {
  clearReq('../lib/email');
  const prev = process.env.APP_URL;
  process.env.APP_URL = 'https://decentinvoice.com/';   // trailing slash on purpose — must be normalised
  const email = require('../lib/email');
  const text = email.buildPaidNotificationText({
    id: 33,
    invoice_number: 'INV-2026-0033',
    total: '99.99',
    currency: 'usd',
    client_name: 'Globex'
  });
  if (prev === undefined) delete process.env.APP_URL; else process.env.APP_URL = prev;

  assert.ok(text.includes('INV-2026-0033'), 'plain-text body includes invoice number');
  assert.ok(text.includes('$99.99'), 'plain-text body includes formatted total');
  assert.ok(text.includes('Globex'), 'plain-text body names the client');
  // Trailing slash on APP_URL must be stripped — no double slash before /invoices.
  assert.ok(text.includes('https://decentinvoice.com/invoices/33'),
    'plain-text body includes canonical view URL with single slash');
  assert.ok(!text.includes('decentinvoice.com//invoices'),
    'trailing slash on APP_URL must be normalised away');
}

async function testEmailLibExports() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  // Lock the public API so a future refactor of the new symbols breaks the
  // test suite before it breaks production callers (routes/billing.js).
  assert.strictEqual(typeof email.sendPaidNotificationEmail, 'function');
  assert.strictEqual(typeof email.buildPaidNotificationSubject, 'function');
  assert.strictEqual(typeof email.buildPaidNotificationHtml, 'function');
  assert.strictEqual(typeof email.buildPaidNotificationText, 'function');
  // Existing exports must not have regressed.
  assert.strictEqual(typeof email.sendInvoiceEmail, 'function');
  assert.strictEqual(typeof email.sendEmail, 'function');
  assert.strictEqual(typeof email.resolveReplyTo, 'function');
}

async function testBuildHtmlEscapesAndRendersButton() {
  clearReq('../lib/email');
  // Set APP_URL so the View-invoice button renders.
  const prev = process.env.APP_URL;
  process.env.APP_URL = 'https://decentinvoice.com';
  const email = require('../lib/email');
  const html = email.buildPaidNotificationHtml(
    {
      id: 99,
      invoice_number: 'INV-2026-0008',
      total: '500.00',
      currency: 'usd',
      client_name: '<script>alert(1)</script>'
    },
    { name: 'Alex', email: 'alex@studio.com' }
  );
  // Restore env to avoid leaking into other tests.
  if (prev === undefined) delete process.env.APP_URL; else process.env.APP_URL = prev;

  assert.ok(!html.includes('<script>alert(1)</script>'),
    'raw client_name must not appear unescaped (XSS guard)');
  assert.ok(html.includes('&lt;script&gt;'),
    'client_name must appear HTML-escaped');
  assert.ok(html.includes('$500.00'),
    'total must be rendered with currency symbol');
  assert.ok(html.includes('https://decentinvoice.com/invoices/99'),
    'View-invoice button must point to the owner-facing invoice URL');
  assert.ok(html.includes('INV-2026-0008'),
    'invoice number must appear in the body');
}

async function testSendNoOwnerEmail() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const r = await email.sendPaidNotificationEmail(
    { id: 1, invoice_number: 'INV-1', total: '10' },
    { email: null }
  );
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no_owner_email',
    'missing owner email must short-circuit before calling Resend');
}

async function testSendHappyPathSendsToOwner() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const sends = [];
  email.setResendClient({
    emails: {
      async send(payload) {
        sends.push(payload);
        return { data: { id: 'em_paid_1' }, error: null };
      }
    }
  });

  const r = await email.sendPaidNotificationEmail(
    {
      id: 7,
      invoice_number: 'INV-2026-0007',
      total: '750.00',
      currency: 'usd',
      client_name: 'Acme Co'
    },
    {
      email: 'freelancer@me.com',
      name: 'Sam',
      business_email: 'invoices@me.com',
      reply_to_email: null
    }
  );

  assert.strictEqual(r.ok, true, 'send must succeed');
  assert.strictEqual(sends.length, 1, 'must call Resend exactly once');
  const payload = sends[0];
  assert.deepStrictEqual(payload.to, ['freelancer@me.com'],
    'recipient is the FREELANCER (owner.email), not the client');
  assert.ok(payload.subject.includes('INV-2026-0007'));
  assert.ok(payload.subject.includes('$750.00'));
  // reply_to follows resolveReplyTo precedence — falls through to business_email.
  assert.strictEqual(payload.reply_to, 'invoices@me.com',
    'reply-to falls through to business_email when reply_to_email is null');
  email.resetResendClient();
}

// ---------- HTTP-level (Stripe webhook) tests -----------------------------

let constructEventImpl = null;
let markPaidResult = null;
let getUserByIdImpl = null;
const updateUserCalls = [];
const poolQueries = [];
const sendPaidNotificationEmailCalls = [];
let sendPaidNotificationEmailImpl = async () => ({ ok: true, id: 'em_x' });

function reset() {
  constructEventImpl = null;
  markPaidResult = null;
  getUserByIdImpl = null;
  updateUserCalls.length = 0;
  poolQueries.length = 0;
  sendPaidNotificationEmailCalls.length = 0;
  sendPaidNotificationEmailImpl = async () => ({ ok: true, id: 'em_x' });
}

const dbStub = {
  pool: {
    query: async (sql, params) => {
      poolQueries.push({ sql: sql.trim(), params });
      return { rows: [] };
    }
  },
  db: {
    async getUserById(id) {
      if (getUserByIdImpl) return getUserByIdImpl(id);
      return { id, plan: 'pro', email: 'owner@x.com', name: 'Owner' };
    },
    async updateUser(id, fields) {
      updateUserCalls.push({ id, fields });
      return { id, ...fields };
    },
    async markInvoicePaidByPaymentLinkId(linkId) {
      return markPaidResult ? markPaidResult(linkId) : null;
    }
  }
};

require.cache[require.resolve('../db')] = {
  id: require.resolve('../db'),
  filename: require.resolve('../db'),
  loaded: true,
  exports: dbStub
};

const mockStripeClient = {
  webhooks: {
    constructEvent(body, sig, secret) {
      if (!constructEventImpl) throw new Error('constructEventImpl not set');
      return constructEventImpl(body, sig, secret);
    }
  },
  customers: { async retrieve() { return { metadata: { user_id: '99' } }; } },
  subscriptions: { async retrieve(id) { return { id, trial_end: null }; } }
};

require.cache[require.resolve('stripe')] = {
  id: require.resolve('stripe'),
  filename: require.resolve('stripe'),
  loaded: true,
  exports: () => mockStripeClient
};

// Stub the email lib so the route imports our spy.
clearReq('../lib/email');
const realEmail = require('../lib/email');
const emailStub = {
  ...realEmail,
  sendPaidNotificationEmail: async (invoice, owner) => {
    sendPaidNotificationEmailCalls.push({ invoice, owner });
    return sendPaidNotificationEmailImpl(invoice, owner);
  }
};
require.cache[require.resolve('../lib/email')] = {
  id: require.resolve('../lib/email'),
  filename: require.resolve('../lib/email'),
  loaded: true,
  exports: emailStub
};

// Stub outbound-webhook so the webhook branch doesn't fire real HTTPs out.
require.cache[require.resolve('../lib/outbound-webhook')] = {
  id: require.resolve('../lib/outbound-webhook'),
  filename: require.resolve('../lib/outbound-webhook'),
  loaded: true,
  exports: {
    isValidWebhookUrl: async () => true,
    firePaidWebhook: async () => ({ ok: true }),
    buildPaidPayload: (inv) => ({ event: 'invoice.paid', invoice_id: inv && inv.id })
  }
};

clearReq('../routes/billing');
const billingRoutes = require('../routes/billing');

function buildApp() {
  const app = express();
  app.use('/billing/webhook', express.raw({ type: 'application/json' }));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use((req, _res, next) => { req.session = { user: null }; next(); });
  app.use('/billing', billingRoutes);
  return app;
}
const app = buildApp();

function webhook(body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const buf = Buffer.from(JSON.stringify(body));
      const headers = {
        'Content-Type': 'application/json',
        'Content-Length': buf.length,
        'stripe-signature': 'valid-sig'
      };
      const req = http.request(
        { hostname: '127.0.0.1', port, path: '/billing/webhook', method: 'POST', headers },
        res => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => server.close(() => resolve({ status: res.statusCode, body: data })));
        }
      );
      req.on('error', err => { server.close(); reject(err); });
      req.write(buf);
      req.end();
    });
  });
}

async function testWebhookPaymentLinkFiresPaidNotification() {
  reset();
  markPaidResult = () => ({
    id: 55, user_id: 7, invoice_number: 'INV-2026-0042',
    total: '1200.00', currency: 'usd', client_name: 'Acme', status: 'paid'
  });
  getUserByIdImpl = (id) => ({
    id, plan: 'pro', email: 'sam@studio.com', name: 'Sam',
    webhook_url: null
  });

  const event = {
    type: 'checkout.session.completed',
    data: { object: { mode: 'payment', payment_link: 'plink_test_42' } }
  };
  constructEventImpl = () => event;

  const res = await webhook(event);
  assert.strictEqual(res.status, 200, 'webhook must return 200');
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));

  assert.strictEqual(sendPaidNotificationEmailCalls.length, 1,
    'sendPaidNotificationEmail must be called exactly once');
  const call = sendPaidNotificationEmailCalls[0];
  assert.strictEqual(call.invoice.id, 55, 'must pass the marked-paid invoice');
  assert.strictEqual(call.invoice.invoice_number, 'INV-2026-0042');
  assert.strictEqual(call.owner.email, 'sam@studio.com',
    'owner email lookup result must be passed to the notification');
}

async function testWebhookPaidNotifyThrowDoesNotBreak200() {
  reset();
  markPaidResult = () => ({
    id: 56, user_id: 8, invoice_number: 'INV-2026-0099',
    total: '50.00', currency: 'usd', client_name: 'Globex'
  });
  getUserByIdImpl = (id) => ({ id, plan: 'pro', email: 'jane@x.com' });
  // sendPaidNotificationEmail rejects — must not stop the webhook from
  // returning 200; must not roll back markInvoicePaidByPaymentLinkId.
  sendPaidNotificationEmailImpl = async () => { throw new Error('Resend exploded'); };

  const event = {
    type: 'checkout.session.completed',
    data: { object: { mode: 'payment', payment_link: 'plink_x' } }
  };
  constructEventImpl = () => event;

  const res = await webhook(event);
  assert.strictEqual(res.status, 200,
    'webhook must still return 200 — fire-and-forget guarantee');
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));

  assert.strictEqual(sendPaidNotificationEmailCalls.length, 1,
    'attempt was made — error swallowed, not retried in-band');
}

async function testWebhookSubscriptionDoesNotFirePaidNotify() {
  reset();
  // Subscription-mode checkout: this is a Pro upgrade, NOT a payment-link
  // invoice payment. Must not fire the paid-notification.
  const event = {
    type: 'checkout.session.completed',
    data: { object: { mode: 'subscription', customer: 'cus_x', subscription: 'sub_y' } }
  };
  constructEventImpl = () => event;

  const res = await webhook(event);
  assert.strictEqual(res.status, 200);
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));

  assert.strictEqual(sendPaidNotificationEmailCalls.length, 0,
    'subscription-mode checkout must NOT trigger a paid-notification email');
}

// ---------- Runner --------------------------------------------------------

async function run() {
  const tests = [
    ['buildPaidNotificationSubject includes invoice number + formatted total', testBuildSubject],
    ['buildPaidNotificationHtml omits View button when APP_URL is unset', testBuildHtmlOmitsButtonWhenAppUrlUnset],
    ['buildPaidNotificationText includes all facts + canonical URL (no double slash)', testBuildTextIncludesAllFactsAndUrl],
    ['lib/email public-API: paid-notification + existing symbols all exported', testEmailLibExports],
    ['buildPaidNotificationHtml escapes XSS, formats total, renders View button', testBuildHtmlEscapesAndRendersButton],
    ['sendPaidNotificationEmail short-circuits when owner has no email', testSendNoOwnerEmail],
    ['sendPaidNotificationEmail happy path: recipient = owner.email, reply_to via precedence', testSendHappyPathSendsToOwner],
    ['Webhook payment_link → sendPaidNotificationEmail called with marked-paid invoice + owner', testWebhookPaymentLinkFiresPaidNotification],
    ['Webhook payment_link → sendPaidNotificationEmail throw still returns 200 (fire-and-forget)', testWebhookPaidNotifyThrowDoesNotBreak200],
    ['Webhook subscription mode → does NOT fire paid-notification', testWebhookSubscriptionDoesNotFirePaidNotify]
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
