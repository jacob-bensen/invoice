'use strict';

/*
 * Referral conversion tests (#50).
 *
 * The viral-loop closure shipped on top of the #49 first-paid celebration
 * banner. Three layers under test:
 *
 *  1. db.creditReferrerIfMissing — the SQL one-shot: CTE-style UPDATE
 *     guarded on (referrer_id IS NOT NULL AND referral_credited_at IS NULL)
 *     joined to the referrer row to return their stripe_subscription_id in
 *     a single round-trip. Replays of the same webhook (Stripe retries up
 *     to 16x over 3 days) must return null on every call after the first.
 *
 *  2. lib/referral.creditReferrerForSubscription — applies the operator-
 *     provisioned STRIPE_REFERRAL_COUPON_ID to the referrer's existing
 *     subscription via stripe.subscriptions.update({ discounts: [...] }).
 *     Soft-fails (no throw) on missing coupon env, missing subscription,
 *     or Stripe API throw — the webhook handler must still 200-OK.
 *
 *  3. POST /billing/create-checkout — attaches `discounts: [{ coupon }]`
 *     AND omits `allow_promotion_codes` when the user has a referrer_id and
 *     STRIPE_REFERRAL_COUPON_ID is configured. Otherwise the existing
 *     allow_promotion_codes:true behaviour is preserved (the
 *     checkout-promo-tax.test.js contract). Metadata.referrer_id flows
 *     onto the session for downstream attribution surfaces.
 *
 * All external I/O (Stripe SDK, pg) is stubbed — no real network calls.
 *
 * Run: NODE_ENV=test node tests/referral-conversion.test.js
 */

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';
process.env.APP_URL = process.env.APP_URL || 'https://test.invoice.app';
process.env.STRIPE_PRO_PRICE_ID = process.env.STRIPE_PRO_PRICE_ID || 'price_monthly_TEST';

const assert = require('assert');
const express = require('express');
const session = require('express-session');
const http = require('http');

function clearReq(mod) { delete require.cache[require.resolve(mod)]; }

// ---------- db.creditReferrerIfMissing ----------------------------------

function stubPg(handler) {
  const pgPath = require.resolve('pg');
  const originalPg = require.cache[pgPath];
  require.cache[pgPath] = {
    id: pgPath, filename: pgPath, loaded: true,
    exports: { Pool: function () { return { query: handler }; } }
  };
  delete require.cache[require.resolve('../db')];
  return () => {
    if (originalPg) require.cache[pgPath] = originalPg;
    else delete require.cache[pgPath];
    delete require.cache[require.resolve('../db')];
  };
}

async function testCreditReferrerShape() {
  const captured = [];
  const restore = stubPg(async (text, params) => {
    captured.push({ text, params });
    return {
      rows: [{
        referrer_id: 42,
        referrer_subscription_id: 'sub_abc123',
        referrer_email: 'ref@example.com',
        referrer_plan: 'pro'
      }]
    };
  });
  try {
    const { db } = require('../db');
    const row = await db.creditReferrerIfMissing(7);
    assert.strictEqual(captured.length, 1, 'must issue exactly one query');
    const q = captured[0];
    assert.ok(/WITH\s+credited\s+AS/i.test(q.text),
      'must use the CTE-style single-round-trip UPDATE+SELECT pattern');
    assert.ok(/UPDATE\s+users/i.test(q.text), 'must UPDATE users');
    assert.ok(/SET[\s\S]*referral_credited_at\s*=\s*NOW\(\)/i.test(q.text),
      'must set referral_credited_at = NOW()');
    assert.ok(/referrer_id\s+IS\s+NOT\s+NULL/i.test(q.text),
      'must guard on referrer_id IS NOT NULL (only credit if a referrer exists)');
    assert.ok(/referral_credited_at\s+IS\s+NULL/i.test(q.text),
      'must guard on referral_credited_at IS NULL (idempotency)');
    assert.ok(/stripe_subscription_id/i.test(q.text),
      'must return the referrer stripe_subscription_id in the same round-trip');
    assert.deepStrictEqual(q.params, [7]);
    assert.strictEqual(row.referrer_id, 42);
    assert.strictEqual(row.referrer_subscription_id, 'sub_abc123');
    assert.strictEqual(row.referrer_email, 'ref@example.com');
  } finally { restore(); }
}

