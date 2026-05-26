'use strict';

/*
 * Tests for per-invoice OpenGraph metadata on the public /i/<token>
 * share page. The previous render passed no per-page OG locals, so
 * every shared invoice URL previewed as the default SaaS marketing tile
 * in WhatsApp / iMessage / Slack — a real Milestone 4 (sent → paid)
 * conversion blocker. This file locks in:
 *
 *   (1) lib/public-invoice-og.buildPublicInvoiceOg() shape and copy
 *   (2) GET /i/<token> threads og fields into views/partials/head.ejs
 *   (3) hostile owner_business_name is HTML-escaped inside the meta tag
 *   (4) client_name is NEVER surfaced in og:title or og:description (privacy)
 *   (5) og:url is the absolute /i/<token> built from APP_URL
 *   (6) noindex remains true so search engines stay out
 *
 * Run: node tests/public-invoice-og.test.js
 */

const assert = require('assert');
const path = require('path');
const express = require('express');
const http = require('http');

const VIEWS = path.join(__dirname, '..', 'views');

// Quiet error logging from the route on intentional failure paths
const origConsoleError = console.error;
console.error = function () {};

function stubDbPg() {
  // The lib being tested doesn't touch pg, but require('../routes/share')
  // chains through require('../db') which would otherwise try to open a
  // real pool. Stub pg at the cache layer.
  const pgPath = require.resolve('pg');
  require.cache[pgPath] = {
    id: pgPath, filename: pgPath, loaded: true,
    exports: { Pool: function () { this.query = async () => ({ rows: [] }); } }
  };
  delete require.cache[require.resolve('../db')];
}

function buildShareApp({ invoiceRow }) {
  stubDbPg();
  require.cache[require.resolve('../db')] = {
    id: require.resolve('../db'), filename: require.resolve('../db'),
    loaded: true,
    exports: {
      pool: { query: async () => ({ rows: [] }) },
      db: {
        async getInvoiceByPublicToken(token) {
          if (!/^[a-f0-9]{8,32}$/i.test(token || '')) return null;
          return invoiceRow;
        }
      }
    }
  };
  delete require.cache[require.resolve('../routes/share')];
  delete require.cache[require.resolve('../lib/public-invoice-og')];
  const shareRoutes = require('../routes/share');
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', VIEWS);
  app.use('/', shareRoutes);
  return app;
}

function getPath(app, urlPath) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      http.get({ hostname: '127.0.0.1', port, path: urlPath }, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => server.close(() => resolve({ status: res.statusCode, body: data })));
      }).on('error', (e) => { server.close(); reject(e); });
    });
  });
}

function buildInvoice(overrides) {
  return Object.assign({
    id: 5,
    invoice_number: 'INV-2026-0042',
    client_name: 'Acme Co.',
    client_email: 'pay@acme.com',
    client_address: '',
    items: [{ description: 'Design consultation', quantity: 4, unit_price: 75 }],
    subtotal: 300, tax_rate: 0, tax_amount: 0, total: 300, notes: null,
    status: 'sent',
    issued_date: new Date('2026-05-01T00:00:00Z'),
    due_date: new Date('2026-05-31T00:00:00Z'),
    payment_link_url: null,
    public_token: 'cafef00ddeadbeef',
    owner_id: 11,
    owner_name: 'Jordan Pine',
    owner_email: 'jordan@example.com',
    owner_business_name: 'Pine Studio',
    owner_business_address: '123 Maple St',
    owner_business_email: 'hi@pinestudio.com',
    owner_business_phone: '555-0100',
    owner_plan: 'pro'
  }, overrides || {});
}

function extractMeta(html, kind, value) {
  // kind is 'property' or 'name'
  const re = new RegExp(
    `<meta\\s+${kind}="${value}"\\s+content="([^"]*)"`, 'i'
  );
  const m = html.match(re);
  return m ? m[1] : null;
}

// ---------- lib/public-invoice-og pure-function tests --------------------

