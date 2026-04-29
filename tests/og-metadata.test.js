'use strict';

/*
 * Tests for Open Graph + Twitter Card metadata (INTERNAL_TODO #36).
 *
 * Verifies:
 *   - default OG meta tags render on every view that includes partials/head.ejs
 *   - per-page locals (ogTitle / ogDescription / ogPath / ogType) override defaults
 *   - APP_URL env var is correctly prefixed onto og:url and og:image
 *   - APP_URL with trailing slash does not produce double-slash URLs
 *   - missing APP_URL still renders without crashing (relative-fallback property)
 *   - all 6 niche landing pages emit niche-specific og:title and og:description
 *   - twitter:card is "summary_large_image" so previews render large
 *   - public/og-image.png exists at the expected path
 *
 * Run: node tests/og-metadata.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');

const VIEWS = path.join(__dirname, '..', 'views');
const HEAD_TEMPLATE = path.join(VIEWS, 'partials', 'head.ejs');

const landingRoutes = require('../routes/landing');

function renderHead(locals) {
  return ejs.renderFile(HEAD_TEMPLATE, { title: 't', ...locals }, { views: [VIEWS] });
}

function extractMeta(html, attr, value) {
  // Match <meta name|property="X" content="...">
  const re = new RegExp(`<meta\\s+(?:property|name)="${value}"\\s+content="([^"]*)"`, 'i');
  const m = html.match(re);
  return m ? m[1] : null;
}

async function testDefaultsRender() {
  delete process.env.APP_URL;
  const html = await renderHead({});
  assert.ok(html.includes('property="og:title"'), 'og:title meta must render');
  assert.ok(html.includes('property="og:description"'), 'og:description meta must render');
  assert.ok(html.includes('property="og:image"'), 'og:image meta must render');
  assert.ok(html.includes('property="og:url"'), 'og:url meta must render');
  assert.ok(html.includes('property="og:type"'), 'og:type meta must render');
  assert.ok(html.includes('name="twitter:card"'), 'twitter:card meta must render');
  assert.ok(html.includes('name="twitter:image"'), 'twitter:image meta must render');
  // Defaults
  assert.ok(extractMeta(html, 'property', 'og:title').includes('DecentInvoice'),
    'default og:title must mention DecentInvoice');
  assert.strictEqual(extractMeta(html, 'name', 'twitter:card'), 'summary_large_image',
    'twitter:card must be summary_large_image for big previews');
  assert.strictEqual(extractMeta(html, 'property', 'og:type'), 'website',
    'default og:type is website');
}

async function testDescriptionMetaRenders() {
  delete process.env.APP_URL;
  const html = await renderHead({});
  assert.ok(html.includes('name="description"'),
    'standard meta description tag must render for SEO');
  const desc = extractMeta(html, 'name', 'description');
  assert.ok(desc && desc.length > 20, 'meta description must be non-trivial');
}

async function testPerPageLocalsOverride() {
  delete process.env.APP_URL;
  const html = await renderHead({
    ogTitle: 'Custom title for this page',
    ogDescription: 'Custom description for this page',
    ogPath: '/custom-path',
    ogType: 'article'
  });
  assert.strictEqual(extractMeta(html, 'property', 'og:title'), 'Custom title for this page');
  assert.strictEqual(extractMeta(html, 'property', 'og:description'), 'Custom description for this page');
  assert.strictEqual(extractMeta(html, 'property', 'og:type'), 'article');
  assert.strictEqual(extractMeta(html, 'name', 'twitter:title'), 'Custom title for this page',
    'twitter:title mirrors og:title');
  assert.strictEqual(extractMeta(html, 'name', 'twitter:description'), 'Custom description for this page',
    'twitter:description mirrors og:description');
  assert.ok(extractMeta(html, 'property', 'og:url').endsWith('/custom-path'),
    'og:url must include the per-page path');
}

async function testAppUrlPrefix() {
  process.env.APP_URL = 'https://decentinvoice.com';
  try {
    const html = await renderHead({ ogPath: '/billing/upgrade' });
    assert.strictEqual(extractMeta(html, 'property', 'og:url'), 'https://decentinvoice.com/billing/upgrade');
    assert.strictEqual(extractMeta(html, 'property', 'og:image'), 'https://decentinvoice.com/og-image.png');
    assert.strictEqual(extractMeta(html, 'name', 'twitter:image'), 'https://decentinvoice.com/og-image.png');
  } finally {
    delete process.env.APP_URL;
  }
}

async function testAppUrlTrailingSlashNormalised() {
  process.env.APP_URL = 'https://decentinvoice.com/';
  try {
    const html = await renderHead({ ogPath: '/' });
    const url = extractMeta(html, 'property', 'og:url');
    assert.ok(!url.includes('//', 'https://'.length),
      'trailing slash on APP_URL must not produce a double slash in og:url');
    assert.strictEqual(url, 'https://decentinvoice.com/');
  } finally {
    delete process.env.APP_URL;
  }
}

async function testAbsoluteOgImageNotRewritten() {
  process.env.APP_URL = 'https://decentinvoice.com';
  try {
    const html = await renderHead({ ogImage: 'https://cdn.example.com/custom-og.png' });
    assert.strictEqual(extractMeta(html, 'property', 'og:image'), 'https://cdn.example.com/custom-og.png',
      'absolute ogImage URL must pass through unchanged');
  } finally {
    delete process.env.APP_URL;
  }
}

async function testNicheLandingPagesEmitOgMeta() {
  delete process.env.APP_URL;
  const niches = landingRoutes.listNiches();
  assert.ok(niches.length >= 6, 'expected at least 6 niche landing pages');

  for (const { slug, url } of niches) {
    const niche = landingRoutes.NICHES[slug];
    // Build the locals the route would pass.
    const locals = {
      title: niche.title,
      nicheHeadline: niche.headline,
      nicheDescription: niche.description,
      nicheSubheadline: niche.subheadline,
      nicheAudience: niche.audience,
      nicheSingular: niche.singular,
      nicheBenefits: niche.benefits,
      nicheFaq: niche.faq,
      exampleInvoice: niche.exampleInvoice,
      screenshotAlt: 'x',
      ogTitle: niche.headline,
      ogDescription: niche.description,
      ogPath: url,
      ogType: 'article',
      user: null
    };
    const html = await ejs.renderFile(
      path.join(VIEWS, 'partials', 'lp-niche.ejs'),
      locals,
      { views: [VIEWS] }
    );
    assert.strictEqual(extractMeta(html, 'property', 'og:title'), niche.headline,
      `niche ${slug} must emit its headline as og:title`);
    assert.strictEqual(extractMeta(html, 'property', 'og:description'), niche.description,
      `niche ${slug} must emit its description as og:description`);
    assert.strictEqual(extractMeta(html, 'property', 'og:type'), 'article',
      `niche ${slug} should be og:type article`);
    assert.ok(extractMeta(html, 'property', 'og:url').endsWith(url),
      `niche ${slug} og:url must end with its public path ${url}`);
  }
}

function testOgImageFileExists() {
  const ogPath = path.join(__dirname, '..', 'public', 'og-image.png');
  assert.ok(fs.existsSync(ogPath), 'public/og-image.png must exist (Master replaces with branded asset)');
  const stat = fs.statSync(ogPath);
  assert.ok(stat.size > 100, 'og-image.png must be a real PNG, not an empty placeholder');
  // Verify PNG magic bytes
  const fd = fs.openSync(ogPath, 'r');
  const buf = Buffer.alloc(8);
  fs.readSync(fd, buf, 0, 8, 0);
  fs.closeSync(fd);
  assert.deepStrictEqual(buf.slice(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    'og-image.png must have valid PNG magic bytes');
}

async function testIndexRouteSetsOgLocals() {
  // Re-render index.ejs with the same locals server.js passes for /
  delete process.env.APP_URL;
  const html = await ejs.renderFile(path.join(VIEWS, 'index.ejs'), {
    title: 'DecentInvoice — Get Paid Faster',
    ogTitle: 'DecentInvoice — Professional invoices in 60 seconds',
    ogDescription: 'Send invoices freelancers can pay in one click. Free to start, $12/mo for Pro. 7-day free trial, no credit card.',
    ogPath: '/',
    user: null
  }, { views: [VIEWS] });
  assert.ok(extractMeta(html, 'property', 'og:title').includes('60 seconds'),
    'homepage og:title must use the per-page override');
  assert.ok(extractMeta(html, 'property', 'og:description').includes('one click'),
    'homepage og:description must use the per-page override');
}

async function testPricingRouteSetsOgLocals() {
  delete process.env.APP_URL;
  const html = await ejs.renderFile(path.join(VIEWS, 'pricing.ejs'), {
    title: 'Upgrade to Pro',
    flash: null,
    user: null,
    csrfToken: 'tkn',
    ogTitle: 'DecentInvoice Pro — Unlimited invoices, payment links, $12/mo',
    ogDescription: 'Upgrade to Pro for unlimited invoices, Stripe payment links, automated reminders, and custom branding. 7-day free trial, no credit card.',
    ogPath: '/billing/upgrade'
  }, { views: [VIEWS] });
  assert.ok(extractMeta(html, 'property', 'og:title').includes('Pro'),
    'pricing og:title must reference Pro');
  assert.ok(extractMeta(html, 'property', 'og:description').includes('Stripe payment links'),
    'pricing og:description must mention key Pro features');
}

async function run() {
  const tests = [
    ['default OG/Twitter meta render with sensible defaults', testDefaultsRender],
    ['standard meta description renders', testDescriptionMetaRenders],
    ['per-page locals override defaults', testPerPageLocalsOverride],
    ['APP_URL is prefixed onto og:url and og:image', testAppUrlPrefix],
    ['APP_URL trailing slash is normalised', testAppUrlTrailingSlashNormalised],
    ['absolute ogImage URL is not rewritten', testAbsoluteOgImageNotRewritten],
    ['niche landing pages emit niche-specific OG meta', testNicheLandingPagesEmitOgMeta],
    ['public/og-image.png exists with valid PNG magic', testOgImageFileExists],
    ['/ route sets per-page OG locals', testIndexRouteSetsOgLocals],
    ['/billing/upgrade route sets per-page OG locals', testPricingRouteSetsOgLocals]
  ];
  let pass = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log('  ✓', name);
      pass++;
    } catch (err) {
      console.error('  ✗', name);
      console.error(err);
      process.exitCode = 1;
    }
  }
  console.log(`\nog-metadata.test.js: ${pass}/${tests.length} passed`);
}

run();
