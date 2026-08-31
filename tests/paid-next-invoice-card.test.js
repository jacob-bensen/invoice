'use strict';

/*
 * "Paid — invoice them again" next-move card on /invoices/:id (Milestone 2
 * lever, harvested at the M4 completion moment).
 *
 * Freelancer just got paid on invoice X. Their engagement peaks at exactly
 * that moment; the most valuable next action for the funnel is "invoice
 * this same client for the next phase / retainer / repeat job". Today the
 * only affordance for that is the small "Duplicate" button in the header
 * actions row — easy to miss. This card promotes the primary next-action
 * to the top of the page: a big emerald "Send {Client} their next invoice"
 * button, with a smaller "Or use these items for a new client" fallback.
 *
 * Layers:
 *   1. buildPaidNextInvoiceCard(invoice, user, opts) — pure helper. Returns
 *      { clientName, invoiceNumber, total, paidDaysAgo, ... } or null.
 *   2. invoice-view.ejs render block — emerald card with two duplicate
 *      forms, positioned above the invoice preview card, print:hidden.
 *
 * Run: NODE_ENV=test node tests/paid-next-invoice-card.test.js
 */

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');

delete require.cache[require.resolve('../routes/invoices')];
const routes = require('../routes/invoices');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const NOW = new Date('2026-09-01T12:00:00Z');

function basePaidInvoice(overrides) {
  return Object.assign({
    id: 77,
    invoice_number: 'INV-2026-0007',
    status: 'paid',
    is_seed: false,
    client_name: 'Acme Corp',
    client_email: 'ap@acme.example',
    client_phone: '',
    total: '1250.00',
    updated_at: new Date('2026-08-30T09:00:00Z')
  }, overrides || {});
}

function baseUser(overrides) {
  return Object.assign({
    id: 1, plan: 'pro', email: 'me@x.example', name: 'Sam',
    business_name: 'Sam Co', invoice_count: 5
  }, overrides || {});
}

// ---- Layer 1: buildPaidNextInvoiceCard ---------------------------------

test('helper: null when invoice is missing / non-object', () => {
  assert.strictEqual(routes.buildPaidNextInvoiceCard(null, baseUser()), null);
  assert.strictEqual(routes.buildPaidNextInvoiceCard(undefined, baseUser()), null);
  assert.strictEqual(routes.buildPaidNextInvoiceCard('not-an-invoice', baseUser()), null);
});

test('helper: null when user is missing / non-object', () => {
  assert.strictEqual(routes.buildPaidNextInvoiceCard(basePaidInvoice(), null), null);
  assert.strictEqual(routes.buildPaidNextInvoiceCard(basePaidInvoice(), undefined), null);
  assert.strictEqual(routes.buildPaidNextInvoiceCard(basePaidInvoice(), 'not-a-user'), null);
});

test('helper: null for draft (draft-send-banner owns that surface)', () => {
  assert.strictEqual(
    routes.buildPaidNextInvoiceCard(basePaidInvoice({ status: 'draft' }), baseUser(), { now: NOW }),
    null
  );
});

test('helper: null for sent (client-view status card owns that surface)', () => {
  assert.strictEqual(
    routes.buildPaidNextInvoiceCard(basePaidInvoice({ status: 'sent' }), baseUser(), { now: NOW }),
    null
  );
});

test('helper: null for overdue', () => {
  assert.strictEqual(
    routes.buildPaidNextInvoiceCard(basePaidInvoice({ status: 'overdue' }), baseUser(), { now: NOW }),
    null
  );
});

test('helper: null for an unrecognised / missing status (belt + braces)', () => {
  assert.strictEqual(
    routes.buildPaidNextInvoiceCard(basePaidInvoice({ status: 'archived' }), baseUser(), { now: NOW }),
    null
  );
  assert.strictEqual(
    routes.buildPaidNextInvoiceCard(basePaidInvoice({ status: null }), baseUser(), { now: NOW }),
    null
  );
});

test('helper: null for the seed sample even if flipped to paid', () => {
  assert.strictEqual(
    routes.buildPaidNextInvoiceCard(basePaidInvoice({ is_seed: true }), baseUser(), { now: NOW }),
    null
  );
});

test('helper: null when client_name is empty / whitespace / missing', () => {
  assert.strictEqual(
    routes.buildPaidNextInvoiceCard(basePaidInvoice({ client_name: '' }), baseUser(), { now: NOW }),
    null
  );
  assert.strictEqual(
    routes.buildPaidNextInvoiceCard(basePaidInvoice({ client_name: '   ' }), baseUser(), { now: NOW }),
    null
  );
  assert.strictEqual(
    routes.buildPaidNextInvoiceCard(basePaidInvoice({ client_name: null }), baseUser(), { now: NOW }),
    null
  );
});

