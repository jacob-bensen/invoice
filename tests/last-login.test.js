'use strict';

/*
 * last_login_at stamping (Milestone 1 — signup → first dashboard re-entry).
 * The PLAN.md "Done means" funnel calls out an explicit `re-entered` stage
 * between welcomed and created_real. Until this ship, `last_login_at` did
 * not exist on the users row, so the activation report could not measure
 * the welcome→return drop-off. Covers:
 *
 *   - lib/last-login.stampLastLogin: returns ok=false on invalid db / null
 *     userId; calls db.markLastLogin and returns the row on success;
 *     swallows a DB throw into ok=false (never propagates).
 *
 *   - lib/last-login.bumpLastLoginMiddleware: skips on unauthenticated
 *     requests; calls db.bumpLastLoginIfStale with the configured stale
 *     window when authenticated; never awaits / never blocks next();
 *     swallows a synchronous error AND a Promise rejection so a slow/down
 *     DB cannot stall every authenticated page load.
 *
 *   - integration: POST /auth/login fires stampLastLogin on success;
 *     auth/magic/<token> consume fires it; auth/reset/<token> POST fires it;
 *     POST /auth/register does NOT fire it (signup is not a re-entry).
 *
 * Run: NODE_ENV=test node tests/last-login.test.js
 */

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

const assert = require('assert');

function clearReq(mod) { delete require.cache[require.resolve(mod)]; }

// ---------- stampLastLogin --------------------------------------------------

async function testStampLastLoginInvalidDb() {
  clearReq('../lib/last-login');
  const { stampLastLogin } = require('../lib/last-login');
  const r1 = await stampLastLogin(null, 42);
  assert.strictEqual(r1.ok, false);
  assert.strictEqual(r1.reason, 'invalid_db');
  const r2 = await stampLastLogin({}, 42); // no markLastLogin method
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.reason, 'invalid_db');
}

async function testStampLastLoginInvalidUserId() {
  clearReq('../lib/last-login');
  const { stampLastLogin } = require('../lib/last-login');
  const db = { markLastLogin: async () => { throw new Error('must not call'); } };
  for (const bad of [null, undefined, 0, '', NaN]) {
    const r = await stampLastLogin(db, bad);
    assert.strictEqual(r.ok, false, `userId=${bad} → ok=false`);
    assert.strictEqual(r.reason, 'invalid_user_id');
  }
}

async function testStampLastLoginHappyPath() {
  clearReq('../lib/last-login');
  const { stampLastLogin } = require('../lib/last-login');
  const calls = [];
  const db = {
    async markLastLogin(id) {
      calls.push(id);
      return { id, last_login_at: new Date('2026-05-24T12:34:56Z') };
    }
  };
  const r = await stampLastLogin(db, 17);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.row.id, 17);
  assert.deepStrictEqual(calls, [17], 'must pass userId through unchanged');
}

async function testStampLastLoginSwallowsDbThrow() {
  clearReq('../lib/last-login');
  const { stampLastLogin } = require('../lib/last-login');
  const db = {
    async markLastLogin() { throw new Error('connection terminated'); }
  };
  const r = await stampLastLogin(db, 42);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'db_error');
  assert.ok(/connection terminated/.test(r.error || ''),
    'underlying error message must be threaded through for debuggability');
}

// ---------- bumpLastLoginMiddleware -----------------------------------------

async function testMiddlewareSkipsUnauthenticated() {
  clearReq('../lib/last-login');
  const { bumpLastLoginMiddleware } = require('../lib/last-login');
  let called = false;
  const db = { bumpLastLoginIfStale: async () => { called = true; } };
  const mw = bumpLastLoginMiddleware({ db });
  let nextCalled = false;
  mw({ session: {} }, {}, () => { nextCalled = true; });
  // Wait for any microtask scheduling to settle.
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(nextCalled, true, 'next() must always fire');
  assert.strictEqual(called, false, 'no DB call when there is no session user');
}

async function testMiddlewareSkipsNoSession() {
  clearReq('../lib/last-login');
  const { bumpLastLoginMiddleware } = require('../lib/last-login');
  let called = false;
  const db = { bumpLastLoginIfStale: async () => { called = true; } };
  const mw = bumpLastLoginMiddleware({ db });
  let nextCalled = false;
  mw({}, {}, () => { nextCalled = true; }); // no session at all
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(nextCalled, true);
  assert.strictEqual(called, false, 'missing req.session is a clean skip — no crash');
}

