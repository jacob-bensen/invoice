const express = require('express');
const { body, validationResult } = require('express-validator');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const stripePaymentLinkLib = require('../lib/stripe-payment-link');
const { createInvoicePaymentLink } = stripePaymentLinkLib;
// Test stubs may omit parsePaymentMethods — fall back to card-only.
const parsePaymentMethods = stripePaymentLinkLib.parsePaymentMethods || (() => ['card']);
const { firePaidWebhook, buildPaidPayload } = require('../lib/outbound-webhook');
const { sendInvoiceEmail, sendReferralCelebrationEmail } = require('../lib/email');
const { loadProSubscriberCount } = require('../lib/pro-subscriber-count');
const { triggerFirstPaidCelebration, buildReferralUrl } = require('../lib/celebration');
const { buildShareSurfaceForInvoice } = require('../lib/share-link');

const router = express.Router();
const FREE_LIMIT = 3;
const ALLOWED_INVOICE_STATUSES = ['draft', 'sent', 'paid', 'overdue'];
// Whitelist of windows the recent-revenue JSON endpoint accepts (#117). Any
// other value falls through to the default 30. Keeps the API surface small
// and predictable — the toggle UI only offers these three.
const RECENT_REVENUE_WINDOWS = [7, 30, 90];

router.get('/', requireAuth, async (req, res) => {
  try {
    const [invoices, user, recentRevenue, oldestStaleDraft] = await Promise.all([
      db.getInvoicesByUser(req.session.user.id),
      db.getUserById(req.session.user.id),
      loadRecentRevenueStats(req.session.user.id),
      loadOldestStaleDraft(req.session.user.id)
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
    const annualUpgradePrompt = buildAnnualUpgradePrompt(user);
    const pendingQuickInvoice = buildPendingQuickInvoiceBanner(user);
    // Pro social-proof anchor (#135): fire the cached count lookup only on
    // the final-day banner render path — earlier-trial banner variants
    // don't surface this line, so a fresh-cache miss isn't worth the
    // round-trip on day-7-through-day-2.
    const socialProof = days_left_in_trial === 1
      ? await loadProSubscriberCount(db).catch(() => null)
      : null;
    const celebration = await loadCelebration(user).catch(() => null);
    const staleDraftPrompt = buildStaleDraftPrompt(user, oldestStaleDraft);
    const firstRealInvoicePrompt = buildFirstRealInvoicePrompt(user, invoices);
    res.render('dashboard', { title: 'My Invoices', invoices, user, flash, days_left_in_trial, onboarding, invoiceLimitProgress, recentRevenue: recentRevenueCard, annualUpgradePrompt, socialProof, celebration, staleDraftPrompt, firstRealInvoicePrompt, pendingQuickInvoice, noindex: true });
  } catch (err) {
    console.error(err);
    res.render('dashboard', {
      title: 'My Invoices', invoices: [], user: req.session.user || null,
      flash: null, days_left_in_trial: 0, onboarding: null,
      invoiceLimitProgress: null, recentRevenue: null,
      annualUpgradePrompt: null, socialProof: null, celebration: null,
      staleDraftPrompt: null, firstRealInvoicePrompt: null,
      pendingQuickInvoice: null, noindex: true
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

/*
 * Decides whether to render the monthly → annual upgrade banner on the
 * dashboard (#47). The prompt is the highest-LTV move on already-paying
 * customers: switching from $12/mo to $99/yr stretches retention from a
 * monthly renewal decision to an annual one, and the freelancer saves
 * $45/year — pure win-win that compounds with each customer who flips.
 *
 * Eligibility (all must hold):
 *   - user is on the Pro plan
 *   - billing_cycle is recorded as 'monthly' (set from Stripe checkout
 *     metadata when the user first subscribed)
 *   - subscription is not in a dunning state (past_due / paused) — never
 *     stack an upsell on top of "your card failed"
 *   - trial has ended OR no trial was used (we do not nudge during trial;
 *     the trial banner owns that surface)
 *   - we have a stripe_subscription_id (needed to actually update the
 *     Stripe subscription server-side)
 *
 * Returns the prompt payload (a tiny shape the EJS template renders) or
 * null when the user is ineligible.
 */
function buildAnnualUpgradePrompt(user) {
  if (!user) return null;
  if (user.plan !== 'pro') return null;
  if (user.billing_cycle !== 'monthly') return null;
  if (user.subscription_status === 'past_due' || user.subscription_status === 'paused') return null;
  if (!user.stripe_subscription_id) return null;
  if (user.trial_ends_at) {
    const ends = new Date(user.trial_ends_at).getTime();
    if (Number.isFinite(ends) && ends > Date.now()) return null;
  }
  return {
    monthlyPrice: 12,
    annualPrice: 99,
    savingsPerYear: 45
  };
}

function buildOnboardingState(user, invoices) {
  if (!user || user.onboarding_dismissed) return null;
  const list = Array.isArray(invoices) ? invoices : [];
  // Exclude the signup-seeded sample invoice (#39) from progress counting —
  // the user hasn't "created" their first invoice until they've made a real one.
  const realInvoices = list.filter((i) => !i.is_seed);
  const businessAdded = !!(user.business_name && String(user.business_name).trim());
  const invoiceCreated = realInvoices.length >= 1;
  const invoiceSent = realInvoices.some((i) => ['sent', 'paid', 'overdue'].includes(i.status));
  const invoicePaid = realInvoices.some((i) => i.status === 'paid');
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

/*
 * Stale-draft activation prompt — bridges the milestone-2 → milestone-3
 * step of the activation funnel ("first invoice created → first invoice
 * sent"). When the user has a real (non-seed) draft invoice sitting
 * unsent for 24+ hours, the dashboard renders a yellow banner with
 * one-click Mark-as-Sent and a deep link to the invoice. The 24-hour
 * threshold filters out same-session edits and targets the actual
 * stuck-in-draft cohort.
 */
async function loadOldestStaleDraft(userId) {
  if (!userId || typeof db.getOldestStaleDraft !== 'function') return null;
  try {
    return await db.getOldestStaleDraft(userId);
  } catch (err) {
    console.error('Stale draft lookup failed:', err && err.message);
    return null;
  }
}

/*
 * Persistent "Create your first real invoice" hero (Milestone 2). The
 * signup seed (#39) gives the dashboard a populated table on day-1, but
 * the soft "this is a sample" hint stops working the moment the user
 * deletes or edits the seed: the dashboard then either falls back to the
 * legacy zero-state hero (deleted case) or shows the seed-only state with
 * no strong CTA (edited case where the seed row still reads is_seed=true).
 *
 * The gate is users.invoice_count === 0 — that counter only bumps on real
 * (non-seed) createInvoice calls, so it stays at 0 throughout the entire
 * pre-first-real-invoice cohort regardless of whether the user has the
 * seed, edited it, or deleted it. We additionally guard on "no non-seed
 * row in the rendered list" as defence-in-depth against data drift (a
 * non-seed draft existing while invoice_count is still 0 means the user
 * has already started a real invoice — the hero would hijack the wrong
 * surface).
 */
function buildFirstRealInvoicePrompt(user, invoices) {
  if (!user) return null;
  const count = parseInt(user.invoice_count, 10);
  if (!Number.isFinite(count) || count > 0) return null;
  const list = Array.isArray(invoices) ? invoices : [];
  if (list.some((i) => i && !i.is_seed)) return null;
  return { hasSeed: list.some((i) => i && i.is_seed) };
}

/*
 * "Continue your draft invoice" banner (Milestone 2 — first dashboard
 * re-entry → first real invoice created). Surfaces on the dashboard when
 * the user has an autosaved /invoices/quick draft. The payload is the raw
 * column value from db.getUserById; we re-validate the shape here because
 * legacy/migration rows or a hand-edited DB row might not match the four
 * expected string fields. Returns null if every field is empty (UI shows
 * nothing) or if the column is null / not an object.
 */
const PENDING_QUICK_MAX_LEN = 500;
const PENDING_QUICK_AMOUNT_MAX_LEN = 32;

function normalizePendingQuickInvoiceInput(body) {
  if (!body || typeof body !== 'object') return null;
  const clamp = (v, max) => {
    if (typeof v === 'string') return v.slice(0, max);
    if (typeof v === 'number' && Number.isFinite(v)) return String(v).slice(0, max);
    return '';
  };
  const payload = {
    client_name: clamp(body.client_name, PENDING_QUICK_MAX_LEN),
    client_email: clamp(body.client_email, PENDING_QUICK_MAX_LEN),
    description: clamp(body.description, PENDING_QUICK_MAX_LEN),
    amount: clamp(body.amount, PENDING_QUICK_AMOUNT_MAX_LEN)
  };
  const allEmpty = !payload.client_name.trim()
    && !payload.client_email.trim()
    && !payload.description.trim()
    && !payload.amount.trim();
  return { payload, allEmpty };
}

function readPendingQuickInvoice(user) {
  if (!user) return null;
  let raw = user.pending_quick_invoice;
  if (raw == null) return null;
  // pg returns JSONB as a parsed object by default; tolerate stringified
  // values from test stubs or legacy drivers.
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch (e) { return null; }
  }
  if (!raw || typeof raw !== 'object') return null;
  const pickStr = (v) => (typeof v === 'string' ? v : '');
  const fields = {
    client_name: pickStr(raw.client_name),
    client_email: pickStr(raw.client_email),
    description: pickStr(raw.description),
    amount: pickStr(raw.amount)
  };
  const allEmpty = !fields.client_name.trim()
    && !fields.client_email.trim()
    && !fields.description.trim()
    && !fields.amount.trim();
  if (allEmpty) return null;
  return fields;
}

function buildPendingQuickInvoiceBanner(user) {
  const fields = readPendingQuickInvoice(user);
  if (!fields) return null;
  return {
    clientName: fields.client_name.trim(),
    description: fields.description.trim(),
    amount: fields.amount.trim()
  };
}

function buildStaleDraftPrompt(user, draft) {
  if (!user || !draft || draft.id == null) return null;
  const createdMs = draft.created_at ? new Date(draft.created_at).getTime() : NaN;
  const hoursOld = Number.isFinite(createdMs)
    ? Math.max(0, Math.floor((Date.now() - createdMs) / 3600000))
    : 0;
  return {
    id: draft.id,
    invoiceNumber: draft.invoice_number || '',
    clientName: draft.client_name || '',
    total: Number(draft.total) || 0,
    hoursOld
  };
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
 * Builds the first-paid celebration banner payload (#49). Returns
 * { firstPaidAt, daysSince, referralUrl } when the user is inside the
 * 7-day window from their first paid invoice, null otherwise. Lazy-generates
 * the user's referral_code on first banner render so existing pre-#49 users
 * who just got their first paid invoice also get a code attached.
 */
const CELEBRATION_WINDOW_DAYS = 7;

async function loadCelebration(user) {
  if (!user || !user.first_paid_at) return null;
  const firstPaidMs = new Date(user.first_paid_at).getTime();
  if (!Number.isFinite(firstPaidMs)) return null;
  const ageMs = Date.now() - firstPaidMs;
  if (ageMs < 0) return null;
  const daysSince = Math.floor(ageMs / 86400000);
  if (daysSince >= CELEBRATION_WINDOW_DAYS) return null;
  let code = user.referral_code;
  if (!code && typeof db.getOrCreateReferralCode === 'function') {
    try {
      code = await db.getOrCreateReferralCode(user.id);
    } catch (err) {
      console.error('Referral code lazy-generate failed:', err && err.message);
    }
  }
  if (!code) return null;
  return {
    firstPaidAt: user.first_paid_at,
    daysSince,
    referralUrl: buildReferralUrl(code)
  };
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

/*
 * "Quick invoice" express form (Milestone 2). The full /invoices/new form is
 * the highest-friction surface in the activation funnel: client name + email
 * + address + line-items array + qty + unit price + tax rate + notes + dates
 * is a lot of typing to produce the very first invoice. The Duplicate button
 * helps repeat clients and seed-duplicators, but a brand-new user with no
 * past invoices still hits the blank-form wall.
 *
 * Quick takes three fields — client name, description, amount — and fills in
 * everything else with sensible defaults (today's date, 30-day terms, single
 * line item with qty=1, no tax, no notes, next auto-generated invoice
 * number). On submit the user lands on /invoices/:id where the share-intent
 * buttons are already prefetched and visible on first paint, so the path
 * from "I want to bill someone" to "I sent them an invoice" collapses to
 * a single form + a single share tap.
 *
 * Same FREE_LIMIT gate as POST /invoices/new (3-invoice cap on the free
 * tier). Validation mirrors the same express-validator pattern. The view
 * is plan-agnostic; free, Pro, and Agency owners all see the same form.
 */
router.get('/quick', requireAuth, async (req, res) => {
  const user = await db.getUserById(req.session.user.id);
  if (!user) return res.redirect('/auth/login');
  if (user.plan === 'free' && user.invoice_count >= FREE_LIMIT) {
    return res.redirect('/invoices?limit_hit=1');
  }
  const pending = readPendingQuickInvoice(user);
  res.render('invoice-quick', {
    title: 'Quick invoice',
    user,
    flash: null,
    submitted: pending || null,
    pendingRestored: !!pending,
    noindex: true
  });
});

/*
 * "Continue your draft invoice" autosave endpoint (Milestone 2). The
 * /invoices/quick form posts a JSON body here on every debounced input
 * change so a user who starts typing then bounces can pick up where they
 * left off — both via the form pre-fill on next GET /invoices/quick AND
 * via the dashboard "Continue your draft invoice" banner. Auth-required;
 * the in-progress draft is per-user. CSRF protected via the same
 * middleware as every other authed POST.
 *
 * The endpoint is forgiving by design: unknown fields are ignored, missing
 * fields are treated as empty strings, oversize fields are clamped at 500
 * chars (32 for amount). An all-empty payload clears the pending row
 * rather than storing { '', '', '', '' } — keeps the dashboard banner
 * from firing on a phantom draft after the user backspaces every field.
 */
router.post('/quick/autosave', requireAuth, async (req, res) => {
  try {
    const normalized = normalizePendingQuickInvoiceInput(req.body);
    if (!normalized) {
      return res.json({ ok: true, stored: false });
    }
    if (normalized.allEmpty) {
      await db.clearPendingQuickInvoice(req.session.user.id);
      return res.json({ ok: true, stored: false });
    }
    await db.setPendingQuickInvoice(req.session.user.id, normalized.payload);
    res.json({ ok: true, stored: true });
  } catch (err) {
    console.error('Quick invoice autosave error:', err && err.message);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

router.post('/quick', requireAuth, [
  body('client_name').trim().notEmpty().withMessage('Client name is required'),
  body('description').trim().notEmpty().withMessage('Describe what you did so the client recognises the bill'),
  body('amount').isFloat({ gt: 0 }).withMessage('Amount must be greater than $0')
], async (req, res) => {
  const user = await db.getUserById(req.session.user.id);
  if (!user) return res.redirect('/auth/login');
  if (user.plan === 'free' && user.invoice_count >= FREE_LIMIT) {
    return res.redirect('/invoices?limit_hit=1');
  }

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.render('invoice-quick', {
      title: 'Quick invoice',
      user,
      flash: { type: 'error', message: errors.array()[0].msg },
      submitted: {
        client_name: req.body.client_name || '',
        client_email: req.body.client_email || '',
        description: req.body.description || '',
        amount: req.body.amount || '',
        payment_instructions: req.body.payment_instructions || ''
      },
      noindex: true
    });
  }

  try {
    const amount = parseFloat(req.body.amount);
    const description = String(req.body.description).trim();
    const today = new Date();
    const issued_date = today.toISOString().split('T')[0];
    const due_date = new Date(today.getTime() + 30 * 86400000).toISOString().split('T')[0];
    const invoice_number = await db.getNextInvoiceNumber(req.session.user.id);

    const client_email = req.body.client_email ? String(req.body.client_email).trim() : null;
    const invoice = await db.createInvoice({
      user_id: req.session.user.id,
      invoice_number,
      client_name: String(req.body.client_name).trim(),
      client_email,
      client_address: null,
      items: [{ description, quantity: 1, unit_price: amount }],
      subtotal: amount,
      tax_rate: 0,
      tax_amount: 0,
      total: amount,
      notes: null,
      issued_date,
      due_date
    });

    req.session.user.invoice_count = (req.session.user.invoice_count || 0) + 1;

    // Clear the autosaved "Continue your draft invoice" payload — the
    // freelancer has now created the real invoice, so the dashboard banner
    // + the GET /invoices/quick pre-fill must stop firing. Best-effort:
    // never blocks the redirect (a stuck banner is recoverable; a 500 on
    // create is not).
    try {
      await db.clearPendingQuickInvoice(req.session.user.id);
    } catch (e) {
      console.error('Quick invoice clear pending failed:', e && e.message);
    }

    // Inline "How will your client pay you?" capture (Milestone 4 — first
    // invoice sent → first payment received). Free-tier owners with no
    // Stripe Pay button get the optional textarea on /invoices/quick; if
    // they filled it in we persist to users.payment_instructions BEFORE
    // the user reaches /invoices/:id, so the very first share link they
    // tap (the draft-send banner is one click away) already carries the
    // payment instructions on the public /i/<token> page. Gated server-
    // side on plan=free AND no existing instructions so a Pro user (who
    // has a Pay Link) or a free user who already saved instructions can't
    // accidentally overwrite via a forged payload. Best-effort: never
    // blocks the redirect.
    if (typeof req.body.payment_instructions === 'string'
        && user.plan === 'free'
        && (!user.payment_instructions || !String(user.payment_instructions).trim())) {
      const payInstr = req.body.payment_instructions.trim();
      if (payInstr.length > 0 && payInstr.length <= 2000) {
        try {
          await db.updateUser(req.session.user.id, { payment_instructions: payInstr });
        } catch (e) {
          console.error('Quick invoice payment-instructions save failed:', e && e.message);
        }
      }
    }

    // Combined create+send path: the freelancer ticked "Create & email to
    // client" on the form, which collapses the create → land on /:id →
    // click "Send by email" two-step into a single action. Gated on
    // Pro/Agency plan + a populated client_email — the view hides the
    // button otherwise; the server hard-gates here as defence-in-depth so
    // a free-tier client tampering with the form payload cannot bypass the
    // pro-lock email surface.
    const sendEmail = req.body.action === 'create_and_email'
      && (user.plan === 'pro' || user.plan === 'agency')
      && !!client_email;

    if (sendEmail) {
      let sendResult = null;
      try {
        sendResult = await sendInvoiceEmail(invoice, user);
      } catch (e) {
        console.error('Quick invoice email send threw:', e && e.message);
      }
      if (sendResult && sendResult.ok === true) {
        // Atomic draft → sent flip, matching the share-intent + /:id/email-client surfaces.
        try {
          await db.markInvoiceSentFromShareIntent(invoice.id, req.session.user.id);
        } catch (e) {
          console.error('Quick invoice status flip failed:', e && e.message);
        }
        req.session.flash = {
          type: 'success',
          message: `Invoice created and emailed to ${client_email}.`
        };
      } else {
        const reason = (sendResult && sendResult.reason) || 'send_failed';
        const copy = reason === 'not_configured'
          ? 'Invoice created, but email delivery is not configured yet. Use the share buttons below to send it.'
          : 'Invoice created, but the email could not be sent. Use the share buttons below to send it.';
        req.session.flash = { type: 'error', message: copy };
      }
      return res.redirect(`/invoices/${invoice.id}`);
    }

    req.session.flash = {
      type: 'success',
      message: 'Invoice created — share it with your client below to mark it as sent.'
    };
    return res.redirect(`/invoices/${invoice.id}`);
  } catch (err) {
    console.error('Quick invoice create error:', err && err.message);
    return res.render('invoice-quick', {
      title: 'Quick invoice',
      user,
      flash: { type: 'error', message: 'Failed to save invoice. Please try again.' },
      submitted: {
        client_name: req.body.client_name || '',
        client_email: req.body.client_email || '',
        description: req.body.description || '',
        amount: req.body.amount || '',
        payment_instructions: req.body.payment_instructions || ''
      },
      noindex: true
    });
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

    // Eagerly mint the public share token + build the share-intent surface so
    // the public-share-section on the rendered page shows the WhatsApp / SMS /
    // Email buttons immediately — no "Generate share link" click required.
    // Cuts the most common freelancer-side path through Milestones 3-4 from
    // 2 clicks to 1. Wrapped in try/catch so a transient mint failure does NOT
    // break the page render — the Generate button is still in the DOM as a
    // fallback (gated on x-show="!url") and will run the legacy lazy-mint.
    let prefetchedShare = null;
    try {
      const token = await db.getOrCreatePublicToken(invoice.id, req.session.user.id);
      if (token) {
        prefetchedShare = buildShareSurfaceForInvoice(
          Object.assign({}, invoice, { public_token: token })
        );
      }
    } catch (err) {
      console.error('Share-link prefetch failed:', err && err.message);
    }

    res.render('invoice-view', {
      title: `Invoice ${invoice.invoice_number}`,
      invoice,
      user,
      flash,
      paymentMethods,
      prefetchedShare,
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
      // First-paid celebration + referral email (#49). Idempotent — only fires
      // once per user, on the very first invoice flipped to paid.
      triggerFirstPaidCelebration(db, req.session.user.id)
        .catch(e => console.error('First-paid celebration error:', e && e.message));
    }

    req.session.flash = { type: 'success', message: `Invoice marked as ${newStatus}.` };
    res.redirect(`/invoices/${req.params.id}`);
  } catch (err) {
    console.error('Status update error:', err);
    res.redirect(`/invoices/${req.params.id}`);
  }
});

/*
 * Lazy-mints (or returns the existing) public share token for an invoice
 * and responds with the absolute /i/<token> URL the user pastes to their
 * client (#43). Open to every plan: a free user has no other in-app way
 * to deliver the invoice (no email-send, no Stripe payment link), so
 * gating the share URL was the activation funnel's biggest dead-end on
 * milestone 4. The public page still surfaces "Powered by DecentInvoice"
 * + the signup CTA on every share, and the pay-button gap on free-owner
 * pages is the upgrade pressure on every share-and-paid loop.
 * CSRF-protected via the shared middleware (POST methods require
 * X-CSRF-Token).
 */
router.post('/:id/share', requireAuth, async (req, res) => {
  try {
    const user = await db.getUserById(req.session.user.id);
    if (!user) return res.status(401).json({ error: 'auth_required' });
    const invoice = await db.getInvoiceById(req.params.id, req.session.user.id);
    if (!invoice) return res.status(404).json({ error: 'not_found' });
    const token = await db.getOrCreatePublicToken(invoice.id, req.session.user.id);
    if (!token) return res.status(500).json({ error: 'token_failed' });
    const surface = buildShareSurfaceForInvoice(
      Object.assign({}, invoice, { public_token: token })
    );
    if (!surface) return res.status(500).json({ error: 'token_failed' });
    res.set('Cache-Control', 'no-store');
    res.json({
      token,
      url: surface.url,
      shareIntents: surface.shareIntents,
      followUpIntents: surface.followUpIntents
    });
  } catch (err) {
    console.error('Share-link mint error:', err && err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

/*
 * Records that the freelancer clicked a share-intent button
 * (WhatsApp / SMS / Email / Copy) on /invoices/:id and atomically flips
 * the invoice from 'draft' to 'sent' if applicable (Milestone 3 — first
 * invoice created → first invoice sent). Counterpart to the client-view
 * auto-flip in recordPublicInvoiceView: the client-view path only fires
 * when the client opens the link, so any share that never gets opened
 * left the invoice stuck in 'draft' indefinitely — invisible to the
 * activation-funnel `sent_one` counter, kept tripping the stale-draft
 * prompt + email cron, and lied to the freelancer's dashboard about the
 * invoice's real state. The intent click is the strongest in-app
 * "definitely sent" signal we can observe on the freelancer side.
 * CSRF-protected via the shared middleware; intent kind is on a small
 * whitelist so a tampered request can't write arbitrary strings.
 * Idempotent — clicking a second time on an already-sent invoice is a
 * no-op success.
 */
const SHARE_INTENT_KINDS = new Set(['whatsapp', 'sms', 'email', 'copy', 'native']);
router.post('/:id/share-intent', requireAuth, async (req, res) => {
  try {
    const intent = (req.body && typeof req.body.intent === 'string')
      ? req.body.intent.trim().toLowerCase() : '';
    if (!SHARE_INTENT_KINDS.has(intent)) {
      return res.status(400).json({ error: 'invalid_intent' });
    }
    const invoice = await db.getInvoiceById(req.params.id, req.session.user.id);
    if (!invoice) return res.status(404).json({ error: 'not_found' });
    const row = await db.markInvoiceSentFromShareIntent(invoice.id, req.session.user.id);
    if (!row) return res.status(500).json({ error: 'update_failed' });
    const flipped = invoice.status === 'draft' && row.status === 'sent';
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, status: row.status, flipped, intent });
  } catch (err) {
    console.error('Share-intent record error:', err && err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

/*
 * One-tap server-side "Send by email" for Pro/Agency users on /invoices/:id
 * (Milestone 3 — first invoice created → first invoice sent). The existing
 * share-intent buttons all hand off to a native app (WhatsApp / Messages /
 * mailto: / OS share sheet) and rely on the user to actually hit send in
 * that other app. This endpoint short-circuits the round-trip: server
 * sends the invoice email directly via Resend (lib/email.sendInvoiceEmail)
 * and atomically flips draft → sent in the same request. One tap, real
 * delivery, no second app.
 *
 * Gates:
 *   - Auth + ownership (db.getInvoiceById's WHERE user_id filter)
 *   - Pro or Agency plan (free users see the existing pro-lock copy
 *     instead of this button — the route still hard-rejects with 402 as a
 *     defence-in-depth measure against a tampered request)
 *   - invoice.client_email present (lib.sendInvoiceEmail returns
 *     no_client_email otherwise; we surface that as a 400 so the UI can
 *     prompt the user to add a client email to the invoice)
 *
 * On success the response carries the same { flipped, status } shape as
 * /share-intent so the client-side handler can update the status badge.
 * The atomic flip uses the same markInvoiceSentFromShareIntent helper —
 * race-safe against the client-view auto-flip or a concurrent explicit
 * Mark-as-Sent. Idempotent on already-sent invoices (still re-sends the
 * email; the freelancer may have hit "client didn't receive it, send
 * again" — that's a feature, not a bug).
 */
router.post('/:id/email-client', requireAuth, async (req, res) => {
  try {
    const user = await db.getUserById(req.session.user.id);
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    if (user.plan !== 'pro' && user.plan !== 'agency') {
      return res.status(402).json({ error: 'plan_locked' });
    }
    const invoice = await db.getInvoiceById(req.params.id, req.session.user.id);
    if (!invoice) return res.status(404).json({ error: 'not_found' });
    if (!invoice.client_email) {
      return res.status(400).json({ error: 'no_client_email' });
    }

    const sendResult = await sendInvoiceEmail(invoice, user);
    if (!sendResult || sendResult.ok !== true) {
      const reason = (sendResult && sendResult.reason) || 'send_failed';
      const status = reason === 'not_configured' ? 503 : 502;
      return res.status(status).json({ error: reason });
    }

    // Atomic draft → sent flip (idempotent on already-sent invoices).
    let row = null;
    try {
      row = await db.markInvoiceSentFromShareIntent(invoice.id, req.session.user.id);
    } catch (e) {
      console.error('email-client status flip failed:', e && e.message);
    }
    const newStatus = (row && row.status) || invoice.status;
    const flipped = invoice.status === 'draft' && newStatus === 'sent';

    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true,
      status: newStatus,
      flipped,
      sent_to: invoice.client_email,
      message_id: sendResult.id || null
    });
  } catch (err) {
    console.error('email-client send error:', err && err.message);
    res.status(500).json({ error: 'server_error' });
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

/*
 * One-click duplicate: clones an owned invoice as a fresh draft so the
 * user can start from a populated form (client/items/notes/tax) instead
 * of a blank page. Most-leverage on Milestone 2 (the seed sample is the
 * obvious thing to clone-and-customize for a real client) and on repeat
 * invoicing (same client, slightly different work — the second invoice
 * onward is dramatically faster). Redirects to /edit so the user lands
 * directly in the form, customizes, and saves.
 *
 * Free-tier limit applies — duplicating a 3rd-real-invoice on the free
 * plan bounces to the limit page exactly like POST /invoices/new.
 * Cross-tenant ids no-op at the DB layer (INSERT…SELECT WHERE user_id
 * filter) and surface as a /dashboard redirect.
 */
router.post('/:id/duplicate', requireAuth, async (req, res) => {
  try {
    const user = await db.getUserById(req.session.user.id);
    if (!user) return res.redirect('/auth/login');
    if (user.plan === 'free' && user.invoice_count >= FREE_LIMIT) {
      return res.redirect('/invoices?limit_hit=1');
    }
    const source = await db.getInvoiceById(req.params.id, req.session.user.id);
    if (!source) return res.redirect('/dashboard');

    const invoice_number = await db.getNextInvoiceNumber(req.session.user.id);
    const today = new Date();
    const issued_date = today.toISOString().split('T')[0];
    const due_date = new Date(today.getTime() + 30 * 86400000).toISOString().split('T')[0];

    const created = await db.duplicateInvoice(source.id, req.session.user.id, {
      invoice_number, issued_date, due_date
    });
    if (!created) return res.redirect('/dashboard');

    req.session.user.invoice_count = (req.session.user.invoice_count || 0) + 1;
    req.session.flash = {
      type: 'success',
      message: 'Duplicated as a new draft — update the client and items, then mark it sent.'
    };
    return res.redirect(`/invoices/${created.id}/edit`);
  } catch (err) {
    console.error('Duplicate invoice error:', err && err.message);
    return res.redirect(`/invoices/${req.params.id}`);
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
module.exports.buildAnnualUpgradePrompt = buildAnnualUpgradePrompt;
module.exports.buildStaleDraftPrompt = buildStaleDraftPrompt;
module.exports.buildFirstRealInvoicePrompt = buildFirstRealInvoicePrompt;
module.exports.buildPendingQuickInvoiceBanner = buildPendingQuickInvoiceBanner;
module.exports.readPendingQuickInvoice = readPendingQuickInvoice;
module.exports.normalizePendingQuickInvoiceInput = normalizePendingQuickInvoiceInput;
module.exports.loadOldestStaleDraft = loadOldestStaleDraft;
module.exports.onboardingDismissHandler = onboardingDismissHandler;
module.exports.ALLOWED_INVOICE_STATUSES = ALLOWED_INVOICE_STATUSES;
module.exports.FREE_LIMIT = FREE_LIMIT;
module.exports.RECENT_REVENUE_WINDOWS = RECENT_REVENUE_WINDOWS;
