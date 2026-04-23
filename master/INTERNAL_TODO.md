# QuickInvoice + InvoiceFlow — Internal Growth TODO

> **Audited:** 2026-04-23 — All InvoiceFlow Phase 1 (P1–P10) [DONE] items archived. [BLOCKED] items moved to bottom. Tasks re-prioritized: income-critical first, [HEALTH] next, [GROWTH] after, [BLOCKED] last. InvoiceFlow P11/P12 expanded into single-session sub-tasks. Complexity tags: [S] < 2 hrs · [M] 2–8 hrs · [L] > 8 hrs.

Do not duplicate items already in `TODO.md`. App labels indicate which codebase each task applies to.

---

## INCOME-CRITICAL

### 1. [DONE 2026-04-23] [GROWTH] Upgrade Modal at Free-Plan Invoice Limit [S]

**App:** QuickInvoice (Node.js)
**Impact:** HIGH — highest-intent conversion moment in the funnel
**Effort:** Low
**Prerequisites:** None

Replace the dead-end at the 3-invoice limit with a full-screen Alpine.js modal in `views/dashboard.ejs` and `views/invoice-form.ejs`.

**Sub-tasks:**
1. In `routes/invoices.js`, locate where the server-side invoice limit is enforced; confirm it returns a detectable signal (redirect with query flag or JSON error).
2. Add an Alpine.js `x-data` component to `views/dashboard.ejs` and `views/invoice-form.ejs` that opens the modal when the limit signal is detected.
3. Build modal body: list Pro unlocks (unlimited invoices, email sending, payment links); single CTA button to the existing Stripe Checkout route; social-proof line ("Join X freelancers on Pro").
4. Test on a free account that has hit 3 invoices — modal must appear before any server error page.

---

### 2. [DONE 2026-04-23] [GROWTH] Stripe Payment Links on Invoices (Pro Feature) [M]

**App:** QuickInvoice (Node.js)
**Impact:** HIGH — turns product into a payment collection tool; dramatically raises switching cost
**Effort:** Medium
**Prerequisites:** Stripe account (already required)

**Sub-tasks:**
1. Apply migration: `ALTER TABLE invoices ADD COLUMN payment_link_url TEXT;` (update `db/schema.sql`).
2. In `routes/invoices.js`, when invoice status changes to `'sent'` and `user.is_pro`, call the Stripe API to create a Payment Link for the invoice total; store the returned URL in `payment_link_url`.
3. In `views/invoice-view.ejs`, render a **"Pay Now"** button linking to `payment_link_url` (visible only when the link exists and user is Pro).
4. In `views/invoice-print.ejs`, render the payment link as a URL and optionally an inline SVG QR code (no server dependency).
5. In `routes/billing.js`, add a webhook handler for `checkout.session.completed` from the payment link: look up the invoice by `payment_link_url` and set its status to `'paid'`. Register the event in the Stripe webhook configuration.

---

### 3. [DONE 2026-04-23] [GROWTH] Annual Billing Plan at $99/year [M]

**App:** QuickInvoice (Node.js)
**Impact:** HIGH — annual subscribers churn at roughly half the rate of monthly; provides immediate cash
**Effort:** Low–Medium
**Prerequisites:** None (Stripe already integrated); one human action to create the Stripe price

**Sub-tasks:**
1. **[Human action]** In Stripe Dashboard, create a second price on the existing Pro product: $99/year recurring. Note the new `price_...` ID.
2. Add a Monthly / Annual toggle (Alpine.js `x-data`) to `views/pricing.ejs`; toggle swaps the displayed price and updates a hidden `billing_cycle` input.
3. Add the same toggle to `views/settings.ejs` (current plan section) so existing users can switch to annual.
4. Update `routes/billing.js` Checkout session creation: read `billing_cycle` from the request body and pass the correct `price_id` (monthly vs. annual) to Stripe.
5. Verify that existing `checkout.session.completed` and `customer.subscription.updated` webhook handlers work for annual subscription events (no format difference — spot-check the event payload).

---

## [HEALTH]

### 4. [DONE 2026-04-23] [HEALTH] Stripe Dunning + Smart Retries — Code Portion [S]

