'use strict';

/*
 * Tests for legal pages scaffolding (#28) — Terms / Privacy / Refund + the
 * shared footer partial that links them from every authed page.
 *
 * Stripe ToS hard requirement: Terms / Privacy / Refund must be reachable
 * from the checkout flow. Without these pages live, Stripe Risk can reject
 * the funnel as it scales. The pages also unblock GDPR (Privacy Policy)
 * and card-network refund-policy requirements.
 *
 * Run: node tests/legal-pages.test.js
 */

const assert = require('assert');
const path = require('path');
const express = require('express');
const http = require('http');
const ejs = require('ejs');

const landingRoutes = require('../routes/landing');

const VIEWS = path.join(__dirname, '..', 'views');

function buildApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', VIEWS);
  app.use((req, res, next) => { res.locals.user = null; res.locals.trialCountdown = null; next(); });
  app.use('/', landingRoutes);
  return app;
}

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

const LEGAL_PATHS = ['/terms', '/privacy', '/refund'];

async function testEachLegalPageReturns200() {
  const app = buildApp();
  for (const url of LEGAL_PATHS) {
    const res = await request(app, 'GET', url);
    assert.strictEqual(res.status, 200, `${url} must return 200, got ${res.status}`);
    assert.ok(res.body.length > 500, `${url} must render a full HTML page (got ${res.body.length} bytes)`);
  }
}

async function testTermsPageCoversRequiredSections() {
  const app = buildApp();
  const res = await request(app, 'GET', '/terms');
  const lc = res.body.toLowerCase();
  assert.ok(lc.includes('terms of service'), 'terms must have the heading');
  assert.ok(lc.includes('subscription') || lc.includes('billing'), 'terms must mention billing/subscription');
  assert.ok(lc.includes('cancel'), 'terms must mention cancellation');
  assert.ok(lc.includes('acceptable use'), 'terms must mention acceptable use');
  assert.ok(lc.includes('liability'), 'terms must include a liability section');
  assert.ok(lc.includes('disclaimer') || lc.includes('warranties'), 'terms must include a warranty disclaimer');
}

async function testPrivacyPageCoversGdprRequirements() {
  const app = buildApp();
  const res = await request(app, 'GET', '/privacy');
  const lc = res.body.toLowerCase();
  assert.ok(lc.includes('privacy policy'), 'privacy must have the heading');
  assert.ok(lc.includes('gdpr') || lc.includes('ccpa'), 'privacy must mention GDPR/CCPA');
  assert.ok(lc.includes('what we collect') || lc.includes('data we collect'), 'privacy must describe what is collected');
  assert.ok(lc.includes('stripe'), 'privacy must disclose Stripe as a processor');
  assert.ok(lc.includes('delet') || lc.includes('forgotten'), 'privacy must mention right to deletion');
  assert.ok(lc.includes('access') && lc.includes('correct'), 'privacy must mention access + correction rights');
  assert.ok(lc.includes('cookie'), 'privacy must address cookies');
}

async function testRefundPageCoversRequiredCases() {
  const app = buildApp();
  const res = await request(app, 'GET', '/refund');
  const lc = res.body.toLowerCase();
  assert.ok(lc.includes('refund'), 'refund page must mention refunds');
  assert.ok(lc.includes('cancel'), 'refund page must mention cancellation');
  assert.ok(lc.includes('trial'), 'refund page must address the trial');
  assert.ok(/14[\s-]?day/.test(lc) || /14 days/.test(lc), 'refund page must state a refund window (e.g. 14 days)');
  assert.ok(lc.includes('chargeback') || lc.includes('dispute'), 'refund page must address disputes/chargebacks');
}

async function testEachLegalPageRendersNavAndFooter() {
  const app = buildApp();
  for (const url of LEGAL_PATHS) {
    const res = await request(app, 'GET', url);
    assert.ok(res.body.includes('<nav'), `${url} must include the nav partial`);
    assert.ok(res.body.includes('data-testid="legal-footer"'), `${url} must include the legal-footer partial`);
  }
}

