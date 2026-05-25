'use strict';

/*
 * Fresh-draft "now send it" dashboard prompt — closes the 0-24h activation
 * gap between a brand-new user creating their first invoice via
 * /invoices/quick (or /invoices/new) and the stale-draft prompt firing at
 * the 24h mark.
 *
 * Cohort: users.first_sent_at IS NULL (never sent ANY invoice) AND there
 * exists a non-seed `status='draft'` invoice created within the last
 * FRESH_DRAFT_MAX_AGE_HOURS hours.
 *
 * Layers under test:
 *  1. buildFreshDraftPrompt — null user / sent-history / no-eligible-draft
 *     paths; recency window enforcement; is_seed exclusion; status filter;
 *     newest-first picker; staleDraftPrompt suppression; numeric coercion.
 *  2. view (dashboard.ejs) — banner renders/omits, copy carries invoice
 *     number + client name + total, primary CTA deep-links to invoice,
 *     mark-sent form POSTs status=sent + CSRF, XSS escape, positional
 *     contract (above stale-draft, below celebration), print:hidden.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

// The builder is pure — no DB call. We still install a minimal stub so the
// routes module loads without trying to connect to Postgres.
const dbStub = {
  pool: { query: async () => ({ rows: [] }) },
  db: {
    getUserById: async () => null,
    getRecentRevenueStats: async () => ({ days: 30, totalPaid: 0, invoiceCount: 0, clientCount: 0, unpaidCount: 0 })
  }
};
require.cache[require.resolve('../db')] = {
  id: require.resolve('../db'),
  filename: require.resolve('../db'),
  loaded: true,
  exports: dbStub
};
delete require.cache[require.resolve('../routes/invoices')];
const routes = require('../routes/invoices');

const hoursAgo = (h) => new Date(Date.now() - h * 3600000);
const minutesAgo = (m) => new Date(Date.now() - m * 60000);

// ---- Layer 1: buildFreshDraftPrompt contract ---------------------------

test('exports buildFreshDraftPrompt and FRESH_DRAFT_MAX_AGE_HOURS', () => {
  assert.strictEqual(typeof routes.buildFreshDraftPrompt, 'function');
  assert.strictEqual(routes.FRESH_DRAFT_MAX_AGE_HOURS, 24,
    '24h matches the stale-draft cutoff so the two prompts are mutually exclusive by age');
});

test('returns null when user is missing', () => {
  assert.strictEqual(routes.buildFreshDraftPrompt(null, []), null);
});

test('returns null when the user has already sent an invoice (first_sent_at set)', () => {
  // The whole point is the momentum push for never-sent users. If they
  // already sent something, they know how to do it — surfacing this
  // banner again on every fresh draft would be noise.
  const user = { id: 1, first_sent_at: new Date().toISOString() };
  const invoices = [{ id: 7, status: 'draft', is_seed: false, created_at: minutesAgo(30), invoice_number: 'INV-2026-0001', client_name: 'A', total: 100 }];
  assert.strictEqual(routes.buildFreshDraftPrompt(user, invoices), null);
});

test('returns null when invoices list is empty', () => {
  const user = { id: 1, first_sent_at: null };
  assert.strictEqual(routes.buildFreshDraftPrompt(user, []), null);
});

test('returns null when invoices is not an array (defence against bad input)', () => {
  const user = { id: 1, first_sent_at: null };
  assert.strictEqual(routes.buildFreshDraftPrompt(user, null), null);
  assert.strictEqual(routes.buildFreshDraftPrompt(user, undefined), null);
  assert.strictEqual(routes.buildFreshDraftPrompt(user, 'not-an-array'), null);
});

test('returns null when no invoice has status=\'draft\'', () => {
  const user = { id: 1, first_sent_at: null };
  const invoices = [
    { id: 1, status: 'sent', is_seed: false, created_at: minutesAgo(30), invoice_number: 'INV-2026-0001', client_name: 'A', total: 100 },
    { id: 2, status: 'paid', is_seed: false, created_at: minutesAgo(15), invoice_number: 'INV-2026-0002', client_name: 'B', total: 200 }
  ];
  // (note: in practice these statuses would mean first_sent_at is non-null,
  // but we test the status filter in isolation.)
  assert.strictEqual(routes.buildFreshDraftPrompt(user, invoices), null);
});

test('returns null when the only draft is the signup seed (is_seed=true)', () => {
  // The seed has its own dedicated banner (seed-invoice-view-banner) on the
  // /invoices/:id page — the dashboard prompt is for REAL drafts the user
  // created themselves.
  const user = { id: 1, first_sent_at: null };
  const invoices = [
    { id: 1, status: 'draft', is_seed: true, created_at: minutesAgo(10), invoice_number: 'INV-SEED', client_name: 'Sample', total: 50 }
  ];
  assert.strictEqual(routes.buildFreshDraftPrompt(user, invoices), null);
});

test('returns null when the only draft is OLDER than the 24h window', () => {
  // 25h crosses the boundary — the stale-draft prompt owns this row instead.
  const user = { id: 1, first_sent_at: null };
  const invoices = [
    { id: 1, status: 'draft', is_seed: false, created_at: hoursAgo(25), invoice_number: 'INV-2026-0001', client_name: 'A', total: 100 }
  ];
  assert.strictEqual(routes.buildFreshDraftPrompt(user, invoices), null);
});

test('suppresses to null when staleDraftPrompt is already firing', () => {
  // Defensive: if a future refactor relaxed the 24h boundary in either
  // prompt, this suppression keeps the dashboard from rendering two
  // simultaneous "send your draft" banners.
  const user = { id: 1, first_sent_at: null };
  const invoices = [
    { id: 1, status: 'draft', is_seed: false, created_at: minutesAgo(30), invoice_number: 'INV-2026-0001', client_name: 'A', total: 100 }
  ];
  const staleDraftPrompt = { id: 99, invoiceNumber: 'INV-STALE', clientName: 'X', total: 1, hoursOld: 48 };
  assert.strictEqual(
    routes.buildFreshDraftPrompt(user, invoices, { staleDraftPrompt }),
    null
  );
});

test('happy path: returns shape {id, invoiceNumber, clientName, total, ageMinutes}', () => {
  const user = { id: 1, first_sent_at: null };
  const created = minutesAgo(45);
  const invoices = [
    { id: 17, status: 'draft', is_seed: false, created_at: created, invoice_number: 'INV-2026-0042', client_name: 'Acme Co.', total: '1500.00' }
  ];
  const out = routes.buildFreshDraftPrompt(user, invoices);
  assert.ok(out, 'expected a prompt object');
  assert.strictEqual(out.id, 17);
  assert.strictEqual(out.invoiceNumber, 'INV-2026-0042');
  assert.strictEqual(out.clientName, 'Acme Co.');
  assert.strictEqual(out.total, 1500, 'stringy total parses to Number');
  assert.ok(out.ageMinutes >= 44 && out.ageMinutes <= 46,
    'ageMinutes computed from created_at (small slack for the test runner)');
});

test('picks the NEWEST eligible draft when the user has multiple', () => {
  // The newest draft is the one the user just clicked away from — peak
  // attention. The older draft (still inside 24h) is also a candidate, but
  // we surface one banner at a time and the newest is the strongest signal
  // of "what the user was just doing".
  const user = { id: 1, first_sent_at: null };
  const invoices = [
    { id: 1, status: 'draft', is_seed: false, created_at: hoursAgo(20), invoice_number: 'INV-OLDER', client_name: 'Old Co.', total: 500 },
    { id: 2, status: 'draft', is_seed: false, created_at: minutesAgo(10), invoice_number: 'INV-NEWER', client_name: 'New Co.', total: 700 }
  ];
  const out = routes.buildFreshDraftPrompt(user, invoices);
  assert.strictEqual(out.id, 2);
  assert.strictEqual(out.invoiceNumber, 'INV-NEWER');
});

test('skips invoices with no id', () => {
  const user = { id: 1, first_sent_at: null };
  const invoices = [
    { id: null, status: 'draft', is_seed: false, created_at: minutesAgo(5), invoice_number: 'X', client_name: 'A', total: 1 },
    { id: 1, status: 'draft', is_seed: false, created_at: minutesAgo(15), invoice_number: 'INV-OK', client_name: 'B', total: 2 }
  ];
  const out = routes.buildFreshDraftPrompt(user, invoices);
  assert.strictEqual(out.id, 1, 'id=null row is skipped, real row wins');
});

test('skips invoices with unparseable created_at', () => {
  const user = { id: 1, first_sent_at: null };
  const invoices = [
    { id: 1, status: 'draft', is_seed: false, created_at: 'not-a-date', invoice_number: 'X', client_name: 'A', total: 1 },
    { id: 2, status: 'draft', is_seed: false, created_at: minutesAgo(20), invoice_number: 'INV-OK', client_name: 'B', total: 2 }
  ];
  const out = routes.buildFreshDraftPrompt(user, invoices);
  assert.strictEqual(out.id, 2);
});

test('inclusive 24h boundary: a draft created exactly 24h ago is INCLUDED', () => {
  // The cutoff is `Date.now() - 24h`. A row created at exactly that
  // instant should qualify (>=, not strictly >). Using a 60-second buffer
  // to avoid races with the test runner's clock.
  const user = { id: 1, first_sent_at: null };
  const justInside = new Date(Date.now() - 24 * 3600000 + 60000);
  const invoices = [
    { id: 1, status: 'draft', is_seed: false, created_at: justInside, invoice_number: 'X', client_name: 'A', total: 1 }
  ];
  const out = routes.buildFreshDraftPrompt(user, invoices);
  assert.ok(out, 'invoice just inside 24h window must fire the prompt');
  assert.strictEqual(out.id, 1);
});

test('empty client_name passes through (view block handles fallback copy)', () => {
  const user = { id: 1, first_sent_at: null };
  const invoices = [
    { id: 1, status: 'draft', is_seed: false, created_at: minutesAgo(5), invoice_number: 'INV-X', client_name: '', total: 0 }
  ];
  const out = routes.buildFreshDraftPrompt(user, invoices);
  assert.strictEqual(out.clientName, '');
});

test('missing total coerces to 0 (no NaN reaches the template)', () => {
  const user = { id: 1, first_sent_at: null };
  const invoices = [
    { id: 1, status: 'draft', is_seed: false, created_at: minutesAgo(5), invoice_number: 'INV-X', client_name: 'A', total: null }
  ];
  const out = routes.buildFreshDraftPrompt(user, invoices);
  assert.strictEqual(out.total, 0);
});

test('future created_at clamps ageMinutes to 0 (clock-skew defence)', () => {
  const user = { id: 1, first_sent_at: null };
  const invoices = [
    { id: 1, status: 'draft', is_seed: false, created_at: new Date(Date.now() + 60000), invoice_number: 'X', client_name: 'A', total: 1 }
  ];
  const out = routes.buildFreshDraftPrompt(user, invoices);
  // Future timestamps are inside the window (cutoff is Date.now() - 24h, a
  // future created_at trivially passes). ageMinutes should clamp to 0 rather
  // than going negative.
  assert.strictEqual(out.ageMinutes, 0);
});

test('first_sent_at as a string is treated as truthy (gate works on real DB rows)', () => {
  // Postgres returns TIMESTAMP columns as Date objects via pg, but JSON
  // serialization to/from session storage can convert them to strings.
  // The gate must be truthy-style ("is anything set?") not deep-equal.
  const user = { id: 1, first_sent_at: '2026-05-23T10:00:00.000Z' };
  const invoices = [
    { id: 1, status: 'draft', is_seed: false, created_at: minutesAgo(10), invoice_number: 'X', client_name: 'A', total: 1 }
  ];
  assert.strictEqual(routes.buildFreshDraftPrompt(user, invoices), null);
});

test('undefined first_sent_at counts as "never sent" (legacy row pre-migration)', () => {
  // For users who pre-date the first_sent_at column migration, the field
  // is undefined; we treat that as "never sent" so the prompt still fires.
  const user = { id: 1 /* no first_sent_at field at all */ };
  const invoices = [
    { id: 1, status: 'draft', is_seed: false, created_at: minutesAgo(10), invoice_number: 'X', client_name: 'A', total: 1 }
  ];
  const out = routes.buildFreshDraftPrompt(user, invoices);
  assert.ok(out, 'absent first_sent_at must not block the prompt');
});

