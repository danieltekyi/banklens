#!/usr/bin/env node
/**
 * BankLens local API smoke test.
 *
 * Exercises the admin CRUD surface, the pipeline sync contract and every public
 * analysis endpoint against a locally running dev server, then cleans up after
 * itself. Use it to certify a change before deploying.
 *
 *   npm run dev            # in one terminal (defaults to http://localhost:5173)
 *   npm run smoke          # in another
 *
 * Override the target and credentials with environment variables:
 *   BANKLENS_URL, BANKLENS_ADMIN_USERNAME, BANKLENS_ADMIN_PASSWORD
 */

const BASE = (process.env.BANKLENS_URL || "http://localhost:5173").replace(/\/$/, "");
const USERNAME = process.env.BANKLENS_ADMIN_USERNAME || "banklensadmin";
const PASSWORD = process.env.BANKLENS_ADMIN_PASSWORD || "TestPassw0rd!2026";

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    failures.push({ name, detail });
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

async function call(method, path, { token, body, expect } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Non-JSON responses are surfaced through `text` below.
  }
  if (expect !== undefined && res.status !== expect) {
    throw new Error(`${method} ${path} expected ${expect}, got ${res.status}: ${text.slice(0, 300)}`);
  }
  return { status: res.status, json, text };
}

async function main() {
  console.log(`BankLens smoke test against ${BASE}\n`);

  // ---------------------------------------------------------------- health
  console.log("Health and auth");
  const health = await call("GET", "/api/health", { expect: 200 });
  check("GET /api/health returns ok", health.json?.ok === true);

  const unauth = await call("GET", "/api/admin/countries");
  check("admin routes reject anonymous callers", unauth.status === 401, `got ${unauth.status}`);

  const login = await call("POST", "/api/auth/login", {
    body: { username: USERNAME, password: PASSWORD },
  });
  if (login.status !== 200 || !login.json?.token) {
    console.error(
      `\nCould not sign in as ${USERNAME}. Set BANKLENS_ADMIN_PASSWORD, or reset the local password first.\n` +
        `Response ${login.status}: ${login.text.slice(0, 300)}`,
    );
    process.exit(2);
  }
  const token = login.json.token;
  check("POST /api/auth/login issues a token", typeof token === "string" && token.length > 20);

  const badLogin = await call("POST", "/api/auth/login", {
    body: { username: USERNAME, password: "definitely-not-the-password" },
  });
  check("bad credentials are rejected", badLogin.status === 401, `got ${badLogin.status}`);

  // ------------------------------------------------------------- countries
  console.log("\nCountry lifecycle");
  const iso2 = "ZZ";
  // Remove any leftover from a previous interrupted run.
  const before = await call("GET", "/api/admin/countries", { token, expect: 200 });
  const stale = (before.json?.data || []).find((x) => x.iso2 === iso2);
  if (stale) await call("DELETE", `/api/admin/countries/${stale.id}?confirm=${iso2}`, { token });

  const created = await call("POST", "/api/admin/countries", {
    token,
    body: { name: "Smoketestia", iso2, currency: "smk" },
  });
  check("POST /api/admin/countries creates a country", created.status === 201, `got ${created.status}`);
  const countryId = created.json?.id;
  check("created country returns an id", Number.isInteger(countryId));

  const dupe = await call("POST", "/api/admin/countries", {
    token,
    body: { name: "Smoketestia again", iso2, currency: "SMK" },
  });
  check("duplicate ISO2 is rejected with 409", dupe.status === 409, `got ${dupe.status}`);

  // Partial update must not blank the fields it was not given.
  const renamed = await call("PATCH", `/api/admin/countries/${countryId}`, {
    token,
    body: { name: "Smoketestia Republic" },
    expect: 200,
  });
  check("PATCH country renames", renamed.json?.country?.name === "Smoketestia Republic");
  check(
    "PATCH country preserves currency",
    renamed.json?.country?.currency === "SMK",
    `got ${renamed.json?.country?.currency}`,
  );
  check("PATCH country preserves regulator", !!renamed.json?.country?.regulator_name);

  const toggled = await call("PATCH", `/api/admin/countries/${countryId}`, {
    token,
    body: { enabled: false },
    expect: 200,
  });
  check("PATCH country toggles enabled", toggled.json?.country?.enabled === 0);
  check("toggling enabled does not wipe the name", toggled.json?.country?.name === "Smoketestia Republic");
  await call("PATCH", `/api/admin/countries/${countryId}`, { token, body: { enabled: true }, expect: 200 });

  // ----------------------------------------------------------------- banks
  console.log("\nBank and portal lifecycle");
  const bankA = await call("POST", `/api/admin/countries/${countryId}/banks`, {
    token,
    body: { name: "Smoke Bank Alpha", sourceUrl: "https://example.com/alpha/financials" },
  });
  check("POST bank creates with a portal", bankA.status === 201, `got ${bankA.status}`);
  const bankAId = bankA.json?.bank?.id;

  const bankB = await call("POST", `/api/admin/countries/${countryId}/banks`, {
    token,
    body: { name: "Smoke Bank Beta", sourceUrl: "https://example.org/beta/reports" },
    expect: 201,
  });
  const bankBId = bankB.json?.bank?.id;

  const dupeBank = await call("POST", `/api/admin/countries/${countryId}/banks`, {
    token,
    body: { name: "Smoke Bank Alpha" },
  });
  check("duplicate bank slug is rejected with 409", dupeBank.status === 409, `got ${dupeBank.status}`);

  const bankDetail = await call("GET", `/api/admin/banks/${bankAId}`, { token, expect: 200 });
  check("GET admin bank returns the record", bankDetail.json?.bank?.name === "Smoke Bank Alpha");
  check("GET admin bank lists its portals", (bankDetail.json?.sources || []).length === 1);

  // The regression that motivated this: a partial PATCH used to null the
  // columns it was not given.
  const patchedBank = await call("PATCH", `/api/admin/banks/${bankAId}`, {
    token,
    body: { website: "https://alpha.example.com" },
    expect: 200,
  });
  check("PATCH bank sets website", patchedBank.json?.bank?.website === "https://alpha.example.com");
  check("PATCH bank preserves name when omitted", patchedBank.json?.bank?.name === "Smoke Bank Alpha");

  const renamedBank = await call("PATCH", `/api/admin/banks/${bankAId}`, {
    token,
    body: { name: "Smoke Bank Alpha PLC" },
    expect: 200,
  });
  check("PATCH bank renames", renamedBank.json?.bank?.name === "Smoke Bank Alpha PLC");
  check("PATCH bank preserves website when omitted", renamedBank.json?.bank?.website === "https://alpha.example.com");

  const emptyName = await call("PATCH", `/api/admin/banks/${bankAId}`, { token, body: { name: "  " } });
  check("PATCH bank rejects an empty name", emptyName.status === 400, `got ${emptyName.status}`);

  // --------------------------------------------------------------- sources
  const config = await call("GET", `/api/admin/countries/${countryId}/config`, { token, expect: 200 });
  const alphaSource = (config.json?.sources || []).find((s) => s.bank_id === bankAId);
  check("country config exposes the portal", !!alphaSource);

  const patchedSource = await call("PATCH", `/api/admin/sources/${alphaSource.id}`, {
    token,
    body: { url: "https://example.com/alpha/investor-relations" },
    expect: 200,
  });
  check(
    "PATCH source amends the URL",
    patchedSource.json?.source?.url === "https://example.com/alpha/investor-relations",
  );

  const badUrl = await call("PATCH", `/api/admin/sources/${alphaSource.id}`, { token, body: { url: "not a url" } });
  check("PATCH source rejects a malformed URL", badUrl.status === 400, `got ${badUrl.status}`);

  const emptyUrl = await call("PATCH", `/api/admin/sources/${alphaSource.id}`, { token, body: { url: "" } });
  check("PATCH source rejects an empty URL", emptyUrl.status === 400, `got ${emptyUrl.status}`);

  const extraSource = await call("POST", `/api/admin/banks/${bankAId}/sources`, {
    token,
    body: { url: "https://example.com/alpha/annual-reports" },
    expect: 201,
  });
  const extraSourceId = extraSource.json?.id;

  const clash = await call("PATCH", `/api/admin/sources/${extraSourceId}`, {
    token,
    body: { url: "https://example.com/alpha/investor-relations" },
  });
  check("PATCH source rejects a duplicate URL on the same bank", clash.status === 409, `got ${clash.status}`);

  const removed = await call("DELETE", `/api/admin/sources/${extraSourceId}`, { token, expect: 200 });
  check("DELETE source deactivates by default", removed.json?.mode === "deactivated");
  const afterRemove = await call("GET", `/api/admin/countries/${countryId}/config`, { token, expect: 200 });
  const removedRow = (afterRemove.json?.sources || []).find((s) => s.id === extraSourceId);
  check("deactivated portal is marked inactive", removedRow?.active === 0, `active=${removedRow?.active}`);

  // -------------------------------------------------------------- pipeline
  console.log("\nPipeline sync contract");
  const pipelineConfig = await call("GET", `/api/admin/pipeline/config?country=${iso2}`, { token, expect: 200 });
  check("pipeline config returns the country", (pipelineConfig.json?.countries || []).length === 1);
  check("pipeline config returns both banks", (pipelineConfig.json?.banks || []).length === 2);
  check(
    "pipeline config only lists active portals",
    (pipelineConfig.json?.sources || []).every((s) => s.active === 1),
  );

  const periodEnd = "2026-12-31";
  const makeRecords = (bankName, hash, values) =>
    Object.entries(values).map(([metric_key, value]) => ({
      bank_name: bankName,
      country_iso2: iso2,
      metric_key,
      metric_label: metric_key,
      value,
      raw_value: String(value),
      unit: ["capital_adequacy", "liquidity", "npl", "roe", "cost_to_income"].includes(metric_key)
        ? "percent"
        : "SMK_bn",
      currency: "SMK",
      source_url: `https://example.com/${hash}.pdf`,
      source_title: `${bankName} annual report 2026`,
      report_type: "annual",
      content_hash: hash,
      period_label: "FY 2026",
      reporting_period_start: "2026-01-01",
      reporting_period_end: periodEnd,
    }));

  const recordsA = makeRecords("Smoke Bank Alpha PLC", "hash-alpha-2026", {
    assets: 50,
    deposits: 38,
    profit: 2.4,
    capital_adequacy: 21,
    liquidity: 45,
    npl: 6,
    roe: 18,
    cost_to_income: 48,
  });
  const recordsB = makeRecords("Smoke Bank Beta", "hash-beta-2026", {
    assets: 20,
    deposits: 14,
    profit: 0.4,
    capital_adequacy: 14,
    liquidity: 31,
    npl: 17,
    roe: 6,
    cost_to_income: 72,
  });

  const sync = await call("POST", "/api/admin/pipeline/sync", {
    token,
    body: { country: { iso2 }, records: [...recordsA, ...recordsB] },
    expect: 200,
  });
  check(
    "pipeline sync inserts values",
    sync.json?.inserted === recordsA.length + recordsB.length,
    `inserted=${sync.json?.inserted}`,
  );
  check(
    "pipeline sync matched every bank",
    (sync.json?.unmatchedBanks || []).length === 0,
    JSON.stringify(sync.json?.unmatchedBanks),
  );

  const replay = await call("POST", "/api/admin/pipeline/sync", {
    token,
    body: { country: { iso2 }, records: [...recordsA, ...recordsB] },
    expect: 200,
  });
  check("pipeline sync is idempotent on replay", replay.json?.inserted === 0, `inserted=${replay.json?.inserted}`);

  const known = await call("GET", `/api/admin/pipeline/known-hashes?country=${iso2}`, { token, expect: 200 });
  check("known-hashes reports processed documents", (known.json?.hashes || []).includes("hash-alpha-2026"));

  const finalize = await call("POST", "/api/admin/pipeline/finalize", {
    token,
    body: {
      country: { iso2 },
      run: { run_at: new Date().toISOString(), reports_seen: 2, new_reports: 2, failures: [] },
    },
    expect: 200,
  });
  check("finalize updates both banks", finalize.json?.banksUpdated === 2, `banksUpdated=${finalize.json?.banksUpdated}`);
  check("finalize analyses both banks", finalize.json?.analysed === 2);

  // --------------------------------------------------------------- public
  console.log("\nPublic analysis endpoints");
  const catalog = await call("GET", "/api/metrics/catalog", { expect: 200 });
  check("metric catalog is served", (catalog.json?.data || []).length > 10);
  const nplDef = (catalog.json?.data || []).find((m) => m.key === "npl");
  check("NPL is flagged as lower-is-better", nplDef?.direction === "lower_is_better");

  const overview = await call("GET", `/api/overview?country=${countryId}`, { expect: 200 });
  check("overview counts banks", overview.json?.data?.banks === 2, `banks=${overview.json?.data?.banks}`);
  check("overview counts published values", overview.json?.data?.valuesPublished >= 16);

  const periods = await call("GET", `/api/periods?country=${countryId}`, { expect: 200 });
  check("periods lists the reporting year", (periods.json?.years || []).includes("2026"));

  const overall = await call("GET", `/api/rankings?country=${countryId}`, { expect: 200 });
  check("overall ranking returns both banks", (overall.json?.data || []).length === 2);
  check("stronger bank ranks first", overall.json?.data?.[0]?.slug === "smoke-bank-alpha", overall.json?.data?.[0]?.slug);
  check("ranking exposes best and worst", !!overall.json?.best?.length && !!overall.json?.worst?.length);
  check("ranking rows carry sources", (overall.json?.data?.[0]?.sources || []).length > 0);

  const nplRanking = await call("GET", `/api/rankings?country=${countryId}&metric=npl`, { expect: 200 });
  check(
    "lower-is-better metric ranks ascending",
    nplRanking.json?.data?.[0]?.value === 6,
    `first=${nplRanking.json?.data?.[0]?.value}`,
  );
  check("metric ranking cites a source", !!nplRanking.json?.data?.[0]?.sourceUrl);

  const assetRanking = await call("GET", `/api/rankings?country=${countryId}&metric=assets`, { expect: 200 });
  check(
    "higher-is-better metric ranks descending",
    assetRanking.json?.data?.[0]?.value === 50,
    `first=${assetRanking.json?.data?.[0]?.value}`,
  );

  const badMetric = await call("GET", `/api/rankings?country=${countryId}&metric=not_a_metric`);
  check("unknown metric is rejected", badMetric.status === 400, `got ${badMetric.status}`);

  const compare = await call("GET", "/api/compare?banks=smoke-bank-alpha,smoke-bank-beta", { expect: 200 });
  check("compare returns both banks", (compare.json?.data?.banks || []).length === 2);
  check("compare aligns metrics into rows", (compare.json?.data?.comparison || []).length >= 8);
  const nplRow = (compare.json?.data?.comparison || []).find((r) => r.metric.key === "npl");
  check("compare marks the leader on a lower-is-better metric", nplRow?.leader === "smoke-bank-alpha", nplRow?.leader);
  const assetRow = (compare.json?.data?.comparison || []).find((r) => r.metric.key === "assets");
  check("compare cells carry their source", !!assetRow?.cells?.[0]?.sourceUrl);

  const tooFew = await call("GET", "/api/compare?banks=smoke-bank-alpha");
  check("compare requires two banks", tooFew.status === 400, `got ${tooFew.status}`);

  const profile = await call("GET", "/api/banks/smoke-bank-alpha/profile", { expect: 200 });
  check("profile returns a strength score", typeof profile.json?.data?.score === "number");
  check("profile returns trend series", Array.isArray(profile.json?.data?.trends?.assets));
  check("profile trend points carry sources", !!profile.json?.data?.trends?.assets?.[0]?.sourceUrl);
  check("profile lists strengths", Array.isArray(profile.json?.data?.strengths));

  const reports = await call("GET", "/api/banks/smoke-bank-alpha/reports", { expect: 200 });
  check("reports endpoint lists source documents", (reports.json?.data || []).length >= 1);
  check("report rows expose the document URL", !!reports.json?.data?.[0]?.report_url);

  // -------------------------------------------------------------- products
  console.log("\nConsumer decision endpoints");
  await call("POST", `/api/admin/banks/${bankAId}/products`, {
    token,
    body: {
      productName: "Alpha Premium Savings",
      productType: "deposit",
      category: "savings",
      rate: 9.5,
      minAmount: 100,
      currency: "SMK",
      sourceUrl: "https://alpha.example.com/rates",
      sourceTitle: "Alpha published rate card",
    },
    expect: 201,
  });
  await call("POST", `/api/admin/banks/${bankBId}/products`, {
    token,
    body: {
      productName: "Beta Saver",
      productType: "deposit",
      category: "savings",
      rate: 12.0,
      minAmount: 50,
      currency: "SMK",
      sourceUrl: "https://beta.example.org/rates",
      sourceTitle: "Beta published rate card",
    },
    expect: 201,
  });
  const loanA = await call("POST", `/api/admin/banks/${bankAId}/products`, {
    token,
    body: {
      productName: "Alpha Personal Loan",
      productType: "credit",
      category: "personal_loan",
      rate: 22.0,
      tenorMonths: 36,
      currency: "SMK",
      sourceUrl: "https://alpha.example.com/loans",
      sourceTitle: "Alpha loan pricing",
    },
    expect: 201,
  });
  await call("POST", `/api/admin/banks/${bankBId}/products`, {
    token,
    body: {
      productName: "Beta Personal Loan",
      productType: "credit",
      category: "personal_loan",
      rate: 31.0,
      tenorMonths: 24,
      currency: "SMK",
      sourceUrl: "https://beta.example.org/loans",
      sourceTitle: "Beta loan pricing",
    },
    expect: 201,
  });

  const badType = await call("POST", `/api/admin/banks/${bankAId}/products`, {
    token,
    body: { productName: "Nonsense", productType: "wibble" },
  });
  check("invalid product type is rejected", badType.status === 400, `got ${badType.status}`);

  const products = await call("GET", `/api/products?country=${countryId}`, { expect: 200 });
  check("products endpoint lists rate cards", (products.json?.data || []).length === 4);

  const deposit = await call("GET", `/api/recommend?need=deposit&country=${countryId}`, { expect: 200 });
  check("deposit recommendation returns both options", (deposit.json?.data || []).length === 2);
  check("deposit recommendation cites the rate card", !!deposit.json?.data?.[0]?.sourceUrl);
  check("deposit recommendation explains itself", (deposit.json?.data?.[0]?.reasons || []).length >= 2);

  const credit = await call("GET", `/api/recommend?need=credit&country=${countryId}`, { expect: 200 });
  check(
    "credit recommendation prefers the cheaper, stronger bank",
    credit.json?.data?.[0]?.bankSlug === "smoke-bank-alpha",
    credit.json?.data?.[0]?.bankSlug,
  );

  const filtered = await call("GET", `/api/recommend?need=deposit&country=${countryId}&amount=75`, { expect: 200 });
  check(
    "amount filter excludes products above the customer's balance",
    (filtered.json?.data || []).length === 1,
    `count=${filtered.json?.data?.length}`,
  );

  const badNeed = await call("GET", `/api/recommend?need=holiday&country=${countryId}`);
  check("invalid need is rejected", badNeed.status === 400, `got ${badNeed.status}`);

  const patchedProduct = await call("PATCH", `/api/admin/products/${loanA.json.product.id}`, {
    token,
    body: { rate: 19.5 },
    expect: 200,
  });
  check("PATCH product updates the rate", patchedProduct.json?.product?.rate === 19.5);
  check("PATCH product preserves the name", patchedProduct.json?.product?.product_name === "Alpha Personal Loan");

  const deletedProduct = await call("DELETE", `/api/admin/products/${loanA.json.product.id}`, { token, expect: 200 });
  check("DELETE product removes it", deletedProduct.json?.ok === true);

  // --------------------------------------------------------- cascade delete
  console.log("\nCascade delete");
  const deletedBank = await call("DELETE", `/api/admin/banks/${bankBId}`, { token, expect: 200 });
  check("DELETE bank reports what it removed", deletedBank.json?.bankName === "Smoke Bank Beta");
  check(
    "DELETE bank removed its values",
    deletedBank.json?.recordsDeleted === 8,
    `records=${deletedBank.json?.recordsDeleted}`,
  );
  check("DELETE bank removed its portals", deletedBank.json?.sourcesDeleted >= 1);
  check(
    "DELETE bank removed its products",
    deletedBank.json?.productsDeleted === 2,
    `products=${deletedBank.json?.productsDeleted}`,
  );

  const missingBank = await call("DELETE", `/api/admin/banks/${bankBId}`, { token });
  check("deleting a missing bank returns 404", missingBank.status === 404, `got ${missingBank.status}`);

  const afterDelete = await call("GET", `/api/overview?country=${countryId}`, { expect: 200 });
  check("overview reflects the deletion", afterDelete.json?.data?.banks === 1, `banks=${afterDelete.json?.data?.banks}`);

  const orphanCompare = await call("GET", "/api/compare?banks=smoke-bank-alpha,smoke-bank-beta");
  check("compare no longer resolves the deleted bank", (orphanCompare.json?.data?.banks || []).length === 1);

  // Country delete must refuse to silently take banks with it.
  const guarded = await call("DELETE", `/api/admin/countries/${countryId}`, { token });
  check("country delete refuses without confirmation", guarded.status === 409, `got ${guarded.status}`);

  const deletedCountry = await call("DELETE", `/api/admin/countries/${countryId}?confirm=${iso2}`, {
    token,
    expect: 200,
  });
  check("confirmed country delete succeeds", deletedCountry.json?.ok === true);
  check("country delete reports the banks removed", deletedCountry.json?.banksDeleted === 1);

  const gone = await call("GET", "/api/banks/smoke-bank-alpha/profile");
  check("deleted bank is no longer readable", gone.status === 404, `got ${gone.status}`);

  const auditLog = await call("GET", "/api/admin/audit-log?limit=20", { token, expect: 200 });
  check(
    "destructive actions are recorded in the audit log",
    (auditLog.json?.data || []).some((r) => r.action === "delete"),
  );

  // ---------------------------------------------------------------- result
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ""}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\nSmoke test aborted:", err.message);
  process.exit(2);
});