async function testFooterLinksAreReachable() {
  const app = buildApp();
  const res = await request(app, 'GET', '/terms');
  assert.ok(res.body.includes('href="/terms"'), 'footer must link to /terms');
  assert.ok(res.body.includes('href="/privacy"'), 'footer must link to /privacy');
  assert.ok(res.body.includes('href="/refund"'), 'footer must link to /refund');
}

async function testLegalPagesAreIndexable() {
  const app = buildApp();
  for (const url of LEGAL_PATHS) {
    const res = await request(app, 'GET', url);
    assert.ok(!/<meta[^>]*name="robots"[^>]*noindex/i.test(res.body),
      `${url} must be indexable (no noindex meta)`);
    assert.ok(/<meta[^>]*name="robots"[^>]*index, follow/i.test(res.body),
      `${url} must explicitly opt into indexing`);
  }
}

async function testLegalPagesCarryLastUpdated() {
  const app = buildApp();
  for (const url of LEGAL_PATHS) {
    const res = await request(app, 'GET', url);
    assert.ok(/Last updated:\s*\d{4}-\d{2}-\d{2}/.test(res.body),
      `${url} must display an ISO "Last updated:" date`);
  }
}

async function testFooterPartialRendersFromEjsDirect() {
  // Regression guard against the partial being moved or accidentally renamed.
  const html = await ejs.renderFile(path.join(VIEWS, 'partials', 'footer.ejs'), {}, { views: [VIEWS] });
  assert.ok(html.includes('data-testid="legal-footer"'));
  assert.ok(html.includes('href="/terms"'));
  assert.ok(html.includes('href="/privacy"'));
  assert.ok(html.includes('href="/refund"'));
}

async function testRegisterPageMentionsLegalAgreement() {
  // GDPR / consumer-protection: account creation must surface a link to the
  // Terms + Privacy the user is accepting. Sign-up is the moment of consent.
  const html = await ejs.renderFile(path.join(VIEWS, 'auth', 'register.ejs'), {
    title: 'Create Account', flash: null, values: null, csrfToken: 'tkn', user: null, trialCountdown: null
  }, { views: [VIEWS] });
  assert.ok(html.includes('href="/terms"'), 'register page must link to Terms');
  assert.ok(html.includes('href="/privacy"'), 'register page must link to Privacy');
}

async function testListLegalPagesExportsAllThree() {
  const list = landingRoutes.listLegalPages();
  const paths = list.map((p) => p.path).sort();
  assert.deepStrictEqual(paths, ['/privacy', '/refund', '/terms'],
    'listLegalPages must expose all three legal routes for sitemap');
}

async function testUnknownLegalPath404s() {
  const app = buildApp();
  app.use((req, res) => res.status(404).send('not found'));
  const res = await request(app, 'GET', '/legal/imaginary');
  assert.strictEqual(res.status, 404, 'unknown legal subpath must 404');
}

async function run() {
  const tests = [
    ['each legal page returns 200', testEachLegalPageReturns200],
    ['terms page covers required sections', testTermsPageCoversRequiredSections],
    ['privacy page covers GDPR/CCPA requirements', testPrivacyPageCoversGdprRequirements],
    ['refund page covers required cases', testRefundPageCoversRequiredCases],
    ['each legal page renders nav + footer partials', testEachLegalPageRendersNavAndFooter],
    ['footer links are reachable from each legal page', testFooterLinksAreReachable],
    ['legal pages opt into search indexing', testLegalPagesAreIndexable],
    ['legal pages carry a Last updated date', testLegalPagesCarryLastUpdated],
    ['footer partial renders standalone', testFooterPartialRendersFromEjsDirect],
    ['register page surfaces legal agreement', testRegisterPageMentionsLegalAgreement],
    ['listLegalPages exports all three routes', testListLegalPagesExportsAllThree],
    ['unknown legal subpath 404s', testUnknownLegalPath404s]
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
  console.log(`\nlegal-pages.test.js: ${passed}/${tests.length} passed`);
}

run();
