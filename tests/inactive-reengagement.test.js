'use strict';

/*
 * Inactive-user re-engagement cron tests.
 *
 * Coverage mirrors tests/no-invoice-nudge.test.js and tests/second-no-invoice-
 * nudge.test.js:
 *   - Email builders: stable subject (no PII), HTML escape, day arithmetic,
 *     APP_URL trimming, graceful CTA degrade when APP_URL is unset, magic-
 *     login URL bake-in with ?next=/invoices/quick.
 *   - Orchestrator: happy path, mint soft-fail / throw, replyTo precedence,
 *     no-email skip, not_configured clean-skip, send-throw containment,
 *     idempotency across runs, top-level query failure containment,
 *     minInactiveHours + ttlMinutes thread-through.
 *   - Cron wiring: test-env block, double-start refusal, DEFAULT_SCHEDULE.
 *   - SQL contract: db.getUsersForInactiveReengagement WHERE predicates,
 *     parameter sanitisation, ORDER BY + LIMIT.
 *   - db.markInactiveReengagementSent: idempotency guard + falsy-userId
 *     short-circuit.
 *
 * Run: NODE_ENV=test node tests/inactive-reengagement.test.js
 */

const assert = require('assert');

const job = require('../jobs/inactive-reengagement');
const email = require('../lib/email');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function cohortRow(over = {}) {
  return {
    id: 42,
    email: 'user@test.io',
    name: 'Sam',
    business_name: 'Studio',
    reply_to_email: null,
    business_email: 'biz@test.io',
    last_login_at: new Date('2026-05-01T00:00:00Z'),
    invoice_count: 3,
    unsubscribe_token: 'tok_unsub_abc',
    ...over
  };
}

// ---- Pure formatters ---------------------------------------------------

test('subject: stable copy + no PII (inbox-preview privacy)', () => {
  const subj = email.buildInactiveReengagementSubject(cohortRow());
  assert.match(subj, /Still freelancing\?/);
  assert.match(subj, /60 seconds/);
  assert.ok(!/Sam|Studio|test\.io/.test(subj),
    'no name / business / email in the subject');
});

test('html: escapes hostile name + threads CTA when APP_URL is set', () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const html = email.buildInactiveReengagementHtml(cohortRow({
    name: '<script>alert(1)</script>'
  }), new Date('2026-05-15T00:00:00Z'));
  assert.ok(!/<script>alert\(1\)<\/script>/.test(html), 'raw script must be escaped');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /https:\/\/decentinvoice\.com\/invoices\/quick/,
    'CTA must deep-link to /invoices/quick');
  assert.match(html, /https:\/\/decentinvoice\.com\/invoices/,
    'dashboard link present');
  assert.match(html, /Create your next invoice/, 'CTA copy present');
  assert.match(html, /Anything new to bill/, 'header framing present');
});

test('html: CTA omitted gracefully when APP_URL is unset (no broken-link button)', () => {
  delete process.env.APP_URL;
  const html = email.buildInactiveReengagementHtml(cohortRow());
  assert.ok(!/<a href=/.test(html), 'no CTA <a> when APP_URL is unset');
  assert.match(html, /Anything new to bill/, 'body copy remains');
});

test('html: greeting falls back through name → business_name → "there"', () => {
  const h1 = email.buildInactiveReengagementHtml(cohortRow({ name: 'Alice', business_name: 'X' }));
  assert.match(h1, /Alice/);
  const h2 = email.buildInactiveReengagementHtml(cohortRow({ name: null, business_name: 'Studio Q' }));
  assert.match(h2, /Studio Q/);
  const h3 = email.buildInactiveReengagementHtml(cohortRow({ name: null, business_name: null }));
  assert.match(h3, /there/);
});

test('text: includes greeting + CTA URLs (trailing slash trimmed)', () => {
  process.env.APP_URL = 'https://decentinvoice.com/';
  const text = email.buildInactiveReengagementText(cohortRow({ name: 'Sam' }), new Date('2026-05-15T00:00:00Z'));
  assert.match(text, /Hi Sam/);
  assert.match(text, /https:\/\/decentinvoice\.com\/invoices\/quick/,
    'APP_URL trailing slash trimmed');
  assert.match(text, /Reply if anything/);
});

