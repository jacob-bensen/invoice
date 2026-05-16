'use strict';

/*
 * Stale-Draft Email Reminder — 24h+ draft invoice cron job.
 *
 * Coverage mirrors tests/trial-nudge.test.js:
 *   1. Subject + HTML + text formatters: XSS escape, hours-old anchor,
 *      pluralization-free copy, CTA URL with/without APP_URL.
 *   2. hoursOld() arithmetic — exact 24h, 72h, expired, garbage.
 *   3. Happy path: stale-draft row → email sent + user stamp written.
 *   4. Skips users without an email (defence-in-depth).
 *   5. not_configured (RESEND key unset) → no stamp, retries next tick.
 *   6. sendEmail throw → counts an error, batch continues, no stamp.
 *   7. Idempotency across runs — modelled via fake DB whose query helper
 *      respects stale_draft_email_sent_at (mirrors production SQL).
 *   8. Top-level query failure → errors=1, no throw.
 *   9. startStaleDraftEmailJob blocked under NODE_ENV=test; accepts force.
 *  10. Cron tick wires processStaleDraftEmails through correctly.
 *  11. Double start refused.
 *  12. DEFAULT_SCHEDULE shape.
 *  13. SQL contract checks on db.getUsersWithStaleDraftForEmail — the
 *      production query gates on is_seed=false, welcome_email_sent_at IS
 *      NOT NULL, and the cooldown window. These predicates are the safety
 *      net against (a) emailing about the seed sample, (b) emailing before
 *      welcome, (c) re-emailing inside cooldown.
 *
 * Run: NODE_ENV=test node tests/stale-draft-email.test.js
 */

const assert = require('assert');

// Stale-draft job module — pure functions + orchestrator.
const staleDraft = require('../jobs/stale-draft-email');

// ---- Helpers -----------------------------------------------------------

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function staleRow(over = {}) {
  return {
    user_id: 42,
    invoice_id: 7,
    invoice_number: 'INV-2026-0003',
    client_name: 'Acme Co',
    invoice_total: '1500.00',
    draft_created_at: new Date('2026-05-14T00:00:00Z'),
    email: 'user@test.io',
    name: 'Sam',
    business_name: 'Studio',
    reply_to_email: null,
    business_email: 'biz@test.io',
    ...over
  };
}

// ---- Pure formatters ---------------------------------------------------

test('subject: hours bucketed (24+, 48+) — no minute drift in subject', () => {
  // 24h exactly
  const subj24 = staleDraft.buildStaleDraftSubject(
    staleRow({ draft_created_at: new Date('2026-05-15T00:00:00Z') }),
    new Date('2026-05-16T00:00:00Z')
  );
  assert.match(subj24, /INV-2026-0003 has been a draft for 24\+ hours/);

  // 72h
  const subj72 = staleDraft.buildStaleDraftSubject(
    staleRow({ draft_created_at: new Date('2026-05-13T00:00:00Z') }),
    new Date('2026-05-16T00:00:00Z')
  );
  assert.match(subj72, /draft for 72\+ hours/, '48h+ subjects bucket to multiples of 24');
});

test('subject: missing invoice_number degrades gracefully', () => {
  const subj = staleDraft.buildStaleDraftSubject(
    staleRow({ invoice_number: null }),
    new Date('2026-05-16T00:00:00Z')
  );
  assert.match(subj, /your invoice has been a draft for/,
    'missing invoice_number falls back to "your invoice"');
});

test('html: escapes hostile name + client + threads CTA URL when APP_URL is set', () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const html = staleDraft.buildStaleDraftHtml(staleRow({
    name: '<script>alert(1)</script>',
    client_name: 'X & Co <em>',
    invoice_number: 'INV-2026-0003',
    invoice_total: '1500.00',
    draft_created_at: new Date('2026-05-14T00:00:00Z')
  }), new Date('2026-05-16T00:00:00Z'));

  assert.ok(!/<script>alert\(1\)<\/script>/.test(html),
    'raw script must be escaped (XSS defence)');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /X &amp; Co/);
  assert.match(html, /INV-2026-0003/);
  assert.match(html, /\$1500\.00/, 'total must be money-formatted');
  assert.match(html, /48 hours/, 'hours-old anchor inline in body');
  assert.match(html, /https:\/\/decentinvoice\.com\/invoices\/7/,
    'CTA must deep-link to /invoices/<id> (not just /dashboard)');
  assert.match(html, /Open draft/, 'CTA copy "Open draft" present');
});

