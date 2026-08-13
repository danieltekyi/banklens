#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

from banklens_core import compute_analysis, run_collection, setup_logging, now


def find_project_root(start: Path) -> Path:
    start = start.resolve()
    if start.is_file():
        start = start.parent
    for candidate in [start, *start.parents]:
        if any((candidate / name).exists() for name in ("wrangler.jsonc", "wrangler.json", "wrangler.toml")):
            return candidate
    raise RuntimeError("Could not locate the BankLens project root. Expected wrangler.jsonc above the pipeline directory.")


def db_name(project_root: Path) -> str:
    value = os.getenv("BANKLENS_D1_DATABASE")
    if value:
        return value
    for p in [project_root / "wrangler.jsonc", project_root / "wrangler.json", project_root / "wrangler.toml"]:
        if not p.exists():
            continue
        text = p.read_text(encoding="utf-8-sig", errors="ignore")
        m = re.search(r'"database_name"\s*:\s*"([^"]+)"', text) or re.search(r'\bdatabase_name\s*=\s*"([^"]+)"', text)
        if m:
            return m.group(1)
    raise RuntimeError(f"D1 database name not found in {project_root}. Expected d1_databases[].database_name in wrangler config.")


def wrangler(project_root: Path, db: str, sql: str | None = None, file: Path | None = None):
    executable = (shutil.which("npx.cmd") or shutil.which("npx") or "npx.cmd") if os.name == "nt" else (shutil.which("npx") or "npx")
    cmd = [executable, "wrangler", "d1", "execute", db, "--remote"]
    if sql is not None:
        cmd += ["--command", sql, "--json"]
    elif file is not None:
        cmd += ["--file", str(file)]
    else:
        raise ValueError("sql/file required")
    p = subprocess.run(cmd, cwd=project_root, capture_output=True, encoding="utf-8", errors="replace")
    if p.returncode:
        err = (p.stderr or p.stdout or "").strip()
        raise RuntimeError(f"Wrangler D1 command failed (exit {p.returncode}).\nDatabase: {db}\nCommand: {' '.join(cmd)}\nOutput:\n{err}")
    if sql is None:
        return p.stdout
    raw = (p.stdout or "").strip()
    try:
        return json.loads(raw)
    except Exception:
        for i in [raw.find("["), raw.find("{")]:
            if i >= 0:
                try:
                    return json.loads(raw[i:])
                except Exception:
                    pass
    raise RuntimeError("Could not parse Wrangler JSON output:\n" + raw[:4000])


def rows(result):
    out = []
    def walk(x):
        if isinstance(x, list):
            for y in x: walk(y)
        elif isinstance(x, dict):
            if isinstance(x.get("results"), list):
                out.extend(x["results"])
            else:
                for v in x.values():
                    if isinstance(v, (dict, list)): walk(v)
    walk(result)
    return out


def query(root: Path, db: str, sql: str):
    return rows(wrangler(root, db, sql=sql))


def q(v: Any) -> str:
    if v is None: return "NULL"
    if isinstance(v, bool): return "1" if v else "0"
    if isinstance(v, (int, float)) and not isinstance(v, bool): return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def load_config(root: Path, db: str, country_filter: str | None):
    countries = query(root, db, "SELECT id,name,iso2,currency,enabled FROM countries WHERE enabled=1 ORDER BY name")
    if country_filter:
        f = country_filter.lower()
        countries = [c for c in countries if str(c["id"]) == f or str(c["name"]).lower() == f or str(c["iso2"]).lower() == f]
    if not countries:
        raise RuntimeError("No enabled country matched.")
    ids = ",".join(str(int(c["id"])) for c in countries)
    banks = query(root, db, f"SELECT id,country_id,name,short_name,slug,active FROM banks WHERE active=1 AND country_id IN ({ids}) ORDER BY country_id,name")
    bank_ids = ",".join(str(int(b["id"])) for b in banks) or "0"
    sources = query(root, db, f"""SELECT id,bank_id,url,source_type,active FROM sources
                              WHERE active=1 AND source_type='financial_portal' AND bank_id IN ({bank_ids})
                              ORDER BY bank_id,id""")
    return countries, banks, sources


