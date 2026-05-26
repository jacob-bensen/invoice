'use strict';

/*
 * Pre-due-date "Heads up — invoice X is due in N days" client reminder
 * (Milestone 4 — first invoice sent → first payment received).
 *
 * Covers:
 *  1. Pure formatters: subject + body include the days-until-due math
 *     (today / tomorrow / N-days plurals), XSS escape on hostile inputs,
 *     pay-link button is rendered when payment_link_url is present.
 *  2. daysUntilDue arithmetic: 0 when due today, 1 when due tomorrow, N
 *     for further-out, clamps negative (defence in depth — SQL should
 *     never produce them).
 *  3. processDueSoonReminders happy path: sends + stamps via
 *     db.markInvoiceDueSoonReminderSent.
 *  4. Free-plan defence-in-depth skip (SQL excludes free, but the
 *     orchestrator re-checks).
 *  5. Missing client_email skipped without error.
 *  6. RESEND not_configured → no stamp, retried on next tick.
 *  7. sendEmail throw → 1 error, batch continues.
 *  8. Idempotent across runs once stamped.
 *  9. cron blocked under NODE_ENV=test without {force:true}.
 * 10. cron callback runs the orchestrator (verified end-to-end via fake
 *     cron + fake db + fake sendEmail).
 * 11. SQL contract on the actual production helper: status='sent' +
 *     is_seed=false + due_date >= CURRENT_DATE + due_date <= window +
 *     due_soon_reminder_sent_at IS NULL + plan in pro/business/agency.
 * 12. markInvoiceDueSoonReminderSent UPDATE shape locks in idempotent
 *     AND IS NULL guard so concurrent ticks don't double-stamp.
 *
 * Run: NODE_ENV=test node tests/due-soon-reminder.test.js
 */

const assert = require('assert');

const dueSoon = require('../jobs/due-soon-reminder');

// ---- Pure helpers ---------------------------------------------------------

function testSubjectFormatNDays() {
  const subj = dueSoon.buildDueSoonSubject(
    { invoice_number: 'INV-2026-0042', due_date: '2026-04-27' },
    new Date('2026-04-25T00:00:00Z')
  );
  assert.match(subj, /Heads up/);
  assert.match(subj, /INV-2026-0042/);
  assert.match(subj, /in 2 days/);
}

function testSubjectFormatTomorrow() {
  const subj = dueSoon.buildDueSoonSubject(
    { invoice_number: 'INV-9', due_date: '2026-04-26' },
    new Date('2026-04-25T08:00:00Z')
  );
  assert.match(subj, /due tomorrow/);
  assert.ok(!/in 1 days/.test(subj), 'singular day case must NOT say "in 1 days"');
}

function testSubjectFormatToday() {
  const subj = dueSoon.buildDueSoonSubject(
    { invoice_number: 'INV-1', due_date: '2026-04-25' },
    new Date('2026-04-25T14:00:00Z')
  );
  assert.match(subj, /due today/);
}

function testHtmlEscapesAndIncludesPayLink() {
  const html = dueSoon.buildDueSoonHtml({
    invoice_number: 'INV-1',
    client_name: '<script>alert(1)</script>',
    owner_business_name: 'Acme & Co',
    total: 250,
    due_date: '2026-04-27',
    payment_link_url: 'https://buy.stripe.com/test_xyz?x=1&y=2'
  }, new Date('2026-04-25T00:00:00Z'));

  assert.ok(!html.includes('<script>alert(1)</script>'),
    'must escape raw script tags from client_name');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /Acme &amp; Co/, 'must escape ampersands in business name');
  assert.match(html, /https:\/\/buy\.stripe\.com\/test_xyz\?x=1&amp;y=2/,
    'pay button must include the payment link URL with escaped query string');
  assert.match(html, /in 2 days/, 'must include the days-until-due clause');
  assert.match(html, /\$250\.00/, 'must include the formatted total');
  // Defence: the "overdue" word from reminders.js must NEVER appear here
  // (this is a PRE-due nudge — not a post-due one).
  assert.ok(!/overdue/i.test(html),
    'pre-due reminder must not use the word "overdue" anywhere in the body');
}

