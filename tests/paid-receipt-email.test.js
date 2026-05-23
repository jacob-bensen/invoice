'use strict';

/*
 * Paid-receipt-to-client email tests (Milestone 4 — first sent → first paid).
 *
 * When an invoice flips to paid (manual Mark-as-Paid OR Stripe Payment Link
 * webhook), the CLIENT is emailed a confirmation receipt. This closes the
 * silent gap on the close-the-loop moment: without this email the client
 * only learns about the paid state if they happen to revisit the
 * /i/<token> share page.
 *
 * Recipient is the CLIENT, not the freelancer (that's sendPaidNotificationEmail).
 *
 * Covers:
 *  - lib/email: buildPaidReceiptSubject — includes invoice number + "Paid"
 *    framing distinct from sendPaidNotificationEmail's "just paid".
 *  - lib/email: buildPaidReceiptHtml — escapes hostile client_name AND
 *    sender name (XSS guard), includes the formatted total, includes the
 *    invoice number, surfaces the public /i/<token> URL when APP_URL is
 *    set, omits the link button when APP_URL is unset, includes
 *    "behalf of <sender>" disclaimer so the client knows who they're
 *    receiving the email from.
 *  - lib/email: buildPaidReceiptText — same facts + plain-text public URL.
 *  - lib/email: sendPaidReceiptEmail short-circuits on missing args, on
 *    missing client_email; happy path sends to the CLIENT (not the
 *    freelancer) with reply_to set to the freelancer.
 *  - lib/email exports lock the public API.
 *  - lib/paid-receipt.triggerPaidReceipt:
 *      • null db / null invoice / null owner → null.
 *      • missing markClientPaidReceiptSent on db → null.
 *      • is_seed invoice → null (no stamp, no send).
 *      • empty / whitespace-only client_email → null.
 *      • already-stamped (client_paid_receipt_sent_at set) → null without
 *        a DB call.
 *      • stamp throws → null with no send.
 *      • stamp returns null (race lost) → null with no send.
 *      • happy path stamps then sends; returns { stamped, send }.
 *      • send throws → returns the error envelope (logged).
 *      • not_configured → unstamps so a future flip can retry once
 *        Resend lands.
 *  - db.markClientPaidReceiptSent SQL contract:
 *      • falsy invoiceId short-circuits without query.
 *      • UPDATE with IS NULL guard, RETURNING id + stamp.
 *  - routes/invoices.js POST /:id/status:
 *      • status='paid' calls triggerPaidReceipt once.
 *      • status='sent' does NOT call triggerPaidReceipt.
 *      • status='paid' on an invoice with no client_email still 200s and
 *        does NOT crash (the trigger short-circuits inside).
 *  - routes/billing.js Stripe webhook:
 *      • mode='payment' (payment_link paid) → triggerPaidReceipt called
 *        exactly once with the marked-paid invoice + owner.
 *      • mode='subscription' → does NOT call triggerPaidReceipt.
 *      • triggerPaidReceipt throw still returns 200 (fire-and-forget).
 *
 * Run: NODE_ENV=test node tests/paid-receipt-email.test.js
 */

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

const assert = require('assert');
const path = require('path');
const express = require('express');
const session = require('express-session');
const http = require('http');

function clearReq(mod) { delete require.cache[require.resolve(mod)]; }

// ---------- Lib formatters --------------------------------------------------

async function testBuildSubject() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const subject = email.buildPaidReceiptSubject({ invoice_number: 'INV-2026-0042' });
  assert.ok(subject.includes('INV-2026-0042'),
    'subject must include the invoice number');
  assert.ok(/paid/i.test(subject),
    'subject must communicate the paid state');
  assert.ok(/thank/i.test(subject),
    'subject leads with a thank-you for trust-building');
  // Distinct framing from sendPaidNotificationEmail ("just paid") — the
  // freelancer-facing notification is celebratory; the client-facing
  // receipt is a formal confirmation.
  assert.ok(!/just paid/i.test(subject),
    'subject must not duplicate the freelancer-facing "just paid" framing');
}

async function testBuildSubjectFallsBackOnMissingNumber() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const subject = email.buildPaidReceiptSubject({});
  assert.ok(/invoice/i.test(subject),
    'subject still says "invoice" when number is missing');
  assert.ok(!subject.includes('undefined'),
    'no literal "undefined" leak when number is missing');
}

