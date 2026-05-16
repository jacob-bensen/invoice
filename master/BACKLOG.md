# DecentInvoice — Backlog

> Each item advances a milestone in PLAN.md. Half-session-or-more of real engineering; no badge / copy-tweak / one-liner items.

## Password reset / magic-link sign-in
End-to-end self-serve flow: request → email token (Resend) → consume single-use token → set new password (or log in). Closes Milestone 1 of the activation funnel — today a user who loses their session cannot get back to the seeded dashboard at all.
_Milestone 1 (signup → first dashboard re-entry)._

## Empty-state CTA after seed invoice is deleted or edited
Once the seed sample is removed or edited beyond recognition, the invoice list goes back to looking like an empty admin shell with only the onboarding checklist. A persistent "Create your first real invoice" hero block on the dashboard (gated on `invoice_count === 0 AND no live drafts`) keeps the next action unmistakable past the seed.
_Milestone 2 (first dashboard re-entry → first real invoice created)._

## Operator activation-funnel report at /admin/activation
SQL-backed JSON+HTML report counting users by funnel stage (signed up, re-entered after welcome, created a real invoice, sent one, got paid) over a date range. Gated behind a single env-var operator email — no full RBAC. This is the observable signal that the Primary Objective is achieved.
_Milestone 4 (instrumentation — the "Done means" report)._
