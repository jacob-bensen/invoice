'use strict';

/*
 * BCC-self on outbound client invoice emails (Milestone 3 — first invoice
 * created → first invoice sent). When a user enables
 * "Send me a copy of every invoice I email" in /billing/settings, every
 * sendInvoiceEmail() delivery (POST /invoices/:id/email-client, POST
 * /invoices/quick action=create_and_email, POST /invoices/new
 * action=create_and_email, and the draft→sent silent send on POST
 * /invoices/:id/status=sent) also delivers a silent BCC to the
 * freelancer's own users.email. Two activation levers:
 *   - Pre-send anxiety: "did it actually go out?" — the BCC arrives in the
 *     freelancer's inbox the moment the client does, turning the black-box
 *     send into a confirmable event.
 *   - Post-send paper trail: the copy sits in their inbox so they can
 *     forward, re-send manually, or scan when the client replies asking
 *     "what was the amount again?".
 *
 * Covers:
 *  1. lib/email: resolveOwnerBcc returns owner.email when bcc_invoice_emails
 *     is true and owner.email differs from invoice.client_email.
 *  2. lib/email: resolveOwnerBcc returns null when bcc_invoice_emails is
 *     false (default — no opt-in, no BCC).
 *  3. lib/email: resolveOwnerBcc returns null when owner is missing entirely.
 *  4. lib/email: resolveOwnerBcc returns null when owner.email is missing
 *     (defensive — can't BCC a nonexistent address).
 *  5. lib/email: resolveOwnerBcc returns null when owner.email == invoice
 *     .client_email (self-addressed invoice → no duplicate copy).
 *  6. lib/email: resolveOwnerBcc dedupe is case-insensitive ("Me@x.com"
 *     vs "me@x.com" still suppresses the BCC).
 *  7. lib/email: sendEmail with bcc threads the value to the Resend payload
 *     as an array (Resend SDK expects an array even for a single recipient).
 *  8. lib/email: sendEmail without bcc omits the payload.bcc key entirely
 *     (must not silently send to undefined).
 *  9. lib/email: sendInvoiceEmail with owner.bcc_invoice_emails=true sends
 *     to the client AND BCCs the owner.
 * 10. lib/email: sendInvoiceEmail with owner.bcc_invoice_emails=false sends
 *     only to the client (no BCC field on the Resend payload).
 * 11. lib/email: sendInvoiceEmail with self-addressed invoice
 *     (owner.email === invoice.client_email) sends only to the client even
 *     when the toggle is on — no duplicate.
 * 12. POST /billing/settings with bcc_invoice_emails=1 persists true.
 * 13. POST /billing/settings WITHOUT bcc_invoice_emails persists false
 *     (browsers omit unchecked checkboxes — absence is the OFF signal).
 * 14. views/settings.ejs renders the checkbox unchecked for a user with
 *     bcc_invoice_emails=false.
 * 15. views/settings.ejs renders the checkbox checked for a user with
 *     bcc_invoice_emails=true.
 * 16. db/schema.sql carries the idempotent ALTER TABLE migration.
 *
 * Run: NODE_ENV=test node tests/bcc-invoice-emails.test.js
 */

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const express = require('express');
const session = require('express-session');
const http = require('http');

function clearReq(mod) {
  try { delete require.cache[require.resolve(mod)]; } catch (_) { /* noop */ }
}

// ---------- Lib-level (no HTTP) tests ------------------------------------

async function testResolveOwnerBccOptInDifferentAddress() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const bcc = email.resolveOwnerBcc(
    { client_email: 'client@acme.com' },
    { email: 'me@studio.com', bcc_invoice_emails: true }
  );
  assert.strictEqual(bcc, 'me@studio.com',
    'opt-in + distinct client/owner addresses must surface the owner address');
}

async function testResolveOwnerBccOptOutDefault() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const bcc = email.resolveOwnerBcc(
    { client_email: 'client@acme.com' },
    { email: 'me@studio.com', bcc_invoice_emails: false }
  );
  assert.strictEqual(bcc, null,
    'opt-out is the default — no BCC even when both addresses are present');
}

async function testResolveOwnerBccNullOwner() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  assert.strictEqual(
    email.resolveOwnerBcc({ client_email: 'c@x.com' }, null),
    null,
    'null owner must yield null bcc (defensive — never throw)'
  );
  assert.strictEqual(
    email.resolveOwnerBcc({ client_email: 'c@x.com' }, undefined),
    null,
    'undefined owner must yield null bcc'
  );
}

