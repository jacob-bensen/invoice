'use strict';

/*
 * Second Pending Quick-Invoice Nudge — 7-day post-first-pending-nudge follow-up.
 *
 * Coverage mirrors tests/pending-quick-invoice-nudge.test.js +
 * tests/second-no-invoice-nudge.test.js. The second pending nudge is a
 * separate one-shot for the cohort that:
 *   - Autosaved /invoices/quick (pending_quick_invoice is populated).
 *   - Got the first pending nudge (pending_invoice_nudge_sent_at IS NOT NULL).
 *   - Is still at invoice_count = 0 a week later.
 *
 * The generic second-no-invoice cron excludes pending-nudged users, so without
 * this job that cohort gets nothing else despite having the strongest
 * activation signal we capture. Asserted properties:
 *   1. Pure formatters: greeting, XSS escape, CTA URLs with/without APP_URL.
 *   2. Different framing from the first pending nudge (subject + body shape).
 *   3. Magic-login bake-in: per-row token + ?next=/invoices/quick deep-link.
 *   4. Payload threading: typed data surfaces in the detail block + skipped
 *      when missing.
 *   5. Happy path: cohort row → email sent + user stamp written.
 *   6. not_configured → no stamp, retries next tick.
 *   7. sendEmail throw / mint throw → counted/soft-failed correctly.
 *   8. Idempotency across runs.
 *   9. Top-level query failure → errors=1, no throw.
 *  10. startSecondPendingQuickInvoiceNudgeJob: NODE_ENV=test block,
 *      force-accept, double-start refusal, cron tick wiring.
 *  11. DEFAULT_SCHEDULE shape (09:30 UTC — strictly after first pending at 09:00).
 *  12. SQL contract on db.getUsersForSecondPendingQuickInvoiceNudge — gates
 *      on invoice_count = 0, welcome stamped, pending data present, first
 *      pending nudge stamped, 7-day inner gap, second stamp NULL.
 *  13. db.markSecondPendingQuickInvoiceNudgeSent: idempotency UPDATE guard +
 *      falsy short-circuit.
 *
 * Run: NODE_ENV=test node tests/second-pending-quick-invoice-nudge.test.js
 */

const assert = require('assert');

const second = require('../jobs/second-pending-quick-invoice-nudge');

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
    pending_quick_invoice: { client_name: 'Acme', description: 'Logo work', amount: '500' },
    pending_quick_invoice_updated_at: new Date('2026-05-05T10:00:00Z'),
    pending_invoice_nudge_sent_at: new Date('2026-05-06T10:00:00Z'),
    ...over
  };
}

// ---- Pure formatters ---------------------------------------------------

test('subject: empathetic terminal framing, no PII, distinguishable from first pending nudge', () => {
  const subj = second.buildSecondPendingQuickInvoiceNudgeSubject();
  assert.match(subj, /[Ss]till want/);
  // No identifying info — generic so the cohort isn't leaked via preview.
  assert.ok(!/Sam|Studio|Acme|test\.io|500/.test(subj));
  // Must NOT be the same line as the first pending nudge — that would feel
  // like spam. The first nudge subject mirrors the typed data ("Your $500
  // invoice for Acme is half-typed"); this one is generic empathetic ask.
  const first = require('../jobs/pending-quick-invoice-nudge');
  const firstSubj = first.buildPendingQuickInvoiceNudgeSubject(cohortRow());
  assert.notStrictEqual(subj, firstSubj,
    'second nudge subject must differ from the first');
});

