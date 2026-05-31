-- DecentInvoice Database Schema

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(255),
  business_name VARCHAR(255),
  business_address TEXT,
  business_phone VARCHAR(50),
  business_email VARCHAR(255),
  plan VARCHAR(20) DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'business', 'agency')),
  stripe_customer_id VARCHAR(255),
  stripe_subscription_id VARCHAR(255),
  subscription_status VARCHAR(20),
  webhook_url TEXT,
  invoice_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS invoices (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  invoice_number VARCHAR(50) NOT NULL,
  client_name VARCHAR(255) NOT NULL,
  client_email VARCHAR(255),
  client_address TEXT,
  items JSONB NOT NULL DEFAULT '[]',
  subtotal DECIMAL(12,2) NOT NULL DEFAULT 0,
  tax_rate DECIMAL(5,2) DEFAULT 0,
  tax_amount DECIMAL(12,2) DEFAULT 0,
  total DECIMAL(12,2) NOT NULL DEFAULT 0,
  notes TEXT,
  status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'paid', 'overdue')),
  issued_date DATE DEFAULT CURRENT_DATE,
  due_date DATE,
  payment_link_url TEXT,
  payment_link_id VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Idempotent migration for existing deployments
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_link_url TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_link_id VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(20);
ALTER TABLE users ADD COLUMN IF NOT EXISTS webhook_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reply_to_email VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_dismissed BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_nudge_sent_at TIMESTAMP;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS last_reminder_sent_at TIMESTAMP;
-- "Heads up — due in 2 days" pre-due-date client reminder (Milestone 4 —
-- first invoice sent → first payment received). Existing reminders.js only
-- fires AFTER due_date; this column gates a single pre-due nudge so a client
-- gets a heads-up *before* slipping into overdue. One stamp per invoice
-- (idempotent at the SQL layer); a second invoice to the same client gets
-- its own window.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS due_soon_reminder_sent_at TIMESTAMP;
-- billing_cycle is set from Stripe checkout-session metadata so the dashboard
-- can offer monthly subscribers a one-click switch to annual ($99/yr saves
-- $45/year vs. monthly $12/mo). Nullable: legacy Pro rows without a recorded
-- cycle simply do not see the switch prompt.
ALTER TABLE users ADD COLUMN IF NOT EXISTS billing_cycle VARCHAR(20);
-- is_seed flags the template invoice auto-inserted at signup (#39) so the
-- dashboard is never empty for a brand-new user. Seeded rows do NOT count
-- toward the free-tier 3-invoice limit (createSeedInvoice skips the
-- users.invoice_count bump), and the dashboard renders an "Example" badge
-- + a one-line edit-me hint on them.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS is_seed BOOLEAN DEFAULT false;

-- First-paid celebration + referral hook (#49). first_paid_at is stamped the
-- first time any of the user's invoices flips to status='paid' (whether
-- via the manual mark-paid flow or the Stripe Payment Link webhook). The
-- dashboard shows a one-shot celebration banner with a referral CTA for
-- 7 days from this timestamp. referral_code is generated lazily at the
-- moment the celebration banner first renders (or any explicit referral
-- surface) so existing users without a code don't all get one written at
-- migration time. referrer_id captures who sent a new signup our way
-- (set at register from the ?ref=<code> attribution cookie); ON DELETE
-- SET NULL preserves a referrer's aggregate count even if their account
-- is wiped.
ALTER TABLE users ADD COLUMN IF NOT EXISTS first_paid_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code VARCHAR(32) UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referrer_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- First-sent celebration (Milestone 3 — first invoice created → first invoice
-- sent). Stamped the very first time any of the user's non-seed invoices
-- crosses into status IN ('sent','paid','overdue') — whether via the manual
-- Mark-as-Sent flow, a share-intent button click (WhatsApp/SMS/Email/Copy/
-- Native), the Pro server-side "Send by email" button, the quick-invoice
-- create+email shortcut, or the public /i/<token> client-view auto-flip. A
-- one-shot transactional email fires from lib/first-sent-celebration on the
-- stamping UPDATE that actually took (the WHERE first_sent_at IS NULL guard
-- + EXISTS subquery on non-seed sent/paid/overdue rows means concurrent flips
-- collapse to exactly one stamp + one email). Reinforces the strongest
-- upstream activation event before payment, confirms the send happened, sets
-- payment-timeline expectation, surfaces Pay-Link upsell to free users, and
-- bakes in a magic-login URL back to the just-sent invoice.
ALTER TABLE users ADD COLUMN IF NOT EXISTS first_sent_at TIMESTAMP;
-- Referral redemption (#50). Stamped exactly once when a referred user's
-- Stripe subscription is created (checkout.session.completed, mode=subscription),
-- so the referrer's free-month coupon application is one-shot — replaying the
-- webhook (Stripe retries up to 16 times across 3 days) must never grant more
-- than one free month per referral.
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_credited_at TIMESTAMP;

-- Welcome-email idempotency. Stamped the first time the post-signup welcome
-- email fires so a re-trigger (e.g. catch-up email helper for legacy users
-- created before the email landed) never double-sends to the same address.
-- The fire path is a single UPDATE guarded on `welcome_email_sent_at IS NULL`,
-- mirroring `recordFirstPaidIfMissing` (#49) and `creditReferrerIfMissing`
-- (#50) — race-safe by SQL construction.
ALTER TABLE users ADD COLUMN IF NOT EXISTS welcome_email_sent_at TIMESTAMP;

-- "How to pay" instructions surfaced on the public /i/<token> invoice page
-- (Milestone 4 — first invoice sent → first payment received). Free users
-- have no Stripe pay-button on the public page; without this field, a client
-- who opens the share link has no in-app path to actually paying. Free-text
-- so the user can list their preferred methods verbatim (Venmo @handle,
-- Zelle email, bank wire instructions, cheque mailing address, PayPal.me
-- link, crypto address). Rendered with whitespace preserved and HTML-
-- escaped by EJS. Also useful as a fallback to the Stripe button for Pro
-- users whose clients prefer ACH / bank transfer over card.
ALTER TABLE users ADD COLUMN IF NOT EXISTS payment_instructions TEXT;

-- INTERNAL_TODO H5: widen users.plan CHECK to allow 'business' and 'agency'.
-- The CREATE TABLE above already uses the wide list for fresh installs; this
-- block migrates pre-existing deployments whose constraint still pins
-- ('free','pro'). Drop-then-add is idempotent: DROP IF EXISTS no-ops on a
-- fresh DB (where the new constraint already exists with the wide list, so we
-- drop and re-add the same definition). On an old DB it swaps the narrow
-- definition for the wide one.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_plan_check;
ALTER TABLE users ADD CONSTRAINT users_plan_check
  CHECK (plan IN ('free', 'pro', 'business', 'agency'));

-- Public read-only invoice share token (#43). Lazy-generated the first time a
-- Pro user clicks "Share link" on an invoice; surfaces a tokenized
-- /i/<token> URL the freelancer can paste into an email or DM so the client
-- views the invoice (and the Pro payment link) without needing a DecentInvoice
-- account. UNIQUE so the route can lookup by token directly; nullable so the
-- column doesn't burn space on the vast majority of invoices that are never
-- shared by link.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS public_token VARCHAR(32) UNIQUE;

-- Client-view tracking on shared invoices (Milestone 4 — sent → paid).
-- Every successful GET /i/<token> by a non-bot user-agent increments
-- view_count and stamps last_viewed_at; first_viewed_at is set exactly
-- once via COALESCE so the dashboard can say "Client first opened this
-- 3 hours ago" — a signal that pulls the freelancer back into the app
-- (re-exposes them to the trial-urgency stack, exit-intent modal,
-- celebration banner, and upgrade-modal surfaces). The owner never
-- shares their own dashboard URL by accident — these stamps fire only
-- on the public /i/<token> path, not on the authenticated /invoices/:id
-- view, so seeing the badge is a true client-side signal.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS view_count INTEGER DEFAULT 0;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS first_viewed_at TIMESTAMP;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS last_viewed_at TIMESTAMP;

-- Auto-transition draft → sent the first time a client opens the public
-- /i/<token> share URL (Milestone 3 — first invoice created → first invoice
-- sent). Before this stamp, a user who generated the public share link and
-- shared it via WhatsApp/SMS/Email without explicitly clicking "Mark as
-- Sent" left the invoice in 'draft' on the freelancer's dashboard — the
-- stale-draft prompt and email both kept firing on already-shared invoices,
-- and the operator activation-funnel report's `sent_one` counter
-- (status IN ('sent','paid','overdue')) missed these real conversions
-- entirely. The CLIENT opening the link is the strongest server-observable
-- "this was definitely sent" signal there is. The stamp itself is the
-- analytics signal — distinguishes "explicit mark-as-sent" from "auto-sent
-- when the client opened the link" — and the status flip is atomic with
-- the view-count bump in the single recordPublicInvoiceView UPDATE so a
-- view never races with a status read.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS sent_via_share_view_at TIMESTAMP;

-- Auto-transition draft → sent the moment the freelancer clicks a
-- share-intent button (WhatsApp/SMS/Email) or Copy on /invoices/:id
-- (Milestone 3 — first invoice created → first invoice sent). Pairs with
-- sent_via_share_view_at: that one fires when the CLIENT opens the link,
-- which never happens if the client never opens it. This one fires the
-- moment the freelancer takes the unambiguous "send to client" gesture in
-- the app, closing the gap where a share-and-never-opened invoice stayed
-- draft on the freelancer's dashboard, kept tripping stale-draft prompts
-- + emails, and was invisible to the activation-funnel report's `sent_one`
-- counter. Same atomic CASE-guard pattern as sent_via_share_view_at — the
-- stamp is set only on a real draft→sent flip; non-draft statuses
-- (sent / paid / overdue) flow through the ELSE branch untouched so a
-- paid-up-front invoice never regresses.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS sent_via_share_intent_at TIMESTAMP;

-- Stale-draft email cooldown stamp. The daily cron picks up users with a real
-- draft invoice 24h+ old who haven't been emailed about it in the last 7 days
-- (and only after the welcome email has fired, so a brand-new signup gets the
-- welcome before this nudge). One stamp per user is sufficient — the cron
-- groups stale drafts by user and emails about the oldest, so a single user
-- never gets multiple emails in one tick.
ALTER TABLE users ADD COLUMN IF NOT EXISTS stale_draft_email_sent_at TIMESTAMP;

-- Second stale-draft email stamp (one-shot terminal follow-up). 7+ days after
-- the first stale-draft email fires, the same draft is still sitting unsent;
-- the original cron would otherwise re-send the SAME copy every 7 days
-- forever. This second pass replaces that repetition with a single, sharper
-- "is anything specific stopping you? hit reply" email and then stops — the
-- user who's silent after two distinct emails over a week+ isn't moved by a
-- third. Mirrors the no-invoice / second-no-invoice nudge pair on Milestone 2,
-- now applied to the Milestone 3 (created_real → sent_one) draft cohort.
-- Originally-fired stale-draft is suppressed via an
-- `AND second_stale_draft_email_sent_at IS NULL` gate on its query, so a user
-- receives at most one first nudge + one terminal second nudge for their
-- still-draft invoice and then drops off the email-cohort entirely.
ALTER TABLE users ADD COLUMN IF NOT EXISTS second_stale_draft_email_sent_at TIMESTAMP;

-- No-invoice nudge stamp. The daily cron picks up users who got the welcome
-- email, are at least 48h past signup, and still have invoice_count = 0
-- (the seed insert deliberately skips that bump, so this column is a clean
-- "no real invoice ever created" gate). One-shot per user: once stamped, the
-- nudge never fires again — this is the signup→first-real-invoice activation
-- step, and a user who ignores it twice will not be moved by a third send.
-- Sits between the welcome email (t=0) and the stale-draft email (t=draft+24h),
-- covering the cohort that gets neither because they never created a draft.
ALTER TABLE users ADD COLUMN IF NOT EXISTS no_invoice_nudge_sent_at TIMESTAMP;

-- Second no-invoice nudge stamp. Fires 7+ days after signup for the cohort
-- still at invoice_count = 0 — the 48h nudge above is one-shot, so a user who
-- ignored or missed it (delivery delay, busy week, RESEND key unset when the
-- first nudge should have fired) is currently lost forever. This second pass
-- uses sharper, problem-solving framing ("hit reply if anything's blocking
-- you") on the same magic-login + /invoices/quick CTA. Also one-shot — a user
-- silent for 7 days after two nudges will not be moved by a third.
ALTER TABLE users ADD COLUMN IF NOT EXISTS second_no_invoice_nudge_sent_at TIMESTAMP;

-- Overdue-invoice freelancer digest stamp (Milestone 4 — first invoice sent →
-- first payment received). Daily cron picks up users whose sent invoices have
-- gone past their due_date and aggregates them into a single "you have N
-- overdue invoices worth $X" email back to the freelancer. Distinct from
-- jobs/reminders.js, which emails the CLIENT (Pro-only, gated on
-- client_email). This stamp covers the freelancer-side activation pull-back:
-- works for ALL plans (free users have no automated client reminder, so
-- this is their only nudge), and even Pro users benefit because the
-- client-side reminder is skipped when client_email is missing. A 7-day
-- cooldown so a user with a chronic backlog isn't spammed daily.
ALTER TABLE users ADD COLUMN IF NOT EXISTS overdue_digest_sent_at TIMESTAMP;

-- Client-side payment-claim widget on the public /i/<token> page (Milestone
-- 4 — first invoice sent → first payment received). The client of a free-tier
-- freelancer pays via Venmo/Zelle/wire/cheque (the "How to pay" instructions
-- the freelancer wrote into their settings) and then clicks "I've sent
-- payment" on the public page. This stamps payment_claimed_at + the
-- structured method/reference, fires an email to the freelancer, and
-- surfaces a "💸 Client reports payment via X" badge on the dashboard so the
-- freelancer can verify the funds landed and one-click Mark-as-Paid. Closes
-- the out-of-band payment loop for the free tier (no Stripe Payment Link)
-- and gives Pro users a fallback for clients who pay by ACH/cheque instead
-- of card. payment_claim_method is one of the small whitelist enforced at
-- the route: cash|check|venmo|zelle|bank_transfer|paypal|other.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_claimed_at TIMESTAMP;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_claim_method VARCHAR(40);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_claim_reference VARCHAR(200);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_claim_note TEXT;

-- Client-viewed-but-unpaid follow-up nudge stamp (Milestone 4 — first invoice
-- sent → first payment received). Fills the gap between the real-time
-- sendClientViewedEmail (fires the instant of first open) and the
-- overdue-freelancer-digest (fires only AFTER due_date passes, often weeks
-- later). The 48h-7d window captures the peak moment: the client demonstrably
-- saw the invoice and is now sitting on it; a freelancer nudge at this exact
-- moment closes the loop before the client forgets entirely. Works for ALL
-- plans — free users get the freelancer-side push to use share-intent buttons,
-- Pro users get the same nudge. One stamp per invoice (not per user) so
-- multiple unpaid-but-viewed invoices each get their own follow-up window.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS client_viewed_followup_sent_at TIMESTAMP;
CREATE INDEX IF NOT EXISTS idx_invoices_client_viewed_followup
  ON invoices(first_viewed_at)
  WHERE status IN ('sent', 'overdue')
    AND first_viewed_at IS NOT NULL
    AND client_viewed_followup_sent_at IS NULL;

-- Terminal client-viewed-but-unpaid follow-up stamp (Milestone 4 — first invoice
-- sent → first payment received). Fires 7+ days after the first
-- client_viewed_followup_sent_at when the invoice is STILL unpaid. Without
-- this terminal pass the freelancer gets exactly one nudge per viewed-unpaid
-- invoice and then silence — and the invoice rides the 30-day window before
-- the overdue-digest picks it up. This second pass closes that gap with an
-- empathetic, terminal "anything we can help unblock?" framing (mirrors the
-- second-stale-draft-email + second-no-invoice-nudge pattern). One stamp per
-- invoice; the cohort is bounded by `first_viewed_at > NOW() - 30d` so we
-- never overlap the overdue-digest's older-cohort window.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS second_client_viewed_followup_sent_at TIMESTAMP;
CREATE INDEX IF NOT EXISTS idx_invoices_second_client_viewed_followup
  ON invoices(client_viewed_followup_sent_at)
  WHERE status IN ('sent', 'overdue')
    AND client_viewed_followup_sent_at IS NOT NULL
    AND second_client_viewed_followup_sent_at IS NULL;

-- Sent-but-never-viewed nudge stamp (Milestone 4 — first invoice sent →
-- first payment received). Covers the cohort where the freelancer fired a
-- share-intent button (WhatsApp/SMS/Email/Copy) on /invoices/:id 72h+ ago
-- but the client has never opened the public /i/<token> link. Common causes:
-- message went to spam, the freelancer copy-pasted to the wrong contact, the
-- client opened the message but didn't tap the link, or WhatsApp number is
-- stale. A nudge at this moment ("your client hasn't opened it yet — try
-- another channel") closes the silent-failure gap that today's surfaces
-- miss entirely: client-viewed-followup is gated on first_viewed_at IS NOT
-- NULL, overdue-freelancer-digest waits for due_date, and reminders.js is
-- Pro-only AND client-facing (irrelevant here — the CLIENT never got the
-- link). Anchored on sent_via_share_intent_at (the unambiguous freelancer
-- intent stamp). One stamp per invoice so multiple unsent invoices each get
-- their own window.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS sent_not_viewed_nudge_sent_at TIMESTAMP;
CREATE INDEX IF NOT EXISTS idx_invoices_sent_not_viewed_nudge
  ON invoices(sent_via_share_intent_at)
  WHERE status IN ('sent', 'overdue')
    AND first_viewed_at IS NULL
    AND sent_via_share_intent_at IS NOT NULL
    AND sent_not_viewed_nudge_sent_at IS NULL;

-- Paid-receipt-to-client stamp (Milestone 4 — first invoice sent → first
-- payment received). When an invoice flips to paid (manual Mark-as-Paid OR
-- Stripe Payment Link webhook), the client receives a short "Paid — thanks"
-- confirmation email so the close-the-loop moment isn't silent. This builds
-- the trust momentum that drives repeat business (the `repeat-client-prompt`
-- on the freelancer's dashboard is the other half of the same loop). Stamp
-- is idempotent — a second flip (e.g. unpaid→paid→unpaid→paid via the
-- Stripe webhook retry) never re-sends. NULL on no client_email or when
-- Resend is not_configured (next mark-paid retries safely). One stamp per
-- invoice, not per user, since each client/invoice pairing deserves its own
-- receipt.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS client_paid_receipt_sent_at TIMESTAMP;

-- Pending-payment-claim follow-up email stamp (Milestone 4 — first invoice
-- sent → first payment received). When the CLIENT clicks "I've sent payment"
-- on the public /i/<token> page we fire sendPaymentClaimedEmail to the
-- freelancer immediately. If 48h pass and the freelancer still hasn't flipped
-- the invoice to paid, the relationship is degrading silently — the client
-- thinks they did their part, the freelancer might never have seen the email
-- (Resend outage, spam folder, mid-batch send failure). This cron fires a
-- second nudge in that exact window, baking a 7-day magic-login URL straight
-- to /invoices/<id> where the freelancer can one-tap Mark-as-Paid. One stamp
-- per invoice — a future claim on a different invoice gets its own window.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_claim_followup_sent_at TIMESTAMP;
CREATE INDEX IF NOT EXISTS idx_invoices_payment_claim_followup
  ON invoices(payment_claimed_at)
  WHERE status <> 'paid'
    AND is_seed = false
    AND payment_claimed_at IS NOT NULL
    AND payment_claim_followup_sent_at IS NULL;

-- Server-sent payment-reminder stamp (Milestone 4 — first invoice sent → first
-- payment received). The dashboard's existing follow-up surfaces are mailto:
-- / sms: / whatsapp: deep-links that hand off to the user's local mail/SMS
-- client. On mobile (especially iOS without a configured mail account) those
-- handoffs frequently dead-end, and the user closes the dashboard without
-- chasing. A server-sent reminder fired from POST /invoices/:id/send-reminder
-- works on every device, every time. last_reminder_email_at gates the
-- cooldown so a panicked freelancer can't blast the same client every five
-- minutes — UPDATE only fires when last_reminder_email_at IS NULL OR is
-- older than the cooldown window (default 48h). Rate-limited, not one-shot:
-- the same invoice can be reminded weekly until paid.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS last_reminder_email_at TIMESTAMP;

-- Password reset / magic-link sign-in (Milestone 1 — signup → first dashboard
-- re-entry). A user who loses their session has to be able to get back into
-- their seeded dashboard or the activation funnel breaks at step 1. Tokens
-- are stored only as SHA-256 hashes — a DB leak does not give an attacker an
-- active reset path. ON DELETE CASCADE wipes a user's outstanding reset
-- tokens when their account is removed. consumed_at + expires_at together
-- enforce single-use, time-boxed semantics; the index on token_hash makes
-- the consume path O(1).
CREATE TABLE IF NOT EXISTS password_resets (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash VARCHAR(64) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  consumed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  kind VARCHAR(20) NOT NULL DEFAULT 'reset' CHECK (kind IN ('reset', 'login'))
);
CREATE INDEX IF NOT EXISTS idx_password_resets_token_hash ON password_resets(token_hash);
CREATE INDEX IF NOT EXISTS idx_password_resets_user_id ON password_resets(user_id);

-- Magic-link sign-in shares the password_resets table via a `kind` column.
-- 'reset' tokens rotate the password on consume (consumePasswordResetAndSetPassword);
-- 'login' tokens just consume + log in (consumeMagicLoginToken), no password
-- change. Default 'reset' so existing rows backfill cleanly on idempotent
-- migration. CHECK constraint stops a typo from producing an
-- unrecognisable-kind row that neither flow would consume.
ALTER TABLE password_resets ADD COLUMN IF NOT EXISTS kind VARCHAR(20) NOT NULL DEFAULT 'reset';
ALTER TABLE password_resets DROP CONSTRAINT IF EXISTS password_resets_kind_check;
ALTER TABLE password_resets ADD CONSTRAINT password_resets_kind_check
  CHECK (kind IN ('reset', 'login'));

CREATE INDEX IF NOT EXISTS idx_invoices_user_id ON invoices(user_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_payment_link_id ON invoices(payment_link_id);
CREATE INDEX IF NOT EXISTS idx_invoices_reminder_due
  ON invoices(status, due_date)
  WHERE status = 'sent';

-- "Continue your draft invoice" recovery (Milestone 2 — first dashboard
-- re-entry → first real invoice created). The /invoices/quick form
-- autosaves any in-progress fields (client_name, client_email, description,
-- amount) on input so a user who starts typing then bounces can pick up
-- where they left off on next visit. The dashboard surfaces a banner
-- pointing back to /invoices/quick whenever this JSON column is populated,
-- and the GET /invoices/quick handler pre-fills the form from it. Cleared
-- on successful create. JSONB so future field additions (notes, due_date,
-- etc.) don't need a schema change; nullable so the row is empty for the
-- vast majority of users who never abandon mid-typing.
ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_quick_invoice JSONB;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_quick_invoice_updated_at TIMESTAMP;

-- Specific re-engagement stamp for users who autosaved a /invoices/quick draft
-- and then bounced. Fires 24h after pending_quick_invoice_updated_at with copy
-- that names the half-typed client/amount/description and a magic-login CTA
-- straight back into /invoices/quick. Distinct from the generic 48h/7d
-- no-invoice-nudge stamps because the cohort signal is stronger (they typed)
-- and the copy is data-specific. One-shot per user; pairs with new gates on
-- the generic nudges so a pending-nudged user isn't dupe-emailed.
ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_invoice_nudge_sent_at TIMESTAMP;

-- Second pending-quick-invoice nudge stamp. The first pending nudge is
-- one-shot; the generic 7-day second-no-invoice nudge gates on
-- pending_invoice_nudge_sent_at IS NULL — meaning a user who autosaved /quick,
-- got the pending-specific nudge, and stayed silent gets nothing else. That
-- cohort has the highest first-invoice intent we capture (they typed real
-- client/amount/description data we still hold) so silence after the first
-- pending nudge wastes the strongest activation signal in the funnel. This
-- second pass fires 7+ days after the first pending nudge for users still at
-- invoice_count = 0 with pending_quick_invoice still populated, with
-- empathetic "still want to send it?" framing on the same magic-login →
-- /invoices/quick CTA so the click auto-signs-in onto the form with their
-- typed values restored. Also one-shot — a silent user after two pending
-- nudges isn't moved by a third.
ALTER TABLE users ADD COLUMN IF NOT EXISTS second_pending_invoice_nudge_sent_at TIMESTAMP;
CREATE INDEX IF NOT EXISTS idx_users_second_pending_invoice_nudge
  ON users(pending_invoice_nudge_sent_at)
  WHERE invoice_count = 0
    AND welcome_email_sent_at IS NOT NULL
    AND lifecycle_emails_opted_out_at IS NULL
    AND pending_quick_invoice IS NOT NULL
    AND pending_invoice_nudge_sent_at IS NOT NULL
    AND second_pending_invoice_nudge_sent_at IS NULL;

-- Conversion-intelligence signals captured from the upgrade-modal "What's
-- missing?" widget (#145). user_id is nullable so the table also accepts
-- anonymous pricing-page submissions; ON DELETE SET NULL preserves the
-- aggregate signal even after the user is wiped. `reason` is the structured
-- bucket (too_expensive | missing_feature | not_ready | still_evaluating |
-- other), `message` the free-text follow-up. `source` namespaces future
-- widgets so a single table feeds every conversion-feedback surface.
CREATE TABLE IF NOT EXISTS feedback_signals (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  source VARCHAR(64) NOT NULL,
  reason VARCHAR(64),
  message TEXT,
  cycle VARCHAR(20),
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_feedback_signals_created_at ON feedback_signals(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_signals_source_reason ON feedback_signals(source, reason);

-- Last-login stamp (Milestone 1 — signup → first dashboard re-entry). PLAN.md's
-- "Done means" lists five funnel stages: signups → re-entered → created real
-- invoice → sent → got paid. The activation-funnel report has always had
-- `welcomed` (welcome_email_sent_at IS NOT NULL) but no `returned` stage, so
-- the operator couldn't see the welcome→return drop-off — the very first
-- conversion gate in the funnel. last_login_at is stamped on every successful
-- explicit re-entry (POST /auth/login, GET /auth/magic/<token>, POST
-- /auth/reset/<token>) and on subsequent authenticated requests via a
-- throttled middleware (writes at most once per 4-hour window per session) so
-- a user with a still-valid session who returns via direct URL also counts.
-- It is NOT stamped during the auto-signin from POST /auth/register — that's
-- the signup itself, not a re-entry.
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP;

-- Self-serve lifecycle-email unsubscribe (CAN-SPAM + RFC 8058 one-click
-- `List-Unsubscribe`). Every lifecycle / re-engagement / activation email
-- the platform sends to its users (welcome, no-invoice nudge x2, pending-
-- quick-invoice nudge, stale-draft email x2, trial-nudge, overdue-digest,
-- client-viewed-followup, sent-not-viewed nudge, pending-payment-claim
-- followup) carries an opaque-token unsubscribe link AND a
-- `List-Unsubscribe`/`List-Unsubscribe-Post` header pair. The link/header
-- hit `POST /unsubscribe/<token>` which stamps
-- `lifecycle_emails_opted_out_at = NOW()`, after which every lifecycle
-- cron query gates with `AND lifecycle_emails_opted_out_at IS NULL` so
-- the user permanently drops off the marketing-email cohort. The user
-- can resubscribe at any time via `POST /unsubscribe/<token>/resubscribe`
-- (the success page exposes the button) — the same token resolves both
-- ways. Transactional emails (invoice-to-client, paid-receipt-to-client,
-- magic-login, password-reset, paid-notification-to-freelancer,
-- first-sent-celebration, client-viewed-real-time, payment-claimed-real-
-- time, referral-celebration) are NOT gated by this stamp — they fire on
-- specific user-initiated events and remain legally transactional. The
-- token is lazy-generated on first need (mirrors referral_code,
-- public_token): 16 hex chars (8 random bytes), UNIQUE for direct
-- lookup. Stable per user — never rotated — so an old email's link still
-- works months later (the value of the link rises with age; rotating it
-- would orphan inboxes).
ALTER TABLE users ADD COLUMN IF NOT EXISTS unsubscribe_token VARCHAR(32) UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS lifecycle_emails_opted_out_at TIMESTAMP;

-- Signup-source attribution. Captured at registration time from the
-- visitor's `?utm_source=…` query string (with session stickiness across
-- the click → bounce → return → register flow) and persisted forever on
-- the user row. Surfaces as a "By signup source" breakdown on the
-- operator's /admin/activation report so the funnel can be sliced by
-- acquisition channel — different sources (niche landing pages, organic
-- referrals, paid traffic, in-app referral links) have wildly different
-- downstream activation rates, and without the breakdown the operator
-- can't tell which channel produces converting users vs. tire-kickers.
-- The middleware whitelists `[A-Za-z0-9._-]{1,32}` on capture so a hostile
-- visitor can't seed arbitrary content into the column or the report.
-- Values longer than 32 chars are silently dropped (a real utm_source
-- like "google" / "twitter" / "freelance-developer-niche" fits comfortably).
ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_source VARCHAR(32);
CREATE INDEX IF NOT EXISTS idx_users_signup_source ON users(signup_source) WHERE signup_source IS NOT NULL;

-- Client phone capture on invoices (Milestone 3 — first invoice created →
-- first invoice sent). Without this, the SMS / WhatsApp share-intent URLs
-- emitted from /invoices/quick (and from the public-share-intents surface on
-- /i/<token>) carry no recipient — `sms:?&body=...` and `https://wa.me/?text=...`
-- — and the freelancer has to hand-pick the client's contact inside Messages
-- or WhatsApp after the tap. Capturing the phone once + threading it into
-- `sms:+15551234567?body=...` and `https://wa.me/15551234567?text=...` cuts a
-- step from the very moment of intent and is what gives the recent-clients
-- quick-pick on a second invoice to the same client real one-tap-send energy.
-- Stored per-invoice (not on users) because freelancers bill multiple clients
-- with different numbers; the recent-clients DISTINCT-ON dropdown surfaces the
-- last-used number per client so a repeat client also gets the same one-tap
-- behaviour without the freelancer re-typing it.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS client_phone VARCHAR(50);

-- Inactive-user re-engagement stamp (Milestone 1 — signup → first dashboard
-- re-entry, applied to the activated-but-silent cohort). The full
-- activation cascade (no-invoice-nudge x2, stale-draft x2, sent-not-viewed
-- nudge, client-viewed-followup x2, overdue-digest, payment-claim-followup,
-- pending-quick-invoice-nudge) fires on invoice-state cohorts. A user who
-- ALREADY activated once (invoice_count > 0) and then went silent for 14+
-- days falls through every existing cron: the no-invoice gates require
-- invoice_count = 0, the draft gates require an open draft, the sent-side
-- gates require recent invoice activity. This cron picks up activated users
-- who haven't logged in for `minInactiveHours` hours with a friendly
-- "anything new to bill?" magic-login CTA back to /invoices/quick. One-shot
-- per user — a user silent after one re-engagement nudge isn't moved by a
-- second. Bounded batch (LIMIT 500) so a legacy backlog doesn't blast SMTP
-- in a single tick. Honours `lifecycle_emails_opted_out_at` like every
-- other lifecycle email.
ALTER TABLE users ADD COLUMN IF NOT EXISTS inactive_reengagement_sent_at TIMESTAMP;
CREATE INDEX IF NOT EXISTS idx_users_inactive_reengagement
  ON users(last_login_at)
  WHERE invoice_count > 0
    AND welcome_email_sent_at IS NOT NULL
    AND lifecycle_emails_opted_out_at IS NULL
    AND last_login_at IS NOT NULL
    AND inactive_reengagement_sent_at IS NULL;

-- Owner-side BCC opt-in (Milestone 3 — first invoice created → first
-- invoice sent). When true, every outbound client invoice email (the
-- one sendInvoiceEmail delivers from POST /invoices/:id/email-client,
-- POST /invoices/quick action=create_and_email, POST /invoices/new
-- action=create_and_email, and the existing draft→sent silent send)
-- also delivers a silent copy to the freelancer's own users.email. The
-- BCC is suppressed when client_email == owner.email (case-insensitive
-- dedupe — sending the user a duplicate of their own self-addressed
-- invoice confuses "did the client get it?"). Defaults to false so
-- existing users don't get an unexpected inbox flood after migration;
-- the settings page exposes the toggle.
ALTER TABLE users ADD COLUMN IF NOT EXISTS bcc_invoice_emails BOOLEAN DEFAULT false;

-- Default invoice notes / footer (Milestones 2 + 3). The notes textarea on
-- /invoices/new and the invoice's notes JSON field on /invoices/quick are
-- empty by default — every new invoice asks the freelancer to retype the
-- same boilerplate ("Net 30. Late fee 1.5%/mo. Thanks for your business!")
-- they put on every previous invoice, or to leave it blank. This column
-- stores a per-user default that pre-fills the notes textarea on the
-- advanced /new form and is written to invoice.notes by the /quick
-- shortcut at create time. Saves keystrokes on the first-real-invoice
-- path (M2) and ships every invoice with consistent payment terms +
-- thanks copy (M3 / M4 — professional invoices get opened sooner and
-- paid faster). 2000-char cap matches payment_instructions; rendered
-- with whitespace preserved on the public /i/<token> page via the
-- invoice's own notes field, so the default flows through every existing
-- presentation surface without further plumbing.
ALTER TABLE users ADD COLUMN IF NOT EXISTS default_invoice_notes TEXT;

-- Tap-to-pay handles for Venmo, Cash App, PayPal.me (Milestone 4 — first
-- invoice sent → first payment received). The existing payment_instructions
-- textarea renders verbatim as a plain-text "How to pay" panel on the
-- public /i/<token> page — informative, but the client must manually copy
-- the handle and re-type it inside the Venmo/Cash App/PayPal app to send
-- payment. These three structured columns let the public page render
-- universal-link buttons with the invoice's amount and number pre-filled,
-- collapsing the 4-step copy/switch/paste/type flow into a single tap on
-- the dominant mobile cohort. Each column is the canonical handle (no
-- leading `@` or `$`, no URL prefix) — normalization + validation lives
-- in lib/payment-handles.js. 64-char cap is far above the platform-level
-- maxes (Venmo 30, Cash App 20, PayPal.me 20) but leaves headroom for
-- future platforms without another schema migration.
ALTER TABLE users ADD COLUMN IF NOT EXISTS venmo_handle VARCHAR(64);
ALTER TABLE users ADD COLUMN IF NOT EXISTS cashapp_handle VARCHAR(64);
ALTER TABLE users ADD COLUMN IF NOT EXISTS paypal_me_handle VARCHAR(64);

-- Zelle handle (Milestone 4 — first invoice sent → first payment
-- received). Unlike Venmo / Cash App / PayPal, Zelle has no public
-- profile URLs and no deep-link standard — it lives entirely inside
-- bank apps. We store the freelancer's registered Zelle handle (an
-- email OR a US phone number) so the public /i/<token> page can render
-- a tap-to-copy handle plus an "open your bank app" hint, collapsing
-- the "ask the freelancer for their Zelle info → wait for reply → re-
-- type into bank app" friction into a single copy-and-paste. 254-char
-- cap matches the email envelope max (RFC 5321) and is far above any
-- phone-shape input; normalization + email-or-phone validation lives
-- in lib/payment-handles.js#normalizeZelleHandle.
ALTER TABLE users ADD COLUMN IF NOT EXISTS zelle_handle VARCHAR(254);

-- Per-user default currency (every Milestone — display propagates to the
-- public /i/<token> share page totals + the PayPal.me tap-to-pay deep
-- link's `/<amount><CCY>` suffix). Pre-this-column, every amount on the
-- public client-facing page was hardcoded `$` + `toFixed(2)` and PayPal's
-- universal-link assumed USD — so a freelancer outside the US either had
-- to squeeze the currency code into their line-item description or
-- accept that their client saw the wrong symbol. Eight ISO-4217 codes
-- supported (USD/EUR/GBP/CAD/AUD/NZD/CHF/JPY); the canonical whitelist
-- + symbol map lives in lib/currency.js + lib/html.js. CHAR(3) NOT NULL
-- DEFAULT 'USD' so every existing row gets the historical default at
-- migration time and the resolver never has to guard against NULL.
ALTER TABLE users ADD COLUMN IF NOT EXISTS default_currency CHAR(3) NOT NULL DEFAULT 'USD';
