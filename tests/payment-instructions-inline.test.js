'use strict';

/*
 * Inline "How to pay" capture on /invoices/:id (Milestone 4 — first invoice
 * sent → first payment received).
 *
 * Free-tier users have no Stripe Pay button on their public /i/<token>
 * share page, so the client opens the link, sees the invoice, and has no
 * way to actually pay unless users.payment_instructions is set. The
 * existing /billing/settings page captures the field but requires the user
 * to navigate away from the share flow — most never do. This ship adds an
 * inline prompt that fires at the share moment.
 *
 * Covers:
 *  - POST /billing/payment-instructions: persists payment_instructions
 *    (trimmed, newlines preserved), redirects to return_to when it matches
 *    the /invoices/<positive-int> whitelist, falls back to
 *    /billing/settings for any non-matching value (open-redirect guard),
 *    rejects empty + > 2000 chars, redirects to /auth/login on missing user.
 *  - views/invoice-view.ejs: the inline prompt renders for free + no
 *    instructions + non-paid invoice, suppresses for Pro / Agency, suppresses
 *    when instructions already set, suppresses on paid, threads the CSRF
 *    token + invoice-id return_to.
 *
 * Run: NODE_ENV=test node tests/payment-instructions-inline.test.js
 */

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';
process.env.APP_URL = process.env.APP_URL || 'https://test.invoice.app';

const assert = require('assert');
const path = require('path');
const ejs = require('ejs');
const express = require('express');
const session = require('express-session');
const http = require('http');

const VIEWS = path.join(__dirname, '..', 'views');

// ---------- POST /billing/payment-instructions plumbing ------------------

const updateUserCalls = [];
let userStore = {};

