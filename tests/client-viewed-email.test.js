'use strict';

/*
 * Client-viewed notification email tests (Milestone 4 — sent → paid).
 *
 * When a non-bot human client first opens the freelancer's /i/<token>
 * share link, the freelancer is emailed: "Your client just opened
 * invoice X". This pulls them back into the app at the exact moment a
 * follow-up message most likely lands a payment — and re-exposes them
 * to the trial-urgency stack, exit-intent modal, celebration banner,
 * and upgrade-modal surfaces on each return.
 *
 * Covers:
 *  - lib/email builders: subject includes invoice number + client name;
 *    HTML XSS-escapes hostile client_name / owner name; formatted
 *    total appears; "Send a follow-up" button is gated on APP_URL;
 *    text body carries the same facts + a /invoices/:id URL when
 *    APP_URL is set.
 *  - sendClientViewedEmail short-circuits on missing owner / missing
 *    owner.email; happy-path sends to the owner (not the client) and
 *    sets reply_to via resolveReplyTo precedence.
 *  - GET /i/<token> route integration: on a first non-bot view
 *    (view_count returns 1), the email fires exactly once; on a second
 *    view (view_count returns 2), the email does NOT fire; a bot UA
 *    suppresses both the record AND the email; a seed-invoice path
 *    (defense-in-depth) does NOT fire the email even if view_count
 *    somehow returns 1; an owner with no email does NOT fire the
 *    email; a sendClientViewedEmail rejection does NOT break the
 *    public client render; a recordPublicInvoiceView throw does NOT
 *    break the render and does NOT call the email.
 *
 * Run: NODE_ENV=test node tests/client-viewed-email.test.js
 */

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

const assert = require('assert');
const path = require('path');
const express = require('express');
const http = require('http');

const VIEWS = path.join(__dirname, '..', 'views');

function clearReq(mod) { delete require.cache[require.resolve(mod)]; }

// ---------- Lib builders -------------------------------------------------

async function testBuildSubject() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const subject = email.buildClientViewedSubject({
    invoice_number: 'INV-2026-0042',
    client_name: 'Acme Co'
  });
  assert.ok(subject.includes('INV-2026-0042'),
    'subject must include the invoice number');
  assert.ok(subject.includes('Acme Co'),
    'subject must include the client name so the inbox preview is informative');
  assert.ok(/just opened/i.test(subject),
    'subject must communicate the open event for emotional impact');
}

async function testBuildSubjectFallsBackOnMissingFields() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const subject = email.buildClientViewedSubject({});
  assert.ok(/invoice/i.test(subject),
    'subject still names the event even when invoice fields are missing');
  assert.ok(!subject.includes('undefined'),
    'no raw "undefined" substring may leak into the subject line');
}

async function testBuildHtmlEscapesAndIncludesButton() {
  clearReq('../lib/email');
  const prev = process.env.APP_URL;
  process.env.APP_URL = 'https://decentinvoice.com';
  const email = require('../lib/email');
  const html = email.buildClientViewedHtml(
    {
      id: 88,
      invoice_number: 'INV-2026-0042',
      total: '300.00',
      currency: 'usd',
      client_name: '<script>alert(1)</script>'
    },
    { name: '<b>Jordan</b>', email: 'jordan@x.com' }
  );
  if (prev === undefined) delete process.env.APP_URL; else process.env.APP_URL = prev;

  assert.ok(!html.includes('<script>alert(1)</script>'),
    'raw client_name must not appear unescaped (XSS guard)');
  assert.ok(html.includes('&lt;script&gt;'),
    'hostile client_name is HTML-escaped');
  assert.ok(!html.includes('<b>Jordan</b>'),
    'raw owner name must not be allowed as HTML');
  assert.ok(html.includes('&lt;b&gt;Jordan&lt;/b&gt;'),
    'owner name is HTML-escaped');
  assert.ok(html.includes('$300.00'),
    'total appears with currency symbol');
  assert.ok(html.includes('INV-2026-0042'),
    'invoice number appears in the body');
  assert.ok(html.includes('https://decentinvoice.com/invoices/88'),
    'follow-up button points at the owner-facing /invoices/:id URL');
  assert.ok(/just opened/i.test(html),
    'headline communicates the open event');
}

