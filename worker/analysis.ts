/**
 * Deterministic financial analysis for BankLens.
 *
 * Everything in this module is pure arithmetic over values that were extracted
 * from published statutory reports. No model, no inference, no external call.
 * Each derived number can be traced back to the source document that produced
 * its inputs, which is what lets the public site cite a source for every figure.
 */

export type MetricDirection = "higher_is_better" | "lower_is_better" | "neutral";

export type MetricDefinition = {
  key: string;
  label: string;
  unit: "amount" | "percent";
  direction: MetricDirection;
  group: "scale" | "performance" | "resilience" | "efficiency";
  description: string;
  /** Relative weight inside the composite strength score. 0 = excluded. */
  weight: number;
};

export const METRIC_CATALOG: MetricDefinition[] = [
  {
    key: "assets",
    label: "Total assets",
    unit: "amount",
    direction: "higher_is_better",
    group: "scale",
    description: "Everything the bank owns. The standard measure of how large a bank is.",
    weight: 0.5,
  },
  {
    key: "deposits",
    label: "Customer deposits",
    unit: "amount",
    direction: "higher_is_better",
    group: "scale",
    description: "Money customers have placed with the bank. A large, stable deposit base is cheap funding.",
    weight: 0.5,
  },
  {
    key: "loans",
    label: "Loans and advances",
    unit: "amount",
    direction: "neutral",
    group: "scale",
    description: "Credit extended to customers.",
    weight: 0,
  },
  {
    key: "equity",
    label: "Total equity",
    unit: "amount",
    direction: "higher_is_better",
    group: "resilience",
    description: "Shareholders' own funds, the first buffer against losses.",
    weight: 0.5,
  },
  {
    key: "liabilities",
    label: "Total liabilities",
    unit: "amount",
    direction: "neutral",
    group: "scale",
    description: "Everything the bank owes.",
    weight: 0,
  },
  {
    key: "profit",
    label: "Profit after tax",
    unit: "amount",
    direction: "higher_is_better",
    group: "performance",
    description: "What the bank earned after tax over the reporting period.",
    weight: 1,
  },
  {
    key: "revenue",
    label: "Total income",
    unit: "amount",
    direction: "higher_is_better",
    group: "performance",
    description: "Total operating income before costs.",
    weight: 0.25,
  },
  {
    key: "net_interest_income",
    label: "Net interest income",
    unit: "amount",
    direction: "higher_is_better",
    group: "performance",
    description: "Interest earned on lending less interest paid on deposits and borrowings.",
    weight: 0.25,
  },
  {
    key: "impairment",
    label: "Credit impairment charge",
    unit: "amount",
    direction: "lower_is_better",
    group: "resilience",
    description: "Amount written off or provided against loans expected to go bad.",
    weight: 0.5,
  },
  {
    key: "capital_adequacy",
    label: "Capital adequacy ratio",
    unit: "percent",
    direction: "higher_is_better",
    group: "resilience",
    description: "Capital held against risk-weighted assets. Regulators set a floor; higher means more shock absorption.",
    weight: 2,
  },
  {
    key: "liquidity",
    label: "Liquidity ratio",
    unit: "percent",
    direction: "higher_is_better",
    group: "resilience",
    description: "Ability to meet withdrawals and obligations without selling long-term assets at a loss.",
    weight: 1.5,
  },
  {
    key: "npl",
    label: "Non-performing loan ratio",
    unit: "percent",
    direction: "lower_is_better",
    group: "resilience",
    description: "Share of the loan book that is not being repaid on schedule. Lower is healthier.",
    weight: 2,
  },
  {
    key: "roe",
    label: "Return on equity",
    unit: "percent",
    direction: "higher_is_better",
    group: "performance",
    description: "Profit generated per unit of shareholder capital.",
    weight: 1.5,
  },
  {
    key: "roa",
    label: "Return on assets",
    unit: "percent",
    direction: "higher_is_better",
    group: "performance",
    description: "Profit generated per unit of total assets.",
    weight: 1,
  },
  {
    key: "cost_to_income",
    label: "Cost-to-income ratio",
    unit: "percent",
    direction: "lower_is_better",
    group: "efficiency",
    description: "Operating costs as a share of income. Lower means a more efficient bank.",
    weight: 1.5,
  },
  {
    key: "net_interest_margin",
    label: "Net interest margin",
    unit: "percent",
    direction: "higher_is_better",
    group: "efficiency",
    description: "Net interest income relative to earning assets.",
    weight: 1,
  },
];

export const METRIC_BY_KEY = new Map(METRIC_CATALOG.map((m) => [m.key, m]));

export function metricDefinition(key: string) {
  return METRIC_BY_KEY.get(key);
}

/**
 * Rank a value within its peer group and convert to a 0..100 score, honouring
 * the metric's direction. With a single peer the score is a neutral 50, because
 * a percentile is meaningless without comparators.
 */
