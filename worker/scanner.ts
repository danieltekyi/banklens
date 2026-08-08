
type Source = { id: number; bank_id: number; url: string; source_type: string };

type ExtractedMetric = {
  key: string;
  label: string;
  value: number;
  unit: string;
  currency: string | null;
  rawValue: string;
};

function cleanText(input: string) {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function htmlToText(bytes: ArrayBuffer, contentType: string) {
  const bytes8 = new Uint8Array(bytes);
  let text = new TextDecoder("utf-8", { fatal: false }).decode(bytes8);
  // This fallback is useful for simple text-based PDF files. It deliberately does
  // not claim to parse compressed PDF streams; those remain available for manual review.
  if (contentType.includes("pdf") || text.startsWith("%PDF")) {
    text = text
      .replace(/\\\((.*?)\\\)/g, " $1 ")
      .replace(/\(([^()]*)\)/g, " $1 ")
      .replace(/\\n/g, " ")
      .replace(/\\r/g, " ");
  }
  return cleanText(text);
}

function parseNumber(raw: string) {
  const s = raw.replace(/\s/g, "").replace(/,/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function normalizeAmount(value: number, context: string) {
  const lower = context.toLowerCase();
  if (/\b(billion|bn)\b/.test(lower)) return { value, unit: "GHS_bn" };
  if (/\b(million|mn)\b/.test(lower)) return { value: value / 1000, unit: "GHS_bn" };
  if (/\b(thousand|k)\b/.test(lower)) return { value: value / 1_000_000, unit: "GHS_bn" };
  return { value, unit: "GHS_bn" };
}

function firstMatch(text: string, patterns: RegExp[]) {
  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (!m) continue;
    const raw = m[1] || m[2];
    const value = parseNumber(raw);
    if (value == null) continue;
    const context = text.slice(Math.max(0, (m.index || 0) - 80), Math.min(text.length, (m.index || 0) + m[0].length + 100));
    return { raw, value, context };
  }
  return null;
}

function extractFinancialMetrics(text: string): ExtractedMetric[] {
  const metrics: ExtractedMetric[] = [];
  const amount = (key: string, label: string, patterns: RegExp[]) => {
    const m = firstMatch(text, patterns);
    if (!m) return;
    const normalized = normalizeAmount(m.value, m.context);
    metrics.push({ key, label, value: normalized.value, unit: normalized.unit, currency: "GHS", rawValue: m.raw });
  };
  const percent = (key: string, label: string, patterns: RegExp[]) => {
    const m = firstMatch(text, patterns);
    if (!m) return;
    metrics.push({ key, label, value: m.value, unit: "percent", currency: null, rawValue: m.raw });
  };

  amount("assets", "Total assets", [
    /total\s+assets?\s*[:\-]?\s*(?:ghs|g\hs|¢)?\s*([\d]+(?:[.,]\d+)?)(?:\s*(bn|billion|mn|million|thousand|k))?/i,
    /assets?\s*[:\-]?\s*(?:ghs|g\hs|¢)?\s*([\d]+(?:[.,]\d+)?)(?:\s*(bn|billion|mn|million|thousand|k))?/i,
  ]);
  amount("deposits", "Deposits", [
    /(?:customer\s+)?deposits?\s*[:\-]?\s*(?:ghs|g\hs|¢)?\s*([\d]+(?:[.,]\d+)?)(?:\s*(bn|billion|mn|million|thousand|k))?/i,
  ]);
  amount("profit", "Profit after tax", [
    /profit\s+(?:after\s+tax|for\s+the\s+(?:year|period)|attributable[^:]{0,60})\s*[:\-]?\s*(?:ghs|g\hs|¢)?\s*([\d]+(?:[.,]\d+)?)(?:\s*(bn|billion|mn|million|thousand|k))?/i,
    /profit\s+after\s+tax\s*[:\-]?\s*([\d]+(?:[.,]\d+)?)/i,
  ]);
  percent("capital_adequacy", "Capital adequacy ratio", [
    /capital\s+adequacy\s+(?:ratio)?\s*[:\-]?\s*([\d]+(?:[.,]\d+)?)\s*%/i,
    /\bCAR\b\s*[:\-]?\s*([\d]+(?:[.,]\d+)?)\s*%/i,
  ]);
  percent("liquidity", "Liquidity ratio", [
    /liquidity\s+(?:ratio|coverage\s+ratio)?\s*[:\-]?\s*([\d]+(?:[.,]\d+)?)\s*%/i,
    /\bLCR\b\s*[:\-]?\s*([\d]+(?:[.,]\d+)?)\s*%/i,
  ]);
  percent("npl", "NPL ratio", [
    /(?:non[\-\s]?performing\s+loans?|NPL)\s+(?:ratio)?\s*[:\-]?\s*([\d]+(?:[.,]\d+)?)\s*%/i,
  ]);
  return metrics;
}

function inferPeriod(text: string, url: string) {
  const dayMonthYear = text.match(/(?:year|period|quarter|month)[^\d]{0,40}(?:ended|ending|as at|as of)?[^\d]{0,20}(\d{1,2})[\s/-]+(January|February|March|April|May|June|July|August|September|October|November|December)[\s,/-]+(20\d{2})/i);
  const yearFirst = text.match(/(?:year|period|quarter|month)[^\d]{0,40}(?:ended|ending|as at|as of)?[^\d]{0,20}(20\d{2})/i);
  const urlYear = url.match(/\b(20\d{2})\b/);
  if (dayMonthYear) {
    const months: Record<string,string> = {january:"01",february:"02",march:"03",april:"04",may:"05",june:"06",july:"07",august:"08",september:"09",october:"10",november:"11",december:"12"};
    const month = months[dayMonthYear[2].toLowerCase()];
    const day = dayMonthYear[1].padStart(2,"0");
    const year = dayMonthYear[3];
    return { label: `${day} ${dayMonthYear[2]} ${year}`, end: `${year}-${month}-${day}` };
  }
  const year = yearFirst?.[1] || urlYear?.[1];
  if (!year) {
    const now = new Date();
    return { label: now.getUTCFullYear().toString(), end: `${now.getUTCFullYear()}-12-31` };
  }
  return { label: year, end: `${year}-12-31` };
}

async function createFinancialRecords(
  env: Env,
  source: Source,
  body: ArrayBuffer,
  contentType: string,
  hash: string,
  sourceTitle: string,
) {
  const text = htmlToText(body, contentType);
  const metrics = extractFinancialMetrics(text);
  const period = inferPeriod(text, source.url);
  const now = new Date().toISOString();

  const prior = await env.DB.prepare(
    `SELECT id FROM financial_extractions WHERE source_id=? AND content_hash=? LIMIT 1`,
  ).bind(source.id, hash).first<any>();
  if (prior) return { extracted: 0, skipped: true, period };

  await env.DB.prepare(
    `INSERT INTO financial_extractions(bank_id,source_id,source_url,content_hash,period_label,status,records_found,created_at)
     VALUES(?,?,?,?,?,?,?,?)`,
  ).bind(source.bank_id, source.id, source.url, hash, period.label, "extracted", metrics.length, now).run();

  for (const metric of metrics) {
    await env.DB.prepare(
      `INSERT INTO financial_records
       (bank_id,source_id,source_url,source_title,metric_key,metric_label,raw_value,value,unit,currency,
        reporting_period_start,reporting_period_end,period_label,statement_date,content_hash,status,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      source.bank_id, source.id, source.url, sourceTitle,
      metric.key, metric.label, metric.rawValue, metric.value, metric.unit, metric.currency,
      `${period.label}-01-01`, period.end, period.label, period.end, hash, "pending", now, now,
    ).run();
  }

  return { extracted: metrics.length, skipped: false, period };
}

async function scanSource(env: Env, source: Source) {
  const response = await fetch(source.url, {
    headers: { "User-Agent": "BankLensBot/0.3 (+https://banklens.tiwaak.com/methodology)" },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const body = await response.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest("SHA-256", body);
  const hash = [...new Uint8Array(hashBuffer)].map(x => x.toString(16).padStart(2, "0")).join("");
  const contentType = response.headers.get("content-type") || "";
  const prior = await env.DB.prepare(
    "SELECT content_hash FROM source_checks WHERE source_id=? ORDER BY checked_at DESC LIMIT 1",
  ).bind(source.id).first<{ content_hash: string }>();

  let changed = prior?.content_hash !== hash;
  if (changed) {
    const key = `sources/${source.bank_id}/${Date.now()}-${source.id}`;
    await env.REPORTS.put(key, body, {
      httpMetadata: { contentType: contentType || "application/octet-stream" },
      customMetadata: { sourceUrl: source.url, hash },
    });
  }

  let extracted = 0;
  if (source.source_type === "financial") {
    const result = await createFinancialRecords(env, source, body, contentType, hash, source.url);
    extracted = result.extracted;
  }

  await env.DB.prepare(
    "INSERT INTO source_checks(source_id,status,content_hash,checked_at,error) VALUES(?,?,?,?,NULL)",
  ).bind(source.id, "ok", hash, new Date().toISOString()).run();

  return { changed, extracted };
}

export async function runScan(env: Env) {
  const started = new Date().toISOString();
  let checked = 0, changed = 0, failed = 0, extracted = 0;
  const { results } = await env.DB.prepare("SELECT id,bank_id,url,source_type FROM sources WHERE active=1").all<Source>();
  for (const source of results) {
    checked++;
    try {
      const result = await scanSource(env, source);
      if (result.changed) changed++;
      extracted += result.extracted;
    } catch (error) {
      failed++;
      await env.DB.prepare("INSERT INTO source_checks(source_id,status,checked_at,error) VALUES(?,?,?,?)")
        .bind(source.id, "error", new Date().toISOString(), String(error)).run();
    }
  }
  await env.DB.prepare("INSERT INTO scan_runs(started_at,finished_at,checked,changed,failed,country_id) VALUES(?,?,?,?,?,NULL)")
    .bind(started, new Date().toISOString(), checked, changed, failed).run();
  return { checked, changed, failed, extracted };
}

export async function runScanForCountry(env: Env, countryId: number, progress?: (info: {
  checked: number; total: number; changed: number; failed: number; extracted: number;
  currentSourceId: number | null; bankId: number | null;
}) => Promise<void> | void) {
  const started = new Date().toISOString();
  let checked = 0, changed = 0, failed = 0, extracted = 0;
  const { results: sources } = await env.DB.prepare(
    "SELECT s.id,s.bank_id,s.url,s.source_type FROM sources s JOIN banks b ON s.bank_id=b.id WHERE b.country_id=? AND s.active=1",
  ).bind(countryId).all<Source>();
  const total = sources.length;

  for (const source of sources) {
    checked++;
    try {
      if (progress) await progress({ checked, total, changed, failed, extracted, currentSourceId: source.id, bankId: source.bank_id });
      const result = await scanSource(env, source);
      if (result.changed) changed++;
      extracted += result.extracted;
    } catch (error) {
      failed++;
      await env.DB.prepare("INSERT INTO source_checks(source_id,status,checked_at,error)")
        .bind(source.id, "error", new Date().toISOString()).run();
    }
    if (progress) await progress({ checked, total, changed, failed, extracted, currentSourceId: null, bankId: null });
  }

  await env.DB.prepare("INSERT INTO scan_runs(started_at,finished_at,checked,changed,failed,country_id)")
    .bind(started, new Date().toISOString(), checked, changed, failed, countryId).run();

  return { checked, changed, failed, extracted, total };
}
