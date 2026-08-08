type Source = { id: number; bank_id: number; url: string; source_type: string };
type ReportLink = { url: string; title: string; reportType: string };
type ExtractedMetric = {
  key: string; label: string; value: number; unit: string; currency: string | null; rawValue: string;
};

type Period = { label: string; start: string; end: string };

const REPORT_TERMS = /annual|financial|statement|results|report|accounts|audited|unaudited|q1|q2|q3|q4|quarter|half[-\s]?year|h1|h2|year[-\s]?end|interim|prudential/i;
const EXCLUDED_TERMS = /privacy|cookie|career|job|vacancy|contact|news|press|sustainability|governance|tariff|fee|loan|saving|product|social|facebook|linkedin|youtube/i;

function cleanText(input: string) {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function decodePdfLiteral(value: string) {
  return value
    .replace(/\\([nrtbf()\\])/g, (_m, c) => ({ n:"\n", r:"\r", t:"\t", b:"\b", f:"\f", "(":"(", ")":")", "\\":"\\" } as Record<string,string>)[c] || c)
    .replace(/\\(\d{1,3})/g, (_m, oct) => String.fromCharCode(parseInt(oct, 8)))
    .replace(/\\\r?\n/g, "");
}

async function inflate(bytes: Uint8Array) {
  try {
    const ds = new DecompressionStream("deflate");
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return bytes;
  }
}

async function pdfToText(bytes: ArrayBuffer) {
  const raw = new Uint8Array(bytes);
  const latin = new TextDecoder("latin1").decode(raw);
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < latin.length) {
    const streamAt = latin.indexOf("stream", cursor);
    if (streamAt < 0) break;
    const dictStart = Math.max(0, latin.lastIndexOf("obj", streamAt - 1) - 1200);
    const dict = latin.slice(dictStart, streamAt);
    let dataStart = streamAt + 6;
    if (latin[dataStart] === "\r") dataStart++;
    if (latin[dataStart] === "\n") dataStart++;
    const endAt = latin.indexOf("endstream", dataStart);
    if (endAt < 0) break;
    const data = raw.slice(dataStart, endAt);
    const decoded = /\/FlateDecode/i.test(dict) ? await inflate(data) : data;
    const text = new TextDecoder("latin1").decode(decoded);
    for (const bt of text.matchAll(/BT([\s\S]*?)ET/g)) {
      const block = bt[1];
      for (const m of block.matchAll(/\((?:\\.|[^\\)])*\)\s*Tj/g)) chunks.push(decodePdfLiteral(m[0].replace(/\)\s*Tj$/, "").replace(/^\(/, "")));
      for (const m of block.matchAll(/\[(.*?)\]\s*TJ/g)) {
        for (const part of m[1].matchAll(/\((?:\\.|[^\\)])*\)/g)) chunks.push(decodePdfLiteral(part[0].slice(1, -1)));
      }
      for (const m of block.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) {
        const hex = m[1];
        let out = "";
        for (let i = 0; i + 3 < hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
        chunks.push(out);
      }
    }
    cursor = endAt + 9;
  }
  return cleanText(chunks.join(" "));
}

async function responseToText(body: ArrayBuffer, contentType: string) {
  if (/pdf/i.test(contentType) || new TextDecoder("latin1").decode(new Uint8Array(body).slice(0, 5)) === "%PDF-") return pdfToText(body);
  return cleanText(new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(body)));
}

