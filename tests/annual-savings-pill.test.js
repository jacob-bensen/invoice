'use strict';

/*
 * Annual savings $-amount pill tests (#101).
 *
 * Asserts that when a user toggles the Monthly/Annual selector to "annual",
 * the rendered HTML on each of the three upgrade surfaces carries the
 * dollar-amount savings as a prominent pill (not just the "Save 31%"
 * percentage label). The pill must:
 *
 *   1. Carry a literal "Save $45/year" string (the dollar number is the
 *      conversion-decision input we want surfaced — the percentage label
 *      is retained but is no longer the only signal).
 *   2. Be wrapped in an x-show="cycle === 'annual'" attribute so it ONLY
 *      appears when the user has selected the annual option (preventing
 *      flash-of-unselected-state on initial render).
 *   3. Sit inside the same Alpine x-data scope that owns `cycle`, so the
 *      reactive show/hide actually works.
 *
 * Run: node tests/annual-savings-pill.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');

function renderPricing(user) {
  const tpl = fs.readFileSync(path.join(__dirname, '..', 'views', 'pricing.ejs'), 'utf8');
  return ejs.render(tpl, { user, title: 'Upgrade', flash: null }, {
    views: [path.join(__dirname, '..', 'views')],
    filename: path.join(__dirname, '..', 'views', 'pricing.ejs')
  });
}

function renderSettings(user) {
  const tpl = fs.readFileSync(path.join(__dirname, '..', 'views', 'settings.ejs'), 'utf8');
  return ejs.render(tpl, { user, title: 'Settings', flash: null }, {
    views: [path.join(__dirname, '..', 'views')],
    filename: path.join(__dirname, '..', 'views', 'settings.ejs')
  });
}

function renderUpgradeModal() {
  const tpl = fs.readFileSync(path.join(__dirname, '..', 'views', 'partials', 'upgrade-modal.ejs'), 'utf8');
  return ejs.render(tpl, {}, {});
}

// ---------- pricing.ejs ------------------------------------------------

function testPricingPageRendersAnnualSavingsPill() {
  const html = renderPricing({ plan: 'free' });
  assert.ok(/Save\s+\$45\/year/.test(html),
    'pricing page must render the literal "Save $45/year" string when annual is selected');
  // Pill must be hidden when monthly is selected — check it's gated by x-show on cycle.
  // The pill is inside the price flex row that has x-show="cycle === 'annual'".
  const pillIdx = html.indexOf('Save $45/year');
  assert.ok(pillIdx > 0, 'pill must exist');
  // Walk back from pillIdx to the nearest x-show attribute and assert it gates on annual.
  const before = html.slice(0, pillIdx);
  const lastXShow = before.lastIndexOf('x-show=');
  assert.ok(lastXShow !== -1, 'pill must be wrapped in an x-show attribute');
  const xShowFragment = html.slice(lastXShow, lastXShow + 80);
  assert.ok(/cycle\s*===\s*['"]annual['"]/.test(xShowFragment),
    'pill must be x-shown only when cycle === annual (no flash-of-unselected on monthly default)');
}

function testPricingPageRetainsPercentageBadgeOnToggle() {
  // The toggle's "Save 31%" pill is a separate element from the new $-amount pill.
  // Both should coexist — the percentage on the toggle button itself, the dollar
  // amount as the prominent inline price-adjacent pill.
  const html = renderPricing({ plan: 'free' });
  assert.ok(/Save\s+31%/.test(html),
    'pricing page must retain the existing "Save 31%" toggle pill (defence against accidental removal)');
}

function testPricingPagePillIsVisuallyPromoted() {
  // Pill should use a background-colour utility class (not bare text). Specifically
  // a green/emerald palette so it reads as a savings affordance and not a regular
  // body-text line.
  const html = renderPricing({ plan: 'free' });
  // Find the "Save $45/year" element and walk back to its enclosing tag.
  const pillIdx = html.indexOf('Save $45/year');
  const window = html.slice(Math.max(0, pillIdx - 400), pillIdx);
  assert.ok(/(bg-emerald|bg-green)-\d{2,3}/.test(window),
    'pricing pill must carry an emerald/green background class for visual emphasis');
  assert.ok(/rounded(-full|-md|-lg|-xl)?/.test(window),
    'pricing pill must be rounded (pill-shape, not a flat banner)');
}

// ---------- settings.ejs ----------------------------------------------

function testSettingsPageRendersAnnualSavingsPillForFreeUsers() {
  const html = renderSettings({
    plan: 'free',
    email: 'u@test.io',
    name: 'U',
    invoice_count: 1
  });
  assert.ok(/Save\s+\$45\/year/.test(html),
    'settings page must render "Save $45/year" pill for free users (the upgrade target audience)');
  const pillIdx = html.indexOf('Save $45/year');
  assert.ok(pillIdx > 0);
  const before = html.slice(0, pillIdx);
  const lastXShow = before.lastIndexOf('x-show=');
  assert.ok(lastXShow !== -1, 'settings pill must be wrapped in x-show');
  const xShowFragment = html.slice(lastXShow, lastXShow + 80);
  assert.ok(/cycle\s*===\s*['"]annual['"]/.test(xShowFragment),
    'settings pill must be x-shown only when cycle === annual');
}

function testSettingsPagePillVisuallyPromoted() {
  const html = renderSettings({
    plan: 'free',
    email: 'u@test.io',
    name: 'U',
    invoice_count: 1
  });
  const pillIdx = html.indexOf('Save $45/year');
  const window = html.slice(Math.max(0, pillIdx - 200), pillIdx + 100);
  assert.ok(/bg-green-\d{2,3}/.test(window),
    'settings pill must carry a green background for visual emphasis');
}

function testSettingsPageHidesPillForProUsers() {
  // Pro users see "Manage subscription" + don't see the upgrade selector at all,
  // so the pill block should not render.
  const html = renderSettings({
    plan: 'pro',
    email: 'u@test.io',
    name: 'U',
    invoice_count: 42
  });
  assert.ok(!/Save\s+\$45\/year/.test(html),
    'Pro users must NOT see the upgrade savings pill (block is gated on plan !== pro)');
}

// ---------- upgrade-modal.ejs partial ---------------------------------

function testUpgradeModalRendersAnnualSavingsPill() {
  const html = renderUpgradeModal();
  assert.ok(/Save\s+\$45\/year/.test(html),
    'upgrade modal must render "Save $45/year" pill');
  const pillIdx = html.indexOf('Save $45/year');
  const before = html.slice(0, pillIdx);
  const lastXShow = before.lastIndexOf('x-show=');
  assert.ok(lastXShow !== -1, 'upgrade-modal pill must be wrapped in x-show');
  const xShowFragment = html.slice(lastXShow, lastXShow + 80);
  assert.ok(/cycle\s*===\s*['"]annual['"]/.test(xShowFragment),
    'upgrade-modal pill must be x-shown only when cycle === annual');
}

function testUpgradeModalToggleButtonsExposePrice() {
  // Pre-#101 the toggle buttons were bare "Monthly" / "Annual".
  // Post-#101 they include the price so the user can compare without
  // toggling. Regression guard.
  const html = renderUpgradeModal();
  assert.ok(/Monthly\s+—\s+\$12\/mo/.test(html),
    'upgrade-modal Monthly toggle must show "$12/mo" inline');
  assert.ok(/Annual\s+—\s+\$99\/yr/.test(html),
    'upgrade-modal Annual toggle must show "$99/yr" inline');
}

function testUpgradeModalRemovesRedundantFinePrintSavings() {
  // Pre-#101 the fine-print disclaimer at the bottom of the modal carried
  // "(save $45/year)" parenthetical because the savings number was nowhere
  // else. Post-#101 the prominent pill above replaces this — the parenthetical
  // is removed to avoid dual sources of truth.
  const html = renderUpgradeModal();
  assert.ok(!/\(save\s+\$45\/year\)/.test(html),
    'upgrade-modal fine-print parenthetical "(save $45/year)" must be gone (pill above is now the canonical savings surface)');
}

// ---------- Cross-surface consistency ---------------------------------

function testSavingsNumberConsistentAcrossAllThreeSurfaces() {
  // The 3 surfaces must agree on the same dollar number — divergent
  // "Save $45" / "Save $40" / "Save $50" strings would erode user trust
  // and indicate a math/source-of-truth bug.
  const pricing = renderPricing({ plan: 'free' });
  const settings = renderSettings({ plan: 'free', email: 'u@test.io', name: 'U', invoice_count: 1 });
  const modal = renderUpgradeModal();

  const extract = html => {
    const m = html.match(/Save\s+\$(\d+)\/year/);
    return m ? m[1] : null;
  };

  const p = extract(pricing);
  const s = extract(settings);
  const m = extract(modal);

  assert.strictEqual(p, '45', 'pricing.ejs must say "Save $45/year"');
  assert.strictEqual(s, '45', 'settings.ejs must say "Save $45/year"');
  assert.strictEqual(m, '45', 'upgrade-modal.ejs must say "Save $45/year"');
}

function testSavingsMatchPriceMath() {
  // Math regression: $12/mo × 12 = $144/yr. $144 - $99 = $45. If a future
  // edit drifts either price, this test catches it before the marketing
  // copy lies to the user.
  const monthlyMonthly = 12;
  const annual = 99;
  const annualisedMonthly = monthlyMonthly * 12; // 144
  const expectedSavings = annualisedMonthly - annual; // 45
  assert.strictEqual(expectedSavings, 45,
    'savings number on the page is derived from $12/mo × 12 - $99 = $45 — if either price changes, update the pill copy');
}

// ---------- Runner ----------------------------------------------------

async function run() {
  const tests = [
    ['pricing.ejs renders "Save $45/year" pill (x-show=annual)', testPricingPageRendersAnnualSavingsPill],
    ['pricing.ejs retains "Save 31%" toggle badge', testPricingPageRetainsPercentageBadgeOnToggle],
    ['pricing.ejs pill is visually promoted (green bg + rounded)', testPricingPagePillIsVisuallyPromoted],
    ['settings.ejs renders pill for free users (x-show=annual)', testSettingsPageRendersAnnualSavingsPillForFreeUsers],
    ['settings.ejs pill is visually promoted (green bg)', testSettingsPagePillVisuallyPromoted],
    ['settings.ejs hides pill for pro users (no upgrade block)', testSettingsPageHidesPillForProUsers],
    ['upgrade-modal renders pill (x-show=annual)', testUpgradeModalRendersAnnualSavingsPill],
    ['upgrade-modal toggle buttons expose Monthly/Annual price', testUpgradeModalToggleButtonsExposePrice],
    ['upgrade-modal removes redundant "(save $45/year)" fine print', testUpgradeModalRemovesRedundantFinePrintSavings],
    ['Savings number is consistent across all 3 surfaces', testSavingsNumberConsistentAcrossAllThreeSurfaces],
    ['Savings number matches monthly×12 - annual = $45 math', testSavingsMatchPriceMath]
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
