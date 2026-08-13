
#!/usr/bin/env python3
from __future__ import annotations
import argparse, json, os, re, shutil, subprocess, sys
from pathlib import Path
from urllib.parse import urlparse

from banklens_pipeline import (
    requests, BeautifulSoup, fetch, discover_reports, extract_pdf, extract_metrics,
    period, sha256, slug, now
)

def find_project_root(start: Path) -> Path:
    """Find the BankLens project root by locating wrangler.jsonc/json/toml."""
    start = start.resolve()
    if start.is_file():
        start = start.parent
    for candidate in [start, *start.parents]:
        if any((candidate / name).exists() for name in ("wrangler.jsonc", "wrangler.json", "wrangler.toml")):
            return candidate
    raise RuntimeError(
        "Could not locate the BankLens project root. "
        "Expected wrangler.jsonc above the pipeline directory."
    )

def db_name(project_root: Path) -> str:
    value = os.getenv("BANKLENS_D1_DATABASE")
    if value:
        return value

    for p in [
        project_root / "wrangler.jsonc",
        project_root / "wrangler.json",
        project_root / "wrangler.toml",
    ]:
        if not p.exists():
            continue

        text = p.read_text(encoding="utf-8-sig", errors="ignore")

        # JSON/JSONC syntax.
        m = re.search(r'"database_name"\s*:\s*"([^"]+)"', text)
        if m:
            return m.group(1)

        # TOML syntax.
        m = re.search(r'\bdatabase_name\s*=\s*"([^"]+)"', text)
        if m:
            return m.group(1)

    raise RuntimeError(
        f"D1 database name not found in {project_root}. "
        "Expected d1_databases[].database_name in wrangler.jsonc."
    )

def wrangler(project_root: Path, db: str, sql: str|None=None, file: Path|None=None):
    # Windows normally exposes npm's launcher as npx.cmd. Resolve it explicitly
    # so Python subprocess/CreateProcess does not fail with WinError 2.
    if os.name == "nt":
        executable = shutil.which("npx.cmd") or shutil.which("npx") or "npx.cmd"
    else:
        executable = shutil.which("npx") or "npx"

    cmd=[executable,"wrangler","d1","execute",db,"--remote"]
    if sql is not None:
        cmd += ["--command",sql,"--json"]
    elif file is not None:
        cmd += ["--file",str(file)]
    else:
        raise ValueError("sql/file required")

    p=subprocess.run(cmd,cwd=project_root,capture_output=True,encoding="utf-8",errors="replace")
    if p.returncode:
        err=(p.stderr or p.stdout or "").strip()
        raise RuntimeError(
            f"Wrangler D1 command failed (exit {p.returncode}).\\n"
            f"Database: {db}\\n"
            f"Command: {' '.join(cmd)}\\n"
            f"Output:\\n{err}"
        )

    if sql is None:
        return p.stdout

    raw=(p.stdout or "").strip()
    try:
        return json.loads(raw)
    except Exception:
        for i in [raw.find("["),raw.find("{")]:
            if i>=0:
                try:
                    return json.loads(raw[i:])
                except Exception:
                    pass

    raise RuntimeError("Could not parse Wrangler JSON output:\n"+raw[:4000])

def rows(result):
    out=[]
    def walk(x):
        if isinstance(x,list):
            for y in x: walk(y)
        elif isinstance(x,dict):
            if isinstance(x.get("results"),list):
                out.extend(x["results"])
            else:
                for v in x.values():
                    if isinstance(v,(dict,list)): walk(v)
    walk(result)
    return out

def query(root,db,sql):
    return rows(wrangler(root,db,sql=sql))

def q(v):
    if v is None:return "NULL"
    if isinstance(v,bool):return "1" if v else "0"
    if isinstance(v,(int,float)) and not isinstance(v,bool):return str(v)
    return "'" + str(v).replace("'","''") + "'"

def discover_deep(session,portal,max_reports=100,max_depth=2):
    queue=[(portal,0,"Financial reporting portal")]
    seen=set(); reports={}
    while queue and len(reports)<max_reports:
        url,depth,title=queue.pop(0); key=url.split("#")[0]
        if key in seen: continue
        seen.add(key)
        try:
            r=fetch(session,url)
            if r.status_code>=400: continue
            ctype=r.headers.get("content-type","")
            body=r.content
            if "pdf" in ctype.lower() or body[:5]==b"%PDF-":
                reports[r.url]=(r.url,title); continue
            if "html" not in ctype.lower(): continue
            for x in discover_reports(r.text,r.url):
                u=x["url"]
                if re.search(r"\.pdf(?:$|[?#])",u,re.I):
                    reports[u]=(u,x["title"])
                elif depth<max_depth and urlparse(u).netloc==urlparse(portal).netloc:
                    queue.append((u,depth+1,x["title"]))
        except Exception:
            continue
    return list(reports.values())

