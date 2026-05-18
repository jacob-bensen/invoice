'use strict';

/*
 * Follow-up share-intent tests (Milestone 4 — first sent → first paid).
 *
 * Covers:
 *   - lib/share-link.buildFollowUpShareIntents: body composition with the
 *     "just checking in" framing (vs the first-send "here's invoice X"),
 *     overdue suffix wiring, URL encoding contract on every output, missing
 *     client_name fallback, missing total fallback, null-on-no-url,
 *     mailto recipient percent-encoding (defence against malformed emails
 *     injecting extra mailto: query params).
 *   - POST /invoices/:id/share: response now carries `followUpIntents`
 *     alongside the existing `shareIntents` shape. daysOverdue derived
 *     from invoice.due_date.
 *   - views/invoice-view.ejs: follow-up section is plan-neutral and only
 *     renders for status='sent' or status='overdue' — never for 'draft'
 *     or 'paid'. Hrefs are bound to followUpIntents.* from the Alpine
 *     state; the existing fireIntent helper is reused for tracking.
 *
 * Run: NODE_ENV=test node tests/follow-up-share-intents.test.js
 */

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

const assert = require('assert');
const path = require('path');
const ejs = require('ejs');
const express = require('express');
const session = require('express-session');
const http = require('http');

const VIEWS = path.join(__dirname, '..', 'views');

// ---------- lib/share-link.buildFollowUpShareIntents --------------------

function testFollowUpHappyPath() {
  delete require.cache[require.resolve('../lib/share-link')];
  const { buildFollowUpShareIntents } = require('../lib/share-link');
  const out = buildFollowUpShareIntents({
    invoiceNumber: 'INV-2026-0042',
    total: 1500,
    clientName: 'Acme Co',
    clientEmail: 'pay@acme.example',
    url: 'https://decentinvoice.com/i/cafef00ddeadbeef'
  });
  assert.ok(out, 'returns a non-null object on a populated input');
  assert.strictEqual(typeof out.whatsapp, 'string');
  assert.strictEqual(typeof out.sms, 'string');
  assert.strictEqual(typeof out.mailto, 'string');
  assert.strictEqual(typeof out.body, 'string');
  assert.strictEqual(typeof out.subject, 'string');
  // Body framing: follow-up, NOT first-send
  assert.ok(out.body.startsWith('Hi Acme Co,'), `greets the client: "${out.body}"`);
  assert.ok(out.body.includes('just checking in'),
    'body uses the follow-up "just checking in" framing — not "here\'s invoice"');
  assert.ok(!out.body.includes("here's invoice"),
    'body avoids the first-send "here\'s invoice X" framing');
  assert.ok(out.body.includes('invoice INV-2026-0042'),
    'body names the invoice');
  assert.ok(out.body.includes('$1500.00'), 'body shows the formatted total');
  assert.ok(out.body.endsWith('https://decentinvoice.com/i/cafef00ddeadbeef'),
    'URL is last so a truncated SMS preview keeps the click target');
  assert.strictEqual(out.overdue, false,
    'overdue defaults to false when no daysOverdue is passed');
}

function testFollowUpSubjectShape() {
  delete require.cache[require.resolve('../lib/share-link')];
  const { buildFollowUpShareIntents } = require('../lib/share-link');
  const out = buildFollowUpShareIntents({
    invoiceNumber: 'INV-7',
    total: 50,
    url: '/i/abcd1234abcd1234'
  });
  assert.strictEqual(out.subject, 'Quick check-in: Invoice INV-7 — $50.00');
}

