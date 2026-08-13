# BankLens

BankLens shows the financial position of the commercial banks in a country, using only figures traceable to each bank's own published, audited financial reports.

An administrator registers a country, its banks, and the URL of each bank's official financial-reporting page. A local Python agent runs weekly, downloads any new reports, extracts the figures and publishes analysed results. The public site then lets anyone see a bank's numbers by period, its trend over the years, how banks rank against each other, a side-by-side comparison, and which bank suits a specific need — with a source link beside every figure.

Built with React 19, TypeScript, Cloudflare Workers (Hono), D1, R2 and Cron Triggers.

## How the pieces fit

| Part | Where | Responsibility |
|---|---|---|
| Public site | `src/` | Country selector, rankings, comparison, trends, decision helper. Read-only. |
| Admin console | `src/pages/Admin.tsx` | Countries, banks, reporting portals, product rate cards. Full create/amend/delete. |
| API | `worker/` | Hono routes over D1. Public analysis endpoints plus authenticated admin and pipeline endpoints. |
| Analysis | `worker/analysis.ts` | Deterministic, peer-relative scoring. No model, no inference. |
| Collector | `pipeline/` | Pure-Python weekly agent. Discovers, dedupes, downloads, extracts, analyses, publishes. |

Nothing in BankLens uses AI or LLM tokens. Every published number is arithmetic over a value read out of a source document.

## Local setup

1. Install Node.js 22+ and Python 3.11+.
2. `npm install`
3. `cp .dev.vars.example .dev.vars`
4. `npm run db:local`
5. `npm run dev`

The public API returns clearly-flagged sample data (`meta.demo === true`) only when no bank has been configured yet. The interface shows a visible banner in that case.

### Verifying a change

```bash
npm run check      # typecheck worker + client
npm run build      # production build
npm run smoke      # 84 API tests against a running dev server
```

`npm run smoke` exercises the full admin CRUD surface, the pipeline sync contract and every public endpoint, then cleans up after itself. Point it elsewhere with `BANKLENS_URL`, and set `BANKLENS_ADMIN_USERNAME` / `BANKLENS_ADMIN_PASSWORD` to match your local admin.

The collector has its own offline test:

```bash
pipeline\.venv\Scripts\python.exe pipeline\selftest.py
```

## The weekly collector

Full documentation is in [`pipeline/README.md`](pipeline/README.md).

The agent runs on your own machine, not on Cloudflare, because downloading and parsing large PDFs is not work for an edge worker. It:

1. Reads the admin configuration (countries, banks, portal URLs).
2. Visits each configured portal and finds links to actual financial reports, rejecting careers, privacy, news, tariff and social links.
3. Checks a URL/content fingerprint **before downloading** and skips anything already processed. A re-run immediately after a successful run downloads nothing.
4. Extracts figures from PDF, XLSX, XLS and CSV.
5. Computes each bank's financial strength, profile, strengths and weaknesses with documented arithmetic rules.
6. Publishes normalised values, with their source document, back to D1.

Install the Saturday 10:00 schedule:

```powershell
powershell -ExecutionPolicy Bypass -File pipeline\install_weekly_task.ps1
```

Remove it with `-Uninstall`. Run it by hand at any time:

```powershell
pipeline\run_banklens.bat                                  # all enabled countries
pipeline\run_banklens.bat --country GH --verbose            # one country
pipeline\run_banklens.bat --country GH --dry-run            # collect, do not publish
pipeline\run_banklens.bat --force                           # ignore dedupe
```

## Cloudflare setup

```bash
npx wrangler login
npx wrangler d1 create banklens-db
npx wrangler r2 bucket create banklens-reports
```

Copy the D1 database ID into `wrangler.jsonc`, then:

```bash
npm run db:remote
npx wrangler secret put RESEND_API_KEY   # optional, for password-reset email
npm run deploy
```

In Cloudflare, add the custom domain `banklens.tiwaak.com` to the deployed Worker.

For GitHub Actions, add repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

## Admin console

Open `/admin`. The initial username is `banklensadmin`; change the password immediately. Recovery email is `sameultekyi@gmail.com`.

From the console you can:

- Create, rename, enable/disable and delete a **country**. Deleting one requires typing its ISO2 code and takes every bank with it.
- Add, rename, retarget and delete a **bank**. Deleting requires typing the bank name and removes its portals, reports, stored files, extracted values, rate cards and analysis.
- Add, amend, remove and purge a **reporting portal**. *Remove* stops future collection but keeps the reports already gathered so existing figures stay citable; *purge* destroys them.
- Maintain **rate cards** per bank. Product pricing is published outside the audited accounts, so it is entered here rather than extracted. Each entry records its own source.
- Review the **activity log** of every administrative change.

## Public API

Read-only, no authentication.

| Endpoint | Returns |
|---|---|
| `GET /api/countries` | Enabled countries |
| `GET /api/overview?country=` | Headline counts for a country |
| `GET /api/metrics/catalog` | Metric dictionary, including which direction is good |
| `GET /api/periods?country=` | Reporting periods that have published data |
| `GET /api/banks?country=` | Banks with their latest snapshot |
| `GET /api/banks/:slug/profile` | Score, components, strengths, trends, movement, products |
| `GET /api/banks/:slug/reports` | Every source document held for the bank |
| `GET /api/rankings?country=&metric=&year=` | Best and worst, respecting metric direction |
| `GET /api/compare?banks=a,b` | Side-by-side, one row per metric, leader marked |
| `GET /api/products?country=&type=` | Published rate cards |
| `GET /api/recommend?need=deposit\|credit` | Ranked recommendation with plain-English reasons |

## Scoring methodology

A bank's strength score is a weighted average of its percentile rank against the other banks in the same country, computed only from values extracted from published reports. It answers "how does this bank compare with its peers", not "is this bank objectively safe".

Metric weights and directions live in `worker/analysis.ts`. `coverage` reports how much of the scoring weight was actually backed by data, and the interface surfaces it so a score built on thin reporting is not read as authoritative.

Recommendations weight the rate the customer receives or pays at 70% and peer-relative financial strength at 30%.

## Production checklist

- Have the scoring methodology reviewed by a banking/compliance professional.
- Add Terms, Privacy, Corrections, Sources and Contact pages.
- Restrict CORS to your domain (currently `*`).
- Add rate limiting to public endpoints.
- Configure monitoring and D1 backups.
- Respect each source site's terms, robots directives and reasonable request rates.
