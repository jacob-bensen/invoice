'use strict';

/*
 * Dashboard "Copy pay link" icon button tests (INTERNAL_TODO #91).
 *
 * Behaviour under test (views/dashboard.ejs invoice table):
 *  - Pro and Agency users see an extra "Actions" column on the invoice table
 *    (a 6th <th>); Free users see only the 5-column table they always saw.
 *  - Per row, a "Copy link" icon button renders ONLY if the invoice has a
 *    payment_link_url AND the user is on a paid plan.
 *  - The button is wired through Alpine: clicking it calls
 *    navigator.clipboard.writeText(<url>) and toggles a "Copied" affordance
 *    for ~2 seconds, then snaps back.
 *  - Clicks on the button MUST NOT bubble up to the row's onclick navigation
 *    (which would whisk the user off to the invoice view immediately, hiding
 *    the "Copied" affordance and producing an unrelated page transition).
 *  - The actions column and its cells carry print:hidden so they don't bleed
 *    into PDF print output.
 *  - Free users must NEVER see the column (#91 is explicitly a Pro feature
 *    advertised to nudge upgrade; never expose it to free users).
 *  - The button is keyboard-accessible (real <button>, not a div) and carries
 *    an :aria-label so screen readers announce both states.
 *
 * Run: NODE_ENV=test node tests/dashboard-copy-pay-link.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

const dashboardTplPath = path.join(__dirname, '..', 'views', 'dashboard.ejs');
const dashboardTpl = fs.readFileSync(dashboardTplPath, 'utf8');

function makeInvoice(overrides = {}) {
  return {
    id: 42,
    invoice_number: 'INV-0001',
    client_name: 'Acme Corp',
    issued_date: '2026-04-01',
    total: '120.00',
    status: 'sent',
    payment_link_url: 'https://buy.stripe.com/test_abc123',
    ...overrides
  };
}

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

// ---------- Pro user, payment link present -----------------------------

function testProUserSeesCopyButtonOnRowWithLink() {
  const inv = makeInvoice();
  const html = renderDashboard({
    user: { plan: 'pro', invoice_count: 4, subscription_status: 'active' },
    invoices: [inv]
  });
  assert.ok(
    html.includes(`data-testid="copy-pay-link-${inv.id}"`),
    'Pro user with a row that has payment_link_url must see the Copy link button'
  );
  // Defence-in-depth: payment_link_url MUST live in a data-attribute and be
  // read at click-time via dataset, NOT interpolated directly into the JS
  // expression in the @click attribute. Interpolating into a JS expression
  // means a hostile DB write (or a future code path that lets a user set
  // payment_link_url) would create stored XSS — `'+alert(1)+'` would break
  // out of the JS string literal in the @click handler. The data-attribute
  // pattern keeps user-controlled bytes out of attribute-as-JS evaluation.
  assert.ok(
    html.includes(`data-pay-link-url="${inv.payment_link_url}"`),
    'payment_link_url must be stored in a data-attribute (defence-in-depth XSS guard)'
  );
  assert.ok(
    html.includes('navigator.clipboard.writeText($event.currentTarget.dataset.payLinkUrl)'),
    'Click handler must read the URL from dataset, not from a directly-interpolated string'
  );
  assert.ok(
    !/navigator\.clipboard\.writeText\('https?:/.test(html),
    'No call site may interpolate the URL directly into a JS string literal'
  );
  assert.ok(
    /<th[^>]*print:hidden[^>]*>Pay link<\/th>/i.test(html),
    'Pro user must see an extra "Pay link" <th> for the actions column (with print:hidden)'
  );
}

function testAgencyUserSeesCopyButton() {
  // Agency is the same Pro tier surface for invoice features — the button
  // must be visible to agency users too.
  const inv = makeInvoice({ id: 7 });
  const html = renderDashboard({
    user: { plan: 'agency', invoice_count: 99, subscription_status: 'active' },
    invoices: [inv]
  });
  assert.ok(
    html.includes('data-testid="copy-pay-link-7"'),
    'Agency users must see the Copy link button (parity with Pro)'
  );
}

function testCopiedAffordanceIsAlpineDriven() {
  const html = renderDashboard({
    user: { plan: 'pro', invoice_count: 4, subscription_status: 'active' },
    invoices: [makeInvoice()]
  });
  // The Alpine state must live on a small wrapper around each button so two
  // rows each get their own independent { copied } scope (not a shared bool
  // across all rows that would flash "Copied" on every button at once).
  assert.ok(/x-data="\{ copied: false \}"/.test(html),
    'Copy button must wrap each row in its own Alpine x-data scope');
  assert.ok(/x-show="copied"/.test(html), 'Copied state must drive the success affordance');
  assert.ok(/x-show="!copied"/.test(html), 'Default state (!copied) must drive the default icon');
}

function testCopyButtonHasIndependentScopePerRow() {
  // Two rows, two buttons, two independent Alpine scopes — clicking row A
  // must not flash "Copied" on row B.
  const html = renderDashboard({
    user: { plan: 'pro', invoice_count: 4, subscription_status: 'active' },
    invoices: [
      makeInvoice({ id: 1, invoice_number: 'INV-0001', payment_link_url: 'https://buy.stripe.com/a' }),
      makeInvoice({ id: 2, invoice_number: 'INV-0002', payment_link_url: 'https://buy.stripe.com/b' })
    ]
  });
  const xDataMatches = html.match(/x-data="\{ copied: false \}"/g) || [];
  assert.strictEqual(xDataMatches.length, 2,
    'Each invoice row must get its own x-data scope (two rows → two scopes)');
  assert.ok(html.includes('data-testid="copy-pay-link-1"'));
  assert.ok(html.includes('data-testid="copy-pay-link-2"'));
  // Each row's URL lives in its own data-attribute (read at click via dataset)
  assert.ok(html.includes('data-pay-link-url="https://buy.stripe.com/a"'));
  assert.ok(html.includes('data-pay-link-url="https://buy.stripe.com/b"'));
}

function testRowClickPropagationIsStopped() {
  // Critical UX: the row navigates on click. If the button click bubbles up,
  // the user gets whisked away before the "Copied" affordance shows AND
  // before the clipboard write resolves on slower browsers.
  const html = renderDashboard({
    user: { plan: 'pro', invoice_count: 4, subscription_status: 'active' },
    invoices: [makeInvoice()]
  });
  // Both stop-propagation surfaces must be present: the button's @click.stop
  // (Alpine modifier — preferred) and the wrapping <td>'s onclick guard
  // (defence-in-depth in case Alpine is degraded / not yet hydrated).
  assert.ok(/@click\.stop=/.test(html),
    'Copy button must use @click.stop to prevent row navigation');
  assert.ok(/onclick="event\.stopPropagation\(\)"/.test(html),
    'Wrapping <td> must also stop propagation as a no-JS-Alpine fallback');
}

// ---------- Pro user, NO payment link on row ---------------------------

function testProUserWithoutLinkShowsEmptyActionsCell() {
  // A Pro user can still have draft invoices that haven't been "Mark as Sent"
  // yet — those rows have no payment_link_url. The button must NOT render,
  // but the column structure must stay (empty cell, not a missing <td> that
  // would shift the row layout).
  const inv = makeInvoice({ id: 99, status: 'draft', payment_link_url: null });
  const html = renderDashboard({
    user: { plan: 'pro', invoice_count: 4, subscription_status: 'active' },
    invoices: [inv]
  });
  assert.ok(!/data-testid="copy-pay-link-99"/.test(html),
    'A row without payment_link_url must NOT render the Copy button');
  // Header still present (the column is rendered for the user even if rows
  // are empty), so the row should still have its <td onclick=stop> cell —
  // count <td> cells in the row.
  assert.ok(html.includes('onclick="event.stopPropagation()"'),
    'Empty actions cell must still render with the propagation guard');
}

// ---------- Free user, NEVER see the column ----------------------------

function testFreeUserDoesNotSeeColumnOrButton() {
  // Even if a free invoice somehow has a payment_link_url stamped on it
  // (legacy data, plan-downgrade), free users must NOT see the Copy button —
  // the feature is a Pro nudge, not a Free affordance.
  const inv = makeInvoice({ id: 5 });
  const html = renderDashboard({
    user: { plan: 'free', invoice_count: 1, subscription_status: null },
    invoices: [inv]
  });
  assert.ok(!/data-testid="copy-pay-link-5"/.test(html),
    'Free user must NEVER see the Copy link button');
  // No empty-header <th> for free users — table is the original 5-column layout.
  // Count the <th> in the table head: must be exactly 5 (Invoice/Client/Date/Amount/Status).
  const theadMatch = html.match(/<thead[\s\S]*?<\/thead>/);
  assert.ok(theadMatch, 'Dashboard must render a <thead>');
  const ths = theadMatch[0].match(/<th[\s>]/g) || [];
  assert.strictEqual(ths.length, 5,
    'Free user table must have exactly 5 columns; Pro/Agency user adds a 6th');
}

function testProUserHeaderHasSixColumns() {
  const html = renderDashboard({
    user: { plan: 'pro', invoice_count: 4, subscription_status: 'active' },
    invoices: [makeInvoice()]
  });
  const theadMatch = html.match(/<thead[\s\S]*?<\/thead>/);
  assert.ok(theadMatch);
  const ths = theadMatch[0].match(/<th[\s>]/g) || [];
  assert.strictEqual(ths.length, 6,
    'Pro user table must add a 6th column for actions');
}

// ---------- Print + accessibility --------------------------------------

function testActionsColumnIsHiddenInPrint() {
  // Print preview / PDF export must not include the action column — clients
  // who receive a PDF should never see an internal "Copy link" affordance.
  const html = renderDashboard({
    user: { plan: 'pro', invoice_count: 4, subscription_status: 'active' },
    invoices: [makeInvoice()]
  });
  // The header <th> + the <td> cell both need print:hidden.
  const theadMatch = html.match(/<thead[\s\S]*?<\/thead>/)[0];
  assert.ok(/<th[^>]*print:hidden/i.test(theadMatch),
    'Actions <th> must carry print:hidden');
  // Find a row's actions <td> by anchoring on event.stopPropagation
  const tdMatch = html.match(/<td[^>]*print:hidden[^>]*onclick="event\.stopPropagation\(\)"/);
  assert.ok(tdMatch, 'Actions <td> must carry print:hidden');
}

function testCopyButtonIsAccessible() {
  const html = renderDashboard({
    user: { plan: 'pro', invoice_count: 4, subscription_status: 'active' },
    invoices: [makeInvoice()]
  });
  // Real <button type="button"> (not div+role), reactive aria-label tied to
  // the copied state, visible label text "Copy link".
  assert.ok(/<button[\s\S]*?type="button"[\s\S]*?data-testid="copy-pay-link-/.test(html),
    'Copy must be a real <button type="button">');
  assert.ok(/:aria-label="copied \?/.test(html),
    'aria-label must reflect the copied state for screen-reader users');
  assert.ok(/>\s*Copy link\s*</.test(html),
    'Default state must include the visible label "Copy link"');
}

// ---------- Empty-state interaction ------------------------------------

function testEmptyInvoiceListStillRendersForProUser() {
  // The actions column logic lives inside the table-render branch, which is
  // only reached when invoices.length > 0. The empty-state branch must not
  // crash for Pro users.
  const html = renderDashboard({
    user: { plan: 'pro', invoice_count: 0, subscription_status: 'active' },
    invoices: []
  });
  // Assert on the empty-state CTA which is stable across copy revisions.
  // The headline and supporting paragraph evolved during the 2026-04-27 PM-5
  // UX audit (was "No invoices yet" → now "Send your first invoice today");
  // the CTA "Create your first invoice" is the load-bearing element that has
  // remained constant since the empty state shipped.
  assert.ok(/Create your first invoice/.test(html),
    'Pro user with zero invoices must see the empty-state CTA, not a broken table');
  assert.ok(!/data-testid="copy-pay-link-/.test(html),
    'Empty state must not contain any Copy link buttons');
}

// ---------- Runner -----------------------------------------------------

async function run() {
  const tests = [
    ['Pro user with payment_link_url sees Copy link button', testProUserSeesCopyButtonOnRowWithLink],
    ['Agency user sees Copy link button (parity with Pro)', testAgencyUserSeesCopyButton],
    ['Copied affordance is Alpine-driven', testCopiedAffordanceIsAlpineDriven],
    ['Each row has independent x-data scope', testCopyButtonHasIndependentScopePerRow],
    ['Row click propagation is stopped on the button', testRowClickPropagationIsStopped],
    ['Pro user with no link shows empty cell, not button', testProUserWithoutLinkShowsEmptyActionsCell],
    ['Free user never sees the column or the button', testFreeUserDoesNotSeeColumnOrButton],
    ['Pro user header has 6 columns', testProUserHeaderHasSixColumns],
    ['Actions column is hidden in print', testActionsColumnIsHiddenInPrint],
    ['Copy button is keyboard + screen-reader accessible', testCopyButtonIsAccessible],
    ['Empty invoice list still renders cleanly for Pro user', testEmptyInvoiceListStillRendersForProUser]
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
