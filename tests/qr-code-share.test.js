'use strict';

/*
 * In-person QR-code handoff on the owner's invoice view
 * (Milestone 3 — first invoice created → first invoice sent; Milestone 4 —
 * first sent → first paid).
 *
 * In-person service freelancers (trainers, hairdressers, contractors,
 * tutors, mobile mechanics, pet groomers, in-home services) finish a
 * session face-to-face with the client. The existing share surfaces
 * (WhatsApp, SMS, mailto:, copy-link, native share sheet) all require a
 * messaging hop — they're built for async delivery. The face-to-face
 * moment is exactly where the activation friction lives: the freelancer
 * has the client right in front of them, but the only way to deliver the
 * invoice is "I'll text it to you later" — a multi-step async flow whose
 * payment rate is materially worse than collecting in the moment.
 *
 * The QR-code panel collapses that flow to a single gesture: the
 * freelancer taps "Show QR code", flips their phone toward the client,
 * the client scans with their camera app, and lands on the same
 * /i/<token> public share page that already exists — which has tap-to-pay
 * (Venmo/Cash App/PayPal/Stripe), payment instructions, the full invoice
 * preview, and the auto-flip-to-sent view-tracking pipeline already wired.
 *
 * Implementation choices locked in by these tests:
 *   - 'qr' is whitelisted in SHARE_INTENT_KINDS so the existing
 *     /share-intent endpoint flips draft → sent on first reveal (same path
 *     as the other intent kinds). No new endpoint, no new schema.
 *   - The qrcode.js CDN script is lazy-loaded on the first reveal — the
 *     page pays zero load tax until the freelancer uses the panel. Most
 *     invoice views never load the library.
 *   - The QR panel is gated on `url` being set (the public share URL is
 *     eagerly minted in GET /invoices/:id), so a token-mint hiccup
 *     hides the panel rather than rendering a broken QR.
 *   - revealQr() is a toggle — second tap collapses the panel without
 *     re-firing fireIntent('qr') (idempotency is only at the route layer,
 *     so we don't want to redundantly POST on every collapse/expand
 *     cycle from the same page load).
 *   - The panel sits in the SAME x-data scope as the existing share
 *     surface, sharing the `url` state and the `fireIntent` method — so
 *     a future URL refresh (e.g., a token rotation) immediately updates
 *     the QR target without dual-tracking.
 *
 * Covers:
 *   - SHARE_INTENT_KINDS exports 'qr' (route-layer accept-list).
 *   - POST /invoices/:id/share-intent with intent='qr' flips draft → sent
 *     and returns flipped=true (route happy path; same shape as the other
 *     intent kinds).
 *   - POST /invoices/:id/share-intent with intent='qr' on an already-sent
 *     invoice returns ok=true with flipped=false (idempotency).
 *   - View renders the QR toggle button.
 *   - View renders the QR panel hidden until revealed.
 *   - View's x-data scope declares qrOpen / qrRendered / qrError state
 *     and the revealQr() method.
 *   - revealQr() lazy-loads the qrcode.js CDN library on first reveal,
 *     not at page load.
 *   - revealQr() fires fireIntent('qr') on reveal (auto-flip wiring).
 *   - revealQr() is a toggle (second call collapses qrOpen=false).
 *   - The QR slot is uniquely identified (per-invoice id) so two views
 *     in the same browser tab can't collide.
 *   - The QR panel renders inside the public-share-section so it shares
 *     the same `url` source of truth.
 *
 * Run: NODE_ENV=test node tests/qr-code-share.test.js
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

// ---------- route module load (sandboxed db stub) ------------------------

function loadRoutesWithDbStub(dbStub) {
  require.cache[require.resolve('../db')] = {
    id: require.resolve('../db'),
    filename: require.resolve('../db'),
    loaded: true,
    exports: dbStub
  };
  delete require.cache[require.resolve('../routes/invoices')];
  return require('../routes/invoices');
}

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
      async getOrCreatePublicToken() { return 'tokentokentokentokentokentokento'; }
    }
  };
  const invoiceRoutes = loadRoutesWithDbStub(dbStub);
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

function postIntent(app, id, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const payload = JSON.stringify(body);
      const req = http.request({
        hostname: '127.0.0.1', port, path: `/invoices/${id}/share-intent`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, (res) => {
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

// ---------- Whitelist -----------------------------------------------------

function testShareIntentKindsAcceptsQr() {
  // The SHARE_INTENT_KINDS Set in routes/invoices.js is the route-layer
  // gate that turns the freelancer's reveal into the draft → sent flip.
  // Adding 'qr' here is the smallest contract change that lets every
  // existing share-intent guarantee (cross-tenant ownership, idempotency,
  // celebration trigger) cover the QR cohort too. Grepping the source is
  // the cheapest stable assertion — the literal Set declaration is the
  // single source of truth and a regression would surface as a 400 from
  // the live route, which the route test below catches in a second layer.
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'invoices.js'), 'utf8');
  const m = src.match(/SHARE_INTENT_KINDS\s*=\s*new\s+Set\(\s*\[([^\]]+)\]\s*\)/);
  assert.ok(m, 'SHARE_INTENT_KINDS Set declaration must be present in routes/invoices.js');
  const kinds = m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
  assert.ok(kinds.includes('qr'),
    `'qr' must be whitelisted in SHARE_INTENT_KINDS; got: ${kinds.join(', ')}`);
}

// ---------- Route layer ---------------------------------------------------

async function testRouteFlipsDraftOnQrIntent() {
  const { app, calls } = buildInvoiceApp({
    invoiceRow: { id: 5, user_id: 7, status: 'draft', invoice_number: 'INV-1' },
    markResult: { id: 5, status: 'sent', sent_via_share_intent_at: new Date() }
  });
  const r = await postIntent(app, 5, { intent: 'qr' });
  assert.strictEqual(r.status, 200,
    'intent="qr" on a draft must succeed; got ' + r.status + ' body=' + r.body);
  const body = JSON.parse(r.body);
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.status, 'sent',
    'a draft must come back as sent after the QR intent fires');
  assert.strictEqual(body.flipped, true,
    'flipped=true when the invoice came in as draft and went out as sent');
  assert.strictEqual(body.intent, 'qr',
    'echoed intent locks in the contract that the route accepted the literal "qr" string');
  assert.deepStrictEqual(calls.mark, [{ id: 5, uid: 7 }],
    'mark helper called exactly once on QR intent — same path as other kinds');
}

async function testRouteIdempotentOnAlreadySent() {
  // First reveal in a session fires once; a second reveal in a new browser
  // tab on an already-sent invoice must NOT report flipped=true, otherwise
  // the celebration would fire twice from a single conversion.
  const { app } = buildInvoiceApp({
    invoiceRow: { id: 5, user_id: 7, status: 'sent', invoice_number: 'INV-1' },
    markResult: { id: 5, status: 'sent', sent_via_share_intent_at: null }
  });
  const r = await postIntent(app, 5, { intent: 'qr' });
  assert.strictEqual(r.status, 200, 'already-sent + qr intent is still 200');
  const body = JSON.parse(r.body);
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.flipped, false,
    'flipped=false because the invoice was already sent before the QR intent fired');
}

// ---------- View layer ----------------------------------------------------

async function renderInvoiceView(overrides) {
  const opts = overrides || {};
  return ejs.renderFile(path.join(VIEWS, 'invoice-view.ejs'), {
    title: 'Invoice',
    user: {
      plan: (opts.userPlan === 'pro' ? 'pro' : 'free'),
      email: 'me@example.com',
      name: 'Me',
      business_name: null
    },
    invoice: {
      id: 5,
      invoice_number: 'INV-2026-0001',
      status: opts.invoiceStatus || 'draft',
      issued_date: new Date('2026-05-01'),
      due_date: new Date('2026-05-31'),
      client_name: 'Acme',
      client_email: 'acme@x.example',
      client_address: '',
      items: [{ description: 'Work', quantity: 1, unit_price: 100 }],
      subtotal: 100, tax_rate: 0, tax_amount: 0, total: 100,
      notes: null,
      payment_link_url: null,
      public_token: 'tokentokentokentokentokentokento'
    },
    paymentMethods: ['card'],
    csrfToken: 'test-csrf-token',
    flash: null,
    prefetchedShare: opts.prefetchedShare === null ? null : {
      url: 'https://example.test/i/tokentokentokentokentokentokento',
      shareIntents: { whatsapp: 'https://wa.me/', sms: 'sms:', mailto: 'mailto:', subject: 's', body: 'b' },
      followUpIntents: { whatsapp: 'https://wa.me/', sms: 'sms:', mailto: 'mailto:', subject: 's', body: 'b' }
    }
  }, { views: [VIEWS] });
}

function extractPublicShareSection(html) {
  const start = html.indexOf('data-testid="public-share-section"');
  assert.ok(start >= 0, 'public-share-section anchor present');
  // Walk forward to the start of the Payment Link section (or end of file).
  const end = html.indexOf('<!-- Payment Link', start);
  return html.slice(start, end > 0 ? end : html.length);
}

async function testViewRendersQrTogglePanel() {
  const html = await renderInvoiceView();
  const section = extractPublicShareSection(html);
  assert.ok(/data-testid="public-share-qr"/.test(section),
    'QR section must render inside public-share-section');
  assert.ok(/data-testid="public-share-qr-toggle"/.test(section),
    'QR toggle button must render');
  assert.ok(/data-testid="public-share-qr-panel"/.test(section),
    'QR collapsible panel must render');
  assert.ok(/data-testid="public-share-qr-image"/.test(section),
    'QR image slot must render');
}

async function testViewQrSlotIsPerInvoiceUnique() {
  // The QR image slot uses an id so the lazy-load callback can find it
  // via document.getElementById. The id must include the invoice id so
  // two open tabs in the same browser session (e.g. a freelancer viewing
  // two invoices in side-by-side tabs) cannot collide on the same DOM
  // slot when each loads the qrcode.js script separately.
  const html = await renderInvoiceView();
  assert.ok(/id="owner-share-qr-5"/.test(html),
    'QR slot id must be invoice-scoped (id="owner-share-qr-<invoice.id>"); the rendered invoice id was 5');
}

async function testViewQrTogglePanelHiddenUntilOpen() {
  const html = await renderInvoiceView();
  const section = extractPublicShareSection(html);
  // The collapsible panel uses x-show="qrOpen" so it stays hidden until
  // the user clicks the toggle. x-cloak ensures no first-paint flash
  // before Alpine evaluates qrOpen.
  assert.ok(/data-testid="public-share-qr-panel"[\s\S]{0,200}x-show="qrOpen"/.test(section)
    || /x-show="qrOpen"[\s\S]{0,200}data-testid="public-share-qr-panel"/.test(section),
    'QR panel must be gated on x-show="qrOpen" so it stays hidden until the user reveals it');
  // x-cloak can appear before OR after data-testid within the same <div>
  // tag — match the tag boundaries (<div ... >) and require both attrs
  // to coexist inside it.
  const panelTagMatch = section.match(/<div\b[^>]*data-testid="public-share-qr-panel"[^>]*>/);
  assert.ok(panelTagMatch, 'QR panel <div> with data-testid must render');
  assert.ok(/\bx-cloak\b/.test(panelTagMatch[0]),
    'QR panel <div> must carry x-cloak so Alpine can suppress a first-paint flash; tag was: ' + panelTagMatch[0]);
}

async function testViewQrSectionHiddenWhenNoUrl() {
  // The whole QR section is gated on x-show="url" — if the token mint
  // failed (rare) and prefetchedShare is null, the public-share-section
  // is still rendered but the URL is empty, so showing the QR would point
  // at an unresolvable target. x-show="url" suppresses it cleanly.
  const html = await renderInvoiceView();
  const section = extractPublicShareSection(html);
  assert.ok(/data-testid="public-share-qr"[\s\S]{0,200}x-show="url"/.test(section)
    || /x-show="url"[\s\S]{0,200}data-testid="public-share-qr"/.test(section),
    'QR section must be gated on x-show="url" so a token-mint hiccup never renders a broken QR');
}

async function testViewXDataDeclaresQrState() {
  // The QR-related Alpine state lives in the SAME x-data scope as the
  // existing share surface (so `url` is shared and `fireIntent` is
  // available). Verify the three state fields and the revealQr method are
  // present in the public-share-section's x-data declaration.
  const html = await renderInvoiceView();
  const section = extractPublicShareSection(html);
  assert.ok(/x-data="\{[^"]*qrOpen:\s*false/.test(section),
    'public-share-section x-data must declare qrOpen: false');
  assert.ok(/x-data="\{[^"]*qrRendered:\s*false/.test(section),
    'public-share-section x-data must declare qrRendered: false (so first-reveal lazy-load is idempotent)');
  assert.ok(/x-data="\{[^"]*qrError:\s*['"]{2}/.test(section),
    'public-share-section x-data must declare qrError: "" (so a CDN load failure surfaces user-facing copy)');
  assert.ok(/x-data="\{[^"]*revealQr\s*\(\s*\)/.test(section),
    'public-share-section x-data must declare a revealQr() method');
}

async function testViewQrToggleWiresRevealQr() {
  const html = await renderInvoiceView();
  const section = extractPublicShareSection(html);
  assert.ok(/data-testid="public-share-qr-toggle"[\s\S]{0,400}@click="revealQr\(\)"/.test(section),
    'QR toggle button must call revealQr() on click');
}

async function testRevealQrFiresShareIntentQr() {
  // First reveal must fire fireIntent('qr') so the draft → sent auto-flip
  // happens on the very first in-person handoff — without it, the
  // freelancer's dashboard would still report this invoice as a stuck
  // draft even though it had been collected in-person.
  const html = await renderInvoiceView();
  const section = extractPublicShareSection(html);
  // Match the revealQr method body — the call to fireIntent('qr') must
  // appear inside it.
  assert.ok(/revealQr\(\)\s*\{[\s\S]{0,1200}fireIntent\(\s*['"]qr['"]\s*\)/.test(section),
    'revealQr() body must call fireIntent("qr") so the draft → sent auto-flip fires on first reveal');
}

async function testRevealQrLazyLoadsCdnScript() {
  // The qrcode.js CDN library is heavy enough (~14KB) that loading it on
  // every invoice-view render would noticeably slow the page for the
  // 99%+ of users who never use the QR. Verify the script tag is
  // injected on first reveal, not declared at page load.
  const html = await renderInvoiceView();
  const section = extractPublicShareSection(html);
  assert.ok(/revealQr\(\)\s*\{[\s\S]{0,2000}cdn\.jsdelivr\.net\/npm\/qrcode/.test(section),
    'revealQr() must lazy-load the qrcode.js CDN script — not declared inline at page load');
  // Page-load script tag for the qrcode library must NOT exist; only the
  // lazy-loader inside revealQr should reference the CDN URL.
  // We allow exactly one cdn URL occurrence in the section (inside the
  // revealQr lazy-loader); a second top-level <script src="..."> reference
  // would be a regression. Count occurrences explicitly so a future
  // refactor that "improves" by pre-loading the script trips the test.
  const cdnHits = (section.match(/cdn\.jsdelivr\.net\/npm\/qrcode/g) || []).length;
  assert.strictEqual(cdnHits, 1,
    `qrcode CDN URL must appear exactly once (inside the lazy-loader); got ${cdnHits} occurrences in public-share-section`);
}

async function testRevealQrIsAToggle() {
  // Second tap on the toggle button must collapse the panel without
  // re-firing fireIntent('qr') or re-rendering the QR. The toggle
  // pattern is encoded by the leading `if (this.qrOpen) { ...; return; }`
  // guard in revealQr() — without it, every click would lazy-load the
  // script all over again.
  const html = await renderInvoiceView();
  const section = extractPublicShareSection(html);
  assert.ok(/revealQr\(\)\s*\{\s*if\s*\(\s*this\.qrOpen\s*\)\s*\{[^}]*qrOpen\s*=\s*false[^}]*return\s*;[^}]*\}/.test(section),
    'revealQr() must short-circuit to qrOpen=false on a second tap (toggle pattern)');
}

// ---------- runner --------------------------------------------------------

async function run() {
  const tests = [
    ['SHARE_INTENT_KINDS whitelist accepts "qr"', testShareIntentKindsAcceptsQr],
    ['POST /invoices/:id/share-intent: intent="qr" flips draft → sent', testRouteFlipsDraftOnQrIntent],
    ['POST /invoices/:id/share-intent: intent="qr" is idempotent on already-sent', testRouteIdempotentOnAlreadySent],
    ['view: QR toggle + panel + image slot render in public-share-section', testViewRendersQrTogglePanel],
    ['view: QR image slot id is invoice-scoped (no cross-tab collision)', testViewQrSlotIsPerInvoiceUnique],
    ['view: QR panel is x-show="qrOpen" + x-cloak (hidden until revealed)', testViewQrTogglePanelHiddenUntilOpen],
    ['view: QR section is x-show="url" (suppressed when no public-share URL)', testViewQrSectionHiddenWhenNoUrl],
    ['view: public-share-section x-data declares qrOpen / qrRendered / qrError / revealQr()', testViewXDataDeclaresQrState],
    ['view: QR toggle button calls revealQr() on @click', testViewQrToggleWiresRevealQr],
    ['view: revealQr() fires fireIntent("qr") on first reveal (draft→sent wiring)', testRevealQrFiresShareIntentQr],
    ['view: revealQr() lazy-loads the qrcode.js CDN (not declared at page load)', testRevealQrLazyLoadsCdnScript],
    ['view: revealQr() is a toggle (second tap collapses without re-firing)', testRevealQrIsAToggle]
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