async function testMiddlewareCallsBumpOnAuthenticated() {
  clearReq('../lib/last-login');
  const { bumpLastLoginMiddleware } = require('../lib/last-login');
  const calls = [];
  const db = {
    async bumpLastLoginIfStale(id, mins) {
      calls.push({ id, mins });
      return { id, last_login_at: new Date() };
    }
  };
  const mw = bumpLastLoginMiddleware({ db, staleAfterMinutes: 60 });
  let nextCalled = false;
  mw({ session: { user: { id: 42 } } }, {}, () => { nextCalled = true; });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(nextCalled, true, 'next() must fire before the DB call resolves');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].id, 42);
  assert.strictEqual(calls[0].mins, 60, 'staleAfterMinutes must thread through unchanged');
}

async function testMiddlewareDefaultsStaleWindowTo240Minutes() {
  clearReq('../lib/last-login');
  const { bumpLastLoginMiddleware, DEFAULT_STALE_AFTER_MINUTES } = require('../lib/last-login');
  assert.strictEqual(DEFAULT_STALE_AFTER_MINUTES, 240,
    '4-hour default keeps post-signup dashboard load from satisfying a "returned" gate');
  const calls = [];
  const db = {
    async bumpLastLoginIfStale(id, mins) { calls.push({ id, mins }); return null; }
  };
  const mw = bumpLastLoginMiddleware({ db });
  mw({ session: { user: { id: 7 } } }, {}, () => {});
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(calls[0].mins, 240);
}

async function testMiddlewareNeverBlocksOnDbThrow() {
  clearReq('../lib/last-login');
  const { bumpLastLoginMiddleware } = require('../lib/last-login');
  const db = {
    async bumpLastLoginIfStale() { throw new Error('boom'); }
  };
  const warns = [];
  const log = { warn: (...args) => warns.push(args.join(' ')) };
  const mw = bumpLastLoginMiddleware({ db, log });
  let nextCalled = false;
  mw({ session: { user: { id: 1 } } }, {}, () => { nextCalled = true; });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(nextCalled, true, 'next() must still fire on a DB throw');
  assert.strictEqual(warns.length, 1, 'one warn line per failure');
  assert.ok(/bumpLastLoginIfStale failed/.test(warns[0]),
    'log must name the source so an operator can correlate');
}

async function testMiddlewareNeverBlocksOnSynchronousThrow() {
  clearReq('../lib/last-login');
  const { bumpLastLoginMiddleware } = require('../lib/last-login');
  // db.bumpLastLoginIfStale that throws synchronously (not a Promise).
  const db = {
    bumpLastLoginIfStale() { throw new Error('sync boom'); }
  };
  const warns = [];
  const log = { warn: (...args) => warns.push(args.join(' ')) };
  const mw = bumpLastLoginMiddleware({ db, log });
  let nextCalled = false;
  mw({ session: { user: { id: 5 } } }, {}, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true, 'sync throw must not block next()');
  assert.strictEqual(warns.length, 1);
  assert.ok(/bumpLastLoginMiddleware error/.test(warns[0]),
    'synchronous-throw path must log under a distinct prefix for triage');
}

async function testMiddlewareNeverAwaitsBeforeNext() {
  clearReq('../lib/last-login');
  const { bumpLastLoginMiddleware } = require('../lib/last-login');
  // bumpLastLoginIfStale that takes a long time to resolve — middleware must
  // call next() before it settles.
  let resolveDb;
  const db = {
    bumpLastLoginIfStale: () => new Promise((r) => { resolveDb = r; })
  };
  const mw = bumpLastLoginMiddleware({ db });
  let nextCalledAt = 0;
  const start = Date.now();
  mw({ session: { user: { id: 9 } } }, {}, () => { nextCalledAt = Date.now(); });
  assert.ok(nextCalledAt >= start, 'next() must have fired by the time we get here');
  assert.ok(nextCalledAt - start < 50,
    'next() must fire essentially synchronously, not after the DB call resolves');
  // Resolve to avoid an unhandled-promise warning in the test harness.
  resolveDb && resolveDb(null);
}

