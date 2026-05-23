'use strict';

/*
 * Second No-Invoice Nudge — 7-day post-signup re-engagement email cron.
 *
 * Coverage mirrors tests/no-invoice-nudge.test.js. The second nudge is a
 * separate one-shot for users still at invoice_count = 0 a week after signup;
 * it covers the cohort the 48h nudge didn't recover (or never reached because
 * RESEND_API_KEY was unset on that tick). Asserted properties:
 *   1. Pure formatters: greeting, XSS escape, CTA URLs with/without APP_URL.
 *   2. Different framing from the 48h nudge (subject + body shape).
 *   3. Magic-login bake-in: per-row token + ?next=/invoices/quick deep-link.
 *   4. Happy path: cohort row → email sent + user stamp written.
 *   5. not_configured → no stamp, retries next tick.
 *   6. sendEmail throw / mint throw → counted/soft-failed correctly.
 *   7. Idempotency across runs.
 *   8. Top-level query failure → errors=1, no throw.
 *   9. startSecondNoInvoiceNudgeJob: NODE_ENV=test block, force-accept,
 *      double-start refusal, cron tick wiring.
 *  10. DEFAULT_SCHEDULE shape (13:00 UTC — strictly after the 48h nudge at 12).
 *  11. SQL contract on db.getUsersForSecondNoInvoiceNudge — gates on
 *      invoice_count = 0, welcome stamped, second_no_invoice_nudge_sent_at
 *      NULL, age window, and the "no first-nudge within 4 days" guard.
 *  12. db.markSecondNoInvoiceNudgeSent: idempotency UPDATE guard + falsy
 *      short-circuit.
 *
 * Run: NODE_ENV=test node tests/second-no-invoice-nudge.test.js
 */

const assert = require('assert');

const second = require('../jobs/second-no-invoice-nudge');

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
    created_at: new Date('2026-05-10T00:00:00Z'),
    ...over
  };
}

// ---- Pure formatters ---------------------------------------------------

test('subject: empathetic framing, no PII, distinguishable from 48h nudge', () => {
  const subj = second.buildSecondNoInvoiceNudgeSubject();
  assert.match(subj, /[Aa]nything blocking/);
  assert.match(subj, /[Hh]it reply/);
  // No identifying info — generic so the cohort isn't leaked via preview.
  assert.ok(!/Sam|Studio|test\.io/.test(subj));
  // Must NOT be the same line as the 48h nudge — that would feel like spam.
  const firstNudge = require('../jobs/no-invoice-nudge');
  assert.notStrictEqual(subj, firstNudge.buildNoInvoiceNudgeSubject(),
    'second nudge subject must differ from the first');
});

test('html: empathetic problem-solving body + reply prompt + CTA', () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const html = second.buildSecondNoInvoiceNudgeHtml(cohortRow());
  assert.match(html, /Anything blocking your first invoice/);
  assert.match(html, /hit reply/i);
  // The body must mention the three common blockers (between gigs / wording /
  // looking unprofessional) — that's the differentiator from the 48h nudge.
  assert.match(html, /[Bb]etween gigs/);
  assert.match(html, /how the invoice will look/i);
  assert.match(html, /Send your first invoice/);
  // CTA points at the express form, not the high-friction /invoices/new.
  assert.match(html, /https:\/\/decentinvoice\.com\/invoices\/quick/);
  assert.ok(!/decentinvoice\.com\/invoices\/new(?!\?)/.test(html),
    'CTA must NOT point at the legacy /invoices/new form');
  // The "won't keep poking" promise is the explicit one-shot commitment —
  // matches the db query's IS NULL idempotency gate.
  assert.match(html, /won't keep poking/i);
});

