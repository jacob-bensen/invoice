# QuickInvoice — Master TODO

> **Audited:** 2026-04-22 — Code build v1.0.0 is complete (see CHANGELOG). All deployment steps below are pending human action. No optional improvements have been implemented yet; none are tagged [LIKELY DONE].

This file tracks what YOU need to do to get QuickInvoice live and earning money.

---

## 🚀 Priority: Deploy (do these in order)

### 1. Create Heroku App
```bash
heroku create your-app-name
heroku addons:create heroku-postgresql:essential-0
```

### 2. Set Up the Database
After provisioning Postgres, run the schema:
```bash
heroku pg:psql < db/schema.sql
```

### 3. Create Stripe Account
- Sign up at https://stripe.com
- Go to **Products** → **Create Product**
  - Name: "QuickInvoice Pro"
  - Price: $12.00 / month (recurring)
  - Copy the **Price ID** (starts with `price_...`)
- Go to **Developers** → **API Keys**
  - Copy Publishable Key (`pk_live_...`) and Secret Key (`sk_live_...`)
- Go to **Developers** → **Webhooks**
  - Add endpoint: `https://your-app.herokuapp.com/billing/webhook`
  - Select events: `checkout.session.completed`, `customer.subscription.deleted`, `customer.subscription.updated`
  - Copy the Webhook Signing Secret (`whsec_...`)

### 4. Set Heroku Environment Variables
```bash
heroku config:set SESSION_SECRET="$(openssl rand -hex 32)"
heroku config:set STRIPE_SECRET_KEY="sk_live_..."
heroku config:set STRIPE_PUBLISHABLE_KEY="pk_live_..."
heroku config:set STRIPE_WEBHOOK_SECRET="whsec_..."
heroku config:set STRIPE_PRO_PRICE_ID="price_..."
heroku config:set APP_URL="https://your-app.herokuapp.com"
heroku config:set NODE_ENV="production"
```
> DATABASE_URL is set automatically by Heroku Postgres.

### 5. Deploy
```bash
git push heroku main
```

### 6. Verify It Works
- Visit your Heroku URL
- Register an account
- Create a test invoice
- Verify PDF print works
- Test Stripe checkout with a test card: `4242 4242 4242 4242`

---

## 💰 Revenue Setup

### Stripe Test → Live
Once verified in test mode, switch to live keys:
- Replace `sk_test_...` with `sk_live_...`
- Replace `pk_test_...` with `pk_live_...`
- Create a new webhook endpoint for production

### Optional: Custom Domain
```bash
heroku domains:add quickinvoice.io
# Then update DNS at your registrar
heroku config:set APP_URL="https://quickinvoice.io"
```

---

## 📊 Monitor Revenue
- Stripe Dashboard: https://dashboard.stripe.com
- Check MRR, churn, and new subscribers weekly
- Heroku logs: `heroku logs --tail`

---

## 🔧 Optional Improvements (future)
- [ ] Add email delivery (Resend or SendGrid) so users can email invoices to clients
- [ ] Add a custom domain to increase conversion
- [ ] Set up Plausible or Fathom analytics for traffic tracking
- [ ] Add Google/GitHub OAuth for easier signup
- [ ] Recurring invoice templates
- [ ] Client portal (clients can view/download their invoices)
