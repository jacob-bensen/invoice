const express = require('express');
const { body, validationResult } = require('express-validator');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const stripePaymentLinkLib = require('../lib/stripe-payment-link');
const { createInvoicePaymentLink } = stripePaymentLinkLib;
// Test stubs may omit parsePaymentMethods — fall back to card-only.
const parsePaymentMethods = stripePaymentLinkLib.parsePaymentMethods || (() => ['card']);
const { firePaidWebhook, buildPaidPayload } = require('../lib/outbound-webhook');
const { sendInvoiceEmail } = require('../lib/email');

const router = express.Router();
const FREE_LIMIT = 3;
const ALLOWED_INVOICE_STATUSES = ['draft', 'sent', 'paid', 'overdue'];
// Whitelist of windows the recent-revenue JSON endpoint accepts (#117). Any
// other value falls through to the default 30. Keeps the API surface small
// and predictable — the toggle UI only offers these three.
const RECENT_REVENUE_WINDOWS = [7, 30, 90];

router.get('/', requireAuth, async (req, res) => {
  try {
    const [invoices, user, recentRevenue] = await Promise.all([
      db.getInvoicesByUser(req.session.user.id),
      db.getUserById(req.session.user.id),
      loadRecentRevenueStats(req.session.user.id)
    ]);
    const flash = req.session.flash;
    delete req.session.flash;
    // Refresh session plan + subscription_status so the dashboard reflects
    // any webhook-driven changes (e.g. Stripe flipping the user to past_due)
    // without forcing the user to log out and back in.
    if (user) {
      req.session.user = {
        ...req.session.user,
        plan: user.plan,
        subscription_status: user.subscription_status || null,
        invoice_count: user.invoice_count,
        trial_ends_at: user.trial_ends_at || null
      };
    }
    let days_left_in_trial = 0;
    if (user && user.trial_ends_at) {
      const ends = new Date(user.trial_ends_at).getTime();
      if (!Number.isNaN(ends)) {
        days_left_in_trial = Math.max(0, Math.ceil((ends - Date.now()) / 86400000));
      }
    }
    const onboarding = buildOnboardingState(user, invoices);
    const invoiceLimitProgress = buildInvoiceLimitProgress(user);
    const recentRevenueCard = buildRecentRevenueCard(user, recentRevenue);
    res.render('dashboard', { title: 'My Invoices', invoices, user, flash, days_left_in_trial, onboarding, invoiceLimitProgress, recentRevenue: recentRevenueCard, noindex: true });
  } catch (err) {
    console.error(err);
    res.render('dashboard', {
      title: 'My Invoices', invoices: [], user: req.session.user || null,
      flash: null, days_left_in_trial: 0, onboarding: null,
      invoiceLimitProgress: null, recentRevenue: null, noindex: true
    });
  }
});

function buildInvoiceLimitProgress(user) {
  if (!user || user.plan !== 'free') return null;
  const used = Math.max(0, parseInt(user.invoice_count, 10) || 0);
  const max = FREE_LIMIT;
  const cappedUsed = Math.min(used, max);
  const percent = max > 0 ? Math.round((cappedUsed / max) * 100) : 0;
  const remaining = Math.max(0, max - used);
  const atLimit = used >= max;
  const nearLimit = !atLimit && remaining <= 1;
  return { used, max, percent, remaining, atLimit, nearLimit };
}

function buildOnboardingState(user, invoices) {
  if (!user || user.onboarding_dismissed) return null;
  const list = Array.isArray(invoices) ? invoices : [];
  const businessAdded = !!(user.business_name && String(user.business_name).trim());
  const invoiceCreated = list.length >= 1;
  const invoiceSent = list.some((i) => ['sent', 'paid', 'overdue'].includes(i.status));
  const invoicePaid = list.some((i) => i.status === 'paid');
  const steps = [
    { key: 'business', label: 'Add your business info', href: '/billing/settings', done: businessAdded },
    { key: 'create', label: 'Create your first invoice', href: '/invoices/new', done: invoiceCreated },
    { key: 'send', label: 'Send an invoice to a client', href: '/invoices', done: invoiceSent },
    { key: 'paid', label: 'Get paid', href: '/invoices', done: invoicePaid }
  ];
  const completed = steps.filter((s) => s.done).length;
  const allDone = completed === steps.length;
  return { steps, completed, total: steps.length, allDone };
}