async function testCreditReferrerIdempotentNull() {
  // Second webhook call: the UPDATE's WHERE clause now fails (the row was
  // stamped on the first call), so the CTE produces zero rows and the
  // SELECT returns nothing. Helper must return null so the caller skips
  // the Stripe API entirely.
  const restore = stubPg(async () => ({ rows: [] }));
  try {
    const { db } = require('../db');
    const row = await db.creditReferrerIfMissing(7);
    assert.strictEqual(row, null,
      'returns null on second-and-subsequent calls so Stripe coupon is never reapplied');
  } finally { restore(); }
}

async function testCreditReferrerNullOnFalsyId() {
  // Defensive: don't issue a query at all when the caller passes a falsy
  // userId. Saves a DB round-trip on the (impossible-but-cheap-to-guard)
  // case where the webhook fires without a resolved user.
  let queryCount = 0;
  const restore = stubPg(async () => { queryCount++; return { rows: [] }; });
  try {
    const { db } = require('../db');
    const row = await db.creditReferrerIfMissing(null);
    assert.strictEqual(row, null);
    assert.strictEqual(queryCount, 0, 'must not issue a query when userId is falsy');
  } finally { restore(); }
}

// ---------- lib/referral.creditReferrerForSubscription ------------------

function buildStubDb(creditedResult) {
  return {
    creditReferrerIfMissing: async () => creditedResult
  };
}

async function testReferralAppliesCouponOnReferrerSubscription() {
  delete require.cache[require.resolve('../lib/referral')];
  const { creditReferrerForSubscription } = require('../lib/referral');
  process.env.STRIPE_REFERRAL_COUPON_ID = 'coupon_REF_FREE_MONTH';
  try {
    const updateCalls = [];
    const stripe = {
      subscriptions: {
        update: async (subId, params) => { updateCalls.push({ subId, params }); return {}; }
      }
    };
    const db = buildStubDb({
      referrer_id: 42, referrer_subscription_id: 'sub_ref_abc', referrer_email: 'r@x.com'
    });
    const result = await creditReferrerForSubscription(stripe, db, 7);

    assert.strictEqual(updateCalls.length, 1,
      'stripe.subscriptions.update must be called exactly once');
    assert.strictEqual(updateCalls[0].subId, 'sub_ref_abc',
      'must target the referrer\'s stripe_subscription_id, not the referred user\'s');
    assert.deepStrictEqual(updateCalls[0].params.discounts, [{ coupon: 'coupon_REF_FREE_MONTH' }],
      'must apply the operator-provisioned referral coupon');
    assert.strictEqual(result.applied, true,
      'helper must report applied=true so callers can log/observe success');
  } finally {
    delete process.env.STRIPE_REFERRAL_COUPON_ID;
  }
}

async function testReferralSkipsWhenCouponEnvUnset() {
  // Until the operator creates the coupon in Stripe Dashboard and sets
  // STRIPE_REFERRAL_COUPON_ID, the helper still stamps the DB (so we don't
  // retry forever) but explicitly does NOT call Stripe — applying a
  // missing coupon ID would throw.
  delete require.cache[require.resolve('../lib/referral')];
  const { creditReferrerForSubscription } = require('../lib/referral');
  delete process.env.STRIPE_REFERRAL_COUPON_ID;
  const updateCalls = [];
  const stripe = {
    subscriptions: { update: async (...a) => { updateCalls.push(a); return {}; } }
  };
  const db = buildStubDb({
    referrer_id: 42, referrer_subscription_id: 'sub_ref_abc'
  });
  const result = await creditReferrerForSubscription(stripe, db, 7);
  assert.strictEqual(updateCalls.length, 0,
    'must NOT call stripe.subscriptions.update when STRIPE_REFERRAL_COUPON_ID is unset');
  assert.strictEqual(result.applied, false);
  assert.strictEqual(result.reason, 'no_coupon_configured');
}

