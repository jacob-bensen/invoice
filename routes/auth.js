const express = require('express');
const bcrypt = require('bcrypt');
const { body, validationResult } = require('express-validator');
const { db } = require('../db');
const { redirectIfAuth } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rate-limit');
const { triggerWelcomeEmail } = require('../lib/welcome');
const {
  requestPasswordReset,
  hashToken
} = require('../lib/password-reset');
const {
  requestMagicLink,
  hashToken: hashMagicToken,
  safeNextPath
} = require('../lib/magic-login');
const { stampLastLogin } = require('../lib/last-login');

const router = express.Router();

router.get('/login', redirectIfAuth, (req, res) => {
  const flash = req.session.flash;
  delete req.session.flash;
  res.render('auth/login', { title: 'Log In', flash, noindex: true });
});

router.get('/register', redirectIfAuth, (req, res) => {
  const flash = req.session.flash;
  delete req.session.flash;
  res.render('auth/register', { title: 'Create Account', flash, noindex: true });
});

router.post('/register', redirectIfAuth, authLimiter, [
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.render('auth/register', {
      title: 'Create Account',
      flash: { type: 'error', message: errors.array()[0].msg },
      values: req.body,
      noindex: true
    });
  }

  try {
    const existing = await db.getUserByEmail(req.body.email);
    if (existing) {
      return res.render('auth/register', {
        title: 'Create Account',
        flash: { type: 'error', message: 'An account with this email already exists.' },
        values: req.body,
        noindex: true
      });
    }

    const password_hash = await bcrypt.hash(req.body.password, 12);
    const user = await db.createUser({ email: req.body.email, password_hash, name: req.body.name });

    // Seed a sample draft invoice (#39) so the dashboard is never empty.
    // Best-effort: a seed failure must NOT abort account creation.
    try {
      if (typeof db.createSeedInvoice === 'function') {
        await db.createSeedInvoice({ user_id: user.id });
      }
    } catch (err) {
      console.error('Seed invoice failed:', err && err.message);
    }

    // Referral attribution (#49). The visitor arrived via `?ref=<code>` and
    // the server.js middleware stashed the code in their session. Attach
    // it now so users.referrer_id captures who sent them; clear the cookie
    // either way so a self-signed-up user later can't double-attribute.
    if (req.session.referral_code && typeof db.attachReferrerByCode === 'function') {
      try {
        await db.attachReferrerByCode(user.id, req.session.referral_code);
      } catch (err) {
        console.error('Referrer attach failed:', err && err.message);
      }
      delete req.session.referral_code;
    }

    req.session.user = {
      id: user.id, email: user.email, name: user.name,
      plan: user.plan, invoice_count: user.invoice_count,
      subscription_status: user.subscription_status || null,
      trial_ends_at: user.trial_ends_at || null
    };

    // Welcome email (fire-and-forget). Drives the signup → first-real-invoice
    // activation step that gates every downstream trial-conversion surface.
    // Idempotent at the DB layer; soft-fails on Resend not_configured / send
    // errors so a transactional-email outage never blocks signup.
    triggerWelcomeEmail(db, user.id)
      .then(r => {
        if (!r.ok && r.reason !== 'not_configured' && r.reason !== 'already_sent') {
          console.warn(`Welcome email skipped for user ${user.id}: ${r.reason}`);
        }
      })
      .catch(e => console.error('Welcome email error:', e && e.message));

    // Drop new signups directly on the value-moment instead of the busy
    // dashboard (Milestone 2 — first dashboard re-entry → first real invoice
    // created). The dashboard's onboarding stack (onboarding checklist,
    // firstRealInvoicePrompt, seed-invoice-hint, seed-invoice-view-banner,
    // nav controls) competes for attention against the single action a
    // brand-new user came here to take. The ?welcome=1 query toggles a
    // dismissable hero banner on /invoices/quick that names the user and
    // links back to the dashboard for the cohort that wants to explore first.
    res.redirect('/invoices/quick?welcome=1');
  } catch (err) {
    console.error('Register error:', err);
    res.render('auth/register', {
      title: 'Create Account',
      flash: { type: 'error', message: 'Something went wrong. Please try again.' },
      values: req.body,
      noindex: true
    });
  }
});

