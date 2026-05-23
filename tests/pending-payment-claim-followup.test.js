'use strict';

/*
 * Pending-Payment-Claim Follow-up Email — 48h+ second-pass nudge cron.
 *
 * Coverage mirrors tests/client-viewed-followup.test.js patterns:
 *   1. Subject + HTML + text formatters: XSS escape, day-since-claimed
 *      anchor, method label, reference/note conditional surfacing, CTA URL
 *      with/without APP_URL, framing distinct from sendPaymentClaimedEmail.
 *   2. daysSinceClaimed() arithmetic — exact 48h, 5d, garbage.
 *   3. Happy path: claimed-unpaid row → email sent + invoice stamp written.
 *   4. Skips rows without an email (defence-in-depth).
 *   5. not_configured (RESEND key unset) → no stamp, retries next tick.
 *   6. sendEmail throw → counts an error, batch continues, no stamp.
 *   7. Magic-login bake-in: per-row mint + cross-row leak guard +
 *      mint-fail soft-fall + ttlMinutes override + safeNextPath compat.
 *   8. Top-level query failure → errors=1, no throw.
 *   9. startPaymentClaimFollowupJob blocked under NODE_ENV=test; accepts force.
 *  10. Cron tick wires processPaymentClaimFollowup through correctly.
 *  11. Double start refused.
 *  12. DEFAULT_SCHEDULE shape.
 *  13. SQL contract checks on db.getInvoicesForPaymentClaimFollowup — the
 *      production query gates on status<>'paid', is_seed=false,
 *      payment_claimed_at IS NOT NULL, the min/max age window, the per-
 *      invoice cooldown, and welcome_email_sent_at IS NOT NULL.
 *  14. db.markPaymentClaimFollowupSent — falsy-id short-circuit + UPDATE
 *      shape with re-asserted NULL guard.
 *
 * Run: NODE_ENV=test node tests/pending-payment-claim-followup.test.js
 */

const assert = require('assert');

const followup = require('../jobs/pending-payment-claim-followup');
const emailLib = require('../lib/email');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function claimRow(over = {}) {
  return {
    invoice_id: 71,
    user_id: 42,
    invoice_number: 'INV-2026-0003',
    client_name: 'Acme Co',
    invoice_total: '1500.00',
    payment_claimed_at: new Date('2026-05-14T00:00:00Z'),
    payment_claim_method: 'venmo',
    payment_claim_reference: '@acme-finance',
    payment_claim_note: 'Sent Tuesday — confirmation #ABC123',
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

test('subject: includes client name + invoice number + reminder framing', () => {
  const subj = emailLib.buildPaymentClaimFollowupSubject(claimRow());
  assert.match(subj, /Acme Co/);
  assert.match(subj, /INV-2026-0003/);
  assert.match(subj, /Reminder/);
  assert.match(subj, /reported paying/);
});

test('subject: distinct framing from sendPaymentClaimedEmail real-time subject', () => {
  // The real-time email is "Your client reports payment sent for invoice X".
  // The follow-up is a SECOND-pass nudge — it must read like a reminder, not
  // a fresh event, otherwise the freelancer dismisses it as a dupe.
  const fresh = emailLib.buildPaymentClaimedSubject(claimRow());
  const followupSubj = emailLib.buildPaymentClaimFollowupSubject(claimRow());
  assert.notStrictEqual(fresh, followupSubj,
    'follow-up subject must be visually distinct from the original claim subject');
  assert.match(followupSubj, /Reminder/i,
    'follow-up framing — never reads as a fresh notification');
});

test('subject: missing invoice_number + client_name degrade gracefully', () => {
  const subj = emailLib.buildPaymentClaimFollowupSubject(
    claimRow({ invoice_number: null, client_name: null })
  );
  assert.match(subj, /Your client/);
  assert.match(subj, /your invoice/i);
});

test('html: escapes hostile name + client + threads CTA URL when APP_URL is set', () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const html = emailLib.buildPaymentClaimFollowupHtml(claimRow({
    name: '<script>alert(1)</script>',
    client_name: 'X & Co <em>',
    invoice_number: 'INV-2026-0003',
    invoice_total: '1500.00',
    payment_claimed_at: new Date('2026-05-14T00:00:00Z')
  }), new Date('2026-05-16T00:00:00Z'));

  assert.ok(!/<script>alert\(1\)<\/script>/.test(html),
    'raw script must be escaped (XSS defence)');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /X &amp; Co/);
  assert.match(html, /INV-2026-0003/);
  assert.match(html, /\$1500\.00/, 'total must be money-formatted');
  assert.match(html, /2 days ago/, 'days-since-claimed anchor inline in body');
  assert.match(html, /https:\/\/decentinvoice\.com\/invoices\/71/,
    'CTA must deep-link to /invoices/<id> (where Mark-as-Paid lives)');
  assert.match(html, /Confirm receipt/, 'CTA copy includes "Confirm receipt"');
  assert.match(html, /mark paid/i, 'CTA copy includes "mark paid"');
});