test('html/text: day arithmetic — floor at 14, growing window', () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  // 14 days since last login
  const h14 = email.buildInactiveReengagementHtml(
    cohortRow({ last_login_at: new Date('2026-05-01T00:00:00Z') }),
    new Date('2026-05-15T00:00:00Z')
  );
  assert.match(h14, /about 14 days/);
  // 30 days since last login
  const h30 = email.buildInactiveReengagementHtml(
    cohortRow({ last_login_at: new Date('2026-04-15T00:00:00Z') }),
    new Date('2026-05-15T00:00:00Z')
  );
  assert.match(h30, /about 30 days/);
  // A row that lands at <14 days (defence) still says "about 14 days" — copy
  // never undershoots the cohort gate.
  const h5 = email.buildInactiveReengagementHtml(
    cohortRow({ last_login_at: new Date('2026-05-10T00:00:00Z') }),
    new Date('2026-05-15T00:00:00Z')
  );
  assert.match(h5, /about 14 days/, 'floor at 14 — never undershoots the cohort');
});

test('daysSinceLastLogin: null / invalid inputs return floor of 14', () => {
  assert.strictEqual(email.daysSinceLastLogin(null, new Date()), 14);
  assert.strictEqual(email.daysSinceLastLogin(undefined, new Date()), 14);
  assert.strictEqual(email.daysSinceLastLogin('not-a-date', new Date()), 14);
});

// ---- Magic-login bake-in -----------------------------------------------

test('html: opts.magicLoginUrl bakes auto-sign-in into the primary CTA with ?next=/invoices/quick', () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const magicUrl = 'https://decentinvoice.com/auth/magic/xyz789';
  const html = email.buildInactiveReengagementHtml(cohortRow(), new Date('2026-05-15T00:00:00Z'),
    { magicLoginUrl: magicUrl });
  assert.match(html, /\/auth\/magic\/xyz789\?next=\/invoices\/quick/,
    'primary CTA uses magic URL with ?next=/invoices/quick');
  assert.ok(!/href="https:\/\/decentinvoice\.com\/invoices\/quick"/.test(html),
    'no plain /invoices/quick href leaks when magic URL is supplied');
});

test('text: opts.magicLoginUrl bakes into plaintext CTA', () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const magicUrl = 'https://decentinvoice.com/auth/magic/xyz789';
  const text = email.buildInactiveReengagementText(cohortRow(), new Date('2026-05-15T00:00:00Z'),
    { magicLoginUrl: magicUrl });
  assert.match(text, /Create your next invoice: https:\/\/decentinvoice\.com\/auth\/magic\/xyz789\?next=\/invoices\/quick/);
});

test('html: whitespace-only magicLoginUrl falls back to plain CTA', () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const html = email.buildInactiveReengagementHtml(cohortRow(), new Date(),
    { magicLoginUrl: '   ' });
  assert.match(html, /https:\/\/decentinvoice\.com\/invoices\/quick/);
  assert.ok(!/\/auth\/magic\//.test(html));
});

test('REENGAGEMENT_TTL_MINUTES is 14 days (matches the cohort gate)', () => {
  assert.strictEqual(job.REENGAGEMENT_TTL_MINUTES, 14 * 24 * 60);
});

test('DEFAULT_MIN_INACTIVE_HOURS is 14 days', () => {
  assert.strictEqual(job.DEFAULT_MIN_INACTIVE_HOURS, 14 * 24);
});

// ---- Orchestrator tests ------------------------------------------------

function fakeDb(rows = []) {
  const stamped = [];
  return {
    rows,
    stamped,
    async getUsersForInactiveReengagement() { return rows; },
    async markInactiveReengagementSent(userId) {
      stamped.push(userId);
      return { id: userId, inactive_reengagement_sent_at: new Date() };
    }
  };
}