async function testBuildHtmlEscapesAndRendersButton() {
  clearReq('../lib/email');
  const prev = process.env.APP_URL;
  process.env.APP_URL = 'https://decentinvoice.com';
  const email = require('../lib/email');
  const html = email.buildPaidReceiptHtml(
    {
      id: 99,
      invoice_number: 'INV-2026-0008',
      total: '500.00',
      currency: 'usd',
      client_name: '<script>alert(1)</script>',
      public_token: 'abcdef0123456789'
    },
    {
      name: '<b>Sender</b>',
      business_name: '<b>Sender</b>',
      email: 'sender@x.com'
    }
  );
  if (prev === undefined) delete process.env.APP_URL; else process.env.APP_URL = prev;

  assert.ok(!html.includes('<script>alert(1)</script>'),
    'raw client_name must not appear unescaped (XSS guard)');
  assert.ok(html.includes('&lt;script&gt;'),
    'client_name must appear HTML-escaped');
  assert.ok(!html.includes('<b>Sender</b>'),
    'raw sender business_name must not appear unescaped (XSS guard)');
  assert.ok(html.includes('&lt;b&gt;Sender&lt;/b&gt;'),
    'sender business_name must appear HTML-escaped');
  assert.ok(html.includes('$500.00'),
    'total must render with currency symbol');
  assert.ok(html.includes('INV-2026-0008'),
    'invoice number must appear in the body');
  assert.ok(html.includes('https://decentinvoice.com/i/abcdef0123456789'),
    'view-receipt button must point at the public /i/<token> share URL');
  assert.ok(/behalf of/i.test(html),
    'body must include the "on behalf of <sender>" disclaimer so the client knows where this email came from');
}

async function testBuildHtmlOmitsButtonWithoutAppUrl() {
  clearReq('../lib/email');
  const prev = process.env.APP_URL;
  delete process.env.APP_URL;
  const email = require('../lib/email');
  const html = email.buildPaidReceiptHtml(
    { id: 12, invoice_number: 'INV-X', total: '5.00', currency: 'usd', client_name: 'Acme', public_token: 'cafe0001cafe0001' },
    { name: 'Sam', email: 'sam@x.com' }
  );
  if (prev !== undefined) process.env.APP_URL = prev;

  assert.ok(!/href="https?:\/\//.test(html),
    'no view-receipt button must render when APP_URL is unset (no canonical host)');
  // The body still renders — the rest of the message is informative on its own.
  assert.ok(html.includes('INV-X'), 'invoice number still appears');
  assert.ok(html.includes('$5.00'), 'total still appears');
  assert.ok(html.includes('Acme'), 'client name still appears');
}

async function testBuildHtmlOmitsButtonWithoutToken() {
  clearReq('../lib/email');
  const prev = process.env.APP_URL;
  process.env.APP_URL = 'https://decentinvoice.com';
  const email = require('../lib/email');
  const html = email.buildPaidReceiptHtml(
    { id: 12, invoice_number: 'INV-X', total: '5.00', currency: 'usd', client_name: 'Acme' },
    { name: 'Sam', email: 'sam@x.com' }
  );
  if (prev === undefined) delete process.env.APP_URL; else process.env.APP_URL = prev;

  // Without a public token we cannot build a public /i/<token> URL, and the
  // owner-facing /invoices/<id> URL is gated behind login — so we render no
  // view button at all rather than a dead link.
  assert.ok(!/href="https?:\/\//.test(html),
    'no view-receipt button must render when invoice has no public_token');
}

async function testBuildTextIncludesAllFactsAndUrl() {
  clearReq('../lib/email');
  const prev = process.env.APP_URL;
  process.env.APP_URL = 'https://decentinvoice.com/'; // trailing slash on purpose
  const email = require('../lib/email');
  const text = email.buildPaidReceiptText(
    {
      id: 33,
      invoice_number: 'INV-2026-0033',
      total: '99.99',
      currency: 'usd',
      client_name: 'Globex',
      public_token: 'beefcafe12345678'
    },
    { name: 'Alex', email: 'alex@studio.com', business_name: 'Alex Studio' }
  );
  if (prev === undefined) delete process.env.APP_URL; else process.env.APP_URL = prev;

  assert.ok(text.includes('INV-2026-0033'), 'plain-text includes invoice number');
  assert.ok(text.includes('$99.99'), 'plain-text includes formatted total');
  assert.ok(text.includes('Globex'), 'plain-text greets the client by name');
  assert.ok(text.includes('Alex Studio'), 'plain-text names the sender');
  assert.ok(text.includes('https://decentinvoice.com/i/beefcafe12345678'),
    'plain-text includes public /i/<token> URL with single slash');
  assert.ok(!text.includes('decentinvoice.com//'),
    'trailing slash on APP_URL must be normalised away');
}

async function testEmailLibExports() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  // Lock the public API.
  assert.strictEqual(typeof email.sendPaidReceiptEmail, 'function',
    'sendPaidReceiptEmail must be exported');
  assert.strictEqual(typeof email.buildPaidReceiptSubject, 'function');
  assert.strictEqual(typeof email.buildPaidReceiptHtml, 'function');
  assert.strictEqual(typeof email.buildPaidReceiptText, 'function');
  // Existing exports must not have regressed.
  assert.strictEqual(typeof email.sendPaidNotificationEmail, 'function');
  assert.strictEqual(typeof email.sendInvoiceEmail, 'function');
}

