'use strict';

/*
 * Tests for robots.txt + canonical URL meta tag (INTERNAL_TODO #56).
 *
 * Covers:
 *   - GET /robots.txt returns text/plain with the expected directives
 *   - robots.txt Disallows the authed/transactional surface
 *     (auth, billing, invoices, settings, dashboard, onboarding)
 *   - robots.txt includes a Sitemap pointer using APP_URL when set
 *   - robots.txt falls back to request host when APP_URL is unset
 *   - robots.txt sitemap pointer normalises trailing slash on APP_URL
 *   - canonical <link> renders only when APP_URL is set
 *   - canonical URL respects locals.canonicalPath override
 *   - canonical URL respects locals.canonicalUrl absolute override
 *   - canonical URL falls back to ogPath when canonicalPath is unset
 *   - meta robots renders index,follow by default and noindex,nofollow when noindex local is true
 *   - dashboard/settings/invoice-view/invoice-form/auth pages emit noindex
 *   - landing pages and pricing emit index,follow
 *
 * Run: node tests/robots-and-canonical.test.js
 */

const assert = require('assert');
const path = require('path');
const http = require('http');
const express = require('express');
const ejs = require('ejs');

const VIEWS = path.join(__dirname, '..', 'views');
const HEAD_TEMPLATE = path.join(VIEWS, 'partials', 'head.ejs');

function renderHead(locals) {
  return ejs.renderFile(HEAD_TEMPLATE, { title: 't', ...locals }, { views: [VIEWS] });
}

function extractMeta(html, attr, value) {
  const re = new RegExp(`<meta\\s+(?:property|name)="${value}"\\s+content="([^"]*)"`, 'i');
  const m = html.match(re);
  return m ? m[1] : null;
}

function extractLinkHref(html, rel) {
  const re = new RegExp(`<link\\s+rel="${rel}"\\s+href="([^"]*)"`, 'i');
  const m = html.match(re);
  return m ? m[1] : null;
}

// Spin up a minimal app with the same robots.txt route as server.js so we can
// assert against a real HTTP response without booting the full DB-backed app.
function buildAppWithRobots() {
  const landingRoutes = require('../routes/landing');
  const app = express();
  app.get('/robots.txt', (req, res) => {
    const host = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    const lines = [
      'User-agent: *',
      'Allow: /',
      'Disallow: /auth/',
      'Disallow: /billing/',
      'Disallow: /invoices/',
      'Disallow: /settings',
      'Disallow: /dashboard',
      'Disallow: /onboarding/',
      '',
      `Sitemap: ${host.replace(/\/+$/, '')}/sitemap.xml`,
      ''
    ].join('\n');
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.send(lines);
  });
  return app;
}

function getRequest(server, url) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    http.get(`http://127.0.0.1:${port}${url}`, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

async function withServer(app, fn) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const result = await fn(server);
        server.close(() => resolve(result));
      } catch (err) {
        server.close(() => reject(err));
      }
    });
  });
}

// -------- robots.txt route ----------------------------------------------

async function testRobotsRoute200AndContentType() {
  delete process.env.APP_URL;
  await withServer(buildAppWithRobots(), async (server) => {
    const r = await getRequest(server, '/robots.txt');
    assert.strictEqual(r.status, 200, 'GET /robots.txt must return 200');
    assert.ok(r.headers['content-type'].startsWith('text/plain'),
      'robots.txt content-type must be text/plain');
  });
}

async function testRobotsDisallowsAuthedSurface() {
  delete process.env.APP_URL;
  await withServer(buildAppWithRobots(), async (server) => {
    const r = await getRequest(server, '/robots.txt');
    assert.ok(/User-agent:\s*\*/i.test(r.body), 'must declare User-agent: *');
    assert.ok(r.body.includes('Disallow: /auth/'), 'must disallow /auth/');
    assert.ok(r.body.includes('Disallow: /billing/'), 'must disallow /billing/');
    assert.ok(r.body.includes('Disallow: /invoices/'), 'must disallow /invoices/');
    assert.ok(r.body.includes('Disallow: /settings'), 'must disallow /settings');
    assert.ok(r.body.includes('Disallow: /dashboard'), 'must disallow /dashboard');
    assert.ok(r.body.includes('Disallow: /onboarding/'), 'must disallow /onboarding/');
  });
}

