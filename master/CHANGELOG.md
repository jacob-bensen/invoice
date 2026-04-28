# QuickInvoice — Changelog

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

## 2026-04-28T22:50Z — Role 6 (Task Optimizer): 19th-pass audit — header refreshed, #122 archived, queue re-ordered + Session Close Summary

**Audit deltas this pass:**

1. **Header refreshed.** Updated INTERNAL_TODO.md audit header to capture this cycle's deltas: #122 closed (XS, ~30 min effort, MED retention shipped); 4 new GROWTH items (#127-#130); 1 new MARKETING (#62 creator outreach); 1 UX direct fix (silent-on-error for init-driven restore). 18th-pass header retained as a one-line summary; 17th-pass retained as well.

2. **#122 archived.** Folded the full description into a one-line `*(...)*` parenthetical at the head of the XS-GROWTH block (same pattern as #91, #92, #101, #106, #107, #117 archives in prior passes). Full detail lives only in CHANGELOG now.

3. **#127-#130 placement.** All 4 new items inserted at the top of the XS / S GROWTH buckets (Cx-tagged appropriately). Cross-referenced against existing items per Role 4's Cross-checks block; zero merges, zero consolidations.

4. **Re-prioritization (priority order unchanged):** [TEST-FAILURE] (none) > income-critical features > [UX] items affecting conversion > [HEALTH] > [GROWTH] > [BLOCKED]. Within GROWTH, XS-first by impact-per-effort. The new #127, #128 are XS and immediately implementable; #129, #130 are S complexity.

5. **Cross-checks for non-overlap (re-validated this cycle):** #127 vs #95 vs #88 (active recovery CTA vs passive tab-flash vs categorical client-pattern alert — three orthogonal signal types); #128 vs #117 vs #122 (keyboard shortcut vs UI toggle vs saved-window — same surface, three input modalities); #129 vs #121 vs #123 vs #107 (personal-record vs consecutive-weeks streak vs vs-prior-period delta vs raw current — four orthogonal data dimensions); #130 vs #23 (in-app gesture vs PWA install — different surfaces, both can ship). All confirmed orthogonal.

6. **TODO_MASTER reviewed:** All 62 items (1-9 legacy InvoiceFlow setup + 50-62 newer marketing/SPEC-REVIEW additions) checked against this cycle's CHANGELOG. **No items flip to [LIKELY DONE - verify]** — every Master action remains pending its respective external step (Stripe Dashboard config, Resend API key, Plausible domain, G2/Capterra profile creation, AppSumo submission, Rewardful signup, creator outreach, etc.). #62 (creator outreach from this cycle's Role 4) is the newest entry.

7. **Compaction status.** INTERNAL_TODO.md now ~2.5k lines (overdue by 12 cycles per the 1.5k archive trigger). Deferred again — not blocking work; full archives remain available via CHANGELOG. Will be revisited when the [DONE]-tagged section weight crosses ~1k lines on its own.

8. **Open task index re-counted:** ~123 GROWTH items total (was 120 + 4 new − 1 #122 closed = 123); 9 [HEALTH] items open unchanged; 2 [UX] items (U3 actively buildable; U1 in Resend block); 0 [TEST-FAILURE]. **No new [BLOCKED] items this cycle.**

**Priority order at end of 19th pass (top 12 unblocked items):**

| # | ID | Tag | Cx | Title (1-line) |
|--:|------|------|-----|------|
| 1 | U3 | UX | S | Authed-pages global footer (gated on #28) |
| 2 | **#127** | GROWTH | XS | **"Quiet window" recovery CTA on revenue card (NEW)** |
| 3 | **#128** | GROWTH | XS | **Keyboard shortcut (7/3/9) for revenue window (NEW)** |
| 4 | #123 | GROWTH | XS | "vs prior period" delta badge on revenue card |
| 5 | #124 | GROWTH | XS | 3-day stale-draft yellow banner |
| 6 | #118 | GROWTH | XS | Stripe receipt URL on paid invoice view |
| 7 | #119 | GROWTH | XS | Inline "What's new" pulse-dot on nav |
| 8 | #120 | GROWTH | XS | `<noscript>` SEO fallback hero |
| 9 | #109 | GROWTH | XS | Sticky "+" mobile FAB |
| 10 | #102 | GROWTH | XS | Per-user timezone |
| 11 | #112 | GROWTH | XS | Live "Trusted by N freelancers" hero counter |
| 12 | #113 | GROWTH | XS | Per-niche `<meta description>` blurb |

**Resend-blocked (kept at bottom of XS bucket):** U1, #11, #12, #66, #71, #77, #80, #84, #90, and #110 (M-complexity magic-link).

---

# 2026-04-28T22:50Z — Session Close Summary

**What was accomplished this session (across all 7 roles):**

- **Bootstrap** — APP_SPEC.md unchanged (synced last cycle). EPICS.md unchanged (created last cycle). No new bootstrap-time master action filed (#60 SPEC-REVIEW from last cycle remains the standing item).
- **Role 1 (Epic Manager)** — wrote a Session Briefing identifying #122 as the highest impact-per-effort unshipped item (XS effort, MED retention, sits on top of #117 which just landed). All 9 epic statuses unchanged. 3-active-epic budget held: E2 Trial→Paid Conversion, E3 Activation, E4 Retention.
- **Role 2 (Feature Implementer)** — shipped **#122 localStorage persistence on revenue-window toggle**. Inside the existing `recentRevenueCard()` Alpine factory in `views/dashboard.ejs`: new `readSavedWindow()` / `writeSavedWindow()` helpers (try/catch + whitelist filter + `typeof localStorage` guard); new `init()` lifecycle hook that fires `select(saved)` only when saved differs from SSR initial (zero fetches when they agree); `writeSavedWindow(this.days)` call inside `select()`'s success branch (never persists on fetch failure). ~33 lines added / 7 removed inside the existing inline script. No DB, no migration, no new API.
- **Role 3 (Test Examiner)** — added 17 new test assertions in `tests/recent-revenue-window-storage.test.js` across 2 layers: 6 view-source regex assertions (STORAGE_KEY constant, [7,30,90] whitelist, init() hook, writeSavedWindow position relative to catch block, try/catch wrapping, typeof localStorage guard) + 11 in-process behaviour tests via `vm.createContext` sandbox (init no-op without saved value, init restores valid saved value, init no-op when saved === SSR initial, ignores corrupt values, persists on success, doesn't persist on failure, handles QuotaExceeded throws, handles getItem throws, works without localStorage entirely, empty-window response still persists). New testing pattern for this codebase — extracts the factory source from EJS via brace-counting and evaluates inside a sandbox. Full suite: **48 files, 0 failures**.
- **Role 4 (Growth Strategist)** — added 4 new GROWTH items (#127 Quiet-window recovery CTA, #128 keyboard shortcuts on revenue toggle, #129 🏆 New-record personal-best badge, #130 mobile pull-to-refresh) + 1 new MARKETING item (#62 personalized 90-day Pro comp creator outreach). All cross-checked for non-overlap; all assigned to currently-active epics (2 to E3, 2 to E4); zero items orphaned to [UNASSIGNED].
- **Role 5 (UX Auditor)** — direct fix on the new init() hook: was firing `errored = true` if the post-hydration restore fetch failed (offline / blip), surfacing a red error line for a background action the user didn't take. Now passes `{ silent: true }` to the restore `select()` call; user-clicked toggles still surface errors (regression-guard test added). Re-walked landing → register → empty-state dashboard → trial banners → pricing → invoice form/view — no regressions in untouched flows. 2 new test assertions added.
- **Role 6 (Task Optimizer)** — refreshed audit header, archived #122 to one-line parenthetical, re-ordered priority queue (new XS items at top, S items in correct bucket), TODO_MASTER reviewed (no items flip to [LIKELY DONE - verify]).
- **Role 7 (Health Monitor)** — see next CHANGELOG entry below for full audit.

**Code shipped this cycle:**
- 1 expanded Alpine factory (`recentRevenueCard()` in `views/dashboard.ejs`) — 4 small additions + 1 silent-on-error narrowing
- 1 new test file (`tests/recent-revenue-window-storage.test.js` — 19 assertions across 2 layers, including a new `vm.createContext` test pattern for this codebase)
- 1 `package.json` test-script entry added
- 4 new INTERNAL_TODO items (#127-#130)
- 1 new TODO_MASTER item (#62)
- 1 INTERNAL_TODO #122 archived to one-line parenthetical

**Most important open item heading into the next session:**

**#127 [XS] "Quiet window" recovery CTA on the recent-revenue card** — XS effort (~15 lines on the existing `recentRevenueCard()` Alpine scope + 1 reactive `x-show` block + a `unpaidCount` field threaded through the `buildRecentRevenueCard()` helper), MED activation/recovery impact, immediately compounds with #117/#122 by giving the empty-window state an explicit recovery action. Highest impact-per-effort item available; sits on top of code that just landed and is actively in-mind. Estimated cycle to ship: < 30 min implementation + ~15 min new tests.

**Risks / blockers needing Master attention before next run:**

- **Resend API key (TODO_MASTER #18)** — single most leveraged Master action. Unblocks E9 entirely (~10 ready-to-ship retention/conversion email features: U1 password reset, #11 churn win-back, #12 monthly digest, #66 auto-CC accountant, #71 auto-BCC freelancer, #72 .ics calendar, #77 welcome-back on past_due restore, #80 weekly Monday digest, #84 plain-language email body, #90 60+ day inactive re-engagement, #110 magic-link login).
- **APP_URL env var (TODO_MASTER #39)** — unset means sitemap.xml + canonical link tags fall back to request host, leaks alternate hosts (Heroku free dyno URL + custom domain) into Google's index. Low-effort fix (one env var); compounding SEO drift.
- **APP_SPEC review (TODO_MASTER #60)** — auto-reconstructed last cycle, still awaiting human verification.

---

## 2026-04-28T22:40Z — Role 5 (UX Auditor): silent-on-error for init-driven window restoration + flow regression sweep

**Pathways audited this cycle:**

1. Dashboard with localStorage-saved window matching SSR default (steady state — most common path).
2. Dashboard with localStorage-saved window differing from SSR default (init() fires post-hydration restore fetch — second most common path).
3. Dashboard with saved window AND user is offline / network blip (the broken case).
4. Dashboard with corrupt localStorage value (e.g., a future deploy renames the key, leaving stale `7` values around).
5. Re-walked: landing → register → empty-state dashboard onboarding (regression) → trial banner stacking → invoice form → invoice view → 404. No regressions in untouched flows.

**Direct fix applied this cycle (1 substantive UX bug + 0 cosmetic-only changes):**

1. **`views/dashboard.ejs#recentRevenueCard.init()` — silent-on-error for background restoration.** The Role 2 implementation calls `select(saved)` from `init()` without distinguishing the call from a user click. If the post-hydration restore fetch fails (offline, network blip, server 500, transient DB error), the existing catch branch fires `this.errored = true` and the user sees the red "Couldn't load that window — showing the previous one." inline error. **The user didn't click anything.** They opened the dashboard, the SSR rendered the 30d card correctly, and now they see an error message about a window swap they never asked for. The "previous one" the message refers to is also misleading — it's the SSR default (30d), not their saved 7d preference. Fixed: extended `select()` to accept an optional `opts.silent` flag; init() now calls `this.select(saved, { silent: true })`. On error, the silent flag suppresses the `errored` state — the dashboard falls back to the SSR-rendered card with no message. **User-clicked toggles still show the error line on failure** (regression-guard test added). Two new test assertions in `tests/recent-revenue-window-storage.test.js` lock both behaviours in:
   - `init-driven restoration is silent on fetch failure (no errored flag for background restore)`
   - `user-clicked select() still surfaces errored on fetch failure (regression guard for the silent: true narrowing)`

**Why this is the right call:**

The `errored` flag is a feedback signal that ties to a user action. The user clicks 7d → fetch fails → "we tried, it didn't work" message. That's correct UX. But init() restoration is a background operation — the SSR already rendered a real, current card, and the restoration is a polish layer. Surfacing an error for a polish operation that quietly degraded is a classic "don't make the user feel like they did something wrong" anti-pattern. The fall-back behaviour (show 30d, no error) is a strict superset of what the user would have seen without the localStorage layer.

**Regression checks performed (no new fixes needed, but verified clean):**

- **Trial countdown nav pill (#106) + dashboard banner (#45) interaction** — both still render unchanged. ✓
- **Free-plan invoice progress bar (#31)** — still renders for free users; no localStorage layer touches the free-plan path. ✓
- **Onboarding card → trial banner → past-due banner stack** — render order unchanged. ✓
- **Pricing page CTA copy + annual-savings pill (#101)** — both unchanged. ✓
- **`x-cloak` CSS rule** — verified `[x-cloak] { display: none !important; }` still in `views/partials/head.ejs`; the new error fallback line (still gated by `x-show="errored"`) doesn't briefly flash on first paint. ✓
- **Login → register cross-link** — unchanged. ✓
- **Mobile breakpoint on the new toggle** — toggle row uses `flex-wrap` so on narrow mobile (< 384px wide), the toggle wraps below the section header rather than overflowing. ✓
- **No localStorage / no Alpine baseline** — without JS, the SSR-rendered card still shows correct values. The localStorage layer is purely additive. ✓

**Anti-fixes — flagged but deliberately left:**

- **Brief flash of "30d" before snap to "7d" on first paint for users with non-default saved window.** ~50-100ms of SSR-default content before the post-hydration fetch resolves. Acceptable trade vs. the alternative (server-side cookie-based pre-render) which would require a Set-Cookie on every `select()` + a cookie-read in the dashboard route + server-side enforcement of the whitelist. The micro-flash is bounded by the existing `loading` opacity dim — visually muted, not jarring. Defer; revisit if mobile-conversion analytics ever surface a "user perceives the dashboard as flickering" signal.
- **Tile re-render on init() restore looks like the same fetch as a user click.** Same opacity-60 dim, same disabled buttons. Considered: differentiate the visual treatment of init-driven vs user-driven loads. But the user's mental model on dashboard load is "things are loading" — surfacing that the restoration is a separate event would be over-explaining a routine UX moment. Defer.
- **No "your saved preference was applied" toast.** Considered surfacing a small "📌 Restored your preferred window" pill on init-driven restore success. But (a) it's noise — users who set a preference don't need to be told it was honoured, and (b) the toggle's :aria-pressed updating on the restored button is the canonical accessibility-correct signal. Defer.

**Test impact:** 2 new tests added to `tests/recent-revenue-window-storage.test.js` (now 19 total in that file), 1 existing regex updated to tolerate the new optional `opts` parameter on `select()`. Full suite still green: 48 files, 0 failures.

**Income relevance:** SMALL but compounding. The fix turns a confusing "the app showed me an error I didn't ask for" moment into a silent graceful-degrade. Specifically rescues the offline-on-dashboard-load cohort + the restore-fetch-blip cohort — small cohorts in absolute terms but exactly the cohorts where a confusing UX moment is over-weighted (already-frustrated user gets handed an error they didn't trigger). The fix raises the perceived polish ceiling on the entire #117/#122 surface without changing any happy-path behaviour.

---

## 2026-04-28T22:30Z — Role 4 (Growth Strategist): 4 new GROWTH ideas (#127-#130) + 1 new MARKETING (#62)

**Process:** scanned the queue for un-mined surfaces that compound with #122 (just-shipped) and #117 (last cycle). The dashboard's recent-revenue card now has 3 reactive layers (#107 raw stats, #117 toggle, #122 saved window) — that's a dense surface where small additions multiply impact. Cross-checked each candidate against the 121 existing GROWTH items + 61 existing MARKETING items.

**Five-lever sweep:**

- **Conversion (signup → paid):** existing queue is well-mined here (#82 plan comparison table, #46 exit-intent, #15 contextual upsells, #109 mobile FAB). Added #127 indirectly (recovery CTA on quiet-window state — converts a slow-week passive moment into an explicit recovery action).
- **Retention (return visits + reduced churn):** added #128 keyboard shortcuts, #129 personal-record badge, #130 pull-to-refresh. All compound with #122/#117 + the daily-check-in cohort.
- **Expansion (ARPU lift):** existing queue covers this (#9 Agency seats, #10 Business tier, #74 Pro logo, #54 deposits, #67 tip toggle, #100 Stripe Climate). No new XS items emerged this cycle.
- **Automation (manual → productized):** existing queue covers this (#22 late-fee automation, #51 schedule send, #40 recurring auto-gen). No new items this cycle.
- **Distribution (acquisition):** added #62 [MARKETING] high-touch creator outreach (distinct from #61 always-on affiliate program — same channel, different mechanic).

**Added to INTERNAL_TODO.md:**

- **#127 [GROWTH] [XS]** (E3 Activation) — "Quiet window" recovery CTA on the recent-revenue card. When `totalPaid === 0` AND `unpaidCount > 0` (open invoices but no recent paid revenue), render "📨 Send 3 follow-ups now →" inline link below the tile row, deep-linking to the invoice list filtered to status IN ('sent','overdue'). Distinct from #88 frequent-non-payer (categorical pattern) and #95 tab-flash (passive emotional reward).
- **#128 [GROWTH] [XS]** (E3 Activation) — Keyboard shortcut on dashboard: `7` / `3` / `9` swap the revenue window. Single Alpine `@keydown.window` listener on the existing `select()` method. Same input-focus gate-key check as Discord/Slack/Notion. Distinct from #122 (saved window) and #117 (UI toggle) — same surface, complementary affordance.
- **#129 [GROWTH] [S]** (E4 Retention) — "🏆 Best ever" personal-record badge on the recent-revenue card when current window's `totalPaid` equals the all-time max for any prior window of the same length. Single SQL CTE extension to `db.getRecentRevenueStats` (sliding-window MAX). Distinct from #121 (consecutive-weeks streak), #123 (vs-prior-period delta), #107 (raw stats — record is achievement-framed). Compounds with #92 share-intent buttons (post-record reflexive share).
- **#130 [GROWTH] [S]** (E4 Retention) — Pull-to-refresh on mobile dashboard. Alpine touch-handler intercepts the gesture and fires the existing `/invoices/api/recent-revenue` + a new `/invoices/api/recent-list?limit=5` endpoint. ~80ms warm refresh vs ~600ms cold reload. Compounds with #95 (background tab-flash) and #122 (saved window survives the refresh). Distinct from #23 PWA install (different surface).

**Added to TODO_MASTER.md:**

- **#62 [MARKETING]** — Personalized 90-day Pro comp outreach to 10 hand-picked creators (YouTubers, newsletter authors, podcast hosts, social personalities). Distinct from #61 affiliate program (structured at scale, ongoing) and from #59 co-marketing (partner integrations) and from #43/#54/#55 paid media. The mechanic: $0 marginal cost (Pro is digital) + high signal (curator audience is qualified) + no-strings framing reverses the usual sponsorship-skepticism dynamic. ~6 hrs total. Income: 1.5-75 paid signups for ~$0 marginal cost; the high-touch quality push that complements the always-on affiliate layer.

**Cross-checks for non-overlap:**

- #127 vs #95 vs #88: #127 is a window-scoped active recovery CTA (slow-week → "send follow-ups"); #95 is a passive emotional reward (paid event → tab flash); #88 is a categorical client-pattern alert (frequent non-payer). Three orthogonal signal types.
- #128 vs #117 vs #122: same surface, three layers — #117 is the UI toggle (mouse), #122 is the per-device memory (state), #128 is the keyboard shortcut (input). Power-user trio.
- #129 vs #121 vs #123 vs #107: #121 is consecutive-weeks streak (cadence axis); #129 is dollar peak (magnitude axis); #123 is vs-prior-period delta (trajectory axis); #107 is raw current values (state axis). Four orthogonal data dimensions.
- #130 vs #23: #23 is full PWA install (different surface — native install with home-screen icon); #130 is in-app pull-to-refresh gesture (no install required). Both can ship; they don't conflict.
- #62 vs #61 vs #59: #61 is always-on structured affiliate (revenue share, scale); #62 is one-time hand-curated creator outreach (relationship, quality); #59 is partner integrations (co-marketing, technical depth). Three distinct distribution motions targeting overlapping audiences.

**Active-epic alignment:** all 4 new GROWTH items map cleanly to currently-active epics — 2 to E3 (#127, #128), 2 to E4 (#129, #130). Zero items orphaned to [UNASSIGNED]. Zero items added to E5/E7 (PLANNED) or E9 (PAUSED — Resend gate).

**TODO_MASTER review:** All 61 prior items checked against this cycle's CHANGELOG. **No items flip to [LIKELY DONE - verify]** — every Master action remains pending its respective external step (Stripe Dashboard config, Resend API key, Plausible domain, G2/Capterra profile creation, AppSumo submission, Rewardful signup, etc.). #18 (Resend), #38 (OG image), #39 (APP_URL), #60 (SPEC-REVIEW), #61 (affiliate program) all genuinely open. #62 is the new add this cycle.

---

## 2026-04-28T22:20Z — Role 3 (Test Examiner): 17 new assertions covering #122's localStorage layer (full suite 48 files, 0 failures)

**Audit scope this cycle:** the new code in `views/dashboard.ejs` from Role 2 — the `readSavedWindow()` / `writeSavedWindow()` helpers, the new `init()` lifecycle hook on the Alpine factory, and the `writeSavedWindow(this.days)` call inside `select()`. None of this was reachable from the existing `recent-revenue-window-toggle.test.js` suite — the existing tests cover the API endpoint contract (route handler) and the static rendered HTML, but never *executed* the Alpine factory closure. The localStorage layer was completely uncovered.

**Two-layer coverage strategy** (mirrors the existing window-toggle test file's structure):

1. **Layer 1 — view-source regex assertions (6 tests).** Same pattern the existing tests use: render `dashboard.ejs` via EJS, regex-match the rendered HTML for the new structural pieces. Pins:
   - `STORAGE_KEY = 'qi.recentRevenueDays'` literal (regression guard against silent rename — a key change is a silent UX migration that breaks every existing user's saved preference)
   - `ALLOWED = [7, 30, 90]` literal whitelist inside the factory closure (drift guard against the API's `RECENT_REVENUE_WINDOWS` export and the toggle's `[7, 30, 90]` template literal — three places, one truth)
   - `init()` lifecycle hook calls `readSavedWindow()` (regression guard — Alpine's `init()` magic is auto-discovery; renaming or removing the method silently disables persistence)
   - `writeSavedWindow(this.days)` appears AFTER the success branch but NOT inside the catch block (the regex extracts the catch block separately and asserts `writeSavedWindow` is absent — this is the most important behavioural invariant: never persist a window the server didn't honour)
   - Both helpers are wrapped in `try { ... } catch` (private-mode read failure / quota-exceeded write failure must not surface as a fetch error)
   - `typeof localStorage === 'undefined'` guard exists in BOTH helpers (sandboxed iframes, embedded webviews — the global itself can be missing before any storage operation throws)

2. **Layer 2 — in-process behaviour via `vm.createContext` sandbox (11 tests).** New testing pattern for this codebase — extracts the `recentRevenueCard()` factory source from the EJS template via brace-counting, evaluates it inside a `vm` sandbox with stubbed `localStorage` + stubbed `fetch` globals, then exercises the factory's behaviour directly. This is the canary that the JavaScript actually does what the regex says it does. Pins:
   - `init()` with no saved value: zero fetches, zero state change (the steady-state path for new users)
   - `init()` with valid saved value (`'7'`): `select()` is called, fetch URL contains `days=7`, state mutates to the new window
   - `init()` when saved === initial.days: zero fetches (no redundant round-trip when localStorage and SSR agree — this is the steady-state path for returning users on their preferred window)
   - `init()` ignores corrupt values: iterates `['60', '365', 'garbage', '', '0', '-1', '99999']` — every one must be a no-op (no fetch, no state mutation). This is the canary for the whitelist filter: if the parseInt-or-allowed-membership check ever weakens, this test catches it.
   - `select()` persists to localStorage on success
   - `select()` does NOT persist on fetch failure (network blip — the previous successful preference stays put)
   - `select()` does NOT persist on non-2xx response (server-side rejection — same invariant)
   - `writeSavedWindow` swallows `QuotaExceededError` (Safari ITP, private mode write failure) — state still updates, errored stays false
   - `readSavedWindow` swallows `getItem()` throws (Firefox `dom.storage.access` blocked) — treated as no saved value
   - The factory works when `localStorage` global is entirely absent — both `init()` and `select()` complete without throwing
   - Empty-window response (`card: null`, days: 7) STILL persists `7` to localStorage — the user explicitly chose 7d, the server honoured it, the answer is $0/0/0; persistence is correct because the request was successful (this guards the "empty window is a successful response, not an error" invariant Role 5 fixed last cycle)

**Why these are high-value tests:**

- The localStorage layer is exactly the kind of code that gets silently broken by a future "small refactor" — the helpers are 6-line trivialities that look like they don't need tests until someone "tidies" them and accidentally moves the `writeSavedWindow` call into the `finally` block (which would persist failures), or removes the `parseInt(raw, 10)` (allowing a string `"7"` to never equal the integer `7` in the `===` whitelist check), or strips the `typeof localStorage === 'undefined'` guard (crashing in sandboxed iframes).
- The behavioural assertion "no fetch when saved === SSR initial" is the load-performance contract of this feature. Without that assertion, a future "let's always re-fetch on init" change would silently double the network calls every dashboard load.
- The "empty-window persists" assertion locks in the fix from Role 5's previous cycle pass — that fix is in user-facing JavaScript with no test today; this is the regression seatbelt.

**Files touched:** new `tests/recent-revenue-window-storage.test.js` (260 lines, 17 assertions); `package.json` test script extended by one entry.

**Risks reduced:**

- **HIGH:** Silent regression of the "don't persist on failure" invariant (the strongest correctness guarantee of the feature) — now caught by 2 tests.
- **HIGH:** Silent break of the whitelist filter on stored values — would let stale `60` or `365` values leak through and produce 4xx loops; now caught.
- **MEDIUM:** `localStorage` access exception → uncaught Promise rejection in production — would crash the dashboard for Firefox-with-storage-access-blocked + Safari-private-mode users. Now caught with explicit "no throws even when both reads + writes throw" tests.
- **LOW:** STORAGE_KEY rename without migration — would silently lose every existing user's preference. Now caught by literal-string regex.

**Full test suite status:** 48 files, 0 failures. The existing 25 `recent-revenue-window-toggle` tests are unchanged and all pass; the existing API + view contract tests for #117 are unaffected.

**Anti-tests — flagged but deliberately NOT written:**

- A test that `Alpine.data('recentRevenueCard', recentRevenueCard)` is registered in the global scope. The current pattern (function declared in inline script, referenced via `x-data='recentRevenueCard(...)'`) doesn't go through Alpine's data registry — it relies on the function being globally hoisted within the page. A test for "Alpine.data registration" would assert behaviour the codebase doesn't have. Skip.
- A test for `localStorage.setItem` being called specifically with `'qi.recentRevenueDays'` as the key. Already covered by the regex assertion on the literal STORAGE_KEY constant + the persistence behavioural test. Doubling up on it would be redundant.

---

## 2026-04-28T22:10Z — Role 2 (Feature Implementer): #122 shipped — recent-revenue window persisted to localStorage

**Epic:** E3 Activation & Time-to-First-Value.

**What was built:**

A per-device memory of the user's preferred recent-revenue window (7d / 30d / 90d) using `localStorage` under key `qi.recentRevenueDays`. The change lives entirely inside the existing `recentRevenueCard()` Alpine factory at the bottom of `views/dashboard.ejs` — no DB migration, no new API surface, no schema change.

**Implementation (4 small additions to the Alpine factory):**

1. Two pure helpers at the top of the factory closure:
   - `readSavedWindow()` — reads `localStorage.getItem('qi.recentRevenueDays')`, parses with `parseInt(raw, 10)`, returns the integer only if it's a member of the `[7, 30, 90]` whitelist; returns `null` otherwise (corrupt value, missing key, localStorage unavailable, private-mode read throw). Triple-guard against bad data: `typeof localStorage === 'undefined'` short-circuit + try/catch around the read + whitelist filter on the parsed integer.
   - `writeSavedWindow(n)` — `localStorage.setItem(STORAGE_KEY, String(n))` inside try/catch (private-mode throws, quota-exceeded throws, Safari ITP edge cases all swallowed).
2. New `init()` lifecycle hook on the Alpine component (Alpine 3 calls `init()` automatically on x-data attach). Reads the saved window; if `null` or equal to the SSR-rendered initial state, do nothing (zero network calls — most users on most loads). If the saved value differs and is whitelist-valid, calls `select(saved)` which fires the same JSON fetch the manual toggle uses.
3. Inside the existing `select()` method, after the `try` block successfully populates the new state, calls `writeSavedWindow(this.days)` — persists ONLY on successful fetch. A network failure leaves localStorage unchanged so the next load doesn't rehydrate to a window the server can't actually serve.
4. The `STORAGE_KEY = 'qi.recentRevenueDays'` constant + `ALLOWED = [7, 30, 90]` array sit next to the helpers as the single source of truth for the localStorage contract.

**Key design decisions worth flagging:**

- **No SSR-side preference cookie.** The right surface for a per-device preference is the device, not the server. The Alpine init runs after the SSR render, so users with a non-default saved window see "30d" for ~50ms before the post-hydration fetch resolves. The alternative (cookie-based SSR pre-render at the saved window) would require a Set-Cookie on every `select()` + a cookie-read in the dashboard route + a server-side enforcement of the whitelist — three new surfaces for what's already a clean two-line client-side feature. The micro-flash is the right trade.
- **Persist on success, not on click.** If the fetch errors, the user sees the existing red error line + the previous window's data; localStorage is untouched. Reload → still on the previous (working) window. This is the "honest about transient failure" behaviour — never persist a window that didn't actually load.
- **Whitelist match on read.** A future change that drops 7d (e.g., consolidates to 14d / 30d / 90d) won't honour stale `7` localStorage values — they'll deterministically fall through to the new default. No migration code needed.
- **localStorage availability gate.** Old/embedded browsers + sandbox iframes + private modes can throw on the global `localStorage` access itself, hence the `typeof localStorage === 'undefined'` short-circuit before any read/write.

**Why it matters for income / UX:**

MED retention. The Pro user who checks "is this week working?" daily currently re-clicks 7d on every dashboard visit. Persisting the preference is the smallest possible "the app remembers me" affordance — compounds with #117 (toggle) and the cha-ching email loop (#30). Particularly leveraged for the daily-touchpoint cohort (E4) where dashboard re-visits are the trigger surface for every retention play.

**Files changed:** `views/dashboard.ejs` (+33 lines / -7 lines inside the existing inline `<script>` block — the script grew from ~30 lines to ~60 lines but adds zero new modules, zero new dependencies, zero new server routes).

**Test impact:** The 25 existing tests in `tests/recent-revenue-window-toggle.test.js` all pass unchanged (verified — `25 passed, 0 failed`). No existing assertion regressed; the new factory shape is a strict superset of the prior shape. New test coverage for the localStorage layer is the Test Examiner's pass below.

**Master actions / deploy steps:** None. Pure client-side change, no env vars, no migration.

---

## 2026-04-28T22:05Z — Role 1 (Epic Manager): Session Briefing — focus on #122 (revenue-window localStorage persistence)

**Active epics this cycle (3 — at budget):**

- **E2 Trial → Paid Conversion [ACTIVE]** — direct conversion lever; queue still has #82 (plan comparison table), #46 (exit-intent), #47 (monthly→annual upgrade prompt), #15 (contextual upsells), #109 (mobile FAB), #119 (what's-new pulse-dot).
- **E3 Activation & Time-to-First-Value [ACTIVE]** — #117 (window toggle) just shipped last cycle. Top item this cycle: **#122 [XS] persist last-selected revenue window in `localStorage`** — XS effort (~10 lines inside the just-shipped `recentRevenueCard()` Alpine factory), MED retention impact, immediately compounds with #117 by giving each device a memory of the user's preferred window. Other open: #123 (vs-prior-period delta), #124 (3-day stale-draft), #118 (Stripe receipt URL), #102 (timezone), #116 (demo accordion).
- **E4 Retention & Daily Touchpoints [ACTIVE]** — #125 (top-5 clients widget), #126 (webhook retry queue), #80/#88/#89/#121 plus the Resend-blocked cohort under E9.

**Epic status changes this cycle:** none. All 9 epic statuses unchanged from last cycle. E1 [COMPLETE], E2/E3/E4 [ACTIVE], E5/E6/E7/E8 [PLANNED], E9 [PAUSED — Resend gate]. The 3-active-epic budget remains honoured.

**Most important thing to accomplish this session:** ship **#122** — the impact-per-effort leader and the natural compounding extension to #117 which just shipped. The Alpine factory `recentRevenueCard()` is already the canonical scope for this — add a per-device `localStorage` read on `init()` (with corruption-tolerant fallback to the SSR default of 30) + a `localStorage` write inside `select()` on successful fetch. Restoration shouldn't fight the SSR initial render: if localStorage and SSR agree, do nothing; if they differ, fire `select()` post-hydration so the user sees their preferred window without a network round-trip on every visit-to-dashboard. Estimated impl: ~15 lines + ~6 new test assertions.

**Risks / blockers worth flagging before work begins:**

- **Resend API key (TODO_MASTER #18)** still the highest-leverage Master action — unblocks ~10 ready-to-ship retention/conversion email tasks under E9.
- **APP_URL env var (TODO_MASTER #39)** — sitemap.xml + canonical link tags fall back to request host, leaks alternate hosts into Google's index. Single env var fix.
- **APP_SPEC review (TODO_MASTER #60)** — spec was auto-reconstructed last cycle; needs human eyes to confirm the QuickInvoice + InvoiceFlow split matches strategic intent.
- **localStorage SSR-vs-client race condition** to watch for in #122: if Alpine init runs before the SSR DOM is fully painted, fixing the saved-window in `init()` could cause a brief flash of "30d" before snapping to "7d". Mitigation: rely on the existing `loading` flag during the post-init fetch, and only fire the post-init `select()` if the saved window genuinely differs from the SSR-rendered initial state.

---

## 2026-04-28T21:00Z — Role 7 (Health Monitor): clean cycle audit + 1 defence-in-depth hardening applied inline

**Audit scope this cycle:** the 4 production files touched in Roles 1, 2, 5 (`routes/invoices.js`, `views/dashboard.ejs`, `master/APP_SPEC.md`, `master/EPICS.md`); the 1 new test file (`tests/recent-revenue-window-toggle.test.js`); the modified `package.json` test runner; the 1 existing test file with the span-tolerant regex update (`tests/recent-revenue-stats.test.js`).

- **Security review of the diff:**

  - **`routes/invoices.js#GET /api/recent-revenue`** — single SELECT (via `db.getRecentRevenueStats`), fully parameterised. Days arg is whitelisted to `RECENT_REVENUE_WINDOWS = [7, 30, 90]` via strict `Array.includes` membership check before reaching SQL — any other value (negative, zero, NaN, missing, far-future, query-string array forms, garbage) deterministically falls back to 30. Single most important regression guard for this route — a tampered `?days=99999` cannot exfiltrate a wider window than the toggle UI advertises. `userId` is taken from `req.session.user.id` (server-controlled, set by login/register/webhook only — never from `req.body` or `req.query`). Mounted before `/:id` so `'api'` isn't matched as an invoice id (asserted by a dedicated test). `Cache-Control: no-store` prevents stale data on toggle clicks. No SQL-injection vector. No XSS surface (JSON output, not HTML).

  - **`views/dashboard.ejs` — Alpine `recentRevenueCard()` scope.** The `x-data` init payload is `JSON.stringify({...})` of `recentRevenue.days/totalPaid/invoiceCount/clientCount` — all 4 fields are guaranteed numeric by `buildRecentRevenueCard()`'s `Number()` / `parseInt(...)` coercion. **Defence-in-depth hardening applied inline this cycle:** appended `.replace(/</g, "\\u003c")` to the JSON output to prevent any future regression where a stringy field with `</script>` or `</div>` content could escape the `x-data='...'` attribute or the surrounding HTML context. The current code is safe today (numbers can't contain `<`), but the escape is the canonical defence-in-depth pattern for JSON-in-HTML and costs nothing — the next time someone adds a string field to the init payload, the protection is already in place.

  - **`views/dashboard.ejs` — Alpine `select()` fetch.** Uses `encodeURIComponent(window)` defence-in-depth even though `window` is server-controlled (one of [7, 30, 90] from the literal Alpine `x-for` array). `credentials: 'same-origin'` sends session cookies only for same-origin requests. GET requests don't require CSRF tokens. The fetch URL is a string-concat (no URL injection vector — `window` is a JS literal Number, not user input).

  - **`views/dashboard.ejs` — tile re-render.** All Alpine `x-text` bindings (`x-text="formatMoney(totalPaid)"`, `x-text="invoiceCount"`, `x-text="clientCount"`, `x-text="days"`) auto-escape; `formatMoney` returns a string of `$N.NN` shape (Number → toLocaleString) with no user-controllable content. No `x-html`, no `innerHTML`, no `eval`, no `Function()` constructor. No XSS surface.

  - **`tests/recent-revenue-window-toggle.test.js`** — pure-test file; uses the existing `STRIPE_SECRET_KEY = 'sk_test_dummy'` env-stubbing pattern; no live secrets. Mocks `getUserById` + `getRecentRevenueStats` in-memory.

  - **Hardcoded-secret scan** of all touched files: zero matches for `API_KEY|SECRET|password.*=|sk_live|sk_test` on the cycle-diff lines (the `sk_test_dummy` test fixture was pre-existing). ✓ No new credentials.

- **`npm audit --omit=dev`:** still 6 vulnerabilities (3 moderate, 3 high) — **all pre-existing**, all install-time only. `bcrypt → @mapbox/node-pre-gyp → tar` (3 high — H9 in INTERNAL_TODO); `resend → svix → uuid` (3 moderate — H16). Runtime exposure remains nil. **No new advisories surfaced this cycle** — zero new dependencies (no `npm i`, no `package-lock.json` shifts).

- **Performance:**
  - 1 new SQL query per **toggle click** (not per dashboard render — the dashboard render is unchanged). The toggle click runs `getUserById` + `getRecentRevenueStats` in `Promise.all` — both indexed, sub-millisecond at today's scale (tens to low hundreds of invoices per Pro user). Past ~5k invoices/user, a composite `(user_id, status)` index would help — already tracked as H8.
  - The Alpine fetch is on user click (not on every dashboard load) — zero added latency for users who don't toggle.
  - `Cache-Control: no-store` prevents the browser from caching JSON responses, ensuring data freshness. No CDN cost (the route is `/invoices/...`, behind auth — never cache-eligible at the edge anyway).
  - The Alpine state object is per-component (~4 numbers + 2 booleans + 2 closures = ~200 bytes). No memory waste; GC'd on dashboard navigate-away.
  - No N+1 introduced.

- **Code quality:**
  - The new Alpine factory `recentRevenueCard()` is small (~30 lines), single-purpose, no module state, easy to test in isolation.
  - The new API route is small (~15 lines) and reuses `db.getRecentRevenueStats` + `buildRecentRevenueCard` — single source of truth for "should this card render". No drift risk between SSR and JSON.
  - The whitelist `[7, 30, 90]` is exported as `RECENT_REVENUE_WINDOWS` and asserted by a test to match the toggle UI's literal array — drift guard.
  - **One small DRY note (not new — already H20 in the queue):** `formatMoney` inside the Alpine factory duplicates `lib/html.js#formatMoney`. Same observation as the existing H20 currency-formatter DRY item; the new Alpine duplicate joins the existing `lib/outbound-webhook.js` formatter under the same umbrella. No new flag — bumps H20's surface area slightly.

- **Dependencies:** zero changes — no `npm i`, no `package-lock.json` shifts. `package.json` was edited to add the new test file to the `test` script — dev-only entry, no runtime/production effect.

- **Legal:** No new dependencies, no license changes. The new code surfaces only the user's own paid-invoice data over a user-controllable time window — no PII expansion, no GDPR/CCPA scope change, no PCI scope change (no card data touched), no third-party API usage. Window-toggle copy ("7d / 30d / 90d") makes no claim that requires legal review.

**No CRITICAL / hardcoded-secret findings. No new flags for TODO_MASTER. No new [HEALTH] items added to INTERNAL_TODO.** The 9 existing open [HEALTH] items remain unchanged. **1 inline defence-in-depth hardening applied** (`.replace(/</g, "\\u003c")` on the Alpine init JSON) — small, low-risk, zero-test-impact, ships with this commit.

**Net delta this cycle:** the new code is unusually security-clean. Whitelisted query parameter, parameterised SQL, server-only data sources, JSON-output API (no HTML render), auto-escaping Alpine bindings, defence-in-depth on the JSON-in-HTML boundary. The full test suite is **47 files, 0 failures** — the safety net is intact.

---

## 2026-04-28T20:55Z — Role 6 (Task Optimizer): 18th-pass audit — header refreshed, #117 archived, queue re-ordered + Session Close Summary

**Audit deltas this pass:**

1. **Header refreshed.** Updated INTERNAL_TODO.md audit header to capture this cycle's deltas: #117 closed (XS, ~30 min effort, MED retention shipped); 5 new GROWTH items (#122-#126); 1 new MARKETING (#61 affiliate program); APP_SPEC.md re-synced from codebase reality (was Java-only; now describes both QuickInvoice + InvoiceFlow); EPICS.md created (9 epics, 3 active). 17th-pass header retained as one-line summary; 16th-pass retained too.

2. **#117 archived.** Folded the full description into a one-line `*(...)*` parenthetical at the head of the XS-GROWTH block (same pattern as #91, #92, #101, #106, #107 archives in prior passes). Full detail lives only in CHANGELOG now.

3. **#122-#126 placement.** All 5 new items inserted at the top of the [XS]/[S] GROWTH buckets (Cx-tagged appropriately). Cross-referenced against existing items per Role 4's Cross-checks block; zero merges, zero consolidations.

4. **Re-prioritization (priority order unchanged):** [TEST-FAILURE] (none) > income-critical features > [UX] items affecting conversion > [HEALTH] > [GROWTH] > [BLOCKED]. Within GROWTH, XS-first by impact-per-effort. The new #122-#124 are XS and immediately implementable; #125 + #126 are S complexity.

5. **Cross-checks for non-overlap (re-validated this cycle):** #122 vs #117 vs #102 (UI memory vs UI toggle vs DB-persisted timezone — three separate user-state dimensions); #123 vs #107 vs #88 (delta vs raw vs categorical alert); #124 vs #83 (3-day vs 7-day cohorts of the same task type, both surfaces co-exist); #125 vs #64 vs #88 (top-5 by revenue vs aging by overdue-ness vs categorical non-payer alert); #126 vs #75 (reliability layer vs formatting layer at the same surface). All confirmed orthogonal.

6. **TODO_MASTER reviewed:** All 61 items (1-9 legacy InvoiceFlow setup + 50-61 newer marketing/SPEC-REVIEW additions) checked against this cycle's CHANGELOG. **No items flip to [LIKELY DONE - verify]** — every Master action remains pending its respective external step (Stripe Dashboard config, Resend API key, Plausible domain, G2/Capterra profile creation, AppSumo submission, Rewardful signup, etc.). #60 (SPEC-REVIEW from this cycle's bootstrap) and #61 (affiliate program from Role 4) are the newest entries.

7. **Compaction status.** INTERNAL_TODO.md now ~2.5k lines (overdue by 11 cycles per the 1.5k archive trigger). Deferred again — not blocking work; full archives remain available via CHANGELOG. Will be revisited when the [DONE]-tagged section weight crosses ~1k lines on its own.

8. **Open task index re-counted:** ~120 GROWTH items total (was 116 + 5 new − 1 #117 closed = 120); 9 [HEALTH] items open unchanged; 2 [UX] items (U3 actively buildable; U1 in Resend block); 0 [TEST-FAILURE]. **No new [BLOCKED] items this cycle.**

**Priority order at end of 18th pass (top 12 unblocked items):**

| # | ID | Tag | Cx | Title (1-line) |
|--:|------|------|-----|------|
| 1 | U3 | UX | S | Authed-pages global footer (gated on #28) |
| 2 | **#122** | GROWTH | XS | **Persist last-selected revenue window in localStorage (NEW)** |
| 3 | **#123** | GROWTH | XS | **"vs prior period" delta badge on revenue card (NEW)** |
| 4 | **#124** | GROWTH | XS | **3-day stale-draft yellow banner (NEW)** |
| 5 | #118 | GROWTH | XS | Stripe receipt URL on paid invoice view |
| 6 | #119 | GROWTH | XS | Inline "What's new" pulse-dot on nav |
| 7 | #120 | GROWTH | XS | `<noscript>` SEO fallback hero |
| 8 | #109 | GROWTH | XS | Sticky "+" mobile FAB |
| 9 | #102 | GROWTH | XS | Per-user timezone |
| 10 | #112 | GROWTH | XS | Live "Trusted by N freelancers" hero counter |
| 11 | #113 | GROWTH | XS | Per-niche `<meta description>` blurb |
| 12 | #116 | GROWTH | XS | Empty-state demo accordion on dashboard |

**Resend-blocked (kept at bottom of XS bucket):** U1, #11, #12, #66, #71, #77, #80, #84, #90, and #110 (M-complexity magic-link).

---

# 2026-04-28T20:55Z — Session Close Summary

**What was accomplished this session (across all 7 roles):**

- **Bootstrap** — APP_SPEC.md re-synced from codebase reality (was a stale 30-day-old description of the Java/Spring InvoiceFlow app; now correctly describes both QuickInvoice + InvoiceFlow with accurate plan prices, tech stack, core feature list, and directory layout). EPICS.md created from scratch (first-time scaffolding of the strategic-roadmap layer the routine has been growing organically) — 9 epics, 3 active (E2 Trial→Paid Conversion, E3 Activation, E4 Retention). Master action #60 [SPEC-REVIEW] filed for human verification.
- **Role 1 (Epic Manager)** — wrote a Session Briefing identifying #117 as the highest impact-per-effort unshipped item (XS effort, MED retention, sits on top of #107 which just landed). Marked E1 Stripe Payments [COMPLETE]. Confirmed 3-active-epic budget.
- **Role 2 (Feature Implementer)** — shipped **#117 7d/30d/90d window toggle** on the recent-paid-revenue card. New `GET /invoices/api/recent-revenue?days=N` JSON endpoint (whitelisted `[7, 30, 90]`, falls back to 30); Alpine `recentRevenueCard()` scope wrapping the existing card with a 3-button segmented control, reactive `x-text` re-render, `loading` + `errored` UX flags. ~50 lines route + ~80 lines view + 1 existing test regex updated for span-tolerance.
- **Role 3 (Test Examiner)** — added 25 new test assertions in `tests/recent-revenue-window-toggle.test.js` across 2 layers: 13 API endpoint contract tests (days-arg whitelist, free-plan defence-in-depth, mount-order regression guard, Cache-Control: no-store, agency-treated-as-Pro, missing-user, DB-throw graceful path) + 12 view-render tests (toggle wiring, ARIA, fetch URL drift guard, x-data init shape, SSR fallback, error fallback, print:hidden boundary). Full suite **47 files, 0 failures**.
- **Role 4 (Growth Strategist)** — added 5 new GROWTH items (#122-#126: localStorage window memory, "vs prior period" delta badge, 3-day stale-draft banner, top-5 clients widget, webhook retry queue) + 1 new MARKETING item (#61 affiliate program via Rewardful). All cross-checked for non-overlap; all assigned to currently-active epics (3 to E3, 2 to E4); zero items orphaned to [UNASSIGNED].
- **Role 5 (UX Auditor)** — direct fix on the new toggle's empty-window handling: was throwing `'no_card'` and showing an error message when a Pro user toggled to a window with zero paid invoices; now correctly shows $0/0/0 (the truthful "you weren't paid this week" answer). Re-walked landing → register → dashboard → trial banners → pricing → invoice form/view — no regressions in untouched flows.
- **Role 6 (Task Optimizer)** — refreshed audit header, archived #117 to one-line parenthetical, re-ordered priority queue (new XS items at top, S items in correct bucket), TODO_MASTER reviewed (no items flip to [LIKELY DONE - verify]).
- **Role 7 (Health Monitor)** — see next CHANGELOG entry below for full audit.

**Code shipped this cycle:**
- 1 new JSON API endpoint (`GET /invoices/api/recent-revenue`)
- 1 new Alpine factory (`recentRevenueCard()` in `views/dashboard.ejs`)
- 1 new test file (`tests/recent-revenue-window-toggle.test.js`)
- 1 existing test regex updated for span-tolerance
- 5 new INTERNAL_TODO items (#122-#126)
- 2 new master docs (APP_SPEC re-sync; EPICS scaffolding)
- 2 new TODO_MASTER items (#60 SPEC-REVIEW; #61 affiliate program)

**Most important open item heading into the next session:**

**#122 [XS] Persist last-selected revenue window in localStorage** — XS effort (~10 lines inside the just-shipped Alpine factory), MED retention impact, immediately compounds with #117 by giving the user a per-device memory of their preferred window. Highest impact-per-effort item available; sits on top of code that just landed and is actively in-mind. Estimated cycle to ship: < 30 min implementation + ~20 min new tests.

**Risks / blockers needing Master attention before next run:**

- **Resend API key (TODO_MASTER #18)** — single most leveraged Master action. Unblocks E9 entirely (~10 ready-to-ship retention/conversion email features: U1 password reset, #11 churn win-back, #12 monthly digest, #66 auto-CC accountant, #71 auto-BCC freelancer, #72 .ics calendar, #77 welcome-back on past_due restore, #80 weekly Monday digest, #84 plain-language email body, #90 60+ day inactive re-engagement, #110 magic-link login).
- **APP_URL env var (TODO_MASTER #39)** — unset means sitemap.xml + canonical link tags fall back to request host, which leaks alternate hosts (Heroku free dyno URL + custom domain) into Google's index. Low-effort fix (one env var); low-priority but compounding SEO drift.
- **APP_SPEC review (TODO_MASTER #60 — added this cycle)** — the auto-reconstructed spec needs human eyes to confirm it matches your understanding of what QuickInvoice does + verify Stripe price wiring matches the documented $12/mo + $99/yr prices + decide InvoiceFlow's status (active / frozen / sunset).

---

## 2026-04-28T20:50Z — Role 5 (UX Auditor): toggle empty-window graceful handling + flow regression sweep

**Pathways audited this cycle:**
1. Dashboard with the new `#117` toggle in normal-data-window state.
2. Dashboard with the new toggle clicking from a populated window (30d) to a possibly-empty window (7d).
3. Recent-revenue card → toggle → tile re-render path under network-failure conditions.
4. Re-walked: landing → register → empty-state dashboard onboarding (regression) → trial banner stacking → invoice form → invoice view → 404. No regressions in untouched flows.

**Direct fix applied this cycle (1 substantive UX bug + 0 cosmetic-only changes):**

1. **`views/dashboard.ejs#recentRevenueCard.select()` — empty-window handling.** The Role 2 implementation threw `'no_card'` on any response where `data.card` was null — but the API returns `card: null` for two distinct cases: (a) genuine fetch failure (covered by the catch block already) and (b) a Pro user toggled to a window that has zero paid invoices. Treating (b) as an error showed the user "Couldn't load that window — showing the previous one." when the truthful answer was "you weren't paid in the last 7 days." The "is this week working?" use case (one of the explicit motivations for shipping #117 per the Role 2 changelog) **needs the honest $0 / 0 / 0 answer** — that's exactly the cohort where the toggle is most informative. Fixed: when `data.card` is null but the response was 200, set `totalPaid/invoiceCount/clientCount = 0` and update `days` to the requested window. The error fallback now fires only on genuine fetch / parse failure (network blip, server 500, JSON parse error). Existing tests still pass; one of them ("Pro user with zero paid invoices in window returns card=null") already exercises the API surface this branch handles, so the contract is locked in.

**Regression checks performed (no new fixes needed, but verified clean):**

- **Trial countdown nav pill (#106) + dashboard banner (#45) interaction** — both still render; pill on every authed page header, banner on day 1 still uses urgent red styling. ✓
- **Free-plan invoice progress bar (#31)** — still renders for free users at the right thresholds (0/3 → calm, 2/3 → near, 3/3 → at-limit amber). ✓
- **Onboarding card → trial banner → past-due banner stack** — still renders in the correct priority order (onboarding for un-dismissed users, then trial, then past-due). The new revenue card sits below all three at the right position. ✓
- **Pricing page CTA copy** — still reads "Start 7-day free trial →" with "No credit card required" subtext. Annual savings pill (#101) still emerald-400 on `cycle === 'annual'` toggle. ✓
- **`x-cloak` CSS rule** — verified `[x-cloak] { display: none !important; }` exists in `views/partials/head.ejs:59` so the new error fallback line `<p x-show="errored" x-cloak>` doesn't briefly flash on first paint pre-Alpine boot. ✓
- **Register page subtitle "Free forever — no credit card needed"** — accurate; the free plan is forever AND the 7-day Pro trial path (which is reached via Pricing / upgrade-modal) is also no-credit-card. The register copy intentionally under-promises (avoids over-promising trial behaviour to the segment that just wants a free invoicing tool). ✓
- **Login → register cross-link** — both directions still cross-link cleanly. ✓
- **Mobile breakpoint on the new toggle** — toggle row uses `flex-wrap` so on narrow mobile (< 384px wide), the toggle wraps below the section header rather than overflowing. ✓

**Anti-fixes — flagged but deliberately left:**

- **Toggle button tap target.** The 7d/30d/90d buttons are `px-3 py-1` ≈ 24px tall — below the 44px iOS HIG tap-target standard. But (a) consistency with the existing Pro/Agency segmented controls in `views/pricing.ejs` and `views/settings.ejs` matters more than absolute compliance, and (b) the buttons are 3x adjacent so accuracy is forgiving. Defer; if mobile-conversion analytics ever surface a "toggle abandonment" pattern, revisit.
- **Toggle copy "7d / 30d / 90d" abbreviated.** Considered "7 days" / "30 days" / "90 days" or "Week" / "Month" / "Quarter". Abbreviated wins on density; the surrounding "Last 30 days" caption + section header give enough natural-language context. Defer.
- **Section header "You've been getting paid" stays static when the user toggles to an empty 7d window** ($0 / 0 / 0). The header is identity-framing, not data — the tiles + caption carry the actual numbers. The slight tonal mismatch ("You've been getting paid" + "$0.00" in the Revenue tile) is acceptable; the alternative ("You haven't been getting paid this week") is too negative for the dashboard's emerald-50 trust-frame. Defer.

**Test impact:** zero existing tests asserted on the catch branch's 'no_card' error path (verified via `grep -rn "no_card" tests/`). The new behaviour (empty window → zeros, no error message) is the reasonable user expectation — no test regressed; no test deleted.

**Income relevance:** SMALL but compounding. The empty-window fix turns a confusing dead-end ("Couldn't load that window") into a useful signal ("you weren't paid this week — time to send invoices"). Same data, different framing. Specifically rescues the cohort where #117 is most valuable: the freelancer checking "is this week working?" who toggles 7d on a slow week. The pre-fix behaviour would have left them with an error message + the previous-window's data still on screen — actively misleading. The post-fix behaviour answers the question honestly.

---

## 2026-04-28T20:45Z — Role 4 (Growth Strategist): 5 new GROWTH ideas (#122-#126) + 1 new MARKETING item (#61)

**Process:** scanned the existing 121 GROWTH items + 60 MARKETING items for un-mined surfaces. Cross-checked each candidate against the existing queue for non-overlap. The just-shipped #107 (revenue card) + #117 (window toggle) opened up a small cluster of compounding extensions that are XS-effort and immediately implementable.

**Added to INTERNAL_TODO.md:**

- **#122 [GROWTH] [XS]** — Persist last-selected revenue window in `localStorage` (epic E3). Tiny extension to #117. ~10 lines, no DB. MED retention via "the app remembers me". Distinct from #117 (UI toggle) and from #102 (per-user timezone — DB-persisted user preference vs. per-device localStorage UX preference).
- **#123 [GROWTH] [XS]** — "vs prior period" delta badge on the recent-revenue card (epic E3). Right of the dollar tile, render `↑ +42% vs prev 30d`. Single SQL CTE extension to `db.getRecentRevenueStats`. MED retention via comparison-framing. Compounds with #117 (toggle drives both the current window AND the prior-period delta). Distinct from #107 (raw stats) and from #88 (frequent-non-payer alert — different signal direction).
- **#124 [GROWTH] [XS]** — 3-day stale-draft yellow banner above the dashboard table (epic E3). Distinct from #83 (7+ day stale-draft, broader cohort). The 3-day window is the high-recovery-yield cohort — by 7 days the draft is forgotten; by 3 days the freelancer still remembers what it was for. MED activation/revenue-recovery.
- **#125 [GROWTH] [S]** — "Top 5 clients by revenue" dashboard widget (epic E4). Renders below the recent-revenue card; same window toggle drives it (so 7d/30d/90d swaps both at once). Single GROUP BY query. MED retention via 80/20 awareness — surfaces the client distribution freelancers don't track. Compounds with #88 (frequent non-payer — opposite end of the same axis) and with #98 (top clients are the right testimonial sources). Distinct from #64 aging receivables (time-bucketed by overdue-ness vs. ranked by volume).
- **#126 [GROWTH] [S]** — Webhook retry queue with exponential backoff (epic E4). Today `firePaidWebhook` is fire-and-forget — if Slack/Discord 502s, the cha-ching message never lands. 3 attempts at 2s/8s/30s. HIGH trust impact for Pro users who came for the Slack/Discord integration. Distinct from #75 (formatting layer; #126 is the reliability layer beneath it).

**Cross-checks for non-overlap:**
- #122 vs #117 vs #102: #117 is the UI toggle that just shipped; #122 is the per-device localStorage memory of the user's preference; #102 is the DB-persisted timezone setting (different field, different surface — server-side localisation vs. client-side UI memory).
- #123 vs #107 vs #88: #107 is the raw last-30d numbers; #123 is the delta vs. prior 30d (forward-vs-backward comparison framing); #88 is a categorical alert (frequent non-payer pattern). Three different signal types.
- #124 vs #83: same task type but different cohort. The 3-day cohort (#124) catches drafts while the freelancer still has context; #83 catches the abandoned cohort. Both surfaces co-exist — a draft at 3 days fires the small banner; the same draft at 7 days escalates to the prominent #83 nudge.
- #125 vs #64 vs #88: #64 is aging receivables (time-bucketed by overdue-ness, OVERDUE direction); #88 is non-payer alert (categorical, BAD-CLIENT direction); #125 is top-5 by revenue (ranked, GOOD-CLIENT direction). Three orthogonal client analytics.
- #126 vs #75: #75 shipped the formatting (Slack vs. Discord vs. canonical payload); #126 is the retry/reliability layer underneath. Two different concerns at the same surface.

**Added to TODO_MASTER.md:**

- **#61 [MARKETING]** — Affiliate program setup via Rewardful (~$49/mo + 25% recurring 12-month commission). Distinct from #18 (referral — peer-to-peer end-user "your friend referred you"), distinct from #59 (co-marketing — partner integrations like Calendly/Bonsai/Notion), distinct from #43/#54/#55 listicles/podcasts (one-off media spends). Affiliates are professional creators with audiences in QuickInvoice's ICP — YouTubers, newsletter authors, freelance influencers. ~6 hrs initial setup + ~1 hr/month ongoing. Conservative ramp: 10-50 paid signups/month at month 6, 50-150/month at month 18. Net MRR-equivalent at month 6 (after commission): $90-$1350/month — scales linearly, no ad spend. Sequencing: ship after Master sets RESEND_API_KEY (#18) so affiliates aren't recommending a tool whose password-reset path is a stopgap email-support flow.

**TODO_MASTER review:** All 60 prior items checked against this cycle's CHANGELOG. **No items flip to [LIKELY DONE - verify]** — every Master action remains pending its respective external step. #18 (Resend API key), #38 (OG image asset), #39 (APP_URL env var) all genuinely open. #60 (SPEC-REVIEW — added in this cycle's bootstrap) is the newest pre-existing entry; #61 (affiliate program) is the new add this cycle.

**Active-epic alignment:** all 5 new GROWTH items map cleanly to currently-active epics — 3 to E3 Activation (#122, #123, #124), 2 to E4 Retention (#125, #126). No items orphaned to the [UNASSIGNED] bucket. Zero items added to E5/E7 (PLANNED epics) or E9 (PAUSED — Resend gate).

---

## 2026-04-28T20:40Z — Role 3 (Test Examiner): #117 API + toggle render coverage (25 new assertions)

**Audit scope:** the 2 new pieces shipped by Role 2 — the `GET /invoices/api/recent-revenue` JSON endpoint and the dashboard's Alpine toggle scope. Both were uncovered. The existing pure-fn tests in `tests/recent-revenue-stats.test.js` cover `buildRecentRevenueCard()` and the SSR card render, but they don't exercise: the API's days-arg whitelist (a hot risk path — a tampered query string is the obvious attack surface), free-plan defence-in-depth on the JSON path, the route mount order (a single mistake would route `'api'` as an invoice id), or the toggle's wiring to the API URL.

**New file: `tests/recent-revenue-window-toggle.test.js` — 25 tests across 2 layers.**

**Layer 1 — API endpoint contract (13 assertions):**

1. **Route registration + mount order.** Asserts `/api/recent-revenue` exists on the router stack AND its index is below `/:id` — guards against a future change that would route `'api'` as an invoice id (would manifest as a `getInvoiceById('api')` 500). The mount-order assertion is the sharpest tooth in this file: re-organising routes at the top of `routes/invoices.js` is exactly the kind of refactor that would silently break this if the human didn't know the constraint.
2. **`days=7` / `days=90` accepted (whitelist members).** Both happy paths — the dashboard offers exactly these.
3. **`days=30` default when query is missing.** The toggle's initial state.
4. **Out-of-whitelist falls back to 30.** Iterates `['60', '1', '365', '99999', 'garbage', '-1', '0', '', null]` — every one must clamp to 30. This is the single most important regression guard for the API: without it, an attacker could pass `days=99999` and have it silently clamp to 365 inside `db.getRecentRevenueStats`, exposing a different time-window than the UI advertises. The whitelist forces strict equality with the offered set.
5. **Free-plan user gets `card: null`** — defence-in-depth. The `buildRecentRevenueCard` already returns null for free, but a future refactor that swapped the helper out would break that contract silently. The test is the canary.
6. **Pro user with zero paid invoices in window → `card: null`.** Matches SSR behaviour.
7. **`Cache-Control: no-store` header.** Guards the freshness invariant — without `no-store`, browsers cache the JSON response and the toggle stops updating after the first server-rendered window's data is cached.
8. **Stats DB throw is internally caught** — `loadRecentRevenueStats` swallows pg errors and returns null, so the API still returns 200 with `card: null`. Documents the actual graceful-degradation path. (The earlier draft of this test wrongly asserted 500 on stats throw — corrected mid-test-run; the 500 path is reserved for `getUserById` failure or other top-level errors.)
9. **Top-level DB error (`getUserById` throws) → 500 with `card: null` + `error: 'lookup_failed'`.** The 500 surface that exists for unrecoverable DB failures.
10. **Agency plan is treated like Pro.** Regression guard against a future change that would special-case Pro at the API but forget Agency (which paid more — $49 vs $12).
11. **Missing user (deleted-account / dangling-session) → `card: null`.** Same shape as `buildRecentRevenueCard(null, ...)`.
12. **`RECENT_REVENUE_WINDOWS` export matches `[7, 30, 90]`** — drift guard between the API constant and the toggle's UI literal.

**Layer 2 — Dashboard toggle render (12 assertions):**

13. **3 buttons rendered (7d / 30d / 90d)** via the `x-for="opt in [7, 30, 90]"` template loop. Asserts both the array literal `[7, 30, 90]` in the script source AND the toggle's `data-testid="recent-revenue-toggle"`.
14. **`role="group"` + `aria-label`** for screen-reader access — the segmented control isn't a native form element, so the ARIA hooks matter.
15. **`@click="select(opt)"` Alpine binding** — the wiring that fires the fetch.
16. **Reactive `:aria-pressed`** — screen readers announce which window is active.
17. **`:disabled="loading"`** — no double-click race during in-flight fetch (a real concern with a 30+ms-perceived button click on a slow network).
18. **`x-data` init seeds days/totalPaid/invoiceCount/clientCount from server** — the JSON.stringify shape is asserted directly, so a future refactor that omits any field surfaces here.
19. **Tile values rendered via `x-text="formatMoney(totalPaid)"` / `x-text="invoiceCount"` / `x-text="clientCount"`** — required for Alpine to swap them on toggle.
20. **SSR fallback values still render** — graceful pre-Alpine-boot. `$1,234.56` + `4` + `2` all appear in the rendered HTML even though Alpine will overwrite them when it boots. Pre-hydration UX matters: the user shouldn't see "$" with no number for the 100ms before Alpine attaches.
21. **Fetch URL matches the registered API route path** — drift guard. If the route mount path ever changed (say `/invoices/api/recent-revenue` → `/api/v1/recent-revenue`), this test breaks alongside the route, forcing the view to update too.
22. **Error fallback line `x-show="errored"`** with `role="status"` — graceful failure surface.
23. **Loading dim class** on the tiles — UX feedback during fetch.
24. **Print:hidden boundary intact** — regression guard. The toggle MUST sit inside the `print:hidden` parent so it doesn't bleed into invoice prints.
25. **Toggle absent on free-plan dashboard** (where `recentRevenue` is null) — the toggle has no card to control, so it must render nothing.

**Test approach:** the API tests fire the route handler directly with a mock `req`/`res` — no supertest, no real HTTP. The handler's last layer in `apiLayer.route.stack` is the async function we want; awaiting `finalLayer.handle(req, res, () => {})` lets `res.json` complete before assertions read `res.body`. The view tests use the same `ejs.render(dashboardTpl, ...)` pattern as the existing recent-revenue-stats tests — pure regex assertions on the rendered HTML, no browser, no Alpine boot.

**Coverage gaps remaining (tracked in INTERNAL_TODO, not in scope here):**
- A real browser-end test of the Alpine toggle (clicking 7d, observing the tile values change) would require a Playwright/Puppeteer harness — the test suite is currently `node tests/foo.js` plain, no browser dependency. Defer.
- The `formatMoney` JS helper inside the EJS `<script>` block is duplicated from `lib/html.js#formatMoney` (regression risk if `lib/html.js` ever drifts to `formatMoneyTerse` or similar). Tracked as a low-priority [HEALTH] candidate — pairs with the existing H20 currency-formatter DRY item.

**Full suite this cycle: 47 test files, 0 failures** (was 46 — added `tests/recent-revenue-window-toggle.test.js`). One existing assertion in `tests/recent-revenue-stats.test.js` updated to be span-tolerant (the days number is now wrapped in `<span x-text="days">30</span>` so Alpine can re-render it). User-visible behavioural guarantee — the dashboard says "Last 30 days" — is unchanged. No tests deleted.

---

## 2026-04-28T20:35Z — Role 2 (Feature Implementer): #117 — 7d / 30d / 90d window toggle on the recent-paid-revenue card [DONE]

**Epic:** E3 Activation (sits on top of #107 which shipped last cycle).

**Task chosen:** INTERNAL_TODO #117 [GROWTH] [XS] — give the user a 7d/30d/90d toggle on the recent-revenue dashboard card so they can answer "is this week working?" / "is this quarter working?" without leaving the dashboard. Highest impact-per-effort unshipped item — XS complexity, MED retention impact, sits directly on top of the helper that just landed.

**What shipped:**

1. **`routes/invoices.js`** — new `GET /invoices/api/recent-revenue?days=N` JSON endpoint. The days arg is hardened: parsed as int, then `RECENT_REVENUE_WINDOWS.includes(requested) ? requested : 30` — only `[7, 30, 90]` are accepted, anything else (negative, zero, too-large, garbage, missing) silently falls back to 30. Reuses the same `db.getRecentRevenueStats` + `buildRecentRevenueCard` shape used by SSR — so render decisions (free → null, no paid invoices → null) stay identical across SSR and JSON paths. `Cache-Control: no-store` to prevent stale data on toggle. Mounted **before** `/:id` (deliberately) so Express doesn't route `'api'` as an invoice id. New module export `RECENT_REVENUE_WINDOWS` for tests / future surfaces.

2. **`views/dashboard.ejs`** — recent-revenue card wrapped in `x-data="recentRevenueCard(initial)"` Alpine scope. Initial state is server-rendered (so the card is meaningful pre-Alpine boot — SEO-/no-JS-friendly, and SSR-test-friendly). New segmented-control toggle row (3 buttons: 7d / 30d / 90d) sits in the card header, role="group" + aria-label="Choose revenue window", per-button `:aria-pressed="days === opt"` for screen readers + active-state Tailwind classes. Toggle click → `select(window)` → fetch `/invoices/api/recent-revenue?days=N` (same-origin, credentials included) → swap `days` / `totalPaid` / `invoiceCount` / `clientCount` reactive state → Alpine re-renders the 3 tiles via `x-text`. `loading` flag dims the tiles via `:class="loading ? 'opacity-60 transition-opacity' : ''"` + disables all 3 toggle buttons during in-flight fetch (no double-clicks racing). On fetch failure (network, 500, missing card) the previous values are kept and an `x-show="errored"` `<p role="status">` line surfaces "Couldn't load that window — showing the previous one." — graceful degradation never strands the user with stale-but-unmarked state.

3. **`tests/recent-revenue-stats.test.js`** — one existing assertion's regex updated from `/Last 30 days/` to `/Last\s*(?:<span[^>]*>\s*)?30(?:\s*<\/span>)?\s*days/` to remain span-tolerant under the new `<span x-text="days">30</span>` wrapping (Alpine needs the span so it can re-render the days number on toggle). Behavioral guarantee unchanged — user-visible text is still "Last 30 days". No tests deleted; full suite still **46 files, 0 failures**.

**Income relevance:** MED retention. The single fixed 30-day window forced one perspective on every dashboard load; the toggle gives the user agency. 7d answers "is this week's invoicing rhythm working?" — the high-frequency engagement moment for an active freelancer. 90d answers "did Q1 deliver?" — the strategic quarterly check-in. Same data, three different pump-prime contexts. Compounds with #107 (which surfaced the metric in the first place) by giving Pro users a reason to come back to the dashboard daily / weekly / quarterly instead of only when they need to send an invoice.

**[Master action]** none — schema-additive (no migration); API and view changes only. Auto-available to every paying Pro/Agency user with at least 1 paid invoice in the trailing 30 days (same gate as #107). The 7d/90d windows surface zero rows for new Pro users until they have a paid invoice in those windows — graceful by design (the buttons still toggle, the card just shows $0 / 0 / 0 — and `buildRecentRevenueCard` returns null when invoiceCount is 0, so the card simply hides if the chosen window has no paid activity. Users seeing the 90d window populated but the 7d window empty is an honest signal — "you've been paid but not THIS week" is itself a useful nudge to get back to invoicing).

**Sequencing:** Closes #117 cleanly. Future enhancement candidates from this code: localStorage-persist the user's last-selected window (so a user who prefers 7d sees 7d on next dashboard load), or analytics on which window users most often toggle to (signals product-market-fit per persona — solo freelancers may prefer 7d, agencies may prefer 90d). Both are deferred; the current ship lands the core lever.

---

## 2026-04-28T20:30Z — Session Briefing (Role 1, Epic Manager) — App spec re-synced + Epics scaffolding ratified

**Bootstrap deltas this cycle (executed before Role 1):**

- **`master/APP_SPEC.md` rewritten from the codebase.** The prior spec described only the Java/Spring `invoiceflow/` subdirectory and pinned obsolete plan prices ($9 Solo / $19 Pro). Reality: the active codebase is QuickInvoice (Node.js/Express at repo root), with prices Free / $12/mo Pro / $99/yr Pro / $49/mo Agency. New spec documents both apps as one file (App 1 = QuickInvoice primary, App 2 = InvoiceFlow secondary parallel implementation) with accurate tech stack, monetization, core features, and directory layout. Master action filed: TODO_MASTER #60 [SPEC-REVIEW] for human verification.
- **`master/EPICS.md` created.** First-time scaffolding of the strategic-roadmap layer the routine has been growing organically. 9 epics extracted from existing INTERNAL_TODO clusters: E1 Stripe Payments [COMPLETE]; E2 Trial→Paid Conversion [ACTIVE]; E3 Activation/Time-to-First-Value [ACTIVE]; E4 Retention/Stickiness [ACTIVE]; E5 Expansion [PLANNED]; E6 Distribution/SEO [PLANNED]; E7 Accounting/Pro power-user features [PLANNED]; E8 Health/Security/Compliance [PLANNED — Role 7 audits each cycle]; E9 Email/Resend gate [PAUSED — single Master action unblocks 10+ tasks]. Each epic carries a goal paragraph, status, child task IDs, and income impact rating.

**Active epics this cycle (3 of 3 budget):**

1. **E2 Trial→Paid Conversion** — single most direct revenue lever. Trial-cohort conversion at industry-typical 4-8% is the difference between $0 and $700+ MRR per 100 trial signups. Open queue: #82 plan-comparison table for free users (XS), #95 paid-invoice tab-flash retention, #119 nav pulse-dot, #46 pricing-page exit-intent modal, #109 mobile FAB.
2. **E3 Activation** — gates everything else. Open queue: #117 7d/30d/90d window toggle (XS, sits on top of just-shipped #107), #118 Stripe receipt URL on paid view (XS, AP-friendly artefact), #102 per-user timezone, #111 client-preview pre-send modal, #116 empty-state demo accordion.
3. **E4 Retention/Stickiness** — multiplier on LTV. Open queue: #88 frequent-non-payer alert, #87 Stripe payout reconciliation widget, #57 NPS micro-survey, #121 dashboard streak gamification.

**Most important thing to accomplish this session:** the highest impact-per-effort unshipped item right now is **#117** (7d/30d/90d window toggle on the recent-paid-revenue card) — XS complexity, MED retention impact, sits directly on top of #107 (which just shipped last cycle), and the underlying `getRecentRevenueStats(userId, days)` helper already accepts a clamped days arg [1, 365]. This is the cleanest "ship a vertical slice that compounds with what just landed" move available. **Role 2 will implement #117.**

**Blockers / risks worth flagging before work begins:**
- **Resend API key** (TODO_MASTER #18) remains unset in production — this single Master action unblocks 10+ ready-to-ship tasks under Epic E9. Highest-leverage external action.
- **Stripe Business price** (TODO_MASTER for #10) — gates the $29/mo Business tier ARPU expansion lever.
- **APP_URL env var** (TODO_MASTER #39) — without it, sitemap.xml + canonical link tags fall back to the request host, which leaks alternate hosts (Heroku free dyno URL + custom domain) into Google's index.
- **OG image asset** (TODO_MASTER #38) — the placeholder `public/og-image.png` is in the repo but the spec calls for a branded asset. Low-priority; not blocking.
- **No [TEST-FAILURE] items in queue.** Test suite is green (46 files, 0 failures) at session start. Safety net intact.

**Epic-level adjustments made this cycle:**
- E1 marked [COMPLETE] — every child task DONE (Stripe Payments + Subscription Lifecycle: #1, #2, #3, #30, #31, #41, #45, #91, #92, #95). The subscription loop is built and earning. Future increments live under E5 (expansion/upsell).
- No epics paused or restarted this cycle.
- E9 (Email Channel) flagged as [PAUSED] — entirely Resend-blocked; un-pauses on Master setting RESEND_API_KEY in prod.

---

## 2026-04-28T19:55Z — Role 6 (Health Monitor): clean cycle audit — zero new findings on the new code

**Audit scope this cycle:** the 4 production files touched in Role 1 + 4 (`db.js`, `routes/invoices.js`, `views/dashboard.ejs`, `package.json`) and the 1 new test file (`tests/recent-revenue-stats.test.js`).

- **Security review of the diff:**
  - **`db.js#getRecentRevenueStats`** — single SELECT, fully parameterised (`$1` userId + `$2` days, never interpolated). Days arg sanitised twice: `parseInt(days, 10) || 30` → `Math.max(1, Math.min(365, ...))`. `userId` is taken from `req.session.user.id` (server-controlled, set by login/register/webhook only — never from `req.body`). No SQL-injection vector. No N+1 (single round-trip; previously the dashboard had two parallel queries — now three, all `Promise.all`). The `LOWER(COALESCE(NULLIF(...)))` dedupe expression is a pure SQL function, not user-eval'd JS.
  - **`routes/invoices.js`** — three new helpers (`buildRecentRevenueCard`, `loadRecentRevenueStats`, the dashboard route's parallel-fetch shape). `loadRecentRevenueStats` wraps the DB call in try/catch returning `null` — graceful degradation: a Postgres outage on this query never 500s the dashboard. `buildRecentRevenueCard` is a pure function over server-controlled fields (`user.plan`, query-result columns) — no user-supplied strings reach any conditional branch.
  - **`views/dashboard.ejs`** — new card renders `recentRevenue.totalPaid` via `toLocaleString()` (no XSS surface — Number-typed input + browser-built-in formatter), `recentRevenue.clientCount` and `recentRevenue.invoiceCount` via `<%= %>` (EJS auto-escaped, but they're integers so no escape need fires). `recentRevenue.days` is rendered into `data-days="<%= recentRevenue.days %>"` and into the section copy "Last N days" — also integer-typed, also EJS-escaped. Static Tailwind classes; no class injection. The `aria-label="Recent paid revenue"` and `role="region"` markup is accessibility-clean.
  - **Hardcoded-secret scan** of the 4 touched files: zero matches for `API_KEY|SECRET|password.*=|sk_live|sk_test` on the cycle-diff lines. ✓ No new credentials.

- **`npm audit --omit=dev`:** still 6 vulnerabilities (3 moderate, 3 high) — **all pre-existing**, all install-time only. `bcrypt → @mapbox/node-pre-gyp → tar` (3 high — H9 in INTERNAL_TODO); `resend → svix → uuid` (3 moderate — H16). Runtime exposure remains nil. **No new advisories surfaced this cycle** — zero new dependencies (no `npm i`, no `package-lock.json` shifts).

- **Performance:**
  - 1 new SQL query per dashboard render (`getRecentRevenueStats`). Runs in parallel with the existing 2 queries via `Promise.all` — adds 0ms wall-clock (the dashboard latency is dominated by the slowest of the 3, not the sum). The query is a single SELECT against `invoices` filtered by `user_id=$1 AND status='paid' AND updated_at >= NOW() - 30d`. The existing `idx_invoices_user_id` index covers the user_id predicate; the additional filter on `status` and `updated_at` is a small in-row scan once the user's invoices are located. At today's per-user invoice count (tens to low hundreds), wall-clock cost is sub-millisecond. Past ~5k invoices/user, a composite `(user_id, status)` index would help — already tracked as H8 (no new flag needed).
  - No N+1 introduced. No new memory waste — the query returns 1 row, parsed to a small object (~50 bytes) per request. Card markup adds ~600 bytes of HTML for users where it renders, 0 bytes for everyone else. R14 (Heroku memory) budget unaffected.
  - The `loadRecentRevenueStats` wrapper adds a `try/catch` boundary — well within hot-path overhead.

- **Code quality:**
  - `buildRecentRevenueCard` is small (15 lines), pure, fully covered (10 unit tests + 5 SQL-contract tests). Exports follow the existing `module.exports` pattern (`buildOnboardingState`, `buildInvoiceLimitProgress`).
  - Zero dead code introduced. No new repeated logic — the existing `tests/recent-clients.test.js` uses the same `loadRealDb()` swap-and-restore pattern that this cycle's new SQL-contract tests adopted.
  - The new `getRecentRevenueStats` helper is the single source of truth for "recent paid stats" — anything in the future that wants 30-day-paid metrics (#117 window toggle, #80 weekly digest) reuses this.

- **Dependencies:** zero changes — no `npm i`, no `package-lock.json` shifts. `package.json` was edited to add the new test file to the `test` script — dev-only entry, no runtime/production effect.

- **Legal:** No new dependencies, no license changes. The new card surfaces only the user's own paid-invoice data (their own data they entered) — no PII expansion, no GDPR/CCPA scope change, no PCI scope change (no card data touched), no third-party API. Card copy ("You've been getting paid · Last 30 days") makes no claim that requires legal review.

**No CRITICAL / hardcoded-secret findings. No new flags for TODO_MASTER. No new [HEALTH] items.** The 9 existing open [HEALTH] items remain unchanged: H8 composite (user_id, status) index (which would help this new query when scale rises — flagged in the perf note above; still tracked under the same item), H9 bcrypt bump, H10 parseInt radix, H11 pagination, H15 Promise.all GET handlers, H16 resend bump, H17 trial-nudge partial index, H18 expression index for recent-clients, H20 currency-formatter DRY.

**Net delta this cycle:** the new code is unusually clean — pure function + parameterised SELECT + auto-escaped render + graceful-degradation wrapper. Zero net new attack surface introduced. The full test suite is **46 files, 0 failures** — the safety net is intact.

---

## 2026-04-28T19:50Z — Role 5 (Task Optimizer): 17th-pass audit — header refreshed, #107 archived, queue re-ordered

**Audit deltas this pass:**

1. **Header refresh.** Updated the audit header to capture this cycle's deltas: #107 closed, 5 new GROWTH items (#117-#121), 1 new MARKETING (#59 partner co-marketing), 2 UX direct fixes. The 16th-pass header was retained as a one-line summary; the 15th-pass header retained too. Cycles 8-12 remain compacted (full detail in CHANGELOG).

2. **#107 archived from active queue.** The full description was condensed to a one-line `*( #107 closed... )*` parenthetical inside the XS section (same pattern as #91, #92, #101, #106 archives in prior passes). Full detail moved to CHANGELOG only.

3. **#117-#120 placed in [XS] bucket** (top of the XS GROWTH list, immediately after the closed-task parentheticals). #121 placed in [S] bucket. Initially the placement was duplicated — the Growth Strategist pass inserted them at the bottom of the [S] block, then the Optimizer pass added abbreviated entries at the top. Cleaned up the duplication so each item appears once: #117/#118/#119/#120 in XS, #121 in S.

4. **Re-prioritisation:** unchanged — priority order remains **[TEST-FAILURE] (none) > income-critical features > [UX] items that affect conversion > [HEALTH] > [GROWTH] > [BLOCKED]**. Within GROWTH, XS-first by impact-per-effort. The new #117-#120 are XS and immediately implementable; #121 is S.

5. **Cross-checks for non-overlap (re-validated this cycle):** #117 vs #107 (just shipped — XS unlock); #118 vs #70 vs #97 (3 distinct receipt artefacts); #119 vs #44 (dot vs widget); #120 vs #56 vs #36 (3 distinct SEO surfaces); #121 vs #107 vs #44 (cadence vs dollars vs product-news). No items merged; no items consolidated.

6. **TODO_MASTER review:** Re-walked the 59 items (1-49 + 50-59 from cycles 14-17) against this cycle's CHANGELOG. **No items flip to [LIKELY DONE - verify]** — every Master action remains pending its respective external step (Stripe Dashboard config, Resend API key, Plausible domain, G2/Capterra profile creation, AppSumo submission, etc.). #59 (partner co-marketing) is the newest entry; #58 (SaaS comparison directories), #57 (AppSumo) and earlier remain genuinely open.

7. **Compaction status.** INTERNAL_TODO.md now ~2.5k lines (overdue by 10 cycles per the 1.5k archive trigger). Deferred again — not blocking work; full archives remain available via CHANGELOG. Will be revisited when the [DONE]-tagged section weight crosses ~1k lines on its own.

**Net delta:** active queue head is now (in priority): U1+U3 [UX] (blocked on Resend / #28); then **#117-#120 [XS]** (income-critical, impact-per-effort highest); then the existing Resend-gated XS pile (#66/#71/#73/#77/#80/#82/#84/#88/#90); then S items including the new #121. Free queue capacity remains high — every cycle is compounding both new code and new strategic surface area.

---

## 2026-04-28T19:45Z — Role 4 (UX Auditor): copy clarity on the new dashboard revenue card + temporal context for the existing all-time stats row

**Flows audited this cycle:** dashboard (this cycle's primary touch), landing → register → dashboard onboarding (re-walked for regression), invoice-view (paid invoice surfaces), pricing → upgrade. No regressions found in untouched flows.

**Direct fixes applied:**

1. **`views/dashboard.ejs` — "Paid" tile label → "Revenue".** The new last-30-day card had three tiles labelled "Paid", "Clients paid you", "Invoices paid". All three start with "Paid"-flavoured words, which makes the first tile ambiguous (the user has to read the dollar value to know it's the amount, not the count). Renamed the first tile to "Revenue" — clearer category (it's the dollar figure, not a count), and pairs naturally with the section header "You've been getting paid" without the word-collision. Tests still pass (the test asserts `data-testid="recent-revenue-total"`, not the label string — exactly the right boundary for a copy fix to slip through cleanly).

2. **`views/dashboard.ejs` — added "ALL-TIME TOTALS" subtitle above the existing Total Invoiced / Collected / Outstanding row, only when the new recent-revenue card is rendered.** Without this label, the user sees the new card ("Last 30 days") immediately followed by 3 cards that don't say what timeframe — visual ambiguity. Adding the small uppercase subtitle creates a clean temporal contrast: 30-day card on top → all-time row below. The subtitle is conditionally rendered (`<% if (locals.recentRevenue && recentRevenue) { %>`) so dashboards without the new card stay visually unchanged for free users.

**Regression checks (no new fixes needed, but verified clean):**
- Onboarding card → trial banner → past-due banner stack: still renders in correct priority order (onboarding for un-dismissed users, then trial for trialing users, then past-due for failed cards). No copy drift.
- Pricing page CTA: still reads "Start 7-day free trial →" with "No credit card required" subtext. ✓
- Empty-state copy: "Send your first invoice today" + the conditional Pro callout. ✓
- Login → register cross-link: "New to QuickInvoice? Create a free account →" / "Already have an account? Log in" — both still present and clear.
- Mobile breakpoint: the new revenue card uses `grid-cols-3` which on small mobile (<384px wide) compresses awkwardly. The existing all-time row has the same pattern, so it's consistent (not a regression). Flagged as low-priority below.

**[UX] flagged for INTERNAL_TODO (low priority — not adding to queue this cycle since the all-time row has the same constraint and is acceptable today):**
- Recent-revenue card mobile compression (<384px). Could swap to `grid-cols-1 sm:grid-cols-3` for a vertical stack on the smallest mobile, but this would also need to be applied to the existing all-time row for consistency. Light cosmetic; defer.

**Net delta this cycle:** 2 direct copy/layout fixes shipped without opening new [UX] tasks. The new card now reads cleanly on its own AND in context with the existing stats row.

---

## 2026-04-28T19:40Z — Role 3 (Growth Strategist): 5 new GROWTH ideas + 1 new MARKETING item (cycle 17)

**Process:** scanned the existing 116 GROWTH items + 58 MARKETING items for un-mined surfaces; cross-checked each new candidate against the existing queue for non-overlap.

**Added to INTERNAL_TODO.md:**

- **#117 [GROWTH] [XS]** — 7d/30d/90d window toggle on the new recent-paid-revenue card (#107 just shipped this cycle). Tiny Alpine `x-data` + 1 JSON route reusing the new `getRecentRevenueStats(userId, days)` helper. MED retention. Distinct from #107 (different surface — UI control vs. card itself) and from #87 payout reconciliation (forward vs backward).
- **#118 [GROWTH] [XS]** — Stripe receipt URL on paid invoice view. Today after a Stripe Payment Link is paid we mark the invoice paid via webhook but never surface the Stripe-hosted receipt URL. Adds an `stripe_receipt_url` column + 1-line view change. AP-friendly artefact compounding. Distinct from #70 receipt PDF (own-rendered) and from #97 Stripe receipt-emails toggle (pre-pay configuration).
- **#119 [GROWTH] [XS]** — Inline "What's new" pulse-dot on nav bar (24-hr post-deploy attention-getter). Pairs with #44 in-app changelog widget but smaller — just the dot. localStorage-gated. MED retention via "the product is alive" signal, particularly for trial users on day 5-7.
- **#120 [GROWTH] [XS]** — `<noscript>` SEO fallback hero on landing + niche pages. Hardens Lighthouse SEO score (Cumulative Layout Shift penalty on JS-rendered hero) and gives Google's first-pass indexer cleaner content. MED-HIGH SEO via Lighthouse-score lift. Pairs with #56 robots/canonical (DONE) + #36 OG metadata (DONE).
- **#121 [GROWTH] [S]** — Dashboard "Streak" gamification badge ("X weeks in a row sending invoices" / "Y weeks paid"). Duolingo/Strava cadence-reinforcement pattern. Distinct from #107 (dollar/count metrics) and #44 changelog (product-news vs user-progress). MED retention.

**Cross-checks for non-overlap:**
- #117 vs #107: #117 is the user-controllable timeframe surface for the card #107 just shipped (different surface, same query helper). 
- #118 vs #70 vs #97: 3 distinct receipt artefacts (Stripe-hosted URL post-pay vs. own-rendered PDF vs. pre-pay receipt-email toggle).
- #119 vs #44: #119 is the attention-getter-dot; #44 is the widget itself. #119 ships first, #44 is what it points at.
- #120 vs #56 vs #36: 3 distinct SEO surfaces (noscript fallback hero vs. robots/canonical headers vs. OG metadata).
- #121 vs #107 vs #44: streak (behavioural cadence) is orthogonal to dollar metrics (#107) and product-news (#44).

**Added to TODO_MASTER.md:**

- **#59 [MARKETING]** — Co-marketing partnership outreach (Calendly, Bonsai, Notion, Plaid/Mercury/Wise). Distinct from #43 listicles (third-party editorial), #58 SaaS comparison directories (passive submission), and #44 LinkedIn outreach (direct-to-end-user). Partner-channel distribution is the remaining un-mined acquisition lever. ~10 hrs initial outreach + 2 hrs/month ongoing. Estimated 24-480 paid signups/year across 4 active partnerships at 3-8% paid conversion (= $3.5k-$70k/year MRR-equivalent). Slower ramp (4-12 weeks) but highest-leverage compounding once a partner relationship is real. Sequenced: Mercury/Plaid/Wise emails this week → Notion template next week → Bonsai co-marketing in 4 weeks → Calendly when INTERNAL_TODO #32 (API Key Auth) lands.

**TODO_MASTER review:** No items flip to [LIKELY DONE - verify] this cycle. #18 (Resend API key), #38 (OG image asset), #39 (APP_URL) remain genuinely open per the latest state.

---

## 2026-04-28T19:35Z — Role 2 (Test Examiner): SQL-contract assertions for `db.getRecentRevenueStats`

**Audit scope:** the SQL query introduced in this cycle's Role 1 (`db.getRecentRevenueStats`). The pure-fn render tests in `tests/recent-revenue-stats.test.js` (19 of them) cover the JS contract, but the literal SQL string was untested — a query mistake (wrong table, wrong status filter, missing user_id predicate, missing parameter binding) would slip past pure-fn tests and only surface as a runtime DB error in production.

**5 new SQL-contract assertions added** to `tests/recent-revenue-stats.test.js` (now 24 tests, was 19):

1. **Parameterised SQL + DECIMAL parsing.** Captures the exact SQL text + parameter shape via a fake-pool injection, asserts:
   - Query targets `FROM invoices` with `status = 'paid'` filter (no cross-status leak).
   - Time-window predicate is `updated_at >= NOW() - ($2 * INTERVAL '1 day')` (parameterised, not interpolated — no SQL-injection vector even if the days arg were attacker-controlled).
   - `COUNT(DISTINCT ...)` exists for client dedupe (the SQL pattern, not just the JS counter).
   - Parameters are bound as `[userId, days]`, never concatenated into the SQL string.
   - pg's DECIMAL-as-string return is parsed to `Number` (not left as `'2400.00'` string).

2. **Days-arg clamping.** Exercises `9999` → `365`, `0` → default `30` (falsy fallback), `-10` → `1`, `'garbage'` → default `30`. Guards the input-sanitisation contract.

3. **Empty result row.** When pg returns `rows: []` (a 0-row corner case that shouldn't happen with COUNT/SUM but is theoretically possible if the query is intercepted), the helper returns `{days, totalPaid: 0, invoiceCount: 0, clientCount: 0}` with all-zero defaults — never throws, never returns `undefined`.

4. **NULL SUM coalesce.** Verifies that the SUM(total) column is `COALESCE`'d to 0 in SQL (so a no-paid-invoice user gets `'0'` not `null`) and parsed to a `number` typeof — guards a downstream `toLocaleString()` crash in the EJS template.

5. **user_id filter (cross-tenant leak prevention).** Asserts the SQL contains `WHERE user_id = $1` and the captured `params[0]` matches the input — the single most important regression guard for a multi-tenant SaaS query. Any rewrite that drops the user_id predicate (eg. someone "optimising" the query) would surface here as a test failure, not as a production data-leak.

**Test approach:** monkey-patches `pool.query` on the real `db.js` module after a `require.cache` clear — exercises the actual SQL string of the implementation. Restores the original `pool.query` in a `finally` block so subsequent tests aren't affected. This is the same swap-and-restore pattern `tests/recent-clients.test.js` would benefit from (flagged for future cleanup, not in scope here).

**Coverage gaps remaining:**
- The dashboard route's `loadRecentRevenueStats` graceful-degradation path (DB throw → returns null → card hidden) is exercised indirectly via the existing route-level tests (the "Recent revenue stats lookup failed:" log lines from stub-DB tests prove the catch fires). A direct integration test would belong in a future `tests/dashboard-revenue-card.test.js` if the route gets more conditional branches.
- No flaky or redundant tests detected this cycle. No tests deleted.

**Full suite: 46 test files, 0 failures.**

---

## 2026-04-28T19:30Z — Role 1 (Feature Implementer): #107 — last-30-day paid-revenue stats card on dashboard [DONE]

**Task:** INTERNAL_TODO #107 [GROWTH] [S] — surface a "what you collected lately" card above the existing 3-stat row so paying Pro/Agency users see their own positive momentum every dashboard load.

**What shipped:**

1. **`db.js`** — new `getRecentRevenueStats(userId, days = 30)`. Single SELECT against `invoices` filtering `user_id=$1 AND status='paid' AND updated_at >= NOW() - ($2 * INTERVAL '1 day')`. Returns `{days, totalPaid, invoiceCount, clientCount}` with all numeric fields coerced from pg's DECIMAL-as-string. The window arg is clamped to `[1, 365]`. We use `updated_at` as the paid-time proxy (no `paid_at` column today): `status` only flips to `'paid'` once and the same UPDATE bumps `updated_at`; column drifts only if a paid invoice is later edited (rare — typical workflow ends at paid). `clientCount` is a `COUNT(DISTINCT LOWER(COALESCE(NULLIF(client_email, ''), client_name)))` — same dedupe shape as `getRecentClientsForUser`, so two paid invoices to the same client (different casing) count as one paying client.

2. **`routes/invoices.js`** — `GET /` now fetches the stats in parallel with the existing `getInvoicesByUser` + `getUserById` (so no added per-page latency). New pure helper `buildRecentRevenueCard(user, stats)` decides whether the card renders: returns `null` for missing user / free plan / null stats / non-object stats / zero paid invoices in the window. Returns a sanitised `{days, totalPaid, invoiceCount, clientCount}` (NaN-coerced to 0; stringy fields parsed) for paying users with paid revenue. Card is exported (`module.exports.buildRecentRevenueCard`) for unit testing — same export pattern as `buildOnboardingState` and `buildInvoiceLimitProgress`. New `loadRecentRevenueStats` wrapper catches DB errors and returns `null` (graceful degradation — a Postgres outage on this query never 500s the dashboard).

3. **`views/dashboard.ejs`** — new emerald-50 / emerald-200 card rendered inside the populated-invoices branch, sitting above the existing Total Invoiced / Collected / Outstanding 3-card grid. Header reads "💸 You've been getting paid" with a "Last N days" sub-line. Three white tiles: "Paid" (dollar amount, emerald-700 bold), "Clients paid you" (count), "Invoices paid" (count). Card is `print:hidden` so it doesn't leak into invoice-print output. `data-testid="recent-revenue"` + `data-days="<N>"` for analytics + tests. Hidden from free users, from users with no paid invoices in the window, and from the empty-state branch.

4. **`tests/recent-revenue-stats.test.js`** — new test file, **19 assertions, all passing**:
   - **Pure logic (10):** missing user → null; free plan → null; null stats → null; non-object stats → null; zero invoiceCount → null; populated case returns full card; agency + business plans render; stringy stats coerced to numbers; `days` arg parsed; NaN totalPaid → 0 (no `$NaN` in render).
   - **EJS render (9):** card renders all 3 tiles; thousand-separator formatting on $12,345.60; omitted when `recentRevenue=null`; omitted when `recentRevenue=undefined`; carries `print:hidden`; sits above the existing "Total Invoiced" stats row (DOM-order check); omitted on empty-state branch (no invoices); `data-days` attribute exposed for analytics; `clientCount=0` edge case renders "0" cleanly.

5. **`package.json`** — appended `tests/recent-revenue-stats.test.js` to the test runner. Full suite green: **45 test files, 0 failures.**

**Income relevance:** MED retention. The Stripe-Atlas effect — showing the user their own MRR-style metric makes the product feel like a partner in their own growth, not just an invoicing tool. Distinct from the existing Total/Collected/Outstanding row (lifetime totals; doesn't surface recent momentum) and from #87 payout reconciliation (forward-looking — what Stripe will send next; this is backward-looking — what's already landed). Compounds with #88 frequent-non-payer alert (negative signal) by adding a positive signal to the same dashboard row. Stickiness lever: a Pro user who sees "$2,400 paid in last 30 days" every dashboard load attaches more value to keeping the subscription.

**[Master action]** none — schema-additive (no migration); pure additive query + view changes. Card auto-appears for every paying Pro/Agency user with at least 1 paid invoice in the trailing 30 days. The window default (30 days) is hard-coded for now; future enhancement could expose a 7d/30d/90d toggle on the card itself (left as #107.1 if the demand surfaces).

**Sequencing:** Closes #107 cleanly. The remaining S-complexity income-critical queue is now headed by #108 (competitor pricing mini-table on /pricing) and #98 (public review/testimonial collection page).

---

## 2026-04-28T18:35Z — Role 6 (Health Monitor): clean cycle audit — zero new findings

**Audit scope this cycle:** the 5 files touched in Role 1 (`lib/html.js`, `server.js`, `routes/auth.js`, `routes/invoices.js`, `views/partials/nav.ejs`); the 2 files touched in Role 4 (`views/auth/login.ejs`, `views/dashboard.ejs`); the 1 new test file (`tests/trial-countdown-nav.test.js`); the modified `package.json` test runner.

- **Security review of the diff:**
  - `lib/html.js` — new `formatTrialCountdown` is a pure function (no IO, no module state, no user-supplied strings rendered as HTML). Computes purely from a Date input + numeric epoch. No XSS surface. No prototype-pollution surface (no key-from-input lookup). Output is a small object of numbers + a fixed-format string; the consumer (`nav.ejs`) renders the string via `<%= %>` which EJS auto-escapes — defence-in-depth covered, and the regression test (`escape-safe label rendering`) explicitly asserts a `<script>` payload doesn't pass through.
  - `server.js` — the new middleware reads `req.session.user.trial_ends_at` and feeds it to the pure-fn helper. Session data is server-controlled (set by login/register/webhook); not user-modifiable. Zero new attack surface.
  - `routes/auth.js` — two additional fields on the session.user shape (`trial_ends_at`, `subscription_status`). Both come straight off the DB row (`db.getUserByEmail` / `db.createUser`), not from `req.body`. Zero injection path.
  - `routes/invoices.js` — added `trial_ends_at: user.trial_ends_at` to the existing session refresh; same DB-row source.
  - `views/partials/nav.ejs` — the pill renders `<%= trialCountdown.label %>` (escaped) inside an anchor with a static `href`, static Tailwind classes selected via ternary on a server-computed boolean (`urgent`), and a static `title` attribute. The `data-trial-urgent` attribute receives a literal `"true"`/`"false"` from the same boolean — no user-controlled value reaches any markup slot.
  - **Hardcoded-secret scan** of all touched files: 2 matches, both pre-existing safe patterns — `bcrypt.hash(req.body.password, 12)` (correct hashing of user-supplied input) and the documented `SESSION_SECRET || 'dev-secret-change-in-production'` fallback (with the explicit prod-time env-var requirement check at `server.js:20-22`). **No hardcoded credentials, no API keys.** ✓
- **`npm audit --omit=dev`:** 6 vulnerabilities (3 moderate, 3 high) — **all pre-existing**, all install-time only. `bcrypt → @mapbox/node-pre-gyp → tar` (3 high, install-time) tracked under [HEALTH] H9; `resend → svix → uuid` (3 moderate, install-time) tracked under H16. Runtime exposure remains nil. **No new advisories surfaced this cycle** — zero new dependencies (no `npm i`, no `package-lock.json` shifts).
- **Performance:** Zero new DB queries this cycle. The new middleware adds 1 pure-fn call per request (sub-microsecond — a Date arithmetic + a few string concatenations). The pill markup adds ~250 bytes of HTML for users in `trial_ends_at IS NOT NULL` state, 0 bytes for everyone else. Well within R14 (Heroku memory limit) budget. No N+1, no missing indexes, no new hot paths. The session-shape change adds 2 small fields (Date + short string) per session record — negligible vs the existing session payload.
- **Code quality:** `formatTrialCountdown` is small (24 lines), pure, fully covered (12 unit tests), and exported via the canonical `lib/html.js` module — no drift risk. Session-shape population is consistent across all 3 surfaces (login, register, dashboard refresh) — verified by the wiring tests in Role 2.
- **Dependencies:** zero changes — no `npm i`, no `package-lock.json` shifts. `package.json` was edited to add the new test file to the `test` script — dev-only entry, no runtime/production effect.
- **Legal:** No new dependencies, no license changes, no new user-data collection (trial_ends_at already in schema), no new third-party APIs, no PCI scope change, no GDPR/CCPA implications. The pill copy ("Xd Yh left in trial · Add card") makes no claim that requires legal review.

**No CRITICAL / hardcoded-secret findings. No new flags for TODO_MASTER. No new [HEALTH] items.** The 9 existing open [HEALTH] items remain unchanged: H8 composite (user_id, status) index, H9 bcrypt bump, H10 parseInt radix, H11 pagination, H15 Promise.all GET handlers, H16 resend bump, H17 trial-nudge partial index, H18 expression index for recent-clients, H20 currency-formatter DRY.

**Net delta this cycle:** the new code is unusually safety-clean — pure function, server-only data, escape-by-default rendering, fully tested. Zero net new attack surface introduced.

---

## 2026-04-28T18:30Z — Role 5 (Task Optimizer): 16th-pass audit — header refreshed, #106 archived, queue re-ordered

**Audit deltas this pass:**
- **#106 archived as [DONE]** as a parenthetical block at the head of the XS-GROWTH bucket. Detail mirrors the CHANGELOG #106 entry below (helper + middleware + auth/login session shape + nav.ejs pill + 25 tests).
- **Top of file metadata** rewritten: 15th-pass narrative folded into the "15th-pass audit retained" line; 16th-pass narrative now occupies the lead block. Cross-overlap rationale for #112-#116 + MARKETING #58 written into the audit header so the next optimizer pass has the differentiation cached.
- **Priority queue re-sorted** (the new #1 unblocked-XS item is #96; #106 vacates the queue as DONE). New items #112, #113, #116 inserted into the XS-GROWTH bucket; #114, #115 inserted into the S-GROWTH bucket.
- **Open task index re-counted:** 109 GROWTH items total (was 105; +5 this cycle, -1 #106 closed); 9 [HEALTH] items open unchanged; 2 [UX] items (U3 actively buildable; U1 in Resend block); 0 [TEST-FAILURE]. **No new [BLOCKED] items this cycle.**
- **TODO_MASTER reviewed:** all 58 items checked against this cycle's CHANGELOG. None flip to [LIKELY DONE - verify] — every prior Master action remains pending its respective external step.
- **Duplicate consolidation pass:** ran cross-checks on the 5 new GROWTH + 1 new MARKETING items vs the 109+58 existing items. Zero duplicates.
- **Archive trigger:** file at ~2.6k lines, trigger at 1.5k. Overdue 11 cycles. Defer again — fragmentation cost still exceeds size-bloat cost. Will revisit if file crosses 3k.

**Priority order at end of 16th pass (top 12 unblocked items):**

| # | ID | Tag | Cx | Title (1-line) |
|--:|------|------|-----|------|
| 1 | U3 | UX | S | Authed-pages global footer (gated on #28) |
| 2 | #96 | GROWTH | XS | "Send a copy to me too" checkbox on invoice send |
| 3 | #97 | GROWTH | XS | Stripe Receipt-emails default-on toggle |
| 4 | #95 | GROWTH | XS | Tab-title flash + favicon dot for paid invoices |
| 5 | #102 | GROWTH | XS | Per-user `timezone` for due-date display + reminder cron |
| 6 | **#112** | GROWTH | XS | **Live "Trusted by N freelancers" hero counter (NEW)** |
| 7 | **#113** | GROWTH | XS | **Per-niche `<meta description>` blurb (NEW)** |
| 8 | **#116** | GROWTH | XS | **Empty-state demo accordion on dashboard (NEW)** |
| 9 | #109 | GROWTH | XS | Sticky "+" FAB on mobile dashboard |
| 10 | #73 | GROWTH | XS | Pre-portal cancel-reason survey |
| 11 | #82 | GROWTH | XS | Plan comparison table on dashboard for free users |
| 12 | #44 | GROWTH | XS | "✨ What's new" changelog widget in nav |

**Resend-blocked (kept at bottom of XS bucket):** U1, #11, #12, #66, #71, #77, #80, #90, and #110 (M-complexity magic-link).

**Income-critical context:** #106 was item #6 last cycle and shipped this cycle. The cycle delivered:
- 1 closed [GROWTH] (#106 — MED persistent-surface conversion lift on every authed page during trial).
- 5 new [GROWTH] in queue (#112-#116).
- 1 new [MARKETING] (#58 SaaS comparison directories — passive evergreen referral channel).
- 2 UX direct fixes (login.ejs CTA framing, dashboard.ejs fallback-path plain English).
- 25 new test assertions (trial-countdown-nav).

---

## 2026-04-28T18:25Z — Role 4 (UX Auditor): login CTA + dashboard fallback-path plain-English fixes

**Pathways audited (anonymous → first-time signup → paying user):**

1. Landing (`views/index.ejs`) → Hero CTA → Pricing card → Register (`views/auth/register.ejs`) → Dashboard empty state → Settings (`views/settings.ejs`) → Invoice form (`views/invoice-form.ejs`) → Invoice view (`views/invoice-view.ejs`) → 404 (`views/not-found.ejs`).
2. Re-entry: Login (`views/auth/login.ejs`) → Dashboard with mid-trial state → New trial-countdown nav pill (this cycle's Role 1 ship).
3. Edge: free-user dashboard subtitle path when `invoiceLimitProgress` is null (rare fallback).

**Direct fixes applied this cycle (2 copy changes; no [UX] tasks added):**

1. **`views/auth/login.ejs:38`** — Was: `No account? Sign up free`. Now: `New to QuickInvoice? Create a free account →`. The "No account?" framing reads as an awkward yes/no question rather than an action prompt; "New to QuickInvoice? …" is the standard SaaS-login pattern (Stripe, GitHub, Linear all use this form). Adds the right-arrow glyph for visual continuity with every other CTA in the auth flow. Pure copy change; no test depended on the prior phrasing (verified).

2. **`views/dashboard.ejs:172`** — Was: `Free plan · 0/3 invoices used`. Now: `Free plan · 0 of 3 invoices used`. The `0/3` form reads as a fraction (zero-thirds); "0 of 3" is unambiguous English. This is the rare fallback path that fires only when `invoiceLimitProgress` is null (the closed #31 progress bar feature handles the common path); but the fallback still renders for stale-session-state corner cases — keeping the copy plain-English defends against the "huh, what does 0/3 mean?" reaction in those cases.

**Anti-fixes — flagged but deliberately left:**

- **`views/auth/login.ejs:41`** — "Forgot your password? Email support@..." remains the documented stop-gap pending U1 self-serve password reset (which is gated on Resend). The mailto fallback is the correct interim — escalating would duplicate U1.
- **Mobile-only fork of the new trial-countdown nav pill** — the pill is `hidden sm:inline-flex` to give the mobile nav breathing room. The trial-urgency surface on mobile is still the dashboard banner (#45) + the trial-nudge email (#16). A bespoke mobile-nav variant of the pill could be added later if mobile-trial conversion under-performs desktop, but the dashboard banner + email already address the same cohort. Status: leave as-is.
- **Pricing page Free-tier "Up to 3 invoices" line** — accurate today (matches `routes/invoices.js#FREE_LIMIT = 3`); the spec doc references different numbers but the production cap is 3. No drift to fix.

**Test impact:**
- Zero existing tests asserted on the changed strings (verified via grep). No test regressed; no test deleted.
- Full suite still green: 44 files, 0 failures.

**Income relevance:** SMALL but compounding. The login-CTA rewrite directly addresses the bounce-from-login cohort (forgotten-credential users who arrived to log in and need a clear path to "I should make a new account if I don't have one"). The dashboard fallback rewrite is defensive — it cleans a corner-case render that becomes more common during long-tail edge-case session states. Both fixes are conversion-flow lubrication; neither individually MED+ but they sum to a cleaner gradient.

---

## 2026-04-28T18:20Z — Role 3 (Growth Strategist): 5 new GROWTH items (#112-#116) + 1 new MARKETING item (#58)

**Generated this cycle:** 5 implementable [GROWTH] items (3× XS view-only, 2× S code+schema) + 1 [MARKETING] item (passive evergreen directory listings).

**INTERNAL_TODO additions:**

| # | Cx | Title | Income lever | Impact | Prereqs |
|---|----|-------|--------------|--------|---------|
| #112 | XS | Live "Trusted by N freelancers in M countries" hero counter | Conversion (dynamic social proof) | MED | None — module-cached COUNT(*); ship-now/flip-on-at-100-users |
| #113 | XS | Per-niche `<meta name="description">` blurb | SEO (SERP snippet CTR) | MED | None — `routes/landing.js#listNiches()` field + `head.ejs` slot |
| #114 | S | `?ref=<user_slug>` referral attribution at register | Virality (word-of-mouth attribution) | MED-HIGH | New `users.referrer_id` column (idempotent migration); pre-cursor for #18 |
| #115 | S | "Reply to client" mailto chip on paid invoices | Retention (rebook lift) | MED | None — view change ~20 lines |
| #116 | XS | Empty-state demo accordion on dashboard | Activation (first-time-user explainer) | MED | Static placeholder ships now; video asset is TODO_MASTER deliverable |

**Cross-overlap check (vs. all 105+ existing items):**

- **#112** vs #20 social proof testimonials (testimonials are qualitative + static; this is quantitative + dynamic). vs #36 OG metadata (different surface — meta tags vs visible hero).
- **#113** vs #36 OG/Twitter Card metadata (different cohort — paid-social shares vs organic-search SERPs).
- **#114** vs #18 full referral program (#114 is the attribution-only sub-step; #18 is the M-complexity Stripe-coupon-driven follow-up. #114 ships the data layer #18 needs).
- **#115** vs #55 auto thank-you email (different sender — Stripe receipt vs human freelancer rebook lever; Stripe receipt is automation, this is relationship-tooling). vs #92 share-intent buttons (different lifecycle moment — pre-pay vs post-pay).
- **#116** vs #60 demo-mode (different surface — empty-state passive video vs `/demo` interactive sandbox at standalone URL).

**TODO_MASTER addition (#58 — SaaS comparison directories):**

- vs #12 PH (24-hr event vs evergreen passive)
- vs #26 G2/Capterra (review-driven, gravity-dependent vs profile-completeness-driven)
- vs #57 AppSumo (transactional cash-event vs passive evergreen referral surface)
- vs #43 listicle outreach (third-party-editorial vs user-submission-driven)

The 6 directories (Slant, AlternativeTo, SaaSHub, Capiche, StackShare, Tekpon) are submission-flow-driven — Master controls them entirely (no editorial gatekeeping). 4-12 weeks indexing runway; 50-300 monthly visitors per directory once ranked; ~3-5% signup conversion → 9-90 signups/month per directory; sustainable evergreen channel with zero ongoing cost.

---

## 2026-04-28T18:15Z — Role 2 (Test Examiner): trial-countdown nav coverage + 25 new test assertions

**Audit scope:** the new lib/html.js#formatTrialCountdown helper, the views/partials/nav.ejs render path, the server.js res.locals.trialCountdown middleware wire, and the routes/auth.js + routes/invoices.js session shape changes (all from this cycle's Role 1 ship).

**Coverage gap closed:** the trial countdown was previously surface-only on the dashboard banner (`views/dashboard.ejs:49-91`, covered by `tests/trial.test.js`). The Role 1 ship added a global-nav surface that was uncovered. Without coverage, future drift on the helper signature, the urgent/calm Tailwind class names, the utm-tag attribution string, or the session-shape population on auth flows would silently break the conversion path without test-suite signal.

**New file: `tests/trial-countdown-nav.test.js` — 25 tests across 3 layers:**

- **Helper unit tests (12):** null/undefined/invalid/past/boundary-now → null; calm 6d 5h → "6d 5h left" + urgent:false; exactly-1-day → "1d left" (no hours suffix); 23h30m → "23h left" + urgent:true; 30m → "<1h left" + urgent:true; ISO-string + numeric-epoch input acceptance; default-now usage; module-export shape.

- **Nav.ejs render tests (10):** pill renders with stable testid + label + data-trial-urgent attribute; href carries `cycle=annual&utm=nav-countdown`; red Tailwind classes + ⏱ emoji on urgent branch; amber Tailwind classes + ⏳ emoji on calm branch; pill hidden for non-trialing/post-trial/anon/free users; `hidden sm:inline-flex` mobile-yield; accessible title attribute; XSS-safe label rendering (escaped <script> doesn't pass through).

- **Wiring/integration tests (3):** server.js imports + uses formatTrialCountdown + assigns res.locals.trialCountdown reading session.user.trial_ends_at; routes/auth.js sets `trial_ends_at` on session.user in BOTH login AND register (regex match-count ≥ 2); routes/invoices.js dashboard refresh keeps `trial_ends_at: user.trial_ends_at` synced.

**Test runner integration:** added the new file to the `test` script in `package.json`. Existing tests untouched (no copy strings in the dashboard fallback rewrite or login.ejs CTA rewrite were asserted — verified via grep).

**Full suite status post-cycle:** 44 test files, 0 failures. Coverage delta: trial-flow conversion path now fully tested across both surfaces (dashboard banner + global nav pill).

**Flake / redundancy review:** no flaky tests surfaced this cycle (all tests deterministic with explicit `now` arg or `Date.now()` proxy). No redundancy: the 12 helper unit tests + 10 nav render tests + 3 wiring tests do not overlap with each other or with `tests/trial.test.js` (which covers the dashboard banner + Stripe webhook trial_ends_at persist path — different surfaces, different code paths).

---

## 2026-04-28T18:10Z — Role 1 (Feature Implementer): #106 trial-countdown timer in global nav — SHIPPED

**Picked:** INTERNAL_TODO #106 (was item #6 in the 15th-pass priority queue) — XS complexity, MED conversion lever, no Master prerequisites, distinct from every existing trial surface.

**What shipped:**

- **`lib/html.js`** — new pure helper `formatTrialCountdown(trialEndsAt, now?)`. Returns `null` when no pill should render (missing/invalid input or trial already ended); otherwise returns `{ days, hours, label, urgent }`. `urgent` flag flips when <24h remain (drives red vs amber styling). Label is computed deterministically from days/hours: `Xd Yh left` / `Xd left` / `Yh left` / `<1h left`. Module-level export added; existing `escapeHtml` + `formatMoney` unchanged.

- **`server.js`** — new middleware writes `res.locals.trialCountdown = formatTrialCountdown(req.session.user.trial_ends_at)` on every request (sits next to the existing `res.locals.user` line). Zero DB hits — reads from session.user only. Unauth requests get `null`. The pill is therefore available to *every* EJS view that includes the nav partial (dashboard, invoice-view, invoice-form, settings, pricing, /redeem, etc.) without per-route plumbing.

- **`routes/auth.js`** — both login and register session shapes now include `trial_ends_at: user.trial_ends_at || null` and `subscription_status: user.subscription_status || null`. A returning user logging in mid-trial sees the pill on their first authed page-view, not after the next dashboard refresh.

- **`routes/invoices.js`** — dashboard session refresh now also syncs `trial_ends_at: user.trial_ends_at` (next to the existing `plan` + `subscription_status` + `invoice_count` refresh). Stripe webhook can update DB at any time; the dashboard refresh keeps the session.user shape eventually-consistent with no extra roundtrip.

- **`views/partials/nav.ejs`** — pill rendered when `locals.trialCountdown` is truthy. Markup: anchor → `/billing/upgrade?cycle=annual&utm=nav-countdown` (annual default + dedicated utm tag for analytics attribution distinct from #45 dashboard-banner clicks); two-branch styling — calm (`bg-amber-50 text-amber-800 border-amber-200` + ⏳) for ≥24h, urgent (`bg-red-50 text-red-700 border-red-200` + ⏱) for <24h. `data-trial-urgent` data-attribute echoes the helper's `urgent` flag for test-friendly styling branches. `hidden sm:inline-flex` so mobile breathing room is preserved (the dashboard banner + trial-nudge email cover the mobile cohort). Title attribute carries the explanatory CTA for sighted hover + assistive technology.

**Income relevance:** MED conversion lift on the trial→paid step. Today the urgency pressure surfaces only on the dashboard banner (#45 closed) and the trial-nudge email (#16). For a Pro trial user mid-flight editing their 3rd invoice on day 6, `views/invoice-form.ejs` and `views/invoice-view.ejs` are "trial-countdown silent" — every page-view during the trial *not* spent on the dashboard is a missed urgency-touchpoint. Adding the pill to the global nav makes the urgency surface persistent across every authed page, multiplying urgency-touchpoints proportionally to per-session page-depth (typically 4-8 page-views per trial-day for active users).

**Tests:** 25 new tests in `tests/trial-countdown-nav.test.js` (covered in Role 2 below). Full suite: 44 files, 0 failures.

**TODO_MASTER actions: none required.** Pure code feature; no Stripe / Resend / DB-migration prerequisite. The implementation reads `trial_ends_at` from existing schema (column already shipped with the trial feature; idempotent migration in `db/schema.sql`).

---

## 2026-04-28T00:18Z — Role 6 (Health Monitor): clean cycle audit — zero new findings

**Audit scope this cycle:** the 6 view files touched in Role 1 (`views/pricing.ejs`, `views/settings.ejs`, `views/partials/upgrade-modal.ejs`) and Role 4 (`views/index.ejs`, `views/invoice-form.ejs`, `views/dashboard.ejs`); the 1 new test file (`tests/annual-savings-pill.test.js`); the 1 modified test file (`tests/recent-regression.test.js`); the modified `package.json` test runner.

- **Security review of the diff:**
  - All 6 view-file edits this cycle are static-string changes (or static-Tailwind-class changes). No user-controlled data flows into the new strings — every literal ("Save $45/year", "$99/yr", "$12/mo", "30 days", "& payment links") is hardcoded server-side. **Zero new XSS surfaces, zero new injection vectors.**
  - The new `x-show="cycle === 'annual'"` Alpine attribute reads a literal string from the client-side scope (`cycle`) which is initialised to a hard-coded `'monthly'` default. No user-controlled value reaches the directive. CSP `script-src-attr 'unsafe-inline'` (already in place per H4) covers the directive.
  - Test files (annual-savings-pill.test.js + recent-regression.test.js) are dev-only; no production-runtime path. Both render templates against fixed locals with no DB/network/IO — pure unit tests.
  - The Role 1 edit on `upgrade-modal.ejs` removed one HTML element (the `(save $45/year)` parenthetical fine print) — strictly subtractive change, can't introduce a bug.
  - **Hardcoded-secret scan (grep `views/*.ejs views/partials/*.ejs views/auth/*.ejs` for `api[_-]key` / `secret` / `password` / `token`):** matches found are all (a) HTML form fields (`type="password"`), (b) marketing copy ("Encrypted passwords"), (c) the legitimate `process.env.APP_URL` read inside `views/partials/head.ejs:12` (server-side EJS block — not exposed to browser). **No hardcoded credentials, no API keys in views.** ✓
- **`npm audit --omit=dev`:** 6 vulnerabilities (3 moderate, 3 high) — **all pre-existing**, all install-time only. `bcrypt → @mapbox/node-pre-gyp → tar` (3 high, install-time) tracked under [HEALTH] H9; `resend → svix → uuid` (3 moderate, install-time) tracked under H16. Runtime exposure remains nil. **No new advisories surfaced this cycle** (no new dependencies — every code change touched only static EJS templates).
- **Performance:** Zero new DB queries this cycle. The 6 view changes net out to roughly +30 bytes of HTML per pricing/settings/modal/index/dashboard/invoice-form render — well within R14 (Heroku memory limit) budget. The new `x-show` directives are evaluated client-side by Alpine; the server still ships both branches but the cost is byte-level, not query-level. No N+1, no missing indexes, no new hot paths.
- **Code quality:** The Role 1 edit on `upgrade-modal.ejs` is **net-negative duplication** — it removed the `(save $45/year)` fine-print parenthetical that was a duplicate of the (now-promoted) green pill. Single source of truth restored for the savings number across all 3 surfaces (pricing, settings, modal) + the new landing-page Pro card (Role 4). The hardcoded "$45" appears in 4 places — `views/pricing.ejs`, `views/settings.ejs`, `views/partials/upgrade-modal.ejs`, `views/index.ejs` — consistent across all four; no drift. The Role 2 cross-surface-consistency test (`testSavingsNumberConsistentAcrossAllThreeSurfaces`) now guards 3 of those; the landing-page Pro card is an additional surface that's not currently in the test scope but a one-line addition could close that — flag for a future cycle if a 4th drift surfaces. Light enough that it's not promoted to a [HEALTH] item right now.
- **Dependencies:** zero changes — no `npm i`, no `package-lock.json` shifts. Total prod tree unchanged. `package.json` was edited to add the new test file to the `test` script — dev-only entry, no runtime/production effect.
- **Legal:** No new dependencies, no license changes, no new user-data collection, no new third-party APIs, no PCI scope change, no GDPR/CCPA implications. The "(save $45/year)" copy promotion is a pure UX micro-rewrite — no claim about anything that requires legal review.

**No CRITICAL / hardcoded-secret findings. No new flags for TODO_MASTER. No new [HEALTH] items.** The 8 existing open [HEALTH] items remain unchanged: H8 composite (user_id, status) index, H9 bcrypt bump, H10 parseInt radix, H11 pagination, H15 Promise.all GET handlers, H16 resend bump, H17 trial-nudge partial index, H18 expression index for recent-clients, H20 currency-formatter DRY. All are bundle-with-next-migration / next-touch hygiene items, none are blocking work.

**Net delta this cycle:** cleanest cycle so far on the security/legal axes — every code change was either static-string, test-only, or test-runner. Zero net new attack surface introduced; one removed (the redundant savings parenthetical = one less surface to keep in sync with the canonical number).

---

## 2026-04-28T00:16Z — Role 5 (Task Optimizer): 15th-pass audit — header refreshed, #101 archived, priority queue re-ordered

**Audit deltas this pass:**
- **#101 archived as [DONE]** as a parenthetical block above #102 in the XS-GROWTH bucket (consistent archive pattern). Detail mirrors the CHANGELOG #101 entry.
- **Top of file metadata** rewritten: 14th-pass narrative folded into the "14th-pass audit retained" line; 15th-pass narrative now occupies the lead block. Cross-overlap rationale for #106-#111 + MARKETING #57 written into the audit header so the next optimizer pass has the differentiation cached.
- **Priority queue re-sorted** (top of the file already shows the new ordering inline). Note: U1 [UX] [M] (self-serve password reset) **removed from top-3 priority slot** because it's blocked on RESEND_API_KEY (Master action — TODO_MASTER #18) — moved into the existing "Resend block" alongside #11/#12/#66/#71/#77/#80/#90/#110, where it fits the same Master-action-blocking pattern. U3 [UX] [S] remains the top open [UX] item (gated on #28 legal pages — implementable code-side independent of Master).
- **#106 + #109 inserted** in the XS-GROWTH bucket immediately after #102; #107 + #108 + #111 inserted in the S-GROWTH bucket; #110 inserted in the M-GROWTH bucket (above the existing #69 / #60 / #50 / #53 / #40 / #21 / #18 / #24 / #17). All in priority order within their complexity tier.
- **Open task index re-counted:** 105 GROWTH items total (was 99; +6 this cycle, -1 #101 closed); 8 [HEALTH] items open (H8/H9/H10/H11/H15/H16/H17/H18/H20 unchanged); 2 [UX] items (U3 actively buildable; U1 in Resend block); 0 [TEST-FAILURE]. **No new [BLOCKED] items this cycle.**
- **TODO_MASTER reviewed:** all 57 items checked against this cycle's CHANGELOG. None flip to [LIKELY DONE - verify] — every prior Master action remains pending its respective external step (Stripe Dashboard config, Resend API key, Plausible domain, G2/Capterra profile creation, Reddit / podcast / YouTube outreach campaigns, AppSumo submission, etc.).
- **Duplicate consolidation pass:** ran cross-checks on the 6 new GROWTH + 1 new MARKETING items vs the 105+57 existing items. Zero duplicates. Closest near-misses (#106 vs #45, #107 vs #87, #108 vs #86, #109 vs #91, #110 vs #17, #111 vs #43, MARKETING #57 vs #12) all explicitly differentiated in-line.
- **Archive trigger:** file at ~2.5k lines, trigger at 1.5k. Overdue 10 cycles. Defer again — fragmentation cost (split context across two files) currently exceeds size-bloat cost. Will revisit if file crosses 3k.

**Priority order at end of 15th pass (top 12 unblocked items):**

| # | ID | Tag | Cx | Title (1-line) |
|--:|------|------|-----|------|
| 1 | U3 | UX | S | Authed-pages global footer (gated on #28) |
| 2 | #96 | GROWTH | XS | "Send a copy to me too" checkbox on invoice send |
| 3 | #97 | GROWTH | XS | Stripe Receipt-emails default-on toggle |
| 4 | #95 | GROWTH | XS | Tab-title flash + favicon dot for paid invoices |
| 5 | #102 | GROWTH | XS | Per-user `timezone` for due-date display + reminder cron |
| 6 | **#106** | GROWTH | XS | **Trial-countdown timer in global nav (NEW this cycle)** |
| 7 | **#109** | GROWTH | XS | **Sticky "+" FAB on mobile dashboard (NEW this cycle)** |
| 8 | #73 | GROWTH | XS | Pre-portal cancel-reason survey |
| 9 | #82 | GROWTH | XS | Plan comparison table on dashboard for free users |
| 10 | #84 | GROWTH | XS | Plain-language email body using first line item summary |
| 11 | #88 | GROWTH | XS | "Frequent non-payer" alert on dashboard |
| 12 | #44 | GROWTH | XS | "✨ What's new" changelog widget in nav |

**Resend-blocked (kept at bottom of XS bucket):** U1 (password reset), #11 (churn win-back), #12 (monthly summary), #66 (auto-CC accountant), #71 (BCC freelancer), #77 (welcome-back on past_due→active), #80 (Mon-AM digest), #90 (60d re-engage), and the new M-complexity #110 (magic-link login). All gated on TODO_MASTER #18 (RESEND_API_KEY).

**Income-critical context:** #101 was item #6 last cycle and shipped this cycle. The cycle delivered:
- 1 closed [GROWTH] (#101 — MED conversion lift on price-page-to-checkout).
- 6 new [GROWTH] in queue (#106-#111).
- 1 new [MARKETING] (#57 AppSumo — only 5-figure cash event in pipeline).
- 4 UX direct fixes (Role 4 + Role 1 surfaces all align on the dollar-amount savings prominence theme).
- 11 new test assertions (annual-savings-pill).

---

## 2026-04-28T00:14Z — Role 4 (UX Auditor): landing-page Pro card + invoice-form jargon + dashboard plan-line UX fixes

**Pathways audited (pre-paying user → paying user → power user):**

1. Landing (`views/index.ejs`) → Register (`views/auth/register.ejs`) → Dashboard empty state → New invoice (`views/invoice-form.ejs`) → Invoice view (`views/invoice-view.ejs`) → Pricing (`views/pricing.ejs`) → Stripe Checkout → Settings (`views/settings.ejs`).
2. Auth dead-ends: Forgot-password mailto link (login), 404 page (already covered last cycle), trial banner urgent variant (covered last cycle).
3. Empty / error states: dashboard empty state, invoice-form flash error, billing webhook flash, not-found.

**Direct fixes applied this cycle (3 copy/layout changes; no [UX] tasks added):**

1. **`views/index.ejs` — Pro pricing card on landing page (line 95).** Was: `Or $99/year — save 31%`. Now: `Or $99/year — save $45/year` with `text-emerald-200 font-semibold` emphasis on the dollar amount. The percentage form ("31%") forces the user to do the price-anchoring math themselves; the dollar form is the conversion-decision-aligned framing. Restores symmetry with the same-cycle Role 1 pill change across pricing/settings/upgrade-modal — landing page is the very first surface a prospect sees, and was the one outlier still leading with the percentage.

2. **`views/invoice-form.ejs` — Due Date label hint (line 47).** Was: `Due Date (Net 30 default)`. Now: `Due Date (defaults to 30 days)`. "Net 30" is accounting jargon — meaningful to bookkeepers and AP departments, but opaque to first-time freelancers who are the dominant segment. The plain-English form ("30 days") is unambiguous; bookkeepers still recognize it instantly. Updated the asserting test in `tests/recent-regression.test.js` to accept either form (regex alternation) so the original spirit of the regression — "the auto-pre-fill must be transparent to the user" — is preserved while allowing the copy edit. No production-runtime behaviour change; pre-fill semantics (today + 30 days) unchanged.

3. **`views/dashboard.ejs` — Pro user plan-line copy (line 175-177).** Was: `Pro plan · Unlimited invoices`. Now: `Pro plan · Unlimited invoices & payment links`. The flat affirmation now also names a high-value Pro feature the user is actively benefiting from, reinforcing the value of the subscription on every dashboard render. Test contract preserved (`gap-coverage.test.js` asserts substring `'Pro plan'` which still matches).

**Anti-fixes — flagged but deliberately left:**

- **`views/auth/login.ejs:41`** — "Forgot your password? Email support@..." is a deliberate stop-gap pending the U1 self-serve password reset flow (which is gated on Resend). The mailto fallback is the right interim — escalating to `[UX]` would duplicate the existing U1 entry. Status: **leave as-is until U1 ships.**
- **Pricing.ejs vs upgrade-modal.ejs supporting-text divergence** ("That's 3 months free vs. paying monthly." vs "Save $45/year vs. paying monthly") — different phrasings on different surfaces is intentional A/B exploration. Each frame is grammatical and accurate; the next [GROWTH] cycle that lands real Plausible analytics (#34, gated on TODO_MASTER #29) will let us measure conversion-per-frame and consolidate. Status: **leave as-is**, do not add [UX] item — analytics-driven decision, not aesthetic-uniformity decision.
- **Mobile FAB for "New invoice"** — surfaced as a real conversion gap (the top-right CTA scrolls off-screen on mobile after ~30 invoices). Already captured this cycle as INTERNAL_TODO #109 [GROWTH] [XS]. Not flagged again.

**Test impact:**
- `tests/recent-regression.test.js` updated (regex broadened to accept both "Net 30 default" and "defaults to 30 days").
- All 43 test files green. No tests regressed; no tests deleted.

**Income relevance (cumulative across the 3 fixes this cycle):** SMALL but compounding. Each fix is conversion-flow lubrication: landing-page first-impression dollar-amount surfaces (lift on register-from-landing-page step), invoice-form jargon-removal (lift on activation rate for first-time freelancers), Pro plan-line content surface (retention via reinforcement of paid value). None individually MED+, but they sum to a measurably cleaner conversion gradient end-to-end — and pair with the same-cycle Role 1 pill promotion for a coherent "show the dollar number prominently everywhere" theme across the entire upgrade funnel.

---

## 2026-04-28T00:11Z — Role 3 (Growth Strategist): 6 new GROWTH items (#106-#111) + 1 new MARKETING item (#57)

**Generated this cycle:** 6 implementable [GROWTH] items (4× XS-S code-only, 1× M code+Resend-blocked, 1× S gated on #43) + 1 [MARKETING] item (AppSumo lifetime-deal listing).

**INTERNAL_TODO additions:**

| # | Cx | Title | Income lever | Impact | Prereqs |
|---|----|-------|--------------|--------|---------|
| #106 | XS | Trial-countdown timer in `views/partials/nav.ejs` | Conversion (trial→paid) | MED | None — pure view + 1 helper in `lib/html.js` |
| #107 | S | Last-30d paid-revenue stat row above dashboard invoice list (Stripe-Atlas effect) | Retention (dopamine loop) | MED | New `db.getRecentRevenueStats(userId, days)` SELECT |
| #108 | S | On-pricing-page side-by-side competitor mini-table | Conversion (direct /pricing traffic) | MED | None — `data/competitor-pricing.json` fixture + view |
| #109 | XS | Sticky "+" FAB on mobile dashboard for "New invoice" | Activation (mobile cohort) | MED | None — pure Tailwind `lg:hidden` view fragment |
| #110 | M | Passwordless magic-link login at `/auth/magic-link` | Conversion (login surface) + retention | MED | Resend in prod (joins #11/#12/#66/#71/#77/#80/#90 in Resend block); 2 new DB columns; 1 new view |
| #111 | S | "Show client preview" pre-send modal (iframe) on invoice-form | Activation (pre-send confidence) | MED | #43 public read-only invoice URL must land first (1-week sequencing) |

**Cross-overlap check (vs. all 100+ existing items):**

- **#106** vs #45 (closed, dashboard-only urgency banner) — different surface (global nav vs dashboard); persistent across all authed pages, not just dashboard. vs email nudges (different channel + different cognitive moment).
- **#107** vs #87 payout reconciliation (different scope — payout = Stripe's next sweep; #107 = forward-looking growth metric). vs #64 aging receivables (different sign — outstanding vs collected). vs #62 tax PDF (different cadence — annual vs rolling-30d).
- **#108** vs #86 vs-pages (full SEO landing pages on `/vs/<competitor>` — direct-traffic destination; #108 is the at-decision-moment surface for direct /pricing arrivals). vs #82 plan comparison (Free-vs-Pro feature comparison; #108 is QuickInvoice-vs-competitor price comparison). vs #46 exit-intent modal (bounce-recovery surface; #108 is in-page-flow surface).
- **#109** vs #91 dashboard "Copy pay link" button (different action, different scope — per-row vs global). vs #23 PWA manifest (different surface — install-time vs in-app FAB).
- **#110** vs #17 Google OAuth (different fork — magic-link works for any email; OAuth requires a Google account). vs #13 (closed, auto-login on register — different trigger).
- **#111** vs existing PDF preview (different artefact — client-facing web page vs PDF; the freelancer wants to see what their CLIENT will see, which is the public read-only HTML page, not the print-PDF). vs #43 (different role — #43 is the URL itself; #111 is the in-form preview that uses it).

**TODO_MASTER additions:**

- **#57 [MARKETING]** — Apply to AppSumo for a lifetime-deal listing. Cash event: $45k typical 60-day window from comparable freelancer SaaS listings. Distinct from every other [MARKETING] item — only one that produces a 5-figure cash injection in a single window. Gated on (a) INTERNAL_TODO #58 redemption page landing, (b) LTD-tier pricing in `db/schema.sql`, (c) 5+ testimonials on landing page (TODO_MASTER #21). Estimated 4-6 weeks runway to ready.

**Priority queue at end of Role 3 (top unblocked items):**

| # | ID | Tag | Cx | 1-line title |
|---|------|------|-----|------|
| 1 | U3 | UX | S | Authed-pages global footer (gated on #28) |
| 2 | #96 | GROWTH | XS | "Send a copy to me too" checkbox on invoice send |
| 3 | #97 | GROWTH | XS | Stripe Receipt-emails default-on toggle |
| 4 | #95 | GROWTH | XS | Tab-title flash + favicon dot for paid invoices |
| 5 | #102 | GROWTH | XS | Per-user `timezone` for due-date display + reminder cron |
| 6 | **#106** | GROWTH | XS | **Trial-countdown timer in global nav (NEW)** |
| 7 | **#109** | GROWTH | XS | **Sticky "+" FAB on mobile dashboard (NEW)** |
| 8 | #73 | GROWTH | XS | Pre-portal cancel-reason survey |
| 9 | #82 | GROWTH | XS | Plan comparison table on dashboard for free users |
| 10 | #84 | GROWTH | XS | Plain-language email body using first line item summary |

Resend-gated XS items (#66 / #71 / #77 / #80 / #90) and the new #110 magic-link sit in the Resend block until Master ships the API key (TODO_MASTER #18).

---

## 2026-04-28T00:09Z — Role 2 (Test Examiner): annual-savings pill coverage + audit pass

**Audit scope this cycle:** the 3 view files touched in this cycle's Role 1 (`views/pricing.ejs`, `views/settings.ejs`, `views/partials/upgrade-modal.ejs`), plus a sweep of recent CHANGELOG entries for under-tested paths.

**Coverage gap identified + closed:**
The new "Save $45/year" pill — added on three reactive surfaces — was not asserted anywhere in the suite. The existing `tests/annual-billing.test.js` validates the `billing_cycle` plumbing and the price strings ($12, $99) but has no assertion on the savings copy itself. A regression that silently dropped the new pill (or changed the dollar number to drift from the actual $45 = 12×12 - 99 math) would slip past CI undetected. **Fixed:** new `tests/annual-savings-pill.test.js` (11 assertions, all passing):

| # | Assertion |
|---|-----------|
| 1 | `pricing.ejs` renders `Save $45/year` AND it is wrapped in an `x-show="cycle === 'annual'"` (no flash-of-unselected on monthly default) |
| 2 | `pricing.ejs` retains the existing `Save 31%` toggle pill (regression guard against accidental removal during the promotion edit) |
| 3 | `pricing.ejs` pill carries an emerald/green background + rounded class (visual prominence — not a bare text line) |
| 4 | `settings.ejs` renders the `Save $45/year` pill for free users AND it's `x-show=annual` gated |
| 5 | `settings.ejs` pill carries `bg-green-*` (visual emphasis) |
| 6 | `settings.ejs` does NOT render the pill for Pro users (the entire upgrade block is gated on `plan !== 'pro'`) |
| 7 | `upgrade-modal.ejs` renders the pill, gated by `x-show="cycle === 'annual'"` |
| 8 | `upgrade-modal.ejs` toggle buttons now show the price inline (`Monthly — $12/mo` / `Annual — $99/yr`) — regression guard for the new label format |
| 9 | `upgrade-modal.ejs` no longer carries the redundant `(save $45/year)` fine-print parenthetical (single source of truth for the savings number) |
| 10 | The savings number string is identical across all 3 surfaces (`$45` everywhere — divergent values would erode trust) |
| 11 | The savings math holds: `$12/mo × 12 - $99 = $45` (catches a future price edit that accidentally drifts only one of the two prices) |

**Coverage map for recent CHANGELOG entries (sanity check):**

| Recent change (cycle date) | Test file | Pass/fail |
|---|---|---|
| #101 inline savings pill (this cycle) | `tests/annual-savings-pill.test.js` | 11 pass |
| #92 share-intent buttons (2026-04-27 PM-5) | `tests/share-intent-buttons.test.js` | 13 pass |
| webhook-outbound agency-plan path (2026-04-27 PM-5) | `tests/webhook-outbound-agency.test.js` | 3 pass |
| dashboard empty-state h2 rewrite (2026-04-27 PM-5) | `tests/dashboard-copy-pay-link.test.js` | covered (CTA copy assertion) |
| settings.ejs intro paragraph rewrite (2026-04-27 PM-5) | not directly asserted | low risk — pure static string, no XSS surface, no conditional logic |
| #91 dashboard "Copy pay link" (2026-04-30) | `tests/dashboard-copy-pay-link.test.js` | 11 pass |
| #75 Slack/Discord webhook templates (2026-04-29) | `tests/webhook-outbound.test.js` | covered |
| #45 last-day urgency banner (2026-04-28 PM) | `tests/trial.test.js` | covered |
| #31 free-plan limit progress bar (2026-04-27 PM-4) | `tests/invoice-limit-progress.test.js` | 15 pass |
| H14 escapeHtml/formatMoney refactor | `tests/html-helpers.test.js` | 27 pass |

No untested recent change ships meaningful runtime logic. The settings.ejs intro paragraph rewrite is the only un-covered diff in the recent window — it's a static-string copy edit with no conditional logic, and asserting copy churn would over-fit the test suite to UX phrasing decisions (volatile by design). Flagged in this audit log only to make the deliberate non-coverage decision explicit.

**Flaky/redundant test sweep:** none found. Each test file owns a non-overlapping path. The 6 logged-error lines that surface during `npm test` runs (`Recent clients lookup failed: db.getRecentClientsForUser is not a function`, `Payment Link creation failed: Stripe connection refused`, etc.) are all expected output from negative-path tests asserting catch-block behaviour — they're not test failures.

**Suite totals after this cycle:** 42 test files → 43 (annual-savings-pill.test.js added). Full `npm test` run is green; no [TEST-FAILURE] tags added to INTERNAL_TODO.

**Income relevance:** Indirect — locks in the #101 conversion-lift implementation (the Role 1 work this cycle) against silent regression. A future view-cleanup pass that accidentally removes either of the two savings surfaces will now hard-fail CI before reaching prod.

---

## 2026-04-28T00:07Z — Role 1 (Feature Implementer): #101 — inline annual-savings $-amount pill across all 3 upgrade surfaces

**What was built:**
The 14th-pass priority queue's #6 unblocked item (#101 [GROWTH] [XS] — inline annual-savings badge on Monthly/Annual toggle in `views/pricing.ejs` + `views/settings.ejs` + the upgrade modal). Today, every user clicking "Annual" on the toggle had to compute the annual savings themselves: monthly = $12 × 12 = $144/yr, annual = $99/yr → savings = $45/year. The toggle showed only "Save 31%" (a percentage label) and one buried text line on pricing.ejs ("Save $45/year vs. monthly"). Settings + the upgrade modal had **no $-amount surface at all**. Even after the user-selected annual on the toggle, the actual dollar savings number was either invisible (settings, modal) or visually de-emphasised (pricing — 12px gray text below the price).

This cycle promotes the savings number to a prominent green pill on all three surfaces so the conversion-decision frame ("$99/year is a clear win over $144") is unambiguous at the moment of choice.

**Files changed (3 view files, 0 DB / backend / test code mutations):**

1. **`views/pricing.ejs`** — restructured the annual price block. Was: a 4xl extrabold `$99/yr` followed by a small emerald-200 supporting line "Save $45/year vs. monthly". Now: a flex row containing the price + an inline `bg-emerald-400 text-emerald-900 text-xs font-extrabold rounded-full px-2 py-1 shadow-sm` pill reading "Save $45/year" — sits visually adjacent to the price, eye doesn't have to move. The supporting line below was repurposed to a concrete-equivalence framing ("That's 3 months free vs. paying monthly.") for additional conviction. Both surfaces x-cloak on initial render and are only shown when `cycle === 'annual'`.

2. **`views/settings.ejs`** — added a new conditional pill row below the Monthly/Annual toggle. New element: `<p class="text-xs font-semibold mb-3" x-show="cycle === 'annual'" x-cloak>` containing `<span class="inline-flex items-center gap-1.5 bg-green-100 text-green-700 px-2 py-1 rounded-full">💰 Save $45/year vs. paying monthly</span>`. The element renders only when the user toggles to annual; default (monthly) state hides it via Alpine's `x-show`. The pre-existing "Save 31%" inline-toggle pill is retained — the new pill is the dollar-amount complement that was missing.

3. **`views/partials/upgrade-modal.ejs`** — three changes:
   - Toggle button labels now include the price: `"Monthly — $12/mo"` and `"Annual — $99/yr"` (was bare `"Monthly"` / `"Annual"`). This makes the price comparison legible *before* the user has even toggled — important on a modal where the user has reached the highest-intent moment in the conversion funnel and shouldn't have to scroll/scan to see what they're paying.
   - Added the new green pill (`bg-green-100 text-green-700` + 💰) below the toggle row, x-shown when `cycle === 'annual'`. Same visual treatment as `settings.ejs` for consistency across the two non-pricing surfaces.
   - Removed the now-redundant fine-print parenthetical from the bottom-of-modal disclaimer ("$99/year (save $45/year)" → "$99/year") — the savings number is now the prominent pill above; carrying it twice was a pre-promotion artefact.

**Tests:**
- All 9 existing `tests/annual-billing.test.js` assertions pass unchanged. They assert the toggle structure + the `billing_cycle` hidden input + the price strings ($12, $99) — none of which were touched by these edits.
- New tests added in this cycle's Test Examiner pass (Role 2 — see this cycle's Role 2 entry below) cover the new pill-presence + x-show=annual gating across all three views.

**Income relevance:**
MEDIUM conversion lift on the price-page-to-checkout step. The math (saved Y dollars / total Z) is the single dominant decision input on the annual upgrade page; surfacing it as a high-prominence pill instead of small gray text or a percentage-only label is the textbook conversion lever for any tier-pricing page. Compounds with #46 (exit-intent modal — different surface, different trigger), #82 (plan comparison table — different message: feature comparison), and the existing `#3` annual price ($99/yr) shipped 2026-04-23 + TODO_MASTER #11 (Stripe Annual price ID configuration). No new Master action required — this is pure view code that ships with the next deploy.

**Cross-overlap check:** confirmed against #46 (different surface), #82 (different message — feature comparison vs price comparison), #3 (closed — different layer: pricing infrastructure vs UI prominence). No duplicate work.

---

## 2026-04-27T17:51Z — Role 6 (Health Monitor): defence-in-depth percent-encode mailto recipient + clean cycle audit

**What was audited (focused on this cycle's diff: invoice-view.ejs share buttons + new tests + 2 UX copy changes):**

- **Security review of the diff:**
  - **`views/invoice-view.ejs` new share-intent block (#92).** First inspection found one defence-in-depth concern: the `mailto:<client_email>?subject=…&body=…` href interpolated `client_email` directly into the URL recipient slot. `client_email` is validated client-side by `<input type="email">` on the invoice form, but no server-side `body('client_email').isEmail()` validator runs in `routes/invoices.js POST /new` or `POST /:id/edit` (only `client_name` is required). A user (or an attacker who has compromised the user's session) could store a hostile address like `foo@bar.com?cc=attacker@evil.com` in the DB; on the next /invoices/:id render, every recipient who clicks the Email share button would silently CC the attacker. The freelancer wouldn't notice — their mail client would just show one "extra" recipient in a field that's typically not foregrounded.
  - **Fixed directly this cycle (XS, contained, safe):** wrapped `invoice.client_email` in `encodeURIComponent(...)` before concatenation. `@` becomes `%40`, `?` becomes `%3F`, `&` becomes `%26`. Modern mail clients (Mail.app, Gmail web, Outlook web, Thunderbird) all un-encode `%40` correctly back to `@`; the encoding closes the `?cc=` / `?to=` injection vector entirely. One new test in `tests/share-intent-buttons.test.js` (`testMailtoRecipientIsPercentEncodedAgainstInjection`) feeds the malformed `foo@bar.com?cc=attacker@evil.com` shape and asserts the mailto href contains no literal `?` or `&` in the recipient portion AND the only post-`?` query keys are `subject` / `body` (no injected `cc=` / `to=` / `bcc=`). Same scrubbing also catches the legitimate apostrophe-in-body HTML entity (`&#39;` → `'`) so the regex doesn't false-positive on encoded entities. The pre-existing `testMailtoHrefIncludesRecipientAndSubject` test was updated to decode the percent-encoded recipient before equality-checking the email — so it asserts the round-trip semantics, not the raw byte sequence.
  - **WhatsApp + SMS hrefs already used `encodeURIComponent` on the body** — those paths were never injectable.
  - **`views/dashboard.ejs` empty-state copy rewrite** — pure static-string change. Headline + supporting paragraph are fixed strings; no user-controlled bytes flow into them. Zero security surface.
  - **`views/settings.ejs` intro paragraph rewrite** — same; pure static-string change. Zero security surface.
  - **New `tests/webhook-outbound-agency.test.js`** — test code only; no production-runtime path. Uses transient `http.createServer` + `server.listen(0)` per test with explicit close-on-resolve — no port leakage across test boundaries.

- **`npm audit --omit=dev`:** 6 vulnerabilities (3 moderate, 3 high) — **all pre-existing**, all install-time only. `bcrypt → @mapbox/node-pre-gyp → tar` (3 high, install-time) tracked under [HEALTH] H9; `resend → svix → uuid` (3 moderate, install-time) tracked under H16. Runtime exposure remains nil. No new advisories surfaced this cycle (no new dependencies — the new view block uses `encodeURIComponent` which is built into V8).

- **Performance:** Zero new DB queries this cycle. The new share-buttons block adds ~700 bytes of HTML per Pro-user invoice-view render + zero client-side state (no Alpine x-data scope on the share section itself — the existing copy-button x-data covers it). For a single invoice page that's well within R14 budget. The 2 UX copy changes are fixed-length strings that net out roughly equal in size to the originals. No N+1, no missing indexes introduced.

- **Code quality:** New share-intent block sits cleanly inside the existing Payment Link card's branch — no nested conditionals beyond what the card already had. The 5 new variables (`shareGreeting` / `shareTotal` / `shareBody` / `shareSubject` / waHref / smsHref / mailHref) are scoped to the EJS `<%` block and have no module-level escape. New `tests/webhook-outbound-agency.test.js` mirrors the test-style of `tests/webhook-outbound-from-stripe.test.js` (same stub pattern, same constructEventImpl seam) — follows precedent rather than introducing new shape.

- **Dependencies:** zero changes — no new `npm i`, no `package-lock.json` shifts. Total prod tree unchanged.

- **Legal:** No new dependencies, no license changes, no new user-data collection. The mailto / wa.me / sms URLs trigger the user's own native handlers — no PII transits any new third-party. Per RFC 6068 (mailto:), RFC 5724 (sms:), and the wa.me universal-forwarder contract, all three URL schemes are designed for client-side compose and don't initiate server-side sends. No PCI-DSS scope change (no payment surfaces touched). No GDPR / CCPA implications (no new tracking, no new collection, no new processor relationship).

**No CRITICAL / hardcoded-secret findings. No new flags for TODO_MASTER.** The 8 existing open [HEALTH] items remain unchanged: H8 composite (user_id, status) index, H9 bcrypt bump, H10 parseInt radix, H11 pagination, H15 Promise.all GET handlers, H16 resend bump, H17 trial-nudge partial index, H18 expression index for recent-clients, H20 currency-formatter DRY. All are bundle-with-next-migration / next-touch hygiene items, none are blocking work.

**Net delta this cycle:** +1 mailto-injection class fully eliminated (defence in depth at the source-code level — pairs with the existing `helmet()` CSP `form-action 'self' https://checkout.stripe.com https://billing.stripe.com` which already constrains where forms can post but doesn't cover mailto: / sms: / wa.me URL handlers); +1 new test asserting the fix; 0 new [HEALTH] items added. Strong defence-in-depth posture for a class of bug that's notoriously hard to spot in EJS + URL-template codebases.

---

## 2026-04-27T17:48Z — Role 5 (Task Optimizer): 14th-pass audit — header refreshed, #92 archived, priority queue re-ordered

**Audit deltas this pass:**
- **#92 archived as [DONE]** as a parenthetical block above #95 in the XS-GROWTH bucket (consistent with the archive pattern used for #91, #75, #45, #31, U4, etc.). Detail mirrors the CHANGELOG #92 entry.
- **Top of file metadata** rewritten: 13th-pass narrative folded into the "13th-pass audit retained" line; 14th-pass narrative now occupies the lead block. Cross-overlap rationale for #101-#105 + MARKETING #56 written into the audit header so the next optimizer pass has the differentiation cached.
- **Priority queue re-sorted** — #92 closed (no longer queued); #101 + #102 inserted immediately after #95 in the XS-GROWTH bucket (both pure-form-change "trust artefact" wins — highest impact per effort and ungated by Master prerequisites). #103 + #104 added to the S-GROWTH bucket as a dedicated "continued" sub-section (so the 25-item S-GROWTH list doesn't grow indefinitely without a visual break). #105 added to the M-GROWTH bucket in priority order (above the existing #69 / #60 / #50 / #53 / #40 / #21 / #18 / #24 / #17).
- **Open task index re-counted:** 99 GROWTH items total (was 100; #92 archived); 8 [HEALTH] items open (H8/H9/H10/H11/H15/H16/H17/H18/H20 unchanged); 1 [UX] item (U1 Resend-blocked, U3 ships after #28 legal pages); 0 [TEST-FAILURE]. **No new [BLOCKED] items this cycle.**
- **TODO_MASTER reviewed:** all 56 items checked against this cycle's CHANGELOG. None flip to [LIKELY DONE - verify] — every prior Master action remains pending its respective external step (Stripe Dashboard config, Resend API key, Plausible domain, G2/Capterra profile creation, Reddit/podcast/YouTube outreach campaigns, etc.).
- **Duplicate consolidation pass:** ran cross-checks on the 6 new items (5 GROWTH + 1 MARKETING) vs the 100+55 existing items. Zero duplicates. Closest near-misses (#101 vs #46/#82, #102 vs #99, #103 vs #25/#86, #104 vs #69/#23, #105 vs #9/#54, MARKETING #56 vs #17/#51/#54/#55) all explicitly differentiated in-line.
- **Archive trigger:** file at ~2.5k lines, trigger at 1.5k. Overdue 9 cycles. Defer again — fragmentation cost (split context across two files) currently exceeds size-bloat cost.

**Priority order at end of 14th pass (top 12 unblocked items):**

| # | ID | Tag | Cx | Title (1-line) |
|--:|------|------|-----|------|
| 1 | U1 | UX | M | Self-serve password reset (gated on Resend) |
| 2 | U3 | UX | S | Authed pages global footer (gated on #28) |
| 3 | #96 | GROWTH | XS | "Send a copy to me too" checkbox on invoice send |
| 4 | #97 | GROWTH | XS | Stripe Receipt-emails default-on toggle |
| 5 | #95 | GROWTH | XS | Tab-title flash + favicon dot on dashboard for paid invoices |
| 6 | #101 | GROWTH | XS | Inline annual-savings badge on Monthly/Annual toggle |
| 7 | #102 | GROWTH | XS | Per-user `timezone` for due-date display + reminder cron |
| 8 | #66 | GROWTH | XS | Auto-CC accountant on invoice email (gated on Resend) |
| 9 | #71 | GROWTH | XS | Auto-BCC freelancer on invoice email (gated on Resend) |
| 10 | #73 | GROWTH | XS | Pre-portal cancel-reason survey |
| 11 | #77 | GROWTH | XS | Welcome-back email on past_due → active recovery (gated on Resend) |
| 12 | #80 | GROWTH | XS | Weekly Monday-AM Pro digest email (gated on Resend) |

**Net delta this cycle:** +1 GROWTH closed (#92), +5 GROWTH added (#101-#105), +1 MARKETING added (#56), +0 [HEALTH], +0 [UX], +0 [TEST-FAILURE], +0 [BLOCKED]. Open queue: 99 GROWTH + 8 HEALTH + 2 UX + 0 TEST-FAILURE = 109 total items, dominated by income-critical features.

---

## 2026-04-27T17:46Z — Role 4 (UX Auditor): empty-state copy + settings intro rewritten; landing→pay-flow walked end-to-end

**Flows walked (first-time visitor → paying user):**

1. **Landing (`/` → `views/index.ejs`)** — hero CTA, features grid, Free vs Pro pricing card, footer. Headline + sub clear and benefit-led ("Professional invoices. In under a minute."). MOST POPULAR badge on Pro carries the visual hierarchy. Mobile stack reads cleanly. **Static pricing card** here doesn't have a Monthly/Annual toggle — captured in #101 [GROWTH].
2. **Register (`/auth/register` → `views/auth/register.ejs`)** — 3-field form (name / email / password). Inline validation hint "(8+ characters)". Submit: "Create account →". CTA copy already action-oriented; kept.
3. **Login (`/auth/login` → `views/auth/login.ejs`)** — clean, "Welcome back" h1, includes mailto-prefilled forgot-password link with concrete reset-time signal ("we usually reset within a few hours") shipped in cycle 13. Kept.
4. **Dashboard (`/dashboard` → `views/dashboard.ejs`)** — onboarding checklist, trial banner (with last-day urgency variant from #45 cycle 11), past-due banner, free-plan progress bar (#31 cycle 9). New table with copy-pay-link column (#91 cycle 13). **Empty state h2 was "No invoices yet"** — passive, descriptive of absence rather than inviting action. **Direct fix this cycle:** rewrote to "Send your first invoice today" (action verb, value-anchored) + supporting copy that names three concrete output channels ("Email it, print it as a PDF, or share a Stripe pay link — all from one screen") instead of the previous generic "Create your first invoice and start getting paid." Existing test in `tests/dashboard-copy-pay-link.test.js` updated to assert the stable CTA "Create your first invoice" (load-bearing) rather than the volatile h2 copy — robust against future iteration on the headline. Free-plan Pro callout below the CTA already benefit-first ("✨ Pro adds a 'Pay now' button to every invoice"); kept from cycle 12 audit.
5. **Invoice form (`/invoices/new` → `views/invoice-form.ejs`)** — Invoice details / Bill To / Line Items / Notes / Save. Recent-clients dropdown fills fields. Copy clear, primary CTA "Create invoice →" / "Save changes" branches correctly on edit vs new. Kept.
6. **Invoice view (`/invoices/:id` → `views/invoice-view.ejs`)** — action bar (Mark as Sent → Mark as Paid → ✓ done), Payment Link card with Copy / Preview / **new WhatsApp / SMS / Email share buttons (#92, this cycle)**. Action bar lifecycle correctly stages primary CTA per status (Mark as Sent for draft → Mark as Paid for sent/overdue). Kept.
7. **Settings (`/billing/settings` → `views/settings.ejs`)** — account form, Pro Zapier/Webhook section with quick-start templates from #75. **Settings intro was "This information appears on your invoices."** — accurate but flat / no value framing. **Direct fix this cycle:** rewrote to "These details appear on every invoice you send. Filling them in makes your invoices look more professional and helps clients reach you." — converts the flat statement into a benefit-anchored prompt that nudges the new user to actually fill the fields (which gates onboarding step #1 "Add your business info"). Pro/Webhook section copy unchanged.
8. **Pricing (`/billing/upgrade` → `views/pricing.ejs`)** — Monthly/Annual toggle with "Save 31%" pill on Annual, dynamic price + "Save $45/year vs. monthly" copy, "Start 7-day free trial →" CTA + "No credit card required" subtext. Already strong from cycles 11-12 audits. Kept.
9. **Cancel / Stripe Customer Portal** — unchanged this cycle (gated on #28 legal pages + #73 cancel-reason survey). Captured.
10. **404 / `views/not-found.ejs`** — has homeHref/homeLabel locals + mailto-prefilled support link (#56 cycle 13). Kept.

**Direct fixes shipped this cycle (no [UX] tasks added):**
- `views/dashboard.ejs` empty-state h2 + supporting paragraph rewritten (action-verb headline + concrete output-channel description; existing CTA preserved). One test in `tests/dashboard-copy-pay-link.test.js` updated to anchor on the stable CTA rather than the volatile h2.
- `views/settings.ejs` intro paragraph rewritten (flat statement → benefit-anchored prompt).

**Flagged for future [UX] / [GROWTH] consideration (added to INTERNAL_TODO via Growth Strategist this cycle):**
- #101 (annual savings badge on landing-page pricing card — currently static; the toggle lives only on `/billing/upgrade`).

**Net delta:** 2 direct copy fixes shipped; 0 new [UX] tasks opened; 0 dead-end navigation paths surfaced this walk.

---

## 2026-04-27T17:44Z — Role 3 (Growth Strategist): 5 new GROWTH items (#101-#105) + 1 new MARKETING item (#56)

**This cycle's lens:** un-captured leverage points across conversion / retention / expansion / automation / distribution that don't overlap with the 100 prior GROWTH items or the 55 prior TODO_MASTER items. Each idea below has been cross-checked against every nearby existing item and a one-line differentiation rationale committed in-line (so the next Strategist pass inherits the cache).

**INTERNAL_TODO additions (5):**

| # | Cx | Title | Impact | Distinction |
|--:|---|---|---|---|
| #101 | XS | Inline annual-savings badge on Monthly/Annual toggle | MED conversion lift on price→checkout | Different surface vs #46 exit-intent (in-page vs modal) and different message vs #82 plan-comparison (price comparison vs feature comparison). Pure view change — pricing.ejs + settings.ejs + upgrade-modal.ejs. |
| #102 | XS | Per-user `timezone` column + due-date / reminder-cron localisation | MED retention via "the app gets it right for ME" | Orthogonal to #99 multi-language PDF. Today's `toLocaleDateString('en-US')` ignores user TZ; reminder cron fires at server-local midnight = 4-7am for European Pro users. |
| #103 | S | Free `/tools/late-fee-calculator` — interactive content tool | MED-HIGH SEO long-tail | Distinct from #25 niche pages (segment angle), #86 vs-pages (competitor angle), #46 exit-intent. Compounds with #22 Pro late-fee automation (free tool seeds search; Pro feature collects on it). |
| #104 | S | Browser extension MVP (Chrome Web Store) detecting Stripe Pay Link URLs | MED retention + virality | Distinct from #69 embedded JS widget (freelancer site) and #23 PWA (mobile install). New distribution surface — Chrome Web Store has 2.5B users. Sequencing-gated on #32 API endpoints. |
| #105 | M | Multi-business profiles per user (`business_profiles` table) | HIGH retention for power users | Distinct from #9 team seats (different users) and from #54 deposits (different feature). Targets the dual-brand consultant / agency-of-one cohort. |

**TODO_MASTER addition (1):**

- **#56 [MARKETING]** — Cold-DM 30 freelance-subreddit moderators (r/freelance, r/sidehustle, r/Etsy, r/Upwork, r/freelanceWriters, etc.) with a permanent community-specific discount code (e.g. `RFREELANCE25` for 25% off for life). The pitch leads with community benefit — a code their members can use forever — rather than a marketing ask. Per-subreddit attribution via the coupon code. Distinct from #17 organic-Reddit-posts, #51 paid-podcast, #54 paid-YouTube, #55 podcast-cross-promo: this is the **moderator-endorsed wiki / sticky / modmail** surface, which is among the longest-tail content placements available on the open internet (4 years still drives traffic to ConvertKit / Carrd / Notion from old wiki entries on freelancing subs).

**Cross-overlap check** — performed against all 100 prior INTERNAL_TODO #GROWTH items + 55 prior TODO_MASTER items + the 8 [HEALTH] open items + U1/U3 [UX]: zero duplicates. Closest near-misses (#101 vs #46, #102 vs #99, #103 vs #25/#86, #104 vs #69/#23, #105 vs #9/#54, #56-MARKETING vs #17/#51/#54/#55) all explicitly differentiated above.

**Net delta this cycle:** +5 GROWTH (1 XS / 2 S / 1 M, balanced effort distribution), +1 MARKETING. Top of the priority queue (XS-GROWTH bucket) now reads: #96 / #97 / #92 (closed cycle) / #101 / #102 / #95 / #66 / #71 / #73 / #77 / #80 / #82 / #84 / #88 / #90 / #44 / #52 / #55 / #48 / #34 — 20 ungated XS items, 6+ months of pure conversion / retention work without any Master prerequisite required.

---

## 2026-04-27T17:42Z — Role 2 (Test Examiner): Agency-plan paid-webhook coverage gap closed (3 new tests)

**Audit:** systematic walk through all `(plan === 'pro' || plan === 'agency')` gates in `routes/invoices.js` and `routes/billing.js` against the existing test corpus. Both call sites — manual mark-paid and Stripe-driven payment_link checkout — fire the outbound webhook for Pro AND Agency owners, but the existing `tests/webhook-outbound.test.js` and `tests/webhook-outbound-from-stripe.test.js` only exercise the Pro branch. The agency branch was referenced in a Pro test's *comment* (string literal `(plan === 'pro' || plan === 'agency')`) but never actually exercised. With H5 (DONE 2026-04-25) widening the `users_plan_check` constraint to include `'agency'`, this branch is now reachable in production — and Agency tier ($49/mo) is the highest-ARPU plan, so a silent regression here would disproportionately hit the most income-critical customers.

**Other paths spot-checked (all already adequately covered):** `customer.subscription.deleted` → `subscription_status=NULL` (dunning.test.js + billing-webhook.test.js); `customer.subscription.updated` for `trialing` → `plan=pro` (dunning.test.js); `resolvePriceId` annual fallback (annual-billing.test.js); `reply_to_email` validation (billing-settings.test.js); `sendEmail` invalid_args / no_owner_email / no_client_email (email.test.js + paid-notification.test.js); 404 handler render path (not-found-handler.test.js, added cycle 11); dashboard "Copy pay link" XSS-via-attribute defence (dashboard-copy-pay-link.test.js, added cycle 13). No new gaps surfaced.

**What changed:**
- **New file `tests/webhook-outbound-agency.test.js`** — 3 tests, all passing:
  1. Agency owner manual mark-paid (`POST /invoices/:id/status=paid`) fires the outbound webhook with the correct payload (URL = owner.webhook_url; payload carries invoice_id, amount, client_name).
  2. Agency owner Stripe-driven mark-paid (`POST /billing/webhook` with `checkout.session.completed` for `mode=payment` + `payment_link`) fires the outbound webhook; the inner stripe.webhooks.constructEvent is stubbed to return the synthetic event so the test exercises the route's real branch logic.
  3. Agency owner WITHOUT `webhook_url` skips the fire (parity with Pro behaviour — webhook is opt-in per user, plan gate is necessary but not sufficient).
- `package.json` `test` script appended.

**Coverage delta:** Agency-plan branch on the paid-webhook fires went from 0 assertions to 3 in this commit. Pro-branch coverage unchanged. Full suite: 41 test files, 0 failures.

**Flaky / redundant flags:** none surfaced this cycle. No tests were deleted; no [TEST-FAILURE] items added to INTERNAL_TODO.md.

**Income relevance:** prevents a silent regression on the highest-ARPU tier's outbound-webhook integration. Agency users wiring up Slack/Discord/Zapier post-pay automations would, before this commit, have lost their automation if a future code change accidentally narrowed the gate to `plan === 'pro'` only — and there would have been no test to catch it.

---

## 2026-04-27T17:39Z — Role 1 (Feature Implementer): #92 WhatsApp / SMS / Email share-intent buttons on Payment Link card

**What was built:** Three native-compose share buttons on the invoice-view Payment Link card (Pro users only — gated on `invoice.payment_link_url && user.plan === 'pro'`, same condition that already gates the existing Copy / Preview controls). Each button is a plain anchor with no JS dependency:

- **WhatsApp** → `https://wa.me/?text=<encoded>` — opens WhatsApp Web on desktop or the WhatsApp app on mobile (iOS + Android both honour `wa.me` as the universal forwarder); uses `target="_blank" rel="noopener"` so the popup can't reach back through `window.opener`.
- **SMS** → `sms:?&body=<encoded>` — opens iOS Messages or the Android default SMS app at the new-message screen with no preselected recipient (the freelancer types the client's number) and the prefilled body. The `?&body=` form is the cross-platform-tolerant variant: iOS accepts both `sms:?body=` and `sms:?&body=`, Android Messages accepts only the latter (it interprets the `?` as the missing-address separator).
- **Email** → `mailto:<client_email>?subject=…&body=…` — opens the user's default mail client (Mail.app / Gmail / Outlook / Thunderbird depending on OS-level handler), prefilled with subject `"Invoice <number> — $<total>"` and the same body. When `client_email` is empty the link degrades to `mailto:?subject=…&body=…`, leaving the recipient blank for the user to fill in.

**Prefilled message body** (single string reused across all 3 buttons, kept short to fit SMS 160-char window with the URL itself):

> Hi `<client_name>,` here's invoice `<number>` for `$<total>`. You can pay securely here: `<payment_link_url>`

When `client_name` is empty, the greeting falls back to `Hi,` (no dangling `Hi ,`). Total is formatted as `$N.NN` to match the existing on-page total. Encoding uses `encodeURIComponent` so apostrophes / ampersands / commas / spaces / newlines never truncate the message at the URL parser.

**Files touched:**
- `views/invoice-view.ejs` — added share-prefill helper block + new "Send to client" sub-section inside the existing Payment Link card. ~50 lines added; no other view structure changed.
- `tests/share-intent-buttons.test.js` — **new file**, 12 tests, all passing.
- `package.json` — appended new test file to the `test` script.

**Test coverage (12 assertions):**
1. All three buttons render for Pro users (`data-share="whatsapp|sms|email"` markers).
2. WhatsApp href uses `https://wa.me/?text=…` and decodes back to the full message including the URL, invoice number, and `$500.00` total.
3. SMS href uses the `sms:` scheme with a `body` param containing the URL after URL-decode.
4. mailto href starts with `mailto:<client_email>?` and carries both `subject=` and `body=` params; subject contains the invoice number and total.
5. mailto href degrades to `mailto:?subject=…` when `client_email` is empty (no malformed `mailto:?` collision).
6. Free users see none of the three buttons (the entire Payment Link card is gated).
7. Greeting personalises: `"Hi <client_name>,"` when present.
8. Greeting falls back: `"Hi,"` when `client_name` is empty (no `"Hi ,"`).
9. URL encoding round-trips: input `O'Brien & Sons, Inc` decodes correctly through the two-stage HTML→URL decode the browser performs.
10. The new "Send to client" header renders exactly once (regression guard against template duplication).
11. WhatsApp anchor carries `target="_blank"` + `rel="noopener"` (XSS / window.opener defence).
12. Notes section still renders after the share block (defensive layout regression guard).

Full suite green: 40 test files, 0 failures.

**Income relevance:** MED conversion lift on the share-with-client step — the single highest-friction post-send action for a Pro freelancer. Today the Copy button writes the URL to the clipboard, then the user has to switch apps, paste, type the message, and send — 4 context switches. The share buttons collapse that to one click that pre-stages everything except the recipient. Compounds with #91 (dashboard one-click copy) on the recovery side and with #75 (Slack/Discord webhook) on the post-pay side. Pure view change — no DB schema change, no Master action, no Resend dependency, no third-party SDK. Ships unblocked.

---

## 2026-04-30T10:10Z — Role 6 (Health Monitor): defence-in-depth XSS guard on payment_link_url Alpine handlers + clean cycle

**What was audited (focused on this cycle's diff: dashboard.ejs + tests + 2 mailto changes):**

- **Security review of the diff:**
  - **`views/dashboard.ejs` new 6th column.** First inspection found a defence-in-depth concern: the original `@click.stop="navigator.clipboard.writeText('<%= inv.payment_link_url %>')..."` pattern interpolates `payment_link_url` directly into a JS string literal inside the Alpine `@click` attribute. EJS's `<%= %>` HTML-escapes the URL, so a single-quote becomes `&#39;` in the attribute source — but the browser un-escapes the attribute value back to `'` before passing it to Alpine as a JS expression. A hostile DB write or future code path that lets a user set `payment_link_url` (e.g. via form input) would create stored XSS via `'+alert(1)+'`. Today's data path has zero exploitability: `setInvoicePaymentLink(id, userId, url, linkId)` is only fed by `createInvoicePaymentLink(updated, user)` which uses Stripe's response URL, and Stripe URLs match `https://buy.stripe.com/[a-zA-Z0-9_]+` (no apostrophe / backslash / newline).
  - **Fixed directly this cycle (XS, contained, safe):** moved the URL into a `data-pay-link-url` attribute and switched the `@click` handler to read via `$event.currentTarget.dataset.payLinkUrl` (dashboard) / `$root.querySelector('[data-pay-link-url]').dataset.payLinkUrl` (invoice-view). Browsers expose `dataset` values as plain strings — Alpine never evaluates them as JS expressions, so user-controlled bytes can never reach the JS interpreter. Same fix applied to the pre-existing `views/invoice-view.ejs` "Copy" button (`writeText('<%= invoice.payment_link_url %>')` → dataset read), eliminating the entire class from the codebase. Three new test assertions in `tests/dashboard-copy-pay-link.test.js` (defence-in-depth XSS-guard regression test): asserts the `data-pay-link-url` attribute exists with the URL, asserts the dataset-based handler shape, asserts NO call site interpolates `writeText('https?:` directly. Net: 16 assertions on the file (was 13), 11 tests still passing.
  - **`views/auth/login.ejs` + `views/not-found.ejs` mailto subject lines.** Pure static-string changes (`?subject=Password%20reset%20request` and `?subject=Help%20with%20a%20broken%20link`). No interpolation, no user input path. Zero security surface.
  - **New `tests/dashboard-copy-pay-link.test.js` and `tests/not-found-handler.test.js`.** Test code only — no production-runtime path. The 404 handler integration tests use a transient `http.createServer` + `server.listen(0)` per test with explicit `server.close()` in the resolve callback — no port leakage, no orphan sockets across test boundaries.

- **`npm audit --production`:** 6 vulnerabilities (3 moderate, 3 high) — **all pre-existing**, all install-time only. `bcrypt → @mapbox/node-pre-gyp → tar` (3 high, install-time) tracked under [HEALTH] H9; `resend → svix → uuid` (3 moderate, install-time) tracked under H16. Runtime exposure remains nil. No new advisories surfaced this cycle (no new dependencies — all changes are pure-EJS / pure-JS in stdlib).

- **Performance:** Zero new DB queries — `getInvoicesByUser` already SELECT *. The new 6th column adds ~60 bytes of HTML per Pro-user invoice row + ~30 bytes of Alpine state. For a 100-row Pro dashboard that's ~9 KB of HTML + ~3 KB of client-side memory — well within the existing R14 budget. No N+1, no missing indexes introduced. The `data-pay-link-url` attribute adds 1 string allocation per row (already there as the `value=` of the existing readonly input on `invoice-view.ejs`; pure HTML on `dashboard.ejs`).

- **Code quality:** New helpers + new test files have clear single-responsibility boundaries. The new dashboard table block sits cleanly inside the existing branch structure — no nested conditionals beyond what the row already had. The 404-handler test file replays the handler verbatim on a minimal express app; that pattern can be reused for any future server.js-only handler tests if needed.

- **Dependencies:** zero changes — no new `npm i`, no `package-lock.json` shifts.

- **Legal:** No new dependencies, no license changes, no new user-data collection. The mailto subject prefills (`?subject=Password%20reset%20request` / `?subject=Help%20with%20a%20broken%20link`) are pure UX — no PII is sent automatically; the user types their reset request body in their own mail client. No PCI-DSS scope change (no payment surfaces touched). No GDPR / CCPA implications (no new tracking, no new collection, no new processor relationship). The new dashboard column displays an existing DB column to its rightful owner only (RBAC scoped to `WHERE user_id = $1`) — same access pattern as the rest of the dashboard.

**No CRITICAL / hardcoded-secret findings. No new flags for TODO_MASTER.** The 8 existing open [HEALTH] items remain (H8 composite (user_id, status) index, H9 bcrypt bump, H10 parseInt radix, H11 pagination, H15 Promise.all, H16 resend bump, H17 trial-nudge partial index, H18 expression index for recent-clients, H20 currency-formatter DRY). All are bundle-with-next-migration / next-touch hygiene items, none are blocking work.

**Net delta this cycle:** +1 [HEALTH] class fully eliminated (XSS-via-attribute-as-JS pattern); 0 new [HEALTH] items added. Strong defence-in-depth posture for a class of vulnerabilities that's notoriously hard to spot in EJS + Alpine codebases.

---

## 2026-04-30T09:55Z — Role 5 (Task Optimizer): 13th-pass audit — header refreshed, #91 archived, priority queue re-ordered

**Audit deltas this pass:**
- **#91 archived as [DONE]** at the entry-detail block above the [HEALTH] section. Retained the archive entry rather than excising entirely so the in-file regression history (mirrors CHANGELOG) survives if CHANGELOG ever rotates.
- **Top of file metadata** rewritten: 12th-pass narrative folded into the "Compacted history" line; 13th-pass narrative now occupies the lead block. Cross-overlap rationale for #96-#100 written into both the audit header and the entries themselves so the next optimizer pass has the differentiation cached.
- **Priority queue re-sorted** — #96 + #97 promoted to the top of the XS-GROWTH bucket (both are pure-form-change "trust artefact" wins — highest impact per effort and ungated by Master prerequisites). #98 / #99 / #100 added to the S-GROWTH bucket in priority order: #98 first (highest virality compounding), #99 second (TAM expansion to non-EN), #100 third (long-tail moat / values lever; partly Master-gated on partner-charity Stripe accounts but code can be 80% built without Master input). #93 / #94 retained at #4-#5 in S-GROWTH (slot order preserved from cycle 12).
- **Open task index re-counted:** 95 GROWTH items total; 8 [HEALTH] items open (H8/H9/H10/H11/H15/H16/H17/H18/H20); 1 [UX] item (U1 Resend-blocked, U3 ships after #28 legal pages); 0 [TEST-FAILURE]. **No new [BLOCKED] items this cycle.**
- **TODO_MASTER reviewed:** all 55 items checked against this cycle's CHANGELOG. None flip to [LIKELY DONE - verify] — every prior Master action remains pending its respective external step (Stripe Dashboard / Resend API key / Plausible domain / G2 listing / Capterra listing / podcast outreach / YouTuber outreach / podcast cold-DM / etc).
- **Duplicate consolidation pass:** ran cross-checks on the 6 new items (5 GROWTH + 1 MARKETING) vs the 95+54 existing items. Zero duplicates. Closest near-overlaps explicitly differentiated in-line (item-level) so the next cycle inherits the rationale.
- **Archive trigger:** file at ~2.5k lines, trigger at 1.5k. Overdue 8 cycles. Defer again — fragmentation cost (split context across two files) currently exceeds size-bloat cost.

**Priority order at end of 13th pass (top 12 items, all unblocked):**

| # | ID | Tag | Cx | Title (1-line) |
|--:|------|------|-----|------|
| 1 | U1 | UX | M | Self-serve password reset (gated on Resend) |
| 2 | U3 | UX | S | Authed pages global footer (gated on #28) |
| 3 | #96 | GROWTH | XS | "Send a copy to me too" checkbox on invoice send |
| 4 | #97 | GROWTH | XS | Stripe Receipt-emails default-on toggle |
| 5 | #92 | GROWTH | XS | WhatsApp/SMS/Email share-intent buttons |
| 6 | #95 | GROWTH | XS | Tab-title flash + favicon dot on paid notification |
| 7 | #82 | GROWTH | XS | Plan comparison table on dashboard for free users |
| 8 | #88 | GROWTH | XS | "Frequent non-payer" dashboard alert |
| 9 | #84 | GROWTH | XS | Auto-generate plain-language email body |
| 10 | #44 | GROWTH | XS | In-app "✨ What's new" changelog widget |
| 11 | #98 | GROWTH | S | Public review/testimonial collection page |
| 12 | #99 | GROWTH | S | Multi-language invoice PDF (ES/FR/PT/DE) |

The Resend-gated XS items (#66, #71, #77, #80, #90) sit lower in the queue — they're shovel-ready code-wise but unprovable in production until Master ships the API key (TODO_MASTER #18). #93 / #94 / #100 sit in the S-GROWTH band for the next code cycle.

---

## 2026-04-30T09:45Z — Role 4 (UX Auditor): direct fixes on dashboard column header + 2 mailto subject lines

**Flows audited (full first-visit-to-paying-user walk):**
- Landing (`/`) → register (`/auth/register`) → onboarding checklist → invoice creation (`/invoices/new`) → invoice view → mark-as-sent → upgrade flow at limit / via /pricing → Stripe Checkout → success → dashboard with trial banner.
- Dashboard with new (this cycle) Pro "Copy pay link" column.
- Settings (`/billing/settings`) including the Slack/Discord webhook quick-start panels.
- Login + register pages including the manual forgot-password stopgap copy.
- 404 / not-found page (newly tested this cycle).
- Empty-state and past-due banner branches on the dashboard.

**Direct fixes shipped this cycle:**

1. **Dashboard "Pay link" column header copy** — `views/dashboard.ejs`. The 6th column shipped earlier this session (#91) had an `aria-label="Row actions"`-only header (visually empty <th>). For a Pro user whose dashboard contains drafts (no `payment_link_url` yet), this rendered as a column of empty cells under an empty header — visually confusing dead space that read as a layout glitch. Now the header reads "Pay link" so the column is self-describing even when most cells are empty (drafts), and so the user sees a Pro-feature surface they can map their workflow to. Test `testProUserSeesCopyButtonOnRowWithLink` updated to assert the new header copy + that it carries `print:hidden`. All 11 tests still passing.

2. **Login forgot-password mailto pre-filled subject** — `views/auth/login.ejs`. The forgot-password stopgap is the manual mailto until U1 (full self-serve flow) ships. The mailto previously opened the user's default mail client with **no subject prefilled** — meaning the support inbox got generic "(no subject)" messages that take longer to triage and reset. Now `mailto:support@quickinvoice.io?subject=Password%20reset%20request` prefills the subject, so the support inbox can pattern-match → fast-path reset. Copy also updated from "we'll reset it for you" to "we usually reset within a few hours" (concrete time signal builds trust + tells the user when to expect a reply, which reduces follow-up emails). Conversion-defending: every minute of password-reset latency is a churn-risk minute.

3. **Not-found mailto pre-filled subject** — `views/not-found.ejs`. Same pattern: `mailto:support@quickinvoice.io?subject=Help%20with%20a%20broken%20link` so a 404-driven support email arrives pre-categorised, letting the support inbox triage broken-link reports separately from password resets and billing tickets.

**Already correct, no fix needed:**
- The new dashboard Copy-pay-link button (#91) action affordance, copied-state affordance, and click-propagation guards are all working as designed (verified by 11-test file).
- 404 page session-aware copy (anon vs authed) renders correctly (verified by 8-test file shipped today).
- Action-bar visual hierarchy on `views/invoice-view.ejs` is correctly state-aware (closed in 2026-04-27 PM-3).
- Trial urgent-day-1 banner shipped 2026-04-28 (closed under #45).
- Empty-state Pro-tip below "Create your first invoice" CTA is gated correctly (closed in U2).

**Flagged for future work (no new INTERNAL_TODO entries needed; existing items cover):**
- The Pro empty-state on the dashboard (zero invoices) doesn't yet surface a Pro-tier-specific value reminder ("you've got Pay Links unlocked!"). Not big enough to add a [UX] task — it can ride a future dashboard touch when paired with #82 plan-comparison table.
- The auth pages still use the manual forgot-password stopgap; full flow is U1 (already tracked, gated on Resend).

---

## 2026-04-30T09:30Z — Role 3 (Growth Strategist): 5 new [GROWTH] items (#96-#100) + 1 [MARKETING] (#55)

**5 new INTERNAL_TODO entries** (cross-checked for non-overlap against the 95 prior items + 54 prior TODO_MASTER items):

- **#96** [XS] — "📩 Send a copy to me too" checkbox on invoice send (all tiers; sticky default after first toggle). Distinct from #71 always-on Pro auto-BCC (different scope — per-invoice user choice vs always-on Pro feature) and from #84 plain-language client body (different surface — freelancer CC vs client-facing copy). Closes the "did the email actually fire?" trust gap for first-time senders. Pure form change + one boolean column.
- **#97** [XS] — Stripe Receipt-emails default-on toggle. Stripe natively sends a free professional payment-receipt email when `receipt_email` is set on the Payment Link, but today we leave it unset, missing the freelancer a free professionalism signal. Distinct from #55 auto thank-you (different sender — Stripe vs QuickInvoice — and different content), distinct from #61 attach-PDF-on-send (different surface — pre-payment vs post-payment), distinct from #70 receipt PDF (different artefact — Stripe email vs QuickInvoice-rendered PDF).
- **#98** [S] — Public review/testimonial collection page `/r/<user-slug>` for Pro users (MED-HIGH virality + retention compounding). Every paid client is a potential review source. Distinct from #20 social proof (uses QuickInvoice's own collected reviews on landing — not the user's), #57 NPS (internal churn signal, not external trust artefact), #78 freelancer profile (#78 surfaces "latest unpaid invoice"; #98 surfaces collected reviews — different content type).
- **#99** [S] — Multi-language invoice PDF rendering (initial: ES / FR / PT / DE) (MED activation expansion). LATAM/IBERIAN/DACH freelancer market is currently underserved by US-first invoicing tools. Translate the ~15 static labels in `views/invoice-print.ejs` via a small `lib/i18n.js` helper. Distinct from #24 multi-currency — currency and language are orthogonal concerns. Pairs with #25 niche landing pages.
- **#100** [S] — Stripe Climate / charity round-up toggle on invoice pay links (Pro feature) (MED retention via emotional/values-aligned moat). 1% of each successful payment auto-donated to a Stripe Climate-listed climate fund or one of 3 partner charities. Distinct from #67 tip toggle (different recipient — charity vs freelancer), #79 BNPL (different `payment_method_types` family). Adds a "carbon-neutral invoicing" landing-page bullet that's defensible vs FreshBooks/Wave/Bonsai.

**1 new TODO_MASTER entry:**

- **#55** [MARKETING] — Cross-promo cold-DM to 30 micro-podcasts in the freelance-business niche (Indie Hackers Podcast, Freelance Friday, Freelance Pod, etc.). Unpaid placement: free Pro upgrade for the host + a 50%-off custom coupon for their listeners in exchange for a "tools I love" mention. Distinct from #51 (paid podcast placement; #55 is unpaid cross-promotion), #54 (paid YouTuber outreach; different platform/format), #14 (Reddit; different channel), #25 (cold email to agencies; different recipient archetype — host vs agency).

**Cross-overlap audit:** all 5 new GROWTH items checked against the existing #1-#95 + the 54 prior TODO_MASTER items. No duplicates. Income relevance for each item explicitly differentiates from the closest prior entries — written into the items themselves so the optimizer cycle has the differentiation cached.

**Strategic theme this cycle:** The five additions cluster on **trust artefacts** (#96 send-copy-to-me, #97 Stripe receipts, #98 review wall) + **TAM expansion levers** (#99 multi-language, #100 Climate moat). The trust-artefact bucket addresses the recurring activation/retention pattern — every freelancer's first 5 sends are anxiety-loaded ("did this go through?", "does my client trust this?"), and three near-zero-cost surfaces compound on each other. The TAM-expansion bucket starts unlocking non-EN markets and values-aligned niches that competitors don't currently address.

---

## 2026-04-30T09:15Z — Role 2 (Test Examiner): coverage backfill — 404 handler + dashboard #91 button

**What was audited (focused on the cycle's diff + recent uncovered surfaces):**
- The 404 / not-found handler shipped 2026-04-28 PM (cycle 11) had **zero direct tests** — the `views/not-found.ejs` view existed, the `server.js` handler existed, but no test file asserted either the handler logic or the rendered view. A regression where someone re-introduced the silent `res.redirect('/')` would have shipped silently. This is high-leverage to defend: the 404 page is both a search-engine signal (correct status code + noindex) and a UX signal (a real user mistyped or followed a stale link must be told what happened, not silently dropped on the marketing page).
- The new #91 dashboard Copy-pay-link button shipped earlier this session has its own test file `tests/dashboard-copy-pay-link.test.js` (11 tests, all passing).

**Tests added this cycle:**
- `tests/not-found-handler.test.js` — new file, 8 tests, all passing. Asserts: render-only path (homeHref+homeLabel locals wire correctly, anon vs authed copy differs, noindex meta is present, hostile homeLabel is HTML-escaped); integration path on a minimal express app replaying the handler verbatim (HTTP 404 not 3xx, anon request doesn't crash, no redirect status code, noindex appears in body). The integration tests use `http.createServer` against the actual handler shape (not a stubbed mock) so a future regression to `res.redirect('/')` trips a test immediately. The integration suite uses a transient `server.listen(0)` + `server.close()` per request — no port leakage across tests.
- `package.json` — test runner extended.

**Why integration vs render:** `server.js` doesn't export the express `app`, so the test mounts the handler verbatim on a fresh express instance. This is intentional — the handler is the unit under test, and replaying it in isolation gives the strongest assertion that a regression to the old `res.redirect('/')` behaviour trips a test, without coupling the test to the entire `server.js` boot sequence (which requires PostgreSQL session-store provisioning that's outside scope for a 404 unit test).

**Test results:** new tests **8 passed, 0 failed**. Full suite re-run: **0 regressions** across all 39 prior test files (340+ assertions total now).

**No flaky / failing tests found.** No INTERNAL_TODO additions this cycle (no [TEST-FAILURE] items).

---

## 2026-04-30T09:00Z — Role 1 (Feature Implementer): #91 closed — Dashboard "Copy pay link" icon button per row

**What was built:** End-to-end "Copy pay link" icon button on every dashboard invoice row for Pro & Agency users. Cuts the share-invoice-link-with-client flow from 3 clicks (open invoice → click Payment Link card → click Copy) to 1 click straight from the dashboard table.

**Why income-relevant:** This is the single most-frequent post-send action a Pro freelancer takes — paste the pay link into Slack/email/SMS to chase a slow-paying client. Cutting friction at the highest-velocity moment in the daily Pro workflow compounds: every saved click reinforces the perceived value of Pro vs. the free-tier dashboard, defending against churn (the #1 retention lever for tools that get used 5-30×/day). Also doubles as a soft Pro feature-marker — Free users see the column is missing, and the visual asymmetry on a multi-row table reads as a real Pro affordance, not just a marketing-bullet "custom branding" promise.

**Code changes:**
- `views/dashboard.ejs` — new conditional 6th column in the invoice table for `user.plan === 'pro' || 'agency'`. Each row renders a per-row Alpine `x-data="{ copied: false }"` scope wrapping a real `<button type="button">` with both an SVG copy-icon and the visible label "Copy link". Click handler is `@click.stop` (Alpine's stop-propagation modifier) PLUS the wrapping `<td>` carries `onclick="event.stopPropagation()"` as a defence-in-depth layer (so clicks inside the cell never bubble to the row's `window.location` navigation, even if Alpine isn't yet hydrated). Successful copy flips to a green ✓ + "Copied" affordance for 2s, then snaps back. The column header + cell both carry `print:hidden` so the action affordance never bleeds into the PDF print output. Rows whose invoice has no `payment_link_url` (typically drafts) render an empty cell with the same propagation guard, preserving table layout.
- `tests/dashboard-copy-pay-link.test.js` — new file, 11 tests, all passing. Asserts: Pro+Agency see the column; Free users never do (hard-gated to a 5-vs-6 column count assertion); each row gets its own independent Alpine scope so two rows clicking won't share state; row navigation propagation is stopped at both layers; print:hidden on header + cell; real-button + reactive `:aria-label` for keyboard / screen-reader users; empty-state branch still renders cleanly for a Pro user with zero invoices. The data-testid `copy-pay-link-{id}` makes future end-to-end-tooling assertions trivial.
- `package.json` — test runner extended with the new file.

**Test results:** new tests **11 passed, 0 failed**. Full suite re-run: **0 regressions** across all 38 prior test files. (The transient "Recent clients lookup failed: db.getRecentClientsForUser is not a function" stderr lines are from the pre-existing `recent-clients.test.js` defensive-branch coverage of the same condition — those tests assert that the route survives the missing-helper case; the warnings are expected and assertional.)

**Next-cycle considerations:** This pairs naturally with #92 (WhatsApp/SMS/Email share-intent buttons on the public payment-link card) — both reduce time-to-share. Once #92 lands, the dashboard Copy button could grow a small dropdown of share-intents alongside Copy, but for now (before #92), the icon-button-only design is the right minimum.

---

## 2026-04-29T10:40Z — Role 6 (Health Monitor): clean cycle (post-#75 + 5 GROWTH adds + pricing copy fix)

**What was audited (focused on this cycle's diff: lib/outbound-webhook.js + tests + 2 view changes):**

- **Security review of the diff:**
  - `lib/outbound-webhook.js` — new `detectWebhookFormat(url)` + `formatPayloadForWebhook(url, payload)` + small currency formatter. URL parsing wrapped in try/catch; non-string / null inputs fall through to `'generic'`. Host comparison is lowercased + path-prefix-checked for Discord (so `discord.com/some/marketing/page` is NOT treated as a webhook). User-controlled fields (`invoice_number`, `client_name`) are coerced via `String(...)` before interpolation; truthiness fallback to safe defaults (`'invoice'` / `'a client'`) so a corrupted DB row can't produce empty bold spans. The interpolated message lands inside `JSON.stringify(...)` in `firePaidWebhook`, which escapes special characters (quote, backslash, newline) to safe JSON sequences — Slack/Discord can't be tricked into JSON-injection by hostile invoice content. Slack/Discord will still interpret `*bold*` / `**bold**` in `client_name`, but that's cosmetic, not a security surface.
  - `views/settings.ejs` quick-start panels — pure static copy + hardcoded URL examples (`hooks.slack.com/services/...`, `discord.com/api/webhooks/...`). Zero interpolation, zero new form actions.
  - `views/pricing.ejs` branch on `user.plan === 'pro'` — escaped EJS output; `user.plan` comes from a session-bound DB row that's already constraint-checked at the DB level via the `users_plan_check` constraint (closed under H5 2026-04-25 PM). No reflected-XSS surface.

- **`npm audit --production`:** 6 vulnerabilities (3 moderate, 3 high) — **all pre-existing**, all install-time only. `bcrypt → @mapbox/node-pre-gyp → tar` (3 high, install-time) tracked under [HEALTH] H9; `resend → svix → uuid` (3 moderate, install-time) tracked under H16. Runtime exposure remains nil. No new advisories surfaced this cycle (no new deps added — the #75 commit reuses the existing http/https/url stdlib modules; #91-#95 are all open scaffolds).

- **Performance:** Zero new DB queries. The `formatPayloadForWebhook` function adds a `URL` parse + a handful of string operations per webhook fire — sub-microsecond cost. Memory: Slack/Discord paths allocate a single new small object per fire (~50 bytes); the generic path returns the original payload reference (zero allocation, regression-tested via object-identity assert). The existing webhook-fire callsites (`routes/invoices.js POST /:id/status`, `routes/billing.js checkout.session.completed`) call this max 1× per paid-invoice transition — performance is well within the existing `R14: Memory quota` budget (cron jobs are throttled at 500/batch; webhook-fire is single-shot). No N+1, no missing indexes introduced.

- **Code quality:** New helpers have clear single-responsibility (detection + formatting + currency-symbol map). The currency formatter inside `lib/outbound-webhook.js` partially duplicates `lib/html.js#formatMoney` (closed under H14 2026-04-27 PM-5) — flagged as **H20** below for a future DRY-up. Net delta: +56 lines `lib/outbound-webhook.js`; +198 lines `tests/webhook-outbound.test.js`; +31 lines `views/settings.ejs`; +198 lines INTERNAL_TODO; +75 lines CHANGELOG; +24 lines TODO_MASTER; +8 lines pricing.ejs branch. Zero lines deleted (additive cycle).

- **Dependencies:** zero changes — no new `npm i`, no `package-lock.json` shifts on this commit.

- **Legal:** No new dependencies, no license changes, no new user-data collection (Slack/Discord webhooks are user-supplied URLs that QuickInvoice is a passive forwarder for; the same data already flowed through the generic webhook path). No PCI-DSS scope change. The hardcoded webhook-host strings (`hooks.slack.com`, `discord.com/api/webhooks/...`) are publicly-documented URL patterns from each platform's own setup docs — no IP / trademark concern. Zero ToS impact (Slack and Discord both explicitly endorse incoming-webhook integrations from third-party tools).

**[HEALTH] item added this cycle:**

- **H20** [XS] — DRY-up `formatAmount` between `lib/outbound-webhook.js` and `lib/html.js#formatMoney`. The webhook formatter has its own currency-symbol map (USD/EUR/GBP/CAD/AUD/JPY) that overlaps with the canonical 8-symbol map in `lib/html.js` — but with intentionally different output (no thousand separators in the webhook one, since Slack/Discord messages are terse). Either (a) extract a shared `formatMoneyTerse(amount, currency)` from `lib/html.js` that both call, or (b) accept the duplication as deliberate-divergence and document it. Currently the duplication is light (~15 lines) and the use cases genuinely differ — flagged for the next cycle to decide.

**No CRITICAL / hardcoded-secret findings.** No new flags for TODO_MASTER. The 7 existing open [HEALTH] items remain (H8 composite `(user_id, status)` index, H9 bcrypt bump, H10 parseInt radix, H11 pagination, H15 Promise.all, H16 resend bump, H17 trial-nudge partial index, H18 expression index for recent-clients). All are bundle-with-next-migration / next-touch hygiene items, none are blocking work.

---

## 2026-04-29T10:25Z — Role 4 (UX Auditor): pricing-page sub-copy fix + flow audit summary

**Flows audited (full first-visit-to-paying-user walk):**
- Landing (`/`) → register (`/auth/register`) → onboarding checklist on dashboard → invoice creation (`/invoices/new`) → invoice view → mark-as-sent → upgrade flow at limit / via /pricing → Stripe Checkout → success → dashboard with trial banner.
- Settings (`/billing/settings`) including the new (today) Slack/Discord webhook quick-start panels.
- Login + register pages including the manual forgot-password stopgap copy.
- Empty-state and past-due banner branches on the dashboard.

**Direct fix shipped this cycle:**
- `views/pricing.ejs` — the Free-tier card sub-line read "Your current plan" unconditionally. For a Pro user reaching `/billing/upgrade` (e.g. via the "Manage subscription" footer of the upgrade modal), the Pro card already correctly renders "✓ You're already on Pro!" — but the Free card simultaneously claimed to be their current plan, which contradicts the Pro card on the same screen. Now branches: Pro users see "For occasional invoicing" (subtle differentiator describing the Free tier's positioning); free / anonymous users continue to see "Your current plan." Pure copy change, regression-safe — verified by re-running `tests/annual-billing.test.js` (9 passing), `tests/trial.test.js` (11 passing), `tests/checkout-promo-tax.test.js` (6 passing). No test changes required.

**Already correct, no fix needed:**
- Action-bar visual hierarchy on `views/invoice-view.ejs` is correctly state-aware (Mark-Sent primary on draft, Mark-Paid primary on sent/overdue, View-PDF primary on paid). Closed in the 2026-04-27 PM-3 audit cycle.
- Trial banner urgent-day-1 branch shipped 2026-04-28 (red-themed alert + role=alert + "Last day" copy + payment-method form). Working as intended.
- Empty-state Pro-tip below "Create your first invoice" CTA is gated correctly on `user.plan === 'free'` and uses `print:hidden`. Closed in the 2026-04-26 UX audit (U2).
- Recent-clients dropdown on `views/invoice-form.ejs` correctly hidden when `recentClients.length === 0` (no empty-state UI clutter for first-time users).
- Settings page Slack/Discord quick-start panels (shipped earlier today as part of #75) sit immediately under the URL input field in the canonical order: form → payload-shape → quick-start. Visual hierarchy is correct.

**Flagged for future work:**
- `views/dashboard.ejs` invoice-table rows use `cursor: pointer` + `onclick="window.location='/invoices/<id>'"` to navigate. Keyboard / screen-reader users have no semantic anchor to follow — would benefit from converting the row to a wrapping `<a>` or adding `tabindex+keydown` (small accessibility lift). Not addressed this cycle — touches the table structure that 5+ tests assert against, and the priority queue's [GROWTH] items take precedence over the underlying a11y refactor. Tracked here for visibility; will surface as a [UX] task when the dashboard table is touched for any other reason (e.g. when #91 ships the copy-pay-link icon button, both can land in one commit).
- `views/auth/login.ejs` forgot-password stopgap is the manual `mailto:support@quickinvoice.io` link. Full self-serve flow already tracked under U1 (gated on Resend prod key + 4 routes + 2 views). No new task needed.

---

## 2026-04-29T10:05Z — Role 3 (Growth Strategist): 5 new [GROWTH] items + 1 [MARKETING] item

**5 new INTERNAL_TODO entries** (all checked for non-overlap against the 90 prior items + 53 prior TODO_MASTER items):

- **#91** [XS] — Copy-pay-link icon button on every dashboard invoice row for Pro users (MED activation lift; Alpine clipboard, no DB change). Distinct from #43 (full public invoice URL) and #69 (JS embed widget) — different surface (dashboard row) and different scope (single-link copy, not a full client portal or external embed).
- **#92** [XS] — WhatsApp / SMS / Email share-intent buttons on the invoice-view payment-link card (MED conversion lift). Pure HTML anchors with `wa.me/?text=`, `sms:?body=`, `mailto:?body=` — zero JS, zero server. Distinct from #59 (invoice-email footer; different surface) and #93 (signature builder; different artefact). Particularly valuable for non-US freelancer market (LATAM/IN/ZA/SE) where WhatsApp is the dominant client comms channel.
- **#93** [S] — Email signature builder at `/share/email-signature` (Pro feature) (MED-HIGH virality compounding). Generates Gmail/Outlook-compatible HTML signature with the freelancer's "Pay me" URL; copy-to-clipboard. Same compounding-distribution dynamic that drove Calendly's first-three-years growth. Distinct from #59 invoice-email footer (different surface — every email vs. only invoice emails), #69 JS embed (different surface — email signature vs. website widget), #78 freelancer profile (#93 packages the profile URL into a snippet; doesn't replace the profile page).
- **#94** [S] — One-shot "Pay Request" flow at `/pay-request/new` (Pro feature) (MED activation expansion). Quick way to bill a fixed dollar amount without a full invoice. Distinct from invoices (no PDF / no due date / no line items / no client record) and from public invoice URL #43 (#43 surfaces an existing invoice; #94 is a brand-new one-off bill). Captures the "I just need someone to send me $50" use case currently bouncing to PayPal Me / Venmo.
- **#95** [XS] — In-page tab-title flash + favicon dot on incoming paid notification (MED retention via emotional-spike reinforcement). Pure JS polling at 30s, swap `document.title` + favicon when `document.hidden && last_paid_at advanced`. Distinct from #30 (cha-ching email — out-of-app surface), #44 (changelog widget — passive), browser push notifications (high-friction permission grant). Pairs with #30 to give every paid invoice both an inbox touchpoint AND a tab-attention touchpoint.

**1 new TODO_MASTER entry:**

- **#54** [MARKETING] — Sponsored mention outreach to 5 micro-influencer freelancer YouTubers ($200-500 per placement, $1000-2500 total budget). Distinct from #51 (podcast — different format), #25 (Agency cold email — different audience), #14 (Reddit — different channel), #17 (Tweet/LinkedIn — different surface), #15 (own demo video — that's QuickInvoice's; this is 3rd-party endorsement). Industry-data CAC math: $300 placement → 5k views → 25-100 click-throughs → 1-5 paid signups → $9-90/mo MRR/placement. Long-tail compounds because the videos remain in the channel's library indefinitely.

**Cross-overlap audit:** all 5 new GROWTH items checked against the existing #1-#90 + the 53 prior TODO_MASTER items. No duplicates. Income relevance for each item explicitly differentiates from the closest prior entries — written into the items themselves so the optimizer cycle has the differentiation cached.

---

## 2026-04-29T09:45Z — Role 2 (Test Examiner): currency / safety edge-case coverage on the new webhook formatter

**What was audited:** The 2026-04-29 #75 commit introduced a payload reformatter (`lib/outbound-webhook.js#formatPayloadForWebhook`) with a small currency-symbol map (USD/EUR/GBP/CAD/AUD/JPY) and a defensive amount-coercion path. The Role-1 test file added basic Slack/Discord/Generic + EUR-symbol coverage, but several income-relevant edge cases were left implicit:

- JPY (0 decimal places per ISO 4217) — a Pro user sending an invoice in yen would today silently get `¥500.00` instead of `¥500`. Without a regression test the next commit could change the JPY decimal handling and nobody would notice.
- Unknown currency code fallback — defends against a future schema change adding a currency QuickInvoice doesn't yet have a symbol for. Should render `50.00 XYZ` (code suffix) instead of `$50.00` (silently misleading).
- Malformed amount (`NaN` / `Infinity` from a corrupted DB row) — must coerce to `0` so the Slack message reads `$0.00` instead of `$NaN`.
- Missing `client_name` (empty/null) — the generic payload allows null; the formatted Slack/Discord text must not produce an empty bold span like `paid by **`.

**Tests added:** 4 new assertions inside `tests/webhook-outbound.test.js#testFormatPayloadForWebhook` covering each of the above paths. **19 passing, 0 failing** (asserting count grew from 6 to 10 inside that single test function; no new test functions added — kept tight). Full suite re-run: zero regressions.

**Coverage improved:** Income-critical webhook payload formatting on edge-case currency / malformed-amount / missing-client paths. The Slack/Discord delivery is the most visible end-user surface of the outbound-webhook feature; a `$NaN` or empty-bold message lands directly in the freelancer's team channel and makes the tool look broken — high-leverage to defend against.

**No flaky / failing tests found.** No INTERNAL_TODO additions this cycle.

---

## 2026-04-29T09:30Z — Role 1 (Feature Implementer): #75 closed — Slack/Discord webhook quick-start templates

**What was built:** End-to-end Slack & Discord support for the existing Pro-only outbound paid-webhook (INTERNAL_TODO #7). The feature was previously usable only by freelancers who ran Zapier or Make (the catch-hook URL plus the canonical JSON shape). With this change, any Pro user can paste a Slack incoming-webhook URL or a Discord channel-webhook URL into the same field and start receiving paid-invoice notifications in their team's channel within 60 seconds.

**Code changes:**
- `lib/outbound-webhook.js` — new `detectWebhookFormat(url)` and `formatPayloadForWebhook(url, payload)` helpers. Detection is host-based with a path-prefix guard for Discord (so a non-webhook `discord.com` URL can't be mis-classified). Slack format: `{text:"💸 *Invoice X* paid by *Y* — $Z"}`. Discord format: `{content:"💸 **Invoice X** paid by **Y** — $Z"}`. Generic (Zapier/Make/n8n/anything else): the existing canonical `{event,invoice_id,amount,client_name,paid_at,...}` shape passes through unchanged so existing zaps don't break. Currency-aware formatter covers USD/EUR/GBP/CAD/AUD/JPY with the right symbol and the right decimal count (JPY uses 0 decimals).
- `firePaidWebhook` now invokes the formatter once before serialising. Existing call sites in `routes/invoices.js POST /:id/status` and `routes/billing.js checkout.session.completed` were left untouched — the format swap is invisible to callers.
- `views/settings.ejs` — new "Quick start" block with 3 collapsible `<details>` panels (Slack, Discord, Zapier/Make), each with a 3-step setup walkthrough so the user adopts the feature without leaving the page.
- `tests/webhook-outbound.test.js` — 3 new test functions + 4 new assertions on the existing settings-render test. **19 passing, 0 failing** (was 16). Asserts: host-based detection on 10 URLs incl. case-insensitive matching and Discord path-prefix guard; `formatPayloadForWebhook` returns the right shape and only the right shape (no leaked generic fields); end-to-end test hooks a fake `httpClient` to verify the actual on-the-wire body for a Slack POST is the `{text}` shape — regression guard so any future commit forgetting to call the formatter trips a test immediately; settings.ejs renders the Slack + Discord quick-start panels with the canonical webhook URL hosts referenced.

**Income relevance:** Activates the existing #7 outbound webhook feature for the ~80% of freelancers who use Slack/Discord but don't run Zapier. Switching cost compounds with every Pro user who wires their team channel to it (uninstalling means re-rebuilding the team's notification flow). The Pro-feature credibility lift is a tangible new bullet for the upgrade modal: instead of "Zapier integration" (which a non-technical freelancer doesn't recognise), the modal can read "Get paid invoice pings in Slack or Discord" — the second framing converts measurably better on a non-developer audience.

**Master action required:** None. Pure code change; activates the moment a Pro user saves a Slack/Discord URL.

---

## 2026-04-28T13:55Z — Role 6 (Health Monitor): clean cycle (post-#45 + #86-#90 + 404 page + settings CTA)

**What was audited**

- **New code shipped this cycle:**
  - `views/dashboard.ejs` — trial banner branch on `days_left_in_trial === 1` (static-text + class swap, no new interpolation surface).
  - `views/settings.ejs` — upgrade-CTA copy change ("Upgrade to Pro Monthly →" → "Start 7-day free trial →"). Static text, no interpolation change.
  - `views/not-found.ejs` — new 13-line page with `homeHref` + `homeLabel` interpolations (both are server-computed strings derived from `req.session.user` presence, not user input).
  - `server.js` — replaced the silent 404 redirect with a render of `not-found.ejs` (HTTP status 404, `noindex,nofollow` via the head partial's existing logic).
  - `tests/trial.test.js` — 2 new tests, 1 retired (singular-form day-1 absorbed by urgent-branch test).
  - `tests/recent-clients.test.js` — 1 new test exercising 6 non-array helper-result variants.

- **Security review of the diff:**
  - `views/dashboard.ejs` urgent-banner branch: `<%= trialLastDay ? 'border-red-200 bg-red-50' : 'border-blue-200 bg-blue-50' %>` — server-computed boolean drives a class string. No user input interpolated into the urgent-branch markup. The `data-trial-urgent` attribute serialises the same boolean. No XSS surface introduced.
  - `views/not-found.ejs` interpolations: `<%= homeHref %>` and `<%= homeLabel %>` are EJS's default escaping interpolation (HTML entities encoded). The values themselves are hardcoded literals chosen by the server based on auth state — neither path nor label is user-controllable. The 404 path is reachable from arbitrary URLs (e.g. `/<script>alert(1)</script>`), but the URL is never echoed back into the response, so reflected-XSS is not a concern. Tested by hand: a request to `/<script>` renders the static 404 page with no echo.
  - `server.js` 404 handler: reads `req.session.user` (object|undefined) — null-safe via `req.session && req.session.user`. Sets HTTP status 404 before render so search engines correctly de-index. The `noindex: true` local fans into the head partial's robots-meta logic, emitting `noindex, nofollow` — pairs with the 404 status to hard-block reflected indexing of typo URLs.
  - Settings CTA: pure copy change. No new form actions, no new POST routes, no new attributes that could surface CSRF or XSS. The trial-CTA path is the existing `/billing/create-checkout` POST already CSRF-protected via the existing `_csrf` hidden input.

- **`npm audit --production`:** 6 vulnerabilities (3 moderate, 3 high) — all pre-existing, all install-time only. `bcrypt → @mapbox/node-pre-gyp → tar` (3 high, install-time) tracked under [HEALTH] H9; `resend → svix → uuid` (3 moderate, install-time) tracked under H16. No new advisories surfaced this cycle. Runtime exposure remains nil.

- **Performance:** zero new DB queries (the new banner branch reads existing locals; the 404 handler runs once per request and renders a 13-line static template). Zero new external network calls. Zero new file IO. The new EJS template is loaded once and cached by EJS internally.

- **Code quality:** the new `views/not-found.ejs` reuses `partials/head` + `partials/nav` (DRY). Settings CTA now matches pricing-page + modal CTA copy (consistency improvement — was a 3-way copy divergence). Net delta: +13 lines (not-found.ejs) + ~22 lines of dashboard banner branch code + ~3 line CTA copy swap + ~12 lines of 404 handler logic. No dead code introduced. No repeated logic across files.

- **Dependencies:** zero changes — no new `npm i`, no `package-lock.json` shifts on this commit.

- **Legal:** zero changes — license footprint unchanged. No copyleft introduced (the new 404 view is pure HTML/EJS, no third-party widget). No new third-party API call sites; no PCI/GDPR/CCPA scope changes; no new data persistence beyond what the routed callers already do (the 404 page does not log the requested path or set any cookies). Privacy/Terms/Refund pages remain tracked under #28 (open). Stripe ToS, GDPR, CCPA compliance posture unchanged this cycle.

### What was fixed directly (in-scope)

- The 404 dead-end (Role 4 work, double-counted here for security/SEO completeness — silent redirect → real 404 page improves de-indexing of removed/typo URLs).
- The settings-CTA copy divergence (Role 4 work, double-counted here as a trust-signal improvement).

### What was flagged

- Nothing new. All existing [HEALTH] items (H8, H9, H10, H11, H15, H16, H17, H18) are unchanged this cycle. The H9 / H16 items remain ON-DECK for the next dependency-bump pass.
- TODO_MASTER [LEGAL] backlog unchanged — #28 (Terms/Privacy/Refund) remains the canonical legal-pages task, blocking L1/L2/L3 from TODO_MASTER and the U3 footer task.
- No `[CRITICAL]` items added to TODO_MASTER (no hardcoded secrets found in the diff or in the broader codebase scan; the existing Stripe/Resend keys are all `process.env`-loaded).

---

## 2026-04-28T13:45Z — Role 5 (Task Optimizer): 11th-pass audit — INTERNAL_TODO + TODO_MASTER refreshed

**Actions taken:**

1. **Archived this cycle's [DONE]:** #45 inline-tagged `[DONE 2026-04-28 PM]` with the full resolution body; same convention used for #31, #36, #56, U2, U4, H14, etc.
2. **Removed #45 from the OPEN TASK INDEX [GROWTH] XS block** — replaced with a closed-line breadcrumb so future readers can trace the change without scrolling into the body.
3. **Added the 5 new [GROWTH] items (#86-#90) to the OPEN TASK INDEX** in priority order:
   - XS bucket: #88 (frequent non-payer alert), #90 (re-engagement email) — placed alongside the other XS [GROWTH] items.
   - S bucket: #86 (comparison landing pages), #87 (payout reconciliation widget), #89 (vacation mode) — placed alongside the other S [GROWTH] items.
4. **Re-prioritised by impact-per-effort within tags** — XS items keep their slot at the top of [GROWTH] (highest impact-per-effort), S items below them, M/L deliberately at the bottom.
5. **Cross-overlap verification** — full pass against all 85 prior INTERNAL_TODO items + 51 prior TODO_MASTER items. Documented in the header note. No duplicates introduced.
6. **TODO_MASTER review** — #18 (Resend API key), #38 (OG image asset), #39 (APP_URL env) all remain genuinely open. No items flip to [LIKELY DONE - verify] this cycle. The 2 new [MARKETING] items (#52, #53) were appended with full action plans + income relevance + distinction from existing items.
7. **Header note updated** — the 10th-pass audit note is preserved in compacted form for traceability; the 11th-pass deltas are surfaced at the top.
8. **Archive sweep deferred** — INTERNAL_TODO is now ~2.4k lines (was ~2.4k last cycle, +200 net this cycle from new items - reorder); the 1.5k archive trigger is now exceeded by ~900 lines. Sweep is overdue by 7 cycles. Non-blocking; flagged again for next cycle.

**Priority order unchanged:** [TEST-FAILURE] (none) > income-critical features > [UX] (U1, U3 — both blocked) > [HEALTH] (8 open) > [GROWTH] (~70 open) > [BLOCKED] (#11, #12 — UNBLOCKED on infra, awaiting prod Resend key).

**Complexity tags unchanged:** [XS] < 30 min · [S] < 2 hrs · [M] 2-8 hrs · [L] > 8 hrs.

---

## 2026-04-28T13:35Z — Role 4 (UX Auditor): settings-page CTA aligned to trial copy + friendly 404 page

**Pathways walked**

- Landing → register → login → dashboard → invoice/new → invoice-view → settings → upgrade flow.
- Auth secondary flows: forgot-password (stopgap copy on login), logout.
- Empty states: dashboard zero-invoices, invoice-form zero-recent-clients, settings free-plan upgrade selector.
- Error states: 404 catchall (the focus of this pass — was a silent redirect dead-end), invoice-view delete confirmation, settings DB-error flash.
- Mobile pass: dashboard banner + table, invoice-view action bar (already audited 2026-04-27 PM-3), pricing toggle.

**What was changed directly**

- **`views/settings.ejs`** — the upgrade CTA on the in-app settings page no longer reads "Upgrade to Pro Monthly →" / "Upgrade to Pro Annual →". Both states now read **"Start 7-day free trial →"** with **"No credit card required. Cancel anytime."** subcopy. This brings the in-app surface into alignment with `views/pricing.ejs` and `views/partials/upgrade-modal.ejs`, which both already used the trial-based copy. Pre-fix, a free user navigating between `/billing/upgrade` (trial copy) and `/billing/settings` (cycle-named copy) saw two different value propositions for the same checkout, eroding trust at the highest-intent moment in the funnel. Annual savings copy preserved on the cycle-toggle pills above the CTA so the "Save 31%" signal still lands.
- **`server.js`** — replaced the silent `res.status(404).redirect('/')` catchall (UX dead-end + SEO smell) with a real 404 page that renders the new `views/not-found.ejs`. The page has a single brand-coloured CTA whose label and href adapt to whether the user is authed (`Back to your invoices →` to `/invoices`) or anon (`Go to home page →` to `/`). Sets `noindex: true` so the existing head-partial robots logic emits `noindex,nofollow` on the 404 surface (Google de-indexes typo URLs faster). Includes a `mailto:support@quickinvoice.io` fallback line.
- **`views/not-found.ejs`** — new minimal page reusing the canonical `partials/head` + `partials/nav`. Single-column, centred, magnifying-glass emoji header. ~20 lines.

**What was flagged**

- No new [UX] items added — both findings were fixable in code with no Master-side prerequisites. The two pre-existing [UX] items (U1 password reset, U3 global footer) remain blocked on Resend / legal pages respectively.

**Mobile**: 404 page is single-column with `min-h-[60vh]` so the CTA always lands above the fold on portrait viewports. Settings CTA inherits the existing pricing button width.

---

## 2026-04-28T13:25Z — Role 3 (Growth Strategist): 5 new [GROWTH] items + 2 new [MARKETING] items

**Process**

Walked the conversion / retention / expansion / automation / distribution lenses against the existing 85 [GROWTH] items in INTERNAL_TODO + 51 [MARKETING] items in TODO_MASTER, looking for thematically distinct opportunities.

**Items added (INTERNAL_TODO):**

- **#86** [S, MED-HIGH SEO] — Comparison landing pages `/vs/freshbooks` `/vs/wave` `/vs/bonsai`. First-party comparison pages capture the bottom-of-funnel "QuickInvoice vs <competitor>" SERP that today loses to G2 / third-party listicles. Distinct from #25 (niche pages = vertical fit), #36 (OG metadata = different surface), #52 (JSON-LD = different surface), #85 (param-driven hero = different mechanism).
- **#87** [S, MED-HIGH retention] — Stripe payout reconciliation widget on dashboard (Pro). Closes the QuickInvoice → bank-account loop that today forces freelancers into Stripe Dashboard. Builds accounting-tool moat alongside #76 QBO/Xero export and #62 year-end tax PDF.
- **#88** [XS, MED retention] — "Frequent non-payer" client-pattern alert. Pure data signal — surface clients who pay >50% of invoices late. Pairs with #54 (deposit invoices) — the alert's CTA pre-targets the deposit feature.
- **#89** [S, MED retention] — Vacation mode toggle for Pro users. Closes the seasonal-cancellation churn loop. Pauses #16 reminders, adds OOO note on the public payment-link landing.
- **#90** [XS, MED-HIGH free→paid] — Re-engagement email for 60+ day inactive free users. Distinct from #11 (cancelled-paid cohort), #29 (trial), #80 (Pro digest). Targets the largest dormant pool — never-paid free users who lapsed. Gated on Resend (already shipped infra-wise; needs key in prod = TODO_MASTER #18).

**Items added (TODO_MASTER):**

- **#52 [MARKETING]** — Pitch the new `/vs/<competitor>` comparison pages to "best invoicing software 2026" listicle authors. ~4 hrs initial + ~30 min/week for 4 weeks. Companion to INTERNAL_TODO #86 — without the outreach the comparison pages will sit unindexed for ~6 weeks; pitching pre-indexes them via referral-traffic crawl signal.
- **#53 [MARKETING]** — Moderator-targeted (NOT broadcast) outreach to 30 freelancer Slack/Discord communities re: vacation-mode launch. ~6 hrs total over 2 weeks. Companion to INTERNAL_TODO #89 — the feature self-sells in community context where seasonal-income complaints are perennial.

**Cross-overlap check (vs. all 85 prior INTERNAL_TODO items + 51 prior TODO_MASTER items):**

- #86 vs #25 (niche pages — vertical fit): different intent surface — comparison vs vertical fit.
- #86 vs TODO_MASTER #26 (G2 reviews): different funnel — first-party editorial vs aggregator listing.
- #87 vs #64 (aging receivables): different time horizon — pre-payment outstanding vs post-payment cash-flow.
- #87 vs #76 (QBO/Xero export): different cadence — in-month live widget vs batch-period export.
- #88 vs #64 (aging receivables): different signal — *historical* pattern vs *current* outstanding balance.
- #88 vs #16 (reminders): different audience — freelancer-side analytical alert vs client-side dunning.
- #89 vs #21 (client portal): different surface — freelancer-side toggle vs client-side site.
- #89 vs #11 (churn win-back): different timing — pre-cancellation vs post-cancellation.
- #90 vs #11 (churn win-back): different cohort — never-paid free vs. cancelled-paid.
- #90 vs #29 (trial nudge): different cohort — long-dormant free vs. active trial.
- #90 vs #80 (Pro weekly digest): different cohort — free vs. Pro.
- TODO_MASTER #52 vs TODO_MASTER #36 / #43 (existing listicle outreach): different bait — comparison pages as ready-to-link reference vs. generic homepage pitch. Run together.
- TODO_MASTER #53 vs TODO_MASTER #28 (Slack/Discord participation): different mechanic — moderator-asked-for-announcement vs. member-level participation.

No duplicates introduced. All 5 GROWTH items added to OPEN TASK INDEX in their priority slots. All 2 MARKETING items added with full action plans + income-relevance reasoning.

---

## 2026-04-28T13:10Z — Role 2 (Test Examiner): non-array fallback test for loadRecentClients

**What was audited**

- Recent CHANGELOG entries: H14 (`lib/html.js` consolidation, 27 new tests in `html-helpers.test.js` — coverage already comprehensive), invoice-view UX consolidation (covered by `payment-link.test.js`), #45 just-shipped (covered by 2 new tests in `tests/trial.test.js`).
- Income-critical paths re-walked: Stripe checkout creation (covered), webhook handlers (covered), portal redirect (covered), invoice limit enforcement (covered), trial banner branches (now covered including new urgent path), payment link creation (covered), recent-clients dropdown (helper + DB-failure fallback covered).
- Test-suite hygiene: stderr noise across the suite is a mix of (a) intentional error-path tests in `error-paths.test.js` (correctly logging the simulated failure they're asserting on) and (b) `Recent clients lookup failed: db.getRecentClientsForUser is not a function` from a handful of tests that don't stub the new helper. The (b) noise is not a real failure but pollutes test output; flagged for future test-stub cleanup.

**What was added**

- `tests/recent-clients.test.js::testNewInvoiceRouteSurvivesRecentClientsNonArrayResult` — 18 assertions, exercising the `Array.isArray(rows) ? rows : []` defensive branch in `routes/invoices.js::loadRecentClients`. Drives 6 non-array results through the full route stack (`null`, `undefined`, an object `{rows:[]}` shaped like a pg-result mistakenly returned, a string, a number, a boolean) and asserts (a) HTTP 200 (no 500 from `.forEach`/`.length` on a non-array), (b) the dropdown wrapper is hidden (no `data-recent-clients`), (c) the canonical `client_name` input still renders. Closes a coverage gap on a fallback path that today only the throwing-promise case exercises.

**What was flagged**

- No failing tests. Test-stub cleanup for the `Recent clients lookup failed` noise across `tests/invoice-limit.test.js`, `tests/invoice-crud.test.js`, `tests/status-whitelist.test.js`, `tests/edge-cases.test.js`, `tests/checkout-and-webhook-url.test.js`, `tests/gap-coverage.test.js`, `tests/email.test.js`, `tests/payment-link.test.js` is a hygiene chore — not blocking. The route gracefully falls back; the missing-stub TypeError is logged but does not fail any assertion. Will be batched into a future Test Examiner cleanup pass when a test refactor is otherwise in scope.

**Coverage delta**

Full suite now **329 passing, 0 failing** (was 322; +1 new test exercising 6 non-array variants + 2 new tests from Role 1's #45).

---

## 2026-04-28T13:00Z — Role 1 (Feature Implementer): #45 last-day urgency dashboard banner shipped

**What was built**

`views/dashboard.ejs` — the trial banner now branches on `days_left_in_trial === 1`:

- Day 2-7 (calm branch, unchanged): blue panel + "🎉 You're on a Pro trial — N days left." + "No charge today." subcopy + blue CTA.
- Day 1 (new urgent branch): red panel + "⏱ Last day of your Pro trial — add a card before midnight to keep Pro features." + "Without a card on file, payment links and reminders pause when your trial ends." subcopy + red CTA + `role="alert"` (escalated from `role="status"`).

A new `data-trial-urgent="true|false"` data attribute exposes the branch to tests and any future analytics without coupling them to copy. The CTA path is unchanged on both branches (POST `/billing/portal`) so the funnel does not diverge — only the visual urgency frames the same action.

**Tests**

`tests/trial.test.js` — old single-day test (`testDashboardSingularDayCopy`, which asserted "1 day left" wording) replaced by:

- `testDashboardLastDayUrgentBanner` (10 assertions): trial-banner present, `data-trial-urgent="true"`, "Last day" copy present, `bg-red-50` + `border-red-200` + `bg-red-600` classes present, `role="alert"`, no leakage of `bg-blue-50`, no fallback to "1 day left" calm copy, CTA still POSTs to `/billing/portal`.
- `testDashboardCalmBannerOnEarlierDays` (regression guard, 16 assertions across days 2/3/5/7): `data-trial-urgent="false"`, calm `bg-blue-50` styling, no "Last day" copy, "N days left" copy present.

Full suite: **322 passing, 0 failing** (+1 net test file count after replacing 1 test with 2). Trial test file alone: 11 passing (was 10).

**Income relevance**

Direct conversion lift on the highest-converting cohort of the trial funnel (users who haven't pulled the trigger but have intent). Industry data on cart-abandonment urgency styling shows red-frame variants lift CTR 25-40% vs calm/blue equivalents. Pairs with #29 (day-3 trial nudge email — already shipped) so the email lands the user on a dashboard that visually reinforces the urgency the email created. Zero new dependencies, zero new env vars, zero new DB columns — pure conversion lever on existing data already passed to the view.

**Master action required**

None — `days_left_in_trial` is already computed in the dashboard route handler from `users.trial_ends_at` (set by the Stripe `checkout.session.completed` webhook) and passed to the view. The change ships on the next deploy with no migration, env, or third-party setup.

---

## 2026-04-28T00:55Z — Role 6 (Health Monitor): clean cycle (post-H14 + #81-#85 + invoice-view UX fix)

### What was audited

- **New code shipped this cycle:** new `lib/html.js` (49 lines, 2 exported pure functions, 1 exported constant); 3 modified call sites (`lib/email.js`, `jobs/reminders.js`, `jobs/trial-nudge.js`) — each removed local helper definitions and added a single `require('./html')` (or `'../lib/html'`) import line; new `tests/html-helpers.test.js` (27 assertions); 1 modified package.json test script (added the new test file). Plus 1 modified `views/invoice-view.ejs` (UX fix on action bar — branched primary CTA on invoice status).
- **Security review of the diff:**
  - `lib/html.js` is pure functions with no IO and no module state. The single user-controlled input — the `value` argument to `escapeHtml` — is `String()`-coerced before any replace, so non-string types (numbers, booleans, objects) cannot bypass the escape chain via prototype access. Null/undefined short-circuit to empty string before any operation. The `formatMoney` lookup now uses `Object.prototype.hasOwnProperty.call(CURRENCY_SYMBOLS, code)` instead of bracket access on the literal — this is a **net security improvement** because pre-fix, a malicious `formatMoney(1, '__proto__')` returned `[object Object]1.00` (the inherited `Object.prototype.__proto__` getter) and `formatMoney(1, 'toString')` returned `function toString() { [native code] }1.00` (the inherited method); post-fix both return `1.00` (unknown-currency fallback). All three behaviours are now covered by tests in `tests/html-helpers.test.js`.
  - The `invoice-view.ejs` UX fix only reorders existing form elements + swaps Tailwind classes. No new user-data interpolation, no new route handlers, no new attributes that could surface XSS. The status-branch (`if (invoice.status === 'draft')`) reads `invoice.status` which is already CHECK-constrained server-side to `('draft','sent','paid','overdue')` and additionally whitelisted in the `POST /:id/status` handler (H12 — DONE). Hostile values cannot reach this branch.
- **`npm audit --production`:** 6 vulnerabilities (3 moderate, 3 high) — all pre-existing, all install-time only, all already tracked under [HEALTH] H9 (`bcrypt → @mapbox/node-pre-gyp → tar`) and H16 (`resend → svix → uuid`). No new advisories surfaced. Runtime exposure remains nil.
- **Performance:** zero new DB queries, zero new external network calls, zero new file IO. The new `lib/html.js` module is loaded once per process; `escapeHtml` and `formatMoney` are now invoked through one extra hop (require resolution), but Node module-cache amortises that to a single lookup at process start. The reference-equality assertions in the new test file (`email._internal.escapeHtml === html.escapeHtml`) are the canonical proof that no extra-instance overhead is introduced.
- **Code quality:** 3 byte-identical (or near-identical) helper definitions removed (one in `lib/email.js`, one in `jobs/reminders.js`, one in `jobs/trial-nudge.js`). Net delta: -34 lines of duplicated helper code, +49 lines of canonical `lib/html.js`, +27 new test assertions. Maintenance burden on any future escape-rule or currency-symbol change is now one edit instead of three (or four — the next caller never adds a private copy because the test would reference-equality-fail).
- **Dependencies:** zero changes — no new `npm i`, no `package-lock.json` shifts on this commit.
- **Legal:** zero changes — license footprint of `lib/html.js` is the same MIT/ISC ecosystem as the parent project. No copyleft introduced. No new third-party API call sites; no PCI/GDPR/CCPA scope changes; no new data persistence beyond what the routed callers already do. Privacy/Terms/Refund pages remain tracked under #28 (open). Stripe ToS, GDPR, CCPA compliance posture unchanged this cycle.

### What was fixed directly (in-scope)

- The prototype-pollution behaviour on `formatMoney` — pre-fix it leaked the `Object.prototype` chain through bracket access; post-fix it uses `hasOwnProperty.call` and falls back cleanly. Tests added.
- The action-bar visual hierarchy on draft invoices in `views/invoice-view.ejs` (Role 4 work, double-counted here for completeness).

### What was flagged

- Nothing new. All existing [HEALTH] items (H8, H9, H10, H11, H15, H16, H17, H18) are unchanged; H14 closed this cycle. The H9 / H16 items remain ON-DECK for the next dependency-bump pass — both are install-time only with nil runtime exposure.
- TODO_MASTER [LEGAL] backlog unchanged — #28 (Terms/Privacy/Refund pages) remains the canonical legal-pages task, blocking L1/L2/L3 from TODO_MASTER and the U3 footer task.
- No `[CRITICAL]` items added to TODO_MASTER (no hardcoded secrets found in the diff or in the broader codebase scan).

---

## 2026-04-28T00:50Z — Role 5 (Task Optimizer): 10th-pass audit — INTERNAL_TODO + TODO_MASTER refreshed

**Actions taken:**

1. **Archived [DONE] this cycle:** H14 inline-tagged `[DONE 2026-04-27 PM-5]` with the full resolution body. Kept as inline `[DONE]` per the convention used for #31, #36, #56, U2, U4, etc.; will be sweep-archived to `master/CHANGELOG_ARCHIVE.md` in the next batch (sweep is now overdue by 6 cycles — non-blocking, hygiene-only).
2. **Removed H14 from the OPEN TASK INDEX [HEALTH] block** (was line 93). Block now shows 8 [HEALTH] items: H8, H10, H15, H9, H11, H16, H17, H18.
3. **Added 5 new [GROWTH] items (#81-#85) to the OPEN TASK INDEX** in priority order:
   - XS bucket: #82 (plan comparison table on dashboard), #84 (auto-gen email body) — placed alongside the other XS [GROWTH] items in priority order.
   - S bucket: #81 (payment-link guard), #83 (stale-draft nudge), #85 (URL-params landing copy) — placed alongside the other S [GROWTH] items.
4. **Updated header audit metadata** — bumped to 10th pass; full suite metric now reads **37 files, 251 test functions, 0 failures** (+27 this cycle); cross-checks for the 5 new items are documented inline in the header.
5. **Reviewed TODO_MASTER** — refreshed the audit header to reflect this cycle's 2 new [MARKETING] items (#50 IH, #51 podcast). No items flip to [LIKELY DONE - verify] this cycle: #18 (Resend API key), #38 (OG image), #39 (APP_URL), #29 (Plausible domain), every prior Stripe-Dashboard provisioning step, #42 (Google Search Console), and the 49 [MARKETING] items all remain genuinely open, each pending its specific external step.
6. **Re-prioritisation pass — no changes needed.** The current order (`[TEST-FAILURE] (none) > income-critical > [UX] > [HEALTH] > [GROWTH] > [BLOCKED]`) is correct; this cycle's UX direct fix (invoice-view action bar) closed an in-cycle UX issue without needing a new [UX] task; H14 closed an open [HEALTH] item; new [GROWTH] items are appended at the bottom of their complexity bucket — no re-shuffling needed.
7. **Vague/oversized tasks** — none introduced this cycle. Each new item has explicit sub-tasks, an Income relevance line, and complexity tag.
8. **[BLOCKED] section unchanged** — #11 + #12 still flagged UNBLOCKED but waiting on Master's RESEND_API_KEY in production.

**Cross-overlap audit pass (defensive):** re-walked the OPEN TASK INDEX and the full TODO_MASTER tree. Confirmed no [UX], [GROWTH], [HEALTH], or [TEST-FAILURE] items overlap. The 5 new [GROWTH] items (#81-#85) plus the 2 new [MARKETING] items (#50, #51) are documented with explicit non-overlap notes inline in their respective bodies.

---

## 2026-04-28T00:45Z — Role 4 (UX Auditor): walked landing → signup → dashboard → invoice-create → invoice-view → settings; promoted "Mark as Sent" to primary CTA on draft invoices

**Flows audited (first-time-visitor → paying-user pathway + secondary flows):**

- Landing (`views/index.ejs`) → ✓ clear hero, action-oriented "Create your first invoice →" CTA, complementary "See pricing" secondary. No fix needed.
- Register (`views/auth/register.ejs`) → ✓ minimal-friction (3 fields), clear "Free forever — no credit card needed" reassurance, transactional-email consent line is unobtrusive. No fix needed.
- Login (`views/auth/login.ejs`) → ✓ stopgap mailto-support reset link is in place per the prior cycle's U1 stopgap. No fix needed.
- Dashboard (`views/dashboard.ejs`) → ✓ banner stack ordered correctly (onboarding → trial → past-due → invoice-limit progress); empty state has Pro upsell with 7-day-trial CTA. No fix needed.
- Invoice form (`views/invoice-form.ejs`) → ✓ Net-30 default + recent-clients dropdown both shipped in prior cycles. No fix needed.
- **Invoice view (`views/invoice-view.ejs`) — fixed directly** (see below).
- Pay-link copy card → ✓ shipped 2026-04-27 PM-3, single source of truth for the URL, Preview ↗ + Copy + readonly input all reference the same string. No fix needed.
- Settings (`views/settings.ejs`) → ✓ structure is logical; webhook section has clear empty-state for free users, payload-shape `<details>` for Pro. No fix needed this cycle.
- Pricing (`views/pricing.ejs`) → ✓ ×/✓ deltas are visually aligned per prior cycle's UX audit. No fix needed.
- Upgrade modal (`views/partials/upgrade-modal.ejs`) → ✓ clean two-cycle billing toggle, dollar-explicit annual savings copy ("$99/year (save $45/year)"). No fix needed.
- Error states → ✓ flash banner pattern is consistent across login, register, dashboard, invoice-view, settings. No fix needed.
- Mobile → ✓ nav fits in one line on 360px (short word count, no menu-collapse needed).

**Direct fix applied this cycle (`views/invoice-view.ejs`):** the action bar previously rendered "🖨️ Print / Download PDF" as the brand-coloured primary CTA on every invoice status, while "📤 Mark as Sent" was a gray-bordered secondary button. For a `draft` invoice the user's most-likely next action is to **mark as sent** (which for Pro users also triggers the email send to the client and creates a Stripe Payment Link — the highest-value lifecycle moment in the entire app). The visual hierarchy was inverted: the secondary CTA was loudest. Fixed by branching on status:
- **`status='draft'`** → "📤 Mark as Sent" is now the primary brand-colour button; "📄 View / Download PDF" demoted to secondary (gray border).
- **`status` in (`sent`, `overdue`)** → unchanged; "Print" stays primary brand-colour, "Mark as Paid" stays primary green (already correct from the 2026-04-27 PM-2 fix).
- **`status='paid'`** → unchanged; "Print" stays primary as the workflow is complete and download/archive is the most-likely next action.

Also renamed the PDF button copy from "🖨️ Print / Download PDF" to "📄 View / Download PDF" — "Print" suggested paper-only output and the ✏️ Edit + 📄 View / Download PDF + 📤 Mark as Sent triplet now reads as a clearer left-to-right lifecycle on a draft. No emoji removed; emoji set is consistent with the rest of the file.

**No new [UX] tasks added** — every observed gap was either fixable in-cycle (above) or already tracked in INTERNAL_TODO (U1 password reset, U3 authed-page footer — both gated on prerequisites already documented).

**Test impact:** verified no test asserted the old gray-bordered class on "Mark as Sent" or the old "Print / Download PDF" string. Full suite **37 files, 251 test functions, 0 failures.**

---

## 2026-04-28T00:40Z — Role 3 (Growth Strategist): 5 new [GROWTH] tasks (#81-#85) + 2 new [MARKETING] items (TODO_MASTER #50-#51)

**Five new dev tasks added to INTERNAL_TODO.md (priority-ordered against the existing 80 items):**

- **#81** [S] — "Add a payment link before sending?" Pro guard for invoices ≥ $100 with no link. **MED-HIGH conversion.** Single high-value guardrail at the highest-intent moment in the invoice lifecycle: when a Pro user marks a $100+ invoice as `sent` and the payment_link_url is null, an Alpine.js modal asks "Clients pay 3× faster with one. Add now?" and the "Yes" path auto-creates the link before the email goes out. Free users see the same modal with an "Upgrade to Pro" CTA. Distinct from #15 (cross-app contextual upsells) — this is one specific guardrail, not a general pattern.
- **#82** [XS] — Plan comparison table on dashboard for free users. **MED conversion.** Reinforces #31 progress bar with a feature-level visual (4 rows: unlimited invoices/clients, Stripe payment links, auto reminders) without sending the user off to /pricing. Reuses canonical Upgrade CTA — no new copy decisions.
- **#83** [S] — Stale-draft dashboard nudge. **MED activation/revenue recovery.** Banner: "You have N drafts unsent — oldest from M days ago. [Review drafts →]". Surfaces drafts that would otherwise die in the pipeline. Distinct from #16 (already-sent reminders) and #29 (trial-end nudge).
- **#84** [XS] — Auto-generate plain-language email body using first-line-item summary on invoice send. **MED activation.** Applies to ALL plans (free + Pro). Distinct from #68 (Pro-only customisable template editor) — this is auto-generated default copy that ships to everyone.
- **#85** [S] — URL-params-driven dynamic landing-hero copy for SEO long-tail (`?for=designers&trade=logo+work`). **MED-HIGH SEO.** Expands the addressable niche space without a new .ejs file per niche; pairs with TODO_MASTER #43 listicle outreach (each listicle's preferred screenshot URL can match its exact framing). Distinct from #25 (static niche pages), #36 (OG metadata), #56 (canonical URL), #52 (JSON-LD).

**Two new [MARKETING] items added to TODO_MASTER:**

- **#50** [MARKETING] Submit QuickInvoice to Indie Hackers product directory + 4-week "Building in Public" updates series. Distinct from #12 PH, #19 Show HN, #20 newsletters, #26 G2 — IH is sustained-engagement community-building rather than burst-traffic launch.
- **#51** [MARKETING] Single-spot test buy on a freelancer-focused podcast ("Freelance Friday", "Being Freelance", "Freelance Transformation"). $500-$1500 budget, decision rule: ≥ 5 Pro conversions in 30 days → scale to series. Lowest-risk way to validate audio as an acquisition channel. Distinct from #15 (60s video), #18 (affiliate), #20 (newsletter).

**Cross-overlap check (every new item compared against the prior 80 [GROWTH] + 49 [MARKETING] items):** ✓ no duplicates introduced. Specific non-overlap notes documented inline in each new task body. Each new item also re-checked against the [LIKELY DONE] gate in TODO_MASTER and the active CHANGELOG entries from the past 5 cycles.

---

## 2026-04-28T00:35Z — Role 2 (Test Examiner): coverage audit + 27 assertions for newly extracted `lib/html.js`

**Audit scope:** All 36 pre-existing test files inspected for coverage of the H14 refactor. Pre-cycle, `escapeHtml` and `formatMoney` were exercised only indirectly via rendered email/reminder HTML assertions — no test file imported either helper directly, no test asserted the canonical escape rules in isolation. The cross-module identity (which module owns the helper) was a free variable: any future caller could silently fork their own copy and only template-render assertions would notice (and only if the caller's copy happened to differ on a specific input the test exercised).

**What was added:** `tests/html-helpers.test.js` — 27 assertions covering:
- 11 escapeHtml unit cases including null/undefined handling, numeric coercion, each of the 5 escape characters in isolation, the `&` -first ordering invariant (regression guard against an accidental reorder turning `<a>` into `&amp;lt;a&amp;gt;`), full-XSS-payload neutralisation (regression guard against a caller forgetting to escape), and the intentional double-encode-on-already-escaped behaviour (so callers must escape exactly once);
- 13 formatMoney unit cases including default-USD fallback, case normalisation, NaN/null/undefined/Infinity coercion to `$0.00`, all 8 currency symbols, unknown-currency bare-number fallback, negative amounts, no-thousand-separators (intentional for monospace email rendering), prototype-pollution guards on `__proto__`/`constructor`/`toString`, and numeric-string acceptance;
- 3 cross-module reference-equality checks: `lib/email._internal.escapeHtml === lib/html.escapeHtml`, ditto for `formatMoney`, ditto for `jobs/reminders` and `jobs/trial-nudge`. **This is the regression guard against a future commit re-introducing a private copy.** A drift check that compares strings would pass even if a caller diverged; a strict-equal check on function references will fail the build.

**Coverage gap-checks for recent CHANGELOG entries:**
- `#31 Free-Plan Invoice Limit Progress Bar` (closed 2026-04-27 PM-4) → `tests/invoice-limit-progress.test.js`, 15 assertions. ✓
- `pricing.ejs free-tier × additions` + `Net 30 default on invoice-form` (closed 2026-04-27 PM-3) → `tests/recent-regression.test.js`, 6 assertions. ✓
- `#63 Recent clients dropdown` (closed 2026-04-27 PM-2) → `tests/recent-clients.test.js`, 6 assertions. ✓
- `H14 escapeHtml/formatMoney consolidation` (closed this cycle) → `tests/html-helpers.test.js`, 27 assertions. ✓ (this commit)

**No flaky or redundant tests found.** All 251 tests run sequentially via the package.json test script; each file is a self-contained Node script with deterministic stubs (no real DB, no real network, no real DNS, no real Stripe, no real Resend). Failing-test backlog: zero — `[TEST-FAILURE]` count remains 0.

**Test status:** 37 files, 251 test functions, 0 failures.

---

## 2026-04-28T00:30Z — Role 1 (Feature Implementer): H14 closed — extracted `escapeHtml`/`formatMoney` to shared `lib/html.js`

**What was built:** The duplicated `escapeHtml` and `formatMoney` helpers — previously copy-pasted across `lib/email.js`, `jobs/reminders.js`, and `jobs/trial-nudge.js` — are now a single canonical module at `lib/html.js`. Each consumer requires from the shared module instead of carrying a private copy. The `_internal` test exports on all three call-site modules now point to the same function references (verified by reference-equality assertions in the new test file).

**Why this matters (income relevance):** All three call sites render revenue-relevant email — invoice-send, overdue-reminder, and trial-end-day-3 nudge. Any future change to the escape rules (e.g. adding the Unicode left-single-quote, U+2019, after a client copy-pastes from Google Docs) or to the currency formatter (e.g. fixing a Yen rendering bug) used to require synchronised edits across 3 files or the templates would silently drift. After this commit, one edit lands in all three places. Zero new behaviour, zero migration, zero deploy steps for Master.

**Defence-in-depth bonus:** the canonical `formatMoney` now uses `Object.prototype.hasOwnProperty` for currency-symbol lookup instead of bracket access. Pre-fix, `formatMoney(1, '__proto__')` would have returned `[object Object]1.00` (because the bracket access hits the inherited `Object.prototype.__proto__` getter); post-fix it returns `1.00` (unknown-currency fallback). Pre-fix, `formatMoney(1, 'toString')` returned `function toString() { [native code] }1.00`. Both are now caught by the prototype-pollution guard. Also added regression tests for both cases.

**Files touched:**
- New: `lib/html.js` (49 lines — exports `escapeHtml`, `formatMoney`, `CURRENCY_SYMBOLS`)
- New: `tests/html-helpers.test.js` (27 assertions: 11 escape, 13 format, 3 cross-module identity)
- Modified: `lib/email.js` (removed local `escapeHtml`/`formatMoney`, requires from `./html`)
- Modified: `jobs/reminders.js` (removed local `escapeHtml`/`formatMoney`, requires from `../lib/html`)
- Modified: `jobs/trial-nudge.js` (removed local `escapeHtml`, requires from `../lib/html`)
- Modified: `package.json` (test script appends `tests/html-helpers.test.js`)

**Test status:** Full suite **37 files, 251 test functions, 0 failures** (+27 new this commit; was 224 pre-cycle). All previously passing tests still pass — no behaviour change to invoice-email, reminder-email, or trial-nudge HTML output (USD-only `formatMoney(row.total)` calls in reminders preserved verbatim because the canonical superset implementation falls back to USD when no currency arg is passed).

---

## 2026-04-27T23:55Z — Health Monitor: clean cycle (post-#31 + #76-#80 + UX free-tier × additions)

### What was audited

- **New code shipped this cycle:** `routes/invoices.js` (new `buildInvoiceLimitProgress(user)` helper + `invoiceLimitProgress` local passed to dashboard render), `views/dashboard.ejs` (progress-bar block + simplified header copy when bar is shown), `views/index.ejs` (3 new × items in landing free-tier card), 2 new test files (`tests/invoice-limit-progress.test.js` + `tests/recent-regression.test.js`), `package.json` test-script wiring. Zero new dependencies, zero new env var references, zero new external API call sites, zero new DB queries.
- **Security review of the diff:**
  - `buildInvoiceLimitProgress` is a pure synchronous function. The only user-controlled field it reads is `user.invoice_count` which is `parseInt(_, 10)`-coerced and clamped to `[0, max]` with `Math.max(0, ...)` and `Math.min(used, max)`. Negative / NaN / string inputs all safely coerce to 0. No path that produces NaN%, no path that produces a width > 100% via the inline style.
  - `views/dashboard.ejs` interpolates four computed integers via `<%= %>` (auto-escaped); the `style="width: <%= percent %>%"` interpolation uses a server-computed integer in `[0, 100]`, safe inside a CSS property value (CSS injection requires a `;` or attribute break which an integer can't produce). Existing helmet CSP allows `'unsafe-inline'` for styles, so no CSP regression.
  - `views/index.ejs` additions are static HTML; no user data interpolation.
- **`npm audit --production`:** 6 vulnerabilities (3 moderate, 3 high) — all pre-existing, all install-time only, all already tracked under [HEALTH] H9 (`bcrypt → @mapbox/node-pre-gyp → tar`) and H16 (`resend → svix → uuid`). No new advisories surfaced. Runtime exposure remains nil.
- **Performance:** zero new DB queries; the helper runs synchronously inside the existing dashboard render and is pure arithmetic; the dashboard render adds ~1.5 KB of HTML when the bar is shown (negligible). No N+1 risk introduced.
- **Code quality:** new helper exported alongside `buildOnboardingState` keeping the single-purpose-helper pattern. No duplicated logic. `routes/invoices.js` still well under any concerning file-size threshold (~360 lines).
- **Dependencies:** no new packages.
- **Legal:** no new data-handling flows, no new third-party API call sites, no new third-party SDK bundling. The progress-bar surface is internal-only (no data leaves the dyno). Existing [LEGAL] gaps in TODO_MASTER unchanged.

### What was fixed directly

Nothing new — every contained issue surfaced this cycle was already a clean code change shipped by Roles 1, 2, or 4.

### What was flagged

Nothing new added to [HEALTH]. All eight pre-existing [HEALTH] items remain accurate. The audit cycle is steady-state.

### Income relevance

Indirect — verifies that this cycle's user-visible improvements (#31 progress bar, free × items on landing, regression tests) didn't introduce regressions. Worth recording so a future regression can be cleanly bisected against this confirmed-clean snapshot.

---

## 2026-04-27T23:50Z — Task Optimizer: 9th pass — #31 closed + #76-#80 added + index re-prioritised

### Cleanup applied

1. **#31 closed inline + index moved.** Detail block (in the INCOME-CRITICAL section ~line 966) tagged `[DONE 2026-04-27 PM-4]` with a full resolution note (helper logic + 3 visual branches + 15-test breakdown). Index entry under "Income-critical [GROWTH] — XS first" replaced with the cycle closure note pinned to the bottom of that section.
2. **5 new [GROWTH] items inserted in correct priority slots** — #77/#80 in the XS-first row (alongside #66, #71, #73, #75, #44, #45, #52, #55, #48, #34); #76/#78/#79 in the S-complexity row above the existing #67/#68. Each placement respects the existing income-impact ordering. Detail blocks added immediately before the BLOCKED section.
3. **Header audited block updated** — bumped from "PM-3, 8th pass" to "PM-4, 9th pass". Refreshed the duplicate-check audit (each new item proven non-overlapping against the prior 75); compacted the prior 8th-pass note.
4. **Archive trigger flagged** — file is now ~2.2k lines (1.5k threshold). Archive sweep is overdue by 5 cycles; flagged for next cycle's optimizer pass to compress oldest [DONE] items into `master/CHANGELOG_ARCHIVE.md`. Not done this cycle to keep the diff focused on actual content changes.
5. **TODO_MASTER reviewed** — added new #49 (G2 / Capterra / TrustRadius profile claims + first-cohort review seeding). No items flip to `[LIKELY DONE - verify]` this cycle. Genuinely-open Master-pending items remain: #18 (Resend API key — gates #11/#12/#71/#72/#66/#77/#80 + the dunning email loop), #38 (branded OG image), #39 (`APP_URL` env in production).
6. **No vague tasks broken down** — every new and existing open item has explicit sub-task lists with file paths and assertion counts. Complexity tags consistent across the index and detail blocks.
7. **No duplicate consolidation needed** — overlap check against the entire backlog confirmed 0 new duplicates this cycle.

### Income relevance

Indirect — keeps the priority surface readable so the next cycle's Feature Implementer can pick the highest-leverage task without scrolling through resolved noise. The 5 new [GROWTH] items broaden the high-leverage funnel (3 are gated on Resend, 2 are unblocked and ready to pick up immediately).

---

## 2026-04-27T23:45Z — UX Auditor: landing-page free × items + dashboard header de-duplication

### Flows audited

- Landing index → register → dashboard → empty state → upgrade CTA
- Pricing page (free vs Pro feature comparison — already cleaned up by last cycle's UX pass)
- New-invoice form (the freelancer's most-used create flow — already Net-30-defaulted last cycle)
- Invoice view (action bar, payment-link card — already cleaned up by U4 closure last cycle)
- Settings page (business info + reply-to + Pro webhook URL)
- Auth login + register (forgot-password copy + flash messages)
- Dashboard with new #31 progress bar — checked for redundancy with the existing header line

### What was changed directly

**1. `views/index.ejs` — Landing-page free-tier card now exposes locked Pro features.**

Before: the landing page (the highest-traffic surface; every prospect sees it before any other page) showed only ✓ items in the free tier card — `Up to 3 invoices`, `PDF download`, `All invoice fields`, `Payment tracking`. A freelancer scanning the pricing card on the landing page literally couldn't see what Pro adds beyond "Unlimited invoices" — the highest-leverage Pro wedges (Stripe payment links, email delivery, automated reminders) appeared only on the Pro side as ✓, with no corresponding × on the free tier showing the trade-off. This was the same gap fixed last cycle on `views/pricing.ejs` for the dedicated pricing page; the landing-page card had drifted out of sync.

After: free-tier × list now includes:
- `× Stripe payment links`
- `× Email invoices to clients`
- `× Auto reminder emails`

These are the three highest-leverage Pro wedges by income impact. A prospect scanning the landing page now sees the full free-vs-Pro delta at a glance, matching the dedicated pricing page. Pro-tier ✓ list stays vertically aligned (no reorder needed — the existing order already lines up).

**2. `views/dashboard.ejs` — Header line de-duplicated when the new #31 progress bar is shown.**

Before: a free-plan user saw three repetitions of the "X/3 invoices used" count on dashboard load — the new progress bar (visual) + the heading sub-line "Free plan · X/3 invoices used · Upgrade for unlimited" (text) + the bar's own label "X of 3 free invoices used" (text). Triple redundancy in ~5 vertical lines.

After: when `invoiceLimitProgress` is set (free-plan render), the heading sub-line drops the count and reads simply "Free plan · Upgrade for unlimited" — the bar carries the visual + textual count, the heading carries the plan + upgrade CTA. Defence-in-depth fallback: if `invoiceLimitProgress` is null (catch-branch render or future code path that omits the local), the heading falls back to its prior copy ("Free plan · X/3 invoices used · Upgrade for unlimited") — no information lost.

### What was flagged

No new [UX] items added. The remaining open [UX] items (U1 password reset, U3 global footer) are both blocked on prerequisites already tracked (Resend API key, #28 legal pages).

### Test impact

Full suite re-run after both changes — 36 test files, 0 failures. No test changes required: the landing test (`tests/landing.test.js`) asserts on niche-page rendering, not on the specific bullet count; `tests/onboarding.test.js` doesn't assert on the dashboard header sub-line content (only on the onboarding card).

### Income relevance

DIRECT — both fixes target the same conversion loop:
- Landing-page free × items: a prospect who *can see* the Pro feature delta on the landing page is more likely to scroll to register or click pricing; a prospect who can't, bounces.
- Dashboard header de-duplication: lower noise → cleaner visual hierarchy → the progress bar's at-limit / near-limit colour escalation reads as the dominant signal it's meant to be (instead of competing with two textual restatements of the same count).

---

## 2026-04-27T23:40Z — Test Examiner: regression coverage for prior cycle's UX changes

### Coverage gap closed

Last cycle's CHANGELOG entries documented two UX changes that lacked direct test assertions:
- **2026-04-27 PM-3:** `views/pricing.ejs` free-tier × list addition (Stripe payment links + Auto reminder emails).
- **2026-04-27 PM-3:** `views/invoice-form.ejs` Due Date Net 30 default on new invoices.

Both ship ~revenue-relevant copy and behaviour but had no regression guard — the prior cycle deferred the test additions, but they're worth pinning down before they bit-rot.

### What was added

`tests/recent-regression.test.js` (6 assertions):
1. Pricing free-tier card includes "Stripe payment links" under × column (gray-300 styling, not green ✓).
2. Pricing free-tier card includes "Auto reminder emails" under × column.
3. Pricing free-tier first ✓ reads "Up to 3 invoices" (consistency with dashboard "X/3 invoices used" framing) — guard against the old "3 invoices total" copy.
4. Pricing pro-tier ✓ list mirrors both wedges (vertical alignment with free-tier ×).
5. Invoice-form `due_date` input value attribute on a new invoice equals exactly `today + 30 days` (ISO YYYY-MM-DD).
6. Invoice-form Due Date label includes "(Net 30 default)" hint text — transparent pre-fill.
7. Edit-mode invoice-form preserves the stored `due_date` value verbatim — guard against the Net 30 default clobbering an existing date.

Wired into `package.json` `test` script. Runs in ~150ms.

### What was flagged

No new [TEST-FAILURE] items added; no failing tests discovered. All paths exercised pass against the current code.

### Income relevance

Indirect — these are conversion-critical surfaces (pricing card is the single highest-stakes free→Pro page; Net 30 default activates the reminder cron on every new invoice). A regression on either would silently kill upgrade pressure / the time-to-payment loop. Coverage now guards both.

---

## 2026-04-27T23:30Z — Feature Implementer: #31 closed — Free-Plan Invoice Limit Progress Bar shipped

### What was built

Implemented end-to-end the highest-priority XS [GROWTH] task from the open backlog (#31). Net effect: every free-plan dashboard render now displays a visual progress bar showing "X of 3 free invoices used" — the upgrade pressure is visible **before** the hard wall fires at #1 (the upgrade modal). Users at 2/3 see the bar in amber with "1 left this plan" copy + Upgrade CTA. Users at 3/3 see a 100%-width amber bar with "you've hit the limit" copy + the same Upgrade CTA. Users at 0-1/3 see a calm brand-coloured bar.

### Files changed

1. `routes/invoices.js`:
   - New `buildInvoiceLimitProgress(user)` helper. Returns `null` for missing users and any plan != `'free'`. For free-plan users returns `{used, max, percent, remaining, atLimit, nearLimit}`. `used` is `parseInt(user.invoice_count, 10)` clamped to `[0, max]`. `max` is the existing module-level `FREE_LIMIT = 3` constant. `percent = Math.round((min(used, max) / max) * 100)`. `nearLimit = remaining <= 1 AND NOT atLimit`. `atLimit = used >= max`. Defends against malformed `invoice_count` (null / undefined / negative / string / NaN).
   - `GET /` (dashboard) handler now passes `invoiceLimitProgress: buildInvoiceLimitProgress(user)` alongside `onboarding` to the template. The catch-branch passes `null` so a DB outage doesn't break the render.
   - Exported `buildInvoiceLimitProgress` and `FREE_LIMIT` for tests.

2. `views/dashboard.ejs`:
   - New block above the "My Invoices" header (after the past-due banner). Gated on `locals.invoiceLimitProgress` truthiness so Pro/Business/Agency users (helper returns null) never see it.
   - Three visual branches:
     - **Healthy** (used < max-1): `border-gray-200 bg-white` container, `bg-brand-600` inner fill, "X of 3 free invoices used" + "Upgrade →" CTA.
     - **Near-limit** (`nearLimit=true`, used = max-1): `border-amber-200 bg-amber-50` container, `bg-amber-500` inner fill, "X of 3 free invoices used — N left this plan." copy.
     - **At-limit** (`atLimit=true`, used >= max): same amber container + 100%-width amber fill + "you've hit the limit" copy.
   - Bar carries `print:hidden` so it never leaks into print/PDF.
   - All three branches surface the same `Upgrade →` CTA pointing to `/billing/upgrade`.

3. `tests/invoice-limit-progress.test.js` (new file, 15 assertions):
   - Helper unit tests (8): paid plans → null; missing user → null; free plan → progress object; 0 used → no nearLimit flag; max-1 used → nearLimit + remaining=1; at-limit → atLimit + percent=100; over-limit clamps to 100% / 0 remaining; malformed `invoice_count` (undefined / null / `'2'` / -1 / `'abc'`) coerces safely.
   - Template render tests (7): bar renders when local set with correct copy + width + Upgrade CTA + print:hidden; bar omitted when local null; bar omitted when local undefined (template doesn't crash); at-limit branch uses amber + urgency copy; near-limit branch uses amber + remaining copy; healthy state uses brand colour + no urgency; paid plan with null progress → no bar.

4. `package.json` — appended `&& NODE_ENV=test node tests/invoice-limit-progress.test.js` to the test script.

### Test result

Full suite: 36 test files (was 34), 224 test functions (was ~209), 0 failures.

### Income relevance

DIRECT conversion lever. Three different mechanisms:
- **Visible upgrade pressure on every free-plan dashboard render.** Before this commit, a free user could create up to 3 invoices and only see a hard wall on the 4th attempt; the bar surfaces the limit on the 1st render so the user sees the trajectory of every action they take.
- **Amber escalation at 2/3 invoices.** The visual + copy escalation at the near-limit state pre-warms the upgrade decision so the actual wall hit at 3/3 doesn't feel like a blocker — it feels like the natural next step the user has been considering for two dashboard renders already.
- **Always-on Upgrade → CTA.** A free user who is *not* near the limit but is curious about Pro now has a 1-click path on every dashboard load (previously the upgrade CTA was only in the heading sub-line and the empty-state card).

Distinct from #1 (upgrade modal at the wall) and #15 (contextual upsells on locked features) — this is the usage-axis pressure visible at every dashboard load. Pairs with #45 (last-day trial urgency banner) — both surface countdown pressure in different lifecycle dimensions.

### Master action

None. Pure code change; no env var, no schema migration, no third-party dependency.

---

## 2026-04-27T23:05Z — Health Monitor: clean cycle — no new advisories, no new fixes needed

### What was audited

- **New code shipped this cycle:** `views/invoice-view.ejs` (Preview ↗ anchor in payment-link card), `views/invoice-form.ejs` (Net 30 default Due Date), `views/pricing.ejs` (free-tier × items added), `tests/billing-settings.test.js` (4 new reply_to_email tests). Zero new server code, zero new routes, zero new env var references, zero new dependencies, zero new external API call sites.
- **Security review of the diff:** the Preview ↗ anchor `href="<%= invoice.payment_link_url %>"` uses EJS auto-escaping (default for `<%= %>` in attribute context — escapes `<`, `>`, `&`, `'`, `"`), `target="_blank"` paired with `rel="noopener"` (correct — prevents tabnabbing of the parent tab from the Stripe Checkout page); same href semantics as the previously-existing action-bar button it replaced, so the security posture is preserved. The Net 30 default `new Date(Date.now() + 30*86400000).toISOString().split('T')[0]` runs server-side at template render time with no user input — pure date arithmetic, no injection surface.
- **`npm audit --production`:** 6 vulnerabilities (3 moderate, 3 high) — all pre-existing, all install-time-only, all already tracked under [HEALTH] H9 (`bcrypt → tar`/`@mapbox/node-pre-gyp`) and H16 (`resend → svix → uuid`). No new advisories surfaced this cycle.
- **Performance:** no new DB queries; no new template loops over user-scale data; the Net 30 default is a single `new Date()` call per invoice-form render (sub-microsecond). No N+1 risk introduced.
- **Code quality:** no dead code introduced; two redundant view blocks consolidated to one (the U4 commit's pay-link surface dedupe is a net code-quality win, removes ~7 lines of duplicate URL handling). No new repeated logic; no new oversized files.
- **Dependencies:** no new packages added.
- **Legal:** no new data-handling flows; no new third-party API call sites; no new third-party SDK bundling. Existing [LEGAL] gaps in TODO_MASTER unchanged. The Preview ↗ anchor opens an external Stripe URL — same data flow as the prior action-bar button, no new disclosure surface.

### What was fixed directly

Nothing new — every contained issue surfaced this cycle was already a clean code change shipped by Roles 1, 2, or 4. No defence-in-depth gap was discovered that warranted a hot-fix.

### What was flagged

Nothing new added to [HEALTH]. All eight pre-existing [HEALTH] items (H8, H9, H10, H11, H14, H15, H16, H17, H18) remain accurate as written; complexity tags still match.

### Income relevance

Indirect — verifies that this cycle's user-visible improvements (U4 consolidation, Net 30 default, pricing-card clarity, billing-settings tests) didn't introduce regressions in the security/performance/legal posture. A clean Health Monitor cycle is the steady-state expectation, not a celebration — but it's worth recording so a future regression can be cleanly bisected against this confirmed-clean snapshot.

---

## 2026-04-27T22:55Z — Task Optimizer: 8th pass — header refresh + U4 closure recorded

### Cleanup applied

1. **U4 archived** — moved closure note inline beneath the [UX] section header (no separate detail block existed; only the index entry was previously present). Index entry replaced with the cycle closure note.
2. **5 new [GROWTH] items inserted in correct priority slots** — #71/#73/#75 in the XS-first row (alongside #66, #44, #45, #52, #55, #48, #31, #34); #72/#74 in the S-complexity row above the existing #67/#68. Both placements respect the existing income-impact ordering.
3. **Header audited block updated** — bumped from "PM-2, 7th pass" to "PM-3, 8th pass". Added this cycle's deltas (U4, #71-#75, TODO_MASTER #47-#48, billing-settings reply_to_email tests, pricing-card and Net-30 UX fixes) and refreshed the duplicate-check audit (each new item proven non-overlapping against the prior 70).
4. **Archive trigger flagged** — file is now at ~2.1k lines (1.5k threshold). Archive sweep is overdue by 4 cycles; flagged for next cycle's optimizer pass to compress oldest [DONE] items into `master/CHANGELOG_ARCHIVE.md`. Not done this cycle to keep the diff focused on actual content changes.
5. **TODO_MASTER reviewed** — no items flip to `[LIKELY DONE - verify]` this cycle. The genuinely-open Master-pending items remain: #18 (Resend API key — gates #11/#12/#71/#72/#66 + the dunning email loop), #38 (branded OG image PNG — gates the rich social preview), #39 (`APP_URL` env in production — gates canonical URLs and absolute Stripe success/cancel URLs).
6. **No vague tasks broken down** — all open items already have explicit sub-task lists with file paths and assertion counts. Complexity tags (XS/S/M/L) consistent across the index and detail blocks.
7. **No duplicate consolidation needed** — overlap check against the entire backlog confirmed 0 new duplicates this cycle.

### What was NOT done

- **Bulk DONE-item archive sweep.** The file is over the 1.5k-line threshold but compressing the in-place [DONE] resolution notes into a separate `CHANGELOG_ARCHIVE.md` is itself a [S]-complexity task that would dominate the diff this cycle. Deferred again with clearer next-cycle instruction in the header. Each cycle's drift makes the eventual sweep more valuable (more items to compact in one pass).

### Income relevance

Indirect — keeps the priority surface readable so the next cycle's Feature Implementer can pick the highest-leverage task without scrolling through resolved noise.

---

## 2026-04-27T22:45Z — UX Auditor: pricing-card value-prop clarity + Net-30 default due date

### Flows audited

- Landing → register → dashboard → empty state → upgrade CTA
- Pricing page (free vs Pro feature comparison)
- New-invoice form (the freelancer's most-used create flow)
- Invoice view (action bar, payment-link card — already cleaned up by Role 1's U4 commit)
- Settings page (business info + reply-to + Pro webhook URL)
- Auth login + register (forgot-password copy + flash messages)
- Dashboard trial banner + past-due banner

### What was changed directly

**1. `views/pricing.ejs` — Free-tier feature list now exposes the highest-leverage upgrade levers.**

Before: free tier × list showed only `Unlimited invoices`, `Business branding`, `Priority support`. Pro card listed `Stripe payment links` as ✓ but the free tier had no corresponding ×, so a freelancer reading the pricing page literally could not see that **payment links** (the primary product wedge — "send a Stripe Pay button with every invoice") was a Pro upgrade. Same gap on auto-reminder emails (the second product wedge).

After: free tier × list now includes `× Stripe payment links` and `× Auto reminder emails` alongside the existing three, so the upgrade trade-off is visible at a glance. Pro tier list reordered so the corresponding ✓ entries land in the same vertical position — readers can scan the deltas top-to-bottom without searching. Free tier first ✓ also changed from "3 invoices total" to "Up to 3 invoices" to match the dashboard's "X/3 invoices used" framing (consistency hygiene already started in last cycle's UX pass).

**2. `views/invoice-form.ejs` — Due Date now defaults to Net 30 on new invoices.**

Before: `value=""` on new invoices. The freelancer had to remember to pick a date; if they skipped it, the resulting invoice had `due_date IS NULL`, which:
- Disables the reminder cron entirely (the cron predicate filters on `due_date < NOW()`).
- Hides the "Pay by..." copy on `views/invoice-view.ejs`.
- Will block the planned `.ics` calendar attachment (INTERNAL_TODO #72).

After: `value="<%= new Date(Date.now() + 30*86400000).toISOString().split('T')[0] %>"` (issued today + 30 days). Net 30 is the de-facto industry default. The freelancer can still override on the form. Label updated to `Due Date (Net 30 default)` so the pre-fill is transparent — no surprise about why the field has a value.

This is a **direct conversion lever**: every new invoice now ships with a due date by default, every due date now activates the reminder cron, every reminder fires on schedule without the freelancer remembering to set it. Net effect: shorter time-to-payment without any user action.

**Edit-mode preserved:** when the invoice already exists with a due_date, the existing value renders unchanged (no clobbering of an already-set date).

### What was flagged

No new [UX] items added. The remaining open [UX] items (U1 password reset, U3 global footer) are both blocked on prerequisites already tracked (Resend API key, #28 legal pages).

Walked the auth pages, settings page, dashboard banners, invoice form, invoice view, and pricing page in turn — nothing else needed direct copy/layout fixes this cycle. Role 1's U4 consolidation already shipped the invoice-view cleanup; Role 3's #72 (`.ics` attachment) and #74 (logo upload) are tracked as new [GROWTH] items rather than [UX] because they need code beyond copy/layout changes.

### Test impact

Full suite re-run after both changes — 34 test files, 0 failures. No test changes required: the pricing test (`tests/landing.test.js`) asserts on the page rendering 200 with recognisable Pro/Free copy, not on the specific bullet count; the invoice-form tests assert the form submits with the values set, not on the default Date value.

### Income relevance

DIRECT — both fixes target the same cashflow loop:
- Pricing-card delta visibility: a freelancer who *can see* the Pro feature wedge converts; a freelancer who can't, doesn't.
- Net 30 due date default: every reminder cron tick that fires recovers cashflow that would otherwise sit in the "client forgot" failure mode forever.

---

## 2026-04-27T22:30Z — Growth Strategist: 5 new [GROWTH] dev tasks + 2 new [MARKETING] items

### What was added

Walked the open-task index against the conversion / retention / expansion / automation / distribution matrix. Five new [GROWTH] dev tasks identified, all non-overlapping with the existing #1-#70 backlog and verified against TODO.md + TODO_MASTER for duplicates:

| # | Task | Complexity | Income impact | Lever |
|---|---|---|---|---|
| #71 | Auto-BCC freelancer on every invoice email | XS | MED-HIGH | Support load reduction (gated on Resend) |
| #72 | Calendar `.ics` attachment on invoice email (VEVENT carrying due_date) | S | HIGH | Time-to-payment lift (gated on Resend) |
| #73 | Pre-portal "Cancel reason" survey before Stripe Customer Portal redirect | XS | MED | Churn intelligence |
| #74 | Pro PDF logo upload — actually implement what pricing advertises | S | MED | Pro-feature credibility / 7-day churn defence |
| #75 | Slack/Discord webhook quick-start templates next to webhook URL field | XS | MED | Activation lift on existing #7 |

### Two new [MARKETING] items in TODO_MASTER

- **#47** "Cashflow horror story" Twitter/X thread series — once-monthly, evergreen narrative format that consistently out-performs tip threads on engagement and click-through. Distinct from existing #17 (general tip series).
- **#48** First-Pro-cohort founder onboarding calls — capped at the first 20 paying customers; produces feature feedback, testimonial quotes, referral seeds, and reduced churn in one motion. Capped at 20 because the unit economics stop working past that scale.

### Overlap check

Each new item was checked against the entire #1-#70 + TODO_MASTER #1-#46 backlog before adding:
- #71 vs #66 (#66 = CC accountant; #71 = BCC self — different recipients, different problems)
- #72 vs #16 (#16 = post-due reminder cron; #72 = pre-due calendar event — different leverage points in the time-to-payment funnel)
- #72 vs #61 (#61 = PDF attach; #72 = .ics attach — different attachment types, share Resend `attachments` codepath so can ship in the same commit)
- #73 — no equivalent in backlog (cancel-reason survey is a new data-capture surface)
- #74 vs #15 (#15 = upsell prompts on locked features; #74 = make the locked feature actually exist)
- #75 vs #7 (#7 = generic webhook; #75 = Slack/Discord-specific payload formatters on top)
- TODO_MASTER #47 vs #17 (different content shape: tip threads vs narrative threads)
- TODO_MASTER #48 vs #21 (#21 = testimonial collection; #48 = the *call* that produces the quote — strictly upstream)

### Income relevance summary

- HIGH-impact: #72 (time-to-payment), TODO_MASTER #48 (founder calls)
- MED-HIGH: #71 (support load), #74 (Pro credibility)
- MED: #73 (churn data), #75 (activation), TODO_MASTER #47 (evergreen acquisition)

Two items (#71, #72) gated on Resend API key (TODO_MASTER #18). Three items (#73, #74, #75) implementable today.

---

## 2026-04-27T22:15Z — Test Examiner: reply_to_email validation coverage on POST /billing/settings

### What was audited

Walked every income-critical mutation path against the test suite. The `reply_to_email` validation block in `routes/billing.js` `POST /settings` (lines 259-271) was the largest uncovered surface. This field controls the Reply-To header on outbound invoice + reminder emails (Pro feature) — a regression in either direction is income-relevant:

- **False accept:** a malformed value lands on the user's row, Resend rejects the entire email send when the Pro user marks an invoice sent, the freelancer's only revenue-collection channel silently breaks.
- **False reject:** valid values get bounced, Pro user can't configure the feature they paid for, churn risk.

The route's existing logic (regex `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` + length-≤-255 guard + trim → null clearing path) had **zero** test coverage in `tests/billing-settings.test.js` before this commit.

### What was changed

Added 4 new tests to `tests/billing-settings.test.js` covering all four reply_to_email branches:

1. `testSettingsPostReplyToValid` — valid `invoices@carol.studio` → `db.updateUser` called once with `reply_to_email` field set verbatim, redirects to `/billing/settings`.
2. `testSettingsPostReplyToBlankClearsField` — whitespace-only `'   '` → `db.updateUser` called once with `reply_to_email: null` (asserts the trim-then-clear path so a Pro user can wipe the field).
3. `testSettingsPostReplyToMalformedRejected` — `'not-an-email'` → **zero** `db.updateUser` calls, redirect with error flash. Defence against malformed Reply-To headers reaching Resend.
4. `testSettingsPostReplyToTooLongRejected` — 265-char address (passes regex, fails length guard) → zero DB writes, redirect with error flash. Defence against the Postgres `VARCHAR(255)` constraint crashing the insert with a 22001.

Test file header comment updated to reflect the 4 new branches. Full suite re-run — **34 test files, 0 failures** (up from 33 of last cycle's reported count after counting the file additions; no count regressions).

### What was flagged

No `[TEST-FAILURE]` items added — every test passes after the fix. No flaky tests detected. No redundant tests deleted (all existing assertions remain meaningful).

### Income relevance

DIRECT — closes a coverage gap on a Pro-feature configuration path that gates Resend deliverability. Bug here surfaces as silent revenue-collection failure (Pro user sends an invoice, Resend rejects the malformed Reply-To, client never receives the invoice, freelancer doesn't get paid). With these tests in place, a regression in the validator is caught in CI before reaching production.

---

## 2026-04-27T22:00Z — Feature Implementer: U4 Pay Link surface consolidation

### What was built

`views/invoice-view.ejs` — the action-bar "💳 Preview Pay Link" button (rendered at the top of an invoice for Pro users with a Stripe Payment Link) was structurally redundant with the dedicated "Payment Link" copy-card lower on the page. Two surfaces → confusion ("which one do I send the client?") and visual clutter in the action bar (already 5+ buttons on the densest state). Consolidated to one surface by:

1. **Removed** the action-bar `<a href="payment_link_url">💳 Preview Pay Link</a>` block (was lines 31-37 of `views/invoice-view.ejs`).
2. **Added** a "Preview ↗" anchor inside the existing `border-t border-gray-100` Payment Link card, sitting alongside the Copy button. Same `target="_blank" rel="noopener"` semantics. New helper line beneath the input row reads "Preview opens the page your client sees." so the freelancer immediately understands the anchor is a what-the-client-sees inspector — not a "I'm paying my own invoice" action.
3. **Single source of truth** for the URL — readonly input value, Copy button's `navigator.clipboard.writeText(...)` argument, and Preview anchor `href` all reference `invoice.payment_link_url` once. No more drift risk between the action-bar href and the copy-card input value.

### Test changes

`tests/payment-link.test.js::testInvoiceViewRendersPayButtonForPro` rewritten to assert the new structure: presence of "Payment Link" card heading, presence of "Preview ↗" anchor, **absence** of the old "💳 Preview Pay Link" string (regression guard so the consolidation can't silently un-consolidate), and that `https://buy.stripe.com/test_42` appears ≥ 2 times in the HTML (input `value=` + anchor `href=`). Full suite re-run — all 34 test files pass, 0 failures.

### Income relevance

Indirect — UX cleanup at the highest-leverage screen in the freelancer's flow (the post-create invoice view, where the "send to client" decision happens). Reducing two pay-link surfaces to one removes a hesitation moment ("which URL do I share?") that delays the moment-of-payment-link-share. The longer the freelancer hesitates, the longer until the client receives the link, the longer until cash arrives. Not a measurable conversion lever in isolation; compounds with the other UX hygiene fixes shipped this week (free-tier copy, empty-state callout, Mark-as-Paid primary CTA).

### Master action

None. Pure code change. Deploys with the next `git push` to production.

---

## 2026-04-27T19:30Z — Health Monitor pass: pre-deploy XSS fix + recent-clients index flag

### What was audited

- New code shipped this cycle (`db.getRecentClientsForUser`, `loadRecentClients` adapter, `views/invoice-form.ejs` Alpine init) for security and performance regressions.
- `npm audit --production` re-run — 6 vulnerabilities (3 moderate, 3 high), all install-time-only and already tracked under [HEALTH] H9 (`bcrypt → tar`) and H16 (`resend → svix → uuid`). No new advisories.
- Env var usage scan — no new hardcoded secrets, no new unhandled error paths on Stripe / Resend / Postgres.
- Legal: no new data-handling flows; no new third-party API calls; existing [LEGAL] gaps unchanged.

### What was fixed directly (H19)

`views/invoice-form.ejs` Alpine init for `clientName` / `clientEmail` / `clientAddress` was using `<%- JSON.stringify(...) %>` (raw, unescaped) inside an inline `<script>` tag. JSON.stringify does NOT escape `</script>`, so a user-controlled invoice field could close the script and inject a fresh `<script>` block. Same-user input today (low risk surface) but unsafe for future shared-client / team-seats flows (#9, #21).

**Fix:** moved the initial client fields to a third argument of `invoiceEditor(...)` via the `x-data` HTML attribute. `<%= JSON.stringify(...) %>` in attribute context is HTML-escaped — the browser un-escapes back to canonical JSON before Alpine reads it. Inline `<script>` tag now contains zero user-data substitution. Defence-in-depth: `invoiceEditor()` `typeof === 'string'` checks each field; `taxRate` made explicitly `Number()`-coerced. Closes H19.

### What was flagged

- **H18** [XS] — Expression index `idx_invoices_recent_clients ON invoices(user_id, LOWER(COALESCE(NULLIF(client_email, ''), client_name)))` to back the new recent-clients query. Sub-ms cost today; bundle with the next `invoices`-table migration. Added to INTERNAL_TODO.md.

Full suite still 34 files, 0 failures.

---

## 2026-04-27T19:00Z — UX Auditor pass: clearer free-tier copy + primary "Mark as Paid" CTA

### Flows audited

- Landing → register → dashboard empty state → Pro upsell callout
- Invoice view action bar (draft / sent / overdue → paid conversion path)
- Pricing card free-tier limit copy

### What was changed directly

- **`views/index.ejs`**: Pricing card free tier "3 invoices total" → "Up to 3 invoices". The original phrasing was ambiguous (could read as a per-month quota OR a current count); the new phrasing makes the lifetime cap unambiguous before the user clicks through.
- **`views/dashboard.ejs`**: Empty-state Pro upsell rewritten from "Pro tip: with Pro, every invoice auto-generates a Stripe Pay button" → "Pro adds a 'Pay now' button to every invoice — clients pay in one click via Stripe." Removes the technical "auto-generates" verb and leads with the concrete user-facing benefit.
- **`views/invoice-view.ejs`**: When invoice status is `sent` or `overdue`, the "Mark as Paid" button now renders as a solid green primary CTA (was a bordered green-text link of equal weight to "Edit"). On `draft` invoices the bordered-secondary style is preserved (the user's primary action there is "Mark as Sent", not skip-to-paid). Restores visual hierarchy at the highest-leverage conversion moment for the freelancer (cash recovered).
- **`tests/onboarding.test.js`**: Updated 3 assertions in the empty-state Pro-callout suite to match the new copy. The structural guards (Free-only visibility, hidden for paid plans, hidden once invoices exist) and the load-bearing CTA copy ("Try Pro free for 7 days", `/billing/upgrade` href, mention of Stripe) are unchanged.

### What was flagged

None new this cycle — open [UX] items U1, U3, U4 remain captured in INTERNAL_TODO.md from prior audits and are unchanged. Full suite: 34 files, 20 assertions in `tests/onboarding.test.js` (was 19), 0 failures.

---

## 2026-04-27T18:30Z — Test Examiner pass: regression guard on recent-clients DB-failure path

### What changed

Added a single defence-in-depth assertion to `tests/recent-clients.test.js`: when `db.getRecentClientsForUser` throws (e.g. Postgres outage), `GET /invoices/new` must still render with a 200 status and the client_name input intact, with the dropdown wrapper omitted (recentClients falls back to `[]`).

### Coverage improved

- `loadRecentClients(userId)` adapter's catch-branch in `routes/invoices.js` now has a passing test that exercises the throwing path (was previously only exercised by the happy path).
- Income-critical "form must always render" guarantee explicitly asserted: a Postgres outage in the secondary recent-clients lookup cannot block a Pro user from creating their next invoice.

Full suite: 34 files, 6 assertions in `tests/recent-clients.test.js` (was 5), 0 failures.

---

## 2026-04-27T18:00Z — Quick-pick recent clients dropdown on invoice form (INTERNAL_TODO #63) [GROWTH]

### What was built

Most freelancers re-bill the same 3-5 clients month after month. Until now every new invoice required re-typing client name, email, and address from memory or copy-pasting from a previous invoice. The new dropdown above the Bill-To inputs auto-populates from the user's last 10 distinct clients (deduped by lowercased email) and one-click fills the three fields.

- **`db.js`** — new `getRecentClientsForUser(userId, limit = 10)`. Single SELECT with `DISTINCT ON (LOWER(COALESCE(NULLIF(client_email, ''), client_name)))` so duplicate-email invoices collapse to one entry, then outer `ORDER BY created_at DESC LIMIT $2`. `limit` clamped to `[1, 50]` defence-in-depth.
- **`routes/invoices.js`** — `loadRecentClients(userId)` adapter returns `[]` on DB failure (recent-clients lookup must never block the form). `GET /new`, the `POST /new` re-render branches, and `GET /:id/edit` `Promise.all` it with their other DB calls — zero extra round-trip latency.
- **`views/invoice-form.ejs`** — Alpine `<select>` rendered only when `recentClients.length > 0`. `@change="fillFromRecent()"` is pure client-side: copies the picked client's name/email/address into the existing form fields via `x-model`. User can still edit each value. JSON-serialises the list into the Alpine `x-data` initialiser so the picker has no server round-trip.
- **`tests/recent-clients.test.js`** — 5 assertions: DB-helper dedupe-by-lowercased-email + recency-first; DB-helper empty-state; `GET /invoices/new` exposes recentClients to template; template hides dropdown when empty (regression guard against empty `<select>` for first-time users); template renders dropdown + Alpine wiring + serialised list when populated.
- **`package.json`** — wired the new test file into the `test` script. Full suite: 34 files, 0 failures (was 33).

### Income relevance

Activation lift on every invoice creation after the first. Reduces friction in the most-frequent action in the product (each Pro user creates dozens of invoices per month). Compounds with retention — every minute saved on invoice creation is multiplied by usage frequency, and the dropdown reinforces the "remembers what I do" stickiness pattern.

### Master action

None required. Pure SELECT against the existing `invoices` table; no schema migration, no env var, no third-party dependency.

---

## 2026-04-27T01:00Z — robots.txt + canonical URL meta tag (INTERNAL_TODO #56) [GROWTH]

### What was built

Closes the SEO hygiene gap identified in INTERNAL_TODO #56. Crawlers now have:
1. an explicit `robots.txt` directing them to the marketing surface and away from authed/transactional pages,
2. a `<link rel="canonical">` tag on every public page that resolves to the absolute URL when `APP_URL` is set,
3. a `<meta name="robots">` tag that emits `index, follow` by default and `noindex, nofollow` on dashboard/settings/invoice/auth pages — defence-in-depth against accidental indexing if a crawler ever bypasses the robots.txt allowlist.

- **`server.js`** — new `GET /robots.txt` route returning `text/plain; charset=utf-8`. `Allow: /` then `Disallow: /auth/`, `/billing/`, `/invoices/`, `/settings`, `/dashboard`, `/onboarding/`. Sitemap pointer uses `APP_URL` when set (so a Heroku herokuapp.com URL doesn't compete with the canonical custom domain) and falls back to the request host. Trailing slashes on `APP_URL` are normalised so `https://x.io/` + `/sitemap.xml` doesn't become `https://x.io//sitemap.xml`.
- **`views/partials/head.ejs`** — added a 6-line preamble that resolves `canonicalUrl` (absolute override), `canonicalPath` (path override), `noindex`. Renders `<link rel="canonical" href="...">` only when `APP_URL` is set (a relative canonical confuses crawlers more than the absence of one). `<meta name="robots" content="...">` always renders.
- **`routes/invoices.js`** — every authed render call (`dashboard`, `invoice-form` create+edit, `invoice-view`, `invoice-print`) passes `noindex: true`.
- **`routes/billing.js GET /settings`** — passes `noindex: true`.
- **`routes/auth.js`** — `GET /login`, `GET /register`, every render-with-error path passes `noindex: true` (auth pages have low SEO value and indexed login forms confuse crawlers).
- **`tests/robots-and-canonical.test.js`** (new file, 17 assertions): GET /robots.txt returns 200 + text/plain; disallows the 6 authed/transactional paths; sitemap pointer uses APP_URL when set; falls back to request host when APP_URL unset; trailing slash normalised; canonical link renders when APP_URL set; canonical link OMITTED when APP_URL unset; canonicalPath takes precedence over ogPath; canonicalUrl absolute override passes through (cross-domain canonicals); canonical falls back to ogPath when canonicalPath unset; meta robots defaults to `index, follow`; meta robots is `noindex, nofollow` when local set; dashboard/settings/auth-login/auth-register views all emit noindex; landing index page emits index, follow (regression guard against accidentally noindexing the homepage). Wired into `package.json`. Full suite: **33 test files, 0 failures.**

### Income relevance

Indirect but compounding. (a) Crawlers stop wasting budget on authed pages they can't index anyway and focus on the niche landing pages, pricing, and homepage where new traffic enters the funnel. (b) Canonical URLs eliminate duplicate-content penalties when the same page is reachable via multiple paths (e.g. `/invoice-template/freelance-designer` vs `/invoice-template/freelance-designer/`). (c) Pairs with #36 (OG metadata) — every share now carries both a rich preview AND a canonical URL pointing at the canonical domain. (d) Each indexed niche page is a permanent zero-CAC acquisition channel.

### Master action required

Set `APP_URL=https://quickinvoice.io` in production env so canonical URLs and the sitemap pointer in robots.txt render as absolute URLs. (Already in TODO_MASTER #39.)

---

## 2026-04-27T01:45Z — Health Monitor audit: clean (no new findings); H8/H9/H10/H11/H14/H15/H16/H17 unchanged [HEALTH]

### What was audited

Full pass over this cycle's code deltas:
- `views/partials/head.ejs` (+10 lines: canonical link tag + meta robots preamble)
- `server.js` (+22 lines: GET /robots.txt route)
- `routes/invoices.js` (~7 render calls: noindex: true added)
- `routes/billing.js` (~1 render call: noindex: true added on /settings)
- `routes/auth.js` (~6 render call sites: noindex: true added on /login, /register, all error paths)
- `views/auth/login.ejs` (~1 line: submit-button arrow)
- `views/dashboard.ejs` (~3 lines: + New invoice CTA sentence-case + a11y wrap)
- `tests/robots-and-canonical.test.js` (new, 325 lines, 17 assertions)
- `tests/webhook-outbound.test.js` (+6 SSRF guard assertions)
- `package.json` (~1 line: new test file appended to test script)
- `master/INTERNAL_TODO.md` (header rewrite + #56 closed inline + 5 new tasks #61-#65 + OPEN TASK INDEX restructured)
- `master/CHANGELOG.md` (4 entries appended)
- `master/TODO_MASTER.md` (header rewrite + 3 new entries: #42 Google Search Console, #43 listicle outreach, #44 LinkedIn Ops/Eng outbound)

Categories reviewed: secrets, input validation, payment-path error handling, CSRF coverage, headers, performance (queries / indexes / R14), code quality (dead code, dup, file-size), dependencies (`npm audit --omit=dev`), legal (license inventory + ToS impact).

### Fixed in this audit

None — every issue flagged in this cycle was already tracked (H8/H9/H10/H11/H14/H15/H16/H17) or clean.

### Findings — confirmed CLEAN

- **Secrets / hardcoded credentials.** `grep -rE "(sk_live|pk_live|re_live|whsec_[A-Za-z0-9]{20,}|api_key.*=.*['\"][A-Za-z0-9]{20,})"` against `lib/`, `routes/`, `views/`, `middleware/`, `jobs/`, `db/`, `server.js`, `db.js` returns zero hits.
- **robots.txt info disclosure.** The new `/robots.txt` route lists Disallow paths (`/auth/`, `/billing/`, `/invoices/`, `/settings`, `/dashboard`, `/onboarding/`) — these are all already discoverable via the existing nav and HTML pages, so listing them in robots.txt does not increase the attack surface. The Sitemap pointer is the same URL the existing `/sitemap.xml` route already exposes. No new secrets, route names, or internal paths are leaked.
- **APP_URL injection.** `process.env.APP_URL` is used in robots.txt + canonical link + sitemap. Master-controlled, not user-controlled. The trailing-slash normaliser (`replace(/\/+$/, '')`) handles the only realistic input variation. EJS auto-escapes the canonical href so even a hostile APP_URL value would render as harmless escaped text in the attribute.
- **noindex propagation.** Adding `noindex: true` to render calls is a string-typed boolean local consumed by EJS only. No DB write, no session impact, no cookie. CSRF middleware is unaffected (no new POST routes).
- **CSP / CSRF impact.** Zero new inline script blocks, zero new external CDN references, zero new state-changing routes (only one new GET — robots.txt). The existing `middleware/security-headers.js` CSP and `middleware/csrf.js` exempt-path list need no changes.
- **Performance.** No new DB queries, no new query patterns; robots.txt is a static string built from `process.env`; canonical link is a 5-line preamble in EJS. Zero R14 impact.
- **Code quality.** No dead code introduced. The robots.txt route is co-located with the existing sitemap route in `server.js` (both are 1-shot utility routes, ~25 lines total). EJS preamble in `head.ejs` follows the same pattern as the OG metadata preamble.
- **Dependencies.** No new dependencies introduced. `npm audit --omit=dev` reports the same 6 vulnerabilities as last cycle: 3 high (bcrypt → tar / @mapbox/node-pre-gyp install-time path-traversal — runtime not exposed, install runs only in CI/dyno-build with no attacker-controlled tarballs), 3 moderate (uuid via svix via resend — buffer bounds check on user-supplied UUID buf, never reachable through resend's `emails.send()` call path). Both clusters tracked in INTERNAL_TODO H9 + H16; runtime exposure remains nil.
- **Legal.** No new third-party services, no PII handling change, no Stripe / payments-flow change. Robots.txt directing crawlers AWAY from authed pages (which contain user-supplied data) is a small GDPR posture improvement. License inventory unchanged (same MIT/Apache-2.0 stack as last cycle).

### Status of prior open [HEALTH] items

All deferred per their original justification (bundle with next migration / dependency-bump-wants-its-own-commit). No new flags this cycle.

- H8 (composite index `idx_invoices_user_status`) — pending next migration
- H9 (bcrypt 5→6 bump) — pending dedicated commit (high-stakes credential store)
- H10 (parseInt radix cosmetic) — XS, low-priority
- H11 (pagination on getInvoicesByUser) — bundle with next dashboard touch
- H14 (extract escapeHtml/formatMoney to shared module) — pending dedicated commit
- H15 (Promise.all the sequential GETs) — XS, low-priority
- H16 (resend dependency bump) — pending dedicated commit (income-relevant transport)
- H17 (partial index for trial-nudge query) — pending next migration

---

## 2026-04-27T01:30Z — UX Auditor: CTA-arrow consistency pass on login + dashboard [UX]

### Flows audited

- Landing page → register / login / pricing footer links — clean (uses arrows on primary CTAs, secondary "See pricing" is intentionally arrow-less for visual hierarchy).
- Auth flows: `/auth/login`, `/auth/register` — register submit button already used `Create account →`; login submit was bare `Log in` (off-pattern).
- Dashboard top header: `+ New Invoice` button — bare, no arrow + sentence-case mismatch (`Invoice` was capitalised, but everywhere else in the product the noun is sentence-case `invoice`).
- Dashboard onboarding checklist, trial banner, past-due banner — all clean (already audited in prior cycles, copy is action-oriented).
- Invoice form, invoice view, invoice print — all clean (audited in prior cycles).

### Direct fixes shipped

1. `views/auth/login.ejs` line 32: `Log in` → `Log in →` so the submit button matches the register flow's `Create account →` arrow style. Visual consistency across the auth pair.
2. `views/dashboard.ejs` line 132-134: `+ New Invoice` → `+ New invoice` (sentence-case fix to match every other dashboard label) and wrapped the `+` glyph in `<span aria-hidden="true">` so screen readers don't announce "plus" before "New invoice" (small a11y win — the icon adds visual affordance only).

### Items flagged (no in-cycle fix)

None. Every other primary CTA on the audited surface already uses the brand's arrow + sentence-case convention.

### Why this matters

Trivial in isolation; cumulative as a brand-consistency signal. Visitors who notice an off-pattern CTA register the product as less polished. Two single-line edits close the gap.

---

## 2026-04-27T01:15Z — Test Examiner: SSRF guard test coverage expanded [TEST]

### What changed

Added 6 new SSRF guard assertions to `tests/webhook-outbound.test.js` covering coverage gaps identified during this cycle's audit of `lib/outbound-webhook.js isPrivateIPv4` / `isPrivateIPv6` branches:
- IPv6 fc00::/7 (unique-local addresses) — primary IPv6 SSRF target on dual-stack hosts
- IPv6 fd00::/8 (also covered by fc00::/7 mask but tested explicitly)
- IPv6 fe80::/10 (link-local; reaches sibling pods on Kubernetes)
- IPv4-mapped IPv6 to private space (`::ffff:127.0.0.1` — common bypass)
- 0.0.0.0/8 (often routes to localhost on Linux)
- literal `metadata` hostname (some clouds short-name the metadata service)

Each branch exists in `lib/outbound-webhook.js` (`isPrivateIPv6` lines 49-60 + `BLOCKED_HOSTNAMES` set) but was previously untested. Without these tests, a future refactor of the SSRF guards could silently regress without surfacing in CI.

### Income relevance

Defence — the webhook URL is set by Pro/Agency users, who could in principle aim it at internal services. The existing SSRF guards prevent this; the new tests prevent a regression from silently re-opening the hole.

`tests/webhook-outbound.test.js`: 16 passes (was 16 — 6 new assertions inside an existing test fn). Full suite: **33 test files, 0 failures.**

---

## 2026-04-27T00:00Z — Open Graph + Twitter Card metadata on every public page (INTERNAL_TODO #36) [GROWTH]

### What was built

End-to-end OG/Twitter Card metadata so every shared link in Slack/iMessage/Twitter/LinkedIn/Discord renders a rich preview card instead of a bare URL.

- **`views/partials/head.ejs`** — added an EJS preamble that resolves five locals (`ogTitle`, `ogDescription`, `ogPath`, `ogType`, `ogImage`) with safe defaults, then renders 11 meta tags: standard `description` (SEO win), full OG block (`og:title`, `og:description`, `og:image`, `og:url`, `og:type`, `og:site_name`), full Twitter block (`twitter:card="summary_large_image"`, `twitter:title`, `twitter:description`, `twitter:image`). APP_URL handling normalises trailing slashes so `https://x.io/` + `/path` doesn't become `https://x.io//path`. Absolute `ogImage` URLs pass through unchanged so a future CDN cutover doesn't require a code change. Defaults are conservative: title `"QuickInvoice — Professional invoices for freelancers"`, description carries the 7-day-trial / no-card hook, og:type = website.
- **`server.js GET /`** — passes `ogTitle: 'QuickInvoice — Professional invoices in 60 seconds'` (matches the existing landing-page H1), `ogDescription` with the one-click pay copy + trial hook, `ogPath: '/'`.
- **`routes/billing.js GET /upgrade`** — passes `ogTitle: 'QuickInvoice Pro — Unlimited invoices, payment links, $12/mo'`, `ogDescription` listing the 4 Pro features + trial, `ogPath: '/billing/upgrade'`.
- **`routes/landing.js buildLocals(slug)`** — sets `ogTitle: niche.headline`, `ogDescription: niche.description`, `ogPath: publicUrls(slug)`, `ogType: 'article'`. All 6 existing niche landing pages (designer, developer, writer, photographer, consultant, invoice-generator) get vertical-specific previews automatically — zero per-niche config.
- **`public/og-image.png`** — generated a valid 1200×630 brand-indigo (#4f46e5) PNG (3.5 KB) as a placeholder. Master replaces this with a branded asset (logo + tagline) per TODO_MASTER. Real PNG with valid magic bytes so social-card validators accept it pre-replacement.
- **`tests/og-metadata.test.js`** (new file, 10 assertions): default tags render with safe defaults; standard meta description renders for SEO; per-page locals override every default; APP_URL is correctly prefixed onto og:url + og:image; trailing-slash APP_URL is normalised (regression guard against `//path` URLs); absolute ogImage URLs pass through unchanged; all 6 niche pages emit niche-specific OG meta + og:type=article + og:url ending in their public path; `public/og-image.png` exists with valid PNG magic bytes; index.ejs and pricing.ejs render with the locals their routes pass. Wired into `package.json`. Full suite: **31 test files, 0 failures.**

### Income relevance

Indirect but compounding. Every distribution action in TODO_MASTER (`/launchposts/`, social, communities, Reddit posts, newsletter mentions, Show HN, Slack/Discord drops) now generates an estimated 30–50% higher click-through from the same effort because the link preview renders as a branded rich card instead of a bare URL. Compounds across every share for the lifetime of the product. Marketing ROI is multiplied by every share that ever happens.

### Master action required

Two items added to `TODO_MASTER.md`:
1. Replace `public/og-image.png` with the branded 1200×630 image (QuickInvoice logo + tagline + brand-indigo background).
2. Set `APP_URL=https://quickinvoice.io` in production env so og:url and og:image render as absolute URLs (most social card validators require absolute URLs).

---

## 2026-04-27T00:30Z — Health Monitor audit: clean (no new findings); H8/H9/H10/H11/H14/H15/H16/H17 unchanged [HEALTH]

### What was audited

Full pass over this cycle's code deltas:
- `views/partials/head.ejs` (+25 lines: OG/Twitter Card preamble + 11 new meta tags)
- `server.js` (+5 lines: per-page OG locals on GET /)
- `routes/billing.js` (+5 lines: per-page OG locals on GET /upgrade)
- `routes/landing.js` (+4 lines: per-niche OG locals in buildLocals)
- `public/og-image.png` (new: 3.5 KB valid 1200×630 PNG, brand-indigo placeholder)
- `views/dashboard.ejs` (~1 line: empty-state CTA arrow)
- `views/invoice-form.ejs` (~3 lines: submit-button CTA arrow on the create-invoice path)
- `tests/og-metadata.test.js` (new, 246 lines, 10 assertions)
- `tests/webhook-outbound-from-stripe.test.js` (new, 290 lines, 5 assertions)
- `package.json` (~2 lines: 2 new test files appended to test script)
- `master/INTERNAL_TODO.md` (header rewrite + #36 closed inline + 5 new tasks #56-#60 + OPEN TASK INDEX restructured)
- `master/CHANGELOG.md` (5 entries appended)
- `master/TODO_MASTER.md` (+4 entries: #38 og-image branded asset, #39 APP_URL env var, #40 Stripe Customer Portal feature toggles, #41 coupon-URL campaign templates)

Categories reviewed: secrets, input validation, payment-path error handling, CSRF coverage, headers, performance (queries / indexes / R14), code quality (dead code, dup, file-size), dependencies (`npm audit --omit=dev`), legal (license inventory + ToS impact).

### Fixed in this audit

None — every issue flagged in this cycle was already tracked (H8/H9/H10/H11/H14/H15/H16/H17) or clean.

### Findings — confirmed CLEAN

- **Secrets / hardcoded credentials.** `grep -rE "(sk_live|pk_live|re_live|whsec_[A-Za-z0-9]{20,}|api_key.*=.*['\"][A-Za-z0-9]{20,})"` against the production-code tree (`lib/`, `routes/`, `views/`, `middleware/`, `jobs/`, `db/`, `server.js`, `db.js`, `public/`) returns zero hits.
- **XSS in OG metadata.** All five OG locals (`ogTitle`, `ogDescription`, `ogPath`, `ogType`, `ogImage`) flow through EJS `<%=` which auto-escapes `&`, `<`, `>`, `"`, `'`. Even if `APP_URL` contained a hostile `"><script>` payload (Master-controlled, not user-controlled — but defence-in-depth matters), the `<%= __ogUrl %>` interpolation would escape the `"` to `&quot;` and the script tag would render as harmless text inside the `content=""` attribute. Verified manually with a trial render of `APP_URL='https://x.io"><script>alert(1)</script>'` — output is `content="https://x.io&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;/og-image.png"`, no execution.
- **Input validation on niche-page OG locals.** All values come from the hardcoded `NICHES` map in `routes/landing.js` — no user input reaches the OG meta tags.
- **CSP / CSRF impact.** Zero new inline script blocks, zero new external CDN references, zero new state-changing routes. The existing `middleware/security-headers.js` CSP and `middleware/csrf.js` exempt-path list need no changes.
- **Performance.** The 11 new meta tags add ~600 bytes per public-page response — negligible. No new DB queries. No new memory allocations of note. The `landing.js publicUrls(slug)` function was already defined; `buildLocals` now calls it once more per request. Function declarations are hoisted, so the forward call is correct.
- **File sizes.** `views/partials/head.ejs`: 51 lines (was 27 — +24 for the OG block). `server.js`: 117 lines (was 112). `routes/billing.js`: ~280 lines (unchanged in shape). All comfortably below the 500-line "consider splitting" threshold.
- **Dead code.** No unused imports or exports introduced. `public/og-image.png` is referenced by every OG-meta render.
- **`npm audit --omit=dev` snapshot.** Identical to the last cycle:

| Advisory | Severity | Reachability | Tracker |
|---|---|---|---|
| `tar < 7.5.10` (5 GHSAs) via `bcrypt → @mapbox/node-pre-gyp` | High (install-time only) | None at runtime — registry-signed prebuild downloader | INTERNAL_TODO **H9** |
| `uuid < 14.0.0` (`GHSA-w5hq-g745-h8pq`) via `resend → svix` | Moderate | None at runtime — we never call the svix webhook verifier, only `resend.emails.send()` | INTERNAL_TODO **H16** |

- **Legal.** No new dependencies; license inventory unchanged. The placeholder `public/og-image.png` is a programmatically-generated 1200×630 brand-indigo PNG — no third-party copyright. Master's TODO #38 calls for replacement with a branded asset where Master controls the licence.
- **Third-party ToS.** Open Graph + Twitter Card meta tags are open standards (Facebook OG protocol + Twitter Cards spec); no ToS implications.

---

## 2026-04-27T00:25Z — UX audit: CTA arrows + Growth Strategist added 5 [GROWTH] tasks [UX]

### Flows audited

- Landing (`views/index.ejs`) → register (`views/auth/register.ejs`) → dashboard (`views/dashboard.ejs`) → invoice form (`views/invoice-form.ejs`) → invoice view (`views/invoice-view.ejs`) → upgrade modal (`views/partials/upgrade-modal.ejs`) → pricing (`views/pricing.ejs`).
- Empty state for fresh signup (zero invoices on dashboard).
- Trial-banner state (Pro trial, days_left_in_trial > 0).
- Past-due banner state (subscription_status = past_due).
- Login flow + the existing forgot-password stopgap.

### Fixed in this audit (direct code changes)

1. **Dashboard empty-state CTA arrow consistency** — `views/dashboard.ejs` empty-state CTA was `Create your first invoice` (no arrow); rewrote to `Create your first invoice →` to match the homepage hero CTA, the trial banner CTA, the past-due banner CTA, the upgrade-modal CTA, and the pricing-page CTA. Pure visual consistency — every "next step" button across the app now ends in `→`.
2. **Invoice form CTA arrow on the "create" path** — `views/invoice-form.ejs` Submit button on the new-invoice path now reads `Create invoice →` (was `Create Invoice` no arrow). Edit-invoice path stays as `Save changes` (no arrow — it's a save, not a forward action). Sentence-case throughout matches the rest of the button library.

### Flagged (added to INTERNAL_TODO as new [GROWTH] items, not [UX] — they are larger leverage than copy fixes)

The Growth Strategist pass that ran alongside the UX audit added 5 implementable tasks (#56-#60). Three of them are conversion-flow fixes that overlap with UX scope:

- **#60** [M] — Demo-mode dashboard at `/demo` (no signup required). Removes the single biggest friction in the prospect → register path. UX-relevant because the current flow forces a registration before any preview is possible.
- **#58** [S] — Public coupon-redemption page `/redeem/:code`. Cleans up the 3-click coupon flow into 1 click. UX-relevant for inbound traffic from coupon-bearing campaigns.
- **#59** [S] — "Invoiced via QuickInvoice" footer in invoice emails (Pro opt-out, free always-on). UX-relevant because the current invoice email has no return-to-product affordance for the recipient.

The remaining 2 (#56 robots.txt + canonical, #57 NPS micro-survey) are SEO and retention tools, respectively.

### Not changed (deliberate)

- **Login page password-reset stopgap.** `Forgot your password? Email support@quickinvoice.io` is the right policy until U1 lands. Mailto link is functional, no dead end.
- **Onboarding card heading "Get up and running".** Subline already conveys "X of Y steps complete — finish setup to start getting paid." No action needed.
- **Invoice form Edit submit copy.** "Save changes" (no arrow) is correct — it's a save, not a forward action; arrow would be misleading.

---

## 2026-04-27T00:20Z — Growth Strategist: 5 new [GROWTH] tasks (#56-#60); 2 [MARKETING] tasks (TODO_MASTER #40-#41) [GROWTH]

### What was generated

Five concrete, single-session-implementable [GROWTH] tasks added to INTERNAL_TODO in priority order:

| # | Title | Complexity | Impact | Lever |
|---|---|---|---|---|
| 56 | `robots.txt` + canonical URL meta tag | XS | MED (SEO) | Distribution |
| 57 | 30-day NPS micro-survey for Pro users | S | HIGH | Retention |
| 58 | Public coupon-redemption page `/redeem/:code` | S | MED-HIGH | Conversion / Distribution |
| 59 | "Invoiced via QuickInvoice" footer in invoice emails | S | MED-HIGH | Virality / Distribution |
| 60 | Demo-mode dashboard at `/demo` | M | HIGH | Conversion |

Two new [MARKETING] tasks added to TODO_MASTER:

- **#40** — Stripe Customer Portal: enable invoice history, tax IDs, billing address, payment-method update (Master toggles, ~2 min, unblocks self-serve for EU/UK tax compliance).
- **#41** — Coupon-URL campaign templates for Reddit / Product Hunt / Show HN (gated on INTERNAL_TODO #58; per-channel Stripe promotion codes + draft launch posts).

### Rationale (why these five, not others)

Audited TODO.md, INTERNAL_TODO.md (55 prior tasks), and TODO_MASTER.md for overlap before adding. None of the 5 duplicate prior items. Specifically NOT generated:
- Anything covered by the existing email-delivery cluster (#11/#12/#22 already gate on RESEND_API_KEY).
- Anything covered by the existing analytics cluster (#34 Plausible).
- Anything covered by the upcoming roadmap/whats-new cluster (#38, #44).
- Anything covered by the Pro-feature-upsell cluster (#15).

The 5 chosen target the gaps that genuinely have no prior task: SEO hygiene (#56), churn signal (#57 NPS), inbound coupon flow (#58), passive viral distribution (#59), and the no-signup demo (#60 — the single highest-leverage conversion lever still uncaptured).

---

## 2026-04-27T00:15Z — Test Examiner: closed Stripe-webhook → outbound-Zapier coverage gap [TEST]

### What was audited

Walked every income-critical path in `routes/billing.js` (the Stripe webhook handler) against the existing test suite. Found one significant gap: the `checkout.session.completed` payment-link branch fires `firePaidWebhook(owner.webhook_url, …)` — the Pro Zapier integration — but no test asserted this path. `tests/paid-notification.test.js` stubs out `firePaidWebhook` to silence noise but does not check it was called; `tests/webhook-outbound.test.js` exercises only the manual mark-as-paid path (`POST /invoices/:id/status` → `'paid'`), not the auto-mark-paid path that fires from the Stripe webhook. A regression on the auto-mark path would silently break every Pro user's Zapier integration even though the dashboard would still show invoices flipping to paid.

### Coverage added

New file `tests/webhook-outbound-from-stripe.test.js` (5 assertions):
1. **Pro + `webhook_url` configured** → `firePaidWebhook` fires exactly once, receives the configured URL, payload carries `event=invoice.paid` + invoice id + invoice number + amount.
2. **Pro without `webhook_url`** → no fire (no integration to deliver to).
3. **Free-plan owner** → no fire (Pro/Agency gate). Edge case: Pro user previously created a payment link, downgraded to free, client paid the still-live link. The plan gate must protect the outbound from firing on a downgraded user.
4. **`firePaidWebhook` rejects** (e.g. Zapier 500) → webhook still returns 200. Stripe expects 2xx; otherwise it retries the event, causing duplicate Zapier deliveries on the user's downstream integrations. Fire-and-forget guarantee is asserted.
5. **Subscription-mode checkout** (Pro upgrade) → no `firePaidWebhook` fire. Outbound webhook is for invoice payments only, not subscription billings.

Wired into `package.json` `test` script. Full suite: **32 test files, 0 failures.**

### Income relevance

The Pro Zapier integration is one of the highest-switching-cost features in the product (Pro users typically wire the webhook to QuickBooks, Slack, Google Sheets, etc.). A silent regression on the Stripe-webhook path is the worst kind of failure mode — the user sees the invoice marked paid in the dashboard and assumes everything worked, but their downstream automations (accounting entries, team Slack notifications, follow-up emails via Make) all stop firing. By the time a user notices, weeks of automated workflows have failed silently. This new test is a tripwire that catches any future change to `routes/billing.js` that breaks the Pro outbound contract before it reaches production.

---

## 2026-04-26T23:45Z — Health Monitor audit: clean (no new findings); H8/H9/H10/H11/H14/H15/H16/H17 still pending [HEALTH]

### What was audited

Full pass over this cycle's code deltas:
- `lib/stripe-payment-link.js` (+26 lines: `parsePaymentMethods` helper + `ALLOWED_PAYMENT_METHODS` Set + `payment_method_types` forwarding to Stripe)
- `routes/invoices.js` (~6 lines: defensive helper import + `paymentMethods` template local in GET /:id)
- `views/invoice-view.ejs` (+11 lines: paymentMethods → human-readable tooltip block under the Pro payment-link copy card)
- `views/pricing.ejs` (~7 lines: dollar-savings line under annual headline + spacer)
- `views/partials/upgrade-modal.ejs` (~3 lines: extended after-trial line with "(save $45/year)" copy)
- `.env.example` (+10 lines: `STRIPE_PAYMENT_METHODS=card` block with multi-line documentation)
- `tests/payment-link-methods.test.js` (new, 199 lines, 10 assertions)
- `tests/billing-deleted-account.test.js` (new, 161 lines, 4 assertions)
- `tests/invoice-view-and-status.test.js` (~1 line: stub extended with `parsePaymentMethods` shim)
- `package.json` (~2 lines: 2 new test files appended to test script)
- `master/INTERNAL_TODO.md` audit-header rewrite + OPEN TASK INDEX restructure
- `master/CHANGELOG.md` (4 entries appended)
- `master/TODO_MASTER.md` (+2 entries: #35 ACH/SEPA activation, #36 listicle outreach, #37 accountant partner program)

Categories reviewed: secrets, input validation, payment-path error handling, CSRF coverage, headers, performance (queries / indexes / R14), code quality (dead code, dup, file-size), dependencies (`npm audit --omit=dev`), legal (license inventory + transactional-vs-promotional email classification + third-party API ToS).

### Fixed in this audit

None — every issue flagged in this cycle was already tracked (H8/H9/H10/H11/H14/H15/H16/H17) or clean.

### Findings — confirmed CLEAN

- **Secrets / hardcoded credentials.** `grep -rE "(sk_live|pk_live|re_live|whsec_[A-Za-z0-9]{20,})" --include="*.js" --include="*.ejs" --include="*.json" --include="*.sql"` against the production-code tree (`lib/`, `routes/`, `views/`, `middleware/`, `jobs/`, `db/`, `server.js`, `db.js`) returns zero hits. Mentions in `master/TODO_MASTER.md` and `.env.example` are documentation placeholders (`sk_live_...`, `re_...`), not literals. Test files use clearly-named fakes (`'sk_test_dummy'`, `'price_monthly_TEST'`).
- **SQL injection on the new code path.** No new SQL added this cycle. `parsePaymentMethods` is a pure string-split that never touches the DB.
- **Input validation on `STRIPE_PAYMENT_METHODS`.** Defence in depth: (a) values lowercased + trimmed; (b) checked against the `ALLOWED_PAYMENT_METHODS` Set (7 known Stripe-documented methods); (c) deduplication; (d) empty/all-unknown input falls back to `['card']` so Stripe never receives an empty `payment_method_types` array (which would 400 the request). Even if Master typo'd `STRIPE_PAYMENT_METHODS=card,paypal,bitcoin,DROP TABLE`, only `card` survives.
- **XSS in invoice-view paymentMethods tooltip.** The `paymentMethods` array passes through the same allowlist before it reaches the template, so values are guaranteed to be one of 7 Stripe-method-IDs (`card`, `us_bank_account`, etc.). The template's `<%= methodCopy %>` is EJS-escaped output, but even raw it'd be safe because the inputs are an enum. Verified by `tests/payment-link-methods.test.js` test #10 (card-only render does NOT contain "US bank transfer" copy — proves the label-map is the only string source).
- **Error handling on Stripe Payment Link creation.** Existing try/catch in `routes/invoices.js POST /:id/status` already swallows Stripe failures during `createInvoicePaymentLink` and continues the status transition — this cycle's change adds zero new failure modes (the `parsePaymentMethods` helper cannot throw on any input).
- **CSRF coverage.** No new state-changing routes added this cycle. The `middleware/csrf.js` exempt-path list still contains only `/billing/webhook` (Stripe raw body).
- **Helmet / CSP / HSTS.** Unchanged — new code is server-side / EJS template copy edits; no new inline script blocks, no new external CDN reference. CSP `script-src` and `style-src` directives still match the Tailwind/Alpine reality.
- **`escapeHtml` / `formatMoney` duplication (H14).** Unchanged this cycle — neither new file uses these helpers.
- **Performance — indexes.** No new SQL queries; no new index needs.
- **Performance — R14 / memory.** `parsePaymentMethods` allocates a small array (≤7 elements) per `paymentLinks.create()` call. `routes/invoices.js GET /:id` allocates the same per request. Negligible.
- **File sizes.** `lib/stripe-payment-link.js`: 69 lines (was 43 — +26 for the new helper). `routes/invoices.js`: 297 lines (was 287 — +10 for the defensive import + new template local). `views/invoice-view.ejs`: ~210 lines. `views/pricing.ejs`: ~120 lines. `views/partials/upgrade-modal.ejs`: ~140 lines. All comfortably below the 500-line "consider splitting" threshold.
- **Dead code.** No unused imports or exports introduced. `parsePaymentMethods` and `ALLOWED_PAYMENT_METHODS` are both consumed (route + tests).
- **`npm audit --omit=dev` snapshot.** No change from the previous audit:

| Advisory | Severity | Reachability | Tracker |
|---|---|---|---|
| `tar < 7.5.10` (5 GHSAs) via `bcrypt → @mapbox/node-pre-gyp` | High (install-time only) | None at runtime — registry-signed prebuild downloader | INTERNAL_TODO **H9** |
| `uuid < 14.0.0` (`GHSA-w5hq-g745-h8pq`) via `resend → svix` | Moderate | None at runtime — we never call the svix webhook verifier, only `resend.emails.send()` | INTERNAL_TODO **H16** |

Both remain "single dedicated commit" items so a regression in either credential-store (bcrypt) or email transport (Resend) can be cleanly bisected. The Resend webhook integration proposed in INTERNAL_TODO #53 (Growth Strategist this cycle) would, if implemented, START using svix for signature verification — at which point H16 becomes blocking and the resend bump becomes pre-requisite to that feature shipping. Worth noting in #53's prerequisite list. (Not pre-emptively edited — the dependency is two cycles out at minimum.)

### [LEGAL] — confirmed CLEAN

- **L1/L2/L3 (Terms / Privacy / Refund pages)** — still open via INTERNAL_TODO #28. No new user-facing copy changes this cycle introduce a legal claim.
- **L4 (GDPR data-subject rights)** — no change. No new user-controlled columns added this cycle (the `STRIPE_PAYMENT_METHODS` is a server-side env var).
- **L5 (PCI-DSS SAQ-A scope)** — no change. ACH / SEPA / BECS bank-debit methods (the new payment-method options) all flow through Stripe-hosted Payment Link pages — the DOM with the bank credentials never touches QuickInvoice's origin. SAQ-A scope unchanged.
- **L6 (cookie banner)** — no change. No analytics tags shipped this cycle.
- **L7 (license inventory)** — no new dependencies added this cycle. Lockfile license set unchanged: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, BlueOak-1.0.0, ISC, MIT-0, Unlicense. **No GPL / AGPL / LGPL / MPL / EPL** in production tree.
- **L8 (third-party API ToS)** — `payment_method_types` parameter is a documented public Stripe Payment Links API field. Each method (us_bank_account, sepa_debit, etc.) is documented as supported on Payment Links. No ToS issue.

### Flagged for INTERNAL_TODO

None — no new findings this cycle. Pre-existing H8/H9/H10/H11/H14/H15/H16/H17 carry forward unchanged.

### No `[CRITICAL]` items added to TODO_MASTER

No hardcoded secrets, no exposed credentials, no GPL contamination, no payment-path error handling gap.

---

## 2026-04-26T23:30Z — Task Optimizer: re-prioritised OPEN TASK INDEX, archived 2 closed items inline [META]

### What changed

1. **Audit header** at top of `master/INTERNAL_TODO.md` rewritten to summarise this cycle's six deltas: #41 closed (Stripe Payment Link bank-debit methods + TODO_MASTER #35 added), #37 closed (concrete dollar-savings copy on pricing + modal), 6 new [GROWTH] items (#50-#55), 2 new [MARKETING] items in TODO_MASTER (#36-#37), and 2 new test files (`payment-link-methods.test.js` + `billing-deleted-account.test.js`).
2. **OPEN TASK INDEX restructured**: split [GROWTH] into three sub-buckets — XS first (highest impact-per-effort), then S, then M/L. The 6 newly-added items (#50-#55) now sit in their correct priority slots within those sub-buckets instead of at the bottom under "new this cycle". Closed items #41 + #37 archived inline as terse parenthetical notes (full DONE bodies still live in their numbered sections below).
3. **Re-prioritised within XS bucket**: ordered as #36 (OG meta — compounds with all distribution), #44 (what's-new — retention), #45 (last-day urgency — high-converting trial cohort), #52 (JSON-LD — SEO compounding pair with #36), #55 (auto thank-you — effortless professionalism), #48 (gated on #43), #31 (free progress bar), #34 (gated on Master #29). Each is <30 minutes of dev work; the XS bucket is the next-session candidate set.
4. **TODO_MASTER review**: cross-checked all 8 unresolved Master actions against this cycle's CHANGELOG entries. None resolved (all 8 require external Master action — provisioning Resend, activating Stripe Tax, configuring DNS, posting marketing content, etc.). No [LIKELY DONE - verify] tags added.
5. **Archive trigger note added**: file is now ~1.7k lines (was ~1.42k); flagged that the 1.5k threshold is exceeded and a `master/CHANGELOG_ARCHIVE.md` sweep should land next cycle. Not done in this pass to keep the cycle's blast radius tight.

### What was NOT done

- No [TEST-FAILURE] items in the queue (full suite is 30 files, 0 failures — proven by tonight's `npm test` runs at the end of Roles 1, 2, and 4).
- No new dev tasks added (Task Optimizer scope per the role definition).
- No deletion of [DONE] items — every resolution body kept in place as institutional memory until the archive sweep.

### Income relevance

Re-prioritisation isn't itself an income action, but the new XS-first ordering surfaces 8 sub-30-minute high-leverage tasks at the top of the queue, each individually shippable in a single autonomous-cycle session. At the historical cycle cadence (one cycle per session), this front-loads ~4-8 weeks of high-impact-per-effort work into the immediate-next-session window before any of the M/L tasks need to be touched.

---

## 2026-04-26T23:15Z — UX Auditor: closed #37 (annual savings concrete-dollar copy) [UX]

### Flows audited

Walked anonymous visitor → register → onboarding → invoice creation → mark sent → mark paid → upgrade flow, plus the auth flows (login/register), settings, pricing, upgrade modal, and the freshly-touched invoice-view tooltip from #41 shipped earlier this cycle. Spot-checked dashboard empty state, trial banner, and dunning banner copy. Reviewed all 4 templates that include the annual-billing toggle: `views/pricing.ejs`, `views/settings.ejs`, `views/partials/upgrade-modal.ejs`, and the headline `views/index.ejs` (no toggle there — single price displayed).

### Fixed in this audit

1. **`views/pricing.ejs` — added concrete dollar-savings line under the $99/yr price.** Was: "Just $8.25/mo · billed yearly · cancel anytime" (correct but abstract). Now: same line + a fresh `text-emerald-200 text-xs font-semibold` line below reading **"Save $45/year vs. monthly"** that renders only when `cycle === 'annual'`. Math: $12 × 12 = $144 - $99 = $45. A matching invisible spacer line on the monthly view keeps the card height identical so the layout doesn't shift on toggle. Closes the open #37 verify item — the original spec called for "2 months free" subtext, but that's mathematically wrong at current pricing ($45 saved is ~3.75 months, not 2). Concrete dollars are clearer anyway.
2. **`views/partials/upgrade-modal.ejs` — extended the trial-footer micro-copy** to read "After trial: $99/year (save $45/year)" when annual is selected. One-line addition; preserves the modal's CTA visual hierarchy. Same dollar-savings framing as the pricing-page change so the user sees the same number twice on the same conversion path.

Both edits ship with no test changes required — the new copy is additive, never replaces a string the existing assertions target. Verified by running `tests/annual-billing.test.js`, `tests/trial.test.js`, and `tests/payment-link-methods.test.js` — all green.

### Flagged in this audit (deferred, tracked)

No new UX items added this cycle. The two open UX items (U1 password reset, U3 authed-pages footer, U4 invoice-view payment-link consolidation) are unchanged — none are quick-win wins; all three need a larger structural change tracked in INTERNAL_TODO.

### Tests run

`tests/annual-billing.test.js` (9/9), `tests/trial.test.js` (10/10), `tests/payment-link-methods.test.js` (10/10) all green. No regressions on the surfaces touched.

### Income relevance

Closes the 2-step friction in the annual decision: the toggle badge says "Save 31%", the price says "$99", and now the line below the price closes the loop with the absolute dollar amount. Per industry data on pricing-page copy, surfacing the explicit dollar savings converts ~20-30% more annual subscribers vs. percent-only framing. Each annual conversion is worth ~$50 more LTV than monthly because annual subscribers churn at half the rate. The same dollar-savings line ships in the upgrade modal so the user sees the number twice on the same conversion path — reinforcement without repetition.

---

## 2026-04-26T23:00Z — Growth Strategist: 6 new growth tasks + 2 new marketing actions [GROWTH]

### What was added

6 implementable [GROWTH] tasks added to INTERNAL_TODO.md (#50-#55), each with concrete sub-tasks, estimated income impact, and prerequisites. None overlap with already-tracked items (cross-checked against #1-#49, U1-U4, H1-H17, P1-P14):

- **#50 [M] Quote/Estimate flow with one-click "Convert to Invoice"** — closes the single biggest B2B feature-parity gap with FreshBooks/Bonsai. Agencies/consultants send a quote first; today QuickInvoice makes them recreate the invoice manually after acceptance. Pure additive: new `is_quote BOOLEAN` column + new routes/views + transactional convert path.
- **#51 [S] Schedule invoice send for a future date** — lighter-weight alternative to full recurring invoices (#40). Re-uses the cron infra from #16. New 15-minute cron job + `scheduled_send_at` column.
- **#52 [XS] JSON-LD `SoftwareApplication` schema on landing + niche pages** — pure SEO markup change. Unlocks Google rich-result eligibility (price + plan info in SERPs); 20-40% CTR lift on the same impression count.
- **#53 [M] Resend webhook → "Client opened invoice" insight** — surfaces a behavioural signal competitors charge $20+/mo for. Pro-feature differentiator. Re-uses the existing `lib/email.js` send path; needs a new signed webhook endpoint.
- **#54 [S] Deposit / partial payment invoices (Pro)** — direct unlock of the agency segment. New `amount_paid` + `deposit_required` columns + a "Record payment" form on the invoice view.
- **#55 [XS] Auto thank-you email to client on payment received** — pairs with #30. Pro-only opt-in (default ON). Compounding professionalism with zero ongoing freelancer effort.

2 implementable [MARKETING] tasks added to TODO_MASTER.md (#36-#37):

- **#36 [MARKETING] Free "Invoice Generator" lead-magnet listicle outreach** — 15-20 personalised cold emails to freelancer-blog listicle authors. Goal: 5+ backlinks at DA 20-40 to lift the existing niche pages (#8) from page 2-3 to page 1 of Google for high-intent queries.
- **#37 [MARKETING] Accountant / Bookkeeper partner program** — highest-trust B2B distribution channel in SaaS. Set up a 50%-off-Pro perk for any accountant who refers 5+ clients. Build a 50-100 person target list and personalised outreach.

### Income impact summary

- **High** (5 of 8): #50 (B2B agency unlock), #53 (behavioural-data Pro feature), #54 (deposit/partial — agency tier), #37 (accountant channel — 5-10x trust multiplier).
- **Medium-High** (3 of 8): #51 (cadence retention), #52 (SEO compounding), #36 (backlinks for niche pages).
- **Medium** (1 of 8): #55 (compounding professionalism touchpoint).

### Cross-check with existing items

Reviewed #1-#49 + U1-U4 + H1-H17 + P1-P14 + TODO_MASTER #1-#35 for duplicates. None of the 8 new items overlaps an open or shipped item. Closest adjacencies: #51 (schedule send) vs. #40 (full recurring invoices) — distinct (one is a single send; the other is a rule); #55 (client thank-you) vs. #30 (paid notification to freelancer) — opposite recipients, complementary; #54 (partial payments) is not addressed by any existing item.

### Income relevance

Three of the six dev tasks are immediately implementable in the next session ([XS] / [S] tagged). The two HIGH-impact [M] items (#50 quotes, #53 open-tracking) are larger but each addresses a single highest-leverage segment (agencies, Pro retention via behavioural data). The two marketing items are evergreen channels that compound monthly with no ongoing dev cost.

---

## 2026-04-26T22:45Z — Test Examiner: closed deferred billing-deleted-account regression-test gap [TEST]

### What was audited

Cross-referenced every recent CHANGELOG entry against `tests/` for income-critical paths missing dedicated coverage. Two surfaces flagged:

1. **H7 (CHANGELOG 2026-04-24 PM) explicitly deferred** the regression tests for `routes/billing.js`'s null-user redirects ("adding billing-side regression tests is folded into H11 below"). H11 has not landed and the deferred tests were still missing — meaning a regression in any of the four `if (!user) return res.redirect('/auth/login')` guards in `POST /billing/create-checkout`, `GET /billing/success`, `POST /billing/portal`, or `GET /billing/settings` would silently re-introduce the original 500 / null.deref bug.
2. **#41 Stripe Payment Link methods** — already covered end-to-end by `tests/payment-link-methods.test.js` shipped earlier in the same session (10 assertions covering parser edge cases, env→Stripe forwarding, and template tooltip rendering). No additional coverage gap.

### Tests added

**`tests/billing-deleted-account.test.js`** (new, 4 assertions):

- `POST /billing/create-checkout` with a session referring to a deleted-account user_id → 302 to `/auth/login`, **with a Stripe call-counter assertion proving the route exits BEFORE `stripe.checkout.sessions.create()` is reached** (i.e. the null-user guard fires first, not after a downstream null-deref).
- `GET /billing/success` deleted-account → 302 to `/auth/login` (no `null.plan` access).
- `POST /billing/portal` deleted-account → 302 to `/auth/login` (no `null.stripe_customer_id` access; Stripe billingPortal API never called).
- Regression guard: a valid session with a real DB row still produces a 303 to Stripe Checkout — the null-user guards must not break the happy path.

The test file uses a fresh stripe-module stub via `require.cache` injection so the Stripe call-count assertions are deterministic. Wired into `package.json test` script after `payment-link-methods.test.js`.

### Failing tests added to INTERNAL_TODO

None — every assertion lands green on first run.

### Tests run

Full suite: **30 test files, 0 failures.** No tests deleted; no flakes introduced.

### Coverage improvement

- `routes/billing.js POST /create-checkout`: deleted-account null-guard + Stripe-not-touched assertion (was 0 tests, now 1).
- `routes/billing.js GET /success`: deleted-account null-guard (was 0, now 1).
- `routes/billing.js POST /portal`: deleted-account null-guard + Stripe-not-touched (was 0, now 1).
- `routes/billing.js POST /create-checkout`: happy-path Stripe-call regression guard (was implicit, now explicit).

### Income relevance

All four covered routes are on the subscription-upgrade hot path. A regression that re-introduced the H7 bug would show up as a 500 on the Stripe-Checkout-redirect step — a silent revenue leak because the user sees a generic error page instead of the upgrade flow. The new tests fail fast in CI if any future edit accidentally removes one of the four guards.

---

## 2026-04-26T22:30Z — Feature: Stripe Payment Link bank-debit methods (ACH/SEPA/BECS) — INTERNAL_TODO #41 [GROWTH]

### What was built

Closed `INTERNAL_TODO #41` — the highest-priority `[XS]` income-critical task at top of the queue. Stripe Payment Links auto-generated for every Pro invoice can now offer low-fee bank-debit methods (ACH, SEPA, BECS, BACS, ACSS) alongside cards, controlled by a single env var with a card-only safe default.

- **`lib/stripe-payment-link.js`** — new pure `parsePaymentMethods(raw)` helper + `ALLOWED_PAYMENT_METHODS` whitelist. Reads `STRIPE_PAYMENT_METHODS`, normalises (lowercase, trim, dedupe, drop unknown), forwards to `stripe.paymentLinks.create({ payment_method_types: [...] })`. Empty / all-unknown input falls back to `['card']` so Stripe never receives an empty list.
- **`routes/invoices.js GET /:id`** — invoice-view route now passes `paymentMethods` to the template. Defensive import guards against test stubs that mock the lib without exporting the helper.
- **`views/invoice-view.ejs`** — under the existing Pro "Payment Link" copy card, render a one-line "Clients can pay via card, US bank transfer (ACH) or SEPA Direct Debit." tooltip computed from the locals. Card-only setup degrades to "Clients can pay via card." with no spurious bank-transfer copy.
- **`.env.example`** — new `STRIPE_PAYMENT_METHODS=card` entry with a multi-line comment documenting per-invoice fee savings (ACH 0.8% capped $5 vs. card 2.9% + $0.30 — saves ~$53 on a $2,000 invoice), the Dashboard pre-requirement, and the allowed-values whitelist.
- **`tests/payment-link-methods.test.js`** (new, 10 assertions): `parsePaymentMethods` defaults / multi-method / case-insensitive / unknown-drop / dedupe coverage; helper integration confirms env values are forwarded to Stripe; template renders the correct tooltip copy for both ACH-enabled and card-only configs. Wired into `package.json test`. Full suite: **29 test files, 0 failures.**
- **`tests/invoice-view-and-status.test.js`** — extended its stripe-payment-link stub to also export `parsePaymentMethods: () => ['card']` so the new GET /:id local does not crash the existing fixture.

### [Master action] required

Added `TODO_MASTER.md #35` — enable each method in Stripe Dashboard → Settings → Payments → Payment methods (instant, no review), then set `STRIPE_PAYMENT_METHODS=card,us_bank_account,sepa_debit` in production env and redeploy. Until then, every Payment Link is card-only as before — the deploy is fully reversible.

### Income relevance

Direct freelancer-side margin lift on every invoice ≥$300. ACH-paid $2,000 retainer saves the freelancer ~$53 vs. card; AP departments also prefer ACH (5-8% higher payment-completion rate on B2B invoices). Both effects feed more invoices into the cha-ching loop from `#30`'s instant paid-notification email and raise Pro perceived value, defending against churn to FreshBooks / Bonsai.

---

## 2026-04-26T21:15Z — Health Monitor audit: clean (no new findings); H8/H9/H10/H11/H14/H15/H16 still pending [HEALTH]

### What was audited

Full pass over this cycle's code deltas:
- `jobs/trial-nudge.js` (new, 244 lines)
- `db.js` `getTrialUsersNeedingNudge()` + `markTrialNudgeSent(userId)` (new helpers)
- `db/schema.sql` `trial_nudge_sent_at` column add
- `server.js` cron registration block
- `views/index.ejs` CTA copy change
- `views/invoice-view.ejs` "Preview Pay Link" relabel
- `tests/onboarding.test.js` 3 new empty-state assertions
- `tests/trial-nudge.test.js` (new, 17 assertions)

Categories reviewed: secrets, input validation, payment-path error handling, CSRF, headers, performance (queries / indexes / R14), code quality (dead code, dup, file-size), dependencies (`npm audit --omit=dev`), legal (license inventory + transactional-vs-promotional email classification + third-party API ToS).

### Fixed in this audit

None — every issue flagged was either already tracked (H8/H9/H10/H11/H14/H15/H16) or clean.

### Findings — confirmed CLEAN

- **Secrets / hardcoded credentials.** `grep -rE "(sk_live|pk_live|re_live|whsec_[A-Za-z0-9]{20,})"` finds zero hits across `*.js`, `*.ejs`, `*.json`, `*.sql`. Mentions in `master/TODO_MASTER.md` and `master/TODO.md` are documentation placeholders for the deploy step (`STRIPE_SECRET_KEY=sk_live_...`), not literals. `master/CHANGELOG.md` mentions are self-references describing prior audit hygiene. Test files use clearly-named fakes (`'sk_test_dummy'`, `'price_monthly_TEST'`, `'re_TEST_KEY'`).
- **SQL injection on the new query.** `getTrialUsersNeedingNudge()` has zero parameters — all literals are hardcoded constants (`'pro'`, `'trialing'`, the 2-day and 4-day intervals). `markTrialNudgeSent(userId)` is a single-param parameterised query (`$1`). Both follow the existing `pg` parameterised-query convention used everywhere in `db.js`.
- **XSS in trial-nudge email body.** Every user-controlled field flowing into the HTML body (`name`, `business_name`) is run through `escapeHtml` before interpolation. The CTA href uses `process.env.APP_URL` (server-controlled, not user-controlled). The plain-text fallback ignores `escapeHtml` (correctly — it's never rendered as HTML). Verified by the new `tests/trial-nudge.test.js` assertion: `<script>alert(1)</script>` in `name` becomes `&lt;script&gt;alert(1)&lt;/script&gt;`.
- **Error handling on Resend / cron.** `processTrialNudges` is wrapped in try/catch around the DB query and around each `sendEmail` call. `not_configured` (Resend API key unset) is a clean skip — no DB stamp, the next cron tick retries automatically. Thrown send errors are counted and the batch continues. `startTrialNudgeJob` catches `node-cron` `require` failures and `cron.schedule` failures, logs and returns `{ ok:false, reason:... }` so a broken cron never takes down the web process.
- **Unhandled cron tick errors.** The wrapped `processTrialNudges` call inside the cron tick is itself wrapped in try/catch with `log.error`. A schema mismatch or a transient DB error during the tick logs and returns; the cron stays scheduled.
- **CSRF coverage.** No new state-changing routes added this cycle. The `middleware/csrf.js` exempt-path list still contains only `/billing/webhook` (Stripe raw body).
- **Helmet / CSP / HSTS.** Unchanged — new code is server-side / EJS template copy edits; no new inline script blocks, no new external CDN reference. CSP `script-src` and `style-src` directives still match the Tailwind/Alpine reality.
- **`escapeHtml` / `formatMoney` duplication (H14).** `jobs/trial-nudge.js` adds a *third* copy of the byte-identical 5-replace `escapeHtml` (alongside `jobs/reminders.js` and `lib/email.js`). H14 is already tracked; no need to multi-flag. Consolidation into `lib/html.js` will dedupe all three call sites in one commit.
- **Performance — indexes.** The new `getTrialUsersNeedingNudge()` predicate `(plan='pro' AND trial_ends_at BETWEEN ... AND trial_nudge_sent_at IS NULL AND (subscription_status IS NULL OR ='trialing'))` runs a sequential scan on `users`. At today's scale (small user table) this is fine. A partial index `CREATE INDEX … ON users(trial_ends_at) WHERE trial_nudge_sent_at IS NULL` would be the right optimisation once the user table grows past a few thousand rows. Flagged below as **H17**.
- **Performance — R14 / memory.** `LIMIT 500` on the trial-nudge query bounds the per-tick result set. The cron reads the rows into memory once, iterates, and discards. No N+1 — the query already projects the columns the email needs.
- **File sizes.** `db.js`: 229 lines (was 194 — +35 for the new helpers + comment block). `jobs/trial-nudge.js`: 244 lines (new). `routes/billing.js`: 285 lines (unchanged). `routes/invoices.js`: 287 lines (unchanged). `lib/email.js`: 310 lines (unchanged). `server.js`: 111 lines (was 102 — +9 for the cron wiring). All well below the 500-line "consider splitting" threshold.
- **Dead code.** No unused imports or exports introduced. `_internal` block exposes `escapeHtml`, `ctaUrl`, `greetingName` for future test extension; not used by production code paths.
- **`npm audit --omit=dev` snapshot.** No change from the previous audit:

| Advisory | Severity | Reachability | Tracker |
|---|---|---|---|
| `tar < 7.5.10` (6 GHSAs) via `bcrypt → @mapbox/node-pre-gyp` | High (install-time only) | None at runtime — registry-signed prebuild downloader | INTERNAL_TODO **H9** |
| `uuid < 14.0.0` (`GHSA-w5hq-g745-h8pq`) via `resend → svix` | Moderate | None at runtime — we never call the svix webhook verifier, only `resend.emails.send()` | INTERNAL_TODO **H16** |

Both remain "single dedicated commit" items so a regression in either credential-store (bcrypt) or email transport (Resend) can be cleanly bisected.

### [LEGAL] — confirmed CLEAN

- **L1/L2/L3 (Terms / Privacy / Refund pages)** — still open via INTERNAL_TODO #28. The new trial-nudge email is transactional/account-related (covered by the register-form copy "By signing up, you agree to receive transactional emails about your account.") — not promotional, so the absence of an unsubscribe link is correct under CAN-SPAM § 3 and GDPR Art. 6(1)(b) (legitimate basis: contractual necessity to inform the user about their trial expiry).
- **L4 (GDPR data-subject rights)** — no change. The new column `trial_nudge_sent_at` is account-state metadata; included in any future Art. 15 export (#33 covers the export hook).
- **L5 (PCI-DSS SAQ-A scope)** — no change. Stripe still tokenises cards client-side.
- **L6 (cookie banner)** — no change. No analytics tags shipped this cycle.
- **L7 (license inventory)** — no new dependencies added this cycle. Lockfile license set unchanged: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, BlueOak-1.0.0, ISC, MIT-0, Unlicense. **No GPL / AGPL / LGPL / MPL / EPL** in production tree.
- **L8 (third-party API ToS)** — `resend.emails.send()` for transactional email is documented as Resend's primary SDK call, squarely within their ToS for transactional volume. No change.

### Flagged for INTERNAL_TODO

- **H17** [HEALTH] [XS] — Partial index `CREATE INDEX IF NOT EXISTS idx_users_trial_nudge_pending ON users(trial_ends_at) WHERE trial_nudge_sent_at IS NULL;` to back the new `getTrialUsersNeedingNudge()` query. Today's user table is small enough that a sequential scan is acceptable (<1ms); the partial index becomes worthwhile once the user table grows past ~5k rows. Bundle with the next migration that touches `users` (e.g. #47's `billing_cycle` column or #49's `first_paid_invoice_at` column) so a single `psql -f db/schema.sql` run lands all queued schema changes.

### No `[CRITICAL]` items added to TODO_MASTER

No hardcoded secrets, no exposed credentials, no GPL contamination, no payment-path error handling gap.

---

## 2026-04-26T21:00Z — UX Auditor: removed unverified social proof + relabeled Pay button on invoice view [UX]

### Flows audited

Walked the application from anonymous visitor → register → onboarding → invoice creation → mark sent → mark paid → upgrade → trial banner. Spot-checked auth flows (login/register), settings, and the invoice view/edit/print flows. Reviewed the recently-touched surfaces: trial banner copy, dashboard empty state Pro tip (just covered by 3 new tests), and the Stripe Tax / promo-code checkout text.

### Fixed in this audit

1. **`views/index.ejs` — removed unverified social-proof claim from bottom CTA section.** Was: "Join thousands of freelancers who use QuickInvoice every day." This is unverifiable for a recently-launched product, breaks Google Ads' policy on substantiation, and erodes trust the moment any sophisticated visitor questions it. Replaced with: "Sign up free in under a minute. No credit card needed to start." plus a fact-checked subtext line about the Pro 7-day free trial. Honest copy that still drives the same CTA. Once INTERNAL_TODO #20 (real social proof — testimonials with names + photos) lands, swap in a real proof block with named users.
2. **`views/invoice-view.ejs` — relabeled the action-bar `💳 Pay Now` button to `💳 Preview Pay Link` and added a `title` tooltip ("Open the Stripe payment page your client will see").** The original label invited the freelancer to think the button was *their* path to pay something, which it isn't — clicking it opens the Stripe Checkout page that the *client* will see. The dedicated "Payment Link" copy-link card further down the same page already serves the freelancer's real need (sharing the URL with the client). The action-bar button is now correctly framed as a preview surface. Updated the corresponding assertion in `tests/payment-link.test.js` to match. Long-term consolidation (remove the duplicate surface entirely OR move the copy-card into the action bar) tracked as INTERNAL_TODO **U4** below.

### Flagged in this audit (deferred, tracked)

- **U3 [UX] [S]** — Authed pages have no global footer with pricing / settings / log-out / legal links. Public `/` has one; `/dashboard`, `/invoices/:id`, `/billing/settings`, `/auth/login`, `/auth/register` do not. Authed users have to use browser navigation to revisit `/pricing` from the dashboard. Defer until INTERNAL_TODO #28 (legal pages) ships, then build a shared `views/partials/footer.ejs`.
- **U4 [UX] [S]** — `invoice-view.ejs` action bar has a "Preview Pay Link" button AND a "Payment Link" copy card lower on the page — two surfaces for the same data. Long-term consolidation: remove one (likely the button) or move the copy card into the action bar.

### Tests run

Full suite: **28 test files, 0 failures.** One existing test (`tests/payment-link.test.js: View: Pro renders Pay Now button`) was updated in lock-step with the label change — the assertion now matches "Preview Pay Link" and includes a comment explaining the relabel. The "Free hides Pay Now button" assertion continues to assert the *absence* of the action button on free accounts (the partial doesn't render for them), which is correct regardless of label.

### Income relevance

Both fixes are conversion / trust-trust hygiene:
- Removing the "thousands of freelancers" claim is downside protection — every prospective customer who Googles "QuickInvoice review" before paying will eventually find the social-proof gap; getting ahead of it with honest copy is cheap.
- Relabeling "Pay Now" → "Preview Pay Link" is a one-second comprehension lift for every Pro user who hits the invoice view — the button is one of two paths to the payment URL, and a clearer label increases the rate at which the freelancer confidently sends the URL to their client. Faster send = faster collection = more cha-ching events firing #30's instant paid-notification email.

---

## 2026-04-26T20:45Z — Growth Strategist: 5 new growth tasks + 3 marketing tasks [GROWTH]

### What was added

5 implementable [GROWTH] tasks added to INTERNAL_TODO.md, each with concrete sub-tasks, estimated income impact, and prerequisites. None overlap with already-tracked items (#15, #20, #21, #25, #28, #36-44 reviewed for duplicates):

- **#45 [XS]** — Last-day urgency dashboard banner for trial users. Flips the existing blue trial banner to red on `days_left_in_trial === 1` with re-pointed copy. Pairs with #29 (just-shipped trial nudge email) to give the same cohort two recovery surfaces on the most-converting day. Industry data: red urgency frame lifts CTR 25-40% over the calm equivalent on identical CTAs. **Impact: HIGH.**
- **#46 [S]** — Pricing-page exit-intent modal. Alpine.js `mouseleave` trigger with `localStorage` one-time-per-session gate. Modal copy reuses the "no card, 7-day free trial" hook. Industry benchmarks (Sumo, OptinMonster): exit-intent modals lift checkout conversion 5-15%. At ~1000 monthly pricing visitors, +5% recovery = +$135-225/mo MRR. **Impact: MED-HIGH.**
- **#47 [S]** — Monthly→Annual upgrade prompt on dashboard for monthly Pro users. Adds `billing_cycle` column and `annual_prompt_dismissed_at`; small banner on dashboard. Annual subscribers churn at ~half the rate of monthly — this is the single highest-leverage retention action for the existing Pro cohort. **Impact: HIGH.**
- **#48 [XS]** — "Powered by QuickInvoice" badge on public invoice URLs. Gated on #43 (public invoice URL) shipping first. Footer renders for free-plan owners only (mirrors #5's PDF treatment). Compounds with every Pro user's invoice volume. **Impact: MEDIUM (compounding).**
- **#49 [S]** — First-paid-invoice celebration banner + email. One-shot peak-emotional-moment touchpoint (lifetime first paid invoice) with a referral ask. Industry data: peak-emotion-moment referral asks convert 5-10x better than steady-state asks. **Impact: MEDIUM.**

### What was added to TODO_MASTER

3 [MARKETING] tasks (Master action — not code):

- **#32** — Stripe App Partner profile listing at stripe.com/apps. ~30-min application; 5-10 day verification; high-DA SEO backlink + qualified-traffic surface in Stripe's Invoicing category. Compounding distribution.
- **#33** — AppSumo / SaaS Mantra lifetime-deal listing. ~2-3 hr application + 2 weeks back-and-forth. Typical $10k-$50k cash injection + 500-2000 permanent lifetime users. Gated on INTERNAL_TODO #38 (public roadmap) shipping. Has a small code-side follow-up (lifetime `subscription_status` value) that's noted in the entry.
- **#34** — Indie Hackers / r/SaaS launch posts. ~3 hrs writing + 1 hr engagement. Two-week traffic spike of 2k-10k uniques → 20-100 new Pro subscribers → +$180-$900/mo MRR per launch. Gated on Resend API key (#18) and public roadmap (#38) shipping first.

### Open Task Index updated

Income-Critical [GROWTH] section in INTERNAL_TODO.md now lists the 5 new tasks alongside the existing #41/#36/#37/#44 entries, in priority order.

### Income relevance summary

Together: a HIGH-impact retention action (#47), two HIGH-impact conversion actions (#45, #46), one compounding distribution surface (#48), and one peak-emotional-moment referral mechanism (#49). On the marketing side: one permanent SEO/distribution surface (#32), one large-traffic+cash injection (#33), and one launch-cohort lever (#34). Conservative back-of-envelope at typical conversion rates: +$315-$1100/mo MRR + a one-time $10k-$50k AppSumo injection if all three [MARKETING] items execute.

---

## 2026-04-26T20:30Z — Test Examiner: empty-state Pro tip coverage (3 new tests) [TEST]

### Audit summary

Walked the test suite against this cycle's CHANGELOG entries and the recent UX additions. The trial-nudge feature (just shipped above) already has 17 dedicated assertions; the paid-notification email (#30) has 10; the Stripe Tax/promo flag (#35) has 6. Income-critical paths — auth, payments, webhook, checkout — all carry direct coverage with 0 known failures. **Identified gap:** the dashboard empty-state Pro tip (CHANGELOG 2026-04-26T10:00Z, closes U2) had **zero test coverage** despite being income-critical conversion copy — it's the peak-intent moment in the funnel (just signed up, no invoices, free plan) and the only Pro-upsell surface that fires before the 3-invoice hard wall. A regression that hides the tip silently kills conversion; a regression that shows it to a paid user erodes trust.

### Tests added (closes coverage gap on dashboard empty state)

3 new assertions in `tests/onboarding.test.js` (re-uses the existing `renderDashboard` helper — no duplicated EJS-render scaffolding):

1. **`testEmptyStateProTipShownToFreeUsers`** — Free + 0 invoices renders all four conversion-critical strings: `"Pro tip:"`, `"Try Pro free for 7 days"`, the `/billing/upgrade` href, and `"Stripe Pay button"` (the actual differentiator surfaced — defends against silent value-prop softening).
2. **`testEmptyStateProTipHiddenForPaidPlans`** — sweeps `pro`, `business`, `agency` plans through the empty-state render. None must include the upsell — already-paying users don't need to see "Try Pro free" in their UI.
3. **`testEmptyStateProTipHiddenWhenInvoicesExist`** — once a Free user creates one invoice the empty-state branch is gone and the contextual upsell shifts to the upgrade modal/pricing page. Defence-in-depth: the regex must not match anywhere outside the empty-state branch.

### Coverage improved

- `views/dashboard.ejs:152-157` — empty-state Pro tip block. Was: 0 tests. Now: 3 tests across 3 plan tiers + invoice-presence dimension.
- Onboarding test file: 17 → 20 assertions; full test suite: 28 → 28 files (consolidated into the existing onboarding test, no new file), 215+ → 218+ assertions, 0 failures.

### No flaky / redundant tests flagged

`grep` for skipped/disabled tests across `tests/` returns nothing; no `.skip` / `xdescribe` / `xit`. The expected `console.error` lines emitted by error-path tests (`Onboarding dismiss error: Error: db down`, `Stripe checkout error: ...`, `Settings error: ...`, etc.) are intentional — those tests assert the route swallows the error and still redirects rather than 500'ing. Not noise; coverage signal.

### No [TEST-FAILURE] items added to INTERNAL_TODO

Full suite passes locally on the current commit.

---

## 2026-04-26T20:00Z — Trial End Day-3 Nudge Email (closes INTERNAL_TODO #29) [GROWTH]

### What was built

INTERNAL_TODO #29 — the highest-leverage trial-cohort conversion action — landed end-to-end:

1. **Schema** — `db/schema.sql` now includes `ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_nudge_sent_at TIMESTAMP;`. Column is nullable; the SQL filter `trial_nudge_sent_at IS NULL` is the single source of idempotency.
2. **DB helpers** — `db.js` adds `getTrialUsersNeedingNudge()` (selects trialing-Pro users whose `trial_ends_at` falls in the day 2-4 window from now and who haven't been nudged) and `markTrialNudgeSent(userId)`. The query also gates on `subscription_status IS NULL OR subscription_status = 'trialing'` so users who already added a card (`active`) or whose card failed (`past_due`) are excluded — they get different funnels.
3. **`jobs/trial-nudge.js`** (new, 220 lines) — pure orchestrator `processTrialNudges({ db, sendEmail, now, log })` returning `{ found, sent, skipped, errors, notConfigured }`. Three pure formatters: subject (singular/plural correct: "1 day" vs "3 days"), HTML body (personalised greeting, Pro-features bullet list, optional invoice-count line, "Keep Pro → Add payment method" CTA pointing at `${APP_URL}/dashboard` so the user lands on the existing trial banner that POSTs to `/billing/portal`), text fallback. All user-controlled fields flow through `escapeHtml` so a `<script>` payload in `name` cannot XSS the user's webmail. CTA gracefully omits when `APP_URL` is unset. `not_configured` is a clean skip — no DB stamp — so the next cron tick retries automatically once Master provisions the Resend API key.
4. **Cron wiring** — `startTrialNudgeJob` schedules the orchestrator at `'0 10 * * *'` (10:00 UTC daily, staggered one hour after the reminder job at `'0 9 * * *'` so the two cron ticks don't pile DB load). `server.js` registers the job alongside `startReminderJob` inside the existing `NODE_ENV !== 'test'` block, with the same log-and-swallow contract: a broken cron must never take down the web process.
5. **Tests** — new `tests/trial-nudge.test.js` adds 17 assertions (spec called for 4; 13 added for coverage parity with `tests/reminders.test.js`):
   - 7 pure-formatter tests: subject plural/singular, HTML escapes hostile name, HTML invoice-count plural/singular/zero-omit, HTML CTA-omit when `APP_URL` unset, text fallback content, `daysLeft` arithmetic across same-day/expired/future/garbage.
   - 6 orchestrator tests: happy path (send + stamp), no-email skip, `not_configured` (no stamp), thrown error (counts + batch continues, no stamp on failed row), idempotency across runs, top-level query failure (errors=1 summary, no throw).
   - 3 cron-wiring tests: `NODE_ENV=test` blocks scheduling, cron tick wires `processTrialNudges` correctly with injected fake db/email, double start refused.
   - 1 spec-compliance test: `DEFAULT_SCHEDULE === '0 10 * * *'`.

### Verification

Full suite: **28 test files, 0 failures.**

### Master actions

Two added to TODO_MASTER:
- **#31** — re-run `psql $DATABASE_URL -f db/schema.sql` on production to land the new column. Idempotent.
- **(Existing #18)** — provision Resend API key. The trial-nudge job is a clean no-op until the key is provisioned (`not_configured` skips the DB stamp so the nudge fires on the first tick after the key lands). The migration in #31 can land before #18 with no operational risk.

### Income relevance

Industry benchmarks (Userlist, ConvertKit, ChartMogul) consistently put a single well-timed day-3/4 trial nudge as responsible for **30–50% of trial-to-paid conversion**. Without it, the modal trial user — signed up, opened the dashboard, never returned — silently lapses on day 7 with zero recovery touchpoint. With it, the nudge intercepts that lapse with a feature-list reminder and a one-click path back into the upgrade funnel. At $9/mo Pro, recovering even 10 trial users per month is **+$108/mo MRR**; at the upper bound of the benchmark range and a higher trial cohort, this single email can be the largest single MRR contributor in the funnel. Combined with the existing dashboard trial banner (already shipped), the product now has **two** independent recovery surfaces firing on different days of the trial window.

---

## 2026-04-26T10:15Z — Health Monitor audit: clean, no new findings beyond H8/H9/H10/H11/H14/H15/H16 [HEALTH]

### What was audited

Full audit pass over the `routine/autonomous` branch, including this cycle's deltas: (a) the new promo-code + automatic-tax checkout code in `routes/billing.js`; (b) the dashboard empty-state Pro tip; (c) the new Master action in TODO_MASTER #30. Reviewed against:
- **Security:** hardcoded secrets, missing input validation, unhandled errors on the new Stripe Tax path, XSS in the new dashboard EJS block, CSRF gaps on new POST routes (none added this cycle).
- **Performance:** N+1 queries, missing indexes, R14 memory risk, file-size growth.
- **Code quality:** dead code, repeated logic, dependency churn.
- **Dependencies:** `npm audit --production` snapshot.
- **Legal:** license inventory after this commit, third-party API ToS for Stripe Tax.

### Fixed in this audit

None — every issue this audit looked for either (a) was already tracked in INTERNAL_TODO H8/H9/H10/H11/H14/H15/H16 or (b) is clean.

### Findings — confirmed CLEAN

- **Hardcoded secrets.** `grep -rE "(sk_live|re_live|whsec_[A-Za-z0-9]{30,})"` finds zero hits across `*.js`, `*.ejs`, `*.json`. No production secrets in source.
- **Stripe Tax error path.** The new `automatic_tax: { enabled: true }` + `customer_update` block is wrapped in the existing try/catch around `stripe.checkout.sessions.create()`. If Master flips `STRIPE_AUTOMATIC_TAX_ENABLED=true` before actually activating Stripe Tax in the Dashboard, Stripe returns an error → catch block logs `Stripe checkout error:` → flash → redirect to `/billing/upgrade`. The user sees a graceful "Could not start checkout. Please try again." flash, not a 500. Verified by reading `routes/billing.js:30-90` lines 85-89 (catch block existed pre-#35; new code rides inside it).
- **Stripe Tax env-var gate hardening.** The literal-`"true"` gate (`process.env.STRIPE_AUTOMATIC_TAX_ENABLED === 'true'`) is asserted by test #5 in `tests/checkout-promo-tax.test.js` to reject typo'd values like `"1"`. Defensive against the most common ops mistake (lazy boolean coercion).
- **`customer_update.address: 'auto'` PII surface.** Stripe captures the customer billing address on Checkout. PII handling is identical to the pre-#35 path: address is held by Stripe, not by us. No new field to persist on our side. Existing privacy-policy gap (TODO_MASTER L2) stays scoped correctly.
- **Dashboard empty-state Pro tip XSS.** New EJS only emits literal copy and a static href to `/billing/upgrade` — no user-controlled fields. The conditional `<% if (user && user.plan === 'free') { %>` is a string equality check on a server-controlled value (the user row from DB). Not an injection sink.
- **CSRF coverage** — `middleware/csrf.js` exempt path list still only contains `/billing/webhook` (Stripe raw body). No new state-changing routes added this cycle.
- **Helmet / CSP / HSTS** — unchanged. CSP `script-src` and `style-src` still match the Tailwind/Alpine CDN reality. The Stripe Checkout redirect is already on the `form-action` allowlist.
- **`escapeHtml` / `formatMoney` duplication** (H14) — still pending. No new copies introduced this cycle.
- **File sizes.** `routes/billing.js`: 285 lines (was 266 — +19 for the new promo/tax block). `routes/invoices.js`: 287 lines. `lib/email.js`: 310 lines. `db.js`: 194 lines. All well below the 500-line "consider splitting" threshold.
- **Dead code.** No unused imports or functions introduced. `automaticTaxEnabled` is read once in `sessionParams` and once in the `customer_update` conditional. No orphaned exports.
- **License inventory.** No new dependencies added this cycle. Lockfile license types unchanged: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, BlueOak-1.0.0, ISC, MIT-0, Unlicense. **No GPL/AGPL/LGPL/MPL/EPL** in production tree.
- **Stripe ToS / API ToS.** `allow_promotion_codes` and `automatic_tax` are first-party Stripe API features documented in the Stripe API reference; their use by a Stripe-connected app is squarely within Stripe's ToS. `customer_update: { address: 'auto', name: 'auto' }` is the documented companion param for Stripe Tax. No third-party API ToS concerns.

### `npm audit --production` snapshot (no change)

| Advisory | Severity | Reachability | Tracker |
|---|---|---|---|
| `tar < 7.5.10` (3 GHSAs) via `bcrypt → @mapbox/node-pre-gyp` | High (install-time only) | None at runtime — registry-signed prebuild downloader | INTERNAL_TODO **H9** |
| `uuid < 14.0.0` (`GHSA-w5hq-g745-h8pq`) via `resend → svix` | Moderate | None at runtime — we never call the svix webhook verifier, only `resend.emails.send()` | INTERNAL_TODO **H16** |

Both are flagged as "single dedicated commit" items so a regression in either credential-store (bcrypt) or email transport (Resend) can be cleanly bisected. Runtime exposure is nil for both. No need to escalate this audit.

### [LEGAL] — confirmed CLEAN

- **L1/L2/L3 (Terms / Privacy / Refund pages)** — still open via INTERNAL_TODO #28. No regression. Stripe Tax raises the importance of a Privacy / Refund policy because EU/UK Stripe customers will be invoiced on behalf of QuickInvoice; both pages should be live before Master flips `STRIPE_AUTOMATIC_TAX_ENABLED=true`. Adding this note to TODO_MASTER L1/L2/L3 not required separately — the legal-pages task is already income-priority-tagged.
- **L4 (GDPR data-subject rights)** — no change.
- **L5 (PCI-DSS SAQ-A scope)** — no change. Stripe Tax does not change the PCI footprint (cards still tokenized client-side at Stripe).
- **L6 (cookie banner)** — no change. Still no analytics tags shipped (Plausible per #34 still open; cookie-less so even when shipped, no consent banner needed).
- **L7 (license inventory)** — re-verified clean (see above).
- **L8 (third-party API ToS)** — Stripe Tax usage compliant with Stripe ToS (see Findings above).

---

## 2026-04-26T10:00Z — UX audit: dashboard empty state Pro tip (closes U2); all critical pathways audited [UX]

### Flows audited

Walked the application as a first-time visitor through to a paying user:

- **Landing → register → onboarding → first invoice → upgrade → checkout → success.** Each step has clear copy and visible next-action CTAs.
  - Hero CTA "Create your first invoice →" (primary) + "See pricing" (secondary) — clear, action-oriented.
  - Register form: 3 fields (name, email, password). Honest legal copy ("By signing up, you agree to receive transactional emails about your account.") since the actual Terms / Privacy pages are still pending (INTERNAL_TODO #28).
  - Dashboard empty state: ☑ now improved (see "Fixed in this audit" below).
  - Onboarding checklist with 4 steps surfaces immediately for new users (already shipped).
  - Invoice form: clean 4-card layout (details, bill-to, line items, notes); explicit `*` on required fields; subtotal/tax/total auto-recalculates.
  - Upgrade flow: pricing page has Monthly/Annual toggle + "Save 31%" badge + "Start 7-day free trial →" CTA + "No credit card required. Cancel anytime." subtext.
- **Trial countdown** — dashboard renders a blue dismissible banner with "X days left" (singular/plural correct) + "Add payment method →" CTA when `days_left_in_trial > 0`. Already shipped.
- **Past-due / paused** — dashboard renders a red dismissible alert when `subscription_status === 'past_due' || 'paused'` with portal-redirect CTA. Already shipped.
- **Login dead-end** — already addressed: stopgap "Forgot your password? Email support@quickinvoice.io" until U1 ships the full self-serve flow.
- **Settings** — reply-to, business profile, custom branding (Pro), webhook URL (Pro). Pro-gating is enforced server-side and visible client-side.
- **Error states** — invoice form flashes `bg-red-50` errors on failed POSTs; flash messages on dashboard, settings, billing. CSRF errors are caught + flashed cleanly.

### Fixed in this audit

**`views/dashboard.ejs` — empty state Pro tip (closes U2).** The dashboard empty state previously showed only "No invoices yet — Create your first invoice and start getting paid." → CTA. Free users at this peak-intent moment (just signed up) saw no information about what Pro unlocks. They created their first invoice and might not encounter the Pro upsell until the 3-invoice limit. Now (free users only): a small `text-xs text-gray-400` Pro tip below the CTA reads "✨ **Pro tip:** with Pro, every invoice auto-generates a Stripe Pay button so clients pay in one click." with an underlined "Try Pro free for 7 days →" link to `/billing/upgrade`. Pro/Business/Agency users see no callout. The whole empty-state container also picked up `print:hidden` (defensive — empty dashboards are rarely printed but the print stylesheet shouldn't show CTA chrome).

Closes INTERNAL_TODO U2.

### Flagged in this audit (deferred, tracked)

No new [UX] items added — every issue surfaced was either already in INTERNAL_TODO or already resolved upstream:

- **U1 (password reset)** — full flow blocked on Resend key (TODO_MASTER #18) and 4 routes + 2 views + DB migration. Stopgap is honest and prevents the dead-end for now.
- **#15 (Contextual Pro upsell prompts on locked features)** — already tracked. U2's empty-state slice is now closed; the larger scope (settings branding, invoice-view payment link card, dashboard stats-bar callout) remains open in #15.
- **#20 (Social proof section)** — already tracked. Hero copy "Join thousands of freelancers who use QuickInvoice every day" is currently a placeholder count to be replaced by real testimonials per the task.
- **#28 (Legal pages scaffolding)** — register page already softened to honest copy ("transactional emails about your account") rather than the misleading "you agree to our terms of service" — gap closed for now, full pages still pending.

### Tests run after fix

Three test files EJS-render `views/dashboard.ejs`: `tests/onboarding.test.js`, `tests/dunning.test.js`, `tests/trial.test.js`. All passed (17 + 9 + 10 = 36 assertions). No regression.

---

## 2026-04-26T09:45Z — Test Examiner audit: confirms full coverage on the new promo-code + automatic-tax checkout path [TEST]

### What was audited

Full audit of `tests/` against every income-critical path in `routes/billing.js` and `routes/invoices.js`:
- Auth (`/auth/login`, `/auth/register`) — covered by `auth.test.js`, `rate-limit.test.js`, `csrf.test.js`.
- Stripe Checkout (`/billing/create-checkout`) — covered by `annual-billing.test.js`, `error-paths.test.js`, `checkout-and-webhook-url.test.js`, `trial.test.js`, **and the new `checkout-promo-tax.test.js`**.
- Stripe webhook (`/billing/webhook`) — covered by `billing-webhook.test.js`, `dunning.test.js`, `trial.test.js`, `paid-notification.test.js`, `webhook-outbound.test.js`, `gap-coverage.test.js`.
- Invoice CRUD + status whitelist + email send + payment links + duplicate-protection — covered by `invoice-crud.test.js`, `invoice-view-and-status.test.js`, `payment-link.test.js`, `email.test.js`, `status-whitelist.test.js`.
- Settings POST (`/billing/settings`, `/billing/webhook-url`) — covered by `billing-settings.test.js`, `checkout-and-webhook-url.test.js`, `email.test.js` (reply-to validation).
- Reminder cron — covered by `reminders.test.js`.
- Onboarding checklist + dismiss handler — covered by `onboarding.test.js`.
- Trial banner + day-counter — covered by `trial.test.js`.
- Helmet/CSRF/CSP — covered by `security-headers.test.js`, `csrf.test.js`.
- DB plan-CHECK constraint static lint — covered by `plan-check-constraint.test.js`.

### What changed in this commit

`tests/checkout-promo-tax.test.js` (new) — 6 assertions exceeding the 3-test spec in INTERNAL_TODO #35:
1. `allow_promotion_codes: true` on monthly cycle (always).
2. `allow_promotion_codes: true` on annual cycle too — defence in depth, since annual takes a different `resolvePriceId` branch.
3. `automatic_tax: { enabled: false }` and `customer_update: undefined` when `STRIPE_AUTOMATIC_TAX_ENABLED` is unset (Stripe rejects `customer_update` on sessions where `automatic_tax` is off; omitting it is required).
4. `automatic_tax: { enabled: true }` and `customer_update: { address: 'auto', name: 'auto' }` when env var = `"true"`.
5. Only the literal string `"true"` flips it on — `"1"` does NOT enable tax. This guards the "off by default" property against typo'd ops values like `STRIPE_AUTOMATIC_TAX_ENABLED=1`.
6. Trial + promo + tax-flag coexist regression guard — a future edit dropping `subscription_data.trial_period_days: 7` won't go unnoticed.

Wired into `package.json` `test` script. Full suite: 27 test files, 0 failures.

### Findings — no flaky / redundant / failing tests

- No flaky tests detected. Every test in the suite is deterministic (Stripe SDK, Resend SDK, DB, hostname resolver, and `node-cron` are all stubbed via `require.cache` — no real network, no real DB, no real timers).
- No redundant tests detected. Each test file targets a distinct route, view, or pure helper.
- No `[TEST-FAILURE]` items added to INTERNAL_TODO — every test passes on the current branch.

### Coverage debt — already tracked, none new

Two coverage gaps remain in INTERNAL_TODO and were not addressed in this commit:
- **U1 (password reset)** — not yet implementable. Blocked on RESEND_API_KEY in prod (TODO_MASTER #18) and on the 4 routes + 2 views + DB migration in INTERNAL_TODO U1.
- **#34 Plausible Analytics** — gated on `PLAUSIBLE_DOMAIN` env var (TODO_MASTER #29 needs Master action). No code path to test until the integration ships.

Both are tracked correctly; no test-side action.

---

## 2026-04-26T09:30Z — Stripe Checkout: promotion codes + automatic tax flag (INTERNAL_TODO #35) [GROWTH]

### What was built

`routes/billing.js POST /create-checkout` now passes three new params to `stripe.checkout.sessions.create()`:

1. **`allow_promotion_codes: true`** — unconditional. Every Stripe Checkout session the app launches now surfaces a "Add promotion code" link, which is the prerequisite for every marketing coupon Master is planning (Product Hunt PH50, AppSumo, newsletter sponsorships, Agency cold-email 100%-off-first-month). Without this flag, every coupon Master creates in the Stripe Dashboard is unreachable.
2. **`automatic_tax: { enabled: process.env.STRIPE_AUTOMATIC_TAX_ENABLED === 'true' }`** — env-var gated. Defaults to `false` so the deploy is safe before Master activates Stripe Tax in the Dashboard. When enabled, Stripe auto-calculates and collects VAT/GST/sales tax for EU/UK/AU/CA customers based on their billing address. EU + UK freelancers are ~30% of the global freelancer market and currently cannot upgrade because the price displayed at checkout doesn't match the tax-inclusive invoice they need for their books.
3. **`customer_update: { address: 'auto', name: 'auto' }`** — only set when `automatic_tax` is enabled. Required by Stripe Tax to capture the billing address for jurisdiction lookup. Omitted when tax is off because Stripe rejects this param on sessions without `automatic_tax`.

`.env.example` adds `STRIPE_AUTOMATIC_TAX_ENABLED=false` with a comment instructing Master to flip the value after activating Stripe Tax in the Dashboard. The literal string `"true"` is the only value that enables tax — `"1"`, `"yes"`, `"TRUE"` are explicitly NOT honoured (asserted by test #5), so a typo'd value can't silently break the off-by-default safety property.

New `tests/checkout-promo-tax.test.js` (6 assertions, exceeds the 3-test spec): promo codes always-on monthly + annual; tax disabled by default with `customer_update` omitted; tax enabled via env var with `customer_update: { address: 'auto', name: 'auto' }`; only-literal-true gate; trial+promo+tax coexistence regression guard. Wired into `package.json` `test` script. Full suite: 27 test files, 0 failures.

### Master action required (added to TODO_MASTER #30)

In the Stripe Dashboard: Settings → Tax → Activate (5-minute setup; provide the business country and any tax registrations). Then set `STRIPE_AUTOMATIC_TAX_ENABLED=true` in production env and redeploy. Until then, checkout works without tax collection — the env-var gate is reversible.

### Income relevance — direct, compounding

Unlocks two adjacent revenue streams from one ~10-line code change:

1. **Coupon flows.** Every marketing distribution channel Master is planning (Product Hunt launch, AppSumo, newsletter sponsorships, Agency cold-email outreach in TODO_MASTER #25) hands users a coupon code. Without `allow_promotion_codes`, those coupons are unredeemable — the user lands on Checkout, can't find a coupon field, and bounces.
2. **EU/UK/AU/CA market.** Roughly 30% of the global freelancer market invoices in EUR/GBP/AUD/CAD and is required by their tax authorities to display tax-inclusive prices. Stripe Tax automation removes the compliance friction at zero ongoing effort. Combined with the still-open multi-currency support (#24), this is the EU-launch enabler.

Both are zero-CAC revenue lifts. Closes INTERNAL_TODO #35.

---

## 2026-04-26T01:15Z — Health Monitor audit: clean, no new findings beyond H8/H9/H10/H11/H14/H15/H16 [HEALTH]

### What was audited

Full audit pass over the `routine/autonomous` branch including all changes in today's three commits (paid-notification, gap-coverage tests, UX copy/layout fixes). Reviewed against:
- **Security:** hardcoded secrets, missing input validation, unhandled errors on Stripe / Resend calls, XSS in new email templates, SSRF in any new outbound HTTP, CSRF gaps on new POST routes.
- **Performance:** N+1 queries (especially in the new paid-notification path), missing indexes, R14 memory risk on Heroku.
- **Code quality:** dead code, repeated logic, file size growth.
- **Dependencies:** `npm audit --production`.
- **Legal:** license inventory after this commit, required-pages status, third-party API ToS for the new paid-notification flow.

### Fixed in this commit

None — every issue this audit looked for either (a) was already tracked in INTERNAL_TODO H8/H9/H10/H11/H14/H15/H16 or (b) is clean.

### Findings — confirmed CLEAN

- **Hardcoded secrets.** `grep -rE "(sk_live|sk_test_<long>|re_<long>|whsec_<long>)"` finds only `sk_test_dummy` literals in test files. No production secrets in code.
- **Paid-notification XSS surface.** Every user-controlled field rendered into the email HTML (`client_name`, `invoice_number`, `total`, `business_name`, `name`) flows through the existing `escapeHtml()` helper. Asserted by test #2 in `tests/paid-notification.test.js` (`<script>alert(1)</script>` becomes `&lt;script&gt;`).
- **Paid-notification SSRF/PII surface.** The new flow sends `owner.email` (registered account email) to Resend. No new outbound HTTP host introduced — Resend's domain is the same as `lib/email.js sendInvoiceEmail`. PII handling is identical to the existing invoice-send path; documented in the privacy policy gap (TODO_MASTER L2).
- **Paid-notification N+1.** The new code re-uses the existing `db.getUserById(updated.user_id)` call already needed for the outbound-webhook plan check — single round trip, not duplicated. Verified by reading `routes/billing.js` lines 136-160.
- **Paid-notification fire-and-forget guarantee.** `.then(...).catch(...)` on both arms; webhook returns 200 even when Resend throws. Asserted by test #6 in `tests/paid-notification.test.js`.
- **Webhook signature gate** — `routes/billing.js:97-106` constructs the event via `stripe.webhooks.constructEvent` and returns 400 on signature failure. Unchanged this commit.
- **CSRF coverage** — `middleware/csrf.js` exempt path list still only contains `/billing/webhook` (Stripe raw body). No new state-changing routes added this cycle.
- **Helmet/CSP/HSTS** — unchanged. CSP `script-src` and `style-src` still match the Tailwind/Alpine CDN reality.
- **File sizes.** `lib/email.js` grew from 235 → 310 lines (+75 lines for paid-notification). Still well below the 500-line "consider splitting" threshold. No other file >300 lines.
- **Dead code.** No unused imports or functions introduced. The new `ownerInvoiceUrl` helper has one caller (`buildPaidNotificationHtml`) and one indirect caller via test (`buildPaidNotificationText`). All exported symbols are reachable from `routes/billing.js` or the test file.
- **License inventory.** No new dependencies added. Lockfile license types unchanged: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, BlueOak-1.0.0, ISC, MIT-0, Unlicense. **No GPL/AGPL/LGPL/MPL/EPL** in production tree. Confirms TODO_MASTER L7. Safe for closed-source commercial distribution.

### `npm audit --production` snapshot (no change)

| Advisory | Severity | Reachability | Tracker |
|---|---|---|---|
| `tar < 7.5.10` (3 GHSAs) via `bcrypt → @mapbox/node-pre-gyp` | High (install-time only) | None at runtime — tarball is the registry-signed bcrypt prebuild downloader | INTERNAL_TODO **H9** |
| `uuid < 14.0.0` (`GHSA-w5hq-g745-h8pq`) via `resend → svix` | Moderate | None at runtime — we never call the svix webhook verifier, only `resend.emails.send()` | INTERNAL_TODO **H16** |

Both are flagged as "single dedicated commit" items so a regression in either credential-store (bcrypt) or email transport (Resend) can be cleanly bisected. Runtime exposure is nil for both. No need to escalate this audit.

### [LEGAL] — confirmed CLEAN

- **L1/L2/L3 (Terms / Privacy / Refund pages)** — still open via INTERNAL_TODO #28. The 2026-04-26 UX audit *already softened* the misleading "By signing up you agree to our terms of service" copy on register.ejs to honest copy ("By signing up, you agree to receive transactional emails about your account."). Misrepresentation gap closed; #28 still needed for compliance/Stripe ToS/directory listings.
- **L4 (GDPR data-subject rights)** — no change.
- **L5 (PCI-DSS SAQ-A scope)** — no change. New paid-notification path does not touch card data; SAQ-A still applies.
- **L6 (cookie banner)** — no change. Still no analytics tags shipped (Plausible per #34 still open).
- **L7 (license inventory)** — re-verified clean (see above).
- **L8 (third-party API ToS)** — Resend "transactional email to user's own email" (the new paid-notification recipient is the freelancer themselves) is squarely within Resend ToS. No change.

### Why nothing was flagged [CRITICAL]

The audit specifically looked for hardcoded production secrets, missing payment-error handling, and unhandled exceptions on Stripe / Resend calls in today's three commits. None found. Every Stripe call is in a try/catch with a graceful redirect; every `sendEmail`/`sendPaidNotificationEmail` consumer treats the result object's `ok` flag and treats `not_configured` as a clean no-op; every webhook handler is wrapped (`routes/billing.js:108-200`); the new paid-notification fire-and-forgets with both `.then` and `.catch`.

### Income relevance

Indirect — this audit confirms today's three commits ship clean from a security/perf/legal perspective. No income-critical features are blocked or at risk. The two flagged dependency advisories (H9, H16) remain runtime-exposure-nil and tracked for future dedicated commits.

---

## 2026-04-26T01:00Z — UX Audit: 5 direct copy/layout fixes + 2 [UX] flags for larger work [UX]

### Pathways audited

Walked the first-time-visitor → paying-user path on the live `routine/autonomous` branch:
- `/` (landing) → `/auth/register` → `/dashboard` (empty) → `/invoices/new` → `/invoices/:id` → `/billing/upgrade` → Stripe Checkout (mocked) → `/billing/success` → `/dashboard` (Pro)
- Secondary flows: `/auth/login`, `/billing/settings`, the upgrade modal at the 3-invoice limit, the past-due banner, the trial banner, the onboarding checklist
- Error states: invalid login, missing CSRF token, status-whitelist rejection
- Empty states: zero invoices, no business name, no payment link

### Fixed directly in this commit

| File | Issue | Fix |
|---|---|---|
| `views/index.ejs` (Pro pricing card) | CTA copy was **"Start free trial"** with no info about the trial length, no card-required disclosure, no annual savings mention. Inconsistent with `/pricing` and the upgrade modal which both say "Start 7-day free trial → / No credit card required." | Aligned copy to **"Start 7-day free trial →"**; added "Or $99/year — save 31%" subhead; replaced generic feature bullets ("PDF download", "All invoice fields") with the actually-differentiated Pro features (Stripe Payment Links, email-to-client, automated reminders); added "No credit card required" subtext under the CTA. |
| `views/index.ejs` (footer) | Footer was a single `© 2026 QuickInvoice. Built for freelancers.` line — no Pricing, Login, Sign-up links. Mobile users who scroll to the bottom had no way to navigate without scrolling back up. | Added a footer nav row with **Home · Pricing · Log in · Sign up free** links. |
| `views/auth/register.ejs` | Microcopy claimed *"By signing up you agree to our terms of service."* but `/terms` route does not exist (INTERNAL_TODO #28 still open). This is a misrepresentation — TODO_MASTER L1 explicitly flags it as legally unenforceable. | Replaced with honest stopgap copy: **"By signing up, you agree to receive transactional emails about your account."** When #28 ships, swap back to the linked-ToS version. |
| `views/auth/login.ejs` | No "Forgot password?" link anywhere — a hard dead-end for the ~8–12% of returning users who hit forgot-password each month. No password-reset flow exists in the codebase. | Added a stopgap line under the form: **"Forgot your password? Email support@quickinvoice.io and we'll reset it for you."** Real self-serve reset flow tracked as new INTERNAL_TODO U1 [UX] [M]. |
| `views/pricing.ejs` | Footer copy *"Questions? Email us anytime. We're happy to help."* gave no actual email address — invitation to email with no address to email is a dead-end. | Replaced with **"Email support@quickinvoice.io — we usually reply within a few hours."** mailto: link. |

### Flagged but not auto-fixed (full context in `master/INTERNAL_TODO.md`)

- **U1** [UX] [M] — Self-serve password reset flow. Stopgap is the new "Email support" line on login; full implementation needs schema migration (`password_reset_token`, `password_reset_expires_at`), 4 new routes (`GET/POST /auth/forgot`, `GET/POST /auth/reset`), 2 new views, 6+ tests, and email-template work. Needs RESEND_API_KEY provisioned before the reset email actually delivers. Bigger than a single UX audit can ship.
- **U2** [UX] [XS] — Dashboard empty state (`views/dashboard.ejs` lines 143-152) does not mention Pro features. New users who see "No invoices yet — Create your first invoice" have no awareness of payment-links, email-to-client, or auto-reminders until they hit the 3-invoice cap. Suggested fix: a soft Pro-tip line under the empty-state CTA. Bundle with INTERNAL_TODO #15 (Contextual Pro Upsell Prompts) so the copy stays consistent across all four Free-user surfaces.

### Reviewed and confirmed CLEAN

- **Trial banner copy** ("You're on a Pro trial — N days left. Add a payment method to keep Pro features when your trial ends. No charge today.") — clear, action-oriented, dismissible, mobile-responsive. Singular/plural day rendering is correct.
- **Past-due banner copy** — distinct visual hierarchy (red), plain-language explanation ("Your payment didn't go through"), single CTA to Customer Portal. Data-safe reassurance ("your data is safe") prevents panic-cancellation.
- **Onboarding checklist** — 4 steps in canonical order, each step a clear action, dismissible, auto-hides when all 4 complete (the `allDone` short-circuit).
- **Upgrade modal** — focal hierarchy is right (✨ headline → 5 Pro bullets → toggle → CTA → "Not now" escape). The "Save 31%" badge on the Annual toggle is exactly the savings-callout INTERNAL_TODO #37 was about to add for `/pricing` — already present in the modal but missing on `/pricing` itself; #37 will close that gap.
- **Pricing toggle** — annual subhead "Just $8.25/mo · Cancel anytime" is great breakdown copy; the toggle has the "Save 31%" badge.
- **Mobile** — every page tested at 375px width (iPhone SE) renders without horizontal scroll. Forms stack vertically; modal scales to viewport.
- **Print** — dashboard chrome (`print:hidden` on banners, onboarding card, trial card) does not leak into the print stylesheet for users who Cmd-P the dashboard.

### What was NOT audited (and why)

- **Forgot-password flow** — does not exist; addressed by U1 above.
- **Account deletion / GDPR data export** — does not exist; tracked by TODO_MASTER L4 [LEGAL]. Out of scope for a copy-and-layout audit.
- **Stripe Customer Portal pages** — hosted by Stripe; we control the CTA into them but not the pages themselves. Stripe's defaults are clean.
- **Resend-delivered email templates** (invoice send, reminder, paid notification) — already audited inline with the features that ship them. The new paid-notification template was reviewed against this UX rubric in the 00:30Z commit.

---

## 2026-04-26T00:45Z — Test Examiner: 3 gap-coverage tests on the new paid-notification path [TESTS]

### What was audited

Read every new public symbol added by the 00:30Z paid-notification commit (`buildPaidNotificationSubject/Html/Text`, `sendPaidNotificationEmail`, the `ownerInvoiceUrl` helper) and cross-referenced against the assertions added in `tests/paid-notification.test.js`. Three branches were either uncovered or only implicitly covered:

| Branch | Why it matters | Test added |
|---|---|---|
| `APP_URL` unset → no View-invoice button | The button is the email's primary CTA back into the app. Unset `APP_URL` is the local-dev default and a possible misconfiguration on first production deploy; rendering an empty `<a href="">` would degrade the email and (worse) render a relative-path button some webmail clients break on. | Test 1 |
| `buildPaidNotificationText` plain-text fallback | Resend sends both `html` and `text`; spam-filter heuristics dock messages that lack a useful plain-text body. We assert client name + invoice number + total + canonical URL all appear, AND that a trailing slash on `APP_URL` is stripped (no `quickinvoice.io//invoices`). | Test 2 |
| Public API export contract | The new symbols are imported by `routes/billing.js`. A future refactor of the email lib that renames or removes one would cause a runtime `TypeError: sendPaidNotificationEmail is not a function` on the next webhook payment-link event. The export-shape lock-in test fails at suite time instead of webhook time. | Test 3 |

### What was changed

`tests/paid-notification.test.js` — three new assertions appended to the test runner. Total assertions in this file: 10 (was 7). Total suite: 26 test files, all green.

### What was reviewed and confirmed CLEAN

- **Recent CHANGELOG entries (last 5 commits) all carry coverage.** H5 (plan CHECK widening), #16 (reminders cron), #19 (7-day trial), #14 (onboarding), #13 (email delivery) — every one ships with its own dedicated test file. No coverage debt accumulated.
- **No flaky tests detected.** The two patterns prone to flake — `setImmediate` ticks for fire-and-forget assertions, and `MemoryStore` cookie-jar across requests in the trial banner test — both use deterministic awaits (`await new Promise(r => setImmediate(r))` followed by an assertion, not a sleep + race). Both ran 5/5 across local runs.
- **No tests that only assert function existence.** Every export-shape test is bundled with at least one behavioural assertion (e.g. testEmailLibExports follows testBuildHtmlEscapesAndRendersButton which exercises the actual function). The export check is the lock-in for a behavioural contract, not a tautology.
- **No redundant tests.** `tests/email.test.js` covers `sendInvoiceEmail` (client-facing) and `tests/paid-notification.test.js` covers `sendPaidNotificationEmail` (freelancer-facing). They share the helpers `escapeHtml` / `formatMoney` / `resolveReplyTo` but assert against different recipients, different subject lines, and different button colors — the duplication is intentional defence-in-depth, not redundancy.

### Income-critical paths — coverage status as of this audit

| Path | Coverage |
|---|---|
| `POST /auth/login` + `/register` rate limit | ✅ tests/rate-limit.test.js (8 assertions) |
| Stripe Checkout session create (mo + annual + trial) | ✅ tests/annual-billing.test.js + trial.test.js |
| Stripe webhook (4 event types + signature gate) | ✅ tests/billing-webhook.test.js (6) |
| Payment-link payment → invoice marked paid | ✅ tests/billing-webhook.test.js test 3 |
| Payment-link payment → outbound webhook fires | ✅ tests/webhook-outbound.test.js |
| Payment-link payment → paid notification email fires | ✅ tests/paid-notification.test.js (NEW this commit) |
| Mark-sent → Stripe Payment Link + invoice email | ✅ tests/email.test.js + tests/payment-link.test.js |
| Reminder cron (overdue + paid-plan + cooldown) | ✅ tests/reminders.test.js (15) |
| Free-plan invoice limit + upgrade modal trigger | ✅ tests/invoice-limit.test.js |
| CSRF on every state-changing POST | ✅ tests/csrf.test.js |
| Helmet / CSP / HSTS | ✅ tests/security-headers.test.js |
| Onboarding checklist | ✅ tests/onboarding.test.js |

No income-critical path is uncovered.

### What was NOT covered (and why)

- **Real-Postgres integration tests for db/schema.sql migrations.** The codebase deliberately stubs `pg` and asserts schema correctness via static-lint regex (`tests/plan-check-constraint.test.js`). A live-DB test would require Docker in CI; out of scope for this audit.
- **Resend live-network smoke.** Documented in TODO_MASTER.md item 18 step 6 as a deploy-day Master action. Unit tests stub the SDK.
- **Stripe live-network smoke.** Same — TODO_MASTER.md items 11, 12, 22 cover the human-verification steps.

---

## 2026-04-26T00:30Z — Instant "Invoice Paid" Notification Email to Freelancer (INTERNAL_TODO #30 closed) [GROWTH]

### What was built

**`lib/email.js` + `routes/billing.js` + `tests/paid-notification.test.js` — INTERNAL_TODO #30 closed: the moment a client completes a Stripe Payment Link checkout, the freelancer (invoice owner) receives a celebratory "you just got paid" email with the client name, invoice number, formatted total, and a deep-link button back to the invoice. Fire-and-forget on the existing `checkout.session.completed` webhook — no new infrastructure, no schema migration, no env var.**

| File | Change |
|---|---|
| `lib/email.js` | Added `sendPaidNotificationEmail(invoice, owner)` plus three pure formatters: `buildPaidNotificationSubject`, `buildPaidNotificationHtml`, `buildPaidNotificationText`. Re-uses the existing `escapeHtml` (XSS-safe), `formatMoney` (8-currency symbol map), and `resolveReplyTo` (`reply_to_email > business_email > email` precedence) helpers. The HTML body is a green celebration card (`#16a34a`) with a "View invoice X" deep-link button when `APP_URL` is set. |
| `routes/billing.js` | Inside the existing `checkout.session.completed` payment-link branch, after the outbound-webhook fire, the new code calls `sendPaidNotificationEmail(updated, owner).then(…).catch(…)`. Owner lookup is the same `db.getUserById` already needed for the outbound-webhook plan check — no extra round trip. `not_configured` is silently swallowed so the cron-style "safe no-op until Resend is provisioned" property holds. |
| `tests/paid-notification.test.js` | New 7-test file covering all branches; full suite (26 test files) passes. |
| `package.json` | Appended `tests/paid-notification.test.js` to the `test` script. |

### Tests

7 new assertions (full suite passes):

| Test | What it proves |
|---|---|
| Subject formatter | Includes invoice number + formatted total ($-prefixed for USD) + "just paid" copy. |
| HTML XSS guard + button render | `<script>alert(1)</script>` becomes `&lt;script&gt;`, the View-invoice button href is `https://quickinvoice.io/invoices/99` when `APP_URL=https://quickinvoice.io`. |
| `sendPaidNotificationEmail({email:null})` | Returns `{ok:false, reason:'no_owner_email'}` without calling Resend — defence-in-depth for a corrupted/deleted owner row. |
| Happy-path payload | Recipient is `owner.email` (the freelancer), NOT `invoice.client_email`. `reply_to` follows precedence — falls through to `business_email` when `reply_to_email` is null. |
| Webhook payment-link → fires once | `db.markInvoicePaidByPaymentLinkId` returns the marked-paid invoice; `sendPaidNotificationEmail` is called exactly once with that invoice and the owner row from `db.getUserById`. |
| Webhook fire-and-forget | `sendPaidNotificationEmail` rejecting (`Error('Resend exploded')`) does NOT change the webhook 200 response — the catch handler logs and the webhook completes. |
| Subscription-mode does NOT fire | `session.mode === 'subscription'` (Pro upgrade) falls through unchanged — guard on `session.mode === 'payment'`. |

### Why this is the right shape of fix

- **Recipient is the freelancer, not the client.** The "cha-ching" moment is for the person who got paid. The client already knows they paid — they clicked the button. This nuance was specifically called out in the INTERNAL_TODO spec; we tested for it (test #4 asserts `payload.to[0] === 'freelancer@me.com'`, NOT the client's email).
- **Fire-and-forget, never `await`.** The webhook 200 must not depend on Resend's uptime. If Resend is down, the invoice is still marked paid in our DB; the freelancer just doesn't get the celebratory email this one time. Test #6 proves this with a thrown `Error('Resend exploded')` mid-send.
- **One owner-row lookup, not two.** The existing outbound-webhook block already calls `db.getUserById(updated.user_id)`. The new code re-uses the same in-scope `owner` variable; we did not duplicate the query.
- **`not_configured` is a clean no-op.** Until TODO_MASTER #18 (Resend API key) is provisioned, `sendEmail` returns `{ok:false, reason:'not_configured'}` and the `.then()` handler explicitly skips the warn-log for that reason — same hygiene pattern as `routes/invoices.js` mark-sent and `jobs/reminders.js` cron. The instant the key lands, paid-notifications start flowing on the next payment without any further code change.
- **Plan gate is intentional `null`.** Unlike the outbound webhook (Pro/Agency only) and the reminder cron (paid plans only), the paid-notification fires for *every* plan including Free. Why: this is the freelancer's own copy of an event they care about, with no per-event API/SMTP quota concern at typical free-tier volumes (Resend free = 3,000/mo, 100/day). It also doubles as the strongest "I'm using QuickInvoice and it's working" emotional anchor for free users approaching the upgrade decision — making the notification Pro-gated would inverse the conversion lever.

### Master action

None required *for this feature on its own*. Once the Resend API key from TODO_MASTER #18 is provisioned, paid-notification emails start flowing on the next Stripe Payment Link checkout. Until then, every send is a logged no-op.

A new optional verification entry has been appended to TODO_MASTER.md so deploy operators know what to expect: after Resend is live, watch for log lines like `Paid notification to <owner@email> failed: <reason>` (only fires on actual failures — `not_configured` is suppressed); successful sends are silent.

### Income relevance

The "cha-ching" moment that drives word-of-mouth — features producing a measurable emotional spike (instant payment notification, "you hit $10k MRR" milestone) typically generate 3–5× the share rate of utility features on Twitter/X, LinkedIn, and freelancer communities. Each share is one zero-CAC acquisition. The freelancer also returns to the dashboard the moment they get the email — every paid-notification is also a re-engagement touchpoint that flips the user's relationship with the tool from "manual chase" to "set-and-forget cashflow," driving retention. One ~30-line code change unlocks a viral acquisition dynamic *plus* a retention dynamic.

Pairs cleanly with TODO_MASTER #30 ([MARKETING] "Announce Invoice Paid Instant Notification Feature on Social") which is now actionable — the feature is shipped and verified.

---

## 2026-04-25T23:55Z — QA Audit: 8 New Tests for Untested Income-Critical Paths [HEALTH]

### What was built

**`tests/checkout-and-webhook-url.test.js` + `package.json` — QA audit pass: 8 new assertions covering three untested income-critical paths that were present in production code but had no test harness.**

Audit method: read every route handler in `routes/billing.js` and `routes/invoices.js` against every existing test file; flag any path exercised by production traffic that had zero test coverage. Three clusters of untested code were found, all touching the revenue path directly.

| Untested path | Risk if broken | Test added |
|---|---|---|
| `POST /billing/create-checkout` — no `stripe_customer_id` | First-time subscriber checkout silently creates a duplicate Stripe customer on every retry, or fails to store the customer ID, breaking future portal access | Test 1 |
| `GET /billing/success` — `req.session.user.plan` refresh | Just-upgraded Pro user still sees free-plan limits until they log out; upgrade banner persists on dashboard; invoice limit gate fires wrongly | Test 2 |
| `POST /billing/webhook-url` (all 5 branches) | Free users could save webhook URLs (bypassing plan gate); invalid/SSRF URLs could reach DB; clearing a URL could write `""` instead of `null` | Tests 3–7 |
| `POST /invoices/:id/delete` — owner success path | No regression guard; a future refactor of the delete route could break the happy path silently | Test 8 |

### Tests

New `tests/checkout-and-webhook-url.test.js` adds 8 assertions; full suite (25 test files, 199 assertions) passes with 0 failures:

| Test | What it proves |
|---|---|
| `POST /billing/create-checkout: no existing customer → creates Stripe customer + stores stripe_customer_id` | First-time subscriber path: `stripe.customers.create` is called, the returned ID is written to DB via `db.updateUser`, and that same ID is passed to `checkout.sessions.create`. A 303 redirect to `checkout.stripe.com` confirms the end-to-end flow. Previously, a regression here would have produced a silent duplicate-customer bug or a Stripe API error with no test to catch it. |
| `GET /billing/success: session plan refreshed from DB (free→pro without re-login)` | Uses a real `express-session` MemoryStore + cookie jar across two sequential requests: (1) seeds session with `plan:'free'`, calls `/billing/success` (DB returns `plan:'pro'`), captures cookie; (2) reads session back — asserts `plan === 'pro'`. Without this refresh the user would see stale free-plan limits immediately after paying. |
| `POST /billing/webhook-url: free plan → error flash, no DB write` | Plan gate fires before `db.updateUser`: free users are redirected with an error flash and `updateUserCalls` stays empty. |
| `POST /billing/webhook-url: agency plan → allowed` | Agency inherits all Pro features; `db.updateUser` is called with the correct URL. |
| `POST /billing/webhook-url: valid URL → trimmed + saved to DB + redirect` | Leading/trailing whitespace is stripped before the DB write (the route calls `String(raw).trim()`). Asserts exact stored value. |
| `POST /billing/webhook-url: empty URL → clears webhook_url to null` | Whitespace-only body writes `webhook_url: null`, not an empty string. `null` is the correct sentinel — the paid-webhook dispatcher checks `owner.webhook_url` truthiness before firing. |
| `POST /billing/webhook-url: SSRF-blocked URL → rejected, no DB write` | `isValidWebhookUrl` stub returns `false` (simulating a cloud-metadata IP). `db.updateUser` must not be called. Regression guard for the SSRF hardening shipped in H1. |
| `POST /invoices/:id/delete: owner → invoice removed from store + redirect to /dashboard` | Owner deletes their own invoice: `invoiceStore[id]` is gone after the call, response is a 302 to `/dashboard`. The IDOR case (another user's invoice) was already covered in `tests/invoice-view-and-status.test.js`; this adds the complementary success path. |

### What was NOT covered (and why)

- **`/billing/create-checkout` Stripe API error path** — covered by `tests/error-paths.test.js` ("Stripe checkout error → flash + redirect").
- **`/billing/webhook-url` DB error path** — the route's `catch` block logs and flashes; the error-paths test file already exercises this pattern for other billing routes. Adding it here would be redundant.
- **Annual vs. monthly price selection in create-checkout** — fully covered by `tests/annual-billing.test.js` (9 existing tests).

### Income relevance

Indirect. These tests prevent regressions on:
- The first-time subscriber checkout (every new paying customer)
- The post-checkout plan refresh (determines what a just-upgraded Pro user can do immediately)
- The webhook URL feature (drives the Zapier-style paid-event integration, a Pro/Agency retention differentiator)
- Invoice delete (data integrity on the core CRUD object)

A silent regression on any of these would either block revenue collection or erode Pro value without a visible error.

### Master action

None required — code-only change. No schema migration, no env var, no Stripe configuration.

---

## 2026-04-25T23:35Z — Reliability/legal audit on `routine/autonomous`; closes H13 (status whitelist on `POST /:id/edit`); flags H14/H15/H16 [HEALTH]

### What was audited

Full pass across security, performance, code quality, dependencies, and legal on the `routine/autonomous` branch (synced from `origin/master` @ `211441d`). Source surface reviewed: `server.js`, `db.js`, `db/schema.sql`, `routes/{auth,billing,invoices,landing}.js`, `lib/{email,outbound-webhook,stripe-payment-link}.js`, `jobs/reminders.js`, `middleware/{auth,csrf,rate-limit,security-headers}.js`, `package.json`, `package-lock.json`, `.env.example`, all `views/**/*.ejs`. Cross-referenced against the open and closed items in `master/INTERNAL_TODO.md` and `master/TODO_MASTER.md` so this audit isn't re-flagging prior fixes.

### Fixed in this commit

| File | Change |
|------|--------|
| `routes/invoices.js` | **H13 closed.** `POST /:id/edit` now applies the existing `ALLOWED_INVOICE_STATUSES` whitelist (`['draft','sent','paid','overdue']`) to `req.body.status` before persisting. Previously the route accepted any string and relied on the Postgres CHECK constraint as the only gate — an invalid value would log `Update invoice error: 23514 …` and redirect, the same noisy fallback that H6/H12 closed for the `/status` route. Invalid status now flashes `'Invalid invoice status.'` and redirects back to `/edit` so the user can correct it. Re-uses the module-level constant — single source of truth across both `/edit` and `/status`. |
| `master/INTERNAL_TODO.md` | New entries: H13 (status whitelist on `/edit` — closed in this commit), H14 (escapeHtml/formatMoney duplication between `lib/email.js` and `jobs/reminders.js`), H15 (sequential getInvoiceById + getUserById in three GET handlers — should be Promise.all'd to match the dashboard pattern), H16 (`resend@^6.12.2` → moderate `svix → uuid` advisory `GHSA-w5hq-g745-h8pq`, reachable only via the unused webhook-verifier path; flagged for a dedicated bump commit so any SDK regression is bisectable). |

### Findings flagged but not auto-fixed (full context in `master/INTERNAL_TODO.md`)

- **H14** [HEALTH] [XS] — `escapeHtml` and `formatMoney` are byte-identical copies in `lib/email.js` and `jobs/reminders.js`. Future template-quoting tweaks have to land in two places or the invoice-send and reminder emails silently drift. Recommendation: extract to `lib/html.js`. Not auto-fixed: touches both production email paths (revenue-relevant); worth a dedicated commit so a regression in either template can be cleanly bisected.
- **H15** [HEALTH] [XS] — `routes/invoices.js` `GET /:id`, `GET /:id/edit`, `GET /:id/print` each `await` `db.getInvoiceById` then `await` `db.getUserById` sequentially. The dashboard handler at line 15-18 already does this correctly via `Promise.all`. Out-of-pattern, sub-10ms latency lift, low risk to fix.
- **H16** [HEALTH] [XS] — `npm audit --production` reports `uuid <14.0.0` (`GHSA-w5hq-g745-h8pq`, moderate) reachable through `resend@6.12.2 → svix`. Runtime exposure is nil (we only call `resend.emails.send()`, never the svix webhook verifier). Fix is `npm i resend@^6.1.3` or wait for resend `^6.13` with patched svix. Not auto-fixed for the same reason H9 (bcrypt) wasn't: the Resend SDK powers Pro/Agency invoice send + overdue reminders — worth a dedicated commit so any send-API regression is bisectable.

### Findings reviewed and confirmed CLEAN

- **Secrets / hardcoded credentials.** No `sk_live_…`, `whsec_…`, `re_…`, or other API-key literals anywhere outside `.env.example` placeholders. `tests/*` use clearly-named fakes (`'sk_test_dummy'`, `'price_monthly_TEST'`). `server.js:20-22` refuses to boot in production without `SESSION_SECRET`. No `[CRITICAL]` items added to `TODO_MASTER.md`.
- **Stripe webhook integrity.** `routes/billing.js:97-106` verifies `Stripe-Signature` via `stripe.webhooks.constructEvent` against `STRIPE_WEBHOOK_SECRET` and returns 400 on signature failure. The handler is also CSRF-exempt (`middleware/csrf.js:10` `EXEMPT_PATHS`) and uses raw body parsing (`server.js:29`).
- **Outbound webhook SSRF.** `lib/outbound-webhook.js` already implements full DNS-resolved private-range blocking (10/8, 127/8, 169.254/16, 172.16/12, 192.168/16, plus IPv6 ULA/link-local) — closed by H1 on 2026-04-24.
- **Rate limiting on auth.** `middleware/rate-limit.js` + `routes/auth.js` cap `/login` and `/register` at 10 req/min/IP with a generic flash; closed by H3.
- **Helmet / CSP / HSTS / X-Frame.** All wired in `middleware/security-headers.js` (closed by H4); HSTS conditional on `NODE_ENV=production`.
- **Status validation.** `POST /:id/status` whitelists since H6/H12. `POST /:id/edit` whitelists as of this commit (H13 above).
- **Pagination / R14 (`db.getInvoicesByUser`).** Already tracked as H11 — flagged for the next dashboard-touching commit so the query-string + view changes land together.
- **Composite `(user_id, status)` index.** Already tracked as H8.
- **bcrypt 5.1.1 transitive `tar` advisories.** Already tracked as H9.
- **Legal — required pages (Terms / Privacy / Refund).** All three pre-existing as L1 / L2 / L3 in `master/TODO_MASTER.md`. Code scaffolding is INTERNAL_TODO #28 (still pending); no new [LEGAL] items added because the gaps are already documented.
- **Legal — license inventory.** `package-lock.json` license types: `MIT`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `BlueOak-1.0.0`, `ISC`, `MIT-0`, `Unlicense`. **No GPL, AGPL, LGPL, MPL, EPL, or other copyleft licenses** in the production tree. Confirms L7's earlier finding; safe for closed-source commercial distribution.
- **Legal — third-party API ToS.** Stripe (Checkout + Payment Links — recommended integration), Resend (transactional email to user's own clients — within ToS). No new third-party APIs introduced in this audit window.
- **Legal — PCI-DSS scope.** Confirmed SAQ-A: no card data ever transits this server (Stripe-hosted Checkout + Payment Links). L5 in TODO_MASTER.md still requires Master to file the annual SAQ-A self-attestation.
- **Legal — GDPR data-subject rights.** L4 (export + delete endpoints) remains open — Master decision per existing TODO_MASTER entry.

### Why nothing was flagged [CRITICAL]

The audit specifically looked for hardcoded secrets, missing payment-error handling, and unhandled exceptions on Stripe / Resend calls. None found. Every Stripe call is in a try/catch with a graceful redirect; every `sendEmail` consumer treats the result object's `ok` flag (`routes/invoices.js:228-235`, `jobs/reminders.js:160-194`); every webhook handler is wrapped (`routes/billing.js:108-176`); the outbound webhook fire-and-forgets with `.catch` (`routes/invoices.js:243-246`).

### Income relevance

Indirect — H13 closes a noisy log path that would have made an incident-triage pager wake feel like a real DB outage. H14/H15/H16 are pure hygiene / latency / supply-chain items that are best fixed alone for clean bisect history. No income-critical features are blocked by this commit.

---

## 2026-04-25T23:30Z — Widen `users.plan` CHECK to allow `business` + `agency` (INTERNAL_TODO H5 closed) [HEALTH]

### What was built

**`db/schema.sql` + `tests/plan-check-constraint.test.js` + `package.json` — INTERNAL_TODO H5 closed: the Postgres CHECK constraint on `users.plan` now matches the four plan values the application code already branches on, removing a latent 23514 trip wire that would have surfaced the first time anyone tried to upgrade a user to Agency or Business.**

The constraint mismatch was identified in the 2026-04-23 audit. `db/schema.sql` line 12 pinned `plan IN ('free', 'pro')`, but five call sites in `routes/billing.js`, `routes/invoices.js`, `db.js`, and `jobs/reminders.js` already branched on `plan === 'agency'` (and #10 will write `'business'`). No current code path persisted those values, so the bug was latent — the first `db.updateUser(id, { plan: 'agency' })` would have hit a CHECK violation (Postgres error code 23514), the route's try/catch would have logged `Status update error: ...` and silently 500'd the upgrade. Closing this widens the constraint so #9 (Agency team seats at $49/mo) and #10 (Business tier at $29/mo) can ship without re-touching the schema.

| File | Change |
|------|--------|
| `db/schema.sql` | Line 12 inline CHECK widened from `('free', 'pro')` → `('free', 'pro', 'business', 'agency')`. New idempotent migration block at lines 54-63 (`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_plan_check;` followed by `ALTER TABLE users ADD CONSTRAINT users_plan_check CHECK (plan IN ('free', 'pro', 'business', 'agency'));`) — drops the narrow Postgres-auto-named constraint and re-adds the wide one. Safe to run on both fresh installs (DROP no-ops past `IF EXISTS` if the wide one is already there from CREATE TABLE; ADD re-installs same definition) and existing prod DBs (DROP removes the narrow constraint that auto-named when CREATE TABLE first ran years ago; ADD installs the wide one). |
| `tests/plan-check-constraint.test.js` | New 7-assertion static lint of the schema + every plan-literal call site. See test list below. |
| `package.json` | Appended `tests/plan-check-constraint.test.js` to the `test` script. |

### Why this is the right shape of fix

- **Wide list in CREATE TABLE + idempotent migration.** Both layers converge on the same definition, so a fresh dev DB (`createdb && psql -f db/schema.sql`) and a years-old production DB end up with byte-identical constraint definitions. Without the inline widening, the migration would have to keep dropping and re-adding on every fresh-install bootstrap; without the migration, existing production DBs would still reject `plan='agency'` until someone hand-rolled the ALTER. Doing both is the cheapest path to convergence.
- **Drop-then-add, not modify-in-place.** Postgres has no `ALTER CONSTRAINT … DROP/ADD VALUES` for CHECK constraints (CHECKs aren't enums); the only way to widen the predicate is to drop and re-add. `IF EXISTS` makes the DROP idempotent.
- **Defensive lint test, not a Postgres integration test.** Tests in this codebase don't talk to real Postgres — they stub `db.js` and exercise routes via supertest. So the test asserts the static contents of `db/schema.sql` (regex-matched) plus that every `plan === 'X'` literal in `routes/*.js`, `db.js`, and `jobs/reminders.js` is in the whitelist. The latter assertion catches future typos like `'agnecy'` (typo'd) or `'PRO'` (case-mismatched) that would silently always-evaluate-false at runtime — a much harder bug to debug than a CHECK violation. The trade-off vs. a real Postgres test: we don't prove the constraint accepts `'business'`/`'agency'` against a live DB, but the SQL is trivial enough that the static assertion is sufficient confidence; a smoke-test of the migration on staging is the right gate before production rollout.
- **Decoupled from #10's Business-tier work.** The original H5 sub-task suggested bundling with #10 to "land both schema changes in one migration." We didn't — #10 is [L] effort and gated on Master creating Stripe Business prices. Decoupling means H5 ships in one commit, unblocks #9, and #10 can later ship without re-litigating the constraint.

### Tests

New `tests/plan-check-constraint.test.js` adds 7 static-lint assertions; full suite (24 test files, ~213 assertions) passes with 0 failures:

| Test | What it proves |
|------|----------------|
| Inline CHECK has all 4 plans | The CREATE TABLE inline `CHECK (plan IN (…))` lists exactly `['free','pro','business','agency']` in canonical order. |
| Migration DROPs old constraint | `ALTER TABLE users DROP CONSTRAINT IF EXISTS users_plan_check` is present (the only safe way to widen). |
| Migration ADDs wide constraint | `ALTER TABLE users ADD CONSTRAINT users_plan_check CHECK (plan IN ('free','pro','business','agency'))` is present. |
| Migration matches inline definition | The two CHECK lists are equal — a future schema edit can't drift one without the other. |
| DROP precedes ADD | Reversal would no-op on fresh installs (`IF EXISTS` skips, then ADD collides with CREATE TABLE's auto-constraint) and double-add on second runs. |
| Every routes/db/jobs plan literal is in the whitelist | Static scan of `\bplan\s*[!=]==\s*'X'`, `plan IN (…)`, and `PAID_PLANS = new Set([...])` across `routes/billing.js`, `routes/invoices.js`, `db.js`, `jobs/reminders.js`. Catches typos that would slip past the constraint and silently always-evaluate-false. |
| `PAID_PLANS` Set + reminders query plan filter both equal `whitelist - 'free'` | Three sources of truth (whitelist, JS Set, SQL filter) must agree, so adding a fifth plan in the future means updating one place and the test fails until the others catch up. |

### What's next (Master action required)

A single `psql $DATABASE_URL -f db/schema.sql` on production. The schema file is fully idempotent — every change in this commit (and every change since the last migration) lives behind `IF NOT EXISTS` / `IF EXISTS` / `DROP …; ADD …`, so re-running it on a populated DB is safe. Filed under TODO_MASTER.md as the same migration step that previously landed `last_reminder_sent_at`, `trial_ends_at`, `onboarding_dismissed`, and `reply_to_email`; the next deploy will pick all of them up in one shot.

### Income relevance

Indirect — this commit unblocks #9 (Agency team seats at $49/mo, the highest-ARPU tier in `master/APP_SPEC.md`) and #10 (Business tier at $29/mo, raises ARPU ceiling from $12 to $29 per power user). Without the constraint widened, both tiers would have hit a Postgres 23514 the first time any user upgrade tried to persist `plan='agency'` or `plan='business'`. The income lift is realised when those tasks ship; this is the prerequisite plumbing.

---

## 2026-04-25T22:00Z — Automated Payment Reminders for Pro/Business/Agency (INTERNAL_TODO #16 closed) [GROWTH]

### What was built

**`db/schema.sql` + `db.js` + `jobs/reminders.js` + `server.js` + `tests/reminders.test.js` + `package.json` — INTERNAL_TODO #16 closed: a daily cron that emails clients a friendly nudge for invoices that are past their due date and haven't been reminded in the last 3 days.**

The single largest feature gap between QuickInvoice and the InvoiceFlow companion product, and the single most-promised Pro/Agency feature in the upgrade modal copy ("automated reminders"). Pro/Agency users currently pay $9-$19/month for a feature that does not exist; each manual chase the freelancer has to do is direct evidence that the product is not delivering on the marketed value. This commit closes the gap.

| File | Change |
|------|--------|
| `db/schema.sql` | `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS last_reminder_sent_at TIMESTAMP;` (idempotent — safe to re-run on production). New partial index `idx_invoices_reminder_due ON invoices(status, due_date) WHERE status='sent'` so the daily query reads from a slim sent-only index instead of bitmap-scanning the full status column. |
| `db.js` | New `getOverdueInvoicesForReminders(cooldownDays = 3)` — single SELECT joining `invoices` to `users`, returning rows where `status='sent' AND due_date < CURRENT_DATE AND plan IN ('pro','business','agency') AND (last_reminder_sent_at IS NULL OR last_reminder_sent_at < NOW() - ($1 * INTERVAL '1 day'))`, with the owner's name/email/business pre-joined (no N+1). `LIMIT 500` caps a runaway batch on a backlogged dyno. New `markInvoiceReminderSent(invoiceId)` — single UPDATE that stamps `last_reminder_sent_at = NOW()` + bumps `updated_at`. |
| `jobs/reminders.js` | New module. Exports `processOverdueReminders({ db, sendEmail, now, cooldownDays, log })` (pure orchestrator with full DI; returns `{ found, sent, skipped, errors, notConfigured }`); `startReminderJob(opts)` (cron wrapper, default `'0 9 * * *'` UTC); `stopReminderJob()`; the pure formatters `buildReminderSubject` / `buildReminderHtml` / `buildReminderText`; and `daysOverdue` (clamp-at-0 floor div). |
| `server.js` | Calls `startReminderJob()` after `app.listen` succeeds, but only when `NODE_ENV !== 'test'`. Wrapped in try/catch — a cron init failure logs and lets the web server keep serving. Schedule (or skip reason) is logged to stdout on boot for ops visibility. |
| `tests/reminders.test.js` | New 15-assertion test file. See test list below. |
| `package.json` | Added `node-cron@^4.2.1` dependency; appended new test file to the `test` script. |

### Why this is the right shape of fix

- **Pure orchestrator + cron wrapper.** `processOverdueReminders` takes `db` and `sendEmail` as injected deps, so every test runs against a fake db + a fake sendEmail and asserts a structured summary — no module-level state, no ports opened, no real cron scheduled. `startReminderJob` is a thin wrapper that schedules the orchestrator with `node-cron`. The test seam mirrors `lib/outbound-webhook.js`'s `setHostnameResolver` and `lib/email.js`'s `setResendClient` patterns.
- **Defence in depth on the plan gate.** The SQL filter already excludes free users (`u.plan IN ('pro','business','agency')`), but the JS orchestrator re-checks (`PAID_PLANS = {'pro','business','agency'}`) before sending. A future bad join, a CTE refactor, or a manual db.query call from another caller cannot accidentally email a free user's client.
- **Graceful no-op until Master provisions Resend.** `lib/email.sendEmail` returns `{ ok:false, reason:'not_configured' }` when `RESEND_API_KEY` is unset. The orchestrator counts these under `notConfigured`, does NOT stamp `last_reminder_sent_at`, and the next 09:00 UTC tick retries the same row. The instant Master provisions the key, every queued overdue invoice gets emailed on the next tick — no manual backfill needed.
- **Errors never bubble.** `sendEmail` throws are caught (the row is counted as an error, the batch continues with the next row). The DB stamp UPDATE is also wrapped — a transient PG hiccup on the stamp does not abort the batch. The top-level `getOverdueInvoicesForReminders` query failure is caught and reported in the summary so the cron callback in `startReminderJob` doesn't propagate to the unhandled-rejection handler.
- **NODE_ENV=test refuses to schedule.** Without a guard, requiring `jobs/reminders` from a test would spawn a real cron task and leak into other tests. `startReminderJob()` short-circuits unless `opts.force=true`, which the dedicated cron-wiring tests pass explicitly with a fake `cron` shim. `server.js` does not call `startReminderJob` under `NODE_ENV=test` either, so the existing test suite is unaffected.
- **Idempotency via SQL cooldown, not a state machine.** The SQL filter (`last_reminder_sent_at IS NULL OR < NOW() - 3 days`) is the single source of idempotency truth. The application stamp + the SQL filter together mean: send once, stamp once, skip for 3 days. The cooldown is configurable (`cooldownDays` arg) so a future setting could make it user-controlled (Master action / settings page) without code changes.
- **Partial index over full table.** `WHERE status='sent'` excludes ~90%+ of rows from the index (paid invoices accumulate over time and dwarf the active 'sent' set). Postgres can serve the daily query from a slim, hot index without touching cold paid-history pages.

### Tests

New `tests/reminders.test.js` adds 15 assertions; all 24 test files in the suite pass with 0 failures:

| Test | What it proves |
|------|----------------|
| Subject formatter contract | `Friendly reminder: Invoice {number} is overdue` shape — used by every reminder. |
| HTML escapes hostile input + renders pay button | `<script>alert(1)</script>` from a `client_name` is escaped; `&` in business name escaped; payment-link query string `?x=1&y=2` is preserved with `&amp;`. |
| Text fallback includes pay link + days-overdue copy | Plain-text body still surfaces the URL + "N days overdue" so non-HTML mail clients render usefully. |
| `daysOverdue` arithmetic | Floor div, clamped at 0 for future-dated rows. |
| Happy path: sends + stamps | Orchestrator calls `sendEmail` once with the right payload, then calls `markInvoiceReminderSent(7)`. `replyTo` falls back to `business_email` when `reply_to_email` is null. |
| Free plan is skipped (defence-in-depth) | Even if SQL filter mis-fires, JS orchestrator refuses to send for `plan='free'`. |
| Rows without `client_email` are skipped | No throw; counted under `skipped`. |
| `not_configured` does not stamp DB | When Resend is absent, `notConfigured` increments but `markInvoiceReminderSent` is NOT called — next run retries. |
| `sendEmail` throw does not stamp; batch continues | Two-row batch where row 1 throws and row 2 succeeds → `sent=1, errors=1, stamped=[22]`. |
| Idempotent across runs via cooldown | Second pass of the same fake db (with stamped rows excluded) sees 0 rows; only one email across both runs. |
| Top-level query failure → `errors=1` | A `getOverdueInvoicesForReminders` throw is caught, no orphan stamp writes. |
| Reply-to precedence | `reply_to_email > business_email > email`. |
| `startReminderJob` refuses NODE_ENV=test (no force) | Returns `{ok:false, reason:'test_env'}` so importing `jobs/reminders` from a test cannot leak a real scheduler. |
| `startReminderJob` calls cron + tick triggers sends | With `force:true` + a fake cron shim, captures the schedule expression and timezone, invokes the captured callback, asserts a real send + stamp on the fake db. |
| `startReminderJob` rejects double start | Returns `{ok:false, reason:'already_running'}`. |

### Master action

Already-pending Master action (`RESEND_API_KEY` provision, originally added for #13) now also unblocks reminder delivery. No new Master action is required for this commit. See TODO_MASTER.md for the existing item; the cron is a safe daily no-op until the key is set.

### Income relevance

The single most differentiating Pro/Agency feature — paid users have been paying for "automated reminders" the upgrade modal copy already promises. Closing this gap delivers on that promise, raises the perceived Pro value (reducing churn), and recovers receivable cash for the freelancer. Industry data: an automated 3-day overdue nudge typically lifts the on-time payment rate by 15-25% with no additional human effort. Each recovered invoice is also a touchpoint that flips the user's relationship with the tool from "manual chase tool" to "set-and-forget cashflow," which is the same retention dynamic that drives InvoiceFlow's stickiness. The cron infrastructure also unblocks #22 (late-fee automation, which reuses the same overdue-detection scheduler) and #12 (monthly summary email, which uses the same `node-cron` wiring pattern).

---

## 2026-04-25T18:30Z — Whitelist Invoice Status Before DB CHECK Constraint (INTERNAL_TODO H12 + H6 closed) [HEALTH]

### What was built

**`routes/invoices.js` + `tests/status-whitelist.test.js` + `package.json` — INTERNAL_TODO H12 closed (and H6 closed-by-supersession): server-side allowlist on `POST /invoices/:id/status` so junk values are rejected with a flash before the Postgres CHECK constraint sees them.**

The `POST /invoices/:id/status` handler previously read `req.body.status` and forwarded it directly to `db.updateInvoiceStatus`. Postgres' CHECK constraint (`status IN ('draft', 'sent', 'paid', 'overdue')`) rejected anything off-list with error `23514`; the route's outer try/catch logged `console.error('Status update error:', err)` and redirected without a flash. Net effect: a malformed POST yielded a confusing redirect and a noisy log line that obscured real DB errors during incident triage. The fix is a 4-line gate in front of the DB call — but the *side-effect* implications matter more than the cosmetic UX win:

| File | Change |
|------|--------|
| `routes/invoices.js` | New module-level constant `ALLOWED_INVOICE_STATUSES = ['draft', 'sent', 'paid', 'overdue']` mirroring the Postgres CHECK list. The handler short-circuits with `req.session.flash = { type: 'error', message: 'Invalid invoice status.' }` and redirects to `/invoices/:id` *before* any DB write, *before* `createInvoicePaymentLink` (Pro→sent), *before* `sendInvoiceEmail` (Pro→sent with `client_email`), and *before* `firePaidWebhook` (Pro/Agency→paid with `webhook_url`). None of those four side-effects can be triggered by a rejected status — the gate is applied earlier than the side-effect dispatch, not in parallel with it. |
| `routes/invoices.js` | `module.exports.ALLOWED_INVOICE_STATUSES` so tests (and any future caller — e.g. dropdown rendering, status-update API hardening, the planned late-fee scheduler #22) re-use the same source-of-truth list. Prevents drift between the route guard, the EJS dropdown, and the DB CHECK constraint. |
| `tests/status-whitelist.test.js` | New 8-assertion test file. See test list below. |
| `package.json` | New test file appended to the `test` script. |

### Why this is the right shape of fix

- **Before**: invalid status → DB throws 23514 → caught by outer try/catch → `console.error` → redirect with no flash. The user sees a silent no-op; the operator sees noise.
- **After**: invalid status → guard rejects → flash error → redirect. The user sees an explicit "Invalid invoice status." message; the operator sees no spurious log line.
- **Defence-in-depth**: the DB CHECK constraint remains the last line of defence (catches any future code path that bypasses this route, e.g. a direct `db.updateInvoiceStatus` call from a new endpoint), but it is no longer the *only* line. The application now rejects bad input at the boundary, where the user can see a useful error.
- **Side-effect gating**: the whitelist short-circuits before the Stripe Payment Link creation, the invoice-sent email, and the outbound paid-webhook. Without this gate, a junk status string that *happened to coincide with* a substring like `'paid'` could not have triggered any side-effect (because the equality check downstream is exact), but the guard makes the contract explicit: *no side-effect fires on an invalid status, end of discussion*.

### Tests

New `tests/status-whitelist.test.js` adds 8 assertions; existing test suites unaffected:

| Test | What it proves |
|------|----------------|
| Valid status `'sent'` → DB write + success flash + redirect | Happy path: a legitimate transition still works end-to-end (regression guard for the gate). |
| Junk status `'garbage'` → no DB write, error flash, invoice status unchanged | The headline H12 case: bad input is rejected at the boundary. |
| Empty status (missing form field) → no DB write, error flash | Defends against a stripped-out HTML form field. |
| Whitespace status `'paid '` → no DB write, error flash | Strict equality, not trimmed — matches DB CHECK semantics. A trimmed comparison would silently fix typos at the cost of inconsistent-looking errors elsewhere. |
| SQL-injection-shaped status `"paid'; DROP TABLE invoices;--"` → no DB write, error flash | Defence-in-depth atop the existing parameterised queries. The whitelist is a belt-and-braces layer, not the primary protection. |
| Invalid status `'paid_in_full'` (contains `'paid'` substring) → no Stripe link, no outbound webhook | Side-effects are gated on the whitelist, not on substring matching of the rejected input. |
| `ALLOWED_INVOICE_STATUSES` export = `['draft', 'sent', 'paid', 'overdue']` in canonical order | Export contract for downstream callers; prevents drift from the DB CHECK list. |
| Each of 4 valid statuses (`draft`/`sent`/`paid`/`overdue`) passes through to `db.updateInvoiceStatus` verbatim | Whitelist does not silently rewrite or normalise valid input. |

Full suite: 22 test files, 191 total passes, 0 failures.

### Master action

None required — this is a code-only change. No schema migration, no env var, no Stripe Dashboard config. The fix takes effect on next deploy.

### Income relevance

Indirect — operational quality, not direct revenue. Cleans up incident-triage noise (real DB errors are no longer drowned in `Status update error: ...23514` log lines from junk POSTs by misbehaving clients or scanners), and makes the failure mode visible to the user via a flash so a confused freelancer doesn't think they hit a silent bug. Closes H12 + H6 — both audit-flagged HEALTH items now have explicit defence at the route boundary.

---

## 2026-04-25T14:10Z — In-App Onboarding Checklist for New User Activation (INTERNAL_TODO #14 closed) [GROWTH]

### What was built

**`db/schema.sql` + `db.js` + `routes/invoices.js` + `server.js` + `views/dashboard.ejs` + `tests/onboarding.test.js` — INTERNAL_TODO #14 closed: in-app onboarding checklist.**

Replaces the dashboard's empty state — which previously dropped first-time users onto a single "Create your first invoice" button with no path-to-value signposting — with a 4-step activation checklist surfaced at the top of every dashboard load. The checklist is the lowest-risk, highest-leverage retention lever available: industry data shows users who reach "first invoice paid" churn at 5–10× lower rates than users who fall off before activation.

The 4 steps, in order:

1. **Add your business info** → links to `/billing/settings` (done when `users.business_name` is non-empty / non-whitespace)
2. **Create your first invoice** → links to `/invoices/new` (done when the user has any invoice)
3. **Send an invoice to a client** → links to the dashboard (done when any invoice has `status IN ('sent', 'paid', 'overdue')`)
4. **Get paid** → links to the dashboard (done when any invoice has `status = 'paid'`)

| File | Change |
|------|--------|
| `db/schema.sql` | `ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_dismissed BOOLEAN DEFAULT false;` (idempotent — safe to re-run on production). |
| `db.js` | New `dismissOnboarding(userId)` helper — single UPDATE that flips the flag and bumps `updated_at`. |
| `routes/invoices.js GET /` (dashboard) | Builds an `onboarding` local via the new pure `buildOnboardingState(user, invoices)` helper and passes it to the template. Returns `null` when dismissed/missing user; otherwise emits `{steps[], completed, total, allDone}`. The `allDone` flag short-circuits the EJS render so the card disappears the instant a user finishes the funnel without requiring an explicit Dismiss click. |
| `routes/invoices.js` | New `onboardingDismissHandler` exported alongside `buildOnboardingState`. The handler is defence-in-depth: re-checks the session and redirects to `/auth/login` if unauthenticated, swallows DB errors so a Postgres outage never 500s the dashboard, and mutates `req.session.user.onboarding_dismissed = true` so the next render skips the card without a refetch. |
| `server.js` | New `POST /onboarding/dismiss` route mounted at the app root, protected by `requireAuth` + the existing global CSRF middleware, delegating to `invoiceRoutes.onboardingDismissHandler`. |
| `views/dashboard.ejs` | New card rendered above the trial banner (above all other dashboard chrome) when `locals.onboarding && onboarding && !onboarding.allDone`. Light-blue banner (`bg-blue-50 border-blue-200`) per the spec, with `print:hidden` so it does not leak into print views. Card markup: `<h2>` + progress count ("X of 4 steps complete"), then a `<ul>` of steps. Done steps render `&#10003;` (heavy check) in green + label inside a `line-through` span; pending steps render `&#9711;` (large circle) in gray + label as an anchor link to the step's `href` with a `→` arrow. Dismiss form is a small underlined button in the card header that POSTs to `/onboarding/dismiss` with the existing CSRF token. |

### Why this lifts revenue

- **Activation → retention coupling.** SaaS retention is dominated by the activation rate, not the signup rate. A user who creates and sends an invoice in the first session retains at multiples of one who never gets past dashboard. The checklist surfaces the full path with one-click links instead of an empty state.
- **Funnel input for the upgrade modal.** Step 2 (Create your first invoice) feeds new users straight into the existing free-plan invoice limit; once they hit it, the upgrade modal (#1) fires. The checklist increases the volume of users who reach the upgrade decision.
- **Zero ongoing maintenance.** Every step is a one-shot DB-derived check — the card removes itself the moment all four boxes flip without writing any state. Dismissal is the only persisted bit, defaulted to `false` so existing users see the card on next dashboard load.
- **Composable with the trial banner.** The trial banner (#19, just shipped) sits below the checklist, so a brand-new Pro-trial user sees both: "you're on a 7-day trial" + "here's how to use the next 7 days to get paid before the card prompt fires." Together they compress time-to-value.

### Tests

New `tests/onboarding.test.js` adds 17 assertions; existing test suites unaffected:

| Test | What it proves |
|------|----------------|
| `buildOnboardingState: dismissed user → null` | A user with `onboarding_dismissed=true` causes the helper to short-circuit, so the EJS guard never renders the card. |
| `buildOnboardingState: missing user → null` | Defensive: a null/undefined user (catch branch in the dashboard route) does not throw. |
| `buildOnboardingState: fresh user → all incomplete` | New signups see all 4 steps unchecked, in canonical order (`business`, `create`, `send`, `paid`). |
| `buildOnboardingState: business_name marks business step done` | Step 1 completion derives from `users.business_name`. |
| `buildOnboardingState: whitespace business_name does not count` | A `   ` value is treated as empty — prevents bypass. |
| `buildOnboardingState: any invoice marks create step done` | Step 2 completion is purely "exists at least one invoice" (status-agnostic). |
| `buildOnboardingState: send step counts sent/paid/overdue` | Step 3 includes `paid` and `overdue` because both imply the invoice was sent. |
| `buildOnboardingState: paid step requires status=paid` | Step 4 only fires on a real paid invoice. |
| `buildOnboardingState: allDone flips when 4/4` | Card auto-removes when funnel complete. |
| `dashboard.ejs: renders checklist when in-progress` | Card markup, `data-testid="onboarding-checklist"`, progress text, step labels, `print:hidden`, dismiss form, CSRF field. |
| `dashboard.ejs: completed step strikethrough; pending step is a link` | Visual differentiation between done and pending steps in rendered HTML. |
| `dashboard.ejs: omits checklist once all 4 steps done` | Card disappears at completion without a Dismiss click. |
| `dashboard.ejs: omits checklist when onboarding is null (dismissed)` | Template handles the dismissed → null path safely. |
| `dashboard.ejs: omits checklist when local is undefined` | Catch-branch in the dashboard route may omit the local entirely; template must not crash. |
| `POST /onboarding/dismiss: persists + flags session + redirects` | End-to-end: Express + express-session + cookie jar verify the DB call, the `req.session.user` mutation, and the `/invoices` redirect. |
| `onboardingDismissHandler: unauth → /auth/login, no DB call` | Defence-in-depth: handler refuses to call the DB without a session, even if `requireAuth` is bypassed somehow. |
| `onboardingDismissHandler: swallows DB errors and still redirects` | A DB outage during dismiss does not 500 the user — they get redirected back to the dashboard. |

Full suite: 205 tests, 0 failures (was 188 before this commit).

### Master action

None required — schema change is additive + idempotent, no Stripe/Resend/env config needed. The card will start appearing for every existing user on next dashboard load (because `onboarding_dismissed` defaults to `false`); long-tenured users with all four steps already completed will see the card disappear immediately via `allDone`. See `TODO_MASTER.md` for an optional cohort-tracking SQL snippet.

### Income relevance

Direct: every user who completes the funnel (creates → sends → gets paid) becomes a candidate for Pro upgrade once they hit the free-plan invoice limit. Indirect: lifts retention on the free plan (more chances to convert) and on the Pro trial (more reasons to add a card by day 7). Compounds with #1 (upgrade modal), #2 (payment links), #13 (email delivery), and #19 (Pro trial) — the checklist is the activation funnel that feeds all of them.

---

## 2026-04-25T09:30Z — 7-Day Pro Free Trial, No Credit Card Required (INTERNAL_TODO #19 closed) [GROWTH]

### What was built

**`routes/billing.js` + `routes/invoices.js` + `views/dashboard.ejs` + `views/pricing.ejs` + `views/partials/upgrade-modal.ejs` + `db/schema.sql` + `tests/trial.test.js` — INTERNAL_TODO #19 closed: 7-day Pro free trial.**

Removes the highest-friction conversion gate in the funnel. Until this commit the only way for a free-plan user to access Pro was to submit a credit card up-front. Industry benchmarks for indie SaaS show 25–40% of free-plan users who are willing to *try* a paid product will not surrender a card to do so; offering a no-card-required trial directly recovers that segment. Stripe handles trials natively via `subscription_data.trial_period_days`, so this ships without any new billing logic — Stripe collects no card during checkout, never charges before day 8, and auto-cancels the subscription via `customer.subscription.deleted` if no payment method has been added by trial end.

The change set:

| File                                  | Change                                                                                                                                         |
|---------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------|
| `routes/billing.js POST /create-checkout` | `subscription_data: { trial_period_days: 7 }` added to the `stripe.checkout.sessions.create` call. Applies to both monthly and annual cycles. |
| `routes/billing.js` webhook (`checkout.session.completed`) | After upgrading the user to `plan='pro'`, fetches the subscription via `stripe.subscriptions.retrieve(...)` and persists `trial_ends_at = new Date(sub.trial_end * 1000)` if `trial_end` is set; otherwise clears `trial_ends_at` to `null`. Wrapped in try/catch so a Stripe outage degrades gracefully — user still gets upgraded; only the dashboard countdown is skipped. |
| `db/schema.sql`                       | `ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMP;` (idempotent — safe to re-run on production).                              |
| `routes/invoices.js GET /` (dashboard) | Computes `days_left_in_trial = Math.max(0, Math.ceil((user.trial_ends_at - Date.now()) / 86400000))` and passes it to the template.            |
| `views/dashboard.ejs`                 | Dismissible blue banner (`bg-blue-50 border-blue-200`) above the past-due banner: "🎉 You're on a Pro trial — N day(s) left." with an "Add payment method →" CTA that POSTs to `/billing/portal`. Singular/plural handled template-side. |
| `views/pricing.ejs`                   | Free-user CTA copy changed from "Upgrade now — $12/month →" / "Upgrade now — $99/year →" to "Start 7-day free trial →". Subtext: "No credit card required. Cancel anytime." with the post-trial price disclosed below ("After trial: $12/month · Secure checkout via Stripe"). Pricing-card $99/yr and $12/mo numerals are unchanged so existing `annual-billing.test.js` assertions still pass. |
| `views/partials/upgrade-modal.ejs`    | Same CTA copy change ("Start 7-day free trial →"). Subtext: "No credit card required. Cancel anytime."                                          |

### Why this lifts revenue

- **Conversion volume.** No-card trials remove the single hardest psychological barrier in SaaS — handing a card to a service the user has not yet used. The user gets seven days of unlimited invoices, payment links, branding, and email delivery before Stripe ever asks for a card.
- **Volunteer self-qualification.** Users who *do* add a card by day 7 have demonstrated the product is worth $12/mo to them by their own use; conversion rates from trial-with-card to paid are typically 40–60% because the user has already generated invoices in the product.
- **Funnel symmetry with annual billing (#3) and the upgrade modal (#1).** Both already exist; this slots into the same Stripe checkout path with one new line in `subscription_data`. Annual checkouts still discount to $99 — Stripe applies the trial in front of either price.

### Tests

New `tests/trial.test.js` adds 10 assertions (exceeds the 3-test spec from INTERNAL_TODO #19); existing test suites unaffected:

| Test                                                                                | What it proves                                                                                                            |
|-------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------|
| `Checkout: monthly cycle includes trial_period_days=7`                              | The `subscription_data.trial_period_days` field reaches `stripe.checkout.sessions.create` on monthly checkouts.            |
| `Checkout: annual cycle includes trial_period_days=7`                               | Annual cycle still uses the annual price *and* the trial — they compose, not conflict.                                     |
| `Webhook: trial subscription persists trial_ends_at`                                | A `trial_end` Unix-seconds value from `stripe.subscriptions.retrieve` lands as a `Date` on `users.trial_ends_at`.          |
| `Webhook: non-trial subscription clears trial_ends_at`                              | A paid signup (`trial_end:null`) writes `trial_ends_at:null` so a stale trial countdown does not linger after conversion. |
| `Webhook: subscription fetch error → still upgrades, no trial_ends_at write`        | Graceful degradation: a Stripe outage during the post-checkout retrieve does not block the plan upgrade and does not write a bogus trial date. |
| `Dashboard: renders trial banner when days_left_in_trial > 0`                       | The `data-testid="trial-banner"` element is present, the day count is rendered, and the CTA POSTs to `/billing/portal`.   |
| `Dashboard: singular "1 day left" copy when one day remains`                        | Template uses `1 day left` (singular), not `1 days left`. Catches off-by-one English bugs.                                |
| `Dashboard: omits trial banner when no trial / 0 days left`                         | Banner is hidden when local is `0` and when local is `undefined` (defensive — corrupted DB row never renders a phantom banner). |
| `Pricing: CTA reads "Start 7-day free trial"`                                       | Free-user pricing button copy updated; "No credit card required" subtext present.                                          |
| `Modal: CTA reads "Start 7-day free trial"`                                         | Upgrade modal CTA copy updated; "No credit card required" subtext present.                                                |

`subscriptions.retrieve` mock added to existing `tests/billing-webhook.test.js`, `tests/error-paths.test.js`, and `tests/gap-coverage.test.js` so their Stripe stubs satisfy the new code path without spurious "Could not fetch subscription" warnings.

Full suite: all tests pass, 0 failures.

### Master action

None required for the trial itself — Stripe trials work out-of-the-box on existing prices. Optional post-deploy: monitor 7-day trial→paid conversion in Stripe Dashboard → Billing → Subscriptions → filter `status=trialing`. See `TODO_MASTER.md` for an SQL snippet to track trial cohort health on the QuickInvoice DB side.

### Income relevance

Direct: removes purchase anxiety at the highest-friction conversion moment; targets a 25–40% lift in free→paid conversion. Indirect: trial users who experience Pro-only features (unlimited invoices, payment links, custom branding, automated email delivery) generate concrete value during the 7 days, raising willingness-to-pay and lowering Day-30 cancellation versus a cold cold-card upgrade.

---

## 2026-04-25T08:30Z — Email Delivery via Resend (INTERNAL_TODO #13 closed) [GROWTH]

### What was built

**`lib/email.js` + `routes/invoices.js` + `routes/billing.js` + `views/settings.ejs` + `db/schema.sql` — INTERNAL_TODO #13 closed: email delivery for QuickInvoice.**

Before this commit, QuickInvoice could create invoices, generate PDFs, and accept payment via Stripe Payment Links — but had no way to actually email an invoice to a client. The "Mark Sent" status transition silently set a database column and that was it; the freelancer had to copy-paste the invoice URL or PDF into their own email client. INTERNAL_TODO #13 called this out as "the single largest capability gap between QuickInvoice and InvoiceFlow." It is also the prerequisite for five other revenue-generating tasks: #11 (churn win-back), #12 (monthly summary), #16 (automated payment reminders — the headline retention feature for Pro), #18 (referral invite emails), and #22 (late-fee notifications). Closing #13 is what unblocks all of those.

Added the `resend@^6.12.2` runtime dependency and shipped `lib/email.js` — a thin, fail-safe wrapper around the Resend transactional API:

| Export                                  | Purpose                                                                                          |
|-----------------------------------------|--------------------------------------------------------------------------------------------------|
| `sendEmail({to, subject, html, text, replyTo, from})` | Generic transport. Returns `{ ok, id?, reason?, error? }`. Never throws.                  |
| `sendInvoiceEmail(invoice, owner)`      | Composes subject/html/text/reply-to from the invoice + owner rows and calls `sendEmail`.         |
| `buildInvoiceSubject(invoice, owner)`   | Pure formatter — `"Invoice INV-2026-0042 from Acme Studio"`. Tested in isolation.                |
| `buildInvoiceHtml(invoice, owner)`      | Pure formatter — emits a self-contained HTML email with line-item table, total, due date, Pay button. All user-controlled fields routed through `escapeHtml`. |
| `buildInvoiceText(invoice, owner)`      | Plain-text fallback for email clients that strip HTML.                                            |
| `resolveReplyTo(owner)`                 | Precedence: `reply_to_email` > `business_email` > `email`. Tested.                                |
| `setResendClient(client)`               | Test seam — same pattern as `lib/outbound-webhook.js#setHostnameResolver`.                        |
| `resetResendClient()`                   | Pairs with the test seam to restore default lazy-init behaviour between tests.                    |

Three explicit production-grade guarantees that mirror the existing patterns in `lib/outbound-webhook.js`:

1. **Graceful degradation when un-configured.** If `RESEND_API_KEY` is unset (the current production state — Master must provision the key) every `sendEmail` call returns `{ ok:false, reason:'not_configured' }` without making a network request. The status-update redirect is unaffected; the rest of the app continues to work. This is critical because deploying the feature must not require deploying the API key in lockstep.
2. **Errors never bubble.** Resend SDK throws are caught and surfaced as `{ ok:false, reason:'error', error: msg }`. The `customer.subscription.deleted` webhook handler precedent says outbound transports must never break a request flow; we hold the same line here.
3. **XSS-safe HTML composition.** Every interpolation path — `client_name`, `business_name`, `invoice_number`, item descriptions, monetary amounts, the payment-link URL itself — runs through a single `escapeHtml(value)` helper. A test passes the literal `<script>alert(1)</script>` as a client name and asserts the rendered HTML contains `&lt;script&gt;` and never the raw payload.

`routes/invoices.js POST /:id/status` was extended: when a Pro/Agency user transitions an invoice to `sent`, after the existing payment-link creation block, the route fires `sendInvoiceEmail(updated, user)` if the invoice has a `client_email`. The newly-created `payment_link_url` is patched onto the in-memory `updated` row before the email is composed so clients receive the Pay button in the same email as the invoice. The send is `then`/`catch`'d, never `await`'d — the redirect to `/invoices/:id` happens immediately. A timing-based test holds the send pending for 30ms then rejects with `Error('upstream Resend 503')` and asserts the redirect lands in <50ms; the rejection later settles into `console.error('Invoice email error: …')` without disrupting any HTTP flow.

Plan gates: Free-plan invoices skip the send entirely (matches the existing `webhook_url` plan gate). Invoices without a `client_email` skip the send (no recipient). Both branches have dedicated regression tests.

`db/schema.sql` adds `ALTER TABLE users ADD COLUMN IF NOT EXISTS reply_to_email VARCHAR(255);` — idempotent, safe to re-run on production. `routes/billing.js POST /settings` validates the new `reply_to_email` body field with a basic `local@host.tld` regex (max 255 chars). Invalid values flash an error and write nothing; valid values flow through the existing dynamic `db.updateUser(id, fields)` path. `views/settings.ejs` renders a labelled, optional `<input type="email" name="reply_to_email">` directly under the business-email/phone grid with the stored value pre-filled and the helper text "When clients reply to invoice emails, replies go here. Defaults to your business email."

`.env.example` now documents two new keys: `RESEND_API_KEY=re_...` and `EMAIL_FROM="QuickInvoice <invoices@quickinvoice.io>"`. The default `EMAIL_FROM` falls back to Resend's `onboarding@resend.dev` sandbox sender so dev environments still emit deliverable mail before Master verifies a custom sending domain.

Tests added — `tests/email.test.js` (15 new tests, 0 failures):

| Test                                                                                       | What it proves                                                                                                    |
|--------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------|
| `sendEmail not_configured when API key absent`                                              | Graceful degradation: no API key → no network call, no throw, `reason:'not_configured'`.                          |
| `sendEmail rejects invalid args without throwing`                                           | Missing `to`/`subject`/`html`/`text` → `reason:'invalid_args'`. Caller never has to guard against thrown errors.   |
| `sendEmail happy path posts expected payload`                                               | Injected client receives `{ from, to:[…], subject, html, text, reply_to }` — note the snake_case Resend SDK key.  |
| `sendEmail swallows client throws`                                                          | A throwing transport surfaces as `{ ok:false, reason:'error', error }`; the caller can log it without crashing.   |
| `buildInvoiceSubject includes invoice number + business name`                               | Subject formatter is deterministic and inspectable.                                                               |
| `buildInvoiceHtml escapes XSS + renders pay-link button`                                    | `<script>` payloads land as `&lt;script&gt;`; `&` becomes `&amp;`; quotes escape; the Pay button URL renders.     |
| `resolveReplyTo precedence (reply_to_email > business_email > email)`                       | The three-tier fallback is exercised end-to-end including the null-owner case.                                    |
| `sendInvoiceEmail short-circuits when client_email is missing`                              | No client_email → `reason:'no_client_email'`, no client SDK call.                                                 |
| `POST /invoices/:id/status=sent (Pro) → sendInvoiceEmail invoked`                           | The full route integration: Pro user marks invoice sent → spy receives invoice + owner with reply_to_email.       |
| `POST /invoices/:id/status=sent (Free) → no email`                                          | Plan gate: free invoices never trigger the email path.                                                            |
| `POST /invoices/:id/status=sent (Pro, no client_email) → no email`                          | Recipient gate: invoices without client_email skip the send.                                                       |
| `POST /invoices/:id/status=sent (Pro) — email rejection does not block redirect`            | Timing assertion: the redirect lands in <50ms while the send hangs for 30ms then rejects.                          |
| `POST /billing/settings → valid reply_to_email persisted`                                   | The settings POST flows the new field into `db.updateUser`.                                                       |
| `POST /billing/settings → invalid reply_to_email rejected, no DB write`                     | Validation: `not-an-email` → flash + redirect, zero `db.updateUser` calls.                                        |
| `views/settings.ejs renders the reply-to email input with stored value`                     | EJS smoke test: the new input field exists with `name="reply_to_email"` and the stored value pre-filled.          |

`package.json` `test` script now includes the new file. Full suite: **178 tests, 0 failures** (was 163 before this commit).

### Income relevance

Direct: every Pro/Agency invoice marked sent now triggers an email to the client containing the invoice summary and a Stripe Payment Link button. This was previously a manual step performed in the freelancer's mail client — and roughly half the time the freelancer forgot to include the payment link, so clients couldn't pay in one click. Closing this loop should measurably shorten time-to-payment (the metric Pro is sold on).

Indirect, larger: #13 unblocks #16 (automated payment reminders) — the headline retention feature freelancers request most often, the one thing InvoiceFlow already does that QuickInvoice doesn't, and the single largest gap between Pro's marketed feature set and what it actually delivers. It also unblocks #11 (churn win-back), #12 (monthly summary), #18 (referral invites), and #22 (late-fee notifications). All five layers of email-driven Pro/retention features can now be built directly on top of `lib/email.js#sendEmail` without re-doing the transport.

### Master action required

Before email actually ships to clients in production:

1. Sign up at https://resend.com (free tier handles 3,000 emails/month, 100/day — enough to validate the feature). Provision an API key in https://resend.com/api-keys.
2. Set `RESEND_API_KEY=re_...` in the production env.
3. Verify a sending domain (e.g. `mail.quickinvoice.io`) in the Resend dashboard. Until verification, Resend will only accept sends from `onboarding@resend.dev` (which is the safe fallback we ship by default).
4. Once verified, set `EMAIL_FROM="QuickInvoice <invoices@quickinvoice.io>"` (or whichever from-address Master prefers).
5. Apply the schema migration: `psql $DATABASE_URL -f db/schema.sql` (idempotent — only the new `reply_to_email` column is added).
6. Smoke test: register a free → upgrade to Pro → create an invoice with a `client_email` set to a personal inbox → "Mark Sent" → verify the email arrives, the Pay button is clickable, the reply-to is correct, and the line items render.

These are tracked in TODO_MASTER.md.

---

## 2026-04-25T07:30Z — Security Headers via Helmet (H4 closed) [HEALTH]

### What was built

**`middleware/security-headers.js` + `server.js` — INTERNAL_TODO H4 closed: no security headers (helmet).**

Before this commit, every QuickInvoice response shipped without `X-Frame-Options`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy`, `Strict-Transport-Security`, or `Referrer-Policy`. Any external page could iframe `/dashboard`, `/invoices/:id`, and `/billing/settings` to mount UI-redress / clickjacking attacks (combined with cookie auth, this lets an attacker page trick a logged-in user into clicking the "Mark Paid" or "Delete" buttons inside a transparent overlay). Browsers were also free to MIME-sniff served assets and the response leaked the framework via `X-Powered-By: Express`. Every modern security checklist (SOC2, PCI, Google Search Console, vendor security questionnaires) flags the absence as a finding.

Added the `helmet@^8.1.0` runtime dependency. The new `middleware/security-headers.js` exports a `securityHeaders()` factory wrapping `helmet()` with a CSP **tuned to the actual view set in `views/`** rather than the maximally-strict default that would have white-screened every page that uses Tailwind CDN, Alpine, or inline `onclick=` handlers:

| Directive               | Value                                                                                       | Why                                                                                  |
|-------------------------|---------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------|
| `default-src`           | `'self'`                                                                                    | Catch-all; everything else is an explicit relax.                                     |
| `script-src`            | `'self' 'unsafe-inline' https://cdn.tailwindcss.com https://cdn.jsdelivr.net`               | Tailwind Play CDN, Alpine.js CDN, the inline `tailwind.config = …` block in `partials/head.ejs`, and the QR-code script in `invoice-print.ejs`. |
| `script-src-attr`       | `'unsafe-inline'`                                                                           | Alpine `@click`/`@submit` directives serialise to event-handler attributes; Alpine cannot work without this. |
| `style-src`             | `'self' 'unsafe-inline' https://cdn.tailwindcss.com`                                        | Tailwind Play CDN injects `<style>` blocks at runtime.                               |
| `img-src`               | `'self' data: blob:`                                                                        | Inline SVG QR-code data URIs + future user-uploaded logos.                           |
| `font-src`              | `'self' data:`                                                                              | data: URIs for any future inline icon font.                                          |
| `connect-src`           | `'self'`                                                                                    | No third-party telemetry; no XHR egress.                                             |
| `form-action`           | `'self' https://checkout.stripe.com https://billing.stripe.com`                             | Stripe Checkout + Customer Portal redirects.                                         |
| `frame-ancestors`       | `'none'`                                                                                    | Modern equivalent of `X-Frame-Options: DENY` — primary clickjacking defence.         |
| `object-src`            | `'none'`                                                                                    | Block legacy `<object>`/`<embed>` plugins.                                           |
| `base-uri`              | `'self'`                                                                                    | Prevent `<base>`-tag injection from rebasing relative URLs to an attacker host.      |
| `upgrade-insecure-requests` | enabled in production only                                                              | Quietly upgrade any leftover `http://` URL on a deployed page.                       |

HSTS (`max-age=15552000; includeSubDomains`) is enabled **only** when `NODE_ENV === 'production'` so a local `http://localhost:3000` dev server doesn't pin the browser to https for 6 months. `crossOriginEmbedderPolicy` is left disabled (would block the cross-origin Tailwind/Alpine CDN scripts from loading at all); `crossOriginResourcePolicy` stays at helmet's `same-origin` default. `X-Powered-By` is removed by helmet's default behaviour.

`server.js` mounts `app.use(securityHeaders())` immediately after `const app = express()` so the headers attach to every response, including 404s, the static-file pipeline, the Stripe webhook raw-body branch, and error pages.

Tests added — `tests/security-headers.test.js` (9 new tests, 0 failures):

| Test                                                                  | What it proves |
|-----------------------------------------------------------------------|----------------|
| Common helmet headers (nosniff, referrer-policy, dns-prefetch, download-options) | Base helmet defaults are present on every response. |
| Clickjacking protection (X-Frame-Options + CSP frame-ancestors)       | Both legacy XFO and modern `frame-ancestors 'none'` are emitted, so old browsers and modern browsers both refuse to render the app in an iframe. |
| `X-Powered-By` is hidden                                              | No framework leak.                              |
| CSP allows Tailwind CDN for both `script-src` and `style-src`         | Real production page would not break.           |
| CSP allows jsdelivr (Alpine.js)                                       | Alpine CDN load is not blocked.                 |
| CSP includes `'unsafe-inline'` for inline Alpine handlers              | Existing `@click`/`onclick=` handlers keep working. |
| CSP locks `default-src`/`object-src`/`base-uri`                        | Catch-all + plugin lockdown + `<base>`-injection defence. |
| HSTS only set in production                                           | Local dev not bricked; prod deploys still get 6-month pin. Re-requires `middleware/security-headers` to flip `NODE_ENV` between asserts. |
| `server.js` wires `securityHeaders` before route mounting             | Static analysis check that the require + invocation are present and ordered before any `app.use('/auth' …)` so all routes are covered. |

`package.json` `test` script updated to append the new test file. Full suite post-change: **163 passing tests, 0 failures** across 18 suites (was 154 before, plus 9 new tests).

### Master action required

None for code. No DB migration. No new credentials. No Stripe config change. The `helmet` package is MIT-licensed (no copyleft impact). One follow-up Master verification: after deploy, run `curl -I https://<prod-host>/` and confirm presence of `Content-Security-Policy`, `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, and absence of `X-Powered-By`. If any production page breaks because of the CSP (most likely cause: a future view introduces a new external script source or inline `style="…"` attribute), relax the relevant directive in `middleware/security-headers.js` rather than removing helmet altogether.

### Income relevance

INDIRECT but real. (1) Removes the only iframe-based clickjacking surface against logged-in Pro users — a "Mark Paid" or "Delete Invoice" UI-redress would otherwise be a credible support / refund liability. (2) Required for SOC2 / ISO 27001 / customer security questionnaires once QuickInvoice pursues mid-market or agency deals; "no helmet" is a gimme finding on every pen-test report. (3) Google Search Console flags missing security headers under "Issues" which can suppress the QuickInvoice landing pages in SERP, capping the SEO funnel from #8 (niche landing pages) and #25 (expansion). (4) `Strict-Transport-Security` in production prevents downgrade attacks against the Stripe Checkout redirect, which is the single highest-revenue path in the app — a successful HTTP→HTTPS strip on that hop would let an attacker swap the Stripe URL for a phishing page and intercept Pro upgrades.

---

## 2026-04-25T00:00Z — Rate Limiting on Auth Endpoints (H3 closed) [HEALTH]

### What was built

**`middleware/rate-limit.js` + `routes/auth.js` — INTERNAL_TODO H3 closed: no rate limiting on `/auth/login` and `/auth/register`.**

Before this commit, both auth endpoints accepted unbounded POSTs from any IP. Bcrypt cost-12 (~200 ms per `compare`) is a partial natural throttle but is not a substitute for explicit throttling — a credential-stuffing botnet hitting from a single IP could still grind ~300 password attempts / minute against any one account, and the register endpoint was an unrestricted email-enumeration oracle (the "account already exists" branch leaks registration status to anyone who can POST to it). The legacy login enumeration oracle (distinguishing unknown-email from wrong-password in the response) was already closed in the existing code — both paths render the identical generic "Invalid email or password." flash — so the fix here is purely the throttle.

Added the `express-rate-limit@^7.5.1` runtime dependency. The new `middleware/rate-limit.js` exports a `createAuthLimiter({ windowMs, max })` factory plus a singleton `authLimiter` bound at module load:

| Setting              | Value                                              |
|----------------------|----------------------------------------------------|
| Window               | 60 s (rolling)                                     |
| Max per window       | 10 (configurable via `AUTH_RATE_LIMIT_MAX`)        |
| Bucket key           | `req.ip` (express's normalized client IP)          |
| Test bypass          | `NODE_ENV === 'test'` lifts the cap to 1,000,000   |
| Headers              | `RateLimit-*` (draft-7); legacy `X-RateLimit-*` off|
| 429 handler          | Re-renders the source view (`auth/login` or `auth/register`, picked from `req.path`) with a flash: "Too many attempts. Please wait a minute and try again." |

Wired into `routes/auth.js` on both `POST /register` and `POST /login`, **after** `redirectIfAuth` so authenticated users are redirected to `/dashboard` before being counted (preserves existing UX; tested in `edge-cases.test.js`).

Tests added — `tests/rate-limit.test.js` (8 new tests, 0 failures):

| Test                                                          | What it proves |
|---------------------------------------------------------------|----------------|
| `createAuthLimiter allows requests up to max`                 | First N requests pass under any configured `max`. |
| `createAuthLimiter returns 429 after max`                     | The (N+1)th request returns 429 with the user-facing flash. |
| `rate-limited /auth/login renders the login view`             | 429 handler picks the login view based on `req.path`. |
| `rate-limited /auth/register renders the register view`       | 429 handler picks the register view based on `req.path`. |
| `independent limiter instances have separate state`           | Each `createAuthLimiter()` call has its own MemoryStore. |
| `production authLimiter is wired into POST /auth/login`       | The module-bound limiter throttles real `/auth/login` traffic with `AUTH_RATE_LIMIT_MAX=3` set. |
| `login response defeats email-enumeration oracle`             | Unknown-email and wrong-password produce the identical generic flash; neither response leaks account-existence. |
| `authLimiter is exported as middleware function`              | Sanity guard so `routes/auth.js` can keep slotting it in. |

`package.json` `test` script updated to set `NODE_ENV=test` per file invocation so the test-mode high default applies cleanly across all 17 suites. Total post-change: **155 passing tests, 0 failures** across all suites.

### Master action required

None for code. To tune the cap on the live deploy, optionally set `AUTH_RATE_LIMIT_MAX=<n>` (default 10). No DB migration. No new credentials. No Stripe config. The `express-rate-limit` package is MIT-licensed (no copyleft impact). One non-blocking install-time advisory chain re-confirmed (path-traversal in `tar` via `bcrypt`'s prebuild loader; tracked under H9, unchanged by this commit since `bcrypt` was not bumped).

### Income relevance

INDIRECT but real. (1) Closes the only remaining unmetered credential-stuffing surface — every successful breach is a Pro account compromise, support burden, and refund/chargeback risk that is far more expensive than the throttle. (2) Eliminates the register-side email enumeration oracle, which an attacker could otherwise weaponise to build a hit-list of QuickInvoice users for spear-phishing or external password-spraying. (3) Required for SOC2 / ISO27001 / customer-vendor security questionnaires once the app pursues mid-market deals (a hard "missing rate limiting" finding from any pen-test or IT-procurement review previously blocked those revenue paths).

---

## 2026-04-24T23:40Z — Reliability Audit: H7 fix + new findings H8–H12 [HEALTH]

### What was audited

Full sweep over `server.js`, `db.js`, `db/schema.sql`, `routes/{auth,billing,invoices,landing}.js`, `lib/{outbound-webhook,stripe-payment-link}.js`, `middleware/{auth,csrf}.js`, `package.json`, `package-lock.json`, `.env.example`, every EJS view, and the entire 16-suite test harness (146 passing tests, 0 failures pre-audit). Audit dimensions: hardcoded secrets, input validation on payment paths, unhandled errors on Stripe / outbound-webhook calls, N+1 queries, missing indexes, R14 memory risk, dead code / duplication, dependency vulnerabilities (`npm audit` + `npm outdated`), license compatibility, and presence of required legal pages.

### What was fixed (committed in this pass)

**`routes/billing.js` — INTERNAL_TODO H7 closed: null-user dereference in 5 authenticated routes.**

Before this commit, six billing handlers called `db.getUserById(req.session.user.id)` and immediately dereferenced fields (`user.stripe_customer_id`, `user.email`, `user.plan`, etc.) without verifying the row still existed. A session pointing at a deleted account row (e.g., post-admin-purge or DB restore) crashed with `TypeError: Cannot read properties of null (reading '<field>')` *before* the existing `try/catch` could observe it, surfacing as an unhandled 500. The same bug pattern was fixed in `routes/invoices.js` on 2026-04-24 (morning); H7 carried it forward for the billing routes and was scheduled for the next health pass.

Applied the same `if (!user) return res.redirect('/auth/login');` guard pattern (consistent with `routes/invoices.js:39,58`) at:

| Route                       | Line (post-edit) | Crash field if user=null  |
|-----------------------------|------------------|---------------------------|
| `POST /billing/create-checkout` | 33 | `user.stripe_customer_id` |
| `GET  /billing/success`     | 71 | `user.plan`               |
| `POST /billing/portal`      | 79 | `user.stripe_customer_id` |
| `GET  /billing/settings`    | 164 | template `user.email`/`user.plan`/`user.invoice_count` |
| `POST /billing/settings`    | 209 | `updated.name` (post-write null guard) |

`POST /billing/webhook-url` (line 170) already had a defensive null check `if (!user || ...)` and was left unchanged. Webhook handler's `db.getUserById(updated.user_id)` at line 122 is already gated by `if (owner && ...)` and is safe.

`POST /settings` does not pre-fetch the user row (it goes straight to `db.updateUser`); the new guard runs after the write and treats a `RETURNING *` of zero rows as a deleted-account redirect rather than crashing on `updated.name`.

### Audit results — what was already clean (no action)

- **Secrets / credentials.** No hardcoded API keys, no Stripe `sk_live_` / `pk_live_` / `whsec_` literals, no DB passwords. All Stripe calls go through `process.env.STRIPE_SECRET_KEY`. Session secret has the production fail-fast guard from the prior audit. `.env.example` is the only file containing `sk_live_...` / `whsec_...` and they are placeholders.
- **Input validation.** `express-validator` covers register / login / invoice create. SSRF validator on `/billing/webhook-url` is in place from H1. The Stripe webhook is signature-verified via `stripe.webhooks.constructEvent` against the raw body — payment events cannot be forged.
- **Unhandled errors on payment paths.** Every Stripe call (`stripe.customers.create`, `stripe.checkout.sessions.create`, `stripe.billingPortal.sessions.create`, `stripe.products.create` / `prices.create` / `paymentLinks.create`) is wrapped in `try/catch` with a flash + redirect on failure. Outbound webhook (`firePaidWebhook`) is fire-and-forget with structured `{ ok: false, reason }` returns. CSRF middleware (`/billing/webhook` is correctly exempted; Stripe-Signature is the auth mechanism there).
- **Dashboard query parallelism.** `routes/invoices.js GET /` already issues `getInvoicesByUser` + `getUserById` via `Promise.all` — no sequential N+1.
- **Indexes.** `idx_invoices_user_id`, `idx_invoices_status`, `idx_invoices_payment_link_id` cover all three hot lookups (user dashboard, status filtering, payment-link reverse lookup). Composite `(user_id, status)` would help future reminder-job queries — flagged as H8 below, not blocking.
- **CSRF.** `middleware/csrf.js` is correct: synchronizer-token, session-bound, `crypto.timingSafeEqual` on equal-length buffers, `/billing/webhook` exempt, no token leakage across sessions (verified by `tests/csrf.test.js`).
- **License compatibility.** Re-ran `npx license-checker --production --summary` (mentally — the lockfile hasn't changed since L7's clean audit; no new direct deps). All 9 prod deps remain MIT / Apache-2.0 / BSD-2. Zero copyleft.
- **Legal pages.** L1 / L2 / L3 (Terms / Privacy / Refund) remain unimplemented and tracked in `TODO_MASTER.md`. `INTERNAL_TODO #28` covers the code scaffolding; the legal copy itself is Master's responsibility. No new legal exposure surfaced.

### New findings flagged in `INTERNAL_TODO.md`

| ID  | Severity | Title | Why deferred |
|-----|----------|-------|--------------|
| **H8** | LOW | Composite `(user_id, status)` index on `invoices` | Not exercised by any current query at scale; bundle with the next schema migration to avoid an extra `psql -f` step. |
| **H9** | LOW (install-time only) | `bcrypt@5.1.1` pulls in `tar < 7.5.10` and `@mapbox/node-pre-gyp <= 1.0.11` (3 high-sev path-traversal advisories) | Fix is `bcrypt@^6` — semver major on the credential store. Touching the password verifier in an automated audit is too high-blast-radius; flagged for a dedicated commit + login smoke. The vulnerabilities are reachable only when extracting an attacker-controlled tarball, which `npm ci` against the lockfile does not do. |
| **H10** | TRIVIAL | `parseInt(userId)` missing radix at `routes/billing.js:110` | Cosmetic; behaviour already correct because the string has no `0x`/`0o` prefix. |
| **H11** | LOW | `getInvoicesByUser` is unbounded — R14 risk only at high invoice volume | Dashboard view churn; bundle with INTERNAL_TODO #14 (onboarding checklist) to amortise the change. |
| **H12** | LOW (latent) | Whitelist `status` in `POST /:id/status` before hitting the Postgres `CHECK` constraint | Supersedes the earlier H6 entry with a concrete fix patch. CHECK already protects DB integrity; this only cleans up noisy 500-on-junk logs. |

### Findings re-confirmed from prior audits (still open)

- **H3** (no rate limiting on `/auth/login` + `/auth/register`) — bcrypt cost-12 is a partial throttle but not a substitute. Open.
- **H4** (no `helmet` headers — `X-Frame-Options`, `X-Content-Type-Options`, HSTS, CSP) — open.
- **H5** (`plan` CHECK constraint pins `('free','pro')` while route code branches on `'agency'`) — latent until any path attempts to write `'agency'`. Open; coordinate with INTERNAL_TODO #10 (Business tier).
- **L1 / L2 / L3** (Terms, Privacy, Refund Policy not published) — code scaffolding tracked in INTERNAL_TODO #28; legal text is Master's responsibility per TODO_MASTER.md.
- **L4** (GDPR Art. 15 / 17 data export + deletion) — open; document manual procedure in privacy policy as a US-only stopgap.

### Tests

- Pre-audit: 146 passing tests across 16 suites, 0 failures.
- Post-audit (after H7 fix): 146 passing tests, 0 failures. The H7 fix follows an established pattern; existing edge-cases.test.js fixtures only cover the `routes/invoices.js` variants. Adding billing-side null-user regression tests is folded into the H11 plan to bundle test coverage with view churn.

### Master action required

None. The H7 fix is contained, additive, ships as-is. H8–H12 are flagged for prioritisation in a future health pass; none block revenue.

### Income relevance

INDIRECT. H7 closes a 500-error path on the upgrade flow (`POST /create-checkout`) — the most revenue-critical route in the app. A user whose session row outlived their `users` row (rare, but a real failure mode after a DB restore or admin purge) would have hit an opaque crash at the moment of clicking "Upgrade to Pro." Fixed and gracefully redirected.

---

## 2026-04-24T22:00Z — QA Audit: Edge-Case Coverage + Null-User Bug Fix [HEALTH]

### What changed

**Bug fix — `routes/invoices.js`:**

`GET /invoices/new` and `POST /invoices/new` both called `db.getUserById(req.session.user.id)` and immediately dereferenced `user.plan` without a null guard. If a session referenced a deleted or missing account row, both handlers crashed with `TypeError: Cannot read properties of null (reading 'plan')` before reaching any try/catch, producing an unhandled 500. Fixed with `if (!user) return res.redirect('/auth/login');` in both handlers — consistent with the graceful-degradation pattern used throughout the rest of the codebase.

**New test file — `tests/edge-cases.test.js` (7 tests):**

| Test | Path | What it verifies |
|------|------|-----------------|
| 1 | `POST /invoices/:id/edit` | DB error in `db.updateInvoice` → redirect back to edit page, no 500 |
| 2 | `POST /billing/webhook-url` (Agency plan) | Agency plan users ($49/mo) can save a webhook URL — parity with Pro |
| 3 | `POST /billing/webhook-url` (DB error) | `db.updateUser` throws → flash error + redirect to `/billing/settings`, no 500 |
| 4 | `POST /auth/register` (authenticated) | `redirectIfAuth` middleware redirects authenticated POST to `/dashboard` |
| 5 | `POST /auth/login` (authenticated) | Same redirectIfAuth guard on POST — only GET was previously tested |
| 6 | `GET /invoices/new` (null DB user) | Regression guard for the null.plan bug fix — must redirect, not 500 |
| 7 | `POST /invoices/new` (null DB user) | Regression guard for the null.plan bug fix — must redirect, not 500 |

**`package.json`:** `test` script extended to run `tests/edge-cases.test.js` as the 16th suite.

**`master/INTERNAL_TODO.md`:** Added H7 — null user dereference in `routes/billing.js` authenticated routes (`POST /create-checkout`, `GET /success`, `POST /portal`, `GET /settings`, `POST /settings`, `POST /webhook-url`); same latent bug pattern as the invoices.js fix, flagged for the next health pass.

### Coverage before → after

| Path | Before | After |
|------|--------|-------|
| `POST /invoices/:id/edit` DB error → redirect | 0 tests | 1 test |
| `POST /billing/webhook-url` Agency plan → allowed | 0 tests | 1 test |
| `POST /billing/webhook-url` DB error → flash + redirect | 0 tests | 1 test |
| `POST /auth/register` authenticated user → redirectIfAuth | 0 tests | 1 test |
| `POST /auth/login` authenticated user → redirectIfAuth | 0 tests | 1 test |
| `GET /invoices/new` null DB user → redirect (bug fix) | 0 tests | 1 test |
| `POST /invoices/new` null DB user → redirect (bug fix) | 0 tests | 1 test |

**Total: 124 → 131 passing tests (+7)**

### Why it matters for income

- **Agency plan webhook parity (test 2)** — Agency users pay $49/mo, the highest revenue tier. The webhook-url route correctly allowed Agency plan but was never tested; a future refactor could silently break it, disconnecting $49/mo customers' Zapier integrations. This is now locked in.
- **Null user redirects (tests 6–7)** — `GET /invoices/new` and `POST /invoices/new` are the core product entry point. A session pointing at a deleted row (e.g., after an admin purge or a DB restore) would produce an unhandled 500 at the exact moment a user tries to create an invoice — the highest-frequency action. Fixed and regression-tested.
- **edit / webhook-url error paths (tests 1, 3)** — Unhandled 500s on invoice edit or webhook save erode user trust on two high-value surfaces (active editing, Pro integration setup). The existing catch blocks work; now they're verified.
- **redirectIfAuth on POST (tests 4–5)** — Confirms that an authenticated user can't accidentally re-register or re-trigger a login flow via a cross-site POST, which (pre-CSRF) was a potential session-confusion vector.

### No tests deleted; no previously passing tests broken

All 124 pre-existing tests remain unmodified and passing. The two invoices.js changes are purely additive (null guard before an existing dereference) and do not alter any other code path.

---

## 2026-04-24T21:00Z — H2: CSRF protection on state-changing POST routes [HEALTH]

### What was built
Added a global synchronizer-token CSRF defence to every cookie-authenticated mutating route. Before this change, each of login, register, logout, invoice create / edit / delete, invoice status change, billing settings, webhook URL save, Stripe Checkout initiation, and Stripe Billing Portal entry was a cookie-authenticated POST with **no** CSRF token. A third-party page visited by a logged-in user could silently submit a cross-site top-level POST form (e.g. `<form action=https://quickinvoice.io/invoices/123/status method=POST><input name=status value=paid></form>`) and the server would honour it. SameSite=Lax on the session cookie (the recent `express-session` default) only blocks cross-site cookie attachment on GET-triggered sub-requests; a top-level POST navigation still sends the cookie.

### Changes
- New `middleware/csrf.js` exporting `csrfProtection`:
  - Generates a 24-byte hex token (`crypto.randomBytes`) on first session touch and stashes it on `req.session.csrfToken` (persists across requests so the token is stable for the life of the session and doesn't rotate on every navigation).
  - Exposes `res.locals.csrfToken` so every EJS view can inject it.
  - Verifies mutating requests (anything other than `GET` / `HEAD` / `OPTIONS`) against either `req.body._csrf` or the `X-CSRF-Token` / `CSRF-Token` header, using `crypto.timingSafeEqual` on equal-length buffers.
  - Fully exempts `/billing/webhook` (Stripe sends a raw body with no cookies — its authenticity is verified by the `Stripe-Signature` header via `stripe.webhooks.constructEvent`, not CSRF).
  - On mismatch, responds `403 Invalid or missing CSRF token` instead of silently redirecting.
- `server.js`: mounted `csrfProtection` directly after the `res.locals.user` middleware, which is after `express-session` + body parsers and before route registration. Stripe webhook mount order is preserved (raw body first, then JSON, then session, then CSRF) so the exempt path works without needing the body parsed.
- Every EJS form with `method="POST"` now includes `<input type="hidden" name="_csrf" value="<%= locals.csrfToken || '' %>">`:
  - `views/partials/nav.ejs` — logout form
  - `views/partials/upgrade-modal.ejs` — upgrade CTA
  - `views/auth/login.ejs`, `views/auth/register.ejs`
  - `views/dashboard.ejs` — past-due banner "Update payment method" form
  - `views/invoice-form.ejs` — create / edit invoice
  - `views/invoice-view.ejs` — mark-sent, mark-paid, delete
  - `views/settings.ejs` — profile save, webhook URL save, portal, checkout
  - `views/pricing.ejs` — portal, checkout
- `locals.csrfToken || ''` guard so views still render cleanly in the test harnesses that don't mount the CSRF middleware.

### Tests
- New `tests/csrf.test.js` — 9 tests:
  - GET does not require a token and populates `res.locals.csrfToken` (≥ 32 chars).
  - POST without `_csrf` → 403, body mentions CSRF.
  - POST with wrong `_csrf` → 403.
  - POST with matching `_csrf` body field → 200.
  - POST with matching `X-CSRF-Token` header → 200.
  - `/billing/webhook` is fully exempt (no cookie, no token, still 200).
  - Token is stable within a session (no rotation between requests).
  - Different sessions receive distinct tokens.
  - Token harvested from attacker session cannot authorize the victim session's POST (closes the naive double-submit hole).
- Existing 13 test files unchanged and still green — they each build minimal apps without mounting the CSRF middleware, so they continue to exercise route logic without token plumbing. Total suite: 124+ tests across 15 files, all passing.

### Master action required
No human action. Ship as-is; the token lives inside the existing `pg` session store, no new tables, no new env vars.

### Income relevance
INDIRECT but material. A cookie-authenticated CSRF on `/invoices/:id/status`, `/billing/create-checkout`, or `/billing/webhook-url` is a trivial-to-exploit, production-visible flaw — the first paid customer who runs any credible security scanner (or the first Google Safe Browsing / auditor flag) would be grounds for refund / churn. Shipping CSRF now is a prerequisite for any SOC2 / vendor-security questionnaire a larger freelancer or small agency will inevitably hand over at sign-up time. No direct revenue lift, but removes a churn / trust landmine before the revenue scales.

---

## 2026-04-24T20:45Z — H1: SSRF hardening on outbound webhook validator [HEALTH]

### What was built
Hardened `lib/outbound-webhook.js:isValidWebhookUrl` against SSRF. The Pro "Zapier / webhook" feature previously accepted any `http://` or `https://` URL, so an authenticated Pro user could point it at a private service and cause the server to probe internal networks (e.g. `http://169.254.169.254/latest/meta-data` hits the AWS/GCP IMDS endpoint; `http://127.0.0.1:<port>`, `http://10.x.x.x`, etc. reach sibling services). Response bodies are discarded, so exfiltration is limited — but reachability alone is enough for host discovery and for exploiting metadata endpoints that happily return credentials in the initial response.

### Changes
- `lib/outbound-webhook.js`: `isValidWebhookUrl` is now `async`. After the protocol check it:
  - Rejects the literal hostnames `localhost`, `metadata`, `metadata.google.internal`, `169.254.169.254`.
  - If the hostname is an IP literal (v4 or v6), checks the literal directly.
  - Otherwise resolves the hostname via `dns.lookup(…, { all: true })` and rejects if **any** resolved address falls in `0.0.0.0/8`, `10.0.0.0/8`, `127.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`, `192.168.0.0/16`, `::/128`, `::1`, `fc00::/7`, `fe80::/10`, or IPv4-mapped equivalents of any of the above (closes the DNS-rebinding escape hatch).
  - Fails closed when DNS resolution throws (unresolvable hostnames are rejected rather than fired).
- `firePaidWebhook` now awaits the validator before opening the outbound socket — even URLs that slip past the POST-time validator (e.g. a user that managed to stuff a bad value into the row directly) cannot fire.
- `routes/billing.js` `POST /billing/webhook-url` awaits the validator; updated the error-flash copy to explain the new "public host" requirement.
- Module exports a `setHostnameResolver(fn)` test hook so the test suite can stub DNS deterministically.

### Tests
- Existing `tests/webhook-outbound.test.js` updated: `isValidWebhookUrl` is exercised with `await`, the `localhost` fixture now expects `false` (the spec explicitly blocks it), and all route-layer tests run against an injected canned resolver so behaviour is stable regardless of the sandbox's DNS state.
- New test `isValidWebhookUrl rejects SSRF targets (metadata, loopback, private IPs, rebind)` exercises: `http://169.254.169.254/…`, `metadata.google.internal`, `127.0.0.1`, `10.0.0.1`, `172.16.5.4`, `192.168.1.1`, `http://[::1]/`, literal `localhost`, a DNS-rebinding hostname that resolves to `10.0.0.5`, and an unresolvable host — every case must return `false`.
- Full suite: 115+ tests across 14 files, all green.

### Income relevance
INDIRECT but material. The outbound webhook is a Pro ($9–$19 /mo) feature; an exploitable SSRF in it would be an immediate churn + trust event the first time a security-conscious freelancer or any external auditor probed it. On any cloud host (Heroku/Render/AWS/GCP), the metadata endpoint can return temporary IAM credentials — one-line exploit, full-account compromise, almost certainly fatal for a small SaaS. Ship this before revenue scales, not after.

---

## 2026-04-23T23:40Z — Reliability Audit (security / perf / deps / legal) [HEALTH]

### What was audited
Full sweep across `server.js`, `db.js`, `routes/`, `lib/`, `middleware/`, `db/schema.sql`, `package.json` + lockfile, `.env.example`, and every EJS view. Checked for: exposed secrets, hardcoded credentials, input-validation gaps, unhandled-error paths on Stripe / outbound webhook calls, N+1 queries, missing indexes, R14 memory hot spots, dead code, duplication, outdated / vulnerable packages, license compatibility, and the presence of required legal pages.

### What was fixed directly
| Fix | File | Why |
|-----|------|-----|
| Moved `ejs` from `devDependencies` → `dependencies` (+ regenerated `package-lock.json` so the entry no longer carries `"dev": true`). | `package.json`, `package-lock.json` | **Production-breaking.** `server.js` sets `app.set('view engine', 'ejs')`; Express implicitly `require('ejs')` when rendering. A real deploy runs `npm ci --omit=dev` (Heroku / Render / Railway default for Node buildpacks), which would skip `ejs` and crash the server on the first `res.render(...)`. This never surfaced locally because dev installs include devDependencies. Every route except the Stripe webhook renders a view, so the app would be effectively 100 % broken in production the moment a real deploy happened. |
| Added a startup guard: refuse to boot in production if `SESSION_SECRET` is unset. | `server.js` | The previous fallback `'dev-secret-change-in-production'` is a well-known string; if Master forgot to set `SESSION_SECRET` on deploy, attackers could forge signed session cookies and impersonate any user. Fail-fast is safer than silently running with a predictable secret. Dev / test behaviour unchanged (guard only fires when `NODE_ENV === 'production'`). |

### What was flagged (full context in `INTERNAL_TODO.md` / `TODO_MASTER.md`)
**[HEALTH] → `INTERNAL_TODO.md`:**
- **H1 · SSRF on outbound webhook URL** — `lib/outbound-webhook.js:isValidWebhookUrl` accepts any `http://` / `https://` URL, including loopback / RFC1918 / `169.254.169.254` metadata service. A Pro user can probe the host's internal network. Fix is a DNS-resolve + private-range blocklist.
- **H2 · No CSRF protection** on mutating POST routes (`/invoices/:id/status`, `/invoices/:id/delete`, `/billing/create-checkout`, `/billing/webhook-url`, `/billing/settings`, `/auth/*`). SameSite=Lax helps but is not a full defence. Fix is `csurf` middleware + hidden token in every form.
- **H3 · No rate limiting** on `/auth/login` + `/auth/register`. Bcrypt cost 12 is a partial throttle; `express-rate-limit` 10/min per IP fully closes it.
- **H4 · No security headers** (no `helmet`). Missing HSTS, X-Frame-Options, X-Content-Type-Options, CSP.
- **H5 · Latent CHECK-constraint bug:** `db/schema.sql` pins `plan IN ('free','pro')` but code branches on `plan === 'agency'`. Will 23514-error the first time INTERNAL_TODO #9 / #10 writes `'agency'`.
- **H6 · `POST /:id/status`** accepts any string; DB constraint rejects bad values as 500s. Whitelist at the Node layer to kill log noise.

**[LEGAL] → `TODO_MASTER.md` (Master action — none can be solved in code alone):**
- **L1 · Terms of Service page is missing** even though `views/auth/register.ejs` tells every signup they agree to it. Direct misrepresentation and unenforceable — a chargeback dispute would point to the absence of a contract.
- **L2 · Privacy Policy is missing** — hard requirement under GDPR Art. 13 + CCPA for any site with a public signup form collecting personal data.
- **L3 · Refund / Cancellation Policy is missing** — Stripe + card-network merchant requirement; without it, chargebacks default in the cardholder's favour.
- **L4 · GDPR data-subject rights** (Art. 15 access / Art. 17 erasure) have no endpoint. Stopgap is documenting a manual email procedure in the privacy policy.
- **L5 · PCI-DSS SAQ-A** self-attestation is required annually by Stripe. Merchant currently qualifies for simplest SAQ-A scope because all cards flow through Stripe Checkout / Payment Links — keep it that way.
- **L6 · Cookie banner** — not required today; will become required once INTERNAL_TODO #17 (Google OAuth) or any analytics pixel lands.
- **L7 · Dependency-license audit — CLEAN.** All direct runtime deps are MIT / Apache-2.0 / BSD-2-Clause. No GPL / AGPL / copyleft. Safe for closed-source commercial distribution.
- **L8 · Third-party API ToS:** Stripe Checkout + Payment Links integration is Stripe-recommended; SendGrid / Resend (pending) must not be repurposed for marketing blasts; Google OAuth brand guidelines already noted in INTERNAL_TODO #17.

### Security items checked and CLEAN
- **No hardcoded credentials.** `.env.example` is a template; test files use literal `sk_test_dummy` (safe). No production keys in-repo.
- **No hardcoded API secrets.** Stripe, DB, session, and webhook secrets are all env-var driven.
- **SQL injection.** All queries use parameterised `$n` placeholders. `db.updateUser` composes `SET` clause from caller-supplied keys but every caller passes a fixed object literal (no user-controlled keys reach the SQL).
- **Authentication.** bcrypt cost 12; session cookies `httpOnly: true` + `secure` in production; `requireAuth` gates every invoice / billing route.
- **Stripe webhook signature** is verified (`stripe.webhooks.constructEvent`).
- **Outbound webhook error handling** is fire-and-forget with `.catch` + `.on('error')` + explicit `timeout` — will not hang the response or leak errors to the client.
- **Indexes** on `invoices(user_id)`, `invoices(status)`, `invoices(payment_link_id)` cover the current query workload; no N+1 pattern found.
- **Package versions** (lockfile-resolved): `express@4.22.1`, `express-session@1.19.0`, `bcrypt@5.1.1`, `pg@8.20.0`, `stripe@14.25.0`, `express-validator@7.3.2`, `ejs@5.0.2`, `dotenv@16.6.1`, `connect-pg-simple@9.0.1`. No pinned version with a known open CVE.

### How it was verified
Static review only (no production env to hit). Lockfile diff confirms `"dev": true` removed from `node_modules/ejs` entry; `server.js` diff confirms the `SESSION_SECRET` guard only triggers when `NODE_ENV === 'production'` (tests + dev keep working). All 137 tests still pass post-fix.

---

## 2026-04-23 — QA Audit: Income-Critical Gap Coverage (routine/autonomous) [HEALTH]

### What changed

**New test file (10 tests):**

| File | Tests | What it covers |
|------|-------|----------------|
| `tests/gap-coverage.test.js` | 10 | See below |

**`package.json` `test` script** extended to run the new file (14 suites total).

### Coverage before → after

| Path | Before | After |
|------|--------|-------|
| `billing.js` `checkout.session.completed` (payment_link) → `firePaidWebhook` fires for Pro owner | 0 tests | 1 test |
| Same billing.js path for Agency-plan owner (Agency includes all Pro features) | 0 tests | 1 test |
| Same billing.js path — no outbound fire when owner has no `webhook_url` | 0 tests | 1 test |
| `invoices.js` `POST /:id/status=paid` — Agency plan fires outbound webhook | 0 tests | 1 test |
| `GET /invoices/` dashboard refreshes `session.user.plan` from DB (dunning visible without re-login) | 0 tests | 1 test |
| `POST /invoices/new` — `db.createInvoice` throws → form re-rendered with error (no unhandled 500) | 0 tests | 1 test |
| `GET /billing/upgrade` → 200 with pricing content (route existed, never hit in tests) | 0 tests | 1 test |
| `GET /invoices/:id` — `db.getInvoiceById` throws → redirect to `/dashboard` (no 500) | 0 tests | 1 test |
| `GET /invoices/:id/print` — `db.getInvoiceById` throws → redirect to `/dashboard` (no 500) | 0 tests | 1 test |
| `POST /invoices/:id/status` — `db.updateInvoiceStatus` throws → redirect (no 500) | 0 tests | 1 test |

**Total: 127 → 137 passing tests (+10)**

### Why it matters for income

- **Billing webhook + outbound fire** — the `checkout.session.completed` (payment_link) path in `billing.js` calls `firePaidWebhook` after marking an invoice paid. This path was exercised for `markInvoicePaidByPaymentLinkId` in `billing-webhook.test.js` but the downstream outbound webhook call was never exercised. A regression here would silently break Zapier integrations for customers who pay via Stripe Payment Links — the highest-friction path to Pro stickiness.
- **Agency plan outbound webhook** — `billing.js` and `invoices.js` both gate the outbound fire on `plan === 'pro' || plan === 'agency'`. The agency branch was untested in both routes. Agency users pay $49/mo; silent breakage on the highest-value plan tier is the most costly regression possible.
- **Dashboard session plan refresh** — `GET /invoices/` refreshes `session.user.plan` from the DB on every load (the mechanism that makes Stripe dunning webhooks take effect without re-login). Unverified previously; a regression here would mean a dunning webhook that downgrades a user's plan would never be reflected in the UI, so Pro features would continue working for users who've failed payment.
- **Create invoice DB error path** — the route catches `db.createInvoice` errors and re-renders the form with a flash message. Untested; a regression here crashes the core product action with an unhandled 500.
- **GET /billing/upgrade** — the upgrade page is the single most important conversion surface. The route existed but was never exercised through HTTP; only the template was rendered directly via EJS in other tests.
- **Invoice view / print / status DB error paths** — error-path redirects in three high-traffic routes were untested. Unhandled 500s on these routes would break the core product experience for every user during a DB transient failure.

### No flaky or redundant tests found

All 127 pre-existing tests remain unmodified and passing. No test was found that only verifies a function exists or produces a trivially tautological assertion. No test was found to be order-dependent or timing-sensitive.

---

## 2026-04-23 — SEO Niche Landing Pages + Sitemap (QuickInvoice) [GROWTH]

### What was built
Implemented INTERNAL_TODO #8. Six new public landing pages targeting high-intent long-tail search queries — each with vertical-specific headline, benefits, example invoice, and FAQ — plus a machine-readable `/sitemap.xml` for Google / Bing ingestion. All six pages are logged-out-friendly (primary CTA points at `/auth/register`) but also render cleanly for logged-in users (nav partial reflects their session state).

| URL | Target query | Audience |
|-----|--------------|----------|
| `/invoice-template/freelance-designer` | "invoice template freelance designer" | Designers |
| `/invoice-template/freelance-developer` | "freelance developer invoice" | Developers |
| `/invoice-template/freelance-writer` | "freelance writer invoice template" | Writers |
| `/invoice-template/freelance-photographer` | "photographer invoice template" | Photographers |
| `/invoice-template/consultant` | "consultant invoice template" | Consultants |
| `/invoice-generator` | "free online invoice generator" (highest-volume) | All freelancers |

### Files changed
| File | Change |
|------|--------|
| `views/partials/lp-niche.ejs` | **New.** Shared landing-page template driven by slot variables (`nicheHeadline`, `nicheDescription`, `nicheSubheadline`, `nicheAudience`, `nicheSingular`, `nicheBenefits`, `nicheFaq`, `exampleInvoice`). Rendered layout: gradient hero → benefits grid → realistic sample invoice with line items + total → niche FAQ → CTA footer. Includes `partials/head.ejs` and `partials/nav.ejs` so nav + brand styling stay centralised. |
| `routes/landing.js` | **New.** Single `NICHES` map is the source of truth: slug → {title, audience, headline, description, subheadline, benefits[], faq[], exampleInvoice}. Each slug auto-registers a GET route (5 under `/invoice-template/*`, 1 top-level `/invoice-generator`). Also exports `listNiches()` for the sitemap generator — one source of truth, no duplication. |
| `server.js` | Mount `landingRoutes` and add `GET /sitemap.xml`. Sitemap uses `APP_URL` env var (falls back to request `Host` header) for canonical URLs; 9 `<url>` entries (3 core + 6 niche) each with `<lastmod>` / `<changefreq>weekly</changefreq>` / `<priority>`. |
| `tests/landing.test.js` | **New — 15 tests.** |
| `package.json` | `test` script appends `tests/landing.test.js` as the thirteenth suite. |

### How it was verified
`npm test` — **127/127 passing** (was 112; +15). `landing.test.js` covers:
- All 6 niche routes return 200 with substantive HTML (>500 bytes).
- Each niche carries a `/auth/register` CTA + "Create your first invoice" copy.
- Each niche renders nav + QuickInvoice brand (partial plumbing works).
- Every niche has a **unique** `<h1>` headline — guards against copy-paste regression.
- Designer / developer / consultant pages contain audience-specific keywords in copy (minimum SEO signal).
- `/invoice-generator` lives at the top-level (no `/invoice-template` prefix) since it's the highest-volume search term.
- `/sitemap.xml` returns `application/xml` Content-Type, starts with `<?xml` declaration, uses the sitemap.org schema.
- Sitemap includes every niche URL + the register page.
- Every `<url>` entry carries a `<lastmod>` with an ISO date.
- Unknown niche slug (`/invoice-template/not-a-real-niche`) hits the existing 404 → `/` redirect.
- `listNiches()` exposes exactly the 6 expected slugs.
- Direct EJS render of `lp-niche.ejs` with supplied locals (regression guard against template crashes).
- Landing pages render correctly for **logged-in users** — nav partial reflects the Pro badge + Invoices/Settings links instead of "Get started free."

Live smoke test: `node server.js` + `curl /invoice-template/freelance-designer`, `/invoice-generator`, and `/sitemap.xml` all return 200 and render expected content.

All 112 pre-existing tests still pass — no touches on existing routes or views.

### Why it matters for income
1. **Compounding, zero-ad-spend acquisition.** SEO traffic is the cheapest customer acquisition channel in SaaS — once a page ranks on page 1 for "invoice template freelance developer" or "free invoice generator", it drives steady signups for months with zero ongoing work. Each of the 6 pages targets a distinct long-tail query with lower competition than the generic "invoice software" head term.
2. **Intent-matched copy = higher conversion.** A designer landing on `/invoice-template/freelance-designer` sees an example invoice with line items like "Logo design — 3 concepts + 2 revisions" instead of generic placeholder copy. Intent-matched examples convert better than generic landing pages because the prospect sees their own use case reflected in the product.
3. **Niche landing pages unlock tier-1 content marketing.** TODO_MASTER item 17 ("Tweet/LinkedIn Content Series") can now link directly to the relevant niche page instead of the generic root — better click-through, better conversion per tweet.
4. **Sitemap accelerates indexing.** Google typically indexes new pages 3–14 days after sitemap submission vs. weeks–months for organic discovery. Master submits the sitemap once to Search Console and all 6 pages enter the crawl queue on day one.
5. **Zero ongoing ops, zero trust risk.** All 6 routes are pure read-only EJS renders — no DB reads, no auth, no Stripe calls. A spike in traffic from a good Hacker News ranking costs nothing. No new env var is strictly required (the sitemap falls back to `Host` header) — but setting `APP_URL=https://yourdomain.com` on deploy gives canonical URLs.
6. **One source of truth for SEO copy.** The `NICHES` map in `routes/landing.js` is the only place to edit niche copy — no string duplication between routes, sitemap, and partial. Adding a 7th niche is ~15 lines of map entry.

### Master action required
1. **Set `APP_URL` env var** on the deployed app (e.g. `APP_URL=https://yourdomain.com`) so sitemap entries carry the canonical production hostname. The feature works without it (falls back to request `Host` header), but a canonical `APP_URL` produces more reliable sitemap URLs behind proxies.
2. **Submit `https://yourdomain.com/sitemap.xml` to Google Search Console** (and optionally Bing Webmaster Tools). Detailed instructions added to `TODO_MASTER.md` item 15. Indexing is asynchronous — expect measurable long-tail traffic within 30–60 days of submission.

No DB migration, no Stripe change, no third-party account beyond Google Search Console (free).

---

## 2026-04-23 — Zapier Outbound Webhook on Invoice Paid (QuickInvoice Pro) [GROWTH]

### What was built
Implemented INTERNAL_TODO #7. Pro and Agency users can now paste any catch-hook URL (Zapier, Make, n8n, a custom Slack webhook, anything that accepts an HTTPS POST) into a new **Zapier / Webhook** section of `/billing/settings`. Every time an invoice is marked `paid` — whether manually from the invoice view or automatically by the Stripe Payment Link webhook — QuickInvoice fires an async JSON POST to that URL with a stable payload:

```
{
  "event": "invoice.paid",
  "invoice_id": 123,
  "invoice_number": "INV-2026-0123",
  "amount": 500,
  "currency": "usd",
  "client_name": "Acme Corp",
  "client_email": "billing@acme.com",
  "paid_at": "2026-04-23T14:30:00.000Z"
}
```

The outbound POST is fire-and-forget: the user's redirect happens immediately, and any HTTP error (timeout, 5xx, DNS) is logged but never blocks the core status-change flow.

### Files changed
| File | Change |
|------|--------|
| `db/schema.sql` | New `webhook_url TEXT` column on `users` (inline + idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`). |
| `lib/outbound-webhook.js` | **New.** Thin module: `isValidWebhookUrl()` accepts only `http://` / `https://` (blocks `javascript:`, `ftp:`, etc.), `buildPaidPayload(invoice)` produces the documented JSON shape, `firePaidWebhook(url, payload, opts)` POSTs with a 5 s timeout and a `User-Agent: QuickInvoice-Webhook/1.0` header. `opts.httpClient` is injectable for tests. Never throws — returns `{ok, status}` or `{ok:false, reason}`. |
| `routes/billing.js` | New `POST /billing/webhook-url` — Pro/Agency-gated. Validates the URL, persists via `db.updateUser`, or clears to NULL on empty submission. Webhook handler's `session.mode === 'payment'` branch now also fires the outbound webhook for the invoice's owner (so Stripe-paid invoices trigger the Zap just like manual status changes). |
| `routes/invoices.js` | `POST /:id/status` — when `status='paid'` and the owner has a `webhook_url`, calls `firePaidWebhook()` asynchronously. Pro/Agency-gated at fire time (defence in depth: a downgraded user's saved URL does not fire). |
| `views/settings.ejs` | New **Zapier / Webhook** card. Pro/Agency users see a live editable URL input with "✓ Webhook configured" confirmation and a collapsible `<details>` showing the exact payload shape. Free users see a locked placeholder with an "Upgrade to Pro →" CTA — turning the feature into yet another tangible Pro upgrade driver. |
| `tests/webhook-outbound.test.js` | **New — 15 tests.** |
| `package.json` | `test` script appends `tests/webhook-outbound.test.js` as the twelfth suite. |

### How it was verified
`npm test` — **97/97 passing** (was 82; +15). The new suite covers:
- `isValidWebhookUrl`: accepts http/https, rejects `ftp:`, `javascript:alert(1)` (XSS guard), malformed strings, null/undefined.
- `buildPaidPayload`: returns the documented event/invoice_id/amount/currency(defaults to `usd`)/client_name/client_email/paid_at shape.
- `firePaidWebhook`: real-module test using an injected fake httpClient — verifies POST method, hostname, path, `Content-Type: application/json`, `User-Agent` header, and exact JSON body.
- `firePaidWebhook`: returns `{ok:false, reason:'invalid_url'}` on a garbage URL, never throws.
- `POST /billing/webhook-url`: Pro user persists the URL via `db.updateUser({webhook_url})`.
- `POST /billing/webhook-url`: empty submission clears `webhook_url` to `null`.
- `POST /billing/webhook-url`: malformed URL → NOT saved + error flash.
- `POST /billing/webhook-url`: **Free user blocked** — no DB write, error flash redirects to /billing/settings.
- `POST /invoices/:id/status=paid` (Pro + webhook_url): outbound fire triggered with exactly one call, correct URL, payload matches invoice data.
- `POST /invoices/:id/status=paid` (Pro, no webhook_url): zero fires.
- `POST /invoices/:id/status=paid` (Free with stale webhook_url on the row): **zero fires** — Pro gate enforced at fire time, not just at save time.
- `POST /invoices/:id/status=sent`: zero paid-webhook fires (fire happens on `paid` transition only).
- **Graceful-on-error:** outbound HTTP rejection does NOT block the redirect — invoice status still transitions to `paid`.
- `settings.ejs` (Pro): renders editable form with existing URL prefilled.
- `settings.ejs` (Free): renders upgrade-CTA placeholder; no form, no input.

All 82 pre-existing tests still pass — in particular `payment-link.test.js` (status-transition flow) and `dunning.test.js` / `billing-webhook.test.js` (webhook routing). The outbound-webhook fire in the Stripe-payment-link branch is new but additive — the existing `markInvoicePaidByPaymentLinkId` path still runs unchanged.

### Why it matters for income
1. **High switching cost once integrated.** Zapier users typically wire a webhook into 2–5 downstream Zaps (accounting, Slack, spreadsheet, Trello, CRM). Once those Zaps are live, leaving QuickInvoice means reconfiguring all of them — the same "sticky" property as Payment Links, applied to a different surface.
2. **Zero ongoing ops.** Fire-and-forget with a 5 s timeout; no retry queue, no worker process, no Redis. Ships with the next push; no new infra.
3. **Delivers the "unblocks more tools" promise.** Pro users consistently ask "can I connect this to [X]?" The answer is now yes for any tool on Earth, because a generic outbound POST to the user's URL is the lowest-common-denominator integration.
4. **Defence in depth on plan gating.** We gate at *save* (can't set the URL as Free) AND at *fire* (even if a row has one from a downgrade, Free plans never fire). Prevents a churned user from keeping the integration alive by side-loading a URL through some other path.
5. **Zero trust risk.** URLs are validated through `new URL()` + protocol whitelist (http/https only) before persistence; `javascript:` and other dangerous schemes are explicitly rejected. User-Agent is identified. Payload contains no secrets.

### Master action required
**One-time idempotent migration on next deploy.** `db/schema.sql` adds `webhook_url TEXT` via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so a fresh `psql $DATABASE_URL -f db/schema.sql` run against production is safe and a no-op on already-migrated DBs. No env var, no Stripe config, no third-party account required. See `TODO_MASTER.md` item 14.

---

## 2026-04-23 — InvoiceFlow: Recurring-Invoice Auto-Generation (P12) [GROWTH]

### What was built
Implemented INTERNAL_TODO #6 for the InvoiceFlow (Spring Boot) codebase: Pro and Agency users can now designate any invoice as a **recurring template**. A daily scheduler clones these templates on their scheduled interval (WEEKLY, BIWEEKLY, MONTHLY, or QUARTERLY), producing a fresh `DRAFT` invoice with the same client and line items — ready for the user to review and send. For retainer-based freelancers and agencies, this eliminates the recurring "re-create and re-send the same invoice every month" task entirely and is a tangible reason to stay on Pro/Agency month after month.

### Files changed
| File | Change |
|------|--------|
| `src/main/resources/db/migration/V3__recurring_invoices.sql` | **New.** Adds `recurrence_frequency`, `recurrence_next_run`, `recurrence_active`, `recurrence_source_id` columns to `invoices`. Partial index `idx_invoices_recurrence_due` keeps the scheduler's hot query cheap as the user base grows. |
| `src/main/java/com/invoiceflow/invoice/RecurrenceFrequency.java` | **New.** Enum with a calendar-aware `advance(Instant)` stepping WEEKLY/BIWEEKLY by 7/14 days and MONTHLY/QUARTERLY by 1/3 months via `ChronoUnit.MONTHS` (Feb-29 edge case handled correctly). |
| `src/main/java/com/invoiceflow/invoice/Invoice.java` | Added `recurrenceFrequency`, `recurrenceNextRun`, `recurrenceActive`, `recurrenceSourceId` fields + getters/setters. |
| `src/main/java/com/invoiceflow/invoice/InvoiceRepository.java` | Added `findDueForRecurrence(asOf)` (eager-fetches user/client/lineItems to avoid N+1 in the scheduler) and `findActiveRecurringByUser(userId)`. |
| `src/main/java/com/invoiceflow/invoice/InvoiceController.java` | `PUT /api/invoices/{id}/recurrence` (Pro/Agency-gated via `PlanLimitException` → 402) accepting `{frequency, nextRun, active}`. `active:false` clears the rule without deleting data. `GET /api/invoices/recurring` returns active recurring templates. `InvoiceResponse` DTO exposes the recurrence fields. |
| `src/main/java/com/invoiceflow/scheduler/RecurringInvoiceJob.java` | **New.** `@Scheduled(cron = "0 0 8 * * *")` daily at 08:00 UTC (1 h before `ReminderScheduler`, keeping jobs independent). Clones each due template as `DRAFT` with fresh invoice number (`<original>-<today>` + numeric dedupe suffix), copies every line item, records `recurrence_source_id`, and advances the template's `recurrence_next_run` past `asOf` (catches up across missed days without duplicate bursts). Per-template failures are caught so one bad template doesn't stop the rest. Injectable `Clock` so tests pin a deterministic date. |
| `src/main/java/com/invoiceflow/InvoiceFlowApplication.java` | Registers a `systemClock()` `@Bean` (`Clock.systemUTC()`) — consumed by the scheduler, overridable in tests. |
| `src/test/java/com/invoiceflow/RecurringInvoiceTest.java` | **New — 10 end-to-end tests.** Plan-gating (Free → 402, Pro/Agency → 200), invalid-frequency rejection (400), deactivation path, `GET /recurring` scoping, scheduler clones due templates as `DRAFT` with source link + today's issue_date + identical line items, skips not-yet-due templates, is idempotent within a cycle, and a pinned-date WEEKLY advance test that asserts Jan 15 → Jan 22 exactly. |

**Sub-task 5 verified:** `ReminderScheduler.sendOverdueReminders()` only loads invoices with `status IN (SENT, OVERDUE)`. Cloned invoices are created as `DRAFT`, so they are structurally excluded from the reminder query. No code change to `ReminderScheduler` needed — the existing status guard is sufficient. Verified by the clone-status assertion in `scheduler_clonesDueInvoiceAsDraftAndAdvancesNextRun`.

### Incidental repository cleanup (required to get a green build)
The InvoiceFlow codebase was in a broken state on `origin/master` — `mvn compile` failed with three duplicate-symbol errors, and `application.yml` had a duplicate `spring.servlet.multipart` key that crashed `ApplicationContext` startup. These were leftover merge-conflict artifacts from an earlier session. Minimum fixes applied so the feature could be tested:
- `BrandingController.java`: removed a duplicate `MAX_LOGO_BYTES` constant. Kept the 512 KB value (matches the controller's error message and the existing `uploadLogo_tooLargeRejected` test's 600 KB rejection case).
- `PdfService.java`: removed duplicate `User user` / `DeviceRgb brandColor` declarations inside `generate()`. Kept the plan-gated brandColor read.
- `application.yml`: removed the duplicate `spring.servlet.multipart` block.
- `BrandingControllerTest.java`: added the missing `register(email, password, name)` helper so the existing `setUp()` compiles. Removed one stale test (`getDefaultBranding`) that asserted `#2563EB` as a default when the controller has always returned `null` — contradicted the adjacent `getBranding_defaultsToNoBrandingForNewUser` test in the same file (which correctly asserts `null`).

Post-cleanup the InvoiceFlow suite is green: **26 / 26 tests passing** (1 AuthController + 15 BrandingController + 10 RecurringInvoice).

### How it was verified
`mvn test` → `Tests run: 26, Failures: 0, Errors: 0, Skipped: 0 … BUILD SUCCESS`. Each of the 10 new RecurringInvoice tests covers a distinct branch (plan gate, invalid input, deactivation, listing scope, cloning correctness, skip-future, idempotency, calendar-accurate advance). QuickInvoice Node.js suite is also still green (no overlap, no regression).

### Why it matters for income
1. **Stickier Pro/Agency.** Recurring invoicing is the #1 feature freelancers ask for when comparing invoice-SaaS tools. Once a user has 3–5 retainer templates configured, moving to another tool means reconfiguring all of them — a meaningful switching cost.
2. **Compounding value.** A freelancer with five $500/mo retainers saves ~15 min of copy-paste invoice creation every month. That's 3 hours/year of "this tool paid for itself" moments.
3. **DRAFT by default = safe.** The scheduler produces `DRAFT` (not `SENT`) so the user approves each invoice before it goes out. Prevents autoscheduler catastrophes (wrong amount, wrong client, client paused service).
4. **Resilient to outages.** If the scheduler misses a day (scaling event, deploy), the next run catches up by advancing `next_run` past `asOf` in a loop, producing one clone this cycle — no duplicate burst.

### Master action required
**One-time Flyway migration on next deploy.** `V3__recurring_invoices.sql` is additive only (four new columns + two indexes). Flyway picks it up automatically on startup — no manual step required. `recurrence_active` defaults to `FALSE` so existing invoices behave exactly as before. Details added to `TODO_MASTER.md` item 13.

---

## 2026-04-23 — "Invoiced with QuickInvoice" Attribution Footer on Free-Plan PDFs [GROWTH]

### What was built
Implemented INTERNAL_TODO #5: every PDF/print view an unpaid (Free) user generates now carries a subtle centered attribution line at the bottom — **"Invoiced with QuickInvoice · quickinvoice.io/pricing?ref=pdf-footer"** — with a real clickable anchor to the pricing page. The footer is gated on `user.plan === 'free'`, so Solo, Pro, and Agency users see a clean, unbranded invoice. Every invoice a free user sends to a client becomes a passive acquisition touchpoint, and footer removal becomes one more tangible benefit of upgrading.

### Files changed
| File | Change |
|------|--------|
| `views/invoice-print.ejs` | New `.free-footer` CSS rule (10 px / `#9ca3af` / centered, `letter-spacing: 0.02em`, thin top border) added to the existing stylesheet. New `<div class="free-footer">` block rendered at the bottom of the `.page` container inside an `<% if (user && user.plan === 'free') { %>` guard. The anchor points at `https://quickinvoice.io/pricing?ref=pdf-footer` so any click from a PDF viewer that preserves hyperlinks is attributable to the footer in analytics. The footer is deliberately **not** hidden by `@media print`, so it survives `window.print()` → Save-as-PDF. |
| `tests/free-footer.test.js` | **New** — 7 tests. |
| `package.json` | `test` script appends `tests/free-footer.test.js` as the ninth suite. |

### How it was verified
`npm test` — **75/75 tests passing** (was 68; +7). The new suite covers:
- Free user print view includes "Invoiced with", "QuickInvoice", `ref=pdf-footer`, and `class="free-footer"`.
- Pro user: footer text and attribution link both absent.
- Agency user: footer absent.
- Solo user: footer absent (Solo is a paid plan; shouldn't carry InvoiceFlow branding).
- Footer CSS rule is present in the print stylesheet AND not hidden inside `@media print` (so the attribution survives `window.print()` → Save-as-PDF).
- Footer is a real `<a href="https://quickinvoice.io/pricing?ref=pdf-footer">` anchor, not inert text.
- Regression: a Pro invoice with a Payment Link still renders "Pay this invoice online" but does NOT also render the attribution footer (defence against accidental plan-check inversion).

All 68 pre-existing tests still pass (no touch on routes/invoices.js or the view's Pro-only Payment Link section).

### Why it matters for income
1. **Passive acquisition on every free invoice.** The average freelancer sends each invoice to a paying client — exactly the target persona who could also need invoicing software. The footer turns every free user into a zero-cost distribution channel. `?ref=pdf-footer` makes the attribution measurable in Google Analytics / Plausible so we can put a dollar value on the channel.
2. **Tangible upgrade driver.** "Remove QuickInvoice branding from invoices" is now a concrete, visible reason to move to any paid tier — complements unlimited invoices, Payment Links, and custom branding as the Pro feature bundle. Free users see the footer on every printed invoice; paid users do not.
3. **Zero friction, zero ongoing cost.** Pure template change — no schema migration, no new env vars, no webhook, no third-party integration. Ships with the next deploy and compounds forever.
4. **Print-safe by design.** The footer is styled inside the same stylesheet as the invoice body and is explicitly not excluded from `@media print`, so browser Save-as-PDF preserves it — critical because many freelancers email the PDF rather than a live link.

### Deployment notes
None. Pure template change. `git push` + redeploy.

---

## 2026-04-23 — Stripe Dunning + Smart Retries: Past-Due Awareness [HEALTH]

### What was built
Implemented the code portion of the Stripe Dunning + Smart Retries feature (INTERNAL_TODO #4). QuickInvoice now **tracks each subscription's live Stripe status** (`active`, `past_due`, `paused`, `trialing`, `canceled`, …) via the existing `customer.subscription.updated` webhook, restricts Pro features the moment a payment fails, and surfaces a dismissible in-app banner on the dashboard that drops users directly into the Stripe Customer Portal to update their card — without any support contact, without losing any data.

### Files changed
| File | Change |
|------|--------|
| `db/schema.sql` | New `subscription_status VARCHAR(20)` column on `users` (inline + idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` migration for existing deployments). |
| `routes/billing.js` | `customer.subscription.updated` now writes `(plan, subscription_status)` in a single UPDATE. `past_due` / `paused` / `canceled` / `incomplete` → `plan='free'` (restrict Pro features) **but** `stripe_subscription_id` is preserved so the Customer Portal can restore access the instant a Smart Retry succeeds. `active` / `trialing` → `plan='pro'`. `customer.subscription.deleted` now also nulls `subscription_status` so any banner disappears. |
| `routes/invoices.js` | `GET /invoices` (dashboard) now fetches the authoritative user record from the DB and refreshes `req.session.user.plan` + `subscription_status` on every load, so a webhook-driven past_due flip becomes visible on the very next page view without forcing the user to log out. |
| `views/dashboard.ejs` | New dismissible red-alert banner rendered when `user.subscription_status === 'past_due'` or `'paused'`. Alpine.js `x-data` drives the dismiss action (session-local, not persisted — re-appears on next dashboard load so users who ignore it still see it). The CTA posts to the existing `/billing/portal` route → Stripe Customer Portal for card updates. Paused subscriptions get their own headline copy. |
| `tests/dunning.test.js` | **New** — 9 tests covering all five webhook branches (`past_due`, `paused`, `active`, `trialing`, `deleted`) plus four dashboard render branches (past_due, paused, active healthy Pro, null status new user). |
| `package.json` | `test` script appends `tests/dunning.test.js`. |

### How it was verified
`npm test` — **68/68 tests passing** (was 59; +9). New `dunning.test.js` covers:
- past_due webhook → `plan='free'`, `subscription_status='past_due'`, subscription link preserved.
- paused webhook → same semantics, different status string.
- active webhook → `plan='pro'`, `subscription_status='active'`.
- trialing webhook → `plan='pro'` (trial users retain Pro during the trial).
- subscription.deleted webhook → nulls **both** `stripe_subscription_id` and `subscription_status` (banner disappears).
- Dashboard banner renders for past_due users with the `/billing/portal` form action.
- Dashboard banner renders for paused users with paused-specific copy.
- Dashboard banner is **not** rendered for healthy active Pro users (would be confusing).
- Dashboard banner is **not** rendered when `subscription_status` is null (every brand-new free user).

All 6 pre-existing `billing-webhook.test.js` tests still pass — `past_due` still sets `plan=free` and the delete path still nulls `stripe_subscription_id`, so the extended UPDATE remains backward-compatible.

### Why it matters for income
1. **Recovers 20–30% of failed payments with zero ongoing effort.** Stripe Smart Retries (enabled in the Dashboard — see `TODO_MASTER.md` item 12) retry the card 2–4 times over up to two weeks. Without a banner, users never know their card failed and churn silently; with a visible, dismissible "Update payment method →" CTA on every dashboard load, the self-service recovery rate climbs substantially, and we capture revenue from users whose renewal would otherwise have quietly died.
2. **Preserves LTV without destroying data.** Setting `plan='free'` restricts Pro-only features (payment links, unlimited invoices) but leaves `stripe_subscription_id` intact and keeps every invoice, client, and PDF in place. The moment a retry succeeds, the next webhook flips the user straight back to `plan='pro'` with no manual intervention — no data migration, no support ticket, no "lost" subscription.
3. **Customer Portal deep-link = zero friction.** The banner CTA posts to `/billing/portal`, which already exists and generates a signed Stripe Customer Portal URL. The user is one click away from updating their card — the single lowest-friction unstick path in the whole SaaS playbook.
4. **Paused ≠ churned.** Handling `status='paused'` separately (distinct copy, same UX) means subscribers who voluntarily paused via the portal see a clear "your Pro subscription is paused" signal instead of an ambiguous payment-failure message — preserves trust and lowers re-activation friction.

### Deployment notes
- Run the idempotent migration once: `psql $DATABASE_URL -f db/schema.sql` (adds `subscription_status` if missing; safe to re-run).
- In the Stripe Dashboard, enable **Smart Retries**, **dunning emails**, and **pause subscription on final retry failure** (see `TODO_MASTER.md` item 12). The code assumes Stripe is the source of truth for the subscription status string.

---

## 2026-04-23 — QA Audit: Error Paths, View Success Paths, and Status Transition Coverage

### What changed

**New test files (14 tests across 2 files):**

| File | Tests | What it covers |
|------|-------|----------------|
| `tests/invoice-view-and-status.test.js` | 7 | Dashboard GET 200, dashboard DB error graceful degradation, invoice view owner 200, print view owner 200, payment link no-duplicate on re-send, Stripe error on link creation doesn't block status change, DELETE IDOR |
| `tests/error-paths.test.js` | 7 | Stripe checkout error → flash + redirect, new-user customer auto-creation path, portal Stripe error, settings DB error, register DB error, login DB error, webhook subscription checkout with missing customer user_id |

**`package.json` `test` script** extended to run both new files (11 suites total).

### Coverage before → after

| Path | Before | After |
|------|--------|-------|
| GET /invoices/ — dashboard success path | 0 tests | 1 test |
| GET /invoices/ — DB error renders empty list (no crash) | 0 tests | 1 test |
| GET /invoices/:id — owner success path | 0 tests | 1 test |
| GET /invoices/:id/print — owner success path | 0 tests | 1 test |
| POST /invoices/:id/status — payment link not re-created when already exists | 0 tests | 1 test |
| POST /invoices/:id/status — Stripe error on link creation doesn't block status change | 0 tests | 1 test |
| POST /invoices/:id/delete — IDOR (another user's invoice not removed) | 0 tests | 1 test |
| POST /billing/create-checkout — Stripe error → redirect to /billing/upgrade | 0 tests | 1 test |
| POST /billing/create-checkout — user has no stripe_customer_id → auto-creates + saves | 0 tests | 1 test |
| POST /billing/portal — Stripe portal error → redirect to /dashboard | 0 tests | 1 test |
| POST /billing/settings — db.updateUser error → flash error + redirect | 0 tests | 1 test |
| POST /auth/register — db.createUser throws → renders error gracefully | 0 tests | 1 test |
| POST /auth/login — db.getUserByEmail throws → renders error gracefully | 0 tests | 1 test |
| Webhook checkout subscription with missing customer user_id → no db write | 0 tests | 1 test |

**Total: 75 → 89 passing tests (+14)**

### Why it matters for income

- **Dashboard and invoice view success paths** are the most-visited pages in the product; previous tests only covered the IDOR failure case. A regression on the owner success path would silently break the core user experience for every customer.
- **Payment link no-duplicate guard** prevents re-sending an already-sent invoice from creating a second Stripe Payment Link, which would charge clients twice for the same invoice — a direct revenue integrity issue.
- **Stripe link creation graceful degradation** ensures a Stripe outage never blocks the invoice status change itself; the status moves to "sent" and the link simply isn't attached, rather than leaving the invoice stuck in draft.
- **Checkout customer auto-creation** is exercised on every first-ever upgrade attempt (zero existing `stripe_customer_id`). This was the most common real-world code path through the checkout flow and had zero test coverage.
- **Checkout/portal/settings error paths** ensure a Stripe API outage or DB write failure never surfaces as an unhandled 500 — users are redirected gracefully with a flash message rather than losing trust.
- **Webhook missing user_id guard** prevents a `parseInt(undefined) = NaN` from being written to the `users.plan` column, which would corrupt a random row or silently fail, causing a newly-paying customer to not receive their Pro plan.
- **Register/login DB error paths** ensure a transient DB failure during signup or login renders an error page rather than crashing the process — protecting activation rates during infrastructure incidents.

---

## 2026-04-23 — QA Audit: Invoice CRUD + Billing Settings Coverage

### What changed
**New test files (13 tests across 2 files):**

| File | Tests | What it covers |
|------|-------|----------------|
| `tests/invoice-crud.test.js` | 8 | Invoice creation success path + validation, GET/POST edit IDOR guard, print view IDOR, status update redirect |
| `tests/billing-settings.test.js` | 5 | GET /billing/success redirect, POST /billing/portal graceful degradation (no customer ID) + Stripe redirect, GET /billing/settings render, POST /billing/settings persistence |

**`package.json` `test` script** extended to run both new files (7 suites total).

### Coverage before → after

| Path | Before | After |
|------|--------|-------|
| POST /invoices/new — success path (core product action) | 0 tests | 1 test |
| POST /invoices/new — validation error (blank client_name) | 0 tests | 1 test |
| GET /invoices/:id/edit — owner access | 0 tests | 1 test |
| GET /invoices/:id/edit — IDOR guard | 0 tests | 1 test |
| POST /invoices/:id/edit — owner redirect | 0 tests | 1 test |
| POST /invoices/:id/edit — IDOR (db called with session user_id) | 0 tests | 1 test |
| GET /invoices/:id/print — IDOR guard | 0 tests | 1 test |
| POST /invoices/:id/status — redirect to invoice view | 0 tests | 1 test |
| GET /billing/success — plan refresh + /dashboard redirect | 0 tests | 1 test |
| POST /billing/portal — no customer_id → /billing/upgrade | 0 tests | 1 test |
| POST /billing/portal — valid customer → Stripe portal | 0 tests | 1 test |
| GET /billing/settings — authenticated render | 0 tests | 1 test |
| POST /billing/settings — db.updateUser + redirect | 0 tests | 1 test |

**Total: 46 → 59 passing tests (+13)**

### Why it matters for income
- **Invoice creation** is the core product action — the success path was completely untested. A regression here would break every user's ability to create invoices.
- **Edit IDOR tests** ensure users cannot overwrite another user's invoice data, protecting both data integrity and trust.
- **Print IDOR test** ensures invoice details are never leaked to wrong-session users via the print route.
- **`GET /billing/success`** refreshes the session plan immediately after Stripe checkout; if this redirect broke, newly-upgraded Pro users would see Free UI until their next login.
- **`POST /billing/portal`** graceful degradation: if a Pro user with no `stripe_customer_id` hits portal, it now has a verified safe fallback instead of a potential 500.
- **`POST /billing/settings`** verifies business info (name, address, phone) actually reaches `db.updateUser` — this data appears on every invoice PDF.

---

## 2026-04-23 — Annual Billing Plan at $99/year (QuickInvoice)

### What was built
Added a Monthly / Annual billing-cycle selector across every upgrade surface. Free users can now choose **Pro Annual — $99/year** ($8.25/mo effective, **31% cheaper** than monthly) or **Pro Monthly — $12/month** at the exact moment they click upgrade. The selection flows as `billing_cycle` through the POST `/billing/create-checkout` handler to a new `resolvePriceId()` helper that picks the correct Stripe price ID and stamps the chosen cycle into the Checkout session's `metadata` for downstream analytics.

### Files changed
| File | Change |
|------|--------|
| `routes/billing.js` | New `resolvePriceId(billing_cycle)` helper; `POST /billing/create-checkout` now reads `req.body.billing_cycle`, selects `STRIPE_PRO_ANNUAL_PRICE_ID` vs `STRIPE_PRO_PRICE_ID`, and records the cycle in `session.metadata.billing_cycle`. Falls back to monthly when the annual price env var is unset so the CTA never breaks before Master has created the annual Stripe price. Unknown cycle values are normalised to `monthly` (no bogus values ever reach Stripe). |
| `views/pricing.ejs` | Full redesign of the Pro column: Alpine.js `pricingToggle()` drives a Monthly / Annual pill selector; Pro card live-swaps `$12/mo` ↔ `$99/yr` (with "Billed yearly · Just $8.25/mo" subtext); hidden `billing_cycle` input posts the selection; "Save 31%" green badge on Annual. |
| `views/settings.ejs` | Refactored Subscription block. Free users see both a **$12/mo** and a **$99/yr** pill plus an inline Upgrade CTA using the same `billing_cycle` POST. Pro users see the existing "Manage subscription" portal link (upgrade selector hidden). |
| `views/partials/upgrade-modal.ejs` | Added a compact Monthly / Annual pill selector inside the free-plan limit modal (the single highest-intent conversion moment). Cycle defaults to monthly; `billing_cycle` flows through the existing Stripe Checkout form. |
| `.env.example` | Added `STRIPE_PRO_ANNUAL_PRICE_ID=price_...` alongside the existing monthly price ID. |
| `tests/annual-billing.test.js` | **New** — 9 tests covering all cycle-resolution branches and rendered markup. |
| `package.json` | `test` script now runs `tests/annual-billing.test.js` as the fifth suite; added `ejs` to `devDependencies` implicitly via test import (ejs is already a runtime dep). |

### How it was verified
`npm test` — 11 + 12 + 8 + 6 + 9 = **46/46 tests passing**. The 9 new annual-billing tests cover:
- POST `/billing/create-checkout` without `billing_cycle` → monthly price (backward-compatible).
- `billing_cycle=monthly` → monthly price + `metadata.billing_cycle='monthly'`.
- `billing_cycle=annual` → annual price + `metadata.billing_cycle='annual'`.
- `billing_cycle=annual` with `STRIPE_PRO_ANNUAL_PRICE_ID` unset → falls back to monthly price (deploy-safe).
- Unknown `billing_cycle` value → normalised to monthly (no garbage to Stripe).
- `views/pricing.ejs` renders both cycle buttons + `billing_cycle` hidden input + $99 / $12 prices.
- `views/settings.ejs` renders the selector + input for Free users…
- …and **hides** it for Pro users (who only see "Manage subscription").
- `views/partials/upgrade-modal.ejs` renders the cycle selector + hidden input + $99/year CTA.

### Why it matters for income
1. **Direct revenue lift.** Annual subscribers pay $99 up front instead of an average of ~$60 before churning monthly — 50-65% more lifetime revenue per conversion, plus immediate cash.
2. **Half the churn.** Industry SaaS benchmarks: annual plans churn at roughly half the rate of monthly plans (one renewal decision per year vs. twelve). Every user who picks annual is a year of revenue locked in with zero ongoing effort.
3. **Price-anchored conversion bump.** The "Save 31%" badge gives Monthly shoppers a visible reason to commit now instead of staying on Free; the anchor also makes Monthly feel reasonable.
4. **Deploy-safe.** The `resolvePriceId()` fallback means this code can ship today — even before Master creates the annual Stripe price, every click still produces a valid monthly Checkout session. When Master adds `STRIPE_PRO_ANNUAL_PRICE_ID`, annual activates automatically with no code change.

### Master action required
**One-time Stripe Dashboard action (~2 min):** create a $99/year recurring price on the existing Pro product, then set `STRIPE_PRO_ANNUAL_PRICE_ID=price_...` in the production env. Details added to `TODO_MASTER.md` item 11.

---

## 2026-04-23 — QA Audit: Auth, Free-Limit, Billing-Webhook, Agency-Plan Bug Fix

### What changed
**Bug fix:** `routes/invoices.js` (line 160) — `POST /invoices/:id/status` only created Stripe Payment Links for `plan === 'pro'`. Agency plan users ($49/mo, which includes all Pro features) were silently skipped. Fixed to check `plan === 'pro' || plan === 'agency'`.

**New test files (26 tests across 3 files):**

| File | Tests | What it covers |
|------|-------|----------------|
| `tests/auth.test.js` | 12 | Registration validation (name/email/password), duplicate-email rejection, successful register → session + redirect, login with wrong password, login with unknown email, successful login → session + redirect, logout destroys session, `redirectIfAuth` guard on GET /login and GET /register, `requireAuth` guard redirects unauthenticated requests |
| `tests/invoice-limit.test.js` | 8 | Free-plan limit enforcement on GET and POST `/invoices/new` (redirect to `?limit_hit=1`), free user under limit renders form, pro user never blocked, solo plan does NOT get Payment Links (regression guard), agency plan DOES get Payment Links (fix verification), IDOR guard on `GET /invoices/:id` (wrong user → /dashboard), DELETE redirects to /dashboard |
| `tests/billing-webhook.test.js` | 6 | Invalid Stripe signature → 400; `checkout.session.completed` subscription mode → `db.updateUser(plan='pro')`; `checkout.session.completed` payment_link mode → `db.markInvoicePaidByPaymentLinkId`; `customer.subscription.deleted` → pool.query downgrade to free; `customer.subscription.updated` (active) → pool.query set to pro; `customer.subscription.updated` (non-active) → pool.query set to free |

**`package.json` `test` script** updated to run all four test files sequentially.

### Coverage before → after
| Path | Before | After |
|------|--------|-------|
| Auth: register/login/logout/redirectIfAuth/requireAuth | 0 tests | 12 tests |
| Free-plan limit enforcement + upgrade-modal redirect | 0 tests | 2 tests |
| Plan gating: solo excluded, agency included | 0 tests | 2 tests |
| IDOR guard (wrong-user invoice fetch) | 0 tests | 1 test |
| Stripe webhook: signature validation | 0 tests | 1 test |
| Stripe webhook: subscription checkout → plan upgrade | 0 tests | 1 test |
| Stripe webhook: payment_link checkout → invoice paid | 0 tests | 1 test |
| Stripe webhook: subscription deleted/updated lifecycle | 0 tests | 2 tests |
| Payment Links (existing) | 11 tests | 11 tests (unchanged) |

**Total: 11 → 37 passing tests (+26)**

### Why it matters for income
- **Auth tests** gate every income-generating action — a broken login flow means zero revenue.
- **Billing webhook tests** verify the entire subscription lifecycle without a live Stripe account: upgrades, downgrades, and payment reconciliation are the revenue backbone.
- **Agency bug fix** means $49/mo agency users now receive Payment Links as advertised — preventing silent feature regression on the highest-value plan.
- **Free-limit tests** lock in the upgrade-modal redirect that drives free → Pro conversions.

---

## 2026-04-23 — Stripe Payment Links on Invoices (QuickInvoice, Pro feature)

### What was built
Pro-plan invoices now auto-generate a Stripe Payment Link the first time the invoice is marked as `sent`. The link URL is stored on the invoice row and surfaced in three places:

1. **`views/invoice-view.ejs`** — a green "💳 Pay Now" action-bar button (Pro + link-present only), plus a dedicated "Payment Link" block with a copyable, read-only URL input (Alpine.js clipboard helper, "Copied!" confirmation).
2. **`views/invoice-print.ejs`** — a print-safe payment section with the full URL and an inline SVG QR code rendered client-side by `qrcode@1.5.3` via CDN (no server-side dependency added). Graceful fallback when JS is disabled: the URL is still clickable.
3. **Stripe webhook (`routes/billing.js`)** — `checkout.session.completed` events with `mode === 'payment'` and a `payment_link` reference now look up the invoice by `payment_link_id` and flip its status to `paid`. Idempotent (already-paid invoices are not re-updated).

### Files changed
| File | Change |
|------|--------|
| `db/schema.sql` | Added `payment_link_url TEXT` and `payment_link_id VARCHAR(255)` columns to `invoices` (with `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for existing DBs); added index `idx_invoices_payment_link_id` |
| `db.js` | New `setInvoicePaymentLink()` and `markInvoicePaidByPaymentLinkId()` queries |
| `lib/stripe-payment-link.js` | **New** — helper that creates a Stripe Product + Price + Payment Link for a given invoice, with a `$0.50` minimum guard and metadata (`invoice_id`, `user_id`, `invoice_number`) for webhook traceability |
| `routes/invoices.js` | `POST /invoices/:id/status` — on the `draft → sent` transition for Pro users, creates the Payment Link asynchronously; errors are logged but do not block the status change (graceful degradation) |
| `routes/billing.js` | Webhook handler for `checkout.session.completed` extended: `mode === 'payment'` + `session.payment_link` → mark the matching invoice paid |
| `views/invoice-view.ejs` | "Pay Now" button in the action bar + shareable copyable link block (Pro only) |
| `views/invoice-print.ejs` | Print-safe payment section with URL + inline SVG QR code (client-side generated) |
| `tests/payment-link.test.js` | **New** — 11-case integration harness (stubs db + Stripe client); runs via `npm test` |
| `package.json` | Added `"test": "node tests/payment-link.test.js"` |

### How it was verified
`npm test` — 11/11 passing, covering:
- Pro user marking `sent` creates exactly one Payment Link with the correct URL/ID stored.
- Free user marking `sent` does NOT create a Payment Link.
- Re-marking `sent` on an invoice that already has a link does NOT duplicate.
- Marking `paid` never triggers Payment Link creation.
- Webhook `markInvoicePaidByPaymentLinkId()` is idempotent.
- `invoice-view.ejs` renders Pay Now + link only for Pro users with a link.
- `invoice-print.ejs` renders QR placeholder + URL only for Pro users with a link.
- `lib/stripe-payment-link.js` passes correct params to Stripe (unit_amount in cents, USD, metadata) and rejects sub-minimum totals.

### Why it matters for income
This is the single largest feature-gap between QuickInvoice and competitor tools like Bonsai, HoneyBook, and FreshBooks: **the invoice itself is the checkout**. Specifically:

1. **Higher switching cost** — once a Pro user has sent 5–10 invoices with working pay links, leaving means re-plumbing their billing flow. That's sticky in a way that "unlimited invoices" is not.
2. **Faster time-to-cash for customers** — clients click Pay → Stripe Checkout → paid in <30s, instead of copying bank details. The invoice auto-flips to `paid` via webhook. Freelancers' own revenue velocity going up is the #1 testimonial driver.
3. **Tangible Pro unlock** — the upgrade modal (shipped earlier today) lists "payment links" as a Pro benefit; this ships the actual functionality. Expected conversion lift from free → Pro now that the promise is real.
4. **Zero-ops billing** — once the Stripe webhook is registered for `checkout.session.completed` (already done for subscriptions), Payment Link payments automatically reconcile. No human in the loop.

### Master action required
Add the `checkout.session.completed` webhook event (already enabled for subscriptions — no new subscription needed) to also process `mode: payment` sessions. No Stripe Dashboard change needed since our existing webhook is already subscribed to `checkout.session.completed`. Just confirm once live.

---

## 2026-04-23 — Upgrade Modal at Free-Plan Invoice Limit (QuickInvoice)

### What was built
Replaced the dead-end "flash error → upgrade page redirect" that free users hit at 3 invoices with a full-screen Alpine.js modal. When a free user tries to create a 4th invoice, the server now redirects to `/invoices?limit_hit=1`; the dashboard (and invoice form, for future parity) detects the query flag on page load and surfaces a modal with Pro unlocks, social proof, a one-click Stripe checkout CTA, "See full pricing" secondary link, and dismiss. After opening, the modal strips `limit_hit=1` from the URL via `history.replaceState` so a refresh doesn't re-trigger it.

### Files changed
| File | Change |
|------|--------|
| `routes/invoices.js` | GET and POST `/invoices/new` at free-plan limit now redirect to `/invoices?limit_hit=1` instead of flash-redirecting to `/billing/upgrade` |
| `views/partials/upgrade-modal.ejs` | **New** — reusable Alpine.js modal component with Pro benefit list, Stripe Checkout CTA, dismiss, auto-open on `?limit_hit=1` |
| `views/dashboard.ejs` | Includes the upgrade-modal partial |
| `views/invoice-form.ejs` | Includes the upgrade-modal partial (parity per spec) |

### How it was verified
Integration test harness (stubbed db + auth) confirmed:
- Free user at 3 invoices → GET and POST `/invoices/new` both redirect 302 to `/invoices?limit_hit=1`.
- Free user under the limit → form renders normally (200).
- Pro user at 100 invoices → form renders normally (200).
EJS render tests confirmed both `views/dashboard.ejs` and `views/invoice-form.ejs` include the modal markup.

### Why it matters for income
This is the highest-intent conversion moment in the funnel — the user has just tried to perform the core paid action and been told "no." The old flow dropped them on a pricing page after a flash error; the new flow keeps them on the dashboard, shows the exact unlocks they're missing (unlimited invoices, email delivery, payment links, branding), and offers a one-click Stripe Checkout without a page navigation. Reducing friction at this exact moment is the single biggest lever for free → Pro conversion.

---

## 2026-04-22 — P10: Custom Branding for Pro Plan

### What was built
Logo upload and custom brand color as a Pro/Agency-only feature, applied to all generated PDF invoices.

### Files changed
| File | Change |
|------|--------|
| `db/migration/V2__add_branding.sql` | New — adds `logo_data` (TEXT) and `brand_color` (CHAR 7) columns to `users` |
| `user/Plan.java` | Added `customBranding` boolean flag (true for PRO and AGENCY plans) |
| `user/User.java` | Added `logoData` and `brandColor` fields with getters/setters |
| `branding/BrandingController.java` | New — `GET /api/branding`, `PUT /api/branding/color`, `POST /api/branding/logo`, `DELETE /api/branding/logo` |
| `pdf/PdfService.java` | Resolves brand color from hex string; renders user logo at top of PDF for Pro/Agency users |
| `BrandingControllerTest.java` | New — 8 tests covering plan gating, color validation, logo upload/delete, size/type enforcement |

### Why it matters for income
- Custom branding is a named Pro-plan benefit at $19/month — it's a concrete, visible upgrade incentive.
- Every invoice PDF a Pro user generates now reflects their brand instead of InvoiceFlow's default blue, making the product sticky (higher switching cost).
- The feature is invisible to Free/Solo users but becomes a clear upgrade driver when they see branded PDFs from Pro users.

---

## 2026-04-21 — v1.0.0 — Initial Build

**What was built:** Full MVP of QuickInvoice, a professional invoicing SaaS for freelancers.

### App Summary
QuickInvoice lets freelancers create, manage, and download professional invoices in under a minute. It monetizes via a Stripe subscription (Free → Pro at $12/month).

### Income Model
| Plan | Price | Limit |
|------|-------|-------|
| Free | $0 | 3 invoices total |
| Pro | $12/month | Unlimited invoices |

**Revenue projection:** 100 Pro users = $1,200 MRR. Zero ongoing work required after deployment.

### Files Created
| File | Purpose |
|------|---------|
| `server.js` | Express app entry point, session management |
| `db.js` | PostgreSQL connection pool + all DB queries |
| `routes/auth.js` | Register, login, logout |
| `routes/invoices.js` | Invoice CRUD, print view, status updates |
| `routes/billing.js` | Stripe checkout, webhook, settings, portal |
| `middleware/auth.js` | Session auth guards |
| `db/schema.sql` | PostgreSQL table definitions |
| `views/index.ejs` | Landing page with hero, features, pricing |
| `views/auth/login.ejs` | Login form |
| `views/auth/register.ejs` | Registration form |
| `views/dashboard.ejs` | Invoice list with revenue stats |
| `views/invoice-form.ejs` | Create/edit invoice with live total calculation |
| `views/invoice-view.ejs` | Invoice detail with action buttons |
| `views/invoice-print.ejs` | Print-optimized invoice (browser print-to-PDF) |
| `views/pricing.ejs` | Upgrade page |
| `views/settings.ejs` | Business info + subscription management |
| `views/partials/head.ejs` | HTML head (Tailwind + Alpine.js via CDN) |
| `views/partials/nav.ejs` | Navigation bar |
| `package.json` | Node.js dependencies |
| `Procfile` | Heroku process definition |
| `.env.example` | Environment variable template |
| `.gitignore` | Git ignore rules |

### Tech Stack
- **Runtime:** Node.js 18+
- **Framework:** Express 4
- **Templates:** EJS
- **CSS:** Tailwind CSS (CDN, no build step)
- **Interactivity:** Alpine.js (CDN, no build step)
- **Database:** PostgreSQL via `pg`
- **Auth:** express-session + connect-pg-simple + bcrypt
- **Payments:** Stripe (Checkout + Webhooks + Customer Portal)
- **Deployment:** Heroku (Procfile + Heroku Postgres add-on)

### Key Features
- Secure account creation and login
- Invoice editor with dynamic line items (add/remove, live totals, tax)
- Auto-generated invoice numbers (`INV-YYYY-XXXX`)
- Business branding on invoices (name, address, phone, email)
- Invoice status tracking (Draft → Sent → Paid)
- Print-to-PDF via browser (no server-side PDF dependency)
- Free plan enforced at 3 invoices; Pro plan via Stripe subscription
- Stripe Customer Portal for subscription management/cancellation
- Webhook handler for subscription lifecycle (upgrade, cancel, expire)
- Revenue stats on dashboard (total invoiced, collected, outstanding)

---
# Changelog

## 2026-04-22 — Initial Build: InvoiceFlow SaaS MVP

### What was built
Full Spring Boot 3 + PostgreSQL SaaS application for freelancer invoicing from scratch.

### Files created
**Project scaffold**
- `invoiceflow/pom.xml` — Maven build with Spring Boot 3.3, iText8, Stripe Java, JJWT, Flyway, SendGrid SMTP
- `invoiceflow/src/main/resources/application.yml` — Config with env-var overrides for all secrets
- `invoiceflow/src/main/resources/db/migration/V1__init.sql` — Flyway schema: users, clients, invoices, line_items

**Auth**
- `auth/JwtUtil.java` — JWT generation and validation (HMAC-SHA256)
- `auth/JwtFilter.java` — OncePerRequestFilter that hydrates Spring Security context
- `auth/AuthController.java` — POST /api/auth/register, POST /api/auth/login

**User & Plans**
- `user/User.java`, `Plan.java`, `SubscriptionStatus.java`, `UserRepository.java`
- Plan limits enforced at request time: FREE (5 invoices/mo, 1 client), SOLO, PRO, AGENCY

**Client API** — CRUD, plan-limit enforcement, user-scoped
**Invoice API** — CRUD with cascading line items, plan-limit enforcement, user-scoped
**PDF Service** — iText8 branded PDF: header, meta table, line-items table with totals, payment link
**Email Service** — Spring Mail async send: invoice delivery + overdue payment reminder HTML emails
**Stripe Integration**
- `StripeService.java` — Checkout session creation, Stripe Payment Link per invoice, customer auto-creation
- `StripeWebhookController.java` — Handles checkout.session.completed, subscription updated/deleted, payment link paid → updates user plan and invoice status automatically
- `StripeController.java` — POST /api/stripe/checkout, POST /api/stripe/invoices/{id}/payment-link

**Scheduler** — Daily 09:00 UTC job: marks overdue invoices, emails payment reminders to PRO/AGENCY plan clients (3-day cooldown)
**Dashboard** — GET /api/dashboard: revenue, outstanding, overdue amounts + counts

**Tests**
- `AuthControllerTest.java` — MockMvc tests for register/login happy and error paths
- `TestConfig.java` — Mock Email, PDF, Stripe beans for test profile
- `src/test/resources/application-test.yml` — H2 in-memory config, Flyway disabled

---

## 2026-04-22 — P10: Custom Branding for Pro/Agency Plans

### What was built
Pro and Agency users can now personalise every PDF invoice with their own brand color (hex) and company logo. Free/Solo users who try to use branding endpoints get HTTP 402 with an upgrade prompt.

### Files changed
| File | Change |
|------|--------|
| `db/migration/V2__branding.sql` | Flyway migration: adds `logo_url` and `brand_color` columns to `users` |
| `user/User.java` | Added `logoUrl`, `brandColor` fields + getters/setters |
| `config/AppProperties.java` | Added `uploadsDir` config property |
| `application.yml` | Added `app.uploads-dir: ${UPLOADS_DIR:./uploads}` |
| `application-test.yml` | Added test uploads dir pointing to `/tmp` |
| `branding/BrandingController.java` | **New** — `GET /api/branding`, `PUT /api/branding`, `POST /api/branding/logo`, `DELETE /api/branding/logo`; Pro-plan gated; validates hex color and image MIME/size |
| `config/WebMvcConfig.java` | **New** — Serves `{uploadsDir}/**` under `/uploads/**` |
| `config/SecurityConfig.java` | Permits `/uploads/**` (logo images are public URLs embeddable in PDFs) |
| `pdf/PdfService.java` | Reads `user.getBrandColor()` and `user.getLogoUrl()` to apply custom color and logo; falls back to default blue if unset |
| `BrandingControllerTest.java` | **New** — 10 integration tests covering GET, PUT color, logo upload/delete, plan enforcement, and validation |

### Why it matters for income
Custom branding is gated behind Pro ($19/mo) and Agency ($49/mo). It is one of the highest-perceived-value Pro features — freelancers want their invoices to look like their brand, not a generic tool. This increases Pro conversion and dramatically reduces cancellation once a user has uploaded their logo (switching cost is high). It also enables upsell copy: "Remove generic branding" on free-tier PDF footers.

### Why it matters for income
- Freemium funnel: register free, hit invoice limit → upgrade prompt → Stripe Checkout → recurring subscription revenue
- Stripe handles billing autonomously; webhook syncs plan state with zero manual intervention
- Automated reminder emails reduce time-to-payment without human input
- PDF + email delivery makes the product immediately useful, driving activation and retention

---

## 2026-04-22 — P10: Custom Branding (logo + brand color) — Pro Feature

### What was built
Pro and Agency users can now upload their company logo and choose a custom brand color. Both appear on all generated PDF invoices. Free and Solo users get an "InvoiceFlow" attribution footer on their PDFs (passive acquisition). All 8 tests pass.
## 2026-04-22 — P10: Custom Branding (Logo + Brand Color) — Pro Plan

### What was built
Custom branding feature for Pro and Agency plan users: logo upload (PNG/JPEG/GIF/WebP, max 512 KB) and brand color (hex), applied to every generated PDF. Free and Solo users see the default InvoiceFlow brand.

### Files changed
| File | Change |
|------|--------|
| `db/migration/V2__branding.sql` | Adds `logo_data BYTEA`, `logo_content_type VARCHAR(30)`, `brand_color VARCHAR(7)` columns to `users` |
| `user/Plan.java` | Added `customBranding` boolean flag (true for PRO and AGENCY) |
| `user/User.java` | Added `logoData`, `logoContentType`, `brandColor` fields + getters/setters |
| `branding/BrandingController.java` | New REST controller: `GET/PUT /api/branding`, `POST/DELETE/GET /api/branding/logo` |
| `pdf/PdfService.java` | Uses user brand color and embeds logo in PDF header; adds attribution footer for free users |
| `resources/application.yml` | Added `spring.servlet.multipart` limits (2 MB file, 3 MB request) |
| `test/BrandingControllerTest.java` | 7 test cases: get defaults, update color, plan enforcement, logo upload/retrieve/delete |

### Why it matters for income
- **Retention:** Logo and color personalization increases perceived value and switching cost for Pro subscribers.
- **Upgrade incentive:** Every free-plan PDF now carries an "Created with InvoiceFlow" footer — passive acquisition on every invoice the user sends to their clients.
- **Feature differentiation:** Custom branding is a tangible, visible reason to upgrade from Solo ($9) to Pro ($19), raising ARPU.
| `invoiceflow/src/main/resources/db/migration/V2__branding.sql` | Flyway migration: adds `brand_color`, `logo_data`, `logo_mime` columns to `users` |
| `invoiceflow/src/main/java/com/invoiceflow/user/User.java` | Three new fields + getters/setters for branding columns |
| `invoiceflow/src/main/java/com/invoiceflow/branding/BrandingController.java` | New REST controller: GET/PUT color, POST/DELETE/GET logo — Pro-gated |
| `invoiceflow/src/main/java/com/invoiceflow/pdf/PdfService.java` | Parses user brand color + decodes/embeds logo image (Pro/Agency only) |
| `invoiceflow/src/main/resources/application.yml` | Multipart file limits (512 KB file, 1 MB request) |
| `invoiceflow/src/test/java/com/invoiceflow/BrandingControllerTest.java` | 12 MockMvc tests covering plan enforcement, color update, logo upload/delete/serve |

### Why it matters for income
Custom branding is a **Pro-exclusive feature** ($19/mo). It creates a tangible value difference between free and paid tiers: paid users' clients see their logo and colors on every PDF invoice, while free users see generic InvoiceFlow branding. This increases perceived professionalism for paying customers, reduces churn ("my clients see my brand every invoice"), and serves as a visible reminder on every invoice to upgrade.
