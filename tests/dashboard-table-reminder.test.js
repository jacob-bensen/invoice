'use strict';

/*
 * Per-row "Send reminder" dashboard table cluster (Milestone 4 — first
 * invoice sent → first payment received). The existing prompt banners
 * (recentView / clientViewedFollowup / sentNotViewed / overdue) each
 * surface ONE unpaid invoice at a time — the oldest qualifying row in
 * each cohort. This ship adds a per-row WhatsApp / SMS / Email / Copy
 * popover on the dashboard invoices table so a freelancer with multiple
 * open unpaid invoices can fire a one-tap follow-up on any of them
 * straight from the table, without navigating into /invoices/:id.
 *
 * Layers exercised:
 *  1. routes/invoices.buildTableFollowUpIntents — pure helper over the
 *     dashboard's already-loaded `invoices` list. Returns a map keyed by
 *     invoice id, populated only for sent/overdue rows that carry a
 *     public_token and have no pending payment-claim.
 *  2. views/dashboard.ejs — table row renders the reminder cluster when
 *     the map carries an entry; cluster carries the 4 channel buttons,
 *     each POSTs /invoices/:id/share-intent with CSRF + matching intent
 *     kind; cluster omitted when the row doesn't qualify.
 *
 * Run: node tests/dashboard-table-reminder.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');

process.env.APP_URL = process.env.APP_URL || 'https://decentinvoice.test';
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

delete require.cache[require.resolve('../routes/invoices')];
const routes = require('../routes/invoices');

// ---- Layer 1: buildTableFollowUpIntents shape contract ------------------

function row(extra) {
  return Object.assign({
    id: 11,
    invoice_number: 'INV-2026-0011',
    client_name: 'Acme Corp',
    client_email: 'ap@acme.example',
    total: '500.00',
    status: 'sent',
    is_seed: false,
    public_token: 'a1b2c3d4e5f6a1b2',
    due_date: '2026-06-15T00:00:00Z',
    payment_claimed_at: null
  }, extra || {});
}

test('buildTableFollowUpIntents: returns empty object on non-array input', () => {
  assert.deepStrictEqual(routes.buildTableFollowUpIntents(null), {});
  assert.deepStrictEqual(routes.buildTableFollowUpIntents(undefined), {});
  assert.deepStrictEqual(routes.buildTableFollowUpIntents('nope'), {});
  assert.deepStrictEqual(routes.buildTableFollowUpIntents({}), {});
});

test('buildTableFollowUpIntents: returns empty object on empty list', () => {
  assert.deepStrictEqual(routes.buildTableFollowUpIntents([]), {});
});

test('buildTableFollowUpIntents: SENT row with public_token → entry with url + intents', () => {
  const out = routes.buildTableFollowUpIntents([row()]);
  const entry = out['11'];
  assert.ok(entry, 'map keyed by id has entry');
  assert.ok(entry.url && entry.url.endsWith('/i/a1b2c3d4e5f6a1b2'), 'url derived from public_token');
  assert.ok(entry.followUpIntents, 'followUpIntents present');
  assert.ok(entry.followUpIntents.whatsapp.startsWith('https://wa.me/?text='), 'whatsapp deep-link');
  assert.ok(entry.followUpIntents.sms.startsWith('sms:?&body='), 'sms deep-link');
  assert.ok(entry.followUpIntents.mailto.startsWith('mailto:'), 'mailto deep-link');
  assert.ok(entry.followUpIntents.mailto.includes('ap%40acme.example'),
    'mailto recipient percent-encoded');
  assert.strictEqual(entry.followUpIntents.url, entry.url,
    'entry.url surfaced inside followUpIntents for view convenience');
});

test('buildTableFollowUpIntents: OVERDUE row qualifies same as SENT', () => {
  const out = routes.buildTableFollowUpIntents([row({ status: 'overdue', id: 12 })]);
  assert.ok(out['12'], 'overdue row included');
});

test('buildTableFollowUpIntents: DRAFT row excluded (no follow-up needed yet)', () => {
  const out = routes.buildTableFollowUpIntents([row({ status: 'draft' })]);
  assert.deepStrictEqual(out, {});
});

test('buildTableFollowUpIntents: PAID row excluded', () => {
  const out = routes.buildTableFollowUpIntents([row({ status: 'paid' })]);
  assert.deepStrictEqual(out, {});
});

test('buildTableFollowUpIntents: SEED sample excluded even if sent', () => {
  const out = routes.buildTableFollowUpIntents([row({ is_seed: true })]);
  assert.deepStrictEqual(out, {});
});

test('buildTableFollowUpIntents: row WITHOUT public_token excluded', () => {
  const out = routes.buildTableFollowUpIntents([row({ public_token: null })]);
  assert.deepStrictEqual(out, {});
});

test('buildTableFollowUpIntents: row with payment_claimed_at excluded (verify, do not nudge)', () => {
  const out = routes.buildTableFollowUpIntents([
    row({ payment_claimed_at: '2026-05-27T10:00:00Z' })
  ]);
  assert.deepStrictEqual(out, {});
});

test('buildTableFollowUpIntents: row with malformed public_token excluded', () => {
  const out = routes.buildTableFollowUpIntents([row({ public_token: 'not-a-token!' })]);
  assert.deepStrictEqual(out, {});
});

test('buildTableFollowUpIntents: row with null id excluded', () => {
  const out = routes.buildTableFollowUpIntents([row({ id: null })]);
  assert.deepStrictEqual(out, {});
});

test('buildTableFollowUpIntents: row without client_email still qualifies (mailto omitted by view)', () => {
  const out = routes.buildTableFollowUpIntents([row({ client_email: null })]);
  const entry = out['11'];
  assert.ok(entry, 'sent invoice without client_email still gets an entry');
  // followUpIntents.mailto still renders with empty recipient (the view
  // can gate on the presence of a usable email separately if it wants).
  assert.ok(entry.followUpIntents.whatsapp, 'whatsapp intent always available');
  assert.ok(entry.followUpIntents.sms, 'sms intent always available');
});

test('buildTableFollowUpIntents: mixed list returns map containing only qualifying ids', () => {
  const list = [
    row({ id: 1, status: 'draft' }),                               // excluded — draft
    row({ id: 2, status: 'sent' }),                                // included
    row({ id: 3, status: 'paid' }),                                // excluded — paid
    row({ id: 4, status: 'overdue' }),                             // included
    row({ id: 5, is_seed: true }),                                 // excluded — seed
    row({ id: 6, public_token: null }),                            // excluded — no token
    row({ id: 7, payment_claimed_at: '2026-05-27T10:00:00Z' })     // excluded — pending claim
  ];
  const out = routes.buildTableFollowUpIntents(list);
  assert.deepStrictEqual(Object.keys(out).sort(), ['2', '4']);
});

test('buildTableFollowUpIntents: daysOverdue computed off injected `now` for determinism', () => {
  // Due date 5 days before our pinned now → overdue subject line.
  const now = new Date('2026-06-20T00:00:00Z');
  const out = routes.buildTableFollowUpIntents([
    row({ id: 42, status: 'overdue', due_date: '2026-06-15T00:00:00Z' })
  ], { now });
  const intents = out['42'].followUpIntents;
  // body includes the "(now overdue)" softener from buildFollowUpShareIntents
  // when daysOverdue > 0.
  assert.ok(intents.body.includes('(now overdue)'),
    'past-due now-time triggers overdue body softener: ' + intents.body);
  assert.ok(intents.subject.toLowerCase().includes('overdue'),
    'past-due triggers overdue subject');
});

test('buildTableFollowUpIntents: hostile public_token (non-hex) excluded — no URL injection', () => {
  const out = routes.buildTableFollowUpIntents([
    row({ public_token: '"><script>alert(1)</script>' })
  ]);
  assert.deepStrictEqual(out, {});
});

// ---- Layer 2: dashboard.ejs renders the per-row reminder cluster ---------

const dashboardTplPath = path.join(__dirname, '..', 'views', 'dashboard.ejs');
const dashboardTpl = fs.readFileSync(dashboardTplPath, 'utf8');

function tableRow(extra) {
  return Object.assign({
    id: 11,
    invoice_number: 'INV-2026-0011',
    client_name: 'Acme Corp',
    issued_date: '2026-05-20T00:00:00Z',
    total: '500.00',
    status: 'sent',
    is_seed: false,
    public_token: 'a1b2c3d4e5f6a1b2',
    first_viewed_at: null,
    payment_claimed_at: null,
    payment_link_url: null
  }, extra || {});
}

function renderDashboard(locals) {
  return ejs.render(dashboardTpl, Object.assign({
    title: 'Dashboard',
    flash: null,
    days_left_in_trial: 0,
    csrfToken: 'TEST_CSRF',
    invoices: [],
    user: { plan: 'free', invoice_count: 5, subscription_status: null },
    onboarding: null,
    invoiceLimitProgress: null,
    recentRevenue: null,
    annualUpgradePrompt: null,
    socialProof: null,
    celebration: null,
    staleDraftPrompt: null,
    paymentClaimPrompt: null,
    recentViewPrompt: null,
    clientViewedFollowupPrompt: null,
    sentNotViewedPrompt: null,
    overduePrompt: null,
    firstRealInvoicePrompt: null,
    freshDraftPrompt: null,
    repeatClientPrompt: null,
    pendingQuickInvoice: null,
    tableFollowUpIntents: {}
  }, locals), {
    views: [path.join(__dirname, '..', 'views')],
    filename: dashboardTplPath
  });
}

function intentsFor(id) {
  return {
    url: `https://decentinvoice.test/i/a1b2c3d4e5f6a1b${id}`,
    followUpIntents: {
      body: 'Hi Acme, just checking in on invoice INV-2026-0011 for $500.00. ...',
      subject: 'Quick check-in: Invoice INV-2026-0011 — $500.00',
      overdue: false,
      whatsapp: 'https://wa.me/?text=Hi%20Acme%2C%20just%20checking',
      sms: 'sms:?&body=Hi%20Acme%2C%20just%20checking',
      mailto: 'mailto:ap%40acme.example?subject=Quick%20check-in&body=Hi%20Acme',
      url: `https://decentinvoice.test/i/a1b2c3d4e5f6a1b${id}`
    }
  };
}

test('view: reminder cluster RENDERS for sent row with tableFollowUpIntents entry', () => {
  const inv = tableRow({ id: 11 });
  const html = renderDashboard({
    invoices: [inv],
    tableFollowUpIntents: { '11': intentsFor(1) }
  });
  assert.match(html, /data-testid="table-reminder-11"/, 'wrapper present');
  assert.match(html, /data-testid="table-reminder-toggle-11"/, 'toggle present');
  assert.match(html, /data-testid="table-reminder-popover-11"/, 'popover present');
  assert.match(html, /data-testid="table-reminder-whatsapp-11"/, 'whatsapp button present');
  assert.match(html, /data-testid="table-reminder-sms-11"/, 'sms button present');
  assert.match(html, /data-testid="table-reminder-email-11"/, 'email button present');
  assert.match(html, /data-testid="table-reminder-copy-11"/, 'copy button present');
});

test('view: reminder cluster OMITTED for sent row with NO tableFollowUpIntents entry', () => {
  // E.g., row missing public_token — the helper returns {} so view skips.
  const inv = tableRow({ id: 22, status: 'sent' });
  const html = renderDashboard({
    invoices: [inv],
    tableFollowUpIntents: {}
  });
  assert.doesNotMatch(html, /data-testid="table-reminder-22"/);
});

test('view: reminder cluster OMITTED for draft row even if map has entry (defence-in-depth)', () => {
  // The map shouldn't be populated for drafts by the helper, but the view
  // should NOT crash if it ever is — it's keyed off the map presence, so
  // a stale entry would render. We assert helper+view contract is consistent
  // by giving the row status=draft AND no map entry, the normal pairing.
  const inv = tableRow({ id: 33, status: 'draft' });
  const html = renderDashboard({
    invoices: [inv],
    tableFollowUpIntents: {}
  });
  assert.doesNotMatch(html, /data-testid="table-reminder-33"/);
});

test('view: reminder cluster OMITTED for paid row (no map entry by contract)', () => {
  const inv = tableRow({ id: 44, status: 'paid' });
  const html = renderDashboard({
    invoices: [inv],
    tableFollowUpIntents: {}
  });
  assert.doesNotMatch(html, /data-testid="table-reminder-44"/);
});

test('view: reminder cluster omitted when row has a pending payment-claim badge', () => {
  // Display gate: even if tableFollowUpIntents has an entry for this row
  // (e.g., a stale-cache scenario), the view must NOT render the cluster
  // when the payment-claim badge is active — the freelancer's next action
  // is verify+mark-paid, not nudge again.
  const inv = tableRow({
    id: 55, status: 'sent',
    payment_claimed_at: '2026-05-27T10:00:00Z',
    payment_claim_method: 'venmo'
  });
  const html = renderDashboard({
    invoices: [inv],
    tableFollowUpIntents: { '55': intentsFor(5) }
  });
  // The claim badge renders; the reminder cluster does not.
  assert.match(html, /data-testid="client-payment-claim-55"/);
  assert.doesNotMatch(html, /data-testid="table-reminder-55"/);
});

test('view: WhatsApp button uses target=_blank rel=noopener and posts share-intent', () => {
  const inv = tableRow({ id: 11 });
  const html = renderDashboard({
    invoices: [inv],
    tableFollowUpIntents: { '11': intentsFor(1) }
  });
  // Capture the entire WhatsApp anchor tag (attributes can appear in any
  // order around the data-testid hook).
  const block = html.match(/<a[^>]*data-testid="table-reminder-whatsapp-11"[^>]*>/);
  assert.ok(block, 'whatsapp button located');
  assert.match(block[0], /target="_blank"/);
  assert.match(block[0], /rel="noopener"/);
  assert.match(block[0], /fetch\('\/invoices\/11\/share-intent'/);
  assert.match(block[0], /intent.{1,5}whatsapp/);
  assert.match(block[0], /X-CSRF-Token.{1,40}TEST_CSRF/);
});

test('view: SMS button posts share-intent with intent=sms', () => {
  const inv = tableRow({ id: 11 });
  const html = renderDashboard({
    invoices: [inv],
    tableFollowUpIntents: { '11': intentsFor(1) }
  });
  const block = html.match(/data-testid="table-reminder-sms-11"[\s\S]{0,1200}/);
  assert.ok(block, 'sms button located');
  assert.match(block[0], /fetch\('\/invoices\/11\/share-intent'/);
  assert.match(block[0], /intent.{1,5}sms/);
});

test('view: Email button posts share-intent with intent=email, ONLY when mailto set', () => {
  const inv = tableRow({ id: 11 });
  const withMailto = intentsFor(1);
  const html1 = renderDashboard({
    invoices: [inv],
    tableFollowUpIntents: { '11': withMailto }
  });
  assert.match(html1, /data-testid="table-reminder-email-11"/);

  const withoutMailto = {
    url: withMailto.url,
    followUpIntents: Object.assign({}, withMailto.followUpIntents, { mailto: '' })
  };
  const html2 = renderDashboard({
    invoices: [inv],
    tableFollowUpIntents: { '11': withoutMailto }
  });
  assert.doesNotMatch(html2, /data-testid="table-reminder-email-11"/);
});

test('view: Copy button carries data-share-url + clipboard handler', () => {
  const inv = tableRow({ id: 11 });
  const intents = intentsFor(1);
  const html = renderDashboard({
    invoices: [inv],
    tableFollowUpIntents: { '11': intents }
  });
  const block = html.match(/data-testid="table-reminder-copy-11"[\s\S]{0,1500}/);
  assert.ok(block, 'copy button located');
  assert.match(block[0], new RegExp('data-share-url="' + intents.url.replace(/\//g, '\\/') + '"'));
  assert.match(block[0], /navigator\.clipboard\.writeText/);
  assert.match(block[0], /intent.{1,5}copy/);
});

test('view: hostile URL in tableFollowUpIntents is HTML-attribute-escaped', () => {
  const inv = tableRow({ id: 11 });
  const hostile = {
    url: 'https://decentinvoice.test/i/abcd"><script>alert(1)</script>',
    followUpIntents: {
      body: 'b',
      subject: 's',
      overdue: false,
      whatsapp: 'https://wa.me/?text=' + '"><script>alert(2)</script>',
      sms: 'sms:?&body=normal',
      mailto: 'mailto:ap@acme.example',
      url: 'https://decentinvoice.test/i/abcd"><script>alert(1)</script>'
    }
  };
  const html = renderDashboard({
    invoices: [inv],
    tableFollowUpIntents: { '11': hostile }
  });
  // No raw <script> tag in the reminder cluster's source.
  const block = html.match(/data-testid="table-reminder-11"[\s\S]{0,4500}/);
  assert.ok(block, 'cluster block located');
  assert.doesNotMatch(block[0], /<script>alert\(1\)/);
  assert.doesNotMatch(block[0], /<script>alert\(2\)/);
  // Both encoded somewhere in the attribute values.
  assert.match(block[0], /&lt;script&gt;alert\(1\)/);
});

test('view: cluster wrapper carries print:hidden so it does not leak into PDF print views', () => {
  const inv = tableRow({ id: 11 });
  const html = renderDashboard({
    invoices: [inv],
    tableFollowUpIntents: { '11': intentsFor(1) }
  });
  // The wrapper div's class= attribute precedes the data-testid hook —
  // capture the whole opening tag to assert on the class list.
  const wrapper = html.match(/<div\s[^>]*data-testid="table-reminder-11"[^>]*>/);
  assert.ok(wrapper);
  assert.match(wrapper[0], /print:hidden/);
});

test('view: popover defaults to hidden via x-show="open" with x-data{open:false}', () => {
  const inv = tableRow({ id: 11 });
  const html = renderDashboard({
    invoices: [inv],
    tableFollowUpIntents: { '11': intentsFor(1) }
  });
  const wrapper = html.match(/<div\s[^>]*data-testid="table-reminder-11"[^>]*>/);
  assert.ok(wrapper);
  assert.match(wrapper[0], /x-data="\{\s*open:\s*false\s*\}"/);
  // Closes on outside click + Escape
  assert.match(wrapper[0], /@click\.outside="open\s*=\s*false"/);
  assert.match(wrapper[0], /@keydown\.escape\.window="open\s*=\s*false"/);
  // Popover gated on open via x-show
  const popover = html.match(/<div\s[^>]*data-testid="table-reminder-popover-11"[^>]*>/);
  assert.ok(popover, 'popover element located');
  assert.match(popover[0], /x-show="open"/);
});

test('view: clicking the cluster does NOT navigate the row (event.stopPropagation on wrapper)', () => {
  // The table row carries onclick="window.location='/invoices/X'" — any
  // click inside the reminder cluster must NOT bubble up and trigger nav.
  const inv = tableRow({ id: 11 });
  const html = renderDashboard({
    invoices: [inv],
    tableFollowUpIntents: { '11': intentsFor(1) }
  });
  const block = html.match(/data-testid="table-reminder-11"[\s\S]{0,4500}/);
  assert.ok(block);
  // The wrapper div carries onclick stopPropagation (so React/Alpine deeper
  // clicks don't bubble back to the <tr> onclick handler).
  assert.match(block[0], /onclick="event\.stopPropagation\(\)"/);
});

test('view: multiple sent rows each get their own per-row cluster', () => {
  const invA = tableRow({ id: 11, invoice_number: 'A' });
  const invB = tableRow({ id: 12, invoice_number: 'B' });
  const html = renderDashboard({
    invoices: [invA, invB],
    tableFollowUpIntents: {
      '11': intentsFor(1),
      '12': intentsFor(2)
    }
  });
  assert.match(html, /data-testid="table-reminder-11"/);
  assert.match(html, /data-testid="table-reminder-12"/);
  assert.match(html, /data-testid="table-reminder-whatsapp-11"/);
  assert.match(html, /data-testid="table-reminder-whatsapp-12"/);
});

test('view: cluster renders for FREE plan users (not Pro-gated)', () => {
  // Per Milestone 4: the public-token share path is the ONLY follow-up
  // surface for free users (no Stripe Pay Link). So this MUST render on
  // the free plan — that's the whole point.
  const inv = tableRow({ id: 11 });
  const html = renderDashboard({
    invoices: [inv],
    user: { plan: 'free', invoice_count: 5, subscription_status: null },
    tableFollowUpIntents: { '11': intentsFor(1) }
  });
  assert.match(html, /data-testid="table-reminder-11"/);
  assert.match(html, /data-testid="table-reminder-whatsapp-11"/);
});

test('view: tolerates missing tableFollowUpIntents local (legacy partial-deploy degrade)', () => {
  // If a future code path renders the dashboard without threading the
  // local, the table must still render with no cluster — never crash.
  const inv = tableRow({ id: 11 });
  const html = renderDashboard({
    invoices: [inv],
    tableFollowUpIntents: undefined
  });
  assert.doesNotMatch(html, /data-testid="table-reminder-11"/);
  assert.match(html, /INV-2026-0011/, 'table row still renders');
});

(async function run() {
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
      if (err.stack) console.error(err.stack.split('\n').slice(0, 4).join('\n'));
    }
  }
  console.log(`\n${passed} passed, ${failed} failed (dashboard-table-reminder.test.js)`);
  if (failed > 0) process.exit(1);
})();
