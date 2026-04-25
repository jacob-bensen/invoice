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

### 18. [MARKETING] Launch an Affiliate / Partner Program

**Impact:** HIGH — referred users convert at 3–5× the rate of cold traffic and churn at half the rate; a 20–30% recurring commission offer is extremely attractive to freelancer bloggers, YouTubers, and newsletter authors who already have the target audience; this is a compounding, zero-upfront-cost acquisition channel
**Action:**
1. Sign up for **Rewardful** (rewardful.com, $49/mo Starter — free 14-day trial). It integrates directly with Stripe and tracks affiliate-referred checkouts automatically via a UTM parameter.
2. Set commission to **25% recurring** (this is the standard for SaaS affiliate programs at this price point; at $12/mo Pro, an affiliate earns $3/mo per referral indefinitely — a strong enough incentive for micro-influencers).
3. Create a public affiliate landing page at `/affiliates` on the site (or use Rewardful's hosted page). Copy: "Earn 25% recurring revenue for every freelancer you refer to QuickInvoice. Most affiliates earn $50–$500/mo."
4. Reach out directly to 10 target affiliates with a templated email. Prioritize:
   - **Freelancer newsletters:** Freelance Weekly (freelanceweekly.email), Swipe Files, The Freelance Folder, Elna Cain's freelance writing community
   - **YouTube channels:** search "freelance invoicing tutorial" — any channel with 5k+ views per video is worth a pitch
   - **Indie Hacker / maker blogs:** writers who review SaaS tools in the productivity / freelance space
   - **Template marketplaces:** Notion template creators who serve freelancers — they can add a "recommended tools" section
5. Pitch email subject: "Earn recurring revenue recommending QuickInvoice to your audience — 25% lifetime commission."
6. Share the affiliate dashboard link in the email so they can see real-time conversions from day one.

---

### 19. [MARKETING] Submit "Show HN" to Hacker News

**Impact:** HIGH — a well-timed Show HN post for a useful indie tool typically drives 200–2,000 targeted visitors in 24 hours; HN readers are developers who freelance, CTOs who hire contractors, and power users who spread tools; a successful post can generate 20–100 signups in a single day at zero cost
**Action:**
1. Wait until the product is fully deployed and the 7-day free trial (#19 in INTERNAL_TODO) is live — the trial dramatically reduces the bounce rate from HN visitors.
2. Write the HN post:
   - **Title:** `Show HN: QuickInvoice – freelancer invoicing with Stripe payment links and auto-reminders`
   - **Body (first comment, posted immediately after submission):** 2–3 short paragraphs. Explain the pain (freelancers spend hours chasing payments), what makes it different (the invoice IS the payment page — clients click Pay and it's done via Stripe), and the pricing model (free to start, $12/mo for Pro, 7-day free trial). End with: "Happy to answer questions about the tech stack (Node.js + Stripe + PostgreSQL) or the product decisions."
3. Post on a **Tuesday or Wednesday** between **6 AM and 9 AM EST** — this is the HN sweet spot for visibility before the US workday rush.
4. Do NOT ask friends to upvote (HN penalizes coordinated voting). Do respond to every comment within the first 2 hours — engagement velocity matters for ranking.
5. Cross-post the milestone to Indie Hackers and r/SideProject the same day.

---

### 20. [MARKETING] Freelancer Newsletter Outreach (Pitch for Feature Mentions)

**Impact:** MEDIUM-HIGH — a single mention in a freelancer newsletter with 10,000+ subscribers can drive 100–500 targeted signups; unlike ads, editorial mentions are trusted; offering free Pro accounts in exchange for a mention is a $12/mo cost that acquires users with $100+ LTV
**Action:** Draft a short outreach email (under 100 words) and send to each of the following. Use a personal, non-promotional tone — you're a maker sharing a tool, not pitching an ad.

**Email template:**
> Subject: Tool you might want to share with your readers — QuickInvoice
>
> Hi [Name], I built QuickInvoice (quickinvoice.io) for freelancers who are tired of chasing payments. When you mark an invoice as Sent, it automatically creates a Stripe Payment Link so clients pay in one click — no login required. Free to start, $12/mo for Pro features. Thought your readers might find it useful. Happy to give you a free Pro account to try it out. No strings attached.

**Target publications (send one at a time, track opens):**
- **Freelance Weekly** (freelanceweekly.email) — 15,000+ subscribers, freelancer tool roundups every issue
- **Swipe Files** (swipefiles.com) — marketing/freelance audience, regularly features SaaS tools
- **The Freelancer's Year** newsletter — UK-based, strong design freelancer audience
- **Hiten Shah's Product Habits** — SaaS-focused, often highlights indie tools
- **Remote Tools Weekly** (remotetools.com) — features productivity tools for remote workers, large freelancer overlap
- **Dense Discovery** (densediscovery.com) — design/creative community; ideal for the designer/photographer niche pages

Track replies in a spreadsheet. Follow up once if no reply after 7 days.

---

### 21. [MARKETING] Add Real Testimonials to Landing and Pricing Pages

**Impact:** MEDIUM-HIGH — the social proof section (dev task #20 in INTERNAL_TODO) is built with placeholder testimonials; replacing them with real quotes from actual users drives a 10–20% conversion lift; this is a pure copy task
**Action:**
1. After the first 10 Pro signups, email each user: "We'd love to feature your experience on our site — would you share one sentence about how QuickInvoice has helped you? We'll credit you by first name and role."
2. Collect 3 quotes. Requirements for each: specific (mentions a concrete outcome like "paid on time", "stopped chasing payments"), short (1–2 sentences), authentic (no marketing buzzwords).
3. Replace the placeholder testimonials in `views/index.ejs` (marked with `<!-- MASTER: update the count and replace placeholder testimonials -->`) with the real quotes, names, and roles.
4. Update the user count number (currently `500+` placeholder) to match actual signups rounded down to the nearest 50. Keep updating this number monthly — social proof compounds as the number grows.

---

### 22. [MARKETING] Apply for AppSumo Lifetime Deal

**Impact:** HIGH — AppSumo has 1M+ deal-seeking subscribers; a well-structured lifetime deal (e.g. $69 once → lifetime Pro access capped at 2,000 invoices/mo) can generate $10,000–50,000 in a single week and creates an instant user base to collect testimonials, bug reports, and referrals; AppSumo customers churn at near-zero rates (they've already paid) and become vocal advocates
**Action:**
1. Apply at **appsumo.com/partners** (the "List your product" form). Category: "Business & Productivity" → "Invoicing & Billing."
2. In the application, emphasise: Stripe Payment Links (unique vs. most competitors), annual billing option, Zapier webhook, PDF export, and the roadmap (recurring invoices coming to QuickInvoice).
3. Proposed deal structure: **$69 one-time** → Lifetime Pro access (unlimited invoices, clients, payment links, custom branding, Zapier webhook). AppSumo typically takes 25–50% of revenue; structure the deal so you net at least $35/LTD customer. At 500 sales that's $17,500–35,000 upfront.
4. Include 5 screenshots: landing page, invoice editor with line items, invoice with Pay Now button, payment dashboard stats, settings with Zapier webhook.
5. **Prerequisite:** Product must be live with a real domain, functional payment flow, and at least 5 real (non-test) user signups to be accepted by AppSumo's review team. Time the application after Product Hunt launch (#12 above) to show traction.
6. **Code note:** AppSumo purchases fire a webhook; the autonomous team can implement AppSumo redemption codes mapped to lifetime plan grants in a future sprint (flag this if accepted).

---

### 23. [MARKETING] Submit QuickInvoice to Stripe App Marketplace

**Impact:** HIGH — Stripe's App Marketplace surfaces tools directly to existing Stripe merchants who are already paying with Stripe; the target persona (freelancers and small agencies using Stripe) is a perfect zero-CAC match; a listing puts QuickInvoice in front of millions of Stripe users at the moment they're looking for invoicing tools
**Action:**
1. Apply at **stripe.com/app-marketplace** → "List your app." Category: Invoicing.
2. Prepare the listing:
   - **App name:** QuickInvoice
   - **Tagline:** "Professional invoices with built-in Stripe Payment Links — for freelancers"
   - **Description:** 2–3 sentences. Emphasise: creates Stripe Payment Links automatically when you send an invoice, clients pay in one click, no login required, status auto-updates to Paid via webhook.
   - **Screenshots:** 3–5 images covering the invoice editor, the Pay Now button on an invoice, and the dashboard stats.
   - **Stripe features used:** Checkout, Payment Links, Customer Portal, Webhooks — all existing integrations.
3. Stripe requires an OAuth integration for Marketplace apps. The autonomous team will need to implement Stripe Connect for the listing (INTERNAL_TODO sub-task to be added if accepted). For the initial application, note that the app currently uses API keys; Connect will be added as part of the Marketplace onboarding.
4. **Timeline:** Stripe's review typically takes 2–4 weeks. Submit early so the listing is live before the Product Hunt launch (#12).

---

### 24. [MARKETING] Submit QuickInvoice as a Native Zapier App (Zapier Marketplace)

**Impact:** MEDIUM-HIGH — Zapier has 3M+ users who actively search for new app integrations; a native Zapier app listing (separate from the outbound webhook feature in INTERNAL_TODO #7) makes QuickInvoice discoverable inside the Zapier UI under "Invoicing" and puts it in front of exactly the power users most likely to upgrade to Pro; it also enables pre-built Zap templates ("When Stripe payment received → Create QuickInvoice invoice") that appear in Google search results
**Action:**
1. Create a Zapier developer account at **developer.zapier.com** (free).
2. Use the Zapier CLI to scaffold a new integration: `npm install -g zapier-platform-cli && zapier init quickinvoice`. Implement at minimum:
   - **Trigger: "Invoice Paid"** — polls `GET /api/invoices?status=paid&since=` or uses the existing outbound webhook as a REST Hook trigger. The outbound webhook (INTERNAL_TODO #7) already sends the correct JSON payload — this maps directly to a Zapier REST hook.
   - **Action: "Create Invoice"** — POSTs to `POST /invoices/new` with client name, line items, and due date. This requires an API-key auth flow (add `GET /auth/api-key` endpoint that returns the session user's API key stored in the `users` table).
3. Write 3 Zap templates to submit alongside the integration:
   - "When an invoice is paid in QuickInvoice → Add a row to Google Sheets"
   - "When a new client is added in QuickInvoice → Add contact to Mailchimp"
   - "When an invoice is paid in QuickInvoice → Post a message to Slack"
4. Submit for Zapier review (typically 2–6 weeks for public listing approval).
5. **Code note:** this requires a small API key auth system in QuickInvoice (`ALTER TABLE users ADD COLUMN api_key VARCHAR(64) UNIQUE`, generated on first `/settings` load). Flag to the autonomous team to implement as a prerequisite.

---

### 25. [MARKETING] Agency Cold Email Campaign (Target Small Creative Agencies)

**Impact:** MEDIUM — Agency plan at $49/mo; acquiring 20 agency customers = $980 MRR from a single outreach campaign; agencies managing 5–15 freelancers are the exact use case for the Agency plan's team-seat feature (INTERNAL_TODO #9); unlike inbound marketing, this is a direct, measurable experiment with a clear ROI calculation
**Action:**
1. Build a prospect list of 100–200 small creative agencies and independent studio owners using **LinkedIn Sales Navigator** (7-day free trial) or **Hunter.io** (free tier, 25 searches/mo). Search criteria: "Creative Director", "Studio Owner", "Agency Principal" with 2–15 employees, in English-speaking markets (US, CA, UK, AU).
2. Write a 3-email sequence (use a tool like Instantly.ai or Lemlist, ~$30–50/mo):
   - **Email 1 (Day 0):** Subject: "How [Agency Name] invoices their clients." Body (60 words max): introduce QuickInvoice, 1 sentence on the team-seat feature ("manage invoicing for your whole team from one account"), free trial CTA.
   - **Email 2 (Day 4):** Subject: "One thing freelance agencies hate about invoicing." Body: 1–2 pain points (chasing payments, re-entering client details for retainers), link to the `/invoice-generator` landing page.
   - **Email 3 (Day 9):** Subject: "Last check-in — free agency account." Body: 2-sentence "no hard feelings" close + offer a 30-day free Agency trial with Stripe coupon code (create a 100%-off-first-month coupon in Stripe Dashboard).
3. Track: open rate target >40%, reply rate target >5%, trial signup rate target >2%. At 200 prospects and 2% conversion that's 4 Agency accounts = $196 MRR from one afternoon of setup.
4. **Prerequisite for team-seat pitch:** INTERNAL_TODO #9 (InvoiceFlow team seats) must be complete before this campaign goes out, or the Agency plan pitch must be limited to QuickInvoice's existing multi-user-friendly features (shared billing, unlimited invoices, Zapier webhook).

---

## 16. (Optional) Tune auth rate-limit cap (added 2026-04-25)

The new auth rate limiter (INTERNAL_TODO H3) defaults to **10 POSTs/minute/IP** on `POST /auth/login` and `POST /auth/register`. No action required to ship — the default is safe. To raise or lower the cap on the deployed app, set:

```
AUTH_RATE_LIMIT_MAX=<integer>
```

Lower (e.g. `5`) for tighter abuse defence on a quiet domain; raise (e.g. `20`) if a legitimate office NAT shares an IP across many users. The 429 response gracefully re-renders the login/register form with a "Too many attempts" flash — no support tickets expected at the default.

No DB migration, no Stripe config, no new dependencies beyond the install of `express-rate-limit` (MIT, included in the lockfile).

---

## 17. (Verification only) Confirm security headers on prod (added 2026-04-25)

INTERNAL_TODO H4 (helmet security headers) shipped in this commit. No new env var, no DB migration, no Stripe change, no human action needed to make it work — `helmet` (MIT) is now a runtime dep and the middleware is wired into `server.js` ahead of all routes. After your next deploy, run:

```
curl -sI https://<prod-host>/ | grep -iE 'content-security-policy|strict-transport|x-content-type|x-frame|referrer-policy|x-powered-by'
```

You should see `Content-Security-Policy`, `Strict-Transport-Security` (max-age 15552000; includeSubDomains), `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, **no** `X-Powered-By`, and either `X-Frame-Options: SAMEORIGIN` or `frame-ancestors 'none'` inside the CSP (both are emitted). If a future view adds a new external script source (e.g. a fonts.googleapis.com stylesheet, a Plausible analytics tag, or a Stripe Elements iframe), the page will silently break in DevTools console with a CSP violation. Fix in `middleware/security-headers.js` by adding the new origin to the relevant directive — do **not** remove helmet to "fix" the symptom.

`Strict-Transport-Security` is intentionally suppressed when `NODE_ENV !== 'production'` so local `http://localhost:3000` dev traffic is not pinned to HTTPS for 6 months by the browser.

---

## 18. QuickInvoice: provision Resend API key + verify sending domain (added 2026-04-25)

INTERNAL_TODO #13 (email delivery for QuickInvoice) shipped in this commit. The wrapper at `lib/email.js` is fully wired into the "Mark Sent" status transition for Pro/Agency users, but it currently no-ops in production because `RESEND_API_KEY` is unset. **The code is safe to deploy as-is — every send returns `{ ok:false, reason:'not_configured' }` until the key is provisioned, and no other route's behaviour depends on that result.** Do steps 1–4 below to flip the feature live.

1. **Sign up at https://resend.com.** Free tier: 3,000 emails/month, 100/day — plenty to validate the feature and cover the first month or two of paid usage. No credit card required.
2. **Provision an API key** at https://resend.com/api-keys. Copy the `re_…` value.
3. **Add the env vars to the production app** (Heroku/Render/etc.):
   ```
   RESEND_API_KEY=re_...
   EMAIL_FROM="QuickInvoice <onboarding@resend.dev>"   # safe sandbox sender — works immediately
   ```
   The `EMAIL_FROM` fallback (`onboarding@resend.dev`) is Resend's universal sandbox sender and lets sends succeed before a domain is verified. Once the domain is verified (step 4) swap it for a branded address.
4. **Verify a sending domain** in the Resend dashboard (recommended: `mail.quickinvoice.io`). Steps:
   - Resend dashboard → Domains → Add Domain → enter the subdomain.
   - Add the three DNS records Resend prints (SPF / DKIM / DMARC) at your DNS provider.
   - Wait for verification (typically <30 min). Once green, update `EMAIL_FROM`:
     ```
     EMAIL_FROM="QuickInvoice <invoices@mail.quickinvoice.io>"
     ```
5. **Run the schema migration** once after deploy (idempotent — adds the `users.reply_to_email` column):
   ```
   psql $DATABASE_URL -f db/schema.sql
   ```
6. **Smoke test** end-to-end:
   - Register a free account → upgrade to Pro via Checkout (use Stripe test card `4242 4242 4242 4242`).
   - Create an invoice with `client_email` set to a personal inbox.
   - Click "Mark Sent" — verify the email arrives with the correct invoice number, total, line items, and a working "Pay invoice" button.
   - Check the reply-to header is the user's `business_email` (or `reply_to_email` if they set one in `/billing/settings`).
   - In `/billing/settings`, set a "Reply-to email" → save → re-send a test invoice → confirm the reply-to header reflects the new value.

**If a send fails:** check the Resend dashboard → Logs for the rejection reason. The two most common pitfalls are (a) sending from an unverified domain (use the sandbox sender until DNS propagates), and (b) a malformed `EMAIL_FROM` — Resend requires `"Display Name <local@host>"` exactly.

**Why this is the highest-leverage action on the list:** #13 unblocks #16 (automated payment reminders — the headline retention feature for Pro), #11 (churn win-back), #12 (monthly summary), #18 (referral invites), and #22 (late-fee notifications). Until the Resend key is set, all five of those features will deploy as no-ops. Setting the key flips them all on without any further code change.

---

## 8. Set logo uploads directory (added 2026-04-22)
Logo uploads are stored on the local filesystem. Set a persistent path (e.g., an attached volume on Heroku/Railway):
```
UPLOADS_DIR=/var/data/invoiceflow-uploads
```
If unset, defaults to `./uploads` relative to the working directory (not persistent across Heroku dyno restarts — use an attached volume or swap this for S3 in production).

---

## [LEGAL] Compliance & Required Legal Pages (added 2026-04-23 audit)

> Findings from reliability/legal audit on routine/autonomous @ 2026-04-23. None of these block the app from running, but shipping a paid SaaS to real users without them is a meaningful commercial + regulatory risk — card-acquirer ToS, Stripe's own Services Agreement, EU/UK GDPR, California CCPA/CPRA, and app-store-style directory listings all assume these pages exist.

### L1. [LEGAL] Publish Terms of Service — **hard requirement**
`views/auth/register.ejs` already tells every signup "By signing up you agree to our terms of service," but there is no `/terms` route or page anywhere in the codebase. This is a direct misrepresentation and unenforceable — a user who disputes a subscription charge can (correctly) argue there was no contract to agree to.
- **Action:** Commission / adapt a ToS for a US-incorporated SaaS that accepts Stripe payments. Minimum clauses: service description, acceptable-use, payment + refund terms, disclaimer of warranties, limitation of liability, governing law, termination.
- **Code follow-up (can be done by the autonomous team once you supply the markdown):** add a `GET /terms` route rendering `views/legal/terms.ejs`, and link it from register, the footer of every landing page, and the footer of `views/index.ejs`.

### L2. [LEGAL] Publish Privacy Policy — **hard requirement** (GDPR Art. 13 / CCPA §1798.100)
QuickInvoice collects email, name, invoice / client data, Stripe customer IDs, session cookies, and (once INTERNAL_TODO #13 / #17 land) Resend and Google OAuth identifiers. Under GDPR and CCPA/CPRA a privacy policy is legally required whenever a site collects personal data from an EU/UK or California resident — which any public signup form does.
- Minimum disclosures: categories of data collected, purposes, lawful basis (contract performance + legitimate interest), third-party sub-processors (**Stripe, SendGrid/Resend once live, Heroku or whichever host**), cookie disclosures (session cookie, Stripe fraud-detection cookies set by Checkout), data-subject rights (access, deletion, portability), contact email for requests, retention policy.
- **Action:** Publish at `/privacy` and link it from the register form, every landing page footer, and the Stripe Checkout branding settings.

### L3. [LEGAL] Publish Refund / Cancellation Policy — **Stripe + card-network requirement**
Stripe's acceptable-use and every card network require a clearly stated refund policy on the merchant's site. Absent one, chargebacks default in the cardholder's favour and merchant-processor ToS allow Stripe to pause payouts.
- Minimum disclosures: billing cycle, auto-renew behaviour, pro-rated vs. full-period refunds, cancellation mechanic ("cancel anytime via `/billing/settings` → Customer Portal"), who to contact for disputes.
- **Action:** Publish at `/refund-policy` (or roll into the ToS). Must be linked from the pricing page and visible inside the Stripe Checkout "Terms & Privacy" footer (Stripe Dashboard → Settings → Public details).

### L4. [LEGAL] GDPR data-subject rights plumbing — data export + deletion
No endpoint exists for a user to (a) download their data or (b) request account deletion. Under GDPR Art. 15 (access) + Art. 17 (erasure) and CCPA §1798.105, this must be available without undue delay.
- Minimum: a "Delete my account" button in `/billing/settings` that cancels the Stripe subscription, cascades to invoices (the `ON DELETE CASCADE` on `invoices.user_id` already handles this), and scrubs `users` to a tombstone row. Plus a "Download my data" action that dumps a JSON of the user's row + all invoices.
- **Action:** Owner decision whether to ship this before enabling EU traffic. For US-only launch, document the manual email-a-request procedure in the privacy policy as a stopgap.

### L5. [LEGAL] PCI-DSS SAQ-A scope confirmation (Stripe-hosted checkout)
Because all card data flows through Stripe-hosted Checkout + Payment Links and never touches this server, the merchant qualifies for PCI-DSS SAQ-A (simplest scope). This is **good news** but Stripe still requires the merchant to file an annual SAQ-A self-attestation.
- **Action:** Before the first real charge, log into Stripe Dashboard → Compliance → complete the SAQ-A wizard. 10-minute task. Keep the PDF on file. No code change required.
- **Code note:** never add a route that accepts raw card numbers, even transiently — it would immediately push us into SAQ-D scope (~300-question attestation, annual ASV scans).

### L6. [LEGAL] Cookie banner (EU/UK visitors only)
The app sets one first-party session cookie (strictly necessary — no consent needed) and Stripe Checkout sets its own fraud-detection cookies on the Stripe domain. A full cookie banner is **not** legally required today, but once INTERNAL_TODO #17 (Google OAuth) lands we'll also be setting Google-originating cookies, and Product Hunt / marketing pages may add an analytics pixel.
- **Action:** Note this as a prerequisite for adding any analytics / marketing tag (Plausible is cookie-less and avoids the requirement entirely — worth considering over GA4).

### L7. [LEGAL] Dependency-license audit — **CLEAN**
Reviewed all direct runtime dependencies: `express` (MIT), `express-session` (MIT), `express-validator` (MIT), `bcrypt` (MIT), `pg` (MIT), `stripe` (MIT), `ejs` (Apache-2.0), `dotenv` (BSD-2-Clause), `connect-pg-simple` (MIT). **No GPL, AGPL, or other copyleft licenses** in the production tree. Safe for closed-source commercial distribution. Re-run this audit whenever `package.json` gains a new dep (`npx license-checker --production --summary` is a 10-second check).

### L8. [LEGAL] Third-party API ToS compliance spot-check
- **Stripe:** compliant (Checkout + Payment Links are Stripe's recommended integration patterns).
- **SendGrid / Resend (pending INTERNAL_TODO #13):** transactional email to the user's own clients is within normal ToS. Do not repurpose into marketing blasts without the recipient's explicit opt-in.
- **Google Search Console / sitemap.xml:** compliant (no scraping, only exposing our own sitemap).
- **Future Google OAuth (INTERNAL_TODO #17):** Google OAuth brand guidelines require the standard "G" icon rendered per `https://developers.google.com/identity/branding-guidelines` — already noted in that task.
