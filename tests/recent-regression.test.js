'use strict';

/*
 * Regression-coverage tests for recent CHANGELOG entries that lacked direct
 * assertions in the existing suite (Test Examiner cycle, 2026-04-27 PM-4):
 *
 *   1. 2026-04-27 PM-3 / PM-2 — pricing.ejs free-tier × list now exposes
 *      `Stripe payment links` and `Auto reminder emails` as the highest-leverage
 *      upgrade levers. A regression that drops either bullet silently kills
 *      conversion (a freelancer literally cannot see what Pro adds beyond
 *      "Unlimited invoices").
 *   2. 2026-04-27 PM-3 — invoice-form.ejs Due Date defaults to Net 30 (issued
 *      today + 30 days) on a NEW invoice; existing invoices preserve their
 *      stored due_date. The Net 30 default is the trigger for the reminder
 *      cron — a regression that returns the field to value="" on new invoices
 *      silently disables the reminder loop on every newly-created invoice.
 *
 * No existing test asserts either contract directly. Adding regression
 * guards before they bit-rot.
 *
 * Run: NODE_ENV=test node tests/recent-regression.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');

const viewsDir = path.join(__dirname, '..', 'views');

// ---------- pricing.ejs free-tier × list -------------------------------

function renderPricing(locals) {
  const tplPath = path.join(viewsDir, 'pricing.ejs');
  return ejs.render(fs.readFileSync(tplPath, 'utf8'), {
    title: 'Pricing',
    user: null,
    flash: null,
    csrfToken: 'TEST_CSRF',
    ...locals
  }, { views: [viewsDir], filename: tplPath });
}

function testPricingFreeTierShowsStripePaymentLinksAsLockedFeature() {
  const html = renderPricing({});
  // The free tier × list is the canonical surface where a freelancer scanning
  // the pricing card sees what they DON'T have today. The two highest-leverage
  // Pro wedges are payment links and auto reminders.
  const freeBlock = html.match(/Your current plan[\s\S]*?<\/ul>/);
  assert.ok(freeBlock, 'free-tier card must render with the "Your current plan" copy');
  const freeHtml = freeBlock[0];
  assert.ok(/Stripe payment links/.test(freeHtml),
    'free-tier × list must include "Stripe payment links" — the primary product wedge');
  assert.ok(/Auto reminder emails/.test(freeHtml),
    'free-tier × list must include "Auto reminder emails" — the secondary product wedge');
  // Both must be in the × column (gray-300 styling), not the ✓ column.
  assert.ok(/text-gray-300["'][^>]*><span>×<\/span>\s*Stripe payment links/.test(freeHtml),
    '"Stripe payment links" must render under the × (locked) column on free tier');
  assert.ok(/text-gray-300["'][^>]*><span>×<\/span>\s*Auto reminder emails/.test(freeHtml),
    '"Auto reminder emails" must render under the × (locked) column on free tier');
}

function testPricingProTierShowsTheSameWedgesAsCheckmarks() {
  const html = renderPricing({});
  const proBlock = html.match(/<h3[^>]*>Pro<\/h3>[\s\S]*?<\/ul>/);
  assert.ok(proBlock, 'pro-tier card must render');
  const proHtml = proBlock[0];
  assert.ok(/Stripe payment links/.test(proHtml),
    'pro tier list must include "Stripe payment links" — vertical alignment with free-tier × is the whole point');
  assert.ok(/Auto reminder emails/.test(proHtml),
    'pro tier list must include "Auto reminder emails" — vertical alignment with free-tier × is the whole point');
}

function testPricingFreeTierFirstBulletUsesUpToCopy() {
  // 2026-04-27 PM-3 — the first ✓ on the free tier was reworded from
  // "3 invoices total" to "Up to 3 invoices" to match the dashboard's
  // "X/3 invoices used" framing. Consistency hygiene.
  const html = renderPricing({});
  assert.ok(/Up to 3 invoices/.test(html),
    'free-tier first ✓ must read "Up to 3 invoices" (consistency with dashboard)');
  assert.ok(!/3 invoices total/.test(html),
    'free-tier first ✓ must no longer use the old "3 invoices total" copy');
}

// ---------- invoice-form.ejs Net 30 default -----------------------------

function renderInvoiceForm(locals) {
  const tplPath = path.join(viewsDir, 'invoice-form.ejs');
  return ejs.render(fs.readFileSync(tplPath, 'utf8'), {
    title: 'New Invoice',
    invoice: null,
    invoiceNumber: 'INV-001',
    recentClients: [],
    user: { plan: 'free', invoice_count: 0, business_name: null },
    flash: null,
    csrfToken: 'TEST_CSRF',
    ...locals
  }, { views: [viewsDir], filename: tplPath });
}

function testInvoiceFormDueDateDefaultsToNet30OnNewInvoice() {
  const html = renderInvoiceForm({ invoice: null });
  // The field must render with a non-empty `value` attribute that is exactly
  // 30 days after today (UTC date).
  const m = html.match(/<input[^>]+name=["']due_date["'][^>]+value=["']([^"']+)["']/);
  assert.ok(m, 'due_date input must render with a value attribute on new invoices');
  const value = m[1];
  assert.ok(value, 'due_date default must not be empty on new invoices (would disable reminder cron)');
  // Compute expected: today + 30 days, ISO YYYY-MM-DD.
  const expected = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
  assert.strictEqual(value, expected,
    `due_date default must be Net 30 (today + 30 days = ${expected}); got ${value}`);
}

function testInvoiceFormDueDateLabelMentionsNet30() {
  const html = renderInvoiceForm({ invoice: null });
  assert.match(html, /Due Date[^<]*<[^>]*>\(Net 30 default\)/,
    'Due Date label must surface the "(Net 30 default)" hint so the pre-fill is transparent');
}

function testInvoiceFormDueDatePreservedOnEdit() {
  // When editing an existing invoice that already has a due_date, the form
  // must render the stored date verbatim — not clobber it with today+30.
  const stored = new Date('2026-06-15T00:00:00Z');
  const html = renderInvoiceForm({
    invoice: {
      id: 1,
      invoice_number: 'INV-001',
      client_name: 'Acme',
      client_email: 'ap@acme.com',
      client_address: null,
      issued_date: new Date('2026-05-01T00:00:00Z'),
      due_date: stored,
      items: [],
      subtotal: 0, tax_rate: 0, tax_amount: 0, total: 0,
      notes: null,
      status: 'draft'
    }
  });
  const m = html.match(/<input[^>]+name=["']due_date["'][^>]+value=["']([^"']+)["']/);
  assert.ok(m, 'edit-mode form must still render due_date input');
  assert.strictEqual(m[1], '2026-06-15',
    'edit-mode form must preserve the stored due_date, not overwrite with Net 30 default');
}

// ---------- Runner -----------------------------------------------------

async function run() {
  const tests = [
    ['pricing.ejs: free × list includes "Stripe payment links"', testPricingFreeTierShowsStripePaymentLinksAsLockedFeature],
    ['pricing.ejs: pro ✓ list mirrors the same wedges', testPricingProTierShowsTheSameWedgesAsCheckmarks],
    ['pricing.ejs: free first ✓ reads "Up to 3 invoices"', testPricingFreeTierFirstBulletUsesUpToCopy],
    ['invoice-form.ejs: Due Date defaults to Net 30 on new invoice', testInvoiceFormDueDateDefaultsToNet30OnNewInvoice],
    ['invoice-form.ejs: Due Date label exposes "(Net 30 default)" hint', testInvoiceFormDueDateLabelMentionsNet30],
    ['invoice-form.ejs: edit-mode preserves stored due_date', testInvoiceFormDueDatePreservedOnEdit]
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
