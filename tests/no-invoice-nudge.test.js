'use strict';

/*
 * No-Invoice Nudge — 48h-after-signup re-engagement email cron.
 *
 * Coverage mirrors tests/stale-draft-email.test.js and tests/trial-nudge.test.js:
 *   1. Pure formatters: XSS escape, greeting fallback, CTA URLs with/without APP_URL.
 *   2. Happy path: cohort row → email sent + user stamp written.
 *   3. Skips users without an email (defence-in-depth).
 *   4. not_configured (RESEND key unset) → no stamp, retries next tick.
 *   5. sendEmail throw → counts an error, batch continues, no stamp.
 *   6. Idempotency across runs — fake DB filters out stamped users next time.
 *   7. Top-level query failure → errors=1, no throw.
 *   8. startNoInvoiceNudgeJob blocked under NODE_ENV=test; accepts force.
 *   9. Cron tick wires processNoInvoiceNudges through correctly.
 *  10. Double start refused.
 *  11. DEFAULT_SCHEDULE shape (12:00 UTC — after stale-draft at 11:00).
 *  12. SQL contract checks on db.getUsersForNoInvoiceNudge — the production
 *      query gates on invoice_count = 0, welcome_email_sent_at IS NOT NULL,
 *      no_invoice_nudge_sent_at IS NULL, and the minAgeHours window.
 *  13. db.markNoInvoiceNudgeSent: idempotency UPDATE guard
 *      (no_invoice_nudge_sent_at IS NULL) + falsy-userId short-circuit.
 *
 * Run: NODE_ENV=test node tests/no-invoice-nudge.test.js
 */

const assert = require('assert');

const noInvoice = require('../jobs/no-invoice-nudge');

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
    created_at: new Date('2026-05-14T00:00:00Z'),
    ...over
  };
}

// ---- Pure formatters ---------------------------------------------------

test('subject: stable copy (no minute/hour drift, no PII)', () => {
  const subj = noInvoice.buildNoInvoiceNudgeSubject(cohortRow(), new Date('2026-05-16T12:00:00Z'));
  assert.match(subj, /first invoice is one click away/);
  // No identifying info in the subject — it stays generic so the cohort isn't
  // leaked via email-preview "Hi <name>…" exposure in the inbox preview.
  assert.ok(!/Sam|Studio|test\.io/.test(subj));
});

test('html: escapes hostile name + threads CTA URLs when APP_URL is set', () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const html = noInvoice.buildNoInvoiceNudgeHtml(cohortRow({
    name: '<script>alert(1)</script>'
  }));
  assert.ok(!/<script>alert\(1\)<\/script>/.test(html),
    'raw script must be escaped (XSS defence)');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /https:\/\/decentinvoice\.com\/invoices\/new/,
    'CTA must deep-link to /invoices/new (not just /dashboard)');
  assert.match(html, /https:\/\/decentinvoice\.com\/dashboard/,
    'secondary link must point to /dashboard for the seed-edit path');
  assert.match(html, /Create your first invoice/, 'CTA copy present');
});

test('html: CTA omitted gracefully when APP_URL is unset (no broken-link button)', () => {
  delete process.env.APP_URL;
  const html = noInvoice.buildNoInvoiceNudgeHtml(cohortRow());
  assert.ok(!/<a href=/.test(html),
    'no CTA <a> when APP_URL is unset — graceful degradation');
  assert.match(html, /Ready to send your first invoice/, 'body copy remains');
});

test('html: greeting falls back through name → business_name → "there"', () => {
  const h1 = noInvoice.buildNoInvoiceNudgeHtml(cohortRow({ name: 'Alice', business_name: 'X' }));
  assert.match(h1, /Hi Alice,/);
  const h2 = noInvoice.buildNoInvoiceNudgeHtml(cohortRow({ name: null, business_name: 'Studio Q' }));
  assert.match(h2, /Hi Studio Q,/);
  const h3 = noInvoice.buildNoInvoiceNudgeHtml(cohortRow({ name: null, business_name: null }));
  assert.match(h3, /Hi there,/);
});

test('text: includes greeting + CTA URLs (trailing slash trimmed)', () => {
  process.env.APP_URL = 'https://decentinvoice.com/';
  const text = noInvoice.buildNoInvoiceNudgeText(cohortRow({ name: 'Sam' }));
  assert.match(text, /Hi Sam/);
  assert.match(text, /https:\/\/decentinvoice\.com\/invoices\/new/,
    'APP_URL trailing slash must be trimmed before joining /invoices/new');
  assert.match(text, /https:\/\/decentinvoice\.com\/dashboard/);
  assert.match(text, /Reply to this email/);
});

// ---- Orchestrator tests ------------------------------------------------

