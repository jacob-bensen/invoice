'use strict';

/*
 * Payment-claim widget tests (Milestone 4 — sent → paid).
 *
 * The client on the public /i/<token> page clicks "I've sent payment", picks
 * a method (Venmo/Zelle/bank/etc.), optionally adds a reference + note, and
 * submits. We:
 *
 *   1. Atomically stamp `invoices.payment_claimed_at` (race-safe via UPDATE
 *      guard on `payment_claimed_at IS NULL AND status != 'paid'`).
 *   2. Fire an email to the FREELANCER with method + reference + note +
 *      "Confirm receipt & mark paid" CTA into the dashboard.
 *   3. Render a confirmation panel on the public page.
 *   4. Surface a "Client reports payment via X" badge on the freelancer's
 *      dashboard the next time they log in.
 *
 * Covers:
 *  - db.recordPaymentClaim: SQL shape (CTE-style UPDATE-then-JOIN; guarded on
 *    payment_claimed_at IS NULL and status != 'paid'; reference/note
 *    coerced to null when falsy), happy-path return shape, already-claimed
 *    returns null without throwing, bad-arg short-circuit.
 *  - db.getInvoiceByPublicToken: SELECT projects the new claim columns.
 *  - lib/email builders: subject names client + invoice number; HTML XSS-
 *    escapes hostile owner name + reference + note; method label rendering;
 *    button gated on APP_URL; text body carries the same facts; missing-
 *    owner / missing-owner-email short-circuit; reply-to precedence;
 *    paymentMethodLabel coerces unknown / hostile values to 'Other'.
 *  - POST /i/:token/payment-claim:
 *      * 404 on bad-format token (no SQL),
 *      * 404 on unknown token,
 *      * idempotent redirect on already-paid invoice (no email, no UPDATE),
 *      * idempotent redirect on already-claimed invoice,
 *      * happy-path: records, fires email exactly once, redirects to /i/<token>?claimed=1,
 *      * unknown-method coerces to 'other' (silently — don't drop the claim),
 *      * reference/note bounds (>200 chars sliced, >1000 chars sliced),
 *      * email rejection survives the route,
 *      * race-loss (recordPaymentClaim returns null) still redirects,
 *      * db throw surfaces 500.
 *  - views/invoice-public.ejs: form rendered when status=sent and unclaimed,
 *    confirmation panel rendered when claimed, suppressed when status=paid,
 *    just-claimed success banner via ?claimed=1, CSRF token threaded.
 *  - views/dashboard.ejs: amber claim badge surfaces for non-seed,
 *    non-paid claimed invoices, with method label; suppressed on paid;
 *    suppressed on no-claim; suppressed on seed.
 *  - schema.sql: 4 idempotent ALTERs.
 *
 * Run: NODE_ENV=test node tests/payment-claim.test.js
 */

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');
const express = require('express');
const http = require('http');

const VIEWS = path.join(__dirname, '..', 'views');

function clearReq(mod) { delete require.cache[require.resolve(mod)]; }

// ---------- pg stub plumbing ---------------------------------------------

function stubPg(handler) {
  const pgPath = require.resolve('pg');
  const originalPg = require.cache[pgPath];
  require.cache[pgPath] = {
    id: pgPath, filename: pgPath, loaded: true,
    exports: { Pool: function () { return { query: handler }; } }
  };
  delete require.cache[require.resolve('../db')];
  return () => {
    if (originalPg) require.cache[pgPath] = originalPg;
    else delete require.cache[pgPath];
    delete require.cache[require.resolve('../db')];
  };
}

// ---------- db.recordPaymentClaim ----------------------------------------

async function testRecordPaymentClaimSqlShape() {
  const captured = [];
  const restore = stubPg(async (text, params) => {
    captured.push({ text, params });
    return { rows: [{
      id: 5, user_id: 11, invoice_number: 'INV-2026-0042',
      client_name: 'Acme', total: '300.00', status: 'sent',
      public_token: 'cafef00ddeadbeef',
      payment_claimed_at: new Date(),
      payment_claim_method: 'venmo',
      payment_claim_reference: 'tx-abc',
      payment_claim_note: null,
      owner_id: 11, owner_email: 'owner@x.com', owner_name: 'Jordan'
    }] };
  });
  try {
    const { db } = require('../db');
    const row = await db.recordPaymentClaim(5, {
      method: 'venmo',
      reference: 'tx-abc',
      note: 'paid from biz account'
    });
    assert.strictEqual(captured.length, 1);
    const q = captured[0];
    assert.ok(/UPDATE\s+invoices/i.test(q.text), 'must UPDATE invoices');
    assert.ok(/payment_claimed_at\s*=\s*NOW\(\)/i.test(q.text),
      'must stamp payment_claimed_at with NOW()');
    assert.ok(/payment_claim_method\s*=\s*\$2/i.test(q.text),
      'method must be parameterised, not interpolated');
    assert.ok(/payment_claim_reference\s*=\s*\$3/i.test(q.text),
      'reference must be parameterised');
    assert.ok(/payment_claim_note\s*=\s*\$4/i.test(q.text),
      'note must be parameterised');
    assert.ok(/payment_claimed_at\s+IS\s+NULL/i.test(q.text),
      'UPDATE must guard on payment_claimed_at IS NULL for race-safe idempotency');
    assert.ok(/status\s*<>\s*'paid'/i.test(q.text),
      'UPDATE must guard on status != paid so a paid invoice cannot be re-claimed');
    assert.ok(/JOIN\s+users\s+u\s+ON\s+u\.id\s*=\s*updated\.user_id/i.test(q.text),
      'must JOIN users so the caller can compose the freelancer-facing email without a second query');
    assert.ok(/owner_email/i.test(q.text), 'JOIN must project owner_email');
    assert.deepStrictEqual(q.params, [5, 'venmo', 'tx-abc', 'paid from biz account']);
    assert.strictEqual(row.invoice_number, 'INV-2026-0042');
    assert.strictEqual(row.owner_email, 'owner@x.com');
  } finally { restore(); }
}

