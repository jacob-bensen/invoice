'use strict';

/*
 * Trial End Day-3 Nudge Email (INTERNAL_TODO #29).
 *
 * Mirrors tests/reminders.test.js coverage shape. Covers:
 *  1. Subject + HTML + text formatters (XSS escape, day-count copy,
 *     singular/plural, invoice-count line, CTA URL).
 *  2. daysLeft arithmetic — same-day, midway, future-trial, expired.
 *  3. Happy-path orchestrator: user with trial ending in 3 days → email
 *     sent + DB stamp written; summary reports sent=1.
 *  4. Skips users without an email (defence-in-depth — query already filters
 *     them in production schema, but the orchestrator must not throw).
 *  5. `not_configured` (RESEND_API_KEY unset) → no DB stamp, summary reports
 *     notConfigured=1, errors=0. Next cron pass retries automatically.
 *  6. sendEmail throw → counts an error, batch continues, no stamp.
 *  7. Idempotency across runs — modelled via fake DB whose query helper
 *     respects `trial_nudge_sent_at` (mirrors the SQL filter).
 *  8. Top-level query failure → summary reports errors=1, no throw.
 *  9. startTrialNudgeJob refuses to schedule under NODE_ENV=test (so the
 *     test suite never spawns a background scheduler) but accepts force:true.
 * 10. Cron tick wires processTrialNudges through correctly with injected
 *     fake db + fake email; schedule string and timezone match the spec.
 *
 * Run: NODE_ENV=test node tests/trial-nudge.test.js
 */

const assert = require('assert');

const trialNudge = require('../jobs/trial-nudge');

// ---- Pure helpers ---------------------------------------------------------

function testSubjectFormat() {
  const user = { trial_ends_at: new Date('2026-04-29T00:00:00Z') };
  const subj = trialNudge.buildTrialNudgeSubject(user, new Date('2026-04-26T00:00:00Z'));
  assert.match(subj, /Your Pro trial ends in 3 days/);
  assert.match(subj, /don't lose your data/);
}

function testSubjectSingularDay() {
  const user = { trial_ends_at: new Date('2026-04-27T00:00:00Z') };
  const subj = trialNudge.buildTrialNudgeSubject(user, new Date('2026-04-26T00:00:00Z'));
  assert.match(subj, /ends in 1 day/);
  assert.ok(!/ends in 1 days/.test(subj), 'must use singular "1 day"');
}

function testHtmlEscapesNameAndIncludesCta() {
  delete process.env.APP_URL;
  process.env.APP_URL = 'https://decentinvoice.com';

  const html = trialNudge.buildTrialNudgeHtml({
    name: '<script>alert(1)</script>',
    business_name: 'Acme & Co',
    trial_ends_at: new Date('2026-04-29T00:00:00Z'),
    invoice_count: 4
  }, new Date('2026-04-26T00:00:00Z'));

  assert.ok(!/<script>alert\(1\)<\/script>/.test(html),
    'must escape raw script tags from name');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /Your Pro trial ends in 3 days/);
  assert.match(html, /4 invoices/, 'must show pluralised invoice count');
  assert.match(html, /https:\/\/decentinvoice\.io\/dashboard/, 'CTA must link to /dashboard');
  assert.match(html, /Keep Pro/);
  assert.match(html, /Add payment method/);
  assert.match(html, /Stripe Payment Links/);
  assert.match(html, /Automated overdue reminders/);
  assert.match(html, /Custom branding/);
}

function testHtmlSingularInvoiceAndZeroInvoiceCases() {
  process.env.APP_URL = 'https://decentinvoice.com';
  const oneInvoice = trialNudge.buildTrialNudgeHtml({
    name: 'Sam', trial_ends_at: new Date('2026-04-29T00:00:00Z'), invoice_count: 1
  }, new Date('2026-04-26T00:00:00Z'));
  assert.match(oneInvoice, /1 invoice</, 'must use singular "1 invoice" (no s)');
  assert.ok(!/1 invoices/.test(oneInvoice));

  const zeroInvoice = trialNudge.buildTrialNudgeHtml({
    name: 'Sam', trial_ends_at: new Date('2026-04-29T00:00:00Z'), invoice_count: 0
  }, new Date('2026-04-26T00:00:00Z'));
  assert.ok(!/0 invoice/.test(zeroInvoice),
    'must omit the invoice line entirely when count is 0 (no "0 invoices created" awkwardness)');
}

