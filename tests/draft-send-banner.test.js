'use strict';

/*
 * Draft "send now" banner at the top of /invoices/:id (Milestone 3 — first
 * invoice created → first invoice sent).
 *
 * A brand-new user lands here from POST /invoices/quick with status='draft'
 * and a prefetched share surface. The existing public-share-section sits
 * BELOW the invoice preview card; this banner surfaces the same WhatsApp /
 * SMS / Email / Copy share-intent targets ABOVE the preview so the
 * next-action is unmistakable and one tap away. Server-rendered hrefs so
 * the buttons work even without JS; the onclick handler additionally
 * posts to /share-intent so the existing draft → sent auto-flip fires
 * regardless of which channel the user picks.
 *
 * Run: NODE_ENV=test node tests/draft-send-banner.test.js
 */

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

const assert = require('assert');
const path = require('path');
const ejs = require('ejs');

const VIEWS = path.join(__dirname, '..', 'views');

function makeInvoice(overrides) {
  return Object.assign({
    id: 5,
    invoice_number: 'INV-2026-0001',
    status: 'draft',
    issued_date: new Date('2026-05-01'),
    due_date: new Date('2026-05-31'),
    client_name: 'Acme Corp',
    client_email: 'acme@x.example',
    client_address: '',
    items: [{ description: 'Work', quantity: 1, unit_price: 100 }],
    subtotal: 100, tax_rate: 0, tax_amount: 0, total: 100,
    notes: null,
    payment_link_url: null
  }, overrides || {});
}

function makeIntents() {
  return {
    body: 'Hi Acme Corp, here\'s invoice INV-2026-0001 for $100.00. View it here: https://decentinvoice.com/i/cafef00ddeadbeef',
    subject: 'Invoice INV-2026-0001 — $100.00',
    whatsapp: 'https://wa.me/?text=PREFETCHED-WA',
    sms: 'sms:?&body=PREFETCHED-SMS',
    mailto: 'mailto:acme%40x.example?subject=PREFETCHED-SUB&body=PREFETCHED-BODY'
  };
}

function renderView({ invoice, prefetchedShare, userPlan, userOverrides }) {
  const baseUser = { plan: userPlan || 'free', email: 'me@example.com', name: 'Me', business_name: null };
  const user = Object.assign(baseUser, userOverrides || {});
  return ejs.renderFile(path.join(VIEWS, 'invoice-view.ejs'), {
    title: 'Invoice',
    user,
    invoice: invoice || makeInvoice(),
    paymentMethods: ['card'],
    csrfToken: 'csrf-test-tkn',
    prefetchedShare: prefetchedShare === undefined ? null : prefetchedShare,
    flash: null
  }, { views: [VIEWS] });
}

function sliceBanner(html) {
  const start = html.indexOf('data-testid="draft-send-banner"');
  if (start < 0) return null;
  // Find the closing </div> that ends the banner — banner is a single
  // top-level <div> with a known closing marker (the immediately-following
  // "Invoice preview card" comment).
  const end = html.indexOf('<!-- Invoice preview card -->', start);
  return html.slice(start, end > 0 ? end : html.length);
}

async function testBannerRendersOnDraftWithPrefetchedShare() {
  const html = await renderView({
    invoice: makeInvoice({ status: 'draft' }),
    prefetchedShare: { url: 'https://decentinvoice.com/i/cafef00ddeadbeef',
      shareIntents: makeIntents(), followUpIntents: null }
  });
  const banner = sliceBanner(html);
  assert.ok(banner, 'draft-send-banner renders for status=draft + prefetchedShare with intents');
  assert.ok(/Ready to send to Acme Corp\?/.test(banner),
    'banner headline names the client when client_name is present');
  // The banner must precede the invoice preview card. The slice cuts on the
  // preview-card comment so finding it at all already proves order; assert
  // belt-and-braces that "Bill To" appears AFTER the banner in the full doc.
  const bannerStart = html.indexOf('data-testid="draft-send-banner"');
  const billTo = html.indexOf('Bill To');
  assert.ok(bannerStart >= 0 && billTo > bannerStart,
    'draft-send-banner is positioned ABOVE the invoice preview card (Bill To section)');
}