test('html: escapes hostile name (XSS defence)', () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const html = second.buildSecondNoInvoiceNudgeHtml(cohortRow({
    name: '<script>alert(1)</script>'
  }));
  assert.ok(!/<script>alert\(1\)<\/script>/.test(html),
    'raw script must be escaped');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('html: CTA omitted gracefully when APP_URL is unset', () => {
  delete process.env.APP_URL;
  const html = second.buildSecondNoInvoiceNudgeHtml(cohortRow());
  assert.ok(!/<a href=/.test(html),
    'no CTA <a> when APP_URL is unset — graceful degradation');
  assert.match(html, /Anything blocking your first invoice/, 'body copy remains');
});

test('html: greeting falls back through name → business_name → "there"', () => {
  const h1 = second.buildSecondNoInvoiceNudgeHtml(cohortRow({ name: 'Alice', business_name: 'X' }));
  assert.match(h1, /Hi Alice,/);
  const h2 = second.buildSecondNoInvoiceNudgeHtml(cohortRow({ name: null, business_name: 'Studio Q' }));
  assert.match(h2, /Hi Studio Q,/);
  const h3 = second.buildSecondNoInvoiceNudgeHtml(cohortRow({ name: null, business_name: null }));
  assert.match(h3, /Hi there,/);
});

test('text: includes greeting + CTA URLs (trailing slash trimmed)', () => {
  process.env.APP_URL = 'https://decentinvoice.com/';
  const text = second.buildSecondNoInvoiceNudgeText(cohortRow({ name: 'Sam' }));
  assert.match(text, /Hi Sam/);
  assert.match(text, /https:\/\/decentinvoice\.com\/invoices\/quick/,
    'APP_URL trailing slash must be trimmed before joining /invoices/quick');
  assert.match(text, /https:\/\/decentinvoice\.com\/dashboard/);
  assert.match(text, /hit reply/i);
  assert.match(text, /won't keep poking/i);
});

// ---- Magic-login bake-in -----------------------------------------------

test('html: opts.magicLoginUrl bakes the auto-sign-in URL into the primary CTA with ?next=/invoices/quick', () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const magicUrl = 'https://decentinvoice.com/auth/magic/abc123def';
  const html = second.buildSecondNoInvoiceNudgeHtml(cohortRow(), null, { magicLoginUrl: magicUrl });
  assert.match(html, /\/auth\/magic\/abc123def\?next=\/invoices\/quick/,
    'primary CTA href is the magic URL with ?next=/invoices/quick');
  assert.ok(!/href="https:\/\/decentinvoice\.com\/invoices\/quick"/.test(html),
    'no plain /invoices/quick href when a magic URL is supplied');
  assert.match(html, /https:\/\/decentinvoice\.com\/dashboard/,
    'secondary dashboard link stays plain (auto-sign-in into the dashboard would force a second decision)');
});

test('text: opts.magicLoginUrl bakes the auto-sign-in URL into the plaintext CTA', () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const magicUrl = 'https://decentinvoice.com/auth/magic/abc123def';
  const text = second.buildSecondNoInvoiceNudgeText(cohortRow(), null, { magicLoginUrl: magicUrl });
  assert.match(text, /Send your first invoice: https:\/\/decentinvoice\.com\/auth\/magic\/abc123def\?next=\/invoices\/quick/);
  assert.ok(!/Send your first invoice: https:\/\/decentinvoice\.com\/invoices\/quick/.test(text),
    'no plain-CTA leak when magic URL is supplied');
});

test('html/text: opts.magicLoginUrl absent → plain /invoices/quick fallback', () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const htmlNoOpts = second.buildSecondNoInvoiceNudgeHtml(cohortRow());
  assert.match(htmlNoOpts, /https:\/\/decentinvoice\.com\/invoices\/quick/);
  assert.ok(!/\/auth\/magic\//.test(htmlNoOpts), 'no magic URL when opts absent');
  const htmlEmptyMagic = second.buildSecondNoInvoiceNudgeHtml(cohortRow(), null, { magicLoginUrl: '   ' });
  assert.match(htmlEmptyMagic, /https:\/\/decentinvoice\.com\/invoices\/quick/,
    'whitespace-only magicLoginUrl is treated as absent');
});

