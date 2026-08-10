import { useEffect, useMemo, useState } from "react";

type Props = { token: string; onBack: () => void };
type Report = {
  id:number; report_title?:string; report_url:string; reporting_period_end?:string;
  period_label?:string; processed_at?:string; status?:string;
  bank_name?:string; source_bank_name?:string; country_name?:string; bank_mismatch?:number;
};
type Metric = {
  bank_id:number; bank_name:string; country_name:string; metric_label:string; value:number;
  unit:string; period_label?:string; reporting_period_end?:string; source_url:string; source_title?:string;
};

async function api(path:string,token:string){
  const r=await fetch(path,{headers:{Authorization:`Bearer ${token}`}});
  const ct=r.headers.get("content-type")||"";
  const body=ct.includes("json")?await r.json().catch(()=>null):await r.text();
  if(!r.ok)throw new Error(typeof body==="string"?body:body?.error||r.statusText||"Request failed");
  return body;
}

export default function Review({token,onBack}:Props){
  const [reports,setReports]=useState<Report[]>([]);
  const [metrics,setMetrics]=useState<Metric[]>([]);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [bankFilter,setBankFilter]=useState("all");
  const [showMismatch,setShowMismatch]=useState(false);

  async function load(){
    setLoading(true);setError("");
    try{
      const x=await api("/api/admin/audit?limit=1000",token);
      setReports(Array.isArray(x?.reports)?x.reports:[]);
      setMetrics(Array.isArray(x?.metrics)?x.metrics:[]);
    }catch(e){setError(String(e));}
    finally{setLoading(false);}
  }
  useEffect(()=>{load()},[]);

  const banks=useMemo(()=>[...new Set(reports.map(r=>r.bank_name).filter(Boolean))].sort(),[reports]);
  const visibleReports=useMemo(()=>reports.filter(r=>
    (bankFilter==="all"||r.bank_name===bankFilter) && (!showMismatch||Number(r.bank_mismatch)===1)
  ),[reports,bankFilter,showMismatch]);
  const publishedBanks=new Set(metrics.map(m=>m.bank_name));
  const mismatches=reports.filter(r=>Number(r.bank_mismatch)===1).length;

  const byBank=useMemo(()=>{
    const map=new Map<string,{reports:number;values:number}>();
    for(const r of reports){
      const name=r.bank_name||"Unknown";
      const x=map.get(name)||{reports:0,values:0};x.reports++;map.set(name,x);
    }
    for(const m of metrics){
      const x=map.get(m.bank_name)||{reports:0,values:0};x.values++;map.set(m.bank_name,x);
    }
    return [...map.entries()].sort((a,b)=>b[1].reports-a[1].reports);
  },[reports,metrics]);

  return <section className="shell page">
    <div className="section-head">
      <div>
        <span className="kicker">Audit & diagnostics</span>
        <h1>Published financial data</h1>
        <p className="lead">This audit shows exactly which bank owns each downloaded report and which extracted values are public.</p>
      </div>
      <div style={{display:"flex",gap:8}}>
        <button className="text-button" onClick={onBack}>← Admin</button>
        <button className="button small" onClick={load} disabled={loading}>{loading?"Refreshing…":"Refresh"}</button>
      </div>
    </div>

    <div className="admin-stats">
      <div><b>{reports.length}</b><span>Reports processed</span></div>
      <div><b>{metrics.length}</b><span>Published values</span></div>
      <div><b>{publishedBanks.size}</b><span>Banks with values</span></div>
      <div><b>{mismatches}</b><span>Bank ownership mismatches</span></div>
    </div>

    {error&&<aside className="notice"><b>Audit error</b><p>{error}</p></aside>}

    <div className="panel">
      <div className="section-head">
        <div><h2>Coverage by bank</h2><p>A bank with reports but zero values needs extraction attention; a mismatch means legacy data was attached to the wrong bank.</p></div>
      </div>
      <div className="table-wrap"><table><thead><tr><th>Bank</th><th>Reports</th><th>Published values</th><th>Status</th></tr></thead><tbody>
        {byBank.map(([name,x])=><tr key={name}><td><b>{name}</b></td><td>{x.reports}</td><td>{x.values}</td><td>{x.values?"Published":"Needs extraction"}</td></tr>)}
      </tbody></table></div>
    </div>

    <div className="panel">
      <div className="section-head">
        <div><h2>Downloaded reports</h2><p>Every report is linked back to its original reporting source.</p></div>
        <div style={{display:"flex",gap:8}}>
          <select value={bankFilter} onChange={e=>setBankFilter(e.target.value)}>
            <option value="all">All banks</option>
            {banks.map(b=><option key={b} value={b}>{b}</option>)}
          </select>
          <label style={{display:"flex",alignItems:"center",gap:6}}>
            <input type="checkbox" checked={showMismatch} onChange={e=>setShowMismatch(e.target.checked)}/>
            mismatches only
          </label>
        </div>
      </div>
      {loading?<div className="loading">Loading audit…</div>:visibleReports.length===0?<div className="notice"><b>No matching reports.</b></div>:
      <div className="table-wrap"><table><thead><tr><th>Bank</th><th>Source owner</th><th>Report</th><th>Period</th><th>Processed</th><th>Source</th></tr></thead><tbody>
        {visibleReports.map(r=><tr key={r.id}>
          <td><b>{r.bank_name||"Unknown"}</b>{Number(r.bank_mismatch)===1&&<small style={{display:"block"}}>Mismatch</small>}</td>
          <td>{r.source_bank_name||"—"}</td>
          <td>{r.report_title||r.report_url}</td>
          <td>{r.period_label||r.reporting_period_end||"—"}</td>
          <td>{r.processed_at?new Date(r.processed_at).toLocaleString():"—"}</td>
          <td><a href={r.report_url} target="_blank" rel="noreferrer">Open report ↗</a></td>
        </tr>)}
      </tbody></table></div>}
    </div>
  </section>;
}