test('happy path: sends + stamps + mints magic-link with the cohort TTL', async () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const sends = [];
  const mintCalls = [];
  const db = fakeDb([cohortRow({ id: 42, email: 'sam@test.io', name: 'Sam' })]);
  const summary = await job.processInactiveReengagement({
    db,
    sendEmail: async (p) => { sends.push(p); return { ok: true, id: 'em_1' }; },
    mintMagicLoginToken: async (_db, userId, opts) => {
      mintCalls.push({ userId, opts });
      return { ok: true, url: `https://decentinvoice.com/auth/magic/tok-${userId}` };
    },
    now: new Date('2026-05-15T15:00:00Z'),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.found, 1);
  assert.strictEqual(summary.sent, 1);
  assert.strictEqual(summary.errors, 0);
  assert.deepStrictEqual(db.stamped, [42]);
  assert.strictEqual(sends.length, 1);
  assert.strictEqual(sends[0].to, 'sam@test.io');
  assert.match(sends[0].subject, /Still freelancing/);
  assert.match(sends[0].html, /\/auth\/magic\/tok-42\?next=\/invoices\/quick/);
  assert.strictEqual(mintCalls.length, 1);
  assert.strictEqual(mintCalls[0].userId, 42);
  assert.strictEqual(mintCalls[0].opts.ttlMinutes, job.REENGAGEMENT_TTL_MINUTES);
});

