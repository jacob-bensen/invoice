# QuickInvoice — Changelog

---

## 2026-04-22 — P10: Custom Branding for Pro Plan

### What was built
Logo upload and custom brand color as a Pro/Agency-only feature, applied to all generated PDF invoices.

### Files changed
| File | Change |
|------|--------|
| `db/migration/V2__add_branding.sql` | New — adds `logo_data` (TEXT) and `brand_color` (CHAR 7) columns to `users` |
| `user/Plan.java` | Added `customBranding` boolean flag (true for PRO and AGENCY plans) |
| `user/User.java` | Added `logoData` and `brandColor` fields with getters/setters |
| `branding/BrandingController.java` | New — `GET /api/branding`, `PUT /api/branding/color`, `POST /api/branding/logo`, `DELETE /api/branding/logo` |
| `pdf/PdfService.java` | Resolves brand color from hex string; renders user logo at top of PDF for Pro/Agency users |
| `BrandingControllerTest.java` | New — 8 tests covering plan gating, color validation, logo upload/delete, size/type enforcement |

### Why it matters for income
- Custom branding is a named Pro-plan benefit at $19/month — it's a concrete, visible upgrade incentive.
- Every invoice PDF a Pro user generates now reflects their brand instead of InvoiceFlow's default blue, making the product sticky (higher switching cost).
- The feature is invisible to Free/Solo users but becomes a clear upgrade driver when they see branded PDFs from Pro users.

---

## 2026-04-21 — v1.0.0 — Initial Build

**What was built:** Full MVP of QuickInvoice, a professional invoicing SaaS for freelancers.

### App Summary
QuickInvoice lets freelancers create, manage, and download professional invoices in under a minute. It monetizes via a Stripe subscription (Free → Pro at $12/month).

### Income Model
| Plan | Price | Limit |
|------|-------|-------|
| Free | $0 | 3 invoices total |
| Pro | $12/month | Unlimited invoices |

**Revenue projection:** 100 Pro users = $1,200 MRR. Zero ongoing work required after deployment.

### Files Created
| File | Purpose |
|------|---------|
| `server.js` | Express app entry point, session management |
| `db.js` | PostgreSQL connection pool + all DB queries |
| `routes/auth.js` | Register, login, logout |
| `routes/invoices.js` | Invoice CRUD, print view, status updates |
| `routes/billing.js` | Stripe checkout, webhook, settings, portal |
| `middleware/auth.js` | Session auth guards |
| `db/schema.sql` | PostgreSQL table definitions |
| `views/index.ejs` | Landing page with hero, features, pricing |
| `views/auth/login.ejs` | Login form |
| `views/auth/register.ejs` | Registration form |
| `views/dashboard.ejs` | Invoice list with revenue stats |
| `views/invoice-form.ejs` | Create/edit invoice with live total calculation |
| `views/invoice-view.ejs` | Invoice detail with action buttons |
| `views/invoice-print.ejs` | Print-optimized invoice (browser print-to-PDF) |
| `views/pricing.ejs` | Upgrade page |
| `views/settings.ejs` | Business info + subscription management |
| `views/partials/head.ejs` | HTML head (Tailwind + Alpine.js via CDN) |
| `views/partials/nav.ejs` | Navigation bar |
| `package.json` | Node.js dependencies |
| `Procfile` | Heroku process definition |
| `.env.example` | Environment variable template |
| `.gitignore` | Git ignore rules |

### Tech Stack
- **Runtime:** Node.js 18+
- **Framework:** Express 4
- **Templates:** EJS
- **CSS:** Tailwind CSS (CDN, no build step)
- **Interactivity:** Alpine.js (CDN, no build step)
- **Database:** PostgreSQL via `pg`
- **Auth:** express-session + connect-pg-simple + bcrypt
- **Payments:** Stripe (Checkout + Webhooks + Customer Portal)
- **Deployment:** Heroku (Procfile + Heroku Postgres add-on)

### Key Features
- Secure account creation and login
- Invoice editor with dynamic line items (add/remove, live totals, tax)
- Auto-generated invoice numbers (`INV-YYYY-XXXX`)
- Business branding on invoices (name, address, phone, email)
- Invoice status tracking (Draft → Sent → Paid)
- Print-to-PDF via browser (no server-side PDF dependency)
- Free plan enforced at 3 invoices; Pro plan via Stripe subscription
- Stripe Customer Portal for subscription management/cancellation
- Webhook handler for subscription lifecycle (upgrade, cancel, expire)
- Revenue stats on dashboard (total invoiced, collected, outstanding)

---
# Changelog

## 2026-04-22 — Initial Build: InvoiceFlow SaaS MVP

### What was built
Full Spring Boot 3 + PostgreSQL SaaS application for freelancer invoicing from scratch.

### Files created
**Project scaffold**
- `invoiceflow/pom.xml` — Maven build with Spring Boot 3.3, iText8, Stripe Java, JJWT, Flyway, SendGrid SMTP
- `invoiceflow/src/main/resources/application.yml` — Config with env-var overrides for all secrets
- `invoiceflow/src/main/resources/db/migration/V1__init.sql` — Flyway schema: users, clients, invoices, line_items

**Auth**
- `auth/JwtUtil.java` — JWT generation and validation (HMAC-SHA256)
- `auth/JwtFilter.java` — OncePerRequestFilter that hydrates Spring Security context
- `auth/AuthController.java` — POST /api/auth/register, POST /api/auth/login

**User & Plans**
- `user/User.java`, `Plan.java`, `SubscriptionStatus.java`, `UserRepository.java`
- Plan limits enforced at request time: FREE (5 invoices/mo, 1 client), SOLO, PRO, AGENCY

**Client API** — CRUD, plan-limit enforcement, user-scoped
**Invoice API** — CRUD with cascading line items, plan-limit enforcement, user-scoped
**PDF Service** — iText8 branded PDF: header, meta table, line-items table with totals, payment link
**Email Service** — Spring Mail async send: invoice delivery + overdue payment reminder HTML emails
**Stripe Integration**
- `StripeService.java` — Checkout session creation, Stripe Payment Link per invoice, customer auto-creation
- `StripeWebhookController.java` — Handles checkout.session.completed, subscription updated/deleted, payment link paid → updates user plan and invoice status automatically
- `StripeController.java` — POST /api/stripe/checkout, POST /api/stripe/invoices/{id}/payment-link

**Scheduler** — Daily 09:00 UTC job: marks overdue invoices, emails payment reminders to PRO/AGENCY plan clients (3-day cooldown)
**Dashboard** — GET /api/dashboard: revenue, outstanding, overdue amounts + counts

**Tests**
- `AuthControllerTest.java` — MockMvc tests for register/login happy and error paths
- `TestConfig.java` — Mock Email, PDF, Stripe beans for test profile
- `src/test/resources/application-test.yml` — H2 in-memory config, Flyway disabled

### Why it matters for income
- Freemium funnel: register free, hit invoice limit → upgrade prompt → Stripe Checkout → recurring subscription revenue
- Stripe handles billing autonomously; webhook syncs plan state with zero manual intervention
- Automated reminder emails reduce time-to-payment without human input
- PDF + email delivery makes the product immediately useful, driving activation and retention
