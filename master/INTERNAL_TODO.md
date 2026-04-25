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

### H5. [HEALTH] Inconsistent `plan` CHECK constraint vs. application code (added 2026-04-23 audit) [S]

**App:** QuickInvoice (Node.js)
**Impact:** LOW (latent) — `db/schema.sql` line 12 pins `plan IN ('free', 'pro')`, but `routes/invoices.js:175,189` and `routes/billing.js:123,170` branch on `plan === 'agency'`. Any path that attempts to persist `plan = 'agency'` will fail the CHECK constraint with a 23514 error. No current route actually writes `'agency'`, so this is latent — but it is a trip wire when INTERNAL_TODO #9 (team seats / Agency tier) or #10 (Business tier) lands.
**Effort:** Very Low
**Sub-tasks:** Add idempotent migration to `db/schema.sql`: `ALTER TABLE users DROP CONSTRAINT IF EXISTS users_plan_check; ALTER TABLE users ADD CONSTRAINT users_plan_check CHECK (plan IN ('free','pro','business','agency'));`. Coordinate with INTERNAL_TODO #10's schema change so both land in one migration.

---

### H6. [HEALTH] `POST /:id/status` accepts any string (added 2026-04-23 audit) [XS]

**App:** QuickInvoice (Node.js)
**Impact:** LOW — the DB CHECK constraint (`status IN ('draft','sent','paid','overdue')`) will reject bad values, but the 500 surfaces as `console.error('Status update error:', err)` and a redirect, creating noisy logs and a confusing UX. Whitelist in Node and return a flash on invalid.
**Location:** `routes/invoices.js:168-203`.

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

### H12. [HEALTH] Whitelist `status` in `POST /:id/status` before hitting Postgres CHECK constraint (added 2026-04-24 PM audit, supersedes earlier H6) [XS]

**App:** QuickInvoice (Node.js)
**Impact:** LOW (latent) — `routes/invoices.js:170-205` reads `req.body.status` and passes it straight to `db.updateInvoiceStatus`. Postgres' CHECK constraint (`status IN ('draft','sent','paid','overdue')`) rejects bad values with error code `23514`, the catch block logs `console.error('Status update error:', err)` and redirects. Effect: a junk `status` POST yields a noisy log line and an opaque redirect rather than a flash. Low impact (CHECK protects DB integrity), but the noise complicates incident triage and obscures real DB errors.
**Effort:** Very Low
**Sub-tasks:** In `routes/invoices.js` `POST /:id/status`, add `const ALLOWED = ['draft','sent','paid','overdue']; if (!ALLOWED.includes(req.body.status)) { req.session.flash = { type: 'error', message: 'Invalid status.' }; return res.redirect('/invoices/' + req.params.id); }` immediately after extracting `newStatus`. Add a test in `tests/edge-cases.test.js` (junk status → flash + redirect, no DB write).

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