test('shareIntents is null when the draft has no public_token (legacy row)', () => {
  // Eager mint at POST /quick + POST /new lands a token at create time, but
  // legacy rows created before that change carry public_token=null. The
  // builder must degrade cleanly — the view falls back to the deep-link CTA
  // when shareIntents is null. Locks in the no-token branch behaviour.
  const user = { id: 1, first_sent_at: null };
  const invoices = [
    { id: 1, status: 'draft', is_seed: false, created_at: minutesAgo(10),
      invoice_number: 'INV-X', client_name: 'A', total: 100,
      public_token: null }
  ];
  const out = routes.buildFreshDraftPrompt(user, invoices);
  assert.ok(out);
  assert.strictEqual(out.shareIntents, null,
    'no token → no inline share-intent surface');
});

test('shareIntents carries whatsapp + sms + url when public_token is present', () => {
  // Happy path for the one-tap dashboard share surface. The intents include
  // a wa.me / sms: URL with the body pre-filled and the public /i/<token>
  // page URL appended so a tap opens the user's native compose window.
  const user = { id: 1, first_sent_at: null };
  const invoices = [
    { id: 17, status: 'draft', is_seed: false, created_at: minutesAgo(10),
      invoice_number: 'INV-2026-0042', client_name: 'Acme Co.',
      client_email: 'ap@acme.example', total: 1500,
      public_token: 'abc1234567890def' }
  ];
  const out = routes.buildFreshDraftPrompt(user, invoices);
  assert.ok(out.shareIntents, 'shareIntents must be set when token is present');
  assert.ok(typeof out.shareIntents.whatsapp === 'string'
    && out.shareIntents.whatsapp.startsWith('https://wa.me/?text='),
    'whatsapp URL is a wa.me deep-link');
  assert.ok(typeof out.shareIntents.sms === 'string'
    && out.shareIntents.sms.startsWith('sms:'),
    'sms URL is an sms: deep-link');
  assert.ok(typeof out.shareIntents.url === 'string'
    && out.shareIntents.url.indexOf('abc1234567890def') !== -1,
    'url surfaces the public /i/<token> link');
  // The pre-filled body should mention the invoice number + amount so the
  // recipient sees context inside the compose window.
  const decoded = decodeURIComponent(out.shareIntents.whatsapp);
  assert.ok(decoded.indexOf('INV-2026-0042') !== -1, 'body mentions invoice number');
  assert.ok(decoded.indexOf('$1500.00') !== -1, 'body mentions $-formatted amount');
});

