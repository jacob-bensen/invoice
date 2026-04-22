# InvoiceFlow — Smart Invoicing SaaS for Freelancers

## Concept
A self-serve SaaS that lets freelancers and small agencies create, send, and collect payment on professional invoices. Automated payment reminders run without any human intervention, reducing time-to-payment and making the service sticky.

## Tech Stack
- **Backend:** Java 21, Spring Boot 3.3, Spring Security (JWT), Spring Mail
- **Database:** PostgreSQL 15 (via Spring Data JPA / Hibernate)
- **Payments:** Stripe (subscriptions + invoice payment links)
- **PDF generation:** iText 8 (server-side PDF rendering)
- **Email:** SendGrid SMTP relay (or any SMTP)
- **Build:** Maven

## Monetization Model
| Plan      | Price       | Limits                        |
|-----------|-------------|-------------------------------|
| Free      | $0/mo       | 5 invoices/mo, 1 client       |
| Solo      | $9/mo       | Unlimited invoices, 10 clients|
| Pro       | $19/mo      | Unlimited invoices + clients, custom branding, auto-reminders |
| Agency    | $49/mo      | All Pro + 5 team seats        |

Recurring Stripe subscriptions. Upgrade prompts trigger when free-tier limits are hit.

## Core Features
1. User registration / JWT auth
2. Client management (CRUD)
3. Invoice CRUD with line items
4. PDF invoice generation and email delivery
5. Stripe Checkout for subscription upgrades
6. Stripe Webhook to sync subscription status
7. Automated payment reminder emails (scheduled job)
8. Invoice payment via Stripe Payment Link
9. Dashboard stats (revenue, outstanding, overdue)

## Directory Layout
```
invoiceflow/
  src/main/java/com/invoiceflow/
    auth/          # JWT security, user registration/login
    user/          # User entity, plan enforcement
    client/        # Client entity + API
    invoice/       # Invoice + LineItem entities + API
    pdf/           # PDF generation service
    email/         # Email service (SendGrid)
    stripe/        # Stripe webhook + subscription service
    scheduler/     # Reminder job
  src/main/resources/
    application.yml
    db/migration/  # Flyway migrations
```
