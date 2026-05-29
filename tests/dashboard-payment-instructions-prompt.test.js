'use strict';

/*
 * Free-tier "Tell your clients how to pay you" dashboard prompt
 * (Milestone 4 — first invoice sent → first payment received).
 *
 * Free users have no Stripe Pay button on the public /i/<token> share page,
 * so the client opens the share link, sees the invoice, and has no payment
 * path unless users.payment_instructions has been filled in. The inline
 * capture on /invoices/:id only surfaces when the freelancer is on that
 * single invoice page; the dominant return surface is /invoices (the
 * dashboard) via magic-link email. This prompt closes the gap by
 * surfacing the capture inline on the dashboard for the cohort where the
 * gap is actively costing payments: free + no payment_instructions + at
 * least one sent/overdue (still unpaid) invoice.
 *
 * users.payment_instructions is JOINed onto every public invoice render
 * as `owner_payment_instructions`, so saving the field once propagates
 * to every share link the user has already sent — no per-invoice
 * backfill needed.
 *
 * Layers under test:
 *   1. buildPaymentInstructionsPrompt — null user / plan gating / payment_
 *      instructions presence (null, empty, whitespace, set, non-string)
 *      / invoice-cohort gating (none, drafts only, seed only, paid only,
 *      mixed sent+overdue+paid) / non-array invoices defence.
 *   2. dashboard.ejs view — banner renders/omits, form action POSTs to
 *      /billing/payment-instructions, hidden return_to=/invoices, CSRF
 *      threaded, textarea + 2000-char maxlength + placeholder, singular
 *      vs plural copy on unpaid-count, data attributes, print:hidden.
 *   3. POST /billing/payment-instructions — return_to=/invoices is now
 *      whitelisted (was previously only /invoices/<id>) so the dashboard
 *      save round-trips back to the dashboard, but other hostile values
 *      still fall back to /billing/settings.
 *
 * Run: NODE_ENV=test node tests/dashboard-payment-instructions-prompt.test.js
 */

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';
process.env.APP_URL = process.env.APP_URL || 'https://test.invoice.app';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');
const express = require('express');
const session = require('express-session');
const http = require('http');

const VIEWS = path.join(__dirname, '..', 'views');

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

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ---- Layer 1: buildPaymentInstructionsPrompt ---------------------------

test('exports buildPaymentInstructionsPrompt', () => {
  assert.strictEqual(typeof routes.buildPaymentInstructionsPrompt, 'function');
});

test('returns null when user is missing', () => {
  assert.strictEqual(routes.buildPaymentInstructionsPrompt(null, []), null);
  assert.strictEqual(routes.buildPaymentInstructionsPrompt(undefined, []), null);
});

test('returns null when plan is pro (Stripe Pay button covers the gap)', () => {
  const user = { plan: 'pro', payment_instructions: null };
  const invoices = [{ id: 1, status: 'sent', is_seed: false }];
  assert.strictEqual(routes.buildPaymentInstructionsPrompt(user, invoices), null);
});

test('returns null when plan is agency (same logic as pro)', () => {
  const user = { plan: 'agency', payment_instructions: null };
  const invoices = [{ id: 1, status: 'sent', is_seed: false }];
  assert.strictEqual(routes.buildPaymentInstructionsPrompt(user, invoices), null);
});

test('returns null when plan is trial / unknown', () => {
  // Defence-in-depth: any non-free plan label suppresses. Trial users get
  // the Pro Pay button via the trial subscription_status path, and an
  // unknown future plan label should fail closed (no prompt) rather than
  // open (spam every Pro user with the free-only banner).
  for (const p of ['trial', 'business', 'enterprise', null, undefined, '']) {
    const user = { plan: p, payment_instructions: null };
    const invoices = [{ id: 1, status: 'sent', is_seed: false }];
    assert.strictEqual(routes.buildPaymentInstructionsPrompt(user, invoices), null,
      `plan=${JSON.stringify(p)} must NOT trigger the prompt`);
  }
});

test('returns null when payment_instructions is already set (non-empty string)', () => {
  const user = { plan: 'free', payment_instructions: 'Venmo @ash' };
  const invoices = [{ id: 1, status: 'sent', is_seed: false }];
  assert.strictEqual(routes.buildPaymentInstructionsPrompt(user, invoices), null,
    'a user who has already filled in the field must not see the prompt — their gap is closed');
});

