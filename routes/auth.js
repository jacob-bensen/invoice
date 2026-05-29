const express = require('express');
const crypto = require('crypto');
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
  // ?mode=magic switches the form to the passwordless variant (name+email
  // only, server emails a one-tap sign-in link). Any other value renders the
  // default password form. The toggle is round-trip-safe: a user who picks
  // the passwordless mode and validation re-renders the form keeps the
  // passwordless layout via the same query string.
  const mode = (req.query && req.query.mode === 'magic') ? 'magic' : 'password';
  res.render('auth/register', { title: 'Create Account', mode, flash, noindex: true });
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

    await applyPostSignupSideEffects(req, user);

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

// Shared side-effects for any new-signup path (password OR passwordless):
// seed sample invoice (#39 — dashboard never empty), referral attribution
// (#49), signup-source attribution (utm_source). All three are soft-fail —
// signup itself MUST never abort on attribution plumbing or seed errors.
async function applyPostSignupSideEffects(req, user) {
  try {
    if (typeof db.createSeedInvoice === 'function') {
      await db.createSeedInvoice({ user_id: user.id });
    }
  } catch (err) {
    console.error('Seed invoice failed:', err && err.message);
  }
  if (req.session.referral_code && typeof db.attachReferrerByCode === 'function') {
    try {
      await db.attachReferrerByCode(user.id, req.session.referral_code);
    } catch (err) {
      console.error('Referrer attach failed:', err && err.message);
    }
    delete req.session.referral_code;
  }
  if (req.session.signup_source && typeof db.attachSignupSource === 'function') {
    try {
      await db.attachSignupSource(user.id, req.session.signup_source);
    } catch (err) {
      console.error('Signup source attach failed:', err && err.message);
    }
    delete req.session.signup_source;
  }
}

// --- Passwordless registration --------------------------------------------
//
// Removes the password-creation step from signup — the dominant friction
// point at the very top of the activation funnel. The user provides name +
// email; we create the account with an unguessable random password (a real
// password can be picked later via /auth/forgot) and fire the welcome email,
// whose CTAs already auto-sign-in via a 7-day baked-in magic-login URL
// (see lib/welcome.js). The user clicks any CTA → lands authenticated on
// /invoices/new (or /billing/upgrade) → activation funnel resumes.
//
// Existing-account collision: we fire requestMagicLink against the existing
// account so the user gets a fresh sign-in link in the same inbox, and we
// render the same generic "check your inbox" success either way (no email
// enumeration). The response is identical for new vs. existing.
//
// Security:
//   - Random password (32 random bytes hex → bcrypt) is unguessable; the
//     account cannot be password-logged-in until the user runs /auth/forgot.
//   - CSRF + authLimiter inherited from the route mount.
//   - Same input validation as POST /register minus the password constraint.
router.post('/register/magic', redirectIfAuth, authLimiter, [
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email required')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.render('auth/register', {
      title: 'Create Account',
      mode: 'magic',
      flash: { type: 'error', message: errors.array()[0].msg },
      values: req.body,
      noindex: true
    });
  }

  const email = req.body.email;
  const name = req.body.name.trim();

  try {
    const existing = await db.getUserByEmail(email);

    if (existing) {
      // Email already has an account. Fire a magic-login email so the user
      // can sign in, and render the same generic success below — never
      // reveal that the address is taken. Fire-and-forget.
      requestMagicLink(db, email)
        .catch((e) => console.error('Magic-link error (existing on /register/magic):', e && e.message));
    } else {
      // New account path. Mint an unguessable bcrypt-hashed random password
      // so the row satisfies the NOT NULL schema constraint without giving
      // anyone a way to password-login. The user can set a real password
      // later via /auth/forgot if they want one.
      const random = crypto.randomBytes(32).toString('hex');
      const password_hash = await bcrypt.hash(random, 12);
      const user = await db.createUser({ email, password_hash, name });

      await applyPostSignupSideEffects(req, user);

      // Welcome email IS the magic-login surface here — its CTAs already
      // carry a 7-day auto-sign-in URL (see lib/welcome.js). The user
      // clicking ANY CTA in the welcome email signs them in. Fire-and-
      // forget; idempotent at the DB layer; soft-fails on Resend not
      // configured / send errors so a transactional-email outage never
      // surfaces here.
      triggerWelcomeEmail(db, user.id)
        .then(r => {
          if (!r.ok && r.reason !== 'not_configured' && r.reason !== 'already_sent') {
            console.warn(`Welcome email skipped for user ${user.id}: ${r.reason}`);
          }
        })
        .catch(e => console.error('Welcome email error (passwordless signup):', e && e.message));
    }

    return res.render('auth/register', {
      title: 'Create Account',
      mode: 'magic',
      sent: true,
      submittedEmail: email,
      noindex: true
    });
  } catch (err) {
    console.error('Passwordless register error:', err);
    return res.render('auth/register', {
      title: 'Create Account',
      mode: 'magic',
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
