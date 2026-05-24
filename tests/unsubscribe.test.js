'use strict';

/*
 * Lifecycle-email unsubscribe (CAN-SPAM compliance + RFC 8058 one-click
 * `List-Unsubscribe`).
 *
 * Covers four layers:
 *   1. lib/unsubscribe pure helpers: token validity, URL build, header
 *      shape, footer injection, lazy mint via row → URL.
 *   2. lib/email sendEmail extension: when unsubscribeUrl is passed,
 *      RFC 8058 headers are emitted AND a footer is appended to both
 *      html and text bodies. When omitted, the email is unchanged.
 *   3. routes/unsubscribe: GET shows confirmation; bad token 404s; POST
 *      stamps opt-out (CSRF-exempt — mail clients have no session); POST
 *      /resubscribe clears the stamp; idempotent re-clicks.
 *   4. middleware/csrf: the route-prefix exemption lets the
 *      `List-Unsubscribe-Post` one-click POST through without a session
 *      token, while every other POST under the same session is still
 *      protected.
 *   5. cron gate (regression): no-invoice-nudge cron skips users opted
 *      out (proves the gate works end-to-end via the new
 *      `lifecycle_emails_opted_out_at IS NULL` SQL filter — exercised
 *      against the live db helper SQL with a fake pool stub).
 *
 * Run: NODE_ENV=test node tests/unsubscribe.test.js
 */

const assert = require('assert');
const express = require('express');
const session = require('express-session');
const http = require('http');
const path = require('path');

function clearReq(mod) { delete require.cache[require.resolve(mod)]; }

// ---------- HTTP helper ------------------------------------------------------

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

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ---------- Layer 1: lib/unsubscribe pure helpers ----------------------------

test('isValidToken rejects garbage / requires hex 8-32 chars', () => {
  const { isValidToken } = require('../lib/unsubscribe');
  assert.strictEqual(isValidToken(''), false, 'empty rejected');
  assert.strictEqual(isValidToken(null), false, 'null rejected');
  assert.strictEqual(isValidToken('z'.repeat(16)), false, 'non-hex rejected');
  assert.strictEqual(isValidToken('abc'), false, 'too short (<8) rejected');
  assert.strictEqual(isValidToken('a'.repeat(64)), false, 'too long (>32) rejected');
  assert.strictEqual(isValidToken('aa<script>'), false, 'XSS payload rejected');
  assert.strictEqual(isValidToken('0123456789abcdef'), true, '16-char hex accepted');
  assert.strictEqual(isValidToken('DEADBEEF12345678'), true, 'uppercase hex accepted');
});

test('buildUnsubscribeUrl uses APP_URL and encodes token; empty when no token', () => {
  const { buildUnsubscribeUrl } = require('../lib/unsubscribe');
  const old = process.env.APP_URL;
  process.env.APP_URL = 'https://decentinvoice.com/';
  assert.strictEqual(
    buildUnsubscribeUrl('abc123def4567890'),
    'https://decentinvoice.com/unsubscribe/abc123def4567890'
  );
  delete process.env.APP_URL;
  assert.strictEqual(buildUnsubscribeUrl('abc123def4567890'), '/unsubscribe/abc123def4567890',
    'no APP_URL falls back to relative path so dev/tests stay sane');
  assert.strictEqual(buildUnsubscribeUrl(''), '', 'empty token returns empty');
  process.env.APP_URL = old || '';
});

