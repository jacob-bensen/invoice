'use strict';

/*
 * Self-test send — POST /invoices/:id/email-self
 * (Milestone 3 — first invoice created → first invoice sent).
 *
 * Sends the EXACT same email body the client would receive, but to the
 * authenticated freelancer's own inbox, so they can verify how it renders
 * in their real mail client (Gmail / Apple Mail / Outlook) before tapping
 * "send to client". Removes the dominant pre-send anxiety beat that
 * survives the static iframe preview at /invoices/:id/preview-email.
 *
 * Covers:
 *   - lib: sendInvoiceTestEmail addresses owner.email (never client_email),
 *     prefixes the subject with "[Test] ", preserves the html/text bodies
 *     identical to sendInvoiceEmail, and uses the same resolveReplyTo.
 *   - lib: missing owner.email → { ok:false, reason:'no_owner_email' }.
 *   - lib: missing invoice → { ok:false, reason:'invalid_args' }.
 *   - route: happy path → 200 + { ok, sent_to, message_id } + Cache-Control: no-store.
 *   - route: free plan allowed (no plan gate — activation is the goal).
 *   - route: NEVER flips invoice status (preview, not delivery).
 *   - route: 404 not_found on cross-tenant id (db.getInvoiceById's user_id filter).
 *   - route: 404 not_found on unknown invoice id.
 *   - route: 401 unauthorized when getUserById returns null.
 *   - route: 503 not_configured when RESEND_API_KEY is unset.
 *   - route: 502 on a generic send failure.
 *   - route: 400 no_owner_email when the user row carries no email.
 *   - route: does NOT require invoice.client_email (recipient is the owner).
 *   - view: button rendered with owner email label + invoice id + csrf attributes.
 *   - view: status span present (hidden by default).
 *   - view: <script> wires button.click → fetch POST /invoices/<id>/email-self
 *     with X-CSRF-Token header.
 *   - view: button is hidden for a user row without an email address.
 *
 * Run: NODE_ENV=test node tests/invoice-self-test-email.test.js
 */

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

const assert = require('assert');
const path = require('path');
const ejs = require('ejs');
const express = require('express');
const session = require('express-session');
const http = require('http');

const VIEWS = path.join(__dirname, '..', 'views');

function clearReq(p) {
  try { delete require.cache[require.resolve(p)]; } catch (_) { /* noop */ }
}

// ---------- lib tests ----------------------------------------------------

async function testLibSendsToOwnerNeverClient() {
  clearReq('../lib/email');
  const emailLib = require('../lib/email');
  const sends = [];
  emailLib.setResendClient({
    emails: {
      send: async (payload) => {
        sends.push(payload);
        return { data: { id: 'em_self_test' } };
      }
    }
  });
  const r = await emailLib.sendInvoiceTestEmail(
    {
      id: 11,
      invoice_number: 'INV-2026-0099',
      client_email: 'real-client@somewhere.example',
      client_name: 'Real Client',
      total: 250,
      items: [{ description: 'Work', quantity: 1, unit_price: 250 }]
    },
    {
      id: 1, email: 'freelancer@me.example',
      business_name: 'My Biz', name: 'Sam', reply_to_email: 'replies@me.example'
    }
  );
  assert.strictEqual(r.ok, true, 'happy path returns ok:true');
  assert.strictEqual(r.id, 'em_self_test');
  assert.strictEqual(sends.length, 1, 'exactly one send went out');
  const sent = sends[0];
  assert.deepStrictEqual(sent.to, ['freelancer@me.example'],
    'recipient is the owner.email — NEVER the invoice.client_email');
  assert.ok(!/real-client@somewhere\.example/.test(JSON.stringify(sent.to)),
    'defence: client_email never appears in the recipient list');
  assert.ok(/^\[Test\] /.test(sent.subject),
    'subject is prefixed with "[Test] " so inbox search can distinguish preview from real send; got ' + JSON.stringify(sent.subject));
  assert.ok(/INV-2026-0099/.test(sent.subject),
    'rest of the subject is the real invoice subject (proves buildInvoiceSubject ran)');
  assert.ok(/Real Client/.test(sent.html),
    'html body is identical to the client-bound body (proves buildInvoiceHtml ran with the invoice as-is)');
  assert.strictEqual(sent.reply_to, 'replies@me.example',
    'reply-to mirrors what the client would see (preview fidelity)');
  emailLib.resetResendClient();
}

