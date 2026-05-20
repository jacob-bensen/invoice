'use strict';

/*
 * Server-side "Send by email" button on /invoices/:id
 * (Milestone 3 — first invoice created → first invoice sent).
 *
 * Until this ship, Pro/Agency users could only get an invoice delivered to
 * a client by clicking "Mark as Sent" (which fires sendInvoiceEmail as a
 * silent side-effect with no UI feedback) or by tapping the mailto: share
 * intent (which opens their local mail client, makes them type + send
 * manually, and never confirms delivery). The new POST
 * /invoices/:id/email-client collapses both paths: server sends the
 * invoice via Resend, atomically flips draft → sent, and the UI shows
 * "✓ Sent to acme@example.com" on success. One tap, real delivery.
 *
 * Covers:
 *   - Route happy path: Pro draft → 200, email sent, draft→sent flipped,
 *     response carries { ok, status='sent', flipped=true, sent_to }.
 *   - Route Agency parity: agency plan also accepted.
 *   - Route idempotent on already-sent invoices: still re-sends + flipped=false.
 *   - Route 402 plan_locked for free users (defence-in-depth even though
 *     the view hides the button).
 *   - Route 400 no_client_email when the invoice has no client_email.
 *   - Route 404 not_found for cross-tenant / unknown invoice id.
 *   - Route 503 not_configured when RESEND_API_KEY is unset.
 *   - Route 502 on a generic send failure.
 *   - Route Cache-Control: no-store.
 *   - Route returns 401 unauthorized when getUserById returns null
 *     (defence — auth middleware should have caught it first).
 *   - sendInvoiceEmail is called with the loaded invoice + owner.
 *   - markInvoiceSentFromShareIntent fires AFTER the email send (so a
 *     send failure never silently flips the status).
 *   - View: Pro user with client_email on draft renders both
 *     data-testid="draft-send-banner-direct-email" and
 *     data-testid="public-share-direct-email" buttons.
 *   - View: Agency parity for both buttons.
 *   - View: free user does NOT render the buttons (existing pro-lock
 *     pitch still owns the upsell surface).
 *   - View: Pro user without client_email does NOT render the buttons.
 *   - View: button is wired to POST /invoices/<id>/email-client with CSRF.
 *   - View: button disables while sending + shows the success label on
 *     emailSent.
 *
 * Run: NODE_ENV=test node tests/email-client-send.test.js
 */

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

const assert = require('assert');
const path = require('path');
const ejs = require('ejs');
const express = require('express');
const session = require('express-session');
const http = require('http');

const VIEWS = path.join(__dirname, '..', 'views');

function clearReq(p) {
  try { delete require.cache[require.resolve(p)]; } catch (_) { /* noop */ }
}

// ---------- Route layer plumbing ----------------------------------------

let sendInvoiceEmailImpl = async () => ({ ok: true, id: 'em_x' });
let sendInvoiceEmailCalls = [];

function setSendImpl(fn) { sendInvoiceEmailImpl = fn; sendInvoiceEmailCalls = []; }

