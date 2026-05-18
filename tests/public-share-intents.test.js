'use strict';

/*
 * Public /i/<token> share-intent buttons (WhatsApp / SMS / mailto) tests.
 *
 * Covers:
 *   - lib/share-link.buildPublicShareIntents: body+subject composition,
 *     URL encoding contract on every output, missing client_name/email
 *     fallbacks, missing total/invoice_number fallbacks, null-on-no-url,
 *     mailto recipient percent-encoding (defence against malformed emails
 *     injecting extra mailto: query params).
 *   - POST /invoices/:id/share: response now carries `shareIntents` with
 *     whatsapp/sms/mailto/body/subject keys alongside the existing
 *     `{token, url}` shape. Free + Pro + Agency owners all receive it.
 *   - views/invoice-view.ejs: public-share-section renders the three
 *     share-intent buttons (gated on `url && intents`) with data-share
 *     attributes for analytics + the same testid contract used elsewhere.
 *
 * Run: NODE_ENV=test node tests/public-share-intents.test.js
 */

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');
const express = require('express');
const session = require('express-session');
const http = require('http');

const VIEWS = path.join(__dirname, '..', 'views');

// ---------- lib/share-link.buildPublicShareIntents ----------------------

function testIntentsHappyPath() {
  delete require.cache[require.resolve('../lib/share-link')];
  const { buildPublicShareIntents } = require('../lib/share-link');
  const out = buildPublicShareIntents({
    invoiceNumber: 'INV-2026-0042',
    total: 1500,
    clientName: 'Acme Co',
    clientEmail: 'pay@acme.example',
    url: 'https://decentinvoice.com/i/cafef00ddeadbeef'
  });
  assert.ok(out, 'returns a non-null object on a populated input');
  assert.strictEqual(typeof out.whatsapp, 'string');
  assert.strictEqual(typeof out.sms, 'string');
  assert.strictEqual(typeof out.mailto, 'string');
  assert.strictEqual(typeof out.body, 'string');
  assert.strictEqual(typeof out.subject, 'string');
  // Body contract: greeting + facts + URL last (SMS-truncation-safe)
  assert.ok(out.body.startsWith('Hi Acme Co,'), `body greets the client: "${out.body}"`);
  assert.ok(out.body.includes('invoice INV-2026-0042'), 'body names the invoice');
  assert.ok(out.body.includes('$1500.00'), 'body shows the formatted total');
  assert.ok(out.body.endsWith('https://decentinvoice.com/i/cafef00ddeadbeef'),
    'URL is last so a truncated SMS preview keeps the click target');
  // Subject contract
  assert.strictEqual(out.subject, 'Invoice INV-2026-0042 — $1500.00');
}

function testIntentsUrlEncodingOnEveryOutput() {
  delete require.cache[require.resolve('../lib/share-link')];
  const { buildPublicShareIntents } = require('../lib/share-link');
  const out = buildPublicShareIntents({
    invoiceNumber: 'INV-2026-0042',
    total: 1500,
    clientName: 'Acme Co',
    clientEmail: 'pay@acme.example',
    url: 'https://decentinvoice.com/i/cafef00ddeadbeef'
  });
  // WhatsApp wraps everything in `?text=` — body must be percent-encoded
  assert.ok(out.whatsapp.startsWith('https://wa.me/?text='));
  assert.ok(!out.whatsapp.includes(' '),
    'whatsapp href must have no raw spaces — they should be %20-encoded');
  assert.ok(out.whatsapp.includes('Hi%20Acme%20Co'),
    'whatsapp body greeting must be percent-encoded');
  // SMS body uses `body=`
  assert.ok(out.sms.startsWith('sms:?&body='));
  assert.ok(!out.sms.includes(' '),
    'sms href must have no raw spaces');
  // mailto with subject + body
  assert.ok(out.mailto.startsWith('mailto:'));
  assert.ok(out.mailto.includes('subject=Invoice%20INV-2026-0042'),
    'mailto subject must be percent-encoded');
  assert.ok(out.mailto.includes('body='),
    'mailto must carry the body query param');
  assert.ok(!out.mailto.includes(' '),
    'mailto href must have no raw spaces');
}