test('helper: null when user is free-tier at the FREE_LIMIT cap (button would 302 to limit_hit)', () => {
  assert.strictEqual(
    routes.buildPaidNextInvoiceCard(basePaidInvoice(), baseUser({ plan: 'free', invoice_count: 3 }), { now: NOW }),
    null
  );
  assert.strictEqual(
    routes.buildPaidNextInvoiceCard(basePaidInvoice(), baseUser({ plan: 'free', invoice_count: 4 }), { now: NOW }),
    null
  );
});

test('helper: free-tier UNDER the cap gets the card', () => {
  const card = routes.buildPaidNextInvoiceCard(
    basePaidInvoice(),
    baseUser({ plan: 'free', invoice_count: 2 }),
    { now: NOW }
  );
  assert.ok(card, 'card returned for free user below cap');
  assert.strictEqual(card.clientName, 'Acme Corp');
});

test('helper: pro / agency plan is unaffected by invoice_count', () => {
  const pro = routes.buildPaidNextInvoiceCard(basePaidInvoice(), baseUser({ plan: 'pro', invoice_count: 999 }), { now: NOW });
  assert.ok(pro);
  const agency = routes.buildPaidNextInvoiceCard(basePaidInvoice(), baseUser({ plan: 'agency', invoice_count: 999 }), { now: NOW });
  assert.ok(agency);
});

test('helper: happy path returns the projected shape', () => {
  const card = routes.buildPaidNextInvoiceCard(
    basePaidInvoice({
      updated_at: new Date('2026-08-30T00:00:00Z') // 2 days before NOW
    }),
    baseUser(),
    { now: NOW }
  );
  assert.ok(card);
  assert.strictEqual(card.clientName, 'Acme Corp');
  assert.strictEqual(card.invoiceNumber, 'INV-2026-0007');
  assert.strictEqual(card.total, 1250);
  assert.strictEqual(card.paidDaysAgo, 2);
  assert.strictEqual(card.paidAtIso, '2026-08-30T00:00:00.000Z');
  assert.strictEqual(card.hasClientEmail, true);
  assert.strictEqual(card.hasClientPhone, false);
});

test('helper: client_name is trimmed (leading/trailing whitespace normalised)', () => {
  const card = routes.buildPaidNextInvoiceCard(
    basePaidInvoice({ client_name: '  Acme Corp  ' }),
    baseUser(),
    { now: NOW }
  );
  assert.strictEqual(card.clientName, 'Acme Corp');
});

test('helper: hasClientEmail / hasClientPhone reflect trimmed content', () => {
  const noEmailNoPhone = routes.buildPaidNextInvoiceCard(
    basePaidInvoice({ client_email: '', client_phone: '' }),
    baseUser(),
    { now: NOW }
  );
  assert.strictEqual(noEmailNoPhone.hasClientEmail, false);
  assert.strictEqual(noEmailNoPhone.hasClientPhone, false);

  const bothPresent = routes.buildPaidNextInvoiceCard(
    basePaidInvoice({ client_email: 'a@b.example', client_phone: '+1 555 0100' }),
    baseUser(),
    { now: NOW }
  );
  assert.strictEqual(bothPresent.hasClientEmail, true);
  assert.strictEqual(bothPresent.hasClientPhone, true);

  // Whitespace-only should not count as present.
  const whitespaceOnly = routes.buildPaidNextInvoiceCard(
    basePaidInvoice({ client_email: '   ', client_phone: '   ' }),
    baseUser(),
    { now: NOW }
  );
  assert.strictEqual(whitespaceOnly.hasClientEmail, false);
  assert.strictEqual(whitespaceOnly.hasClientPhone, false);
});

test('helper: paidDaysAgo derives from updated_at, floors, and never goes negative under clock skew', () => {
  const dayZero = routes.buildPaidNextInvoiceCard(
    basePaidInvoice({ updated_at: new Date('2026-09-01T09:00:00Z') }), // 3h before NOW
    baseUser(),
    { now: NOW }
  );
  assert.strictEqual(dayZero.paidDaysAgo, 0);

  const futureFlip = routes.buildPaidNextInvoiceCard(
    basePaidInvoice({ updated_at: new Date('2026-09-05T00:00:00Z') }), // 4d AFTER NOW
    baseUser(),
    { now: NOW }
  );
  assert.strictEqual(futureFlip.paidDaysAgo, 0, 'clock-skew clamp');

  const noStamp = routes.buildPaidNextInvoiceCard(
    basePaidInvoice({ updated_at: null }),
    baseUser(),
    { now: NOW }
  );
  assert.strictEqual(noStamp.paidDaysAgo, null);
  assert.strictEqual(noStamp.paidAtIso, null);
});

