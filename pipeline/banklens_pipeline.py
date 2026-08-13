#!/usr/bin/env python3
"""
BankLens local collection + extraction + Cloudflare D1 sync.

Usage:
  python banklens_pipeline.py --config config.ghana.json
  python banklens_pipeline.py --config config.ghana.json --dry-run
  python banklens_pipeline.py --config config.ghana.json --no-sync

The Worker is intentionally NOT used for crawling/downloading reports.
Only the final normalized records are sent to BankLens via the authenticated
pipeline sync endpoint.
"""
from __future__ import annotations
import argparse, hashlib, json, os, re, sys, time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse, urldefrag

import requests
from bs4 import BeautifulSoup
from pypdf import PdfReader

try:
    import pdfplumber
except Exception:
    pdfplumber = None

REPORT_TERMS = re.compile(
    r"\b(annual|financial|statement|results|report|accounts|audited|unaudited|"
    r"q[1-4]|quarter|half[-\s]?year|h1|h2|interim|year[-\s]?end|prudential)\b", re.I)
EXCLUDED_TERMS = re.compile(
    r"\b(privacy|cookie|career|job|vacancy|contact|news|press|sustainability|"
    r"governance|tariff|fee|loan|saving|product|social|facebook|linkedin|youtube)\b", re.I)
PDF_RE = re.compile(r"\.pdf(?:$|[?#])", re.I)

METRICS = [
    ("assets","Total assets",["total assets","total asset"],"amount"),
    ("deposits","Customer deposits",["customer deposits","deposits from customers","customer deposits and other accounts","deposits"],"amount"),
    ("profit","Profit after tax",["profit after tax","profit for the year","profit for the period","profit attributable"],"amount"),
    ("loans","Loans and advances",["loans and advances","gross loans","net loans","loans"],"amount"),
    ("equity","Total equity",["total equity","shareholders' funds","total shareholders' equity"],"amount"),
    ("liabilities","Total liabilities",["total liabilities"],"amount"),
    ("net_interest_income","Net interest income",["net interest income"],"amount"),
    ("impairment","Credit impairment charge",["credit impairment charge","credit impairment","impairment charge","impairment loss"],"amount"),
    ("revenue","Total income",["total income","operating income","revenue"],"amount"),
    ("capital_adequacy","Capital adequacy ratio",["capital adequacy ratio","capital adequacy"],"percent"),
    ("liquidity","Liquidity ratio",["liquidity ratio","liquidity"],"percent"),
    ("npl","NPL ratio",["npl ratio","non-performing loans ratio","non performing loans ratio"],"percent"),
    ("roe","ROE",["return on equity","roe"],"percent"),
    ("roa","ROA",["return on assets","roa"],"percent"),
    ("cost_to_income","Cost-to-income ratio",["cost to income ratio","cost-to-income ratio","cost income ratio"],"percent"),
    ("net_interest_margin","Net interest margin",["net interest margin","nim"],"percent"),
]

def now():
    return datetime.now(timezone.utc).isoformat()

def slug(s):
    return re.sub(r"[^a-z0-9]+","-",s.lower()).strip("-")

def sha256(b):
    return hashlib.sha256(b).hexdigest()

