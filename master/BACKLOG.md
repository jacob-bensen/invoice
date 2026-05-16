# DecentInvoice — Backlog

> Each item advances a milestone in PLAN.md. Half-session-or-more of real engineering; no badge / copy-tweak / one-liner items.

## Empty-state CTA after seed invoice is deleted or edited
Once the seed sample is removed or edited beyond recognition, the invoice list goes back to looking like an empty admin shell with only the onboarding checklist. A persistent "Create your first real invoice" hero block on the dashboard (gated on `invoice_count === 0 AND no live drafts`) keeps the next action unmistakable past the seed.
_Milestone 2 (first dashboard re-entry → first real invoice created)._

## Operator activation-funnel report at /admin/activation
SQL-backed JSON+HTML report counting users by funnel stage (signed up, re-entered after welcome, created a real invoice, sent one, got paid) over a date range. Gated behind a single env-var operator email — no full RBAC. This is the observable signal that the Primary Objective is achieved.
_Milestone 4 (instrumentation — the "Done means" report)._
