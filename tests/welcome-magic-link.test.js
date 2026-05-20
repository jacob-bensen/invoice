'use strict';

/*
 * Welcome-email magic-login bake-in (Milestone 1 — signup → first dashboard
 * re-entry). The welcome email's "Create your first invoice →" and "Start
 * your free Pro trial" CTAs carry a one-shot 7-day magic-login URL with a
 * `?next=` query, so a recipient who clicks days after signup lands
 * auto-signed-in on the target page instead of bouncing at /auth/login.
 *
 * Coverage:
 *  1.  lib/magic-login.safeNextPath: allow-list accepts known logged-in
 *      landing pages (including /invoices/quick — the welcome email's primary
 *      first-invoice CTA target since the 3-field express form ship) and
 *      rejects everything else (absolute URLs, protocol-relative `//evil.com`,
 *      `javascript:`, control characters, unknown app paths, non-strings,
 *      empty strings).
 *  2.  lib/magic-login.mintMagicLoginToken: db_unavailable when the db has
 *      no createPasswordResetToken; no_user when userId is falsy.
 *  3.  lib/magic-login.mintMagicLoginToken: persists with kind='login' and
 *      the requested TTL; returns { ok, token, url, expires_at, ttlMinutes }.
 *  4.  lib/magic-login.mintMagicLoginToken: defaults TTL to 30 minutes.
 *  5.  lib/magic-login.mintMagicLoginToken: soft-fails on createPasswordResetToken
 *      throw with reason='db_error' (never bubbles).
 *  6.  lib/email.buildWelcomeHtml with opts.magicLoginUrl embeds the magic
 *      URL with `?next=/invoices/quick` on the primary CTA and
 *      `?next=/billing/upgrade` on the secondary CTA.
 *  7.  lib/email.buildWelcomeText with opts.magicLoginUrl embeds the magic
 *      URL on both CTAs in plaintext form.
 *  8.  lib/email.buildWelcomeHtml without opts falls back to the plain
 *      APP_URL paths (regression guard — the bake-in is opt-in).
 *  9.  lib/welcome.triggerWelcomeEmail mints a 7-day magic-login token after
 *      markWelcomeEmailSent and passes the URL into sendWelcomeEmail.
 * 10.  lib/welcome.triggerWelcomeEmail still sends the email when the mint
 *      fails (graceful degradation: send goes out with plain CTAs).
 * 11.  routes/auth GET /auth/magic/:token honours ?next=/invoices/quick and
 *      redirects there after consume; session is written.
 * 12.  routes/auth GET /auth/magic/:token with an off-list ?next=
 *      (https://evil.com) falls back to /dashboard (open-redirect guard).
 * 13.  routes/auth GET /auth/magic/:token with no ?next= redirects to
 *      /dashboard (backward compat).
 * 14.  routes/auth GET /auth/magic/:token for an already-authed user with
 *      ?next=/invoices/quick redirects to /invoices/quick without consuming
 *      the token (so the welcome CTA works from the same browser used for
 *      signup).
 * 15.  routes/auth GET /auth/magic/:token with a CRLF-injection ?next= falls
 *      back to /dashboard (header-injection guard).
 *
 * Run: NODE_ENV=test node tests/welcome-magic-link.test.js
 */

const assert = require('assert');
const path = require('path');
const express = require('express');
const session = require('express-session');
const http = require('http');
const crypto = require('crypto');

function clearReq(mod) { delete require.cache[require.resolve(mod)]; }

// ---------- safeNextPath -----------------------------------------------------

async function testSafeNextAllowList() {
  clearReq('../lib/magic-login');
  const { safeNextPath } = require('../lib/magic-login');
  assert.strictEqual(safeNextPath('/dashboard'), '/dashboard');
  assert.strictEqual(safeNextPath('/invoices'), '/invoices');
  assert.strictEqual(safeNextPath('/invoices/new'), '/invoices/new');
  assert.strictEqual(safeNextPath('/invoices/quick'), '/invoices/quick',
    '/invoices/quick must be on the allow-list — the welcome email\'s primary CTA targets it');
  assert.strictEqual(safeNextPath('/billing/upgrade'), '/billing/upgrade');
  assert.strictEqual(safeNextPath('/settings'), '/settings');
}