async function testRecordPaymentClaimReturnsNullWhenAlreadyClaimed() {
  // The UPDATE guard misses (because the row was already claimed OR
  // already paid). The CTE-with-no-rows + JOIN returns zero rows; helper
  // returns null so the caller can branch on "do not fire the email".
  const restore = stubPg(async () => ({ rows: [] }));
  try {
    const { db } = require('../db');
    const row = await db.recordPaymentClaim(5, { method: 'venmo' });
    assert.strictEqual(row, null,
      'already-claimed / already-paid invoice returns null');
  } finally { restore(); }
}

async function testRecordPaymentClaimCoercesEmptyClaimFields() {
  const captured = [];
  const restore = stubPg(async (text, params) => {
    captured.push({ text, params });
    return { rows: [{ id: 5 }] };
  });
  try {
    const { db } = require('../db');
    await db.recordPaymentClaim(5, { method: '', reference: '', note: '' });
    assert.deepStrictEqual(captured[0].params, [5, null, null, null],
      'empty-string claim fields coerce to null so the column ends up NULL, not "" — keeps the surface a clean "missing" instead of "zero-length string"');
  } finally { restore(); }
}

async function testRecordPaymentClaimShortCircuitsOnBadArgs() {
  const calls = [];
  const restore = stubPg(async (text, params) => { calls.push({ text, params }); return { rows: [] }; });
  try {
    const { db } = require('../db');
    assert.strictEqual(await db.recordPaymentClaim(null, { method: 'venmo' }), null);
    assert.strictEqual(await db.recordPaymentClaim(0, { method: 'venmo' }), null);
    assert.strictEqual(await db.recordPaymentClaim('abc', { method: 'venmo' }), null);
    assert.strictEqual(await db.recordPaymentClaim(undefined, undefined), null);
    assert.strictEqual(calls.length, 0,
      'bad-args short-circuit before any DB query');
  } finally { restore(); }
}

// ---------- db.getInvoiceByPublicToken projection ------------------------

async function testGetInvoiceByPublicTokenProjectsClaimColumns() {
  const captured = [];
  const restore = stubPg(async (text, params) => {
    captured.push({ text, params });
    return { rows: [{ id: 1 }] };
  });
  try {
    const { db } = require('../db');
    await db.getInvoiceByPublicToken('cafef00ddeadbeef');
    const q = captured[0];
    assert.ok(/i\.payment_claimed_at/i.test(q.text),
      'SELECT must project i.payment_claimed_at so the public page can switch between form / confirmation panel without a second query');
    assert.ok(/i\.payment_claim_method/i.test(q.text),
      'SELECT must project payment_claim_method so the confirmation panel can render which method the client picked');
    assert.ok(/i\.payment_claim_reference/i.test(q.text),
      'SELECT must project payment_claim_reference');
  } finally { restore(); }
}

// ---------- lib/email builders -------------------------------------------

function testPaymentMethodLabelHandlesKnownAndUnknown() {
  clearReq('../lib/email');
  const { paymentMethodLabel } = require('../lib/email');
  assert.strictEqual(paymentMethodLabel('venmo'), 'Venmo');
  assert.strictEqual(paymentMethodLabel('VENMO'), 'Venmo', 'case-insensitive');
  assert.strictEqual(paymentMethodLabel('  venmo  '), 'Venmo', 'whitespace trimmed');
  assert.strictEqual(paymentMethodLabel('bank_transfer'), 'Bank transfer / ACH');
  assert.strictEqual(paymentMethodLabel(''), 'Other', 'empty falls back to Other');
  assert.strictEqual(paymentMethodLabel('<script>'), 'Other',
    'hostile / unknown method coerces to Other — no raw label leak');
  assert.strictEqual(paymentMethodLabel(null), 'Other');
  assert.strictEqual(paymentMethodLabel(undefined), 'Other');
}