function testIntentsMailtoRecipientPercentEncoded() {
  // Defence in depth: a malformed/hostile client_email like
  // `victim@x.com?cc=attacker@evil.com` could otherwise inject extra
  // mailto: query params and silently CC a third party from the user's
  // mail client. The lib must percent-encode the recipient just like the
  // Pro pay-link share-intent at views/invoice-view.ejs:282.
  delete require.cache[require.resolve('../lib/share-link')];
  const { buildPublicShareIntents } = require('../lib/share-link');
  const out = buildPublicShareIntents({
    invoiceNumber: 'INV-1',
    total: 100,
    clientName: 'X',
    clientEmail: 'victim@x.com?cc=attacker@evil.com',
    url: 'https://decentinvoice.com/i/abcd1234abcd1234'
  });
  // The encoded `?` is `%3F`; presence of a literal `?` after the recipient
  // is allowed (the subject= one), but not before it. Check that the raw
  // hostile email's `?` is encoded.
  const recipientPart = out.mailto.slice('mailto:'.length).split('?')[0];
  assert.ok(recipientPart.includes('%3F'),
    `recipient must have its raw "?" percent-encoded; got "${recipientPart}"`);
  assert.ok(!recipientPart.includes('?cc='),
    'recipient must not contain a raw `?cc=` that would inject a mailto CC param');
}

function testIntentsFallbackWhenNoClientName() {
  delete require.cache[require.resolve('../lib/share-link')];
  const { buildPublicShareIntents } = require('../lib/share-link');
  const out = buildPublicShareIntents({
    invoiceNumber: 'INV-1',
    total: 50,
    url: '/i/abcd1234abcd1234'
  });
  assert.ok(out.body.startsWith('Hi, '),
    `falls back to "Hi," when client_name is absent; got "${out.body}"`);
  // mailto without recipient: still valid as `mailto:?subject=…&body=…`
  assert.ok(/^mailto:\?subject=/.test(out.mailto),
    'mailto with empty recipient still parses as a valid native compose target');
}

function testIntentsFallbackWhenNoInvoiceFields() {
  delete require.cache[require.resolve('../lib/share-link')];
  const { buildPublicShareIntents } = require('../lib/share-link');
  const out = buildPublicShareIntents({
    url: '/i/abcd1234abcd1234'
  });
  // No invoice_number + no total → still produces a coherent body
  assert.ok(typeof out.body === 'string' && out.body.length > 0);
  assert.ok(out.body.includes('/i/abcd1234abcd1234'),
    'URL still appears in body when invoice fields are missing');
  assert.strictEqual(out.subject, 'Your invoice',
    'subject falls back to a generic line when invoice_number is missing');
}

function testIntentsRejectsMissingUrl() {
  delete require.cache[require.resolve('../lib/share-link')];
  const { buildPublicShareIntents } = require('../lib/share-link');
  assert.strictEqual(
    buildPublicShareIntents({ invoiceNumber: 'INV-1', total: 100 }),
    null,
    'returns null when url is missing — caller renders nothing rather than a half-built href'
  );
  assert.strictEqual(buildPublicShareIntents(null), null);
  assert.strictEqual(buildPublicShareIntents(undefined), null);
  assert.strictEqual(buildPublicShareIntents({ url: 42 }), null,
    'non-string url is treated as missing');
}

function testIntentsNonFiniteTotalOmitsAmount() {
  delete require.cache[require.resolve('../lib/share-link')];
  const { buildPublicShareIntents } = require('../lib/share-link');
  const out = buildPublicShareIntents({
    invoiceNumber: 'INV-1',
    total: 'not-a-number',
    url: '/i/abcd1234abcd1234'
  });
  assert.ok(!out.body.includes('$'),
    `body omits the dollar amount when total is non-numeric; got "${out.body}"`);
  assert.strictEqual(out.subject, 'Invoice INV-1',
    'subject omits the amount when total is non-numeric');
}

// ---------- POST /invoices/:id/share carries shareIntents ----------------

function buildShareApp({ userPlan, invoiceRow, token }) {
  const dbStub = {
    pool: { query: async () => ({ rows: [] }) },
    db: {
      async getUserById() { return { id: 7, plan: userPlan }; },
      async getInvoiceById(id, uid) {
        if (!invoiceRow) return null;
        return Object.assign({ user_id: uid }, invoiceRow);
      },
      async getOrCreatePublicToken() { return token; },
      async getInvoicesByUser() { return []; },
      async getRecentRevenueStats() { return null; },
      async getNextInvoiceNumber() { return 'INV-2026-0001'; }
    }
  };
  require.cache[require.resolve('../db')] = {
    id: require.resolve('../db'), filename: require.resolve('../db'),
    loaded: true, exports: dbStub
  };
  delete require.cache[require.resolve('../routes/invoices')];
  delete require.cache[require.resolve('../lib/share-link')];
  const invoiceRoutes = require('../routes/invoices');
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', VIEWS);
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, res, next) => {
    req.session.user = { id: 7, plan: userPlan };
    next();
  });
  app.use('/invoices', invoiceRoutes);
  return app;
}

