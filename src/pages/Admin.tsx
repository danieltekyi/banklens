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
 const [countries,setCountries]=useState<Country[]>([]),[selected,setSelected]=useState<number|null>(null),[config,setConfig]=useState<any>(null),[showAudit,setShowAudit]=useState(false);
 const [countryForm,setCountryForm]=useState({name:"",iso2:"",currency:""});
 const load=()=>api("/api/admin/countries",token).then(x=>setCountries(x.data));
 useEffect(()=>{load().catch(logout)},[]);
 async function openCountry(id:number){setSelected(id);setConfig(await api(`/api/admin/countries/${id}/config`,token));}
 async function createCountry(e:any){e.preventDefault();if(!countryForm.name||!countryForm.iso2||!countryForm.currency)return;await api("/api/admin/countries",token,{method:"POST",body:JSON.stringify(countryForm)});setCountryForm({name:"",iso2:"",currency:""});await load();}
 async function seedGhana(){try{const x=await api("/api/admin/ghana-starter",token,{method:"POST"});alert(`Ghana starter set ready: ${x.banksAdded} banks and ${x.sourcesAdded} reporting portals added.`);await load();}catch(e){alert(String(e))}}

 if(showAudit)return <Review token={token} onBack={()=>setShowAudit(false)}/>;
 return <section className="shell page"><div className="section-head"><div><span className="kicker">BankLens control centre</span><h1>Countries & reporting portals</h1><p className="lead">Configure countries, banks, and official financial-reporting sources. Financial collection and analysis run locally through Wrangler; Cloudflare serves the resulting data.</p></div><div style={{display:"flex",gap:8,flexWrap:"wrap"}}><button className="button small" onClick={()=>setShowAudit(true)}>Audit published data</button><button className="button small" onClick={logout}>Sign out</button></div></div>
 <div className="admin-stats"><div><b>{countries.length}</b><span>Countries</span></div><div><b>{countries.reduce((n,c)=>n+c.bank_count,0)}</b><span>Banks with portals</span></div>
 <div><b>{countries.reduce((n,c)=>n+(c.bank_total||c.bank_count),0)}</b><span>Total bank records</span></div><div><b>{countries.reduce((n,c)=>n+c.source_count,0)}</b><span>Report portals</span></div><div><b>{countries.reduce((n,c)=>n+c.report_count,0)}</b><span>Reports processed</span></div></div>
 <div className="panel"><div className="section-head"><div><h2>Add a country</h2><p>Create the country first, then add banks and the official pages where their financial reports are published.</p></div></div><form onSubmit={createCountry} style={{display:"grid",gridTemplateColumns:"2fr 1fr 1fr auto",gap:10}}><input placeholder="Country name" value={countryForm.name} onChange={e=>setCountryForm({...countryForm,name:e.target.value})}/><input placeholder="ISO2" maxLength={2} value={countryForm.iso2} onChange={e=>setCountryForm({...countryForm,iso2:e.target.value.toUpperCase()})}/><input placeholder="Currency" value={countryForm.currency} onChange={e=>setCountryForm({...countryForm,currency:e.target.value.toUpperCase()})}/><button className="button">Create country</button></form></div>
 <div className="panel"><div className="section-head"><div><h2>Configured countries</h2><p>Enable a country to make it eligible for the local BankLens collector. The local collector reads this configuration through Wrangler and publishes analysed results to Cloudflare D1.</p></div></div><div className="table-wrap"><table><thead><tr><th>Country</th><th>Banks</th><th>Portals</th><th>Reports</th><th>Last scan</th><th>Enabled</th><th/></tr></thead><tbody>{countries.map(c=><tr key={c.id}><td><button className="text-button" onClick={()=>openCountry(c.id)}><b>{c.name}</b></button><small>{c.iso2} · {c.currency}</small></td><td>{c.bank_count}</td><td>{c.source_count}</td><td>{c.report_count}</td><td>{c.last_scan_at?new Date(c.last_scan_at).toLocaleString():"Never"}</td><td><button className={`toggle ${c.enabled?"on":""}`} onClick={async()=>{await api(`/api/admin/countries/${c.id}`,token,{method:"PATCH",body:JSON.stringify({enabled:!c.enabled})});load()}}><span/></button></td><td><span className="muted">Local pipeline</span></td></tr>)}</tbody></table></div></div>
 {config&&selected&&<CountryConfig token={token} config={config} onClose={()=>{setConfig(null);setSelected(null)}} reload={()=>openCountry(selected)}/>} 
 </section>
}