async function testSafeNextInvoiceIdPattern() {
  clearReq('../lib/magic-login');
  const { safeNextPath } = require('../lib/magic-login');
  // Specific-invoice deep-links must pass so the stale-draft email CTA can
  // land users straight on their own draft after auto-sign-in (instead of the
  // /dashboard fallback, which loses the deep-link).
  assert.strictEqual(safeNextPath('/invoices/1'), '/invoices/1',
    'single-digit invoice id must pass — the stale-draft reminder targets one row');
  assert.strictEqual(safeNextPath('/invoices/7'), '/invoices/7');
  assert.strictEqual(safeNextPath('/invoices/12345'), '/invoices/12345',
    'multi-digit invoice id must pass');
}

async function testSafeNextRejectsEverythingElse() {
  clearReq('../lib/magic-login');
  const { safeNextPath } = require('../lib/magic-login');
  // Absolute URLs and schemes
  assert.strictEqual(safeNextPath('https://evil.com/dashboard'), null,
    'absolute URLs must be rejected');
  assert.strictEqual(safeNextPath('http://x'), null);
  assert.strictEqual(safeNextPath('javascript:alert(1)'), null,
    'javascript: scheme must be rejected');
  assert.strictEqual(safeNextPath('data:text/html,x'), null);
  // Protocol-relative
  assert.strictEqual(safeNextPath('//evil.com'), null,
    'protocol-relative URLs must be rejected');
  assert.strictEqual(safeNextPath('//evil.com/dashboard'), null);
  // Off-list app paths
  assert.strictEqual(safeNextPath('/admin/activation'), null,
    'unknown app paths must NOT be honoured even if they start with /');
  assert.strictEqual(safeNextPath('/auth/login'), null);
  assert.strictEqual(safeNextPath('/'), null);
  // Invoice-id pattern boundaries — must NOT match anything but a bare
  // positive integer. These are the easy widening mistakes a refactor could
  // make (sub-routes, leading zeros, negatives, decimals, non-digit suffix).
  assert.strictEqual(safeNextPath('/invoices/0'), null,
    '/invoices/0 must be rejected — SERIAL starts at 1, 0 is never a real id');
  assert.strictEqual(safeNextPath('/invoices/-1'), null,
    'negative ids must be rejected');
  assert.strictEqual(safeNextPath('/invoices/01'), null,
    'leading-zero ids must be rejected (no path-normalisation ambiguity)');
  assert.strictEqual(safeNextPath('/invoices/1.5'), null,
    'decimal ids must be rejected');
  assert.strictEqual(safeNextPath('/invoices/abc'), null,
    'non-numeric ids must be rejected');
  assert.strictEqual(safeNextPath('/invoices/1abc'), null,
    'mixed alpha-numeric ids must be rejected');
  assert.strictEqual(safeNextPath('/invoices/1/edit'), null,
    'sub-routes off the invoice id must be rejected — pattern is strictly /invoices/<id> with no trailing segment');
  assert.strictEqual(safeNextPath('/invoices/1?foo=bar'), null,
    'query strings must be rejected — bake them into the magic URL itself, not the next path');
  assert.strictEqual(safeNextPath('/invoices/1#frag'), null,
    'fragments must be rejected');
  assert.strictEqual(safeNextPath('/invoices//1'), null,
    'double-slash must be rejected');
  // Bad types / empty
  assert.strictEqual(safeNextPath(''), null);
  assert.strictEqual(safeNextPath(null), null);
  assert.strictEqual(safeNextPath(undefined), null);
  assert.strictEqual(safeNextPath(42), null);
  assert.strictEqual(safeNextPath({}), null);
  assert.strictEqual(safeNextPath('   '), null);
  // Control chars (header-injection guard)
  assert.strictEqual(safeNextPath('/dashboard\r\nLocation: https://evil.com'), null,
    'CRLF injection must be rejected before allow-list lookup');
  assert.strictEqual(safeNextPath('/dashboard\nfoo'), null);
  assert.strictEqual(safeNextPath('/dashboard\tfoo'), null);
  assert.strictEqual(safeNextPath('/invoices/1\r\nLocation: x'), null,
    'CRLF injection against the invoice-id pattern must be rejected too');
}

