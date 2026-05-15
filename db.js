require('dotenv').config();
const crypto = require('crypto');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const db = {
  query: (text, params) => pool.query(text, params),

  async getUserByEmail(email) {
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    return rows[0] || null;
  },

  async getUserById(id) {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    return rows[0] || null;
  },

  async createUser({ email, password_hash, name }) {
    const { rows } = await pool.query(
      'INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING *',
      [email, password_hash, name]
    );
    return rows[0];
  },

  async updateUser(id, fields) {
    const keys = Object.keys(fields);
    const values = Object.values(fields);
    const set = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const { rows } = await pool.query(
      `UPDATE users SET ${set}, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id, ...values]
    );
    return rows[0];
  },

  async getInvoicesByUser(userId) {
    const { rows } = await pool.query(
      'SELECT * FROM invoices WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    return rows;
  },

  async getInvoiceById(id, userId) {
    const { rows } = await pool.query(
      'SELECT * FROM invoices WHERE id = $1 AND user_id = $2',
      [id, userId]
    );
    return rows[0] || null;
  },

  /*
   * Inserts the "welcome" sample invoice (#39) at signup so the new user's
   * dashboard is never empty. The row is marked `is_seed = true`, which the
   * dashboard surfaces as an Example badge + edit-me hint, and the onboarding
   * checklist ignores when counting "create your first invoice". Critically,
   * we do NOT bump users.invoice_count — the seed is a free 4th slot on the
   * free tier so the user doesn't burn a real invoice slot on the template.
   * Best-effort: callers (auth/register) wrap this in try/catch so a seed
   * failure can never block account creation.
   */
  async createSeedInvoice({ user_id }) {
    const items = [
      { description: 'Design consultation (4 hrs)', quantity: 4, unit_price: 75 }
    ];
    const subtotal = 300;
    const tax_rate = 0;
    const tax_amount = 0;
    const total = 300;
    const issued = new Date();
    const due = new Date(Date.now() + 30 * 86400000);
    const year = issued.getFullYear();
    const invoice_number = `INV-${year}-0001`;
    const { rows } = await pool.query(
      `INSERT INTO invoices
        (user_id, invoice_number, client_name, client_email, client_address,
         items, subtotal, tax_rate, tax_amount, total, notes, due_date, issued_date, is_seed)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, true)
       RETURNING *`,
      [
        user_id,
        invoice_number,
        'Sample Client (edit this)',
        'client@example.com',
        '',
        JSON.stringify(items),
        subtotal,
        tax_rate,
        tax_amount,
        total,
        'Thanks for your business! Payment due within 30 days.',
        due,
        issued
      ]
    );
    return rows[0];
  },

  async createInvoice(data) {
    const {
      user_id, invoice_number, client_name, client_email, client_address,
      items, subtotal, tax_rate, tax_amount, total, notes, due_date, issued_date
    } = data;
    const { rows } = await pool.query(
      `INSERT INTO invoices
        (user_id, invoice_number, client_name, client_email, client_address,
         items, subtotal, tax_rate, tax_amount, total, notes, due_date, issued_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [user_id, invoice_number, client_name, client_email, client_address,
       JSON.stringify(items), subtotal, tax_rate, tax_amount, total, notes, due_date, issued_date]
    );
    await pool.query('UPDATE users SET invoice_count = invoice_count + 1 WHERE id = $1', [user_id]);
    return rows[0];
  },

  async updateInvoice(id, userId, data) {
    const {
      client_name, client_email, client_address,
      items, subtotal, tax_rate, tax_amount, total, notes, due_date, issued_date, status
    } = data;
    const { rows } = await pool.query(
      `UPDATE invoices SET
        client_name=$3, client_email=$4, client_address=$5,
        items=$6, subtotal=$7, tax_rate=$8, tax_amount=$9, total=$10,
        notes=$11, due_date=$12, issued_date=$13, status=$14, updated_at=NOW()
       WHERE id=$1 AND user_id=$2 RETURNING *`,
      [id, userId, client_name, client_email, client_address,
       JSON.stringify(items), subtotal, tax_rate, tax_amount, total, notes, due_date, issued_date, status]
    );
    return rows[0] || null;
  },

  async updateInvoiceStatus(id, userId, status) {
    const { rows } = await pool.query(
      'UPDATE invoices SET status=$3, updated_at=NOW() WHERE id=$1 AND user_id=$2 RETURNING *',
      [id, userId, status]
    );
    return rows[0] || null;
  },

  async setInvoicePaymentLink(id, userId, url, linkId) {
    const { rows } = await pool.query(
      `UPDATE invoices SET payment_link_url=$3, payment_link_id=$4, updated_at=NOW()
       WHERE id=$1 AND user_id=$2 RETURNING *`,
      [id, userId, url, linkId]
    );
    return rows[0] || null;
  },

  async markInvoicePaidByPaymentLinkId(linkId) {
    const { rows } = await pool.query(
      `UPDATE invoices SET status='paid', updated_at=NOW()
       WHERE payment_link_id=$1 AND status <> 'paid' RETURNING *`,
      [linkId]
    );
    return rows[0] || null;
  },

  async deleteInvoice(id, userId) {
    const { rows } = await pool.query(
      'DELETE FROM invoices WHERE id=$1 AND user_id=$2 RETURNING id',
      [id, userId]
    );
    return rows[0] || null;
  },

  async dismissOnboarding(userId) {
    const { rows } = await pool.query(
      'UPDATE users SET onboarding_dismissed = true, updated_at = NOW() WHERE id = $1 RETURNING id',
      [userId]
    );
    return rows[0] || null;
  },

  /*
   * Returns invoices whose owner is on a paid plan, status='sent', past their
   * due date, and either never reminded or last reminded more than
   * `cooldownDays` ago. Joined to the owner so jobs/reminders.js can compose
   * the email without an extra round-trip per invoice.
   */
  async getOverdueInvoicesForReminders(cooldownDays = 3) {
    const { rows } = await pool.query(
      `SELECT
         i.id              AS invoice_id,
         i.user_id          AS user_id,
         i.invoice_number   AS invoice_number,
         i.client_name      AS client_name,
         i.client_email     AS client_email,
         i.total            AS total,
         i.due_date         AS due_date,
         i.payment_link_url AS payment_link_url,
         i.last_reminder_sent_at AS last_reminder_sent_at,
         i.items            AS items,
         u.email            AS owner_email,
         u.name             AS owner_name,
         u.business_name    AS owner_business_name,
         u.business_email   AS owner_business_email,
         u.reply_to_email   AS owner_reply_to_email,
         u.plan             AS owner_plan
       FROM invoices i
       JOIN users u ON u.id = i.user_id
       WHERE i.status = 'sent'
         AND i.due_date IS NOT NULL
         AND i.due_date < CURRENT_DATE
         AND u.plan IN ('pro', 'business', 'agency')
         AND (i.last_reminder_sent_at IS NULL
              OR i.last_reminder_sent_at < NOW() - ($1 * INTERVAL '1 day'))
       ORDER BY i.due_date ASC
       LIMIT 500`,
      [cooldownDays]
    );
    return rows;
  },

  async markInvoiceReminderSent(invoiceId) {
    const { rows } = await pool.query(
      `UPDATE invoices SET last_reminder_sent_at = NOW(), updated_at = NOW()
        WHERE id = $1 RETURNING id, last_reminder_sent_at`,
      [invoiceId]
    );
    return rows[0] || null;
  },

  /*
   * Trial-nudge query (INTERNAL_TODO #29). Returns trial users whose
   * `trial_ends_at` falls in the day-3-to-day-5 window from now and who
   * haven't been nudged yet. The `trial_nudge_sent_at IS NULL` filter is the
   * idempotency guard — every user gets exactly one nudge per trial. The
   * `subscription_status` clause keeps the cohort tight: only users still in
   * the trial state ('trialing'), or whose status was never written for any
   * reason (NULL), are eligible. Users who already added a card mid-trial
   * (`active`) or whose card failed (`past_due`) get different funnels.
   */
  async getTrialUsersNeedingNudge() {
    const { rows } = await pool.query(
      `SELECT id, email, name, business_name, trial_ends_at, invoice_count
         FROM users
        WHERE plan = 'pro'
          AND trial_ends_at IS NOT NULL
          AND trial_ends_at BETWEEN NOW() + INTERVAL '2 days'
                                AND NOW() + INTERVAL '4 days'
          AND trial_nudge_sent_at IS NULL
          AND (subscription_status IS NULL OR subscription_status = 'trialing')
        ORDER BY trial_ends_at ASC
        LIMIT 500`
    );
    return rows;
  },

  async markTrialNudgeSent(userId) {
    const { rows } = await pool.query(
      `UPDATE users SET trial_nudge_sent_at = NOW(), updated_at = NOW()
         WHERE id = $1 RETURNING id, trial_nudge_sent_at`,
      [userId]
    );
    return rows[0] || null;
  },

  /*
   * Recent paid-revenue stats for the dashboard "what you collected lately"
   * row (INTERNAL_TODO #107). Returns SUM(total), COUNT(*) and a count of
   * distinct paying clients (deduped on lowercased email-or-name) over a
   * trailing window. We use `updated_at` as the paid-time proxy because
   * `status` only flips to 'paid' once and the same UPDATE bumps
   * `updated_at`; the column drifts only if a paid invoice is later edited
   * (rare: the typical workflow ends at paid). DECIMAL columns come back
   * from pg as strings — we cast to numbers in JS so the template can
   * format and toLocaleString without re-parsing.
   */
  async getRecentRevenueStats(userId, days = 30) {
    const window = Math.max(1, Math.min(365, parseInt(days, 10) || 30));
    // Single round-trip: paid-window aggregates + a NOT-windowed
    // count of currently-unpaid invoices (status IN ('sent','overdue'))
    // used by the quiet-window recovery CTA (#127). The unpaid count is
    // not bounded by the trailing window because the CTA is about
    // follow-ups on all open invoices, not invoices opened in the last N days.
    const { rows } = await pool.query(
      `SELECT
         COALESCE(SUM(total) FILTER (WHERE status = 'paid' AND updated_at >= NOW() - ($2 * INTERVAL '1 day')), 0)::text AS total_paid,
         COUNT(*) FILTER (WHERE status = 'paid' AND updated_at >= NOW() - ($2 * INTERVAL '1 day'))::int                AS invoice_count,
         COUNT(DISTINCT LOWER(COALESCE(NULLIF(client_email, ''), client_name)))
           FILTER (WHERE status = 'paid' AND updated_at >= NOW() - ($2 * INTERVAL '1 day'))::int                       AS client_count,
         COUNT(*) FILTER (WHERE status IN ('sent', 'overdue'))::int                                                    AS unpaid_count
         FROM invoices
        WHERE user_id = $1`,
      [userId, window]
    );
    const row = rows[0] || { total_paid: '0', invoice_count: 0, client_count: 0, unpaid_count: 0 };
    return {
      days: window,
      totalPaid: parseFloat(row.total_paid) || 0,
      invoiceCount: parseInt(row.invoice_count, 10) || 0,
      clientCount: parseInt(row.client_count, 10) || 0,
      unpaidCount: parseInt(row.unpaid_count, 10) || 0
    };
  },

  /*
   * Returns up to `limit` most-recent unique clients for a user, deduplicated
   * by email-then-name. Powers the "quick-pick recent clients" dropdown on
   * the invoice form (INTERNAL_TODO #63). DISTINCT ON groups by the
   * lowercased email (or the lowercased name when email is missing) so two
   * invoices to the same address don't produce two dropdown entries even if
   * the freelancer typed the email with different casing.
   */
  async getRecentClientsForUser(userId, limit = 10) {
    const cap = Math.max(1, Math.min(50, parseInt(limit, 10) || 10));
    const { rows } = await pool.query(
      `SELECT client_name, client_email, client_address
         FROM (
           SELECT DISTINCT ON (LOWER(COALESCE(NULLIF(client_email, ''), client_name)))
                  client_name, client_email, client_address, created_at
             FROM invoices
            WHERE user_id = $1
              AND client_name IS NOT NULL
              AND client_name <> ''
            ORDER BY LOWER(COALESCE(NULLIF(client_email, ''), client_name)),
                     created_at DESC
         ) AS uniq
         ORDER BY created_at DESC
         LIMIT $2`,
      [userId, cap]
    );
    return rows;
  },

  /*
   * Records a single "what's missing?" feedback row (#145). Called from
   * POST /billing/feedback when a user submits the upgrade-modal close
   * widget. The route trims/whitelists every field before calling here; we
   * still cap message length at 1000 chars as a belt-and-braces defence
   * against a runaway TEXT write. user_id may be null for anonymous
   * pricing-page submissions.
   */
  async recordFeedbackSignal({ user_id, source, reason, message, cycle }) {
    const trimmedMessage = typeof message === 'string'
      ? message.trim().slice(0, 1000)
      : null;
    const { rows } = await pool.query(
      `INSERT INTO feedback_signals (user_id, source, reason, message, cycle)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, created_at`,
      [
        user_id || null,
        source,
        reason || null,
        trimmedMessage && trimmedMessage.length > 0 ? trimmedMessage : null,
        cycle || null
      ]
    );
    return rows[0] || null;
  },

  /*
   * Count of currently-active paid Pro/Agency subscribers used by the
   * trial-urgent banner social-proof line (#135). Restricted to
   * subscription_status='active' so we don't pad the number with trialing
   * users (who are the audience this line is shown to) or past_due/paused
   * users (who are mid-churn). The result powers a "Join N freelancers on
   * Pro" anchor; lib/pro-subscriber-count.js wraps this in a 1-hour cache
   * so the dashboard doesn't issue this query per render.
   */
  async countActiveProSubscribers() {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS count
         FROM users
        WHERE plan IN ('pro', 'agency')
          AND subscription_status = 'active'`
    );
    return parseInt(rows[0] && rows[0].count, 10) || 0;
  },

  async getNextInvoiceNumber(userId) {
    const { rows } = await pool.query(
      'SELECT COUNT(*) as count FROM invoices WHERE user_id=$1',
      [userId]
    );
    const count = parseInt(rows[0].count, 10) + 1;
    const year = new Date().getFullYear();
    return `INV-${year}-${String(count).padStart(4, '0')}`;
  },

  /*
   * Idempotently stamps users.first_paid_at the first time a user has any
   * invoice in status='paid' (#49 — first-paid celebration + referral hook).
   * Safe to call on every paid-status transition (manual flip or Stripe
   * Payment Link webhook): the WHERE first_paid_at IS NULL guard ensures the
   * UPDATE only takes effect once per user, and the EXISTS subquery prevents
   * the timestamp from being set if for some reason no paid invoice is
   * actually present (e.g. a status flip raced with a delete). Returns the
   * updated row (with first_paid_at + referral_code) when the stamp was just
   * applied, or null when the user was already stamped / has no paid invoice.
   * Callers use the non-null return as the "fire the celebration email now"
   * signal so the email goes out exactly once.
   */
  async recordFirstPaidIfMissing(userId) {
    const { rows } = await pool.query(
      `UPDATE users
          SET first_paid_at = NOW(),
              updated_at    = NOW()
        WHERE id = $1
          AND first_paid_at IS NULL
          AND EXISTS (
                SELECT 1 FROM invoices
                 WHERE user_id = $1 AND status = 'paid'
              )
        RETURNING id, email, name, plan, first_paid_at, referral_code`,
      [userId]
    );
    return rows[0] || null;
  },

  /*
   * Lazy-generates a stable referral code on first need (#49). 8 random
   * bytes → 16 hex chars; collision probability against the population is
   * negligible (2^64). UNIQUE constraint on the column means a colliding
   * INSERT would throw — caller retries on UNIQUE violation (Postgres
   * error code 23505). The COALESCE pattern means concurrent callers race
   * to the UPDATE but only one write lands; both see the same final code
   * on the follow-up SELECT.
   */
  async getOrCreateReferralCode(userId) {
    const existing = await pool.query(
      'SELECT referral_code FROM users WHERE id = $1',
      [userId]
    );
    const current = existing.rows[0] && existing.rows[0].referral_code;
    if (current) return current;
    for (let attempt = 0; attempt < 3; attempt++) {
      const code = crypto.randomBytes(8).toString('hex');
      try {
        const { rows } = await pool.query(
          `UPDATE users
              SET referral_code = $2,
                  updated_at    = NOW()
            WHERE id = $1
              AND referral_code IS NULL
            RETURNING referral_code`,
          [userId, code]
        );
        if (rows[0] && rows[0].referral_code) return rows[0].referral_code;
        // No row returned → another writer beat us; re-read.
        const reread = await pool.query(
          'SELECT referral_code FROM users WHERE id = $1',
          [userId]
        );
        if (reread.rows[0] && reread.rows[0].referral_code) {
          return reread.rows[0].referral_code;
        }
      } catch (err) {
        // 23505 = unique_violation. Generate a fresh code and try again.
        if (!err || err.code !== '23505') throw err;
      }
    }
    return null;
  },

  /*
   * Attaches users.referrer_id at signup when the visitor arrived via a
   * `?ref=<code>` link (#49). The lookup-then-set is a 2-step round-trip
   * rather than a sub-select so callers can short-circuit on bad codes
   * without holding a transaction. Self-referral (a user trying to claim
   * their own code) is silently ignored. ON DELETE SET NULL on the FK
   * preserves the historical attribution even if the referrer's account
   * is later deleted.
   */
  async attachReferrerByCode(userId, code) {
    if (!userId || !code || typeof code !== 'string') return null;
    const trimmed = code.trim().slice(0, 32);
    if (!/^[a-f0-9]{8,32}$/i.test(trimmed)) return null;
    const lookup = await pool.query(
      'SELECT id FROM users WHERE referral_code = $1',
      [trimmed]
    );
    const referrerId = lookup.rows[0] && lookup.rows[0].id;
    if (!referrerId || referrerId === userId) return null;
    const { rows } = await pool.query(
      `UPDATE users
          SET referrer_id = $2,
              updated_at  = NOW()
        WHERE id = $1
          AND referrer_id IS NULL
        RETURNING referrer_id`,
      [userId, referrerId]
    );
    return rows[0] ? rows[0].referrer_id : null;
  }
};

module.exports = { pool, db };
