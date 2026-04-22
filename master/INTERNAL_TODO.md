# QuickInvoice — Internal Growth TODO

This file tracks growth, monetization, and automation opportunities identified by the product strategy layer. Items are tagged `[GROWTH]` and ordered by income impact (highest first). Do not duplicate items already in `TODO.md`.

---

## [GROWTH] 1. Add Annual Billing Plan at $99/year

**Impact:** HIGH
**Effort:** Low–Medium
**Prerequisites:** None (Stripe already integrated)

Create a second Stripe price on the existing Pro product: $99/year (saves $45 vs monthly). Add a billing-cycle toggle (Monthly / Annual) to `views/pricing.ejs` and `views/settings.ejs`. Update `routes/billing.js` to pass the correct `price_id` based on the selected cycle. Update the Stripe webhook handler to recognise annual subscription events.

Annual subscribers churn at roughly half the rate of monthly subscribers, and the upfront cash improves cash flow immediately. A user who would have churned at month 3 is now locked in for 12.

---

## [GROWTH] 2. Upgrade Modal at Free-Plan Invoice Limit

**Impact:** HIGH
**Effort:** Low
**Prerequisites:** None

Right now, hitting the 3-invoice limit likely returns a generic server-side error or redirect. Replace this with a full-screen Alpine.js modal in `views/dashboard.ejs` and `views/invoice-form.ejs` that fires the moment the limit is detected. The modal should:

- Show exactly what Pro unlocks (unlimited invoices, email sending, payment links)
- Include a single prominent CTA that opens the existing Stripe Checkout flow
- Display a short testimonial or "join X freelancers" social-proof line

This is the highest-intent moment in the entire funnel. Turning a dead-end into a conversion step costs almost nothing to build.

---

## [GROWTH] 3. "Business" Tier at $29/month (or $249/year)

**Impact:** HIGH
**Effort:** Medium
**Prerequisites:** Annual billing (#1) recommended first

Add a third Stripe plan targeted at freelancers with agencies or growing practices. Gating features:

- Up to 3 business profiles (separate branding per client entity)
- Up to 2 additional team seats (invite a VA or accountant)
- Automated recurring invoice scheduling (integrate with the recurring invoices item already in TODO.md)
- Priority email support SLA badge

Update `db/schema.sql` (add `plan` column values), `middleware/auth.js` (plan checks), all views that gate on `is_pro`, and the pricing page. The Business tier raises the revenue ceiling from $12/month to $29/month per power user without cannibalising the Pro tier.

---

## [GROWTH] 4. Stripe Payment Links on Invoices (Pro Feature)

**Impact:** HIGH
**Effort:** Medium
**Prerequisites:** Stripe account (already required)

When a Pro user marks an invoice as "Sent," automatically generate a Stripe Payment Link for the invoice total and embed a **"Pay Now"** button in the invoice view and print layout. When the client pays, Stripe fires a webhook that automatically marks the invoice as "Paid."

This transforms QuickInvoice from an invoice *generator* into a payment *collection* tool. Freelancers whose clients pay through the platform will almost never cancel — the switching cost becomes too high. Implement in `routes/invoices.js` (create Payment Link on status change) and `views/invoice-print.ejs` (render QR code or URL).

---

## [GROWTH] 5. SEO Niche Landing Pages for Freelancer Verticals

**Impact:** MEDIUM–HIGH
**Effort:** Medium
**Prerequisites:** Custom domain (in TODO.md) recommended first

Create 6–8 static EJS routes targeting high-intent, low-competition keywords:

- `/invoice-template/freelance-designer`
- `/invoice-template/freelance-developer`
- `/invoice-template/freelance-writer`
- `/invoice-template/freelance-photographer`
- `/invoice-template/consultant`
- `/invoice-generator` (broad)

Each page renders a niche-specific headline, screenshot, and a "Create your first invoice free" CTA that routes to `/register`. Pages share a single EJS partial with slot variables — minimal duplication. Submit a sitemap to Google Search Console. This is a zero-ad-spend acquisition channel that compounds over time.

---

## [GROWTH] 6. "Created with QuickInvoice" Footer on Free Plan PDFs

**Impact:** MEDIUM
**Effort:** Very Low
**Prerequisites:** None

Add a subtle one-line footer to `views/invoice-print.ejs` that renders only when `user.plan === 'free'`:

```
Invoiced with QuickInvoice · quickinvoice.io/free
```

The URL should land on the pricing page with a UTM parameter (`?ref=pdf-footer`). Every invoice a free user sends to a client becomes a passive acquisition touchpoint. Pro users get a clean, unbranded PDF — making the removal of the watermark a tangible Pro benefit.

---

## [GROWTH] 7. Automated Stripe Dunning + Smart Retries

**Impact:** MEDIUM
**Effort:** Very Low (mostly Stripe Dashboard config)
**Prerequisites:** Stripe account live

In the Stripe Dashboard, enable:

1. **Smart Retries** — Stripe ML-picks the optimal retry window for failed charges.
2. **Dunning emails** — Stripe sends automatic "your card failed" emails on retry attempts and before subscription cancels.
3. **Subscription pause on failure** (instead of immediate cancel) — gives users a grace period to update payment.

Then update the `customer.subscription.updated` webhook handler in `routes/billing.js` to handle the `past_due` and `paused` status values so the UI correctly restricts access without permanently deleting user data. This recovers an estimated 20–30% of failed payments with zero ongoing effort.

---

## [GROWTH] 8. Churn Win-Back Email Sequence

**Impact:** MEDIUM
**Effort:** Low–Medium
**Prerequisites:** Email delivery (in TODO.md) must be implemented first

When the `customer.subscription.deleted` Stripe webhook fires, trigger a 3-email automated sequence:

- **Email 1 (day 0):** "Sorry to see you go — your data is safe for 30 days."
- **Email 2 (day 3):** "Here's what you're missing + 20% off your first month back" (generate a Stripe coupon via API and embed the link).
- **Email 3 (day 14):** "Last chance — your invoice history will be archived soon."

Implement via a `churn_sequences` table in Postgres and a daily cron job (`node-cron`) that checks for pending sends. A 10–15% win-back rate on churned users is typical and requires zero manual effort after the sequence is built.

---

## [GROWTH] 9. Monthly Revenue Summary Email to Pro Subscribers

**Impact:** MEDIUM
**Effort:** Low
**Prerequisites:** Email delivery (in TODO.md) must be implemented first

On the 1st of each month, send each Pro user a summary pulled from their invoice data:

- Total invoiced this month vs. last month
- Amount collected vs. outstanding
- Number of new clients invoiced
- CTA: "View your dashboard →"

This is a retention tool disguised as a feature. It reminds users of the value they're getting each month, reducing passive churn ("I forgot I was paying for this"). Implement with a `node-cron` monthly job querying `db.js` aggregations already used on the dashboard.

---

## [GROWTH] 10. Zapier Outbound Webhook on Invoice Paid

**Impact:** MEDIUM
**Effort:** Low
**Prerequisites:** None

When an invoice is marked "Paid" (manually or via Stripe Payment Link), POST a JSON payload to a user-configured webhook URL stored in the `users` table. Add a "Zapier / Webhook" section to `views/settings.ejs` where Pro users paste their Zapier catch-hook URL.

This unlocks integrations with QuickBooks, FreshBooks, Notion, Airtable, Slack, and Google Sheets — all via Zapier or Make, with zero code on QuickInvoice's side. Listing on the Zapier app directory (even as a "Webhook by Zapier" connection) drives discovery. Gate behind Pro to add upgrade incentive.

---