test('helper: coerces malformed total to 0 (defence against string / null / NaN in DB)', () => {
  const nullTotal = routes.buildPaidNextInvoiceCard(basePaidInvoice({ total: null }), baseUser(), { now: NOW });
  assert.strictEqual(nullTotal.total, 0);
  const badTotal = routes.buildPaidNextInvoiceCard(basePaidInvoice({ total: 'not-a-number' }), baseUser(), { now: NOW });
  assert.strictEqual(badTotal.total, 0);
});

test('helper: accepts updated_at as ISO string too (pg driver difference tolerance)', () => {
  const card = routes.buildPaidNextInvoiceCard(
    basePaidInvoice({ updated_at: '2026-08-30T00:00:00Z' }),
    baseUser(),
    { now: NOW }
  );
  assert.strictEqual(card.paidDaysAgo, 2);
});

// ---- Layer 2: invoice-view.ejs render -----------------------------------

const invoiceViewTplPath = path.join(__dirname, '..', 'views', 'invoice-view.ejs');
const invoiceViewTpl = fs.readFileSync(invoiceViewTplPath, 'utf8');

function renderInvoiceView(locals) {
  const defaults = {
    title: 'Invoice INV-2026-0007',
    invoice: {
      id: 77,
      invoice_number: 'INV-2026-0007',
      status: 'paid',
      client_name: 'Acme Corp',
      client_email: 'ap@acme.example',
      client_address: '',
      total: '1250.00', subtotal: 1250, tax_rate: 0, tax_amount: 0,
      items: [{ description: 'Logo design', quantity: 1, unit_price: 1250 }],
      due_date: new Date('2026-09-30'),
      issued_date: new Date('2026-08-30'),
      is_seed: false,
      payment_link_url: null
    },
    user: { id: 1, plan: 'pro', email: 'me@x.example', name: 'Sam', business_name: 'Sam Co', invoice_count: 5 },
    flash: null,
    paymentMethods: [],
    prefetchedShare: null,
    clientViewStatus: null,
    paidNextInvoiceCard: null,
    currency: 'USD',
    currencySymbol: '$',
    formatMoney: (amt) => '$' + Number(amt).toFixed(2),
    csrfToken: 'TEST_CSRF'
  };
  return ejs.render(invoiceViewTpl, Object.assign(defaults, locals), {
    views: [path.join(__dirname, '..', 'views')],
    filename: invoiceViewTplPath
  });
}

test('view: card OMITTED when paidNextInvoiceCard is null', () => {
  const html = renderInvoiceView({ paidNextInvoiceCard: null });
  assert.doesNotMatch(html, /data-testid="paid-next-invoice-card"/);
});

test('view: card renders with client name + primary + secondary CTAs on paid invoice', () => {
  const html = renderInvoiceView({
    paidNextInvoiceCard: {
      clientName: 'Acme Corp',
      invoiceNumber: 'INV-2026-0007',
      total: 1250,
      paidAtIso: '2026-08-30T00:00:00.000Z',
      paidDaysAgo: 2,
      hasClientEmail: true,
      hasClientPhone: false
    }
  });
  const block = html.match(/data-testid="paid-next-invoice-card"[\s\S]{0,4000}/);
  assert.ok(block, 'card rendered');
  assert.match(block[0], /data-paid-days-ago="2"/);
  assert.match(block[0], /🎉 Paid!/);
  assert.match(block[0], /data-testid="paid-next-invoice-card-client-name"[^>]*>Acme Corp</);
  assert.match(block[0], /Ready to invoice/);
  assert.match(block[0], /for the next job/);
  assert.match(block[0], /data-testid="paid-next-invoice-card-days-ago"[^>]*>2</);
  assert.match(block[0], /days ago/);
  // Both forms
  assert.match(block[0], /data-testid="paid-next-invoice-card-same-client-form"/);
  assert.match(block[0], /data-testid="paid-next-invoice-card-new-client-form"/);
  assert.match(block[0], /data-testid="paid-next-invoice-card-same-client-button"/);
  assert.match(block[0], /data-testid="paid-next-invoice-card-new-client-button"/);
  assert.match(block[0], /Send Acme Corp their next invoice/);
  assert.match(block[0], /use these items for a new client/i);
});