function testPaymentClaimedSubjectIncludesClientAndInvoice() {
  clearReq('../lib/email');
  const { buildPaymentClaimedSubject } = require('../lib/email');
  const subject = buildPaymentClaimedSubject({
    invoice_number: 'INV-2026-0042',
    client_name: 'Acme Co'
  });
  assert.ok(subject.includes('INV-2026-0042'),
    'subject must include the invoice number so the inbox is scannable');
  assert.ok(subject.includes('Acme Co'),
    'subject must include the client name so the inbox preview names who claims to have paid');
  assert.ok(/payment\s+sent/i.test(subject),
    'subject must communicate the event for emotional salience');
}

function testPaymentClaimedSubjectFallsBackOnMissingFields() {
  clearReq('../lib/email');
  const { buildPaymentClaimedSubject } = require('../lib/email');
  const subject = buildPaymentClaimedSubject({});
  assert.ok(/invoice/i.test(subject));
  assert.ok(!subject.includes('undefined'),
    'no raw undefined leaks even when fields are missing');
}

function testPaymentClaimedHtmlEscapesHostileInputs() {
  clearReq('../lib/email');
  const prev = process.env.APP_URL;
  process.env.APP_URL = 'https://decentinvoice.com';
  const { buildPaymentClaimedHtml } = require('../lib/email');
  const html = buildPaymentClaimedHtml(
    {
      id: 88,
      invoice_number: 'INV-2026-0042',
      total: '300.00',
      currency: 'usd',
      client_name: '<script>alert(1)</script>'
    },
    { name: '<b>Jordan</b>', email: 'jordan@x.com' },
    { method: 'venmo', reference: '<img src=x>', note: '<svg/onload=1>' }
  );
  if (prev === undefined) delete process.env.APP_URL; else process.env.APP_URL = prev;

  assert.ok(!html.includes('<script>alert(1)</script>'),
    'hostile client name must be HTML-escaped');
  assert.ok(!html.includes('<b>Jordan</b>'),
    'hostile owner name must be HTML-escaped');
  assert.ok(!html.includes('<img src=x>'),
    'hostile reference must be HTML-escaped');
  assert.ok(!html.includes('<svg/onload=1>'),
    'hostile note must be HTML-escaped');
  assert.ok(/Venmo/.test(html), 'method label is rendered');
  assert.ok(html.includes('INV-2026-0042'), 'invoice number rendered');
  assert.ok(html.includes('$300.00'), 'currency-formatted total rendered');
  assert.ok(html.includes('https://decentinvoice.com/invoices/88'),
    'CTA button points at the freelancer-facing /invoices/:id URL');
  assert.ok(/Confirm receipt/i.test(html),
    'CTA copy frames the action as "verify and confirm", not auto-paid');
}

function testPaymentClaimedHtmlOmitsButtonWhenAppUrlUnset() {
  clearReq('../lib/email');
  const prev = process.env.APP_URL;
  delete process.env.APP_URL;
  const { buildPaymentClaimedHtml } = require('../lib/email');
  const html = buildPaymentClaimedHtml(
    { id: 1, invoice_number: 'X', total: '5.00', currency: 'usd', client_name: 'A' },
    { name: 'O', email: 'o@x.com' },
    { method: 'cash' }
  );
  if (prev !== undefined) process.env.APP_URL = prev;
  assert.ok(!/href="https?:\/\//.test(html),
    'no CTA button must render when APP_URL is not set');
}

function testPaymentClaimedHtmlOmitsReferenceLineWhenAbsent() {
  clearReq('../lib/email');
  const { buildPaymentClaimedHtml } = require('../lib/email');
  const html = buildPaymentClaimedHtml(
    { id: 1, invoice_number: 'X', total: '5.00', currency: 'usd', client_name: 'A' },
    { name: 'O', email: 'o@x.com' },
    { method: 'cash' }
  );
  assert.ok(!/Reference:/i.test(html),
    'when reference is absent the line is omitted entirely — no empty <strong>Reference:</strong>');
}

function testPaymentClaimedTextCarriesFacts() {
  clearReq('../lib/email');
  const prev = process.env.APP_URL;
  process.env.APP_URL = 'https://decentinvoice.com/';
  const { buildPaymentClaimedText } = require('../lib/email');
  const text = buildPaymentClaimedText(
    { id: 7, invoice_number: 'INV-1', total: '120.00', currency: 'usd', client_name: 'Acme' },
    { name: 'Sam', email: 'sam@x.com' },
    { method: 'zelle', reference: 'zelle-ref-1', note: 'business account' }
  );
  if (prev === undefined) delete process.env.APP_URL; else process.env.APP_URL = prev;

  assert.ok(text.includes('Acme'), 'client name in plaintext');
  assert.ok(text.includes('INV-1'), 'invoice number in plaintext');
  assert.ok(text.includes('$120.00'), 'total in plaintext');
  assert.ok(text.includes('Zelle'), 'method label in plaintext');
  assert.ok(text.includes('zelle-ref-1'), 'reference echoed in plaintext');
  assert.ok(text.includes('business account'), 'note echoed in plaintext');
  assert.ok(/https:\/\/decentinvoice\.com\/invoices\/7$/m.test(text),
    'plaintext URL has trailing slash trimmed from APP_URL — exactly one /invoices/7');
}

