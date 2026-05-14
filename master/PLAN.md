# QuickInvoice — Plan

## What this is and how it makes money

QuickInvoice is a Node.js + Postgres SaaS that lets freelancers and small agencies create, send, and collect payment on professional invoices in under 60 seconds. Stripe Payment Links collapse the create-invoice → get-paid loop into one click for the client; Slack/Discord/Zapier webhooks plus daily reminder cron jobs keep paying users engaged with each invoice's lifecycle. Revenue comes from a recurring Stripe subscription: Pro at $12/mo or $99/yr (the conversion event after a 7-day no-card trial), Agency at $49/mo for team-seat workflows. The free tier hard-walls at 3 invoices and no payment-link / no email-send, so the upgrade pressure compounds with each invoice the user creates. A second parallel implementation (InvoiceFlow, Java/Spring) exists but is not the routine's primary target.

## Primary Objective

**Maximize the trial → paid conversion rate.** Every authed surface during the 7-day Pro trial should reinforce "the trial ends in N, here's what you'd lose, here's the one-click path to keep it." This is the single revenue lever where shipped code moves MRR the fastest: the funnel feeds itself with free signups today, and every percentage point of trial→paid lift translates directly into recurring revenue at industry-typical 4-8% baselines. The most recent five sessions all advanced this objective (#138, #134, #133 layered time/price/precision anchors on the day-1 urgent banner; #127 and #122 sit one epic over but feed the same dashboard surface).

## Milestones

1. **Decision-moment surfaces complete on /pricing, dashboard, and upgrade modal.** Exit-intent recovery, monthly→annual prompt, and a side-by-side competitor pricing strip all live; every pricing-page bounce is intercepted at least once.
2. **Locked-feature upsell stack.** A consistent contextual Pro prompt fires on every gated feature (email send, payment link, branding, webhooks) — no dead-end "this is a Pro feature" copy without a one-click upgrade path.
3. **Conversion intelligence captured.** "What's missing?" close-signal on the upgrade modal feeds a Master-readable signal table; first-paid celebration closes the activation→conversion loop with a referral hook.
4. **Trial urgency stack frozen.** Day-1 banner has time anchor (#134), price anchor (#133), precision label (#138), and one remaining social-proof anchor (#135) layered without further reshuffling.

## Done means

The trial→paid funnel has shipped surfaces at every cohort point: pre-decision (pricing competitor strip + trust badges), at-decision (exit-intent modal, upgrade-modal pricing anchors), in-trial (day-1 urgency stack complete + social proof), and post-trial-close (feedback widget capturing "what's missing"). At least one Pro-paying user has flowed through the loop end-to-end on live Stripe, validating the conversion event in production rather than in test mode.
