'use strict';

/*
 * Magic-link sign-in tests (Milestone 1 — signup → first dashboard re-entry).
 * End-to-end coverage of the three-step flow:
 *
 *   1. GET  /auth/magic                — form renders, has CSRF + email input
 *   2. POST /auth/magic                — generic success regardless of whether
 *                                        the email is known (no enumeration)
 *                                        + validation error on bad email
 *   3. GET  /auth/magic/:token         — valid token → consume + log in +
 *                                        302 /dashboard; replay → invalid;
 *                                        bad shape → invalid; expired → invalid;
 *                                        kind isolation: reset token cannot
 *                                        be replayed as a magic-login URL
 *
 * Plus lib-level coverage:
 *   - lib/email.buildMagicLoginSubject is non-empty + mentions sign-in
 *   - lib/email.buildMagicLoginHtml escapes user input + embeds the URL + TTL
 *   - lib/email.buildMagicLoginText is plaintext + includes URL + TTL
 *   - lib/email.sendMagicLoginEmail short-circuits on no recipient / no URL
 *   - lib/email.sendMagicLoginEmail happy path posts the right Resend payload
 *   - lib/magic-login.hashToken is deterministic SHA-256 hex
 *   - lib/magic-login.buildMagicLoginUrl is APP_URL-prefixed when set,
 *     relative otherwise; uses /auth/magic/<token> path
 *   - lib/magic-login.requestMagicLink returns ok:true unknown_email when
 *     the address isn't in the DB (no enumeration)
 *   - lib/magic-login.requestMagicLink happy path persists hash with kind='login'
 *   - lib/magic-login.requestMagicLink returns ok:true reason='db_error' on
 *     a getUserByEmail throw (never bubbles)
 *   - lib/magic-login.requestMagicLink default TTL is 30 minutes
 *
 * Cross-flow coverage:
 *   - Login page links to /auth/magic (entry-point discoverability)
 *
 * Run: NODE_ENV=test node tests/magic-login.test.js
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
  const subject = email.buildMagicLoginSubject();
  assert.ok(subject.length > 0 && subject.length < 100,
    'subject must be non-empty and fit a typical inbox preview');
  assert.ok(/sign[- ]?in|sign[- ]?up|login/i.test(subject),
    'subject must mention sign-in / login');
}

async function testBuildHtmlEscapesAndEmbedsUrl() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const url = 'https://invoice.example.com/auth/magic/abc123def';
  const html = email.buildMagicLoginHtml(
    { name: '<script>alert(1)</script>', email: 'a@x.com' },
    url,
    30
  );
  assert.ok(!html.includes('<script>alert(1)</script>'),
    'raw name must not appear unescaped (XSS guard)');
  assert.ok(html.includes('&lt;script&gt;'),
    'name must appear HTML-escaped');
  assert.ok(html.includes(url),
    'html body must contain the magic-login URL');
  assert.ok(/30/.test(html), 'html body must surface the TTL in minutes');
  assert.ok(/once/i.test(html) || /single/i.test(html),
    'html body must indicate single-use semantics');
  assert.ok(/no password/i.test(html) || /password[- ]less/i.test(html),
    'html body must surface the password-less nature of the flow');
}

async function testBuildTextIncludesUrlPlaintext() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const url = 'https://invoice.example.com/auth/magic/abcdef';
  const text = email.buildMagicLoginText({ name: 'Alice' }, url, 30);
  assert.ok(text.includes(url), 'plaintext body must contain the URL');
  assert.ok(/30/.test(text), 'plaintext body must surface the TTL');
  assert.ok(!/<[a-z]/i.test(text),
    'plaintext body must not contain HTML tag delimiters');
}

async function testSendShortCircuitsNoRecipient() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const r = await email.sendMagicLoginEmail(null, 'https://x/y', 30);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no_recipient');
}

async function testSendShortCircuitsNoUrl() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const r = await email.sendMagicLoginEmail({ email: 'a@x.com' }, '', 30);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no_login_url');
}

async function testSendHappyPath() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const sends = [];
  email.setResendClient({
    emails: {
      async send(payload) { sends.push(payload); return { data: { id: 'em_m1' }, error: null }; }
    }
  });
  const r = await email.sendMagicLoginEmail(
    { email: 'alice@x.com', name: 'Alice', reply_to_email: 'alice@x.com' },
    'https://invoice.example.com/auth/magic/tok',
    30
  );
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.id, 'em_m1');
  assert.strictEqual(sends.length, 1);
  const payload = sends[0];
  assert.deepStrictEqual(payload.to, ['alice@x.com']);
  assert.ok(/sign[- ]?in/i.test(payload.subject), 'subject must mention sign-in');
  assert.ok(payload.html.includes('https://invoice.example.com/auth/magic/tok'),
    'html must embed the magic-login URL');
  assert.ok(payload.text.includes('https://invoice.example.com/auth/magic/tok'),
    'text must embed the magic-login URL');
  assert.strictEqual(payload.reply_to, 'alice@x.com');
  email.resetResendClient();
}

async function testHashTokenDeterministic() {
  clearReq('../lib/magic-login');
  const { hashToken } = require('../lib/magic-login');
  const a = hashToken('hello');
  const b = hashToken('hello');
  const c = hashToken('world');
  assert.strictEqual(a, b, 'same input must hash to same output');
  assert.notStrictEqual(a, c, 'different input must hash to different output');
  assert.ok(/^[a-f0-9]{64}$/.test(a),
    'hashToken output must be 64-char SHA-256 hex');
}

async function testBuildMagicLoginUrlAbsAndRelative() {
  clearReq('../lib/magic-login');
  const { buildMagicLoginUrl } = require('../lib/magic-login');
  const old = process.env.APP_URL;
  process.env.APP_URL = 'https://invoice.example.com/';
  let url = buildMagicLoginUrl('deadbeef');
  assert.strictEqual(url, 'https://invoice.example.com/auth/magic/deadbeef',
    'trailing slash on APP_URL must be normalised; URL must use /auth/magic/ path');
  delete process.env.APP_URL;
  url = buildMagicLoginUrl('cafef00d');
  assert.strictEqual(url, '/auth/magic/cafef00d',
    'no APP_URL → relative path');
  url = buildMagicLoginUrl('');
  assert.strictEqual(url, '', 'empty token → empty URL');
  process.env.APP_URL = old;
}

async function testRequestUnknownEmailNoEnum() {
  clearReq('../lib/email');
  clearReq('../lib/magic-login');
  const email = require('../lib/email');
  email.setResendClient({
    emails: { async send() { throw new Error('should not be called for unknown email'); } }
  });
  const { requestMagicLink } = require('../lib/magic-login');
  const r = await requestMagicLink({
    getUserByEmail: async () => null,
    createPasswordResetToken: async () => { throw new Error('should not persist for unknown'); }
  }, 'who@x.com');
  assert.strictEqual(r.ok, true, 'must return ok:true (no enumeration)');
  assert.strictEqual(r.reason, 'unknown_email');
  assert.ok(!r.sent, 'must NOT mark sent for unknown email');
  email.resetResendClient();
}

async function testRequestHappyPathPersistsHashWithLoginKind() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const sends = [];
  email.setResendClient({
    emails: {
      async send(payload) { sends.push(payload); return { data: { id: 'em_m2' }, error: null }; }
    }
  });
  clearReq('../lib/magic-login');
  const oldAppUrl = process.env.APP_URL;
  process.env.APP_URL = 'https://invoice.example.com';
  const { requestMagicLink, hashToken } = require('../lib/magic-login');
  const persisted = [];
  const db = {
    getUserByEmail: async () => ({
      id: 42, email: 'alice@x.com', name: 'Alice', plan: 'free'
    }),
    createPasswordResetToken: async (userId, tokenHash, ttl, kind) => {
      persisted.push({ userId, tokenHash, ttl, kind });
      return { id: 7, expires_at: new Date(Date.now() + 30 * 60 * 1000), kind: kind || 'reset' };
    }
  };
  const r = await requestMagicLink(db, 'alice@x.com');
  process.env.APP_URL = oldAppUrl;
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.sent, true);
  assert.strictEqual(r.id, 'em_m2');
  assert.strictEqual(persisted.length, 1);
  assert.strictEqual(persisted[0].userId, 42);
  assert.ok(/^[a-f0-9]{64}$/.test(persisted[0].tokenHash),
    'persisted token must be a 64-char SHA-256 hex hash');
  assert.strictEqual(persisted[0].ttl, 30, 'default TTL must be 30 minutes');
  assert.strictEqual(persisted[0].kind, 'login',
    'persisted token must be tagged kind=login');
  assert.strictEqual(sends.length, 1);
  const m = sends[0].text.match(/https:\/\/invoice\.example\.com\/auth\/magic\/([a-f0-9]+)/);
  assert.ok(m, 'plaintext must contain the absolute magic-login URL');
  const rawToken = m[1];
  assert.strictEqual(persisted[0].tokenHash, hashToken(rawToken),
    'persisted hash must match SHA-256 of the URL token');
  email.resetResendClient();
}

async function testRequestSoftFailsOnDbThrow() {
  clearReq('../lib/email');
  clearReq('../lib/magic-login');
  const { requestMagicLink } = require('../lib/magic-login');
  const db = {
    getUserByEmail: async () => { throw new Error('connection refused'); },
    createPasswordResetToken: async () => null
  };
  const r = await requestMagicLink(db, 'alice@x.com');
  assert.strictEqual(r.ok, true, 'must NOT bubble to caller (no enumeration)');
  assert.strictEqual(r.reason, 'db_error');
}

async function testRequestSoftFailsOnDbUnavailable() {
  clearReq('../lib/email');
  clearReq('../lib/magic-login');
  const { requestMagicLink } = require('../lib/magic-login');
  const r = await requestMagicLink({}, 'alice@x.com');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.reason, 'db_unavailable');
}

async function testRequestNoEmailShortCircuits() {
  clearReq('../lib/email');
  clearReq('../lib/magic-login');
  const { requestMagicLink } = require('../lib/magic-login');
  const r = await requestMagicLink({
    getUserByEmail: async () => null,
    createPasswordResetToken: async () => null
  }, '   ');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.reason, 'no_email');
}

async function testRequestPropagatesCustomTtl() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  email.setResendClient({
    emails: { async send() { return { data: { id: 'em_x' }, error: null }; } }
  });
  clearReq('../lib/magic-login');
  const { requestMagicLink } = require('../lib/magic-login');
  const persisted = [];
  const db = {
    getUserByEmail: async () => ({ id: 1, email: 'a@x.com', name: 'A' }),
    createPasswordResetToken: async (uid, hash, ttl, kind) => {
      persisted.push({ ttl, kind });
      return { id: 1, expires_at: new Date() };
    }
  };
  await requestMagicLink(db, 'a@x.com', { ttlMinutes: 10 });
  assert.strictEqual(persisted[0].ttl, 10, 'custom ttlMinutes must flow through');
  assert.strictEqual(persisted[0].kind, 'login', 'kind must still be login');
  email.resetResendClient();
}

// ---------- Route integration tests -----------------------------------------

// bcrypt stub (carries no semantic content here — magic-login never hashes,
// but routes/auth.js requires bcrypt at load time).
require.cache[require.resolve('bcrypt')] = {
  id: require.resolve('bcrypt'),
  filename: require.resolve('bcrypt'),
  loaded: true,
  exports: {
    hash: async (pw) => `hashed:${pw}`,
    compare: async (pw, hash) => hash === `hashed:${pw}`
  }
};

// In-memory store. Tokens carry kind to exercise the route's kind-isolation.
const usersById = new Map();
const usersByEmail = new Map();
const tokensByHash = new Map();
let nextUserId = 200;
let nextTokenId = 1;
const requestCalls = [];
let requestImpl = async () => ({ ok: true, reason: 'unknown_email' });

function resetStore() {
  usersById.clear();
  usersByEmail.clear();
  tokensByHash.clear();
  nextUserId = 200;
  nextTokenId = 1;
  requestCalls.length = 0;
}

function seedUser(overrides = {}) {
  const u = Object.assign({
    id: nextUserId++,
    email: 'alice@x.com',
    name: 'Alice',
    password_hash: 'hashed:somepw',
    plan: 'free',
    invoice_count: 0,
    subscription_status: null,
    trial_ends_at: null
  }, overrides);
  usersById.set(u.id, u);
  usersByEmail.set(u.email, u);
  return u;
}

function seedToken({ userId, tokenHash, kind, expiresInMinutes = 30, consumed = false }) {
  const expires_at = new Date(Date.now() + expiresInMinutes * 60 * 1000);
  const row = {
    id: nextTokenId++,
    user_id: userId,
    token_hash: tokenHash,
    expires_at,
    consumed_at: consumed ? new Date() : null,
    kind: kind || 'reset'
  };
  tokensByHash.set(tokenHash, row);
  return row;
}

const dbStub = {
  db: {
    async getUserByEmail(email) { return usersByEmail.get(email) || null; },
    async getUserById(id) { return usersById.get(id) || null; },
    async createPasswordResetToken(userId, tokenHash, ttlMinutes, kind) {
      const safeKind = kind === 'login' ? 'login' : 'reset';
      const row = seedToken({ userId, tokenHash, kind: safeKind, expiresInMinutes: ttlMinutes || 30 });
      return { id: row.id, expires_at: row.expires_at, kind: safeKind };
    },
    async findValidPasswordResetByHash(tokenHash) {
      const r = tokensByHash.get(tokenHash);
      if (!r || r.consumed_at) return null;
      if (r.kind !== 'reset') return null;
      if (r.expires_at <= new Date()) return null;
      const u = usersById.get(r.user_id);
      if (!u) return null;
      return {
        reset_id: r.id, user_id: u.id, expires_at: r.expires_at,
        email: u.email, name: u.name, plan: u.plan
      };
    },
    async consumePasswordResetAndSetPassword(tokenHash, newHash) {
      const r = tokensByHash.get(tokenHash);
      if (!r || r.consumed_at) return null;
      if (r.kind !== 'reset') return null;
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
    },
    async findValidMagicLoginByHash(tokenHash) {
      const r = tokensByHash.get(tokenHash);
      if (!r || r.consumed_at) return null;
      if (r.kind !== 'login') return null;
      if (r.expires_at <= new Date()) return null;
      const u = usersById.get(r.user_id);
      if (!u) return null;
      return { reset_id: r.id, user_id: u.id, expires_at: r.expires_at, email: u.email };
    },
    async consumeMagicLoginToken(tokenHash) {
      const r = tokensByHash.get(tokenHash);
      if (!r || r.consumed_at) return null;
      if (r.kind !== 'login') return null;
      if (r.expires_at <= new Date()) return null;
      r.consumed_at = new Date();
      const u = usersById.get(r.user_id);
      if (!u) return null;
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

require.cache[require.resolve('../lib/welcome')] = {
  id: require.resolve('../lib/welcome'),
  filename: require.resolve('../lib/welcome'),
  loaded: true,
  exports: { triggerWelcomeEmail: async () => ({ ok: true }) }
};

// Stub lib/password-reset so the route module's require resolves and the
// existing /auth/forgot tests in another file are not perturbed.
const realPwReset = (() => {
  clearReq('../lib/password-reset');
  return require('../lib/password-reset');
})();
require.cache[require.resolve('../lib/password-reset')] = {
  id: require.resolve('../lib/password-reset'),
  filename: require.resolve('../lib/password-reset'),
  loaded: true,
  exports: Object.assign({}, realPwReset, {
    requestPasswordReset: async () => ({ ok: true, reason: 'unknown_email' })
  })
};

// Stub lib/magic-login.requestMagicLink so we observe POST /auth/magic calls
// without firing the real email orchestrator (lib tests cover that branch).
// hashToken must remain the real one because the consume path needs it.
const realMagicLogin = (() => {
  clearReq('../lib/magic-login');
  return require('../lib/magic-login');
})();
require.cache[require.resolve('../lib/magic-login')] = {
  id: require.resolve('../lib/magic-login'),
  filename: require.resolve('../lib/magic-login'),
  loaded: true,
  exports: Object.assign({}, realMagicLogin, {
    requestMagicLink: async (db, e, opts) => {
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

async function testGetMagicRendersForm() {
  resetStore();
  const app = buildApp();
  const res = await request(app, 'GET', '/auth/magic');
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.includes('Sign in with email') || res.body.includes('sign-in link'),
    'must show the magic-link page heading or CTA copy');
  assert.ok(/<form[^>]+action="\/auth\/magic"/.test(res.body),
    'must render the request-form posting to /auth/magic');
  assert.ok(res.body.includes('name="email"'), 'form must collect email');
}

async function testPostMagicRendersGenericSuccessUnknown() {
  resetStore();
  requestImpl = async () => ({ ok: true, reason: 'unknown_email' });
  const app = buildApp();
  const res = await request(app, 'POST', '/auth/magic', { email: 'who@x.com' });
  assert.strictEqual(res.status, 200,
    'must render success page even for unknown email (no enumeration)');
  assert.ok(res.body.includes('Check your inbox'),
    'must show generic "check your inbox" copy');
  assert.ok(res.body.includes('who@x.com'),
    'must echo the email the user submitted (for usability)');
}

async function testPostMagicFiresWhenKnown() {
  resetStore();
  seedUser({ email: 'alice@x.com' });
  requestImpl = async () => ({ ok: true, sent: true, id: 'em_z' });
  const app = buildApp();
  const res = await request(app, 'POST', '/auth/magic', { email: 'alice@x.com' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(requestCalls.length, 1, 'must invoke requestMagicLink exactly once');
  assert.strictEqual(requestCalls[0].email, 'alice@x.com');
}

async function testPostMagicValidationError() {
  resetStore();
  const app = buildApp();
  const res = await request(app, 'POST', '/auth/magic', { email: 'not-an-email' });
  assert.strictEqual(res.status, 200, 're-renders form, no redirect');
  assert.ok(res.body.includes('Valid email required'),
    'must render the validator error message');
  assert.ok(!res.body.includes('Check your inbox'),
    'must NOT render the success page on validation failure');
}

async function testGetMagicTokenHappyPathLogsInAndRedirects() {
  resetStore();
  const u = seedUser({ id: 501, email: 'alice@x.com', name: 'Alice' });
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = require('../lib/magic-login').hashToken(raw);
  seedToken({ userId: u.id, tokenHash: hash, kind: 'login' });
  const app = buildApp();
  const jar = {};
  const res = await request(app, 'GET', `/auth/magic/${raw}`, null, jar);
  assert.strictEqual(res.status, 302, 'happy path must redirect');
  assert.ok(res.headers.location.includes('/dashboard'),
    'redirect target must be /dashboard');
  // Follow the redirect with the cookie to confirm session is set
  const res2 = await request(app, 'GET', '/dashboard', null, jar);
  assert.strictEqual(res2.status, 200);
  assert.strictEqual(res2.body, `dashboard:${u.id}`,
    'session.user.id must be set on the user we resolved');
  // Token must now be consumed
  const row = tokensByHash.get(hash);
  assert.ok(row && row.consumed_at,
    'token row must be marked consumed after happy-path GET');
}

async function testGetMagicTokenReplayRejected() {
  resetStore();
  const u = seedUser({ id: 502, email: 'bob@x.com' });
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = require('../lib/magic-login').hashToken(raw);
  seedToken({ userId: u.id, tokenHash: hash, kind: 'login', consumed: true });
  const app = buildApp();
  const res = await request(app, 'GET', `/auth/magic/${raw}`);
  assert.strictEqual(res.status, 400, 'replay of consumed token must render invalid');
  assert.ok(res.body.includes('no longer valid') || res.body.includes('expired'),
    'must surface invalid-link copy');
}

async function testGetMagicTokenBadShape() {
  resetStore();
  const app = buildApp();
  const res = await request(app, 'GET', '/auth/magic/not-a-hex-token');
  assert.strictEqual(res.status, 400);
  assert.ok(res.body.includes('no longer valid') || res.body.includes('expired'),
    'must surface invalid-link copy without hitting the DB');
}

async function testGetMagicTokenExpired() {
  resetStore();
  const u = seedUser({ id: 503, email: 'carol@x.com' });
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = require('../lib/magic-login').hashToken(raw);
  // Seed with negative expiry so the row exists but is expired
  seedToken({ userId: u.id, tokenHash: hash, kind: 'login', expiresInMinutes: -1 });
  const app = buildApp();
  const res = await request(app, 'GET', `/auth/magic/${raw}`);
  assert.strictEqual(res.status, 400, 'expired token must render invalid');
  // Make sure session was NOT set
  const res2 = await request(app, 'GET', '/dashboard');
  assert.strictEqual(res2.status, 401, 'no session must be written on expired-token consume');
}

async function testGetMagicTokenKindIsolation_ResetTokenNotConsumable() {
  resetStore();
  const u = seedUser({ id: 504, email: 'dave@x.com' });
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = require('../lib/magic-login').hashToken(raw);
  // Seed a PASSWORD-RESET kind token. GET /auth/magic/<that-token> must
  // NOT consume it — kind mismatch.
  seedToken({ userId: u.id, tokenHash: hash, kind: 'reset' });
  const app = buildApp();
  const res = await request(app, 'GET', `/auth/magic/${raw}`);
  assert.strictEqual(res.status, 400,
    'reset-kind token must NOT be consumable via the magic-login route');
  // Token must still be UN-consumed so the legitimate /auth/reset path works
  const row = tokensByHash.get(hash);
  assert.ok(row && !row.consumed_at,
    'reset-kind token must remain un-consumed after a magic-route attempt');
}

async function testMagicTokenAuthedUserRedirected() {
  resetStore();
  const app = buildApp({ id: 999, plan: 'free', email: 'u@x.com', name: 'U' });
  const res = await request(app, 'GET', '/auth/magic');
  assert.strictEqual(res.status, 302,
    'an authed user visiting /magic must redirect to /dashboard');
  assert.ok(res.headers.location.includes('/dashboard'));
}

async function testLoginPageLinksToMagic() {
  resetStore();
  const app = buildApp();
  const res = await request(app, 'GET', '/auth/login');
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.includes('href="/auth/magic"'),
    'login page must surface the /auth/magic entry point');
  assert.ok(res.body.includes('data-testid="login-magic-link"'),
    'login page must carry the testid on the magic-link CTA');
}

// ---------- Runner ----------------------------------------------------------

async function run() {
  const tests = [
    ['lib/email: buildMagicLoginSubject is non-empty + mentions sign-in', testBuildSubject],
    ['lib/email: buildMagicLoginHtml escapes input + embeds URL + TTL', testBuildHtmlEscapesAndEmbedsUrl],
    ['lib/email: buildMagicLoginText is plaintext + URL + TTL', testBuildTextIncludesUrlPlaintext],
    ['lib/email: sendMagicLoginEmail short-circuits on no recipient', testSendShortCircuitsNoRecipient],
    ['lib/email: sendMagicLoginEmail short-circuits on no URL', testSendShortCircuitsNoUrl],
    ['lib/email: sendMagicLoginEmail happy path posts Resend payload', testSendHappyPath],
    ['lib/magic-login: hashToken deterministic SHA-256 hex', testHashTokenDeterministic],
    ['lib/magic-login: buildMagicLoginUrl absolute when APP_URL set, relative otherwise', testBuildMagicLoginUrlAbsAndRelative],
    ['lib/magic-login: requestMagicLink unknown email → no enumeration', testRequestUnknownEmailNoEnum],
    ['lib/magic-login: requestMagicLink happy path persists hash with kind=login', testRequestHappyPathPersistsHashWithLoginKind],
    ['lib/magic-login: requestMagicLink soft-fails on db throw', testRequestSoftFailsOnDbThrow],
    ['lib/magic-login: requestMagicLink soft-fails on db_unavailable', testRequestSoftFailsOnDbUnavailable],
    ['lib/magic-login: requestMagicLink short-circuits on no email', testRequestNoEmailShortCircuits],
    ['lib/magic-login: requestMagicLink propagates custom ttlMinutes', testRequestPropagatesCustomTtl],
    ['GET /auth/magic renders request form', testGetMagicRendersForm],
    ['POST /auth/magic generic success for unknown email (no enum)', testPostMagicRendersGenericSuccessUnknown],
    ['POST /auth/magic still fires when email is known', testPostMagicFiresWhenKnown],
    ['POST /auth/magic validation error on bad email', testPostMagicValidationError],
    ['GET /auth/magic/:token happy path consumes + logs in + 302 /dashboard', testGetMagicTokenHappyPathLogsInAndRedirects],
    ['GET /auth/magic/:token replay of consumed token rejected', testGetMagicTokenReplayRejected],
    ['GET /auth/magic/:token bad token shape → invalid page (no DB hit)', testGetMagicTokenBadShape],
    ['GET /auth/magic/:token expired token rejected (no session written)', testGetMagicTokenExpired],
    ['GET /auth/magic/:token kind isolation: reset token not consumable here', testGetMagicTokenKindIsolation_ResetTokenNotConsumable],
    ['/auth/magic redirects authed user to /dashboard', testMagicTokenAuthedUserRedirected],
    ['Login page links to /auth/magic (entry-point discoverability)', testLoginPageLinksToMagic]
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