async function testSendPaymentClaimedEmailShortCircuits() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  let r = await email.sendPaymentClaimedEmail(null, { email: 'o@x.com' }, {});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'invalid_args');

  r = await email.sendPaymentClaimedEmail({ invoice_number: 'x' }, null, {});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'invalid_args');

  r = await email.sendPaymentClaimedEmail({ invoice_number: 'x' }, {}, {});
  assert.strictEqual(r.reason, 'no_owner_email',
    'owner without email short-circuits before transport');
}

async function testSendPaymentClaimedEmailHappyPathPayload() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const sends = [];
  email.setResendClient({
    emails: { send: async (payload) => { sends.push(payload); return { data: { id: 'em_1' } }; } }
  });
  try {
    const r = await email.sendPaymentClaimedEmail(
      { id: 4, invoice_number: 'INV-9', total: '50', currency: 'usd', client_name: 'Acme' },
      { email: 'owner@x.com', name: 'Owner', business_email: 'biz@x.com', reply_to_email: 'reply@x.com' },
      { method: 'check', reference: 'ck#1234', note: null }
    );
    assert.strictEqual(r.ok, true);
    assert.strictEqual(sends.length, 1);
    assert.deepStrictEqual(sends[0].to, ['owner@x.com'],
      'recipient is the FREELANCER (owner.email), not the client');
    assert.ok(/payment sent/i.test(sends[0].subject));
    assert.strictEqual(sends[0].reply_to, 'reply@x.com',
      'reply_to precedence prefers reply_to_email over business_email and email');
    assert.ok(/Cheque/.test(sends[0].html) || /Check/.test(sends[0].html));
    assert.ok(sends[0].html.includes('ck#1234'),
      'reference value reaches the rendered HTML');
  } finally {
    email.resetResendClient();
  }
}

// ---------- POST /i/:token/payment-claim ---------------------------------

function buildShareApp({ invoiceRow, recordResult, recordImpl, sentInbox, viewedImpl }) {
  const records = [];
  const dbStub = {
    pool: { query: async () => ({ rows: [] }) },
    db: {
      async getInvoiceByPublicToken(token) {
        if (!/^[a-f0-9]{8,32}$/i.test(token || '')) return null;
        return invoiceRow;
      },
      async recordPublicInvoiceView() {
        if (typeof viewedImpl === 'function') return await viewedImpl();
        return null;
      },
      async recordPaymentClaim(id, claim) {
        records.push({ id, claim });
        if (typeof recordImpl === 'function') return await recordImpl(id, claim);
        return recordResult === undefined ? null : recordResult;
      }
    }
  };
  require.cache[require.resolve('../db')] = {
    id: require.resolve('../db'), filename: require.resolve('../db'),
    loaded: true, exports: dbStub
  };

  // Stub the email module so the route's fire-and-forget send can be
  // asserted without spinning up Resend.
  clearReq('../lib/email');
  const realEmail = require('../lib/email');
  const inbox = sentInbox || [];
  realEmail.sendPaymentClaimedEmail = async (invoice, owner, claim) => {
    inbox.push({ invoice, owner, claim });
    return { ok: true };
  };

  clearReq('../routes/share');
  const shareRoutes = require('../routes/share');
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', VIEWS);
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use('/', shareRoutes);
  app.records = records;
  app.inbox = inbox;
  return app;
}

function postClaim(app, token, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const data = new URLSearchParams(body || {}).toString();
      const req = http.request({
        hostname: '127.0.0.1', port,
        path: `/i/${token}/payment-claim`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(data)
        }
      }, (res) => {
        let buf = '';
        res.on('data', (c) => buf += c);
        res.on('end', () => server.close(() => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: buf
        })));
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.write(data);
      req.end();
    });
  });
}

function baseInvoice(overrides) {
  return Object.assign({
    id: 5,
    invoice_number: 'INV-2026-0042',
    client_name: 'Acme',
    total: '300.00',
    status: 'sent',
    public_token: 'cafef00ddeadbeef',
    is_seed: false,
    payment_claimed_at: null,
    payment_claim_method: null,
    owner_id: 11,
    owner_email: 'owner@x.com',
    owner_name: 'Jordan'
  }, overrides || {});
}

