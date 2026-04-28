# QuickInvoice — Epics

> Strategic feature endeavors. Each Epic groups related INTERNAL_TODO tasks under a shared goal. No more than 3 [ACTIVE] at any time. Status: [ACTIVE] in flight · [PLANNED] queued · [COMPLETE] all child tasks done · [PAUSED] deferred.

---

## E1 — Stripe Payments & Subscription Lifecycle  [COMPLETE]

**Goal:** Make every transactional surface — first checkout, renewal, dunning, cancel-and-recover — feel inevitable. The subscription lifecycle is the single revenue loop; every leak here scales linearly with traffic.

**Outcome:** Free→Pro conversion at the 3-invoice wall; monthly + annual prices wired; Customer Portal link; Stripe webhook syncs subscription_status; Stripe Payment Links per invoice; outbound webhook on paid; trial-end card-add flow.

**Child tasks:** #1, #2, #3, #30, #31, #41, #45, #91, #92, #95 (all DONE).

**Income impact:** HIGH — built and earning. Future increments live under E5 (expansion/upsell).

---

## E2 — Trial → Paid Conversion Surfaces  [ACTIVE]

**Goal:** Every authed surface during the 7-day trial should reinforce "the trial ends in N days, here's what you'd lose, here's the one-click path to keep it." Compress the gap between trial-start and card-add.