async function testBuildHtmlOmitsButtonWhenAppUrlUnset() {
  clearReq('../lib/email');
  const prev = process.env.APP_URL;
  delete process.env.APP_URL;
  const email = require('../lib/email');
  const html = email.buildClientViewedHtml(
    { id: 12, invoice_number: 'INV-X', total: '5.00', currency: 'usd', client_name: 'Acme' },
    { name: 'Sam', email: 'sam@x.com' }
  );
  if (prev !== undefined) process.env.APP_URL = prev;

  assert.ok(!/href="https?:\/\//.test(html),
    'no follow-up button must render when APP_URL is not set');
  // Body still informative.
  assert.ok(html.includes('INV-X'));
  assert.ok(html.includes('$5.00'));
  assert.ok(html.includes('Acme'));
}

async function testBuildTextIncludesFactsAndUrl() {
  clearReq('../lib/email');
  const prev = process.env.APP_URL;
  process.env.APP_URL = 'https://decentinvoice.com/';   // trailing slash on purpose
  const email = require('../lib/email');
  const text = email.buildClientViewedText({
    id: 33,
    invoice_number: 'INV-2026-0033',
    total: '99.99',
    currency: 'usd',
    client_name: 'Globex'
  });
  if (prev === undefined) delete process.env.APP_URL; else process.env.APP_URL = prev;

  assert.ok(text.includes('INV-2026-0033'));
  assert.ok(text.includes('$99.99'));
  assert.ok(text.includes('Globex'));
  assert.ok(text.includes('https://decentinvoice.com/invoices/33'),
    'plain-text body includes canonical view URL with single slash');
  assert.ok(!text.includes('decentinvoice.com//invoices'),
    'trailing slash on APP_URL must be normalised away');
}

async function testEmailLibExports() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  assert.strictEqual(typeof email.sendClientViewedEmail, 'function');
  assert.strictEqual(typeof email.buildClientViewedSubject, 'function');
  assert.strictEqual(typeof email.buildClientViewedHtml, 'function');
  assert.strictEqual(typeof email.buildClientViewedText, 'function');
}

async function testSendShortCircuitsOnMissingOwner() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const r1 = await email.sendClientViewedEmail(
    { id: 1, invoice_number: 'INV-1', total: '10', client_name: 'X' },
    null
  );
  assert.strictEqual(r1.ok, false);
  assert.strictEqual(r1.reason, 'invalid_args',
    'a null owner short-circuits before Resend is touched');

  const r2 = await email.sendClientViewedEmail(
    { id: 1, invoice_number: 'INV-1', total: '10', client_name: 'X' },
    { name: 'Sam', email: null }
  );
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.reason, 'no_owner_email',
    'missing owner.email short-circuits before Resend is touched');
}

async function testSendShortCircuitsOnMissingInvoice() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const r = await email.sendClientViewedEmail(null, { email: 'a@b.com' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'invalid_args',
    'a null invoice short-circuits before Resend is touched');
}

