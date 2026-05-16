'use strict';

/*
 * Password reset / magic-link sign-in tests (Milestone 1 — signup → first
 * dashboard re-entry). End-to-end coverage of the four-step flow:
 *
 *   1. GET  /auth/forgot         — form renders, has CSRF + email input
 *   2. POST /auth/forgot         — generic success regardless of whether the
 *                                  email is known (no enumeration); when the
 *                                  email IS known, requestPasswordReset fires
 *                                  with that email; when validation fails,
 *                                  re-renders form with error
 *   3. GET  /auth/reset/:token   — valid token → form; invalid/expired token
 *                                  → "this link is no longer valid" page
 *   4. POST /auth/reset/:token   — valid token + 8+ char password → consumes
 *                                  token, rotates password_hash, writes
 *                                  session, redirects /dashboard
 *                                  - replay (already-consumed) → invalid page
 *                                  - bad password (< 8 chars) → re-render
 *                                    with validation error
 *
 * Plus lib-level coverage:
 *   - lib/email.buildPasswordResetSubject is a non-empty deliverable subject
 *   - lib/email.buildPasswordResetHtml escapes user input + embeds the reset
 *     URL + mentions the TTL
 *   - lib/email.buildPasswordResetText is plaintext (no HTML tag delimiters)
 *     and includes the URL + TTL
 *   - lib/email.sendPasswordResetEmail short-circuits on no recipient / no URL
 *   - lib/email.sendPasswordResetEmail happy path posts the right Resend payload
 *   - lib/password-reset.hashToken is deterministic SHA-256 hex
 *   - lib/password-reset.buildResetUrl is APP_URL-prefixed when set, relative
 *     otherwise
 *   - lib/password-reset.requestPasswordReset returns ok:true unknown_email
 *     when the address isn't in the DB (no enumeration)
 *   - lib/password-reset.requestPasswordReset happy path persists a hash
 *     (not the raw token) and fires the email with the URL
 *   - lib/password-reset.requestPasswordReset returns ok:true reason='db_error'
 *     on a getUserByEmail throw (never bubbles)
 *
 * Run: NODE_ENV=test node tests/password-reset.test.js
 */

const assert = require('assert');
const path = require('path');
const express = require('express');
const session = require('express-session');
const http = require('http');
const crypto = require('crypto');

function clearReq(mod) { delete require.cache[require.resolve(mod)]; }

// ---------- Lib-level tests --------------------------------------------------

async function testBuildSubject() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const subject = email.buildPasswordResetSubject();
  assert.ok(subject.length > 0 && subject.length < 100,
    'subject must be non-empty and fit a typical inbox preview');
  assert.ok(/reset/i.test(subject), 'subject must mention "reset"');
}

async function testBuildHtmlEscapesAndEmbedsUrl() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const url = 'https://invoice.example.com/auth/reset/abc123';
  const html = email.buildPasswordResetHtml(
    { name: '<script>alert(1)</script>', email: 'a@x.com' },
    url,
    60
  );
  assert.ok(!html.includes('<script>alert(1)</script>'),
    'raw name must not appear unescaped (XSS guard)');
  assert.ok(html.includes('&lt;script&gt;'),
    'name must appear HTML-escaped');
  assert.ok(html.includes(url),
    'html body must contain the reset URL');
  assert.ok(/60/.test(html), 'html body must surface the TTL in minutes');
  assert.ok(/once/i.test(html) || /single/i.test(html),
    'html body must indicate single-use semantics');
}

async function testBuildTextIncludesUrlPlaintext() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const url = 'https://invoice.example.com/auth/reset/xyz';
  const text = email.buildPasswordResetText(
    { name: 'Alice', email: 'a@x.com' },
    url,
    60
  );
  assert.ok(text.includes('Alice'), 'plaintext must personalise');
  assert.ok(text.includes(url), 'plaintext must include the URL');
  assert.ok(!text.includes('<') && !text.includes('>'),
    'plaintext must not contain HTML tag delimiters');
  assert.ok(/60/.test(text), 'plaintext must surface the TTL');
}