def sql_id_list(values):
    ids = []
    for value in values:
        try:
            ids.append(str(int(value)))
        except (TypeError, ValueError):
            continue
    if not ids:
        raise RuntimeError("No valid country IDs were supplied for the D1 query.")
    return ",".join(ids)


def existing(root: Path, db: str, country_ids):
    ids = sql_id_list(country_ids)
    docs_sql = (
        "SELECT d.id,d.bank_id,d.source_id,d.report_url,d.report_title,d.report_type,"
        "d.content_hash,d.status,d.reporting_period_start,d.reporting_period_end,"
        "d.period_label,b.country_id,b.name AS bank_name "
        "FROM financial_documents AS d JOIN banks AS b ON b.id=d.bank_id "
        f"WHERE b.country_id IN ({ids})"
    )
    recs_sql = (
        "SELECT fr.id,fr.bank_id,fr.source_id,fr.source_url,fr.source_title,fr.metric_key,"
        "fr.metric_label,fr.raw_value,fr.value,fr.unit,fr.currency,"
        "fr.reporting_period_start,fr.reporting_period_end,fr.period_label,"
        "fr.statement_date,fr.content_hash,fr.status,b.country_id,b.name AS bank_name "
        "FROM financial_records AS fr JOIN banks AS b ON b.id=fr.bank_id "
        f"WHERE b.country_id IN ({ids}) AND fr.status='published'"
    )
    try:
        return query(root, db, docs_sql), query(root, db, recs_sql)
    except Exception as exc:
        raise RuntimeError(f"Failed to read existing BankLens reports/records from D1. Country IDs: {ids}.\nSQL error: {exc}") from exc


def sql_sync(new_records, documents, extractions, snapshots, analyses, bank_updates, country_ids, scan_time):
    s = ["BEGIN TRANSACTION;"]
    for d in documents:
        cols = ["bank_id", "source_id", "report_url", "report_title", "report_type", "content_hash", "content_type", "r2_key", "reporting_period_start", "reporting_period_end", "period_label", "status", "discovered_at", "downloaded_at", "processed_at", "created_at", "updated_at"]
        s.append(f"INSERT OR IGNORE INTO financial_documents({','.join(cols)}) VALUES({','.join(q(d.get(c)) for c in cols)});")
    for e in extractions:
        cols = ["bank_id", "source_id", "source_url", "content_hash", "period_label", "status", "records_found", "error", "created_at"]
        s.append(f"INSERT INTO financial_extractions({','.join(cols)}) VALUES({','.join(q(e.get(c)) for c in cols)});")
    for r in new_records:
        s.append(f"DELETE FROM financial_records WHERE source_id={q(r['source_id'])} AND source_url={q(r['source_url'])} AND content_hash={q(r['content_hash'])} AND metric_key={q(r['metric_key'])};")
        cols = ["bank_id", "source_id", "source_url", "source_title", "metric_key", "metric_label", "raw_value", "value", "unit", "currency", "reporting_period_start", "reporting_period_end", "period_label", "statement_date", "content_hash", "status", "created_at", "updated_at"]
        s.append(f"INSERT INTO financial_records({','.join(cols)}) VALUES({','.join(q(r.get(c)) for c in cols)});")
    for x in snapshots:
        cols = ["bank_id", "assets", "deposits", "profit", "capital_adequacy", "liquidity", "npl", "reporting_period", "reporting_period_end", "updated_at", "assets_source_url", "assets_source_title", "deposits_source_url", "deposits_source_title", "profit_source_url", "profit_source_title", "capital_adequacy_source_url", "capital_adequacy_source_title", "liquidity_source_url", "liquidity_source_title", "npl_source_url", "npl_source_title"]
        s.append(f"DELETE FROM banklens_latest_metrics WHERE bank_id={q(x['bank_id'])};")
        s.append(f"INSERT INTO banklens_latest_metrics({','.join(cols)}) VALUES({','.join(q(x.get(c)) for c in cols)});")
    for a in analyses:
        s.append(f"INSERT OR REPLACE INTO bank_analysis(bank_id,strengths_json,weaknesses_json,generated_at) VALUES({q(a['bank_id'])},{q(a['strengths_json'])},{q(a['weaknesses_json'])},{q(a['generated_at'])});")
    for b in bank_updates:
        s.append(f"UPDATE banks SET health_score={q(b['health_score'])}, summary={q(b['summary'])}, updated_at={q(b['updated_at'])} WHERE id={q(b['bank_id'])};")
    if country_ids:
        ids = ",".join(str(int(x)) for x in country_ids)
        s.append(f"UPDATE countries SET last_scan_at={q(scan_time)} WHERE id IN ({ids});")
    s.append("COMMIT;")
    return "\n".join(s) + "\n"


