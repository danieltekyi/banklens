type Source = { id: number; bank_id: number; url: string; source_type: string };
type ReportLink = { url: string; title: string; reportType: string };
type ExtractedMetric = {
  key: string; label: string; value: number; unit: string; currency: string | null; rawValue: string;
};
type Period = { label: string; start: string; end: string };

const REPORT_TERMS = /\b(annual|financial|statement|results|report|accounts|audited|unaudited|q1|q2|q3|q4|quarter|half[-\s]?year|h1|h2|year[-\s]?end|interim|prudential)\b/i;
const EXCLUDED_TERMS = /\b(privacy|cookie|career|job|vacancy|contact|news|press|sustainability|governance|tariff|fee|loan|saving|product|social|facebook|linkedin|youtube)\b/i;

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

function htmlTextForScan(input: string) {
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

function absoluteUrl(raw: string, base: string) {
  try { return new URL(raw, base).href; } catch { return null; }
}

function sameOrigin(a: string, b: string) {
  try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
}

function likelyReportUrl(url: string, title = "") {
  const text = `${title} ${url}`.toLowerCase();
  return /\.pdf(?:$|[?#])/i.test(url) || (REPORT_TERMS.test(text) && !EXCLUDED_TERMS.test(text));
}

function reportType(title: string, url: string) {
  const text = `${title} ${url}`;
  if (/\bq[1-4]\b|quarter/i.test(text)) return "quarterly";
  if (/annual|year\s+end|full\s+year/i.test(text)) return "annual";
  if (/half|h1|h2|interim/i.test(text)) return "interim";
  return "financial";
}

/**
 * Many bank portals do not put the PDF URL in a normal <a href>.
 * Some use data-download attributes, onclick handlers, iframe/object/embed
 * elements or JavaScript strings. Collect all of those without executing JS.
 */
function extractCandidateUrls(html: string, baseUrl: string) {
  const candidates = new Map<string, string>();

  const add = (raw: string | undefined, title = "") => {
    if (!raw) return;
    const decoded = raw
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/\\\//g, "/")
      .trim();
    if (!decoded || decoded.startsWith("#") || /^(mailto|tel|javascript):/i.test(decoded)) return;
    const url = absoluteUrl(decoded, baseUrl);
    if (!url || !/^https?:$/i.test(new URL(url).protocol)) return;
    // Financial portals frequently host the actual PDF on a CDN or document
    // service with a different origin. Allow those links when the URL/title
    // itself is clearly a financial report; keep ordinary navigation same-origin.
    if (!sameOrigin(url, baseUrl) && !likelyReportUrl(url, title)) return;
    const key = url.split("#")[0];
    candidates.set(key, title || key);
  };

  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    add(m[1], cleanText(m[2]).slice(0, 300));
  }
  for (const m of html.matchAll(/\b(?:data-href|data-url|data-download-url|data-file|data-pdf|data-document)=["']([^"']+)["']/gi)) {
    add(m[1]);
  }
  for (const m of html.matchAll(/\b(?:src|href)=["']([^"']+)["']/gi)) {
    if (/\.pdf(?:$|[?#])|download|report|financial|statement|annual|results/i.test(m[1])) add(m[1]);
  }
  for (const m of html.matchAll(/(?:window\.open|location(?:\.href)?|downloadUrl|fileUrl|pdfUrl|documentUrl)\s*(?:=|\()\s*["']([^"']+)["']/gi)) {
    add(m[1]);
  }
  for (const m of html.matchAll(/["']([^"']+(?:\.pdf(?:\?[^"']*)?|\/download\/[^"']+|\/documents?\/[^"']+|\/uploads?\/[^"']+))["']/gi)) {
    add(m[1]);
  }

  return [...candidates.entries()].map(([url, title]) => ({
    url,
    title,
    reportType: reportType(title, url),
  }));
}

function extractReportLinks(html: string, baseUrl: string): ReportLink[] {
  const links = extractCandidateUrls(html, baseUrl)
    .filter(x => likelyReportUrl(x.url, x.title));

  const unique = new Map<string, ReportLink>();
  for (const link of links) unique.set(link.url, link);
  return [...unique.values()];
}

function looksLikeChallenge(text: string, responseUrl: string) {
  const sample = text.slice(0, 10000).toLowerCase();
  return /just a moment|checking your browser|verify you are human|enable javascript and cookies|attention required|cloudflare ray id|cf-chl-|captcha/i.test(sample)
    || /\/cdn-cgi\/|challenge-platform/i.test(responseUrl);
}

function decodePdfLiteral(value: string) {
  return value
    .replace(/\\([nrtbf()\\])/g, (_m, c) => ({n:"\n",r:"\r",t:"\t",b:"\b",f:"\f","(":"(",")":")","\\":"\\"} as Record<string,string>)[c] || c)
    .replace(/\\(\d{1,3})/g, (_m, oct) => String.fromCharCode(parseInt(oct, 8)))
    .replace(/\\\r?\n/g, "");
}

async function inflate(bytes: Uint8Array, timeoutMs = 8_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const formats = ["deflate-raw", "deflate"];
    for (const format of formats) {
      if (controller.signal.aborted) throw new Error(`PDF stream decompression timed out after ${Math.round(timeoutMs / 1000)}s`);
      try {
        const ds = new DecompressionStream(format as CompressionFormat);
        const stream = new Blob([bytes]).stream().pipeThrough(ds, { signal: controller.signal } as any);
        return new Uint8Array(await new Response(stream).arrayBuffer());
      } catch (error) {
        if (controller.signal.aborted) {
          throw new Error(`PDF stream decompression timed out after ${Math.round(timeoutMs / 1000)}s`);
        }
      }
    }
    return bytes;
  } finally {
    clearTimeout(timer);
  }
}

function decodePdfHex(hex: string) {
  let out = "";
  const clean = hex.length % 4 === 0 ? hex : hex.padEnd(hex.length + (4 - hex.length % 4), "0");
  for (let i = 0; i + 3 < clean.length; i += 4) {
    const code = parseInt(clean.slice(i, i + 4), 16);
    if (Number.isFinite(code)) out += String.fromCharCode(code);
  }
  return out;
}

async function pdfToText(bytes: ArrayBuffer, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  if (bytes.byteLength > MAX_PDF_BYTES) {
    throw new Error(`PDF is too large to process safely (${Math.round(bytes.byteLength / 1024 / 1024)}MB > ${Math.round(MAX_PDF_BYTES / 1024 / 1024)}MB)`);
  }

  const raw = new Uint8Array(bytes);
  const latin = new TextDecoder("latin1").decode(raw);
  const chunks: string[] = [];
  let extractedLength = 0;
  let cursor = 0;
  let streamCount = 0;

  const checkDeadline = () => {
    if (Date.now() > deadline) throw new Error(`PDF text extraction timed out after ${Math.round(timeoutMs / 1000)}s`);
  };

  const pushChunk = (value: string) => {
    if (!value || extractedLength >= MAX_EXTRACTED_TEXT) return;
    const remaining = MAX_EXTRACTED_TEXT - extractedLength;
    const piece = value.slice(0, remaining);
    chunks.push(piece);
    extractedLength += piece.length;
  };

  // Keep individual PDF text-operator scans bounded. A malformed stream can
  // otherwise make a single regex scan monopolise the Worker event loop.
  const extractTextOperators = (text: string) => {
    const MAX_BLOCK = 512 * 1024;
    let pos = 0;
    while (pos < text.length) {
      checkDeadline();
      const btAt = text.indexOf("BT", pos);
      if (btAt < 0) break;
      const etAt = text.indexOf("ET", btAt + 2);
      const blockEnd = etAt >= 0 ? Math.min(etAt, btAt + MAX_BLOCK) : Math.min(text.length, btAt + MAX_BLOCK);
      const block = text.slice(btAt + 2, blockEnd);

      for (const m of block.matchAll(/\((?:\\.|[^\\)])*\)\s*Tj/g)) {
        checkDeadline();
        pushChunk(decodePdfLiteral(m[0].replace(/\)\s*Tj$/, "").replace(/^\(/, "")));
      }
      for (const m of block.matchAll(/\[(.*?)\]\s*TJ/g)) {
        checkDeadline();
        for (const part of m[1].matchAll(/\((?:\\.|[^\\)])*\)/g)) {
          checkDeadline();
          pushChunk(decodePdfLiteral(part[0].slice(1, -1)));
        }
      }
      for (const m of block.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) {
        checkDeadline();
        pushChunk(decodePdfHex(m[1]));
      }
      pos = etAt >= 0 ? etAt + 2 : blockEnd;
    }
  };

  while (cursor < latin.length) {
    checkDeadline();
    if (++streamCount > MAX_PDF_STREAMS) break;

    const streamAt = latin.indexOf("stream", cursor);
    if (streamAt < 0) break;
    const dictStart = Math.max(0, latin.lastIndexOf("obj", streamAt - 1) - 1500);
    const dict = latin.slice(dictStart, streamAt);
    let dataStart = streamAt + 6;
    if (latin[dataStart] === "\r") dataStart++;
    if (latin[dataStart] === "\n") dataStart++;

    const endAt = latin.indexOf("endstream", dataStart);
    if (endAt < 0) break;

    const rawStreamLength = endAt - dataStart;
    const rawLength = Math.min(rawStreamLength, MAX_PDF_STREAM_BYTES);
    const data = raw.slice(dataStart, dataStart + rawLength);

    let decoded: Uint8Array;
    if (/\/FlateDecode/i.test(dict)) {
      decoded = await inflate(data, 8_000);
    } else {
      decoded = data;
    }

    checkDeadline();
    // Avoid allocating/scanning enormous decoded streams. Financial text
    // streams normally contain useful text near their beginning; the global
    // extracted-text limit provides another safety bound.
    const boundedDecoded = decoded.length > 4 * 1024 * 1024 ? decoded.slice(0, 4 * 1024 * 1024) : decoded;
    const streamText = new TextDecoder("latin1").decode(boundedDecoded);
    extractTextOperators(streamText);

    cursor = endAt + 9;
  }

  checkDeadline();
  return cleanText(chunks.join(" "));
}

async function responseToText(body: ArrayBuffer, contentType: string) {
  const bytes = new Uint8Array(body);
  if (/pdf/i.test(contentType) || new TextDecoder("latin1").decode(bytes.slice(0, 5)) === "%PDF-") {
    return await pdfToText(body, 45_000);
  }
  // Bound HTML processing too; a portal page should never need tens of MB of
  // HTML to identify its report links.
  const bounded = bytes.length > 8 * 1024 * 1024 ? bytes.slice(0, 8 * 1024 * 1024) : bytes;
  return htmlTextForScan(new TextDecoder("utf-8", { fatal:false }).decode(bounded));
}

function parseNumber(raw: string) {
  let s = raw.trim().replace(/\s/g, "");
  const negative = /^\(.*\)$/.test(s) || /^-/.test(s);
  s = s.replace(/[(),]/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? (negative ? -Math.abs(n) : n) : null;
}

function findUnit(text: string, position: number) {
  const nearby = text.slice(Math.max(0, position - 1200), Math.min(text.length, position + 1200)).toLowerCase();
  const global = text.slice(0, 12000).toLowerCase();
  const combined = `${nearby} ${global}`;

  if (/(?:gh[¢₵]|ghs)\s*['’]?\s*000\s*,?\s*000|in\s+billions|\bghs\s+billion\b|\(bn\)/i.test(combined)) return "billion";
  if (/(?:gh[¢₵]|ghs)\s*['’]?\s*000|in\s+thousands|\(000s?\)/i.test(combined)) return "thousand";
  if (/(?:gh[¢₵]|ghs)\s*(?:million|m)\b|in\s+millions|\(m\)/i.test(combined)) return "million";
  return null;
}

function normalizeAmount(value: number, unit: string | null) {
  if (unit === "thousand") return {value:value/1_000_000,unit:"GHS_bn"};
  if (unit === "million") return {value:value/1_000,unit:"GHS_bn"};
  if (unit === "billion") return {value,unit:"GHS_bn"};
  // If the statement explicitly uses GHS and gives a plain number, retain it
  // as GHS_bn only when the report title/text clearly says billions.
  return null;
}

function firstMatch(text: string, patterns: RegExp[]) {
  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (!m) continue;
    const value = parseNumber(m[1]);
    if (value == null) continue;
    return {raw:m[1],value,position:m.index||0};
  }
  return null;
}

function amountPatterns(labels: string[]) {
  const label = labels.join("|");
  return [
    new RegExp(`(?:${label})[^\\d()\\-]{0,160}(?:ghs|gh[¢₵])?\\s*([\\(\\-]?\\s*[\\d]+(?:[,.]\\d+)*\\s*\\)?)`, "i"),
    new RegExp(`(?:${label})\\s+([\\(\\-]?\\s*[\\d]+(?:[,.]\\d+)*\\s*\\)?)`, "i"),
  ];
}

function percentPatterns(labels: string[]) {
  const label = labels.join("|");
  return [
    new RegExp(`(?:${label})[^\\d()\\-]{0,80}([\\(\\-]?\\s*[\\d]+(?:[,.]\\d+)*\\s*\\)?)\\s*%`, "i"),
    new RegExp(`(?:${label})[^\\d()\\-]{0,80}([\\d]+(?:[,.]\\d+)?)`, "i"),
  ];
}

function extractFinancialMetrics(text: string): ExtractedMetric[] {
  const metrics: ExtractedMetric[] = [];
  const amount = (key:string,label:string,labels:string[]) => {
    const m=firstMatch(text,amountPatterns(labels)); if(!m)return;
    const normalized=normalizeAmount(m.value,findUnit(text,m.position)); if(!normalized)return;
    metrics.push({key,label,value:normalized.value,unit:normalized.unit,currency:"GHS",rawValue:m.raw});
  };
  const percent=(key:string,label:string,labels:string[])=>{
    const m=firstMatch(text,percentPatterns(labels)); if(!m)return;
    metrics.push({key,label,value:m.value,unit:"percent",currency:null,rawValue:m.raw});
  };

  amount("assets","Total assets",["total assets","total asset"]);
  amount("deposits","Customer deposits",["customer deposits","deposits"]);
  amount("profit","Profit after tax",["profit after tax","profit for the year","profit for the period","profit attributable"]);
  amount("loans","Loans and advances",["loans and advances","gross loans","net loans","loans"]);
  amount("equity","Total equity",["total equity","shareholders' funds","total shareholders' equity"]);
  amount("liabilities","Total liabilities",["total liabilities"]);
  amount("net_interest_income","Net interest income",["net interest income"]);
  amount("impairment","Credit impairment charge",["credit impairment charge","credit impairment","impairment charge","impairment loss"]);
  amount("revenue","Total income / revenue",["total income","total revenue","total operating income"]);
  amount("operating_expenses","Operating expenses",["operating expenses","total operating expenses"]);

  percent("capital_adequacy","Capital adequacy ratio",["capital adequacy ratio","capital adequacy","CAR"]);
  percent("liquidity","Liquidity ratio",["liquidity ratio","liquid assets ratio","LCR"]);
  percent("npl","NPL ratio",["non-performing loans ratio","non-performing loans","NPL ratio","NPL"]);
  percent("roe","Return on equity",["return on equity","ROE"]);
  percent("roa","Return on assets",["return on assets","ROA"]);
  percent("cost_to_income","Cost-to-income ratio",["cost-to-income","cost income","cost/income"]);
  percent("net_interest_margin","Net interest margin",["net interest margin","NIM"]);
  percent("credit_loss_ratio","Credit loss ratio",["credit loss ratio"]);

  const seen=new Set<string>();
  return metrics.filter(m=>{if(seen.has(m.key))return false;seen.add(m.key);return true;});
}

function inferPeriod(text: string,title: string,url: string): Period {
  const combined=`${title} ${text} ${url}`;
  const lower=combined.toLowerCase();
  const yearMatch=combined.match(/\b(20\d{2})\b/);
  const year=yearMatch?.[1]||String(new Date().getUTCFullYear());
  const q=lower.match(/\bq([1-4])\b|\b([1-4])(?:st|nd|rd|th)\s+quarter\b/);
  if(q){const quarter=Number(q[1]||q[2]);const month=quarter*3;const end=new Date(Date.UTC(Number(year),month,0));return{label:`Q${quarter} ${year}`,start:`${year}-${String(month-2).padStart(2,"0")}-01`,end:`${year}-${String(month).padStart(2,"0")}-${String(end.getUTCDate()).padStart(2,"0")}`};}
  if(/\b(?:h1|half\s+year|six\s+months?)\b/i.test(combined))return{label:`H1 ${year}`,start:`${year}-01-01`,end:`${year}-06-30`};
  if(/\b(?:h2|second\s+half)\b/i.test(combined))return{label:`H2 ${year}`,start:`${year}-07-01`,end:`${year}-12-31`};
  const exact=combined.match(/(?:ended|ending|as at|as of)\s+(\d{1,2})[\s/-]+(January|February|March|April|May|June|July|August|September|October|November|December)[\s,/-]+(20\d{2})/i);
  if(exact){const months:Record<string,string>={january:"01",february:"02",march:"03",april:"04",may:"05",june:"06",july:"07",august:"08",september:"09",october:"10",november:"11",december:"12"};const month=months[exact[2].toLowerCase()];return{label:`${exact[1]} ${exact[2]} ${exact[3]}`,start:`${exact[3]}-${month}-01`,end:`${exact[3]}-${month}-${exact[1].padStart(2,"0")}`};}
  return{label:`FY ${year}`,start:`${year}-01-01`,end:`${year}-12-31`};
}

async function hashBytes(body:ArrayBuffer){const digest=await crypto.subtle.digest("SHA-256",body);return[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,"0")).join("");}

const PORTAL_FETCH_TIMEOUT_MS = 30_000;
const REPORT_FETCH_TIMEOUT_MS = 60_000;
const REPORT_PROCESS_TIMEOUT_MS = 90_000;
const MAX_PDF_BYTES = 40 * 1024 * 1024;
const MAX_PDF_STREAMS = 350;
const MAX_PDF_STREAM_BYTES = 12 * 1024 * 1024;
const MAX_EXTRACTED_TEXT = 6 * 1024 * 1024;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

async function fetchPortal(url:string, timeoutMs = PORTAL_FETCH_TIMEOUT_MS){
  const headers={
    "User-Agent":"Mozilla/5.0 (compatible; BankLensBot/0.6; +https://banklens.odefokitchen.com/methodology)",
    "Accept":"text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8",
    "Accept-Language":"en-US,en;q=0.8",
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response=await fetch(url,{headers,redirect:"follow",signal:controller.signal});
    const body=await response.arrayBuffer();
    const contentType=response.headers.get("content-type")||"";
    const text=await withTimeout(responseToText(body,contentType), 45_000, "Document text extraction timed out after 45s");
    return {response,body,contentType,text,finalUrl:response.url||url};
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Request timed out after ${Math.round(timeoutMs/1000)}s: ${url}`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function discoverReportsFromPortal(source:Source, firstBody:ArrayBuffer, firstContentType:string, firstFinalUrl:string) {
  const queue:Array<{url:string,title:string,depth:number}>= [];
  const seen=new Set<string>();
  const addQueue=(link:ReportLink,depth:number)=>{
    const key=link.url.split("#")[0];
    if(seen.has(key))return;
    seen.add(key);
    queue.push({url:key,title:link.title,depth});
  };

  const firstIsPdf=/pdf/i.test(firstContentType)||new TextDecoder("latin1").decode(new Uint8Array(firstBody).slice(0,5))==="%PDF-";
  if(firstIsPdf)return[{url:firstFinalUrl,title:"Financial report",reportType:"financial"}];

  const firstHtml=new TextDecoder("utf-8",{fatal:false}).decode(new Uint8Array(firstBody));
  for(const link of extractReportLinks(firstHtml,firstFinalUrl))addQueue(link,0);

  const reports:ReportLink[]=[];
  let processedPages=0;
  while(queue.length && reports.length<80 && processedPages<25){
    const current=queue.shift()!;
    processedPages++;
    if(/\.pdf(?:$|[?#])/i.test(current.url)){reports.push({url:current.url,title:current.title,reportType:reportType(current.title,current.url)});continue;}
    if(current.depth>=2)continue;

    try{
      const fetched=await fetchPortal(current.url);
      const isPdf=/pdf/i.test(fetched.contentType)||new TextDecoder("latin1").decode(new Uint8Array(fetched.body).slice(0,5))==="%PDF-";
      if(isPdf){reports.push({url:fetched.finalUrl,title:current.title,reportType:reportType(current.title,fetched.finalUrl)});continue;}
      if(looksLikeChallenge(fetched.text,fetched.finalUrl))continue;

      for(const link of extractReportLinks(new TextDecoder("utf-8",{fatal:false}).decode(new Uint8Array(fetched.body)),fetched.finalUrl)){
        if(/\.pdf(?:$|[?#])/i.test(link.url)) reports.push(link);
        else if(sameOrigin(link.url,source.url)) addQueue(link,current.depth+1);
      }
    }catch{}
  }

  const unique=new Map<string,ReportLink>();
  for(const r of reports)unique.set(r.url,r);
  return [...unique.values()].slice(0,80);
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
  await env.DB.prepare("DELETE FROM banklens_latest_metrics WHERE bank_id=?").bind(bankId).run();
  const names = ["bank_id","assets","deposits","profit","capital_adequacy","liquidity","npl","reporting_period","reporting_period_end","updated_at",
    "assets_source_url","assets_source_title","deposits_source_url","deposits_source_title","profit_source_url","profit_source_title",
    "capital_adequacy_source_url","capital_adequacy_source_title","liquidity_source_url","liquidity_source_title","npl_source_url","npl_source_title"];
  const marks = names.map(() => "?").join(",");
  await env.DB.prepare(`INSERT INTO banklens_latest_metrics(${names.join(",")}) VALUES(${marks})`).bind(...names.map(n => snapshot[n] ?? null)).run();
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
    `SELECT lm.capital_adequacy,lm.liquidity,lm.npl FROM banklens_latest_metrics lm JOIN banks b ON b.id=lm.bank_id WHERE b.country_id=? AND b.active=1`,
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

export async function processReport(
  env: Env,
  source: Source,
  report: ReportLink,
  options: { rebuild?: boolean } = {},
) {
  // A report may already exist from an earlier crawler version. Re-use it only
  // when the same hash has already produced published metrics. If the document
  // exists but extraction produced zero values, re-process it automatically.
  const existing = await env.DB.prepare(
    `SELECT id,bank_id,content_hash,status,reporting_period_start,reporting_period_end,period_label
     FROM financial_documents
     WHERE source_id=? AND report_url=?
     ORDER BY id DESC LIMIT 1`,
  ).bind(source.id, report.url).first<any>();

  const fetched = await fetchPortal(report.url, REPORT_FETCH_TIMEOUT_MS);
  if (!fetched.response.ok) throw new Error(`Report HTTP ${fetched.response.status}`);

  const body = fetched.body;
  const contentType = fetched.contentType || "application/octet-stream";
  const hash = await hashBytes(body);
  const text = fetched.text;

  const existingMetrics = existing?.content_hash === hash
    ? await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM financial_records
         WHERE source_id=? AND source_url=? AND content_hash=? AND status='published'`,
      ).bind(source.id, report.url, hash).first<any>()
    : null;

  // Repair ownership whenever a source was previously attached to the wrong bank.
  // The configured source is authoritative.
  if (existing?.id && Number(existing.bank_id) !== Number(source.bank_id)) {
    await env.DB.batch([
      env.DB.prepare("UPDATE financial_documents SET bank_id=?,updated_at=? WHERE id=?")
        .bind(source.bank_id,new Date().toISOString(),existing.id),
      env.DB.prepare("UPDATE financial_records SET bank_id=?,updated_at=? WHERE source_id=? AND source_url=? AND content_hash=?")
        .bind(source.bank_id,new Date().toISOString(),source.id,report.url,hash),
      env.DB.prepare("UPDATE financial_extractions SET bank_id=? WHERE source_id=? AND source_url=? AND content_hash=?")
        .bind(source.bank_id,source.id,report.url,hash),
    ]);
  }

  if (existing?.content_hash === hash && Number(existingMetrics?.n || 0) > 0) {
    return { newReport:false, extracted:0, published:0, skipped:true, reason:"already_processed" };
  }

  if (!text.trim()) throw new Error("Report downloaded but no machine-readable text could be extracted");

  const period = inferPeriod(text, report.title, report.url);
  const r2Key = `reports/${source.bank_id}/${period.end}-${hash.slice(0,16)}.${(/pdf/i.test(contentType)||/\.pdf/i.test(report.url))?"pdf":"html"}`;
  await env.REPORTS.put(r2Key,body,{
    httpMetadata:{contentType},
    customMetadata:{sourceUrl:report.url,hash,bankId:String(source.bank_id)}
  });

  const now = new Date().toISOString();

  // Remove an earlier zero/incorrect extraction for the same source+document so
  // the retry is idempotent and does not create duplicate public metrics.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM financial_records WHERE source_id=? AND source_url=? AND content_hash=?")
      .bind(source.id,report.url,hash),
    env.DB.prepare("DELETE FROM financial_extractions WHERE source_id=? AND source_url=? AND content_hash=?")
      .bind(source.id,report.url,hash),
  ]);

  let documentId = existing?.id;
  if (documentId && existing.content_hash === hash) {
    await env.DB.prepare(
      `UPDATE financial_documents
       SET bank_id=?,report_title=?,report_type=?,content_type=?,r2_key=?,
           reporting_period_start=?,reporting_period_end=?,period_label=?,
           status='published',error=NULL,downloaded_at=?,processed_at=?,updated_at=?
       WHERE id=?`
    ).bind(
      source.bank_id,report.title,report.reportType,contentType,r2Key,
      period.start,period.end,period.label,now,now,now,documentId
    ).run();
  } else {
    const inserted = await env.DB.prepare(
      `INSERT INTO financial_documents
       (bank_id,source_id,report_url,report_title,report_type,content_hash,content_type,r2_key,
        reporting_period_start,reporting_period_end,period_label,status,discovered_at,downloaded_at,processed_at,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      source.bank_id,source.id,report.url,report.title,report.reportType,hash,contentType,r2Key,
      period.start,period.end,period.label,"published",now,now,now,now,now
    ).run();
    documentId = Number(inserted.meta?.last_row_id || 0);
  }

  // Keep metric regex scans bounded. Running every metric regex across several
  // megabytes of PDF text can monopolise a Worker even after PDF extraction
  // itself has completed.
  const metricText = text.length > 2 * 1024 * 1024 ? text.slice(0, 2 * 1024 * 1024) : text;
  const metrics = extractFinancialMetrics(metricText);
  await env.DB.prepare(
    `INSERT INTO financial_extractions
     (bank_id,source_id,source_url,content_hash,period_label,status,records_found,created_at)
     VALUES(?,?,?,?,?,?,?,?)`
  ).bind(
    source.bank_id,source.id,report.url,hash,period.label,
    metrics.length ? "published" : "no_metrics",metrics.length,now
  ).run();

  for (const metric of metrics) {
    await env.DB.prepare(
      `INSERT INTO financial_records
       (bank_id,source_id,source_url,source_title,metric_key,metric_label,raw_value,value,unit,currency,
        reporting_period_start,reporting_period_end,period_label,statement_date,content_hash,status,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      source.bank_id,source.id,report.url,report.title,metric.key,metric.label,metric.rawValue,
      metric.value,metric.unit,metric.currency,period.start,period.end,period.label,period.end,
      hash,"published",now,now
    ).run();
  }

  if (metrics.length && options.rebuild !== false) {
    await rebuildLatestMetrics(env,source.bank_id);
    const bank=await env.DB.prepare("SELECT country_id FROM banks WHERE id=?").bind(source.bank_id).first<any>();
    if(bank) await rebuildBankAnalysis(env,source.bank_id,Number(bank.country_id));
  }

  return {
    newReport: existing?.content_hash === hash ? false : true,
    reprocessed: existing?.content_hash === hash,
    extracted:metrics.length,
    published:metrics.length,
    skipped:false,
    period:period.label,
    url:report.url,
    documentId
  };
}

type ScanProgress = (info:any) => Promise<void> | void;

async function scanConfiguredSource(env:Env,source:Source){
  const fetched=await fetchPortal(source.url);
  if(!fetched.response.ok) throw new Error(`Portal HTTP ${fetched.response.status}`);
  if(looksLikeChallenge(fetched.text,fetched.finalUrl)) throw new Error(`Portal blocked automated access (${fetched.response.status}); final URL ${fetched.finalUrl}`);
  const hash=await hashBytes(fetched.body);
  await env.DB.prepare("INSERT INTO source_checks(source_id,status,content_hash,checked_at,error) VALUES(?,?,?,?,NULL)")
    .bind(source.id,"ok",hash,new Date().toISOString()).run();

  const reports=await discoverReportsFromPortal(source,fetched.body,fetched.contentType,fetched.finalUrl);
  if(!reports.length) throw new Error("Portal fetched successfully but no financial-report links were discovered. The page may require JavaScript or expose downloads through an unsupported API.");

  let newReports=0,reprocessed=0,extracted=0,published=0,failed=0;
  const reportFailures:any[]=[];
  for(const report of reports){
    try{
      const r=await withTimeout(processReport(env,source,report), REPORT_PROCESS_TIMEOUT_MS, `Report processing timed out after ${Math.round(REPORT_PROCESS_TIMEOUT_MS/1000)}s`);
      if(r.newReport)newReports++;
      if(r.reprocessed)reprocessed++;
      extracted+=Number(r.extracted||0);
      published+=Number(r.published||0);
    }catch(error){
      failed++;
      const failure={bankId:source.bank_id,sourceId:source.id,portalUrl:source.url,reportUrl:report.url,title:report.title,error:String(error)};
      reportFailures.push(failure);
      console.error("REPORT_PROCESS_ERROR",JSON.stringify(failure));
      await env.DB.prepare(`UPDATE financial_documents SET error=?,updated_at=? WHERE source_id=? AND report_url=?`)
        .bind(String(error),new Date().toISOString(),source.id,report.url).run().catch(()=>{});
    }
  }
  return {changed:true,reportsFound:reports.length,newReports,reprocessed,extracted,published,failed,reportFailures,portalUrl:fetched.finalUrl};
}

export async function reprocessStoredReports(env:Env,countryId:number,progress?:ScanProgress){
  const {results:docs}=await env.DB.prepare(`
    SELECT d.id,d.bank_id,d.source_id,d.report_url,d.report_title,d.report_type,d.content_hash,
           b.name bank_name,s.url source_url,s.source_type,s.active
    FROM financial_documents d
    JOIN banks b ON b.id=d.bank_id
    LEFT JOIN sources s ON s.id=d.source_id
    WHERE b.country_id=? AND b.active=1 AND d.status='published'
      AND NOT EXISTS (SELECT 1 FROM financial_records fr WHERE fr.source_id=d.source_id AND fr.source_url=d.report_url AND fr.content_hash=d.content_hash AND fr.status='published')
    ORDER BY d.created_at ASC LIMIT 500
  `).bind(countryId).all<any>();
  let attempted=0,reprocessed=0,extracted=0,published=0,failed=0; const failures:any[]=[]; const total=(docs||[]).length;
  for(const doc of docs||[]){
    attempted++;
    if(progress) await progress({status:"reprocessing_start",checked:attempted,total,bankId:doc.bank_id,reportId:doc.id,reportTitle:doc.report_title,extracted,published,failed});
    try{
      let source:any=doc.source_id?await env.DB.prepare(`SELECT id,bank_id,url,source_type,active FROM sources WHERE id=?`).bind(doc.source_id).first<any>():null;
      if(!source){
        const host=(()=>{try{return new URL(doc.report_url).hostname.replace(/^www\\./,"")}catch{return ""}})();
        const candidates=await env.DB.prepare(`SELECT s.id,s.bank_id,s.url,s.source_type,s.active FROM sources s JOIN banks b ON b.id=s.bank_id WHERE b.id=? AND s.active=1 AND s.source_type='financial_portal'`).bind(doc.bank_id).all<any>();
        source=(candidates.results||[]).find((x:any)=>{try{return new URL(x.url).hostname.replace(/^www\\./,"")===host}catch{return false}})||(candidates.results||[])[0]||null;
      }
      if(!source) throw new Error(`No active configured financial portal is available for bank ${doc.bank_name}.`);
      if(Number(source.bank_id)!==Number(doc.bank_id)||Number(source.id)!==Number(doc.source_id)) await env.DB.prepare(`UPDATE financial_documents SET bank_id=?,source_id=?,updated_at=? WHERE id=?`).bind(source.bank_id,source.id,new Date().toISOString(),doc.id).run();
      const result=await withTimeout(
        processReport(
          env,
          {id:Number(source.id),bank_id:Number(source.bank_id),url:source.url,source_type:source.source_type},
          {url:doc.report_url,title:doc.report_title||doc.report_url,reportType:doc.report_type||"financial"},
          {rebuild:false},
        ),
        REPORT_PROCESS_TIMEOUT_MS,
        `Report processing timed out after ${Math.round(REPORT_PROCESS_TIMEOUT_MS/1000)}s`,
      );
      reprocessed++; extracted+=Number(result.extracted||0); published+=Number(result.published||0);
      if(progress)await progress({status:"reprocessing",checked:attempted,total,bankId:source.bank_id,reportId:doc.id,reportTitle:doc.report_title,extracted,published,failed});
    }catch(error){
      failed++; const failure={id:doc.id,bankId:doc.bank_id,bankName:doc.bank_name,reportUrl:doc.report_url,error:String(error)}; failures.push(failure);
      await env.DB.prepare(`UPDATE financial_documents SET error=?,updated_at=? WHERE id=?`).bind(String(error),new Date().toISOString(),doc.id).run().catch(()=>{});
      if(progress)await progress({status:"reprocess_error",checked:attempted,total,bankId:doc.bank_id,reportId:doc.id,reportTitle:doc.report_title,error:String(error),extracted,published,failed});
    }
  }
  return {attempted,reprocessed,extracted,published,failed,failures};
}

export async function runConfiguredScan(env:Env,countryId?:number,progress?:ScanProgress){
  const started=new Date().toISOString();
  const query=countryId?"SELECT s.id,s.bank_id,s.url,s.source_type FROM sources s JOIN banks b ON b.id=s.bank_id WHERE b.country_id=? AND b.active=1 AND s.active=1 AND s.source_type='financial_portal'":"SELECT id,bank_id,url,source_type FROM sources WHERE active=1 AND source_type='financial_portal'";
  const q=countryId?env.DB.prepare(query).bind(countryId):env.DB.prepare(query); const {results:sources}=await q.all<Source>();
  let checked=0,sourceFailed=0,reportFailed=0,reportsFound=0,newReports=0,reprocessed=0,extracted=0,published=0; const sourceFailures:any[]=[]; const reportFailures:any[]=[];
  for(const source of sources){
    checked++; if(progress)await progress({status:"checking",checked,total:sources.length,currentSourceId:source.id,bankId:source.bank_id,reportsFound,newReports,reprocessed,extracted,published,sourceFailed,reportFailed});
    try{
      const r=await scanConfiguredSource(env,source); reportsFound+=r.reportsFound; newReports+=r.newReports; reprocessed+=r.reprocessed; extracted+=r.extracted; published+=r.published; reportFailed+=r.failed; if(r.reportFailures?.length)reportFailures.push(...r.reportFailures);
      if(progress)await progress({status:"source_done",checked,total:sources.length,currentSourceId:null,bankId:null,...r,reportsFound,newReports,reprocessed,extracted,published,sourceFailed,reportFailed,lastError:r.reportFailures?.[0]?.error||null});
    }catch(error){
      sourceFailed++; const failure={sourceId:source.id,bankId:source.bank_id,portalUrl:source.url,error:String(error)}; sourceFailures.push(failure);
      await env.DB.prepare("INSERT INTO source_checks(source_id,status,checked_at,error) VALUES(?,?,?,?)").bind(source.id,"error",new Date().toISOString(),String(error)).run();
      if(progress)await progress({status:"source_error",checked,total:sources.length,currentSourceId:null,bankId:null,message:String(error),reportsFound,newReports,reprocessed,extracted,published,sourceFailed,reportFailed});
    }
  }
  let stored={attempted:0,reprocessed:0,extracted:0,published:0,failed:0,failures:[] as any[]};
  if(countryId){
    if(progress)await progress({status:"stored_reprocess_start",attempted:0,reprocessed:0,extracted:0,published:0,failed:0});
    stored=await reprocessStoredReports(env,countryId,progress); reprocessed+=stored.reprocessed; extracted+=stored.extracted; published+=stored.published; reportFailed+=stored.failed;
  }
  const banks=countryId?await env.DB.prepare("SELECT id,country_id FROM banks WHERE country_id=? AND active=1").bind(countryId).all<any>():await env.DB.prepare("SELECT id,country_id FROM banks WHERE active=1").all<any>();
  for(const bank of banks.results||[])await rebuildBankAnalysis(env,Number(bank.id),Number(bank.country_id));
  await env.DB.prepare("INSERT INTO scan_runs(started_at,finished_at,checked,changed,failed,country_id) VALUES(?,?,?,?,?,?)").bind(started,new Date().toISOString(),checked,newReports,sourceFailed+reportFailed,countryId??null).run();
  return {checked,failed:sourceFailed+reportFailed,sourceFailed,reportFailed,reportsFound,newReports,reprocessed,extracted,published,total:sources.length,sourceFailures,reportFailures:[...reportFailures,...stored.failures].slice(0,50)};
}

export async function runScan(env:Env){
  const {results}=await env.DB.prepare("SELECT id FROM countries WHERE enabled=1").all<{id:number}>();
  const outputs=[];
  for(const country of results||[]){
    try{ outputs.push({countryId:country.id,result:await runConfiguredScan(env,Number(country.id))}); }
    catch(error){ outputs.push({countryId:country.id,error:String(error)}); }
  }
  return outputs;
}
export async function runScanForCountry(env:Env,countryId:number,progress?:(info:any)=>Promise<void>|void){return runConfiguredScan(env,countryId,progress);}