async function testReferralSkipsWhenReferrerHasNoSubscription() {
  // The referrer is still on Free (never paid). They have a referral_code
  // but no stripe_subscription_id. We can't apply a subscription coupon —
  // we still want to mark the DB as credited so the loop doesn't retry.
  // The db.creditReferrerIfMissing already stamped on its own; this helper
  // reports the skip reason.
  delete require.cache[require.resolve('../lib/referral')];
  const { creditReferrerForSubscription } = require('../lib/referral');
  process.env.STRIPE_REFERRAL_COUPON_ID = 'coupon_X';
  try {
    const updateCalls = [];
    const stripe = {
      subscriptions: { update: async (...a) => { updateCalls.push(a); return {}; } }
    };
    const db = buildStubDb({
      referrer_id: 42, referrer_subscription_id: null
    });
    const result = await creditReferrerForSubscription(stripe, db, 7);
    assert.strictEqual(updateCalls.length, 0,
      'must NOT call Stripe when the referrer has no subscription');
    assert.strictEqual(result.applied, false);
    assert.strictEqual(result.reason, 'referrer_no_subscription');
  } finally {
    delete process.env.STRIPE_REFERRAL_COUPON_ID;
  }
}

async function testReferralSoftFailsOnStripeThrow() {
  // A Stripe API outage during webhook handling must not bubble up — the
  // webhook handler depends on this helper returning a structured shape
  // so it can keep returning 200 to Stripe (otherwise Stripe retries
  // forever and the user-upgrade webhook side-effect never settles).
  delete require.cache[require.resolve('../lib/referral')];
  const { creditReferrerForSubscription } = require('../lib/referral');
  process.env.STRIPE_REFERRAL_COUPON_ID = 'coupon_X';
  try {
    const stripe = {
      subscriptions: {
        update: async () => { throw new Error('stripe transient error'); }
      }
    };
    const db = buildStubDb({
      referrer_id: 42, referrer_subscription_id: 'sub_ref_abc'
    });
    const result = await creditReferrerForSubscription(stripe, db, 7);
    assert.strictEqual(result.applied, false);
    assert.strictEqual(result.reason, 'stripe_error');
    assert.ok(/stripe transient error/.test(result.error || ''));
  } finally {
    delete process.env.STRIPE_REFERRAL_COUPON_ID;
  }
}

async function testReferralReturnsNullOnIdempotentNoOp() {
  // When db.creditReferrerIfMissing returns null (the user was already
  // credited, OR has no referrer at all), the helper must short-circuit
  // entirely — no Stripe call, no return shape.
  delete require.cache[require.resolve('../lib/referral')];
  const { creditReferrerForSubscription } = require('../lib/referral');
  process.env.STRIPE_REFERRAL_COUPON_ID = 'coupon_X';
  try {
    const updateCalls = [];
    const stripe = {
      subscriptions: { update: async (...a) => { updateCalls.push(a); return {}; } }
    };
    const db = buildStubDb(null);
    const result = await creditReferrerForSubscription(stripe, db, 7);
    assert.strictEqual(updateCalls.length, 0,
      'no Stripe call when DB says "already credited" or "no referrer"');
    assert.strictEqual(result, null,
      'returns null so the caller logs nothing — fully silent idempotent no-op');
  } finally {
    delete process.env.STRIPE_REFERRAL_COUPON_ID;
  }
}

async function testReferralSoftFailsOnDbThrow() {
  // A pg outage during the credit-stamp query must not blow up the
  // webhook. Helper logs and returns null — same shape as idempotent
  // no-op, since the caller can't distinguish "already done" from
  // "couldn't check" and both warrant the same do-nothing behaviour.
  delete require.cache[require.resolve('../lib/referral')];
  const { creditReferrerForSubscription } = require('../lib/referral');
  const stripe = { subscriptions: { update: async () => ({}) } };
  const db = {
    creditReferrerIfMissing: async () => { throw new Error('pg down'); }
  };
  const result = await creditReferrerForSubscription(stripe, db, 7);
  assert.strictEqual(result, null);
}

