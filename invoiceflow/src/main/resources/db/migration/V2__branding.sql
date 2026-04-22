ALTER TABLE users
    ADD COLUMN brand_color     CHAR(7)      NOT NULL DEFAULT '#2563eb',
    ADD COLUMN company_name    VARCHAR(255),
    ADD COLUMN company_address TEXT,
    ADD COLUMN company_phone   VARCHAR(50),
    ADD COLUMN company_website VARCHAR(255);

CREATE TABLE user_logos (
    user_id      BIGINT       PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    logo_data    BYTEA        NOT NULL,
    content_type VARCHAR(50)  NOT NULL,
    updated_at   TIMESTAMP    NOT NULL DEFAULT NOW()
);