async function testMiddlewareInvalidStaleAfterMinutesFallsBackToDefault() {
  clearReq('../lib/last-login');
  const { bumpLastLoginMiddleware } = require('../lib/last-login');
  for (const bad of [-1, 0, 'forty', NaN, null]) {
    const calls = [];
    const db = {
      async bumpLastLoginIfStale(_id, mins) { calls.push(mins); return null; }
    };
    const mw = bumpLastLoginMiddleware({ db, staleAfterMinutes: bad });
    mw({ session: { user: { id: 1 } } }, {}, () => {});
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(calls[0], 240, `${bad} must fall back to 240`);
  }
}

// ---------- Auth route integration -----------------------------------------

// These tests exercise the auth router against an in-memory db stub, looking
// only at whether markLastLogin was invoked on the relevant success path.

const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');

let lastLoginCalls = [];
let getUserByEmailReturn = null;
let createUserReturn = null;
let consumeMagicReturn = null;
let consumeResetReturn = null;

function resetAuthStubs() {
  lastLoginCalls = [];
  getUserByEmailReturn = null;
  createUserReturn = null;
  consumeMagicReturn = null;
  consumeResetReturn = null;
}

const fakeDbModule = {
  pool: { query: async () => ({ rows: [] }) },
  db: {
    async getUserByEmail(email) { return getUserByEmailReturn; },
    async getUserById(id) { return null; },
    async createUser({ email, password_hash, name }) {
      const u = createUserReturn || { id: 99, email, password_hash, name, plan: 'free', invoice_count: 0 };
      return u;
    },
    async createSeedInvoice() { return null; },
    async attachReferrerByCode() { return null; },
    async findValidPasswordResetByHash() { return consumeResetReturn ? { email: consumeResetReturn.email, user_id: consumeResetReturn.id } : null; },
    async consumePasswordResetAndSetPassword() { return consumeResetReturn; },
    async consumeMagicLoginToken() { return consumeMagicReturn; },
    async markLastLogin(userId) {
      lastLoginCalls.push(userId);
      return { id: userId, last_login_at: new Date() };
    },
    async bumpLastLoginIfStale() { return null; },
    async query() { return { rows: [] }; }
  }
};

require.cache[require.resolve('../db')] = {
  id: require.resolve('../db'),
  filename: require.resolve('../db'),
  loaded: true,
  exports: fakeDbModule
};

// Stub out the email-side libs so the auth router doesn't fire real network.
require.cache[require.resolve('../lib/welcome')] = {
  id: require.resolve('../lib/welcome'),
  filename: require.resolve('../lib/welcome'),
  loaded: true,
  exports: { triggerWelcomeEmail: async () => ({ ok: true, reason: 'noop' }) }
};
require.cache[require.resolve('../lib/password-reset')] = {
  id: require.resolve('../lib/password-reset'),
  filename: require.resolve('../lib/password-reset'),
  loaded: true,
  exports: {
    requestPasswordReset: async () => ({ ok: true }),
    hashToken: (raw) => 'a'.repeat(64)
  }
};
require.cache[require.resolve('../lib/magic-login')] = {
  id: require.resolve('../lib/magic-login'),
  filename: require.resolve('../lib/magic-login'),
  loaded: true,
  exports: {
    requestMagicLink: async () => ({ ok: true }),
    hashToken: (raw) => 'a'.repeat(64),
    safeNextPath: (next) => typeof next === 'string' && next.startsWith('/') ? next : null,
    mintMagicLoginToken: async () => ({ ok: false, reason: 'noop' })
  }
};

clearReq('../routes/auth');
clearReq('../lib/last-login');
const authRoutes = require('../routes/auth');

function buildApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    res.locals.csrfToken = 'test-csrf';
    next();
  });
  app.use('/auth', authRoutes);
  return app;
}

function request(app, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const payload = body ? new URLSearchParams(body).toString() : '';
      const req = http.request({
        hostname: '127.0.0.1', port, path: urlPath, method,
        headers: body ? {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(payload)
        } : {}
      }, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => {
          server.close(() => resolve({ status: res.statusCode, headers: res.headers, body: data }));
        });
      });
      req.on('error', (err) => { server.close(); reject(err); });
      if (body) req.write(payload);
      req.end();
    });
  });
}

async function testLoginStampsLastLogin() {
  resetAuthStubs();
  const hash = await bcrypt.hash('correctpw1', 4);
  getUserByEmailReturn = { id: 5, email: 'a@x.com', password_hash: hash, name: 'A', plan: 'free', invoice_count: 0 };
  const app = buildApp();
  const res = await request(app, 'POST', '/auth/login', { email: 'a@x.com', password: 'correctpw1' });
  assert.strictEqual(res.status, 302, 'successful login must redirect');
  // stamp is fire-and-forget; give the microtask a chance to flush.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(lastLoginCalls, [5],
    'POST /auth/login success must fire markLastLogin once with the user id');
}