async function testLibRejectsMissingOwnerEmail() {
  clearReq('../lib/email');
  const emailLib = require('../lib/email');
  const sends = [];
  emailLib.setResendClient({
    emails: { send: async (p) => { sends.push(p); return { data: { id: 'x' } }; } }
  });
  const r = await emailLib.sendInvoiceTestEmail(
    { id: 1, invoice_number: 'X', items: [], client_name: 'Y' },
    { id: 1, email: null, name: 'Sam' }
  );
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no_owner_email');
  assert.strictEqual(sends.length, 0, 'no send attempted without an owner email');
  emailLib.resetResendClient();
}

async function testLibRejectsMissingInvoice() {
  clearReq('../lib/email');
  const emailLib = require('../lib/email');
  const sends = [];
  emailLib.setResendClient({
    emails: { send: async (p) => { sends.push(p); return { data: { id: 'x' } }; } }
  });
  const r = await emailLib.sendInvoiceTestEmail(null, { email: 'me@x.com' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'invalid_args');
  assert.strictEqual(sends.length, 0);
  emailLib.resetResendClient();
}

async function testLibParityWithClientBody() {
  // The whole value prop is "I see exactly what the client sees". This
  // assertion locks in body parity: the html body byte-for-byte matches
  // sendInvoiceEmail's body, modulo no-list-unsubscribe-footer (which only
  // appears when unsubscribeUrl is passed — we deliberately don't).
  clearReq('../lib/email');
  const emailLib = require('../lib/email');
  const sends = [];
  emailLib.setResendClient({
    emails: { send: async (p) => { sends.push(p); return { data: { id: 'a' } }; } }
  });
  const invoice = {
    id: 1, invoice_number: 'INV-1',
    client_email: 'c@x.com', client_name: 'Client',
    total: 100, items: [{ description: 'd', quantity: 1, unit_price: 100 }]
  };
  const owner = { id: 1, email: 'me@x.com', business_name: 'Biz', name: 'Sam' };
  await emailLib.sendInvoiceEmail(invoice, owner);
  await emailLib.sendInvoiceTestEmail(invoice, owner);
  assert.strictEqual(sends.length, 2);
  const [client, self] = sends;
  assert.strictEqual(client.html, self.html,
    'html body of the test send is byte-for-byte identical to the client-bound send');
  assert.strictEqual(client.text, self.text,
    'text body of the test send is byte-for-byte identical to the client-bound send');
  emailLib.resetResendClient();
}

// ---------- Route layer plumbing ----------------------------------------

let sendImpl = async () => ({ ok: true, id: 'em_route' });
let sendCalls = [];

function setSendImpl(fn) { sendImpl = fn; sendCalls = []; }

function buildInvoiceApp({ user, invoiceRow }) {
  const calls = { userById: [], invoiceById: [], mark: [] };
  const dbStub = {
    pool: { query: async () => ({ rows: [] }) },
    db: {
      async getUserById(id) {
        calls.userById.push(id);
        if (!user) return null;
        if (Number(user.id) !== Number(id)) return null;
        return user;
      },
      async getInvoiceById(id, uid) {
        calls.invoiceById.push({ id, uid });
        if (!invoiceRow) return null;
        if (Number(invoiceRow.user_id) !== Number(uid)) return null;
        if (Number(invoiceRow.id) !== Number(id)) return null;
        return invoiceRow;
      },
      async markInvoiceSentFromShareIntent(id, uid) {
        calls.mark.push({ id, uid });
        // If the route ever calls this on the self-test path, the test
        // suite fails — defence against a future refactor that copies
        // email-client's flip behaviour onto the email-self route.
        return { id, status: 'sent' };
      },
      async getInvoicesByUser() { return []; },
      async getRecentRevenueStats() { return null; },
      async getNextInvoiceNumber() { return 'INV-2026-0001'; },
      async getOrCreatePublicToken() { return 'tokentokentoken'; }
    }
  };
  require.cache[require.resolve('../db')] = {
    id: require.resolve('../db'), filename: require.resolve('../db'),
    loaded: true, exports: dbStub
  };

  const realEmailLib = (() => { clearReq('../lib/email'); return require('../lib/email'); })();
  const emailStub = {
    ...realEmailLib,
    sendInvoiceTestEmail: async (invoice, owner) => {
      sendCalls.push({ invoice, owner });
      return sendImpl(invoice, owner);
    }
  };
  require.cache[require.resolve('../lib/email')] = {
    id: require.resolve('../lib/email'), filename: require.resolve('../lib/email'),
    loaded: true, exports: emailStub
  };

  require.cache[require.resolve('../lib/outbound-webhook')] = {
    id: require.resolve('../lib/outbound-webhook'),
    filename: require.resolve('../lib/outbound-webhook'),
    loaded: true,
    exports: {
      isValidWebhookUrl: async () => true,
      buildPaidPayload: () => ({}),
      firePaidWebhook: async () => ({ ok: true }),
      setHostnameResolver: () => {}
    }
  };

  clearReq('../routes/invoices');
  const invoiceRoutes = require('../routes/invoices');
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', VIEWS);
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, res, next) => {
    req.session.user = { id: 7, plan: user ? user.plan : 'free' };
    next();
  });
  app.use('/invoices', invoiceRoutes);
  return { app, calls };
}

