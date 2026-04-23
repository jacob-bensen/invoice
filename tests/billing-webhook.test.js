'use strict';

/*
 * Billing webhook integration tests.
 *
 * Covers all income-critical Stripe webhook events:
 *  - Invalid signature → 400 (security gate)
 *  - checkout.session.completed (subscription) → user upgraded to Pro
 *  - checkout.session.completed (payment_link) → invoice marked paid
 *  - customer.subscription.deleted → user downgraded to Free
 *  - customer.subscription.updated (active) → plan set to Pro
 *  - customer.subscription.updated (non-active) → plan set to Free
 *
 * The Stripe SDK and ../db are stubbed so no real network calls occur.
 *
 * Run: node tests/billing-webhook.test.js
 */

const assert = require('assert');
const express = require('express');
const http = require('http');

// ---------- Mutable test state ------------------------------------------

// Set these per-test before each request.
let constructEventImpl = null;   // (body, sig, secret) => event | throws
let customerUserId = '42';       // returned by stripe.customers.retrieve
let markPaidResult = null;       // returned by db.markInvoicePaidByPaymentLinkId

const updateUserCalls = [];
const poolQueries = [];

function reset() {
  constructEventImpl = null;
  customerUserId = '42';
  markPaidResult = null;
  updateUserCalls.length = 0;
  poolQueries.length = 0;
}

// ---------- Stubs -------------------------------------------------------

const dbStub = {
  pool: {
    query: async (sql, params) => {
      poolQueries.push({ sql: sql.trim(), params });
      return { rows: [] };
    }
  },
  db: {
    async getUserById(id) { return { id, plan: 'free' }; },
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

// Stub the Stripe SDK: billing.js does require('stripe')(KEY) at load time.
const mockStripeClient = {
  webhooks: {
    constructEvent(body, sig, secret) {
      if (!constructEventImpl) throw new Error('constructEventImpl not set for this test');
      return constructEventImpl(body, sig, secret);
    }
  },
  customers: {
    async retrieve(customerId) {
      return { metadata: { user_id: customerUserId } };
    }
  }
};

require.cache[require.resolve('stripe')] = {
  id: require.resolve('stripe'),
  filename: require.resolve('stripe'),
  loaded: true,
  exports: (key) => mockStripeClient
};

// Load billing routes AFTER all stubs are installed.
function clearReq(mod) { delete require.cache[require.resolve(mod)]; }
clearReq('../routes/billing');
const billingRoutes = require('../routes/billing');

// ---------- App builder -------------------------------------------------

function buildApp() {
  const app = express();
  // Must register raw parser for the webhook path before any JSON parser,
  // mirroring the setup in server.js.
  app.use('/billing/webhook', express.raw({ type: 'application/json' }));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use((req, _res, next) => {
    req.session = { user: null };
    next();
  });
  app.use('/billing', billingRoutes);
  return app;
}

const app = buildApp(); // one app for all webhook tests (no session state)

// ---------- HTTP helper (raw JSON body) ---------------------------------

function webhook(body, sig) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const bodyStr = JSON.stringify(body);
      const bodyBuf = Buffer.from(bodyStr);
      const headers = {
        'Content-Type': 'application/json',
        'Content-Length': bodyBuf.length,
        'stripe-signature': sig || 'valid-sig'
      };
      const req = http.request(
        { hostname: '127.0.0.1', port, path: '/billing/webhook', method: 'POST', headers },
        res => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => { server.close(() => resolve({ status: res.statusCode, body: data })); });
        }
      );
      req.on('error', err => { server.close(); reject(err); });
      req.write(bodyBuf);
      req.end();
    });
  });
}

// ---------- Tests -------------------------------------------------------

async function testInvalidSignatureReturns400() {
  reset();
  constructEventImpl = (_body, sig) => {
    if (sig === 'bad-sig') throw new Error('No signatures found matching the expected signature');
    return {};
  };
  const res = await webhook({}, 'bad-sig');
  assert.strictEqual(res.status, 400, 'invalid Stripe signature must return 400');
  assert.ok(res.body.includes('Webhook Error'), 'response must describe the error');
}