def load_config(root,db,country_filter):
    countries=query(root,db,"SELECT id,name,iso2,currency,enabled FROM countries WHERE enabled=1 ORDER BY name")
    if country_filter:
        f=country_filter.lower()
        countries=[c for c in countries if str(c["id"])==f or c["name"].lower()==f or str(c["iso2"]).lower()==f]
    if not countries: raise RuntimeError("No enabled country matched.")
    ids=",".join(str(int(c["id"])) for c in countries)
    banks=query(root,db,f"SELECT id,country_id,name,short_name,slug,active FROM banks WHERE active=1 AND country_id IN ({ids}) ORDER BY country_id,name")
    bank_ids=",".join(str(int(b["id"])) for b in banks) or "0"
    sources=query(root,db,f"""SELECT id,bank_id,url,source_type,active FROM sources
                              WHERE active=1 AND source_type='financial_portal' AND bank_id IN ({bank_ids})
                              ORDER BY bank_id,id""")
    return countries,banks,sources

def sql_id_list(values):
    ids=[]
    for value in values:
        try:
            ids.append(str(int(value)))
        except (TypeError, ValueError):
            continue
    if not ids:
        raise RuntimeError("No valid country IDs were supplied for the D1 query.")
    return ",".join(ids)

def existing(root,db,country_ids):
    ids=sql_id_list(country_ids)
    docs_sql=(
        "SELECT d.id,d.bank_id,d.source_id,d.report_url,d.report_title,d.report_type,"
        "d.content_hash,d.status,d.reporting_period_start,d.reporting_period_end,"
        "d.period_label,b.country_id,b.name AS bank_name "
        "FROM financial_documents AS d "
        "JOIN banks AS b ON b.id=d.bank_id "
        f"WHERE b.country_id IN ({ids})"
    )
    recs_sql=(
        "SELECT fr.id,fr.bank_id,fr.source_id,fr.source_url,fr.source_title,fr.metric_key,"
        "fr.metric_label,fr.raw_value,fr.value,fr.unit,fr.currency,"
        "fr.reporting_period_start,fr.reporting_period_end,fr.period_label,"
        "fr.statement_date,fr.content_hash,fr.status,b.country_id,b.name AS bank_name "
        "FROM financial_records AS fr "
        "JOIN banks AS b ON b.id=fr.bank_id "
        f"WHERE b.country_id IN ({ids}) AND fr.status='published'"
    )
    try:
        docs=query(root,db,docs_sql)
        recs=query(root,db,recs_sql)
    except Exception as exc:
        raise RuntimeError(
            "Failed to read existing BankLens reports/records from D1. "
            f"Country IDs: {ids}.\nSQL error: {exc}\n"
            f"Documents SQL: {docs_sql}\nRecords SQL: {recs_sql}"
        ) from exc
    return docs,recs

def compute_analysis(all_records,banks):
    by_bank={}
    for r in all_records:
        by_bank.setdefault(int(r["bank_id"]),[]).append(r)
    snapshots=[]; analyses=[]
    for b in banks:
        bid=int(b["id"]); rows_=sorted(by_bank.get(bid,[]),key=lambda x:(x.get("reporting_period_end") or "",int(x.get("id") or 0)),reverse=True)
        latest={}
        for r in rows_:
            latest.setdefault(r["metric_key"],r)
        s={"bank_id":bid,"updated_at":now(),"reporting_period":None,"reporting_period_end":None}
        for key in ["assets","deposits","profit","capital_adequacy","liquidity","npl"]:
            r=latest.get(key)
            if r:
                s[key]=r.get("value"); s[f"{key}_source_url"]=r.get("source_url"); s[f"{key}_source_title"]=r.get("source_title")
                if s["reporting_period"] is None:
                    s["reporting_period"]=r.get("period_label"); s["reporting_period_end"]=r.get("reporting_period_end")
        strengths=[]; weaknesses=[]
        def nums(k):
            return [float(x["value"]) for x in rows_ if x["metric_key"]==k and x.get("value") is not None]
        for key,label,higher in [("profit","Profitability",True),("capital_adequacy","Capital adequacy",True),("liquidity","Liquidity",True),("npl","NPL ratio",False),("roe","Return on equity",True),("cost_to_income","Cost-to-income ratio",False)]:
            vals=nums(key)
            if len(vals)>=2:
                good=vals[0]>vals[1] if higher else vals[0]<vals[1]
                (strengths if good else weaknesses).append(f"{label} improved versus the prior reported period." if good else f"{label} moved in an unfavourable direction versus the prior reported period.")
        analyses.append({"bank_id":bid,"strengths_json":json.dumps(list(dict.fromkeys(strengths))[:4]),"weaknesses_json":json.dumps(list(dict.fromkeys(weaknesses))[:4]),"generated_at":now()})
        snapshots.append(s)
    return snapshots,analyses

