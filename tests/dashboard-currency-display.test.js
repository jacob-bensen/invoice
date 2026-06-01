'use strict';

/*
 * Owner-side dashboard currency display.
 *
 * The per-user default_currency already drove the form totals, the public
 * share page, outbound emails, the invoice-view, and the printed PDF (per
 * owner-currency-display.test.js, multi-currency.test.js, locale-currency.
 * test.js). The dashboard at GET / was the last owner-facing surface still
 * hardcoding '$' on every money cell, so a freelancer in EUR/GBP/JPY
 * landed back from /invoices/new — where their own currency symbol now
 * renders — onto a dashboard that contradicted it with '$' on the all-time
 * totals, every prompt total, the recent-revenue card, the toggle re-render,
 * the invoice table Amount column, and the pending-quick-invoice amount.
 *
 * Milestone-relevance: the user's first dashboard re-entry after signup is
 * the surface that drives Milestone 1 → 2 (re-entered → first real invoice).
 * A currency mismatch at that moment is the kind of "is this product even
 * built for me?" friction that shaves activation. The route now threads
 * `currency` + `currencySymbol` into the EJS locals, and the toggle JSON
 * endpoint surfaces `currencySymbol` so the Alpine factory's formatMoney
 * re-renders totalPaid with the right symbol after a window switch.
 *
 * Covers:
 *  1. Route — GET / passes currencySymbol via locals; the API endpoint
 *     surfaces currencySymbol at the top level of the JSON response.
 *  2. View — every owner-side money cell on the dashboard renders the
 *     symbol from the local: all-time totals (3 cells), recent-revenue
 *     card SSR fallback, invoice table Amount column, every prompt's
 *     total (8 prompts), pending-quick-invoice amount.
 *  3. Alpine factory — receives currencySymbol via x-data; formatMoney
 *     uses this.currencySymbol (not a hardcoded '$') so a window-toggle
 *     re-render keeps the right symbol.
 *  4. Legacy/regression — a USD-defaulted user (or a render with the
 *     local omitted entirely) falls back to '$' on every cell, so existing
 *     callers and the error-path fallback render still produce the
 *     historical shape.
 *
 * Run: node tests/dashboard-currency-display.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

// ---- Layer 1: route plumbing ------------------------------------------

let mockUserById = { id: 1, plan: 'pro', default_currency: 'EUR' };
let mockStats = { totalPaid: 100, invoiceCount: 1, clientCount: 1, unpaidCount: 0 };

const dbStub = {
  pool: { query: async () => ({ rows: [] }) },
  db: {
    getUserById: async () => mockUserById,
    getRecentRevenueStats: async (userId, days) => ({ ...mockStats, days })
  }
};
require.cache[require.resolve('../db')] = {
  id: require.resolve('../db'),
  filename: require.resolve('../db'),
  loaded: true,
  exports: dbStub
};

delete require.cache[require.resolve('../routes/invoices')];
const invoiceRoutes = require('../routes/invoices');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const apiLayer = (invoiceRoutes.stack || []).find((l) =>
  l.route && l.route.path === '/api/recent-revenue'
);

function mockResponse() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    set(n, v) { this.headers[n.toLowerCase()] = v; return this; },
    json(p) { this.body = p; return this; }
  };
}
function mockRequest(query = {}, sessionUser = { id: 1 }) {
  return { query, session: { user: sessionUser } };
}
async function fireApi(req, res) {
  const stack = apiLayer.route.stack;
  await stack[stack.length - 1].handle(req, res, () => {});
}

test('API: currencySymbol € is surfaced at the top level for an EUR user', async () => {
  mockUserById = { id: 1, plan: 'pro', default_currency: 'EUR' };
  mockStats = { totalPaid: 100, invoiceCount: 1, clientCount: 1, unpaidCount: 0 };
  const req = mockRequest({ days: '30' });
  const res = mockResponse();
  await fireApi(req, res);
  assert.strictEqual(res.body.currencySymbol, '€');
});

test('API: currencySymbol £ is surfaced for a GBP user (case-insensitive resolve)', async () => {
  mockUserById = { id: 1, plan: 'pro', default_currency: 'gbp' };
  mockStats = { totalPaid: 100, invoiceCount: 1, clientCount: 1, unpaidCount: 0 };
  const req = mockRequest({ days: '30' });
  const res = mockResponse();
  await fireApi(req, res);
  assert.strictEqual(res.body.currencySymbol, '£');
});

test('API: currencySymbol ¥ is surfaced for a JPY user', async () => {
  mockUserById = { id: 1, plan: 'pro', default_currency: 'JPY' };
  mockStats = { totalPaid: 100, invoiceCount: 1, clientCount: 1, unpaidCount: 0 };
  const req = mockRequest({ days: '7' });
  const res = mockResponse();
  await fireApi(req, res);
  assert.strictEqual(res.body.currencySymbol, '¥');
});

test('API: currencySymbol $ falls back when user.default_currency is missing', async () => {
  mockUserById = { id: 1, plan: 'pro' /* default_currency omitted */ };
  mockStats = { totalPaid: 0, invoiceCount: 0, clientCount: 0, unpaidCount: 2 };
  const req = mockRequest({ days: '30' });
  const res = mockResponse();
  await fireApi(req, res);
  assert.strictEqual(res.body.currencySymbol, '$');
});