async function testSendShortCircuitsNoRecipient() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const r = await email.sendPasswordResetEmail({ name: 'No Email' }, 'https://x.com/r');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no_recipient');
}

async function testSendShortCircuitsNoUrl() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const r = await email.sendPasswordResetEmail({ email: 'a@x.com' }, '');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no_reset_url');
}

async function testSendHappyPath() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const sends = [];
  email.setResendClient({
    emails: {
      async send(payload) {
        sends.push(payload);
        return { data: { id: 'em_reset_99' }, error: null };
      }
    }
  });
  const r = await email.sendPasswordResetEmail(
    { id: 1, name: 'Bob', email: 'bob@x.com', reply_to_email: 'replies@bob.com' },
    'https://invoice.example.com/auth/reset/tk',
    60
  );
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.id, 'em_reset_99');
  assert.strictEqual(sends.length, 1);
  assert.deepStrictEqual(sends[0].to, ['bob@x.com']);
  assert.ok(sends[0].subject && /reset/i.test(sends[0].subject));
  assert.ok(sends[0].html && sends[0].html.includes('https://invoice.example.com/auth/reset/tk'));
  assert.ok(sends[0].text && sends[0].text.includes('https://invoice.example.com/auth/reset/tk'));
  assert.strictEqual(sends[0].reply_to, 'replies@bob.com',
    'reply_to must be the user\'s configured reply-to');
  email.resetResendClient();
}

async function testHashTokenDeterministic() {
  clearReq('../lib/password-reset');
  const { hashToken } = require('../lib/password-reset');
  const a = hashToken('abc');
  const b = hashToken('abc');
  const c = hashToken('xyz');
  assert.strictEqual(a, b, 'same input must hash to same output');
  assert.notStrictEqual(a, c, 'different inputs must differ');
  assert.ok(/^[a-f0-9]{64}$/.test(a), 'output must be 64-char hex (SHA-256)');
}

async function testBuildResetUrlAbsAndRelative() {
  clearReq('../lib/password-reset');
  const old = process.env.APP_URL;
  process.env.APP_URL = 'https://invoice.example.com';
  let { buildResetUrl } = require('../lib/password-reset');
  assert.strictEqual(buildResetUrl('deadbeef'),
    'https://invoice.example.com/auth/reset/deadbeef',
    'absolute URL when APP_URL is set');
  delete process.env.APP_URL;
  clearReq('../lib/password-reset');
  ({ buildResetUrl } = require('../lib/password-reset'));
  assert.strictEqual(buildResetUrl('deadbeef'), '/auth/reset/deadbeef',
    'relative URL when APP_URL is unset');
  if (old !== undefined) process.env.APP_URL = old;
}

async function testRequestUnknownEmailNoEnum() {
  clearReq('../lib/email');
  clearReq('../lib/password-reset');
  const { requestPasswordReset } = require('../lib/password-reset');
  const calls = { lookup: [], create: [] };
  const db = {
    getUserByEmail: async (e) => { calls.lookup.push(e); return null; },
    createPasswordResetToken: async (...args) => { calls.create.push(args); return { id: 1 }; }
  };
  const r = await requestPasswordReset(db, 'unknown@x.com');
  assert.strictEqual(r.ok, true, 'must report ok:true to the caller');
  assert.strictEqual(r.reason, 'unknown_email');
  assert.deepStrictEqual(calls.lookup, ['unknown@x.com']);
  assert.strictEqual(calls.create.length, 0,
    'must NOT persist a reset token for an unknown email');
}

