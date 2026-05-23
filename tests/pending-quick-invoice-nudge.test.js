'use strict';

/*
 * Pending Quick-Invoice Nudge — 24h post-autosave re-engagement email cron.
 *
 * Coverage spans:
 *   1. parsePendingPayload — JSONB object + stringified-JSON tolerance,
 *      all-empty short-circuit, trim + truncate behaviour, non-string fields.
 *   2. formatAmountDisplay — adds "$" only when numeric + positive; preserves
 *      raw text otherwise; existing currency prefix passes through.
 *   3. buildHeadline — every combination of (client/amount/description)
 *      produces grammatical copy.
 *   4. Pure formatters: subject mirrors headline, HTML/text bodies surface
 *      every populated field with XSS escape, CTA URLs honour APP_URL +
 *      magicLoginUrl bake-in.
 *   5. Orchestrator: happy path, mint-per-row + cross-user leak guard, mint
 *      failure / throw soft-fall, malformed pending-row skip, replyTo
 *      precedence, no-email skip, not_configured retry, mid-batch send
 *      throw, top-level query failure, ttlMinutes override.
 *   6. SQL contract on db.getUsersForPendingQuickInvoiceNudge — every gate
 *      column is asserted, including the mutual-exclusion gates with the
 *      generic 48h/7d nudges.
 *   7. db.markPendingQuickInvoiceNudgeSent — IS NULL guard + falsy short-
 *      circuit.
 *   8. Job wiring: NODE_ENV=test guard, force-accept, double-start refusal,
 *      cron tick invocation, DEFAULT_SCHEDULE strictly earlier than the
 *      generic nudges.
 *
 * Run: NODE_ENV=test node tests/pending-quick-invoice-nudge.test.js
 */

const assert = require('assert');

const pending = require('../jobs/pending-quick-invoice-nudge');

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
    pending_quick_invoice: { client_name: 'Acme Corp', description: 'Logo design', amount: '500' },
    pending_quick_invoice_updated_at: new Date('2026-05-22T00:00:00Z'),
    ...over
  };
}

// ---- parsePendingPayload -----------------------------------------------

test('parsePendingPayload: parses an object with all fields', () => {
  const p = pending.parsePendingPayload({ client_name: 'Acme', description: 'Design', amount: '500' });
  assert.deepStrictEqual(p, { clientName: 'Acme', description: 'Design', amount: '500' });
});

test('parsePendingPayload: parses a stringified JSON value (legacy driver / test stub tolerance)', () => {
  const p = pending.parsePendingPayload('{"client_name":"Acme","amount":"100"}');
  assert.strictEqual(p && p.clientName, 'Acme');
  assert.strictEqual(p && p.amount, '100');
});

test('parsePendingPayload: null / non-object / unparseable → null', () => {
  assert.strictEqual(pending.parsePendingPayload(null), null);
  assert.strictEqual(pending.parsePendingPayload(undefined), null);
  assert.strictEqual(pending.parsePendingPayload(42), null);
  assert.strictEqual(pending.parsePendingPayload('not json'), null);
  assert.strictEqual(pending.parsePendingPayload('[1,2,3]'), null,
    'arrays are not objects in our schema — treat as missing');
});

test('parsePendingPayload: all-empty-after-trim → null (no displayable signal)', () => {
  assert.strictEqual(
    pending.parsePendingPayload({ client_name: '', description: '   ', amount: null }),
    null
  );
});

test('parsePendingPayload: trims surrounding whitespace on every field', () => {
  const p = pending.parsePendingPayload({ client_name: '  Acme  ', description: '\tDesign\n', amount: ' 500 ' });
  assert.strictEqual(p.clientName, 'Acme');
  assert.strictEqual(p.description, 'Design');
  assert.strictEqual(p.amount, '500');
});

