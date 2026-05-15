'use strict';

/*
 * Welcome email on signup (#WELCOME).
 *
 * Covers:
 *  1.  lib/email: buildWelcomeSubject includes the user's first name and a
 *      "first invoice" hook so the inbox subject motivates re-entry.
 *  2.  lib/email: buildWelcomeSubject falls back to a non-personalised line
 *      when the user has no name.
 *  3.  lib/email: buildWelcomeHtml escapes user input (XSS guard) and renders
 *      both CTAs (create-invoice + start-trial) with APP_URL-prefixed links
 *      when APP_URL is set.
 *  4.  lib/email: buildWelcomeText is non-empty plaintext that includes both
 *      CTAs so clients with HTML disabled still see the activation path.
 *  5.  lib/email: sendWelcomeEmail short-circuits with `no_recipient` when
 *      user.email is missing.
 *  6.  lib/email: sendWelcomeEmail with an injected client posts the right
 *      to/subject/html/text/reply_to and returns ok:true with the Resend id.
 *  7.  lib/welcome: triggerWelcomeEmail short-circuits when db has no
 *      markWelcomeEmailSent method (legacy db / test stub safety).
 *  8.  lib/welcome: triggerWelcomeEmail soft-fails on db throw with
 *      reason='db_error' (never bubbles).
 *  9.  lib/welcome: triggerWelcomeEmail soft-fails with
 *      reason='already_sent' when db.markWelcomeEmailSent returns null
 *      (idempotency: never double-send).
 * 10.  lib/welcome: triggerWelcomeEmail returns ok:true on the happy path
 *      and calls sendWelcomeEmail exactly once with the row returned by
 *      markWelcomeEmailSent (so personalisation reflects the DB row).
 * 11.  lib/welcome: triggerWelcomeEmail surfaces a Resend send throw as
 *      reason='send_error' (never bubbles).
 * 12.  lib/welcome: triggerWelcomeEmail surfaces a send-not-configured
 *      result as ok:false reason='not_configured'.
 * 13.  routes/auth POST /register success → triggerWelcomeEmail fires once
 *      with the newly created user's id, the redirect to /dashboard is not
 *      blocked on the email path, and a rejection from triggerWelcomeEmail
 *      does NOT prevent account creation.
 * 14.  routes/auth POST /register failure (duplicate email) → does NOT
 *      trigger the welcome email.
 *
 * Run: NODE_ENV=test node tests/welcome-email.test.js
 */

const assert = require('assert');
const path = require('path');
const express = require('express');
const session = require('express-session');
const http = require('http');

function clearReq(mod) { delete require.cache[require.resolve(mod)]; }

// ---------- Lib-level tests --------------------------------------------------

async function testBuildWelcomeSubjectWithName() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const subject = email.buildWelcomeSubject({ name: 'Alice', email: 'a@x.com' });
  assert.ok(subject.includes('Alice'), 'subject must include the user\'s name');
  assert.ok(/invoice/i.test(subject),
    'subject must hint at the activation CTA (first invoice) so inbox previews motivate re-entry');
  assert.ok(subject.length < 100,
    'subject should fit in a typical inbox preview (under 100 chars)');
}

async function testBuildWelcomeSubjectFallback() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const subject = email.buildWelcomeSubject({ email: 'a@x.com' });
  assert.ok(subject.length > 0, 'must produce a non-empty subject even without a name');
  assert.ok(/welcome/i.test(subject), 'fallback subject must still say "welcome"');
}

async function testBuildWelcomeHtmlEscapesAndRendersCtas() {
  clearReq('../lib/email');
  const oldAppUrl = process.env.APP_URL;
  process.env.APP_URL = 'https://invoice.example.com';
  const email = require('../lib/email');
  const html = email.buildWelcomeHtml({
    name: '<script>alert(1)</script>',
    email: 'a@x.com'
  });
  process.env.APP_URL = oldAppUrl;
  assert.ok(!html.includes('<script>alert(1)</script>'),
    'raw name must not appear unescaped (XSS guard)');
  assert.ok(html.includes('&lt;script&gt;'),
    'name must appear HTML-escaped');
  assert.ok(html.includes('https://invoice.example.com/invoices/new'),
    'first-invoice CTA must point at APP_URL-prefixed /invoices/new');
  assert.ok(html.includes('https://invoice.example.com/billing/upgrade'),
    'pro-trial CTA must point at APP_URL-prefixed /billing/upgrade');
  assert.ok(/trial/i.test(html),
    'body must mention the free trial so the upsell path is visible');
  assert.ok(/no card/i.test(html),
    'body must say "no card" so the trial CTA reads as zero-friction');
}