def main():
    ap = argparse.ArgumentParser(description="BankLens local financial-report collector using Wrangler/D1 (default transport).")
    ap.add_argument("--project-root", default=None, help="BankLens project root. Defaults to nearest parent containing wrangler config.")
    ap.add_argument("--country", default=None, help="Run one enabled country by ISO2, name, or id. Omit for all enabled countries.")
    ap.add_argument("--dry-run", action="store_true", help="Collect/extract locally and write run artifacts, but do not publish to D1.")
    ap.add_argument("--no-sync", action="store_true", help="Alias for --dry-run after local extraction; no D1 writes.")
    ap.add_argument("--force", action="store_true", help="Ignore URL/hash dedupe and re-download candidates.")
    ap.add_argument("--limit", type=int, default=None, help="Maximum number of new/changed reports to process in this run.")
    ap.add_argument("--verbose", action="store_true", help="Print detailed discovery/dedupe logging to the console.")
    args = ap.parse_args()

    script_dir = Path(__file__).resolve().parent
    root = find_project_root(Path(args.project_root)) if args.project_root else find_project_root(script_dir)
    data_dir = script_dir / "banklens_data"
    logger, log_path = setup_logging(data_dir, args.verbose)
    db = db_name(root)
    logger.info("BankLens Wrangler pipeline started. Log: %s", log_path)
    countries, banks, sources = load_config(root, db, args.country)
    docs, recs = existing(root, db, [c["id"] for c in countries])
    result = run_collection(countries, banks, sources, data_dir, docs, recs, force=args.force, limit=args.limit, verbose=args.verbose, logger=logger)
    combined = list(recs)
    known = {(int(r["source_id"]), r["source_url"], r.get("content_hash"), r["metric_key"]) for r in recs if r.get("source_id") is not None}
    for r in result["records"]:
        if (r["source_id"], r["source_url"], r["content_hash"], r["metric_key"]) not in known:
            combined.append(r)
    snapshots, analyses, bank_updates = compute_analysis(combined, banks)
    summary = result["summary"]
    logger.info(json.dumps(summary, indent=2))
    if args.dry_run or args.no_sync:
        logger.info("DRY RUN / NO SYNC: no D1 changes made.")
        return 0
    sql_path = data_dir / "sync_latest.sql"
    sql_path.write_text(sql_sync(result["records"], result["documents"], result["extractions"], snapshots, analyses, bank_updates, [c["id"] for c in countries], summary["finished_at"]), encoding="utf-8")
    if not result["records"]:
        logger.info("No new analysed values; applying metadata/analysis refresh only.")
    logger.info("Applying %s bytes to D1 '%s' using Wrangler...", f"{sql_path.stat().st_size:,}", db)
    wrangler(root, db, file=sql_path)
    logger.info("D1 publication complete.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
