'use strict';

/*
 * Tests for SEO niche landing pages + sitemap (INTERNAL_TODO #8).
 *
 * Covers:
 *   - 6 niche routes render 200 with niche-specific copy
 *   - each route includes the register CTA pointing at /auth/register
 *   - each route includes the nav partial + "DecentInvoice" brand
 *   - niche headlines are distinct (no accidental copy reuse)
 *   - /sitemap.xml returns XML with all 6 niche URLs + core pages
 *   - /sitemap.xml sets Content-Type: application/xml
 *   - missing / unknown niche slug 404s → redirects to / (matches server 404 handler)
 *   - lp-niche partial renders from EJS directly with supplied locals
 *
 * No DB, no Stripe — routes are pure EJS render.
 *
 * Run: node tests/landing.test.js
 */

const assert = require('assert');
const path = require('path');
const express = require('express');
const http = require('http');
const ejs = require('ejs');

const landingRoutes = require('../routes/landing');

// ---------- App builder -------------------------------------------------

function buildApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: true }));
  // Emulate server.js locals middleware — landing routes don't require a
  // session, but nav.ejs reads res.locals.user.
  app.use((req, res, next) => { res.locals.user = null; next(); });

  app.use('/', landingRoutes);

  app.get('/sitemap.xml', (req, res) => {
    const host = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    const lastmod = new Date().toISOString().split('T')[0];
    const staticUrls = ['/', '/auth/register', '/auth/login'];
    const nicheUrls = landingRoutes.listNiches().map((n) => n.url);
    const urls = [...staticUrls, ...nicheUrls].map((p) => {
      const priority = p === '/' ? '1.0' : '0.8';
      return `  <url>\n    <loc>${host}${p}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>${priority}</priority>\n  </url>`;
    }).join('\n');
    res.set('Content-Type', 'application/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
  });

  // Match server.js 404 → redirect to /
  app.use((req, res) => res.status(404).redirect('/'));

  return app;
}

// ---------- HTTP helper -------------------------------------------------

function request(app, method, url) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const req = http.request({ hostname: '127.0.0.1', port, path: url, method }, res => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => {
          server.close(() => resolve({ status: res.statusCode, headers: res.headers, body: data }));
        });
      });
      req.on('error', err => { server.close(); reject(err); });
      req.end();
    });
  });
}

// ---------- Expected niche routes ---------------------------------------

const EXPECTED_NICHE_PATHS = [
  '/invoice-template/freelance-designer',
  '/invoice-template/freelance-developer',
  '/invoice-template/freelance-writer',
  '/invoice-template/freelance-photographer',
  '/invoice-template/consultant',
  '/invoice-generator'
];

// ---------- Tests -------------------------------------------------------

async function testAllSixNicheRoutesReturn200() {
  const app = buildApp();
  for (const url of EXPECTED_NICHE_PATHS) {
    const res = await request(app, 'GET', url);
    assert.strictEqual(res.status, 200, `${url} should return 200, got ${res.status}`);
    assert.ok(res.body.length > 500, `${url} should render a full HTML page`);
  }
}

async function testEachNichePageHasRegisterCta() {
  const app = buildApp();
  for (const url of EXPECTED_NICHE_PATHS) {
    const res = await request(app, 'GET', url);
    assert.ok(res.body.includes('/auth/register'),
      `${url} must include a /auth/register CTA link`);
    assert.ok(res.body.toLowerCase().includes('create your first invoice'),
      `${url} must include the "Create your first invoice" CTA copy`);
  }
}

async function testEachNichePageUsesNavAndBranding() {
  const app = buildApp();
  for (const url of EXPECTED_NICHE_PATHS) {
    const res = await request(app, 'GET', url);
    assert.ok(res.body.includes('DecentInvoice'),
      `${url} must include the product name`);
    assert.ok(res.body.includes('<nav'),
      `${url} must include the nav partial`);
  }
}

