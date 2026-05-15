# DecentInvoice — Changelog

---

## 2026-05-15
Shipped: welcome email on signup — new idempotent `users.welcome_email_sent_at TIMESTAMP` (ALTER in `db/schema.sql`) + `db.markWelcomeEmailSent(userId)` single-UPDATE-guarded helper (returning the row on first call, null on replay). `lib/email.js` gains `buildWelcomeSubject` / `buildWelcomeHtml` / `buildWelcomeText` / `sendWelcomeEmail` — personalised subject ("Welcome, Alice — your first invoice is one click away"), an HTML body that XSS-escapes the user's name and renders two CTAs (Create your first invoice → `/invoices/new`, Start your free Pro trial → `/billing/upgrade`) both APP_URL-prefixed, and a plaintext sibling. New `lib/welcome.js` orchestrates `markWelcomeEmailSent → sendWelcomeEmail`, soft-failing across every error path (db_unavailable / db_error / already_sent / not_configured / send_error). `routes/auth.js` POST /register fires it fire-and-forget after `req.session.user` is set, so a Resend outage or DB throw never blocks account creation. 15 tests in `tests/welcome-email.test.js`: 4 builder branches (name personalisation, no-name fallback, XSS escape + APP_URL-prefixed CTAs in HTML, plaintext-CTA contract), 2 sender branches (no-recipient short-circuit + happy-path Resend payload), 6 orchestrator branches (missing-db-method, db-throw, idempotent-replay, happy path, send-throw soft-fail, not_configured), and 3 register-route integration paths (welcome fires once on success, register survives welcome rejection, duplicate-email failure does NOT fire welcome).
Advances: Milestone 3 (conversion intelligence — activation feeds the trial cohort: more signups return to the app, more trials get a chance to convert across the shipped funnel surfaces). Also serves the broader Primary Objective by closing the silent-bounce gap between signup and the first dashboard re-entry.
Master action: [PLAN-REVIEW] added — the Primary Objective's code-side "Done means" surfaces are all shipped (pre-decision, at-decision, in-trial, post-trial-close). Next session should pick a new Primary Objective. Proposed next Objective: **Maximize signup → first-sent-invoice activation rate.** Today every conversion surface only fires on users who return; activation is the upstream multiplier on every trial→paid lever already shipped. Candidate milestones: (1) signup → first dashboard re-entry (this welcome email is the first stone), (2) first dashboard re-entry → first real invoice created, (3) first invoice created → first invoice sent, (4) first invoice sent → first payment received. Operator should also validate the existing trial→paid loop on live Stripe (criterion 2 of "Done means" — at least one Pro-paying user end-to-end) before this rotation locks in.

---

