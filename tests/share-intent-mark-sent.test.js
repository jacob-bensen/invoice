'use strict';

/*
 * Freelancer-side draft → sent flip on share-intent click
 * (Milestone 3 — first invoice created → first invoice sent).
 *
 * Before this ship, the only path that flipped a draft to sent without an
 * explicit manual "Mark as Sent" was recordPublicInvoiceView — fires when
 * the CLIENT opens the public /i/<token> URL. Any share that never gets
 * opened (busy client, link routed to spam, channel the client doesn't
 * check) left the invoice stuck in 'draft' indefinitely: stale-draft
 * prompts kept firing, stale-draft email kept firing, the activation-
 * funnel report's `sent_one` counter missed the conversion entirely, and
 * the freelancer's dashboard lied about the invoice's actual state.
 *
 * The new POST /invoices/:id/share-intent fires from a `fireIntent(kind)`
 * call wired onto every share-intent button (WhatsApp / SMS / Email /
 * Copy) in both the public-share-section and the Pro pay-link section of
 * views/invoice-view.ejs. On click, the freelancer's browser pings the
 * endpoint with `keepalive: true` so the request completes even when
 * the click hands the page off to a native compose handler. The endpoint
 * atomically flips draft → sent via the same CASE-guard pattern that
 * powers sent_via_share_view_at, stamps sent_via_share_intent_at on the
 * flip (and only on the flip — non-draft statuses fall through to the
 * ELSE branch and never regress), and is idempotent across replays.
 *
 * Covers:
 *   - db.markInvoiceSentFromShareIntent SQL shape (CASE guards on status
 *     + stamp, RETURNING shape, user_id scoping in WHERE).
 *   - DB helper draft → sent flip happy path.
 *   - DB helper does NOT regress sent / paid / overdue.
 *   - DB helper rejects invalid invoice / user ids.
 *   - Route happy path: draft → sent flip, response shape with flipped=true.
 *   - Route idempotency: already-sent invoice returns flipped=false but ok=true.
 *   - Route rejects invalid intent strings (400).
 *   - Route 404 on missing invoice (also covers cross-tenant: a different
 *     user's invoice id returns 404 because getInvoiceById is owner-scoped).
 *   - View wiring: every share-intent surface (4 buttons × 2 sections)
 *     carries a fireIntent(kind) call in its @click.
 *   - View wiring: fireIntent posts to /invoices/<id>/share-intent with
 *     the CSRF header and `keepalive: true` so a native-handler navigation
 *     doesn't drop the request.
 *   - schema.sql: sent_via_share_intent_at migration is idempotent.
 *
 * Run: NODE_ENV=test node tests/share-intent-mark-sent.test.js
 */

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');
const express = require('express');
const session = require('express-session');
const http = require('http');

const VIEWS = path.join(__dirname, '..', 'views');

// ---------- pg stub plumbing ---------------------------------------------

function stubPg(handler) {
  const pgPath = require.resolve('pg');
  const originalPg = require.cache[pgPath];
  require.cache[pgPath] = {
    id: pgPath, filename: pgPath, loaded: true,
    exports: {
      Pool: function () { return { query: handler }; }
    }
  };
  delete require.cache[require.resolve('../db')];
  return () => {
    if (originalPg) require.cache[pgPath] = originalPg;
    else delete require.cache[pgPath];
    delete require.cache[require.resolve('../db')];
  };
}

// ---------- DB-level: SQL shape -----------------------------------------

