'use strict';

/*
 * Overdue-Invoice Freelancer Digest — daily re-engagement email back to the
 * freelancer when their sent invoices have gone past their due_date.
 *
 * Coverage mirrors tests/no-invoice-nudge.test.js / tests/stale-draft-email.test.js:
 *   1. Pure formatters: subject pluralisation, XSS escape, CTA URLs.
 *   2. daysOverdue arithmetic + clamps.
 *   3. Happy path: cohort row → email sent + user stamp written.
 *   4. Skips users without an email (defence-in-depth).
 *   5. not_configured (RESEND key unset) → no stamp, retries next tick.
 *   6. sendEmail throw → counts an error, batch continues, no stamp.
 *   7. Idempotency across runs — fake DB filters out stamped users next time.
 *   8. Top-level query failure → errors=1, no throw.
 *   9. replyTo precedence: reply_to_email > business_email > email.
 *  10. startOverdueDigestJob blocked under NODE_ENV=test; accepts force.
 *  11. Cron tick wires processOverdueDigest through correctly.
 *  12. Double start refused.
 *  13. DEFAULT_SCHEDULE shape (13:00 UTC — after no-invoice at 12:00).
 *  14. cooldownDays opt threaded through to db helper.
 *  15. SQL contract checks on db.getUsersWithOverdueInvoicesForDigest.
 *  16. db.markOverdueDigestSent: falsy-userId short-circuit.
 *
 * Run: NODE_ENV=test node tests/overdue-freelancer-digest.test.js
 */

const assert = require('assert');

const digest = require('../jobs/overdue-freelancer-digest');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function cohortRow(over = {}) {
  return {
    user_id: 42,
    email: 'user@test.io',
    name: 'Sam',
    business_name: 'Studio',
    reply_to_email: null,
    business_email: 'biz@test.io',
    plan: 'free',
    overdue_count: 3,
    overdue_total: '450.00',
    oldest_due_date: '2026-05-10',
    newest_due_date: '2026-05-12',
    ...over
  };
}

// ---- Pure formatters ---------------------------------------------------

test('subject: pluralisation by overdue_count', () => {
  const s1 = digest.buildOverdueDigestSubject(cohortRow({ overdue_count: 1 }));
  assert.match(s1, /an overdue invoice/i);
  assert.ok(!/invoices/.test(s1), 'singular form when count=1');
  const s3 = digest.buildOverdueDigestSubject(cohortRow({ overdue_count: 3 }));
  assert.match(s3, /3 overdue invoices/i);
  // Count = 0 (edge: query shouldn't return this, but be defensive)
  const s0 = digest.buildOverdueDigestSubject(cohortRow({ overdue_count: 0 }));
  assert.match(s0, /an overdue invoice/i, 'count<=1 falls back to singular shape');
});

test('subject: no PII leakage (generic, no name/email/total)', () => {
  const s = digest.buildOverdueDigestSubject(cohortRow({
    overdue_count: 2,
    name: 'Sam',
    overdue_total: '999.99'
  }));
  assert.ok(!/Sam|Studio|test\.io|999/.test(s),
    'subject must stay generic — inbox-preview leakage protection');
});

test('html: escapes hostile name + threads dashboard URL when APP_URL is set', () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const html = digest.buildOverdueDigestHtml(cohortRow({
    name: '<script>alert(1)</script>',
    overdue_count: 2,
    overdue_total: '300.00'
  }), new Date('2026-05-16T12:00:00Z'));
  assert.ok(!/<script>alert\(1\)<\/script>/.test(html),
    'raw script must be escaped (XSS defence)');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /https:\/\/decentinvoice\.com\/invoices/,
    'CTA must deep-link to the dashboard (/invoices)');
  assert.match(html, /Open your dashboard/);
  assert.match(html, /2 overdue invoices/);
  assert.match(html, /\$300\.00/);
});

test('html: CTA omitted gracefully when APP_URL is unset (no broken-link button)', () => {
  delete process.env.APP_URL;
  const html = digest.buildOverdueDigestHtml(cohortRow(), new Date('2026-05-16T12:00:00Z'));
  assert.ok(!/<a href=/.test(html),
    'no CTA <a> when APP_URL is unset — graceful degradation');
  assert.match(html, /Time to chase/, 'body copy remains');
});

