const express = require('express');
const bcrypt = require('bcrypt');
const { body, validationResult } = require('express-validator');
const { db } = require('../db');
const { redirectIfAuth } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rate-limit');

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

    req.session.user = {
      id: user.id, email: user.email, name: user.name,
      plan: user.plan, invoice_count: user.invoice_count,
      subscription_status: user.subscription_status || null,
      trial_ends_at: user.trial_ends_at || null
    };
    res.redirect('/dashboard');
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

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

module.exports = router;