**App:** QuickInvoice (Node.js)
**Impact:** MEDIUM — recovers an estimated 20–30% of failed payments with zero ongoing effort
**Effort:** Very Low (code portion only)
**Prerequisites:** None for code; Stripe Dashboard configuration requires a live Stripe account

**Sub-tasks (code — implement now):**
1. In `routes/billing.js`, extend the `customer.subscription.updated` webhook handler to handle `status === 'past_due'` and `status === 'paused'`: restrict Pro features without deleting user data.
2. Add a dismissible warning banner to `views/dashboard.ejs` rendered when `user.subscription_status === 'past_due'`; include a link to the Stripe Customer Portal to update card details.

**Human action (requires live Stripe):** In the Stripe Dashboard, enable Smart Retries, dunning emails on retry attempts, and subscription pause (not immediate cancel) on payment failure.

---

## [GROWTH]

### 5. [DONE 2026-04-23] [GROWTH] "Created with QuickInvoice" Footer on Free Plan PDFs [S]

**App:** QuickInvoice (Node.js)
**Impact:** MEDIUM — every invoice a free user sends becomes a passive acquisition touchpoint; footer removal is a tangible Pro benefit
**Effort:** Very Low
**Prerequisites:** None

**Sub-tasks:**
1. In `views/invoice-print.ejs`, wrap a footer element in `<% if (user.plan === 'free') { %>`.
2. Render: `Invoiced with QuickInvoice · quickinvoice.io/pricing?ref=pdf-footer`
3. Style subtly (small gray text, print-safe); verify it appears in browser print preview.

---

### 6. [DONE 2026-04-23] [GROWTH] InvoiceFlow — Recurring Invoice Auto-Generation (P12) [M]

**App:** InvoiceFlow (Spring Boot)
**Impact:** MEDIUM — reduces manual work for repeat clients; increases retention
**Effort:** Medium
**Prerequisites:** None

**Sub-tasks:**
1. Flyway migration (next V number): add `recurrence_frequency VARCHAR(20)` (allowed values: `WEEKLY`, `BIWEEKLY`, `MONTHLY`, `QUARTERLY`), `recurrence_next_run TIMESTAMP`, `recurrence_active BOOLEAN DEFAULT false` to the `invoices` table.
2. `InvoiceController`: add `PUT /api/invoices/{id}/recurrence` to set or clear the recurrence rule (Pro/Agency plan gate).
3. `scheduler/RecurringInvoiceJob.java`: daily `@Scheduled` job; query invoices where `recurrence_active = true AND recurrence_next_run <= NOW()`; clone the invoice (new `id`, status `DRAFT`, same line items); advance `recurrence_next_run` based on frequency.
4. Add `GET /api/invoices/recurring` to list the authenticated user's active recurring invoices.
5. Verify the existing payment reminder scheduler (`ReminderJob.java`) does not re-send reminders for DRAFT cloned invoices (check the status guard).

---

### 7. [GROWTH] Zapier Outbound Webhook on Invoice Paid (Pro Feature) [M]

**App:** QuickInvoice (Node.js)
**Impact:** MEDIUM — high switching cost once a user has integrated with Zapier or Make
**Effort:** Low
**Prerequisites:** None

**Sub-tasks:**
1. Apply migration: `ALTER TABLE users ADD COLUMN webhook_url TEXT;`
2. Add a "Zapier / Webhook" section to `views/settings.ejs` (Pro only): text input for catch-hook URL with a Save button.
3. Add or extend a route in `routes/billing.js` or `routes/invoices.js` to accept and persist `webhook_url` for the authenticated Pro user; gate behind a Pro plan check.
4. In `routes/invoices.js`, whenever an invoice status is set to `'paid'`, check `user.webhook_url` and fire an async `https.request` POST with JSON payload `{ invoice_id, amount, client_name, paid_at }`. Do not block the response on the outbound request.

---

### 8. [GROWTH] SEO Niche Landing Pages for Freelancer Verticals [M]

**App:** QuickInvoice (Node.js)
**Impact:** MEDIUM–HIGH (long-term; compounds monthly with zero ad spend)
**Effort:** Medium
**Prerequisites:** Custom domain (in `TODO.md`) recommended for SEO authority; implementable without it