test('unsubscribeHeaders emits RFC 8058 one-click pair when URL present, empty otherwise', () => {
  const { unsubscribeHeaders } = require('../lib/unsubscribe');
  assert.deepStrictEqual(unsubscribeHeaders(''), {}, 'no URL → no headers (spread-safe)');
  assert.deepStrictEqual(unsubscribeHeaders(null), {}, 'null URL → no headers');
  const h = unsubscribeHeaders('https://x.com/unsubscribe/T');
  assert.strictEqual(h['List-Unsubscribe'], '<https://x.com/unsubscribe/T>',
    'RFC 2369 angle-bracket wrapping');
  assert.strictEqual(h['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click',
    'RFC 8058 one-click sentinel');
});

test('appendUnsubscribeFooter slots HTML footer before </body> and appends to text', () => {
  const { appendUnsubscribeFooter } = require('../lib/unsubscribe');
  const out = appendUnsubscribeFooter(
    '<!doctype html><html><body><p>hi</p></body></html>',
    'plain body',
    'https://x.com/unsubscribe/T'
  );
  assert.ok(/Unsubscribe/.test(out.html), 'HTML carries footer text');
  assert.ok(out.html.indexOf('</body>') > out.html.indexOf('Unsubscribe'),
    'HTML footer sits BEFORE </body>');
  assert.ok(/href="https:\/\/x\.com\/unsubscribe\/T"/.test(out.html),
    'HTML footer carries the unsubscribe href');
  assert.ok(out.text.endsWith('Unsubscribe: https://x.com/unsubscribe/T'),
    'text footer ends with the unsubscribe URL');
  // No mutation of the inputs (returns a new pair).
  assert.strictEqual(typeof out.html, 'string');
  assert.strictEqual(typeof out.text, 'string');
});

test('appendUnsubscribeFooter no-ops when URL is absent or falsy', () => {
  const { appendUnsubscribeFooter } = require('../lib/unsubscribe');
  const out = appendUnsubscribeFooter('<html><body>x</body></html>', 'y', '');
  assert.strictEqual(out.html, '<html><body>x</body></html>');
  assert.strictEqual(out.text, 'y');
});

test('appendUnsubscribeFooter appends to body-less HTML gracefully', () => {
  const { appendUnsubscribeFooter } = require('../lib/unsubscribe');
  const out = appendUnsubscribeFooter('<p>fragment</p>', 't', 'https://x.com/u/T');
  assert.ok(out.html.startsWith('<p>fragment</p>'), 'original fragment preserved');
  assert.ok(/Unsubscribe/.test(out.html), 'footer appended');
});

test('resolveUnsubscribeUrlForRow uses row token when present (no DB hit)', async () => {
  const { resolveUnsubscribeUrlForRow } = require('../lib/unsubscribe');
  const old = process.env.APP_URL;
  process.env.APP_URL = 'https://app.example.com';
  let mintCalled = false;
  const url = await resolveUnsubscribeUrlForRow(
    { getOrCreateUnsubscribeToken: async () => { mintCalled = true; return 'newtoken12345678'; } },
    { id: 7, unsubscribe_token: 'rowtoken12345678' }
  );
  assert.strictEqual(url, 'https://app.example.com/unsubscribe/rowtoken12345678');
  assert.strictEqual(mintCalled, false, 'no mint round-trip when row already carries token');
  process.env.APP_URL = old || '';
});

test('resolveUnsubscribeUrlForRow lazy-mints when row token is null', async () => {
  const { resolveUnsubscribeUrlForRow } = require('../lib/unsubscribe');
  const old = process.env.APP_URL;
  process.env.APP_URL = 'https://app.example.com';
  const mintCalls = [];
  const url = await resolveUnsubscribeUrlForRow(
    {
      getOrCreateUnsubscribeToken: async (uid) => {
        mintCalls.push(uid);
        return 'minted123456789a';
      }
    },
    { id: 42, unsubscribe_token: null }
  );
  assert.strictEqual(url, 'https://app.example.com/unsubscribe/minted123456789a');
  assert.deepStrictEqual(mintCalls, [42], 'mint called with the row\'s user id');
  process.env.APP_URL = old || '';
});

test('resolveUnsubscribeUrlForRow soft-fails to empty when mint throws', async () => {
  const { resolveUnsubscribeUrlForRow } = require('../lib/unsubscribe');
  const url = await resolveUnsubscribeUrlForRow(
    { getOrCreateUnsubscribeToken: async () => { throw new Error('PG down'); } },
    { id: 1, unsubscribe_token: null }
  );
  assert.strictEqual(url, '', 'mint throw must never bubble — drops the URL silently');
});

// ---------- Layer 2: lib/email sendEmail headers + footer --------------------

test('sendEmail with unsubscribeUrl emits List-Unsubscribe headers + footer', async () => {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const sends = [];
  email.setResendClient({
    emails: { async send(p) { sends.push(p); return { data: { id: 'em' } }; } }
  });
  const r = await email.sendEmail({
    to: 'u@example.com',
    subject: 'subj',
    html: '<html><body>body</body></html>',
    text: 'text body',
    unsubscribeUrl: 'https://app.example.com/unsubscribe/abc123def4567890'
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(sends.length, 1);
  assert.ok(sends[0].headers, 'headers attached');
  assert.strictEqual(
    sends[0].headers['List-Unsubscribe'],
    '<https://app.example.com/unsubscribe/abc123def4567890>',
    'RFC 2369 angle-bracket header'
  );
  assert.strictEqual(
    sends[0].headers['List-Unsubscribe-Post'],
    'List-Unsubscribe=One-Click',
    'RFC 8058 one-click sentinel'
  );
  assert.ok(/Unsubscribe/i.test(sends[0].html), 'html carries footer link');
  assert.ok(/href="https:\/\/app\.example\.com\/unsubscribe\/abc123def4567890"/.test(sends[0].html),
    'html footer href is the unsubscribe URL');
  assert.ok(sends[0].text.endsWith('Unsubscribe: https://app.example.com/unsubscribe/abc123def4567890'),
    'plaintext footer ends with the unsubscribe URL');
  email.resetResendClient();
});

test('sendEmail without unsubscribeUrl emits no List-Unsubscribe headers + no footer', async () => {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const sends = [];
  email.setResendClient({
    emails: { async send(p) { sends.push(p); return { data: { id: 'em' } }; } }
  });
  const r = await email.sendEmail({
    to: 'u@example.com',
    subject: 's',
    html: '<html><body>plain body</body></html>',
    text: 'plain text'
  });
  assert.strictEqual(r.ok, true);
  assert.ok(!sends[0].headers || !sends[0].headers['List-Unsubscribe'],
    'no List-Unsubscribe header without an URL — transactional sends stay clean');
  assert.ok(!/Unsubscribe/.test(sends[0].html), 'no footer in HTML');
  assert.ok(!/Unsubscribe/.test(sends[0].text), 'no footer in plaintext');
  email.resetResendClient();
});

// ---------- Layer 3: routes/unsubscribe + view rendering ---------------------

function buildApp(dbStub) {
  // Stub the production db module before requiring routes/unsubscribe so its
  // top-level require('../db') resolves to the test double. After the test
  // we restore the cache so other tests aren't affected.
  const dbPath = require.resolve('../db');
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: { db: dbStub, pool: {} }
  };
  delete require.cache[require.resolve('../routes/unsubscribe')];
  const router = require('../routes/unsubscribe');
  const { csrfProtection } = require('../middleware/csrf');
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: 'unsub-test-secret', resave: false, saveUninitialized: false }));
  // Mirror server.js: surface req.session.user as res.locals.user so the
  // shared nav partial (rendered inside the unsubscribe view) can read it.
  app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    next();
  });
  // Mirror the production stack: global csrf protection, then the
  // unsubscribe router. The prefix bypass in middleware/csrf.js is what
  // lets the one-click POST through.
  app.use(csrfProtection);
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use('/unsubscribe', router);
  // Sibling protected POST to prove the bypass is prefix-scoped, not global.
  app.post('/protected', (req, res) => res.status(200).send('ok'));
  return app;
}

