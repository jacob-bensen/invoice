'use strict';

/*
 * Terminal Client-Viewed-But-Unpaid Follow-up Email — 7d+ post-first-followup
 * cron job. Coverage mirrors tests/client-viewed-followup.test.js + the
 * second-stale-draft-email pattern:
 *   1. Subject + HTML + text formatters: XSS escape, day-since-first-followup
 *      floor, CTA URL with/without APP_URL, terminal framing.
 *   2. daysSinceFirstFollowup arithmetic — exact 7d, 12d, garbage, null.
 *   3. Happy path: cohort row → email sent + invoice stamp written.
 *   4. Skips rows without email.
 *   5. not_configured → no stamp, retries next tick.
 *   6. sendEmail throw → counts error, batch continues, no stamp.
 *   7. Magic-login bake-in: per-row mint + cross-row leak guard +
 *      mint-fail soft-fall + ttlMinutes override + safeNextPath compat.
 *   8. Top-level query failure → errors=1, no throw.
 *   9. start...Job blocked under NODE_ENV=test; accepts force.
 *  10. Cron tick wires processSecondClientViewedFollowup.
 *  11. Double start refused.
 *  12. DEFAULT_SCHEDULE shape (14:30 UTC, after first at 14:00).
 *  13. SQL contract on db.getInvoicesForSecondClientViewedFollowup — gates
 *      on status IN ('sent','overdue'), is_seed=false, first_viewed_at IS
 *      NOT NULL + maxDays cap, client_viewed_followup_sent_at >= gap, second
 *      stamp NULL, welcome_email_sent_at NOT NULL, opt-out NULL.
 *  14. db.markSecondClientViewedFollowupSent: falsy-id no-op + NULL guard.
 *
 * Run: NODE_ENV=test node tests/second-client-viewed-followup.test.js
 */

const assert = require('assert');

const followup = require('../jobs/second-client-viewed-followup');
const emailLib = require('../lib/email');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function followupRow(over = {}) {
  return {
    invoice_id: 71,
    user_id: 42,
    invoice_number: 'INV-2026-0003',
    client_name: 'Acme Co',
    invoice_total: '1500.00',
    first_viewed_at: new Date('2026-05-08T00:00:00Z'),
    view_count: 3,
    status: 'sent',
    first_followup_sent_at: new Date('2026-05-09T00:00:00Z'),
    email: 'user@test.io',
    name: 'Sam',
    business_name: 'Studio',
    reply_to_email: null,
    business_email: 'biz@test.io',
    unsubscribe_token: null,
    ...over
  };
}

// ---- Pure formatters ---------------------------------------------------

test('subject: terminal framing, no PII', () => {
  const subj = emailLib.buildSecondClientViewedFollowupSubject(followupRow());
  assert.match(subj, /INV-2026-0003/);
  assert.match(subj, /Still no payment/i);
  assert.match(subj, /last nudge/i, 'subject signals this is the terminal nudge');
  assert.ok(!/Acme/.test(subj),
    'subject must NOT include client_name (inbox-preview privacy)');
});

test('subject: missing invoice_number degrades to "your invoice"', () => {
  const subj = emailLib.buildSecondClientViewedFollowupSubject(
    followupRow({ invoice_number: null })
  );
  assert.match(subj, /your invoice/i);
});

test('html: escapes hostile name + client + threads CTA URL when APP_URL is set', () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const html = emailLib.buildSecondClientViewedFollowupHtml(followupRow({
    name: '<script>alert(1)</script>',
    client_name: 'X & Co <em>',
    invoice_number: 'INV-2026-0003',
    invoice_total: '1500.00',
    first_followup_sent_at: new Date('2026-05-09T00:00:00Z')
  }), new Date('2026-05-16T00:00:00Z'));

  assert.ok(!/<script>alert\(1\)<\/script>/.test(html),
    'raw script must be escaped (XSS defence)');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /X &amp; Co/);
  assert.match(html, /INV-2026-0003/);
  assert.match(html, /\$1500\.00/, 'total must be money-formatted');
  assert.match(html, /7 days/, 'days-since-first-followup anchor in body');
  assert.match(html, /https:\/\/decentinvoice\.com\/invoices\/71/,
    'CTA must deep-link to /invoices/<id>');
  assert.match(html, /one last nudge|terminal reminder|won.t nudge you again/i,
    'copy signals terminal framing');
});