// ---------- mintMagicLoginToken ---------------------------------------------

async function testMintNoDb() {
  clearReq('../lib/magic-login');
  const { mintMagicLoginToken } = require('../lib/magic-login');
  const r = await mintMagicLoginToken({}, 7);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'db_unavailable');
}

async function testMintNoUser() {
  clearReq('../lib/magic-login');
  const { mintMagicLoginToken } = require('../lib/magic-login');
  const db = { createPasswordResetToken: async () => ({ id: 1, expires_at: new Date(), kind: 'login' }) };
  const r = await mintMagicLoginToken(db, null);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no_user');
  const r2 = await mintMagicLoginToken(db, 0);
  assert.strictEqual(r2.reason, 'no_user');
}

async function testMintHappyPath() {
  clearReq('../lib/magic-login');
  const oldAppUrl = process.env.APP_URL;
  process.env.APP_URL = 'https://invoice.example.com';
  const { mintMagicLoginToken, hashToken, WELCOME_TTL_MINUTES } = require('../lib/magic-login');
  const calls = [];
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const db = {
    createPasswordResetToken: async (userId, tokenHash, ttlMinutes, kind) => {
      calls.push({ userId, tokenHash, ttlMinutes, kind });
      return { id: 42, expires_at: expires, kind };
    }
  };
  const r = await mintMagicLoginToken(db, 7, { ttlMinutes: WELCOME_TTL_MINUTES });
  process.env.APP_URL = oldAppUrl;
  assert.strictEqual(r.ok, true);
  assert.ok(/^[a-f0-9]{64}$/i.test(r.token), 'token must be 64-hex (32 random bytes)');
  assert.strictEqual(r.url, `https://invoice.example.com/auth/magic/${r.token}`);
  assert.strictEqual(r.expires_at, expires);
  assert.strictEqual(r.ttlMinutes, WELCOME_TTL_MINUTES);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].userId, 7);
  assert.strictEqual(calls[0].kind, 'login',
    'mint must persist with kind=login so consumeMagicLoginToken accepts it');
  assert.strictEqual(calls[0].ttlMinutes, WELCOME_TTL_MINUTES);
  assert.strictEqual(calls[0].tokenHash, hashToken(r.token),
    'persisted hash must match the SHA-256 of the returned token');
  assert.ok(WELCOME_TTL_MINUTES >= 6 * 24 * 60,
    'WELCOME_TTL_MINUTES must be at least 6 days so weekend-clicked welcomes still consume');
}

async function testMintDefaultTtl() {
  clearReq('../lib/magic-login');
  const { mintMagicLoginToken, DEFAULT_TTL_MINUTES } = require('../lib/magic-login');
  const calls = [];
  const db = {
    createPasswordResetToken: async (userId, tokenHash, ttlMinutes, kind) => {
      calls.push({ ttlMinutes });
      return { id: 1, expires_at: new Date(), kind };
    }
  };
  await mintMagicLoginToken(db, 11);
  assert.strictEqual(calls[0].ttlMinutes, DEFAULT_TTL_MINUTES,
    'absent opts.ttlMinutes must fall back to DEFAULT_TTL_MINUTES');
}

async function testMintSoftFailsOnDbThrow() {
  clearReq('../lib/magic-login');
  const { mintMagicLoginToken } = require('../lib/magic-login');
  const db = {
    createPasswordResetToken: async () => { throw new Error('pool exploded'); }
  };
  const r = await mintMagicLoginToken(db, 7);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'db_error',
    'db throw must surface as soft-failure (never bubbles into the welcome flow)');
  assert.ok(r.error && r.error.includes('pool exploded'));
}

// ---------- buildWelcomeHtml / buildWelcomeText with magicLoginUrl ----------