test('parsePendingPayload: oversize values get an ellipsis truncation', () => {
  const longClient = 'X'.repeat(120);
  const longDesc = 'Y'.repeat(120);
  const p = pending.parsePendingPayload({ client_name: longClient, description: longDesc, amount: '$1' });
  assert.ok(p.clientName.length <= 61, 'client truncated within CLIENT_DISPLAY_MAX + 1 ellipsis char');
  assert.ok(p.clientName.endsWith('…'));
  assert.ok(p.description.length <= 81, 'description truncated within DESCRIPTION_DISPLAY_MAX + 1 char');
  assert.ok(p.description.endsWith('…'));
});

test('parsePendingPayload: non-string fields coerce to empty', () => {
  const p = pending.parsePendingPayload({ client_name: 'OK', description: 42, amount: { evil: true } });
  assert.strictEqual(p.clientName, 'OK');
  assert.strictEqual(p.description, '');
  assert.strictEqual(p.amount, '');
});

// ---- formatAmountDisplay -----------------------------------------------

test('formatAmountDisplay: numeric → adds leading $', () => {
  assert.strictEqual(pending.formatAmountDisplay('500'), '$500');
  assert.strictEqual(pending.formatAmountDisplay('1234.50'), '$1234.50');
});

test('formatAmountDisplay: comma-separated numeric is recognised', () => {
  assert.strictEqual(pending.formatAmountDisplay('1,234.50'), '$1,234.50');
});

test('formatAmountDisplay: existing currency prefix passes through unchanged', () => {
  assert.strictEqual(pending.formatAmountDisplay('$500'), '$500');
  assert.strictEqual(pending.formatAmountDisplay('£250'), '£250');
});

test('formatAmountDisplay: non-numeric strings pass through as-is (no $TBD render)', () => {
  assert.strictEqual(pending.formatAmountDisplay('TBD'), 'TBD');
  assert.strictEqual(pending.formatAmountDisplay('see contract'), 'see contract');
});

test('formatAmountDisplay: zero / negative numeric → raw string (no $-0)', () => {
  assert.strictEqual(pending.formatAmountDisplay('0'), '0');
  assert.strictEqual(pending.formatAmountDisplay('-50'), '-50');
});

test('formatAmountDisplay: empty / whitespace → empty string', () => {
  assert.strictEqual(pending.formatAmountDisplay(''), '');
  assert.strictEqual(pending.formatAmountDisplay('   '), '');
  assert.strictEqual(pending.formatAmountDisplay(null), '');
});

// ---- buildHeadline -----------------------------------------------------

test('buildHeadline: client + amount → specific copy with both', () => {
  const h = pending.buildHeadline({ clientName: 'Acme', amount: '500' });
  assert.match(h, /\$500/);
  assert.match(h, /Acme/);
  assert.match(h, /half-typed/);
});

test('buildHeadline: client only → "started an invoice for"', () => {
  const h = pending.buildHeadline({ clientName: 'Acme', description: '', amount: '' });
  assert.match(h, /You started an invoice for Acme/);
});

test('buildHeadline: amount only → "Your $X invoice"', () => {
  const h = pending.buildHeadline({ clientName: '', description: '', amount: '750' });
  assert.match(h, /\$750/);
  assert.match(h, /half-typed/);
});

test('buildHeadline: description only → "Your invoice for <desc>"', () => {
  const h = pending.buildHeadline({ clientName: '', description: 'Logo redesign', amount: '' });
  assert.match(h, /Logo redesign/);
});

test('buildHeadline: client + description → both surface', () => {
  const h = pending.buildHeadline({ clientName: 'Acme', description: 'Logo redesign', amount: '' });
  assert.match(h, /Acme/);
  assert.match(h, /Logo redesign/);
});

test('buildHeadline: null payload → generic fallback', () => {
  assert.match(pending.buildHeadline(null), /[Pp]ick up where you left off/);
});

test('buildHeadline: never produces "$" without a value', () => {
  const h = pending.buildHeadline({ clientName: 'Acme', amount: '' });
  assert.ok(!/\$\s/.test(h), 'no orphan $');
});

// ---- Subject / HTML / Text ---------------------------------------------

