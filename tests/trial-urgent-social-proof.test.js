'use strict';

/*
 * Trial-urgent banner social-proof line (#135) — closes the urgency stack
 * for milestone 4. Three layers tested:
 *
 *   1. db.countActiveProSubscribers() — SQL filters on plan IN ('pro','agency')
 *      AND subscription_status = 'active'. Trialing / past_due / paused users
 *      do NOT inflate the count (they're either the audience or mid-churn).
 *
 *   2. lib/pro-subscriber-count.js cached loader — caches for 1 hour, falls
 *      back to a static-copy shape when the live count is below the
 *      threshold or when the DB call throws.
 *
 *   3. views/dashboard.ejs — renders a "Join N freelancers on Pro" pill on
 *      the day-1 trial-urgent banner only, with thousands-separator
 *      formatting; renders the static fallback when socialProof.count is
 *      null; renders nothing when socialProof is null.
 *
 * Run: node tests/trial-urgent-social-proof.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');

// ---------- db.countActiveProSubscribers() ------------------------------

async function testCountActiveProSubscribersSqlShape() {
  const calls = [];
  const stubPool = {
    query: async (text, params) => {
      calls.push({ text, params });
      return { rows: [{ count: 1342 }] };
    }
  };
  // Inject a stub pool into a fresh copy of db.js so we can verify the
  // exact SQL without hitting Postgres. We rebuild the helper from its
  // source to keep this hermetic.
  const dbSource = fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8');
  const match = dbSource.match(/async countActiveProSubscribers\(\) \{[\s\S]*?\n  \},/);
  assert.ok(match, 'db.countActiveProSubscribers must exist in db.js');
  const fnBody = match[0]
    .replace(/^\s*async countActiveProSubscribers\(\) \{/, '')
    .replace(/\n  \},\s*$/, '');
  // Wrap in an async function with `pool` in scope.
  // eslint-disable-next-line no-new-func
  const fn = new Function('pool', `return (async () => { ${fnBody} })();`);
  const result = await fn(stubPool);
  assert.strictEqual(result, 1342, 'returns the integer COUNT(*)');
  assert.strictEqual(calls.length, 1, 'issues exactly one SQL query');
  const sql = calls[0].text;
  assert.ok(/COUNT\(\*\)/i.test(sql), 'uses COUNT(*)');
  assert.ok(/plan IN \('pro', 'agency'\)/.test(sql),
    'filters on plan IN (\'pro\',\'agency\') — excludes free + business legacy from the social-proof number');
  assert.ok(/subscription_status = 'active'/.test(sql),
    "filters on subscription_status='active' — does not pad with trialing/past_due/paused users");
}

async function testCountActiveProSubscribersHandlesZeroRows() {
  const stubPool = {
    query: async () => ({ rows: [{ count: 0 }] })
  };
  const dbSource = fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8');
  const match = dbSource.match(/async countActiveProSubscribers\(\) \{[\s\S]*?\n  \},/);
  const fnBody = match[0]
    .replace(/^\s*async countActiveProSubscribers\(\) \{/, '')
    .replace(/\n  \},\s*$/, '');
  // eslint-disable-next-line no-new-func
  const fn = new Function('pool', `return (async () => { ${fnBody} })();`);
  const result = await fn(stubPool);
  assert.strictEqual(result, 0, 'fresh DB returns 0 (not NaN, not null)');
}

async function testCountActiveProSubscribersHandlesStringCount() {
  // pg can return COUNT as a string when the integer cast is dropped.
  // The ::int cast in the SQL should prevent this, but the JS layer must
  // be tolerant if a future schema change loses the cast.
  const stubPool = {
    query: async () => ({ rows: [{ count: '777' }] })
  };
  const dbSource = fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8');
  const match = dbSource.match(/async countActiveProSubscribers\(\) \{[\s\S]*?\n  \},/);
  const fnBody = match[0]
    .replace(/^\s*async countActiveProSubscribers\(\) \{/, '')
    .replace(/\n  \},\s*$/, '');
  // eslint-disable-next-line no-new-func
  const fn = new Function('pool', `return (async () => { ${fnBody} })();`);
  const result = await fn(stubPool);
  assert.strictEqual(result, 777, 'string count is coerced to integer');
}

// ---------- lib/pro-subscriber-count.js loader --------------------------

function freshLoader() {
  delete require.cache[require.resolve('../lib/pro-subscriber-count')];
  return require('../lib/pro-subscriber-count');
}

async function testLoaderReturnsCountShapeAboveThreshold() {
  const { loadProSubscriberCount, _resetForTests } = freshLoader();
  _resetForTests();
  let calls = 0;
  const db = { countActiveProSubscribers: async () => { calls++; return 1247; } };
  const result = await loadProSubscriberCount(db);
  assert.deepStrictEqual(result, { count: 1247, fallback: null });
  assert.strictEqual(calls, 1);
}

async function testLoaderReturnsStaticFallbackBelowThreshold() {
  const { loadProSubscriberCount, _resetForTests, STATIC_FALLBACK_COPY } = freshLoader();
  _resetForTests();
  const db = { countActiveProSubscribers: async () => 12 };
  const result = await loadProSubscriberCount(db);
  assert.strictEqual(result.count, null, 'below-threshold count is suppressed (no anti-persuasive small number)');
  assert.strictEqual(result.fallback, STATIC_FALLBACK_COPY);
}

async function testLoaderReturnsStaticFallbackOnDbThrow() {
  const { loadProSubscriberCount, _resetForTests, STATIC_FALLBACK_COPY } = freshLoader();
  _resetForTests();
  const db = { countActiveProSubscribers: async () => { throw new Error('boom'); } };
  const result = await loadProSubscriberCount(db);
  assert.strictEqual(result.count, null);
  assert.strictEqual(result.fallback, STATIC_FALLBACK_COPY);
}

async function testLoaderCachesForOneHour() {
  const { loadProSubscriberCount, _resetForTests, ONE_HOUR_MS } = freshLoader();
  _resetForTests();
  let calls = 0;
  const db = { countActiveProSubscribers: async () => { calls++; return 5000; } };
  const t0 = 1_000_000;
  await loadProSubscriberCount(db, t0);
  await loadProSubscriberCount(db, t0 + 1000);
  await loadProSubscriberCount(db, t0 + 60_000);
  await loadProSubscriberCount(db, t0 + (ONE_HOUR_MS - 1000));
  assert.strictEqual(calls, 1, 'one DB query within the 1-hour TTL even after 4 calls');
}

async function testLoaderRefreshesAfterTtlExpiry() {
  const { loadProSubscriberCount, _resetForTests, ONE_HOUR_MS } = freshLoader();
  _resetForTests();
  let calls = 0;
  const db = { countActiveProSubscribers: async () => { calls++; return 5000 + calls; } };
  const t0 = 1_000_000;
  await loadProSubscriberCount(db, t0);
  // Past the TTL — second call must hit the DB again.
  const fresh = await loadProSubscriberCount(db, t0 + ONE_HOUR_MS + 1000);
  assert.strictEqual(calls, 2, 'second DB call fires past the 1-hour TTL');
  assert.strictEqual(fresh.count, 5002, 'returns the refreshed count, not the stale one');
}

async function testLoaderConcurrentCallsCoalesce() {
  const { loadProSubscriberCount, _resetForTests } = freshLoader();
  _resetForTests();
  let calls = 0;
  const db = {
    countActiveProSubscribers: async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return 999;
    }
  };
  const [a, b, c] = await Promise.all([
    loadProSubscriberCount(db),
    loadProSubscriberCount(db),
    loadProSubscriberCount(db)
  ]);
  assert.strictEqual(calls, 1, 'three concurrent dashboard renders coalesce into one DB call');
  assert.strictEqual(a.count, 999);
  assert.strictEqual(b.count, 999);
  assert.strictEqual(c.count, 999);
}

// ---------- views/dashboard.ejs render ----------------------------------

const dashboardTplPath = path.join(__dirname, '..', 'views', 'dashboard.ejs');
const dashboardTpl = fs.readFileSync(dashboardTplPath, 'utf8');

function renderDashboard(locals) {
  return ejs.render(dashboardTpl, {
    title: 'Dashboard',
    flash: null,
    days_left_in_trial: 0,
    csrfToken: 'TEST_CSRF',
    invoices: [
      { id: 1, invoice_number: 'INV-2026-0001', client_name: 'Acme', issued_date: '2026-04-01', total: 500, status: 'paid' }
    ],
    user: {
      plan: 'pro',
      invoice_count: 5,
      subscription_status: 'trialing',
      trial_ends_at: new Date(Date.now() + 12 * 3600 * 1000).toISOString()
    },
    onboarding: null,
    invoiceLimitProgress: null,
    recentRevenue: null,
    annualUpgradePrompt: null,
    socialProof: null,
    ...locals
  }, {
    views: [path.join(__dirname, '..', 'views')],
    filename: dashboardTplPath
  });
}

function testViewRendersSocialProofPillWithCount() {
  const html = renderDashboard({
    days_left_in_trial: 1,
    socialProof: { count: 1247, fallback: null }
  });
  assert.ok(/data-testid="trial-urgent-social-proof"/.test(html),
    'social-proof pill renders on day-1 banner');
  assert.ok(/data-testid="trial-urgent-social-proof-count">1,247<\/span>/.test(html),
    'count is rendered with thousands separator (1,247 not 1247)');
  assert.ok(/Join\s+<span data-testid="trial-urgent-social-proof-count">1,247<\/span>\s+freelancers on Pro/.test(html),
    '"Join N freelancers on Pro" copy wraps the count');
}

function testViewRendersStaticFallbackWhenCountNull() {
  const html = renderDashboard({
    days_left_in_trial: 1,
    socialProof: { count: null, fallback: 'Join the freelancers who locked in Pro this week' }
  });
  assert.ok(/data-testid="trial-urgent-social-proof"/.test(html),
    'pill still renders when count is below threshold / lookup failed');
  assert.ok(/data-testid="trial-urgent-social-proof-fallback">Join the freelancers who locked in Pro this week<\/span>/.test(html),
    'static fallback copy is rendered instead of a count');
  assert.ok(!/trial-urgent-social-proof-count/.test(html),
    'count span is omitted when fallback is in use (no empty number rendered)');
}

function testViewOmitsSocialProofWhenLocalIsNull() {
  const html = renderDashboard({
    days_left_in_trial: 1,
    socialProof: null
  });
  assert.ok(!/trial-urgent-social-proof/.test(html),
    'pill is omitted entirely when locals.socialProof is null (e.g. non-day-1 banner)');
}

function testViewOmitsSocialProofOnEarlierTrialDays() {
  // Even if a future bug threaded socialProof into render on day-2+ by
  // accident, the banner copy itself only enters the trial-urgent branch
  // on day 1 — so the pill must NOT render on day-2-or-later.
  const html = renderDashboard({
    days_left_in_trial: 3,
    socialProof: { count: 9999, fallback: null }
  });
  assert.ok(!/trial-urgent-social-proof/.test(html),
    'social-proof pill is gated inside the trial-urgent branch; never appears on the day-7-through-day-2 banner');
}

function testViewSocialProofPillSitsBelowAnnualPill() {
  // Anchor stack order: hours-remaining (#134) → annual-savings (#133) →
  // social-proof (#135). The DOM order matters for visual hierarchy on the
  // banner — social proof closes the stack.
  const html = renderDashboard({
    days_left_in_trial: 1,
    socialProof: { count: 1247, fallback: null }
  });
  const annualIdx = html.indexOf('data-testid="trial-urgent-annual-pill"');
  const socialIdx = html.indexOf('data-testid="trial-urgent-social-proof"');
  assert.ok(annualIdx > -1 && socialIdx > -1);
  assert.ok(socialIdx > annualIdx,
    'social-proof pill (#135) must render below the annual-savings pill (#133)');
}

function testViewSocialProofPillCarriesUrgentRedPalette() {
  // The day-1 banner is red (urgent). The social-proof pill should match
  // the urgent palette (red-100 / red-800) rather than the green
  // annual-savings palette — keeps the visual cue "this is still urgent"
  // even on the supportive social-proof anchor.
  const html = renderDashboard({
    days_left_in_trial: 1,
    socialProof: { count: 1247, fallback: null }
  });
  const idx = html.indexOf('data-testid="trial-urgent-social-proof"');
  const window = html.slice(idx, idx + 600);
  assert.ok(/bg-red-\d{2,3}/.test(window),
    'social-proof pill carries the urgent red palette (visual continuity with the day-1 banner)');
  assert.ok(/rounded-full/.test(window),
    'social-proof pill is rounded-full (pill shape, consistent with the other two anchors)');
}

function testViewEscapesFallbackCopy() {
  const html = renderDashboard({
    days_left_in_trial: 1,
    socialProof: { count: null, fallback: '<script>alert(1)</script>' }
  });
  assert.ok(!/<script>alert\(1\)<\/script>/.test(html),
    'fallback copy is HTML-escaped — no raw <script> tag in output');
  assert.ok(/&lt;script&gt;alert\(1\)&lt;\/script&gt;/.test(html),
    'fallback copy renders escaped form');
}

// ---------- Runner ------------------------------------------------------

async function run() {
  const tests = [
    ['db.countActiveProSubscribers SQL shape (plan + active-only filters)', testCountActiveProSubscribersSqlShape],
    ['db.countActiveProSubscribers handles zero-row fresh DB', testCountActiveProSubscribersHandlesZeroRows],
    ['db.countActiveProSubscribers tolerates string count column', testCountActiveProSubscribersHandlesStringCount],
    ['loader returns {count} shape above threshold', testLoaderReturnsCountShapeAboveThreshold],
    ['loader returns static fallback below threshold', testLoaderReturnsStaticFallbackBelowThreshold],
    ['loader returns static fallback when DB throws', testLoaderReturnsStaticFallbackOnDbThrow],
    ['loader caches result for 1 hour (single DB call across 4 reads)', testLoaderCachesForOneHour],
    ['loader refreshes after TTL expiry', testLoaderRefreshesAfterTtlExpiry],
    ['loader coalesces concurrent calls into a single DB query', testLoaderConcurrentCallsCoalesce],
    ['view renders "Join 1,247 freelancers on Pro" with thousands separator', testViewRendersSocialProofPillWithCount],
    ['view renders static fallback copy when count is null', testViewRendersStaticFallbackWhenCountNull],
    ['view omits social-proof pill when locals.socialProof is null', testViewOmitsSocialProofWhenLocalIsNull],
    ['view omits social-proof pill on earlier trial days (day-2+)', testViewOmitsSocialProofOnEarlierTrialDays],
    ['view stack order: hours → annual → social-proof (DOM order)', testViewSocialProofPillSitsBelowAnnualPill],
    ['view social-proof pill carries urgent red palette + rounded-full', testViewSocialProofPillCarriesUrgentRedPalette],
    ['view HTML-escapes the fallback copy (XSS defence)', testViewEscapesFallbackCopy]
  ];

  let pass = 0;
  let fail = 0;
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
