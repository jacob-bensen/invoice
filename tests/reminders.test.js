'use strict';

/*
 * Automated payment reminders (INTERNAL_TODO #16).
 *
 * Covers:
 *  1. processOverdueReminders sends a reminder for a Pro invoice that is
 *     past due and never reminded; stamps last_reminder_sent_at via
 *     db.markInvoiceReminderSent.
 *  2. Free-plan rows are skipped (defence-in-depth: the SQL filter would
 *     already exclude them, but the orchestrator re-checks the plan).
 *  3. Rows missing client_email are skipped without error.
 *  4. When sendEmail returns { ok:false, reason:'not_configured' } (no
 *     RESEND_API_KEY), no DB stamp is written — the next run retries.
 *  5. When sendEmail throws, the orchestrator counts the error but does not
 *     bubble; the rest of the batch is still processed.
 *  6. The email payload contains the expected subject, payment link button,
 *     reply-to, and overdue-day count.
 *  7. Second run after the first emits no further sends (idempotent within
 *     the cooldown window) — modelled by re-querying through the SQL helper
 *     which respects last_reminder_sent_at.
 *  8. startReminderJob refuses to schedule under NODE_ENV=test (so the test
 *     suite never spawns a background scheduler) but accepts {force:true}
 *     for explicit scheduling tests with a fake cron.
 *  9. startReminderJob runs the orchestrator on the cron tick (verified by
 *     invoking the captured callback against a fake db + fake email).
 * 10. buildReminderSubject + buildReminderHtml + buildReminderText escape
 *     hostile inputs (XSS guard) and surface the payment link / overdue
 *     text correctly.
 *
 * Run: NODE_ENV=test node tests/reminders.test.js
 */

const assert = require('assert');

function clearReq(mod) { delete require.cache[require.resolve(mod)]; }

// Use the real reminders module (no DB, no email side-effects in any test).
const reminders = require('../jobs/reminders');

// ---- Pure helpers ---------------------------------------------------------

function testSubjectFormat() {
  const subj = reminders.buildReminderSubject({ invoice_number: 'INV-2026-0042' });
  assert.match(subj, /Friendly reminder/);
  assert.match(subj, /INV-2026-0042/);
  assert.match(subj, /overdue/i);
}

function testHtmlEscapesAndIncludesPayLink() {
  const html = reminders.buildReminderHtml({
    invoice_number: 'INV-1',
    client_name: '<script>alert(1)</script>',
    owner_business_name: 'Acme & Co',
    total: 250,
    due_date: '2026-04-01',
    payment_link_url: 'https://buy.stripe.com/test_xyz?x=1&y=2'
  }, new Date('2026-04-25T00:00:00Z'));

  assert.ok(!html.includes('<script>alert(1)</script>'),
    'must escape raw script tags from client_name');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /Acme &amp; Co/, 'must escape ampersands in business name');
  assert.match(html, /https:\/\/buy\.stripe\.com\/test_xyz\?x=1&amp;y=2/,
    'pay button must include the payment link URL with escaped query string');
  assert.match(html, /day(s)? overdue/, 'must include an overdue-days line');
  assert.match(html, /\$250\.00/, 'must include the formatted total');
}

function testTextFallbackIncludesPayLink() {
  const text = reminders.buildReminderText({
    invoice_number: 'INV-9',
    client_name: 'Sam',
    owner_business_name: 'Studio',
    total: 100,
    due_date: '2026-04-10',
    payment_link_url: 'https://buy.stripe.com/abc'
  }, new Date('2026-04-25T00:00:00Z'));
  assert.match(text, /Hi Sam/);
  assert.match(text, /INV-9/);
  assert.match(text, /Studio/);
  assert.match(text, /\$100\.00/);
  assert.match(text, /15 days overdue/);
  assert.match(text, /https:\/\/buy\.stripe\.com\/abc/);
}

function testDaysOverdueArithmetic() {
  // Due 2026-04-20, now 2026-04-25 → 5 days overdue
  const row = { due_date: '2026-04-20' };
  assert.strictEqual(reminders.daysOverdue(row, new Date('2026-04-25T12:00:00Z')), 5);
  assert.strictEqual(reminders.daysOverdue(row, new Date('2026-04-20T00:00:00Z')), 0);
  // Future due date → 0 (not negative)
  assert.strictEqual(
    reminders.daysOverdue({ due_date: '2026-05-10' }, new Date('2026-04-25T00:00:00Z')),
    0
  );
}