test('API: currencySymbol survives the card===null branch (zero paid in window)', async () => {
  // Critical: the toggle JSON re-render must keep the right symbol even when
  // the user toggled to a window with zero paid invoices. The Alpine factory
  // reads data.currencySymbol from this top-level field.
  mockUserById = { id: 1, plan: 'pro', default_currency: 'EUR' };
  mockStats = { totalPaid: 0, invoiceCount: 0, clientCount: 0, unpaidCount: 3 };
  const req = mockRequest({ days: '7' });
  const res = mockResponse();
  await fireApi(req, res);
  assert.strictEqual(res.body.card, null);
  assert.strictEqual(res.body.currencySymbol, '€');
});

// ---- Layer 2-3: view rendering ----------------------------------------

const dashboardTplPath = path.join(__dirname, '..', 'views', 'dashboard.ejs');
const dashboardTpl = fs.readFileSync(dashboardTplPath, 'utf8');

function renderDashboard(overrides = {}) {
  return ejs.render(dashboardTpl, Object.assign({
    title: 'Dashboard',
    flash: null,
    days_left_in_trial: 0,
    csrfToken: 'TEST_CSRF',
    invoices: [
      { id: 11, invoice_number: 'INV-2026-0001', client_name: 'Acme', issued_date: '2026-04-01', total: 500, status: 'paid', is_seed: false }
    ],
    user: { plan: 'pro', invoice_count: 5, subscription_status: null, default_currency: 'EUR' },
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
    pendingQuickInvoice: null,
    tableFollowUpIntents: {},
    currency: 'EUR',
    currencySymbol: '€'
  }, overrides), {
    views: [path.join(__dirname, '..', 'views')],
    filename: dashboardTplPath
  });
}

test('view: all-time Total Invoiced uses € for EUR-default user', () => {
  const html = renderDashboard();
  assert.match(html, /data-testid="alltime-total-invoiced"[^>]*>€500\.00</);
});

test('view: all-time Collected uses € for EUR-default user', () => {
  const html = renderDashboard();
  assert.match(html, /data-testid="alltime-collected"[^>]*>€500\.00</);
});

test('view: all-time Outstanding uses € for EUR-default user (zero-paid case)', () => {
  const html = renderDashboard({
    invoices: [
      { id: 12, invoice_number: 'INV-2026-0002', client_name: 'B', issued_date: '2026-04-02', total: 250, status: 'sent', is_seed: false }
    ]
  });
  assert.match(html, /data-testid="alltime-outstanding"[^>]*>€250\.00</);
});

test('view: invoice-table Amount cell uses € for EUR-default user', () => {
  const html = renderDashboard();
  assert.match(html, /data-testid="invoice-row-amount-11"[^>]*>€500\.00</);
});

test('view: recent-revenue card SSR fallback uses € for EUR-default user', () => {
  const html = renderDashboard({
    recentRevenue: { days: 30, totalPaid: 1234.56, invoiceCount: 4, clientCount: 2, unpaidCount: 0 }
  });
  // The x-text="formatMoney(totalPaid)" element's SSR fallback content
  // must carry the € symbol so the card is meaningful before Alpine boots.
  assert.match(html, /data-testid="recent-revenue-total"[^>]*x-text="formatMoney\(totalPaid\)">\s*€1,234\.56\s*</);
});