async function loadRecentClients(userId) {
  try {
    const rows = await db.getRecentClientsForUser(userId, 10);
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    console.error('Recent clients lookup failed:', err && err.message);
    return [];
  }
}

async function loadRecentRevenueStats(userId, days = 30) {
  try {
    return await db.getRecentRevenueStats(userId, days);
  } catch (err) {
    console.error('Recent revenue stats lookup failed:', err && err.message);
    return null;
  }
}

/*
 * Decides whether to show the last-N-days "what you collected" card on the
 * dashboard (INTERNAL_TODO #107). Hidden for free users and for anyone who
 * has zero paid invoices in the window — the card is a positive-momentum
 * surface, not an empty-state nag. `stats` is whatever loadRecentRevenueStats
 * returned (object on success, null on DB failure or missing user).
 */
function buildRecentRevenueCard(user, stats) {
  if (!user) return null;
  if (user.plan === 'free') return null;
  if (!stats || typeof stats !== 'object') return null;
  const totalPaid = Number(stats.totalPaid) || 0;
  const invoiceCount = parseInt(stats.invoiceCount, 10) || 0;
  const clientCount = parseInt(stats.clientCount, 10) || 0;
  const unpaidCount = parseInt(stats.unpaidCount, 10) || 0;
  // Card stays gated on having at least one paid invoice in the window —
  // the 30d default determines whether the card appears at all on SSR.
  // unpaidCount is threaded through so toggle re-fetches can drive the
  // quiet-window recovery CTA (#127) when the user toggles to a window
  // with totalPaid===0 but has open unpaid invoices to follow up on.
  if (invoiceCount === 0) return null;
  return {
    days: parseInt(stats.days, 10) || 30,
    totalPaid,
    invoiceCount,
    clientCount,
    unpaidCount
  };
}

/*
 * JSON endpoint that powers the dashboard's recent-revenue window toggle
 * (INTERNAL_TODO #117). Reuses the same db.getRecentRevenueStats helper +
 * buildRecentRevenueCard render shape used by the SSR dashboard. Days arg
 * is whitelisted to [7, 30, 90] — any other value (including 0, negative,
 * or out-of-range) falls back to 30. Free-plan users get a 200 with
 * `card: null` so the client can hide the card without a 4xx error
 * branch; this matches the SSR behaviour (free → null card) exactly.
 *
 * Mounted before /:id so 'api' isn't matched as an invoice id.
 */
router.get('/api/recent-revenue', requireAuth, async (req, res) => {
  const requested = parseInt(req.query.days, 10);
  const days = RECENT_REVENUE_WINDOWS.includes(requested) ? requested : 30;
  try {
    const [user, stats] = await Promise.all([
      db.getUserById(req.session.user.id),
      loadRecentRevenueStats(req.session.user.id, days)
    ]);
    const card = buildRecentRevenueCard(user, stats);
    // Surface unpaidCount at the top level too, so the quiet-window
    // recovery CTA (#127) can fire even when card===null (i.e. when
    // invoiceCount===0 in this window — buildRecentRevenueCard returns
    // null in that case but the user may still have open unpaid invoices
    // worth following up on).
    const unpaidCount = stats && typeof stats === 'object'
      ? parseInt(stats.unpaidCount, 10) || 0
      : 0;
    res.set('Cache-Control', 'no-store');
    res.json({ days, card, unpaidCount });
  } catch (err) {
    console.error('Recent revenue API error:', err && err.message);
    res.status(500).json({ days, card: null, error: 'lookup_failed' });
  }
});

router.get('/new', requireAuth, async (req, res) => {
  const user = await db.getUserById(req.session.user.id);
  if (!user) return res.redirect('/auth/login');
  if (user.plan === 'free' && user.invoice_count >= FREE_LIMIT) {
    return res.redirect('/invoices?limit_hit=1');
  }
  const [invoiceNumber, recentClients] = await Promise.all([
    db.getNextInvoiceNumber(req.session.user.id),
    loadRecentClients(req.session.user.id)
  ]);
  res.render('invoice-form', {
    title: 'New Invoice',
    invoice: null,
    invoiceNumber,
    recentClients,
    user,
    flash: null,
    noindex: true
  });
});