router.post('/login', redirectIfAuth, authLimiter, [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty()
], async (req, res) => {
  try {
    const user = await db.getUserByEmail(req.body.email);
    if (!user || !(await bcrypt.compare(req.body.password, user.password_hash))) {
      return res.render('auth/login', {
        title: 'Log In',
        flash: { type: 'error', message: 'Invalid email or password.' },
        values: { email: req.body.email },
        noindex: true
      });
    }

    req.session.user = {
      id: user.id, email: user.email, name: user.name,
      plan: user.plan, invoice_count: user.invoice_count,
      subscription_status: user.subscription_status || null,
      trial_ends_at: user.trial_ends_at || null
    };
    // Fire-and-forget last-login stamp for the activation funnel's
    // `returned` stage. Never blocks the redirect.
    stampLastLogin(db, user.id).catch((e) => console.error('stampLastLogin (login) error:', e && e.message));
    res.redirect('/dashboard');
  } catch (err) {
    console.error('Login error:', err);
    res.render('auth/login', {
      title: 'Log In',
      flash: { type: 'error', message: 'Something went wrong. Please try again.' },
      noindex: true
    });
  }
});

// --- Password reset / magic-link sign-in -----------------------------------
//
// Closes Milestone 1 of the activation funnel: a brand-new user who lost
// their session previously had no self-serve path back into the seeded
// dashboard. The login page's old "email support@..." hint was a dead end.
//
// The flow:
//   1. GET  /auth/forgot           — request-a-link form
//   2. POST /auth/forgot           — fires the email; always renders the
//                                    same generic success (no email enum)
//   3. GET  /auth/reset/:token     — set-new-password form, gated on a
//                                    valid (unconsumed + unexpired) token
//   4. POST /auth/reset/:token     — atomic consume + password rotate, log
//                                    the user in, redirect to dashboard
// Tokens are stored as SHA-256 hashes only; the raw token only lives in the
// emailed URL and the user's browser address bar.

router.get('/forgot', redirectIfAuth, (req, res) => {
  const flash = req.session.flash;
  delete req.session.flash;
  res.render('auth/forgot', { title: 'Reset your password', flash, noindex: true });
});

router.post('/forgot', redirectIfAuth, authLimiter, [
  body('email').isEmail().normalizeEmail().withMessage('Valid email required')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.render('auth/forgot', {
      title: 'Reset your password',
      flash: { type: 'error', message: errors.array()[0].msg },
      values: req.body,
      noindex: true
    });
  }
  // Fire the orchestrator; we deliberately ignore success/failure detail in
  // the user-facing response so the surface gives no signal about whether
  // an account exists for the submitted email. Errors are logged inside the
  // lib so a Resend outage or DB hiccup never surfaces here.
  requestPasswordReset(db, req.body.email)
    .catch((e) => console.error('Password reset error:', e && e.message));
  res.render('auth/forgot', {
    title: 'Reset your password',
    sent: true,
    submittedEmail: req.body.email,
    noindex: true
  });
});

router.get('/reset/:token', redirectIfAuth, async (req, res) => {
  const raw = req.params.token || '';
  let hash = null;
  if (/^[a-f0-9]{64}$/i.test(raw)) {
    hash = hashToken(raw);
  }
  let reset = null;
  if (hash) {
    try {
      reset = await db.findValidPasswordResetByHash(hash);
    } catch (err) {
      console.error('Password reset lookup failed:', err && err.message);
    }
  }
  if (!reset) {
    return res.status(400).render('auth/reset', {
      title: 'Reset your password',
      token: raw,
      invalid: true,
      noindex: true
    });
  }
  res.render('auth/reset', {
    title: 'Reset your password',
    token: raw,
    invalid: false,
    email: reset.email,
    noindex: true
  });
});