test('subject: mirrors the headline (no emoji, no marketing-y exclamation)', () => {
  const s = pending.buildPendingQuickInvoiceNudgeSubject(cohortRow());
  assert.match(s, /Acme Corp/);
  assert.match(s, /\$500/);
  assert.ok(!/!/.test(s), 'no "!" — reads spammy on a re-engagement email');
});

test('html: surfaces every populated field with strong XSS escape', () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const html = pending.buildPendingQuickInvoiceNudgeHtml(cohortRow({
    pending_quick_invoice: { client_name: '<b>Acme</b>', description: '"alert"', amount: '500' }
  }));
  assert.match(html, /Hi Sam,/);
  assert.match(html, /Client:.*&lt;b&gt;Acme&lt;\/b&gt;/);
  assert.match(html, /What you did:.*&quot;alert&quot;/);
  assert.match(html, /Amount:.*\$500/);
  assert.ok(!/<b>Acme<\/b>/.test(html), 'raw HTML must be escaped');
});

test('html: greeting falls back name → business_name → "there"', () => {
  const h1 = pending.buildPendingQuickInvoiceNudgeHtml(cohortRow({ name: 'Alice' }));
  assert.match(h1, /Hi Alice,/);
  const h2 = pending.buildPendingQuickInvoiceNudgeHtml(cohortRow({ name: null, business_name: 'Studio Q' }));
  assert.match(h2, /Hi Studio Q,/);
  const h3 = pending.buildPendingQuickInvoiceNudgeHtml(cohortRow({ name: null, business_name: null }));
  assert.match(h3, /Hi there,/);
});

test('html: CTA omitted when APP_URL is unset (graceful degradation)', () => {
  delete process.env.APP_URL;
  const html = pending.buildPendingQuickInvoiceNudgeHtml(cohortRow());
  assert.ok(!/<a href=/.test(html), 'no CTA anchor without APP_URL');
  // Body copy still surfaces — the email is just less actionable, not broken.
  assert.match(html, /half-typed/);
});

test('html: magicLoginUrl opt bakes auto-sign-in URL into primary CTA with ?next=/invoices/quick', () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const magicUrl = 'https://decentinvoice.com/auth/magic/tok-abc';
  const html = pending.buildPendingQuickInvoiceNudgeHtml(cohortRow(), null, {
    magicLoginUrl: magicUrl,
    payload: pending.parsePendingPayload(cohortRow().pending_quick_invoice)
  });
  assert.match(html, /\/auth\/magic\/tok-abc\?next=\/invoices\/quick/);
  assert.ok(!/href="https:\/\/decentinvoice\.com\/invoices\/quick"/.test(html),
    'plain /invoices/quick CTA is replaced by the magic URL');
});

test('html: whitespace-only magicLoginUrl falls back to plain /invoices/quick', () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const html = pending.buildPendingQuickInvoiceNudgeHtml(cohortRow(), null, {
    magicLoginUrl: '   ',
    payload: pending.parsePendingPayload(cohortRow().pending_quick_invoice)
  });
  assert.match(html, /https:\/\/decentinvoice\.com\/invoices\/quick/);
  assert.ok(!/\/auth\/magic\//.test(html));
});

test('text: surfaces fields + headline + CTA (trailing slash on APP_URL trimmed)', () => {
  process.env.APP_URL = 'https://decentinvoice.com/';
  const text = pending.buildPendingQuickInvoiceNudgeText(cohortRow({ name: 'Sam' }));
  assert.match(text, /Hi Sam/);
  assert.match(text, /Client: Acme Corp/);
  assert.match(text, /Amount: \$500/);
  assert.match(text, /https:\/\/decentinvoice\.com\/invoices\/quick/);
  assert.match(text, /https:\/\/decentinvoice\.com\/dashboard/);
});

test('html: suppresses detail bullets that have no value (no empty "Client:" line)', () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const html = pending.buildPendingQuickInvoiceNudgeHtml(cohortRow({
    pending_quick_invoice: { client_name: '', description: '', amount: '300' }
  }));
  assert.match(html, /Amount:.*\$300/);
  assert.ok(!/Client:/.test(html), 'no orphan "Client:" line when client_name is empty');
  assert.ok(!/What you did:/.test(html), 'no orphan "What you did:" line when description is empty');
});

