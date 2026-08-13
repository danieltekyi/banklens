#!/usr/bin/env python3
from __future__ import annotations

import shutil
from pathlib import Path

from banklens_core import (
    compute_analysis,
    discover_reports,
    extract_document_text,
    extract_metrics,
    fingerprint_key,
    is_financial_report_candidate,
    load_state,
    period,
    remember_processed,
    save_state,
    sha256,
    should_skip_before_download,
)

def assert_true(value, message):
    if not value:
        raise AssertionError(message)


def main():
    root = Path(__file__).resolve().parent
    work = root / "banklens_data" / "selftest"
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)

    positives = [
        ("https://bank.example/reports/annual-report-2025.pdf", "Annual Report 2025"),
        ("https://bank.example/investors/q1-2026-unaudited-financial-statements.xlsx", "Q1 unaudited financial statements"),
        ("https://bank.example/pillar-3-disclosures-2025.html", "Pillar 3 disclosures"),
        ("https://bank.example/results/half-year-results-2026.csv", "Half-year results"),
    ]
    negatives = [
        ("https://bank.example/careers/finance-manager", "Finance manager vacancy"),
        ("https://bank.example/privacy-policy", "Privacy policy"),
        ("https://bank.example/news/2026-annual-awards", "Annual awards news"),
        ("https://bank.example/tariffs/fees-and-charges.pdf", "Fees and charges"),
        ("https://facebook.com/bank/posts/annual-report-2025.pdf", "Annual report social post"),
    ]
    for url, title in positives:
        assert_true(is_financial_report_candidate(url, title), f"expected report candidate: {url}")
    for url, title in negatives:
        assert_true(not is_financial_report_candidate(url, title), f"expected rejection: {url}")

    html = """
    <a href="/reports/annual-report-2025.pdf">Annual report 2025</a>
    <a href="/careers">Careers</a>
    <a href="/investors/q2-2026-unaudited-financial-statements.xlsx">Q2 unaudited financial statements</a>
    <a href="/news/annual-fun-run">Annual fun run news</a>
    <a href="/pillar-3-disclosures-2025.html">Pillar 3 disclosures</a>
    """
    links = discover_reports(html, "https://bank.example/investors/")
    assert_true(len(links) == 3, f"expected 3 report links, got {links}")

    fp = {"final_url": "https://bank.example/reports/annual-report-2025.pdf", "ETag": '"abc"', "Content-Length": "100"}
    state_path = work / "state.json"
    state = load_state(state_path)
    body = b"fake pdf bytes"
    h = sha256(body)
    remember_processed(state, fp["final_url"], h, fp, "report.pdf", {"title": "Annual Report"})
    save_state(state_path, state)
    state2 = load_state(state_path)
    skip, reason = should_skip_before_download(fp["final_url"], fp, state2, {h}, force=False)
    assert_true(skip and reason == "unchanged fingerprint", "second pass should skip unchanged URL before download")
    changed = dict(fp); changed["ETag"] = '"def"'
    skip, _ = should_skip_before_download(fp["final_url"], changed, state2, {h}, force=False)
    assert_true(not skip and fingerprint_key(changed) != fingerprint_key(fp), "changed fingerprint should not pre-skip")

    text = """
    Annual Report 2025. Amounts in GHS million.
    Total assets 12,500
    Customer deposits 8,100
    Profit after tax 950
    Loans and advances 6,200
    Total equity 1,700
    Capital adequacy ratio 21.4%
    Liquidity ratio 38.5%
    NPL ratio 3.2%
    Return on equity 24.1%
    Cost-to-income ratio 48.0%
    """
    pdfish = work / "fixture.pdf"
    pdfish.write_text(text, encoding="utf-8")
    extracted = extract_document_text(pdfish, "application/pdf", "https://bank.example/annual-report-2025.pdf")
    metrics = extract_metrics(extracted)
    keys = {m["metric_key"] for m in metrics}
    for key in ["assets", "deposits", "profit", "capital_adequacy", "liquidity", "npl", "roe", "cost_to_income"]:
        assert_true(key in keys, f"missing metric {key}: {metrics}")
    assert_true(next(m for m in metrics if m["metric_key"] == "assets")["value"] == 12.5, "GHS million should normalise to GHS_bn")

    # Regression: a server may advertise a .csv report as an Excel MIME type
    # (Windows hosts map .csv to application/vnd.ms-excel). The file extension
    # must win, otherwise the Excel reader is handed a CSV and the report is
    # lost. This was a real failure against a live portal.
    csv_fixture = work / "mislabelled.csv"
    csv_fixture.write_text(
        "Fixture Bank Annual Report 2025,Amounts in GHS million\n"
        "Total assets,12500\n"
        "Customer deposits,8100\n"
        "Profit after tax,950\n"
        "Capital adequacy ratio,21.4%\n"
        "NPL ratio,3.2%\n",
        encoding="utf-8",
    )
    mislabelled = extract_document_text(csv_fixture, "application/vnd.ms-excel", "https://bank.example/report.csv")
    assert_true("Total assets" in mislabelled, f"CSV mislabelled as Excel lost its text: {mislabelled!r}")
    csv_metrics = {m["metric_key"] for m in extract_metrics(mislabelled)}
    assert_true("assets" in csv_metrics and "npl" in csv_metrics, f"CSV metrics not extracted: {csv_metrics}")

    label, start, end = period(text, "Annual report 2025", "https://bank.example/annual-report-2025.pdf")
    assert_true((label, start, end) == ("FY 2025", "2025-01-01", "2025-12-31"), "annual period parse failed")
    q = period("Unaudited financial statements Q2 2026", "Q2 2026 results", "")
    assert_true(q == ("Q2 2026", "2026-04-01", "2026-06-30"), f"quarter period parse failed: {q}")

    records = []
    for i, m in enumerate(metrics, 1):
        records.append({**m, "id": i, "bank_id": 1, "source_id": 1, "source_url": "https://bank.example/annual-report-2025.pdf", "source_title": "Annual Report 2025", "reporting_period_end": "2025-12-31", "period_label": "FY 2025"})
    records.append({"id": 99, "bank_id": 1, "source_id": 1, "metric_key": "npl", "metric_label": "NPL ratio", "value": 5.5, "unit": "percent", "source_url": "old", "source_title": "old", "reporting_period_end": "2024-12-31", "period_label": "FY 2024"})
    snapshots, analyses, updates = compute_analysis(records, [{"id": 1, "name": "Fixture Bank"}])
    assert_true(snapshots[0]["assets"] == 12.5, "snapshot assets failed")
    assert_true(updates[0]["health_score"] > 50, f"expected healthy score, got {updates[0]}")
    assert_true("strengths_json" in analyses[0], "analysis JSON missing")

    print("SELFTEST PASS: filtering, dedupe, period parsing, extraction, and analysis scoring")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
