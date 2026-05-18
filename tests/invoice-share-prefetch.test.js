'use strict';

/*
 * Eager-prefetch of the public share-link surface on GET /invoices/:id.
 *
 * The freelancer's path from "invoice created" to "invoice sent" is the
 * single biggest drop-off in the activation funnel (PLAN.md Milestone 3).
 * Until this ship the user had to click "Generate share link" before the
 * WhatsApp / SMS / Email share-intent buttons appeared — one extra click on
 * the activation-critical surface. This file exercises the prefetch:
 *
 *   - lib/share-link.buildShareSurfaceForInvoice: returns the same
 *     {url, shareIntents, followUpIntents} shape the POST /:id/share route
 *     responds with, computed from an invoice row + its public_token.
 *   - GET /invoices/:id: eagerly mints the token via getOrCreatePublicToken
 *     and passes `prefetchedShare` to the view. A mint failure (throw OR
 *     null OR missing method on a partial stub) must NOT crash the page —
 *     the route still renders 200 with the legacy Generate-button fallback.
 *   - views/invoice-view.ejs: surfaces the prefetched URL / intents /
 *     followUpIntents via data-prefetch-* attributes; x-init hydrates the
 *     Alpine state from them so the share-intent buttons render on first
 *     paint. The Generate button stays in the DOM as a fallback. The
 *     existing x-data initial state literals (intents: null,
 *     followUpIntents: null) are preserved so the legacy tests still pass.
 *
 * Run: NODE_ENV=test node tests/invoice-share-prefetch.test.js
 */

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

const assert = require('assert');
const path = require('path');
const ejs = require('ejs');
const express = require('express');
const session = require('express-session');
const http = require('http');

const VIEWS = path.join(__dirname, '..', 'views');

// ---------- lib helper -------------------------------------------------

function testLibBuildSurfaceHappyPath() {
  delete require.cache[require.resolve('../lib/share-link')];
  process.env.APP_URL = 'https://decentinvoice.com';
  const { buildShareSurfaceForInvoice } = require('../lib/share-link');
  const surface = buildShareSurfaceForInvoice({
    id: 5,
    invoice_number: 'INV-2026-0001',
    total: '1500.00',
    client_name: 'Acme Co',
    client_email: 'pay@acme.example',
    public_token: 'cafef00ddeadbeef',
    due_date: '2026-06-01',
    status: 'sent'
  }, { now: new Date('2026-05-01T00:00:00Z') });
  assert.ok(surface, 'returns a non-null surface on populated input');
  assert.strictEqual(surface.url, 'https://decentinvoice.com/i/cafef00ddeadbeef');
  assert.ok(surface.shareIntents, 'shareIntents present');
  assert.ok(surface.shareIntents.whatsapp.startsWith('https://wa.me/?text='));
  assert.ok(surface.shareIntents.body.includes('INV-2026-0001'));
  assert.ok(surface.followUpIntents, 'followUpIntents present');
  // Not overdue (due 2026-06-01, now 2026-05-01) → followUpIntents.overdue is false
  assert.strictEqual(surface.followUpIntents.overdue, false,
    'pre-due invoice marks followUpIntents.overdue=false');
  delete process.env.APP_URL;
}

function testLibBuildSurfaceComputesDaysOverdue() {
  delete require.cache[require.resolve('../lib/share-link')];
  const { buildShareSurfaceForInvoice } = require('../lib/share-link');
  const surface = buildShareSurfaceForInvoice({
    invoice_number: 'INV-OVERDUE',
    total: 100,
    client_name: 'Late Co',
    client_email: 'late@x.com',
    public_token: 'abcd1234abcd1234',
    due_date: '2026-04-01',
    status: 'overdue'
  }, { now: new Date('2026-05-01T00:00:00Z') });
  assert.ok(surface);
  assert.strictEqual(surface.followUpIntents.overdue, true,
    '30-days-past-due invoice flags followUpIntents.overdue=true');
  assert.ok(/Reminder:.*Invoice INV-OVERDUE.*overdue/.test(surface.followUpIntents.subject),
    `overdue subject sharpens to "Reminder:": "${surface.followUpIntents.subject}"`);
}

