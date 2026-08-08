import Review from "./Review";
import { useEffect, useState } from "react";

const ADMIN_RECOVERY_EMAIL = "sameultekyi@gmail.com";

type Country = {
  id: number; name: string; iso2: string; currency: string;
  regulator_name: string; enabled: number; discovery_status: string;
  bank_count: number; review_count: number;
};

async function api(path: string, token = "", options: RequestInit = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers },
  });
  const contentType = response.headers.get("content-type") || "";
  let body: any;
  if (contentType.includes("application/json")) {
    try {
      body = await response.json();
    } catch (e) {
      body = null;
    }
  } else {
    // fallback to text for HTML or plain error messages
    body = await response.text();
  }
  if (!response.ok) {
    const message = typeof body === "string" && body ? body : (body && body.error) || response.statusText || "Request failed";
    throw new Error(message);
  }
  return body;
}

export default function Admin() {
  const [token, setToken] = useState(localStorage.getItem("bl_admin") || "");
  const [username, setUsername] = useState("banklensadmin");
  const [password, setPassword] = useState("");
  const [resetToken, setResetToken] = useState(() => new URLSearchParams(window.location.search).get("reset") || "");
  const [resetPassword, setResetPassword] = useState("");
  const [resetConfirm, setResetConfirm] = useState("");

  if (token) return <Console token={token} logout={() => { localStorage.removeItem("bl_admin"); setToken(""); }} />;

  if (resetToken) return <section className="shell page auth-page">
    <form className="auth-card" onSubmit={async (event) => {
      event.preventDefault();
      if (resetPassword.length < 12) {
        alert("Use a password with at least 12 characters.");
        return;
      }
      if (resetPassword !== resetConfirm) {
        alert("The passwords do not match.");
        return;
      }
      try {
        await api("/api/auth/reset", "", { method: "POST", body: JSON.stringify({ token: resetToken, password: resetPassword }) });
        setResetToken("");
        setResetPassword("");
        setResetConfirm("");
        window.history.replaceState({}, "", "/admin");
        alert("Password updated. Sign in with the new password.");
      } catch (error) { alert(String(error)); }
    }}>
      <span className="brandmark">BL</span>
      <h1>Reset password</h1>
      <p>Use the secure link from your email to set a new admin password.</p>
      <label>New password<input type="password" value={resetPassword} onChange={(e) => setResetPassword(e.target.value)} /></label>
      <label>Confirm password<input type="password" value={resetConfirm} onChange={(e) => setResetConfirm(e.target.value)} /></label>
      <button className="button">Update password</button>
      <button type="button" className="text-button" onClick={() => { setResetToken(""); window.history.replaceState({}, "", "/admin"); }}>Back to sign in</button>
    </form>
  </section>;

  return <section className="shell page auth-page">
    <form className="auth-card" onSubmit={async (event) => {
      event.preventDefault();
      try {
        const result = await api("/api/auth/login", "", { method: "POST", body: JSON.stringify({ username, password }) });
        localStorage.setItem("bl_admin", result.token);
        setToken(result.token);
      } catch (error) { alert(String(error)); }
    }}>
      <span className="brandmark">BL</span>
      <h1>Admin sign in</h1>
      <p>Public BankLens pages remain open to everyone.</p>
      <label>Username<input value={username} onChange={(e) => setUsername(e.target.value)} /></label>
      <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      <button className="button">Sign in</button>
      <button type="button" className="text-button" onClick={async () => {
        await api("/api/auth/forgot", "", { method: "POST", body: JSON.stringify({ email: ADMIN_RECOVERY_EMAIL }) });
        alert(`If the email is registered, a reset link has been sent to ${ADMIN_RECOVERY_EMAIL}.`);
      }}>Forgot password?</button>
      <small>Recovery email: {ADMIN_RECOVERY_EMAIL}</small>
    </form>
  </section>;
}