**Sub-tasks:**
1. Create `views/partials/lp-niche.ejs` with slot variables: `nicheTitle`, `nicheHeadline`, `nicheDescription`, `screenshotAlt`.
2. Create `routes/landing.js` with 6 GET routes mapping niche slugs to the partial; register in `server.js`:
   - `/invoice-template/freelance-designer`
   - `/invoice-template/freelance-developer`
   - `/invoice-template/freelance-writer`
   - `/invoice-template/freelance-photographer`
   - `/invoice-template/consultant`
   - `/invoice-generator`
3. Write niche-specific headline and CTA copy for each route (CTA: "Create your first invoice free" → `/register`).
4. Add `GET /sitemap.xml` route to `server.js` returning an XML sitemap listing all landing page and marketing URLs with `<lastmod>` dates.
5. **[Human action]** Submit the sitemap URL to Google Search Console after deploying.

---

### 9. [GROWTH] InvoiceFlow — Team Seats for Agency Plan (P11) [L]

**App:** InvoiceFlow (Spring Boot)
**Impact:** HIGH — unlocks Agency tier at $49/mo
**Effort:** Large
**Prerequisites:** Email delivery must be live (SendGrid configured per `TODO_MASTER.md` step 4) for invite emails; code skeleton is implementable now

**Sub-tasks:**
1. Flyway migration (next V number): create `team_members` table — `id BIGSERIAL PK, owner_id BIGINT FK users, member_email VARCHAR(255), invite_token VARCHAR(64), status VARCHAR(20) DEFAULT 'PENDING', created_at TIMESTAMP`.
2. `team/TeamMember.java` entity + `TeamMemberRepository.java`.
3. `team/TeamController.java`:
   - `POST /api/team/invite` — Agency-gated; validate seat count ≤ 5; insert PENDING row; send invite email with token link. **Invite email sub-task blocked until SendGrid is configured.**
   - `GET /api/team` — list owner's team members.
   - `DELETE /api/team/{id}` — remove member (Agency-gated).
4. `GET /api/team/accept?token=` — validate token; set status to ACTIVE; associate member account with owner's Agency plan.
5. Update plan enforcement to count active seats for Agency tier (max 5 active members per owner).

---

### 10. [GROWTH] "Business" Tier at $29/month / $249/year (QuickInvoice) [L]