function testLibBuildSurfaceReturnsNullOnMissingToken() {
  delete require.cache[require.resolve('../lib/share-link')];
  const { buildShareSurfaceForInvoice } = require('../lib/share-link');
  assert.strictEqual(buildShareSurfaceForInvoice(null), null);
  assert.strictEqual(buildShareSurfaceForInvoice({ invoice_number: 'X' }), null,
    'no public_token → null (route falls back to Generate button)');
  assert.strictEqual(buildShareSurfaceForInvoice({ public_token: 'bad-not-hex' }), null,
    'malformed public_token → null (defence in depth alongside isValidPublicToken)');
}

function testLibBuildSurfaceTreatsMissingDueDateAsNotOverdue() {
  delete require.cache[require.resolve('../lib/share-link')];
  const { buildShareSurfaceForInvoice } = require('../lib/share-link');
  const surface = buildShareSurfaceForInvoice({
    invoice_number: 'X',
    total: 50,
    client_name: 'A',
    public_token: 'abcd1234abcd1234',
    due_date: null
  }, { now: new Date('2026-05-01T00:00:00Z') });
  assert.strictEqual(surface.followUpIntents.overdue, false,
    'no due_date is treated as not overdue (the most charitable default)');
}

// ---------- GET /invoices/:id prefetch via route ----------------------