async function testBuildHtmlWithMagicLoginUrl() {
  clearReq('../lib/email');
  const oldAppUrl = process.env.APP_URL;
  process.env.APP_URL = 'https://invoice.example.com';
  const email = require('../lib/email');
  const magicLoginUrl = 'https://invoice.example.com/auth/magic/' + 'a'.repeat(64);
  const html = email.buildWelcomeHtml({ name: 'Alice', email: 'a@x.com' }, { magicLoginUrl });
  process.env.APP_URL = oldAppUrl;
  // Primary CTA → /invoices/quick via magic-link (the 3-field express form —
  // lowest-friction Milestone 2 path).
  assert.ok(html.includes(`${magicLoginUrl}?next=/invoices/quick`),
    'primary CTA href must wrap the magic-login URL with ?next=/invoices/quick');
  // Secondary CTA → /billing/upgrade via magic-link
  assert.ok(html.includes(`${magicLoginUrl}?next=/billing/upgrade`),
    'pro-trial CTA href must wrap the magic-login URL with ?next=/billing/upgrade');
  // The bare APP_URL paths must NOT be present as CTA hrefs — the magic URL
  // is the single source of truth for the clickable target.
  assert.ok(!/href="https:\/\/invoice\.example\.com\/invoices\/quick"/.test(html),
    'plain /invoices/quick href must be replaced by the magic-link URL on the primary CTA');
  assert.ok(!/href="https:\/\/invoice\.example\.com\/billing\/upgrade"/.test(html),
    'plain /billing/upgrade href must be replaced by the magic-link URL on the pro CTA');
}

async function testBuildTextWithMagicLoginUrl() {
  clearReq('../lib/email');
  const oldAppUrl = process.env.APP_URL;
  process.env.APP_URL = 'https://invoice.example.com';
  const email = require('../lib/email');
  const magicLoginUrl = 'https://invoice.example.com/auth/magic/' + 'b'.repeat(64);
  const text = email.buildWelcomeText({ name: 'Bob', email: 'b@x.com' }, { magicLoginUrl });
  process.env.APP_URL = oldAppUrl;
  assert.ok(text.includes(`${magicLoginUrl}?next=/invoices/quick`),
    'plaintext must include the magic-link URL with ?next=/invoices/quick');
  assert.ok(text.includes(`${magicLoginUrl}?next=/billing/upgrade`),
    'plaintext must include the magic-link URL with ?next=/billing/upgrade');
}

async function testBuildHtmlWithoutOptsKeepsLegacyLinks() {
  clearReq('../lib/email');
  const oldAppUrl = process.env.APP_URL;
  process.env.APP_URL = 'https://invoice.example.com';
  const email = require('../lib/email');
  const html = email.buildWelcomeHtml({ name: 'Alice', email: 'a@x.com' });
  process.env.APP_URL = oldAppUrl;
  assert.ok(html.includes('https://invoice.example.com/invoices/quick'),
    'absent opts.magicLoginUrl must fall back to the plain /invoices/quick path');
  assert.ok(html.includes('https://invoice.example.com/billing/upgrade'),
    'absent opts.magicLoginUrl must fall back to the plain /billing/upgrade path');
  assert.ok(!html.includes('/auth/magic/'),
    'absent opts.magicLoginUrl must NOT embed any /auth/magic/ path');
}

// ---------- triggerWelcomeEmail orchestrator with bake-in --------------------