async function testBannerHiddenOnNonDraftStatuses() {
  for (const status of ['sent', 'paid', 'overdue']) {
    const html = await renderView({
      invoice: makeInvoice({ status }),
      prefetchedShare: { url: 'https://decentinvoice.com/i/cafef00ddeadbeef',
        shareIntents: makeIntents(), followUpIntents: null }
    });
    assert.ok(!/data-testid="draft-send-banner"/.test(html),
      'draft-send-banner must NOT render for status=' + status +
      ' (only the draft state needs the above-fold send CTA)');
  }
}

async function testBannerHiddenWhenPrefetchedShareMissing() {
  // A token-mint failure (rare but observable) leaves prefetchedShare=null.
  // The banner must short-circuit cleanly so users land on the existing
  // public-share-section path (Generate-link fallback) instead of seeing
  // a broken row with javascript:undefined hrefs.
  const html = await renderView({
    invoice: makeInvoice({ status: 'draft' }),
    prefetchedShare: null
  });
  assert.ok(!/data-testid="draft-send-banner"/.test(html),
    'draft-send-banner must NOT render when prefetchedShare is null (no broken hrefs)');
}

async function testBannerHiddenWhenIntentsMissing() {
  // prefetchedShare can be partially-populated if buildShareSurfaceForInvoice
  // returns a url with null shareIntents (defence-in-depth — current code
  // doesn't do this, but the contract should not break the page if it does).
  const html = await renderView({
    invoice: makeInvoice({ status: 'draft' }),
    prefetchedShare: { url: '/i/abcd1234abcd1234', shareIntents: null, followUpIntents: null }
  });
  assert.ok(!/data-testid="draft-send-banner"/.test(html),
    'draft-send-banner must NOT render when shareIntents is null');
}

function findOpeningTag(banner, testid) {
  // Match the opening <a ...> or <button ...> tag carrying the given testid,
  // attribute-order-agnostic. The opening tag ends at the first unescaped >.
  const re = new RegExp('<(?:a|button)\\s[^>]*data-testid="' + testid + '"[^>]*>');
  const m = banner.match(re);
  return m ? m[0] : '';
}

async function testBannerUsesPrefetchedHrefs() {
  const html = await renderView({
    invoice: makeInvoice({ status: 'draft' }),
    prefetchedShare: { url: 'https://decentinvoice.com/i/cafef00ddeadbeef',
      shareIntents: makeIntents(), followUpIntents: null }
  });
  const banner = sliceBanner(html);
  assert.ok(banner, 'banner present');

  const wa = findOpeningTag(banner, 'draft-send-banner-whatsapp');
  assert.ok(wa, 'WhatsApp opening tag located');
  assert.ok(wa.includes('href="https://wa.me/?text=PREFETCHED-WA"'),
    'WhatsApp button href is the server-rendered prefetched whatsapp intent — NOT empty, NOT a regenerated client-side URL');

  // EJS-escapes & in attribute values to &amp; — sms/mailto intents contain
  // ampersands so we account for both raw and escaped forms.
  const sms = findOpeningTag(banner, 'draft-send-banner-sms');
  assert.ok(sms, 'SMS opening tag located');
  assert.ok(/href="sms:\?(&amp;|&)body=PREFETCHED-SMS"/.test(sms),
    'SMS button href is the server-rendered prefetched sms intent');

  const email = findOpeningTag(banner, 'draft-send-banner-email');
  assert.ok(email, 'Email opening tag located');
  assert.ok(/href="mailto:acme%40x\.example\?subject=PREFETCHED-SUB(&amp;|&)body=PREFETCHED-BODY"/.test(email),
    'Email button href is the server-rendered prefetched mailto intent');
}

async function testBannerCopyButtonCarriesShareUrl() {
  const html = await renderView({
    invoice: makeInvoice({ status: 'draft' }),
    prefetchedShare: { url: 'https://decentinvoice.com/i/cafef00ddeadbeef',
      shareIntents: makeIntents(), followUpIntents: null }
  });
  const banner = sliceBanner(html);
  assert.ok(/data-testid="draft-send-banner-copy"/.test(banner),
    'Copy-link button renders when prefetchedShare.url is non-empty');
  assert.ok(/data-testid="draft-send-banner-copy"[^>]*data-share-url="https:\/\/decentinvoice\.com\/i\/cafef00ddeadbeef"/.test(banner),
    'Copy button stamps the share URL into data-share-url so the inline handler can copy it without leaking it into a global');
  assert.ok(/data-testid="draft-send-banner-copy"[\s\S]{0,800}navigator\.clipboard\.writeText/.test(banner),
    'Copy button onclick uses navigator.clipboard.writeText');
}