function testFollowUpOverdueSuffix() {
  delete require.cache[require.resolve('../lib/share-link')];
  const { buildFollowUpShareIntents } = require('../lib/share-link');
  const out = buildFollowUpShareIntents({
    invoiceNumber: 'INV-9',
    total: 100,
    clientName: 'X',
    url: '/i/abcd1234abcd1234',
    daysOverdue: 5
  });
  assert.strictEqual(out.overdue, true,
    'overdue flag flips when daysOverdue > 0');
  assert.ok(out.body.includes('(now overdue)'),
    `overdue body carries a "(now overdue)" status clause; got "${out.body}"`);
  assert.ok(out.subject.startsWith('Reminder:'),
    `overdue subject leads with "Reminder:"; got "${out.subject}"`);
  assert.ok(out.subject.includes('overdue'),
    'overdue subject names the overdue status');
}

function testFollowUpZeroOrNegativeDaysOverdueIsNotOverdue() {
  delete require.cache[require.resolve('../lib/share-link')];
  const { buildFollowUpShareIntents } = require('../lib/share-link');
  // daysOverdue=0 (due today) → not overdue yet, so soft "check-in" copy
  const sameDay = buildFollowUpShareIntents({
    invoiceNumber: 'INV-1', total: 100, url: '/i/abcd1234abcd1234', daysOverdue: 0
  });
  assert.strictEqual(sameDay.overdue, false, 'daysOverdue=0 stays in soft framing');
  assert.ok(!sameDay.body.includes('overdue'),
    'soft body does not name the invoice as overdue');
  // Negative (future due date) → also not overdue
  const future = buildFollowUpShareIntents({
    invoiceNumber: 'INV-1', total: 100, url: '/i/abcd1234abcd1234', daysOverdue: -3
  });
  assert.strictEqual(future.overdue, false, 'negative daysOverdue stays soft');
}

function testFollowUpUrlEncodingOnEveryOutput() {
  delete require.cache[require.resolve('../lib/share-link')];
  const { buildFollowUpShareIntents } = require('../lib/share-link');
  const out = buildFollowUpShareIntents({
    invoiceNumber: 'INV-2026-0042',
    total: 1500,
    clientName: 'Acme Co',
    clientEmail: 'pay@acme.example',
    url: 'https://decentinvoice.com/i/cafef00ddeadbeef'
  });
  // WhatsApp wraps everything in `?text=` — body must be percent-encoded
  assert.ok(out.whatsapp.startsWith('https://wa.me/?text='));
  assert.ok(!out.whatsapp.includes(' '),
    'whatsapp href must have no raw spaces — they should be %20-encoded');
  assert.ok(out.whatsapp.includes('Hi%20Acme%20Co'),
    'whatsapp body greeting must be percent-encoded');
  // SMS body uses `body=`
  assert.ok(out.sms.startsWith('sms:?&body='));
  assert.ok(!out.sms.includes(' '),
    'sms href must have no raw spaces');
  // mailto with subject + body
  assert.ok(out.mailto.startsWith('mailto:'));
  assert.ok(out.mailto.includes('subject='),
    'mailto carries the subject query param');
  assert.ok(out.mailto.includes('body='),
    'mailto carries the body query param');
  assert.ok(!out.mailto.includes(' '),
    'mailto href must have no raw spaces');
}

function testFollowUpMailtoRecipientPercentEncoded() {
  // Defence in depth — same surface as buildPublicShareIntents. A hostile
  // client_email like `victim@x.com?cc=attacker@evil.com` must not be able
  // to inject extra mailto: query params from the user's mail client.
  delete require.cache[require.resolve('../lib/share-link')];
  const { buildFollowUpShareIntents } = require('../lib/share-link');
  const out = buildFollowUpShareIntents({
    invoiceNumber: 'INV-1',
    total: 100,
    clientName: 'X',
    clientEmail: 'victim@x.com?cc=attacker@evil.com',
    url: 'https://decentinvoice.com/i/abcd1234abcd1234'
  });
  const recipientPart = out.mailto.slice('mailto:'.length).split('?')[0];
  assert.ok(recipientPart.includes('%3F'),
    `recipient must have its raw "?" percent-encoded; got "${recipientPart}"`);
  assert.ok(!recipientPart.includes('?cc='),
    'recipient must not contain a raw `?cc=` that would inject a mailto CC param');
}