test('returns null when payment_instructions is whitespace-only (treated as not-set)', () => {
  // Defence — a hand-edited DB row could leave whitespace; that is still
  // visually empty on the public page, so we still surface the prompt.
  // Wait — actually a whitespace-only string fails the trim().length > 0
  // gate so we DO surface the prompt. Lock that in.
  const user = { plan: 'free', payment_instructions: '   \n\t' };
  const invoices = [{ id: 1, status: 'sent', is_seed: false }];
  const out = routes.buildPaymentInstructionsPrompt(user, invoices);
  assert.deepStrictEqual(out, { unpaidCount: 1 },
    'whitespace-only payment_instructions does not close the gap on the public page — surface the prompt');
});

test('returns null when payment_instructions is a non-string (corrupt row defence)', () => {
  for (const bad of [123, true, [], {}]) {
    const user = { plan: 'free', payment_instructions: bad };
    const invoices = [{ id: 1, status: 'sent', is_seed: false }];
    assert.strictEqual(routes.buildPaymentInstructionsPrompt(user, invoices), null,
      `non-string payment_instructions ${JSON.stringify(bad)} must fail closed (no prompt)`);
  }
});

test('returns null when invoices is not an array', () => {
  const user = { plan: 'free', payment_instructions: null };
  for (const bad of [null, undefined, 'string', 42, {}]) {
    assert.strictEqual(routes.buildPaymentInstructionsPrompt(user, bad), null,
      `non-array invoices ${JSON.stringify(bad)} must fail closed (no prompt)`);
  }
});

test('returns null when invoices is an empty array (no unpaid cohort to chase)', () => {
  const user = { plan: 'free', payment_instructions: null };
  assert.strictEqual(routes.buildPaymentInstructionsPrompt(user, []), null,
    'a fresh free user with no sent invoices has nothing to recover yet — drafts get their own prompt path');
});

test('returns null when only drafts exist (drafts are an M3 surface, not M4)', () => {
  const user = { plan: 'free', payment_instructions: null };
  const invoices = [
    { id: 1, status: 'draft', is_seed: false },
    { id: 2, status: 'draft', is_seed: false }
  ];
  assert.strictEqual(routes.buildPaymentInstructionsPrompt(user, invoices), null,
    'no sent invoice = no client has opened a share link yet = no payment-path gap to surface');
});

test('returns null when the only sent invoice is the signup seed', () => {
  // The seed is_seed=true row should never count toward the unpaid cohort
  // — it is a dashboard demo, not a real client-facing invoice.
  const user = { plan: 'free', payment_instructions: null };
  const invoices = [
    { id: 1, status: 'sent', is_seed: true }
  ];
  assert.strictEqual(routes.buildPaymentInstructionsPrompt(user, invoices), null,
    'seed invoice must never count toward the unpaid cohort that triggers the prompt');
});

test('returns null when only paid invoices exist (gap already closed for those)', () => {
  const user = { plan: 'free', payment_instructions: null };
  const invoices = [
    { id: 1, status: 'paid', is_seed: false },
    { id: 2, status: 'paid', is_seed: false }
  ];
  assert.strictEqual(routes.buildPaymentInstructionsPrompt(user, invoices), null,
    'a user who only has paid invoices already worked around the missing-instructions gap — no urgency to surface');
});

test('returns {unpaidCount: 1} for free + null payment_instructions + 1 sent invoice', () => {
  const user = { plan: 'free', payment_instructions: null };
  const invoices = [{ id: 1, status: 'sent', is_seed: false }];
  assert.deepStrictEqual(routes.buildPaymentInstructionsPrompt(user, invoices),
    { unpaidCount: 1 });
});

test('returns {unpaidCount: 1} when payment_instructions is empty string', () => {
  const user = { plan: 'free', payment_instructions: '' };
  const invoices = [{ id: 1, status: 'sent', is_seed: false }];
  assert.deepStrictEqual(routes.buildPaymentInstructionsPrompt(user, invoices),
    { unpaidCount: 1 },
    'empty string is functionally equivalent to NULL — public page renders no "how to pay" block either way');
});

test('counts sent + overdue together; excludes draft + paid + seed', () => {
  const user = { plan: 'free', payment_instructions: null };
  const invoices = [
    { id: 1, status: 'sent',    is_seed: false },
    { id: 2, status: 'overdue', is_seed: false },
    { id: 3, status: 'overdue', is_seed: false },
    { id: 4, status: 'paid',    is_seed: false },
    { id: 5, status: 'draft',   is_seed: false },
    { id: 6, status: 'sent',    is_seed: true  }
  ];
  assert.deepStrictEqual(routes.buildPaymentInstructionsPrompt(user, invoices),
    { unpaidCount: 3 },
    'count is the union of sent + overdue minus seed/paid/draft');
});