function postSelf(app, id) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const req = http.request({
        hostname: '127.0.0.1', port, path: `/invoices/${id}/email-self`,
        method: 'POST',
        headers: { 'Accept': 'application/json' }
      }, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => server.close(() => resolve({
          status: res.statusCode, body: data, headers: res.headers
        })));
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.end();
    });
  });
}

// ---------- Route tests --------------------------------------------------

async function testRouteHappyPath() {
  setSendImpl(async () => ({ ok: true, id: 'em_happy' }));
  const { app, calls } = buildInvoiceApp({
    user: { id: 7, plan: 'free', email: 'me@example.com', name: 'Sam' },
    invoiceRow: {
      id: 5, user_id: 7, status: 'draft',
      invoice_number: 'INV-1', client_email: 'acme@x.example',
      client_name: 'Acme', total: '100.00', items: []
    }
  });
  const r = await postSelf(app, 5);
  assert.strictEqual(r.status, 200, 'happy path returns 200; got ' + r.status + ' body=' + r.body);
  const body = JSON.parse(r.body);
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.sent_to, 'me@example.com',
    'response echoes the owner email actually delivered to');
  assert.strictEqual(body.message_id, 'em_happy',
    'response carries the Resend message id for ops tracing');
  assert.strictEqual(sendCalls.length, 1, 'sendInvoiceTestEmail fires exactly once');
  assert.strictEqual(sendCalls[0].invoice.id, 5);
  assert.strictEqual(sendCalls[0].owner.id, 7);
  assert.strictEqual(sendCalls[0].owner.email, 'me@example.com');
  assert.strictEqual(calls.mark.length, 0,
    'preview send must NEVER flip invoice status — it is a preview, not a delivery');
  assert.ok(/no-store/i.test(r.headers['cache-control'] || ''),
    'response must carry Cache-Control: no-store; got ' + r.headers['cache-control']);
}