router.post('/new', requireAuth, [
  body('client_name').trim().notEmpty().withMessage('Client name is required'),
  body('items').notEmpty().withMessage('At least one line item is required')
], async (req, res) => {
  const user = await db.getUserById(req.session.user.id);
  if (!user) return res.redirect('/auth/login');
  if (user.plan === 'free' && user.invoice_count >= FREE_LIMIT) {
    return res.redirect('/invoices?limit_hit=1');
  }

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const [invoiceNumber, recentClients] = await Promise.all([
      db.getNextInvoiceNumber(req.session.user.id),
      loadRecentClients(req.session.user.id)
    ]);
    return res.render('invoice-form', {
      title: 'New Invoice',
      invoice: null, invoiceNumber, recentClients, user,
      flash: { type: 'error', message: errors.array()[0].msg },
      noindex: true
    });
  }

  try {
    let items = [];
    try { items = JSON.parse(req.body.items); } catch (_) {}

    const subtotal = parseFloat(req.body.subtotal) || 0;
    const tax_rate = parseFloat(req.body.tax_rate) || 0;
    const tax_amount = parseFloat(req.body.tax_amount) || 0;
    const total = parseFloat(req.body.total) || 0;

    const invoice = await db.createInvoice({
      user_id: req.session.user.id,
      invoice_number: req.body.invoice_number,
      client_name: req.body.client_name,
      client_email: req.body.client_email || null,
      client_address: req.body.client_address || null,
      items, subtotal, tax_rate, tax_amount, total,
      notes: req.body.notes || null,
      issued_date: req.body.issued_date || new Date().toISOString().split('T')[0],
      due_date: req.body.due_date || null
    });

    req.session.user.invoice_count = (req.session.user.invoice_count || 0) + 1;
    res.redirect(`/invoices/${invoice.id}`);
  } catch (err) {
    console.error('Create invoice error:', err);
    const [invoiceNumber, recentClients] = await Promise.all([
      db.getNextInvoiceNumber(req.session.user.id),
      loadRecentClients(req.session.user.id)
    ]);
    res.render('invoice-form', {
      title: 'New Invoice', invoice: null, invoiceNumber, recentClients, user,
      flash: { type: 'error', message: 'Failed to save invoice. Please try again.' },
      noindex: true
    });
  }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const invoice = await db.getInvoiceById(req.params.id, req.session.user.id);
    if (!invoice) return res.redirect('/dashboard');
    const user = await db.getUserById(req.session.user.id);
    const flash = req.session.flash;
    delete req.session.flash;
    const paymentMethods = parsePaymentMethods(process.env.STRIPE_PAYMENT_METHODS);
    res.render('invoice-view', {
      title: `Invoice ${invoice.invoice_number}`,
      invoice,
      user,
      flash,
      paymentMethods,
      noindex: true
    });
  } catch (err) {
    console.error(err);
    res.redirect('/dashboard');
  }
});

router.get('/:id/print', requireAuth, async (req, res) => {
  try {
    const invoice = await db.getInvoiceById(req.params.id, req.session.user.id);
    if (!invoice) return res.redirect('/dashboard');
    const user = await db.getUserById(req.session.user.id);
    res.render('invoice-print', { title: `Invoice ${invoice.invoice_number}`, invoice, user, noindex: true });
  } catch (err) {
    console.error(err);
    res.redirect('/dashboard');
  }
});

router.get('/:id/edit', requireAuth, async (req, res) => {
  try {
    const invoice = await db.getInvoiceById(req.params.id, req.session.user.id);
    if (!invoice) return res.redirect('/dashboard');
    const [user, recentClients] = await Promise.all([
      db.getUserById(req.session.user.id),
      loadRecentClients(req.session.user.id)
    ]);
    res.render('invoice-form', {
      title: 'Edit Invoice', invoice, invoiceNumber: invoice.invoice_number,
      recentClients, user, flash: null, noindex: true
    });
  } catch (err) {
    res.redirect('/dashboard');
  }
});