function buildInvoiceApp({ user, invoiceRow, markResult }) {
  const calls = { mark: [], userById: [] };
  const dbStub = {
    pool: { query: async () => ({ rows: [] }) },
    db: {
      async getUserById(id) {
        calls.userById.push(id);
        if (!user) return null;
        if (Number(user.id) !== Number(id)) return null;
        return user;
      },
      async getInvoiceById(id, uid) {
        if (!invoiceRow) return null;
        if (Number(invoiceRow.user_id) !== Number(uid)) return null;
        if (Number(invoiceRow.id) !== Number(id)) return null;
        return invoiceRow;
      },
      async markInvoiceSentFromShareIntent(id, uid) {
        calls.mark.push({ id, uid });
        return markResult;
      },
      async getInvoicesByUser() { return []; },
      async getRecentRevenueStats() { return null; },
      async getNextInvoiceNumber() { return 'INV-2026-0001'; },
      async getOrCreatePublicToken() { return 'tokentokentoken'; }
    }
  };
  require.cache[require.resolve('../db')] = {
    id: require.resolve('../db'), filename: require.resolve('../db'),
    loaded: true, exports: dbStub
  };

  const realEmailLib = (() => { clearReq('../lib/email'); return require('../lib/email'); })();
  const emailStub = {
    ...realEmailLib,
    sendInvoiceEmail: async (invoice, owner) => {
      sendInvoiceEmailCalls.push({ invoice, owner });
      return sendInvoiceEmailImpl(invoice, owner);
    }
  };
  require.cache[require.resolve('../lib/email')] = {
    id: require.resolve('../lib/email'), filename: require.resolve('../lib/email'),
    loaded: true, exports: emailStub
  };

  require.cache[require.resolve('../lib/outbound-webhook')] = {
    id: require.resolve('../lib/outbound-webhook'),
    filename: require.resolve('../lib/outbound-webhook'),
    loaded: true,
    exports: {
      isValidWebhookUrl: async () => true,
      buildPaidPayload: () => ({}),
      firePaidWebhook: async () => ({ ok: true }),
      setHostnameResolver: () => {}
    }
  };

  clearReq('../routes/invoices');
  const invoiceRoutes = require('../routes/invoices');
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', VIEWS);
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, res, next) => {
    req.session.user = { id: 7, plan: user ? user.plan : 'free' };
    next();
  });
  app.use('/invoices', invoiceRoutes);
  return { app, calls };
}

function postEmailClient(app, id) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const req = http.request({
        hostname: '127.0.0.1', port, path: `/invoices/${id}/email-client`,
        method: 'POST',
        headers: { 'Accept': 'application/json' }
      }, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => server.close(() => resolve({
          status: res.statusCode, body: data, headers: res.headers
        })));
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.end();
    });
  });
}

// ---------- Route tests --------------------------------------------------

async function testProDraftHappyPath() {
  setSendImpl(async () => ({ ok: true, id: 'em_happy' }));
  const { app, calls } = buildInvoiceApp({
    user: { id: 7, plan: 'pro', email: 'me@x.com', name: 'Me' },
    invoiceRow: {
      id: 5, user_id: 7, status: 'draft',
      invoice_number: 'INV-1', client_email: 'acme@x.example',
      client_name: 'Acme', total: '100.00', items: [], due_date: null
    },
    markResult: { id: 5, status: 'sent', sent_via_share_intent_at: new Date() }
  });
  const r = await postEmailClient(app, 5);
  assert.strictEqual(r.status, 200, 'pro happy path returns 200; got ' + r.status + ' body=' + r.body);
  const body = JSON.parse(r.body);
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.status, 'sent');
  assert.strictEqual(body.flipped, true, 'draft→sent flipped=true');
  assert.strictEqual(body.sent_to, 'acme@x.example', 'response echoes the client email actually delivered to');
  assert.strictEqual(body.message_id, 'em_happy', 'response carries the Resend message id for ops tracing');
  assert.strictEqual(sendInvoiceEmailCalls.length, 1, 'sendInvoiceEmail fires exactly once');
  assert.strictEqual(sendInvoiceEmailCalls[0].invoice.id, 5);
  assert.strictEqual(sendInvoiceEmailCalls[0].invoice.client_email, 'acme@x.example');
  assert.strictEqual(sendInvoiceEmailCalls[0].owner.id, 7);
  assert.deepStrictEqual(calls.mark, [{ id: 5, uid: 7 }],
    'markInvoiceSentFromShareIntent fires exactly once with the invoice id + session user id');
  assert.ok(/no-store/i.test(r.headers['cache-control'] || ''),
    'response must carry Cache-Control: no-store; got ' + r.headers['cache-control']);
}

async function testAgencyDraftHappyPath() {
  setSendImpl(async () => ({ ok: true, id: 'em_agency' }));
  const { app, calls } = buildInvoiceApp({
    user: { id: 7, plan: 'agency', email: 'me@x.com', name: 'Agency' },
    invoiceRow: {
      id: 5, user_id: 7, status: 'draft',
      invoice_number: 'INV-1', client_email: 'biz@x.example',
      client_name: 'BigCo', total: '500.00', items: []
    },
    markResult: { id: 5, status: 'sent', sent_via_share_intent_at: new Date() }
  });
  const r = await postEmailClient(app, 5);
  assert.strictEqual(r.status, 200, 'agency plan accepted (parity with pro)');
  const body = JSON.parse(r.body);
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.flipped, true);
  assert.strictEqual(sendInvoiceEmailCalls.length, 1);
  assert.strictEqual(calls.mark.length, 1, 'agency also triggers the status flip');
}