// ---- Orchestrator tests ---------------------------------------------------

function fakeDb(rows = []) {
  const stamped = [];
  return {
    rows,
    stamped,
    async getOverdueInvoicesForReminders() { return rows; },
    async markInvoiceReminderSent(id) {
      stamped.push(id);
      return { id, last_reminder_sent_at: new Date() };
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
      due_date: '2026-04-15',
      payment_link_url: 'https://buy.stripe.com/x',
      last_reminder_sent_at: null,
      owner_email: 'me@me.com',
      owner_business_name: 'My Studio',
      owner_business_email: 'billing@me.com',
      owner_reply_to_email: null,
      owner_plan: 'pro'
    }
  ]);

  const summary = await reminders.processOverdueReminders({
    db,
    sendEmail: async (payload) => { sends.push(payload); return { ok: true, id: 'em_1' }; },
    now: new Date('2026-04-25T09:00:00Z'),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });

  assert.strictEqual(summary.found, 1);
  assert.strictEqual(summary.sent, 1);
  assert.strictEqual(summary.errors, 0);
  assert.strictEqual(summary.skipped, 0);
  assert.deepStrictEqual(db.stamped, [7], 'must stamp last_reminder_sent_at by invoice id');
  assert.strictEqual(sends.length, 1);
  assert.strictEqual(sends[0].to, 'ar@acme.com');
  assert.match(sends[0].subject, /INV-2026-0007/);
  assert.match(sends[0].subject, /overdue/i);
  assert.strictEqual(sends[0].replyTo, 'billing@me.com',
    'reply-to falls back to business_email when reply_to_email is null');
  assert.match(sends[0].html, /My Studio/);
  assert.match(sends[0].text, /\$1234\.50/);
}

async function testSkipsFreePlan() {
  // Defence-in-depth: even if a free user sneaks past the SQL filter, the
  // orchestrator must not email them.
  const sends = [];
  const db = fakeDb([
    {
      invoice_id: 8, invoice_number: 'INV-8', client_name: 'X', client_email: 'x@x.com',
      total: 50, due_date: '2026-04-20', payment_link_url: null,
      owner_email: 'free@me.com', owner_business_name: null,
      owner_business_email: null, owner_reply_to_email: null,
      owner_plan: 'free'
    }
  ]);
  const summary = await reminders.processOverdueReminders({
    db,
    sendEmail: async (p) => { sends.push(p); return { ok: true }; },
    now: new Date('2026-04-25T09:00:00Z'),
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
      client_email: null, total: 10, due_date: '2026-04-20',
      payment_link_url: null, owner_email: 'pro@me.com',
      owner_business_name: 'Pro Co', owner_business_email: null,
      owner_reply_to_email: null, owner_plan: 'pro'
    }
  ]);
  const summary = await reminders.processOverdueReminders({
    db,
    sendEmail: async (p) => { sends.push(p); return { ok: true }; },
    now: new Date(),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.sent, 0);
  assert.strictEqual(summary.skipped, 1);
  assert.strictEqual(sends.length, 0);
  assert.deepStrictEqual(db.stamped, []);
}

