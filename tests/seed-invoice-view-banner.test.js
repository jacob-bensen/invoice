'use strict';

/*
 * Seed-invoice banner at the top of /invoices/:id (Milestone 2 — first
 * dashboard re-entry → first real invoice created).
 *
 * A brand-new user clicks the seed sample from the dashboard "👋 Take a
 * look at this sample invoice" hint and lands on /invoices/<id>. The
 * existing view's most-prominent CTA is "Mark as Sent" — a confusing
 * dead-end on a placeholder row whose client is "Sample Client (edit
 * this)". The banner reframes the page ("this is just a sample") and
 * surfaces the real next action — POST a real invoice via the 3-field
 * express form at /invoices/quick — above the action bar so the
 * next-real-action signal wins the visual hierarchy.
 *
 * The banner gates ONLY on invoice.is_seed (truthy). Status doesn't
 * matter: if a curious user marked the seed as sent or paid while
 * exploring, the banner is still the right next-action surface. We
 * suppress on falsy is_seed so real invoices never accidentally pick it
 * up if their is_seed column is missing/null/false.
 *
 * Run: NODE_ENV=test node tests/seed-invoice-view-banner.test.js
 */

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

const assert = require('assert');
const path = require('path');
const ejs = require('ejs');

const VIEWS = path.join(__dirname, '..', 'views');

function makeInvoice(overrides) {
  return Object.assign({
    id: 7,
    invoice_number: 'INV-2026-0001',
    status: 'draft',
    issued_date: new Date('2026-05-01'),
    due_date: new Date('2026-05-31'),
    client_name: 'Sample Client (edit this)',
    client_email: 'client@example.com',
    client_address: '',
    items: [{ description: 'Design consultation (4 hrs)', quantity: 4, unit_price: 75 }],
    subtotal: 300, tax_rate: 0, tax_amount: 0, total: 300,
    notes: 'Thanks for your business! Payment due within 30 days.',
    payment_link_url: null,
    is_seed: true
  }, overrides || {});
}

function renderView({ invoice, userPlan }) {
  return ejs.renderFile(path.join(VIEWS, 'invoice-view.ejs'), {
    title: 'Invoice',
    user: { plan: userPlan || 'free', email: 'me@example.com', name: 'Me', business_name: null },
    invoice: invoice || makeInvoice(),
    paymentMethods: ['card'],
    csrfToken: 'csrf-test-tkn',
    prefetchedShare: null,
    flash: null
  }, { views: [VIEWS] });
}

const BANNER_TESTID = 'data-testid="seed-invoice-view-banner"';
const BANNER_CTA_TESTID = 'data-testid="seed-invoice-view-banner-cta"';

async function testBannerRendersForSeedDraft() {
  const html = await renderView({ invoice: makeInvoice({ is_seed: true, status: 'draft' }) });
  assert.ok(html.includes(BANNER_TESTID),
    'seed-invoice-view-banner must render when invoice.is_seed=true');
  assert.ok(/sample invoice we made for you/i.test(html),
    'banner copy must read as a "this is a sample" reframe, not a generic CTA');
  assert.ok(html.includes(BANNER_CTA_TESTID),
    'banner must carry the CTA testid for click-through tracking + targeted assertions');
}

async function testBannerCtaPointsAtInvoicesQuick() {
  const html = await renderView({ invoice: makeInvoice({ is_seed: true }) });
  // Capture the anchor opening tag + inner text up to the closing </a>.
  const re = new RegExp('<a[^>]*' + BANNER_CTA_TESTID + '[\\s\\S]*?</a>');
  const anchor = (html.match(re) || [''])[0];
  assert.ok(anchor, 'CTA anchor (open → close) is locatable');
  assert.ok(/href="\/invoices\/quick"/.test(anchor),
    'CTA must deep-link to /invoices/quick (the 3-field express form), NOT /invoices/new or /dashboard');
  assert.ok(/Create your real first invoice/i.test(anchor),
    'CTA copy must name the real next action explicitly (create + first + invoice)');
}

async function testBannerOmittedForNonSeedInvoice() {
  const html = await renderView({ invoice: makeInvoice({ is_seed: false }) });
  assert.ok(!html.includes(BANNER_TESTID),
    'banner MUST NOT render on a real (is_seed=false) invoice — no false-positive on the user\'s actual work');
}

async function testBannerOmittedWhenIsSeedUndefined() {
  const inv = makeInvoice();
  delete inv.is_seed;
  const html = await renderView({ invoice: inv });
  assert.ok(!html.includes(BANNER_TESTID),
    'banner MUST NOT render when is_seed column is missing (older rows, partial projections)');
}

async function testBannerOmittedWhenIsSeedNull() {
  const html = await renderView({ invoice: makeInvoice({ is_seed: null }) });
  assert.ok(!html.includes(BANNER_TESTID),
    'banner MUST NOT render when is_seed is null (defence-in-depth on nullable column)');
}

