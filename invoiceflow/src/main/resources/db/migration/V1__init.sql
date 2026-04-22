CREATE TABLE users (
    id                  BIGSERIAL PRIMARY KEY,
    email               VARCHAR(255) NOT NULL UNIQUE,
    password_hash       VARCHAR(255) NOT NULL,
    full_name           VARCHAR(255) NOT NULL,
    plan                VARCHAR(20)  NOT NULL DEFAULT 'FREE',
    stripe_customer_id  VARCHAR(255),
    stripe_sub_id       VARCHAR(255),
    sub_status          VARCHAR(20),
    created_at          TIMESTAMP    NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE TABLE clients (
    id         BIGSERIAL PRIMARY KEY,
    user_id    BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       VARCHAR(255) NOT NULL,
    email      VARCHAR(255) NOT NULL,
    company    VARCHAR(255),
    address    TEXT,
    created_at TIMESTAMP    NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_clients_user ON clients(user_id);

CREATE TABLE invoices (
    id                  BIGSERIAL PRIMARY KEY,
    user_id             BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id           BIGINT       NOT NULL REFERENCES clients(id),
    invoice_number      VARCHAR(50)  NOT NULL,
    status              VARCHAR(20)  NOT NULL DEFAULT 'DRAFT',
    issue_date          DATE         NOT NULL,
    due_date            DATE         NOT NULL,
    currency            CHAR(3)      NOT NULL DEFAULT 'USD',
    notes               TEXT,
    stripe_payment_link VARCHAR(512),
    last_reminder_sent  TIMESTAMP,
    created_at          TIMESTAMP    NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMP    NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, invoice_number)
);

CREATE INDEX idx_invoices_user   ON invoices(user_id);
CREATE INDEX idx_invoices_status ON invoices(status);
CREATE INDEX idx_invoices_due    ON invoices(due_date);

CREATE TABLE line_items (
    id          BIGSERIAL PRIMARY KEY,
    invoice_id  BIGINT         NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    description VARCHAR(512)   NOT NULL,
    quantity    NUMERIC(10,2)  NOT NULL,
    unit_price  NUMERIC(12,2)  NOT NULL,
    sort_order  INT            NOT NULL DEFAULT 0
);

CREATE INDEX idx_line_items_invoice ON line_items(invoice_id);