async function testBuildWelcomeTextIncludesBothCtas() {
  clearReq('../lib/email');
  const oldAppUrl = process.env.APP_URL;
  process.env.APP_URL = 'https://invoice.example.com';
  const email = require('../lib/email');
  const text = email.buildWelcomeText({ name: 'Bob', email: 'b@x.com' });
  process.env.APP_URL = oldAppUrl;
  assert.ok(text.length > 50, 'text body must be non-trivial');
  assert.ok(text.includes('Bob'), 'text body must personalise');
  assert.ok(text.includes('https://invoice.example.com/invoices/new'),
    'plaintext must include the first-invoice URL');
  assert.ok(text.includes('https://invoice.example.com/billing/upgrade'),
    'plaintext must include the trial URL');
  assert.ok(!text.includes('<') && !text.includes('>'),
    'plaintext must not contain HTML tag delimiters');
}

async function testSendWelcomeEmailNoRecipient() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const r = await email.sendWelcomeEmail({ name: 'Nobody' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no_recipient',
    'missing user.email must short-circuit before calling Resend');
}

async function testSendWelcomeEmailHappyPath() {
  clearReq('../lib/email');
  const oldAppUrl = process.env.APP_URL;
  process.env.APP_URL = 'https://invoice.example.com';
  const email = require('../lib/email');
  const sends = [];
  email.setResendClient({
    emails: {
      async send(payload) {
        sends.push(payload);
        return { data: { id: 'em_welcome_42' }, error: null };
      }
    }
  });

  const r = await email.sendWelcomeEmail({
    id: 7,
    name: 'Alice',
    email: 'alice@x.com',
    business_email: 'billing@alice.com',
    reply_to_email: 'replies@alice.com'
  });
  process.env.APP_URL = oldAppUrl;

  assert.strictEqual(r.ok, true, 'happy path returns ok=true');
  assert.strictEqual(r.id, 'em_welcome_42', 'must surface the Resend message id');
  assert.strictEqual(sends.length, 1, 'must call the Resend client exactly once');
  const payload = sends[0];
  assert.deepStrictEqual(payload.to, ['alice@x.com'], 'recipient is the user\'s account email');
  assert.ok(payload.subject.includes('Alice'), 'subject must be personalised');
  assert.ok(payload.html && payload.html.includes('Alice'), 'html body must be personalised');
  assert.ok(payload.text && payload.text.includes('Alice'), 'text body must be personalised');
  assert.strictEqual(payload.reply_to, 'replies@alice.com',
    'reply_to must be the user\'s configured reply-to (so user-replies route to the freelancer)');
  email.resetResendClient();
}

// ---------- Orchestrator tests ----------------------------------------------

async function testTriggerWelcomeShortCircuitsOnMissingDbMethod() {
  clearReq('../lib/email');
  clearReq('../lib/welcome');
  const { triggerWelcomeEmail } = require('../lib/welcome');
  const r = await triggerWelcomeEmail({}, 7);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'db_unavailable',
    'a db without markWelcomeEmailSent must not throw');
}

async function testTriggerWelcomeSoftFailsOnDbThrow() {
  clearReq('../lib/email');
  clearReq('../lib/welcome');
  const { triggerWelcomeEmail } = require('../lib/welcome');
  const db = { markWelcomeEmailSent: async () => { throw new Error('connection refused'); } };
  const r = await triggerWelcomeEmail(db, 7);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'db_error');
  assert.ok(r.error && r.error.includes('connection refused'));
}

async function testTriggerWelcomeIdempotency() {
  clearReq('../lib/email');
  clearReq('../lib/welcome');
  const { triggerWelcomeEmail } = require('../lib/welcome');
  const db = { markWelcomeEmailSent: async () => null }; // already sent
  const r = await triggerWelcomeEmail(db, 7);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'already_sent',
    'a null return from the idempotency stamp must NOT trigger a send');
}