async function testTriggerWelcomePassesMagicUrlIntoSend() {
  clearReq('../lib/email');
  clearReq('../lib/magic-login');
  clearReq('../lib/welcome');
  const oldAppUrl = process.env.APP_URL;
  process.env.APP_URL = 'https://invoice.example.com';
  const email = require('../lib/email');
  const sends = [];
  email.setResendClient({
    emails: {
      async send(payload) { sends.push(payload); return { data: { id: 'em_42' }, error: null }; }
    }
  });
  const { triggerWelcomeEmail } = require('../lib/welcome');
  const { WELCOME_TTL_MINUTES } = require('../lib/magic-login');

  const mintCalls = [];
  const db = {
    markWelcomeEmailSent: async (id) => ({ id, email: 'alice@x.com', name: 'Alice', plan: 'free' }),
    createPasswordResetToken: async (userId, tokenHash, ttlMinutes, kind) => {
      mintCalls.push({ userId, tokenHash, ttlMinutes, kind });
      return { id: 99, expires_at: new Date(Date.now() + ttlMinutes * 60000), kind };
    }
  };
  const r = await triggerWelcomeEmail(db, 7);
  process.env.APP_URL = oldAppUrl;
  email.resetResendClient();

  assert.strictEqual(r.ok, true, 'happy path must succeed');
  assert.ok(r.magicLoginUrl,
    'orchestrator must surface the minted magic-login URL on its result');
  assert.strictEqual(mintCalls.length, 1, 'mint called exactly once');
  assert.strictEqual(mintCalls[0].userId, 7);
  assert.strictEqual(mintCalls[0].kind, 'login');
  assert.strictEqual(mintCalls[0].ttlMinutes, WELCOME_TTL_MINUTES,
    'mint must use WELCOME_TTL_MINUTES (7 days) so weekend-clicked welcomes still consume');

  assert.strictEqual(sends.length, 1, 'email sent exactly once');
  const payload = sends[0];
  assert.ok(payload.html.includes('/auth/magic/'),
    'sent HTML must embed the magic-login token URL');
  assert.ok(payload.html.includes('?next=/invoices/quick'),
    'sent HTML primary CTA must carry ?next=/invoices/quick');
  assert.ok(payload.html.includes('?next=/billing/upgrade'),
    'sent HTML pro CTA must carry ?next=/billing/upgrade');
  assert.ok(payload.text.includes('/auth/magic/'),
    'plaintext must also embed the magic-link URL');
  assert.ok(payload.text.includes('?next=/invoices/quick'));
}

async function testTriggerWelcomeMintFailureStillSends() {
  clearReq('../lib/email');
  clearReq('../lib/magic-login');
  clearReq('../lib/welcome');
  const oldAppUrl = process.env.APP_URL;
  process.env.APP_URL = 'https://invoice.example.com';
  const email = require('../lib/email');
  const sends = [];
  email.setResendClient({
    emails: {
      async send(payload) { sends.push(payload); return { data: { id: 'em_43' }, error: null }; }
    }
  });
  const { triggerWelcomeEmail } = require('../lib/welcome');

  const db = {
    markWelcomeEmailSent: async (id) => ({ id, email: 'bob@x.com', name: 'Bob', plan: 'free' }),
    createPasswordResetToken: async () => { throw new Error('table missing'); }
  };
  const r = await triggerWelcomeEmail(db, 11);
  process.env.APP_URL = oldAppUrl;
  email.resetResendClient();

  assert.strictEqual(r.ok, true,
    'mint failure must NOT block the welcome email from going out');
  assert.strictEqual(r.magicLoginUrl, null,
    'orchestrator must surface null magicLoginUrl when the mint failed');
  assert.strictEqual(sends.length, 1, 'email still sent exactly once');
  const payload = sends[0];
  assert.ok(payload.html.includes('https://invoice.example.com/invoices/quick'),
    'fallback HTML must use the plain /invoices/quick path when the mint failed');
  assert.ok(!payload.html.includes('/auth/magic/'),
    'fallback HTML must NOT contain a /auth/magic/ URL when the mint failed');
}

// ---------- Route integration: ?next= behaviour on consume ------------------

const usersById = new Map();
const usersByEmail = new Map();
const tokensByHash = new Map();
let nextUserId = 700;
let nextTokenId = 1;

function resetStore() {
  usersById.clear();
  usersByEmail.clear();
  tokensByHash.clear();
  nextUserId = 700;
  nextTokenId = 1;
}

function seedUser(overrides = {}) {
  const u = Object.assign({
    id: nextUserId++,
    email: 'route@x.com',
    name: 'Route',
    password_hash: 'hashed:pw',
    plan: 'free',
    invoice_count: 0,
    subscription_status: null,
    trial_ends_at: null
  }, overrides);
  usersById.set(u.id, u);
  usersByEmail.set(u.email, u);
  return u;
}