export function percentileScore(value: number, peers: number[], direction: MetricDirection) {
  const clean = peers.filter((x) => Number.isFinite(x));
  if (clean.length < 2 || !Number.isFinite(value)) return 50;
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  if (max === min) return 50;
  const normalised = (value - min) / (max - min);
  const oriented = direction === "lower_is_better" ? 1 - normalised : normalised;
  return Math.round(Math.max(0, Math.min(1, oriented)) * 100);
}

export type MetricValue = {
  metric_key: string;
  value: number;
  unit?: string | null;
  period_label?: string | null;
  reporting_period_end?: string | null;
  source_url?: string | null;
  source_title?: string | null;
};

export type BankScore = {
  bankId: number;
  score: number;
  coverage: number;
  components: Array<{
    key: string;
    label: string;
    value: number;
    unit: string;
    score: number;
    weight: number;
    direction: MetricDirection;
    sourceUrl: string | null;
    sourceTitle: string | null;
    periodLabel: string | null;
  }>;
  strengths: string[];
  weaknesses: string[];
};

/**
 * Composite financial-strength score for every bank in a peer group.
 *
 * The score is a weighted average of per-metric percentile scores against the
 * other banks in the same group, so it answers "how does this bank compare with
 * its peers" rather than inventing an absolute standard. `coverage` reports how
 * much of the available weight was actually backed by data, so the UI can warn
 * when a score rests on thin reporting.
 */
export function scoreBanks(byBank: Map<number, MetricValue[]>): Map<number, BankScore> {
  const peerValues = new Map<string, number[]>();
  for (const values of byBank.values()) {
    for (const v of values) {
      if (!Number.isFinite(v.value)) continue;
      const def = METRIC_BY_KEY.get(v.metric_key);
      if (!def || def.weight === 0) continue;
      const list = peerValues.get(v.metric_key) ?? [];
      list.push(v.value);
      peerValues.set(v.metric_key, list);
    }
  }

  const totalPossibleWeight = METRIC_CATALOG.filter((m) => m.weight > 0).reduce((n, m) => n + m.weight, 0);
  const out = new Map<number, BankScore>();

  for (const [bankId, values] of byBank.entries()) {
    const components: BankScore["components"] = [];
    let weighted = 0;
    let usedWeight = 0;

    for (const v of values) {
      const def = METRIC_BY_KEY.get(v.metric_key);
      if (!def || def.weight === 0 || !Number.isFinite(v.value)) continue;
      const score = percentileScore(v.value, peerValues.get(v.metric_key) ?? [], def.direction);
      weighted += score * def.weight;
      usedWeight += def.weight;
      components.push({
        key: def.key,
        label: def.label,
        value: v.value,
        unit: v.unit ?? (def.unit === "percent" ? "percent" : "amount"),
        score,
        weight: def.weight,
        direction: def.direction,
        sourceUrl: v.source_url ?? null,
        sourceTitle: v.source_title ?? null,
        periodLabel: v.period_label ?? null,
      });
    }

    const score = usedWeight > 0 ? Math.round(weighted / usedWeight) : 0;
    const ranked = [...components].sort((a, b) => b.score - a.score);
    const strengths = ranked
      .filter((x) => x.score >= 60)
      .slice(0, 4)
      .map((x) => `${x.label} ranks in the top tier of its peer group.`);
    const weaknesses = ranked
      .filter((x) => x.score <= 40)
      .slice(-4)
      .map((x) => `${x.label} trails its peer group and is worth checking before committing funds.`);

    out.set(bankId, {
      bankId,
      score,
      coverage: totalPossibleWeight > 0 ? Math.round((usedWeight / totalPossibleWeight) * 100) : 0,
      components,
      strengths,
      weaknesses,
    });
  }

  return out;
}

/**
 * Collapse a flat list of published records into the most recent value per
 * metric per bank, preserving the citation that produced it.
 */
export function latestByBankAndMetric(rows: any[]) {
  const byBank = new Map<number, MetricValue[]>();
  const seen = new Map<string, string>();
  for (const row of rows) {
    const bankId = Number(row.bank_id);
    const key = `${bankId}:${row.metric_key}`;
    const periodEnd = String(row.reporting_period_end ?? "");
    const previous = seen.get(key);
    if (previous !== undefined && previous >= periodEnd) continue;
    seen.set(key, periodEnd);
    const list = byBank.get(bankId) ?? [];
    const existingIndex = list.findIndex((x) => x.metric_key === row.metric_key);
    const value: MetricValue = {
      metric_key: row.metric_key,
      value: Number(row.value),
      unit: row.unit,
      period_label: row.period_label,
      reporting_period_end: row.reporting_period_end,
      source_url: row.source_url,
      source_title: row.source_title,
    };
    if (existingIndex >= 0) list[existingIndex] = value;
    else list.push(value);
    byBank.set(bankId, list);
  }
  return byBank;
}

/** Sort helper that respects a metric's direction when ranking banks. */
export function orderForMetric(direction: MetricDirection) {
  return (a: { value: number }, b: { value: number }) =>
    direction === "lower_is_better" ? a.value - b.value : b.value - a.value;
}
