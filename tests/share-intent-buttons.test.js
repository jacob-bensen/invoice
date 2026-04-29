'use strict';

/*
 * Tests for #92 — WhatsApp / SMS / Email share-intent buttons on the
 * invoice-view Payment Link card.
 *
 * The buttons open the user's native compose flow with a prefilled message
 * containing the Stripe Payment Link URL. No backend logic is involved —
 * these are pure anchor tags with `wa.me/?text=...`, `sms:?body=...`, and
 * `mailto:?subject=...&body=...` hrefs. The tests assert:
 *
 *   - All three anchors render for a Pro user with a payment link.
 *   - The hrefs use the correct scheme/host and the URL is encoded into the
 *     `text` / `body` query param (so the native handler sees one parameter
 *     value, not a partially-decoded string).
 *   - The mailto link populates the recipient when client_email is set.
 *   - The mailto link omits the recipient when client_email is empty.
 *   - The buttons are NOT rendered for free users (no payment link → no card).
 *   - The share message contains the invoice number and total (so the client
 *     receives a self-describing message even before opening the link).
 *   - HTML special characters in client_name are escaped (XSS defence on the
 *     visible label text — separate from URL-encoding which protects the href).
 *   - The new "Send to client" section header is rendered exactly once.
 *
 * Run: node tests/share-intent-buttons.test.js
 */

const assert = require('assert');
const path = require('path');
const ejs = require('ejs');

const TPL = path.join(__dirname, '..', 'views', 'invoice-view.ejs');
const VIEWS = { views: [path.join(__dirname, '..', 'views')] };

function baseInvoice(overrides = {}) {
  return Object.assign({
    id: 100,
    invoice_number: 'INV-2026-0100',
    client_name: 'Acme Corp',
    client_email: 'ap@acme.test',
    client_address: '',
    items: [],
    subtotal: '500.00',
    tax_rate: '0',
    tax_amount: '0',
    total: '500.00',
    status: 'sent',
    issued_date: '2026-04-25',
    due_date: '2026-05-25',
    notes: '',
    payment_link_url: 'https://buy.stripe.com/test_share_100',
    payment_link_id: 'plink_share_100'
  }, overrides);
}

function baseUser(plan = 'pro') {
  return { id: 1, plan, name: 'Owner', email: 'owner@x.com' };
}

async function render(invoice, user) {
  return ejs.renderFile(TPL, {
    title: 't', invoice, user, flash: null, paymentMethods: ['card']
  }, VIEWS);
}

// ---------------------------------------------------------------------------

async function testAllThreeShareButtonsRender() {
  const html = await render(baseInvoice(), baseUser('pro'));
  assert.ok(html.includes('data-share="whatsapp"'),
    'WhatsApp share anchor must render (data-share="whatsapp")');
  assert.ok(html.includes('data-share="sms"'),
    'SMS share anchor must render (data-share="sms")');
  assert.ok(html.includes('data-share="email"'),
    'Email share anchor must render (data-share="email")');
  // Visible labels for screen readers and sighted users.
  assert.ok(html.includes('>WhatsApp<'), 'WhatsApp button has visible label');
  assert.ok(html.includes('>SMS<'), 'SMS button has visible label');
  assert.ok(html.includes('>Email<'), 'Email button has visible label');
}

async function testWhatsAppHrefUsesWaMeScheme() {
  const html = await render(baseInvoice(), baseUser('pro'));
  // wa.me is the canonical universal share host (works on web + iOS + Android).
  const match = html.match(/href="(https:\/\/wa\.me\/\?text=[^"]+)"/);
  assert.ok(match, 'WhatsApp href must use https://wa.me/?text=...');
  const decoded = decodeURIComponent(match[1].split('text=')[1]);
  assert.ok(decoded.includes('https://buy.stripe.com/test_share_100'),
    'WhatsApp message must include the payment link URL after decode');
  assert.ok(decoded.includes('INV-2026-0100'),
    'WhatsApp message must include the invoice number');
  assert.ok(decoded.includes('$500.00'),
    'WhatsApp message must include the formatted total');
}

