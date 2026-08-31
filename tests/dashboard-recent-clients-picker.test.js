'use strict';

/*
 * Dashboard "Invoice a recent client" quick-picker — a compact chip cluster
 * above the invoice table that surfaces the freelancer's top-3 recent
 * clients as one-tap links into /invoices/quick with the client_name /
 * client_email / client_phone pre-filled off the URL. Advances Milestone
 * 2 → Milestone 3 by collapsing the "start a repeat-client invoice"
 * loop to a single tap from the dashboard.
 *
 * Layers:
 *  1. buildRecentClientsQuickPicker(user, invoices, recentClients) — pure
 *     helper. Returns { clients: [{name, email, phone}] } or null.
 *  2. dashboard.ejs render block — card + chips; hostile names escaped;
 *     URLs percent-encoded; positioned above the invoice table.
 *
 * Run: NODE_ENV=test node tests/dashboard-recent-clients-picker.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

delete require.cache[require.resolve('../routes/invoices')];
const routes = require('../routes/invoices');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ---- Layer 1: buildRecentClientsQuickPicker -----------------------------

const realInvoice = { id: 1, is_seed: false, status: 'paid' };
const seedInvoice = { id: 99, is_seed: true, status: 'draft' };

test('helper: null when user is missing', () => {
  assert.strictEqual(
    routes.buildRecentClientsQuickPicker(null, [realInvoice], [{ client_name: 'A' }]),
    null
  );
});

test('helper: null when invoices is not an array', () => {
  assert.strictEqual(
    routes.buildRecentClientsQuickPicker({ plan: 'pro' }, null, [{ client_name: 'A' }]),
    null
  );
});

test('helper: null when recentClients is not an array', () => {
  assert.strictEqual(
    routes.buildRecentClientsQuickPicker({ plan: 'pro' }, [realInvoice], null),
    null
  );
});

test('helper: null when the user has zero real invoices (day-zero cohort)', () => {
  // firstRealInvoicePrompt owns the empty-state surface; the picker must
  // not fire until the freelancer has actually created a non-seed invoice.
  assert.strictEqual(
    routes.buildRecentClientsQuickPicker({ plan: 'pro' }, [], [{ client_name: 'A' }]),
    null
  );
  assert.strictEqual(
    routes.buildRecentClientsQuickPicker({ plan: 'pro' }, [seedInvoice], [{ client_name: 'A' }]),
    null
  );
});

test('helper: null when free-tier user is at the 3-invoice cap', () => {
  // The invoice-limit banner owns the upgrade CTA; every prefilled chip
  // would just bounce to /invoices?limit_hit=1.
  const user = { plan: 'free', invoice_count: 3 };
  assert.strictEqual(
    routes.buildRecentClientsQuickPicker(user, [realInvoice], [{ client_name: 'A' }]),
    null
  );
});

test('helper: renders for free-tier user BELOW the cap', () => {
  const user = { plan: 'free', invoice_count: 2 };
  const out = routes.buildRecentClientsQuickPicker(user, [realInvoice], [{ client_name: 'A' }]);
  assert.ok(out);
  assert.strictEqual(out.clients.length, 1);
});

test('helper: null when recentClients has zero usable entries (all empty names)', () => {
  const user = { plan: 'pro' };
  assert.strictEqual(
    routes.buildRecentClientsQuickPicker(user, [realInvoice], []),
    null
  );
  assert.strictEqual(
    routes.buildRecentClientsQuickPicker(user, [realInvoice], [{ client_name: '' }]),
    null
  );
  assert.strictEqual(
    routes.buildRecentClientsQuickPicker(user, [realInvoice], [{ client_name: '   ' }]),
    null
  );
  assert.strictEqual(
    routes.buildRecentClientsQuickPicker(user, [realInvoice], [{ client_name: null }]),
    null
  );
});

test('helper: caps clients at RECENT_CLIENTS_PICKER_MAX (3)', () => {
  const user = { plan: 'pro' };
  const many = [
    { client_name: 'A' }, { client_name: 'B' }, { client_name: 'C' },
    { client_name: 'D' }, { client_name: 'E' }
  ];
  const out = routes.buildRecentClientsQuickPicker(user, [realInvoice], many);
  assert.ok(out);
  assert.strictEqual(routes.RECENT_CLIENTS_PICKER_MAX, 3);
  assert.strictEqual(out.clients.length, 3);
  assert.deepStrictEqual(out.clients.map((c) => c.name), ['A', 'B', 'C']);
});

test('helper: trims whitespace from name / email / phone', () => {
  const user = { plan: 'agency' };
  const out = routes.buildRecentClientsQuickPicker(user, [realInvoice], [
    { client_name: '  Acme  ', client_email: '  ap@acme.co  ', client_phone: '  555  ' }
  ]);
  assert.ok(out);
  assert.deepStrictEqual(out.clients[0], { name: 'Acme', email: 'ap@acme.co', phone: '555' });
});

test('helper: skips rows with missing name but keeps rows with only phone empty', () => {
  const user = { plan: 'pro' };
  const rows = [
    { client_name: 'Acme', client_email: 'ap@acme.co' },
    { client_name: '', client_email: 'nope@x.co', client_phone: '555' },
    { client_name: 'Bravo', client_email: null, client_phone: null }
  ];
  const out = routes.buildRecentClientsQuickPicker(user, [realInvoice], rows);
  assert.ok(out);
  assert.deepStrictEqual(out.clients.map((c) => c.name), ['Acme', 'Bravo']);
  assert.strictEqual(out.clients[1].email, '');
  assert.strictEqual(out.clients[1].phone, '');
});

test('helper: ignores non-string email / phone fields (defence-in-depth)', () => {
  const user = { plan: 'pro' };
  const out = routes.buildRecentClientsQuickPicker(user, [realInvoice], [
    { client_name: 'Acme', client_email: 42, client_phone: { x: 1 } }
  ]);
  assert.ok(out);
  assert.strictEqual(out.clients[0].email, '');
  assert.strictEqual(out.clients[0].phone, '');
});

// ---- Layer 2: dashboard.ejs render --------------------------------------

const dashboardTplPath = path.join(__dirname, '..', 'views', 'dashboard.ejs');
const dashboardTpl = fs.readFileSync(dashboardTplPath, 'utf8');

function renderDashboard(locals) {
  return ejs.render(dashboardTpl, Object.assign({
    title: 'Dashboard',
    flash: null,
    days_left_in_trial: 0,
    csrfToken: 'TEST_CSRF',
    invoices: [{ id: 1, invoice_number: 'INV-0001', client_name: 'Anyone', status: 'sent', total: '100.00', is_seed: false, items: [] }],
    user: { id: 1, plan: 'pro', invoice_count: 5, subscription_status: null },
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
    paymentInstructionsPrompt: null,
    recentClientsQuickPicker: null,
    pendingQuickInvoice: null,
    tableFollowUpIntents: {},
    tableSendIntents: {},
    currency: 'USD',
    currencySymbol: '$'
  }, locals), {
    views: [path.join(__dirname, '..', 'views')],
    filename: dashboardTplPath
  });
}

test('view: card OMITTED when recentClientsQuickPicker is null', () => {
  const html = renderDashboard({ recentClientsQuickPicker: null });
  assert.doesNotMatch(html, /data-testid="recent-clients-quick-picker"/);
});

test('view: card RENDERS when picker set', () => {
  const html = renderDashboard({
    recentClientsQuickPicker: {
      clients: [
        { name: 'Acme Corp', email: 'ap@acme.co', phone: '555-1234' },
        { name: 'Bravo LLC', email: '', phone: '' }
      ]
    }
  });
  assert.match(html, /data-testid="recent-clients-quick-picker"/);
  const chipMatches = html.match(/data-testid="recent-clients-quick-picker-chip"/g);
  assert.ok(chipMatches);
  assert.strictEqual(chipMatches.length, 2);
});

test('view: each chip href points at /invoices/quick with URL-encoded params', () => {
  const html = renderDashboard({
    recentClientsQuickPicker: {
      clients: [
        { name: 'Acme & Co', email: 'ap+billing@acme.co', phone: '+1 (555) 555-1234' }
      ]
    }
  });
  const block = html.match(/data-testid="recent-clients-quick-picker"[\s\S]{0,1400}/);
  assert.ok(block);
  const hrefMatch = block[0].match(/href="([^"]+)"/);
  assert.ok(hrefMatch, 'chip href present');
  const href = hrefMatch[1].replace(/&amp;/g, '&');
  assert.ok(href.startsWith('/invoices/quick?'), 'points at /invoices/quick with query');
  assert.ok(href.includes('client_name=Acme%20%26%20Co'), 'name percent-encoded (space + ampersand)');
  assert.ok(href.includes('client_email=ap%2Bbilling%40acme.co'), 'email percent-encoded (+, @)');
  assert.ok(href.includes('client_phone=%2B1%20(555)%20555-1234'), 'phone percent-encoded (+)');
});

test('view: chip omits missing email / phone params from the URL', () => {
  const html = renderDashboard({
    recentClientsQuickPicker: {
      clients: [{ name: 'JustName', email: '', phone: '' }]
    }
  });
  const block = html.match(/data-testid="recent-clients-quick-picker"[\s\S]{0,1400}/);
  const hrefMatch = block[0].match(/href="([^"]+)"/);
  const href = hrefMatch[1].replace(/&amp;/g, '&');
  assert.strictEqual(href, '/invoices/quick?client_name=JustName');
  assert.doesNotMatch(href, /client_email=/);
  assert.doesNotMatch(href, /client_phone=/);
});

test('view: hostile client name is HTML-escaped in the visible label', () => {
  const hostile = '<script>alert(1)</script>';
  const html = renderDashboard({
    recentClientsQuickPicker: {
      clients: [{ name: hostile, email: '', phone: '' }]
    }
  });
  const block = html.match(/data-testid="recent-clients-quick-picker"[\s\S]{0,1400}/);
  assert.ok(block);
  assert.doesNotMatch(block[0], /<script>alert\(1\)<\/script>/);
  assert.match(block[0], /&lt;script&gt;/);
});

test('view: card carries print:hidden so it does not leak into PDF prints', () => {
  const html = renderDashboard({
    recentClientsQuickPicker: {
      clients: [{ name: 'Acme', email: '', phone: '' }]
    }
  });
  const block = html.match(/data-testid="recent-clients-quick-picker"[\s\S]{0,600}/);
  assert.ok(block);
  assert.match(block[0], /print:hidden/);
});

test('view: card sits ABOVE the invoice table', () => {
  const html = renderDashboard({
    recentClientsQuickPicker: {
      clients: [{ name: 'Acme', email: '', phone: '' }]
    }
  });
  const pickerIdx = html.indexOf('data-testid="recent-clients-quick-picker"');
  const tableIdx = html.indexOf('id="invoices-table"');
  assert.ok(pickerIdx > 0, 'picker present');
  assert.ok(tableIdx > 0, 'invoices table present');
  assert.ok(pickerIdx < tableIdx, 'picker must render BEFORE the invoice table');
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
      if (err.stack) console.error(err.stack.split('\n').slice(0, 4).join('\n'));
    }
  }
  console.log(`\n${passed} passed, ${failed} failed (dashboard-recent-clients-picker.test.js)`);
  if (failed > 0) process.exit(1);
})();
