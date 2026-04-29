'use strict';

/*
 * Free-plan invoice-limit progress bar tests (INTERNAL_TODO #31).
 *
 * Covers:
 *  - buildInvoiceLimitProgress() pure logic (free plan only, percent math,
 *    near/at-limit flags, never exceeds 100%).
 *  - Returns null for null user, missing user, paid plans (pro/business/agency).
 *  - dashboard.ejs renders the progress bar with correct copy + width when the
 *    local is set, omits it when the local is null/undefined.
 *  - At-limit + near-limit branches use the amber colour family; healthy state
 *    uses the brand colour.
 *  - The progress bar carries print:hidden so it does not leak into PDFs.
 *  - The progress bar always includes the "Upgrade →" link (the highest-intent
 *    CTA on the dashboard for a free user nearing the wall).
 *  - Defence-in-depth: malformed user.invoice_count (string, NaN, negative)
 *    must not crash the helper or render junk in the bar.
 *
 * Run: NODE_ENV=test node tests/invoice-limit-progress.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

// Stub db so requiring routes/invoices doesn't open a pool.
require.cache[require.resolve('../db')] = {
  id: require.resolve('../db'),
  filename: require.resolve('../db'),
  loaded: true,
  exports: {
    pool: { query: async () => ({ rows: [] }) },
    db: {}
  }
};

delete require.cache[require.resolve('../routes/invoices')];
const invoiceRoutes = require('../routes/invoices');
const { buildInvoiceLimitProgress, FREE_LIMIT } = invoiceRoutes;

const dashboardTplPath = path.join(__dirname, '..', 'views', 'dashboard.ejs');
const dashboardTpl = fs.readFileSync(dashboardTplPath, 'utf8');

function renderDashboard(locals) {
  return ejs.render(dashboardTpl, {
    title: 'Dashboard',
    flash: null,
    days_left_in_trial: 0,
    csrfToken: 'TEST_CSRF',
    invoices: [],
    user: { plan: 'free', invoice_count: 0, subscription_status: null },
    onboarding: null,
    invoiceLimitProgress: null,
    ...locals
  }, {
    views: [path.join(__dirname, '..', 'views')],
    filename: dashboardTplPath
  });
}

// ---------- Pure helper -------------------------------------------------

function testHelperReturnsNullForPaidPlans() {
  for (const plan of ['pro', 'business', 'agency']) {
    const out = buildInvoiceLimitProgress({ plan, invoice_count: 1 });
    assert.strictEqual(out, null,
      `buildInvoiceLimitProgress must return null for plan="${plan}" — paid users do not see the bar`);
  }
}

function testHelperReturnsNullForMissingUser() {
  assert.strictEqual(buildInvoiceLimitProgress(null), null);
  assert.strictEqual(buildInvoiceLimitProgress(undefined), null);
}

function testHelperReturnsObjectForFreePlan() {
  const out = buildInvoiceLimitProgress({ plan: 'free', invoice_count: 1 });
  assert.ok(out && typeof out === 'object', 'free plan must return a progress object');
  assert.strictEqual(out.used, 1);
  assert.strictEqual(out.max, FREE_LIMIT);
  assert.strictEqual(out.percent, Math.round((1 / FREE_LIMIT) * 100));
  assert.strictEqual(out.remaining, FREE_LIMIT - 1);
  assert.strictEqual(out.atLimit, false);
}

function testHelperZeroUsedRendersCleanState() {
  const out = buildInvoiceLimitProgress({ plan: 'free', invoice_count: 0 });
  assert.strictEqual(out.used, 0);
  assert.strictEqual(out.percent, 0);
  assert.strictEqual(out.atLimit, false);
  assert.strictEqual(out.nearLimit, false,
    '0/3 must not be flagged near-limit; that fires only at 2/3');
}

function testHelperNearLimitFlagsOneRemaining() {
  // FREE_LIMIT is 3 today; the near-limit threshold is "remaining <= 1 AND not at-limit".
  const out = buildInvoiceLimitProgress({ plan: 'free', invoice_count: FREE_LIMIT - 1 });
  assert.strictEqual(out.nearLimit, true,
    'used = max-1 must flag nearLimit so the UI can switch to amber');
  assert.strictEqual(out.atLimit, false);
  assert.strictEqual(out.remaining, 1);
}

function testHelperAtLimitFlag() {
  const out = buildInvoiceLimitProgress({ plan: 'free', invoice_count: FREE_LIMIT });
  assert.strictEqual(out.atLimit, true);
  assert.strictEqual(out.nearLimit, false,
    'at-limit must not also set nearLimit (ui branches are mutually exclusive)');
  assert.strictEqual(out.percent, 100);
  assert.strictEqual(out.remaining, 0);
}

function testHelperOverLimitClampsPercent() {
  // A misbehaving DB row could put invoice_count > FREE_LIMIT (e.g. data import,
  // race, or a Pro-to-Free downgrade leaving residual count). The bar must
  // clamp at 100% and remaining at 0 — never render width:120% or negative.
  const out = buildInvoiceLimitProgress({ plan: 'free', invoice_count: FREE_LIMIT + 5 });
  assert.strictEqual(out.percent, 100);
  assert.strictEqual(out.remaining, 0);
  assert.strictEqual(out.atLimit, true);
}

function testHelperHandlesMalformedInvoiceCount() {
  // Defence-in-depth: invoice_count comes from the DB row but a stale session
  // could carry undefined / null / "1" (string from a hand-edited record).
  // None of these should crash or produce NaN%.
  const cases = [
    [{ plan: 'free', invoice_count: undefined }, 0],
    [{ plan: 'free', invoice_count: null }, 0],
    [{ plan: 'free', invoice_count: '2' }, 2],
    [{ plan: 'free', invoice_count: -1 }, 0], // negative clamps to 0
    [{ plan: 'free', invoice_count: 'abc' }, 0]
  ];
  for (const [user, expectedUsed] of cases) {
    const out = buildInvoiceLimitProgress(user);
    assert.strictEqual(out.used, expectedUsed,
      `malformed invoice_count=${JSON.stringify(user.invoice_count)} must coerce to ${expectedUsed}`);
    assert.ok(Number.isFinite(out.percent), 'percent must be a finite number');
    assert.ok(out.percent >= 0 && out.percent <= 100,
      'percent must be in [0,100]');
  }
}

// ---------- Template render --------------------------------------------

function testDashboardRendersBarWhenLocalSet() {
  const html = renderDashboard({
    invoiceLimitProgress: { used: 1, max: 3, percent: 33, remaining: 2, atLimit: false, nearLimit: false }
  });
  assert.ok(/data-testid=["']invoice-limit-progress["']/.test(html),
    'dashboard must render invoice-limit-progress region when local is provided');
  assert.ok(/<strong>1 of 3<\/strong> free invoices used/.test(html),
    'bar must show "<used> of <max>" copy with strong tag');
  assert.ok(/width:\s*33%/.test(html),
    'bar inner fill must use the percent value as inline width');
  assert.ok(/href=["']\/billing\/upgrade["']/.test(html),
    'bar must include the upgrade CTA link to /billing/upgrade');
  assert.ok(/print:hidden/.test(html.match(/data-testid=["']invoice-limit-progress["'][\s\S]*?<\/div>\s*<\/div>/)[0]),
    'progress bar container must carry print:hidden');
}

function testDashboardOmitsBarWhenLocalNull() {
  const html = renderDashboard({ invoiceLimitProgress: null });
  assert.ok(!/data-testid=["']invoice-limit-progress["']/.test(html),
    'progress bar must not render when invoiceLimitProgress is null');
}

function testDashboardOmitsBarWhenLocalUndefined() {
  // Catch-branch in the dashboard route falls back to the local being passed
  // explicitly as null, but a future regression could omit it. The template
  // must not crash either way.
  const html = ejs.render(dashboardTpl, {
    title: 'Dashboard',
    flash: null,
    days_left_in_trial: 0,
    csrfToken: 'T',
    invoices: [],
    user: { plan: 'free', invoice_count: 0, subscription_status: null },
    onboarding: null
    // invoiceLimitProgress intentionally omitted
  }, { views: [path.join(__dirname, '..', 'views')], filename: dashboardTplPath });
  assert.ok(!/data-testid=["']invoice-limit-progress["']/.test(html),
    'template must not crash or render bar when invoiceLimitProgress local is missing');
}

function testDashboardAtLimitUsesAmber() {
  const html = renderDashboard({
    invoiceLimitProgress: { used: 3, max: 3, percent: 100, remaining: 0, atLimit: true, nearLimit: false }
  });
  // The at-limit branch must visually escalate. Both the container background
  // and the inner fill switch to the amber colour family.
  assert.ok(/border-amber-200/.test(html),
    'at-limit container must use amber border');
  assert.ok(/bg-amber-50/.test(html),
    'at-limit container must use amber background');
  assert.ok(/bg-amber-500/.test(html),
    'at-limit inner fill must use amber-500 (visual urgency)');
  assert.ok(/you've hit the limit/.test(html),
    'at-limit copy must call out the hit-limit state');
  assert.ok(/width:\s*100%/.test(html),
    'at-limit fill must be full-width');
}

function testDashboardNearLimitUsesAmber() {
  const html = renderDashboard({
    invoiceLimitProgress: { used: 2, max: 3, percent: 67, remaining: 1, atLimit: false, nearLimit: true }
  });
  assert.ok(/border-amber-200/.test(html),
    'near-limit container must use amber border');
  assert.ok(/bg-amber-500/.test(html),
    'near-limit inner fill must use amber-500');
  assert.ok(/1 left this plan/.test(html),
    'near-limit copy must show how many invoices remain');
}

function testDashboardHealthyStateUsesBrand() {
  const html = renderDashboard({
    invoiceLimitProgress: { used: 1, max: 3, percent: 33, remaining: 2, atLimit: false, nearLimit: false }
  });
  // Healthy state stays calm — brand colour, no urgency copy.
  assert.ok(!/you've hit the limit/.test(html),
    'healthy state must not show at-limit copy');
  assert.ok(!/left this plan/.test(html),
    'healthy state must not show near-limit copy');
  // The bar fill should use bg-brand-600 (the existing CTA colour).
  const barRegion = html.match(/data-testid=["']invoice-limit-progress["'][\s\S]*?<\/div>\s*<\/div>/);
  assert.ok(barRegion, 'progress bar region must render');
  assert.ok(/bg-brand-600/.test(barRegion[0]),
    'healthy-state inner fill must use the brand colour');
}

function testDashboardBarHidesForPaidPlansViaHelper() {
  // End-to-end: when the route passes invoiceLimitProgress=null (because the
  // user is Pro), the bar must not render even if user.plan happens to be
  // something else in the locals (defence in depth — the bar is keyed off
  // the local, not off user.plan, so a future helper change can't silently
  // re-enable the bar for paid plans without updating the helper).
  const html = renderDashboard({
    user: { plan: 'pro', invoice_count: 1, subscription_status: 'active' },
    invoiceLimitProgress: null
  });
  assert.ok(!/data-testid=["']invoice-limit-progress["']/.test(html),
    'Pro user with null invoiceLimitProgress must not see the bar');
}

// ---------- Runner -----------------------------------------------------

async function run() {
  const tests = [
    ['buildInvoiceLimitProgress: paid plans → null', testHelperReturnsNullForPaidPlans],
    ['buildInvoiceLimitProgress: missing user → null', testHelperReturnsNullForMissingUser],
    ['buildInvoiceLimitProgress: free plan → progress object', testHelperReturnsObjectForFreePlan],
    ['buildInvoiceLimitProgress: 0 used → clean state, no nearLimit flag', testHelperZeroUsedRendersCleanState],
    ['buildInvoiceLimitProgress: 1-remaining → nearLimit flag', testHelperNearLimitFlagsOneRemaining],
    ['buildInvoiceLimitProgress: at-limit → atLimit flag, percent 100', testHelperAtLimitFlag],
    ['buildInvoiceLimitProgress: over-limit clamps to 100% / 0 remaining', testHelperOverLimitClampsPercent],
    ['buildInvoiceLimitProgress: malformed invoice_count is coerced safely', testHelperHandlesMalformedInvoiceCount],
    ['dashboard.ejs: renders progress bar when local is set', testDashboardRendersBarWhenLocalSet],
    ['dashboard.ejs: omits bar when local is null', testDashboardOmitsBarWhenLocalNull],
    ['dashboard.ejs: omits bar when local is undefined', testDashboardOmitsBarWhenLocalUndefined],
    ['dashboard.ejs: at-limit branch uses amber + urgency copy', testDashboardAtLimitUsesAmber],
    ['dashboard.ejs: near-limit branch uses amber + remaining copy', testDashboardNearLimitUsesAmber],
    ['dashboard.ejs: healthy state uses brand colour, no urgency copy', testDashboardHealthyStateUsesBrand],
    ['dashboard.ejs: paid plan with null progress → no bar', testDashboardBarHidesForPaidPlansViaHelper]
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