async function testSmsHrefUsesSmsScheme() {
  const html = await render(baseInvoice(), baseUser('pro'));
  // sms: scheme with `body` param per RFC 5724 — works on iOS Messages and
  // Android default SMS apps. Some Android handlers prefer `&body=` (with a
  // leading address separator) — we use `sms:?&body=...` which is tolerated
  // by both and never opens a thread to a wrong recipient.
  const match = html.match(/href="(sms:[^"]+)"/);
  assert.ok(match, 'SMS href must use sms: scheme');
  assert.ok(match[1].includes('body='), 'SMS href must carry a body param');
  const decoded = decodeURIComponent(match[1].split('body=')[1]);
  assert.ok(decoded.includes('https://buy.stripe.com/test_share_100'),
    'SMS body must include the payment link URL after decode');
}

async function testMailtoHrefIncludesRecipientAndSubject() {
  const html = await render(baseInvoice(), baseUser('pro'));
  const match = html.match(/href="(mailto:[^"]+)"/);
  assert.ok(match, 'mailto href must render');
  const href = match[1];
  // Recipient is percent-encoded as defence-in-depth against `?`/`&` injection
  // in malformed client_email values — `@` becomes `%40`. Modern mail clients
  // (Mail.app, Gmail web, Outlook web, Thunderbird) all un-encode this
  // correctly; the encoding closes a class of bug where a hostile email
  // address could inject extra `?cc=` or `?to=` query params.
  const recipientPart = href.slice('mailto:'.length).split('?')[0];
  const recipientDecoded = decodeURIComponent(recipientPart);
  assert.strictEqual(recipientDecoded, 'ap@acme.test',
    'mailto: recipient (after percent-decode) must equal the client_email; got encoded: ' + recipientPart);
  assert.ok(href.includes('subject='), 'mailto must carry a subject param');
  assert.ok(href.includes('body='), 'mailto must carry a body param');
  // Decode and check the subject contains the invoice number + total.
  const subjectEncoded = href.match(/subject=([^&]+)/)[1];
  const subject = decodeURIComponent(subjectEncoded);
  assert.ok(subject.includes('INV-2026-0100'),
    'mailto subject must include the invoice number; got: ' + subject);
  assert.ok(subject.includes('$500.00'),
    'mailto subject must include the formatted total; got: ' + subject);
}

async function testMailtoOmitsRecipientWhenClientEmailEmpty() {
  const html = await render(
    baseInvoice({ client_email: '' }),
    baseUser('pro')
  );
  const match = html.match(/href="(mailto:[^"]+)"/);
  assert.ok(match, 'mailto href must still render even without client_email');
  // mailto:?subject=... is the canonical "let the user pick the recipient"
  // form; the trailing ? must come immediately after the colon.
  assert.ok(match[1].startsWith('mailto:?'),
    'mailto must render as `mailto:?subject=...` when client_email is empty; got ' + match[1]);
}

async function testFreeUserSeesNoShareButtons() {
  // Free users don't get a payment_link_url, so the entire Payment Link card
  // (which now contains the share buttons) must not render.
  const html = await render(
    baseInvoice({ payment_link_url: null, payment_link_id: null }),
    baseUser('free')
  );
  assert.ok(!html.includes('data-share="whatsapp"'),
    'WhatsApp share must NOT render for free users');
  assert.ok(!html.includes('data-share="sms"'),
    'SMS share must NOT render for free users');
  assert.ok(!html.includes('data-share="email"'),
    'Email share must NOT render for free users');
  assert.ok(!html.includes('Send to client'),
    'Share section header must NOT render for free users');
}

async function testShareMessageIncludesGreetingFromClientName() {
  const html = await render(baseInvoice({ client_name: 'Beta Inc' }), baseUser('pro'));
  // Pull the WhatsApp text and decode — easier to assert on than navigating
  // through HTML attribute escaping for the visible label.
  const match = html.match(/href="(https:\/\/wa\.me\/\?text=[^"]+)"/);
  assert.ok(match, 'WhatsApp href present');
  const decoded = decodeURIComponent(match[1].split('text=')[1]);
  assert.ok(decoded.startsWith('Hi Beta Inc,'),
    'Share message must open with "Hi <client_name>," for personalisation; got: ' + decoded.slice(0, 30));
}

