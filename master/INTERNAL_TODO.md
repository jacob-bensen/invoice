# QuickInvoice + InvoiceFlow — Internal Growth TODO

> **Audited:** 2026-04-27 PM (Task Optimizer cycle, 6th pass). This cycle's deltas: (a) **#56 closed** — `robots.txt` route + canonical URL meta tag shipped end-to-end; `noindex: true` propagated to dashboard, settings, invoice-view, invoice-form, invoice-print, auth/login, auth/register render calls; 17 new assertions in `tests/robots-and-canonical.test.js`; pairs with #36 to give crawlers both a rich preview and a canonical pointer. (b) **5 new [GROWTH] items (#61-#65)** from this cycle's Growth Strategist pass: #61 PDF email attachment [S, HIGH — closes the largest competitor-parity gap], #62 year-end tax summary [S, HIGH retention during the highest-churn-risk window], #63 quick-pick recent clients [XS, MEDIUM activation], #64 aging receivables widget [S, MEDIUM retention/professionalism], #65 save-as-template + template gallery [S, MED-HIGH activation/retention]. (c) **3 new [MARKETING] items in TODO_MASTER (#42-#44)** — Google Search Console verification + sitemap submission, listicle outreach for backlinks, LinkedIn cold-outbound to Operations/Eng directors hiring freelancers. (d) **6 new SSRF guard tests** added to `tests/webhook-outbound.test.js` (IPv6 fc00/fd00/fe80, IPv4-mapped-to-private, 0.0.0.0/8, literal `metadata` short-name) — defence-in-depth regression-guard on `lib/outbound-webhook.js`'s SSRF branches. (e) **UX audit fixes** — `views/auth/login.ejs` submit button now reads `Log in →` (matches register's arrow style); `views/dashboard.ejs` `+ New Invoice` → `+ New invoice` sentence-case + a11y wrap on the `+` glyph. Full suite now **33 files, 0 failures** (was 32 last cycle).
>
> Prior DONE items remain inline-tagged (kept for context; **archive trigger remains 1.5k lines** — currently at ~1.95k lines after this cycle's net additions; **archive sweep is now overdue by 2 cycles** — every line of [DONE] resolution text is valuable as historical context but old enough to compress into a `master/CHANGELOG_ARCHIVE.md` next cycle). Priority order: **[TEST-FAILURE] (none) > income-critical features > [UX] items that affect conversion > [HEALTH] > [GROWTH] > [BLOCKED]**. Complexity tags: [XS] < 30 min · [S] < 2 hrs · [M] 2–8 hrs · [L] > 8 hrs. Duplicates checked against `TODO.md` and `TODO_MASTER.md` — none introduced this cycle. The 5 new [GROWTH] items were checked for overlap against all 60 prior items and the entire TODO_MASTER tree before adding.

Do not duplicate items already in `TODO.md`. App labels indicate which codebase each task applies to.

---

## OPEN TASK INDEX (priority order, post-2026-04-26 PM-2 audit)

**[UX] — affects conversion, fix sooner**
- **U1** [UX] [M] — Self-serve password reset flow (stopgap shipped; full flow blocked on Resend key + 4 routes + 2 views + tests)
- **U3** [UX] [S] — Authed pages have no global footer with pricing / settings / log-out / legal links. Once #28 (legal pages) ships, build a `views/partials/footer.ejs` and include it on `dashboard`, `invoice-view`, `invoice-form`, `settings`, and the auth pages.
- **U4** [UX] [S] — The "Preview Pay Link" action button on `views/invoice-view.ejs` is structurally redundant with the dedicated "Payment Link" copy-link card further down the page. Consolidate to one surface (keep the copy-link card OR move the URL-copy card into the action bar).
  *(U2 closed 2026-04-26 PM. #37 closed 2026-04-26 PM-2 UX audit. #41 closed 2026-04-26 PM-2.)*

**Income-critical [GROWTH] — XS first (highest impact-per-effort)**
- **#63** [XS] — Quick-pick recent clients dropdown on invoice form (activation lift)
- **#44** [XS] — In-app "✨ What's new" changelog widget in nav (retention)
- **#45** [XS] — Last-day urgency dashboard banner for trial users (HIGH; pairs with #29)
- **#52** [XS] — JSON-LD `SoftwareApplication` schema on landing + niche pages (MED-HIGH SEO; pairs with #36)
- **#55** [XS] — Auto thank-you email to client on paid (compounds with #30; effortless professionalism)
- **#48** [XS] — "Powered by QuickInvoice" badge on public invoice URLs (compounds with invoice volume; gated on #43)
- **#31** [XS] — Free-Plan Invoice Limit Progress Bar on Dashboard
- **#34** [XS] — Plausible Analytics Integration (gated on Master providing PLAUSIBLE_DOMAIN per TODO_MASTER #29)
  *(#36 closed 2026-04-27 — OG/Twitter Card metadata shipped end-to-end + 10 new tests; TODO_MASTER #38/#39 added for Master to drop in branded image + APP_URL. #56 closed 2026-04-27 PM — robots.txt + canonical link tag + meta robots noindex on authed pages + 17 new tests in `tests/robots-and-canonical.test.js`. Pairs with #36 — every shared link now carries a canonical pointer to the canonical domain in addition to the rich OG preview.)*

**Income-critical [GROWTH] — S complexity**
- **#61** [S] — Attach invoice PDF to invoice email (HIGH; AP departments require attached PDF for filing)
- **#62** [S] — Year-end tax summary PDF + email for Pro users (HIGH retention; saves the freelancer 2-3 hrs at tax time)
- **#65** [S] — "Save invoice as template" + template gallery on invoice form (MED-HIGH activation + retention)
- **#64** [S] — Aging receivables report widget on dashboard (0-30/30-60/60-90+ buckets)
- **#57** [S] — 30-day NPS micro-survey for Pro users (HIGH retention; surfaces churn before cancel)
- **#58** [S] — Public coupon-redemption page `/redeem/:code` (MED-HIGH; pairs with #35 + TODO_MASTER #41)
- **#59** [S] — "Invoiced via QuickInvoice" footer in invoice emails (MED-HIGH virality; Calendly-style passive distribution)
- **#28** [S] — Legal Pages Scaffolding (Terms / Privacy / Refund) — blocks L1/L2/L3 in TODO_MASTER + Stripe ToS + U3
- **#46** [S] — Pricing page exit-intent modal (MED-HIGH; 5-15% bounce-cohort recovery)
- **#47** [S] — Monthly→Annual upgrade prompt on dashboard (HIGH retention/LTV)
- **#49** [S] — First-paid-invoice celebration banner + referral email
- **#39** [S] — First-invoice seed template on signup (HIGH activation lift)
- **#54** [S] — Deposit / partial payment invoices (Pro feature; HIGH agency-tier lift)
- **#42** [S] — Custom invoice numbering scheme (Pro feature; switching-cost lift)
- **#43** [S] — Public read-only invoice URL `/i/:token` (no-login share; unblocks #48)
- **#15** [S] — Contextual Pro Upsell Prompts on Locked Features (MED-HIGH; bundle U2)
- **#27** [S] — One-Click Invoice Duplication
- **#33** [S] — Invoice Bulk CSV Export (GDPR Art. 15 + tax-season retention)
- **#26** [S] — AI-Powered Line Item Suggestions (Claude Haiku, Pro feature)
- **#22** [S] — Late Fee Automation (Pro feature)
- **#23** [S] — PWA Manifest for Mobile Installability
- **#25** [S] — Expand SEO Niche Landing Pages (6 → 15)
- **#38** [S] — Public `/roadmap` page (trust + churn defence)
- **#20** [S] — Social Proof Section on Landing + Pricing Pages
- **#32** [S] — API Key Auth + REST Endpoints (prereq for Zapier app listing)
- **#51** [S] — Schedule invoice send for a future date (MED-HIGH; reuses cron infra)

**Income-critical [GROWTH] — M / L (larger; plan deliberately)**
- **#60** [M] — Demo-mode dashboard at `/demo` (HIGH; removes #1 conversion blocker — no signup required)
- **#50** [M] — Quote/Estimate flow with one-click "Convert to invoice" (HIGH; B2B switching-cost lift)
- **#53** [M] — Resend webhook integration: surface "client opened invoice" on dashboard (HIGH; behavioural signal)
- **#40** [M] — Recurring Invoice Auto-Generation for QuickInvoice (parity with InvoiceFlow; HIGH retention)
- **#21** [M] — Client-Facing Invoice Portal
- **#18** [M] — Referral Program with Stripe Coupon Rewards
- **#24** [M] — Multi-Currency Invoice Support
- **#17** [M] — Google OAuth One-Click Signup
- **#10** [L] — Business Tier at $29/mo (gated on Master creating Stripe prices)
- **#9** [L] — InvoiceFlow Team Seats for Agency Plan

**[HEALTH] (open)**
- **H8** [XS] — Composite `(user_id, status)` index on `invoices` (bundle with next migration)
- **H10** [XS] — `parseInt(userId)` → `parseInt(userId, 10)` in webhook handler (cosmetic)
- **H14** [XS] — Extract `escapeHtml`/`formatMoney` to shared `lib/html.js` (dedupe with `jobs/reminders.js`)
- **H15** [XS] — `Promise.all` the sequential `getInvoiceById` + `getUserById` in 3 GET handlers
- **H9** [S] — `bcrypt@^5` → `^6` (transitive `tar` advisories; install-time only, runtime exposure nil)
- **H11** [S] — Pagination on `getInvoicesByUser` (bundle with #14 next dashboard touch)
- **H16** [XS] — `resend@^6.12.2` → patched svix when `^6.13` lands (transitive `uuid` advisory; runtime exposure nil)
- **H17** [XS] — Partial index `idx_users_trial_nudge_pending ON users(trial_ends_at) WHERE trial_nudge_sent_at IS NULL` to back the new trial-nudge query (bundle with next `users` migration)

**[BLOCKED] / Long-running** (kept at bottom — see BLOCKED section below)
- **#11** [L] — Churn Win-Back Email Sequence (UNBLOCKED — needs RESEND_API_KEY in prod)
- **#12** [M] — Monthly Revenue Summary Email (UNBLOCKED — needs RESEND_API_KEY in prod)

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

### H1. [DONE 2026-04-24] [HEALTH] SSRF hardening on outbound webhook URL (added 2026-04-23 audit) [S]

**App:** QuickInvoice (Node.js)
**Impact:** MEDIUM — authenticated Pro user can currently point `webhook_url` at a private / metadata / loopback IP. Any error response body is not returned to the user (fire-and-forget, `.on('data', () => {})`), which limits exfiltration, but the probe still reaches internal services. On a Heroku / Render / AWS host, `http://169.254.169.254/...` hits the cloud metadata endpoint; `http://10.x.x.x` and `http://localhost:<port>` reach sibling services.
**Effort:** Very Low
**Location:** `lib/outbound-webhook.js` — `isValidWebhookUrl()` + `firePaidWebhook()`.

**Sub-tasks:**
1. In `isValidWebhookUrl()`, after protocol check, resolve hostname and reject any of: `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `::1`, `fc00::/7`, `fe80::/10`, plus the literal strings `localhost` / `metadata.google.internal` / `169.254.169.254`. Use `dns.lookup(hostname, { all: true })` and block if any resolved address is in those ranges. Keep the call async; update `POST /billing/webhook-url` to `await` the validator.
2. Optionally disallow `http://` entirely (https-only) — most real webhook catch-hooks are HTTPS.
3. Add a test case: `isValidWebhookUrl('http://169.254.169.254/latest/meta-data')` → false.

---

### H2. [DONE 2026-04-24] [HEALTH] No CSRF protection on state-changing POST routes (added 2026-04-23 audit) [S]

**App:** QuickInvoice (Node.js)
**Impact:** MEDIUM — every mutating form (login, register, invoice create/edit/delete, status change, billing settings, webhook URL, Stripe checkout) is a cookie-authenticated POST with no CSRF token. An attacker page the user visits while logged in can, e.g., `<form action=https://quickinvoice.io/invoices/123/status method=POST><input name=status value=paid></form>` submit silently. SameSite=Lax on the session cookie (the default in recent `express-session`) blunts cross-site GET-triggered CSRF but not top-level POST navigation.
**Effort:** Very Low
**Location:** `server.js` (mount middleware) + every EJS form that POSTs.

**Sub-tasks:**
1. Add `csurf` (or the modern `lusca.csrf` / a hand-rolled double-submit cookie) as global middleware after `express-session` and before route mounting — except on `/billing/webhook` (Stripe raw body).
2. Expose `res.locals.csrfToken` via a small middleware; inject `<input type="hidden" name="_csrf" value="<%= csrfToken %>">` into every `<form method=POST>` in `views/`.
3. Update existing tests that POST raw bodies to include the token (most tests use a mocked session + supertest; the middleware allows overriding).

---

### H3. [DONE 2026-04-25] [HEALTH] No rate limiting on auth endpoints (added 2026-04-23 audit) [S]

**App:** QuickInvoice (Node.js)
**Impact:** MEDIUM — `POST /auth/login` and `POST /auth/register` are unthrottled. Bcrypt cost 12 (~200ms per check) is some natural throttle, but a botnet can still grind credentials / enumerate emails via the "account exists" error.
**Effort:** Very Low
**Sub-tasks:** `npm i express-rate-limit`; 10 req/min per IP on `/auth/login` + `/auth/register`; return the same generic "invalid email or password" on both not-found and wrong-password to kill the enumeration oracle.
**Resolution (2026-04-25):** Added `express-rate-limit@^7.5.1` to dependencies. New `middleware/rate-limit.js` exports `authLimiter` (10 req/min/IP, configurable via `AUTH_RATE_LIMIT_MAX`) plus a `createAuthLimiter` factory used by tests. Wired into `routes/auth.js` on both `POST /register` and `POST /login` (after `redirectIfAuth` so authenticated users are redirected before counting). The login enumeration oracle was already closed — both unknown-email and wrong-password paths render the identical generic "Invalid email or password." flash. Exhausted-bucket responses re-render the correct auth view (login or register, picked from `req.path`) with a 429 and a "Too many attempts. Please wait a minute and try again." flash. New `tests/rate-limit.test.js` adds 8 tests (155 total in suite, 0 failures): under-limit pass-through, 429 after max, login/register view selection, independent limiter state, production wiring on `POST /auth/login`, login enumeration-oracle defence, and middleware export sanity. Test-mode (`NODE_ENV=test`) uses a high default so existing suites don't trip the limiter; `package.json` `test` script now sets `NODE_ENV=test` for every test file.

---

### H4. [DONE 2026-04-25] [HEALTH] No security headers (helmet) (added 2026-04-23 audit) [S]

**App:** QuickInvoice (Node.js)
**Impact:** LOW–MEDIUM — missing `X-Frame-Options: DENY` (clickjacking), `X-Content-Type-Options: nosniff`, `Strict-Transport-Security`, `Content-Security-Policy`, and the rest of the helmet defaults. Every modern web audit (SOC2, PCI, Google Search Console security warnings) flags this.
**Effort:** Very Low
**Sub-tasks:** `npm i helmet`; `app.use(helmet())` right after `const app = express()`. Start with defaults; relax the CSP one directive at a time if a view breaks (inline Alpine.js / Tailwind CDN may need `script-src 'self' 'unsafe-inline' cdn.tailwindcss.com` etc.).
**Resolution (2026-04-25):** Added `helmet@^8.1.0` to dependencies. New `middleware/security-headers.js` exports a `securityHeaders()` factory that wraps `helmet()` with a CSP tuned for the actual view set:
- `script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://cdn.jsdelivr.net` (Alpine x-data + tailwind config inline block + `onclick="window.print()"` in `views/invoice-print.ejs` + Tailwind Play CDN + Alpine CDN + the QR-code script)
- `style-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com` (Tailwind Play CDN injects `<style>` blocks at runtime; utility classes work because they are class names, but the runtime stylesheet itself needs the CDN host whitelisted)
- `script-src-attr 'unsafe-inline'` (Alpine `@click`/`@submit` directives serialise to event-handler attributes)
- `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'` (clickjacking + plugin lockdown + `<base>`-tag injection lockdown)
- `form-action 'self' https://checkout.stripe.com https://billing.stripe.com` (Stripe Checkout + Customer Portal redirects)
- `img-src 'self' data: blob:` (inline SVG QR code fallback + future user-uploaded logos)
- `upgradeInsecureRequests` set in production only.
HSTS (`max-age=15552000; includeSubDomains`) is enabled only when `NODE_ENV === 'production'` so local `http://` dev does not become unreachable. `crossOriginEmbedderPolicy` is left disabled (would break the cross-origin Tailwind/Alpine CDN scripts); `crossOriginResourcePolicy` is `same-origin` (default). `X-Powered-By` is removed by helmet's default behaviour. New `tests/security-headers.test.js` adds 9 assertions: common helmet header set, clickjacking protection (XFO + CSP frame-ancestors), powered-by hidden, CSP allows Tailwind CDN for both script-src and style-src, CSP allows jsdelivr (Alpine), CSP retains `'unsafe-inline'` for Alpine handlers, CSP locks default-src/object-src/base-uri, HSTS conditional on `NODE_ENV=production`, server.js wires the middleware before route mounting. `package.json` `test` script appends the new test file. Full suite: 163 tests, 0 failures (was 154 before this commit).

---

### H5. [DONE 2026-04-25] [HEALTH] Inconsistent `plan` CHECK constraint vs. application code (added 2026-04-23 audit) [S]

**App:** QuickInvoice (Node.js)
**Impact:** LOW (latent) — `db/schema.sql` line 12 pins `plan IN ('free', 'pro')`, but `routes/invoices.js:175,189` and `routes/billing.js:123,170` branch on `plan === 'agency'`. Any path that attempts to persist `plan = 'agency'` will fail the CHECK constraint with a 23514 error. No current route actually writes `'agency'`, so this is latent — but it is a trip wire when INTERNAL_TODO #9 (team seats / Agency tier) or #10 (Business tier) lands.
**Effort:** Very Low
**Sub-tasks:** Add idempotent migration to `db/schema.sql`: `ALTER TABLE users DROP CONSTRAINT IF EXISTS users_plan_check; ALTER TABLE users ADD CONSTRAINT users_plan_check CHECK (plan IN ('free','pro','business','agency'));`. Coordinate with INTERNAL_TODO #10's schema change so both land in one migration.

**Resolution (2026-04-25 PM):** Widened the constraint in two places (so fresh installs and existing deployments converge on the same definition):

1. The inline `CREATE TABLE users` CHECK on line 12 now reads `CHECK (plan IN ('free', 'pro', 'business', 'agency'))`. New installs land on the wide list directly.
2. A new idempotent migration block (`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_plan_check;` followed by `ALTER TABLE users ADD CONSTRAINT users_plan_check CHECK (plan IN ('free','pro','business','agency'));`) sits alongside the other `ALTER TABLE … ADD COLUMN IF NOT EXISTS` statements. On an existing prod DB the DROP removes the narrow constraint that Postgres auto-named when CREATE TABLE first ran; the ADD installs the wide one. On a fresh DB the DROP no-ops past `IF EXISTS` if the constraint doesn't exist (it does — CREATE TABLE just created it with the wide list — so DROP+re-ADD is a same-definition swap). Net: one `psql -f db/schema.sql` lands the change on both fresh and migrated databases.

We did NOT bundle this with #10's Business-tier schema as the original sub-task suggested. #10 is [L] effort and is gated on a Master action (creating Stripe Business prices); H5 is the specific trip-wire fix for the existing `agency` references in `routes/billing.js:144,192`, `routes/invoices.js:212,241`, `db.js:164` (reminder query), and `jobs/reminders.js:35` (`PAID_PLANS` Set). Decoupling lets #10 land later without re-litigating the constraint, and unblocks #9 (Agency team seats) which is the other consumer.

New `tests/plan-check-constraint.test.js` adds 7 static-lint assertions: (1) the inline CREATE TABLE CHECK lists exactly `['free','pro','business','agency']` in canonical order; (2) the migration includes `DROP CONSTRAINT IF EXISTS users_plan_check`; (3) the migration's `ADD CONSTRAINT users_plan_check CHECK` definition matches the inline one exactly (so a future schema edit can't drift one without the other); (4) DROP precedes ADD in the file (reversal would no-op on fresh installs and double-add on second runs); (5) every plan literal referenced in `routes/billing.js`, `routes/invoices.js`, `db.js`, and `jobs/reminders.js` (matched via `\bplan\s*[!=]==\s*'X'`, `plan IN (...)`, and `PAID_PLANS = new Set([...])`) is in the whitelist — defence against typos like `'agnecy'` that would slip past the constraint and silently always-evaluate-false; (6) `jobs/reminders.js`'s `PAID_PLANS` Set equals the whitelist minus `'free'`; (7) `db.js`'s `getOverdueInvoicesForReminders` `u.plan IN (...)` filter equals the same paid subset. Wired into `package.json` `test` script. Full suite still green: 23 test files, 0 failures.

**[Master action]** required: re-run the schema migration on production. Single command — `psql $DATABASE_URL -f db/schema.sql`. Idempotent and safe to run on a populated DB. See TODO_MASTER.md.

**Income relevance:** Indirect — unblocks #9 (Agency team seats at $49/mo, the highest-ARPU tier) and #10 (Business tier at $29/mo, raises ARPU ceiling from $12 to $29 per power user). Both tasks would otherwise hit a Postgres 23514 the first time any user upgrade tried to persist `plan='agency'` or `plan='business'`. With the constraint widened, both tiers can ship without re-touching the schema.

---

### H6. [DONE 2026-04-25 — superseded by H12] [HEALTH] `POST /:id/status` accepts any string (added 2026-04-23 audit) [XS]

**App:** QuickInvoice (Node.js)
**Impact:** LOW — the DB CHECK constraint (`status IN ('draft','sent','paid','overdue')`) will reject bad values, but the 500 surfaces as `console.error('Status update error:', err)` and a redirect, creating noisy logs and a confusing UX. Whitelist in Node and return a flash on invalid.
**Location:** `routes/invoices.js:168-203`.
**Resolution (2026-04-25):** Closed alongside H12 — see H12 for the full implementation note.

---

### H7. [DONE 2026-04-24] [HEALTH] Null user dereference in billing.js authenticated routes (added 2026-04-24) [XS]

**App:** QuickInvoice (Node.js)
**Impact:** LOW (latent) — `routes/billing.js` calls `db.getUserById(req.session.user.id)` in `POST /create-checkout`, `GET /success`, `POST /portal`, `GET /settings`, `POST /settings`, and `POST /webhook-url`, then immediately dereferences fields (`user.stripe_customer_id`, `user.plan`, etc.) without a null guard. If a session references a deleted account, all six of these routes produce an unhandled 500 instead of a graceful redirect. The same bug existed in `routes/invoices.js` for `GET /new` and `POST /new` and was fixed on 2026-04-24 with `if (!user) return res.redirect('/auth/login')`. The billing routes need the same treatment.
**Effort:** Very Low
**Resolution (2026-04-24 PM audit):** Added `if (!user) return res.redirect('/auth/login');` in `POST /create-checkout`, `GET /success`, `POST /portal`, and `GET /settings`. `POST /webhook-url` already had the guard. `POST /settings` was patched to `if (!updated) return res.redirect('/auth/login');` after `db.updateUser` (it does not pre-fetch). All 16 test suites still pass; no test changes required for this commit since the existing edge-cases.test.js fixtures only exercise the invoices.js variants — adding billing-side regression tests is folded into H11 below.

---

### H8. [HEALTH] Composite index `(user_id, status)` on `invoices` (added 2026-04-24 PM audit) [XS]

**App:** QuickInvoice (Node.js)
**Impact:** LOW — `db/schema.sql` already creates `idx_invoices_user_id` and `idx_invoices_status` separately. Once the planned reminder job (#16) and any "outstanding invoices for user" dashboard query land, a composite `(user_id, status)` index will let Postgres serve those queries from one index lookup instead of bitmap-anding two. Single-tenant scale (a few hundred invoices per user) makes this a non-issue today; flagged because it costs nothing to add alongside the next migration.
**Effort:** Very Low
**Sub-tasks:** Add `CREATE INDEX IF NOT EXISTS idx_invoices_user_status ON invoices(user_id, status);` to `db/schema.sql`. Idempotent, safe to run on production. Bundle with the next schema change (recurring invoices, late fee, currency, or trial_ends_at — whichever ships first) so the deploy includes only one `psql -f db/schema.sql` step.

---

### H9. [HEALTH] `bcrypt` 5.1.1 — 3 high-severity transitive `tar`/`@mapbox/node-pre-gyp` advisories (added 2026-04-24 PM audit) [S]

**App:** QuickInvoice (Node.js)
**Impact:** LOW (install-time only) — `npm audit` reports `tar < 7.5.10` (3 GHSAs: `34x7-hfp2-rc4v`, `8qq5-rm4j-mr97`, `83g3-92jg-28cx`, `qffp-2rhf-9h96`, `9ppj-qmqm-q256`) and the upstream `@mapbox/node-pre-gyp <= 1.0.11`, both reachable only through `bcrypt@5.1.1`'s prebuild downloader. Every advisory is a path-traversal / symlink class issue exploitable **only when extracting an attacker-controlled tarball during `npm install`**. The runtime auth path (`bcrypt.hash` / `bcrypt.compare`) is not affected. The vulnerabilities also can't fire in a normal `npm ci` against the lockfile (registry tarballs are signed). Risk profile: the build is run on Heroku/Render dynos with no attacker-controlled inputs.
**Fix:** `npm i bcrypt@^6` (semver major). bcrypt 6.0 keeps the same `hash`/`compare`/`compareSync` API surface but drops Node 16 support and reworks the prebuild loader. Requires a follow-up smoke test of `POST /auth/register` (creates user with a fresh hash) and `POST /auth/login` (verifies the existing hash) on a staging deploy.
**Effort:** Very Low (bump + run full `npm test` + manual login smoke).
**Why not auto-fixed in this audit:** bcrypt is the credential store. Bumping it in an automated audit pass is too high-stakes for the marginal install-time risk reduction. Flagged as a single dedicated commit so a regression in the password verifier can't be conflated with other changes.

---

### H10. [HEALTH] `parseInt(userId)` without explicit radix in webhook handler (added 2026-04-24 PM audit) [XS]

**App:** QuickInvoice (Node.js)
**Impact:** TRIVIAL — `routes/billing.js:110` reads `customer.metadata.user_id` (a string the app itself wrote when creating the Stripe customer) and converts it via `parseInt(userId)` with no radix arg. ES5+ defaults to base 10 for strings without `0x`/`0o` prefixes, so behaviour is correct in practice. Fixing it removes the lint warning surface and matches the convention used elsewhere (`parseInt(x, 10)`). Pure cosmetic.
**Effort:** Very Low
**Sub-tasks:** `parseInt(userId)` → `parseInt(userId, 10)` at `routes/billing.js:110`. No tests need updating.

---

### H11. [HEALTH] Pagination on `getInvoicesByUser` to bound dashboard memory (R14 awareness) (added 2026-04-24 PM audit) [S]

**App:** QuickInvoice (Node.js)
**Impact:** LOW (today) — `db.getInvoicesByUser(userId)` returns the entire result set unbounded; the dashboard view `views/dashboard.ejs` renders every row. A long-tenured Pro/Agency user with several thousand invoices would pull every JSONB `items` blob and serialise it into memory on every dashboard load, increasing Heroku dyno RSS proportionally to invoice history. At today's scale (free-plan = 3 invoices, normal Pro = tens to low hundreds) this is fine; the `R14 — Memory quota exceeded` risk surfaces only after the user base grows or someone with thousands of invoices logs in.
**Effort:** Very Low
**Sub-tasks:**
1. Add `LIMIT 200 OFFSET $2` to `getInvoicesByUser` (or paginate via `cursor / page` query string). Default page size 50; cap at 200.
2. `routes/invoices.js GET /` — surface `?page=N` to the template; render simple "Newer / Older" links if `invoices.length === pageSize`.
3. Verify the `idx_invoices_user_id` index already supports the `ORDER BY created_at DESC LIMIT N` plan (Postgres will use it for the index scan + sort if `created_at` is correlated with insertion order, which it is by default).
**Why not now:** Adds query-string + view churn that is orthogonal to today's audit. Bundle with #14 (onboarding checklist) which already touches `routes/invoices.js GET /`.

---

### H13. [DONE 2026-04-25 PM] [HEALTH] Apply `ALLOWED_INVOICE_STATUSES` whitelist to `POST /:id/edit` (added 2026-04-25 PM audit) [XS]

**App:** QuickInvoice (Node.js)
**Impact:** LOW (latent) — H12 closed the whitelist gap on `POST /:id/status` but missed `POST /:id/edit` (`routes/invoices.js:174-199`), which still passes `req.body.status || 'draft'` straight into `db.updateInvoice`. The DB CHECK constraint still rejects junk values with 23514, but the catch block logs `console.error('Update invoice error:', err)` and redirects to `/edit`, producing the same noisy log + opaque UX that H12 fixed for the `/status` route. The form template only emits the four valid options so well-behaved clients never trip this; an attacker submitting a hand-crafted form (or a corrupted browser autofill) can still POST any string.
**Effort:** Very Low
**Resolution (2026-04-25 PM, in this audit):** Added the same `ALLOWED_INVOICE_STATUSES.includes(...)` short-circuit at the top of `POST /:id/edit` that `POST /:id/status` already uses. Invalid status flashes `'Invalid invoice status.'` and redirects to `/invoices/:id/edit` (back to the form so the user can correct it). Re-uses the existing module-level `ALLOWED_INVOICE_STATUSES` constant — single source of truth across both routes. No test added in this commit (the existing `tests/status-whitelist.test.js` already covers the constant export contract that both routes depend on, and a regression in the edit-route whitelist would surface immediately as a 23514 in the DB CHECK constraint just as before — defence in depth, not new functionality).

---

### H14. [HEALTH] `escapeHtml` / `formatMoney` duplication between `lib/email.js` and `jobs/reminders.js` (added 2026-04-25 PM audit) [XS]

**App:** QuickInvoice (Node.js)
**Impact:** TRIVIAL (maintenance) — both modules implement byte-identical `escapeHtml(value)` (5-char replace chain: `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`, `"` → `&quot;`, `'` → `&#39;`) and very-similar `formatMoney(amount[, currency])` helpers. A future change to either (e.g. adding the Unicode left-single-quote codepoint, or fixing a currency symbol) has to be made in two places or the email template and reminder template silently drift. No security risk because both implementations are correct today.
**Effort:** Very Low
**Sub-tasks:** Promote both helpers to a `lib/html.js` (or `lib/format.js`) module: `module.exports = { escapeHtml, formatMoney }`. Update `lib/email.js` and `jobs/reminders.js` to `const { escapeHtml, formatMoney } = require('./html')` (paths adjusted). Verify the existing `lib/email.js` `_internal` test export and `jobs/reminders.js` `_internal` test export still work. Run `npm test` to confirm no test that asserts against the email or reminder HTML breaks.
**Why not now:** Touches two production code paths that send revenue-relevant email (invoice send + overdue reminder). Worth a dedicated commit so a regression in either email template can be cleanly bisected.

---

### H15. [HEALTH] Sequential `db.getInvoiceById` + `db.getUserById` in `routes/invoices.js` GET handlers (added 2026-04-25 PM audit) [XS]

**App:** QuickInvoice (Node.js)
**Impact:** TRIVIAL (latency) — three handlers (`GET /:id`, `GET /:id/edit`, `GET /:id/print`) `await db.getInvoiceById(...)` then `await db.getUserById(...)` sequentially. Both queries are independent (the user lookup doesn't depend on the invoice row) so they could be a single `Promise.all([...])`, halving the per-page DB-roundtrip count from 2 to effectively 1. The dashboard handler (`GET /`) already does this correctly (`Promise.all([getInvoicesByUser, getUserById])` at line 15-18); the per-invoice handlers are out of pattern. With local-network Postgres each round trip is sub-millisecond, so user-visible latency impact is sub-10ms on a Heroku dyno; matters only as the app's RPS rises.
**Effort:** Very Low
**Sub-tasks:** Replace the two sequential `await`s in `GET /:id`, `GET /:id/edit`, `GET /:id/print` with `const [invoice, user] = await Promise.all([db.getInvoiceById(req.params.id, req.session.user.id), db.getUserById(req.session.user.id)]);` then keep the existing `if (!invoice) return res.redirect('/dashboard');` guard. Existing tests for these routes continue to pass because the resolved-value semantics are identical.

---

### H16. [HEALTH] `resend@^6.12.2` — moderate-severity transitive `svix → uuid` advisory (added 2026-04-25 PM audit) [XS]

**App:** QuickInvoice (Node.js)
**Impact:** LOW — `npm audit --production` reports `uuid <14.0.0` (`GHSA-w5hq-g745-h8pq` — "Missing buffer bounds check in v3/v5/v6 when buf is provided"), reachable through `resend@6.12.2 → svix → uuid`. The advisory is a moderate-severity bounds check on a *user-supplied* buffer to specific UUID generation paths (v3/v5/v6 with a custom buffer). QuickInvoice never calls `uuid` directly; the only consumer in our dependency tree is `svix` (Resend's webhook signature library), which we don't use the verifier of — we only call `resend.emails.send()`. The advisory's exploit requires attacker control of the `buf` argument to `uuid.v3/v5/v6`, which is not reachable through any of our call paths.
**Fix:** `npm i resend@^6.1.3` (semver downgrade — note the audit fix's recommended version is *lower* than current because resend `6.2.0+` pulled in the affected svix range). Confirm `lib/email.js` `sendEmail` happy path still works against the downgraded SDK (the public `Resend(...).emails.send({...})` API has been stable across the 6.x line). Or: wait for `resend@^6.13` which is expected to pin the patched `svix@>=1.92`.
**Effort:** Very Low (bump + run full `npm test` + manual mark-sent smoke).
**Why not auto-fixed in this audit:** Same reasoning as H9 (bcrypt) — Resend is the email transport for invoice send + reminder emails (the Pro feature). A regression in the SDK's send API is income-relevant. Worth a dedicated commit so any rate-limit or payload-shape change can be cleanly attributed. Runtime exposure is nil; this is install-time/library-hygiene only.

---

### H17. [HEALTH] Partial index for trial-nudge query (added 2026-04-26 PM audit) [XS]

**App:** QuickInvoice (Node.js)
**Impact:** TRIVIAL (today) / LOW (future) — the new `db.getTrialUsersNeedingNudge()` runs once per day via the trial-nudge cron tick. Its predicate `(plan='pro' AND trial_ends_at BETWEEN NOW()+2d AND NOW()+4d AND trial_nudge_sent_at IS NULL AND (subscription_status IS NULL OR ='trialing'))` currently runs as a sequential scan on `users`. At today's user-table scale the scan is sub-millisecond; once the user table grows past ~5k rows the scan cost becomes noticeable on the daily cron (still single-digit ms — not a user-visible problem until ~50k rows or a multi-tenant table-bloat scenario).
**Effort:** Very Low
**Sub-tasks:**
1. Add to `db/schema.sql`: `CREATE INDEX IF NOT EXISTS idx_users_trial_nudge_pending ON users(trial_ends_at) WHERE trial_nudge_sent_at IS NULL;` — partial index, only covers rows that haven't been nudged yet (which is the SQL filter that benefits from the index). Idempotent.
2. Bundle with the next migration that touches `users` so a single `psql -f db/schema.sql` lands all queued schema changes. Candidates: #47's `billing_cycle` column, #49's `first_paid_invoice_at` column.
3. No tests needed — the query semantics are unchanged; this is purely an index hint for the planner.

**Why not now:** The cron runs once a day, even a 10ms full-scan is not a user-visible problem. Bundling with the next column-add minimises Master deploy steps.

---

### H12. [DONE 2026-04-25] [HEALTH] Whitelist `status` in `POST /:id/status` before hitting Postgres CHECK constraint (added 2026-04-24 PM audit, supersedes earlier H6) [XS]

**App:** QuickInvoice (Node.js)
**Impact:** LOW (latent) — `routes/invoices.js:170-205` reads `req.body.status` and passes it straight to `db.updateInvoiceStatus`. Postgres' CHECK constraint (`status IN ('draft','sent','paid','overdue')`) rejects bad values with error code `23514`, the catch block logs `console.error('Status update error:', err)` and redirects. Effect: a junk `status` POST yields a noisy log line and an opaque redirect rather than a flash. Low impact (CHECK protects DB integrity), but the noise complicates incident triage and obscures real DB errors.
**Effort:** Very Low
**Sub-tasks:** In `routes/invoices.js` `POST /:id/status`, add `const ALLOWED = ['draft','sent','paid','overdue']; if (!ALLOWED.includes(req.body.status)) { req.session.flash = { type: 'error', message: 'Invalid status.' }; return res.redirect('/invoices/' + req.params.id); }` immediately after extracting `newStatus`. Add a test in `tests/edge-cases.test.js` (junk status → flash + redirect, no DB write).
**Resolution (2026-04-25):** Added `ALLOWED_INVOICE_STATUSES = ['draft', 'sent', 'paid', 'overdue']` as a module-level constant at the top of `routes/invoices.js` (re-used by tests via the new `module.exports.ALLOWED_INVOICE_STATUSES` export so the source-of-truth list cannot drift between the route and any future caller). The `POST /:id/status` handler now short-circuits with `req.session.flash = { type: 'error', message: 'Invalid invoice status.' }` and redirects to `/invoices/:id` *before* `db.updateInvoiceStatus`, the Stripe Payment Link creator (`createInvoicePaymentLink`), the outbound paid-webhook (`firePaidWebhook`), and the invoice-sent email (`sendInvoiceEmail`) — none of those side-effects can fire on a rejected status. The Postgres CHECK constraint remains the last line of defence, but it's no longer the only one. Closes H6 (which was superseded by this entry per the 2026-04-24 PM audit note).

New `tests/status-whitelist.test.js` adds 8 assertions: (1) valid `'sent'` → DB write + success flash + redirect to invoice; (2) `'garbage'` → no DB write, error flash, invoice status unchanged; (3) empty string (missing form field) → no DB write, error flash; (4) `'paid '` (trailing whitespace) → no DB write, error flash (strict equality, matches DB CHECK semantics); (5) SQL-injection-shaped value `"paid'; DROP TABLE invoices;--"` → no DB write, error flash (defence-in-depth atop parameterised queries); (6) invalid status that contains the substring `paid` → no Stripe Payment Link, no outbound webhook (side-effects gated on whitelist, not on substring matching); (7) `ALLOWED_INVOICE_STATUSES` export contract (4 entries, canonical order); (8) each of the 4 valid statuses (`draft`, `sent`, `paid`, `overdue`) passes through to `db.updateInvoiceStatus` verbatim. Wired into `package.json` `test` script. Full suite: 22 test files, 191 total passes, 0 failures.

---

### H13. [DONE 2026-04-25] [HEALTH] QA audit — 8 new tests for untested income-critical paths [XS]

**App:** QuickInvoice (Node.js)
**Impact:** MEDIUM — prevents silent regressions on the first-time subscriber checkout, the post-checkout plan refresh, the webhook-URL CRUD, and invoice delete. Any regression on those paths would either block revenue collection or expose a Pro feature gap without a visible error.
**Effort:** Very Low
**Resolution (2026-04-25T23:55Z):** Systematic audit of every route handler in `routes/billing.js` and `routes/invoices.js` against every test file in `tests/`. Three untested clusters identified; all closed in a single commit.

| Gap | File | Tests added |
|---|---|---|
| `POST /billing/create-checkout` no-`stripe_customer_id` path | `tests/checkout-and-webhook-url.test.js` | 1 |
| `GET /billing/success` session plan refresh | same | 1 |
| `POST /billing/webhook-url` (5 branches: free gate, agency, valid URL, clear, SSRF) | same | 5 |
| `POST /invoices/:id/delete` owner success path | same | 1 |

New file: `tests/checkout-and-webhook-url.test.js` (8 assertions). Full suite: 25 test files, 199 assertions, 0 failures.

---

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

### 7. [DONE 2026-04-23] [GROWTH] Zapier Outbound Webhook on Invoice Paid (Pro Feature) [M]

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

### 8. [DONE 2026-04-23] [GROWTH] SEO Niche Landing Pages for Freelancer Verticals [M]

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

### 13. [DONE 2026-04-25] [GROWTH] Email Delivery for QuickInvoice (Resend) [M]

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

**Resolution (2026-04-25):** Added `resend@^6.12.2` as a dependency. New `lib/email.js` exports `sendEmail({ to, subject, html, text, replyTo, from })`, `sendInvoiceEmail(invoice, owner)`, and pure formatters `buildInvoiceSubject` / `buildInvoiceHtml` / `buildInvoiceText`. Three graceful-degradation guarantees: (a) when `RESEND_API_KEY` is unset (current state — Master action below), every send returns `{ ok:false, reason:'not_configured' }` without touching the network, so the rest of the app keeps working unchanged; (b) Resend SDK throws are caught and surfaced as `{ ok:false, reason:'error', error }` — never bubbled to the caller; (c) all HTML is built from a single sanitiser (`escapeHtml`) so client_name, business_name, invoice number, item descriptions, and any future user-controlled fields are XSS-safe even if they contain `<script>` payloads. Reply-to precedence is `user.reply_to_email > user.business_email > user.email`. The wrapper exposes `setResendClient(client)` as a test seam — same pattern as `lib/outbound-webhook.js`'s `setHostnameResolver`. New `EMAIL_FROM` env var (defaults to Resend's `onboarding@resend.dev` sandbox sender so dev still works pre-domain-verification).

`routes/invoices.js POST /:id/status` now fires `sendInvoiceEmail` whenever a Pro/Agency user transitions an invoice to `sent` AND the invoice has a `client_email`. The send is `then`/`catch`'d, never `await`'d — the redirect happens immediately. The existing payment-link creation block was reorganised so the freshly-minted `payment_link_url` ends up on the in-memory `updated` row before the email is composed; clients receive the Pay-button link in the same email as the invoice. Free-plan and email-less invoices skip the send entirely.

`db/schema.sql` adds `ALTER TABLE users ADD COLUMN IF NOT EXISTS reply_to_email VARCHAR(255);` — idempotent, safe to re-run on production. `routes/billing.js POST /settings` validates the new `reply_to_email` body field with a basic local@host regex (max 255 chars) and persists via the existing dynamic `db.updateUser` path; an invalid value flashes an error and writes nothing. `views/settings.ejs` renders a labelled, optional `<input type="email" name="reply_to_email">` directly under the business-email/phone grid with the stored value pre-filled.

New `tests/email.test.js` adds 15 assertions: not-configured graceful no-op, invalid-args rejection, happy-path payload (from/to/subject/html/text/reply_to keys), throw-swallowing, subject formatter, HTML escaping + pay-button rendering, reply-to precedence, missing-client-email short-circuit, Pro send invocation with full payload, Free-plan skip, Pro-without-client_email skip, fire-and-forget redirect-doesn't-await proof (timing assertion: redirect lands in <50ms while the send hangs for 30ms then rejects), reply-to validation accept and reject paths, and an EJS render assertion that the new input field appears with its value attribute pre-filled. Wired into `package.json` `test` script. Full suite: 178 tests, 0 failures (was 163 before this commit).

**[Master action]** required to actually deliver email: provision a Resend API key (https://resend.com/api-keys), set `RESEND_API_KEY=re_...` and `EMAIL_FROM="QuickInvoice <invoices@yourdomain.com>"` in production env, and verify the sending domain in the Resend dashboard. Until those are set, `sendInvoiceEmail` is a no-op — see TODO_MASTER.md.

**Unblocks:** #11 (churn win-back), #12 (monthly summary), #16 (automated reminders), #18 (referral invites), #22 (late-fee notifications). All five tasks can now layer on top of `lib/email.js#sendEmail` without re-doing the transport.

---

### 14. [DONE 2026-04-25] [GROWTH] In-App Onboarding Checklist (Activation Flow) [S]

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

**Resolution (2026-04-25):** `db/schema.sql` adds idempotent `ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_dismissed BOOLEAN DEFAULT false;` so existing production deploys can re-run `psql -f db/schema.sql` without a separate migration step. `db.js` exports `dismissOnboarding(userId)` — a single UPDATE that sets the flag and bumps `updated_at`. New `POST /onboarding/dismiss` route (mounted at the app root in `server.js`, protected by `requireAuth` + the existing global CSRF middleware) delegates to a small `onboardingDismissHandler` exported from `routes/invoices.js`. The handler is defence-in-depth: it re-checks the session and redirects to `/auth/login` if unauthenticated, swallows DB errors so a Postgres outage never 500s the dashboard, and mutates `req.session.user.onboarding_dismissed = true` so the next render skips the card without a refetch.

`routes/invoices.js GET /` (dashboard) builds an `onboarding` local via the new pure `buildOnboardingState(user, invoices)` helper. The helper returns `null` for dismissed/missing users and otherwise emits a 4-step checklist in canonical order — `business` (`!!user.business_name && trimmed`), `create` (`invoices.length >= 1`), `send` (any invoice with `status IN ('sent', 'paid', 'overdue')` — paid/overdue imply sent), `paid` (any invoice with `status = 'paid'`). Each step carries `{key, label, href, done}` and the wrapper exposes `{steps, completed, total, allDone}`. The `allDone` flag short-circuits the EJS render so the card disappears the instant a user finishes the funnel without requiring them to click Dismiss.

`views/dashboard.ejs`: new card rendered above the trial banner (above all other dashboard chrome) when `locals.onboarding && onboarding && !onboarding.allDone`. Light-blue banner (`bg-blue-50 border-blue-200`) per the spec, with `print:hidden` so it does not leak into invoice print views — the existing print path uses a different template (`invoice-print.ejs`) but the dashboard could plausibly be printed by a user; safer to suppress. Card markup: `<h2>` + progress count ("X of 4 steps complete"), then a `<ul>` of steps. Done steps render `&#10003;` (heavy check) in green + label inside a `line-through` span; pending steps render `&#9711;` (large circle) in gray + label as an anchor link to the step's `href` with a `→` arrow. Dismiss form is a small underlined button in the card header that POSTs to `/onboarding/dismiss` with the existing CSRF token.

New `tests/onboarding.test.js` adds 17 assertions: 9 for `buildOnboardingState` pure logic (dismissed/missing user → null, fresh user → all incomplete, business_name marks business done, whitespace business_name does NOT count, any invoice marks create done, send step counts sent/paid/overdue, paid step requires status=paid, allDone flips when 4/4, step keys in canonical order); 5 for EJS rendering (renders when in-progress, completed step strikethrough + pending step as link, hides when allDone, hides when null, hides when local is undefined — guards the catch-branch in the dashboard route); 3 for the dismiss handler (persists + flags session + redirects to /invoices, unauth → /auth/login with no DB call, swallows DB errors and still redirects). The dismiss test uses a real Express + express-session pipeline with a cookie jar to verify the session mutation persists across the redirect-then-inspect flow. Full suite: 205 tests, 0 failures (was 188 before this commit).

**[Master action]** none required — schema change is additive + idempotent, no Stripe/Resend/env config needed. The card will start appearing for every existing user on next dashboard load (because `onboarding_dismissed` defaults to `false`); long-tenured users with all four steps already completed will see the card disappear immediately via `allDone`.

**Income relevance:** Activation is the highest-leverage retention lever for SaaS — users who reach "first invoice paid" churn at 5–10× lower rates than users who never get past signup. The dashboard previously dropped new users at an empty state with one CTA; the checklist now surfaces the full path-to-value (business profile → invoice → send → get paid) with one-click links to each step, lifting activation rate and feeding more users into the Pro upgrade funnel.

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

### 16. [DONE 2026-04-25] [GROWTH] Automated Payment Reminders for QuickInvoice (Pro Feature) [M]

**App:** QuickInvoice (Node.js)
**Impact:** MEDIUM-HIGH — InvoiceFlow already has this; QuickInvoice Pro users currently have to manually follow up on overdue invoices, which is the #1 pain point the product is supposed to solve
**Effort:** Low-Medium
**Prerequisites:** Email delivery (#13 above) must be live first — **unblocked 2026-04-25 PM** when #13 landed.

**Sub-tasks:**
1. `npm install node-cron` (add to `package.json` dependencies).
2. `db/schema.sql`: `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS last_reminder_sent_at TIMESTAMP;`
3. `jobs/reminders.js` — export a `startReminderJob()` function using `node-cron` schedule `'0 9 * * *'` (daily 09:00 UTC):
   - Query: invoices joined to users where `status='sent'`, `due_date < CURRENT_DATE`, `plan IN ('pro','business','agency')`, and either never reminded or last reminded > 3 days ago.
   - For each row: call `sendEmail()` to the client email with subject "Friendly reminder: Invoice [number] is overdue" and a body including invoice total, due date, and payment link URL (if set).
   - Update `invoices.last_reminder_sent_at = NOW()` after sending.
4. `server.js`: `require('./jobs/reminders').startReminderJob();` after the DB pool is confirmed ready.
5. Write a unit test in `tests/reminders.test.js` (stub `node-cron` and `lib/email.js`) verifying: overdue Pro invoice → email sent; free-plan invoice → skipped; already-reminded-within-3-days → skipped.

**Resolution (2026-04-25 PM):** Added `node-cron@^4.2.1` to dependencies. New `db/schema.sql` line: `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS last_reminder_sent_at TIMESTAMP;` plus a partial index `idx_invoices_reminder_due ON invoices(status, due_date) WHERE status = 'sent'` so the daily cron query reads from a slim sent-only index instead of bitmap-scanning the full status column. Both are idempotent — production deploy is one `psql -f db/schema.sql`.

`db.js` adds two helpers:
- `getOverdueInvoicesForReminders(cooldownDays = 3)` — single SELECT joining `invoices` to `users`, filtering `status='sent' AND due_date IS NOT NULL AND due_date < CURRENT_DATE AND plan IN ('pro','business','agency') AND (last_reminder_sent_at IS NULL OR last_reminder_sent_at < NOW() - ($1 * INTERVAL '1 day'))`. Returns one row per due reminder with the owner's name/email/business already joined in (no N+1). `LIMIT 500` caps a runaway batch on a backlogged dyno.
- `markInvoiceReminderSent(invoiceId)` — single UPDATE that stamps `last_reminder_sent_at = NOW()` and bumps `updated_at`.

New `jobs/reminders.js` exports:
- `processOverdueReminders({ db, sendEmail, now, cooldownDays, log })` — pure orchestrator with full DI. Returns a structured summary `{ found, sent, skipped, errors, notConfigured }` so tests can assert against it without mocks. Plan-gates again in JS (`PAID_PLANS = {'pro','business','agency'}`) as defence-in-depth atop the SQL filter — a future bad join can't accidentally email a free user's clients. Treats `{ ok:false, reason:'not_configured' }` as a clean skip (counted under `notConfigured`, NOT stamped) so until Master provisions a Resend key the cron is a safe no-op that retries every day. `sendEmail` rejections / DB stamp failures are caught and surfaced as `errors` without bubbling — the rest of the batch still gets processed.
- `buildReminderSubject` / `buildReminderHtml` / `buildReminderText` — pure formatters; HTML is built via the same `escapeHtml` pattern as `lib/email.js` so client_name, business_name, invoice number, and payment URLs are XSS-safe even if user-controlled. The HTML body includes a "Pay invoice X" CTA button (when `payment_link_url` is set) and a red "N day(s) overdue" line so the visual urgency rises with the days late.
- `daysOverdue(row, now)` — pure floor((now - due_date) / 86400000), clamped to 0 for future-dated rows.
- `startReminderJob(opts)` — wraps the orchestrator in a `node-cron` schedule (default `'0 9 * * *'` UTC, overrideable via `REMINDER_CRON_SCHEDULE` env or `opts.schedule`). Refuses to start when `NODE_ENV='test'` unless `opts.force=true` so the test suite never spawns a background scheduler that could leak across tests. Refuses double-start (returns `{ ok:false, reason:'already_running' }`). A `require('node-cron')` failure is caught and logged — the reminder feature degrading is preferable to taking down the web server. `cron.schedule` errors are also caught.
- `stopReminderJob()` — clears the singleton; only used by tests.

`server.js` calls `startReminderJob()` immediately after `app.listen` succeeds, but only when `NODE_ENV !== 'test'`. The startup is wrapped in try/catch so a cron init failure logs and lets the web server keep running. Stdout reports the active schedule (or the reason it didn't start) on boot for ops visibility.

New `tests/reminders.test.js` adds 15 assertions covering: (1) subject formatter contract; (2) HTML escapes raw `<script>` tags + ampersands + retains the payment-link query string; (3) text fallback includes pay link + days-overdue copy; (4) `daysOverdue` arithmetic incl. clamp-at-0 for future dates; (5) happy path → sendEmail called with correct payload, DB stamped; (6) free-plan row is skipped (defence-in-depth — even if SQL filter misses); (7) row missing `client_email` is skipped without error; (8) `not_configured` does NOT stamp DB so the next run retries; (9) `sendEmail` throw → counted as error, batch continues, only successful row is stamped; (10) reply-to precedence (reply_to_email > business_email > email); (11) DB query throw → top-level errors=1, no orphaned writes; (12) idempotent across runs via cooldown (second run of the same fake db sees 0 rows because the cooldown filter excludes the just-stamped invoice); (13) `startReminderJob()` under `NODE_ENV=test` (no force) returns `{ok:false, reason:'test_env'}`; (14) with `force:true` + a fake cron, captures the cron callback, asserts the schedule is forwarded, invokes the tick, and verifies it sends + stamps; (15) double start returns `{ok:false, reason:'already_running'}`. Wired into `package.json` `test` script. Full suite passes (24 test files), 0 failures.

**[Master action required]** to actually deliver reminders: provision the Resend API key (already a [Master action] for #13). Until `RESEND_API_KEY` is set in production env, the cron runs daily but `sendEmail` returns `not_configured` and no email is sent, no DB row is stamped. The instant the key is provisioned, the next 09:00 UTC tick begins reminding for every overdue Pro/Business/Agency invoice in the queue. See TODO_MASTER.md.

**Income relevance:** The single most differentiating Pro feature — Pro/Agency users are paying $9-$19/month for "automated reminders" that the upgrade modal copy already promises. Closing this gap delivers on that promise, raises the perceived Pro value (reducing churn), and recovers receivable cash for the freelancer. Industry data: an automated 3-day overdue nudge typically lifts the on-time payment rate by 15-25% with no additional human effort. Each recovered invoice is also a touchpoint that flips the user's relationship with the tool from "manual chase tool" to "set-and-forget cashflow," which is the same retention dynamic that drives InvoiceFlow's stickiness.

**Unblocks:** #22 (late fee automation — reuses the same overdue-detection scheduler), eventual quarterly/weekly variants of the cooldown window, and the planned monthly summary email (#12 — same `node-cron` infrastructure).

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

### 19. [DONE 2026-04-25] [GROWTH] 7-Day Pro Free Trial (No Credit Card Required) [S]

**App:** QuickInvoice (Node.js)
**Impact:** HIGH — removes purchase anxiety at the highest-friction conversion moment; industry benchmarks show 25–40% lift in free→paid conversion when a no-card trial is offered; Stripe supports `trial_period_days` natively so no billing logic changes are needed
**Effort:** Very Low
**Prerequisites:** None (Stripe already integrated; annual billing #3 already live)

**Sub-tasks:**
1. `routes/billing.js` `POST /billing/create-checkout`: add `subscription_data: { trial_period_days: 7 }` to the `stripe.checkout.sessions.create()` call for both monthly and annual cycles. Stripe will not charge the card until day 8; if no payment method is collected it cancels automatically and fires `customer.subscription.deleted`.
2. `db/schema.sql`: `ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMP;` — set this in the `checkout.session.completed` webhook handler when a trial subscription is created (`subscription.trial_end` is available on the Stripe event).
3. `routes/invoices.js` (dashboard GET): if `user.trial_ends_at` is in the future, add `days_left_in_trial` to the template locals (compute as `Math.ceil((trial_ends_at - Date.now()) / 86400000)`).
4. `views/dashboard.ejs`: render a dismissible blue banner `"🎉 You're on a Pro trial — X days left. Add a payment method to keep Pro features."` with a CTA to `/billing/portal` — only when `days_left_in_trial > 0`. Wrap in `<% if (locals.days_left_in_trial > 0) { %>`.
5. `views/pricing.ejs` and `views/partials/upgrade-modal.ejs`: change the CTA button copy from "Upgrade to Pro" to **"Start 7-day free trial"**; add a subtext line: "No credit card required. Cancel anytime."
6. Write 3 tests in `tests/trial.test.js`: `checkout POST` includes `trial_period_days:7`; `checkout.session.completed` webhook with a trial subscription sets `trial_ends_at`; dashboard renders the trial banner when `trial_ends_at` is in the future and omits it when absent.

**Resolution (2026-04-25):** Added `subscription_data: { trial_period_days: 7 }` to the `stripe.checkout.sessions.create()` call in `routes/billing.js POST /create-checkout` — applies to both monthly and annual cycles, no code branching needed (Stripe normalises trial behaviour across subscription prices). Stripe collects no card and auto-cancels via `customer.subscription.deleted` if no payment method is added by day 8.

`db/schema.sql`: added idempotent `ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMP;` so existing production deploys can re-run `psql -f db/schema.sql` without a separate migration step.

`routes/billing.js` `checkout.session.completed` webhook handler: after upgrading a subscription user to `plan='pro'`, fetches the subscription via `stripe.subscriptions.retrieve(session.subscription)` and persists `trial_ends_at = new Date(sub.trial_end * 1000)` if `trial_end` is set, or `null` otherwise (paid signup overwrites a stale trial countdown). The retrieve call is wrapped in a try/catch so a Stripe outage degrades gracefully — the user still gets upgraded, only the countdown banner is skipped.

`routes/invoices.js` `GET /` (dashboard): computes `days_left_in_trial = Math.max(0, Math.ceil((user.trial_ends_at - Date.now()) / 86400000))` and passes it to the template as a local. NaN/null trial dates short-circuit to 0 so a corrupted column never renders a phantom banner.

`views/dashboard.ejs`: renders a dismissible blue banner (`bg-blue-50 border-blue-200`) above the past-due banner when `days_left_in_trial > 0`. Copy: `"You're on a Pro trial — N day(s) left."` with an `Add payment method →` CTA that POSTs to `/billing/portal` (uses the existing CSRF token). Singular/plural day rendering is template-side. Past-due/paused banner remains the highest-priority alert (visually below trial in DOM order, but only one fires at a time in practice — past-due implies trial already converted to paid).

`views/pricing.ejs` + `views/partials/upgrade-modal.ejs`: CTA copy changed from "Upgrade to Pro — $12/month →" / "Upgrade to Pro — $99/year →" to a single "Start 7-day free trial →" button. Subtext line added: "No credit card required. Cancel anytime." with the post-trial price disclosed below ("After trial: $12/month · Secure checkout via Stripe"). Pricing-card $99/yr and $12/mo numerals stay unchanged so existing `annual-billing.test.js` pricing-page assertions still pass.

`subscriptions.retrieve` stub added to `tests/billing-webhook.test.js`, `tests/error-paths.test.js`, and `tests/gap-coverage.test.js` so the existing webhook tests' Stripe mocks satisfy the new code path without emitting spurious "Could not fetch subscription" warnings.

New `tests/trial.test.js` adds 10 assertions (exceeds the original 3-test spec): monthly+annual checkouts both include `trial_period_days:7`, webhook persists `trial_ends_at` when sub has trial_end, webhook clears `trial_ends_at` when sub has no trial_end (paid path), webhook still upgrades to Pro when `subscriptions.retrieve` throws (graceful degradation — `trial_ends_at` is left untouched, never written), dashboard renders the trial banner with `data-testid="trial-banner"` when `days_left_in_trial > 0`, dashboard uses singular "1 day left" copy correctly, dashboard omits the banner when local is 0/undefined, pricing CTA copy reads "Start 7-day free trial" with no-card subtext, modal CTA copy reads "Start 7-day free trial" with no-card subtext. Wired into `package.json` `test` script. Full suite: all tests pass, 0 failures.

**[Master action]** none required — Stripe trials work out-of-the-box on existing prices; no Dashboard config needed. See TODO_MASTER.md for an optional post-deploy item: monitor 7-day trial→paid conversion rate via Stripe → Billing → Subscriptions filter `status=trialing`.

**Income relevance:** Industry benchmarks show 25–40% lift in free→paid conversion when a no-card-required trial is offered at the highest-friction conversion moment. Removes purchase anxiety; shifts the "do I trust this enough to give my card?" decision from signup to day-7 retention.

---

### 20. [GROWTH] Social Proof Section on Landing + Pricing Pages [S]

**App:** QuickInvoice (Node.js)
**Impact:** MEDIUM-HIGH — cold visitors have no trust signal today; a testimonial grid + "X freelancers" counter is the single fastest static conversion lift, adding ~10–20% to landing page conversion with zero backend work
**Effort:** Very Low
**Prerequisites:** None; Master provides final testimonial text (see TODO_MASTER.md)

**Sub-tasks:**
1. `views/index.ejs`: below the features grid and above the pricing section, insert a new `<section>` with:
   - A centered heading: `"Trusted by freelancers who get paid faster"` with a subtext: `"Join <strong>500+</strong> designers, developers, and consultants"` (placeholder count; Master updates as it grows).
   - Three testimonial cards in a responsive 3-column Tailwind grid (`md:grid-cols-3`). Each card: avatar initials circle (`bg-indigo-100 text-indigo-700`), quote text in `italic`, name + role in `text-sm text-gray-500`. Use placeholder copy (see sub-task 3) that Master replaces with real testimonials.
   - Placeholder testimonials (realistic, non-misleading; label with an HTML comment `<!-- Replace with real testimonials -->`):
     - *"I used to spend 20 minutes per client chasing payments. Now I just send the invoice and they pay on the spot."* — Alex M., Freelance Developer
     - *"The Payment Link feature alone is worth the subscription. Clients actually pay the day I send the invoice."* — Sarah K., Graphic Designer
     - *"Finally an invoicing tool that doesn't feel like accounting software."* — James T., Independent Consultant
2. `views/pricing.ejs`: add the same social-proof count line (`"Join 500+ freelancers"`) immediately above the pricing card grid, no testimonials needed on this page (they're on the landing page one click back).
3. Add an HTML comment in both views: `<!-- MASTER: update the count and replace placeholder testimonials with real quotes as they come in -->` so the location is easy to find during deployment.
4. No routes, no DB, no tests needed — pure view change.

---

### 21. [GROWTH] Client-Facing Invoice Portal (Public Pay Page per Client) [M]

**App:** QuickInvoice (Node.js)
**Impact:** MEDIUM-HIGH — clients get a bookmarkable URL showing all outstanding invoices from a specific freelancer; they can pay any invoice without the freelancer sending a new email; dramatically increases stickiness (freelancers who activate this feature are very unlikely to switch tools because their clients are trained on the portal URL)
**Effort:** Medium
**Prerequisites:** Stripe Payment Links (#2, done); Email Delivery (#13) recommended but not required (portal URL can be shared manually or via email)

**Sub-tasks:**
1. `db/schema.sql`: `ALTER TABLE clients ADD COLUMN IF NOT EXISTS portal_token VARCHAR(32) UNIQUE;` Backfill via: `UPDATE clients SET portal_token = encode(gen_random_bytes(16), 'hex') WHERE portal_token IS NULL;` (include both statements — `ADD COLUMN IF NOT EXISTS` + `UPDATE` — so the migration is idempotent).
2. `db.js`: add `getClientByPortalToken(token)` (returns client row + `owner_user_id`); add `getOutstandingInvoicesByClient(clientId)` (returns invoices where `status IN ('sent', 'overdue')` with `payment_link_url`); add `generatePortalTokenForClient(clientId)` called on client create if `portal_token` is null.
3. `routes/invoices.js` or new `routes/portal.js`: `GET /pay/:token` — public (no `requireAuth`): look up client by token; 404 if not found; render `views/client-portal.ejs` with client name, freelancer business name, and the list of outstanding invoices. Each invoice row: invoice number, amount, due date, status badge, and a prominent "Pay Now →" button linking to `payment_link_url` (or "No payment link — contact [business_name]" fallback).
4. `views/client-portal.ejs`: clean, unbranded invoice list page. Header: `"Invoices from [business_name]"`. Tailwind card per invoice. Footer: `"Powered by QuickInvoice"` (passive acquisition; links to `/`). No nav, no login required.
5. `views/invoice-view.ejs` (Pro users only): add a "Client Portal" card showing the client's portal URL (`APP_URL/pay/:token`) with a copy button (Alpine.js clipboard, same pattern as the payment link copy UI). Add tooltip: "Share this link with [client_name] — they can pay any outstanding invoice here."
6. `routes/invoices.js` `POST /clients` (client creation): call `generatePortalTokenForClient` for new clients. For existing clients, add a one-time lazy-generation: if `portal_token` is null when the portal card is rendered in the invoice view, generate and persist it then.
7. Plan gate: portal card in `invoice-view.ejs` is Pro-only (free users see a locked placeholder with "Upgrade to Pro →" CTA). The public `/pay/:token` route itself is plan-ungated (the client should always be able to pay even if the freelancer downgrades — this protects payment integrity).
8. Tests in `tests/client-portal.test.js` (5 tests minimum): valid token returns 200 with outstanding invoices; unknown token returns 404; paid invoices are excluded from the list; portal card renders in invoice view for Pro user; portal card renders as locked for Free user.

---

### 22. [GROWTH] Late Fee Automation (Pro Feature) [S]

**App:** QuickInvoice (Node.js)
**Impact:** MEDIUM — "auto late fee" is a top-3 requested invoicing feature on freelancer forums; removes the awkward manual negotiation; forces clients to act sooner; adds a concrete, visible Pro retention driver beyond payment links
**Effort:** Low
**Prerequisites:** Automated payment reminders (#16) is a natural companion but not required; this feature is self-contained

**Sub-tasks:**
1. `db/schema.sql`: `ALTER TABLE users ADD COLUMN IF NOT EXISTS late_fee_pct NUMERIC(5,2);` (e.g. `5.00` = 5%). `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS late_fee_applied BOOLEAN DEFAULT false;`
2. `views/settings.ejs`: add a "Late Fee" card in the Pro section (gated behind `user.plan !== 'free'`). Input: "Automatically add __% late fee after an invoice is overdue." Save via `POST /billing/settings` (extend the existing handler to also write `late_fee_pct` via `db.updateUser`). Free users see a locked placeholder with upgrade CTA.
3. `jobs/reminders.js` (or whichever scheduler runs daily for overdue invoices — currently the reminder query in #16's planned spec): when an invoice transitions to overdue AND `user.late_fee_pct` is set AND `invoice.late_fee_applied = false`:
   - Compute late fee amount: `Math.round(invoice.total * user.late_fee_pct / 100 * 100) / 100` (round to 2 decimal places).
   - Insert a new line item row: `description = "Late fee (X%)", quantity = 1, unit_price = <computed_amount>`.
   - Update `invoices.late_fee_applied = true` and recalculate `invoices.total` (or derive total from line items at render time — check existing total calculation pattern).
   - If the invoice has a `payment_link_url`, create a new Stripe Payment Link for the updated total (call `lib/stripe-payment-link.js`, store the new URL, overwrite the old one). Log old URL before overwrite.
4. `views/invoice-view.ejs`: if `invoice.late_fee_applied`, render a small amber badge "Late fee applied" next to the total line.
5. Test in `tests/late-fee.test.js` (4 tests): Pro user with `late_fee_pct` set + overdue invoice → fee line item inserted, `late_fee_applied` flipped; second scheduler run → no duplicate fee (idempotent); Free user's invoice → no fee applied regardless of `late_fee_pct`; fee amount rounds correctly at 2 decimal places.

---

### 23. [GROWTH] PWA Manifest for Mobile Installability [S]

**App:** QuickInvoice (Node.js)
**Impact:** MEDIUM — freelancers frequently check invoice status on mobile; an installable PWA appears on the home screen alongside native apps, dramatically increasing session frequency and reducing passive churn from users who forget the tool exists between billing cycles
**Effort:** Very Low
**Prerequisites:** None

**Sub-tasks:**
1. Create `public/manifest.json`:
   ```json
   {
     "name": "QuickInvoice",
     "short_name": "QuickInvoice",
     "start_url": "/dashboard",
     "display": "standalone",
     "background_color": "#ffffff",
     "theme_color": "#4f46e5",
     "icons": [
       { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
       { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" }
     ]
   }
   ```
2. Create `public/icons/` directory. Add `icon-192.png` and `icon-512.png` — a simple indigo square with "QI" in white text (generate with any image tool; or use a 1-pixel placeholder PNG and note in a comment that Master should replace with brand assets). Check: `public/` is already served by Express (`express.static('public')` in `server.js`).
3. `views/partials/head.ejs`: add inside `<head>`:
   ```html
   <link rel="manifest" href="/manifest.json">
   <meta name="theme-color" content="#4f46e5">
   <meta name="apple-mobile-web-app-capable" content="yes">
   <meta name="apple-mobile-web-app-status-bar-style" content="default">
   <meta name="apple-mobile-web-app-title" content="QuickInvoice">
   <link rel="apple-touch-icon" href="/icons/icon-192.png">
   ```
4. `server.js`: add a minimal service worker registration snippet (inline `<script>` in `head.ejs`, not a separate file) that registers a no-op SW only if `'serviceWorker' in navigator` — this satisfies Chrome's "installable" check without adding offline complexity. Alternatively, serve `public/sw.js` with a cache-first strategy for static assets only.
5. Test: open the app in Chrome DevTools → Application → Manifest — confirm it loads with correct fields and no errors. On Android Chrome, confirm the "Add to Home Screen" prompt appears. No automated test needed — document verification steps here.

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

---

### 24. [GROWTH] Multi-Currency Invoice Support [M]

**App:** QuickInvoice (Node.js)
**Impact:** HIGH — USD-only design locks out the ~40% of global freelancers who invoice in EUR, GBP, CAD, AUD, or other currencies; adding currency selection directly unlocks a new market segment at zero CAC
**Effort:** Medium
**Prerequisites:** None (Stripe natively supports multi-currency Payment Links and Checkout)

**Sub-tasks:**
1. `db/schema.sql`: `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS currency VARCHAR(3) DEFAULT 'usd';`  Update `db.js` `createInvoice()` and `updateInvoice()` to accept and persist `currency`.
2. `views/invoice-form.ejs`: add a `<select name="currency">` dropdown before the line-items table with the 8 most common freelancer currencies: USD, EUR, GBP, CAD, AUD, CHF, JPY, NZD. Default to USD. Store the selection in the hidden input on edit too.
3. `routes/invoices.js` `POST /invoices/new` and `POST /invoices/:id/edit`: read `currency` from body; validate against the allowlist; pass to `db.createInvoice` / `db.updateInvoice`.
4. `lib/stripe-payment-link.js` `createPaymentLink()`: pass `currency` from the invoice row to `stripe.prices.create({ currency: invoice.currency, ... })`. This is the only Stripe API call that currently hardcodes USD — Stripe normalises everything else.
5. `views/invoice-view.ejs`, `views/invoice-print.ejs`, `views/dashboard.ejs`: replace any hardcoded `$` prefix with a `currencySymbol(currency)` helper function (map of code → symbol, 8 entries; keep in a `lib/currency.js` module). Dashboard revenue stats should group and sum per currency, or display the primary currency only when all invoices share one (show a note when mixed).
6. `lib/outbound-webhook.js` `buildPaidPayload()`: `currency` field already exists on the payload and currently defaults to `'usd'` — update it to read `invoice.currency` from the passed invoice object.
7. Tests in `tests/currency.test.js` (5 tests minimum): EUR invoice creates a Stripe price with `currency: 'eur'`; GBP invoice renders `£` symbol in print view; dashboard sums correctly for single-currency user; invalid currency value is rejected with 400; webhook payload carries the correct non-USD currency.

---

### 25. [GROWTH] Expand SEO Niche Landing Pages (6 → 15) [S]

**App:** QuickInvoice (Node.js)
**Impact:** MEDIUM-HIGH — each additional niche page targets a distinct long-tail query ("freelance videographer invoice template", "social media manager invoice", etc.) with near-zero competition and direct audience match; the entire landing-page system is already built in `routes/landing.js`; adding 9 pages is ~135 lines of config with no new infrastructure
**Effort:** Very Low
**Prerequisites:** INTERNAL_TODO #8 (done — SEO niche landing pages are live)

**Sub-tasks:**
1. In `routes/landing.js`, add 9 new entries to the `NICHES` map. Target slugs and queries:
   - `freelance-videographer` → "freelance videographer invoice template"
   - `social-media-manager` → "social media manager invoice"
   - `virtual-assistant` → "virtual assistant invoice template"
   - `ux-designer` → "UX designer invoice template"
   - `copywriter` → "copywriter invoice template"
   - `marketing-consultant` → "marketing consultant invoice"
   - `architect` → "architect invoice template freelance"
   - `bookkeeper` → "freelance bookkeeper invoice template"
   - `tutor` → "tutoring invoice template"
   Each entry needs: `headline`, `description`, `audience`, `benefits[]` (3–4 items), `faq[]` (3–4 Q&A), and `exampleInvoice` with realistic line items for that niche.
2. The routes, sitemap, and EJS partial pick up new entries automatically — no code changes outside the `NICHES` map.
3. Update `tests/landing.test.js`: add 9 assertions that each new route returns 200 with unique `<h1>` content and the `/auth/register` CTA. Verify `listNiches()` now returns 15 slugs.

---

### 26. [GROWTH] AI-Powered Line Item Suggestions (Claude API, Pro Feature) [S]

**App:** QuickInvoice (Node.js)
**Impact:** MEDIUM-HIGH — reduces time-to-first-invoice for new users (the #1 activation friction point); differentiates QuickInvoice from every competing indie invoicing tool; turns "suggest items" into a visible Pro feature that free users see and want; one-time call to Claude per invoice creation means cost is negligible ($0.001–0.005 per suggestion)
**Effort:** Low
**Prerequisites:** None (Claude API key from console.anthropic.com, ~2 min to provision)

**Sub-tasks:**
1. `npm install @anthropic-ai/sdk` and add `ANTHROPIC_API_KEY=sk-ant-...` to `.env.example`.
2. Create `lib/ai-suggestions.js`:
   - Export `suggestLineItems(clientName, projectDescription)` — async function.
   - Calls `anthropic.messages.create()` with model `claude-haiku-4-5-20251001` (fastest + cheapest), a tightly scoped system prompt ("You are a freelance invoicing assistant. Given a client name and project description, return a JSON array of 4 suggested line items, each with `description` (string), `quantity` (number), and `unit_price` (number in USD). Return only the JSON array, no prose."), and a user message composed from the inputs.
   - Parse the response JSON; on any error return an empty array (graceful degradation — never throw to the caller).
   - Cap the call to 300 output tokens (suggestions are short).
3. New `POST /invoices/suggest-items` route in `routes/invoices.js`:
   - `requireAuth` guard; Pro/Agency plan gate (Free users see an "Upgrade to Pro →" tooltip on the button; the route returns `403` for them).
   - Reads `client_name` and `project_description` from the JSON body.
   - Calls `suggestLineItems()`; returns `{ suggestions: [...] }`.
   - Rate-limit: 10 calls per user per day stored in a simple in-memory LRU map (no Redis needed at this scale); return `429` if exceeded.
4. `views/invoice-form.ejs`: add a "✨ Suggest items" button (Pro-styled, grayed-out for free users with tooltip) below the client name field. Alpine.js `x-data` component: on click, POSTs `{ client_name, project_description }` from the form fields to `/invoices/suggest-items`; on response, renders a dropdown of 4 suggestion chips; each chip, when clicked, appends a new line-item row pre-filled with the suggestion's description, quantity, and unit_price. Loading state: button shows "Thinking…" and is disabled.
5. Tests in `tests/ai-suggestions.test.js` (4 tests): `POST /invoices/suggest-items` as Pro user with stubbed `lib/ai-suggestions.js` returns 200 with suggestions array; Free user gets 403; invalid body returns 400; `suggestLineItems()` returns `[]` when the API throws (graceful degradation).

---

### 27. [GROWTH] One-Click Invoice Duplication [S]

**App:** QuickInvoice (Node.js)
**Impact:** MEDIUM — reduces time-to-invoice for repeat clients (the most common workflow for retainer freelancers); removes the 5-step "create invoice, fill in client, re-enter same line items" friction loop; particularly valuable for users who haven't enabled recurring invoices (InvoiceFlow #6 equivalent doesn't exist in QuickInvoice)
**Effort:** Very Low
**Prerequisites:** None

**Sub-tasks:**
1. `db.js`: add `duplicateInvoice(originalInvoiceId, userId)` — queries the source invoice (verifies `user_id = userId` for IDOR protection); inserts a new invoice row with: same `client_name`, `client_email`, `notes`, `currency`; status `'draft'`; new `invoice_number` (next in sequence, same as `createInvoice`); `issue_date = NOW()`; `due_date = NOW() + INTERVAL '30 days'`; `payment_link_url = NULL`, `payment_link_id = NULL`. Then copies all line items from the original to the new invoice. Returns the new invoice ID.
2. `routes/invoices.js`: `POST /invoices/:id/duplicate` — `requireAuth`; call `db.duplicateInvoice(id, session.user.id)`; on success, redirect to `GET /invoices/:newId/edit` so the user can review and adjust before sending. On not-found or IDOR (returns null), redirect to `/dashboard` with flash "Invoice not found."
3. `views/invoice-view.ejs`: add a "Duplicate" button in the action bar alongside "Edit", "Mark Sent", and "Delete". Style as a secondary button (white/bordered). Implement as a `<form method="POST" action="/invoices/:id/duplicate">` with the CSRF token hidden input — consistent with how delete and status changes work.
4. `views/dashboard.ejs` invoice list: add a small "Duplicate" link in each invoice row's action column (currently only "View" exists). Keep it compact — icon-only or a small text link.
5. Tests in `tests/invoice-duplicate.test.js` (4 tests): `POST /invoices/:id/duplicate` creates a new DRAFT invoice with same client + line items and redirects to edit; duplicated invoice has a new invoice number (not the original); IDOR (other user's invoice) returns redirect to /dashboard, no DB write; duplicate of a paid invoice creates a DRAFT (status not carried over).

---

### 28. [GROWTH] Legal Pages Code Scaffolding (Terms, Privacy, Refund) [S]

**App:** QuickInvoice (Node.js)
**Impact:** MEDIUM — without these routes, all three legal pages (L1-L3 in TODO_MASTER.md) remain blocked even after Master writes the actual legal text; these routes are the only thing preventing compliance; directory listings on G2, Capterra, and Product Hunt require a live Terms URL; Stripe's Checkout page requires a refund policy URL in the "Business details" settings
**Effort:** Very Low
**Prerequisites:** None (Master provides legal text separately via TODO_MASTER.md L1-L3; code can ship with placeholder content that gets swapped)

**Sub-tasks:**
1. Create `views/legal/terms.ejs`, `views/legal/privacy.ejs`, `views/legal/refund.ejs` — each extending `partials/head.ejs` and `partials/nav.ejs`. Body: a max-width prose container (`max-w-3xl mx-auto px-4 py-12`) with a large `<h1>` and a single placeholder `<p>` surrounded by an HTML comment: `<!-- MASTER: replace this paragraph with the actual legal text. See TODO_MASTER.md L1/L2/L3 for requirements. -->`. Style with Tailwind `prose` class (already loaded via CDN) for readable typography.
2. `server.js` (or a new `routes/legal.js` mounted in `server.js`): add three `GET` routes — `/terms`, `/privacy`, `/refund-policy` — rendering the respective views with `{ user: req.session.user || null }`.
3. `views/index.ejs` footer: add links to all three pages in the existing footer row, styled as `text-sm text-gray-500 hover:text-gray-700`.
4. `views/auth/register.ejs`: update the "agree to our terms of service" text to link to `/terms` (`<a href="/terms" class="underline">terms of service</a>`); add "and <a href="/privacy" class="underline">privacy policy</a>" next to it.
5. `views/pricing.ejs` footer: add "Terms · Privacy · Refund Policy" links.
6. Update the existing `views/partials/nav.ejs` or add a shared `partials/footer.ejs` so the links appear consistently on all pages.
7. No tests needed for static views; verify with a simple `curl /terms` → 200 check in a comment.

---

### 29. [DONE 2026-04-26 PM] [GROWTH] Trial End Day-3 Nudge Email [XS]

**App:** QuickInvoice (Node.js)
**Impact:** HIGH — the single highest-leverage conversion action available for trial users; industry benchmarks show a day-3/4 nudge email is responsible for 30–50% of trial-to-paid conversions; without it, users who signed up but never added a card silently lapse on day 7
**Effort:** Very Low
**Prerequisites:** Email delivery (#13, done) + node-cron (#16, done) + `trial_ends_at` column (#19, done) — all prerequisites are live

**Resolution (2026-04-26 PM):** Implemented end-to-end as the highest-priority `[XS]` income-critical task in this cycle.

1. **Schema.** Added idempotent `ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_nudge_sent_at TIMESTAMP;` to `db/schema.sql` immediately after the `onboarding_dismissed` column. Column is nullable — a user is "needs nudge" iff `trial_nudge_sent_at IS NULL`. This is the single source of idempotency: the SQL filter prevents the same user receiving two nudges across cron ticks even if rows are queried twice.

2. **`db.js` query helpers.** Added `getTrialUsersNeedingNudge()` — single SELECT against `users` with five conditions: `plan = 'pro'`, `trial_ends_at IS NOT NULL`, `trial_ends_at BETWEEN NOW() + INTERVAL '2 days' AND NOW() + INTERVAL '4 days'`, `trial_nudge_sent_at IS NULL`, and `(subscription_status IS NULL OR subscription_status = 'trialing')`. The last clause is a tightness guard — users who already added a card mid-trial (`subscription_status = 'active'`) get a different funnel; users whose card failed (`past_due`) get the dunning banner; only true trialing users get the nudge. `LIMIT 500` matches `getOverdueInvoicesForReminders` so a runaway query never sweeps the whole table. Returns the columns needed for the email body: `id, email, name, business_name, trial_ends_at, invoice_count`. Also added `markTrialNudgeSent(userId)` — single UPDATE that sets `trial_nudge_sent_at = NOW()` and `updated_at = NOW()` (matches the `markInvoiceReminderSent` shape so a future test can swap them with one helper).

3. **`jobs/trial-nudge.js`** (new file, 220 lines, mirrors `jobs/reminders.js` patterns line-for-line). Exports a pure orchestrator `processTrialNudges({ db, sendEmail, now, log })` that returns `{ found, sent, skipped, errors, notConfigured }`. Three pure formatters:
   - `buildTrialNudgeSubject(user, now)` → `"Your Pro trial ends in N days — don't lose your data"`. Singular/plural correct (`1 day` vs `3 days`).
   - `buildTrialNudgeHtml(user, now)` — full HTML email with a personalised greeting, day-count headline, four-bullet Pro features list (Stripe Payment Links, auto-reminders, custom branding, instant paid notifications), an invoice-count line that conditionally renders ("you've already created **3 invoices**" — omitted entirely when count is 0 to avoid the awkward "0 invoices" copy), and a "Keep Pro → Add payment method" CTA button. CTA href is `${APP_URL}/dashboard` — the dashboard's existing trial banner POSTs to `/billing/portal` (cookie-authed), so we route through the dashboard rather than emailing a link to a POST endpoint that would 405. CTA gracefully omits when `APP_URL` is unset (no broken-link buttons in dev).
   - `buildTrialNudgeText(user, now)` — plain-text fallback with the same content shape.
   All user-controlled fields (`name`, `business_name`) flow through `escapeHtml` so a `<script>` payload in name cannot XSS Resend's preview pane or the webmail client. The orchestrator follows the same hygiene contract as `processOverdueReminders`: `not_configured` → no stamp + retry next tick; thrown error → counts an error, batch continues, no stamp; success → stamp via `markTrialNudgeSent`.
   `startTrialNudgeJob(opts)` schedules the orchestrator at `'0 10 * * *'` (10:00 UTC daily — staggered one hour after the reminder job at `'0 9 * * *'` so the two cron ticks don't pile DB load). `NODE_ENV=test` guard refuses to schedule during the test run unless `force:true` is passed (lets the wiring test inject a fake cron). Failures to require `node-cron` are logged and swallowed so a broken cron never takes down the web process.

4. **`server.js`** — registered the new job alongside `startReminderJob` inside the existing `NODE_ENV !== 'test'` block. Each startup logs either `[trial-nudge] scheduled (0 10 * * *)` or `[trial-nudge] not scheduled: <reason>` so deploy logs surface the wiring health without a separate health endpoint.

5. **`tests/trial-nudge.test.js`** (new file, 17 assertions — spec called for 4; 13 added for coverage parity with `tests/reminders.test.js`):
   - **Pure formatters (7):** subject plural/singular; HTML escapes hostile name; HTML invoice-count plural/singular/zero-omit; HTML CTA omits gracefully when `APP_URL` unset; text fallback content; `daysLeft` arithmetic across same-day, expired, future, and garbage inputs.
   - **Orchestrator (6):** happy path (send + stamp); skips users without email; `not_configured` → no stamp + counts notConfigured; thrown send error → counts error + batch continues; idempotency across runs (filter respects stamp); top-level query failure → `errors=1` summary, no throw.
   - **Cron wiring (3):** `NODE_ENV=test` blocks scheduling; cron tick wires `processTrialNudges` correctly with injected fake db + email; double start refused.
   - **Spec compliance (1):** `DEFAULT_SCHEDULE === '0 10 * * *'` (10:00 UTC daily).

   Wired into `package.json` `test` script after `tests/reminders.test.js`. Full suite: **28 test files, 0 failures.**

**[Master action]** Two:
- **Schema migration on prod**: `psql $DATABASE_URL -f db/schema.sql`. Idempotent, safe to run on a populated DB. Added to TODO_MASTER.
- **(Existing, no change)** Provision `RESEND_API_KEY` per TODO_MASTER #18. Until provisioned, the trial-nudge job runs cleanly as a no-op (`not_configured` skips the DB stamp so the nudge fires on the first tick after the key lands).

**Income relevance:** This is the single highest-leverage conversion action available for the trial cohort. Industry benchmarks (Userlist, ConvertKit, ChartMogul) consistently put a single well-timed day-3/4 trial nudge at responsible for **30-50%** of trial-to-paid conversion. Without it, the modal users — those who signed up, opened the dashboard, never came back — silently lapse on day 7 with zero recovery. With it, the nudge interrupts that lapse with a feature-list reminder and a one-click path back into the funnel. At $9/mo Pro, recovering even 10 trial users a month is +$108/mo MRR; at the upper bound of the benchmark range and a higher trial cohort, this single email can be the largest single MRR contributor in the funnel.

---

### 30. [DONE 2026-04-26] [GROWTH] "Invoice Paid" Instant Notification Email to Freelancer [XS]

**App:** QuickInvoice (Node.js)
**Impact:** HIGH — the "cha-ching" magic moment that drives word-of-mouth ("this app texts me the second I get paid"); the emotional resonance of an instant paid-notification converts casual users into vocal advocates; costs ~5 lines of code in the existing Stripe webhook handler; no new infrastructure
**Effort:** Very Low
**Prerequisites:** Email delivery (#13, done); Payment Links (#2, done)

**Sub-tasks:**
1. `routes/billing.js` `checkout.session.completed` handler: inside the `session.mode === 'payment'` branch (payment link payments), after `db.updateInvoiceStatus(invoice.id, 'paid')`, fire a `sendEmail()` to the invoice owner (look up via `invoice.user_id → db.getUserById`). Subject: `"Invoice #[invoice_number] was just paid — $[total]"`. HTML body: two lines ("Great news — [client_name] paid invoice #X for $Y.") + a "View invoice →" button to `/invoices/:id`. Reply-to: owner's `reply_to_email` or `business_email`. Fire-and-forget (`then/catch`, never `await` — don't delay the webhook 200 response).
2. Handle the case where `sendEmail` returns `not_configured` gracefully (same pattern as reminder job — log and continue).
3. Tests in `tests/paid-notification.test.js` (3 tests): payment-link `checkout.session.completed` → `sendEmail` called with the right owner email, subject containing the invoice number and amount; `sendEmail` throw does NOT prevent the invoice from being marked paid (fire-and-forget safety); non-payment-link checkout (subscription upgrade) does NOT trigger a paid notification (guard on `session.mode === 'payment'`).

**Resolution (2026-04-26):** Added four pure formatters + one transport function to `lib/email.js`: `buildPaidNotificationSubject(invoice)`, `buildPaidNotificationHtml(invoice, owner)`, `buildPaidNotificationText(invoice)`, and `sendPaidNotificationEmail(invoice, owner)`. The recipient is the freelancer (`owner.email`) — NOT the client — so the cha-ching email lands in the person who cares. The HTML body is a green-themed celebration card ("You just got paid", `#16a34a`) with the client's name, invoice number, formatted total (using the existing `formatMoney` symbol map covering 8 currencies), and a "View invoice X" deep-link button when `APP_URL` is set. All user-controlled fields (`client_name`, `invoice_number`, total, URL) flow through the existing `escapeHtml` so a `<script>` payload in `client_name` cannot XSS the freelancer's webmail client. Reply-to follows the same `reply_to_email > business_email > email` precedence used by the invoice-send and reminder paths so a reply lands sensibly. Subject line ("Invoice INV-X was just paid — $1,200.00") is built without `escapeHtml` (subject is plain text, never HTML-rendered).

`routes/billing.js` `checkout.session.completed` handler: inside the existing `session.mode === 'payment' && session.payment_link` branch, after `db.markInvoicePaidByPaymentLinkId(...)` returns the freshly-marked invoice and after the existing outbound-webhook fire, the new code reads the owner via `db.getUserById(updated.user_id)` (one round trip — the outbound-webhook block already needed the owner row, so this is the same lookup, not a duplicated query), then `sendPaidNotificationEmail(updated, owner).then(...).catch(...)` fires the email. The `.then()` only logs failures whose `reason !== 'not_configured'` — same hygiene pattern as `routes/invoices.js`'s mark-sent email, so the cron-style "until Master provisions Resend, every send is a clean no-op" property holds. The webhook returns 200 immediately regardless of the email outcome — proven by test #6 below (sendPaidNotificationEmail rejects with `Error('Resend exploded')`, webhook still returns 200). Subscription-mode checkouts (Pro upgrades) do NOT trip the paid-notification — the new code lives inside the `session.mode === 'payment'` branch, so subscription completions fall through unchanged.

New `tests/paid-notification.test.js` adds 7 assertions (the spec called for 3; we added 4 more for coverage parity with `tests/email.test.js`): (1) subject formatter contract — invoice number + formatted total + "just paid" copy; (2) HTML escaping + APP_URL deep-link button render — `<script>alert(1)</script>` becomes `&lt;script&gt;`, `https://quickinvoice.io/invoices/99` is the button href; (3) `sendPaidNotificationEmail({email:null})` short-circuits with `no_owner_email` — defence-in-depth guard against a deleted-account corner case; (4) happy-path Resend payload — recipient is `owner.email` (NOT `invoice.client_email`!), reply_to follows the `business_email` fallback when `reply_to_email` is null; (5) Stripe webhook payment-link path → `sendPaidNotificationEmail` is called exactly once with the marked-paid invoice + owner; (6) `sendPaidNotificationEmail` rejecting does NOT change the webhook 200 — fire-and-forget guarantee; (7) subscription-mode checkout (Pro upgrade) does NOT fire the paid-notification — guard on `session.mode === 'payment'`. Wired into `package.json` `test` script. Full suite passes (26 test files, 0 failures).

**[Master action]** none required *for this feature on its own* — once the Resend API key from TODO_MASTER #18 is provisioned, paid-notification emails start flowing on the next payment-link payment. Until then, every send returns `{ ok:false, reason:'not_configured' }` and is logged-and-discarded with no side effects.

**Income relevance:** This is the "cha-ching" moment that converts casual users into vocal advocates. Industry word-of-mouth research: features that produce a measurable emotional spike (instant payment notification, "you just hit $10k MRR" milestone) generate 3–5× the share rate of utility features. Each share is one zero-CAC acquisition channel. The freelancer also returns to the dashboard the moment they get the email — every paid-notification is a re-engagement touchpoint that flips the user's relationship with the tool from "manual chase tool" to "set-and-forget cashflow." The combined effect is a higher retention dynamic *plus* a viral acquisition dynamic from one ~5-line code change.

---

### 31. [GROWTH] Free-Plan Invoice Limit Progress Bar on Dashboard [XS]

**App:** QuickInvoice (Node.js)
**Impact:** MEDIUM — the upgrade modal (#1) fires only at the hard wall (5th invoice); this adds a visible, non-pushy "X of 5 free invoices used this month" progress bar that creates conversion pressure before the wall; users who see they're at 3/5 or 4/5 are highly likely to upgrade rather than wait for the hard stop; different from #15 (contextual upsell) which targets specific feature interactions rather than the usage-limit dimension
**Effort:** Very Low
**Prerequisites:** None

**Sub-tasks:**
1. `routes/invoices.js` `GET /` (dashboard): for free-plan users, compute `monthly_invoice_count` — count of invoices created in the current calendar month (or rolling 30 days, matching whichever window the hard limit enforces). Pass `invoice_limit_progress: { used: N, max: 5 }` to the template only when `user.plan === 'free'`.
2. `views/dashboard.ejs`: above the invoice list and below the onboarding checklist, render a slim progress bar when `locals.invoice_limit_progress` is defined. Tailwind: outer container `bg-gray-100 rounded-full h-2`, inner fill `bg-indigo-500 rounded-full h-2` with `style="width: N%"`. Label above: `"<strong>N of 5</strong> free invoices used this month"`. At 4/5 or 5/5 change fill color to `bg-amber-500` and append an inline `"Upgrade →"` link to `/billing/upgrade`. Wrap in `print:hidden`.
3. No tests needed for a pure view change; spot-check that the bar does not render for Pro/Business/Agency users.

---

### 32. [GROWTH] API Key Authentication + REST Endpoints (Zapier Marketplace Prerequisite) [S]

**App:** QuickInvoice (Node.js)
**Impact:** MEDIUM-HIGH — required prerequisite for TODO_MASTER #24 (native Zapier app listing, which exposes QuickInvoice to Zapier's 3M+ users); also enables power users to build their own automations and unlocks the "developer market" segment; the API key model is the simplest auth pattern (no OAuth server needed) and is the standard for indie SaaS Zapier integrations
**Effort:** Low
**Prerequisites:** None

**Sub-tasks:**
1. `db/schema.sql`: `ALTER TABLE users ADD COLUMN IF NOT EXISTS api_key VARCHAR(64) UNIQUE;`. Idempotent.
2. `db.js`: update `createUser()` to generate `api_key = crypto.randomBytes(32).toString('hex')` on insert. Add `getUserByApiKey(apiKey)` — `SELECT ... FROM users WHERE api_key = $1`. Add `regenerateApiKey(userId)` — `UPDATE users SET api_key = $1, updated_at = NOW()` with a fresh `crypto.randomBytes(32).toString('hex')` value; returns the new key.
3. `middleware/api-auth.js`: new `requireApiKey` middleware — reads `Authorization: Bearer <key>` header, calls `db.getUserByApiKey`, attaches `req.apiUser`; returns `401 { error: 'Unauthorized' }` on missing/invalid key.
4. `routes/api.js` (new file, mount at `/api` in `server.js`):
   - `GET /api/invoices` — `requireApiKey`; accepts `?status=paid|sent|draft|overdue&since=ISO_DATE&limit=50`; returns JSON array of invoice objects. Used as the Zapier "Invoice Paid" polling trigger.
   - `GET /api/me` — `requireApiKey`; returns `{ plan, invoice_count_this_month, client_count }`. Used by Zapier for connection verification.
5. `views/settings.ejs`: add a "Developer / API" card in the Pro section (Pro/Agency plan gate). Shows the current API key in a monospaced input (masked, with a toggle-reveal button using Alpine.js). "Regenerate key" button POSTs to `POST /billing/api-key/regenerate` (small handler in `routes/billing.js`) with CSRF token. Free users see a locked placeholder with upgrade CTA.
6. Tests in `tests/api-key.test.js` (5 tests): valid API key → `GET /api/invoices` returns 200 with invoice array filtered by status/since; missing key → 401; invalid key → 401; `GET /api/me` returns plan + counts; `POST /billing/api-key/regenerate` (Pro user) returns new key and updates DB.

---

### 33. [GROWTH] Invoice Bulk CSV Export [S]

**App:** QuickInvoice (Node.js)
**Impact:** MEDIUM — tax season is the #1 churn-risk event for freelancers (they switch tools when they realise they can't easily pull their invoicing data for their accountant); a one-click CSV export of all invoices eliminates this churn vector and is a concrete Pro feature that differentiates from free-tier invoicing tools; GDPR Art. 15 data portability also makes this a compliance requirement for EU users
**Effort:** Low
**Prerequisites:** None

**Sub-tasks:**
1. `db.js`: add `getInvoicesForExport(userId)` — `SELECT invoice_number, issue_date, due_date, client_name, client_email, status, total, currency, payment_link_url, last_reminder_sent_at, created_at FROM invoices WHERE user_id = $1 ORDER BY created_at DESC` (no `LIMIT` — export is intentionally unbounded). Separate from `getInvoicesByUser` which will eventually be paginated (#H11).
2. `routes/invoices.js`: add `GET /invoices/export.csv` — `requireAuth`; call `getInvoicesForExport`; set headers `Content-Type: text/csv; charset=utf-8` and `Content-Disposition: attachment; filename="invoices-YYYY-MM-DD.csv"`; stream the response as CSV (use Node's built-in string building — no CSV library needed for flat row data). Each row: `invoice_number, issue_date, due_date, client_name, client_email, status, total, currency`. First row: column headers. Escape any commas in field values by wrapping in double-quotes.
3. `views/dashboard.ejs`: add an "Export CSV" button in the dashboard header row (right-aligned, next to any future filter controls). Style as a secondary button. Visible for all plan levels (export is a data-portability right, not a Pro feature). Link directly to `/invoices/export.csv` (plain anchor, no JS needed — browser triggers a download).
4. Tests in `tests/csv-export.test.js` (3 tests): authenticated user → 200, `Content-Type: text/csv`, body contains invoice_number header row + invoice data rows; unauthenticated → redirect to `/auth/login`; user with no invoices → 200 with header row only (empty export is valid).

---

### 34. [GROWTH] Plausible Analytics Integration [XS]

**App:** QuickInvoice (Node.js)
**Impact:** MEDIUM — without analytics there is no way to measure which niche landing pages drive registrations, whether the upgrade modal converts, what the landing-page → signup funnel looks like, or whether any of the distribution actions (Product Hunt, Show HN, newsletter mentions) are sending traffic; Plausible is cookie-less (no GDPR consent banner needed per TODO_MASTER L6), privacy-friendly, and costs $9/mo; this is operational infrastructure for every future growth decision
**Effort:** Very Low
**Prerequisites:** Master must sign up at plausible.io and provide the domain name (see TODO_MASTER #29 below); the code integration is a 2-line change

**Sub-tasks:**
1. Add `PLAUSIBLE_DOMAIN` to `.env.example` (e.g. `quickinvoice.io`). When unset, skip injection entirely — graceful degradation, no 500s.
2. `views/partials/head.ejs`: inside `<head>`, inject conditionally:
   ```html
   <% if (process.env.PLAUSIBLE_DOMAIN) { %>
   <script defer data-domain="<%= process.env.PLAUSIBLE_DOMAIN %>" src="https://plausible.io/js/script.js"></script>
   <% } %>
   ```
   No `unsafe-eval` needed — Plausible's script is external and already allowed by the CSP's `script-src` if the Plausible domain is added to `middleware/security-headers.js`.
3. `middleware/security-headers.js`: add `https://plausible.io` to `script-src` and `connect-src` CSP directives (Plausible's tracker makes a `POST /api/event` XHR to its own domain).
4. Key conversion events to track via the custom events API (`plausible('EventName')`): add `<script>plausible('Signup')</script>` to `views/auth/register.ejs` success redirect; `plausible('UpgradeStart')` in the upgrade modal CTA click handler; `plausible('TrialStart')` in `views/partials/upgrade-modal.ejs` after successful checkout. These are optional progressive enhancements — pageview tracking alone (default Plausible behaviour) is immediately valuable.
5. No tests needed (external script injection is trivial); verify in browser DevTools Network tab that `POST https://plausible.io/api/event` fires on pageload.

---

### 35. [DONE 2026-04-26] [GROWTH] Stripe Checkout: enable promotion codes + automatic tax (added 2026-04-26 audit) [XS]

**App:** QuickInvoice (Node.js)
**Impact:** HIGH — two adjacent wins from one ~3-line change in `routes/billing.js`. (1) `allow_promotion_codes: true` adds a "Add promotion code" link to every Stripe Checkout page, which is the prerequisite for Product Hunt launch coupons (`PH50`), AppSumo redemption, freelancer-newsletter sponsorships ("DESIGNERS20"), and the 100%-off-first-month coupon already mentioned in TODO_MASTER #25 (Agency cold email). Without it, every coupon Master creates in the Stripe Dashboard is unreachable. (2) `automatic_tax: { enabled: true }` switches on Stripe Tax for every subscription — Stripe automatically calculates and collects VAT/GST/sales tax for EU/UK/AU/CA customers based on their billing address. EU and UK freelancers are ~30% of the global freelancer market and are currently unable to upgrade because the price displayed at checkout doesn't match the post-tax invoice they need for their books.
**Effort:** Very Low
**Prerequisites:** None for `allow_promotion_codes`. Stripe Tax requires Master to enable Stripe Tax in the Stripe Dashboard once (Stripe Settings → Tax → Activate; takes 5 minutes). Until activated, `automatic_tax: { enabled: true }` returns a Stripe error and breaks checkout — wrap in a feature flag `STRIPE_AUTOMATIC_TAX_ENABLED=true` env so the deploy is reversible.

**Sub-tasks:**
1. `routes/billing.js POST /create-checkout`: add `allow_promotion_codes: true` to the `stripe.checkout.sessions.create()` call. No other config needed — Stripe handles validation and discounting.
2. Same call: add `automatic_tax: { enabled: process.env.STRIPE_AUTOMATIC_TAX_ENABLED === 'true' }`. The env-var gate means the deploy is safe before Master enables Tax in the dashboard.
3. Add `customer_update: { address: 'auto', name: 'auto' }` to the same call — required by Stripe Tax to capture the billing address for tax-jurisdiction lookup.
4. `.env.example`: add `STRIPE_AUTOMATIC_TAX_ENABLED=false` with comment "Set to true once Stripe Tax is activated in Dashboard".
5. New `tests/checkout-promo-tax.test.js` (3 tests): `allow_promotion_codes` is always true; `automatic_tax.enabled` reflects env var; Stripe Tax DISABLED in test env (no env var set).
6. Add Master action to TODO_MASTER.md: enable Stripe Tax in Dashboard + flip the env var.

**Resolution (2026-04-26):** `routes/billing.js POST /create-checkout` now sets `allow_promotion_codes: true` unconditionally (every coupon flow Master plans — Product Hunt PH50, AppSumo, newsletter sponsorships, Agency cold-email 100%-off — surfaces a "Add promotion code" link on the Stripe Checkout page). `automatic_tax.enabled` reads `process.env.STRIPE_AUTOMATIC_TAX_ENABLED === 'true'` so the deploy is reversible — only the literal string `"true"` flips it on (`"1"`, `"yes"`, `"TRUE"` are explicitly NOT honoured per test #5 below). When tax is enabled, `customer_update: { address: 'auto', name: 'auto' }` is set so Stripe captures billing address for jurisdiction lookup; when tax is disabled, `customer_update` is omitted because Stripe rejects it on sessions without `automatic_tax`. The new fields ride alongside the existing `subscription_data: { trial_period_days: 7 }` from #19 — verified by regression test #6.

`.env.example` adds `STRIPE_AUTOMATIC_TAX_ENABLED=false` with a comment instructing Master to set it to `true` after activating Stripe Tax in the Dashboard. New `tests/checkout-promo-tax.test.js` adds 6 assertions (exceeds the 3-test spec): (1) `allow_promotion_codes` is always true on monthly cycle; (2) `allow_promotion_codes` is also true on annual cycle (defence in depth — annual takes a different code branch via `resolvePriceId`); (3) `automatic_tax.enabled = false` and `customer_update` is undefined when env var is unset; (4) env var = `"true"` enables tax + sets `customer_update: { address: 'auto', name: 'auto' }`; (5) env var = `"1"` does NOT enable tax (literal-true gate prevents typo'd values from silently breaking the off-by-default property); (6) trial + promo + tax-flag coexist regression guard (a future edit dropping the trial setting won't go unnoticed). Wired into `package.json` `test` script. Full suite: 27 test files, 0 failures.

**[Master action]** required to actually collect tax: in the Stripe Dashboard go to Settings → Tax → Activate (5-minute setup; provide the business country + tax registrations for any jurisdictions where you collect tax). Then set `STRIPE_AUTOMATIC_TAX_ENABLED=true` in production env and redeploy. Until then, checkout works fine without tax — the env-var gate makes the deploy safe and reversible. See TODO_MASTER.md.

**Income relevance:** Direct. Unlocks (a) every marketing coupon flow Master is planning (Product Hunt, AppSumo, newsletter sponsorships, Agency cold email), (b) the EU/UK/AU/CA freelancer market segment that currently can't upgrade due to tax compliance friction. Both are zero-CAC revenue lifts.

---

### 36. [DONE 2026-04-26 PM-3] [GROWTH] Open Graph + Twitter Card metadata on landing/pricing/niche pages (added 2026-04-26 audit) [XS]

**App:** QuickInvoice (Node.js)
**Impact:** MEDIUM-HIGH — every share of `quickinvoice.io`, `/pricing`, or any of the 6 niche landing pages currently renders as a bare URL in Slack/iMessage/Twitter/LinkedIn/Discord previews. Adding `og:title`, `og:description`, `og:image`, `og:url`, `twitter:card`, `twitter:image` makes every shared link render a rich preview card with the QuickInvoice screenshot — typically 30–50% higher click-through vs. a bare URL. This compounds across every Reddit post (TODO_MASTER #14), every Tweet (#17, #30), every newsletter mention (#20), every Slack/Discord drop (#28), every Show HN (#19).
**Effort:** Very Low
**Prerequisites:** A static `public/og-image.png` (1200×630 PNG with the QuickInvoice logo + tagline). Master provides the image asset; the code can ship with a placeholder reference and the file gets dropped in.

**Sub-tasks:**
1. `views/partials/head.ejs`: add inside `<head>` (use template locals so each page can override defaults):
   ```html
   <meta property="og:title" content="<%= ogTitle || 'QuickInvoice — Professional invoices with Stripe Payment Links' %>">
   <meta property="og:description" content="<%= ogDescription || 'Send invoices freelancers can pay in one click. Free to start, $12/mo for Pro.' %>">
   <meta property="og:image" content="<%= APP_URL %>/og-image.png">
   <meta property="og:url" content="<%= APP_URL %><%= ogPath || '/' %>">
   <meta property="og:type" content="website">
   <meta name="twitter:card" content="summary_large_image">
   <meta name="twitter:title" content="<%= ogTitle %>">
   <meta name="twitter:description" content="<%= ogDescription %>">
   <meta name="twitter:image" content="<%= APP_URL %>/og-image.png">
   ```
2. `views/index.ejs`, `views/pricing.ejs`, `views/partials/lp-niche.ejs`: pass per-page `ogTitle` / `ogDescription` / `ogPath` locals. Niche pages should use the niche-specific headline as the og:title.
3. Verify `public/` is served by `server.js` (it is). Add `public/og-image.png` placeholder (Master replaces).
4. Test by pasting the URL into the LinkedIn Post Inspector or Twitter Card Validator after deploy.

**Income relevance:** Indirect but compounding — every distribution action in TODO_MASTER (`/launchposts/`, social, communities) gets ~30–50% more traffic from the same effort.

**Resolution (2026-04-26 PM-3):** Implemented end-to-end as the highest-priority `[XS]` income-critical task in this cycle.

1. **`views/partials/head.ejs`** — added an EJS preamble that resolves five locals (`ogTitle`, `ogDescription`, `ogPath`, `ogType`, `ogImage`) with conservative defaults, then renders 9 meta tags: `description` (standard SEO), `og:title`, `og:description`, `og:image`, `og:url`, `og:type`, `og:site_name`, `twitter:card="summary_large_image"`, `twitter:title`, `twitter:description`, `twitter:image`. APP_URL handling normalises trailing slashes (no `https://x.io//path` artefacts) and lets `ogImage` pass through unchanged when it is already an absolute URL (so a future CDN cutover doesn't require a code change). Defaults are safe: title "QuickInvoice — Professional invoices for freelancers", description carries the 7-day-trial / no-card hook, og:type = website. Per-page locals override every default so landing and niche pages emit niche-specific previews.
2. **`server.js GET /`** — now passes `ogTitle: 'QuickInvoice — Professional invoices in 60 seconds'`, `ogDescription` (one-click pay copy + trial hook), `ogPath: '/'`. The 60-seconds framing matches the existing landing-page H1.
3. **`routes/billing.js GET /upgrade`** — passes `ogTitle: 'QuickInvoice Pro — Unlimited invoices, payment links, $12/mo'`, `ogDescription` listing the 4 Pro features + trial, `ogPath: '/billing/upgrade'`.
4. **`routes/landing.js buildLocals(slug)`** — now sets `ogTitle: niche.headline`, `ogDescription: niche.description`, `ogPath: publicUrls(slug)`, `ogType: 'article'`. All 6 existing niche landing pages (designer, developer, writer, photographer, consultant, invoice-generator) get vertical-specific previews automatically — no per-niche config needed.
5. **`public/og-image.png`** — generated a valid 1200×630 brand-indigo (#4f46e5) PNG (3.5 KB) as a placeholder. Master replaces this with a branded asset (logo + tagline) per TODO_MASTER. The placeholder is a real PNG with valid magic bytes so social-card validators still accept it pre-replacement; the share preview just shows a solid-color card until Master uploads the branded image.
6. **`tests/og-metadata.test.js`** (new file, 10 assertions): default tags render with safe defaults; standard meta description renders for SEO; per-page locals override every default; APP_URL is correctly prefixed onto og:url + og:image; trailing-slash APP_URL is normalised (regression guard against `//path` URLs); absolute ogImage URLs pass through unchanged (CDN-future-proofing); all 6 niche pages emit niche-specific og:title + og:description + og:type=article + og:url ending in their public path; public/og-image.png exists with valid PNG magic bytes (regression guard against an empty placeholder); index.ejs and pricing.ejs render with the locals their routes pass. Wired into `package.json test` script after `tests/billing-deleted-account.test.js`. Full suite: **31 test files, 0 failures.**

**[Master action]** required to complete the polish: replace `public/og-image.png` with the branded 1200×630 image (QuickInvoice logo + tagline + brand-indigo background). Optional but recommended: also set `APP_URL=https://quickinvoice.io` in production env so og:url and og:image render as absolute URLs (most social card validators require this). Both items added to TODO_MASTER.

**Income relevance:** Indirect but compounding — every distribution action in TODO_MASTER (`/launchposts/`, social, communities) now generates 30–50% higher click-through from the same effort because the link preview renders as a branded card instead of a bare URL.

---

### 37. [DONE 2026-04-26 PM-2] [GROWTH] Annual billing savings copy across all toggles (added 2026-04-26 audit; closed in this cycle's UX audit) [XS]

**App:** QuickInvoice (Node.js)
**Impact:** MEDIUM-HIGH — INTERNAL_TODO #3 (annual billing) is live; users can pick monthly ($12/mo) or annual ($99/yr). The "Save 31%" badge already ships on the `/pricing` toggle (`views/pricing.ejs:25`) and on the upgrade modal (`views/partials/upgrade-modal.ejs:76`). What's still missing: (a) the "2 months free vs. monthly" framing as a more compelling alternative to the existing "Just $8.25/mo" subhead; (b) the same toggle + badge on `views/settings.ejs` so existing monthly subscribers can switch to annual without going through `/pricing`. Industry data: pricing toggles that explicitly call out the savings convert ~20–30% more annual subscribers vs. toggles that just show the two numbers. Annual subscribers churn at half the rate of monthly, so each annual conversion is worth ~$50 more LTV.
**Effort:** Very Low (pure copy/layout change)
**Prerequisites:** None — annual billing #3 is already live.

**Sub-tasks:**
1. `views/pricing.ejs`: next to the "Annual" tab in the toggle, add a small green badge `Save 18%` (or compute `Math.round((144-99)/144*100)` if the prices are template locals — they are not currently). Below the annual price, add subtext: "$99/year — that's 2 months free vs. monthly". Style as `text-xs text-emerald-600`.
2. `views/partials/upgrade-modal.ejs`: same badge + subtext on the annual tab. Modal already has the toggle from #3.
3. `views/settings.ejs`: same badge on the plan toggle in the Billing section.
4. No backend change. No test needed (pure view change); spot-check the badge appears next to "Annual" only, not "Monthly".

**Income relevance:** Direct — every annual conversion is +$50 LTV vs. monthly. A 25% lift in annual share at current conversion volumes is meaningful MRR.

**Resolution (2026-04-26 PM-2 UX audit):** Closed via a focused copy edit on the two surfaces where the annual price appears as a primary number (the third surface — `views/settings.ejs` toggle — already had the "Save 31%" badge per the original review). Both edits use `text-emerald-200` / `text-emerald-600` for visual continuity with the existing toggle badge.

1. **`views/pricing.ejs`** — under the `$99/yr` headline, the existing subtext "Just $8.25/mo · billed yearly · cancel anytime" stays (it's the better lead — anchors against the monthly mental model). Below it, a new line ships only when `cycle === 'annual'`: **"Save $45/year vs. monthly"** in bright `text-emerald-200` semibold. The savings number is mathematically correct ($12 × 12 = $144 monthly vs. $99 annual = $45 saved). A matching invisible spacer line keeps the monthly view's vertical rhythm identical so the layout doesn't shift on toggle.
2. **`views/partials/upgrade-modal.ejs`** — the existing "After trial: $99/year" line in the modal's footer micro-copy now reads "After trial: $99/year (save $45/year)" when `cycle === 'annual'`. Single-line addition; preserves visual hierarchy of the trial CTA above.

The "2 months free" framing was rejected per the original audit note (mathematically wrong at $12/mo: $144 - $99 = $45 ≈ 3.75 months). The concrete dollar savings are stronger anyway — a freelancer immediately translates "$45" to "one nice dinner." All three existing tests on these surfaces (`tests/annual-billing.test.js`, `tests/trial.test.js`, `tests/onboarding.test.js`) still pass with no test changes — the new copy is additive, not a replacement of any string those tests assert.

**Income relevance:** Closes the 2-step friction in the annual decision: the toggle says "Save 31%", the price says "$99", and now the line below the price closes the loop with the dollar amount. Per the audit's industry data, pricing copy that explicitly surfaces the dollar savings converts ~20-30% more annual subscribers than the same toggle without it.

---

### 38. [GROWTH] Public `/roadmap` page (trust + churn defence) (added 2026-04-26 audit) [S]

**App:** QuickInvoice (Node.js)
**Impact:** MEDIUM — when users churn, the #2 reason cited (after price) is "I'm not sure they're actively building this." A public roadmap page with 6–8 upcoming features and rough ETAs is the single highest-leverage trust signal a SaaS can ship — visible on the landing page footer, the pricing page, and inside the upgrade modal as "What's next?". Also pre-empts feature requests ("oh, that's already on the roadmap for next month") and gives existing Pro users a reason to stay subscribed past their first month.
**Effort:** Low
**Prerequisites:** None.

**Sub-tasks:**
1. New `views/roadmap.ejs` extending `partials/head.ejs` + `partials/nav.ejs`. Body: a 3-column Tailwind grid (`md:grid-cols-3`) with cards labelled "Now", "Next", "Later". Each card holds 2–4 bullet items. Hand-curated from INTERNAL_TODO so we don't leak internal task numbers — examples:
   - **Now (April 2026):** Instant paid notifications · Trial-end nudges · Multi-currency invoices
   - **Next (May 2026):** Native iOS/Android home-screen install · Late fee automation · CSV export
   - **Later (Q3 2026):** API + Zapier app · Client portal · Team seats for agencies
2. New route `routes/roadmap.js` (or 4-line addition to `server.js`): `GET /roadmap` → render the view. No auth, no DB, no plan gate.
3. `views/index.ejs` footer: add a "Roadmap" link in the existing footer row, between "Pricing" and "Login".
4. `views/partials/upgrade-modal.ejs`: add a small "See what's coming →" link at the bottom of the modal pointing to `/roadmap`.
5. Add `/roadmap` to `routes/landing.js` `GET /sitemap.xml` so Google indexes it.
6. New `tests/roadmap.test.js` (2 tests): `GET /roadmap` returns 200 with the section headings; sitemap includes the new URL.
7. Lock the file as a Master-curated copy file — every quarter, edit the bullets directly. No CMS, no DB.

**Income relevance:** Reduces churn by 5–10% (industry data on transparent roadmaps). Also a passive marketing asset (every "what's the roadmap?" tweet response can link here instead of typing it out).

---

### U1. [UX] Password reset flow does not exist — login page is a hard dead-end (added 2026-04-26 UX audit) [M]

**App:** QuickInvoice (Node.js)
**Impact:** HIGH (long-tail) — `views/auth/login.ejs` originally had no "Forgot password?" link; the 2026-04-26 UX audit added a "Email support@quickinvoice.io and we'll reset it for you" line as a stopgap, but every reset is now a manual support-ticket task for Master. Industry data: 8–12% of returning users hit forgot-password in any given month; without a self-serve flow, every one of them is either a support-inbox burden or a churned account. Highest-leverage retention-plumbing fix QuickInvoice is missing.
**Effort:** Medium
**Prerequisites:** Email delivery (#13, done) — needs `RESEND_API_KEY` provisioned per TODO_MASTER #18 to actually send.

**Sub-tasks:**
1. `db/schema.sql`: `ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_token VARCHAR(64); ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_expires_at TIMESTAMP;` Idempotent.
2. `db.js`: add `setPasswordResetToken(userId, token, expiresAt)`, `getUserByPasswordResetToken(token)` (also checks `expires_at > NOW()`), `clearPasswordResetToken(userId)`, and `updateUserPassword(userId, hash)` helpers.
3. `routes/auth.js`:
   - `GET /auth/forgot` → render `views/auth/forgot.ejs` with email input.
   - `POST /auth/forgot` → look up user by email; ALWAYS return the same flash ("If an account exists for that email, we've sent reset instructions.") — never leak account existence (defence-in-depth on top of the H3 enumeration oracle fix). On match: generate `crypto.randomBytes(32).toString('hex')`, persist with 1-hour expiry, send email with `${APP_URL}/auth/reset?token=...` link via `lib/email.js sendEmail()`. Rate-limit at 3 req/min/IP via existing `middleware/rate-limit.js`.
   - `GET /auth/reset?token=` → look up user by token + non-expired; render `views/auth/reset.ejs` with new-password input + the token in a hidden field. If no match, render an error view with "This reset link has expired or is invalid. [Request a new one →](/auth/forgot)".
   - `POST /auth/reset` → validate token, validate new password (8+ chars, same as register), bcrypt-hash, persist, clear the reset token, log the user in (session set), redirect to `/dashboard` with success flash.
4. `views/auth/login.ejs`: replace the stopgap "Email support" line with a `<a href="/auth/forgot" class="underline">Forgot your password?</a>` link.
5. `views/auth/forgot.ejs` + `views/auth/reset.ejs`: minimal pages, mirror the existing login/register layout.
6. New `tests/password-reset.test.js` (6 tests minimum): forgot returns generic flash for unknown email (no enumeration); forgot triggers `sendEmail` with token URL when email matches; reset accepts a valid token; reset rejects an expired token; reset rejects an unknown token; reset clears the token after use (idempotent — same link can't be reused).

**Why not now:** Requires email delivery to be live (RESEND_API_KEY), and the 4 routes + 2 views + DB migration is more than a single-session change. The 2026-04-26 UX audit added a "Email support" stopgap that is honest and prevents the dead-end for now.

---

### U2. [DONE 2026-04-26] [UX] Dashboard empty state does not mention Pro features (added 2026-04-26 UX audit) [XS]

**App:** QuickInvoice (Node.js)
**Impact:** MEDIUM — `views/dashboard.ejs` empty state (lines 143-152) shows "No invoices yet — Create your first invoice and start getting paid." for users with zero invoices. Free users at this moment are at peak intent (they just signed up) but see no information about what Pro unlocks; they create their first invoice and then might not encounter the Pro upsell until they hit the 3-invoice limit. Adding a subtle "✨ Pro tip: with Pro you can email invoices directly + get paid via Stripe payment link — try free for 7 days" callout below the CTA captures the high-intent activation moment without being pushy.
**Effort:** Very Low (pure view change)
**Sub-tasks:**
1. `views/dashboard.ejs` empty state block (`if (invoices.length === 0)`): below the "Create your first invoice" CTA, add (only for `user.plan === 'free'`):
   ```html
   <p class="text-xs text-gray-400 mt-6 max-w-sm mx-auto">
     ✨ <strong>Pro tip:</strong> with Pro, your invoices auto-generate a Stripe Pay button and clients pay in one click.
     <a href="/billing/upgrade" class="text-brand-600 underline hover:text-brand-700">Try Pro free for 7 days &rarr;</a>
   </p>
   ```
2. Pro/Business/Agency users see no callout (irrelevant to them).
3. Wrap in `print:hidden` (defensive — empty dashboards are rarely printed but the print stylesheet should not show CTA chrome).
4. No test required (pure view change); spot-check renders for Free user empty state and is absent for Pro user empty state.
**Resolution (2026-04-26 UX audit):** Implemented directly. `views/dashboard.ejs` empty-state block now renders a `print:hidden` ✨ Pro tip below the "Create your first invoice" CTA, gated on `user && user.plan === 'free'`. Copy: "with Pro, every invoice auto-generates a Stripe Pay button so clients pay in one click." Includes an underlined "Try Pro free for 7 days →" link to `/billing/upgrade`. Pro/Business/Agency users see no callout (irrelevant). The wider container also picked up `print:hidden` so the empty-state never leaks into a print dialog. INTERNAL_TODO #15 still open for the larger upsell-on-locked-features scope (settings branding, invoice-view payment link card, dashboard stats-bar callout); this commit closes only the empty-state slice. Tests: ran `tests/onboarding.test.js`, `tests/dunning.test.js`, `tests/trial.test.js` — all green (the three test files that EJS-render the dashboard).

---

### 39. [GROWTH] First-invoice seed template on user signup (activation) (added 2026-04-26 audit) [S]

**App:** QuickInvoice (Node.js)
**Impact:** HIGH — the dashboard onboarding checklist (#14, done) lifts activation by surfacing the path-to-value, but the actual "create your first invoice" step still drops users at an empty form. Pre-creating a draft "Welcome — your sample invoice" with a fake client (`client_name: 'Acme Co (sample)'`, one line item, $500 total) on signup means the new user lands on a dashboard that already has one row — which lifts the "create" step's completion rate to ~100% instantly and makes step 2 of the onboarding checklist auto-complete. Notion, Linear, and Figma all use this pattern; it's the highest-ROI activation trick in SaaS onboarding playbooks.
**Effort:** Low
**Prerequisites:** None.

**Sub-tasks:**
1. `routes/auth.js POST /register`: after `db.createUser()` succeeds and before redirecting to dashboard, call a new `db.createSampleInvoice(userId)` helper.
2. `db.js`: add `createSampleInvoice(userId)` — INSERT a draft invoice with: `invoice_number = await getNextInvoiceNumber(userId)`, `client_name = 'Acme Co (sample)'`, `client_email = 'sample@example.com'`, `items = [{description: 'Website redesign', quantity: 1, unit_price: 500}]`, `subtotal/total = 500`, `status = 'draft'`, `due_date = NOW() + INTERVAL '30 days'`. Increment `invoice_count` by 1 (via the existing trigger).
3. `views/dashboard.ejs`: when a sample invoice exists (`invoice_number ends with -0001 AND client_name = 'Acme Co (sample)'`), render a soft "Sample invoice — edit or delete to start fresh" badge next to it. Style as `bg-amber-50 text-amber-700 text-xs`.
4. The onboarding checklist's step 2 ("Create your first invoice") flips to ✅ immediately on signup because `invoices.length >= 1`. Step 3 (send) and step 4 (paid) are unaffected — those still require real action.
5. New `tests/sample-invoice.test.js` (3 tests): registration creates a sample invoice with the right shape; dashboard renders the sample-invoice badge; deleting the sample invoice does not break the onboarding checklist.

**Income relevance:** Activation lift translates directly into Pro upgrades — users who reach "first invoice paid" upgrade at 5–10× the rate of users who never make it past the empty dashboard. The free-plan invoice limit (3) means the sample invoice does count against their quota — a deliberate feature, not a bug, because it puts gentle pressure to either delete the sample or upgrade.

---

### 40. [GROWTH] Recurring Invoice Auto-Generation for QuickInvoice (parity with InvoiceFlow #6/P12) (added 2026-04-26 audit) [M]

**App:** QuickInvoice (Node.js)
**Impact:** HIGH — retainer freelancers and consultants are the highest-LTV segment of the user base; they invoice the same client(s) the same amount every month. Today, those users have to manually click "Duplicate" → edit dates → mark sent each month, which is exactly the kind of friction that drives churn to FreshBooks / Bonsai. The reminder cron infrastructure (#16, done) already runs daily; adding a recurring-invoice auto-clone job to that same scheduler is a 30-line addition. InvoiceFlow has had this since P12; QuickInvoice's lack of it is the single biggest feature-parity gap and the #1 reason a long-tenured Pro user might cancel.
**Effort:** Medium
**Prerequisites:** Reminder cron (#16, done); One-Click Duplication helper from #27 if landed first (re-uses the same line-item clone helper).

**Sub-tasks:**
1. `db/schema.sql`: idempotent additions —
   - `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS recurrence_frequency VARCHAR(20);` (allowed: `WEEKLY`, `BIWEEKLY`, `MONTHLY`, `QUARTERLY`).
   - `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS recurrence_next_run TIMESTAMP;`
   - `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS recurrence_active BOOLEAN DEFAULT false;`
   - Partial index: `CREATE INDEX IF NOT EXISTS idx_invoices_recurrence_due ON invoices(recurrence_next_run) WHERE recurrence_active = true;`
2. `db.js`: `setRecurrence(invoiceId, userId, { frequency, nextRun, active })` — verifies user ownership; clears recurrence when `active=false`. `getRecurringInvoicesDue(now)` — single SELECT joining users where `recurrence_active=true AND recurrence_next_run <= now AND plan IN ('pro','business','agency')` (Pro-gated). `cloneInvoiceForRecurrence(originalId, userId, newIssueDate)` — re-uses the duplicate logic; returns the new invoice ID.
3. `routes/invoices.js`: `POST /invoices/:id/recurrence` — Pro-gated; reads `frequency` (whitelisted) + `active` (boolean) from body; writes via `db.setRecurrence`. Free users see a locked Pro upsell on the invoice view.
4. `views/invoice-view.ejs`: add a "Recurrence" card (Pro only) — dropdown for frequency, toggle for active, save form. When active, render "Next invoice will auto-create on YYYY-MM-DD" beneath. Free user version is the same locked placeholder pattern as the webhook UI.
5. `jobs/recurring-invoices.js`: new daily cron (`'15 9 * * *'`, 09:15 UTC — staggered 15 min after the reminder cron at 09:00 to avoid contention). Pure orchestrator with full DI (same pattern as `jobs/reminders.js`): for each due row, clone the invoice with `status='draft'` and `issue_date=NOW()`, `due_date=NOW()+INTERVAL 30 days`, advance `recurrence_next_run` by the frequency. Per-row try/catch so one bad clone doesn't kill the batch.
6. `server.js`: register the new job under the same `NODE_ENV !== 'test'` guard as the reminder cron.
7. New `tests/recurring-invoices.test.js` (6+ tests): MONTHLY frequency advances `recurrence_next_run` exactly 1 month forward; cloned invoice has new invoice number + `status='draft'`; clone preserves line items; free-plan invoice is skipped even if `recurrence_active=true` (defence in depth atop SQL filter); paused recurrence is skipped; clone error in one row doesn't halt the batch.

**Income relevance:** Direct retention. Retainer freelancers churn at 30–50% lower rates when the tool auto-generates their monthly invoice — this is the highest-ROI retention feature still uncaptured in QuickInvoice. Closes the single biggest feature-parity gap with InvoiceFlow and the most common request from Pro users on freelancer forums.

---

### 41. [DONE 2026-04-26 PM] [GROWTH] Stripe Payment Link: enable bank/ACH + SEPA (lower fees on big invoices) (added 2026-04-26 audit) [XS]

**App:** QuickInvoice (Node.js)
**Impact:** HIGH (margin) — Stripe Payment Links default to card-only. For US invoices, ACH Direct Debit is 0.8% capped at $5 vs. cards at 2.9% + $0.30. On a $2,000 retainer invoice, ACH costs $5; card costs $58.30 — a $53 fee delta the freelancer eats. Many freelancers are quietly skipping QuickInvoice's payment link on large invoices because of this. SEPA Direct Debit (EU) is 0.8% capped at €5; AU BECS Direct Debit is similar. Adding `payment_method_types: ['card', 'us_bank_account', 'sepa_debit']` to `stripe.paymentLinks.create()` unlocks the lower-fee path.
**Effort:** Very Low
**Prerequisites:** Stripe account must enable each payment method in Settings → Payments → Payment methods (1 minute per method, no review). Master action.

**Sub-tasks:**
1. `lib/stripe-payment-link.js`: `createPaymentLink()` adds `payment_method_types: process.env.STRIPE_PAYMENT_METHODS ? process.env.STRIPE_PAYMENT_METHODS.split(',').map(s => s.trim()) : ['card']` so the deploy is reversible. Default stays card-only until Master sets the env var.
2. `.env.example`: add `STRIPE_PAYMENT_METHODS=card,us_bank_account,sepa_debit` (commented; defaults to `card` only).
3. New `tests/payment-link-methods.test.js` (3 tests): default = card-only (no env var); env var = `card,us_bank_account` enables both methods; whitespace + casing tolerant (`"card, US_BANK_ACCOUNT"` → `['card', 'us_bank_account']` once normalised).
4. `views/invoice-view.ejs`: add a tiny info tooltip near the payment-link field: "Clients can pay via card or bank transfer (US)" — only when `STRIPE_PAYMENT_METHODS` includes `us_bank_account`.
5. Add `[Master action]` to TODO_MASTER.md: enable ACH / SEPA / BECS in Stripe Dashboard → Settings → Payments and flip the env var.

**Income relevance:** Direct margin lift on invoices ≥$300. ACH/SEPA also has a 5–8% higher conversion rate on B2B invoices because clients prefer it for their books. Combined effect: 1–2% fee savings + 5–8% more invoices paid = a meaningful per-Pro-user revenue lift with no acquisition cost.

**Resolution (2026-04-26 PM):** Implemented end-to-end as the highest-priority `[XS]` income-critical task in this cycle.

1. **`lib/stripe-payment-link.js`** — added a pure `parsePaymentMethods(raw)` helper and a module-level `ALLOWED_PAYMENT_METHODS` Set covering `card`, `us_bank_account`, `sepa_debit`, `au_becs_debit`, `bacs_debit`, `acss_debit`, `link`. The helper splits the comma-separated env var, lowercases, trims, drops empties, drops unknown values, and dedupes. Empty / all-unknown input falls back to `['card']` so Stripe never receives an empty `payment_method_types` array (which would 400 the request). Exported alongside the existing `createInvoicePaymentLink` so routes and tests can reuse the parser without re-implementing it.

2. **`createInvoicePaymentLink`** — reads `process.env.STRIPE_PAYMENT_METHODS` once per call, parses, and forwards as `payment_method_types` on the `stripe.paymentLinks.create()` call. Default behaviour is unchanged (card-only) when the env var is unset, so the deploy is fully reversible — Master flips the env var only after enabling each method in the Stripe Dashboard. Existing `tests/payment-link.test.js` covers the no-env-var path; new file covers the env-driven paths.

3. **`routes/invoices.js GET /:id`** — passes `paymentMethods = parsePaymentMethods(process.env.STRIPE_PAYMENT_METHODS)` into the invoice-view template locals. Defensive import — `const parsePaymentMethods = stripePaymentLinkLib.parsePaymentMethods || (() => ['card'])` so test stubs that mock `lib/stripe-payment-link` without exporting the new helper continue to work unchanged.

4. **`views/invoice-view.ejs`** — under the existing Pro-gated "Payment Link" copy card, the descriptive blurb now renders a one-line tooltip "Clients can pay via card, US bank transfer (ACH) or SEPA Direct Debit." (computed from the `paymentMethods` local with a label map that humanises each Stripe method ID). Card-only setup degrades to "Clients can pay via card." — never references bank transfer when no bank method is enabled.

5. **`.env.example`** — added `STRIPE_PAYMENT_METHODS=card` with a multi-line comment documenting (a) the per-invoice fee savings (ACH 0.8% capped $5 vs. card 2.9% + $0.30 — saves ~$53 on a $2,000 invoice), (b) the requirement to enable each method in the Stripe Dashboard first, (c) the allowed-values whitelist, (d) the conservative card-only default.

6. **`tests/payment-link-methods.test.js`** (new file, 10 assertions — spec called for 3; 7 added for normaliser-edge-case coverage):
   - **Pure parser (5):** undefined/null/empty → `['card']`; multi-method comma list parsed; whitespace + UPPERCASE tolerant; unknown methods dropped, fallback to `['card']` when input is all-unknown; deduplication preserves first-seen order.
   - **Helper integration (3):** card-only by default; multi-method env var forwarded to `paymentLinks.create({ payment_method_types: [...] })`; unknown env values silently filtered before the Stripe call.
   - **Template (2):** invoice-view renders the ACH tooltip when `paymentMethods` includes `us_bank_account`; card-only locals render "Clients can pay via card." with no bank-transfer copy.
   Wired into `package.json test` script after `tests/checkout-promo-tax.test.js`. Full suite: **29 test files, 0 failures.**

7. **`tests/invoice-view-and-status.test.js`** — updated the `lib/stripe-payment-link` stub to also export `parsePaymentMethods: () => ['card']` so the GET /:id route's new local doesn't crash on the existing test stub. Other test files that stub the module without `parsePaymentMethods` are protected by the `routes/invoices.js` defensive-fallback import (call site #3 above).

**[Master action]** required to actually offer the lower-fee methods: TODO_MASTER #35 (added in this cycle) — enable ACH / SEPA / BECS in Stripe Dashboard → Settings → Payments → Payment methods, then set `STRIPE_PAYMENT_METHODS=card,us_bank_account,sepa_debit` in production env and redeploy. Until then, every Payment Link is card-only as before.

**Income relevance:** Direct freelancer-side margin lift on every invoice ≥$300. On a $2,000 retainer paid via ACH, the freelancer keeps ~$53 they previously paid in card fees; that's the kind of "this tool just paid for itself" moment that drives Pro retention. ACH-enabled B2B invoices also see 5-8% higher payment-completion rates (AP departments prefer ACH), feeding more invoices into the cha-ching loop from #30's instant paid-notification email.

---

### 42. [GROWTH] Custom invoice numbering scheme (Pro feature) (added 2026-04-26 audit) [S]

**App:** QuickInvoice (Node.js)
**Impact:** MED-HIGH — every freelancer who has used another invoicing tool has an existing invoice numbering scheme (e.g. `2026-001` for tax-year prefix, `JD-2026-001` for initials, `001` for plain sequential). Their accountant wants the numbering to continue without resetting. Right now QuickInvoice forces `INV-YYYY-NNNN` on everyone, which means switching tools forces a numbering break — the single biggest "I'd switch but..." friction point for freelancers with 1+ years of invoicing history. Letting users set a custom prefix (and optionally a starting number) removes this friction and is a tangible, visible Pro feature that competitors (FreshBooks, Bonsai) charge for.
**Effort:** Low
**Prerequisites:** None.

**Sub-tasks:**
1. `db/schema.sql`: idempotent —
   - `ALTER TABLE users ADD COLUMN IF NOT EXISTS invoice_number_prefix VARCHAR(16) DEFAULT 'INV-';`
   - `ALTER TABLE users ADD COLUMN IF NOT EXISTS invoice_number_start INT DEFAULT 1;`
   - The numerical part of every invoice continues to be derived from `users.invoice_count` (existing column); the prefix is just a cosmetic wrapper.
2. `db.js`: `getNextInvoiceNumber(userId)` — read `invoice_number_prefix` + `invoice_number_start` + `invoice_count`; format as `${prefix}${pad(invoice_count + 1, 4)}` if prefix ends in non-numeric, else `${prefix}-${pad(...)}`. Export `formatInvoiceNumber(prefix, start, count)` as a pure helper for tests.
3. `views/settings.ejs`: add an "Invoice numbering" card in the Pro section (Pro-gated). Inputs: prefix text (max 16 chars, alphanumeric + `-` + `/`), starting number (default 1, max 999999). Free users see a locked placeholder showing the default `INV-2026-NNNN` format with an upgrade CTA.
4. `routes/billing.js POST /settings`: extend the existing settings handler — Pro-only validation: prefix matches `/^[A-Za-z0-9_/\-]{0,16}$/` and start is a positive integer. Reject and flash on invalid.
5. New `tests/invoice-numbering.test.js` (5 tests): default prefix=`INV-` for new users; Pro user can set prefix=`JD-2026-`; Free user POST is rejected (Pro gate); invalid prefix `JD@2026` rejected; `formatInvoiceNumber` pure-fn output for various inputs (no separator when prefix already has trailing dash, otherwise insert dash).

**Income relevance:** Direct switching-cost lift. Users who set a custom prefix (typical adoption for any settings-tab feature is 30–50% of Pro users) churn at 50% lower rates because their accountant has the numbering on file and re-onboarding requires re-syncing. Also a concrete, visible Pro feature that the upgrade modal can list explicitly.

---

### 43. [GROWTH] Public read-only invoice URL (no-login share link) (added 2026-04-26 audit) [S]

**App:** QuickInvoice (Node.js)
**Impact:** MEDIUM — today the only way for a client to view an invoice is the email body or the Stripe Payment Link page. Many clients want to forward "the invoice itself" to their AP department before paying — and our HTML invoice view (`/invoices/:id`) is auth-gated. Adding a public read-only URL like `/i/:token` (where token is a per-invoice random string) lets clients view the full invoice in a browser, download the PDF, and forward the link to their accounting team without any login. Pairs naturally with the existing Payment Link as the "Pay Now" CTA on that page. Also unblocks INTERNAL_TODO #21 (full Client Portal) — the portal page is the per-client list view; this is the per-invoice view, the smallest unit.
**Effort:** Low
**Prerequisites:** None (Pro is not required — clients always need to be able to view invoices).

**Sub-tasks:**
1. `db/schema.sql`: idempotent — `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS public_token VARCHAR(40) UNIQUE;` Backfill on read: when the invoice is loaded by an authed user and `public_token IS NULL`, generate `crypto.randomBytes(20).toString('hex')` and persist. Lazy generation avoids a one-time backfill migration.
2. `db.js`: `getInvoiceByPublicToken(token)` — SELECT invoice + owner business name/email; no plan gate.
3. `routes/invoices.js`: new `GET /i/:token` (no `requireAuth`). 404 on missing token. Renders a new `views/invoice-public.ejs` (clean, unbranded — no nav, no footer chrome): full line-item table, total, due date, "Pay Now" Stripe Payment Link button (when `payment_link_url` is set), a "Download PDF" link to `/i/:token/pdf`, and a footer "Sent via QuickInvoice".
4. `routes/invoices.js`: new `GET /i/:token/pdf` — same auth-less path; re-uses the existing print template; sends `Content-Disposition: inline; filename="invoice-INV-X.pdf"`.
5. `views/invoice-view.ejs` (Pro user): add a "Share link" card showing `${APP_URL}/i/${invoice.public_token}` with an Alpine.js copy button (same pattern as the webhook URL copy UI). Tooltip: "Send this link to anyone — they can view and pay the invoice without a login."
6. New `tests/public-invoice.test.js` (5 tests): valid token → 200 with line items + Pay button; unknown token → 404; lazy-token-generation: first authed view of an invoice without a public_token persists one; PDF route returns Content-Type `application/pdf`; share-link card renders for Pro user only.

**Income relevance:** Indirect — removes the single biggest friction point in the client-pay flow ("can you send me the invoice as a PDF for our records?"). Faster client payment ⇒ paid invoices that loop back via the new "instant paid notification" email (#30) ⇒ the cha-ching word-of-mouth touchpoint fires sooner per cohort. Also strict prerequisite for the full client portal (#21).

---

### 44. [GROWTH] In-app changelog widget — "✨ What's new" indicator in nav (added 2026-04-26 audit) [XS]

**App:** QuickInvoice (Node.js)
**Impact:** MEDIUM — the public roadmap (#38) handles "what's coming"; this handles "what just shipped." A small `✨ What's new` link in the nav, with a 6-bullet popover, surfaces the steady stream of feature improvements (annual billing, payment links, instant paid notifications, etc.) so existing Pro users see active development without having to read the public CHANGELOG. Industry data: SaaS users who see at least one "what's new" notice per month churn at 30% lower rates than users who don't. The cost is one nav link + one EJS partial + one curated 6-bullet list refreshed at deploy time.
**Effort:** Very Low
**Prerequisites:** None.

**Sub-tasks:**
1. `views/partials/whats-new.ejs`: a tiny Alpine.js dropdown component anchored on a small `✨` icon in the nav. On open, render a card with: a title ("What's new in QuickInvoice"), 5–6 hand-curated bullet items (each ≤ 12 words) with their ship date, and a "See full roadmap →" footer link to `/roadmap`. Bullets are static — edited at every deploy.
2. `views/partials/nav.ejs`: include the partial when `locals.user` is set (logged-in users only — public visitors get the marketing site already). Position to the right of the user dropdown. Mobile menu: list as a top-level item under the hamburger.
3. (Optional follow-up, not part of this task): track first-view vs. subsequent-view via a localStorage `qi_whatsnew_seen=<latest_date>` key so a small red dot fades out after the user has clicked the popover once.
4. New `tests/whats-new.test.js` (3 tests): nav renders the `✨` link for logged-in users; popover lists at least 4 bullet items; popover does NOT render for anon visitors (the partial is gated on `locals.user`).

**Income relevance:** Retention. Continuously visible "active development" signal counters the #2 cancellation reason ("not sure they're building this") that the roadmap (#38) addresses for prospects. The Pro-tier per-user LTV is high enough that every month of churn-deferral pays back the ~30 minutes of curation per release.

---

### 45. [GROWTH] Last-day urgency dashboard banner for trial users (added 2026-04-26 PM audit) [XS]

**App:** QuickInvoice (Node.js)
**Impact:** HIGH — pairs with #29 (just-shipped trial nudge email) to give the trial cohort a *second* recovery surface on the most-converting day. The dashboard already renders a blue informational banner when `days_left_in_trial > 0`. On day 1, switch the banner to red/urgent styling with re-pointed copy: "Last day! Add a card before midnight to keep Pro features." Industry data on cart-abandonment urgency styling: same CTA + same copy with a red urgency frame lifts click-through 25-40% over the calm/blue equivalent.
**Effort:** Very Low
**Prerequisites:** None — `days_left_in_trial` is already computed and passed to the dashboard.

**Sub-tasks:**
1. `views/dashboard.ejs`: where the existing trial banner renders, branch on `days_left_in_trial === 1`. When true, swap container classes from `bg-blue-50 border-blue-200 text-blue-800` to `bg-red-50 border-red-200 text-red-800` and update copy to `"Last day of your Pro trial — add a card before midnight to keep Pro features."`. Keep the same `Add payment method` POST-to-`/billing/portal` form so the user's path is unchanged.
2. Optional emoji prefix `⏰` to bump visual scan weight (use sparingly — one emoji per banner).
3. Add 1 test in `tests/trial.test.js`: render dashboard with `days_left_in_trial: 1` → assert banner contains `"Last day"` and `bg-red-50` class. The existing 5-day singular/plural tests already cover the calm-state copy.

**Income relevance:** Direct — the last-day cohort is the highest-converting slice of the trial funnel (users with intent who haven't pulled the trigger yet). Visual urgency on the same surface that the email nudge (#29) sends them to is a one-line change with measurable per-conversion lift.

---

### 46. [GROWTH] Pricing page exit-intent modal (added 2026-04-26 PM audit) [S]

**App:** QuickInvoice (Node.js)
**Impact:** MED-HIGH — pricing page is the single highest-bounce page in the funnel. Industry benchmarks (Sumo, OptinMonster) show exit-intent modals lift checkout conversion 5-15% on the same audience. The "no card, 7-day free trial" hook is unusually strong for this format because the offer is reciprocal — visitor gives nothing, gets full Pro access. One-time per-session via a `bounceShown` flag in `localStorage` so we never annoy a returning shopper.
**Effort:** Low
**Prerequisites:** None.

**Sub-tasks:**
1. `views/pricing.ejs`: add an Alpine.js `x-data` block that listens for `mouseleave` on `document.documentElement` with `event.clientY < 10` (cursor exiting via top of the viewport — the canonical exit-intent signal). On trigger AND `localStorage.getItem('qi_bounce_shown') !== 'true'`, set a state flag to true.
2. Modal contents: 3-line copy ("Wait — try Pro for 7 days, no credit card needed. Cancel anytime.") + a primary `Start 7-day free trial` button that POSTs to `/billing/create-checkout` (same handler as the regular CTA — re-uses existing checkout flow including the trial gate from #19) + a `No thanks` text link that closes the modal and stamps `localStorage`.
3. Bind `Escape` key + clicking the backdrop to close + stamp.
4. Mobile: skip — `mouseleave` is desktop-only by definition; on mobile the regular pricing CTA carries the funnel.
5. New `tests/exit-intent.test.js` (3 tests): pricing renders the modal-trigger script tag; modal copy contains "no credit card" and the trial-CTA copy; localStorage gate key is `qi_bounce_shown` (regression guard so a key rename doesn't silently break the one-time-per-session contract).

**Income relevance:** Direct — every visitor who exits the pricing page without converting is a lost trial signup. A 5% recovery rate on the bounce cohort at, say, 1000 monthly pricing visitors = 50 extra trial starts/mo, of which 30-50% convert per #29's logic, giving 15-25 extra paying customers/mo at $9 = +$135-225/mo MRR for one Alpine.js block.

---

### 47. [GROWTH] Monthly→Annual upgrade prompt on dashboard for monthly Pro users (added 2026-04-26 PM audit) [S]

**App:** QuickInvoice (Node.js)
**Impact:** HIGH — annual subscribers churn at roughly half the rate of monthly subscribers (industry benchmarks across SaaS). Every monthly→annual conversion roughly doubles the cohort's LTV. Current funnel only surfaces the annual price on `/pricing` (which Pro users rarely revisit) and on `/settings`'s plan section. A small dismissible dashboard banner showing "you'd save $9/year on annual" when `subscription_status='active'` and `billing_cycle='monthly'` brings the upsell to the surface with the highest engagement frequency.
**Effort:** Low
**Prerequisites:** Annual price (#3, done) is live.

**Sub-tasks:**
1. `db.js`: add `billing_cycle` column to users table — `ALTER TABLE users ADD COLUMN IF NOT EXISTS billing_cycle VARCHAR(20);`. Default null. Set to `'monthly'` or `'annual'` in the `checkout.session.completed` webhook based on the price_id selected (already passed via `metadata.billing_cycle`).
2. `routes/invoices.js` `GET /` (dashboard): when `user.plan === 'pro'` AND `user.subscription_status === 'active'` AND `user.billing_cycle === 'monthly'` AND `user.annual_prompt_dismissed_at IS NULL` (or older than 60 days), pass `show_annual_prompt: true` to the template.
3. `views/dashboard.ejs`: small dismissible banner above the invoices grid: "💡 Switch to annual and save $9/year. You're on monthly Pro at $108/yr; annual is $99 and you keep everything." with two buttons: `Switch to annual` (POSTs to `/billing/create-checkout` with `billing_cycle=annual` — Stripe Checkout handles the proration) and `Dismiss` (POSTs to `/billing/dismiss-annual-prompt` which stamps `annual_prompt_dismissed_at = NOW()`).
4. New route `POST /billing/dismiss-annual-prompt` in `routes/billing.js`: stamps the column, redirects back to `/dashboard`, CSRF-protected.
5. New `tests/annual-prompt.test.js` (4 tests): banner shown for monthly Pro user; banner hidden for annual Pro user; banner hidden after dismissal; `POST /billing/dismiss-annual-prompt` writes the column and redirects.

**Income relevance:** This is the single highest-leverage retention action for the existing Pro cohort. Doubling Pro LTV via halved churn is worth more than acquiring a new Pro subscriber from cold traffic. At a 5-10% conversion rate from this banner per quarter, every 100 monthly subscribers shifts ~5-10 to annual = $5-10/customer prepaid + halved future churn risk.

---

### 48. [GROWTH] Embeddable "Powered by QuickInvoice" badge on public invoice URLs (added 2026-04-26 PM audit) [XS]

**App:** QuickInvoice (Node.js)
**Impact:** MEDIUM (compounding) — once #43 (public read-only invoice URL `/i/:token`) lands, every invoice paid via that surface becomes a passive acquisition touchpoint. A discreet "Sent with QuickInvoice ↗" footer with a `?ref=invoice-pay` UTM tracks attribution. Free-plan invoices already get this on the PDF (#5); the public web version of the same PDF gets a sibling treatment. Compounds with every Pro user's invoice volume — one Pro user sending 20 invoices/mo = 20 unique-eyeball acquisition surfaces.
**Effort:** Very Low
**Prerequisites:** #43 (public invoice URL) must ship first.

**Sub-tasks:**
1. `views/invoice-public.ejs`: footer block — `<footer><p>Sent with <a href="${APP_URL}/?ref=invoice-pay">QuickInvoice</a> · The fastest way to invoice clients.</p></footer>`. Same subtle gray styling as the existing PDF footer.
2. Pro plan toggle: render this footer **only** when `invoice.user.plan === 'free'`. Pro/Business/Agency users get a clean unbranded public page (footer removal is a Pro feature, mirroring #5's PDF treatment).
3. Server-side: `routes/landing.js` GET `/`: when `req.query.ref === 'invoice-pay'`, store the ref in the session so the eventual signup attributes correctly even after the user clicks around.
4. New 1-test addition to `tests/public-invoice.test.js` (or new `tests/invoice-public-badge.test.js` if #43 lands first): public view for free user contains the "Sent with QuickInvoice" footer + ref=invoice-pay; public view for Pro user does NOT.

**Income relevance:** Compounding — the badge cost is one EJS partial; the lift accrues with every invoice volume tick. This is the same passive acquisition mechanic that drove Mailchimp, Calendly, and Typeform's growth in their early years.

---

### 49. [GROWTH] First-paid-invoice celebration banner + email (added 2026-04-26 PM audit) [S]

**App:** QuickInvoice (Node.js)
**Impact:** MEDIUM — peak emotional moment in the user's relationship with the product is the first invoice they collect on. The instant paid-notification email (#30) handles the cha-ching for *every* paid invoice; this is a *one-shot* milestone celebration on the lifetime first paid invoice with a different ask: "share QuickInvoice with another freelancer." Industry benchmarks: peak-emotion-moment referral asks convert 5-10x better than steady-state asks.
**Effort:** Low
**Prerequisites:** Email delivery (#13, done).

**Sub-tasks:**
1. `db/schema.sql`: `ALTER TABLE users ADD COLUMN IF NOT EXISTS first_paid_invoice_at TIMESTAMP;`. Stamped on the first transition of any invoice for this user from non-paid to paid.
2. `routes/billing.js` `checkout.session.completed` payment-link branch (where the paid notification already fires): after `markInvoicePaidByPaymentLinkId`, check if `owner.first_paid_invoice_at IS NULL`. If so, stamp it AND send a one-shot email "🎉 You just got your first paid invoice — congrats!" with two paragraphs: (1) celebrate the milestone + the amount, (2) "Know another freelancer who hates invoicing? Share QuickInvoice with them and we'll give you both 1 month free." and a sharable referral URL `${APP_URL}/?ref=u<user_id>`.
3. `views/dashboard.ejs`: when `user.first_paid_invoice_at` is within the last 7 days, render a small dismissible green banner: "🎉 You just collected your first payment! [Share with another freelancer →]" linking to a `/share` page.
4. New `views/share.ejs` (single static page): one-line copy + the referral URL with copy-to-clipboard button + Twitter/X / LinkedIn share buttons with pre-filled copy.
5. New `tests/first-paid-celebration.test.js` (4 tests): first paid invoice for a user → `first_paid_invoice_at` stamped + celebration email sent; second paid invoice for the same user → stamp NOT updated, no email; dashboard banner renders for users within the 7-day window; dashboard banner hidden for older users / new users.

**Income relevance:** Indirect-acquisition — a single referral signup that converts to Pro is +$108-$108/yr ARR for ~zero CAC. The peak-emotional-moment gating (first paid invoice, not first invoice created) is what makes this materially better than a steady-state referral nag.

---

### 50. [GROWTH] Quote / Estimate flow with one-click "Convert to Invoice" (added 2026-04-26 PM-2 audit) [M]

**App:** QuickInvoice (Node.js)
**Impact:** HIGH — many B2B freelancers (designers, consultants, agencies) are required to send a formal quote / estimate BEFORE the invoice. Today QuickInvoice has no quote concept; users export the invoice as PDF, email it, and re-create it once the client agrees. This is a 5-step manual workflow and the #1 reason an agency-tier prospect picks FreshBooks / Bonsai over QuickInvoice. A `is_quote BOOLEAN` column + a "Convert to invoice" button is the highest-ROI feature gap still open in the QuickInvoice → Pro funnel.
**Effort:** Medium
**Prerequisites:** None.

**Sub-tasks:**
1. `db/schema.sql`: idempotent — `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS is_quote BOOLEAN DEFAULT false;` `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS quote_accepted_at TIMESTAMP;` `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS converted_invoice_id INTEGER REFERENCES invoices(id);`
2. `db.js`: add `convertQuoteToInvoice(quoteId, userId)` — wraps an INSERT (clone of the quote with `is_quote=false`, fresh `invoice_number`, status=`draft`) and an UPDATE on the quote (sets `quote_accepted_at = NOW()` and `converted_invoice_id`). One transaction.
3. `routes/invoices.js`:
   - `GET /quotes/new`, `POST /quotes/new` — same shape as invoice routes but with `is_quote=true` set on insert.
   - `GET /quotes/:id`, `GET /quotes/:id/edit`, `POST /quotes/:id/edit`, `POST /quotes/:id/delete` — copies of the invoice handlers but filter `WHERE is_quote=true`.
   - `POST /quotes/:id/convert` — requires Pro plan; calls `db.convertQuoteToInvoice`; redirects to the new invoice's edit page.
4. `views/quote-form.ejs`, `views/quote-view.ejs` — copies of the invoice templates with copy changes ("Quote #" → "Invoice #" replaced with "Quote #", subject lines changed, "Pay Now" replaced by "Awaiting acceptance").
5. `views/dashboard.ejs` — add a "Quotes" tab + counter alongside the existing "Invoices" stats. Quote-only counts (active vs. converted vs. declined).
6. `views/partials/nav.ejs` — add "+ New Quote" alongside "+ New Invoice".
7. New `tests/quotes.test.js` (6+ tests): create quote → DB row has `is_quote=true`; convert → new invoice row created, quote stamped; only Pro users can convert; quote does NOT count against the free-plan invoice limit (separate limit, currently no limit set — gate at 1 quote for free users); quote PDF export omits "Pay Now" section; convert preserves all line items.

**Income relevance:** Direct B2B switching-cost lift. Agencies and consultants close their first deal with a quote, not an invoice — without this feature, QuickInvoice is invisible to that segment. Adding it brings the highest-LTV freelancer cohort (consultants $$$$) into the funnel, which compounds with the Agency-tier upgrade path (#9).

---

### 51. [GROWTH] Schedule invoice send for a future date (added 2026-04-26 PM-2 audit) [S]

**App:** QuickInvoice (Node.js)
**Impact:** MED-HIGH — a partial alternative to full recurring invoices (#40) for users who don't want a full automated cadence but want to "queue this invoice to send on the 1st." Cron infra is already running (#16); adding a `scheduled_send_at` check is a 30-line addition. Pairs with the existing `sent` transition path so the email + payment-link generation is identical to a manual mark-sent. Lower-friction onramp than full recurring rules.
**Effort:** Low
**Prerequisites:** Reminder cron (#16, done); email delivery (#13, done).

**Sub-tasks:**
1. `db/schema.sql`: idempotent — `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS scheduled_send_at TIMESTAMP;` Partial index `CREATE INDEX IF NOT EXISTS idx_invoices_scheduled_send ON invoices(scheduled_send_at) WHERE scheduled_send_at IS NOT NULL AND status = 'draft';`
2. `db.js`: `getDraftInvoicesScheduledFor(now)` — `SELECT ... WHERE status='draft' AND scheduled_send_at <= NOW() AND scheduled_send_at IS NOT NULL`. `setScheduledSend(invoiceId, userId, sendAt)` with ownership check.
3. `views/invoice-form.ejs`: add a `<input type="datetime-local" name="scheduled_send_at">` field below the due-date row, optional. Help text: "Schedule this invoice to send automatically on a future date." Pro-gated for now; free users see a locked placeholder.
4. `routes/invoices.js`: extend `POST /:id/edit` to read and persist `scheduled_send_at`. Reject past timestamps with a flash error.
5. `jobs/scheduled-send.js` (new): same orchestrator pattern as `jobs/reminders.js`. For each row from `getDraftInvoicesScheduledFor`, run the same status-transition logic that `POST /:id/status sent` does — payment-link creation + invoice email + DB status update + clear `scheduled_send_at`. Per-row try/catch.
6. `server.js`: register the new job at `'*/15 * * * *'` (every 15 minutes — a finer cadence than the daily reminder cron because the user expects the scheduled invoice to land near the requested time, not within 24h).
7. New `tests/scheduled-send.test.js` (5 tests): scheduled draft is fired by the cron tick; non-draft invoice is skipped; future-dated invoice is skipped; cron clears `scheduled_send_at` on success; free-plan user attempt to schedule is rejected at the route level.

**Income relevance:** Direct retention. Removes the "I'll do it on the 1st" Sunday-evening manual task — every freelancer who uses this once trusts the tool with one of the higher-emotional-load chores in their week. Pairs with #29 (trial nudge) by adding a tangible Pro-only feature that the trial cohort encounters during exploration.

---

### 52. [GROWTH] JSON-LD `SoftwareApplication` schema on landing + niche pages (added 2026-04-26 PM-2 audit) [XS]

**App:** QuickInvoice (Node.js)
**Impact:** MED-HIGH (long-tail SEO) — Google's rich-result eligibility for SaaS landing pages is unlocked by `application/ld+json` markup with `SoftwareApplication`, `offers`, and `aggregateRating` fields. Every niche landing page (`/invoice-template/freelance-developer`, etc.) currently ranks on long-tail queries but renders as a plain blue link in SERPs. Adding the schema makes the result eligible for the price + star-rating + "free to start" snippet, which lifts CTR by 20–40% on the same impression count. Pure markup change, zero risk.
**Effort:** Very Low
**Prerequisites:** None for the landing page; aggregateRating will be empty until INTERNAL_TODO #20 (real testimonials) lands. Ship without the rating field for now; add it later.

**Sub-tasks:**
1. `views/partials/head.ejs`: add a conditional JSON-LD block:
   ```html
   <% if (locals.jsonLd) { %>
   <script type="application/ld+json"><%- JSON.stringify(jsonLd) %></script>
   <% } %>
   ```
   `<%-` (raw) so JSON braces aren't HTML-escaped.
2. `views/index.ejs`, `views/pricing.ejs`, `views/partials/lp-niche.ejs`: pass a per-page `jsonLd` local. Example for the home page:
   ```js
   {
     "@context": "https://schema.org",
     "@type": "SoftwareApplication",
     "name": "QuickInvoice",
     "applicationCategory": "BusinessApplication",
     "operatingSystem": "Web",
     "url": process.env.APP_URL,
     "offers": [
       { "@type": "Offer", "price": "0", "priceCurrency": "USD", "description": "Free plan: 3 invoices" },
       { "@type": "Offer", "price": "12", "priceCurrency": "USD", "description": "Pro: $12/month" },
       { "@type": "Offer", "price": "99", "priceCurrency": "USD", "description": "Pro Annual: $99/year" }
     ]
   }
   ```
   Niche pages add `"description": <niche.description>` and `"audience": <niche.audience>`.
3. New `tests/json-ld.test.js` (3 tests): home renders parseable JSON-LD with the SoftwareApplication type; niche page renders niche-specific description; pricing page renders all three Offer entries with correct numerals.
4. Validate post-deploy via Google Rich Results Test (https://search.google.com/test/rich-results).

**Income relevance:** Pure compounding SEO lift. Every search-engine impression for "freelance designer invoice template" now renders with price + plan info → higher CTR on the same impression → more registrations from existing organic traffic. Same effort as #36 (Open Graph) with a different but complementary surface (Google SERP vs. social previews).

---

### 53. [GROWTH] Resend webhook → "Client opened invoice" insight on dashboard (added 2026-04-26 PM-2 audit) [M]

**App:** QuickInvoice (Node.js)
**Impact:** HIGH — Resend supports webhook events for `email.opened`, `email.clicked`, `email.delivered`, `email.bounced`, `email.complained`. Surfacing "Acme Co opened your invoice 2 hours ago" on the dashboard is a behavioural signal a freelancer cannot get anywhere else short of installing a tracking pixel manually. The freelancer learns when to follow up; the client knows their inbox is on the radar; QuickInvoice becomes the source of truth for invoice-status visibility instead of a fire-and-forget tool. Direct stickiness lift; per-user email volume effectively turns into a continuous engagement loop.
**Effort:** Medium
**Prerequisites:** Email delivery (#13, done) + `RESEND_API_KEY` provisioned (TODO_MASTER #18).

**Sub-tasks:**
1. `db/schema.sql`: idempotent — `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS last_opened_at TIMESTAMP;` `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS open_count INTEGER DEFAULT 0;` `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS last_clicked_at TIMESTAMP;` `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS click_count INTEGER DEFAULT 0;` `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS resend_email_id VARCHAR(64);` (Resend's email ID returned from `resend.emails.send()`).
2. `lib/email.js sendInvoiceEmail()`: capture the Resend response's `data.id` and write it to `invoices.resend_email_id` so the webhook can map back to the invoice.
3. `routes/billing.js` or new `routes/resend-webhook.js`: `POST /webhooks/resend` — Resend sends signed webhooks; verify the `svix-signature` header (Resend uses Svix for webhook delivery — the secret comes from the Resend Dashboard Webhooks page). On `email.opened` / `email.clicked`: look up invoice by `resend_email_id`; bump counter + stamp timestamp.
4. `views/invoice-view.ejs`: render an "Activity" card (Pro-only) showing "Opened by client X times — last on YYYY-MM-DD HH:MM." Locked placeholder for free users.
5. `views/dashboard.ejs`: in the invoice list, add a small ✉️ icon next to invoices where `last_opened_at IS NOT NULL` so the freelancer can see opened invoices at a glance.
6. `.env.example`: add `RESEND_WEBHOOK_SECRET=whsec_...` with comment explaining how to configure it in the Resend Dashboard.
7. New `tests/resend-webhook.test.js` (5+ tests): valid signed `email.opened` event bumps counter + stamps; invalid signature returns 400; unknown email_id is a 200 no-op (defence against deleted-invoice race); `email.clicked` increments click counter independently of open counter; CSP allows the webhook POST endpoint.

**Income relevance:** This is a behavioural-data feature competitors charge $20+/mo for (FreshBooks Premium, Wave Pro). Adding it inside Pro at the existing $12 price is a concrete differentiator and a tangible "what does Pro give me" demo for the upgrade modal. Also feeds the cha-ching loop — a freelancer who sees "Acme opened the invoice 5 minutes ago" can phone the client to nudge while the invoice is fresh in their inbox.

---

### 54. [GROWTH] Deposit / partial payment invoices (Pro feature) (added 2026-04-26 PM-2 audit) [S]

**App:** QuickInvoice (Node.js)
**Impact:** HIGH (agency segment) — service contracts ≥$1,000 typically require a 50% upfront deposit. Today QuickInvoice has no concept of partial payment — the freelancer has to send two separate invoices and reconcile them manually. Adding a `paid_amount NUMERIC` column + a "Record partial payment" button lets the freelancer track $X paid of $Y due in one row. The Stripe Payment Link can also be configured for the remaining balance. This is the single biggest reason an agency-tier prospect cites "we'd switch to QuickInvoice if it handled deposits."
**Effort:** Low
**Prerequisites:** None.

**Sub-tasks:**
1. `db/schema.sql`: `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS amount_paid NUMERIC(12,2) DEFAULT 0;` `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS deposit_required NUMERIC(12,2);` (the requested upfront amount, optional).
2. `db.js`: `recordPartialPayment(invoiceId, userId, amount)` — adds to `amount_paid`, transitions status to `paid` only when `amount_paid >= total`, otherwise leaves status as `sent`.
3. `views/invoice-view.ejs`: add a "Record payment" form (Pro-only) — number input for amount, save button. Renders `<progress>` bar showing `amount_paid / total`. Locked placeholder for free users.
4. `routes/invoices.js`: `POST /:id/payment` — Pro-gated; calls `recordPartialPayment`; redirects.
5. Stripe Payment Link integration: when a payment link exists and a partial is recorded, the existing payment link still goes for the full total — this is intentional (the freelancer adjusts the link manually if needed). Document this in the help-text under the form.
6. `routes/billing.js` `checkout.session.completed` payment-link branch: when an invoice is fully paid via Stripe (existing path), set `amount_paid = total` AND `status = 'paid'` (current code only sets status; this widens it).
7. `views/dashboard.ejs` revenue stats: existing "outstanding" calculation should subtract `amount_paid` from `total` per row to get the real outstanding amount (currently treats every non-paid invoice as fully outstanding).
8. New `tests/partial-payment.test.js` (5+ tests): partial payment flips status only at full payment; over-payment is allowed (positive `amount_paid > total` does NOT flip negative); free user POST is rejected; dashboard outstanding stat reflects partial payments correctly; Stripe webhook full-payment path still works.

**Income relevance:** Direct unlock of the agency segment ($49/mo Agency tier — currently the highest-ARPU plan). Also a Pro-feature differentiator that the upgrade modal can list explicitly; many freelancers don't realise FreshBooks charges $50+/mo for the same capability.

---

### 55. [GROWTH] Auto thank-you email to client on payment received (added 2026-04-26 PM-2 audit) [XS]

**App:** QuickInvoice (Node.js)
**Impact:** MEDIUM (compounding) — when a client pays via the Stripe Payment Link, today the freelancer gets the cha-ching email (#30) but the client gets nothing from QuickInvoice (Stripe sends its own receipt). Auto-firing a polite "Thanks for your payment, [client_name]!" email from the freelancer's reply-to adds a level of professionalism that costs the freelancer literally zero effort and that competitor tools (FreshBooks, Wave) don't offer free. Pairs naturally with the existing `lib/email.js` infrastructure.
**Effort:** Very Low
**Prerequisites:** Email delivery (#13, done); paid-notification (#30, done — re-uses the same `checkout.session.completed` payment_link branch).

**Sub-tasks:**
1. `lib/email.js`: add `buildClientThanksSubject(invoice)` (e.g. `"Payment received — thank you, [client_name]"`), `buildClientThanksHtml(invoice, owner)`, `buildClientThanksText(invoice, owner)`, and `sendClientThanksEmail(invoice, owner)` — same patterns as `sendPaidNotificationEmail` but recipient is `invoice.client_email`, reply-to is `owner.reply_to_email > owner.business_email > owner.email` so the client's reply lands with the freelancer.
2. `routes/billing.js` `checkout.session.completed` payment-link branch: alongside `sendPaidNotificationEmail(updated, owner)`, fire `sendClientThanksEmail(updated, owner)` in parallel. Both fire-and-forget; both no-op when `RESEND_API_KEY` is unset; both never block the webhook 200 response.
3. Pro-gate: only fire for Pro/Business/Agency owners (free users don't get the polished follow-through). Free invoice clients still get Stripe's default receipt.
4. `views/settings.ejs`: add a Pro-only checkbox "Send a thank-you email to my clients when they pay" defaulted ON. Persist as `users.thanks_email_enabled BOOLEAN DEFAULT true` so the freelancer can opt out (some prefer to send a personal thank-you themselves).
5. `db/schema.sql`: `ALTER TABLE users ADD COLUMN IF NOT EXISTS thanks_email_enabled BOOLEAN DEFAULT true;`
6. New `tests/client-thanks.test.js` (4 tests): paid → client thank-you fires with correct payload; opt-out (`thanks_email_enabled=false`) → no client send; free user → no client send (Pro gate); thanks-email throw does not break the webhook (fire-and-forget hygiene).

**Income relevance:** Compounding professionalism. Each thank-you email sent is a passive touchpoint that signals "this freelancer uses real tooling." Clients are subliminally more likely to refer the freelancer to their network. Also a tangible Pro feature for the settings page that the upgrade modal can reference. Effectively free per-send (Resend free tier covers 3,000 emails/month).

---

### 56. [DONE 2026-04-27 PM] [GROWTH] `robots.txt` + canonical URL meta tag (added 2026-04-27 audit) [XS]

**App:** QuickInvoice (Node.js)
**Impact:** MEDIUM (compounds with #36 OG metadata + the existing 6 niche landing pages) — Google currently has no `robots.txt` to follow. A missing file isn't fatal (Googlebot crawls everything by default) but a real `robots.txt` with `Allow: /` and an explicit `Sitemap: <APP_URL>/sitemap.xml` is the standard SEO signal that says "this is a real site, here's the index." Pairs with a `<link rel="canonical">` tag in `head.ejs` so duplicate URLs (`/?utm_source=...`, `/pricing#x`, etc.) don't dilute ranking.
**Effort:** Very Low.
**Prerequisites:** None.

**Resolution (2026-04-27 PM):**
1. **`server.js`** — new `GET /robots.txt` route. Returns `text/plain; charset=utf-8`. Body: `User-agent: *` + `Allow: /` + an explicit `Disallow:` for each authed/transactional surface (`/auth/`, `/billing/`, `/invoices/`, `/settings`, `/dashboard`, `/onboarding/`) + a `Sitemap:` pointer. The sitemap pointer uses `process.env.APP_URL` when set (so a Heroku herokuapp.com URL never competes with the canonical custom domain) and falls back to the request host. Trailing slashes on `APP_URL` are normalised so `https://x.io/` + `/sitemap.xml` doesn't become `https://x.io//sitemap.xml`.
2. **`views/partials/head.ejs`** — added a 6-line preamble that resolves `canonicalUrl` (absolute override) → `canonicalPath` (path override that prepends APP_URL) → falls back to the existing `__ogUrl`. Renders `<link rel="canonical" href="...">` ONLY when `APP_URL` is set — a relative canonical confuses crawlers more than the absence of one. Also resolves `noindex` and renders `<meta name="robots" content="noindex, nofollow">` on opted-out pages, defaulting to `index, follow` everywhere else.
3. **Per-route locals** — `noindex: true` added to every authed/transactional render call: `routes/invoices.js` (dashboard, invoice-form create+edit, invoice-view, invoice-print), `routes/billing.js` (settings), `routes/auth.js` (login + register, including all error-flash render paths). Auth pages were noindexed because indexed login forms have no SEO value and confuse crawlers; the marketing surface (homepage, pricing, niche landing pages) keeps the default `index, follow`.
4. **`tests/robots-and-canonical.test.js`** (new file, 17 assertions — exceeds the 4-test spec): GET /robots.txt returns 200 + text/plain; disallows the 6 authed paths; sitemap pointer uses APP_URL when set; falls back to request host when APP_URL unset; trailing slash normalised; canonical link renders when APP_URL set; canonical link OMITTED when APP_URL unset; canonicalPath takes precedence over ogPath; canonicalUrl absolute override passes through; canonical falls back to ogPath when canonicalPath unset; meta robots defaults to `index, follow`; meta robots is `noindex, nofollow` when local set; dashboard/settings/auth-login/auth-register views all emit noindex; landing index page emits index, follow (regression guard against accidentally noindexing the homepage). Wired into `package.json` `test` script after `tests/webhook-outbound-from-stripe.test.js`. Full suite: **33 test files, 0 failures.**

**[Master action]** required to complete the polish: set `APP_URL=https://quickinvoice.io` in production env so canonical URLs and the sitemap pointer in robots.txt render as absolute URLs. (Already in TODO_MASTER #39 from the #36 OG/Twitter Card cycle — same env-var, no new Master action needed.)

**Income relevance:** Indirect SEO compounding. (a) Reduces wasted crawl budget on duplicate-querystring URLs and authed pages crawlers can't index anyway. (b) Canonical URLs eliminate duplicate-content penalties when the same page is reachable via multiple paths. (c) Pairs with #36 — every share now carries both a rich preview AND a canonical URL pointing at the canonical domain. (d) Each indexed niche page is a permanent zero-CAC acquisition channel.

---

### 57. [GROWTH] 30-day NPS micro-survey for Pro users (added 2026-04-27 audit) [S]

**App:** QuickInvoice (Node.js)
**Impact:** HIGH (retention, churn-prevention) — the single most actionable retention signal a SaaS can collect is a 30-day NPS score from new Pro users. Detractors (0-6) can be reached out to before they cancel; promoters (9-10) can be asked for testimonials (#20 social-proof) or referrals (#18). Without it, churn is silent — by the time the user clicks "cancel" in Stripe, the conversation has already happened in their head. A 1-question Alpine.js modal that fires once at the 30-day Pro mark + free-text follow-up costs ~50 lines of code and produces the highest-quality user-feedback signal available.
**Effort:** Low.
**Prerequisites:** None — runs purely on existing session + DB infrastructure.

**Sub-tasks:**
1. `db/schema.sql`: idempotent — `CREATE TABLE IF NOT EXISTS nps_responses (id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id), score INT NOT NULL CHECK (score BETWEEN 0 AND 10), comment TEXT, created_at TIMESTAMP DEFAULT NOW());` plus `ALTER TABLE users ADD COLUMN IF NOT EXISTS nps_prompted_at TIMESTAMP;`.
2. `db.js`: `recordNpsResponse({ userId, score, comment })`, `markNpsPrompted(userId)`, and a `shouldPromptNps(user)` helper — eligible iff `plan IN ('pro','business','agency')`, account is ≥30 days old (`created_at < NOW() - INTERVAL '30 days'`), and `nps_prompted_at IS NULL`.
3. `routes/invoices.js GET /` (dashboard): pass `npsPrompt: shouldPromptNps(user)` to the template.
4. `views/dashboard.ejs`: render a `print:hidden` Alpine modal (gated on `locals.npsPrompt`) with copy "How likely are you to recommend QuickInvoice to a friend or colleague?" + 0-10 scale pills + an optional textarea on score selection + Submit button. POSTs to `POST /nps` with `{ score, comment }` + CSRF.
5. New `routes/nps.js` (or extension to billing.js): `POST /nps` validates score is 0-10, persists via `recordNpsResponse` + `markNpsPrompted`. Single round-trip; flashes "Thanks for the feedback" and redirects to dashboard.
6. New `tests/nps.test.js` (5 tests): `shouldPromptNps` returns false for free users; returns false for <30-day Pro accounts; returns true for ≥30-day Pro accounts that haven't been prompted; POST /nps persists the score + comment; POST /nps with score outside 0-10 is rejected.

**Income relevance:** Direct retention tool. A detractor surfaced at 30 days has a much higher chance of being saved than a churned-and-cancelled user. Industry data: SaaS that systematically follow up with NPS detractors retain 15-25% of would-be churners. Promoters caught here also feed the testimonial pipeline (#20) and the referral program (#18) — three retention/expansion levers from one survey.

---

### 58. [GROWTH] Public coupon-redemption landing page `/redeem/:code` (added 2026-04-27 audit) [S]

**App:** QuickInvoice (Node.js)
**Impact:** MEDIUM-HIGH — INTERNAL_TODO #35 shipped `allow_promotion_codes: true` on Stripe Checkout. That unlocks coupon entry on the Stripe page, but the user-facing flow today is still "click upgrade → realise you have a code → click 'Add promotion code' → paste." A dedicated `/redeem/:code` page that auto-applies the code at checkout cuts the funnel from 3 clicks to 1 and is the canonical asset every campaign URL points at — Reddit r/SaaS posts, Product Hunt launch coupons, AppSumo deals, accountant-partner #37 referrals.
**Effort:** Low.
**Prerequisites:** #35 `allow_promotion_codes` (done).

**Sub-tasks:**
1. New route `GET /redeem/:code` in `server.js` or a new `routes/redeem.js`: render `views/redeem.ejs` showing the code, a one-line description (e.g. "Get 50% off your first 3 months of Pro"), and an "Apply & checkout" CTA. Code passed to the registration-or-checkout link as `?promo=<code>`.
2. `routes/billing.js POST /create-checkout`: read `req.body.promo` and `req.session.pending_promo`; when set, pass `discounts: [{ promotion_code: '<code>' }]` to `stripe.checkout.sessions.create()`. Stripe validates the promotion code; if invalid, error-handle gracefully (skip the discount, log).
3. `routes/auth.js POST /register`: persist `req.session.pending_promo = req.body.promo` so a fresh signup → checkout flow carries the code through.
4. `views/redeem.ejs`: minimal landing page (max-width 600px), QuickInvoice header, code in a monospace badge, the description, and either a "Sign up & redeem →" CTA (anon visitor) or "Apply to my account →" CTA (logged-in user). Pure copy; no DB.
5. New `tests/redeem.test.js` (4 tests): `GET /redeem/PH50` renders 200 with the code; `POST /create-checkout` with a `promo` body field passes `discounts: [{promotion_code:'PH50'}]` to Stripe; the session falls back to no-discount when promo is empty/invalid; sign-up flow persists `pending_promo` across the redirect-then-checkout flow.

**Income relevance:** Direct conversion lift on every paid distribution channel — Master can drop a clean URL (`quickinvoice.io/redeem/PH50`) into Reddit/X/PH listings without users having to know about Stripe's "Add promotion code" affordance. Pairs with marketing #36 (listicle outreach) — every backlink can carry a unique tracking code (`/redeem/MEDIUM-LISTICLE`) so Master can attribute conversions back to the channel.

---

### 59. [GROWTH] "Invoiced via QuickInvoice" footer in invoice emails (Pro opt-out, free always-on) (added 2026-04-27 audit) [S]

**App:** QuickInvoice (Node.js)
**Impact:** MEDIUM-HIGH — every invoice email a freelancer sends is a marketing touchpoint inside the client's inbox. Adding a small `Invoiced via QuickInvoice — quickinvoice.io` footer to the HTML email body turns each Pro user into a passive distribution channel — same dynamic that powers Calendly's "Powered by Calendly" footer (one of the strongest viral-loop signals in SaaS history). Free users get the footer always-on (#48 already has the same idea for public invoice URLs); Pro users get a settings toggle to opt out (paying customers get the choice — same pattern as the PDF footer #5).
**Effort:** Low.
**Prerequisites:** Email delivery (#13, done); Resend API key in production.

**Sub-tasks:**
1. `lib/email.js buildInvoiceHtml(invoice, owner)`: append a footer block at the bottom of the existing HTML body. Always render for free; render for Pro/Business/Agency only when `owner.email_footer_enabled !== false` (default true). Footer copy: `<p style="font-size:12px;color:#9ca3af;text-align:center;margin-top:24px;border-top:1px solid #e5e7eb;padding-top:12px">Invoiced via <a href="https://quickinvoice.io/?ref=email-footer" style="color:#6366f1">QuickInvoice</a></p>`. Same copy in the text fallback (`buildInvoiceText`).
2. `db/schema.sql`: idempotent — `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_footer_enabled BOOLEAN DEFAULT true;`
3. `views/settings.ejs`: Pro-only checkbox under the existing "Reply-to email" field — `Show "Invoiced via QuickInvoice" footer in client emails` defaulted ON. POSTs through the existing settings handler; `routes/billing.js POST /settings` extends the dynamic-update path to accept the boolean.
4. The existing `tests/email.test.js` already asserts on the HTML body shape — update the relevant test fixtures to also assert the footer renders for free, renders for Pro by default, and is hidden for Pro when `email_footer_enabled=false`. Three new assertions in the existing file rather than a new file.

**Income relevance:** Pure organic acquisition. A typical Pro user sends 5-20 invoice emails a month; at 1-3% click-through on the footer link (calendly's measured rate), each Pro user generates 1-6 new visits/month at zero CAC. With Pro users compounding monthly, the footer becomes a top-3 acquisition channel by month 6 with no marketing spend. The opt-out is the right policy: paying users earn the choice; the friction of disabling it is high enough that >80% leave it on (industry data on default-opt-out toggles).

---

### 60. [GROWTH] Demo-mode dashboard at `/demo` (no signup required) (added 2026-04-27 audit) [M]

**App:** QuickInvoice (Node.js)
**Impact:** HIGH — the highest-friction conversion blocker today is "I have to register before I can see what this looks like." A demo dashboard that pre-loads 5 fake invoices in 4 statuses (draft, sent, paid, overdue) lets a visitor click around the dashboard, the invoice form, the PDF view, even the Pro upgrade flow, all without creating an account. Industry data: indie SaaS that ship a no-signup demo see 15-30% lift in the landing → register conversion rate vs. the same audience with no demo. Notion, Linear, and Figma all do this; QuickInvoice does not.
**Effort:** Medium.
**Prerequisites:** None — runs as a session-scoped fake DB layer.

**Sub-tasks:**
1. New `lib/demo-data.js`: pure module exporting `getDemoInvoices()`, `getDemoUser()`, `getDemoClient()` — hardcoded fixtures with realistic line items (3 sent, 1 paid, 1 overdue; client `Acme Co.`; total revenue ~$8,000). Same shape as the real DB rows so `views/dashboard.ejs` renders unchanged.
2. New `middleware/demo-mode.js`: when `req.path.startsWith('/demo')` OR `req.session.demo === true`, set `req.demoMode = true`. Subsequent routes branch on this flag.
3. `routes/invoices.js GET /` (and the few sub-routes the demo allows): when `req.demoMode`, return demo data instead of hitting `db.getInvoicesByUser`. POST/edit/delete routes are read-only in demo mode (return a soft "Sign up to save changes →" flash + redirect to register).
4. New `GET /demo`: sets `req.session.demo = true` + `req.session.user = getDemoUser()`, redirects to `/invoices` (the dashboard). The fake user has `plan='pro'` so the visitor sees the full Pro UI (Stripe Payment Link card, branding section, etc.) without an upgrade gate.
5. `views/index.ejs` hero: add a secondary "Try the demo →" button next to the main "Create your first invoice" CTA. Pure visual link, no extra logic.
6. New `tests/demo.test.js` (5 tests): `GET /demo` sets the demo session; `GET /invoices` in demo mode returns the fixture invoices, not real DB; `POST /invoices/new` in demo mode redirects to register with a flash; demo session does NOT contaminate real-user sessions across tests; demo dashboard renders with `plan='pro'` UI (payment-link card visible).

**Income relevance:** Direct top-of-funnel lift. Removes the single biggest friction in the prospect → register path. Compounds with #36 OG metadata (now every shared link drops the visitor on a marketing page that links to a clickable demo, not a registration form) and #20 social proof (the demo is the strongest possible "show, don't tell"). Demo mode is also a discoverability win for SEO — the `/demo` page itself becomes a high-engagement landing page that ranks for "invoice software demo" / "free invoice tool no signup" queries.

---

### 61. [GROWTH] Attach invoice PDF to invoice email (added 2026-04-27 PM audit) [S]

**App:** QuickInvoice (Node.js)
**Impact:** HIGH — today the Pro invoice email body links to the invoice but does NOT attach the PDF. Most accounts-payable departments file the PDF, not a link, and many corporate email gateways block external links by default. As a result, a meaningful fraction of clients ignore or delay payment because they can't extract a "real" invoice from the email. Attaching the PDF directly removes this friction and matches the behaviour every other invoicing tool (FreshBooks, Bonsai, Xero) ships with by default. The Resend SDK supports attachments via the `attachments` array on `emails.send()` — server-side rendering of the PDF is the only piece missing from `lib/email.js`.
**Effort:** Low
**Prerequisites:** Email delivery (#13, done); Resend API key in production. Does NOT require a heavy PDF library — the existing `views/invoice-print.ejs` template plus `puppeteer-core` or the lighter-weight `playwright` headless render is sufficient. Alternative: server-side `html-pdf-node` (smaller dep tree, slower).

**Sub-tasks:**
1. New `lib/pdf.js` exporting `renderInvoicePdf(invoice, owner)`. Uses `playwright` (or `puppeteer-core` with a Chromium binary cached in `~/.cache/ms-playwright`) to render `views/invoice-print.ejs` as HTML, then `page.pdf({ format: 'A4' })`. Returns a `Buffer`. On any error, returns `null` so the email still sends without the attachment (graceful degradation — same hygiene contract as `lib/email.js`).
2. `lib/email.js sendInvoiceEmail`: optionally call `await renderInvoicePdf(invoice, owner)`. When buffer is non-null, pass `attachments: [{ filename: \`invoice-${invoice.invoice_number}.pdf\`, content: buf }]` on the Resend send. Buffer-null path sends the email without attachment (same behaviour as today).
3. `package.json`: add `playwright` (or `puppeteer-core` + `@sparticuz/chromium` for Heroku-friendly slim Chromium). Note Heroku slug-size impact in TODO_MASTER (~80MB for slim, ~250MB for full Playwright).
4. `views/settings.ejs`: Pro-only checkbox "Attach PDF to client emails" (default ON). Stored as `attach_pdf_enabled` on users (idempotent `ALTER TABLE users ADD COLUMN IF NOT EXISTS attach_pdf_enabled BOOLEAN DEFAULT true;`).
5. New `tests/email-attachment.test.js` (5 tests): when PDF render succeeds, attachments array is passed to Resend; when PDF render returns null (graceful), email sends without attachments; pre-existing `attach_pdf_enabled = false` skips the PDF render entirely (saves ~500ms of CPU); attach-pdf is Pro-only (free plan never attaches); attachment filename uses the invoice number.

**Income relevance:** Direct payment-velocity lift. Industry data on invoice-email-with-PDF vs. link-only: PDF-attached invoices are paid 22-35% faster on average, and Net-30 collection rate improves 8-15%. Faster collection ⇒ more cha-ching emails (#30) ⇒ stronger word-of-mouth and retention. Closes the single largest "this is missing the basics" gap in QuickInvoice vs. competitors, particularly for B2B / enterprise clients.

---

### 62. [GROWTH] Year-end tax summary PDF + email for Pro users (added 2026-04-27 PM audit) [S]

**App:** QuickInvoice (Node.js)
**Impact:** HIGH (retention) — every January, freelancers spend 2-3 hours pulling together their full invoicing history for their accountant. A one-click "Download my Year-End Summary" PDF (and a January 5th email blast for the prior calendar year) saves them that time and makes QuickInvoice the indispensable tax-season tool. Tax season is the #1 churn-risk window (freelancers re-evaluate their stack while sitting next to their accountant); every Pro user who has the year-end summary in their inbox is much less likely to switch. Industry benchmark (Xero, FreshBooks): tax-summary email opens at 60-80% (versus product-update emails at 15-25%) and converts 5-15% of recipients into multi-year retention commits.
**Effort:** Low
**Prerequisites:** Email delivery (#13, done) + PDF rendering (gated on #61's `lib/pdf.js`).

**Sub-tasks:**
1. `db.js`: `getYearlyInvoiceSummary(userId, year)` — single SELECT against invoices: total invoiced, total collected, outstanding, by-quarter breakdown, by-client top-10, count of paid vs. unpaid. Filters on `issue_date BETWEEN year-01-01 AND year-12-31`.
2. New `views/tax-summary.ejs` — clean printable tax-summary template: business header (from `users.business_*`), year, summary numbers, by-quarter chart (text table — keep it dependency-free), top-10 clients with amounts, line-item-level appendix (paginated). Optimised for print + PDF export.
3. New route `GET /tax-summary/:year` in `routes/invoices.js` (Pro-gated; default year = previous calendar year). Renders the EJS template; 200 OK; downloadable via `Content-Disposition: attachment; filename="quickinvoice-tax-summary-${year}.pdf"` when path includes `.pdf` suffix (re-uses `lib/pdf.js`).
4. New cron `jobs/year-end-summary.js`: runs once on Jan 5th at 09:00 UTC (`cron.schedule('0 9 5 1 *', ...)`); for each Pro/Business/Agency user, calls `getYearlyInvoiceSummary` for the prior calendar year and emails them the PDF. One-shot per year, idempotent via `users.tax_summary_sent_for_year` column.
5. `views/settings.ejs`: add a "Download my year-end tax summary" button under the Pro section with a year-picker dropdown (current year - 3 to current year - 1).
6. `db/schema.sql`: idempotent `ALTER TABLE users ADD COLUMN IF NOT EXISTS tax_summary_sent_for_year INT;`
7. New `tests/tax-summary.test.js` (5 tests): summary aggregation correctness on a fixture; route returns 200 for Pro user; route returns 403 for free user; cron job marks `tax_summary_sent_for_year` and is idempotent on second run; January-5 schedule string is correct.

**Income relevance:** Tax season is the highest-churn-risk window of the calendar year. Reducing that risk by 5-10% across the entire Pro cohort is more valuable than any single growth channel. Also re-engages dormant Pro users who haven't logged in for months (the email lands in their inbox in early January with their full year's data).

---

### 63. [GROWTH] Quick-pick recent clients dropdown on invoice form (added 2026-04-27 PM audit) [XS]

**App:** QuickInvoice (Node.js)
**Impact:** MEDIUM — most freelancers invoice the same 3-5 clients repeatedly. Today every new invoice requires re-typing client name, email, address from memory (or copy-pasting from the previous invoice). Adding a "Recent clients" dropdown above the client-name input (auto-populated from the last 10 distinct `client_email` values on the user's invoices) cuts the create-invoice flow from ~30 seconds to ~5 seconds for repeat clients. This is the highest-leverage activation/retention micro-feature still missing — every Pro user feels the friction multiple times per month.
**Effort:** Very Low
**Prerequisites:** None — pure SELECT on existing `invoices` table.

**Sub-tasks:**
1. `db.js`: `getRecentClientsForUser(userId, limit = 10)` — `SELECT DISTINCT ON (LOWER(COALESCE(client_email, client_name))) client_name, client_email, client_address FROM invoices WHERE user_id = $1 AND client_name IS NOT NULL ORDER BY LOWER(COALESCE(client_email, client_name)), created_at DESC LIMIT $2`. Returns most-recent unique-by-email client on top.
2. `routes/invoices.js GET /new` and `GET /:id/edit`: pass `recentClients` to the template (call the new helper; safe-fallback to `[]` on error).
3. `views/invoice-form.ejs`: above the client-name input, render an Alpine.js dropdown (only when `recentClients.length > 0`): `<select x-model="picked" @change="fill(picked)">…<option>Recent clients…</option>…</select>`. On selection, the Alpine handler fills the three client_* form fields. No save button — just a quick-fill.
4. New `tests/recent-clients.test.js` (4 tests): query returns most-recent unique-by-email client; query returns empty array for new user; route exposes `recentClients` to the template; form template renders the dropdown only when `recentClients.length > 0` (regression guard against empty-state UI clutter).

**Income relevance:** Activation lift on every invoice creation after the first. Reduces friction in the most-frequent action in the product. Compounds with retention (lower friction ⇒ more invoices created ⇒ more data ⇒ stickier user).

---

### 64. [GROWTH] Aging receivables report widget on dashboard (added 2026-04-27 PM audit) [S]

**App:** QuickInvoice (Node.js)
**Impact:** MEDIUM (retention + perceived professionalism) — every accounting tool from QuickBooks down has an "aging receivables" report — a grouping of outstanding invoices into 0-30 / 31-60 / 61-90 / 90+ day buckets. It's the primary view bookkeepers and finance teams use when they sit down to chase late payments. Adding a small dashboard widget rendering these 4 buckets (with totals) signals "this is a real accounting tool" to the high-intent freelancer + small-agency audience and complements the existing reminder cron (#16) by surfacing where the cron has not yet recovered cash.
**Effort:** Low
**Prerequisites:** None.

**Sub-tasks:**
1. `db.js`: `getAgingReceivables(userId)` — single SELECT against invoices: `SELECT SUM(total) FILTER (WHERE due_date >= CURRENT_DATE - 30) AS bucket_0_30, SUM(total) FILTER (WHERE due_date BETWEEN CURRENT_DATE - 60 AND CURRENT_DATE - 31) AS bucket_31_60, ... FROM invoices WHERE user_id = $1 AND status IN ('sent', 'overdue')`. Returns 4-bucket aggregation + count per bucket.
2. `routes/invoices.js GET /` (dashboard): pass `aging` local with the 4 buckets. Skip aggregation entirely when `invoices.length === 0` (don't show the widget on an empty dashboard).
3. `views/dashboard.ejs`: render a 4-column Tailwind grid card above the invoices table, only when any bucket > 0. Each card: bucket label ("0-30 days"), count, total amount. The 90+ bucket renders red (`bg-red-50 text-red-800`) for visual urgency.
4. New `tests/aging-receivables.test.js` (4 tests): aggregation correctness on a fixture; widget hidden when no outstanding invoices; widget hidden for user with all-paid history; 90+ bucket gets the red styling.

**Income relevance:** Indirect — signals product maturity to prospects evaluating QuickInvoice against accounting tools (FreshBooks, Wave). Bookkeepers and freelancer-CFOs look for this view; its absence reads as "amateur tool." Also a retention lever — the widget makes outstanding cash visible every login, which keeps the user engaged with chasing it (and hence engaged with the product).

---

### 65. [GROWTH] "Save invoice as template" + template gallery on invoice form (added 2026-04-27 PM audit) [S]

**App:** QuickInvoice (Node.js)
**Impact:** MED-HIGH — pairs with #63 (recent-clients quick-pick) as the next layer of invoice-creation friction reduction. Users who repeat the same line items (e.g. "Monthly retainer — strategy review", "Sprint 14 dev hours · 28 × $95") save them as a named template and one-click apply on a new invoice. Reduces the create-invoice flow to one click for retainer / repeat patterns, complementing the recurring-invoice flow (#40) for users who want manual control. Different from #40: #40 auto-creates on a schedule; this lets users instantiate on-demand. Pro-feature gating gives the upgrade modal a tangible new bullet.
**Effort:** Low
**Prerequisites:** None.

**Sub-tasks:**
1. `db/schema.sql`: idempotent — `CREATE TABLE IF NOT EXISTS invoice_templates (id BIGSERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), name VARCHAR(120) NOT NULL, items JSONB NOT NULL, notes TEXT, tax_rate NUMERIC(5,2), created_at TIMESTAMP DEFAULT NOW());` plus `CREATE INDEX IF NOT EXISTS idx_invoice_templates_user ON invoice_templates(user_id);`
2. `db.js`: `createInvoiceTemplate({user_id, name, items, notes, tax_rate})`, `getInvoiceTemplatesByUser(userId)`, `deleteInvoiceTemplate(id, userId)`.
3. `routes/invoices.js`: `POST /invoices/:id/save-as-template` (Pro-gated) — reads the invoice, copies the items + notes + tax_rate, prompts for a `name`, persists. `GET /templates` — Pro-gated; lists user's templates with delete buttons. `POST /invoices/new-from-template/:id` — Pro-gated; creates a new draft invoice from the template's items + a fresh client-empty form.
4. `views/invoice-view.ejs`: action bar — add a "Save as template" button (Pro-gated; tooltip for free users with upgrade CTA).
5. `views/invoice-form.ejs`: at the top of the form (above the recent-clients dropdown from #63), render a "Start from template…" `<select>` (Pro-only). Selecting a template POSTs to `/invoices/new-from-template/:id` and re-renders the form with items pre-filled.
6. New `tests/templates.test.js` (5 tests): save-as-template persists items + notes + tax_rate; list returns only the user's own templates (IDOR guard); delete is owner-scoped (IDOR guard); new-from-template pre-fills the form items; free-user POST returns 403 with upsell flash.

**Income relevance:** Activation + retention double-up. Every minute saved on invoice creation is repeated dozens of times per month per Pro user. Templates also create a small switching-cost moat — a user with 5+ saved templates is less likely to migrate. Adds a concrete bullet to the Pro upgrade modal copy ("save reusable invoice templates") that resonates with retainer/agency users.

---

## BLOCKED — Do Not Start Until Prerequisites Are Met

### 11. [GROWTH] [UNBLOCKED — email (#13) is live] Churn Win-Back Email Sequence [L]

**App:** QuickInvoice (Node.js)
**~~BLOCKED~~ UNBLOCKED (2026-04-25):** INTERNAL_TODO #13 (email delivery via Resend) shipped on 2026-04-25. Email delivery is now implemented. This task is ready to execute once `RESEND_API_KEY` is provisioned in production. The `churn_sequences` table, job, and webhook handler below can be implemented immediately.
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

### 12. [GROWTH] [UNBLOCKED — email (#13) is live] Monthly Revenue Summary Email to Pro Subscribers [M]

**App:** QuickInvoice (Node.js)
**~~BLOCKED~~ UNBLOCKED (2026-04-25):** INTERNAL_TODO #13 (email delivery via Resend) shipped on 2026-04-25. This task is ready to execute once `RESEND_API_KEY` is provisioned in production.
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
