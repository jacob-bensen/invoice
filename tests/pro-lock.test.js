'use strict';

/*
 * Tests for the canonical Pro upsell partial (#15) and its wiring on the
 * webhook + invoice-view surfaces.
 *
 * The single partial `views/partials/pro-lock.ejs` is supposed to:
 *   - render a consistent upsell card with a Stripe-checkout form for any
 *     non-Pro user when supplied `feature`, `headline`, `benefit`
 *   - be a no-op (empty output) for Pro and Agency users
 *   - be a no-op when required locals are missing
 *   - POST directly to /billing/create-checkout with billing_cycle=annual
 *     and a `source` slug so each lock surface attributes its own
 *     conversions, instead of redirecting through /billing/upgrade
 *
 * It must replace the bespoke dead-end lock blocks on:
 *   - settings.ejs       → free user sees a webhook pro-lock (no plain
 *                          "Upgrade to Pro →" link any more)
 *   - invoice-view.ejs   → free user sees payment_link + email_send
 *                          pro-lock cards instead of a silent omission
 *
 * Run: node tests/pro-lock.test.js
 */

const assert = require('assert');
const path = require('path');
const ejs = require('ejs');
const fs = require('fs');

const VIEWS = path.join(__dirname, '..', 'views');
const TEMPLATE = path.join(VIEWS, 'partials', 'pro-lock.ejs');

function render(locals) {
  return ejs.renderFile(TEMPLATE, { ...locals }, { views: [VIEWS] });
}

// ---------- Partial: rendering for free users -------------------------------

async function testRendersCardForFreeUser() {
  const html = await render({
    user: { plan: 'free' },
    csrfToken: 'csrf-abc',
    proLock: {
      feature: 'webhook',
      icon: '🔗',
      headline: 'Pipe paid invoices into Slack',
      benefit: 'Pro fires a JSON POST on every paid invoice.'
    }
  });
  assert.ok(/data-pro-lock="webhook"/.test(html),
    'lock card must carry data-pro-lock attribute keyed on the feature slug');
  assert.ok(html.includes('Pipe paid invoices into Slack'),
    'lock card must render the caller-supplied headline');
  assert.ok(html.includes('Pro fires a JSON POST on every paid invoice.'),
    'lock card must render the caller-supplied benefit');
  assert.ok(/action="\/billing\/create-checkout"/.test(html),
    'lock card form must POST directly to /billing/create-checkout');
  assert.ok(/name="billing_cycle"\s+value="annual"/.test(html),
    'lock card must default to annual billing — the higher-LTV upsell');
  assert.ok(/name="source"\s+value="pro-lock-webhook"/.test(html),
    'lock card must tag the source field so analytics can attribute by feature slug');
  assert.ok(/name="_csrf"\s+value="csrf-abc"/.test(html),
    'lock card must include the supplied CSRF token');
  assert.ok(/Start 7-day free trial/.test(html),
    'lock card CTA must read "Start 7-day free trial"');
  assert.ok(/PRO/.test(html), 'lock card must carry the PRO badge');
}

async function testRendersDefaultIconWhenIconOmitted() {
  const html = await render({
    user: { plan: 'free' },
    csrfToken: '',
    proLock: { feature: 'x', headline: 'h', benefit: 'b' }
  });
  // Default icon is the padlock emoji.
  assert.ok(html.includes('🔒'),
    'lock card must fall back to a padlock icon when none is supplied');
}

async function testCardHasNoStraightUpgradeToProLink() {
  // Distinct from the old bespoke "Upgrade to Pro →" copy — the canonical
  // lock must not surface that text; it has to be a one-click checkout.
  const html = await render({
    user: { plan: 'free' },
    csrfToken: '',
    proLock: { feature: 'x', headline: 'h', benefit: 'b' }
  });
  assert.ok(!/Upgrade to Pro\s*→/.test(html),
    'canonical lock must replace the dead-end "Upgrade to Pro →" link with a checkout form');
}

// ---------- Partial: silent no-op cases -------------------------------------

async function testNoopForProUser() {
  const html = await render({
    user: { plan: 'pro' },
    csrfToken: '',
    proLock: { feature: 'webhook', headline: 'h', benefit: 'b' }
  });
  assert.strictEqual(html.trim(), '',
    'lock card must render nothing for Pro users — they already have the feature');
}

