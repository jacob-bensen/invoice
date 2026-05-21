'use strict';

/*
 * Client-Viewed-But-Unpaid Follow-up Email — 48h+ post-view cron job.
 *
 * Coverage mirrors tests/stale-draft-email.test.js:
 *   1. Subject + HTML + text formatters: XSS escape, day-since-viewed
 *      anchor, view-count line, CTA URL with/without APP_URL.
 *   2. daysSinceViewed() arithmetic — exact 48h, 5d, garbage.
 *   3. Happy path: viewed-unpaid row → email sent + invoice stamp written.
 *   4. Skips rows without an email (defence-in-depth).
 *   5. not_configured (RESEND key unset) → no stamp, retries next tick.
 *   6. sendEmail throw → counts an error, batch continues, no stamp.
 *   7. Magic-login bake-in: per-row mint + cross-row leak guard +
 *      mint-fail soft-fall + ttlMinutes override + safeNextPath compat.
 *   8. Top-level query failure → errors=1, no throw.
 *   9. startClientViewedFollowupJob blocked under NODE_ENV=test; accepts force.
 *  10. Cron tick wires processClientViewedFollowup through correctly.
 *  11. Double start refused.
 *  12. DEFAULT_SCHEDULE shape.
 *  13. SQL contract checks on db.getInvoicesForClientViewedFollowup — the
 *      production query gates on status IN ('sent','overdue'), is_seed=false,
 *      first_viewed_at IS NOT NULL, the min/max age window, the per-invoice
 *      cooldown, and welcome_email_sent_at IS NOT NULL.
 *
 * Run: NODE_ENV=test node tests/client-viewed-followup.test.js
 */

const assert = require('assert');

const followup = require('../jobs/client-viewed-followup');
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
    first_viewed_at: new Date('2026-05-14T00:00:00Z'),
    view_count: 2,
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

test('subject: includes client name + invoice number + nudge framing', () => {
  const subj = emailLib.buildClientViewedFollowupSubject(followupRow());
  assert.match(subj, /Acme Co/);
  assert.match(subj, /INV-2026-0003/);
  assert.match(subj, /hasn't paid/);
  assert.match(subj, /nudge/);
});

test('subject: missing invoice_number + client_name degrade gracefully', () => {
  const subj = emailLib.buildClientViewedFollowupSubject(
    followupRow({ invoice_number: null, client_name: null })
  );
  assert.match(subj, /your client opened your invoice/i);
});

test('html: escapes hostile name + client + threads CTA URL when APP_URL is set', () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const html = emailLib.buildClientViewedFollowupHtml(followupRow({
    name: '<script>alert(1)</script>',
    client_name: 'X & Co <em>',
    invoice_number: 'INV-2026-0003',
    invoice_total: '1500.00',
    first_viewed_at: new Date('2026-05-14T00:00:00Z'),
    view_count: 3
  }), new Date('2026-05-16T00:00:00Z'));

  assert.ok(!/<script>alert\(1\)<\/script>/.test(html),
    'raw script must be escaped (XSS defence)');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /X &amp; Co/);
  assert.match(html, /INV-2026-0003/);
  assert.match(html, /\$1500\.00/, 'total must be money-formatted');
  assert.match(html, /2 days ago/, 'days-since-viewed anchor inline in body');
  assert.match(html, /3 times/, 'view_count >1 surfaces the multi-view line');
  assert.match(html, /https:\/\/decentinvoice\.com\/invoices\/71/,
    'CTA must deep-link to /invoices/<id> (where share-intent buttons live)');
  assert.match(html, /Open invoice/, 'CTA copy includes "Open invoice"');
});

test('html: view_count = 1 omits the multi-open line', () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const html = emailLib.buildClientViewedFollowupHtml(
    followupRow({ view_count: 1 }),
    new Date('2026-05-16T00:00:00Z')
  );
  assert.ok(!/times/.test(html.replace(/sometimes|times of/g, '')),
    'no "N times" line when only opened once');
});

