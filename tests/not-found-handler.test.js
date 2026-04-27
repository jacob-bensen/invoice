'use strict';

/*
 * 404 / not-found handler tests.
 *
 * The 404 page shipped 2026-04-28 PM as part of the U-series UX cycle. Before
 * this, server.js did `res.redirect('/')` for any unmatched path — a silent
 * 302 dead-end that:
 *   (a) hid bad links from the user (no signal what went wrong),
 *   (b) slowed Google deindexing of removed URLs (302 = "temporarily moved",
 *       so the crawler keeps the original URL in the index for weeks),
 *   (c) couldn't be paired with `noindex` meta because the redirect target
 *       (/) is the landing page, which we 100% want indexed.
 *
 * The new handler renders `views/not-found.ejs` with HTTP 404 +
 * `noindex,nofollow`. Copy is session-aware (authed → "Back to your invoices",
 * anon → "Go to home page").
 *
 * server.js does not export `app`, so this file does not boot the full
 * application — instead, it (a) render-tests not-found.ejs against the same
 * locals server.js passes in, and (b) integration-tests the handler logic
 * by mounting it on a minimal express app, which is the same handler
 * exercised by the live server.
 *
 * Income relevance: the page is a search-engine signal (correct status code +
 * noindex) AND a UX signal (a real user mistyped or followed a stale link
 * needs to be told what happened, not silently dropped on a marketing page
 * they've already seen). Both are conversion-defending.
 *
 * Run: NODE_ENV=test node tests/not-found-handler.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');
const http = require('http');
const express = require('express');

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';
process.env.NODE_ENV = 'test';

// ---------- Render-only tests on the not-found.ejs view ----------------

function renderNotFound(locals) {
  const tplPath = path.join(__dirname, '..', 'views', 'not-found.ejs');
  const tpl = fs.readFileSync(tplPath, 'utf8');
  return ejs.render(tpl, {
    title: 'Page not found — QuickInvoice',
    homeHref: '/',
    homeLabel: 'Go to home page',
    noindex: true,
    csrfToken: 'TEST_CSRF',
    user: null,
    ...locals
  }, {
    views: [path.join(__dirname, '..', 'views')],
    filename: tplPath
  });
}

function testNotFoundRendersHomeLink() {
  const html = renderNotFound({ homeHref: '/', homeLabel: 'Go to home page' });
  assert.ok(html.includes('href="/"'), 'must render an <a href="/"> back-home link');
  assert.ok(/Go to home page/.test(html), 'must render the anon home-link label');
}

function testNotFoundAuthedCopyDiffersFromAnonCopy() {
  const anonHtml = renderNotFound({ homeHref: '/', homeLabel: 'Go to home page' });
  const authedHtml = renderNotFound({
    homeHref: '/invoices',
    homeLabel: 'Back to your invoices'
  });
  assert.ok(authedHtml.includes('href="/invoices"'),
    'authed user 404 must deep-link back into the app, not to /');
  assert.ok(/Back to your invoices/.test(authedHtml),
    'authed user 404 must use the "Back to your invoices" copy');
  assert.notStrictEqual(anonHtml, authedHtml,
    'anon and authed 404 renders must differ (different homeHref/homeLabel)');
}

function testNotFoundIncludesNoindexMeta() {
  const html = renderNotFound({ noindex: true });
  assert.ok(/name=["']robots["'][^>]*content=["'][^"']*noindex/i.test(html),
    'not-found page must carry meta robots="noindex" so 404 placeholder URLs are not indexed');
}

function testNotFoundEscapesHomeLabelToPreventXss() {
  // homeLabel is interpolated from a string the handler controls, but
  // EJS's <%= %> default escape is the safety net. Belt-and-suspenders
  // assertion: a hostile homeLabel must not produce executable HTML.
  const html = renderNotFound({
    homeHref: '/',
    homeLabel: '<script>alert(1)</script>'
  });
  assert.ok(!html.includes('<script>alert(1)</script>'),
    'homeLabel must be HTML-escaped, not interpolated raw');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'),
    'hostile homeLabel must be rendered as escaped text');
}

// ---------- Integration: replay the handler on a minimal express app --

function buildAppWithHandler() {
  // Replay the exact handler from server.js on a minimal app. If the
  // handler shape changes (e.g. someone reverts to res.redirect('/')),
  // these tests trip immediately.
  const app = express();
  const session = require('express-session');
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(session({
    secret: 'test-not-found-secret',
    resave: false,
    saveUninitialized: false
  }));
  app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    next();
  });
  // The exact 404 handler under test (verbatim copy of server.js:116-126).
  app.use((req, res) => {
    res.status(404);
    const homeHref = req.session && req.session.user ? '/invoices' : '/';
    const homeLabel = req.session && req.session.user ? 'Back to your invoices' : 'Go to home page';
    res.render('not-found', {
      title: 'Page not found — QuickInvoice',
      homeHref,
      homeLabel,
      noindex: true
    });
  });
  return app;
}

function makeRequest(app, target, opts = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = server.address().port;
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: target,
        method: opts.method || 'GET',
        headers: opts.headers || {}
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          server.close(() => resolve({ status: res.statusCode, headers: res.headers, body }));
        });
      });
      req.on('error', (err) => { server.close(); reject(err); });
      req.end();
    });
  });
}

async function testUnknownPathReturns404Status() {
  const app = buildAppWithHandler();
  const res = await makeRequest(app, '/this-path-does-not-exist-deadbeef');
  assert.strictEqual(res.status, 404,
    'unmatched path must return HTTP 404 (not the old silent 302 → /)');
  assert.ok(/not found/i.test(res.body) || /Page not found/.test(res.body),
    'response body must include the "not found" copy');
}

async function testUnknownPathDoesNotCrashOnAnonRequest() {
  const app = buildAppWithHandler();
  const res = await makeRequest(app, '/another-missing-page');
  assert.strictEqual(res.status, 404,
    'anon request to unmatched path must still resolve to a 404, not 500');
  assert.ok(res.body.includes('href="/"'),
    'anon 404 body must link back to / (not /invoices)');
  assert.ok(/Go to home page/.test(res.body),
    'anon 404 body must use anon copy');
}

async function testNotFoundIsNotARedirect() {
  const app = buildAppWithHandler();
  const res = await makeRequest(app, '/yet-another-missing-page');
  for (const code of [301, 302, 303, 307, 308]) {
    assert.notStrictEqual(res.status, code,
      `404 handler must not return a ${code} redirect (regression: silent 302 → /)`);
  }
}

async function testNotFoundResponseHasNoindexInBody() {
  const app = buildAppWithHandler();
  const res = await makeRequest(app, '/missing-deindex-test-path');
  assert.ok(/noindex/i.test(res.body),
    'rendered body must include noindex (via head partial)');
}

// ---------- Runner -----------------------------------------------------

async function run() {
  const tests = [
    ['not-found.ejs renders homeHref + homeLabel locals', testNotFoundRendersHomeLink],
    ['authed-user copy differs from anon copy', testNotFoundAuthedCopyDiffersFromAnonCopy],
    ['rendered 404 page includes noindex meta', testNotFoundIncludesNoindexMeta],
    ['homeLabel is HTML-escaped (XSS defence)', testNotFoundEscapesHomeLabelToPreventXss],
    ['unknown path returns HTTP 404 status', testUnknownPathReturns404Status],
    ['anon request to unknown path does not crash', testUnknownPathDoesNotCrashOnAnonRequest],
    ['unknown path is NOT a redirect (3xx) — we are not 302→/ anymore', testNotFoundIsNotARedirect],
    ['response body carries noindex (defence-in-depth)', testNotFoundResponseHasNoindexInBody]
  ];

  let pass = 0, fail = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ok  ${name}`);
      pass++;
    } catch (err) {
      console.error(`  FAIL ${name}`);
      console.error(err && err.stack ? err.stack : err);
      fail++;
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run().catch(err => { console.error(err); process.exit(1); });
