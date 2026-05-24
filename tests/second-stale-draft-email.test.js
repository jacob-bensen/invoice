'use strict';

/*
 * Second Stale-Draft Email — terminal follow-up on a still-unsent draft.
 *
 * Coverage mirrors tests/second-no-invoice-nudge.test.js and
 * tests/stale-draft-email.test.js. The second stale-draft is a separate
 * one-shot for users whose first stale-draft email fired 7+ days ago and
 * STILL have the draft sitting unsent. Asserted properties:
 *   1. Pure formatters: greeting, XSS escape, CTA URLs with/without APP_URL,
 *      days-since-created bucket.
 *   2. Differentiated framing from the first stale-draft email (subject + body).
 *   3. Magic-login bake-in: per-row token + ?next=/invoices/<id> deep-link.
 *   4. Happy path: cohort row → email sent + user stamp written.
 *   5. not_configured → no stamp, retries next tick.
 *   6. sendEmail throw / mint throw → counted/soft-failed correctly.
 *   7. Idempotency across runs.
 *   8. Top-level query failure → errors=1, no throw.
 *   9. startSecondStaleDraftEmailJob: NODE_ENV=test block, force-accept,
 *      double-start refusal, cron tick wiring.
 *  10. DEFAULT_SCHEDULE shape (11:30 UTC — strictly after first stale-draft
 *      at 11:00).
 *  11. SQL contract on db.getUsersForSecondStaleDraftEmail — gates on
 *      status='draft', is_seed=false, welcome stamped, first stale-draft
 *      sent_at <= NOW() - 7d, second one-shot NULL, age window.
 *  12. db.markSecondStaleDraftEmailSent: idempotency UPDATE guard + falsy
 *      short-circuit.
 *  13. Existing getUsersWithStaleDraftForEmail now suppresses users who
 *      already received the second-pass (regression-guard the new gate).
 *
 * Run: NODE_ENV=test node tests/second-stale-draft-email.test.js
 */

const assert = require('assert');

const second = require('../jobs/second-stale-draft-email');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function cohortRow(over = {}) {
  return {
    user_id: 42,
    invoice_id: 7001,
    invoice_number: 'INV-1001',
    client_name: 'Acme Corp',
    invoice_total: 500,
    draft_created_at: new Date('2026-05-01T00:00:00Z'),
    email: 'user@test.io',
    name: 'Sam',
    business_name: 'Studio',
    reply_to_email: null,
    business_email: 'biz@test.io',
    ...over
  };
}

// ---- Pure formatters ---------------------------------------------------

test('subject: empathetic framing, no PII, distinguishable from first stale-draft', () => {
  const subj = second.buildSecondStaleDraftSubject();
  assert.match(subj, /[Aa]nything blocking/);
  assert.match(subj, /[Hh]it reply/);
  assert.ok(!/INV-1001|Acme|Sam|Studio|test\.io/.test(subj),
    'no PII in subject');
  const first = require('../jobs/stale-draft-email');
  const firstSubj = first.buildStaleDraftSubject(cohortRow());
  assert.notStrictEqual(subj, firstSubj,
    'second-pass subject must differ from first stale-draft subject');
});

test('html: empathetic problem-solving body + reply prompt + CTA', () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const html = second.buildSecondStaleDraftHtml(cohortRow(), new Date('2026-05-10T00:00:00Z'));
  assert.match(html, /Is anything stopping you sending this/i);
  assert.match(html, /hit reply/i);
  // Body lists the common blockers — that's the differentiator from the
  // first stale-draft email's purely transactional "send it" copy.
  assert.match(html, /total is right/i, 'mentions "amount uncertainty" blocker');
  assert.match(html, /how the email\/share will look/i, 'mentions "presentation worry" blocker');
  assert.match(html, /job isn't actually done/i, 'mentions "not complete yet" blocker');
  assert.match(html, /already invoiced this client/i, 'mentions "duplicate / forgot to mark sent" blocker');
  // Mentions the invoice metadata so the recipient instantly knows which
  // draft we mean (versus a generic re-engagement).
  assert.match(html, /INV-1001/);
  assert.match(html, /Acme Corp/);
  assert.match(html, /\$500/);
  // The "last reminder" promise is the explicit one-shot commitment —
  // matches the db query's IS NULL idempotency gate.
  assert.match(html, /last reminder we'll send/i);
});

test('html: days-since-creation bucket renders honestly', () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const html = second.buildSecondStaleDraftHtml(
    cohortRow({ draft_created_at: new Date('2026-05-01T00:00:00Z') }),
    new Date('2026-05-10T12:00:00Z') // 9.5 days later
  );
  assert.match(html, /waiting for <strong>9 days<\/strong>/i,
    'days bucket is floor(hours/24) so 9.5d shows as 9');
});