test('html: CTA omitted gracefully when APP_URL is unset (no broken-link button)', () => {
  delete process.env.APP_URL;
  const html = staleDraft.buildStaleDraftHtml(staleRow(), new Date('2026-05-16T00:00:00Z'));
  assert.ok(!/<a href=/.test(html),
    'no CTA <a> when APP_URL is unset — graceful degradation');
  assert.match(html, /still a draft/, 'body copy remains');
});

test('text: includes greeting, hours-old anchor, client + CTA URL with trimmed trailing slash', () => {
  process.env.APP_URL = 'https://decentinvoice.com/';
  const text = staleDraft.buildStaleDraftText(staleRow({
    name: 'Sam',
    invoice_number: 'INV-2026-0003',
    invoice_total: '1500.00',
    client_name: 'Acme',
    draft_created_at: new Date('2026-05-14T00:00:00Z')
  }), new Date('2026-05-16T00:00:00Z'));
  assert.match(text, /Hi Sam/);
  assert.match(text, /INV-2026-0003/);
  assert.match(text, /Acme/);
  assert.match(text, /48 hours/);
  assert.match(text, /https:\/\/decentinvoice\.com\/invoices\/7/,
    'APP_URL trailing slash must be trimmed before joining /invoices/<id>');
});

test('hoursOld: 24h exact, future, garbage, missing', () => {
  assert.strictEqual(
    staleDraft.hoursOld(new Date('2026-05-15T00:00:00Z'), new Date('2026-05-16T00:00:00Z')),
    24
  );
  // Future creation date (would be a clock skew artefact)
  assert.strictEqual(
    staleDraft.hoursOld(new Date('2026-05-17T00:00:00Z'), new Date('2026-05-16T00:00:00Z')),
    0
  );
  assert.strictEqual(staleDraft.hoursOld(null), 0);
  assert.strictEqual(staleDraft.hoursOld('not-a-date'), 0);
});

// ---- Orchestrator tests ------------------------------------------------

function fakeDb(rows = []) {
  const stamped = [];
  return {
    rows,
    stamped,
    async getUsersWithStaleDraftForEmail() { return rows; },
    async markStaleDraftEmailSent(userId) {
      stamped.push(userId);
      return { id: userId, stale_draft_email_sent_at: new Date() };
    }
  };
}

test('happy path: sends and stamps', async () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const sends = [];
  const db = fakeDb([staleRow({
    user_id: 42, invoice_id: 7, invoice_number: 'INV-2026-0003',
    email: 'sam@test.io', name: 'Sam'
  })]);
  const summary = await staleDraft.processStaleDraftEmails({
    db,
    sendEmail: async (p) => { sends.push(p); return { ok: true, id: 'em_1' }; },
    now: new Date('2026-05-16T11:00:00Z'),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.found, 1);
  assert.strictEqual(summary.sent, 1);
  assert.strictEqual(summary.errors, 0);
  assert.strictEqual(summary.notConfigured, 0);
  assert.deepStrictEqual(db.stamped, [42], 'must stamp by user_id (not invoice_id)');
  assert.strictEqual(sends.length, 1);
  assert.strictEqual(sends[0].to, 'sam@test.io');
  assert.match(sends[0].subject, /INV-2026-0003/);
  assert.match(sends[0].html, /Hi Sam/);
  assert.match(sends[0].text, /Hi Sam/);
});

