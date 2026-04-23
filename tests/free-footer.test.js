'use strict';

/*
 * Tests for the "Invoiced with QuickInvoice" free-plan attribution footer
 * rendered on the print/PDF view (INTERNAL_TODO #5). The footer:
 *   - must render for plan === 'free' users (passive acquisition touchpoint)
 *   - must NOT render for paid plans (solo/pro/agency) — tangible Pro benefit
 *   - must be styled for print (no @media print display:none so it survives PDF)
 *   - must carry the ?ref=pdf-footer attribution query string
 *
 * Run: node tests/free-footer.test.js
 */

const assert = require('assert');
const path = require('path');
const ejs = require('ejs');

const VIEWS = path.join(__dirname, '..', 'views');
const TEMPLATE = path.join(VIEWS, 'invoice-print.ejs');

const baseInvoice = {
  id: 1,
  invoice_number: 'INV-2026-0001',
  client_name: 'Client Co',
  client_email: 'c@example.com',
  client_address: '123 Main St',
  items: [{ description: 'Design work', quantity: 1, unit_price: '100.00' }],
  subtotal: '100.00',
  tax_rate: '0',
  tax_amount: '0',
  total: '100.00',
  status: 'sent',
  issued_date: '2026-04-23',
  due_date: null,
  notes: '',
  payment_link_url: null,
  payment_link_id: null
};

const baseUser = { id: 1, name: 'Freelancer', email: 'u@example.com' };

async function render(userPlan, overrides = {}) {
  return ejs.renderFile(TEMPLATE, {
    title: 't',
    invoice: { ...baseInvoice, ...(overrides.invoice || {}) },
    user: { ...baseUser, plan: userPlan, ...(overrides.user || {}) }
  }, { views: [VIEWS] });
}

async function testFooterRendersForFreeUser() {
  const html = await render('free');
  assert.ok(html.includes('Invoiced with'), 'free plan must show "Invoiced with" attribution');
  assert.ok(html.includes('QuickInvoice'), 'free plan must name the product');
  assert.ok(html.includes('quickinvoice.io/pricing?ref=pdf-footer'),
    'free plan must carry the ref=pdf-footer attribution URL');
  assert.ok(html.includes('class="free-footer"'),
    'footer wrapper uses the free-footer class for styling');
}

async function testFooterHiddenForProUser() {
  const html = await render('pro');
  assert.ok(!html.includes('Invoiced with'),
    'Pro plan must NOT show the QuickInvoice attribution (paid benefit)');
  assert.ok(!html.includes('ref=pdf-footer'),
    'Pro plan must NOT carry the ref=pdf-footer attribution link');
  assert.ok(!html.includes('class="free-footer"'),
    'Pro plan must not render the free-footer container');
}

async function testFooterHiddenForAgencyUser() {
  const html = await render('agency');
  assert.ok(!html.includes('Invoiced with'),
    'Agency plan must NOT show the attribution footer');
  assert.ok(!html.includes('ref=pdf-footer'));
}

async function testFooterHiddenForSoloUser() {
  const html = await render('solo');
  assert.ok(!html.includes('Invoiced with'),
    'Solo plan must NOT show the attribution footer');
  assert.ok(!html.includes('ref=pdf-footer'));
}

async function testFooterStyleIsPrintSafe() {
  // The CSS declaration must exist in the rendered stylesheet so the footer
  // styles come through on `window.print()` / Save-as-PDF. We also verify the
  // @media print block does NOT hide the footer (only `.print-actions` is
  // hidden for print).
  const html = await render('free');
  assert.ok(html.includes('.free-footer {'),
    'free-footer CSS rule must be present in the print stylesheet');

  const mediaPrintIdx = html.indexOf('@media print');
  assert.ok(mediaPrintIdx !== -1, 'expected @media print block for print styles');
  const mediaPrintBlock = html.slice(mediaPrintIdx, mediaPrintIdx + 400);
  assert.ok(!mediaPrintBlock.includes('.free-footer'),
    'footer must NOT be hidden inside @media print');
}

async function testFooterIsAttributionLinkNotButton() {
  // The footer must include a real anchor to the pricing page so click-through
  // works from any PDF viewer that preserves hyperlinks.
  const html = await render('free');
  assert.ok(html.includes('<a href="https://quickinvoice.io/pricing?ref=pdf-footer"'),
    'footer must include a clickable anchor to the pricing page');
}

async function testFooterCoexistsWithProPaymentLink() {
  // Regression guard: a Pro user with a Payment Link must see the pay section
  // and must NOT see the free-plan footer in the same document.
  const html = await render('pro', {
    invoice: {
      payment_link_url: 'https://buy.stripe.com/test_abc',
      payment_link_id: 'plink_abc'
    }
  });
  assert.ok(html.includes('Pay this invoice online'),
    'Pro Payment Link section must render');
  assert.ok(!html.includes('Invoiced with'),
    'Pro user must NOT render the attribution footer alongside the pay link');
}

async function run() {
  const tests = [
    ['footer renders for free user', testFooterRendersForFreeUser],
    ['footer hidden for pro user', testFooterHiddenForProUser],
    ['footer hidden for agency user', testFooterHiddenForAgencyUser],
    ['footer hidden for solo user', testFooterHiddenForSoloUser],
    ['footer style is print-safe', testFooterStyleIsPrintSafe],
    ['footer is a real anchor link', testFooterIsAttributionLinkNotButton],
    ['footer absent on Pro invoices with payment links', testFooterCoexistsWithProPaymentLink]
  ];

  let passed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ ${name}`);
      console.error(err);
      process.exitCode = 1;
    }
  }
  console.log(`\nfree-footer.test.js: ${passed}/${tests.length} passed`);
}

run();