test('GET /unsubscribe/<token> renders the confirmation page with the user email', async () => {
  const calls = [];
  const dbStub = {
    async findUserByUnsubscribeToken(t) {
      calls.push(t);
      return { id: 7, email: 'jane@example.com', lifecycle_emails_opted_out_at: null };
    },
    async markLifecycleOptOut() { return null; },
    async markLifecycleResubscribe() { return null; }
  };
  const app = buildApp(dbStub);
  const res = await request(app, 'GET', '/unsubscribe/abc123def4567890');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(calls, ['abc123def4567890'], 'token threaded to db lookup');
  assert.ok(res.body.includes('jane@example.com'),
    'user email rendered so the recipient confirms it\'s the right account');
  assert.ok(res.body.includes('data-testid="unsubscribe-form"'),
    'POST form rendered');
  assert.ok(res.body.includes('action="/unsubscribe/abc123def4567890"'),
    'POST form targets the same token URL');
  assert.ok(!res.body.includes('data-testid="unsubscribe-already"'),
    'not-yet-opted-out user does NOT see the already-unsubscribed banner');
});

test('GET /unsubscribe/<token> shows already-opted-out banner when user has the stamp', async () => {
  const dbStub = {
    async findUserByUnsubscribeToken() {
      return { id: 7, email: 'a@b.com', lifecycle_emails_opted_out_at: new Date() };
    },
    async markLifecycleOptOut() { return null; },
    async markLifecycleResubscribe() { return null; }
  };
  const app = buildApp(dbStub);
  const res = await request(app, 'GET', '/unsubscribe/abc123def4567890');
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.includes('data-testid="unsubscribe-already"'),
    'already-unsubscribed banner shown so re-click is no-op');
});

