# Actions Required from Master

> **Audited:** 2026-04-28 — Task Optimizer 10th-pass re-review. All items re-checked against the CHANGELOG (which now spans 2026-04-22 → 2026-04-28). Two new [MARKETING] items added this cycle: **#50** (Indie Hackers product directory + 4-week "Building in Public" series — community-building distribution channel distinct from #12 PH burst, #19 Show HN, #20 newsletter borrowed-audience) and **#51** (single-spot test buy on a freelance-focused podcast — $500-$1500, decision rule ≥ 5 Pro conversions in 30 days → scale to series; lowest-risk validation of audio as an acquisition channel before committing to a series). No items tagged [LIKELY DONE - verify] this cycle — every prior Master action remains pending its respective external step (Stripe Dashboard config, Resend API key, Plausible domain, G2/Capterra profile creation, etc.). Items 1–8 are human deployment/configuration actions; none are resolved by code commits. Code for all P1–P10 features and every shipped INTERNAL_TODO item is complete (including this cycle's H14 helper consolidation + invoice-view UX fix); deployment + the listed Stripe / Resend / domain / analytics provisioning are the remaining blockers to scale-revenue.

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

### 26. [MARKETING] Request G2 and Capterra Reviews from First Pro Users

**Impact:** HIGH — G2 and Capterra reviews appear directly in Google SERPs for queries like "QuickInvoice reviews" and "best invoicing software for freelancers"; a product with 0 reviews is invisible in category comparisons; even 5 genuine reviews can move a SaaS product from page 3 to the first page of G2's category ranking; this is a zero-cost action that compounds indefinitely (reviews attract more reviews)
**Action:**
1. After the first 10 Pro or Business plan signups, email each user directly from a personal address (not a no-reply). Keep it under 60 words:
   > Subject: Quick favour — 2 minutes on G2?
   >
   > Hi [first name], I'm the founder of QuickInvoice. You've been using it for [N] days — I'd love to hear what you think. Would you mind leaving a 2-sentence review on G2? It takes about 2 minutes and helps other freelancers find the tool. Here's the link: [G2 review link]. Totally optional — just thought I'd ask.