test('view: both forms target POST /invoices/:id/duplicate with the invoice id', () => {
  const html = renderInvoiceView({
    invoice: {
      id: 4242,
      invoice_number: 'INV-2026-4242',
      status: 'paid',
      client_name: 'Acme Corp',
      client_email: 'ap@acme.example', client_address: '',
      total: '250.00', subtotal: 250, tax_rate: 0, tax_amount: 0,
      items: [{ description: 'X', quantity: 1, unit_price: 250 }],
      due_date: new Date('2026-09-30'),
      issued_date: new Date('2026-08-30'),
      is_seed: false, payment_link_url: null
    },
    paidNextInvoiceCard: {
      clientName: 'Acme Corp', invoiceNumber: 'INV-2026-4242',
      total: 250, paidAtIso: 'x', paidDaysAgo: 1,
      hasClientEmail: true, hasClientPhone: false
    }
  });
  const block = html.match(/data-testid="paid-next-invoice-card"[\s\S]{0,4000}/);
  assert.ok(block);
  // Same-client form: verify a <form ...> tag exists that includes both the
  // testid and the correct action/method attrs (attribute order tolerated).
  const sameClientTag = block[0].match(/<form[^>]*data-testid="paid-next-invoice-card-same-client-form"[^>]*>/);
  assert.ok(sameClientTag, 'same-client form tag found');
  assert.match(sameClientTag[0], /action="\/invoices\/4242\/duplicate"/);
  assert.match(sameClientTag[0], /method="POST"/);
  // New-client form
  const newClientTag = block[0].match(/<form[^>]*data-testid="paid-next-invoice-card-new-client-form"[^>]*>/);
  assert.ok(newClientTag, 'new-client form tag found');
  assert.match(newClientTag[0], /action="\/invoices\/4242\/duplicate"/);
  assert.match(newClientTag[0], /method="POST"/);
});

test('view: new-client form carries client_scope=new_client hidden field', () => {
  const html = renderInvoiceView({
    paidNextInvoiceCard: {
      clientName: 'Acme Corp', invoiceNumber: 'INV-2026-0007',
      total: 1250, paidAtIso: 'x', paidDaysAgo: 2,
      hasClientEmail: true, hasClientPhone: false
    }
  });
  // Non-greedy isolation of each form's body so the same-client extraction
  // does not spill into the new-client form (which sits directly after it).
  const newClientForm = html.match(/data-testid="paid-next-invoice-card-new-client-form"[\s\S]*?<\/form>/);
  assert.ok(newClientForm, 'new-client form isolated');
  assert.match(newClientForm[0], /name="client_scope"[^>]*value="new_client"/);
  // Same-client form must NOT carry client_scope=new_client.
  const sameClientForm = html.match(/data-testid="paid-next-invoice-card-same-client-form"[\s\S]*?<\/form>/);
  assert.ok(sameClientForm);
  assert.doesNotMatch(sameClientForm[0], /name="client_scope"/);
});

test('view: both forms carry the _csrf hidden field', () => {
  const html = renderInvoiceView({
    paidNextInvoiceCard: {
      clientName: 'Acme Corp', invoiceNumber: 'INV-2026-0007',
      total: 1250, paidAtIso: 'x', paidDaysAgo: 2,
      hasClientEmail: true, hasClientPhone: false
    }
  });
  const sameForm = html.match(/data-testid="paid-next-invoice-card-same-client-form"[\s\S]*?<\/form>/);
  const newForm = html.match(/data-testid="paid-next-invoice-card-new-client-form"[\s\S]*?<\/form>/);
  assert.ok(sameForm && newForm);
  assert.match(sameForm[0], /name="_csrf"[^>]*value="TEST_CSRF"/);
  assert.match(newForm[0], /name="_csrf"[^>]*value="TEST_CSRF"/);
});

test('view: card carries print:hidden so it never leaks into a downloaded PDF', () => {
  const html = renderInvoiceView({
    paidNextInvoiceCard: {
      clientName: 'Acme Corp', invoiceNumber: 'INV-2026-0007',
      total: 1250, paidAtIso: 'x', paidDaysAgo: 2,
      hasClientEmail: true, hasClientPhone: false
    }
  });
  const block = html.match(/data-testid="paid-next-invoice-card"[\s\S]{0,500}/);
  assert.ok(block);
  assert.match(block[0], /print:hidden/);
});

