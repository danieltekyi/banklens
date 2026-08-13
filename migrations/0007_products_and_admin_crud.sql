-- BankLens 0007
-- Consumer decision support + delete/amend support + reporting indexes.

-- Rate cards and product terms an administrator maintains per bank. The weekly
-- collector fills in statutory financial statements; product pricing is a
-- separate, admin-curated feed because banks publish it outside the audited
-- accounts. Every row keeps its own citation so the public site never shows a
-- rate without a source.
CREATE TABLE IF NOT EXISTS bank_products(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_id INTEGER NOT NULL,
  product_name TEXT NOT NULL,
  product_type TEXT NOT NULL,            -- deposit | credit | account | transfer
  category TEXT,                          -- savings, fixed_deposit, personal_loan, mortgage, sme_loan, current...
  rate REAL,                              -- annual percentage rate
  rate_note TEXT,
  min_amount REAL,
  max_amount REAL,
  tenor_months INTEGER,
  fee REAL,
  fee_note TEXT,
  eligibility TEXT,
  currency TEXT,
  source_url TEXT,
  source_title TEXT,
  effective_date TEXT,
  status TEXT NOT NULL DEFAULT 'published',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(bank_id) REFERENCES banks(id)
);
CREATE INDEX IF NOT EXISTS idx_bank_products_bank ON bank_products(bank_id,product_type,status);
CREATE INDEX IF NOT EXISTS idx_bank_products_type_rate ON bank_products(product_type,status,rate);

-- Deleting a bank has to clear every table that references it. These indexes
-- keep the cascade cheap. Indexes on financial_records / financial_documents /
-- financial_extractions live in worker/schema.ts instead, because those tables
-- are created at runtime by ensureBankLensSchema rather than by a migration.
CREATE INDEX IF NOT EXISTS idx_sources_bank ON sources(bank_id);
CREATE INDEX IF NOT EXISTS idx_banks_country ON banks(country_id,active);

-- Audit trail for destructive admin actions, so a deletion is explainable later.
CREATE TABLE IF NOT EXISTS admin_audit_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  entity_label TEXT,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_log(created_at DESC);