test('GET /unsubscribe/<bad token> 404s without DB hit', async () => {
  let called = false;
  const dbStub = {
    async findUserByUnsubscribeToken() { called = true; return null; },
    async markLifecycleOptOut() { return null; },
    async markLifecycleResubscribe() { return null; }
  };
  const app = buildApp(dbStub);
  const res = await request(app, 'GET', '/unsubscribe/<script>');
  assert.strictEqual(res.status, 404, 'XSS-shaped token must 404 (validator rejects it)');
  assert.strictEqual(called, false, 'invalid token must never reach the DB lookup');
});

test('GET /unsubscribe/<unknown valid token> 404s', async () => {
  const dbStub = {
    async findUserByUnsubscribeToken() { return null; },
    async markLifecycleOptOut() { return null; },
    async markLifecycleResubscribe() { return null; }
  };
  const app = buildApp(dbStub);
  const res = await request(app, 'GET', '/unsubscribe/0123456789abcdef');
  assert.strictEqual(res.status, 404);
});

test('POST /unsubscribe/<token> stamps opt-out, renders success, with NO CSRF token', async () => {
  const stamps = [];
  const dbStub = {
    async findUserByUnsubscribeToken() {
      return { id: 7, email: 'p@q.com', lifecycle_emails_opted_out_at: null };
    },
    async markLifecycleOptOut(uid) {
      stamps.push(uid);
      return { id: uid, lifecycle_emails_opted_out_at: new Date() };
    },
    async markLifecycleResubscribe() { return null; }
  };
  const app = buildApp(dbStub);
  // Direct POST — no GET first, no session cookie. Mail clients carry
  // neither when they hit `List-Unsubscribe-Post` URLs.
  const res = await request(app, 'POST', '/unsubscribe/abc123def4567890');
  assert.strictEqual(res.status, 200,
    'no-session POST must succeed (CSRF prefix bypass)');
  assert.deepStrictEqual(stamps, [7], 'opt-out stamped on the right user');
  assert.ok(res.body.includes('data-testid="unsubscribed-title"'));
  assert.ok(res.body.includes('p@q.com'), 'success page echoes the email');
  assert.ok(res.body.includes('data-testid="resubscribe-form"'),
    'resubscribe form rendered so the user can undo');
});

test('POST /unsubscribe/<token>/resubscribe clears opt-out and renders welcome-back', async () => {
  const clears = [];
  const dbStub = {
    async findUserByUnsubscribeToken() {
      return { id: 99, email: 'r@s.com', lifecycle_emails_opted_out_at: new Date() };
    },
    async markLifecycleOptOut() { return null; },
    async markLifecycleResubscribe(uid) {
      clears.push(uid);
      return { id: uid, lifecycle_emails_opted_out_at: null };
    }
  };
  const app = buildApp(dbStub);
  const res = await request(app, 'POST', '/unsubscribe/abc123def4567890/resubscribe');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(clears, [99], 'resubscribe stamp cleared on the right user');
  assert.ok(res.body.includes('data-testid="resubscribed-title"'));
  assert.ok(res.body.includes('r@s.com'));
});

test('CSRF protection still blocks unrelated POSTs (bypass is prefix-scoped)', async () => {
  const dbStub = {
    async findUserByUnsubscribeToken() { return null; },
    async markLifecycleOptOut() { return null; },
    async markLifecycleResubscribe() { return null; }
  };
  const app = buildApp(dbStub);
  // POST /protected has NO CSRF token — must be rejected, proving the
  // unsubscribe-prefix bypass did NOT leak globally.
  const res = await request(app, 'POST', '/protected', { x: 1 });
  assert.strictEqual(res.status, 403,
    'sibling POST without token must still be rejected — bypass must NOT leak past /unsubscribe/');
});