// ---------- POST /billing/create-checkout — discount attachment ---------

const checkoutSessionCalls = [];
let stubbedUser = null;

function resetCheckout() {
  checkoutSessionCalls.length = 0;
  stubbedUser = null;
}

const dbStub = {
  pool: { query: async () => ({ rows: [] }) },
  db: {
    async getUserById(id) {
      return stubbedUser ? { id, ...stubbedUser } : { id, email: 'u@t.io', plan: 'free', stripe_customer_id: 'cus_existing' };
    },
    async updateUser(id, fields) { return { id, ...fields }; },
    async markInvoicePaidByPaymentLinkId() { return null; },
    async creditReferrerIfMissing() { return null; }
  }
};

const mockStripeClient = {
  webhooks: { constructEvent: () => { throw new Error('not used'); } },
  customers: {
    async create() { return { id: 'cus_new' }; },
    async retrieve() { return { metadata: { user_id: '1' } }; }
  },
  checkout: {
    sessions: {
      async create(params) {
        checkoutSessionCalls.push(params);
        return { id: 'cs_test', url: 'https://checkout.stripe.com/test' };
      }
    }
  },
  billingPortal: { sessions: { async create() { return { url: 'https://billing.stripe.com/portal' }; } } },
  subscriptions: { update: async () => ({}), retrieve: async () => ({}) }
};

function installCheckoutStubs() {
  require.cache[require.resolve('../db')] = {
    id: require.resolve('../db'),
    filename: require.resolve('../db'),
    loaded: true,
    exports: dbStub
  };
  require.cache[require.resolve('stripe')] = {
    id: require.resolve('stripe'),
    filename: require.resolve('stripe'),
    loaded: true,
    exports: () => mockStripeClient
  };
  clearReq('../routes/billing');
  return require('../routes/billing');
}

function buildCheckoutApp(billingRoutes, sessionUser) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, _res, next) => { if (sessionUser) req.session.user = sessionUser; next(); });
  app.use('/billing', billingRoutes);
  return app;
}

function post(app, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const bodyStr = new URLSearchParams(body || {}).toString();
      const req = http.request(
        { hostname: '127.0.0.1', port, path: '/billing/create-checkout', method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(bodyStr)
          } },
        res => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => { server.close(() => resolve({ status: res.statusCode, body: data })); });
        }
      );
      req.on('error', err => { server.close(); reject(err); });
      req.write(bodyStr);
      req.end();
    });
  });
}

async function testCheckoutAttachesReferralCouponWhenAllSet() {
  resetCheckout();
  process.env.STRIPE_REFERRAL_COUPON_ID = 'coupon_FREE_MONTH';
  try {
    stubbedUser = { email: 'ref@u.io', plan: 'free', stripe_customer_id: 'cus_existing', referrer_id: 42 };
    const billingRoutes = installCheckoutStubs();
    const app = buildCheckoutApp(billingRoutes, { id: 7 });

    const res = await post(app, {});
    assert.strictEqual(res.status, 303);
    assert.strictEqual(checkoutSessionCalls.length, 1);
    const call = checkoutSessionCalls[0];

    assert.deepStrictEqual(call.discounts, [{ coupon: 'coupon_FREE_MONTH' }],
      'session must attach the referral coupon so the referred user\'s first Pro charge is free');
    assert.strictEqual(call.allow_promotion_codes, false,
      'allow_promotion_codes must be false when discounts is set — Stripe rejects both together');
    assert.strictEqual(call.metadata.referrer_id, '42',
      'metadata.referrer_id must flow onto the session for downstream attribution');
    assert.strictEqual(call.metadata.user_id, '7');
  } finally {
    delete process.env.STRIPE_REFERRAL_COUPON_ID;
  }
}