test('html: escapes hostile name + invoice number (XSS defence)', () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const html = second.buildSecondStaleDraftHtml(cohortRow({
    name: '<script>alert(1)</script>',
    invoice_number: '"><img src=x>'
  }));
  assert.ok(!/<script>alert\(1\)<\/script>/.test(html),
    'raw script must be escaped');
  assert.ok(!/"><img src=x>/.test(html), 'invoice-number injection must be escaped');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('html: CTA omitted gracefully when APP_URL unset AND no magic URL', () => {
  delete process.env.APP_URL;
  const html = second.buildSecondStaleDraftHtml(cohortRow());
  assert.ok(!/<a href=/.test(html),
    'no CTA <a> when neither APP_URL nor magic URL — graceful degradation');
  assert.match(html, /Is anything stopping you sending this/i, 'body copy remains');
});

test('html: greeting falls back through name → business_name → "there"', () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const h1 = second.buildSecondStaleDraftHtml(cohortRow({ name: 'Alice', business_name: 'X' }));
  assert.match(h1, /Hi Alice,/);
  const h2 = second.buildSecondStaleDraftHtml(cohortRow({ name: null, business_name: 'Studio Q' }));
  assert.match(h2, /Hi Studio Q,/);
  const h3 = second.buildSecondStaleDraftHtml(cohortRow({ name: null, business_name: null }));
  assert.match(h3, /Hi there,/);
});

test('text: includes greeting, body, CTA URL (trailing slash trimmed)', () => {
  process.env.APP_URL = 'https://decentinvoice.com/';
  const text = second.buildSecondStaleDraftText(
    cohortRow({ name: 'Sam', invoice_id: 5012 }),
    new Date('2026-05-10T00:00:00Z')
  );
  assert.match(text, /Hi Sam/);
  assert.match(text, /hit reply/i);
  assert.match(text, /last reminder/i);
  assert.match(text, /https:\/\/decentinvoice\.com\/invoices\/5012/,
    'APP_URL trailing slash trimmed; deep-link to /invoices/<id>');
});

test('hoursOld / daysOld helpers handle missing or bad input', () => {
  assert.strictEqual(second.hoursOld(null), 0);
  assert.strictEqual(second.hoursOld('not-a-date'), 0);
  assert.strictEqual(second.daysOld(null), 1, 'daysOld floors to at least 1');
  const five = second.hoursOld(new Date('2026-05-01T00:00:00Z'), new Date('2026-05-01T05:00:00Z'));
  assert.strictEqual(five, 5);
});

// ---- Magic-login bake-in -----------------------------------------------

test('html: opts.magicLoginUrl bakes auto-sign-in URL with ?next=/invoices/<id>', () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const magicUrl = 'https://decentinvoice.com/auth/magic/abc123';
  const html = second.buildSecondStaleDraftHtml(
    cohortRow({ invoice_id: 9090 }), null, { magicLoginUrl: magicUrl }
  );
  assert.match(html, /\/auth\/magic\/abc123\?next=\/invoices\/9090/,
    'primary CTA href is the magic URL with ?next=/invoices/<id>');
  assert.ok(!/href="https:\/\/decentinvoice\.com\/invoices\/9090"/.test(html),
    'no plain /invoices/<id> href when a magic URL is supplied');
});