async function testSendShortCircuitsOnMissingArgs() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const r1 = await email.sendPaidReceiptEmail(null, { email: 'x@x.com' });
  assert.strictEqual(r1.ok, false);
  assert.strictEqual(r1.reason, 'invalid_args');
  const r2 = await email.sendPaidReceiptEmail({ client_email: 'c@x.com' }, null);
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.reason, 'invalid_args');
}

async function testSendShortCircuitsOnNoClientEmail() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const r = await email.sendPaidReceiptEmail(
    { id: 1, invoice_number: 'INV-1', total: '10', client_email: '' },
    { email: 'sender@x.com' }
  );
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no_client_email',
    'missing client_email must short-circuit before calling Resend');
}

async function testSendHappyPathSendsToClient() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const sends = [];
  email.setResendClient({
    emails: {
      async send(payload) {
        sends.push(payload);
        return { data: { id: 'em_receipt_1' }, error: null };
      }
    }
  });

  const r = await email.sendPaidReceiptEmail(
    {
      id: 7,
      invoice_number: 'INV-2026-0007',
      total: '750.00',
      currency: 'usd',
      client_name: 'Acme Co',
      client_email: 'finance@acme.com',
      public_token: 'cafe0001cafe0001'
    },
    {
      email: 'freelancer@me.com',
      name: 'Sam',
      business_email: 'invoices@me.com',
      reply_to_email: null
    }
  );

  assert.strictEqual(r.ok, true, 'send must succeed');
  assert.strictEqual(sends.length, 1, 'must call Resend exactly once');
  const payload = sends[0];
  assert.deepStrictEqual(payload.to, ['finance@acme.com'],
    'recipient is the CLIENT (invoice.client_email), not the freelancer — this is the core contract distinguishing it from sendPaidNotificationEmail');
  assert.ok(payload.subject.includes('INV-2026-0007'));
  assert.strictEqual(payload.reply_to, 'invoices@me.com',
    'reply_to falls through to business_email so client replies land in the freelancer\'s mailbox');
  email.resetResendClient();
}

// ---------- triggerPaidReceipt orchestrator -------------------------------

function makeStubDb(overrides = {}) {
  const calls = { markStamps: [], poolQueries: [] };
  const db = Object.assign({
    pool: {
      query: async (sql, params) => {
        calls.poolQueries.push({ sql, params });
        return { rows: [] };
      }
    },
    markClientPaidReceiptSent: async (invoiceId) => {
      calls.markStamps.push(invoiceId);
      return { id: invoiceId, client_paid_receipt_sent_at: new Date() };
    }
  }, overrides);
  return { db, calls };
}

async function testTriggerNullArgs() {
  clearReq('../lib/email');
  clearReq('../lib/paid-receipt');
  const { triggerPaidReceipt } = require('../lib/paid-receipt');
  const { db } = makeStubDb();
  assert.strictEqual(await triggerPaidReceipt(null, { id: 1, client_email: 'a@b.com' }, { email: 'x@x.com' }), null);
  assert.strictEqual(await triggerPaidReceipt(db, null, { email: 'x@x.com' }), null);
  assert.strictEqual(await triggerPaidReceipt(db, { id: 1, client_email: 'a@b.com' }, null), null);
}

async function testTriggerMissingMethod() {
  clearReq('../lib/email');
  clearReq('../lib/paid-receipt');
  const { triggerPaidReceipt } = require('../lib/paid-receipt');
  // db without markClientPaidReceiptSent — soft-fail.
  const r = await triggerPaidReceipt(
    { pool: { query: async () => ({ rows: [] }) } },
    { id: 1, client_email: 'a@b.com' },
    { email: 'x@x.com' }
  );
  assert.strictEqual(r, null);
}

async function testTriggerSeedShortCircuits() {
  clearReq('../lib/email');
  clearReq('../lib/paid-receipt');
  const { triggerPaidReceipt } = require('../lib/paid-receipt');
  const { db, calls } = makeStubDb();
  const r = await triggerPaidReceipt(db, { id: 1, client_email: 'c@x.com', is_seed: true }, { email: 'o@x.com' });
  assert.strictEqual(r, null);
  assert.strictEqual(calls.markStamps.length, 0,
    'seed invoice must not stamp — defence-in-depth against the sample being marked paid by a curious user');
}

async function testTriggerMissingClientEmailShortCircuits() {
  clearReq('../lib/email');
  clearReq('../lib/paid-receipt');
  const { triggerPaidReceipt } = require('../lib/paid-receipt');
  const { db, calls } = makeStubDb();
  const r1 = await triggerPaidReceipt(db, { id: 1 }, { email: 'o@x.com' });
  assert.strictEqual(r1, null);
  const r2 = await triggerPaidReceipt(db, { id: 1, client_email: '' }, { email: 'o@x.com' });
  assert.strictEqual(r2, null);
  const r3 = await triggerPaidReceipt(db, { id: 1, client_email: '   ' }, { email: 'o@x.com' });
  assert.strictEqual(r3, null);
  assert.strictEqual(calls.markStamps.length, 0,
    'no client_email = no recipient = no stamp (no point stamping if we cannot send)');
}

