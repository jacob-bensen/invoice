'use strict';

/*
 * Repeat-client prompt — dashboard banner that fires when the user has a
 * recently-paid invoice (status='paid', updated_at within 7d) AND the same
 * client has no currently-open invoice. Turns a paid moment into the next
 * invoice via /invoices/:id/duplicate. Every duplicate re-enters the full
 * create→sent→paid funnel — the Primary Objective's activation multiplier.
 *
 * Layers:
 *  1. routes/invoices.buildRepeatClientPrompt — pure function over the
 *     dashboard's already-loaded `invoices` list. No DB, no async.
 *  2. views/dashboard.ejs — banner renders when prompt set, omits otherwise;
 *     copy carries client + invoice number + total + daysAgo; CTA POSTs to
 *     /invoices/:sourceId/duplicate with CSRF; hostile names escaped.
 *
 * Run: node tests/repeat-client-prompt.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

// Load routes/invoices fresh — no DB stub needed; the helper is pure.
delete require.cache[require.resolve('../routes/invoices')];
const routes = require('../routes/invoices');

// ---- Layer 1: buildRepeatClientPrompt shape contract -------------------

function recentPaid(extra = {}) {
  // Default: paid 2 days ago, real invoice (not seed), Acme client.
  return Object.assign({
    id: 88,
    invoice_number: 'INV-2026-0099',
    client_name: 'Acme Corp',
    total: '1500.00',
    status: 'paid',
    is_seed: false,
    updated_at: new Date(Date.now() - 2 * 86400000).toISOString()
  }, extra);
}

test('buildRepeatClientPrompt: null when invoices is not an array', () => {
  assert.strictEqual(routes.buildRepeatClientPrompt(null), null);
  assert.strictEqual(routes.buildRepeatClientPrompt(undefined), null);
  assert.strictEqual(routes.buildRepeatClientPrompt('paid'), null);
});

test('buildRepeatClientPrompt: null on empty list', () => {
  assert.strictEqual(routes.buildRepeatClientPrompt([]), null);
});

test('buildRepeatClientPrompt: ignores seed sample even if status=paid', () => {
  const seedPaid = recentPaid({ is_seed: true, client_name: 'Seed Client' });
  assert.strictEqual(routes.buildRepeatClientPrompt([seedPaid]), null);
});

test('buildRepeatClientPrompt: ignores draft, sent, overdue (only paid qualifies)', () => {
  for (const status of ['draft', 'sent', 'overdue']) {
    const inv = recentPaid({ status });
    assert.strictEqual(
      routes.buildRepeatClientPrompt([inv]),
      null,
      `status=${status} must not qualify`
    );
  }
});

test('buildRepeatClientPrompt: null when paid invoice has no client_name', () => {
  const inv = recentPaid({ client_name: '' });
  assert.strictEqual(routes.buildRepeatClientPrompt([inv]), null);
});

test('buildRepeatClientPrompt: null when paid invoice has whitespace-only client_name', () => {
  const inv = recentPaid({ client_name: '   ' });
  assert.strictEqual(routes.buildRepeatClientPrompt([inv]), null);
});

test('buildRepeatClientPrompt: null when paid invoice has no id', () => {
  const inv = recentPaid({ id: null });
  assert.strictEqual(routes.buildRepeatClientPrompt([inv]), null);
});

test('buildRepeatClientPrompt: null when updated_at missing', () => {
  const inv = recentPaid({ updated_at: null });
  assert.strictEqual(routes.buildRepeatClientPrompt([inv]), null);
});

test('buildRepeatClientPrompt: null when updated_at is older than 7 days', () => {
  const inv = recentPaid({
    updated_at: new Date(Date.now() - 8 * 86400000).toISOString()
  });
  assert.strictEqual(routes.buildRepeatClientPrompt([inv]), null);
});

test('buildRepeatClientPrompt: null when updated_at is in the future (clock skew defence)', () => {
  const inv = recentPaid({
    updated_at: new Date(Date.now() + 60_000).toISOString()
  });
  assert.strictEqual(routes.buildRepeatClientPrompt([inv]), null);
});

test('buildRepeatClientPrompt: null when updated_at is unparseable', () => {
  const inv = recentPaid({ updated_at: 'not-a-date' });
  assert.strictEqual(routes.buildRepeatClientPrompt([inv]), null);
});

test('buildRepeatClientPrompt: happy-path shape (sourceId, invoiceNumber, clientName, total, daysAgo)', () => {
  const inv = recentPaid();
  const out = routes.buildRepeatClientPrompt([inv]);
  assert.ok(out, 'fires on qualifying paid invoice');
  assert.strictEqual(out.sourceId, 88);
  assert.strictEqual(out.invoiceNumber, 'INV-2026-0099');
  assert.strictEqual(out.clientName, 'Acme Corp');
  assert.strictEqual(out.total, 1500);
  assert.strictEqual(out.daysAgo, 2);
});

test('buildRepeatClientPrompt: trims surrounding whitespace from client_name', () => {
  const inv = recentPaid({ client_name: '  Acme Corp  ' });
  const out = routes.buildRepeatClientPrompt([inv]);
  assert.strictEqual(out.clientName, 'Acme Corp');
});

test('buildRepeatClientPrompt: stringy total parses to Number', () => {
  const inv = recentPaid({ total: '799.99' });
  const out = routes.buildRepeatClientPrompt([inv]);
  assert.strictEqual(out.total, 799.99);
});

test('buildRepeatClientPrompt: total defaults to 0 when missing or NaN', () => {
  const inv = recentPaid({ total: null });
  const out = routes.buildRepeatClientPrompt([inv]);
  assert.strictEqual(out.total, 0);
});

test('buildRepeatClientPrompt: paid today renders daysAgo=0', () => {
  const inv = recentPaid({ updated_at: new Date().toISOString() });
  const out = routes.buildRepeatClientPrompt([inv]);
  assert.strictEqual(out.daysAgo, 0);
});

test('buildRepeatClientPrompt: paid exactly 7 days ago still qualifies (inclusive window)', () => {
  // Cushion 1 ms so floating-point arithmetic on the boundary doesn't flake.
  const inv = recentPaid({
    updated_at: new Date(Date.now() - (7 * 86400000 - 1)).toISOString()
  });
  const out = routes.buildRepeatClientPrompt([inv]);
  assert.ok(out, 'paid <7 days ago still fires');
  assert.strictEqual(out.daysAgo, 6);
});

test('buildRepeatClientPrompt: picks the most recently-paid qualifying invoice when multiple match', () => {
  const older = recentPaid({
    id: 1, invoice_number: 'OLD', client_name: 'Beta Co',
    updated_at: new Date(Date.now() - 5 * 86400000).toISOString()
  });
  const newer = recentPaid({
    id: 2, invoice_number: 'NEW', client_name: 'Acme Corp',
    updated_at: new Date(Date.now() - 1 * 86400000).toISOString()
  });
  const out = routes.buildRepeatClientPrompt([older, newer]);
  assert.strictEqual(out.sourceId, 2, 'most-recent paid wins');
  assert.strictEqual(out.invoiceNumber, 'NEW');
});

test('buildRepeatClientPrompt: SUPPRESSED when same client has an open draft', () => {
  const paid = recentPaid({ id: 88, client_name: 'Acme Corp' });
  const openDraft = {
    id: 99, invoice_number: 'D1', client_name: 'Acme Corp', total: 200,
    status: 'draft', is_seed: false,
    updated_at: new Date().toISOString()
  };
  assert.strictEqual(routes.buildRepeatClientPrompt([paid, openDraft]), null,
    'never prompt to invoice a client who already has work in flight');
});

test('buildRepeatClientPrompt: SUPPRESSED when same client has an open sent invoice', () => {
  const paid = recentPaid({ id: 88, client_name: 'Acme Corp' });
  const openSent = {
    id: 99, invoice_number: 'S1', client_name: 'Acme Corp', total: 200,
    status: 'sent', is_seed: false,
    updated_at: new Date().toISOString()
  };
  assert.strictEqual(routes.buildRepeatClientPrompt([paid, openSent]), null);
});

test('buildRepeatClientPrompt: SUPPRESSED when same client has an open overdue invoice', () => {
  const paid = recentPaid({ id: 88, client_name: 'Acme Corp' });
  const openOverdue = {
    id: 99, invoice_number: 'O1', client_name: 'Acme Corp', total: 200,
    status: 'overdue', is_seed: false,
    updated_at: new Date().toISOString()
  };
  assert.strictEqual(routes.buildRepeatClientPrompt([paid, openOverdue]), null);
});

test('buildRepeatClientPrompt: SUPPRESSION is case-insensitive + trim-tolerant', () => {
  const paid = recentPaid({ id: 88, client_name: 'Acme Corp' });
  const openDraft = {
    id: 99, invoice_number: 'D1', client_name: '  ACME CORP  ', total: 200,
    status: 'draft', is_seed: false
  };
  assert.strictEqual(routes.buildRepeatClientPrompt([paid, openDraft]), null,
    '"ACME CORP" with whitespace matches "Acme Corp" — same client');
});

test('buildRepeatClientPrompt: NOT suppressed by a paid invoice for the same client', () => {
  const newPaid = recentPaid({
    id: 88, client_name: 'Acme Corp',
    updated_at: new Date(Date.now() - 1 * 86400000).toISOString()
  });
  const olderPaid = recentPaid({
    id: 77, client_name: 'Acme Corp',
    updated_at: new Date(Date.now() - 6 * 86400000).toISOString()
  });
  const out = routes.buildRepeatClientPrompt([newPaid, olderPaid]);
  assert.ok(out, 'two paid invoices for the same client: still fires (no open work)');
  assert.strictEqual(out.sourceId, 88, 'prefers most-recent paid');
});

test('buildRepeatClientPrompt: a DIFFERENT client with open work does not suppress', () => {
  const paid = recentPaid({ id: 88, client_name: 'Acme Corp' });
  const otherOpen = {
    id: 99, invoice_number: 'D1', client_name: 'Beta Co', total: 200,
    status: 'draft', is_seed: false
  };
  const out = routes.buildRepeatClientPrompt([paid, otherOpen]);
  assert.ok(out, 'open work for a different client must NOT block the prompt');
  assert.strictEqual(out.sourceId, 88);
});

test('buildRepeatClientPrompt: seed open invoice does not count toward suppression', () => {
  // is_seed=true rows are filtered out entirely — a seed draft for the same
  // client name must not suppress the prompt.
  const paid = recentPaid({ id: 88, client_name: 'Acme Corp' });
  const seedDraft = {
    id: 1, invoice_number: 'SEED', client_name: 'Acme Corp', total: 0,
    status: 'draft', is_seed: true
  };
  const out = routes.buildRepeatClientPrompt([paid, seedDraft]);
  assert.ok(out, 'seed sample must not block the prompt');
  assert.strictEqual(out.sourceId, 88);
});

test('buildRepeatClientPrompt: scans the OLDER of two paid invoices when the newer is disqualified', () => {
  // The most-recent paid is for a client with open work; the older paid is
  // for a different client with no open work. The older should fire.
  const newerPaidBlocked = recentPaid({
    id: 88, client_name: 'Acme Corp',
    updated_at: new Date(Date.now() - 1 * 86400000).toISOString()
  });
  const openSent = {
    id: 99, invoice_number: 'S1', client_name: 'Acme Corp', total: 200,
    status: 'sent', is_seed: false
  };
  const olderPaidFree = recentPaid({
    id: 77, invoice_number: 'OLD', client_name: 'Beta Co',
    updated_at: new Date(Date.now() - 5 * 86400000).toISOString()
  });
  const out = routes.buildRepeatClientPrompt([newerPaidBlocked, openSent, olderPaidFree]);
  assert.ok(out, 'older paid still fires when newer is blocked');
  assert.strictEqual(out.sourceId, 77);
  assert.strictEqual(out.clientName, 'Beta Co');
});

test('buildRepeatClientPrompt: accepts injected now for deterministic timing', () => {
  const inv = recentPaid({
    updated_at: '2026-05-20T00:00:00Z'
  });
  const out = routes.buildRepeatClientPrompt([inv], {
    now: new Date('2026-05-23T00:00:00Z').getTime()
  });
  assert.ok(out);
  assert.strictEqual(out.daysAgo, 3);
});

// ---- Layer 2: dashboard.ejs renders the banner -------------------------

const dashboardTplPath = path.join(__dirname, '..', 'views', 'dashboard.ejs');
const dashboardTpl = fs.readFileSync(dashboardTplPath, 'utf8');

function renderDashboard(locals) {
  return ejs.render(dashboardTpl, Object.assign({
    title: 'Dashboard',
    flash: null,
    days_left_in_trial: 0,
    csrfToken: 'TEST_CSRF',
    invoices: [],
    user: { plan: 'pro', invoice_count: 5, subscription_status: null },
    onboarding: null,
    invoiceLimitProgress: null,
    recentRevenue: null,
    annualUpgradePrompt: null,
    socialProof: null,
    celebration: null,
    staleDraftPrompt: null,
    paymentClaimPrompt: null,
    clientViewedFollowupPrompt: null,
    sentNotViewedPrompt: null,
    overduePrompt: null,
    firstRealInvoicePrompt: null,
    repeatClientPrompt: null,
    pendingQuickInvoice: null
  }, locals), {
    views: [path.join(__dirname, '..', 'views')],
    filename: dashboardTplPath
  });
}

test('view: banner OMITTED when repeatClientPrompt is null', () => {
  const html = renderDashboard({ repeatClientPrompt: null });
  assert.doesNotMatch(html, /data-testid="repeat-client-prompt"/);
});

test('view: banner RENDERS when prompt set', () => {
  const html = renderDashboard({
    repeatClientPrompt: {
      sourceId: 88, invoiceNumber: 'INV-2026-0099',
      clientName: 'Acme Corp', total: 1500, daysAgo: 2
    }
  });
  assert.match(html, /data-testid="repeat-client-prompt"/);
});

test('view: banner shows client name, invoice number, total, daysAgo', () => {
  const html = renderDashboard({
    repeatClientPrompt: {
      sourceId: 88, invoiceNumber: 'INV-2026-0099',
      clientName: 'Acme Corp', total: 1500, daysAgo: 2
    }
  });
  assert.match(html, /Acme Corp/, 'client name visible');
  assert.match(html, /INV-2026-0099/, 'invoice number visible');
  assert.match(html, /\$<span[^>]*>1500\.00<\/span>/, 'total formatted to 2 decimals');
  assert.match(html, /<span[^>]*data-testid="repeat-client-days-ago"[^>]*>2<\/span>\s*days?\s*ago/, 'daysAgo surface visible');
});

test('view: CTA form POSTs to /invoices/:sourceId/duplicate with CSRF', () => {
  const html = renderDashboard({
    repeatClientPrompt: {
      sourceId: 88, invoiceNumber: 'X', clientName: 'Acme', total: 100, daysAgo: 1
    }
  });
  const blockMatch = html.match(/data-testid="repeat-client-prompt"[\s\S]{0,1400}/);
  assert.ok(blockMatch, 'banner block located');
  assert.match(blockMatch[0], /action="\/invoices\/88\/duplicate"/);
  assert.match(blockMatch[0], /method="POST"/i);
  assert.match(blockMatch[0], /name="_csrf"\s+value="TEST_CSRF"/);
  assert.match(blockMatch[0], /data-testid="repeat-client-cta"/);
});

test('view: daysAgo=1 uses singular "day" (not "days")', () => {
  const html = renderDashboard({
    repeatClientPrompt: {
      sourceId: 88, invoiceNumber: 'X', clientName: 'Acme', total: 100, daysAgo: 1
    }
  });
  const blockMatch = html.match(/data-testid="repeat-client-prompt"[\s\S]{0,1400}/);
  assert.ok(blockMatch);
  assert.match(blockMatch[0], />1<\/span>\s*day\s+ago/i,
    'singular "day ago" on daysAgo=1');
  assert.doesNotMatch(blockMatch[0], />1<\/span>\s*days\s+ago/i,
    'must NOT pluralize on daysAgo=1');
});

test('view: daysAgo=0 renders "today" (not "0 days ago")', () => {
  const html = renderDashboard({
    repeatClientPrompt: {
      sourceId: 88, invoiceNumber: 'X', clientName: 'Acme', total: 100, daysAgo: 0
    }
  });
  const blockMatch = html.match(/data-testid="repeat-client-prompt"[\s\S]{0,1400}/);
  assert.ok(blockMatch);
  assert.match(blockMatch[0], /data-testid="repeat-client-days-ago"[^>]*>today</);
  assert.doesNotMatch(blockMatch[0], />0<\/span>\s*days?\s*ago/);
});

test('view: hostile clientName is HTML-escaped', () => {
  const hostile = '<script>alert(1)</script>';
  const html = renderDashboard({
    repeatClientPrompt: {
      sourceId: 88, invoiceNumber: 'X', clientName: hostile, total: 100, daysAgo: 1
    }
  });
  const blockMatch = html.match(/data-testid="repeat-client-prompt"[\s\S]{0,1400}/);
  assert.ok(blockMatch);
  assert.doesNotMatch(blockMatch[0], /<script>/i,
    'EJS <%= %> must escape angle brackets in the client name');
  assert.match(blockMatch[0], /&lt;script&gt;/);
});

test('view: banner carries print:hidden so it does not leak into PDF print views', () => {
  const html = renderDashboard({
    repeatClientPrompt: {
      sourceId: 88, invoiceNumber: 'X', clientName: 'Acme', total: 100, daysAgo: 1
    }
  });
  const blockMatch = html.match(/data-testid="repeat-client-prompt"[\s\S]{0,200}/);
  assert.ok(blockMatch);
  assert.match(blockMatch[0], /print:hidden/);
});

test('view: banner sits after the overdue-prompt block in source order', () => {
  // Positional ordering anchors the visual stack — repeat-client is a paid-
  // moment surface, so it follows the overdue chase surface (downstream of
  // M4 paid event vs. M4 collection event).
  const html = renderDashboard({
    overduePrompt: {
      id: 11, invoiceNumber: 'OV1', clientName: 'Late Co',
      total: 100, daysPastDue: 3, status: 'sent'
    },
    repeatClientPrompt: {
      sourceId: 88, invoiceNumber: 'INV-2026-0099',
      clientName: 'Acme Corp', total: 1500, daysAgo: 2
    }
  });
  const overdueIdx = html.indexOf('data-testid="overdue-prompt"');
  const repeatIdx = html.indexOf('data-testid="repeat-client-prompt"');
  assert.ok(overdueIdx > 0, 'overdue prompt present');
  assert.ok(repeatIdx > 0, 'repeat-client prompt present');
  assert.ok(repeatIdx > overdueIdx,
    'repeat-client prompt must render AFTER overdue prompt');
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
      if (err.stack) console.error(err.stack.split('\n').slice(0, 3).join('\n'));
    }
  }
  console.log(`\n${passed} passed, ${failed} failed (repeat-client-prompt.test.js)`);
  if (failed > 0) process.exit(1);
})();
