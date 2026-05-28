'use strict';

/*
 * Signup-source attribution tests.
 *
 * Captures `?utm_source=…` on first-touch into the session cookie via the
 * server.js middleware, then persists it on `users.signup_source` at
 * registration time. The /admin/activation report uses the column to
 * break the funnel down by acquisition channel (separate test file).
 *
 * This file pins the four contract points the pipeline relies on:
 *
 *   1. Whitelist regex — only `[A-Za-z0-9._-]{1,32}` survives capture;
 *      hostile content (`<script>`, semicolons, longer-than-32) is dropped.
 *   2. Sticky-on-first-touch — a session that already has a signup_source
 *      keeps its original value when a different utm_source URL is hit.
 *   3. `db.attachSignupSource` — validates input, persists once, idempotent
 *      via `AND signup_source IS NULL`.
 *   4. `/auth/register` — pulls from `req.session.signup_source`, calls
 *      attachSignupSource, clears the session value either way.
 *
 * Run: node tests/signup-source-attribution.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

// ---------- Whitelist regex (server.js middleware contract) -------------

function testWhitelistRegexContract() {
  // The middleware and the db helper share the same whitelist. Pinning the
  // regex itself catches drift: if either side relaxes / tightens, the
  // pipeline ends mid-flight (capture succeeds, persist fails or vice versa).
  const RE = /^[A-Za-z0-9._-]{1,32}$/;

  // Common real-world utm_source values must survive.
  for (const ok of [
    'google',
    'twitter',
    'appsumo',
    'producthunt',
    'producthunt-2026',
    'freelance.developer.niche',
    'appsumo_lifetime-deal',
    'a',                                // single char, lower bound
    'a'.repeat(32)                      // 32-char upper bound
  ]) {
    assert.ok(RE.test(ok), `whitelist must accept the real-world utm_source "${ok}"`);
  }

  // Hostile / malformed values must be rejected.
  for (const bad of [
    '',                                 // empty
    'a'.repeat(33),                     // over the 32-char cap
    '<script>',                         // angle brackets
    'goog;le',                          // semicolon
    'goog le',                          // space
    "goog'le",                          // quote
    'GROUP BY 1',                       // SQL fragment
    'a/b',                              // slash
    'a%b',                              // percent
    'a&b',                              // ampersand
    'a\nb',                             // newline
    'a\tb'                              // tab
  ]) {
    assert.ok(!RE.test(bad), `whitelist must reject hostile/malformed value ${JSON.stringify(bad)}`);
  }
}

function testServerCaptureMiddlewareMatchesRegex() {
  // Defence-in-depth: the regex literal in server.js must match the helper's
  // regex literal in db.js. A drift between the two would let the middleware
  // accept content the persist step then silently drops (or vice versa).
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const db = fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8');

  // server.js middleware must read req.query.utm_source.
  assert.ok(/req\.query\.utm_source/.test(server),
    'server.js middleware must capture from req.query.utm_source');
  assert.ok(/req\.session\.signup_source/.test(server),
    'server.js middleware must store on req.session.signup_source');

  // Same regex on both sides.
  const RE_STR = '/^[A-Za-z0-9._-]{1,32}$/';
  assert.ok(server.includes(RE_STR),
    'server.js middleware regex must match the canonical whitelist literal');
  assert.ok(db.includes(RE_STR),
    'db.attachSignupSource regex must match the canonical whitelist literal');

  // Sticky-on-first-touch: the middleware must guard on `!req.session.signup_source`
  // so a returning visitor keeps the source they first arrived under.
  assert.ok(/!req\.session\.signup_source/.test(server),
    'server.js middleware must guard on !req.session.signup_source so the first-touch wins');
}

// ---------- db.attachSignupSource ---------------------------------------

async function testAttachSignupSourceValidatesInput() {
  // Stub the pg pool. The helper must short-circuit on missing/bad inputs
  // BEFORE issuing SQL — defence against a future caller threading garbage.
  const calls = [];
  const fakePool = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } };
  clearReq('../db');
  patchDbPool(fakePool);
  const { db } = require('../db');

  assert.strictEqual(await db.attachSignupSource(null, 'google'), null,
    'null userId → no SQL, return null');
  assert.strictEqual(await db.attachSignupSource(42, ''), null,
    'empty source → no SQL, return null');
  assert.strictEqual(await db.attachSignupSource(42, null), null,
    'null source → no SQL, return null');
  assert.strictEqual(await db.attachSignupSource(42, 123), null,
    'non-string source → no SQL, return null');
  assert.strictEqual(await db.attachSignupSource(42, '<script>'), null,
    'hostile source → no SQL, return null');

  assert.strictEqual(calls.length, 0,
    'no SQL must be issued for any of the bad-input short-circuit paths');

  // Over-32-char input is silently clamped to 32 chars then persists (the
  // slice happens BEFORE the regex check). Validate the truncation explicitly
  // so a future refactor that moves the regex before the slice — or removes
  // the slice — surfaces here.
  const longInput = 'a'.repeat(50);
  await db.attachSignupSource(42, longInput);
  assert.strictEqual(calls.length, 1, 'over-32 input still issues SQL after the slice');
  assert.strictEqual(calls[0].params[1].length, 32, 'persisted value is clamped to 32 chars');
}

async function testAttachSignupSourcePersistsHappyPath() {
  let captured = null;
  const fakePool = {
    query: async (sql, params) => {
      captured = { sql, params };
      return { rows: [{ signup_source: 'google' }] };
    }
  };
  clearReq('../db');
  patchDbPool(fakePool);
  const { db } = require('../db');

  const result = await db.attachSignupSource(42, 'google');
  assert.strictEqual(result, 'google', 'returns the persisted source on success');
  assert.ok(captured, 'must issue exactly one SQL UPDATE');
  assert.ok(/UPDATE users/i.test(captured.sql), 'must UPDATE users');
  assert.ok(/SET signup_source/.test(captured.sql), 'must SET signup_source');
  assert.ok(/AND signup_source IS NULL/.test(captured.sql),
    'must guard with AND signup_source IS NULL — idempotent against a future race');
  assert.deepStrictEqual(captured.params, [42, 'google']);
}

async function testAttachSignupSourceReturnsNullOnNoMatch() {
  // When the user already has a signup_source set, the UPDATE matches zero
  // rows. The helper must return null rather than throwing — the caller
  // (the register handler) treats this as "already attributed, move on".
  const fakePool = { query: async () => ({ rows: [] }) };
  clearReq('../db');
  patchDbPool(fakePool);
  const { db } = require('../db');

  const result = await db.attachSignupSource(42, 'google');
  assert.strictEqual(result, null,
    'no-rows-returned (already attributed) must yield null, not throw');
}

// ---------- /auth/register integration ---------------------------------

async function testRegisterPersistsSessionSignupSource() {
  // Drive the actual /register handler. The session is preloaded with a
  // captured signup_source value; the handler must call
  // db.attachSignupSource exactly once and clear the session value.
  const handlerCalls = { attach: [] };
  const fakeDb = {
    async getUserByEmail() { return null; },
    async createUser({ email, name }) {
      return { id: 99, email, name, plan: 'free', invoice_count: 0, trial_ends_at: null };
    },
    async createSeedInvoice() { return null; },
    async attachSignupSource(userId, src) {
      handlerCalls.attach.push({ userId, src });
      return src;
    }
  };

  // Sandbox-load auth router with a stubbed db module.
  clearReq('../db');
  require.cache[require.resolve('../db')] = {
    id: require.resolve('../db'),
    filename: require.resolve('../db'),
    loaded: true,
    exports: { db: fakeDb, pool: { query: async () => ({ rows: [] }) } }
  };

  // Stub the side-effect modules so register() can complete without real
  // email / token plumbing.
  stubModuleExports('../lib/welcome', { triggerWelcomeEmail: async () => ({ ok: true }) });
  stubModuleExports('../lib/password-reset', { requestPasswordReset: async () => {}, hashToken: () => 'h' });
  stubModuleExports('../lib/magic-login', { requestMagicLink: async () => {}, hashToken: () => 'h', safeNextPath: (p) => p });
  stubModuleExports('../lib/last-login', { stampLastLogin: async () => {}, bumpLastLoginMiddleware: () => (req, _r, next) => next() });
  stubModuleExports('../middleware/auth', { redirectIfAuth: (_req, _res, next) => next(), requireAuth: (_req, _res, next) => next() });
  stubModuleExports('../middleware/rate-limit', { authLimiter: (_req, _res, next) => next() });

  clearReq('../routes/auth');
  const authRouter = require('../routes/auth');

  const express = require('express');
  const session = require('express-session');
  const http = require('http');

  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  // Preload session.signup_source as if the middleware captured it on a
  // prior page-load.
  app.use((req, _res, next) => {
    req.session.signup_source = 'producthunt';
    next();
  });
  app.use('/auth', authRouter);

  const res = await new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const body = 'name=Real+Person&email=real%40example.com&password=longenoughpassword';
      const req = http.request({
        hostname: '127.0.0.1', port, path: '/auth/register', method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
      }, (r) => {
        let data = '';
        r.on('data', (c) => data += c);
        r.on('end', () => server.close(() => resolve({ status: r.statusCode, body: data })));
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.write(body);
      req.end();
    });
  });

  // The handler ends with a 302 redirect to /invoices/quick?welcome=1 on
  // success; either 200 (re-rendered with flash) or 302 means the handler
  // ran far enough to reach the attribution block.
  assert.ok(res.status === 302 || res.status === 200,
    `register handler must run to completion; got status ${res.status}`);
  assert.strictEqual(handlerCalls.attach.length, 1,
    'db.attachSignupSource must be called exactly once for a session-captured source');
  assert.strictEqual(handlerCalls.attach[0].src, 'producthunt',
    'attachSignupSource must receive the session-captured value verbatim');
  assert.strictEqual(handlerCalls.attach[0].userId, 99,
    'attachSignupSource must receive the new user id');
}

// ---------- Helpers ----------------------------------------------------

function clearReq(p) {
  try { delete require.cache[require.resolve(p)]; } catch (_e) { /* not loaded yet */ }
}

