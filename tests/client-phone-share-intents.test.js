'use strict';

/*
 * Client-phone share-intent tests (Milestone 3 — first invoice created →
 * first invoice sent).
 *
 * Before this feature: the SMS / WhatsApp share-intent URLs emitted by
 * lib/share-link.buildPublicShareIntents and buildFollowUpShareIntents had no
 * recipient — `sms:?&body=...` and `https://wa.me/?text=...`. After tapping
 * "Create & open SMS" on /invoices/quick the freelancer landed in Messages /
 * WhatsApp on the contact picker, having to hand-pick the client every time.
 *
 * Now: when an invoice carries a normalised `client_phone`, the URLs become
 *   sms:+15551234567?&body=...
 *   https://wa.me/15551234567?text=...
 * — one tap from the form to a fully-addressed pre-filled message. The phone
 * is captured on /invoices/quick (optional field) and persisted to
 * invoices.client_phone; subsequent invoices to the same client get the same
 * one-tap behaviour via the recent-clients quick-pick.
 *
 * Layers:
 *   - Layer 1 — lib/phone.normalizeClientPhone:
 *       happy paths (E.164 + bare digits + punctuated formats),
 *       reject too-short / too-long / non-digits-only,
 *       null / empty / non-string inputs collapse to null.
 *   - Layer 2 — lib/share-link.buildPublicShareIntents with clientPhone:
 *       sms: URL embeds normalised phone before `?&body=`,
 *       wa.me URL embeds phone WITHOUT a leading "+",
 *       mailto is unchanged (phone never leaks into the email path),
 *       missing phone falls back to current shape (recipient slot empty).
 *   - Layer 3 — lib/share-link.buildFollowUpShareIntents with clientPhone:
 *       same shape (one-tap reminder is the dominant repeat-client surface).
 *   - Layer 4 — lib/share-link.buildShareSurfaceForInvoice:
 *       invoice.client_phone is threaded through to both shareIntents and
 *       followUpIntents — no double-plumbing required at every callsite.
 *   - Layer 5 — defence in depth:
 *       a hostile / malformed client_phone never leaks anything past digits
 *       + a single leading "+" into the emitted URL (no spaces, no script,
 *       no scheme tampering).
 *   - Layer 6 — view: /invoices/quick renders the client-phone input with
 *       the documented testids + name="client_phone" attribute, and the
 *       autosave x-data shape carries `client_phone` in `fields`.
 *
 * Run: NODE_ENV=test node tests/client-phone-share-intents.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

const VIEWS = path.join(__dirname, '..', 'views');

// ============================================================================
// Layer 1 — lib/phone.normalizeClientPhone
// ============================================================================

function testNormalizeAcceptsE164() {
  delete require.cache[require.resolve('../lib/phone')];
  const { normalizeClientPhone } = require('../lib/phone');
  assert.strictEqual(normalizeClientPhone('+15551234567'), '+15551234567',
    'E.164 plus-prefixed digits pass through verbatim');
  assert.strictEqual(normalizeClientPhone('+1 (555) 123-4567'), '+15551234567',
    'punctuated E.164 strips parens/dashes/spaces while keeping the +');
  assert.strictEqual(normalizeClientPhone('+44 20 7946 0958'), '+442079460958',
    'international number is preserved with country code');
}

function testNormalizeAcceptsBareDigits() {
  delete require.cache[require.resolve('../lib/phone')];
  const { normalizeClientPhone } = require('../lib/phone');
  assert.strictEqual(normalizeClientPhone('5551234567'), '5551234567',
    'bare 10-digit number passes through');
  assert.strictEqual(normalizeClientPhone('(555) 123-4567'), '5551234567',
    'punctuated bare number strips formatting');
  assert.strictEqual(normalizeClientPhone('555.123.4567'), '5551234567',
    'dot-separated bare number strips formatting');
}

function testNormalizeRejectsTooShort() {
  delete require.cache[require.resolve('../lib/phone')];
  const { normalizeClientPhone } = require('../lib/phone');
  assert.strictEqual(normalizeClientPhone('12345'), null,
    'fewer than 7 digits rejected — not a real phone');
  assert.strictEqual(normalizeClientPhone('+1'), null,
    'lonely country code rejected');
}

function testNormalizeRejectsTooLong() {
  delete require.cache[require.resolve('../lib/phone')];
  const { normalizeClientPhone } = require('../lib/phone');
  assert.strictEqual(normalizeClientPhone('+1234567890123456'), null,
    'more than 15 digits exceeds E.164 spec — rejected');
}

function testNormalizeRejectsEmptyAndNonStrings() {
  delete require.cache[require.resolve('../lib/phone')];
  const { normalizeClientPhone } = require('../lib/phone');
  assert.strictEqual(normalizeClientPhone(''), null);
  assert.strictEqual(normalizeClientPhone('   '), null,
    'whitespace-only is treated as empty');
  assert.strictEqual(normalizeClientPhone(null), null);
  assert.strictEqual(normalizeClientPhone(undefined), null);
  assert.strictEqual(normalizeClientPhone({}), null,
    'objects coerced to "[object Object]" → no digits → null');
}

function testNormalizeStripsLetters() {
  delete require.cache[require.resolve('../lib/phone')];
  const { normalizeClientPhone } = require('../lib/phone');
  // "1-800-FLOWERS" — the letters are stripped, leaving "1-800-" → "1800"
  // which is 4 digits → rejected as too short. This is the right behaviour:
  // we don't want to silently convert vanity numbers since the share-intent
  // SMS URL would dial the wrong number.
  assert.strictEqual(normalizeClientPhone('1-800-FLOWERS'), null,
    'vanity number rejected — letters stripped to too-short digit string');
}

// ============================================================================
// Layer 2 — buildPublicShareIntents with clientPhone
// ============================================================================

function testShareIntentsEmbedsPhoneInSms() {
  delete require.cache[require.resolve('../lib/share-link')];
  delete require.cache[require.resolve('../lib/phone')];
  const { buildPublicShareIntents } = require('../lib/share-link');
  const out = buildPublicShareIntents({
    invoiceNumber: 'INV-2026-0042',
    total: 1500,
    clientName: 'Acme Co',
    clientEmail: 'pay@acme.example',
    clientPhone: '+1 (555) 123-4567',
    url: 'https://decentinvoice.com/i/cafef00ddeadbeef'
  });
  // E.164 form survives into the sms: URL with the leading "+"
  assert.ok(out.sms.startsWith('sms:+15551234567?&body='),
    `sms: must embed normalised phone before body; got "${out.sms}"`);
  // The body is still percent-encoded after the recipient
  assert.ok(out.sms.includes('body=Hi%20Acme%20Co'),
    `sms body must remain percent-encoded after the phone insertion; got "${out.sms}"`);
}

function testShareIntentsEmbedsPhoneInWhatsApp() {
  delete require.cache[require.resolve('../lib/share-link')];
  delete require.cache[require.resolve('../lib/phone')];
  const { buildPublicShareIntents } = require('../lib/share-link');
  const out = buildPublicShareIntents({
    invoiceNumber: 'INV-1',
    total: 100,
    clientName: 'Acme',
    clientPhone: '+15551234567',
    url: 'https://decentinvoice.com/i/cafef00ddeadbeef'
  });
  // wa.me requires digits only — no leading "+" — even though the stored
  // phone keeps the "+" for SMS.
  assert.ok(out.whatsapp.startsWith('https://wa.me/15551234567?text='),
    `wa.me must strip the leading "+" from the path segment; got "${out.whatsapp}"`);
  assert.ok(!out.whatsapp.includes('wa.me/+'),
    'wa.me must never contain a literal "+" in the path — WhatsApp rejects those URLs');
}

function testShareIntentsMailtoUnchangedByPhone() {
  delete require.cache[require.resolve('../lib/share-link')];
  delete require.cache[require.resolve('../lib/phone')];
  const { buildPublicShareIntents } = require('../lib/share-link');
  const out = buildPublicShareIntents({
    invoiceNumber: 'INV-1',
    total: 100,
    clientEmail: 'pay@acme.example',
    clientPhone: '+15551234567',
    url: 'https://decentinvoice.com/i/cafef00ddeadbeef'
  });
  // mailto recipient is still the email — phone must never leak into the
  // mailto path or any of its query params.
  assert.ok(out.mailto.startsWith('mailto:pay%40acme.example?subject='),
    `mailto recipient is the client_email, not the phone; got "${out.mailto}"`);
  assert.ok(!out.mailto.includes('5551234567'),
    'mailto must never embed the phone — phone is for SMS / WhatsApp only');
}

function testShareIntentsFallbackWhenNoPhone() {
  delete require.cache[require.resolve('../lib/share-link')];
  delete require.cache[require.resolve('../lib/phone')];
  const { buildPublicShareIntents } = require('../lib/share-link');
  const out = buildPublicShareIntents({
    invoiceNumber: 'INV-1',
    total: 100,
    clientName: 'Acme',
    url: 'https://decentinvoice.com/i/cafef00ddeadbeef'
  });
  // Backward compatibility: legacy invoices (no phone) keep the pickerless
  // recipient slot — every existing test that asserts the old shape stays
  // green.
  assert.ok(out.sms.startsWith('sms:?&body='),
    `no-phone sms: must keep the current "sms:?&body=" shape; got "${out.sms}"`);
  assert.ok(out.whatsapp.startsWith('https://wa.me/?text='),
    `no-phone wa.me must keep the current "wa.me/?text=" shape; got "${out.whatsapp}"`);
}

function testShareIntentsFallbackOnInvalidPhone() {
  delete require.cache[require.resolve('../lib/share-link')];
  delete require.cache[require.resolve('../lib/phone')];
  const { buildPublicShareIntents } = require('../lib/share-link');
  const out = buildPublicShareIntents({
    invoiceNumber: 'INV-1',
    total: 100,
    clientPhone: '12345', // too short — normalised to null
    url: 'https://decentinvoice.com/i/cafef00ddeadbeef'
  });
  // A malformed stored phone must not produce a broken `sms:12345?…` link;
  // it falls back to the pickerless URL silently.
  assert.ok(out.sms.startsWith('sms:?&body='),
    `invalid phone falls back to pickerless sms:; got "${out.sms}"`);
  assert.ok(out.whatsapp.startsWith('https://wa.me/?text='),
    `invalid phone falls back to pickerless wa.me; got "${out.whatsapp}"`);
}

// ============================================================================
// Layer 3 — buildFollowUpShareIntents with clientPhone
// ============================================================================

function testFollowUpShareIntentsEmbedsPhone() {
  delete require.cache[require.resolve('../lib/share-link')];
  delete require.cache[require.resolve('../lib/phone')];
  const { buildFollowUpShareIntents } = require('../lib/share-link');
  const out = buildFollowUpShareIntents({
    invoiceNumber: 'INV-2026-0042',
    total: 500,
    clientName: 'Acme',
    clientPhone: '+15551234567',
    url: 'https://decentinvoice.com/i/cafef00ddeadbeef',
    daysOverdue: 3
  });
  assert.ok(out.sms.startsWith('sms:+15551234567?&body='),
    `follow-up sms: embeds normalised phone; got "${out.sms}"`);
  assert.ok(out.whatsapp.startsWith('https://wa.me/15551234567?text='),
    `follow-up wa.me embeds digits-only phone; got "${out.whatsapp}"`);
  // Body framing is still the follow-up "checking in" copy, not first-send
  assert.ok(out.body.includes('just checking in'),
    'follow-up body keeps the "just checking in" framing after the phone change');
}

function testFollowUpShareIntentsFallbackWhenNoPhone() {
  delete require.cache[require.resolve('../lib/share-link')];
  delete require.cache[require.resolve('../lib/phone')];
  const { buildFollowUpShareIntents } = require('../lib/share-link');
  const out = buildFollowUpShareIntents({
    invoiceNumber: 'INV-1',
    total: 100,
    clientName: 'Acme',
    url: 'https://decentinvoice.com/i/cafef00ddeadbeef'
  });
  assert.ok(out.sms.startsWith('sms:?&body='),
    'follow-up sms: keeps legacy pickerless shape when no phone');
  assert.ok(out.whatsapp.startsWith('https://wa.me/?text='),
    'follow-up wa.me keeps legacy pickerless shape when no phone');
}

// ============================================================================
// Layer 4 — buildShareSurfaceForInvoice threads invoice.client_phone
// ============================================================================

function testShareSurfaceThreadsInvoicePhone() {
  delete require.cache[require.resolve('../lib/share-link')];
  delete require.cache[require.resolve('../lib/phone')];
  const { buildShareSurfaceForInvoice } = require('../lib/share-link');
  process.env.APP_URL = 'https://decentinvoice.example';
  const surface = buildShareSurfaceForInvoice({
    id: 1,
    invoice_number: 'INV-2026-0001',
    client_name: 'Acme',
    client_email: 'pay@acme.example',
    client_phone: '+15551234567',
    total: 500,
    due_date: '2026-06-30',
    public_token: 'cafef00ddeadbeef'
  }, { now: new Date('2026-05-30T00:00:00Z') });
  assert.ok(surface, 'returns a populated surface for an invoice with a token');
  assert.ok(surface.shareIntents.sms.startsWith('sms:+15551234567?&body='),
    `shareIntents.sms threads invoice.client_phone; got "${surface.shareIntents.sms}"`);
  assert.ok(surface.shareIntents.whatsapp.startsWith('https://wa.me/15551234567?text='),
    `shareIntents.whatsapp threads invoice.client_phone; got "${surface.shareIntents.whatsapp}"`);
  assert.ok(surface.followUpIntents.sms.startsWith('sms:+15551234567?&body='),
    `followUpIntents.sms threads invoice.client_phone; got "${surface.followUpIntents.sms}"`);
  assert.ok(surface.followUpIntents.whatsapp.startsWith('https://wa.me/15551234567?text='),
    `followUpIntents.whatsapp threads invoice.client_phone; got "${surface.followUpIntents.whatsapp}"`);
}

function testShareSurfaceLegacyInvoiceWithoutPhone() {
  delete require.cache[require.resolve('../lib/share-link')];
  delete require.cache[require.resolve('../lib/phone')];
  const { buildShareSurfaceForInvoice } = require('../lib/share-link');
  process.env.APP_URL = 'https://decentinvoice.example';
  const surface = buildShareSurfaceForInvoice({
    id: 1,
    invoice_number: 'INV-LEGACY-0001',
    client_name: 'Acme',
    client_email: 'pay@acme.example',
    total: 500,
    due_date: '2026-06-30',
    public_token: 'cafef00ddeadbeef'
    // client_phone undefined — pre-migration row
  });
  assert.ok(surface.shareIntents.sms.startsWith('sms:?&body='),
    'legacy invoice (no client_phone) still produces the pickerless sms: URL — backward compat');
  assert.ok(surface.shareIntents.whatsapp.startsWith('https://wa.me/?text='),
    'legacy invoice (no client_phone) still produces the pickerless wa.me URL — backward compat');
}

// ============================================================================
// Layer 5 — defence in depth
// ============================================================================

function testHostilePhoneCannotInjectIntoUrl() {
  delete require.cache[require.resolve('../lib/share-link')];
  delete require.cache[require.resolve('../lib/phone')];
  const { buildPublicShareIntents } = require('../lib/share-link');
  // A hostile DB row with a stuffed phone: control chars, scheme, query
  // params, a script tag. normalizeClientPhone strips everything but digits
  // and a single leading "+", so none of this can land in the URL.
  const hostile = '+1<script>alert(1)</script>5551234567?cc=evil@x.com';
  const out = buildPublicShareIntents({
    invoiceNumber: 'INV-1',
    total: 100,
    clientPhone: hostile,
    url: 'https://decentinvoice.com/i/cafef00ddeadbeef'
  });
  assert.ok(!out.sms.includes('<script>'),
    `sms: must not embed a raw <script> from a hostile phone; got "${out.sms}"`);
  assert.ok(!out.sms.includes('cc=evil'),
    `sms: must not embed cc= query injection from a hostile phone; got "${out.sms}"`);
  assert.ok(!out.whatsapp.includes('<script>'),
    `wa.me must not embed a raw <script> from a hostile phone; got "${out.whatsapp}"`);
  // The digits are kept, the rest is dropped — the URL is `sms:+115551234567?&body=…`
  // (the "1" from "+1" + the digits embedded in the injection).
  const smsRecipient = out.sms.slice('sms:'.length).split('?')[0];
  assert.ok(/^\+?\d+$/.test(smsRecipient),
    `sms recipient slot must contain ONLY digits and optional "+"; got "${smsRecipient}"`);
}

// ============================================================================
// Layer 6 — view: /invoices/quick renders the client_phone input
// ============================================================================

function testInvoiceQuickRendersClientPhoneInput() {
  const tpl = fs.readFileSync(path.join(VIEWS, 'invoice-quick.ejs'), 'utf8');
  // The render path bottoms out at a template render — easier to assert on
  // the raw template since the EJS substitutions for our targets are static.
  assert.ok(tpl.includes('name="client_phone"'),
    'template renders an input with name="client_phone" so POST /quick receives it');
  assert.ok(tpl.includes('data-testid="invoice-quick-client-phone-input"'),
    'template carries the stable test id for the phone input');
  assert.ok(tpl.includes('data-testid="invoice-quick-client-phone-block"'),
    'template wraps the phone input in a testable block');
  assert.ok(tpl.includes("inputmode=\"tel\""),
    'phone input has inputmode="tel" so mobile keyboards open the phone keypad');
  // Autosave x-data shape carries the phone in `fields` and the helper
  // posts it on every debounced keystroke.
  assert.ok(/fields:[\s\S]*client_phone:/.test(tpl),
    'autosave x-data fields object includes client_phone');
  assert.ok(/body:[\s\S]*client_phone:/.test(tpl),
    'autosave POST body includes client_phone');
  // Recent-clients pick fills the phone field too — repeat-client flow.
  assert.ok(/this\.fields\.client_phone\s*=\s*c\.client_phone\s*\|\|\s*''/.test(tpl),
    'fillFromRecent() pre-fills the phone field from the picked recent client');
}

// ============================================================================
// Runner
// ============================================================================

(async () => {
  const tests = [
    ['phone: normalize E.164 inputs', testNormalizeAcceptsE164],
    ['phone: normalize bare-digit inputs', testNormalizeAcceptsBareDigits],
    ['phone: reject too-short digits', testNormalizeRejectsTooShort],
    ['phone: reject too-long digits', testNormalizeRejectsTooLong],
    ['phone: reject empty / non-string inputs', testNormalizeRejectsEmptyAndNonStrings],
    ['phone: reject vanity-number letter inputs', testNormalizeStripsLetters],
    ['share-link: sms URL embeds normalised phone', testShareIntentsEmbedsPhoneInSms],
    ['share-link: wa.me URL embeds digits-only phone', testShareIntentsEmbedsPhoneInWhatsApp],
    ['share-link: mailto unaffected by phone (no leak)', testShareIntentsMailtoUnchangedByPhone],
    ['share-link: no phone → legacy sms:/wa.me shape preserved', testShareIntentsFallbackWhenNoPhone],
    ['share-link: invalid phone → legacy fallback', testShareIntentsFallbackOnInvalidPhone],
    ['share-link follow-up: embeds phone in sms + wa.me', testFollowUpShareIntentsEmbedsPhone],
    ['share-link follow-up: no phone → legacy fallback', testFollowUpShareIntentsFallbackWhenNoPhone],
    ['share-link surface: threads invoice.client_phone through both intent sets', testShareSurfaceThreadsInvoicePhone],
    ['share-link surface: legacy invoice (no phone) preserves pickerless URLs', testShareSurfaceLegacyInvoiceWithoutPhone],
    ['defence: hostile client_phone cannot inject into URL', testHostilePhoneCannotInjectIntoUrl],
    ['view: /invoices/quick renders client_phone input + autosave plumbing', testInvoiceQuickRendersClientPhoneInput]
  ];

  let pass = 0;
  let fail = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      pass += 1;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      fail += 1;
      console.error(`  ✗ ${name}`);
      console.error('    ', err && err.message ? err.message : err);
    }
  }
  console.log(`\nclient-phone-share-intents: ${pass}/${pass + fail} passed`);
  if (fail > 0) process.exit(1);
})();
