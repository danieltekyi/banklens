import type { Bank, CompareResponse, Country, MetricDefinition, Overview, Period, Profile, RecommendResponse, RankingsResponse, Report } from "../types";

async function request<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { Accept: "application/json" } });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json?.error || `Request failed: ${response.status}`);
  return json as T;
}

export const api = {
  countries: () => request<{ data: Country[] }>("/api/countries"),
  overview: (country?: string) => request<{ data: Overview }>(`/api/overview${country ? `?country=${encodeURIComponent(country)}` : ""}`),
  catalog: () => request<{ data: MetricDefinition[] }>("/api/metrics/catalog"),
  periods: (country?: string) => request<{ data: Period[]; years: string[] }>(`/api/periods${country ? `?country=${encodeURIComponent(country)}` : ""}`),
  banks: (country?: string) => request<{ data: Bank[]; meta?: { demo?: boolean; updatedAt?: string } }>(`/api/banks${country ? `?country=${encodeURIComponent(country)}` : ""}`),
  profile: (slug: string) => request<{ data: Profile }>(`/api/banks/${encodeURIComponent(slug)}/profile`),
  reports: (slug: string) => request<{ data: Report[]; meta: { bankId: number; bankName: string } }>(`/api/banks/${encodeURIComponent(slug)}/reports`),
  rankings: (params: URLSearchParams) => request<RankingsResponse>(`/api/rankings?${params.toString()}`),
  compare: (params: URLSearchParams) => request<CompareResponse>(`/api/compare?${params.toString()}`),
  recommend: (params: URLSearchParams) => request<RecommendResponse>(`/api/recommend?${params.toString()}`),
};

export async function getBanks(): Promise<{ data: Bank[]; meta?: { demo?: boolean; updatedAt?: string } }> { return api.banks(); }
export async function getBank(slug: string): Promise<{ data: Bank }> { return request<{ data: Bank }>(`/api/banks/${encodeURIComponent(slug)}`); }
