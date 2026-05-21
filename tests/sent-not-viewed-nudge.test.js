'use strict';

/*
 * Sent-but-never-viewed nudge — 72h+ post-share-intent cron job.
 *
 * Coverage mirrors tests/client-viewed-followup.test.js:
 *   1. Subject + HTML + text formatters: XSS escape, day-since-sent anchor,
 *      CTA URL with/without APP_URL, three-bullet "why didn't they open it"
 *      diagnostic copy that distinguishes this email from client-viewed
 *      (which assumes they DID see it).
 *   2. daysSinceSent() arithmetic — exact 72h, 5d, garbage.
 *   3. Happy path: sent-but-not-viewed row → email + invoice stamp.
 *   4. Skips rows without an email (defence-in-depth).
 *   5. not_configured (RESEND key unset) → no stamp, retries next tick.
 *   6. sendEmail throw → counts an error, batch continues, no stamp.
 *   7. Magic-login bake-in: per-row mint + cross-row leak guard + mint-fail
 *      soft-fall + ttlMinutes override + safeNextPath compat.
 *   8. Top-level query failure → errors=1, no throw.
 *   9. startSentNotViewedNudgeJob blocked under NODE_ENV=test; accepts force.
 *  10. Cron tick wires processSentNotViewedNudge through correctly.
 *  11. Double start refused.
 *  12. DEFAULT_SCHEDULE shape.
 *  13. SQL contract on db.getInvoicesForSentNotViewedNudge — the production
 *      query gates on status IN ('sent','overdue'), is_seed=false,
 *      first_viewed_at IS NULL, sent_via_share_intent_at IS NOT NULL with
 *      min/max age window, sent_not_viewed_nudge_sent_at IS NULL cooldown,
 *      and welcome_email_sent_at IS NOT NULL.
 *
 * Run: NODE_ENV=test node tests/sent-not-viewed-nudge.test.js
 */

const assert = require('assert');

const job = require('../jobs/sent-not-viewed-nudge');
const emailLib = require('../lib/email');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function nudgeRow(over = {}) {
  return {
    invoice_id: 71,
    user_id: 42,
    invoice_number: 'INV-2026-0003',
    client_name: 'Acme Co',
    client_email: 'client@acme.test',
    invoice_total: '1500.00',
    sent_at: new Date('2026-05-13T00:00:00Z'),
    status: 'sent',
    email: 'user@test.io',
    name: 'Sam',
    business_name: 'Studio',
    reply_to_email: null,
    business_email: 'biz@test.io',
    ...over
  };
}

// ---- Pure formatters ---------------------------------------------------

test('subject: includes client name + invoice number + "hasn\'t opened" framing', () => {
  const subj = emailLib.buildSentNotViewedNudgeSubject(nudgeRow());
  assert.match(subj, /Acme Co/);
  assert.match(subj, /INV-2026-0003/);
  assert.match(subj, /hasn't opened/);
  assert.match(subj, /try another channel/i);
});

test('subject: missing invoice_number + client_name degrade gracefully', () => {
  const subj = emailLib.buildSentNotViewedNudgeSubject(
    nudgeRow({ invoice_number: null, client_name: null })
  );
  assert.match(subj, /your client hasn't opened your invoice/i);
});

test('html: escapes hostile name + client + threads CTA URL when APP_URL is set', () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const html = emailLib.buildSentNotViewedNudgeHtml(nudgeRow({
    name: '<script>alert(1)</script>',
    client_name: 'X & Co <em>',
    invoice_number: 'INV-2026-0003',
    invoice_total: '1500.00',
    sent_at: new Date('2026-05-13T00:00:00Z')
  }), new Date('2026-05-16T00:00:00Z'));

  assert.ok(!/<script>alert\(1\)<\/script>/.test(html),
    'raw script must be escaped (XSS defence)');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /X &amp; Co/);
  assert.match(html, /INV-2026-0003/);
  assert.match(html, /\$1500\.00/, 'total must be money-formatted');
  assert.match(html, /3 days ago/, 'days-since-sent anchor inline in body');
  assert.match(html, /https:\/\/decentinvoice\.com\/invoices\/71/,
    'CTA must deep-link to /invoices/<id>');
  assert.match(html, /re-share/i, 'CTA copy includes "re-share"');
  assert.match(html, /spam/i, 'diagnostic bullet: spam folder');
  assert.match(html, /stale phone/i, 'diagnostic bullet: stale contact');
  assert.match(html, /didn't tap/i, 'diagnostic bullet: opened but didn\'t click');
});