async function testIdempotentOnAlreadySent() {
  setSendImpl(async () => ({ ok: true, id: 'em_replay' }));
  const { app, calls } = buildInvoiceApp({
    user: { id: 7, plan: 'pro', email: 'me@x.com' },
    invoiceRow: {
      id: 5, user_id: 7, status: 'sent',
      invoice_number: 'INV-1', client_email: 'acme@x.example',
      client_name: 'Acme', total: '100.00', items: []
    },
    markResult: { id: 5, status: 'sent', sent_via_share_intent_at: null }
  });
  const r = await postEmailClient(app, 5);
  assert.strictEqual(r.status, 200, 'already-sent invoice still returns 200');
  const body = JSON.parse(r.body);
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.status, 'sent');
  assert.strictEqual(body.flipped, false,
    'flipped=false on already-sent — caller can show "Sent again" copy if they want');
  assert.strictEqual(sendInvoiceEmailCalls.length, 1,
    'sendInvoiceEmail STILL fires on already-sent — freelancer may be re-sending after a client miss');
}

async function testFreePlanLocked() {
  setSendImpl(async () => { throw new Error('should not be called for free'); });
  const { app, calls } = buildInvoiceApp({
    user: { id: 7, plan: 'free', email: 'me@x.com' },
    invoiceRow: {
      id: 5, user_id: 7, status: 'draft',
      invoice_number: 'INV-1', client_email: 'acme@x.example',
      client_name: 'Acme', total: '100.00', items: []
    },
    markResult: { id: 5, status: 'sent', sent_via_share_intent_at: new Date() }
  });
  const r = await postEmailClient(app, 5);
  assert.strictEqual(r.status, 402, 'free plan returns 402 Payment Required');
  const body = JSON.parse(r.body);
  assert.strictEqual(body.error, 'plan_locked');
  assert.strictEqual(sendInvoiceEmailCalls.length, 0,
    'sendInvoiceEmail must NOT fire for a plan-locked request — wastes Resend send quota');
  assert.strictEqual(calls.mark.length, 0,
    'status flip must NOT fire for a plan-locked request');
}

async function testNoClientEmail() {
  setSendImpl(async () => { throw new Error('should not be called'); });
  const { app, calls } = buildInvoiceApp({
    user: { id: 7, plan: 'pro', email: 'me@x.com' },
    invoiceRow: {
      id: 5, user_id: 7, status: 'draft',
      invoice_number: 'INV-1', client_email: null,
      client_name: 'Acme', total: '100.00', items: []
    },
    markResult: { id: 5, status: 'sent', sent_via_share_intent_at: new Date() }
  });
  const r = await postEmailClient(app, 5);
  assert.strictEqual(r.status, 400, 'no client_email returns 400 so UI can prompt to add one');
  const body = JSON.parse(r.body);
  assert.strictEqual(body.error, 'no_client_email');
  assert.strictEqual(sendInvoiceEmailCalls.length, 0, 'no send attempt without a recipient');
  assert.strictEqual(calls.mark.length, 0, 'no status flip without a send');
}

async function testCrossTenantNotFound() {
  setSendImpl(async () => { throw new Error('should not be called'); });
  const { app, calls } = buildInvoiceApp({
    user: { id: 7, plan: 'pro', email: 'me@x.com' },
    invoiceRow: {
      id: 5, user_id: 999, // belongs to a different user
      status: 'draft',
      invoice_number: 'INV-1', client_email: 'acme@x.example',
      client_name: 'Acme', total: '100.00', items: []
    },
    markResult: null
  });
  const r = await postEmailClient(app, 5);
  assert.strictEqual(r.status, 404, 'cross-tenant invoice returns 404');
  const body = JSON.parse(r.body);
  assert.strictEqual(body.error, 'not_found');
  assert.strictEqual(sendInvoiceEmailCalls.length, 0);
  assert.strictEqual(calls.mark.length, 0,
    'cross-tenant request must NOT touch the status flip');
}