function parseNumber(raw: string) {
  const s = raw.replace(/\s/g, "").replace(/,/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function unitContext(text: string, position: number) {
  const context = text.slice(Math.max(0, position - 600), Math.min(text.length, position + 700));
  const lower = context.toLowerCase();
  if (/gh[₵s]?\s*['’]?000|g hs\s+thousand|ghs\s+thousand|in\s+thousands|\(000s?\)/i.test(lower)) return "thousand";
  if (/gh[₵s]?\s*['’]?000\s*,?\s*000|ghs\s+million|in\s+millions|\(m\)/i.test(lower)) return "million";
  if (/ghs\s+billion|in\s+billions|\(bn\)/i.test(lower)) return "billion";
  return null;
}

function normalizeAmount(value: number, unitContextValue: string | null) {
  if (unitContextValue === "thousand") return { value: value / 1_000_000, unit: "GHS_bn" };
  if (unitContextValue === "million") return { value: value / 1_000, unit: "GHS_bn" };
  if (unitContextValue === "billion") return { value, unit: "GHS_bn" };
  return null;
}

function firstMatch(text: string, patterns: RegExp[]) {
  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (!m) continue;
    const raw = m[1];
    const value = parseNumber(raw);
    if (value == null) continue;
    return { raw, value, position: m.index || 0 };
  }
  return null;
}

function extractFinancialMetrics(text: string): ExtractedMetric[] {
  const metrics: ExtractedMetric[] = [];
  const amount = (key: string, label: string, patterns: RegExp[]) => {
    const m = firstMatch(text, patterns);
    if (!m) return;
    const normalized = normalizeAmount(m.value, unitContext(text, m.position));
    if (!normalized) return;
    metrics.push({ key, label, value: normalized.value, unit: normalized.unit, currency: "GHS", rawValue: m.raw });
  };
  const percent = (key: string, label: string, patterns: RegExp[]) => {
    const m = firstMatch(text, patterns);
    if (!m) return;
    metrics.push({ key, label, value: m.value, unit: "percent", currency: null, rawValue: m.raw });
  };

  amount("assets", "Total assets", [/total\s+(?:assets|asset)\b[^\d]{0,80}(?:ghs|g hs|¢)?\s*([\d]+(?:[.,]\d+)?)/i]);
  amount("deposits", "Customer deposits", [/(?:customer\s+)?deposits?\b[^\d]{0,80}(?:ghs|g hs|¢)?\s*([\d]+(?:[.,]\d+)?)/i]);
  amount("profit", "Profit after tax", [/(?:profit\s+after\s+tax|profit\s+for\s+the\s+(?:year|period)|profit\s+attributable)[^\d]{0,100}(?:ghs|g hs|¢)?\s*([\d]+(?:[.,]\d+)?)/i]);
  amount("loans", "Loans and advances", [/(?:loans?\s+and\s+advances|gross\s+loans?|net\s+loans?)[^\d]{0,100}(?:ghs|g hs|¢)?\s*([\d]+(?:[.,]\d+)?)/i]);
  amount("equity", "Total equity", [/(?:total\s+equity|shareholders?['’]?\s+funds|total\s+shareholders?['’]?\s+equity)[^\d]{0,100}(?:ghs|g hs|¢)?\s*([\d]+(?:[.,]\d+)?)/i]);
  amount("liabilities", "Total liabilities", [/(?:total\s+liabilities?|liabilities)[^\d]{0,100}(?:ghs|g hs|¢)?\s*([\d]+(?:[.,]\d+)?)/i]);
  amount("net_interest_income", "Net interest income", [/(?:net\s+interest\s+income)[^\d]{0,100}(?:ghs|g hs|¢)?\s*([\d]+(?:[.,]\d+)?)/i]);
  amount("impairment", "Credit impairment charge", [/(?:credit\s+(?:impairment|impairment\s+charge)|impairment\s+(?:charge|loss))[^\d]{0,100}(?:ghs|g hs|¢)?\s*([\d]+(?:[.,]\d+)?)/i]);
  amount("revenue", "Total income / revenue", [/(?:total\s+(?:income|revenue)|total\s+operating\s+income)[^\d]{0,100}(?:ghs|g hs|¢)?\s*([\d]+(?:[.,]\d+)?)/i]);
  amount("operating_expenses", "Operating expenses", [/(?:operating\s+expenses?|total\s+operating\s+expenses?)[^\d]{0,100}(?:ghs|g hs|¢)?\s*([\d]+(?:[.,]\d+)?)/i]);
  percent("capital_adequacy", "Capital adequacy ratio", [/capital\s+adequacy\s+(?:ratio)?[^\d]{0,40}([\d]+(?:[.,]\d+)?)\s*%/i, /\bCAR\b[^\d]{0,20}([\d]+(?:[.,]\d+)?)\s*%/i]);
  percent("liquidity", "Liquidity ratio", [/(?:liquid(?:ity)?\s+ratio|liquid\s+assets?\s+ratio)[^\d]{0,40}([\d]+(?:[.,]\d+)?)\s*%/i, /\bLCR\b[^\d]{0,20}([\d]+(?:[.,]\d+)?)\s*%/i]);
  percent("npl", "NPL ratio", [/(?:non[\s-]?performing\s+loans?|NPL)(?:\s+ratio)?[^\d]{0,40}([\d]+(?:[.,]\d+)?)\s*%/i]);
  percent("roe", "Return on equity", [/(?:return\s+on\s+equity|ROE)[^\d]{0,30}([\d]+(?:[.,]\d+)?)\s*%/i]);
  percent("roa", "Return on assets", [/(?:return\s+on\s+assets|ROA)[^\d]{0,30}([\d]+(?:[.,]\d+)?)\s*%/i]);
  percent("cost_to_income", "Cost-to-income ratio", [/(?:cost[\s-]?to[\s-]?income|cost\s+income)\s*(?:ratio)?[^\d]{0,30}([\d]+(?:[.,]\d+)?)\s*%/i]);
  percent("net_interest_margin", "Net interest margin", [/(?:net\s+interest\s+margin|NIM)[^\d]{0,30}([\d]+(?:[.,]\d+)?)\s*%/i]);
  percent("credit_loss_ratio", "Credit loss ratio", [/(?:credit\s+loss\s+ratio)[^\d]{0,30}([\d]+(?:[.,]\d+)?)\s*%/i]);

  const seen = new Set<string>();
  return metrics.filter(m => { if (seen.has(m.key)) return false; seen.add(m.key); return true; });
}

function inferPeriod(text: string, title: string, url: string): Period {
  const combined = `${title} ${text} ${url}`;
  const lower = combined.toLowerCase();
  const yearMatch = combined.match(/\b(20\d{2})\b/);
  const year = yearMatch?.[1] || String(new Date().getUTCFullYear());
  const q = lower.match(/\bq([1-4])\b|\b([1-4])(?:st|nd|rd|th)\s+quarter\b/);
  if (q) {
    const quarter = Number(q[1] || q[2]);
    const month = quarter * 3;
    const end = new Date(Date.UTC(Number(year), month, 0));
    const mm = String(month).padStart(2,"0");
    const dd = String(end.getUTCDate()).padStart(2,"0");
    return { label:`Q${quarter} ${year}`, start:`${year}-${String(month-2).padStart(2,"0")}-01`, end:`${year}-${mm}-${dd}` };
  }
  if (/\b(?:h1|half\s+year|six\s+months?)\b/i.test(combined)) return { label:`H1 ${year}`, start:`${year}-01-01`, end:`${year}-06-30` };
  if (/\b(?:h2|second\s+half)\b/i.test(combined)) return { label:`H2 ${year}`, start:`${year}-07-01`, end:`${year}-12-31` };
  const exact = combined.match(/(?:ended|ending|as at|as of)\s+(\d{1,2})[\s/-]+(January|February|March|April|May|June|July|August|September|October|November|December)[\s,/-]+(20\d{2})/i);
  if (exact) {
    const months: Record<string,string> = {january:"01",february:"02",march:"03",april:"04",may:"05",june:"06",july:"07",august:"08",september:"09",october:"10",november:"11",december:"12"};
    const month = months[exact[2].toLowerCase()]; const day = exact[1].padStart(2,"0");
    return { label:`${exact[1]} ${exact[2]} ${exact[3]}`, start:`${exact[3]}-${month}-01`, end:`${exact[3]}-${month}-${day}` };
  }
  return { label:`FY ${year}`, start:`${year}-01-01`, end:`${year}-12-31` };
}

function extractReportLinks(html: string, baseUrl: string): ReportLink[] {
  const links: ReportLink[] = [];
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      const url = new URL(m[1], baseUrl).href;
      const title = cleanText(m[2]).slice(0, 300);
      const text = `${title} ${url}`;
      if (!/^https?:$/i.test(new URL(url).protocol)) continue;
      if (!REPORT_TERMS.test(text) || EXCLUDED_TERMS.test(text)) continue;
      const isPdf = /\.pdf(?:$|[?#])/i.test(url) || /pdf/i.test(text);
      if (!isPdf && !/annual|financial|statement|results|report|accounts|q[1-4]|half/i.test(text)) continue;
      links.push({ url, title: title || url, reportType: /quarter|q[1-4]/i.test(text) ? "quarterly" : /annual|year/i.test(text) ? "annual" : "financial" });
    } catch {}
  }
  const unique = new Map<string, ReportLink>();
  for (const link of links) unique.set(link.url, link);
  return [...unique.values()];
}

async function hashBytes(body: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", body);
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2,"0")).join("");
}

async function rebuildLatestMetrics(env: Env, bankId: number) {
  const { results } = await env.DB.prepare(
    `SELECT metric_key,value,unit,reporting_period_end,period_label,source_url,source_title
     FROM financial_records WHERE bank_id=? AND status='published'
     ORDER BY reporting_period_end DESC,id DESC`,
  ).bind(bankId).all<any>();
  const snapshot: any = { bank_id: bankId, updated_at:new Date().toISOString() };
  for (const row of results || []) {
    if (snapshot[row.metric_key] == null) {
      snapshot[row.metric_key] = row.value;
      snapshot[`${row.metric_key}_source_url`] = row.source_url;
      snapshot[`${row.metric_key}_source_title`] = row.source_title;
      snapshot.reporting_period = row.period_label;
      snapshot.reporting_period_end = row.reporting_period_end;
    }
  }
  await env.DB.prepare("DELETE FROM latest_metrics WHERE bank_id=?").bind(bankId).run();
  const names = ["bank_id","assets","deposits","profit","capital_adequacy","liquidity","npl","reporting_period","reporting_period_end","updated_at",
    "assets_source_url","assets_source_title","deposits_source_url","deposits_source_title","profit_source_url","profit_source_title",
    "capital_adequacy_source_url","capital_adequacy_source_title","liquidity_source_url","liquidity_source_title","npl_source_url","npl_source_title"];
  const marks = names.map(() => "?").join(",");
  await env.DB.prepare(`INSERT INTO latest_metrics(${names.join(",")}) VALUES(${marks})`).bind(...names.map(n => snapshot[n] ?? null)).run();
}

async function rebuildBankAnalysis(env: Env, bankId: number, countryId: number) {
  const previous = await env.DB.prepare(
    `SELECT metric_key,value,reporting_period_end FROM financial_records WHERE bank_id=? AND status='published' ORDER BY reporting_period_end DESC,id DESC`,
  ).bind(bankId).all<any>();
  const latestMap: Record<string,number> = {};
  for (const row of previous.results || []) if (latestMap[row.metric_key] == null) latestMap[row.metric_key] = Number(row.value);
  const strengths: string[] = [];
  const weaknesses: string[] = [];
  const rows = previous.results || [];
  const trend = (key:string, label:string, positiveWhen:string) => {
    const vals = rows.filter((r:any)=>r.metric_key===key).map((r:any)=>Number(r.value));
    if (vals.length >= 2) {
      const a = vals[0], b = vals[1];
      if ((positiveWhen === "up" && a > b) || (positiveWhen === "down" && a < b)) strengths.push(`${label} improved versus the prior reported period.`);
      if ((positiveWhen === "up" && a < b) || (positiveWhen === "down" && a > b)) weaknesses.push(`${label} moved in an unfavourable direction versus the prior reported period.`);
    }
  };
  trend("profit","Profitability","up"); trend("capital_adequacy","Capital adequacy","up"); trend("liquidity","Liquidity","up"); trend("npl","NPL ratio","down"); trend("roe","Return on equity","up"); trend("cost_to_income","Cost-to-income ratio","down");
  const peer = await env.DB.prepare(
    `SELECT lm.capital_adequacy,lm.liquidity,lm.npl FROM latest_metrics lm JOIN banks b ON b.id=lm.bank_id WHERE b.country_id=? AND b.active=1`,
  ).bind(countryId).all<any>();
  const peerRows = peer.results || [];
  const percentile = (field:string, higherBetter:boolean) => {
    const v = Number(latestMap[field]); if (!Number.isFinite(v) || !peerRows.length) return;
    const values = peerRows.map((x:any)=>Number(x[field])).filter(Number.isFinite);
    if (!values.length) return;
    const better = values.filter(x => higherBetter ? x <= v : x >= v).length / values.length;
    if (better >= .75) strengths.push(`${field.replace(/_/g," ")} is in the stronger quartile among configured peers.`);
    if (better <= .25) weaknesses.push(`${field.replace(/_/g," ")} is in the weaker quartile among configured peers.`);
  };
  percentile("capital_adequacy",true); percentile("liquidity",true); percentile("npl",false);
  const uniq = (items:string[]) => [...new Set(items)].slice(0,4);
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT OR REPLACE INTO bank_analysis(bank_id,strengths_json,weaknesses_json,generated_at) VALUES(?,?,?,?)")
    .bind(bankId, JSON.stringify(uniq(strengths)), JSON.stringify(uniq(weaknesses)), now).run();
  const scoreParts = [
    [Number(latestMap.capital_adequacy), 25, true], [Number(latestMap.liquidity), 20, true], [Number(latestMap.roe ?? latestMap.profit), 20, true], [Number(latestMap.npl), 20, false], [Number(latestMap.cost_to_income), 15, false],
  ];
  let scoreTotal = 0; let weight = 0;
  for (const [v,w,high] of scoreParts as any[]) if (Number.isFinite(v)) {
    const component = high ? Math.min(100, Math.max(0, v * (v <= 50 ? 4 : 1.5))) : Math.max(0, 100 - v * 2.5);
    scoreTotal += component * w; weight += w;
  }
  const score = weight ? Math.max(0, Math.min(100, Math.round(scoreTotal / weight))) : 50;
  const summary = strengths.length ? strengths[0] : "Financial history is being built from configured official reports.";
  await env.DB.prepare("UPDATE banks SET health_score=?,summary=?,updated_at=? WHERE id=?").bind(score, summary, now, bankId).run();
}

async function processReport(env: Env, source: Source, report: ReportLink) {
  const existing = await env.DB.prepare("SELECT id,content_hash,status FROM financial_documents WHERE source_id=? AND report_url=? ORDER BY id DESC LIMIT 1").bind(source.id, report.url).first<any>();

  const response = await fetch(report.url, { headers:{ "User-Agent":"BankLensBot/0.4 (+https://banklens.tiwaak.com/methodology)" } });
  if (!response.ok) throw new Error(`Report HTTP ${response.status}`);
  const body = await response.arrayBuffer();
  const contentType = response.headers.get("content-type") || "application/octet-stream";
  const hash = await hashBytes(body);
  if (existing?.content_hash === hash) return { newReport:false, extracted:0, published:0, skipped:true };

  const now = new Date().toISOString();
  const text = await responseToText(body, contentType);
  const period = inferPeriod(text, report.title, report.url);
  const r2Key = `reports/${source.bank_id}/${period.end}-${hash.slice(0,16)}.${/pdf/i.test(contentType)||/\.pdf/i.test(report.url)?"pdf":"html"}`;
  await env.REPORTS.put(r2Key, body, { httpMetadata:{contentType}, customMetadata:{sourceUrl:report.url,hash,bankId:String(source.bank_id)} });
  await env.DB.prepare(`INSERT INTO financial_documents(bank_id,source_id,report_url,report_title,report_type,content_hash,content_type,r2_key,reporting_period_start,reporting_period_end,period_label,status,discovered_at,downloaded_at,processed_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(source.bank_id,source.id,report.url,report.title,report.reportType,hash,contentType,r2Key,period.start,period.end,period.label,"published",now,now,now,now,now).run();
  const metrics = extractFinancialMetrics(text);
  await env.DB.prepare(`INSERT INTO financial_extractions(bank_id,source_id,source_url,content_hash,period_label,status,records_found,created_at) VALUES(?,?,?,?,?,?,?,?)`)
    .bind(source.bank_id,source.id,report.url,hash,period.label,"published",metrics.length,now).run();
  let published = 0;
  for (const metric of metrics) {
    await env.DB.prepare(`INSERT INTO financial_records(bank_id,source_id,source_url,source_title,metric_key,metric_label,raw_value,value,unit,currency,reporting_period_start,reporting_period_end,period_label,statement_date,content_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(source.bank_id,source.id,report.url,report.title,metric.key,metric.label,metric.rawValue,metric.value,metric.unit,metric.currency,period.start,period.end,period.label,period.end,hash,"published",now,now,now,now).run();
    published++;
  }
  await rebuildLatestMetrics(env, source.bank_id);
  const bank = await env.DB.prepare("SELECT country_id FROM banks WHERE id=?").bind(source.bank_id).first<any>();
  if (bank) await rebuildBankAnalysis(env, source.bank_id, Number(bank.country_id));
  return { newReport:true, extracted:metrics.length, published, skipped:false, period:period.label, url:report.url };
}

async function scanConfiguredSource(env: Env, source: Source) {
  const response = await fetch(source.url, { headers:{"User-Agent":"BankLensBot/0.4 (+https://banklens.tiwaak.com/methodology)"} });
  if (!response.ok) throw new Error(`Portal HTTP ${response.status}`);
  const body = await response.arrayBuffer();
  const contentType = response.headers.get("content-type") || "";
  const hash = await hashBytes(body);
  await env.DB.prepare("INSERT INTO source_checks(source_id,status,content_hash,checked_at,error) VALUES(?,?,?,?,NULL)").bind(source.id,"ok",hash,new Date().toISOString()).run();
  const isPdf = /pdf/i.test(contentType) || new TextDecoder("latin1").decode(new Uint8Array(body).slice(0,5)) === "%PDF-";
  const reports: ReportLink[] = isPdf ? [{url:source.url,title:"Financial report",reportType:"financial"}] : extractReportLinks(new TextDecoder("utf-8",{fatal:false}).decode(new Uint8Array(body)),source.url);
  let newReports=0, extracted=0, published=0, failed=0;
  for (const report of reports.slice(0,40)) {
    try { const r = await processReport(env,source,report); if(r.newReport)newReports++; extracted += r.extracted; published += r.published; }
    catch (error) { failed++; console.error("REPORT_PROCESS_ERROR",source.id,report.url,String(error)); }
  }
  return { changed:true, reportsFound:reports.length, newReports, extracted, published, failed };
}

export async function runConfiguredScan(env: Env, countryId?: number, progress?: (info:any)=>Promise<void>|void) {
  const started = new Date().toISOString();
  const query = countryId
    ? "SELECT s.id,s.bank_id,s.url,s.source_type FROM sources s JOIN banks b ON b.id=s.bank_id WHERE b.country_id=? AND b.active=1 AND s.active=1 AND s.source_type='financial_portal'"
    : "SELECT id,bank_id,url,source_type FROM sources WHERE active=1 AND source_type='financial_portal'";
  const q = countryId ? env.DB.prepare(query).bind(countryId) : env.DB.prepare(query);
  const { results:sources } = await q.all<Source>();
  let checked=0, failed=0, reportsFound=0, newReports=0, extracted=0, published=0;
  for (const source of sources) {
    checked++;
    if(progress) await progress({status:"checking",checked,total:sources.length,currentSourceId:source.id,bankId:source.bank_id,reportsFound,newReports,extracted,published,failed});
    try {
      const r = await scanConfiguredSource(env,source);
      reportsFound += r.reportsFound; newReports += r.newReports; extracted += r.extracted; published += r.published; failed += r.failed;
      if(progress) await progress({status:"source_done",checked,total:sources.length,currentSourceId:null,bankId:null,...r,reportsFound,newReports,extracted,published,failed});
    } catch(error) {
      failed++;
      await env.DB.prepare("INSERT INTO source_checks(source_id,status,checked_at,error) VALUES(?,?,?,?)").bind(source.id,"error",new Date().toISOString(),String(error)).run();
      if(progress) await progress({status:"source_error",checked,total:sources.length,currentSourceId:null,bankId:null,message:String(error),reportsFound,newReports,extracted,published,failed});
    }
  }
  const banks = countryId
    ? await env.DB.prepare("SELECT id,country_id FROM banks WHERE country_id=? AND active=1").bind(countryId).all<any>()
    : await env.DB.prepare("SELECT id,country_id FROM banks WHERE active=1").all<any>();
  for (const bank of banks.results || []) await rebuildBankAnalysis(env,Number(bank.id),Number(bank.country_id));
  await env.DB.prepare("INSERT INTO scan_runs(started_at,finished_at,checked,changed,failed,country_id) VALUES(?,?,?,?,?,?)")
    .bind(started,new Date().toISOString(),checked,newReports,failed,countryId ?? null).run();
  return {checked,failed,reportsFound,newReports,extracted,published,total:sources.length};
}

export async function runScan(env: Env) { return runConfiguredScan(env); }
export async function runScanForCountry(env: Env,countryId:number,progress?: (info:any)=>Promise<void>|void) { return runConfiguredScan(env,countryId,progress); }