async function testBannerCopyButtonAbsentWhenUrlMissing() {
  // If url is missing but intents are present (degenerate prefetch shape),
  // the copy button must hide — there'd be nothing to copy.
  const html = await renderView({
    invoice: makeInvoice({ status: 'draft' }),
    prefetchedShare: { url: '', shareIntents: makeIntents(), followUpIntents: null }
  });
  const banner = sliceBanner(html);
  assert.ok(banner, 'banner still renders with empty url + intents (shows WA/SMS/Email)');
  assert.ok(!/data-testid="draft-send-banner-copy"/.test(banner),
    'Copy button must NOT render when prefetchedShare.url is empty');
}

async function testBannerFiresShareIntentOnClick() {
  // Each button's onclick must POST to /invoices/:id/share-intent so the
  // existing draft → sent auto-flip fires regardless of channel. Mirrors
  // the public-share-section's fireIntent path.
  const html = await renderView({
    invoice: makeInvoice({ id: 5, status: 'draft' }),
    prefetchedShare: { url: 'https://decentinvoice.com/i/cafef00ddeadbeef',
      shareIntents: makeIntents(), followUpIntents: null }
  });
  const banner = sliceBanner(html);
  for (const kind of ['whatsapp', 'sms', 'email', 'copy']) {
    const btnMatch = new RegExp(
      `data-testid="draft-send-banner-${kind}"[\\s\\S]{0,1500}`
    );
    const window = (banner.match(btnMatch) || [''])[0];
    assert.ok(window.includes("/invoices/5/share-intent"),
      `${kind} button onclick posts to /invoices/5/share-intent`);
    assert.ok(window.includes("'intent': '" + kind + "'") ||
              window.includes("\"intent\":\"" + kind + "\"") ||
              new RegExp(`intent['\"]?\\s*:\\s*['\"]${kind}['\"]`).test(window),
      `${kind} button onclick names intent kind '${kind}' in the JSON body`);
    assert.ok(window.includes('keepalive: true'),
      `${kind} button uses fetch keepalive so the POST survives navigation`);
    assert.ok(window.includes("X-CSRF-Token") && window.includes('csrf-test-tkn'),
      `${kind} button onclick threads the CSRF token header`);
  }
}

async function testBannerOnclickWrappedInTryCatch() {
  // A throw inside the onclick (e.g. a browser without fetch) must NOT
  // prevent the default navigation — the link should still open the share
  // target. try/catch + .catch(()=>{}) keeps the click path silent.
  const html = await renderView({
    invoice: makeInvoice({ status: 'draft' }),
    prefetchedShare: { url: 'https://decentinvoice.com/i/cafef00ddeadbeef',
      shareIntents: makeIntents(), followUpIntents: null }
  });
  const banner = sliceBanner(html);
  // At minimum: every onclick that calls fetch wraps it in try { ... } catch
  // AND attaches .catch on the fetch promise.
  for (const kind of ['whatsapp', 'sms', 'email']) {
    const re = new RegExp(`data-testid="draft-send-banner-${kind}"[\\s\\S]{0,1500}`);
    const window = (banner.match(re) || [''])[0];
    assert.ok(/onclick="try \{[\s\S]*?\.catch\(function\(\)\{\}\);[\s\S]*?\} catch \(e\) \{\}"/.test(window),
      `${kind} onclick wraps fetch in try/catch + .catch swallow so a network error never blocks the share-intent target opening`);
  }
}

async function testBannerWhatsappTargetBlank() {
  // WhatsApp web opens in a new tab so we don't leave the invoice page —
  // matches the existing public-share-section WhatsApp link behaviour
  // (target="_blank" + rel="noopener" defence).
  const html = await renderView({
    invoice: makeInvoice({ status: 'draft' }),
    prefetchedShare: { url: 'https://decentinvoice.com/i/cafef00ddeadbeef',
      shareIntents: makeIntents(), followUpIntents: null }
  });
  const banner = sliceBanner(html);
  const wa = findOpeningTag(banner, 'draft-send-banner-whatsapp');
  assert.ok(wa, 'WhatsApp opening tag located');
  assert.ok(wa.includes('target="_blank"'),
    'WhatsApp button opens in a new tab');
  assert.ok(wa.includes('rel="noopener"'),
    'WhatsApp button carries rel="noopener" to prevent reverse-tabnabbing');
}