test('text: opts.magicLoginUrl bakes auto-sign-in URL into plaintext', () => {
  const text = second.buildSecondStaleDraftText(
    cohortRow({ invoice_id: 5012 }), null,
    { magicLoginUrl: 'https://decentinvoice.com/auth/magic/zzz' }
  );
  assert.match(text, /https:\/\/decentinvoice\.com\/auth\/magic\/zzz\?next=\/invoices\/5012/);
});

test('html/text: opts.magicLoginUrl absent → plain /invoices/<id> fallback', () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const html = second.buildSecondStaleDraftHtml(cohortRow({ invoice_id: 333 }));
  assert.match(html, /https:\/\/decentinvoice\.com\/invoices\/333/);
  assert.ok(!/\/auth\/magic\//.test(html), 'no magic URL when opts absent');
  const htmlEmpty = second.buildSecondStaleDraftHtml(
    cohortRow({ invoice_id: 333 }), null, { magicLoginUrl: '   ' }
  );
  assert.match(htmlEmpty, /https:\/\/decentinvoice\.com\/invoices\/333/,
    'whitespace-only magicLoginUrl is treated as absent');
});

test('NUDGE_TTL_MINUTES is 7 days', () => {
  assert.strictEqual(second.NUDGE_TTL_MINUTES, 7 * 24 * 60);
});

test('DEFAULT constants', () => {
  assert.strictEqual(second.DEFAULT_MIN_AGE_HOURS, 24);
  assert.strictEqual(second.DEFAULT_FIRST_SENT_GAP_DAYS, 7);
});

// ---- Orchestrator tests ------------------------------------------------

function fakeDb(rows = []) {
  const stamped = [];
  return {
    rows,
    stamped,
    async getUsersForSecondStaleDraftEmail() { return rows; },
    async markSecondStaleDraftEmailSent(userId) {
      stamped.push(userId);
      return { id: userId, second_stale_draft_email_sent_at: new Date() };
    }
  };
}

