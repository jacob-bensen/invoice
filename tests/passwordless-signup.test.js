'use strict';

/*
 * Passwordless registration tests (Milestone 1 — signup → first dashboard
 * re-entry, applied at the upstream signup-completion gate).
 *
 * The default POST /auth/register flow requires an 8+ character password,
 * which is the most common bounce point at the very top of the activation
 * funnel. POST /auth/register/magic removes the password requirement: the
 * user submits name + email, the server creates the account with an
 * unguessable random password hash, and the welcome email's auto-sign-in
 * CTAs (mintMagicLoginToken baked into lib/welcome.js) are the user's way
 * in. The user can later set a real password via /auth/forgot.
 *
 * Coverage:
 *   - GET /auth/register?mode=magic renders the passwordless form (name +
 *     email only, no password field).
 *   - GET /auth/register renders the password form by default and links to
 *     ?mode=magic for the passwordless path.
 *   - POST /auth/register/magic with valid input creates the user with a
 *     non-empty bcrypt-hashed password, seeds the sample invoice, fires the
 *     welcome email (which carries the magic-login CTA), and renders a
 *     generic "check your inbox" success without authenticating the session.
 *   - POST /auth/register/magic with blank name re-renders the magic form
 *     (not the password form) with the validation error.
 *   - POST /auth/register/magic with invalid email re-renders the magic form
 *     with the validation error.
 *   - POST /auth/register/magic with an email that already has an account
 *     does NOT create a duplicate, fires a magic-login email to the existing
 *     account, and renders the same generic success page — no enumeration.
 *   - Session is NOT authenticated after POST /auth/register/magic; the user
 *     must click the emailed CTA to land authenticated.
 *
 * Run: NODE_ENV=test node tests/passwordless-signup.test.js
 */

const assert = require('assert');
const path = require('path');
const express = require('express');
const session = require('express-session');
const http = require('http');

// ---------- Stubs -------------------------------------------------------

// bcrypt stub: hash(pw) => "hashed:<pw>" — preserves the input so we can
// assert that the random-password branch persists a non-empty hash and that
// the hash is NOT the literal random string (i.e. the bcrypt step ran).
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
const seededFor = [];
const referralAttachCalls = [];
const sourceAttachCalls = [];
let nextId = 500;

function resetStore() {
  usersById.clear();
  usersByEmail.clear();
  seededFor.length = 0;
  referralAttachCalls.length = 0;
  sourceAttachCalls.length = 0;
  nextId = 500;
}

const dbStub = {
  db: {
    async getUserByEmail(email) { return usersByEmail.get(email) || null; },
    async getUserById(id) { return usersById.get(id) || null; },
    async createUser({ email, password_hash, name }) {
      const user = {
        id: nextId++, email, password_hash, name,
        plan: 'free', invoice_count: 0,
        subscription_status: null, trial_ends_at: null
      };
      usersById.set(user.id, user);
      usersByEmail.set(email, user);
      return user;
    },
    async createSeedInvoice({ user_id }) {
      seededFor.push(user_id);
      return { id: 1, is_seed: true };
    },
    async attachReferrerByCode(userId, code) {
      referralAttachCalls.push({ userId, code });
      return null;
    },
    async attachSignupSource(userId, source) {
      sourceAttachCalls.push({ userId, source });
      return null;
    },
    async markWelcomeEmailSent(userId) {
      // Idempotency stamp: first call returns the user row, subsequent
      // calls return null. Matches the prod helper's semantics so the
      // welcome-email orchestrator's `already_sent` branch is exercisable.
      const u = usersById.get(userId);
      if (!u || u.welcome_email_sent_at) return null;
      u.welcome_email_sent_at = new Date();
      return u;
    },
    async createPasswordResetToken(userId, tokenHash, ttlMinutes, kind) {
      // Mint a no-op row so triggerWelcomeEmail's mintMagicLoginToken
      // succeeds (returns a URL) and the welcome-email orchestrator's
      // happy path lands without a Resend round-trip.
      return { id: 1, expires_at: new Date(Date.now() + (ttlMinutes || 30) * 60000), kind: kind || 'reset' };
    }
  },
  pool: { query: async () => ({ rows: [] }) }
};

require.cache[require.resolve('../db')] = {
  id: require.resolve('../db'),
  filename: require.resolve('../db'),
  loaded: true,
  exports: dbStub
};