test('html: copy framing is silent-failure (not "they saw it" — distinguish from client-viewed-followup)', () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const html = emailLib.buildSentNotViewedNudgeHtml(
    nudgeRow(),
    new Date('2026-05-16T00:00:00Z')
  );
  assert.match(html, /zero opens/i,
    'must surface the silent-failure signal explicitly');
  // Defensive: the client-viewed-followup says "opened ... about N days ago".
  // This one must NEVER claim the client opened it.
  assert.ok(!/opened it about/i.test(html),
    'must NOT say the client opened the invoice');
});

test('html: CTA omitted gracefully when APP_URL is unset (no broken-link button)', () => {
  delete process.env.APP_URL;
  const html = emailLib.buildSentNotViewedNudgeHtml(
    nudgeRow(),
    new Date('2026-05-16T00:00:00Z')
  );
  assert.ok(!/<a href=/.test(html),
    'no CTA <a> when APP_URL is unset — graceful degradation');
  assert.match(html, /hasn't opened/i, 'body copy remains');
});

test('text: includes greeting, day anchor, client + CTA URL with trimmed trailing slash', () => {
  process.env.APP_URL = 'https://decentinvoice.com/';
  const txt = emailLib.buildSentNotViewedNudgeText(nudgeRow({
    name: 'Sam',
    invoice_number: 'INV-2026-0003',
    invoice_total: '1500.00',
    client_name: 'Acme',
    sent_at: new Date('2026-05-12T00:00:00Z')
  }), new Date('2026-05-16T00:00:00Z'));

  assert.match(txt, /Hi Sam,/);
  assert.match(txt, /Acme/);
  assert.match(txt, /INV-2026-0003/);
  assert.match(txt, /\$1500\.00/);
  assert.match(txt, /4 days ago/);
  assert.match(txt, /https:\/\/decentinvoice\.com\/invoices\/71/);
});

test('text: CTA URL omitted when APP_URL is unset', () => {
  delete process.env.APP_URL;
  const txt = emailLib.buildSentNotViewedNudgeText(
    nudgeRow(),
    new Date('2026-05-16T00:00:00Z')
  );
  assert.ok(!/https?:\/\//.test(txt),
    'no URLs in body when APP_URL is unset — graceful degradation');
});

// ---- daysSinceSent arithmetic ------------------------------------------

test('daysSinceSent: exact 72h is 3 days; 5 days is 5; null is 0; garbage is 0', () => {
  const ref = new Date('2026-05-16T12:00:00Z');
  assert.strictEqual(emailLib.daysSinceSent(new Date('2026-05-13T12:00:00Z'), ref), 3);
  assert.strictEqual(emailLib.daysSinceSent(new Date('2026-05-11T12:00:00Z'), ref), 5);
  assert.strictEqual(emailLib.daysSinceSent(null), 0);
  assert.strictEqual(emailLib.daysSinceSent('not-a-date'), 0);
});

test('html: < 3 day shows "3 days" floor (subject/copy never says "0 days")', () => {
  // 50h after share is < 3 days. Copy clamps to "3 days" minimum since the
  // cohort itself is gated 72h+ — anything less would be query-tier garbage.
  process.env.APP_URL = 'https://decentinvoice.com';
  const html = emailLib.buildSentNotViewedNudgeHtml(
    nudgeRow({ sent_at: new Date('2026-05-14T10:00:00Z') }),
    new Date('2026-05-16T12:00:00Z')
  );
  assert.match(html, /3 days ago/,
    'copy must not show "1 day" or "0 days" — minimum floor is 3 days');
});

// ---- Orchestrator tests ------------------------------------------------

function fakeDb(rows = []) {
  const stamped = [];
  return {
    rows,
    stamped,
    async getInvoicesForSentNotViewedNudge() { return rows; },
    async markSentNotViewedNudgeSent(invoiceId) {
      stamped.push(invoiceId);
      return { id: invoiceId, sent_not_viewed_nudge_sent_at: new Date() };
    }
  };
}

test('happy path: sends and stamps by invoice_id', async () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const sends = [];
  const db = fakeDb([nudgeRow({
    invoice_id: 71, user_id: 42, invoice_number: 'INV-2026-0003',
    email: 'sam@test.io', name: 'Sam'
  })]);
  const summary = await job.processSentNotViewedNudge({
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
    'must stamp by invoice_id (per-invoice cooldown — multiple unsent invoices each tracked separately)');
  assert.strictEqual(sends.length, 1);
  assert.strictEqual(sends[0].to, 'sam@test.io');
  assert.match(sends[0].subject, /INV-2026-0003/);
  assert.match(sends[0].html, /Hi Sam/);
  assert.match(sends[0].text, /Hi Sam/);
});

test('magic-login: mints once per cohort row + bakes the URL into the sent email', async () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const sends = [];
  const mintCalls = [];
  const db = fakeDb([
    nudgeRow({ invoice_id: 101, user_id: 7, email: 'a@a.com', name: 'A' }),
    nudgeRow({ invoice_id: 102, user_id: 8, email: 'b@b.com', name: 'B' })
  ]);
  await job.processSentNotViewedNudge({
    db,
    sendEmail: async (p) => { sends.push(p); return { ok: true, id: 'em' }; },
    mintMagicLoginToken: async (_db, userId, opts) => {
      mintCalls.push({ userId, opts });
      return { ok: true, url: `https://decentinvoice.com/auth/magic/tok-${userId}`, ttlMinutes: opts.ttlMinutes };
    },
    now: new Date('2026-05-16T11:00:00Z'),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(mintCalls.length, 2, 'mint called exactly once per cohort row');
  assert.strictEqual(mintCalls[0].userId, 7,
    'mint must use row.user_id (token belongs to the freelancer)');
  assert.strictEqual(mintCalls[0].opts.ttlMinutes, job.NUDGE_TTL_MINUTES,
    'mint uses the 7-day TTL');
  assert.strictEqual(mintCalls[1].userId, 8);
  assert.match(sends[0].html, /\/auth\/magic\/tok-7\?next=\/invoices\/101/,
    'user 7 receives the user 7 magic URL deep-linking to invoice 101');
  assert.match(sends[1].html, /\/auth\/magic\/tok-8\?next=\/invoices\/102/,
    'user 8 receives the user 8 magic URL deep-linking to invoice 102 (no cross-user token leak)');
  assert.ok(!/\/auth\/magic\/tok-7/.test(sends[1].html),
    'user 8 must NOT receive user 7 token');
  assert.ok(!/next=\/invoices\/102/.test(sends[0].html),
    'user 7 email must NOT deep-link to user 8 invoice');
});

test('magic-login: mint failure falls back to plain CTA + email still ships + stamp still lands', async () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const sends = [];
  const warns = [];
  const db = fakeDb([nudgeRow({ invoice_id: 7, user_id: 99, email: 'q@q.com', name: 'Q' })]);
  const summary = await job.processSentNotViewedNudge({
    db,
    sendEmail: async (p) => { sends.push(p); return { ok: true, id: 'em_99' }; },
    mintMagicLoginToken: async () => ({ ok: false, reason: 'db_error', error: 'PG hiccup' }),
    now: new Date('2026-05-16T11:00:00Z'),
    log: { error: () => {}, warn: (...a) => warns.push(a), log: () => {} }
  });
  assert.strictEqual(summary.sent, 1, 'mint failure does NOT block the send');
  assert.deepStrictEqual(db.stamped, [7], 'stamp lands on send success regardless of mint outcome');
  assert.match(sends[0].html, /https:\/\/decentinvoice\.com\/invoices\/7/,
    'falls back to the plain /invoices/<id> CTA');
  assert.ok(!/\/auth\/magic\//.test(sends[0].html),
    'no magic URL in the body when mint failed');
  assert.ok(warns.some(args => /magic-link mint skipped/.test(args.join(' '))),
    'warn logged for operator visibility');
});

test('magic-login: mint throws → soft-fails to plain CTA + email still ships', async () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const sends = [];
  const db = fakeDb([nudgeRow({ invoice_id: 31, user_id: 5, email: 'z@z.com' })]);
  const summary = await job.processSentNotViewedNudge({
    db,
    sendEmail: async (p) => { sends.push(p); return { ok: true }; },
    mintMagicLoginToken: async () => { throw new Error('mint exploded'); },
    now: new Date('2026-05-16T11:00:00Z'),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.sent, 1);
  assert.strictEqual(summary.errors, 0,
    'mint throw is a soft-fail — must not count as a send error');
  assert.match(sends[0].html, /https:\/\/decentinvoice\.com\/invoices\/31/);
  assert.ok(!/\/auth\/magic\//.test(sends[0].html));
});

test('magic-login: ttlMinutes opt overrides NUDGE_TTL_MINUTES on the mint call', async () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  let capturedTtl = null;
  const db = fakeDb([nudgeRow({ invoice_id: 9, user_id: 1, email: 'a@a.com' })]);
  await job.processSentNotViewedNudge({
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
  // The auth/magic consume route gates ?next= through safeNextPath. If the
  // emitted deep-link doesn't pass that filter, the CTA silently degrades to
  // /dashboard — losing the whole point of baking in the invoice id.
  delete require.cache[require.resolve('../lib/magic-login')];
  const { safeNextPath } = require('../lib/magic-login');
  process.env.APP_URL = 'https://decentinvoice.com';
  const html = emailLib.buildSentNotViewedNudgeHtml(
    nudgeRow({ invoice_id: 42 }),
    new Date('2026-05-16T11:00:00Z'),
    { magicLoginUrl: 'https://decentinvoice.com/auth/magic/tok' }
  );
  const m = /next=(\/invoices\/\d+)/.exec(html);
  assert.ok(m, 'CTA must carry a ?next=/invoices/<id> deep-link');
  assert.strictEqual(safeNextPath(m[1]), m[1],
    'the emitted next= path must be accepted by safeNextPath');
});

test('replyTo precedence: reply_to_email > business_email > email', async () => {
  const sends = [];
  const db = fakeDb([
    nudgeRow({ invoice_id: 1, user_id: 1, email: 'fallback@x.com', reply_to_email: 'reply@x.com', business_email: 'biz@x.com' }),
    nudgeRow({ invoice_id: 2, user_id: 2, email: 'fallback@y.com', reply_to_email: null, business_email: 'biz@y.com' }),
    nudgeRow({ invoice_id: 3, user_id: 3, email: 'fallback@z.com', reply_to_email: null, business_email: null })
  ]);
  await job.processSentNotViewedNudge({
    db,
    sendEmail: async (p) => { sends.push(p); return { ok: true }; },
    now: new Date('2026-05-16T11:00:00Z'),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(sends[0].replyTo, 'reply@x.com', 'reply_to_email wins when set');
  assert.strictEqual(sends[1].replyTo, 'biz@y.com', 'business_email is second choice');
  assert.strictEqual(sends[2].replyTo, 'fallback@z.com', 'falls back to user email last');
});

test('rows without email are skipped (defence-in-depth — query already filters them)', async () => {
  const sends = [];
  const db = fakeDb([nudgeRow({ invoice_id: 9, user_id: 9, email: null })]);
  const summary = await job.processSentNotViewedNudge({
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
  const db = fakeDb([nudgeRow({ invoice_id: 11, user_id: 99, email: 'foo@bar.com' })]);
  const summary = await job.processSentNotViewedNudge({
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
    nudgeRow({ invoice_id: 1, user_id: 1, email: 'a@a.com' }),
    nudgeRow({ invoice_id: 2, user_id: 2, email: 'b@b.com' })
  ]);
  let calls = 0;
  const summary = await job.processSentNotViewedNudge({
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
  assert.deepStrictEqual(db.stamped, [2], 'only the successful row is stamped');
});

test('top-level query failure → errors=1, no throw', async () => {
  const db = {
    async getInvoicesForSentNotViewedNudge() { throw new Error('PG down'); },
    async markSentNotViewedNudgeSent() { return null; }
  };
  const summary = await job.processSentNotViewedNudge({
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

test('startSentNotViewedNudgeJob blocked under NODE_ENV=test', () => {
  process.env.NODE_ENV = 'test';
  job.stopSentNotViewedNudgeJob();
  const r = job.startSentNotViewedNudgeJob();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'test_env');
});

test('startSentNotViewedNudgeJob: cron tick triggers processSentNotViewedNudge', async () => {
  job.stopSentNotViewedNudgeJob();
  let captured = null;
  const fakeCron = {
    schedule(expr, cb, opts) {
      captured = { expr, cb, opts };
      return { stop() {} };
    }
  };
  const db = fakeDb([nudgeRow({ invoice_id: 51, user_id: 51, email: 'e@e.com' })]);
  let sendCalls = 0;
  const r = job.startSentNotViewedNudgeJob({
    force: true,
    cron: fakeCron,
    schedule: '0 15 * * *',
    db,
    sendEmail: async () => { sendCalls += 1; return { ok: true }; },
    mintMagicLoginToken: async () => ({ ok: true, url: 'https://x/auth/magic/t' }),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.schedule, '0 15 * * *');
  assert.ok(captured, 'cron.schedule must be called');
  assert.strictEqual(captured.expr, '0 15 * * *');
  assert.strictEqual(captured.opts && captured.opts.timezone, 'UTC');
  await captured.cb();
  assert.strictEqual(sendCalls, 1, 'cron tick must invoke processSentNotViewedNudge');
  assert.deepStrictEqual(db.stamped, [51]);
  job.stopSentNotViewedNudgeJob();
});

test('startSentNotViewedNudgeJob refuses double start', () => {
  job.stopSentNotViewedNudgeJob();
  const fakeCron = { schedule() { return { stop() {} }; } };
  const r1 = job.startSentNotViewedNudgeJob({ force: true, cron: fakeCron });
  assert.strictEqual(r1.ok, true);
  const r2 = job.startSentNotViewedNudgeJob({ force: true, cron: fakeCron });
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.reason, 'already_running');
  job.stopSentNotViewedNudgeJob();
});

test('DEFAULT_SCHEDULE is 0 15 * * * (15:00 UTC — after client-viewed-followup at 14:00)', () => {
  assert.strictEqual(job.DEFAULT_SCHEDULE, '0 15 * * *');
});

// ---- SQL contract on db.getInvoicesForSentNotViewedNudge ----------------

test('SQL: query gates on status, is_seed, first_viewed_at IS NULL, share-intent anchor, cooldown', async () => {
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
    await db.getInvoicesForSentNotViewedNudge(72, 14);
    assert.ok(captured, 'query was issued');
    assert.match(captured.sql, /status\s+IN\s*\(\s*'sent'\s*,\s*'overdue'\s*\)/i,
      'status predicate covers sent + overdue (NOT paid, NOT draft)');
    assert.match(captured.sql, /is_seed\s*=\s*false/i,
      'is_seed=false predicate — never email about the seed sample');
    assert.match(captured.sql, /first_viewed_at\s+IS\s+NULL/i,
      'first_viewed_at IS NULL — the silent-failure cohort by definition');
    assert.match(captured.sql, /sent_via_share_intent_at\s+IS\s+NOT\s+NULL/i,
      'sent_via_share_intent_at IS NOT NULL — anchor on unambiguous freelancer intent');
    assert.match(captured.sql, /sent_via_share_intent_at\s*<=\s*NOW\(\)\s*-\s*\(\$1\s*\*\s*INTERVAL\s*'1 hour'\)/i,
      'min-age predicate uses the first parameter');
    assert.match(captured.sql, /sent_via_share_intent_at\s*>\s*NOW\(\)\s*-\s*\(\$2\s*\*\s*INTERVAL\s*'1 day'\)/i,
      'max-age predicate uses the second parameter — caps how far back we look');
    assert.match(captured.sql, /sent_not_viewed_nudge_sent_at\s+IS\s+NULL/i,
      'cooldown gate — one-shot per invoice');
    assert.match(captured.sql, /welcome_email_sent_at\s+IS\s+NOT\s+NULL/i,
      'welcome_email_sent_at gate — activation ordering');
    assert.match(captured.sql, /ORDER\s+BY\s+i\.sent_via_share_intent_at\s+ASC/i,
      'oldest unopened first');
    assert.match(captured.sql, /LIMIT\s+500/i, 'batch cap');
    assert.deepStrictEqual(captured.params, [72, 14]);
  } finally {
    realPool.query = originalQuery;
  }
});

test('SQL: input sanitization — non-numeric / negative minHours / maxDays fall back to defaults', async () => {
  delete require.cache[require.resolve('../db')];
  const realDbMod = require('../db');
  const realPool = realDbMod.pool;
  const db = realDbMod.db;
  let captured = null;
  const originalQuery = realPool.query.bind(realPool);
  realPool.query = async (sql, params) => { captured = { sql, params }; return { rows: [] }; };
  try {
    await db.getInvoicesForSentNotViewedNudge(-5, 'abc');
    assert.deepStrictEqual(captured.params, [72, 14],
      'negative / non-numeric inputs must coerce to safe defaults');
  } finally {
    realPool.query = originalQuery;
  }
});

test('db.markSentNotViewedNudgeSent: returns null when invoiceId is falsy (no SQL issued)', async () => {
  delete require.cache[require.resolve('../db')];
  const realDbMod = require('../db');
  const realPool = realDbMod.pool;
  const db = realDbMod.db;
  let calls = 0;
  const originalQuery = realPool.query.bind(realPool);
  realPool.query = async () => { calls += 1; return { rows: [] }; };
  try {
    assert.strictEqual(await db.markSentNotViewedNudgeSent(null), null);
    assert.strictEqual(await db.markSentNotViewedNudgeSent(0), null);
    assert.strictEqual(await db.markSentNotViewedNudgeSent(undefined), null);
    assert.strictEqual(calls, 0, 'no SQL must be issued for falsy invoiceId');
  } finally {
    realPool.query = originalQuery;
  }
});

test('db.markSentNotViewedNudgeSent: stamping UPDATE re-asserts NULL guard (concurrent-tick safety)', async () => {
  delete require.cache[require.resolve('../db')];
  const realDbMod = require('../db');
  const realPool = realDbMod.pool;
  const db = realDbMod.db;
  let captured = null;
  const originalQuery = realPool.query.bind(realPool);
  realPool.query = async (sql, params) => { captured = { sql, params }; return { rows: [{ id: 71 }] }; };
  try {
    await db.markSentNotViewedNudgeSent(71);
    assert.match(captured.sql, /UPDATE\s+invoices/i);
    assert.match(captured.sql, /SET\s+sent_not_viewed_nudge_sent_at\s*=\s*NOW\(\)/i);
    assert.match(captured.sql, /WHERE\s+id\s*=\s*\$1/i);
    assert.match(captured.sql, /AND\s+sent_not_viewed_nudge_sent_at\s+IS\s+NULL/i,
      'NULL guard re-asserted in UPDATE — concurrent ticks cannot double-send');
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
  console.log(`\n${passed} passed, ${failed} failed (sent-not-viewed-nudge.test.js)`);
  if (failed > 0) process.exit(1);
})();