test('shareIntents is null when public_token is a malformed string', () => {
  // The token regex on lib/share-link gates the surface; a malformed token
  // (wrong length, non-hex chars) must NOT produce a usable share-intent URL.
  const user = { id: 1, first_sent_at: null };
  const invoices = [
    { id: 1, status: 'draft', is_seed: false, created_at: minutesAgo(10),
      invoice_number: 'INV-X', client_name: 'A', total: 100,
      public_token: 'BAD!!!' }
  ];
  const out = routes.buildFreshDraftPrompt(user, invoices);
  assert.strictEqual(out.shareIntents, null,
    'malformed token must not produce share-intent URLs');
});

// ---- Layer 2: dashboard.ejs view ---------------------------------------

const dashboardTplPath = path.join(__dirname, '..', 'views', 'dashboard.ejs');
const dashboardTpl = fs.readFileSync(dashboardTplPath, 'utf8');

function renderDashboard(locals) {
  return ejs.render(dashboardTpl, {
    title: 'Dashboard',
    flash: null,
    days_left_in_trial: 0,
    csrfToken: 'TEST_CSRF',
    invoices: [
      { id: 1, invoice_number: 'INV-2026-0001', client_name: 'Acme', issued_date: '2026-04-01', total: 500, status: 'draft', is_seed: false }
    ],
    user: { plan: 'pro', invoice_count: 1, subscription_status: null },
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
    freshDraftPrompt: null,
    repeatClientPrompt: null,
    pendingQuickInvoice: null,
    ...locals
  }, {
    views: [path.join(__dirname, '..', 'views')],
    filename: dashboardTplPath
  });
}