function buildInvoiceViewApp({ userPlan, invoiceRow, token, mintBehavior }) {
  let getOrCreateCallCount = 0;
  let getOrCreateArgs = null;
  const dbStub = {
    pool: { query: async () => ({ rows: [] }) },
    db: {
      async getUserById() {
        return { id: 7, plan: userPlan, name: 'Owner', email: 'me@x.com', business_name: null };
      },
      async getInvoiceById(id, uid) {
        if (!invoiceRow) return null;
        return Object.assign({ user_id: uid }, invoiceRow);
      },
      async getOrCreatePublicToken(invoiceId, userId) {
        getOrCreateCallCount++;
        getOrCreateArgs = { invoiceId, userId };
        if (mintBehavior === 'throw') throw new Error('mint exploded');
        if (mintBehavior === 'null') return null;
        return token;
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
    res.locals.csrfToken = 'tkn';
    next();
  });
  app.use('/invoices', invoiceRoutes);
  app.getMintStats = () => ({ count: getOrCreateCallCount, args: getOrCreateArgs });
  return app;
}

function getInvoiceView(app, id) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const req = http.request({
        hostname: '127.0.0.1', port, path: `/invoices/${id}`, method: 'GET'
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

async function testRoutePrefetchesShareSurfaceOnView() {
  process.env.APP_URL = 'https://decentinvoice.com';
  const app = buildInvoiceViewApp({
    userPlan: 'free',
    invoiceRow: {
      id: 5,
      invoice_number: 'INV-2026-0042',
      status: 'draft',
      total: '1500.00',
      client_name: 'Acme Co',
      client_email: 'pay@acme.example',
      issued_date: new Date('2026-05-01'),
      due_date: new Date('2026-05-31'),
      items: [{ description: 'x', quantity: 1, unit_price: 1500 }],
      subtotal: 1500, tax_rate: 0, tax_amount: 0
    },
    token: 'cafef00ddeadbeef'
  });
  const r = await getInvoiceView(app, 5);
  assert.strictEqual(r.status, 200,
    'GET /invoices/:id still returns 200 with the prefetch enabled');
  assert.strictEqual(app.getMintStats().count, 1,
    'route calls getOrCreatePublicToken exactly once per view render');
  assert.strictEqual(app.getMintStats().args.invoiceId, 5,
    'route passes the invoice id from the URL');
  assert.strictEqual(app.getMintStats().args.userId, 7,
    'route passes the session user id');
  assert.ok(r.body.includes('data-prefetch-url="https://decentinvoice.com/i/cafef00ddeadbeef"'),
    'prefetched URL appears in the data-prefetch-url attribute');
  assert.ok(/data-prefetch-intents="\{[^"]*whatsapp[^"]*\}"/.test(r.body),
    'prefetched share intents JSON appears in data-prefetch-intents (HTML-escaped)');
  assert.ok(/data-prefetch-followup="\{[^"]*whatsapp[^"]*\}"/.test(r.body),
    'prefetched follow-up intents JSON appears in data-prefetch-followup');
  delete process.env.APP_URL;
}

async function testRouteRendersWhenMintThrows() {
  const app = buildInvoiceViewApp({
    userPlan: 'free',
    invoiceRow: {
      id: 9,
      invoice_number: 'INV-X',
      status: 'draft',
      total: 100,
      client_name: 'X',
      client_email: 'x@x.com',
      issued_date: new Date('2026-05-01'),
      due_date: new Date('2026-05-31'),
      items: [{ description: 'a', quantity: 1, unit_price: 100 }],
      subtotal: 100, tax_rate: 0, tax_amount: 0
    },
    token: 'cafef00ddeadbeef',
    mintBehavior: 'throw'
  });
  const r = await getInvoiceView(app, 9);
  assert.strictEqual(r.status, 200,
    'a thrown mint must NOT break the page render');
  assert.ok(r.body.includes('data-prefetch-url=""'),
    'data-prefetch-url is empty when the mint failed — Generate-button fallback owns the flow');
  assert.ok(r.body.includes('data-testid="public-share-generate"'),
    'Generate fallback button still present in the DOM after a mint failure');
}

async function testRouteRendersWhenMintReturnsNull() {
  const app = buildInvoiceViewApp({
    userPlan: 'free',
    invoiceRow: {
      id: 10,
      invoice_number: 'INV-Y',
      status: 'draft',
      total: 200,
      client_name: 'Y',
      issued_date: new Date('2026-05-01'),
      due_date: new Date('2026-05-31'),
      items: [{ description: 'b', quantity: 1, unit_price: 200 }],
      subtotal: 200, tax_rate: 0, tax_amount: 0
    },
    token: null,
    mintBehavior: 'null'
  });
  const r = await getInvoiceView(app, 10);
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.includes('data-prefetch-url=""'),
    'data-prefetch-url stays empty when getOrCreatePublicToken returns null');
}

async function testRouteSurvivesPartialDbStubWithoutMintMethod() {
  // Defence-in-depth — earlier tests + legacy stubs may not implement
  // getOrCreatePublicToken. Our try/catch absorbs the TypeError so the
  // view still renders.
  const dbStub = {
    pool: { query: async () => ({ rows: [] }) },
    db: {
      async getUserById() { return { id: 7, plan: 'free', email: 'a@b.com', name: 'A' }; },
      async getInvoiceById(id, uid) {
        return {
          id: 11, user_id: uid, invoice_number: 'INV-Z', status: 'draft',
          total: 50, client_name: 'Z',
          issued_date: new Date('2026-05-01'),
          due_date: new Date('2026-05-31'),
          items: [{ description: 'c', quantity: 1, unit_price: 50 }],
          subtotal: 50, tax_rate: 0, tax_amount: 0
        };
      }
      // intentionally no getOrCreatePublicToken
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
    req.session.user = { id: 7, plan: 'free' };
    res.locals.csrfToken = 'tkn';
    next();
  });
  app.use('/invoices', invoiceRoutes);
  const r = await getInvoiceView(app, 11);
  assert.strictEqual(r.status, 200,
    'route must render 200 even when db.getOrCreatePublicToken is undefined (partial stub / partial deploy)');
  assert.ok(r.body.includes('public-share-section'),
    'share section still renders in the page');
}

// ---------- views/invoice-view.ejs prefetch wiring ---------------------

function makeInvoiceForView(overrides) {
  return Object.assign({
    id: 1,
    invoice_number: 'INV-2026-0001',
    status: 'draft',
    issued_date: new Date('2026-05-01'),
    due_date: new Date('2026-05-31'),
    client_name: 'Acme',
    client_email: 'acme@x.com',
    client_address: '',
    items: [{ description: 'x', quantity: 1, unit_price: 100 }],
    subtotal: 100, tax_rate: 0, tax_amount: 0, total: 100,
    notes: null,
    payment_link_url: null
  }, overrides || {});
}

function renderView(prefetchedShare) {
  return ejs.renderFile(path.join(VIEWS, 'invoice-view.ejs'), {
    title: 'Invoice',
    user: { plan: 'free', email: 'me@x.com', name: 'Me', business_name: null },
    invoice: makeInvoiceForView(),
    paymentMethods: ['card'],
    csrfToken: 'tkn',
    prefetchedShare,
    flash: null
  }, { views: [VIEWS] });
}

async function testViewRendersPrefetchAttrsWhenSupplied() {
  const html = await renderView({
    url: 'https://decentinvoice.com/i/cafef00ddeadbeef',
    shareIntents: { body: 'b', subject: 's', whatsapp: 'https://wa.me/?text=b',
      sms: 'sms:?&body=b', mailto: 'mailto:?subject=s&body=b' },
    followUpIntents: { body: 'b2', subject: 's2', overdue: false,
      whatsapp: 'https://wa.me/?text=b2', sms: 'sms:?&body=b2', mailto: 'mailto:?subject=s2&body=b2' }
  });
  assert.ok(html.includes('data-prefetch-url="https://decentinvoice.com/i/cafef00ddeadbeef"'),
    'data-prefetch-url carries the URL when prefetchedShare is supplied');
  // EJS HTML-escapes the JSON in <%= %> — JSON.parse decodes after the
  // browser HTML-decodes the dataset attribute value.
  assert.ok(html.includes('data-prefetch-intents="') && /data-prefetch-intents="[^"]*whatsapp[^"]*"/.test(html),
    'data-prefetch-intents carries an HTML-escaped JSON blob with the share-intent keys');
  assert.ok(/data-prefetch-followup="[^"]*whatsapp[^"]*"/.test(html),
    'data-prefetch-followup carries the follow-up intents JSON');
}

async function testViewEmptyPrefetchAttrsWhenAbsent() {
  const html = await renderView(undefined);
  assert.ok(html.includes('data-prefetch-url=""'),
    'data-prefetch-url is an empty string when prefetchedShare is absent (no URL leak)');
  assert.ok(html.includes('data-prefetch-intents=""'),
    'data-prefetch-intents is empty so x-init falls through to defaults');
  assert.ok(html.includes('data-prefetch-followup=""'),
    'data-prefetch-followup is empty so x-init falls through to defaults');
}

async function testViewXInitHydratesFromDataset() {
  const html = await renderView({
    url: '/i/abcd1234abcd1234',
    shareIntents: { whatsapp: 'wa', sms: 'sms', mailto: 'm' },
    followUpIntents: { whatsapp: 'wa2', sms: 'sms2', mailto: 'm2', overdue: false }
  });
  // The x-init handler must read all three data-prefetch-* attributes
  // and assign them into the Alpine reactive scope.
  assert.ok(/x-init="[^"]*\$el\.dataset\.prefetchUrl[^"]*"/.test(html),
    'x-init reads $el.dataset.prefetchUrl into the Alpine `url` reactive');
  assert.ok(/x-init="[^"]*JSON\.parse\(\$el\.dataset\.prefetchIntents\)[^"]*"/.test(html),
    'x-init JSON.parses dataset.prefetchIntents into the Alpine `intents` reactive');
  assert.ok(/x-init="[^"]*JSON\.parse\(\$el\.dataset\.prefetchFollowup\)[^"]*"/.test(html),
    'x-init JSON.parses dataset.prefetchFollowup into the Alpine `followUpIntents` reactive');
  // try/catch around the parse so a malformed payload never crashes the
  // scope (defence in depth — the server-generated JSON is trusted but
  // the wrapping survives the worst case).
  assert.ok(/x-init="try \{[\s\S]*?\} catch \(e\) \{\}"/.test(html),
    'x-init wraps the hydration in try/catch so a bad payload never crashes the scope');
}

async function testViewKeepsGenerateButtonAsFallback() {
  const html = await renderView({
    url: '/i/abcd1234abcd1234',
    shareIntents: { whatsapp: 'wa', sms: 'sms', mailto: 'm' },
    followUpIntents: { whatsapp: 'wa2', sms: 'sms2', mailto: 'm2', overdue: false }
  });
  // The Generate button must still exist in the DOM (just visually hidden
  // by x-show="!url" when prefetch succeeds) so a prefetch failure path
  // can still mint the token via the legacy fetch flow.
  assert.ok(html.includes('data-testid="public-share-generate"'),
    'Generate-link button remains in the DOM as a fallback even when prefetched');
  assert.ok(/x-show="!url"/.test(html),
    'Generate button is x-show-gated on `!url` so it hides when prefetch already populated the URL');
}

async function testViewPreservesLegacyXDataInitialState() {
  // Existing tests (public-share-intents, follow-up-share-intents) assert
  // the literal substrings "intents: null" and "followUpIntents: null" in
  // x-data. The new hydration must NOT change the x-data literal — it
  // assigns into the reactives via x-init, AFTER the initial declaration.
  const html = await renderView({
    url: '/i/abcd1234abcd1234',
    shareIntents: { whatsapp: 'wa', sms: 'sms', mailto: 'm' },
    followUpIntents: { whatsapp: 'wa2', sms: 'sms2', mailto: 'm2', overdue: false }
  });
  assert.ok(/x-data="\{[\s\S]*?\burl:\s*''[\s\S]*?\bintents:\s*null[\s\S]*?\bfollowUpIntents:\s*null/.test(html),
    'x-data literal still declares url:\'\', intents:null, followUpIntents:null — hydration happens in x-init');
}

async function testViewDataPrefetchEscapesJsonForHtmlAttribute() {
  // Defence: a client_name containing a `"` or `&` must not break out of
  // the data-prefetch-intents attribute. EJS's <%= %> HTML-escapes those.
  const html = await renderView({
    url: '/i/abcd1234abcd1234',
    shareIntents: {
      whatsapp: 'https://wa.me/?text=Hi%20%22hostile%22',
      body: 'Hi "hostile", <script>alert(1)</script> & more',
      subject: 's', sms: 'sms', mailto: 'm'
    },
    followUpIntents: { whatsapp: 'wa', sms: 'sms', mailto: 'm', overdue: false }
  });
  // Double quotes inside JSON values must appear HTML-escaped (EJS emits
  // numeric `&#34;` rather than `&quot;` but both are valid `"` entities)
  // so they do not close the attribute prematurely.
  assert.ok(/&#34;|&quot;/.test(html),
    'JSON quotes are HTML-escaped via EJS <%= %> so the attribute boundary is preserved');
  // Literal <script> must not appear unescaped inside the attribute (the
  // `<` becomes `&lt;` and `>` becomes `&gt;` so the parser cannot
  // accidentally start tag-tokenising from within the attribute value).
  assert.ok(!/data-prefetch-intents="[^"]*<script>/.test(html),
    'no raw <script> inside the data-prefetch-intents attribute value');
  assert.ok(html.includes('&lt;script&gt;'),
    '<script> is HTML-encoded so the attribute payload cannot escape into markup');
}

// ---------- runner -----------------------------------------------------

(async () => {
  const tests = [
    ['lib: buildShareSurfaceForInvoice happy path', testLibBuildSurfaceHappyPath],
    ['lib: buildShareSurfaceForInvoice computes overdue follow-up from due_date', testLibBuildSurfaceComputesDaysOverdue],
    ['lib: buildShareSurfaceForInvoice returns null on missing/bad token', testLibBuildSurfaceReturnsNullOnMissingToken],
    ['lib: buildShareSurfaceForInvoice treats missing due_date as not overdue', testLibBuildSurfaceTreatsMissingDueDateAsNotOverdue],
    ['route: GET /invoices/:id prefetches share surface + emits data-prefetch-*', testRoutePrefetchesShareSurfaceOnView],
    ['route: GET /invoices/:id survives a throwing getOrCreatePublicToken', testRouteRendersWhenMintThrows],
    ['route: GET /invoices/:id survives a null mint return', testRouteRendersWhenMintReturnsNull],
    ['route: GET /invoices/:id survives a partial db stub without getOrCreatePublicToken', testRouteSurvivesPartialDbStubWithoutMintMethod],
    ['view: data-prefetch-* attrs carry the surface when supplied', testViewRendersPrefetchAttrsWhenSupplied],
    ['view: data-prefetch-* attrs empty when no prefetchedShare', testViewEmptyPrefetchAttrsWhenAbsent],
    ['view: x-init hydrates url + JSON.parses intents + followUp', testViewXInitHydratesFromDataset],
    ['view: Generate-link button remains as fallback (x-show !url)', testViewKeepsGenerateButtonAsFallback],
    ['view: legacy x-data initial state literal preserved', testViewPreservesLegacyXDataInitialState],
    ['view: hostile JSON cannot break out of data-prefetch-intents attribute', testViewDataPrefetchEscapesJsonForHtmlAttribute]
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