test('html: surfaces method label + reference + note when set', () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const html = emailLib.buildPaymentClaimFollowupHtml(claimRow({
    payment_claim_method: 'venmo',
    payment_claim_reference: '@acme-finance',
    payment_claim_note: 'Sent Tuesday — confirmation #ABC123'
  }), new Date('2026-05-16T11:00:00Z'));
  assert.match(html, /Venmo/, 'method label "Venmo" rendered');
  assert.match(html, /Reference/, 'reference label rendered');
  assert.match(html, /@acme-finance/, 'reference value rendered');
  assert.match(html, /Sent Tuesday/, 'client note rendered');
});

test('html: reference + note lines suppressed when unset', () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const html = emailLib.buildPaymentClaimFollowupHtml(claimRow({
    payment_claim_reference: null,
    payment_claim_note: null
  }), new Date('2026-05-16T11:00:00Z'));
  assert.ok(!/Reference/.test(html), 'no Reference: line when reference is null');
  // The note styling carries a left-border; absence of that distinctive style is
  // the easiest signal it didn't render.
  assert.ok(!/border-left:3px solid #d1d5db/.test(html),
    'no note block when note is null');
});

test('html: method falls back to "Other" on unknown / missing method', () => {
  const html = emailLib.buildPaymentClaimFollowupHtml(
    claimRow({ payment_claim_method: 'bitcoin', payment_claim_reference: null, payment_claim_note: null }),
    new Date('2026-05-16T11:00:00Z')
  );
  assert.match(html, /Other/, 'unknown method falls back to "Other"');
  const html2 = emailLib.buildPaymentClaimFollowupHtml(
    claimRow({ payment_claim_method: null, payment_claim_reference: null, payment_claim_note: null }),
    new Date('2026-05-16T11:00:00Z')
  );
  assert.match(html2, /Other/, 'null method falls back to "Other"');
});

test('html: hostile reference + note are HTML-escaped', () => {
  const html = emailLib.buildPaymentClaimFollowupHtml(claimRow({
    payment_claim_reference: '<img src=x onerror=alert(1)>',
    payment_claim_note: '<script>steal()</script>'
  }), new Date('2026-05-16T11:00:00Z'));
  assert.ok(!/<img src=x/.test(html), 'hostile reference must be escaped');
  assert.ok(!/<script>steal/.test(html), 'hostile note must be escaped');
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script&gt;/);
});

test('html: CTA omitted gracefully when APP_URL is unset (no broken-link button)', () => {
  delete process.env.APP_URL;
  const html = emailLib.buildPaymentClaimFollowupHtml(
    claimRow(),
    new Date('2026-05-16T00:00:00Z')
  );
  assert.ok(!/<a href=/.test(html),
    'no CTA <a> when APP_URL is unset — graceful degradation');
  assert.match(html, /reported paying/, 'body copy remains');
});

