
export async function ensureBankLensSchema(db: D1Database) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS financial_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bank_id INTEGER NOT NULL,
      source_id INTEGER,
      source_url TEXT NOT NULL,
      source_title TEXT,
      metric_key TEXT NOT NULL,
      metric_label TEXT NOT NULL,
      raw_value TEXT,
      value REAL,
      unit TEXT NOT NULL,
      currency TEXT,
      reporting_period_start TEXT,
      reporting_period_end TEXT,
      period_label TEXT,
      statement_date TEXT,
      content_hash TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      review_note TEXT,
      reviewed_by TEXT,
      reviewed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_financial_records_bank_metric_period
      ON financial_records(bank_id, metric_key, reporting_period_end, status)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_financial_records_review
      ON financial_records(status, created_at)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS financial_extractions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bank_id INTEGER NOT NULL,
      source_id INTEGER,
      source_url TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      period_label TEXT,
      status TEXT NOT NULL DEFAULT 'extracted',
      records_found INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_financial_extractions_hash
      ON financial_extractions(source_id, content_hash)`),
  ]);
}

export async function ensureLatestMetrics(db: D1Database) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS latest_metrics (
    bank_id INTEGER PRIMARY KEY,
    assets REAL,
    deposits REAL,
    profit REAL,
    capital_adequacy REAL,
    liquidity REAL,
    npl REAL,
    reporting_period TEXT,
    reporting_period_end TEXT,
    updated_at TEXT
  )`).run();
}
