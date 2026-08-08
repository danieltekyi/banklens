import { useEffect, useMemo, useState } from "react";

type MetricReview = {
  id: number;
  bank_id: number;
  bank_name: string;
  country_name: string;
  source_type?: string;
  source_url: string;
  source_title?: string;
  metric_key: string;
  metric_label: string;
  raw_value?: string;
  value: number;
  unit: string;
  currency?: string;
  reporting_period_start?: string;
  reporting_period_end?: string;
  period_label?: string;
  status: string;
};

type BankOption = { id:number; name:string; country_id:number };
type SourceReview = {
  id: number;
  country_id: number;
  country_name: string;
  url: string;
  kind: string;
  title?: string;
  status: string;
  discovered_at?: string;
};

type Props = { token: string; onBack: () => void };

async function api(path: string, token: string, options: RequestInit = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json")
    ? await response.json().catch(() => null)
    : await response.text();
  if (!response.ok) throw new Error(body?.error || body || response.statusText || "Request failed");
  return body;
}

function formatDate(value?: string) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString();
}

export default function Review({ token, onBack }: Props) {
  const [metrics, setMetrics] = useState<MetricReview[]>([]);
  const [sources, setSources] = useState<SourceReview[]>([]);
  const [banks, setBanks] = useState<BankOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string>("");
  const [selected, setSelected] = useState<MetricReview | null>(null);
  const [note, setNote] = useState("");
  const [tab, setTab] = useState<"financial" | "sources">("financial");

  async function load() {
    setLoading(true);
    setError("");
    try {
      const body = await api("/api/admin/reviews?status=pending", token);
      setMetrics(Array.isArray(body?.data) ? body.data : []);
      setSources(Array.isArray(body?.sources) ? body.sources : []);
      setBanks(Array.isArray(body?.banks) ? body.banks : []);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function reviewMetric(id: number, action: "approve" | "reject") {
    setBusy(`metric-${id}`);
    try {
      await api(`/api/admin/reviews/${id}/${action}`, token, {
        method: "POST",
        body: JSON.stringify({ note }),
      });
      setSelected(null);
      setNote("");
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
    }
  }

  async function reviewSource(id: number, action: "approve" | "reject", bankId?: number) {
    setBusy(`source-${id}`);
    try {
      await api(`/api/admin/source-reviews/${id}/${action}`, token, {
        method: "POST",
        body: JSON.stringify({ note, bankId }),
      });
      setNote("");
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
    }
  }

  const grouped = useMemo(() => {
    const map = new Map<string, MetricReview[]>();
    for (const item of metrics) {
      const key = `${item.bank_id}:${item.period_label || item.reporting_period_end || "unknown"}`;
      map.set(key, [...(map.get(key) || []), item]);
    }
    return [...map.values()];
  }, [metrics]);

  return (
    <section className="shell page">
      <div className="section-head">
        <div>
          <span className="kicker">Secure administration</span>
          <h1>Review & publication</h1>
          <p className="lead">
            Nothing enters the public comparison until the source and extracted financial values have been checked.
          </p>
        </div>
        <div style={{display:"flex",gap:8}}>
          <button className="text-button" onClick={onBack}>← Admin console</button>
          <button className="button small" onClick={load} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button>
        </div>
      </div>

      <div className="admin-stats">
        <div><b>{metrics.length}</b><span>Financial values pending</span></div>
        <div><b>{sources.length}</b><span>Sources pending</span></div>
        <div><b>{grouped.length}</b><span>Statement periods</span></div>
      </div>

      {error && <aside className="notice"><b>Review error</b><p>{error}</p></aside>}

      <div style={{display:"flex",gap:8,marginBottom:16}}>
        <button className={tab==="financial" ? "button small" : "text-button"} onClick={()=>setTab("financial")}>
          Financial values ({metrics.length})
        </button>
        <button className={tab==="sources" ? "button small" : "text-button"} onClick={()=>setTab("sources")}>
          Discovered sources ({sources.length})
        </button>
      </div>

      {loading ? <div className="loading">Loading review queue…</div> : tab === "financial" ? (
        <div className="panel">
          <div className="section-head">
            <div>
              <h2>Financial statements</h2>
              <p>Review the proposed values, period and source before publication.</p>
            </div>
          </div>

          {metrics.length === 0 ? <div className="notice"><b>No financial values are waiting.</b><p>Approve a financial source, then run the country collection again to extract values.</p></div> :
            <div className="table-wrap">
              <table>
                <thead><tr><th>Bank</th><th>Metric</th><th>Value</th><th>Period</th><th>Source</th><th /></tr></thead>
                <tbody>
                  {metrics.map(item => (
                    <tr key={item.id}>
                      <td><b>{item.bank_name}</b><small>{item.country_name}</small></td>
                      <td>{item.metric_label}</td>
                      <td><b>{item.value}</b> <small>{item.unit}</small></td>
                      <td>{item.period_label || item.reporting_period_end || "—"}</td>
                      <td><a href={item.source_url} target="_blank" rel="noreferrer">Open source ↗</a></td>
                      <td><button className="text-button" onClick={()=>{setSelected(item);setNote("");}}>Inspect</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          }
        </div>
      ) : (
        <div className="panel">
          <div className="section-head"><div><h2>Discovered sources</h2><p>Approve only official financial/product sources that should be tracked.</p></div></div>
          {sources.length === 0 ? <div className="notice"><b>No sources are waiting.</b></div> :
            <div className="table-wrap"><table><thead><tr><th>Country</th><th>Type</th><th>Title</th><th>URL</th><th>Discovered</th><th /></tr></thead>
              <tbody>{sources.map(s=><tr key={s.id}>
                <td>{s.country_name}</td><td>{s.kind}</td><td>{s.title || "—"}</td>
                <td><a href={s.url} target="_blank" rel="noreferrer">Open ↗</a></td>
                <td>{formatDate(s.discovered_at)}</td>
                <td><div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                  <select id={`bank-${s.id}`} defaultValue="" disabled={busy===`source-${s.id}`}>
                    <option value="">Select bank</option>
                    {banks.filter(b=>b.country_id===s.country_id).map(b=><option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                  <button className="text-button" disabled={busy===`source-${s.id}`} onClick={()=>reviewSource(s.id,"reject")}>Reject</button>
                  <button className="button small" disabled={busy===`source-${s.id}`} onClick={()=>{
                    const el=document.getElementById(`bank-${s.id}`) as HTMLSelectElement | null;
                    const bankId=el?.value ? Number(el.value) : undefined;
                    if (!bankId && s.kind==="financial") { setError("Select the bank that owns this financial source before approving."); return; }
                    reviewSource(s.id,"approve",bankId);
                  }}>{busy===`source-${s.id}`?"Saving…":"Approve source"}</button>
                </div></td>
              </tr>)}</tbody>
            </table></div>
          }
        </div>
      )}

      {selected && (
        <div role="dialog" aria-modal="true" style={{position:"fixed",inset:0,background:"rgba(0,0,0,.35)",display:"flex",justifyContent:"center",alignItems:"center",padding:20,zIndex:1000}}>
          <div className="panel" style={{width:"min(900px,100%)",maxHeight:"90vh",overflow:"auto"}}>
            <div className="section-head">
              <div><span className="kicker">Financial value #{selected.id}</span><h2>{selected.bank_name}</h2><p>{selected.metric_label} · {selected.period_label || selected.reporting_period_end}</p></div>
              <button className="text-button" onClick={()=>setSelected(null)}>Close</button>
            </div>
            <div className="metric-cards">
              <div className="metric-card"><span>Metric</span><b>{selected.metric_label}</b></div>
              <div className="metric-card"><span>Proposed value</span><b>{selected.value} {selected.unit}</b></div>
              <div className="metric-card"><span>Reporting period</span><b>{selected.period_label || selected.reporting_period_end || "—"}</b></div>
              <div className="metric-card"><span>Raw source value</span><b>{selected.raw_value || "—"}</b></div>
            </div>
            <h3>Source evidence</h3>
            <p><a href={selected.source_url} target="_blank" rel="noreferrer">{selected.source_title || selected.source_url} ↗</a></p>
            <label>Review note<textarea value={note} onChange={e=>setNote(e.target.value)} rows={4} style={{width:"100%",boxSizing:"border-box"}} placeholder="Optional audit note"/></label>
            <div style={{display:"flex",justifyContent:"flex-end",gap:10,marginTop:16}}>
              <button className="text-button" disabled={busy===`metric-${selected.id}`} onClick={()=>reviewMetric(selected.id,"reject")}>Reject</button>
              <button className="button" disabled={busy===`metric-${selected.id}`} onClick={()=>reviewMetric(selected.id,"approve")}>{busy===`metric-${selected.id}`?"Publishing…":"Approve & publish"}</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