def sql_sync(new_records,documents,extractions,snapshots,analyses,country_ids,scan_time):
    s=["BEGIN TRANSACTION;"]
    for d in documents:
        cols=["bank_id","source_id","report_url","report_title","report_type","content_hash","content_type","r2_key","reporting_period_start","reporting_period_end","period_label","status","discovered_at","downloaded_at","processed_at","created_at","updated_at"]
        s.append(f"INSERT OR IGNORE INTO financial_documents({','.join(cols)}) VALUES({','.join(q(d.get(c)) for c in cols)});")
    for e in extractions:
        cols=["bank_id","source_id","source_url","content_hash","period_label","status","records_found","error","created_at"]
        s.append(f"INSERT INTO financial_extractions({','.join(cols)}) VALUES({','.join(q(e.get(c)) for c in cols)});")
    for r in new_records:
        s.append(f"DELETE FROM financial_records WHERE source_id={q(r['source_id'])} AND source_url={q(r['source_url'])} AND content_hash={q(r['content_hash'])} AND metric_key={q(r['metric_key'])};")
        cols=["bank_id","source_id","source_url","source_title","metric_key","metric_label","raw_value","value","unit","currency","reporting_period_start","reporting_period_end","period_label","statement_date","content_hash","status","created_at","updated_at"]
        s.append(f"INSERT INTO financial_records({','.join(cols)}) VALUES({','.join(q(r.get(c)) for c in cols)});")
    for x in snapshots:
        cols=["bank_id","assets","deposits","profit","capital_adequacy","liquidity","npl","reporting_period","reporting_period_end","updated_at",
              "assets_source_url","assets_source_title","deposits_source_url","deposits_source_title","profit_source_url","profit_source_title",
              "capital_adequacy_source_url","capital_adequacy_source_title","liquidity_source_url","liquidity_source_title","npl_source_url","npl_source_title"]
        s.append(f"DELETE FROM banklens_latest_metrics WHERE bank_id={q(x['bank_id'])};")
        s.append(f"INSERT INTO banklens_latest_metrics({','.join(cols)}) VALUES({','.join(q(x.get(c)) for c in cols)});")
    for a in analyses:
        s.append(f"INSERT OR REPLACE INTO bank_analysis(bank_id,strengths_json,weaknesses_json,generated_at) VALUES({q(a['bank_id'])},{q(a['strengths_json'])},{q(a['weaknesses_json'])},{q(a['generated_at'])});")
    if country_ids:
        ids=",".join(str(int(x)) for x in country_ids)
        s.append(f"UPDATE countries SET last_scan_at={q(scan_time)} WHERE id IN ({ids});")
    s.append("COMMIT;")
    return "\n".join(s)+"\n"

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument(
        "--project-root",
        default=None,
        help="BankLens project root. If omitted, automatically finds the nearest parent containing wrangler.jsonc."
    )
    ap.add_argument("--country",default=None)
    ap.add_argument("--dry-run",action="store_true")
    args=ap.parse_args()

    script_dir = Path(__file__).resolve().parent
    root = find_project_root(Path(args.project_root)) if args.project_root else find_project_root(script_dir)
    db = db_name(root)
    countries,banks,sources=load_config(root,db,args.country)
    country_by_id={int(c["id"]):c for c in countries}; bank_by_id={int(b["id"]):b for b in banks}
    docs,recs=existing(root,db,list(country_by_id))
    doc_hash={(int(d["source_id"]),d["report_url"],d.get("content_hash")) for d in docs}
    analysed={(int(r["source_id"]),r["source_url"],r.get("content_hash")) for r in recs}
    source_by_bank={}
    for s in sources: source_by_bank.setdefault(int(s["bank_id"]),[]).append(s)
    session=requests.Session()
    session.headers.update({"User-Agent":"BankLens Local Intelligence/1.0 (+https://banklens.tiwaak.com/methodology)","Accept":"text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8"})
    root_data=root/"pipeline"/"banklens_data" if (root/"pipeline").exists() else root/"banklens_data"; reports_root=root_data/"reports"; root_data.mkdir(parents=True,exist_ok=True)
    new_records=[]; documents=[]; extractions=[]; failures=[]
    discovered=downloaded=skipped=0
    for bank in banks:
        bid=int(bank["id"]); country=country_by_id[int(bank["country_id"])]
        bank_dir=reports_root/slug(country["name"])/slug(bank["name"]); bank_dir.mkdir(parents=True,exist_ok=True)
        for source in source_by_bank.get(bid,[]):
            print(f"\n[{country['name']}] {bank['name']} -> {source['url']}")
            try: report_list=discover_deep(session,source["url"])
            except Exception as e:
                failures.append({"stage":"portal","bank":bank["name"],"url":source["url"],"error":str(e)}); continue
            print(f"  discovered {len(report_list)} report links")
            for report_url,title in report_list:
                discovered+=1
                try:
                    rr=fetch(session,report_url,timeout=90)
                    body=rr.content
                    if not (re.search(r"\.pdf(?:$|[?#])",rr.url,re.I) or body[:5]==b"%PDF-"): continue
                    h=sha256(body)
                    key=(int(source["id"]),rr.url,h)
                    if key in analysed:
                        skipped+=1; continue
                    path=bank_dir/(h[:16]+".pdf")
                    if not path.exists(): path.write_bytes(body)
                    downloaded+=1
                    text=extract_pdf(path)
                    if not text.strip(): raise RuntimeError("NO_TEXT: PDF contains no machine-readable text")
                    pl,ps,pe=period(text,title,rr.url)
                    metrics=extract_metrics(text)
                    if not metrics: raise RuntimeError("NO_METRICS: PDF text was extracted but no supported financial metrics were matched")
                    ts=now()
                    documents.append({"bank_id":bid,"source_id":int(source["id"]),"report_url":rr.url,"report_title":title,"report_type":"financial","content_hash":h,"content_type":"application/pdf","r2_key":None,"reporting_period_start":ps,"reporting_period_end":pe,"period_label":pl,"status":"published","discovered_at":ts,"downloaded_at":ts,"processed_at":ts,"created_at":ts,"updated_at":ts})
                    extractions.append({"bank_id":bid,"source_id":int(source["id"]),"source_url":rr.url,"content_hash":h,"period_label":pl,"status":"published","records_found":len(metrics),"error":None,"created_at":ts})
                    for m in metrics:
                        new_records.append({"bank_id":bid,"source_id":int(source["id"]),"source_url":rr.url,"source_title":title,"metric_key":m["metric_key"],"metric_label":m["metric_label"],"raw_value":m["raw_value"],"value":m["value"],"unit":m["unit"],"currency":m.get("currency") or country["currency"],"reporting_period_start":ps,"reporting_period_end":pe,"period_label":pl,"statement_date":pe,"content_hash":h,"status":"published","created_at":ts,"updated_at":ts})
                    print(f"  NEW {pl}: {len(metrics)} metrics")
                except Exception as e:
                    failures.append({"stage":"report","bank":bank["name"],"country":country["name"],"url":report_url,"title":title,"error":str(e)})
                    print(f"  FAIL {title[:70]}: {e}")
    combined=list(recs)
    known={(int(r["source_id"]),r["source_url"],r.get("content_hash"),r["metric_key"]) for r in recs}
    for r in new_records:
        if (r["source_id"],r["source_url"],r["content_hash"],r["metric_key"]) not in known: combined.append(r)
    snapshots,analyses=compute_analysis(combined,banks)
    summary={"countries":len(countries),"banks":len(banks),"portals":len(sources),"reports_discovered":discovered,"reports_downloaded":downloaded,"reports_skipped_already_analysed":skipped,"new_values":len(new_records),"failures":len(failures),"finished_at":now()}
    print("\n"+json.dumps(summary,indent=2))
    (root_data/"failures.json").write_text(json.dumps(failures,indent=2,ensure_ascii=False))
    (root_data/"last_run.json").write_text(json.dumps(summary,indent=2))
    if args.dry_run:
        print("DRY RUN: no D1 changes made."); return 0
    sql_path=root_data/"sync_latest.sql"
    sql_path.write_text(
        sql_sync(
            new_records,
            documents,
            extractions,
            snapshots,
            analyses,
            list(country_by_id),
            summary["finished_at"]
        ),
        encoding="utf-8"
    )
    if not new_records:
        print("No new analysed values. Updating last local sync timestamp only.")
    print(f"Applying {sql_path.stat().st_size:,} bytes to D1 '{db}' using Wrangler...")
    wrangler(root,db,file=sql_path)
    print("D1 publication complete.")
    return 0

if __name__=="__main__":
    raise SystemExit(main())