async function testResolveOwnerBccMissingOwnerEmail() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  assert.strictEqual(
    email.resolveOwnerBcc(
      { client_email: 'c@x.com' },
      { email: null, bcc_invoice_emails: true }
    ),
    null,
    'opt-in but no owner email must yield null (can\'t BCC nothing)'
  );
  assert.strictEqual(
    email.resolveOwnerBcc(
      { client_email: 'c@x.com' },
      { email: '   ', bcc_invoice_emails: true }
    ),
    null,
    'whitespace-only owner email must yield null'
  );
}

async function testResolveOwnerBccSelfAddressedDedupe() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const bcc = email.resolveOwnerBcc(
    { client_email: 'me@studio.com' },
    { email: 'me@studio.com', bcc_invoice_emails: true }
  );
  assert.strictEqual(bcc, null,
    'self-addressed invoice (client_email === owner.email) must NOT BCC — would deliver twice');
}

async function testResolveOwnerBccCaseInsensitiveDedupe() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const bcc = email.resolveOwnerBcc(
    { client_email: 'Me@Studio.COM' },
    { email: 'me@studio.com', bcc_invoice_emails: true }
  );
  assert.strictEqual(bcc, null,
    'case-insensitive dedupe — RFC 5321 local-parts are technically case-sensitive but every real mail provider canonicalises');
}

async function testSendEmailThreadsBccArray() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const sends = [];
  email.setResendClient({
    emails: {
      async send(payload) {
        sends.push(payload);
        return { data: { id: 'em_with_bcc' }, error: null };
      }
    }
  });
  const r = await email.sendEmail({
    to: 'client@x.com',
    subject: 's',
    html: '<p>h</p>',
    bcc: 'owner@x.com'
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(sends.length, 1);
  assert.ok(Array.isArray(sends[0].bcc),
    'bcc must be normalised to an array (Resend SDK contract)');
  assert.deepStrictEqual(sends[0].bcc, ['owner@x.com']);
  email.resetResendClient();
}

async function testSendEmailWithoutBccOmitsKey() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const sends = [];
  email.setResendClient({
    emails: {
      async send(payload) {
        sends.push(payload);
        return { data: { id: 'em_no_bcc' }, error: null };
      }
    }
  });
  const r = await email.sendEmail({
    to: 'client@x.com',
    subject: 's',
    html: '<p>h</p>'
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(sends.length, 1);
  assert.ok(!('bcc' in sends[0]),
    'bcc key must be omitted entirely when no bcc passed — never send `bcc: undefined`');
  email.resetResendClient();
}

async function testSendInvoiceEmailBccsOwnerWhenOptedIn() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const sends = [];
  email.setResendClient({
    emails: {
      async send(payload) {
        sends.push(payload);
        return { data: { id: 'em_optedin' }, error: null };
      }
    }
  });
  const r = await email.sendInvoiceEmail(
    {
      invoice_number: 'INV-1', total: '100.00', currency: 'usd',
      client_name: 'Acme', client_email: 'ap@acme.com',
      items: [{ description: 'work', quantity: 1, unit_price: 100 }]
    },
    {
      email: 'freelancer@studio.com',
      business_name: 'Studio',
      bcc_invoice_emails: true
    }
  );
  assert.strictEqual(r.ok, true);
  assert.strictEqual(sends.length, 1);
  assert.deepStrictEqual(sends[0].to, ['ap@acme.com'],
    'client is still the primary recipient');
  assert.deepStrictEqual(sends[0].bcc, ['freelancer@studio.com'],
    'owner gets a silent BCC copy');
  email.resetResendClient();
}

async function testSendInvoiceEmailNoBccWhenOptedOut() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const sends = [];
  email.setResendClient({
    emails: {
      async send(payload) {
        sends.push(payload);
        return { data: { id: 'em_optedout' }, error: null };
      }
    }
  });
  const r = await email.sendInvoiceEmail(
    {
      invoice_number: 'INV-2', total: '50.00', currency: 'usd',
      client_name: 'Acme', client_email: 'ap@acme.com',
      items: [{ description: 'work', quantity: 1, unit_price: 50 }]
    },
    {
      email: 'freelancer@studio.com',
      business_name: 'Studio',
      bcc_invoice_emails: false
    }
  );
  assert.strictEqual(r.ok, true);
  assert.strictEqual(sends.length, 1);
  assert.ok(!('bcc' in sends[0]),
    'opt-out: bcc key must be absent from the Resend payload');
  email.resetResendClient();
}