async function testSubscriptionCheckoutUpgradesUser() {
  reset();
  customerUserId = '99';
  const event = {
    type: 'checkout.session.completed',
    data: { object: { mode: 'subscription', customer: 'cus_abc', subscription: 'sub_xyz' } }
  };
  constructEventImpl = () => event;

  const res = await webhook(event);
  assert.strictEqual(res.status, 200, 'webhook must return 200');

  // Give the async handler a tick to finish (billing.js doesn't await the handler result).
  await new Promise(r => setImmediate(r));

  assert.ok(updateUserCalls.length >= 1, 'db.updateUser must be called');
  const call = updateUserCalls.find(c => c.fields.plan === 'pro');
  assert.ok(call, 'user must be upgraded to pro');
  assert.strictEqual(call.id, 99, 'correct user ID must be updated');
  assert.strictEqual(call.fields.stripe_subscription_id, 'sub_xyz',
    'subscription ID must be stored');
}

async function testPaymentLinkCheckoutMarksInvoicePaid() {
  reset();
  let markedLinkId = null;
  markPaidResult = (linkId) => { markedLinkId = linkId; return { id: 55, status: 'paid' }; };

  const event = {
    type: 'checkout.session.completed',
    data: { object: { mode: 'payment', payment_link: 'plink_live_abc', customer: null } }
  };
  constructEventImpl = () => event;

  const res = await webhook(event);
  assert.strictEqual(res.status, 200, 'webhook must return 200');

  await new Promise(r => setImmediate(r));

  assert.strictEqual(markedLinkId, 'plink_live_abc',
    'markInvoicePaidByPaymentLinkId must be called with the payment_link ID');
}

async function testSubscriptionDeletedDowngradesToFree() {
  reset();
  const event = {
    type: 'customer.subscription.deleted',
    data: { object: { id: 'sub_del123' } }
  };
  constructEventImpl = () => event;

  const res = await webhook(event);
  assert.strictEqual(res.status, 200);

  await new Promise(r => setImmediate(r));

  const q = poolQueries.find(q => q.sql.includes('stripe_subscription_id=NULL'));
  assert.ok(q, 'pool.query must issue plan-downgrade SQL with NULL subscription');
  assert.strictEqual(q.params[0], 'free', 'plan must be set to free');
  assert.strictEqual(q.params[1], 'sub_del123', 'correct subscription ID must be targeted');
}

async function testSubscriptionUpdatedActiveSetsProPlan() {
  reset();
  const event = {
    type: 'customer.subscription.updated',
    data: { object: { id: 'sub_upd123', status: 'active' } }
  };
  constructEventImpl = () => event;

  const res = await webhook(event);
  assert.strictEqual(res.status, 200);

  await new Promise(r => setImmediate(r));

  const q = poolQueries.find(q => q.sql.includes('SET plan'));
  assert.ok(q, 'pool.query must update plan on subscription update');
  assert.strictEqual(q.params[0], 'pro', 'active subscription must set plan to pro');
  assert.strictEqual(q.params[1], 'sub_upd123', 'correct subscription ID must be targeted');
}

async function testSubscriptionUpdatedCancelledSetsFreePlan() {
  reset();
  const event = {
    type: 'customer.subscription.updated',
    data: { object: { id: 'sub_can456', status: 'past_due' } }  // non-active status
  };
  constructEventImpl = () => event;

  const res = await webhook(event);
  assert.strictEqual(res.status, 200);

  await new Promise(r => setImmediate(r));

  const q = poolQueries.find(q => q.sql.includes('SET plan'));
  assert.ok(q, 'pool.query must update plan on subscription status change');
  assert.strictEqual(q.params[0], 'free',
    'non-active subscription status must downgrade plan to free');
  assert.strictEqual(q.params[1], 'sub_can456', 'correct subscription ID must be targeted');
}

// ---------- Runner ------------------------------------------------------

async function run() {
  const tests = [
    ['Webhook: invalid signature returns 400', testInvalidSignatureReturns400],
    ['Webhook: checkout.session.completed (subscription) upgrades user to pro', testSubscriptionCheckoutUpgradesUser],
    ['Webhook: checkout.session.completed (payment_link) marks invoice paid', testPaymentLinkCheckoutMarksInvoicePaid],
    ['Webhook: customer.subscription.deleted downgrades user to free', testSubscriptionDeletedDowngradesToFree],
    ['Webhook: customer.subscription.updated (active) sets plan to pro', testSubscriptionUpdatedActiveSetsProPlan],
    ['Webhook: customer.subscription.updated (non-active) sets plan to free', testSubscriptionUpdatedCancelledSetsFreePlan]
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