async function testNicheCopyIsDistinct() {
  // Guard against accidentally rendering the same headline for every niche
  // (copy-paste regression on NICHES map).
  const app = buildApp();
  const headlines = new Set();
  for (const url of EXPECTED_NICHE_PATHS) {
    const res = await request(app, 'GET', url);
    // Pull the first <h1>…</h1>
    const m = res.body.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
    assert.ok(m, `${url} must render an <h1>`);
    const headline = m[1].replace(/\s+/g, ' ').trim();
    headlines.add(headline);
  }
  assert.strictEqual(headlines.size, EXPECTED_NICHE_PATHS.length,
    `each niche must have a unique <h1> headline; got ${headlines.size} unique across ${EXPECTED_NICHE_PATHS.length} routes`);
}

async function testDesignerNicheCopy() {
  const app = buildApp();
  const res = await request(app, 'GET', '/invoice-template/freelance-designer');
  assert.ok(res.body.toLowerCase().includes('designer'),
    'designer page must mention designers in copy');
}

async function testDeveloperNicheCopy() {
  const app = buildApp();
  const res = await request(app, 'GET', '/invoice-template/freelance-developer');
  assert.ok(res.body.toLowerCase().includes('developer'),
    'developer page must mention developers');
}

async function testConsultantNicheCopy() {
  const app = buildApp();
  const res = await request(app, 'GET', '/invoice-template/consultant');
  assert.ok(res.body.toLowerCase().includes('consultant'),
    'consultant page must mention consultants');
}

async function testInvoiceGeneratorPage() {
  // Top-level /invoice-generator (no /invoice-template prefix) — the
  // highest-volume search term; must live on its own clean URL.
  const app = buildApp();
  const res = await request(app, 'GET', '/invoice-generator');
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.toLowerCase().includes('invoice generator'),
    'generator page must self-identify');
}

async function testSitemapReturnsXml() {
  const app = buildApp();
  const res = await request(app, 'GET', '/sitemap.xml');
  assert.strictEqual(res.status, 200, 'sitemap must return 200');
  assert.ok(res.headers['content-type'].includes('application/xml'),
    `sitemap must set application/xml content-type, got ${res.headers['content-type']}`);
  assert.ok(res.body.startsWith('<?xml'),
    'sitemap must begin with XML declaration');
  assert.ok(res.body.includes('<urlset'),
    'sitemap must use sitemap.org schema');
}

async function testSitemapIncludesAllNicheUrls() {
  const app = buildApp();
  const res = await request(app, 'GET', '/sitemap.xml');
  for (const url of EXPECTED_NICHE_PATHS) {
    assert.ok(res.body.includes(url),
      `sitemap must include ${url}`);
  }
  assert.ok(res.body.includes('/auth/register'),
    'sitemap must include register page');
}

async function testSitemapEntryHasLastmod() {
  const app = buildApp();
  const res = await request(app, 'GET', '/sitemap.xml');
  // Every <url> must have a <lastmod>
  const urlCount = (res.body.match(/<url>/g) || []).length;
  const lastmodCount = (res.body.match(/<lastmod>/g) || []).length;
  assert.strictEqual(urlCount, lastmodCount,
    'every <url> entry must carry a <lastmod> timestamp');
  assert.ok(/\d{4}-\d{2}-\d{2}/.test(res.body),
    'sitemap must contain ISO date entries');
}

async function testUnknownNicheSlugIs404() {
  const app = buildApp();
  const res = await request(app, 'GET', '/invoice-template/not-a-real-niche');
  // server.js 404 handler redirects to /
  assert.strictEqual(res.status, 302, 'unknown niche slug must hit the 404 → / redirect');
  assert.strictEqual(res.headers.location, '/');
}

async function testListNichesHelper() {
  const list = landingRoutes.listNiches();
  assert.strictEqual(list.length, 6, 'must expose exactly 6 niches');
  const slugs = list.map(n => n.slug).sort();
  assert.deepStrictEqual(slugs, [
    'consultant',
    'freelance-designer',
    'freelance-developer',
    'freelance-photographer',
    'freelance-writer',
    'invoice-generator'
  ]);
  for (const entry of list) {
    assert.ok(entry.url.startsWith('/'), `URL ${entry.url} must be site-relative`);
    assert.ok(entry.title.length > 0, 'each niche must carry a page <title>');
  }
}

