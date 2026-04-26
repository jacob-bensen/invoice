'use strict';

/*
 * Stripe webhook → outbound (Zapier) webhook integration test.
 *
 * Income-critical Pro path: Pro/Agency user has webhook_url configured;
 * client pays via Stripe Payment Link → Stripe sends checkout.session.completed
 * with mode=payment + payment_link → routes/billing.js webhook handler:
 *   1. db.markInvoicePaidByPaymentLinkId() flips the invoice to paid
 *   2. db.getUserById(invoice.user_id) fetches the owner
 *   3. firePaidWebhook(owner.webhook_url, buildPaidPayload(invoice)) fires
 *      the Zapier-style notification
 *
 * Existing webhook-outbound.test.js covers the manual mark-as-paid path
 * (POST /invoices/:id/status → 'paid'). This file specifically covers the
 * AUTO-mark-paid path that runs from the Stripe webhook — a regression
 * here would silently break every Pro user's Zapier integration even
 * though they would still see the invoice flip to paid in the dashboard.
 *
 * Covers:
 *  1. Pro user + webhook_url → firePaidWebhook called once with the
 *     configured URL + a payload built from the marked-paid invoice.
 *  2. Pro user without webhook_url → firePaidWebhook NOT called.
 *  3. Free-plan owner (downgraded after a previously-paid Pro invoice) →
 *     firePaidWebhook NOT called (plan gate).
 *  4. firePaidWebhook rejection does NOT block the webhook 200 response
 *     (fire-and-forget guarantee — same property as the paid-notification
 *     email).
 *  5. Subscription-mode checkout (Pro upgrade) does NOT fire firePaidWebhook
 *     — the outbound-webhook fires only on payment-link mode, never on
 *     subscription mode.
 *
 * Run: NODE_ENV=test node tests/webhook-outbound-from-stripe.test.js
 */

const assert = require('assert');
const express = require('express');
const http = require('http');

function clearReq(mod) { delete require.cache[require.resolve(mod)]; }

// ---------- Mutable test state -------------------------------------------

let constructEventImpl = null;
let markPaidResult = null;
let getUserByIdImpl = null;
const firePaidWebhookCalls = [];
let firePaidWebhookImpl = async () => ({ ok: true });

function reset() {
  constructEventImpl = null;
  markPaidResult = null;
  getUserByIdImpl = null;
  firePaidWebhookCalls.length = 0;
  firePaidWebhookImpl = async () => ({ ok: true });
}

// ---------- Stubs --------------------------------------------------------

const dbStub = {
  pool: { query: async () => ({ rows: [] }) },
  db: {
    async getUserById(id) {
      if (getUserByIdImpl) return getUserByIdImpl(id);
      return { id, plan: 'pro', email: 'owner@x.com', name: 'Owner', webhook_url: null };
    },
    async updateUser(id, fields) { return { id, ...fields }; },
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

// Spy on outbound-webhook (the focus of this test file).
require.cache[require.resolve('../lib/outbound-webhook')] = {
  id: require.resolve('../lib/outbound-webhook'),
  filename: require.resolve('../lib/outbound-webhook'),
  loaded: true,
  exports: {
    isValidWebhookUrl: async () => true,
    firePaidWebhook: async (url, payload) => {
      firePaidWebhookCalls.push({ url, payload });
      return firePaidWebhookImpl(url, payload);
    },
    buildPaidPayload: (inv) => ({
      event: 'invoice.paid',
      invoice_id: inv && inv.id,
      invoice_number: inv && inv.invoice_number,
      amount: inv && inv.total,
      currency: inv && inv.currency,
      client_name: inv && inv.client_name,
      paid_at: new Date().toISOString()
    })
  }
};

// Stub email so its no-op doesn't muddy the firePaidWebhook spy.
clearReq('../lib/email');
const realEmail = require('../lib/email');
require.cache[require.resolve('../lib/email')] = {
  id: require.resolve('../lib/email'),
  filename: require.resolve('../lib/email'),
  loaded: true,
  exports: { ...realEmail, sendPaidNotificationEmail: async () => ({ ok: false, reason: 'not_configured' }) }
};

clearReq('../routes/billing');
const billingRoutes = require('../routes/billing');

// ---------- App + HTTP helper --------------------------------------------

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

// ---------- Tests --------------------------------------------------------

async function testProUserWithWebhookUrlFiresOutbound() {
  reset();
  markPaidResult = (linkId) => ({
    id: 1001, user_id: 7, invoice_number: 'INV-2026-0100',
    total: '2000.00', currency: 'usd', client_name: 'Acme Co', status: 'paid',
    payment_link_id: linkId
  });
  getUserByIdImpl = (id) => ({
    id, plan: 'pro', email: 'sam@studio.com', name: 'Sam',
    webhook_url: 'https://hooks.zapier.com/hooks/catch/12345/abc'
  });

  const event = {
    type: 'checkout.session.completed',
    data: { object: { mode: 'payment', payment_link: 'plink_test_100' } }
  };
  constructEventImpl = () => event;

  const res = await webhook(event);
  assert.strictEqual(res.status, 200, 'webhook must return 200');

  // Allow the fire-and-forget .then chain to settle.
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));

  assert.strictEqual(firePaidWebhookCalls.length, 1,
    'firePaidWebhook must fire exactly once when Pro user has webhook_url');
  const call = firePaidWebhookCalls[0];
  assert.strictEqual(call.url, 'https://hooks.zapier.com/hooks/catch/12345/abc',
    'firePaidWebhook must receive the owner\'s configured webhook_url');
  assert.strictEqual(call.payload.event, 'invoice.paid',
    'payload must declare the invoice.paid event for Zapier filter consumers');
  assert.strictEqual(call.payload.invoice_id, 1001,
    'payload carries the marked-paid invoice id');
  assert.strictEqual(call.payload.invoice_number, 'INV-2026-0100',
    'payload includes the human invoice number for Zapier templating');
  assert.strictEqual(call.payload.amount, '2000.00',
    'payload includes the invoice total');
}