async function testLoginFailureDoesNotStamp() {
  resetAuthStubs();
  const hash = await bcrypt.hash('correctpw1', 4);
  getUserByEmailReturn = { id: 5, email: 'a@x.com', password_hash: hash, name: 'A', plan: 'free', invoice_count: 0 };
  const app = buildApp();
  const res = await request(app, 'POST', '/auth/login', { email: 'a@x.com', password: 'WRONG_PASSWORD' });
  assert.strictEqual(res.status, 200, 'bad password re-renders the login form');
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(lastLoginCalls, [],
    'failed login must NOT stamp — the returned-to-app signal must be a real auth event');
}

async function testRegisterDoesNotStamp() {
  resetAuthStubs();
  getUserByEmailReturn = null;
  createUserReturn = { id: 11, email: 'new@x.com', password_hash: 'x', name: 'N', plan: 'free', invoice_count: 0 };
  const app = buildApp();
  const res = await request(app, 'POST', '/auth/register', {
    email: 'new@x.com', password: 'newpw1234', name: 'New User'
  });
  assert.strictEqual(res.status, 302, 'register success must redirect to dashboard');
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(lastLoginCalls, [],
    'POST /auth/register must NOT stamp last_login_at — the funnel "returned" stage must not collapse to "completed signup"');
}

async function testMagicConsumeStampsLastLogin() {
  resetAuthStubs();
  consumeMagicReturn = { id: 21, email: 'm@x.com', name: 'M', plan: 'free', invoice_count: 0 };
  const app = buildApp();
  const token = 'a'.repeat(64);
  const res = await request(app, 'GET', `/auth/magic/${token}`);
  assert.strictEqual(res.status, 302, 'magic-link consume must redirect on success');
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(lastLoginCalls, [21],
    'GET /auth/magic/<token> success must fire markLastLogin once');
}

async function testResetConsumeStampsLastLogin() {
  resetAuthStubs();
  consumeResetReturn = { id: 33, email: 'r@x.com', name: 'R', plan: 'free', invoice_count: 0 };
  const app = buildApp();
  const token = 'a'.repeat(64);
  const res = await request(app, 'POST', `/auth/reset/${token}`, { password: 'newpw1234' });
  assert.strictEqual(res.status, 302, 'reset consume must redirect to dashboard on success');
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(lastLoginCalls, [33],
    'POST /auth/reset/<token> success must fire markLastLogin once');
}

// ---------- db.markLastLogin + bumpLastLoginIfStale SQL contract -----------

async function testDbMarkLastLoginSqlContract() {
  // Stub pg.Pool to capture the SQL the db module issues, without standing
  // up a real Postgres. The real db module imports `pg.Pool`; we replace
  // require.cache for `pg` before requiring `db`.
  clearReq('../db');
  const calls = [];
  const fakePg = {
    Pool: class { constructor() {} async query(sql, params) { calls.push({ sql, params }); return { rows: [{ id: params[0], last_login_at: new Date() }] }; } }
  };
  require.cache[require.resolve('pg')] = {
    id: require.resolve('pg'),
    filename: require.resolve('pg'),
    loaded: true,
    exports: fakePg
  };
  const { db } = require('../db');
  await db.markLastLogin(7);
  assert.strictEqual(calls.length, 1, 'markLastLogin issues exactly one UPDATE');
  assert.ok(/UPDATE users SET last_login_at = NOW\(\)/.test(calls[0].sql),
    'must set last_login_at = NOW()');
  assert.ok(/updated_at = NOW\(\)/.test(calls[0].sql),
    'must bump updated_at too (consistent with other write helpers)');
  assert.ok(/WHERE id = \$1/.test(calls[0].sql),
    'must scope by user id parameter');
  assert.ok(/RETURNING id, last_login_at/.test(calls[0].sql),
    'must RETURN the stamp so callers can confirm the write took');
  assert.deepStrictEqual(calls[0].params, [7]);
  // Falsy userId must short-circuit before SQL.
  calls.length = 0;
  assert.strictEqual(await db.markLastLogin(null), null);
  assert.strictEqual(await db.markLastLogin(0), null);
  assert.strictEqual(await db.markLastLogin(undefined), null);
  assert.strictEqual(calls.length, 0, 'falsy userId must not touch the DB');
  // Clean up stub so other tests get a real-shape db.
  delete require.cache[require.resolve('pg')];
  clearReq('../db');
}