async function testSendHappyPathSendsToOwner() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const sends = [];
  email.setResendClient({
    emails: {
      async send(payload) {
        sends.push(payload);
        return { data: { id: 'em_view_1' }, error: null };
      }
    }
  });

  const r = await email.sendClientViewedEmail(
    {
      id: 7,
      invoice_number: 'INV-2026-0007',
      total: '750.00',
      currency: 'usd',
      client_name: 'Acme Co'
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
  assert.deepStrictEqual(payload.to, ['freelancer@me.com'],
    'recipient is the FREELANCER (owner.email), not the client');
  assert.ok(payload.subject.includes('INV-2026-0007'));
  assert.ok(payload.subject.includes('Acme Co'));
  // reply_to follows resolveReplyTo precedence — falls through to business_email
  // when reply_to_email is null.
  assert.strictEqual(payload.reply_to, 'invoices@me.com',
    'reply-to falls through to business_email when reply_to_email is null');
  email.resetResendClient();
}

// ---------- Route integration -------------------------------------------

function buildShareApp({ invoiceRow, recordImpl, recordCalls, sendImpl, sendCalls }) {
  const calls = recordCalls || [];
  // Stub db so the share route uses our in-memory invoice + record-view.
  const dbStub = {
    pool: { query: async () => ({ rows: [] }) },
    db: {
      async getInvoiceByPublicToken(token) {
        if (!/^[a-f0-9]{8,32}$/i.test(token || '')) return null;
        return invoiceRow;
      },
      recordPublicInvoiceView: recordImpl || (async (id) => {
        calls.push(id);
        return { id, view_count: 1, first_viewed_at: new Date(), last_viewed_at: new Date() };
      })
    }
  };
  require.cache[require.resolve('../db')] = {
    id: require.resolve('../db'), filename: require.resolve('../db'),
    loaded: true, exports: dbStub
  };
  // Stub email lib so the route imports our spy.
  clearReq('../lib/email');
  const realEmail = require('../lib/email');
  const emailStub = {
    ...realEmail,
    sendClientViewedEmail: async (invoice, owner) => {
      sendCalls.push({ invoice, owner });
      return sendImpl ? sendImpl(invoice, owner) : { ok: true, id: 'em_x' };
    }
  };
  require.cache[require.resolve('../lib/email')] = {
    id: require.resolve('../lib/email'), filename: require.resolve('../lib/email'),
    loaded: true, exports: emailStub
  };
  clearReq('../routes/share');
  const shareRoutes = require('../routes/share');
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', VIEWS);
  app.use('/', shareRoutes);
  return app;
}

function getPath(app, urlPath, headers) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      http.get({ hostname: '127.0.0.1', port, path: urlPath, headers: headers || {} }, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => server.close(() => resolve({ status: res.statusCode, body: data })));
      }).on('error', (e) => { server.close(); reject(e); });
    });
  });
}

function sampleInvoiceRow(overrides) {
  return Object.assign({
    id: 88,
    invoice_number: 'INV-2026-0042',
    client_name: 'Acme Co.',
    client_email: 'pay@acme.com',
    client_address: '',
    items: [{ description: 'Design', quantity: 1, unit_price: 300 }],
    subtotal: 300, tax_rate: 0, tax_amount: 0, total: 300,
    notes: null, status: 'sent',
    issued_date: new Date('2026-05-01'), due_date: new Date('2026-05-31'),
    payment_link_url: 'https://buy.stripe.com/x', public_token: 'cafef00ddeadbeef',
    is_seed: false,
    owner_id: 11, owner_name: 'Jordan', owner_email: 'jordan@x.com',
    owner_reply_to_email: null,
    owner_business_name: 'Pine Studio', owner_business_address: '',
    owner_business_email: 'hi@pinestudio.com', owner_business_phone: '',
    owner_plan: 'pro'
  }, overrides || {});
}

const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function flushAsync() {
  // Drain the fire-and-forget chain (recordPublicInvoiceView → .then →
  // sendClientViewedEmail). Two setImmediate ticks: one for the record-
  // view resolution, one for the email-send resolution.
  await new Promise((res) => setImmediate(res));
  await new Promise((res) => setImmediate(res));
}

async function testFirstViewFiresEmail() {
  const recordCalls = [];
  const sendCalls = [];
  const app = buildShareApp({
    invoiceRow: sampleInvoiceRow(),
    recordCalls,
    sendCalls
  });
  const r = await getPath(app, '/i/cafef00ddeadbeef', { 'User-Agent': CHROME_UA });
  assert.strictEqual(r.status, 200);
  await flushAsync();
  assert.deepStrictEqual(recordCalls, [88], 'record fires once');
  assert.strictEqual(sendCalls.length, 1,
    'a first non-bot view must fire sendClientViewedEmail exactly once');
  const sent = sendCalls[0];
  assert.strictEqual(sent.invoice.id, 88);
  assert.strictEqual(sent.invoice.invoice_number, 'INV-2026-0042');
  assert.strictEqual(sent.owner.email, 'jordan@x.com',
    'email recipient is the owner email lifted from the joined invoice row');
  assert.strictEqual(sent.owner.name, 'Jordan');
  assert.strictEqual(sent.owner.business_email, 'hi@pinestudio.com');
}