async function testSendInvoiceEmailSelfAddressedSuppressesBcc() {
  clearReq('../lib/email');
  const email = require('../lib/email');
  const sends = [];
  email.setResendClient({
    emails: {
      async send(payload) {
        sends.push(payload);
        return { data: { id: 'em_self' }, error: null };
      }
    }
  });
  // owner.email === invoice.client_email (the freelancer test-billed their
  // own address, or a one-person shop is the client of record). Sending
  // to+bcc the same address delivers twice and breaks the "did it land?"
  // signal — the BCC must drop even with the toggle on.
  const r = await email.sendInvoiceEmail(
    {
      invoice_number: 'INV-3', total: '10.00', currency: 'usd',
      client_name: 'Self', client_email: 'me@x.com',
      items: [{ description: 'work', quantity: 1, unit_price: 10 }]
    },
    { email: 'me@x.com', bcc_invoice_emails: true }
  );
  assert.strictEqual(r.ok, true);
  assert.strictEqual(sends.length, 1);
  assert.deepStrictEqual(sends[0].to, ['me@x.com']);
  assert.ok(!('bcc' in sends[0]),
    'self-addressed dedupe — owner BCC must not duplicate the to: recipient');
  email.resetResendClient();
}

// ---------- Settings route + view tests ----------------------------------

const users = new Map();
const updateUserCalls = [];

function resetStores() {
  users.clear();
  updateUserCalls.length = 0;
}

const dbStub = {
  pool: { query: async () => ({ rows: [] }) },
  db: {
    async getUserByEmail() { return null; },
    async getUserById(id) { return users.get(id) || null; },
    async updateUser(id, fields) {
      updateUserCalls.push({ id, fields });
      const u = users.get(id);
      if (u) Object.assign(u, fields);
      return u || null;
    }
  }
};

require.cache[require.resolve('../db')] = {
  id: require.resolve('../db'),
  filename: require.resolve('../db'),
  loaded: true,
  exports: dbStub
};

// Stub Stripe — billing routes import the SDK at top-level.
require.cache[require.resolve('stripe')] = {
  id: require.resolve('stripe'),
  filename: require.resolve('stripe'),
  loaded: true,
  exports: () => ({
    checkout: { sessions: { create: async () => ({ url: 'https://x' }) } },
    billingPortal: { sessions: { create: async () => ({ url: 'https://x' }) } },
    webhooks: { constructEvent: () => ({}) },
    customers: { update: async () => ({}) },
    paymentLinks: { create: async () => ({ id: 'p', url: 'https://x' }) }
  })
};

clearReq('../routes/billing');
const billingRoutes = require('../routes/billing');

function buildApp(sessionUser) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, _res, next) => {
    if (sessionUser) req.session.user = sessionUser;
    next();
  });
  app.use((req, res, next) => { res.locals.user = sessionUser || null; next(); });
  app.use('/billing', billingRoutes);
  return app;
}