async function testMarkSentSqlShape() {
  const captured = [];
  const restore = stubPg(async (text, params) => {
    captured.push({ text, params });
    return {
      rows: [{
        id: 42, status: 'sent',
        sent_via_share_intent_at: new Date('2026-05-18T12:00:00Z')
      }]
    };
  });
  try {
    const { db } = require('../db');
    await db.markInvoiceSentFromShareIntent(42, 7);
    assert.strictEqual(captured.length, 1, 'fires exactly one UPDATE');
    const q = captured[0];
    // CASE guard on status='draft' → 'sent', else preserve.
    assert.ok(/status\s*=\s*CASE\s+WHEN\s+status\s*=\s*'draft'\s+THEN\s+'sent'\s+ELSE\s+status\s+END/i.test(q.text),
      'status must flip draft→sent via a CASE guard, leaving other statuses untouched');
    // Stamp set only on the same draft guard so flip + stamp are atomic.
    assert.ok(/sent_via_share_intent_at\s*=\s*CASE\s+WHEN\s+status\s*=\s*'draft'\s+THEN\s+NOW\(\)\s+ELSE\s+sent_via_share_intent_at\s+END/i.test(q.text),
      'sent_via_share_intent_at must be stamped on the same draft-guard CASE');
    // Cross-tenant guard.
    assert.ok(/WHERE\s+id\s*=\s*\$1\s+AND\s+user_id\s*=\s*\$2/i.test(q.text),
      'WHERE must include user_id so a different owner cannot flip this invoice');
    // RETURNING must include status + the stamp so the route can compute `flipped`.
    assert.ok(/RETURNING\b.*\bstatus\b/i.test(q.text),
      'RETURNING must include status so the route can detect whether the flip happened');
    assert.ok(/RETURNING\b.*\bsent_via_share_intent_at\b/i.test(q.text),
      'RETURNING must include sent_via_share_intent_at for analytics + the activation report');
    assert.deepStrictEqual(q.params, [42, 7]);
  } finally { restore(); }
}

// ---------- DB-level: status transitions --------------------------------

async function testMarkSentFlipsDraft() {
  const restore = stubPg(async () => ({
    rows: [{ id: 42, status: 'sent', sent_via_share_intent_at: new Date('2026-05-18T12:00:00Z') }]
  }));
  try {
    const { db } = require('../db');
    const row = await db.markInvoiceSentFromShareIntent(42, 7);
    assert.strictEqual(row.status, 'sent',
      'a draft must come back as sent after the intent fires');
    assert.ok(row.sent_via_share_intent_at instanceof Date,
      'sent_via_share_intent_at must be stamped on the draft→sent flip');
  } finally { restore(); }
}

async function testMarkSentLeavesAlreadySentUnchanged() {
  // Live DB behavior: explicit Mark-as-Sent fired earlier, then the
  // freelancer clicks WhatsApp share. CASE guard sees status != 'draft',
  // ELSE branch preserves the existing status and leaves the stamp NULL.
  const restore = stubPg(async () => ({
    rows: [{ id: 42, status: 'sent', sent_via_share_intent_at: null }]
  }));
  try {
    const { db } = require('../db');
    const row = await db.markInvoiceSentFromShareIntent(42, 7);
    assert.strictEqual(row.status, 'sent', 'already-sent stays sent');
    assert.strictEqual(row.sent_via_share_intent_at, null,
      'sent_via_share_intent_at NULL when an explicit Mark-as-Sent fired first');
  } finally { restore(); }
}

async function testMarkSentLeavesPaidUnchanged() {
  // Critical: a paid-first-then-shared invoice (e.g. cash up-front,
  // share link generated for record-keeping) must NEVER regress to 'sent'.
  const restore = stubPg(async () => ({
    rows: [{ id: 42, status: 'paid', sent_via_share_intent_at: null }]
  }));
  try {
    const { db } = require('../db');
    const row = await db.markInvoiceSentFromShareIntent(42, 7);
    assert.strictEqual(row.status, 'paid',
      'paid invoices NEVER regress via share-intent — the CASE guard only flips from draft');
    assert.strictEqual(row.sent_via_share_intent_at, null);
  } finally { restore(); }
}

async function testMarkSentLeavesOverdueUnchanged() {
  const restore = stubPg(async () => ({
    rows: [{ id: 42, status: 'overdue', sent_via_share_intent_at: null }]
  }));
  try {
    const { db } = require('../db');
    const row = await db.markInvoiceSentFromShareIntent(42, 7);
    assert.strictEqual(row.status, 'overdue', 'overdue stays overdue');
  } finally { restore(); }
}

async function testMarkSentReturnsNullOnInvalidArgs() {
  const restore = stubPg(async () => { throw new Error('should never query'); });
  try {
    const { db } = require('../db');
    assert.strictEqual(await db.markInvoiceSentFromShareIntent(null, 7), null,
      'null invoice id short-circuits to null without touching pg');
    assert.strictEqual(await db.markInvoiceSentFromShareIntent(42, null), null,
      'null user id short-circuits to null');
    assert.strictEqual(await db.markInvoiceSentFromShareIntent(0, 7), null,
      'non-positive invoice id is rejected');
    assert.strictEqual(await db.markInvoiceSentFromShareIntent('not-a-number', 7), null,
      'non-numeric invoice id is rejected');
  } finally { restore(); }
}

