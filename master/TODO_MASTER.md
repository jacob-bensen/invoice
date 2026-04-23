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

## 8. Set logo uploads directory (added 2026-04-22)
Logo uploads are stored on the local filesystem. Set a persistent path (e.g., an attached volume on Heroku/Railway):
```
UPLOADS_DIR=/var/data/invoiceflow-uploads
```
If unset, defaults to `./uploads` relative to the working directory (not persistent across Heroku dyno restarts — use an attached volume or swap this for S3 in production).