router.post('/:id/edit', requireAuth, async (req, res) => {
  try {
    let items = [];
    try { items = JSON.parse(req.body.items); } catch (_) {}

    const requestedStatus = req.body.status || 'draft';
    if (!ALLOWED_INVOICE_STATUSES.includes(requestedStatus)) {
      req.session.flash = { type: 'error', message: 'Invalid invoice status.' };
      return res.redirect(`/invoices/${req.params.id}/edit`);
    }

    await db.updateInvoice(req.params.id, req.session.user.id, {
      client_name: req.body.client_name,
      client_email: req.body.client_email || null,
      client_address: req.body.client_address || null,
      items,
      subtotal: parseFloat(req.body.subtotal) || 0,
      tax_rate: parseFloat(req.body.tax_rate) || 0,
      tax_amount: parseFloat(req.body.tax_amount) || 0,
      total: parseFloat(req.body.total) || 0,
      notes: req.body.notes || null,
      issued_date: req.body.issued_date,
      due_date: req.body.due_date || null,
      status: requestedStatus
    });

    res.redirect(`/invoices/${req.params.id}`);
  } catch (err) {
    console.error('Update invoice error:', err);
    res.redirect(`/invoices/${req.params.id}/edit`);
  }
});

router.post('/:id/status', requireAuth, async (req, res) => {
  try {
    const newStatus = req.body.status;
    if (!ALLOWED_INVOICE_STATUSES.includes(newStatus)) {
      req.session.flash = { type: 'error', message: 'Invalid invoice status.' };
      return res.redirect(`/invoices/${req.params.id}`);
    }
    const updated = await db.updateInvoiceStatus(req.params.id, req.session.user.id, newStatus);

    if (updated && newStatus === 'sent') {
      const user = await db.getUserById(req.session.user.id);
      if (user && (user.plan === 'pro' || user.plan === 'agency')) {
        if (!updated.payment_link_url) {
          try {
            const link = await createInvoicePaymentLink(updated, user);
            if (link && link.url) {
              await db.setInvoicePaymentLink(updated.id, user.id, link.url, link.id);
              updated.payment_link_url = link.url;
              updated.payment_link_id = link.id;
            }
          } catch (e) {
            console.error('Payment Link creation failed:', e.message);
          }
        }
        // Pro/Agency: send the invoice to the client by email. Fire-and-forget;
        // a Resend outage must never block the redirect or break the flow.
        if (updated.client_email) {
          sendInvoiceEmail(updated, user)
            .then(r => {
              if (!r.ok && r.reason !== 'not_configured') {
                console.warn(`Invoice email to ${updated.client_email} failed:`, r.reason || r.error);
              }
            })
            .catch(e => console.error('Invoice email error:', e && e.message));
        }
      }
    }

    if (updated && newStatus === 'paid') {
      const user = await db.getUserById(req.session.user.id);
      if (user && (user.plan === 'pro' || user.plan === 'agency') && user.webhook_url) {
        // Fire and forget — do not block the response on the outbound HTTP call.
        firePaidWebhook(user.webhook_url, buildPaidPayload(updated))
          .then(r => { if (!r.ok) console.warn(`webhook ${user.webhook_url} failed:`, r.reason || r.status); })
          .catch(e => console.error('Outbound webhook error:', e && e.message));
      }
    }

    req.session.flash = { type: 'success', message: `Invoice marked as ${newStatus}.` };
    res.redirect(`/invoices/${req.params.id}`);
  } catch (err) {
    console.error('Status update error:', err);
    res.redirect(`/invoices/${req.params.id}`);
  }
});

router.post('/:id/delete', requireAuth, async (req, res) => {
  try {
    await db.deleteInvoice(req.params.id, req.session.user.id);
    req.session.flash = { type: 'success', message: 'Invoice deleted.' };
    res.redirect('/dashboard');
  } catch (err) {
    res.redirect('/dashboard');
  }
});

async function onboardingDismissHandler(req, res) {
  try {
    if (!req.session || !req.session.user) return res.redirect('/auth/login');
    await db.dismissOnboarding(req.session.user.id);
    req.session.user = { ...req.session.user, onboarding_dismissed: true };
  } catch (err) {
    console.error('Onboarding dismiss error:', err);
  }
  return res.redirect('/invoices');
}

module.exports = router;
module.exports.buildOnboardingState = buildOnboardingState;
module.exports.buildInvoiceLimitProgress = buildInvoiceLimitProgress;
module.exports.buildRecentRevenueCard = buildRecentRevenueCard;
module.exports.onboardingDismissHandler = onboardingDismissHandler;
module.exports.ALLOWED_INVOICE_STATUSES = ALLOWED_INVOICE_STATUSES;
module.exports.FREE_LIMIT = FREE_LIMIT;
module.exports.RECENT_REVENUE_WINDOWS = RECENT_REVENUE_WINDOWS;
