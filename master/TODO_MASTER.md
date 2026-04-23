# Actions Required from Master

> **Audited:** 2026-04-23 — All items reviewed against CHANGELOG. Items 1–8 are human deployment/configuration actions; none are resolved by code commits. No items tagged [LIKELY DONE - verify]. Fixed numbering (item 8 was listed before item 7). Code for all P1–P10 features is complete; deployment is the only remaining blocker to revenue.

---

## 1. Provision PostgreSQL database (~2 min)
Create a PostgreSQL 15 database named `invoiceflow`. Then set env vars:
```
DATABASE_URL=jdbc:postgresql://<host>:5432/invoiceflow
DATABASE_USER=<user>
DATABASE_PASSWORD=<password>
```
Flyway will create the schema automatically on first startup.

## 2. Set JWT secret (~1 min)
Generate a random 256-bit secret and set:
```
JWT_SECRET=<your-64-char-random-string>
```

## 3. Create Stripe products and prices (~5 min)
In the Stripe Dashboard (or CLI), create 3 recurring prices:
- Solo: $9/mo
- Pro: $19/mo
- Agency: $49/mo

Then set:
```
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...   (from Stripe CLI: stripe listen --forward-to ...)
STRIPE_PRICE_SOLO=price_...
STRIPE_PRICE_PRO=price_...
STRIPE_PRICE_AGENCY=price_...
```

## 4. Configure email (SendGrid SMTP, ~2 min)
```
MAIL_HOST=smtp.sendgrid.net
MAIL_PORT=587
MAIL_USERNAME=apikey
MAIL_PASSWORD=<sendgrid-api-key>
FROM_EMAIL=billing@yourdomain.com
```

## 5. Set BASE_URL
```
BASE_URL=https://yourdomain.com
```
(Used to construct Stripe Checkout success/cancel redirect URLs.)

## 6. Deploy
```bash
cd invoiceflow
mvn package -q
java -jar target/invoiceflow-0.0.1-SNAPSHOT.jar
```
Or deploy the fat JAR to Heroku/Railway/Render with the env vars above.

## 7. Register the Stripe webhook endpoint
In Stripe Dashboard → Webhooks → Add endpoint:
- URL: `https://yourdomain.com/api/stripe/webhook`
- Events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `payment_link.payment_completed`

## 9. Confirm QuickInvoice webhook covers Payment Link events (added 2026-04-23)
QuickInvoice's existing Stripe webhook at `POST /billing/webhook` is already subscribed to `checkout.session.completed` (used for Pro subscriptions). The new invoice Payment Link feature re-uses this same event type, distinguished by `session.mode === 'payment'` with a `session.payment_link` ID. **No new event subscription needed** — just verify after deploy that the endpoint shows `checkout.session.completed` events and that a test invoice Payment Link payment flips the invoice to `paid` in the DB.

If you want to harden against network glitches, also subscribe the endpoint to `payment_intent.succeeded` (current code ignores it; future hardening can use it as a fallback).

## 10. Run idempotent migration for `payment_link_url` / `payment_link_id` (added 2026-04-23)
The invoice Payment Links feature adds two columns. `db/schema.sql` includes idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements, so a fresh `psql -f db/schema.sql` run against production is safe and a no-op on already-migrated DBs.

## 11. Create Stripe annual Pro price and set env var (added 2026-04-23)
The new annual billing cycle (**$99/year**) is fully implemented on the QuickInvoice side (UI toggle on pricing, settings, and the upgrade modal; `billing_cycle` flows through `POST /billing/create-checkout`). It requires one human action to activate:

1. In the Stripe Dashboard, open the existing **Pro** product and add a second recurring price: **$99 / year**. Copy the new `price_...` ID.
2. Set the env var on the deployed app:
   ```
   STRIPE_PRO_ANNUAL_PRICE_ID=price_...
   ```
3. Verify: hit `/billing/upgrade`, toggle to Annual, click upgrade — the Stripe Checkout page should show $99/year.