test('html: empathetic body + reply prompt + terminal one-shot promise', () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const html = second.buildSecondPendingQuickInvoiceNudgeHtml(cohortRow());
  assert.match(html, /Still want to send that invoice/);
  assert.match(html, /[Hh]it reply/);
  // Body must surface the three common blockers — the differentiator from the
  // first pending nudge's "your draft is half-typed" framing.
  assert.match(html, /gig fell through/i);
  assert.match(html, /how to word it/i);
  assert.match(html, /waiting on something/i);
  // CTA points at the express form, not the high-friction /invoices/new.
  assert.match(html, /https:\/\/decentinvoice\.com\/invoices\/quick/);
  assert.ok(!/decentinvoice\.com\/invoices\/new(?!\?)/.test(html),
    'CTA must NOT point at the legacy /invoices/new form');
  // Terminal promise — the second pending nudge IS the last one, matching the
  // SQL one-shot idempotency gate.
  assert.match(html, /last note about this draft/i);
  assert.match(html, /won't keep poking/i);
});

test('html: surfaces typed data (client + description + amount) from payload', () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const html = second.buildSecondPendingQuickInvoiceNudgeHtml(cohortRow({
    pending_quick_invoice: { client_name: 'Acme Corp', description: 'Logo redesign', amount: '1500' }
  }));
  assert.match(html, /Acme Corp/);
  assert.match(html, /Logo redesign/);
  assert.match(html, /\$1500/, 'amount surfaced with $ prefix when numeric');
});

test('html: omits detail block when payload empty / unparseable', () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const empty = second.buildSecondPendingQuickInvoiceNudgeHtml(cohortRow({
    pending_quick_invoice: null
  }));
  assert.ok(!/<ul[^>]*>/.test(empty.split('most common reasons')[0]),
    'no detail <ul> before the blockers block when payload is empty');
  // The "most common reasons" detail list still renders — that's the
  // empathetic body block, not the typed-data block.
  assert.match(empty, /most common reasons/);
});

test('html: escapes hostile payload values (XSS defence)', () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const html = second.buildSecondPendingQuickInvoiceNudgeHtml(cohortRow({
    pending_quick_invoice: {
      client_name: '<script>alert(1)</script>',
      description: 'normal',
      amount: '500'
    }
  }));
  assert.ok(!/<script>alert\(1\)<\/script>/.test(html),
    'raw script tags must be escaped');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('html: escapes hostile greeting (XSS defence)', () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const html = second.buildSecondPendingQuickInvoiceNudgeHtml(cohortRow({
    name: '<img src=x onerror=alert(1)>'
  }));
  assert.ok(!/<img src=x onerror/.test(html), 'raw greeting must be escaped');
  assert.match(html, /&lt;img/);
});

test('html: CTA omitted gracefully when APP_URL is unset', () => {
  delete process.env.APP_URL;
  const html = second.buildSecondPendingQuickInvoiceNudgeHtml(cohortRow());
  assert.ok(!/<a href=/.test(html),
    'no CTA <a> when APP_URL is unset — graceful degradation');
  assert.match(html, /Still want to send that invoice/, 'body copy remains');
});

test('html: greeting falls back through name → business_name → "there"', () => {
  const h1 = second.buildSecondPendingQuickInvoiceNudgeHtml(cohortRow({ name: 'Alice', business_name: 'X' }));
  assert.match(h1, /Hi Alice,/);
  const h2 = second.buildSecondPendingQuickInvoiceNudgeHtml(cohortRow({ name: null, business_name: 'Studio Q' }));
  assert.match(h2, /Hi Studio Q,/);
  const h3 = second.buildSecondPendingQuickInvoiceNudgeHtml(cohortRow({ name: null, business_name: null }));
  assert.match(h3, /Hi there,/);
});

test('text: includes greeting + CTA URLs (trailing slash trimmed)', () => {
  process.env.APP_URL = 'https://decentinvoice.com/';
  const text = second.buildSecondPendingQuickInvoiceNudgeText(cohortRow({ name: 'Sam' }));
  assert.match(text, /Hi Sam/);
  assert.match(text, /https:\/\/decentinvoice\.com\/invoices\/quick/,
    'APP_URL trailing slash must be trimmed before joining /invoices/quick');
  assert.match(text, /https:\/\/decentinvoice\.com\/dashboard/);
  assert.match(text, /[Hh]it reply/);
  assert.match(text, /last note about this draft/i);
});