function CountryConfig({token,config,onClose,reload}:{token:string;config:any;onClose:()=>void;reload:()=>void}){
 const [bank,setBank]=useState({name:"",sourceUrl:""});const [sourceBank,setSourceBank]=useState("");const [sourceUrl,setSourceUrl]=useState("");const [editingSource,setEditingSource]=useState<number|null>(null);const [editingUrl,setEditingUrl]=useState("");const [busyAction,setBusyAction]=useState<string|null>(null);
 async function addBank(e:any){e.preventDefault();await api(`/api/admin/countries/${config.country.id}/banks`,token,{method:"POST",body:JSON.stringify(bank)});setBank({name:"",sourceUrl:""});reload()}
 async function addSource(e:any){e.preventDefault();if(!sourceBank||!sourceUrl)return;await api(`/api/admin/banks/${sourceBank}/sources`,token,{method:"POST",body:JSON.stringify({url:sourceUrl})});setSourceUrl("");reload()}
 async function updateSource(id:number){const url=editingUrl.trim();if(!url)return;setBusyAction(`source-edit-${id}`);try{await api(`/api/admin/sources/${id}`,token,{method:"PATCH",body:JSON.stringify({url})});setEditingSource(null);setEditingUrl("");await reload()}catch(e){alert(String(e))}finally{setBusyAction(null)}}
 async function deleteSource(id:number,url:string){if(!confirm(`Remove this reporting portal?\n\n${url}\n\nExisting financial records will remain.`))return;setBusyAction(`source-delete-${id}`);try{await api(`/api/admin/sources/${id}`,token,{method:"DELETE"});await reload()}catch(e){alert(String(e))}finally{setBusyAction(null)}}
 async function deleteBank(bankId:number,bankName:string){if(!confirm(`DELETE ${bankName}?\n\nThis permanently removes the bank and all BankLens data belonging to it: portals, financial documents, extracted values, latest metrics and analysis.`))return;const typed=prompt(`Type the bank name exactly to confirm:\n\n${bankName}`);if(typed!==bankName)return alert("Deletion cancelled.");setBusyAction(`bank-delete-${bankId}`);try{const result=await api(`/api/admin/banks/${bankId}`,token,{method:"DELETE"});alert(`Deleted ${result.bankName||bankName}. Reports removed: ${result.documentsDeleted||0}; values removed: ${result.recordsDeleted||0}.`);await reload()}catch(e){alert(String(e))}finally{setBusyAction(null)}}

 return <div role="dialog" aria-modal="true" style={{position:"fixed",inset:0,background:"rgba(0,0,0,.35)",zIndex:1000,overflow:"auto",padding:24}}><div className="shell" style={{background:"white",margin:"20px auto",padding:24,borderRadius:18,maxWidth:1100}}><div className="section-head"><div><span className="kicker">Country configuration</span><h2>{config.country.name}</h2><p className="lead">Manage banks and the exact official reporting portals the local collector is allowed to fetch.</p></div><div style={{display:"flex",gap:8}}>
<button className="text-button" onClick={onClose}>Close</button>
</div></div>
 <div className="panel"><h3>Add bank</h3><form onSubmit={addBank} style={{display:"grid",gridTemplateColumns:"2fr 3fr auto",gap:10}}><input placeholder="Bank name" value={bank.name} onChange={e=>setBank({...bank,name:e.target.value})}/><input placeholder="Financial report portal URL" value={bank.sourceUrl} onChange={e=>setBank({...bank,sourceUrl:e.target.value})}/><button className="button">Add bank</button></form></div>
 <div className="panel"><h3>Add another reporting portal</h3><form onSubmit={addSource} style={{display:"grid",gridTemplateColumns:"2fr 4fr auto",gap:10}}><select value={sourceBank} onChange={e=>setSourceBank(e.target.value)}><option value="">Select bank</option>{config.banks.filter((b:Bank)=>b.active).map((b:Bank)=><option key={b.id} value={b.id}>{b.name}</option>)}</select><input placeholder="Official financial-report page" value={sourceUrl} onChange={e=>setSourceUrl(e.target.value)}/><button className="button">Add portal</button></form></div>
 <div className="table-wrap"><table><thead><tr><th>Bank</th><th>Website</th><th>Health</th><th>Report portal</th><th/></tr></thead><tbody>{config.banks.filter((b:Bank)=>b.active).map((b:Bank)=><tr key={b.id}><td><b>{b.name}</b><small>{b.slug}</small></td><td>{b.website||"—"}</td><td>{b.health_score||"Pending"}</td><td>{config.sources.filter((s:Source)=>s.bank_id===b.id).map((s:Source)=><div key={s.id} style={{marginBottom:12,paddingBottom:10,borderBottom:"1px solid #eee"}}>
 {editingSource===s.id ? <div style={{display:"grid",gridTemplateColumns:"1fr auto auto",gap:8,alignItems:"center"}}>
   <input value={editingUrl} onChange={e=>setEditingUrl(e.target.value)} />
   <button className="button small" disabled={busyAction===`source-edit-${s.id}`} onClick={()=>updateSource(s.id)}>{busyAction===`source-edit-${s.id}`?"Saving…":"Save"}</button>
   <button className="text-button small" disabled={!!busyAction} onClick={()=>{setEditingSource(null);setEditingUrl("")}}>Cancel</button>
 </div> : <>
   <a href={s.url} target="_blank" rel="noreferrer">{s.url}</a>
   <div style={{display:"flex",gap:8,marginTop:5,flexWrap:"wrap"}}>
     <button className="text-button small" onClick={()=>{setEditingSource(s.id);setEditingUrl(s.url)}}>Edit link</button>
     <button className="text-button small" disabled={busyAction===`source-delete-${s.id}`} onClick={()=>deleteSource(s.id,s.url)}>{busyAction===`source-delete-${s.id}`?"Removing…":"Remove portal"}</button>
   </div>
 </>}
</div>)}</td><td><button className="text-button small" style={{color:"#b42318"}} disabled={!!busyAction} onClick={()=>deleteBank(b.id,b.name)}>{busyAction===`bank-delete-${b.id}`?"Deleting…":"Delete bank"}</button></td></tr>)}</tbody></table></div>
 <aside className="notice" style={{marginTop:12}}>
   <b>Permanent deletion</b>
   <p>Deleting a bank removes its configured portals and all stored BankLens financial data for that bank. Editing a portal changes the source used by the next local Wrangler run.</p>
 </aside>
 </div></div>
}