async function testNoopForAgencyUser() {
  const html = await render({
    user: { plan: 'agency' },
    csrfToken: '',
    proLock: { feature: 'webhook', headline: 'h', benefit: 'b' }
  });
  assert.strictEqual(html.trim(), '',
    'lock card must render nothing for Agency users');
}

async function testNoopWhenLocalsMissingHeadline() {
  const html = await render({
    user: { plan: 'free' },
    csrfToken: '',
    proLock: { feature: 'x', benefit: 'b' }
  });
  assert.strictEqual(html.trim(), '',
    'lock card must render nothing when headline is missing — fail closed, never partial');
}

async function testNoopWhenLocalsMissingBenefit() {
  const html = await render({
    user: { plan: 'free' },
    csrfToken: '',
    proLock: { feature: 'x', headline: 'h' }
  });
  assert.strictEqual(html.trim(), '',
    'lock card must render nothing when benefit is missing');
}

async function testNoopWhenLocalsMissingFeature() {
  const html = await render({
    user: { plan: 'free' },
    csrfToken: '',
    proLock: { headline: 'h', benefit: 'b' }
  });
  assert.strictEqual(html.trim(), '',
    'lock card must render nothing when feature slug is missing — needed for analytics + testid');
}

async function testNoopWhenProLockMissingEntirely() {
  const html = await render({
    user: { plan: 'free' },
    csrfToken: ''
  });
  assert.strictEqual(html.trim(), '',
    'lock card must render nothing when proLock locals object is absent');
}

// ---------- Wiring: settings.ejs webhook surface ----------------------------

async function testSettingsRendersWebhookProLockForFreeUser() {
  const html = await ejs.renderFile(path.join(VIEWS, 'settings.ejs'), {
    title: 'Account Settings',
    user: { plan: 'free', email: 'free@x.com', invoice_count: 1, webhook_url: null },
    csrfToken: 'csrf-1',
    flash: null
  }, { views: [VIEWS] });
  assert.ok(/data-pro-lock="webhook"/.test(html),
    'free-plan settings.ejs must include the canonical pro-lock keyed to webhook');
  assert.ok(!/Upgrade to Pro\s*→/.test(html),
    'settings.ejs must no longer carry the bespoke "Upgrade to Pro →" link — only the canonical lock');
  assert.ok(/action="\/billing\/create-checkout"[\s\S]*data-pro-lock-form/.test(html)
    || /data-pro-lock-form[\s\S]*action="\/billing\/create-checkout"/.test(html),
    'the webhook lock form must POST to /billing/create-checkout');
}

async function testSettingsDoesNotRenderProLockForProUser() {
  const html = await ejs.renderFile(path.join(VIEWS, 'settings.ejs'), {
    title: 'Account Settings',
    user: { plan: 'pro', email: 'pro@x.com', invoice_count: 12, webhook_url: null },
    csrfToken: 'csrf-1',
    flash: null
  }, { views: [VIEWS] });
  assert.ok(!/data-pro-lock="webhook"/.test(html),
    'Pro user must NOT see the webhook lock card — they already have the live form');
}

// ---------- Wiring: invoice-view.ejs payment-link + email surfaces ----------

function makeInvoice(overrides) {
  return Object.assign({
    id: 1,
    invoice_number: 'INV-2026-0001',
    status: 'draft',
    issued_date: new Date('2026-05-01'),
    due_date: new Date('2026-05-31'),
    client_name: 'Acme',
    client_email: 'acme@x.com',
    client_address: '',
    items: [{ description: 'x', quantity: 1, unit_price: 100 }],
    subtotal: 100,
    tax_rate: 0,
    tax_amount: 0,
    total: 100,
    notes: null,
    payment_link_url: null
  }, overrides || {});
}

async function testInvoiceViewRendersBothLocksForFreeUser() {
  const html = await ejs.renderFile(path.join(VIEWS, 'invoice-view.ejs'), {
    title: 'Invoice',
    user: { plan: 'free', email: 'free@x.com', name: 'Free', business_name: null },
    invoice: makeInvoice(),
    csrfToken: 'csrf-2',
    flash: null
  }, { views: [VIEWS] });
  assert.ok(/data-pro-lock="payment_link"/.test(html),
    'free-plan invoice-view.ejs must surface the payment_link lock card');
  assert.ok(/data-pro-lock="email_send"/.test(html),
    'free-plan invoice-view.ejs must surface the email_send lock card');
  // Two source slugs prove the same partial was reused for both surfaces.
  assert.ok(/name="source"\s+value="pro-lock-payment_link"/.test(html),
    'payment_link lock must tag its source for attribution');
  assert.ok(/name="source"\s+value="pro-lock-email_send"/.test(html),
    'email_send lock must tag its source for attribution');
}

