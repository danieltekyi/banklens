import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import BankBadge from "../components/BankBadge";
import CountrySelect from "../components/CountrySelect";
import Score from "../components/Score";
import SourceLink from "../components/SourceLink";
import { EmptyState, ErrorState, LoadingBlock } from "../components/States";
import { api } from "../lib/api";
import { directionCopy, formatValue } from "../lib/format";
import { useCountry } from "../hooks/useCountry";
import type { Bank, CompareResponse } from "../types";

export default function Compare() {
  const { countries, country, setCountry } = useCountry();
  const [searchParams, setSearchParams] = useSearchParams();
  const [banks, setBanks] = useState<Bank[]>([]);
  const [selected, setSelected] = useState<string[]>(() => (searchParams.get("banks") || "").split(",").filter(Boolean));
  const [year, setYear] = useState(searchParams.get("year") || "");
  const [years, setYears] = useState<string[]>([]);
  const [result, setResult] = useState<CompareResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!country) return;
    api.banks(country).then((r) => {
      setBanks(r.data || []);
      setSelected((prev) => prev.length >= 2 ? prev : (r.data || []).slice(0, 2).map((b) => b.slug));
    }).catch(() => setBanks([]));
    api.periods(country).then((r) => setYears(r.years || [])).catch(() => setYears([]));
  }, [country]);

  useEffect(() => {
    const next = new URLSearchParams();
    if (selected.length) next.set("banks", selected.join(","));
    if (year) next.set("year", year);
    setSearchParams(next, { replace: true });
  }, [selected, year, setSearchParams]);

  useEffect(() => {
    if (selected.length < 2) { setResult(null); return; }
    const params = new URLSearchParams({ banks: selected.join(",") });
    if (year) params.set("year", year);
    setLoading(true); setError(null);
    api.compare(params).then(setResult).catch((err: Error) => { setResult(null); setError(err.message); }).finally(() => setLoading(false));
  }, [selected, year]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const toggle = (slug: string) => setSelected((prev) => prev.includes(slug) ? prev.filter((x) => x !== slug) : prev.length < 6 ? [...prev, slug] : prev);

  return <section className="shell page"><span className="kicker">Side-by-side evidence</span><h1>Compare banks</h1><p className="lead">Choose two to six banks. The URL updates as you choose, so this comparison can be shared.</p><div className="selectors"><CountrySelect countries={countries} value={country} onChange={setCountry} /><label className="field compact"><span>Year</span><select value={year} onChange={(e) => setYear(e.target.value)}><option value="">Latest available</option>{years.map((y) => <option key={y} value={y}>{y}</option>)}</select></label></div><div className="bank-picker" role="group" aria-label="Select banks to compare">{banks.map((bank) => <button key={bank.slug} className={`choice-chip ${selectedSet.has(bank.slug) ? "on" : ""}`} onClick={() => toggle(bank.slug)} aria-pressed={selectedSet.has(bank.slug)} disabled={!selectedSet.has(bank.slug) && selected.length >= 6}>{bank.shortName || bank.name}<small>{selectedSet.has(bank.slug) ? "Selected" : selected.length >= 6 ? "Limit reached" : "Add"}</small></button>)}</div>{selected.length < 2 ? <EmptyState title="Select at least two banks" message="Choose up to six banks to compare each metric and source side by side." /> : loading ? <LoadingBlock /> : error ? <ErrorState message={error} /> : result ? <Comparison result={result} /> : null}</section>;
}

function Comparison({ result }: { result: CompareResponse }) {
  if (!result.data.comparison.length) return <EmptyState title="No comparable figures" message="These banks do not have published values in the selected period yet." />;
  return <div className="panel compare-panel"><div className="compare-bank-row">{result.data.banks.map((bank) => <article key={bank.slug} className="compare-bank-card"><BankBadge bank={bank} meta={bank.countryName} /><Score value={bank.score} coverage={bank.coverage} />{bank.coverage < 60 && <p className="source-note">Low coverage: only {bank.coverage}% of scoring weight has sourced data.</p>}</article>)}</div><div className="table-wrap"><table className="responsive-table compare-table"><thead><tr><th>Metric</th>{result.data.banks.map((bank) => <th key={bank.slug}>{bank.shortName || bank.name}</th>)}</tr></thead><tbody>{result.data.comparison.map((row) => <tr key={row.metric.key}><th scope="row" data-label="Metric"><span>{row.metric.label}</span><small>{directionCopy(row.metric.direction)}</small></th>{row.cells.map((cell) => <td key={`${row.metric.key}-${cell.slug}`} data-label={result.data.banks.find((b) => b.slug === cell.slug)?.name || cell.slug} className={row.leader === cell.slug ? "leader-cell" : ""}><b>{formatValue(cell.value, cell.unit)}</b>{row.leader === cell.slug && <span className="pill success">Leader</span>}<small>{cell.periodLabel || cell.reportingPeriodEnd || "Period not reported"}</small><SourceLink compact url={cell.sourceUrl} title={cell.sourceTitle} /></td>)}</tr>)}</tbody></table></div><p className="source-note"><b>Method:</b> Leaders are highlighted only when the metric direction is clear. Each cell cites its own report.</p></div>;
}