function testFollowUpFallbackWhenNoClientName() {
  delete require.cache[require.resolve('../lib/share-link')];
  const { buildFollowUpShareIntents } = require('../lib/share-link');
  const out = buildFollowUpShareIntents({
    invoiceNumber: 'INV-1',
    total: 50,
    url: '/i/abcd1234abcd1234'
  });
  assert.ok(out.body.startsWith('Hi, '),
    `falls back to "Hi," when client_name is absent; got "${out.body}"`);
}

function testFollowUpRejectsMissingUrl() {
  delete require.cache[require.resolve('../lib/share-link')];
  const { buildFollowUpShareIntents } = require('../lib/share-link');
  assert.strictEqual(
    buildFollowUpShareIntents({ invoiceNumber: 'INV-1', total: 100 }),
    null,
    'returns null when url is missing — caller renders nothing rather than a half-built href'
  );
  assert.strictEqual(buildFollowUpShareIntents(null), null);
  assert.strictEqual(buildFollowUpShareIntents(undefined), null);
  assert.strictEqual(buildFollowUpShareIntents({ url: 42 }), null,
    'non-string url is treated as missing');
}

function testFollowUpNonFiniteTotalOmitsAmount() {
  delete require.cache[require.resolve('../lib/share-link')];
  const { buildFollowUpShareIntents } = require('../lib/share-link');
  const out = buildFollowUpShareIntents({
    invoiceNumber: 'INV-1',
    total: 'not-a-number',
    url: '/i/abcd1234abcd1234'
  });
  assert.ok(!out.body.includes('$'),
    `body omits the dollar amount when total is non-numeric; got "${out.body}"`);
}

// ---------- POST /invoices/:id/share carries followUpIntents ------------

function buildShareApp({ userPlan, invoiceRow, token }) {
  const dbStub = {
    pool: { query: async () => ({ rows: [] }) },
    db: {
      async getUserById() { return { id: 7, plan: userPlan }; },
      async getInvoiceById(id, uid) {
        if (!invoiceRow) return null;
        return Object.assign({ user_id: uid }, invoiceRow);
      },
      async getOrCreatePublicToken() { return token; },
      async getInvoicesByUser() { return []; },
      async getRecentRevenueStats() { return null; },
      async getNextInvoiceNumber() { return 'INV-2026-0001'; }
    }
  };
  require.cache[require.resolve('../db')] = {
    id: require.resolve('../db'), filename: require.resolve('../db'),
    loaded: true, exports: dbStub
  };
  delete require.cache[require.resolve('../routes/invoices')];
  delete require.cache[require.resolve('../lib/share-link')];
  const invoiceRoutes = require('../routes/invoices');
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', VIEWS);
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, res, next) => {
    req.session.user = { id: 7, plan: userPlan };
    next();
  });
  app.use('/invoices', invoiceRoutes);
  return app;
}

function postShare(app, id) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
      const req = http.request({
        hostname: '127.0.0.1', port, path: `/invoices/${id}/share`, method: 'POST', headers
      }, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => server.close(() => resolve({ status: res.statusCode, body: data })));
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.end();
    });
  });
}