test('html: day floor — never "0 days ago" or "1 day ago" (cohort gate is 48h+)', () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  // 24h elapsed — would normally floor to "1 day" but cohort gate is 48h+
  // so we floor at 2 days to keep copy consistent with the gate.
  const html = emailLib.buildPaymentClaimFollowupHtml(
    claimRow({ payment_claimed_at: new Date('2026-05-16T00:00:00Z') }),
    new Date('2026-05-17T00:00:00Z')
  );
  assert.match(html, /2 days ago/, 'floor at 2 days even if math says 1');
});

test('text: includes greeting, day anchor, client + CTA URL with trimmed trailing slash', () => {
  process.env.APP_URL = 'https://decentinvoice.com/';
  const txt = emailLib.buildPaymentClaimFollowupText(claimRow({
    name: 'Sam',
    invoice_number: 'INV-2026-0003',
    payment_claimed_at: new Date('2026-05-14T00:00:00Z')
  }), new Date('2026-05-16T00:00:00Z'));
  assert.match(txt, /Hi Sam,/);
  assert.match(txt, /INV-2026-0003/);
  assert.match(txt, /2 days ago/);
  assert.match(txt, /\$1500\.00/);
  // Trailing slash on APP_URL must be trimmed before the path is appended,
  // otherwise the URL becomes `https://x.com//invoices/71`.
  assert.match(txt, /https:\/\/decentinvoice\.com\/invoices\/71/);
  assert.ok(!/https:\/\/decentinvoice\.com\/\/invoices\//.test(txt),
    'double-slash bug regression guard');
});

test('text: surfaces method + reference + note block when set', () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const txt = emailLib.buildPaymentClaimFollowupText(claimRow({
    payment_claim_method: 'venmo',
    payment_claim_reference: '@acme-finance',
    payment_claim_note: 'Sent Tuesday — confirmation #ABC123'
  }), new Date('2026-05-16T11:00:00Z'));
  assert.match(txt, /Method: Venmo/);
  assert.match(txt, /Reference: @acme-finance/);
  assert.match(txt, /Note from your client/);
  assert.match(txt, /confirmation #ABC123/);
});

// ---- daysSinceClaimed arithmetic ---------------------------------------

test('daysSinceClaimed: exact 48h elapsed → 2', () => {
  const claimedAt = new Date('2026-05-14T00:00:00Z');
  const now = new Date('2026-05-16T00:00:00Z');
  assert.strictEqual(emailLib.daysSinceClaimed(claimedAt, now), 2);
});

test('daysSinceClaimed: 5 days elapsed → 5', () => {
  const claimedAt = new Date('2026-05-10T00:00:00Z');
  const now = new Date('2026-05-15T00:00:00Z');
  assert.strictEqual(emailLib.daysSinceClaimed(claimedAt, now), 5);
});

test('daysSinceClaimed: null / garbage / future returns safe 0', () => {
  assert.strictEqual(emailLib.daysSinceClaimed(null, new Date()), 0);
  assert.strictEqual(emailLib.daysSinceClaimed('not-a-date', new Date()), 0);
  const future = new Date('2030-01-01T00:00:00Z');
  const now = new Date('2026-05-16T00:00:00Z');
  // Future timestamps return 0 (negative diff floored to 0 by Math.max).
  assert.strictEqual(emailLib.daysSinceClaimed(future, now), 0);
});

// ---- Orchestrator tests ------------------------------------------------

function fakeDb(rows = []) {
  const stamped = [];
  return {
    rows,
    stamped,
    async getInvoicesForPaymentClaimFollowup() { return rows; },
    async markPaymentClaimFollowupSent(invoiceId) {
      stamped.push(invoiceId);
      return { id: invoiceId, payment_claim_followup_sent_at: new Date() };
    }
  };
}

