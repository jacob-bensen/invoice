# QuickInvoice — Internal Growth TODO

> **Audited:** 2026-04-22 — Reordered by income impact; [BLOCKED] items moved to bottom. No items were marked [DONE]. Complexity tags added: [S] < 2 hrs · [M] 2–8 hrs · [L] > 8 hrs.

Do not duplicate items already in `TODO.md`.

---

## [GROWTH] 1. Upgrade Modal at Free-Plan Invoice Limit [S]

**Impact:** HIGH
**Effort:** Low
**Prerequisites:** None

Replace the current dead-end at the 3-invoice limit with a full-screen Alpine.js modal in `views/dashboard.ejs` and `views/invoice-form.ejs`.

**Sub-tasks:**
1. Locate where the server-side invoice limit is enforced (likely `routes/invoices.js`) and confirm it returns a detectable signal (e.g., redirect with query flag or JSON error).
2. Add an Alpine.js `x-data` component to `views/dashboard.ejs` and `views/invoice-form.ejs` that opens the modal when the limit signal is detected.
3. Build the modal body: list Pro unlocks (unlimited invoices, email sending, payment links), a single CTA button that navigates to the existing Stripe Checkout route, and a social-proof line ("Join X freelancers on Pro").
4. Test on a free account that has hit 3 invoices — modal must appear before any server error page.

This is the highest-intent moment in the funnel. A conversion here costs nothing to acquire.

---

## [GROWTH] 2. "Created with QuickInvoice" Footer on Free Plan PDFs [S]

**Impact:** MEDIUM
**Effort:** Very Low
**Prerequisites:** None

Add a one-line branded footer to `views/invoice-print.ejs` visible only to free users.

**Sub-tasks:**
1. In `views/invoice-print.ejs`, wrap a footer element in `<% if (user.plan === 'free') { %>`.
2. Render: `Invoiced with QuickInvoice · quickinvoice.io/pricing?ref=pdf-footer`
3. Style subtly (small gray text, print-safe — verify it appears in browser print preview).

Every invoice a free user sends becomes a passive acquisition touchpoint. Removal of the footer is a tangible Pro benefit.

---

## [GROWTH] 3. Stripe Dunning + Smart Retries — Code Portion [S]

**Impact:** MEDIUM
**Effort:** Very Low (code); Stripe Dashboard config is a human action
**Prerequisites:** Stripe account must be live before dashboard config; code portion is implementable now

**Sub-tasks (code — do now):**
1. In `routes/billing.js`, extend the `customer.subscription.updated` webhook handler to handle `status === 'past_due'` and `status === 'paused'`: restrict Pro features without deleting user data.
2. Add a dismissible warning banner to `views/dashboard.ejs` rendered when `user.subscription_status === 'past_due'` (link to Stripe Customer Portal to update card).

**Human action (requires live Stripe):** In the Stripe Dashboard enable Smart Retries, dunning emails on retry attempts, and subscription pause on failure instead of immediate cancel. Recovers an estimated 20–30% of failed payments with zero ongoing effort.

---

## [GROWTH] 4. Add Annual Billing Plan at $99/year [M]

**Impact:** HIGH
**Effort:** Low–Medium
**Prerequisites:** None (Stripe already integrated); requires one human action to create the Stripe price

**Sub-tasks:**
1. **[Human action]** In the Stripe Dashboard, create a second price on the existing Pro product: $99/year recurring. Note the new `price_...` ID.
2. Add a Monthly / Annual toggle (Alpine.js `x-data`) to `views/pricing.ejs`. Toggle must swap the displayed price and update a hidden `billing_cycle` input.
3. Add the same toggle to `views/settings.ejs` (current plan section) so existing users can switch to annual.
4. Update `routes/billing.js` Checkout session creation: read `billing_cycle` from the request body and pass the correct `price_id` (monthly vs annual) to Stripe.
5. Confirm the existing `checkout.session.completed` and `customer.subscription.updated` webhook handlers work for annual events (they should — no event format difference, but verify).

Annual subscribers churn at roughly half the rate of monthly subscribers. Upfront cash improves runway immediately.

---

## [GROWTH] 5. Stripe Payment Links on Invoices (Pro Feature) [M]

**Impact:** HIGH
**Effort:** Medium
**Prerequisites:** Stripe account (already required)

Automatically generate a Stripe Payment Link when a Pro user marks an invoice "Sent," turning QuickInvoice into a payment collection tool.

**Sub-tasks:**
1. Add a `payment_link_url` column to the `invoices` table (`db/schema.sql`). Write and apply the migration: `ALTER TABLE invoices ADD COLUMN payment_link_url TEXT;`
2. In `routes/invoices.js`, when invoice status changes to `'sent'` and `user.is_pro`, call the Stripe API to create a Payment Link for the invoice total. Store the returned URL in `payment_link_url`.
3. In `views/invoice-view.ejs`, render a **"Pay Now"** button linking to `payment_link_url` (visible only when the link exists and user is Pro).
4. In `views/invoice-print.ejs`, render the payment link as a URL and optionally a QR code (use a lightweight inline SVG QR library — no server dependency).
5. Add a webhook handler for `payment_intent.succeeded` (or `checkout.session.completed` from the payment link) in `routes/billing.js` that looks up the invoice by `payment_link_url` and sets its status to `'paid'`.

Freelancers whose clients pay through the platform will almost never cancel — switching cost becomes too high.

---

## [GROWTH] 6. Zapier Outbound Webhook on Invoice Paid (Pro Feature) [M]

**Impact:** MEDIUM
**Effort:** Low
**Prerequisites:** None

Fire a JSON POST to a user-configured URL whenever an invoice is marked "Paid," enabling Zapier/Make integrations with zero third-party SDK.

