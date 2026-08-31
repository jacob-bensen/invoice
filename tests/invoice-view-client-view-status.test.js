'use strict';

/*
 * Client-view status card on /invoices/:id (Milestones 3 → 4).
 *
 * Answers the freelancer's single most common on-page question after the
 * invoice has left their outbox: did the client actually see this yet, and
 * is it time to nudge them? Two rendered shapes:
 *
 *   1. viewed:false → amber "Hasn't been opened yet" state, with a
 *      follow-up channel row so the freelancer can re-share on a different
 *      channel (their first channel didn't land).
 *   2. viewed:true → emerald "Opened by your client" state, with view
 *      count + last-viewed relative time + a follow-up nudge cluster
 *      (still unpaid = opportunity to close).
 *
 * Card short-circuits to null for draft (draft-send-banner owns that),
 * paid (celebration path owns that), and the seed sample. Runs on every
 * sent / overdue invoice regardless of plan.
 *
 * Layers:
 *   1. buildClientViewStatusCard(invoice, opts) — pure helper. Returns
 *      { viewed, viewCount, sentDaysAgo, ... } or null.
 *   2. invoice-view.ejs render block — amber / emerald cards with
 *      follow-up intents, positioned above the invoice preview card,
 *      print:hidden so it never leaks into a downloaded PDF.
 *
 * Run: NODE_ENV=test node tests/invoice-view-client-view-status.test.js
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

function baseSentInvoice(overrides) {
  return Object.assign({
    id: 42,
    status: 'sent',
    is_seed: false,
    view_count: 0,
    first_viewed_at: null,
    last_viewed_at: null,
    sent_via_share_view_at: null,
    sent_via_share_intent_at: null,
    updated_at: new Date('2026-08-30T12:00:00Z')
  }, overrides || {});
}

function sampleIntents() {
  return {
    url: 'https://app.example/i/deadbeefdeadbeef',
    whatsapp: 'https://wa.me/15550001111?text=hey',
    sms: 'sms:+15550001111?&body=hey',
    mailto: 'mailto:client@x.example?subject=hi&body=hey',
    subject: 'Quick check-in',
    body: 'Hey — checking in.'
  };
}

// ---- Layer 1: buildClientViewStatusCard ---------------------------------

test('helper: null when invoice is missing / non-object', () => {
  assert.strictEqual(routes.buildClientViewStatusCard(null), null);
  assert.strictEqual(routes.buildClientViewStatusCard(undefined), null);
  assert.strictEqual(routes.buildClientViewStatusCard('not-an-invoice'), null);
});

test('helper: null for draft (draft-send-banner owns that surface)', () => {
  const inv = baseSentInvoice({ status: 'draft' });
  assert.strictEqual(routes.buildClientViewStatusCard(inv, { now: NOW }), null);
});

test('helper: null for paid (celebration path owns that surface)', () => {
  const inv = baseSentInvoice({ status: 'paid', view_count: 5 });
  assert.strictEqual(routes.buildClientViewStatusCard(inv, { now: NOW }), null);
});

test('helper: null for the seed sample even when its status looks sent', () => {
  const inv = baseSentInvoice({ is_seed: true, status: 'sent' });
  assert.strictEqual(routes.buildClientViewStatusCard(inv, { now: NOW }), null);
});

test('helper: null for an unrecognised status (belt + braces against schema drift)', () => {
  const inv = baseSentInvoice({ status: 'archived' });
  assert.strictEqual(routes.buildClientViewStatusCard(inv, { now: NOW }), null);
});

test('helper: sent with view_count=0 → not-viewed card with sentDaysAgo', () => {
  const inv = baseSentInvoice({
    view_count: 0,
    updated_at: new Date('2026-08-28T12:00:00Z') // 4 days before NOW
  });
  const card = routes.buildClientViewStatusCard(inv, { now: NOW });
  assert.ok(card, 'card returned');
  assert.strictEqual(card.viewed, false);
  assert.strictEqual(card.viewCount, 0);
  assert.strictEqual(card.isOverdue, false);
  assert.strictEqual(card.sentDaysAgo, 4);
  assert.strictEqual(card.firstViewedAtIso, null);
  assert.strictEqual(card.lastViewedAtIso, null);
  assert.strictEqual(card.hoursSinceLastView, null);
});

test('helper: overdue with view_count=0 → not-viewed card, isOverdue=true', () => {
  const inv = baseSentInvoice({
    status: 'overdue',
    view_count: 0,
    updated_at: new Date('2026-08-01T12:00:00Z') // 31 days before
  });
  const card = routes.buildClientViewStatusCard(inv, { now: NOW });
  assert.ok(card);
  assert.strictEqual(card.viewed, false);
  assert.strictEqual(card.isOverdue, true);
  assert.strictEqual(card.sentDaysAgo, 31);
});

test('helper: sent with view_count >= 1 → viewed card with first/last stamps + hoursSinceLastView', () => {
  const inv = baseSentInvoice({
    view_count: 3,
    first_viewed_at: new Date('2026-08-30T18:00:00Z'), // 42h before NOW
    last_viewed_at: new Date('2026-09-01T09:00:00Z'), // 3h before NOW
    sent_via_share_view_at: new Date('2026-08-30T15:00:00Z')
  });
  const card = routes.buildClientViewStatusCard(inv, { now: NOW });
  assert.ok(card);
  assert.strictEqual(card.viewed, true);
  assert.strictEqual(card.viewCount, 3);
  assert.strictEqual(card.hoursSinceLastView, 3);
  assert.strictEqual(card.firstViewedAtIso, '2026-08-30T18:00:00.000Z');
  assert.strictEqual(card.lastViewedAtIso, '2026-09-01T09:00:00.000Z');
});

test('helper: viewed with only first_viewed_at (last stamp missing) falls back to first stamp', () => {
  // Legacy row that was viewed once before the last_viewed_at column existed.
  const inv = baseSentInvoice({
    view_count: 1,
    first_viewed_at: new Date('2026-09-01T10:00:00Z'), // 2h before NOW
    last_viewed_at: null
  });
  const card = routes.buildClientViewStatusCard(inv, { now: NOW });
  assert.strictEqual(card.viewed, true);
  assert.strictEqual(card.hoursSinceLastView, 2);
  assert.strictEqual(card.lastViewedAtIso, '2026-09-01T10:00:00.000Z');
});

test('helper: coerces non-integer view_count and clamps at zero for negative / NaN', () => {
  // A malformed pg return or hand-edited row must not turn a "not viewed"
  // invoice into a viewed one via a truthy-but-non-numeric value.
  const notViewedFromString = routes.buildClientViewStatusCard(
    baseSentInvoice({ view_count: '0' }), { now: NOW }
  );
  assert.strictEqual(notViewedFromString.viewed, false);

  const notViewedFromNaN = routes.buildClientViewStatusCard(
    baseSentInvoice({ view_count: 'not-a-number' }), { now: NOW }
  );
  assert.strictEqual(notViewedFromNaN.viewed, false);
  assert.strictEqual(notViewedFromNaN.viewCount, 0);

  const notViewedFromNegative = routes.buildClientViewStatusCard(
    baseSentInvoice({ view_count: -5 }), { now: NOW }
  );
  assert.strictEqual(notViewedFromNegative.viewed, false);
  assert.strictEqual(notViewedFromNegative.viewCount, 0);

  const viewedFromStringInt = routes.buildClientViewStatusCard(
    baseSentInvoice({
      view_count: '2',
      first_viewed_at: new Date('2026-09-01T09:00:00Z'),
      last_viewed_at: new Date('2026-09-01T11:00:00Z')
    }),
    { now: NOW }
  );
  assert.strictEqual(viewedFromStringInt.viewed, true);
  assert.strictEqual(viewedFromStringInt.viewCount, 2);
});

test('helper: sent timestamp preference is share_view > share_intent > updated_at', () => {
  const only_share_view = routes.buildClientViewStatusCard(
    baseSentInvoice({
      sent_via_share_view_at: new Date('2026-08-30T00:00:00Z'), // 2d20h before
      sent_via_share_intent_at: new Date('2026-08-25T00:00:00Z'),
      updated_at: new Date('2026-08-20T00:00:00Z')
    }),
    { now: NOW }
  );
  assert.strictEqual(only_share_view.sentAtIso, '2026-08-30T00:00:00.000Z');
  assert.strictEqual(only_share_view.sentDaysAgo, 2);

  const share_intent_only = routes.buildClientViewStatusCard(
    baseSentInvoice({
      sent_via_share_view_at: null,
      sent_via_share_intent_at: new Date('2026-08-25T00:00:00Z'), // 7d12h before
      updated_at: new Date('2026-08-20T00:00:00Z')
    }),
    { now: NOW }
  );
  assert.strictEqual(share_intent_only.sentAtIso, '2026-08-25T00:00:00.000Z');
  assert.strictEqual(share_intent_only.sentDaysAgo, 7);

  const updated_at_fallback = routes.buildClientViewStatusCard(
    baseSentInvoice({
      sent_via_share_view_at: null,
      sent_via_share_intent_at: null,
      updated_at: new Date('2026-08-20T00:00:00Z') // 12d12h before
    }),
    { now: NOW }
  );
  assert.strictEqual(updated_at_fallback.sentAtIso, '2026-08-20T00:00:00.000Z');
  assert.strictEqual(updated_at_fallback.sentDaysAgo, 12);

  const no_timestamps = routes.buildClientViewStatusCard(
    baseSentInvoice({
      sent_via_share_view_at: null,
      sent_via_share_intent_at: null,
      updated_at: null
    }),
    { now: NOW }
  );
  assert.strictEqual(no_timestamps.sentAtIso, null);
  assert.strictEqual(no_timestamps.sentDaysAgo, null);
});

test('helper: threads followUpIntents through when provided; null when not', () => {
  const intents = sampleIntents();
  const withIntents = routes.buildClientViewStatusCard(
    baseSentInvoice({ view_count: 0 }),
    { now: NOW, followUpIntents: intents }
  );
  assert.strictEqual(withIntents.followUpIntents, intents,
    'passes the object through by identity so the render layer can access url/whatsapp/sms/mailto');

  const withoutIntents = routes.buildClientViewStatusCard(
    baseSentInvoice({ view_count: 0 }),
    { now: NOW }
  );
  assert.strictEqual(withoutIntents.followUpIntents, null);

  const withBadIntents = routes.buildClientViewStatusCard(
    baseSentInvoice({ view_count: 0 }),
    { now: NOW, followUpIntents: 'not-an-object' }
  );
  assert.strictEqual(withBadIntents.followUpIntents, null);
});

test('helper: sentDaysAgo never goes negative when the sent timestamp is in the future (clock skew)', () => {
  const inv = baseSentInvoice({
    updated_at: new Date('2026-09-05T00:00:00Z') // 4 days AFTER NOW
  });
  const card = routes.buildClientViewStatusCard(inv, { now: NOW });
  assert.strictEqual(card.sentDaysAgo, 0);
});

test('helper: hoursSinceLastView never goes negative when last_viewed_at is in the future', () => {
  const inv = baseSentInvoice({
    view_count: 1,
    first_viewed_at: new Date('2026-08-30T00:00:00Z'),
    last_viewed_at: new Date('2026-09-05T00:00:00Z') // future
  });
  const card = routes.buildClientViewStatusCard(inv, { now: NOW });
  assert.strictEqual(card.hoursSinceLastView, 0);
});

// ---- Layer 2: invoice-view.ejs render -----------------------------------

const invoiceViewTplPath = path.join(__dirname, '..', 'views', 'invoice-view.ejs');
const invoiceViewTpl = fs.readFileSync(invoiceViewTplPath, 'utf8');

function renderInvoiceView(locals) {
  const defaults = {
    title: 'Invoice INV-2026-0042',
    invoice: {
      id: 42,
      invoice_number: 'INV-2026-0042',
      status: 'sent',
      client_name: 'Acme Corp',
      client_email: 'ap@acme.example',
      client_address: '',
      total: '250.00', subtotal: 250, tax_rate: 0, tax_amount: 0,
      items: [{ description: 'Logo design', quantity: 1, unit_price: 250 }],
      due_date: new Date('2026-09-30'),
      issued_date: new Date('2026-08-30'),
      is_seed: false,
      payment_link_url: null
    },
    user: { id: 1, plan: 'pro', email: 'me@x.example', name: 'Sam', business_name: 'Sam Co' },
    flash: null,
    paymentMethods: [],
    prefetchedShare: null,
    clientViewStatus: null,
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

test('view: card OMITTED when clientViewStatus is null', () => {
  const html = renderInvoiceView({ clientViewStatus: null });
  assert.doesNotMatch(html, /data-testid="client-view-status-card"/);
});

test('view: not-viewed card renders amber block with sentDaysAgo copy + follow-up intents', () => {
  const html = renderInvoiceView({
    clientViewStatus: {
      viewed: false,
      viewCount: 0,
      isOverdue: false,
      sentAtIso: '2026-08-28T12:00:00.000Z',
      sentDaysAgo: 4,
      firstViewedAtIso: null,
      lastViewedAtIso: null,
      hoursSinceLastView: null,
      followUpIntents: sampleIntents()
    }
  });
  const block = html.match(/data-testid="client-view-status-card"[\s\S]{0,5000}/);
  assert.ok(block, 'card rendered');
  assert.match(block[0], /data-view-state="not-viewed"/);
  assert.match(block[0], /data-view-count="0"/);
  assert.match(block[0], /data-sent-days-ago="4"/);
  assert.match(block[0], /hasn&rsquo;t opened this invoice yet/i);
  assert.match(block[0], /data-testid="client-view-status-sent-days-ago"[^>]*>4</);
  assert.match(block[0], /days ago/);
  // Follow-up intents row
  assert.match(block[0], /data-testid="client-view-status-followup-intents"/);
  assert.match(block[0], /data-testid="client-view-status-followup-whatsapp"/);
  assert.match(block[0], /data-testid="client-view-status-followup-sms"/);
  assert.match(block[0], /data-testid="client-view-status-followup-email"/);
  assert.match(block[0], /data-testid="client-view-status-followup-copy"/);
});

test('view: not-viewed card day-0 copy says "earlier today" not a day count', () => {
  const html = renderInvoiceView({
    clientViewStatus: {
      viewed: false, viewCount: 0, isOverdue: false,
      sentAtIso: '2026-09-01T00:00:00.000Z',
      sentDaysAgo: 0,
      firstViewedAtIso: null, lastViewedAtIso: null,
      hoursSinceLastView: null, followUpIntents: null
    }
  });
  const block = html.match(/data-testid="client-view-status-card"[\s\S]{0,1200}/);
  assert.ok(block);
  assert.match(block[0], /earlier today/i);
  assert.doesNotMatch(block[0], /0 days ago/);
});

test('view: not-viewed card handles singular vs plural day count', () => {
  const singular = renderInvoiceView({
    clientViewStatus: {
      viewed: false, viewCount: 0, isOverdue: false,
      sentAtIso: 'x', sentDaysAgo: 1,
      firstViewedAtIso: null, lastViewedAtIso: null,
      hoursSinceLastView: null, followUpIntents: null
    }
  });
  const s = singular.match(/data-testid="client-view-status-card"[\s\S]{0,1500}/);
  assert.ok(s);
  assert.match(s[0], /data-sent-days-ago="1"/);
  assert.match(s[0], />1<\/span> day ago/);
  assert.doesNotMatch(s[0], /days ago/);

  const plural = renderInvoiceView({
    clientViewStatus: {
      viewed: false, viewCount: 0, isOverdue: false,
      sentAtIso: 'x', sentDaysAgo: 12,
      firstViewedAtIso: null, lastViewedAtIso: null,
      hoursSinceLastView: null, followUpIntents: null
    }
  });
  const p = plural.match(/data-testid="client-view-status-card"[\s\S]{0,1500}/);
  assert.match(p[0], /data-sent-days-ago="12"/);
  assert.match(p[0], />12<\/span> days ago/);
});

test('view: viewed card renders emerald block with view count + last-view relative time + nudge intents', () => {
  const html = renderInvoiceView({
    clientViewStatus: {
      viewed: true,
      viewCount: 3,
      isOverdue: false,
      sentAtIso: 'x',
      sentDaysAgo: 2,
      firstViewedAtIso: '2026-08-30T18:00:00.000Z',
      lastViewedAtIso: '2026-09-01T09:00:00.000Z',
      hoursSinceLastView: 3,
      followUpIntents: sampleIntents()
    }
  });
  const block = html.match(/data-testid="client-view-status-card"[\s\S]{0,6000}/);
  assert.ok(block);
  assert.match(block[0], /data-view-state="viewed"/);
  assert.match(block[0], /data-view-count="3"/);
  assert.match(block[0], /data-hours-since-last-view="3"/);
  assert.match(block[0], /opened this invoice/i);
  assert.match(block[0], /data-testid="client-view-status-view-count"[^>]*>3</);
  assert.match(block[0], /3 hours ago/);
  assert.match(block[0], /circling/i, 'multi-view copy variant surfaces the "circling" nudge');
  // Nudge cluster
  assert.match(block[0], /WhatsApp nudge/);
  assert.match(block[0], /SMS nudge/);
  assert.match(block[0], /Email nudge/);
});

test('view: viewed card single-view suppresses the "N times" count', () => {
  const html = renderInvoiceView({
    clientViewStatus: {
      viewed: true, viewCount: 1, isOverdue: false,
      sentAtIso: 'x', sentDaysAgo: 1,
      firstViewedAtIso: 'x', lastViewedAtIso: 'x',
      hoursSinceLastView: 5, followUpIntents: null
    }
  });
  const block = html.match(/data-testid="client-view-status-card"[\s\S]{0,1600}/);
  assert.ok(block);
  assert.doesNotMatch(block[0], /data-testid="client-view-status-view-count"/);
  assert.doesNotMatch(block[0], /circling/i);
  assert.match(block[0], /They&rsquo;ve seen it/);
});

test('view: viewed card "just now" copy for < 1 hour since last view', () => {
  const html = renderInvoiceView({
    clientViewStatus: {
      viewed: true, viewCount: 2, isOverdue: false,
      sentAtIso: 'x', sentDaysAgo: 1,
      firstViewedAtIso: 'x', lastViewedAtIso: 'x',
      hoursSinceLastView: 0, followUpIntents: null
    }
  });
  const block = html.match(/data-testid="client-view-status-card"[\s\S]{0,1600}/);
  assert.ok(block);
  assert.match(block[0], /just now/);
});

test('view: viewed card "N days ago" copy for >= 48 hours since last view', () => {
  const html = renderInvoiceView({
    clientViewStatus: {
      viewed: true, viewCount: 5, isOverdue: true,
      sentAtIso: 'x', sentDaysAgo: 10,
      firstViewedAtIso: 'x', lastViewedAtIso: 'x',
      hoursSinceLastView: 120, // 5 days
      followUpIntents: null
    }
  });
  const block = html.match(/data-testid="client-view-status-card"[\s\S]{0,1600}/);
  assert.ok(block);
  assert.match(block[0], /5 days ago/);
});

test('view: card renders without follow-up intents when they are absent (no share URL)', () => {
  const html = renderInvoiceView({
    clientViewStatus: {
      viewed: false, viewCount: 0, isOverdue: false,
      sentAtIso: 'x', sentDaysAgo: 2,
      firstViewedAtIso: null, lastViewedAtIso: null,
      hoursSinceLastView: null, followUpIntents: null
    }
  });
  const block = html.match(/data-testid="client-view-status-card"[\s\S]{0,1600}/);
  assert.ok(block);
  assert.doesNotMatch(block[0], /data-testid="client-view-status-followup-intents"/);
});

test('view: card carries print:hidden so it never leaks into a downloaded PDF', () => {
  const html = renderInvoiceView({
    clientViewStatus: {
      viewed: false, viewCount: 0, isOverdue: false,
      sentAtIso: 'x', sentDaysAgo: 2,
      firstViewedAtIso: null, lastViewedAtIso: null,
      hoursSinceLastView: null, followUpIntents: null
    }
  });
  const block = html.match(/data-testid="client-view-status-card"[\s\S]{0,400}/);
  assert.ok(block);
  assert.match(block[0], /print:hidden/);
});

test('view: card sits ABOVE the invoice preview card', () => {
  const html = renderInvoiceView({
    clientViewStatus: {
      viewed: true, viewCount: 1, isOverdue: false,
      sentAtIso: 'x', sentDaysAgo: 1,
      firstViewedAtIso: 'x', lastViewedAtIso: 'x',
      hoursSinceLastView: 2, followUpIntents: null
    }
  });
  const cardIdx = html.indexOf('data-testid="client-view-status-card"');
  const invoicePreviewIdx = html.indexOf('<!-- Invoice preview card -->');
  assert.ok(cardIdx > 0, 'card present');
  assert.ok(invoicePreviewIdx > 0, 'invoice preview present');
  assert.ok(cardIdx < invoicePreviewIdx, 'card must render BEFORE the invoice preview');
});

test('view: follow-up mailto is OMITTED when the intents shape has no mailto (missing client_email)', () => {
  const intents = sampleIntents();
  delete intents.mailto;
  const html = renderInvoiceView({
    clientViewStatus: {
      viewed: false, viewCount: 0, isOverdue: false,
      sentAtIso: 'x', sentDaysAgo: 3,
      firstViewedAtIso: null, lastViewedAtIso: null,
      hoursSinceLastView: null, followUpIntents: intents
    }
  });
  const block = html.match(/data-testid="client-view-status-card"[\s\S]{0,3000}/);
  assert.ok(block);
  assert.doesNotMatch(block[0], /data-testid="client-view-status-followup-email"/);
  // WhatsApp / SMS / copy still render.
  assert.match(block[0], /data-testid="client-view-status-followup-whatsapp"/);
  assert.match(block[0], /data-testid="client-view-status-followup-sms"/);
  assert.match(block[0], /data-testid="client-view-status-followup-copy"/);
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
  console.log(`\n${passed} passed, ${failed} failed (invoice-view-client-view-status.test.js)`);
  if (failed > 0) process.exit(1);
})();