function request(app, method, url, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const payload = body ? new URLSearchParams(body).toString() : '';
      const headers = {};
      if (payload) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        headers['Content-Length'] = Buffer.byteLength(payload);
      }
      const req = http.request(
        { hostname: '127.0.0.1', port, path: url, method, headers },
        res => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => server.close(() => resolve({
            status: res.statusCode, headers: res.headers, body: data
          })));
        }
      );
      req.on('error', err => { server.close(); reject(err); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

async function testSettingsSavesBccOptIn() {
  resetStores();
  users.set(21, {
    id: 21, email: 'me@x.com', name: 'M', plan: 'free',
    bcc_invoice_emails: false
  });
  const app = buildApp({ id: 21, plan: 'free' });
  const res = await request(app, 'POST', '/billing/settings', {
    name: 'M',
    bcc_invoice_emails: '1'
  });
  assert.strictEqual(res.status, 302);
  assert.ok(updateUserCalls.length >= 1, 'db.updateUser must be called');
  const call = updateUserCalls[updateUserCalls.length - 1];
  assert.strictEqual(call.fields.bcc_invoice_emails, true,
    'checked checkbox must persist as boolean true');
}

async function testSettingsSavesBccOptOutOnAbsence() {
  resetStores();
  // User had it on; now they uncheck and submit. The checkbox is omitted
  // from the form submission — that absence is the "off" signal.
  users.set(22, {
    id: 22, email: 'me@x.com', name: 'M', plan: 'free',
    bcc_invoice_emails: true
  });
  const app = buildApp({ id: 22, plan: 'free' });
  const res = await request(app, 'POST', '/billing/settings', {
    name: 'M'
    // bcc_invoice_emails intentionally omitted
  });
  assert.strictEqual(res.status, 302);
  assert.ok(updateUserCalls.length >= 1);
  const call = updateUserCalls[updateUserCalls.length - 1];
  assert.strictEqual(call.fields.bcc_invoice_emails, false,
    'absent checkbox must persist as boolean false — uncheck signal');
}

async function testSettingsViewRendersUncheckedCheckbox() {
  const html = await ejs.renderFile(
    path.join(__dirname, '..', 'views', 'settings.ejs'),
    {
      title: 'Settings',
      user: {
        email: 'me@x.com', name: 'M', plan: 'free',
        business_name: null, business_address: null,
        business_email: null, business_phone: null,
        webhook_url: null, invoice_count: 0,
        reply_to_email: null, payment_instructions: null,
        bcc_invoice_emails: false
      },
      flash: null
    },
    { rmWhitespace: false }
  );
  assert.ok(html.includes('name="bcc_invoice_emails"'),
    'settings view must render the bcc_invoice_emails checkbox');
  assert.ok(html.includes('data-testid="settings-bcc-invoice-emails"'),
    'checkbox must carry a stable data-testid for downstream assertions');
  // Find the checkbox input element and confirm it is NOT checked.
  const inputMatch = html.match(/<input[^>]*name="bcc_invoice_emails"[^>]*>/);
  assert.ok(inputMatch, 'checkbox <input> element must be present');
  assert.ok(!/\bchecked\b/.test(inputMatch[0]),
    'opt-out user must see an unchecked box');
  assert.ok(/Send me a copy of every invoice I email/.test(html),
    'settings view must label the checkbox so users understand what it does');
}

async function testSettingsViewRendersCheckedCheckbox() {
  const html = await ejs.renderFile(
    path.join(__dirname, '..', 'views', 'settings.ejs'),
    {
      title: 'Settings',
      user: {
        email: 'me@x.com', name: 'M', plan: 'free',
        business_name: null, business_address: null,
        business_email: null, business_phone: null,
        webhook_url: null, invoice_count: 0,
        reply_to_email: null, payment_instructions: null,
        bcc_invoice_emails: true
      },
      flash: null
    },
    { rmWhitespace: false }
  );
  const inputMatch = html.match(/<input[^>]*name="bcc_invoice_emails"[^>]*>/);
  assert.ok(inputMatch, 'checkbox <input> element must be present');
  assert.ok(/\bchecked\b/.test(inputMatch[0]),
    'opt-in user must see a checked box reflecting their current state');
}

async function testSchemaIncludesBccMigration() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  assert.ok(
    /ALTER TABLE users ADD COLUMN IF NOT EXISTS bcc_invoice_emails BOOLEAN DEFAULT false/i.test(sql),
    'schema.sql must carry an idempotent ALTER for users.bcc_invoice_emails BOOLEAN DEFAULT false'
  );
}

// ---------- Runner -------------------------------------------------------

async function run() {
  const tests = [
    ['lib/email: resolveOwnerBcc opted-in + distinct addresses returns owner.email', testResolveOwnerBccOptInDifferentAddress],
    ['lib/email: resolveOwnerBcc opted-out (default) returns null', testResolveOwnerBccOptOutDefault],
    ['lib/email: resolveOwnerBcc null/undefined owner returns null', testResolveOwnerBccNullOwner],
    ['lib/email: resolveOwnerBcc missing owner email returns null', testResolveOwnerBccMissingOwnerEmail],
    ['lib/email: resolveOwnerBcc self-addressed dedupe (client === owner) returns null', testResolveOwnerBccSelfAddressedDedupe],
    ['lib/email: resolveOwnerBcc case-insensitive dedupe', testResolveOwnerBccCaseInsensitiveDedupe],
    ['lib/email: sendEmail with bcc threads array to Resend payload', testSendEmailThreadsBccArray],
    ['lib/email: sendEmail without bcc omits the payload.bcc key', testSendEmailWithoutBccOmitsKey],
    ['lib/email: sendInvoiceEmail BCCs owner when bcc_invoice_emails=true', testSendInvoiceEmailBccsOwnerWhenOptedIn],
    ['lib/email: sendInvoiceEmail no BCC when bcc_invoice_emails=false', testSendInvoiceEmailNoBccWhenOptedOut],
    ['lib/email: sendInvoiceEmail self-addressed suppresses BCC', testSendInvoiceEmailSelfAddressedSuppressesBcc],
    ['POST /billing/settings — bcc_invoice_emails=1 persists true', testSettingsSavesBccOptIn],
    ['POST /billing/settings — absent bcc_invoice_emails persists false (uncheck)', testSettingsSavesBccOptOutOnAbsence],
    ['views/settings.ejs renders unchecked checkbox for opt-out user', testSettingsViewRendersUncheckedCheckbox],
    ['views/settings.ejs renders checked checkbox for opt-in user', testSettingsViewRendersCheckedCheckbox],
    ['db/schema.sql carries idempotent ALTER for users.bcc_invoice_emails', testSchemaIncludesBccMigration]
  ];
  let pass = 0, fail = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ok  ${name}`);
      pass++;
    } catch (err) {
      console.error(`  FAIL ${name}`);
      console.error('       ' + (err && err.message));
      console.error('       ' + (err && err.stack && err.stack.split('\n').slice(1, 4).join('\n       ')));
      fail++;
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run().catch(err => { console.error(err); process.exit(1); });
