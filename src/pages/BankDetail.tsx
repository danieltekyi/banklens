import { ArrowLeft, ExternalLink } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import BankBadge from "../components/BankBadge";
import Score from "../components/Score";
import SourceLink from "../components/SourceLink";
import { EmptyState, ErrorState, LoadingBlock } from "../components/States";
import TrendChart from "../components/TrendChart";
import { api } from "../lib/api";
import { directionCopy, formatDate, formatValue } from "../lib/format";
import type { Profile, Report } from "../types";

export default function BankDetail() {
  const { slug } = useParams();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [reports, setReports] = useState<Report[]>([]);
  const [metric, setMetric] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) return;
    setLoading(true); setError(null);
    Promise.all([api.profile(slug), api.reports(slug)])
      .then(([profileResult, reportResult]) => {
        setProfile(profileResult.data);
        setReports(reportResult.data || []);
        const firstMetric = profileResult.data.components[0]?.key || Object.keys(profileResult.data.trends)[0] || "";
        setMetric(firstMetric);
      })
      .catch((err: Error) => setError(err.message || "Could not load this bank."))
      .finally(() => setLoading(false));
  }, [slug]);

  const currentComponent = useMemo(() => profile?.components.find((component) => component.key === metric), [profile, metric]);
  const points = profile?.trends[metric] || [];
  const movement = profile?.movement[metric];

  if (loading) return <section className="shell page"><LoadingBlock label="Loading bank profile" /></section>;
  if (error) return <section className="shell page"><ErrorState message={error} action={<Link className="button" to="/rankings">Back to rankings</Link>} /></section>;
  if (!profile) return <section className="shell page"><EmptyState title="Bank not found" message="The bank profile is not available." /></section>;

  return <section className="shell page bank-detail"><Link className="back-link" to="/rankings"><ArrowLeft size={16} /> Back to rankings</Link><div className="detail-hero panel"><div><BankBadge bank={profile} meta={`${profile.countryName}${profile.regulator ? ` · ${profile.regulator}` : ""}`} /><h1>{profile.name}</h1><p className="lead">{profile.summary || "No public summary has been published for this bank yet."}</p>{profile.website && <a className="source-link" href={profile.website} target="_blank" rel="noreferrer">Bank website <ExternalLink size={14} /></a>}</div><div className="score-card"><span>Financial strength</span><Score value={profile.score} coverage={profile.coverage} /><p>Coverage: <b>{profile.coverage}%</b> of scoring weight has published-source data.</p>{profile.coverage < 60 && <div className="notice"><b>Low coverage caveat</b><p>Use this score carefully: several weighted metrics are not reported yet.</p></div>}</div></div><div className="rank-summaries"><ListPanel title="Strengths" items={profile.strengths} empty="No strengths have been computed yet." /><ListPanel title="Watch points" items={profile.weaknesses} empty="No watch points have been computed yet." /></div><section className="panel"><div className="section-head"><div><span className="kicker">Latest values</span><h2>Score components and source reports</h2></div></div>{profile.components.length ? <div className="metric-cards">{profile.components.map((component) => <article className="metric-card" key={component.key}><span>{component.label}</span><b>{formatValue(component.value, component.unit, profile.currency)}</b><small>{directionCopy(component.direction)} · Score {component.score == null ? "not scored" : Math.round(component.score)}</small><small>{component.periodLabel || "Period not reported"}</small><SourceLink url={component.sourceUrl} title={component.sourceTitle} /></article>)}</div> : <EmptyState title="No sourced metrics" message="This bank has no published extracted values yet." />}</section><section className="panel"><div className="section-head"><div><span className="kicker">Trends over time</span><h2>How the bank is moving</h2></div><label className="field compact"><span>Metric</span><select value={metric} onChange={(event) => setMetric(event.target.value)}>{Object.keys(profile.trends).map((key) => <option key={key} value={key}>{profile.components.find((c) => c.key === key)?.label || key}</option>)}</select></label></div>{movement && <p className={`movement ${movement.change >= 0 ? "up" : "down"}`}>{movement.change >= 0 ? "Up" : "Down"} {formatValue(Math.abs(movement.change), currentComponent?.unit, profile.currency)} ({movement.changePercent == null ? "percentage change not available" : `${Math.abs(movement.changePercent).toFixed(1)}%`}) from {movement.from} to {movement.to}.</p>}<TrendChart points={points} label={currentComponent?.label || metric} currency={profile.currency} description={`${currentComponent?.label || metric} trend for ${profile.name}.`} />{points.length > 0 && <div className="table-wrap"><table className="responsive-table"><thead><tr><th>Period</th><th>Value</th><th>Source</th></tr></thead><tbody>{points.map((point, index) => <tr key={`${point.periodEnd}-${index}`}><td data-label="Period">{point.periodLabel || formatDate(point.periodEnd)}</td><td data-label="Value"><b>{formatValue(point.value, point.unit, profile.currency)}</b></td><td data-label="Source"><SourceLink url={point.sourceUrl} title={point.sourceTitle} /></td></tr>)}</tbody></table></div>}</section><section className="panel"><div className="section-head"><div><span className="kicker">Evidence trail</span><h2>All source documents</h2></div></div>{reports.length ? <div className="table-wrap"><table className="responsive-table"><thead><tr><th>Report</th><th>Period</th><th>Status</th><th>Values</th><th>Source</th></tr></thead><tbody>{reports.map((report) => <tr key={report.id}><td data-label="Report"><b>{report.report_title}</b><small>{report.report_type || "Report"}</small></td><td data-label="Period">{report.period_label || formatDate(report.reporting_period_end)}</td><td data-label="Status">{report.status || "Stored"}</td><td data-label="Values">{report.value_count ?? 0}</td><td data-label="Source"><SourceLink url={report.report_url} title={report.report_title} /></td></tr>)}</tbody></table></div> : <EmptyState title="No reports stored" message="The evidence trail will list every source document once reports are downloaded." />}</section></section>;
}

function ListPanel({ title, items, empty }: { title: string; items: string[]; empty: string }) { return <div className="panel mini-panel"><h3>{title}</h3>{items.length ? <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul> : <p className="muted">{empty}</p>}</div>; }