router.post('/reset/:token', redirectIfAuth, authLimiter, [
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
], async (req, res) => {
  const raw = req.params.token || '';
  if (!/^[a-f0-9]{64}$/i.test(raw)) {
    return res.status(400).render('auth/reset', {
      title: 'Reset your password',
      token: raw,
      invalid: true,
      noindex: true
    });
  }
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.render('auth/reset', {
      title: 'Reset your password',
      token: raw,
      invalid: false,
      flash: { type: 'error', message: errors.array()[0].msg },
      noindex: true
    });
  }
  const hash = hashToken(raw);
  try {
    const password_hash = await bcrypt.hash(req.body.password, 12);
    const user = await db.consumePasswordResetAndSetPassword(hash, password_hash);
    if (!user) {
      return res.status(400).render('auth/reset', {
        title: 'Reset your password',
        token: raw,
        invalid: true,
        noindex: true
      });
    }
    // Auto-login on the same hop so the user lands directly in their
    // seeded dashboard — the activation funnel's whole point is to get
    // them back in front of the app without a re-login speed bump.
    req.session.user = {
      id: user.id, email: user.email, name: user.name,
      plan: user.plan, invoice_count: user.invoice_count,
      subscription_status: user.subscription_status || null,
      trial_ends_at: user.trial_ends_at || null
    };
    stampLastLogin(db, user.id).catch((e) => console.error('stampLastLogin (reset) error:', e && e.message));
    req.session.flash = { type: 'success', message: 'Your password has been reset.' };
    return res.redirect('/dashboard');
  } catch (err) {
    console.error('Password reset consume failed:', err && err.message);
    return res.status(500).render('auth/reset', {
      title: 'Reset your password',
      token: raw,
      invalid: false,
      flash: { type: 'error', message: 'Something went wrong. Please try again.' },
      noindex: true
    });
  }
});

// --- Magic-link sign-in ---------------------------------------------------
//
// Password-less counterpart to /auth/forgot. The user types their email, we
// email a one-tap sign-in URL. Clicking the URL consumes the token atomically
// and writes the session — no password choice in between.
//
//   1. GET  /auth/magic               — request-a-link form
//   2. POST /auth/magic               — fires the email; always renders the
//                                       same generic success (no enumeration)
//   3. GET  /auth/magic/:token        — atomic consume + session-write + 302
//                                       to /dashboard, or render an
//                                       "invalid/expired" page on a bad token
// Tokens share the password_resets table via kind='login'; the consume path
// filters on kind='login' so a leaked password-reset hash cannot be replayed
// here.

router.get('/magic', redirectIfAuth, (req, res) => {
  const flash = req.session.flash;
  delete req.session.flash;
  res.render('auth/magic', { title: 'Email me a sign-in link', flash, noindex: true });
});

router.post('/magic', redirectIfAuth, authLimiter, [
  body('email').isEmail().normalizeEmail().withMessage('Valid email required')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.render('auth/magic', {
      title: 'Email me a sign-in link',
      flash: { type: 'error', message: errors.array()[0].msg },
      values: req.body,
      noindex: true
    });
  }
  // Same enumeration-resistance pattern as /auth/forgot: fire and forget,
  // render the same generic "check your inbox" regardless of whether the
  // address resolves to an account.
  requestMagicLink(db, req.body.email)
    .catch((e) => console.error('Magic-link error:', e && e.message));
  res.render('auth/magic', {
    title: 'Email me a sign-in link',
    sent: true,
    submittedEmail: req.body.email,
    noindex: true
  });
});

// The consume route deliberately skips the `redirectIfAuth` middleware that
// the request-form routes use: a user who is already signed in and clicks the
// welcome-email CTA with `?next=/invoices/new` should still land on that
// page, not bounce to /dashboard. When `next` is absent and the user is
// already authed we forward to /dashboard inline, matching the pre-existing
// behaviour without consuming a still-valid token.
router.get('/magic/:token', authLimiter, async (req, res) => {
  const next = safeNextPath(req.query && req.query.next);
  if (req.session.user) {
    return res.redirect(next || '/dashboard');
  }
  const raw = req.params.token || '';
  if (!/^[a-f0-9]{64}$/i.test(raw)) {
    return res.status(400).render('auth/magic', {
      title: 'Sign-in link',
      invalid: true,
      noindex: true
    });
  }
  const hash = hashMagicToken(raw);
  let user = null;
  try {
    user = await db.consumeMagicLoginToken(hash);
  } catch (err) {
    console.error('Magic-link consume failed:', err && err.message);
    return res.status(500).render('auth/magic', {
      title: 'Sign-in link',
      flash: { type: 'error', message: 'Something went wrong. Please try again.' },
      noindex: true
    });
  }
  if (!user) {
    return res.status(400).render('auth/magic', {
      title: 'Sign-in link',
      invalid: true,
      noindex: true
    });
  }
  req.session.user = {
    id: user.id, email: user.email, name: user.name,
    plan: user.plan, invoice_count: user.invoice_count,
    subscription_status: user.subscription_status || null,
    trial_ends_at: user.trial_ends_at || null
  };
  stampLastLogin(db, user.id).catch((e) => console.error('stampLastLogin (magic) error:', e && e.message));
  req.session.flash = { type: 'success', message: "You're signed in." };
  return res.redirect(next || '/dashboard');
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

module.exports = router;
