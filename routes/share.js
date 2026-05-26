'use strict';

/*
 * Public, no-auth invoice share route (#43). A Pro user generates a token on
 * /invoices/:id/share, sends the resulting /i/<token> URL to their client by
 * email/DM, and the client opens the URL to see a clean, read-only invoice
 * (with the Stripe payment-link button if one is attached). No DecentInvoice
 * account, no login.
 *
 * Token format is strictly enforced before any DB lookup so a probing crawler
 * doesn't pay the SQL cost on garbage paths. Tokenised URLs carry noindex so
 * search engines don't accidentally surface a client's invoice on Google.
 */

const express = require('express');
const { db } = require('../db');
const { isValidPublicToken } = require('../lib/share-link');
const { isLikelyBotUserAgent } = require('../lib/client-view');
const emailLib = require('../lib/email');
const { triggerFirstSentCelebration } = require('../lib/first-sent-celebration');
const { buildInvoiceIcs, buildIcsFilename } = require('../lib/calendar');
const { buildPublicInvoiceOg, PUBLIC_INVOICE_OG_DEFAULT_DESCRIPTION } = require('../lib/public-invoice-og');

const router = express.Router();

// Whitelist of payment methods the public payment-claim widget accepts.
// Matches the lib/email PAYMENT_METHOD_LABELS keys; any other value coerces
// to 'other' so a tampered form never persists arbitrary strings.
const PAYMENT_CLAIM_METHODS = new Set([
  'cash', 'check', 'venmo', 'zelle', 'bank_transfer', 'paypal', 'other'
]);

const PAYMENT_CLAIM_REFERENCE_MAX = 200;
const PAYMENT_CLAIM_NOTE_MAX = 1000;

router.get('/i/:token', async (req, res) => {
  const token = req.params.token || '';
  if (!isValidPublicToken(token)) {
    res.status(404);
    return res.render('not-found', {
      title: 'Invoice not found — DecentInvoice',
      homeHref: '/',
      homeLabel: 'Go to home page',
      noindex: true
    });
  }
  let invoice;
  try {
    invoice = await db.getInvoiceByPublicToken(token.trim());
  } catch (err) {
    console.error('Public invoice lookup failed:', err && err.message);
    res.status(500);
    return res.render('not-found', {
      title: 'Invoice unavailable — DecentInvoice',
      homeHref: '/',
      homeLabel: 'Go to home page',
      noindex: true
    });
  }
  if (!invoice) {
    res.status(404);
    return res.render('not-found', {
      title: 'Invoice not found — DecentInvoice',
      homeHref: '/',
      homeLabel: 'Go to home page',
      noindex: true
    });
  }

  /*
   * Stamp the client view AFTER the lookup succeeded but BEFORE we
   * render — fire-and-forget so a transient pool blip never blocks the
   * client seeing their invoice. Bot/preview-fetcher UAs are excluded
   * so the freelancer's dashboard badge only fires on real human
   * opens. The owner of the invoice viewing their own /i/<token> URL
   * (unlikely, but possible if they preview the link) is NOT excluded
   * by IP/session — the public route is auth-less by design — so the
   * count includes any owner self-preview. This is acceptable: the
   * dashboard badge says "Viewed Xh ago" and even a self-preview is
   * a useful "the link works" confirmation. Owner browser UAs (Chrome
   * etc.) intentionally pass through.
   */
  if (typeof db.recordPublicInvoiceView === 'function' &&
      !isLikelyBotUserAgent(req.get('user-agent'))) {
    db.recordPublicInvoiceView(invoice.id).then((row) => {
      // First-sent celebration on the client-view auto-flip. The atomic
      // UPDATE in recordPublicInvoiceView returns the row with the new
      // status; if the pre-update status was 'draft' and the post-update
      // status is 'sent', the auto-transition just fired. The DB-side guard
      // in recordFirstSentIfMissing makes this safe to call unconditionally,
      // but gating on invoice.is_seed + an owner_id check trims the trigger
      // to the actual activation cohort.
      const flipped = row && invoice.status === 'draft' && row.status === 'sent';
      if (flipped && !invoice.is_seed && invoice.owner_id) {
        triggerFirstSentCelebration(db, invoice.owner_id, invoice)
          .catch((err) => console.error('First-sent celebration error:', err && err.message));
      }

      // On the very first non-bot view, pull the freelancer back into the
      // app with a notification email. The atomic UPDATE in
      // recordPublicInvoiceView guarantees exactly one concurrent caller
      // observes view_count = 1, so the email fires once per invoice
      // even under racing parallel opens. Seed invoices are excluded
      // defensively (they never carry a public_token in practice, so
      // this is belt-and-braces).
      if (!row || Number(row.view_count) !== 1) return;
      if (invoice.is_seed) return;
      if (!invoice.owner_email) return;
      if (typeof emailLib.sendClientViewedEmail !== 'function') return;
      const owner = {
        email: invoice.owner_email,
        name: invoice.owner_name,
        business_name: invoice.owner_business_name,
        business_email: invoice.owner_business_email,
        reply_to_email: invoice.owner_reply_to_email
      };
      emailLib.sendClientViewedEmail(invoice, owner).catch((err) => {
        console.error('sendClientViewedEmail failed:', err && err.message);
      });
    }).catch((err) => {
      console.error('recordPublicInvoiceView failed:', err && err.message);
    });
  }

  const claimed = req.query && req.query.claimed === '1';
  // Per-invoice OpenGraph metadata (Milestone 4 — first invoice sent → first
  // payment received). When a freelancer shares the /i/<token> URL via
  // WhatsApp / iMessage / Slack / Telegram / Facebook Messenger, the link
  // preview pivots from the default SaaS marketing tile ("DecentInvoice —
  // Professional invoices for freelancers") to a concrete invoice tile that
  // names the sender, the amount, and the due-date / overdue / paid state.
  // Client click-through on the preview rises materially when the tile
  // looks like a real invoice rather than what reads as an ad. Privacy:
  // client_name is deliberately NOT included — the link previews on the
  // freelancer's send-chain (their device, their forwarded chats) and the
  // client is the recipient, not the subject of the title.
  const ogFields = buildPublicInvoiceOg(invoice) || {};
  res.render('invoice-public', {
    title: `Invoice ${invoice.invoice_number} — DecentInvoice`,
    invoice,
    paymentClaimMethods: Array.from(PAYMENT_CLAIM_METHODS),
    paymentClaimReferenceMax: PAYMENT_CLAIM_REFERENCE_MAX,
    paymentClaimNoteMax: PAYMENT_CLAIM_NOTE_MAX,
    justClaimed: claimed,
    ogTitle: ogFields.title || `Invoice ${invoice.invoice_number} — DecentInvoice`,
    ogDescription: ogFields.description || PUBLIC_INVOICE_OG_DEFAULT_DESCRIPTION,
    ogPath: `/i/${token.trim()}`,
    noindex: true
  });
});