function fakeDb(rows = []) {
  const stamped = [];
  return {
    rows,
    stamped,
    async getUsersForNoInvoiceNudge() { return rows; },
    async markNoInvoiceNudgeSent(userId) {
      stamped.push(userId);
      return { id: userId, no_invoice_nudge_sent_at: new Date() };
    }
  };
}

test('happy path: sends and stamps', async () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const sends = [];
  const db = fakeDb([cohortRow({ id: 42, email: 'sam@test.io', name: 'Sam' })]);
  const summary = await noInvoice.processNoInvoiceNudges({
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
  assert.match(sends[0].subject, /first invoice is one click away/);
  assert.match(sends[0].html, /Hi Sam/);
  assert.match(sends[0].text, /Hi Sam/);
});

test('replyTo precedence: reply_to_email > business_email > email', async () => {
  const sends = [];
  const db = fakeDb([
    cohortRow({ id: 1, email: 'fallback@x.com', reply_to_email: 'reply@x.com', business_email: 'biz@x.com' }),
    cohortRow({ id: 2, email: 'fallback@y.com', reply_to_email: null, business_email: 'biz@y.com' }),
    cohortRow({ id: 3, email: 'fallback@z.com', reply_to_email: null, business_email: null })
  ]);
  await noInvoice.processNoInvoiceNudges({
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
  const db = fakeDb([cohortRow({ id: 9, email: null })]);
  const summary = await noInvoice.processNoInvoiceNudges({
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
  const db = fakeDb([cohortRow({ id: 99, email: 'foo@bar.com' })]);
  const summary = await noInvoice.processNoInvoiceNudges({
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
    cohortRow({ id: 1, email: 'a@a.com' }),
    cohortRow({ id: 2, email: 'b@b.com' })
  ]);
  let i = 0;
  const summary = await noInvoice.processNoInvoiceNudges({
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

test('idempotent across runs (filter respects stamp)', async () => {
  const initial = [cohortRow({ id: 11, email: 'c@c.com' })];
  const stamped = [];
  const db = {
    async getUsersForNoInvoiceNudge() {
      return initial.filter(u => !stamped.includes(u.id));
    },
    async markNoInvoiceNudgeSent(uid) { stamped.push(uid); return { id: uid }; }
  };
  const sends = [];
  const send = async (p) => { sends.push(p); return { ok: true, id: 'e' }; };
  const r1 = await noInvoice.processNoInvoiceNudges({
    db, sendEmail: send, now: new Date('2026-05-16T12:00:00Z'),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(r1.sent, 1);
  const r2 = await noInvoice.processNoInvoiceNudges({
    db, sendEmail: send, now: new Date('2026-05-17T12:00:00Z'),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(r2.found, 0, 'one-shot stamp excludes the row on the next run');
  assert.strictEqual(r2.sent, 0);
  assert.strictEqual(sends.length, 1, 'one email across both runs — never repeats');
});

test('top-level query failure → errors=1, no throw', async () => {
  const db = {
    async getUsersForNoInvoiceNudge() { throw new Error('PG down'); },
    async markNoInvoiceNudgeSent() { throw new Error('should not be called'); }
  };
  const summary = await noInvoice.processNoInvoiceNudges({
    db,
    sendEmail: async () => ({ ok: true }),
    now: new Date(),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.found, 0);
  assert.strictEqual(summary.sent, 0);
  assert.strictEqual(summary.errors, 1);
});

test('minAgeHours opt is threaded through to the db helper', async () => {
  let captured = null;
  const db = {
    async getUsersForNoInvoiceNudge(hours) { captured = hours; return []; },
    async markNoInvoiceNudgeSent() { return null; }
  };
  await noInvoice.processNoInvoiceNudges({
    db,
    sendEmail: async () => ({ ok: true }),
    minAgeHours: 72,
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(captured, 72);
});

// ---- Cron wiring -------------------------------------------------------

test('startNoInvoiceNudgeJob blocked under NODE_ENV=test', () => {
  process.env.NODE_ENV = 'test';
  noInvoice.stopNoInvoiceNudgeJob();
  const r = noInvoice.startNoInvoiceNudgeJob();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'test_env');
});

test('startNoInvoiceNudgeJob: cron tick triggers processNoInvoiceNudges', async () => {
  noInvoice.stopNoInvoiceNudgeJob();
  let captured = null;
  const fakeCron = {
    schedule(expr, cb, opts) {
      captured = { expr, cb, opts };
      return { stop() {} };
    }
  };
  const db = fakeDb([cohortRow({ id: 51, email: 'e@e.com' })]);
  let sendCalls = 0;
  const r = noInvoice.startNoInvoiceNudgeJob({
    force: true,
    cron: fakeCron,
    schedule: '0 12 * * *',
    db,
    sendEmail: async () => { sendCalls += 1; return { ok: true }; },
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.schedule, '0 12 * * *');
  assert.ok(captured, 'cron.schedule must be called');
  assert.strictEqual(captured.expr, '0 12 * * *');
  assert.strictEqual(captured.opts && captured.opts.timezone, 'UTC');
  await captured.cb();
  assert.strictEqual(sendCalls, 1, 'cron tick must invoke processNoInvoiceNudges');
  assert.deepStrictEqual(db.stamped, [51]);
  noInvoice.stopNoInvoiceNudgeJob();
});

test('startNoInvoiceNudgeJob refuses double start', () => {
  noInvoice.stopNoInvoiceNudgeJob();
  const fakeCron = { schedule() { return { stop() {} }; } };
  const r1 = noInvoice.startNoInvoiceNudgeJob({ force: true, cron: fakeCron });
  assert.strictEqual(r1.ok, true);
  const r2 = noInvoice.startNoInvoiceNudgeJob({ force: true, cron: fakeCron });
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.reason, 'already_running');
  noInvoice.stopNoInvoiceNudgeJob();
});

test('DEFAULT_SCHEDULE is 0 12 * * * (12:00 UTC — after stale-draft at 11:00)', () => {
  assert.strictEqual(noInvoice.DEFAULT_SCHEDULE, '0 12 * * *');
});

// ---- SQL contract on db.getUsersForNoInvoiceNudge ----------------------

test('SQL: query gates on invoice_count=0, welcome_email_sent_at NOT NULL, no_invoice_nudge_sent_at NULL, age window', async () => {
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
    await db.getUsersForNoInvoiceNudge(48);
    assert.ok(captured, 'query was issued');
    assert.match(captured.sql, /invoice_count\s*=\s*0/i,
      'invoice_count=0 gate — no real invoice ever created');
    assert.match(captured.sql, /welcome_email_sent_at\s+IS\s+NOT\s+NULL/i,
      'welcome must have fired before this nudge — activation ordering');
    assert.match(captured.sql, /no_invoice_nudge_sent_at\s+IS\s+NULL/i,
      'one-shot idempotency — never re-nudge');
    assert.match(captured.sql, /email\s+IS\s+NOT\s+NULL/i,
      'email gate — defence in depth');
    assert.match(captured.sql, /created_at\s*<=\s*NOW\(\)\s*-\s*\(\$1\s*\*\s*INTERVAL\s*'1 hour'\)/i,
      'age threshold via parameter — let user breathe before nudging');
    assert.match(captured.sql, /ORDER BY\s+created_at\s+ASC/i,
      'oldest signups first — drain the backlog deterministically');
    assert.deepStrictEqual(captured.params, [48]);
  } finally {
    realPool.query = originalQuery;
  }
});

test('SQL: input sanitization — non-numeric / negative minAgeHours falls back to default 48', async () => {
  delete require.cache[require.resolve('../db')];
  const realDbMod = require('../db');
  const realPool = realDbMod.pool;
  const db = realDbMod.db;
  let captured = null;
  const originalQuery = realPool.query.bind(realPool);
  realPool.query = async (sql, params) => { captured = { sql, params }; return { rows: [] }; };
  try {
    await db.getUsersForNoInvoiceNudge(-5);
    assert.deepStrictEqual(captured.params, [48], 'negative coerces to default 48');
    await db.getUsersForNoInvoiceNudge('abc');
    assert.deepStrictEqual(captured.params, [48], 'non-numeric coerces to default 48');
  } finally {
    realPool.query = originalQuery;
  }
});

test('db.markNoInvoiceNudgeSent: idempotency guard + falsy-userId short-circuit', async () => {
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
    return { rows: [{ id: params[0], no_invoice_nudge_sent_at: new Date() }] };
  };
  try {
    // Falsy short-circuit — no SQL issued.
    assert.strictEqual(await db.markNoInvoiceNudgeSent(null), null);
    assert.strictEqual(await db.markNoInvoiceNudgeSent(0), null);
    assert.strictEqual(await db.markNoInvoiceNudgeSent(undefined), null);
    assert.strictEqual(calls, 0, 'no SQL must be issued for falsy userId');
    // Happy path — guarded UPDATE.
    const r = await db.markNoInvoiceNudgeSent(7);
    assert.ok(r && r.id === 7);
    assert.match(captured.sql, /UPDATE\s+users\s+SET\s+no_invoice_nudge_sent_at\s*=\s*NOW\(\)/i);
    assert.match(captured.sql, /no_invoice_nudge_sent_at\s+IS\s+NULL/i,
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
  console.log(`\n${passed} passed, ${failed} failed (no-invoice-nudge.test.js)`);
  if (failed > 0) process.exit(1);
})();