async function testShareEndpointReturnsFollowUpIntentsForFree() {
  process.env.APP_URL = 'https://decentinvoice.com';
  // Use a far-future due date so daysOverdue is negative (not overdue)
  const futureDue = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const app = buildShareApp({
    userPlan: 'free',
    invoiceRow: {
      id: 5,
      invoice_number: 'INV-2026-0042',
      total: '1500.00',
      client_name: 'Acme Co',
      client_email: 'pay@acme.example',
      status: 'sent',
      due_date: futureDue
    },
    token: 'cafef00ddeadbeef'
  });
  const r = await postShare(app, 5);
  assert.strictEqual(r.status, 200);
  const body = JSON.parse(r.body);
  assert.ok(body.followUpIntents,
    'response carries followUpIntents alongside shareIntents+url+token');
  assert.ok(body.followUpIntents.whatsapp.startsWith('https://wa.me/?text='),
    'followUpIntents.whatsapp is a wa.me deep-link');
  assert.ok(body.followUpIntents.sms.startsWith('sms:?&body='),
    'followUpIntents.sms is an sms: deep-link');
  assert.ok(body.followUpIntents.mailto.startsWith('mailto:'),
    'followUpIntents.mailto is a mailto: deep-link');
  assert.ok(body.followUpIntents.body.includes('just checking in'),
    'follow-up body uses the soft "checking in" framing');
  assert.strictEqual(body.followUpIntents.overdue, false,
    'future due_date → not overdue');
  // shareIntents is unchanged — both surfaces coexist on the same response
  assert.ok(body.shareIntents, 'shareIntents still present');
  assert.ok(body.shareIntents.body.includes("here's invoice"),
    'shareIntents stays on the first-send framing');
  delete process.env.APP_URL;
}

async function testShareEndpointMarksOverdueWhenDueDatePassed() {
  process.env.APP_URL = 'https://decentinvoice.com';
  // 10 days ago → daysOverdue ~= 10
  const pastDue = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
  const app = buildShareApp({
    userPlan: 'pro',
    invoiceRow: {
      id: 5, invoice_number: 'INV-1', total: '300.00',
      client_name: 'Bob', client_email: 'bob@x.example',
      status: 'overdue', due_date: pastDue
    },
    token: 'beefbeefbeefbeef'
  });
  const r = await postShare(app, 5);
  assert.strictEqual(r.status, 200);
  const body = JSON.parse(r.body);
  assert.strictEqual(body.followUpIntents.overdue, true,
    'past due_date → overdue=true');
  assert.ok(body.followUpIntents.body.includes('(now overdue)'),
    'overdue body carries the "(now overdue)" clause');
  delete process.env.APP_URL;
}

async function testShareEndpointHandlesMissingDueDate() {
  // Invoices with no due_date should still get followUpIntents with
  // overdue=false rather than 500-ing on a date parse.
  const app = buildShareApp({
    userPlan: 'free',
    invoiceRow: {
      id: 5, invoice_number: 'INV-1', total: '100.00',
      client_name: 'C', client_email: 'c@x.example',
      status: 'sent', due_date: null
    },
    token: 'cafef00ddeadbeefcafef00ddeadbeef'
  });
  const r = await postShare(app, 5);
  assert.strictEqual(r.status, 200);
  const body = JSON.parse(r.body);
  assert.ok(body.followUpIntents, 'followUpIntents present even with no due_date');
  assert.strictEqual(body.followUpIntents.overdue, false,
    'missing due_date defaults to not-overdue (soft check-in framing)');
}

// ---------- views/invoice-view.ejs renders the follow-up section --------

async function renderInvoiceView({ userPlan, status, payment_link_url }) {
  return ejs.renderFile(path.join(VIEWS, 'invoice-view.ejs'), {
    title: 'Invoice',
    user: { plan: userPlan, email: 'me@example.com', name: 'Me', business_name: null },
    invoice: {
      id: 5,
      invoice_number: 'INV-2026-0001',
      status: status || 'draft',
      issued_date: new Date('2026-05-01'),
      due_date: new Date('2026-05-31'),
      client_name: 'Acme',
      client_email: 'acme@x.example',
      client_address: '',
      items: [{ description: 'Work', quantity: 1, unit_price: 100 }],
      subtotal: 100, tax_rate: 0, tax_amount: 0, total: 100,
      notes: null,
      payment_link_url: payment_link_url || null
    },
    paymentMethods: ['card'],
    csrfToken: 'tkn',
    flash: null
  }, { views: [VIEWS] });
}