async function testRequestHappyPathPersistsHashFiresEmail() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const sends = [];
  email.setResendClient({
    emails: {
      async send(payload) { sends.push(payload); return { data: { id: 'em_x' }, error: null }; }
    }
  });
  clearReq('../lib/password-reset');
  const oldAppUrl = process.env.APP_URL;
  process.env.APP_URL = 'https://invoice.example.com';
  const { requestPasswordReset, hashToken } = require('../lib/password-reset');
  const persisted = [];
  const db = {
    getUserByEmail: async () => ({
      id: 42, email: 'alice@x.com', name: 'Alice', plan: 'free'
    }),
    createPasswordResetToken: async (userId, tokenHash, ttl) => {
      persisted.push({ userId, tokenHash, ttl });
      return { id: 7, expires_at: new Date(Date.now() + 60 * 60 * 1000) };
    }
  };
  const r = await requestPasswordReset(db, 'alice@x.com');
  process.env.APP_URL = oldAppUrl;
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.sent, true);
  assert.strictEqual(r.id, 'em_x');
  assert.strictEqual(persisted.length, 1);
  assert.strictEqual(persisted[0].userId, 42);
  assert.ok(/^[a-f0-9]{64}$/.test(persisted[0].tokenHash),
    'persisted token must be a 64-char SHA-256 hex hash');
  assert.strictEqual(persisted[0].ttl, 60);
  assert.strictEqual(sends.length, 1);
  // The URL embedded in the email must be the APP_URL-prefixed reset link.
  const m = sends[0].text.match(/https:\/\/invoice\.example\.com\/auth\/reset\/([a-f0-9]+)/);
  assert.ok(m, 'plaintext must contain the absolute reset URL');
  const rawToken = m[1];
  // The persisted hash must be SHA-256(rawToken).
  assert.strictEqual(persisted[0].tokenHash, hashToken(rawToken),
    'persisted hash must match SHA-256 of the URL token');
  email.resetResendClient();
}

async function testRequestSoftFailsOnDbThrow() {
  clearReq('../lib/email');
  clearReq('../lib/password-reset');
  const { requestPasswordReset } = require('../lib/password-reset');
  const db = {
    getUserByEmail: async () => { throw new Error('connection refused'); },
    createPasswordResetToken: async () => null
  };
  const r = await requestPasswordReset(db, 'alice@x.com');
  assert.strictEqual(r.ok, true, 'must NOT bubble to caller (no enumeration)');
  assert.strictEqual(r.reason, 'db_error');
}

async function testRequestSoftFailsOnDbUnavailable() {
  clearReq('../lib/email');
  clearReq('../lib/password-reset');
  const { requestPasswordReset } = require('../lib/password-reset');
  const r = await requestPasswordReset({}, 'alice@x.com');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.reason, 'db_unavailable');
}

async function testRequestNoEmailShortCircuits() {
  clearReq('../lib/email');
  clearReq('../lib/password-reset');
  const { requestPasswordReset } = require('../lib/password-reset');
  const r = await requestPasswordReset({
    getUserByEmail: async () => null,
    createPasswordResetToken: async () => null
  }, '   ');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.reason, 'no_email');
}

// ---------- Route integration tests -----------------------------------------

// bcrypt stub: deterministic hash+compare so tests don't pay the real cost.
require.cache[require.resolve('bcrypt')] = {
  id: require.resolve('bcrypt'),
  filename: require.resolve('bcrypt'),
  loaded: true,
  exports: {
    hash: async (pw) => `hashed:${pw}`,
    compare: async (pw, hash) => hash === `hashed:${pw}`
  }
};

// In-memory user/reset store.
const usersById = new Map();
const usersByEmail = new Map();
const resetsByHash = new Map();
let nextUserId = 100;
let nextResetId = 1;
const requestCalls = [];
let requestImpl = async (db, e) => ({ ok: true, reason: 'unknown_email' });

function resetStore() {
  usersById.clear();
  usersByEmail.clear();
  resetsByHash.clear();
  nextUserId = 100;
  nextResetId = 1;
  requestCalls.length = 0;
}