async function testUnknownInvoiceNotFound() {
  const { app, calls } = buildInvoiceApp({
    user: { id: 7, plan: 'pro', email: 'me@x.com' },
    invoiceRow: null,
    markResult: null
  });
  const r = await postEmailClient(app, 999);
  assert.strictEqual(r.status, 404);
  const body = JSON.parse(r.body);
  assert.strictEqual(body.error, 'not_found');
  assert.strictEqual(sendInvoiceEmailCalls.length, 0);
  assert.strictEqual(calls.mark.length, 0);
}

async function testResendNotConfigured() {
  setSendImpl(async () => ({ ok: false, reason: 'not_configured' }));
  const { app, calls } = buildInvoiceApp({
    user: { id: 7, plan: 'pro', email: 'me@x.com' },
    invoiceRow: {
      id: 5, user_id: 7, status: 'draft',
      invoice_number: 'INV-1', client_email: 'acme@x.example',
      client_name: 'Acme', total: '100.00', items: []
    },
    markResult: { id: 5, status: 'sent', sent_via_share_intent_at: new Date() }
  });
  const r = await postEmailClient(app, 5);
  assert.strictEqual(r.status, 503,
    'not_configured returns 503 Service Unavailable so the UI can tell the user the feature is not ready yet');
  const body = JSON.parse(r.body);
  assert.strictEqual(body.error, 'not_configured');
  assert.strictEqual(calls.mark.length, 0,
    'status flip must NOT fire when the email never went out — would lie about state');
}

async function testGenericSendFailure() {
  setSendImpl(async () => ({ ok: false, reason: 'error', error: 'resend boom' }));
  const { app, calls } = buildInvoiceApp({
    user: { id: 7, plan: 'pro', email: 'me@x.com' },
    invoiceRow: {
      id: 5, user_id: 7, status: 'draft',
      invoice_number: 'INV-1', client_email: 'acme@x.example',
      client_name: 'Acme', total: '100.00', items: []
    },
    markResult: { id: 5, status: 'sent', sent_via_share_intent_at: new Date() }
  });
  const r = await postEmailClient(app, 5);
  assert.strictEqual(r.status, 502, 'generic send failure returns 502 Bad Gateway');
  const body = JSON.parse(r.body);
  assert.strictEqual(body.error, 'error',
    'reason from sendInvoiceEmail is echoed back to the client for diagnosis');
  assert.strictEqual(calls.mark.length, 0,
    'status flip must NOT fire when the email failed — would lie about state');
}

async function testUserMissingUnauthorized() {
  setSendImpl(async () => { throw new Error('should not be called'); });
  const { app, calls } = buildInvoiceApp({
    user: null, // getUserById returns null — defence-in-depth case
    invoiceRow: {
      id: 5, user_id: 7, status: 'draft',
      client_email: 'a@x.com', items: []
    },
    markResult: null
  });
  const r = await postEmailClient(app, 5);
  assert.strictEqual(r.status, 401, 'missing user returns 401 Unauthorized');
  const body = JSON.parse(r.body);
  assert.strictEqual(body.error, 'unauthorized');
  assert.strictEqual(sendInvoiceEmailCalls.length, 0);
  assert.strictEqual(calls.mark.length, 0);
}

// ---------- View tests --------------------------------------------------

async function renderInvoiceView({ userPlan, status, client_email, prefetchedShare }) {
  return ejs.renderFile(path.join(VIEWS, 'invoice-view.ejs'), {
    title: 'Invoice',
    user: { plan: userPlan, email: 'me@example.com', name: 'Me', business_name: null },
    invoice: {
      id: 5,
      invoice_number: 'INV-2026-0001',
      status: status || 'draft',
      issued_date: new Date('2026-05-01'),
      due_date: new Date('2026-05-31'),
      client_name: 'Acme',
      client_email: client_email === undefined ? 'acme@x.example' : client_email,
      client_address: '',
      items: [{ description: 'Work', quantity: 1, unit_price: 100 }],
      subtotal: 100, tax_rate: 0, tax_amount: 0, total: 100,
      notes: null,
      payment_link_url: null,
      is_seed: false
    },
    paymentMethods: ['card'],
    csrfToken: 'test-csrf-token',
    flash: null,
    prefetchedShare: prefetchedShare || {
      url: 'https://app.example/i/abc123',
      shareIntents: {
        whatsapp: 'https://wa.me/?text=...',
        sms: 'sms:?&body=...',
        mailto: 'mailto:a@x?subject=...',
        subject: 'Invoice INV-2026-0001',
        body: 'Hi'
      },
      followUpIntents: null
    }
  }, { views: [VIEWS] });
}