async function testBannerHeadlineWithoutClientName() {
  // Defensive: an invoice with no client_name must still render a
  // sensible headline (no trailing "to ?" punctuation glitch).
  const html = await renderView({
    invoice: makeInvoice({ status: 'draft', client_name: '' }),
    prefetchedShare: { url: 'https://decentinvoice.com/i/cafef00ddeadbeef',
      shareIntents: makeIntents(), followUpIntents: null }
  });
  const banner = sliceBanner(html);
  assert.ok(banner, 'banner still renders without a client name');
  assert.ok(/Ready to send\?/.test(banner),
    'banner falls back to "Ready to send?" when client_name is empty');
  assert.ok(!/Ready to send to \?/.test(banner) && !/Ready to send to  \?/.test(banner),
    'banner must NOT emit "Ready to send to ?" when client_name is empty');
}

async function testBannerMoreOptionsLinksToShareSection() {
  const html = await renderView({
    invoice: makeInvoice({ status: 'draft' }),
    prefetchedShare: { url: 'https://decentinvoice.com/i/cafef00ddeadbeef',
      shareIntents: makeIntents(), followUpIntents: null }
  });
  const banner = sliceBanner(html);
  const more = findOpeningTag(banner, 'draft-send-banner-more');
  assert.ok(more, '"More share options" opening tag located');
  assert.ok(more.includes('href="#public-share-section"'),
    'banner has a "More share options" anchor pointing at #public-share-section');
  // And the existing public-share section must actually carry that id — a
  // contract that, if broken, would silently turn the anchor into a no-op.
  assert.ok(/id="public-share-section"/.test(html) && /data-testid="public-share-section"/.test(html),
    'the existing public-share-section div carries id="public-share-section" so the banner anchor scrolls there');
}

async function testBannerPrintHidden() {
  // Printed invoice PDFs shouldn't carry the "send now" CTA — the printed
  // artifact is the document, not the activation surface. Matches the
  // print:hidden convention used for the existing public-share-section
  // siblings.
  const html = await renderView({
    invoice: makeInvoice({ status: 'draft' }),
    prefetchedShare: { url: 'https://decentinvoice.com/i/cafef00ddeadbeef',
      shareIntents: makeIntents(), followUpIntents: null }
  });
  const banner = sliceBanner(html);
  assert.ok(/print:hidden/.test(banner),
    'banner carries print:hidden so it does NOT appear on printed/PDF invoice exports');
}

/*
 * Inline "Send a test to my inbox" affordance (Milestone 3 — first invoice
 * created → first invoice sent). The /email-self route already exists and
 * is reachable via the small "👀 Preview what your client gets" link, but a
 * brand-new freelancer hesitating on the very first send wants the
 * confidence-builder one tap away, not two clicks deep. The block surfaces
 * the test-send inline on the draft-send-banner for ALL plans (the route
 * itself is plan-agnostic), so the dominant pre-send anxiety beat closes
 * without nav.
 */
async function testBannerSelfTestRendersWithOwnerEmail() {
  const html = await renderView({
    invoice: makeInvoice({ status: 'draft' }),
    prefetchedShare: { url: 'https://decentinvoice.com/i/cafef00ddeadbeef',
      shareIntents: makeIntents(), followUpIntents: null }
  });
  const banner = sliceBanner(html);
  assert.ok(banner, 'banner present');
  assert.ok(/data-testid="draft-send-banner-self-test"/.test(banner),
    'inline self-test block renders when user.email is present');
  assert.ok(/data-testid="draft-send-banner-self-test-button"/.test(banner),
    'self-test button has stable testid');
  // Plan-agnostic — the renderView default is plan='free', so the assertion
  // above already proves free-plan visibility.
}

async function testBannerSelfTestPlanAgnostic() {
  for (const plan of ['free', 'trial', 'pro', 'agency']) {
    const html = await renderView({
      invoice: makeInvoice({ status: 'draft' }),
      prefetchedShare: { url: 'https://decentinvoice.com/i/cafef00ddeadbeef',
        shareIntents: makeIntents(), followUpIntents: null },
      userPlan: plan
    });
    const banner = sliceBanner(html);
    assert.ok(/data-testid="draft-send-banner-self-test-button"/.test(banner),
      'self-test button renders for plan=' + plan + ' (the underlying /email-self route is not plan-gated)');
  }
}