test('text: surfaces typed data in detail bullets', () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const text = second.buildSecondPendingQuickInvoiceNudgeText(cohortRow({
    pending_quick_invoice: { client_name: 'Acme Corp', description: 'Logo redesign', amount: '1500' }
  }));
  assert.match(text, /Client: Acme Corp/);
  assert.match(text, /What you did: Logo redesign/);
  assert.match(text, /Amount: \$1500/);
});

// ---- Magic-login bake-in -----------------------------------------------

test('html: opts.magicLoginUrl bakes the auto-sign-in URL into the primary CTA with ?next=/invoices/quick', () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const magicUrl = 'https://decentinvoice.com/auth/magic/abc123def';
  const html = second.buildSecondPendingQuickInvoiceNudgeHtml(cohortRow(), null, { magicLoginUrl: magicUrl });
  assert.match(html, /\/auth\/magic\/abc123def\?next=\/invoices\/quick/,
    'primary CTA href is the magic URL with ?next=/invoices/quick');
  assert.ok(!/href="https:\/\/decentinvoice\.com\/invoices\/quick"/.test(html),
    'no plain /invoices/quick href when a magic URL is supplied');
  assert.match(html, /https:\/\/decentinvoice\.com\/dashboard/,
    'secondary dashboard link stays plain');
});

test('text: opts.magicLoginUrl bakes the auto-sign-in URL into the plaintext CTA', () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const magicUrl = 'https://decentinvoice.com/auth/magic/abc123def';
  const text = second.buildSecondPendingQuickInvoiceNudgeText(cohortRow(), null, { magicLoginUrl: magicUrl });
  assert.match(text, /Finish your invoice: https:\/\/decentinvoice\.com\/auth\/magic\/abc123def\?next=\/invoices\/quick/);
  assert.ok(!/Finish your invoice: https:\/\/decentinvoice\.com\/invoices\/quick/.test(text),
    'no plain-CTA leak when magic URL is supplied');
});

test('html/text: opts.magicLoginUrl absent → plain /invoices/quick fallback', () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const htmlNoOpts = second.buildSecondPendingQuickInvoiceNudgeHtml(cohortRow());
  assert.match(htmlNoOpts, /https:\/\/decentinvoice\.com\/invoices\/quick/);
  assert.ok(!/\/auth\/magic\//.test(htmlNoOpts), 'no magic URL when opts absent');
  const htmlEmptyMagic = second.buildSecondPendingQuickInvoiceNudgeHtml(cohortRow(), null, { magicLoginUrl: '   ' });
  assert.match(htmlEmptyMagic, /https:\/\/decentinvoice\.com\/invoices\/quick/,
    'whitespace-only magicLoginUrl is treated as absent');
});

test('NUDGE_TTL_MINUTES is 7 days', () => {
  assert.strictEqual(second.NUDGE_TTL_MINUTES, 7 * 24 * 60);
});

test('DEFAULT_MIN_INNER_GAP_DAYS is 7', () => {
  assert.strictEqual(second.DEFAULT_MIN_INNER_GAP_DAYS, 7);
});

// ---- Orchestrator tests ------------------------------------------------

function fakeDb(rows = []) {
  const stamped = [];
  return {
    rows,
    stamped,
    async getUsersForSecondPendingQuickInvoiceNudge() { return rows; },
    async markSecondPendingQuickInvoiceNudgeSent(userId) {
      stamped.push(userId);
      return { id: userId, second_pending_invoice_nudge_sent_at: new Date() };
    }
  };
}

