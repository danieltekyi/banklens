import { useEffect, useState } from "react";

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
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Request failed");
  return body;
}

export default function Admin() {
  const [token, setToken] = useState(localStorage.getItem("bl_admin") || "");
  const [username, setUsername] = useState("banklensadmin");
  const [password, setPassword] = useState("");

  if (token) return <Console token={token} logout={() => { localStorage.removeItem("bl_admin"); setToken(""); }} />;

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
        await api("/api/auth/forgot", "", { method: "POST", body: JSON.stringify({ email: "samueltekyi@gmail.com" }) });
        alert("If email delivery is configured, reset instructions have been sent.");
      }}>Forgot password?</button>
    </form>
  </section>;
}

function Console({ token, logout }: { token: string; logout: () => void }) {
  const [countries, setCountries] = useState<Country[]>([]);
  const [busy, setBusy] = useState<number>();
  const load = () => api("/api/admin/countries", token).then((x) => setCountries(x.data));
  useEffect(() => { load().catch(logout); }, []);

  return <section className="shell page">
    <div className="section-head">
      <div><span className="kicker">Secure administration</span><h1>Smart discovery</h1><p className="lead">BankLens starts at each country's verified regulator, discovers licensed banks, then tracks official publications and contextual sources.</p></div>
      <button onClick={logout} className="button small">Sign out</button>
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
          <td>{country.regulator_name}</td><td>{country.bank_count}</td><td>{country.review_count}</td><td>{country.discovery_status}</td>
          <td><button className={`toggle ${country.enabled ? "on" : ""}`} onClick={async () => { await api(`/api/admin/countries/${country.id}`, token, { method: "PATCH", body: JSON.stringify({ enabled: !country.enabled }) }); load(); }}><span /></button></td>
          <td><button className="text-button" disabled={busy === country.id || !country.enabled} onClick={async () => { setBusy(country.id); try { const result = await api(`/api/admin/countries/${country.id}/discover`, token, { method: "POST" }); alert(`Found ${result.linksFound} candidate links`); await load(); } finally { setBusy(undefined); } }}>{busy === country.id ? "Discovering..." : "Discover now"}</button></td>
        </tr>)}
      </tbody></table></div>
    </div>
    <aside className="notice"><b>Review before publishing</b><p>Financial filings, rates, fees, news and reviews are assigned different source types. News and customer sentiment never alter the financial-health score automatically.</p></aside>
  </section>;
}
