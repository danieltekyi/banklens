import type { Hono } from "hono";
import type { AppEnv } from "../env";
import {
  METRIC_CATALOG,
  metricDefinition,
  latestByBankAndMetric,
  scoreBanks,
  orderForMetric,
} from "../analysis";

type Env = AppEnv;

const FROM_DEFAULT = "1900-01-01";
const TO_DEFAULT = "2999-12-31";

function windowFrom(c: any) {
  const year = c.req.query("year");
  if (year && /^\d{4}$/.test(year)) return { from: `${year}-01-01`, to: `${year}-12-31` };
  return { from: c.req.query("from") || FROM_DEFAULT, to: c.req.query("to") || TO_DEFAULT };
}

/** Published records for a country (or all countries) inside a reporting window. */
async function publishedRecords(db: D1Database, countryId: number | undefined, from: string, to: string) {
  const sql = `SELECT fr.bank_id,fr.metric_key,fr.metric_label,fr.value,fr.unit,fr.currency,
      fr.period_label,fr.reporting_period_start,fr.reporting_period_end,fr.source_url,fr.source_title,
      b.slug,b.name bank_name,b.short_name,b.color,c.id country_id,c.name country_name,c.currency country_currency
    FROM financial_records fr
    JOIN banks b ON b.id=fr.bank_id
    JOIN countries c ON c.id=b.country_id
    WHERE fr.status='published' AND b.active=1
      AND fr.value IS NOT NULL
      AND COALESCE(fr.reporting_period_end,'9999-12-31') BETWEEN ? AND ?
      ${countryId ? "AND b.country_id=?" : ""}
    ORDER BY fr.reporting_period_end ASC,fr.id ASC`;
  const stmt = countryId ? db.prepare(sql).bind(from, to, countryId) : db.prepare(sql).bind(from, to);
  const { results } = await stmt.all<any>();
  return results ?? [];
}