function testHtmlOmitsCtaWhenAppUrlMissing() {
  delete process.env.APP_URL;
  const html = trialNudge.buildTrialNudgeHtml({
    name: 'Sam', trial_ends_at: new Date('2026-04-29T00:00:00Z'), invoice_count: 0
  }, new Date('2026-04-26T00:00:00Z'));
  assert.ok(!/<a href=/.test(html),
    'no CTA <a> when APP_URL is unset (graceful degradation, no broken-link buttons)');
  assert.match(html, /Add a payment method/, 'body copy still references the action');
}

function testTextFallback() {
  process.env.APP_URL = 'https://decentinvoice.com/';
  const text = trialNudge.buildTrialNudgeText({
    name: 'Sam',
    trial_ends_at: new Date('2026-04-29T00:00:00Z'),
    invoice_count: 7
  }, new Date('2026-04-26T00:00:00Z'));
  assert.match(text, /Hi Sam/);
  assert.match(text, /trial ends in 3 days/);
  assert.match(text, /7 invoices/);
  assert.match(text, /Stripe Payment Links/);
  assert.match(text, /https:\/\/decentinvoice\.io\/dashboard/, 'must trim trailing slash from APP_URL');
}

function testDaysLeftArithmetic() {
  // 3 days exact
  assert.strictEqual(
    trialNudge.daysLeft(new Date('2026-04-29T12:00:00Z'), new Date('2026-04-26T12:00:00Z')),
    3
  );
  // Already expired
  assert.strictEqual(
    trialNudge.daysLeft(new Date('2026-04-25T00:00:00Z'), new Date('2026-04-26T00:00:00Z')),
    0
  );
  // Same instant
  assert.strictEqual(
    trialNudge.daysLeft(new Date('2026-04-26T00:00:00Z'), new Date('2026-04-26T00:00:00Z')),
    0
  );
  // null trial
  assert.strictEqual(trialNudge.daysLeft(null, new Date()), 0);
  // garbage
  assert.strictEqual(trialNudge.daysLeft('not-a-date', new Date()), 0);
}

// ---- Orchestrator tests ---------------------------------------------------

function fakeDb(users = []) {
  const stamped = [];
  return {
    users,
    stamped,
    async getTrialUsersNeedingNudge() { return users; },
    async markTrialNudgeSent(id) {
      stamped.push(id);
      return { id, trial_nudge_sent_at: new Date() };
    }
  };
}

async function testHappyPathSendsAndStamps() {
  process.env.APP_URL = 'https://decentinvoice.com';
  const sends = [];
  const db = fakeDb([
    {
      id: 42,
      email: 'u@test.io',
      name: 'Sam',
      business_name: 'Studio',
      trial_ends_at: new Date('2026-04-29T00:00:00Z'),
      invoice_count: 3
    }
  ]);

  const summary = await trialNudge.processTrialNudges({
    db,
    sendEmail: async (payload) => { sends.push(payload); return { ok: true, id: 'em_1' }; },
    now: new Date('2026-04-26T10:00:00Z'),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });

  assert.strictEqual(summary.found, 1);
  assert.strictEqual(summary.sent, 1);
  assert.strictEqual(summary.errors, 0);
  assert.strictEqual(summary.skipped, 0);
  assert.strictEqual(summary.notConfigured, 0);
  assert.deepStrictEqual(db.stamped, [42], 'must stamp trial_nudge_sent_at by user id');
  assert.strictEqual(sends.length, 1);
  assert.strictEqual(sends[0].to, 'u@test.io', 'recipient is the trial user');
  assert.match(sends[0].subject, /Your Pro trial ends in 3 days/);
  assert.match(sends[0].html, /Hi Sam/, 'HTML must include personalised greeting');
  assert.match(sends[0].html, /3 invoices/);
  assert.match(sends[0].text, /Hi Sam/);
}

