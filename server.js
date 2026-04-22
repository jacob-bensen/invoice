require('dotenv').config();
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');
const { pool } = require('./db');

const authRoutes = require('./routes/auth');
const invoiceRoutes = require('./routes/invoices');
const billingRoutes = require('./routes/billing');

const app = express();

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
  next();
});

app.get('/', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('index', { title: 'QuickInvoice — Get Paid Faster' });
});

app.get('/dashboard', (req, res) => {
  if (!req.session.user) return res.redirect('/auth/login');
  res.redirect('/invoices');
});

app.use('/auth', authRoutes);
app.use('/invoices', invoiceRoutes);
app.use('/billing', billingRoutes);

app.use((req, res) => res.status(404).redirect('/'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`QuickInvoice running on port ${PORT}`));