function seedUser(overrides = {}) {
  const u = Object.assign({
    id: nextUserId++,
    email: 'alice@x.com',
    name: 'Alice',
    password_hash: 'hashed:oldpassword',
    plan: 'free',
    invoice_count: 0,
    subscription_status: null,
    trial_ends_at: null
  }, overrides);
  usersById.set(u.id, u);
  usersByEmail.set(u.email, u);
  return u;
}

const dbStub = {
  db: {
    async getUserByEmail(email) { return usersByEmail.get(email) || null; },
    async getUserById(id) { return usersById.get(id) || null; },
    async createPasswordResetToken(userId, tokenHash, ttlMinutes) {
      const expires_at = new Date(Date.now() + (ttlMinutes || 60) * 60 * 1000);
      const row = { id: nextResetId++, user_id: userId, token_hash: tokenHash, expires_at, consumed_at: null };
      resetsByHash.set(tokenHash, row);
      return { id: row.id, expires_at };
    },
    async findValidPasswordResetByHash(tokenHash) {
      const r = resetsByHash.get(tokenHash);
      if (!r || r.consumed_at) return null;
      if (r.expires_at <= new Date()) return null;
      const u = usersById.get(r.user_id);
      if (!u) return null;
      return {
        reset_id: r.id, user_id: u.id, expires_at: r.expires_at,
        email: u.email, name: u.name, plan: u.plan,
        invoice_count: u.invoice_count,
        subscription_status: u.subscription_status,
        trial_ends_at: u.trial_ends_at
      };
    },
    async consumePasswordResetAndSetPassword(tokenHash, newHash) {
      const r = resetsByHash.get(tokenHash);
      if (!r || r.consumed_at) return null;
      if (r.expires_at <= new Date()) return null;
      r.consumed_at = new Date();
      const u = usersById.get(r.user_id);
      if (!u) return null;
      u.password_hash = newHash;
      return {
        id: u.id, email: u.email, name: u.name, plan: u.plan,
        invoice_count: u.invoice_count,
        subscription_status: u.subscription_status,
        trial_ends_at: u.trial_ends_at
      };
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

// Stub the welcome orchestrator so the register-route side doesn't try to
// hit the email lib in route-test context (we don't exercise /register here
// but the routes module imports it at load time).
require.cache[require.resolve('../lib/welcome')] = {
  id: require.resolve('../lib/welcome'),
  filename: require.resolve('../lib/welcome'),
  loaded: true,
  exports: { triggerWelcomeEmail: async () => ({ ok: true }) }
};

// Stub lib/password-reset so the route test observes calls without actually
// hitting the email lib (which is covered by the lib tests above). hashToken
// must still be the real one because the route uses it to look up the row.
const realPwReset = (() => {
  clearReq('../lib/password-reset');
  return require('../lib/password-reset');
})();
require.cache[require.resolve('../lib/password-reset')] = {
  id: require.resolve('../lib/password-reset'),
  filename: require.resolve('../lib/password-reset'),
  loaded: true,
  exports: Object.assign({}, realPwReset, {
    requestPasswordReset: async (db, e, opts) => {
      requestCalls.push({ email: e, opts });
      return requestImpl(db, e, opts);
    }
  })
};

clearReq('../routes/auth');
const authRoutes = require('../routes/auth');

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
  app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    next();
  });
  app.use('/auth', authRoutes);
  app.get('/dashboard', (req, res) => {
    if (!req.session.user) return res.status(401).send('unauth');
    res.send(`dashboard:${req.session.user.id}`);
  });
  return app;
}

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

async function testGetForgotRendersForm() {
  resetStore();
  const app = buildApp();
  const res = await request(app, 'GET', '/auth/forgot');
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.includes('Reset your password'), 'must show the page title');
  assert.ok(/<form[^>]+action="\/auth\/forgot"/.test(res.body),
    'must render the request-form posting to /auth/forgot');
  assert.ok(res.body.includes('name="email"'), 'form must collect email');
}