async function testCheckoutNoDiscountWhenCouponEnvUnset() {
  // User has a referrer but the operator hasn't created the coupon yet —
  // checkout still works (graceful degradation), no discounts attached,
  // and allow_promotion_codes stays true so other coupons remain usable.
  resetCheckout();
  delete process.env.STRIPE_REFERRAL_COUPON_ID;
  stubbedUser = { email: 'ref@u.io', plan: 'free', stripe_customer_id: 'cus_existing', referrer_id: 42 };
  const billingRoutes = installCheckoutStubs();
  const app = buildCheckoutApp(billingRoutes, { id: 7 });

  const res = await post(app, {});
  assert.strictEqual(res.status, 303);
  const call = checkoutSessionCalls[0];
  assert.strictEqual(call.discounts, undefined,
    'no discounts must be attached when STRIPE_REFERRAL_COUPON_ID is unset');
  assert.strictEqual(call.allow_promotion_codes, true,
    'allow_promotion_codes must stay true as long as no auto-coupon is attached');
  assert.strictEqual(call.metadata.referrer_id, '42',
    'metadata.referrer_id still flows so post-launch coupon configuration can audit the cohort');
}

async function testCheckoutNoDiscountWhenNoReferrer() {
  // Non-referred user — even with the coupon env set, no discounts must be
  // attached. allow_promotion_codes:true is preserved (the existing
  // checkout-promo-tax.test.js contract).
  resetCheckout();
  process.env.STRIPE_REFERRAL_COUPON_ID = 'coupon_FREE_MONTH';
  try {
    stubbedUser = { email: 'org@u.io', plan: 'free', stripe_customer_id: 'cus_existing', referrer_id: null };
    const billingRoutes = installCheckoutStubs();
    const app = buildCheckoutApp(billingRoutes, { id: 7 });

    const res = await post(app, {});
    assert.strictEqual(res.status, 303);
    const call = checkoutSessionCalls[0];
    assert.strictEqual(call.discounts, undefined,
      'no discount must be attached when the user has no referrer_id');
    assert.strictEqual(call.allow_promotion_codes, true,
      'organic users must keep allow_promotion_codes so PH50/AppSumo/newsletter codes still work');
    assert.strictEqual(call.metadata.referrer_id, undefined,
      'metadata.referrer_id must NOT appear when there is no referrer');
  } finally {
    delete process.env.STRIPE_REFERRAL_COUPON_ID;
  }
}

// ---------- POST /billing/webhook — referral credit fires --------------

const updateUserCalls = [];
const subscriptionUpdateCalls = [];
let creditReferrerImpl = async () => null;
let constructEventImpl = null;

function resetWebhook() {
  updateUserCalls.length = 0;
  subscriptionUpdateCalls.length = 0;
  creditReferrerImpl = async () => null;
  constructEventImpl = null;
}

function installWebhookStubs() {
  require.cache[require.resolve('../db')] = {
    id: require.resolve('../db'),
    filename: require.resolve('../db'),
    loaded: true,
    exports: {
      pool: { query: async () => ({ rows: [] }) },
      db: {
        async getUserById(id) { return { id, plan: 'free' }; },
        async updateUser(id, fields) { updateUserCalls.push({ id, fields }); return { id, ...fields }; },
        async markInvoicePaidByPaymentLinkId() { return null; },
        async creditReferrerIfMissing(userId) { return creditReferrerImpl(userId); }
      }
    }
  };
  const stripe = {
    webhooks: {
      constructEvent(body, sig) {
        if (!constructEventImpl) throw new Error('constructEventImpl not set');
        return constructEventImpl(body, sig);
      }
    },
    customers: { async retrieve() { return { metadata: { user_id: '99' } }; } },
    subscriptions: {
      async retrieve(subId) { return { id: subId, trial_end: null }; },
      async update(subId, params) { subscriptionUpdateCalls.push({ subId, params }); return {}; }
    },
    checkout: { sessions: { async create() { return { id: 'cs', url: 'http://x' }; } } },
    billingPortal: { sessions: { async create() { return { url: 'http://b' }; } } }
  };
  require.cache[require.resolve('stripe')] = {
    id: require.resolve('stripe'),
    filename: require.resolve('stripe'),
    loaded: true,
    exports: () => stripe
  };
  clearReq('../routes/billing');
  return require('../routes/billing');
}