// ---------- Route integration -------------------------------------------

function buildInvoiceApp({ invoiceRow, markResult }) {
  const calls = { mark: [] };
  const dbStub = {
    pool: { query: async () => ({ rows: [] }) },
    db: {
      async getUserById(id) { return { id, plan: 'free', email: 'me@x.com' }; },
      async getInvoiceById(id, uid) {
        if (!invoiceRow) return null;
        if (Number(invoiceRow.user_id) !== Number(uid)) return null;
        if (Number(invoiceRow.id) !== Number(id)) return null;
        return invoiceRow;
      },
      async markInvoiceSentFromShareIntent(id, uid) {
        calls.mark.push({ id, uid });
        return markResult;
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
  delete require.cache[require.resolve('../routes/invoices')];
  const invoiceRoutes = require('../routes/invoices');
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', VIEWS);
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, res, next) => {
    req.session.user = { id: 7, plan: 'free' };
    next();
  });
  app.use('/invoices', invoiceRoutes);
  return { app, calls };
}

function postIntent(app, id, body, contentType) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const payload = contentType === 'json'
        ? JSON.stringify(body)
        : new URLSearchParams(body).toString();
      const headers = {
        'Content-Type': contentType === 'json'
          ? 'application/json'
          : 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(payload)
      };
      const req = http.request({
        hostname: '127.0.0.1', port, path: `/invoices/${id}/share-intent`,
        method: 'POST', headers
      }, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => server.close(() => resolve({ status: res.statusCode, body: data, headers: res.headers })));
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.write(payload);
      req.end();
    });
  });
}

async function testRouteFlipsDraftAndReturnsFlippedTrue() {
  const { app, calls } = buildInvoiceApp({
    invoiceRow: { id: 5, user_id: 7, status: 'draft', invoice_number: 'INV-1' },
    markResult: { id: 5, status: 'sent', sent_via_share_intent_at: new Date() }
  });
  const r = await postIntent(app, 5, { intent: 'whatsapp' }, 'json');
  assert.strictEqual(r.status, 200, 'happy path returns 200; got ' + r.status + ' body=' + r.body);
  const body = JSON.parse(r.body);
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.status, 'sent');
  assert.strictEqual(body.flipped, true,
    'flipped=true when the invoice came in as draft and went out as sent');
  assert.strictEqual(body.intent, 'whatsapp');
  assert.deepStrictEqual(calls.mark, [{ id: 5, uid: 7 }],
    'mark helper called exactly once with the invoice id + session user id');
  // Cache-Control: no-store so a CDN never serves a stale "flipped: true"
  // back to a freelancer who's already clicked a second share-intent.
  assert.ok(/no-store/i.test(r.headers['cache-control'] || ''),
    'response must carry Cache-Control: no-store; got ' + r.headers['cache-control']);
}

async function testRouteAcceptsAllFourIntentKinds() {
  for (const kind of ['whatsapp', 'sms', 'email', 'copy']) {
    const { app } = buildInvoiceApp({
      invoiceRow: { id: 5, user_id: 7, status: 'draft', invoice_number: 'INV-1' },
      markResult: { id: 5, status: 'sent', sent_via_share_intent_at: new Date() }
    });
    const r = await postIntent(app, 5, { intent: kind }, 'json');
    assert.strictEqual(r.status, 200, `${kind}: expected 200; got ${r.status}`);
    const body = JSON.parse(r.body);
    assert.strictEqual(body.intent, kind, `${kind}: echoed back`);
    assert.strictEqual(body.flipped, true);
  }
}

async function testRouteIdempotentOnAlreadySent() {
  const { app } = buildInvoiceApp({
    invoiceRow: { id: 5, user_id: 7, status: 'sent', invoice_number: 'INV-1' },
    markResult: { id: 5, status: 'sent', sent_via_share_intent_at: null }
  });
  const r = await postIntent(app, 5, { intent: 'whatsapp' }, 'json');
  assert.strictEqual(r.status, 200, 'already-sent is still a 200 — replay is safe');
  const body = JSON.parse(r.body);
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.status, 'sent');
  assert.strictEqual(body.flipped, false,
    'flipped=false because the invoice was already sent before the intent fired');
}