**Outcome shipped so far:** trial-countdown nav pill (#106) + last-day urgency banner (#45) + dashboard onboarding cards + trial-nudge cron emails. Free-plan invoice progress bar (#31) + plan-comparison table candidates queue.

**Child tasks (open):** #82 (plan comparison table on dashboard for free users), #44 ("✨ What's new" widget), #119 (nav-bar pulse-dot for what's new), #95 (paid-invoice tab-flash retention surface), #15 (contextual Pro upsell prompts on locked features), #46 (pricing-page exit-intent modal), #47 (monthly→annual upgrade prompt), #109 (mobile FAB for new invoice).

**Income impact:** HIGH — direct conversion lever; every fix here moves the trial→paid percentage. Trial-cohort conversion at industry-typical 4-8% is the difference between $0 and $700+ MRR per 100 trial signups.

---

## E3 — Activation & Time-to-First-Value  [ACTIVE]

**Goal:** A new user's first session ends with a sent invoice, not "I'll come back tomorrow". Every minute between signup and first-sent-invoice is an exponential drop in conversion-to-paid.

**Outcome shipped so far:** onboarding step list on empty dashboard, share-intent buttons (#92), copy-pay-link affordances, recent-clients dropdown to skip retyping, invoice-limit progress bar, last-30-day revenue card (#107).

**Child tasks (open):** #39 (first-invoice seed template on signup), #65 (save invoice as template + gallery), #84 (auto-generate plain-language email body), #96 ("send a copy to me too" checkbox), #102 (per-user timezone), #111 ("show client preview" pre-send modal), #116 (empty-state demo accordion), #60 (demo-mode at /demo), #117 (7d/30d/90d window toggle), #118 (Stripe receipt URL on paid invoice).

**Income impact:** HIGH — activation gates everything else. Every percentage point of activation lift compounds with conversion (E2) and retention (E4).

---

## E4 — Retention, Stickiness & Daily Touchpoints  [ACTIVE]

**Goal:** Make Pro a daily habit, not a tool you remember when an invoice is due. The more touchpoints per week, the lower the churn rate.

**Outcome shipped so far:** Slack/Discord webhook on paid (#75), share-intent buttons (#92), recent-clients dropdown, recent-revenue card, paid-notification email (#30).

**Child tasks (open):** #80 (weekly Monday-AM email digest), #88 (frequent non-payer alert), #87 (Stripe payout reconciliation widget), #57 (NPS micro-survey), #89 (vacation mode), #11 (churn win-back sequence — Resend-blocked), #12 (monthly revenue summary email — Resend-blocked), #77 (welcome-back email when past_due Pro restores card), #90 (60+ day inactive free re-engagement), #121 (dashboard streak gamification), #44 (in-app what's-new widget), #66 (auto-CC accountant), #71 (auto-BCC freelancer).

**Income impact:** HIGH — retention is the multiplier on lifetime value; reducing monthly churn from 8% to 4% doubles LTV.

---

## E5 — Expansion: Tiers, Add-Ons & Upsells  [PLANNED]

**Goal:** Capture more revenue per active user. Today's plan ladder caps at $49/mo Agency; expansion lever is unlocking higher-ARPU patterns (annual prepay, team seats, Business tier, upgrade prompts on locked features).

**Child tasks (open):** #9 (Agency team seats — gated on H5 plan-CHECK widening), #10 (Business tier @ $29/mo — gated on Master creating Stripe price), #15 (contextual Pro upsell prompts), #47 (monthly→annual upgrade prompt), #74 (Pro PDF logo upload — match what /pricing already advertises), #54 (deposit / partial-payment invoices — Pro), #67 (tip-on-pay toggle — Pro), #100 (Stripe Climate / charity round-up — Pro), #79 (BNPL — Klarna/Afterpay/Affirm).

**Income impact:** HIGH — direct ARPU lift once trial→paid loop is saturated.

---

## E6 — Distribution & Acquisition (SEO + Virality)  [PLANNED]

**Goal:** Sustainable user acquisition without paid ads. SEO long-tail (niche pages, vs-pages, free tools), passive distribution (Calendly-style footers, public links), and word-of-mouth attribution.

**Outcome shipped so far:** OG/Twitter Card metadata (#36), robots.txt + canonical link tags + sitemap.xml (#56), 6 niche landing pages, friendly 404 page.

**Child tasks (open):** #25 (expand niches 6→15), #85 (URL-params dynamic hero copy), #86 (vs-pages: /vs/freshbooks etc), #103 (free tool /tools/late-fee-calculator), #52 (JSON-LD SoftwareApplication schema), #20 (social proof testimonials), #112 (live "trusted by N freelancers" counter), #113 (per-niche meta description blurbs), #120 (noscript SEO hero fallback), #59 ("Invoiced via QuickInvoice" footer in invoice emails — Calendly virality), #93 (email-signature builder), #114 (?ref=user_slug attribution at register), #18 (full referral program with Stripe coupons), #34 (Plausible analytics — gated on Master), #98 (public review/testimonial collection page), #78 (public freelancer profile /u/slug), #38 (public /roadmap), #58 (public coupon-redemption page), #104 (Chrome extension MVP), #69 (embeddable JS pay widget — gated on #43), #43 (public read-only invoice URL — unblocks #48, #69, #78).

**Income impact:** MED-HIGH — slow-burn compounding. Each new SEO surface earns 50-300 monthly visitors at maturity; virality compounds with active-user count.

---

## E7 — Accounting & Pro Power-User Features  [PLANNED]

**Goal:** Become the freelancer's accounting hub, not just an invoicing tool. Switching cost moat: every Pro feature here makes "I'll just use FreshBooks" harder.

**Child tasks (open):** #61 (attach invoice PDF on send), #62 (year-end tax summary PDF for Pro), #64 (aging receivables widget), #76 (QBO/Xero export), #70 (receipt PDF for paid invoices), #87 (Stripe payout reconciliation widget), #33 (bulk CSV export), #42 (custom invoice numbering), #22 (late-fee automation — Pro), #99 (multi-language PDF), #24 (multi-currency), #105 (multi-business profiles per user), #51 (schedule invoice send for future date), #40 (recurring invoice auto-generation — QuickInvoice parity with InvoiceFlow), #50 (quote/estimate flow with convert-to-invoice), #21 (client-facing invoice portal), #27 (one-click invoice duplication), #26 (AI line-item suggestions — Claude Haiku), #115 ("reply to client" mailto chip on paid invoices).

**Income impact:** MED — Pro retention via accounting-tool integration moat.

---

## E8 — Operational Health, Security & Compliance  [PLANNED]

**Goal:** Don't lose the business to a security/legal/perf incident. Always-on hygiene that the Health Monitor role drives each cycle.

> _Note: Role 7 (Health Monitor) audits the codebase every cycle and pulls fixes inline as needed. This epic stays [PLANNED] so the 3-active-feature-epic budget is reserved for revenue-leverage work; H-tasks ship opportunistically when bundled with other migrations or when Role 7 flags them._

**Outcome shipped so far:** SSRF hardening on outbound webhooks (H1), CSRF on every mutating POST (H2), rate-limit on auth (H3), helmet/CSP security headers (H4), plan-CHECK constraint widened (H5), null-user dereference fix (H7), status-whitelist (H6/H12), session-shape consistency, friendly 404, lib/html.js DRY (H14).

**Child tasks (open):** H8 (composite (user_id, status) index), H9 (bcrypt → ^6), H10 (parseInt radix), H11 (pagination on getInvoicesByUser), H15 (Promise.all sequential lookups), H16 (resend → patched svix), H17 (partial index for trial-nudge), H18 (expression index for recent-clients), H20 (currency-formatter DRY in outbound-webhook), #28 (legal pages scaffolding — Terms/Privacy/Refund — blocks U3 + Stripe ToS + several TODO_MASTER L items).

**Income impact:** LOW direct, but a single security/compliance incident is HIGH negative. This epic is insurance, not growth — but the Stripe ToS and legal pages do gate acquisition surfaces (App Store listings, B2B sales).

---

## E9 — Email Channel Activation (Resend gate)  [PAUSED]

**Goal:** Unlock the entire email-driven retention/conversion arsenal that's currently blocked on Master setting `RESEND_API_KEY` in production.

**Status:** [PAUSED] — every child task is implementation-ready but cannot ship to prod until the Resend key lands. TODO_MASTER #18 tracks the Master action.

**Child tasks (open, all Resend-gated):** U1 (self-serve password reset), #11 (churn win-back sequence), #12 (monthly revenue summary), #66 (auto-CC accountant), #71 (auto-BCC freelancer), #72 (.ics calendar attachment), #77 (welcome-back on past_due restore), #80 (weekly Monday digest), #84 (plain-language email body), #90 (60+ day inactive re-engagement), #110 (passwordless magic-link login).

**Income impact:** HIGH — the unlock is one Master action that releases ~10 ready-to-ship retention/conversion tasks.

---

_Status legend:_ [ACTIVE] = work is happening or queued for next 1-2 cycles · [PLANNED] = on the roadmap, not yet active · [COMPLETE] = all child tasks DONE · [PAUSED] = waiting on external blocker.