function installBillingStubs() {
  const dbStub = {
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
    exports: dbStub
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

// ---------- Route tests --------------------------------------------------

async function testInlineRoutePersistsAndRedirectsToInvoice() {
  updateUserCalls.length = 0;
  userStore = {
    21: { id: 21, email: 'a@x.com', name: 'A', plan: 'free', payment_instructions: null }
  };
  const app = buildBillingApp({ id: 21, plan: 'free', name: 'A', email: 'a@x.com' });
  const res = await postForm(app, '/billing/payment-instructions', {
    payment_instructions: '  Venmo @ash\nZelle: ash@bank.com\nBank: ABA 021000021 / acct 9876543210  ',
    return_to: '/invoices/42'
  });
  assert.strictEqual(res.status, 302, 'happy-path must 302');
  assert.strictEqual(res.headers.location, '/invoices/42',
    'whitelisted return_to /invoices/<id> must round-trip on the redirect');
  assert.strictEqual(updateUserCalls.length, 1, 'db.updateUser must be called exactly once');
  assert.strictEqual(updateUserCalls[0].id, 21, 'updateUser must target the session user id');
  assert.deepStrictEqual(
    Object.keys(updateUserCalls[0].fields),
    ['payment_instructions'],
    'inline route must update ONLY payment_instructions — never touch other settings columns (it co-exists with the main settings POST, must not stomp business_name / reply_to_email etc.)'
  );
  assert.strictEqual(
    updateUserCalls[0].fields.payment_instructions,
    'Venmo @ash\nZelle: ash@bank.com\nBank: ABA 021000021 / acct 9876543210',
    'value must be trimmed at the edges and persisted verbatim with newlines preserved'
  );
}

async function testInlineRouteRejectsOpenRedirectReturnTo() {
  // Any return_to that doesn't match /invoices/<positive-int> falls back to
  // /billing/settings. Includes the obvious open-redirect vectors (absolute
  // URLs, protocol-relative, encoded path, /admin, /invoices/0, leading
  // zero, trailing slash, sub-path).
  const hostile = [
    'https://evil.example.com/x',
    '//evil.example.com/x',
    '/admin',
    '/invoices/0',
    '/invoices/01',
    '/invoices/42/edit',
    '/invoices/42?x=1',
    '/invoices/42#frag',
    'javascript:alert(1)',
    '/',
    '',
    '   ',
    '/invoices/abc',
    '/invoices/-1'
  ];
  for (const bad of hostile) {
    updateUserCalls.length = 0;
    userStore = {
      22: { id: 22, email: 'b@x.com', name: 'B', plan: 'free', payment_instructions: null }
    };
    const app = buildBillingApp({ id: 22, plan: 'free', name: 'B', email: 'b@x.com' });
    const res = await postForm(app, '/billing/payment-instructions', {
      payment_instructions: 'Venmo @b',
      return_to: bad
    });
    assert.strictEqual(res.status, 302, `hostile return_to ${JSON.stringify(bad)} must still 302`);
    assert.strictEqual(res.headers.location, '/billing/settings',
      `hostile return_to ${JSON.stringify(bad)} must fall back to /billing/settings`);
    // Persistence still succeeds — the bad return_to is a redirect issue,
    // not a data-integrity one.
    assert.strictEqual(updateUserCalls.length, 1,
      'a bad return_to does NOT block the save — the user still gets value');
    assert.strictEqual(updateUserCalls[0].fields.payment_instructions, 'Venmo @b');
  }
}

async function testInlineRouteRejectsEmptyInputs() {
  updateUserCalls.length = 0;
  userStore = {
    23: { id: 23, email: 'c@x.com', name: 'C', plan: 'free', payment_instructions: null }
  };
  const app = buildBillingApp({ id: 23, plan: 'free', name: 'C', email: 'c@x.com' });
  for (const empty of ['', '   ', '\n\n\t']) {
    const res = await postForm(app, '/billing/payment-instructions', {
      payment_instructions: empty,
      return_to: '/invoices/7'
    });
    assert.strictEqual(res.status, 302,
      `empty payment_instructions (${JSON.stringify(empty)}) must redirect with an error flash`);
    assert.strictEqual(res.headers.location, '/invoices/7',
      'redirect must still honour the whitelisted return_to so the user lands back on the prompt');
  }
  assert.strictEqual(updateUserCalls.length, 0,
    'empty payment_instructions must NOT trigger a db.updateUser — the existing value (NULL) stays');
}

async function testInlineRouteRejectsOverLengthInput() {
  updateUserCalls.length = 0;
  userStore = {
    24: { id: 24, email: 'd@x.com', name: 'D', plan: 'free', payment_instructions: null }
  };
  const app = buildBillingApp({ id: 24, plan: 'free', name: 'D', email: 'd@x.com' });
  const huge = 'v'.repeat(2001);
  const res = await postForm(app, '/billing/payment-instructions', {
    payment_instructions: huge,
    return_to: '/invoices/11'
  });
  assert.strictEqual(res.status, 302, 'over-length must redirect (with error flash)');
  assert.strictEqual(res.headers.location, '/invoices/11',
    'redirect must honour the whitelisted return_to so the user can re-enter a shorter value');
  assert.strictEqual(updateUserCalls.length, 0,
    'over-length must NOT trigger a db.updateUser (rejecting rather than truncating prevents silent loss of the bank-details tail)');
}

async function testInlineRouteAcceptsExactlyTwoThousandChars() {
  updateUserCalls.length = 0;
  userStore = {
    25: { id: 25, email: 'e@x.com', name: 'E', plan: 'free', payment_instructions: null }
  };
  const app = buildBillingApp({ id: 25, plan: 'free', name: 'E', email: 'e@x.com' });
  const exact = 'V'.repeat(2000);
  const res = await postForm(app, '/billing/payment-instructions', {
    payment_instructions: exact,
    return_to: '/invoices/3'
  });
  assert.strictEqual(res.status, 302, 'exactly 2000 chars (boundary) must succeed');
  assert.strictEqual(res.headers.location, '/invoices/3');
  assert.strictEqual(updateUserCalls.length, 1);
  assert.strictEqual(updateUserCalls[0].fields.payment_instructions.length, 2000,
    'boundary value persists at the 2000-char limit');
}

async function testInlineRouteRedirectsToLoginWhenUserMissing() {
  // updateUser returns null when the user row is gone (deleted between
  // session-establish and now). The route must surface that as a redirect
  // to /auth/login rather than silently swallowing it.
  updateUserCalls.length = 0;
  userStore = {}; // empty — no user
  const app = buildBillingApp({ id: 999, plan: 'free', name: 'X', email: 'gone@x.com' });
  const res = await postForm(app, '/billing/payment-instructions', {
    payment_instructions: 'Venmo @gone',
    return_to: '/invoices/1'
  });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.location, '/auth/login',
    'missing user must redirect to /auth/login (matches the /billing/settings POST contract)');
}

// ---------- views/invoice-view.ejs wiring -------------------------------

function makeInvoiceForView(overrides) {
  return Object.assign({
    id: 9,
    invoice_number: 'INV-2026-0009',
    status: 'draft',
    issued_date: new Date('2026-05-01'),
    due_date: new Date('2026-05-31'),
    client_name: 'Acme',
    client_email: 'acme@x.com',
    client_address: '',
    items: [{ description: 'Logo design', quantity: 1, unit_price: 250 }],
    subtotal: 250, tax_rate: 0, tax_amount: 0, total: 250,
    notes: null,
    payment_link_url: null
  }, overrides || {});
}

async function testViewRendersPromptForFreeNoInstructionsOnDraft() {
  const html = await ejs.renderFile(path.join(VIEWS, 'invoice-view.ejs'), {
    title: 'Invoice',
    user: { plan: 'free', email: 'f@x.com', name: 'F', business_name: null, payment_instructions: null },
    invoice: makeInvoiceForView({ status: 'draft' }),
    csrfToken: 'csrf-inline-1',
    flash: null
  }, { views: [VIEWS] });
  assert.ok(html.includes('data-testid="inline-payment-instructions-prompt"'),
    'free user with no payment_instructions on a draft invoice must see the inline prompt');
  assert.ok(/action="\/billing\/payment-instructions"/.test(html),
    'prompt form must POST to /billing/payment-instructions');
  assert.ok(html.includes('data-testid="inline-payment-instructions-input"'),
    'textarea must be present so the user can type');
  assert.ok(/name="payment_instructions"/.test(html),
    'textarea must POST under the same payment_instructions name the existing settings route already understands');
  assert.ok(html.includes('value="/invoices/9"'),
    'hidden return_to must carry the current invoice id so the success flash lands back on this same page');
  assert.ok(/X-CSRF-Token|name="_csrf"/.test(html),
    'CSRF token must be threaded so the POST clears the global csrfProtection middleware');
  assert.ok(/csrf-inline-1/.test(html),
    'the actual session csrfToken must be rendered (not a stale literal)');
}

async function testViewRendersPromptOnSentInvoice() {
  // Even on a sent/overdue invoice, if the freelancer hasn't set up payment
  // instructions yet, the client opening the share link still needs them.
  // Suppressing the prompt on sent invoices would lose the largest cohort
  // it's designed for — users who sent the share link, got no payment, and
  // now realise their client has no way to pay them.
  const html = await ejs.renderFile(path.join(VIEWS, 'invoice-view.ejs'), {
    title: 'Invoice',
    user: { plan: 'free', email: 'g@x.com', name: 'G', business_name: null, payment_instructions: null },
    invoice: makeInvoiceForView({ status: 'sent' }),
    csrfToken: 'csrf-inline-2',
    flash: null
  }, { views: [VIEWS] });
  assert.ok(html.includes('data-testid="inline-payment-instructions-prompt"'),
    'free user with no instructions on a SENT invoice still needs the prompt — the client opening the share link can\'t pay yet');
}

async function testViewSuppressesPromptOnPaidInvoice() {
  // Once an invoice is paid, the prompt is noise — the user can still set
  // instructions from /billing/settings if they want, but the share-moment
  // urgency is gone.
  const html = await ejs.renderFile(path.join(VIEWS, 'invoice-view.ejs'), {
    title: 'Invoice',
    user: { plan: 'free', email: 'h@x.com', name: 'H', business_name: null, payment_instructions: null },
    invoice: makeInvoiceForView({ status: 'paid' }),
    csrfToken: 'csrf-inline-3',
    flash: null
  }, { views: [VIEWS] });
  assert.ok(!html.includes('data-testid="inline-payment-instructions-prompt"'),
    'paid invoice must NOT show the inline payment-instructions prompt');
}

async function testViewSuppressesPromptWhenInstructionsAlreadySet() {
  const html = await ejs.renderFile(path.join(VIEWS, 'invoice-view.ejs'), {
    title: 'Invoice',
    user: { plan: 'free', email: 'i@x.com', name: 'I', business_name: null, payment_instructions: 'Venmo @i' },
    invoice: makeInvoiceForView({ status: 'draft' }),
    csrfToken: 'csrf-inline-4',
    flash: null
  }, { views: [VIEWS] });
  assert.ok(!html.includes('data-testid="inline-payment-instructions-prompt"'),
    'users with payment_instructions already set must NOT see the prompt — they\'ve already covered the milestone');
}

async function testViewSuppressesPromptForPro() {
  // Pro users have a Stripe Pay button on the public share page, so the
  // bank-fallback prompt is not the activation-critical surface it is for
  // free users.
  const html = await ejs.renderFile(path.join(VIEWS, 'invoice-view.ejs'), {
    title: 'Invoice',
    user: { plan: 'pro', email: 'j@x.com', name: 'J', business_name: null, payment_instructions: null },
    invoice: makeInvoiceForView({ status: 'draft', payment_link_url: 'https://buy.stripe.com/test' }),
    paymentMethods: ['card'],
    csrfToken: 'csrf-inline-5',
    flash: null
  }, { views: [VIEWS] });
  assert.ok(!html.includes('data-testid="inline-payment-instructions-prompt"'),
    'Pro user must NOT see the inline payment-instructions prompt — they have the Stripe Pay button');
}

async function testViewSuppressesPromptForAgency() {
  const html = await ejs.renderFile(path.join(VIEWS, 'invoice-view.ejs'), {
    title: 'Invoice',
    user: { plan: 'agency', email: 'k@x.com', name: 'K', business_name: null, payment_instructions: null },
    invoice: makeInvoiceForView({ status: 'draft' }),
    csrfToken: 'csrf-inline-6',
    flash: null
  }, { views: [VIEWS] });
  assert.ok(!html.includes('data-testid="inline-payment-instructions-prompt"'),
    'Agency user must NOT see the inline payment-instructions prompt (same logic as Pro)');
}

async function testViewSubmitButtonAndCopyPresent() {
  const html = await ejs.renderFile(path.join(VIEWS, 'invoice-view.ejs'), {
    title: 'Invoice',
    user: { plan: 'free', email: 'm@x.com', name: 'M', business_name: null, payment_instructions: null },
    invoice: makeInvoiceForView({ status: 'draft' }),
    csrfToken: 'csrf-inline-7',
    flash: null
  }, { views: [VIEWS] });
  assert.ok(html.includes('data-testid="inline-payment-instructions-submit"'),
    'submit button must be present with the expected testid');
  assert.ok(/Tell your client how to pay you/.test(html),
    'prompt headline must name the activation goal in plain English so the user knows what the field is for');
  assert.ok(/Venmo @yourhandle/.test(html),
    'textarea placeholder must offer concrete examples (Venmo) so the user has a starting point');
  assert.ok(/maxlength="2000"/.test(html),
    'textarea must surface the same 2000-char cap the server enforces, so the browser blocks oversized input client-side too');
}

// ---------- runner -------------------------------------------------------

async function run() {
  const tests = [
    ['POST /billing/payment-instructions: persists trimmed value, redirects to whitelisted return_to', testInlineRoutePersistsAndRedirectsToInvoice],
    ['POST /billing/payment-instructions: rejects open-redirect return_to (falls back to /billing/settings)', testInlineRouteRejectsOpenRedirectReturnTo],
    ['POST /billing/payment-instructions: empty / whitespace-only input rejected without DB write', testInlineRouteRejectsEmptyInputs],
    ['POST /billing/payment-instructions: > 2000-char input rejected without DB write', testInlineRouteRejectsOverLengthInput],
    ['POST /billing/payment-instructions: exactly 2000 chars accepted (boundary)', testInlineRouteAcceptsExactlyTwoThousandChars],
    ['POST /billing/payment-instructions: missing user row redirects to /auth/login', testInlineRouteRedirectsToLoginWhenUserMissing],
    ['invoice-view.ejs: prompt renders for free + no instructions + draft', testViewRendersPromptForFreeNoInstructionsOnDraft],
    ['invoice-view.ejs: prompt renders for free + no instructions + sent invoice', testViewRendersPromptOnSentInvoice],
    ['invoice-view.ejs: prompt suppressed on paid invoice', testViewSuppressesPromptOnPaidInvoice],
    ['invoice-view.ejs: prompt suppressed when payment_instructions already set', testViewSuppressesPromptWhenInstructionsAlreadySet],
    ['invoice-view.ejs: prompt suppressed for Pro user', testViewSuppressesPromptForPro],
    ['invoice-view.ejs: prompt suppressed for Agency user', testViewSuppressesPromptForAgency],
    ['invoice-view.ejs: submit button + headline + 2000-char maxlength wired', testViewSubmitButtonAndCopyPresent]
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
