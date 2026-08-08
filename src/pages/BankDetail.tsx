import { useEffect, useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { getBank } from "../lib/api";
import type { Bank } from "../types";
import BankBadge from "../components/BankBadge";
import Score from "../components/Score";

type Trend = {
  metric_key: string;
  metric_label: string;
  value: number;
  unit: string;
  reporting_period_end?: string;
  period_label?: string;
  source_url?: string;
};

const METRICS = [
  ["assets", "Total assets", "GHS_bn"],
  ["deposits", "Deposits", "GHS_bn"],
  ["profit", "Profit after tax", "GHS_bn"],
  ["capital_adequacy", "Capital adequacy", "percent"],
  ["liquidity", "Liquidity", "percent"],
  ["npl", "NPL ratio", "percent"],
] as const;

function formatDate(value?: string) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString(undefined, { year:"numeric", month:"short" });
}

function TrendChart({ rows, unit }: { rows: Trend[]; unit: string }) {
  if (!rows.length) return <div className="notice"><b>No approved historical values yet.</b><p>Once multiple reporting periods are approved, the trend will appear here.</p></div>;
  const points = rows.map((r, i) => ({ x:i, y:r.value, label:r.period_label || r.reporting_period_end || String(i+1) }));
  const min = Math.min(...points.map(p=>p.y));
  const max = Math.max(...points.map(p=>p.y));
  const span = max - min || 1;
  const width = 760, height = 250, pad = 36;
  const xy = points.map(p => ({
    x: pad + (p.x / Math.max(1, points.length-1)) * (width-pad*2),
    y: height-pad - ((p.y-min)/span) * (height-pad*2),
    ...p
  }));
  const d = xy.map((p,i)=>`${i?"L":"M"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  return <div>
    <svg viewBox={`0 0 ${width} ${height}`} style={{width:"100%",height:"auto",minHeight:220}} role="img" aria-label="Historical performance trend">
      <line x1={pad} x2={width-pad} y1={height-pad} y2={height-pad} stroke="currentColor" opacity=".15"/>
      <line x1={pad} x2={pad} y1={pad} y2={height-pad} stroke="currentColor" opacity=".15"/>
      <path d={d} fill="none" stroke="currentColor" strokeWidth="3"/>
      {xy.map(p=><g key={p.x}><circle cx={p.x} cy={p.y} r="5" fill="currentColor"/><text x={p.x} y={p.y-12} textAnchor="middle" fontSize="11">{p.y.toFixed(2)}</text><text x={p.x} y={height-12} textAnchor="middle" fontSize="10">{p.label}</text></g>)}
    </svg>
    <small>Unit: {unit}. Values are published only after admin review.</small>
  </div>;
}

export default function BankDetail() {
  const { slug } = useParams();
  const [bank, setBank] = useState<Bank>();
  const [trendRows, setTrendRows] = useState<Trend[]>([]);
  const [metric, setMetric] = useState("assets");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  useEffect(() => { if (slug) getBank(slug).then(x => setBank(x.data)); }, [slug]);

  useEffect(() => {
    if (!slug) return;
    const qs = new URLSearchParams();
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    fetch(`/api/banks/${encodeURIComponent(slug)}/trends?${qs.toString()}`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error("Could not load trends")))
      .then(x => setTrendRows(x.data || []))
      .catch(() => setTrendRows([]));
  }, [slug, from, to]);

  const selectedTrend = useMemo(
    () => trendRows.filter(x => x.metric_key === metric),
    [trendRows, metric]
  );

  if (!bank) return <section className="shell page">Loading...</section>;

  const formatMoney=(value:number|null)=>value==null?'Pending':`GH₵${value}bn`;
  const formatRate=(value:number|null)=>value==null?'Pending':`${value}%`;
  const unit = METRICS.find(x=>x[0]===metric)?.[2] || "";

  return <section className="shell page">
    <Link to="/">← Back to rankings</Link>
    <div className="detail-title"><BankBadge bank={bank}/><Score value={bank.healthScore}/></div>
    <p className="lead">{bank.summary}</p>

    <h2>Financial position</h2>
    <div className="metric-cards">
      <Metric label="Total assets" value={formatMoney(bank.metrics.assets)}/>
      <Metric label="Deposits" value={formatMoney(bank.metrics.deposits)}/>
      <Metric label="Profit after tax" value={formatMoney(bank.metrics.profit)}/>
      <Metric label="Capital adequacy" value={formatRate(bank.metrics.capitalAdequacy)}/>
      <Metric label="Liquidity" value={formatRate(bank.metrics.liquidity)}/>
      <Metric label="NPL ratio" value={formatRate(bank.metrics.npl)}/>
    </div>

    <section className="panel" style={{marginTop:32}}>
      <div className="section-head">
        <div><span className="kicker">Historical performance</span><h2>Bank trend</h2><p>Compare approved reporting periods instead of looking only at the latest number.</p></div>
      </div>
      <div style={{display:"flex",gap:10,flexWrap:"wrap",marginBottom:18}}>
        <select value={metric} onChange={e=>setMetric(e.target.value)}>
          {METRICS.map(([key,label])=><option key={key} value={key}>{label}</option>)}
        </select>
        <label>From <input type="date" value={from} onChange={e=>setFrom(e.target.value)}/></label>
        <label>To <input type="date" value={to} onChange={e=>setTo(e.target.value)}/></label>
        <button className="text-button" onClick={()=>{setFrom("");setTo("");}}>Clear dates</button>
      </div>
      <TrendChart rows={selectedTrend} unit={unit}/>
      {selectedTrend.length > 0 && <div className="table-wrap" style={{marginTop:18}}>
        <table><thead><tr><th>Period</th><th>Value</th><th>Source</th></tr></thead>
        <tbody>{selectedTrend.map((r,i)=><tr key={`${r.metric_key}-${r.reporting_period_end}-${i}`}>
          <td>{formatDate(r.reporting_period_end)}</td><td><b>{r.value}</b> {r.unit}</td>
          <td>{r.source_url ? <a href={r.source_url} target="_blank" rel="noreferrer">Source ↗</a> : "—"}</td>
        </tr>)}</tbody></table>
      </div>}
    </section>

    <h2>Consumer products</h2>
    <div className="metric-cards">
      <Metric label="Savings rate" value={formatRate(bank.products.savingsRate)}/>
      <Metric label="Listed loan rate" value={formatRate(bank.products.loanRate)}/>
      <Metric label="Transfer fee" value={bank.products.transferFee==null?'Pending':`GH₵${bank.products.transferFee.toFixed(2)}`}/>
    </div>
    <aside className="notice"><b>Important</b><p>Only reviewed values are used in the public financial history. Rates and financial indicators are not recommendations or guarantees.</p></aside>
  </section>
}
function Metric({label,value}:{label:string;value:string}){return <div className="metric-card"><span>{label}</span><b>{value}</b></div>}