async function testRouteFreePlanAllowed() {
  // No plan gate — activation is the Primary Objective and we don't want
  // to gate the de-anxiety surface that converts drafts to sends.
  setSendImpl(async () => ({ ok: true, id: 'em_free' }));
  const { app } = buildInvoiceApp({
    user: { id: 7, plan: 'free', email: 'me@example.com' },
    invoiceRow: {
      id: 5, user_id: 7, status: 'draft',
      invoice_number: 'INV-1', client_email: null,
      client_name: 'Acme', total: '100.00', items: []
    }
  });
  const r = await postSelf(app, 5);
  assert.strictEqual(r.status, 200,
    'free plan must be allowed (parity with all plans — preview is activation-critical)');
  assert.strictEqual(sendCalls.length, 1,
    'free plan still fires the send');
}

async function testRouteNoClientEmailStillOk() {
  // The test send goes to the OWNER. invoice.client_email being null
  // doesn't matter — the freelancer can preview the email even mid-edit,
  // before they've filled in the client email.
  setSendImpl(async () => ({ ok: true, id: 'em_no_client' }));
  const { app } = buildInvoiceApp({
    user: { id: 7, plan: 'pro', email: 'me@example.com' },
    invoiceRow: {
      id: 5, user_id: 7, status: 'draft',
      invoice_number: 'INV-1', client_email: null,
      client_name: 'Acme', total: '100.00', items: []
    }
  });
  const r = await postSelf(app, 5);
  assert.strictEqual(r.status, 200,
    'missing invoice.client_email does NOT block the self-test (recipient is the owner)');
  const body = JSON.parse(r.body);
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.sent_to, 'me@example.com');
}

async function testRouteCrossTenantNotFound() {
  setSendImpl(async () => { throw new Error('should not be called'); });
  const { app, calls } = buildInvoiceApp({
    user: { id: 7, plan: 'pro', email: 'me@example.com' },
    invoiceRow: {
      id: 5, user_id: 999, // belongs to a different user
      status: 'draft', invoice_number: 'INV-1', client_email: 'a@x.com',
      client_name: 'X', total: '100.00', items: []
    }
  });
  const r = await postSelf(app, 5);
  assert.strictEqual(r.status, 404,
    'cross-tenant invoice returns 404 — never leaks another user\'s invoice');
  const body = JSON.parse(r.body);
  assert.strictEqual(body.error, 'not_found');
  assert.strictEqual(sendCalls.length, 0);
  assert.strictEqual(calls.mark.length, 0);
}

async function testRouteUnknownInvoiceNotFound() {
  const { app } = buildInvoiceApp({
    user: { id: 7, plan: 'pro', email: 'me@x.com' },
    invoiceRow: null
  });
  const r = await postSelf(app, 999);
  assert.strictEqual(r.status, 404);
  const body = JSON.parse(r.body);
  assert.strictEqual(body.error, 'not_found');
  assert.strictEqual(sendCalls.length, 0);
}

async function testRouteUnauthorizedWhenUserMissing() {
  setSendImpl(async () => { throw new Error('should not be called'); });
  const { app } = buildInvoiceApp({
    user: null, // db.getUserById returns null
    invoiceRow: {
      id: 5, user_id: 7, status: 'draft',
      invoice_number: 'INV-1', client_email: 'a@x.com',
      client_name: 'X', total: '100.00', items: []
    }
  });
  const r = await postSelf(app, 5);
  assert.strictEqual(r.status, 401, 'missing user returns 401 Unauthorized');
  const body = JSON.parse(r.body);
  assert.strictEqual(body.error, 'unauthorized');
  assert.strictEqual(sendCalls.length, 0);
}

async function testRouteNoOwnerEmail400() {
  setSendImpl(async () => { throw new Error('should not be called'); });
  const { app } = buildInvoiceApp({
    user: { id: 7, plan: 'pro', email: null },
    invoiceRow: {
      id: 5, user_id: 7, status: 'draft',
      invoice_number: 'INV-1', client_email: 'a@x.com',
      client_name: 'X', total: '100.00', items: []
    }
  });
  const r = await postSelf(app, 5);
  assert.strictEqual(r.status, 400,
    'user row with no email returns 400 no_owner_email so UI can prompt to add one');
  const body = JSON.parse(r.body);
  assert.strictEqual(body.error, 'no_owner_email');
  assert.strictEqual(sendCalls.length, 0);
}