function testBuildTitleContainsNumberBusinessAmount() {
  delete require.cache[require.resolve('../lib/public-invoice-og')];
  const { buildPublicInvoiceOg } = require('../lib/public-invoice-og');
  const og = buildPublicInvoiceOg(buildInvoice(), {
    now: new Date('2026-05-10T00:00:00Z')
  });
  assert.ok(og && og.title,
    'pure helper returns a non-empty title for a normal invoice');
  assert.ok(og.title.includes('INV-2026-0042'),
    'title must include the invoice number');
  assert.ok(og.title.includes('Pine Studio'),
    'title must include the owner business name (who the invoice is from)');
  assert.ok(og.title.includes('$300.00'),
    'title must include the formatted total');
  assert.ok(/from Pine Studio/i.test(og.title),
    'title pivots on "from <business>" so the client sees who is asking');
}

function testBuildTitleFallsBackToOwnerNameWhenNoBusiness() {
  delete require.cache[require.resolve('../lib/public-invoice-og')];
  const { buildPublicInvoiceOg } = require('../lib/public-invoice-og');
  const og = buildPublicInvoiceOg(buildInvoice({
    owner_business_name: '   '
  }), { now: new Date('2026-05-10T00:00:00Z') });
  assert.ok(og.title.includes('Jordan Pine'),
    'title falls back to owner_name when business_name is blank');
  assert.ok(!/from\s+\s/.test(og.title),
    'title must not double-space when only one name source resolves');
}

function testBuildTitleFallsBackGracefullyWhenAllOwnerLabelsMissing() {
  delete require.cache[require.resolve('../lib/public-invoice-og')];
  const { buildPublicInvoiceOg } = require('../lib/public-invoice-og');
  const og = buildPublicInvoiceOg(buildInvoice({
    owner_business_name: null,
    owner_name: null
  }));
  assert.ok(og.title.startsWith('Invoice INV-2026-0042'),
    'no business → title still leads with "Invoice <num>"');
  assert.ok(!og.title.includes('from'),
    'no "from " segment is rendered when no sender label resolves');
}

function testBuildTitleOmitsAmountWhenInvalid() {
  delete require.cache[require.resolve('../lib/public-invoice-og')];
  const { buildPublicInvoiceOg } = require('../lib/public-invoice-og');
  const og = buildPublicInvoiceOg(buildInvoice({ total: 'not-a-number' }));
  assert.ok(!og.title.includes('NaN'), 'no NaN leak in title');
  assert.ok(!og.title.includes('—'), 'no dangling em-dash separator');
}

function testBuildTitleOmitsNumberWhenMissing() {
  delete require.cache[require.resolve('../lib/public-invoice-og')];
  const { buildPublicInvoiceOg } = require('../lib/public-invoice-og');
  const og = buildPublicInvoiceOg(buildInvoice({ invoice_number: null }));
  assert.ok(og.title.startsWith('Invoice from Pine Studio'),
    'no number → title leads with generic "Invoice from <business>"');
}

function testBuildDescriptionIncludesDueDateForOnTimeSent() {
  delete require.cache[require.resolve('../lib/public-invoice-og')];
  const { buildPublicInvoiceOg } = require('../lib/public-invoice-og');
  const og = buildPublicInvoiceOg(buildInvoice(), {
    now: new Date('2026-05-10T00:00:00Z')
  });
  assert.ok(og.description.includes('May 31, 2026'),
    'description must surface the due date in long form so it works in every locale');
  assert.ok(/Tap to view and pay/.test(og.description),
    'description must include the action-oriented "Tap to view and pay"');
  assert.ok(og.description.includes('$300.00'),
    'description must include the amount so the client knows the cost at a glance');
}

