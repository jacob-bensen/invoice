# QuickInvoice — Backlog

> Each item advances a milestone in PLAN.md. Half-session-or-more of real engineering; no badge / copy-tweak / one-liner items.

## #50 — Referral conversion: grant free Pro month to both sides
Wire `STRIPE_REFERRAL_COUPON_ID` into the checkout-session metadata + the post-conversion webhook so a referred user's first Pro charge applies the coupon and the referrer's subscription gets a one-month trial extension — closes the loop on the #49 celebration-banner promise.
Milestone 3 (conversion intelligence — viral loop closes).

## #43 — Public read-only invoice URL `/i/:token`
Tokenized share link for an invoice without login; unblocks downstream surfaces (#48 powered-by badge, #69 embed widget, #78 freelancer profile, #111 client-preview).
Milestone 2 (locked-feature upsell stack — adds a Pro-only share surface).

