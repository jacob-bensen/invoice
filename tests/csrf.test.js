'use strict';

/*
 * CSRF middleware tests.
 *
 * Verifies the double-submit synchronizer-token pattern in
 * middleware/csrf.js: state-changing POST requests without a matching
 * token are rejected with 403; GETs receive and expose a token via
 * res.locals.csrfToken; POSTs with the matching token pass; the Stripe
 * webhook path is exempt.
 *
 * Run: node tests/csrf.test.js
 */

const assert = require('assert');
const express = require('express');
const session = require('express-session');
const http = require('http');

const { csrfProtection } = require('../middleware/csrf');

// ---------- HTTP helpers ------------------------------------------------

function request(app, method, url, body, cookieJar, extraHeaders) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const payload = body ? new URLSearchParams(body).toString() : '';
      const headers = Object.assign({}, extraHeaders || {});
      if (payload) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        headers['Content-Length'] = Buffer.byteLength(payload);
      }
      if (cookieJar && cookieJar.cookie) headers['Cookie'] = cookieJar.cookie;

      const req = http.request({ hostname: '127.0.0.1', port, path: url, method, headers }, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          if (res.headers['set-cookie']) {
            if (cookieJar) cookieJar.cookie = res.headers['set-cookie'][0].split(';')[0];
          }
          server.close(() => resolve({ status: res.statusCode, headers: res.headers, body: data }));
        });
      });
      req.on('error', err => { server.close(); reject(err); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

// ---------- App builder -------------------------------------------------

function buildApp() {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(session({ secret: 'csrf-test-secret', resave: false, saveUninitialized: false }));
  app.use(csrfProtection);

  // GET route exposes the session token so tests can read it.
  app.get('/token', (req, res) => res.json({ token: res.locals.csrfToken || null }));

  // Generic protected POST endpoint.
  app.post('/protected', (req, res) => res.status(200).send('ok'));

  // Stripe webhook path — must be fully exempt.
  app.post('/billing/webhook', (req, res) => res.status(200).send('webhook-ok'));

  return app;
}

// ---------- Tests -------------------------------------------------------

async function testGetDoesNotRequireToken() {
  const app = buildApp();
  const res = await request(app, 'GET', '/token');
  assert.strictEqual(res.status, 200, 'GET must succeed without a token');
  const { token } = JSON.parse(res.body);
  assert.ok(typeof token === 'string' && token.length >= 32,
    'GET must populate res.locals.csrfToken with a non-trivial random string');
}

async function testPostWithoutTokenIsRejected() {
  const app = buildApp();
  const jar = { cookie: null };
  // First hit a GET so a session + token are created.
  await request(app, 'GET', '/token', null, jar);
  const res = await request(app, 'POST', '/protected', { foo: 'bar' }, jar);
  assert.strictEqual(res.status, 403, 'POST without _csrf must be rejected');
  assert.ok(res.body.toLowerCase().includes('csrf'),
    'rejection body should mention CSRF');
}

async function testPostWithWrongTokenIsRejected() {
  const app = buildApp();
  const jar = { cookie: null };
  await request(app, 'GET', '/token', null, jar);
  const res = await request(app, 'POST', '/protected',
    { _csrf: 'definitely-not-the-real-token', foo: 'bar' }, jar);
  assert.strictEqual(res.status, 403, 'POST with wrong _csrf must be rejected');
}

async function testPostWithCorrectTokenPasses() {
  const app = buildApp();
  const jar = { cookie: null };
  const tokenRes = await request(app, 'GET', '/token', null, jar);
  const { token } = JSON.parse(tokenRes.body);
  assert.ok(token, 'token must be present');
  const res = await request(app, 'POST', '/protected', { _csrf: token, foo: 'bar' }, jar);
  assert.strictEqual(res.status, 200, 'POST with matching _csrf must succeed');
  assert.strictEqual(res.body, 'ok');
}

async function testPostWithTokenViaHeader() {
  const app = buildApp();
  const jar = { cookie: null };
  const tokenRes = await request(app, 'GET', '/token', null, jar);
  const { token } = JSON.parse(tokenRes.body);
  const res = await request(app, 'POST', '/protected', { foo: 'bar' }, jar,
    { 'X-CSRF-Token': token });
  assert.strictEqual(res.status, 200, 'POST with matching X-CSRF-Token header must succeed');
}

async function testStripeWebhookPathIsExempt() {
  const app = buildApp();
  // No session, no token, no cookies — Stripe's webhook path must still POST successfully.
  const res = await request(app, 'POST', '/billing/webhook', { any: 'payload' });
  assert.strictEqual(res.status, 200, 'Stripe webhook path must bypass CSRF');
  assert.strictEqual(res.body, 'webhook-ok');
}

async function testTokenIsStableWithinSession() {
  const app = buildApp();
  const jar = { cookie: null };
  const first = JSON.parse((await request(app, 'GET', '/token', null, jar)).body).token;
  const second = JSON.parse((await request(app, 'GET', '/token', null, jar)).body).token;
  assert.strictEqual(first, second, 'token must not rotate on every request');
}

async function testTokensAreUniquePerSession() {
  const app = buildApp();
  const jar1 = { cookie: null };
  const jar2 = { cookie: null };
  const t1 = JSON.parse((await request(app, 'GET', '/token', null, jar1)).body).token;
  const t2 = JSON.parse((await request(app, 'GET', '/token', null, jar2)).body).token;
  assert.notStrictEqual(t1, t2, 'two fresh sessions must receive distinct tokens');
}

async function testCrossSessionTokenReuseIsRejected() {
  const app = buildApp();
  const victimJar = { cookie: null };
  const attackerJar = { cookie: null };
  // Attacker learns their own token somehow (not the victim's).
  const attackerToken = JSON.parse(
    (await request(app, 'GET', '/token', null, attackerJar)).body
  ).token;
  // Victim is logged in separately.
  await request(app, 'GET', '/token', null, victimJar);
  // CSRF attack: POST against the victim's session, submitting the attacker's token.
  const res = await request(app, 'POST', '/protected',
    { _csrf: attackerToken }, victimJar);
  assert.strictEqual(res.status, 403,
    'token from a different session must not authorize the victim session');
}

// ---------- Runner ------------------------------------------------------

async function run() {
  const tests = [
    ['GET does not require a token', testGetDoesNotRequireToken],
    ['POST without _csrf returns 403', testPostWithoutTokenIsRejected],
    ['POST with wrong _csrf returns 403', testPostWithWrongTokenIsRejected],
    ['POST with correct _csrf body field passes', testPostWithCorrectTokenPasses],
    ['POST with correct X-CSRF-Token header passes', testPostWithTokenViaHeader],
    ['/billing/webhook path is exempt from CSRF', testStripeWebhookPathIsExempt],
    ['Token is stable within a session', testTokenIsStableWithinSession],
    ['Tokens differ between sessions', testTokensAreUniquePerSession],
    ['Token from another session cannot authorize POST', testCrossSessionTokenReuseIsRejected]
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
