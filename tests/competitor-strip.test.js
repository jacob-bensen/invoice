'use strict';

/*
 * Tests for the side-by-side competitor pricing strip (#108).
 *
 * The strip renders on:
 *   - /                  (homepage `index.ejs`, public)
 *   - /billing/upgrade   (authed `pricing.ejs`)
 *
 * Coverage:
 *   - data fixture shape: products list, featureLabels map, every product
 *     carries a Boolean for every labelled feature key
 *   - exactly one row is highlighted (the DecentInvoice row) — the strip
 *     loses its anchor if zero or two rows are highlighted
 *   - the partial renders all product names + feature labels and bolds
 *     the highlighted row
 *   - the partial is a no-op when locals.competitorPricing is missing
 *   - homepage renders the strip section + every competitor name
 *   - the pricing view renders the strip when supplied competitorPricing
 *
 * Run: node tests/competitor-strip.test.js
 */

const assert = require('assert');
const path = require('path');
const ejs = require('ejs');
const http = require('http');
const express = require('express');

const { getCompetitorPricing, getFeatureKeys } = require('../lib/competitor-pricing');

const VIEWS = path.join(__dirname, '..', 'views');
const STRIP_TEMPLATE = path.join(VIEWS, 'partials', 'competitor-strip.ejs');

function renderStrip(locals) {
  return ejs.renderFile(STRIP_TEMPLATE, { ...locals }, { views: [VIEWS] });
}

function request(app, method, url) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const req = http.request({ hostname: '127.0.0.1', port, path: url, method }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => server.close(() => resolve({ status: res.statusCode, body: data })));
      });
      req.on('error', (err) => { server.close(); reject(err); });
      req.end();
    });
  });
}

// ---------- Data shape tests ------------------------------------------------

function testFixtureHasFiveProducts() {
  const data = getCompetitorPricing();
  assert.ok(Array.isArray(data.products), 'products must be an array');
  assert.ok(data.products.length >= 4,
    'comparison must include DecentInvoice + at least 3 competitors to be useful');
}

function testEveryProductHasMonthlyPriceAndFreeTierNote() {
  const data = getCompetitorPricing();
  for (const p of data.products) {
    assert.strictEqual(typeof p.name, 'string', `${p.name} must have a string name`);
    assert.strictEqual(typeof p.monthlyPrice, 'number',
      `${p.name} must declare a numeric monthlyPrice`);
    assert.ok(p.monthlyPrice >= 0, `${p.name} monthlyPrice must be non-negative`);
    assert.strictEqual(typeof p.freeTierNote, 'string',
      `${p.name} must declare a freeTierNote string`);
  }
}

function testEveryProductCoversEveryFeatureKey() {
  // Defensive against silent regressions where a competitor row is added
  // without filling in one of the feature keys — the table would render
  // "undefined → ✕" which is misleading. Forcing every product to declare
  // every key catches it at test time.
  const data = getCompetitorPricing();
  const keys = getFeatureKeys();
  assert.ok(keys.length >= 3, 'at least 3 feature columns expected');
  for (const p of data.products) {
    for (const k of keys) {
      assert.strictEqual(typeof p.features[k], 'boolean',
        `${p.name} must declare a boolean for feature "${k}", got ${typeof p.features[k]}`);
    }
  }
}

function testExactlyOneHighlightedRow() {
  const data = getCompetitorPricing();
  const highlighted = data.products.filter((p) => p.highlight === true);
  assert.strictEqual(highlighted.length, 1,
    `exactly one product must be highlighted (the DecentInvoice row); got ${highlighted.length}`);
  assert.ok(/decentinvoice/i.test(highlighted[0].name),
    `the highlighted row must be DecentInvoice, got "${highlighted[0].name}"`);
}

function testDecentInvoiceCheaperOrEqualToEveryCompetitor() {
  // The whole point of the strip is the price-anchor. If a future fixture
  // bump made a competitor cheaper than DecentInvoice Pro, the strip would
  // argue against the conversion event it's meant to support.
  const data = getCompetitorPricing();
  const us = data.products.find((p) => p.highlight);
  for (const p of data.products) {
    if (p === us) continue;
    assert.ok(us.monthlyPrice <= p.monthlyPrice,
      `DecentInvoice ($${us.monthlyPrice}/mo) must be <= ${p.name} ($${p.monthlyPrice}/mo)`);
  }
}

// ---------- Partial render tests --------------------------------------------

async function testStripRendersAllProductsAndLabels() {
  const data = getCompetitorPricing();
  const html = await renderStrip({ competitorPricing: data });
  for (const p of data.products) {
    assert.ok(html.includes(p.name), `rendered strip must include "${p.name}"`);
  }
  for (const label of Object.values(data.featureLabels)) {
    assert.ok(html.includes(label),
      `rendered strip must include feature label "${label}"`);
  }
  // Highlighted row carries the "You're here" anchor badge.
  assert.ok(/You're here/.test(html),
    'highlighted row must carry the "You\'re here" badge');
}