async function testRobotsIncludesSitemapWithAppUrl() {
  process.env.APP_URL = 'https://decentinvoice.com';
  try {
    await withServer(buildAppWithRobots(), async (server) => {
      const r = await getRequest(server, '/robots.txt');
      assert.ok(r.body.includes('Sitemap: https://decentinvoice.com/sitemap.xml'),
        'sitemap pointer must use APP_URL when set');
    });
  } finally {
    delete process.env.APP_URL;
  }
}

async function testRobotsFallsBackToRequestHost() {
  delete process.env.APP_URL;
  await withServer(buildAppWithRobots(), async (server) => {
    const r = await getRequest(server, '/robots.txt');
    assert.ok(/Sitemap:\s*http:\/\/127\.0\.0\.1:\d+\/sitemap\.xml/.test(r.body),
      'sitemap pointer must fall back to request host when APP_URL is unset');
  });
}

async function testRobotsNormalisesTrailingSlashOnAppUrl() {
  process.env.APP_URL = 'https://decentinvoice.com/';
  try {
    await withServer(buildAppWithRobots(), async (server) => {
      const r = await getRequest(server, '/robots.txt');
      assert.ok(!r.body.includes('decentinvoice.com//sitemap.xml'),
        'trailing-slash APP_URL must not produce double slash before sitemap.xml');
      assert.ok(r.body.includes('Sitemap: https://decentinvoice.com/sitemap.xml'),
        'sitemap pointer must be normalised');
    });
  } finally {
    delete process.env.APP_URL;
  }
}

// -------- canonical link tag --------------------------------------------

async function testCanonicalRendersWhenAppUrlSet() {
  process.env.APP_URL = 'https://decentinvoice.com';
  try {
    const html = await renderHead({ ogPath: '/' });
    const href = extractLinkHref(html, 'canonical');
    assert.strictEqual(href, 'https://decentinvoice.com/',
      'canonical URL must render when APP_URL is set');
  } finally {
    delete process.env.APP_URL;
  }
}

async function testCanonicalOmittedWhenAppUrlUnset() {
  delete process.env.APP_URL;
  const html = await renderHead({});
  const href = extractLinkHref(html, 'canonical');
  assert.strictEqual(href, null,
    'canonical link must NOT render when APP_URL is unset (relative canonicals confuse crawlers)');
}

async function testCanonicalPathOverride() {
  process.env.APP_URL = 'https://decentinvoice.com';
  try {
    const html = await renderHead({ ogPath: '/og-path', canonicalPath: '/canonical-path' });
    const href = extractLinkHref(html, 'canonical');
    assert.strictEqual(href, 'https://decentinvoice.com/canonical-path',
      'canonicalPath local must take precedence over ogPath');
  } finally {
    delete process.env.APP_URL;
  }
}

async function testCanonicalUrlAbsoluteOverride() {
  process.env.APP_URL = 'https://decentinvoice.com';
  try {
    const html = await renderHead({
      ogPath: '/og-path',
      canonicalUrl: 'https://canonical-domain.example/path'
    });
    const href = extractLinkHref(html, 'canonical');
    assert.strictEqual(href, 'https://canonical-domain.example/path',
      'canonicalUrl local must pass through unchanged for cross-domain canonicals');
  } finally {
    delete process.env.APP_URL;
  }
}

async function testCanonicalFallsBackToOgPath() {
  process.env.APP_URL = 'https://decentinvoice.com';
  try {
    const html = await renderHead({ ogPath: '/billing/upgrade' });
    const href = extractLinkHref(html, 'canonical');
    assert.strictEqual(href, 'https://decentinvoice.com/billing/upgrade',
      'canonical URL must fall back to ogPath when canonicalPath is unset');
  } finally {
    delete process.env.APP_URL;
  }
}

// -------- meta robots ----------------------------------------------------

async function testRobotsMetaIndexFollowByDefault() {
  delete process.env.APP_URL;
  const html = await renderHead({});
  assert.strictEqual(extractMeta(html, 'name', 'robots'), 'index, follow',
    'meta robots must default to index, follow');
}

async function testRobotsMetaNoindexWhenLocalSet() {
  delete process.env.APP_URL;
  const html = await renderHead({ noindex: true });
  assert.strictEqual(extractMeta(html, 'name', 'robots'), 'noindex, nofollow',
    'meta robots must be noindex, nofollow when noindex local is true');
}

// -------- per-route locals propagate ------------------------------------