async function testRouteIdempotentOnPaid() {
  // Belt-and-braces: a paid invoice routed through share-intent must NOT
  // be reported as flipped — the live DB CASE guard would never flip it,
  // and the route must reflect that.
  const { app } = buildInvoiceApp({
    invoiceRow: { id: 5, user_id: 7, status: 'paid', invoice_number: 'INV-1' },
    markResult: { id: 5, status: 'paid', sent_via_share_intent_at: null }
  });
  const r = await postIntent(app, 5, { intent: 'copy' }, 'json');
  assert.strictEqual(r.status, 200);
  const body = JSON.parse(r.body);
  assert.strictEqual(body.flipped, false, 'paid invoice never reports flipped=true');
  assert.strictEqual(body.status, 'paid');
}

async function testRouteRejectsInvalidIntent() {
  const { app, calls } = buildInvoiceApp({
    invoiceRow: { id: 5, user_id: 7, status: 'draft' },
    markResult: null
  });
  const r = await postIntent(app, 5, { intent: 'snapchat' }, 'json');
  assert.strictEqual(r.status, 400, 'unknown intent kind is a 400');
  assert.ok(r.body.includes('invalid_intent'),
    'response names the failure mode so the client knows to drop the call rather than retry; got: ' + r.body);
  assert.strictEqual(calls.mark.length, 0,
    'DB mark helper must NOT fire on a rejected intent');
}

async function testRouteRejectsMissingIntent() {
  const { app, calls } = buildInvoiceApp({
    invoiceRow: { id: 5, user_id: 7, status: 'draft' },
    markResult: null
  });
  const r = await postIntent(app, 5, {}, 'json');
  assert.strictEqual(r.status, 400, 'missing intent body is a 400');
  assert.strictEqual(calls.mark.length, 0);
}

async function testRouteAcceptsFormUrlencoded() {
  // Defence-in-depth: a sendBeacon caller that falls back to URLSearchParams
  // must still work even though the primary client uses JSON. express.urlencoded
  // is wired globally on the test app; verify the route reads .intent correctly.
  const { app } = buildInvoiceApp({
    invoiceRow: { id: 5, user_id: 7, status: 'draft' },
    markResult: { id: 5, status: 'sent', sent_via_share_intent_at: new Date() }
  });
  const r = await postIntent(app, 5, { intent: 'sms' }, 'urlencoded');
  assert.strictEqual(r.status, 200, 'urlencoded body still works; got ' + r.status + ' body=' + r.body);
  const body = JSON.parse(r.body);
  assert.strictEqual(body.flipped, true);
}

async function testRoute404ForCrossTenantInvoice() {
  // getInvoiceById is owner-scoped; a freelancer who hand-crafts a request
  // against a different user's invoice id gets a 404 (not a 403, since the
  // route can't tell the difference between "doesn't exist" and "exists but
  // not yours" without leaking the existence signal).
  const { app, calls } = buildInvoiceApp({
    invoiceRow: { id: 99, user_id: 999, status: 'draft' }, // different user_id
    markResult: null
  });
  const r = await postIntent(app, 99, { intent: 'whatsapp' }, 'json');
  assert.strictEqual(r.status, 404,
    'cross-tenant invoice id 404s before any DB write; got ' + r.status);
  assert.strictEqual(calls.mark.length, 0,
    'mark helper must NOT fire when the invoice is not owned by the caller');
}

async function testRoute404ForMissingInvoice() {
  const { app } = buildInvoiceApp({ invoiceRow: null, markResult: null });
  const r = await postIntent(app, 9999, { intent: 'whatsapp' }, 'json');
  assert.strictEqual(r.status, 404);
}

// ---------- View wiring -------------------------------------------------

