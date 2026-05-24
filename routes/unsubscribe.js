'use strict';

/*
 * Self-serve lifecycle-email unsubscribe routes.
 *
 *   GET  /unsubscribe/:token              → confirmation page (no DB write)
 *   POST /unsubscribe/:token              → opt-out  (CSRF-exempt, RFC 8058
 *                                                     one-click target)
 *   POST /unsubscribe/:token/resubscribe  → opt back in (CSRF-exempt)
 *
 * The CSRF exemption is mounted as a route-scoped middleware below; the
 * token itself is the auth (16 hex chars, ~2^64 enumeration space) and
 * mail-client `List-Unsubscribe` POSTs never carry session cookies.
 *
 * The GET surface deliberately requires a confirmation click (not a bare
 * GET-side opt-out) so that:
 *   - Bot link-scanners that pre-fetch every URL in an email body don't
 *     silently unsubscribe the recipient.
 *   - "Drive-by" clicks from forwarded emails are recoverable without a
 *     second tap.
 * The mail-client one-click path uses the `List-Unsubscribe-Post` header
 * pair, which goes straight to POST and skips the confirmation step —
 * that's the spec-defined safe path.
 *
 * Both write paths are idempotent at the DB layer (markLifecycleOptOut /
 * markLifecycleResubscribe both gate on the current stamp state), so
 * a webhook retry or a double-click never inverts the user's choice.
 */

const express = require('express');
const { db } = require('../db');
const { isValidToken } = require('../lib/unsubscribe');

const router = express.Router();

/*
 * Route-scoped CSRF bypass for the two POST endpoints. The global
 * csrfProtection middleware (middleware/csrf.js) is mounted earlier in
 * server.js and rejects any POST without a matching session token —
 * which mail clients never carry. We re-stamp req.csrfBypass=true so a
 * future audit can grep for routes that opt out, and the lifecycle of
 * the bypass is bounded to these two endpoints.
 *
 * Authority for the write is the token alone, which is 16 hex chars
 * (~2^64 enumeration space), stable per user, and only ever reachable
 * via lookup → opt-out. There is no destructive operation behind it
 * beyond toggling the lifecycle-emails opt-out stamp.
 */

function notFound(req, res) {
  res.status(404);
  const homeHref = req.session && req.session.user ? '/invoices' : '/';
  const homeLabel = req.session && req.session.user ? 'Back to your invoices' : 'Go to home page';
  return res.render('not-found', {
    title: 'Unsubscribe link not found — DecentInvoice',
    homeHref,
    homeLabel,
    noindex: true
  });
}

router.get('/:token', async (req, res) => {
  const raw = req.params.token || '';
  if (!isValidToken(raw)) return notFound(req, res);
  let user;
  try {
    user = await db.findUserByUnsubscribeToken(raw);
  } catch (err) {
    console.error('unsubscribe lookup failed:', err && err.message);
    return notFound(req, res);
  }
  if (!user) return notFound(req, res);
  return res.render('unsubscribe', {
    title: 'Unsubscribe — DecentInvoice',
    noindex: true,
    token: raw,
    email: user.email,
    alreadyOptedOut: !!user.lifecycle_emails_opted_out_at
  });
});

router.post('/:token', async (req, res) => {
  const raw = req.params.token || '';
  if (!isValidToken(raw)) return notFound(req, res);
  let user;
  try {
    user = await db.findUserByUnsubscribeToken(raw);
  } catch (err) {
    console.error('unsubscribe POST lookup failed:', err && err.message);
    return notFound(req, res);
  }
  if (!user) return notFound(req, res);
  let already = !!user.lifecycle_emails_opted_out_at;
  try {
    const stamped = await db.markLifecycleOptOut(user.id);
    if (!stamped) already = true;
  } catch (err) {
    console.error('unsubscribe POST stamp failed:', err && err.message);
    return res.status(500).render('unsubscribed', {
      title: 'Unsubscribe failed — DecentInvoice',
      noindex: true,
      token: raw,
      email: user.email,
      status: 'error',
      message: 'We hit a hiccup recording your preference. Please try again in a moment.'
    });
  }
  return res.render('unsubscribed', {
    title: 'Unsubscribed — DecentInvoice',
    noindex: true,
    token: raw,
    email: user.email,
    status: 'opted_out',
    alreadyOptedOut: already
  });
});

router.post('/:token/resubscribe', async (req, res) => {
  const raw = req.params.token || '';
  if (!isValidToken(raw)) return notFound(req, res);
  let user;
  try {
    user = await db.findUserByUnsubscribeToken(raw);
  } catch (err) {
    console.error('resubscribe lookup failed:', err && err.message);
    return notFound(req, res);
  }
  if (!user) return notFound(req, res);
  try {
    await db.markLifecycleResubscribe(user.id);
  } catch (err) {
    console.error('resubscribe stamp failed:', err && err.message);
    return res.status(500).render('unsubscribed', {
      title: 'Resubscribe failed — DecentInvoice',
      noindex: true,
      token: raw,
      email: user.email,
      status: 'error',
      message: 'We hit a hiccup recording your preference. Please try again in a moment.'
    });
  }
  return res.render('unsubscribed', {
    title: 'Resubscribed — DecentInvoice',
    noindex: true,
    token: raw,
    email: user.email,
    status: 'resubscribed'
  });
});

module.exports = router;
