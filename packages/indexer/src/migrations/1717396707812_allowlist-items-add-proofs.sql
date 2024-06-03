-- Up Migration
ALTER TABLE allowlists_items ADD COLUMN proofs JSONB;

-- Down Migration
ALTER TABLE allowlists_items DROP COLUMN proofs;
