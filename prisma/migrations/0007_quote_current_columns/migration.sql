-- Quotes cache the current version's headline facts so lists, filters, sorting and expiry need no join.
ALTER TABLE quotes ADD COLUMN title TEXT, ADD COLUMN quote_date DATE, ADD COLUMN valid_until DATE, ADD COLUMN total_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE quotes ADD CONSTRAINT quotes_total_chk CHECK (total_cents >= 0);
DROP INDEX quotes_expiry_idx;
CREATE INDEX quotes_valid_until_idx ON quotes (business_id, valid_until) WHERE status IN ('SENT', 'VIEWED');
CREATE INDEX quotes_total_idx ON quotes (business_id, total_cents);