async function testTriggerAlreadyStampedShortCircuits() {
  clearReq('../lib/email');
  clearReq('../lib/paid-receipt');
  const { triggerPaidReceipt } = require('../lib/paid-receipt');
  const { db, calls } = makeStubDb();
  const r = await triggerPaidReceipt(
    db,
    { id: 1, client_email: 'c@x.com', client_paid_receipt_sent_at: new Date() },
    { email: 'o@x.com' }
  );
  assert.strictEqual(r, null);
  assert.strictEqual(calls.markStamps.length, 0,
    'already-stamped invoice must short-circuit before even hitting the DB');
}

async function testTriggerStampThrow() {
  clearReq('../lib/email');
  clearReq('../lib/paid-receipt');
  const { triggerPaidReceipt } = require('../lib/paid-receipt');
  const { db } = makeStubDb({
    markClientPaidReceiptSent: async () => { throw new Error('db boom'); }
  });
  const r = await triggerPaidReceipt(db, { id: 1, client_email: 'c@x.com' }, { email: 'o@x.com' });
  assert.strictEqual(r, null, 'stamp throw soft-fails to null');
}

async function testTriggerStampRaceLost() {
  clearReq('../lib/email');
  clearReq('../lib/paid-receipt');
  const { triggerPaidReceipt } = require('../lib/paid-receipt');
  const { db, calls } = makeStubDb({
    markClientPaidReceiptSent: async () => null   // another tick won the IS NULL race
  });
  const r = await triggerPaidReceipt(db, { id: 1, client_email: 'c@x.com' }, { email: 'o@x.com' });
  assert.strictEqual(r, null, 'race-loser collapses to null without a send');
  assert.strictEqual(calls.poolQueries.length, 0,
    'race-loser must not attempt to unstamp or re-query');
}

async function testTriggerHappyPath() {
  clearReq('../lib/email');
  clearReq('../lib/paid-receipt');
  const email = require('../lib/email');
  const sends = [];
  email.setResendClient({
    emails: {
      async send(payload) {
        sends.push(payload);
        return { data: { id: 'em_x' }, error: null };
      }
    }
  });
  const { triggerPaidReceipt } = require('../lib/paid-receipt');
  const { db, calls } = makeStubDb();

  const r = await triggerPaidReceipt(
    db,
    { id: 42, client_email: '  finance@acme.com  ', invoice_number: 'INV-42', total: '120.00', currency: 'usd', client_name: 'Acme', public_token: 'a'.repeat(16) },
    { email: 'freelancer@me.com', name: 'Sam' }
  );

  assert.ok(r && r.stamped, 'happy path returns the stamped row');
  assert.deepStrictEqual(calls.markStamps, [42],
    'stamp must be called exactly once with the invoice id');
  assert.strictEqual(sends.length, 1, 'email is sent exactly once after a successful stamp');
  assert.deepStrictEqual(sends[0].to, ['finance@acme.com'],
    'client_email is trimmed before being used as the Resend recipient');
  assert.strictEqual(r.send.ok, true);
  email.resetResendClient();
}

async function testTriggerSendThrow() {
  clearReq('../lib/email');
  clearReq('../lib/paid-receipt');
  // Stub sendPaidReceiptEmail to throw via module-cache replacement.
  const realEmail = require('../lib/email');
  const emailStub = Object.assign({}, realEmail, {
    sendPaidReceiptEmail: async () => { throw new Error('Resend exploded'); }
  });
  require.cache[require.resolve('../lib/email')] = {
    id: require.resolve('../lib/email'),
    filename: require.resolve('../lib/email'),
    loaded: true,
    exports: emailStub
  };
  clearReq('../lib/paid-receipt');
  const { triggerPaidReceipt } = require('../lib/paid-receipt');
  const { db } = makeStubDb();

  const r = await triggerPaidReceipt(
    db,
    { id: 1, client_email: 'c@x.com' },
    { email: 'o@x.com' }
  );
  assert.ok(r && r.stamped, 'stamp is preserved even when send throws — we do not want to re-spam the client on retry');
  assert.strictEqual(r.send.ok, false);
  assert.strictEqual(r.send.reason, 'error');
  clearReq('../lib/email');
}