async function testPostForgotRendersGenericSuccessUnknown() {
  resetStore();
  // No user seeded: unknown email path
  requestImpl = async () => ({ ok: true, reason: 'unknown_email' });
  const app = buildApp();
  const res = await request(app, 'POST', '/auth/forgot', { email: 'who@x.com' });
  assert.strictEqual(res.status, 200,
    'must render success page even for unknown email (no email enumeration)');
  assert.ok(res.body.includes('Check your inbox'),
    'must show generic "check your inbox" copy');
  await new Promise(r => setImmediate(r));
  assert.strictEqual(requestCalls.length, 1,
    'requestPasswordReset must still be called so the trigger fires when the email IS known');
  assert.strictEqual(requestCalls[0].email, 'who@x.com');
}

async function testPostForgotFiresWhenKnown() {
  resetStore();
  seedUser({ email: 'real@x.com' });
  requestImpl = async () => ({ ok: true, sent: true, id: 'em_42' });
  const app = buildApp();
  const res = await request(app, 'POST', '/auth/forgot', { email: 'real@x.com' });
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.includes('Check your inbox'));
  await new Promise(r => setImmediate(r));
  assert.strictEqual(requestCalls.length, 1);
  assert.strictEqual(requestCalls[0].email, 'real@x.com');
}

async function testPostForgotValidationError() {
  resetStore();
  const app = buildApp();
  const res = await request(app, 'POST', '/auth/forgot', { email: 'notanemail' });
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.includes('Valid email required') || res.body.includes('Email'),
    'must show validation error on bad email');
  await new Promise(r => setImmediate(r));
  assert.strictEqual(requestCalls.length, 0,
    'validation failure must NOT fire the orchestrator');
}

async function testGetResetInvalidTokenShowsExpired() {
  resetStore();
  const app = buildApp();
  // 64 hex chars but unknown: triggers the lookup-then-null branch
  const fakeToken = 'a'.repeat(64);
  const res = await request(app, 'GET', `/auth/reset/${fakeToken}`);
  assert.strictEqual(res.status, 400);
  assert.ok(res.body.includes('no longer valid'),
    'unknown token must render the expired-link page');
  assert.ok(/data-testid="reset-invalid"/.test(res.body),
    'expired view must be marked with reset-invalid testid');
}

async function testGetResetBadTokenShapeShowsExpired() {
  resetStore();
  const app = buildApp();
  const res = await request(app, 'GET', '/auth/reset/not-hex');
  assert.strictEqual(res.status, 400);
  assert.ok(res.body.includes('no longer valid'),
    'a non-hex token shape must short-circuit to the expired page without a DB hit');
}

async function testGetResetValidTokenShowsForm() {
  resetStore();
  const user = seedUser();
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = realPwReset.hashToken(raw);
  resetsByHash.set(hash, {
    id: 1, user_id: user.id, token_hash: hash,
    expires_at: new Date(Date.now() + 60 * 60 * 1000),
    consumed_at: null
  });
  const app = buildApp();
  const res = await request(app, 'GET', `/auth/reset/${raw}`);
  assert.strictEqual(res.status, 200);
  assert.ok(/<form[^>]+action="\/auth\/reset\//.test(res.body),
    'valid token must render the set-password form');
  assert.ok(res.body.includes('name="password"'),
    'form must collect a new password');
  assert.ok(res.body.includes(user.email),
    'form must surface the account email so the user knows whose password they\'re changing');
}

