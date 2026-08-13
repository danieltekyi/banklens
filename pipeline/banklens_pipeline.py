#!/usr/bin/env python3
"""Alternative BankLens pipeline transport using Worker admin HTTP endpoints."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

from banklens_core import compute_analysis, make_session, run_collection, setup_logging


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def get_json(session, url: str, headers: dict[str, str]) -> dict[str, Any]:
    r = session.get(url, headers=headers, timeout=60)
    r.raise_for_status()
    return r.json()


def post_json(session, url: str, headers: dict[str, str], payload: dict[str, Any]) -> dict[str, Any]:
    r = session.post(url, headers=headers, json=payload, timeout=90)
    r.raise_for_status()
    return r.json()


def load_http_config(session, api_base: str, headers: dict[str, str], country: str | None):
    url = f"{api_base}/api/admin/pipeline/config"
    if country:
        url += f"?country={country}"
    cfg = get_json(session, url, headers)
    countries = cfg.get("countries") or []
    banks = cfg.get("banks") or []
    sources = cfg.get("sources") or []
    if not countries:
        raise RuntimeError("Pipeline config endpoint returned no enabled countries.")
    return countries, banks, sources


def load_known_hashes(session, api_base: str, headers: dict[str, str], countries: list[dict[str, Any]]) -> set[str]:
    hashes: set[str] = set()
    for country in countries:
        iso = country.get("iso2") or country.get("id")
        if not iso:
            continue
        try:
            payload = get_json(session, f"{api_base}/api/admin/pipeline/known-hashes?country={iso}", headers)
            hashes.update(str(h) for h in payload.get("hashes", []) if h)
        except Exception:
            # The local state still protects immediate reruns if this optional endpoint is unavailable.
            continue
    return hashes


def public_record(record: dict[str, Any]) -> dict[str, Any]:
    keys = ["bank_name", "country_iso2", "metric_key", "metric_label", "value", "raw_value", "unit", "currency", "source_url", "source_title", "report_type", "content_hash", "period_label", "reporting_period_start", "reporting_period_end"]
    return {k: record.get(k) for k in keys}


def main():
    ap = argparse.ArgumentParser(description="BankLens local financial-report collector using Worker admin HTTP endpoints.")
    ap.add_argument("--api-base", default=os.getenv("BANKLENS_API_BASE"), help="BankLens Worker base URL, or BANKLENS_API_BASE.")
    ap.add_argument("--token", default=os.getenv("BANKLENS_ADMIN_TOKEN"), help="Admin bearer token, or BANKLENS_ADMIN_TOKEN.")
    ap.add_argument("--country", default=None, help="Run one enabled country by ISO2. Omit for all countries returned by the endpoint.")
    ap.add_argument("--dry-run", action="store_true", help="Collect/extract locally, but do not call sync/finalize endpoints.")
    ap.add_argument("--no-sync", action="store_true", help="Collect/extract locally, but do not call sync/finalize endpoints.")
    ap.add_argument("--force", action="store_true", help="Ignore URL/hash dedupe and re-download candidates.")
    ap.add_argument("--limit", type=int, default=None, help="Maximum number of new/changed reports to process in this run.")
    ap.add_argument("--verbose", action="store_true", help="Print detailed discovery/dedupe logging to the console.")
    args = ap.parse_args()

    if not args.api_base:
        raise SystemExit("Set --api-base or BANKLENS_API_BASE.")
    if not args.token:
        raise SystemExit("Set --token or BANKLENS_ADMIN_TOKEN.")
    api_base = args.api_base.rstrip("/")
    data_dir = Path(__file__).resolve().parent / "banklens_data"
    logger, log_path = setup_logging(data_dir, args.verbose)
    logger.info("BankLens HTTP pipeline started. Log: %s", log_path)
    session = make_session()
    headers = auth_headers(args.token)
    countries, banks, sources = load_http_config(session, api_base, headers, args.country)
    known_hashes = load_known_hashes(session, api_base, headers, countries)
    result = run_collection(countries, banks, sources, data_dir, extra_known_hashes=known_hashes, force=args.force, limit=args.limit, verbose=args.verbose, logger=logger)
    snapshots, analyses, bank_updates = compute_analysis(result["records"], banks)
    run_payload = {**result["summary"], "analysis": {"snapshots": len(snapshots), "analyses": len(analyses), "bank_updates": bank_updates}}
    logger.info(json.dumps(result["summary"], indent=2))
    if args.dry_run or args.no_sync:
        logger.info("DRY RUN / NO SYNC: no HTTP sync performed.")
        return 0
    batch_size = 50
    records = [public_record(r) for r in result["records"]]
    inserted = skipped = 0
    for country in countries:
        country_records = [r for r in records if str(r.get("country_iso2", "")).upper() == str(country.get("iso2", "")).upper()]
        for i in range(0, len(country_records), batch_size):
            response = post_json(session, f"{api_base}/api/admin/pipeline/sync", headers, {"country": country, "records": country_records[i:i + batch_size]})
            inserted += int(response.get("inserted") or response.get("synced") or 0)
            skipped += int(response.get("skipped") or 0)
            logger.info("SYNC %s %d/%d -> %s", country.get("iso2"), min(i + batch_size, len(country_records)), len(country_records), response)
        final = post_json(session, f"{api_base}/api/admin/pipeline/finalize", headers, {"country": country, "run": run_payload})
        logger.info("FINALIZE %s -> %s", country.get("iso2"), final)
    logger.info("HTTP publication complete: inserted=%d skipped=%d", inserted, skipped)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