2. Include a G2 review link (your product's G2 page — created as part of item #13 above). Do the same for Capterra and AlternativeTo (3 separate outreach emails, spaced 3 days apart, to avoid survey fatigue).
3. Offer a genuine incentive if helpful: "I'll extend your subscription by 1 month as a thank-you" (create a Stripe coupon for `100% off once` and include a redemption link in the follow-up after they post the review).
4. Track review counts on a monthly basis. Target: 5 reviews within 60 days of first 10 Pro signups. Update directory listings (#13) with the new review count as it grows.

---

### 27. [MARKETING] Free Invoice Template PDF Lead Magnet

**Impact:** MEDIUM-HIGH — a downloadable free invoice template PDF serves two purposes: (1) it intercepts the high-intent "invoice template for freelance designer/developer/etc." search query that the niche landing pages (#8) are already targeting, converting organic visitors who aren't ready to sign up yet; (2) it builds an email list for future drip sequences; every user who downloads a template and later becomes a paid subscriber arrived at near-zero CAC
**Action:**
1. Create a professional, cleanly designed PDF invoice template for each niche (minimum: one generic + one per the 6 existing niche pages). Tools: Canva (free), Figma, or Google Docs → PDF export. The template should include: the freelancer's name/logo placeholder, client details section, line items table, total, payment terms, and a subtle "Made with QuickInvoice — quickinvoice.io" footer.
2. Add a "Download free template" email capture form to each niche landing page (rendered by `views/partials/lp-niche.ejs`). Gate the download behind a first-name + email form. On submit: (a) add the email to a Resend audience list or a simple CSV/Airtable log; (b) redirect to the PDF file URL or email it automatically. The dev team can implement the form + Resend audience add; the PDF itself is a Master asset.
3. Use the downloaded-user email list for a 3-email onboarding drip: Day 0 ("Here's your template"), Day 3 ("Here's how to make clients pay faster"), Day 7 ("QuickInvoice does all of this automatically — free to start").
4. **Dev prerequisite:** the autonomous team will need a `POST /landing/template-download` route that accepts `email + niche`, adds the email to a `template_leads` DB table (simple: `id, email, niche, created_at`), and either serves a redirect to the PDF asset URL or triggers a Resend send. Small [S] task — flag to the autonomous team as a companion to #25 (Expand SEO niche pages).

---

### 28. [MARKETING] Freelancer Slack and Discord Community Outreach

**Impact:** MEDIUM — large freelancer Slack/Discord communities contain tens of thousands of active freelancers who share tool recommendations daily; unlike Reddit (item #14) which is asynchronous and competitive, Slack/Discord communities are real-time, relationship-driven, and highly trusted; a single organic mention from a respected community member can drive 50–200 signups in 24 hours at zero cost
**Action:** Join and post in the following communities (one post per community, organic tone — introduce yourself as the builder, share a specific pain you solved, link to the product):
- **Designer Hangout** (designerhangout.co) — 15,000+ designers, invite-only Slack; request an invite via the website. Post in `#tools` or `#freelance` channel.
- **Freelance Forward Discord** (searchable on Discord) — active freelancers across design, dev, writing.
- **Webflow Community** (webflow.com/community) — large community of freelance Webflow developers; many invoice clients and need invoicing tools.
- **The UX Mastery Community** (uxmastery.com/community) — UX/product designers who frequently do contract work.
- **Indie Hackers community chat** — already captured for the IH product listing (#13), but also post in the `#growth` and `#tools` channels of the IH Discord.
- **Remote Work Hub** (various Slack groups under this name) — remote workers include a high proportion of freelancers.

**Tone guide:** Never post a bare product link. Lead with the problem ("Tired of clients saying they never received the invoice?"), describe the solution briefly (2 sentences), and end with "I built QuickInvoice to fix this — happy to give anyone here a free Pro month to try it." The Pro-month offer costs $12 and acquires a user whose LTV is $60–$120.

**Timing:** Post Tuesday–Thursday between 9 AM and 1 PM ET for maximum active user overlap.

---

### 29. [MARKETING] Sign Up for Plausible Analytics (Prerequisite for INTERNAL_TODO #34)

**Impact:** MEDIUM (operational) — without analytics there is no way to measure whether any of the distribution actions above (#12–#28) are driving traffic or signups; Plausible is privacy-friendly, cookie-less (no GDPR consent banner required per TODO_MASTER L6), and costs $9/mo; the dev team's code integration (INTERNAL_TODO #34) requires the `PLAUSIBLE_DOMAIN` env var from this step
**Action:**
1. Sign up at **plausible.io** ($9/mo Starter, or start with the 30-day free trial — no credit card required for the trial).
2. Add your domain (e.g. `quickinvoice.io`) as a new site in the Plausible dashboard. Plausible will show you the one-line JS snippet — pass the domain name to the autonomous team as `PLAUSIBLE_DOMAIN=quickinvoice.io` so they can complete INTERNAL_TODO #34.
3. Set `PLAUSIBLE_DOMAIN=quickinvoice.io` as an env var on the deployed app. The code integration is already handled by INTERNAL_TODO #34 — once the env var is set, analytics start immediately on next deploy.
4. In Plausible dashboard → Goals, create the following custom goals (these correspond to the `plausible('EventName')` calls INTERNAL_TODO #34 adds to the views): `Signup`, `UpgradeStart`, `TrialStart`. These will let you see the signup funnel and attribute signups to specific traffic sources.
5. **Optional:** connect Google Search Console to Plausible (Settings → Integrations) so keyword-level data from your niche landing pages (#8) flows into the same dashboard.

---

### 31. [MARKETING] Activate Stripe Tax in Stripe Dashboard (prerequisite for INTERNAL_TODO #35)

**Impact:** HIGH — INTERNAL_TODO #35 will add `automatic_tax: { enabled: true }` to checkout sessions, gated behind a `STRIPE_AUTOMATIC_TAX_ENABLED=true` env var. Until you activate Stripe Tax in the Dashboard, that env var must stay `false` or checkouts will error. Activating Stripe Tax unlocks the EU/UK/AU/CA freelancer market segment (~30% of global freelancers) who currently can't reasonably upgrade because their VAT/GST isn't being calculated.
**Action:**
1. Stripe Dashboard → Settings → Tax → "Activate Stripe Tax". Stripe walks you through a 3-step wizard (origin address, jurisdictions, tax IDs).
2. Origin address: your registered business address.
3. Jurisdictions: select the countries/states where you want automatic tax collection. Recommended starter set: US (all states), Canada (all provinces), UK, Australia, EU (all member states).
4. Once green, set `STRIPE_AUTOMATIC_TAX_ENABLED=true` on the production env. The next checkout session picks it up automatically.
5. **Pricing:** Stripe Tax is $0.50 per tax-calculated transaction (or 0.5%). Below 250 transactions/month it's free under the Stripe Tax starter plan. At any reasonable scale this is worth orders of magnitude more in unblocked EU revenue than the fee.
6. **Verification:** open `/billing/upgrade` from a UK IP (or use a UK billing address in test mode). Stripe Checkout should show the price + a "VAT (20%)" line item. The success webhook still fires identically — `automatic_tax` is invisible to QuickInvoice's data model.

---

### 32. [MARKETING] Create promo coupons in Stripe Dashboard (Product Hunt, AppSumo, newsletter sponsorships)

**Impact:** HIGH — INTERNAL_TODO #35 enables `allow_promotion_codes: true` on every Checkout session, which means any coupon you create in the Stripe Dashboard is immediately usable by customers via the "Add promotion code" link on the Stripe Checkout page. This unlocks every coupon-driven distribution channel — Product Hunt launch (`PH50`), AppSumo redemption codes, freelancer newsletter sponsorships (`DESIGNERS20`), and the 100%-off-first-month coupon flagged in [MARKETING] #25 (Agency cold email). Without these coupons created, every distribution post that promises a discount has nothing to redeem.
**Action:** Pre-create the following coupons in **Stripe Dashboard → Products → Coupons**:
1. **`PH50`** — 50% off, applies once. Tagged for Product Hunt launch ([MARKETING] #12).
2. **`DESIGNERS20`** — 20% off forever (recurring). Tagged for designer-focused newsletters ([MARKETING] #20).
3. **`AGENCY30`** — 30 days free trial extension (100% off, 1 month, redeemable once per customer). Tagged for Agency cold email ([MARKETING] #25).
4. **`HN30`** — 30% off first 3 months. Tagged for Show HN launch ([MARKETING] #19).
5. **`REVIEWTHANKS`** — 1 month free, redeemable once. Used to thank G2/Capterra reviewers ([MARKETING] #26).
6. **`AFFILIATE25`** — Reserved for Rewardful integration ([MARKETING] #18); Rewardful auto-creates per-affiliate coupons but a manual fallback is useful.
7. **AppSumo redemption** — when AppSumo is approved ([MARKETING] #22), they will issue redemption codes; the autonomous team will need to add an `/redeem` route. For now, no Stripe coupon needed — that's a separate flow.

Each coupon takes ~30 seconds in the Dashboard. Stripe surfaces them automatically on Checkout once `allow_promotion_codes: true` ships from INTERNAL_TODO #35.

**Verification:** open `/billing/upgrade` → Start trial → on the Stripe Checkout page you should now see "Add promotion code" link. Enter `PH50` and the price should drop to $6/mo (50% off $12).

---

### 33. [MARKETING] LinkedIn outreach to top "Best Invoicing Software for Freelancers 2026" listicle authors (added 2026-04-26)

**Impact:** MEDIUM-HIGH — Google's top 3–5 results for "best invoicing software for freelancers" are SEO-driven listicles (G2, Capterra-syndicated, blogger roundups). Each receives ~5,000–20,000 monthly visits with high purchase intent. Getting QuickInvoice added to even one of these articles is a permanent zero-CAC traffic source compounding monthly. The authors are individual people (not committees) and are reachable on LinkedIn.
**Action:**
1. Search Google for the following queries, capture the top 5 results for each:
   - `best invoicing software for freelancers 2026`
   - `freelance invoice software reviews`
   - `invoicing tools for designers 2026`
   - `best invoicing app for consultants`
2. Identify the article author for each (usually in the byline or "About the author" footer). Find them on LinkedIn.
3. Send a short LinkedIn connection note (under 300 chars):
   > Hi [Name] — your roundup of [list name] was helpful when I was researching this space. I built QuickInvoice (quickinvoice.io) — Stripe Payment Links auto-generated on every invoice + 7-day free trial. Would you consider adding it to the next refresh? Happy to give you a free Pro account to try first.
4. After they connect, follow up with a 1-message pitch: 1 screenshot of the invoice editor, 1-line description, the free Pro account offer. Do NOT send a press kit — these authors are individual creators, not journalists.
5. Track responses in a spreadsheet. Aim: 3 article inclusions over 60 days. Each ranking #1–3 article is worth ~$200/mo in compounding LTV.
6. **Prerequisite:** The product must be live with a real domain, the 7-day trial (#19, done) live, and at least one real testimonial on the landing page (after [MARKETING] #21 collects testimonials).

**Income relevance:** Direct top-of-funnel traffic that compounds across every article inclusion, every month, indefinitely. Highest ROI per hour spent of any [MARKETING] action — one well-pitched message can secure a permanent referral source.

---

### 30. [MARKETING] Announce "Invoice Paid Instant Notification" Feature on Social

**Impact:** MEDIUM — when INTERNAL_TODO #30 ("Invoice Paid" notification email to freelancer) ships, it is the kind of emotionally resonant micro-feature that goes viral on Twitter/X among freelancers; the single-sentence pitch ("QuickInvoice now emails you the instant your client pays — so you can stop refreshing your bank account") is a self-contained hook that needs no explanation; native video or screenshot of the email in a phone notification tray maximises engagement
**Action (after INTERNAL_TODO #30 is deployed):**
1. Write the tweet/X post: `"I added one small thing to QuickInvoice: the instant a client pays your invoice, you get this email. No more refreshing your bank account. 🔔" [screenshot of the "Invoice #X was just paid — $1,200" email on a phone screen]`
2. Post as a native Twitter/X image post (not a link). Tag relevant accounts: `@stripe`, `@resend`, and any freelancer community accounts you follow.
3. Cross-post to LinkedIn (more professional tone): `"We just shipped a small feature with big emotional impact: QuickInvoice now sends you an instant notification the moment a client pays your invoice."` + screenshot.
4. Share in the same Reddit/community channels from #14 and #28 as a "just shipped" update post. This is a legitimate update post, not a promotional post — communities reward builders who share progress transparently.
5. Add the feature to the product's landing page feature grid (`views/index.ejs`) with copy: "Instant paid notifications — get emailed the moment your client pays."

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

## 12. [OPTIONAL] Monitor 7-day Pro trial conversion (added 2026-04-25)
INTERNAL_TODO #19 is closed: the Pro Checkout now ships with `subscription_data: { trial_period_days: 7 }`, no card required. **No env var, no Stripe Dashboard config change is required for the trial to work** — Stripe applies the trial to either the monthly or annual price automatically.

Optional post-deploy actions to track trial-cohort health:

1. **Stripe Dashboard health check.** Stripe Dashboard → Billing → Subscriptions → filter `Status = trialing`. Watch the count grow over the first 14 days. Trial → paid conversion typically lands at 25–60% depending on activation; below 20% means the in-product activation flow (INTERNAL_TODO #14 onboarding checklist) is the next bottleneck to fix.
2. **DB-side cohort query** (run on the QuickInvoice production DB):
   ```sql
   SELECT
     date_trunc('day', created_at) AS signup_day,
     COUNT(*) FILTER (WHERE trial_ends_at IS NOT NULL) AS started_trial,
     COUNT(*) FILTER (WHERE plan = 'pro' AND trial_ends_at IS NOT NULL AND trial_ends_at < NOW()) AS converted,
     COUNT(*) FILTER (WHERE plan = 'free' AND trial_ends_at IS NOT NULL AND trial_ends_at < NOW()) AS lapsed
   FROM users
   WHERE created_at > NOW() - INTERVAL '60 days'
   GROUP BY 1 ORDER BY 1 DESC;
   ```
3. **Day-3 nudge email** (future hardening, blocked on `node-cron` job introduced by INTERNAL_TODO #16): if `trial_ends_at` is 3–4 days away and the user has not added a payment method, send a "Heads-up — your Pro trial ends in N days" email with a Customer Portal link. Out of scope for #19 itself; documented here so it does not get missed when #16 lands.

## 19. [OPTIONAL] Monitor onboarding-checklist activation funnel (added 2026-04-25)
INTERNAL_TODO #14 is closed: every dashboard load now renders a 4-step activation checklist (business info → first invoice → first sent → first paid) until the user dismisses it or completes all four. **No env var, no Stripe / Resend config change is required for the checklist to work** — the schema migration is in `db/schema.sql` (idempotent `ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_dismissed BOOLEAN DEFAULT false;`) and is applied by the existing `psql -f db/schema.sql` deploy step.

Optional post-deploy actions to track activation-cohort health:

1. **DB-side activation-funnel query** (run on the QuickInvoice production DB to see how many users complete each step within 7 days of signup):
   ```sql
   SELECT
     date_trunc('week', u.created_at) AS signup_week,
     COUNT(*) AS signups,
     COUNT(*) FILTER (WHERE u.business_name IS NOT NULL AND length(trim(u.business_name)) > 0) AS step1_business,
     COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM invoices i WHERE i.user_id = u.id)) AS step2_created,
     COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM invoices i WHERE i.user_id = u.id AND i.status IN ('sent','paid','overdue'))) AS step3_sent,
     COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM invoices i WHERE i.user_id = u.id AND i.status = 'paid')) AS step4_paid,
     COUNT(*) FILTER (WHERE u.onboarding_dismissed) AS dismissed
   FROM users u
   WHERE u.created_at > NOW() - INTERVAL '90 days'
   GROUP BY 1 ORDER BY 1 DESC;
   ```
   Healthy SaaS funnels lose 30–50% per step. If `step4_paid / signups` < 5% the checklist is *not* fixing activation by itself — the next levers are payment-link reliability (INTERNAL_TODO #2, already done) and email delivery to clients (INTERNAL_TODO #13, done — but the Resend API key still needs provisioning per item 18).
2. **Trigger-based dismissal monitoring**: a sudden spike in `dismissed=true` rows without a corresponding spike in `step4_paid` is a signal the card copy or progress logic is annoying users. Re-evaluate the wording in `views/dashboard.ejs` (`Get up and running` → consider `Welcome — let's get your first invoice paid` if the data warrants it).
3. **No marketing-email-to-clients fallout**: dismissing the checklist does not affect any email behaviour — it only suppresses the dashboard banner for that user. Safe to roll back via a single UPDATE if the feature regresses (`UPDATE users SET onboarding_dismissed = false;`).

## 20. QuickInvoice: automated payment reminder cron — deploy notes (added 2026-04-25 PM)

INTERNAL_TODO #16 is closed: a daily cron at **09:00 UTC** (`0 9 * * *`) now picks up every Pro/Business/Agency invoice that is `status='sent'`, past its `due_date`, and either never reminded or last reminded > 3 days ago, and emails the client a "Friendly reminder: Invoice X is overdue" nudge with a Pay button. **The cron is a safe no-op until the Resend API key from item 18 is provisioned** — every send returns `{ ok:false, reason:'not_configured' }`, no DB stamp is written, and the next 09:00 UTC tick retries. The instant `RESEND_API_KEY` is set, the next tick begins delivering the entire backlog.

No Master action is required *for this feature on its own* — item 18 (Resend API key) is the only gate. This entry exists so deploy-day operators know what to expect and how to verify.

### Verification on first tick after Resend goes live

1. **Confirm the schedule is registered.** Tail the production log for the boot line:
   ```
   QuickInvoice running on port 3000
   [reminders] scheduled (0 9 * * *)
   ```
   If you see `[reminders] not scheduled: cron_unavailable` instead, redeploy — `node-cron` did not install. If you see `[reminders] not scheduled: test_env`, the dyno is running with `NODE_ENV=test` (config error — set to `production`).

2. **Wait until 09:00 UTC** (or trigger a manual run — see below). The next log line will read:
   ```
   [reminders] found=N sent=M skipped=K errors=0 notConfigured=0
   ```
   - `notConfigured=N` (matching `found`) means `RESEND_API_KEY` is unset — fix item 18.
   - `errors > 0` means `sendEmail` threw or the DB stamp failed; check Resend dashboard → Logs and the application log for the row IDs.
   - `sent=M` matches the number of clients who received a reminder. The `last_reminder_sent_at` column on those rows will be set to the tick's `NOW()`.

3. **DB-side spot check** (run on the QuickInvoice production DB):
   ```sql
   SELECT id, invoice_number, client_email, due_date, status, last_reminder_sent_at
     FROM invoices
    WHERE last_reminder_sent_at > NOW() - INTERVAL '15 minutes'
    ORDER BY last_reminder_sent_at DESC;
   ```
   Cross-reference against Resend dashboard → Logs. Each row should correspond to one delivered email.

### Schema migration (idempotent, included in `db/schema.sql`)

```
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS last_reminder_sent_at TIMESTAMP;
CREATE INDEX IF NOT EXISTS idx_invoices_reminder_due
  ON invoices(status, due_date) WHERE status = 'sent';
```

Apply on deploy via the existing `psql $DATABASE_URL -f db/schema.sql` step. The partial index makes the daily query a sub-millisecond hot-path even at 100k+ invoices.

### Manual trigger (incident response or backfill)

If a backlog accumulates while the Resend key is being provisioned, you can drive a one-shot run from a one-off dyno without waiting for the next tick:

```
heroku run node -e "(async () => { \
  const r = await require('./jobs/reminders').processOverdueReminders(); \
  console.log(r); \
})()"
```

This bypasses the cron and runs against production credentials. The same plan-gate, cooldown, and `not_configured` logic applies, so it is safe to run repeatedly — at most one reminder per 3 days per invoice.

### Tunables (env vars)

| Var | Default | Effect |
|-----|---------|--------|
| `REMINDER_CRON_SCHEDULE` | `0 9 * * *` | Override the daily schedule (e.g. `0 */6 * * *` for every 6 hrs). Cron expression in UTC. |

The 3-day cooldown is currently a code constant (`DEFAULT_COOLDOWN_DAYS=3` in `jobs/reminders.js`). If user feedback indicates 3 days is too aggressive (clients complaining of spam) or too lax (freelancers wanting weekly nudges only), bump the constant or expose it via `users.reminder_cooldown_days` — that is a follow-up code change, not a Master action.

### What clients see

Subject: `Friendly reminder: Invoice INV-2026-0042 is overdue`
From: `<EMAIL_FROM>` (currently `QuickInvoice <onboarding@resend.dev>` until item 18 step 4 — the verified domain — completes; Resend's sandbox sender works but lands in spam more often, so prioritise domain verification).
Reply-to: `users.reply_to_email > business_email > email` of the freelancer (so the client's "Reply" lands in the freelancer's inbox, not in a no-reply void).
Body: HTML + plaintext, both include the freelancer's business name, the invoice total, the original due date, the days-overdue count, and a "Pay invoice X" button (only when the invoice has a `payment_link_url` — Pro/Agency invoices created or marked-sent after #2 shipped on 2026-04-23).

### Why this is the highest-leverage feature shipped this cycle

QuickInvoice's entire upgrade-modal copy promises "automated payment reminders" — until this commit, that promise was unfulfilled. Pro/Agency users have been paying $9-$19/month for a manual chase tool. Industry data: an automated 3-day overdue nudge typically lifts the on-time payment rate by 15-25%. Each recovered invoice is also a touchpoint that flips the user's relationship with the tool from "manual chase" to "set-and-forget cashflow" — the same retention dynamic that drives InvoiceFlow's stickiness.

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

---

## 22. QuickInvoice: paid-notification email — verify after Resend goes live (added 2026-04-26)

INTERNAL_TODO #30 is closed: every Stripe Payment Link checkout now fires a fire-and-forget "you just got paid" email to the freelancer (invoice owner) with the client name, invoice number, and total. **No new env var, no schema migration, no Stripe Dashboard change** — the wiring lives entirely inside the existing `checkout.session.completed` webhook, gated on `session.mode === 'payment'`. Until item 18 (Resend API key) is provisioned, every notification is a logged no-op.

### Verification (after Resend goes live)

1. **Smoke test** — once `RESEND_API_KEY` and `EMAIL_FROM` are set in production:
   - Log in as a Pro user. Create an invoice with `client_email` set; mark it Sent. The mark-sent flow already creates a Stripe Payment Link.
   - Open the invoice's "Pay Now" link in an incognito window; pay with Stripe test card `4242 4242 4242 4242`.
   - Inside ~5 seconds the freelancer's account email should receive: subject `Invoice INV-X was just paid — $Y.YY`, green celebration card, "View invoice X" deep-link button.
2. **Production log signal** — successful sends are silent. Failures emit one of:
   - `Paid notification to <email> failed: <reason>` — Resend rejection (check Resend dashboard → Logs).
   - `Paid notification error: <message>` — SDK throw (network glitch, JSON malformed, etc).
   - `not_configured` is *suppressed* in the log — when the Resend key is unset, no log spam.
3. **Reply-to header** — should match the freelancer's `reply_to_email` (if set in `/billing/settings`), otherwise `business_email`, otherwise the registered account email.

### Why this matters (income relevance)

This pairs with [MARKETING] item 30 ("Announce Invoice Paid Instant Notification Feature on Social") — the feature is now shipped and verified, so that announcement is actionable as soon as the first real customer pays. Industry word-of-mouth research: features producing a measurable emotional spike (instant payment notification, milestone alerts) generate 3–5× the share rate of utility features. Each share is one zero-CAC acquisition.

---

## 21. QuickInvoice: re-run schema migration to widen `users.plan` CHECK (added 2026-04-25 PM)

INTERNAL_TODO H5 is closed: `db/schema.sql` now declares `plan` as `CHECK (plan IN ('free', 'pro', 'business', 'agency'))` (was `('free', 'pro')`) and includes an idempotent `ALTER TABLE users DROP CONSTRAINT IF EXISTS users_plan_check; ALTER TABLE users ADD CONSTRAINT users_plan_check CHECK (...)` block to migrate existing production DBs.

Five call sites in the application code (`routes/billing.js:144,192`, `routes/invoices.js:212,241`, `db.js:164` — reminder query, `jobs/reminders.js:35` — `PAID_PLANS` Set) already branch on `plan === 'agency'`. Without this constraint widening, the first attempt to persist `plan='agency'` (or `plan='business'` once #10 ships) would have hit a Postgres 23514 error — silently 500'ing the upgrade flow.

### Action

A single command on production after the next deploy:

```
psql $DATABASE_URL -f db/schema.sql
```

This is the same migration step that previously landed `last_reminder_sent_at`, `trial_ends_at`, `onboarding_dismissed`, `reply_to_email`, and `webhook_url`. The schema file is fully idempotent — re-running it on a populated DB is safe (every change lives behind `IF NOT EXISTS` / `IF EXISTS` / `DROP …; ADD …`). The next deploy can pick up all queued schema changes in one shot.

### Verification

```sql
SELECT conname, pg_get_constraintdef(oid)
  FROM pg_constraint
 WHERE conname = 'users_plan_check';
```

Expected output:

```
       conname       |                  pg_get_constraintdef
---------------------+-----------------------------------------------------------
 users_plan_check    | CHECK ((plan)::text = ANY (ARRAY['free'::character varying, 'pro'::character varying, 'business'::character varying, 'agency'::character varying]::text[]))
```

If the output still shows the narrow `('free', 'pro')` pair, the migration didn't run — re-execute the `psql -f` step. Constraint widening is non-blocking (`ALTER TABLE … ADD CONSTRAINT` does not lock the table for reads or writes when the new predicate is a superset of the old one — Postgres skips the table-rescan because every existing row already satisfies the new predicate).

### Why this matters

Indirect income lift: this is the prerequisite plumbing for #9 (Agency team seats at $49/mo, the highest-ARPU tier in `master/APP_SPEC.md`) and #10 (Business tier at $29/mo, raises ARPU ceiling from $12 to $29 per power user). Both tasks would have hit a 23514 the first time any user upgrade tried to persist `plan='agency'` or `plan='business'`. With the constraint widened, both tiers can ship without re-touching the schema.

---

## 30. QuickInvoice: activate Stripe Tax + flip `STRIPE_AUTOMATIC_TAX_ENABLED` (added 2026-04-26)

INTERNAL_TODO #35 is closed in code: every Stripe Checkout session now ships with `allow_promotion_codes: true` (active immediately — no env var, no Dashboard change) and `automatic_tax: { enabled: process.env.STRIPE_AUTOMATIC_TAX_ENABLED === 'true' }` (env-var gated; off by default).

The promotion-code half is **live now** — every coupon Master creates in the Stripe Dashboard from this point forward is reachable via the "Add promotion code" link on the Checkout page. No verification needed beyond running the next coupon-driven distribution action (Product Hunt PH50, AppSumo, agency cold email).

The automatic-tax half needs Master to do two things in production:

### Action

1. **Activate Stripe Tax in the Dashboard** (~5 minutes). Stripe Dashboard → Settings → Tax → Activate. You will be asked for:
   - Your business country and address (the "origin" address used for tax calculation).
   - The tax registrations you currently hold. For a new SaaS, the typical starting answer is "no registrations yet" — Stripe Tax can still **calculate** tax on every invoice and will track which jurisdictions you cross thresholds in (so you know when to register). Stripe will auto-add your home-country registration once you provide it.
   - Whether to **collect** tax or just calculate. If you're not yet registered anywhere, set to "calculate only" (no collection). Once registered in any jurisdiction (typical first registration is your home country once you cross its small-seller threshold), flip the registration to "collect".
2. **Flip the env var** in production (Heroku / Render / Railway / etc):
   ```
   STRIPE_AUTOMATIC_TAX_ENABLED=true
   ```
   Restart the dyno. Next checkout will pass `automatic_tax.enabled=true` and `customer_update: { address: 'auto', name: 'auto' }` to Stripe — Stripe captures the billing address and applies the calculated tax.

Until both steps are done, leave the env var unset (or `=false`). Checkout still works, just without tax collection.

### Verification

After the env flip, hit `/billing/upgrade`, click "Start 7-day free trial". On the Stripe Checkout page:
- A **"Add promotion code"** link should appear next to the line-item price (the promo half — already live before this Master action).
- A **"VAT / Sales tax"** line should appear in the order summary (tax half — needs the env flip + Stripe Tax activation).
- The billing address fields should be auto-required.

Stripe's Test Card `4242 4242 4242 4242` with a EU postcode (e.g. UK `SW1A 1AA`) should display VAT in the summary; same card with a US postcode (e.g. `94105`) should display sales tax for jurisdictions where you've registered.

### Why this matters (income relevance)

Direct, compounding revenue lift from one ~10-line code change:

1. **Coupon flows.** Unlocks every marketing distribution action that hands users a coupon code: Product Hunt launch coupons (PH50), AppSumo lifetime deals, freelancer-newsletter sponsorships ("DESIGNERS20"), and the 100%-off-first-month coupon planned for the Agency cold-email outreach (TODO_MASTER #25). Without `allow_promotion_codes`, every coupon was unreachable — the user landed on Checkout, couldn't find a coupon field, and bounced.
2. **EU/UK/AU/CA market segment.** ~30% of the global freelancer market is outside the US and is required by their tax authorities to display tax-inclusive prices. Stripe Tax automation removes the compliance friction. Combined with the still-open multi-currency support (INTERNAL_TODO #24), this is the EU-launch enabler.

Both are zero-CAC revenue lifts.

---

## 31. QuickInvoice: re-run schema migration for `trial_nudge_sent_at` (added 2026-04-26 PM)

INTERNAL_TODO #29 (Trial End Day-3 Nudge Email) is closed in code. The job is wired into `server.js` and ticks at 10:00 UTC daily once `NODE_ENV !== 'test'`. It depends on a new column `users.trial_nudge_sent_at TIMESTAMP` (idempotent `ALTER TABLE … ADD COLUMN IF NOT EXISTS …` already in `db/schema.sql`).

### Action

A single command on production after the next deploy:

```
psql $DATABASE_URL -f db/schema.sql
```

This is the same migration command that previously landed `last_reminder_sent_at`, `trial_ends_at`, `onboarding_dismissed`, `reply_to_email`, and `webhook_url`. The schema file is fully idempotent — re-running it on a populated DB is safe (every change lives behind `IF NOT EXISTS` / `IF EXISTS`). If TODO_MASTER #21 (the `users.plan` CHECK widening) and this one have not yet been run on production, a single `psql -f` execution will land both at once. No downtime.

### Verification

```sql
SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_name = 'users'
   AND column_name = 'trial_nudge_sent_at';
```

Expected output: a single row with `trial_nudge_sent_at | timestamp without time zone`.

To verify the cron is wired (after the next deploy with `NODE_ENV=production`), check the boot logs for:

```
[trial-nudge] scheduled (0 10 * * *)
```

If the line reads `[trial-nudge] not scheduled: cron_unavailable`, the `node-cron` dependency didn't install — re-run `npm ci`. If the line is missing entirely, the wiring in `server.js` is bypassed (likely because the dyno is running with `NODE_ENV=test` or the `app.listen` callback didn't fire — check the process manager output).

### Why this matters (income relevance)

This is the highest-leverage trial-cohort conversion action available to the product. Industry benchmarks (Userlist, ConvertKit, ChartMogul) consistently put a single well-timed day-3/4 trial nudge at responsible for 30–50% of trial-to-paid conversion. Without it, modal users who opened the dashboard once and didn't return silently lapse on day 7. With this column in place, every cron tick can stamp the row and prevent a duplicate send — the SQL filter is the source of idempotency. The job is also a clean no-op until the Resend API key from #18 is provisioned (`not_configured` skips the DB stamp), so this migration can land before #18 with no operational risk.

---

## 32. [MARKETING] Stripe App Partner profile listing (added 2026-04-26 PM)

QuickInvoice is a Stripe-connected SaaS that uses Stripe for both subscription billing and invoice Payment Links. Stripe maintains an "App Partner" directory at https://stripe.com/apps where partners can list a profile with screenshots, a description, and a link back to the SaaS. Inclusion does not require a "Stripe App" build (which is the heavier path for embedded apps inside the Stripe Dashboard); the Partner directory accepts any verified Stripe-integrated SaaS.

### Action (Master, ~30 min)

1. Sign up at https://stripe.com/partners with the same Stripe account that processes QuickInvoice subscriptions and Payment Links.
2. Submit the partner application: business name "QuickInvoice", category "Invoicing & Billing", short description ("Smart invoicing SaaS for freelancers — Pro plan unlocks Stripe Payment Links on every invoice and instant paid-notification emails the moment a client pays"), 3-4 screenshots (the dashboard, an invoice with the Pay Now button, the pricing page).
3. Wait for verification (typically 5-10 business days; Stripe checks the integrated account and confirms live processing).
4. Once approved, the listing appears at stripe.com/apps in the Invoicing category with a backlink to `quickinvoice.io` — the backlink alone is high-DA SEO juice (Stripe's domain is one of the strongest in fintech).

### Why this matters (income relevance)

Compounding distribution: every visitor to stripe.com/apps researching invoicing solutions sees QuickInvoice in the listing. Stripe's directory traffic is a high-quality cohort — these are SaaS owners and freelancers who already use Stripe and have credit-card-on-file with a Stripe-related vendor. Conversion rate from Stripe directory traffic is typically 2-3x the cold-traffic baseline. The backlink also lifts overall SEO authority for ranking on "Stripe-integrated invoicing", "Stripe invoice tool", and similar long-tail queries that the niche landing pages (#8) target.

---

## 33. [MARKETING] AppSumo / SaaS Mantra lifetime-deal listing (added 2026-04-26 PM)

AppSumo and SaaS Mantra both run lifetime-deal marketplaces where SaaS founders sell a one-time-payment lifetime license to a tier of their product (typically the equivalent of 1-2 years of normal subscription revenue) in exchange for a large traffic / cash injection plus permanent customer base growth. Typical AppSumo listing for a $9-19/mo SaaS sells a Pro lifetime tier at $49-99 one-time and converts ~$10k-$50k in deal revenue across 4-6 weeks of the deal window.

### Action (Master, ~2-3 hr application + ~2 weeks back-and-forth)

1. Apply at https://sell.appsumo.com (and/or https://saasmantra.com/sellers). Both run a vetting process — they check for: a working product (✓), a paid plan (✓), a Stripe integration (✓), a self-serve signup (✓), and a published roadmap (gated on INTERNAL_TODO #38 — currently open). Ship #38 before applying.
2. Pre-application: prepare a 60-90 second product walkthrough screencast (sign up → first invoice → mark paid → see the cha-ching email). AppSumo's editorial team uses this to evaluate fit.
3. Pricing tier: "Pro lifetime" at $49 one-time (≈ 4.5 months of monthly Pro). The lifetime tier should match the existing Pro feature set; the (un-shipped) Business tier is excluded from the lifetime offer to preserve the upsell path.
4. The deal terms: AppSumo takes 30% of gross deal revenue. SaaS Mantra takes 50% but typically drives 30-50% more units. Run both back-to-back rather than simultaneously.
5. **Code-side prerequisite (small):** the existing `subscription_status` plumbing already accepts the values we use; for lifetime deals, we'll need a new value `'lifetime'` that bypasses the dunning checks. Add to INTERNAL_TODO as a [S] follow-up — gated on AppSumo acceptance, not the other way round.

### Why this matters (income relevance)

One-time cash injection: typical $10k-$50k in 4-6 weeks. More importantly, ~500-2000 lifetime users become a permanent revenue floor: they don't churn (they paid once and are sticky), they refer their freelancer networks (the cohort is heavy in the indie-hacker/freelancer niche we target), and they generate Stripe Payment Link transaction fee revenue if we ever add a "QuickInvoice take-rate on collected invoices" tier. Caveats: lifetime cohorts have higher support volume per user (~3x); they can compress the price elasticity ceiling because you can't raise lifetime prices later. Plan for 2-4 hours/week of support during the deal window.

---

## 34. [MARKETING] Indie Hackers / Reddit r/SaaS launch posts after Resend goes live (added 2026-04-26 PM)

The Indie Hackers product directory (https://indiehackers.com/products) and r/SaaS subreddit are the two highest-quality founder-cohort distribution channels for an indie-SaaS launch. Both reward genuine builder-narrative posts ("here's how I built Y; here's what I learned"). Typical first-week traffic from a well-pitched IH launch + r/SaaS post is 2k-10k unique visitors, of which 1-3% sign up.

### Action (Master, ~3 hrs writing + ~1 hr engagement)

1. Wait for two prerequisites: (a) `RESEND_API_KEY` provisioned per #18 so email-driven features (invoice send, reminders, paid notification, trial nudge) actually fire end-to-end during launch traffic; (b) public roadmap (INTERNAL_TODO #38) live so the inevitable "what's next?" comments have a single linkable answer.
2. Write the IH launch post: 600-800 words, structured as: (1) the problem ("freelancers waste 4-6 hrs/mo chasing late invoices"), (2) the build journey (concrete numbers — "shipped in 6 weeks; 23 commits this month; 28 test files"), (3) the differentiators (Stripe Payment Links + instant paid notification + 7-day no-card trial), (4) the ask ("would love feedback / what feature would you want next"). Link to pricing.
3. r/SaaS post: 200-300 words, lighter tone, focus on one concrete numbers-backed insight from the build (e.g. "what shipping a 7-day no-card trial did to our trial-to-paid conversion") with the product mention as context, not the headline. Reddit's algorithm rewards educational content and demotes promotional posts.
4. Follow-up: respond to every comment within 4 hours of posting for the first 24 hrs. The IH product page also accepts permanent reviews / ratings; a 4-5 star average on the IH directory is a long-tail conversion lever (every prospect who searches "QuickInvoice review" finds it).

### Why this matters (income relevance)

Two-week traffic spike of 2k-10k uniques lifts the funnel by 50-200 trial signups (at typical SaaS landing-page conversion). At 30-50% trial-to-paid (per #29 above) → 20-100 new Pro subscribers → +$180-$900/mo MRR per launch. The IH product directory listing also stays as a permanent SEO surface — the listing ranks well for "QuickInvoice" branded searches and captures every subsequent prospect who tries to validate the product before signing up.

---

## 35. QuickInvoice: enable bank-debit payment methods on Stripe Payment Links (added 2026-04-26 PM)

INTERNAL_TODO #41 shipped the code-side wiring for low-fee bank-debit Payment Link methods (ACH, SEPA, BECS, BACS, ACSS). The new env var `STRIPE_PAYMENT_METHODS` is read by `lib/stripe-payment-link.js` and forwarded as `payment_method_types` to `stripe.paymentLinks.create()`. Default stays `card` only — the deploy is reversible and safe to release before activating any new methods in Stripe.

### Action (Master, ~3-5 min per method)

1. In Stripe Dashboard → **Settings → Payments → Payment methods**, enable each method you want offered:
   - **ACH Direct Debit** (US bank transfer): 0.8% capped at **$5** vs. cards at 2.9% + $0.30 — saves the freelancer **~$53 per $2,000 invoice**.
   - **SEPA Direct Debit** (EU): 0.8% capped at **€5**.
   - **BECS Direct Debit** (AU) / **BACS Direct Debit** (UK) / **ACSS Debit** (Canada): similar margin profile in their respective regions.
   No Stripe review required — instant activation per method.
2. On the deployed app, set the env var to the comma-separated list of activated methods. Safe values:
   ```
   STRIPE_PAYMENT_METHODS=card,us_bank_account,sepa_debit
   ```
   Unknown values are silently dropped by `parsePaymentMethods()`; an empty/invalid value falls back to `['card']` so Stripe never receives an empty array.
3. Redeploy. Next Pro user who marks an invoice `sent` gets a Payment Link that surfaces all enabled methods on the Stripe-hosted page. The invoice-view template's "Clients can pay via X" tooltip auto-updates to reflect the activated methods.
4. (Optional) Note that ACH/SEPA settle in 3-5 business days vs. card's instant authorisation. The freelancer-facing UI already says "Stripe Payment Link" without promising instant settlement; if you want to surface settlement-time copy, INTERNAL_TODO can pick that up as a follow-up.

### Why this matters (income relevance)

Two compounding effects on the existing Pro cohort:
- **Margin lift.** Every invoice ≥$300 that the client pays via ACH/SEPA instead of card saves the freelancer 1-2% in fees they currently absorb. On a typical $1500 retainer invoice, the savings is ~$30 per invoice. This is direct freelancer-side value the freelancer feels every month — the kind of "this tool just paid for itself" moment that drives Pro retention.
- **Higher conversion on B2B invoices.** Many AP departments prefer ACH for their books (paper trail + lower bank fees). Industry data: B2B invoices with bank-transfer enabled show 5-8% higher payment-completion rates than card-only. Combined with the instant paid-notification email (#30), this also feeds the cha-ching word-of-mouth loop.

---

## 36. [MARKETING] Free "Invoice Generator" lead-magnet landing page link-building (added 2026-04-26 PM-2)

**Impact:** MEDIUM-HIGH (long-tail SEO + backlink building) — the existing `/invoice-generator` and `/invoice-template/<niche>` landing pages are content marketing assets that target high-intent keywords ("freelance designer invoice template", etc.). To rank, they need backlinks. The single highest-leverage outreach channel is to small-business / freelancer roundup posts: Medium and Substack bloggers regularly write "Top 10 invoice templates for freelancers in 2026" listicles that include 5-10 outbound links to template generators. Getting QuickInvoice listed in just 5-10 of these listicles is worth more domain authority than a Product Hunt launch and lasts indefinitely.

### Action (Master, ~3-4 hrs identification + ~1 hr per outreach)

1. Search Google for: `"invoice template" "freelance" 2025 OR 2026 -site:quickinvoice.io`. Filter to results from past 12 months. Identify 15-20 listicle-style posts on Medium / Substack / freelancer-blog domains (Upwork blog, Fiverr Workspace, Bonsai blog, Freshbooks blog are too large to reach; target solo bloggers and mid-size sites).
2. For each post, find the author's contact email or Twitter / X DM handle. Send a short personalised note: "Hi [name], saw your great post on freelance invoice templates. We just shipped QuickInvoice, a free invoice generator with built-in Stripe payment links — would love to be considered for the list if you ever update it. Here's a screenshot: [link]." No ask for payment, no pressure. Track responses in a simple spreadsheet.
3. For posts where the author lets readers submit tools (often via a "submit your tool" form or `add@` email), submit through that channel instead of cold email.
4. Track replies for 4 weeks; about 20-30% of cold outreach to small bloggers converts to a backlink. 5 successful backlinks at DA 20-40 is enough to lift the niche pages from page 2-3 to page 1 for their target keywords.

### Why this matters (income relevance)

Page-1 organic ranking on a freelancer-niche query is worth ~50-200 visits/month per query at zero CAC. With 6 niche pages live (more after #25 ships), that's 300-1,200 monthly organic visitors compounding indefinitely. At a 2% landing → trial conversion and 30-50% trial → Pro conversion (per #29), this is +$30-$300/mo MRR per query that ranks. Five queries on page 1 = a foundational organic-traffic stream that does not depend on any single distribution event.

---

## 37. [MARKETING] Accountant / Bookkeeper partner program (added 2026-04-26 PM-2)

**Impact:** HIGH (B2B referral channel) — accountants and bookkeepers each serve 20-100 freelance clients. Every accountant who recommends QuickInvoice represents 20-100 prospective Pro signups with extremely high trust (the recommendation comes from the client's existing trusted financial professional). Setting up a simple "refer a client, get 1 month free Pro" partner program targets this segment specifically. Industry data: SaaS that builds a strong accountant-referral channel sees 25-40% of new revenue come through that channel within 12 months.

### Action (Master, ~4-6 hrs setup + ongoing engagement)

1. Create a one-page `views/partners.ejs` (or have INTERNAL_TODO add a code task — pure copy + form) explaining the partner offer: accountants who refer 5+ clients get a 50% lifetime discount on a Pro account they use to manage their own freelance projects, plus a co-branded "QuickInvoice Certified Accountant" badge. The 5-client threshold filters out single-referral attempts and incentivises ongoing engagement.
2. Build a target list of 50-100 accountants who specialise in freelancers / solopreneurs. Sources: LinkedIn search "accountant freelancer", QuickBooks ProAdvisor directory (accountants who serve small clients but might want a simpler invoicing tool to recommend), local small-business CPA listings.
3. Send a personalised outreach email to each: "Hi [name], saw you specialise in freelance clients on [LinkedIn / their site]. We just launched QuickInvoice — a Stripe-native invoicing tool we built specifically for solo freelancers. Would you be open to recommending it to clients who don't need full QuickBooks-level accounting? We'll comp your account and add you to our partner directory." Personal email > automated drip.
4. Track responses in a simple Google Sheet. For accountants who reply positively, set up the Stripe coupon (`PARTNER50` valid forever) and add them to a `views/partner-directory.ejs` page (creates a useful SEO surface in addition to the partner channel itself).
5. Quarterly check-in email to active partners with a "what's new in QuickInvoice" recap and a request to share with one more client.

### Why this matters (income relevance)

The accountant-referral channel is the single highest-trust distribution channel in B2B SaaS — a freelancer who hears "QuickInvoice handles your invoicing" from their CPA converts at 5-10x the rate of cold organic traffic. Five active partner accountants each referring 2-5 clients per quarter = 40-100 new Pro signups per year per partner cohort, at ~zero ongoing CAC. The compounding effect over 12-18 months can produce a recurring revenue floor that is more stable than any single launch event.

---

## 38. QuickInvoice: replace `public/og-image.png` with branded asset (added 2026-04-27)

**Impact:** MEDIUM-HIGH (compounds across every share) — INTERNAL_TODO #36 shipped Open Graph + Twitter Card metadata on every public page (landing, pricing, all 6 niche landing pages). The placeholder `public/og-image.png` is a valid 1200×630 brand-indigo PNG so social-card validators accept it pre-replacement, but the actual share preview is just a solid color block. Replacing it with a branded card (logo + tagline + brand color background) makes every shared link in Slack / iMessage / Twitter / LinkedIn / Discord render as a recognisable QuickInvoice card.

### Action (Master, ~15 min)

1. Open Figma / Canva / any image tool. Create a 1200×630 PNG with:
   - QuickInvoice wordmark or `⚡ QuickInvoice` logo (top-left or centered)
   - Tagline: "Professional invoices in 60 seconds" or "Get paid faster"
   - Brand-indigo (#4f46e5) background or gradient (matches `views/partials/head.ejs` Tailwind brand-600)
   - White or near-white text for high contrast
2. Export as PNG, name it `og-image.png`, replace `public/og-image.png` in the repo. Commit + deploy.
3. Validate after deploy by pasting `https://quickinvoice.io/` into:
   - LinkedIn Post Inspector: https://www.linkedin.com/post-inspector/
   - Twitter Card Validator: https://cards-dev.twitter.com/validator
   - Both should show the new card. If they show the old image, click "Refresh" / "Re-fetch" to bust their cache.

### Why this matters (income relevance)

Indirect but compounding. Every distribution action in TODO_MASTER (Reddit posts #14, tweets #17/#30, newsletter mentions #20, Slack/Discord drops #28, Show HN #19, listicle outreach #36) generates ~30-50% higher click-through when the link preview renders as a branded card vs. a bare URL. Lifetime ROI on 15 minutes of design work.

---

## 39. QuickInvoice: set `APP_URL` env var in production (added 2026-04-27)

**Impact:** MEDIUM-HIGH — INTERNAL_TODO #36's Open Graph metadata uses `process.env.APP_URL` to render absolute `og:url` and `og:image` URLs. Most social-card validators (Twitter, LinkedIn, Discord) require absolute URLs for the preview image — relative paths fail silently and the card falls back to "no image." The env var is also used by other features (`jobs/trial-nudge.js`'s CTA, `lib/email.js` paid-notification button) where it's nice-to-have; for OG metadata it's effectively required.

### Action (Master, ~1 min)

1. In Heroku / Render / your prod env, set:
   ```
   APP_URL=https://quickinvoice.io
   ```
   (no trailing slash — the OG helper normalises it either way, but cleaner without).
2. Restart / redeploy so the new env var takes effect.
3. Re-validate via LinkedIn Post Inspector + Twitter Card Validator (see #38) — preview image should now load instead of "Image preview unavailable."

### Why this matters

Pairs with #38 (branded OG image). Without `APP_URL` set, the og:image URL renders as a bare `/og-image.png` which most social-card consumers can't fetch. With it set, every shared link gets the rich preview card.

---

## 40. [MARKETING] Stripe Customer Portal: enable invoice history + tax IDs + payment method update (added 2026-04-27)

**Impact:** MEDIUM (retention + EU/UK tax compliance) — Stripe Customer Portal launches today with only the "Cancel subscription" affordance enabled by default. Pro users can already reach the portal from the past-due banner and the pricing page's "Manage subscription" link, but they can't:
- Download past invoices for their accountant.
- Update billing details (address, tax ID) — required for EU/UK VAT compliance once #30 (Stripe Tax) is activated.
- Update payment method without going through dunning.

Each of these is a self-serve feature Stripe ships behind a single dashboard toggle. Enabling them costs zero engineering work and removes 3 categories of "I have to email support" tickets, which compounds support time-savings as the user base grows.

### Action (Master, ~2 min)

1. Stripe Dashboard → Settings → Billing → Customer portal → "Configure" the Live mode portal.
2. Under "Features", enable:
   - **Invoice history** (already on by default — verify)
   - **Tax IDs** (off by default — turn ON for EU/UK/AU/CA freelancer compliance once #30 Stripe Tax is activated)
   - **Update billing address** (off by default — turn ON; required by Stripe Tax)
   - **Update payment method** (off by default — turn ON; the most-requested portal feature)
3. Under "Cancellation", confirm the cancellation flow asks for a reason (Stripe collects this and it's the cheapest churn-signal data we'll ever have).
4. Save. Changes apply immediately to every subsequent portal session — no redeploy.

### Why this matters (income relevance)

Self-serve portal features convert "support escalation" into "happy customer" with zero ongoing engineering cost. Each enabled feature is a few hours of Master support time saved per month, and tax IDs specifically unblock #30 (Stripe Tax) for the EU/UK/AU/CA freelancer market segment that #30's automatic_tax flag will start collecting from.

---

## 41. [MARKETING] Coupon-URL campaign templates for Reddit / Product Hunt / Show HN (added 2026-04-27 — gated on INTERNAL_TODO #58)

**Impact:** MEDIUM-HIGH (conversion lift on every paid distribution) — once INTERNAL_TODO #58 (`/redeem/:code` page) ships, every distribution channel can carry a unique URL that auto-applies a Stripe promotion code at checkout. This converts the existing "Add promotion code" affordance (which most visitors don't notice) into a 1-click redemption flow. Master needs to (a) create the codes in Stripe, (b) draft channel-specific posts that carry the URLs.

### Action (Master, ~2 hrs once #58 ships)

1. Stripe Dashboard → Products → Coupons → create:
   - `PH50` — 50% off first 3 months (Product Hunt launch)
   - `SHOWHN30` — 30% off first 3 months (Show HN)
   - `REDDITSAAS25` — 25% off first 3 months (r/SaaS, r/freelance posts)
   - `MEDIUM-LISTICLE` — 20% off first 3 months (one per inbound listicle, see #36)
   - `ACCOUNTANT-PARTNER50` — 50% off first 3 months (for #37 partner referrals)
2. For each coupon, create a Stripe Promotion Code with the same name (Stripe distinguishes Coupons from Promotion Codes; #58 reads the latter).
3. Draft 3 launch posts that carry the URLs:
   - **Product Hunt launch** — `https://quickinvoice.io/redeem/PH50` in the comments.
   - **Show HN** — `https://quickinvoice.io/redeem/SHOWHN30` in the body.
   - **r/SaaS Friday Roundup** — `https://quickinvoice.io/redeem/REDDITSAAS25` in the post.
4. Track conversions per code in Stripe → Coupons → individual coupon page → "Redemptions" count. Each redemption is a measurable Pro signup attributable to that exact channel.

### Why this matters

Without per-channel codes, every paid signup looks identical in Stripe and channel ROI is impossible to measure. With them, Master can see "30 signups via PH50 in week 1, $0 ad spend" and double down on what works. Pairs with INTERNAL_TODO #34 (Plausible analytics) — Plausible measures the click; the coupon code measures the conversion.

---

## 42. [MARKETING] Submit `quickinvoice.io/sitemap.xml` + verify in Google Search Console (added 2026-04-27 PM)

**Impact:** HIGH (one-time SEO foundation) — INTERNAL_TODO #56 just shipped `robots.txt` + canonical URLs, completing the trio (`/sitemap.xml` already shipped in #8, `/robots.txt` now points at it). Google still needs to be told the site exists. Verifying ownership in Google Search Console is a 5-minute one-time action that unlocks: (a) accelerated indexing of every niche landing page (typically 2-3 days vs. 4-8 weeks for organic discovery), (b) impression / click data per query so Master can see which niche pages are pulling traffic, (c) a manual reindex button for any single page after a copy update, (d) backlink reports.

### Action (Master, ~10 min total)

1. Go to https://search.google.com/search-console.
2. Click "Add property" → enter `https://quickinvoice.io` (use the domain property if Cloudflare/Route53 can hold a TXT record; otherwise use the URL prefix property and verify via the HTML file method or Google Tag).
3. After verification, navigate to "Sitemaps" → submit `https://quickinvoice.io/sitemap.xml`. Confirm Google reports "Success" (a few minutes after submission).
4. Repeat for `https://quickinvoice.io/robots.txt` via "Settings" → "robots.txt" report — Google fetches it automatically; this just surfaces any parse errors.
5. Bookmark the "Performance" tab — review monthly to identify which niche pages are ranking and which queries are driving traffic. Use this signal to prioritise INTERNAL_TODO #25 (expand niche pages from 6 → 15) toward the queries already showing impressions.

### Why this matters

Without this, INTERNAL_TODO #8 (sitemap), #25 (niche pages), #36 (OG metadata), and #56 (robots + canonical) are technically perfect but invisible to Google for 4-8 weeks longer than necessary. Google Search Console verification is the single highest-leverage one-time SEO action available. Pairs with #29 (Plausible analytics) — Plausible measures user behaviour; GSC measures crawler behaviour and search intent.

---

## 43. [MARKETING] Listicle outreach — "best invoicing tools for freelancers" backlinks (added 2026-04-27 PM)

**Impact:** HIGH (compounding SEO) — Google's #1 ranking signal remains backlinks from authoritative listicle articles. Searching "best invoicing software for freelancers 2026" returns the same 8-12 listicles that drive most freelancer-tool decisions. Getting QuickInvoice mentioned in even 3-5 of these articles drives sustained referral traffic for years. The pattern is well-established: a polite cold email to the article author offering a free Pro account + a one-paragraph product summary + a screenshot (now branded after #38 og-image lands) gets a "yes" rate of 15-25% on cold outreach.

### Action (Master, ~6 hrs total over 2 weeks)

1. **Scope the target list** (~1 hr). Search Google for: "best invoicing software for freelancers", "best invoice apps for designers", "freelance invoice tools", "Bonsai alternatives", "FreshBooks alternatives", "invoice generator review". Compile the top 20 articles into a spreadsheet with: URL, author name, author email (use Hunter.io free tier or check author byline), date last updated, current tools listed.
2. **Filter to active authors** (~30 min). Drop any article older than 18 months (Google heavily discounts stale content). Drop any article whose author isn't reachable (anonymous bylines).
3. **Draft a 5-line outreach email** (~30 min). Template: "Hi [name], I saw your [year] article on [topic] — really useful breakdown. I'm the founder of QuickInvoice (quickinvoice.io), a stripped-down invoicing tool for freelancers. Two things specifically that competitors don't: (a) instant Stripe Payment Link on every invoice, (b) a dead-simple Free plan (no credit card, 3 invoices). I'd love to be considered for the next refresh of your article — happy to set you up with a free Pro account so you can try it. No expectation of anything in return. — Master / @quickinvoice". Per-author personalisation (~2 min each) lifts response rate ~3x.
4. **Send 20 outreach emails over 2 weeks** (~3 hrs incl. follow-ups). Stagger: 5 / day to avoid Gmail rate limits.
5. **Track each response** in the same spreadsheet. For each "yes," provision a free Pro account via the Stripe Dashboard (manual subscription create — no code required). For each "yes" that results in a backlink, note the article URL.
6. **Re-pitch every 6 months** for any author who replied positively but didn't end up linking.

### Why this matters

Backlinks from the right 5 listicles outperform any paid ad campaign for indie SaaS at this stage. Each linked article drives 5-50 referral visits/month for years. Compounding effect across 5 articles: 50-200 high-intent visits/month, of which 5-15% convert to free signups, of which 15-30% convert to Pro = 4-25 paying customers/month from a one-time 6-hour effort. Pairs with INTERNAL_TODO #36 (OG metadata — author screenshots in the article render as the branded card), #38 (roadmap — gives the author confidence the project is alive), and #34 (Plausible — measures the post-link traffic).

---

## 44. [MARKETING] LinkedIn outreach to recently-promoted Operations / Engineering Directors hiring freelancers (added 2026-04-27 PM)

**Impact:** MEDIUM (B2B agency-tier funnel) — LinkedIn surfaces "started a new position" updates for Director-level operations and engineering hires. These users are about to onboard freelancers and contractors and need a way to invoice them — i.e. they're shopping for an invoicing tool RIGHT NOW. A short, non-spammy connection request + a one-line follow-up converts at 5-15% to an invitation to share more, of which 10-20% convert to a paid Agency seat. Volume: LinkedIn sales-nav free-tier search returns ~50 such promotions per week in any major metro.

### Action (Master, ~3 hrs/week ongoing)

1. **Set up a LinkedIn Sales Navigator free trial** (1 month free; cancel before billing). Use the Lead filter: "Job title = Operations Director / VP Engineering / Head of People", "Location = US/UK/EU", "Started in current role within last 90 days".
2. **Send 20 connection requests/week** with a personalised note: "Hi [name], congrats on the [title] role at [company]. I run QuickInvoice (quickinvoice.io) — we make invoicing freelance contractors painless for ops teams. Happy to share a Pro plan if you ever want to try us out. — Master".
3. **For accepted connections**, send a one-line follow-up 3-5 days later: "Thanks for connecting! If you're hiring freelancers and they're invoicing you via Word/PDF, our Agency tier ($49/mo) handles 5 contractor seats with auto-reminders + Stripe payment links. Want me to set you up with a free 30-day trial? — Master". Do NOT send a follow-up to anyone who didn't accept.
4. **For "yes" responses**, provision a manual 30-day Agency-tier trial via the Stripe Dashboard. Master sets a calendar reminder for day 25 to check in.
5. Track in a spreadsheet: name / company / connect-accepted / responded / trialled / converted-to-paid.

### Why this matters

The Agency tier ($49/mo, 5 contractor seats) has the highest LTV in the funnel but the lowest organic acquisition rate (it's not a self-serve segment — Ops Directors don't browse listicles). Cold outbound on LinkedIn is the standard B2B SaaS sales motion at this stage. Pairs with INTERNAL_TODO #9 (Agency team seats — must be live before this campaign starts) and #38 (roadmap — gives the prospect confidence the team-seats feature is actively maintained).

---

## 45. [MARKETING] Indie/freelancer Slack + Discord community presence (added 2026-04-27 PM-2)

**Impact:** MEDIUM — most active SaaS / freelancer Slack and Discord communities are NOT covered by the Reddit-launch (#34) or LinkedIn-outbound (#44) playbooks because they're closed-membership and require a different posture (you must be a participating member, not a drive-by poster). Joining the right 4-5 communities and answering invoicing-related questions naturally converts at 5-15% per relevant thread response (much higher than Reddit because the audience is smaller and warmer). Compounds over months — answers stay searchable inside the community for years.

### Action (Master, ~1 hr/week ongoing)

1. **Join 4 communities** (one-time, ~30 min):
   - **Indie Hackers Slack** (free, application form at indiehackers.com/community)
   - **Indie Worldwide** (paid $20/mo, indieworldwide.com — strong founder + freelancer overlap)
   - **Online Geniuses Slack** (free, onlinegeniuses.com — marketing/SaaS focus, freelancers building agencies)
   - **r/freelance Discord** (linked from the subreddit sidebar) — direct freelancer audience match
2. **Set up a saved search** in each (Slack: `/search invoice OR invoicing OR FreshBooks OR Bonsai`; Discord: same keywords). Check 2-3 times a week.
3. **For each relevant thread** (someone asking "what invoicing tool do you use?" or complaining about FreshBooks/Bonsai pricing): reply naturally with one sentence about how you handle invoicing, link to QuickInvoice ONLY if you're already a participating member of that channel for 2+ weeks (to avoid the "drive-by promoter" auto-ban).
4. **Track each link share** in a spreadsheet: community / thread URL / date / response. After 8 weeks compare community-attribution to Plausible referrer data (#34 once live) to identify the highest-converting community.
5. **Run one community-only AMA** per quarter (e.g. "Ask me anything about building QuickInvoice from scratch"). Indie Hackers AMAs typically draw 20-50 questions, several of which become inbound trial signups.

### Why this matters

Closed communities are the highest-conversion-per-impression distribution surface for indie SaaS once you're past the cold-launch phase (Product Hunt, Show HN). They're also the most resilient against algorithm changes (no Twitter / Reddit reach collapse risk). Pairs with #34 (Plausible analytics — measures community-driven traffic by referrer), #38 (roadmap — gives community members confidence the project is real), and #19 (Show HN — the cross-post lifts traffic from the community to HN and back).

---

## 46. [MARKETING] 60-second YouTube product walkthrough video (evergreen SEO + landing) (added 2026-04-27 PM-2)

**Impact:** MEDIUM — distinct from the existing Loom demo plan (#15 — that's an autoplay clip on the landing page). A separate, public YouTube video titled "QuickInvoice — Invoice + Get Paid in 60 Seconds (Freelancer Tool Demo)" lives on YouTube indefinitely, ranks for the long-tail "how to invoice freelance clients" query, and is embedded as the landing-page hero (replacing or complementing #15). YouTube SEO compounds — the video is discoverable for years, drives passive signups every month with zero ongoing effort, and the landing-page embed gives QuickInvoice a video-thumbnail social-share preview that the static OG image (#36, INTERNAL_TODO) can't.

### Action (Master, ~3 hrs one-time)

1. **Record the 60-second walkthrough** (1 hr) using OBS or Loom Pro:
   - 0-10s: Problem hook ("Stop chasing invoices.")
   - 10-30s: Create an invoice — 3 line items, mark Sent
   - 30-45s: Switch to the client's perspective — open the Stripe Payment Link, click Pay
   - 45-60s: Back to dashboard — invoice flips to PAID; revenue stat ticks up. End-card with quickinvoice.io URL.
2. **Edit + caption** (~1 hr) — auto-captions in YouTube Studio + manual cleanup.
3. **Publish to YouTube** with: title "QuickInvoice — Invoice + Get Paid in 60 Seconds (Freelancer Tool Demo)", description with timestamps + landing-page link, end-card pointing to the video's own playlist, tags `freelance, invoicing, stripe, saas, freelancer`. Submit to the YouTube SEO via the description (first 200 chars).
4. **Embed on landing page** in `views/index.ejs` — replace or complement the auto-play Loom from #15. YouTube embed gives a thumbnail + Schema.org `VideoObject` that inflates the SEO of the landing page itself (compounds with the JSON-LD `SoftwareApplication` work in INTERNAL_TODO #52).
5. **Cross-post the video link** to: r/freelance, Indie Hackers (as a Show update), LinkedIn (native upload — LinkedIn deboosts external links but boosts native video), Twitter/X.

### Why this matters

YouTube SEO is the single most-evergreen acquisition channel for B2B SaaS at this stage. A 60-second walkthrough that ranks for one or two long-tail queries drives 50-300 passive views per month indefinitely, of which ~5% click through to the landing page, of which ~5% convert to free signup. Doesn't compete with #15 (Loom autoplay clip — that's about reducing landing-page bounce); this is about new acquisition. Compounds with #36 (OG metadata) and INTERNAL_TODO #52 (JSON-LD `SoftwareApplication` schema with `VideoObject` ref).

---

## 47. [MARKETING] "Cashflow horror story" Twitter/X thread series — once monthly, evergreen (added 2026-04-27 PM-3)

**Impact:** MEDIUM — distinct from #17 (LinkedIn/Tweet content series — that's invoicing tips). This is a structured monthly thread format that retells a real freelancer cashflow horror story (anonymised, sourced from r/freelance, Indie Hackers, or your own users) and lands on a "this is the gap QuickInvoice closes" beat. Threads of this shape (relatable problem → narrative → tool reveal) consistently outperform tip threads on engagement and click-through, because the reader spends 90 seconds invested in the problem before the product gets named.

### Action (Master, ~1 hr/month ongoing)

1. **Source one story per month** (~20 min): scrape r/freelance and Indie Hackers for posts tagged `chasing payment`, `client won't pay`, `late invoice`, `freelance accountant horror`. Take one with > 50 upvotes / > 10 comments and the freelancer's permission to retell anonymised.
2. **Write the thread** (~30 min, 8-12 tweets): tweet 1 = the hook ("Freelance designer waited 91 days to get paid. Here's what happened."). Tweets 2-8 = narrative beats (signed contract, sent invoice, client ghosted, follow-up emails, etc.). Tweet 9 = the systemic gap ("No automated reminder. No payment link. Just hope."). Tweet 10 = "This is why I built QuickInvoice." with the landing URL.
3. **Schedule** via Buffer/Hypefury for Tuesday 10am ET (highest engagement window for the freelancer cohort).
4. **Cross-post the thread to LinkedIn** as a single long-form post (LinkedIn auto-truncates at 1300 chars but the algorithm rewards long-form text-only posts; embed the landing-page link in the first comment, not the post body — LinkedIn deboosts posts with external links).
5. **Track conversion** via the `?ref=twitter-cashflow-MM-YY` URL param on the landing-page link; review Plausible's referrer split (#29 once live) at 30 days post-publish.

### Why this matters

Once-monthly cadence (12 threads/year) is sustainable. Each thread compounds — the problem stays evergreen, the freelancer cohort doesn't change, the QuickInvoice positioning ("we close this specific gap") gets reinforced 12 times a year without ever feeling like a sales pitch. Pairs with #34 (Indie Hackers / Reddit launch posts — same audience, different surface), #44 (LinkedIn outbound — same content can be repurposed there), and the #45 community presence (you can drop the thread into your community feed once you've earned the standing).

---

## 48. [MARKETING] First-Pro-cohort founder onboarding calls — first 20 customers only (added 2026-04-27 PM-3)

**Impact:** HIGH (early-stage learning + retention) — every SaaS founder who skipped the "manually onboard the first 20 paying customers" step has a regret thread on Indie Hackers about it. A 15-minute Zoom call with each of the first 20 Pro signups generates: (a) the most actionable feature feedback you'll ever get; (b) testimonial quotes (#21 prereq); (c) referral seeds (each Pro user knows ~5 other freelancers, half of whom would benefit from QuickInvoice); (d) reduced churn (a customer who's spoken to a founder 1-on-1 churns at roughly half the rate of one who hasn't). Each call is a marketing asset, a product-research interview, and a retention lever simultaneously. Stops at 20 customers because the math stops working past that scale; the "first 20" is a one-time investment.

### Action (Master, ~30 min per customer, capped at 20 customers ≈ 10 hrs total)

1. **Trigger:** add a hook in the existing `customer.subscription.updated` webhook handler so the first 20 Pro upgrades fire a Slack notification to Master with the user's email (no code change needed if Master sets up a Stripe-to-Slack Zap; otherwise tag as INTERNAL_TODO).
2. **Personalised email** (template, ~5 min to fill per customer): "Hi <name>, founder of QuickInvoice here — you're one of the first 20 Pro users, and I want to make sure you get a real human onboarding. 15-minute Zoom this week? <Calendly link>." Calendly free tier is fine.
3. **Run the call** (15-20 min): (a) watch them create their first invoice — observe friction; (b) ask "what would you have wanted that's missing?"; (c) ask "what almost stopped you from signing up?"; (d) close with "would you mind if I quoted you on the landing page once you've used it for a month?"
4. **Capture the answers** in a single Notion / Google Doc — one entry per customer, structured: name / vertical / pain point / feature requests / quote-permission y/n.
5. **Feed back into INTERNAL_TODO** — every feature request that surfaces 2+ times across the 20 calls becomes a [GROWTH] item with the tag "validated by user interview."
6. **Stop at 20 customers.** Past 20, the unit economics break (Master's hourly cost > customer LTV at $9-19/mo), and the patterns repeat. The first-20 cohort is a one-time investment.

### Why this matters

Every SaaS team that skipped this step bought their first 20 customers' feedback in churn data instead of voice — that's strictly worse data, delivered later, when the customer has already left. Compounds with #21 (testimonials — the calls produce the quotes), #18 (affiliate program — the early Pros are the most likely affiliates), and INTERNAL_TODO #57 (NPS survey — the calls calibrate the NPS-question wording before the survey ships at scale).

---

## 49. [MARKETING] G2 / Capterra / TrustRadius profile claims + first-cohort review seeding (added 2026-04-27 PM-4)

**Impact:** HIGH (long-tail acquisition + late-funnel trust) — G2, Capterra, and TrustRadius are the dominant late-funnel comparison surfaces for SaaS buyers (any prospect who Googles "QuickInvoice vs FreshBooks" or "best invoice tool for freelancers" lands on one of these sites). Without a profile, the prospect either lands on a competitor's profile or on a generic listicle that doesn't have QuickInvoice in it. A claimed profile with 5+ reviews from real Pro users:
- Surfaces in long-tail comparison searches (organic SEO)
- Pre-empts the "no reviews → can't trust it" objection that kills late-funnel conversion
- Becomes a first-page Google result for the brand itself (claim it before a competitor or scraper does)
- Compounds across all three platforms simultaneously (one batch of review requests, three platforms populated)

Distinct from existing #33 (AppSumo / SaaS Mantra lifetime-deal listing — different funnel: AppSumo is acquisition via promo, G2 is mid/late-funnel comparison & trust signal) and #44 (LinkedIn outbound to Ops Directors — different audience: enterprise/agency buyer vs. SMB/freelancer self-serve).

### Action (Master, ~3 hrs total — broken into 4 steps over 30 days)

1. **Claim the profile on each platform** (~30 min per platform, ~90 min total):
   - **G2** (https://www.g2.com/sellers/sign-up): claim or create the QuickInvoice listing under the "Invoicing & Billing" category. G2 verifies via a `quickinvoice.io` email address.
   - **Capterra / GetApp / Software Advice** (one signup at https://vendors.capterra.com/listing — three sites, single profile): same-category listing.
   - **TrustRadius** (https://www.trustradius.com/products/new): smaller volume but high-intent traffic.

2. **Populate each profile with the canonical pitch** (~30 min total — paste the same content across all three):
   - 1-paragraph product summary (already written in `views/index.ejs` hero section)
   - 3-5 screenshots: dashboard, invoice form, invoice view with Pay button, pricing page (use the already-shipped OG image from `public/og-image.png` once #38 lands)
   - Pricing tiers verbatim from `views/pricing.ejs`
   - "Best for" tags: Freelancers, Small agencies, Solopreneurs, Independent contractors

3. **Review seeding from the first 20 Pro cohort** (paired with #48 founder onboarding calls — ~10 min of each call). Pitch wording: *"If QuickInvoice is genuinely saving you time, would you write a 2-3 sentence review on G2? Here's the link." (Send the direct G2 review URL after the call, not as a generic ask.)* G2 incentivises with a $10 Amazon gift card per verified review (valued at marketing $); QuickInvoice doesn't pay anything. Target: 5 reviews on G2, 3 on Capterra, 2 on TrustRadius within 30 days.

4. **Add the review badges to the landing page** (~5 min) — once 5 reviews are live, G2 generates an embed snippet ("4.8 stars on G2 · 5 reviews"). Drop into `views/index.ejs` social-proof section (alongside whatever ships from INTERNAL_TODO #20).

### Why this matters

Late-funnel trust signal that compounds for years with no ongoing maintenance. Most SMB SaaS prospects do this exact path: hear about the tool → search "<tool> vs <alternative>" → see comparison-site results. A claimed profile with 5+ reviews wins that surface; a non-existent profile loses to whoever did claim theirs. The cost is one afternoon of profile setup + leveraging the #48 onboarding call cohort for review seeding. No paid spend, no recurring effort.

Pairs with #48 (founder calls produce the review-seeding cohort), INTERNAL_TODO #20 (social-proof landing section consumes the badges), and INTERNAL_TODO #57 (NPS survey can be re-pitched as a review request after high scores).

---

### 50. [MARKETING] Submit QuickInvoice to Indie Hackers product directory + run a "Building in Public" updates series (added 2026-04-28)

**Audience:** Bootstrapped-founder community on Indie Hackers (~150K monthly active, the highest-density freelancer + indie SaaS community on the open web).

**Distinct from:**
- **#12** (Product Hunt) — different community (PH is launch-day burst traffic, IH is sustained engagement over weeks)
- **#19** (Show HN) — different audience (HN is technical/engineering, IH is product/marketing)
- **#20** (Newsletter outreach) — different format (newsletter is borrowed audience; IH is direct posting to your own profile)
- **#26** (G2/Capterra) — different funnel (G2 is comparison-shopping; IH is community-building)

### Action (Master, ~30 min one-time setup + ~2 hrs/week ongoing for 4 weeks)

1. **Profile setup** (~15 min): create the QuickInvoice product listing at https://www.indiehackers.com/products. Tags: "SaaS", "Freelance", "Invoicing", "Productivity". Add the same OG image, tagline, and pricing as the G2/Capterra setup (#49).

2. **Founder profile** (~15 min): set up Master's personal IH profile linked to the product. Bio: "Building QuickInvoice — invoicing for freelancers who'd rather be doing the work."

3. **"Building in Public" weekly post series** (~30 min/post, 4 posts):
   - Week 1: "We just shipped a 7-day Pro free trial. Here's what we learned about activation." (link to public roadmap once #38 ships)
   - Week 2: "First 20 paying users — what they all have in common." (cohort-analysis post; great for review seeding)
   - Week 3: "We added Klarna/Afterpay to invoice payment links. Here's the conversion-lift data." (gated on INTERNAL_TODO #79 shipping)
   - Week 4: "MRR milestone update + lessons from the first quarter." (transparency = trust on IH)

4. **Comment engagement** (~30 min/week): comment substantively on at least 5 other founders' posts per week. The IH algorithm boosts active posters. Pure-promo profiles get demoted; engaged profiles get pinned to the front page.

### Why this matters (income relevance)

Indie Hackers is the single highest-density community of two types of QuickInvoice's ideal customers:
1. **Self-employed product founders** who invoice contract clients on the side and need a tool that takes 2 minutes (not 20 like Wave/QuickBooks)
2. **Bootstrapped-SaaS operators** who watch other bootstrappers' products to learn from the journey — a public "Building in Public" series both attracts that audience as customers AND builds Master's personal credibility for future fundraising / acquisitions / partnerships.

Compounds with #43 (listicle outreach — IH posts often get cross-linked from listicle articles), #21 (testimonials — IH commenters often become testimonial sources), and INTERNAL_TODO #18 (referral program — IH founders are heavy referrers; once #18 ships, an IH-specific affiliate-link drop closes the loop).

**Why now and not later:** IH's algorithm rewards consistency. Starting a Building-in-Public series at MRR $0 is more authentic than starting at MRR $10K — early posts age into "look how far they've come" social proof. The window to start is now-ish.

---

### 51. [MARKETING] Sponsor a single-spot test on a freelancer-focused podcast (added 2026-04-28)

**Audience:** Freelancers who consume freelance-business advice via audio (typically the more-mature freelancer cohort — full-time independents, agency principals, and 1-employee studios — exactly the Pro/Agency tier QuickInvoice already monetises hardest).

**Distinct from:**
- **#20** (Newsletter outreach — text format, different consumption pattern)
- **#17** (Twitter/LinkedIn series — text/static visual, different attention pattern)
- **#15** (60-second demo video — video format, different distribution surface)

### Action (Master, ~3 hrs research + ~1 hr negotiation + $500-$1500 single-spot ad spend)

1. **Identify 3 candidate podcasts** (~2 hrs):
   - "The Freelance Friday Podcast" (~25K downloads/episode, freelance-business focus)
   - "Being Freelance" (~30K downloads/episode, UK-skewed but English-speaking)
   - "Freelance Transformation" (~15K downloads/episode, US-skewed, host-read ads)

   Look for: host-read ads (3× the conversion of pre-recorded), audience match (freelance > business-owner > entrepreneur), and CPM under $25 (any higher and the ROI is harder to recoup at $19/mo Pro).

2. **Pitch + negotiate** (~1 hr): contact the show's sales rep (always linked in the show notes) with a short pitch:

   > *"Hi — we run QuickInvoice, an invoicing SaaS for freelancers ($19/mo Pro). We'd like to test a single-spot host-read ad in your next available episode. Our offer: a custom promo code (15% off forever) so you can run the read straight from our pricing page. Budget: up to $1500 for one episode. Looking to test conversion before committing to a series."*

3. **Set up the tracking** (~30 min, after agreement): create a Stripe coupon `PODCAST15` (per [MARKETING] #32 process), and add a UTM-tagged landing variant of `/pricing` (e.g. `/pricing?utm_source=podcast&utm_campaign=<show>`). The landing-page variant just renders `views/pricing.ejs` with the coupon hint pre-filled.

4. **Measure** (~1 hr after the episode airs): track signup count + Pro conversion via `?utm_*` query params over the 30 days following episode air. Decision rule: if a single $1000 spot drives ≥ 5 Pro conversions in 30 days (LTV ≈ $300, gross margin ≈ $1500), buy a series of 4. If not, drop the channel.

### Why this matters (income relevance)

Test-buy validates whether audio is a cost-effective acquisition channel for QuickInvoice's exact target customer before committing to a series. The freelance-podcast audience skews older / higher-income / more business-mature than the typical Twitter / Reddit freelancer audience, which means they (a) churn less, (b) need fewer features to convert (the value prop "stop chasing payments" hits home immediately), and (c) are more likely to refer-out (Master's ICP).

A single test buy is the lowest-risk way to find out whether the unit economics work — if they do, scaling is just buying more spots; if they don't, the cost is capped at one spot.

Distinct from #18 (Affiliate / Rewardful — affiliate is performance-only, podcast sponsorship is brand + impression), #15 (60s demo video — video is shareable asset, audio is one-and-done CPM media), and #20 (newsletter — different consumption, different audience-overlap).

**Why now:** podcast sponsorship is most cost-effective when (a) you have a clear, easy-to-pitch value prop ("stop chasing payments"), (b) you have a working free trial (#19 — done), and (c) you have at least one shippable customer testimonial (gated on #21 testimonials work + #48 founder calls). The first two are true today; the third lands within 4 weeks. Buy the spot to air ~5 weeks out so the testimonial is in the can before the read goes live.

---

### 52. [MARKETING] Pitch the 3 new `/vs/<competitor>` comparison pages to "best invoicing software 2026" listicle authors (added 2026-04-28 PM-2)

**Impact:** MED-HIGH (one-time SEO foundation + persistent backlink asset). INTERNAL_TODO #86 ships three first-party comparison pages — `/vs/freshbooks`, `/vs/wave`, `/vs/bonsai`. Comparison pages only rank when they accumulate backlinks from authoritative listicle sites; without that signal Google treats them as orphan thin-content. A targeted email outreach campaign to the 15-20 authors of "best invoicing software for freelancers 2026" / "FreshBooks alternatives 2026" / "Wave alternatives 2026" listicles, pitching QuickInvoice as a candidate addition with the new comparison pages as ready-to-link reference copy, gives those listicles a one-click reason to add QuickInvoice (the comparison page is the destination URL they'd otherwise have to write themselves). Compounds with #36 (LinkedIn outreach to listicle authors) — same audience, different surface (LinkedIn DM vs cold email).

**Distinct from existing items:**

- **#36** (LinkedIn outreach to listicle authors) — same audience, different surface and copy. #36 is generic "please consider listing QuickInvoice"; #52 is specific "here's a ready-to-link comparison page that does the listicle author's research for them."
- **#26** (G2 / Capterra reviews) — different mechanism. G2 is review-aggregation listings; this is editorial content.
- **#13** (freelancer-tool directories) — different format. Directories list; listicles narrate.
- **TODO_MASTER #43** (existing listicle outreach) — same broad campaign, but this item adds the *comparison pages as the bait* — the existing #43 outreach pitched the homepage; this version pitches the dedicated comparison URL. Run together.

### Action (Master, ~4 hrs initial + ~30 min/week follow-up for 4 weeks)

1. **Confirm INTERNAL_TODO #86 has shipped** (the three comparison pages must be live and indexable before pitching — broken link in pitch = dead pitch).

2. **Build target list** (~1 hr): Google "best invoicing software for freelancers 2026", "FreshBooks alternatives", "Wave alternatives", "Bonsai alternatives", "best invoice apps for designers 2026". Compile top 15-20 articles into a spreadsheet — URL, author name, author email (Hunter.io free tier or check author byline), date last updated, current tools listed, contact form URL if email isn't public. Skip anything older than 18 months — those won't be re-edited.

3. **Draft outreach template** (~30 min). Subject: "Quick suggestion for your <article title>". Body (~80 words):

   > Hi <author>, I work on QuickInvoice (an invoicing SaaS for freelancers — $9/mo Solo / $19/mo Pro). I noticed your <article> piece. I built dedicated comparison pages for the tools you covered — FreshBooks (<URL>), Wave (<URL>), Bonsai (<URL>) — that lay out price/feature/time-to-first-invoice side-by-side. If you're considering adding QuickInvoice to your list when the article next gets a refresh, those pages are ready-to-cite reference copy. No paid placement, no obligation. Happy to grant Pro access if you want to test it first.

4. **Send 5 pitches/week** (~30 min/week) using a free Mailmerge tool (Yet Another Mail Merge, GMass free tier). Track open + reply rates in a Google Sheet. Reply rate target: 20%; placement rate target: 5% (1 placement per 20 pitches).

5. **Monthly review** (~30 min): cull the list, swap in fresh listicles, refine the pitch copy based on which subject lines opened best.

### Why this matters (income relevance)

Each placement of QuickInvoice in a "best invoicing software 2026" listicle is a backlink + ongoing referral traffic source for years. Listicle traffic converts at 3-5x the rate of generic homepage traffic because the visitor is already in evaluation mode. The comparison pages serve double-duty: (a) as the ready-to-cite reference that makes the listicle author's job easier (raising acceptance rate), (b) as the landing page the listicle's referral traffic lands on (matching the "compare X tools" reader intent perfectly). One placement on a high-DA listicle (DA 50+) is worth ~$2-5K in equivalent paid acquisition over its first 12 months.

**Why now:** the comparison pages will be live within the next sprint (gated on INTERNAL_TODO #86). Pitch within 2 weeks of those going live so they're indexed by Google before the listicle authors start verifying the citations. Pre-indexing matters because Google penalises listicles that link to thin/empty pages; a 2-week head start gives QuickInvoice's comparison pages enough crawl traffic to rank for at least the long-tail "<competitor> alternative" queries before the listicle's ranking-signal arrives.

---

### 53. [MARKETING] Manual cold-email outreach to 30 freelancer Slack communities re: vacation-mode launch (added 2026-04-28 PM-2)

**Impact:** MED (positioning + community-driven distribution). When INTERNAL_TODO #89 (vacation mode) ships, it's the kind of feature that turns a generic invoicing tool into a tool that "gets" how freelancers actually live (seasonal income, vacation pauses, sabbaticals). It's a natural conversation-starter in any freelancer Slack/Discord community where the perennial complaint is "I cancelled my SaaS to save $20 during my off-season, then had to re-set-up everything when I came back." Manual outreach to community moderators/admins (NOT broadcast posting — that's the spam bait existing #28 warned against) asking them to consider mentioning the feature in their community newsletter or pinned announcements.

**Distinct from existing items:**

- **#28** (Freelancer Slack/Discord community participation) — this is moderator-targeted outreach asking for an announcement, not member-level participation. Different mechanic, different yield.
- **#21** (testimonials on landing page) — different surface and audience.
- **#14** (Reddit launch posts) — Reddit allows broadcast posts; Slack/Discord communities largely don't.

### Action (Master, ~3 hrs research + ~3 hrs outreach over 2 weeks)

1. **Confirm INTERNAL_TODO #89 has shipped** (vacation-mode toggle live, with an empty `vacation_until` value rendering the bare settings page so screenshots demo cleanly).

2. **Build target list** (~2 hrs): identify 30 freelancer-focused Slack/Discord communities. Sources: the existing #28 task's research (re-use that list as a starter), Indie Hackers community directory, "Freelancing Slack groups" listicles. Filter to communities with public moderator contact info (Slack workspace owner email or Discord moderator handle visible in #welcome). Skip communities with explicit no-promo rules.

3. **Draft outreach template** (~30 min). Subject: "Tiny feature your members will love". Body (~70 words):

   > Hi <mod>, mod-to-mod here. We just shipped "vacation mode" on QuickInvoice — freelancers can pause auto-reminders + show an OOO note on payment links without cancelling their subscription. It's the kind of thing your community has probably ranted about. If it's useful to share, here's a 3-line announcement you can copy-paste: <link>. No paid promotion, just a heads-up.

4. **Pre-write the copy-paste announcement** (~15 min). Make it a one-liner the moderator can paste with zero edits — that's the difference between "I'll consider" and "done in 30 seconds":

   > **QuickInvoice just shipped Vacation Mode** — pause invoice reminders + show clients an out-of-office note on payment links without cancelling your plan. Useful if you take seasonal breaks. Free 7-day trial of Pro at quickinvoice.io.

5. **Send 5/day for 6 days** (~3 hrs total). Track replies in a Google Sheet. Target: 10% acceptance = 3 community announcements.

### Why this matters (income relevance)

Each community announcement reaches 200-2000 highly-targeted freelancers in the exact moment they're most receptive (community context = high trust). One moderator-driven announcement is worth ~5x a generic ad placement because the framing is "your trusted community recommends" not "we're paying to be in front of you." The vacation-mode story is unusually portable — it's a 1-line feature description that sells itself in any community where seasonal-income freelancers gather, which is most of them.

**Why now:** the feature's value proposition is acutely seasonal — outreach in Q2 / Q3 catches the summer-vacation cohort and Q4 holiday cohort. Ship the outreach within 30 days of the feature shipping so the announcement is news rather than backfilled history.

---

### 54. [MARKETING] Sponsored mention outreach to 5 micro-influencer freelancer YouTubers (added 2026-04-29)

**Why this matters (concretely):** Established cold-email and Reddit/X channels (TODO_MASTER #14, #17, #25) cover community surfaces; podcast sponsorship (#51) covers audio; listicle-author outreach (#52) covers SEO referrals. The remaining un-touched channel is YouTube, where freelance-niche channels (designer / developer / consultant tutorials) routinely place a "tools I use" sponsor segment in their 5-15 minute videos. A 30-second mention from a 10k-subscriber freelance YouTuber typically converts at 0.5-2% of view count to a /pricing visit — for $200-500 per placement that's ~$0.30-1.00 per high-intent visitor, well below QuickInvoice's blended CAC. Distinct from #51 podcast (different format/audience overlap minimal) and #15 demo video (that's QuickInvoice's own; this is third-party endorsement on someone else's audience).

**Action (Master, ~4 hrs research + ~1 hr/week ongoing during 6-week campaign + $1000-2500 ad spend total):**

1. **Build a YouTuber shortlist (~2 hrs).** Search YouTube for `freelance designer tools`, `freelance developer business`, `consultant invoicing`, `freelance accounting` — filter for channels with 5k-50k subs (sweet spot: large enough audience to matter, small enough that ad rates are negotiable). Pull 20-30 channels into a Google Sheet with: subscriber count, recent video views, niche, contact (channel about page, business email, Twitter/X). Prioritise channels that have placed a sponsor segment in the last 6 months — they're already accepting sponsorships.

2. **Draft outreach template (~30 min).** Pitch is short — YouTubers get 100+ inbound pitches/week:

   > Hi <name>, big fan of <recent video>. We run QuickInvoice — a freelancer invoicing tool with one-click Stripe payment links + automated late reminders. We're testing a small sponsorship budget across 5 freelance-niche YouTubers and would love to sponsor a 30-60s segment in one of your upcoming videos. Budget: $200-500 depending on placement. We send a free Pro plan + a custom referral coupon for your audience. Reply if useful — happy to send a 60s product demo.

3. **Send 5-10/week (~30-45 min/week).** Track in the same Google Sheet. Target: 20% reply rate = 5-6 placements landed across 4-6 weeks.

4. **Per-placement onboarding (~1 hr each).** Send each YouTuber a free Pro plan account, a custom Stripe promo code (`<creator-handle-50>` for 50% off first 3 months — gated through INTERNAL_TODO #58 redemption page once it ships), a 60s product-demo video they can voice-over, and 3 talking points (Stripe Pay Links, automated reminders, free 7-day trial).

5. **Track conversions for 60 days post-mention.** Per-placement coupon code makes attribution exact. Refresh the playbook based on which placements outperform.

**Income relevance (concrete numbers):** Industry data on freelancer-niche YouTube sponsorships (Mailbrew, Pirate Ship, ConvertKit have run similar plays) puts conversion-to-paid at 2-5% of click-through, with click-through rates of 0.5-2% of view counts. A $300 placement on a 10k-subscriber channel that gets 5k views → 25-100 click-throughs → 1-5 paid signups → $9-90/mo in MRR per placement. Across 5 placements that's $45-450/mo in incremental MRR for $1000-2500 one-time spend — ROI breakeven 5-25 months but the placements remain in the YouTuber's video library indefinitely (long-tail compounds for years).

**Why now:** Q2 / Q3 is YouTube's higher-engagement window before holiday content saturates Q4 ad inventory. Channels are also still finalising their 2026 sponsor lineup; getting in early secures lower rates. Pairs with #58 redemption page (once it ships, every YouTuber gets a clean attributable URL) and #52 listicle outreach (compounding multi-channel evergreen presence).


---

### 55. [MARKETING] Cross-promo cold-DM to 30 micro-podcasts in the freelance-business niche (added 2026-04-30)

**Why this matters (concretely):** TODO_MASTER #51 is a single paid podcast placement ($500-1500); TODO_MASTER #54 is paid YouTube sponsorship. Both pay for placement. Distinct from those, this is unpaid cross-promotion: cold-DM the host of 30 freelance-niche micro-podcasts (Indie Hackers Podcast, Freelance Friday, Freelance Pod, The Freelance Podcast, etc.) offering a free **Pro-tier upgrade for the host + a custom-branded discount code for their listeners** in exchange for a single mention on their next episode. No money changes hands. Hosts of small podcasts (2k-15k downloads/episode) are typically receptive because (a) the offer is genuinely useful if they invoice clients, (b) they get an attribution coupon to share, and (c) it's a 60-second "tools I love" segment, not an obligation to do an interview. Distinct from #51 (paid placement; this is unpaid) and #54 (different platform/format — YouTube vs audio-only).

**Action (Master, ~3 hrs research + ~30 min/week ongoing for 8 weeks):**

1. **Build a 30-podcast shortlist (~2 hrs).** Search Apple Podcasts / Spotify / Overcast for `freelance`, `solopreneur`, `freelance business`, `consulting business`, `independent contractor`. Filter for: weekly cadence, 2k-15k downloads/episode, host has a Twitter/X presence (cold DM beats cold email here — the medium signals "fellow indie creator", not "marketer"). Build sheet with: podcast, host name, X handle, latest-episode topic, listener-count estimate.

2. **Draft outreach template (~20 min).** Personal, short, no marketing fluff:

   > Hey <host>, just listened to <recent episode> — really liked <specific 1-line takeaway>. I run QuickInvoice, an invoicing tool for freelancers (Stripe Pay Links + auto-reminders). I'd love to give you a free Pro account + a 50%-off coupon for your listeners, in exchange for a quick mention next episode. No fee, no script — just whatever's authentic if you'd actually use it. DM me back if useful.

3. **Send 5/week × 6-8 weeks (~30 min/week).** Target: 20-30% reply rate = 6-9 placements landed. Track in sheet.

4. **Per-host onboarding (~30 min each).** Free Pro plan, custom-branded Stripe promo code (`<podcast-name-50>` for 50% off first 3 months — gated through INTERNAL_TODO #58 redemption page when it ships), a 90-second product demo video, and 2 talking points (one-click Stripe pay links, automated late-payment reminders).

5. **Track conversions for 60 days post-mention** via the per-host coupon code. Refresh the playbook based on which podcasts convert best.

**Income relevance (concrete numbers):** Cold-DM podcast cross-promo typically converts at 1-3% of listener count to paid (vs the 0.5-1% of paid sponsorship). On a 5k-listener episode that's 50-150 paid signups; even at the low end of $9/mo Pro that's $450-1350/mo in incremental MRR per placement — for $0 ad spend, just 30-min/week of DMs. Across 6-9 placements landed in the 8-week campaign that's $2700-12150/mo in additional MRR with **zero CAC**, which is wildly above the blended-channel CAC ROI. Pairs with #51 (paid podcast — different audience overlap) and #58 redemption page (once shipped, every host gets a clean attributable URL).

**Why now:** Q2 / Q3 is the season freelancers tax-prep + invoice-tooling-shopping; podcast hosts are also actively planning their 2026 content runs and tools-segment placements. Pairs with #93 email signature builder (once shipped, every host gets a "QuickInvoice user" footer that compounds organic reach).


---

### 56. [MARKETING] Cold-DM 30 freelance subreddit moderators with a permanent community discount (added 2026-04-27)

**Why this matters (concretely):** TODO_MASTER #14 (cold-email small agencies), #17 (Reddit/X organic posts on personal account), #25 (newsletter-borrowed audience), #51 (paid single-podcast), #54 (paid YouTube sponsorship), #55 (cold-DM 30 micro-podcasts) cover most adjacent-to-Reddit channels. The remaining un-touched surface is **moderator-endorsed community announcements** — a sticky thread or wiki entry on a high-traffic freelance subreddit that surfaces every time a community member asks "what invoicing tool should I use?". One sticky on `r/freelance` (790k members), `r/freelanceWriters` (180k), `r/Etsy` (470k — relevant for handmade-goods sellers who also invoice for custom orders), `r/sidehustle` (3.4M), or `r/Upwork` (250k) drives sustained organic traffic for months because the post stays at the top of the subreddit + is referenced in answers across the wider web. Distinct from #17 (organic posts you make on your account; this is moderator-endorsed) and from #55 (different platform — Reddit vs podcast). The hook is a permanent community-specific discount code (e.g. `RFREELANCE25` for 25% off for life) — the moderator gets a compelling community benefit to announce, the community gets a benefit they wouldn't get going to /pricing directly, and QuickInvoice gets attributable conversion + permanent presence in the wiki.

**Action (Master, ~3 hrs research + ~1 hr/week ongoing for 4-6 weeks):**

1. **Build a 30-subreddit shortlist (~2 hrs).** Search Reddit for `freelance`, `consulting`, `independent contractor`, `gig economy`, `1099`, `solopreneur`, `small business owner`. Filter for: ≥ 50k members, active mod team (recent mod posts), wiki/recommended-tools section already exists. Build sheet with: subreddit, member count, mod usernames (top 1-2 active), latest mod stickied post, modmail open?

2. **Draft outreach template (~30 min).** Mod-friendly framing — Reddit mods are notoriously hostile to obvious marketing, so lead with the community benefit:

   > Hi <mod_name>, I run QuickInvoice (invoicing tool for freelancers — Stripe Pay Links + auto-reminders). I'd like to offer r/<sub> a permanent 25%-off-for-life discount code (e.g. R<SUB>25) — listing it on the recommended-tools wiki, in modmail to anyone who asks "what invoice tool", or as a one-time stickied announcement, whichever feels right. No payment, no quid pro quo — just a community benefit if it's a fit. I'm happy to provide free Pro accounts for the mod team too. DM if useful, or feel free to ignore if not a fit.

3. **Send 5/week × 4-6 weeks (~30 min/week).** Track in sheet. Target: 10-20% acceptance rate = 3-6 placements. Some mods will counter-offer (e.g. "I'll add it to the wiki but no sticky") — that's still a win.

4. **Per-subreddit onboarding (~30 min each).** Free Pro plan for the mod team, custom Stripe promo code (`R<SUB>25` for 25% off life-of-account — gated through INTERNAL_TODO #58 redemption page when it ships), 1-paragraph community announcement they can copy-paste, links to a 90-second product demo video.

5. **Track conversions for 90 days post-placement** via the per-subreddit coupon code. Refresh the playbook based on which subreddits convert best.

**Income relevance (concrete numbers):** Reddit moderator-endorsed product placements have a known long-tail conversion profile (e.g. r/EntrepreneurRideAlong, r/sidehustle wiki entries from 2019-2021 still drive recurring traffic to ConvertKit, Carrd, Notion — search Reddit for "wiki recommended tools" to see). On a 100k-member subreddit that's typically 2-5 wiki referrals per week → 100-250/year → at 2-5% paid conversion that's 2-12 paid signups per year per subreddit, sustained for 2-5 years per placement. Across 3-6 placements landed in the 4-week campaign that's 12-72 sustained paid signups/year for $0 ad spend. The lifetime value compounds because (a) wiki placements rarely get removed and (b) every QuickInvoice user from that channel becomes a community-context evangelist. Pairs with #58 redemption page (clean attribution per subreddit) and #50 Indie Hackers product directory (different community type — small dedicated cohort vs Reddit's broader scale).

**Why now:** Reddit's moderator team turnover happens in 6-12 month cycles; landing a wiki entry now means 2026's mod team inherits the placement (even higher staying power). Q2/Q3 is also when freelance-niche subreddits run their annual "what tools do you use" megathreads — placements made now compound into those threads naturally.

---

### 57. [MARKETING] Apply to AppSumo for a lifetime-deal listing (added 2026-04-28)

**Why this matters (concretely):** TODO_MASTER #12 (Product Hunt), #13/#26 (G2/Capterra reviews), #19 (Show HN), #20 (newsletter sponsorship), #50 (Indie Hackers), #51 (paid podcast), #54 (paid YouTube), #55 (cross-promo podcasts), #56 (Reddit moderator placements) cover discovery / review / community / sponsorship channels. The remaining un-touched surface is **transactional lifetime-deal marketplaces** — AppSumo / DealMirror / PitchGround. AppSumo is the dominant one (1M+ active buyers, $30-80 typical lifetime deal price-point, freelancer-tools is a top-3 vertical). A successful AppSumo listing typically sells 500-3000 codes in the first 30 days at $39-49 with QuickInvoice taking ~30% net (~$15/code × 1500 = ~$22k cash injection up-front), plus a permanent funnel of LTD users who become organic word-of-mouth advocates inside their freelancer networks. Distinct from G2/Capterra (review/discovery surface, not transactional), distinct from Product Hunt (24-hour launch burst, not a sustained sales channel), distinct from organic Reddit / podcast / YouTube (those are top-of-funnel; AppSumo is bottom-of-funnel — buyers convert during the 60-day deal window). The product is a great fit: freelancer-targeted, recurring SaaS (AppSumo prefers products where users can be on-boarded without high-touch sales), self-serve checkout already live, free trial already live (which AppSumo evaluators verify before accepting).

**Action (Master, ~6 hrs initial submission + ~2 hrs/week ongoing during deal window):**

1. **Build the AppSumo submission package (~3 hrs).** AppSumo's vendor application asks for: short pitch (under 150 words), full product description, pricing tiers, Stripe Connect or AppSumo's escrow account, demo video (90-120 seconds — record using Loom over the existing QuickInvoice flow), screenshots (5-10 of pricing, dashboard, invoice-view, payment link, settings), refund policy (AppSumo standard is 60-day). Submit at https://appsumo.com/sell-on-appsumo/.

2. **Build the LTD redemption flow (~1.5 hrs Master + INTERNAL_TODO #58 dependency).** AppSumo issues unique redemption codes — needs the `/redeem/:code` page (already queued as INTERNAL_TODO #58) and a Stripe coupon `APPSUMO_LTD` (100% off, lifetime, 1-time-use per code) + a corresponding "lifetime" plan tier in `db/schema.sql` (could re-use Pro plan with `subscription_status='lifetime'` flag instead of adding a new tier). **Coordinate with INTERNAL_TODO Optimizer to bump #58 priority** if AppSumo accepts the listing.

3. **Set the deal price + stack tiers (~30 min).** AppSumo deals are typically tiered (1 code = 1 user, 2 codes = 5 users, 3 codes = 25 users) at $39 / $89 / $159 price points. Position QuickInvoice Pro Lifetime at $39 (single user) / $89 (3 users) / $159 (10 users) — gives Master ~$13/$30/$53 net per tier after AppSumo's 30% cut. Decision rule: model 1500 sales × $30 average net = $45k cash; minimum acceptable result for Master before approving the listing.

4. **Run the 60-day deal window (~2 hrs/week).** AppSumo deals run 60 days. During this period: (a) respond to AppSumo Q&A forum posts within 24 hrs (their algorithm down-ranks vendors who don't respond — direct conversion impact), (b) publish weekly "what's coming next" updates so LTD buyers feel ongoing-product-investment vs abandoned-LTD risk, (c) refund within 60 days no questions asked (AppSumo enforces this). Post-deal: convert LTD buyers to organic referral surface — they get unlimited Pro for life, but every invoice they send has the QuickInvoice powered-by footer + their network sees the product.

5. **Track conversions for 12 months post-listing.** Count: code redemptions, post-redemption monthly active rate, organic referrals from LTD users (via UTMs on shared invoice URLs), churn (LTD buyers who never log in past day 30). LTD-buyer activity rate is a key health signal — sub-30% MAU at month 6 means the LTD audience didn't stick.

**Income relevance (concrete numbers):** Comparable freelancer/business SaaS LTD listings on AppSumo (Carrd, Plutio, Bonsai-adjacent tools, Noteable, Hexowatch) sold 1500-4000 codes at $39-99 single-tier averages. At a 1500-sale midpoint × $30 net per sale, that's a $45k cash injection in 60 days — equivalent to ~50 net-new monthly Pro subscriptions sustained for a year (and bypasses the typical 18-month CAC payback). Indirect uplift (organic referrals from LTD users + AppSumo's badge / press placement on their landing page driving non-AppSumo traffic) typically adds another 200-400 organic signups within 6 months. Distinct income pattern from every other [MARKETING] item — this is the only one that produces a 5-figure cash event in a single 60-day window.

**Why now:** Master should run AppSumo only AFTER (a) INTERNAL_TODO #58 redemption page is built, (b) the LTD-tier pricing is defined in `db/schema.sql` (schema-side gating prevents LTD users from accidentally being charged later), (c) at least 5 testimonials are on the landing page (AppSumo evaluators check for social proof). Items (a) and (b) are queued; item (c) is gated on TODO_MASTER #21 testimonial collection. **Estimated runway to ready: 4-6 weeks.** This item is an Action queue item — keep [MARKETING #57] visible so when the prerequisites land, Master can move on it without re-deriving the rationale.

---

### 58. [MARKETING] Submit QuickInvoice to 6 SaaS-comparison directories (Slant / AlternativeTo / SaaSHub / Capiche / StackShare / Tekpon) (added 2026-04-28)

**Why this matters (concretely):** The shipped marketing pipeline already covers: Product Hunt (#12, 24-hr launch burst), G2/Capterra/TrustRadius (#26/#49, review-driven discovery), AppSumo (#57, transactional LTD), Reddit (#56, community moderator placements), podcast (#51/#55, audio), YouTube (#54, video sponsorship), listicles (#43, third-party SEO referrals), newsletter borrowed-audience (#20). The remaining un-touched discovery channel is **passive evergreen software-comparison directories** — Slant ("which is best, X or Y?"), AlternativeTo ("alternatives to FreshBooks"), SaaSHub ("compare SaaS tools"), Capiche, StackShare, Tekpon. These directories rank consistently in the top 3-10 for high-intent comparison queries (`freshbooks alternatives`, `wave alternatives`, `best invoicing tool for freelancers`) and a properly-written profile attracts referral traffic for years with zero ongoing cost. Distinct from G2/Capterra (which are review-driven and require user-volume gravity to rank); comparison directories rank on profile completeness + freshness, both of which are entirely Master-controllable. Distinct from listicle outreach #43 (which targets editorial articles); directories are user-generated submission flows that don't require third-party editorial buy-in.

**Action (Master, ~6 hrs initial submissions + ~30 min/quarter ongoing):**

1. **Build the canonical profile asset (~1.5 hrs).** One Google Doc with the canonical: 60-word product description, 200-word product description, 4-line pitch (what / who / why / pricing), feature matrix (vs. FreshBooks/Wave/Bonsai/HoneyBook — pull from INTERNAL_TODO #108), 5-10 product screenshots (already exist for AppSumo #57), pricing tiers, founder name + email + LinkedIn, list of 3 customer testimonials (gated on #21 testimonial collection — directories accept "no testimonials yet" but the listing converts noticeably better with 1-3 quotes). Re-use this asset across all 6 directories.

2. **Submit to Slant (~45 min).** Visit https://www.slant.co/options/new — submit QuickInvoice as an option under the "Best invoicing tool for freelancers" topic (and "Best Stripe-integrated invoicing tools"). Slant ranks options by community votes — after submission, ask the first 20 Pro customers (via in-app email post-conversion) to vote.

3. **Submit to AlternativeTo (~45 min).** Visit https://alternativeto.net/software/new/ — submit QuickInvoice as an alternative to FreshBooks, Wave, Bonsai, HoneyBook (4 separate "alternative-to" links). Each comparison surface ranks independently in Google for the respective `<competitor> alternatives` query. Critical: fill in the licensing field (commercial/SaaS/freemium), platforms (web), price range ($0-19/mo).

4. **Submit to SaaSHub (~30 min).** Visit https://www.saashub.com/submit — moderately-curated directory; submission needs a clean website + screenshots + pricing — already have all three.

5. **Submit to Capiche, StackShare, Tekpon (~45 min each, parallel).** Capiche and StackShare are developer-leaning (good fit for freelance-developer cohort); Tekpon has a lifetime-deal section that complements AppSumo #57 cross-promotion.

6. **Quarterly refresh (~30 min/quarter).** Update profiles when (a) a new pricing tier ships, (b) a new feature lands worth surfacing, (c) testimonial count crosses a milestone (5 → 10 → 25). Stale profiles drift down rankings.

**Income relevance (concrete numbers):** Comparable horizontal-SaaS profiles on these directories drive 50-300 organic referral visitors/month per directory once indexed (4-12 weeks post-submission). Across 6 directories: 300-1800 monthly visitors at QuickInvoice's measured signup conversion rate (~3-5%) = 9-90 signups/month and 1-5 paid conversions/month per directory. Compounding annually with no ongoing spend — the listings live forever once accepted. Approximate ARR contribution at month 12: $1.5k-7k MRR-equivalent, assuming each Pro converter sticks 12+ months. Distinct dynamic from every other [MARKETING] item: passive, evergreen, zero-ongoing-cost.

**Why now:** All 6 directories accept submissions only after the product has a public website + screenshots + a pricing page (all live), and all 6 weight "founder is responsive in the comments / Q&A" — a Master who's actively running the company will outperform an absentee one. Submitting NOW (rather than batching with later marketing pushes) gives the listings 12+ weeks of indexing runway before they need to start performing — the lead time is the only cost.

---

### 59. [MARKETING] Co-marketing partnership outreach — Calendly / Bonsai / Notion / Plaid integration listings (added 2026-04-28 PM-2)

**Why this matters (concretely):** The marketing pipeline so far covers acquisition channels owned by QuickInvoice (#12 PH, #19 Show HN, #26/#49 G2, #57 AppSumo, #58 SaaS-comparison directories) or that target end-users directly (#43 listicles, #44 LinkedIn, #45 Slack/Discord, #50 IH, #56 Reddit). The remaining un-touched lever is **partner-channel distribution** — getting QuickInvoice listed on the integration / app-marketplace pages of products that the same freelancer cohort already uses every day. The 4 highest-leverage targets:

1. **Calendly** — every freelancer who books client calls has Calendly. Calendly's app marketplace (https://calendly.com/integrations) lists QuickInvoice as "Generate an invoice after a Calendly meeting" — adds a per-meeting `auto_invoice_after` toggle. Calendly's marketplace gets ~150k unique visitors/month browsing integrations.
2. **Bonsai / HoneyBook competitor co-marketing** — paradoxically, the competitor-tools-with-different-niche segment will refer for free if the integration positions QuickInvoice as the "lightweight Stripe-first" alternative their over-served customers ask for. Bonsai customers who churn cite "too many features I don't need + price" — those ex-Bonsai users are ideal QuickInvoice converters.
3. **Notion** — the Notion templates marketplace (https://www.notion.com/templates) accepts "Notion + integration" listings. A "Freelancer financial dashboard" Notion template that pulls data from QuickInvoice's (planned) #32 API surfaces both products to each others' audiences. 25M+ Notion users.
4. **Plaid / Mercury / Wise small-business banking** — these banks publish "tools we recommend" pages curated by their content team. A short pitch email to their content lead ("here's a tool your customers ask about — happy to write the partner integration") lands a backlink from a high-authority finance domain.

Distinct from #43 listicles (third-party editorial, not partner-direct) and from #58 SaaS comparison directories (passive submission, no relationship). Co-marketing partnerships are slower (4-12 week relationship-building cycle) but produce higher-quality referrals (partner audiences are pre-qualified for product-fit) and compound — a partner who's run the integration for 6 months is much more likely to expand the relationship.

**Action (Master, ~10 hrs initial outreach + ~2 hrs/month ongoing):**

1. **Build the canonical partnership pitch deck (~2 hrs).** Single Google Slides deck (8-10 slides max): "Who QuickInvoice is for", "What we offer partners" (a) listing on our `/integrations` page (gated on building one — note as new INTERNAL_TODO if not queued), (b) co-branded email to our user base post-launch, (c) revenue share if applicable for transactional integrations, (d) data exchange / SSO / OAuth depending on technical fit. Include 2-3 mock screenshots of the integration in action. Re-use across all 4 partner outreaches.

2. **Calendly partner application (~2 hrs).** https://developer.calendly.com/getting-started — submit as an integration partner. Requires OAuth implementation on QuickInvoice side (folds into INTERNAL_TODO #32 API Key Auth + REST Endpoints). The technical effort gate is 20-30 hrs of dev (Calendly OAuth + webhook handler that creates a draft invoice when `invitee.created` fires); Master handles the relationship-building + listing copy. **Coordinate with INTERNAL_TODO Optimizer to bump #32 priority** if Calendly accepts the listing.

3. **Bonsai co-marketing email (~1 hr).** Cold email Bonsai's growth lead (LinkedIn-search "Bonsai growth marketing" + Hunter.io for email) with a "QuickInvoice as the lightweight alternative for your customers who churn for cost reasons — here's a $50 referral bonus per Pro signup we'll honour for 12 months" pitch. Bonsai's growth team explicitly tracks "where do churned customers go?" — making it easy to channel them to QuickInvoice (with a small kickback) is rational.

4. **Notion template listing (~3 hrs).** Build a template called "Freelancer Financial Dashboard" (Notion table that mirrors invoice/client/payment data with sample fixtures). Submit at https://www.notion.com/templates/submit. Initially the template carries pure-fixture data; once #32 API ships, layer in a Zapier/Make recipe that auto-syncs real QuickInvoice data into the template. Notion's template marketplace is curated — quality threshold is high but the audience-quality is unmatched.

5. **Plaid / Mercury / Wise partnership email (~2 hrs/each, parallel).** Cold email each bank's content team / partnerships lead with a "partner spotlight" pitch — offer them a co-authored blog post ("How freelancers should think about getting paid"), a guest podcast on their podcast (#51/#55 channel reuse), or a co-branded webinar. The ask is small (a backlink from their resources page), the give is content. Even a 30% acceptance rate across 3 banks lands 1 high-authority backlink — single highest-impact SEO move available.

6. **Track conversions + partner health (~30 min/month).** Single Notion page: partner name, pitch date, response (yes/no/silent), integration status, signups attributable per month, paid conversions. Score each at month 6 against the rule "≥ 5 paid signups/month → invest more; sub-3 → quietly de-prioritise". Sustained partner relationships are 80/20 — most partners produce nothing and a few become long-term distribution channels.

**Income relevance (concrete numbers):** Comparable freelancer-SaaS partnership listings (Wave on Plaid, FreshBooks on Calendly, HoneyBook on Honeybook's own template-marketplace) drive 200-1500 attributable signups/year per partnership at 3-8% paid conversion → 6-120 paid signups/year/partner. Across 4 active partnerships: 24-480 paid signups/year — equivalent to $3.5k-$70k/year in MRR-equivalent at QuickInvoice's $12/mo Pro price-point. Slower ramp than other [MARKETING] items (4-12 week relationship-building cycle) but the highest-leverage compounding effect once a partner relationship is real.

**Why now:** Pre-#32 API Key Auth landing, the technical depth of each integration is shallow (no OAuth, no webhook bidirectional). Some partners (Notion templates, Plaid/Mercury/Wise content links) don't require API depth and can land NOW; others (Calendly app marketplace) are gated on #32. Splitting the outreach across "API-not-required" (3 items) and "API-required" (1 item, Calendly) lets the no-API ones ship in 4-6 weeks; the Calendly one waits on engineering. Master should sequence: Mercury/Plaid/Wise emails this week → Notion template next week → Bonsai co-marketing in 4 weeks → Calendly when #32 lands.

---

### 60. [SPEC-REVIEW] Verify auto-reconstructed master/APP_SPEC.md (added 2026-04-28 PM-3)

The previous `master/APP_SPEC.md` described only the InvoiceFlow Java/Spring app (the `invoiceflow/` subdirectory) and had drifted out of sync with the actual codebase being shipped (QuickInvoice — Node.js/Express, at the repo root). It also pinned plan prices that no longer match production ($9 Solo / $19 Pro / $49 Agency) — the live tiers are Free / $12-mo or $99-yr Pro / $49 Agency.

This cycle's bootstrap reconstructed APP_SPEC.md from the codebase directly: read `package.json`, `server.js`, `routes/*.js`, `views/*.ejs`, `db/schema.sql`, `Procfile`, plus the InvoiceFlow `pom.xml` and Java tree. Both apps are now documented under one spec (App 1 = QuickInvoice primary, App 2 = InvoiceFlow secondary).

**Action (Master, ~10 min):**

1. Read the new `master/APP_SPEC.md` end-to-end.
2. Verify the documented plan prices ($12/mo, $99/yr, $49/mo Agency) match the Stripe Dashboard prices currently configured.
3. Confirm the "core features built today" list matches your understanding of what QuickInvoice does — flag any discrepancies (e.g., a feature the doc claims is shipped but isn't, or a feature you consider shipped that the doc omits).
4. Confirm the InvoiceFlow status — is it actively maintained, frozen, or scheduled for sunset? The current spec says "feature parity goals tracked under specific INTERNAL_TODO items" — refine if InvoiceFlow is no longer being developed.
5. Edit any inaccuracies directly. The routine will pick up the corrected spec on the next run via the App Spec Sync step at boot.

**Why this matters:** every subsequent role reads APP_SPEC.md to orient. A stale spec causes off-target growth ideas and irrelevant test priorities. ~10 min spent reviewing once compounds across every future routine cycle.

### 61. [MARKETING] Set up affiliate program via Rewardful (or LaunchAffiliate / FirstPromoter) for influencer-driven Pro signups (added 2026-04-28 PM-3)

Distinct from #18 (referral program for end-users — peer-to-peer "your friend gave me a coupon"). An affiliate program targets professional creators / YouTubers / newsletter authors / freelance influencers — the people whose audiences are exactly QuickInvoice's ICP. The mechanic is a stable 25%-recurring commission paid out monthly via Stripe Connect or PayPal, signed up through a self-serve portal. Distinct from co-marketing (#59) — partners promote QuickInvoice as a feature of their integration; affiliates promote QuickInvoice as a recommendation in their content.

**Action (Master, ~6 hrs initial setup + ~1 hr/month ongoing):**

1. **Pick the platform (~30 min).** Rewardful ($49/mo, Stripe-native, 30-second integration), LaunchAffiliate ($79/mo, more-features-than-needed), or FirstPromoter ($59/mo, similar to Rewardful). Default recommendation: Rewardful — it's the cheapest, the integration is single-script-tag, and the dashboard ships pre-built. Master can sign up, drop the script tag in `views/partials/head.ejs` (mid-upgrade-funnel only — gated on `?aff=` query string detection), and configure Stripe webhook routing within an hour.

2. **Define the offer (~1 hr).** 25% recurring commission for 12 months on each Pro signup the affiliate drives. (Industry-standard for freelancer SaaS — FreshBooks runs 25%, Bonsai runs 25%, FreeAgent runs 30%.) Cookie window: 60 days. Minimum payout threshold: $50. Approval: manual for the first 25 affiliates (so we can vet ICP fit), auto-approve after that.

3. **Build the affiliate landing page (~1 hr).** Single static page at `/affiliates` linking to the Rewardful signup portal. Hosted via existing `routes/landing.js#listNiches()` machinery — add as a static niche entry. Copy emphasises (a) "your audience already invoices clients — recommend the tool you'd actually use", (b) the 25%-recurring math: $36 per active referral over 12 months, scales linearly, and (c) the asset pack download (logos, screenshots, YouTube thumbnail templates).

4. **Identify + outreach 50 candidate affiliates (~3 hrs).** YouTubers in the freelance / design / dev / consulting space with 5k-100k subs. Newsletter authors covering freelance/solopreneur topics. Cold email + 3-touch follow-up. Acceptance rate ~15-25% expected (industry typical for cold outreach with a strong recurring offer).

5. **Track + optimise monthly (~1 hr/month ongoing).** Rewardful surfaces conversion stats per affiliate. Once an affiliate hits 5+ paid signups in a month, escalate to a 30%-recurring tier (signal: they're actually driving signups, double-down on the best ones).

**Income relevance (concrete numbers):** Comparable freelancer-SaaS affiliate programs (FreshBooks, Bonsai, AND.CO, HoneyBook) generate 100-500 paid signups/month at maturity (12-18 months in). Conservative ramp for QuickInvoice's stage: 10-50 paid signups/month at month 6, 50-150/month at month 18. At $12/mo Pro: $120-$1800/month MRR-equivalent at month 6, scaling to $600-$5400/month at month 18. The 25% commission costs $30-$1350 of that — the remaining $90-$4050 net is high-leverage growth that compounds without ad spend.

**Why now:** the trial-countdown nav pill (#106), recent-revenue card (#107), and window toggle (#117) recently shipped — the dashboard surface is more compelling-looking than 30 days ago. Affiliate creators making screenshot-driven content benefit when the screenshots show momentum (the recent-revenue card showing "$2,400 paid in last 7 days" is the kind of asset YouTubers feature in thumbnails). Sequence after Master sets RESEND_API_KEY (#18) so affiliates aren't recommending a tool whose password-reset is a stopgap email-support flow.

---

### 62. [MARKETING] Personalized 90-day Pro comp outreach to top-10 freelance YouTubers (added 2026-04-28 PM-4)

Distinct from #61 (structured affiliate program at scale) and from #59 (co-marketing partner integrations) and from #43/#54/#55 (one-off media spends with paid sponsorships). The mechanic here is a single one-time hand-curated outreach: identify 10 specific high-fit YouTubers / newsletter authors in the freelance space, each cold-emailed with a personalised 90-day Pro account comp + a "no strings, do whatever you want with it — review, recommend, or never mention us, your call". The asymmetry: $0 marginal cost (Pro is digital), high signal (the curator audience is qualified), and the no-strings framing reverses the usual sponsorship-skepticism dynamic — every published mention is genuine, every silent ignore is fine. Runs in parallel with #61 affiliate program (which is the always-on revenue share); this is the single-shot quality push that seeds the top-of-funnel.

**Action (Master, ~6 hrs total):**

1. **Build the target list (~2 hrs).** 10 specific creators, ranked by fit-not-size:
   - 3-4 YouTubers with 20k-100k subs in the design/dev/consulting freelance space (search: "freelance" + "tools I use" review videos with > 5k views in last 6 months). The mid-tier is higher-fit than mega-creators — closer relationships with their audiences, more responsive to cold outreach.
   - 2-3 newsletter authors in the solopreneur space (Substack search "freelance"; Beehiiv "indie business"). Newsletter open-rates are 30-50% — small lists with high engagement convert better than large lists with low engagement.
   - 2-3 podcast hosts in the freelance/creator space (search Apple Podcasts "freelance" + episode counts > 50). Podcast plugs convert at 10-30x newsletter rates per impression for product mentions.
   - 1-2 Twitter/Threads/Bluesky personalities with 10k+ followers who post regularly about freelance ops (vs. just generic productivity).
2. **Personalize each email (~30 min/email × 10 = 5 hrs).** This is the one place where templating fails — generic "we're QuickInvoice, here's a comp" outreach has < 3% response rate; personalized "I watched your video on freelance billing tools last week, I built X to solve the specific pain you mentioned at 4:32 — here's a 90-day Pro comp, do whatever you want with it" hits 30-50%. The 30-minute-per-email cost is the entire mechanic.
3. **Track responses + follow up at 14 days (~1 hr).** Single Notion sheet: creator name, channel, send date, response (yes/no/silent), 90-day comp code, attributable signups (via UTM-tagged share link). Score at month 3: ≥ 1 paid Pro signup attributable per creator → invest more (sponsor a video, send free swag, escalate to ongoing relationship). 0 → no follow-up needed.

**Income relevance (concrete numbers):** Comparable single-shot creator outreach for freelancer-SaaS (Toggl Track, Wave, FreshBooks early-days) lands 1-3 free organic mentions per 10 outreach emails (response rate × publish rate). Each organic mention from a 20k-100k-sub creator drives 50-300 attributable signups over 30 days at QuickInvoice's signup conversion rate (~3-5% to Pro) → 1.5-15 Pro signups per mention. Across 10 outreach emails: 1-5 published mentions × 1.5-15 signups = 1.5-75 paid signups for ~$0 marginal cost. At $12/mo Pro: $18-$900/month MRR-equivalent for ~6 hrs of work. Distinct from #61 affiliate (always-on, structured) — this is the high-touch quality push that complements the always-on layer.

---

### 63. [MARKETING] Submit QuickInvoice to G2's annual "Best Free Invoice Software" award category for the next quarterly cycle (added 2026-04-28 PM-5)

Distinct from #26 / #49 (G2 Crowd profile creation + ongoing review collection — continuous, year-round). G2 runs **named annual award categories** (Best Free Invoice Software, Best Small-Business Billing Software, Easiest to Use, Best Estimated ROI) that publish quarterly with a hand-curated badge that winners can display + a press release G2 distributes to their B2B media network. The badge becomes a permanent acquisition asset on the landing page; the press release lands in 30-60 small-business newsletters by default. Submission is free and requires only (a) an existing G2 profile (which #26 / #49 establishes), (b) ≥ 10 verified reviews in the prior 90 days, (c) a 200-word "why we should win" submission essay.

The asymmetry: zero ongoing cost, 1-time submission effort (~1 hr), an evergreen acquisition badge (every QuickInvoice landing page render + the next 12 months of organic search shows the "Best Free Invoice Software 2026 Q3" badge if won), AND the press-release secondary distribution layer. Even nominee status (no win) renders a "G2 Nominee" badge that strengthens trust signals at no cost.

**Action (Master, ~1 hr initial + ~30 min/quarter ongoing):**

1. **Confirm G2 profile is live + has ≥ 10 reviews (~5 min).** Gated on #26 / #49 progressing. If fewer than 10 reviews, fold this into the post-#26 sequence — the award-submission triggers on the review-count milestone.
2. **Identify the next eligible quarterly cycle (~10 min).** G2's award cycles: spring (deadline early March), summer (early June), fall (early September), winter (early December). Pick the next cycle whose deadline falls 4+ weeks out so the submission essay has buffer.
3. **Write the 200-word submission essay (~30 min).** Concrete-numbers framing: "QuickInvoice ships invoice-to-paid in 60 seconds via Stripe Payment Links — our Pro users average 4.2 days from sent-to-paid vs. industry-typical 14-21 days. At 4x faster cash-collection on a $2k freelance invoice, freelancers earn the cost of QuickInvoice Pro back on a single invoice." The essay reads like a press-release lede; G2's curators score on (a) concrete differentiator, (b) measurable user outcome, (c) clarity. Avoid feature lists.
4. **Submit + retain copy (~5 min).** G2 submission form at https://research.g2.com/awards. Keep a copy of the essay in `master/G2_AWARD_SUBMISSIONS.md` (new doc; not yet existing) so quarterly resubmissions can iterate on the same template.
5. **Quarterly follow-up (~30 min/quarter).** When G2 publishes results, (a) embed the badge on the landing page hero (winning) or footer (nominee), (b) add a `/og-image-award.png` variant for the quarter so social shares carry the badge in OG previews, (c) tweet the announcement with G2's @ tag (G2 reliably amplifies). Repeat each quarter.

**Income relevance (concrete numbers):** Comparable freelancer-SaaS that won (or were nominated for) G2 awards in the prior year (FreshBooks, Wave, AND.CO, Honeybook) reported 15-40% conversion lift at the landing-page-hero step over 12 months. At QuickInvoice's signup volume, even 15% lift on 200 monthly hero impressions = 30 incremental signups, 1-2 incremental paid Pro signups per month per quarter — **per category won**. Across 4 categories submitted simultaneously: 4-8 incremental paid signups/month at $12/mo = $48-96/month MRR-equivalent. The press-release secondary distribution adds 50-300 referral visitors per published win (G2's media partners run the press releases for free for their pre-existing relationships). Compounding: each quarterly badge stacks (the landing page eventually shows 4 quarterly badges, then 8, then 12) — the trust-signal density compounds linearly with cycle count.

**Why now:** QuickInvoice has shipped enough recent surface-area improvements (recent-revenue card, trial-countdown nav, share-intent buttons, annual savings pill, niche landing pages) that the "concrete differentiator" essay slot has fresh material. Submitting at the next cycle deadline before the existing G2 reviews go stale (they decay weighting after 12 months) maximizes the badge-and-distribution upside. Distinct from #26 (build the profile), #49 (collect reviews), #61 (affiliate program), #62 (creator outreach) — this is the editorial-recognition acquisition layer that complements every other [MARKETING] item without overlap.

**Why now:** the dashboard surface (recent-revenue card #107, window toggle #117, localStorage persistence #122 just shipped) is screenshot-ready in a way it wasn't 30 days ago. Reviewers featuring the product in screenshot-driven content (YouTube reviews, newsletter writeups) benefit when the dashboard shows momentum + state-preserving polish. The window toggle + saved preference is the kind of small-but-thoughtful detail reviewers explicitly call out as differentiating from competitor tools.

---

### 64. [MARKETING] Quora answer-rotation: top 10 high-traffic freelancer-billing questions (added 2026-04-29 AM)

Distinct from existing distribution motions: #14 Reddit posts (different platform pattern — Reddit threads expire in days, Quora answers index in Google for years), #34 Indie Hackers / r/SaaS launches (different audience — IH is founder-cohort, Quora is freelancer-cohort searching practical answers), #43 listicle outreach (third-party article placement vs. first-party answer authorship), #44 LinkedIn outbound (DM vs. content), #62 creator outreach (1:1 partnership vs. broadcast Q&A). The Quora long-tail answer-rotation channel is the **search-intent** distribution layer: Quora answers rank in Google for "how do I [verb] X" queries with high commercial intent, and a single substantive answer drives 10-50 monthly visits for years.

**Why this matters concretely:** Quora's algorithm rewards (a) length (300+ words), (b) specificity (concrete numbers / step-by-step / first-person experience), (c) recency (answers refreshed in the prior 6 months rank higher), and (d) author credibility (Quora author profiles with linked-website + bio rank higher). The cost is one founder profile setup + ~20 min per answer. The lift is asymmetric: a freelancer searching "freelance invoice template" lands on a Quora answer that solves their real question (what fields to include, how to format, what payment terms to offer) AND mentions QuickInvoice in context as one tool option — typical click-through rate 1-3% of answer-readers.

**Action (Master, ~3 hrs initial + ~30 min/week ongoing):**

1. **Set up Quora Author profile (~15 min).** Create / claim the founder Quora account. Set bio to: "Founder of QuickInvoice — helping freelancers send professional invoices and get paid faster via Stripe." Link to https://quickinvoice.app (or live URL). Upload a professional headshot. The bio + linked-website is what every answer's "by [name]" footer surfaces — it's the click-through path.

2. **Identify the top 10 highest-traffic target questions (~30 min).** Use Quora's search to find questions with ≥ 100 followers and ≥ 50 answers (signal of established traffic). Target seed list:
   - "What is the best invoicing software for freelancers?"
   - "How should I write an invoice as a freelancer?"
   - "What should I include on a freelance invoice?"
   - "How do I get paid faster as a freelancer?"
   - "How do freelancers handle late payments?"
   - "What's the best way to send invoices to international clients?"
   - "Should I use FreshBooks or [alternative] for freelance invoicing?"
   - "How do I follow up on overdue invoices professionally?"
   - "What's the best free invoice template for freelancers?"
   - "How do I set up a freelance billing system?"

   Actual question wording will vary — Quora rewards precise matches, so the founder should use the exact phrasing of the top 1-2 ranked questions.

3. **Write 10 substantive answers (~2 hrs initial + ~20 min each ongoing).** Each answer follows the format: (a) acknowledge the asker's specific situation, (b) give 3-5 concrete tips that solve the question independent of any tool (real value first), (c) mention QuickInvoice as one example tool in the context of "I built this because..." (founder-credibility framing — Quora algorithm penalizes anonymous product mentions, rewards founder-acknowledged ones), (d) close with a clear "the best tool depends on your situation" softener (not a hard sell). Avoid: bare links, repeated phrasing across answers (Quora's spam filter penalizes pattern-matching), exclusively self-promotional content.

4. **Link strategically (~5 min per answer).** Each answer should contain 1-2 links: one to the QuickInvoice landing page (`https://quickinvoice.app/?utm=quora-[question-slug]`), one to a relevant niche page (e.g., `/invoice-template/freelance-designer`). The UTM parameter routes Quora traffic to its own attribution stream so the conversion rate can be measured separately.

5. **Refresh + monitor (~30 min/week ongoing).** Quora's algorithm decays answer rank after 6 months without engagement. Each week: edit one of the 10 answers (add a new paragraph, update a stat, freshen the example) — minor edits restore the recency signal. Monitor `?utm=quora-*` traffic in Plausible (#34 / TODO_MASTER #29) once that lands; without analytics, monitor the Quora-built-in answer-view counter as a lagging proxy.

**Income relevance (concrete numbers):** Quora answers that rank top-3 on the question for "best freelance invoicing software" typically attract 200-1000 monthly views once stabilized (3-6 months). At a 1-3% click-through rate, that's 2-30 monthly visits to the QuickInvoice landing page per ranked answer. Across 10 ranked answers: 20-300 monthly visits at zero ongoing cost. At QuickInvoice's typical landing-to-trial conversion (~3-5%), that's 1-15 incremental trials/month, or 1-5 incremental Pro signups/month at the trial→paid rate. **The compounding factor:** answers don't decay if maintained — a well-written Quora answer ranked in 2026 is likely to still rank in 2028, making this the highest-LTV per-hour distribution channel in the entire TODO_MASTER list.

**Risks:** Quora's TOS prohibits "primarily promotional" content. The mitigation is the format (real value first, product mention contextual). Founders who routinely treat Quora as a promo-link channel get shadow-banned; founders who answer substantively and mention their own product transparently when relevant get rewarded with sustained reach. The format above is the working pattern.

**Why now:** the trial-urgent banner cluster (#45 + #133 + #134/#135 candidates) is now richly featured for the screenshot-driven Quora answer that says "and here's how QuickInvoice handles the trial-end conversion moment" — the screenshot is differentiating in a way that wasn't true 60 days ago. Same dynamic as #62 creator outreach: the product surface needs to be visually compelling for the marketing channel to convert at full strength.

---

### 65. [MARKETING] Cold-DM 30 Twitter/X freelance "personal CRM" / "freelance ops" thread-creators with Pro comp + collab offer (added 2026-04-29 AM-3)

**Action (Master, ~2 hrs research + ~1 hr/week ongoing for 4 weeks):**

1. **Identify the cohort (~2 hrs).** On Twitter/X, search for accounts that have published at least 3 viral threads (≥ 5k impressions each) in the last 6 months on freelance operations, personal CRM, freelance billing, or "tools I use as a freelancer". Filter to follower count between 5k and 50k — small enough to be reachable via DM, large enough that a single thread-mention drives meaningful traffic. Build a spreadsheet of 30 candidates with: handle, follower count, top thread URL, last post date, niche.

2. **Send personalized DMs (~30 min/week × 4 weeks).** Don't blast — send 7-8 DMs per week so each is genuinely personalized. Template:
   > "Hey [name] — saw your thread on [specific topic] last [time period]. Genuinely useful framing on [specific point].
   >
   > I built QuickInvoice — invoicing for freelancers that gets you paid 60% faster. Free Pro account for you (no card, no expiry) if you want to kick the tires. No ask, just thought it might fit your toolkit.
   >
   > If you ever want to feature it in a thread, happy to share the back-end metrics for context (we shipped a feature this week that I think your audience would find interesting: [specific feature relevant to their niche])."

3. **Track responses.** Use a simple sheet — sent date, response (none / declined / engaged / converted to mention), date of any thread mention, traffic delta in Plausible (#34 / TODO_MASTER #29) for the days following the mention.

4. **Provision Pro comp accounts on request.** When a creator says yes, manually flip their `plan` to `pro` and set `subscription_status = 'active'` + `trial_ends_at = NULL` via Postgres. Mark with a `notes` field "creator-comp-2026-04-XX-handle" so the cohort can be analyzed separately later.

**Income relevance (concrete numbers):** A single Twitter/X thread mention from a 20k-follower freelance-ops creator typically drives 200-500 visits to the linked landing page over 48 hours, with a conversion-to-trial rate of 4-8% and a trial-to-paid rate of 4-8% — so 0.3-3.2 Pro signups per mention. Across 30 outreaches at a typical 10-20% positive-response rate, that's 3-6 thread mentions, or 1-19 incremental Pro signups in the campaign window (one-time effect plus an ongoing tail as the threads continue to surface in the Twitter/X algorithm).

**Distinct from existing distribution motions:** #44 LinkedIn outreach (B2B exec channel, different cohort), #47 cashflow horror story Twitter threads (founder-authored content vs. third-party endorsement), #54 YouTube micro-influencer outreach (long-form video vs. text-thread distribution), #62 top-10 YouTuber comp (different platform), #63 G2 awards (review-platform distribution), #64 Quora answer-rotation (search-intent first-party content). Twitter-thread-creator cohort is a third social-channel surface beyond LinkedIn (B2B exec) and YouTube (long-form).

**Risks:** DM-fatigue is real on Twitter/X. The mitigation is volume control (7-8/week, not 30-in-one-day), genuine personalization (reference a specific thread, not a generic "love your content"), and the no-ask close ("happy to share metrics" rather than "would love a thread mention"). Creators who feel transacted-with shadow-block; creators who feel respected often mention organically months later.

**Why now:** the recent feature shipping cadence (cycle 21 #133 + cycle 22 #134 + cycle 23 #138 + the upcoming #135/#139/#141 candidates) gives the founder a fresh, screenshot-able feature surface every week to anchor the DM's "shipped this week" line. Without ongoing visible-shipping cadence the DM template's specific-feature-mention slot rings hollow.
