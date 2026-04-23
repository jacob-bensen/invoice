'use strict';

/*
 * Stripe Dunning + Smart Retries tests.
 *
 * Covers the code portion of the Dunning feature (see INTERNAL_TODO.md #4):
 *  1. Webhook `customer.subscription.updated` with status `past_due` must:
 *       - downgrade plan to 'free' (restrict Pro features)
 *       - persist `subscription_status='past_due'` (drives the banner)
 *       - NOT null out stripe_subscription_id (data preservation)
 *  2. Webhook with status `paused` → same behavior as past_due.
 *  3. Webhook with status `active` → plan='pro', subscription_status='active'.
 *  4. Webhook with status `trialing` → plan='pro' (trial users retain access).
 *  5. Webhook `customer.subscription.deleted` → subscription_status nulled.
 *  6. Dashboard banner renders when user.subscription_status === 'past_due'.
 *  7. Dashboard banner renders when user.subscription_status === 'paused'.
 *  8. Dashboard banner is NOT rendered for a healthy active Pro user.
 *  9. Dashboard banner links to /billing/portal (Customer Portal) so users can
 *     self-serve their card update without contacting support.
 *
 * Stripe SDK and ../db are stubbed — no network calls.
 *
 * Run: node tests/dunning.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const ejs = require('ejs');

// ---------- Webhook test state ------------------------------------------

let constructEventImpl = null;
const poolQueries = [];
const updateUserCalls = [];

function reset() {
  constructEventImpl = null;
  poolQueries.length = 0;
  updateUserCalls.length = 0;
}

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
    async markInvoicePaidByPaymentLinkId() { return null; }
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
  customers: {
    async retrieve() { return { metadata: { user_id: '1' } }; }
  }
};

require.cache[require.resolve('stripe')] = {
  id: require.resolve('stripe'),
  filename: require.resolve('stripe'),
  loaded: true,
  exports: () => mockStripeClient
};

function clearReq(mod) { delete require.cache[require.resolve(mod)]; }
clearReq('../routes/billing');
const billingRoutes = require('../routes/billing');

function buildWebhookApp() {
  const app = express();
  app.use('/billing/webhook', express.raw({ type: 'application/json' }));
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { user: null }; next(); });
  app.use('/billing', billingRoutes);
  return app;
}

const webhookApp = buildWebhookApp();

function webhook(body, sig) {
  return new Promise((resolve, reject) => {
    const server = webhookApp.listen(0, () => {
      const port = server.address().port;
      const bodyBuf = Buffer.from(JSON.stringify(body));
      const req = http.request(
        {
          hostname: '127.0.0.1', port,
          path: '/billing/webhook', method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': bodyBuf.length,
            'stripe-signature': sig || 'valid-sig'
          }
        },
        res => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => server.close(() => resolve({ status: res.statusCode, body: data })));
        }
      );
      req.on('error', err => { server.close(); reject(err); });
      req.write(bodyBuf);
      req.end();
    });
  });
}

// ---------- Webhook tests -----------------------------------------------

async function testPastDueRestrictsButPreservesSubscription() {
  reset();
  const event = {
    type: 'customer.subscription.updated',
    data: { object: { id: 'sub_pd1', status: 'past_due' } }
  };
  constructEventImpl = () => event;

  const res = await webhook(event);
  assert.strictEqual(res.status, 200);

  await new Promise(r => setImmediate(r));

  const q = poolQueries.find(q => q.sql.includes('SET plan'));
  assert.ok(q, 'plan must be updated on past_due');
  assert.strictEqual(q.params[0], 'free',
    'past_due status must restrict Pro by setting plan=free');
  assert.strictEqual(q.params[1], 'sub_pd1',
    'correct subscription ID must be targeted');
  assert.strictEqual(q.params[2], 'past_due',
    'subscription_status must be persisted so the banner can render');
  assert.ok(!q.sql.includes('stripe_subscription_id=NULL'),
    'past_due must NOT null out stripe_subscription_id — data preservation');
}

async function testPausedRestrictsButPreservesSubscription() {
  reset();
  const event = {
    type: 'customer.subscription.updated',
    data: { object: { id: 'sub_pz1', status: 'paused' } }
  };
  constructEventImpl = () => event;

  const res = await webhook(event);
  assert.strictEqual(res.status, 200);

  await new Promise(r => setImmediate(r));

  const q = poolQueries.find(q => q.sql.includes('SET plan'));
  assert.ok(q);
  assert.strictEqual(q.params[0], 'free', 'paused → plan=free');
  assert.strictEqual(q.params[2], 'paused',
    'subscription_status must be stored as "paused"');
  assert.ok(!q.sql.includes('stripe_subscription_id=NULL'),
    'paused must not wipe the subscription link — keeps restore path open');
}

async function testActivePersistsSubscriptionStatus() {
  reset();
  const event = {
    type: 'customer.subscription.updated',
    data: { object: { id: 'sub_ok1', status: 'active' } }
  };
  constructEventImpl = () => event;

  const res = await webhook(event);
  assert.strictEqual(res.status, 200);

  await new Promise(r => setImmediate(r));

  const q = poolQueries.find(q => q.sql.includes('SET plan'));
  assert.ok(q);
  assert.strictEqual(q.params[0], 'pro');
  assert.strictEqual(q.params[2], 'active',
    'active status must also be stored as subscription_status');
}

async function testTrialingKeepsPro() {
  reset();
  const event = {
    type: 'customer.subscription.updated',
    data: { object: { id: 'sub_tr1', status: 'trialing' } }
  };
  constructEventImpl = () => event;

  await webhook(event);
  await new Promise(r => setImmediate(r));

  const q = poolQueries.find(q => q.sql.includes('SET plan'));
  assert.ok(q);
  assert.strictEqual(q.params[0], 'pro',
    'trialing users still get Pro features — they are paying-convertible');
  assert.strictEqual(q.params[2], 'trialing');
}

async function testSubscriptionDeletedClearsStatus() {
  reset();
  const event = {
    type: 'customer.subscription.deleted',
    data: { object: { id: 'sub_gone' } }
  };
  constructEventImpl = () => event;

  await webhook(event);
  await new Promise(r => setImmediate(r));

  const q = poolQueries.find(q => q.sql.includes('stripe_subscription_id=NULL'));
  assert.ok(q, 'subscription.deleted must null the subscription link');
  assert.ok(q.sql.includes('subscription_status=NULL'),
    'subscription.deleted must also clear subscription_status so banner hides');
}

// ---------- Banner render tests -----------------------------------------

function renderDashboard(user) {
  const file = path.join(__dirname, '..', 'views', 'dashboard.ejs');
  return ejs.renderFile(file, {
    title: 'My Invoices',
    user,
    invoices: [],
    flash: null
  }, { async: false });
}

async function testBannerRendersForPastDueUser() {
  const html = await renderDashboard({
    id: 1, email: 'a@b.com', plan: 'free',
    subscription_status: 'past_due', invoice_count: 2
  });
  assert.ok(html.includes('data-testid="past-due-banner"'),
    'dashboard must render the past-due banner when subscription_status=past_due');
  assert.ok(html.includes("Your payment didn't go through"),
    'past-due copy must be present');
  assert.ok(html.includes('action="/billing/portal"'),
    'banner must post to /billing/portal so user hits Stripe Customer Portal');
}

async function testBannerRendersForPausedUser() {
  const html = await renderDashboard({
    id: 2, plan: 'free', subscription_status: 'paused', invoice_count: 0
  });
  assert.ok(html.includes('data-testid="past-due-banner"'),
    'banner must render for paused subscription too');
  assert.ok(html.includes('paused'),
    'paused-specific copy must be present');
}

async function testBannerHiddenForHealthyProUser() {
  const html = await renderDashboard({
    id: 3, plan: 'pro', subscription_status: 'active', invoice_count: 0
  });
  assert.ok(!html.includes('data-testid="past-due-banner"'),
    'banner must NOT render for healthy Pro users — it would be confusing');
}

async function testBannerHiddenForUserWithNoSubStatus() {
  // A brand-new free user never had a subscription; banner must not show.
  const html = await renderDashboard({
    id: 4, plan: 'free', subscription_status: null, invoice_count: 0
  });
  assert.ok(!html.includes('data-testid="past-due-banner"'),
    'banner must not render when subscription_status is null');
}

// ---------- Runner ------------------------------------------------------

async function run() {
  const tests = [
    ['Webhook: past_due sets plan=free, subscription_status=past_due, preserves link', testPastDueRestrictsButPreservesSubscription],
    ['Webhook: paused sets plan=free, subscription_status=paused, preserves link', testPausedRestrictsButPreservesSubscription],
    ['Webhook: active sets plan=pro and persists subscription_status', testActivePersistsSubscriptionStatus],
    ['Webhook: trialing keeps plan=pro', testTrialingKeepsPro],
    ['Webhook: subscription.deleted clears subscription_status + stripe_subscription_id', testSubscriptionDeletedClearsStatus],
    ['Dashboard: renders past-due banner for past_due user with portal link', testBannerRendersForPastDueUser],
    ['Dashboard: renders paused banner for paused user', testBannerRendersForPausedUser],
    ['Dashboard: hides banner for healthy active Pro user', testBannerHiddenForHealthyProUser],
    ['Dashboard: hides banner when subscription_status is null (new free users)', testBannerHiddenForUserWithNoSubStatus]
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
