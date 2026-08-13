import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import BankBadge from "../components/BankBadge";
import CountrySelect from "../components/CountrySelect";
import Score from "../components/Score";
import SourceLink from "../components/SourceLink";
import { EmptyState, ErrorState, LoadingBlock } from "../components/States";
import { api } from "../lib/api";
import { directionCopy, formatDate, formatValue } from "../lib/format";
import { useCountry } from "../hooks/useCountry";
import type { MetricDefinition, Period, RankingRow } from "../types";

export default function Rankings() {
  const { countries, country, setCountry } = useCountry();
  const [catalog, setCatalog] = useState<MetricDefinition[]>([]);
  const [periods, setPeriods] = useState<Period[]>([]);
  const [metric, setMetric] = useState("overall");
  const [year, setYear] = useState("");
  const [rows, setRows] = useState<RankingRow[]>([]);
  const [best, setBest] = useState<RankingRow[]>([]);
  const [worst, setWorst] = useState<RankingRow[]>([]);
  const [meta, setMeta] = useState<{ metric?: MetricDefinition; methodology?: string; empty?: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api.catalog().then((r) => setCatalog(r.data)).catch(() => setCatalog([])); }, []);
  useEffect(() => {
    if (!country) return;
    api.periods(country).then((r) => { setPeriods(r.data); setYear((prev) => prev || r.years?.[0] || ""); }).catch(() => setPeriods([]));
  }, [country]);
  useEffect(() => {
    if (!country) return;
    const params = new URLSearchParams({ country, metric });
    if (year) params.set("year", year);
    setLoading(true); setError(null);
    api.rankings(params).then((r) => { setRows(r.data || []); setBest(r.best || []); setWorst(r.worst || []); setMeta(r.meta); }).catch((err: Error) => setError(err.message)).finally(() => setLoading(false));
  }, [country, metric, year]);

  const years = useMemo(() => [...new Set(periods.map((p) => p.year).filter(Boolean))], [periods]);
  const currentMetric = meta?.metric || (metric === "overall" ? { key: "overall", label: "Overall financial strength", unit: "score", direction: "higher_is_better" as const } : catalog.find((m) => m.key === metric));

  return <section className="shell page"><span className="kicker">Best and worst performers</span><h1>Rankings with receipts</h1><p className="lead">Pick a country, year and metric. The API already respects whether higher or lower is better; every row cites a source document.</p><div className="selectors"><CountrySelect countries={countries} value={country} onChange={setCountry} /><label className="field compact"><span>Metric</span><select value={metric} onChange={(e) => setMetric(e.target.value)}><option value="overall">Overall financial strength</option>{catalog.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}</select></label><label className="field compact"><span>Year</span><select value={year} onChange={(e) => setYear(e.target.value)}><option value="">All years</option>{years.map((y) => <option key={y} value={y}>{y}</option>)}</select></label></div>{currentMetric && <div className="method-box"><b>{currentMetric.label}</b><span>{directionCopy(currentMetric.direction)}. {currentMetric.description}</span></div>}{error ? <ErrorState message={error} /> : loading ? <LoadingBlock /> : rows.length ? <><div className="rank-summaries"><Summary title="Best performers" rows={best} /><Summary title="Watch list" rows={worst} /></div><div className="panel"><div className="section-head"><div><span className="kicker">Full table</span><h2>{currentMetric?.label || "Ranking"}</h2></div></div><RankingTable rows={rows} metric={currentMetric} /></div>{meta?.methodology && <p className="source-note methodology-note"><b>Methodology:</b> {meta.methodology}</p>}</> : <EmptyState title="No published values yet" message="An administrator has not published bank figures for this country, metric and year." />}</section>;
}

function Summary({ title, rows }: { title: string; rows: RankingRow[] }) { return <div className="panel mini-panel"><h3>{title}</h3>{rows.length ? rows.map((row) => <Link key={row.slug} to={`/banks/${row.slug}`}><span>#{row.rank} {row.name}</span><b>{formatValue(row.value, row.unit)}</b></Link>) : <p className="muted">Not enough data.</p>}</div>; }
function RankingTable({ rows, metric }: { rows: RankingRow[]; metric?: MetricDefinition }) { return <div className="table-wrap"><table className="responsive-table"><thead><tr><th>Rank</th><th>Bank</th><th>Value</th><th>Period</th><th>Evidence</th></tr></thead><tbody>{rows.map((row) => <tr key={`${row.rank}-${row.slug}`}><td data-label="Rank"><b>#{row.rank}</b></td><td data-label="Bank"><Link to={`/banks/${row.slug}`}><BankBadge bank={{ name: row.name, shortName: row.shortName || row.name.slice(0, 2), color: row.color || "#08715f" }} meta={row.countryName} /></Link></td><td data-label="Value">{metric?.key === "overall" ? <Score value={row.value} coverage={row.coverage} /> : <b>{formatValue(row.value, row.unit, row.currency)}</b>}</td><td data-label="Period">{row.periodLabel || formatDate(row.reportingPeriodEnd)}</td><td data-label="Evidence">{row.sourceUrl ? <SourceLink url={row.sourceUrl} title={row.sourceTitle} /> : row.sources?.length ? row.sources.slice(0, 2).map((s) => <SourceLink key={s.url || s.title} url={s.url} title={s.title || s.metric} />) : "Not reported"}</td></tr>)}</tbody></table></div>; }
