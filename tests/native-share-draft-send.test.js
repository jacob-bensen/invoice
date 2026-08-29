'use strict';

/*
 * Native browser "More apps" share button on the primary draft-send
 * surfaces (Milestone 3 — first invoice created → first invoice sent).
 *
 * Existing per-surface send affordances cover WhatsApp / SMS / Email /
 * Copy link. That leaves the freelancer whose client actually uses
 * Signal, Telegram, Slack, iMessage, Instagram DM, Facebook Messenger,
 * or the OS-level share sheet (AirDrop, Nearby Share) staring at a
 * cluster that doesn't fit their workflow.
 *
 * navigator.share({ title, text, url }) is the Web Share API on iOS
 * Safari 12.2+, Android Chrome 75+, desktop Safari, Edge, Opera —
 * "More apps..." button opens the OS share sheet with every installed
 * messaging app. Gracefully hidden on Firefox and older browsers via
 * x-show="nativeShareSupported" gated by an x-init feature-detection
 * so unsupported browsers never see a dead-end button.
 *
 * Same POST /invoices/:id/share-intent { intent: 'native' } that the
 * existing invoice-view public-share section uses, so the atomic draft
 * → sent flip + first-sent celebration fire on activation-funnel
 * `sent_one` regardless of which app the freelancer ends up in.
 *
 * Four surfaces covered:
 *   1. invoice-view draft-send-banner  (the primary /:id first-send
 *      surface a brand-new user lands on after /quick or /new)
 *   2. dashboard freshDraftPrompt       (dashboard-level draft prompt
 *      for a draft under 24h old)
 *   3. dashboard staleDraftPrompt       (dashboard-level draft prompt
 *      for a draft over 24h old)
 *   4. dashboard per-row "Send now"     (table-level per-draft cluster
 *      that lets a freelancer clear a multi-draft backlog in-place)
 *
 * Run: node tests/native-share-draft-send.test.js
 */

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';
process.env.APP_URL = process.env.APP_URL || 'https://decentinvoice.test';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');

const VIEWS = path.join(__dirname, '..', 'views');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ---------- dashboard render helper --------------------------------------

const dashboardTplPath = path.join(VIEWS, 'dashboard.ejs');
const dashboardTpl = fs.readFileSync(dashboardTplPath, 'utf8');

function renderDashboard(locals) {
  return ejs.render(dashboardTpl, Object.assign({
    title: 'Dashboard',
    flash: null,
    days_left_in_trial: 0,
    csrfToken: 'TEST_CSRF',
    invoices: [],
    user: { plan: 'free', invoice_count: 5, subscription_status: null },
    onboarding: null,
    invoiceLimitProgress: null,
    recentRevenue: null,
    annualUpgradePrompt: null,
    socialProof: null,
    celebration: null,
    staleDraftPrompt: null,
    paymentClaimPrompt: null,
    recentViewPrompt: null,
    clientViewedFollowupPrompt: null,
    sentNotViewedPrompt: null,
    overduePrompt: null,
    firstRealInvoicePrompt: null,
    freshDraftPrompt: null,
    repeatClientPrompt: null,
    pendingQuickInvoice: null,
    tableFollowUpIntents: {},
    tableSendIntents: {}
  }, locals), {
    views: [VIEWS],
    filename: dashboardTplPath
  });
}

const SHARE_URL = 'https://decentinvoice.test/i/a1b2c3d4e5f6a1b2';
const SHARE_SUBJECT = 'Invoice INV-2026-0042 — $500.00';
const SHARE_BODY = "Hi Acme Corp, here's invoice INV-2026-0042 for $500.00. View it here: " + SHARE_URL;

function baseShareIntents(extra) {
  return Object.assign({
    body: SHARE_BODY,
    subject: SHARE_SUBJECT,
    whatsapp: 'https://wa.me/?text=Hi%20Acme%20Corp',
    sms: 'sms:?&body=Hi%20Acme%20Corp',
    mailto: 'mailto:ap%40acme.example?subject=Invoice&body=Hi%20Acme%20Corp',
    url: SHARE_URL
  }, extra || {});
}

// ---------- fresh-draft prompt -------------------------------------------

function freshDraftPrompt(extra) {
  return Object.assign({
    id: 17,
    invoiceNumber: 'INV-2026-0042',
    clientName: 'Acme Corp',
    clientEmail: '',
    total: 500,
    ageMinutes: 12,
    directEmail: false,
    shareIntents: baseShareIntents()
  }, extra || {});
}