async function testNotConfiguredDoesNotStamp() {
  // sendEmail returns not_configured (RESEND_API_KEY unset). The next cron
  // pass must retry — so we must NOT stamp the DB.
  const db = fakeDb([
    {
      invoice_id: 11, invoice_number: 'INV-11', client_name: 'Foo',
      client_email: 'foo@bar.com', total: 99, due_date: '2026-04-01',
      payment_link_url: 'https://buy.stripe.com/y',
      owner_email: 'pro@me.com', owner_business_name: 'Pro',
      owner_business_email: null, owner_reply_to_email: null, owner_plan: 'pro'
    }
  ]);
  const summary = await reminders.processOverdueReminders({
    db,
    sendEmail: async () => ({ ok: false, reason: 'not_configured' }),
    now: new Date('2026-04-25T09:00:00Z'),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.found, 1);
  assert.strictEqual(summary.sent, 0);
  assert.strictEqual(summary.notConfigured, 1);
  assert.strictEqual(summary.errors, 0,
    'not_configured is a clean skip, not an error');
  assert.deepStrictEqual(db.stamped, [],
    'must NOT stamp last_reminder_sent_at when send was a no-op');
}

async function testEmailErrorDoesNotStampAndContinuesBatch() {
  // First row throws; second row succeeds; orchestrator must report 1
  // error + 1 sent without bubbling.
  const sends = [];
  const db = fakeDb([
    {
      invoice_id: 21, invoice_number: 'INV-21', client_name: 'A',
      client_email: 'a@a.com', total: 1, due_date: '2026-04-20',
      payment_link_url: null, owner_email: 'pro@me.com',
      owner_business_name: 'Pro', owner_business_email: null,
      owner_reply_to_email: null, owner_plan: 'pro'
    },
    {
      invoice_id: 22, invoice_number: 'INV-22', client_name: 'B',
      client_email: 'b@b.com', total: 2, due_date: '2026-04-19',
      payment_link_url: 'https://buy.stripe.com/z',
      owner_email: 'pro@me.com', owner_business_name: 'Pro',
      owner_business_email: null, owner_reply_to_email: null, owner_plan: 'pro'
    }
  ]);

  let i = 0;
  const summary = await reminders.processOverdueReminders({
    db,
    sendEmail: async (p) => {
      i += 1;
      if (i === 1) throw new Error('SMTP exploded');
      sends.push(p);
      return { ok: true, id: 'em_b' };
    },
    now: new Date('2026-04-25T09:00:00Z'),
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

async function testIdempotentAcrossRunsViaCooldown() {
  // Models the cooldown semantics: after a successful send, the SQL helper
  // (in real code) would exclude the row until 3 days pass. Here we simulate
  // the second pass by re-querying the same fake — but the fake removes the
  // stamped row from its pool, mirroring "the SQL filter excludes it".
  const initialRows = [{
    invoice_id: 31, invoice_number: 'INV-31', client_name: 'C',
    client_email: 'c@c.com', total: 5, due_date: '2026-04-15',
    payment_link_url: null, owner_email: 'pro@me.com',
    owner_business_name: 'Pro', owner_business_email: null,
    owner_reply_to_email: null, owner_plan: 'pro'
  }];
  let pool = [...initialRows];
  const stamped = [];
  const db = {
    async getOverdueInvoicesForReminders() {
      // Simulate the SQL cooldown filter: excludes rows already stamped.
      return pool.filter(r => !stamped.includes(r.invoice_id));
    },
    async markInvoiceReminderSent(id) {
      stamped.push(id);
      return { id };
    }
  };
  const sends = [];
  const send = async (p) => { sends.push(p); return { ok: true, id: 'em' }; };

  const r1 = await reminders.processOverdueReminders({
    db, sendEmail: send, now: new Date('2026-04-25T09:00:00Z'),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(r1.sent, 1);

  const r2 = await reminders.processOverdueReminders({
    db, sendEmail: send, now: new Date('2026-04-25T09:01:00Z'),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(r2.found, 0,
    'cooldown filter must exclude the row on the next run');
  assert.strictEqual(r2.sent, 0);
  assert.strictEqual(sends.length, 1, 'only one email across both runs');
}

async function testQueryFailureBubblesAsErrorSummary() {
  const db = {
    async getOverdueInvoicesForReminders() { throw new Error('PG down'); },
    async markInvoiceReminderSent() { throw new Error('should not be called'); }
  };
  const summary = await reminders.processOverdueReminders({
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
  // owner_reply_to_email > business_email > email
  const db = fakeDb([
    {
      invoice_id: 41, invoice_number: 'INV-41', client_name: 'D',
      client_email: 'd@d.com', total: 9, due_date: '2026-04-15',
      payment_link_url: null, owner_email: 'me@me.com',
      owner_business_name: 'B', owner_business_email: 'biz@me.com',
      owner_reply_to_email: 'reply@me.com', owner_plan: 'pro'
    }
  ]);
  let captured = null;
  await reminders.processOverdueReminders({
    db,
    sendEmail: async (p) => { captured = p; return { ok: true }; },
    now: new Date(),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(captured.replyTo, 'reply@me.com',
    'must prefer reply_to_email over business_email');

  const db2 = fakeDb([{
    ...db.rows[0], owner_reply_to_email: null, owner_business_email: 'biz@me.com'
  }]);
  let captured2 = null;
  await reminders.processOverdueReminders({
    db: db2,
    sendEmail: async (p) => { captured2 = p; return { ok: true }; },
    now: new Date(),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(captured2.replyTo, 'biz@me.com');
}

// ---- Cron wiring ---------------------------------------------------------

async function testStartReminderJobBlockedInTestEnv() {
  // No `force` flag → must refuse to schedule under NODE_ENV=test so the test
  // suite never starts a background scheduler.
  process.env.NODE_ENV = 'test';
  const r = reminders.startReminderJob();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'test_env');
}

async function testStartReminderJobUsesCronCallback() {
  // Inject a fake cron, capture the callback, force scheduling under test
  // env, then trigger the callback against a fake db + sendEmail.
  reminders.stopReminderJob();
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
      client_email: 'e@e.com', total: 12, due_date: '2026-04-10',
      payment_link_url: null, owner_email: 'pro@me.com',
      owner_business_name: 'P', owner_business_email: null,
      owner_reply_to_email: null, owner_plan: 'pro'
    }
  ]);
  let sendCalls = 0;
  const r = reminders.startReminderJob({
    force: true,
    cron: fakeCron,
    schedule: '5 9 * * *',
    db,
    sendEmail: async () => { sendCalls += 1; return { ok: true }; },
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.schedule, '5 9 * * *',
    'startReminderJob must surface the configured schedule');
  assert.ok(captured, 'cron.schedule must be called');
  assert.strictEqual(captured.expr, '5 9 * * *');
  assert.strictEqual(captured.opts && captured.opts.timezone, 'UTC');
  // Trigger the cron tick.
  await captured.cb();
  assert.strictEqual(sendCalls, 1, 'cron tick must invoke processOverdueReminders');
  assert.deepStrictEqual(db.stamped, [51]);
  reminders.stopReminderJob();
}

async function testStartReminderJobRefusesDoubleStart() {
  reminders.stopReminderJob();
  const fakeCron = { schedule() { return { stop() {} }; } };
  const r1 = reminders.startReminderJob({ force: true, cron: fakeCron });
  assert.strictEqual(r1.ok, true);
  const r2 = reminders.startReminderJob({ force: true, cron: fakeCron });
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.reason, 'already_running');
  reminders.stopReminderJob();
}

// ---- Test runner ---------------------------------------------------------

async function run() {
  const tests = [
    ['subject formatter', testSubjectFormat],
    ['html escapes hostile input + renders pay button', testHtmlEscapesAndIncludesPayLink],
    ['text fallback includes pay link + days overdue', testTextFallbackIncludesPayLink],
    ['daysOverdue arithmetic', testDaysOverdueArithmetic],
    ['happy path sends and stamps', testHappyPathSendsAndStamps],
    ['free plan is skipped (defence-in-depth)', testSkipsFreePlan],
    ['rows without client_email are skipped', testSkipsRowsWithoutClientEmail],
    ['not_configured does not stamp DB', testNotConfiguredDoesNotStamp],
    ['email error does not stamp; batch continues', testEmailErrorDoesNotStampAndContinuesBatch],
    ['idempotent across runs via cooldown', testIdempotentAcrossRunsViaCooldown],
    ['top-level query failure → errors=1', testQueryFailureBubblesAsErrorSummary],
    ['reply-to precedence: reply_to > business > email', testReplyToPrecedence],
    ['startReminderJob refuses to schedule under NODE_ENV=test', testStartReminderJobBlockedInTestEnv],
    ['startReminderJob calls cron + tick triggers sends', testStartReminderJobUsesCronCallback],
    ['startReminderJob rejects double start', testStartReminderJobRefusesDoubleStart]
  ];

  let passed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ok  ${name}`);
      passed += 1;
    } catch (err) {
      console.error(`  FAIL ${name}\n    ${err && err.stack || err}`);
      process.exitCode = 1;
    }
  }
  console.log(`\n${passed}/${tests.length} reminder tests passed`);
}

run();