/*
 * "Add to calendar" download for the public invoice page (Milestone 4 — sent
 * → paid). The client opens /i/<token>, clicks 📅 Add to calendar, and gets
 * an .ics file pinning the due date in their native calendar app — Apple
 * Calendar, Google Calendar (via .ics import), Outlook. A built-in VALARM
 * fires a notification ~12h before the due day, which is the single most
 * effective on-time-payment intervention you can ship without owning the
 * client's notification surface.
 *
 * Auth model mirrors GET /i/<token>: no login required, the token IS the
 * capability. 404s on bad-format token, missing invoice, paid invoice (no
 * reminder needed), or missing due_date (nothing to remind about). The
 * route is intentionally NOT exposed for status='draft' invoices either —
 * a public share link for a draft is itself an out-of-flow state, and
 * surfacing a calendar reminder for a not-yet-sent invoice would confuse
 * the client.
 */
router.get('/i/:token/calendar.ics', async (req, res) => {
  const token = req.params.token || '';
  if (!isValidPublicToken(token)) {
    res.status(404);
    return res.render('not-found', {
      title: 'Invoice not found — DecentInvoice',
      homeHref: '/',
      homeLabel: 'Go to home page',
      noindex: true
    });
  }
  let invoice;
  try {
    invoice = await db.getInvoiceByPublicToken(token.trim());
  } catch (err) {
    console.error('calendar.ics: lookup failed:', err && err.message);
    res.status(500);
    return res.render('not-found', {
      title: 'Invoice unavailable — DecentInvoice',
      homeHref: '/',
      homeLabel: 'Go to home page',
      noindex: true
    });
  }
  if (!invoice) {
    res.status(404);
    return res.render('not-found', {
      title: 'Invoice not found — DecentInvoice',
      homeHref: '/',
      homeLabel: 'Go to home page',
      noindex: true
    });
  }
  if (invoice.status === 'paid' || invoice.status === 'draft' || !invoice.due_date) {
    res.status(404);
    return res.render('not-found', {
      title: 'No upcoming due date — DecentInvoice',
      homeHref: '/',
      homeLabel: 'Go to home page',
      noindex: true
    });
  }
  const body = buildInvoiceIcs(invoice, { appUrl: process.env.APP_URL });
  if (!body) {
    res.status(404);
    return res.render('not-found', {
      title: 'No upcoming due date — DecentInvoice',
      homeHref: '/',
      homeLabel: 'Go to home page',
      noindex: true
    });
  }
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition',
    `attachment; filename="${buildIcsFilename(invoice)}"`);
  // Avoid intermediary caching — a paid flip / due-date edit on the
  // freelancer side should be reflected the next time the client re-
  // downloads (rare but real for invoices whose due date got updated).
  res.set('Cache-Control', 'no-store');
  // The .ics is a downloadable artifact, not a page. Strip the
  // X-Robots-Tag header so crawlers don't waste budget on it AND don't
  // accidentally index the bytes; this is belt-and-braces alongside the
  // global noindex on /i/<token>.
  res.set('X-Robots-Tag', 'noindex');
  return res.send(body);
});