test('view: banner is OMITTED when freshDraftPrompt is null', () => {
  const html = renderDashboard({ freshDraftPrompt: null });
  assert.doesNotMatch(html, /data-testid="fresh-draft-prompt"/);
});

test('view: banner RENDERS when freshDraftPrompt is set', () => {
  const html = renderDashboard({
    freshDraftPrompt: { id: 17, invoiceNumber: 'INV-2026-0042', clientName: 'Acme Co.', total: 1500, ageMinutes: 30 }
  });
  assert.match(html, /data-testid="fresh-draft-prompt"/);
});

test('view: banner copy carries client name (named cohort)', () => {
  const html = renderDashboard({
    freshDraftPrompt: { id: 17, invoiceNumber: 'INV-2026-0042', clientName: 'Acme Co.', total: 1500, ageMinutes: 30 }
  });
  assert.match(html, /You made an invoice for[\s\S]*?Acme Co\./,
    'named client appears in the headline');
  assert.match(html, /now send it/i, 'urgency phrasing present');
});

test('view: empty client name falls back to "your first invoice" framing', () => {
  const html = renderDashboard({
    freshDraftPrompt: { id: 17, invoiceNumber: 'INV-2026-0042', clientName: '', total: 1500, ageMinutes: 30 }
  });
  assert.match(html, /your first invoice/i,
    'unnamed client gets the activation-framed fallback copy');
});