async function testBannerSelfTestHiddenWhenOwnerEmailMissing() {
  // Two failure modes: user.email = '' (signup oddity) and user.email = null.
  // Both must short-circuit the block — sending a test to nowhere is a
  // pointless surface that would also confuse the freelancer.
  for (const email of ['', null, undefined]) {
    const html = await renderView({
      invoice: makeInvoice({ status: 'draft' }),
      prefetchedShare: { url: 'https://decentinvoice.com/i/cafef00ddeadbeef',
        shareIntents: makeIntents(), followUpIntents: null },
      userOverrides: { email }
    });
    const banner = sliceBanner(html) || '';
    assert.ok(!/data-testid="draft-send-banner-self-test"/.test(banner),
      'self-test block must NOT render when user.email is ' + JSON.stringify(email));
  }
}

async function testBannerSelfTestNamesOwnerEmail() {
  const html = await renderView({
    invoice: makeInvoice({ status: 'draft' }),
    prefetchedShare: { url: 'https://decentinvoice.com/i/cafef00ddeadbeef',
      shareIntents: makeIntents(), followUpIntents: null },
    userOverrides: { email: 'pat@example.com' }
  });
  const banner = sliceBanner(html);
  assert.ok(/Send a test to pat@example\.com/.test(banner),
    'button label names the owner email so the freelancer knows exactly where the test lands');
  assert.ok(/Test sent &mdash; check pat@example\.com/.test(banner),
    'success-state copy also names the owner email');
}