test('replyTo precedence: reply_to_email > business_email > email', async () => {
  const sends = [];
  const db = fakeDb([
    staleRow({ user_id: 1, email: 'fallback@x.com', reply_to_email: 'reply@x.com', business_email: 'biz@x.com' }),
    staleRow({ user_id: 2, email: 'fallback@y.com', reply_to_email: null, business_email: 'biz@y.com' }),
    staleRow({ user_id: 3, email: 'fallback@z.com', reply_to_email: null, business_email: null })
  ]);
  await staleDraft.processStaleDraftEmails({
    db,
    sendEmail: async (p) => { sends.push(p); return { ok: true }; },
    now: new Date('2026-05-16T11:00:00Z'),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(sends[0].replyTo, 'reply@x.com', 'reply_to_email wins when set');
  assert.strictEqual(sends[1].replyTo, 'biz@y.com', 'business_email is second choice');
  assert.strictEqual(sends[2].replyTo, 'fallback@z.com', 'falls back to user email last');
});

test('users without email are skipped (defence-in-depth — query already filters them)', async () => {
  const sends = [];
  const db = fakeDb([staleRow({ user_id: 9, email: null })]);
  const summary = await staleDraft.processStaleDraftEmails({
    db,
    sendEmail: async (p) => { sends.push(p); return { ok: true }; },
    now: new Date('2026-05-16T11:00:00Z'),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.sent, 0);
  assert.strictEqual(summary.skipped, 1);
  assert.strictEqual(sends.length, 0);
  assert.deepStrictEqual(db.stamped, []);
});

test('not_configured does NOT stamp DB (next cron pass retries)', async () => {
  const db = fakeDb([staleRow({ user_id: 99, email: 'foo@bar.com' })]);
  const summary = await staleDraft.processStaleDraftEmails({
    db,
    sendEmail: async () => ({ ok: false, reason: 'not_configured' }),
    now: new Date('2026-05-16T11:00:00Z'),
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
    staleRow({ user_id: 1, email: 'a@a.com', invoice_id: 100 }),
    staleRow({ user_id: 2, email: 'b@b.com', invoice_id: 101 })
  ]);
  let i = 0;
  const summary = await staleDraft.processStaleDraftEmails({
    db,
    sendEmail: async (p) => {
      i += 1;
      if (i === 1) throw new Error('SMTP exploded');
      sends.push(p);
      return { ok: true, id: 'em_b' };
    },
    now: new Date('2026-05-16T11:00:00Z'),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.found, 2);
  assert.strictEqual(summary.sent, 1);
  assert.strictEqual(summary.errors, 1);
  assert.deepStrictEqual(db.stamped, [2], 'only the successful user is stamped');
  assert.strictEqual(sends[0].to, 'b@b.com');
});

test('idempotent across runs (filter respects stamp)', async () => {
  const initial = [staleRow({ user_id: 11, email: 'c@c.com' })];
  const stamped = [];
  const db = {
    async getUsersWithStaleDraftForEmail() {
      return initial.filter(u => !stamped.includes(u.user_id));
    },
    async markStaleDraftEmailSent(uid) { stamped.push(uid); return { id: uid }; }
  };
  const sends = [];
  const send = async (p) => { sends.push(p); return { ok: true, id: 'e' }; };
  const r1 = await staleDraft.processStaleDraftEmails({
    db, sendEmail: send, now: new Date('2026-05-16T11:00:00Z'),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(r1.sent, 1);
  const r2 = await staleDraft.processStaleDraftEmails({
    db, sendEmail: send, now: new Date('2026-05-17T11:00:00Z'),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(r2.found, 0, 'cooldown filter excludes the row on the next run');
  assert.strictEqual(r2.sent, 0);
  assert.strictEqual(sends.length, 1, 'one email across both runs');
});

test('top-level query failure → errors=1, no throw', async () => {
  const db = {
    async getUsersWithStaleDraftForEmail() { throw new Error('PG down'); },
    async markStaleDraftEmailSent() { throw new Error('should not be called'); }
  };
  const summary = await staleDraft.processStaleDraftEmails({
    db,
    sendEmail: async () => ({ ok: true }),
    now: new Date(),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.found, 0);
  assert.strictEqual(summary.sent, 0);
  assert.strictEqual(summary.errors, 1);
});

// ---- Cron wiring -------------------------------------------------------

test('startStaleDraftEmailJob blocked under NODE_ENV=test', () => {
  process.env.NODE_ENV = 'test';
  staleDraft.stopStaleDraftEmailJob();
  const r = staleDraft.startStaleDraftEmailJob();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'test_env');
});

test('startStaleDraftEmailJob: cron tick triggers processStaleDraftEmails', async () => {
  staleDraft.stopStaleDraftEmailJob();
  let captured = null;
  const fakeCron = {
    schedule(expr, cb, opts) {
      captured = { expr, cb, opts };
      return { stop() {} };
    }
  };
  const db = fakeDb([staleRow({ user_id: 51, email: 'e@e.com' })]);
  let sendCalls = 0;
  const r = staleDraft.startStaleDraftEmailJob({
    force: true,
    cron: fakeCron,
    schedule: '0 11 * * *',
    db,
    sendEmail: async () => { sendCalls += 1; return { ok: true }; },
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.schedule, '0 11 * * *');
  assert.ok(captured, 'cron.schedule must be called');
  assert.strictEqual(captured.expr, '0 11 * * *');
  assert.strictEqual(captured.opts && captured.opts.timezone, 'UTC');
  await captured.cb();
  assert.strictEqual(sendCalls, 1, 'cron tick must invoke processStaleDraftEmails');
  assert.deepStrictEqual(db.stamped, [51]);
  staleDraft.stopStaleDraftEmailJob();
});

test('startStaleDraftEmailJob refuses double start', () => {
  staleDraft.stopStaleDraftEmailJob();
  const fakeCron = { schedule() { return { stop() {} }; } };
  const r1 = staleDraft.startStaleDraftEmailJob({ force: true, cron: fakeCron });
  assert.strictEqual(r1.ok, true);
  const r2 = staleDraft.startStaleDraftEmailJob({ force: true, cron: fakeCron });
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.reason, 'already_running');
  staleDraft.stopStaleDraftEmailJob();
});

test('DEFAULT_SCHEDULE is 0 11 * * * (11:00 UTC — after trial-nudge at 10:00)', () => {
  assert.strictEqual(staleDraft.DEFAULT_SCHEDULE, '0 11 * * *');
});

// ---- SQL contract on db.getUsersWithStaleDraftForEmail -----------------

test('SQL: query gates on is_seed=false, welcome_email_sent_at IS NOT NULL, cooldown window', async () => {
  // Capture the SQL that the production DB helper issues. The four gates we
  // care about are: status='draft', is_seed=false, age threshold via
  // ($1 * INTERVAL '1 hour'), and the cooldown OR-clause on
  // stale_draft_email_sent_at. The welcome-email gate is the key activation
  // ordering — a brand-new signup must receive the welcome email before any
  // stale-draft nudge.
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
    await db.getUsersWithStaleDraftForEmail(24, 7);
    assert.ok(captured, 'query was issued');
    assert.match(captured.sql, /status\s*=\s*'draft'/i, 'status=draft predicate');
    assert.match(captured.sql, /is_seed\s*=\s*false/i,
      'is_seed=false predicate — must NOT email about the seed sample');
    assert.match(captured.sql, /welcome_email_sent_at\s+IS\s+NOT\s+NULL/i,
      'welcome_email_sent_at gate — activation ordering');
    assert.match(captured.sql, /stale_draft_email_sent_at\s+IS\s+NULL/i,
      'first half of cooldown OR — never-emailed users included');
    assert.match(captured.sql, /stale_draft_email_sent_at\s*<\s*NOW\(\)\s*-\s*\(\$2\s*\*\s*INTERVAL\s*'1 day'\)/i,
      'second half of cooldown OR — cooldown window respected');
    assert.match(captured.sql, /DISTINCT\s+ON\s*\(\s*i\.user_id\s*\)/i,
      'one row per user (oldest draft) — not one row per draft');
    assert.deepStrictEqual(captured.params, [24, 7]);
  } finally {
    realPool.query = originalQuery;
  }
});

test('SQL: input sanitization — non-numeric / negative minAgeHours / cooldownDays fall back to defaults', async () => {
  delete require.cache[require.resolve('../db')];
  const realDbMod = require('../db');
  const realPool = realDbMod.pool;
  const db = realDbMod.db;
  let captured = null;
  const originalQuery = realPool.query.bind(realPool);
  realPool.query = async (sql, params) => { captured = { sql, params }; return { rows: [] }; };
  try {
    await db.getUsersWithStaleDraftForEmail(-5, 'abc');
    assert.deepStrictEqual(captured.params, [24, 7],
      'negative / non-numeric inputs must coerce to safe defaults');
  } finally {
    realPool.query = originalQuery;
  }
});

test('db.markStaleDraftEmailSent: returns null when userId is falsy (no SQL issued)', async () => {
  delete require.cache[require.resolve('../db')];
  const realDbMod = require('../db');
  const realPool = realDbMod.pool;
  const db = realDbMod.db;
  let calls = 0;
  const originalQuery = realPool.query.bind(realPool);
  realPool.query = async () => { calls += 1; return { rows: [] }; };
  try {
    assert.strictEqual(await db.markStaleDraftEmailSent(null), null);
    assert.strictEqual(await db.markStaleDraftEmailSent(0), null);
    assert.strictEqual(await db.markStaleDraftEmailSent(undefined), null);
    assert.strictEqual(calls, 0, 'no SQL must be issued for falsy userId');
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
  console.log(`\n${passed} passed, ${failed} failed (stale-draft-email.test.js)`);
  if (failed > 0) process.exit(1);
})();