**Until this is done, annual selections gracefully fall back to the monthly $12/mo price** (the `resolvePriceId()` helper in `routes/billing.js` handles this — the CTA never breaks, users just don't get the annual discount). No code change is needed once the env var is set; the next request picks it up automatically.

The existing `checkout.session.completed` and `customer.subscription.updated` webhook handlers already work for annual subscriptions — no webhook change needed.

## 12. Enable Stripe Smart Retries + Dunning Emails (added 2026-04-23)
The QuickInvoice code for Stripe Dunning is now live (`customer.subscription.updated` webhook now tracks past_due/paused, dashboard renders a dismissible "Update payment method" banner that deep-links to the Customer Portal). Activating the recovery flow requires three human actions in the Stripe Dashboard on the live account:

1. **Settings → Billing → Subscriptions and emails → Smart Retries:** toggle ON. Accept the default schedule (retries over ~14 days) or customise.
2. **Settings → Billing → Subscriptions and emails → Emails to customers:** enable "Email customers for failed payments" and "Send emails about expiring cards". These are Stripe-sent dunning emails — no code needed on our side.
3. **Settings → Billing → Subscriptions and emails → Manage failed payments:** select **"Pause subscription"** (not "Cancel subscription") on final retry failure. This is critical — pausing preserves `stripe_subscription_id`, which is what lets the user self-recover via the in-app banner → Customer Portal. Cancelling would require a fresh Checkout.

Also run the idempotent schema migration once after deploy (adds `subscription_status` column):
```bash
psql $DATABASE_URL -f db/schema.sql
```

**Verification:** create a test subscription, use Stripe's test card `4000 0000 0000 0341` (successful for subscription creation, fails on first renewal) to simulate a past_due state, and confirm the dashboard renders the red banner with an "Update payment method →" button that opens the Stripe Customer Portal.

## 14. QuickInvoice: idempotent migration for `webhook_url` column (added 2026-04-23)
The new Zapier outbound-webhook feature (INTERNAL_TODO #7) adds a single nullable `webhook_url TEXT` column to `users`. `db/schema.sql` includes an idempotent `ALTER TABLE users ADD COLUMN IF NOT EXISTS webhook_url TEXT;` statement, so:

```bash
psql $DATABASE_URL -f db/schema.sql
```

is safe to run against production (no-op on already-migrated DBs). No env var, no Stripe config, no Zapier/Make account required — this is a pure code feature. Users paste their own catch-hook URL into `/billing/settings`.

**Verify after deploy (1 min):** log in as a Pro user, paste a test URL from https://webhook.site into the **Zapier / Webhook** section of `/billing/settings`, mark any invoice as paid, and confirm a POST with `event: "invoice.paid"` arrives at the webhook.site endpoint.

---

## 15. QuickInvoice: submit sitemap to Google Search Console (added 2026-04-23)
The SEO niche landing pages feature (INTERNAL_TODO #8) is now live at:
- `/invoice-template/freelance-designer`
- `/invoice-template/freelance-developer`
- `/invoice-template/freelance-writer`
- `/invoice-template/freelance-photographer`
- `/invoice-template/consultant`
- `/invoice-generator`

plus a machine-readable `/sitemap.xml`. To unlock organic search traffic:

1. **Set `APP_URL` env var** on the deployed app so sitemap entries carry the canonical production hostname:
   ```
   APP_URL=https://yourdomain.com
   ```
   If unset, the sitemap falls back to the `Host` header from the incoming request (works but non-canonical if the app is behind a proxy).

2. **Submit the sitemap to Google Search Console** (~5 min):
   - Sign in at https://search.google.com/search-console
   - Add and verify your domain property (DNS TXT record or HTML file)
   - Left nav → **Sitemaps** → enter `sitemap.xml` → Submit
   - Google typically indexes the listed URLs within 3–14 days

3. **(Optional) Submit to Bing Webmaster Tools** at https://www.bing.com/webmasters — same process, covers ~5% of US search.

4. **Verify before submitting:** open `https://yourdomain.com/sitemap.xml` in a browser — it should return XML with 9 `<url>` entries (6 niche + 3 core: `/`, `/auth/register`, `/auth/login`).

No code change, no env var dependency for the pages themselves to work — only the sitemap's hostname benefits from `APP_URL`. Indexing is asynchronous; expect measurable long-tail traffic within 30–60 days of submission.

---

## 13. InvoiceFlow: deploy V3 Flyway migration for recurring invoices (added 2026-04-23)
The InvoiceFlow recurring-invoice feature (INTERNAL_TODO #6) adds migration `V3__recurring_invoices.sql`. On the **next deploy**, Flyway picks it up automatically — no manual action required. The migration adds four additive columns to the `invoices` table (`recurrence_frequency`, `recurrence_next_run`, `recurrence_active DEFAULT FALSE`, `recurrence_source_id`) plus two indexes. No data backfill, no downtime, and existing invoices behave exactly as before (`recurrence_active` defaults to FALSE).

A new daily scheduler runs at **08:00 UTC** (`@Scheduled(cron = "0 0 8 * * *")`) one hour before the existing reminder job. No extra infra is needed — Spring's in-process scheduler is already enabled via `@EnableScheduling` in `InvoiceFlowApplication`.

**Verify after deploy (2 min):** log in as a Pro/Agency account, `PUT /api/invoices/{id}/recurrence` with `{"frequency":"MONTHLY","active":true}`, confirm `GET /api/invoices/recurring` lists it, then wait for 08:00 UTC (or invoke the job via a test harness) and confirm a new `DRAFT` invoice appears with `recurrence_source_id` pointing at the template.

---

## [MARKETING] Growth & Distribution Actions

> These require Master action — no code needed. Execute in order of income impact.

### 12. [MARKETING] Launch on Product Hunt

**Impact:** HIGH — a well-executed Product Hunt launch drives 500–2,000 targeted visitors in 24 hours, many of whom are freelancers or makers actively looking for tools
**Action:**
1. Create a hunter account at producthunt.com (if not already done).
2. Prepare the listing:
   - **Name:** QuickInvoice
   - **Tagline:** "Professional invoices with Stripe payment links — in under a minute"
   - **Description:** 2–3 sentences about the pain (chasing payments), the solution (one-click invoice → client pays via Stripe), and the price (free to start, $12/mo for Pro).
   - **Gallery:** 3–5 screenshots: landing page, invoice editor, invoice with Pay Now button, dashboard stats, pricing page.
   - **First comment:** Write a "maker comment" explaining why you built it and linking to a special Product Hunt discount (create a Stripe coupon for 50% off first month with code `PH50`).
3. Launch on a Tuesday or Wednesday between 12:01 AM PST and 6 AM PST (maximizes upvote window).
4. Post in r/SideProject and Indie Hackers the same day announcing the launch.

---

### 13. [MARKETING] List on Freelancer Tool Directories

**Impact:** MEDIUM-HIGH — directory listings drive passive, evergreen organic traffic and backlinks that improve SEO; each listing takes 15–30 minutes
**Action:** Create consistent listings on each of the following. Use the same description, screenshots, and feature list for each. Category: "Invoicing Software" or "Freelancer Tools."
- **G2.com** (g2.com/products/new) — highest domain authority; reviews from real users will appear in Google search results for "QuickInvoice reviews"
- **Capterra** (capterra.com/vendors) — strong for B2B SaaS discovery
- **AlternativeTo** (alternativeto.net/add-software) — lists QuickInvoice as an alternative to FreshBooks, Wave, Bonsai; captures high-intent comparison traffic
- **GetApp** (getapp.com — same vendor portal as Capterra)
- **SaaSHub** (saashub.com/add) — frequented by developers and indie makers
- **Indie Hackers Products** (indiehackers.com/products/new) — maker community with high conversion intent

**For each listing include:** URL, tagline, 3–5 screenshots, feature list (unlimited invoices, Stripe payment links, custom branding, PDF export, automated reminders), pricing ($0 free / $12 mo / $99 yr), and a link to the pricing page.

---

### 14. [MARKETING] Reddit & Community Launch Posts

**Impact:** MEDIUM — targeted posts in high-traffic freelancer communities generate signups with no ad spend; subreddits with 100k+ freelancers are a direct audience match
**Action:** Post in the following communities within the same week. Titles should focus on the pain/solution, not the product name. Do NOT post the same text verbatim (Reddit detects this). Write each post naturally.
- **r/freelance** (300k+ members): "I got tired of chasing payments so I built a tool that auto-sends Stripe payment links when you mark an invoice sent — free to try"
- **r/webdev**: "Built a no-nonsense invoicing tool for developers doing freelance work — payment links, PDF export, reminders"
- **r/Entrepreneur**: "Zero to $X MRR in N weeks building an invoicing SaaS — here's what's working"
- **r/SideProject**: "Show HN-style: QuickInvoice — freelancer invoicing with built-in Stripe payment collection"
- **Facebook group: Freelancers Union** — community post with a screenshot of a paid invoice notification
- **Indie Hackers** — post a "Milestone" update once you hit first paid subscriber, linking to the product

---

### 15. [MARKETING] Create a 60-Second Demo Video

**Impact:** MEDIUM — video on the landing page increases conversion by 20–30% on average; a screen recording showing "invoice created → client pays → dashboard updates" is the fastest way to communicate value
**Action:**
1. Use Loom (loom.com, free tier) to record a 60-second screen walkthrough:
   - 0–10s: Landing page intro ("Here's how QuickInvoice works")
   - 10–30s: Create a new invoice with one line item, set due date, mark as Sent
   - 30–45s: Show the auto-generated Stripe Payment Link; open it as the "client" in an incognito window
   - 45–60s: Return to dashboard — show invoice flipped to Paid and the revenue stat updated
2. Download the MP4 from Loom.
3. Host it on the landing page (`views/index.ejs`) above the feature grid — embed as `<video autoplay muted loop playsinline>` (silent autoplay) with a "▶ Watch demo" click-to-unmute overlay.
4. Share the same video on Twitter/X, LinkedIn, and as a YouTube short titled "Get paid in 30 seconds — QuickInvoice."

---

### 16. [MARKETING] Set Up Google / GitHub OAuth Credentials

**Impact:** MEDIUM — required prerequisite for dev task #17 (Google OAuth signup); without the OAuth client credentials the code cannot be activated
**Action:**
1. Go to console.cloud.google.com → Create a new project named "QuickInvoice".
2. Enable "Google+ API" (or "People API").
3. Credentials → Create OAuth 2.0 Client ID:
   - Application type: Web
   - Authorized redirect URI: `https://yourdomain.com/auth/google/callback`
4. Copy the **Client ID** and **Client Secret**.
5. Set on the deployed app:
   ```
   GOOGLE_CLIENT_ID=...apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=...
   ```
6. Update the Stripe webhook redirect URI allowlist if required.

---

### 17. [MARKETING] Tweet / LinkedIn Content Series (Invoicing Tips)

**Impact:** MEDIUM — consistent content in the freelancer space builds an audience that converts to users over 4–8 weeks; positions QuickInvoice as a knowledgeable resource, not just an ad
**Action:** Post one piece of content per week for 6 weeks. Examples:
- "5 invoicing mistakes that delay your payment (and how to fix them)" — thread, end with a link to QuickInvoice
- "How to write an invoice payment terms clause that actually gets paid" — tip thread
- "I analyzed 1,000 freelancer invoices. Here's what separates those paid on time vs. 30 days late."
- "Free invoice template for [web designers / photographers / consultants]" — link to the niche landing page (after SEO pages are live, dev task #8)
- Share the demo video (item 15 above) as a native Twitter video upload (not a link)
- Post a milestone ("First 10 paying users!") to build transparency/trust

---

## 8. Set logo uploads directory (added 2026-04-22)
Logo uploads are stored on the local filesystem. Set a persistent path (e.g., an attached volume on Heroku/Railway):
```
UPLOADS_DIR=/var/data/invoiceflow-uploads
```
If unset, defaults to `./uploads` relative to the working directory (not persistent across Heroku dyno restarts — use an attached volume or swap this for S3 in production).