async function testViewHidesFollowUpForDraft() {
  const html = await renderInvoiceView({ userPlan: 'free', status: 'draft' });
  assert.ok(!html.includes('data-testid="public-share-followup"'),
    'follow-up section absent on draft invoices — you can\'t follow up on something you haven\'t sent');
}

async function testViewShowsFollowUpForSent() {
  const html = await renderInvoiceView({ userPlan: 'free', status: 'sent' });
  assert.ok(html.includes('data-testid="public-share-followup"'),
    'follow-up section renders on sent invoices');
  assert.ok(html.includes('data-share="followup-whatsapp"'),
    'WhatsApp follow-up button rendered');
  assert.ok(html.includes('data-share="followup-sms"'),
    'SMS follow-up button rendered');
  assert.ok(html.includes('data-share="followup-email"'),
    'Email follow-up button rendered');
}

async function testViewShowsFollowUpForOverdue() {
  const html = await renderInvoiceView({ userPlan: 'free', status: 'overdue' });
  assert.ok(html.includes('data-testid="public-share-followup"'),
    'follow-up section renders on overdue invoices');
}

async function testViewHidesFollowUpForPaid() {
  const html = await renderInvoiceView({ userPlan: 'free', status: 'paid' });
  assert.ok(!html.includes('data-testid="public-share-followup"'),
    'follow-up section absent on paid invoices — the loop is closed');
}

async function testViewFollowUpPlanNeutral() {
  // Free + Pro + Agency all get the follow-up surface — it rides on the
  // same plan-neutral public share path.
  const free = await renderInvoiceView({ userPlan: 'free', status: 'sent' });
  const pro = await renderInvoiceView({ userPlan: 'pro', status: 'sent' });
  const agency = await renderInvoiceView({ userPlan: 'agency', status: 'sent' });
  assert.ok(free.includes('data-testid="public-share-followup"'),
    'free plan sees the follow-up section');
  assert.ok(pro.includes('data-testid="public-share-followup"'),
    'pro plan sees the follow-up section');
  assert.ok(agency.includes('data-testid="public-share-followup"'),
    'agency plan sees the follow-up section');
}

async function testViewFollowUpHrefBoundFromAlpineState() {
  const html = await renderInvoiceView({ userPlan: 'free', status: 'sent' });
  assert.ok(/x-bind:href="followUpIntents\s*&&\s*followUpIntents\.whatsapp"/.test(html),
    'whatsapp follow-up href is bound to Alpine followUpIntents.whatsapp');
  assert.ok(/x-bind:href="followUpIntents\s*&&\s*followUpIntents\.sms"/.test(html),
    'sms follow-up href is bound to Alpine followUpIntents.sms');
  assert.ok(/x-bind:href="followUpIntents\s*&&\s*followUpIntents\.mailto"/.test(html),
    'mailto follow-up href is bound to Alpine followUpIntents.mailto');
}

async function testViewFollowUpGatedOnFetchedIntents() {
  const html = await renderInvoiceView({ userPlan: 'free', status: 'sent' });
  // The container is x-show="url && followUpIntents" so it stays hidden
  // until the fetch resolves — pre-fetch the user sees only the Generate
  // button, and post-fetch the follow-up buttons appear alongside.
  const idx = html.indexOf('data-testid="public-share-followup"');
  assert.ok(idx >= 0);
  const window = html.slice(Math.max(0, idx - 200), idx + 200);
  assert.ok(/x-show="url\s*&&\s*followUpIntents"/.test(window),
    'container gates on both url AND followUpIntents being set');
  assert.ok(/x-cloak/.test(window),
    'container uses x-cloak so pre-Alpine render does not flash the buttons');
}

async function testViewClickResolverAssignsFollowUpIntents() {
  const html = await renderInvoiceView({ userPlan: 'free', status: 'sent' });
  // The Generate-link button's fetch().then must assign data.followUpIntents
  // into the Alpine state so the new container becomes visible after a
  // successful mint.
  assert.ok(/followUpIntents\s*=\s*data\.followUpIntents/.test(html),
    'fetch resolver assigns data.followUpIntents into Alpine state');
  assert.ok(/x-data="\{[\s\S]*?followUpIntents:\s*null/.test(html),
    'Alpine x-data declares an initial `followUpIntents: null`');
}