test('view: invoice number + total ($X.XX) surface in the body', () => {
  const html = renderDashboard({
    freshDraftPrompt: { id: 17, invoiceNumber: 'INV-2026-0042', clientName: 'Acme Co.', total: 1500, ageMinutes: 30 }
  });
  assert.match(html, /INV-2026-0042/);
  assert.match(html, /\$<span[^>]*>1500\.00<\/span>/, 'total formatted to 2 decimals');
});

test('view: primary CTA deep-links to /invoices/:id', () => {
  const html = renderDashboard({
    freshDraftPrompt: { id: 17, invoiceNumber: 'X', clientName: 'A', total: 1, ageMinutes: 5 }
  });
  assert.match(html, /href="\/invoices\/17"[^>]*data-testid="fresh-draft-open-link"/);
});

test('view: Mark-as-Sent form POSTs to /invoices/:id/status with status=sent + CSRF', () => {
  const html = renderDashboard({
    freshDraftPrompt: { id: 17, invoiceNumber: 'X', clientName: 'A', total: 1, ageMinutes: 5 }
  });
  const formMatch = html.match(
    /<form\s+action="\/invoices\/17\/status"\s+method="POST"[^>]*>[\s\S]*?data-testid="fresh-draft-mark-sent"/
  );
  assert.ok(formMatch, 'Mark-as-Sent form must POST to /invoices/17/status');
  assert.match(formMatch[0], /name="_csrf"\s+value="TEST_CSRF"/, 'CSRF wired from locals');
  assert.match(formMatch[0], /name="status"\s+value="sent"/, 'status=sent hidden field');
});

