# InvoiceFlow — Internal TODO

## Priority Order
Tasks are ordered highest → lowest value. Pick first unblocked item.

---

### PHASE 1 — Core Foundation

- [DONE 2026-04-22] P1 — Project scaffold: pom.xml, application.yml, Flyway migrations (users, clients, invoices, line_items)
- [DONE 2026-04-22] P2 — Auth: User registration + JWT login endpoints
- [DONE 2026-04-22] P3 — Client API: CRUD with plan-limit enforcement
- [DONE 2026-04-22] P4 — Invoice API: CRUD with line items + plan-limit enforcement
- [DONE 2026-04-22] P5 — PDF generation: iText8, download endpoint
- [DONE 2026-04-22] P6 — Email delivery: send invoice PDF via SendGrid SMTP
- [DONE 2026-04-22] P7 — Stripe subscription Checkout session + webhook sync
- [DONE 2026-04-22] P8 — Payment reminder scheduler (daily job, emails overdue invoices)
- [DONE 2026-04-22] P9 — Dashboard stats endpoint

### PHASE 2 — Growth

- [ ] P10 — Custom branding (logo upload, brand color) — Pro plan
- [ ] P11 — Team seats (Agency plan)
- [ ] P12 — Recurring invoice auto-generation