async function renderInvoiceView({ userPlan, payment_link_url }) {
  return ejs.renderFile(path.join(VIEWS, 'invoice-view.ejs'), {
    title: 'Invoice',
    user: { plan: userPlan, email: 'me@example.com', name: 'Me', business_name: null },
    invoice: {
      id: 5,
      invoice_number: 'INV-2026-0001',
      status: 'draft',
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
    csrfToken: 'test-csrf-token',
    flash: null
  }, { views: [VIEWS] });
}

async function testViewWiresAllFourIntentsInPublicShareSection() {
  // Every share-intent surface (WhatsApp, SMS, Email anchors + Copy
  // button) inside the public-share-section must carry the fireIntent(kind)
  // call so a freelancer can pick whichever channel makes sense and STILL
  // get their dashboard updated.
  const html = await renderInvoiceView({ userPlan: 'free' });
  // Public-share section: scope opens with data-testid="public-share-section".
  const sectionStart = html.indexOf('data-testid="public-share-section"');
  assert.ok(sectionStart >= 0, 'public-share-section present');
  // Take everything from section start to the closing div before Payment Link.
  const sectionEnd = html.indexOf('<!-- Payment Link', sectionStart);
  const section = html.slice(sectionStart, sectionEnd > 0 ? sectionEnd : html.length);
  assert.ok(/fireIntent\(['"]whatsapp['"]\)/.test(section),
    'WhatsApp anchor in public-share-section must call fireIntent("whatsapp")');
  assert.ok(/fireIntent\(['"]sms['"]\)/.test(section),
    'SMS anchor in public-share-section must call fireIntent("sms")');
  assert.ok(/fireIntent\(['"]email['"]\)/.test(section),
    'Email anchor in public-share-section must call fireIntent("email")');
  assert.ok(/fireIntent\(['"]copy['"]\)/.test(section),
    'Copy button in public-share-section must call fireIntent("copy")');
}

async function testViewWiresAllFourIntentsInProPayLinkSection() {
  const html = await renderInvoiceView({
    userPlan: 'pro',
    payment_link_url: 'https://buy.stripe.com/test_xyz'
  });
  // Pro pay-link section: starts at the "Payment Link" header inside the
  // `if invoice.payment_link_url && user.plan === 'pro'` branch.
  const sectionStart = html.indexOf('Payment Link');
  assert.ok(sectionStart >= 0, 'Pro pay-link section present');
  // Take everything from there onward — the Notes block at the end is fine
  // to include since it has no share-intent buttons.
  const section = html.slice(sectionStart);
  // The pay-link section has its own scope with fireIntent — verify each
  // surface carries the call exactly. We look for the @click attribute
  // adjacent to data-share="<kind>" to disambiguate from the public-share
  // section's own occurrences (which use x-bind:href).
  assert.ok(/data-share="whatsapp"[\s\S]{0,200}fireIntent\(['"]whatsapp['"]\)/.test(section),
    'Pro pay-link WhatsApp anchor must call fireIntent("whatsapp")');
  assert.ok(/data-share="sms"[\s\S]{0,200}fireIntent\(['"]sms['"]\)/.test(section),
    'Pro pay-link SMS anchor must call fireIntent("sms")');
  assert.ok(/data-share="email"[\s\S]{0,200}fireIntent\(['"]email['"]\)/.test(section),
    'Pro pay-link Email anchor must call fireIntent("email")');
  assert.ok(/data-share-intent="copy"[\s\S]{0,200}fireIntent\(['"]copy['"]\)/.test(section),
    'Pro pay-link Copy button must call fireIntent("copy")');
}

async function testViewFireIntentPostsKeepaliveWithCsrf() {
  // The fireIntent helper must use fetch with keepalive:true so the
  // request survives the page handing off to a native compose handler
  // (wa.me / sms: / mailto:). It must also include the CSRF token so the
  // global csrfProtection middleware accepts the request.
  const html = await renderInvoiceView({ userPlan: 'free' });
  // The fireIntent body spans nested object literals — `[^}]*` would stop
  // at the first inner `}`, so match across the whole window of interest.
  assert.ok(/fireIntent\(kind\)[\s\S]{0,400}fetch\(\s*['"]\/invoices\/5\/share-intent['"]/.test(html),
    'fireIntent must POST to /invoices/<id>/share-intent with the invoice id baked in by EJS');
  assert.ok(/fireIntent\(kind\)[\s\S]{0,400}keepalive:\s*true/.test(html),
    'fireIntent fetch must set keepalive:true so the native-handler handoff does not drop the request');
  assert.ok(/fireIntent\(kind\)[\s\S]{0,400}['"]X-CSRF-Token['"]\s*:\s*['"]test-csrf-token['"]/.test(html),
    'fireIntent fetch must carry the X-CSRF-Token header sourced from locals.csrfToken');
  assert.ok(/fireIntent\(kind\)[\s\S]{0,600}JSON\.stringify\(\s*\{\s*intent:\s*kind\s*\}\s*\)/.test(html),
    'fireIntent must POST a JSON body with the intent kind so the route receives the whitelisted value');
}

async function testViewFireIntentPresentInBothScopesForProUser() {
  // A Pro user with a pay-link sees TWO independent x-data scopes that
  // both expose fireIntent (public-share-section + Pro pay-link card).
  // Each scope defines its own fireIntent — count both occurrences so a
  // regression that consolidated the methods incorrectly would surface.
  const html = await renderInvoiceView({
    userPlan: 'pro',
    payment_link_url: 'https://buy.stripe.com/test_xyz'
  });
  const matches = html.match(/fireIntent\(kind\)/g) || [];
  assert.strictEqual(matches.length, 2,
    'Pro user with pay-link has exactly 2 fireIntent definitions — one per x-data scope; got ' + matches.length);
}

async function testViewFireIntentSwallowsErrors() {
  // The fetch must be wrapped so a network blip / CSRF mismatch / 5xx
  // doesn't surface a runtime error in the Alpine handler — the
  // freelancer's WhatsApp open must never be blocked by our analytics
  // ping failing. Either try/catch around fetch OR .catch() on the
  // promise chain satisfies this.
  const html = await renderInvoiceView({ userPlan: 'free' });
  assert.ok(/fireIntent\(kind\)[\s\S]{0,800}\.catch\(/.test(html),
    'fireIntent must swallow fetch promise rejections via .catch() so the native handoff is never blocked');
}

// ---------- schema -----------------------------------------------------

function testSchemaIdempotent() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  assert.ok(/ALTER\s+TABLE\s+invoices\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+sent_via_share_intent_at\s+TIMESTAMP/i.test(sql),
    'schema.sql must add sent_via_share_intent_at idempotently via ADD COLUMN IF NOT EXISTS');
}

// ---------- runner ------------------------------------------------------

async function run() {
  const tests = [
    ['db.markInvoiceSentFromShareIntent: SQL has CASE-guarded status + stamp + user_id WHERE', testMarkSentSqlShape],
    ['db.markInvoiceSentFromShareIntent: draft flips to sent', testMarkSentFlipsDraft],
    ['db.markInvoiceSentFromShareIntent: already-sent does not re-stamp', testMarkSentLeavesAlreadySentUnchanged],
    ['db.markInvoiceSentFromShareIntent: paid NEVER regresses', testMarkSentLeavesPaidUnchanged],
    ['db.markInvoiceSentFromShareIntent: overdue NEVER regresses', testMarkSentLeavesOverdueUnchanged],
    ['db.markInvoiceSentFromShareIntent: invalid args short-circuit to null without querying', testMarkSentReturnsNullOnInvalidArgs],
    ['POST /invoices/:id/share-intent: draft flip returns flipped=true + sent', testRouteFlipsDraftAndReturnsFlippedTrue],
    ['POST /invoices/:id/share-intent: all four kinds (whatsapp/sms/email/copy) accepted', testRouteAcceptsAllFourIntentKinds],
    ['POST /invoices/:id/share-intent: already-sent is 200 ok with flipped=false', testRouteIdempotentOnAlreadySent],
    ['POST /invoices/:id/share-intent: paid invoice reports flipped=false (never regresses)', testRouteIdempotentOnPaid],
    ['POST /invoices/:id/share-intent: bad intent string is 400', testRouteRejectsInvalidIntent],
    ['POST /invoices/:id/share-intent: missing intent is 400', testRouteRejectsMissingIntent],
    ['POST /invoices/:id/share-intent: accepts urlencoded body (sendBeacon-friendly)', testRouteAcceptsFormUrlencoded],
    ['POST /invoices/:id/share-intent: cross-tenant invoice id is 404, mark helper never fires', testRoute404ForCrossTenantInvoice],
    ['POST /invoices/:id/share-intent: missing invoice is 404', testRoute404ForMissingInvoice],
    ['view: all 4 share-intent surfaces in public-share-section call fireIntent(kind)', testViewWiresAllFourIntentsInPublicShareSection],
    ['view: all 4 share-intent surfaces in Pro pay-link section call fireIntent(kind)', testViewWiresAllFourIntentsInProPayLinkSection],
    ['view: fireIntent fetch uses keepalive:true + X-CSRF-Token + JSON body', testViewFireIntentPostsKeepaliveWithCsrf],
    ['view: Pro user with pay-link has fireIntent defined in BOTH x-data scopes', testViewFireIntentPresentInBothScopesForProUser],
    ['view: fireIntent swallows fetch errors so the native handoff never breaks', testViewFireIntentSwallowsErrors],
    ['schema.sql: sent_via_share_intent_at migration is idempotent', testSchemaIdempotent]
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
