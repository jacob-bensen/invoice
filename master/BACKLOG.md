# QuickInvoice — Backlog

> Each item advances a milestone in PLAN.md. Half-session-or-more of real engineering; no badge / copy-tweak / one-liner items.

## #15 — Contextual Pro upsell prompts on locked features
Single canonical upsell component fired from every gated feature (email send, payment link, branding, webhook URL) instead of bespoke dead-end copy per surface.
Milestone 2 (locked-feature upsell stack).

## #49 — First-paid-invoice celebration banner + referral email
On the freelancer's first paid invoice, surface a celebration banner + send a "share QuickInvoice with a friend, both get Pro month" email — converts the emotional spike into a viral loop.
Milestone 3 (conversion intelligence).

## #135 — Social-proof line on day-1 trial-urgent banner
Inline "Join 1,247 freelancers on Pro" line (live count cached 1 hr, static fallback) layered below the existing time + price anchors. Closes the urgency stack.
Milestone 4 (trial urgency stack frozen).

## #39 — First-invoice seed template on signup
Auto-populate a draft invoice for new users so the dashboard is never empty; activation lift compounds directly with trial-end conversion.
Milestone 3 (conversion intelligence — activation feeds the trial cohort).

## #43 — Public read-only invoice URL `/i/:token`
Tokenized share link for an invoice without login; unblocks downstream surfaces (#48 powered-by badge, #69 embed widget, #78 freelancer profile, #111 client-preview).
Milestone 2 (locked-feature upsell stack — adds a Pro-only share surface).

## #28 — Legal pages scaffolding (Terms / Privacy / Refund)
Three EJS pages + a `views/partials/footer.ejs` linking them from every authed page. Hard requirement for Stripe ToS compliance and unblocks GDPR/PCI deliverables. Without this the trial→paid funnel risks rejection by Stripe Risk on growth.
Milestone 1 (decision-moment surfaces — legal links sit in the pricing/checkout footer).