async function testSecondViewDoesNotFireEmail() {
  // recordPublicInvoiceView returns view_count = 2 → this is the second
  // open by the client (or a forwarded second look). The dashboard badge
  // updates, but the freelancer must NOT be re-emailed for every open —
  // that would train them to ignore the notification entirely.
  const sendCalls = [];
  const app = buildShareApp({
    invoiceRow: sampleInvoiceRow(),
    recordImpl: async (id) => ({ id, view_count: 2, first_viewed_at: new Date(), last_viewed_at: new Date() }),
    sendCalls
  });
  const r = await getPath(app, '/i/cafef00ddeadbeef', { 'User-Agent': CHROME_UA });
  assert.strictEqual(r.status, 200);
  await flushAsync();
  assert.strictEqual(sendCalls.length, 0,
    'a non-first view (view_count > 1) must NOT fire sendClientViewedEmail');
}

async function testBotUaDoesNotFireEmail() {
  const sendCalls = [];
  const app = buildShareApp({
    invoiceRow: sampleInvoiceRow(),
    sendCalls
  });
  const r = await getPath(app, '/i/cafef00ddeadbeef', {
    'User-Agent': 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)'
  });
  assert.strictEqual(r.status, 200);
  await flushAsync();
  assert.strictEqual(sendCalls.length, 0,
    'a bot UA must not fire the client-viewed email (no human signal)');
}

async function testSeedInvoiceDoesNotFireEmail() {
  // Defense-in-depth: seed invoices never carry a public_token, but if a
  // future deploy regresses that invariant, surfacing a "your client just
  // opened your seed sample" email would erode trust in the signal.
  const sendCalls = [];
  const app = buildShareApp({
    invoiceRow: sampleInvoiceRow({ is_seed: true }),
    sendCalls
  });
  const r = await getPath(app, '/i/cafef00ddeadbeef', { 'User-Agent': CHROME_UA });
  assert.strictEqual(r.status, 200);
  await flushAsync();
  assert.strictEqual(sendCalls.length, 0,
    'a seed invoice must NEVER fire the client-viewed email even on a first view');
}

async function testNoOwnerEmailDoesNotFireEmail() {
  // owner_email is non-null in production (NOT NULL constraint on users.email),
  // but a future legacy row or a defensive code path could surface null —
  // gate cleanly on it rather than letting Resend reject the empty `to`.
  const sendCalls = [];
  const app = buildShareApp({
    invoiceRow: sampleInvoiceRow({ owner_email: null }),
    sendCalls
  });
  const r = await getPath(app, '/i/cafef00ddeadbeef', { 'User-Agent': CHROME_UA });
  assert.strictEqual(r.status, 200);
  await flushAsync();
  assert.strictEqual(sendCalls.length, 0,
    'a missing owner_email must not surface a malformed email payload');
}

async function testEmailRejectionDoesNotBreakRender() {
  const sendCalls = [];
  const app = buildShareApp({
    invoiceRow: sampleInvoiceRow(),
    sendCalls,
    sendImpl: async () => { throw new Error('Resend 502'); }
  });
  const r = await getPath(app, '/i/cafef00ddeadbeef', { 'User-Agent': CHROME_UA });
  assert.strictEqual(r.status, 200, 'render still succeeds even if email send fails');
  assert.ok(r.body.includes('INV-2026-0042'),
    'invoice content still in the response body');
  await flushAsync();
  assert.strictEqual(sendCalls.length, 1,
    'email was attempted exactly once before the error path swallowed the rejection');
}

async function testRecordViewThrowSuppressesEmail() {
  const sendCalls = [];
  const app = buildShareApp({
    invoiceRow: sampleInvoiceRow(),
    recordImpl: async () => { throw new Error('pool exhausted'); },
    sendCalls
  });
  const r = await getPath(app, '/i/cafef00ddeadbeef', { 'User-Agent': CHROME_UA });
  assert.strictEqual(r.status, 200, 'render still succeeds even if record-view throws');
  await flushAsync();
  assert.strictEqual(sendCalls.length, 0,
    'if recordPublicInvoiceView throws, sendClientViewedEmail must NOT fire');
}

