'use strict';

/*
 * Seed-invoice-hint one-tap "Turn this into a real invoice" CTA tests.
 *
 * Primary Objective (PLAN.md): maximize signup → first-sent-invoice activation.
 * Milestone 2 gap: a seed-only dashboard cohort has to click into the seed
 * invoice, find the "Duplicate for a new client" button on `/invoices/:id`,
 * and click through — two clicks and a page load between "I want to start a
 * real invoice" and "the /edit form is ready to fill in." This ship collapses
 * that path to one tap on the dashboard's amber `seed-invoice-hint` block by
 * embedding a POST form that fires `/invoices/:seedId/duplicate` with
 * `client_scope=new_client` (existing route). The user lands directly in the
 * edit form with the seed's items/notes copied and the client fields blank.
 *
 * Test surface:
 *   - The CTA form renders inside `seed-invoice-hint` when the invoice list
 *     is a single seed.
 *   - The form's action points at `/invoices/<seed.id>/duplicate`, uses
 *     method="POST", carries the CSRF hidden field, and carries the
 *     `client_scope=new_client` hidden field so the existing route's
 *     "blank the client fields" branch is taken.
 *   - The CTA is absent when the user has any non-seed invoice (the hint
 *     block itself already hides in that case — belt + braces).
 *   - The CTA is absent on the empty-state / zero-invoice branch.
 *
 * Run: NODE_ENV=test node tests/seed-invoice-hint-cta.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');

const dashboardTplPath = path.join(__dirname, '..', 'views', 'dashboard.ejs');
const dashboardTpl = fs.readFileSync(dashboardTplPath, 'utf8');

function renderDashboard(locals) {
  return ejs.render(dashboardTpl, {
    title: 'Dashboard',
    flash: null,
    days_left_in_trial: 0,
    csrfToken: 'TEST_CSRF_TOKEN_123',
    invoices: [],
    user: { plan: 'free', invoice_count: 0, subscription_status: null },
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

function makeSeed(over) {
  return {
    id: 7,
    invoice_number: 'INV-2026-0001',
    client_name: 'Sample Client (edit this)',
    total: '300.00',
    issued_date: new Date(),
    status: 'draft',
    is_seed: true,
    ...over
  };
}

function makeReal(over) {
  return {
    id: 42,
    invoice_number: 'INV-2026-0002',
    client_name: 'Real Client LLC',
    total: '500.00',
    issued_date: new Date(),
    status: 'sent',
    is_seed: false,
    ...over
  };
}

function extractHintBlock(html) {
  const idx = html.indexOf('data-testid="seed-invoice-hint"');
  assert.ok(idx >= 0, 'seed-invoice-hint anchor missing');
  // Walk back to the opening <div, then forward until the matching </div>.
  const openTagStart = html.lastIndexOf('<div', idx);
  assert.ok(openTagStart >= 0, 'could not locate opening <div for seed hint');
  // Simple depth walk until balanced. </div> is unambiguous inside since we
  // don't embed <div>s… but the hint block DOES contain nested divs now, so
  // count opens/closes.
  let depth = 0;
  let i = openTagStart;
  while (i < html.length) {
    const nextOpen = html.indexOf('<div', i + 1);
    const nextClose = html.indexOf('</div>', i + 1);
    if (nextClose === -1) break;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      i = nextOpen;
    } else {
      if (depth === 0) return html.slice(openTagStart, nextClose + '</div>'.length);
      depth--;
      i = nextClose;
    }
  }
  throw new Error('seed-invoice-hint block never closed');
}

// ---------- Tests ----------------------------------------------------------

function testCtaRendersOnSeedOnlyList() {
  const html = renderDashboard({ invoices: [makeSeed({ id: 7 })] });
  assert.ok(html.includes('data-testid="seed-invoice-hint"'),
    'baseline: seed-invoice-hint block renders on a seed-only list');
  assert.ok(html.includes('data-testid="seed-invoice-hint-duplicate-cta"'),
    'CTA button must render inside the hint block');
  assert.ok(html.includes('data-testid="seed-invoice-hint-duplicate-form"'),
    'CTA form must render inside the hint block');
}

function testCtaFormPointsAtSeedDuplicateRoute() {
  const html = renderDashboard({ invoices: [makeSeed({ id: 7 })] });
  const hintBlock = extractHintBlock(html);
  const formMatch = hintBlock.match(/<form[^>]+data-testid="seed-invoice-hint-duplicate-form"[^>]*>/);
  assert.ok(formMatch, 'CTA form tag must appear inside the hint block');
  assert.ok(/action="\/invoices\/7\/duplicate"/.test(formMatch[0]),
    'form action must be /invoices/<seedId>/duplicate — got: ' + formMatch[0]);
  assert.ok(/method="POST"/i.test(formMatch[0]),
    'form method must be POST (mutating action)');
}

function testCtaFormCarriesClientScopeNewClient() {
  const html = renderDashboard({ invoices: [makeSeed({ id: 7 })] });
  const hintBlock = extractHintBlock(html);
  assert.ok(/name="client_scope"[^>]*value="new_client"/.test(hintBlock)
        || /value="new_client"[^>]*name="client_scope"/.test(hintBlock),
    'CTA form must carry hidden client_scope=new_client so the duplicate route blanks the client fields — this is the whole point of the one-tap');
}

function testCtaFormCarriesCsrfToken() {
  const html = renderDashboard({ invoices: [makeSeed({ id: 7 })] });
  const hintBlock = extractHintBlock(html);
  assert.ok(/name="_csrf"[^>]*value="TEST_CSRF_TOKEN_123"/.test(hintBlock)
        || /value="TEST_CSRF_TOKEN_123"[^>]*name="_csrf"/.test(hintBlock),
    'CTA form must include the CSRF token hidden field, or CSRF middleware will 403');
}

function testCtaAbsentWhenRealInvoicePresent() {
  const html = renderDashboard({ invoices: [makeSeed(), makeReal()] });
  assert.ok(!html.includes('data-testid="seed-invoice-hint"'),
    'baseline: hint block is hidden once a real invoice exists');
  assert.ok(!html.includes('data-testid="seed-invoice-hint-duplicate-cta"'),
    'CTA button must not render when a real invoice already exists');
}

function testCtaAbsentOnEmptyInvoiceList() {
  const html = renderDashboard({ invoices: [] });
  assert.ok(!html.includes('data-testid="seed-invoice-hint-duplicate-cta"'),
    'CTA must not render on the zero-invoice empty-state branch (no seed to duplicate)');
}

function testCtaUsesActualSeedId() {
  // If two seed shapes exist (theoretically), the CTA must pick the seed's
  // own id, not a hardcoded 1. Pin it against a non-default id.
  const html = renderDashboard({ invoices: [makeSeed({ id: 91234 })] });
  const hintBlock = extractHintBlock(html);
  assert.ok(/action="\/invoices\/91234\/duplicate"/.test(hintBlock),
    'CTA action URL must be built from the seed row.id, not hardcoded');
}

function testCtaCopyReinforcesActivationIntent() {
  const html = renderDashboard({ invoices: [makeSeed()] });
  const hintBlock = extractHintBlock(html);
  assert.ok(/Turn this into a real invoice/i.test(hintBlock),
    'CTA button copy must read "Turn this into a real invoice" (activation-anchored copy, not generic "Duplicate")');
  assert.ok(/one tap|blank|fresh draft|ready to fill/i.test(hintBlock),
    'hint copy should acknowledge the new one-tap flow (client fields blank / fresh draft)');
}

// ---------- Runner ---------------------------------------------------------

async function run() {
  const tests = [
    ['CTA renders on a seed-only invoice list', testCtaRendersOnSeedOnlyList],
    ['CTA form action targets /invoices/<seedId>/duplicate (POST)', testCtaFormPointsAtSeedDuplicateRoute],
    ['CTA form carries client_scope=new_client (blanks client fields)', testCtaFormCarriesClientScopeNewClient],
    ['CTA form carries the _csrf hidden field (avoids 403 on submit)', testCtaFormCarriesCsrfToken],
    ['CTA is absent when a real invoice already exists', testCtaAbsentWhenRealInvoicePresent],
    ['CTA is absent on empty invoice list (no seed to duplicate)', testCtaAbsentOnEmptyInvoiceList],
    ['CTA action URL is built from the seed row.id (not hardcoded)', testCtaUsesActualSeedId],
    ['CTA copy reinforces activation intent ("Turn this into a real invoice")', testCtaCopyReinforcesActivationIntent]
  ];

  let pass = 0;
  let fail = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log('  ok  ' + name);
      pass++;
    } catch (err) {
      console.error('  FAIL ' + name);
      console.error(err && err.stack ? err.stack : err);
      fail++;
    }
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail > 0) process.exit(1);
}

run().catch(function (err) { console.error(err); process.exit(1); });