test('NUDGE_TTL_MINUTES is 7 days', () => {
  assert.strictEqual(pending.NUDGE_TTL_MINUTES, 7 * 24 * 60);
});

test('DEFAULT_MIN_AGE_HOURS is 24', () => {
  assert.strictEqual(pending.DEFAULT_MIN_AGE_HOURS, 24);
});

test('DEFAULT_SCHEDULE fires strictly before the other re-engagement nudges', () => {
  // 09:00 UTC < 11:00 UTC (stale-draft) < 12:00 UTC (no-invoice) < 13:00 UTC (second)
  // — pending nudge runs first since it's the strongest signal.
  assert.strictEqual(pending.DEFAULT_SCHEDULE, '0 9 * * *');
});

// ---- Orchestrator ------------------------------------------------------

function fakeDb(rows = []) {
  const stamped = [];
  return {
    rows,
    stamped,
    async getUsersForPendingQuickInvoiceNudge() { return rows; },
    async markPendingQuickInvoiceNudgeSent(userId) {
      stamped.push(userId);
      return { id: userId, pending_invoice_nudge_sent_at: new Date() };
    }
  };
}

test('happy path: sends one email + stamps user', async () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const sends = [];
  const db = fakeDb([cohortRow({ id: 42, email: 'sam@test.io', name: 'Sam' })]);
  const summary = await pending.processPendingQuickInvoiceNudges({
    db,
    sendEmail: async (p) => { sends.push(p); return { ok: true, id: 'em_1' }; },
    mintMagicLoginToken: async () => ({ ok: false, reason: 'stubbed' }),
    now: new Date('2026-05-23T09:00:00Z'),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.found, 1);
  assert.strictEqual(summary.sent, 1);
  assert.strictEqual(summary.errors, 0);
  assert.strictEqual(summary.notConfigured, 0);
  assert.deepStrictEqual(db.stamped, [42]);
  assert.strictEqual(sends.length, 1);
  assert.strictEqual(sends[0].to, 'sam@test.io');
  assert.match(sends[0].subject, /Acme Corp/);
  assert.match(sends[0].html, /Hi Sam/);
  assert.match(sends[0].html, /Acme Corp/);
});

