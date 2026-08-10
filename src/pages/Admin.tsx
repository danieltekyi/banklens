import { useEffect, useState } from "react";
import Review from "./Review";

const ADMIN_RECOVERY_EMAIL = "sameultekyi@gmail.com";

type Country = { id:number; name:string; iso2:string; currency:string; regulator_name:string; enabled:number; bank_count:number; bank_total?:number; source_count:number; report_count:number; last_scan_at?:string|null };
type Bank = { id:number; name:string; slug:string; website?:string|null; active:number; health_score:number; source_count?:number };
type Source = { id:number; bank_id:number; bank_name:string; url:string; source_type:string; active:number };

async function api(path:string,token="",options:RequestInit={}){
  const r=await fetch(path,{...options,headers:{"Content-Type":"application/json",...(token?{Authorization:`Bearer ${token}`}:{}) ,...(options.headers||{})}});
  const ct=r.headers.get("content-type")||""; const body=ct.includes("json")?await r.json().catch(()=>null):await r.text();
  if(!r.ok)throw new Error(typeof body==="string"?body:body?.error||body?.message||r.statusText||"Request failed"); return body;
}

export default function Admin(){
 const [token,setToken]=useState(localStorage.getItem("bl_admin")||"");
 const [username,setUsername]=useState("banklensadmin"),[password,setPassword]=useState("");
 const [resetToken,setResetToken]=useState(()=>new URLSearchParams(location.search).get("reset")||"");
 const [resetPassword,setResetPassword]=useState(""),[resetConfirm,setResetConfirm]=useState("");
 if(!token)return resetToken?<Reset token={resetToken} setResetToken={setResetToken} password={resetPassword} setPassword={setResetPassword} confirm={resetConfirm} setConfirm={setResetConfirm}/>:<section className="shell page auth-page"><form className="auth-card" onSubmit={async e=>{e.preventDefault();try{const x=await api("/api/auth/login","",{method:"POST",body:JSON.stringify({username,password})});localStorage.setItem("bl_admin",x.token);setToken(x.token);}catch(err){alert(String(err));}}}><span className="brandmark">BL</span><h1>Admin sign in</h1><p>Configure countries and their official financial-report portals.</p><label>Username<input value={username} onChange={e=>setUsername(e.target.value)}/></label><label>Password<input type="password" value={password} onChange={e=>setPassword(e.target.value)}/></label><button className="button">Sign in</button><button type="button" className="text-button" onClick={async()=>{await api("/api/auth/forgot","",{method:"POST",body:JSON.stringify({email:ADMIN_RECOVERY_EMAIL})});alert("If the email is registered, reset instructions have been sent.")}}>Forgot password?</button></form></section>;
 return <Console token={token} logout={()=>{localStorage.removeItem("bl_admin");setToken("")}}/>;
}

function Reset(p:any){return <section className="shell page auth-page"><form className="auth-card" onSubmit={async e=>{e.preventDefault();if(p.password.length<12||p.password!==p.confirm)return alert("Use at least 12 characters and make both passwords match.");try{await api("/api/auth/reset","",{method:"POST",body:JSON.stringify({token:p.token,password:p.password})});p.setResetToken("");history.replaceState({},"","/admin");alert("Password updated.");}catch(err){alert(String(err));}}}><span className="brandmark">BL</span><h1>Reset password</h1><label>New password<input type="password" value={p.password} onChange={e=>p.setPassword(e.target.value)}/></label><label>Confirm password<input type="password" value={p.confirm} onChange={e=>p.setConfirm(e.target.value)}/></label><button className="button">Update password</button></form></section>}

