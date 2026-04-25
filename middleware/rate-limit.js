'use strict';

// Rate limiter for authentication endpoints (POST /auth/login, POST /auth/register).
// Mitigates credential stuffing and email enumeration. The login route already
// returns a single generic "Invalid email or password" for both unknown-email
// and wrong-password (no oracle); this throttles any remaining attempts.

const rateLimit = require('express-rate-limit');

const DEFAULT_WINDOW_MS = 60 * 1000;
const DEFAULT_MAX = 10;

// Tests run against per-test fresh app instances but share this module's
// closure across tests in the same process. Bypass the limiter when
// NODE_ENV === 'test' so test suites don't accidentally trip it; tests
// targeting the limiter itself construct their own via createAuthLimiter.
const TEST_MAX = 1_000_000;

function resolveDefaultMax() {
  if (process.env.NODE_ENV === 'test') return TEST_MAX;
  const fromEnv = parseInt(process.env.AUTH_RATE_LIMIT_MAX, 10);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_MAX;
}

function createAuthLimiter({ windowMs = DEFAULT_WINDOW_MS, max = resolveDefaultMax() } = {}) {
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => {
      const path = req.path || req.originalUrl || '';
      const isLogin = path.endsWith('/login');
      const view = isLogin ? 'auth/login' : 'auth/register';
      const title = isLogin ? 'Log In' : 'Create Account';
      res.status(429).render(view, {
        title,
        flash: {
          type: 'error',
          message: 'Too many attempts. Please wait a minute and try again.'
        },
        values: { email: (req.body && req.body.email) || '' }
      });
    }
  });
}

const authLimiter = createAuthLimiter();

module.exports = { authLimiter, createAuthLimiter };