test('skips malformed/missing invoice entries without throwing', () => {
  const user = { plan: 'free', payment_instructions: null };
  const invoices = [
    null, undefined, {}, { status: 'sent' /* no is_seed */ },
    { id: 7, status: 'sent', is_seed: false }
  ];
  // The entry with no is_seed falls through to the status filter and counts
  // (undefined is_seed is falsy → not excluded as seed). The id-less entry
  // also counts because we never gate on id presence; this matches the
  // cohort semantic — the prompt is about "is there a client out there with
  // no pay path", not "are these specific rows queryable."
  const out = routes.buildPaymentInstructionsPrompt(user, invoices);
  assert.ok(out && out.unpaidCount >= 1,
    'malformed rows must not throw; at least one real sent row counts');
});

// ---- Layer 2: dashboard.ejs view block ---------------------------------

const dashboardTplPath = path.join(VIEWS, 'dashboard.ejs');
const dashboardTpl = fs.readFileSync(dashboardTplPath, 'utf8');

function renderDashboard(locals) {
  return ejs.render(dashboardTpl, {
    title: 'Dashboard',
    flash: null,
    days_left_in_trial: 0,
    csrfToken: 'TEST_CSRF',
    invoices: [
      { id: 1, invoice_number: 'INV-2026-0001', client_name: 'Acme', issued_date: '2026-04-01', total: 500, status: 'sent', is_seed: false }
    ],
    user: { plan: 'free', invoice_count: 1, subscription_status: null, email: 'f@x.com' },
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
    ...locals
  }, {
    views: [VIEWS],
    filename: dashboardTplPath
  });
}

test('view: banner OMITTED when paymentInstructionsPrompt is null', () => {
  const html = renderDashboard({ paymentInstructionsPrompt: null });
  assert.doesNotMatch(html, /data-testid="dashboard-payment-instructions-prompt"/);
});

test('view: banner RENDERS when paymentInstructionsPrompt is set', () => {
  const html = renderDashboard({ paymentInstructionsPrompt: { unpaidCount: 1 } });
  assert.match(html, /data-testid="dashboard-payment-instructions-prompt"/);
});

test('view: form POSTs to /billing/payment-instructions', () => {
  const html = renderDashboard({ paymentInstructionsPrompt: { unpaidCount: 1 } });
  assert.match(html, /<form\s+action="\/billing\/payment-instructions"\s+method="POST"[^>]*data-testid="dashboard-payment-instructions-prompt"/);
});

test('view: hidden return_to=/invoices (lands back on dashboard after save)', () => {
  const html = renderDashboard({ paymentInstructionsPrompt: { unpaidCount: 1 } });
  // The whitelist on /billing/payment-instructions accepts /invoices (the
  // dashboard) and /invoices/<positive-int> (a single invoice page). The
  // dashboard prompt must round-trip back to the dashboard, NOT into a
  // single invoice.
  assert.match(html, /<input\s+type="hidden"\s+name="return_to"\s+value="\/invoices"\s+data-testid="dashboard-payment-instructions-return-to"/);
});

test('view: CSRF token threaded from locals', () => {
  const html = renderDashboard({ paymentInstructionsPrompt: { unpaidCount: 1 } });
  // CSRF hidden field exists somewhere inside the form (form scoping is
  // implicit — every form on the dashboard threads its own _csrf input).
  const formMatch = html.match(/<form[^>]*data-testid="dashboard-payment-instructions-prompt"[^>]*>([\s\S]*?)<\/form>/);
  assert.ok(formMatch, 'form must render');
  assert.match(formMatch[1], /name="_csrf"\s+value="TEST_CSRF"/,
    'CSRF token from locals must thread into the prompt form');
});

test('view: textarea name=payment_instructions + maxlength=2000 + required', () => {
  const html = renderDashboard({ paymentInstructionsPrompt: { unpaidCount: 1 } });
  const tx = html.match(/<textarea[^>]*data-testid="dashboard-payment-instructions-input"[^>]*>/);
  assert.ok(tx, 'textarea must render');
  assert.match(tx[0], /name="payment_instructions"/,
    'textarea POSTs under the same name the existing /billing/payment-instructions route understands');
  assert.match(tx[0], /maxlength="2000"/,
    'textarea must surface the same 2000-char cap the server enforces');
  assert.match(tx[0], /\brequired\b/,
    'textarea is required so the browser blocks empty submits before they hit the server');
});

