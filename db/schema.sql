-- QuickInvoice Database Schema

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(255),
  business_name VARCHAR(255),
  business_address TEXT,
  business_phone VARCHAR(50),
  business_email VARCHAR(255),
  plan VARCHAR(20) DEFAULT 'free' CHECK (plan IN ('free', 'pro')),
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

CREATE INDEX IF NOT EXISTS idx_invoices_user_id ON invoices(user_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_payment_link_id ON invoices(payment_link_id);