async function testPartialRendersWithSuppliedLocals() {
  // Direct-render check of the EJS partial — guards against template crashes
  // when `user` is null (logged-out landing page traffic).
  const VIEWS = path.join(__dirname, '..', 'views');
  const TEMPLATE = path.join(VIEWS, 'partials', 'lp-niche.ejs');
  const html = await ejs.renderFile(TEMPLATE, {
    title: 'test',
    nicheHeadline: 'Test Headline',
    nicheDescription: 'desc',
    nicheSubheadline: 'sub',
    nicheAudience: 'testers',
    nicheSingular: 'tester',
    nicheBenefits: [{ icon: '✅', title: 'B1', body: 'body1' }],
    nicheFaq: [{ q: 'Q?', a: 'A.' }],
    exampleInvoice: {
      businessName: 'Biz', businessTagline: 'tag', clientName: 'Client',
      lineItems: [{ description: 'x', quantity: 1, rate: '10.00', amount: '10.00' }],
      total: '10.00'
    },
    screenshotAlt: 'alt',
    user: null
  }, { views: [VIEWS] });
  assert.ok(html.includes('Test Headline'));
  assert.ok(html.includes('testers'));
  assert.ok(html.includes('Q?'));
  assert.ok(html.includes('A.'));
}

async function testSessionPresentDoesNotCrashLandingPage() {
  // Regression: even when a logged-in user visits a landing URL (e.g. they
  // shared the link with a teammate and follow it back), the nav partial
  // reads `user` off locals; rendering must succeed.
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use((req, res, next) => {
    res.locals.user = { id: 1, plan: 'pro', email: 'pro@x.com', name: 'Pro User' };
    next();
  });
  app.use('/', landingRoutes);

  for (const url of EXPECTED_NICHE_PATHS) {
    const res = await request(app, 'GET', url);
    assert.strictEqual(res.status, 200, `${url} must render for logged-in user, got ${res.status}`);
    // Pro nav badge should appear instead of "Get started free"
    assert.ok(res.body.includes('PRO') || res.body.includes('Invoices'),
      `${url} nav must reflect the logged-in Pro user`);
  }
}

// ---------- Runner ------------------------------------------------------

async function run() {
  const tests = [
    ['all 6 niche routes return 200', testAllSixNicheRoutesReturn200],
    ['each niche has a /auth/register CTA', testEachNichePageHasRegisterCta],
    ['each niche renders nav + DecentInvoice brand', testEachNichePageUsesNavAndBranding],
    ['niche headlines are distinct', testNicheCopyIsDistinct],
    ['designer copy mentions designers', testDesignerNicheCopy],
    ['developer copy mentions developers', testDeveloperNicheCopy],
    ['consultant copy mentions consultants', testConsultantNicheCopy],
    ['invoice-generator page lives at /invoice-generator', testInvoiceGeneratorPage],
    ['/sitemap.xml returns XML', testSitemapReturnsXml],
    ['/sitemap.xml includes every niche URL + register', testSitemapIncludesAllNicheUrls],
    ['/sitemap.xml entries carry <lastmod>', testSitemapEntryHasLastmod],
    ['unknown niche slug redirects to /', testUnknownNicheSlugIs404],
    ['listNiches() exposes all 6 slugs', testListNichesHelper],
    ['lp-niche partial renders with supplied locals', testPartialRendersWithSuppliedLocals],
    ['landing pages render for logged-in users', testSessionPresentDoesNotCrashLandingPage]
  ];

  let passed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ ${name}`);
      console.error(err);
      process.exitCode = 1;
    }
  }
  console.log(`\nlanding.test.js: ${passed}/${tests.length} passed`);
}

run();