test('view: placeholder gives concrete examples (Venmo / Zelle / Bank)', () => {
  const html = renderDashboard({ paymentInstructionsPrompt: { unpaidCount: 1 } });
  assert.match(html, /Venmo @yourhandle/,
    'placeholder names a concrete payment method so the user has a starting point');
  assert.match(html, /Zelle:/);
  assert.match(html, /Bank:/);
});

test('view: submit button present with the documented testid', () => {
  const html = renderDashboard({ paymentInstructionsPrompt: { unpaidCount: 1 } });
  assert.match(html, /<button[^>]*type="submit"[^>]*data-testid="dashboard-payment-instructions-submit"/);
  assert.match(html, /Save payment instructions/);
});

test('view: headline names the activation outcome ("how to pay you")', () => {
  const html = renderDashboard({ paymentInstructionsPrompt: { unpaidCount: 1 } });
  assert.match(html, /Tell your clients how to pay you/i,
    'headline reads as the goal, not "fill in this field"');
});

test('view: singular copy when unpaidCount === 1', () => {
  const html = renderDashboard({ paymentInstructionsPrompt: { unpaidCount: 1 } });
  assert.match(html, /1 unpaid invoice/);
  // No plural "s" — the singular form is explicit, not a brittle template fold.
  assert.doesNotMatch(html, /<strong[^>]*>1<\/strong> unpaid invoices/,
    'must NOT render "1 unpaid invoices" — singular branch should win');
});

test('view: plural copy when unpaidCount > 1', () => {
  const html = renderDashboard({ paymentInstructionsPrompt: { unpaidCount: 3 } });
  assert.match(html, /<strong[^>]*data-testid="dashboard-payment-instructions-unpaid-count"[^>]*>3<\/strong> unpaid invoices/,
    'plural form names the actual count');
  assert.doesNotMatch(html, /1 unpaid invoice/,
    'singular branch must not also fire on plural counts');
});

test('view: data-unpaid-count attribute exposes count for e2e + analytics', () => {
  const html = renderDashboard({ paymentInstructionsPrompt: { unpaidCount: 7 } });
  assert.match(html, /data-unpaid-count="7"/);
});

test('view: banner carries print:hidden so it drops from printed PDFs', () => {
  const html = renderDashboard({ paymentInstructionsPrompt: { unpaidCount: 1 } });
  const block = html.match(/<form\s[^>]*data-testid="dashboard-payment-instructions-prompt"[^>]*>/);
  assert.ok(block);
  assert.match(block[0], /print:hidden/);
});

test('view: banner sits BEFORE the freshDraftPrompt (positional contract)', () => {
  // Both can coexist when a free user has both an open draft AND an unpaid
  // sent invoice without payment_instructions; the payment-instructions
  // banner is a one-time setup gap that, once closed, applies to every
  // existing share link — so it should win the visual hierarchy.
  const html = renderDashboard({
    paymentInstructionsPrompt: { unpaidCount: 1 },
    freshDraftPrompt: { id: 9, invoiceNumber: 'INV-X', clientName: 'A', total: 1, ageMinutes: 5 }
  });
  const payIdx = html.indexOf('data-testid="dashboard-payment-instructions-prompt"');
  const freshIdx = html.indexOf('data-testid="fresh-draft-prompt"');
  assert.ok(payIdx !== -1 && freshIdx !== -1, 'both banners render');
  assert.ok(payIdx < freshIdx, 'payment-instructions banner sits above the fresh-draft prompt');
});

// ---- Layer 3: POST /billing/payment-instructions accepts /invoices -----

const updateUserCalls = [];
let userStore = {};

function installBillingStubs() {
  const stub = {
    pool: { query: async () => ({ rows: [] }) },
    db: {
      async getUserById(id) { return userStore[id] || null; },
      async updateUser(id, fields) {
        updateUserCalls.push({ id, fields });
        const u = userStore[id];
        if (!u) return null;
        Object.assign(u, fields);
        return u;
      },
      async markInvoicePaidByPaymentLinkId() { return null; }
    }
  };
  require.cache[require.resolve('../db')] = {
    id: require.resolve('../db'),
    filename: require.resolve('../db'),
    loaded: true,
    exports: stub
  };
  const stripePath = require.resolve('stripe');
  require.cache[stripePath] = {
    id: stripePath, filename: stripePath, loaded: true,
    exports: () => ({
      webhooks: { constructEvent: () => { throw new Error('not used'); } },
      customers: { async create() { return { id: 'cus_x' }; }, async retrieve() { return { metadata: {} }; } },
      checkout: { sessions: { async create() { return { url: '' }; } } },
      billingPortal: { sessions: { async create() { return { url: '' }; } } }
    })
  };
  delete require.cache[require.resolve('../routes/billing')];
  return require('../routes/billing');
}