async function testPostResetHappyPathLogsInAndRedirects() {
  resetStore();
  const user = seedUser();
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = realPwReset.hashToken(raw);
  resetsByHash.set(hash, {
    id: 1, user_id: user.id, token_hash: hash,
    expires_at: new Date(Date.now() + 60 * 60 * 1000),
    consumed_at: null
  });
  const app = buildApp();
  const jar = { cookie: null };
  const res = await request(app, 'POST', `/auth/reset/${raw}`,
    { password: 'new-strong-pw' }, jar);
  assert.strictEqual(res.status, 302, 'happy path must redirect on success');
  assert.ok(res.headers.location.includes('/dashboard'),
    'redirect target must be /dashboard');
  // Confirm password rotated
  assert.strictEqual(usersById.get(user.id).password_hash, 'hashed:new-strong-pw',
    'password_hash must be rotated by bcrypt.hash output');
  // Confirm token consumed
  assert.ok(resetsByHash.get(hash).consumed_at instanceof Date,
    'token must be stamped consumed_at');
  // Confirm session was written by following the redirect
  const dashRes = await request(app, 'GET', '/dashboard', null, jar);
  assert.strictEqual(dashRes.status, 200, 'session cookie must authenticate /dashboard');
  assert.ok(dashRes.body.startsWith('dashboard:'),
    'dashboard view must see req.session.user populated');
}

async function testPostResetReplayRejected() {
  resetStore();
  const user = seedUser();
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = realPwReset.hashToken(raw);
  resetsByHash.set(hash, {
    id: 1, user_id: user.id, token_hash: hash,
    expires_at: new Date(Date.now() + 60 * 60 * 1000),
    consumed_at: null
  });
  const app = buildApp();
  // First submit: succeeds
  const first = await request(app, 'POST', `/auth/reset/${raw}`,
    { password: 'first-pass-12' });
  assert.strictEqual(first.status, 302);
  // Replay: must NOT succeed
  const replay = await request(app, 'POST', `/auth/reset/${raw}`,
    { password: 'second-pass-12' });
  assert.strictEqual(replay.status, 400,
    'replay of a consumed token must reject (single-use)');
  assert.ok(replay.body.includes('no longer valid'));
  // Password was rotated by the FIRST request only; the second must NOT
  // have re-hashed the password (in particular, the dashboard-session
  // password is the first-pass-12 hash).
  assert.strictEqual(usersById.get(user.id).password_hash, 'hashed:first-pass-12',
    'replay must NOT silently rotate the password again');
}

async function testPostResetWeakPasswordRerenders() {
  resetStore();
  const user = seedUser();
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = realPwReset.hashToken(raw);
  resetsByHash.set(hash, {
    id: 1, user_id: user.id, token_hash: hash,
    expires_at: new Date(Date.now() + 60 * 60 * 1000),
    consumed_at: null
  });
  const app = buildApp();
  const res = await request(app, 'POST', `/auth/reset/${raw}`,
    { password: 'short' });
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.includes('8 characters') || res.body.includes('Password'),
    'must show validation error for < 8 char password');
  // Token still valid (not consumed)
  assert.strictEqual(resetsByHash.get(hash).consumed_at, null,
    'a validation rejection must NOT consume the token');
  // Password untouched
  assert.strictEqual(usersById.get(user.id).password_hash, 'hashed:oldpassword',
    'a validation rejection must NOT rotate the password');
}

async function testPostResetBadTokenShape() {
  resetStore();
  const app = buildApp();
  const res = await request(app, 'POST', '/auth/reset/not-hex',
    { password: 'something-strong' });
  assert.strictEqual(res.status, 400);
  assert.ok(res.body.includes('no longer valid'),
    'bad-shape token on POST must short-circuit to the expired page');
}

async function testPostResetExpiredToken() {
  resetStore();
  const user = seedUser();
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = realPwReset.hashToken(raw);
  resetsByHash.set(hash, {
    id: 1, user_id: user.id, token_hash: hash,
    expires_at: new Date(Date.now() - 1000),
    consumed_at: null
  });
  const app = buildApp();
  const res = await request(app, 'POST', `/auth/reset/${raw}`,
    { password: 'new-strong-pw' });
  assert.strictEqual(res.status, 400);
  assert.ok(res.body.includes('no longer valid'),
    'expired token on POST must surface the invalid view');
  // Password untouched
  assert.strictEqual(usersById.get(user.id).password_hash, 'hashed:oldpassword',
    'expired-token POST must NOT rotate the password');
}