async function testRouteNotConfigured503() {
  setSendImpl(async () => ({ ok: false, reason: 'not_configured' }));
  const { app } = buildInvoiceApp({
    user: { id: 7, plan: 'pro', email: 'me@x.com' },
    invoiceRow: {
      id: 5, user_id: 7, status: 'draft',
      invoice_number: 'INV-1', client_email: 'a@x.com',
      client_name: 'X', total: '100.00', items: []
    }
  });
  const r = await postSelf(app, 5);
  assert.strictEqual(r.status, 503,
    'not_configured returns 503 so the UI can tell the user the feature is not ready yet');
  const body = JSON.parse(r.body);
  assert.strictEqual(body.error, 'not_configured');
}

async function testRouteGenericSendFailure502() {
  setSendImpl(async () => ({ ok: false, reason: 'error', error: 'resend boom' }));
  const { app } = buildInvoiceApp({
    user: { id: 7, plan: 'pro', email: 'me@x.com' },
    invoiceRow: {
      id: 5, user_id: 7, status: 'draft',
      invoice_number: 'INV-1', client_email: 'a@x.com',
      client_name: 'X', total: '100.00', items: []
    }
  });
  const r = await postSelf(app, 5);
  assert.strictEqual(r.status, 502, 'generic send failure returns 502 Bad Gateway');
  const body = JSON.parse(r.body);
  assert.strictEqual(body.error, 'error',
    'reason from sendInvoiceTestEmail is echoed back to the client for diagnosis');
}

// ---------- View tests ---------------------------------------------------

async function renderPreviewEmail({ ownerEmail }) {
  return ejs.renderFile(path.join(VIEWS, 'invoice-preview-email.ejs'), {
    title: 'Preview',
    invoice: {
      id: 42, invoice_number: 'INV-2026-0042',
      client_email: 'client@x.example', client_name: 'Client'
    },
    user: { id: 1, email: ownerEmail, name: 'Sam', business_name: 'Sam Co' },
    emailSubject: 'Invoice INV-2026-0042 from Sam Co',
    emailHtml: '<p>body</p>',
    emailText: 'body',
    replyTo: 'replies@sam.co',
    csrfToken: 'test-csrf',
    noindex: true
  }, { views: [VIEWS] });
}

async function testViewButtonRendered() {
  const html = await renderPreviewEmail({ ownerEmail: 'me@my.test' });
  assert.ok(/data-testid="preview-email-actions"/.test(html),
    'actions block present');
  assert.ok(/data-testid="preview-email-self-send"/.test(html),
    'self-send button rendered');
  // The button surfaces the owner email so the user knows exactly where the
  // test will land — same affordance pattern as the email-client button.
  assert.ok(/Send test to my inbox \(me@my\.test\)/.test(html),
    'button label includes the owner email');
  // Attributes carry the data the JS handler needs.
  const m = html.match(/<button[^>]*data-testid="preview-email-self-send"[^>]*>/);
  assert.ok(m, 'button opening tag located');
  const tag = m[0];
  assert.ok(/data-invoice-id="42"/.test(tag), 'data-invoice-id is the route id');
  assert.ok(/data-csrf="test-csrf"/.test(tag), 'data-csrf carries the session token');
  assert.ok(/data-owner-email="me@my\.test"/.test(tag), 'data-owner-email carries the owner email for the success label');
}

async function testViewStatusSpanHidden() {
  const html = await renderPreviewEmail({ ownerEmail: 'me@my.test' });
  const m = html.match(/<span[^>]*data-testid="preview-email-self-status"[^>]*>/);
  assert.ok(m, 'status span present');
  assert.ok(/\shidden(?:=|\s|>)/.test(m[0]),
    'status span starts hidden — only revealed once the user clicks the button');
}