test('html: < 7 days clamps the daysSinceNudge floor to 7 (cohort gate is 7+ days)', () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  // 4 days after the first follow-up — should still floor to 7 days in copy
  // since the cohort itself is gated on 7+ day gap; anything less is query-tier
  // garbage we should never emit "4 days" in customer-facing copy for.
  const html = emailLib.buildSecondClientViewedFollowupHtml(
    followupRow({ first_followup_sent_at: new Date('2026-05-12T00:00:00Z') }),
    new Date('2026-05-16T00:00:00Z')
  );
  assert.match(html, /7 days/);
  assert.ok(!/\b4 days\b/.test(html), 'no "4 days" — copy must floor to 7');
});

test('html: CTA omitted gracefully when APP_URL is unset', () => {
  delete process.env.APP_URL;
  const html = emailLib.buildSecondClientViewedFollowupHtml(
    followupRow(),
    new Date('2026-05-16T00:00:00Z')
  );
  assert.ok(!/<a href=/.test(html),
    'no CTA <a> when APP_URL unset — graceful degradation');
  assert.match(html, /Still no payment|terminal/i, 'body copy remains');
});

test('text: includes greeting, day-since anchor, terminal framing, trimmed APP_URL', () => {
  process.env.APP_URL = 'https://decentinvoice.com/';
  const txt = emailLib.buildSecondClientViewedFollowupText(followupRow({
    name: 'Sam',
    invoice_number: 'INV-2026-0003',
    invoice_total: '1500.00',
    client_name: 'Acme',
    first_followup_sent_at: new Date('2026-05-04T00:00:00Z')
  }), new Date('2026-05-16T00:00:00Z'));

  assert.match(txt, /Hi Sam,/);
  assert.match(txt, /Acme/);
  assert.match(txt, /INV-2026-0003/);
  assert.match(txt, /\$1500\.00/);
  assert.match(txt, /12 days/);
  assert.match(txt, /https:\/\/decentinvoice\.com\/invoices\/71/);
  assert.match(txt, /Terminal reminder|won.t nudge you again/i);
});

test('text: CTA URL omitted when APP_URL is unset', () => {
  delete process.env.APP_URL;
  const txt = emailLib.buildSecondClientViewedFollowupText(
    followupRow(),
    new Date('2026-05-16T00:00:00Z')
  );
  assert.ok(!/https?:\/\//.test(txt),
    'no URLs in body when APP_URL is unset — graceful degradation');
});

// ---- daysSinceFirstFollowup arithmetic ---------------------------------

test('daysSinceFirstFollowup: exact 7d=7; 12d=12; null=0; garbage=0', () => {
  const ref = new Date('2026-05-16T12:00:00Z');
  assert.strictEqual(emailLib.daysSinceFirstFollowup(new Date('2026-05-09T12:00:00Z'), ref), 7);
  assert.strictEqual(emailLib.daysSinceFirstFollowup(new Date('2026-05-04T12:00:00Z'), ref), 12);
  assert.strictEqual(emailLib.daysSinceFirstFollowup(null), 0);
  assert.strictEqual(emailLib.daysSinceFirstFollowup('not-a-date'), 0);
});

// ---- Orchestrator tests ------------------------------------------------

function fakeDb(rows = []) {
  const stamped = [];
  return {
    rows,
    stamped,
    async getInvoicesForSecondClientViewedFollowup() { return rows; },
    async markSecondClientViewedFollowupSent(invoiceId) {
      stamped.push(invoiceId);
      return { id: invoiceId, second_client_viewed_followup_sent_at: new Date() };
    }
  };
}