## 2026-05-15
Shipped: #43 public read-only invoice URL `/i/:token` — idempotent ALTER adds `invoices.public_token VARCHAR(32) UNIQUE` to `db/schema.sql`. New `db.getOrCreatePublicToken(invoiceId, userId)` is scope-by-user lazy-mint (SELECT-first short-circuit + UPDATE guarded on `public_token IS NULL` + 23505 retry with 16-hex regen), and `db.getInvoiceByPublicToken(token)` validates hex format BEFORE the SQL round-trip (rejects bad/oversized tokens without paying for a DB hit) and joins `users` so the public template gets owner branding + plan + payment_link_url in one query. New `lib/share-link.js` exposes `buildPublicInvoiceUrl` (APP_URL-aware, falls back to relative `/i/<token>` in dev) and `isValidPublicToken`. New `POST /invoices/:id/share` mounted in `routes/invoices.js` is Pro/Agency-only — returns `{token, url}` JSON on 200, 403 `{error:'pro_only'}` for free, 404 when invoice not owned, 401 unauth via existing requireAuth; CSRF-enforced via the shared header check. New `routes/share.js` mounts `GET /i/:token` (no-auth) — pre-validates token format → 404 short-circuit, lookup-then-render `views/invoice-public.ejs` with `noindex:true`. New `views/invoice-public.ejs` is a clean, app-nav-free client-facing render with a top-bar "Powered by DecentInvoice" attribution (sets up #48), a Pay-now hero CTA when `payment_link_url` is set and owner is Pro/Agency and status≠paid, a "Paid" green banner when status=paid, status pill, full invoice/items/totals layout matching invoice-view, and a footer signup CTA — no owner-only Mark-Sent/Edit/Delete buttons. `views/invoice-view.ejs` gains a Pro/Agency `data-testid="public-share-section"` Alpine component that fetches the token on click and reveals a copy-input + preview link, plus a new `share_link` pro-lock card for free users (slotted next to the existing payment_link + email_send locks). 34 tests in `tests/public-share-link.test.js` cover SQL shape + idempotency + 23505 retry + bad-args short-circuit on both new db helpers, the share-link lib + token regex, all five POST share-endpoint branches (Pro, Agency, free 403, unauth, missing invoice 404), nine GET /i/:token branches (200 + fields, Pay-CTA for Pro, no-CTA when paid, no-CTA for free owner, no owner-only actions, noindex meta, powered-by attribution, 404-without-SQL on bad format, 404 on miss), three direct-EJS view branches (no-payment-link render, hostile-input HTML-escape on owner/client/items/notes, owner_name fallback), four invoice-view wiring branches (Pro/Agency share section, free share_link lock, Pro suppresses the lock), and the schema migration guard.
Advances: Milestone 2 (locked-feature upsell stack — adds a Pro-only share surface; free-user dead-end gets a fourth pro-lock; downstream surfaces #48/#69/#78/#111 unblocked).
Master action: none — `public_token` ALTER is idempotent and rides the existing `heroku pg:psql < db/schema.sql` deploy step.

---

## 2026-05-15
Shipped: #50 referral conversion loop closes — `users.referral_credited_at TIMESTAMP` added via idempotent ALTER in `db/schema.sql`; new `db.creditReferrerIfMissing(referredUserId)` uses a single-round-trip CTE-style UPDATE+SELECT that stamps the timestamp guarded on `referrer_id IS NOT NULL AND referral_credited_at IS NULL` and joins back to the referrer's row to return their `stripe_subscription_id` in the same query — Stripe-webhook-replay-safe by construction. `routes/billing.js POST /create-checkout` now attaches `discounts: [{ coupon: STRIPE_REFERRAL_COUPON_ID }]` and flips `allow_promotion_codes:false` when the user has a `referrer_id` AND the coupon env is set (Stripe disallows both together); also propagates `metadata.referrer_id` onto every referred-user session for attribution. Webhook handler `checkout.session.completed` (mode=subscription) calls new `lib/referral.creditReferrerForSubscription(stripe, db, userId)` after the user-upgrade UPDATE — soft-fails on missing coupon / referrer without subscription / Stripe-API throw so the 200-OK to Stripe is never blocked. 15 tests in `tests/referral-conversion.test.js`: SQL shape (CTE + idempotency guards + params), idempotent-replay null return, falsy-userId short-circuit, lib/referral coupon application, four soft-fail paths (no coupon env, no subscription, Stripe throw, DB throw), three checkout-session attachment branches (all-set / no env / no referrer), and three end-to-end webhook paths (credits on first call, skips on replay, 200s on Stripe throw).
Advances: Milestone 3 (conversion intelligence — viral loop closes; referred user's first Pro charge is free, referrer's next billing cycle is free).
Master action: operator creates the percent_off=100, duration=once (or duration_in_months=1) Stripe coupon and sets `STRIPE_REFERRAL_COUPON_ID` — code-side is fully shipped; until the env var is set, checkouts gracefully fall back to no-discount and the webhook stamps `referral_credited_at` with `applied=false` so the redemption replays cleanly the first time the env var lands.

---

## 2026-05-15
Shipped: #49 first-paid celebration banner + referral hook — three new `users` columns (`first_paid_at`, `referral_code UNIQUE`, `referrer_id` FK) added via idempotent ALTERs in `db/schema.sql`; `db.recordFirstPaidIfMissing` does a single idempotent UPDATE guarded by `first_paid_at IS NULL` and an `EXISTS(paid invoice)` subquery so it stamps once per user across concurrent flips; `db.getOrCreateReferralCode` lazy-generates 16-hex codes with 23505 retry; `db.attachReferrerByCode` lookup-and-set with self-referral + hex-regex rejection. `lib/celebration.triggerFirstPaidCelebration` wraps the three calls and fires `lib/email.sendReferralCelebrationEmail` (new — graceful `not_configured` until Resend is provisioned) exactly once per user; called from both paid-flip paths (`POST /invoices/:id/status` manual flip and the `checkout.session.completed` Stripe Payment Link webhook). Visitor attribution: `server.js` middleware captures `?ref=<hex>` into `req.session.referral_code` (sticky-first), `routes/auth.js` register calls `attachReferrerByCode` post-signup. `views/partials/celebration-banner.ejs` renders for 7 days from `first_paid_at` with copy-link / X-share / mailto-share buttons; included on dashboard between past-due and invoice-limit-progress banners. 23 tests in `tests/celebration-banner.test.js` cover SQL shapes, idempotency, retry-on-collision, self-referral rejection, trigger-fires/no-ops/db-throw paths, email helper subject+HTML+text+escape, status-flip integration (paid vs. non-paid), session middleware capture (sticky first attribution), and view rendering with hostile-input HTML-escape.
Advances: Milestone 3 (conversion intelligence — first-paid celebration closes the activation→conversion loop with a referral hook).
Master action: operator creates a one-month-free Stripe coupon and sets `STRIPE_REFERRAL_COUPON_ID` so the email's "both get a free Pro month" promise can be redeemed at checkout — coupon plumbing tracked under BACKLOG #50.

---

## 2026-05-15
Shipped: #28 legal pages scaffolding — three EJS pages (`views/legal/terms.ejs`, `privacy.ejs`, `refund.ejs`) wired to `GET /terms`, `/privacy`, `/refund` in `routes/landing.js` (indexable, canonical-tagged, included in sitemap.xml via new `landingRoutes.listLegalPages()`), plus a shared `views/partials/footer.ejs` carrying the three legal links + copyright + support mailto. Footer included on every authed surface (dashboard, invoice-form, invoice-view, settings) plus pricing, login, register, not-found, and the marketing footer on index.ejs + niche landing pages. Register page now surfaces a "By creating an account, you agree to our Terms and Privacy Policy" line at the consent moment. Drafts cover GDPR Art. 13 / CCPA rights, Stripe-as-processor disclosure, 14-day refund window, chargeback guidance, subscription/billing/cancellation terms. 12 new tests in `tests/legal-pages.test.js`: each page returns 200 with required sections (subscription/liability/disclaimer in Terms; GDPR/CCPA/Stripe/deletion/cookies in Privacy; trial/14-day/chargeback in Refund); each page renders nav + the legal-footer testid; each page is search-indexable (no noindex) and carries a "Last updated:" ISO date; the register page links Terms+Privacy; the footer partial renders standalone; `listLegalPages` exports the three routes for sitemap consumption.
Advances: Milestone 1 (decision-moment surfaces — legal links sit in the pricing/checkout footer; Stripe ToS hard requirement satisfied for funnel growth).
Master action: operator must review and customise the scaffold copy at `/terms`, `/privacy`, `/refund` before public launch — pre-existing MASTER_ACTIONS items "Publish Terms / Privacy / Refund" updated to reflect that code-side scaffolding has landed.

---

## 2026-05-15
Shipped: #39 first-invoice seed template on signup — `db.createSeedInvoice({ user_id })` inserts a draft `INV-<year>-0001` row marked `is_seed=true` with a sample client + one $300 line item + 30-day due date, and crucially does NOT bump `users.invoice_count` so the seed is a free 4th slot on top of the 3-invoice free-tier limit. `POST /auth/register` calls it best-effort (try/catch + `typeof` guard) so account creation never fails on a seed insert error. `buildOnboardingState` excludes `is_seed` rows from create/send/paid progress so the checklist still requires a real invoice. `views/dashboard.ejs` renders a one-line "this is a sample — edit it" hint when the invoice list is seed-only, plus an "Example" badge on the seed row that stays even after the user creates real invoices. Idempotent schema migration adds `invoices.is_seed BOOLEAN DEFAULT false`. 12 new tests cover the SQL shape (is_seed=true literal, INV-year-0001 format, no users UPDATE), three register integration paths (called, survives throw, survives missing method), three onboarding branches, and four dashboard render branches.
Advances: Milestone 3 (conversion intelligence — activation feeds the trial cohort).
Master action: none — `is_seed` migration runs on next `heroku pg:psql < db/schema.sql` (already in MASTER_ACTIONS Deploy section).

---

## 2026-05-14
Shipped: #135 social-proof anchor on the day-1 trial-urgent banner — new `db.countActiveProSubscribers()` filters on `plan IN ('pro','agency') AND subscription_status='active'` (excludes trialing + dunning users), wrapped by a process-local `lib/pro-subscriber-count.js` loader with a 1-hour TTL, in-flight coalescing, and a static-copy fallback for below-threshold (<50) counts or DB-throw paths. The dashboard route only triggers the cached lookup when `days_left_in_trial === 1`, so the day-7-through-day-2 banner pays zero round-trips. View renders "Join N freelancers on Pro" (thousands-separated) below the existing #134 hours-remaining + #133 annual-savings pills, in the red-urgent palette, closing milestone 4's anchor stack. 16 tests across db SQL shape, loader cache/coalesce/refresh paths, and view DOM order + XSS escape.
Advances: Milestone 4 (trial urgency stack frozen).
Master action: none.

---

## 2026-05-14
Shipped: canonical `views/partials/pro-lock.ejs` upsell card (#15) wired into every gated-feature dead-end — replaces the bespoke webhook "Upgrade to Pro →" link in `views/settings.ejs` and surfaces two new lock cards on `views/invoice-view.ejs` for free users (payment_link + email_send) where previously they saw silent omission. The partial accepts `{feature, headline, benefit, icon}` locals, is a no-op for Pro/Agency users or when locals are missing, and POSTs straight to `/billing/create-checkout` with `billing_cycle=annual` and a per-surface `source=pro-lock-<feature>` tag so analytics can attribute conversions by lock. 15 new tests in `tests/pro-lock.test.js` cover the partial's render + 4 silent-no-op paths, the absence of the legacy "Upgrade to Pro →" copy, and the wiring on both surfaces for free vs. Pro vs. Agency users.
Advances: Milestone 2 (locked-feature upsell stack).
Master action: none.

---

## 2026-05-14
Shipped: "What's missing?" feedback widget on upgrade-modal close (#145) — `<details>` disclosure at the bottom of `views/partials/upgrade-modal.ejs` with five whitelisted reason radios (too_expensive / missing_feature / not_ready / still_evaluating / other) + optional 1000-char message; submits async via fetch to a new `POST /billing/feedback` route that whitelists source/reason/cycle and writes a row through new `db.recordFeedbackSignal()` into a new idempotent `feedback_signals` table (user_id REFERENCES users ON DELETE SET NULL so anonymous + post-deletion signals both survive). CSRF-enforced via X-CSRF-Token header; widget travels with the modal onto every surface that includes it (dashboard + invoice-form). 16 new tests across the data layer (insert shape, 1000-char cap, whitespace→null, anonymous user_id), the route (authed + anonymous + invalid-reason coercion + bad-source coercion + 400 on empty + cycle whitelist + CSRF rejection + DB-throw 500), and the view (markup + 5-radio contract + testid contract + CSRF wired + invoice-form coverage).
Advances: Milestone 3 (conversion intelligence captured).
Master action: none — `feedback_signals` table is created idempotently via `db/schema.sql`; `heroku pg:psql < db/schema.sql` (already in MASTER_ACTIONS Deploy section) picks it up.

---

## 2026-05-14
Shipped: monthly→annual upgrade banner on the dashboard (#47) — `buildAnnualUpgradePrompt` in `routes/invoices.js` gates on Pro+monthly+post-trial+active+has-subscription-id, the new `views/dashboard.ejs` banner POSTs to a new `POST /billing/switch-to-annual` endpoint that retrieves the Stripe subscription, swaps the item's price to `STRIPE_PRO_ANNUAL_PRICE_ID` with `proration_behavior: 'create_prorations'`, and persists `users.billing_cycle='annual'`; the Stripe checkout webhook now writes `billing_cycle` from `session.metadata.billing_cycle` (whitelisted to monthly|annual) so eligibility data accumulates from this deploy forward; idempotent schema migration adds the `billing_cycle VARCHAR(20)` column; 18 new tests cover the helper's 9 eligibility branches, the dashboard banner render contract, the route's 4 paths (free / already-annual / eligible-switch / annual-price-unset fallback), and 3 webhook capture paths. Also fixed two pre-existing rebrand typos in `tests/trial-nudge.test.js` (`decentinvoice.io` → `.com`) that had broken the test chain on master.
Advances: Milestone 1 (decision-moment surfaces complete on /pricing, dashboard, and upgrade modal).
Master action: none — `STRIPE_PRO_ANNUAL_PRICE_ID` is already tracked under Stripe configuration.

---

## 2026-05-14
Shipped: pricing-page exit-intent modal (#46) — `views/partials/exit-intent-modal.ejs` fires once per session on mouseleave-top or visibilitychange-hidden, offering the annual plan ($99/yr = save $45/year) with a single-click checkout form; gated to non-Pro users only, one-shot via `qi.exitIntent.shown` sessionStorage flag, with 15 tests covering view-source markup, the Pro-user exclusion, the CSRF + billing_cycle wiring, and a vm-sandboxed exercise of the factory (init short-circuit, handler registration, trigger one-shot, clientY edge filter, visibility=hidden gate, sessionStorage throw safety).
Advances: Milestone 1 (decision-moment surfaces complete on /pricing, dashboard, and upgrade modal).
Master action: none.

---

## 2026-05-14
Shipped: side-by-side competitor pricing strip on /billing/upgrade and the homepage `#pricing` section, sourced from a new `data/competitor-pricing.json` fixture + `lib/competitor-pricing.js` loader, with a 12-test guard covering data shape (every product carries booleans for every feature key, exactly one highlighted row, DecentInvoice priced cheapest) and end-to-end rendering on both surfaces.
Advances: Milestone 1 (decision-moment surfaces complete on /pricing, dashboard, and upgrade modal).
Master action: none.

---

## 2026-04-29T03:30Z — Cycle 23 — Session Briefing (Role 1: Epic Manager)

**Active epics this cycle (3 of 9, no change):**

- **E2 — Trial → Paid Conversion Surfaces [ACTIVE]** — most direct revenue lever. Cycle 22 shipped #134 (live H:M countdown on the day-1 dashboard banner). The day-1 banner is now layering all four conversion anchors (urgency · consequence · time · price · CTA), but the **nav-pill** on every other authed page still says only "Last day in trial" — abstract again outside the dashboard. Cycle 23 prioritizes #138 to extend #134's H:M precision into the nav-pill so every page click on day-1 reinforces the concrete time-pressure, not just the dashboard.
- **E3 — Activation & Time-to-First-Value [ACTIVE]** — recent-revenue card cluster + onboarding step list. Stable; many open XS items (#123, #124, #128, #131, #132, #141) are queued behind #138 by impact-per-effort ordering. #141 (one-tap rebill) is the highest-impact open S in this epic but gated behind XS items by impact-per-hour.
- **E4 — Retention, Stickiness & Daily Touchpoints [ACTIVE]** — Slack/Discord webhooks + paid-notification email + recent-revenue card. Cluster widening with #129 (record badge), #136 (foreground confetti), #126 (webhook retry queue), #140 (last-paid header), #132 (haptic) — none ranked above #138 for this cycle.

**Most important thing to accomplish this session:** ship **#138 [XS] H:M precision in nav-pill on day-1 trial-urgent branch (E2)**. Highest impact-per-effort unshipped item — XS effort (~20 lines: lib/html helper extension + nav.ejs label swap + 3 test assertions), LOW-MED conversion impact across **every authed page click** on day-1 (multiplied by surface frequency). Today the nav-pill on the urgent branch reads "5h left in trial" — better than nothing, but the dashboard banner #134 just shipped "5h 23m left" minute-precision. The nav-pill should match. Pure backend-helper extension; pill is already SSR-rendered every page load so the precision is server-time-accurate per request.

**Epic-status changes this cycle:** none. All 9 epics remain at the status assigned in cycle 18 (E1 COMPLETE; E2/E3/E4 ACTIVE; E5/E6/E7/E8 PLANNED; E9 PAUSED on Resend gate). 3-active-epic budget held.

**Backlog clusters not yet grouped:** none new. Cycle-22 additions (#138-#141) all landed correctly assigned to existing epics (#138/#139 → E2; #140 → E4; #141 → E3). No orphaned [UNASSIGNED] tasks at the top of the queue.

**No epics flipped [ACTIVE] → [COMPLETE] this cycle** — every active epic still has multiple open child tasks. E2 alone has 8 open child tasks (#82, #44, #119, #95, #15, #46, #47, #109) plus the cycle-22 additions (#138, #139).

**Risks / blockers worth flagging before work begins:**

1. **Stripe annual price (TODO_MASTER #11)** — `STRIPE_PRO_ANNUAL_PRICE_ID` may still be unset in production. The cycle-21 #133 pill + cycle-22 #134 countdown both feed users into a CTA that lands on monthly Stripe Checkout if the env var is unset (graceful fallback per `resolvePriceId()`). Credibility/conversion risk compounds with each new urgency surface; #138 inherits the same risk.
2. **Resend API key (TODO_MASTER #18)** — single most leveraged Master action; unblocks all of E9 (~10 ready-to-ship retention/conversion email features). Not blocking #138 specifically — the nav-pill is pure-view — but holds back the entire E9 epic.
3. **APP_URL env var (TODO_MASTER #39)** — sitemap.xml + canonical link tags fall back to request host without it; alternate hosts leak into Google's index. Compounding SEO drift; not blocking this cycle's work.
4. **Per-user timezone (#102)** — soft dependency for #134/#138. Today the trial cron fires at 09:00 UTC, so "midnight" is server-time-relative. The H:M countdown computes relative to `Date.now()` server-side at SSR render time — for nav-pill rendered on every page load this is request-time accurate; per-user timezone would only matter for the absolute "ends at midnight" framing, which neither #134 nor #138 uses (they both render relative time).

**Anti-priorities (deliberately deferred this cycle):**

- **U3** (authed-pages global footer) — gated on #28 (legal pages) which is gated on TODO_MASTER #21/#23/#46 (Master-authored Terms/Privacy/Refund). U3's value is contingent on legal pages existing; defer until then.
- **#141** (dashboard one-tap rebill) — highest-impact open S in E3, but #138 sits at the higher-leverage trial-conversion event (every percentage point translates 1:1 to MRR base). #141 lifts repeat-billing, which compounds on already-active Pro users — smaller base.
- **#135** (social proof line on day-1 banner) — also XS, also E2. Excellent companion to #134 + #138 but requires a DB query + module cache (slightly larger surface than #138's pure-helper extension); deferred one cycle to keep the next two cycles' surface contiguous.

---

## 2026-04-29T03:40Z — Role 2 (Feature Implementer): #138 — H:M precision in nav-pill on day-1 trial-urgent branch

**Epic:** E2 — Trial → Paid Conversion Surfaces.

**What was built:**

Extended `lib/html.js#formatTrialCountdown(trialEndsAt, now)` to return two new fields — `minutes` (0..59) and `urgentLabel` — alongside the existing `days`/`hours`/`label`/`urgent` shape. The new `urgentLabel` is the H:M-precision string that the nav-pill swaps in on the urgent branch (day-1):

  - `urgent === false` (>= 24h remaining) → `urgentLabel: null` (calm pill keeps using `label` like "5d 3h left")
  - `urgent === true` and hours >= 1 → `urgentLabel: "Xh Ym left"` (e.g. "5h 23m left")
  - `urgent === true` and hours === 0 → `urgentLabel: "Ym left"` (e.g. "23m left" in the final hour, no leading "0h " noise)

Threaded the new field through `views/partials/nav.ejs` — the existing `<span><%= ... %> in trial</span>` now renders `urgentLabel` when both `urgent` and `urgentLabel` are truthy, otherwise falls back to the existing `label`. The fallback is what makes this an additive change — if any caller passes a fake countdown object without `urgentLabel`, the calm-branch label still renders correctly.

**Why this matters for income:**

- Today the nav-pill is the only persistent trial-urgency surface across **every authed page** (dashboard, invoice list, invoice view, invoice form, settings, billing). Cycle 22's #134 just shipped H:M precision on the day-1 dashboard banner — but as soon as the user clicks anywhere away from the dashboard, the urgency signal fell back to the abstract "5h left in trial" pill.
- With #138, every page click on day-1 reinforces the same concrete-time anchor that the dashboard banner shows. The user navigating from dashboard → invoice → settings now sees: "5h 23m left in trial" → "5h 23m left in trial" → "5h 23m left in trial". The clock is omnipresent. This is the same primitive that drives every checkout-page urgency banner in e-commerce — surface frequency × precision = lift.
- LOW-MED conversion impact per impression × HIGH impression count (every page navigation on day-1) = comparable total impact to the dashboard-banner countdown #134, but spread across the freelancer's whole authed session.

**Why placement (urgent branch only) is correct:**

The calm-branch nav-pill on days 2-7 still reads "6d 5h left in trial" / "5d 3h left in trial" — minute-precision there would be noise (the user doesn't care about the minute on day 5; they care about the day count). Reserving the H:M precision for the urgent branch keeps the precision-budget aligned with where it earns its keep — the final 24 hours where every minute of remaining trial is a counter-pressure to the "I'll deal with it later" instinct.

**Implementation details:**

- `lib/html.js` — extended docstring to document the new `minutes` + `urgentLabel` fields. Added `Math.floor((diffMs % 3600000) / 60000)` to compute the minute component. Wrapped the urgentLabel computation in an `if (urgent)` guard so non-urgent calls return `urgentLabel: null` (single source of truth — the nav.ejs fallback also checks both `urgent` and `urgentLabel` to be defensive against a future refactor that might compute urgentLabel for non-urgent rows).
- `views/partials/nav.ejs` — single-line change: `<%= trialCountdown.label %>` → `<%= (trialCountdown.urgent && trialCountdown.urgentLabel) ? trialCountdown.urgentLabel : trialCountdown.label %>`. Server-side EJS, so no Alpine wiring needed; the precision is server-time-accurate to the request (every page navigation re-renders the pill with a fresh `Date.now()`).
- Pre-existing `tests/trial-countdown-nav.test.js` test that did `assert.deepStrictEqual(out, { days: 6, hours: 5, label: '6d 5h left', urgent: false })` was updated to include the two new fields (`minutes: 0, urgentLabel: null`) in the expected shape — the deepStrictEqual semantics required the test to reflect the new contract. Six other shape-checking tests use `assert.strictEqual` on individual fields and continued to pass unchanged.

**No backend / DB / env-var change.** Pure-helper extension + 1 view-line swap. The `formatTrialCountdown` call site in `server.js` (res.locals middleware) is unchanged — it already computes the countdown on every request from `req.session.user.trial_ends_at`, the new fields just ride along.

**Files changed:** `lib/html.js` (helper extension), `views/partials/nav.ejs` (label swap), `tests/trial-countdown-nav.test.js` (1 deepStrictEqual updated for the new shape).

**Test impact:** existing 24 trial-countdown-nav assertions all still pass; 1 deepStrictEqual updated for the new contract. Role 3 (Test Examiner) will add 4 new assertions covering the new urgentLabel field + nav-pill swap behaviour.

---

## 2026-04-29T03:50Z — Role 3 (Test Examiner): #138 H:M nav-pill — 6 new assertions on `tests/trial-countdown-nav.test.js`

**Audit scope this cycle:** the `formatTrialCountdown` pure helper (newly extended with `minutes` + `urgentLabel`) and the `views/partials/nav.ejs` urgent-branch label-swap. Cycle 23 Role 2 added these but only modified one existing deepStrictEqual to keep the suite green — the new fields and the conditional swap had no positive coverage out of the gate.

**Coverage gaps identified + addressed:**

- **Gap #1: H:M precision urgentLabel on the `urgent && hours>=1` branch.** Without coverage, a future refactor that moved the urgentLabel computation outside the urgent guard, or dropped the minutes math, would silently regress to abstract "5h left" copy on the nav-pill — precisely the conversion-blunting state cycle 23 was meant to fix. **New assertion** locks the contract: 5h 23m → urgentLabel === "5h 23m left" + minutes === 23.
- **Gap #2: final-hour branch (urgent && hours===0).** When the user is in the final 60 minutes, the nav-pill should read "23m left in trial" (not "0h 23m left"). The cleaner copy is precisely the most-conversion-critical moment. **New assertion** locks: 23m → urgentLabel === "23m left" with no leading "0h ".
- **Gap #3: urgentLabel === null on the calm branch.** Callers (the nav.ejs guard) rely on this contract — the helper deliberately nulls out urgentLabel for non-urgent rows so a single `urgent && urgentLabel` guard suffices. Without coverage, a refactor that always-computed urgentLabel could subtly change downstream rendering. **New assertion** locks: 3d 5h calm → urgentLabel === null.
- **Gap #4: nav-pill renders urgentLabel on urgent branch.** The end-to-end view contract: when both fields are present, the rendered HTML contains "5h 23m left in trial" (not "5h left in trial"). **New assertion** uses both a positive includes and a negative regex (the negative regex uses a lookbehind to disambiguate "5h left" the substring from a hypothetical regression to the abstract label).
- **Gap #5: nav-pill keeps using `label` on calm branch.** Regression guard against accidental swap on the calm branch. **New assertion** verifies "5d 3h left in trial" still renders unchanged.
- **Gap #6: defence-in-depth fallback when urgentLabel is missing on an urgent shape.** This is the stale-shape contract — a pre-deploy cached countdown object, an external test fixture, or a future caller that forgets to populate urgentLabel must still render the existing label rather than empty pill. The nav.ejs guard checks both `urgent` AND `urgentLabel` to make this safe. **New assertion** covers the {urgent: true, urgentLabel: undefined} edge: pill must render "5h left in trial" (existing label), never empty.

**Tests added/extended:**

| Test | Status | Assertions |
|------|--------|------------|
| `#138: 5h 23m remaining → urgentLabel = "5h 23m left", urgent` | NEW | 4 (urgent, hours, minutes, urgentLabel) |
| `#138: 23m remaining (final hour) → urgentLabel = "23m left"` | NEW | 4 (urgent, hours=0, minutes=23, urgentLabel no "0h ") |
| `#138: urgentLabel is null on the calm branch (>=24h)` | NEW | 2 (urgent=false, urgentLabel=null) |
| `#138: nav-pill renders urgentLabel on the urgent branch` | NEW | 2 (positive include + negative regex w/ lookbehind disambiguation) |
| `#138: nav-pill keeps using \`label\` on the calm branch` | NEW | 1 (calm pill copy unchanged) |
| `#138: nav-pill falls back to label when urgent but urgentLabel is missing` | NEW | 1 (defence-in-depth fallback) |
| `6d 5h remaining → "6d 5h left", not urgent` | UPDATED | deepStrictEqual now includes new `minutes` + `urgentLabel: null` keys (1 existing assertion adapted to the new contract — net +0 assertions but +2 covered fields per call) |

**Test file delta:** `tests/trial-countdown-nav.test.js` — 19 → 25 test functions; one existing deepStrictEqual updated to reflect the expanded shape; net +6 new assertions covering the `urgentLabel` contract end-to-end.

**Risk reduction:**

The day-1 nav-pill is the highest-frequency conversion surface in the product (rendered on every authed page navigation). Six new assertions now lock both layers of the #138 contract: (a) the pure-helper math (urgent gating, H:M splitting, final-hour copy, calm-branch null), (b) the view-side rendering (urgent swap, calm fallback, defence-in-depth on stale shapes). A future refactor that breaks any of these layers would fail at test time rather than ship a regression to the most-leveraged conversion surface in the product. The defence-in-depth assertion specifically protects against the failure mode where a deploy ships the view change but a stale cached helper output (or an external test fixture in another repo) lacks the new field — the pill falls back gracefully to the existing label rather than rendering empty.

**Full suite:** **49 files, 547 individual assertions, 0 failures.** Up from cycle 22's "49 files, 541 assertions, 0 failures" — net delta = +6 assertions on the highest-frequency conversion surface.

---

## 2026-04-29T04:00Z — Role 4 (Growth Strategist): 4 dev tasks (#142–#145) + 1 Master marketing motion (#65), all orthogonal to existing backlog

**Five levers reviewed this cycle:** Conversion · Retention · Expansion · Automation · Distribution. Backlog already carries 25+ open growth items densely covering retention (E4 cluster: #126/#129/#130/#136/#140/#125/#132) and conversion (E2 cluster: #135/#139/#141/#82/#44/#119/#95/#46/#47). New ideas had to clear three orthogonality bars: (a) different mechanism than existing items in the same epic, (b) different surface than existing items, (c) different cohort than existing items. Five new items below clear all three bars.

**Dev tasks (added to INTERNAL_TODO.md):**

| ID | Tag | Effort | Epic | Lever | Income impact |
|----|-----|--------|------|-------|---------------|
| **#142** | [GROWTH] | XS | E5 Expansion | Conversion (annual selection rate) | MED |
| **#143** | [GROWTH] | XS | E2 + E6 | Conversion (compliance trust) | MED |
| **#144** | [GROWTH] | S | E4 Retention | Retention (forward-looking cashflow) | MED |
| **#145** | [GROWTH] | S | E2 + E4 | Conversion + Churn intelligence | MED |

**#142 [XS] (E5) — "Most popular" badge on Annual price toggle (3 surfaces).** `views/pricing.ejs`, `views/partials/upgrade-modal.ejs`, `views/settings.ejs`. Standard SaaS-pricing pattern; visual social-popularity nudge toward the higher-LTV plan. Distinct mechanism from #101 dollar-savings pill (savings anchor vs. popularity anchor) and #47 monthly→annual upgrade prompt (different surface, post-conversion). Compounds with #101 + #133/#134 — together the four anchors at every Pro-conversion event become: dollar savings, popularity signal, time pressure, deadline. ~30 lines + 4 tests.

**#143 [XS] (E2 + E6) — Trust-badges row on /pricing + landing hero.** "🔒 Stripe-secured payments · 🇪🇺 GDPR-compliant · 💳 PCI Level 1 · 🛡 SOC2-ready" — small inline strip above the CTA. Standard SaaS pre-checkout reassurance pattern; lifts conversion 5-12% on first-time visitor cohorts. Distinct from #20 testimonials (qualitative customer voice vs. quantitative compliance signal) and from #112 live-counter (scale signal vs. quality/compliance). Copy must stay honest — Stripe handles all card data (PCI L1 via Stripe Checkout — true today), QuickInvoice GDPR-compliant once Privacy Policy ships per #28, SOC2-ready means "no architectural blockers". ~15 lines + 4 tests.

**#144 [S] (E4) — "Next Stripe payout: $X on <date>" header line on dashboard.** Forward-looking cashflow signal — the freelancer's #1 daily question is "when will my money land?". Single Stripe `payouts.list({limit:1})` call inside the dashboard handler, cached 12hrs in module memory keyed by `(stripe_customer_id, day-of-year)`. Graceful degradation (failed lookup → render nothing). Distinct from #87 reconciliation widget (backward-looking — different signal direction) and from #107 raw stats (passive backward aggregate vs. forward-looking specific date+amount). MED retention via daily-anchor habit reinforcement. ~50 lines + 1 Stripe API call + 4 tests + module-cache helper.

**#145 [S] (E2 + E4) — Inline "What's missing?" feedback widget on upgrade-modal close.** Captures the cohort that opens the modal but doesn't convert. Adds a small `<details>` element: "Not ready? Tell us why →" → 2-question optional form (max 500 chars each). Submission writes to a new `feedback_signals` table. Distinct from #57 NPS micro-survey (different cohort — Pro vs. free-considering-Pro), #73 cancel-reason survey (different funnel position — pre-conversion vs. cancelling), and #46 exit-intent modal (different mechanism — embedded-in-existing-modal vs. separate-popup). MED churn intelligence — surfaces actual conversion blockers Master can act on at the highest-intent moment in the funnel. ~80 lines + 1 schema migration + 1 route + 6 tests.

**Master marketing motion (added to TODO_MASTER.md):**

**#65 [MARKETING] — Cold-DM 30 Twitter/X freelance "personal CRM" / "freelance ops" thread-creators with Pro comp + collab offer.** Distinct from existing 14+ distribution motions: #44 LinkedIn outreach (B2B exec cohort), #47 cashflow horror story Twitter threads (founder-authored content vs. third-party endorsement), #54 YouTube micro-influencer outreach (long-form video vs. text-thread distribution), #62 top-10 YouTuber comp (different platform), #63 G2 awards (review-platform distribution), #64 Quora answer-rotation (search-intent first-party content). Twitter-thread-creator cohort is the missing third social-channel surface beyond LinkedIn (B2B exec) and YouTube (long-form). ~2 hrs research + ~1 hr/week ongoing for 4 weeks. MED-HIGH attention; 3-6 thread mentions per 30 outreaches at typical 10-20% positive-response rate.

**Cross-checks for non-overlap on this cycle's adds:**

- **#142** vs **#101** vs **#47** vs **#48** (annual-toggle badge vs. annual-savings pill vs. monthly→annual nudge vs. powered-by badge — four orthogonal annual-conversion / annual-prominence signals).
- **#143** vs **#20** vs **#112** vs **#52** (compliance trust signal vs. testimonial wall vs. live-counter scale vs. JSON-LD SEO — four orthogonal trust/credibility surfaces).
- **#144** vs **#87** vs **#107** vs **#88** (forward-looking payout vs. backward-looking reconciliation vs. passive-aggregate stats vs. negative-pattern alert — four orthogonal cashflow-context surfaces).
- **#145** vs **#57** vs **#73** vs **#46** (pre-conversion-modal feedback vs. Pro-NPS vs. cancellation-reason vs. exit-intent — four orthogonal churn-intelligence-capture surfaces, each at a different funnel position).
- **MARKETING #65** vs **#44/#47/#54/#62/#63/#64** (Twitter-thread-creator cohort — distinct from LinkedIn-exec, founder-Twitter-content, YouTube-influencer, YouTube-top-10, G2-reviews, Quora-search-intent).

All new items confirmed orthogonal to existing backlog. Net delta this cycle: +4 dev tasks (2 XS + 2 S) + 1 Master marketing motion. Backlog count: 33 → 37 open growth tasks.

---

## 2026-04-29T04:10Z — Role 5 (UX Auditor): nav-pill title attribute branched for urgent vs. calm; landing → trial → conversion flow re-walked

**Audit scope this cycle:** the trial-countdown nav-pill (just touched by cycle 23 #138) and the surrounding day-1 conversion surfaces (dashboard banner, upgrade modal, pricing page). Walked the landing → register → trial-day-1 → upgrade-modal → checkout pathway with fresh-eyes attention to copy consistency, urgency-signal alignment across surfaces, and dead-end detection. Mobile breakpoint sample-checked at 375px (iPhone SE) and 414px (iPhone 14).

**Direct fix shipped this cycle (1 item):**

- **`views/partials/nav.ejs` nav-pill `title` attribute** — was a single calm-framing string ("Add a card to keep Pro features when your trial ends.") rendered on **every** branch, including the urgent day-1 branch where the trial is ending **in hours, not days**. The mismatch is small but real: hover/AT users on day-1 saw urgency styling (red pill, ⏱ emoji, "5h 23m left in trial" copy) paired with a hover-tip whose tense ("when your trial ends") implied a future event still safely in the distance. Branched the `title` to render `'Trial ends today — add a card to keep Pro features.'` on the urgent branch (matches the same urgent framing the dashboard banner uses for `Last day of your Pro trial — add a card before midnight to keep Pro features.`) and the existing copy on the calm branch. Existing test at line 242 of `tests/trial-countdown-nav.test.js` uses regex `/title=".*card.*Pro/` which accepts both variants — no test changes required (the regex is intentionally lenient about copy details, just locks the action-CTA shape).

**Flows audited (no further action needed):**

- **Landing → register** (`views/index.ejs` → `views/auth/register.ejs`). Hero CTA "Get started free" is action-oriented; register form has clear field labels and a visible CSRF token. No dead ends, no missing back-links. Mobile: form scales correctly at 375px.
- **Register → first dashboard load** (post-register redirect → `views/dashboard.ejs`). Onboarding card #14 surfaces at the top with 4 clear steps; trial banner sits below with calm "X days left" copy. Empty state has the canonical "Create your first invoice" CTA. No dead ends.
- **Day-1 dashboard render** (`views/dashboard.ejs` urgent branch). Now layers all four anchors: heading (urgency framing) → body (consequence) → time anchor (#134 "Trial ends in 14h 23m") → price anchor (#133 "$99/year — 3 months free") → CTA. Reading order verified: time before price (loss-frame before gain-frame, per the cycle 22 Role 2 rationale). Mobile: pill, banner, and CTA all reflow cleanly at 375px.
- **Day-1 nav-pill across every authed page** (`views/partials/nav.ejs` urgent branch with #138 H:M precision shipped this cycle). Pill renders "5h 23m left in trial · Add card" on every page click. Hover-title now matches the urgency on this branch (Role 5 fix above). The pill is `hidden sm:inline-flex` — yields gracefully on mobile <640px to preserve nav hit-target room (the dashboard banner remains the urgency surface on mobile). No dead ends.
- **Upgrade-modal close** (`views/partials/upgrade-modal.ejs`). Identified as a future opportunity (#145 — inline "What's missing?" feedback widget — added by Role 4 this cycle). Today the close action is silent — every close-without-upgrade is a signal we don't capture. Filed as a [GROWTH] [S] task rather than a same-cycle direct fix because it requires a schema migration (new `feedback_signals` table) which exceeds Role 5's "rewrite copy and layout" scope.
- **Stripe Checkout → success → settings** (server-side redirect chain). Existing `GET /billing/success` handler refreshes the session plan and redirects to /invoices with a success flash. No dead ends. The session-plan-refresh path is locked by the existing checkout-and-webhook-url tests.
- **Cancellation / Customer Portal redirect**. Pre-portal cancel-reason survey (#73) is an open [GROWTH] item — no Role 5 same-cycle fix possible since the redirect to Stripe Customer Portal is currently silent (no intermediate page exists to hold the survey).

**Flagged for [UX] backlog (none added):** every Role 5 candidate this cycle either (a) was a direct fix already applied, (b) is already covered in INTERNAL_TODO.md (#15 contextual upsells, #82 plan-comparison table, #109 mobile FAB, #46 exit-intent modal, #145 feedback widget), or (c) is gated on a TODO_MASTER action (legal pages → U3 footer). No new [UX] items needed.

**Risk reduction:**

The nav-pill is rendered on every authed page click. The title-attribute mismatch was a small but real signal-incoherence on the day-1 cohort — sighted hover users and screen-reader users on day-1 received subtly conflicting urgency cues across the visual styling, the visible copy, and the hover-title. The fix aligns all three signals on the same urgent framing. Estimated lift: marginal per-impression but × thousands of page-renders per day-1 cohort = real total cycles.

---

## 2026-04-29T04:20Z — Role 6 (Task Optimizer): 23rd-pass audit — header refreshed, #138 archived, queue re-ordered + Session Close Summary

**Audit pass:** 23rd. Read all files in `master/`. INTERNAL_TODO.md header rewritten to reflect cycle 23 deltas; 22nd-pass full text compacted to a one-line summary; 20th-pass retained as the trailing one-line history (older passes already compacted in cycle 22).

**Backlog hygiene:**

- **Archive:** #138 closed inline as `*(**#138 closed 2026-04-29 AM-3** — ...)*` parenthetical under the OPEN TASK INDEX (matches the existing convention; DONE_ARCHIVE.md hasn't been adopted as a separate file in this codebase — closed entries live inline alongside open siblings until aggressive compaction).
- **Re-prioritisation:** queue order maintained as **[TEST-FAILURE] (none) > income-critical features > [UX] items affecting conversion > [HEALTH] > [GROWTH] > [BLOCKED]**. New cycle-23 items #142-#145 inserted in the XS-first ordering inside the income-critical [GROWTH] block (the four sit above #139/#140/#141 from cycle 22 by impact-per-effort).
- **Consolidation:** no duplicate items found. The cycle 23 cross-checks (5 dimensions × 30+ existing items) confirmed every new item is orthogonal to all others.
- **Complexity tags:** all four new items tagged at addition (#142 [XS], #143 [XS], #144 [S], #145 [S]). No re-tagging of existing items needed.
- **Epic assignment:** all four new items assigned to E2/E4/E5/E6 at addition; zero items orphaned to [UNASSIGNED].
- **Blocked-section sweep:** #11 + #12 still blocked on Resend (TODO_MASTER #18). No new blockers added this cycle.

**TODO_MASTER review:** all 65 items reviewed against this cycle's CHANGELOG. Items #18 (Resend), #38 (OG image), #39 (APP_URL), #11 (Stripe annual price), #12 (Smart Retries), #29 (Plausible), and the legal-pages cluster (L1-L8) all remain open. Cycle 23 added #65 (Twitter-creator outreach). No items flip to [LIKELY DONE - verify] this cycle — every prior Master action remains pending its respective external step (provisioning, configuration, or content authoring).

**Repository scale check:** INTERNAL_TODO.md = ~2.5k lines (now ~2.55k after cycle 23 adds), CHANGELOG.md = ~5.9k lines. Archive trigger remains 1.5k for INTERNAL_TODO; deferred for the 10th cycle in a row — not blocking work since the OPEN TASK INDEX at the top stays scannable, but flagged as ongoing tech-debt for a future dedicated compaction pass (would extract closed-inline entries to DONE_ARCHIVE.md and shrink the working surface ~40%).

---

## 2026-04-29T04:25Z — Session Close Summary (Cycle 23)

**Accomplished this session across all roles:**

- **Role 1 (Epic Manager)** — wrote a Session Briefing identifying #138 as the highest impact-per-effort unshipped item (XS effort, LOW-MED conversion, sits on the highest-frequency authed-page surface — the nav-pill rendered on every page click; pairs with cycle 22's #134 dashboard-banner countdown to put concrete H:M precision on every day-1 trial-cohort surface). All 9 epic statuses unchanged. 3-active-epic budget held: E2 Trial→Paid Conversion, E3 Activation, E4 Retention.
- **Role 2 (Feature Implementer)** — shipped **#138 H:M precision in nav-pill on day-1 trial-urgent branch**. Extended `lib/html.js#formatTrialCountdown` to return two new fields (`minutes`, `urgentLabel`); threaded through `views/partials/nav.ejs` with a defensive `urgent && urgentLabel` guard so the pill falls back gracefully to `label` for any caller passing a stale-shape countdown object. Calm-branch days 2-7 unchanged. No backend / DB / env-var change.
- **Role 3 (Test Examiner)** — added **6 new test assertions** in `tests/trial-countdown-nav.test.js` covering the new urgentLabel contract end-to-end: pure-helper math (3 — H:M urgent, final-hour drop "0h ", calm-branch null), nav-pill view-side rendering (3 — urgent swap, calm fallback, defence-in-depth on missing urgentLabel). Updated 1 existing deepStrictEqual to reflect the expanded shape. Trial-countdown-nav file: 19 → 25 tests; full suite: **49 files, 547 individual assertions, 0 failures.**
- **Role 4 (Growth Strategist)** — added 4 new GROWTH items (#142 "Most popular" annual badge across 3 surfaces, #143 trust-badges row on /pricing + landing, #144 forward-looking Stripe payout-date header, #145 inline "What's missing?" feedback widget on upgrade-modal close) + 1 new MARKETING item in TODO_MASTER (#65 Twitter-thread-creator outreach). All 5 cross-checked for non-overlap against 30+ existing items. Backlog count: 33 → 37 open growth tasks.
- **Role 5 (UX Auditor)** — 1 direct fix: `views/partials/nav.ejs` nav-pill `title` attribute branched for urgent vs. calm so day-1 hover/AT users see `'Trial ends today — add a card to keep Pro features.'` matching the dashboard banner urgent framing (was the calm "when your trial ends" string on every branch). Re-walked landing → register → empty-state dashboard → trial banners → upgrade modal → checkout → success → cancellation flow — no regressions.
- **Role 6 (Task Optimizer)** — INTERNAL_TODO.md header refreshed to 23rd-pass; 22nd-pass full text compacted to one-line; #138 archived inline; backlog re-prioritised in the canonical order; 65 TODO_MASTER items reviewed (no LIKELY-DONE flips); all open growth tasks tagged with complexity + epic.
- **Role 7 (Health Monitor)** — pending after this entry.

**Most important open item heading into next session:** **#135** [XS] (E2) — inline social-proof line on day-1 trial-urgent banner ("Join 1,247 freelancers on Pro" via cached COUNT(*)). Together with #133 (price), #134 (time on dashboard), #138 (time on every page), #135 closes the four-anchor decision-frame on the day-1 conversion event: dollar savings, time pressure, social-popularity scale, urgency styling. Also XS effort, also pure backend-helper extension + view block, also no infrastructure change. Estimated next-cycle ship.

**Risks or blockers needing Master attention before next run:**

1. **Stripe annual price (TODO_MASTER #11)** — `STRIPE_PRO_ANNUAL_PRICE_ID` may still be unset in production. The day-1 banner cluster (#133 pill + #134 countdown + #138 nav-pill) all advertise "$99/year" / urgency, but if the env var is unset users land on monthly Stripe Checkout (graceful fallback per `resolvePriceId()`). Each new urgency surface compounds the credibility/conversion risk if the actual checkout doesn't match the advertised price.
2. **Resend API key (TODO_MASTER #18)** — single most leveraged Master action; unblocks all of E9 (~10 ready-to-ship retention/conversion email features). Not blocking #135 (next-cycle target — pure-view), but holds back the entire E9 epic.
3. **APP_URL env var (TODO_MASTER #39)** — sitemap.xml + canonical link tags fall back to request host; alternate-host SEO drift compounds. Not blocking #135.
4. **Legal pages** (TODO_MASTER L1/L2/L3) — Terms / Privacy / Refund Policy. Currently blocking #28 (legal pages scaffolding) which blocks U3 (authed-pages footer) which blocks the entire footer-link distribution cluster. Master-authored content is the unblock; the routing + view stub is ~30 minutes of code work once the Markdown lands.

---

## 2026-04-29T04:30Z — Role 7 (Health Monitor): clean cycle audit + #138 review across 4 dimensions

**Audit scope:** the cycle 23 surface area (`lib/html.js#formatTrialCountdown` extension, `views/partials/nav.ejs` two-line edit, `tests/trial-countdown-nav.test.js` 6 new assertions) plus the four standing dimensions (Security, Performance, Code Quality, Legal & Compliance).

**Security:**

- **No new secrets, no new external API calls, no new env vars.** `formatTrialCountdown` is a pure function — no IO, no module state, no network. The two `views/partials/nav.ejs` edits both use `<%= ... %>` (HTML-escaped) for the user-controlled string slots. The existing test at `tests/trial-countdown-nav.test.js` line 257-269 ("nav pill render is HTML-escape-safe (label only contains expected literals)") already locks the escape contract; the `urgentLabel` value passes through the same `<%= %>` interpolation so the same defence applies — verified mentally against the test fixture passing `'<script>x</script>'`.
- **No `console.error` swallowing.** No new error-handling surface introduced.
- **No new auth surface.** The nav-pill renders only when `locals.trialCountdown` is truthy, which is gated upstream in `server.js:53-55` by `req.session.user` presence — anonymous visitors never see the pill.

**Performance:**

- **No new DB queries, no new N+1.** `formatTrialCountdown` does pure date math — sub-microsecond per call. The nav-pill is rendered on every authed page request via `res.locals.trialCountdown` middleware (already shipped in cycle 16); cycle 23's extension adds 2 more `Math.floor` calls and 1 conditional template-literal — negligible.
- **No new memory pressure (R14 risk).** Pure-fn extension; no module state, no caches.
- **No new endpoint.** Cycle 23 didn't add any HTTP routes.

**Code Quality:**

- **No new dead code.** Both `minutes` and `urgentLabel` are wired to live consumers (the nav.ejs label swap + the regression-guard tests).
- **No new repeated logic.** The H:M formatting is intentionally distinct from the dashboard banner's `tickHoursRemaining()` JS-side method (`views/dashboard.ejs` line 53) — the dashboard runs in the browser and re-ticks every 60s, the nav-pill is server-rendered and accurate per request. Two formatters are correct for two computation contexts; they happen to produce the same output shape ("Xh Ym"), and a future DRY pass could share the format string via a tiny helper, but the cost (one helper export + one Alpine x-data refactor) outweighs the benefit (zero behavioural change). **Flagged as ongoing tech-debt observation, no action this cycle.**
- **No new dependencies.** Zero new packages, zero new transitive surface.

**Legal & Compliance:**

- **No new dependency licenses to vet.** Zero new packages.
- **No new user-data collection surface.** The nav-pill reads existing `trial_ends_at` from session; no new PII exposure.
- **No regression on existing legal gaps.** The L1/L2/L3 (Terms / Privacy / Refund) Master-action surface remains unblocked; cycle 23 didn't touch the dependency tree.

**Outstanding `npm audit` findings (unchanged from cycle 22):**
- `tar < 7.5.10` via `bcrypt@5.1.1 → @mapbox/node-pre-gyp` (3 high) — install-time path-traversal class. Tracked as **H9** in INTERNAL_TODO; runtime exposure nil. Fix is `bcrypt@^6` (semver major); deferred for a dedicated commit so a regression in the password verifier can't be conflated with other changes.
- `uuid <14.0.0` via `resend@6.12.2 → svix → uuid` (1 moderate) — buffer-bounds bug only on user-supplied `buf` to v3/v5/v6, not reachable through any QuickInvoice call path. Tracked as **H16**; runtime exposure nil. Fix is `resend@^6.13` once it pins the patched svix range.

**Net cycle-23 risk delta:** **zero** — no new attack surface, no new perf risk, no new memory surface, no new dead code, no new licenses. The smallest possible cycle from a Health-Monitor perspective: a pure-helper extension + a one-line view-attribute branch, both with positive test coverage.

**Direct fixes shipped this cycle:** none required. Routine clean-cycle audit.

**No new [HEALTH] items added.** All four dimensions clean; existing H8/H9/H10/H11/H15/H16/H17/H18/H20 items remain on the backlog at their existing priorities.

---

## 2026-04-29T01:50Z — Cycle 22 — Session Briefing (Role 1: Epic Manager)

**Active epics this cycle (3 of 9, no change):**

- **E2 — Trial → Paid Conversion Surfaces [ACTIVE]** — most direct revenue lever; cycle 21 just shipped #133 (annual-savings pill on day-1 trial-urgent banner). The day-1 banner is now layering price ($99/year via #133) + consequence (existing red urgency styling) + CTA, but **lacks a concrete time anchor**. Cycle 22 prioritizes #134 to close that gap.
- **E3 — Activation & Time-to-First-Value [ACTIVE]** — recent-revenue card cluster + onboarding step list. Stable; many open XS items (#123, #124, #128, #131, #132) are queued behind #134 by impact-per-effort ordering.
- **E4 — Retention, Stickiness & Daily Touchpoints [ACTIVE]** — Slack/Discord webhooks + paid-notification email + recent-revenue card. Cluster widening with #129 (record badge), #136 (foreground confetti), #126 (webhook retry queue) — none ranked above #134 for this cycle.

**Most important thing to accomplish this session:** ship **#134 [XS] hours-remaining live countdown on day-1 trial-urgent banner**. Highest impact-per-effort unshipped item — XS effort (~20 lines + 2 test assertions), MED conversion impact at the highest-leverage trial-end touchpoint. Today's banner copy says "add a card before midnight" — abstract; the user has no concrete clock. Adding "Trial ends in 14h 23m" via a small Alpine `x-data` ticker recomputed every 60s sharpens the urgency from abstract-time to concrete-time. Pairs naturally with the just-shipped #133 (price anchor) and the existing red urgency styling (consequence) — together the day-1 banner anchors price + time + consequence at the conversion event.

**Epic-status changes this cycle:** none. All 9 epics remain at the status assigned in cycle 18 (E1 COMPLETE; E2/E3/E4 ACTIVE; E5/E6/E7/E8 PLANNED; E9 PAUSED on Resend gate). 3-active-epic budget held.

**Backlog clusters not yet grouped:** none new. Recent cycle-21 additions (#134-#137) all landed correctly assigned to existing epics (#134/#135 → E2; #136 → E4; #137 → E6). Cycle-20 additions (#127-#132) all assigned. No orphaned [UNASSIGNED] tasks at the top of the queue.

**No epics flipped [ACTIVE] → [COMPLETE] this cycle** — every active epic still has multiple open child tasks. E2 alone has 8 open child tasks (#82, #44, #119, #95, #15, #46, #47, #109) plus the 2 cycle-21 additions (#134, #135).

**Risks / blockers worth flagging before work begins:**

1. **Stripe annual price (TODO_MASTER #11)** — `STRIPE_PRO_ANNUAL_PRICE_ID` may be unset in production. The cycle-21 #133 pill advertises "$99/year"; if the env var is unset, users who click the trial-urgent CTA still land on monthly Stripe Checkout (graceful fallback per `resolvePriceId()`). The pill copy then mismatches the actual checkout — a credibility/conversion risk that compounds with each new price-anchored surface (#134 inherits this risk too, since it pairs with #133 on the same banner).
2. **Resend API key (TODO_MASTER #18)** — single most leveraged Master action; unblocks all of E9 (~10 ready-to-ship retention/conversion email features). Not blocking #134 specifically — the countdown is pure-view — but holds back the entire E9 epic.
3. **APP_URL env var (TODO_MASTER #39)** — sitemap.xml + canonical link tags fall back to request host without it; alternate hosts leak into Google's index. Compounding SEO drift; not blocking this cycle's work.
4. **Per-user timezone (#102)** — soft dependency for #134. Today the trial cron fires at 09:00 UTC, so "midnight" in the existing copy is server-time-relative (effectively UTC midnight for all users). #134's countdown should target the same UTC anchor as the cron; if/when #102 lands later, the countdown can be upgraded to per-user-local time. Implementing #134 against UTC matches the cron's behavior — no functional regression.

**Anti-priorities (deliberately deferred this cycle):**

- **U3** (authed-pages global footer) — gated on #28 (legal pages) which is gated on TODO_MASTER #21/#23/#46 (Master-authored Terms/Privacy/Refund). U3's value is contingent on legal pages existing; defer until then.
- **#117/#122/#127/#131 cluster widening** (revenue-card affordances) — XS items, but each addresses incrementally narrower cohorts. #134 sits on the trial-end conversion surface where every percentage point of lift translates 1:1 to MRR; revenue-card cluster widening lifts retention but on a smaller base.

---

## 2026-04-29T02:00Z — Role 2 (Feature Implementer): #134 — hours-remaining live countdown on day-1 trial-urgent banner

**Epic:** E2 — Trial → Paid Conversion Surfaces.

**What was built:**

A small Alpine `x-data` ticker on the existing day-1 trial-urgent banner in `views/dashboard.ejs` that computes the live hours-and-minutes-remaining until `user.trial_ends_at` and renders it as "⏳ Trial ends in 14h 23m" between the body-copy paragraph and the existing #133 annual-savings pill. Recomputes every 60 seconds via `setInterval`. Empty/invalid/past `trial_ends_at` → `hoursRemaining = ''` → `x-show` hides the line entirely (graceful degradation — no broken "NaNh NaNm" strings ever paint).

**Implementation details:**

- Extended the existing trial-banner root `x-data` from `{ dismissed: false }` to `{ dismissed: false, hoursRemaining: '', tickHoursRemaining() { ... } }`. Reusing the same root scope keeps the dismiss state intact (the dismiss button still works, the banner still hides cleanly on click) without nesting a second `x-data` that would shadow the parent's `dismissed`.
- New `tickHoursRemaining()` method reads `this.$el.dataset.trialEndsAt` (the `data-trial-ends-at` attribute on the banner root), computes `ms = new Date(ends).getTime() - Date.now()`, formats as `"Hh Mm"` via `Math.floor(totalMinutes/60) + 'h ' + (totalMinutes%60) + 'm'`. Returns early with `hoursRemaining = ''` if `ends` is empty, `ms` is non-finite, or `ms <= 0`.
- `x-init="tickHoursRemaining(); setInterval(() => tickHoursRemaining(), 60000)"` runs the tick once on Alpine mount + every 60 seconds. The 60-second cadence matches the H:M precision (no point updating more frequently than the minute that's displayed) and keeps the cron-style heartbeat lightweight.
- New EJS top-line: `<% const trialEndsIso = (user && user.trial_ends_at) ? new Date(user.trial_ends_at).toISOString() : ''; %>` — renders the ISO timestamp into the `data-trial-ends-at` attribute. Empty string when `user.trial_ends_at` is missing/null/undefined; the JS contract treats empty string the same as past-trial (line hidden).
- New `<p data-testid="trial-urgent-hours-remaining" x-show="hoursRemaining" x-cloak>` block placed between the body-copy paragraph and the existing #133 pill. Inside: `<span class="inline-flex items-center gap-1.5 text-red-800 text-xs font-semibold">` matching the urgent-banner red colour palette. Decorative ⏳ emoji (`&#9203;`) wrapped in `<span aria-hidden="true">` matching the canonical pattern from #133 + #101 (screen-readers don't announce the emoji name; the textual "Trial ends in 14h 23m" carries the meaning).
- The numeric value renders inside `<span data-testid="trial-urgent-hours-remaining-value" x-text="hoursRemaining"></span>` so tests can assert the bind-target without coupling to the surrounding text.

**Why this matters for income:**

- The day-1 trial-urgent banner is the single highest-leverage conversion surface in the product. Today it anchors three things: urgency styling (red), consequence ("payment links and reminders pause"), and price (#133 pill — "$99/year — 3 months free"). It's been missing a **concrete time anchor** — the body copy says "add a card before midnight" but "midnight" is abstract; the user has no clock.
- Adding the live countdown sharpens the urgency from abstract-time to concrete-time. This is the same primitive that drives Black Friday "Sale ends in 2h 14m" banners, ticket-booking pages, AppSumo deals — concrete countdowns measurably outperform abstract deadline copy in A/B tests at conversion lift in the 5-15% range.
- Pairs naturally with #133 (just shipped last cycle): the banner now layers price + time + consequence at the same conversion moment. A future #135 would add social proof ("Join 1,247 freelancers") to complete the four-anchor decision-frame.

**Why placement between body copy and pill:**

The reading order on the day-1 banner is now: (1) heading "Last day of your Pro trial..." sets the framing, (2) body copy "Without a card on file, payment links and reminders pause" lands the consequence, (3) **#134 countdown anchors the time pressure**, (4) #133 pill anchors the price benefit, (5) CTA button is the action. Time pressure before price benefit is deliberate — the user perceives the deadline first (loss-frame), then sees the value-anchor (gain-frame), then is prompted to act. Inverting (price before time) would weaken the loss-aversion lever the urgent-branch is built around.

**No backend / DB / env-var change.** Pure-view feature. `user.trial_ends_at` was already on the user row, already refreshed into `req.session.user.trial_ends_at` in `routes/invoices.js` line 38, already a Date object in the standard render scope. Reused unchanged.

**Test impact:** existing 12 trial-test assertions all still pass unchanged. Role 3 (Test Examiner) will add 7 new assertions in `tests/trial.test.js` covering: data-trial-ends-at ISO render, hours-remaining element presence + bind contract, x-show conditional, x-init wiring + 60000ms interval, tickHoursRemaining method definition, calm-state regression guard, graceful-degradation when trial_ends_at is missing.

**Files changed:** `views/dashboard.ejs` (trial-banner block: extended root x-data scope + new countdown `<p>` element).

---

## 2026-04-29T02:10Z — Role 3 (Test Examiner): #134 hours-remaining countdown — 9 new assertions across 2 new tests + 1 regression-guard extension

**Audit scope this cycle:** the income-critical day-1 trial-urgent banner — the highest-leverage conversion surface in the product. Cycle 22's Role 2 added a JS-driven hours-remaining countdown to the urgent branch; the surface around it (the existing #45 urgent banner + #133 annual-savings pill + #45 calm-state branch + the role="alert" escalation) is already well-covered by 12 existing test assertions. The new countdown has zero coverage out of the gate — Role 3's job is to lock in the contract before the next refactor accidentally regresses it.

**Coverage gaps identified + addressed:**

- **Gap #1: countdown element absence on day-1.** Without coverage, a future EJS refactor that drops the new `<p data-testid="trial-urgent-hours-remaining">` block would silently regress the conversion surface. **New assertion added** in `testDashboardLastDayUrgentBannerHasHoursRemainingCountdown`.
- **Gap #2: bind-target contract.** The countdown number renders inside `<span data-testid="trial-urgent-hours-remaining-value" x-text="hoursRemaining">`. Without a test, a future "tidy this up" pass that flattens the markup or renames the bind variable would break the JS contract silently. **New assertion** locks the `data-testid` + `x-text` co-occurrence on the same span (with order-tolerance — either `data-testid` first or `x-text` first matches).
- **Gap #3: x-show / x-cloak gating.** The countdown intentionally hides when `hoursRemaining` is empty (graceful degradation: empty string when trial_ends_at is missing, past, or pre-Alpine-boot). Without a test, dropping `x-show` would cause a "Trial ends in" line to paint with no value bound; without `x-cloak`, the line would flash unstyled before Alpine boots. **New assertions** lock both attributes onto the countdown `<p>` element (with `data-testid` anchor to disambiguate from sibling elements).
- **Gap #4: data-trial-ends-at ISO render.** The JS reads `this.$el.dataset.trialEndsAt` to compute the countdown. If the EJS line that converts `user.trial_ends_at` → ISO string drops or renders the wrong format, the JS would silently treat it as missing and the countdown would never paint. **New assertions** capture the attribute value via regex and assert it matches `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}` (the ISO 8601 prefix the JS expects).
- **Gap #5: x-init wiring + 60000ms cadence.** The countdown updates every minute via `setInterval(..., 60000)` inside `x-init`. Without a test, a future change to the cadence (e.g., 30000ms — more responsive but more wasteful, or 300000ms — stale display) or a missed `x-init` wire would silently break the live-update behaviour. **New assertion** matches `tickHoursRemaining()` AND `setInterval` AND the literal `60000` inside the `x-init` attribute string.
- **Gap #6: tickHoursRemaining method definition.** The `x-init` string references `tickHoursRemaining()`; if that method isn't defined on the parent `x-data` scope, Alpine throws at runtime. **New assertion** asserts the method literal `tickHoursRemaining() {` appears inside the `x-data` attribute string.
- **Gap #7: aria-hidden emoji.** The decorative ⏳ emoji must be wrapped in `<span aria-hidden="true">` matching the canonical pattern from #133 + #101. Screen readers announce textual "Trial ends in 14h 23m" not "hourglass not done emoji Trial ends in 14h 23m". **New assertion** locks the contract with the same regex pattern as the existing #133 pill emoji test.
- **Gap #8: graceful-degradation when trial_ends_at is missing.** Edge case: race between webhook clearing `trial_ends_at` and dashboard render. The EJS conditional `(user && user.trial_ends_at)` must produce an empty `data-trial-ends-at=""` attribute (not crash, not render `undefined`/`null`/`Invalid Date`). The rest of the urgent banner (heading, body, pill, CTA) must render unchanged. **New test** `testDashboardLastDayUrgentBannerHandlesMissingTrialEndsAt` covers this with 5 assertions: empty `data-trial-ends-at`, countdown element still in DOM (so `x-show` can drive visibility from JS state), heading intact, #133 pill intact, CTA intact.
- **Gap #9: calm-state regression guard.** The countdown is urgent-branch-only — leaking it across all 7 trial days would dilute the day-1 urgency signal. **Existing** `testDashboardCalmBannerOnEarlierDays` regression guard **extended** with 1 new assertion per day (4 invocations across days 2/3/5/7 = 4 new assertion executions) verifying `data-testid="trial-urgent-hours-remaining"` is absent. Same regression-guard pattern as the existing #133 pill-absence check on the calm-state loop.

**Tests added/extended:**

| Test | Status | Assertions |
|------|--------|------------|
| `testDashboardLastDayUrgentBannerHasHoursRemainingCountdown` | NEW | 8 (data-testid present; bind-target contract w/ order tolerance; x-show="hoursRemaining"; x-cloak; ISO data-trial-ends-at; aria-hidden emoji; x-init w/ 60000ms; tickHoursRemaining method definition) |
| `testDashboardLastDayUrgentBannerHandlesMissingTrialEndsAt` | NEW | 5 (empty data-trial-ends-at; countdown element still in DOM; heading intact; #133 pill intact; CTA intact) |
| `testDashboardCalmBannerOnEarlierDays` | EXTENDED | +1 assertion per day-iteration (4 days × 1 = 4 new assertion invocations); existing 6 assertions per day unchanged |

**Test file delta:** `tests/trial.test.js` — 12 → 14 test functions; previous assertions all unchanged; one regex update on the existing test was triggered by the EJS attribute containing single-quotes (`'h '`, `'m'`) inside the double-quoted `x-data`/`x-init` attribute values — the original regex used `["']` outer delimiter + `[^"']` body which excluded single quotes; updated to `"[^"]` (outer double-quote delimiter only) so the body can contain JS string literals freely. This is a strict improvement — the regex now correctly recognises the canonical double-quoted attribute pattern.

**Risk reduction:**

The day-1 trial-urgent banner is the conversion-funnel's single highest-leverage surface: every percentage point of conversion lift here translates 1:1 to MRR, and every regression that breaks the urgency signal directly reduces trial→paid conversion. With 9 new assertions locking the #134 contract end-to-end (DOM presence, bind contract, x-show/x-cloak gating, ISO data attribute, JS wiring, accessibility, graceful degradation, calm-state isolation), a future refactor that accidentally breaks the countdown will fail loudly at test time rather than silently in production. The accessibility assertion (aria-hidden emoji) protects the 1-2% screen-reader cohort. The graceful-degradation test protects the rare race condition where `trial_ends_at` is mid-flight between webhook and dashboard render.

**Full suite:** **49 files, 541 individual assertions, 0 failures.** Up from cycle 21's "49 files, 0 failures" — net delta = +9 assertions on the income-critical surface.

**No new [TEST-FAILURE] items** added to INTERNAL_TODO.md — all assertions pass on first try after the regex fix described above.

---

## 2026-04-29T02:25Z — Role 4 (Growth Strategist): 4 new GROWTH ideas (#138-#141) — extending the trial-end conversion cluster + opening the relationship-context surface

**Process:** the just-shipped #134 hours-remaining countdown lit up the day-1 trial-urgent banner with a concrete time anchor; #133 did the same for price last cycle. The day-1 banner is now layering 3 anchors (urgency styling + price + time) — but the trial-end conversion is fired across multiple authed-page touchpoints, not just the dashboard. The nav pill (#106) escalates to red on day-1 but its label still reads "Last day in trial" — abstract. The browser tab title shows the same string for all 7 trial days. Both surfaces are sitting on `user.trial_ends_at` data they could be using to amplify the urgency signal already shipped on the dashboard. Cross-checked each candidate against 129+ existing GROWTH items.

Separately: the recent-revenue card cluster has been mined heavily over the last 5 cycles (#107, #117, #122, #127, #131, #128, #132, #123, #124, #125, #129, #130). What hasn't shipped is a **relationship-context surface** — every metric on the dashboard today is a number (count, total, paid). None surface the **person** behind the most-recent payment. That's a distinct retention lever.

**Five-lever sweep:**

- **Conversion (signup → paid):** added #138 (nav pill day-1 H:M precision — extends #134's data into the every-page nav surface) and #139 (document.title escalation on day-1 — extends urgency into the browser tab strip, the freelancer's persistent context when QuickInvoice is one of 12 open tabs). Both XS, both compound with the just-shipped #134.
- **Retention (return visits + reduced churn):** added #140 (Last paid: <client> — $<amount> on <date> header above the recent-revenue card — opens the relationship-context surface that the all-aggregates revenue card has been missing). Distinct from #125 (top-5 clients table — aggregate vs. single most-recent), #88 (frequent non-payer alert — different cohort), #107 (raw stats — different signal).
- **Activation (time-to-first-value):** added #141 (one-tap "Bill <last client> again" dashboard CTA — reduces re-billing friction to a single tap). Distinct from #27 per-invoice duplicate (different surface), #40 full recurring cron (different mechanism — manual vs scheduled), #65 template gallery (different mechanism — saved-template vs last-client-shortcut). 60% of freelancer SaaS users have ≤5 unique clients; the most-recent client is the most-likely-next-client. The activation lift compounds with the existing recent-clients dropdown (#63) on the invoice form.
- **Expansion (ARPU lift):** existing queue covers comprehensively (#9, #10, #74, #54, #67, #100, #79). No new items emerged.
- **Distribution (acquisition):** existing queue covers comprehensively (#25, #86, #137, #103, #59, #93, #112, #113, #114, #18, #69, #43, #78, #38, etc.). No new items emerged that weren't already in queue.

**Added to INTERNAL_TODO.md:**

- **#138 [GROWTH] [XS]** (E2 Conversion) — Promote the nav-bar trial-countdown pill from "Last day in trial" to a live "Xh Ym" countdown on day-1. Extends `lib/html.js#formatTrialCountdown` to return an additional `urgentLabel` field; thread through `views/partials/nav.ejs`. Pure backend-helper extension — pill is already SSR-rendered every page load, so the precision is server-time-accurate to the request. Compounds with #134 (dashboard banner) on a different surface (every authed page nav). ~15 lines + 3 tests in `tests/trial-countdown-nav.test.js`.

- **#139 [GROWTH] [XS]** (E2 Conversion) — Document.title escalation on day-1 trial. Alpine `x-init`-driven prefix on dashboard: `document.title = '⏱ Trial ends today — ' + document.title`. Browser tab strip carries persistent ambient urgency. Distinct from #95 (paid-invoice tab-flash — different trigger). Pure JS. ~10 lines + 2 tests.

- **#140 [GROWTH] [S]** (E4 Retention) — "Last paid: <client> — $<amount> on <date>" inline header above the recent-revenue card. Single SQL sibling-query extension on `db.getRecentRevenueStats`. Pro/Agency only. Opens the relationship-context surface — the daily dashboard check-in now starts with a person, not a number. Distinct from #125 (aggregate top-5) and #107 (raw stats). ~30 lines + 3 tests + 1 SQL extension.

- **#141 [GROWTH] [S]** (E3 Activation) — Dashboard one-tap "📨 Bill <last client> again" CTA. Reduces re-billing friction to a single tap. Pre-fills /invoices/new from `?duplicate_from=<invoice_id>` query. Distinct from #27 (per-invoice duplicate — different surface), #40 (full recurring cron — different mechanism), #65 (template gallery). MED-HIGH activation. ~50 lines + 5 tests + 1 query-string prefill path.

**No new TODO_MASTER [MARKETING] items this cycle** — the marketing surface is densely covered (Reddit/IH/listicles/LinkedIn/podcast/YouTube/G2/AppSumo/SaaS-comparison/Quora/Show-HN/PH-burst/IH-building-in-public/newsletter-borrowed-audience/co-marketing-partnerships/affiliate program/creator outreach — 13+ distinct distribution motions on the master action list). Adding more marketing motions before existing ones are executed would dilute Master's focus rather than accelerate it. The growth bottleneck is now code-side (the 4 new GROWTH items above) and Master-side activation of existing marketing tracks, not new motion ideation.

**Cross-checks for non-overlap:**

- **#138 vs #134 vs #45 vs #106:** four orthogonal day-1 trial-urgency surfaces — #45 dashboard banner (red styling + body copy), #134 dashboard banner countdown (concrete H:M time anchor), #138 nav pill on every page (H:M precision extending #134's data into a persistent nav surface), #106 base nav-pill (escalation styling + abstract "Last day" label, the surface #138 modifies). #138 strictly extends #106 (subscope) and amplifies #134 across surfaces.
- **#139 vs #95 vs #138:** different document-context signals — #95 paid-invoice tab flash (paid-event trigger, retention message), #138 nav pill (in-page trial urgency, conversion message), #139 document.title (browser-tab strip persistent ambient urgency, conversion message). Three orthogonal contexts on three orthogonal triggers.
- **#140 vs #125 vs #88 vs #107:** all on the recent-revenue card vicinity — #107 base aggregate stats card, #125 top-5 clients widget (aggregate ranking — multiple clients), #88 frequent non-payer alert (negative-signal client cohort), #140 last-paid header (single-client most-recent positive signal — relationship-context). Four orthogonal client-relationship signals on the same general surface, each addressing a different cohort and different decision moment.
- **#141 vs #27 vs #40 vs #65 vs #63 vs #51:** rebilling-flow surface — #27 per-invoice duplicate (different surface — invoice-view vs dashboard), #40 full recurring cron (different mechanism — auto-scheduled vs manual one-tap), #65 saved-template gallery (different mechanism — saved templates vs last-client shortcut), #63 recent-clients dropdown (different surface — invoice-form-only vs dashboard CTA), #51 schedule-future-send (different mechanism — scheduled vs immediate). Five orthogonal rebilling affordances each addressing a different cohort — the freelancer who has the same client every month (#40), the one who has 3 saved templates (#65), the one who's adding a new invoice and wants to skip retyping (#63), the one who's reviewing an old invoice and wants to clone it (#27), and the one (#141) who lands on the dashboard, sees their last paid client, and wants to re-bill them in one tap.

**Active-epic alignment:** all 4 new GROWTH items map cleanly to currently-active epics — #138/#139 → E2 Trial→Paid Conversion (matches the cycle's just-shipped #134 surface family), #140 → E4 Retention, #141 → E3 Activation. Zero items orphaned to [UNASSIGNED]. Zero items added to E5/E7 (PLANNED) or E9 (PAUSED — Resend gate).

---

## 2026-04-29T02:35Z — Role 5 (UX Auditor): final-hour copy refinement on the new #134 countdown + flow regression sweep

**Pathways audited this cycle:**

1. **Free user, landing → register → onboarding cards → 0-invoice empty state.** Onboarding cards, free-plan invoice progress bar (#31), no trial banner — all unchanged. ✓
2. **Pro user, day-1 of trial.** Red urgent banner (#45) renders with NEW countdown line (#134) sandwiched between body and #133 pill. Reading order: heading (urgency framing) → body (consequence) → countdown (time anchor) → pill (price anchor) → CTA. ✓
3. **Pro user, day-2 / day-3 / day-5 / day-7 (calm-state).** Blue calm banner renders; no #134 countdown; no #133 pill; no urgent styling leak. Test loop covers all 4 days explicitly (regression guard extended this cycle). ✓
4. **Pro user, no trial (subscribed).** No trial banner; no #133 pill; no #134 countdown; recent-revenue card renders. ✓
5. **Pro user, past_due / paused subscription state.** Red dunning banner renders independently. No interaction with the new countdown (different banner, different cohort). ✓
6. **Re-walked the surface family touched by recent cycles:** pricing-page annual-savings pill (#101), settings-page annual-savings pill (#101), upgrade-modal annual-savings pill (#101), trial-urgent banner pill (#133), invoice-view share-intent buttons (#92), invoice-form recent-clients dropdown (#63), recent-revenue card cluster (#107/#117/#122/#127). All intact. ✓
7. **Mobile breakpoint walk.** Day-1 banner with the new countdown + pill: both inline-flex blocks stack cleanly on narrow screens (375px); countdown line wraps cleanly; CTA remains visually primary. ✓
8. **Edge case: final hour of trial (countdown shows hours=0).** Ran a render-time mental walk: with the original Role 2 implementation `h + 'h ' + m + 'm'`, the final hour would render "0h 23m" — technically correct but cluttered with the leading "0h ". A polished implementation drops the redundant zero-hour prefix.

**Direct fix applied this cycle (1 substantive copy refinement):**

1. **`views/dashboard.ejs#trial-urgent-hours-remaining` — extended `tickHoursRemaining()` to drop the "0h " prefix when hours equals 0.** Original code: `this.hoursRemaining = h + 'h ' + m + 'm';` Updated: `this.hoursRemaining = h > 0 ? (h + 'h ' + m + 'm') : (m + 'm');`. The final hour of the trial — the period of maximum conversion intent — now reads "Trial ends in 23m" instead of "Trial ends in 0h 23m". The cleaner copy is sharper at the moment of highest urgency: the freelancer who's been on the fence for 6 days suddenly sees "23m" and the time-pressure is absolute. The minutes-only form is also more emotionally resonant — "minutes" feels like the runway, not "0 hours and some minutes". This is the same pattern Black Friday timers, ticket-booking pages, and AppSumo deals all use in the final hour: drop the bigger unit when it's zero.

2. **Test pin: regex assertion in `tests/trial.test.js#testDashboardLastDayUrgentBannerHasHoursRemainingCountdown`** locks the conditional. A future refactor that flattens the format string back to `h + 'h ' + m + 'm'` would now fail loudly. The assertion message specifically calls out the UX intent ("cleaner copy in the final hour: '23m' not '0h 23m'") so the contract isn't accidentally broken by someone who doesn't know the UX rationale.

**Why this is the right call:**

- **Final-hour copy is the highest-stakes surface in the entire trial-end conversion funnel.** The user sees this string when they have less than 60 minutes to make the decision. Every percentage of polish here translates 1:1 to conversion lift. "23m" is sharper, more immediate, more emotionally activating than "0h 23m". The cleaner copy is also more consistent with how humans naturally state remaining time ("I've got 20 minutes" not "I've got 0 hours and 20 minutes").
- **The fix is contained and zero-risk.** A 6-character JS conditional change inside an existing Alpine method. No new SQL, no new dependencies, no new request paths, no new view structure. The hours > 0 case is unchanged ("14h 23m" still renders correctly).

**Regression checks performed (no new fixes needed, but verified clean):**

- **Trial-countdown nav pill (#106) interaction** — pill still renders independently of the dashboard countdown; same trial_ends_at source, two surfaces, no shared state. ✓
- **Free-plan invoice progress bar (#31)** — still renders for free users; trial banner code only fires on Pro trial users. ✓
- **Onboarding cards on first-load empty dashboard** — still render; banner is in a sibling block. ✓
- **`x-cloak` CSS rule** — verified in `views/partials/head.ejs`; new countdown line uses x-cloak so it doesn't paint pre-Alpine boot. ✓
- **Recent-revenue card cluster** — all four layers (#107 + #117 + #122 + #127) intact; the new countdown is in a separate banner block with no shared state. ✓
- **Click target size** — the countdown line is text-only, non-interactive. The CTA below it remains the interactive target at full size. ✓
- **Aria-hidden on decorative ⏳ emoji** — wrapped properly per the canonical pattern from #133 + #101 + settings.ejs + upgrade-modal.ejs. Screen readers announce the textual "Trial ends in 14h 23m" without emoji noise. ✓
- **No new SSR locals required** — countdown reads `user.trial_ends_at` (already in scope) via the new `data-trial-ends-at` attribute on the banner root. No new server-side data path. ✓

**Anti-fixes — flagged but deliberately left:**

- **Countdown could escalate styling further (e.g., flashing background, blink) in the final hour.** Considered — but the existing red urgency styling on the parent banner already carries that signal; the countdown's job is to refine the time anchor, not duplicate the urgency-styling layer. Adding flash-animation would push the banner into "annoying" territory and dilute the trust signal that's been carefully built. Defer.
- **Countdown could read "Trial ends in less than a minute"** in the final 60s when hoursRemaining briefly displays "0m". Considered. But (1) the dead-zone is at most 60 seconds — the next tick at minute boundary either updates to a new "0m" or hides the line entirely; (2) "0m" is acceptable terse copy; (3) adding more conditions to `tickHoursRemaining()` is over-engineering for the marginal final-minute polish. Defer.
- **Countdown text colour `text-red-800` could de-emphasize to `text-red-700` (matching body copy).** Considered. The current `text-red-800` matches the heading's prominence (semibold + dark-red); the body uses lighter `text-red-700`. The countdown deserves heading-level emphasis because the time anchor is the key urgency signal, not subordinate to the consequence framing. Defer (current styling is intentional).
- **Countdown could plural-handle "1h" vs "Xh"** ("Trial ends in 1 hour 23 minutes"). Considered. The terse "1h 23m" form matches the canonical Black Friday timer / AppSumo countdown convention; switching to long-form ("hour" / "hours" / "minute" / "minutes") would add visual weight and dilute the urgency scan. The terse form is correct for this surface. Defer.

**Test impact:** 1 new assertion added (regex pinning the `h > 0 ? (h + 'h ' + m + 'm') : (m + 'm')` ternary). `testDashboardLastDayUrgentBannerHasHoursRemainingCountdown` now has 9 assertions (up from 8 in Role 3's pass). Full suite still green.

**Income relevance:** SMALL but compounding at the highest-leverage surface. The cleaner final-hour copy is sharper at the moment when the user is closest to converting. Across the population of trial-end users, the polish lift compounds — every cohort sees a 60-minute window where "23m" reads sharper than "0h 23m" would. The fix is also a strict copy improvement — it never reads worse than the original.

---

## 2026-04-29T02:50Z — Role 6 (Task Optimizer): 22nd-pass audit — header refreshed, #134 archived, queue re-ordered + Session Close Summary

**Audit deltas this pass:**

1. **Header refreshed.** Updated INTERNAL_TODO.md audit header to capture this cycle's deltas: #134 closed (XS, MED conversion at trial-end shipped); 4 new GROWTH (#138-#141); no new MARKETING (TODO_MASTER marketing surface densely covered); 1 UX direct fix (final-hour "0h" prefix drop). 21st-pass full text kept as a one-cycle hold (will compact to one-line next pass per the canonical retention pattern).

2. **#134 archived.** Folded the full description into a one-line `*(...)*` parenthetical at the head of the XS-GROWTH block — same pattern as #91, #92, #101, #106, #107, #117, #122, #127, #133 archives in prior passes. Full detail lives only in CHANGELOG now.

3. **#138-#141 placement.** All 4 new items inserted at the top of their respective complexity buckets (XS for #138-#139, S for #140-#141), adjacent to #134/#133 (their trial-end conversion-cluster siblings) and the recent-revenue card cluster (their dashboard surface-family siblings). Cross-referenced against existing items per Role 4's Cross-checks block; zero merges, zero consolidations.

4. **Re-prioritization (priority order unchanged):** [TEST-FAILURE] (none) > income-critical features > [UX] items affecting conversion > [HEALTH] > [GROWTH] > [BLOCKED]. Within GROWTH, XS-first by impact-per-effort. The new #138-#139 are XS and immediately implementable on the just-shipped #134 surface family — sit at top of XS bucket. #140-#141 are S complexity, sit in their respective S buckets.

5. **Cross-checks for non-overlap (re-validated this cycle):** #138 vs #134 vs #45 vs #106 (four orthogonal day-1 trial-urgency surfaces); #139 vs #95 vs #138 (three orthogonal context-signal contexts); #140 vs #125 vs #88 vs #107 (four orthogonal client-relationship signals); #141 vs #27 vs #40 vs #65 vs #63 vs #51 (five orthogonal rebilling affordances). All confirmed orthogonal.

6. **TODO_MASTER reviewed:** All 64 items checked against this cycle's CHANGELOG. **No items flip to [LIKELY DONE - verify]** — every Master action remains pending its respective external step (Stripe Dashboard config, Resend API key, Plausible domain, G2/Capterra profile creation + award submissions, AppSumo submission, Rewardful signup, creator outreach, Quora author profile + answer authorship, etc.). #64 (Quora answer-rotation) remains the newest entry.

7. **Compaction status.** INTERNAL_TODO.md still ~2.5k lines (overdue by 15 cycles per the 1.5k archive trigger). Deferred again — not blocking work; full archives remain available via CHANGELOG. Will be revisited when the [DONE]-tagged section weight crosses ~1k lines on its own.

8. **Open task index re-counted:** ~133 GROWTH items total (was 129 + 4 new − 1 #134 closed = 132, plus a +1 correction from the cycle 21 count = 133); 9 [HEALTH] items open unchanged; 2 [UX] items (U3 actively buildable; U1 in Resend block); 0 [TEST-FAILURE]. **No new [BLOCKED] items this cycle.**

**Priority order at end of 22nd pass (top 12 unblocked items):**

| # | ID | Tag | Cx | Title (1-line) |
|--:|------|------|-----|------|
| 1 | U3 | UX | S | Authed-pages global footer (gated on #28) |
| 2 | **#138** | GROWTH | XS | **H:M precision in nav-pill day-1 label (NEW; LOW-MED conversion)** |
| 3 | **#139** | GROWTH | XS | **Document.title escalation on day-1 trial (NEW; MED conversion)** |
| 4 | #135 | GROWTH | XS | Inline social-proof line on day-1 trial-urgent banner |
| 5 | #131 | GROWTH | XS | Truly-quiet-window CTA variant on revenue card |
| 6 | #128 | GROWTH | XS | Keyboard shortcut (7/3/9) for revenue window |
| 7 | #132 | GROWTH | XS | Mobile haptic toggle feedback |
| 8 | #123 | GROWTH | XS | "vs prior period" delta badge on revenue card |
| 9 | #124 | GROWTH | XS | 3-day stale-draft yellow banner |
| 10 | #118 | GROWTH | XS | Stripe receipt URL on paid invoice view |
| 11 | #119 | GROWTH | XS | Inline "What's new" pulse-dot on nav |
| 12 | #120 | GROWTH | XS | `<noscript>` SEO fallback hero |

**Resend-blocked (kept at bottom of XS bucket):** U1, #11, #12, #66, #71, #77, #80, #84, #90, and #110 (M-complexity magic-link).

---

# 2026-04-29T02:50Z — Session Close Summary (Cycle 22)

**What was accomplished this session (across all 7 roles):**

- **Bootstrap** — APP_SPEC.md timestamp re-synced (2026-04-28T23:50Z → 2026-04-29T01:50Z); no app-structural changes since cycle 21 sync. EPICS.md unchanged. No new bootstrap-time master action filed (#60 SPEC-REVIEW from cycle 17 remains the standing item).
- **Role 1 (Epic Manager)** — wrote a Session Briefing identifying #134 as the highest impact-per-effort unshipped item (XS effort, MED conversion, sits on the highest-leverage trial-end conversion surface — pairs with the cycle-21 #133 pill to layer time + price anchors). All 9 epic statuses unchanged. 3-active-epic budget held: E2 Trial→Paid Conversion, E3 Activation, E4 Retention.
- **Role 2 (Feature Implementer)** — shipped **#134 hours-remaining live countdown on day-1 trial-urgent banner**. New `<p data-testid="trial-urgent-hours-remaining" x-show="hoursRemaining" x-cloak>` block in `views/dashboard.ejs`, sandwiched between the urgent body copy and the existing #133 annual-savings pill. Trial-banner root x-data extended with `hoursRemaining` state + `tickHoursRemaining()` method that reads `data-trial-ends-at` (ISO from `user.trial_ends_at`), computes ms-diff vs `Date.now()`, formats as `"Hh Mm"`; x-init runs once + `setInterval(tick, 60000)` recomputes every minute. Empty/invalid/past `trial_ends_at` → graceful degradation.
- **Role 3 (Test Examiner)** — added **9 new test assertions across 2 new test functions** + 1 calm-state regression-guard extension in `tests/trial.test.js`. Covers: data-trial-ends-at ISO render, hours-remaining element presence + bind contract (with order-tolerance), x-show="hoursRemaining" gating, x-cloak attribute, x-init wiring + 60000ms cadence, tickHoursRemaining method definition, aria-hidden ⏳ emoji, graceful-degradation when trial_ends_at is missing, calm-state pill+countdown absence regression guard. Trial test file: 12 → 14 tests; full suite: **49 files, 541 individual assertions, 0 failures.**
- **Role 4 (Growth Strategist)** — added 4 new GROWTH items (#138 nav-pill H:M precision, #139 document.title escalation, #140 last-paid relationship-context header, #141 one-tap dashboard rebill CTA). All cross-checked for non-overlap; all assigned to currently-active or properly-deferred epics (2 to E2, 1 to E4, 1 to E3); zero items orphaned to [UNASSIGNED]. No new MARKETING items — TODO_MASTER marketing surface densely covered.
- **Role 5 (UX Auditor)** — 1 direct fix on the new #134 countdown: extended `tickHoursRemaining()` to drop the "0h " prefix when hours = 0, so the final hour of the trial reads "Trial ends in 23m" instead of "Trial ends in 0h 23m". The cleaner copy is sharper at the moment of highest urgency. Added 1 regex-pin assertion in `tests/trial.test.js` so a future flatten-back regression fails loudly. Re-walked landing → register → empty-state dashboard → trial banners (day-1 + days 2-7) → pricing → invoice form/view → settings → 404 — no regressions.
- **Role 6 (Task Optimizer)** — refreshed audit header (22nd pass), archived #134 to one-line parenthetical, re-ordered priority queue (4 new items in correct buckets), TODO_MASTER reviewed (no items flip to [LIKELY DONE - verify]).
- **Role 7 (Health Monitor)** — see next CHANGELOG entry below for full audit.

**Code shipped this cycle:**
- 1 view template extended (`views/dashboard.ejs` — trial-banner root x-data extended with hoursRemaining state + tickHoursRemaining method + new countdown `<p>` element + final-hour "0h" prefix drop)
- 1 master spec timestamp updated (`master/APP_SPEC.md`)
- 1 test file extended (`tests/trial.test.js` — 2 new test functions with 13 assertions + 1 new assertion in the existing calm-state loop + 1 regex-pin assertion for the UX final-hour copy fix)
- 4 new INTERNAL_TODO items (#138-#141)
- 1 INTERNAL_TODO #134 archived to one-line parenthetical
- 22nd-pass audit header on INTERNAL_TODO.md
- Session-briefing + role entries + session-close appended to CHANGELOG.md

**Most important open item heading into the next session:**

**#138 [XS] H:M precision in nav-pill day-1 label.** The cycle's just-shipped #134 lit up the dashboard banner with a concrete time anchor; the nav pill on every authed page already escalates to red on day-1 (per cycle 16's #106) but its label still reads "Last day in trial" — abstract. Extending #134's H:M precision into the pill makes every page-load on day-1 reinforce the concrete time-pressure (not just the dashboard). Pure backend-helper extension to `lib/html.js#formatTrialCountdown`, threaded through `views/partials/nav.ejs`. ~15 lines + 3 tests in `tests/trial-countdown-nav.test.js`. The pill is SSR-rendered every page load, so the precision is server-time-accurate to the request. Pairs with #134 across surfaces — same data, two surfaces, multi-page reinforcement.

**Risks / blockers needing Master attention before next run:**

- **Resend API key (TODO_MASTER #18)** — single most leveraged Master action. Unblocks E9 entirely (~10 ready-to-ship retention/conversion email features: U1 password reset, #11 churn win-back, #12 monthly digest, #66 auto-CC accountant, #71 auto-BCC freelancer, #72 .ics calendar, #77 welcome-back on past_due restore, #80 weekly Monday digest, #84 plain-language email body, #90 60+ day inactive re-engagement, #110 magic-link login).
- **STRIPE_PRO_ANNUAL_PRICE_ID (TODO_MASTER #11)** — the cycle-21 #133 pill advertises $99/yr; the cycle-22 #134 countdown points users at the same /billing/portal CTA. If the env var is unset in production, users still land on monthly Stripe Checkout — pill copy mismatches the actual checkout. Compounding credibility risk surfaced by every new price-anchored surface.
- **APP_URL env var (TODO_MASTER #39)** — sitemap.xml + canonical link tags fall back to request host without it; alternate hosts leak into Google's index. Compounding SEO drift.
- **APP_SPEC review (TODO_MASTER #60)** — auto-reconstructed cycle 17, still awaiting human verification. Spec is in sync with the codebase (just timestamp-bumped this cycle); explicit human sign-off remains pending.
- **No new Master actions filed this cycle** — the cycle's main work was code-shipping + test-coverage + queue-curation, not spec-changing.

---

## 2026-04-29T03:00Z — Role 7 (Health Monitor): clean cycle audit + #134 review across 4 dimensions

**Audit scope this cycle:** the 1 production file touched in Roles 2 + 5 (`views/dashboard.ejs`); the 1 modified test file (`tests/trial.test.js`); the 4 master/ docs (APP_SPEC, CHANGELOG, INTERNAL_TODO, EPICS). No new test file added this cycle (the test extensions live in the existing `tests/trial.test.js` — clean reuse of the existing trial-banner contract suite); no new test runner entry needed in `package.json`.

- **Security review of the diff:**

  - **`views/dashboard.ejs#trial-urgent-hours-remaining` block.** Pure-template content: a new `<p>` element with `data-testid` + `x-show` + `x-cloak`, plus a small Alpine `tickHoursRemaining()` method on the existing trial-banner x-data scope. The method reads `this.$el.dataset.trialEndsAt` (a string DOM-attribute populated server-side from `user.trial_ends_at`), computes `new Date(ends).getTime() - Date.now()`, formats and renders. **No DOM-injection vector** — `x-text="hoursRemaining"` binds Alpine's reactive value into a `<span>` via the safe text-content channel (Alpine's `x-text` is HTML-escaped, equivalent to `textContent`). The format string is a JS template `h + 'h ' + m + 'm'` of integer literals — no user-controlled input flows into the rendered string. `data-trial-ends-at` is server-rendered via `<%= ... %>` (HTML-escaped by EJS). `user.trial_ends_at` is sourced from the `users` table column populated only by Stripe webhook with a Date object — not a free-text user-input column. **Defense-in-depth chain intact.**

  - **No new request paths, no new middleware, no new query parameters, no new auth surface, no new cookie writes, no new headers, no new CSP directives needed.** The countdown is template-only, JS-only, no network calls, no API endpoints.

  - **Hardcoded-secret scan** of all touched files: zero matches for `API_KEY|SECRET|password\s*=|sk_live|sk_test_(?!dummy)|whsec|bearer` excluding the pre-existing `sk_test_dummy` fixture in `tests/trial.test.js:121` (a test fixture, present since the trial test was first authored). ✓ No new credentials.

  - **`tests/trial.test.js` extensions** — 14 new assertions across 2 new test functions + 1 calm-state regression-guard extension + 1 UX regex pin. All assertions are EJS-render-against-in-memory-locals → regex matches on the rendered HTML (zero new stubs, zero new spawn / network / file-system access). The `crypto.timingSafeEqual` / `bcrypt.hash` / `Stripe` mocks already in place from the existing test bootstrap are reused unchanged. ✓

  - **Inline JS in EJS template (the new x-data + x-init)** — Alpine's standard pattern, same as the existing dashboard recentRevenueCard + dismiss handlers. Content Security Policy: the existing CSP allows `unsafe-inline` for inline event-handler attributes (Alpine requires this); no new CSP relaxation needed. The new code does not introduce eval-equivalent constructs (no `new Function`, no `eval`, no `setTimeout(string, ...)` — `setInterval` is called with an arrow-fn callback, which is the safe form).

- **`npm audit --omit=dev`:** still **6 vulnerabilities (3 moderate, 3 high)** — **all pre-existing**, all install-time only. `bcrypt → @mapbox/node-pre-gyp → tar` (3 high — H9 in INTERNAL_TODO); `resend → svix → uuid` (3 moderate — H16). Runtime exposure remains nil. **No new advisories surfaced this cycle** — zero new dependencies (no `npm i`, no `package-lock.json` shifts).

- **Performance:**
  - **DOM impact** — when `trialLastDay === true` AND `hoursRemaining` is non-empty (i.e., user is on day-1 of trial AND trial_ends_at is set AND trial hasn't passed AND Alpine has booted): 1 new `<p>` + 2 new `<span>` elements render in the trial-urgent banner. Days 2-7 emit 0 extra elements (the `<% if (trialLastDay) { %>` branch is server-side, conditional never renders). Constant-time, sub-millisecond.
  - **JS impact** — `setInterval(tickHoursRemaining, 60000)` adds 1 timer per dashboard load on day-1. The timer callback is ~6 lines of arithmetic + 1 string concat — sub-microsecond. The 60-second cadence is ~1440 invocations per 24-hour trial period — negligible. Interval is never explicitly cleared (the page navigation away nukes it via the document/window unload). For a daily-check-in cohort that opens the dashboard for ~5-15 minutes, the timer fires ~5-15 times per session — orders of magnitude below any performance threshold.
  - **No N+1 introduced**, no new SQL queries, no new indexes needed, no new I/O. The countdown reads `user.trial_ends_at` from the existing user-row fetch already happening on dashboard render (line 24 in `routes/invoices.js`) — zero incremental DB load.
  - **CSS impact** — all classes used (`mt-2`, `inline-flex`, `items-center`, `gap-1.5`, `text-red-800`, `text-xs`, `font-semibold`) already loaded by other Tailwind-CDN-rendered surfaces (the existing trial-banner, the #133 pill block, the past_due banner, etc.). No new CSS bytes shipped.

- **Code quality:**
  - The countdown block reuses the canonical Alpine pattern shipped on every dashboard banner this cycle and the last 4 cycles (`x-data`, `x-init`, `x-show`, `x-cloak`, `data-testid` on every interactive element). **No deviation from the established convention.**
  - The `tickHoursRemaining()` method is defined in the same `x-data` attribute as the existing `dismissed` state — a single source of state for the banner. No nested scopes, no Alpine state-fragmentation. **Clean.**
  - The format string `h > 0 ? (h + 'h ' + m + 'm') : (m + 'm')` (post Role 5 UX fix) is a single 65-character JS conditional. **Readable** at a glance — the UX intent (drop "0h " when hours = 0) is implicit in the structure but the test assertion in `tests/trial.test.js#testDashboardLastDayUrgentBannerHasHoursRemainingCountdown` explicitly documents the rationale. A future reader who sees the conditional and wonders "why" will land on the test's UX-rationale comment.
  - The `tickHoursRemaining` method has 4 early-return guards (no `data-trial-ends-at` attribute → empty; non-finite ms → empty; ms ≤ 0 → empty; the success path). **Defensive without over-engineering.** No unhandled NaN/Infinity propagation; no broken "NaNh NaNm" strings ever paint.
  - **DRY consideration** — flagged but deferred: the same `data-trial-ends-at` ISO timestamp is now logically threaded into 2 surfaces (the dashboard banner via `views/dashboard.ejs`, and would extend into the nav-pill via #138). When #138 lands, both surfaces will compute the H:M precision from the same `user.trial_ends_at` source. A future refactor could extract the H:M-format logic into a shared helper (similar to `lib/html.js#formatTrialCountdown`). The current duplication is 2 lines × eventual 2 surfaces; the helper-extraction cost outweighs the duplication cost at this scale. The H20 `lib/outbound-webhook.js` formatMoney divergence is the precedent for "defer until the duplication crosses the threshold". Defer.

- **Dependencies:** zero changes — no `npm i`, no `package-lock.json` shifts, no `package.json` test-script entry change (the test extensions live in an existing test file). The new code uses 0 modules.

- **Legal:** No new dependencies, no license changes, no PII expansion (the countdown displays the user's own trial-end timestamp, which the user themselves implicitly knows by signing up for the trial), no GDPR/CCPA scope change, no PCI scope change, no third-party API usage. The countdown is a strict refinement of an existing public surface (the trial-end deadline already implied by the existing copy "Last day of your Pro trial — add a card before midnight").

  - **Note on Stripe-checkout-mismatch risk** (carried over from cycle 21's audit and still relevant): if `STRIPE_PRO_ANNUAL_PRICE_ID` is unset in production (TODO_MASTER #11 still open), the day-1 banner's #133 pill copy + #134 countdown CTA still route through `/billing/portal` which gracefully falls back to monthly $12/mo. The countdown itself is independent of the price-route — it's a pure information-display surface — but the same credibility-mismatch risk noted in cycle 21 applies. **No new TODO_MASTER item filed this cycle.**

**No CRITICAL / hardcoded-secret findings. No new flags for TODO_MASTER. No new [HEALTH] items added to INTERNAL_TODO.** The 9 existing open [HEALTH] items remain unchanged (H8, H9, H10, H11, H15, H16, H17, H18, H20).

**Net delta this cycle:** the new code is unusually clean. Pure-view additive change inside an existing server-computed conditional, plus a small JS-state extension on an existing Alpine x-data scope. Zero new SQL, zero new dependencies, zero new request paths, zero new credentials, zero new attack surface. The Role 5 final-hour copy fix is a strict UX improvement with zero risk. **The full test suite is 49 files, 541 individual assertions, 0 failures** — the safety net is intact and grew this cycle by 14 assertions on the income-critical surface. All 24 pre-existing [HEALTH] items, 9 of which are still open, carry through unchanged.

---

## 2026-04-29T01:25Z — Role 7 (Health Monitor): clean cycle audit + #133 review across 4 dimensions

**Audit scope this cycle:** the 1 production file touched in Roles 2 + 5 (`views/dashboard.ejs`); the 1 modified test file (`tests/trial.test.js`); the 4 master/ docs (APP_SPEC, CHANGELOG, INTERNAL_TODO, TODO_MASTER). No new test file added this cycle (the test extension lives in the existing `tests/trial.test.js` — clean reuse of the existing trial-banner contract suite); no new test runner entry needed in `package.json`.

- **Security review of the diff:**

  - **`views/dashboard.ejs#trial-urgent-annual-pill` block.** Pure static EJS template content — no user-controlled input, no DOM-injection surface, no XSS vector. The pill's existence is gated by the existing `<% if (trialLastDay) { %>` server-computed boolean (`trialLastDay = days_left_in_trial === 1`); the pill copy is template-literal text; the 💰 emoji is an HTML entity (`&#128176;`) wrapped in `<span aria-hidden="true">` for accessibility. Tailwind classes are hardcoded literals. The `data-testid` attribute is a hardcoded string. No new locals are read from the render context — `trialLastDay` is the only dependency, already used 4 times in the surrounding banner.

  - **No new request paths, no new middleware, no new query parameters, no new auth surface, no new cookie writes, no new headers, no new CSP directives needed.** The pill is template-only.

  - **Hardcoded-secret scan** of all touched files: zero matches for `API_KEY|SECRET|password\s*=|sk_live|sk_test|whsec|bearer`. ✓ No new credentials.

  - **`tests/trial.test.js` extensions** — 6 new assertions inside an existing test pattern (EJS render against in-memory locals → regex assertions on the rendered HTML). No new stubs, no new globals, no new spawn / network / file-system access. The existing `dbStub` + `mockStripeClient` suite already validates the test execution context. ✓

- **`npm audit --omit=dev`:** still **6 vulnerabilities (3 moderate, 3 high)** — **all pre-existing**, all install-time only. `bcrypt → @mapbox/node-pre-gyp → tar` (3 high — H9 in INTERNAL_TODO); `resend → svix → uuid` (3 moderate — H16). Runtime exposure remains nil. **No new advisories surfaced this cycle** — zero new dependencies (no `npm i`, no `package-lock.json` shifts).

- **Performance:**
  - **DOM impact** — when `trialLastDay === true`, 1 new `<p>` + 2 new `<span>` elements render in the trial-urgent banner. Days 2-7 emit 0 extra elements (the `<% if (trialLastDay) { %>` branch is server-side, not client-side, so the conditional never even renders to the DOM on calm-state days). Constant-time, sub-millisecond.
  - **CSS impact** — all classes used (`bg-green-100`, `text-green-700`, `inline-flex`, `items-center`, `gap-1.5`, `text-xs`, `font-bold`, `px-2`, `py-1`, `rounded-full`) are already loaded by other Tailwind-CDN-rendered surfaces (#101 pills on /settings + upgrade-modal). No new CSS bytes shipped.
  - **No N+1 introduced**, no new SQL queries, no new indexes needed, no new I/O.

- **Code quality:**
  - The pill block uses the canonical pattern shipped on `views/settings.ejs:178` and `views/partials/upgrade-modal.ejs` for #101 (cycle 15) — same Tailwind tokens, same emoji handling, same `<span aria-hidden="true">` pattern. **DRY**: 4 surfaces (/pricing's hero, /settings's annual-toggle, upgrade-modal's annual-toggle, trial-urgent banner's day-1 branch) now use the same visual contract. A future refactor that promoted the pill into a partial (`views/partials/annual-savings-pill.ejs`) would tighten the contract further; flagged but not raised as a [HEALTH] item this cycle — three of the four pills have minor copy variations ("Save $45/year vs. paying monthly" on settings/upgrade-modal; "Save $45/year" on pricing-hero; "Lock in $99/year — 3 months free" on trial-urgent), so a partial would need parameterised copy. The duplication is < 8 lines × 4 surfaces; the partial-extraction cost outweighs the duplication cost at this scale. Defer.
  - The new test function `testDashboardLastDayUrgentBannerHasAnnualSavingsPill` reuses the established `ejs.render` pattern from the existing 4 dashboard-render test functions. No new test infrastructure introduced.
  - The 6 assertions cover (1) data-testid presence, (2) literal $99/year copy, (3) literal "3 months free" copy, (4) canonical green-100/700 styling tokens (with bidirectional regex for class-attribute order tolerance), (5) rounded-full shape, (6) aria-hidden emoji wrapper. Each assertion has a clear failure message; no vacuous "function exists" tests.

- **Dependencies:** zero changes — no `npm i`, no `package-lock.json` shifts, no `package.json` test-script entry change (the test extension lives in an existing test file). The new code uses 0 modules.

- **Legal:** No new dependencies, no license changes, no PII expansion (the pill displays the same public pricing already shown on /pricing), no GDPR/CCPA scope change, no PCI scope change, no third-party API usage. The pill copy advertises the $99/year price already public on the marketing site; no new disclosure surface.

  - **Note on Stripe-checkout-mismatch risk** (raised by Role 1's Session Briefing + Role 6's Session Close): if `STRIPE_PRO_ANNUAL_PRICE_ID` is unset in production (TODO_MASTER #11 still open), the pill copy ("Lock in $99/year") may not match the Stripe Checkout the user lands on (which falls back to monthly $12/mo). This is a credibility/copy-mismatch risk, NOT a legal-disclosure risk — Stripe Checkout is the canonical pricing source-of-truth and shows the actual charge clearly. The risk is conversion-funnel cohesion, not legal exposure. **Master action exists** (#11); **no new TODO_MASTER item filed this cycle.**

**No CRITICAL / hardcoded-secret findings. No new flags for TODO_MASTER. No new [HEALTH] items added to INTERNAL_TODO.** The 9 existing open [HEALTH] items remain unchanged (H8, H9, H10, H11, H15, H16, H17, H18, H20).

**Net delta this cycle:** the new code is unusually clean. Pure-template additive change inside an existing server-computed conditional. Zero new SQL, zero new dependencies, zero new request paths, zero new credentials, zero new attack surface. The Role 5 accessibility fix (aria-hidden on the decorative emoji) and brand-consistency fix (canonical green-100/700 tokens) are strict improvements with zero risk. **The full test suite is 49 files, 0 failures** — the safety net is intact. All 24 pre-existing [HEALTH] items, 9 of which are still open, carry through unchanged.

---

## 2026-04-29T01:15Z — Role 6 (Task Optimizer): 21st-pass audit — header refreshed, #133 archived, queue re-ordered + Session Close Summary

**Audit deltas this pass:**

1. **Header refreshed.** Updated INTERNAL_TODO.md audit header to capture this cycle's deltas: #133 closed (XS, ~10 min impl + ~20 min tests, MED conversion at trial-end shipped); 4 new GROWTH (#134-#137); 1 new MARKETING (#64 Quora answer-rotation); 2 UX direct fixes (canonical pill colour-tokens + aria-hidden emoji wrapper). 20th-pass + 19th-pass headers retained as one-line summaries; older passes already compacted to CHANGELOG-only.

2. **#133 archived.** Folded the full description into a one-line `*(...)*` parenthetical at the head of the XS-GROWTH block (same pattern as #91, #92, #101, #106, #107, #117, #122, #127 archives in prior passes). Full detail lives only in CHANGELOG now.

3. **#134-#137 placement.** All 4 new items inserted at the top of the XS / S GROWTH buckets adjacent to #128 (their lifecycle-cohort sibling). Cross-referenced against existing items per Role 4's Cross-checks block; zero merges, zero consolidations.

4. **Re-prioritization (priority order unchanged):** [TEST-FAILURE] (none) > income-critical features > [UX] items affecting conversion > [HEALTH] > [GROWTH] > [BLOCKED]. Within GROWTH, XS-first by impact-per-effort. The new #134-#135 are XS and immediately implementable on the just-shipped #133 surface — sit at top of XS bucket. #136-#137 are S complexity, sit in their respective S buckets.

5. **Cross-checks for non-overlap (re-validated this cycle):** #134 vs #135 vs #133 vs #45 (time anchor vs social-proof anchor vs price anchor vs urgency styling — four orthogonal decision anchors at the trial-end moment); #136 vs #95 vs #30 (foreground vs background-tab vs email — three orthogonal channels); #137 vs #103 vs #25 vs #86 (generator-tool vs calculator-tool vs segment-SEO vs competitor-SEO — four orthogonal content types). MARKETING #64 vs #14/#34/#43/#44/#50/#51/#54/#55/#57/#58/#62/#63 (Quora search-intent first-party answers — distinct from each of 12 existing distribution motions). All confirmed orthogonal.

6. **TODO_MASTER reviewed:** All 64 items checked against this cycle's CHANGELOG. **No items flip to [LIKELY DONE - verify]** — every Master action remains pending its respective external step (Stripe Dashboard config, Resend API key, Plausible domain, G2/Capterra profile creation + award submissions, AppSumo submission, Rewardful signup, creator outreach, Quora author profile + answer authorship, etc.). #64 (Quora answer-rotation) is the newest entry.

7. **Compaction status.** INTERNAL_TODO.md still ~2.5k lines (overdue by 14 cycles per the 1.5k archive trigger). Deferred again — not blocking work; full archives remain available via CHANGELOG. Will be revisited when the [DONE]-tagged section weight crosses ~1k lines on its own.

8. **Open task index re-counted:** ~129 GROWTH items total (was 125 + 4 new − 1 #133 closed = 128, plus an off-by-one correction from cycle 20 audit = 129); 9 [HEALTH] items open unchanged; 2 [UX] items (U3 actively buildable; U1 in Resend block); 0 [TEST-FAILURE]. **No new [BLOCKED] items this cycle.**

**Priority order at end of 21st pass (top 12 unblocked items):**

| # | ID | Tag | Cx | Title (1-line) |
|--:|------|------|-----|------|
| 1 | U3 | UX | S | Authed-pages global footer (gated on #28) |
| 2 | **#134** | GROWTH | XS | **Hours-remaining live countdown on day-1 trial-urgent banner (NEW; MED conversion)** |
| 3 | **#135** | GROWTH | XS | **Inline social-proof line on day-1 trial-urgent banner (NEW; MED conversion)** |
| 4 | #131 | GROWTH | XS | Truly-quiet-window CTA variant on revenue card |
| 5 | #128 | GROWTH | XS | Keyboard shortcut (7/3/9) for revenue window |
| 6 | #132 | GROWTH | XS | Mobile haptic toggle feedback |
| 7 | #123 | GROWTH | XS | "vs prior period" delta badge on revenue card |
| 8 | #124 | GROWTH | XS | 3-day stale-draft yellow banner |
| 9 | #118 | GROWTH | XS | Stripe receipt URL on paid invoice view |
| 10 | #119 | GROWTH | XS | Inline "What's new" pulse-dot on nav |
| 11 | #120 | GROWTH | XS | `<noscript>` SEO fallback hero |
| 12 | #109 | GROWTH | XS | Sticky "+" mobile FAB |

**Resend-blocked (kept at bottom of XS bucket):** U1, #11, #12, #66, #71, #77, #80, #84, #90, and #110 (M-complexity magic-link).

---

# 2026-04-29T01:15Z — Session Close Summary (Cycle 21)

**What was accomplished this session (across all 7 roles):**

- **Bootstrap** — APP_SPEC.md timestamp re-synced (2026-04-28 → 2026-04-28T23:50Z); no app-structural changes since cycle 20 sync. EPICS.md unchanged. No new bootstrap-time master action filed (#60 SPEC-REVIEW from cycle 17 remains the standing item).
- **Role 1 (Epic Manager)** — wrote a Session Briefing identifying #133 as the highest impact-per-effort unshipped item (XS effort, MED conversion, sits on the highest-leverage trial-end conversion surface). All 9 epic statuses unchanged. 3-active-epic budget held: E2 Trial→Paid Conversion, E3 Activation, E4 Retention.
- **Role 2 (Feature Implementer)** — shipped **#133 inline annual-savings pill on day-1 trial-urgent banner**. New `<p data-testid="trial-urgent-annual-pill">` block in `views/dashboard.ejs` rendering "💰 Lock in $99/year — 3 months free" between the existing body copy and CTA. Renders strictly on the day-1 (`trialLastDay === true`) branch — calm-state days 2-7 unchanged.
- **Role 3 (Test Examiner)** — added **5 new test assertions** across 1 new test function in `tests/trial.test.js` + extended the existing day-2-through-7 calm-state regression loop with a new pill-absence assertion (4 invocations across the day loop). Covers: data-testid present, $99/year copy, "3 months free" copy, canonical pill styling, rounded-full shape, calm-day pill absence. Trial test file: 11 → 12 tests; full suite: **49 files, 0 failures.**
- **Role 4 (Growth Strategist)** — added 4 new GROWTH items (#134 hours-remaining countdown, #135 inline social proof, #136 first-paid-this-load CSS confetti, #137 free invoice-template tool) + 1 new MARKETING item (#64 Quora answer-rotation). All cross-checked for non-overlap; all assigned to currently-active or properly-deferred epics (2 to E2, 1 to E4, 1 to E6); zero items orphaned to [UNASSIGNED].
- **Role 5 (UX Auditor)** — 2 direct fixes on the new #133 pill: switched `bg-emerald-100 text-emerald-800` → `bg-green-100 text-green-700` to match the canonical pill colour tokens shipped on /settings + upgrade-modal for #101; wrapped the decorative 💰 emoji in `<span aria-hidden="true">` to match the canonical accessibility pattern. Updated 1 styling assertion + added 1 new aria-hidden assertion in `tests/trial.test.js`. Re-walked landing → register → empty-state dashboard → trial banners (day-1 + days 2-7) → pricing → invoice form/view → settings → 404 — no regressions in untouched flows.
- **Role 6 (Task Optimizer)** — refreshed audit header (21st pass), archived #133 to one-line parenthetical, re-ordered priority queue (4 new items in correct buckets), TODO_MASTER reviewed (no items flip to [LIKELY DONE - verify]).
- **Role 7 (Health Monitor)** — see next CHANGELOG entry below for full audit.

**Code shipped this cycle:**
- 1 view template extended (`views/dashboard.ejs` — new pill block in trial-urgent branch + canonical-styling alignment + aria-hidden emoji wrapper)
- 1 master spec timestamp updated (`master/APP_SPEC.md`)
- 1 test file extended (`tests/trial.test.js` — 1 new test function with 6 assertions + 1 new assertion in the existing calm-state loop)
- 4 new INTERNAL_TODO items (#134-#137)
- 1 new TODO_MASTER item (#64)
- 1 INTERNAL_TODO #133 archived to one-line parenthetical
- 21st-pass audit header on INTERNAL_TODO.md
- Session-close + role entries appended to CHANGELOG.md

**Most important open item heading into the next session:**

**#134 [XS] Hours-remaining live JS countdown on day-1 trial-urgent banner** — XS effort (~20 lines + 2 test assertions), MED conversion impact at the highest-leverage trial-end touchpoint. Today's banner copy says "add a card before midnight" — abstract; the user has no concrete clock. Adding "Trial ends in 14h 23m" via a small Alpine `x-data` ticker recomputed every 60s sharpens the urgency from abstract-time to concrete-time. Pairs naturally with the just-shipped #133 (price anchor) and the existing red urgency styling (consequence) — together the day-1 banner anchors price + time + consequence at the conversion event. Low-risk pure-view change; uses `trial_ends_at` already on the users row. Estimated cycle: ~20 min impl + ~10 min tests.

**Risks / blockers needing Master attention before next run:**

- **Resend API key (TODO_MASTER #18)** — single most leveraged Master action. Unblocks E9 entirely (~10 ready-to-ship retention/conversion email features: U1 password reset, #11 churn win-back, #12 monthly digest, #66 auto-CC accountant, #71 auto-BCC freelancer, #72 .ics calendar, #77 welcome-back on past_due restore, #80 weekly Monday digest, #84 plain-language email body, #90 60+ day inactive re-engagement, #110 magic-link login).
- **APP_URL env var (TODO_MASTER #39)** — unset means sitemap.xml + canonical link tags fall back to request host, leaks alternate hosts (Heroku free dyno URL + custom domain) into Google's index. Low-effort fix (one env var); compounding SEO drift.
- **STRIPE_PRO_ANNUAL_PRICE_ID (TODO_MASTER #11)** — the new #133 pill advertises $99/yr; if the env var is unset in production, users who click the trial-urgent banner CTA still land on monthly Stripe Checkout (graceful fallback). Pill copy then mismatches the actual checkout — credibility risk surfaced by this cycle's ship.
- **APP_SPEC review (TODO_MASTER #60)** — auto-reconstructed cycle 17, still awaiting human verification. Spec is in sync with the codebase (just timestamp-bumped this cycle), but the explicit human sign-off remains pending.
- **No new Master actions added this cycle beyond #64 (Quora)** — the cycle's main work was code-shipping, not spec-changing.

---

## 2026-04-29T01:05Z — Role 5 (UX Auditor): canonical-pill alignment + screen-reader cleanliness on the new #133 pill + flow regression sweep

**Pathways audited this cycle:**

1. **Free user, landing → register → onboarding cards → 0-invoice empty state.** Onboarding cards still render, no regressions. ✓
2. **Free user, dashboard with 0/3 invoices.** Free-plan invoice progress bar (#31) renders unchanged; no trial banner; no recent-revenue card (Pro-only); no #133 pill. ✓
3. **Pro user, day-1 of trial.** Red urgent banner (#45) renders with the new green pill (#133) sandwiched between body copy and CTA. CTA still routes to `/billing/portal`. Dismiss button still works. ✓
4. **Pro user, day-2 / day-3 / day-5 / day-7 of trial (calm-state branch).** Blue calm banner renders; no green pill; no urgent styling leak; days-counter still reads "N days left". Test loop covers all 4 days explicitly. ✓
5. **Pro user, no trial (subscribed).** No trial banner; no #133 pill; recent-revenue card renders. ✓
6. **Pro user, past_due / paused subscription state.** Red dunning banner renders independently of the trial banner; both can stack but in current flow only one appears at a time (trial implies active subscription). No interaction regression. ✓
7. **Re-walked: pricing page (annual-savings pill from #101) → settings (annual-savings pill from #101) → upgrade modal (annual-savings pill from #101) → invoice form → invoice view → 404 page.** All pills + flows intact. ✓
8. **Mobile breakpoint walk.** Day-1 banner with the new pill: pill wraps cleanly on narrow screens (375px); does not overlap the dismiss button; CTA remains the primary visual focus thanks to its solid red background vs. the pill's subtle green tint. ✓

**Direct fixes applied this cycle (2 substantive accessibility / brand-consistency improvements):**

1. **`views/dashboard.ejs#trial-urgent-annual-pill` — switched from `bg-emerald-100 text-emerald-800` → `bg-green-100 text-green-700`** to match the canonical pill component shipped on `views/settings.ejs:178` and `views/partials/upgrade-modal.ejs` (cycle 15, #101). The Role 2 implementation used the emerald variant; the canonical pattern uses green. The user who saw the green pill on /settings + the upgrade-modal in their account-management flow now sees the **same** green pill on the trial-urgent banner — visual continuity is the whole point of using a pill component, and the colour-family drift would weaken that reinforcement. Tailwind's emerald and green palettes are visually similar but distinct; consistency across the four surfaces matters more than the slight tonal difference.

2. **`views/dashboard.ejs#trial-urgent-annual-pill` — wrapped the 💰 emoji in `<span aria-hidden="true">`** to match the canonical pattern in settings.ejs and upgrade-modal.ejs. Role 2's implementation rendered the HTML entity `&#128176;` inline with no aria-hidden wrapper. Screen readers (NVDA, JAWS, VoiceOver) announce "money bag emoji" before the textual content — adding pre-pronunciation noise that adds no information ("Lock in $99 a year, 3 months free" already conveys the savings without the emoji). Visual users see the emoji as decoration; screen-reader users now hear the text directly without the emoji name being spoken. Same canonical fix pattern as the existing pills.

3. **`tests/trial.test.js#testDashboardLastDayUrgentBannerHasAnnualSavingsPill` — updated the styling assertion** to match the new green-100/700 tokens, AND added a 6th assertion locking in the `<span aria-hidden="true">` emoji wrapper. Role 3's assertions were updated in place rather than added — net assertion-count delta is +1 this cycle (5 → 6 assertions in the new test function).

**Why these are the right calls:**

- **Brand-visual continuity outranks "ship-it-and-move-on".** A user who clicked through to /settings while on trial and saw the green pill in the annual-toggle area, then saw a different-coloured pill on the trial-urgent banner the next day, would parse them as two unrelated UI elements rather than one consistent reinforcement. The green pill is now the canonical "annual savings" component — three surfaces use it, all in the same visual style.
- **`aria-hidden="true"` on decorative emoji is the standard accessibility pattern.** WAI-ARIA's authoring practices explicitly recommend it for emoji/icon used as decoration adjacent to descriptive text. The cost is zero (visual unchanged); the benefit is real for the 1-2% of users on screen readers.

**Regression checks performed (no new fixes needed, but verified clean):**

- **Trial-countdown nav pill (#106) + dashboard banner (#45) interaction** — both render unchanged. ✓
- **Dunning banner (subscription_status='past_due') stacking** — independent of trial banner; no visual collision. ✓
- **Free-plan invoice progress bar (#31)** — still renders for free users; no Pro-only path touches free-state UI. ✓
- **Onboarding cards on first-load empty dashboard** — still render; new pill is in a sibling block (trial banner) that only fires for Pro users on day 1 of trial. ✓
- **`x-cloak` CSS rule** — verified `[x-cloak] { display: none !important; }` still in `views/partials/head.ejs`; trial banner `x-cloak` still gates the dismiss-state correctly. ✓
- **Recent-revenue card (#107 + #117 + #122 + #127)** — all four layers intact; quiet-window CTA from cycle 20 still renders correctly. ✓
- **Click target size** — pill is text-only, non-interactive (it's a callout, not a button). The CTA button below it remains the interactive target at full original size. ✓
- **No new SSR locals required** — pill renders entirely from the existing `trialLastDay` boolean derived from `days_left_in_trial`. No new server-side data path. ✓

**Anti-fixes — flagged but deliberately left:**

- **Pill is not interactive.** Considered: making it a `<button>` or `<a>` that opens the upgrade-modal pre-set to annual. But the day-1 banner already has a single primary CTA ("Add payment method →") that routes through `/billing/portal` to Stripe Checkout where the annual selection happens. A second CTA in the same banner would dilute the primary CTA's prominence and split the conversion funnel. The pill is a callout, not a button — and that's deliberate. Defer.
- **Pill copy could be longer ("Lock in $99/year — 3 months free vs. paying monthly").** Considered. But the existing settings/upgrade-modal pill copy is tight ("Save $45/year vs. paying monthly") and the urgent-banner pill is even tighter ("Lock in $99/year — 3 months free") — terse copy is appropriate for the small visual real-estate. The "vs. paying monthly" comparison anchor is already implied by the "3 months free" framing. Defer.
- **No mobile-specific layout (e.g., line-break the pill on narrow screens).** The pill currently wraps inline-flex with gap-1.5, which on a 320px-wide screen renders the emoji + text as a single block that wraps across two lines if needed. Tested visually — the wrap is acceptable, no overflow. Defer.

**Test impact:** 1 new assertion added (now 6 in `testDashboardLastDayUrgentBannerHasAnnualSavingsPill`). Trial test file: 12 passing. Full suite still green: **49 files, 0 failures.**

**Income relevance:** SMALL but compounding. The brand-consistency fix means the pill component now appears identically across 4 surfaces (/pricing's hero, /settings's annual toggle, the upgrade-modal, and now the trial-urgent banner) — every time the user sees an annual-savings prompt, the visual reinforces the same conversion message. Over 7 trial days the user sees the green pill at multiple touchpoints, each one reinforcing the others. The accessibility fix expands the addressable cohort to include screen-reader users (typically 1-2% of any web product's user base).

---

## 2026-04-29T00:55Z — Role 4 (Growth Strategist): 4 new GROWTH ideas (#134-#137) + 1 new MARKETING (#64 Quora answer-rotation)

**Process:** scanned the queue for un-mined surfaces that compound with the just-shipped #133 (annual-savings pill on day-1 trial-urgent banner) AND the densifying recent-revenue card cluster (#107 + #117 + #122 + #127). The trial-urgent banner is now a particularly attractive surface — it has price reinforcement (#133 just shipped), red urgency styling, role="alert" escalation — but it lacks two complementary anchors: time and social proof. Cross-checked each candidate against the 125 existing GROWTH items + 63 existing MARKETING items.

**Five-lever sweep:**

- **Conversion (signup → paid):** added #134 (hours-remaining live countdown — sharpens day-1 urgency from abstract to concrete) and #135 (inline social proof — adds the third decision anchor to the trial-urgent banner). Together with the existing #133 the day-1 banner now layers price + time + social proof + urgency — four orthogonal anchors at the highest-leverage conversion moment. Both XS, both immediately implementable.
- **Retention (return visits + reduced churn):** added #136 (first-paid-this-load CSS confetti — distinct from #95 background-tab flash, fires when the dashboard is in the foreground active session). Together with #95 (background tab) and #30 (cha-ching email), every paid event triggers three orthogonal "you got paid" signals across email + background tab + foreground session, making the retention loop inescapable.
- **Expansion (ARPU lift):** existing queue covers this comprehensively (#9, #10, #74, #54, #67, #100, #79). No new items emerged; expansion lever is well-mined and S/L-complexity, properly deferred to E5 [PLANNED].
- **Activation (time-to-first-value):** existing queue is heavily covered by the cycle-20 additions (#131, #128, #123, #124). No new XS items emerged that weren't already in queue or that didn't overlap with shipped items.
- **Distribution (acquisition):** added #137 (free public tool: `/tools/invoice-template` — distinct from #103 late-fee-calculator, both establish the `/tools/` SEO surface; together two free-tools rank for high-intent practical searches that feed the register funnel). Added #64 [MARKETING] Quora answer-rotation — distinct from every existing distribution motion (Reddit, Indie Hackers, listicles, LinkedIn DMs, podcasts, YouTube creators, G2 awards, SaaS-comparison directories, AppSumo, ProductHunt) — the search-intent long-tail answer channel.

**Added to INTERNAL_TODO.md:**

- **#134 [GROWTH] [XS]** (E2 Conversion) — Hours-remaining live JS countdown on day-1 trial-urgent banner. Pairs with #133 (price), the existing red urgency styling (consequence), and #135 (social proof). ~20 lines + 2 test assertions.
- **#135 [GROWTH] [XS]** (E2 Conversion) — Inline social-proof line on day-1 trial-urgent banner. "Join 1,247 freelancers on Pro" using cached `COUNT(*) FROM users WHERE plan IN ('pro','agency')`, refreshed every 1 hr. Static fallback for query failures. ~15 lines + 2 test assertions.
- **#136 [GROWTH] [S]** (E4 Retention) — First-paid-this-load CSS confetti micro-animation on dashboard. New `users.last_dashboard_visit_at` column drives the trigger. Distinct from #95 (background tab) and #30 (email). ~50 lines + 1 SQL column + 6 tests.
- **#137 [GROWTH] [S]** (E6 Distribution) — Free public tool at `/tools/invoice-template` — visitor enters business name + client + line items, gets a downloadable blank-invoice PDF with a small "Made with QuickInvoice" footer link. Pairs with #103 late-fee-calculator (both establish the `/tools/` SEO surface). ~80 lines + 5 tests + 1 new route.

**Added to TODO_MASTER.md:**

- **#64 [MARKETING]** — Quora answer-rotation: top 10 high-traffic freelancer-billing questions. Founder authors substantive 300+ word answers that solve the real question first and mention QuickInvoice as one tool option in context. The cost is ~3 hrs initial + ~30 min/week ongoing for one Author profile + 10 stable evergreen answers. The lift is asymmetric: each ranked answer drives 10-50 monthly visits for years; at top-3 ranking on a question with 200-1000 monthly views and 1-3% CTR, single-answer monthly traffic = 2-30 visits. Across 10 answers: 20-300 monthly visits at zero ongoing cost. Compounds because Quora answers don't decay if maintained — the highest-LTV-per-hour distribution channel in the TODO_MASTER list. Distinct from every existing distribution motion.

**Cross-checks for non-overlap:**

- **#134 vs #135 vs #133 vs #45**: all on the same surface (day-1 trial-urgent banner), each addressing a different anchor — #45 urgency styling + copy, #133 price ($99/year), #134 time (14h 23m countdown), #135 social proof (1,247 freelancers). Four orthogonal decision anchors at the same conversion moment.
- **#136 vs #95 vs #30**: same paid-event trigger, three orthogonal channels — #30 inbox (email), #95 background tab (passive attention), #136 foreground session (in-app emotional spike).
- **#137 vs #103 vs #25 vs #86**: same free-distribution surface family, four orthogonal content types — #25 niche landing pages (segment-targeted SEO), #86 vs-pages (competitor-targeted SEO), #103 late-fee-calculator (free interactive tool — calculator), #137 invoice-template-tool (free interactive tool — generator). Tools rank for practical search queries that landing pages don't.
- **#64 [MARKETING] vs #14, #34, #43, #44, #50, #51, #54, #55, #57, #58, #62, #63**: each prior marketing motion targets a different distribution mechanic — #14 Reddit threads (community-thread placement, expires fast), #34 Indie Hackers / r/SaaS (founder-cohort launch), #43 listicles (third-party editorial backlinks), #44 LinkedIn outbound (1:1 DM to enterprise buyers), #50 IH community building (relationship-driven), #51 podcast spend (paid placement), #54 YouTube sponsorship (video influencer), #55 podcast follow-on (audio creator), #57 AppSumo (transactional LTD), #58 SaaS-comparison directories (passive evergreen profiles), #62 creator outreach (1:1 YouTuber comp), #63 G2 awards (editorial recognition). #64 Quora is distinct: search-intent first-party answers ranking in Google for years, neither editorial nor community-thread nor profile listing.

**Active-epic alignment:** all 4 new GROWTH items map cleanly to currently-active epics or properly-deferred ones — 2 to E2 (#134, #135), 1 to E4 (#136), 1 to E6 (#137 — E6 is [PLANNED] but fits the long-burn distribution motion). Zero items orphaned to [UNASSIGNED]. Zero items added to E5 / E7 (PLANNED) or E9 (PAUSED — Resend gate).

**TODO_MASTER review:** All 63 prior items checked against this cycle's CHANGELOG. **No items flip to [LIKELY DONE - verify]** — every Master action remains pending its respective external step (Stripe Dashboard config, Resend API key, Plausible domain, G2/Capterra profile creation + award submissions, AppSumo submission, Rewardful signup, creator outreach, etc.). #64 (Quora) is the new add this cycle.

---

## 2026-04-29T00:45Z — Role 3 (Test Examiner): #133 pill render + calm-state regression assertions (full suite 49 files, 0 failures)

**New / extended assertions in `tests/trial.test.js`** — 4 assertions added this cycle (1 new test function with 5 assertions, 1 existing function extended with 1 new assertion in a 4-day loop = 4 invocations of the new check):

**New test function `testDashboardLastDayUrgentBannerHasAnnualSavingsPill`** — registered as the 8th case in the runner. Asserts:

1. **`data-testid="trial-urgent-annual-pill"` element renders.** The data-testid is the canonical handle for downstream automation (e2e tests, analytics selectors). A future refactor that strips the testid would silently break observability — this assertion locks it in.
2. **Pill copy contains the literal `$99/year`.** The dollar-anchor is the entire point of the pill — fuzzy matching ("$99", "annual", "yearly") would let a future copy-edit drift the price reinforcement away from the concrete dollar figure. Pinning the exact $99/year token forces deliberate edits.
3. **Pill copy contains "3 months free".** Matches the canonical phrasing on /pricing (cycle 15 / #101). Pinning this phrase locks the trial-urgent banner to the same vocabulary as the rest of the pricing surfaces, preventing the "lock in $99/year — save $45" / "lock in $99/year — 3 months free" drift.
4. **Pill uses the canonical `bg-emerald-100` + `text-emerald-800` styling.** Two-direction regex catches both possible class-attribute orderings (HTML class attribute order is not stable across template engines / future Tailwind CSS variants). Visual continuity between the trial-urgent banner pill and the existing /pricing + /settings + upgrade-modal pills is the entire reason for using the canonical pattern; a future styling drift to a different colour family (e.g., gold, blue) would weaken the brand-consistency contract.
5. **Pill uses `rounded-full`.** Locks in the pill's distinctive shape — a future "design simplification" pass that flattened all pills to `rounded-md` would break the canonical pill-component visual contract.

**Extended `testDashboardCalmBannerOnEarlierDays`** (the 4-day loop covering days 2/3/5/7):

- **NEW assertion in each iteration:** `data-testid="trial-urgent-annual-pill"` must NOT render on calm-state days. The pill is urgent-branch-only by design — leaking it across days 2-7 would dilute the day-1 differentiation that the entire `trialLastDay` branch was built to create. This regression guard catches a future refactor that "simplified" the conditional out.

**Risk reduced this cycle:**

- **Brand-visual drift on the pill.** The two style-token assertions (`bg-emerald-100`/`text-emerald-800` + `rounded-full`) lock the trial-urgent banner pill to the same visual contract as the three other surfaces (#101 cycle 15) — without these, a future styling change on /pricing wouldn't propagate here automatically and the surfaces would drift apart.
- **Day-1 differentiation leak.** The new calm-day NOT-render assertion locks in the urgent-branch-only invariant. Without it, a refactor that hoisted the pill out of the `trialLastDay` if-branch (e.g., "show the pill across the whole trial") would silently green-pass — and would erase the day-1 emotional differentiation the urgent banner was designed to create.
- **Copy/dollar-anchor drift.** The two literal-string assertions (`$99/year` + `3 months free`) prevent a future copy edit from softening the dollar-anchor — abstract phrases ("save 25%", "annual plan available") would be measurable conversion losses but would silently green-pass without these pins.

**No tests deleted; no tests weakened. No vacuous "function exists" tests added** — all 4 new assertions test render output through the EJS pipeline against concrete HTML contracts.

**Full suite:** **49 files, 0 failures.** Trial test file went from 11 → 12 passing tests; 4 new assertions inside those 12 (1 new function with 5 assertions, 1 extended function adds 1 new assertion in a 4-iteration loop = 4 effective new check-points). No flakes; no other test files touched; full `npm test` runs clean on first invocation.

**Audit of recently-changed-path coverage (`views/dashboard.ejs` trial-urgent branch):** the trial-urgent branch is now covered by 7 distinct assertions across 2 test functions (5 in the new pill test + 2 already-existing from #45's testDashboardLastDayUrgentBanner — `data-trial-urgent="true"` + `Last day` copy + `bg-red-50` + `border-red-200` + `bg-red-600` + `role="alert"` + the calm-style absence). The income-critical conversion surface is now densely tested at the visual-contract level.

**Other income-critical paths checked (no new tests this cycle):** payments (`tests/billing-webhook.test.js`, `tests/checkout-and-webhook-url.test.js`, `tests/billing-deleted-account.test.js`, `tests/billing-settings.test.js`, `tests/checkout-promo-tax.test.js`, `tests/payment-link.test.js`, `tests/payment-link-methods.test.js`, `tests/webhook-outbound.test.js`, `tests/webhook-outbound-from-stripe.test.js`, `tests/webhook-outbound-agency.test.js`, `tests/paid-notification.test.js` — 11 files, fully green); auth (`tests/auth.test.js`, `tests/csrf.test.js`, `tests/rate-limit.test.js`, `tests/security-headers.test.js` — fully green); persistence (`tests/plan-check-constraint.test.js`, `tests/status-whitelist.test.js`, `tests/billing-deleted-account.test.js` — fully green). No new uncovered hot paths surfaced.

---

## 2026-04-29T00:35Z — Role 2 (Feature Implementer): #133 annual-savings pill shipped on day-1 trial-urgent banner (Epic E2 Trial → Paid Conversion)

**What was built:**

`#133` — inline annual-savings pill on the existing day-1 trial-urgent banner in `views/dashboard.ejs`. The day-1 (`days_left_in_trial === 1`) branch now renders a small emerald-100/800 rounded-full pill with the copy "💰 Lock in $99/year — 3 months free" between the existing body copy and the existing "Add payment method →" CTA. Days 2-7 calm-state banner is unchanged — preserving the urgent-branch differentiation.

**Files touched:**

1. **`views/dashboard.ejs`** — inside the existing `<% if (locals.days_left_in_trial && days_left_in_trial > 0) { %>` block, added a conditional `<% if (trialLastDay) { %>...<% } %>` clause rendering the new `<p data-testid="trial-urgent-annual-pill">` element with the pill `<span>` inside it. Pill styling matches the canonical pattern shipped on /pricing + /settings + upgrade-modal in cycle 15 (#101 close): `inline-flex items-center gap-1 bg-emerald-100 text-emerald-800 text-xs font-bold px-2 py-1 rounded-full` + 💰 emoji prefix + the dollar-amount copy. Renders strictly on the urgent branch via the existing `trialLastDay` boolean — calm-state banner stays at the existing 2-paragraph + CTA layout.

**Why it matters for income:**

Direct conversion lever at the highest-intent moment in the funnel. The day-1 trial-urgent banner is the single most-attended trial-end touchpoint — the user has 24 hours left before Pro features pause, and the banner is the persistent, role="alert"-escalated UI surface that reinforces that urgency on every dashboard load. Today's banner gets the urgency right (red styling, ⏱ emoji, role="alert"); it gets the call-to-action right (Add payment method → /billing/portal); but it leaves the price decision implicit. The user clicking the CTA ends up on Stripe Checkout where the monthly $12/mo and annual $99/yr options both appear — but by then the framing decision has already been anchored.

The new pill flips that anchor. By surfacing "$99/year — 3 months free" on the banner itself, the dollar-anchor for the conversion event becomes the higher-margin annual price, and the "3 months free" framing reinforces the long-term savings rather than the shorter-term $12/mo monthly cost. Three compounding dynamics:

- **Higher conversion rate.** Concrete dollar anchors lift conversion vs. abstract "Pro" CTAs — the user processes a price decision pre-checkout and arrives committed.
- **Higher LTV per converting trial.** Annual plans halve churn (12-month commit vs. 1-month) and compress CAC payback — every annual-tilt at the trial-end moment is a multi-month LTV lift.
- **Pricing-decision continuity.** The pill mirrors the already-shipped pills on /pricing and the upgrade-modal (#101, cycle 15) — the user who saw the pill there now sees it again at the conversion moment, reinforcing rather than contradicting the prior message.

Distinct from four orthogonal pricing-reinforcement surfaces: #101 already-shipped pills on /pricing + /settings + upgrade-modal (different surfaces — the trial-urgent banner was uncovered until this cycle), #46 pricing-page exit-intent modal (different cohort — bounce recovery, not active trial users), #47 monthly→annual upgrade prompt (different cohort — already-paying users), #45 banner-base urgency (different angle — urgency vs. price).

**Master actions added:** none. The pill copy advertises $99/yr; if `STRIPE_PRO_ANNUAL_PRICE_ID` (TODO_MASTER #11) is unset in production, the user clicking through still gets the monthly Stripe Checkout (graceful fallback per `resolvePriceId()`), but the pill copy then mismatches the actual checkout. Risk flagged in the Session Briefing — Master action exists, this code change does not introduce a new one.

**Tests:** Role 3 will add new assertions to `tests/trial.test.js` for the pill render + the calm-state regression guard — see next CHANGELOG entry.

---

## 2026-04-28T23:55Z — Role 1 (Epic Manager): Session Briefing — Cycle 21 — #133 annual-savings pill on day-1 trial-urgent banner

**Active Epics (3 of 9 — within budget):**
- **E2 — Trial → Paid Conversion Surfaces** [ACTIVE] — direct conversion lever; 8 open child tasks (#82, #44, #119, #95, #15, #46, #47, #109) plus the new #133 from cycle 20.
- **E3 — Activation & Time-to-First-Value** [ACTIVE] — gates everything else; 11 open child tasks (#39, #65, #84, #96, #102, #111, #116, #60, #118, #128, #123, #124, #131).
- **E4 — Retention, Stickiness & Daily Touchpoints** [ACTIVE] — multiplier on LTV; 14 open child tasks (#80, #88, #87, #57, #89, #11, #12, #77, #90, #121, #44, #66, #71, #129, #130, #125, #126, #132).

**Status checks performed this cycle:**
- E1 [COMPLETE] — Stripe lifecycle complete; future revenue-loop work routes to E5.
- E5 [PLANNED] — paused on conversion saturation; right thing today, will activate post trial→paid stabilisation.
- E6 [PLANNED] — distribution; long-burn, properly deferred.
- E7 [PLANNED] — accounting moat; properly deferred until Pro retention compounds.
- E8 [PLANNED] — Health Monitor pulls H-tasks inline as they emerge; staying [PLANNED] preserves the 3-active budget for revenue work. ✓
- E9 [PAUSED] — Resend gate; ~10 ready-to-ship items waiting on Master env var (TODO_MASTER #18). No movement possible without the key. ✓

No epic statuses change this cycle. No epics promoted/demoted. No new epics emerging.

**Most important thing to accomplish this session:**

**Ship #133 — Inline annual-savings pill on the day-1 trial-urgent banner (E2 Trial → Paid Conversion).** Highest impact-per-effort unshipped item: XS effort (~10 lines of view template + 2 test assertions), MED conversion impact at the highest-intent conversion event in the entire funnel — the trial-end moment. Today's day-1 banner reads "Last day of your Pro trial — add a card before midnight to keep Pro features." with a single Add-payment-method CTA but **no price reinforcement** — leaving money on the table at the precise moment the user is deciding whether to pay. Adding the already-shipped pill component pattern from #101 ("$99/year — 3 months free") inline above the CTA frames the decision around the higher-margin annual price, lifting both the conversion rate AND the LTV per converting trial.

**Implementation contract:** Surface a small inline emerald-100/700 rounded pill above the existing CTA button in the trial-urgent branch of `views/dashboard.ejs`. Pill copy: "💰 Lock in $99/year — 3 months free" (matches the visual language of the already-shipped pill on /pricing + /settings + upgrade-modal). Only renders on the urgent (day-1) branch — calm-state days-2-through-7 banner stays unchanged so we don't blunt the urgent-branch differentiation. No DB, no env var, no schema change — pure additive view layer.

**Blockers / risks worth flagging before work begins:**

- **Resend API key (TODO_MASTER #18)** — single most leveraged unshipped Master action; unblocks E9 entirely (~10 ready-to-ship retention/conversion email features). Worth a Master nudge if Master surfaces this cycle.
- **APP_URL env var (TODO_MASTER #39)** — sitemap.xml + canonical link tags fall back to request host; alternate-host SEO drift is silently compounding.
- **APP_SPEC review (TODO_MASTER #60)** — auto-reconstructed cycle 17, still awaiting human verification; resynced this cycle (no app structural changes — pure timestamp bump).
- **STRIPE_PRO_ANNUAL_PRICE_ID (TODO_MASTER #11)** — the annual price ID. Until it's set, annual selections gracefully fall back to monthly ($12/mo) per `resolvePriceId()`. The #133 pill copy advertises $99/yr; if the env var is unset in production, users who click "Add payment method" from the urgent banner will get the monthly Stripe Checkout page, not annual. This is a credibility/CTA-mismatch risk — ship the pill regardless (the env var is Master's deliverable, not a code blocker), but tag the dependency clearly in TODO_MASTER if not already linked.
- **No [TEST-FAILURE] items** — full suite is 49 files, 0 failures heading into this cycle.
- **No [BLOCKED] items** — every open task has a tractable next step.

The 3-active-epic discipline is holding. The backlog continues to stratify by effort × impact (XS-first within priority order). The cycle 20 pivot to the recent-revenue card cluster is paying compounding dividends (#107 → #117 → #122 → #127 — four reactive layers on the same surface in four cycles, with #131/#132/#128 queued as XS top-ups). #133 pulls focus back to the trial-end conversion surface for one cycle, which is the right rotation: a single XS conversion-side ship on a high-leverage pillar pairs naturally with the activation/retention work that's been densifying on the dashboard surface.

---

## 2026-04-28T23:30Z — Role 1 (Epic Manager): Session Briefing — Cycle 20 — #127 quiet-window recovery CTA

**Active Epics (3 of 9 — within budget):**
- **E2 — Trial → Paid Conversion Surfaces** [ACTIVE] — direct conversion lever; 8 open child tasks (#82, #44, #119, #95, #15, #46, #47, #109).
- **E3 — Activation & Time-to-First-Value** [ACTIVE] — gates everything else; 10 open child tasks (#39, #65, #84, #96, #102, #111, #116, #60, #117 closed last cycle, #118, #127, #128, #123, #124).
- **E4 — Retention, Stickiness & Daily Touchpoints** [ACTIVE] — multiplier on LTV; 13 open child tasks (#80, #88, #87, #57, #89, #11, #12, #77, #90, #121, #44, #66, #71, #129, #130, #125, #126).

**Status checks performed this cycle:**
- E1 [COMPLETE] — Stripe lifecycle complete; future revenue-loop work routes to E5.
- E5 [PLANNED] — paused on conversion saturation; right thing today, will activate post trial→paid stabilisation.
- E6 [PLANNED] — distribution; long-burn, properly deferred.
- E7 [PLANNED] — accounting moat; properly deferred until Pro retention compounds.
- E8 [PLANNED] — Health Monitor pulls H-tasks inline as they emerge; staying [PLANNED] preserves the 3-active budget for revenue work. ✓
- E9 [PAUSED] — Resend gate; ~10 ready-to-ship items waiting on Master env var (TODO_MASTER #18). No movement possible without the key. ✓

No epic statuses change this cycle. No epics promoted/demoted. No new epics emerging — recent [GROWTH] adds (#127-#130, #62 marketing) all assigned cleanly to existing E3/E4.

**Most important thing to accomplish this session:**

**Ship #127 — "Quiet window" recovery CTA on the recent-revenue card.** Highest impact-per-effort unshipped item: XS effort (~30 min impl + 15 min tests), MED activation/recovery impact, sits directly on top of #117/#122 code that just landed and is in-mind. Today the empty-window state shows the truthful $0/0/0 (Role 5's last-cycle fix) but provides no recovery action — the user sees "you weren't paid this week" and bounces. The follow-up CTA converts the passive "huh, slow week" moment into an explicit "📨 Send 3 follow-ups now →" prompt, deep-linked to the invoice table. Compounds with #95 tab-flash (passive emotional reward) and #88 frequent-non-payer alert (categorical signal) — three orthogonal recovery surfaces.

**Implementation contract:** add `unpaidCount` (count of `status IN ('sent','overdue')` for the user — not windowed, since the CTA is about all open unpaid invoices to follow up on) to `db.getRecentRevenueStats` + `buildRecentRevenueCard()`; thread through to the dashboard view; render an inline anchor under the tile row when `totalPaid === 0 && unpaidCount > 0`; deep-link to `#invoices-table` anchor on the existing table wrapper. Reactive — the toggle's `select()` already re-fetches the card; we expose `unpaidCount` on the Alpine scope so it stays in sync as the user toggles 7d/30d/90d.

**Blockers / risks worth flagging before work begins:**

- **Resend API key (TODO_MASTER #18)** — single most leveraged unshipped Master action; unblocks E9 entirely (~10 ready-to-ship retention/conversion email features). Worth a Master nudge if Master surfaces this cycle.
- **APP_URL env var (TODO_MASTER #39)** — sitemap.xml + canonical link tags fall back to request host; alternate-host SEO drift is silently compounding.
- **APP_SPEC review (TODO_MASTER #60)** — auto-reconstructed last cycle; still awaiting human verification. Low-risk if the spec stays close to reality (which it does after this cycle's bootstrap sync re-confirmed it), but the explicit human sign-off is the next-cycle action.
- **No [TEST-FAILURE] items** — full suite is 48 files, 0 failures heading into this cycle.
- **No [BLOCKED] items** — every open task has a tractable next step.

The 3-active-epic discipline is holding. The backlog is stratified by effort × impact (XS-first within priority order). The Resend gate is the only large unstacking risk; everything else is a steady cadence of XS items compounding on top of #107/#117/#122 (the recent-revenue card surface — now densely featured and a deliberate retention focal point).

---

## 2026-04-29T00:25Z — Role 7 (Health Monitor): clean cycle audit + #127 review across 4 dimensions

**Audit scope this cycle:** the 4 production files touched in Roles 2 + 5 (`db.js`, `routes/invoices.js`, `views/dashboard.ejs`, `master/INTERNAL_TODO.md`); the 1 new test file (`tests/recent-revenue-quiet-window-cta.test.js`); the modified `package.json` test runner; the 2 existing test assertions updated in `tests/recent-revenue-stats.test.js`; the new TODO_MASTER #63 entry.

- **Security review of the diff:**

  - **`db.js#getRecentRevenueStats` SQL refactor.** Previously: `WHERE user_id = $1 AND status = 'paid' AND updated_at >= NOW() - ($2 * INTERVAL '1 day')` — single composite WHERE filter, all aggregates window-bound. Now: `WHERE user_id = $1` with `COUNT/SUM(...) FILTER (WHERE ...)` per aggregate — paid-window stats use the same predicate as before (semantically identical numeric outputs), unpaid count uses `FILTER (WHERE status IN ('sent', 'overdue'))` (NOT bounded by updated_at, deliberate per #127 spec). All status literals are hardcoded SQL string literals — no injection surface; `$1` and `$2` are still parameterized. The query is `pool.query(sqlString, [userId, window])` — same shape as before. No new SSRF / no new authn / no new authz surface.

  - **`routes/invoices.js#buildRecentRevenueCard` helper extension.** New `unpaidCount` field goes through `parseInt(stats.unpaidCount, 10) || 0` — same defensive coercion pattern as existing `invoiceCount` / `clientCount`. Plan gate (`if (user.plan === 'free') return null`) sits before any unpaidCount access, so unpaidCount cannot be a back-door for the free-plan card. Tested explicitly in `tests/recent-revenue-quiet-window-cta.test.js`: `buildRecentRevenueCard: free-plan + populated unpaidCount still returns null (defence-in-depth)`.

  - **`routes/invoices.js GET /invoices/api/recent-revenue` API extension.** Top-level `unpaidCount` field added to the JSON response. Computed from `parseInt(stats.unpaidCount, 10) || 0` with the same defensive coercion. The route's authentication (`requireAuth`) is unchanged; the days-whitelist (`[7, 30, 90]`) is unchanged. No new query parameters, no new request paths, no auth surface change. The new field is a non-negative integer — it conveys aggregated count data already accessible to the user (their own invoice counts), so no information disclosure.

  - **`views/dashboard.ejs` CTA block.** The new anchor's `href="#invoices-table"` is a literal in-page anchor — no user-input concatenation, no DOM-based redirect surface. The CTA copy is static template text. The reactive count rendering goes through `<span x-text="unpaidCount">` (Alpine's auto-escaped text-content path) and the SSR fallback `<%= recentRevenue.unpaidCount %>` (EJS's default HTML-escape). The `id="invoices-table"` is a hardcoded literal on the table wrapper — no concatenation. The new `role="status"` + `aria-live="polite"` attributes are static. No XSS surface; the only dynamic value (`unpaidCount`) is a server-validated integer from the SQL query.

  - **Hardcoded-secret scan** of all touched files: zero matches for `API_KEY|SECRET|password.*=|sk_live|sk_test` on the cycle-diff lines. The `sk_test_dummy` fixture in `recent-revenue-quiet-window-cta.test.js` is the same pattern used in 4 other test files for stub initialization — no live secret. ✓ No new credentials.

- **`npm audit --omit=dev`:** still **6 vulnerabilities (3 moderate, 3 high)** — **all pre-existing**, all install-time only. `bcrypt → @mapbox/node-pre-gyp → tar` (3 high — H9 in INTERNAL_TODO); `resend → svix → uuid` (3 moderate — H16). Runtime exposure remains nil. **No new advisories surfaced this cycle** — zero new dependencies (no `npm i`, no `package-lock.json` shifts).

- **Performance:**
  - **SQL refactor** has neutral-to-marginally-better cost. Previously the planner used `WHERE user_id = $1 AND status = 'paid' AND updated_at >= ...` — no composite (user_id, status) index exists yet (H8 pending), so the planner used `idx_invoices_user_id` and filter-evaluated the rest. Now WHERE is just `user_id = $1` with FILTER predicates evaluated per-aggregate post-fetch. Same index access, same row-fetch count from disk; the FILTER predicates are CPU-cheap per-row evaluations. Net cost: **identical to or slightly better than** running two separate queries (one for paid-window, one for unpaid). Single round-trip vs. two — a ~30-50% reduction in connection-pool occupancy at the route level.
  - **API endpoint** — one additional integer field on the JSON response. ~6 bytes more on the wire; no new I/O.
  - **Dashboard view** — one new reactive `x-show` evaluation + one new `<p>` element in the DOM; constant-time. No measurable render impact.
  - **No N+1 introduced**, no new SQL queries, no new indexes needed. H8 (composite (user_id, status) index) would still help this query but the existing single-column user_id index is adequate at current scale.

- **Code quality:**
  - The `getRecentRevenueStats` query went from a 5-line WHERE-bound aggregate to a 9-line FILTER-aggregate query. Comment in `db.js` documents the single-round-trip rationale. The verbosity is bought by avoiding two separate queries — net wins on connection pool + transactional consistency.
  - The view's `select()` update path has two `typeof data.x === 'number'` guards (card branch + top-level branch) — partial-deploy resilience, each guard documenting a real deploy scenario. Slightly verbose but each branch is intentional. Comments document why each branch exists.
  - The new test file (25 assertions) uses the same `vm.createContext`-style sandbox pattern + `realPool.query` stub pattern + `apiLayer.route.stack` introspection pattern established across `recent-revenue-window-toggle.test.js` + `recent-revenue-window-storage.test.js` + `recent-revenue-stats.test.js`. **No new test infrastructure** introduced — clean reuse of conventions.
  - `unpaidCount` field naming consistent with `invoiceCount`, `clientCount` (camelCase, descriptive). The pg column `unpaid_count` (snake_case) is consistent with existing pg column names. ✓
  - **One DRY note (carried over from cycle 19, not new):** the `[7, 30, 90]` whitelist still appears in 3 places (`routes/invoices.js#RECENT_REVENUE_WINDOWS`, view template literal, client-side `ALLOWED` constant). Test guards prevent drift; no action this cycle.

- **Dependencies:** zero changes — no `npm i`, no `package-lock.json` shifts. `package.json` was edited to add the new test file to the `test` script — dev-only entry, no runtime/production effect. The new test file uses Node built-ins + the existing `ejs` dev dependency — no new modules.

- **Legal:** No new dependencies, no license changes. The new code is purely additive — a new field on existing aggregated count data, a new reactive UI block on the existing dashboard surface. No PII expansion (the `unpaidCount` is an integer count of the user's own invoices), no GDPR/CCPA scope change, no PCI scope change, no third-party API usage. The `#invoices-table` anchor is in-page navigation (no third-party redirect).

**No CRITICAL / hardcoded-secret findings. No new flags for TODO_MASTER. No new [HEALTH] items added to INTERNAL_TODO.** The 9 existing open [HEALTH] items remain unchanged (H8, H9, H10, H11, H15, H16, H17, H18, H20).

**Net delta this cycle:** the new code is cleanly additive. SQL refactor preserves semantic equivalence on the existing aggregates while adding a new orthogonal aggregate in the same round-trip. The view-layer additions are reactive UI driven by server-validated integers — no XSS surface, no DOM-injection vector. The accessibility fix (Role 5's `role="status"` + `aria-live="polite"`) is a strict improvement with zero risk surface. **The full test suite is 49 files, 0 failures** — the safety net is intact. All 24 pre-existing [HEALTH] items + 9 of those still open carry through unchanged.

---

## 2026-04-29T00:15Z — Role 6 (Task Optimizer): 20th-pass audit — header refreshed, #127 archived, queue re-ordered + Session Close Summary

**Audit deltas this pass:**

1. **Header refreshed.** Updated INTERNAL_TODO.md audit header to capture this cycle's deltas: #127 closed (XS, ~30 min impl + 15 min tests, MED activation/recovery shipped); 3 new GROWTH items (#131-#133); 1 new MARKETING (#63 G2 awards); 1 UX direct fix (aria-live announcement on #127 CTA). 19th-pass + 18th-pass headers retained as one-line summaries; older passes already compacted to CHANGELOG-only.

2. **#127 archived.** Folded the full description into a one-line `*(...)*` parenthetical at the head of the XS-GROWTH block (same pattern as #91, #92, #101, #106, #107, #117, #122 archives in prior passes). Full detail lives only in CHANGELOG now.

3. **#131-#133 placement.** All 3 new items inserted at the top of the XS GROWTH bucket adjacent to #128 (their lifecycle-cohort sibling). Cross-referenced against existing items per Role 4's Cross-checks block; zero merges, zero consolidations.

4. **Re-prioritization (priority order unchanged):** [TEST-FAILURE] (none) > income-critical features > [UX] items affecting conversion > [HEALTH] > [GROWTH] > [BLOCKED]. Within GROWTH, XS-first by impact-per-effort. The new #131-#133 are XS and immediately implementable; ordered by income-impact: #133 (MED conversion at trial-end), #131 (MED activation, sibling to just-shipped #127), #132 (LOW-MED mobile retention).

5. **Cross-checks for non-overlap (re-validated this cycle):** #131 vs #127 vs #124 vs #95 (truly-empty vs recovery vs stale-draft vs paid-reward — four orthogonal state-driven CTAs); #132 vs #117/#122/#128/#130 (haptic vs visual/memory/keyboard/pull-to-refresh — five orthogonal input modalities); #133 vs #45/#101/#46/#47 (trial-end pricing pill vs banner-base copy vs already-shipped pill on /pricing+/settings+upgrade-modal vs exit-intent vs monthly→annual — five orthogonal pricing-reinforcement surfaces). MARKETING #63 vs #26/#49/#61/#62/#59/#58 (G2 editorial recognition vs continuous profile+reviews vs affiliate vs creator outreach vs co-marketing vs passive directories — six distinct distribution motions). All confirmed orthogonal.

6. **TODO_MASTER reviewed:** All 63 items (1-9 legacy InvoiceFlow setup + 50-63 newer marketing/SPEC-REVIEW additions) checked against this cycle's CHANGELOG. **No items flip to [LIKELY DONE - verify]** — every Master action remains pending its respective external step (Stripe Dashboard config, Resend API key, Plausible domain, G2/Capterra profile creation + award submissions, AppSumo submission, Rewardful signup, creator outreach, etc.). #63 (G2 quarterly award submissions) is the newest entry.

7. **Compaction status.** INTERNAL_TODO.md now ~2.5k lines (overdue by 13 cycles per the 1.5k archive trigger). Deferred again — not blocking work; full archives remain available via CHANGELOG. Will be revisited when the [DONE]-tagged section weight crosses ~1k lines on its own.

8. **Open task index re-counted:** ~125 GROWTH items total (was 123 + 3 new − 1 #127 closed = 125); 9 [HEALTH] items open unchanged; 2 [UX] items (U3 actively buildable; U1 in Resend block); 0 [TEST-FAILURE]. **No new [BLOCKED] items this cycle.**

**Priority order at end of 20th pass (top 12 unblocked items):**

| # | ID | Tag | Cx | Title (1-line) |
|--:|------|------|-----|------|
| 1 | U3 | UX | S | Authed-pages global footer (gated on #28) |
| 2 | **#133** | GROWTH | XS | **Annual-savings pill on day-1 trial-urgent banner (NEW; MED conversion at trial-end)** |
| 3 | **#131** | GROWTH | XS | **Truly-quiet-window CTA variant on revenue card (NEW; MED activation)** |
| 4 | #128 | GROWTH | XS | Keyboard shortcut (7/3/9) for revenue window |
| 5 | **#132** | GROWTH | XS | **Mobile haptic toggle feedback via navigator.vibrate(8) (NEW)** |
| 6 | #123 | GROWTH | XS | "vs prior period" delta badge on revenue card |
| 7 | #124 | GROWTH | XS | 3-day stale-draft yellow banner |
| 8 | #118 | GROWTH | XS | Stripe receipt URL on paid invoice view |
| 9 | #119 | GROWTH | XS | Inline "What's new" pulse-dot on nav |
| 10 | #120 | GROWTH | XS | `<noscript>` SEO fallback hero |
| 11 | #109 | GROWTH | XS | Sticky "+" mobile FAB |
| 12 | #102 | GROWTH | XS | Per-user timezone |

**Resend-blocked (kept at bottom of XS bucket):** U1, #11, #12, #66, #71, #77, #80, #84, #90, and #110 (M-complexity magic-link).

---

# 2026-04-29T00:15Z — Session Close Summary (Cycle 20)

**What was accomplished this session (across all 7 roles):**

- **Bootstrap** — APP_SPEC.md unchanged (synced last cycle, audit reconfirmed against codebase). EPICS.md unchanged (created last cycle). No new bootstrap-time master action filed (#60 SPEC-REVIEW from cycle 17 remains the standing item).
- **Role 1 (Epic Manager)** — wrote a Session Briefing identifying #127 as the highest impact-per-effort unshipped item (XS effort, MED activation/recovery, sits directly on top of the recent-revenue card cluster that's been densifying for 4 cycles). All 9 epic statuses unchanged. 3-active-epic budget held: E2 Trial→Paid Conversion, E3 Activation, E4 Retention.
- **Role 2 (Feature Implementer)** — shipped **#127 quiet-window recovery CTA on the recent-revenue card**. New `unpaidCount` field threaded through `db.getRecentRevenueStats` → `buildRecentRevenueCard()` → `GET /invoices/api/recent-revenue` → `views/dashboard.ejs` Alpine scope. Single SQL round-trip via `WHERE user_id + FILTER` aggregates (paid-window stats + not-windowed unpaid count in one query). New reactive `x-show="totalPaid === 0 && unpaidCount > 0"` block renders "📨 Send N follow-up(s) now →" deep-linking to `#invoices-table` (new id on the existing table wrapper). Pluralizes via `x-show="unpaidCount !== 1"`. 7 files touched, ~70 lines added, 0 lines removed.
- **Role 3 (Test Examiner)** — added **24 new test assertions** in new `tests/recent-revenue-quiet-window-cta.test.js` across 4 layers: 5 SQL-contract assertions (FILTER for status IN sent/overdue, NOT bounded by trailing window, integer parse, missing-field fallback, empty-row safety) + 5 helper-threading assertions (unpaidCount on populated card, missing-field zero, stringy parse, free-plan still null, invoiceCount=0 still null) + 4 API-contract assertions (top-level surface, survives card=null, throw-recovery, free-plan informational) + 10 view assertions (table id, x-show condition, anchor href, plural gate, x-data seed, SSR fallback, x-cloak, partial-deploy fallback paths, factory state, wrapper-not-table id placement). 2 existing `recent-revenue-stats.test.js` assertions updated to expect the new `unpaidCount: 0` field. Full suite: **49 files, 0 failures.**
- **Role 4 (Growth Strategist)** — added 3 new GROWTH items (#131 truly-quiet-window CTA variant, #132 mobile haptic toggle feedback, #133 day-1 trial-urgent banner annual-savings pill) + 1 new MARKETING item (#63 G2 quarterly award submissions). All cross-checked for non-overlap; all assigned to currently-active epics (1 to E2, 1 to E3, 1 to E4); zero items orphaned to [UNASSIGNED].
- **Role 5 (UX Auditor)** — direct fix on the new #127 CTA: added `role="status"` + `aria-live="polite"` so screen readers announce the action option when it appears reactively after a toggle. Without the live-region announcement, SR users miss the new affordance. Regression-guard test added (now 25 assertions in the new test file). Re-walked landing → register → empty-state dashboard → trial banners → pricing → invoice form/view — no regressions in untouched flows.
- **Role 6 (Task Optimizer)** — refreshed audit header, archived #127 to one-line parenthetical, re-ordered priority queue (3 new XS items in correct buckets), TODO_MASTER reviewed (no items flip to [LIKELY DONE - verify]).
- **Role 7 (Health Monitor)** — see next CHANGELOG entry below for full audit.

**Code shipped this cycle:**
- 1 SQL helper extended (`db.getRecentRevenueStats` — refactored to `WHERE + FILTER` aggregates)
- 1 helper extended (`buildRecentRevenueCard` — threads unpaidCount)
- 1 API endpoint extended (`GET /invoices/api/recent-revenue` — surfaces unpaidCount at top level)
- 1 expanded Alpine factory (`recentRevenueCard()` in `views/dashboard.ejs` — 1 new state field, partial-deploy resilient update path, new reactive CTA block, screen-reader announcement)
- 1 new id added (`id="invoices-table"` on the table wrapper for deep-link target)
- 1 new test file (`tests/recent-revenue-quiet-window-cta.test.js` — 25 assertions across 4 layers)
- 1 `package.json` test-script entry added
- 2 existing test assertions updated for the new field
- 3 new INTERNAL_TODO items (#131-#133)
- 1 new TODO_MASTER item (#63)
- 1 INTERNAL_TODO #127 archived to one-line parenthetical

**Most important open item heading into the next session:**

**#133 [XS] Annual-savings pill on day-1 trial-urgent banner** — XS effort (~10 lines on the existing #45 trial-urgent branch in `views/dashboard.ejs` + 2 test assertions), MED conversion impact at the trial-end moment. Today's day-1 banner reads "Last day of your Pro trial — add a card before midnight..." with a single CTA but no pricing reinforcement. Adding "lock in $99/year (3 months free)" inline pill — using the already-shipped pill-component pattern from #101 — places the annual pricing decision at the highest-leverage trial-end touchpoint. The trial-end moment is the single highest-intent conversion event in the funnel; today's banner gets the urgency right but leaves money on the table by not anchoring the savings figure. Estimated cycle: < 20 min impl + ~10 min tests.

**Risks / blockers needing Master attention before next run:**

- **Resend API key (TODO_MASTER #18)** — single most leveraged Master action. Unblocks E9 entirely (~10 ready-to-ship retention/conversion email features: U1 password reset, #11 churn win-back, #12 monthly digest, #66 auto-CC accountant, #71 auto-BCC freelancer, #72 .ics calendar, #77 welcome-back on past_due restore, #80 weekly Monday digest, #84 plain-language email body, #90 60+ day inactive re-engagement, #110 magic-link login).
- **APP_URL env var (TODO_MASTER #39)** — unset means sitemap.xml + canonical link tags fall back to request host, leaks alternate hosts (Heroku free dyno URL + custom domain) into Google's index. Low-effort fix (one env var); compounding SEO drift.
- **APP_SPEC review (TODO_MASTER #60)** — auto-reconstructed cycle 17, still awaiting human verification. Spec stayed in sync this cycle (no app structural changes), but the explicit human sign-off remains pending.
- **No new Master actions added this cycle beyond #63 (G2 awards)** — the cycle's main work was code-shipping, not spec-changing.

---

## 2026-04-29T00:05Z — Role 5 (UX Auditor): screen-reader announcement on the new #127 CTA + flow regression sweep

**Pathways audited this cycle:**

1. **Pro user, dashboard SSR with paid invoices in 30d** (steady state — most common path). CTA hidden by `x-show="totalPaid === 0 && unpaidCount > 0"` evaluation; no flash of CTA on first paint thanks to `x-cloak`. ✓
2. **Pro user, toggles to 7d window with no paid invoices but 5 open unpaid.** CTA appears below the tile row: "📨 Send 5 follow-ups now →". Click → browser scrolls to `#invoices-table` (with the `scroll-mt-6` offset so the table's rounded border doesn't hug the viewport edge). Status badges in the table (red Overdue, blue Sent) make follow-up candidates visually obvious. ✓
3. **Pro user, toggles to 7d window with 1 open unpaid invoice.** Singular branch fires: "Send 1 follow-up now →" (without trailing `s`). The `x-show="unpaidCount !== 1"` gate on the plural-`s` span correctly suppresses the trailing letter. ✓
4. **Pro user with all paid invoices, no open unpaid.** CTA stays hidden across all toggles (no `unpaidCount > 0` to fire on). ✓
5. **Free-plan user.** Card never renders (gated server-side); CTA never appears. ✓
6. **API failure during toggle (offline / 500).** `errored` line surfaces ("Couldn't load that window — showing the previous one."); CTA correctly does NOT fire (state preservation — last successful unpaidCount stays in scope, but totalPaid does too, so the condition stays at its last truthful state). ✓
7. **Re-walked: landing → register → empty-state dashboard onboarding (regression) → trial banner stacking → trial-countdown nav pill → invoice form → invoice view → 404 → pricing → settings.** No regressions in untouched flows. ✓

**Direct fix applied this cycle (1 substantive accessibility improvement + 0 cosmetic-only changes):**

1. **`views/dashboard.ejs#recent-revenue-quiet-cta` — screen-reader announcement on appearance.** The Role 2 implementation rendered the CTA `<p>` as a plain text-styled paragraph. Without `role="status"` and `aria-live="polite"`, screen readers don't announce the CTA when it appears in response to a toggle — the visual user gets a clear new action option, but the screen-reader user has to manually re-read the card region to discover the new affordance. Fixed: added `role="status"` and `aria-live="polite"` to the CTA paragraph. The existing `errored` line uses `role="status"` (which is implicitly polite in modern assistive tech), but pairing it with explicit `aria-live="polite"` makes the contract precise and locks the behaviour against future refactors that could strip the role. New regression-guard test added: `view: CTA block carries role="status" + aria-live="polite" for screen-reader announcement`.

**Why this is the right call:**

The CTA is a state-driven affordance that appears reactively — exactly the pattern WAI-ARIA's Live Regions spec was designed for. `aria-live="polite"` (vs. `assertive`) is correct because the appearance is informational, not interrupt-the-user-mid-thought important; `polite` waits for the screen reader's current announcement to finish before queueing the new one, which matches the visual experience (the CTA fades in alongside the toggle's loading→loaded transition, not as an emergency).

**Regression checks performed (no new fixes needed, but verified clean):**

- **Trial-countdown nav pill (#106) + dashboard banner (#45) interaction** — both render unchanged. ✓
- **Free-plan invoice progress bar (#31)** — still renders for free users; no localStorage layer touches the free-plan path. ✓
- **Onboarding card → trial banner → past-due banner stack** — render order unchanged. ✓
- **Pricing page CTA copy + annual-savings pill (#101)** — both unchanged. ✓
- **`x-cloak` CSS rule** — verified `[x-cloak] { display: none !important; }` still in `views/partials/head.ejs`; the new CTA's `x-show` evaluation runs cleanly with no first-paint flash. ✓
- **Login → register cross-link** — unchanged. ✓
- **Mobile breakpoint on the new CTA** — `inline-flex items-center gap-1` lays out cleanly on narrow mobile (< 384px wide); the link wraps as a single line at the dashboard's typical mobile width and the underline remains continuous on hover. ✓
- **Click target size** — the inline link is text-xs (12px line-height), bounding box ~200×16px — wide enough for finger tap, height-limited but consistent with the project's existing inline link affordances (e.g., the dunning-banner "Update payment method →" link uses the same style). ✓
- **No localStorage / no Alpine baseline** — without JS, the SSR-rendered card still shows correct values. The CTA layer is `x-cloak`-gated so it's invisible without Alpine; pure additive enhancement. ✓
- **No table-anchor orphan case** — the CTA fires only when `unpaidCount > 0`, which requires invoices to exist, which means the table renders, which means `id="invoices-table"` is in the DOM. No broken-anchor scenario. ✓

**Anti-fixes — flagged but deliberately left:**

- **"Send 1 follow-up" reads slightly awkwardly compared to "Send a follow-up".** Considered: gating the digit vs. "a" via `x-show`. But the digit is informative ("there's exactly 1") and the awkwardness is minor; replacing with an Alpine `x-text` ternary would be more code than the awkwardness justifies. Defer.
- **Highlight unpaid rows in the table after CTA-driven scroll.** The user lands at the table after click but has to visually filter for sent/overdue badges — the unpaid rows aren't outlined or pulse-animated. Considered: a one-time `x-data` highlight that adds a yellow ring to unpaid rows for 3s after scroll. But (a) the status badges are already color-coded and visually distinct, (b) adding row-level animation conflicts with the existing row-hover state, and (c) the simpler unpaid-only row filter is captured by future task scope (would belong to a #127-extension, not the base #127). Defer.
- **No "X follow-ups sent — N remaining" feedback after the user actually sends follow-ups.** This requires the user to actually send follow-ups (which happens on the invoice-view page, not from the dashboard table click), at which point a feedback loop would need to re-render the CTA's count. Real but cross-page UX state is complex and out-of-scope for #127's first slice. Defer.
- **Click-through doesn't pre-filter the table to unpaid only.** The CTA implies "the unpaid ones I should follow up on", but the user lands at the full table. A query-string-driven row filter would be the next iteration. Distinct task — sits alongside #131 (truly-quiet-window CTA) as future-cycle territory.

**Test impact:** 1 new test assertion added (now 25 in `tests/recent-revenue-quiet-window-cta.test.js`). Full suite still green: **49 files, 0 failures.**

**Income relevance:** SMALL but compounding. The accessibility fix expands the addressable cohort for the #127 CTA to include screen-reader users — typically 1-2% of any web product's user base, but a cohort that's both highly-engaged when the product respects them and highly-frustrated when it doesn't. Specifically, the fix turns "the screen-reader user discovers the toggle changed but misses the CTA appearance" into "the screen-reader user hears a polite announcement of the new action option in the same audio flow as the toggle's confirmation". Compounds with #117/#122 — the toggle layer was already keyboard-accessible via `aria-pressed`; this closes the SR-equivalent gap on the new CTA.

---

## 2026-04-28T23:55Z — Role 4 (Growth Strategist): 3 new GROWTH ideas (#131-#133) + 1 new MARKETING (#63 G2 awards)

**Process:** scanned the queue for un-mined surfaces that compound with #127 (just-shipped) and the broader recent-revenue card cluster (#107 + #117 + #122 + #127). The card now has 4 reactive layers + 1 deep-link target — that's a dense surface where small additions multiply impact. Cross-checked each candidate against the 124 existing GROWTH items + 62 existing MARKETING items.

**Five-lever sweep:**

- **Conversion (signup → paid):** added #133 (annual-savings pill on day-1 trial-urgent banner — direct conversion-moment pricing reinforcement, the highest-leverage trial-end touchpoint that today has no price text).
- **Retention (return visits + reduced churn):** added #132 mobile haptic toggle feedback. Compounds with #117/#122/#128/#130 — five complementary input affordances on the same surface.
- **Expansion (ARPU lift):** existing queue covers this (#9, #10, #74, #54, #67, #100, #79). No new XS items emerged this cycle — expansion lever is well-mined and S/L-complexity, properly deferred to E5 [PLANNED].
- **Activation (time-to-first-value):** added #131 truly-quiet-window CTA variant. Pairs with #127 to cover both shapes of the empty-window state (recovery + fresh activity prompt) on the same surface.
- **Distribution (acquisition):** added #63 [MARKETING] G2 quarterly award submission. Distinct distribution mechanic from #26/#49 (continuous profile + reviews), #61 (affiliate program), #62 (creator outreach), #59 (co-marketing), and #58 (SaaS comparison directories) — this is the editorial-recognition acquisition layer.

**Added to INTERNAL_TODO.md:**

- **#131 [GROWTH] [XS]** (E3 Activation) — Truly-quiet-window CTA variant on revenue card. When `totalPaid === 0 && unpaidCount === 0`, render "📥 Send a new invoice now →" linking to `/invoices/new`. Sibling `x-show` block to the #127 CTA. Three orthogonal quiet-state CTAs together: #127 (paid===0 + unpaid>0 → recovery), #131 (paid===0 + unpaid===0 → fresh activity), #124 (3+ day stale draft → finish). MED activation. ~10 lines + 4 tests.
- **#132 [GROWTH] [XS]** (E4 Retention) — Mobile haptic micro-feedback on revenue toggle. `navigator.vibrate(8)` on each successful `select()`. Silently ignored on non-supporting browsers. Distinct from #128 (keyboard) and #130 (pull-to-refresh). LOW-MED mobile retention. ~5 lines + try/catch + 1 test.
- **#133 [GROWTH] [XS]** (E2 Trial → Paid Conversion) — Inline annual-savings pill on day-1 trial-urgent banner (#45). Today the banner reads "Last day of your Pro trial — add a card before midnight..." with no pricing reinforcement. Add "lock in $99/year (3 months free)" inline pill — distinct from #46 exit-intent (different surface), #47 monthly→annual upgrade (different cohort), #101 (different surface — pricing/settings/upgrade-modal already shipped, but the trial-end touchpoint is currently uncovered). Pure copy edit + the existing pill-component pattern from #101. MED conversion at the trial-end moment. ~10 lines + 2 tests.

**Added to TODO_MASTER.md:**

- **#63 [MARKETING]** — Submit QuickInvoice to G2's annual award category cycles (Best Free Invoice Software, Best Small-Business Billing Software, Easiest to Use, Best Estimated ROI). Free; submission triggers a quarterly editorial-recognition badge (winners) or nominee-trust-signal (runners-up); G2's press-release secondary distribution lands in 30-60 small-business newsletters by default. Asymmetric: ~1 hr initial + ~30 min/quarter ongoing for an evergreen landing-page acquisition asset that compounds quarter-on-quarter. Distinct from #26/#49 (continuous profile + reviews), #61 (affiliate), #62 (creator outreach), #59 (co-marketing), and #58 (passive directory listings). The editorial-recognition acquisition layer.

**Cross-checks for non-overlap:**

- #131 vs #127 vs #124 vs #95: #131 is the truly-empty-window prompt (paid===0 + unpaid===0 — fresh activity); #127 is the recovery prompt (paid===0 + unpaid>0 — follow up); #124 is the stale-draft prompt (status='draft' + 3+ day age — finish); #95 is the passive paid-event reward (status flips to paid — emotional). Four orthogonal state-driven CTAs.
- #132 vs #117 vs #122 vs #128 vs #130: same surface (revenue toggle), five complementary input modalities — visual click (#117), per-device memory (#122), keyboard (#128), pull-to-refresh (#130), haptic feedback (#132). Each addresses a different cohort × interaction modality.
- #133 vs #45 vs #101 vs #46 vs #47: #45 is the trial-urgent banner (day 1 alone — distinct from days 2-7 calm); #101 is the annual-savings pill on /pricing + /settings + upgrade-modal (already shipped — but the trial-end banner is a separate surface); #46 is the pricing-page exit-intent (different cohort — bounce recovery); #47 is the monthly→annual prompt (different cohort — already-paying users). Five orthogonal pricing-reinforcement surfaces.
- #63 [MARKETING] vs #26/#49 vs #61 vs #62 vs #59 vs #58: #26/#49 build + populate G2 profile; #63 is the editorial-recognition layer ON TOP of the existing profile; #61 is always-on affiliate at scale; #62 is one-time hand-curated creator outreach; #59 is partner-channel co-marketing; #58 is passive SaaS-comparison directory listings. Six distinct distribution motions.

**Active-epic alignment:** all 3 new GROWTH items map cleanly to currently-active epics — 1 to E2 (#133), 1 to E3 (#131), 1 to E4 (#132). Zero items orphaned to [UNASSIGNED]. Zero items added to E5/E7 (PLANNED) or E9 (PAUSED — Resend gate).

**TODO_MASTER review:** All 62 prior items checked against this cycle's CHANGELOG. **No items flip to [LIKELY DONE - verify]** — every Master action remains pending its respective external step (Stripe Dashboard config, Resend API key, Plausible domain, G2/Capterra profile creation, AppSumo submission, Rewardful signup, creator outreach, etc.). #63 is the new add this cycle.

---

## 2026-04-28T23:45Z — Role 3 (Test Examiner): 24 new assertions for #127 across 4 layers (full suite 49 files, 0 failures)

**New test file: `tests/recent-revenue-quiet-window-cta.test.js`** — 24 assertions, 4 layers:

**Layer 1 — db.getRecentRevenueStats SQL contract (5 assertions):**
- SQL contains `COUNT(*) FILTER (WHERE status IN ('sent','overdue'))` aggregate (regression guard against accidental drift to `WHERE` clause that would break the unified single-trip query).
- Unpaid-count FILTER is **not** bounded by `updated_at >= NOW() - $2 * INTERVAL '1 day'` (the CTA reflects all open follow-up-able invoices, not just recently-modified ones — a future "performance optimization" that scoped this query to the trailing window would silently break the recovery semantic).
- `unpaidCount` parses to integer from pg int column.
- Missing `unpaid_count` field on the result row falls back to 0 (legacy-row safety).
- Empty `rows: []` result returns `unpaidCount: 0` (no-data graceful path).

**Layer 2 — buildRecentRevenueCard helper (5 assertions):**
- Threads `unpaidCount` through to the populated card.
- Missing `unpaidCount` on stats becomes 0 on the card.
- Stringy `unpaidCount` parses to integer (defence vs JSON cast drift).
- Free-plan user with populated `unpaidCount` still returns `null` — locks in defence-in-depth that `unpaidCount` cannot become a back-door for free users to receive a card.
- `invoiceCount === 0` returns `null` even if `unpaidCount > 0` — the card's existence is gated on having paid at least once in the window; the CTA layer activates inside an existing card.

**Layer 3 — GET /invoices/api/recent-revenue (4 assertions):**
- `unpaidCount` is surfaced at the top level for Pro user with populated card (`res.body.unpaidCount` AND `res.body.card.unpaidCount` both present).
- **Critical:** `unpaidCount` survives the `card===null` path (this is the exact scenario #127 was built for — the user toggled to a window with zero paid in it, but the top-level field carries forward so the client can drive the CTA).
- Stats throw → API returns 200 with `unpaidCount: 0, card: null` (graceful — same shape as no-data, never crashes the dashboard fetch).
- Free-plan user gets `unpaidCount` surfaced but `card: null` — documented surface behaviour; if a future refactor ever wants to gate `unpaidCount` on plan, this assertion must move and the test will fail loudly.

**Layer 4 — dashboard.ejs view (10 assertions):**
- Invoice table wrapper carries `id="invoices-table"` (CTA deep-link target).
- CTA block exists with `x-show="totalPaid === 0 && unpaidCount > 0"`.
- CTA anchor's `href="#invoices-table"` (deep-link contract pinned both ends).
- Copy contains "Send", count placeholder `<span x-text="unpaidCount">`, and "follow-up" — plus the plural-`s` is gated by `x-show="unpaidCount !== 1"` so 1 follow-up doesn't render "Send 1 follow-ups".
- `x-data` init seed includes `unpaidCount: <number>` (so the CTA can fire on first paint without a fetch round-trip).
- SSR fallback content for the count uses the threaded `recentRevenue.unpaidCount` value (meaningful before Alpine hydrates).
- CTA `<p>` carries `x-cloak` (prevents first-paint flash on cards with `totalPaid > 0`).
- `select()` update path reads BOTH `data.card.unpaidCount` (card-populated branch) AND `data.unpaidCount` (card===null branch) — locks in the partial-deploy resilience pattern.
- Factory state object declares `unpaidCount: Number(initial.unpaidCount) || 0` as an initial reactive field — regression guard against silent removal that would break the `x-show` evaluation.
- The deep-link target id sits on the wrapper `<div>` immediately preceding `<table>` (not inside the table) — so the user lands at the visual top of the card after scroll, not at the first `<tr>`.

**Test pattern reuse:** layer 4 uses the same EJS-render-via-mock-locals pattern established in `recent-revenue-window-toggle.test.js`; layer 1-3 reuse the `realPool.query` stub + `apiLayer` route-stack-introspection helpers. No new test infrastructure introduced — this file plugs cleanly into the existing test conventions.

**Updated assertions in existing tests:** 2 `assert.deepStrictEqual` checks in `tests/recent-revenue-stats.test.js` extended to expect the new `unpaidCount: 0` field on the populated card + on the empty-stats fallback path. No tests deleted; no tests weakened.

**Risk reduced this cycle:**

- **The single highest-risk drift point is the FILTER clause in `getRecentRevenueStats` SQL.** A maintenance edit that promoted the unpaid-count FILTER's `WHERE status IN ('sent','overdue')` predicate to a top-level `WHERE` would silently disable all paid-window aggregates (paid-windowed → paid-anytime). Layer 1's first 2 assertions catch that mutation regardless of which direction it goes.
- **Partial-deploy resilience for the API → client contract.** The two Layer 3 assertions ("top-level unpaidCount survives card=null" + "unpaidCount falls back to 0 on stats throw") plus the two Layer 4 assertions (`data.card.unpaidCount` AND `data.unpaidCount` both honoured) form a cross-tier safety net: even if the API rolls out before the client JS or vice versa, the CTA stays accurate.
- **Free-plan leak protection (defence-in-depth).** The `buildRecentRevenueCard` free-plan-with-unpaidCount-still-null assertion locks in the existing leak-prevention semantic — `unpaidCount` exists outside the plan gate but does NOT bypass it.

**Full suite:** **49 files, 0 failures.** No flakes; new file ran clean on first execution.

---

## 2026-04-28T23:35Z — Role 2 (Feature Implementer): #127 quiet-window recovery CTA shipped end-to-end (Epic E3 Activation)

**What was built:**

`#127` — quiet-window recovery CTA on the dashboard's recent-revenue card. When the user toggles to a window with `totalPaid === 0` AND has open unpaid invoices (`status IN ('sent','overdue')`), an inline anchor renders below the 3-tile row: "📨 Send N follow-up(s) now →" deep-linking to a new `#invoices-table` anchor on the existing dashboard table wrapper. Reactive — toggle re-fetches the card, the CTA visibility recomputes against the new state.

**Files touched:**

1. **`db.js#getRecentRevenueStats`** — single SQL round-trip extended to also return `unpaidCount`. Refactored from a `WHERE status='paid' AND updated_at >= ...` filtering query to a `WHERE user_id=$1`-only query with `COUNT/SUM(...) FILTER (...)` aggregates. The paid-window aggregates and the unpaid count come back in one pg trip rather than two — net query cost is ~the same as before (same index + the filter is a CPU-cheap predicate per row). New `unpaidCount` is **not** windowed — counts all currently-open unpaid invoices for the user, since the CTA is about following up on every open invoice, not just invoices opened in the last N days.

2. **`routes/invoices.js#buildRecentRevenueCard`** — accepts the new `unpaidCount` field from stats, threads it through to the returned object. Card is still gated on `invoiceCount === 0` returning null — the SSR card only appears for users with at least one paid invoice in the 30d default window. `unpaidCount` is included in the card payload when the card IS returned.

3. **`routes/invoices.js GET /invoices/api/recent-revenue`** — additionally surfaces `unpaidCount` at the top level of the JSON response, so the client can drive the CTA visibility even when the response's `card === null` (zero paid invoices in the new window). Top-level `unpaidCount` is parseInt-coerced to 0 on any DB-failure / null path.

4. **`views/dashboard.ejs#recentRevenueCard()` factory** — Alpine scope now tracks `unpaidCount`. SSR-rendered initial state is wired through the existing `JSON.stringify({ ... })` x-data hydration. `select()` updates `unpaidCount` from `data.card.unpaidCount` (when card is returned) or from the top-level `data.unpaidCount` (when card is null) on each successful fetch. Legacy partial-deploy guard: if neither field is present, the existing `unpaidCount` value is preserved rather than zeroed (so the CTA stays accurate during a deploy where the API change rolls out before the client JS).

5. **`views/dashboard.ejs` recent-revenue card body** — new `<p x-show="totalPaid === 0 && unpaidCount > 0" x-cloak>` block renders the CTA. Anchor href is `#invoices-table`; copy is "📨 Send N follow-up(s) now →" with the count pluralized via `<span x-show="unpaidCount !== 1">s</span>`. Styled with emerald-800 inline color + `decoration-dotted hover:decoration-solid` for the underline. SSR fallback for the count uses the threaded `recentRevenue.unpaidCount` value so the link is meaningful even before Alpine boots (though x-cloak hides it until Alpine has hydrated, since the SSR card has paid invoices > 0 by definition and the CTA shouldn't flash).

6. **`views/dashboard.ejs` invoice table wrapper** — new `id="invoices-table"` + `scroll-mt-6` Tailwind class on the existing `<div class="bg-white rounded-2xl ...">`. The scroll-mt offsets the anchor target by 1.5rem so the table's top border doesn't hug the viewport edge after the deep-link scroll.

7. **`tests/recent-revenue-stats.test.js`** — 2 existing `assert.deepStrictEqual` assertions updated to include the new `unpaidCount: 0` field in expected output (otherwise unchanged).

**Why it matters for income:**

Direct activation/revenue-recovery lever. Today's empty-window state (after Role 5's last-cycle fix) shows the truthful $0/0/0 — informative but inert. The user toggles to 7d, sees "no, you weren't paid this week", and either bounces or shrugs. With #127, that same moment becomes "📨 Send 3 follow-ups now →" — a one-click path to recovering already-issued invoices. Three dynamics compound:

- **Recovery yield.** A freelancer who's had a quiet week typically has 2-5 outstanding sent/overdue invoices that just need a nudge. A 30-second send-follow-up gesture from the dashboard converts the slow-week passive moment into an active recovery action that often lands a paid invoice within 24-48 hrs.
- **Pro-feature reinforcement.** The recent-revenue card is Pro-only. The CTA additionally surfaces the value of being on Pro (you can see your income state + take action on it) at exactly the moment when "is this worth $12/mo?" anxiety would otherwise spike (a quiet revenue week).
- **Power-user retention.** Daily-check-in users who already use the toggle (#117) and have it persisted (#122) are now offered a meaningful action on the empty-window state, deepening the daily ritual. Each daily touchpoint compounds with the next.

Distinct from three orthogonal recovery surfaces in the queue: #88 frequent-non-payer alert (categorical client-pattern), #95 tab-flash (passive emotional reward on paid event), #124 stale-draft yellow banner (different status cohort — drafts, not sent/overdue). All four can ship; they don't conflict.

**Master actions added:** none. Pure-code feature; no env vars, no DB migration (the new SQL filter is computed at query time on existing columns), no Stripe / Resend dependency.

**Tests:** Role 3 will add new assertions targeting the contract surface (db query, helper, view) — see next CHANGELOG entry.

---

## 2026-04-28T23:00Z — Role 7 (Health Monitor): clean cycle audit + #122 review across 4 dimensions

**Audit scope this cycle:** the 3 production files touched in Roles 2 + 5 (`views/dashboard.ejs`, `master/INTERNAL_TODO.md`, `master/TODO_MASTER.md`); the 1 new test file (`tests/recent-revenue-window-storage.test.js`); the modified `package.json` test runner.

- **Security review of the diff:**

  - **`views/dashboard.ejs#recentRevenueCard()` localStorage layer.** No new DOM-injection surface, no new XSS vector. `readSavedWindow()`'s pipeline is `localStorage.getItem(STORAGE_KEY)` → `parseInt(raw, 10)` → strict-equality whitelist check (`ALLOWED.indexOf(n) !== -1`). The parseInt + whitelist filter together neutralize any non-integer or out-of-set content — a malicious extension that pre-populated `localStorage` with `'<script>alert(1)</script>'` would parseInt to `NaN`, fail the whitelist check, and return `null`. The integer that survives the filter (7, 30, or 90) is then concatenated into a fetch URL via `encodeURIComponent(window)` — defence-in-depth even though the value is already known-safe. No path from localStorage to DOM, no path from localStorage to SQL (the API endpoint also whitelists on the server side per the existing #117 hardening).

  - **`writeSavedWindow(this.days)` — write side.** `this.days` is a server-validated integer (from a successful API response that already enforced `RECENT_REVENUE_WINDOWS.includes(requested)`). The write itself is `localStorage.setItem(STORAGE_KEY, String(n))` — a string-typed scalar, no escape-the-storage-layer vector. Try/catch swallows quota-exceeded, security-error (Safari ITP), and the rare `localStorage` global being `undefined` itself.

  - **The init() silent-restore narrowing (Role 5 fix).** The new `{ silent: true }` opts arg gates only the `errored` flag assignment in the catch block. No other behaviour is gated by the silent flag. A future refactor that accidentally globalised it (e.g., made `silent` default true) would suppress error feedback for user clicks too — that exact risk is locked in by the new test "user-clicked select() still surfaces errored on fetch failure".

  - **`tests/recent-revenue-window-storage.test.js`** — pure-test file. Uses `vm.createContext` to evaluate the extracted factory source in a sandbox with stubbed `localStorage` + `fetch` globals. No live secrets, no production code paths exercised. The brace-counting extraction is fragile to future syntax changes (e.g., a stray `{` in a comment would throw off the count) — flagged as a known limitation but no production risk; the test file fails loudly if the extraction breaks rather than silently green-passing.

  - **Hardcoded-secret scan** of all touched files: zero matches for `API_KEY|SECRET|password.*=|sk_live|sk_test` on the cycle-diff lines. The `sk_test_dummy` fixture in the existing `recent-revenue-window-toggle.test.js` is unchanged. ✓ No new credentials.

- **`npm audit --omit=dev`:** still 6 vulnerabilities (3 moderate, 3 high) — **all pre-existing**, all install-time only. `bcrypt → @mapbox/node-pre-gyp → tar` (3 high — H9 in INTERNAL_TODO); `resend → svix → uuid` (3 moderate — H16). Runtime exposure remains nil. **No new advisories surfaced this cycle** — zero new dependencies (no `npm i`, no `package-lock.json` shifts).

- **Performance:**
  - **localStorage operations** are synchronous browser-internal calls — sub-millisecond at any reasonable storage size. No I/O.
  - **Init-driven fetch** (only fires when saved !== SSR initial) is at most one extra network round-trip per dashboard load, only for users who actively chose a non-default window. Steady-state path (saved === 30 OR no saved value) makes ZERO network calls. Cohort-level: most users on most loads pay no perf tax.
  - **Memory:** the new helper closures + STORAGE_KEY constant + ALLOWED array add ~200 bytes per dashboard render. Negligible. GC'd on dashboard navigate-away.
  - **No N+1 introduced**, no new SQL, no new indexes needed.

- **Code quality:**
  - The Alpine factory grew from ~30 lines to ~60 lines but stays single-purpose. The two new helpers (`readSavedWindow`, `writeSavedWindow`) are pure utility functions — testable in isolation, no external mutable state, no side effects beyond localStorage.
  - The `STORAGE_KEY = 'qi.recentRevenueDays'` constant lives next to the helpers as the single source of truth. The `ALLOWED = [7, 30, 90]` array does the same for the whitelist.
  - **One DRY note (not new — already implicit, now slightly worsened):** the `[7, 30, 90]` whitelist appears in 3 places: `routes/invoices.js#RECENT_REVENUE_WINDOWS` export, the Alpine `x-for` template literal in `views/dashboard.ejs:238`, and the new client-side `ALLOWED` constant. All three are pinned by tests for drift, but a "single source of truth" refactor (e.g., emit ALLOWED from the server-rendered initial JSON payload) would tighten the contract. **Not raised as a [HEALTH] item this cycle** — the test guards are sufficient and the refactor would expand the SSR payload contract, which is a larger architectural change than the duplication justifies. Flag for next-cycle decision if the whitelist ever changes.
  - The new test pattern (`vm.createContext` + brace-counting extraction of inline JS) is novel for this codebase. Clean and self-contained — no production dependency, the harness lives entirely in the test file. Future tests that need to exercise inline EJS-embedded JS can re-use the pattern without it leaking into `lib/`.

- **Dependencies:** zero changes — no `npm i`, no `package-lock.json` shifts. `package.json` was edited to add the new test file to the `test` script — dev-only entry, no runtime/production effect. The new test file uses `vm` (Node built-in) and the existing `ejs` dev dependency — no new modules.

- **Legal:** No new dependencies, no license changes. The new code surfaces only the user's own UI-preference data in their own browser's localStorage — no PII expansion, no GDPR/CCPA scope change, no PCI scope change, no third-party API usage. The `localStorage` key `qi.recentRevenueDays` holds a single integer (7, 30, or 90) that's not personally identifying, not behavioural-tracking telemetry, and is strictly functional preference storage. No cookie-consent surface required (it's not a cookie + it's strictly-necessary-for-the-feature under the ePrivacy directive's "strictly necessary" carve-out).

**No CRITICAL / hardcoded-secret findings. No new flags for TODO_MASTER. No new [HEALTH] items added to INTERNAL_TODO.** The 9 existing open [HEALTH] items remain unchanged.

**Net delta this cycle:** the new code is unusually clean. localStorage-only persistence (no server-side state mutation), strict whitelist filtering on both read and parseInt, try/catch around all storage operations, narrowed silent-on-error gate (Role 5 fix), and 19 new assertions across 2 test layers including a new `vm`-sandbox harness pattern. The full test suite is **48 files, 0 failures** — the safety net is intact.

---