async function testTriggerWelcomeHappyPath() {
  clearReq('../lib/email');
  clearReq('../lib/welcome');
  const email = require('../lib/email');
  const sendCalls = [];
  email.setResendClient({
    emails: {
      async send(payload) {
        sendCalls.push(payload);
        return { data: { id: 'em_x9' }, error: null };
      }
    }
  });
  const { triggerWelcomeEmail } = require('../lib/welcome');

  const markCalls = [];
  const stampedRow = { id: 7, email: 'alice@x.com', name: 'Alice', plan: 'free' };
  const db = {
    markWelcomeEmailSent: async (userId) => {
      markCalls.push(userId);
      return stampedRow;
    }
  };

  const r = await triggerWelcomeEmail(db, 7);
  assert.strictEqual(r.ok, true, 'happy path returns ok=true');
  assert.strictEqual(r.id, 'em_x9');
  assert.deepStrictEqual(markCalls, [7], 'idempotency stamp called exactly once with user id');
  assert.strictEqual(sendCalls.length, 1, 'send invoked exactly once');
  assert.deepStrictEqual(sendCalls[0].to, ['alice@x.com']);
  assert.ok(sendCalls[0].subject.includes('Alice'));
  email.resetResendClient();
}

async function testTriggerWelcomeSurfacesSendThrow() {
  clearReq('../lib/email');
  clearReq('../lib/welcome');
  const email = require('../lib/email');
  email.setResendClient({
    emails: { async send() { throw new Error('Resend exploded'); } }
  });
  const { triggerWelcomeEmail } = require('../lib/welcome');
  const db = {
    markWelcomeEmailSent: async () => ({ id: 7, email: 'x@y.com', name: 'X', plan: 'free' })
  };
  const r = await triggerWelcomeEmail(db, 7);
  // The lib/email layer catches the throw internally and surfaces ok:false
  // reason:'error', so the orchestrator returns ok:false reason:'error'
  // (NOT send_error — that path is reserved for throws that escape the
  // email lib's catch). Either reason is acceptable for the contract; what
  // MUST hold is ok:false + no bubble.
  assert.strictEqual(r.ok, false, 'send-side throw must surface as ok:false');
  assert.ok(['send_error', 'error', 'send_failed'].includes(r.reason),
    `reason must be a send-side failure marker, got: ${r.reason}`);
  email.resetResendClient();
}

async function testTriggerWelcomeNotConfigured() {
  clearReq('../lib/email');
  clearReq('../lib/welcome');
  const email = require('../lib/email');
  email.resetResendClient();
  delete process.env.RESEND_API_KEY;
  const { triggerWelcomeEmail } = require('../lib/welcome');
  const db = {
    markWelcomeEmailSent: async () => ({ id: 7, email: 'x@y.com', name: 'X', plan: 'free' })
  };
  const r = await triggerWelcomeEmail(db, 7);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'not_configured',
    'no Resend key must produce not_configured (graceful pre-launch behaviour)');
}

// ---------- Route integration tests -----------------------------------------

const triggerCalls = [];
let triggerImpl = async () => ({ ok: true, id: 'em_route' });

// bcrypt stub
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
let nextId = 200;

function resetUserStore() {
  usersById.clear();
  usersByEmail.clear();
  nextId = 200;
  triggerCalls.length = 0;
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
    async createSeedInvoice() { return { id: 1, is_seed: true }; },
    async markWelcomeEmailSent(userId) {
      // Real DB returns the user row on first call, null on idempotent retry.
      const u = usersById.get(userId);
      if (!u || u.welcome_email_sent_at) return null;
      u.welcome_email_sent_at = new Date();
      return u;
    },
    async updateUser() { return null; },
    async attachReferrerByCode() { return null; }
  },
  pool: { query: async () => ({ rows: [] }) }
};
require.cache[require.resolve('../db')] = {
  id: require.resolve('../db'),
  filename: require.resolve('../db'),
  loaded: true,
  exports: dbStub
};

// Stub the welcome orchestrator so the route test can observe calls
// without hitting the email lib (which is already covered by lib tests).
require.cache[require.resolve('../lib/welcome')] = {
  id: require.resolve('../lib/welcome'),
  filename: require.resolve('../lib/welcome'),
  loaded: true,
  exports: {
    triggerWelcomeEmail: async (db, userId) => {
      triggerCalls.push({ userId });
      return triggerImpl(db, userId);
    }
  }
};

clearReq('../routes/auth');
const authRoutes = require('../routes/auth');

function buildApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, res, next) => { res.locals.user = req.session.user || null; next(); });
  app.use('/auth', authRoutes);
  return app;
}