test('NUDGE_TTL_MINUTES is 7 days', () => {
  assert.strictEqual(second.NUDGE_TTL_MINUTES, 7 * 24 * 60);
});

test('DEFAULT_MIN_AGE_HOURS is 168 (7 days)', () => {
  assert.strictEqual(second.DEFAULT_MIN_AGE_HOURS, 168);
});

// ---- Orchestrator tests ------------------------------------------------

function fakeDb(rows = []) {
  const stamped = [];
  return {
    rows,
    stamped,
    async getUsersForSecondNoInvoiceNudge() { return rows; },
    async markSecondNoInvoiceNudgeSent(userId) {
      stamped.push(userId);
      return { id: userId, second_no_invoice_nudge_sent_at: new Date() };
    }
  };
}

test('happy path: sends and stamps', async () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const sends = [];
  const db = fakeDb([cohortRow({ id: 42, email: 'sam@test.io', name: 'Sam' })]);
  const summary = await second.processSecondNoInvoiceNudges({
    db,
    sendEmail: async (p) => { sends.push(p); return { ok: true, id: 'em_1' }; },
    mintMagicLoginToken: async () => ({ ok: false, reason: 'stubbed' }),
    now: new Date('2026-05-17T13:00:00Z'),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.found, 1);
  assert.strictEqual(summary.sent, 1);
  assert.strictEqual(summary.errors, 0);
  assert.strictEqual(summary.notConfigured, 0);
  assert.deepStrictEqual(db.stamped, [42]);
  assert.strictEqual(sends.length, 1);
  assert.strictEqual(sends[0].to, 'sam@test.io');
  assert.match(sends[0].subject, /Anything blocking/);
  assert.match(sends[0].html, /Hi Sam/);
  assert.match(sends[0].text, /Hi Sam/);
});

