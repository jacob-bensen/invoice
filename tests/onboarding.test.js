'use strict';

/*
 * Onboarding checklist activation flow tests.
 *
 * Covers:
 *  - buildOnboardingState() pure logic (returns null when dismissed; flags
 *    each step done/not-done from user.business_name + invoice list).
 *  - dashboard.ejs renders the checklist card when onboarding is in progress
 *    and omits it when dismissed / fully complete / locals omitted.
 *  - Each completed step renders with a strikethrough; remaining steps render
 *    a CTA link to the relevant page.
 *  - POST /onboarding/dismiss calls db.dismissOnboarding for the session
 *    user, mutates req.session.user.onboarding_dismissed, and redirects to
 *    /invoices.
 *  - Unauthenticated POST /onboarding/dismiss redirects to /auth/login and
 *    never calls the DB.
 *  - The checklist card carries print:hidden so it does not leak into PDF /
 *    print rendering.
 *
 * Run: node tests/onboarding.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');
const express = require('express');
const session = require('express-session');
const http = require('http');

// ---------- Stub db -----------------------------------------------------

const dismissCalls = [];

const dbStub = {
  pool: { query: async () => ({ rows: [] }) },
  db: {
    async dismissOnboarding(userId) {
      dismissCalls.push(userId);
      return { id: userId };
    }
  }
};

require.cache[require.resolve('../db')] = {
  id: require.resolve('../db'),
  filename: require.resolve('../db'),
  loaded: true,
  exports: dbStub
};

// Avoid loading optional integrations when routes/invoices.js is required —
// we only need buildOnboardingState + onboardingDismissHandler from it.
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

function clearReq(mod) { delete require.cache[require.resolve(mod)]; }
clearReq('../routes/invoices');
const invoiceRoutes = require('../routes/invoices');
const { buildOnboardingState, onboardingDismissHandler } = invoiceRoutes;

// ---------- Helpers ------------------------------------------------------

const dashboardTplPath = path.join(__dirname, '..', 'views', 'dashboard.ejs');
const dashboardTpl = fs.readFileSync(dashboardTplPath, 'utf8');

function renderDashboard(locals) {
  return ejs.render(dashboardTpl, {
    title: 'Dashboard',
    flash: null,
    days_left_in_trial: 0,
    csrfToken: 'TEST_CSRF',
    invoices: [],
    user: { plan: 'free', invoice_count: 0, subscription_status: null },
    onboarding: null,
    ...locals
  }, {
    views: [path.join(__dirname, '..', 'views')],
    filename: dashboardTplPath
  });
}

function buildDismissApp(sessionUser) {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: true }));
  // Seed session.user only on the first request — let the dismiss handler's
  // mutation persist across the redirect into the inspect endpoint.
  app.use((req, _res, next) => {
    if (sessionUser && !req.session.user) req.session.user = { ...sessionUser };
    next();
  });
  app.post('/onboarding/dismiss', onboardingDismissHandler);
  app.get('/inspect-session', (req, res) => res.json({
    user: req.session.user || null
  }));
  return app;
}

function postForm(app, urlPath, cookieJar) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const headers = { 'Content-Length': 0 };
      if (cookieJar && cookieJar.cookie) headers.Cookie = cookieJar.cookie;
      const req = http.request(
        { hostname: '127.0.0.1', port, path: urlPath, method: 'POST', headers },
        (res) => {
          let data = '';
          res.on('data', (c) => data += c);
          res.on('end', () => {
            const setCookie = res.headers['set-cookie'];
            if (setCookie && cookieJar) {
              cookieJar.cookie = setCookie.map(c => c.split(';')[0]).join('; ');
            }
            server.close(() => resolve({
              status: res.statusCode,
              location: res.headers.location,
              body: data,
              setCookie
            }));
          });
        }
      );
      req.on('error', (err) => { server.close(); reject(err); });
      req.end();
    });
  });
}

function getJson(app, urlPath, cookieJar) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const headers = {};
      if (cookieJar && cookieJar.cookie) headers.Cookie = cookieJar.cookie;
      const req = http.request(
        { hostname: '127.0.0.1', port, path: urlPath, method: 'GET', headers },
        (res) => {
          let data = '';
          res.on('data', (c) => data += c);
          res.on('end', () => {
            server.close(() => resolve({
              status: res.statusCode,
              body: data ? JSON.parse(data) : null
            }));
          });
        }
      );
      req.on('error', (err) => { server.close(); reject(err); });
      req.end();
    });
  });
}

// ---------- Tests --------------------------------------------------------

function testBuildStateReturnsNullWhenDismissed() {
  const out = buildOnboardingState(
    { id: 1, business_name: '', onboarding_dismissed: true },
    []
  );
  assert.strictEqual(out, null,
    'buildOnboardingState must return null when user.onboarding_dismissed is true');
}

function testBuildStateReturnsNullWhenUserMissing() {
  assert.strictEqual(buildOnboardingState(null, []), null);
  assert.strictEqual(buildOnboardingState(undefined, [{ status: 'paid' }]), null);
}

function testBuildStateAllStepsIncomplete() {
  const out = buildOnboardingState({ id: 1, business_name: null, onboarding_dismissed: false }, []);
  assert.ok(out, 'expected onboarding object');
  assert.strictEqual(out.total, 4);
  assert.strictEqual(out.completed, 0);
  assert.strictEqual(out.allDone, false);
  for (const step of out.steps) {
    assert.strictEqual(step.done, false, `step ${step.key} should be incomplete for fresh user`);
  }
  const keys = out.steps.map(s => s.key);
  assert.deepStrictEqual(keys, ['business', 'create', 'send', 'paid'],
    'step keys must be in canonical order');
}

function testBuildStateBusinessInfoAdded() {
  const out = buildOnboardingState(
    { id: 1, business_name: 'Acme LLC', onboarding_dismissed: false },
    []
  );
  const businessStep = out.steps.find(s => s.key === 'business');
  assert.strictEqual(businessStep.done, true,
    'business step must be done when business_name is non-empty');
  assert.strictEqual(out.completed, 1);
}

function testBuildStateBusinessInfoIgnoresWhitespace() {
  const out = buildOnboardingState(
    { id: 1, business_name: '   ', onboarding_dismissed: false },
    []
  );
  assert.strictEqual(out.steps.find(s => s.key === 'business').done, false,
    'whitespace-only business_name must not count as completed');
}

function testBuildStateInvoiceCreated() {
  const out = buildOnboardingState(
    { id: 1, business_name: '', onboarding_dismissed: false },
    [{ status: 'draft' }]
  );
  const create = out.steps.find(s => s.key === 'create');
  const send = out.steps.find(s => s.key === 'send');
  assert.strictEqual(create.done, true, 'create step done when at least one invoice exists');
  assert.strictEqual(send.done, false, 'send step still incomplete for draft-only invoices');
}

function testBuildStateSendStepCountsSentPaidOverdue() {
  for (const status of ['sent', 'paid', 'overdue']) {
    const out = buildOnboardingState(
      { id: 1, business_name: '', onboarding_dismissed: false },
      [{ status }]
    );
    const send = out.steps.find(s => s.key === 'send');
    assert.strictEqual(send.done, true,
      `send step should count status="${status}" as sent`);
  }
}

function testBuildStatePaidStep() {
  const incomplete = buildOnboardingState(
    { id: 1, business_name: 'Acme', onboarding_dismissed: false },
    [{ status: 'sent' }, { status: 'overdue' }]
  );
  assert.strictEqual(incomplete.steps.find(s => s.key === 'paid').done, false,
    'paid step is incomplete until at least one invoice is paid');

  const complete = buildOnboardingState(
    { id: 1, business_name: 'Acme', onboarding_dismissed: false },
    [{ status: 'paid' }]
  );
  assert.strictEqual(complete.steps.find(s => s.key === 'paid').done, true,
    'paid step is done when any invoice has status=paid');
}

function testBuildStateAllDone() {
  const out = buildOnboardingState(
    { id: 1, business_name: 'Acme', onboarding_dismissed: false },
    [{ status: 'paid' }]
  );
  assert.strictEqual(out.completed, 4,
    'all four steps complete when business_name + paid invoice exist');
  assert.strictEqual(out.allDone, true);
}

function testDashboardRendersChecklistWhenInProgress() {
  const onboarding = buildOnboardingState(
    { id: 1, business_name: '', onboarding_dismissed: false },
    [{ status: 'draft' }]
  );
  const html = renderDashboard({ onboarding });
  assert.ok(/data-testid=["']onboarding-checklist["']/.test(html),
    'dashboard must render onboarding-checklist region when state is in-progress');
  assert.ok(/Get up and running/.test(html), 'card must show heading');
  assert.ok(/1 of 4 steps complete/.test(html),
    'card must show progress count derived from state');
  assert.ok(/Add your business info/.test(html), 'business step label rendered');
  assert.ok(/Create your first invoice/.test(html), 'create step label rendered');
  assert.ok(/print:hidden/.test(html), 'card must carry print:hidden so it does not leak into print view');
  assert.ok(/action=["']\/onboarding\/dismiss["']/.test(html),
    'dismiss form must POST to /onboarding/dismiss');
  assert.ok(/name=["']_csrf["']/.test(html),
    'dismiss form must include CSRF token field');
}

function testDashboardCompletedStepStrikethrough() {
  const onboarding = buildOnboardingState(
    { id: 1, business_name: 'Acme LLC', onboarding_dismissed: false },
    [{ status: 'sent' }]
  );
  const html = renderDashboard({ onboarding });
  // The business step is done — must render the label inside a line-through
  // span instead of a CTA link.
  assert.ok(/line-through[^>]*>\s*Add your business info\s*</.test(html),
    'completed step must render with line-through styling');
  // The paid step is still incomplete — must render as a link.
  assert.ok(/<a[^>]+href=["']\/invoices["'][^>]*>Get paid/.test(html),
    'incomplete "Get paid" step must render as a CTA link');
}

function testDashboardOmitsCardWhenAllDone() {
  const onboarding = buildOnboardingState(
    { id: 1, business_name: 'Acme', onboarding_dismissed: false },
    [{ status: 'paid' }]
  );
  const html = renderDashboard({ onboarding });
  assert.ok(!/data-testid=["']onboarding-checklist["']/.test(html),
    'completed checklist must hide itself once all four steps are done');
}

function testDashboardOmitsCardWhenDismissed() {
  // buildOnboardingState already returns null when dismissed; the dashboard
  // route would pass null. Verify the template handles the null case.
  const html = renderDashboard({ onboarding: null });
  assert.ok(!/data-testid=["']onboarding-checklist["']/.test(html),
    'dismissed users must not see the checklist card');
}

function testDashboardOmitsCardWhenLocalUndefined() {
  // The catch-branch in the dashboard route falls back to onboarding: null;
  // older error paths might omit the local entirely. The template must not
  // crash either way.
  const tpl = fs.readFileSync(dashboardTplPath, 'utf8');
  const html = ejs.render(tpl, {
    title: 'Dashboard',
    flash: null,
    days_left_in_trial: 0,
    csrfToken: 'T',
    invoices: [],
    user: { plan: 'free', invoice_count: 0, subscription_status: null }
    // onboarding intentionally omitted
  }, { views: [path.join(__dirname, '..', 'views')], filename: dashboardTplPath });
  assert.ok(!/data-testid=["']onboarding-checklist["']/.test(html),
    'dashboard must not render checklist when onboarding local is missing');
}

// ---------- Empty-state Pro tip (CHANGELOG 2026-04-26 / closes U2) -------
// The dashboard empty state shows a Free-only "Pro tip" callout below the
// "Create your first invoice" CTA. This is income-critical conversion copy:
// it's the peak-intent moment (just signed up, no invoices yet) and the only
// surface where free users see a Pro upsell *before* hitting the 3-invoice
// hard wall. A regression that hides the tip silently kills conversion;
// regressions that show it to Pro/Business/Agency users degrade trust.

function testEmptyStateProTipShownToFreeUsers() {
  const html = renderDashboard({
    invoices: [],
    user: { plan: 'free', invoice_count: 0, subscription_status: null }
  });
  // The Pro callout in the empty state was reworded 2026-04-27 PM-2 from
  // "Pro tip: with Pro, every invoice auto-generates a Stripe Pay button..."
  // to the more concrete, action-oriented "Pro adds a 'Pay now' button to
  // every invoice — clients pay in one click via Stripe." The regression
  // guards now key off the action-button language ("Pay now" button) and
  // the trial CTA copy, both of which are the load-bearing parts of the
  // upsell.
  assert.match(html, /Pro adds a/,
    'Free user empty state must include the Pro upsell callout');
  assert.match(html, /["“]Pay now["”]\s*<\/strong>?\s*button|"Pay now" button/,
    'Empty-state callout must reference the concrete "Pay now" button benefit');
  assert.match(html, /Try Pro free for 7 days/,
    'Empty-state callout must include the "Try Pro free for 7 days" CTA copy');
  assert.match(html, /href=["']\/billing\/upgrade["']/,
    'Empty-state CTA must link to /billing/upgrade');
  assert.match(html, /Stripe/,
    'Empty-state callout must mention Stripe (the concrete payment processor)');
}

function testEmptyStateProTipHiddenForPaidPlans() {
  for (const plan of ['pro', 'business', 'agency']) {
    const html = renderDashboard({
      invoices: [],
      user: { plan, invoice_count: 0, subscription_status: 'active' }
    });
    assert.ok(!/Pro adds a/.test(html),
      `${plan} users must NOT see the Pro callout in the empty state (already paid)`);
    assert.ok(!/Try Pro free for 7 days/.test(html),
      `${plan} users must NOT see the trial CTA in the empty state`);
  }
}

function testEmptyStateProTipHiddenWhenInvoicesExist() {
  // The Pro callout is bound to the "no invoices yet" empty state — once a
  // Free user creates an invoice, the empty-state container is replaced
  // with the stats grid, and the upsell shifts to the contextual upgrade
  // modal / pricing page. Defence-in-depth check that the regex doesn't
  // match anywhere outside the empty-state branch.
  const html = renderDashboard({
    invoices: [{
      id: 1, invoice_number: 'INV-1', client_name: 'Acme', total: '100.00',
      status: 'draft', issued_date: new Date(), due_date: new Date(),
      created_at: new Date(), payment_link_url: null
    }],
    user: { plan: 'free', invoice_count: 1, subscription_status: null }
  });
  assert.ok(!/Pro adds a/.test(html),
    'Pro callout must not appear once the user has any invoices (empty-state branch is gone)');
}

async function testDismissHandlerCallsDbAndRedirects() {
  dismissCalls.length = 0;
  const app = buildDismissApp({ id: 42, email: 'u@test.io', plan: 'free' });
  const jar = {};

  const res = await postForm(app, '/onboarding/dismiss', jar);
  assert.strictEqual(res.status, 302, 'dismiss must redirect after success');
  assert.strictEqual(res.location, '/invoices',
    'dismiss must redirect back to the dashboard');
  assert.deepStrictEqual(dismissCalls, [42],
    'dismissOnboarding must be called once with the session user id');

  const inspect = await getJson(app, '/inspect-session', jar);
  assert.strictEqual(inspect.body.user.onboarding_dismissed, true,
    'session user must be flagged dismissed so the next render skips the card without a refetch');
}

async function testDismissHandlerUnauthenticatedRedirectsToLogin() {
  // Use the real handler directly (bypassing requireAuth which lives in
  // server.js for the production path). The handler defends in depth:
  // even when reached without a session it must redirect to /auth/login
  // and must not invoke the DB.
  dismissCalls.length = 0;
  const calls = [];
  const fakeReq = { session: {} };
  const fakeRes = {
    redirect(url) { calls.push(['redirect', url]); }
  };
  await onboardingDismissHandler(fakeReq, fakeRes);
  assert.deepStrictEqual(calls, [['redirect', '/auth/login']],
    'unauthenticated dismiss must redirect to /auth/login');
  assert.strictEqual(dismissCalls.length, 0,
    'unauthenticated dismiss must NOT invoke the DB');
}

async function testDismissHandlerSwallowsDbErrors() {
  // A DB outage during dismiss must still redirect the user, not 500.
  dismissCalls.length = 0;
  const originalFn = dbStub.db.dismissOnboarding;
  dbStub.db.dismissOnboarding = async () => { throw new Error('db down'); };
  try {
    const calls = [];
    const fakeReq = { session: { user: { id: 7 } } };
    const fakeRes = { redirect(url) { calls.push(url); } };
    await onboardingDismissHandler(fakeReq, fakeRes);
    assert.deepStrictEqual(calls, ['/invoices'],
      'DB outage must not block the redirect');
  } finally {
    dbStub.db.dismissOnboarding = originalFn;
  }
}

// ---------- Runner -------------------------------------------------------

async function run() {
  const tests = [
    ['buildOnboardingState: dismissed user → null', testBuildStateReturnsNullWhenDismissed],
    ['buildOnboardingState: missing user → null', testBuildStateReturnsNullWhenUserMissing],
    ['buildOnboardingState: fresh user → all incomplete', testBuildStateAllStepsIncomplete],
    ['buildOnboardingState: business_name marks business step done', testBuildStateBusinessInfoAdded],
    ['buildOnboardingState: whitespace business_name does not count', testBuildStateBusinessInfoIgnoresWhitespace],
    ['buildOnboardingState: any invoice marks create step done', testBuildStateInvoiceCreated],
    ['buildOnboardingState: send step counts sent/paid/overdue', testBuildStateSendStepCountsSentPaidOverdue],
    ['buildOnboardingState: paid step requires status=paid', testBuildStatePaidStep],
    ['buildOnboardingState: allDone flips when 4/4', testBuildStateAllDone],
    ['dashboard.ejs: renders checklist when in-progress', testDashboardRendersChecklistWhenInProgress],
    ['dashboard.ejs: completed step strikethrough; pending step is a link', testDashboardCompletedStepStrikethrough],
    ['dashboard.ejs: omits checklist once all 4 steps done', testDashboardOmitsCardWhenAllDone],
    ['dashboard.ejs: omits checklist when onboarding is null (dismissed)', testDashboardOmitsCardWhenDismissed],
    ['dashboard.ejs: omits checklist when local is undefined', testDashboardOmitsCardWhenLocalUndefined],
    ['empty state: Pro tip shown to Free users (conversion copy)', testEmptyStateProTipShownToFreeUsers],
    ['empty state: Pro tip hidden for pro/business/agency users', testEmptyStateProTipHiddenForPaidPlans],
    ['empty state: Pro tip hidden when invoices exist', testEmptyStateProTipHiddenWhenInvoicesExist],
    ['POST /onboarding/dismiss: persists + flags session + redirects', testDismissHandlerCallsDbAndRedirects],
    ['onboardingDismissHandler: unauth → /auth/login, no DB call', testDismissHandlerUnauthenticatedRedirectsToLogin],
    ['onboardingDismissHandler: swallows DB errors and still redirects', testDismissHandlerSwallowsDbErrors]
  ];

  let pass = 0, fail = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ok  ${name}`);
      pass++;
    } catch (err) {
      console.error(`  FAIL ${name}`);
      console.error(err && err.stack ? err.stack : err);
      fail++;
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run().catch(err => { console.error(err); process.exit(1); });