async function testTriggerNotConfiguredUnstamps() {
  // Stub sendPaidReceiptEmail to return not_configured so the orchestrator
  // unstamps the row so a future flip can retry once RESEND_API_KEY lands.
  clearReq('../lib/email');
  const realEmail = require('../lib/email');
  const emailStub = Object.assign({}, realEmail, {
    sendPaidReceiptEmail: async () => ({ ok: false, reason: 'not_configured' })
  });
  require.cache[require.resolve('../lib/email')] = {
    id: require.resolve('../lib/email'),
    filename: require.resolve('../lib/email'),
    loaded: true,
    exports: emailStub
  };
  clearReq('../lib/paid-receipt');
  const { triggerPaidReceipt } = require('../lib/paid-receipt');
  const poolCalls = [];
  const { db } = makeStubDb({
    pool: {
      query: async (sql, params) => {
        poolCalls.push({ sql: sql.trim(), params });
        return { rows: [] };
      }
    }
  });

  const r = await triggerPaidReceipt(
    db,
    { id: 99, client_email: 'c@x.com' },
    { email: 'o@x.com' }
  );
  assert.ok(r && r.stamped);
  assert.strictEqual(r.send.reason, 'not_configured');
  assert.strictEqual(poolCalls.length, 1,
    'not_configured must trigger exactly one UPDATE to unstamp the row');
  assert.ok(/UPDATE invoices SET client_paid_receipt_sent_at = NULL/i.test(poolCalls[0].sql),
    'unstamp SQL must NULL the stamp column so a future flip retries');
  assert.deepStrictEqual(poolCalls[0].params, [99],
    'unstamp must target the same invoice id by parameter, never inlined');
  clearReq('../lib/email');
}

// ---------- db.markClientPaidReceiptSent SQL contract --------------------

async function testMarkSqlContractHappy() {
  const pgPath = require.resolve('pg');
  const original = require.cache[pgPath];
  const queries = [];
  require.cache[pgPath] = {
    id: pgPath, filename: pgPath, loaded: true,
    exports: {
      Pool: function () {
        return {
          query: async (sql, params) => {
            queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
            return { rows: [{ id: params[0], client_paid_receipt_sent_at: new Date() }] };
          }
        };
      }
    }
  };
  clearReq('../db');
  const { db } = require('../db');
  const r = await db.markClientPaidReceiptSent(77);

  if (original) require.cache[pgPath] = original; else delete require.cache[pgPath];
  clearReq('../db');

  assert.ok(r, 'returns the RETURNING row on a successful stamp');
  assert.strictEqual(r.id, 77);
  assert.strictEqual(queries.length, 1, 'exactly one SQL round-trip');
  const q = queries[0];
  assert.ok(/UPDATE invoices/i.test(q.sql), 'UPDATEs invoices');
  assert.ok(/client_paid_receipt_sent_at = NOW\(\)/i.test(q.sql), 'sets stamp to NOW()');
  assert.ok(/updated_at = NOW\(\)/i.test(q.sql), 'bumps updated_at so dashboard ordering reflects the new state');
  assert.ok(/WHERE id = \$1/i.test(q.sql), 'targets the invoice id by param');
  assert.ok(/AND client_paid_receipt_sent_at IS NULL/i.test(q.sql),
    'IS NULL guard locks idempotency — a concurrent stamp loses the race cleanly');
  assert.ok(/RETURNING id, client_paid_receipt_sent_at/i.test(q.sql),
    'RETURNING shape lets the caller detect stamp-took vs. race-lost without a follow-up read');
  assert.deepStrictEqual(q.params, [77]);
}

async function testMarkSqlContractFalsyId() {
  const pgPath = require.resolve('pg');
  const original = require.cache[pgPath];
  const queries = [];
  require.cache[pgPath] = {
    id: pgPath, filename: pgPath, loaded: true,
    exports: {
      Pool: function () {
        return {
          query: async (sql, params) => {
            queries.push({ sql, params });
            return { rows: [] };
          }
        };
      }
    }
  };
  clearReq('../db');
  const { db } = require('../db');
  assert.strictEqual(await db.markClientPaidReceiptSent(null), null);
  assert.strictEqual(await db.markClientPaidReceiptSent(0), null);
  assert.strictEqual(await db.markClientPaidReceiptSent(undefined), null);

  if (original) require.cache[pgPath] = original; else delete require.cache[pgPath];
  clearReq('../db');

  assert.strictEqual(queries.length, 0,
    'falsy invoiceId must short-circuit before any SQL round-trip');
}

// ---------- routes/invoices.js POST /:id/status integration -------------

function buildInvoicesApp({ triggerCalls, dbOverrides }) {
  const dbStub = {
    pool: { query: async () => ({ rows: [] }) },
    db: Object.assign({
      async getUserById(id) { return { id, plan: 'pro', webhook_url: null, email: 'owner@x.com' }; },
      async getInvoicesByUser() { return []; },
      async getRecentRevenueStats() { return null; },
      async updateInvoiceStatus(id, userId, status) {
        return {
          id, user_id: userId, status,
          total: '100', invoice_number: 'INV-2026-0007',
          client_name: 'Acme', client_email: 'finance@acme.com',
          is_seed: false
        };
      },
      async recordFirstSentIfMissing() { return null; },
      async recordFirstPaidIfMissing() { return null; },
      async markClientPaidReceiptSent(id) {
        return { id, client_paid_receipt_sent_at: new Date() };
      }
    }, dbOverrides || {})
  };
  require.cache[require.resolve('../db')] = {
    id: require.resolve('../db'), filename: require.resolve('../db'),
    loaded: true, exports: dbStub
  };
  // Stub the paid-receipt module so we can observe the call.
  require.cache[require.resolve('../lib/paid-receipt')] = {
    id: require.resolve('../lib/paid-receipt'),
    filename: require.resolve('../lib/paid-receipt'),
    loaded: true,
    exports: {
      triggerPaidReceipt: async (_db, invoice, owner) => {
        triggerCalls.push({ invoiceId: invoice && invoice.id, ownerId: owner && owner.id, clientEmail: invoice && invoice.client_email, status: invoice && invoice.status });
        return null;
      }
    }
  };
  // Stub stripe-payment-link so requiring the route doesn't init Stripe.
  require.cache[require.resolve('../lib/stripe-payment-link')] = {
    id: require.resolve('../lib/stripe-payment-link'),
    filename: require.resolve('../lib/stripe-payment-link'),
    loaded: true,
    exports: {
      createInvoicePaymentLink: async () => ({ url: 'https://buy.stripe.com/test', id: 'plink_test' }),
      parsePaymentMethods: () => ['card']
    }
  };
  clearReq('../routes/invoices');
  const invoiceRoutes = require('../routes/invoices');
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, _res, next) => { req.session.user = { id: 7, plan: 'pro' }; next(); });
  app.use('/invoices', invoiceRoutes);
  return app;
}

