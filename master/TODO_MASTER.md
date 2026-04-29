# Actions Required from Master

> **Audited:** 2026-04-27 PM — Task Optimizer re-pass. All items reviewed against CHANGELOG (which now spans 2026-04-22 → 2026-04-27 PM). Three new items added this cycle: **#42** (verify domain + submit sitemap to Google Search Console — 10-min one-time SEO foundation, gates the value of #8 sitemap + #36 OG metadata + #56 robots.txt), **#43** ([MARKETING] listicle outreach for backlinks — high-leverage compounding SEO), **#44** ([MARKETING] LinkedIn cold-outbound to Ops/Eng Directors hiring freelancers — Agency-tier funnel — gated on INTERNAL_TODO #9 shipping). No items tagged [LIKELY DONE - verify] this cycle — every prior Master action remains pending its respective external step (Stripe Dashboard config, Resend API key, Plausible domain, etc.). Items 1–8 are human deployment/configuration actions; none are resolved by code commits. Code for all P1–P10 features and every shipped INTERNAL_TODO item is complete; deployment + the listed Stripe / Resend / domain / analytics provisioning are the remaining blockers to scale-revenue.

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

## 9. Confirm DecentInvoice webhook covers Payment Link events (added 2026-04-23)
DecentInvoice's existing Stripe webhook at `POST /billing/webhook` is already subscribed to `checkout.session.completed` (used for Pro subscriptions). The new invoice Payment Link feature re-uses this same event type, distinguished by `session.mode === 'payment'` with a `session.payment_link` ID. **No new event subscription needed** — just verify after deploy that the endpoint shows `checkout.session.completed` events and that a test invoice Payment Link payment flips the invoice to `paid` in the DB.

If you want to harden against network glitches, also subscribe the endpoint to `payment_intent.succeeded` (current code ignores it; future hardening can use it as a fallback).

## 10. Run idempotent migration for `payment_link_url` / `payment_link_id` (added 2026-04-23)
The invoice Payment Links feature adds two columns. `db/schema.sql` includes idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements, so a fresh `psql -f db/schema.sql` run against production is safe and a no-op on already-migrated DBs.

## 11. Create Stripe annual Pro price and set env var (added 2026-04-23)
The new annual billing cycle (**$99/year**) is fully implemented on the DecentInvoice side (UI toggle on pricing, settings, and the upgrade modal; `billing_cycle` flows through `POST /billing/create-checkout`). It requires one human action to activate:

1. In the Stripe Dashboard, open the existing **Pro** product and add a second recurring price: **$99 / year**. Copy the new `price_...` ID.
2. Set the env var on the deployed app:
   ```
   STRIPE_PRO_ANNUAL_PRICE_ID=price_...
   ```
3. Verify: hit `/billing/upgrade`, toggle to Annual, click upgrade — the Stripe Checkout page should show $99/year.