/*
 * Client-side payment-claim widget submit (Milestone 4 — sent → paid).
 * The client on the public /i/<token> page clicks "I've sent payment",
 * picks the method (Venmo/Zelle/bank/etc.), optionally adds a reference
 * (transaction id / cheque number / Venmo handle), and submits. We stamp
 * `payment_claimed_at` exactly once via a guarded UPDATE — so concurrent
 * double-submits collapse to a single stamp — then fire an email back to
 * the freelancer fire-and-forget so a Resend outage never blocks the
 * client's confirmation render.
 *
 * Note: this is a CLIENT self-report. The freelancer still has to verify
 * the funds landed and click Mark-as-Paid on /invoices/:id to actually
 * flip the status. We deliberately do NOT auto-flip to status='paid' —
 * a hostile client could otherwise mark every invoice paid without
 * sending a cent.
 *
 * Already-paid invoices and already-claimed invoices both 200 redirect
 * back to the share page with ?claimed=1 (idempotent) — a client who
 * accidentally double-submits sees the same confirmation, not an error.
 *
 * CSRF is enforced by the global middleware: a session cookie was set
 * on the first GET /i/<token> (which created session.csrfToken and rendered
 * it into the form), so the POST round-trip carries the matching token.
 */
router.post('/i/:token/payment-claim', async (req, res) => {
  const token = (req.params.token || '').trim();
  if (!isValidPublicToken(token)) {
    res.status(404);
    return res.render('not-found', {
      title: 'Invoice not found — DecentInvoice',
      homeHref: '/',
      homeLabel: 'Go to home page',
      noindex: true
    });
  }

  let invoice;
  try {
    invoice = await db.getInvoiceByPublicToken(token);
  } catch (err) {
    console.error('payment-claim: lookup failed:', err && err.message);
    res.status(500);
    return res.render('not-found', {
      title: 'Invoice unavailable — DecentInvoice',
      homeHref: '/',
      homeLabel: 'Go to home page',
      noindex: true
    });
  }
  if (!invoice) {
    res.status(404);
    return res.render('not-found', {
      title: 'Invoice not found — DecentInvoice',
      homeHref: '/',
      homeLabel: 'Go to home page',
      noindex: true
    });
  }

  // Idempotent: if the invoice is already paid OR already claimed, treat the
  // POST as a no-op and redirect to the share page in claimed state. This
  // protects against re-submits from the back button / refresh.
  if (invoice.status === 'paid' || invoice.payment_claimed_at) {
    return res.redirect(`/i/${token}?claimed=1`);
  }

  // Method whitelist — anything off-list coerces to 'other' instead of 400ing
  // so a slightly out-of-date form (e.g. a value we deprecate later) still
  // lands as a useful signal rather than dropping the claim on the floor.
  const rawMethod = (req.body && req.body.method && String(req.body.method).trim().toLowerCase()) || '';
  const method = PAYMENT_CLAIM_METHODS.has(rawMethod) ? rawMethod : 'other';

  const reference = (req.body && req.body.reference)
    ? String(req.body.reference).trim().slice(0, PAYMENT_CLAIM_REFERENCE_MAX) || null
    : null;
  const note = (req.body && req.body.note)
    ? String(req.body.note).trim().slice(0, PAYMENT_CLAIM_NOTE_MAX) || null
    : null;

  let claimedRow;
  try {
    claimedRow = await db.recordPaymentClaim(invoice.id, { method, reference, note });
  } catch (err) {
    console.error('payment-claim: stamp failed:', err && err.message);
    res.status(500);
    return res.render('not-found', {
      title: 'Could not record payment — DecentInvoice',
      homeHref: '/',
      homeLabel: 'Go to home page',
      noindex: true
    });
  }

  // Atomic guard lost the race (concurrent submit got there first, OR the
  // row was flipped to paid between the lookup and the UPDATE). Treat as
  // claimed and redirect to the same confirmation page.
  if (!claimedRow) {
    return res.redirect(`/i/${token}?claimed=1`);
  }

  // Fire the email back to the freelancer. Fire-and-forget so a Resend
  // outage never breaks the client's confirmation render. Missing owner
  // email skips silently inside sendPaymentClaimedEmail.
  if (typeof emailLib.sendPaymentClaimedEmail === 'function' && claimedRow.owner_email) {
    const owner = {
      email: claimedRow.owner_email,
      name: claimedRow.owner_name,
      business_name: claimedRow.owner_business_name,
      business_email: claimedRow.owner_business_email,
      reply_to_email: claimedRow.owner_reply_to_email
    };
    emailLib.sendPaymentClaimedEmail(claimedRow, owner, { method, reference, note })
      .catch((err) => {
        console.error('sendPaymentClaimedEmail failed:', err && err.message);
      });
  }

  return res.redirect(`/i/${token}?claimed=1`);
});

module.exports = router;
