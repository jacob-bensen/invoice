# Invoice Apps — App Spec

> _This repo contains two parallel invoicing apps that share the same revenue thesis and roadmap: a Node.js app (QuickInvoice — primary, in production iteration) and a Java/Spring app (InvoiceFlow — secondary). All "active development" by the routine targets QuickInvoice unless an item is explicitly tagged InvoiceFlow._

---

## App 1: QuickInvoice (Node.js — primary)

### Concept
A self-serve SaaS that lets freelancers and small agencies create, send, and collect payment on professional invoices in under 60 seconds. Stripe Payment Links collapse the create-invoice → get-paid loop. Automated payment reminders and Slack/Discord webhooks keep the user engaged with each invoice's payment lifecycle.

### Who it's for
Solo freelancers, contractors, and small agencies (designers, developers, writers, photographers, consultants) who want professional invoices without learning bookkeeping software.

### Tech stack
- **Runtime:** Node.js ≥ 18, Express 4
- **View layer:** EJS templates + Tailwind CDN + Alpine.js (no SPA build)
- **Database:** PostgreSQL (raw `pg` pool; schema in `db/schema.sql`)
- **Sessions:** `express-session` + `connect-pg-simple` (session table in Postgres)
- **Auth:** bcrypt-hashed passwords, session cookies
- **Payments:** Stripe Checkout (subscriptions) + Stripe Payment Links (per-invoice collection) + Stripe webhooks
- **Email:** Resend (`resend` SDK) — gated on `RESEND_API_KEY` in production
- **Scheduling:** `node-cron` jobs (reminders, trial nudges) inline in the web process
- **Security middleware:** `helmet`, `express-rate-limit`, custom CSRF (double-submit), custom security-headers
- **Hosting target:** Heroku (Procfile = `web: node server.js`)