async function testViewProDraftBannerButton() {
  const html = await renderInvoiceView({ userPlan: 'pro', status: 'draft' });
  assert.ok(/data-testid="draft-send-banner-direct-email"/.test(html),
    'pro user on a draft must see the draft-send-banner direct-email button');
  // The banner div carries the x-data with the email-client POST handler.
  const bannerIdx = html.indexOf('data-testid="draft-send-banner"');
  const buttonIdx = html.indexOf('data-testid="draft-send-banner-direct-email"');
  assert.ok(bannerIdx >= 0 && buttonIdx > bannerIdx, 'banner contains the button');
  const banner = html.slice(bannerIdx, buttonIdx + 800);
  assert.ok(/\/invoices\/5\/email-client/.test(banner),
    'banner must wire to POST /invoices/<id>/email-client');
  assert.ok(/X-CSRF-Token[\s\S]{0,80}test-csrf-token/.test(banner),
    'POST must carry the CSRF token header');
  // Recipient email is shown on the button label so the user knows where it goes.
  assert.ok(/acme@x\.example/.test(banner),
    'button label must surface the actual client email so the user knows the recipient');
  // The button's @click invokes the emailSendTo handler.
  const buttonChunk = html.slice(buttonIdx, buttonIdx + 1200);
  assert.ok(/@click="emailSendTo\(/.test(buttonChunk),
    'button @click must invoke the emailSendTo handler defined on the banner x-data');
}

async function testViewProDraftPublicShareButton() {
  const html = await renderInvoiceView({ userPlan: 'pro', status: 'draft' });
  assert.ok(/data-testid="public-share-direct-email"/.test(html),
    'pro user on a draft must see the public-share-section direct-email button');
  const idx = html.indexOf('data-testid="public-share-direct-email"');
  const window = html.slice(Math.max(0, idx - 800), idx + 800);
  assert.ok(/emailSendDirect\(\)/.test(window),
    'button must call the emailSendDirect() handler');
  assert.ok(/acme@x\.example/.test(window),
    'public-share-section button label must include the client email');
}

async function testViewAgencyParity() {
  const html = await renderInvoiceView({ userPlan: 'agency', status: 'draft' });
  assert.ok(/data-testid="draft-send-banner-direct-email"/.test(html),
    'agency parity: button must render in the draft-send-banner');
  assert.ok(/data-testid="public-share-direct-email"/.test(html),
    'agency parity: button must render in the public-share-section');
}

async function testViewFreeNoButton() {
  const html = await renderInvoiceView({ userPlan: 'free', status: 'draft' });
  assert.ok(!/data-testid="draft-send-banner-direct-email"/.test(html),
    'free user must NOT see the direct-email button — the existing pro-lock owns the upsell surface');
  assert.ok(!/data-testid="public-share-direct-email"/.test(html),
    'free user must NOT see the direct-email button in the public-share-section either');
}

async function testViewNoClientEmailNoButton() {
  const html = await renderInvoiceView({
    userPlan: 'pro', status: 'draft', client_email: null
  });
  assert.ok(!/data-testid="draft-send-banner-direct-email"/.test(html),
    'pro user without client_email must NOT see the button — no recipient to send to');
  assert.ok(!/data-testid="public-share-direct-email"/.test(html),
    'pro user without client_email must NOT see the public-share button either');
}

async function testViewButtonShowsSendingAndSentStates() {
  const html = await renderInvoiceView({ userPlan: 'pro', status: 'draft' });
  const idx = html.indexOf('data-testid="draft-send-banner-direct-email"');
  const window = html.slice(Math.max(0, idx - 200), idx + 1200);
  assert.ok(/Sending…|Sending&hellip;|Sending\.\.\./.test(window),
    'button must show a "Sending…" state while the request is in flight');
  assert.ok(/Sent to acme@x\.example/.test(window),
    'button must show "Sent to <client_email>" on success');
  // The button disables itself while in flight (defence against double-clicks)
  assert.ok(/emailSending\s*\|\|\s*emailSent/.test(window),
    'button must disable while sending OR after sent so a double-tap does not double-send');
}