async function testPostClaim404OnBadTokenFormat() {
  let dbCalls = 0;
  const app = buildShareApp({ invoiceRow: baseInvoice() });
  // Re-stub to count getInvoiceByPublicToken calls
  app.records.length = 0;
  const r = await postClaim(app, 'not-hex!', { method: 'venmo' });
  assert.strictEqual(r.status, 404);
  assert.strictEqual(app.records.length, 0,
    'bad-format token must not reach recordPaymentClaim');
}

async function testPostClaim404OnUnknownToken() {
  const app = buildShareApp({ invoiceRow: null });
  const r = await postClaim(app, 'deadbeefdeadbeef', { method: 'venmo' });
  assert.strictEqual(r.status, 404);
  assert.strictEqual(app.records.length, 0);
}

async function testPostClaimRedirectsAndIsNoOpOnAlreadyPaid() {
  const app = buildShareApp({
    invoiceRow: baseInvoice({ status: 'paid' }),
    sentInbox: []
  });
  const r = await postClaim(app, 'cafef00ddeadbeef', { method: 'venmo' });
  assert.strictEqual(r.status, 302);
  assert.strictEqual(r.headers.location, '/i/cafef00ddeadbeef?claimed=1');
  assert.strictEqual(app.records.length, 0,
    'paid invoices must not record a claim (would be misleading)');
  assert.strictEqual(app.inbox.length, 0,
    'paid invoices must not email the freelancer (already-known state)');
}

async function testPostClaimIdempotentOnAlreadyClaimed() {
  const app = buildShareApp({
    invoiceRow: baseInvoice({
      payment_claimed_at: new Date(),
      payment_claim_method: 'zelle'
    })
  });
  const r = await postClaim(app, 'cafef00ddeadbeef', { method: 'venmo' });
  assert.strictEqual(r.status, 302);
  assert.strictEqual(r.headers.location, '/i/cafef00ddeadbeef?claimed=1');
  assert.strictEqual(app.records.length, 0,
    'already-claimed short-circuit before recordPaymentClaim — keep the existing method/reference intact');
}

async function testPostClaimHappyPathRecordsAndEmails() {
  const inbox = [];
  const app = buildShareApp({
    invoiceRow: baseInvoice(),
    recordResult: {
      id: 5, owner_email: 'owner@x.com', owner_name: 'Jordan',
      owner_business_name: 'Pine', invoice_number: 'INV-2026-0042',
      client_name: 'Acme', total: '300.00'
    },
    sentInbox: inbox
  });
  const r = await postClaim(app, 'cafef00ddeadbeef', {
    method: 'venmo',
    reference: 'tx-99',
    note: 'sent from biz'
  });
  assert.strictEqual(r.status, 302);
  assert.strictEqual(r.headers.location, '/i/cafef00ddeadbeef?claimed=1');
  assert.strictEqual(app.records.length, 1);
  assert.strictEqual(app.records[0].id, 5);
  assert.strictEqual(app.records[0].claim.method, 'venmo');
  assert.strictEqual(app.records[0].claim.reference, 'tx-99');
  assert.strictEqual(app.records[0].claim.note, 'sent from biz');

  // The fire-and-forget email is async — let one tick pass for it to land.
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(inbox.length, 1, 'email must fire exactly once on a successful claim');
  assert.strictEqual(inbox[0].owner.email, 'owner@x.com');
  assert.strictEqual(inbox[0].claim.method, 'venmo');
  assert.strictEqual(inbox[0].claim.reference, 'tx-99');
}

async function testPostClaimCoercesUnknownMethodToOther() {
  const app = buildShareApp({
    invoiceRow: baseInvoice(),
    recordResult: { id: 5, owner_email: 'o@x.com' }
  });
  const r = await postClaim(app, 'cafef00ddeadbeef', {
    method: 'crypto', // not in whitelist
    reference: 'btc-tx'
  });
  assert.strictEqual(r.status, 302);
  assert.strictEqual(app.records[0].claim.method, 'other',
    'unknown method must coerce to "other" — never drop the claim on the floor for a tampered or out-of-date form');
}

async function testPostClaimBoundsLongReferenceAndNote() {
  const app = buildShareApp({
    invoiceRow: baseInvoice(),
    recordResult: { id: 5, owner_email: 'o@x.com' }
  });
  const longRef = 'r'.repeat(500);
  const longNote = 'n'.repeat(2000);
  await postClaim(app, 'cafef00ddeadbeef', {
    method: 'venmo',
    reference: longRef,
    note: longNote
  });
  assert.strictEqual(app.records[0].claim.reference.length, 200,
    'reference must be sliced to the 200-char ceiling');
  assert.strictEqual(app.records[0].claim.note.length, 1000,
    'note must be sliced to the 1000-char ceiling');
}

async function testPostClaimSurvivesEmailRejection() {
  const inbox = [];
  const app = buildShareApp({
    invoiceRow: baseInvoice(),
    recordResult: { id: 5, owner_email: 'o@x.com' },
    sentInbox: inbox
  });
  // Replace the email stub with one that throws
  const emailLib = require('../lib/email');
  emailLib.sendPaymentClaimedEmail = async () => {
    throw new Error('resend exploded');
  };
  const r = await postClaim(app, 'cafef00ddeadbeef', { method: 'venmo' });
  assert.strictEqual(r.status, 302,
    'email throw must not break the client confirmation redirect');
}