test('html: greeting falls back through name → business_name → "there"', () => {
  const h1 = digest.buildOverdueDigestHtml(cohortRow({ name: 'Alice', business_name: 'X' }));
  assert.match(h1, /Hi Alice,/);
  const h2 = digest.buildOverdueDigestHtml(cohortRow({ name: null, business_name: 'Studio Q' }));
  assert.match(h2, /Hi Studio Q,/);
  const h3 = digest.buildOverdueDigestHtml(cohortRow({ name: null, business_name: null }));
  assert.match(h3, /Hi there,/);
});

test('html: oldest-overdue line renders when oldest_due_date is in the past', () => {
  const html = digest.buildOverdueDigestHtml(
    cohortRow({ oldest_due_date: '2026-05-01' }),
    new Date('2026-05-11T12:00:00Z')
  );
  assert.match(html, /Oldest is 10 days past due/);
});

test('html: oldest-overdue line omitted when oldest_due_date is in the future or null', () => {
  // Future
  const future = digest.buildOverdueDigestHtml(
    cohortRow({ oldest_due_date: '2026-06-01' }),
    new Date('2026-05-01T12:00:00Z')
  );
  assert.ok(!/past due/.test(future), 'no past-due line when oldest is in the future');
  // Null
  const nul = digest.buildOverdueDigestHtml(
    cohortRow({ oldest_due_date: null }),
    new Date('2026-05-16T12:00:00Z')
  );
  assert.ok(!/past due/.test(nul), 'no past-due line on null oldest_due_date');
});

test('text: includes greeting + total + CTA URL (trailing slash trimmed)', () => {
  process.env.APP_URL = 'https://decentinvoice.com/';
  const text = digest.buildOverdueDigestText(cohortRow({
    name: 'Sam',
    overdue_count: 2,
    overdue_total: '450.00',
    oldest_due_date: '2026-05-10'
  }), new Date('2026-05-15T12:00:00Z'));
  assert.match(text, /Hi Sam/);
  assert.match(text, /2 overdue invoices/);
  assert.match(text, /\$450\.00/);
  assert.match(text, /5 days past due/);
  assert.match(text, /https:\/\/decentinvoice\.com\/invoices/,
    'APP_URL trailing slash must be trimmed before joining /invoices');
  assert.match(text, /Reply to this email/);
});

test('text: 1-day-overdue uses singular "day past due"', () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const text = digest.buildOverdueDigestText(cohortRow({
    overdue_count: 1,
    oldest_due_date: '2026-05-15'
  }), new Date('2026-05-16T12:00:00Z'));
  assert.match(text, /1 day past due/);
  assert.ok(!/1 days past due/.test(text), 'singular when oldest=1');
});

test('daysOverdue: clamps to non-negative, NaN-safe, null returns 0', () => {
  assert.strictEqual(digest.daysOverdue(null), 0);
  assert.strictEqual(digest.daysOverdue(undefined), 0);
  assert.strictEqual(digest.daysOverdue('not a date'), 0);
  assert.strictEqual(
    digest.daysOverdue('2026-05-10', new Date('2026-05-01T12:00:00Z')),
    0,
    'future due_date must clamp to 0 (not negative)'
  );
  assert.strictEqual(
    digest.daysOverdue('2026-05-10', new Date('2026-05-15T12:00:00Z')),
    5
  );
});

// ---- Orchestrator tests ------------------------------------------------

function fakeDb(rows = []) {
  const stamped = [];
  return {
    rows,
    stamped,
    async getUsersWithOverdueInvoicesForDigest() { return rows; },
    async markOverdueDigestSent(userId) {
      stamped.push(userId);
      return { id: userId, overdue_digest_sent_at: new Date() };
    }
  };
}

test('happy path: sends and stamps', async () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const sends = [];
  const db = fakeDb([cohortRow({ user_id: 42, email: 'sam@test.io', name: 'Sam' })]);
  const summary = await digest.processOverdueDigest({
    db,
    sendEmail: async (p) => { sends.push(p); return { ok: true, id: 'em_1' }; },
    now: new Date('2026-05-16T12:00:00Z'),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.found, 1);
  assert.strictEqual(summary.sent, 1);
  assert.strictEqual(summary.errors, 0);
  assert.strictEqual(summary.notConfigured, 0);
  assert.deepStrictEqual(db.stamped, [42]);
  assert.strictEqual(sends.length, 1);
  assert.strictEqual(sends[0].to, 'sam@test.io');
  assert.match(sends[0].subject, /3 overdue invoices/);
  assert.match(sends[0].html, /Hi Sam/);
  assert.match(sends[0].text, /Hi Sam/);
});