function testHtmlWithoutPayLink() {
  const html = dueSoon.buildDueSoonHtml({
    invoice_number: 'INV-2',
    client_name: 'Sam',
    owner_business_name: 'Studio',
    total: 100,
    due_date: '2026-04-26',
    payment_link_url: null
  }, new Date('2026-04-25T00:00:00Z'));
  assert.match(html, /due tomorrow/);
  // No pay button rendered → no anchor tag at all.
  assert.ok(!/<a\b/.test(html), 'no anchor should render when payment_link_url is null');
}

function testTextFallbackIncludesPayLink() {
  const text = dueSoon.buildDueSoonText({
    invoice_number: 'INV-9',
    client_name: 'Sam',
    owner_business_name: 'Studio',
    total: 100,
    due_date: '2026-04-27',
    payment_link_url: 'https://buy.stripe.com/abc'
  }, new Date('2026-04-25T00:00:00Z'));
  assert.match(text, /Hi Sam/);
  assert.match(text, /INV-9/);
  assert.match(text, /Studio/);
  assert.match(text, /\$100\.00/);
  assert.match(text, /in 2 days/);
  assert.match(text, /https:\/\/buy\.stripe\.com\/abc/);
}

function testDaysUntilDueArithmetic() {
  // Due 2026-04-27, now 2026-04-25 → 2 days
  assert.strictEqual(
    dueSoon.daysUntilDue({ due_date: '2026-04-27' }, new Date('2026-04-25T12:00:00Z')),
    2
  );
  // Same day → 0
  assert.strictEqual(
    dueSoon.daysUntilDue({ due_date: '2026-04-25' }, new Date('2026-04-25T20:00:00Z')),
    0
  );
  // Past date → clamped 0 (defence-in-depth; SQL gate normally excludes)
  assert.strictEqual(
    dueSoon.daysUntilDue({ due_date: '2026-04-20' }, new Date('2026-04-25T00:00:00Z')),
    0
  );
  // No due_date → 0
  assert.strictEqual(dueSoon.daysUntilDue({}, new Date('2026-04-25T00:00:00Z')), 0);
}

function testDaysUntilDueIsUtcStable() {
  // A naive same-day subtraction near a UTC boundary could flip the
  // "due in 2 days" framing depending on the hour. Both calls below must
  // return 2 because both anchor on UTC dates, not local clock-time.
  const due = '2026-04-27';
  assert.strictEqual(
    dueSoon.daysUntilDue({ due_date: due }, new Date('2026-04-25T00:30:00Z')),
    2
  );
  assert.strictEqual(
    dueSoon.daysUntilDue({ due_date: due }, new Date('2026-04-25T23:30:00Z')),
    2
  );
}

// ---- Orchestrator tests ---------------------------------------------------

function fakeDb(rows = []) {
  const stamped = [];
  return {
    rows,
    stamped,
    async getSentInvoicesDueSoon() { return rows; },
    async markInvoiceDueSoonReminderSent(id) {
      stamped.push(id);
      return { id, due_soon_reminder_sent_at: new Date() };
    }
  };
}

async function testHappyPathSendsAndStamps() {
  const sends = [];
  const db = fakeDb([
    {
      invoice_id: 7,
      invoice_number: 'INV-2026-0007',
      client_name: 'Acme',
      client_email: 'ar@acme.com',
      total: 1234.5,
      due_date: '2026-04-27',
      payment_link_url: 'https://buy.stripe.com/x',
      due_soon_reminder_sent_at: null,
      owner_email: 'me@me.com',
      owner_business_name: 'My Studio',
      owner_business_email: 'billing@me.com',
      owner_reply_to_email: null,
      owner_plan: 'pro'
    }
  ]);

  const summary = await dueSoon.processDueSoonReminders({
    db,
    sendEmail: async (payload) => { sends.push(payload); return { ok: true, id: 'em_1' }; },
    now: new Date('2026-04-25T10:00:00Z'),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });

  assert.strictEqual(summary.found, 1);
  assert.strictEqual(summary.sent, 1);
  assert.strictEqual(summary.errors, 0);
  assert.strictEqual(summary.skipped, 0);
  assert.deepStrictEqual(db.stamped, [7],
    'must stamp due_soon_reminder_sent_at by invoice id');
  assert.strictEqual(sends.length, 1);
  assert.strictEqual(sends[0].to, 'ar@acme.com');
  assert.match(sends[0].subject, /INV-2026-0007/);
  assert.match(sends[0].subject, /in 2 days/);
  assert.strictEqual(sends[0].replyTo, 'billing@me.com',
    'reply-to falls back to business_email when reply_to_email is null');
  assert.match(sends[0].html, /My Studio/);
  assert.match(sends[0].text, /\$1234\.50/);
}

