'use strict';

/*
 * Per-row "Send now" dashboard table cluster for DRAFT rows (Milestone 3 —
 * first invoice created → first invoice sent, PLAN.md's biggest single
 * drop-off). The freshDraft / staleDraft banners each surface exactly ONE
 * draft, so a freelancer holding several unsent drafts could only reach one
 * of them in a tap. This ship gives every qualifying draft row its own
 * WhatsApp / SMS / Email / Copy cluster (plus the Pro/Agency server-side
 * "Email it now" button) straight from the invoices table.
 *
 * Layers exercised:
 *  1. routes/invoices.buildTableSendIntents — pure helper over the
 *     dashboard's already-loaded `invoices` list + user row. Keyed by
 *     invoice id, populated only for non-seed drafts with a valid
 *     public_token, carrying first-send (not follow-up) copy.
 *  2. views/dashboard.ejs — draft row renders the cluster when the map has
 *     an entry; the Pro direct-email button replaces the mailto: fallback;
 *     every channel POSTs /invoices/:id/share-intent with CSRF.
 *
 * Run: node tests/dashboard-table-send.test.js
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

// ---- Layer 1: buildTableSendIntents shape contract ----------------------

function row(extra) {
  return Object.assign({
    id: 11,
    invoice_number: 'INV-2026-0011',
    client_name: 'Acme Corp',
    client_email: 'ap@acme.example',
    total: '500.00',
    status: 'draft',
    is_seed: false,
    public_token: 'a1b2c3d4e5f6a1b2',
    due_date: '2026-06-15T00:00:00Z'
  }, extra || {});
}

const freeUser = { plan: 'free' };
const proUser = { plan: 'pro' };

test('buildTableSendIntents: empty object on non-array input', () => {
  assert.deepStrictEqual(routes.buildTableSendIntents(null, freeUser), {});
  assert.deepStrictEqual(routes.buildTableSendIntents(undefined, freeUser), {});
  assert.deepStrictEqual(routes.buildTableSendIntents('nope', freeUser), {});
  assert.deepStrictEqual(routes.buildTableSendIntents({}, freeUser), {});
  assert.deepStrictEqual(routes.buildTableSendIntents([], freeUser), {});
});

test('buildTableSendIntents: DRAFT row with public_token → entry with url + first-send intents', () => {
  const out = routes.buildTableSendIntents([row()], freeUser);
  const entry = out['11'];
  assert.ok(entry, 'map keyed by id has entry');
  assert.ok(entry.url.endsWith('/i/a1b2c3d4e5f6a1b2'), 'url derived from public_token');
  assert.ok(entry.shareIntents.whatsapp.startsWith('https://wa.me/?text='), 'whatsapp deep-link');
  assert.ok(entry.shareIntents.sms.startsWith('sms:?&body='), 'sms deep-link');
  assert.ok(entry.shareIntents.mailto.includes('ap%40acme.example'),
    'mailto recipient percent-encoded');
  assert.strictEqual(entry.shareIntents.url, entry.url,
    'entry.url surfaced inside shareIntents for view convenience');
});

test('buildTableSendIntents: body is first-send copy, NOT follow-up copy', () => {
  // A draft has never been sent — "just checking in" would be a lie the
  // client can catch. Guards against a refactor swapping the surface for
  // buildTableFollowUpIntents' followUpIntents.
  const intents = routes.buildTableSendIntents([row()], freeUser)['11'].shareIntents;
  assert.ok(intents.body.includes("here's invoice INV-2026-0011"),
    'first-send body: ' + intents.body);
  assert.ok(!intents.body.includes('checking in'), 'not the follow-up body');
  assert.strictEqual(intents.subject, 'Invoice INV-2026-0011 — $500.00');
});

test('buildTableSendIntents: SENT / OVERDUE / PAID rows excluded', () => {
  assert.deepStrictEqual(routes.buildTableSendIntents([row({ status: 'sent' })], freeUser), {});
  assert.deepStrictEqual(routes.buildTableSendIntents([row({ status: 'overdue' })], freeUser), {});
  assert.deepStrictEqual(routes.buildTableSendIntents([row({ status: 'paid' })], freeUser), {});
});

test('buildTableSendIntents: SEED sample draft excluded', () => {
  assert.deepStrictEqual(routes.buildTableSendIntents([row({ is_seed: true })], freeUser), {});
});

test('buildTableSendIntents: row without a usable public_token excluded', () => {
  assert.deepStrictEqual(routes.buildTableSendIntents([row({ public_token: null })], freeUser), {});
  assert.deepStrictEqual(routes.buildTableSendIntents([row({ public_token: 'not-a-token!' })], freeUser), {});
  assert.deepStrictEqual(
    routes.buildTableSendIntents([row({ public_token: '"><script>alert(1)</script>' })], freeUser),
    {}, 'hostile token rejected — no URL injection');
});

test('buildTableSendIntents: row with null id excluded', () => {
  assert.deepStrictEqual(routes.buildTableSendIntents([row({ id: null })], freeUser), {});
});

test('buildTableSendIntents: directEmail true only for pro/agency WITH a client email', () => {
  assert.strictEqual(routes.buildTableSendIntents([row()], freeUser)['11'].directEmail, false,
    'free plan → mailto: fallback');
  assert.strictEqual(routes.buildTableSendIntents([row()], proUser)['11'].directEmail, true,
    'pro plan with client email → server-side send');
  assert.strictEqual(
    routes.buildTableSendIntents([row()], { plan: 'agency' })['11'].directEmail, true,
    'agency plan → server-side send');
  assert.strictEqual(
    routes.buildTableSendIntents([row({ client_email: '  ' })], proUser)['11'].directEmail, false,
    'blank client email → no server-side send');
  assert.strictEqual(routes.buildTableSendIntents([row()], null)['11'].directEmail, false,
    'missing user row → no server-side send');
});

test('buildTableSendIntents: clientEmail trimmed for the button label', () => {
  const entry = routes.buildTableSendIntents([row({ client_email: '  ap@acme.example ' })], proUser)['11'];
  assert.strictEqual(entry.clientEmail, 'ap@acme.example');
});

test('buildTableSendIntents: mixed list returns only qualifying draft ids', () => {
  const out = routes.buildTableSendIntents([
    row({ id: 1, status: 'draft' }),               // included
    row({ id: 2, status: 'sent' }),                // excluded — already sent
    row({ id: 3, status: 'paid' }),                // excluded — paid
    row({ id: 4, status: 'draft', is_seed: true }),// excluded — seed
    row({ id: 5, status: 'draft', public_token: null }), // excluded — no token
    row({ id: 6, status: 'draft' })                // included
  ], freeUser);
  assert.deepStrictEqual(Object.keys(out).sort(), ['1', '6']);
});

// ---- Layer 2: dashboard.ejs renders the per-row send cluster ------------

const dashboardTplPath = path.join(__dirname, '..', 'views', 'dashboard.ejs');
const dashboardTpl = fs.readFileSync(dashboardTplPath, 'utf8');

function tableRow(extra) {
  return Object.assign({
    id: 11,
    invoice_number: 'INV-2026-0011',
    client_name: 'Acme Corp',
    issued_date: '2026-05-20T00:00:00Z',
    total: '500.00',
    status: 'draft',
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
    tableFollowUpIntents: {},
    tableSendIntents: {}
  }, locals), {
    views: [path.join(__dirname, '..', 'views')],
    filename: dashboardTplPath
  });
}

function sendEntry(extra) {
  const url = 'https://decentinvoice.test/i/a1b2c3d4e5f6a1b2';
  return Object.assign({
    url,
    shareIntents: {
      body: "Hi Acme Corp, here's invoice INV-2026-0011 for $500.00. View it here: " + url,
      subject: 'Invoice INV-2026-0011 — $500.00',
      whatsapp: 'https://wa.me/?text=Hi%20Acme%20Corp',
      sms: 'sms:?&body=Hi%20Acme%20Corp',
      mailto: 'mailto:ap%40acme.example?subject=Invoice&body=Hi%20Acme%20Corp',
      url
    },
    directEmail: false,
    clientEmail: 'ap@acme.example'
  }, extra || {});
}

test('view: send cluster RENDERS for a draft row with a map entry', () => {
  const html = renderDashboard({
    invoices: [tableRow()],
    tableSendIntents: { '11': sendEntry() }
  });
  assert.match(html, /data-testid="table-send-11"/, 'wrapper present');
  assert.match(html, /data-testid="table-send-toggle-11"/, 'toggle present');
  assert.match(html, /data-testid="table-send-popover-11"/, 'popover present');
  assert.match(html, /data-testid="table-send-whatsapp-11"/, 'whatsapp button');
  assert.match(html, /data-testid="table-send-sms-11"/, 'sms button');
  assert.match(html, /data-testid="table-send-email-11"/, 'mailto button');
  assert.match(html, /data-testid="table-send-copy-11"/, 'copy button');
});

test('view: send cluster OMITTED when the map has no entry for the row', () => {
  const html = renderDashboard({
    invoices: [tableRow({ id: 22 })],
    tableSendIntents: {}
  });
  assert.doesNotMatch(html, /data-testid="table-send-22"/);
  assert.match(html, /INV-2026-0011/, 'table row still renders');
});

test('view: tolerates a missing tableSendIntents local (legacy partial-deploy degrade)', () => {
  const html = renderDashboard({
    invoices: [tableRow()],
    tableSendIntents: undefined
  });
  assert.doesNotMatch(html, /data-testid="table-send-11"/);
  assert.match(html, /INV-2026-0011/, 'table row still renders');
});

test('view: WhatsApp button opens in a new tab and posts intent=whatsapp with CSRF', () => {
  const html = renderDashboard({
    invoices: [tableRow()],
    tableSendIntents: { '11': sendEntry() }
  });
  const block = html.match(/<a[^>]*data-testid="table-send-whatsapp-11"[^>]*>/);
  assert.ok(block, 'whatsapp button located');
  assert.match(block[0], /target="_blank"/);
  assert.match(block[0], /rel="noopener"/);
  assert.match(block[0], /fetch\('\/invoices\/11\/share-intent'/);
  assert.match(block[0], /intent.{1,5}whatsapp/);
  assert.match(block[0], /X-CSRF-Token.{1,40}TEST_CSRF/);
});

test('view: SMS and Copy buttons post their own intent kinds', () => {
  const html = renderDashboard({
    invoices: [tableRow()],
    tableSendIntents: { '11': sendEntry() }
  });
  const sms = html.match(/<a[^>]*data-testid="table-send-sms-11"[^>]*>/);
  assert.ok(sms, 'sms button located');
  assert.match(sms[0], /fetch\('\/invoices\/11\/share-intent'/);
  assert.match(sms[0], /intent.{1,5}sms/);

  const copy = html.match(/<button[^>]*data-testid="table-send-copy-11"[^>]*>/);
  assert.ok(copy, 'copy button located');
  assert.match(copy[0], /intent.{1,5}copy/);
  assert.match(copy[0], /data-share-url="https:\/\/decentinvoice\.test\/i\/a1b2c3d4e5f6a1b2"/);
});

test('view: Pro direct-email button REPLACES the mailto: fallback', () => {
  const html = renderDashboard({
    invoices: [tableRow()],
    user: { plan: 'pro', invoice_count: 5, subscription_status: 'active' },
    tableSendIntents: { '11': sendEntry({ directEmail: true }) }
  });
  assert.match(html, /data-testid="table-send-direct-email-11"/, 'direct-email button present');
  assert.doesNotMatch(html, /data-testid="table-send-email-11"/,
    'mailto: fallback suppressed — one email affordance, not two');
  const block = html.match(/<button[^>]*data-testid="table-send-direct-email-11"[^>]*>/);
  assert.match(block[0], /emailSendDirect\(\)/, 'wired to the direct-send handler');
  assert.match(html, /fetch\('\/invoices\/11\/email-client'/, 'posts to the server-side send route');
  assert.match(html, /data-testid="table-send-direct-email-error-11"/, 'inline error slot present');
});

test('view: mailto: fallback omitted when the entry carries no mailto', () => {
  const entry = sendEntry();
  entry.shareIntents.mailto = '';
  const html = renderDashboard({
    invoices: [tableRow()],
    tableSendIntents: { '11': entry }
  });
  assert.doesNotMatch(html, /data-testid="table-send-email-11"/);
  assert.match(html, /data-testid="table-send-whatsapp-11"/, 'other channels unaffected');
});

test('view: cluster click does not bubble to the row navigation handler', () => {
  const html = renderDashboard({
    invoices: [tableRow()],
    tableSendIntents: { '11': sendEntry() }
  });
  // The wrapper's x-data contains `=>` arrow functions, so a `[^>]*` tag
  // match won't span it — assert over the attribute window just before the
  // testid instead.
  const wrapper = html.match(/onclick="event\.stopPropagation\(\)"\s*\n\s*data-testid="table-send-11"/);
  assert.ok(wrapper,
    'row-level window.location navigation must not fire on a cluster tap');
});

test('view: multiple drafts each get an independently keyed cluster', () => {
  const html = renderDashboard({
    invoices: [
      tableRow({ id: 11 }),
      tableRow({ id: 12, invoice_number: 'INV-2026-0012' }),
      tableRow({ id: 13, invoice_number: 'INV-2026-0013', status: 'sent' })
    ],
    tableSendIntents: { '11': sendEntry(), '12': sendEntry() }
  });
  assert.match(html, /data-testid="table-send-toggle-11"/);
  assert.match(html, /data-testid="table-send-toggle-12"/);
  assert.doesNotMatch(html, /data-testid="table-send-13"/, 'sent row gets no send cluster');
});

test('view: draft row shows the send cluster but NOT the mark-paid or reminder clusters', () => {
  const html = renderDashboard({
    invoices: [tableRow()],
    tableSendIntents: { '11': sendEntry() },
    tableFollowUpIntents: {}
  });
  assert.match(html, /data-testid="table-send-11"/);
  assert.doesNotMatch(html, /data-testid="table-mark-paid-11"/,
    'an unsent draft cannot be marked paid from the table');
  assert.doesNotMatch(html, /data-testid="table-reminder-11"/,
    'an unsent draft has nothing to remind about');
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
  console.log(`\n${passed} passed, ${failed} failed (dashboard-table-send.test.js)`);
  if (failed > 0) process.exit(1);
})();
