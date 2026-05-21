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

  /*
   * "Continue your draft invoice" recovery (Milestone 2). Persists the
   * in-progress /invoices/quick form fields server-side on every debounced
   * keystroke so a user who starts typing then bounces can resume on next
   * visit (form pre-fill + dashboard banner). Payload is the same 4-field
   * shape the route normalizes — strings only, length-clamped at the call
   * site. NULL payload clears the row (same effect as clearPendingQuickInvoice
   * but kept distinct for caller clarity).
   */
  async setPendingQuickInvoice(userId, payload) {
    const json = (payload && typeof payload === 'object') ? JSON.stringify(payload) : null;
    await pool.query(
      `UPDATE users
         SET pending_quick_invoice = $2::jsonb,
             pending_quick_invoice_updated_at = NOW(),
             updated_at = NOW()
       WHERE id = $1`,
      [userId, json]
    );
  },

  async clearPendingQuickInvoice(userId) {
    await pool.query(
      `UPDATE users
         SET pending_quick_invoice = NULL,
             pending_quick_invoice_updated_at = NULL,
             updated_at = NOW()
       WHERE id = $1`,
      [userId]
    );
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

  /*
   * Atomically duplicates an owned invoice as a fresh draft so a freelancer
   * can one-click clone the seed sample (Milestone 2) or any past invoice
   * for a repeat client (Milestone 3/4) instead of re-entering line items,
   * notes, and tax-rate by hand. Owner-gated by user_id in the INSERT…SELECT
   * WHERE clause; a cross-tenant id returns null without any write.
   *
   * The copy preserves the parts a freelancer almost always wants again
   * (client_name, client_email, client_address, items, subtotal, tax_rate,
   * tax_amount, total, notes) and resets the lifecycle bookkeeping the new
   * draft must start clean on (status='draft', is_seed=false,
   * payment_link_url/_id, public_token, view_count/first_viewed_at/
   * last_viewed_at, sent_via_share_*_at, payment_claim_*, last_reminder_sent_at).
   * issued_date + due_date come from the caller so a duplicate of a
   * 6-month-old invoice doesn't show up dated to last spring.
   *
   * The invoice_count bump runs in the same transaction so a partial-failure
   * (insert succeeds, count update throws) doesn't strand the user with an
   * un-counted real invoice — both go through together or neither does.
   */
  async duplicateInvoice(sourceId, userId, { invoice_number, issued_date, due_date }) {
    if (!sourceId || !userId || !invoice_number) return null;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO invoices (
           user_id, invoice_number, client_name, client_email, client_address,
           items, subtotal, tax_rate, tax_amount, total, notes,
           issued_date, due_date, status, is_seed
         )
         SELECT
           user_id, $3, client_name, client_email, client_address,
           items, subtotal, tax_rate, tax_amount, total, notes,
           $4, $5, 'draft', false
         FROM invoices
         WHERE id = $1 AND user_id = $2
         RETURNING *`,
        [sourceId, userId, invoice_number, issued_date, due_date]
      );
      if (!rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      await client.query(
        'UPDATE users SET invoice_count = invoice_count + 1 WHERE id = $1',
        [userId]
      );
      await client.query('COMMIT');
      return rows[0];
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw err;
    } finally {
      client.release();
    }
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
   * Returns the user's oldest real draft invoice that has been sitting
   * unsent for at least `minAgeHours`. Powers the dashboard stale-draft
   * "send your invoice" prompt — the bridge between activation milestones
   * "first invoice created" and "first invoice sent" on the trial→paid
   * funnel. The seed-on-signup sample (is_seed=true) is excluded so the
   * banner only fires on something the user actually started.
   */
  async getOldestStaleDraft(userId, minAgeHours = 24) {
    if (!userId) return null;
    const hours = Number.isFinite(minAgeHours) && minAgeHours > 0
      ? Math.floor(minAgeHours)
      : 24;
    const { rows } = await pool.query(
      `SELECT id, invoice_number, client_name, total, created_at
         FROM invoices
        WHERE user_id = $1
          AND status = 'draft'
          AND is_seed = false
          AND created_at <= NOW() - ($2 * INTERVAL '1 hour')
        ORDER BY created_at ASC
        LIMIT 1`,
      [userId, hours]
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
   * Stale-draft email cron query. Picks up one row per user whose oldest real
   * draft (status='draft', is_seed=false) has been sitting for at least
   * `minAgeHours` and who hasn't received a stale-draft email in the last
   * `cooldownDays`. Welcome email must have fired (welcome_email_sent_at IS
   * NOT NULL) so a freshly-signed-up user gets the welcome before this nudge.
   *
   * DISTINCT ON (i.user_id) bound to ORDER BY (user_id, created_at ASC)
   * guarantees we surface the OLDEST draft per user — the one with the most
   * urgency to push toward "send" — and only one row per user even if they
   * have a backlog of multiple stale drafts.
   */
  async getUsersWithStaleDraftForEmail(minAgeHours = 24, cooldownDays = 7) {
    const hours = Number.isFinite(minAgeHours) && minAgeHours > 0
      ? Math.floor(minAgeHours)
      : 24;
    const cooldown = Number.isFinite(cooldownDays) && cooldownDays > 0
      ? Math.floor(cooldownDays)
      : 7;
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (i.user_id)
         i.user_id        AS user_id,
         i.id             AS invoice_id,
         i.invoice_number AS invoice_number,
         i.client_name    AS client_name,
         i.total          AS invoice_total,
         i.created_at     AS draft_created_at,
         u.email          AS email,
         u.name           AS name,
         u.business_name  AS business_name,
         u.reply_to_email AS reply_to_email,
         u.business_email AS business_email
       FROM invoices i
       JOIN users u ON u.id = i.user_id
       WHERE i.status = 'draft'
         AND i.is_seed = false
         AND i.created_at <= NOW() - ($1 * INTERVAL '1 hour')
         AND u.email IS NOT NULL
         AND u.welcome_email_sent_at IS NOT NULL
         AND (u.stale_draft_email_sent_at IS NULL
              OR u.stale_draft_email_sent_at < NOW() - ($2 * INTERVAL '1 day'))
       ORDER BY i.user_id, i.created_at ASC
       LIMIT 500`,
      [hours, cooldown]
    );
    return rows;
  },

  async markStaleDraftEmailSent(userId) {
    if (!userId) return null;
    const { rows } = await pool.query(
      `UPDATE users SET stale_draft_email_sent_at = NOW(), updated_at = NOW()
         WHERE id = $1 RETURNING id, stale_draft_email_sent_at`,
      [userId]
    );
    return rows[0] || null;
  },

  /*
   * No-invoice-nudge cron query. Picks up users who got the welcome email,
   * are at least `minAgeHours` past signup, still have `invoice_count = 0`
   * (the seed insert deliberately skips that bump, so this is a clean "no
   * real invoice ever created" gate), and haven't been nudged yet. Bounded
   * batch so a backlog of legacy users doesn't blast SMTP on a single tick.
   */
  async getUsersForNoInvoiceNudge(minAgeHours = 48) {
    const hours = Number.isFinite(minAgeHours) && minAgeHours > 0
      ? Math.floor(minAgeHours)
      : 48;
    const { rows } = await pool.query(
      `SELECT id, email, name, business_name, reply_to_email, business_email, created_at
         FROM users
        WHERE invoice_count = 0
          AND email IS NOT NULL
          AND welcome_email_sent_at IS NOT NULL
          AND no_invoice_nudge_sent_at IS NULL
          AND created_at <= NOW() - ($1 * INTERVAL '1 hour')
        ORDER BY created_at ASC
        LIMIT 500`,
      [hours]
    );
    return rows;
  },

  async markNoInvoiceNudgeSent(userId) {
    if (!userId) return null;
    const { rows } = await pool.query(
      `UPDATE users SET no_invoice_nudge_sent_at = NOW(), updated_at = NOW()
         WHERE id = $1
           AND no_invoice_nudge_sent_at IS NULL
         RETURNING id, no_invoice_nudge_sent_at`,
      [userId]
    );
    return rows[0] || null;
  },

  /*
   * Second no-invoice nudge cron query. Mirrors getUsersForNoInvoiceNudge but
   * for the day-7+ cohort still at invoice_count = 0 — recovers users who
   * either ignored the 48h nudge or missed it entirely (RESEND_API_KEY unset
   * when their first nudge tick ran). One-shot: `second_no_invoice_nudge_sent_at
   * IS NULL` so the second nudge never repeats either.
   *
   * The `no_invoice_nudge_sent_at IS NULL OR < NOW() - 4d` clause prevents the
   * first and second nudge from going out on the same cron day for users
   * whose initial nudge was delayed (e.g. RESEND configured retroactively).
   * The 4-day inner gap is the smallest window that's bigger than the
   * 48h-vs-7d cohort gap, so under normal operation the second nudge always
   * lands at least 4 days after the first.
   */
  async getUsersForSecondNoInvoiceNudge(minAgeHours = 168) {
    const hours = Number.isFinite(minAgeHours) && minAgeHours > 0
      ? Math.floor(minAgeHours)
      : 168;
    const { rows } = await pool.query(
      `SELECT id, email, name, business_name, reply_to_email, business_email, created_at
         FROM users
        WHERE invoice_count = 0
          AND email IS NOT NULL
          AND welcome_email_sent_at IS NOT NULL
          AND second_no_invoice_nudge_sent_at IS NULL
          AND created_at <= NOW() - ($1 * INTERVAL '1 hour')
          AND (no_invoice_nudge_sent_at IS NULL
               OR no_invoice_nudge_sent_at <= NOW() - INTERVAL '4 days')
        ORDER BY created_at ASC
        LIMIT 500`,
      [hours]
    );
    return rows;
  },

  async markSecondNoInvoiceNudgeSent(userId) {
    if (!userId) return null;
    const { rows } = await pool.query(
      `UPDATE users SET second_no_invoice_nudge_sent_at = NOW(), updated_at = NOW()
         WHERE id = $1
           AND second_no_invoice_nudge_sent_at IS NULL
         RETURNING id, second_no_invoice_nudge_sent_at`,
      [userId]
    );
    return rows[0] || null;
  },

  /*
   * Overdue-invoice freelancer digest query (Milestone 4 — first invoice sent
   * → first payment received). Aggregates one row per user whose sent
   * invoices are past their due_date, returning counts + totals + the
   * oldest due date so the digest email can render "you have N overdue
   * invoices worth $X, oldest due M days ago" without a second round-trip.
   *
   * Gating:
   *   - `i.status = 'sent'` only (paid + draft excluded by definition).
   *   - `i.due_date < CURRENT_DATE` — server-side overdue check, no client
   *     timezone leakage. CURRENT_DATE rolls over at UTC midnight, matching
   *     the cron's UTC schedule.
   *   - `u.welcome_email_sent_at IS NOT NULL` — activation ordering. A user
   *     who hasn't been welcomed (legacy migration) shouldn't get an
   *     overdue-digest before the welcome.
   *   - `u.email IS NOT NULL` — defence-in-depth (the per-row email guard
   *     in the orchestrator catches this too).
   *   - Cooldown: `overdue_digest_sent_at IS NULL` OR last-sent > N days ago.
   *     7-day default so a chronic backlog isn't spammed daily.
   *
   * NOT plan-gated. The freelancer-side pull-back is independent of paid
   * status — free users get it because they have no client-side reminder
   * cron, Pro users get it because (a) it complements client-side reminders
   * that are skipped when client_email is missing, and (b) returning to the
   * dashboard re-exposes them to the conversion machinery.
   *
   * LIMIT 500 bounds the cron tick. ORDER BY MIN(i.due_date) ASC drains the
   * most-overdue backlog first.
   */
  async getUsersWithOverdueInvoicesForDigest(cooldownDays = 7) {
    const cooldown = Number.isFinite(cooldownDays) && cooldownDays > 0
      ? Math.floor(cooldownDays)
      : 7;
    const { rows } = await pool.query(
      `SELECT
         u.id              AS user_id,
         u.email           AS email,
         u.name            AS name,
         u.business_name   AS business_name,
         u.reply_to_email  AS reply_to_email,
         u.business_email  AS business_email,
         u.plan            AS plan,
         COUNT(i.id)::int  AS overdue_count,
         COALESCE(SUM(i.total), 0)::text AS overdue_total,
         MIN(i.due_date)   AS oldest_due_date,
         MAX(i.due_date)   AS newest_due_date
       FROM users u
       JOIN invoices i ON i.user_id = u.id
       WHERE i.status = 'sent'
         AND i.due_date IS NOT NULL
         AND i.due_date < CURRENT_DATE
         AND u.email IS NOT NULL
         AND u.welcome_email_sent_at IS NOT NULL
         AND (u.overdue_digest_sent_at IS NULL
              OR u.overdue_digest_sent_at < NOW() - ($1 * INTERVAL '1 day'))
       GROUP BY u.id, u.email, u.name, u.business_name, u.reply_to_email,
                u.business_email, u.plan
       ORDER BY MIN(i.due_date) ASC
       LIMIT 500`,
      [cooldown]
    );
    return rows;
  },

  async markOverdueDigestSent(userId) {
    if (!userId) return null;
    const { rows } = await pool.query(
      `UPDATE users SET overdue_digest_sent_at = NOW(), updated_at = NOW()
         WHERE id = $1
         RETURNING id, overdue_digest_sent_at`,
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
   * Idempotently stamps users.welcome_email_sent_at the first time the
   * post-signup welcome email fires. Single SQL UPDATE guarded on the column
   * being NULL — concurrent callers race on the row lock and exactly one
   * sees rows[0] returned (the others see []), so the email is sent at most
   * once per user even if /auth/register were retriggered or a future
   * catch-up job re-enters this path. Returns the post-stamp user row when
   * the email should be sent now, or null when the welcome was already sent.
   */
  async markWelcomeEmailSent(userId) {
    if (!userId) return null;
    const { rows } = await pool.query(
      `UPDATE users
          SET welcome_email_sent_at = NOW(),
              updated_at            = NOW()
        WHERE id = $1
          AND welcome_email_sent_at IS NULL
        RETURNING id, email, name, business_name, business_email, reply_to_email, plan`,
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
  },

  /*
   * Idempotent one-shot for the referrer's free-month redemption (#50). Called
   * from the Stripe `checkout.session.completed` (mode=subscription) webhook
   * the moment a referred user's Pro subscription is created. The CTE-style
   * UPDATE-then-SELECT pattern stamps `referral_credited_at = NOW()` exactly
   * once (guarded on `referral_credited_at IS NULL AND referrer_id IS NOT NULL`)
   * and returns the referrer's `stripe_subscription_id` + email in the same
   * round-trip. Replays of the same webhook (Stripe retries up to 16x over 3
   * days) all see the WHERE clause fail and return `{ rows: [] }` → null,
   * so the caller's Stripe `subscriptions.update` is never invoked twice.
   */
  /*
   * Lazy-generates a stable public-share token for an invoice (#43). Token is
   * 16 hex chars (8 random bytes) — same shape as referral codes, opaque
   * enough that enumeration is intractable (2^64). Scoped by user_id so a
   * caller can't mint a token on someone else's invoice. UNIQUE constraint
   * means a colliding INSERT throws 23505 — we retry with a fresh code.
   * The COALESCE pattern handles concurrent callers: both race the UPDATE,
   * only one write lands, both see the same final token on the follow-up
   * SELECT.
   */
  async getOrCreatePublicToken(invoiceId, userId) {
    if (!invoiceId || !userId) return null;
    const existing = await pool.query(
      'SELECT public_token FROM invoices WHERE id = $1 AND user_id = $2',
      [invoiceId, userId]
    );
    if (!existing.rows[0]) return null;
    const current = existing.rows[0].public_token;
    if (current) return current;
    for (let attempt = 0; attempt < 3; attempt++) {
      const token = crypto.randomBytes(8).toString('hex');
      try {
        const { rows } = await pool.query(
          `UPDATE invoices
              SET public_token = $3,
                  updated_at    = NOW()
            WHERE id = $1
              AND user_id = $2
              AND public_token IS NULL
            RETURNING public_token`,
          [invoiceId, userId, token]
        );
        if (rows[0] && rows[0].public_token) return rows[0].public_token;
        const reread = await pool.query(
          'SELECT public_token FROM invoices WHERE id = $1 AND user_id = $2',
          [invoiceId, userId]
        );
        if (reread.rows[0] && reread.rows[0].public_token) {
          return reread.rows[0].public_token;
        }
      } catch (err) {
        if (!err || err.code !== '23505') throw err;
      }
    }
    return null;
  },

  /*
   * Fetches an invoice + the owner's branding fields for a public, no-auth
   * render at /i/:token (#43). Token format is strictly enforced before the
   * round-trip — anything that's not 8-32 hex chars short-circuits to null
   * so a probing crawler doesn't pay the SQL cost. Joins users so the
   * public template can render the owner's business name / address / email
   * without a second query, and exposes plan + payment_link_url so the
   * template can conditionally show a Pay-now button (Pro/Agency only).
   */
  async getInvoiceByPublicToken(token) {
    if (!token || typeof token !== 'string') return null;
    const trimmed = token.trim();
    if (!/^[a-f0-9]{8,32}$/i.test(trimmed)) return null;
    const { rows } = await pool.query(
      `SELECT
         i.id, i.invoice_number, i.client_name, i.client_email, i.client_address,
         i.items, i.subtotal, i.tax_rate, i.tax_amount, i.total, i.notes,
         i.status, i.issued_date, i.due_date,
         i.payment_link_url, i.public_token, i.is_seed,
         i.payment_claimed_at, i.payment_claim_method, i.payment_claim_reference,
         u.id              AS owner_id,
         u.name            AS owner_name,
         u.email           AS owner_email,
         u.reply_to_email  AS owner_reply_to_email,
         u.business_name   AS owner_business_name,
         u.business_address AS owner_business_address,
         u.business_email   AS owner_business_email,
         u.business_phone   AS owner_business_phone,
         u.payment_instructions AS owner_payment_instructions,
         u.plan            AS owner_plan
         FROM invoices i
         JOIN users u ON u.id = i.user_id
        WHERE i.public_token = $1`,
      [trimmed]
    );
    return rows[0] || null;
  },

  /*
   * Stamps a client-side view on a shared invoice (Milestone 4 — sent → paid)
   * AND atomically auto-transitions the invoice from 'draft' → 'sent' the
   * first time a real client opens the public /i/<token> URL (Milestone 3 —
   * first invoice created → first invoice sent). The auto-transition closes
   * the activation-funnel gap where a user generates the share link, sends
   * it via WhatsApp/SMS/Email, and never clicks Mark-as-Sent — the
   * dashboard then shows the invoice as 'draft', stale-draft prompts keep
   * firing on already-shared invoices, and the operator activation-funnel
   * report's `sent_one` counter misses the conversion. The CLIENT opening
   * the link is the strongest server-observable "definitely sent" signal
   * there is; bot/owner exclusion in the caller means by the time we get
   * here the view is real human activity worth counting + acting on.
   *
   * Single atomic UPDATE: increments view_count, COALESCE-sets
   * first_viewed_at on the first hit (so concurrent first views from a
   * forwarded email both resolve to the earliest server-clock NOW() rather
   * than racing), always advances last_viewed_at, flips status from 'draft'
   * to 'sent' (and only from 'draft' — 'sent'/'overdue'/'paid' are left
   * untouched so a paid-first-then-viewed invoice never regresses), and
   * stamps sent_via_share_view_at on the auto-flip so the dashboard +
   * activation report can distinguish explicit Mark-as-Sent clicks from
   * client-view auto-transitions. PostgreSQL evaluates the CASE
   * expressions against the OLD row before any SET clause is applied, so
   * the guards are race-safe against concurrent updates. Returns the new
   * row state including status + sent_via_share_view_at so the caller can
   * fan out follow-on events (the existing view_count === 1 → email
   * trigger still fires unchanged).
   */
  async recordPublicInvoiceView(invoiceId) {
    if (!invoiceId) return null;
    const id = Number(invoiceId);
    if (!Number.isInteger(id) || id <= 0) return null;
    const { rows } = await pool.query(
      `UPDATE invoices
          SET view_count             = COALESCE(view_count, 0) + 1,
              first_viewed_at        = COALESCE(first_viewed_at, NOW()),
              last_viewed_at         = NOW(),
              status                 = CASE WHEN status = 'draft' THEN 'sent' ELSE status END,
              sent_via_share_view_at = CASE WHEN status = 'draft' THEN NOW() ELSE sent_via_share_view_at END,
              updated_at             = NOW()
        WHERE id = $1
        RETURNING id, view_count, first_viewed_at, last_viewed_at, status, sent_via_share_view_at`,
      [id]
    );
    return rows[0] || null;
  },

  /*
   * Freelancer-side counterpart to recordPublicInvoiceView's auto-transition
   * (Milestone 3 — first invoice created → first invoice sent). Fires from
   * POST /invoices/:id/share-intent when the freelancer clicks a
   * WhatsApp/SMS/Email/Copy button on /invoices/:id. The client-view path
   * only flips the invoice once the recipient actually opens the link — many
   * shares never get opened (client busy, link routed to spam, freelancer
   * shared on a channel the client doesn't check), and those invoices used
   * to be stuck in 'draft' forever: stale-draft prompts kept firing,
   * activation-funnel `sent_one` counter missed them, freelancer dashboard
   * lied about the invoice state. The intent click is the strongest in-app
   * "definitely sent" signal we can observe on the freelancer side.
   *
   * Single atomic UPDATE with the same CASE-guard pattern as
   * recordPublicInvoiceView: status flips draft → sent only when the OLD
   * row's status is 'draft', the stamp is set only on that flip, and any
   * other status flows through the ELSE branch untouched. Race-safe against
   * concurrent flips from the client-view auto-transition or an explicit
   * Mark-as-Sent — whichever lands first owns the row, the others no-op.
   * user_id in the WHERE clause guards against cross-tenant invocation.
   */
  async markInvoiceSentFromShareIntent(invoiceId, userId) {
    if (!invoiceId || !userId) return null;
    const id = Number(invoiceId);
    const uid = Number(userId);
    if (!Number.isInteger(id) || id <= 0) return null;
    if (!Number.isInteger(uid) || uid <= 0) return null;
    const { rows } = await pool.query(
      `UPDATE invoices
          SET status                    = CASE WHEN status = 'draft' THEN 'sent' ELSE status END,
              sent_via_share_intent_at  = CASE WHEN status = 'draft' THEN NOW() ELSE sent_via_share_intent_at END,
              updated_at                = NOW()
        WHERE id = $1 AND user_id = $2
        RETURNING id, status, sent_via_share_intent_at`,
      [id, uid]
    );
    return rows[0] || null;
  },

  /*
   * Stamps a client-side payment claim from the public /i/<token> share page
   * (Milestone 4 — sent → paid). Single atomic UPDATE guarded on
   * `payment_claimed_at IS NULL AND status != 'paid'`, so concurrent submits
   * race on the row lock and exactly one wins — the email-fire path can
   * safely fire-and-forget without double-emailing the freelancer. Joins
   * `users` so the caller composes the freelancer-facing email without a
   * second query (mirrors getInvoiceByPublicToken's projection). The
   * `method` argument is the small whitelist enforced at the route layer
   * (cash|check|venmo|zelle|bank_transfer|paypal|other); reference + note
   * are bounded scalars stored verbatim and HTML-escaped at render. Returns
   * the joined row on first claim, null on already-claimed / paid / missing
   * invoice.
   */
  async recordPaymentClaim(invoiceId, claim = {}) {
    if (!invoiceId) return null;
    const id = Number(invoiceId);
    if (!Number.isInteger(id) || id <= 0) return null;
    const method = (claim.method && String(claim.method)) || null;
    const reference = (claim.reference && String(claim.reference)) || null;
    const note = (claim.note && String(claim.note)) || null;
    const { rows } = await pool.query(
      `WITH updated AS (
         UPDATE invoices
            SET payment_claimed_at       = NOW(),
                payment_claim_method     = $2,
                payment_claim_reference  = $3,
                payment_claim_note       = $4,
                updated_at               = NOW()
          WHERE id = $1
            AND payment_claimed_at IS NULL
            AND status <> 'paid'
          RETURNING id, user_id, invoice_number, client_name, client_email,
                    total, status, public_token,
                    payment_claimed_at, payment_claim_method,
                    payment_claim_reference, payment_claim_note
       )
       SELECT updated.*,
              u.id              AS owner_id,
              u.name            AS owner_name,
              u.email           AS owner_email,
              u.reply_to_email  AS owner_reply_to_email,
              u.business_name   AS owner_business_name,
              u.business_email  AS owner_business_email
         FROM updated
         JOIN users u ON u.id = updated.user_id`,
      [id, method, reference, note]
    );
    return rows[0] || null;
  },

  /*
   * Password-reset / magic-link sign-in (Milestone 1 — signup → first
   * dashboard re-entry). The raw token is generated by the caller via
   * `crypto.randomBytes(32).toString('hex')` and ONLY the SHA-256 hash is
   * persisted; a database read alone never yields a usable reset link.
   * Returns the inserted row id + expires_at so the orchestrator can
   * log/audit, but does NOT echo the raw token (the caller already has it).
   * ttlMinutes defaults to 60 (one hour) — long enough that a user clicking
   * the link from another device after a coffee break still works, short
   * enough that a leaked-then-rotated mailbox can't be replayed weeks later.
   */
  async createPasswordResetToken(userId, tokenHash, ttlMinutes = 60, kind = 'reset') {
    if (!userId || !tokenHash || typeof tokenHash !== 'string') return null;
    const minutes = Number.isFinite(ttlMinutes) && ttlMinutes > 0
      ? Math.floor(ttlMinutes)
      : 60;
    const safeKind = (kind === 'login') ? 'login' : 'reset';
    const { rows } = await pool.query(
      `INSERT INTO password_resets (user_id, token_hash, expires_at, kind)
       VALUES ($1, $2, NOW() + ($3 * INTERVAL '1 minute'), $4)
       RETURNING id, expires_at, kind`,
      [userId, tokenHash, minutes, safeKind]
    );
    return rows[0] || null;
  },

  /*
   * Lookup a password-reset row by token hash. Surfaces the joined user
   * email/name so the route can render the form with the account context
   * ("Reset password for alice@x.com") and the orchestrator can fire post-
   * reset side-effects (session login). Returns null for any of: bad hash
   * shape, no matching row, expired, already-consumed. The single SELECT
   * does the validity check inline so callers don't have to re-check
   * expires_at / consumed_at and accidentally drift.
   */
  async findValidPasswordResetByHash(tokenHash) {
    if (!tokenHash || typeof tokenHash !== 'string') return null;
    if (!/^[a-f0-9]{64}$/i.test(tokenHash)) return null;
    const { rows } = await pool.query(
      `SELECT pr.id            AS reset_id,
              pr.user_id        AS user_id,
              pr.expires_at     AS expires_at,
              u.email           AS email,
              u.name            AS name,
              u.plan            AS plan,
              u.invoice_count   AS invoice_count,
              u.subscription_status AS subscription_status,
              u.trial_ends_at   AS trial_ends_at
         FROM password_resets pr
         JOIN users u ON u.id = pr.user_id
        WHERE pr.token_hash  = $1
          AND pr.kind        = 'reset'
          AND pr.consumed_at IS NULL
          AND pr.expires_at  > NOW()
        LIMIT 1`,
      [tokenHash]
    );
    return rows[0] || null;
  },

  /*
   * Atomically consume the reset token AND rotate the user's password_hash
   * in a single round-trip. The UPDATE on password_resets is guarded on
   * `consumed_at IS NULL AND expires_at > NOW()`, so a concurrent double-
   * submit (user hits Submit twice, or a tab refresh resends the POST)
   * consumes once and returns null on the replay — the caller treats null
   * as "link already used or expired". The CTE chain ensures the password
   * UPDATE only fires when the reset actually consumed; on the replay path
   * the user's password is NOT touched (avoiding the silent re-hash of an
   * empty/invalid post body landing on a stale token).
   *
   * Returns the user row (id, email, name, plan, etc.) so the route can
   * write the post-reset session without a second SELECT.
   */
  async consumePasswordResetAndSetPassword(tokenHash, newPasswordHash) {
    if (!tokenHash || !newPasswordHash) return null;
    if (!/^[a-f0-9]{64}$/i.test(tokenHash)) return null;
    const { rows } = await pool.query(
      `WITH consumed AS (
         UPDATE password_resets
            SET consumed_at = NOW()
          WHERE token_hash  = $1
            AND kind        = 'reset'
            AND consumed_at IS NULL
            AND expires_at  > NOW()
          RETURNING user_id
       ),
       rotated AS (
         UPDATE users
            SET password_hash = $2,
                updated_at    = NOW()
          WHERE id = (SELECT user_id FROM consumed)
          RETURNING id, email, name, plan, invoice_count, subscription_status, trial_ends_at
       )
       SELECT * FROM rotated`,
      [tokenHash, newPasswordHash]
    );
    return rows[0] || null;
  },

  /*
   * Magic-link sign-in lookup — kind='login' counterpart to
   * findValidPasswordResetByHash. Same shape (joined user fields so the
   * route can write the post-login session without a second SELECT), but
   * filters on kind='login' so a reset token cannot be replayed as a
   * magic-login (or vice versa). Returns null on any of: bad hash shape,
   * no matching row, expired, already-consumed, wrong kind.
   */
  async findValidMagicLoginByHash(tokenHash) {
    if (!tokenHash || typeof tokenHash !== 'string') return null;
    if (!/^[a-f0-9]{64}$/i.test(tokenHash)) return null;
    const { rows } = await pool.query(
      `SELECT pr.id            AS reset_id,
              pr.user_id        AS user_id,
              pr.expires_at     AS expires_at,
              u.email           AS email,
              u.name            AS name,
              u.plan            AS plan,
              u.invoice_count   AS invoice_count,
              u.subscription_status AS subscription_status,
              u.trial_ends_at   AS trial_ends_at
         FROM password_resets pr
         JOIN users u ON u.id = pr.user_id
        WHERE pr.token_hash  = $1
          AND pr.kind        = 'login'
          AND pr.consumed_at IS NULL
          AND pr.expires_at  > NOW()
        LIMIT 1`,
      [tokenHash]
    );
    return rows[0] || null;
  },

  /*
   * Atomically consume a magic-login token AND return the joined user row
   * in a single SQL round-trip. No password rotation — the entire point of
   * the magic-link flow is that the user signs in without typing or
   * choosing a password. The UPDATE is guarded on `consumed_at IS NULL
   * AND expires_at > NOW() AND kind='login'`, so a concurrent double-click
   * (or a link prefetcher and the user both following the URL) consumes
   * exactly once. The CTE chain ensures the user SELECT only fires on the
   * winning consume — replays return null.
   */
  async consumeMagicLoginToken(tokenHash) {
    if (!tokenHash || typeof tokenHash !== 'string') return null;
    if (!/^[a-f0-9]{64}$/i.test(tokenHash)) return null;
    const { rows } = await pool.query(
      `WITH consumed AS (
         UPDATE password_resets
            SET consumed_at = NOW()
          WHERE token_hash  = $1
            AND kind        = 'login'
            AND consumed_at IS NULL
            AND expires_at  > NOW()
          RETURNING user_id
       )
       SELECT u.id, u.email, u.name, u.plan, u.invoice_count,
              u.subscription_status, u.trial_ends_at
         FROM consumed c
         JOIN users u ON u.id = c.user_id`,
      [tokenHash]
    );
    return rows[0] || null;
  },

  async creditReferrerIfMissing(referredUserId) {
    if (!referredUserId) return null;
    const { rows } = await pool.query(
      `WITH credited AS (
         UPDATE users
            SET referral_credited_at = NOW(),
                updated_at           = NOW()
          WHERE id = $1
            AND referrer_id IS NOT NULL
            AND referral_credited_at IS NULL
          RETURNING referrer_id
       )
       SELECT u.id                        AS referrer_id,
              u.stripe_subscription_id    AS referrer_subscription_id,
              u.email                     AS referrer_email,
              u.plan                       AS referrer_plan
         FROM credited c
         JOIN users u ON u.id = c.referrer_id`,
      [referredUserId]
    );
    return rows[0] || null;
  }
};

module.exports = { pool, db };