export function registerPublicApi(app: Hono<Env>) {
  /** The metric dictionary the whole product is built on, including which
   *  direction counts as "good". The UI uses this to label and colour figures. */
  app.get("/api/metrics/catalog", (c) => c.json({ data: METRIC_CATALOG }));

  /** Reporting periods that actually have published data, for period pickers. */
  app.get("/api/periods", async (c) => {
    const countryId = c.req.query("country") ? Number(c.req.query("country")) : undefined;
    const sql = `SELECT DISTINCT fr.period_label,fr.reporting_period_end,
        substr(COALESCE(fr.reporting_period_end,''),1,4) year
      FROM financial_records fr JOIN banks b ON b.id=fr.bank_id
      WHERE fr.status='published' AND b.active=1 AND fr.reporting_period_end IS NOT NULL
      ${countryId ? "AND b.country_id=?" : ""}
      ORDER BY fr.reporting_period_end DESC`;
    const stmt = countryId ? c.env.DB.prepare(sql).bind(countryId) : c.env.DB.prepare(sql);
    const { results } = await stmt.all<any>();
    const years = [...new Set((results ?? []).map((r: any) => r.year).filter(Boolean))];
    return c.json({ data: results ?? [], years });
  });

  /**
   * Best and worst performing banks for a metric, within a reporting window.
   * Every row carries the source document so a ranking can be challenged.
   */
  app.get("/api/rankings", async (c) => {
    const countryId = c.req.query("country") ? Number(c.req.query("country")) : undefined;
    const { from, to } = windowFrom(c);
    const requested = c.req.query("metric");
    const rows = await publishedRecords(c.env.DB, countryId, from, to);

    if (!rows.length) {
      return c.json({ data: [], meta: { from, to, metric: requested ?? null, empty: true } });
    }

    const bankMeta = new Map<number, any>();
    for (const r of rows) {
      if (!bankMeta.has(Number(r.bank_id))) {
        bankMeta.set(Number(r.bank_id), {
          bankId: Number(r.bank_id),
          slug: r.slug,
          name: r.bank_name,
          shortName: r.short_name,
          color: r.color,
          countryId: Number(r.country_id),
          countryName: r.country_name,
          currency: r.country_currency,
        });
      }
    }
    const latest = latestByBankAndMetric(rows);

    // A single named metric: straight league table for that metric.
    if (requested && requested !== "overall") {
      const def = metricDefinition(requested);
      if (!def) return c.json({ error: `Unknown metric "${requested}"` }, 400);
      const entries: any[] = [];
      for (const [bankId, values] of latest.entries()) {
        const hit = values.find((v) => v.metric_key === requested);
        if (!hit) continue;
        entries.push({
          ...bankMeta.get(bankId),
          value: hit.value,
          unit: hit.unit,
          periodLabel: hit.period_label,
          reportingPeriodEnd: hit.reporting_period_end,
          sourceUrl: hit.source_url,
          sourceTitle: hit.source_title,
        });
      }
      entries.sort(orderForMetric(def.direction));
      const ranked = entries.map((x, i) => ({ ...x, rank: i + 1 }));
      return c.json({
        data: ranked,
        best: ranked.slice(0, 3),
        worst: ranked.slice(-3).reverse(),
        meta: { metric: def, from, to, count: ranked.length },
      });
    }

    // Overall: composite strength score across the peer group.
    const scores = scoreBanks(latest);
    const entries = [...scores.values()]
      .map((s) => ({
        ...bankMeta.get(s.bankId),
        value: s.score,
        unit: "score",
        coverage: s.coverage,
        components: s.components,
        strengths: s.strengths,
        weaknesses: s.weaknesses,
        sources: [
          ...new Map(
            s.components
              .filter((x) => x.sourceUrl)
              .map((x) => [x.sourceUrl, { url: x.sourceUrl, title: x.sourceTitle, metric: x.label }]),
          ).values(),
        ],
      }))
      .sort((a, b) => b.value - a.value)
      .map((x, i) => ({ ...x, rank: i + 1 }));

    return c.json({
      data: entries,
      best: entries.slice(0, 3),
      worst: entries.slice(-3).reverse(),
      meta: {
        metric: { key: "overall", label: "Overall financial strength", unit: "score", direction: "higher_is_better" },
        from,
        to,
        count: entries.length,
        methodology:
          "Weighted average of each bank's percentile rank against its peers, computed only from values extracted from published statutory reports.",
      },
    });
  });

  /**
   * Side-by-side comparison of two or more banks, aligned on metric key so the
   * UI can render a single table with one row per metric.
   */
  app.get("/api/compare", async (c) => {
    const slugs = (c.req.query("banks") || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (slugs.length < 2) return c.json({ error: "Provide at least two bank slugs, e.g. ?banks=gcb-bank,absa-bank-ghana" }, 400);
    if (slugs.length > 6) return c.json({ error: "Compare at most six banks at a time" }, 400);

    const placeholders = slugs.map(() => "?").join(",");
    const { results: banks } = await c.env.DB.prepare(
      `SELECT b.id,b.slug,b.name,b.short_name,b.color,b.website,b.summary,c.name country_name,c.currency
       FROM banks b JOIN countries c ON c.id=b.country_id
       WHERE b.slug IN (${placeholders}) AND b.active=1`,
    )
      .bind(...slugs)
      .all<any>();
    if (!banks?.length) return c.json({ error: "No matching banks" }, 404);

    const { from, to } = windowFrom(c);
    const ids = banks.map((b: any) => Number(b.id));
    const idPlaceholders = ids.map(() => "?").join(",");
    const { results: rows } = await c.env.DB.prepare(
      `SELECT bank_id,metric_key,metric_label,value,unit,currency,period_label,reporting_period_end,source_url,source_title
       FROM financial_records
       WHERE status='published' AND value IS NOT NULL AND bank_id IN (${idPlaceholders})
         AND COALESCE(reporting_period_end,'9999-12-31') BETWEEN ? AND ?
       ORDER BY reporting_period_end ASC,id ASC`,
    )
      .bind(...ids, from, to)
      .all<any>();

    const latest = latestByBankAndMetric(rows ?? []);
    const scores = scoreBanks(latest);

    const metricKeys = [...new Set((rows ?? []).map((r: any) => r.metric_key))];
    const ordered = METRIC_CATALOG.filter((m) => metricKeys.includes(m.key));

    const comparison = ordered.map((def) => {
      const cells = banks.map((bank: any) => {
        const hit = latest.get(Number(bank.id))?.find((v) => v.metric_key === def.key);
        return {
          bankId: Number(bank.id),
          slug: bank.slug,
          value: hit?.value ?? null,
          unit: hit?.unit ?? null,
          periodLabel: hit?.period_label ?? null,
          reportingPeriodEnd: hit?.reporting_period_end ?? null,
          sourceUrl: hit?.source_url ?? null,
          sourceTitle: hit?.source_title ?? null,
        };
      });
      const present = cells.filter((x) => x.value !== null) as Array<{ value: number; slug: string }>;
      let leader: string | null = null;
      if (present.length > 1 && def.direction !== "neutral") {
        leader = [...present].sort(orderForMetric(def.direction))[0].slug;
      }
      return { metric: def, cells, leader };
    });

    return c.json({
      data: {
        banks: banks.map((b: any) => ({
          bankId: Number(b.id),
          slug: b.slug,
          name: b.name,
          shortName: b.short_name,
          color: b.color,
          website: b.website,
          summary: b.summary,
          countryName: b.country_name,
          currency: b.currency,
          score: scores.get(Number(b.id))?.score ?? null,
          coverage: scores.get(Number(b.id))?.coverage ?? 0,
          strengths: scores.get(Number(b.id))?.strengths ?? [],
          weaknesses: scores.get(Number(b.id))?.weaknesses ?? [],
        })),
        comparison,
      },
      meta: { from, to, metricCount: ordered.length },
    });
  });

  /** Every source document held for a bank, so any figure can be traced. */
  app.get("/api/banks/:slug/reports", async (c) => {
    const bank = await c.env.DB.prepare("SELECT id,name,slug FROM banks WHERE slug=? AND active=1")
      .bind(c.req.param("slug"))
      .first<any>();
    if (!bank) return c.json({ error: "Bank not found" }, 404);
    const { results } = await c.env.DB.prepare(
      `SELECT d.id,d.report_title,d.report_url,d.report_type,d.period_label,d.reporting_period_start,
        d.reporting_period_end,d.processed_at,d.downloaded_at,d.status,d.content_type,
        s.url portal_url,
        (SELECT COUNT(*) FROM financial_records fr
          WHERE fr.source_id=d.source_id AND fr.source_url=d.report_url AND fr.status='published') value_count
       FROM financial_documents d LEFT JOIN sources s ON s.id=d.source_id
       WHERE d.bank_id=? ORDER BY COALESCE(d.reporting_period_end,d.created_at) DESC LIMIT 200`,
    )
      .bind(bank.id)
      .all<any>();
    return c.json({ data: results ?? [], meta: { bankId: bank.id, bankName: bank.name } });
  });

  /**
   * Full public profile: latest values with citations, peer-relative strength
   * score, strengths and weaknesses, and the metric history for trend charts.
   */
  app.get("/api/banks/:slug/profile", async (c) => {
    const slug = c.req.param("slug");
    const bank = await c.env.DB.prepare(
      `SELECT b.*,c.id country_id,c.name country_name,c.currency,c.regulator_name
       FROM banks b JOIN countries c ON c.id=b.country_id WHERE b.slug=? AND b.active=1`,
    )
      .bind(slug)
      .first<any>();
    if (!bank) return c.json({ error: "Bank not found" }, 404);

    // Peer group = every active bank in the same country. The score is only
    // meaningful relative to the market the customer is actually choosing from.
    const peerRows = await publishedRecords(c.env.DB, Number(bank.country_id), FROM_DEFAULT, TO_DEFAULT);
    const latest = latestByBankAndMetric(peerRows);
    const scores = scoreBanks(latest);
    const mine = scores.get(Number(bank.id));

    const { results: history } = await c.env.DB.prepare(
      `SELECT metric_key,metric_label,value,unit,currency,period_label,
        reporting_period_start,reporting_period_end,source_url,source_title
       FROM financial_records
       WHERE bank_id=? AND status='published' AND value IS NOT NULL
       ORDER BY reporting_period_end ASC,metric_key ASC`,
    )
      .bind(bank.id)
      .all<any>();

    const { results: products } = await c.env.DB.prepare(
      "SELECT * FROM bank_products WHERE bank_id=? AND status='published' ORDER BY product_type,rate DESC",
    )
      .bind(bank.id)
      .all<any>();

    const trends: Record<string, any[]> = {};
    for (const row of history ?? []) {
      (trends[row.metric_key] ??= []).push({
        value: Number(row.value),
        unit: row.unit,
        periodLabel: row.period_label,
        periodEnd: row.reporting_period_end,
        sourceUrl: row.source_url,
        sourceTitle: row.source_title,
      });
    }

    // Period-on-period movement for each metric, computed from the two most
    // recent distinct reporting periods we hold.
    const movement: Record<string, { change: number; changePercent: number | null; from: string; to: string }> = {};
    for (const [key, series] of Object.entries(trends)) {
      if (series.length < 2) continue;
      const last = series[series.length - 1];
      const prev = series[series.length - 2];
      const change = last.value - prev.value;
      movement[key] = {
        change,
        changePercent: prev.value !== 0 ? (change / Math.abs(prev.value)) * 100 : null,
        from: prev.periodLabel ?? prev.periodEnd,
        to: last.periodLabel ?? last.periodEnd,
      };
    }

    return c.json({
      data: {
        bankId: Number(bank.id),
        slug: bank.slug,
        name: bank.name,
        shortName: bank.short_name,
        color: bank.color,
        website: bank.website,
        summary: bank.summary,
        countryName: bank.country_name,
        currency: bank.currency,
        regulator: bank.regulator_name,
        score: mine?.score ?? null,
        coverage: mine?.coverage ?? 0,
        components: mine?.components ?? [],
        strengths: mine?.strengths ?? [],
        weaknesses: mine?.weaknesses ?? [],
        trends,
        movement,
        products: products ?? [],
        peerCount: scores.size,
      },
    });
  });

  /** Published rate cards and product terms, with their citations. */
  app.get("/api/products", async (c) => {
    const countryId = c.req.query("country") ? Number(c.req.query("country")) : undefined;
    const type = c.req.query("type");
    const params: any[] = [];
    let sql = `SELECT p.*,b.slug bank_slug,b.name bank_name,b.short_name,b.color,c.name country_name,c.currency country_currency
      FROM bank_products p JOIN banks b ON b.id=p.bank_id JOIN countries c ON c.id=b.country_id
      WHERE p.status='published' AND b.active=1`;
    if (countryId) {
      sql += " AND b.country_id=?";
      params.push(countryId);
    }
    if (type) {
      sql += " AND p.product_type=?";
      params.push(type);
    }
    sql += " ORDER BY p.product_type,p.category,p.rate DESC";
    const { results } = await c.env.DB.prepare(sql)
      .bind(...params)
      .all<any>();
    return c.json({ data: results ?? [] });
  });

  /**
   * Consumer decision helper.
   *
   * `need=deposit` ranks by the highest rate the customer would earn.
   * `need=credit` ranks by the lowest rate the customer would pay.
   * Financial strength is folded in as a secondary factor so the answer is not
   * simply "whichever bank quotes the most aggressive number".
   */
  app.get("/api/recommend", async (c) => {
    const need = (c.req.query("need") || "deposit").toLowerCase();
    if (!["deposit", "credit"].includes(need)) {
      return c.json({ error: 'need must be "deposit" or "credit"' }, 400);
    }
    const countryId = c.req.query("country") ? Number(c.req.query("country")) : undefined;
    const category = c.req.query("category");
    const amount = c.req.query("amount") ? Number(c.req.query("amount")) : undefined;
    const tenor = c.req.query("tenor") ? Number(c.req.query("tenor")) : undefined;

    const params: any[] = [need];
    let sql = `SELECT p.*,b.id bank_id,b.slug bank_slug,b.name bank_name,b.short_name,b.color,
        c.name country_name,c.currency country_currency
      FROM bank_products p JOIN banks b ON b.id=p.bank_id JOIN countries c ON c.id=b.country_id
      WHERE p.status='published' AND b.active=1 AND p.product_type=? AND p.rate IS NOT NULL`;
    if (countryId) {
      sql += " AND b.country_id=?";
      params.push(countryId);
    }
    if (category) {
      sql += " AND p.category=?";
      params.push(category);
    }
    if (amount !== undefined && Number.isFinite(amount)) {
      sql += " AND (p.min_amount IS NULL OR p.min_amount<=?) AND (p.max_amount IS NULL OR p.max_amount>=?)";
      params.push(amount, amount);
    }
    if (tenor !== undefined && Number.isFinite(tenor)) {
      sql += " AND (p.tenor_months IS NULL OR p.tenor_months>=?)";
      params.push(tenor);
    }
    const { results: products } = await c.env.DB.prepare(sql)
      .bind(...params)
      .all<any>();

    if (!products?.length) {
      return c.json({
        data: [],
        meta: {
          need,
          empty: true,
          message:
            "No published rate cards match those filters yet. An administrator adds product terms and their source in the BankLens admin console.",
        },
      });
    }

    // Peer-relative financial strength for the banks that appear in the results.
    const countryIds = [...new Set(products.map((p: any) => Number(p.bank_id)))];
    const idPlaceholders = countryIds.map(() => "?").join(",");
    const { results: rows } = await c.env.DB.prepare(
      `SELECT bank_id,metric_key,value,unit,period_label,reporting_period_end,source_url,source_title
       FROM financial_records WHERE status='published' AND value IS NOT NULL AND bank_id IN (${idPlaceholders})
       ORDER BY reporting_period_end ASC,id ASC`,
    )
      .bind(...countryIds)
      .all<any>();
    const scores = scoreBanks(latestByBankAndMetric(rows ?? []));

    const rates = products.map((p: any) => Number(p.rate));
    const minRate = Math.min(...rates);
    const maxRate = Math.max(...rates);
    const spread = maxRate - minRate;

    const ranked = products
      .map((p: any) => {
        const rate = Number(p.rate);
        // Rate score: for a deposit the customer wants the highest rate, for
        // credit the lowest. Normalised across the matching product set.
        const rateScore =
          spread === 0 ? 50 : Math.round(((need === "deposit" ? rate - minRate : maxRate - rate) / spread) * 100);
        const strength = scores.get(Number(p.bank_id))?.score ?? 50;
        // Price dominates the decision, but a materially weaker bank should not
        // win purely on headline rate.
        const total = Math.round(rateScore * 0.7 + strength * 0.3);
        const reasons: string[] = [];
        reasons.push(
          need === "deposit"
            ? `Pays ${rate}% on ${p.product_name}.`
            : `Charges ${rate}% on ${p.product_name}.`,
        );
        if (p.fee != null) reasons.push(`Fee of ${p.fee}${p.fee_note ? ` (${p.fee_note})` : ""}.`);
        if (p.min_amount != null) reasons.push(`Minimum ${p.currency ?? p.country_currency ?? ""} ${p.min_amount}.`);
        if (p.tenor_months != null) reasons.push(`Available over ${p.tenor_months} months.`);
        reasons.push(
          strength >= 60
            ? "Financial strength is above its peer group average."
            : strength <= 40
              ? "Financial strength trails its peer group — weigh this against the rate."
              : "Financial strength is around its peer group average.",
        );
        return {
          productId: Number(p.id),
          bankId: Number(p.bank_id),
          bankSlug: p.bank_slug,
          bankName: p.bank_name,
          shortName: p.short_name,
          color: p.color,
          countryName: p.country_name,
          productName: p.product_name,
          productType: p.product_type,
          category: p.category,
          rate,
          rateNote: p.rate_note,
          fee: p.fee,
          feeNote: p.fee_note,
          minAmount: p.min_amount,
          maxAmount: p.max_amount,
          tenorMonths: p.tenor_months,
          eligibility: p.eligibility,
          currency: p.currency ?? p.country_currency,
          effectiveDate: p.effective_date,
          sourceUrl: p.source_url,
          sourceTitle: p.source_title,
          rateScore,
          strengthScore: strength,
          matchScore: total,
          reasons,
        };
      })
      .sort((a: any, b: any) => b.matchScore - a.matchScore)
      .map((x: any, i: number) => ({ ...x, rank: i + 1 }));

    return c.json({
      data: ranked,
      meta: {
        need,
        category: category ?? null,
        amount: amount ?? null,
        tenor: tenor ?? null,
        count: ranked.length,
        methodology:
          "Ranked 70% on the rate the customer receives or pays and 30% on the bank's peer-relative financial strength. Every rate links to the bank's own published source.",
      },
    });
  });

  /** Headline numbers for the landing page. */
  app.get("/api/overview", async (c) => {
    const countryId = c.req.query("country") ? Number(c.req.query("country")) : undefined;
    const scope = countryId ? "AND b.country_id=?" : "";
    const bind = countryId ? [countryId] : [];
    const summary = await c.env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM banks b WHERE b.active=1 ${scope}) banks,
        (SELECT COUNT(*) FROM financial_documents d JOIN banks b ON b.id=d.bank_id WHERE d.status='published' ${scope}) reports,
        (SELECT COUNT(*) FROM financial_records fr JOIN banks b ON b.id=fr.bank_id WHERE fr.status='published' ${scope}) values_published,
        (SELECT MAX(fr.reporting_period_end) FROM financial_records fr JOIN banks b ON b.id=fr.bank_id WHERE fr.status='published' ${scope}) latest_period`,
    )
      .bind(...bind, ...bind, ...bind, ...bind)
      .first<any>();

    const { results: countries } = await c.env.DB.prepare(
      "SELECT id,name,iso2,currency FROM countries WHERE enabled=1 ORDER BY name",
    ).all<any>();

    return c.json({
      data: {
        banks: Number(summary?.banks ?? 0),
        reports: Number(summary?.reports ?? 0),
        valuesPublished: Number(summary?.values_published ?? 0),
        latestPeriod: summary?.latest_period ?? null,
        countries: countries ?? [],
      },
    });
  });
}