async function testSkipsFreePlan() {
  const sends = [];
  const db = fakeDb([
    {
      invoice_id: 8, invoice_number: 'INV-8', client_name: 'X', client_email: 'x@x.com',
      total: 50, due_date: '2026-04-27', payment_link_url: null,
      owner_email: 'free@me.com', owner_business_name: null,
      owner_business_email: null, owner_reply_to_email: null,
      owner_plan: 'free'
    }
  ]);
  const summary = await dueSoon.processDueSoonReminders({
    db,
    sendEmail: async (p) => { sends.push(p); return { ok: true }; },
    now: new Date('2026-04-25T10:00:00Z'),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.sent, 0);
  assert.strictEqual(summary.skipped, 1);
  assert.strictEqual(sends.length, 0, 'must NOT email a free-plan owner\'s client');
  assert.deepStrictEqual(db.stamped, [], 'must NOT stamp a skipped row');
}

async function testSkipsRowsWithoutClientEmail() {
  const sends = [];
  const db = fakeDb([
    {
      invoice_id: 9, invoice_number: 'INV-9', client_name: 'NoEmail',
      client_email: null, total: 10, due_date: '2026-04-26',
      payment_link_url: null, owner_email: 'pro@me.com',
      owner_business_name: 'Pro Co', owner_business_email: null,
      owner_reply_to_email: null, owner_plan: 'pro'
    }
  ]);
  const summary = await dueSoon.processDueSoonReminders({
    db,
    sendEmail: async (p) => { sends.push(p); return { ok: true }; },
    now: new Date('2026-04-25T00:00:00Z'),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.sent, 0);
  assert.strictEqual(summary.skipped, 1);
  assert.strictEqual(sends.length, 0);
  assert.deepStrictEqual(db.stamped, []);
}

async function testNotConfiguredDoesNotStamp() {
  const db = fakeDb([
    {
      invoice_id: 11, invoice_number: 'INV-11', client_name: 'Foo',
      client_email: 'foo@bar.com', total: 99, due_date: '2026-04-27',
      payment_link_url: 'https://buy.stripe.com/y',
      owner_email: 'pro@me.com', owner_business_name: 'Pro',
      owner_business_email: null, owner_reply_to_email: null, owner_plan: 'pro'
    }
  ]);
  const summary = await dueSoon.processDueSoonReminders({
    db,
    sendEmail: async () => ({ ok: false, reason: 'not_configured' }),
    now: new Date('2026-04-25T10:00:00Z'),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.found, 1);
  assert.strictEqual(summary.sent, 0);
  assert.strictEqual(summary.notConfigured, 1);
  assert.strictEqual(summary.errors, 0,
    'not_configured is a clean skip, not an error');
  assert.deepStrictEqual(db.stamped, [],
    'must NOT stamp due_soon_reminder_sent_at when send was a no-op');
}

async function testEmailErrorDoesNotStampAndContinuesBatch() {
  const sends = [];
  const db = fakeDb([
    {
      invoice_id: 21, invoice_number: 'INV-21', client_name: 'A',
      client_email: 'a@a.com', total: 1, due_date: '2026-04-26',
      payment_link_url: null, owner_email: 'pro@me.com',
      owner_business_name: 'Pro', owner_business_email: null,
      owner_reply_to_email: null, owner_plan: 'pro'
    },
    {
      invoice_id: 22, invoice_number: 'INV-22', client_name: 'B',
      client_email: 'b@b.com', total: 2, due_date: '2026-04-27',
      payment_link_url: 'https://buy.stripe.com/z',
      owner_email: 'pro@me.com', owner_business_name: 'Pro',
      owner_business_email: null, owner_reply_to_email: null, owner_plan: 'pro'
    }
  ]);

  let i = 0;
  const summary = await dueSoon.processDueSoonReminders({
    db,
    sendEmail: async (p) => {
      i += 1;
      if (i === 1) throw new Error('SMTP exploded');
      sends.push(p);
      return { ok: true, id: 'em_b' };
    },
    now: new Date('2026-04-25T10:00:00Z'),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });

  assert.strictEqual(summary.found, 2);
  assert.strictEqual(summary.sent, 1, 'second row should still be emailed');
  assert.strictEqual(summary.errors, 1, 'first throw counts as one error');
  assert.deepStrictEqual(db.stamped, [22],
    'only the successful invoice must be stamped');
  assert.strictEqual(sends.length, 1);
  assert.strictEqual(sends[0].to, 'b@b.com');
}

async function testIdempotentAcrossRunsViaStamp() {
  const initialRows = [{
    invoice_id: 31, invoice_number: 'INV-31', client_name: 'C',
    client_email: 'c@c.com', total: 5, due_date: '2026-04-27',
    payment_link_url: null, owner_email: 'pro@me.com',
    owner_business_name: 'Pro', owner_business_email: null,
    owner_reply_to_email: null, owner_plan: 'pro'
  }];
  let pool = [...initialRows];
  const stamped = [];
  const db = {
    async getSentInvoicesDueSoon() {
      // Simulate the SQL stamp gate: excludes already-stamped rows.
      return pool.filter(r => !stamped.includes(r.invoice_id));
    },
    async markInvoiceDueSoonReminderSent(id) {
      stamped.push(id);
      return { id };
    }
  };
  const sends = [];
  const send = async (p) => { sends.push(p); return { ok: true, id: 'em' }; };

  const r1 = await dueSoon.processDueSoonReminders({
    db, sendEmail: send, now: new Date('2026-04-25T10:00:00Z'),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(r1.sent, 1);

  const r2 = await dueSoon.processDueSoonReminders({
    db, sendEmail: send, now: new Date('2026-04-26T10:00:00Z'),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(r2.found, 0,
    'stamp gate must exclude the row on the next run');
  assert.strictEqual(r2.sent, 0);
  assert.strictEqual(sends.length, 1, 'only one email across both runs');
}

async function testQueryFailureBubblesAsErrorSummary() {
  const db = {
    async getSentInvoicesDueSoon() { throw new Error('PG down'); },
    async markInvoiceDueSoonReminderSent() { throw new Error('should not be called'); }
  };
  const summary = await dueSoon.processDueSoonReminders({
    db,
    sendEmail: async () => ({ ok: true }),
    now: new Date(),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.found, 0);
  assert.strictEqual(summary.sent, 0);
  assert.strictEqual(summary.errors, 1, 'a top-level query failure must count as one error');
}

async function testReplyToPrecedence() {
  const db = fakeDb([
    {
      invoice_id: 41, invoice_number: 'INV-41', client_name: 'D',
      client_email: 'd@d.com', total: 9, due_date: '2026-04-27',
      payment_link_url: null, owner_email: 'me@me.com',
      owner_business_name: 'B', owner_business_email: 'biz@me.com',
      owner_reply_to_email: 'reply@me.com', owner_plan: 'pro'
    }
  ]);
  let captured = null;
  await dueSoon.processDueSoonReminders({
    db,
    sendEmail: async (p) => { captured = p; return { ok: true }; },
    now: new Date('2026-04-25T10:00:00Z'),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(captured.replyTo, 'reply@me.com');
}

async function testDaysAheadOptThreadsToQuery() {
  // Verify the orchestrator passes daysAhead through to db.getSentInvoicesDueSoon
  // so a deployment can tighten or widen the pre-due window via env-driven cron config.
  let captured = null;
  const db = {
    async getSentInvoicesDueSoon(daysAhead) {
      captured = daysAhead;
      return [];
    },
    async markInvoiceDueSoonReminderSent() { return null; }
  };
  await dueSoon.processDueSoonReminders({
    db,
    sendEmail: async () => ({ ok: true }),
    now: new Date(),
    daysAhead: 5,
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(captured, 5,
    'orchestrator must thread opts.daysAhead through to the SQL helper');
}

// ---- Cron wiring ----------------------------------------------------------

async function testStartJobBlockedInTestEnv() {
  process.env.NODE_ENV = 'test';
  const r = dueSoon.startDueSoonReminderJob();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'test_env');
}

async function testStartJobUsesCronCallback() {
  dueSoon.stopDueSoonReminderJob();
  let captured = null;
  const fakeCron = {
    schedule(expr, cb, opts) {
      captured = { expr, cb, opts };
      return { stop() {} };
    }
  };
  const db = fakeDb([
    {
      invoice_id: 51, invoice_number: 'INV-51', client_name: 'E',
      client_email: 'e@e.com', total: 12, due_date: '2026-04-27',
      payment_link_url: null, owner_email: 'pro@me.com',
      owner_business_name: 'P', owner_business_email: null,
      owner_reply_to_email: null, owner_plan: 'pro'
    }
  ]);
  let sendCalls = 0;
  const r = dueSoon.startDueSoonReminderJob({
    force: true,
    cron: fakeCron,
    schedule: '5 10 * * *',
    db,
    sendEmail: async () => { sendCalls += 1; return { ok: true }; },
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.schedule, '5 10 * * *',
    'startDueSoonReminderJob must surface the configured schedule');
  assert.ok(captured, 'cron.schedule must be called');
  assert.strictEqual(captured.expr, '5 10 * * *');
  assert.strictEqual(captured.opts && captured.opts.timezone, 'UTC');
  await captured.cb();
  assert.strictEqual(sendCalls, 1, 'cron tick must invoke processDueSoonReminders');
  assert.deepStrictEqual(db.stamped, [51]);
  dueSoon.stopDueSoonReminderJob();
}

function testDefaultScheduleIsAfterReminders() {
  // Lock in the schedule: reminders.js runs at 09:00 UTC; we run at 10:00 UTC.
  // Two crons fanning out client-facing email at the same minute increases
  // the per-tick burst on Resend; staggering by one hour gives breathing room.
  assert.strictEqual(dueSoon.DEFAULT_SCHEDULE, '0 10 * * *');
}

// ---- SQL contract regression guard ----------------------------------------

async function testSqlGatesOnRealProductionHelper() {
  // Drive db.getSentInvoicesDueSoon through a stubbed pool.query so the
  // exact production SQL is asserted. A future refactor that drops the
  // due_soon_reminder_sent_at IS NULL gate would mass-spam clients with
  // duplicate "heads up" emails; this test fails loudly in that scenario.
  delete require.cache[require.resolve('../db')];
  let captured = null;
  const original = require('pg').Pool.prototype.query;
  require('pg').Pool.prototype.query = async function (sql, params) {
    captured = { sql, params };
    return { rows: [] };
  };
  try {
    const { db } = require('../db');
    await db.getSentInvoicesDueSoon(3);
    assert.ok(captured, 'pool.query must be invoked');
    const sql = captured.sql;
    assert.match(sql, /FROM\s+invoices\s+i/);
    assert.match(sql, /JOIN\s+users\s+u\s+ON\s+u\.id\s*=\s*i\.user_id/i);
    assert.match(sql, /i\.status\s*=\s*'sent'/);
    assert.match(sql, /i\.is_seed\s*=\s*false/);
    assert.match(sql, /i\.due_date\s+IS\s+NOT\s+NULL/i);
    assert.match(sql, /i\.due_date\s*>=\s*CURRENT_DATE/i);
    assert.match(sql, /i\.due_date\s*<=\s*CURRENT_DATE\s*\+\s*\(\$1\s*\*\s*INTERVAL\s+'1\s+day'\)/i);
    assert.match(sql, /i\.due_soon_reminder_sent_at\s+IS\s+NULL/i);
    assert.match(sql, /u\.plan\s+IN\s*\(\s*'pro',\s*'business',\s*'agency'\s*\)/i);
    assert.deepStrictEqual(captured.params, [3]);
  } finally {
    require('pg').Pool.prototype.query = original;
    delete require.cache[require.resolve('../db')];
  }
}

async function testSqlSanitisesNegativeAndNonNumericDaysAhead() {
  delete require.cache[require.resolve('../db')];
  const captures = [];
  const original = require('pg').Pool.prototype.query;
  require('pg').Pool.prototype.query = async function (sql, params) {
    captures.push({ sql, params });
    return { rows: [] };
  };
  try {
    const { db } = require('../db');
    await db.getSentInvoicesDueSoon(-5);
    await db.getSentInvoicesDueSoon('abc');
    await db.getSentInvoicesDueSoon(0);
    assert.strictEqual(captures.length, 3);
    assert.deepStrictEqual(captures[0].params, [2], 'negative falls back to default 2');
    assert.deepStrictEqual(captures[1].params, [2], 'NaN falls back to default 2');
    assert.deepStrictEqual(captures[2].params, [2], 'zero falls back to default 2');
  } finally {
    require('pg').Pool.prototype.query = original;
    delete require.cache[require.resolve('../db')];
  }
}

async function testMarkHelperGuardsAgainstDoubleStamp() {
  delete require.cache[require.resolve('../db')];
  let captured = null;
  const original = require('pg').Pool.prototype.query;
  require('pg').Pool.prototype.query = async function (sql, params) {
    captured = { sql, params };
    return { rows: [{ id: 42, due_soon_reminder_sent_at: new Date() }] };
  };
  try {
    const { db } = require('../db');
    const result = await db.markInvoiceDueSoonReminderSent(42);
    assert.ok(captured, 'pool.query must be invoked');
    assert.match(captured.sql, /UPDATE\s+invoices\s+SET\s+due_soon_reminder_sent_at\s*=\s*NOW\(\)/i);
    assert.match(captured.sql, /updated_at\s*=\s*NOW\(\)/i);
    assert.match(captured.sql, /WHERE\s+id\s*=\s*\$1\s+AND\s+due_soon_reminder_sent_at\s+IS\s+NULL/i,
      'mark helper must guard against double-stamp via IS NULL clause');
    assert.match(captured.sql, /RETURNING\s+id,\s+due_soon_reminder_sent_at/i);
    assert.deepStrictEqual(captured.params, [42]);
    assert.ok(result && result.id === 42, 'must return the stamped row');
  } finally {
    require('pg').Pool.prototype.query = original;
    delete require.cache[require.resolve('../db')];
  }

  // Falsy id short-circuits without a query.
  delete require.cache[require.resolve('../db')];
  let called = false;
  require('pg').Pool.prototype.query = async function () { called = true; return { rows: [] }; };
  try {
    const { db } = require('../db');
    const result = await db.markInvoiceDueSoonReminderSent(0);
    assert.strictEqual(result, null);
    assert.strictEqual(called, false, 'falsy id must not hit the DB');
  } finally {
    require('pg').Pool.prototype.query = original;
    delete require.cache[require.resolve('../db')];
  }
}

// ---- Runner ---------------------------------------------------------------

async function run() {
  const tests = [
    ['subject N days', testSubjectFormatNDays],
    ['subject tomorrow', testSubjectFormatTomorrow],
    ['subject today', testSubjectFormatToday],
    ['html escapes + pay link', testHtmlEscapesAndIncludesPayLink],
    ['html without pay link', testHtmlWithoutPayLink],
    ['text fallback', testTextFallbackIncludesPayLink],
    ['daysUntilDue arithmetic', testDaysUntilDueArithmetic],
    ['daysUntilDue UTC-stable', testDaysUntilDueIsUtcStable],
    ['happy path sends + stamps', testHappyPathSendsAndStamps],
    ['skip free plan', testSkipsFreePlan],
    ['skip no client_email', testSkipsRowsWithoutClientEmail],
    ['not_configured no stamp', testNotConfiguredDoesNotStamp],
    ['email throw continues batch', testEmailErrorDoesNotStampAndContinuesBatch],
    ['idempotent via stamp', testIdempotentAcrossRunsViaStamp],
    ['query failure → error', testQueryFailureBubblesAsErrorSummary],
    ['replyTo precedence', testReplyToPrecedence],
    ['daysAhead opt threads', testDaysAheadOptThreadsToQuery],
    ['cron blocked in test env', testStartJobBlockedInTestEnv],
    ['cron callback runs orchestrator', testStartJobUsesCronCallback],
    ['default schedule 10:00 UTC', testDefaultScheduleIsAfterReminders],
    ['SQL gates on real helper', testSqlGatesOnRealProductionHelper],
    ['SQL sanitises bad daysAhead', testSqlSanitisesNegativeAndNonNumericDaysAhead],
    ['mark guards against double stamp', testMarkHelperGuardsAgainstDoubleStamp]
  ];

  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL - ${name}`);
      console.error(err && err.stack || err);
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log(`\nAll ${tests.length} due-soon-reminder tests passed.`);
}

run();
