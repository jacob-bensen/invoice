'use strict';

/*
 * Security headers (helmet) middleware tests.
 *
 * Verifies that middleware/security-headers.js:
 *   - Sets the standard helmet header set on every response
 *     (X-Content-Type-Options, X-Frame-Options/CSP frame-ancestors,
 *     Referrer-Policy, X-DNS-Prefetch-Control, etc).
 *   - Sets a Content-Security-Policy that allows the CDNs (Tailwind,
 *     jsDelivr/Alpine) and inline scripts/styles the views actually use.
 *   - Sets Strict-Transport-Security only in production.
 *   - Removes the X-Powered-By disclosure.
 *   - Does not interfere with route handlers (status / body unchanged).
 *
 * Run: node tests/security-headers.test.js
 */

const assert = require('assert');
const express = require('express');
const http = require('http');

function request(app, method, url) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const req = http.request({ hostname: '127.0.0.1', port, path: url, method }, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => server.close(() => resolve({
          status: res.statusCode, headers: res.headers, body: data
        })));
      });
      req.on('error', err => { server.close(); reject(err); });
      req.end();
    });
  });
}

function buildApp() {
  const { securityHeaders } = require('../middleware/security-headers');
  const app = express();
  app.use(securityHeaders());
  app.get('/', (req, res) => res.send('hello'));
  return app;
}

async function testCommonHeaders() {
  const app = buildApp();
  const res = await request(app, 'GET', '/');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body, 'hello');

  assert.strictEqual(res.headers['x-content-type-options'], 'nosniff',
    'X-Content-Type-Options: nosniff is required');
  assert.ok(res.headers['referrer-policy'],
    'Referrer-Policy must be set');
  assert.ok(res.headers['x-dns-prefetch-control'],
    'X-DNS-Prefetch-Control must be set');
  assert.strictEqual(res.headers['x-download-options'], 'noopen',
    'X-Download-Options: noopen is required');
}

async function testFrameProtection() {
  const app = buildApp();
  const res = await request(app, 'GET', '/');
  // Helmet sets both X-Frame-Options (legacy) and CSP frame-ancestors.
  // Either pinning to DENY/none is acceptable; assert at least one is restrictive.
  const xfo = (res.headers['x-frame-options'] || '').toUpperCase();
  const csp = res.headers['content-security-policy'] || '';
  const cspBlocksFrames = /frame-ancestors\s+'none'/.test(csp);
  assert.ok(xfo === 'DENY' || xfo === 'SAMEORIGIN' || cspBlocksFrames,
    `Clickjacking protection missing — XFO=${xfo} CSP=${csp}`);
  assert.ok(cspBlocksFrames, "CSP must include frame-ancestors 'none'");
}

async function testPoweredByHidden() {
  const app = buildApp();
  const res = await request(app, 'GET', '/');
  assert.strictEqual(res.headers['x-powered-by'], undefined,
    'X-Powered-By must not be sent (information disclosure)');
}

async function testCspAllowsTailwindCdn() {
  const app = buildApp();
  const res = await request(app, 'GET', '/');
  const csp = res.headers['content-security-policy'] || '';
  assert.ok(csp.length > 0, 'CSP header must be present');
  assert.ok(/script-src[^;]*cdn\.tailwindcss\.com/.test(csp),
    'CSP script-src must allow https://cdn.tailwindcss.com (Tailwind Play CDN)');
  assert.ok(/style-src[^;]*cdn\.tailwindcss\.com/.test(csp),
    'CSP style-src must allow https://cdn.tailwindcss.com (Tailwind injects style tags at runtime)');
}

async function testCspAllowsJsdelivrAlpine() {
  const app = buildApp();
  const res = await request(app, 'GET', '/');
  const csp = res.headers['content-security-policy'] || '';
  assert.ok(/script-src[^;]*cdn\.jsdelivr\.net/.test(csp),
    'CSP script-src must allow https://cdn.jsdelivr.net (Alpine.js CDN)');
}

