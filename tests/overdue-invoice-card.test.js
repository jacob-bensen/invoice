'use strict';

/*
 * "🔴 N days past due" urgency card on /invoices/:id (Milestone 4 — first
 * invoice sent → first payment received).
 *
 * Freelancer lands on /invoices/:id for a specific overdue invoice (email
 * deep-link, bookmark, invoice-table row-click). Today the only urgency
 * signal is the small red 'Overdue' status pill next to the invoice number
 * — no days-past-due count, no one-tap Mark-as-Paid, no firm-tone follow-up
 * cluster. The dashboard's overduePrompt covers exactly ONE overdue invoice
 * (oldest by due_date) so a freelancer with 3 overdue rows only gets that
 * signal for the oldest. This card surfaces the days-late count + a
 * "Mark as Paid" form + a firm follow-up channel row at the top of every
 * overdue invoice-view page.
 *
 * Layers:
 *   1. buildOverdueInvoiceCard(invoice, opts) — pure helper. Returns
 *      { daysPastDue, urgencyTier, dueDateIso, clientName, invoiceNumber,
 *        total, hasClientEmail, followUpIntents } or null.
 *   2. invoice-view.ejs render block — red urgency card with Mark-as-Paid
 *      form + follow-up cluster, positioned above the client-view-status
 *      card, print:hidden.
 *
 * Run: NODE_ENV=test node tests/overdue-invoice-card.test.js
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

function baseOverdueInvoice(overrides) {
  return Object.assign({
    id: 88,
    invoice_number: 'INV-2026-0088',
    status: 'sent',
    is_seed: false,
    client_name: 'Acme Corp',
    client_email: 'ap@acme.example',
    total: '750.00',
    due_date: new Date('2026-08-25T00:00:00Z') // 7 days before NOW
  }, overrides || {});
}

function baseIntents() {
  return {
    whatsapp: 'https://wa.me/?text=x',
    sms: 'sms:?body=x',
    mailto: 'mailto:ap@acme.example?subject=x',
    url: 'https://app.example/i/tok123',
    overdue: true,
    subject: 'Reminder: Invoice INV-2026-0088 — $750.00 is overdue',
    body: 'Hi Acme, just checking in on invoice INV-2026-0088 (now overdue).'
  };
}

// ---- Layer 1: buildOverdueInvoiceCard -----------------------------------

test('helper: null when invoice is missing / non-object', () => {
  assert.strictEqual(routes.buildOverdueInvoiceCard(null), null);
  assert.strictEqual(routes.buildOverdueInvoiceCard(undefined), null);
  assert.strictEqual(routes.buildOverdueInvoiceCard('not-an-invoice'), null);
});

test('helper: null for the seed sample', () => {
  assert.strictEqual(
    routes.buildOverdueInvoiceCard(baseOverdueInvoice({ is_seed: true }), { now: NOW }),
    null
  );
});

test('helper: null for draft / paid / any status outside sent+overdue', () => {
  for (const status of ['draft', 'paid', 'archived', null, '']) {
    assert.strictEqual(
      routes.buildOverdueInvoiceCard(baseOverdueInvoice({ status }), { now: NOW }),
      null,
      `status=${JSON.stringify(status)} must return null`
    );
  }
});

test('helper: null when due_date is missing / unparseable', () => {
  assert.strictEqual(
    routes.buildOverdueInvoiceCard(baseOverdueInvoice({ due_date: null }), { now: NOW }),
    null
  );
  assert.strictEqual(
    routes.buildOverdueInvoiceCard(baseOverdueInvoice({ due_date: undefined }), { now: NOW }),
    null
  );
  assert.strictEqual(
    routes.buildOverdueInvoiceCard(baseOverdueInvoice({ due_date: 'not-a-date' }), { now: NOW }),
    null
  );
});

test('helper: null when due_date is still in the future', () => {
  assert.strictEqual(
    routes.buildOverdueInvoiceCard(
      baseOverdueInvoice({ due_date: new Date('2026-09-10T00:00:00Z') }),
      { now: NOW }
    ),
    null
  );
});

test('helper: null when due_date equals now (not YET overdue by contractual signal)', () => {
  assert.strictEqual(
    routes.buildOverdueInvoiceCard(
      baseOverdueInvoice({ due_date: new Date(NOW.getTime()) }),
      { now: NOW }
    ),
    null
  );
});

test('helper: happy path returns the projected shape (7 days past due, sent status)', () => {
  const card = routes.buildOverdueInvoiceCard(baseOverdueInvoice(), { now: NOW });
  assert.ok(card, 'card returned');
  assert.strictEqual(card.daysPastDue, 7);
  assert.strictEqual(card.urgencyTier, 'moderate');
  assert.strictEqual(card.dueDateIso, '2026-08-25T00:00:00.000Z');
  assert.strictEqual(card.clientName, 'Acme Corp');
  assert.strictEqual(card.invoiceNumber, 'INV-2026-0088');
  assert.strictEqual(card.total, 750);
  assert.strictEqual(card.hasClientEmail, true);
  assert.strictEqual(card.followUpIntents, null);
});

test('helper: fires equally on status=overdue (both cohorts of the sent/overdue split)', () => {
  const card = routes.buildOverdueInvoiceCard(
    baseOverdueInvoice({ status: 'overdue' }),
    { now: NOW }
  );
  assert.ok(card);
  assert.strictEqual(card.daysPastDue, 7);
});

test('helper: urgencyTier bucketed by daysPastDue (mild < moderate < serious < severe)', () => {
  const cases = [
    { days: 1, tier: 'mild' },
    { days: 3, tier: 'mild' },
    { days: 4, tier: 'moderate' },
    { days: 13, tier: 'moderate' },
    { days: 14, tier: 'serious' },
    { days: 29, tier: 'serious' },
    { days: 30, tier: 'severe' },
    { days: 90, tier: 'severe' }
  ];
  for (const { days, tier } of cases) {
    const due = new Date(NOW.getTime() - days * 86400000);
    const card = routes.buildOverdueInvoiceCard(baseOverdueInvoice({ due_date: due }), { now: NOW });
    assert.ok(card, `days=${days} card returned`);
    assert.strictEqual(card.daysPastDue, days, `days=${days}`);
    assert.strictEqual(card.urgencyTier, tier, `days=${days} tier`);
  }
});

test('helper: daysPastDue floors partial-day gaps AND clamps to at least 1 (never zero when past due)', () => {
  // 6 hours past due → floor is 0, but we clamp to 1 (the invoice IS past due).
  const card = routes.buildOverdueInvoiceCard(
    baseOverdueInvoice({ due_date: new Date(NOW.getTime() - 6 * 3600000) }),
    { now: NOW }
  );
  assert.ok(card);
  assert.strictEqual(card.daysPastDue, 1);
  assert.strictEqual(card.urgencyTier, 'mild');
});

test('helper: coerces malformed total to 0 (string / null / NaN defence)', () => {
  const nullTotal = routes.buildOverdueInvoiceCard(baseOverdueInvoice({ total: null }), { now: NOW });
  assert.strictEqual(nullTotal.total, 0);
  const badTotal = routes.buildOverdueInvoiceCard(baseOverdueInvoice({ total: 'not-a-number' }), { now: NOW });
  assert.strictEqual(badTotal.total, 0);
  const stringTotal = routes.buildOverdueInvoiceCard(baseOverdueInvoice({ total: '1234.50' }), { now: NOW });
  assert.strictEqual(stringTotal.total, 1234.5);
});

test('helper: clientName trimmed; hasClientEmail reflects trimmed content only', () => {
  const trimmed = routes.buildOverdueInvoiceCard(
    baseOverdueInvoice({ client_name: '  Acme Corp  ' }),
    { now: NOW }
  );
  assert.strictEqual(trimmed.clientName, 'Acme Corp');
  const wsEmail = routes.buildOverdueInvoiceCard(
    baseOverdueInvoice({ client_email: '   ' }),
    { now: NOW }
  );
  assert.strictEqual(wsEmail.hasClientEmail, false);
  const noEmail = routes.buildOverdueInvoiceCard(
    baseOverdueInvoice({ client_email: '' }),
    { now: NOW }
  );
  assert.strictEqual(noEmail.hasClientEmail, false);
});

test('helper: accepts due_date as ISO string too (pg driver difference tolerance)', () => {
  const card = routes.buildOverdueInvoiceCard(
    baseOverdueInvoice({ due_date: '2026-08-25T00:00:00Z' }),
    { now: NOW }
  );
  assert.ok(card);
  assert.strictEqual(card.daysPastDue, 7);
});

test('helper: followUpIntents passed through by identity when a valid object; null otherwise', () => {
  const intents = baseIntents();
  const withIntents = routes.buildOverdueInvoiceCard(baseOverdueInvoice(), { now: NOW, followUpIntents: intents });
  assert.strictEqual(withIntents.followUpIntents, intents);
  const withNonObject = routes.buildOverdueInvoiceCard(baseOverdueInvoice(), { now: NOW, followUpIntents: 'not-an-object' });
  assert.strictEqual(withNonObject.followUpIntents, null);
  const withNull = routes.buildOverdueInvoiceCard(baseOverdueInvoice(), { now: NOW, followUpIntents: null });
  assert.strictEqual(withNull.followUpIntents, null);
});

// ---- Layer 2: invoice-view.ejs render -----------------------------------

const invoiceViewTplPath = path.join(__dirname, '..', 'views', 'invoice-view.ejs');
const invoiceViewTpl = fs.readFileSync(invoiceViewTplPath, 'utf8');

function renderInvoiceView(locals) {
  const defaults = {
    title: 'Invoice INV-2026-0088',
    invoice: {
      id: 88,
      invoice_number: 'INV-2026-0088',
      status: 'sent',
      client_name: 'Acme Corp',
      client_email: 'ap@acme.example',
      client_address: '',
      total: '750.00', subtotal: 750, tax_rate: 0, tax_amount: 0,
      items: [{ description: 'Design work', quantity: 1, unit_price: 750 }],
      due_date: new Date('2026-08-25T00:00:00Z'),
      issued_date: new Date('2026-07-25T00:00:00Z'),
      is_seed: false,
      payment_link_url: null
    },
    user: { id: 1, plan: 'pro', email: 'me@x.example', name: 'Sam', business_name: 'Sam Co', invoice_count: 5 },
    flash: null,
    paymentMethods: [],
    prefetchedShare: null,
    clientViewStatus: null,
    overdueInvoiceCard: null,
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

test('view: card OMITTED when overdueInvoiceCard is null', () => {
  const html = renderInvoiceView({ overdueInvoiceCard: null });
  assert.doesNotMatch(html, /data-testid="overdue-invoice-card"/);
});

test('view: card renders with days-past-due count + client name for a 7-day-late invoice', () => {
  const html = renderInvoiceView({
    overdueInvoiceCard: {
      daysPastDue: 7,
      urgencyTier: 'moderate',
      dueDateIso: '2026-08-25T00:00:00.000Z',
      clientName: 'Acme Corp',
      invoiceNumber: 'INV-2026-0088',
      total: 750,
      hasClientEmail: true,
      followUpIntents: baseIntents()
    }
  });
  const block = html.match(/data-testid="overdue-invoice-card"[\s\S]{0,5000}/);
  assert.ok(block, 'card rendered');
  assert.match(block[0], /data-days-past-due="7"/);
  assert.match(block[0], /data-urgency-tier="moderate"/);
  assert.match(block[0], /data-testid="overdue-invoice-card-days"[^>]*>7</);
  assert.match(block[0], /days past due/);
  assert.match(block[0], /data-testid="overdue-invoice-card-client-name"[^>]*>Acme Corp</);
});

test('view: singular "1 day past due" copy for daysPastDue === 1', () => {
  const html = renderInvoiceView({
    overdueInvoiceCard: {
      daysPastDue: 1, urgencyTier: 'mild', dueDateIso: 'x',
      clientName: 'Acme Corp', invoiceNumber: 'INV-2026-0088',
      total: 750, hasClientEmail: true, followUpIntents: null
    }
  });
  const block = html.match(/data-testid="overdue-invoice-card"[\s\S]{0,3000}/);
  assert.ok(block);
  assert.match(block[0], /data-testid="overdue-invoice-card-days"[^>]*>1</);
  assert.match(block[0], /1<\/span>\s*day past due/);
  assert.doesNotMatch(block[0], /1<\/span>\s*days past due/);
});

test('view: copy pivots per urgencyTier (mild / moderate / serious / severe)', () => {
  const mk = (tier, days) => ({
    overdueInvoiceCard: {
      daysPastDue: days, urgencyTier: tier, dueDateIso: 'x',
      clientName: 'Acme', invoiceNumber: 'X', total: 100, hasClientEmail: false, followUpIntents: null
    }
  });
  const mildHtml = renderInvoiceView(mk('mild', 2));
  const modHtml = renderInvoiceView(mk('moderate', 7));
  const serHtml = renderInvoiceView(mk('serious', 21));
  const sevHtml = renderInvoiceView(mk('severe', 45));
  assert.match(mildHtml, /Just past the due date/);
  assert.match(modHtml, /paid this week/);
  assert.match(serHtml, /Two weeks past due/);
  assert.match(sevHtml, /month past due/);
});

test('view: Mark-as-Paid form targets POST /invoices/:id/status with status=paid + _csrf', () => {
  const html = renderInvoiceView({
    invoice: {
      id: 4242, invoice_number: 'INV-2026-4242', status: 'overdue',
      client_name: 'Acme Corp', client_email: 'ap@acme.example', client_address: '',
      total: '250.00', subtotal: 250, tax_rate: 0, tax_amount: 0,
      items: [{ description: 'X', quantity: 1, unit_price: 250 }],
      due_date: new Date('2026-08-01T00:00:00Z'),
      issued_date: new Date('2026-07-01T00:00:00Z'),
      is_seed: false, payment_link_url: null
    },
    overdueInvoiceCard: {
      daysPastDue: 30, urgencyTier: 'severe', dueDateIso: 'x',
      clientName: 'Acme Corp', invoiceNumber: 'INV-2026-4242',
      total: 250, hasClientEmail: true, followUpIntents: null
    }
  });
  const block = html.match(/data-testid="overdue-invoice-card"[\s\S]*?<\/div>\s*<\/div>/);
  assert.ok(block, 'card block found');
  const formTag = block[0].match(/<form[^>]*data-testid="overdue-invoice-card-mark-paid-form"[^>]*>/);
  assert.ok(formTag, 'mark-paid form tag found');
  assert.match(formTag[0], /action="\/invoices\/4242\/status"/);
  assert.match(formTag[0], /method="POST"/);
  // Isolate the form body so csrf/status hidden fields are unambiguous.
  const formBody = block[0].match(/data-testid="overdue-invoice-card-mark-paid-form"[\s\S]*?<\/form>/);
  assert.ok(formBody);
  assert.match(formBody[0], /name="_csrf"[^>]*value="TEST_CSRF"/);
  assert.match(formBody[0], /name="status"[^>]*value="paid"/);
  assert.match(formBody[0], /data-testid="overdue-invoice-card-mark-paid-button"/);
});

test('view: follow-up cluster rendered when followUpIntents present (whatsapp/sms/email/copy)', () => {
  const html = renderInvoiceView({
    overdueInvoiceCard: {
      daysPastDue: 5, urgencyTier: 'moderate', dueDateIso: 'x',
      clientName: 'Acme', invoiceNumber: 'INV-1', total: 100, hasClientEmail: true,
      followUpIntents: baseIntents()
    }
  });
  const block = html.match(/data-testid="overdue-invoice-card"[\s\S]{0,6000}/);
  assert.ok(block);
  // Attribute order in the rendered tag is href first, testid later — match
  // the tag as a whole so the assertion is order-independent.
  const waTag = block[0].match(/<a[^>]*data-testid="overdue-invoice-card-followup-whatsapp"[^>]*>/);
  assert.ok(waTag, 'whatsapp tag');
  assert.match(waTag[0], /href="https:\/\/wa.me\/\?text=x"/);
  const smsTag = block[0].match(/<a[^>]*data-testid="overdue-invoice-card-followup-sms"[^>]*>/);
  assert.ok(smsTag, 'sms tag');
  assert.match(smsTag[0], /href="sms:\?body=x"/);
  const emailTag = block[0].match(/<a[^>]*data-testid="overdue-invoice-card-followup-email"[^>]*>/);
  assert.ok(emailTag, 'email tag');
  assert.match(emailTag[0], /href="mailto:ap@acme.example[^"]*"/);
  assert.match(block[0], /data-testid="overdue-invoice-card-followup-copy"/);
  assert.match(block[0], /data-share-url="https:\/\/app.example\/i\/tok123"/);
});

test('view: follow-up cluster is OMITTED when followUpIntents is null (mint hiccup)', () => {
  const html = renderInvoiceView({
    overdueInvoiceCard: {
      daysPastDue: 3, urgencyTier: 'mild', dueDateIso: 'x',
      clientName: 'Acme', invoiceNumber: 'INV-1', total: 100, hasClientEmail: false,
      followUpIntents: null
    }
  });
  const block = html.match(/data-testid="overdue-invoice-card"[\s\S]{0,4000}/);
  assert.ok(block);
  assert.doesNotMatch(block[0], /overdue-invoice-card-followup-whatsapp/);
  assert.doesNotMatch(block[0], /overdue-invoice-card-followup-sms/);
  assert.doesNotMatch(block[0], /overdue-invoice-card-followup-email/);
  assert.doesNotMatch(block[0], /overdue-invoice-card-followup-copy/);
  // Mark-as-Paid still renders even without intents — reconciliation is the primary CTA.
  assert.match(block[0], /overdue-invoice-card-mark-paid-form/);
});

test('view: Email chase link is OMITTED when followUpIntents.mailto is missing (no client_email)', () => {
  const intents = baseIntents();
  delete intents.mailto;
  const html = renderInvoiceView({
    overdueInvoiceCard: {
      daysPastDue: 5, urgencyTier: 'moderate', dueDateIso: 'x',
      clientName: 'Acme', invoiceNumber: 'INV-1', total: 100, hasClientEmail: false,
      followUpIntents: intents
    }
  });
  const block = html.match(/data-testid="overdue-invoice-card"[\s\S]{0,4000}/);
  assert.ok(block);
  assert.doesNotMatch(block[0], /overdue-invoice-card-followup-email/);
  // WhatsApp / SMS / Copy still there.
  assert.match(block[0], /overdue-invoice-card-followup-whatsapp/);
  assert.match(block[0], /overdue-invoice-card-followup-sms/);
  assert.match(block[0], /overdue-invoice-card-followup-copy/);
});

test('view: card carries print:hidden so it never leaks into a downloaded PDF', () => {
  const html = renderInvoiceView({
    overdueInvoiceCard: {
      daysPastDue: 7, urgencyTier: 'moderate', dueDateIso: 'x',
      clientName: 'Acme', invoiceNumber: 'X', total: 750, hasClientEmail: true, followUpIntents: null
    }
  });
  const block = html.match(/data-testid="overdue-invoice-card"[\s\S]{0,800}/);
  assert.ok(block);
  assert.match(block[0], /print:hidden/);
});

test('view: card renders ABOVE the client-view-status card AND above the invoice preview card', () => {
  const html = renderInvoiceView({
    clientViewStatus: {
      viewed: false, viewCount: 0, isOverdue: true, sentAtIso: 'x',
      sentDaysAgo: 7, firstViewedAtIso: null, lastViewedAtIso: null,
      hoursSinceLastView: null, followUpIntents: null
    },
    overdueInvoiceCard: {
      daysPastDue: 7, urgencyTier: 'moderate', dueDateIso: 'x',
      clientName: 'Acme', invoiceNumber: 'X', total: 750, hasClientEmail: true, followUpIntents: null
    }
  });
  const overdueIdx = html.indexOf('data-testid="overdue-invoice-card"');
  const cvsIdx = html.indexOf('data-testid="client-view-status-card"');
  const previewIdx = html.indexOf('<!-- Invoice preview card -->');
  assert.ok(overdueIdx > 0, 'overdue card present');
  assert.ok(cvsIdx > 0, 'client-view-status card present');
  assert.ok(previewIdx > 0, 'invoice preview present');
  assert.ok(overdueIdx < cvsIdx, 'overdue card must render BEFORE the client-view-status card');
  assert.ok(cvsIdx < previewIdx, 'client-view-status card must render BEFORE the invoice preview');
});

test('view: hostile client name is HTML-escaped in the header (no injection via client_name)', () => {
  const html = renderInvoiceView({
    overdueInvoiceCard: {
      daysPastDue: 5, urgencyTier: 'moderate', dueDateIso: 'x',
      clientName: '<script>alert(1)</script>', invoiceNumber: 'INV-1',
      total: 100, hasClientEmail: false, followUpIntents: null
    }
  });
  const block = html.match(/data-testid="overdue-invoice-card"[\s\S]{0,3000}/);
  assert.ok(block);
  assert.doesNotMatch(block[0], /<script>alert\(1\)<\/script>/);
  assert.match(block[0], /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

// ---- Runner --------------------------------------------------------------

(async () => {
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log('  ✓', name);
      passed++;
    } catch (err) {
      console.error('  ✗', name);
      console.error(err && err.stack ? err.stack : err);
      failed++;
    }
  }
  console.log(`\noverdue-invoice-card.test.js — ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