async function testPostClaimRedirectsWhenRecordLosesRace() {
  // recordPaymentClaim returns null (concurrent submit won, or status flipped
  // to paid between lookup and UPDATE). Route still 302s — the client sees
  // the same ?claimed=1 confirmation.
  const inbox = [];
  const app = buildShareApp({
    invoiceRow: baseInvoice(),
    recordResult: null,
    sentInbox: inbox
  });
  const r = await postClaim(app, 'cafef00ddeadbeef', { method: 'venmo' });
  assert.strictEqual(r.status, 302);
  assert.strictEqual(r.headers.location, '/i/cafef00ddeadbeef?claimed=1');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(inbox.length, 0,
    'race-loss must NOT fire the email — the winning caller already did');
}

async function testPostClaim500OnDbThrow() {
  const app = buildShareApp({
    invoiceRow: baseInvoice(),
    recordImpl: async () => { throw new Error('db dead'); }
  });
  const r = await postClaim(app, 'cafef00ddeadbeef', { method: 'venmo' });
  assert.strictEqual(r.status, 500,
    'a DB throw on the stamp surfaces a 500 to the client, not a misleading "claimed" redirect');
}

// ---------- views/invoice-public.ejs -------------------------------------

async function renderPublic(invoiceOverrides, extraLocals) {
  return ejs.renderFile(path.join(VIEWS, 'invoice-public.ejs'), Object.assign({
    invoice: Object.assign({
      id: 5,
      invoice_number: 'INV-2026-0042',
      client_name: 'Acme',
      client_email: '',
      client_address: '',
      items: [{ description: 'Work', quantity: 1, unit_price: 100 }],
      subtotal: 100, tax_rate: 0, tax_amount: 0, total: 100,
      notes: null,
      status: 'sent',
      issued_date: new Date('2026-05-01'),
      due_date: new Date('2026-05-31'),
      public_token: 'cafef00ddeadbeef',
      payment_link_url: null,
      owner_business_name: 'Pine Studio',
      owner_name: 'Jordan',
      owner_email: 'jordan@x.com',
      owner_plan: 'free',
      payment_claimed_at: null,
      payment_claim_method: null
    }, invoiceOverrides || {}),
    title: 't',
    paymentClaimMethods: ['cash','check','venmo','zelle','bank_transfer','paypal','other'],
    paymentClaimReferenceMax: 200,
    paymentClaimNoteMax: 1000,
    justClaimed: false,
    csrfToken: 'csrf-public-1'
  }, extraLocals || {}), { views: [VIEWS] });
}

async function testPublicViewRendersClaimFormWhenSentAndUnclaimed() {
  const html = await renderPublic({ status: 'sent' });
  assert.ok(html.includes('data-testid="public-payment-claim"'),
    'payment-claim widget container present');
  assert.ok(html.includes('data-testid="public-payment-claim-form"'),
    'form present');
  assert.ok(/action="\/i\/cafef00ddeadbeef\/payment-claim"/.test(html),
    'form posts to /i/<token>/payment-claim');
  assert.ok(html.includes('data-testid="public-payment-claim-method-venmo"'),
    'venmo radio rendered');
  assert.ok(html.includes('data-testid="public-payment-claim-method-bank_transfer"'),
    'bank_transfer radio rendered');
  assert.ok(/value="csrf-public-1"/.test(html),
    'CSRF token threaded into hidden input');
}

async function testPublicViewRendersClaimedPanelWhenClaimed() {
  const html = await renderPublic({
    status: 'sent',
    payment_claimed_at: new Date(),
    payment_claim_method: 'venmo'
  });
  assert.ok(html.includes('data-testid="public-payment-claimed-panel"'),
    'claimed panel surfaces');
  assert.ok(!html.includes('data-testid="public-payment-claim-form"'),
    'form is suppressed once claimed');
  assert.ok(/data-testid="public-payment-claimed-method"[^>]*>\s*venmo/i.test(html),
    'method label renders inside the claimed panel');
}

async function testPublicViewSuppressesClaimWidgetOnPaid() {
  const html = await renderPublic({ status: 'paid' });
  assert.ok(!html.includes('data-testid="public-payment-claim"'),
    'claim widget must not render for an already-paid invoice');
  assert.ok(!html.includes('data-testid="public-payment-claimed-panel"'),
    'claimed panel must not render once status=paid — the paid banner replaces it');
}

async function testPublicViewRendersClaimFormOnOverdue() {
  const html = await renderPublic({ status: 'overdue' });
  assert.ok(html.includes('data-testid="public-payment-claim-form"'),
    'overdue invoices keep the claim form — the freelancer most wants the signal here');
}

