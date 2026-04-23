# QuickInvoice — Changelog

---

## 2026-04-23 — QA Audit: Auth, Free-Limit, Billing-Webhook, Agency-Plan Bug Fix

### What changed
**Bug fix:** `routes/invoices.js` (line 160) — `POST /invoices/:id/status` only created Stripe Payment Links for `plan === 'pro'`. Agency plan users ($49/mo, which includes all Pro features) were silently skipped. Fixed to check `plan === 'pro' || plan === 'agency'`.

**New test files (26 tests across 3 files):**

| File | Tests | What it covers |
|------|-------|----------------|
| `tests/auth.test.js` | 12 | Registration validation (name/email/password), duplicate-email rejection, successful register → session + redirect, login with wrong password, login with unknown email, successful login → session + redirect, logout destroys session, `redirectIfAuth` guard on GET /login and GET /register, `requireAuth` guard redirects unauthenticated requests |
| `tests/invoice-limit.test.js` | 8 | Free-plan limit enforcement on GET and POST `/invoices/new` (redirect to `?limit_hit=1`), free user under limit renders form, pro user never blocked, solo plan does NOT get Payment Links (regression guard), agency plan DOES get Payment Links (fix verification), IDOR guard on `GET /invoices/:id` (wrong user → /dashboard), DELETE redirects to /dashboard |
| `tests/billing-webhook.test.js` | 6 | Invalid Stripe signature → 400; `checkout.session.completed` subscription mode → `db.updateUser(plan='pro')`; `checkout.session.completed` payment_link mode → `db.markInvoicePaidByPaymentLinkId`; `customer.subscription.deleted` → pool.query downgrade to free; `customer.subscription.updated` (active) → pool.query set to pro; `customer.subscription.updated` (non-active) → pool.query set to free |

**`package.json` `test` script** updated to run all four test files sequentially.

### Coverage before → after
| Path | Before | After |
|------|--------|-------|
| Auth: register/login/logout/redirectIfAuth/requireAuth | 0 tests | 12 tests |
| Free-plan limit enforcement + upgrade-modal redirect | 0 tests | 2 tests |
| Plan gating: solo excluded, agency included | 0 tests | 2 tests |
| IDOR guard (wrong-user invoice fetch) | 0 tests | 1 test |
| Stripe webhook: signature validation | 0 tests | 1 test |
| Stripe webhook: subscription checkout → plan upgrade | 0 tests | 1 test |
| Stripe webhook: payment_link checkout → invoice paid | 0 tests | 1 test |
| Stripe webhook: subscription deleted/updated lifecycle | 0 tests | 2 tests |
| Payment Links (existing) | 11 tests | 11 tests (unchanged) |

**Total: 11 → 37 passing tests (+26)**

### Why it matters for income
- **Auth tests** gate every income-generating action — a broken login flow means zero revenue.
- **Billing webhook tests** verify the entire subscription lifecycle without a live Stripe account: upgrades, downgrades, and payment reconciliation are the revenue backbone.
- **Agency bug fix** means $49/mo agency users now receive Payment Links as advertised — preventing silent feature regression on the highest-value plan.
- **Free-limit tests** lock in the upgrade-modal redirect that drives free → Pro conversions.

---

## 2026-04-23 — Stripe Payment Links on Invoices (QuickInvoice, Pro feature)

### What was built
Pro-plan invoices now auto-generate a Stripe Payment Link the first time the invoice is marked as `sent`. The link URL is stored on the invoice row and surfaced in three places:

1. **`views/invoice-view.ejs`** — a green "💳 Pay Now" action-bar button (Pro + link-present only), plus a dedicated "Payment Link" block with a copyable, read-only URL input (Alpine.js clipboard helper, "Copied!" confirmation).
2. **`views/invoice-print.ejs`** — a print-safe payment section with the full URL and an inline SVG QR code rendered client-side by `qrcode@1.5.3` via CDN (no server-side dependency added). Graceful fallback when JS is disabled: the URL is still clickable.
3. **Stripe webhook (`routes/billing.js`)** — `checkout.session.completed` events with `mode === 'payment'` and a `payment_link` reference now look up the invoice by `payment_link_id` and flip its status to `paid`. Idempotent (already-paid invoices are not re-updated).