function postShare(app, id) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
      const req = http.request({
        hostname: '127.0.0.1', port, path: `/invoices/${id}/share`, method: 'POST', headers
      }, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => server.close(() => resolve({ status: res.statusCode, body: data })));
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.end();
    });
  });
}

async function testShareEndpointReturnsShareIntentsForFree() {
  process.env.APP_URL = 'https://decentinvoice.com';
  const app = buildShareApp({
    userPlan: 'free',
    invoiceRow: {
      id: 5,
      invoice_number: 'INV-2026-0042',
      total: '1500.00',
      client_name: 'Acme Co',
      client_email: 'pay@acme.example'
    },
    token: 'cafef00ddeadbeef'
  });
  const r = await postShare(app, 5);
  assert.strictEqual(r.status, 200);
  const body = JSON.parse(r.body);
  assert.strictEqual(body.token, 'cafef00ddeadbeef');
  assert.strictEqual(body.url, 'https://decentinvoice.com/i/cafef00ddeadbeef');
  assert.ok(body.shareIntents, 'response carries shareIntents alongside url+token');
  assert.ok(body.shareIntents.whatsapp.startsWith('https://wa.me/?text='),
    'shareIntents.whatsapp is a wa.me deep-link');
  assert.ok(body.shareIntents.sms.startsWith('sms:?&body='),
    'shareIntents.sms is an sms: deep-link');
  assert.ok(body.shareIntents.mailto.startsWith('mailto:'),
    'shareIntents.mailto is a mailto: deep-link');
  // Body inside the encoded payload must contain the URL (URL-encoded)
  const expectedEncodedUrl = encodeURIComponent('https://decentinvoice.com/i/cafef00ddeadbeef');
  assert.ok(body.shareIntents.whatsapp.includes(expectedEncodedUrl),
    'whatsapp body embeds the share URL');
  delete process.env.APP_URL;
}

async function testShareEndpointReturnsShareIntentsForPro() {
  const app = buildShareApp({
    userPlan: 'pro',
    invoiceRow: {
      id: 5, invoice_number: 'INV-2026-0001', total: '300.00',
      client_name: 'Bob', client_email: 'bob@x.example'
    },
    token: 'beefbeefbeefbeef'
  });
  const r = await postShare(app, 5);
  assert.strictEqual(r.status, 200);
  const body = JSON.parse(r.body);
  assert.ok(body.shareIntents, 'Pro also receives shareIntents — share-intent buttons render on every plan');
  assert.ok(body.shareIntents.body.includes('Bob'),
    'body greets the client by name');
  assert.ok(body.shareIntents.body.includes('$300.00'),
    'body shows the formatted total');
}

async function testShareEndpointReturnsShareIntentsForAgency() {
  const app = buildShareApp({
    userPlan: 'agency',
    invoiceRow: {
      id: 5, invoice_number: 'INV-2026-0001', total: '300.00',
      client_name: 'C', client_email: 'c@x.example'
    },
    token: 'cafef00ddeadbeefcafef00ddeadbeef'
  });
  const r = await postShare(app, 5);
  assert.strictEqual(r.status, 200);
  const body = JSON.parse(r.body);
  assert.ok(body.shareIntents,
    'Agency also receives shareIntents — feature is plan-neutral');
}

// ---------- views/invoice-view.ejs renders share-intent buttons ----------

async function renderInvoiceView({ userPlan, payment_link_url }) {
  return ejs.renderFile(path.join(VIEWS, 'invoice-view.ejs'), {
    title: 'Invoice',
    user: { plan: userPlan, email: 'me@example.com', name: 'Me', business_name: null },
    invoice: {
      id: 5,
      invoice_number: 'INV-2026-0001',
      status: 'draft',
      issued_date: new Date('2026-05-01'),
      due_date: new Date('2026-05-31'),
      client_name: 'Acme',
      client_email: 'acme@x.example',
      client_address: '',
      items: [{ description: 'Work', quantity: 1, unit_price: 100 }],
      subtotal: 100, tax_rate: 0, tax_amount: 0, total: 100,
      notes: null,
      payment_link_url: payment_link_url || null
    },
    paymentMethods: ['card'],
    csrfToken: 'tkn',
    flash: null
  }, { views: [VIEWS] });
}

async function testViewRendersShareIntentsContainerForFree() {
  const html = await renderInvoiceView({ userPlan: 'free' });
  assert.ok(html.includes('data-testid="public-share-intents"'),
    'public-share-intents container present for free users');
  assert.ok(html.includes('data-share="whatsapp"'),
    'WhatsApp button rendered for free users');
  assert.ok(html.includes('data-share="sms"'),
    'SMS button rendered for free users');
  assert.ok(html.includes('data-share="email"'),
    'Email button rendered for free users');
}