async function testPublicViewSuppressesClaimFormOnDraft() {
  const html = await renderPublic({ status: 'draft' });
  assert.ok(!html.includes('data-testid="public-payment-claim-form"'),
    'a draft invoice should never surface a claim form — the freelancer has not yet sent it');
}

async function testPublicViewRendersJustClaimedSuccessBanner() {
  const html = await renderPublic({
    status: 'sent',
    payment_claimed_at: new Date(),
    payment_claim_method: 'venmo'
  }, { justClaimed: true });
  assert.ok(html.includes('data-testid="payment-claim-success"'),
    '?claimed=1 surfaces a green confirmation banner above the persistent panel');
}

// ---------- views/dashboard.ejs badge ------------------------------------

async function renderDashboard(invoices, userOverrides) {
  return ejs.renderFile(path.join(VIEWS, 'dashboard.ejs'), {
    user: Object.assign({
      id: 1, email: 'u@x.com', name: 'U', plan: 'free',
      invoice_count: invoices.length,
      subscription_status: null,
      trial_ends_at: null
    }, userOverrides || {}),
    invoices,
    title: 'Dashboard',
    csrfToken: 'csrf-dash',
    flash: null,
    onboarding: null,
    invoiceLimitProgress: null,
    recentRevenueCard: null,
    annualUpgradePrompt: null,
    days_left_in_trial: 0,
    socialProof: null,
    firstRealInvoicePrompt: null,
    staleDraftPrompt: null,
    trialCountdown: null,
    pastDueBanner: null
  }, { views: [VIEWS] });
}

function dashboardInvoice(overrides) {
  return Object.assign({
    id: 5,
    invoice_number: 'INV-2026-0042',
    client_name: 'Acme',
    issued_date: new Date('2026-05-01'),
    status: 'sent',
    total: '300.00',
    is_seed: false,
    payment_link_url: null,
    first_viewed_at: null,
    last_viewed_at: null,
    view_count: 0,
    payment_claimed_at: null,
    payment_claim_method: null
  }, overrides || {});
}

async function testDashboardRendersClaimBadgeForClaimedSentInvoice() {
  const html = await renderDashboard([
    dashboardInvoice({
      payment_claimed_at: new Date(),
      payment_claim_method: 'venmo'
    })
  ]);
  assert.ok(html.includes('data-testid="client-payment-claim-5"'),
    'amber claim badge present on the row');
  assert.ok(/data-claim-method="venmo"/.test(html),
    'badge carries the method as a data attribute for analytics');
  assert.ok(/Client reports paid[\s\S]*Venmo/.test(html),
    'badge copy names the method label');
}

async function testDashboardSuppressesClaimBadgeWhenStatusIsPaid() {
  const html = await renderDashboard([
    dashboardInvoice({
      status: 'paid',
      payment_claimed_at: new Date(),
      payment_claim_method: 'venmo'
    })
  ]);
  assert.ok(!html.includes('data-testid="client-payment-claim-5"'),
    'paid invoices must not show the claim badge — the green Paid pill covers it');
}

async function testDashboardSuppressesClaimBadgeWhenNoClaim() {
  const html = await renderDashboard([dashboardInvoice()]);
  assert.ok(!html.includes('data-testid="client-payment-claim-5"'),
    'no claim stamp = no badge');
}

async function testDashboardSuppressesClaimBadgeOnSeed() {
  const html = await renderDashboard([
    dashboardInvoice({
      is_seed: true,
      payment_claimed_at: new Date(),
      payment_claim_method: 'venmo'
    })
  ]);
  assert.ok(!html.includes('data-testid="client-payment-claim-5"'),
    'seed invoices must never surface the claim badge — they have no real client');
}

// ---------- schema migration --------------------------------------------

function testSchemaIncludesClaimColumnMigrations() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  assert.ok(/ALTER\s+TABLE\s+invoices\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+payment_claimed_at\s+TIMESTAMP/i.test(sql),
    'schema.sql must carry an idempotent ALTER for invoices.payment_claimed_at');
  assert.ok(/ALTER\s+TABLE\s+invoices\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+payment_claim_method\s+VARCHAR\(40\)/i.test(sql),
    'schema.sql must carry an idempotent ALTER for invoices.payment_claim_method');
  assert.ok(/ALTER\s+TABLE\s+invoices\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+payment_claim_reference\s+VARCHAR\(200\)/i.test(sql),
    'schema.sql must carry an idempotent ALTER for invoices.payment_claim_reference');
  assert.ok(/ALTER\s+TABLE\s+invoices\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+payment_claim_note\s+TEXT/i.test(sql),
    'schema.sql must carry an idempotent ALTER for invoices.payment_claim_note');
}

// ---------- runner -------------------------------------------------------