async function testShareMessageFallsBackWhenClientNameEmpty() {
  const html = await render(baseInvoice({ client_name: '' }), baseUser('pro'));
  const match = html.match(/href="(https:\/\/wa\.me\/\?text=[^"]+)"/);
  assert.ok(match, 'WhatsApp href present even with empty client_name');
  const decoded = decodeURIComponent(match[1].split('text=')[1]);
  // No client name → generic "Hi," — never an empty greeting like "Hi ,".
  assert.ok(decoded.startsWith('Hi,'),
    'Share message must fall back to "Hi," when client_name is empty; got: ' + decoded.slice(0, 30));
  assert.ok(!decoded.startsWith('Hi ,'),
    'Share message must NOT produce dangling "Hi ," when client_name is empty');
}

async function testShareUrlEncodesSpecialChars() {
  // A client_name with spaces, commas, and an apostrophe — common real-world
  // content (e.g. "O'Brien & Sons, Inc"). The href value must travel through
  // two decoders in the browser: HTML attribute decoding (entity refs like
  // `&#39;` → `'`, `&amp;` → `&`) followed by URL decoding by the OS handler.
  // Both must round-trip back to the original JS string.
  const html = await render(
    baseInvoice({ client_name: "O'Brien & Sons, Inc" }),
    baseUser('pro')
  );
  const match = html.match(/href="(https:\/\/wa\.me\/\?text=[^"]+)"/);
  assert.ok(match, 'WhatsApp href present');
  const enc = match[1].split('text=')[1];
  // The encoded form must NOT carry a literal space — that would truncate the
  // message at the first space when the OS handler parses the URL.
  assert.ok(!/\s/.test(enc),
    'Encoded share text must not contain literal spaces; got: ' + enc);
  // Two-step decode roundtrip: HTML entities first, then URL encoding.
  const htmlDecoded = enc
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  const decoded = decodeURIComponent(htmlDecoded);
  assert.ok(decoded.includes("O'Brien & Sons, Inc"),
    'Two-step decode (HTML entity → URL) must recover apostrophe + ampersand + comma; got: ' + decoded);
}

async function testShareSectionHeaderRendersOnce() {
  const html = await render(baseInvoice(), baseUser('pro'));
  const occurrences = html.split('Send to client').length - 1;
  assert.strictEqual(occurrences, 1,
    'The "Send to client" section header must render exactly once; got ' + occurrences);
}

async function testShareLinksHaveSafeRelOnExternal() {
  const html = await render(baseInvoice(), baseUser('pro'));
  // WhatsApp opens in a new tab so it must carry rel="noopener" to prevent
  // the popup from accessing window.opener. SMS + mailto stay in-context, so
  // they don't need it.
  const wa = html.match(/<a href="https:\/\/wa\.me[^>]*>/);
  assert.ok(wa, 'WhatsApp anchor present');
  assert.ok(/target="_blank"/.test(wa[0]),
    'WhatsApp anchor must open in a new tab (target="_blank")');
  assert.ok(/rel="[^"]*noopener/.test(wa[0]),
    'WhatsApp anchor must carry rel="noopener"; got: ' + wa[0]);
}

