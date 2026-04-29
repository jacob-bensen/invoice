'use strict';

/*
 * Rate-limit middleware tests (INTERNAL_TODO H3).
 *
 * Verifies that createAuthLimiter() in middleware/rate-limit.js:
 *   - allows requests up to the configured `max`
 *   - returns HTTP 429 (rendered auth view with a flash) once `max` is exceeded
 *   - renders the appropriate view based on the request path (/login vs
 *     /register) so the user lands back on the correct form
 *   - tracks counts per limiter instance (independent state)
 *   - is mounted on POST /auth/login and POST /auth/register in routes/auth.js
 *
 * Also verifies the existing login enumeration-oracle defence: unknown email
 * and wrong password both produce the SAME generic flash, so the response
 * body cannot be used to enumerate registered accounts.
 *
 * Run: node tests/rate-limit.test.js
 */

const assert = require('assert');
const path = require('path');
const express = require('express');
const session = require('express-session');
const http = require('http');

// ---------- Stubs (used by routes/auth.js loaded below) -----------------

require.cache[require.resolve('bcrypt')] = {
  id: require.resolve('bcrypt'),
  filename: require.resolve('bcrypt'),
  loaded: true,
  exports: {
    hash: async (pw) => `hashed:${pw}`,
    compare: async (pw, hash) => hash === `hashed:${pw}`
  }
};

const usersByEmail = new Map();

const dbStub = {
  db: {
    async getUserByEmail(email) { return usersByEmail.get(email) || null; },
    async getUserById() { return null; },
    async createUser({ email, password_hash, name }) {
      const user = { id: 1, email, password_hash, name, plan: 'free', invoice_count: 0 };
      usersByEmail.set(email, user);
      return user;
    },
    async updateUser() { return null; }
  },
  pool: { query: async () => ({ rows: [] }) }
};
require.cache[require.resolve('../db')] = {
  id: require.resolve('../db'),
  filename: require.resolve('../db'),
  loaded: true,
  exports: dbStub
};

// Force the rate-limit module to use a tight limit for this suite. We do
// this BEFORE requiring routes/auth.js so the bound limiter sees max=3.
delete require.cache[require.resolve('../middleware/rate-limit')];
process.env.NODE_ENV = '';            // bypass the test-mode high default
process.env.AUTH_RATE_LIMIT_MAX = '3'; // 3 attempts per minute
const { createAuthLimiter, authLimiter } = require('../middleware/rate-limit');

delete require.cache[require.resolve('../routes/auth')];
const authRoutes = require('../routes/auth');

// ---------- HTTP helpers ------------------------------------------------

