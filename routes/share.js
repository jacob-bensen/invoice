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

const router = express.Router();

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

  res.render('invoice-public', {
    title: `Invoice ${invoice.invoice_number} — DecentInvoice`,
    invoice,
    noindex: true
  });
});

module.exports = router;