async function testViewRendersShareIntentsContainerForPro() {
  const html = await renderInvoiceView({ userPlan: 'pro', payment_link_url: 'https://buy.stripe.com/test' });
  // Pro already has the pay-link share-intents (data-share=… inside the
  // Payment Link card). The NEW container is gated on `url && intents` —
  // it must also be in the markup so Pro users get the public-share
  // intent too once they click Generate.
  assert.ok(html.includes('data-testid="public-share-intents"'),
    'public-share-intents container present for Pro users too');
}

async function testViewSharesIntentsAlpineGatedOnUrl() {
  const html = await renderInvoiceView({ userPlan: 'free' });
  // The container is x-show="url && intents" so it stays hidden until the
  // fetch resolves — pre-fetch the user sees only the Generate button.
  // Just check both gates are present on the container itself.
  const idx = html.indexOf('data-testid="public-share-intents"');
  assert.ok(idx >= 0);
  const window = html.slice(Math.max(0, idx - 200), idx + 200);
  assert.ok(/x-show="url\s*&&\s*intents"/.test(window),
    'container gates on both url AND intents being set');
  assert.ok(/x-cloak/.test(window),
    'container uses x-cloak so pre-Alpine render does not flash the buttons');
}

async function testViewSharesIntentsHrefBoundFromAlpineState() {
  const html = await renderInvoiceView({ userPlan: 'free' });
  // hrefs must be x-bind:href so they come from the fetch payload —
  // a static EJS-evaluated mailto: would be wrong (the URL isn't known
  // until the fetch returns the token).
  assert.ok(/x-bind:href="intents\s*&&\s*intents\.whatsapp"/.test(html),
    'whatsapp href is bound to the Alpine intents.whatsapp');
  assert.ok(/x-bind:href="intents\s*&&\s*intents\.sms"/.test(html),
    'sms href is bound to the Alpine intents.sms');
  assert.ok(/x-bind:href="intents\s*&&\s*intents\.mailto"/.test(html),
    'mailto href is bound to the Alpine intents.mailto');
}

async function testViewClickHandlerAssignsIntents() {
  const html = await renderInvoiceView({ userPlan: 'free' });
  // The Generate-link button's fetch().then must assign data.shareIntents
  // into the Alpine state so the new container becomes visible after a
  // successful mint.
  assert.ok(/intents\s*=\s*data\.shareIntents/.test(html),
    'fetch resolver assigns data.shareIntents into the Alpine `intents` state');
  // x-data may now host nested object literals (e.g. the fireIntent helper
  // method that fires the share-intent ping); match across them.
  assert.ok(/x-data="\{[\s\S]*?\burl:[\s\S]*?\bintents:\s*null/.test(html),
    'Alpine x-data declares an initial `intents: null`');
}

// ---------- runner -------------------------------------------------------

(async () => {
  const tests = [
    ['lib helper: happy path', testIntentsHappyPath],
    ['lib helper: URL encoding on every output', testIntentsUrlEncodingOnEveryOutput],
    ['lib helper: mailto recipient is percent-encoded (CC-injection defence)', testIntentsMailtoRecipientPercentEncoded],
    ['lib helper: missing client_name falls back to "Hi,"', testIntentsFallbackWhenNoClientName],
    ['lib helper: missing invoice fields fall back coherently', testIntentsFallbackWhenNoInvoiceFields],
    ['lib helper: missing url returns null', testIntentsRejectsMissingUrl],
    ['lib helper: non-finite total omits the dollar amount', testIntentsNonFiniteTotalOmitsAmount],
    ['route: free response carries shareIntents', testShareEndpointReturnsShareIntentsForFree],
    ['route: Pro response carries shareIntents', testShareEndpointReturnsShareIntentsForPro],
    ['route: Agency response carries shareIntents', testShareEndpointReturnsShareIntentsForAgency],
    ['view: share-intents container renders for free', testViewRendersShareIntentsContainerForFree],
    ['view: share-intents container renders for Pro', testViewRendersShareIntentsContainerForPro],
    ['view: container is x-show-gated on url && intents + x-cloak', testViewSharesIntentsAlpineGatedOnUrl],
    ['view: hrefs are x-bind:href to Alpine state', testViewSharesIntentsHrefBoundFromAlpineState],
    ['view: fetch resolver assigns data.shareIntents into Alpine state', testViewClickHandlerAssignsIntents]
  ];
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log('  ok  ' + name);
    } catch (e) {
      failed++;
      console.error('  FAIL ' + name);
      console.error(e && e.stack ? e.stack : e);
    }
  }
  if (failed) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log(`\n${tests.length} tests passed`);
})();