function testBuildDescriptionForOverdueInvoice() {
  delete require.cache[require.resolve('../lib/public-invoice-og')];
  const { buildPublicInvoiceOg } = require('../lib/public-invoice-og');
  // due 2026-05-31, now 2026-06-15 → 15 days overdue
  const og = buildPublicInvoiceOg(buildInvoice({ status: 'overdue' }), {
    now: new Date('2026-06-15T00:00:00Z')
  });
  assert.ok(/overdue/i.test(og.description),
    'overdue invoices must call that out in the preview tile');
  assert.ok(og.description.includes('$300.00'),
    'overdue tile still surfaces the amount');
  assert.ok(!og.description.includes('May 31, 2026'),
    'overdue copy does not need to name the original due date — the urgency cue is enough');
}

function testBuildDescriptionForPaidInvoice() {
  delete require.cache[require.resolve('../lib/public-invoice-og')];
  const { buildPublicInvoiceOg } = require('../lib/public-invoice-og');
  const og = buildPublicInvoiceOg(buildInvoice({ status: 'paid' }));
  assert.ok(/Paid/.test(og.description),
    'paid invoices preview as "Paid" — no more pay CTA in the tile');
  assert.ok(og.description.includes('$300.00'),
    'paid tile still names the amount');
  assert.ok(/receipt/i.test(og.description),
    'paid tile invites the client to "view the receipt"');
}

function testBuildDescriptionForNoDueDate() {
  delete require.cache[require.resolve('../lib/public-invoice-og')];
  const { buildPublicInvoiceOg } = require('../lib/public-invoice-og');
  const og = buildPublicInvoiceOg(buildInvoice({ due_date: null }));
  assert.ok(/Tap to view and pay/.test(og.description),
    'no due date still gets a useful CTA description');
  assert.ok(!og.description.includes('Due'),
    'no due date → no "Due X" prefix');
  assert.ok(!og.description.includes('overdue'),
    'no due date is NOT the same as overdue');
}

function testBuildOmitsClientNameForPrivacy() {
  delete require.cache[require.resolve('../lib/public-invoice-og')];
  const { buildPublicInvoiceOg } = require('../lib/public-invoice-og');
  const og = buildPublicInvoiceOg(buildInvoice({
    client_name: 'Sensitive Client Name LLC'
  }));
  assert.ok(!og.title.includes('Sensitive'),
    'client_name MUST NOT appear in og:title — link previews render on the sender\'s device chain');
  assert.ok(!og.description.includes('Sensitive'),
    'client_name MUST NOT appear in og:description either');
}

function testBuildReturnsNullForFalsyInvoice() {
  delete require.cache[require.resolve('../lib/public-invoice-og')];
  const { buildPublicInvoiceOg } = require('../lib/public-invoice-og');
  assert.strictEqual(buildPublicInvoiceOg(null), null);
  assert.strictEqual(buildPublicInvoiceOg(undefined), null);
  assert.strictEqual(buildPublicInvoiceOg('string'), null);
}

function testBuildDueDateUsesUtcSlotsNotLocalTimezone() {
  delete require.cache[require.resolve('../lib/public-invoice-og')];
  const { buildPublicInvoiceOg } = require('../lib/public-invoice-og');
  // 2026-05-31T00:00:00Z formatted in EDT (UTC-4) without UTC slots
  // would read "May 30, 2026". The helper must lock to UTC.
  const og = buildPublicInvoiceOg(buildInvoice({
    due_date: new Date('2026-05-31T00:00:00Z')
  }), { now: new Date('2026-05-10T00:00:00Z') });
  assert.ok(og.description.includes('May 31, 2026'),
    'due-date format must be timezone-stable on UTC slots');
}

// ---------- GET /i/:token integration tests ------------------------------

async function testRouteRendersInvoiceSpecificOgTitle() {
  process.env.APP_URL = 'https://decentinvoice.com';
  const app = buildShareApp({ invoiceRow: buildInvoice() });
  const r = await getPath(app, '/i/cafef00ddeadbeef');
  assert.strictEqual(r.status, 200);
  const ogTitle = extractMeta(r.body, 'property', 'og:title');
  assert.ok(ogTitle,
    'GET /i/<token> must render an og:title meta tag');
  assert.ok(ogTitle.includes('INV-2026-0042'),
    'og:title must surface the invoice number, not the default SaaS copy');
  assert.ok(ogTitle.includes('Pine Studio'),
    'og:title must surface the sender business name');
  assert.ok(!ogTitle.includes('Professional invoices for freelancers'),
    'og:title MUST NOT fall back to the default DecentInvoice marketing copy');
  delete process.env.APP_URL;
}

