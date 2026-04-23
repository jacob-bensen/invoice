-- Recurring-invoice auto-generation (INTERNAL_TODO #6 / P12)
-- Allows Pro/Agency users to designate an invoice as a template that is
-- cloned on a schedule (WEEKLY, BIWEEKLY, MONTHLY, QUARTERLY). The daily
-- scheduler looks for rows where recurrence_active = true AND
-- recurrence_next_run <= NOW(), clones them as DRAFT, and advances the next run.

ALTER TABLE invoices ADD COLUMN recurrence_frequency VARCHAR(20);
ALTER TABLE invoices ADD COLUMN recurrence_next_run TIMESTAMP;
ALTER TABLE invoices ADD COLUMN recurrence_active BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE invoices ADD COLUMN recurrence_source_id BIGINT;

CREATE INDEX idx_invoices_recurrence_due
    ON invoices(recurrence_active, recurrence_next_run)
    WHERE recurrence_active = TRUE;

CREATE INDEX idx_invoices_recurrence_source ON invoices(recurrence_source_id);