// ---------- Layer 4: cron-gate regression on db.getUsersForNoInvoiceNudge ----

test('SQL regression: getUsersForNoInvoiceNudge gates on lifecycle_emails_opted_out_at IS NULL', async () => {
  // Sniff the production SQL: stub the pg pool and capture the query text.
  // This proves the new gate is wired at the DB-helper layer — without it,
  // an opted-out user would keep receiving nudges even after clicking the
  // footer link.
  delete require.cache[require.resolve('../db')];
  const dbMod = require('../db');
  const pool = dbMod.pool;
  const originalQuery = pool.query.bind(pool);
  const captured = [];
  pool.query = async (text, params) => {
    captured.push({ text, params });
    return { rows: [] };
  };
  try {
    await dbMod.db.getUsersForNoInvoiceNudge(48);
  } finally {
    pool.query = originalQuery;
  }
  assert.strictEqual(captured.length, 1);
  const sql = captured[0].text.replace(/\s+/g, ' ');
  assert.ok(/lifecycle_emails_opted_out_at IS NULL/.test(sql),
    'cohort query MUST gate on lifecycle_emails_opted_out_at IS NULL — without this an opted-out user keeps getting nudges');
  assert.ok(/unsubscribe_token/.test(sql),
    'SELECT must surface unsubscribe_token so the cron orchestrator can bake it into the email without a second round-trip');
});

test('SQL regression: getInvoicesForClientViewedFollowup also gates + SELECTs token', async () => {
  delete require.cache[require.resolve('../db')];
  const dbMod = require('../db');
  const pool = dbMod.pool;
  const originalQuery = pool.query.bind(pool);
  const captured = [];
  pool.query = async (text, params) => {
    captured.push({ text, params });
    return { rows: [] };
  };
  try {
    await dbMod.db.getInvoicesForClientViewedFollowup(48, 14);
  } finally {
    pool.query = originalQuery;
  }
  assert.strictEqual(captured.length, 1);
  const sql = captured[0].text.replace(/\s+/g, ' ');
  assert.ok(/lifecycle_emails_opted_out_at IS NULL/.test(sql),
    'invoice-anchored cohort cron must also honour the user-level opt-out');
  assert.ok(/unsubscribe_token/.test(sql),
    'SELECT must surface unsubscribe_token even when the cohort row is invoice-shaped');
});

// ---------- Layer 5: no-invoice-nudge cron passes URL through ----------------

test('no-invoice-nudge orchestrator threads unsubscribeUrl into sendEmail per row', async () => {
  const old = process.env.APP_URL;
  process.env.APP_URL = 'https://app.example.com';
  delete require.cache[require.resolve('../jobs/no-invoice-nudge')];
  const noInvoice = require('../jobs/no-invoice-nudge');
  const sends = [];
  const dbStub = {
    async getUsersForNoInvoiceNudge() {
      return [
        { id: 7, email: 'a@a.com', name: 'A', unsubscribe_token: 'rowtoken1aaaaaaa' },
        { id: 8, email: 'b@b.com', name: 'B', unsubscribe_token: null }
      ];
    },
    async markNoInvoiceNudgeSent(uid) { return { id: uid }; },
    async getOrCreateUnsubscribeToken(uid) { return `minted${uid}bbbbbbb`; }
  };
  await noInvoice.processNoInvoiceNudges({
    db: dbStub,
    sendEmail: async (p) => { sends.push(p); return { ok: true, id: 'em' }; },
    mintMagicLoginToken: async () => ({ ok: false, reason: 'stubbed' }),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(sends.length, 2);
  assert.strictEqual(sends[0].unsubscribeUrl,
    'https://app.example.com/unsubscribe/rowtoken1aaaaaaa',
    'user with pre-existing token uses it directly (no mint round-trip)');
  assert.strictEqual(sends[1].unsubscribeUrl,
    'https://app.example.com/unsubscribe/minted8bbbbbbb',
    'user without token gets a freshly-minted one baked into the email');
  process.env.APP_URL = old || '';
});

// ---------- Runner -----------------------------------------------------------

async function run() {
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ok  ${name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL  ${name}`);
      console.error('    ', err && err.stack ? err.stack : err);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed (unsubscribe.test.js)`);
  if (failed > 0) process.exit(1);
}

run();