// Stub the welcome-email orchestrator so we can assert it fired without
// touching Resend / templates. Captures the (db, userId) call args.
const welcomeCalls = [];
require.cache[require.resolve('../lib/welcome')] = {
  id: require.resolve('../lib/welcome'),
  filename: require.resolve('../lib/welcome'),
  loaded: true,
  exports: {
    triggerWelcomeEmail: async (db, userId) => {
      welcomeCalls.push({ userId });
      return { ok: true, id: 'em_w1' };
    }
  }
};

// Stub the magic-login orchestrator so we can assert the existing-email
// branch fires requestMagicLink without sending a real email.
const magicCalls = [];
require.cache[require.resolve('../lib/magic-login')] = {
  id: require.resolve('../lib/magic-login'),
  filename: require.resolve('../lib/magic-login'),
  loaded: true,
  exports: {
    requestMagicLink: async (db, email, opts) => {
      magicCalls.push({ email, opts: opts || null });
      return { ok: true, sent: true };
    },
    // The route imports these too; provide no-op shims for module-load.
    hashToken: () => 'hash',
    safeNextPath: (s) => (typeof s === 'string' && s.startsWith('/')) ? s : null
  }
};

// Stub last-login so the POST /login handler can load without a DB round-trip.
require.cache[require.resolve('../lib/last-login')] = {
  id: require.resolve('../lib/last-login'),
  filename: require.resolve('../lib/last-login'),
  loaded: true,
  exports: { stampLastLogin: async () => null }
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

async function session_requests(app, steps) {
  const jar = { cookie: null };
  const results = [];
  for (const [method, url, body] of steps) {
    results.push(await request(app, method, url, body, jar));
  }
  return results;
}

function resetCallLogs() {
  welcomeCalls.length = 0;
  magicCalls.length = 0;
}

// ---------- Tests -------------------------------------------------------

async function testGetMagicModeRendersPasswordlessForm() {
  resetStore(); resetCallLogs();
  const app = buildApp();
  const res = await request(app, 'GET', '/auth/register?mode=magic');
  assert.strictEqual(res.status, 200, 'GET ?mode=magic must render the form');
  assert.ok(res.body.includes('register-magic-form'),
    'magic mode must render the passwordless form (data-testid present)');
  assert.ok(res.body.includes('/auth/register/magic'),
    'magic form must POST to /auth/register/magic');
  assert.ok(!res.body.includes('name="password"'),
    'magic mode must NOT render a password input');
  assert.ok(/no password/i.test(res.body) || /one[- ]tap/i.test(res.body),
    'magic mode must visibly tell the user no password is required');
}

async function testGetDefaultRendersPasswordForm() {
  resetStore(); resetCallLogs();
  const app = buildApp();
  const res = await request(app, 'GET', '/auth/register');
  assert.strictEqual(res.status, 200, 'GET /register must render the form');
  assert.ok(res.body.includes('name="password"'),
    'default mode must render the password input');
  assert.ok(res.body.includes('action="/auth/register"'),
    'default form must POST to /auth/register');
  assert.ok(res.body.includes('register-switch-to-magic'),
    'default form must surface a passwordless-switch link');
  assert.ok(res.body.includes('mode=magic'),
    'default form must link to ?mode=magic');
}

async function testGetMagicLinksBackToPasswordMode() {
  resetStore(); resetCallLogs();
  const app = buildApp();
  const res = await request(app, 'GET', '/auth/register?mode=magic');
  assert.ok(res.body.includes('register-switch-to-password'),
    'magic mode must surface a switch-back link to the password form');
}

async function testPostMagicCreatesUserAndFiresWelcome() {
  resetStore(); resetCallLogs();
  const app = buildApp();
  const [res] = await session_requests(app, [
    ['POST', '/auth/register/magic', { name: 'Alice', email: 'alice@example.com' }]
  ]);
  assert.strictEqual(res.status, 200, 'success must render (not redirect)');
  assert.ok(res.body.includes('register-magic-success'),
    'success page must render the magic-success block');
  assert.ok(res.body.includes('Check your inbox'),
    'success copy must tell the user to check their inbox');
  assert.ok(res.body.includes('alice@example.com'),
    'success page must surface the submitted email so the user knows where to look');

  // User must exist with a non-empty password hash (NOT NULL satisfied) and
  // the hash must NOT be empty / NOT the literal random bytes.
  const stored = usersByEmail.get('alice@example.com');
  assert.ok(stored, 'user row must be persisted');
  assert.strictEqual(stored.name, 'Alice');
  assert.ok(stored.password_hash && stored.password_hash.length > 0,
    'password_hash must be non-empty to satisfy the NOT NULL schema constraint');
  assert.ok(stored.password_hash.startsWith('hashed:'),
    'password_hash must come from bcrypt.hash (stub prefix proves the bcrypt step ran)');
  // The bcrypt-stubbed string after "hashed:" should be a 64-char hex random
  // value — never the literal user-friendly password.
  const hashed = stored.password_hash.replace(/^hashed:/, '');
  assert.ok(/^[a-f0-9]{64}$/.test(hashed),
    'random password should be a 64-char hex string (32 random bytes)');

  // Seed-invoice + welcome-email must both fire for the new account.
  assert.deepStrictEqual(seededFor, [stored.id],
    'createSeedInvoice must be called for the new user');
  assert.strictEqual(welcomeCalls.length, 1, 'welcome email must fire exactly once');
  assert.strictEqual(welcomeCalls[0].userId, stored.id,
    'welcome email must target the freshly-created user');
  assert.strictEqual(magicCalls.length, 0,
    'magic-link orchestrator must NOT fire on the new-account branch (welcome email already carries the magic CTA)');
}

async function testPostMagicDoesNotAuthenticateSession() {
  resetStore(); resetCallLogs();
  const app = buildApp();
  // Submit the passwordless form then immediately hit a protected route on
  // the same session cookie. The protected route MUST 302 back to login
  // because the passwordless flow requires the user to click the emailed
  // magic link before any session is established.
  const [, dashRes] = await session_requests(app, [
    ['POST', '/auth/register/magic', { name: 'Bob', email: 'bob@example.com' }],
    ['GET', '/dashboard', null]
  ]);
  assert.strictEqual(dashRes.status, 302,
    'session MUST NOT be authenticated by POST /register/magic');
  assert.ok(dashRes.headers.location && dashRes.headers.location.includes('/auth/login'),
    'unauthenticated /dashboard must redirect to /auth/login');
}

async function testPostMagicBlankNameRendersError() {
  resetStore(); resetCallLogs();
  const app = buildApp();
  const res = await request(app, 'POST', '/auth/register/magic',
    { name: '   ', email: 'a@b.com' });
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.includes('Name is required'),
    'blank name must surface the validation error');
  assert.ok(res.body.includes('register-magic-form'),
    'error re-render must stay in the magic form (not bounce to the password form)');
  assert.ok(!res.body.includes('name="password"'),
    'error re-render must not introduce a password field');
  // No user created on validation failure.
  assert.strictEqual(usersByEmail.size, 0);
  assert.strictEqual(welcomeCalls.length, 0);
}