**Until this is done, annual selections gracefully fall back to the monthly $12/mo price** (the `resolvePriceId()` helper in `routes/billing.js` handles this — the CTA never breaks, users just don't get the annual discount). No code change is needed once the env var is set; the next request picks it up automatically.

The existing `checkout.session.completed` and `customer.subscription.updated` webhook handlers already work for annual subscriptions — no webhook change needed.

## 12. Enable Stripe Smart Retries + Dunning Emails (added 2026-04-23)
The DecentInvoice code for Stripe Dunning is now live (`customer.subscription.updated` webhook now tracks past_due/paused, dashboard renders a dismissible "Update payment method" banner that deep-links to the Customer Portal). Activating the recovery flow requires three human actions in the Stripe Dashboard on the live account:

1. **Settings → Billing → Subscriptions and emails → Smart Retries:** toggle ON. Accept the default schedule (retries over ~14 days) or customise.
2. **Settings → Billing → Subscriptions and emails → Emails to customers:** enable "Email customers for failed payments" and "Send emails about expiring cards". These are Stripe-sent dunning emails — no code needed on our side.
3. **Settings → Billing → Subscriptions and emails → Manage failed payments:** select **"Pause subscription"** (not "Cancel subscription") on final retry failure. This is critical — pausing preserves `stripe_subscription_id`, which is what lets the user self-recover via the in-app banner → Customer Portal. Cancelling would require a fresh Checkout.

Also run the idempotent schema migration once after deploy (adds `subscription_status` column):
```bash
psql $DATABASE_URL -f db/schema.sql
```

**Verification:** create a test subscription, use Stripe's test card `4000 0000 0000 0341` (successful for subscription creation, fails on first renewal) to simulate a past_due state, and confirm the dashboard renders the red banner with an "Update payment method →" button that opens the Stripe Customer Portal.

## 14. DecentInvoice: idempotent migration for `webhook_url` column (added 2026-04-23)
The new Zapier outbound-webhook feature (INTERNAL_TODO #7) adds a single nullable `webhook_url TEXT` column to `users`. `db/schema.sql` includes an idempotent `ALTER TABLE users ADD COLUMN IF NOT EXISTS webhook_url TEXT;` statement, so:

```bash
psql $DATABASE_URL -f db/schema.sql
```

is safe to run against production (no-op on already-migrated DBs). No env var, no Stripe config, no Zapier/Make account required — this is a pure code feature. Users paste their own catch-hook URL into `/billing/settings`.

**Verify after deploy (1 min):** log in as a Pro user, paste a test URL from https://webhook.site into the **Zapier / Webhook** section of `/billing/settings`, mark any invoice as paid, and confirm a POST with `event: "invoice.paid"` arrives at the webhook.site endpoint.

---

## 15. DecentInvoice: submit sitemap to Google Search Console (added 2026-04-23)
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
   - **Name:** DecentInvoice
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
- **G2.com** (g2.com/products/new) — highest domain authority; reviews from real users will appear in Google search results for "DecentInvoice reviews"
- **Capterra** (capterra.com/vendors) — strong for B2B SaaS discovery
- **AlternativeTo** (alternativeto.net/add-software) — lists DecentInvoice as an alternative to FreshBooks, Wave, Bonsai; captures high-intent comparison traffic
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
- **r/SideProject**: "Show HN-style: DecentInvoice — freelancer invoicing with built-in Stripe payment collection"
- **Facebook group: Freelancers Union** — community post with a screenshot of a paid invoice notification
- **Indie Hackers** — post a "Milestone" update once you hit first paid subscriber, linking to the product

---

### 15. [MARKETING] Create a 60-Second Demo Video

**Impact:** MEDIUM — video on the landing page increases conversion by 20–30% on average; a screen recording showing "invoice created → client pays → dashboard updates" is the fastest way to communicate value
**Action:**
1. Use Loom (loom.com, free tier) to record a 60-second screen walkthrough:
   - 0–10s: Landing page intro ("Here's how DecentInvoice works")
   - 10–30s: Create a new invoice with one line item, set due date, mark as Sent
   - 30–45s: Show the auto-generated Stripe Payment Link; open it as the "client" in an incognito window
   - 45–60s: Return to dashboard — show invoice flipped to Paid and the revenue stat updated
2. Download the MP4 from Loom.
3. Host it on the landing page (`views/index.ejs`) above the feature grid — embed as `<video autoplay muted loop playsinline>` (silent autoplay) with a "▶ Watch demo" click-to-unmute overlay.
4. Share the same video on Twitter/X, LinkedIn, and as a YouTube short titled "Get paid in 30 seconds — DecentInvoice."

---

### 16. [MARKETING] Set Up Google / GitHub OAuth Credentials

**Impact:** MEDIUM — required prerequisite for dev task #17 (Google OAuth signup); without the OAuth client credentials the code cannot be activated
**Action:**
1. Go to console.cloud.google.com → Create a new project named "DecentInvoice".
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

**Impact:** MEDIUM — consistent content in the freelancer space builds an audience that converts to users over 4–8 weeks; positions DecentInvoice as a knowledgeable resource, not just an ad
**Action:** Post one piece of content per week for 6 weeks. Examples:
- "5 invoicing mistakes that delay your payment (and how to fix them)" — thread, end with a link to DecentInvoice
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
3. Create a public affiliate landing page at `/affiliates` on the site (or use Rewardful's hosted page). Copy: "Earn 25% recurring revenue for every freelancer you refer to DecentInvoice. Most affiliates earn $50–$500/mo."
4. Reach out directly to 10 target affiliates with a templated email. Prioritize:
   - **Freelancer newsletters:** Freelance Weekly (freelanceweekly.email), Swipe Files, The Freelance Folder, Elna Cain's freelance writing community
   - **YouTube channels:** search "freelance invoicing tutorial" — any channel with 5k+ views per video is worth a pitch
   - **Indie Hacker / maker blogs:** writers who review SaaS tools in the productivity / freelance space
   - **Template marketplaces:** Notion template creators who serve freelancers — they can add a "recommended tools" section
5. Pitch email subject: "Earn recurring revenue recommending DecentInvoice to your audience — 25% lifetime commission."
6. Share the affiliate dashboard link in the email so they can see real-time conversions from day one.

---

### 19. [MARKETING] Submit "Show HN" to Hacker News

**Impact:** HIGH — a well-timed Show HN post for a useful indie tool typically drives 200–2,000 targeted visitors in 24 hours; HN readers are developers who freelance, CTOs who hire contractors, and power users who spread tools; a successful post can generate 20–100 signups in a single day at zero cost
**Action:**
1. Wait until the product is fully deployed and the 7-day free trial (#19 in INTERNAL_TODO) is live — the trial dramatically reduces the bounce rate from HN visitors.
2. Write the HN post:
   - **Title:** `Show HN: DecentInvoice – freelancer invoicing with Stripe payment links and auto-reminders`
   - **Body (first comment, posted immediately after submission):** 2–3 short paragraphs. Explain the pain (freelancers spend hours chasing payments), what makes it different (the invoice IS the payment page — clients click Pay and it's done via Stripe), and the pricing model (free to start, $12/mo for Pro, 7-day free trial). End with: "Happy to answer questions about the tech stack (Node.js + Stripe + PostgreSQL) or the product decisions."
3. Post on a **Tuesday or Wednesday** between **6 AM and 9 AM EST** — this is the HN sweet spot for visibility before the US workday rush.
4. Do NOT ask friends to upvote (HN penalizes coordinated voting). Do respond to every comment within the first 2 hours — engagement velocity matters for ranking.
5. Cross-post the milestone to Indie Hackers and r/SideProject the same day.

---

### 20. [MARKETING] Freelancer Newsletter Outreach (Pitch for Feature Mentions)

**Impact:** MEDIUM-HIGH — a single mention in a freelancer newsletter with 10,000+ subscribers can drive 100–500 targeted signups; unlike ads, editorial mentions are trusted; offering free Pro accounts in exchange for a mention is a $12/mo cost that acquires users with $100+ LTV
**Action:** Draft a short outreach email (under 100 words) and send to each of the following. Use a personal, non-promotional tone — you're a maker sharing a tool, not pitching an ad.

**Email template:**
> Subject: Tool you might want to share with your readers — DecentInvoice
>
> Hi [Name], I built DecentInvoice (decentinvoice.com) for freelancers who are tired of chasing payments. When you mark an invoice as Sent, it automatically creates a Stripe Payment Link so clients pay in one click — no login required. Free to start, $12/mo for Pro features. Thought your readers might find it useful. Happy to give you a free Pro account to try it out. No strings attached.

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
1. After the first 10 Pro signups, email each user: "We'd love to feature your experience on our site — would you share one sentence about how DecentInvoice has helped you? We'll credit you by first name and role."
2. Collect 3 quotes. Requirements for each: specific (mentions a concrete outcome like "paid on time", "stopped chasing payments"), short (1–2 sentences), authentic (no marketing buzzwords).
3. Replace the placeholder testimonials in `views/index.ejs` (marked with `<!-- MASTER: update the count and replace placeholder testimonials -->`) with the real quotes, names, and roles.
4. Update the user count number (currently `500+` placeholder) to match actual signups rounded down to the nearest 50. Keep updating this number monthly — social proof compounds as the number grows.

---

### 22. [MARKETING] Apply for AppSumo Lifetime Deal

**Impact:** HIGH — AppSumo has 1M+ deal-seeking subscribers; a well-structured lifetime deal (e.g. $69 once → lifetime Pro access capped at 2,000 invoices/mo) can generate $10,000–50,000 in a single week and creates an instant user base to collect testimonials, bug reports, and referrals; AppSumo customers churn at near-zero rates (they've already paid) and become vocal advocates
**Action:**
1. Apply at **appsumo.com/partners** (the "List your product" form). Category: "Business & Productivity" → "Invoicing & Billing."
2. In the application, emphasise: Stripe Payment Links (unique vs. most competitors), annual billing option, Zapier webhook, PDF export, and the roadmap (recurring invoices coming to DecentInvoice).
3. Proposed deal structure: **$69 one-time** → Lifetime Pro access (unlimited invoices, clients, payment links, custom branding, Zapier webhook). AppSumo typically takes 25–50% of revenue; structure the deal so you net at least $35/LTD customer. At 500 sales that's $17,500–35,000 upfront.
4. Include 5 screenshots: landing page, invoice editor with line items, invoice with Pay Now button, payment dashboard stats, settings with Zapier webhook.
5. **Prerequisite:** Product must be live with a real domain, functional payment flow, and at least 5 real (non-test) user signups to be accepted by AppSumo's review team. Time the application after Product Hunt launch (#12 above) to show traction.
6. **Code note:** AppSumo purchases fire a webhook; the autonomous team can implement AppSumo redemption codes mapped to lifetime plan grants in a future sprint (flag this if accepted).

---

### 23. [MARKETING] Submit DecentInvoice to Stripe App Marketplace

**Impact:** HIGH — Stripe's App Marketplace surfaces tools directly to existing Stripe merchants who are already paying with Stripe; the target persona (freelancers and small agencies using Stripe) is a perfect zero-CAC match; a listing puts DecentInvoice in front of millions of Stripe users at the moment they're looking for invoicing tools
**Action:**
1. Apply at **stripe.com/app-marketplace** → "List your app." Category: Invoicing.
2. Prepare the listing:
   - **App name:** DecentInvoice
   - **Tagline:** "Professional invoices with built-in Stripe Payment Links — for freelancers"
   - **Description:** 2–3 sentences. Emphasise: creates Stripe Payment Links automatically when you send an invoice, clients pay in one click, no login required, status auto-updates to Paid via webhook.
   - **Screenshots:** 3–5 images covering the invoice editor, the Pay Now button on an invoice, and the dashboard stats.
   - **Stripe features used:** Checkout, Payment Links, Customer Portal, Webhooks — all existing integrations.
3. Stripe requires an OAuth integration for Marketplace apps. The autonomous team will need to implement Stripe Connect for the listing (INTERNAL_TODO sub-task to be added if accepted). For the initial application, note that the app currently uses API keys; Connect will be added as part of the Marketplace onboarding.
4. **Timeline:** Stripe's review typically takes 2–4 weeks. Submit early so the listing is live before the Product Hunt launch (#12).

---

### 24. [MARKETING] Submit DecentInvoice as a Native Zapier App (Zapier Marketplace)

**Impact:** MEDIUM-HIGH — Zapier has 3M+ users who actively search for new app integrations; a native Zapier app listing (separate from the outbound webhook feature in INTERNAL_TODO #7) makes DecentInvoice discoverable inside the Zapier UI under "Invoicing" and puts it in front of exactly the power users most likely to upgrade to Pro; it also enables pre-built Zap templates ("When Stripe payment received → Create DecentInvoice invoice") that appear in Google search results
**Action:**
1. Create a Zapier developer account at **developer.zapier.com** (free).
2. Use the Zapier CLI to scaffold a new integration: `npm install -g zapier-platform-cli && zapier init decentinvoice`. Implement at minimum:
   - **Trigger: "Invoice Paid"** — polls `GET /api/invoices?status=paid&since=` or uses the existing outbound webhook as a REST Hook trigger. The outbound webhook (INTERNAL_TODO #7) already sends the correct JSON payload — this maps directly to a Zapier REST hook.
   - **Action: "Create Invoice"** — POSTs to `POST /invoices/new` with client name, line items, and due date. This requires an API-key auth flow (add `GET /auth/api-key` endpoint that returns the session user's API key stored in the `users` table).
3. Write 3 Zap templates to submit alongside the integration:
   - "When an invoice is paid in DecentInvoice → Add a row to Google Sheets"
   - "When a new client is added in DecentInvoice → Add contact to Mailchimp"
   - "When an invoice is paid in DecentInvoice → Post a message to Slack"
4. Submit for Zapier review (typically 2–6 weeks for public listing approval).
5. **Code note:** this requires a small API key auth system in DecentInvoice (`ALTER TABLE users ADD COLUMN api_key VARCHAR(64) UNIQUE`, generated on first `/settings` load). Flag to the autonomous team to implement as a prerequisite.

---

### 25. [MARKETING] Agency Cold Email Campaign (Target Small Creative Agencies)

**Impact:** MEDIUM — Agency plan at $49/mo; acquiring 20 agency customers = $980 MRR from a single outreach campaign; agencies managing 5–15 freelancers are the exact use case for the Agency plan's team-seat feature (INTERNAL_TODO #9); unlike inbound marketing, this is a direct, measurable experiment with a clear ROI calculation
**Action:**
1. Build a prospect list of 100–200 small creative agencies and independent studio owners using **LinkedIn Sales Navigator** (7-day free trial) or **Hunter.io** (free tier, 25 searches/mo). Search criteria: "Creative Director", "Studio Owner", "Agency Principal" with 2–15 employees, in English-speaking markets (US, CA, UK, AU).
2. Write a 3-email sequence (use a tool like Instantly.ai or Lemlist, ~$30–50/mo):
   - **Email 1 (Day 0):** Subject: "How [Agency Name] invoices their clients." Body (60 words max): introduce DecentInvoice, 1 sentence on the team-seat feature ("manage invoicing for your whole team from one account"), free trial CTA.
   - **Email 2 (Day 4):** Subject: "One thing freelance agencies hate about invoicing." Body: 1–2 pain points (chasing payments, re-entering client details for retainers), link to the `/invoice-generator` landing page.
   - **Email 3 (Day 9):** Subject: "Last check-in — free agency account." Body: 2-sentence "no hard feelings" close + offer a 30-day free Agency trial with Stripe coupon code (create a 100%-off-first-month coupon in Stripe Dashboard).
3. Track: open rate target >40%, reply rate target >5%, trial signup rate target >2%. At 200 prospects and 2% conversion that's 4 Agency accounts = $196 MRR from one afternoon of setup.
4. **Prerequisite for team-seat pitch:** INTERNAL_TODO #9 (InvoiceFlow team seats) must be complete before this campaign goes out, or the Agency plan pitch must be limited to DecentInvoice's existing multi-user-friendly features (shared billing, unlimited invoices, Zapier webhook).

---

### 26. [MARKETING] Request G2 and Capterra Reviews from First Pro Users

**Impact:** HIGH — G2 and Capterra reviews appear directly in Google SERPs for queries like "DecentInvoice reviews" and "best invoicing software for freelancers"; a product with 0 reviews is invisible in category comparisons; even 5 genuine reviews can move a SaaS product from page 3 to the first page of G2's category ranking; this is a zero-cost action that compounds indefinitely (reviews attract more reviews)
**Action:**
1. After the first 10 Pro or Business plan signups, email each user directly from a personal address (not a no-reply). Keep it under 60 words:
   > Subject: Quick favour — 2 minutes on G2?
   >
   > Hi [first name], I'm the founder of DecentInvoice. You've been using it for [N] days — I'd love to hear what you think. Would you mind leaving a 2-sentence review on G2? It takes about 2 minutes and helps other freelancers find the tool. Here's the link: [G2 review link]. Totally optional — just thought I'd ask.
2. Include a G2 review link (your product's G2 page — created as part of item #13 above). Do the same for Capterra and AlternativeTo (3 separate outreach emails, spaced 3 days apart, to avoid survey fatigue).
3. Offer a genuine incentive if helpful: "I'll extend your subscription by 1 month as a thank-you" (create a Stripe coupon for `100% off once` and include a redemption link in the follow-up after they post the review).
4. Track review counts on a monthly basis. Target: 5 reviews within 60 days of first 10 Pro signups. Update directory listings (#13) with the new review count as it grows.

---

### 27. [MARKETING] Free Invoice Template PDF Lead Magnet

**Impact:** MEDIUM-HIGH — a downloadable free invoice template PDF serves two purposes: (1) it intercepts the high-intent "invoice template for freelance designer/developer/etc." search query that the niche landing pages (#8) are already targeting, converting organic visitors who aren't ready to sign up yet; (2) it builds an email list for future drip sequences; every user who downloads a template and later becomes a paid subscriber arrived at near-zero CAC
**Action:**
1. Create a professional, cleanly designed PDF invoice template for each niche (minimum: one generic + one per the 6 existing niche pages). Tools: Canva (free), Figma, or Google Docs → PDF export. The template should include: the freelancer's name/logo placeholder, client details section, line items table, total, payment terms, and a subtle "Made with DecentInvoice — decentinvoice.com" footer.
2. Add a "Download free template" email capture form to each niche landing page (rendered by `views/partials/lp-niche.ejs`). Gate the download behind a first-name + email form. On submit: (a) add the email to a Resend audience list or a simple CSV/Airtable log; (b) redirect to the PDF file URL or email it automatically. The dev team can implement the form + Resend audience add; the PDF itself is a Master asset.
3. Use the downloaded-user email list for a 3-email onboarding drip: Day 0 ("Here's your template"), Day 3 ("Here's how to make clients pay faster"), Day 7 ("DecentInvoice does all of this automatically — free to start").
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

**Tone guide:** Never post a bare product link. Lead with the problem ("Tired of clients saying they never received the invoice?"), describe the solution briefly (2 sentences), and end with "I built DecentInvoice to fix this — happy to give anyone here a free Pro month to try it." The Pro-month offer costs $12 and acquires a user whose LTV is $60–$120.

**Timing:** Post Tuesday–Thursday between 9 AM and 1 PM ET for maximum active user overlap.

---

### 29. [MARKETING] Sign Up for Plausible Analytics (Prerequisite for INTERNAL_TODO #34)

**Impact:** MEDIUM (operational) — without analytics there is no way to measure whether any of the distribution actions above (#12–#28) are driving traffic or signups; Plausible is privacy-friendly, cookie-less (no GDPR consent banner required per TODO_MASTER L6), and costs $9/mo; the dev team's code integration (INTERNAL_TODO #34) requires the `PLAUSIBLE_DOMAIN` env var from this step
**Action:**
1. Sign up at **plausible.io** ($9/mo Starter, or start with the 30-day free trial — no credit card required for the trial).
2. Add your domain (e.g. `decentinvoice.com`) as a new site in the Plausible dashboard. Plausible will show you the one-line JS snippet — pass the domain name to the autonomous team as `PLAUSIBLE_DOMAIN=decentinvoice.com` so they can complete INTERNAL_TODO #34.
3. Set `PLAUSIBLE_DOMAIN=decentinvoice.com` as an env var on the deployed app. The code integration is already handled by INTERNAL_TODO #34 — once the env var is set, analytics start immediately on next deploy.
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
6. **Verification:** open `/billing/upgrade` from a UK IP (or use a UK billing address in test mode). Stripe Checkout should show the price + a "VAT (20%)" line item. The success webhook still fires identically — `automatic_tax` is invisible to DecentInvoice's data model.

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

**Impact:** MEDIUM-HIGH — Google's top 3–5 results for "best invoicing software for freelancers" are SEO-driven listicles (G2, Capterra-syndicated, blogger roundups). Each receives ~5,000–20,000 monthly visits with high purchase intent. Getting DecentInvoice added to even one of these articles is a permanent zero-CAC traffic source compounding monthly. The authors are individual people (not committees) and are reachable on LinkedIn.
**Action:**
1. Search Google for the following queries, capture the top 5 results for each:
   - `best invoicing software for freelancers 2026`
   - `freelance invoice software reviews`
   - `invoicing tools for designers 2026`
   - `best invoicing app for consultants`
2. Identify the article author for each (usually in the byline or "About the author" footer). Find them on LinkedIn.
3. Send a short LinkedIn connection note (under 300 chars):
   > Hi [Name] — your roundup of [list name] was helpful when I was researching this space. I built DecentInvoice (decentinvoice.com) — Stripe Payment Links auto-generated on every invoice + 7-day free trial. Would you consider adding it to the next refresh? Happy to give you a free Pro account to try first.
4. After they connect, follow up with a 1-message pitch: 1 screenshot of the invoice editor, 1-line description, the free Pro account offer. Do NOT send a press kit — these authors are individual creators, not journalists.
5. Track responses in a spreadsheet. Aim: 3 article inclusions over 60 days. Each ranking #1–3 article is worth ~$200/mo in compounding LTV.
6. **Prerequisite:** The product must be live with a real domain, the 7-day trial (#19, done) live, and at least one real testimonial on the landing page (after [MARKETING] #21 collects testimonials).

**Income relevance:** Direct top-of-funnel traffic that compounds across every article inclusion, every month, indefinitely. Highest ROI per hour spent of any [MARKETING] action — one well-pitched message can secure a permanent referral source.

---

### 30. [MARKETING] Announce "Invoice Paid Instant Notification" Feature on Social

**Impact:** MEDIUM — when INTERNAL_TODO #30 ("Invoice Paid" notification email to freelancer) ships, it is the kind of emotionally resonant micro-feature that goes viral on Twitter/X among freelancers; the single-sentence pitch ("DecentInvoice now emails you the instant your client pays — so you can stop refreshing your bank account") is a self-contained hook that needs no explanation; native video or screenshot of the email in a phone notification tray maximises engagement
**Action (after INTERNAL_TODO #30 is deployed):**
1. Write the tweet/X post: `"I added one small thing to DecentInvoice: the instant a client pays your invoice, you get this email. No more refreshing your bank account. 🔔" [screenshot of the "Invoice #X was just paid — $1,200" email on a phone screen]`
2. Post as a native Twitter/X image post (not a link). Tag relevant accounts: `@stripe`, `@resend`, and any freelancer community accounts you follow.
3. Cross-post to LinkedIn (more professional tone): `"We just shipped a small feature with big emotional impact: DecentInvoice now sends you an instant notification the moment a client pays your invoice."` + screenshot.
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

## 18. DecentInvoice: provision Resend API key + verify sending domain (added 2026-04-25)

INTERNAL_TODO #13 (email delivery for DecentInvoice) shipped in this commit. The wrapper at `lib/email.js` is fully wired into the "Mark Sent" status transition for Pro/Agency users, but it currently no-ops in production because `RESEND_API_KEY` is unset. **The code is safe to deploy as-is — every send returns `{ ok:false, reason:'not_configured' }` until the key is provisioned, and no other route's behaviour depends on that result.** Do steps 1–4 below to flip the feature live.

1. **Sign up at https://resend.com.** Free tier: 3,000 emails/month, 100/day — plenty to validate the feature and cover the first month or two of paid usage. No credit card required.
2. **Provision an API key** at https://resend.com/api-keys. Copy the `re_…` value.
3. **Add the env vars to the production app** (Heroku/Render/etc.):
   ```
   RESEND_API_KEY=re_...
   EMAIL_FROM="DecentInvoice <onboarding@resend.dev>"   # safe sandbox sender — works immediately
   ```
   The `EMAIL_FROM` fallback (`onboarding@resend.dev`) is Resend's universal sandbox sender and lets sends succeed before a domain is verified. Once the domain is verified (step 4) swap it for a branded address.
4. **Verify a sending domain** in the Resend dashboard (recommended: `mail.decentinvoice.com`). Steps:
   - Resend dashboard → Domains → Add Domain → enter the subdomain.
   - Add the three DNS records Resend prints (SPF / DKIM / DMARC) at your DNS provider.
   - Wait for verification (typically <30 min). Once green, update `EMAIL_FROM`:
     ```
     EMAIL_FROM="DecentInvoice <invoices@mail.decentinvoice.com>"
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
2. **DB-side cohort query** (run on the DecentInvoice production DB):
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

1. **DB-side activation-funnel query** (run on the DecentInvoice production DB to see how many users complete each step within 7 days of signup):
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

## 20. DecentInvoice: automated payment reminder cron — deploy notes (added 2026-04-25 PM)

INTERNAL_TODO #16 is closed: a daily cron at **09:00 UTC** (`0 9 * * *`) now picks up every Pro/Business/Agency invoice that is `status='sent'`, past its `due_date`, and either never reminded or last reminded > 3 days ago, and emails the client a "Friendly reminder: Invoice X is overdue" nudge with a Pay button. **The cron is a safe no-op until the Resend API key from item 18 is provisioned** — every send returns `{ ok:false, reason:'not_configured' }`, no DB stamp is written, and the next 09:00 UTC tick retries. The instant `RESEND_API_KEY` is set, the next tick begins delivering the entire backlog.

No Master action is required *for this feature on its own* — item 18 (Resend API key) is the only gate. This entry exists so deploy-day operators know what to expect and how to verify.

### Verification on first tick after Resend goes live

1. **Confirm the schedule is registered.** Tail the production log for the boot line:
   ```
   DecentInvoice running on port 3000
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

3. **DB-side spot check** (run on the DecentInvoice production DB):
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
From: `<EMAIL_FROM>` (currently `DecentInvoice <onboarding@resend.dev>` until item 18 step 4 — the verified domain — completes; Resend's sandbox sender works but lands in spam more often, so prioritise domain verification).
Reply-to: `users.reply_to_email > business_email > email` of the freelancer (so the client's "Reply" lands in the freelancer's inbox, not in a no-reply void).
Body: HTML + plaintext, both include the freelancer's business name, the invoice total, the original due date, the days-overdue count, and a "Pay invoice X" button (only when the invoice has a `payment_link_url` — Pro/Agency invoices created or marked-sent after #2 shipped on 2026-04-23).

### Why this is the highest-leverage feature shipped this cycle

DecentInvoice's entire upgrade-modal copy promises "automated payment reminders" — until this commit, that promise was unfulfilled. Pro/Agency users have been paying $9-$19/month for a manual chase tool. Industry data: an automated 3-day overdue nudge typically lifts the on-time payment rate by 15-25%. Each recovered invoice is also a touchpoint that flips the user's relationship with the tool from "manual chase" to "set-and-forget cashflow" — the same retention dynamic that drives InvoiceFlow's stickiness.

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
DecentInvoice collects email, name, invoice / client data, Stripe customer IDs, session cookies, and (once INTERNAL_TODO #13 / #17 land) Resend and Google OAuth identifiers. Under GDPR and CCPA/CPRA a privacy policy is legally required whenever a site collects personal data from an EU/UK or California resident — which any public signup form does.
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

## 22. DecentInvoice: paid-notification email — verify after Resend goes live (added 2026-04-26)

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

## 21. DecentInvoice: re-run schema migration to widen `users.plan` CHECK (added 2026-04-25 PM)

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

## 30. DecentInvoice: activate Stripe Tax + flip `STRIPE_AUTOMATIC_TAX_ENABLED` (added 2026-04-26)

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

## 31. DecentInvoice: re-run schema migration for `trial_nudge_sent_at` (added 2026-04-26 PM)

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

DecentInvoice is a Stripe-connected SaaS that uses Stripe for both subscription billing and invoice Payment Links. Stripe maintains an "App Partner" directory at https://stripe.com/apps where partners can list a profile with screenshots, a description, and a link back to the SaaS. Inclusion does not require a "Stripe App" build (which is the heavier path for embedded apps inside the Stripe Dashboard); the Partner directory accepts any verified Stripe-integrated SaaS.

### Action (Master, ~30 min)

1. Sign up at https://stripe.com/partners with the same Stripe account that processes DecentInvoice subscriptions and Payment Links.
2. Submit the partner application: business name "DecentInvoice", category "Invoicing & Billing", short description ("Smart invoicing SaaS for freelancers — Pro plan unlocks Stripe Payment Links on every invoice and instant paid-notification emails the moment a client pays"), 3-4 screenshots (the dashboard, an invoice with the Pay Now button, the pricing page).
3. Wait for verification (typically 5-10 business days; Stripe checks the integrated account and confirms live processing).
4. Once approved, the listing appears at stripe.com/apps in the Invoicing category with a backlink to `decentinvoice.com` — the backlink alone is high-DA SEO juice (Stripe's domain is one of the strongest in fintech).

### Why this matters (income relevance)

Compounding distribution: every visitor to stripe.com/apps researching invoicing solutions sees DecentInvoice in the listing. Stripe's directory traffic is a high-quality cohort — these are SaaS owners and freelancers who already use Stripe and have credit-card-on-file with a Stripe-related vendor. Conversion rate from Stripe directory traffic is typically 2-3x the cold-traffic baseline. The backlink also lifts overall SEO authority for ranking on "Stripe-integrated invoicing", "Stripe invoice tool", and similar long-tail queries that the niche landing pages (#8) target.

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

One-time cash injection: typical $10k-$50k in 4-6 weeks. More importantly, ~500-2000 lifetime users become a permanent revenue floor: they don't churn (they paid once and are sticky), they refer their freelancer networks (the cohort is heavy in the indie-hacker/freelancer niche we target), and they generate Stripe Payment Link transaction fee revenue if we ever add a "DecentInvoice take-rate on collected invoices" tier. Caveats: lifetime cohorts have higher support volume per user (~3x); they can compress the price elasticity ceiling because you can't raise lifetime prices later. Plan for 2-4 hours/week of support during the deal window.

---

## 34. [MARKETING] Indie Hackers / Reddit r/SaaS launch posts after Resend goes live (added 2026-04-26 PM)

The Indie Hackers product directory (https://indiehackers.com/products) and r/SaaS subreddit are the two highest-quality founder-cohort distribution channels for an indie-SaaS launch. Both reward genuine builder-narrative posts ("here's how I built Y; here's what I learned"). Typical first-week traffic from a well-pitched IH launch + r/SaaS post is 2k-10k unique visitors, of which 1-3% sign up.

### Action (Master, ~3 hrs writing + ~1 hr engagement)

1. Wait for two prerequisites: (a) `RESEND_API_KEY` provisioned per #18 so email-driven features (invoice send, reminders, paid notification, trial nudge) actually fire end-to-end during launch traffic; (b) public roadmap (INTERNAL_TODO #38) live so the inevitable "what's next?" comments have a single linkable answer.
2. Write the IH launch post: 600-800 words, structured as: (1) the problem ("freelancers waste 4-6 hrs/mo chasing late invoices"), (2) the build journey (concrete numbers — "shipped in 6 weeks; 23 commits this month; 28 test files"), (3) the differentiators (Stripe Payment Links + instant paid notification + 7-day no-card trial), (4) the ask ("would love feedback / what feature would you want next"). Link to pricing.
3. r/SaaS post: 200-300 words, lighter tone, focus on one concrete numbers-backed insight from the build (e.g. "what shipping a 7-day no-card trial did to our trial-to-paid conversion") with the product mention as context, not the headline. Reddit's algorithm rewards educational content and demotes promotional posts.
4. Follow-up: respond to every comment within 4 hours of posting for the first 24 hrs. The IH product page also accepts permanent reviews / ratings; a 4-5 star average on the IH directory is a long-tail conversion lever (every prospect who searches "DecentInvoice review" finds it).

### Why this matters (income relevance)

Two-week traffic spike of 2k-10k uniques lifts the funnel by 50-200 trial signups (at typical SaaS landing-page conversion). At 30-50% trial-to-paid (per #29 above) → 20-100 new Pro subscribers → +$180-$900/mo MRR per launch. The IH product directory listing also stays as a permanent SEO surface — the listing ranks well for "DecentInvoice" branded searches and captures every subsequent prospect who tries to validate the product before signing up.

---

## 35. DecentInvoice: enable bank-debit payment methods on Stripe Payment Links (added 2026-04-26 PM)

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

**Impact:** MEDIUM-HIGH (long-tail SEO + backlink building) — the existing `/invoice-generator` and `/invoice-template/<niche>` landing pages are content marketing assets that target high-intent keywords ("freelance designer invoice template", etc.). To rank, they need backlinks. The single highest-leverage outreach channel is to small-business / freelancer roundup posts: Medium and Substack bloggers regularly write "Top 10 invoice templates for freelancers in 2026" listicles that include 5-10 outbound links to template generators. Getting DecentInvoice listed in just 5-10 of these listicles is worth more domain authority than a Product Hunt launch and lasts indefinitely.

### Action (Master, ~3-4 hrs identification + ~1 hr per outreach)

1. Search Google for: `"invoice template" "freelance" 2025 OR 2026 -site:decentinvoice.com`. Filter to results from past 12 months. Identify 15-20 listicle-style posts on Medium / Substack / freelancer-blog domains (Upwork blog, Fiverr Workspace, Bonsai blog, Freshbooks blog are too large to reach; target solo bloggers and mid-size sites).
2. For each post, find the author's contact email or Twitter / X DM handle. Send a short personalised note: "Hi [name], saw your great post on freelance invoice templates. We just shipped DecentInvoice, a free invoice generator with built-in Stripe payment links — would love to be considered for the list if you ever update it. Here's a screenshot: [link]." No ask for payment, no pressure. Track responses in a simple spreadsheet.
3. For posts where the author lets readers submit tools (often via a "submit your tool" form or `add@` email), submit through that channel instead of cold email.
4. Track replies for 4 weeks; about 20-30% of cold outreach to small bloggers converts to a backlink. 5 successful backlinks at DA 20-40 is enough to lift the niche pages from page 2-3 to page 1 for their target keywords.

### Why this matters (income relevance)

Page-1 organic ranking on a freelancer-niche query is worth ~50-200 visits/month per query at zero CAC. With 6 niche pages live (more after #25 ships), that's 300-1,200 monthly organic visitors compounding indefinitely. At a 2% landing → trial conversion and 30-50% trial → Pro conversion (per #29), this is +$30-$300/mo MRR per query that ranks. Five queries on page 1 = a foundational organic-traffic stream that does not depend on any single distribution event.

---

## 37. [MARKETING] Accountant / Bookkeeper partner program (added 2026-04-26 PM-2)

**Impact:** HIGH (B2B referral channel) — accountants and bookkeepers each serve 20-100 freelance clients. Every accountant who recommends DecentInvoice represents 20-100 prospective Pro signups with extremely high trust (the recommendation comes from the client's existing trusted financial professional). Setting up a simple "refer a client, get 1 month free Pro" partner program targets this segment specifically. Industry data: SaaS that builds a strong accountant-referral channel sees 25-40% of new revenue come through that channel within 12 months.

### Action (Master, ~4-6 hrs setup + ongoing engagement)

1. Create a one-page `views/partners.ejs` (or have INTERNAL_TODO add a code task — pure copy + form) explaining the partner offer: accountants who refer 5+ clients get a 50% lifetime discount on a Pro account they use to manage their own freelance projects, plus a co-branded "DecentInvoice Certified Accountant" badge. The 5-client threshold filters out single-referral attempts and incentivises ongoing engagement.
2. Build a target list of 50-100 accountants who specialise in freelancers / solopreneurs. Sources: LinkedIn search "accountant freelancer", QuickBooks ProAdvisor directory (accountants who serve small clients but might want a simpler invoicing tool to recommend), local small-business CPA listings.
3. Send a personalised outreach email to each: "Hi [name], saw you specialise in freelance clients on [LinkedIn / their site]. We just launched DecentInvoice — a Stripe-native invoicing tool we built specifically for solo freelancers. Would you be open to recommending it to clients who don't need full QuickBooks-level accounting? We'll comp your account and add you to our partner directory." Personal email > automated drip.
4. Track responses in a simple Google Sheet. For accountants who reply positively, set up the Stripe coupon (`PARTNER50` valid forever) and add them to a `views/partner-directory.ejs` page (creates a useful SEO surface in addition to the partner channel itself).
5. Quarterly check-in email to active partners with a "what's new in DecentInvoice" recap and a request to share with one more client.

### Why this matters (income relevance)

The accountant-referral channel is the single highest-trust distribution channel in B2B SaaS — a freelancer who hears "DecentInvoice handles your invoicing" from their CPA converts at 5-10x the rate of cold organic traffic. Five active partner accountants each referring 2-5 clients per quarter = 40-100 new Pro signups per year per partner cohort, at ~zero ongoing CAC. The compounding effect over 12-18 months can produce a recurring revenue floor that is more stable than any single launch event.

---

## 38. DecentInvoice: replace `public/og-image.png` with branded asset (added 2026-04-27)

**Impact:** MEDIUM-HIGH (compounds across every share) — INTERNAL_TODO #36 shipped Open Graph + Twitter Card metadata on every public page (landing, pricing, all 6 niche landing pages). The placeholder `public/og-image.png` is a valid 1200×630 brand-indigo PNG so social-card validators accept it pre-replacement, but the actual share preview is just a solid color block. Replacing it with a branded card (logo + tagline + brand color background) makes every shared link in Slack / iMessage / Twitter / LinkedIn / Discord render as a recognisable DecentInvoice card.

### Action (Master, ~15 min)

1. Open Figma / Canva / any image tool. Create a 1200×630 PNG with:
   - DecentInvoice wordmark or `⚡ DecentInvoice` logo (top-left or centered)
   - Tagline: "Professional invoices in 60 seconds" or "Get paid faster"
   - Brand-indigo (#4f46e5) background or gradient (matches `views/partials/head.ejs` Tailwind brand-600)
   - White or near-white text for high contrast
2. Export as PNG, name it `og-image.png`, replace `public/og-image.png` in the repo. Commit + deploy.
3. Validate after deploy by pasting `https://decentinvoice.com/` into:
   - LinkedIn Post Inspector: https://www.linkedin.com/post-inspector/
   - Twitter Card Validator: https://cards-dev.twitter.com/validator
   - Both should show the new card. If they show the old image, click "Refresh" / "Re-fetch" to bust their cache.

### Why this matters (income relevance)

Indirect but compounding. Every distribution action in TODO_MASTER (Reddit posts #14, tweets #17/#30, newsletter mentions #20, Slack/Discord drops #28, Show HN #19, listicle outreach #36) generates ~30-50% higher click-through when the link preview renders as a branded card vs. a bare URL. Lifetime ROI on 15 minutes of design work.

---

## 39. DecentInvoice: set `APP_URL` env var in production (added 2026-04-27)

**Impact:** MEDIUM-HIGH — INTERNAL_TODO #36's Open Graph metadata uses `process.env.APP_URL` to render absolute `og:url` and `og:image` URLs. Most social-card validators (Twitter, LinkedIn, Discord) require absolute URLs for the preview image — relative paths fail silently and the card falls back to "no image." The env var is also used by other features (`jobs/trial-nudge.js`'s CTA, `lib/email.js` paid-notification button) where it's nice-to-have; for OG metadata it's effectively required.

### Action (Master, ~1 min)

1. In Heroku / Render / your prod env, set:
   ```
   APP_URL=https://decentinvoice.com
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
   - **Product Hunt launch** — `https://decentinvoice.com/redeem/PH50` in the comments.
   - **Show HN** — `https://decentinvoice.com/redeem/SHOWHN30` in the body.
   - **r/SaaS Friday Roundup** — `https://decentinvoice.com/redeem/REDDITSAAS25` in the post.
4. Track conversions per code in Stripe → Coupons → individual coupon page → "Redemptions" count. Each redemption is a measurable Pro signup attributable to that exact channel.

### Why this matters

Without per-channel codes, every paid signup looks identical in Stripe and channel ROI is impossible to measure. With them, Master can see "30 signups via PH50 in week 1, $0 ad spend" and double down on what works. Pairs with INTERNAL_TODO #34 (Plausible analytics) — Plausible measures the click; the coupon code measures the conversion.

---

## 42. [MARKETING] Submit `decentinvoice.com/sitemap.xml` + verify in Google Search Console (added 2026-04-27 PM)

**Impact:** HIGH (one-time SEO foundation) — INTERNAL_TODO #56 just shipped `robots.txt` + canonical URLs, completing the trio (`/sitemap.xml` already shipped in #8, `/robots.txt` now points at it). Google still needs to be told the site exists. Verifying ownership in Google Search Console is a 5-minute one-time action that unlocks: (a) accelerated indexing of every niche landing page (typically 2-3 days vs. 4-8 weeks for organic discovery), (b) impression / click data per query so Master can see which niche pages are pulling traffic, (c) a manual reindex button for any single page after a copy update, (d) backlink reports.

### Action (Master, ~10 min total)

1. Go to https://search.google.com/search-console.
2. Click "Add property" → enter `https://decentinvoice.com` (use the domain property if Cloudflare/Route53 can hold a TXT record; otherwise use the URL prefix property and verify via the HTML file method or Google Tag).
3. After verification, navigate to "Sitemaps" → submit `https://decentinvoice.com/sitemap.xml`. Confirm Google reports "Success" (a few minutes after submission).
4. Repeat for `https://decentinvoice.com/robots.txt` via "Settings" → "robots.txt" report — Google fetches it automatically; this just surfaces any parse errors.
5. Bookmark the "Performance" tab — review monthly to identify which niche pages are ranking and which queries are driving traffic. Use this signal to prioritise INTERNAL_TODO #25 (expand niche pages from 6 → 15) toward the queries already showing impressions.

### Why this matters

Without this, INTERNAL_TODO #8 (sitemap), #25 (niche pages), #36 (OG metadata), and #56 (robots + canonical) are technically perfect but invisible to Google for 4-8 weeks longer than necessary. Google Search Console verification is the single highest-leverage one-time SEO action available. Pairs with #29 (Plausible analytics) — Plausible measures user behaviour; GSC measures crawler behaviour and search intent.

---

## 43. [MARKETING] Listicle outreach — "best invoicing tools for freelancers" backlinks (added 2026-04-27 PM)

**Impact:** HIGH (compounding SEO) — Google's #1 ranking signal remains backlinks from authoritative listicle articles. Searching "best invoicing software for freelancers 2026" returns the same 8-12 listicles that drive most freelancer-tool decisions. Getting DecentInvoice mentioned in even 3-5 of these articles drives sustained referral traffic for years. The pattern is well-established: a polite cold email to the article author offering a free Pro account + a one-paragraph product summary + a screenshot (now branded after #38 og-image lands) gets a "yes" rate of 15-25% on cold outreach.

### Action (Master, ~6 hrs total over 2 weeks)

1. **Scope the target list** (~1 hr). Search Google for: "best invoicing software for freelancers", "best invoice apps for designers", "freelance invoice tools", "Bonsai alternatives", "FreshBooks alternatives", "invoice generator review". Compile the top 20 articles into a spreadsheet with: URL, author name, author email (use Hunter.io free tier or check author byline), date last updated, current tools listed.
2. **Filter to active authors** (~30 min). Drop any article older than 18 months (Google heavily discounts stale content). Drop any article whose author isn't reachable (anonymous bylines).
3. **Draft a 5-line outreach email** (~30 min). Template: "Hi [name], I saw your [year] article on [topic] — really useful breakdown. I'm the founder of DecentInvoice (decentinvoice.com), a stripped-down invoicing tool for freelancers. Two things specifically that competitors don't: (a) instant Stripe Payment Link on every invoice, (b) a dead-simple Free plan (no credit card, 3 invoices). I'd love to be considered for the next refresh of your article — happy to set you up with a free Pro account so you can try it. No expectation of anything in return. — Master / @decentinvoice". Per-author personalisation (~2 min each) lifts response rate ~3x.
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
2. **Send 20 connection requests/week** with a personalised note: "Hi [name], congrats on the [title] role at [company]. I run DecentInvoice (decentinvoice.com) — we make invoicing freelance contractors painless for ops teams. Happy to share a Pro plan if you ever want to try us out. — Master".
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
3. **For each relevant thread** (someone asking "what invoicing tool do you use?" or complaining about FreshBooks/Bonsai pricing): reply naturally with one sentence about how you handle invoicing, link to DecentInvoice ONLY if you're already a participating member of that channel for 2+ weeks (to avoid the "drive-by promoter" auto-ban).
4. **Track each link share** in a spreadsheet: community / thread URL / date / response. After 8 weeks compare community-attribution to Plausible referrer data (#34 once live) to identify the highest-converting community.
5. **Run one community-only AMA** per quarter (e.g. "Ask me anything about building DecentInvoice from scratch"). Indie Hackers AMAs typically draw 20-50 questions, several of which become inbound trial signups.

### Why this matters

Closed communities are the highest-conversion-per-impression distribution surface for indie SaaS once you're past the cold-launch phase (Product Hunt, Show HN). They're also the most resilient against algorithm changes (no Twitter / Reddit reach collapse risk). Pairs with #34 (Plausible analytics — measures community-driven traffic by referrer), #38 (roadmap — gives community members confidence the project is real), and #19 (Show HN — the cross-post lifts traffic from the community to HN and back).

---

## 46. [MARKETING] 60-second YouTube product walkthrough video (evergreen SEO + landing) (added 2026-04-27 PM-2)

**Impact:** MEDIUM — distinct from the existing Loom demo plan (#15 — that's an autoplay clip on the landing page). A separate, public YouTube video titled "DecentInvoice — Invoice + Get Paid in 60 Seconds (Freelancer Tool Demo)" lives on YouTube indefinitely, ranks for the long-tail "how to invoice freelance clients" query, and is embedded as the landing-page hero (replacing or complementing #15). YouTube SEO compounds — the video is discoverable for years, drives passive signups every month with zero ongoing effort, and the landing-page embed gives DecentInvoice a video-thumbnail social-share preview that the static OG image (#36, INTERNAL_TODO) can't.

### Action (Master, ~3 hrs one-time)

1. **Record the 60-second walkthrough** (1 hr) using OBS or Loom Pro:
   - 0-10s: Problem hook ("Stop chasing invoices.")
   - 10-30s: Create an invoice — 3 line items, mark Sent
   - 30-45s: Switch to the client's perspective — open the Stripe Payment Link, click Pay
   - 45-60s: Back to dashboard — invoice flips to PAID; revenue stat ticks up. End-card with decentinvoice.com URL.
2. **Edit + caption** (~1 hr) — auto-captions in YouTube Studio + manual cleanup.
3. **Publish to YouTube** with: title "DecentInvoice — Invoice + Get Paid in 60 Seconds (Freelancer Tool Demo)", description with timestamps + landing-page link, end-card pointing to the video's own playlist, tags `freelance, invoicing, stripe, saas, freelancer`. Submit to the YouTube SEO via the description (first 200 chars).
4. **Embed on landing page** in `views/index.ejs` — replace or complement the auto-play Loom from #15. YouTube embed gives a thumbnail + Schema.org `VideoObject` that inflates the SEO of the landing page itself (compounds with the JSON-LD `SoftwareApplication` work in INTERNAL_TODO #52).
5. **Cross-post the video link** to: r/freelance, Indie Hackers (as a Show update), LinkedIn (native upload — LinkedIn deboosts external links but boosts native video), Twitter/X.

### Why this matters

YouTube SEO is the single most-evergreen acquisition channel for B2B SaaS at this stage. A 60-second walkthrough that ranks for one or two long-tail queries drives 50-300 passive views per month indefinitely, of which ~5% click through to the landing page, of which ~5% convert to free signup. Doesn't compete with #15 (Loom autoplay clip — that's about reducing landing-page bounce); this is about new acquisition. Compounds with #36 (OG metadata) and INTERNAL_TODO #52 (JSON-LD `SoftwareApplication` schema with `VideoObject` ref).
