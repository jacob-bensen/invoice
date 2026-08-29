'use strict';

/*
 * "Preview the share page" — GET /invoices/:id/preview-public
 * (Milestone 3 — first invoice created → first invoice sent).
 *
 * Renders the same invoice-public view a client would see at /i/<token>, but
 * authenticated as the owner and with two consequential side effects
 * deliberately suppressed:
 *
 *   1. NO recordPublicInvoiceView — on a draft that helper atomically flips
 *      status draft → sent, stamps sent_via_share_view_at, and downstream
 *      fires the first-sent celebration + client-viewed email. Hitting
 *      Preview must not irreversibly send the invoice.
 *   2. NO view_count / first_viewed_at bump — the dashboard "👀 Viewed"
 *      badge keys off view_count; previewing must not lie that the client
 *      opened the link.
 *
 * The rendered payment-claim form is hard-disabled in the template when
 * `preview` is truthy so the owner cannot accidentally POST a self-claim.
 *
 * Covers:
 *   - Route: owner happy path (draft) → 200 + preview banner + invoice
 *     number + client name + total, and recordPublicInvoiceView is NEVER
 *     called (the auto-flip contract must not fire from preview).
 *   - Route: owner-hydrated owner_* fields — business_name and
 *     payment_instructions surface even though getInvoiceById does not
 *     project them (proves the hydration step ran on freshly-loaded owner).
 *   - Route: cross-tenant invoice id → 302 → /dashboard (never leaks
 *     someone else's invoice).
 *   - Route: unknown invoice id → 302 → /dashboard.
 *   - Route: Cache-Control: no-store so a shared / proxied preview can't
 *     leak the invoice content past the owner session.
 *   - View: payment-claim submit is disabled in preview mode (owner cannot
 *     accidentally self-claim payment on their own invoice).
 *   - View: preview banner absent on the real /i/<token> render (no
 *     `preview` local).
 *   - View: link in the draft-send-banner points at /preview-public with
 *     target="_blank" so opening the preview doesn't lose the draft view.
 *
 * Run: NODE_ENV=test node tests/preview-public-page.test.js
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

function buildInvoiceApp({ user, invoiceRow }) {
  const calls = { userById: [], invoiceById: [], recordView: [] };
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
        calls.invoiceById.push({ id, uid });
        if (!invoiceRow) return null;
        if (Number(invoiceRow.user_id) !== Number(uid)) return null;
        if (Number(invoiceRow.id) !== Number(id)) return null;
        return invoiceRow;
      },
      async recordPublicInvoiceView(id) {
        // Preview must NEVER call this. Log the call so a test that
        // asserts calls.recordView.length === 0 catches a regression.
        calls.recordView.push(id);
        return { id, view_count: 1, status: 'sent' };
      },
      async getInvoicesByUser() { return []; },
      async getRecentRevenueStats() { return null; },
      async getNextInvoiceNumber() { return 'INV-2026-0001'; }
    }
  };
  require.cache[require.resolve('../db')] = {
    id: require.resolve('../db'), filename: require.resolve('../db'),
    loaded: true, exports: dbStub
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

  clearReq('../lib/email');
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

function getPreview(app, id) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const req = http.request({
        hostname: '127.0.0.1', port, path: `/invoices/${id}/preview-public`,
        method: 'GET'
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

async function testOwnerHappyPathDraftDoesNotStampView() {
  const { app, calls } = buildInvoiceApp({
    user: {
      id: 7, plan: 'free', email: 'me@example.com', name: 'Sam Freelance',
      business_name: 'Sam Co', reply_to_email: 'me@samco.test',
      payment_instructions: 'Venmo @sam-co',
      venmo_handle: null, cashapp_handle: null, paypal_me_handle: null,
      zelle_handle: null, default_currency: 'USD'
    },
    invoiceRow: {
      id: 5, user_id: 7, status: 'draft',
      invoice_number: 'INV-2026-0042',
      client_name: 'Acme Corp', client_email: 'acme@x.example',
      client_address: '', client_phone: null,
      total: '250.00', subtotal: 250, tax_rate: 0, tax_amount: 0,
      items: [{ description: 'Logo design', quantity: 1, unit_price: 250 }],
      due_date: new Date('2026-06-30'),
      issued_date: new Date('2026-05-21'),
      public_token: 'deadbeefdeadbeef',
      view_count: 0, first_viewed_at: null,
      payment_claimed_at: null, payment_claim_method: null, payment_claim_reference: null,
      notes: null, payment_link_url: null, is_seed: false
    }
  });
  const r = await getPreview(app, 5);
  assert.strictEqual(r.status, 200, 'owner gets 200; got ' + r.status);
  assert.ok(/data-testid="public-preview-banner"/.test(r.body),
    'preview banner present so the owner cannot mistake preview for the real share view');
  assert.ok(/Preview mode/i.test(r.body),
    'preview banner copy makes the state unambiguous');
  assert.ok(/INV-2026-0042/.test(r.body),
    'invoice number surfaced in the rendered public view');
  assert.ok(/Acme Corp/.test(r.body),
    'client name rendered so the freelancer can see how it appears to the client');
  assert.ok(/250\.00/.test(r.body),
    'total amount rendered in the invoice card');
  // Draft in the /i/<token> flow would flip to sent via recordPublicInvoiceView.
  // The preview route must never call it — otherwise a "peek" would send the
  // invoice irreversibly and count as a client view.
  assert.strictEqual(calls.recordView.length, 0,
    'recordPublicInvoiceView MUST NOT fire from preview — draft would auto-flip to sent otherwise');
  assert.ok(/no-store/i.test(r.headers['cache-control'] || ''),
    'Cache-Control: no-store on the preview response; got ' + r.headers['cache-control']);
  assert.strictEqual(calls.invoiceById.length, 1, 'invoice loaded exactly once');
  assert.deepStrictEqual(calls.invoiceById[0], { id: '5', uid: 7 },
    'getInvoiceById called with the route id + session user id');
}

async function testOwnerHydrationSurfacesBusinessAndPaymentInstructions() {
  // getInvoiceById does NOT project owner_* fields (that's
  // getInvoiceByPublicToken's shape). The preview route hydrates them
  // from the freshly-loaded owner row so the rendered view carries
  // business_name + payment_instructions the client would actually see.
  const { app } = buildInvoiceApp({
    user: {
      id: 7, plan: 'free', email: 'me@example.com', name: 'Sam Freelance',
      business_name: 'Sam & Co Studio',
      payment_instructions: 'Bank: Chase 021000021 acct 1234567890',
      reply_to_email: null,
      venmo_handle: null, cashapp_handle: null, paypal_me_handle: null,
      zelle_handle: null, default_currency: 'USD'
    },
    invoiceRow: {
      id: 5, user_id: 7, status: 'sent',
      invoice_number: 'INV-2026-0099',
      client_name: 'Widget Inc', client_email: 'w@x.example',
      client_address: '', client_phone: null,
      total: '500.00', subtotal: 500, tax_rate: 0, tax_amount: 0,
      items: [{ description: 'Retainer', quantity: 1, unit_price: 500 }],
      due_date: new Date('2026-07-15'),
      issued_date: new Date('2026-05-21'),
      public_token: 'deadbeefdeadbeef',
      view_count: 0, first_viewed_at: null,
      payment_claimed_at: null, payment_claim_method: null,
      notes: null, payment_link_url: null, is_seed: false
    }
  });
  const r = await getPreview(app, 5);
  assert.strictEqual(r.status, 200);
  assert.ok(/Sam &amp; Co Studio/.test(r.body),
    'owner business_name rendered — proves hydration ran (getInvoiceById does not project owner_*)');
  assert.ok(/Bank: Chase 021000021/.test(r.body),
    'owner payment_instructions rendered — same hydration path');
}

async function testCrossTenantRedirects() {
  const { app } = buildInvoiceApp({
    user: { id: 7, plan: 'pro', email: 'me@x.com', name: 'Me' },
    invoiceRow: {
      id: 5, user_id: 999, // belongs to a different user
      status: 'draft',
      invoice_number: 'INV-CROSSTENANT', client_name: 'Not Mine',
      client_email: 'a@x.com', total: '100.00', items: [],
      subtotal: 100, tax_rate: 0, tax_amount: 0
    }
  });
  const r = await getPreview(app, 5);
  assert.strictEqual(r.status, 302,
    'cross-tenant invoice redirects (302) — never leaks another user\'s invoice content');
  assert.strictEqual(r.headers.location, '/dashboard',
    'redirect target is /dashboard, matching the sibling /preview-email pattern');
  assert.ok(!/INV-CROSSTENANT/.test(r.body),
    'redirect body must not contain the cross-tenant invoice number');
}

async function testUnknownInvoiceRedirects() {
  const { app } = buildInvoiceApp({
    user: { id: 7, plan: 'pro', email: 'me@x.com' },
    invoiceRow: null
  });
  const r = await getPreview(app, 999);
  assert.strictEqual(r.status, 302, 'unknown invoice id redirects');
  assert.strictEqual(r.headers.location, '/dashboard');
}

// ---------- View tests ---------------------------------------------------

async function testPaymentClaimFormDisabledInPreview() {
  // A sent invoice in preview mode must render the payment-claim form
  // hard-disabled (owner cannot accidentally POST a self-claim on their
  // own invoice).
  const html = await ejs.renderFile(path.join(VIEWS, 'invoice-public.ejs'), {
    invoice: {
      id: 5, invoice_number: 'INV-1', client_name: 'Acme',
      status: 'sent', issued_date: new Date('2026-05-01'),
      due_date: new Date('2026-05-31'),
      subtotal: 100, tax_rate: 0, tax_amount: 0, total: 100,
      items: [{ description: 'Work', quantity: 1, unit_price: 100 }],
      notes: null, payment_link_url: null, public_token: 'deadbeefdeadbeef',
      owner_business_name: 'Sam Co', owner_name: 'Sam',
      owner_email: null, owner_business_email: null,
      owner_business_phone: null, owner_business_address: null,
      owner_payment_instructions: null, owner_plan: 'free',
      view_count: 0, first_viewed_at: null,
      payment_claimed_at: null, payment_claim_method: null
    },
    preview: true,
    paymentClaimMethods: ['cash','check','venmo','zelle','bank_transfer','paypal','other'],
    paymentClaimReferenceMax: 200,
    paymentClaimNoteMax: 1000,
    justClaimed: false,
    tapToPayLinks: { venmo: null, cashapp: null, paypal: null, zelle: null },
    invoiceCurrency: 'USD',
    ogTitle: 'x', ogDescription: 'x', ogPath: '/x',
    title: 'Preview', noindex: true
  }, { views: [VIEWS] });

  assert.ok(/data-testid="public-preview-banner"/.test(html),
    'preview banner present when preview flag set');
  const submitRe = /<button[^>]*data-testid="public-payment-claim-submit"[^>]*>/;
  const m = html.match(submitRe);
  assert.ok(m, 'payment-claim submit button located');
  assert.ok(/\bdisabled\b/.test(m[0]),
    'payment-claim submit must carry the disabled attribute in preview mode; got: ' + m[0]);
  assert.ok(/aria-disabled="true"/.test(m[0]),
    'aria-disabled="true" on the preview-mode submit for accessibility');
  // The <details> wrapper should also carry data-preview-disabled=true so
  // future JS can react to the state without re-parsing button attrs.
  const detailsRe = /<details[^>]*data-testid="public-payment-claim"[^>]*>/;
  const dm = html.match(detailsRe);
  assert.ok(dm, 'payment-claim <details> located');
  assert.ok(/data-preview-disabled="true"/.test(dm[0]),
    '<details> carries data-preview-disabled="true" in preview mode');
}

async function testRealPublicPageOmitsPreviewBanner() {
  // The un-flagged /i/<token> render must NOT show the preview banner.
  const html = await ejs.renderFile(path.join(VIEWS, 'invoice-public.ejs'), {
    invoice: {
      id: 5, invoice_number: 'INV-1', client_name: 'Acme',
      status: 'sent', issued_date: new Date('2026-05-01'),
      due_date: new Date('2026-05-31'),
      subtotal: 100, tax_rate: 0, tax_amount: 0, total: 100,
      items: [{ description: 'Work', quantity: 1, unit_price: 100 }],
      notes: null, payment_link_url: null, public_token: 'deadbeefdeadbeef',
      owner_business_name: 'Sam Co', owner_name: 'Sam',
      owner_email: null, owner_business_email: null,
      owner_business_phone: null, owner_business_address: null,
      owner_payment_instructions: null, owner_plan: 'free',
      view_count: 0, first_viewed_at: null,
      payment_claimed_at: null, payment_claim_method: null
    },
    // preview flag OMITTED — mimics routes/share.js render locals
    paymentClaimMethods: ['cash','check','venmo','zelle','bank_transfer','paypal','other'],
    paymentClaimReferenceMax: 200,
    paymentClaimNoteMax: 1000,
    justClaimed: false,
    tapToPayLinks: { venmo: null, cashapp: null, paypal: null, zelle: null },
    invoiceCurrency: 'USD',
    ogTitle: 'x', ogDescription: 'x', ogPath: '/x',
    title: 'Invoice', noindex: true
  }, { views: [VIEWS] });

  assert.ok(!/data-testid="public-preview-banner"/.test(html),
    'preview banner MUST NOT render on the real /i/<token> view (no `preview` local)');
  const submitRe = /<button[^>]*data-testid="public-payment-claim-submit"[^>]*>/;
  const m = html.match(submitRe);
  assert.ok(m, 'payment-claim submit button located on real render');
  assert.ok(!/\bdisabled\b/.test(m[0]),
    'payment-claim submit MUST NOT be disabled on the real /i/<token> view');
}

async function testDraftSendBannerCarriesPreviewPublicLink() {
  const html = await ejs.renderFile(path.join(VIEWS, 'invoice-view.ejs'), {
    title: 'Invoice',
    user: { plan: 'free', email: 'me@example.com', name: 'Me', business_name: null },
    invoice: {
      id: 5,
      invoice_number: 'INV-2026-0001',
      status: 'draft',
      issued_date: new Date('2026-05-01'),
      due_date: new Date('2026-05-31'),
      client_name: 'Acme Corp',
      client_email: 'acme@x.example',
      client_address: '',
      items: [{ description: 'Work', quantity: 1, unit_price: 100 }],
      subtotal: 100, tax_rate: 0, tax_amount: 0, total: 100,
      notes: null, payment_link_url: null
    },
    paymentMethods: ['card'],
    csrfToken: 'csrf-test-tkn',
    prefetchedShare: {
      url: 'https://app.example/i/abcd1234abcd1234',
      shareIntents: {
        body: 'b', subject: 's', whatsapp: 'wa', sms: 'sms', mailto: 'mt'
      },
      followUpIntents: null
    },
    flash: null
  }, { views: [VIEWS] });

  const bannerStart = html.indexOf('data-testid="draft-send-banner"');
  const bannerEnd = html.indexOf('<!-- Invoice preview card -->', bannerStart);
  const banner = bannerStart >= 0 ? html.slice(bannerStart, bannerEnd > 0 ? bannerEnd : html.length) : '';
  assert.ok(banner, 'draft-send-banner present in the rendered view');
  assert.ok(/data-testid="draft-send-banner-preview-public"/.test(banner),
    'banner carries the preview-public link so the freelancer can peek at the client view');
  const re = /<a\s[^>]*data-testid="draft-send-banner-preview-public"[^>]*>/;
  const m = banner.match(re);
  assert.ok(m, 'preview-public anchor tag located');
  const tag = m[0];
  assert.ok(/href="\/invoices\/5\/preview-public"/.test(tag),
    'preview-public link points at /invoices/<id>/preview-public; got: ' + tag);
  assert.ok(/target="_blank"/.test(tag),
    'preview-public link opens in a new tab so the user does not lose the draft view');
  assert.ok(/rel="noopener"/.test(tag),
    'preview-public link carries rel="noopener" (defence against reverse-tabnabbing)');
  // The existing preview-email link must remain — the two previews are
  // complementary (email inbox view vs browser landing view).
  assert.ok(/data-testid="draft-send-banner-preview-email"/.test(banner),
    'preview-email link still present alongside preview-public');
}

async function run() {
  const tests = [
    ['owner happy path (draft) renders preview banner + never stamps view', testOwnerHappyPathDraftDoesNotStampView],
    ['owner hydration surfaces business_name + payment_instructions', testOwnerHydrationSurfacesBusinessAndPaymentInstructions],
    ['cross-tenant invoice redirects to /dashboard', testCrossTenantRedirects],
    ['unknown invoice id redirects to /dashboard', testUnknownInvoiceRedirects],
    ['payment-claim submit disabled in preview mode', testPaymentClaimFormDisabledInPreview],
    ['real /i/<token> render omits the preview banner', testRealPublicPageOmitsPreviewBanner],
    ['draft-send-banner carries the preview-public link', testDraftSendBannerCarriesPreviewPublicLink]
  ];
  let passed = 0, failed = 0;
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
  if (failed > 0) process.exit(1);
}

run();