### Files changed
| File | Change |
|------|--------|
| `db/schema.sql` | Added `payment_link_url TEXT` and `payment_link_id VARCHAR(255)` columns to `invoices` (with `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for existing DBs); added index `idx_invoices_payment_link_id` |
| `db.js` | New `setInvoicePaymentLink()` and `markInvoicePaidByPaymentLinkId()` queries |
| `lib/stripe-payment-link.js` | **New** — helper that creates a Stripe Product + Price + Payment Link for a given invoice, with a `$0.50` minimum guard and metadata (`invoice_id`, `user_id`, `invoice_number`) for webhook traceability |
| `routes/invoices.js` | `POST /invoices/:id/status` — on the `draft → sent` transition for Pro users, creates the Payment Link asynchronously; errors are logged but do not block the status change (graceful degradation) |
| `routes/billing.js` | Webhook handler for `checkout.session.completed` extended: `mode === 'payment'` + `session.payment_link` → mark the matching invoice paid |
| `views/invoice-view.ejs` | "Pay Now" button in the action bar + shareable copyable link block (Pro only) |
| `views/invoice-print.ejs` | Print-safe payment section with URL + inline SVG QR code (client-side generated) |
| `tests/payment-link.test.js` | **New** — 11-case integration harness (stubs db + Stripe client); runs via `npm test` |
| `package.json` | Added `"test": "node tests/payment-link.test.js"` |

### How it was verified
`npm test` — 11/11 passing, covering:
- Pro user marking `sent` creates exactly one Payment Link with the correct URL/ID stored.
- Free user marking `sent` does NOT create a Payment Link.
- Re-marking `sent` on an invoice that already has a link does NOT duplicate.
- Marking `paid` never triggers Payment Link creation.
- Webhook `markInvoicePaidByPaymentLinkId()` is idempotent.
- `invoice-view.ejs` renders Pay Now + link only for Pro users with a link.
- `invoice-print.ejs` renders QR placeholder + URL only for Pro users with a link.
- `lib/stripe-payment-link.js` passes correct params to Stripe (unit_amount in cents, USD, metadata) and rejects sub-minimum totals.

### Why it matters for income
This is the single largest feature-gap between QuickInvoice and competitor tools like Bonsai, HoneyBook, and FreshBooks: **the invoice itself is the checkout**. Specifically:

1. **Higher switching cost** — once a Pro user has sent 5–10 invoices with working pay links, leaving means re-plumbing their billing flow. That's sticky in a way that "unlimited invoices" is not.
2. **Faster time-to-cash for customers** — clients click Pay → Stripe Checkout → paid in <30s, instead of copying bank details. The invoice auto-flips to `paid` via webhook. Freelancers' own revenue velocity going up is the #1 testimonial driver.
3. **Tangible Pro unlock** — the upgrade modal (shipped earlier today) lists "payment links" as a Pro benefit; this ships the actual functionality. Expected conversion lift from free → Pro now that the promise is real.
4. **Zero-ops billing** — once the Stripe webhook is registered for `checkout.session.completed` (already done for subscriptions), Payment Link payments automatically reconcile. No human in the loop.

### Master action required
Add the `checkout.session.completed` webhook event (already enabled for subscriptions — no new subscription needed) to also process `mode: payment` sessions. No Stripe Dashboard change needed since our existing webhook is already subscribed to `checkout.session.completed`. Just confirm once live.

---

## 2026-04-23 — Upgrade Modal at Free-Plan Invoice Limit (QuickInvoice)

### What was built
Replaced the dead-end "flash error → upgrade page redirect" that free users hit at 3 invoices with a full-screen Alpine.js modal. When a free user tries to create a 4th invoice, the server now redirects to `/invoices?limit_hit=1`; the dashboard (and invoice form, for future parity) detects the query flag on page load and surfaces a modal with Pro unlocks, social proof, a one-click Stripe checkout CTA, "See full pricing" secondary link, and dismiss. After opening, the modal strips `limit_hit=1` from the URL via `history.replaceState` so a refresh doesn't re-trigger it.

### Files changed
| File | Change |
|------|--------|
| `routes/invoices.js` | GET and POST `/invoices/new` at free-plan limit now redirect to `/invoices?limit_hit=1` instead of flash-redirecting to `/billing/upgrade` |
| `views/partials/upgrade-modal.ejs` | **New** — reusable Alpine.js modal component with Pro benefit list, Stripe Checkout CTA, dismiss, auto-open on `?limit_hit=1` |
| `views/dashboard.ejs` | Includes the upgrade-modal partial |
| `views/invoice-form.ejs` | Includes the upgrade-modal partial (parity per spec) |

### How it was verified
Integration test harness (stubbed db + auth) confirmed:
- Free user at 3 invoices → GET and POST `/invoices/new` both redirect 302 to `/invoices?limit_hit=1`.
- Free user under the limit → form renders normally (200).
- Pro user at 100 invoices → form renders normally (200).
EJS render tests confirmed both `views/dashboard.ejs` and `views/invoice-form.ejs` include the modal markup.

### Why it matters for income
This is the highest-intent conversion moment in the funnel — the user has just tried to perform the core paid action and been told "no." The old flow dropped them on a pricing page after a flash error; the new flow keeps them on the dashboard, shows the exact unlocks they're missing (unlimited invoices, email delivery, payment links, branding), and offers a one-click Stripe Checkout without a page navigation. Reducing friction at this exact moment is the single biggest lever for free → Pro conversion.

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

---

## 2026-04-22 — P10: Custom Branding for Pro/Agency Plans

### What was built
Pro and Agency users can now personalise every PDF invoice with their own brand color (hex) and company logo. Free/Solo users who try to use branding endpoints get HTTP 402 with an upgrade prompt.

### Files changed
| File | Change |
|------|--------|
| `db/migration/V2__branding.sql` | Flyway migration: adds `logo_url` and `brand_color` columns to `users` |
| `user/User.java` | Added `logoUrl`, `brandColor` fields + getters/setters |
| `config/AppProperties.java` | Added `uploadsDir` config property |
| `application.yml` | Added `app.uploads-dir: ${UPLOADS_DIR:./uploads}` |
| `application-test.yml` | Added test uploads dir pointing to `/tmp` |
| `branding/BrandingController.java` | **New** — `GET /api/branding`, `PUT /api/branding`, `POST /api/branding/logo`, `DELETE /api/branding/logo`; Pro-plan gated; validates hex color and image MIME/size |
| `config/WebMvcConfig.java` | **New** — Serves `{uploadsDir}/**` under `/uploads/**` |
| `config/SecurityConfig.java` | Permits `/uploads/**` (logo images are public URLs embeddable in PDFs) |
| `pdf/PdfService.java` | Reads `user.getBrandColor()` and `user.getLogoUrl()` to apply custom color and logo; falls back to default blue if unset |
| `BrandingControllerTest.java` | **New** — 10 integration tests covering GET, PUT color, logo upload/delete, plan enforcement, and validation |

### Why it matters for income
Custom branding is gated behind Pro ($19/mo) and Agency ($49/mo). It is one of the highest-perceived-value Pro features — freelancers want their invoices to look like their brand, not a generic tool. This increases Pro conversion and dramatically reduces cancellation once a user has uploaded their logo (switching cost is high). It also enables upsell copy: "Remove generic branding" on free-tier PDF footers.

### Why it matters for income
- Freemium funnel: register free, hit invoice limit → upgrade prompt → Stripe Checkout → recurring subscription revenue
- Stripe handles billing autonomously; webhook syncs plan state with zero manual intervention
- Automated reminder emails reduce time-to-payment without human input
- PDF + email delivery makes the product immediately useful, driving activation and retention

---

## 2026-04-22 — P10: Custom Branding (logo + brand color) — Pro Feature

### What was built
Pro and Agency users can now upload their company logo and choose a custom brand color. Both appear on all generated PDF invoices. Free and Solo users get an "InvoiceFlow" attribution footer on their PDFs (passive acquisition). All 8 tests pass.
## 2026-04-22 — P10: Custom Branding (Logo + Brand Color) — Pro Plan

### What was built
Custom branding feature for Pro and Agency plan users: logo upload (PNG/JPEG/GIF/WebP, max 512 KB) and brand color (hex), applied to every generated PDF. Free and Solo users see the default InvoiceFlow brand.

### Files changed
| File | Change |
|------|--------|
| `db/migration/V2__branding.sql` | Adds `logo_data BYTEA`, `logo_content_type VARCHAR(30)`, `brand_color VARCHAR(7)` columns to `users` |
| `user/Plan.java` | Added `customBranding` boolean flag (true for PRO and AGENCY) |
| `user/User.java` | Added `logoData`, `logoContentType`, `brandColor` fields + getters/setters |
| `branding/BrandingController.java` | New REST controller: `GET/PUT /api/branding`, `POST/DELETE/GET /api/branding/logo` |
| `pdf/PdfService.java` | Uses user brand color and embeds logo in PDF header; adds attribution footer for free users |
| `resources/application.yml` | Added `spring.servlet.multipart` limits (2 MB file, 3 MB request) |
| `test/BrandingControllerTest.java` | 7 test cases: get defaults, update color, plan enforcement, logo upload/retrieve/delete |

### Why it matters for income
- **Retention:** Logo and color personalization increases perceived value and switching cost for Pro subscribers.
- **Upgrade incentive:** Every free-plan PDF now carries an "Created with InvoiceFlow" footer — passive acquisition on every invoice the user sends to their clients.
- **Feature differentiation:** Custom branding is a tangible, visible reason to upgrade from Solo ($9) to Pro ($19), raising ARPU.
| `invoiceflow/src/main/resources/db/migration/V2__branding.sql` | Flyway migration: adds `brand_color`, `logo_data`, `logo_mime` columns to `users` |
| `invoiceflow/src/main/java/com/invoiceflow/user/User.java` | Three new fields + getters/setters for branding columns |
| `invoiceflow/src/main/java/com/invoiceflow/branding/BrandingController.java` | New REST controller: GET/PUT color, POST/DELETE/GET logo — Pro-gated |
| `invoiceflow/src/main/java/com/invoiceflow/pdf/PdfService.java` | Parses user brand color + decodes/embeds logo image (Pro/Agency only) |
| `invoiceflow/src/main/resources/application.yml` | Multipart file limits (512 KB file, 1 MB request) |
| `invoiceflow/src/test/java/com/invoiceflow/BrandingControllerTest.java` | 12 MockMvc tests covering plan enforcement, color update, logo upload/delete/serve |

### Why it matters for income
Custom branding is a **Pro-exclusive feature** ($19/mo). It creates a tangible value difference between free and paid tiers: paid users' clients see their logo and colors on every PDF invoice, while free users see generic InvoiceFlow branding. This increases perceived professionalism for paying customers, reduces churn ("my clients see my brand every invoice"), and serves as a visible reminder on every invoice to upgrade.