async function testRecordViewReturnsNullSuppressesEmail() {
  // recordPublicInvoiceView returns null for invoiceId 0 / NaN / missing-row —
  // the email path must short-circuit on a null row rather than NPE.
  const sendCalls = [];
  const app = buildShareApp({
    invoiceRow: sampleInvoiceRow(),
    recordImpl: async () => null,
    sendCalls
  });
  const r = await getPath(app, '/i/cafef00ddeadbeef', { 'User-Agent': CHROME_UA });
  assert.strictEqual(r.status, 200);
  await flushAsync();
  assert.strictEqual(sendCalls.length, 0,
    'a null recordPublicInvoiceView result must not fire the email');
}

// ---------- Schema sanity ------------------------------------------------

async function testGetInvoiceByPublicTokenIncludesIsSeedAndReplyTo() {
  // The defense-in-depth seed-guard and replyTo precedence both depend on
  // these fields being JOIN-loaded in a single query; lock the SELECT shape.
  const pgPath = require.resolve('pg');
  const originalPg = require.cache[pgPath];
  const captured = [];
  require.cache[pgPath] = {
    id: pgPath, filename: pgPath, loaded: true,
    exports: {
      Pool: function () {
        return { query: async (text, params) => {
          captured.push({ text, params });
          return { rows: [] };
        }};
      }
    }
  };
  delete require.cache[require.resolve('../db')];
  try {
    const { db } = require('../db');
    await db.getInvoiceByPublicToken('cafef00ddeadbeef');
    assert.strictEqual(captured.length, 1);
    const q = captured[0].text;
    assert.ok(/i\.is_seed/i.test(q),
      'getInvoiceByPublicToken must SELECT i.is_seed (seed-guard for client-viewed email)');
    assert.ok(/u\.reply_to_email\s+AS\s+owner_reply_to_email/i.test(q),
      'getInvoiceByPublicToken must SELECT u.reply_to_email AS owner_reply_to_email');
  } finally {
    if (originalPg) require.cache[pgPath] = originalPg;
    else delete require.cache[pgPath];
    delete require.cache[require.resolve('../db')];
  }
}

// ---------- Runner -------------------------------------------------------

async function run() {
  const tests = [
    ['buildClientViewedSubject: includes invoice number + client name', testBuildSubject],
    ['buildClientViewedSubject: graceful fallback on missing fields', testBuildSubjectFallsBackOnMissingFields],
    ['buildClientViewedHtml: XSS-escapes hostile names + renders button when APP_URL set', testBuildHtmlEscapesAndIncludesButton],
    ['buildClientViewedHtml: omits button when APP_URL is unset', testBuildHtmlOmitsButtonWhenAppUrlUnset],
    ['buildClientViewedText: includes facts + canonical URL', testBuildTextIncludesFactsAndUrl],
    ['lib/email exports client-viewed builders + sender', testEmailLibExports],
    ['sendClientViewedEmail: short-circuits on missing owner', testSendShortCircuitsOnMissingOwner],
    ['sendClientViewedEmail: short-circuits on missing invoice', testSendShortCircuitsOnMissingInvoice],
    ['sendClientViewedEmail: happy path sends to owner with reply-to precedence', testSendHappyPathSendsToOwner],
    ['GET /i/<token>: first view fires sendClientViewedEmail once', testFirstViewFiresEmail],
    ['GET /i/<token>: second view does NOT fire the email', testSecondViewDoesNotFireEmail],
    ['GET /i/<token>: bot UA does NOT fire the email', testBotUaDoesNotFireEmail],
    ['GET /i/<token>: seed invoice does NOT fire the email (defense)', testSeedInvoiceDoesNotFireEmail],
    ['GET /i/<token>: missing owner_email does NOT fire the email', testNoOwnerEmailDoesNotFireEmail],
    ['GET /i/<token>: email rejection does not break render', testEmailRejectionDoesNotBreakRender],
    ['GET /i/<token>: record-view throw suppresses email + does not break render', testRecordViewThrowSuppressesEmail],
    ['GET /i/<token>: record-view returns null suppresses email', testRecordViewReturnsNullSuppressesEmail],
    ['db.getInvoiceByPublicToken: SELECT shape includes is_seed + reply_to_email', testGetInvoiceByPublicTokenIncludesIsSeedAndReplyTo]
  ];
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log('  ✓', name);
    } catch (err) {
      failed++;
      console.error('  ✗', name);
      console.error(err.stack || err.message);
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log(`\nAll ${tests.length} tests passed`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
