import type { Hono } from "hono";
import type { AppEnv } from "../env";
import { latestByBankAndMetric, scoreBanks } from "../analysis";

type Env = AppEnv;

const nowIso = () => new Date().toISOString();

/**
 * The six metrics the public snapshot table carries as first-class columns.
 * Everything else lives in `financial_records` and is read via the trends API.
 */
const SNAPSHOT_METRICS = ["assets", "deposits", "profit", "capital_adequacy", "liquidity", "npl"] as const;

async function resolveCountry(db: D1Database, country: any) {
  if (!country) return null;
  if (country.id) {
    const row = await db.prepare("SELECT * FROM countries WHERE id=?").bind(Number(country.id)).first<any>();
    if (row) return row;
  }
  if (country.iso2) {
    const row = await db
      .prepare("SELECT * FROM countries WHERE iso2=?")
      .bind(String(country.iso2).toUpperCase())
      .first<any>();
    if (row) return row;
  }
  if (country.name) {
    return db.prepare("SELECT * FROM countries WHERE name=?").bind(country.name).first<any>();
  }
  return null;
}

/**
 * Match an incoming record to a configured bank. The collector reports the bank
 * name it was configured with, so an exact match is tried first and a
 * normalised match second. Records that cannot be matched are skipped and
 * reported back rather than silently creating new banks — bank creation stays
 * an administrator decision.
 */
async function resolveBank(db: D1Database, countryId: number, bankName: string) {
  const exact = await db
    .prepare("SELECT id,name FROM banks WHERE country_id=? AND name=? AND active=1")
    .bind(countryId, bankName)
    .first<any>();
  if (exact) return exact;
  const normalised = String(bankName).toLowerCase().replace(/[^a-z0-9]+/g, "");
  const { results } = await db
    .prepare("SELECT id,name,slug FROM banks WHERE country_id=? AND active=1")
    .bind(countryId)
    .all<any>();
  for (const row of results ?? []) {
    const candidate = String(row.name).toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (candidate === normalised) return row;
    if (String(row.slug).replace(/-/g, "") === normalised) return row;
  }
  return null;
}

async function resolveSource(db: D1Database, bankId: number, sourceUrl: string) {
  // The record's source_url is the report itself; the configured portal is the
  // page it was found on. Match on the portal's origin so a PDF hosted on the
  // same site is still attributed to the right configured source.
  const { results } = await db
    .prepare("SELECT id,url FROM sources WHERE bank_id=? AND active=1")
    .bind(bankId)
    .all<any>();
  if (!results?.length) return null;
  let host = "";
  try {
    host = new URL(sourceUrl).host;
  } catch {
    return results[0];
  }
  for (const row of results) {
    try {
      if (new URL(row.url).host === host) return row;
    } catch {
      // Skip a malformed configured URL rather than failing the whole sync.
    }
  }
  return results[0];
}