function httpPost(app, urlPath, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const payload = new URLSearchParams(body).toString();
      const headers = {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(payload)
      };
      const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method: 'POST', headers }, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => server.close(() => resolve({ status: res.statusCode, body: data })));
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.write(payload);
      req.end();
    });
  });
}

async function testStatusPaidTriggersReceipt() {
  const triggerCalls = [];
  const app = buildInvoicesApp({ triggerCalls });
  const r = await httpPost(app, '/invoices/7/status', { status: 'paid' });
  assert.strictEqual(r.status, 302, 'status flip redirects');
  await new Promise((res) => setImmediate(res));
  await new Promise((res) => setImmediate(res));
  assert.strictEqual(triggerCalls.length, 1,
    'POST /:id/status with status=paid calls triggerPaidReceipt exactly once');
  assert.strictEqual(triggerCalls[0].status, 'paid',
    'the invoice passed to the trigger has the new paid status (the updated row)');
  assert.strictEqual(triggerCalls[0].clientEmail, 'finance@acme.com',
    'the invoice passed to the trigger carries the client_email so the helper can send');
  assert.strictEqual(triggerCalls[0].ownerId, 7,
    'the owner row from getUserById is forwarded so reply-to lands on the freelancer');
}

async function testStatusSentDoesNotTriggerReceipt() {
  const triggerCalls = [];
  const app = buildInvoicesApp({ triggerCalls });
  const r = await httpPost(app, '/invoices/7/status', { status: 'sent' });
  assert.strictEqual(r.status, 302);
  await new Promise((res) => setImmediate(res));
  await new Promise((res) => setImmediate(res));
  assert.strictEqual(triggerCalls.length, 0,
    'status=sent must NOT fire the paid-receipt — that surface only fires on paid');
}

async function testStatusPaidNoClientEmailStill200() {
  // The helper short-circuits internally when client_email is missing, but
  // the route layer must NOT crash before the helper gets called.
  const triggerCalls = [];
  const app = buildInvoicesApp({
    triggerCalls,
    dbOverrides: {
      async updateInvoiceStatus(id, userId, status) {
        return {
          id, user_id: userId, status,
          total: '100', invoice_number: 'INV-X',
          client_name: 'Acme', client_email: null,
          is_seed: false
        };
      }
    }
  });
  const r = await httpPost(app, '/invoices/7/status', { status: 'paid' });
  assert.strictEqual(r.status, 302, 'still redirects even with no client_email');
  await new Promise((res) => setImmediate(res));
  await new Promise((res) => setImmediate(res));
  assert.strictEqual(triggerCalls.length, 1,
    'route layer must still call triggerPaidReceipt; the helper itself decides to skip on missing client_email');
}

// ---------- routes/billing.js Stripe webhook integration ----------------

