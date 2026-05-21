'use strict';

/*
 * "Preview client email" — GET /invoices/:id/preview-email
 * (Milestone 3 — first invoice created → first invoice sent).
 *
 * Renders the exact subject + HTML body that lib/email.sendInvoiceEmail
 * would deliver, sandboxed in an iframe, so a freelancer can see "what my
 * client will actually receive" before tapping a share button. Addresses
 * the dominant pre-send anxiety beat ("I don't know what this looks like
 * to them") that keeps users stuck in draft.
 *
 * Covers:
 *   - Route happy path: owner sees 200 + the rendered subject + iframe
 *     srcdoc containing the email body.
 *   - Route ownership: cross-tenant invoice id (belongs to a different
 *     user) redirects to /dashboard (matches the existing /:id/print
 *     ownership-fail pattern, never leaks another user's invoice).
 *   - Route unknown id redirects to /dashboard.
 *   - Route Cache-Control: no-store so the preview never lands in an
 *     intermediate proxy.
 *   - View: chrome carries the "preview / no email sent" framing so a
 *     user can't confuse the preview for a real send.
 *   - View: iframe carries sandbox="" so any future template-injection
 *     hole can't escape the iframe into the parent page.
 *   - View: link in the draft-send-banner points at /preview-email with
 *     target="_blank" so opening the preview doesn't lose the draft view.
 *
 * Run: NODE_ENV=test node tests/preview-client-email.test.js
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
  const calls = { userById: [], invoiceById: [] };
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

  // Use the REAL email lib — buildInvoiceSubject / buildInvoiceHtml are pure
  // functions, no network calls, so the route can call them directly. This
  // is the contract the route depends on; stubbing it would only test the
  // stub, not the real preview content the user sees.
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
        hostname: '127.0.0.1', port, path: `/invoices/${id}/preview-email`,
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

async function testOwnerHappyPath() {
  const { app, calls } = buildInvoiceApp({
    user: { id: 7, plan: 'pro', email: 'me@example.com', name: 'Sam Freelance',
            business_name: 'Sam Co', reply_to_email: 'me@samco.test' },
    invoiceRow: {
      id: 5, user_id: 7, status: 'draft',
      invoice_number: 'INV-2026-0042', client_email: 'acme@x.example',
      client_name: 'Acme Corp', total: '250.00', subtotal: 250, tax_rate: 0,
      tax_amount: 0, items: [{ description: 'Logo design', quantity: 1, unit_price: 250 }],
      due_date: new Date('2026-06-30'), issued_date: new Date('2026-05-21')
    }
  });
  const r = await getPreview(app, 5);
  assert.strictEqual(r.status, 200, 'owner gets 200; got ' + r.status);
  assert.ok(/preview-email-chrome/.test(r.body),
    'chrome block present so the page is unmistakably a preview');
  assert.ok(/preview-email-iframe/.test(r.body), 'iframe rendered');
  assert.ok(/srcdoc="/.test(r.body), 'iframe carries srcdoc (the rendered email HTML)');
  assert.ok(/sandbox=""/.test(r.body),
    'iframe carries sandbox="" so any future template-injection hole cannot escape');
  // The real buildInvoiceSubject is "Invoice <number> from <senderName>" —
  // the assertion locks in the contract between the route and the email lib.
  assert.ok(/Invoice INV-2026-0042 from Sam Co/.test(r.body),
    'rendered subject embeds invoice number + business sender name; got body=' + r.body.slice(0, 400));
  assert.ok(/Acme Corp/.test(r.body),
    'rendered email body contains the client name (proves buildInvoiceHtml ran with the loaded invoice, not an empty placeholder)');
  assert.ok(/me@samco\.test/.test(r.body),
    'reply-to surfaced in the meta block so the freelancer can verify which inbox replies will hit');
  assert.ok(/no email has been sent/i.test(r.body),
    'chrome carries the "no email sent" framing so the user does not confuse the preview for a real send');
  assert.ok(/no-store/i.test(r.headers['cache-control'] || ''),
    'Cache-Control: no-store on the preview response; got ' + r.headers['cache-control']);
  assert.strictEqual(calls.invoiceById.length, 1, 'invoice loaded exactly once');
  assert.deepStrictEqual(calls.invoiceById[0], { id: '5', uid: 7 },
    'getInvoiceById called with the route id + session user id');
}

async function testCrossTenantRedirects() {
  const { app, calls } = buildInvoiceApp({
    user: { id: 7, plan: 'pro', email: 'me@x.com', name: 'Me' },
    invoiceRow: {
      id: 5, user_id: 999, // belongs to a different user
      status: 'draft',
      invoice_number: 'INV-1', client_email: 'a@x.com', client_name: 'X',
      total: '100.00', items: [], subtotal: 100, tax_rate: 0, tax_amount: 0
    }
  });
  const r = await getPreview(app, 5);
  assert.strictEqual(r.status, 302,
    'cross-tenant invoice redirects (302) — never leaks another user\'s invoice content');
  assert.strictEqual(r.headers.location, '/dashboard',
    'redirect target is /dashboard, matching the existing /:id/print ownership-fail behaviour');
  // Defence: assert the body does NOT carry the cross-tenant invoice number,
  // even on a redirect. A misconfigured response that 302'd AND rendered the
  // body would still leak the data.
  assert.ok(!/INV-1/.test(r.body),
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

async function testDraftSendBannerCarriesPreviewLink() {
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
  assert.ok(/data-testid="draft-send-banner-preview-email"/.test(banner),
    'banner carries the preview-email link');
  // Match the opening anchor tag — attribute order is irrelevant.
  const re = /<a\s[^>]*data-testid="draft-send-banner-preview-email"[^>]*>/;
  const m = banner.match(re);
  assert.ok(m, 'preview-email anchor tag located');
  const tag = m[0];
  assert.ok(/href="\/invoices\/5\/preview-email"/.test(tag),
    'preview-email link points at /invoices/<id>/preview-email');
  assert.ok(/target="_blank"/.test(tag),
    'preview-email link opens in a new tab so the user does not lose the draft view');
  assert.ok(/rel="noopener"/.test(tag),
    'preview-email link carries rel="noopener" (defence against reverse-tabnabbing)');
}

async function run() {
  const tests = [
    ['owner happy path renders subject + iframe srcdoc', testOwnerHappyPath],
    ['cross-tenant invoice redirects to /dashboard', testCrossTenantRedirects],
    ['unknown invoice id redirects to /dashboard', testUnknownInvoiceRedirects],
    ['draft-send-banner carries the preview-email link', testDraftSendBannerCarriesPreviewLink]
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