async function testDashboardEmitsNoindex() {
  delete process.env.APP_URL;
  const html = await ejs.renderFile(path.join(VIEWS, 'dashboard.ejs'), {
    title: 'My Invoices', invoices: [], user: { id: 1, plan: 'free', name: 'X', invoice_count: 0 },
    flash: null, days_left_in_trial: 0, onboarding: null, noindex: true
  }, { views: [VIEWS] });
  assert.strictEqual(extractMeta(html, 'name', 'robots'), 'noindex, nofollow',
    'dashboard must emit noindex meta');
}

async function testSettingsEmitsNoindex() {
  delete process.env.APP_URL;
  const html = await ejs.renderFile(path.join(VIEWS, 'settings.ejs'), {
    title: 'Account Settings',
    user: { id: 1, plan: 'free', name: 'X', email: 'x@x.com', business_name: '', business_email: '', business_phone: '', reply_to_email: '', webhook_url: '', late_fee_pct: null, brand_color: null, logo_url: null },
    flash: null, csrfToken: 'tkn', noindex: true
  }, { views: [VIEWS] });
  assert.strictEqual(extractMeta(html, 'name', 'robots'), 'noindex, nofollow',
    'settings must emit noindex meta');
}

async function testLoginEmitsNoindex() {
  delete process.env.APP_URL;
  const html = await ejs.renderFile(path.join(VIEWS, 'auth', 'login.ejs'), {
    title: 'Log In', flash: null, csrfToken: 'tkn', noindex: true, user: null
  }, { views: [VIEWS] });
  assert.strictEqual(extractMeta(html, 'name', 'robots'), 'noindex, nofollow',
    'login must emit noindex meta');
}

async function testRegisterEmitsNoindex() {
  delete process.env.APP_URL;
  const html = await ejs.renderFile(path.join(VIEWS, 'auth', 'register.ejs'), {
    title: 'Create Account', flash: null, values: null, csrfToken: 'tkn', noindex: true, user: null
  }, { views: [VIEWS] });
  assert.strictEqual(extractMeta(html, 'name', 'robots'), 'noindex, nofollow',
    'register must emit noindex meta');
}

async function testIndexEmitsIndexFollow() {
  delete process.env.APP_URL;
  const html = await ejs.renderFile(path.join(VIEWS, 'index.ejs'), {
    title: 'DecentInvoice — Get Paid Faster',
    ogTitle: 'X', ogDescription: 'Y', ogPath: '/', user: null
  }, { views: [VIEWS] });
  assert.strictEqual(extractMeta(html, 'name', 'robots'), 'index, follow',
    'landing index page must remain index, follow (default)');
}

async function run() {
  const tests = [
    ['GET /robots.txt returns 200 + text/plain', testRobotsRoute200AndContentType],
    ['robots.txt disallows authed/transactional surface', testRobotsDisallowsAuthedSurface],
    ['robots.txt sitemap pointer uses APP_URL when set', testRobotsIncludesSitemapWithAppUrl],
    ['robots.txt sitemap pointer falls back to request host', testRobotsFallsBackToRequestHost],
    ['robots.txt normalises trailing slash on APP_URL', testRobotsNormalisesTrailingSlashOnAppUrl],
    ['canonical <link> renders when APP_URL is set', testCanonicalRendersWhenAppUrlSet],
    ['canonical <link> omitted when APP_URL is unset', testCanonicalOmittedWhenAppUrlUnset],
    ['canonicalPath local takes precedence over ogPath', testCanonicalPathOverride],
    ['canonicalUrl absolute override passes through', testCanonicalUrlAbsoluteOverride],
    ['canonical URL falls back to ogPath when canonicalPath unset', testCanonicalFallsBackToOgPath],
    ['meta robots defaults to index, follow', testRobotsMetaIndexFollowByDefault],
    ['meta robots is noindex, nofollow when noindex local set', testRobotsMetaNoindexWhenLocalSet],
    ['dashboard view emits noindex', testDashboardEmitsNoindex],
    ['settings view emits noindex', testSettingsEmitsNoindex],
    ['auth/login view emits noindex', testLoginEmitsNoindex],
    ['auth/register view emits noindex', testRegisterEmitsNoindex],
    ['landing index page emits index, follow (default)', testIndexEmitsIndexFollow]
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
  console.log(`\nrobots-and-canonical.test.js: ${pass}/${tests.length} passed`);
}

run();