async function testMailtoRecipientIsPercentEncodedAgainstInjection() {
  // Defence-in-depth: a hostile client_email containing `?` or `&` must not
  // produce a mailto: with extra query parameters that would let an attacker
  // silently CC themselves on every share-by-email click. The view percent-
  // encodes the recipient so `?` / `&` collapse to `%3F` / `%26` and never
  // reach the URL parser as separators.
  const html = await render(
    baseInvoice({ client_email: 'foo@bar.com?cc=attacker@evil.com' }),
    baseUser('pro')
  );
  const match = html.match(/href="(mailto:[^"]+)"/);
  assert.ok(match, 'mailto href must render even with malformed client_email');
  const href = match[1];
  // Find the boundary between the recipient and the first legitimate `?`.
  // That `?` must come AFTER the encoded `?` in the email — i.e. the
  // recipient portion has no literal `?` or `&` before the subject param.
  const firstQuestionMark = href.indexOf('?');
  const recipientPart = href.slice('mailto:'.length, firstQuestionMark);
  assert.ok(!recipientPart.includes('@'),
    'recipient must be percent-encoded — `@` should appear as `%40`, not literal `@`');
  assert.ok(!recipientPart.includes('?'),
    'recipient must not contain a literal `?` (injection vector); got: ' + recipientPart);
  assert.ok(!recipientPart.includes('&'),
    'recipient must not contain a literal `&` (injection vector); got: ' + recipientPart);
  // After the first legitimate `?`, the only param keys allowed are
  // `subject` and `body`. An injected `cc=` or `to=` would mean encoding
  // failed. Note: EJS HTML-escapes the `&` separator to `&amp;` in the
  // attribute source — the browser un-escapes back to `&` before handing
  // to the URL parser. We do the same here, then ALSO collapse `&#39;`
  // (apostrophe) and other entities back to their literals before counting
  // separators (the body contains "here's" which would otherwise show up
  // as a phantom `#39;...` "key").
  const queryStringHtmlDecoded = href.slice(firstQuestionMark + 1)
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
  // Split on `&` AND filter out the apostrophe-fragment bits — anything not
  // matching `^[a-z]+=` is a continuation of the previous param's value, not
  // a real key.
  const params = queryStringHtmlDecoded.split('&')
    .map(p => p.split('=')[0])
    .filter(k => /^[a-z][a-z0-9_]*$/i.test(k));
  for (const key of params) {
    assert.ok(['subject', 'body'].includes(key),
      'mailto query string must only carry subject/body params; got injected key: ' + key);
  }
}

async function testNotesSectionStillRendersAfterShareSection() {
  // Defensive layout test: the share buttons block must not break the Notes
  // block that comes after it. Notes are user-controlled text — if the EJS
  // template structure was accidentally damaged, Notes rendering would be
  // the first thing to disappear.
  const html = await render(
    baseInvoice({ notes: 'Net 30; pay by credit card or ACH.' }),
    baseUser('pro')
  );
  assert.ok(html.includes('Net 30; pay by credit card or ACH.'),
    'Notes section must still render after the share-buttons block');
}

// ---------------------------------------------------------------------------

async function run() {
  const tests = [
    ['All three share buttons render for Pro user', testAllThreeShareButtonsRender],
    ['WhatsApp href uses wa.me/?text= scheme', testWhatsAppHrefUsesWaMeScheme],
    ['SMS href uses sms: scheme with body param', testSmsHrefUsesSmsScheme],
    ['mailto href includes client recipient + subject', testMailtoHrefIncludesRecipientAndSubject],
    ['mailto omits recipient when client_email empty', testMailtoOmitsRecipientWhenClientEmailEmpty],
    ['Free user sees no share buttons (no payment-link card)', testFreeUserSeesNoShareButtons],
    ['Share message opens with "Hi <client_name>,"', testShareMessageIncludesGreetingFromClientName],
    ['Share message falls back to "Hi," when client_name empty', testShareMessageFallsBackWhenClientNameEmpty],
    ['Share URL encodes apostrophe / ampersand / comma / spaces', testShareUrlEncodesSpecialChars],
    ['"Send to client" section header renders exactly once', testShareSectionHeaderRendersOnce],
    ['WhatsApp anchor carries target="_blank" + rel="noopener"', testShareLinksHaveSafeRelOnExternal],
    ['mailto recipient is percent-encoded (no injection of cc=/to= via malformed email)', testMailtoRecipientIsPercentEncodedAgainstInjection],
    ['Notes section still renders after share block', testNotesSectionStillRendersAfterShareSection]
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