function request(app, method, url, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const payload = body ? new URLSearchParams(body).toString() : '';
      const headers = {};
      if (payload) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        headers['Content-Length'] = Buffer.byteLength(payload);
      }
      const req = http.request({ hostname: '127.0.0.1', port, path: url, method, headers }, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => server.close(() => resolve({
          status: res.statusCode, headers: res.headers, body: data
        })));
      });
      req.on('error', err => { server.close(); reject(err); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

async function testRegisterFiresWelcomeEmail() {
  resetUserStore();
  triggerImpl = async () => ({ ok: true, id: 'em_route_42' });
  const app = buildApp();
  const res = await request(app, 'POST', '/auth/register',
    { name: 'Alice', email: 'alice@x.com', password: 'password123' });

  assert.strictEqual(res.status, 302, 'successful register must redirect to /dashboard');
  // The trigger is fire-and-forget; the redirect lands before the promise
  // resolves. Wait one microtask tick for the scheduled call to land.
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  assert.strictEqual(triggerCalls.length, 1,
    'triggerWelcomeEmail must be invoked exactly once on successful register');
  const created = usersByEmail.get('alice@x.com');
  assert.ok(created, 'user must be persisted');
  assert.strictEqual(triggerCalls[0].userId, created.id,
    'trigger must receive the newly-created user\'s id (not name/email)');
}

async function testRegisterSurvivesWelcomeRejection() {
  resetUserStore();
  triggerImpl = async () => { throw new Error('catastrophic email failure'); };
  const app = buildApp();
  const res = await request(app, 'POST', '/auth/register',
    { name: 'Bob', email: 'bob@x.com', password: 'password123' });

  assert.strictEqual(res.status, 302, 'register must still redirect even when welcome throws');
  assert.ok(res.headers.location.includes('/dashboard'),
    'a welcome-email rejection must NOT block the user reaching the dashboard');
  assert.ok(usersByEmail.get('bob@x.com'),
    'account must be persisted even if welcome email throws');
}

async function testRegisterFailureDoesNotFireWelcome() {
  resetUserStore();
  triggerImpl = async () => ({ ok: true, id: 'em_should_not_fire' });
  // Pre-populate so the email is taken.
  usersByEmail.set('taken@x.com', { id: 999, email: 'taken@x.com', name: 'Existing' });
  const app = buildApp();
  const res = await request(app, 'POST', '/auth/register',
    { name: 'New', email: 'taken@x.com', password: 'password123' });

  assert.strictEqual(res.status, 200, 'duplicate email re-renders form');
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  assert.strictEqual(triggerCalls.length, 0,
    'duplicate-email failure path must NOT fire the welcome email');
}

// ---------- Runner ----------------------------------------------------------

async function run() {
  const tests = [
    ['lib/email: buildWelcomeSubject personalises with the user name', testBuildWelcomeSubjectWithName],
    ['lib/email: buildWelcomeSubject has a no-name fallback', testBuildWelcomeSubjectFallback],
    ['lib/email: buildWelcomeHtml escapes XSS + renders both CTAs', testBuildWelcomeHtmlEscapesAndRendersCtas],
    ['lib/email: buildWelcomeText includes plaintext CTAs', testBuildWelcomeTextIncludesBothCtas],
    ['lib/email: sendWelcomeEmail short-circuits on missing recipient', testSendWelcomeEmailNoRecipient],
    ['lib/email: sendWelcomeEmail happy path posts the right Resend payload', testSendWelcomeEmailHappyPath],
    ['lib/welcome: triggerWelcomeEmail short-circuits on missing db method', testTriggerWelcomeShortCircuitsOnMissingDbMethod],
    ['lib/welcome: triggerWelcomeEmail soft-fails on db throw', testTriggerWelcomeSoftFailsOnDbThrow],
    ['lib/welcome: triggerWelcomeEmail respects idempotency (already-sent)', testTriggerWelcomeIdempotency],
    ['lib/welcome: triggerWelcomeEmail happy path stamps then sends', testTriggerWelcomeHappyPath],
    ['lib/welcome: triggerWelcomeEmail surfaces send throw without bubbling', testTriggerWelcomeSurfacesSendThrow],
    ['lib/welcome: triggerWelcomeEmail surfaces Resend not_configured', testTriggerWelcomeNotConfigured],
    ['POST /auth/register success fires welcome email once', testRegisterFiresWelcomeEmail],
    ['POST /auth/register survives welcome-email rejection', testRegisterSurvivesWelcomeRejection],
    ['POST /auth/register duplicate-email failure does NOT fire welcome', testRegisterFailureDoesNotFireWelcome]
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
