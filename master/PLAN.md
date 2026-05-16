# DecentInvoice — Plan

## What this is and how it makes money

DecentInvoice is a Node.js + Postgres SaaS that lets freelancers and small agencies create, send, and collect payment on professional invoices in under 60 seconds. Stripe Payment Links collapse the create-invoice → get-paid loop into one click for the client; Slack/Discord/Zapier webhooks plus daily reminder cron jobs keep paying users engaged with each invoice's lifecycle. Revenue comes from a recurring Stripe subscription: Pro at $12/mo or $99/yr (the conversion event after a 7-day no-card trial), Agency at $49/mo for team-seat workflows. The free tier hard-walls at 3 invoices and no payment-link / no email-send, so the upgrade pressure compounds with each invoice the user creates. A second parallel implementation (InvoiceFlow, Java/Spring) exists but is not the routine's primary target.

## Primary Objective

**Maximize signup → first-sent-invoice activation rate.** Every trial→paid conversion surface built over the last 30 sessions only fires on users who return to the app and produce a real, sent invoice. Activation is the upstream multiplier on every conversion lever already shipped: doubling activation doubles the cohort exposed to the trial-urgency stack, the exit-intent modal, the celebration banner, the referral loop, and the locked-feature upsells. The previous Primary Objective's code-side "Done means" is complete; the live-Stripe validation criterion is gated on operator deploy and tracked in MASTER_ACTIONS.

## Milestones

1. **Signup → first dashboard re-entry.** Welcome email (shipped) and seed sample invoice (shipped) get the user back in front of the app. Remaining: a password-reset / magic-link path so users who lose their session can re-enter.
2. **First dashboard re-entry → first real invoice created.** The new-user dashboard should make "create your first real invoice" the unmistakable next action. Onboarding checklist (shipped) and seed-invoice "edit this" hint (shipped) anchor this; remaining work is empty-state CTAs that survive the seed-only state.
3. **First invoice created → first invoice sent.** The biggest single drop-off: a draft sitting in the user's account is invisible to their client. Stale-draft dashboard prompt (shipped) is the on-app surface; a 24-hour stale-draft email reminder closes the loop for users who don't return.
4. **First invoice sent → first payment received.** Already partially covered by the existing reminder cron, the Pro-only Stripe Payment Link surfaces, and the share-intent buttons. Remaining: a non-Pro share path (the public token URL #43 is the foundation).

## Done means

A brand-new signup, with no manual intervention, reaches a sent invoice within their first 7 days at a rate the funnel surfaces above support. Concrete observable signal: an in-app activation funnel report (signups → re-entered → created real invoice → sent → got paid) accessible from the operator's view shows positive day-over-day flow at every step, and the trial→paid funnel surfaces (already shipped) start firing on real-cohort users rather than empty trial accounts.