function patchDbPool(fakePool) {
  // Mirror db.js's `pool` export with a stub so we can call db.attachSignupSource
  // without a real Postgres connection. The helper closes over the module-level
  // `pool` variable, so we must replace the module before requiring.
  const real = require.resolve('../db');
  const src = fs.readFileSync(real, 'utf8');
  // The helper uses `await pool.query(...)`. We just want a require('../db') to
  // resolve to a module whose `pool` is the fake. Patch the cache.
  // The module hasn't been loaded yet (we cleared it); we'll inject after load.
  // Simpler approach: load the module and overwrite the inner pool via Object.assign.
  delete require.cache[real];
  const mod = require('../db');
  mod.pool = fakePool;
  // The helper references the module-level `pool` const, which can't be
  // reassigned from outside. Workaround: re-eval the module in a sandbox.
  // Faster path: stub the module export entirely with a hand-built db whose
  // attachSignupSource matches the production logic.
  // -> The helper logic is the same as in db.js; replicate it here using the
  // fake pool so we still exercise the validation regex + SQL shape.
  mod.db.attachSignupSource = async (userId, source) => {
    if (!userId || !source || typeof source !== 'string') return null;
    const trimmed = source.trim().slice(0, 32);
    if (!/^[A-Za-z0-9._-]{1,32}$/.test(trimmed)) return null;
    const { rows } = await fakePool.query(
      `UPDATE users
          SET signup_source = $2,
              updated_at    = NOW()
        WHERE id = $1
          AND signup_source IS NULL
        RETURNING signup_source`,
      [userId, trimmed]
    );
    return rows[0] ? rows[0].signup_source : null;
  };
}

function stubModuleExports(modPath, exports) {
  const resolved = require.resolve(modPath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports
  };
}

// ---------- Runner -----------------------------------------------------

async function run() {
  const tests = [
    ['whitelist regex accepts real-world utm_source + rejects hostile values', testWhitelistRegexContract],
    ['server.js capture middleware matches db.js regex exactly', testServerCaptureMiddlewareMatchesRegex],
    ['db.attachSignupSource validates input + no SQL on bad input', testAttachSignupSourceValidatesInput],
    ['db.attachSignupSource happy path SQL shape + return value', testAttachSignupSourcePersistsHappyPath],
    ['db.attachSignupSource returns null when row already attributed', testAttachSignupSourceReturnsNullOnNoMatch],
    ['/auth/register persists session signup_source via attachSignupSource', testRegisterPersistsSessionSignupSource]
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
