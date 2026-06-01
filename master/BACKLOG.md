# DecentInvoice — Backlog

> Each item advances a milestone in PLAN.md. Half-session-or-more of real engineering; no badge / copy-tweak / one-liner items.

_(empty — 2026-06-01 shipped per-user `default_tax_rate` (NUMERIC(5,2) NOT NULL DEFAULT 0, bounded 0-100 with up to 2 decimals at the settings route) → `/invoices/new` form's Tax % input now pre-fills from the user's saved rate, with a "Defaulting to your saved 19% rate — change in settings" hint linking back to the settings surface. Closes the settings-defaults cluster started by default_invoice_notes + default_payment_terms_days; the new-invoice form is now zero-keystroke for the common VAT/GST/sales-tax freelancer. Next session derives a new milestone-advancing task.)_
