# BankLens local pipeline

The default entry point is `run_banklens.bat`, which creates/updates `pipeline\.venv`, installs `requirements.txt`, and runs `banklens_wrangle.py`. This path reads BankLens admin config from Cloudflare D1 with Wrangler, crawls official financial portals locally, extracts financial metrics without AI/LLM calls, and writes normalized records back to D1.

`banklens_pipeline.py` is the alternative HTTP transport for the Worker endpoints:

- `GET /api/admin/pipeline/config?country=GH`
- `GET /api/admin/pipeline/known-hashes?country=GH`
- `POST /api/admin/pipeline/sync`
- `POST /api/admin/pipeline/finalize`

Both entry points share `banklens_core.py` for report discovery, filtering, dedupe, extraction, and deterministic analysis.

## Setup

Prerequisites: Python on PATH, Node/npm with Wrangler available to `npx.cmd`, and Cloudflare credentials already logged in for Wrangler.

```powershell
cd C:\Users\danieltekyi\dev\banklens
pipeline\run_banklens.bat --help
```

The first run creates `pipeline\.venv` and installs Python packages.

Optional environment variables:

- `BANKLENS_D1_DATABASE` overrides the D1 database name discovered from `wrangler.jsonc`.
- `BANKLENS_API_BASE` and `BANKLENS_ADMIN_TOKEN` are used by the HTTP transport.

## Manual runs

Default Wrangler/D1 transport:

```powershell
pipeline\run_banklens.bat
pipeline\run_banklens.bat --country GH
pipeline\run_banklens.bat --country GH --dry-run --verbose
pipeline\run_banklens.bat --country GH --no-sync
pipeline\run_banklens.bat --country GH --force --limit 5
```

HTTP transport:

```powershell
pipeline\.venv\Scripts\python.exe pipeline\banklens_pipeline.py --api-base https://example.workers.dev --token <admin-token> --country GH
pipeline\.venv\Scripts\python.exe pipeline\banklens_pipeline.py --dry-run --verbose
```

CLI flags:

- `--country ISO2|name|id`: run one country; omit to run all enabled countries.
- `--dry-run`: crawl, download, extract, log, and write local artifacts only.
- `--no-sync`: same as `--dry-run` for publication; useful when collecting local evidence.
- `--force`: ignore persisted URL/hash dedupe and re-download candidates.
- `--limit N`: stop after processing N new/changed reports.
- `--verbose`: print detailed discovery/dedupe diagnostics.
- `--project-root PATH`: Wrangler entry only; defaults to the parent with `wrangler.jsonc`.

## Scheduling

Windows Scheduled Task for Saturday 10:00 local time:

```powershell
powershell -ExecutionPolicy Bypass -File pipeline\install_weekly_task.ps1
```

Uninstall:

```powershell
powershell -ExecutionPolicy Bypass -File pipeline\install_weekly_task.ps1 -Uninstall
```

Pass fixed task arguments, for example only Ghana:

```powershell
powershell -ExecutionPolicy Bypass -File pipeline\install_weekly_task.ps1 -ExtraArguments "--country GH"
```

Linux/macOS cron equivalent for Saturday 10:00 local time:

```cron
0 10 * * 6 cd /path/to/banklens && /usr/bin/env bash -lc 'python3 -m venv pipeline/.venv && pipeline/.venv/bin/python -m pip install -r pipeline/requirements.txt >/dev/null && pipeline/.venv/bin/python pipeline/banklens_wrangle.py >> pipeline/banklens_data/cron.log 2>&1'
```

## Dedupe and data files

Runtime data is under `pipeline\banklens_data\`:

- `state.json`: persisted URL and content-hash dedupe state.
- `reports\`: downloaded report files named by content hash.
- `logs\banklens_YYYYMMDD_HHMMSS.log`: timestamped run logs.
- `last_run.json`, `failures.json`, `sync_latest.sql`: run artifacts.

The collector attempts `HEAD`, then a ranged `GET`, before full download. If the persisted URL fingerprint is unchanged and the content hash is known locally or remotely, the report is skipped before download. Changed content is reprocessed.

## Financial filtering and extraction

Discovery accepts PDF, XLS, XLSX, CSV, and report-like HTML links for annual reports, audited/unaudited financial statements, interim/half-year/quarterly results, Pillar 3, Basel, capital adequacy, and prudential disclosures. It rejects careers, privacy/cookies, news/press, tariffs/fees/rates/products, social links, and other non-report pages.

Extraction is pure Python: `pypdf`/`pdfplumber` for PDFs, `openpyxl`/`pandas` for spreadsheets, and CSV/HTML text parsing. No AI or LLM calls are used. Analysis uses deterministic thresholds and trend rules for capital adequacy, liquidity, NPL, profitability, efficiency, and returns.

## Verification

Run offline checks without contacting bank websites:

```powershell
pipeline\.venv\Scripts\python.exe -m py_compile pipeline\banklens_core.py pipeline\banklens_wrangle.py pipeline\banklens_pipeline.py pipeline\selftest.py
pipeline\.venv\Scripts\python.exe pipeline\selftest.py
```