async function testPostMagicInvalidEmailRendersError() {
  resetStore(); resetCallLogs();
  const app = buildApp();
  const res = await request(app, 'POST', '/auth/register/magic',
    { name: 'Carol', email: 'notanemail' });
  assert.strictEqual(res.status, 200);
  assert.ok(/email/i.test(res.body), 'error must mention email');
  assert.ok(res.body.includes('register-magic-form'),
    'error re-render must stay in the magic form');
  assert.strictEqual(usersByEmail.size, 0);
}

async function testPostMagicExistingEmailFiresMagicLinkNotDuplicate() {
  resetStore(); resetCallLogs();
  // Seed an existing account.
  usersByEmail.set('taken@example.com', {
    id: 999, email: 'taken@example.com',
    password_hash: 'hashed:existing', name: 'Existing',
    plan: 'free', invoice_count: 3
  });
  usersById.set(999, usersByEmail.get('taken@example.com'));
  const app = buildApp();
  const res = await request(app, 'POST', '/auth/register/magic',
    { name: 'Imposter', email: 'taken@example.com' });
  assert.strictEqual(res.status, 200,
    'existing-email submit must render the same success page (no error leak)');
  assert.ok(res.body.includes('register-magic-success'),
    'response must be the generic "check your inbox" page — no enumeration');
  assert.ok(res.body.includes('taken@example.com'),
    'success page must echo the submitted email');

  // No new user; existing row unchanged.
  assert.strictEqual(usersById.size, 1, 'no new user row must be created');
  const existing = usersByEmail.get('taken@example.com');
  assert.strictEqual(existing.name, 'Existing',
    'existing user name must NOT be overwritten');
  assert.strictEqual(existing.password_hash, 'hashed:existing',
    'existing user password hash must NOT be rotated');

  // Welcome email must NOT fire (would be wrong for a returning user);
  // magic-link orchestrator MUST fire so the existing user gets a sign-in.
  assert.strictEqual(welcomeCalls.length, 0,
    'welcome email must NOT fire when the email already has an account');
  assert.strictEqual(magicCalls.length, 1, 'magic-link orchestrator must fire once');
  assert.strictEqual(magicCalls[0].email, 'taken@example.com',
    'magic-link must target the submitted email');
}