test('view: recent-revenue card threads currencySymbol into the Alpine x-data binding', () => {
  const html = renderDashboard({
    recentRevenue: { days: 30, totalPaid: 1234.56, invoiceCount: 4, clientCount: 2, unpaidCount: 0 }
  });
  // EJS JSON.stringify escapes quotes inside x-data attributes to &#34;.
  // The currencySymbol field must appear in the seed payload as the EUR
  // symbol so the Alpine factory's formatMoney() uses it on re-render.
  assert.match(html, /"currencySymbol":\s*"€"|currencySymbol&#34;:&#34;€&#34;|"currencySymbol":&quot;€&quot;/);
});

test('view: Alpine factory formatMoney uses this.currencySymbol (not hardcoded $)', () => {
  const html = renderDashboard({
    recentRevenue: { days: 30, totalPaid: 1234.56, invoiceCount: 4, clientCount: 2, unpaidCount: 0 }
  });
  // The Alpine factory closure must read its own currencySymbol field,
  // not a literal '$'. The defence-in-depth contract is locked in: any
  // future refactor that re-introduces a hardcoded '$' here will fail.
  assert.match(html, /return\s+this\.currencySymbol\s*\+\s*v\.toLocaleString/);
});

test('view: Alpine factory has a currencySymbol reactive field with a $ fallback', () => {
  const html = renderDashboard({
    recentRevenue: { days: 30, totalPaid: 1234.56, invoiceCount: 4, clientCount: 2, unpaidCount: 0 }
  });
  // The factory return object must declare currencySymbol with a string
  // fallback to '$' — so a legacy payload missing the field still produces
  // a non-undefined symbol in formatMoney.
  assert.match(html, /currencySymbol:\s*\(typeof\s+initial\.currencySymbol\s*===\s*'string'\s*&&\s*initial\.currencySymbol\)\s*\?\s*initial\.currencySymbol\s*:\s*'\$'/);
});

test('view: Alpine select() update path reads top-level data.currencySymbol from the API JSON', () => {
  const html = renderDashboard({
    recentRevenue: { days: 30, totalPaid: 1234.56, invoiceCount: 4, clientCount: 2, unpaidCount: 0 }
  });
  // The window-toggle fetch handler must update this.currencySymbol from
  // the API response so a re-render carries the right symbol. (Real-world
  // this matters for a future symbol-change-then-toggle flow; the contract
  // is that the field is honoured if present.)
  assert.match(html, /typeof\s+data\.currencySymbol\s*===\s*'string'/);
  assert.match(html, /this\.currencySymbol\s*=\s*data\.currencySymbol/);
});

test('view: fresh-draft prompt total uses € for EUR-default user', () => {
  const html = renderDashboard({
    freshDraftPrompt: { id: 7, ageMinutes: 5, directEmail: false, clientName: 'A', invoiceNumber: 'INV-DRAFT', total: 500 }
  });
  assert.match(html, /data-testid="fresh-draft-total"[^>]*>500\.00</);
  // The € symbol must immediately precede the testid span.
  assert.match(html, /\(€<span\s+data-testid="fresh-draft-total"/);
});

test('view: stale-draft prompt total uses € for EUR-default user', () => {
  const html = renderDashboard({
    staleDraftPrompt: { id: 8, ageHours: 48, directEmail: false, clientName: 'C', invoiceNumber: 'INV-STALE', total: 750 }
  });
  assert.match(html, /\(€<span\s+data-testid="stale-draft-total"/);
});

test('view: payment-claim prompt total uses € for EUR-default user', () => {
  const html = renderDashboard({
    paymentClaimPrompt: { id: 9, invoiceNumber: 'INV-CLAIM', clientName: 'D', total: 600, hoursSinceClaim: 8 }
  });
  assert.match(html, /\(€<span\s+data-testid="payment-claim-total"/);
});

test('view: recent-view prompt total uses € for EUR-default user', () => {
  const html = renderDashboard({
    recentViewPrompt: { id: 10, invoiceNumber: 'INV-VIEW', clientName: 'E', total: 400, viewCount: 3, lastViewedAgo: '2h ago', viewedJustNow: false }
  });
  assert.match(html, /\(€<span\s+data-testid="recent-view-total"/);
});

test('view: client-viewed-followup prompt total uses € for EUR-default user', () => {
  const html = renderDashboard({
    clientViewedFollowupPrompt: { id: 12, invoiceNumber: 'INV-CVF', clientName: 'F', total: 700, viewedAgo: '1d ago' }
  });
  assert.match(html, /\(€<span\s+data-testid="client-viewed-followup-total"/);
});

test('view: sent-not-viewed prompt total uses € for EUR-default user', () => {
  const html = renderDashboard({
    sentNotViewedPrompt: { id: 13, invoiceNumber: 'INV-SNV', clientName: 'G', total: 300, sentDaysAgo: 4 }
  });
  assert.match(html, /\(€<span\s+data-testid="sent-not-viewed-total"/);
});

test('view: overdue prompt total uses € for EUR-default user', () => {
  const html = renderDashboard({
    overduePrompt: { id: 14, invoiceNumber: 'INV-OD', clientName: 'H', total: 1200, daysOverdue: 5, lastReminderAgo: null }
  });
  assert.match(html, /\(€<span\s+data-testid="overdue-total"/);
});

test('view: repeat-client prompt total uses € for EUR-default user', () => {
  const html = renderDashboard({
    repeatClientPrompt: { clientName: 'I', clientEmail: 'i@x.com', total: 900, lastIssuedAgo: '14d ago' }
  });
  assert.match(html, /\(€<span\s+data-testid="repeat-client-total"/);
});

test('view: pending-quick-invoice amount uses € for EUR-default user', () => {
  const html = renderDashboard({
    pendingQuickInvoice: { clientName: 'J', description: 'Logo work', amount: '450' }
  });
  // The amount line carries the € symbol immediately before the span.
  assert.match(html, /&middot;\s*€<span\s+data-testid="pending-quick-invoice-amount"/);
});

test('view: pending-quick-invoice description-less amount fallback also uses €', () => {
  const html = renderDashboard({
    pendingQuickInvoice: { clientName: 'K', description: '', amount: '120' }
  });
  // The else-if branch (amount-only, no description) — same currency rule.
  assert.match(html, /€<span\s+data-testid="pending-quick-invoice-amount"/);
});

// ---- Layer 4: regression guards (USD + legacy callers) ----------------

test('view: USD-default user still sees $ on all-time totals (regression guard)', () => {
  const html = renderDashboard({
    user: { plan: 'pro', invoice_count: 5, subscription_status: null, default_currency: 'USD' },
    currency: 'USD', currencySymbol: '$'
  });
  assert.match(html, /data-testid="alltime-total-invoiced"[^>]*>\$500\.00</);
  assert.match(html, /data-testid="alltime-collected"[^>]*>\$500\.00</);
});

test('view: USD-default user still sees $ on the invoice-table Amount cell', () => {
  const html = renderDashboard({
    user: { plan: 'pro', invoice_count: 5, subscription_status: null, default_currency: 'USD' },
    currency: 'USD', currencySymbol: '$'
  });
  assert.match(html, /data-testid="invoice-row-amount-11"[^>]*>\$500\.00</);
});

test('view: legacy render without currencySymbol local falls back to $ on all-time totals', () => {
  // The error-path fallback (catch in router.get('/')) renders the
  // dashboard without the new currency locals. The view must still
  // produce sensible $-prefixed output rather than throwing or emitting
  // an "undefined" prefix.
  const html = ejs.render(dashboardTpl, {
    title: 'Dashboard', flash: null, days_left_in_trial: 0, csrfToken: 'T',
    invoices: [
      { id: 22, invoice_number: 'INV-LEG', client_name: 'L', issued_date: '2026-04-01', total: 99.50, status: 'paid', is_seed: false }
    ],
    user: null,
    onboarding: null, invoiceLimitProgress: null, recentRevenue: null,
    annualUpgradePrompt: null, socialProof: null, celebration: null,
    staleDraftPrompt: null, paymentClaimPrompt: null, recentViewPrompt: null,
    clientViewedFollowupPrompt: null, sentNotViewedPrompt: null,
    overduePrompt: null, firstRealInvoicePrompt: null, freshDraftPrompt: null,
    repeatClientPrompt: null, paymentInstructionsPrompt: null,
    pendingQuickInvoice: null, tableFollowUpIntents: {}
  }, {
    views: [path.join(__dirname, '..', 'views')],
    filename: dashboardTplPath
  });
  assert.match(html, /data-testid="alltime-total-invoiced"[^>]*>\$99\.50</);
  assert.match(html, /data-testid="invoice-row-amount-22"[^>]*>\$99\.50</);
});

test('view: legacy recent-revenue render (no currencySymbol local) seeds the factory with $', () => {
  const html = ejs.render(dashboardTpl, {
    title: 'Dashboard', flash: null, days_left_in_trial: 0, csrfToken: 'T',
    invoices: [
      { id: 33, invoice_number: 'INV-X', client_name: 'M', issued_date: '2026-04-01', total: 200, status: 'paid', is_seed: false }
    ],
    user: { plan: 'pro', invoice_count: 5 },
    onboarding: null, invoiceLimitProgress: null,
    recentRevenue: { days: 30, totalPaid: 200, invoiceCount: 1, clientCount: 1, unpaidCount: 0 },
    annualUpgradePrompt: null, socialProof: null, celebration: null,
    staleDraftPrompt: null, paymentClaimPrompt: null, recentViewPrompt: null,
    clientViewedFollowupPrompt: null, sentNotViewedPrompt: null,
    overduePrompt: null, firstRealInvoicePrompt: null, freshDraftPrompt: null,
    repeatClientPrompt: null, paymentInstructionsPrompt: null,
    pendingQuickInvoice: null, tableFollowUpIntents: {}
  }, {
    views: [path.join(__dirname, '..', 'views')],
    filename: dashboardTplPath
  });
  // The factory seed must carry currencySymbol="$" (HTML-escaped quotes).
  assert.match(html, /"currencySymbol":\s*"\$"|currencySymbol&#34;:&#34;\$&#34;|"currencySymbol":&quot;\$&quot;/);
  // SSR fallback content for the recent-revenue total still uses $.
  assert.match(html, /data-testid="recent-revenue-total"[^>]*>\s*\$200\.00\s*</);
});

test('view: no stray $ remains on owner-side money cells for an EUR user (drift guard)', () => {
  // If a future refactor reintroduces a hardcoded $ on any of the eight
  // prompt totals or the all-time stats while the user is EUR-default,
  // this catches it. We render with every prompt populated.
  const html = renderDashboard({
    recentRevenue: { days: 30, totalPaid: 1234.56, invoiceCount: 4, clientCount: 2, unpaidCount: 1 },
    freshDraftPrompt: { id: 7, ageMinutes: 5, directEmail: false, clientName: 'A', invoiceNumber: 'INV-DRAFT', total: 500 },
    staleDraftPrompt: { id: 8, ageHours: 48, directEmail: false, clientName: 'C', invoiceNumber: 'INV-STALE', total: 750 },
    paymentClaimPrompt: { id: 9, invoiceNumber: 'INV-CLAIM', clientName: 'D', total: 600, hoursSinceClaim: 8 },
    recentViewPrompt: { id: 10, invoiceNumber: 'INV-VIEW', clientName: 'E', total: 400, viewCount: 3, lastViewedAgo: '2h ago', viewedJustNow: false },
    clientViewedFollowupPrompt: { id: 12, invoiceNumber: 'INV-CVF', clientName: 'F', total: 700, viewedAgo: '1d ago' },
    sentNotViewedPrompt: { id: 13, invoiceNumber: 'INV-SNV', clientName: 'G', total: 300, sentDaysAgo: 4 },
    overduePrompt: { id: 14, invoiceNumber: 'INV-OD', clientName: 'H', total: 1200, daysOverdue: 5, lastReminderAgo: null },
    repeatClientPrompt: { clientName: 'I', clientEmail: 'i@x.com', total: 900, lastIssuedAgo: '14d ago' },
    pendingQuickInvoice: { clientName: 'J', description: 'Logo', amount: '450' }
  });
  // No $-prefixed money-shaped strings on the owner-side prompt totals.
  // The three Stripe-pricing dollar amounts (annualUpgradePrompt) are
  // explicitly omitted from this render, so any $X.XX or ($XXX) match
  // would be a regression on a prompt total.
  assert.ok(!/\(\$\d/.test(html), 'no ($N… on prompt totals for an EUR user');
  // No hardcoded $ immediately preceding the alltime testids.
  assert.ok(!/data-testid="alltime-(total-invoiced|collected|outstanding)"[^>]*>\$/.test(html),
    'no $ prefix on all-time totals for an EUR user');
  // No hardcoded $ immediately preceding the per-row Amount testid.
  assert.ok(!/data-testid="invoice-row-amount-\d+"[^>]*>\$/.test(html),
    'no $ prefix on invoice-table Amount cell for an EUR user');
});

// ---- Run --------------------------------------------------------------

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
  console.log(`\n${passed} passed, ${failed} failed (dashboard-currency-display.test.js)`);
  if (failed > 0) process.exit(1);
})();