async function testBannerSelfTestFiresEmailSelfWithCsrf() {
  const html = await renderView({
    invoice: makeInvoice({ id: 7, status: 'draft' }),
    prefetchedShare: { url: 'https://decentinvoice.com/i/cafef00ddeadbeef',
      shareIntents: makeIntents(), followUpIntents: null }
  });
  const banner = sliceBanner(html);
  // The x-data scope on the test-send wrapper carries the selfSendTest()
  // method. The fetch target must be POST /invoices/<id>/email-self with the
  // X-CSRF-Token header — anything else means the test send is broken.
  const block = (banner.match(/data-testid="draft-send-banner-self-test"[\s\S]{0,3000}/) || [''])[0];
  assert.ok(block.includes("/invoices/7/email-self"),
    'self-test fetch posts to /invoices/<id>/email-self');
  assert.ok(/method:\s*['"]POST['"]/.test(block),
    'self-test fetch uses POST');
  assert.ok(/X-CSRF-Token['"]?\s*:\s*['"]csrf-test-tkn['"]/.test(block),
    'self-test fetch threads the CSRF token header');
  assert.ok(/@click="selfSendTest\(\)"/.test(block),
    'button click handler invokes selfSendTest()');
  assert.ok(/x-bind:disabled="selfSending \|\| selfSent"/.test(block),
    'button disables on selfSending OR selfSent so a double-tap cannot fire two test sends');
}

async function testBannerSelfTestErrorMappings() {
  const html = await renderView({
    invoice: makeInvoice({ status: 'draft' }),
    prefetchedShare: { url: 'https://decentinvoice.com/i/cafef00ddeadbeef',
      shareIntents: makeIntents(), followUpIntents: null }
  });
  const banner = sliceBanner(html);
  const block = (banner.match(/data-testid="draft-send-banner-self-test"[\s\S]{0,3000}/) || [''])[0];
  assert.ok(/Email delivery is not configured/.test(block),
    'self-test maps the not_configured error reason to human-readable copy');
  assert.ok(/No email on file/.test(block),
    'self-test maps the no_owner_email error reason to actionable copy');
  assert.ok(/Could not send the test/.test(block),
    'self-test has a generic fallback copy for unknown error reasons');
  assert.ok(/data-testid="draft-send-banner-self-test-error"/.test(block),
    'error paragraph carries a stable testid');
}

async function testBannerSelfTestEscapesHostileOwnerEmail() {
  // user.email comes from signup input — a hostile or test-rig email like
  // `"><img src=x onerror=alert(1)>` must be HTML-entity-escaped on the
  // button label + success copy. EJS `<%= %>` escapes by default; this test
  // locks in the contract.
  const hostile = '"><img src=x onerror=alert(1)>@evil.example';
  const html = await renderView({
    invoice: makeInvoice({ status: 'draft' }),
    prefetchedShare: { url: 'https://decentinvoice.com/i/cafef00ddeadbeef',
      shareIntents: makeIntents(), followUpIntents: null },
    userOverrides: { email: hostile }
  });
  const banner = sliceBanner(html);
  assert.ok(banner, 'banner present');
  assert.ok(!banner.includes('<img src=x onerror=alert(1)>'),
    'hostile user.email must NOT render as a live <img> tag');
  assert.ok(banner.includes('&lt;img src=x onerror=alert(1)&gt;'),
    'hostile user.email must HTML-entity-escape into the button label');
}

async function testBannerSelfTestPositionedAboveFooter() {
  // Visual hierarchy contract: the test-send affordance lives BELOW the
  // primary channel buttons (WhatsApp/SMS/Email/Copy) but ABOVE the small
  // "👀 Preview / ↓ More share options" footer. This ensures the primary
  // CTAs win clicks while the test-send remains discoverable.
  const html = await renderView({
    invoice: makeInvoice({ status: 'draft' }),
    prefetchedShare: { url: 'https://decentinvoice.com/i/cafef00ddeadbeef',
      shareIntents: makeIntents(), followUpIntents: null }
  });
  const banner = sliceBanner(html);
  const idxWa = banner.indexOf('data-testid="draft-send-banner-whatsapp"');
  const idxSelf = banner.indexOf('data-testid="draft-send-banner-self-test"');
  const idxFooter = banner.indexOf('data-testid="draft-send-banner-preview-email"');
  assert.ok(idxWa > 0 && idxSelf > 0 && idxFooter > 0,
    'all three reference anchors are present in the banner');
  assert.ok(idxWa < idxSelf,
    'self-test block appears AFTER the WhatsApp primary CTA');
  assert.ok(idxSelf < idxFooter,
    'self-test block appears BEFORE the "Preview / More options" footer link');
}

async function run() {
  const tests = [
    ['banner renders on status=draft with prefetched share', testBannerRendersOnDraftWithPrefetchedShare],
    ['banner hidden on status=sent / paid / overdue', testBannerHiddenOnNonDraftStatuses],
    ['banner hidden when prefetchedShare missing', testBannerHiddenWhenPrefetchedShareMissing],
    ['banner hidden when shareIntents is null inside prefetchedShare', testBannerHiddenWhenIntentsMissing],
    ['WhatsApp / SMS / Email hrefs come from prefetchedShare intents', testBannerUsesPrefetchedHrefs],
    ['Copy button stamps share url + uses navigator.clipboard', testBannerCopyButtonCarriesShareUrl],
    ['Copy button hides when share url is empty', testBannerCopyButtonAbsentWhenUrlMissing],
    ['each button onclick posts to /share-intent with kind + csrf + keepalive', testBannerFiresShareIntentOnClick],
    ['each fetch is wrapped in try/catch + .catch swallow', testBannerOnclickWrappedInTryCatch],
    ['WhatsApp link opens in a new tab + rel=noopener', testBannerWhatsappTargetBlank],
    ['headline falls back gracefully without a client name', testBannerHeadlineWithoutClientName],
    ['"More options" link anchors to #public-share-section', testBannerMoreOptionsLinksToShareSection],
    ['banner is hidden on print', testBannerPrintHidden],
    ['inline self-test block renders with owner email', testBannerSelfTestRendersWithOwnerEmail],
    ['inline self-test button is plan-agnostic (free/trial/pro/agency)', testBannerSelfTestPlanAgnostic],
    ['inline self-test block is hidden when user.email is missing', testBannerSelfTestHiddenWhenOwnerEmailMissing],
    ['inline self-test label + success copy name the owner email', testBannerSelfTestNamesOwnerEmail],
    ['inline self-test fires POST /:id/email-self with CSRF + selfSendTest()', testBannerSelfTestFiresEmailSelfWithCsrf],
    ['inline self-test error copy maps not_configured / no_owner_email / fallback', testBannerSelfTestErrorMappings],
    ['inline self-test HTML-escapes hostile owner email', testBannerSelfTestEscapesHostileOwnerEmail],
    ['inline self-test sits below WhatsApp CTA and above "Preview / More options" footer', testBannerSelfTestPositionedAboveFooter]
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
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