async function testViewFollowUpClickFiresIntentTracking() {
  const html = await renderInvoiceView({ userPlan: 'free', status: 'sent' });
  // Each follow-up button must call fireIntent so the existing
  // /share-intent tracking endpoint still records the activation signal.
  const idx = html.indexOf('data-testid="public-share-followup"');
  assert.ok(idx >= 0);
  const section = html.slice(idx, idx + 4000);
  assert.ok(/data-share="followup-whatsapp"[\s\S]*?@click="fireIntent\('whatsapp'\)"/.test(section),
    'WhatsApp follow-up triggers fireIntent(\'whatsapp\')');
  assert.ok(/data-share="followup-sms"[\s\S]*?@click="fireIntent\('sms'\)"/.test(section),
    'SMS follow-up triggers fireIntent(\'sms\')');
  assert.ok(/data-share="followup-email"[\s\S]*?@click="fireIntent\('email'\)"/.test(section),
    'Email follow-up triggers fireIntent(\'email\')');
}

// ---------- runner -------------------------------------------------------

(async () => {
  const tests = [
    ['lib helper: follow-up happy path uses check-in framing', testFollowUpHappyPath],
    ['lib helper: subject shape for non-overdue follow-up', testFollowUpSubjectShape],
    ['lib helper: overdue daysOverdue flips body + subject to reminder', testFollowUpOverdueSuffix],
    ['lib helper: daysOverdue <= 0 stays in soft check-in framing', testFollowUpZeroOrNegativeDaysOverdueIsNotOverdue],
    ['lib helper: URL encoding on every output', testFollowUpUrlEncodingOnEveryOutput],
    ['lib helper: mailto recipient is percent-encoded (CC-injection defence)', testFollowUpMailtoRecipientPercentEncoded],
    ['lib helper: missing client_name falls back to "Hi,"', testFollowUpFallbackWhenNoClientName],
    ['lib helper: missing url returns null', testFollowUpRejectsMissingUrl],
    ['lib helper: non-finite total omits the dollar amount', testFollowUpNonFiniteTotalOmitsAmount],
    ['route: response carries followUpIntents alongside shareIntents (free, future due)', testShareEndpointReturnsFollowUpIntentsForFree],
    ['route: past due_date marks followUpIntents.overdue=true', testShareEndpointMarksOverdueWhenDueDatePassed],
    ['route: missing due_date does not 500, defaults to not-overdue', testShareEndpointHandlesMissingDueDate],
    ['view: follow-up section hidden on draft invoices', testViewHidesFollowUpForDraft],
    ['view: follow-up section renders on sent invoices', testViewShowsFollowUpForSent],
    ['view: follow-up section renders on overdue invoices', testViewShowsFollowUpForOverdue],
    ['view: follow-up section hidden on paid invoices', testViewHidesFollowUpForPaid],
    ['view: follow-up is plan-neutral (free + pro + agency)', testViewFollowUpPlanNeutral],
    ['view: hrefs bound to Alpine followUpIntents state', testViewFollowUpHrefBoundFromAlpineState],
    ['view: container x-show-gated on url && followUpIntents + x-cloak', testViewFollowUpGatedOnFetchedIntents],
    ['view: fetch resolver assigns data.followUpIntents into Alpine state', testViewClickResolverAssignsFollowUpIntents],
    ['view: follow-up buttons call fireIntent for tracking', testViewFollowUpClickFiresIntentTracking]
  ];
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log('  ok  ' + name);
    } catch (e) {
      failed++;
      console.error('  FAIL ' + name);
      console.error(e && e.stack ? e.stack : e);
    }
  }
  if (failed) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log(`\n${tests.length} tests passed`);
})();