test('html: CTA omitted gracefully when APP_URL is unset (no broken-link button)', () => {
  delete process.env.APP_URL;
  const html = emailLib.buildClientViewedFollowupHtml(
    followupRow(),
    new Date('2026-05-16T00:00:00Z')
  );
  assert.ok(!/<a href=/.test(html),
    'no CTA <a> when APP_URL is unset — graceful degradation');
  assert.match(html, /hasn't paid/, 'body copy remains');
});

test('text: includes greeting, day anchor, client + CTA URL with trimmed trailing slash', () => {
  process.env.APP_URL = 'https://decentinvoice.com/';
  const txt = emailLib.buildClientViewedFollowupText(followupRow({
    name: 'Sam',
    invoice_number: 'INV-2026-0003',
    invoice_total: '1500.00',
    client_name: 'Acme',
    first_viewed_at: new Date('2026-05-14T00:00:00Z'),
    view_count: 4
  }), new Date('2026-05-16T00:00:00Z'));

  assert.match(txt, /Hi Sam,/);
  assert.match(txt, /Acme/);
  assert.match(txt, /INV-2026-0003/);
  assert.match(txt, /\$1500\.00/);
  assert.match(txt, /2 days ago/);
  assert.match(txt, /4 times/);
  assert.match(txt, /https:\/\/decentinvoice\.com\/invoices\/71/);
});

test('text: CTA URL omitted when APP_URL is unset', () => {
  delete process.env.APP_URL;
  const txt = emailLib.buildClientViewedFollowupText(
    followupRow(),
    new Date('2026-05-16T00:00:00Z')
  );
  assert.ok(!/https?:\/\//.test(txt),
    'no URLs in body when APP_URL is unset — graceful degradation');
});

// ---- daysSinceViewed arithmetic ----------------------------------------

test('daysSinceViewed: exact 48h is 2 days; 5 days is 5; null is 0; garbage is 0', () => {
  const ref = new Date('2026-05-16T12:00:00Z');
  assert.strictEqual(emailLib.daysSinceViewed(new Date('2026-05-14T12:00:00Z'), ref), 2);
  assert.strictEqual(emailLib.daysSinceViewed(new Date('2026-05-11T12:00:00Z'), ref), 5);
  assert.strictEqual(emailLib.daysSinceViewed(null), 0);
  assert.strictEqual(emailLib.daysSinceViewed('not-a-date'), 0);
});

test('html: < 1 day shows "2 days" floor (subject/copy never says "0 days")', () => {
  // 30h after view is < 2 days. Copy clamps to "2 days" minimum since the
  // cohort itself is gated 48h+ — anything less would be query-tier garbage.
  process.env.APP_URL = 'https://decentinvoice.com';
  const html = emailLib.buildClientViewedFollowupHtml(
    followupRow({ first_viewed_at: new Date('2026-05-15T06:00:00Z') }),
    new Date('2026-05-16T12:00:00Z')
  );
  assert.match(html, /2 days ago/,
    'copy must not show "1 day" or "0 days" — minimum floor is 2 days');
});

// ---- Orchestrator tests ------------------------------------------------

function fakeDb(rows = []) {
  const stamped = [];
  return {
    rows,
    stamped,
    async getInvoicesForClientViewedFollowup() { return rows; },
    async markClientViewedFollowupSent(invoiceId) {
      stamped.push(invoiceId);
      return { id: invoiceId, client_viewed_followup_sent_at: new Date() };
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
  const summary = await followup.processClientViewedFollowup({
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
    'must stamp by invoice_id (NOT user_id — multiple unpaid-viewed invoices per user are each tracked separately)');
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
    followupRow({ invoice_id: 101, user_id: 7, email: 'a@a.com', name: 'A' }),
    followupRow({ invoice_id: 102, user_id: 8, email: 'b@b.com', name: 'B' })
  ]);
  await followup.processClientViewedFollowup({
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
    'mint must use row.user_id (token belongs to the freelancer, not the client)');
  assert.strictEqual(mintCalls[0].opts.ttlMinutes, followup.FOLLOWUP_TTL_MINUTES,
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
  const db = fakeDb([followupRow({ invoice_id: 7, user_id: 99, email: 'q@q.com', name: 'Q' })]);
  const summary = await followup.processClientViewedFollowup({
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
  const db = fakeDb([followupRow({ invoice_id: 31, user_id: 5, email: 'z@z.com' })]);
  const summary = await followup.processClientViewedFollowup({
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

test('magic-login: ttlMinutes opt overrides FOLLOWUP_TTL_MINUTES on the mint call', async () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  let capturedTtl = null;
  const db = fakeDb([followupRow({ invoice_id: 9, user_id: 1, email: 'a@a.com' })]);
  await followup.processClientViewedFollowup({
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
  const html = emailLib.buildClientViewedFollowupHtml(
    followupRow({ invoice_id: 42 }),
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
    followupRow({ invoice_id: 1, user_id: 1, email: 'fallback@x.com', reply_to_email: 'reply@x.com', business_email: 'biz@x.com' }),
    followupRow({ invoice_id: 2, user_id: 2, email: 'fallback@y.com', reply_to_email: null, business_email: 'biz@y.com' }),
    followupRow({ invoice_id: 3, user_id: 3, email: 'fallback@z.com', reply_to_email: null, business_email: null })
  ]);
  await followup.processClientViewedFollowup({
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
  const db = fakeDb([followupRow({ invoice_id: 9, user_id: 9, email: null })]);
  const summary = await followup.processClientViewedFollowup({
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
  const db = fakeDb([followupRow({ invoice_id: 11, user_id: 99, email: 'foo@bar.com' })]);
  const summary = await followup.processClientViewedFollowup({
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
  const summary = await followup.processClientViewedFollowup({
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
    async getInvoicesForClientViewedFollowup() { throw new Error('PG down'); },
    async markClientViewedFollowupSent() { return null; }
  };
  const summary = await followup.processClientViewedFollowup({
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

test('startClientViewedFollowupJob blocked under NODE_ENV=test', () => {
  process.env.NODE_ENV = 'test';
  followup.stopClientViewedFollowupJob();
  const r = followup.startClientViewedFollowupJob();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'test_env');
});

test('startClientViewedFollowupJob: cron tick triggers processClientViewedFollowup', async () => {
  followup.stopClientViewedFollowupJob();
  let captured = null;
  const fakeCron = {
    schedule(expr, cb, opts) {
      captured = { expr, cb, opts };
      return { stop() {} };
    }
  };
  const db = fakeDb([followupRow({ invoice_id: 51, user_id: 51, email: 'e@e.com' })]);
  let sendCalls = 0;
  const r = followup.startClientViewedFollowupJob({
    force: true,
    cron: fakeCron,
    schedule: '0 14 * * *',
    db,
    sendEmail: async () => { sendCalls += 1; return { ok: true }; },
    mintMagicLoginToken: async () => ({ ok: true, url: 'https://x/auth/magic/t' }),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.schedule, '0 14 * * *');
  assert.ok(captured, 'cron.schedule must be called');
  assert.strictEqual(captured.expr, '0 14 * * *');
  assert.strictEqual(captured.opts && captured.opts.timezone, 'UTC');
  await captured.cb();
  assert.strictEqual(sendCalls, 1, 'cron tick must invoke processClientViewedFollowup');
  assert.deepStrictEqual(db.stamped, [51]);
  followup.stopClientViewedFollowupJob();
});

test('startClientViewedFollowupJob refuses double start', () => {
  followup.stopClientViewedFollowupJob();
  const fakeCron = { schedule() { return { stop() {} }; } };
  const r1 = followup.startClientViewedFollowupJob({ force: true, cron: fakeCron });
  assert.strictEqual(r1.ok, true);
  const r2 = followup.startClientViewedFollowupJob({ force: true, cron: fakeCron });
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.reason, 'already_running');
  followup.stopClientViewedFollowupJob();
});

test('DEFAULT_SCHEDULE is 0 14 * * * (14:00 UTC — after overdue-digest at 13:00)', () => {
  assert.strictEqual(followup.DEFAULT_SCHEDULE, '0 14 * * *');
});

// ---- SQL contract on db.getInvoicesForClientViewedFollowup --------------

test('SQL: query gates on status IN (sent,overdue), is_seed=false, first_viewed_at, age window, cooldown', async () => {
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
    await db.getInvoicesForClientViewedFollowup(48, 14);
    assert.ok(captured, 'query was issued');
    assert.match(captured.sql, /status\s+IN\s*\(\s*'sent'\s*,\s*'overdue'\s*\)/i,
      'status predicate covers sent + overdue (NOT paid, NOT draft)');
    assert.match(captured.sql, /is_seed\s*=\s*false/i,
      'is_seed=false predicate — must NEVER email about the seed sample');
    assert.match(captured.sql, /first_viewed_at\s+IS\s+NOT\s+NULL/i,
      'first_viewed_at IS NOT NULL — only invoices the client demonstrably opened');
    assert.match(captured.sql, /first_viewed_at\s*<=\s*NOW\(\)\s*-\s*\(\$1\s*\*\s*INTERVAL\s*'1 hour'\)/i,
      'min-age predicate uses the first parameter');
    assert.match(captured.sql, /first_viewed_at\s*>\s*NOW\(\)\s*-\s*\(\$2\s*\*\s*INTERVAL\s*'1 day'\)/i,
      'max-age predicate uses the second parameter — caps how far back we look');
    assert.match(captured.sql, /client_viewed_followup_sent_at\s+IS\s+NULL/i,
      'cooldown gate — one-shot per invoice');
    assert.match(captured.sql, /welcome_email_sent_at\s+IS\s+NOT\s+NULL/i,
      'welcome_email_sent_at gate — activation ordering');
    assert.match(captured.sql, /ORDER\s+BY\s+i\.first_viewed_at\s+ASC/i,
      'oldest-viewed first — peak conversion-likelihood ordering');
    assert.match(captured.sql, /LIMIT\s+500/i, 'batch cap');
    assert.deepStrictEqual(captured.params, [48, 14]);
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
    await db.getInvoicesForClientViewedFollowup(-5, 'abc');
    assert.deepStrictEqual(captured.params, [48, 14],
      'negative / non-numeric inputs must coerce to safe defaults');
  } finally {
    realPool.query = originalQuery;
  }
});

test('db.markClientViewedFollowupSent: returns null when invoiceId is falsy (no SQL issued)', async () => {
  delete require.cache[require.resolve('../db')];
  const realDbMod = require('../db');
  const realPool = realDbMod.pool;
  const db = realDbMod.db;
  let calls = 0;
  const originalQuery = realPool.query.bind(realPool);
  realPool.query = async () => { calls += 1; return { rows: [] }; };
  try {
    assert.strictEqual(await db.markClientViewedFollowupSent(null), null);
    assert.strictEqual(await db.markClientViewedFollowupSent(0), null);
    assert.strictEqual(await db.markClientViewedFollowupSent(undefined), null);
    assert.strictEqual(calls, 0, 'no SQL must be issued for falsy invoiceId');
  } finally {
    realPool.query = originalQuery;
  }
});

test('db.markClientViewedFollowupSent: stamping UPDATE re-asserts NULL guard (concurrent-tick safety)', async () => {
  delete require.cache[require.resolve('../db')];
  const realDbMod = require('../db');
  const realPool = realDbMod.pool;
  const db = realDbMod.db;
  let captured = null;
  const originalQuery = realPool.query.bind(realPool);
  realPool.query = async (sql, params) => { captured = { sql, params }; return { rows: [{ id: 71 }] }; };
  try {
    await db.markClientViewedFollowupSent(71);
    assert.match(captured.sql, /UPDATE\s+invoices/i);
    assert.match(captured.sql, /SET\s+client_viewed_followup_sent_at\s*=\s*NOW\(\)/i);
    assert.match(captured.sql, /WHERE\s+id\s*=\s*\$1/i);
    assert.match(captured.sql, /AND\s+client_viewed_followup_sent_at\s+IS\s+NULL/i,
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
  console.log(`\n${passed} passed, ${failed} failed (client-viewed-followup.test.js)`);
  if (failed > 0) process.exit(1);
})();
