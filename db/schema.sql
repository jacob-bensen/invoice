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

-- Stale-draft email cooldown stamp. The daily cron picks up users with a real
-- draft invoice 24h+ old who haven't been emailed about it in the last 7 days
-- (and only after the welcome email has fired, so a brand-new signup gets the
-- welcome before this nudge). One stamp per user is sufficient — the cron
-- groups stale drafts by user and emails about the oldest, so a single user
-- never gets multiple emails in one tick.
ALTER TABLE users ADD COLUMN IF NOT EXISTS stale_draft_email_sent_at TIMESTAMP;

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
