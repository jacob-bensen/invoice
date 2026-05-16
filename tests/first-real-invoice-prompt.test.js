'use strict';

/*
 * "Create your first real invoice" persistent hero (BACKLOG Milestone 2).
 *
 * Covers:
 *  - buildFirstRealInvoicePrompt gate: returns null for null user, for
 *    invoice_count > 0, for NaN / undefined invoice_count, and when a
 *    non-seed invoice already lives in the list (defence-in-depth against
 *    data drift). Returns { hasSeed: true|false } in the eligible cohort.
 *  - dashboard.ejs renders the new hero when the prompt is set, with the
 *    CTA pointing at /invoices/new. Copy adapts between hasSeed=true (sample
 *    context) and hasSeed=false (cold-start copy).
 *  - dashboard suppresses the LEGACY empty-state hero when the new prompt
 *    is present — never both at once.
 *  - Seed-invoice-hint and Example badge still render below the hero when
 *    seed is present (existing #39 behaviour preserved).
 *  - Free-plan upsell sub-line renders inside the new hero for free users
 *    and is omitted for Pro / Agency.
 *  - Legacy empty-state fallback still fires when firstRealInvoicePrompt
 *    is null and invoices.length === 0 (error-fallback render path).
 *
 * Run: NODE_ENV=test node tests/first-real-invoice-prompt.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

// ---------- helper: load buildFirstRealInvoicePrompt --------------------

function loadInvoiceRouteHelpers() {
  require.cache[require.resolve('../db')] = {
    id: require.resolve('../db'),
    filename: require.resolve('../db'),
    loaded: true,
    exports: { pool: { query: async () => ({ rows: [] }) }, db: {} }
  };
  delete require.cache[require.resolve('../routes/invoices')];
  return require('../routes/invoices');
}

// ---------- buildFirstRealInvoicePrompt — pure gate tests ---------------

function testGateReturnsNullForNullUser() {
  const { buildFirstRealInvoicePrompt } = loadInvoiceRouteHelpers();
  assert.strictEqual(buildFirstRealInvoicePrompt(null, []), null,
    'null user must return null');
  assert.strictEqual(buildFirstRealInvoicePrompt(undefined, []), null,
    'undefined user must return null');
}

function testGateReturnsNullForInvoiceCountGreaterThanZero() {
  const { buildFirstRealInvoicePrompt } = loadInvoiceRouteHelpers();
  const user = { id: 1, invoice_count: 1 };
  assert.strictEqual(buildFirstRealInvoicePrompt(user, []), null,
    'invoice_count > 0 must hide the hero — the user already created at least one real invoice');
}

function testGateReturnsNullForMissingInvoiceCount() {
  const { buildFirstRealInvoicePrompt } = loadInvoiceRouteHelpers();
  assert.strictEqual(buildFirstRealInvoicePrompt({ id: 1 }, []), null,
    'undefined invoice_count is treated as ineligible (Number.isFinite(NaN) === false)');
  assert.strictEqual(buildFirstRealInvoicePrompt({ id: 1, invoice_count: 'oops' }, []), null,
    'non-numeric invoice_count must return null rather than treating it as zero');
}

function testGateReturnsNullWhenNonSeedInvoiceExists() {
  // Data-drift guard: if a non-seed invoice somehow lives in the list while
  // invoice_count is still 0, the user is already past first-real and the
  // hero would hijack the wrong surface.
  const { buildFirstRealInvoicePrompt } = loadInvoiceRouteHelpers();
  const user = { id: 1, invoice_count: 0 };
  assert.strictEqual(
    buildFirstRealInvoicePrompt(user, [{ id: 9, is_seed: false, status: 'draft' }]),
    null,
    'non-seed row in list must hide the hero even when invoice_count is 0'
  );
}

function testGateReturnsHasSeedTrueWhenOnlySeedPresent() {
  const { buildFirstRealInvoicePrompt } = loadInvoiceRouteHelpers();
  const user = { id: 1, invoice_count: 0 };
  const out = buildFirstRealInvoicePrompt(user, [{ id: 1, is_seed: true, status: 'draft' }]);
  assert.deepStrictEqual(out, { hasSeed: true },
    'seed-only list with invoice_count=0 must return { hasSeed: true }');
}

function testGateReturnsHasSeedFalseWhenInvoiceListEmpty() {
  const { buildFirstRealInvoicePrompt } = loadInvoiceRouteHelpers();
  const user = { id: 1, invoice_count: 0 };
  const out = buildFirstRealInvoicePrompt(user, []);
  assert.deepStrictEqual(out, { hasSeed: false },
    'empty list with invoice_count=0 must return { hasSeed: false } — the seed has been deleted');
}

function testGateAcceptsStringInvoiceCount() {
  // pg returns INT columns as JS numbers, but session-restored users may
  // have stringified counts. parseInt covers both.
  const { buildFirstRealInvoicePrompt } = loadInvoiceRouteHelpers();
  assert.deepStrictEqual(
    buildFirstRealInvoicePrompt({ id: 1, invoice_count: '0' }, []),
    { hasSeed: false },
    'string "0" invoice_count must still be treated as zero'
  );
  assert.strictEqual(
    buildFirstRealInvoicePrompt({ id: 1, invoice_count: '2' }, []),
    null,
    'string "2" invoice_count must be treated as > 0 and hide the hero'
  );
}

function testGateAcceptsNonArrayInvoices() {
  const { buildFirstRealInvoicePrompt } = loadInvoiceRouteHelpers();
  assert.deepStrictEqual(
    buildFirstRealInvoicePrompt({ id: 1, invoice_count: 0 }, null),
    { hasSeed: false },
    'null invoices arg must be tolerated (defensive — error-fallback path)'
  );
  assert.deepStrictEqual(
    buildFirstRealInvoicePrompt({ id: 1, invoice_count: 0 }, undefined),
    { hasSeed: false },
    'undefined invoices arg must be tolerated'
  );
}

// ---------- dashboard.ejs render tests ----------------------------------

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
    recentRevenue: null,
    annualUpgradePrompt: null,
    socialProof: null,
    celebration: null,
    staleDraftPrompt: null,
    firstRealInvoicePrompt: null,
    ...locals
  }, {
    views: [path.join(__dirname, '..', 'views')],
    filename: dashboardTplPath
  });
}

function makeSeedInvoice(over) {
  return {
    id: 1,
    invoice_number: 'INV-2026-0001',
    client_name: 'Sample Client (edit this)',
    total: '300.00',
    issued_date: new Date(),
    status: 'draft',
    is_seed: true,
    ...over
  };
}

function testDashboardRendersPromptForEmptyState() {
  const html = renderDashboard({
    invoices: [],
    firstRealInvoicePrompt: { hasSeed: false }
  });
  assert.ok(html.includes('data-testid="first-real-invoice-prompt"'),
    'hero block must render when firstRealInvoicePrompt is set');
  assert.ok(/Create your first real invoice/.test(html),
    'hero headline must read "Create your first real invoice"');
  assert.ok(html.includes('data-testid="first-real-invoice-prompt-cta"'),
    'CTA must carry the testid hook');
  // Confirm the href and testid live on the same <a> tag.
  assert.ok(/<a\s[^>]*href="\/invoices\/new"[^>]*data-testid="first-real-invoice-prompt-cta"/.test(html),
    'CTA anchor must carry href="/invoices/new" and the testid attribute');
  assert.ok(html.includes('data-has-seed="false"'),
    'data-has-seed must reflect the prompt payload');
}

function testDashboardRendersPromptInSeedOnlyState() {
  const html = renderDashboard({
    invoices: [makeSeedInvoice()],
    firstRealInvoicePrompt: { hasSeed: true }
  });
  assert.ok(html.includes('data-testid="first-real-invoice-prompt"'),
    'hero must render alongside the seed-only state (NOT just empty state)');
  assert.ok(html.includes('data-has-seed="true"'),
    'data-has-seed="true" must reflect the seed presence');
  // Seed hint + Example badge from #39 must STILL render below the new hero.
  assert.ok(html.includes('data-testid="seed-invoice-hint"'),
    'seed-invoice-hint must still render in seed-only state alongside the new hero');
  assert.ok(html.includes('data-testid="seed-invoice-badge"'),
    'Example badge on the seed row must still render');
}

function testDashboardCopyVariesWithHasSeed() {
  const withSeed = renderDashboard({
    invoices: [makeSeedInvoice()],
    firstRealInvoicePrompt: { hasSeed: true }
  });
  const withoutSeed = renderDashboard({
    invoices: [],
    firstRealInvoicePrompt: { hasSeed: false }
  });
  assert.ok(/sample below/i.test(withSeed),
    'hasSeed=true copy must reference the sample below');
  assert.ok(!/sample below/i.test(withoutSeed),
    'hasSeed=false copy must NOT reference the sample (it was deleted or never seeded)');
  assert.ok(/60 seconds|under 60 seconds/i.test(withoutSeed),
    'hasSeed=false copy must surface the 60-second promise');
}

function testDashboardSuppressesLegacyEmptyStateWhenPromptPresent() {
  const html = renderDashboard({
    invoices: [],
    firstRealInvoicePrompt: { hasSeed: false }
  });
  // The legacy empty-state used the headline "Send your first invoice today";
  // the new hero replaces it. They must NEVER both render — that would be
  // a duplicate-CTA on the same surface.
  assert.ok(!/Send your first invoice today/.test(html),
    'legacy empty-state headline must NOT render when the new prompt is shown');
  // Exactly one /invoices/new "Create" CTA on the page.
  const newCtaMatches = html.match(/data-testid="first-real-invoice-prompt-cta"/g) || [];
  assert.strictEqual(newCtaMatches.length, 1,
    'exactly one new-hero CTA must render — no duplicates');
}

function testDashboardOmitsPromptWhenNull() {
  const html = renderDashboard({
    invoices: [],
    firstRealInvoicePrompt: null
  });
  assert.ok(!html.includes('data-testid="first-real-invoice-prompt"'),
    'hero must NOT render when firstRealInvoicePrompt is null');
  // Legacy empty-state fallback DOES still fire — preserves the error-render path.
  assert.ok(/Send your first invoice today/.test(html),
    'legacy empty-state must still fire as the fallback when prompt is null');
}

function testDashboardOmitsPromptForUsersWithRealInvoices() {
  // When the real route runs, buildFirstRealInvoicePrompt returns null for
  // invoice_count > 0 users, so firstRealInvoicePrompt should never be set
  // for them. Defence-in-depth: even if it leaked through, the view should
  // render the table. The hero IS gated on the prompt itself being set,
  // not on invoices.length, so we verify the gate from the helper end too.
  const html = renderDashboard({
    invoices: [{ id: 10, invoice_number: 'INV-2026-0002', client_name: 'Real Client', total: '500.00', issued_date: new Date(), status: 'sent', is_seed: false }],
    firstRealInvoicePrompt: null,
    user: { plan: 'free', invoice_count: 1, subscription_status: null }
  });
  assert.ok(!html.includes('data-testid="first-real-invoice-prompt"'),
    'hero must NOT render for users with real invoices');
  // Stats grid still renders — invoice table is present.
  assert.ok(/Real Client/.test(html),
    'invoice table still renders when prompt is null');
}

function testDashboardShowsFreePlanUpsellInsideHero() {
  const html = renderDashboard({
    invoices: [],
    firstRealInvoicePrompt: { hasSeed: false },
    user: { plan: 'free', invoice_count: 0, subscription_status: null }
  });
  // Pull the substring between the hero testid and its closing </div> chain
  // — we want to assert the upsell sub-line lives INSIDE the hero, not
  // somewhere else on the page.
  const heroStart = html.indexOf('data-testid="first-real-invoice-prompt"');
  assert.ok(heroStart >= 0, 'hero block must render for the slice check');
  const slice = html.slice(heroStart, heroStart + 2000);
  assert.ok(/Try Pro free for 7 days/i.test(slice),
    'free-plan upsell sub-line must render inside the hero block');
}

function testDashboardHidesProUpsellSubLineForPro() {
  const html = renderDashboard({
    invoices: [],
    firstRealInvoicePrompt: { hasSeed: false },
    user: { plan: 'pro', invoice_count: 0, subscription_status: 'active' }
  });
  const heroStart = html.indexOf('data-testid="first-real-invoice-prompt"');
  const slice = html.slice(heroStart, heroStart + 2000);
  assert.ok(!/Try Pro free for 7 days/i.test(slice),
    'Pro users must NOT see the free-plan trial upsell inside the hero');
}

// ---------- Runner ------------------------------------------------------

async function run() {
  const tests = [
    ['gate: null/undefined user returns null', testGateReturnsNullForNullUser],
    ['gate: invoice_count > 0 returns null', testGateReturnsNullForInvoiceCountGreaterThanZero],
    ['gate: missing / non-numeric invoice_count returns null', testGateReturnsNullForMissingInvoiceCount],
    ['gate: non-seed row in list returns null (data-drift guard)', testGateReturnsNullWhenNonSeedInvoiceExists],
    ['gate: seed-only list returns { hasSeed: true }', testGateReturnsHasSeedTrueWhenOnlySeedPresent],
    ['gate: empty list returns { hasSeed: false }', testGateReturnsHasSeedFalseWhenInvoiceListEmpty],
    ['gate: string invoice_count is coerced', testGateAcceptsStringInvoiceCount],
    ['gate: non-array invoices arg tolerated', testGateAcceptsNonArrayInvoices],
    ['dashboard: hero renders in empty state with hasSeed=false', testDashboardRendersPromptForEmptyState],
    ['dashboard: hero renders in seed-only state alongside seed hint', testDashboardRendersPromptInSeedOnlyState],
    ['dashboard: copy varies between hasSeed=true and hasSeed=false', testDashboardCopyVariesWithHasSeed],
    ['dashboard: legacy empty-state suppressed when prompt present', testDashboardSuppressesLegacyEmptyStateWhenPromptPresent],
    ['dashboard: prompt omitted when null + legacy fallback fires', testDashboardOmitsPromptWhenNull],
    ['dashboard: hero omitted for users with real invoices', testDashboardOmitsPromptForUsersWithRealInvoices],
    ['dashboard: free-plan upsell sub-line renders inside hero', testDashboardShowsFreePlanUpsellInsideHero],
    ['dashboard: Pro user hides upsell sub-line inside hero', testDashboardHidesProUpsellSubLineForPro]
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

run().catch((err) => { console.error(err); process.exit(1); });
