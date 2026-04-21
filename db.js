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

  async deleteInvoice(id, userId) {
    const { rows } = await pool.query(
      'DELETE FROM invoices WHERE id=$1 AND user_id=$2 RETURNING id',
      [id, userId]
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