async function testCspAllowsInlineForAlpineDirectives() {
  const app = buildApp();
  const res = await request(app, 'GET', '/');
  const csp = res.headers['content-security-policy'] || '';
  // Alpine's @click and inline onclick handlers in views require unsafe-inline
  // for both script-src and script-src-attr.
  assert.ok(/script-src[^;]*'unsafe-inline'/.test(csp),
    "CSP script-src must include 'unsafe-inline' for Alpine x-data + tailwind config block");
  assert.ok(/style-src[^;]*'unsafe-inline'/.test(csp),
    "CSP style-src must include 'unsafe-inline' for Tailwind utility classes injected as style attrs");
}

async function testCspDefaultSrcAndObject() {
  const app = buildApp();
  const res = await request(app, 'GET', '/');
  const csp = res.headers['content-security-policy'] || '';
  assert.ok(/default-src\s+'self'/.test(csp),
    "CSP default-src must be 'self'");
  assert.ok(/object-src\s+'none'/.test(csp),
    "CSP object-src must be 'none' (block legacy plugins)");
  assert.ok(/base-uri\s+'self'/.test(csp),
    "CSP base-uri must be 'self' (prevent <base> tag injection)");
}

async function testHstsOnlyInProduction() {
  delete require.cache[require.resolve('../middleware/security-headers')];
  const original = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'development';
    delete require.cache[require.resolve('../middleware/security-headers')];
    const { securityHeaders } = require('../middleware/security-headers');
    const devApp = express();
    devApp.use(securityHeaders());
    devApp.get('/', (req, res) => res.send('ok'));
    const devRes = await request(devApp, 'GET', '/');
    assert.strictEqual(devRes.headers['strict-transport-security'], undefined,
      'HSTS must NOT be sent in non-production (would brick local http)');

    process.env.NODE_ENV = 'production';
    delete require.cache[require.resolve('../middleware/security-headers')];
    const { securityHeaders: prodHeaders } = require('../middleware/security-headers');
    const prodApp = express();
    prodApp.use(prodHeaders());
    prodApp.get('/', (req, res) => res.send('ok'));
    const prodRes = await request(prodApp, 'GET', '/');
    const hsts = prodRes.headers['strict-transport-security'] || '';
    assert.ok(/max-age=\d+/.test(hsts), `HSTS must be set in production, got: ${hsts}`);
    assert.ok(/includeSubDomains/i.test(hsts),
      'HSTS in production should include includeSubDomains');
  } finally {
    process.env.NODE_ENV = original;
    delete require.cache[require.resolve('../middleware/security-headers')];
  }
}

async function testWiredIntoServerJs() {
  // Smoke test: importing server.js wires the middleware before route mounting
  // so any GET route returns the security headers.
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(src.includes("require('./middleware/security-headers')"),
    'server.js must require middleware/security-headers');
  assert.ok(src.includes('securityHeaders()'),
    'server.js must invoke securityHeaders() as middleware');
  // Sanity: securityHeaders must be installed BEFORE route mounting so all
  // routes (including the static fallback / 404) carry the header set.
  const headerIdx = src.indexOf('securityHeaders()');
  const firstRouteIdx = src.indexOf("app.use('/auth'");
  assert.ok(headerIdx > -1 && firstRouteIdx > -1 && headerIdx < firstRouteIdx,
    'securityHeaders() must be mounted before route handlers');
}

async function run() {
  const tests = [
    ['Common helmet headers (nosniff, referrer-policy, dns-prefetch, download-options)', testCommonHeaders],
    ['Clickjacking protection (X-Frame-Options + CSP frame-ancestors)', testFrameProtection],
    ['X-Powered-By is hidden', testPoweredByHidden],
    ['CSP allows Tailwind CDN for script-src and style-src', testCspAllowsTailwindCdn],
    ['CSP allows jsdelivr (Alpine.js)', testCspAllowsJsdelivrAlpine],
    ["CSP includes 'unsafe-inline' for inline Alpine handlers", testCspAllowsInlineForAlpineDirectives],
    ['CSP locks default-src/object-src/base-uri', testCspDefaultSrcAndObject],
    ['HSTS only set in production', testHstsOnlyInProduction],
    ['server.js wires securityHeaders before route mounting', testWiredIntoServerJs]
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