test('happy path: sends and stamps by invoice_id', async () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const sends = [];
  const db = fakeDb([claimRow({
    invoice_id: 71, user_id: 42, invoice_number: 'INV-2026-0003',
    email: 'sam@test.io', name: 'Sam'
  })]);
  const summary = await followup.processPaymentClaimFollowup({
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
    'must stamp by invoice_id (NOT user_id — multiple pending claims per user are each tracked separately)');
  assert.strictEqual(sends.length, 1);
  assert.strictEqual(sends[0].to, 'sam@test.io');
  assert.match(sends[0].subject, /INV-2026-0003/);
  assert.match(sends[0].subject, /Reminder/);
  assert.match(sends[0].html, /Hi Sam/);
  assert.match(sends[0].text, /Hi Sam/);
});

test('magic-login: mints once per cohort row + bakes the URL into the sent email', async () => {
  process.env.APP_URL = 'https://decentinvoice.com';
  const sends = [];
  const mintCalls = [];
  const db = fakeDb([
    claimRow({ invoice_id: 101, user_id: 7, email: 'a@a.com', name: 'A' }),
    claimRow({ invoice_id: 102, user_id: 8, email: 'b@b.com', name: 'B' })
  ]);
  await followup.processPaymentClaimFollowup({
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
  const db = fakeDb([claimRow({ invoice_id: 7, user_id: 99, email: 'q@q.com', name: 'Q' })]);
  const summary = await followup.processPaymentClaimFollowup({
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
  const db = fakeDb([claimRow({ invoice_id: 31, user_id: 5, email: 'z@z.com' })]);
  const summary = await followup.processPaymentClaimFollowup({
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
  const db = fakeDb([claimRow({ invoice_id: 9, user_id: 1, email: 'a@a.com' })]);
  await followup.processPaymentClaimFollowup({
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
  const html = emailLib.buildPaymentClaimFollowupHtml(
    claimRow({ invoice_id: 42 }),
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
    claimRow({ invoice_id: 1, user_id: 1, email: 'fallback@x.com', reply_to_email: 'reply@x.com', business_email: 'biz@x.com' }),
    claimRow({ invoice_id: 2, user_id: 2, email: 'fallback@y.com', reply_to_email: null, business_email: 'biz@y.com' }),
    claimRow({ invoice_id: 3, user_id: 3, email: 'fallback@z.com', reply_to_email: null, business_email: null })
  ]);
  await followup.processPaymentClaimFollowup({
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
  const db = fakeDb([claimRow({ invoice_id: 9, user_id: 9, email: null })]);
  const summary = await followup.processPaymentClaimFollowup({
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
  const db = fakeDb([claimRow({ invoice_id: 11, user_id: 99, email: 'foo@bar.com' })]);
  const summary = await followup.processPaymentClaimFollowup({
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
    claimRow({ invoice_id: 1, user_id: 1, email: 'a@a.com' }),
    claimRow({ invoice_id: 2, user_id: 2, email: 'b@b.com' })
  ]);
  let calls = 0;
  const summary = await followup.processPaymentClaimFollowup({
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
    async getInvoicesForPaymentClaimFollowup() { throw new Error('PG down'); },
    async markPaymentClaimFollowupSent() { return null; }
  };
  const summary = await followup.processPaymentClaimFollowup({
    db,
    sendEmail: async () => ({ ok: true }),
    now: new Date(),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.errors, 1);
  assert.strictEqual(summary.found, 0);
  assert.strictEqual(summary.sent, 0);
});

test('sendEmail returns ok=false with non-not_configured reason → error count + no stamp', async () => {
  const db = fakeDb([claimRow({ invoice_id: 5, user_id: 1, email: 'x@x.com' })]);
  const summary = await followup.processPaymentClaimFollowup({
    db,
    sendEmail: async () => ({ ok: false, reason: 'rate_limited' }),
    now: new Date('2026-05-16T11:00:00Z'),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(summary.errors, 1);
  assert.strictEqual(summary.sent, 0);
  assert.deepStrictEqual(db.stamped, [], 'non-not_configured failure leaves stamp NULL');
});

// ---- Cron wiring -------------------------------------------------------

test('startPaymentClaimFollowupJob blocked under NODE_ENV=test', () => {
  process.env.NODE_ENV = 'test';
  followup.stopPaymentClaimFollowupJob();
  const r = followup.startPaymentClaimFollowupJob();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'test_env');
});

test('startPaymentClaimFollowupJob: cron tick triggers processPaymentClaimFollowup', async () => {
  followup.stopPaymentClaimFollowupJob();
  let captured = null;
  const fakeCron = {
    schedule(expr, cb, opts) {
      captured = { expr, cb, opts };
      return { stop() {} };
    }
  };
  const db = fakeDb([claimRow({ invoice_id: 51, user_id: 51, email: 'e@e.com' })]);
  let sendCalls = 0;
  const r = followup.startPaymentClaimFollowupJob({
    force: true,
    cron: fakeCron,
    schedule: '0 16 * * *',
    db,
    sendEmail: async () => { sendCalls += 1; return { ok: true }; },
    mintMagicLoginToken: async () => ({ ok: true, url: 'https://x/auth/magic/t' }),
    log: { error: () => {}, warn: () => {}, log: () => {} }
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.schedule, '0 16 * * *');
  assert.ok(captured, 'cron.schedule must be called');
  assert.strictEqual(captured.expr, '0 16 * * *');
  assert.strictEqual(captured.opts && captured.opts.timezone, 'UTC');
  await captured.cb();
  assert.strictEqual(sendCalls, 1, 'cron tick must invoke processPaymentClaimFollowup');
  assert.deepStrictEqual(db.stamped, [51]);
  followup.stopPaymentClaimFollowupJob();
});

test('startPaymentClaimFollowupJob refuses double start', () => {
  followup.stopPaymentClaimFollowupJob();
  const fakeCron = { schedule() { return { stop() {} }; } };
  const r1 = followup.startPaymentClaimFollowupJob({ force: true, cron: fakeCron });
  assert.strictEqual(r1.ok, true);
  const r2 = followup.startPaymentClaimFollowupJob({ force: true, cron: fakeCron });
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.reason, 'already_running');
  followup.stopPaymentClaimFollowupJob();
});

test('DEFAULT_SCHEDULE is 0 16 * * * (16:00 UTC — strictly after sent-not-viewed at 15:00)', () => {
  // Spacing the crons across the hour keeps Resend send-rate spikes spread
  // out. The follow-up sits at the END of the re-engagement chain so any
  // row that fired an earlier nudge today already had its window.
  assert.strictEqual(followup.DEFAULT_SCHEDULE, '0 16 * * *');
  const hourMatch = /^0\s+(\d+)\s+\*\s+\*\s+\*$/.exec(followup.DEFAULT_SCHEDULE);
  assert.ok(hourMatch, 'cron expression must be a fixed-hour daily schedule');
  const hour = parseInt(hourMatch[1], 10);
  // Sanity: must be later than 15:00 (sent-not-viewed) to avoid overlap.
  assert.ok(hour > 15, 'schedule must be strictly after sent-not-viewed-nudge at 15:00');
});

// ---- SQL contract on db.getInvoicesForPaymentClaimFollowup --------------

test('SQL: query gates on status<>paid, is_seed=false, payment_claimed_at, age window, cooldown', async () => {
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
    await db.getInvoicesForPaymentClaimFollowup(48, 14);
    assert.ok(captured, 'query was issued');
    assert.match(captured.sql, /status\s*<>\s*'paid'/i,
      'status predicate excludes paid — only invoices the freelancer hasn\'t confirmed');
    assert.match(captured.sql, /is_seed\s*=\s*false/i,
      'is_seed=false predicate — must NEVER email about the seed sample');
    assert.match(captured.sql, /payment_claimed_at\s+IS\s+NOT\s+NULL/i,
      'payment_claimed_at IS NOT NULL — only invoices the client demonstrably claimed');
    assert.match(captured.sql, /payment_claimed_at\s*<=\s*NOW\(\)\s*-\s*\(\$1\s*\*\s*INTERVAL\s*'1 hour'\)/i,
      'min-age predicate uses the first parameter');
    assert.match(captured.sql, /payment_claimed_at\s*>\s*NOW\(\)\s*-\s*\(\$2\s*\*\s*INTERVAL\s*'1 day'\)/i,
      'max-age predicate uses the second parameter — caps how far back we look');
    assert.match(captured.sql, /payment_claim_followup_sent_at\s+IS\s+NULL/i,
      'cooldown gate — one-shot per invoice');
    assert.match(captured.sql, /welcome_email_sent_at\s+IS\s+NOT\s+NULL/i,
      'welcome_email_sent_at gate — activation ordering');
    assert.match(captured.sql, /u\.email\s+IS\s+NOT\s+NULL/i,
      'email IS NOT NULL — defence-in-depth');
    assert.match(captured.sql, /ORDER\s+BY\s+i\.payment_claimed_at\s+ASC/i,
      'oldest-claimed first — peak urgency ordering');
    assert.match(captured.sql, /LIMIT\s+500/i, 'batch cap');
    assert.match(captured.sql, /payment_claim_method/i,
      'method projection — surfaces in email body');
    assert.match(captured.sql, /payment_claim_reference/i,
      'reference projection — surfaces in email body');
    assert.match(captured.sql, /payment_claim_note/i,
      'note projection — surfaces in email body');
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
    await db.getInvoicesForPaymentClaimFollowup(-5, 'abc');
    assert.deepStrictEqual(captured.params, [48, 14],
      'negative / non-numeric inputs must coerce to safe defaults');
  } finally {
    realPool.query = originalQuery;
  }
});

test('db.markPaymentClaimFollowupSent: returns null when invoiceId is falsy (no SQL issued)', async () => {
  delete require.cache[require.resolve('../db')];
  const realDbMod = require('../db');
  const realPool = realDbMod.pool;
  const db = realDbMod.db;
  let calls = 0;
  const originalQuery = realPool.query.bind(realPool);
  realPool.query = async () => { calls += 1; return { rows: [] }; };
  try {
    assert.strictEqual(await db.markPaymentClaimFollowupSent(null), null);
    assert.strictEqual(await db.markPaymentClaimFollowupSent(0), null);
    assert.strictEqual(await db.markPaymentClaimFollowupSent(undefined), null);
    assert.strictEqual(calls, 0, 'no SQL must be issued for falsy invoiceId');
  } finally {
    realPool.query = originalQuery;
  }
});

test('db.markPaymentClaimFollowupSent: stamping UPDATE re-asserts NULL guard (concurrent-tick safety)', async () => {
  delete require.cache[require.resolve('../db')];
  const realDbMod = require('../db');
  const realPool = realDbMod.pool;
  const db = realDbMod.db;
  let captured = null;
  const originalQuery = realPool.query.bind(realPool);
  realPool.query = async (sql, params) => { captured = { sql, params }; return { rows: [{ id: 71 }] }; };
  try {
    await db.markPaymentClaimFollowupSent(71);
    assert.match(captured.sql, /UPDATE\s+invoices/i);
    assert.match(captured.sql, /SET\s+payment_claim_followup_sent_at\s*=\s*NOW\(\)/i);
    assert.match(captured.sql, /updated_at\s*=\s*NOW\(\)/i,
      'updated_at bump on stamp — keeps last-touched timestamp accurate');
    assert.match(captured.sql, /WHERE\s+id\s*=\s*\$1/i);
    assert.match(captured.sql, /AND\s+payment_claim_followup_sent_at\s+IS\s+NULL/i,
      'NULL guard re-asserted in UPDATE — concurrent ticks cannot double-send');
    assert.match(captured.sql, /RETURNING\s+id,\s+payment_claim_followup_sent_at/i,
      'RETURNING shape — caller observes whether the stamp landed');
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
  console.log(`\n${passed} passed, ${failed} failed (pending-payment-claim-followup.test.js)`);
  if (failed > 0) process.exit(1);
})();
