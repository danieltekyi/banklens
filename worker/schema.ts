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
      status TEXT NOT NULL DEFAULT 'published',
      review_note TEXT,
      reviewed_by TEXT,
      reviewed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_financial_records_bank_metric_period ON financial_records(bank_id,metric_key,reporting_period_end,status)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_financial_records_review ON financial_records(status,created_at)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS financial_extractions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bank_id INTEGER NOT NULL,
      source_id INTEGER,
      source_url TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      period_label TEXT,
      status TEXT NOT NULL DEFAULT 'published',
      records_found INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_financial_extractions_hash ON financial_extractions(source_id,content_hash)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS financial_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bank_id INTEGER NOT NULL,
      source_id INTEGER NOT NULL,
      report_url TEXT NOT NULL,
      report_title TEXT,
      report_type TEXT,
      content_hash TEXT,
      content_type TEXT,
      r2_key TEXT,
      reporting_period_start TEXT,
      reporting_period_end TEXT,
      period_label TEXT,
      status TEXT NOT NULL DEFAULT 'published',
      error TEXT,
      discovered_at TEXT NOT NULL,
      downloaded_at TEXT,
      processed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(source_id,report_url,content_hash)
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_financial_documents_source_url ON financial_documents(source_id,report_url)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_financial_documents_bank_period ON financial_documents(bank_id,reporting_period_end,status)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS bank_analysis (
      bank_id INTEGER PRIMARY KEY,
      strengths_json TEXT NOT NULL DEFAULT '[]',
      weaknesses_json TEXT NOT NULL DEFAULT '[]',
      generated_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_bank_analysis_generated ON bank_analysis(generated_at)`),
    // Supporting indexes for the cascade delete in routes/admin-crud.ts and for
    // the public ranking/trend queries in routes/public-api.ts.
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_financial_records_bank ON financial_records(bank_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_financial_records_source ON financial_records(source_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_financial_records_metric_period ON financial_records(metric_key,reporting_period_end,status)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_financial_documents_bank_only ON financial_documents(bank_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_financial_extractions_bank ON financial_extractions(bank_id)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS banklens_latest_metrics (
      bank_id INTEGER PRIMARY KEY,
      assets REAL,
      deposits REAL,
      profit REAL,
      capital_adequacy REAL,
      liquidity REAL,
      npl REAL,
      reporting_period TEXT,
      reporting_period_end TEXT,
      updated_at TEXT,
      assets_source_url TEXT,
      assets_source_title TEXT,
      deposits_source_url TEXT,
      deposits_source_title TEXT,
      profit_source_url TEXT,
      profit_source_title TEXT,
      capital_adequacy_source_url TEXT,
      capital_adequacy_source_title TEXT,
      liquidity_source_url TEXT,
      liquidity_source_title TEXT,
      npl_source_url TEXT,
      npl_source_title TEXT
    )`),
  ]);

  // `latest_metrics` is an existing production view in some BankLens D1 databases.
  // Never ALTER or CREATE TABLE against that object. The writable BankLens snapshot
  // lives in banklens_latest_metrics instead.
  //
  // Best-effort bootstrap: preserve the existing six public metrics if the legacy
  // view is readable. This does not modify or drop the view.
  try {
    await db.prepare(`
      INSERT OR IGNORE INTO banklens_latest_metrics
      (bank_id,assets,deposits,profit,capital_adequacy,liquidity,npl,reporting_period,reporting_period_end,updated_at)
      SELECT bank_id,assets,deposits,profit,capital_adequacy,liquidity,npl,reporting_period,reporting_period_end,COALESCE(updated_at,?)
      FROM latest_metrics
    `).bind(new Date().toISOString()).run();
  } catch {
    // Legacy latest_metrics may not exist or may expose a different shape.
    // New financial scans will populate banklens_latest_metrics.
  }
}

export async function ensureLatestMetrics(db: D1Database) {
  await ensureBankLensSchema(db);
}