function postWebhook(app, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const bodyStr = JSON.stringify(body);
      const buf = Buffer.from(bodyStr);
      const req = http.request(
        { hostname: '127.0.0.1', port, path: '/billing/webhook', method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': buf.length,
            'stripe-signature': 'valid-sig'
          } },
        res => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => { server.close(() => resolve({ status: res.statusCode, body: data })); });
        }
      );
      req.on('error', err => { server.close(); reject(err); });
      req.write(buf);
      req.end();
    });
  });
}

async function testWebhookCreditsReferrerOnSubscriptionCompletion() {
  // End-to-end: the Stripe webhook fires after the referred user's
  // subscription is created. The handler upgrades them to Pro AND credits
  // the referrer in the same handler call. Confirms the wiring lives
  // alongside the existing user-upgrade side-effect, not somewhere it
  // could silently drift.
  resetWebhook();
  process.env.STRIPE_REFERRAL_COUPON_ID = 'coupon_FREE_MONTH';
  try {
    creditReferrerImpl = async (userId) => {
      if (userId === 99) {
        return {
          referrer_id: 42,
          referrer_subscription_id: 'sub_referrer',
          referrer_email: 'r@x.com',
          referrer_plan: 'pro'
        };
      }
      return null;
    };
    constructEventImpl = () => ({
      type: 'checkout.session.completed',
      data: { object: {
        mode: 'subscription', customer: 'cus_referred', subscription: 'sub_referred',
        metadata: { user_id: '99', referrer_id: '42' }
      } }
    });
    const billingRoutes = installWebhookStubs();
    const app = express();
    app.use('/billing/webhook', express.raw({ type: 'application/json' }));
    app.use('/billing', billingRoutes);

    const res = await postWebhook(app, {});
    assert.strictEqual(res.status, 200,
      'webhook must 200 even with referral side-effect — Stripe retries on non-2xx');

    // Let the fire-and-forget promise resolve.
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));

    assert.strictEqual(subscriptionUpdateCalls.length, 1,
      'stripe.subscriptions.update must be called once on the referrer\'s subscription');
    assert.strictEqual(subscriptionUpdateCalls[0].subId, 'sub_referrer');
    assert.deepStrictEqual(subscriptionUpdateCalls[0].params.discounts,
      [{ coupon: 'coupon_FREE_MONTH' }]);

    const upgradeCall = updateUserCalls.find(c => c.fields.plan === 'pro');
    assert.ok(upgradeCall, 'referred user must still be upgraded to Pro');
    assert.strictEqual(upgradeCall.id, 99);
  } finally {
    delete process.env.STRIPE_REFERRAL_COUPON_ID;
  }
}

async function testWebhookSkipsCouponWhenDbReportsAlreadyCredited() {
  // Replay: Stripe re-sends the same checkout.session.completed event
  // (e.g. after our 200 didn't reach them, or via Stripe Dashboard
  // "resend webhook"). db.creditReferrerIfMissing returns null on the
  // second call (the UPDATE's idempotency guard fails). No Stripe API
  // call must follow.
  resetWebhook();
  process.env.STRIPE_REFERRAL_COUPON_ID = 'coupon_FREE_MONTH';
  try {
    creditReferrerImpl = async () => null; // already credited
    constructEventImpl = () => ({
      type: 'checkout.session.completed',
      data: { object: {
        mode: 'subscription', customer: 'cus_referred', subscription: 'sub_referred',
        metadata: { user_id: '99' }
      } }
    });
    const billingRoutes = installWebhookStubs();
    const app = express();
    app.use('/billing/webhook', express.raw({ type: 'application/json' }));
    app.use('/billing', billingRoutes);

    const res = await postWebhook(app, {});
    assert.strictEqual(res.status, 200);
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));

    assert.strictEqual(subscriptionUpdateCalls.length, 0,
      'no Stripe coupon application on webhook replay — the DB idempotency guard short-circuits the helper');
  } finally {
    delete process.env.STRIPE_REFERRAL_COUPON_ID;
  }
}