test('view: hostile client_name is HTML-escaped (XSS guard)', () => {
  const html = renderDashboard({
    freshDraftPrompt: {
      id: 1, invoiceNumber: 'INV-2026-0001',
      clientName: '<script>alert(1)</script>', total: 100, ageMinutes: 5
    }
  });
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/,
    'raw script must NOT appear — EJS <%= must escape');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('view: banner carries print:hidden so it drops from printed PDFs', () => {
  const html = renderDashboard({
    freshDraftPrompt: { id: 1, invoiceNumber: 'X', clientName: 'A', total: 1, ageMinutes: 5 }
  });
  const block = html.match(/<div\s[^>]*data-testid="fresh-draft-prompt"[^>]*>/);
  assert.ok(block, 'banner div is rendered');
  assert.match(block[0], /print:hidden/);
});

test('view: banner sits ABOVE the stale-draft prompt (positional contract)', () => {
  // Even though the two prompts are mutually exclusive in practice (the
  // builder suppresses freshDraftPrompt when staleDraftPrompt fires), if a
  // future refactor relaxed that the fresh momentum push should still win
  // the visual hierarchy for first-time users.
  const html = renderDashboard({
    freshDraftPrompt: { id: 1, invoiceNumber: 'X', clientName: 'A', total: 1, ageMinutes: 5 },
    staleDraftPrompt: { id: 2, invoiceNumber: 'Y', clientName: 'B', total: 2, hoursOld: 48 }
  });
  const freshIdx = html.indexOf('data-testid="fresh-draft-prompt"');
  const staleIdx = html.indexOf('data-testid="stale-draft-prompt"');
  assert.ok(freshIdx !== -1 && staleIdx !== -1, 'both banners present');
  assert.ok(freshIdx < staleIdx, 'fresh-draft prompt must render BEFORE stale-draft prompt');
});

test('view: banner sits BELOW the celebration banner include (positional contract)', () => {
  const html = renderDashboard({
    freshDraftPrompt: { id: 1, invoiceNumber: 'X', clientName: 'A', total: 1, ageMinutes: 5 }
  });
  const celebrationIdx = html.indexOf('data-testid="celebration-banner"');
  const freshIdx = html.indexOf('data-testid="fresh-draft-prompt"');
  // celebration partial may render nothing — only assert order when both
  // appear.
  if (celebrationIdx !== -1 && freshIdx !== -1) {
    assert.ok(celebrationIdx < freshIdx,
      'celebration banner must precede the fresh-draft prompt when both render');
  }
});

test('view: banner carries data attributes for invoice-id and age-minutes', () => {
  const html = renderDashboard({
    freshDraftPrompt: { id: 17, invoiceNumber: 'X', clientName: 'A', total: 1, ageMinutes: 42 }
  });
  assert.match(html, /data-invoice-id="17"/);
  assert.match(html, /data-age-minutes="42"/);
});

// ---- Layer 3: dashboard.ejs share-intent buttons ----------------------

test('view: share-intent row is OMITTED when shareIntents is null', () => {
  // Legacy drafts without a public_token degrade silently — the existing
  // "Open & send invoice →" deep-link is the fallback path.
  const html = renderDashboard({
    freshDraftPrompt: {
      id: 17, invoiceNumber: 'X', clientName: 'A', total: 1, ageMinutes: 5,
      shareIntents: null
    }
  });
  assert.doesNotMatch(html, /data-testid="fresh-draft-share-intents"/);
});

test('view: share-intent row RENDERS the WhatsApp / SMS / Copy buttons when shareIntents is set', () => {
  const html = renderDashboard({
    freshDraftPrompt: {
      id: 17, invoiceNumber: 'X', clientName: 'A', total: 1, ageMinutes: 5,
      shareIntents: {
        whatsapp: 'https://wa.me/?text=Hi%20here%27s%20your%20invoice',
        sms: 'sms:?&body=Hi%20here%27s%20your%20invoice',
        url: 'https://app.example/i/abc1234567890def'
      }
    }
  });
  assert.match(html, /data-testid="fresh-draft-share-intents"/);
  assert.match(html, /data-testid="fresh-draft-share-whatsapp"/);
  assert.match(html, /data-testid="fresh-draft-share-sms"/);
  assert.match(html, /data-testid="fresh-draft-share-copy"/);
});

test('view: WhatsApp + SMS anchors use the URLs from shareIntents (no double-encoding)', () => {
  const html = renderDashboard({
    freshDraftPrompt: {
      id: 17, invoiceNumber: 'X', clientName: 'A', total: 1, ageMinutes: 5,
      shareIntents: {
        whatsapp: 'https://wa.me/?text=hello',
        sms: 'sms:?&body=hello',
        url: 'https://app.example/i/abc1234567890def'
      }
    }
  });
  // EJS <%= escapes &, <, > but the dashboard interpolates these URLs in
  // href attributes directly — so `&` becomes `&amp;` in the HTML output.
  // The browser parses these back to `&` when navigating the anchor.
  assert.match(html, /href="https:\/\/wa\.me\/\?text=hello"/,
    'WhatsApp anchor href surfaces the wa.me URL verbatim');
  assert.match(html, /href="sms:\?&amp;body=hello"/,
    'SMS anchor href encodes & as &amp; in the HTML attribute');
});

test('view: share-intent buttons fire POST /share-intent with the matching intent kind + CSRF token', () => {
  const html = renderDashboard({
    freshDraftPrompt: {
      id: 17, invoiceNumber: 'X', clientName: 'A', total: 1, ageMinutes: 5,
      shareIntents: {
        whatsapp: 'https://wa.me/?text=hello',
        sms: 'sms:?&body=hello',
        url: 'https://app.example/i/abc1234567890def'
      }
    }
  });
  // Each onclick handler must hit /invoices/17/share-intent so the atomic
  // draft→sent flip fires from this surface, just like on /invoices/:id.
  const waBlock = html.match(/data-testid="fresh-draft-share-whatsapp"[\s\S]*?<\/a>/);
  assert.ok(waBlock, 'WhatsApp anchor renders');
  assert.match(waBlock[0], /\/invoices\/17\/share-intent/);
  assert.match(waBlock[0], /intent:\s*'whatsapp'/);
  assert.match(waBlock[0], /X-CSRF-Token['"]\s*:\s*['"]TEST_CSRF/);

  const smsBlock = html.match(/data-testid="fresh-draft-share-sms"[\s\S]*?<\/a>/);
  assert.ok(smsBlock, 'SMS anchor renders');
  assert.match(smsBlock[0], /\/invoices\/17\/share-intent/);
  assert.match(smsBlock[0], /intent:\s*'sms'/);

  const copyBlock = html.match(/data-testid="fresh-draft-share-copy"[\s\S]*?<\/button>/);
  assert.ok(copyBlock, 'Copy button renders');
  assert.match(copyBlock[0], /\/invoices\/17\/share-intent/);
  assert.match(copyBlock[0], /intent:\s*'copy'/);
  assert.match(copyBlock[0], /data-share-url="https:\/\/app\.example\/i\/abc1234567890def"/,
    'Copy button carries the public URL for navigator.clipboard.writeText');
});

test('view: hostile URL in shareIntents.url is HTML-attribute-escaped (XSS guard)', () => {
  // Defence-in-depth — the URL is built by buildShareSurfaceForInvoice's
  // strict token regex, but if a malformed token ever slipped past the
  // gate, the rendered href + data attribute must not break out of the
  // attribute.
  const html = renderDashboard({
    freshDraftPrompt: {
      id: 17, invoiceNumber: 'X', clientName: 'A', total: 1, ageMinutes: 5,
      shareIntents: {
        whatsapp: 'https://wa.me/?text=hello',
        sms: 'sms:?&body=hello',
        url: '" onmouseover="alert(1)"'
      }
    }
  });
  assert.doesNotMatch(html, /data-share-url="" onmouseover="alert\(1\)/);
  // EJS <%= encodes " as &#34; (or &quot;); accept either form.
  assert.match(html, /data-share-url="(?:&#34;|&quot;) onmouseover=(?:&#34;|&quot;)alert\(1\)(?:&#34;|&quot;)"/);
});

// ---- Run ---------------------------------------------------------------

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
  console.log(`\n${passed} passed, ${failed} failed (fresh-draft-prompt.test.js)`);
  if (failed > 0) process.exit(1);
})();