async function testSkipsUsersWithoutEmail() {
  const sends = [];
  const db = fakeDb([
    { id: 7, email: null, name: 'NoEmail',
      trial_ends_at: new Date('2026-04-29T00:00:00Z'), invoice_count: 0 }
  ]);
  const summary = await trialNudge.processTrialNudges({
    db,
    sendEmail: async (p) => { sends.push(p); return { ok: true }; },
    now: new Date('2026-04-26T10:00:00Z'),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.sent, 0);
  assert.strictEqual(summary.skipped, 1);
  assert.strictEqual(sends.length, 0, 'must not call sendEmail with no recipient');
  assert.deepStrictEqual(db.stamped, []);
}

async function testNotConfiguredDoesNotStamp() {
  // RESEND_API_KEY unset path. The next cron pass must retry — so we must
  // NOT stamp the DB.
  const db = fakeDb([
    { id: 99, email: 'foo@bar.com', name: 'Foo',
      trial_ends_at: new Date('2026-04-29T00:00:00Z'), invoice_count: 1 }
  ]);
  const summary = await trialNudge.processTrialNudges({
    db,
    sendEmail: async () => ({ ok: false, reason: 'not_configured' }),
    now: new Date('2026-04-26T10:00:00Z'),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.found, 1);
  assert.strictEqual(summary.sent, 0);
  assert.strictEqual(summary.notConfigured, 1);
  assert.strictEqual(summary.errors, 0,
    'not_configured is a clean skip, not an error — log/discard, retry next tick');
  assert.deepStrictEqual(db.stamped, [],
    'must NOT stamp trial_nudge_sent_at when send was a no-op');
}

async function testEmailErrorContinuesBatch() {
  const sends = [];
  const db = fakeDb([
    { id: 1, email: 'a@a.com', name: 'A',
      trial_ends_at: new Date('2026-04-29T00:00:00Z'), invoice_count: 0 },
    { id: 2, email: 'b@b.com', name: 'B',
      trial_ends_at: new Date('2026-04-29T01:00:00Z'), invoice_count: 0 }
  ]);
  let i = 0;
  const summary = await trialNudge.processTrialNudges({
    db,
    sendEmail: async (p) => {
      i += 1;
      if (i === 1) throw new Error('SMTP exploded');
      sends.push(p);
      return { ok: true, id: 'em_b' };
    },
    now: new Date('2026-04-26T10:00:00Z'),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.found, 2);
  assert.strictEqual(summary.sent, 1, 'second user should still be emailed');
  assert.strictEqual(summary.errors, 1);
  assert.deepStrictEqual(db.stamped, [2], 'only the successful user is stamped');
  assert.strictEqual(sends.length, 1);
  assert.strictEqual(sends[0].to, 'b@b.com');
}

async function testIdempotentAcrossRuns() {
  // The query helper is the source of idempotency in production: once a row
  // is stamped, the WHERE clause excludes it. We mirror that here by having
  // the fake's getTrialUsersNeedingNudge filter out stamped ids — same
  // semantics as the production SQL `trial_nudge_sent_at IS NULL`.
  const initial = [{
    id: 11, email: 'c@c.com', name: 'C',
    trial_ends_at: new Date('2026-04-29T00:00:00Z'), invoice_count: 2
  }];
  const stamped = [];
  const db = {
    async getTrialUsersNeedingNudge() {
      return initial.filter(u => !stamped.includes(u.id));
    },
    async markTrialNudgeSent(id) { stamped.push(id); return { id }; }
  };
  const sends = [];
  const send = async (p) => { sends.push(p); return { ok: true, id: 'e' }; };

  const r1 = await trialNudge.processTrialNudges({
    db, sendEmail: send, now: new Date('2026-04-26T10:00:00Z'),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(r1.sent, 1);

  const r2 = await trialNudge.processTrialNudges({
    db, sendEmail: send, now: new Date('2026-04-27T10:00:00Z'),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(r2.found, 0,
    'idempotency filter must exclude the row on the next run');
  assert.strictEqual(r2.sent, 0);
  assert.strictEqual(sends.length, 1, 'only one email across both runs');
}

async function testQueryFailureBubblesAsErrorSummary() {
  const db = {
    async getTrialUsersNeedingNudge() { throw new Error('PG down'); },
    async markTrialNudgeSent() { throw new Error('should not be called'); }
  };
  const summary = await trialNudge.processTrialNudges({
    db,
    sendEmail: async () => ({ ok: true }),
    now: new Date(),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.found, 0);
  assert.strictEqual(summary.sent, 0);
  assert.strictEqual(summary.errors, 1, 'a top-level query failure must count as one error');
}

// ---- Cron wiring ---------------------------------------------------------

async function testStartTrialNudgeJobBlockedInTestEnv() {
  process.env.NODE_ENV = 'test';
  trialNudge.stopTrialNudgeJob();
  const r = trialNudge.startTrialNudgeJob();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'test_env');
}

async function testStartTrialNudgeJobUsesCronCallback() {
  trialNudge.stopTrialNudgeJob();
  let captured = null;
  const fakeCron = {
    schedule(expr, cb, opts) {
      captured = { expr, cb, opts };
      return { stop() {} };
    }
  };
  const db = fakeDb([{
    id: 51, email: 'e@e.com', name: 'E',
    trial_ends_at: new Date('2026-04-29T00:00:00Z'), invoice_count: 1
  }]);
  let sendCalls = 0;
  const r = trialNudge.startTrialNudgeJob({
    force: true,
    cron: fakeCron,
    schedule: '0 10 * * *',
    db,
    sendEmail: async () => { sendCalls += 1; return { ok: true }; },
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.schedule, '0 10 * * *');
  assert.ok(captured, 'cron.schedule must be called');
  assert.strictEqual(captured.expr, '0 10 * * *');
  assert.strictEqual(captured.opts && captured.opts.timezone, 'UTC');
  await captured.cb();
  assert.strictEqual(sendCalls, 1, 'cron tick must invoke processTrialNudges');
  assert.deepStrictEqual(db.stamped, [51]);
  trialNudge.stopTrialNudgeJob();
}

async function testStartTrialNudgeJobRefusesDoubleStart() {
  trialNudge.stopTrialNudgeJob();
  const fakeCron = { schedule() { return { stop() {} }; } };
  const r1 = trialNudge.startTrialNudgeJob({ force: true, cron: fakeCron });
  assert.strictEqual(r1.ok, true);
  const r2 = trialNudge.startTrialNudgeJob({ force: true, cron: fakeCron });
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.reason, 'already_running');
  trialNudge.stopTrialNudgeJob();
}

async function testDefaultSchedule() {
  // Default cron expression matches the spec: 10:00 UTC daily.
  assert.strictEqual(trialNudge.DEFAULT_SCHEDULE, '0 10 * * *',
    'default schedule must be 10:00 UTC daily per INTERNAL_TODO #29');
}

// ---- Test runner ---------------------------------------------------------

async function run() {
  const tests = [
    ['subject formatter (3 days, plural)', testSubjectFormat],
    ['subject formatter (1 day, singular)', testSubjectSingularDay],
    ['html escapes hostile name + includes CTA / features list', testHtmlEscapesNameAndIncludesCta],
    ['html: singular "1 invoice" / omits invoice line at 0', testHtmlSingularInvoiceAndZeroInvoiceCases],
    ['html omits CTA gracefully when APP_URL is unset', testHtmlOmitsCtaWhenAppUrlMissing],
    ['text fallback includes greeting + invoice count + CTA URL', testTextFallback],
    ['daysLeft arithmetic: same-day, expired, future, garbage', testDaysLeftArithmetic],
    ['happy path: sends and stamps', testHappyPathSendsAndStamps],
    ['users without email are skipped (defence-in-depth)', testSkipsUsersWithoutEmail],
    ['not_configured does not stamp DB', testNotConfiguredDoesNotStamp],
    ['email error counts; batch continues; only success stamped', testEmailErrorContinuesBatch],
    ['idempotent across runs (filter respects stamp)', testIdempotentAcrossRuns],
    ['top-level query failure → errors=1', testQueryFailureBubblesAsErrorSummary],
    ['startTrialNudgeJob refuses to schedule under NODE_ENV=test', testStartTrialNudgeJobBlockedInTestEnv],
    ['startTrialNudgeJob calls cron + tick triggers sends', testStartTrialNudgeJobUsesCronCallback],
    ['startTrialNudgeJob rejects double start', testStartTrialNudgeJobRefusesDoubleStart],
    ['DEFAULT_SCHEDULE is 0 10 * * * (10:00 UTC daily)', testDefaultSchedule]
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
  console.log(`\n${passed}/${tests.length} trial-nudge tests passed`);
}

run();
