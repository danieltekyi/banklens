-- Only run if banklens_latest_metrics does not exist.
-- This script intentionally does not touch legacy latest_metrics views.
CREATE TABLE IF NOT EXISTS banklens_latest_metrics (
  bank_id INTEGER PRIMARY KEY,
  assets REAL, deposits REAL, profit REAL, capital_adequacy REAL, liquidity REAL, npl REAL,
  reporting_period TEXT, reporting_period_end TEXT, updated_at TEXT,
  assets_source_url TEXT, assets_source_title TEXT,
  deposits_source_url TEXT, deposits_source_title TEXT,
  profit_source_url TEXT, profit_source_title TEXT,
  capital_adequacy_source_url TEXT, capital_adequacy_source_title TEXT,
  liquidity_source_url TEXT, liquidity_source_title TEXT,
  npl_source_url TEXT, npl_source_title TEXT
);