test('magic-link: cross-user token isolation — user A never sees user B magic URL', async () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const sends = [];
  const db = fakeDb([
    cohortRow({ id: 7, email: 'a@a.com' }),
    cohortRow({ id: 8, email: 'b@b.com' })
  ]);
  await job.processInactiveReengagement({
    db,
    sendEmail: async (p) => { sends.push(p); return { ok: true }; },
    mintMagicLoginToken: async (_db, uid) => ({ ok: true, url: `https://decentinvoice.com/auth/magic/tok-${uid}` }),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.match(sends[0].html, /\/auth\/magic\/tok-7\?next=\/invoices\/quick/);
  assert.ok(!/\/auth\/magic\/tok-8/.test(sends[0].html),
    'user 7 must not see user 8 magic token');
  assert.match(sends[1].html, /\/auth\/magic\/tok-8\?next=\/invoices\/quick/);
});

test('magic-link: mint failure soft-falls to plain CTA + email still ships + stamp lands', async () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const sends = [];
  const db = fakeDb([cohortRow({ id: 99, email: 'q@q.com' })]);
  const summary = await job.processInactiveReengagement({
    db,
    sendEmail: async (p) => { sends.push(p); return { ok: true }; },
    mintMagicLoginToken: async () => ({ ok: false, reason: 'db_error' }),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.sent, 1);
  assert.deepStrictEqual(db.stamped, [99]);
  assert.match(sends[0].html, /https:\/\/decentinvoice\.com\/invoices\/quick/);
  assert.ok(!/\/auth\/magic\//.test(sends[0].html));
});

test('magic-link: mint throw → soft-fall + email still ships', async () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const sends = [];
  const db = fakeDb([cohortRow({ id: 5, email: 'z@z.com' })]);
  const summary = await job.processInactiveReengagement({
    db,
    sendEmail: async (p) => { sends.push(p); return { ok: true }; },
    mintMagicLoginToken: async () => { throw new Error('mint exploded'); },
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.sent, 1);
  assert.strictEqual(summary.errors, 0, 'mint throw must not count as a send error');
});

test('replyTo precedence: reply_to_email > business_email > email', async () => {
  const sends = [];
  const db = fakeDb([
    cohortRow({ id: 1, email: 'fallback@x.com', reply_to_email: 'reply@x.com', business_email: 'biz@x.com' }),
    cohortRow({ id: 2, email: 'fallback@y.com', reply_to_email: null, business_email: 'biz@y.com' }),
    cohortRow({ id: 3, email: 'fallback@z.com', reply_to_email: null, business_email: null })
  ]);
  await job.processInactiveReengagement({
    db,
    sendEmail: async (p) => { sends.push(p); return { ok: true }; },
    mintMagicLoginToken: async () => ({ ok: false, reason: 'stubbed' }),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(sends[0].replyTo, 'reply@x.com');
  assert.strictEqual(sends[1].replyTo, 'biz@y.com');
  assert.strictEqual(sends[2].replyTo, 'fallback@z.com');
});

test('users without email are skipped (defence-in-depth)', async () => {
  const sends = [];
  const db = fakeDb([cohortRow({ id: 9, email: null })]);
  const summary = await job.processInactiveReengagement({
    db,
    sendEmail: async (p) => { sends.push(p); return { ok: true }; },
    mintMagicLoginToken: async () => ({ ok: false, reason: 'stubbed' }),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.sent, 0);
  assert.strictEqual(summary.skipped, 1);
  assert.strictEqual(sends.length, 0);
  assert.deepStrictEqual(db.stamped, []);
});

test('not_configured does NOT stamp DB (next cron pass retries)', async () => {
  const db = fakeDb([cohortRow({ id: 99, email: 'foo@bar.com' })]);
  const summary = await job.processInactiveReengagement({
    db,
    sendEmail: async () => ({ ok: false, reason: 'not_configured' }),
    mintMagicLoginToken: async () => ({ ok: false, reason: 'stubbed' }),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.found, 1);
  assert.strictEqual(summary.sent, 0);
  assert.strictEqual(summary.notConfigured, 1);
  assert.strictEqual(summary.errors, 0);
  assert.deepStrictEqual(db.stamped, []);
});

test('email error continues batch; only successful sends stamped', async () => {
  const sends = [];
  const db = fakeDb([
    cohortRow({ id: 1, email: 'a@a.com' }),
    cohortRow({ id: 2, email: 'b@b.com' })
  ]);
  let i = 0;
  const summary = await job.processInactiveReengagement({
    db,
    sendEmail: async (p) => {
      i += 1;
      if (i === 1) throw new Error('SMTP exploded');
      sends.push(p);
      return { ok: true };
    },
    mintMagicLoginToken: async () => ({ ok: false, reason: 'stubbed' }),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.found, 2);
  assert.strictEqual(summary.sent, 1);
  assert.strictEqual(summary.errors, 1);
  assert.deepStrictEqual(db.stamped, [2]);
  assert.strictEqual(sends[0].to, 'b@b.com');
});

test('idempotent across runs (filter respects stamp)', async () => {
  const initial = [cohortRow({ id: 11, email: 'c@c.com' })];
  const stamped = [];
  const db = {
    async getUsersForInactiveReengagement() {
      return initial.filter(u => !stamped.includes(u.id));
    },
    async markInactiveReengagementSent(uid) { stamped.push(uid); return { id: uid }; }
  };
  const sends = [];
  const send = async (p) => { sends.push(p); return { ok: true }; };
  const r1 = await job.processInactiveReengagement({
    db, sendEmail: send,
    mintMagicLoginToken: async () => ({ ok: false, reason: 'stubbed' }),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(r1.sent, 1);
  const r2 = await job.processInactiveReengagement({
    db, sendEmail: send,
    mintMagicLoginToken: async () => ({ ok: false, reason: 'stubbed' }),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(r2.found, 0, 'one-shot stamp excludes the row on the next run');
  assert.strictEqual(r2.sent, 0);
  assert.strictEqual(sends.length, 1, 'one email across both runs');
});

test('top-level query failure → errors=1, no throw', async () => {
  const db = {
    async getUsersForInactiveReengagement() { throw new Error('PG down'); },
    async markInactiveReengagementSent() { throw new Error('should not be called'); }
  };
  const summary = await job.processInactiveReengagement({
    db,
    sendEmail: async () => ({ ok: true }),
    mintMagicLoginToken: async () => ({ ok: false, reason: 'stubbed' }),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.found, 0);
  assert.strictEqual(summary.sent, 0);
  assert.strictEqual(summary.errors, 1);
});

test('minInactiveHours opt is threaded through to the db helper', async () => {
  let captured = null;
  const db = {
    async getUsersForInactiveReengagement(hours) { captured = hours; return []; },
    async markInactiveReengagementSent() { return null; }
  };
  await job.processInactiveReengagement({
    db,
    sendEmail: async () => ({ ok: true }),
    mintMagicLoginToken: async () => ({ ok: false, reason: 'stubbed' }),
    minInactiveHours: 30 * 24,
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(captured, 30 * 24);
});

test('ttlMinutes opt overrides REENGAGEMENT_TTL_MINUTES on the mint call', async () => {
  let capturedTtl = null;
  const db = fakeDb([cohortRow({ id: 1, email: 'a@a.com' })]);
  await job.processInactiveReengagement({
    db,
    sendEmail: async () => ({ ok: true }),
    mintMagicLoginToken: async (_db, _uid, opts) => {
      capturedTtl = opts.ttlMinutes;
      return { ok: true, url: 'https://x/auth/magic/t' };
    },
    ttlMinutes: 60,
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(capturedTtl, 60);
});

// ---- Cron wiring -------------------------------------------------------

test('startInactiveReengagementJob blocked under NODE_ENV=test', () => {
  process.env.NODE_ENV = 'test';
  job.stopInactiveReengagementJob();
  const r = job.startInactiveReengagementJob();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'test_env');
});

test('startInactiveReengagementJob: cron tick triggers processInactiveReengagement', async () => {
  job.stopInactiveReengagementJob();
  let captured = null;
  const fakeCron = {
    schedule(expr, cb, opts) {
      captured = { expr, cb, opts };
      return { stop() {} };
    }
  };
  const db = fakeDb([cohortRow({ id: 51, email: 'e@e.com' })]);
  let sendCalls = 0;
  const r = job.startInactiveReengagementJob({
    force: true,
    cron: fakeCron,
    schedule: '0 15 * * *',
    db,
    sendEmail: async () => { sendCalls += 1; return { ok: true }; },
    mintMagicLoginToken: async () => ({ ok: false, reason: 'stubbed' }),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.schedule, '0 15 * * *');
  assert.ok(captured, 'cron.schedule must be called');
  assert.strictEqual(captured.expr, '0 15 * * *');
  assert.strictEqual(captured.opts && captured.opts.timezone, 'UTC');
  await captured.cb();
  assert.strictEqual(sendCalls, 1);
  assert.deepStrictEqual(db.stamped, [51]);
  job.stopInactiveReengagementJob();
});

test('startInactiveReengagementJob refuses double start', () => {
  job.stopInactiveReengagementJob();
  const fakeCron = { schedule() { return { stop() {} }; } };
  const r1 = job.startInactiveReengagementJob({ force: true, cron: fakeCron });
  assert.strictEqual(r1.ok, true);
  const r2 = job.startInactiveReengagementJob({ force: true, cron: fakeCron });
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.reason, 'already_running');
  job.stopInactiveReengagementJob();
});

test('DEFAULT_SCHEDULE is 0 15 * * * (15:00 UTC — after the noon cluster)', () => {
  assert.strictEqual(job.DEFAULT_SCHEDULE, '0 15 * * *');
});

// ---- SQL contract on db.getUsersForInactiveReengagement ----------------

test('SQL: query gates on the seven activation-funnel predicates', async () => {
  delete require.cache[require.resolve('../db')];
  const realDbMod = require('../db');
  const realPool = realDbMod.pool;
  const db = realDbMod.db;
  let captured = null;
  const originalQuery = realPool.query.bind(realPool);
  realPool.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };
  };
  try {
    await db.getUsersForInactiveReengagement(14 * 24);
    assert.ok(captured, 'query was issued');
    assert.match(captured.sql, /invoice_count\s*>\s*0/i,
      'cohort requires already-activated users (invoice_count > 0)');
    assert.match(captured.sql, /email\s+IS\s+NOT\s+NULL/i,
      'email gate — defence in depth');
    assert.match(captured.sql, /welcome_email_sent_at\s+IS\s+NOT\s+NULL/i,
      'welcome must have fired — activation ordering');
    assert.match(captured.sql, /lifecycle_emails_opted_out_at\s+IS\s+NULL/i,
      'lifecycle opt-out respected');
    assert.match(captured.sql, /last_login_at\s+IS\s+NOT\s+NULL/i,
      'must have logged in at least once');
    assert.match(captured.sql, /last_login_at\s*<=\s*NOW\(\)\s*-\s*\(\$1\s*\*\s*INTERVAL\s*'1 hour'\)/i,
      'inactivity threshold via parameterised hour interval');
    assert.match(captured.sql, /inactive_reengagement_sent_at\s+IS\s+NULL/i,
      'one-shot idempotency stamp');
    assert.match(captured.sql, /ORDER BY\s+last_login_at\s+ASC/i,
      'oldest-silent first');
    assert.match(captured.sql, /LIMIT\s+500/i, 'bounded batch');
    assert.deepStrictEqual(captured.params, [14 * 24]);
  } finally {
    realPool.query = originalQuery;
  }
});

test('SQL: input sanitisation — non-numeric / negative falls back to 14d default', async () => {
  delete require.cache[require.resolve('../db')];
  const realDbMod = require('../db');
  const realPool = realDbMod.pool;
  const db = realDbMod.db;
  let captured = null;
  const originalQuery = realPool.query.bind(realPool);
  realPool.query = async (sql, params) => { captured = { sql, params }; return { rows: [] }; };
  try {
    await db.getUsersForInactiveReengagement(-5);
    assert.deepStrictEqual(captured.params, [14 * 24], 'negative coerces to 14d default');
    await db.getUsersForInactiveReengagement('abc');
    assert.deepStrictEqual(captured.params, [14 * 24], 'non-numeric coerces to 14d default');
    await db.getUsersForInactiveReengagement();
    assert.deepStrictEqual(captured.params, [14 * 24], 'no-arg defaults to 14d');
  } finally {
    realPool.query = originalQuery;
  }
});

test('db.markInactiveReengagementSent: idempotency guard + falsy-userId short-circuit', async () => {
  delete require.cache[require.resolve('../db')];
  const realDbMod = require('../db');
  const realPool = realDbMod.pool;
  const db = realDbMod.db;
  let captured = null;
  let calls = 0;
  const originalQuery = realPool.query.bind(realPool);
  realPool.query = async (sql, params) => {
    calls += 1;
    captured = { sql, params };
    return { rows: [{ id: params[0], inactive_reengagement_sent_at: new Date() }] };
  };
  try {
    assert.strictEqual(await db.markInactiveReengagementSent(null), null);
    assert.strictEqual(await db.markInactiveReengagementSent(0), null);
    assert.strictEqual(await db.markInactiveReengagementSent(undefined), null);
    assert.strictEqual(calls, 0, 'no SQL must be issued for falsy userId');
    const r = await db.markInactiveReengagementSent(7);
    assert.ok(r && r.id === 7);
    assert.match(captured.sql, /UPDATE\s+users\s+SET\s+inactive_reengagement_sent_at\s*=\s*NOW\(\)/i);
    assert.match(captured.sql, /inactive_reengagement_sent_at\s+IS\s+NULL/i,
      'guard prevents double-stamp on concurrent callers');
    assert.deepStrictEqual(captured.params, [7]);
  } finally {
    realPool.query = originalQuery;
  }
});

// ---- Run ---------------------------------------------------------------

(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log(`  ok  ${t.name}`);
    } catch (err) {
      failed++;
      console.error(`  FAIL ${t.name}`);
      console.error(`    ${err && err.stack || err}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed (inactive-reengagement.test.js)`);
  if (failed > 0) process.exit(1);
})();