async function testRouteRendersInvoiceSpecificOgDescription() {
  process.env.APP_URL = 'https://decentinvoice.com';
  const app = buildShareApp({ invoiceRow: buildInvoice() });
  const r = await getPath(app, '/i/cafef00ddeadbeef');
  const ogDesc = extractMeta(r.body, 'property', 'og:description');
  assert.ok(ogDesc, 'og:description meta tag must render');
  assert.ok(/Tap to view and pay/.test(ogDesc),
    'og:description must invite the recipient to act');
  assert.ok(!/Send invoices freelancers can pay/.test(ogDesc),
    'og:description MUST NOT fall back to the default DecentInvoice marketing copy');
  delete process.env.APP_URL;
}

async function testRouteRendersOgUrlAsAbsoluteShareUrl() {
  process.env.APP_URL = 'https://decentinvoice.com';
  const app = buildShareApp({ invoiceRow: buildInvoice() });
  const r = await getPath(app, '/i/cafef00ddeadbeef');
  const ogUrl = extractMeta(r.body, 'property', 'og:url');
  assert.strictEqual(ogUrl, 'https://decentinvoice.com/i/cafef00ddeadbeef',
    'og:url must be the absolute /i/<token> URL — link unfurlers need it');
  delete process.env.APP_URL;
}

async function testRouteTwitterCardMirrorsOg() {
  process.env.APP_URL = 'https://decentinvoice.com';
  const app = buildShareApp({ invoiceRow: buildInvoice() });
  const r = await getPath(app, '/i/cafef00ddeadbeef');
  const tcTitle = extractMeta(r.body, 'name', 'twitter:title');
  const ogTitle = extractMeta(r.body, 'property', 'og:title');
  assert.strictEqual(tcTitle, ogTitle,
    'twitter:title must mirror og:title (head.ejs already does this — locked in for regression)');
  delete process.env.APP_URL;
}

async function testRouteKeepsNoindexOnShareTokenUrl() {
  const app = buildShareApp({ invoiceRow: buildInvoice() });
  const r = await getPath(app, '/i/cafef00ddeadbeef');
  assert.ok(/<meta[^>]*name="robots"[^>]*noindex/i.test(r.body),
    'tokenised /i/<token> URLs must remain noindex — better OG must not leak indexability');
}

async function testRouteHtmlEscapesHostileBusinessName() {
  process.env.APP_URL = 'https://decentinvoice.com';
  const app = buildShareApp({
    invoiceRow: buildInvoice({
      owner_business_name: 'Hostile" /><script>alert(1)</script> Inc'
    })
  });
  const r = await getPath(app, '/i/cafef00ddeadbeef');
  const ogTitle = extractMeta(r.body, 'property', 'og:title');
  assert.ok(ogTitle, 'og:title still renders for hostile business name');
  assert.ok(!r.body.includes('<script>alert(1)</script>'),
    'raw <script> from owner_business_name must never reach the rendered HTML');
  // EJS escapes the quote (as &quot; or &#34;) so the attribute boundary
  // survives — defence against breaking out of the content="..." meta value.
  assert.ok(ogTitle.includes('&quot;') || ogTitle.includes('&#34;'),
    'hostile " from business name must be HTML-attribute-escaped');
  delete process.env.APP_URL;
}

