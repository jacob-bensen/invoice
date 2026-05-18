'use strict';

/*
 * Public /i/<token> "Save as PDF" download button tests.
 *
 * The freelancer's share link is the activation funnel's last-mile artifact —
 * a client opens it, sees the invoice, and (today, before this ship) has no
 * clean way to archive it. window.print() works but the rendered PDF is
 * littered with marketing chrome (the "X sent you an invoice" header, the
 * Pay-now CTA card, the "How to pay" instructions, the payment-claim widget,
 * the powered-by + signup-CTA attribution). This ship adds a Save-as-PDF
 * button + a media-print stylesheet that hides every workflow surface from
 * the printed artifact, leaving just the invoice card on a clean letter-size
 * sheet.
 *
 * Covers:
 *   - The action bar + button render with the right testids + onclick + aria.
 *   - The print stylesheet block is inline (no external request, so a
 *     network-isolated print path always works).
 *   - The stylesheet hides each piece of marketing chrome AND the print bar
 *     itself (so the button doesn't end up on the PDF).
 *   - @page is letter-sized with reasonable margins.
 *   - The action bar carries print:hidden as a Tailwind belt-and-braces.
 *
 * Run: NODE_ENV=test node tests/public-share-pdf-download.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');

const VIEWS = path.join(__dirname, '..', 'views');

function buildSampleInvoiceRow(overrides) {
  return Object.assign({
    id: 5,
    invoice_number: 'INV-2026-0042',
    client_name: 'Acme Co.',
    client_email: 'pay@acme.com',
    client_address: '',
    items: [
      { description: 'Design consultation', quantity: 4, unit_price: 75 }
    ],
    subtotal: 300,
    tax_rate: 0,
    tax_amount: 0,
    total: 300,
    notes: null,
    status: 'sent',
    issued_date: new Date('2026-05-01'),
    due_date: new Date('2026-05-31'),
    payment_link_url: 'https://buy.stripe.com/test_link',
    public_token: 'cafef00ddeadbeef',
    owner_id: 11,
    owner_name: 'Jordan Pine',
    owner_email: 'jordan@example.com',
    owner_business_name: 'Pine Studio',
    owner_business_address: '123 Maple St',
    owner_business_email: 'hi@pinestudio.com',
    owner_business_phone: '555-0100',
    owner_plan: 'pro',
    owner_payment_instructions: null,
    view_count: 0,
    first_viewed_at: null,
    last_viewed_at: null,
    payment_claimed_at: null,
    payment_claim_method: null,
    payment_claim_reference: null
  }, overrides || {});
}

function renderPublic(invoiceRow, extras) {
  const tpl = path.join(VIEWS, 'invoice-public.ejs');
  return ejs.renderFile(tpl, Object.assign({
    invoice: invoiceRow,
    title: 'Invoice ' + invoiceRow.invoice_number,
    noindex: true,
    csrfToken: 'csrf-test-token'
  }, extras || {}));
}

// ---------- button surface -----------------------------------------------

async function testPrintBarRendersForFreeOwner() {
  const html = await renderPublic(buildSampleInvoiceRow({ owner_plan: 'free', payment_link_url: null }));
  assert.ok(html.includes('data-testid="public-print-bar"'),
    'public-print-bar container must render for a free-tier owner');
  assert.ok(html.includes('data-testid="public-print-button"'),
    'public-print-button must render for a free-tier owner');
}

async function testPrintBarRendersForProOwner() {
  const html = await renderPublic(buildSampleInvoiceRow({ owner_plan: 'pro' }));
  assert.ok(html.includes('data-testid="public-print-bar"'),
    'public-print-bar container must render for a Pro owner');
  assert.ok(html.includes('data-testid="public-print-button"'),
    'public-print-button must render for a Pro owner');
}

async function testPrintBarRendersForAgencyOwner() {
  const html = await renderPublic(buildSampleInvoiceRow({ owner_plan: 'agency' }));
  assert.ok(html.includes('data-testid="public-print-bar"'),
    'public-print-bar container must render for an Agency owner');
}

async function testPrintBarRendersOnPaidInvoice() {
  const html = await renderPublic(buildSampleInvoiceRow({ status: 'paid' }));
  assert.ok(html.includes('data-testid="public-print-button"'),
    'a paid invoice is exactly when a client most wants to archive — button must still render');
}

async function testPrintButtonTriggersWindowPrint() {
  const html = await renderPublic(buildSampleInvoiceRow());
  const btnMatch = html.match(/<button[^>]*data-testid="public-print-button"[^>]*>/);
  assert.ok(btnMatch, 'must find the print button element');
  assert.ok(/onclick="window\.print\(\)"/.test(btnMatch[0]),
    'button must trigger window.print() inline so it works with zero JS framework dependency');
  assert.ok(/type="button"/.test(btnMatch[0]),
    'must be type=button so it never accidentally submits a parent form');
  assert.ok(/aria-label="[^"]*PDF[^"]*"/i.test(btnMatch[0]),
    'must carry an aria-label that mentions PDF for screen-reader users');
}

async function testPrintBarCarriesPrintHiddenTailwindClass() {
  const html = await renderPublic(buildSampleInvoiceRow());
  const barMatch = html.match(/<div[^>]*data-testid="public-print-bar"[^>]*>/);
  assert.ok(barMatch, 'must find the print-bar container');
  assert.ok(/\bprint:hidden\b/.test(barMatch[0]),
    'print-bar must carry the Tailwind print:hidden utility as belt-and-braces against the @media-print rule');
}

// ---------- print stylesheet ---------------------------------------------

async function testPrintStylesheetIsInline() {
  const html = await renderPublic(buildSampleInvoiceRow());
  assert.ok(html.includes('data-testid="public-print-styles"'),
    'the print stylesheet block must be present + locatable via testid');
  assert.ok(/<style[^>]*data-testid="public-print-styles"[^>]*>[\s\S]*<\/style>/.test(html),
    'must be an inline <style> block — no external request so print works on isolated networks');
  assert.ok(/@media\s+print/.test(html),
    'must declare an @media print block');
}

async function testPrintStylesheetSetsLetterPageWithMargin() {
  const html = await renderPublic(buildSampleInvoiceRow());
  assert.ok(/@page\s*\{[^}]*size:\s*letter/i.test(html),
    'must set @page size: letter for US default; print drivers cope with A4 if needed');
  assert.ok(/@page\s*\{[^}]*margin:\s*0\.5in/i.test(html),
    'must declare a sensible default print margin (0.5in)');
}

async function testEveryMarketingChromeSurfaceCarriesPrintHidden() {
  // Each chrome element (header bar, pay-now CTA, payment instructions,
  // payment-claim widget, claimed panel, success banner, attribution, the
  // print bar itself) must carry Tailwind's `print:hidden` utility so it
  // drops out of the printed PDF. We assert by locating the opening tag of
  // each element and checking the class list. Using `print:hidden` rather
  // than testid-based CSS selectors keeps the inline stylesheet small AND
  // sidesteps a substring-collision footgun (other tests use
  // body.includes('data-testid="X"') as a presence check; a CSS selector
  // that contained the same string would silently break them).
  const html = await renderPublic(buildSampleInvoiceRow({ payment_claimed_at: null }));
  const chromeContainers = [
    { match: /<header\s+class="([^"]*)"/,
      label: 'top header bar (contains the powered-by link)' },
    { match: /<div[^>]*class="([^"]*)"[^>]*data-testid="public-print-bar"/,
      label: 'print action bar (must not print itself)' },
    { match: /<div[^>]*class="([^"]*)"[^>]*data-testid="public-pay-cta"/,
      label: 'pay-now CTA card' },
    { match: /<details[^>]*class="([^"]*)"[^>]*data-testid="public-payment-claim"/,
      label: 'payment-claim <details> widget' },
    { match: /<p[^>]*class="([^"]*)"[^>]*data-testid="public-attribution"/,
      label: 'footer attribution paragraph' }
  ];
  for (const { match, label } of chromeContainers) {
    const m = html.match(match);
    assert.ok(m, 'must locate the ' + label + ' in the rendered HTML');
    assert.ok(/\bprint:hidden\b/.test(m[1]),
      'the ' + label + ' must carry Tailwind print:hidden so it drops out of the PDF');
  }
}

async function testPaymentInstructionsCarryPrintHidden() {
  // Payment instructions only render when the freelancer has filled them in
  // — separate render path requires a separate fixture.
  const html = await renderPublic(buildSampleInvoiceRow({
    owner_payment_instructions: 'Venmo: @pinestudio\nZelle: hi@pinestudio.com'
  }));
  const m = html.match(/<div[^>]*class="([^"]*)"[^>]*data-testid="public-payment-instructions"/);
  assert.ok(m, 'must render the "How to pay" block when owner_payment_instructions is set');
  assert.ok(/\bprint:hidden\b/.test(m[1]),
    'the "How to pay" block must carry print:hidden — workflow surface, not artifact content');
}

async function testPaymentClaimedPanelCarriesPrintHidden() {
  const html = await renderPublic(buildSampleInvoiceRow({
    status: 'sent',
    payment_claimed_at: new Date('2026-05-10T12:00:00Z'),
    payment_claim_method: 'venmo'
  }));
  const m = html.match(/<div[^>]*class="([^"]*)"[^>]*data-testid="public-payment-claimed-panel"/);
  assert.ok(m, 'must render the claimed-panel when payment_claimed_at is set on an unpaid invoice');
  assert.ok(/\bprint:hidden\b/.test(m[1]),
    'the post-claim confirmation panel must carry print:hidden');
}

async function testPaymentClaimSuccessBannerCarriesPrintHidden() {
  const html = await renderPublic(buildSampleInvoiceRow(), { justClaimed: true });
  const m = html.match(/<div[^>]*class="([^"]*)"[^>]*data-testid="payment-claim-success"/);
  assert.ok(m, 'must render the success banner when justClaimed is truthy (?claimed=1 flow)');
  assert.ok(/\bprint:hidden\b/.test(m[1]),
    'the success banner is a transient workflow notice and must carry print:hidden');
}

async function testPrintStylesheetCleansInvoiceCardChrome() {
  const html = await renderPublic(buildSampleInvoiceRow());
  const styleMatch = html.match(/<style[^>]*data-testid="public-print-styles"[^>]*>([\s\S]*?)<\/style>/);
  const css = styleMatch[1];
  assert.ok(/\.print-invoice-wrap/.test(css),
    'must target the public-invoice wrapper via .print-invoice-wrap to flatten its padding for print');
  assert.ok(/\.print-invoice-card/.test(css),
    'must target the invoice card via .print-invoice-card to strip border + shadow for clean print');
  assert.ok(/border:\s*none\s*!important/.test(css),
    'invoice card must lose its border in print');
  assert.ok(/box-shadow:\s*none\s*!important/.test(css),
    'invoice card must lose its drop shadow in print');

  // The card and wrap classes must actually be attached to the elements that
  // need them — otherwise the CSS has nothing to target.
  assert.ok(/<div[^>]*class="[^"]*\bprint-invoice-wrap\b[^"]*"[^>]*data-testid="public-invoice"/.test(html),
    'the public-invoice container must carry .print-invoice-wrap');
  assert.ok(/<div[^>]*class="[^"]*\bprint-invoice-card\b[^"]*"/.test(html),
    'the invoice card must carry .print-invoice-card');
}

async function testPrintStylesheetForcesWhiteBackground() {
  const html = await renderPublic(buildSampleInvoiceRow());
  const styleMatch = html.match(/<style[^>]*data-testid="public-print-styles"[^>]*>([\s\S]*?)<\/style>/);
  const css = styleMatch[1];
  assert.ok(/background:\s*#ffffff\s*!important/i.test(css),
    'must force a white background so the gray-50 body color does not bleed into print margins');
  assert.ok(/print-color-adjust:\s*exact/.test(css),
    'must opt into exact print-color-adjust so brand colors / borders survive the print pipeline');
}

// ---------- coexistence with existing surfaces ---------------------------

async function testPrintBarDoesNotBreakExistingPublicInvoiceSurface() {
  // Smoke-check that the surrounding surfaces still render around the new
  // print bar — guards against an accidental tag mis-nesting that would
  // visually break the page.
  const html = await renderPublic(buildSampleInvoiceRow());
  assert.ok(html.includes('data-testid="public-invoice"'),
    'the wrapping public-invoice container still renders');
  assert.ok(html.includes('data-testid="public-pay-cta"'),
    'the pay-now CTA still renders next to the print bar for Pro owners');
  assert.ok(html.includes('data-testid="public-attribution"'),
    'the footer attribution still renders');
  assert.ok(html.includes('INV-2026-0042'),
    'the invoice number still renders');
  assert.ok(html.includes('$300.00'),
    'the total still renders');
}

async function testPrintBarRendersBeforePayNowCta() {
  // The Save-as-PDF action belongs at the top of the page so it's discoverable
  // without scrolling. Asserting DOM order against the markup guards against
  // a future refactor accidentally pushing it below the fold.
  const html = await renderPublic(buildSampleInvoiceRow());
  const barIdx = html.indexOf('data-testid="public-print-bar"');
  const ctaIdx = html.indexOf('data-testid="public-pay-cta"');
  // lastIndexOf skips the .print-invoice-card mention inside the @media-print
  // stylesheet and lands on the actual class-attribute occurrence on the card.
  const cardIdx = html.lastIndexOf('print-invoice-card');
  assert.ok(barIdx > 0 && ctaIdx > 0 && cardIdx > 0,
    'all three landmarks must appear in the rendered HTML');
  assert.ok(barIdx < ctaIdx,
    'print bar must render before the pay-now CTA');
  assert.ok(barIdx < cardIdx,
    'print bar must render before the invoice card');
}

// ---------- runner -------------------------------------------------------

async function run() {
  const tests = [
    ['button: renders for free-tier owner', testPrintBarRendersForFreeOwner],
    ['button: renders for Pro owner', testPrintBarRendersForProOwner],
    ['button: renders for Agency owner', testPrintBarRendersForAgencyOwner],
    ['button: renders on paid invoice (filing artifact still useful)', testPrintBarRendersOnPaidInvoice],
    ['button: onclick=window.print(), type=button, aria-label mentions PDF', testPrintButtonTriggersWindowPrint],
    ['action bar: carries Tailwind print:hidden as belt-and-braces', testPrintBarCarriesPrintHiddenTailwindClass],
    ['stylesheet: inline <style data-testid="public-print-styles"> with @media print', testPrintStylesheetIsInline],
    ['stylesheet: @page sets letter size + 0.5in margin', testPrintStylesheetSetsLetterPageWithMargin],
    ['chrome: every marketing surface (header, CTA, claim, attribution, print bar) carries Tailwind print:hidden', testEveryMarketingChromeSurfaceCarriesPrintHidden],
    ['chrome: payment-instructions block carries print:hidden when rendered', testPaymentInstructionsCarryPrintHidden],
    ['chrome: payment-claimed panel carries print:hidden when rendered', testPaymentClaimedPanelCarriesPrintHidden],
    ['chrome: payment-claim success banner carries print:hidden when rendered', testPaymentClaimSuccessBannerCarriesPrintHidden],
    ['stylesheet: strips invoice card border/shadow/padding for clean print', testPrintStylesheetCleansInvoiceCardChrome],
    ['stylesheet: forces white background + exact print-color-adjust', testPrintStylesheetForcesWhiteBackground],
    ['coexistence: pay-now CTA, attribution, invoice number still render', testPrintBarDoesNotBreakExistingPublicInvoiceSurface],
    ['DOM order: print bar renders before pay-now CTA and invoice card', testPrintBarRendersBeforePayNowCta]
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