export function registerPipelineApi(app: Hono<Env>) {
  /**
   * The collector's view of the admin configuration: which countries are
   * enabled, their banks, and the exact portals it is allowed to fetch.
   */
  app.get("/api/admin/pipeline/config", async (c) => {
    const iso2 = c.req.query("country");
    const countrySql = iso2
      ? "SELECT * FROM countries WHERE enabled=1 AND iso2=? ORDER BY name"
      : "SELECT * FROM countries WHERE enabled=1 ORDER BY name";
    const { results: countries } = await (iso2
      ? c.env.DB.prepare(countrySql).bind(String(iso2).toUpperCase())
      : c.env.DB.prepare(countrySql)
    ).all<any>();

    if (!countries?.length) return c.json({ countries: [], banks: [], sources: [] });

    const ids = countries.map((x: any) => Number(x.id));
    const placeholders = ids.map(() => "?").join(",");
    const { results: banks } = await c.env.DB.prepare(
      `SELECT id,slug,name,short_name,country_id,website,active FROM banks
       WHERE country_id IN (${placeholders}) AND active=1 ORDER BY name`,
    )
      .bind(...ids)
      .all<any>();
    const { results: sources } = await c.env.DB.prepare(
      `SELECT s.id,s.bank_id,s.url,s.source_type,s.active,b.name bank_name,b.country_id
       FROM sources s JOIN banks b ON b.id=s.bank_id
       WHERE b.country_id IN (${placeholders}) AND b.active=1 AND s.active=1 AND s.source_type='financial_portal'
       ORDER BY b.name,s.url`,
    )
      .bind(...ids)
      .all<any>();

    return c.json({ countries, banks: banks ?? [], sources: sources ?? [] });
  });

  /**
   * Content hashes and URLs the platform has already processed. The collector
   * uses this to skip downloads, so a re-run costs almost nothing.
   */
  app.get("/api/admin/pipeline/known-hashes", async (c) => {
    const iso2 = c.req.query("country");
    const base = `SELECT d.content_hash,d.report_url FROM financial_documents d
      JOIN banks b ON b.id=d.bank_id JOIN countries c ON c.id=b.country_id
      WHERE d.content_hash IS NOT NULL`;
    const { results } = await (iso2
      ? c.env.DB.prepare(`${base} AND c.iso2=?`).bind(String(iso2).toUpperCase())
      : c.env.DB.prepare(base)
    ).all<any>();
    const hashes = [...new Set((results ?? []).map((r: any) => r.content_hash).filter(Boolean))];
    const urls = [...new Set((results ?? []).map((r: any) => r.report_url).filter(Boolean))];
    return c.json({ hashes, urls, count: hashes.length });
  });

  /**
   * Accept a batch of normalised values from the local collector.
   *
   * Idempotent: a value is keyed on bank + metric + reporting period + content
   * hash, so replaying a batch does not duplicate rows.
   */
  app.post("/api/admin/pipeline/sync", async (c) => {
    const body = await c.req.json().catch(() => null as any);
    if (!body || !Array.isArray(body.records)) {
      return c.json({ error: "Body must be {country, records: []}" }, 400);
    }

    const country = await resolveCountry(c.env.DB, body.country);
    if (!country) return c.json({ error: "Unknown country. Create it in Admin before syncing." }, 404);

    const stamp = nowIso();
    const bankCache = new Map<string, any>();
    const sourceCache = new Map<string, any>();
    let inserted = 0;
    let skipped = 0;
    const unmatched = new Set<string>();
    const documents = new Map<string, any>();

    for (const record of body.records) {
      const bankName = record.bank_name ?? record.bankName;
      if (!bankName || !record.metric_key || record.value === undefined || record.value === null) {
        skipped++;
        continue;
      }

      let bank = bankCache.get(bankName);
      if (bank === undefined) {
        bank = await resolveBank(c.env.DB, Number(country.id), bankName);
        bankCache.set(bankName, bank);
      }
      if (!bank) {
        unmatched.add(bankName);
        skipped++;
        continue;
      }

      const sourceUrl = record.source_url ?? record.sourceUrl ?? "";
      const sourceKey = `${bank.id}:${sourceUrl}`;
      let source = sourceCache.get(sourceKey);
      if (source === undefined) {
        source = await resolveSource(c.env.DB, Number(bank.id), sourceUrl);
        sourceCache.set(sourceKey, source);
      }

      const periodEnd = record.reporting_period_end ?? record.reportingPeriodEnd ?? null;
      const contentHash = record.content_hash ?? record.contentHash ?? null;

      const existing = await c.env.DB.prepare(
        `SELECT id FROM financial_records
         WHERE bank_id=? AND metric_key=? AND COALESCE(reporting_period_end,'')=COALESCE(?,'')
           AND COALESCE(content_hash,'')=COALESCE(?,'')`,
      )
        .bind(bank.id, record.metric_key, periodEnd, contentHash)
        .first<any>();
      if (existing) {
        skipped++;
      } else {
        await c.env.DB.prepare(
          `INSERT INTO financial_records
            (bank_id,source_id,source_url,source_title,metric_key,metric_label,raw_value,value,unit,currency,
             reporting_period_start,reporting_period_end,period_label,content_hash,status,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'published',?,?)`,
        )
          .bind(
            bank.id,
            source?.id ?? null,
            sourceUrl,
            record.source_title ?? record.sourceTitle ?? null,
            record.metric_key,
            record.metric_label ?? record.metric_key,
            record.raw_value ?? record.rawValue ?? null,
            Number(record.value),
            record.unit ?? "amount",
            record.currency ?? country.currency ?? null,
            record.reporting_period_start ?? record.reportingPeriodStart ?? null,
            periodEnd,
            record.period_label ?? record.periodLabel ?? null,
            contentHash,
            stamp,
            stamp,
          )
          .run();
        inserted++;
      }

      if (sourceUrl && source?.id) {
        documents.set(`${source.id}:${sourceUrl}:${contentHash ?? ""}`, {
          bankId: bank.id,
          sourceId: source.id,
          reportUrl: sourceUrl,
          reportTitle: record.source_title ?? record.sourceTitle ?? null,
          reportType: record.report_type ?? record.reportType ?? "financial",
          contentHash,
          periodLabel: record.period_label ?? record.periodLabel ?? null,
          periodStart: record.reporting_period_start ?? record.reportingPeriodStart ?? null,
          periodEnd,
        });
      }
    }

    // Register the underlying documents so the public site can cite them and
    // the collector can dedupe against them on the next run.
    for (const doc of documents.values()) {
      try {
        await c.env.DB.prepare(
          `INSERT OR IGNORE INTO financial_documents
            (bank_id,source_id,report_url,report_title,report_type,content_hash,reporting_period_start,
             reporting_period_end,period_label,status,discovered_at,downloaded_at,processed_at,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,'published',?,?,?,?,?)`,
        )
          .bind(
            doc.bankId,
            doc.sourceId,
            doc.reportUrl,
            doc.reportTitle,
            doc.reportType,
            doc.contentHash,
            doc.periodStart,
            doc.periodEnd,
            doc.periodLabel,
            stamp,
            stamp,
            stamp,
            stamp,
            stamp,
          )
          .run();
      } catch {
        // A duplicate document is expected on a replay; keep going.
      }
    }

    return c.json({
      ok: true,
      countryId: Number(country.id),
      inserted,
      skipped,
      documents: documents.size,
      unmatchedBanks: [...unmatched],
    });
  });

  /**
   * Recompute the published snapshot, strength scores and per-bank analysis for
   * a country once all batches have landed.
   */
  app.post("/api/admin/pipeline/finalize", async (c) => {
    const body = await c.req.json().catch(() => ({}) as any);
    const country = await resolveCountry(c.env.DB, body.country);
    if (!country) return c.json({ error: "Unknown country" }, 404);
    const stamp = nowIso();

    const { results: rows } = await c.env.DB.prepare(
      `SELECT fr.bank_id,fr.metric_key,fr.value,fr.unit,fr.period_label,fr.reporting_period_end,
        fr.source_url,fr.source_title
       FROM financial_records fr JOIN banks b ON b.id=fr.bank_id
       WHERE b.country_id=? AND b.active=1 AND fr.status='published' AND fr.value IS NOT NULL
       ORDER BY fr.reporting_period_end ASC,fr.id ASC`,
    )
      .bind(Number(country.id))
      .all<any>();

    const latest = latestByBankAndMetric(rows ?? []);
    const scores = scoreBanks(latest);

    let banksUpdated = 0;
    for (const [bankId, values] of latest.entries()) {
      const pick = (key: string) => values.find((v) => v.metric_key === key);
      const periodSource = pick("assets") ?? values[0];

      const snapshot: Record<string, any> = {
        reporting_period: periodSource?.period_label ?? null,
        reporting_period_end: periodSource?.reporting_period_end ?? null,
      };
      for (const key of SNAPSHOT_METRICS) {
        const hit = pick(key);
        snapshot[key] = hit?.value ?? null;
        snapshot[`${key}_source_url`] = hit?.source_url ?? null;
        snapshot[`${key}_source_title`] = hit?.source_title ?? null;
      }

      await c.env.DB.prepare(
        `INSERT INTO banklens_latest_metrics
          (bank_id,assets,deposits,profit,capital_adequacy,liquidity,npl,reporting_period,reporting_period_end,updated_at,
           assets_source_url,assets_source_title,deposits_source_url,deposits_source_title,
           profit_source_url,profit_source_title,capital_adequacy_source_url,capital_adequacy_source_title,
           liquidity_source_url,liquidity_source_title,npl_source_url,npl_source_title)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(bank_id) DO UPDATE SET
           assets=excluded.assets,deposits=excluded.deposits,profit=excluded.profit,
           capital_adequacy=excluded.capital_adequacy,liquidity=excluded.liquidity,npl=excluded.npl,
           reporting_period=excluded.reporting_period,reporting_period_end=excluded.reporting_period_end,
           updated_at=excluded.updated_at,
           assets_source_url=excluded.assets_source_url,assets_source_title=excluded.assets_source_title,
           deposits_source_url=excluded.deposits_source_url,deposits_source_title=excluded.deposits_source_title,
           profit_source_url=excluded.profit_source_url,profit_source_title=excluded.profit_source_title,
           capital_adequacy_source_url=excluded.capital_adequacy_source_url,
           capital_adequacy_source_title=excluded.capital_adequacy_source_title,
           liquidity_source_url=excluded.liquidity_source_url,liquidity_source_title=excluded.liquidity_source_title,
           npl_source_url=excluded.npl_source_url,npl_source_title=excluded.npl_source_title`,
      )
        .bind(
          bankId,
          snapshot.assets,
          snapshot.deposits,
          snapshot.profit,
          snapshot.capital_adequacy,
          snapshot.liquidity,
          snapshot.npl,
          snapshot.reporting_period,
          snapshot.reporting_period_end,
          stamp,
          snapshot.assets_source_url,
          snapshot.assets_source_title,
          snapshot.deposits_source_url,
          snapshot.deposits_source_title,
          snapshot.profit_source_url,
          snapshot.profit_source_title,
          snapshot.capital_adequacy_source_url,
          snapshot.capital_adequacy_source_title,
          snapshot.liquidity_source_url,
          snapshot.liquidity_source_title,
          snapshot.npl_source_url,
          snapshot.npl_source_title,
        )
        .run();
      banksUpdated++;
    }

    let analysed = 0;
    for (const [bankId, score] of scores.entries()) {
      await c.env.DB.prepare(
        `INSERT INTO bank_analysis(bank_id,strengths_json,weaknesses_json,generated_at)
         VALUES(?,?,?,?)
         ON CONFLICT(bank_id) DO UPDATE SET
           strengths_json=excluded.strengths_json,
           weaknesses_json=excluded.weaknesses_json,
           generated_at=excluded.generated_at`,
      )
        .bind(bankId, JSON.stringify(score.strengths), JSON.stringify(score.weaknesses), stamp)
        .run();
      await c.env.DB.prepare("UPDATE banks SET health_score=?,updated_at=? WHERE id=?")
        .bind(score.score, stamp, bankId)
        .run();
      analysed++;
    }

    // Record the run so the admin console can show when data last moved.
    try {
      const run = body.run ?? {};
      await c.env.DB.prepare(
        "INSERT INTO scan_runs(started_at,finished_at,checked,changed,failed,country_id) VALUES(?,?,?,?,?,?)",
      )
        .bind(
          run.run_at ?? stamp,
          stamp,
          Number(run.reports_seen ?? 0),
          Number(run.new_reports ?? 0),
          Array.isArray(run.failures) ? run.failures.length : 0,
          Number(country.id),
        )
        .run();
    } catch {
      // scan_runs is diagnostic only.
    }

    return c.json({ ok: true, countryId: Number(country.id), banksUpdated, analysed });
  });
}
