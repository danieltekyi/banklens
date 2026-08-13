export type ApiEnvelope<T, M = Record<string, unknown>> = { data: T; meta?: M; years?: string[]; best?: RankingRow[]; worst?: RankingRow[] };

export type Country = { id: number; name: string; iso2: string; currency: string };
export type Unit = "amount" | "percent" | "score" | string;
export type Direction = "higher_is_better" | "lower_is_better" | "neutral";

export type MetricDefinition = {
  key: string;
  label: string;
  unit: Unit;
  direction: Direction;
  group?: "scale" | "performance" | "resilience" | "efficiency" | string;
  description?: string;
  weight?: number;
};

export type MetricKey = "assets" | "deposits" | "profit" | "capitalAdequacy" | "liquidity" | "npl";
export type Bank = {
  id: string | number;
  slug: string;
  name: string;
  shortName: string;
  color: string;
  healthScore: number | null;
  summary: string;
  updatedAt?: string;
  countryName?: string;
  currency?: string;
  metrics: Record<MetricKey, number | null>;
  metricSources?: Partial<Record<MetricKey, string | null>>;
  reportingPeriod?: string | null;
  reportingPeriodEnd?: string | null;
  products: { savingsRate: number | null; loanRate: number | null; transferFee: number | null; minimumBalance: number | null };
};

export type Overview = { banks: number; reports: number; valuesPublished: number; latestPeriod: string | null; countries: Country[] };
export type Period = { period_label: string; reporting_period_end: string; year: string };

export type ComponentScore = {
  key: string;
  label: string;
  value: number | null;
  unit: string | null;
  score: number | null;
  weight: number;
  direction: Direction;
  sourceUrl?: string | null;
  sourceTitle?: string | null;
  periodLabel?: string | null;
};

export type TrendPoint = { value: number; unit: string; periodLabel?: string | null; periodEnd?: string | null; sourceUrl?: string | null; sourceTitle?: string | null };
export type Movement = { change: number; changePercent: number | null; from: string; to: string };
export type Profile = {
  bankId: number;
  slug: string;
  name: string;
  shortName: string;
  color: string;
  website?: string | null;
  summary?: string | null;
  countryName: string;
  currency: string;
  regulator?: string | null;
  score: number | null;
  coverage: number;
  components: ComponentScore[];
  strengths: string[];
  weaknesses: string[];
  trends: Record<string, TrendPoint[]>;
  movement: Record<string, Movement>;
  products: Product[];
  peerCount: number;
};

export type Report = {
  id: number;
  report_title: string;
  report_url: string;
  report_type?: string | null;
  period_label?: string | null;
  reporting_period_start?: string | null;
  reporting_period_end?: string | null;
  processed_at?: string | null;
  downloaded_at?: string | null;
  status?: string | null;
  content_type?: string | null;
  portal_url?: string | null;
  value_count?: number | null;
};

export type RankingSource = { url?: string | null; title?: string | null; metric?: string | null };
export type RankingRow = {
  bankId: number;
  slug: string;
  name: string;
  shortName?: string;
  color?: string;
  countryName?: string;
  currency?: string;
  value: number | null;
  unit?: string | null;
  coverage?: number;
  components?: ComponentScore[];
  strengths?: string[];
  weaknesses?: string[];
  sources?: RankingSource[];
  periodLabel?: string | null;
  reportingPeriodEnd?: string | null;
  sourceUrl?: string | null;
  sourceTitle?: string | null;
  rank: number;
};
export type RankingsResponse = { data: RankingRow[]; best?: RankingRow[]; worst?: RankingRow[]; meta: { metric?: MetricDefinition; from?: string; to?: string; count?: number; methodology?: string; empty?: boolean } };

export type CompareBank = { bankId: number; slug: string; name: string; shortName: string; color: string; website?: string | null; summary?: string | null; countryName: string; currency: string; score: number | null; coverage: number; strengths: string[]; weaknesses: string[] };
export type CompareCell = { bankId: number; slug: string; value: number | null; unit: string | null; periodLabel: string | null; reportingPeriodEnd: string | null; sourceUrl: string | null; sourceTitle: string | null };
export type CompareResponse = { data: { banks: CompareBank[]; comparison: { metric: MetricDefinition; cells: CompareCell[]; leader: string | null }[] }; meta: { from: string; to: string; metricCount: number } };

export type Product = {
  id?: number;
  bank_id?: number;
  product_name?: string;
  product_type?: string;
  productName?: string;
  productType?: string;
  category?: string | null;
  rate?: number | null;
  rate_note?: string | null;
  rateNote?: string | null;
  min_amount?: number | null;
  max_amount?: number | null;
  tenor_months?: number | null;
  fee?: number | null;
  fee_note?: string | null;
  eligibility?: string | null;
  currency?: string | null;
  source_url?: string | null;
  source_title?: string | null;
  effective_date?: string | null;
  bank_slug?: string;
  bank_name?: string;
  short_name?: string;
  color?: string;
  country_name?: string;
  country_currency?: string;
};

export type Recommendation = {
  rank: number;
  productId: number;
  bankId: number;
  bankSlug: string;
  bankName: string;
  shortName: string;
  color: string;
  countryName: string;
  productName: string;
  productType: string;
  category?: string | null;
  rate: number;
  rateNote?: string | null;
  fee?: number | null;
  feeNote?: string | null;
  minAmount?: number | null;
  maxAmount?: number | null;
  tenorMonths?: number | null;
  eligibility?: string | null;
  currency?: string | null;
  effectiveDate?: string | null;
  sourceUrl?: string | null;
  sourceTitle?: string | null;
  rateScore: number;
  strengthScore: number;
  matchScore: number;
  reasons: string[];
};
export type RecommendResponse = { data: Recommendation[]; meta: { need: string; category?: string | null; amount?: number | null; tenor?: number | null; count?: number; methodology?: string; empty?: boolean; message?: string } };