def clean_text(s):
    s = re.sub(r"<script[\s\S]*?</script>|<style[\s\S]*?</style>", " ", s, flags=re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    s = re.sub(r"&nbsp;|&#160;", " ", s, flags=re.I)
    s = re.sub(r"&amp;", "&", s, flags=re.I)
    return re.sub(r"\s+", " ", s).strip()

def parse_number(raw):
    x = raw.replace(",", "").replace(" ", "").replace("(", "-").replace(")", "")
    try: return float(x)
    except ValueError: return None

def period(text, title, url):
    s = f"{title} {url} {text[:300000]}"
    m = re.search(r"\b(20\d{2})\s*(?:annual|year[- ]end|full[- ]year)\b", s, re.I)
    if not m:
        m = re.search(r"\b(?:annual|year[- ]end|full[- ]year)\s*(?:report|results|financial statements?)?\s*(20\d{2})\b", s, re.I)
    if m:
        y = int(m.group(1)); return f"FY {y}", f"{y}-01-01", f"{y}-12-31"
    m = re.search(r"\b(?:Q([1-4])|([1-4])Q)[\s-]*(20\d{2})\b", s, re.I)
    if m:
        q = int(m.group(1) or m.group(2)); y = int(m.group(3))
        starts={1:"01-01",2:"04-01",3:"07-01",4:"10-01"}; ends={1:"03-31",2:"06-30",3:"09-30",4:"12-31"}
        return f"Q{q} {y}", f"{y}-{starts[q]}", f"{y}-{ends[q]}"
    m = re.search(r"\b(20\d{2})\b", s)
    y = int(m.group(1)) if m else datetime.now().year
    return f"FY {y}", f"{y}-01-01", f"{y}-12-31"

def unit_multiplier(text):
    t = text.lower()
    if re.search(r"\b(?:ghs|₵)\s*(?:'000|000|thousand)\b|\b(?:in|amounts in)\s+thousands\b", t):
        return 1/1_000_000, "GHS_bn"
    if re.search(r"\b(?:ghs|₵)\s*(?:million|mn|m)\b|\b(?:in|amounts in)\s+millions\b", t):
        return 1/1_000, "GHS_bn"
    if re.search(r"\b(?:ghs|₵)\s*(?:billion|bn)\b|\b(?:in|amounts in)\s+billions\b", t):
        return 1.0, "GHS_bn"
    return None, None

def extract_metrics(text):
    results=[]
    mult, unit = unit_multiplier(text)
    for key,label,labels,kind in METRICS:
        best=None
        for lab in labels:
            pat = re.compile(rf"{re.escape(lab)}[^0-9()\-%]{{0,220}}([(\-]?\s*\d[\d,]*(?:\.\d+)?\s*\)?)\s*(%)?", re.I)
            m=pat.search(text)
            if not m: continue
            val=parse_number(m.group(1))
            if val is None: continue
            if kind=="percent":
                if val > 1000: continue
                best=(val, m.group(1)); break
            if mult is None:
                # Conservative fallback: do not publish an ambiguous plain amount.
                continue
            best=(val*mult,m.group(1)); break
        if best:
            v,raw=best
            results.append({
                "metric_key":key,"metric_label":label,"raw_value":raw,
                "value":v,"unit":"percent" if kind=="percent" else unit,
                "currency":None if kind=="percent" else "GHS"
            })
    return results

def discover_reports(html, base):
    soup=BeautifulSoup(html,"html.parser")
    found={}
    def add(raw,title):
        if not raw: return
        raw=raw.strip().replace("\\/","/")
        if raw.startswith("#") or raw.lower().startswith(("javascript:","mailto:","tel:")): return
        u=urljoin(base, raw)
        u=urldefrag(u)[0]
        if urlparse(u).scheme not in ("http","https"): return
        txt=f"{title} {u}"
        if PDF_RE.search(u) or (REPORT_TERMS.search(txt) and not EXCLUDED_TERMS.search(txt)):
            found[u]=title or u
    for a in soup.find_all("a"):
        add(a.get("href"),a.get_text(" ",strip=True))
        for k in ("data-href","data-url","data-download","data-download-url","data-file","data-pdf","data-document-url"):
            add(a.get(k),a.get_text(" ",strip=True))
        oc=a.get("onclick","")
        for u in re.findall(r"""['"]([^'"]+(?:pdf|download|document)[^'"]*)['"]""",oc,re.I): add(u,a.get_text(" ",strip=True))
    for tag in soup.find_all(["iframe","object","embed"]):
        add(tag.get("src") or tag.get("data"),tag.get("title",""))
    return [{"url":u,"title":t,"report_type":"annual" if "annual" in t.lower() or "annual" in u.lower() else "quarterly" if re.search(r"\bq[1-4]\b|quarter",t+" "+u,re.I) else "financial"} for u,t in found.items()]

def fetch(session,url,timeout=45):
    r=session.get(url,timeout=timeout,allow_redirects=True)
    r.raise_for_status()
    return r

def extract_pdf(path):
    text=""
    try:
        reader=PdfReader(str(path), strict=False)
        for p in reader.pages:
            text += (p.extract_text() or "") + "\n"
            if len(text)>4_000_000: break
    except Exception:
        pass
    if len(text.strip())<200 and pdfplumber:
        try:
            with pdfplumber.open(str(path)) as pdf:
                chunks=[]
                for p in pdf.pages[:80]:
                    chunks.append(p.extract_text() or "")
                    if sum(map(len,chunks))>4_000_000: break
                text="\n".join(chunks)
        except Exception:
            pass
    return text

def load_state(path):
    try: return json.loads(path.read_text())
    except Exception: return {"files":{}}

def save_state(path,state):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(state,indent=2))

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--config",required=True)
    ap.add_argument("--dry-run",action="store_true")
    ap.add_argument("--no-sync",action="store_true")
    ap.add_argument("--max-pages",type=int,default=4)
    args=ap.parse_args()
    cfg=json.loads(Path(args.config).read_text())
    root=Path(cfg.get("reports_root","./banklens_data/reports"))
    state_path=Path(cfg.get("state_file","./banklens_data/state.json"))
    state=load_state(state_path)
    session=requests.Session()
    session.headers.update({"User-Agent":"BankLens Local Collector/1.0","Accept":"text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8"})
    all_records=[]; report_count=0; new_count=0; failed=[]
    country=cfg["country"]
    for bank_name,portal in cfg["banks"]:
        bank_dir=root/slug(country["name"])/slug(bank_name)
        bank_dir.mkdir(parents=True,exist_ok=True)
        print(f"\n[{bank_name}] {portal}")
        try:
            r=fetch(session,portal)
            ctype=r.headers.get("content-type","")
            html=r.text if "html" in ctype.lower() else ""
            reports=discover_reports(html,r.url) if html else ([{"url":r.url,"title":bank_name,"report_type":"financial"}] if PDF_RE.search(r.url) else [])
            # Follow up to max-pages report listing pages on same origin.
            seen={r.url}; queue=[(x["url"],0) for x in reports if not PDF_RE.search(x["url"])][:args.max_pages]
            while queue:
                u,d=queue.pop(0)
                if u in seen or d>=2: continue
                seen.add(u)
                try:
                    rr=fetch(session,u)
                    if "html" not in rr.headers.get("content-type","").lower(): continue
                    for x in discover_reports(rr.text,rr.url):
                        if x["url"] not in {z["url"] for z in reports}: reports.append(x)
                    for x in discover_reports(rr.text,rr.url):
                        if not PDF_RE.search(x["url"]) and urlparse(x["url"]).netloc==urlparse(portal).netloc:
                            queue.append((x["url"],d+1))
                except Exception as e: failed.append({"bank":bank_name,"url":u,"error":str(e)})
            # Deduplicate by canonical URL.
            unique={x["url"].split("#")[0]:x for x in reports}
            for rep in unique.values():
                report_count+=1
                try:
                    rr=fetch(session,rep["url"])
                    body=rr.content
                    h=sha256(body)
                    ext=".pdf" if PDF_RE.search(rr.url) or "pdf" in rr.headers.get("content-type","").lower() else ".html"
                    fn=f"{h[:16]}{ext}"
                    path=bank_dir/fn
                    already=state["files"].get(rep["url"])
                    if path.exists() and already and already.get("sha256")==h:
                        continue
                    path.write_bytes(body); new_count+=1
                    if ext==".pdf":
                        text=extract_pdf(path)
                    else:
                        text=clean_text(body.decode("utf-8","ignore"))
                    pl,ps,pe=period(text,rep["title"],rep["url"])
                    metrics=extract_metrics(text)
                    for m in metrics:
                        m.update({"bank_name":bank_name,"country_name":country["name"],"country_iso2":country["iso2"],
                                  "source_url":rep["url"],"source_title":rep["title"],"report_type":rep["report_type"],
                                  "content_hash":h,"period_label":pl,"reporting_period_start":ps,"reporting_period_end":pe,
                                  "local_path":str(path)})
                    all_records.extend(metrics)
                    state["files"][rep["url"]]={"sha256":h,"path":str(path),"bank":bank_name,"title":rep["title"],"period":pl,"metrics":len(metrics),"processed_at":now()}
                    print(f"  {rep['title'][:70]} -> {len(metrics)} metrics")
                except Exception as e:
                    failed.append({"bank":bank_name,"url":rep["url"],"error":str(e)})
        except Exception as e:
            failed.append({"bank":bank_name,"url":portal,"error":str(e)})
            print(f"  PORTAL ERROR: {e}")
    save_state(state_path,state)
    payload={"run_at":now(),"country":country,"reports_seen":report_count,"new_reports":new_count,
             "records":all_records,"failures":failed}
    out=Path("banklens_data")/f"run_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    out.parent.mkdir(exist_ok=True); out.write_text(json.dumps(payload,indent=2))
    print(f"\nCOLLECTION COMPLETE: {report_count} reports, {new_count} new/changed, {len(all_records)} values, {len(failed)} failures")
    if args.dry_run or args.no_sync:
        print(f"Local run saved to {out}")
        return 0
    api=cfg["api_base"].rstrip("/")
    username=os.getenv("BANKLENS_ADMIN_USERNAME")
    password=os.getenv("BANKLENS_ADMIN_PASSWORD")
    token=os.getenv("BANKLENS_ADMIN_TOKEN")
    if not token:
        if not username or not password:
            raise SystemExit("Set BANKLENS_ADMIN_TOKEN or BANKLENS_ADMIN_USERNAME and BANKLENS_ADMIN_PASSWORD")
        lr=session.post(api+"/api/auth/login",json={"username":username,"password":password},timeout=30)
        lr.raise_for_status(); token=lr.json()["token"]
    headers={"Authorization":f"Bearer {token}","Content-Type":"application/json"}
    # Send in batches so one large country does not create a huge Worker request.
    batch_size=25
    sent=0
    for i in range(0,len(all_records),batch_size):
        batch=all_records[i:i+batch_size]
        sr=session.post(api+"/api/admin/pipeline/sync",headers=headers,json={"country":country,"records":batch},timeout=60)
        sr.raise_for_status()
        sent += len(batch)
        print(f"SYNC {sent}/{len(all_records)}")
    fr=session.post(api+"/api/admin/pipeline/finalize",headers=headers,json={"country":country,"run":payload},timeout=60)
    fr.raise_for_status()
    print("CLOUD PUBLISH COMPLETE:",fr.json())
    return 0

if __name__=="__main__":
    raise SystemExit(main())
