require('dotenv').config();
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');
const { pool } = require('./db');

const authRoutes = require('./routes/auth');
const invoiceRoutes = require('./routes/invoices');
const billingRoutes = require('./routes/billing');
const landingRoutes = require('./routes/landing');
const { csrfProtection } = require('./middleware/csrf');
const { securityHeaders } = require('./middleware/security-headers');
const { requireAuth } = require('./middleware/auth');
const { formatTrialCountdown } = require('./lib/html');
const { getCompetitorPricing } = require('./lib/competitor-pricing');

const app = express();

app.use(securityHeaders());

if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET must be set in production. Refusing to start with a predictable default.');
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

// Stripe webhook needs raw body — mount before json parser
app.use('/billing/webhook', express.raw({ type: 'application/json' }));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  store: new pgSession({ pool, tableName: 'session', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  // Global nav trial-countdown pill (INTERNAL_TODO #106). Persistent across
  // every authed page so trial urgency is not confined to the dashboard
  // banner. Reads from session.user.trial_ends_at (populated on login /
  // register / dashboard refresh) — no extra DB hit per request.
  res.locals.trialCountdown = req.session.user
    ? formatTrialCountdown(req.session.user.trial_ends_at)
    : null;
  next();
});

app.use(csrfProtection);

app.get('/', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('index', {
    title: 'DecentInvoice — Get Paid Faster',
    competitorPricing: getCompetitorPricing(),
    ogTitle: 'DecentInvoice — Professional invoices in 60 seconds',
    ogDescription: 'Send invoices freelancers can pay in one click. Free to start, $12/mo for Pro. 7-day free trial, no credit card.',
    ogPath: '/'
  });
});

app.get('/dashboard', (req, res) => {
  if (!req.session.user) return res.redirect('/auth/login');
  res.redirect('/invoices');
});

app.post('/onboarding/dismiss', requireAuth, invoiceRoutes.onboardingDismissHandler);

app.use('/auth', authRoutes);
app.use('/invoices', invoiceRoutes);
app.use('/billing', billingRoutes);
app.use('/', landingRoutes);

app.get('/sitemap.xml', (req, res) => {
  const host = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
  const lastmod = new Date().toISOString().split('T')[0];
  const staticUrls = ['/', '/auth/register', '/auth/login'];
  const nicheUrls = landingRoutes.listNiches().map((n) => n.url);
  const urls = [...staticUrls, ...nicheUrls].map((p) => {
    const priority = p === '/' ? '1.0' : '0.8';
    return `  <url>\n    <loc>${host}${p}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>${priority}</priority>\n  </url>`;
  }).join('\n');
  res.set('Content-Type', 'application/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
});

// robots.txt — instructs crawlers to index the marketing surface and avoid the
// authed/transactional surface. The sitemap pointer uses APP_URL when set so
// crawlers fetch the absolute URL rather than the request host (avoids cases
// where the app is reachable via a Heroku herokuapp.com URL and a custom
// domain — both sitemap copies should point to the canonical host).
app.get('/robots.txt', (req, res) => {
  const host = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
  const lines = [
    'User-agent: *',
    'Allow: /',
    'Disallow: /auth/',
    'Disallow: /billing/',
    'Disallow: /invoices/',
    'Disallow: /settings',
    'Disallow: /dashboard',
    'Disallow: /onboarding/',
    '',
    `Sitemap: ${host.replace(/\/+$/, '')}/sitemap.xml`,
    ''
  ].join('\n');
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.send(lines);
});

// Friendly 404 page. A silent redirect to '/' was a dead-end — the user had no
// signal they'd hit a stale or mistyped link, and Google saw a 302 redirect
// instead of a 404 (which slowed deindexing of removed URLs). The 404 status
// also pairs correctly with the meta-noindex tag in head.ejs for authed paths.
app.use((req, res) => {
  res.status(404);
  const homeHref = req.session && req.session.user ? '/invoices' : '/';
  const homeLabel = req.session && req.session.user ? 'Back to your invoices' : 'Go to home page';
  res.render('not-found', {
    title: 'Page not found — QuickInvoice',
    homeHref,
    homeLabel,
    noindex: true
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`DecentInvoice running on port ${PORT}`);
  // Daily payment-reminder cron. Runs only outside the test env so the test
  // suite can require server.js without spinning up a background scheduler.
  // Failures are logged and swallowed inside startReminderJob — a broken
  // cron must never take down the web process.
  if (process.env.NODE_ENV !== 'test') {
    try {
      const { startReminderJob } = require('./jobs/reminders');
      const r = startReminderJob();
      if (r && r.ok) console.log(`[reminders] scheduled (${r.schedule})`);
      else console.warn('[reminders] not scheduled:', r && r.reason);
    } catch (err) {
      console.error('[reminders] startup failed:', err && err.message);
    }

    try {
      const { startTrialNudgeJob } = require('./jobs/trial-nudge');
      const t = startTrialNudgeJob();
      if (t && t.ok) console.log(`[trial-nudge] scheduled (${t.schedule})`);
      else console.warn('[trial-nudge] not scheduled:', t && t.reason);
    } catch (err) {
      console.error('[trial-nudge] startup failed:', err && err.message);
    }
  }
});