test('fresh-draft: "More apps" native-share button renders when share intents present', () => {
  const html = renderDashboard({ freshDraftPrompt: freshDraftPrompt() });
  assert.match(html, /data-testid="fresh-draft-share-native"/,
    'native share button present in fresh-draft prompt');
  assert.match(html, /data-testid="fresh-draft-share-native"[\s\S]{0,300}data-share="native"|data-share="native"[\s\S]{0,300}data-testid="fresh-draft-share-native"/,
    'native button carries data-share="native"');
});

test('fresh-draft: native button is x-show-gated by nativeShareSupported', () => {
  const html = renderDashboard({ freshDraftPrompt: freshDraftPrompt() });
  // The button must not surface on Firefox / older browsers — the
  // x-show="nativeShareSupported" flag defaults to false and only flips
  // via x-init's feature-detection.
  const btn = html.match(/<button[^>]*data-testid="fresh-draft-share-native"[^>]*>/);
  assert.ok(btn, 'button element found');
  assert.match(btn[0], /x-show="nativeShareSupported"/,
    'native button must be gated by x-show="nativeShareSupported"');
});

test('fresh-draft: prompt wrapper declares nativeShareSupported: false + x-init detection', () => {
  const html = renderDashboard({ freshDraftPrompt: freshDraftPrompt() });
  const wrapperStart = html.indexOf('data-testid="fresh-draft-prompt"');
  assert.ok(wrapperStart >= 0);
  // Look at the wrapper's opening tag attributes.
  const wrapperWindow = html.slice(wrapperStart, wrapperStart + 3000);
  assert.match(wrapperWindow, /nativeShareSupported:\s*false/,
    'x-data must declare nativeShareSupported: false so the button stays hidden until init proves support');
  assert.match(wrapperWindow, /x-init="[^"]*navigator\.share[^"]*nativeShareSupported\s*=\s*true/,
    'x-init must set nativeShareSupported = true when navigator.share is a function');
});

