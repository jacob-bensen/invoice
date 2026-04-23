# QuickInvoice — Changelog

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