async function testViewButtonReloadsOnSuccess() {
  const html = await renderInvoiceView({ userPlan: 'pro', status: 'draft' });
  // After a successful send, the page reloads so the status badge updates
  // from "Draft" to "Sent" and the draft-send-banner disappears.
  assert.ok(/window\.location\.reload/.test(html),
    'on success, the handler must reload the page so the status badge and banner reflect sent state');
}

async function testViewSentInvoiceNoBannerButton() {
  // The draft-send-banner is gated on status='draft' — for a sent invoice
  // the banner does not render at all, so neither does the banner button.
  // The public-share-section button STILL renders (a freelancer can re-send
  // the invoice from there if the client didn't receive it).
  const html = await renderInvoiceView({ userPlan: 'pro', status: 'sent' });
  assert.ok(!/data-testid="draft-send-banner-direct-email"/.test(html),
    'sent invoice: the draft-send-banner does not render so neither does its email button');
  assert.ok(/data-testid="public-share-direct-email"/.test(html),
    'sent invoice: public-share-section button still renders so the freelancer can re-send if needed');
}

async function testViewErrorMessageDisplayed() {
  const html = await renderInvoiceView({ userPlan: 'pro', status: 'draft' });
  assert.ok(/data-testid="draft-send-banner-direct-email-error"/.test(html),
    'error feedback element must be present in the banner so failures surface to the user');
  assert.ok(/data-testid="public-share-direct-email-error"/.test(html),
    'error feedback element must be present in the public-share-section too');
  // Specific error reasons get human-readable copy.
  assert.ok(/Add a client email/.test(html),
    'no_client_email reason maps to "Add a client email on this invoice first."');
  assert.ok(/Email delivery is not configured/.test(html),
    'not_configured reason maps to a copy explaining the operator has not set up Resend');
}

// ---------- runner -------------------------------------------------------

async function run() {
  const tests = [
    ['route: pro draft happy path → email sent + draft→sent flipped', testProDraftHappyPath],
    ['route: agency plan parity', testAgencyDraftHappyPath],
    ['route: idempotent on already-sent (still re-sends, flipped=false)', testIdempotentOnAlreadySent],
    ['route: free plan returns 402 plan_locked, no send, no flip', testFreePlanLocked],
    ['route: 400 no_client_email when invoice has no recipient', testNoClientEmail],
    ['route: 404 not_found on cross-tenant invoice id', testCrossTenantNotFound],
    ['route: 404 not_found on unknown invoice id', testUnknownInvoiceNotFound],
    ['route: 503 not_configured when Resend is unset', testResendNotConfigured],
    ['route: 502 on a generic Resend failure', testGenericSendFailure],
    ['route: 401 unauthorized when getUserById returns null', testUserMissingUnauthorized],
    ['view: pro draft renders draft-send-banner email button', testViewProDraftBannerButton],
    ['view: pro draft renders public-share-section email button', testViewProDraftPublicShareButton],
    ['view: agency plan parity in both surfaces', testViewAgencyParity],
    ['view: free plan does NOT render either button', testViewFreeNoButton],
    ['view: pro without client_email does NOT render either button', testViewNoClientEmailNoButton],
    ['view: button shows sending + sent state copy + disables while in flight', testViewButtonShowsSendingAndSentStates],
    ['view: button reloads the page on successful send', testViewButtonReloadsOnSuccess],
    ['view: sent invoice — banner button gone, public-share button stays', testViewSentInvoiceNoBannerButton],
    ['view: error message surfaces specific reason copy', testViewErrorMessageDisplayed]
  ];
  let passed = 0;
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log('  ok  ' + name);
      passed++;
    } catch (e) {
      console.error('  FAIL  ' + name);
      console.error('    ' + (e && e.stack ? e.stack : e));
      failed++;
    }
  }
  console.log('');
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch(e => { console.error(e); process.exit(1); });