function Console({ token, logout }: { token: string; logout: () => void }) {
  const [countries, setCountries] = useState<Country[]>([]);
  const [busy, setBusy] = useState<number>();
  const [runProgress, setRunProgress] = useState<Record<number,{percent:number,message?:string,checked?:number,total?:number,changed?:number,failed?:number}>>({});
  const [showReview, setShowReview] = useState(false);
  const load = () => api("/api/admin/countries", token).then((x) => setCountries(x.data));
  useEffect(() => { load().catch(logout); }, []);

  if (showReview) {
    return <Review token={token} onBack={() => { setShowReview(false); load(); }} />;
  }

  return <section className="shell page">
    <div className="section-head">
      <div><span className="kicker">Secure administration</span><h1>Smart discovery</h1><p className="lead">BankLens starts at each country's verified regulator, discovers licensed banks, then tracks official publications and contextual sources.</p></div>
      <div style={{display:'flex',gap:8}}>
        <button className="button small" onClick={() => setShowReview(true)}>Review & publish</button>
        <button onClick={async()=>{await api('/api/auth/forgot','',{method:'POST',body:JSON.stringify({email:ADMIN_RECOVERY_EMAIL})});alert(`If email delivery is configured, reset instructions have been sent to ${ADMIN_RECOVERY_EMAIL}.`)}} className="text-button small">Send password reset</button>
        <button onClick={logout} className="button small">Sign out</button>
      </div>
    </div>
    <div className="admin-stats">
      <div><b>{countries.length}</b><span>Countries</span></div>
      <div><b>{countries.filter((x) => x.enabled).length}</b><span>Active crawlers</span></div>
      <div><b>{countries.reduce((sum, x) => sum + x.review_count, 0)}</b><span>Items to review</span></div>
    </div>
    <div className="panel">
      <div className="section-head"><div><h2>Country discovery</h2><p>Only verified regulator seeds are crawled automatically.</p></div></div>
      <div className="table-wrap"><table><thead><tr><th>Country</th><th>Regulator</th><th>Banks</th><th>Review</th><th>Status</th><th>Enabled</th><th></th></tr></thead><tbody>
        {countries.map((country) => <tr key={country.id}>
          <td><b>{country.name}</b><small>{country.iso2} · {country.currency}</small></td>
          <td>{country.regulator_name}</td><td>{country.bank_count}</td><td><button className="text-button" onClick={() => setShowReview(true)} disabled={!country.review_count}>{country.review_count}</button></td><td>{country.discovery_status}</td>
          <td><button className={`toggle ${country.enabled ? "on" : ""}`} onClick={async () => { await api(`/api/admin/countries/${country.id}`, token, { method: "PATCH", body: JSON.stringify({ enabled: !country.enabled }) }); load(); }}><span /></button></td>
          <td>
            <div style={{display:'flex',gap:8,alignItems:'center'}}>
              <button className="text-button" disabled={busy === country.id || !country.enabled} onClick={async () => { setBusy(country.id); try { const result = await api(`/api/admin/countries/${country.id}/discover`, token, { method: "POST" }); alert(`Found ${result.linksFound} candidate links`); await load(); } finally { setBusy(undefined); } }}>{busy === country.id ? "Discovering..." : "Discover now"}</button>
              <button className="text-button" disabled={!country.enabled || runProgress[country.id]?.percent===100} onClick={async () => {
                // start streaming run
                setRunProgress(p=>({...p,[country.id]:{percent:0,message:'starting'}}));
                try{
                  const res = await fetch(`/api/admin/countries/${country.id}/run`,{method:'POST',headers:{Authorization:`Bearer ${token}`}});
                  if(!res.body) throw new Error('No stream available');
                  const reader = res.body.getReader();
                  const decoder = new TextDecoder();
                  let buf = '';
                  while(true){
                    const {done,value} = await reader.read();
                    if(done) break;
                    buf += decoder.decode(value, {stream:true});
                    const lines = buf.split('\n');
                    buf = lines.pop() || '';
                    for(const line of lines){
                      if(!line.trim()) continue;
                      try{ const obj = JSON.parse(line);
                        if(obj.status==='scanning'){
                          const percent = obj.total?Math.round((obj.checked/obj.total)*100):0;
                          setRunProgress(p=>({...p,[country.id]:{percent,message:obj.currentSourceId?`scanning ${obj.currentSourceId}`:'scanning',checked:obj.checked,total:obj.total,changed:obj.changed,failed:obj.failed}}));
                        } else if(obj.status==='discovered'){
                          setRunProgress(p=>({...p,[country.id]:{percent:5,message:`discovered ${obj.linksFound} links, imported ${obj.banksUpserted || 0} banks`}}));
                        } else if(obj.status==='done'){
                          setRunProgress(p=>({...p,[country.id]:{percent:100,message:'completed',checked:obj.scan.checked,total:obj.scan.total,changed:obj.scan.changed,failed:obj.scan.failed}}));
                        } else if(obj.status==='error'){
                          setRunProgress(p=>({...p,[country.id]:{percent:100,message:`error: ${obj.message}`}}));
                        }
                      }catch(e){}
                    }
                  }
                  await load();
                }catch(error){
                  setRunProgress(p=>({...p,[country.id]:{percent:100,message:`failed: ${String(error)}`}}));
                }
              }}>Run cron</button>
            </div>
            {runProgress[country.id] && <div style={{marginTop:6}}>
              <div style={{height:8,background:'#eee',borderRadius:4,overflow:'hidden'}}>
                <div style={{width:`${runProgress[country.id].percent}%`,height:8,background:'#2b80ff'}} />
              </div>
              <small>{runProgress[country.id].message || ''} {runProgress[country.id].checked?`(${runProgress[country.id].checked}/${runProgress[country.id].total})`:''}</small>
            </div>}
          </td>
        </tr>)}
      </tbody></table></div>
    </div>
    <aside className="notice"><b>Review before publishing</b><p>Financial filings, rates, fees, news and reviews are assigned different source types. News and customer sentiment never alter the financial-health score automatically.</p></aside>
  </section>;
}