test('magic-login: mints once per cohort row + bakes per-user URL', async () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const sends = [];
  const mintCalls = [];
  const db = fakeDb([
    cohortRow({ id: 7, email: 'a@a.com', name: 'A' }),
    cohortRow({ id: 8, email: 'b@b.com', name: 'B' })
  ]);
  await second.processSecondNoInvoiceNudges({
    db,
    sendEmail: async (p) => { sends.push(p); return { ok: true, id: 'em' }; },
    mintMagicLoginToken: async (_db, userId, opts) => {
      mintCalls.push({ userId, opts });
      return { ok: true, url: `https://decentinvoice.com/auth/magic/tok-${userId}`, ttlMinutes: opts.ttlMinutes };
    },
    now: new Date('2026-05-17T13:00:00Z'),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(mintCalls.length, 2, 'mint called exactly once per cohort row');
  assert.strictEqual(mintCalls[0].userId, 7);
  assert.strictEqual(mintCalls[0].opts.ttlMinutes, second.NUDGE_TTL_MINUTES,
    'mint uses the 7-day TTL');
  assert.match(sends[0].html, /\/auth\/magic\/tok-7\?next=\/invoices\/quick/,
    'user 7 receives the user 7 magic URL');
  assert.match(sends[1].html, /\/auth\/magic\/tok-8\?next=\/invoices\/quick/,
    'user 8 receives the user 8 magic URL (no cross-user leak)');
  assert.ok(!/\/auth\/magic\/tok-7/.test(sends[1].html),
    'user 8 must NOT receive user 7 token');
});

test('magic-login: mint failure soft-fails to plain CTA, email still ships', async () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const sends = [];
  const warns = [];
  const db = fakeDb([cohortRow({ id: 99, email: 'q@q.com', name: 'Q' })]);
  const summary = await second.processSecondNoInvoiceNudges({
    db,
    sendEmail: async (p) => { sends.push(p); return { ok: true, id: 'em_99' }; },
    mintMagicLoginToken: async () => ({ ok: false, reason: 'db_error' }),
    log: { error: () => {}, warn: (...a) => warns.push(a), log: () => {} }
  });
  assert.strictEqual(summary.sent, 1, 'mint failure does NOT block the send');
  assert.deepStrictEqual(db.stamped, [99]);
  assert.match(sends[0].html, /https:\/\/decentinvoice\.com\/invoices\/quick/);
  assert.ok(!/\/auth\/magic\//.test(sends[0].html));
  assert.ok(warns.some(args => /magic-link mint skipped/.test(args.join(' '))));
});

test('magic-login: mint throws → soft-fails, no error counted', async () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const sends = [];
  const db = fakeDb([cohortRow({ id: 5, email: 'z@z.com' })]);
  const summary = await second.processSecondNoInvoiceNudges({
    db,
    sendEmail: async (p) => { sends.push(p); return { ok: true }; },
    mintMagicLoginToken: async () => { throw new Error('mint exploded'); },
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.sent, 1);
  assert.strictEqual(summary.errors, 0,
    'mint throw must not count as a send error');
  assert.match(sends[0].html, /https:\/\/decentinvoice\.com\/invoices\/quick/);
});

test('replyTo precedence: reply_to_email > business_email > email', async () => {
  const sends = [];
  const db = fakeDb([
    cohortRow({ id: 1, email: 'fallback@x.com', reply_to_email: 'reply@x.com', business_email: 'biz@x.com' }),
    cohortRow({ id: 2, email: 'fallback@y.com', reply_to_email: null, business_email: 'biz@y.com' }),
    cohortRow({ id: 3, email: 'fallback@z.com', reply_to_email: null, business_email: null })
  ]);
  await second.processSecondNoInvoiceNudges({
    db,
    sendEmail: async (p) => { sends.push(p); return { ok: true }; },
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(sends[0].replyTo, 'reply@x.com');
  assert.strictEqual(sends[1].replyTo, 'biz@y.com');
  assert.strictEqual(sends[2].replyTo, 'fallback@z.com');
});

test('users without email are skipped (defence-in-depth)', async () => {
  const sends = [];
  const db = fakeDb([cohortRow({ id: 9, email: null })]);
  const summary = await second.processSecondNoInvoiceNudges({
    db,
    sendEmail: async (p) => { sends.push(p); return { ok: true }; },
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.sent, 0);
  assert.strictEqual(summary.skipped, 1);
  assert.strictEqual(sends.length, 0);
  assert.deepStrictEqual(db.stamped, []);
});

test('not_configured does NOT stamp DB (next cron pass retries)', async () => {
  const db = fakeDb([cohortRow({ id: 99, email: 'foo@bar.com' })]);
  const summary = await second.processSecondNoInvoiceNudges({
    db,
    sendEmail: async () => ({ ok: false, reason: 'not_configured' }),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.found, 1);
  assert.strictEqual(summary.sent, 0);
  assert.strictEqual(summary.notConfigured, 1);
  assert.strictEqual(summary.errors, 0,
    'not_configured is a clean skip, not an error');
  assert.deepStrictEqual(db.stamped, []);
});

test('email error continues batch; only successful sends stamped', async () => {
  const sends = [];
  const db = fakeDb([
    cohortRow({ id: 1, email: 'a@a.com' }),
    cohortRow({ id: 2, email: 'b@b.com' })
  ]);
  let i = 0;
  const summary = await second.processSecondNoInvoiceNudges({
    db,
    sendEmail: async (p) => {
      i += 1;
      if (i === 1) throw new Error('SMTP exploded');
      sends.push(p);
      return { ok: true, id: 'em_b' };
    },
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
    async getUsersForSecondNoInvoiceNudge() {
      return initial.filter(u => !stamped.includes(u.id));
    },
    async markSecondNoInvoiceNudgeSent(uid) { stamped.push(uid); return { id: uid }; }
  };
  const sends = [];
  const send = async (p) => { sends.push(p); return { ok: true, id: 'e' }; };
  const r1 = await second.processSecondNoInvoiceNudges({
    db, sendEmail: send,
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(r1.sent, 1);
  const r2 = await second.processSecondNoInvoiceNudges({
    db, sendEmail: send,
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(r2.found, 0, 'one-shot stamp excludes the row on the next run');
  assert.strictEqual(r2.sent, 0);
  assert.strictEqual(sends.length, 1, 'one email across both runs — never repeats');
});

test('top-level query failure → errors=1, no throw', async () => {
  const db = {
    async getUsersForSecondNoInvoiceNudge() { throw new Error('PG down'); },
    async markSecondNoInvoiceNudgeSent() { throw new Error('should not be called'); }
  };
  const summary = await second.processSecondNoInvoiceNudges({
    db,
    sendEmail: async () => ({ ok: true }),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.found, 0);
  assert.strictEqual(summary.sent, 0);
  assert.strictEqual(summary.errors, 1);
});

test('minAgeHours opt is threaded through to the db helper', async () => {
  let captured = null;
  const db = {
    async getUsersForSecondNoInvoiceNudge(hours) { captured = hours; return []; },
    async markSecondNoInvoiceNudgeSent() { return null; }
  };
  await second.processSecondNoInvoiceNudges({
    db,
    sendEmail: async () => ({ ok: true }),
    minAgeHours: 240,
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(captured, 240);
});

// ---- Cron wiring -------------------------------------------------------

test('startSecondNoInvoiceNudgeJob blocked under NODE_ENV=test', () => {
  process.env.NODE_ENV = 'test';
  second.stopSecondNoInvoiceNudgeJob();
  const r = second.startSecondNoInvoiceNudgeJob();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'test_env');
});

test('startSecondNoInvoiceNudgeJob: cron tick triggers processSecondNoInvoiceNudges', async () => {
  second.stopSecondNoInvoiceNudgeJob();
  let captured = null;
  const fakeCron = {
    schedule(expr, cb, opts) {
      captured = { expr, cb, opts };
      return { stop() {} };
    }
  };
  const db = fakeDb([cohortRow({ id: 51, email: 'e@e.com' })]);
  let sendCalls = 0;
  const r = second.startSecondNoInvoiceNudgeJob({
    force: true,
    cron: fakeCron,
    schedule: '0 13 * * *',
    db,
    sendEmail: async () => { sendCalls += 1; return { ok: true }; },
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.schedule, '0 13 * * *');
  assert.ok(captured, 'cron.schedule must be called');
  assert.strictEqual(captured.expr, '0 13 * * *');
  assert.strictEqual(captured.opts && captured.opts.timezone, 'UTC');
  await captured.cb();
  assert.strictEqual(sendCalls, 1, 'cron tick must invoke processSecondNoInvoiceNudges');
  assert.deepStrictEqual(db.stamped, [51]);
  second.stopSecondNoInvoiceNudgeJob();
});

test('startSecondNoInvoiceNudgeJob refuses double start', () => {
  second.stopSecondNoInvoiceNudgeJob();
  const fakeCron = { schedule() { return { stop() {} }; } };
  const r1 = second.startSecondNoInvoiceNudgeJob({ force: true, cron: fakeCron });
  assert.strictEqual(r1.ok, true);
  const r2 = second.startSecondNoInvoiceNudgeJob({ force: true, cron: fakeCron });
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.reason, 'already_running');
  second.stopSecondNoInvoiceNudgeJob();
});

test('DEFAULT_SCHEDULE is 0 13 * * * (13:00 UTC — strictly after 48h nudge at 12:00)', () => {
  assert.strictEqual(second.DEFAULT_SCHEDULE, '0 13 * * *');
  const first = require('../jobs/no-invoice-nudge');
  // Same-day ordering guarantee: 48h nudge at 12 runs and stamps before this
  // job picks up its cohort at 13. The 4-day inner gap in the SQL query is
  // the real defence; the schedule offset is the belt.
  assert.strictEqual(first.DEFAULT_SCHEDULE, '0 12 * * *',
    'first nudge runs at 12:00 UTC; second must run after');
});

// ---- SQL contract on db.getUsersForSecondNoInvoiceNudge ----------------

test('SQL: query gates on invoice_count=0, welcome stamped, second_no_invoice_nudge_sent_at NULL, age, 4d gap', async () => {
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
    await db.getUsersForSecondNoInvoiceNudge(168);
    assert.ok(captured, 'query was issued');
    assert.match(captured.sql, /invoice_count\s*=\s*0/i,
      'invoice_count=0 gate — no real invoice ever created');
    assert.match(captured.sql, /welcome_email_sent_at\s+IS\s+NOT\s+NULL/i,
      'welcome must have fired before this nudge');
    assert.match(captured.sql, /second_no_invoice_nudge_sent_at\s+IS\s+NULL/i,
      'one-shot idempotency on the second-nudge stamp');
    assert.match(captured.sql, /pending_invoice_nudge_sent_at\s+IS\s+NULL/i,
      'mutual-exclusion with the pending-quick-invoice nudge');
    assert.match(captured.sql, /email\s+IS\s+NOT\s+NULL/i,
      'email gate — defence in depth');
    assert.match(captured.sql, /created_at\s*<=\s*NOW\(\)\s*-\s*\(\$1\s*\*\s*INTERVAL\s*'1 hour'\)/i,
      'age threshold via parameter');
    // The inner 4-day gap prevents the first and second nudges firing on the
    // same cron day for a backfilled cohort.
    assert.match(captured.sql, /no_invoice_nudge_sent_at\s+IS\s+NULL/i,
      'permits users who never got the first nudge (e.g. RESEND was unset)');
    assert.match(captured.sql, /no_invoice_nudge_sent_at\s*<=\s*NOW\(\)\s*-\s*INTERVAL\s*'4 days'/i,
      '4-day inner gap between first and second nudge');
    assert.match(captured.sql, /ORDER BY\s+created_at\s+ASC/i,
      'oldest signups first — deterministic backlog drain');
    assert.deepStrictEqual(captured.params, [168]);
  } finally {
    realPool.query = originalQuery;
  }
});

test('SQL: non-numeric / negative minAgeHours coerces to default 168', async () => {
  delete require.cache[require.resolve('../db')];
  const realDbMod = require('../db');
  const realPool = realDbMod.pool;
  const db = realDbMod.db;
  let captured = null;
  const originalQuery = realPool.query.bind(realPool);
  realPool.query = async (sql, params) => { captured = { sql, params }; return { rows: [] }; };
  try {
    await db.getUsersForSecondNoInvoiceNudge(-5);
    assert.deepStrictEqual(captured.params, [168], 'negative coerces to default 168');
    await db.getUsersForSecondNoInvoiceNudge('abc');
    assert.deepStrictEqual(captured.params, [168], 'non-numeric coerces to default 168');
  } finally {
    realPool.query = originalQuery;
  }
});

test('db.markSecondNoInvoiceNudgeSent: idempotency guard + falsy-userId short-circuit', async () => {
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
    return { rows: [{ id: params[0], second_no_invoice_nudge_sent_at: new Date() }] };
  };
  try {
    assert.strictEqual(await db.markSecondNoInvoiceNudgeSent(null), null);
    assert.strictEqual(await db.markSecondNoInvoiceNudgeSent(0), null);
    assert.strictEqual(await db.markSecondNoInvoiceNudgeSent(undefined), null);
    assert.strictEqual(calls, 0, 'no SQL must be issued for falsy userId');
    const r = await db.markSecondNoInvoiceNudgeSent(7);
    assert.ok(r && r.id === 7);
    assert.match(captured.sql, /UPDATE\s+users\s+SET\s+second_no_invoice_nudge_sent_at\s*=\s*NOW\(\)/i);
    assert.match(captured.sql, /second_no_invoice_nudge_sent_at\s+IS\s+NULL/i,
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
  console.log(`\n${passed} passed, ${failed} failed (second-no-invoice-nudge.test.js)`);
  if (failed > 0) process.exit(1);
})();
