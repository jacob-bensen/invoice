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
  res.render('invoice-public', {
    title: `Invoice ${invoice.invoice_number} — DecentInvoice`,
    invoice,
    noindex: true
  });
});

module.exports = router;
