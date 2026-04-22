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