test('happy path: sends and stamps', async () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const sends = [];
  const db = fakeDb([cohortRow({ id: 42, email: 'sam@test.io', name: 'Sam' })]);
  const summary = await second.processSecondPendingQuickInvoiceNudges({
    db,
    sendEmail: async (p) => { sends.push(p); return { ok: true, id: 'em_1' }; },
    mintMagicLoginToken: async () => ({ ok: false, reason: 'stubbed' }),
    now: new Date('2026-05-17T13:00:00Z'),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.found, 1);
  assert.strictEqual(summary.sent, 1);
  assert.strictEqual(summary.errors, 0);
  assert.strictEqual(summary.notConfigured, 0);
  assert.deepStrictEqual(db.stamped, [42]);
  assert.strictEqual(sends.length, 1);
  assert.strictEqual(sends[0].to, 'sam@test.io');
  assert.match(sends[0].subject, /Still want to send that invoice/);
  assert.match(sends[0].html, /Hi Sam/);
  assert.match(sends[0].text, /Hi Sam/);
  // Typed data threaded through to the email body.
  assert.match(sends[0].html, /Acme/);
});

test('rows with all-empty payload are skipped (defence-in-depth — SQL gate excludes NULL but not all-empty JSON)', async () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const sends = [];
  const db = fakeDb([
    cohortRow({ id: 1, email: 'a@a.com', pending_quick_invoice: {} }),
    cohortRow({ id: 2, email: 'b@b.com', pending_quick_invoice: { client_name: 'real' } })
  ]);
  const summary = await second.processSecondPendingQuickInvoiceNudges({
    db,
    sendEmail: async (p) => { sends.push(p); return { ok: true, id: 'em' }; },
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.found, 2);
  assert.strictEqual(summary.skipped, 1, 'empty payload row skipped');
  assert.strictEqual(summary.sent, 1, 'real payload row sent');
  assert.deepStrictEqual(db.stamped, [2]);
  assert.strictEqual(sends.length, 1);
  assert.strictEqual(sends[0].to, 'b@b.com');
});

