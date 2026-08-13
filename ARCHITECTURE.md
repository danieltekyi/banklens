# Architecture

```
Admin (browser) ─┐
                 ├─> Cloudflare Worker (Hono) ──> D1  ──> Public site (browser)
Local collector ─┘                          └──> R2
```

Static React assets are built with the Cloudflare Vite plugin. The Worker serves them and exposes the API.

## Boundaries

**The Worker never crawls.** Downloading and parsing multi-megabyte PDFs is not edge work, and bank portals are slow and inconsistent. All collection happens in `pipeline/`, on a machine the operator controls. The Worker only accepts already-normalised values through authenticated pipeline endpoints.

**The collector never decides what to collect.** It reads the administrator's configuration — countries, banks, portal URLs — and fetches only those. There is no open-ended discovery.

**Analysis is deterministic.** `worker/analysis.ts` holds the metric dictionary (label, unit, direction, weight) and the peer-relative scoring. It is pure arithmetic over extracted values, so any published figure can be traced to the document that produced it. No model is involved anywhere in BankLens.

**Deletion is explicit about its blast radius.** Removing a reporting portal is a soft delete: collection stops, but the documents and values already gathered stay readable so existing figures remain citable. Purging a portal, or deleting a bank or country, cascades through every dependent table and the matching R2 objects, and reports back exactly what it destroyed.

## Layout

| Path | Contents |
|---|---|
| `worker/index.ts` | Entry point, auth, legacy routes, cron handler |
| `worker/env.ts` | Shared `Bindings` type |
| `worker/analysis.ts` | Metric catalog, percentile scoring, strengths/weaknesses |
| `worker/routes/admin-crud.ts` | Country/bank/portal/product CRUD and cascade deletes |
| `worker/routes/public-api.ts` | Rankings, compare, profile, reports, recommend, overview |
| `worker/routes/pipeline-api.ts` | Config, known-hashes, sync, finalize |
| `worker/db.ts` | Public bank queries |
| `worker/schema.ts` | Runtime-created tables and indexes |
| `migrations/` | Migration-owned tables |
| `pipeline/banklens_core.py` | Discovery, dedupe, extraction, analysis |
| `pipeline/banklens_wrangle.py` | Default entry point, talks to D1 via Wrangler |
| `pipeline/banklens_pipeline.py` | Alternative entry point, talks to the Worker over HTTP |
| `scripts/api-smoke.mjs` | End-to-end API test suite |

## Schema ownership

Two mechanisms create tables, which is a wrinkle worth knowing about:

- **Migrations** own `banks`, `countries`, `sources`, `products`, `bank_products`, `admin_*`, `scan_runs`.
- **`worker/schema.ts` (`ensureBankLensSchema`)** creates `financial_records`, `financial_documents`, `financial_extractions`, `bank_analysis` and `banklens_latest_metrics` at runtime on first request.

A migration therefore cannot add an index to a `financial_*` table, because that table may not exist yet when migrations run. Those indexes live in `schema.ts` alongside the `CREATE TABLE` that precedes them.

`latest_metrics` is a legacy view in some production databases. It is never altered. The writable snapshot is `banklens_latest_metrics`.

## Dedupe

The collector avoids re-downloading in three layers:

1. A `HEAD` request fingerprint (ETag, Content-Length, final URL) compared against local state — this skips before any body is transferred.
2. A SHA-256 of the body compared against known hashes, for servers that do not support conditional requests.
3. `GET /api/admin/pipeline/known-hashes`, so a fresh machine still knows what the platform already holds.

Content that changed is reprocessed; content that did not is skipped. `POST /api/admin/pipeline/sync` is itself idempotent — a value is keyed on bank, metric, reporting period and content hash — so replaying a batch inserts nothing.