async function testStripRendersDisclaimer() {
  const data = getCompetitorPricing();
  const html = await renderStrip({ competitorPricing: data });
  assert.ok(html.includes('Trademarks'),
    'disclaimer must reference trademarks to avoid TM ambiguity');
}

async function testStripIsNoopWithoutData() {
  const html = await renderStrip({});
  assert.strictEqual(html.trim(), '',
    'strip must render to empty when no competitorPricing local is supplied');
}

async function testStripIsNoopWithEmptyProducts() {
  const html = await renderStrip({ competitorPricing: { products: [], featureLabels: {} } });
  assert.strictEqual(html.trim(), '',
    'strip must render to empty when products array is empty');
}

async function testStripRendersOneTablePerInvocation() {
  const data = getCompetitorPricing();
  const html = await renderStrip({ competitorPricing: data });
  const tableCount = (html.match(/<table/g) || []).length;
  assert.strictEqual(tableCount, 1,
    `strip must render exactly one <table>, got ${tableCount}`);
}

// ---------- HTTP integration: homepage --------------------------------------

async function testHomepageRendersCompetitorStrip() {
  // Spin up a minimal app mirroring server.js#GET '/' so the test confirms
  // the locals wiring (server.js → index.ejs → partials/competitor-strip)
  // is correct end-to-end without booting the full server (DB/cron).
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', VIEWS);
  app.use((req, res, next) => { res.locals.user = null; next(); });
  app.get('/', (req, res) => {
    res.render('index', {
      title: 'DecentInvoice — Get Paid Faster',
      competitorPricing: getCompetitorPricing(),
      ogTitle: 'DecentInvoice — Professional invoices in 60 seconds',
      ogDescription: 'desc',
      ogPath: '/'
    });
  });

  const res = await request(app, 'GET', '/');
  assert.strictEqual(res.status, 200, `/ must render 200, got ${res.status}`);
  assert.ok(res.body.includes('id="competitor-pricing-heading"'),
    'homepage must include the competitor-strip section heading anchor');
  for (const p of getCompetitorPricing().products) {
    assert.ok(res.body.includes(p.name),
      `homepage must include competitor "${p.name}"`);
  }
}

// ---------- HTTP integration: pricing view ----------------------------------

async function testPricingViewRendersCompetitorStrip() {
  // Skip user/csrfToken wiring — pricing.ejs reads locals.flash + locals.user
  // + locals.csrfToken with `locals.` fallback. Render directly.
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', VIEWS);
  app.use((req, res, next) => {
    res.locals.user = null;
    res.locals.trialCountdown = null;
    next();
  });
  app.get('/billing/upgrade', (req, res) => {
    res.render('pricing', {
      title: 'Upgrade to Pro',
      competitorPricing: getCompetitorPricing(),
      ogTitle: 't',
      ogDescription: 'd',
      ogPath: '/billing/upgrade'
    });
  });

  const res = await request(app, 'GET', '/billing/upgrade');
  assert.strictEqual(res.status, 200, `/billing/upgrade must render 200, got ${res.status}`);
  assert.ok(res.body.includes('id="competitor-pricing-heading"'),
    'pricing page must include the competitor-strip section heading anchor');
  assert.ok(res.body.includes('How we compare'),
    'pricing page must include the strip headline');
}

// ---------- Runner ----------------------------------------------------------

async function run() {
  const tests = [
    ['fixture has DecentInvoice + at least 3 competitors', testFixtureHasFiveProducts],
    ['every product carries monthlyPrice + freeTierNote', testEveryProductHasMonthlyPriceAndFreeTierNote],
    ['every product covers every feature key with a boolean', testEveryProductCoversEveryFeatureKey],
    ['exactly one row is highlighted (DecentInvoice)', testExactlyOneHighlightedRow],
    ['DecentInvoice is the cheapest row', testDecentInvoiceCheaperOrEqualToEveryCompetitor],
    ['partial renders every product name + feature label', testStripRendersAllProductsAndLabels],
    ['partial renders the trademark disclaimer', testStripRendersDisclaimer],
    ['partial is a no-op without competitorPricing local', testStripIsNoopWithoutData],
    ['partial is a no-op with empty products array', testStripIsNoopWithEmptyProducts],
    ['partial renders exactly one <table>', testStripRendersOneTablePerInvocation],
    ['/ homepage embeds the competitor strip', testHomepageRendersCompetitorStrip],
    ['/billing/upgrade pricing view embeds the competitor strip', testPricingViewRendersCompetitorStrip]
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
  console.log(`\ncompetitor-strip.test.js: ${passed}/${tests.length} passed`);
}

run();