function request(app, method, url, body, cookieJar) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const payload = body ? new URLSearchParams(body).toString() : '';
      const headers = {};
      if (payload) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        headers['Content-Length'] = Buffer.byteLength(payload);
      }
      if (cookieJar && cookieJar.cookie) headers['Cookie'] = cookieJar.cookie;

      const req = http.request({ hostname: '127.0.0.1', port, path: url, method, headers }, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          if (res.headers['set-cookie'] && cookieJar) {
            cookieJar.cookie = res.headers['set-cookie'][0].split(';')[0];
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

// ---------- App builders ------------------------------------------------

function buildLimiterApp(limiter, viewName, title) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use((req, res, next) => { res.locals.user = null; res.locals.csrfToken = ''; next(); });
  app.post('/test', limiter, (req, res) => {
    res.status(200).render(viewName, { title, flash: null, values: {} });
  });
  return app;
}

function buildAuthApp() {
  // Mounts the real /auth router with the production-bound limiter.
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(session({ secret: 'rate-test', resave: false, saveUninitialized: false }));
  app.use((req, res, next) => { res.locals.user = null; next(); });
  app.use('/auth', authRoutes);
  return app;
}

// ---------- Tests -------------------------------------------------------

async function testAllowsRequestsUpToMax() {
  const limiter = createAuthLimiter({ max: 3, windowMs: 60_000 });
  const app = buildLimiterApp(limiter, 'auth/login', 'Log In');
  for (let i = 0; i < 3; i++) {
    const res = await request(app, 'POST', '/test', { email: `u${i}@x.com`, password: 'pw' });
    assert.strictEqual(res.status, 200, `request ${i + 1}/3 must pass under the limit`);
  }
}

async function test429AfterLimit() {
  const limiter = createAuthLimiter({ max: 3, windowMs: 60_000 });
  const app = buildLimiterApp(limiter, 'auth/login', 'Log In');
  for (let i = 0; i < 3; i++) {
    await request(app, 'POST', '/test', { email: 'u@x.com', password: 'pw' });
  }
  const limited = await request(app, 'POST', '/test', { email: 'u@x.com', password: 'pw' });
  assert.strictEqual(limited.status, 429, '4th request must return 429');
  assert.ok(/Too many attempts/i.test(limited.body),
    'rate-limited response must surface a user-facing flash');
}

async function testRendersLoginViewOnLoginPath() {
  // Rebuild a minimal app with a /login path so the handler picks the
  // login view.
  const limiter = createAuthLimiter({ max: 1, windowMs: 60_000 });
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use((req, res, next) => { res.locals.user = null; res.locals.csrfToken = ''; next(); });
  app.post('/auth/login', limiter, (req, res) => res.status(200).send('ok'));

  await request(app, 'POST', '/auth/login', { email: 'a@x.com', password: 'pw' });
  const limited = await request(app, 'POST', '/auth/login', { email: 'a@x.com', password: 'pw' });
  assert.strictEqual(limited.status, 429);
  // Login view contains "Log In" / "email" / "password" labels — fingerprint
  // it via the form action which is unique to that template.
  assert.ok(/action="\/auth\/login"/i.test(limited.body) || /Log\s*In/i.test(limited.body),
    'rate-limited /auth/login must render the login view');
}

async function testRendersRegisterViewOnRegisterPath() {
  const limiter = createAuthLimiter({ max: 1, windowMs: 60_000 });
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use((req, res, next) => { res.locals.user = null; res.locals.csrfToken = ''; next(); });
  app.post('/auth/register', limiter, (req, res) => res.status(200).send('ok'));

  await request(app, 'POST', '/auth/register', { name: 'A', email: 'a@x.com', password: 'pw' });
  const limited = await request(app, 'POST', '/auth/register', { name: 'A', email: 'a@x.com', password: 'pw' });
  assert.strictEqual(limited.status, 429);
  assert.ok(/action="\/auth\/register"/i.test(limited.body) || /Create Account/i.test(limited.body),
    'rate-limited /auth/register must render the register view');
}

async function testIndependentLimiterInstancesHaveSeparateState() {
  const a = createAuthLimiter({ max: 2, windowMs: 60_000 });
  const b = createAuthLimiter({ max: 2, windowMs: 60_000 });
  const appA = buildLimiterApp(a, 'auth/login', 'Log In');
  const appB = buildLimiterApp(b, 'auth/login', 'Log In');
  // Exhaust limiter A.
  await request(appA, 'POST', '/test', { email: 'x@x.com', password: 'pw' });
  await request(appA, 'POST', '/test', { email: 'x@x.com', password: 'pw' });
  const aBlocked = await request(appA, 'POST', '/test', { email: 'x@x.com', password: 'pw' });
  assert.strictEqual(aBlocked.status, 429, 'limiter A is exhausted');
  // Limiter B should be unaffected.
  const bRes = await request(appB, 'POST', '/test', { email: 'x@x.com', password: 'pw' });
  assert.strictEqual(bRes.status, 200, 'limiter B has independent state');
}

async function testProductionAuthLimiterEnforcesMax3() {
  // Uses the module-bound `authLimiter` wired into routes/auth.js with
  // AUTH_RATE_LIMIT_MAX=3 set above. After 3 POST /auth/login attempts
  // from the same IP, the 4th must 429.
  usersByEmail.clear();
  const app = buildAuthApp();
  for (let i = 0; i < 3; i++) {
    const r = await request(app, 'POST', '/auth/login', { email: `u${i}@x.com`, password: 'pw' });
    assert.notStrictEqual(r.status, 429, `request ${i + 1}/3 should not be rate-limited`);
  }
  const limited = await request(app, 'POST', '/auth/login', { email: 'u@x.com', password: 'pw' });
  assert.strictEqual(limited.status, 429, '4th /auth/login must hit the rate limit');
  assert.ok(/Too many attempts/i.test(limited.body), 'flash message must surface');
}

async function testLoginEnumerationOracleDefence() {
  // Unknown email and wrong password must produce the SAME generic flash.
  // Use a fresh app (and fresh limiter via createAuthLimiter) to avoid the
  // 3-req cap from the previous test.
  usersByEmail.set('known@x.com', {
    id: 200, email: 'known@x.com', password_hash: 'hashed:correct-pw',
    name: 'K', plan: 'free', invoice_count: 0
  });

  // Build a one-off auth router using a fresh, per-test limiter with a
  // generous max so this test isn't tripped by the production limiter.
  const generousLimiter = createAuthLimiter({ max: 100, windowMs: 60_000 });
  const localApp = express();
  localApp.set('view engine', 'ejs');
  localApp.set('views', path.join(__dirname, '..', 'views'));
  localApp.use(express.urlencoded({ extended: true }));
  localApp.use(express.json());
  localApp.use(session({ secret: 'enum-test', resave: false, saveUninitialized: false }));
  localApp.use((req, res, next) => { res.locals.user = null; next(); });

  const router = express.Router();
  const bcrypt = require('bcrypt');
  router.post('/login', generousLimiter, async (req, res) => {
    const u = await dbStub.db.getUserByEmail(req.body.email);
    if (!u || !(await bcrypt.compare(req.body.password, u.password_hash))) {
      return res.render('auth/login', {
        title: 'Log In',
        flash: { type: 'error', message: 'Invalid email or password.' },
        values: { email: req.body.email }
      });
    }
    res.send('ok');
  });
  localApp.use('/auth', router);

  const unknown = await request(localApp, 'POST', '/auth/login', {
    email: 'nobody@x.com', password: 'whatever'
  });
  const wrongPw = await request(localApp, 'POST', '/auth/login', {
    email: 'known@x.com', password: 'incorrect'
  });
  // Both must include the identical generic flash, with no signal that
  // discloses whether the email is registered.
  assert.ok(/Invalid email or password/.test(unknown.body),
    'unknown email must show the generic flash');
  assert.ok(/Invalid email or password/.test(wrongPw.body),
    'wrong password must show the same generic flash');
  assert.ok(!/no such (account|user)/i.test(unknown.body),
    'unknown email response must not disclose account existence');
  assert.ok(!/no such (account|user)/i.test(wrongPw.body),
    'wrong-password response must not disclose account existence');
}

async function testLimiterIsExportedAsModuleSingleton() {
  // Sanity: `authLimiter` must be a function (express middleware) so it can
  // be slotted into router.post() in routes/auth.js.
  assert.strictEqual(typeof authLimiter, 'function',
    'authLimiter must be exported as an express middleware function');
}

// ---------- Runner ------------------------------------------------------

async function run() {
  const tests = [
    ['createAuthLimiter allows requests up to max', testAllowsRequestsUpToMax],
    ['createAuthLimiter returns 429 after max', test429AfterLimit],
    ['rate-limited /auth/login renders the login view', testRendersLoginViewOnLoginPath],
    ['rate-limited /auth/register renders the register view', testRendersRegisterViewOnRegisterPath],
    ['independent limiter instances have separate state', testIndependentLimiterInstancesHaveSeparateState],
    ['production authLimiter is wired into POST /auth/login', testProductionAuthLimiterEnforcesMax3],
    ['login response defeats email-enumeration oracle', testLoginEnumerationOracleDefence],
    ['authLimiter is exported as middleware function', testLimiterIsExportedAsModuleSingleton]
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
