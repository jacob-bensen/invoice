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

## 13. InvoiceFlow: deploy V3 Flyway migration for recurring invoices (added 2026-04-23)
The InvoiceFlow recurring-invoice feature (INTERNAL_TODO #6) adds migration `V3__recurring_invoices.sql`. On the **next deploy**, Flyway picks it up automatically — no manual action required. The migration adds four additive columns to the `invoices` table (`recurrence_frequency`, `recurrence_next_run`, `recurrence_active DEFAULT FALSE`, `recurrence_source_id`) plus two indexes. No data backfill, no downtime, and existing invoices behave exactly as before (`recurrence_active` defaults to FALSE).

A new daily scheduler runs at **08:00 UTC** (`@Scheduled(cron = "0 0 8 * * *")`) one hour before the existing reminder job. No extra infra is needed — Spring's in-process scheduler is already enabled via `@EnableScheduling` in `InvoiceFlowApplication`.

**Verify after deploy (2 min):** log in as a Pro/Agency account, `PUT /api/invoices/{id}/recurrence` with `{"frequency":"MONTHLY","active":true}`, confirm `GET /api/invoices/recurring` lists it, then wait for 08:00 UTC (or invoke the job via a test harness) and confirm a new `DRAFT` invoice appears with `recurrence_source_id` pointing at the template.

## 8. Set logo uploads directory (added 2026-04-22)
Logo uploads are stored on the local filesystem. Set a persistent path (e.g., an attached volume on Heroku/Railway):
```
UPLOADS_DIR=/var/data/invoiceflow-uploads
```
If unset, defaults to `./uploads` relative to the working directory (not persistent across Heroku dyno restarts — use an attached volume or swap this for S3 in production).