async function testPostMagicAttributesSignupSourceAndReferral() {
  resetStore(); resetCallLogs();
  // Build an app that pre-seeds the session with a referral_code and
  // signup_source before the auth router runs — same pattern as the
  // server.js first-touch middleware.
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, _res, next) => {
    req.session.referral_code = 'REF123';
    req.session.signup_source = 'producthunt';
    next();
  });
  app.use((req, res, next) => { res.locals.user = req.session.user || null; next(); });
  app.use('/auth', authRoutes);

  const res = await request(app, 'POST', '/auth/register/magic',
    { name: 'Dora', email: 'dora@example.com' });
  assert.strictEqual(res.status, 200);
  const stored = usersByEmail.get('dora@example.com');
  assert.ok(stored, 'user row must be persisted');
  assert.deepStrictEqual(referralAttachCalls, [{ userId: stored.id, code: 'REF123' }],
    'referrer attribution must fire for the new passwordless signup');
  assert.deepStrictEqual(sourceAttachCalls, [{ userId: stored.id, source: 'producthunt' }],
    'signup-source attribution must fire for the new passwordless signup');
}

async function testGetMagicAuthedUserRedirects() {
  resetStore(); resetCallLogs();
  const app = buildApp({ id: 1, plan: 'free', name: 'U', email: 'u@x.com' });
  const res = await request(app, 'GET', '/auth/register?mode=magic');
  assert.strictEqual(res.status, 302,
    'authenticated user visiting ?mode=magic must redirect to /dashboard');
  assert.ok(res.headers.location.includes('/dashboard'));
}

async function testPostMagicAuthedUserRedirects() {
  resetStore(); resetCallLogs();
  const app = buildApp({ id: 1, plan: 'free', name: 'U', email: 'u@x.com' });
  const res = await request(app, 'POST', '/auth/register/magic',
    { name: 'X', email: 'x@y.com' });
  assert.strictEqual(res.status, 302,
    'authenticated user posting to /register/magic must redirect to /dashboard');
  // No user must be created in this branch.
  assert.strictEqual(usersByEmail.has('x@y.com'), false);
  assert.strictEqual(welcomeCalls.length, 0);
  assert.strictEqual(magicCalls.length, 0);
}

// ---------- Runner ------------------------------------------------------

async function run() {
  const tests = [
    ['GET /auth/register?mode=magic renders passwordless form (no password field)', testGetMagicModeRendersPasswordlessForm],
    ['GET /auth/register defaults to password form + links to magic mode', testGetDefaultRendersPasswordForm],
    ['GET /auth/register?mode=magic links back to the password form', testGetMagicLinksBackToPasswordMode],
    ['POST /auth/register/magic creates user, seeds, fires welcome (not magic-link)', testPostMagicCreatesUserAndFiresWelcome],
    ['POST /auth/register/magic does NOT authenticate the session', testPostMagicDoesNotAuthenticateSession],
    ['POST /auth/register/magic blank name re-renders magic form with error', testPostMagicBlankNameRendersError],
    ['POST /auth/register/magic invalid email re-renders magic form with error', testPostMagicInvalidEmailRendersError],
    ['POST /auth/register/magic existing email fires magic-link (no duplicate, no enumeration)', testPostMagicExistingEmailFiresMagicLinkNotDuplicate],
    ['POST /auth/register/magic attributes signup-source + referral on new user', testPostMagicAttributesSignupSourceAndReferral],
    ['GET /auth/register?mode=magic redirects authenticated users', testGetMagicAuthedUserRedirects],
    ['POST /auth/register/magic redirects authenticated users', testPostMagicAuthedUserRedirects]
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