### Monetization model
| Plan      | Monthly | Annual | Limits                                                           |
|-----------|---------|--------|------------------------------------------------------------------|
| Free      | $0      | —      | 3 invoices total, no email send, no payment links                |
| Pro       | $12/mo  | $99/yr | Unlimited invoices, email send, Stripe Payment Links, branding   |
| Agency    | $49/mo  | —      | All Pro + team seats (planned, gated by INTERNAL_TODO #9)        |

7-day free trial on Pro (no credit card to start; trial-end card-add is the conversion event). Recurring Stripe subscriptions; upgrade prompts trigger when free-tier limits are hit and via the trial-countdown nav pill.

### Core features (built today)
1. Email/password auth (login, register, session) with rate-limit + CSRF
2. Invoice CRUD with line items + status flow (draft → sent → paid / overdue)
3. Client-data dedupe via `client_email` / `client_name` columns on invoices (no separate clients table)
4. Stripe Checkout for Pro upgrade (monthly + annual prices)
5. Stripe Payment Links per invoice (Pro feature) with copy / preview / share-intent (WhatsApp, SMS, email)
6. Stripe webhook → flips `subscription_status` (active/past_due/cancelled) and invoice `status='paid'`
7. Outbound webhook on paid event (Slack / Discord / Zapier) with per-host payload formatting
8. Daily payment-reminder cron (`jobs/reminders.js`) — sends due-soon and overdue emails to clients (Pro only)
9. Trial-nudge cron (`jobs/trial-nudge.js`) — emails trial users approaching expiry
10. Dashboard: total invoiced / collected / outstanding cards + last-30-day paid revenue card + recent clients dropdown + invoice-limit progress bar (free) + trial-countdown nav pill
11. Invoice view page (per-invoice: print, mark sent/paid, copy pay link, share buttons)
12. Print-friendly invoice page (`views/invoice-print.ejs`) with optional QR code
13. Settings page: plan management, billing-cycle switch, outbound webhook URL, Stripe Customer Portal link
14. SEO surfaces: niche landing pages, OG/Twitter Card metadata, canonical link tags, robots.txt + sitemap.xml, 404 page
15. Onboarding cards on first dashboard load (dismissible, persisted)

### Directory layout
```
/                          # repo root = QuickInvoice
  server.js                # express bootstrap, middleware, routes mount
  db.js                    # pg pool + query helpers (one file)
  db/schema.sql            # idempotent CREATE TABLE / ALTER TABLE block
  routes/
    auth.js                # login, register, logout
    billing.js             # /billing/checkout, /portal, /settings, webhook
    invoices.js            # /invoices CRUD, /:id/status, dashboard handler
    landing.js             # /, /pricing, niche landing pages
  views/                   # EJS templates
    auth/                  # login, register
    partials/              # head, nav, upgrade-modal
    *.ejs                  # dashboard, invoice-form, invoice-view, etc.
  middleware/
    auth.js                # requireAuth, redirectIfAuth
    csrf.js                # double-submit CSRF
    rate-limit.js          # express-rate-limit auth bucket
    security-headers.js    # helmet wrapper with tuned CSP
  lib/
    email.js               # Resend wrapper (sendEmail, sendInvoiceEmail, etc.)
    html.js                # escapeHtml, formatMoney, formatTrialCountdown
    stripe-payment-link.js # createInvoicePaymentLink
    outbound-webhook.js    # firePaidWebhook, format-detection (Slack/Discord/canonical)
  jobs/
    reminders.js           # cron: send reminders for due-soon and overdue invoices
    trial-nudge.js         # cron: email trial users near expiry
  tests/                   # plain `node test.js` files; runner = `npm test`
  public/                  # static assets (og-image.png, etc.)
  master/                  # operational docs (this file, INTERNAL_TODO, CHANGELOG, TODO_MASTER)
```

### Income mechanics today
- Free → Pro at the 3-invoice hard wall (upgrade modal in `views/dashboard.ejs` + `views/invoice-form.ejs`)
- Free trial countdown is persistent across every authed page (nav pill + dashboard banner with day-1 urgent fork)
- Stripe Payment Links create the get-paid-faster moat (Pro switching cost)
- Slack/Discord webhooks create the daily-touchpoint moat (Pro)
- Annual billing ($99/yr) compresses CAC payback and halves churn vs monthly

---

## App 2: InvoiceFlow (Java/Spring — secondary)

### Concept
A second self-serve invoicing SaaS targeting the same persona, built on a Java/Spring stack. Currently a separate parallel implementation rather than a service of QuickInvoice. Routine work touches QuickInvoice unless tasks are explicitly tagged InvoiceFlow.

### Tech stack
- **Backend:** Java 21, Spring Boot 3.3, Spring Security (JWT)
- **Database:** PostgreSQL via Spring Data JPA / Hibernate (Flyway migrations under `src/main/resources/db/migration`)
- **Payments:** Stripe (subscriptions + invoice payment links) — Stripe Java SDK 25
- **PDF generation:** iText 8 (server-side PDF rendering)
- **Email:** SMTP (Spring Mail; SendGrid relay or any SMTP)
- **Build:** Maven (`pom.xml` at `invoiceflow/`)

### Directory layout
```
invoiceflow/
  pom.xml
  src/main/java/com/invoiceflow/
    auth/          # JWT security, user registration/login
    user/          # User entity, plan enforcement
    client/        # Client entity + API
    invoice/       # Invoice + LineItem entities + API, dashboard, recurrence
    pdf/           # PDF generation service
    email/         # Email service
    stripe/        # Stripe webhook + subscription service
    branding/      # Pro branding controller
    scheduler/     # Reminder job
  src/main/resources/
    application.yml
    db/migration/  # Flyway migrations
  src/test/java/com/invoiceflow/  # JUnit + Spring test harness
```

### Status
InvoiceFlow has feature parity goals tracked under specific INTERNAL_TODO items (e.g. recurring invoices, team seats). It is not the routine's primary target; new feature work lands on QuickInvoice unless the item is explicitly tagged for InvoiceFlow.

---

_Last synced: 2026-04-28_