function buildBillingApp({ triggerCalls, markPaidImpl, getUserByIdImpl, eventBuilder, triggerImpl }) {
  let markedPaid = markPaidImpl;
  let userById = getUserByIdImpl;
  const dbStub = {
    pool: {
      query: async () => ({ rows: [] })
    },
    db: {
      async getUserById(id) { return userById ? userById(id) : { id, plan: 'pro', email: 'owner@x.com' }; },
      async markInvoicePaidByPaymentLinkId(linkId) { return markedPaid ? markedPaid(linkId) : null; },
      async updateUser() { return null; },
      async creditReferrerForSubscription() { return null; }
    }
  };
  require.cache[require.resolve('../db')] = {
    id: require.resolve('../db'), filename: require.resolve('../db'),
    loaded: true, exports: dbStub
  };
  // Stub stripe so constructEvent always returns the supplied event.
  require.cache[require.resolve('stripe')] = {
    id: require.resolve('stripe'), filename: require.resolve('stripe'),
    loaded: true,
    exports: () => ({
      webhooks: {
        constructEvent: () => eventBuilder()
      },
      customers: { async retrieve() { return { metadata: { user_id: '99' } }; } },
      subscriptions: { async retrieve(id) { return { id, trial_end: null }; } }
    })
  };
  // Stub the paid-receipt module so we can observe (and optionally throw) the call.
  require.cache[require.resolve('../lib/paid-receipt')] = {
    id: require.resolve('../lib/paid-receipt'),
    filename: require.resolve('../lib/paid-receipt'),
    loaded: true,
    exports: {
      triggerPaidReceipt: async (_db, invoice, owner) => {
        triggerCalls.push({ invoiceId: invoice && invoice.id, ownerId: owner && owner.id });
        if (triggerImpl) return triggerImpl();
        return null;
      }
    }
  };
  // Stub outbound webhook + paid-notification + celebration + referral so we don't fire side effects.
  require.cache[require.resolve('../lib/outbound-webhook')] = {
    id: require.resolve('../lib/outbound-webhook'),
    filename: require.resolve('../lib/outbound-webhook'),
    loaded: true,
    exports: {
      isValidWebhookUrl: async () => true,
      firePaidWebhook: async () => ({ ok: true }),
      buildPaidPayload: (inv) => ({ event: 'invoice.paid', invoice_id: inv && inv.id })
    }
  };
  clearReq('../lib/email');
  const realEmail = require('../lib/email');
  require.cache[require.resolve('../lib/email')] = {
    id: require.resolve('../lib/email'),
    filename: require.resolve('../lib/email'),
    loaded: true,
    exports: Object.assign({}, realEmail, {
      sendPaidNotificationEmail: async () => ({ ok: true, id: 'em_x' })
    })
  };
  require.cache[require.resolve('../lib/celebration')] = {
    id: require.resolve('../lib/celebration'),
    filename: require.resolve('../lib/celebration'),
    loaded: true,
    exports: {
      triggerFirstPaidCelebration: async () => null,
      buildReferralUrl: () => ''
    }
  };
  require.cache[require.resolve('../lib/referral')] = {
    id: require.resolve('../lib/referral'),
    filename: require.resolve('../lib/referral'),
    loaded: true,
    exports: {
      creditReferrerForSubscription: async () => null
    }
  };
  clearReq('../routes/billing');
  const billingRoutes = require('../routes/billing');
  const app = express();
  app.use('/billing/webhook', express.raw({ type: 'application/json' }));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use((req, _res, next) => { req.session = { user: null }; next(); });
  app.use('/billing', billingRoutes);
  return app;
}

function webhook(app, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const buf = Buffer.from(JSON.stringify(body));
      const headers = {
        'Content-Type': 'application/json',
        'Content-Length': buf.length,
        'stripe-signature': 'valid-sig'
      };
      const req = http.request(
        { hostname: '127.0.0.1', port, path: '/billing/webhook', method: 'POST', headers },
        res => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => server.close(() => resolve({ status: res.statusCode, body: data })));
        }
      );
      req.on('error', err => { server.close(); reject(err); });
      req.write(buf);
      req.end();
    });
  });
}

async function testWebhookPaymentLinkFiresReceipt() {
  const triggerCalls = [];
  const event = {
    type: 'checkout.session.completed',
    data: { object: { mode: 'payment', payment_link: 'plink_test_42' } }
  };
  const app = buildBillingApp({
    triggerCalls,
    markPaidImpl: () => ({
      id: 55, user_id: 7, invoice_number: 'INV-2026-0042',
      total: '1200.00', currency: 'usd', client_name: 'Acme',
      client_email: 'finance@acme.com', status: 'paid',
      public_token: 'cafe0001cafe0001'
    }),
    getUserByIdImpl: (id) => ({ id, plan: 'pro', email: 'sam@studio.com', name: 'Sam', webhook_url: null }),
    eventBuilder: () => event
  });
  const r = await webhook(app, event);
  assert.strictEqual(r.status, 200, 'webhook returns 200');
  await new Promise(res => setImmediate(res));
  await new Promise(res => setImmediate(res));
  assert.strictEqual(triggerCalls.length, 1,
    'payment_link paid → triggerPaidReceipt called exactly once');
  assert.strictEqual(triggerCalls[0].invoiceId, 55,
    'must pass the marked-paid invoice to the receipt trigger');
  assert.strictEqual(triggerCalls[0].ownerId, 7,
    'must pass the owner row to the receipt trigger so reply-to lands on the freelancer');
}

async function testWebhookSubscriptionDoesNotFireReceipt() {
  const triggerCalls = [];
  const event = {
    type: 'checkout.session.completed',
    data: { object: { mode: 'subscription', customer: 'cus_x', subscription: 'sub_y' } }
  };
  const app = buildBillingApp({
    triggerCalls,
    eventBuilder: () => event
  });
  const r = await webhook(app, event);
  assert.strictEqual(r.status, 200);
  await new Promise(res => setImmediate(res));
  await new Promise(res => setImmediate(res));
  assert.strictEqual(triggerCalls.length, 0,
    'subscription-mode checkout must NOT fire a client receipt — that is a freelancer upgrade, not an invoice payment');
}