test('happy path: sends and stamps by invoice_id', async () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const sends = [];
  const db = fakeDb([followupRow({
    invoice_id: 71, user_id: 42, invoice_number: 'INV-2026-0003',
    email: 'sam@test.io', name: 'Sam'
  })]);
  const summary = await followup.processSecondClientViewedFollowup({
    db,
    sendEmail: async (p) => { sends.push(p); return { ok: true, id: 'em_1' }; },
    now: new Date('2026-05-16T11:00:00Z'),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.found, 1);
  assert.strictEqual(summary.sent, 1);
  assert.strictEqual(summary.errors, 0);
  assert.strictEqual(summary.notConfigured, 0);
  assert.deepStrictEqual(db.stamped, [71],
    'stamp by invoice_id (each unpaid-viewed invoice gets independent tracking)');
  assert.strictEqual(sends.length, 1);
  assert.strictEqual(sends[0].to, 'sam@test.io');
  assert.match(sends[0].subject, /INV-2026-0003/);
  assert.match(sends[0].html, /Hi Sam/);
  assert.match(sends[0].text, /Hi Sam/);
});

test('magic-login: mints once per cohort row, bakes URL, no cross-user leak', async () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const sends = [];
  const mintCalls = [];
  const db = fakeDb([
    followupRow({ invoice_id: 101, user_id: 7, email: 'a@a.com', name: 'A' }),
    followupRow({ invoice_id: 102, user_id: 8, email: 'b@b.com', name: 'B' })
  ]);
  await followup.processSecondClientViewedFollowup({
    db,
    sendEmail: async (p) => { sends.push(p); return { ok: true, id: 'em' }; },
    mintMagicLoginToken: async (_db, userId, opts) => {
      mintCalls.push({ userId, opts });
      return { ok: true, url: `https://decentinvoice.com/auth/magic/tok-${userId}`, ttlMinutes: opts.ttlMinutes };
    },
    now: new Date('2026-05-16T11:00:00Z'),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(mintCalls.length, 2);
  assert.strictEqual(mintCalls[0].userId, 7);
  assert.strictEqual(mintCalls[0].opts.ttlMinutes, followup.FOLLOWUP_TTL_MINUTES);
  assert.strictEqual(mintCalls[1].userId, 8);
  assert.match(sends[0].html, /\/auth\/magic\/tok-7\?next=\/invoices\/101/);
  assert.match(sends[1].html, /\/auth\/magic\/tok-8\?next=\/invoices\/102/);
  assert.ok(!/\/auth\/magic\/tok-7/.test(sends[1].html),
    'user 8 must NOT receive user 7 token');
  assert.ok(!/next=\/invoices\/102/.test(sends[0].html),
    'user 7 email must NOT deep-link to user 8 invoice');
});

test('magic-login: mint failure falls back to plain CTA, email still ships, stamp lands', async () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const sends = [];
  const warns = [];
  const db = fakeDb([followupRow({ invoice_id: 7, user_id: 99, email: 'q@q.com', name: 'Q' })]);
  const summary = await followup.processSecondClientViewedFollowup({
    db,
    sendEmail: async (p) => { sends.push(p); return { ok: true }; },
    mintMagicLoginToken: async () => ({ ok: false, reason: 'db_error', error: 'PG hiccup' }),
    now: new Date('2026-05-16T11:00:00Z'),
    log: { error: () => {}, warn: (...a) => warns.push(a), log: () => {} }
  });
  assert.strictEqual(summary.sent, 1, 'mint failure does NOT block the send');
  assert.deepStrictEqual(db.stamped, [7]);
  assert.match(sends[0].html, /https:\/\/decentinvoice\.com\/invoices\/7/);
  assert.ok(!/\/auth\/magic\//.test(sends[0].html));
  assert.ok(warns.some(args => /magic-link mint skipped/.test(args.join(' '))));
});

test('magic-login: mint throws → soft-fails, email still ships', async () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const sends = [];
  const db = fakeDb([followupRow({ invoice_id: 31, user_id: 5, email: 'z@z.com' })]);
  const summary = await followup.processSecondClientViewedFollowup({
    db,
    sendEmail: async (p) => { sends.push(p); return { ok: true }; },
    mintMagicLoginToken: async () => { throw new Error('mint exploded'); },
    now: new Date('2026-05-16T11:00:00Z'),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.sent, 1);
  assert.strictEqual(summary.errors, 0,
    'mint throw is soft-fail — must not count as send error');
  assert.match(sends[0].html, /https:\/\/decentinvoice\.com\/invoices\/31/);
  assert.ok(!/\/auth\/magic\//.test(sends[0].html));
});

test('magic-login: ttlMinutes opt overrides FOLLOWUP_TTL_MINUTES on mint call', async () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  let capturedTtl = null;
  const db = fakeDb([followupRow({ invoice_id: 9, user_id: 1, email: 'a@a.com' })]);
  await followup.processSecondClientViewedFollowup({
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

test('magic-login: ?next= deep-link passes lib/magic-login.safeNextPath validation', () => {
  delete require.cache[require.resolve('../lib/magic-login')];
  const { safeNextPath } = require('../lib/magic-login');
  process.env.APP_URL = 'https://decentinvoice.com';
  const html = emailLib.buildSecondClientViewedFollowupHtml(
    followupRow({ invoice_id: 42 }),
    new Date('2026-05-16T11:00:00Z'),
    { magicLoginUrl: 'https://decentinvoice.com/auth/magic/tok' }
  );
  const m = /next=(\/invoices\/\d+)/.exec(html);
  assert.ok(m, 'CTA must carry ?next=/invoices/<id>');
  assert.strictEqual(safeNextPath(m[1]), m[1],
    'emitted next= path must be accepted by safeNextPath');
});

test('replyTo precedence: reply_to_email > business_email > email', async () => {
  const sends = [];
  const db = fakeDb([
    followupRow({ invoice_id: 1, user_id: 1, email: 'fb@x.com', reply_to_email: 'reply@x.com', business_email: 'biz@x.com' }),
    followupRow({ invoice_id: 2, user_id: 2, email: 'fb@y.com', reply_to_email: null, business_email: 'biz@y.com' }),
    followupRow({ invoice_id: 3, user_id: 3, email: 'fb@z.com', reply_to_email: null, business_email: null })
  ]);
  await followup.processSecondClientViewedFollowup({
    db,
    sendEmail: async (p) => { sends.push(p); return { ok: true }; },
    now: new Date('2026-05-16T11:00:00Z'),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(sends[0].replyTo, 'reply@x.com');
  assert.strictEqual(sends[1].replyTo, 'biz@y.com');
  assert.strictEqual(sends[2].replyTo, 'fb@z.com');
});

test('rows without email are skipped (defence-in-depth)', async () => {
  const sends = [];
  const db = fakeDb([followupRow({ invoice_id: 9, user_id: 9, email: null })]);
  const summary = await followup.processSecondClientViewedFollowup({
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

test('not_configured does NOT stamp DB (next pass retries)', async () => {
  const db = fakeDb([followupRow({ invoice_id: 11, user_id: 99, email: 'foo@bar.com' })]);
  const summary = await followup.processSecondClientViewedFollowup({
    db,
    sendEmail: async () => ({ ok: false, reason: 'not_configured' }),
    now: new Date('2026-05-16T11:00:00Z'),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.found, 1);
  assert.strictEqual(summary.sent, 0);
  assert.strictEqual(summary.notConfigured, 1);
  assert.deepStrictEqual(db.stamped, [],
    'not_configured must leave the stamp NULL so the next tick retries');
});

test('sendEmail throw → error count incremented, batch continues, no stamp', async () => {
  const db = fakeDb([
    followupRow({ invoice_id: 1, user_id: 1, email: 'a@a.com' }),
    followupRow({ invoice_id: 2, user_id: 2, email: 'b@b.com' })
  ]);
  let calls = 0;
  const summary = await followup.processSecondClientViewedFollowup({
    db,
    sendEmail: async () => {
      calls += 1;
      if (calls === 1) throw new Error('SMTP timeout');
      return { ok: true };
    },
    now: new Date('2026-05-16T11:00:00Z'),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.found, 2);
  assert.strictEqual(summary.sent, 1, 'second row still ships');
  assert.strictEqual(summary.errors, 1);
  assert.deepStrictEqual(db.stamped, [2], 'only successful row is stamped');
});

test('top-level query failure → errors=1, no throw', async () => {
  const db = {
    async getInvoicesForSecondClientViewedFollowup() { throw new Error('PG down'); },
    async markSecondClientViewedFollowupSent() { return null; }
  };
  const summary = await followup.processSecondClientViewedFollowup({
    db,
    sendEmail: async () => ({ ok: true }),
    now: new Date(),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.errors, 1);
  assert.strictEqual(summary.found, 0);
  assert.strictEqual(summary.sent, 0);
});

// ---- Cron wiring -------------------------------------------------------

test('startSecondClientViewedFollowupJob blocked under NODE_ENV=test', () => {
  process.env.NODE_ENV = 'test';
  followup.stopSecondClientViewedFollowupJob();
  const r = followup.startSecondClientViewedFollowupJob();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'test_env');
});

test('startSecondClientViewedFollowupJob: cron tick triggers process...', async () => {
  followup.stopSecondClientViewedFollowupJob();
  let captured = null;
  const fakeCron = {
    schedule(expr, cb, opts) {
      captured = { expr, cb, opts };
      return { stop() {} };
    }
  };
  const db = fakeDb([followupRow({ invoice_id: 51, user_id: 51, email: 'e@e.com' })]);
  let sendCalls = 0;
  const r = followup.startSecondClientViewedFollowupJob({
    force: true,
    cron: fakeCron,
    schedule: '30 14 * * *',
    db,
    sendEmail: async () => { sendCalls += 1; return { ok: true }; },
    mintMagicLoginToken: async () => ({ ok: true, url: 'https://x/auth/magic/t' }),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.schedule, '30 14 * * *');
  assert.ok(captured, 'cron.schedule called');
  assert.strictEqual(captured.expr, '30 14 * * *');
  assert.strictEqual(captured.opts && captured.opts.timezone, 'UTC');
  await captured.cb();
  assert.strictEqual(sendCalls, 1);
  assert.deepStrictEqual(db.stamped, [51]);
  followup.stopSecondClientViewedFollowupJob();
});

test('startSecondClientViewedFollowupJob refuses double start', () => {
  followup.stopSecondClientViewedFollowupJob();
  const fakeCron = { schedule() { return { stop() {} }; } };
  const r1 = followup.startSecondClientViewedFollowupJob({ force: true, cron: fakeCron });
  assert.strictEqual(r1.ok, true);
  const r2 = followup.startSecondClientViewedFollowupJob({ force: true, cron: fakeCron });
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.reason, 'already_running');
  followup.stopSecondClientViewedFollowupJob();
});

test('DEFAULT_SCHEDULE is 30 14 * * * (14:30 UTC — 30 min after first follow-up at 14:00)', () => {
  assert.strictEqual(followup.DEFAULT_SCHEDULE, '30 14 * * *');
});

// ---- SQL contract on db.getInvoicesForSecondClientViewedFollowup -------

test('SQL: query gates on status, is_seed, first_followup gap, maxDays cap, second stamp NULL', async () => {
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
    await db.getInvoicesForSecondClientViewedFollowup(7, 30);
    assert.ok(captured, 'query was issued');
    assert.match(captured.sql, /status\s+IN\s*\(\s*'sent'\s*,\s*'overdue'\s*\)/i);
    assert.match(captured.sql, /is_seed\s*=\s*false/i);
    assert.match(captured.sql, /first_viewed_at\s+IS\s+NOT\s+NULL/i);
    assert.match(captured.sql, /first_viewed_at\s*>\s*NOW\(\)\s*-\s*\(\$2\s*\*\s*INTERVAL\s*'1 day'\)/i,
      'max-age predicate bounds cohort on first_viewed_at');
    assert.match(captured.sql, /client_viewed_followup_sent_at\s+IS\s+NOT\s+NULL/i,
      'first follow-up must have fired');
    assert.match(captured.sql, /client_viewed_followup_sent_at\s*<=\s*NOW\(\)\s*-\s*\(\$1\s*\*\s*INTERVAL\s*'1 day'\)/i,
      'first follow-up must be N days old');
    assert.match(captured.sql, /second_client_viewed_followup_sent_at\s+IS\s+NULL/i,
      'terminal stamp NULL — one-shot per invoice');
    assert.match(captured.sql, /welcome_email_sent_at\s+IS\s+NOT\s+NULL/i,
      'activation ordering');
    assert.match(captured.sql, /lifecycle_emails_opted_out_at\s+IS\s+NULL/i,
      'opt-out gate');
    assert.match(captured.sql, /ORDER\s+BY\s+i\.client_viewed_followup_sent_at\s+ASC/i,
      'oldest first-followup first — fairness + peak conversion-likelihood');
    assert.match(captured.sql, /LIMIT\s+500/i);
    assert.deepStrictEqual(captured.params, [7, 30]);
  } finally {
    realPool.query = originalQuery;
  }
});

test('SQL: input sanitization — non-numeric / negative inputs fall back to defaults (7, 30)', async () => {
  delete require.cache[require.resolve('../db')];
  const realDbMod = require('../db');
  const realPool = realDbMod.pool;
  const db = realDbMod.db;
  let captured = null;
  const originalQuery = realPool.query.bind(realPool);
  realPool.query = async (sql, params) => { captured = { sql, params }; return { rows: [] }; };
  try {
    await db.getInvoicesForSecondClientViewedFollowup(-3, 'abc');
    assert.deepStrictEqual(captured.params, [7, 30],
      'negative / non-numeric inputs must coerce to safe defaults');
  } finally {
    realPool.query = originalQuery;
  }
});

test('db.markSecondClientViewedFollowupSent: returns null when invoiceId is falsy (no SQL)', async () => {
  delete require.cache[require.resolve('../db')];
  const realDbMod = require('../db');
  const realPool = realDbMod.pool;
  const db = realDbMod.db;
  let calls = 0;
  const originalQuery = realPool.query.bind(realPool);
  realPool.query = async () => { calls += 1; return { rows: [] }; };
  try {
    assert.strictEqual(await db.markSecondClientViewedFollowupSent(null), null);
    assert.strictEqual(await db.markSecondClientViewedFollowupSent(0), null);
    assert.strictEqual(await db.markSecondClientViewedFollowupSent(undefined), null);
    assert.strictEqual(calls, 0, 'no SQL must be issued for falsy invoiceId');
  } finally {
    realPool.query = originalQuery;
  }
});

test('db.markSecondClientViewedFollowupSent: UPDATE re-asserts NULL guard', async () => {
  delete require.cache[require.resolve('../db')];
  const realDbMod = require('../db');
  const realPool = realDbMod.pool;
  const db = realDbMod.db;
  let captured = null;
  const originalQuery = realPool.query.bind(realPool);
  realPool.query = async (sql, params) => { captured = { sql, params }; return { rows: [{ id: 71 }] }; };
  try {
    await db.markSecondClientViewedFollowupSent(71);
    assert.match(captured.sql, /UPDATE\s+invoices/i);
    assert.match(captured.sql, /SET\s+second_client_viewed_followup_sent_at\s*=\s*NOW\(\)/i);
    assert.match(captured.sql, /WHERE\s+id\s*=\s*\$1/i);
    assert.match(captured.sql, /AND\s+second_client_viewed_followup_sent_at\s+IS\s+NULL/i,
      'NULL guard re-asserted — concurrent ticks cannot double-send');
    assert.deepStrictEqual(captured.params, [71]);
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
  console.log(`\n${passed} passed, ${failed} failed (second-client-viewed-followup.test.js)`);
  if (failed > 0) process.exit(1);
})();
