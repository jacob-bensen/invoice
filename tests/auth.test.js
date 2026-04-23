'use strict';

/*
 * Auth route integration tests.
 *
 * Stubs: bcrypt (fast deterministic hashing), ../db (in-memory store).
 * Uses express-session MemoryStore so session cookies persist across
 * sequential requests within a single test.
 *
 * Run: node tests/auth.test.js
 */

const assert = require('assert');
const path = require('path');
const express = require('express');
const session = require('express-session');
const http = require('http');

// ---------- Stubs -------------------------------------------------------

// bcrypt stub: hash(pw) => "hashed:<pw>", compare(pw, hash) => hash === "hashed:<pw>"
require.cache[require.resolve('bcrypt')] = {
  id: require.resolve('bcrypt'),
  filename: require.resolve('bcrypt'),
  loaded: true,
  exports: {
    hash: async (pw) => `hashed:${pw}`,
    compare: async (pw, hash) => hash === `hashed:${pw}`
  }
};

const usersById = new Map();
const usersByEmail = new Map();
let nextId = 100;

function resetStore() {
  usersById.clear();
  usersByEmail.clear();
  nextId = 100;
}

const dbStub = {
  db: {
    async getUserByEmail(email) { return usersByEmail.get(email) || null; },
    async getUserById(id) { return usersById.get(id) || null; },
    async createUser({ email, password_hash, name }) {
      const user = { id: nextId++, email, password_hash, name, plan: 'free', invoice_count: 0 };
      usersById.set(user.id, user);
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

// Load routes after stubs are in place.
function clearReq(mod) { delete require.cache[require.resolve(mod)]; }
clearReq('../routes/auth');
const authRoutes = require('../routes/auth');
clearReq('../middleware/auth');
const { requireAuth } = require('../middleware/auth');

// ---------- App builder -------------------------------------------------

function buildApp(preloadedSessionUser) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  if (preloadedSessionUser !== undefined) {
    app.use((req, _res, next) => { req.session.user = preloadedSessionUser; next(); });
  }
  app.use((req, res, next) => { res.locals.user = req.session.user || null; next(); });
  app.use('/auth', authRoutes);
  app.get('/dashboard', requireAuth, (req, res) => res.send('dashboard'));
  return app;
}

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

// Make sequential requests sharing a session cookie on the same app instance.
async function session_requests(app, steps) {
  const jar = { cookie: null };
  const results = [];
  for (const [method, url, body] of steps) {
    results.push(await request(app, method, url, body, jar));
  }
  return results;
}

// ---------- Tests -------------------------------------------------------

async function testRegisterMissingName() {
  resetStore();
  const app = buildApp();
  const res = await request(app, 'POST', '/auth/register',
    { name: '  ', email: 'a@b.com', password: 'password123' });
  assert.strictEqual(res.status, 200, 'should re-render form on blank name');
  assert.ok(res.body.includes('Name is required'), 'error message must mention name');
}

async function testRegisterInvalidEmail() {
  resetStore();
  const app = buildApp();
  const res = await request(app, 'POST', '/auth/register',
    { name: 'Alice', email: 'notanemail', password: 'password123' });
  assert.strictEqual(res.status, 200, 'should re-render form on bad email');
  assert.ok(res.body.includes('email') || res.body.includes('Email'),
    'error message must mention email');
}

async function testRegisterShortPassword() {
  resetStore();
  const app = buildApp();
  const res = await request(app, 'POST', '/auth/register',
    { name: 'Alice', email: 'a@b.com', password: 'short' });
  assert.strictEqual(res.status, 200, 'should re-render form on short password');
  assert.ok(res.body.includes('8 characters') || res.body.includes('Password'),
    'error message must mention password length');
}

async function testRegisterDuplicateEmail() {
  resetStore();
  usersByEmail.set('taken@x.com', { id: 99, email: 'taken@x.com',
    password_hash: 'hashed:pw', name: 'Existing', plan: 'free', invoice_count: 0 });
  const app = buildApp();
  const res = await request(app, 'POST', '/auth/register',
    { name: 'New', email: 'taken@x.com', password: 'password123' });
  assert.strictEqual(res.status, 200, 'should re-render form on duplicate email');
  assert.ok(res.body.includes('already exists'), 'error message must mention duplicate account');
}

async function testRegisterSuccess() {
  resetStore();
  const app = buildApp();
  const [regRes, dashRes] = await session_requests(app, [
    ['POST', '/auth/register', { name: 'Alice', email: 'alice@x.com', password: 'password123' }],
    ['GET', '/dashboard', null]
  ]);
  assert.strictEqual(regRes.status, 302, 'successful registration should redirect');
  assert.ok(regRes.headers.location.includes('/dashboard'), 'redirect target should be /dashboard');
  assert.strictEqual(dashRes.status, 200, 'session cookie must authenticate subsequent requests');
  const stored = usersByEmail.get('alice@x.com');
  assert.ok(stored, 'user must be persisted');
  assert.strictEqual(stored.name, 'Alice');
  assert.strictEqual(stored.password_hash, 'hashed:password123');
}

async function testLoginWrongPassword() {
  resetStore();
  usersByEmail.set('b@x.com', { id: 101, email: 'b@x.com',
    password_hash: 'hashed:correct-pass', name: 'Bob', plan: 'free', invoice_count: 0 });
  const app = buildApp();
  const res = await request(app, 'POST', '/auth/login',
    { email: 'b@x.com', password: 'wrong-pass' });
  assert.strictEqual(res.status, 200, 'should re-render login on wrong password');
  assert.ok(res.body.includes('Invalid email or password'), 'error message must appear');
}

async function testLoginUnknownEmail() {
  resetStore();
  const app = buildApp();
  const res = await request(app, 'POST', '/auth/login',
    { email: 'nobody@x.com', password: 'anypass123' });
  assert.strictEqual(res.status, 200, 'should re-render login on unknown email');
  assert.ok(res.body.includes('Invalid email or password'), 'error message must appear');
}

async function testLoginSuccess() {
  resetStore();
  usersByEmail.set('c@x.com', { id: 102, email: 'c@x.com',
    password_hash: 'hashed:mypassword1', name: 'Carol', plan: 'free', invoice_count: 0 });
  const app = buildApp();
  const [loginRes, dashRes] = await session_requests(app, [
    ['POST', '/auth/login', { email: 'c@x.com', password: 'mypassword1' }],
    ['GET', '/dashboard', null]
  ]);
  assert.strictEqual(loginRes.status, 302, 'successful login should redirect');
  assert.ok(loginRes.headers.location.includes('/dashboard'), 'redirect must target /dashboard');
  assert.strictEqual(dashRes.status, 200, 'session cookie must authenticate subsequent requests');
}

async function testLogout() {
  resetStore();
  usersByEmail.set('d@x.com', { id: 103, email: 'd@x.com',
    password_hash: 'hashed:pw123', name: 'Dan', plan: 'free', invoice_count: 0 });
  const app = buildApp();
  const [, logoutRes, afterDashRes] = await session_requests(app, [
    ['POST', '/auth/login', { email: 'd@x.com', password: 'pw123' }],
    ['POST', '/auth/logout', {}],
    ['GET', '/dashboard', null]
  ]);
  assert.strictEqual(logoutRes.status, 302, 'logout should redirect');
  assert.strictEqual(logoutRes.headers.location, '/', 'logout redirects to /');
  // After logout the session is destroyed; /dashboard must redirect to login.
  assert.strictEqual(afterDashRes.status, 302, 'protected route must redirect after logout');
  assert.ok(afterDashRes.headers.location.includes('/auth/login'),
    'post-logout redirect should be to /auth/login');
}

async function testRedirectIfAuthOnLogin() {
  resetStore();
  const app = buildApp({ id: 1, plan: 'free', name: 'U', email: 'u@x.com' });
  const res = await request(app, 'GET', '/auth/login');
  assert.strictEqual(res.status, 302, 'authenticated user visiting /login must redirect');
  assert.ok(res.headers.location.includes('/dashboard'), 'must redirect to /dashboard');
}

async function testRedirectIfAuthOnRegister() {
  resetStore();
  const app = buildApp({ id: 1, plan: 'free', name: 'U', email: 'u@x.com' });
  const res = await request(app, 'GET', '/auth/register');
  assert.strictEqual(res.status, 302, 'authenticated user visiting /register must redirect');
  assert.ok(res.headers.location.includes('/dashboard'), 'must redirect to /dashboard');
}

async function testRequireAuthRedirectsUnauthenticated() {
  resetStore();
  const app = buildApp(); // no session user
  const res = await request(app, 'GET', '/dashboard');
  assert.strictEqual(res.status, 302, 'unauthenticated access must redirect');
  assert.ok(res.headers.location.includes('/auth/login'), 'must redirect to /auth/login');
}

// ---------- Runner ------------------------------------------------------

async function run() {
  const tests = [
    ['Register: blank name shows validation error', testRegisterMissingName],
    ['Register: invalid email shows validation error', testRegisterInvalidEmail],
    ['Register: short password shows validation error', testRegisterShortPassword],
    ['Register: duplicate email shows error', testRegisterDuplicateEmail],
    ['Register: success creates session and redirects', testRegisterSuccess],
    ['Login: wrong password shows error', testLoginWrongPassword],
    ['Login: unknown email shows error', testLoginUnknownEmail],
    ['Login: success creates session and redirects', testLoginSuccess],
    ['Logout: destroys session and redirects to /', testLogout],
    ['redirectIfAuth: GET /login redirects authenticated user', testRedirectIfAuthOnLogin],
    ['redirectIfAuth: GET /register redirects authenticated user', testRedirectIfAuthOnRegister],
    ['requireAuth: unauthenticated request redirects to /auth/login', testRequireAuthRedirectsUnauthenticated]
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