function seedToken({ userId, tokenHash, kind = 'login', expiresInMinutes = 30, consumed = false }) {
  const row = {
    id: nextTokenId++,
    user_id: userId,
    token_hash: tokenHash,
    expires_at: new Date(Date.now() + expiresInMinutes * 60000),
    consumed_at: consumed ? new Date() : null,
    kind
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
    },
    async findValidPasswordResetByHash() { return null; },
    async consumePasswordResetAndSetPassword() { return null; }
  },
  pool: { query: async () => ({ rows: [] }) }
};

require.cache[require.resolve('../db')] = {
  id: require.resolve('../db'),
  filename: require.resolve('../db'),
  loaded: true,
  exports: dbStub
};

// Stub welcome / password-reset orchestrators so route load resolves cleanly.
require.cache[require.resolve('../lib/welcome')] = {
  id: require.resolve('../lib/welcome'),
  filename: require.resolve('../lib/welcome'),
  loaded: true,
  exports: { triggerWelcomeEmail: async () => ({ ok: true }) }
};
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
  app.use((req, res, next) => { res.locals.user = req.session.user || null; next(); });
  app.use('/auth', authRoutes);
  app.get('/dashboard', (req, res) => {
    if (!req.session.user) return res.status(401).send('unauth');
    res.send(`dashboard:${req.session.user.id}`);
  });
  app.get('/invoices/new', (req, res) => {
    if (!req.session.user) return res.status(401).send('unauth');
    res.send(`new-invoice:${req.session.user.id}`);
  });
  app.get('/invoices/quick', (req, res) => {
    if (!req.session.user) return res.status(401).send('unauth');
    res.send(`quick-invoice:${req.session.user.id}`);
  });
  app.get('/billing/upgrade', (req, res) => {
    if (!req.session.user) return res.status(401).send('unauth');
    res.send(`upgrade:${req.session.user.id}`);
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

async function testNextHonouredOnHappyPath() {
  resetStore();
  const u = seedUser({ id: 801, email: 'next-happy@x.com' });
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = require('../lib/magic-login').hashToken(raw);
  seedToken({ userId: u.id, tokenHash: hash, kind: 'login' });
  const app = buildApp();
  const jar = {};
  const res = await request(app, 'GET', `/auth/magic/${raw}?next=/invoices/quick`, null, jar);
  assert.strictEqual(res.status, 302, 'happy-path consume must redirect');
  assert.strictEqual(res.headers.location, '/invoices/quick',
    'consume must redirect to ?next= when on the allow-list');
  const followed = await request(app, 'GET', '/invoices/quick', null, jar);
  assert.strictEqual(followed.status, 200, 'session must be set so /invoices/quick resolves');
  assert.strictEqual(followed.body, `quick-invoice:${u.id}`);
  const row = tokensByHash.get(hash);
  assert.ok(row && row.consumed_at, 'token must be consumed on the next-honoured path');
}

async function testNextOpenRedirectGuard() {
  resetStore();
  const u = seedUser({ id: 802, email: 'next-evil@x.com' });
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = require('../lib/magic-login').hashToken(raw);
  seedToken({ userId: u.id, tokenHash: hash, kind: 'login' });
  const app = buildApp();
  const jar = {};
  const res = await request(app, 'GET', `/auth/magic/${raw}?next=https://evil.com`, null, jar);
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.location, '/dashboard',
    'off-list ?next= must fall back to /dashboard (open-redirect guard)');
  // Token must still be consumed (we did sign the user in).
  const row = tokensByHash.get(hash);
  assert.ok(row && row.consumed_at, 'token still consumes even when next is rejected');
}

async function testNextAbsentBackwardCompat() {
  resetStore();
  const u = seedUser({ id: 803, email: 'next-absent@x.com' });
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = require('../lib/magic-login').hashToken(raw);
  seedToken({ userId: u.id, tokenHash: hash, kind: 'login' });
  const app = buildApp();
  const res = await request(app, 'GET', `/auth/magic/${raw}`);
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.location, '/dashboard',
    'absent ?next= must keep the pre-existing /dashboard redirect (regression guard)');
}