async function testBannerRendersOnSeedRegardlessOfStatus() {
  // The user may have clicked "Mark as Sent" or "Mark as Paid" while
  // exploring the sample. The banner is still the right surface — they
  // still need a real first invoice. Suppressing on status would orphan
  // the cohort that converted-out of the seed playfully.
  for (const status of ['draft', 'sent', 'paid', 'overdue']) {
    const html = await renderView({ invoice: makeInvoice({ is_seed: true, status }) });
    assert.ok(html.includes(BANNER_TESTID),
      `banner must render on a seed invoice in status=${status} — exploring the sample doesn't replace the need for a real first invoice`);
  }
}

async function testBannerSitsAboveActionBar() {
  const html = await renderView({ invoice: makeInvoice({ is_seed: true, status: 'draft' }) });
  const bannerStart = html.indexOf(BANNER_TESTID);
  // Match the actual button text (with emoji prefix) — the literal phrase
  // "Mark as Sent" also appears in HTML comments above the banner, so we
  // anchor on the emoji-prefixed render that only the button uses.
  const markSentBtn = html.indexOf('📤 Mark as Sent');
  const billTo = html.indexOf('Bill To');
  assert.ok(bannerStart >= 0, 'banner present');
  assert.ok(markSentBtn > bannerStart,
    'banner must be positioned ABOVE the action bar (Mark as Sent button) so the next-real-action signal wins the visual hierarchy');
  assert.ok(billTo > bannerStart,
    'banner must be positioned ABOVE the invoice preview card (Bill To section)');
}

async function testBannerIsPrintHidden() {
  const html = await renderView({ invoice: makeInvoice({ is_seed: true }) });
  // Find the banner opening div and assert it carries the print:hidden class.
  const openMatch = html.match(/<div[^>]*data-testid="seed-invoice-view-banner"[^>]*>/);
  assert.ok(openMatch, 'banner opening <div> is locatable');
  assert.ok(/class="[^"]*print:hidden/.test(openMatch[0]),
    'banner must carry print:hidden so a printed sample stays clean');
}

async function testBannerCopyDistinctFromGenericCallouts() {
  // The banner must use the "sample" reframe (not just a generic "Create
  // an invoice" CTA) so a user who's already past the seed never sees
  // copy that conflates a real invoice view with the sample frame.
  const seedHtml = await renderView({ invoice: makeInvoice({ is_seed: true }) });
  const realHtml = await renderView({ invoice: makeInvoice({ is_seed: false }) });
  assert.ok(/sample invoice/i.test(seedHtml),
    'seed view contains the "sample invoice" reframe copy');
  assert.ok(!/sample invoice we made for you/i.test(realHtml),
    'real-invoice view MUST NOT contain the "sample invoice we made for you" copy — no copy leak across the gate');
}

async function testBannerRendersForPaidPlans() {
  // A trial-Pro user who just signed up also sees the seed sample. The
  // banner must render for plan='pro' and plan='agency' too — there's
  // nothing plan-specific about the seed-vs-real distinction.
  for (const plan of ['pro', 'agency']) {
    const html = await renderView({ invoice: makeInvoice({ is_seed: true }), userPlan: plan });
    assert.ok(html.includes(BANNER_TESTID),
      `banner must render for plan=${plan} — the seed-vs-real reframe is plan-independent`);
  }
}

async function testBannerHasAriaRegionLabel() {
  const html = await renderView({ invoice: makeInvoice({ is_seed: true }) });
  const openMatch = html.match(/<div[^>]*data-testid="seed-invoice-view-banner"[^>]*>/);
  assert.ok(openMatch, 'banner opening <div> is locatable');
  assert.ok(/role="region"/.test(openMatch[0]),
    'banner uses role="region" for assistive-tech navigation');
  assert.ok(/aria-label="[^"]+"/.test(openMatch[0]),
    'banner carries an aria-label naming the region');
}

async function run() {
  const tests = [
    ['banner renders on a seed draft', testBannerRendersForSeedDraft],
    ['banner CTA points at /invoices/quick with the right copy', testBannerCtaPointsAtInvoicesQuick],
    ['banner omitted for a real (is_seed=false) invoice', testBannerOmittedForNonSeedInvoice],
    ['banner omitted when is_seed is undefined', testBannerOmittedWhenIsSeedUndefined],
    ['banner omitted when is_seed is null', testBannerOmittedWhenIsSeedNull],
    ['banner renders on a seed regardless of status', testBannerRendersOnSeedRegardlessOfStatus],
    ['banner sits above the action bar + invoice preview', testBannerSitsAboveActionBar],
    ['banner is print:hidden', testBannerIsPrintHidden],
    ['banner copy is distinct from real-invoice render', testBannerCopyDistinctFromGenericCallouts],
    ['banner renders for pro/agency plans', testBannerRendersForPaidPlans],
    ['banner exposes role=region + aria-label', testBannerHasAriaRegionLabel]
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
  console.log(`\nseed-invoice-view-banner: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

run();