async function testInvoiceViewSuppressesLocksForProUser() {
  const html = await ejs.renderFile(path.join(VIEWS, 'invoice-view.ejs'), {
    title: 'Invoice',
    user: { plan: 'pro', email: 'pro@x.com', name: 'Pro', business_name: null },
    invoice: makeInvoice({ payment_link_url: 'https://buy.stripe.com/test' }),
    paymentMethods: ['card'],
    csrfToken: 'csrf-2',
    flash: null
  }, { views: [VIEWS] });
  assert.ok(!/data-pro-lock=/.test(html),
    'Pro user must see zero pro-lock cards — they have the live payment-link UI');
  assert.ok(html.includes('https://buy.stripe.com/test'),
    'Pro user should still see their live payment link');
}

async function testInvoiceViewSuppressesLocksForProWithoutLink() {
  // Pro user on a draft (no payment_link_url yet). They shouldn't see the
  // free-only lock cards because the link will be created on "Mark as Sent".
  const html = await ejs.renderFile(path.join(VIEWS, 'invoice-view.ejs'), {
    title: 'Invoice',
    user: { plan: 'pro', email: 'pro@x.com', name: 'Pro', business_name: null },
    invoice: makeInvoice({ status: 'draft', payment_link_url: null }),
    csrfToken: 'csrf-2',
    flash: null
  }, { views: [VIEWS] });
  assert.ok(!/data-pro-lock=/.test(html),
    'Pro user on a draft must not see lock cards even when payment_link_url is null');
}

// ---------- Single source-of-truth contract --------------------------------

function testPartialFileExistsAndIsReused() {
  // Defence against future drift: any future locked-feature surface should
  // reuse this partial. The contract here is just that the partial file
  // exists at the canonical path — drift is caught by the surface tests
  // above flipping red if a maintainer inlines bespoke copy instead.
  assert.ok(fs.existsSync(TEMPLATE),
    `canonical pro-lock partial must live at ${TEMPLATE}`);
  const src = fs.readFileSync(TEMPLATE, 'utf8');
  assert.ok(/billing\/create-checkout/.test(src),
    'partial must POST to /billing/create-checkout, not the old /billing/upgrade landing page');
  assert.ok(/billing_cycle"\s+value="annual"/.test(src),
    'partial must default to annual cycle so every lock click is the higher-LTV path');
}

// ---------- Runner ----------------------------------------------------------

async function run() {
  const tests = [
    ['partial renders a checkout-form card for a free user', testRendersCardForFreeUser],
    ['partial falls back to a padlock icon when none supplied', testRendersDefaultIconWhenIconOmitted],
    ['partial does not surface the bespoke "Upgrade to Pro →" link', testCardHasNoStraightUpgradeToProLink],
    ['partial renders nothing for a Pro user', testNoopForProUser],
    ['partial renders nothing for an Agency user', testNoopForAgencyUser],
    ['partial renders nothing when headline is missing', testNoopWhenLocalsMissingHeadline],
    ['partial renders nothing when benefit is missing', testNoopWhenLocalsMissingBenefit],
    ['partial renders nothing when feature slug is missing', testNoopWhenLocalsMissingFeature],
    ['partial renders nothing when proLock locals are absent', testNoopWhenProLockMissingEntirely],
    ['settings.ejs surfaces the webhook pro-lock for a free user', testSettingsRendersWebhookProLockForFreeUser],
    ['settings.ejs hides the pro-lock for a Pro user', testSettingsDoesNotRenderProLockForProUser],
    ['invoice-view.ejs surfaces both payment_link + email_send locks for a free user', testInvoiceViewRendersBothLocksForFreeUser],
    ['invoice-view.ejs hides locks for a Pro user with live link', testInvoiceViewSuppressesLocksForProUser],
    ['invoice-view.ejs hides locks for a Pro user even on a draft', testInvoiceViewSuppressesLocksForProWithoutLink],
    ['canonical partial file lives at the expected path with the right form contract', testPartialFileExistsAndIsReused]
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
  console.log(`\npro-lock.test.js: ${passed}/${tests.length} passed`);
}

run();