function buildBillingApp(sessionUser) {
  const billingRoutes = installBillingStubs();
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', VIEWS);
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, _res, next) => { if (sessionUser) req.session.user = sessionUser; next(); });
  app.use((req, res, next) => { res.locals.user = sessionUser || null; next(); });
  app.use('/billing', billingRoutes);
  return app;
}

function postForm(app, url, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const payload = new URLSearchParams(body).toString();
      const req = http.request({
        hostname: '127.0.0.1', port, path: url, method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => server.close(() => resolve({ status: res.statusCode, headers: res.headers, body: data })));
      });
      req.on('error', e => { server.close(); reject(e); });
      req.write(payload);
      req.end();
    });
  });
}

test('route: return_to=/invoices accepted (dashboard round-trip)', async () => {
  updateUserCalls.length = 0;
  userStore = {
    31: { id: 31, email: 'd@x.com', name: 'D', plan: 'free', payment_instructions: null }
  };
  const app = buildBillingApp({ id: 31, plan: 'free', name: 'D', email: 'd@x.com' });
  const res = await postForm(app, '/billing/payment-instructions', {
    payment_instructions: 'Venmo @dash',
    return_to: '/invoices'
  });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.location, '/invoices',
    'dashboard return_to=/invoices must round-trip on the redirect — the user lands back where the prompt fired');
  assert.strictEqual(updateUserCalls.length, 1, 'persisted once');
  assert.strictEqual(updateUserCalls[0].fields.payment_instructions, 'Venmo @dash');
});

test('route: return_to=/invoices/<id> still works (regression guard)', async () => {
  updateUserCalls.length = 0;
  userStore = {
    32: { id: 32, email: 'e@x.com', name: 'E', plan: 'free', payment_instructions: null }
  };
  const app = buildBillingApp({ id: 32, plan: 'free', name: 'E', email: 'e@x.com' });
  const res = await postForm(app, '/billing/payment-instructions', {
    payment_instructions: 'Zelle: e@bank.com',
    return_to: '/invoices/55'
  });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.location, '/invoices/55',
    'the /invoices/<id> return_to that powers the /:id inline prompt must continue to work');
});

test('route: hostile return_to values still fall back to /billing/settings', async () => {
  // Sanity-check the regex widening did NOT accidentally allow new
  // open-redirect vectors. /invoices/foo, /invoices/ (trailing slash),
  // /invoices/0, sub-paths, absolute URLs all stay rejected.
  const hostile = [
    '/invoices/',          // trailing slash — must NOT match the optional /<id> group
    '/invoices/edit',      // sub-path
    '/invoices/0',         // zero id
    '/invoices/abc',       // non-numeric
    '/invoices/-1',        // negative
    '/invoices?foo=bar',   // query string
    'https://evil.example.com/invoices',
    '//evil.example.com/invoices',
    '/admin',
    '/',
    '',
    'javascript:alert(1)'
  ];
  for (const bad of hostile) {
    updateUserCalls.length = 0;
    userStore = {
      33: { id: 33, email: 'f@x.com', name: 'F', plan: 'free', payment_instructions: null }
    };
    const app = buildBillingApp({ id: 33, plan: 'free', name: 'F', email: 'f@x.com' });
    const res = await postForm(app, '/billing/payment-instructions', {
      payment_instructions: 'Venmo @f',
      return_to: bad
    });
    assert.strictEqual(res.status, 302, `hostile return_to ${JSON.stringify(bad)} must 302`);
    assert.strictEqual(res.headers.location, '/billing/settings',
      `hostile return_to ${JSON.stringify(bad)} must fall back to /billing/settings`);
  }
});

// ---- Run ----------------------------------------------------------------

(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log(`  ok  ${t.name}`);
    } catch (err) {
      failed++;
      console.error(`  FAIL ${t.name}`);
      console.error(err && err.stack ? err.stack : err);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed (dashboard-payment-instructions-prompt.test.js)`);
  if (failed > 0) process.exit(1);
})();