async function testWebhookStillReturns200WhenStripeUpdateThrows() {
  // Stripe SDK throws while applying the coupon — webhook must still 200
  // so Stripe doesn't retry forever and the upgrade side-effect (which
  // already landed in the DB) stays settled.
  resetWebhook();
  process.env.STRIPE_REFERRAL_COUPON_ID = 'coupon_FREE_MONTH';
  try {
    creditReferrerImpl = async () => ({
      referrer_id: 42, referrer_subscription_id: 'sub_referrer', referrer_email: 'r@x.com'
    });
    constructEventImpl = () => ({
      type: 'checkout.session.completed',
      data: { object: { mode: 'subscription', customer: 'cus_referred', subscription: 'sub_referred',
        metadata: { user_id: '99' } } }
    });
    const billingRoutes = installWebhookStubs();
    // Override only the subscriptions.update to throw — keep retrieve working.
    const stripeMod = require('stripe');
    const stripeClient = stripeMod();
    const originalUpdate = stripeClient.subscriptions.update;
    stripeClient.subscriptions.update = async () => { throw new Error('stripe outage'); };

    const app = express();
    app.use('/billing/webhook', express.raw({ type: 'application/json' }));
    app.use('/billing', billingRoutes);

    const res = await postWebhook(app, {});
    assert.strictEqual(res.status, 200,
      'webhook must 200 even when the referral-coupon Stripe call throws');

    stripeClient.subscriptions.update = originalUpdate;
  } finally {
    delete process.env.STRIPE_REFERRAL_COUPON_ID;
  }
}

// ---------- Runner ------------------------------------------------------

async function run() {
  const tests = [
    ['db.creditReferrerIfMissing: SQL shape (CTE UPDATE+SELECT, idempotency guards, params)', testCreditReferrerShape],
    ['db.creditReferrerIfMissing: returns null on replay (zero rows back)', testCreditReferrerIdempotentNull],
    ['db.creditReferrerIfMissing: short-circuits on falsy userId (no query)', testCreditReferrerNullOnFalsyId],
    ['lib/referral: applies STRIPE_REFERRAL_COUPON_ID to referrer subscription', testReferralAppliesCouponOnReferrerSubscription],
    ['lib/referral: skips Stripe call when STRIPE_REFERRAL_COUPON_ID is unset', testReferralSkipsWhenCouponEnvUnset],
    ['lib/referral: skips Stripe call when referrer has no subscription', testReferralSkipsWhenReferrerHasNoSubscription],
    ['lib/referral: soft-fails (no throw) when Stripe SDK throws', testReferralSoftFailsOnStripeThrow],
    ['lib/referral: returns null on idempotent no-op (DB says already credited)', testReferralReturnsNullOnIdempotentNoOp],
    ['lib/referral: soft-fails when DB throws', testReferralSoftFailsOnDbThrow],
    ['POST /create-checkout: attaches discount + omits allow_promotion_codes when referrer + coupon set', testCheckoutAttachesReferralCouponWhenAllSet],
    ['POST /create-checkout: no discount when STRIPE_REFERRAL_COUPON_ID unset', testCheckoutNoDiscountWhenCouponEnvUnset],
    ['POST /create-checkout: no discount + promo codes stay enabled when no referrer', testCheckoutNoDiscountWhenNoReferrer],
    ['POST /billing/webhook: credits referrer on checkout.session.completed', testWebhookCreditsReferrerOnSubscriptionCompletion],
    ['POST /billing/webhook: skips Stripe coupon on webhook replay', testWebhookSkipsCouponWhenDbReportsAlreadyCredited],
    ['POST /billing/webhook: returns 200 even when referral Stripe call throws', testWebhookStillReturns200WhenStripeUpdateThrows]
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
