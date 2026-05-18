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

-- No-invoice nudge stamp. The daily cron picks up users who got the welcome
-- email, are at least 48h past signup, and still have invoice_count = 0
-- (the seed insert deliberately skips that bump, so this column is a clean
-- "no real invoice ever created" gate). One-shot per user: once stamped, the
-- nudge never fires again — this is the signup→first-real-invoice activation
-- step, and a user who ignores it twice will not be moved by a third send.
-- Sits between the welcome email (t=0) and the stale-draft email (t=draft+24h),
-- covering the cohort that gets neither because they never created a draft.
ALTER TABLE users ADD COLUMN IF NOT EXISTS no_invoice_nudge_sent_at TIMESTAMP;

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
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_password_resets_token_hash ON password_resets(token_hash);
CREATE INDEX IF NOT EXISTS idx_password_resets_user_id ON password_resets(user_id);

CREATE INDEX IF NOT EXISTS idx_invoices_user_id ON invoices(user_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_payment_link_id ON invoices(payment_link_id);
CREATE INDEX IF NOT EXISTS idx_invoices_reminder_due
  ON invoices(status, due_date)
  WHERE status = 'sent';

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
