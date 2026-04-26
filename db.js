require('dotenv').config();
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

  async getNextInvoiceNumber(userId) {
    const { rows } = await pool.query(
      'SELECT COUNT(*) as count FROM invoices WHERE user_id=$1',
      [userId]
    );
    const count = parseInt(rows[0].count, 10) + 1;
    const year = new Date().getFullYear();
    return `INV-${year}-${String(count).padStart(4, '0')}`;
  }
};

module.exports = { pool, db };