**Sub-tasks:**
1. Add a `webhook_url` column to the `users` table: `ALTER TABLE users ADD COLUMN webhook_url TEXT;`
2. Add a "Zapier / Webhook" section to `views/settings.ejs` (Pro only): a text input for the catch-hook URL with a Save button.
3. Add a route (or extend existing settings route) in `routes/billing.js` or `routes/invoices.js` to accept and persist `webhook_url` for the authenticated Pro user.
4. In `routes/invoices.js`, whenever an invoice status is set to `'paid'` (manual or via webhook), check `user.webhook_url` and fire an async `https.request` POST with a JSON payload: `{ invoice_id, amount, client_name, paid_at }`. Do not block the response on the outbound request.
5. Gate the webhook URL save and outbound POST behind a Pro plan check in `middleware/auth.js` or inline.

---

## [GROWTH] 7. SEO Niche Landing Pages for Freelancer Verticals [M]

**Impact:** MEDIUM–HIGH (long-term, compounds over time)
**Effort:** Medium
**Prerequisites:** Custom domain (in `TODO.md`) recommended for SEO authority; implementable without it

**Sub-tasks:**
1. Create `views/partials/lp-niche.ejs` with slot variables: `nicheTitle`, `nicheHeadline`, `nicheDescription`, `screenshotAlt`.
2. Create `routes/landing.js` with 6–8 GET routes mapping niche slugs to the partial. Register in `server.js`.
   - `/invoice-template/freelance-designer`
   - `/invoice-template/freelance-developer`
   - `/invoice-template/freelance-writer`
   - `/invoice-template/freelance-photographer`
   - `/invoice-template/consultant`
   - `/invoice-generator`
3. Write niche-specific headline and CTA copy for each route (render a "Create your first invoice free" CTA → `/register`).
4. Add a `GET /sitemap.xml` route to `server.js` that returns an XML sitemap listing all landing page and marketing URLs with `<lastmod>` dates.
5. **[Human action]** Submit the sitemap URL to Google Search Console after deploying.

Zero ad-spend acquisition channel; organic traffic compounds monthly.

---

## [GROWTH] 8. "Business" Tier at $29/month / $249/year [L]

**Impact:** HIGH
**Effort:** Medium–Large
**Prerequisites:** Annual Billing (#4 above) should be live first; team seat invites require email delivery (see BLOCKED section)

**Sub-tasks:**
1. **[Human action]** Create $29/month and $249/year Stripe prices for a new "Business" product in Stripe Dashboard. Note both `price_id` values.
2. `db/schema.sql`: Add `'business'` as a valid value for the `plan` column. Add `business_profiles` table (id, user_id, name, address, logo_url). Add `team_members` table (id, owner_user_id, member_email, status).
3. `middleware/auth.js`: Add `is_business` helper (checks `user.plan === 'business'`). Apply to gated route guards.
4. Update all views that branch on `user.is_pro` to also handle `user.is_business` (Business inherits all Pro features plus Business-only gating).
5. `views/pricing.ejs`: Add a third pricing column (Free / Pro / Business) listing Business-only features.
6. Implement multi-profile: routes for creating, listing, and switching active business profiles. Render profile selector in `views/partials/nav.ejs`.
7. Implement team seat invite flow: send invite email to member_email (**requires email delivery — defer this sub-task until email is live**), accept invite via token link, add member to team.
8. `views/settings.ejs`: Add Business-plan section showing seat count, invite form, and active profiles.

Raises the revenue ceiling from $12/month to $29/month per power user.

---

---

## BLOCKED — Do Not Start Until Prerequisites Are Met

---

## [GROWTH] [BLOCKED] 9. Churn Win-Back Email Sequence [L]

**BLOCKED:** Email delivery is not implemented. Complete the "Add email delivery (Resend or SendGrid)" item in `TODO.md` first.

**Impact:** MEDIUM
**Effort:** Low–Medium (after email is live)

**Sub-tasks (ready to execute once email delivery exists):**
1. `db/schema.sql`: Create `churn_sequences` table: `(id, user_id, email, step, scheduled_at, sent_at)`.
2. Set up `node-cron` daily job in `server.js` (or a dedicated `jobs/churn.js`): query rows where `scheduled_at <= NOW()` and `sent_at IS NULL`, send the correct email template, update `sent_at`.
3. Build 3 email templates:
   - Day 0: "Your data is safe for 30 days."
   - Day 3: "Here's what you're missing — 20% off your first month back." (generate Stripe coupon via `stripe.coupons.create` and embed link)
   - Day 14: "Last chance — invoice history will be archived soon."
4. In `routes/billing.js` `customer.subscription.deleted` handler: insert 3 rows into `churn_sequences` for days 0, 3, and 14.

---

## [GROWTH] [BLOCKED] 10. Monthly Revenue Summary Email to Pro Subscribers [M]

**BLOCKED:** Email delivery is not implemented. Complete the "Add email delivery (Resend or SendGrid)" item in `TODO.md` first.

**Impact:** MEDIUM
**Effort:** Low (after email is live)

**Sub-tasks (ready to execute once email delivery exists):**
1. Set up `node-cron` monthly job (1st of each month, 09:00 UTC) in `server.js` or `jobs/monthly-summary.js`.
2. For each Pro user, run the existing `db.js` aggregation queries (already used on the dashboard) to retrieve: total invoiced this month vs. last, amount collected vs. outstanding, new clients invoiced.
3. Build an HTML email template with those 4 data points and a "View your dashboard →" CTA.
4. Send via the email delivery provider added in step above. Log send in a `email_log` table to prevent duplicates on restart.

Reduces passive churn by reminding users of the value they receive each month.

---
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