test('view: card sits ABOVE the invoice preview card', () => {
  const html = renderInvoiceView({
    paidNextInvoiceCard: {
      clientName: 'Acme Corp', invoiceNumber: 'INV-2026-0007',
      total: 1250, paidAtIso: 'x', paidDaysAgo: 2,
      hasClientEmail: true, hasClientPhone: false
    }
  });
  const cardIdx = html.indexOf('data-testid="paid-next-invoice-card"');
  const invoicePreviewIdx = html.indexOf('<!-- Invoice preview card -->');
  assert.ok(cardIdx > 0, 'card present');
  assert.ok(invoicePreviewIdx > 0, 'invoice preview present');
  assert.ok(cardIdx < invoicePreviewIdx, 'card must render BEFORE the invoice preview');
});

test('view: card day-0 copy says "earlier today" not a day count', () => {
  const html = renderInvoiceView({
    paidNextInvoiceCard: {
      clientName: 'Acme Corp', invoiceNumber: 'INV-2026-0007',
      total: 1250, paidAtIso: 'x', paidDaysAgo: 0,
      hasClientEmail: true, hasClientPhone: false
    }
  });
  const block = html.match(/data-testid="paid-next-invoice-card"[\s\S]{0,1200}/);
  assert.ok(block);
  assert.match(block[0], /earlier today/i);
  assert.doesNotMatch(block[0], /0 days ago/);
});

test('view: card singular vs plural day count copy', () => {
  const singular = renderInvoiceView({
    paidNextInvoiceCard: {
      clientName: 'Acme Corp', invoiceNumber: 'INV-2026-0007',
      total: 1250, paidAtIso: 'x', paidDaysAgo: 1,
      hasClientEmail: true, hasClientPhone: false
    }
  });
  const s = singular.match(/data-testid="paid-next-invoice-card"[\s\S]{0,1500}/);
  assert.match(s[0], /data-paid-days-ago="1"/);
  assert.match(s[0], />1<\/span> day ago/);
  assert.doesNotMatch(s[0], /days ago/);

  const plural = renderInvoiceView({
    paidNextInvoiceCard: {
      clientName: 'Acme Corp', invoiceNumber: 'INV-2026-0007',
      total: 1250, paidAtIso: 'x', paidDaysAgo: 12,
      hasClientEmail: true, hasClientPhone: false
    }
  });
  const p = plural.match(/data-testid="paid-next-invoice-card"[\s\S]{0,1500}/);
  assert.match(p[0], /data-paid-days-ago="12"/);
  assert.match(p[0], />12<\/span> days ago/);
});

test('view: card handles a null paidDaysAgo (missing updated_at) with a generic copy fallback', () => {
  const html = renderInvoiceView({
    paidNextInvoiceCard: {
      clientName: 'Acme Corp', invoiceNumber: 'INV-2026-0007',
      total: 1250, paidAtIso: null, paidDaysAgo: null,
      hasClientEmail: true, hasClientPhone: false
    }
  });
  const block = html.match(/data-testid="paid-next-invoice-card"[\s\S]{0,1500}/);
  assert.ok(block);
  assert.doesNotMatch(block[0], /data-testid="paid-next-invoice-card-days-ago"/);
  assert.match(block[0], /data-paid-days-ago=""/);
  assert.match(block[0], /repeat sale/);
});

test('view: hostile client name is HTML-escaped (never breaks out of the button label)', () => {
  const html = renderInvoiceView({
    paidNextInvoiceCard: {
      clientName: '<script>alert(1)</script>',
      invoiceNumber: 'INV-2026-0007',
      total: 1250, paidAtIso: 'x', paidDaysAgo: 2,
      hasClientEmail: true, hasClientPhone: false
    }
  });
  const block = html.match(/data-testid="paid-next-invoice-card"[\s\S]{0,3000}/);
  assert.ok(block);
  assert.doesNotMatch(block[0], /<script>alert\(1\)<\/script>/);
  assert.match(block[0], /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

// ---- Run ----------------------------------------------------------------

(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log(`  ✓ ${t.name}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${t.name}`);
      console.error(`    ${err.message}`);
      if (err.stack) console.error(err.stack.split('\n').slice(0, 6).join('\n'));
    }
  }
  console.log(`\n${passed} passed, ${failed} failed (paid-next-invoice-card.test.js)`);
  if (failed > 0) process.exit(1);
})();