async function testProUserWithoutWebhookUrlSkipsOutbound() {
  reset();
  markPaidResult = () => ({
    id: 1002, user_id: 8, invoice_number: 'INV-2026-0101',
    total: '500.00', currency: 'usd', client_name: 'Globex'
  });
  getUserByIdImpl = (id) => ({
    id, plan: 'pro', email: 'jane@x.com', webhook_url: null  // explicitly unset
  });

  const event = {
    type: 'checkout.session.completed',
    data: { object: { mode: 'payment', payment_link: 'plink_no_url' } }
  };
  constructEventImpl = () => event;

  const res = await webhook(event);
  assert.strictEqual(res.status, 200);
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));

  assert.strictEqual(firePaidWebhookCalls.length, 0,
    'firePaidWebhook MUST NOT fire when owner.webhook_url is null — no integration to deliver to');
}

async function testFreePlanOwnerSkipsOutbound() {
  reset();
  markPaidResult = () => ({
    id: 1003, user_id: 9, invoice_number: 'INV-2026-0102',
    total: '300.00', currency: 'usd', client_name: 'Initech'
  });
  // Edge case: a Pro user previously created a payment link, downgraded
  // to free, and the client paid the still-live link. The route's
  // `(plan === 'pro' || plan === 'agency')` gate must protect the
  // outbound from firing on a downgraded user — they are no longer
  // entitled to the Pro Zapier integration.
  getUserByIdImpl = (id) => ({
    id, plan: 'free', email: 'expro@x.com',
    webhook_url: 'https://hooks.zapier.com/hooks/catch/9999/zzz'
  });

  const event = {
    type: 'checkout.session.completed',
    data: { object: { mode: 'payment', payment_link: 'plink_free_owner' } }
  };
  constructEventImpl = () => event;

  const res = await webhook(event);
  assert.strictEqual(res.status, 200);
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));

  assert.strictEqual(firePaidWebhookCalls.length, 0,
    'firePaidWebhook MUST NOT fire for free-plan owner — Pro feature gate');
}

async function testOutboundFailureDoesNotBreak200() {
  reset();
  markPaidResult = () => ({
    id: 1004, user_id: 10, invoice_number: 'INV-X', total: '100.00',
    currency: 'usd', client_name: 'X'
  });
  getUserByIdImpl = (id) => ({
    id, plan: 'pro', email: 'a@b.com',
    webhook_url: 'https://hooks.example.com/x'
  });
  // Simulate the user's Zapier hook timing out / 500-ing.
  firePaidWebhookImpl = async () => { throw new Error('Zapier 500'); };

  const event = {
    type: 'checkout.session.completed',
    data: { object: { mode: 'payment', payment_link: 'plink_zap_fails' } }
  };
  constructEventImpl = () => event;

  const res = await webhook(event);
  assert.strictEqual(res.status, 200,
    'webhook must still return 200 — Stripe expects 2xx; otherwise it retries (causing duplicate Zapier deliveries)');
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));

  assert.strictEqual(firePaidWebhookCalls.length, 1,
    'attempt was made — error swallowed');
}

async function testSubscriptionModeDoesNotFireOutbound() {
  reset();
  // mode=subscription is the Pro upgrade flow — must NOT trip firePaidWebhook
  // (which is only for invoice payments, not subscription billings).
  getUserByIdImpl = (id) => ({
    id, plan: 'pro', email: 'a@b.com',
    webhook_url: 'https://hooks.zapier.com/hooks/catch/1/2'
  });

  const event = {
    type: 'checkout.session.completed',
    data: {
      object: {
        mode: 'subscription',
        customer: 'cus_test_99',
        subscription: 'sub_test_99'
      }
    }
  };
  constructEventImpl = () => event;

  const res = await webhook(event);
  assert.strictEqual(res.status, 200);
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));

  assert.strictEqual(firePaidWebhookCalls.length, 0,
    'firePaidWebhook MUST NOT fire on subscription-mode checkouts (Pro upgrade ≠ invoice paid)');
}

async function run() {
  const tests = [
    ['Pro + webhook_url → firePaidWebhook fires with URL + payload', testProUserWithWebhookUrlFiresOutbound],
    ['Pro without webhook_url → no fire', testProUserWithoutWebhookUrlSkipsOutbound],
    ['Free-plan owner → no fire (Pro gate)', testFreePlanOwnerSkipsOutbound],
    ['firePaidWebhook throw → webhook still 200 (fire-and-forget)', testOutboundFailureDoesNotBreak200],
    ['Subscription mode → no firePaidWebhook (Pro upgrade ≠ invoice paid)', testSubscriptionModeDoesNotFireOutbound]
  ];
  let pass = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log('  ok ', name);
      pass++;
    } catch (err) {
      console.error('  FAIL', name);
      console.error(err);
      process.exitCode = 1;
    }
  }
  console.log(`\nwebhook-outbound-from-stripe.test.js: ${pass}/${tests.length} passed`);
}

run();
