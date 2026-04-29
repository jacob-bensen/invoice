'use strict';

const crypto = require('crypto');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Paths that MUST bypass CSRF entirely. The Stripe webhook arrives with a
// raw body and no session cookie — its authenticity is verified by the
// Stripe-Signature header instead.
const EXEMPT_PATHS = new Set(['/billing/webhook']);

function generateToken() {
  return crypto.randomBytes(24).toString('hex');
}

function timingSafeStringEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function csrfProtection(req, res, next) {
  if (EXEMPT_PATHS.has(req.path)) return next();
  if (!req.session) return next();

  if (!req.session.csrfToken) {
    req.session.csrfToken = generateToken();
  }
  res.locals.csrfToken = req.session.csrfToken;

  if (SAFE_METHODS.has(req.method)) return next();

  const submitted =
    (req.body && typeof req.body._csrf === 'string' && req.body._csrf) ||
    req.get('x-csrf-token') ||
    req.get('csrf-token') ||
    '';

  if (!timingSafeStringEqual(submitted, req.session.csrfToken)) {
    res.status(403);
    return res.send('Invalid or missing CSRF token');
  }

  next();
}

module.exports = { csrfProtection, generateToken };
