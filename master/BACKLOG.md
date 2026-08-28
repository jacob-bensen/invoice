# DecentInvoice — Backlog

> Each item advances a milestone in PLAN.md. Half-session-or-more of real engineering; no badge / copy-tweak / one-liner items.

_(empty — 2026-06-02 shipped per-user invoice-number customization: `users.invoice_number_prefix VARCHAR(20)` NULL + `users.invoice_number_start INTEGER NOT NULL DEFAULT 1`, new `lib/invoice-number.js` module with `sanitizePrefix` / `sanitizeStart` / `formatInvoiceNumber` (defence-in-depth resolver), `db.getNextInvoiceNumber` rewired through the lib in one JOIN'd round-trip, `POST /billing/settings` validates + persists both fields, two new labelled inputs in `views/settings.ejs`. Closes the settings-defaults cluster with the last piece freelancers were routinely retyping — a custom prefix per brand + a non-#0001 starting number that lets a first-run freelancer's very first invoice not literally announce itself as their first. Next session derives a new milestone-advancing task.)_