test('magic-login: mints once per cohort row + bakes per-user URL (cross-row leak guard)', async () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const sends = [];
  const mintCalls = [];
  const db = fakeDb([
    cohortRow({ id: 7, email: 'a@a.com', name: 'A',
      pending_quick_invoice: { client_name: 'Aco', amount: '100' } }),
    cohortRow({ id: 8, email: 'b@b.com', name: 'B',
      pending_quick_invoice: { client_name: 'Bco', amount: '200' } })
  ]);
  await pending.processPendingQuickInvoiceNudges({
    db,
    sendEmail: async (p) => { sends.push(p); return { ok: true, id: 'em' }; },
    mintMagicLoginToken: async (_db, userId, opts) => {
      mintCalls.push({ userId, opts });
      return { ok: true, url: `https://decentinvoice.com/auth/magic/tok-${userId}`, ttlMinutes: opts.ttlMinutes };
    },
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(mintCalls.length, 2, 'mint called once per cohort row');
  assert.strictEqual(mintCalls[0].userId, 7);
  assert.strictEqual(mintCalls[0].opts.ttlMinutes, pending.NUDGE_TTL_MINUTES);
  assert.match(sends[0].html, /\/auth\/magic\/tok-7\?next=\/invoices\/quick/);
  assert.match(sends[1].html, /\/auth\/magic\/tok-8\?next=\/invoices\/quick/);
  assert.ok(!/\/auth\/magic\/tok-7/.test(sends[1].html),
    'user 8 must NOT receive user 7 token');
  // Per-row payload too — user 7 sees their pending, user 8 sees theirs.
  assert.match(sends[0].html, /Aco/);
  assert.match(sends[1].html, /Bco/);
  assert.ok(!/Aco/.test(sends[1].html), 'user 8 must NOT see user 7 pending data');
});

test('magic-login: mint failure soft-falls to plain CTA, email still ships and stamps', async () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const sends = [];
  const warns = [];
  const db = fakeDb([cohortRow({ id: 99, email: 'q@q.com', name: 'Q' })]);
  const summary = await pending.processPendingQuickInvoiceNudges({
    db,
    sendEmail: async (p) => { sends.push(p); return { ok: true }; },
    mintMagicLoginToken: async () => ({ ok: false, reason: 'db_error' }),
    log: { error: () => {}, warn: (...a) => warns.push(a), log: () => {} }
  });
  assert.strictEqual(summary.sent, 1);
  assert.deepStrictEqual(db.stamped, [99]);
  assert.match(sends[0].html, /https:\/\/decentinvoice\.com\/invoices\/quick/);
  assert.ok(!/\/auth\/magic\//.test(sends[0].html));
  assert.ok(warns.some(args => /magic-link mint skipped/.test(args.join(' '))));
});

test('magic-login: mint throw soft-falls (no error counted, email still ships)', async () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const sends = [];
  const db = fakeDb([cohortRow({ id: 5, email: 'z@z.com' })]);
  const summary = await pending.processPendingQuickInvoiceNudges({
    db,
    sendEmail: async (p) => { sends.push(p); return { ok: true }; },
    mintMagicLoginToken: async () => { throw new Error('mint exploded'); },
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.sent, 1);
  assert.strictEqual(summary.errors, 0,
    'mint throw must NOT count as a send error');
});

test('malformed pending payload is skipped without a send or stamp', async () => {
  const sends = [];
  const db = fakeDb([
    cohortRow({ id: 1, email: 'a@a.com', pending_quick_invoice: 'not json at all' }),
    cohortRow({ id: 2, email: 'b@b.com',
      pending_quick_invoice: { client_name: '', description: '', amount: '' } }),
    cohortRow({ id: 3, email: 'c@c.com',
      pending_quick_invoice: { client_name: 'OK', amount: '50' } })
  ]);
  const summary = await pending.processPendingQuickInvoiceNudges({
    db,
    sendEmail: async (p) => { sends.push(p); return { ok: true }; },
    mintMagicLoginToken: async () => ({ ok: false }),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.found, 3);
  assert.strictEqual(summary.sent, 1, 'only the OK row sends');
  assert.strictEqual(summary.skipped, 2, 'both malformed rows skipped');
  assert.deepStrictEqual(db.stamped, [3]);
  assert.strictEqual(sends.length, 1);
  assert.strictEqual(sends[0].to, 'c@c.com');
});

test('replyTo precedence: reply_to_email > business_email > email', async () => {
  const sends = [];
  const db = fakeDb([
    cohortRow({ id: 1, email: 'fb@x.com', reply_to_email: 'r@x.com', business_email: 'b@x.com' }),
    cohortRow({ id: 2, email: 'fb@y.com', reply_to_email: null, business_email: 'b@y.com' }),
    cohortRow({ id: 3, email: 'fb@z.com', reply_to_email: null, business_email: null })
  ]);
  await pending.processPendingQuickInvoiceNudges({
    db,
    sendEmail: async (p) => { sends.push(p); return { ok: true }; },
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(sends[0].replyTo, 'r@x.com');
  assert.strictEqual(sends[1].replyTo, 'b@y.com');
  assert.strictEqual(sends[2].replyTo, 'fb@z.com');
});

test('users without email are skipped (defence-in-depth, SQL gate is the primary)', async () => {
  const sends = [];
  const db = fakeDb([cohortRow({ id: 9, email: null })]);
  const summary = await pending.processPendingQuickInvoiceNudges({
    db,
    sendEmail: async (p) => { sends.push(p); return { ok: true }; },
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.sent, 0);
  assert.strictEqual(summary.skipped, 1);
  assert.strictEqual(sends.length, 0);
  assert.deepStrictEqual(db.stamped, []);
});

test('not_configured does NOT stamp (next cron pass retries)', async () => {
  const db = fakeDb([cohortRow({ id: 99, email: 'foo@bar.com' })]);
  const summary = await pending.processPendingQuickInvoiceNudges({
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

test('mid-batch send error continues batch; only successful sends stamp', async () => {
  const db = fakeDb([
    cohortRow({ id: 1, email: 'a@a.com' }),
    cohortRow({ id: 2, email: 'b@b.com' })
  ]);
  let i = 0;
  const summary = await pending.processPendingQuickInvoiceNudges({
    db,
    sendEmail: async () => {
      i += 1;
      if (i === 1) throw new Error('Resend boom');
      return { ok: true };
    },
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.found, 2);
  assert.strictEqual(summary.sent, 1);
  assert.strictEqual(summary.errors, 1);
  assert.deepStrictEqual(db.stamped, [2], 'first row was a throw, only second stamped');
});

test('top-level query failure → errors=1, no throw', async () => {
  const db = {
    async getUsersForPendingQuickInvoiceNudge() { throw new Error('PG down'); }
  };
  const summary = await pending.processPendingQuickInvoiceNudges({
    db,
    sendEmail: async () => ({ ok: true }),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.errors, 1);
  assert.strictEqual(summary.sent, 0);
  assert.strictEqual(summary.found, 0);
});

test('ttlMinutes override is threaded into mintMagicLoginToken', async () => {
  let captured = null;
  const db = fakeDb([cohortRow({ id: 1, email: 'a@a.com' })]);
  await pending.processPendingQuickInvoiceNudges({
    db,
    sendEmail: async () => ({ ok: true }),
    mintMagicLoginToken: async (_db, _uid, opts) => {
      captured = opts;
      return { ok: true, url: 'https://x/m/t' };
    },
    ttlMinutes: 999,
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(captured && captured.ttlMinutes, 999);
});

test('minAgeHours opt is threaded into the db query', async () => {
  let captured = null;
  const db = {
    async getUsersForPendingQuickInvoiceNudge(hours) { captured = hours; return []; }
  };
  await pending.processPendingQuickInvoiceNudges({
    db,
    sendEmail: async () => ({ ok: true }),
    minAgeHours: 36,
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(captured, 36);
});

// ---- Cron wiring -------------------------------------------------------

test('startPendingQuickInvoiceNudgeJob: NODE_ENV=test refuses unless force', () => {
  const r = pending.startPendingQuickInvoiceNudgeJob();
  assert.deepStrictEqual(r, { ok: false, reason: 'test_env' });
});

test('startPendingQuickInvoiceNudgeJob: force-accepts with stubbed cron', () => {
  pending.stopPendingQuickInvoiceNudgeJob(); // belt-and-braces
  const fakeCron = {
    schedule: () => ({ stop: () => {} })
  };
  const r = pending.startPendingQuickInvoiceNudgeJob({ force: true, cron: fakeCron });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.schedule, pending.DEFAULT_SCHEDULE);
  // Double-start refusal
  const r2 = pending.startPendingQuickInvoiceNudgeJob({ force: true, cron: fakeCron });
  assert.deepStrictEqual(r2, { ok: false, reason: 'already_running' });
  pending.stopPendingQuickInvoiceNudgeJob();
});

test('startPendingQuickInvoiceNudgeJob: cron tick calls processPendingQuickInvoiceNudges', async () => {
  pending.stopPendingQuickInvoiceNudgeJob();
  let tickFn = null;
  const fakeCron = {
    schedule: (_sched, fn) => {
      tickFn = fn;
      return { stop: () => {} };
    }
  };
  const db = fakeDb([]);
  pending.startPendingQuickInvoiceNudgeJob({
    force: true,
    cron: fakeCron,
    db,
    sendEmail: async () => ({ ok: true }),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(typeof tickFn, 'function', 'schedule callback captured');
  await tickFn();
  // Successful tick on an empty cohort exits cleanly.
  pending.stopPendingQuickInvoiceNudgeJob();
});

// ---- SQL contract on db.getUsersForPendingQuickInvoiceNudge ------------

test('SQL: query gates on invoice_count=0, welcome, pending_quick_invoice NOT NULL, mutual-exclusion stamps, age', async () => {
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
    await db.getUsersForPendingQuickInvoiceNudge(24);
    assert.ok(captured, 'query was issued');
    assert.match(captured.sql, /invoice_count\s*=\s*0/i,
      'invoice_count=0 gate — no real invoice ever created');
    assert.match(captured.sql, /welcome_email_sent_at\s+IS\s+NOT\s+NULL/i,
      'welcome must have fired before this nudge — activation ordering');
    assert.match(captured.sql, /pending_quick_invoice\s+IS\s+NOT\s+NULL/i,
      'cohort signal — the autosave row exists');
    assert.match(captured.sql, /pending_quick_invoice_updated_at\s+IS\s+NOT\s+NULL/i,
      'age threshold needs a timestamp to compare against');
    assert.match(captured.sql, /pending_invoice_nudge_sent_at\s+IS\s+NULL/i,
      'one-shot idempotency on this stamp');
    assert.match(captured.sql, /no_invoice_nudge_sent_at\s+IS\s+NULL/i,
      'mutual-exclusion with the generic 48h nudge — one activation email per user');
    assert.match(captured.sql, /second_no_invoice_nudge_sent_at\s+IS\s+NULL/i,
      'mutual-exclusion with the generic 7d nudge — one activation email per user');
    assert.match(captured.sql, /email\s+IS\s+NOT\s+NULL/i,
      'email gate — defence in depth');
    assert.match(captured.sql, /pending_quick_invoice_updated_at\s*<=\s*NOW\(\)\s*-\s*\(\$1\s*\*\s*INTERVAL\s*'1 hour'\)/i,
      'age anchors on autosave timestamp, not signup — recency of the typed signal');
    assert.match(captured.sql, /ORDER BY\s+pending_quick_invoice_updated_at\s+ASC/i,
      'oldest pending first — drain backlog deterministically');
    assert.deepStrictEqual(captured.params, [24]);
  } finally {
    realPool.query = originalQuery;
  }
});

test('SQL: input sanitization — non-numeric / negative minAgeHours falls back to default 24', async () => {
  delete require.cache[require.resolve('../db')];
  const realDbMod = require('../db');
  const realPool = realDbMod.pool;
  const db = realDbMod.db;
  let captured = null;
  const originalQuery = realPool.query.bind(realPool);
  realPool.query = async (sql, params) => { captured = { sql, params }; return { rows: [] }; };
  try {
    await db.getUsersForPendingQuickInvoiceNudge(-5);
    assert.deepStrictEqual(captured.params, [24], 'negative coerces to default 24');
    await db.getUsersForPendingQuickInvoiceNudge('abc');
    assert.deepStrictEqual(captured.params, [24], 'non-numeric coerces to default 24');
  } finally {
    realPool.query = originalQuery;
  }
});

test('db.markPendingQuickInvoiceNudgeSent: IS NULL guard + falsy-userId short-circuit', async () => {
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
    return { rows: [{ id: params[0], pending_invoice_nudge_sent_at: new Date() }] };
  };
  try {
    assert.strictEqual(await db.markPendingQuickInvoiceNudgeSent(null), null);
    assert.strictEqual(await db.markPendingQuickInvoiceNudgeSent(0), null);
    assert.strictEqual(await db.markPendingQuickInvoiceNudgeSent(undefined), null);
    assert.strictEqual(calls, 0, 'no SQL must be issued for falsy userId');
    const r = await db.markPendingQuickInvoiceNudgeSent(7);
    assert.ok(r && r.id === 7);
    assert.match(captured.sql, /UPDATE\s+users\s+SET\s+pending_invoice_nudge_sent_at\s*=\s*NOW\(\)/i);
    assert.match(captured.sql, /pending_invoice_nudge_sent_at\s+IS\s+NULL/i,
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
      console.error(err && err.stack ? err.stack : err);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