function Console({token,logout}:{token:string;logout:()=>void}){
 const [countries,setCountries]=useState<Country[]>([]),[selected,setSelected]=useState<number|null>(null),[config,setConfig]=useState<any>(null),[showAudit,setShowAudit]=useState(false),[busy,setBusy]=useState<number|null>(null),[progress,setProgress]=useState<Record<number,string>>({});
 const [countryForm,setCountryForm]=useState({name:"",iso2:"",currency:""});
 const load=()=>api("/api/admin/countries",token).then(x=>setCountries(x.data));
 useEffect(()=>{load().catch(logout)},[]);
 async function openCountry(id:number){setSelected(id);setConfig(await api(`/api/admin/countries/${id}/config`,token));}
 async function createCountry(e:any){e.preventDefault();if(!countryForm.name||!countryForm.iso2||!countryForm.currency)return;await api("/api/admin/countries",token,{method:"POST",body:JSON.stringify(countryForm)});setCountryForm({name:"",iso2:"",currency:""});await load();}
 async function seedGhana(){setBusy(-1);try{const x=await api("/api/admin/ghana-starter",token,{method:"POST"});alert(`Ghana starter set ready: ${x.banksAdded} banks and ${x.sourcesAdded} reporting portals added.`);await load();}catch(e){alert(String(e))}finally{setBusy(null)}}
 async function analyze(id:number){
   setBusy(id); setProgress(p=>({...p,[id]:"Repairing existing report ownership…"}));
   try{
     const repair=await api(`/api/admin/countries/${id}/repair`,token,{method:"POST"});
     setProgress(p=>({...p,[id]:`Ownership repaired · ${repair.documentsReassigned||0} reports · ${repair.recordsReassigned||0} values · starting analysis…`}));
     const r=await fetch(`/api/admin/countries/${id}/analyze`,{method:"POST",headers:{Authorization:`Bearer ${token}`}});
     if(!r.ok) throw new Error(await r.text());
     const reader=r.body?.getReader(); if(!reader) throw new Error("No progress stream");
     const dec=new TextDecoder(); let buf="";
     while(true){
       const {done,value}=await reader.read(); if(done) break;
       buf+=dec.decode(value,{stream:true});
       const lines=buf.split("\n"); buf=lines.pop()||"";
       for(const line of lines){
         if(!line.trim()) continue;
         try{
           const x=JSON.parse(line);
           if(x.status==="repaired") setProgress(p=>({...p,[id]:`Repaired ${x.documentsReassigned||0} report owners · scanning portals…`}));
           else if(x.status==="checking") setProgress(p=>({...p,[id]:`Checking portal ${x.checked}/${x.total} · ${x.reportsFound||0} reports · ${x.newReports||0} new · ${x.reprocessed||0} reprocessed · ${x.published||0} values`}));
           else if(x.status==="source_done") setProgress(p=>({...p,[id]:`Portal complete · ${x.reportsFound||0} reports · ${x.newReports||0} new · ${x.reprocessed||0} reprocessed · ${x.extracted||0} extracted · ${x.published||0} published · ${x.failed||0} report failures`}));
           else if(x.status==="source_error") setProgress(p=>({...p,[id]:`Portal failed · ${x.message}`}));
           else if(x.status==="stored_reprocess_start") setProgress(p=>({...p,[id]:`Retrying stored reports with no published values…`}));
           else if(x.status==="reprocessing") setProgress(p=>({...p,[id]:`Reprocessing stored report ${x.checked}/${x.total} · ${x.reportTitle||"report"} · ${x.extracted||0} extracted · ${x.published||0} published · ${x.failed||0} failed`}));
           else if(x.status==="reprocess_error") setProgress(p=>({...p,[id]:`Stored report failed · ${x.error}`}));
           else if(x.status==="done"){ const f=x.result.sourceFailures?.[0]?.error||x.result.reportFailures?.[0]?.error||""; setProgress(p=>({...p,[id]:`Complete · ${x.result.reportsFound} reports · ${x.result.newReports} new · ${x.result.reprocessed} reprocessed · ${x.result.extracted} extracted · ${x.result.published} published · ${x.result.sourceFailed||0} portal failures · ${x.result.reportFailed||0} report failures${f?` · ${f}`:""}`})); }
           else if(x.status==="error") setProgress(p=>({...p,[id]:`Error: ${x.message}`}));
         }catch{}
       }
     }
     await load(); if(selected===id) await openCountry(id);
   }catch(e){ setProgress(p=>({...p,[id]:`Failed: ${String(e)}`})); }
   finally{ setBusy(null); }
 }
 if(showAudit)return <Review token={token} onBack={()=>setShowAudit(false)}/>;
 return <section className="shell page"><div className="section-head"><div><span className="kicker">BankLens control centre</span><h1>Countries & reporting portals</h1><p className="lead">No automatic source discovery. Each bank is explicitly paired with the official page where its financial reports are published.</p></div><div style={{display:"flex",gap:8,flexWrap:"wrap"}}><button className="button small" onClick={()=>setShowAudit(true)}>Audit published data</button><button className="text-button small" disabled={busy===-1} onClick={seedGhana}>{busy===-1?"Loading Ghana…":"Load Ghana starter set"}</button><button className="button small" onClick={logout}>Sign out</button></div></div>
 <div className="admin-stats"><div><b>{countries.length}</b><span>Countries</span></div><div><b>{countries.reduce((n,c)=>n+c.bank_count,0)}</b><span>Banks with portals</span></div>
 <div><b>{countries.reduce((n,c)=>n+(c.bank_total||c.bank_count),0)}</b><span>Total bank records</span></div><div><b>{countries.reduce((n,c)=>n+c.source_count,0)}</b><span>Report portals</span></div><div><b>{countries.reduce((n,c)=>n+c.report_count,0)}</b><span>Reports processed</span></div></div>
 <div className="panel"><div className="section-head"><div><h2>Add a country</h2><p>Create the country first, then add banks and their financial-report portals.</p></div></div><form onSubmit={createCountry} style={{display:"grid",gridTemplateColumns:"2fr 1fr 1fr auto",gap:10}}><input placeholder="Country name" value={countryForm.name} onChange={e=>setCountryForm({...countryForm,name:e.target.value})}/><input placeholder="ISO2" maxLength={2} value={countryForm.iso2} onChange={e=>setCountryForm({...countryForm,iso2:e.target.value.toUpperCase()})}/><input placeholder="Currency" value={countryForm.currency} onChange={e=>setCountryForm({...countryForm,currency:e.target.value.toUpperCase()})}/><button className="button">Create country</button></form></div>
 <div className="panel"><div className="section-head"><div><h2>Configured countries</h2><p>Enable a country to include its portals in the scheduled cron. “Start analysis” runs the same pipeline immediately.</p></div></div><div className="table-wrap"><table><thead><tr><th>Country</th><th>Banks</th><th>Portals</th><th>Reports</th><th>Last scan</th><th>Enabled</th><th/></tr></thead><tbody>{countries.map(c=><tr key={c.id}><td><button className="text-button" onClick={()=>openCountry(c.id)}><b>{c.name}</b></button><small>{c.iso2} · {c.currency}</small></td><td>{c.bank_count}</td><td>{c.source_count}</td><td>{c.report_count}</td><td>{c.last_scan_at?new Date(c.last_scan_at).toLocaleString():"Never"}</td><td><button className={`toggle ${c.enabled?"on":""}`} onClick={async()=>{await api(`/api/admin/countries/${c.id}`,token,{method:"PATCH",body:JSON.stringify({enabled:!c.enabled})});load()}}><span/></button></td><td><button className="button small" disabled={!c.enabled||busy===c.id} onClick={()=>analyze(c.id)}>{busy===c.id?"Analysing…":"Start analysis"}</button>{progress[c.id]&&<small style={{display:"block",maxWidth:320}}>{progress[c.id]}</small>}</td></tr>)}</tbody></table></div></div>
 {config&&selected&&<CountryConfig token={token} config={config} onClose={()=>{setConfig(null);setSelected(null)}} reload={()=>openCountry(selected)}/>} 
 </section>
}