async function run() {
  const tests = [
    ['db.recordPaymentClaim: CTE UPDATE+JOIN shape, guards, params', testRecordPaymentClaimSqlShape],
    ['db.recordPaymentClaim: returns null on already-claimed / paid', testRecordPaymentClaimReturnsNullWhenAlreadyClaimed],
    ['db.recordPaymentClaim: coerces empty claim fields to null', testRecordPaymentClaimCoercesEmptyClaimFields],
    ['db.recordPaymentClaim: bad-arg short-circuit, no SQL', testRecordPaymentClaimShortCircuitsOnBadArgs],
    ['db.getInvoiceByPublicToken: SELECT projects claim columns', testGetInvoiceByPublicTokenProjectsClaimColumns],
    ['lib/email.paymentMethodLabel: known/unknown coercion', testPaymentMethodLabelHandlesKnownAndUnknown],
    ['lib/email.buildPaymentClaimedSubject: includes client + invoice', testPaymentClaimedSubjectIncludesClientAndInvoice],
    ['lib/email.buildPaymentClaimedSubject: falls back on missing fields', testPaymentClaimedSubjectFallsBackOnMissingFields],
    ['lib/email.buildPaymentClaimedHtml: XSS-escapes hostile inputs', testPaymentClaimedHtmlEscapesHostileInputs],
    ['lib/email.buildPaymentClaimedHtml: omits CTA button when APP_URL unset', testPaymentClaimedHtmlOmitsButtonWhenAppUrlUnset],
    ['lib/email.buildPaymentClaimedHtml: omits Reference line when absent', testPaymentClaimedHtmlOmitsReferenceLineWhenAbsent],
    ['lib/email.buildPaymentClaimedText: carries facts + trims APP_URL', testPaymentClaimedTextCarriesFacts],
    ['lib/email.sendPaymentClaimedEmail: short-circuits on bad args / no email', testSendPaymentClaimedEmailShortCircuits],
    ['lib/email.sendPaymentClaimedEmail: happy-path Resend payload + reply-to precedence', testSendPaymentClaimedEmailHappyPathPayload],
    ['POST /i/:token/payment-claim: 404 on bad-format token, no DB call', testPostClaim404OnBadTokenFormat],
    ['POST /i/:token/payment-claim: 404 on unknown token', testPostClaim404OnUnknownToken],
    ['POST /i/:token/payment-claim: 302 + no record + no email on paid invoice', testPostClaimRedirectsAndIsNoOpOnAlreadyPaid],
    ['POST /i/:token/payment-claim: idempotent on already-claimed', testPostClaimIdempotentOnAlreadyClaimed],
    ['POST /i/:token/payment-claim: happy path records + emails once + redirects', testPostClaimHappyPathRecordsAndEmails],
    ['POST /i/:token/payment-claim: unknown method coerces to "other"', testPostClaimCoercesUnknownMethodToOther],
    ['POST /i/:token/payment-claim: reference/note sliced to 200/1000 chars', testPostClaimBoundsLongReferenceAndNote],
    ['POST /i/:token/payment-claim: survives email throw', testPostClaimSurvivesEmailRejection],
    ['POST /i/:token/payment-claim: race-loss redirects without re-emailing', testPostClaimRedirectsWhenRecordLosesRace],
    ['POST /i/:token/payment-claim: 500 on db throw', testPostClaim500OnDbThrow],
    ['invoice-public.ejs: claim form when sent + unclaimed', testPublicViewRendersClaimFormWhenSentAndUnclaimed],
    ['invoice-public.ejs: claimed panel when payment_claimed_at set', testPublicViewRendersClaimedPanelWhenClaimed],
    ['invoice-public.ejs: suppresses widget when status=paid', testPublicViewSuppressesClaimWidgetOnPaid],
    ['invoice-public.ejs: renders claim form on overdue', testPublicViewRendersClaimFormOnOverdue],
    ['invoice-public.ejs: suppresses claim form on draft', testPublicViewSuppressesClaimFormOnDraft],
    ['invoice-public.ejs: renders just-claimed success banner via ?claimed=1', testPublicViewRendersJustClaimedSuccessBanner],
    ['dashboard.ejs: amber claim badge on claimed non-paid row', testDashboardRendersClaimBadgeForClaimedSentInvoice],
    ['dashboard.ejs: suppresses claim badge when status=paid', testDashboardSuppressesClaimBadgeWhenStatusIsPaid],
    ['dashboard.ejs: suppresses claim badge when unclaimed', testDashboardSuppressesClaimBadgeWhenNoClaim],
    ['dashboard.ejs: suppresses claim badge on seed invoice', testDashboardSuppressesClaimBadgeOnSeed],
    ['schema.sql: 4 idempotent ALTERs for invoices.payment_claim_*', testSchemaIncludesClaimColumnMigrations]
  ];
  let pass = 0, fail = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ok  ${name}`);
      pass++;
    } catch (err) {
      console.error(`  FAIL ${name}`);
      console.error(err && err.stack ? err.stack : err);
      fail++;
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