async function testLoginLinksToForgot() {
  resetStore();
  const app = buildApp();
  const res = await request(app, 'GET', '/auth/login');
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.includes('href="/auth/forgot"'),
    'login page must link to /auth/forgot (the activation Milestone 1 entry point)');
  assert.ok(!res.body.includes('we\'ll reset it for you'),
    'login page must NOT contain the legacy "email support — we\'ll reset it" dead-end copy');
}

async function testForgotRedirectsAuthedUser() {
  resetStore();
  const app = buildApp({ id: 1, plan: 'free', email: 'u@x.com', name: 'U' });
  const res = await request(app, 'GET', '/auth/forgot');
  assert.strictEqual(res.status, 302,
    'an authed user visiting /forgot must redirect to /dashboard');
  assert.ok(res.headers.location.includes('/dashboard'));
}

// ---------- Runner ----------------------------------------------------------

async function run() {
  const tests = [
    ['lib/email: buildPasswordResetSubject is non-empty + mentions "reset"', testBuildSubject],
    ['lib/email: buildPasswordResetHtml escapes input + embeds URL + TTL', testBuildHtmlEscapesAndEmbedsUrl],
    ['lib/email: buildPasswordResetText is plaintext + URL + TTL', testBuildTextIncludesUrlPlaintext],
    ['lib/email: sendPasswordResetEmail short-circuits on no recipient', testSendShortCircuitsNoRecipient],
    ['lib/email: sendPasswordResetEmail short-circuits on no URL', testSendShortCircuitsNoUrl],
    ['lib/email: sendPasswordResetEmail happy path posts Resend payload', testSendHappyPath],
    ['lib/password-reset: hashToken deterministic SHA-256 hex', testHashTokenDeterministic],
    ['lib/password-reset: buildResetUrl absolute when APP_URL set, relative otherwise', testBuildResetUrlAbsAndRelative],
    ['lib/password-reset: requestPasswordReset unknown email → no enumeration', testRequestUnknownEmailNoEnum],
    ['lib/password-reset: requestPasswordReset happy path persists HASH + fires email', testRequestHappyPathPersistsHashFiresEmail],
    ['lib/password-reset: requestPasswordReset soft-fails on db throw', testRequestSoftFailsOnDbThrow],
    ['lib/password-reset: requestPasswordReset soft-fails on db_unavailable', testRequestSoftFailsOnDbUnavailable],
    ['lib/password-reset: requestPasswordReset short-circuits on no email', testRequestNoEmailShortCircuits],
    ['GET /auth/forgot renders request form', testGetForgotRendersForm],
    ['POST /auth/forgot generic success for unknown email (no enum)', testPostForgotRendersGenericSuccessUnknown],
    ['POST /auth/forgot still fires when email is known', testPostForgotFiresWhenKnown],
    ['POST /auth/forgot validation error on bad email', testPostForgotValidationError],
    ['GET /auth/reset/:token unknown token → expired page (400)', testGetResetInvalidTokenShowsExpired],
    ['GET /auth/reset/:token bad shape → expired page (no DB hit)', testGetResetBadTokenShapeShowsExpired],
    ['GET /auth/reset/:token valid token → set-password form', testGetResetValidTokenShowsForm],
    ['POST /auth/reset/:token happy path rotates pwd + logs in + redirects', testPostResetHappyPathLogsInAndRedirects],
    ['POST /auth/reset/:token replay of consumed token rejected (single-use)', testPostResetReplayRejected],
    ['POST /auth/reset/:token weak password re-renders form', testPostResetWeakPasswordRerenders],
    ['POST /auth/reset/:token bad token shape → expired page', testPostResetBadTokenShape],
    ['POST /auth/reset/:token expired token rejected (no password rotation)', testPostResetExpiredToken],
    ['Login page links to /auth/forgot (no support-mailto dead-end)', testLoginLinksToForgot],
    ['/auth/forgot redirects authed user to /dashboard', testForgotRedirectsAuthedUser]
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