async function testViewScriptWiresFetch() {
  const html = await renderPreviewEmail({ ownerEmail: 'me@my.test' });
  // The inline script wires the button click to fetch POST /invoices/:id/email-self
  // with the X-CSRF-Token header. We assert all three contract points.
  const script = html.match(/<script data-testid="preview-email-self-script">[\s\S]*?<\/script>/);
  assert.ok(script, 'inline script tagged with preview-email-self-script is present');
  const body = script[0];
  assert.ok(/preview-email-self-send/.test(body),
    'script queries the button by data-testid');
  assert.ok(/\/email-self/.test(body),
    'script POSTs to /invoices/<id>/email-self');
  assert.ok(/X-CSRF-Token/.test(body),
    'script sends the CSRF token in the X-CSRF-Token header');
  assert.ok(/method:\s*'POST'/.test(body),
    'script issues a POST');
  // Defence: the success path must read sent_to and update the button label
  // so the user has unambiguous "the test went out" feedback.
  assert.ok(/sent_to/.test(body),
    'script reads response.sent_to for the success label');
  // The handler must disable the button before issuing the fetch (defence
  // against a panicked double-tap blasting two test emails).
  assert.ok(/btn\.disabled\s*=\s*true/.test(body),
    'script disables the button before issuing the fetch');
}

async function testViewNoButtonWhenOwnerEmailMissing() {
  const html = await renderPreviewEmail({ ownerEmail: '' });
  assert.ok(!/data-testid="preview-email-self-send"/.test(html),
    'no button when the user has no email on file — the route would 400 anyway');
  assert.ok(!/data-testid="preview-email-actions"/.test(html),
    'no actions block at all when there is no owner email');
}

// ---------- runner -------------------------------------------------------

async function run() {
  const tests = [
    ['lib: send addresses owner.email, never invoice.client_email; [Test] subject prefix', testLibSendsToOwnerNeverClient],
    ['lib: missing owner.email → no_owner_email + no send', testLibRejectsMissingOwnerEmail],
    ['lib: missing invoice → invalid_args + no send', testLibRejectsMissingInvoice],
    ['lib: html/text body byte-for-byte identical to sendInvoiceEmail (preview fidelity)', testLibParityWithClientBody],
    ['route: happy path → 200, sent_to+message_id, no status flip, no-store', testRouteHappyPath],
    ['route: free plan allowed (no plan gate — activation surface)', testRouteFreePlanAllowed],
    ['route: invoice without client_email STILL sends to owner', testRouteNoClientEmailStillOk],
    ['route: 404 not_found on cross-tenant invoice', testRouteCrossTenantNotFound],
    ['route: 404 not_found on unknown invoice id', testRouteUnknownInvoiceNotFound],
    ['route: 401 unauthorized when getUserById returns null', testRouteUnauthorizedWhenUserMissing],
    ['route: 400 no_owner_email when user row has null email', testRouteNoOwnerEmail400],
    ['route: 503 not_configured when Resend is unset', testRouteNotConfigured503],
    ['route: 502 on a generic Resend failure', testRouteGenericSendFailure502],
    ['view: button rendered with owner email label + invoice id + csrf attrs', testViewButtonRendered],
    ['view: status span starts hidden', testViewStatusSpanHidden],
    ['view: inline script wires button → POST /email-self with CSRF header', testViewScriptWiresFetch],
    ['view: no button when owner.email is missing', testViewNoButtonWhenOwnerEmailMissing]
  ];
  let passed = 0, failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log('  ok  ' + name);
      passed++;
    } catch (e) {
      console.error('  FAIL  ' + name);
      console.error('    ' + (e && e.stack ? e.stack : e));
      failed++;
    }
  }
  console.log('');
  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch(e => { console.error(e); process.exit(1); });