**App:** QuickInvoice (Node.js)
**Impact:** HIGH — raises ARPU ceiling from $12 to $29/month per power user
**Effort:** Medium–Large
**Prerequisites:** Annual Billing (#3 above) should be live first; team invite emails require email delivery

**Sub-tasks:**
1. **[Human action]** In Stripe Dashboard, create $29/month and $249/year prices on a new "Business" product. Note both `price_id` values.
2. `db/schema.sql`: add `'business'` as a valid plan value; add `business_profiles` table (`id, user_id, name, address, logo_url`); add `team_members` table (`id, owner_user_id, member_email, status`).
3. `middleware/auth.js`: add `is_business` helper (`user.plan === 'business'`); apply to gated route guards.
4. Update all views branching on `user.is_pro` to also handle `user.is_business` (Business inherits all Pro features).
5. `views/pricing.ejs`: add a third pricing column (Free / Pro / Business) listing Business-only features.
6. Implement multi-profile: routes for creating, listing, and switching active business profiles; render profile selector in `views/partials/nav.ejs`.
7. `views/settings.ejs`: add Business section showing seat count, invite form, and active profiles.
8. **[BLOCKED sub-task]** Team invite flow (send invite email → accept via token → add member). Requires email delivery to be live first.

---

### 13. [GROWTH] Email Delivery for QuickInvoice (Resend) [M]

**App:** QuickInvoice (Node.js)
**Impact:** HIGH — prerequisite for invoice email sending, automated reminders, churn win-back (#11), and monthly summaries (#12); currently the single largest capability gap between QuickInvoice and InvoiceFlow
**Effort:** Medium
**Prerequisites:** None (Resend free tier is sufficient to start)

**Sub-tasks:**
1. `npm install resend` and add `RESEND_API_KEY=re_...` to `.env.example`.
2. Create `lib/email.js` — thin wrapper: `sendEmail({ to, subject, html })` calls `resend.emails.send()`; returns promise; logs errors without throwing (graceful degradation pattern already used elsewhere in the codebase).
3. `routes/invoices.js` `POST /invoices/:id/status` (`draft → sent` transition for Pro users): call `sendEmail()` with the client's email, a subject of "Invoice [INV-YYYY-XXXX] from [business_name]", and an HTML body with invoice summary + payment link URL (if present). Do not block the redirect on the email — fire and forget.
4. `views/settings.ejs`: add a "Reply-to email" field (stored as `reply_to_email` on the user row via `db.updateUser`). Fallback to the registered account email.
5. `db/schema.sql`: `ALTER TABLE users ADD COLUMN IF NOT EXISTS reply_to_email VARCHAR(255);`
6. Manual smoke test: mark a test invoice as sent → verify email arrives with correct invoice number, amount, and payment link.

---

### 14. [GROWTH] In-App Onboarding Checklist (Activation Flow) [S]

**App:** QuickInvoice (Node.js)
**Impact:** HIGH — users who reach "first invoice sent" have 5–10× lower churn; the dashboard currently drops new users with no guidance
**Effort:** Very Low
**Prerequisites:** None

**Sub-tasks:**
1. `db/schema.sql`: `ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_dismissed BOOLEAN DEFAULT false;`; `db.js`: add `dismissOnboarding(userId)` update + include `onboarding_dismissed` in the `getUser` query result.
2. In `routes/invoices.js` (or a dedicated route), add `POST /onboarding/dismiss` → set `onboarding_dismissed = true` for the session user and redirect back.
3. `views/dashboard.ejs`: render a checklist card at the top for users where `!user.onboarding_dismissed`. Four steps, each links to the relevant page:
   - ✅ **Add your business info** → `/settings` (check: `user.business_name` is non-null)
   - ✅ **Create your first invoice** → `/invoices/new` (check: `stats.total_invoices >= 1`)
   - ✅ **Send an invoice to a client** (check: any invoice has `status = 'sent'`)
   - ✅ **Get paid** (check: any invoice has `status = 'paid'`)
   Mark each completed step with a green checkmark (Alpine.js toggled by initial render state); show a "Dismiss" link that POSTs to `/onboarding/dismiss`.
4. Style the card as a light blue banner (Tailwind `bg-blue-50 border border-blue-200`); keep it out of the print stylesheet.

---

### 15. [GROWTH] Contextual Pro Upsell Prompts on Locked Features [S]

**App:** QuickInvoice (Node.js)
**Impact:** MEDIUM-HIGH — the upgrade modal only fires at the invoice limit; free users who discover Pro features organically (branding page, invoice view) have high purchase intent but currently see no CTA at that moment
**Effort:** Very Low
**Prerequisites:** None

**Sub-tasks:**
1. `views/settings.ejs` — Branding section (currently rendered for all users): wrap the logo/color inputs in `<% if (user.plan !== 'free') { %> … <% } else { %>` and render a locked placeholder with text "Custom branding is a Pro feature. [Upgrade to Pro →](/billing/upgrade)" styled with a gray overlay and a lock icon (Unicode 🔒, or inline SVG).
2. `views/invoice-view.ejs` — For free-plan users, render a grayed-out "Payment Link" card with a lock icon and copy: "Pro users get a Stripe payment link on every invoice. [Upgrade →]". Only show if `!user.is_pro` (the card is already hidden for Pro-without-link; add the locked version for free users).
3. `views/dashboard.ejs` — Add a one-line Pro feature callout below the stats bar for free users: "✨ **Pro:** Email invoices directly to clients, collect payment in one click. [See plans →](/billing/upgrade)". Wrap in `<% if (user.plan === 'free') { %>`.
4. Verify none of the new conditional blocks appear in print view (`@media print { .upgrade-callout { display: none; } }` in `views/partials/head.ejs`).

---

### 16. [GROWTH] Automated Payment Reminders for QuickInvoice (Pro Feature) [M]

**App:** QuickInvoice (Node.js)
**Impact:** MEDIUM-HIGH — InvoiceFlow already has this; QuickInvoice Pro users currently have to manually follow up on overdue invoices, which is the #1 pain point the product is supposed to solve
**Effort:** Low-Medium
**Prerequisites:** Email delivery (#13 above) must be live first

**Sub-tasks:**
1. `npm install node-cron` (add to `package.json` dependencies).
2. `db/schema.sql`: `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_reminder_sent_at TIMESTAMP;` on `invoices` (not users) — `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS last_reminder_sent_at TIMESTAMP;`
3. `jobs/reminders.js` — export a `startReminderJob()` function using `node-cron` schedule `'0 9 * * *'` (daily 09:00 UTC):
   - Query: `SELECT i.*, u.email AS owner_email, u.business_name, u.plan FROM invoices i JOIN users u ON i.user_id = u.id WHERE i.status = 'sent' AND i.due_date < NOW() AND (i.last_reminder_sent_at IS NULL OR i.last_reminder_sent_at < NOW() - INTERVAL '3 days') AND u.plan IN ('pro', 'business')`.
   - For each row: call `sendEmail()` to the client email with subject "Friendly reminder: Invoice [number] is overdue" and a body including invoice total, due date, and payment link URL (if set).
   - Update `invoices.last_reminder_sent_at = NOW()` after sending.
4. `server.js`: `require('./jobs/reminders').startReminderJob();` after the DB pool is confirmed ready.
5. Write a unit test in `tests/reminders.test.js` (stub `node-cron` and `lib/email.js`) verifying: overdue Pro invoice → email sent; free-plan invoice → skipped; already-reminded-within-3-days → skipped.

---

### 17. [GROWTH] Google OAuth One-Click Signup [M]

**App:** QuickInvoice (Node.js)
**Impact:** MEDIUM — every extra form field at registration costs ~5–10% of signups; Google OAuth removes 4 fields and eliminates password anxiety; most freelancer SaaS tools see 30–50% of registrations switch to OAuth within 30 days of adding it
**Effort:** Medium
**Prerequisites:** Custom domain live (OAuth redirect URI must be a real domain); Google Cloud project with OAuth 2.0 credentials

**Sub-tasks:**
1. `npm install passport passport-google-oauth20 express-session` (session already in use — just add passport packages).
2. `routes/auth.js`: add `GET /auth/google` (initiates flow with `scope: ['profile', 'email']`) and `GET /auth/google/callback` (handles code exchange). On success: look up or create user by `google_id` OR email match; set `req.session.user` identically to the existing login flow; redirect to `/dashboard`.
3. `db/schema.sql`: `ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id VARCHAR(64) UNIQUE;` — `db.js`: add `findUserByGoogleId(googleId)` and `upsertGoogleUser({ googleId, name, email })` helpers.
4. `views/auth/login.ejs` and `views/auth/register.ejs`: add a "Continue with Google" button above the existing form (styled with the standard Google G icon inline SVG from Google Brand Guidelines; white button, border, shadow). Separate with a centered "or" divider.
5. `middleware/auth.js`: `requireAuth` already checks `req.session.user` — no changes needed (OAuth sets the same session key).
6. **[Human action]** Create a Google Cloud project → enable Google+ API → create OAuth 2.0 Client ID with redirect URI `https://yourdomain.com/auth/google/callback`. Add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` to `.env.example` and `TODO_MASTER.md`.

---

### 18. [GROWTH] Referral Program with Stripe Coupon Rewards [M]

**App:** QuickInvoice (Node.js)
**Impact:** MEDIUM — referred users convert at 3–5× the rate of cold traffic and churn at half the rate; a one-month-free reward for the referrer costs $12 and acquires a user with estimated $60–$120 LTV
**Effort:** Medium
**Prerequisites:** Email delivery (#13) recommended so referral invite links can be emailed; Stripe already integrated

**Sub-tasks:**
1. `db/schema.sql`: `ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code VARCHAR(12) UNIQUE;` and `ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by_code VARCHAR(12);`. Generate code on user creation (`Math.random().toString(36).slice(2, 8).toUpperCase()` is sufficient).
2. `db.js`: add `getUserByReferralCode(code)`, update `createUser()` to generate and store `referral_code`, and accept optional `referred_by_code` on insert.
3. `routes/auth.js` `POST /register`: read `req.body.ref` (from landing page URL `?ref=XXXXXX`); store as `referred_by_code`; persist `?ref=` in the register link via `views/auth/register.ejs` hidden input.
4. `routes/billing.js` `customer.subscription.updated` handler (when `status === 'active'` and newly upgraded): look up `user.referred_by_code`; if set and referrer is a Pro user, call `stripe.coupons.create({ percent_off: 100, duration: 'once' })` and `stripe.subscriptionItems.update(referrerSubItemId, { coupon })` to apply one free month. Mark `referred_by_code` as redeemed (add `referral_redeemed BOOLEAN DEFAULT false` to users) to prevent double-apply.
5. `views/settings.ejs`: add a "Refer a friend" card showing the user's unique referral URL (`APP_URL/register?ref=XXXXXX`) with a copy button (Alpine.js clipboard); copy reads "Get 1 free month for every friend who upgrades to Pro."

---

## BLOCKED — Do Not Start Until Prerequisites Are Met

### 11. [GROWTH] [BLOCKED] Churn Win-Back Email Sequence [L]

**App:** QuickInvoice (Node.js)
**BLOCKED:** Email delivery is not implemented in QuickInvoice. Complete "Add email delivery (Resend or SendGrid)" in `TODO.md` first.
**Impact:** MEDIUM
**Effort:** Low–Medium (after email is live)

**Sub-tasks (ready to execute once email delivery exists):**
1. `db/schema.sql`: create `churn_sequences` table — `(id, user_id, email, step, scheduled_at, sent_at)`.
2. Set up `node-cron` daily job in `server.js` (or `jobs/churn.js`): query rows where `scheduled_at <= NOW() AND sent_at IS NULL`; send the correct email template; update `sent_at`.
3. Build 3 email templates:
   - Day 0: "Your data is safe for 30 days."
   - Day 3: "Here's what you're missing — 20% off your first month back." (generate Stripe coupon via `stripe.coupons.create`; embed link)
   - Day 14: "Last chance — invoice history will be archived soon."
4. In `routes/billing.js` `customer.subscription.deleted` handler: insert 3 rows into `churn_sequences` for days 0, 3, and 14.

---

### 12. [GROWTH] [BLOCKED] Monthly Revenue Summary Email to Pro Subscribers [M]

**App:** QuickInvoice (Node.js)
**BLOCKED:** Email delivery is not implemented in QuickInvoice. Complete "Add email delivery (Resend or SendGrid)" in `TODO.md` first.
**Impact:** MEDIUM — reduces passive churn by reminding users of value received each month
**Effort:** Low (after email is live)

**Sub-tasks (ready to execute once email delivery exists):**
1. Set up `node-cron` monthly job (1st of each month, 09:00 UTC) in `server.js` or `jobs/monthly-summary.js`.
2. For each Pro user, run existing `db.js` aggregation queries to retrieve: total invoiced this month vs. last, amount collected vs. outstanding, new clients invoiced.
3. Build an HTML email template with those 4 data points and a "View your dashboard →" CTA.
4. Send via the email delivery provider. Log sends in an `email_log` table to prevent duplicates on restart.

---

## ARCHIVE — Completed Items

### InvoiceFlow Phase 1 (all completed 2026-04-22)

- [DONE 2026-04-22] **P1** — Project scaffold: `pom.xml`, `application.yml`, Flyway migrations (users, clients, invoices, line_items)
- [DONE 2026-04-22] **P2** — Auth: user registration + JWT login endpoints
- [DONE 2026-04-22] **P3** — Client API: CRUD with plan-limit enforcement
- [DONE 2026-04-22] **P4** — Invoice API: CRUD with line items + plan-limit enforcement
- [DONE 2026-04-22] **P5** — PDF generation: iText8, download endpoint
- [DONE 2026-04-22] **P6** — Email delivery: send invoice PDF via SendGrid SMTP
- [DONE 2026-04-22] **P7** — Stripe subscription Checkout session + webhook sync
- [DONE 2026-04-22] **P8** — Payment reminder scheduler (daily job, emails overdue invoices)
- [DONE 2026-04-22] **P9** — Dashboard stats endpoint

### InvoiceFlow Phase 2 — Partial

- [DONE 2026-04-22] **P10** — Custom branding (logo upload, brand color) — Pro/Agency plan (confirmed in CHANGELOG)