async function testWebhookReceiptThrowStillReturns200() {
  const triggerCalls = [];
  const event = {
    type: 'checkout.session.completed',
    data: { object: { mode: 'payment', payment_link: 'plink_x' } }
  };
  const app = buildBillingApp({
    triggerCalls,
    markPaidImpl: () => ({
      id: 56, user_id: 8, invoice_number: 'INV-X', total: '50.00',
      currency: 'usd', client_name: 'Globex', client_email: 'c@globex.com'
    }),
    getUserByIdImpl: (id) => ({ id, plan: 'pro', email: 'jane@x.com' }),
    eventBuilder: () => event,
    triggerImpl: () => { throw new Error('Resend exploded'); }
  });
  const r = await webhook(app, event);
  assert.strictEqual(r.status, 200,
    'webhook must still return 200 — fire-and-forget guarantee');
  await new Promise(res => setImmediate(res));
  await new Promise(res => setImmediate(res));
  assert.strictEqual(triggerCalls.length, 1,
    'the trigger was attempted exactly once — its rejection was swallowed');
}

// ---------- Runner --------------------------------------------------------

async function run() {
  const tests = [
    ['buildPaidReceiptSubject: includes invoice number + "paid" + thanks; distinct from "just paid"', testBuildSubject],
    ['buildPaidReceiptSubject: falls back without literal "undefined"', testBuildSubjectFallsBackOnMissingNumber],
    ['buildPaidReceiptHtml: escapes XSS on client_name + sender; renders view-receipt button on public /i/<token>', testBuildHtmlEscapesAndRendersButton],
    ['buildPaidReceiptHtml: omits view button when APP_URL is unset', testBuildHtmlOmitsButtonWithoutAppUrl],
    ['buildPaidReceiptHtml: omits view button when invoice has no public_token', testBuildHtmlOmitsButtonWithoutToken],
    ['buildPaidReceiptText: includes facts + canonical public /i/<token> URL (no double slash)', testBuildTextIncludesAllFactsAndUrl],
    ['lib/email exports: sendPaidReceiptEmail + build* are exported; existing exports intact', testEmailLibExports],
    ['sendPaidReceiptEmail: invalid_args on null invoice or null owner', testSendShortCircuitsOnMissingArgs],
    ['sendPaidReceiptEmail: no_client_email on missing client_email', testSendShortCircuitsOnNoClientEmail],
    ['sendPaidReceiptEmail: happy path — recipient is CLIENT, reply_to via owner precedence', testSendHappyPathSendsToClient],
    ['triggerPaidReceipt: null db / invoice / owner → null', testTriggerNullArgs],
    ['triggerPaidReceipt: missing markClientPaidReceiptSent → null', testTriggerMissingMethod],
    ['triggerPaidReceipt: is_seed → null without stamp', testTriggerSeedShortCircuits],
    ['triggerPaidReceipt: missing/whitespace client_email → null without stamp', testTriggerMissingClientEmailShortCircuits],
    ['triggerPaidReceipt: already-stamped → null without DB call', testTriggerAlreadyStampedShortCircuits],
    ['triggerPaidReceipt: stamp throw → null', testTriggerStampThrow],
    ['triggerPaidReceipt: stamp returns null (race lost) → null without send', testTriggerStampRaceLost],
    ['triggerPaidReceipt: happy path stamps then sends, returns { stamped, send }; trims client_email', testTriggerHappyPath],
    ['triggerPaidReceipt: send throw → keeps stamp, surfaces error envelope', testTriggerSendThrow],
    ['triggerPaidReceipt: not_configured → unstamps so a future flip can retry', testTriggerNotConfiguredUnstamps],
    ['db.markClientPaidReceiptSent: UPDATE shape + IS NULL guard + RETURNING + params', testMarkSqlContractHappy],
    ['db.markClientPaidReceiptSent: falsy invoiceId short-circuits before any SQL', testMarkSqlContractFalsyId],
    ['POST /invoices/:id/status status=paid → triggerPaidReceipt called once with updated row + owner', testStatusPaidTriggersReceipt],
    ['POST /invoices/:id/status status=sent → does NOT call triggerPaidReceipt', testStatusSentDoesNotTriggerReceipt],
    ['POST /invoices/:id/status status=paid with no client_email → route still 302s, trigger still called (helper decides)', testStatusPaidNoClientEmailStill200],
    ['Webhook payment_link paid → triggerPaidReceipt called once with marked-paid invoice + owner', testWebhookPaymentLinkFiresReceipt],
    ['Webhook subscription mode → does NOT call triggerPaidReceipt', testWebhookSubscriptionDoesNotFireReceipt],
    ['Webhook triggerPaidReceipt throw → webhook still returns 200 (fire-and-forget)', testWebhookReceiptThrowStillReturns200]
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

run().catch(err => { console.error(err); process.exit(1); });