test('happy path: sends and stamps', async () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const sends = [];
  const db = fakeDb([cohortRow({ user_id: 42, email: 'sam@test.io', name: 'Sam' })]);
  const summary = await second.processSecondStaleDraftEmails({
    db,
    sendEmail: async (p) => { sends.push(p); return { ok: true, id: 'em_1' }; },
    mintMagicLoginToken: async () => ({ ok: false, reason: 'stubbed' }),
    now: new Date('2026-05-10T11:30:00Z'),
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
    cohortRow({ user_id: 7, invoice_id: 700, email: 'a@a.com' }),
    cohortRow({ user_id: 8, invoice_id: 800, email: 'b@b.com' })
  ]);
  await second.processSecondStaleDraftEmails({
    db,
    sendEmail: async (p) => { sends.push(p); return { ok: true, id: 'em' }; },
    mintMagicLoginToken: async (_db, userId, opts) => {
      mintCalls.push({ userId, opts });
      return { ok: true, url: `https://decentinvoice.com/auth/magic/tok-${userId}`, ttlMinutes: opts.ttlMinutes };
    },
    now: new Date('2026-05-10T11:30:00Z'),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(mintCalls.length, 2, 'mint called exactly once per cohort row');
  assert.strictEqual(mintCalls[0].userId, 7);
  assert.strictEqual(mintCalls[0].opts.ttlMinutes, second.NUDGE_TTL_MINUTES,
    'mint uses the 7-day TTL');
  assert.match(sends[0].html, /\/auth\/magic\/tok-7\?next=\/invoices\/700/,
    'user 7 receives the user 7 magic URL pointing at their invoice');
  assert.match(sends[1].html, /\/auth\/magic\/tok-8\?next=\/invoices\/800/,
    'user 8 receives the user 8 magic URL (no cross-user leak)');
  assert.ok(!/\/auth\/magic\/tok-7/.test(sends[1].html),
    'user 8 must NOT receive user 7 token');
});

test('magic-login: mint failure soft-fails to plain CTA, email still ships', async () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const sends = [];
  const warns = [];
  const db = fakeDb([cohortRow({ user_id: 99, invoice_id: 990, email: 'q@q.com' })]);
  const summary = await second.processSecondStaleDraftEmails({
    db,
    sendEmail: async (p) => { sends.push(p); return { ok: true, id: 'em_99' }; },
    mintMagicLoginToken: async () => ({ ok: false, reason: 'db_error' }),
    log: { error: () => {}, warn: (...a) => warns.push(a), log: () => {} }
  });
  assert.strictEqual(summary.sent, 1, 'mint failure does NOT block the send');
  assert.deepStrictEqual(db.stamped, [99]);
  assert.match(sends[0].html, /https:\/\/decentinvoice\.com\/invoices\/990/);
  assert.ok(!/\/auth\/magic\//.test(sends[0].html));
  assert.ok(warns.some(args => /magic-link mint skipped/.test(args.join(' '))));
});

test('magic-login: mint throws → soft-fails, no error counted', async () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const sends = [];
  const db = fakeDb([cohortRow({ user_id: 5, invoice_id: 500, email: 'z@z.com' })]);
  const summary = await second.processSecondStaleDraftEmails({
    db,
    sendEmail: async (p) => { sends.push(p); return { ok: true }; },
    mintMagicLoginToken: async () => { throw new Error('mint exploded'); },
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.sent, 1);
  assert.strictEqual(summary.errors, 0,
    'mint throw must not count as a send error');
  assert.match(sends[0].html, /https:\/\/decentinvoice\.com\/invoices\/500/);
});

test('replyTo precedence: reply_to_email > business_email > email', async () => {
  const sends = [];
  const db = fakeDb([
    cohortRow({ user_id: 1, email: 'fallback@x.com', reply_to_email: 'reply@x.com', business_email: 'biz@x.com' }),
    cohortRow({ user_id: 2, email: 'fallback@y.com', reply_to_email: null, business_email: 'biz@y.com' }),
    cohortRow({ user_id: 3, email: 'fallback@z.com', reply_to_email: null, business_email: null })
  ]);
  await second.processSecondStaleDraftEmails({
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
  const db = fakeDb([cohortRow({ user_id: 9, email: null })]);
  const summary = await second.processSecondStaleDraftEmails({
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
  const db = fakeDb([cohortRow({ user_id: 99, email: 'foo@bar.com' })]);
  const summary = await second.processSecondStaleDraftEmails({
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
    cohortRow({ user_id: 1, email: 'a@a.com' }),
    cohortRow({ user_id: 2, email: 'b@b.com' })
  ]);
  let i = 0;
  const summary = await second.processSecondStaleDraftEmails({
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
  const initial = [cohortRow({ user_id: 11, email: 'c@c.com' })];
  const stamped = [];
  const db = {
    async getUsersForSecondStaleDraftEmail() {
      return initial.filter(r => !stamped.includes(r.user_id));
    },
    async markSecondStaleDraftEmailSent(uid) { stamped.push(uid); return { id: uid }; }
  };
  const sends = [];
  const send = async (p) => { sends.push(p); return { ok: true, id: 'e' }; };
  const r1 = await second.processSecondStaleDraftEmails({
    db, sendEmail: send,
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(r1.sent, 1);
  const r2 = await second.processSecondStaleDraftEmails({
    db, sendEmail: send,
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(r2.found, 0, 'one-shot stamp excludes the row on the next run');
  assert.strictEqual(r2.sent, 0);
  assert.strictEqual(sends.length, 1, 'one email across both runs — never repeats');
});

test('top-level query failure → errors=1, no throw', async () => {
  const db = {
    async getUsersForSecondStaleDraftEmail() { throw new Error('PG down'); },
    async markSecondStaleDraftEmailSent() { throw new Error('should not be called'); }
  };
  const summary = await second.processSecondStaleDraftEmails({
    db,
    sendEmail: async () => ({ ok: true }),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.found, 0);
  assert.strictEqual(summary.sent, 0);
  assert.strictEqual(summary.errors, 1);
});

test('minAgeHours and firstSentGapDays threaded through to db helper', async () => {
  let captured = null;
  const db = {
    async getUsersForSecondStaleDraftEmail(hours, gapDays) {
      captured = { hours, gapDays };
      return [];
    },
    async markSecondStaleDraftEmailSent() { return null; }
  };
  await second.processSecondStaleDraftEmails({
    db,
    sendEmail: async () => ({ ok: true }),
    minAgeHours: 48,
    firstSentGapDays: 14,
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.deepStrictEqual(captured, { hours: 48, gapDays: 14 });
});

// ---- Cron wiring -------------------------------------------------------

test('startSecondStaleDraftEmailJob blocked under NODE_ENV=test', () => {
  process.env.NODE_ENV = 'test';
  second.stopSecondStaleDraftEmailJob();
  const r = second.startSecondStaleDraftEmailJob();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'test_env');
});

test('startSecondStaleDraftEmailJob: cron tick triggers processSecondStaleDraftEmails', async () => {
  second.stopSecondStaleDraftEmailJob();
  let captured = null;
  const fakeCron = {
    schedule(expr, cb, opts) {
      captured = { expr, cb, opts };
      return { stop() {} };
    }
  };
  const db = fakeDb([cohortRow({ user_id: 51, email: 'e@e.com' })]);
  let sendCalls = 0;
  const r = second.startSecondStaleDraftEmailJob({
    force: true,
    cron: fakeCron,
    schedule: '30 11 * * *',
    db,
    sendEmail: async () => { sendCalls += 1; return { ok: true }; },
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.schedule, '30 11 * * *');
  assert.ok(captured, 'cron.schedule must be called');
  assert.strictEqual(captured.expr, '30 11 * * *');
  assert.strictEqual(captured.opts && captured.opts.timezone, 'UTC');
  await captured.cb();
  assert.strictEqual(sendCalls, 1, 'cron tick must invoke processSecondStaleDraftEmails');
  assert.deepStrictEqual(db.stamped, [51]);
  second.stopSecondStaleDraftEmailJob();
});

test('startSecondStaleDraftEmailJob refuses double start', () => {
  second.stopSecondStaleDraftEmailJob();
  const fakeCron = { schedule() { return { stop() {} }; } };
  const r1 = second.startSecondStaleDraftEmailJob({ force: true, cron: fakeCron });
  assert.strictEqual(r1.ok, true);
  const r2 = second.startSecondStaleDraftEmailJob({ force: true, cron: fakeCron });
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.reason, 'already_running');
  second.stopSecondStaleDraftEmailJob();
});

test('DEFAULT_SCHEDULE is 30 11 * * * (11:30 UTC — strictly after first stale-draft at 11:00)', () => {
  assert.strictEqual(second.DEFAULT_SCHEDULE, '30 11 * * *');
  const first = require('../jobs/stale-draft-email');
  assert.strictEqual(first.DEFAULT_SCHEDULE, '0 11 * * *',
    'first stale-draft runs at 11:00 UTC; second must run after');
});

// ---- SQL contract on db.getUsersForSecondStaleDraftEmail ----------------

test('SQL: query gates on draft, !seed, welcome stamped, first sent >=7d ago, second NULL, age', async () => {
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
    await db.getUsersForSecondStaleDraftEmail(24, 7);
    assert.ok(captured, 'query was issued');
    assert.match(captured.sql, /status\s*=\s*'draft'/i, 'status=draft predicate');
    assert.match(captured.sql, /is_seed\s*=\s*false/i,
      'is_seed=false — must NOT email about the seed sample');
    assert.match(captured.sql, /welcome_email_sent_at\s+IS\s+NOT\s+NULL/i,
      'welcome must have fired first');
    assert.match(captured.sql, /stale_draft_email_sent_at\s+IS\s+NOT\s+NULL/i,
      'first stale-draft must have fired');
    assert.match(captured.sql, /stale_draft_email_sent_at\s*<=\s*NOW\(\)\s*-\s*\(\$2\s*\*\s*INTERVAL\s*'1 day'\)/i,
      'gap window via parameter $2');
    assert.match(captured.sql, /second_stale_draft_email_sent_at\s+IS\s+NULL/i,
      'one-shot idempotency on the second-pass stamp');
    assert.match(captured.sql, /created_at\s*<=\s*NOW\(\)\s*-\s*\(\$1\s*\*\s*INTERVAL\s*'1 hour'\)/i,
      'draft age threshold via $1');
    assert.match(captured.sql, /DISTINCT\s+ON\s*\(\s*i\.user_id\s*\)/i,
      'one row per user (oldest draft) — not one row per draft');
    assert.match(captured.sql, /ORDER BY\s+i\.user_id,\s*i\.created_at\s+ASC/i,
      'DISTINCT ON ordering matches the SELECT key');
    assert.deepStrictEqual(captured.params, [24, 7]);
  } finally {
    realPool.query = originalQuery;
  }
});

test('SQL: input sanitization — non-numeric / negative inputs coerce to defaults (24, 7)', async () => {
  delete require.cache[require.resolve('../db')];
  const realDbMod = require('../db');
  const realPool = realDbMod.pool;
  const db = realDbMod.db;
  let captured = null;
  const originalQuery = realPool.query.bind(realPool);
  realPool.query = async (sql, params) => { captured = { sql, params }; return { rows: [] }; };
  try {
    await db.getUsersForSecondStaleDraftEmail(-5, 'abc');
    assert.deepStrictEqual(captured.params, [24, 7],
      'negative / non-numeric inputs must coerce to safe defaults');
  } finally {
    realPool.query = originalQuery;
  }
});

test('db.markSecondStaleDraftEmailSent: idempotency guard + falsy-userId short-circuit', async () => {
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
    return { rows: [{ id: params[0], second_stale_draft_email_sent_at: new Date() }] };
  };
  try {
    assert.strictEqual(await db.markSecondStaleDraftEmailSent(null), null);
    assert.strictEqual(await db.markSecondStaleDraftEmailSent(0), null);
    assert.strictEqual(await db.markSecondStaleDraftEmailSent(undefined), null);
    assert.strictEqual(calls, 0, 'no SQL must be issued for falsy userId');
    const r = await db.markSecondStaleDraftEmailSent(7);
    assert.ok(r && r.id === 7);
    assert.match(captured.sql, /UPDATE\s+users\s+SET\s+second_stale_draft_email_sent_at\s*=\s*NOW\(\)/i);
    assert.match(captured.sql, /second_stale_draft_email_sent_at\s+IS\s+NULL/i,
      'guard prevents double-stamp on concurrent callers');
    assert.deepStrictEqual(captured.params, [7]);
  } finally {
    realPool.query = originalQuery;
  }
});

// ---- Regression-guard: original stale-draft query now excludes 2nd-pass users -

test('SQL regression: getUsersWithStaleDraftForEmail now suppresses second-pass recipients', async () => {
  delete require.cache[require.resolve('../db')];
  const realDbMod = require('../db');
  const realPool = realDbMod.pool;
  const db = realDbMod.db;
  let captured = null;
  const originalQuery = realPool.query.bind(realPool);
  realPool.query = async (sql, params) => { captured = { sql, params }; return { rows: [] }; };
  try {
    await db.getUsersWithStaleDraftForEmail(24, 7);
    assert.match(captured.sql, /second_stale_draft_email_sent_at\s+IS\s+NULL/i,
      'first stale-draft query must skip users who already received the terminal 2nd-pass');
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
  console.log(`\n${passed} passed, ${failed} failed (second-stale-draft-email.test.js)`);
  if (failed > 0) process.exit(1);
})();