test('magic-login: mints once per cohort row + bakes per-user URL (no cross-user leak)', async () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const sends = [];
  const mintCalls = [];
  const db = fakeDb([
    cohortRow({ id: 7, email: 'a@a.com', name: 'A' }),
    cohortRow({ id: 8, email: 'b@b.com', name: 'B' })
  ]);
  await second.processSecondPendingQuickInvoiceNudges({
    db,
    sendEmail: async (p) => { sends.push(p); return { ok: true, id: 'em' }; },
    mintMagicLoginToken: async (_db, userId, opts) => {
      mintCalls.push({ userId, opts });
      return { ok: true, url: `https://decentinvoice.com/auth/magic/tok-${userId}`, ttlMinutes: opts.ttlMinutes };
    },
    now: new Date('2026-05-17T13:00:00Z'),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(mintCalls.length, 2, 'mint called exactly once per cohort row');
  assert.strictEqual(mintCalls[0].userId, 7);
  assert.strictEqual(mintCalls[0].opts.ttlMinutes, second.NUDGE_TTL_MINUTES,
    'mint uses the 7-day TTL');
  assert.match(sends[0].html, /\/auth\/magic\/tok-7\?next=\/invoices\/quick/,
    'user 7 receives the user 7 magic URL');
  assert.match(sends[1].html, /\/auth\/magic\/tok-8\?next=\/invoices\/quick/,
    'user 8 receives the user 8 magic URL (no cross-user leak)');
  assert.ok(!/\/auth\/magic\/tok-7/.test(sends[1].html),
    'user 8 must NOT receive user 7 token');
});

test('magic-login: mint failure soft-fails to plain CTA, email still ships', async () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const sends = [];
  const warns = [];
  const db = fakeDb([cohortRow({ id: 99, email: 'q@q.com', name: 'Q' })]);
  const summary = await second.processSecondPendingQuickInvoiceNudges({
    db,
    sendEmail: async (p) => { sends.push(p); return { ok: true, id: 'em_99' }; },
    mintMagicLoginToken: async () => ({ ok: false, reason: 'db_error' }),
    log: { error: () => {}, warn: (...a) => warns.push(a), log: () => {} }
  });
  assert.strictEqual(summary.sent, 1, 'mint failure does NOT block the send');
  assert.deepStrictEqual(db.stamped, [99]);
  assert.match(sends[0].html, /https:\/\/decentinvoice\.com\/invoices\/quick/);
  assert.ok(!/\/auth\/magic\//.test(sends[0].html));
  assert.ok(warns.some(args => /magic-link mint skipped/.test(args.join(' '))));
});

test('magic-login: mint throws → soft-fails, no error counted', async () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const sends = [];
  const db = fakeDb([cohortRow({ id: 5, email: 'z@z.com' })]);
  const summary = await second.processSecondPendingQuickInvoiceNudges({
    db,
    sendEmail: async (p) => { sends.push(p); return { ok: true }; },
    mintMagicLoginToken: async () => { throw new Error('mint exploded'); },
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.sent, 1);
  assert.strictEqual(summary.errors, 0,
    'mint throw must not count as a send error');
  assert.match(sends[0].html, /https:\/\/decentinvoice\.com\/invoices\/quick/);
});

test('replyTo precedence: reply_to_email > business_email > email', async () => {
  const sends = [];
  const db = fakeDb([
    cohortRow({ id: 1, email: 'fallback@x.com', reply_to_email: 'reply@x.com', business_email: 'biz@x.com' }),
    cohortRow({ id: 2, email: 'fallback@y.com', reply_to_email: null, business_email: 'biz@y.com' }),
    cohortRow({ id: 3, email: 'fallback@z.com', reply_to_email: null, business_email: null })
  ]);
  await second.processSecondPendingQuickInvoiceNudges({
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
  const db = fakeDb([cohortRow({ id: 9, email: null })]);
  const summary = await second.processSecondPendingQuickInvoiceNudges({
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
  const db = fakeDb([cohortRow({ id: 99, email: 'foo@bar.com' })]);
  const summary = await second.processSecondPendingQuickInvoiceNudges({
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
    cohortRow({ id: 1, email: 'a@a.com' }),
    cohortRow({ id: 2, email: 'b@b.com' })
  ]);
  let i = 0;
  const summary = await second.processSecondPendingQuickInvoiceNudges({
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
  const initial = [cohortRow({ id: 11, email: 'c@c.com' })];
  const stamped = [];
  const db = {
    async getUsersForSecondPendingQuickInvoiceNudge() {
      return initial.filter(u => !stamped.includes(u.id));
    },
    async markSecondPendingQuickInvoiceNudgeSent(uid) { stamped.push(uid); return { id: uid }; }
  };
  const sends = [];
  const send = async (p) => { sends.push(p); return { ok: true, id: 'e' }; };
  const r1 = await second.processSecondPendingQuickInvoiceNudges({
    db, sendEmail: send,
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(r1.sent, 1);
  const r2 = await second.processSecondPendingQuickInvoiceNudges({
    db, sendEmail: send,
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(r2.found, 0, 'one-shot stamp excludes the row on the next run');
  assert.strictEqual(r2.sent, 0);
  assert.strictEqual(sends.length, 1, 'one email across both runs — never repeats');
});

test('top-level query failure → errors=1, no throw', async () => {
  const db = {
    async getUsersForSecondPendingQuickInvoiceNudge() { throw new Error('PG down'); },
    async markSecondPendingQuickInvoiceNudgeSent() { throw new Error('should not be called'); }
  };
  const summary = await second.processSecondPendingQuickInvoiceNudges({
    db,
    sendEmail: async () => ({ ok: true }),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.found, 0);
  assert.strictEqual(summary.sent, 0);
  assert.strictEqual(summary.errors, 1);
});

test('minInnerGapDays opt is threaded through to the db helper', async () => {
  let captured = null;
  const db = {
    async getUsersForSecondPendingQuickInvoiceNudge(days) { captured = days; return []; },
    async markSecondPendingQuickInvoiceNudgeSent() { return null; }
  };
  await second.processSecondPendingQuickInvoiceNudges({
    db,
    sendEmail: async () => ({ ok: true }),
    minInnerGapDays: 14,
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(captured, 14);
});

test('ttlMinutes opt overrides NUDGE_TTL_MINUTES on the mint call', async () => {
  let mintTtl = null;
  const db = fakeDb([cohortRow({ id: 1, email: 'a@a.com' })]);
  await second.processSecondPendingQuickInvoiceNudges({
    db,
    sendEmail: async () => ({ ok: true }),
    mintMagicLoginToken: async (_db, _uid, opts) => { mintTtl = opts.ttlMinutes; return { ok: false }; },
    ttlMinutes: 1234,
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(mintTtl, 1234);
});

// ---- Cron wiring -------------------------------------------------------

test('startSecondPendingQuickInvoiceNudgeJob blocked under NODE_ENV=test', () => {
  process.env.NODE_ENV = 'test';
  second.stopSecondPendingQuickInvoiceNudgeJob();
  const r = second.startSecondPendingQuickInvoiceNudgeJob();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'test_env');
});

test('startSecondPendingQuickInvoiceNudgeJob: cron tick triggers processSecondPendingQuickInvoiceNudges', async () => {
  second.stopSecondPendingQuickInvoiceNudgeJob();
  let captured = null;
  const fakeCron = {
    schedule(expr, cb, opts) {
      captured = { expr, cb, opts };
      return { stop() {} };
    }
  };
  const db = fakeDb([cohortRow({ id: 51, email: 'e@e.com' })]);
  let sendCalls = 0;
  const r = second.startSecondPendingQuickInvoiceNudgeJob({
    force: true,
    cron: fakeCron,
    schedule: '30 9 * * *',
    db,
    sendEmail: async () => { sendCalls += 1; return { ok: true }; },
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.schedule, '30 9 * * *');
  assert.ok(captured, 'cron.schedule must be called');
  assert.strictEqual(captured.expr, '30 9 * * *');
  assert.strictEqual(captured.opts && captured.opts.timezone, 'UTC');
  await captured.cb();
  assert.strictEqual(sendCalls, 1, 'cron tick must invoke processSecondPendingQuickInvoiceNudges');
  assert.deepStrictEqual(db.stamped, [51]);
  second.stopSecondPendingQuickInvoiceNudgeJob();
});

test('startSecondPendingQuickInvoiceNudgeJob refuses double start', () => {
  second.stopSecondPendingQuickInvoiceNudgeJob();
  const fakeCron = { schedule() { return { stop() {} }; } };
  const r1 = second.startSecondPendingQuickInvoiceNudgeJob({ force: true, cron: fakeCron });
  assert.strictEqual(r1.ok, true);
  const r2 = second.startSecondPendingQuickInvoiceNudgeJob({ force: true, cron: fakeCron });
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.reason, 'already_running');
  second.stopSecondPendingQuickInvoiceNudgeJob();
});

test('DEFAULT_SCHEDULE is 30 9 * * * (09:30 UTC — strictly after first pending nudge at 09:00)', () => {
  assert.strictEqual(second.DEFAULT_SCHEDULE, '30 9 * * *');
  const first = require('../jobs/pending-quick-invoice-nudge');
  // Same-day ordering guarantee: first pending nudge at 09:00 runs and stamps
  // before this job picks up its cohort at 09:30. The 7-day inner gap in the
  // SQL query is the real defence; the schedule offset is the belt.
  assert.strictEqual(first.DEFAULT_SCHEDULE, '0 9 * * *',
    'first pending nudge runs at 09:00 UTC; second must run after');
});

// ---- SQL contract on db.getUsersForSecondPendingQuickInvoiceNudge -------

test('SQL: query gates on invoice_count=0, welcome stamped, pending data + first nudge present, 7-day inner gap, second stamp NULL', async () => {
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
    await db.getUsersForSecondPendingQuickInvoiceNudge(7);
    assert.ok(captured, 'query was issued');
    assert.match(captured.sql, /invoice_count\s*=\s*0/i,
      'invoice_count=0 gate — no real invoice ever created');
    assert.match(captured.sql, /welcome_email_sent_at\s+IS\s+NOT\s+NULL/i,
      'welcome must have fired before this nudge');
    assert.match(captured.sql, /lifecycle_emails_opted_out_at\s+IS\s+NULL/i,
      'honour the lifecycle opt-out');
    assert.match(captured.sql, /pending_quick_invoice\s+IS\s+NOT\s+NULL/i,
      'must still have typed data to surface');
    assert.match(captured.sql, /pending_invoice_nudge_sent_at\s+IS\s+NOT\s+NULL/i,
      'must have received the first pending nudge');
    assert.match(captured.sql, /pending_invoice_nudge_sent_at\s*<=\s*NOW\(\)\s*-\s*\(\$1\s*\*\s*INTERVAL\s*'1 day'\)/i,
      '7-day inner gap parameterised on $1');
    assert.match(captured.sql, /second_pending_invoice_nudge_sent_at\s+IS\s+NULL/i,
      'one-shot idempotency on the second-pending-nudge stamp');
    assert.match(captured.sql, /email\s+IS\s+NOT\s+NULL/i,
      'email gate — defence in depth');
    assert.match(captured.sql, /ORDER BY\s+pending_invoice_nudge_sent_at\s+ASC/i,
      'oldest first-nudge first — fairness + peak conversion likelihood');
    assert.match(captured.sql, /LIMIT 500/i,
      'bounded batch so legacy backlog never blasts SMTP');
    assert.deepStrictEqual(captured.params, [7]);
  } finally {
    realPool.query = originalQuery;
  }
});

test('SQL: non-numeric / negative minInnerGapDays coerces to default 7', async () => {
  delete require.cache[require.resolve('../db')];
  const realDbMod = require('../db');
  const realPool = realDbMod.pool;
  const db = realDbMod.db;
  let captured = null;
  const originalQuery = realPool.query.bind(realPool);
  realPool.query = async (sql, params) => { captured = { sql, params }; return { rows: [] }; };
  try {
    await db.getUsersForSecondPendingQuickInvoiceNudge(-5);
    assert.deepStrictEqual(captured.params, [7], 'negative coerces to default 7');
    await db.getUsersForSecondPendingQuickInvoiceNudge('abc');
    assert.deepStrictEqual(captured.params, [7], 'non-numeric coerces to default 7');
    await db.getUsersForSecondPendingQuickInvoiceNudge();
    assert.deepStrictEqual(captured.params, [7], 'undefined coerces to default 7');
  } finally {
    realPool.query = originalQuery;
  }
});

test('db.markSecondPendingQuickInvoiceNudgeSent: idempotency guard + falsy-userId short-circuit', async () => {
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
    return { rows: [{ id: params[0], second_pending_invoice_nudge_sent_at: new Date() }] };
  };
  try {
    assert.strictEqual(await db.markSecondPendingQuickInvoiceNudgeSent(null), null);
    assert.strictEqual(await db.markSecondPendingQuickInvoiceNudgeSent(0), null);
    assert.strictEqual(await db.markSecondPendingQuickInvoiceNudgeSent(undefined), null);
    assert.strictEqual(calls, 0, 'no SQL must be issued for falsy userId');
    const r = await db.markSecondPendingQuickInvoiceNudgeSent(7);
    assert.ok(r && r.id === 7);
    assert.match(captured.sql, /UPDATE\s+users\s+SET\s+second_pending_invoice_nudge_sent_at\s*=\s*NOW\(\)/i);
    assert.match(captured.sql, /second_pending_invoice_nudge_sent_at\s+IS\s+NULL/i,
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
  console.log(`\n${passed} passed, ${failed} failed (second-pending-quick-invoice-nudge.test.js)`);
  if (failed > 0) process.exit(1);
})();