test('replyTo precedence: reply_to_email > business_email > email', async () => {
  const sends = [];
  const db = fakeDb([
    cohortRow({ user_id: 1, email: 'fallback@x.com', reply_to_email: 'reply@x.com', business_email: 'biz@x.com' }),
    cohortRow({ user_id: 2, email: 'fallback@y.com', reply_to_email: null, business_email: 'biz@y.com' }),
    cohortRow({ user_id: 3, email: 'fallback@z.com', reply_to_email: null, business_email: null })
  ]);
  await digest.processOverdueDigest({
    db,
    sendEmail: async (p) => { sends.push(p); return { ok: true }; },
    now: new Date('2026-05-16T12:00:00Z'),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(sends[0].replyTo, 'reply@x.com');
  assert.strictEqual(sends[1].replyTo, 'biz@y.com');
  assert.strictEqual(sends[2].replyTo, 'fallback@z.com');
});

test('users without email are skipped (defence-in-depth — query already filters them)', async () => {
  const sends = [];
  const db = fakeDb([cohortRow({ user_id: 9, email: null })]);
  const summary = await digest.processOverdueDigest({
    db,
    sendEmail: async (p) => { sends.push(p); return { ok: true }; },
    now: new Date('2026-05-16T12:00:00Z'),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.sent, 0);
  assert.strictEqual(summary.skipped, 1);
  assert.strictEqual(sends.length, 0);
  assert.deepStrictEqual(db.stamped, []);
});

test('not_configured does NOT stamp DB (next cron pass retries)', async () => {
  const db = fakeDb([cohortRow({ user_id: 99, email: 'foo@bar.com' })]);
  const summary = await digest.processOverdueDigest({
    db,
    sendEmail: async () => ({ ok: false, reason: 'not_configured' }),
    now: new Date('2026-05-16T12:00:00Z'),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.found, 1);
  assert.strictEqual(summary.sent, 0);
  assert.strictEqual(summary.notConfigured, 1);
  assert.strictEqual(summary.errors, 0,
    'not_configured is a clean skip, not an error');
  assert.deepStrictEqual(db.stamped, [],
    'must NOT stamp when send was a no-op so the next pass retries');
});

test('email error continues batch; only successful sends stamped', async () => {
  const sends = [];
  const db = fakeDb([
    cohortRow({ user_id: 1, email: 'a@a.com' }),
    cohortRow({ user_id: 2, email: 'b@b.com' })
  ]);
  let i = 0;
  const summary = await digest.processOverdueDigest({
    db,
    sendEmail: async (p) => {
      i += 1;
      if (i === 1) throw new Error('SMTP exploded');
      sends.push(p);
      return { ok: true, id: 'em_b' };
    },
    now: new Date('2026-05-16T12:00:00Z'),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.found, 2);
  assert.strictEqual(summary.sent, 1);
  assert.strictEqual(summary.errors, 1);
  assert.deepStrictEqual(db.stamped, [2], 'only the successful user is stamped');
  assert.strictEqual(sends[0].to, 'b@b.com');
});

test('idempotent across cooldown runs (filter respects stamp)', async () => {
  const initial = [cohortRow({ user_id: 11, email: 'c@c.com' })];
  const stamped = [];
  const db = {
    async getUsersWithOverdueInvoicesForDigest() {
      return initial.filter(u => !stamped.includes(u.user_id));
    },
    async markOverdueDigestSent(uid) { stamped.push(uid); return { id: uid }; }
  };
  const sends = [];
  const send = async (p) => { sends.push(p); return { ok: true, id: 'e' }; };
  const r1 = await digest.processOverdueDigest({
    db, sendEmail: send, now: new Date('2026-05-16T12:00:00Z'),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(r1.sent, 1);
  const r2 = await digest.processOverdueDigest({
    db, sendEmail: send, now: new Date('2026-05-17T12:00:00Z'),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(r2.found, 0, 'cooldown-stamped users excluded on next tick');
  assert.strictEqual(r2.sent, 0);
  assert.strictEqual(sends.length, 1, 'one email across both runs — never repeats within cooldown');
});

test('top-level query failure → errors=1, no throw', async () => {
  const db = {
    async getUsersWithOverdueInvoicesForDigest() { throw new Error('PG down'); },
    async markOverdueDigestSent() { throw new Error('should not be called'); }
  };
  const summary = await digest.processOverdueDigest({
    db,
    sendEmail: async () => ({ ok: true }),
    now: new Date(),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.found, 0);
  assert.strictEqual(summary.sent, 0);
  assert.strictEqual(summary.errors, 1);
});

test('cooldownDays opt is threaded through to the db helper', async () => {
  let captured = null;
  const db = {
    async getUsersWithOverdueInvoicesForDigest(days) { captured = days; return []; },
    async markOverdueDigestSent() { return null; }
  };
  await digest.processOverdueDigest({
    db,
    sendEmail: async () => ({ ok: true }),
    cooldownDays: 14,
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(captured, 14);
});

test('mark-stamp failure counts an error but does not crash the batch', async () => {
  const db = {
    async getUsersWithOverdueInvoicesForDigest() {
      return [cohortRow({ user_id: 77, email: 'x@x.com' })];
    },
    async markOverdueDigestSent() { throw new Error('DB sad'); }
  };
  const summary = await digest.processOverdueDigest({
    db,
    sendEmail: async () => ({ ok: true, id: 'e' }),
    now: new Date(),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.found, 1);
  assert.strictEqual(summary.sent, 0, 'sent only counts when stamp succeeds');
  assert.strictEqual(summary.errors, 1);
});

// ---- Cron wiring -------------------------------------------------------

test('startOverdueDigestJob blocked under NODE_ENV=test', () => {
  process.env.NODE_ENV = 'test';
  digest.stopOverdueDigestJob();
  const r = digest.startOverdueDigestJob();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'test_env');
});

test('startOverdueDigestJob: cron tick triggers processOverdueDigest', async () => {
  digest.stopOverdueDigestJob();
  let captured = null;
  const fakeCron = {
    schedule(expr, cb, opts) {
      captured = { expr, cb, opts };
      return { stop() {} };
    }
  };
  const db = fakeDb([cohortRow({ user_id: 51, email: 'e@e.com' })]);
  let sendCalls = 0;
  const r = digest.startOverdueDigestJob({
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
  assert.strictEqual(sendCalls, 1, 'cron tick must invoke processOverdueDigest');
  assert.deepStrictEqual(db.stamped, [51]);
  digest.stopOverdueDigestJob();
});

test('startOverdueDigestJob refuses double start', () => {
  digest.stopOverdueDigestJob();
  const fakeCron = { schedule() { return { stop() {} }; } };
  const r1 = digest.startOverdueDigestJob({ force: true, cron: fakeCron });
  assert.strictEqual(r1.ok, true);
  const r2 = digest.startOverdueDigestJob({ force: true, cron: fakeCron });
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.reason, 'already_running');
  digest.stopOverdueDigestJob();
});

test('DEFAULT_SCHEDULE is 0 13 * * * (13:00 UTC — after no-invoice at 12:00)', () => {
  assert.strictEqual(digest.DEFAULT_SCHEDULE, '0 13 * * *');
});

// ---- SQL contract on db.getUsersWithOverdueInvoicesForDigest -----------

test('SQL: query gates on status=sent, due_date<CURRENT_DATE, welcome_email_sent_at NOT NULL, cooldown', async () => {
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
    await db.getUsersWithOverdueInvoicesForDigest(7);
    assert.ok(captured, 'query was issued');
    assert.match(captured.sql, /i\.status\s*=\s*'sent'/i,
      'overdue cohort is sent (not draft, not paid, not overdue-status — past-due is the gate)');
    assert.match(captured.sql, /i\.due_date\s*<\s*CURRENT_DATE/i,
      'server-side past-due check via CURRENT_DATE');
    assert.match(captured.sql, /i\.due_date\s+IS\s+NOT\s+NULL/i,
      'due_date present — invoices without a due date can never be overdue');
    assert.match(captured.sql, /u\.welcome_email_sent_at\s+IS\s+NOT\s+NULL/i,
      'welcome must have fired before this digest — activation ordering');
    assert.match(captured.sql, /u\.email\s+IS\s+NOT\s+NULL/i,
      'email gate — defence in depth');
    assert.match(captured.sql, /overdue_digest_sent_at\s+IS\s+NULL[\s\S]+overdue_digest_sent_at\s*<\s*NOW\(\)\s*-\s*\(\$1\s*\*\s*INTERVAL\s*'1 day'\)/i,
      'cooldown enforced via parameter');
    assert.match(captured.sql, /COUNT\(i\.id\)::int\s+AS\s+overdue_count/i,
      'aggregate count for the digest copy');
    assert.match(captured.sql, /SUM\(i\.total\)/i,
      'aggregate total for the digest copy');
    assert.match(captured.sql, /MIN\(i\.due_date\)\s+AS\s+oldest_due_date/i,
      'oldest due date powers the "X days past due" urgency line');
    assert.match(captured.sql, /GROUP BY/i, 'aggregation requires GROUP BY');
    assert.match(captured.sql, /ORDER BY\s+MIN\(i\.due_date\)\s+ASC/i,
      'oldest-overdue first — drain the most-overdue backlog deterministically');
    assert.match(captured.sql, /LIMIT 500/i, 'bounded batch per tick');
    assert.deepStrictEqual(captured.params, [7]);
  } finally {
    realPool.query = originalQuery;
  }
});

test('SQL: NOT plan-gated (free users get the freelancer pull-back too)', async () => {
  delete require.cache[require.resolve('../db')];
  const realDbMod = require('../db');
  const realPool = realDbMod.pool;
  const db = realDbMod.db;
  let captured = null;
  const originalQuery = realPool.query.bind(realPool);
  realPool.query = async (sql, params) => { captured = { sql, params }; return { rows: [] }; };
  try {
    await db.getUsersWithOverdueInvoicesForDigest(7);
    // The plan column is SELECTed (for downstream consumers) but NOT filtered
    // in the WHERE clause. Distinct from jobs/reminders.js, which gates on
    // `u.plan IN ('pro','business','agency')` for client-side reminders.
    assert.ok(!/u\.plan\s+IN\s*\(/i.test(captured.sql),
      'WHERE clause must NOT filter by plan — free users need this digest most');
  } finally {
    realPool.query = originalQuery;
  }
});

test('SQL: input sanitization — non-numeric / negative cooldownDays falls back to default 7', async () => {
  delete require.cache[require.resolve('../db')];
  const realDbMod = require('../db');
  const realPool = realDbMod.pool;
  const db = realDbMod.db;
  let captured = null;
  const originalQuery = realPool.query.bind(realPool);
  realPool.query = async (sql, params) => { captured = { sql, params }; return { rows: [] }; };
  try {
    await db.getUsersWithOverdueInvoicesForDigest(-5);
    assert.deepStrictEqual(captured.params, [7], 'negative coerces to default 7');
    await db.getUsersWithOverdueInvoicesForDigest('abc');
    assert.deepStrictEqual(captured.params, [7], 'non-numeric coerces to default 7');
    await db.getUsersWithOverdueInvoicesForDigest(0);
    assert.deepStrictEqual(captured.params, [7], 'zero coerces to default 7');
  } finally {
    realPool.query = originalQuery;
  }
});

test('db.markOverdueDigestSent: UPDATE shape + falsy-userId short-circuit', async () => {
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
    return { rows: [{ id: params[0], overdue_digest_sent_at: new Date() }] };
  };
  try {
    // Falsy short-circuit — no SQL issued.
    assert.strictEqual(await db.markOverdueDigestSent(null), null);
    assert.strictEqual(await db.markOverdueDigestSent(0), null);
    assert.strictEqual(await db.markOverdueDigestSent(undefined), null);
    assert.strictEqual(calls, 0, 'no SQL must be issued for falsy userId');
    // Happy path
    const r = await db.markOverdueDigestSent(7);
    assert.ok(r && r.id === 7);
    assert.match(captured.sql, /UPDATE\s+users\s+SET\s+overdue_digest_sent_at\s*=\s*NOW\(\)/i);
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
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