async function testDbBumpLastLoginIfStaleSqlContract() {
  clearReq('../db');
  const calls = [];
  const fakePg = {
    Pool: class { constructor() {} async query(sql, params) { calls.push({ sql, params }); return { rows: [] }; } }
  };
  require.cache[require.resolve('pg')] = {
    id: require.resolve('pg'),
    filename: require.resolve('pg'),
    loaded: true,
    exports: fakePg
  };
  const { db } = require('../db');
  await db.bumpLastLoginIfStale(42, 60);
  assert.strictEqual(calls.length, 1);
  assert.ok(/UPDATE users SET last_login_at = NOW\(\)/.test(calls[0].sql));
  assert.ok(/WHERE id = \$1/.test(calls[0].sql), 'scoped by user id');
  assert.ok(/last_login_at IS NULL/.test(calls[0].sql),
    'NULL stamp must be bumped (the no-prior-login path)');
  assert.ok(/last_login_at < NOW\(\) - \(\$2 \* INTERVAL '1 minute'\)/.test(calls[0].sql),
    'stale predicate must use parameterised minute interval');
  assert.ok(/RETURNING id, last_login_at/.test(calls[0].sql));
  assert.deepStrictEqual(calls[0].params, [42, 60]);
  // Negative / non-numeric / null stale window falls back to default 240
  for (const bad of [0, -5, NaN, null, 'huh']) {
    calls.length = 0;
    await db.bumpLastLoginIfStale(42, bad);
    assert.strictEqual(calls[0].params[1], 240, `${bad} must default to 240`);
  }
  // Falsy userId short-circuit
  calls.length = 0;
  assert.strictEqual(await db.bumpLastLoginIfStale(null, 60), null);
  assert.strictEqual(calls.length, 0);
  delete require.cache[require.resolve('pg')];
  clearReq('../db');
}

// ---------- Runner ----------------------------------------------------------

async function run() {
  console.log('last-login tests');
  const tests = [
    ['stampLastLogin: invalid db', testStampLastLoginInvalidDb],
    ['stampLastLogin: invalid userId', testStampLastLoginInvalidUserId],
    ['stampLastLogin: happy path', testStampLastLoginHappyPath],
    ['stampLastLogin: swallows DB throw', testStampLastLoginSwallowsDbThrow],
    ['middleware: skips unauthenticated', testMiddlewareSkipsUnauthenticated],
    ['middleware: skips when req.session missing', testMiddlewareSkipsNoSession],
    ['middleware: calls bumpLastLoginIfStale on authed req', testMiddlewareCallsBumpOnAuthenticated],
    ['middleware: defaults stale window to 240 min', testMiddlewareDefaultsStaleWindowTo240Minutes],
    ['middleware: never blocks on DB Promise rejection', testMiddlewareNeverBlocksOnDbThrow],
    ['middleware: never blocks on synchronous throw', testMiddlewareNeverBlocksOnSynchronousThrow],
    ['middleware: never awaits before next()', testMiddlewareNeverAwaitsBeforeNext],
    ['middleware: invalid staleAfterMinutes falls back to 240', testMiddlewareInvalidStaleAfterMinutesFallsBackToDefault],
    ['POST /auth/login success stamps last_login_at', testLoginStampsLastLogin],
    ['POST /auth/login failure does NOT stamp', testLoginFailureDoesNotStamp],
    ['POST /auth/register does NOT stamp (signup ≠ re-entry)', testRegisterDoesNotStamp],
    ['GET /auth/magic/<token> success stamps last_login_at', testMagicConsumeStampsLastLogin],
    ['POST /auth/reset/<token> success stamps last_login_at', testResetConsumeStampsLastLogin],
    ['db.markLastLogin SQL contract', testDbMarkLastLoginSqlContract],
    ['db.bumpLastLoginIfStale SQL contract', testDbBumpLastLoginIfStaleSqlContract]
  ];
  let passed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ ${name}`);
      console.error(`    ${err && err.stack ? err.stack : err}`);
      process.exitCode = 1;
    }
  }
  console.log(`${passed}/${tests.length} passed`);
}

run();
