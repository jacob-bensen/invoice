# QuickInvoice — Master Actions

> Items genuinely waiting on a human (credentials, payment-provider setup, asset delivery, legal, store listings). Code is in for every item below; nothing here is solved by a commit.

## Deploy

### Provision Heroku app + Postgres + env
- `heroku create` + `heroku addons:create heroku-postgresql:essential-0`
- `heroku pg:psql < db/schema.sql` (idempotent)
- Set: `SESSION_SECRET` (`openssl rand -hex 32`), `STRIPE_SECRET_KEY` (`sk_live_…`), `STRIPE_PUBLISHABLE_KEY` (`pk_live_…`), `STRIPE_WEBHOOK_SECRET` (`whsec_…`), `STRIPE_PRO_PRICE_ID`, `STRIPE_PRO_ANNUAL_PRICE_ID`, `APP_URL`, `NODE_ENV=production`
- `git push heroku master`

### Register Stripe webhook endpoint
- URL: `https://<host>/billing/webhook`
- Events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`
- Copy `whsec_…` → `STRIPE_WEBHOOK_SECRET`

## Stripe configuration

### Create annual Pro price ($99/yr) and set `STRIPE_PRO_ANNUAL_PRICE_ID`
Until set, annual selections gracefully fall back to monthly $12/mo via `resolvePriceId()` in `routes/billing.js`.

### Enable Smart Retries + Dunning Emails
Stripe Dashboard → Billing → Subscriptions and emails:
1. Smart Retries: ON (default 14-day schedule).
2. "Email customers for failed payments" + "Send emails about expiring cards": ON.
3. Manage failed payments → **Pause subscription** (not Cancel) on final retry, so `stripe_subscription_id` is preserved for in-app self-recovery via the dunning banner.

### Activate Stripe Tax + flip `STRIPE_AUTOMATIC_TAX_ENABLED=true`
Stripe Dashboard → Tax → Activate → set origin address → enable for Checkout. Then set the env var.

### Enable bank-debit / BNPL payment methods on Payment Links
Stripe Dashboard → Payment methods: enable ACH Direct Debit, SEPA, BACS as applicable. Each method takes ~3-5 min and lifts pay-rate on $500+ invoices.

### Stripe Customer Portal config
Enable: invoice history, tax ID collection, payment method update, plan switch (monthly ↔ annual).

## Email

### Provision Resend API key + verify sending domain
Set `RESEND_API_KEY` in production. **Unblocks 10+ ready-to-ship retention/conversion tasks** (self-serve password reset, churn win-back, weekly digest, monthly summary, auto-CC accountant, auto-BCC freelancer, .ics calendar attachment, welcome-back-after-past-due, 60+ day inactive re-engagement, magic-link login).

## Assets

### Replace `public/og-image.png` with a branded asset
Currently a placeholder. 1200×630 PNG; the meta tags (`#36`) are already wired.

## SEO

### Submit `sitemap.xml` to Google Search Console (and Bing)
Verify domain → submit `https://<host>/sitemap.xml`. Indexing within 3-14 days; measurable long-tail traffic within 30-60 days.

### Sign up for Plausible Analytics + set `PLAUSIBLE_DOMAIN`
Unblocks INTERNAL_TODO #34 (analytics integration). Pick Plausible.io ($9/mo) or self-host.

## Legal

### Publish Terms of Service (`#28`)
Hard requirement for Stripe ToS compliance. EJS scaffold lands with #28; copy must be reviewed by the operator.

### Publish Privacy Policy (`#28`)
GDPR Art. 13 / CCPA §1798.100. EJS scaffold lands with #28; operator supplies the org-specific particulars (controller name, retention windows, sub-processor list).

### Publish Refund / Cancellation Policy (`#28`)
Stripe + card-network requirement. EJS scaffold lands with #28; operator decides the refund window.

## Store / directory listings

### List on G2, Capterra, AlternativeTo, GetApp, SaaSHub, Indie Hackers
Use the same description, screenshots, feature list, pricing across all six. Drives passive evergreen organic traffic + comparison-query backlinks.

### Apply to AppSumo for a lifetime-deal listing
~2-3 hr application; lands 100-1,000 first-cohort users in the launch week if accepted.

### Stripe App Marketplace partner profile
Lists QuickInvoice in the Stripe App directory. Discovery channel that converts higher than generic SaaS directories because the visitor already has Stripe.