function CountryConfig({token,config,onClose,reload}:{token:string;config:any;onClose:()=>void;reload:()=>void}){
 const [bank,setBank]=useState({name:"",sourceUrl:""});const [sourceBank,setSourceBank]=useState("");const [sourceUrl,setSourceUrl]=useState("");const [reprocessBusy,setReprocessBusy]=useState(false);const [reprocessProgress,setReprocessProgress]=useState("");
 async function addBank(e:any){e.preventDefault();await api(`/api/admin/countries/${config.country.id}/banks`,token,{method:"POST",body:JSON.stringify(bank)});setBank({name:"",sourceUrl:""});reload()}
 async function addSource(e:any){e.preventDefault();if(!sourceBank||!sourceUrl)return;await api(`/api/admin/banks/${sourceBank}/sources`,token,{method:"POST",body:JSON.stringify({url:sourceUrl})});setSourceUrl("");reload()}
 async function reprocessStored(){setReprocessBusy(true);setReprocessProgress("Starting reprocess…");try{const r=await fetch(`/api/admin/countries/${config.country.id}/reprocess`,{method:"POST",headers:{Authorization:`Bearer ${token}`}});if(!r.ok)throw new Error(await r.text());const reader=r.body?.getReader();if(!reader)throw new Error("No progress stream");const dec=new TextDecoder();let buf="";while(true){const {done,value}=await reader.read();if(done)break;buf+=dec.decode(value,{stream:true});const lines=buf.split("\n");buf=lines.pop()||"";for(const line of lines){if(!line.trim())continue;try{const x=JSON.parse(line);if(x.status==="reprocessing_start")setReprocessProgress(`Starting ${x.checked}/${x.total}: ${x.reportTitle||"report"} · ${x.extracted||0} values · ${x.failed||0} failed`);else if(x.status==="reprocess_error")setReprocessProgress(`Failed ${x.checked}/${x.total}: ${x.error}`);else if(x.status==="done")setReprocessProgress(`Complete · ${x.result.attempted} attempted · ${x.result.reprocessed} reprocessed · ${x.result.extracted} values extracted · ${x.result.published} published · ${x.result.failed} failed`);else if(x.status==="error")setReprocessProgress(`Error: ${x.message}`)}catch{}}}await reload()}catch(e){setReprocessProgress(`Failed: ${String(e)}`)}finally{setReprocessBusy(false)}}
 return <div role="dialog" aria-modal="true" style={{position:"fixed",inset:0,background:"rgba(0,0,0,.35)",zIndex:1000,overflow:"auto",padding:24}}><div className="shell" style={{background:"white",margin:"20px auto",padding:24,borderRadius:18,maxWidth:1100}}><div className="section-head"><div><span className="kicker">Country configuration</span><h2>{config.country.name}</h2><p className="lead">Manage banks and the exact reporting portals the cron is allowed to fetch.</p></div><div style={{display:"flex",gap:8}}>
<button className="text-button" onClick={async()=>{const x=await api(`/api/admin/countries/${config.country.id}/repair`,token,{method:"POST"});alert(`Repaired ${x.documentsReassigned||0} report owners and ${x.recordsReassigned||0} value owners.`);reload()}}>Repair existing data</button><button className="button small" disabled={reprocessBusy} onClick={reprocessStored}>{reprocessBusy?"Reprocessing…":"Reprocess stored reports"}</button>
<button className="text-button" onClick={onClose}>Close</button>
</div></div>{reprocessProgress&&<div className="notice" style={{marginTop:12}}><b>Stored report reprocessing</b><p>{reprocessProgress}</p></div>}
 <div className="panel"><h3>Add bank</h3><form onSubmit={addBank} style={{display:"grid",gridTemplateColumns:"2fr 3fr auto",gap:10}}><input placeholder="Bank name" value={bank.name} onChange={e=>setBank({...bank,name:e.target.value})}/><input placeholder="Financial report portal URL" value={bank.sourceUrl} onChange={e=>setBank({...bank,sourceUrl:e.target.value})}/><button className="button">Add bank</button></form></div>
 <div className="panel"><h3>Add another reporting portal</h3><form onSubmit={addSource} style={{display:"grid",gridTemplateColumns:"2fr 4fr auto",gap:10}}><select value={sourceBank} onChange={e=>setSourceBank(e.target.value)}><option value="">Select bank</option>{config.banks.filter((b:Bank)=>b.active).map((b:Bank)=><option key={b.id} value={b.id}>{b.name}</option>)}</select><input placeholder="Official financial-report page" value={sourceUrl} onChange={e=>setSourceUrl(e.target.value)}/><button className="button">Add portal</button></form></div>
 <div className="table-wrap"><table><thead><tr><th>Bank</th><th>Website</th><th>Health</th><th>Report portal</th><th/></tr></thead><tbody>{config.banks.filter((b:Bank)=>b.active).map((b:Bank)=><tr key={b.id}><td><b>{b.name}</b><small>{b.slug}</small></td><td>{b.website||"—"}</td><td>{b.health_score||"Pending"}</td><td>{config.sources.filter((s:Source)=>s.bank_id===b.id).map((s:Source)=><div key={s.id} style={{marginBottom:10}}>
<a href={s.url} target="_blank" rel="noreferrer">{s.url}</a>
<div style={{display:"flex",gap:8,marginTop:4}}>
<button className="text-button" onClick={async()=>{const d=await api(`/api/admin/sources/${s.id}/diagnostics`,token);alert(`Last check: ${d.checks?.[0]?.status||"never"}${d.checks?.[0]?.error?`\\nError: ${d.checks[0].error}`:""}\\nReports stored: ${d.reports?.length||0}`)}}>Diagnostics</button>
<button className="text-button" onClick={async()=>{await api(`/api/admin/sources/${s.id}`,token,{method:"DELETE"});reload()}}>Remove</button>
</div>
</div>)}</td><td/></tr>)}</tbody></table></div>
 </div></div>
}
