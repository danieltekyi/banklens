-- scan_runs.country_id is created directly by 0001_initial.sql.
-- This migration previously ran `ALTER TABLE scan_runs ADD COLUMN country_id`,
-- which fails with "duplicate column name" on any database built from the
-- current 0001 baseline. Databases provisioned before country_id was folded
-- into 0001 already applied that ALTER, so both shapes now have the column.
-- Keep this file idempotent so fresh deployments migrate cleanly.
CREATE INDEX IF NOT EXISTS idx_scan_runs_country ON scan_runs(country_id);