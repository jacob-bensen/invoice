const express = require('express');
const { body, validationResult } = require('express-validator');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { createInvoicePaymentLink } = require('../lib/stripe-payment-link');

const router = express.Router();
const FREE_LIMIT = 3;

router.get('/', requireAuth, async (req, res) => {
  try {
    const [invoices, user] = await Promise.all([
      db.getInvoicesByUser(req.session.user.id),
      db.getUserById(req.session.user.id)
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
        invoice_count: user.invoice_count
      };
    }
    res.render('dashboard', { title: 'My Invoices', invoices, user, flash });
  } catch (err) {
    console.error(err);
    res.render('dashboard', { title: 'My Invoices', invoices: [], user: req.session.user || null, flash: null });
  }
});

router.get('/new', requireAuth, async (req, res) => {
  const user = await db.getUserById(req.session.user.id);
  if (user.plan === 'free' && user.invoice_count >= FREE_LIMIT) {
    return res.redirect('/invoices?limit_hit=1');
  }
  const invoiceNumber = await db.getNextInvoiceNumber(req.session.user.id);
  res.render('invoice-form', {
    title: 'New Invoice',
    invoice: null,
    invoiceNumber,
    user,
    flash: null
  });
});

router.post('/new', requireAuth, [
  body('client_name').trim().notEmpty().withMessage('Client name is required'),
  body('items').notEmpty().withMessage('At least one line item is required')
], async (req, res) => {
  const user = await db.getUserById(req.session.user.id);
  if (user.plan === 'free' && user.invoice_count >= FREE_LIMIT) {
    return res.redirect('/invoices?limit_hit=1');
  }

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const invoiceNumber = await db.getNextInvoiceNumber(req.session.user.id);
    return res.render('invoice-form', {
      title: 'New Invoice',
      invoice: null, invoiceNumber, user,
      flash: { type: 'error', message: errors.array()[0].msg }
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
    const invoiceNumber = await db.getNextInvoiceNumber(req.session.user.id);
    res.render('invoice-form', {
      title: 'New Invoice', invoice: null, invoiceNumber, user,
      flash: { type: 'error', message: 'Failed to save invoice. Please try again.' }
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
    res.render('invoice-view', { title: `Invoice ${invoice.invoice_number}`, invoice, user, flash });
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
    res.render('invoice-print', { title: `Invoice ${invoice.invoice_number}`, invoice, user });
  } catch (err) {
    console.error(err);
    res.redirect('/dashboard');
  }
});

router.get('/:id/edit', requireAuth, async (req, res) => {
  try {
    const invoice = await db.getInvoiceById(req.params.id, req.session.user.id);
    if (!invoice) return res.redirect('/dashboard');
    const user = await db.getUserById(req.session.user.id);
    res.render('invoice-form', { title: 'Edit Invoice', invoice, invoiceNumber: invoice.invoice_number, user, flash: null });
  } catch (err) {
    res.redirect('/dashboard');
  }
});

router.post('/:id/edit', requireAuth, async (req, res) => {
  try {
    let items = [];
    try { items = JSON.parse(req.body.items); } catch (_) {}

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
      status: req.body.status || 'draft'
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
    const updated = await db.updateInvoiceStatus(req.params.id, req.session.user.id, newStatus);

    if (updated && newStatus === 'sent' && !updated.payment_link_url) {
      const user = await db.getUserById(req.session.user.id);
      if (user && (user.plan === 'pro' || user.plan === 'agency')) {
        try {
          const link = await createInvoicePaymentLink(updated, user);
          if (link && link.url) {
            await db.setInvoicePaymentLink(updated.id, user.id, link.url, link.id);
          }
        } catch (e) {
          console.error('Payment Link creation failed:', e.message);
        }
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

module.exports = router;