async function testAuthedUserClickingWelcomeCtaLandsAtNext() {
  resetStore();
  // User was just signed up + is still in-session on the same browser when
  // they hop over to their inbox and click the welcome email CTA. They
  // should land on /invoices/quick, not bounce to /dashboard, and we must NOT
  // consume the still-valid token (so they can click the CTA again later).
  const u = seedUser({ id: 804, email: 'authed@x.com' });
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = require('../lib/magic-login').hashToken(raw);
  seedToken({ userId: u.id, tokenHash: hash, kind: 'login' });
  const app = buildApp({ id: u.id, email: u.email, name: u.name, plan: u.plan });
  const res = await request(app, 'GET', `/auth/magic/${raw}?next=/invoices/quick`);
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.location, '/invoices/quick',
    'authed user with allowed ?next= must be forwarded there');
  const row = tokensByHash.get(hash);
  assert.ok(row && !row.consumed_at,
    'token MUST NOT be consumed when the user is already signed in (re-clickable)');
}

async function testCrlfInjectionInNextRejected() {
  resetStore();
  const u = seedUser({ id: 805, email: 'crlf@x.com' });
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = require('../lib/magic-login').hashToken(raw);
  seedToken({ userId: u.id, tokenHash: hash, kind: 'login' });
  const app = buildApp();
  // %0d%0a is CRLF — a classic response-splitting payload. URL-decoded the
  // query value contains \r\n; safeNextPath must reject it before reaching
  // the Location header so the browser never sees a spliced header.
  const res = await request(app, 'GET', `/auth/magic/${raw}?next=%2Fdashboard%0d%0aLocation:%20https://evil.com`);
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.location, '/dashboard',
    'CRLF-laced next must fall back to /dashboard');
  // Location header must not contain any \r or \n leftover.
  assert.ok(!/\r|\n/.test(res.headers.location),
    'response Location header must be free of CR/LF');
}

// ---------- Driver -----------------------------------------------------------

(async () => {
  const tests = [
    ['lib/magic-login: safeNextPath accepts allow-list paths', testSafeNextAllowList],
    ['lib/magic-login: safeNextPath accepts /invoices/<positive-int> deep-link', testSafeNextInvoiceIdPattern],
    ['lib/magic-login: safeNextPath rejects everything else', testSafeNextRejectsEverythingElse],
    ['lib/magic-login: mintMagicLoginToken db_unavailable on missing method', testMintNoDb],
    ['lib/magic-login: mintMagicLoginToken no_user on falsy userId', testMintNoUser],
    ['lib/magic-login: mintMagicLoginToken happy path persists kind=login', testMintHappyPath],
    ['lib/magic-login: mintMagicLoginToken default TTL', testMintDefaultTtl],
    ['lib/magic-login: mintMagicLoginToken soft-fails on db throw', testMintSoftFailsOnDbThrow],
    ['lib/email: buildWelcomeHtml with opts.magicLoginUrl embeds magic CTAs', testBuildHtmlWithMagicLoginUrl],
    ['lib/email: buildWelcomeText with opts.magicLoginUrl embeds magic CTAs', testBuildTextWithMagicLoginUrl],
    ['lib/email: buildWelcomeHtml without opts falls back to plain links', testBuildHtmlWithoutOptsKeepsLegacyLinks],
    ['lib/welcome: triggerWelcomeEmail bakes magic URL into the send', testTriggerWelcomePassesMagicUrlIntoSend],
    ['lib/welcome: triggerWelcomeEmail still sends when the mint fails', testTriggerWelcomeMintFailureStillSends],
    ['GET /auth/magic/:token?next=/invoices/quick redirects there', testNextHonouredOnHappyPath],
    ['GET /auth/magic/:token?next=https://evil.com falls back to /dashboard', testNextOpenRedirectGuard],
    ['GET /auth/magic/:token (no next) redirects /dashboard', testNextAbsentBackwardCompat],
    ['GET /auth/magic/:token authed-user with ?next= forwards without consume', testAuthedUserClickingWelcomeCtaLandsAtNext],
    ['GET /auth/magic/:token rejects CRLF-laced next', testCrlfInjectionInNextRejected]
  ];

  let passed = 0;
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log('  ok ', name);
      passed += 1;
    } catch (err) {
      console.error('  FAIL', name);
      console.error('       ', err && err.stack ? err.stack : err);
      failed += 1;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