test('fresh-draft: native button passes subject/body/url to navigator.share', () => {
  const html = renderDashboard({ freshDraftPrompt: freshDraftPrompt() });
  const btn = html.match(/<button[^>]*data-testid="fresh-draft-share-native"[^>]*>/);
  assert.ok(btn);
  assert.match(btn[0], /navigator\.share\(/,
    'button must invoke navigator.share(...)');
  assert.ok(btn[0].includes('INV-2026-0042'),
    'title / body must carry the invoice number so the share payload is ready to send');
  assert.ok(btn[0].includes(SHARE_URL),
    'url slot must carry the public share URL');
});

test('fresh-draft: native button POSTs share-intent { intent: "native" } with CSRF', () => {
  const html = renderDashboard({ freshDraftPrompt: freshDraftPrompt() });
  const btn = html.match(/<button[^>]*data-testid="fresh-draft-share-native"[^>]*>/);
  assert.ok(btn);
  assert.match(btn[0], /fetch\('\/invoices\/17\/share-intent'/,
    'button must fire the same /share-intent atomic flip endpoint the other channels use');
  assert.match(btn[0], /intent.{1,5}native/,
    'body must name intent="native" so the whitelist accepts + telemetry captures the channel');
  assert.match(btn[0], /X-CSRF-Token.{1,40}TEST_CSRF/,
    'CSRF token wired');
});

test('fresh-draft: native button hostile inputs are safely encoded', () => {
  // A hostile invoice_number reaches the button as JSON.stringify(subject),
  // which HTML-escapes to prevent an attribute-context escape into the
  // Alpine expression. The double-quote inside the string must be
  // rendered as a JSON escape `\"` inside a "-quoted attribute, and the
  // HTML-attribute quoting must survive.
  const html = renderDashboard({ freshDraftPrompt: freshDraftPrompt({
    shareIntents: baseShareIntents({
      subject: 'Evil"><script>alert(1)</script>',
      body: 'Evil"><script>alert(1)</script>'
    })
  }) });
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/,
    'hostile subject/body must not break out of the attribute context');
});

// ---------- stale-draft prompt -------------------------------------------

function staleDraftPrompt(extra) {
  return Object.assign({
    id: 23,
    invoiceNumber: 'INV-2026-0042',
    clientName: 'Acme Corp',
    clientEmail: '',
    total: 500,
    hoursOld: 30,
    directEmail: false,
    shareIntents: baseShareIntents()
  }, extra || {});
}

test('stale-draft: "More apps" native-share button renders when share intents present', () => {
  const html = renderDashboard({ staleDraftPrompt: staleDraftPrompt() });
  assert.match(html, /data-testid="stale-draft-share-native"/,
    'native share button present in stale-draft prompt');
});

test('stale-draft: native button is x-show-gated by nativeShareSupported', () => {
  const html = renderDashboard({ staleDraftPrompt: staleDraftPrompt() });
  const btn = html.match(/<button[^>]*data-testid="stale-draft-share-native"[^>]*>/);
  assert.ok(btn);
  assert.match(btn[0], /x-show="nativeShareSupported"/);
});

test('stale-draft: prompt wrapper declares nativeShareSupported + x-init detection', () => {
  const html = renderDashboard({ staleDraftPrompt: staleDraftPrompt() });
  const wrapperStart = html.indexOf('data-testid="stale-draft-prompt"');
  assert.ok(wrapperStart >= 0);
  const wrapperWindow = html.slice(wrapperStart, wrapperStart + 3000);
  assert.match(wrapperWindow, /nativeShareSupported:\s*false/);
  assert.match(wrapperWindow, /x-init="[^"]*navigator\.share[^"]*nativeShareSupported\s*=\s*true/);
});

test('stale-draft: native button posts intent=native + calls navigator.share', () => {
  const html = renderDashboard({ staleDraftPrompt: staleDraftPrompt() });
  const btn = html.match(/<button[^>]*data-testid="stale-draft-share-native"[^>]*>/);
  assert.ok(btn);
  assert.match(btn[0], /fetch\('\/invoices\/23\/share-intent'/);
  assert.match(btn[0], /intent.{1,5}native/);
  assert.match(btn[0], /navigator\.share\(/);
  assert.ok(btn[0].includes(SHARE_URL));
});

// ---------- dashboard per-row Send now cluster ---------------------------

function tableRow(extra) {
  return Object.assign({
    id: 11,
    invoice_number: 'INV-2026-0011',
    client_name: 'Acme Corp',
    issued_date: '2026-05-20T00:00:00Z',
    total: '500.00',
    status: 'draft',
    is_seed: false,
    public_token: 'a1b2c3d4e5f6a1b2',
    first_viewed_at: null,
    payment_claimed_at: null,
    payment_link_url: null
  }, extra || {});
}

function tableSendEntry(extra) {
  return Object.assign({
    url: SHARE_URL,
    shareIntents: baseShareIntents(),
    directEmail: false,
    clientEmail: 'ap@acme.example'
  }, extra || {});
}

test('per-row Send: "More apps" native-share button renders for a draft row', () => {
  const html = renderDashboard({
    invoices: [tableRow()],
    tableSendIntents: { '11': tableSendEntry() }
  });
  assert.match(html, /data-testid="table-send-native-11"/,
    'per-row native share button present');
});

test('per-row Send: native button is x-show-gated by nativeShareSupported', () => {
  const html = renderDashboard({
    invoices: [tableRow()],
    tableSendIntents: { '11': tableSendEntry() }
  });
  const btn = html.match(/<button[^>]*data-testid="table-send-native-11"[^>]*>/);
  assert.ok(btn, 'button element found');
  assert.match(btn[0], /x-show="nativeShareSupported"/);
});

test('per-row Send: cluster wrapper declares nativeShareSupported + x-init detection', () => {
  const html = renderDashboard({
    invoices: [tableRow()],
    tableSendIntents: { '11': tableSendEntry() }
  });
  const wrapperStart = html.indexOf('data-testid="table-send-11"');
  assert.ok(wrapperStart >= 0);
  // Search upward for the x-data block on the same element by looking at
  // the surrounding wrapper window.
  const wrapperWindow = html.slice(Math.max(0, wrapperStart - 3000), wrapperStart + 200);
  assert.match(wrapperWindow, /nativeShareSupported:\s*false/);
  assert.match(wrapperWindow, /x-init="[^"]*navigator\.share[^"]*nativeShareSupported\s*=\s*true/);
});

test('per-row Send: native button POSTs share-intent + calls navigator.share', () => {
  const html = renderDashboard({
    invoices: [tableRow()],
    tableSendIntents: { '11': tableSendEntry() }
  });
  const btn = html.match(/<button[^>]*data-testid="table-send-native-11"[^>]*>/);
  assert.ok(btn);
  assert.match(btn[0], /fetch\('\/invoices\/11\/share-intent'/);
  assert.match(btn[0], /intent.{1,5}native/);
  assert.match(btn[0], /navigator\.share\(/);
  assert.ok(btn[0].includes(SHARE_URL),
    'url slot must carry the public share URL for the row');
  assert.ok(btn[0].includes('INV-2026-0042'),
    'subject/body must carry the invoice number embedded in the share intents');
});

test('per-row Send: cluster is OMITTED when the map has no entry (no dead native button)', () => {
  const html = renderDashboard({
    invoices: [tableRow({ id: 99 })],
    tableSendIntents: {}
  });
  assert.doesNotMatch(html, /data-testid="table-send-native-99"/,
    'no send cluster → no native button');
});

test('per-row Send: independent per-row nativeShareSupported state — no id-collision', () => {
  const html = renderDashboard({
    invoices: [
      tableRow({ id: 11 }),
      tableRow({ id: 12, invoice_number: 'INV-2026-0012' })
    ],
    tableSendIntents: {
      '11': tableSendEntry(),
      '12': tableSendEntry({ url: SHARE_URL.replace('a1b2', 'ffff'), shareIntents: baseShareIntents({ url: SHARE_URL.replace('a1b2', 'ffff') }) })
    }
  });
  assert.match(html, /data-testid="table-send-native-11"/);
  assert.match(html, /data-testid="table-send-native-12"/);
  // Each row gets its own x-data instance so state can't leak — assert
  // both nativeShareSupported blocks appear (Alpine scopes independently
  // per element even though the string is identical).
  const matches = html.match(/nativeShareSupported:\s*false/g);
  assert.ok(matches && matches.length >= 2,
    'multiple send clusters each declare their own nativeShareSupported field');
});

// ---------- invoice-view draft-send-banner -------------------------------

function renderInvoiceViewDraft() {
  const shareIntents = baseShareIntents();
  return ejs.renderFile(path.join(VIEWS, 'invoice-view.ejs'), {
    title: 'Invoice',
    user: { plan: 'free', email: 'me@example.com', name: 'Me', business_name: null, payment_instructions: 'Venmo @me' },
    invoice: {
      id: 42,
      invoice_number: 'INV-2026-0042',
      status: 'draft',
      issued_date: new Date('2026-05-01'),
      due_date: new Date('2026-05-31'),
      client_name: 'Acme Corp',
      client_email: 'ap@acme.example',
      client_address: '',
      items: [{ description: 'Work', quantity: 1, unit_price: 500 }],
      subtotal: 500, tax_rate: 0, tax_amount: 0, total: 500,
      notes: null,
      payment_link_url: null,
      public_token: 'a1b2c3d4e5f6a1b2'
    },
    paymentMethods: ['card'],
    csrfToken: 'TEST_CSRF',
    flash: null,
    prefetchedShare: {
      url: SHARE_URL,
      shareIntents,
      followUpIntents: shareIntents
    }
  }, { views: [VIEWS] });
}

test('invoice-view draft-send-banner: "More apps" native-share button renders', async () => {
  const html = await renderInvoiceViewDraft();
  assert.match(html, /data-testid="draft-send-banner-native"/,
    'native share button present in draft-send-banner');
});

test('invoice-view draft-send-banner: native button is x-show-gated by nativeShareSupported', async () => {
  const html = await renderInvoiceViewDraft();
  const btn = html.match(/<button[^>]*data-testid="draft-send-banner-native"[^>]*>/);
  assert.ok(btn);
  assert.match(btn[0], /x-show="nativeShareSupported"/);
});

test('invoice-view draft-send-banner: wrapper declares nativeShareSupported + x-init detection', async () => {
  const html = await renderInvoiceViewDraft();
  const wrapperStart = html.indexOf('data-testid="draft-send-banner"');
  assert.ok(wrapperStart >= 0);
  const wrapperWindow = html.slice(wrapperStart, wrapperStart + 3000);
  assert.match(wrapperWindow, /nativeShareSupported:\s*false/);
  assert.match(wrapperWindow, /x-init="[^"]*navigator\.share[^"]*nativeShareSupported\s*=\s*true/);
});

test('invoice-view draft-send-banner: native button posts intent=native + calls navigator.share', async () => {
  const html = await renderInvoiceViewDraft();
  const btn = html.match(/<button[^>]*data-testid="draft-send-banner-native"[^>]*>/);
  assert.ok(btn);
  assert.match(btn[0], /fetch\('\/invoices\/42\/share-intent'/);
  assert.match(btn[0], /intent.{1,5}native/);
  assert.match(btn[0], /navigator\.share\(/);
  assert.ok(btn[0].includes(SHARE_URL),
    'url slot must carry the public share URL');
  assert.ok(btn[0].includes('INV-2026-0042'),
    'subject/body must carry the invoice number');
});

test('invoice-view draft-send-banner: native button carries data-share="native"', async () => {
  const html = await renderInvoiceViewDraft();
  const btn = html.match(/<button[^>]*data-testid="draft-send-banner-native"[^>]*>/);
  assert.ok(btn);
  assert.match(btn[0], /data-share="native"/);
});

// ---------- runner --------------------------------------------------------

(async function run() {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log(`  ok  ${t.name}`);
    } catch (err) {
      failed++;
      console.error(`  FAIL  ${t.name}`);
      console.error(`    ${err && err.stack ? err.stack : err}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed (native-share-draft-send.test.js)`);
  if (failed > 0) process.exit(1);
})();