async function testRouteOmitsClientNameFromAllMetaTags() {
  process.env.APP_URL = 'https://decentinvoice.com';
  const app = buildShareApp({
    invoiceRow: buildInvoice({ client_name: 'Confidential Client Name LLC' })
  });
  const r = await getPath(app, '/i/cafef00ddeadbeef');
  // Grab every og:/twitter:/description meta and assert none carries client_name
  const metaRe = /<meta\s+[^>]*content="([^"]*)"[^>]*>/gi;
  let match;
  while ((match = metaRe.exec(r.body)) !== null) {
    assert.ok(!match[1].includes('Confidential Client Name'),
      `client_name must not appear in any <meta>: leaked into "${match[1]}"`);
  }
  delete process.env.APP_URL;
}

async function testRoutePaidInvoiceFlipsDescriptionToReceipt() {
  process.env.APP_URL = 'https://decentinvoice.com';
  const app = buildShareApp({
    invoiceRow: buildInvoice({ status: 'paid' })
  });
  const r = await getPath(app, '/i/cafef00ddeadbeef');
  const ogDesc = extractMeta(r.body, 'property', 'og:description');
  assert.ok(/Paid/.test(ogDesc),
    'paid invoice preview tile reads "Paid", not "Tap to view and pay"');
  assert.ok(/receipt/i.test(ogDesc),
    'paid tile invites the client to "view the receipt" instead');
  delete process.env.APP_URL;
}

async function testRouteFallsBackOnOgHelperReturningNull() {
  // Deeply hostile invoice with everything stripped — exercise the fallback
  // arms in routes/share.js so we don't 500 if the helper ever returns null
  // for a future edge case.
  process.env.APP_URL = 'https://decentinvoice.com';
  const app = buildShareApp({
    invoiceRow: {
      id: 5,
      invoice_number: 'INV-1',
      client_name: 'X',
      items: [],
      total: 0,
      status: 'sent',
      public_token: 'cafef00ddeadbeef',
      owner_id: 11,
      owner_email: 'x@x.com',
      owner_plan: 'free',
      due_date: null
    }
  });
  const r = await getPath(app, '/i/cafef00ddeadbeef');
  assert.strictEqual(r.status, 200,
    'route must still 200 when the invoice has minimal owner fields');
  const ogTitle = extractMeta(r.body, 'property', 'og:title');
  assert.ok(ogTitle && ogTitle.length > 0,
    'og:title still renders something useful even without business_name / owner_name');
  delete process.env.APP_URL;
}

// ---------- runner -------------------------------------------------------

async function run() {
  const tests = [
    testBuildTitleContainsNumberBusinessAmount,
    testBuildTitleFallsBackToOwnerNameWhenNoBusiness,
    testBuildTitleFallsBackGracefullyWhenAllOwnerLabelsMissing,
    testBuildTitleOmitsAmountWhenInvalid,
    testBuildTitleOmitsNumberWhenMissing,
    testBuildDescriptionIncludesDueDateForOnTimeSent,
    testBuildDescriptionForOverdueInvoice,
    testBuildDescriptionForPaidInvoice,
    testBuildDescriptionForNoDueDate,
    testBuildOmitsClientNameForPrivacy,
    testBuildReturnsNullForFalsyInvoice,
    testBuildDueDateUsesUtcSlotsNotLocalTimezone,
    testRouteRendersInvoiceSpecificOgTitle,
    testRouteRendersInvoiceSpecificOgDescription,
    testRouteRendersOgUrlAsAbsoluteShareUrl,
    testRouteTwitterCardMirrorsOg,
    testRouteKeepsNoindexOnShareTokenUrl,
    testRouteHtmlEscapesHostileBusinessName,
    testRouteOmitsClientNameFromAllMetaTags,
    testRoutePaidInvoiceFlipsDescriptionToReceipt,
    testRouteFallsBackOnOgHelperReturningNull
  ];
  let failed = 0;
  for (const t of tests) {
    try {
      await t();
      origConsoleError(`✓ ${t.name}`);
    } catch (err) {
      failed++;
      origConsoleError(`✗ ${t.name}`);
      origConsoleError(err && err.stack || err);
    }
  }
  if (failed > 0) {
    origConsoleError(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  origConsoleError(`\nAll ${tests.length} public-invoice-og tests passed.`);
}

run();
