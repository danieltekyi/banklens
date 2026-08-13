import { useCallback, useEffect, useMemo, useState } from "react";
import Review from "./Review";
import "../admin.css";

const ADMIN_RECOVERY_EMAIL = "sameultekyi@gmail.com";

type Country = {
  id: number;
  name: string;
  iso2: string;
  currency: string;
  regulator_name: string;
  regulator_url?: string | null;
  bank_directory_url?: string | null;
  enabled: number;
  bank_count: number;
  bank_total?: number;
  source_count: number;
  report_count: number;
  last_scan_at?: string | null;
};

type Bank = {
  id: number;
  name: string;
  slug: string;
  short_name?: string | null;
  website?: string | null;
  active: number;
  health_score: number;
};

type Source = {
  id: number;
  bank_id: number;
  bank_name: string;
  url: string;
  source_type: string;
  active: number;
};

type Product = {
  id: number;
  bank_id: number;
  product_name: string;
  product_type: string;
  category?: string | null;
  rate?: number | null;
  fee?: number | null;
  min_amount?: number | null;
  tenor_months?: number | null;
  eligibility?: string | null;
  currency?: string | null;
  source_url?: string | null;
  source_title?: string | null;
  status: string;
};

async function api(path: string, token = "", options: RequestInit = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const contentType = res.headers.get("content-type") || "";
  const body = contentType.includes("json") ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) {
    const message =
      typeof body === "string" ? body : body?.error || body?.message || res.statusText || "Request failed";
    const error = new Error(message) as Error & { status?: number };
    error.status = res.status;
    throw error;
  }
  return body;
}

function errorText(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

export default function Admin() {
  const [token, setToken] = useState(localStorage.getItem("bl_admin") || "");
  const [resetToken, setResetToken] = useState(() => new URLSearchParams(location.search).get("reset") || "");

  const signOut = useCallback(() => {
    localStorage.removeItem("bl_admin");
    setToken("");
  }, []);

  if (resetToken) return <ResetPassword resetToken={resetToken} onDone={() => setResetToken("")} />;
  if (!token)
    return (
      <SignIn
        onSignedIn={(next) => {
          localStorage.setItem("bl_admin", next);
          setToken(next);
        }}
      />
    );
  return <Console token={token} signOut={signOut} />;
}

function SignIn({ onSignedIn }: { onSignedIn: (token: string) => void }) {
  const [username, setUsername] = useState("banklensadmin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <section className="shell page auth-page">
      <form
        className="auth-card"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          try {
            const result = await api("/api/auth/login", "", {
              method: "POST",
              body: JSON.stringify({ username, password }),
            });
            onSignedIn(result.token);
          } catch (err) {
            setError(errorText(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <span className="brandmark">BL</span>
        <h1>Admin sign in</h1>
        <p>
          Configure countries, their commercial banks, and the official portals where financial reports are published.
        </p>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        <button className="button" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <button
          type="button"
          className="text-button"
          onClick={async () => {
            try {
              await api("/api/auth/forgot", "", {
                method: "POST",
                body: JSON.stringify({ email: ADMIN_RECOVERY_EMAIL }),
              });
              alert("If the email is registered, reset instructions have been sent.");
            } catch (err) {
              setError(errorText(err));
            }
          }}
        >
          Forgot password?
        </button>
      </form>
    </section>
  );
}

function ResetPassword({ resetToken, onDone }: { resetToken: string; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");

  return (
    <section className="shell page auth-page">
      <form
        className="auth-card"
        onSubmit={async (event) => {
          event.preventDefault();
          if (password.length < 12) return setError("Use at least 12 characters.");
          if (password !== confirm) return setError("Both passwords must match.");
          try {
            await api("/api/auth/reset", "", {
              method: "POST",
              body: JSON.stringify({ token: resetToken, password }),
            });
            history.replaceState({}, "", "/admin");
            onDone();
            alert("Password updated. Sign in with your new password.");
          } catch (err) {
            setError(errorText(err));
          }
        }}
      >
        <span className="brandmark">BL</span>
        <h1>Reset password</h1>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <label>
          New password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <label>
          Confirm password
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </label>
        <button className="button">Update password</button>
      </form>
    </section>
  );
}

function Console({ token, signOut }: { token: string; signOut: () => void }) {
  const [countries, setCountries] = useState<Country[]>([]);
  const [openCountryId, setOpenCountryId] = useState<number | null>(null);
  const [config, setConfig] = useState<any>(null);
  const [view, setView] = useState<"countries" | "audit" | "log">("countries");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const loadCountries = useCallback(async () => {
    const result = await api("/api/admin/countries", token);
    setCountries(result.data);
  }, [token]);

  const loadConfig = useCallback(
    async (id: number) => {
      setConfig(await api(`/api/admin/countries/${id}/config`, token));
    },
    [token],
  );

  useEffect(() => {
    loadCountries()
      .catch((err) => {
        if ((err as { status?: number }).status === 401) signOut();
        else setError(errorText(err));
      })
      .finally(() => setLoading(false));
  }, [loadCountries, signOut]);

  const refreshAll = useCallback(async () => {
    await loadCountries();
    if (openCountryId) await loadConfig(openCountryId);
  }, [loadCountries, loadConfig, openCountryId]);

  const totals = useMemo(
    () => ({
      countries: countries.length,
      banksWithPortals: countries.reduce((n, c) => n + c.bank_count, 0),
      banks: countries.reduce((n, c) => n + (c.bank_total ?? c.bank_count), 0),
      portals: countries.reduce((n, c) => n + c.source_count, 0),
      reports: countries.reduce((n, c) => n + c.report_count, 0),
    }),
    [countries],
  );

  if (view === "audit") return <Review token={token} onBack={() => setView("countries")} />;
  if (view === "log") return <AuditLog token={token} onBack={() => setView("countries")} />;

  return (
    <section className="shell page">
      <div className="section-head">
        <div>
          <span className="kicker">BankLens control centre</span>
          <h1>Countries &amp; reporting portals</h1>
          <p className="lead">
            Configure countries, their commercial banks, and the exact official pages where each bank publishes its
            audited financial reports. The local collector reads this configuration and publishes analysed results back
            to Cloudflare.
          </p>
        </div>
        <div className="admin-actions">
          <button className="button small" onClick={() => setView("audit")}>
            Audit published data
          </button>
          <button className="button small" onClick={() => setView("log")}>
            Activity log
          </button>
          <button className="button small" onClick={signOut}>
            Sign out
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}

      <div className="admin-stats">
        <div>
          <b>{totals.countries}</b>
          <span>Countries</span>
        </div>
        <div>
          <b>{totals.banksWithPortals}</b>
          <span>Banks with portals</span>
        </div>
        <div>
          <b>{totals.banks}</b>
          <span>Total bank records</span>
        </div>
        <div>
          <b>{totals.portals}</b>
          <span>Report portals</span>
        </div>
        <div>
          <b>{totals.reports}</b>
          <span>Reports processed</span>
        </div>
      </div>

      <AddCountry token={token} onCreated={loadCountries} />

      <div className="panel">
        <div className="section-head">
          <div>
            <h2>Configured countries</h2>
            <p>
              Enable a country to make it eligible for the local collector. Select a country to manage its banks and
              reporting portals.
            </p>
          </div>
        </div>
        {loading ? (
          <p className="loading">Loading configuration…</p>
        ) : countries.length === 0 ? (
          <p className="empty-state">No countries yet. Add the first one above to begin.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Country</th>
                  <th>Banks</th>
                  <th>Portals</th>
                  <th>Reports</th>
                  <th>Last scan</th>
                  <th>Enabled</th>
                  <th>Manage</th>
                </tr>
              </thead>
              <tbody>
                {countries.map((country) => (
                  <CountryRow
                    key={country.id}
                    token={token}
                    country={country}
                    onChanged={loadCountries}
                    onOpen={async () => {
                      setOpenCountryId(country.id);
                      await loadConfig(country.id);
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {config && openCountryId && (
        <CountryConfig
          token={token}
          config={config}
          onClose={() => {
            setConfig(null);
            setOpenCountryId(null);
          }}
          reload={refreshAll}
        />
      )}
    </section>
  );
}

function AddCountry({ token, onCreated }: { token: string; onCreated: () => Promise<void> }) {
  const [form, setForm] = useState({ name: "", iso2: "", currency: "", regulatorName: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <div className="panel">
      <div className="section-head">
        <div>
          <h2>Add a country</h2>
          <p>Create the country first, then add its banks and the official pages where their reports are published.</p>
        </div>
      </div>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <form
        className="admin-form country-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!form.name.trim() || !form.iso2.trim() || !form.currency.trim()) {
            return setError("Country name, ISO2 code and currency are all required.");
          }
          setBusy(true);
          setError("");
          try {
            await api("/api/admin/countries", token, { method: "POST", body: JSON.stringify(form) });
            setForm({ name: "", iso2: "", currency: "", regulatorName: "" });
            await onCreated();
          } catch (err) {
            setError(errorText(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Country name
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ghana" />
        </label>
        <label>
          ISO2
          <input
            value={form.iso2}
            maxLength={2}
            onChange={(e) => setForm({ ...form, iso2: e.target.value.toUpperCase() })}
            placeholder="GH"
          />
        </label>
        <label>
          Currency
          <input
            value={form.currency}
            onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })}
            placeholder="GHS"
          />
        </label>
        <label>
          Regulator (optional)
          <input
            value={form.regulatorName}
            onChange={(e) => setForm({ ...form, regulatorName: e.target.value })}
            placeholder="Bank of Ghana"
          />
        </label>
        <button className="button" disabled={busy}>
          {busy ? "Creating…" : "Create country"}
        </button>
      </form>
    </div>
  );
}

function CountryRow({
  token,
  country,
  onChanged,
  onOpen,
}: {
  token: string;
  country: Country;
  onChanged: () => Promise<void>;
  onOpen: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    name: country.name,
    iso2: country.iso2,
    currency: country.currency,
    regulatorName: country.regulator_name || "",
  });
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await api(`/api/admin/countries/${country.id}`, token, { method: "PATCH", body: JSON.stringify(form) });
      setEditing(false);
      await onChanged();
    } catch (err) {
      alert(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    const bankTotal = country.bank_total ?? country.bank_count;
    const warning =
      bankTotal > 0
        ? `Delete ${country.name}?\n\nThis also permanently deletes ${bankTotal} bank record(s) and every report, value and analysis belonging to them.`
        : `Delete ${country.name}?`;
    if (!confirm(warning)) return;
    const typed = prompt(`Type the ISO2 code to confirm deletion of ${country.name}:\n\n${country.iso2}`);
    if (typed !== country.iso2) return alert("Deletion cancelled.");
    setBusy(true);
    try {
      const result = await api(`/api/admin/countries/${country.id}?confirm=${country.iso2}`, token, {
        method: "DELETE",
      });
      alert(
        `Deleted ${result.countryName}. Banks removed: ${result.banksDeleted}; reports removed: ${result.documentsDeleted}; values removed: ${result.recordsDeleted}.`,
      );
      await onChanged();
    } catch (err) {
      alert(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <tr>
        <td colSpan={7}>
          <div className="inline-edit">
            <label>
              Name
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            <label>
              ISO2
              <input
                value={form.iso2}
                maxLength={2}
                onChange={(e) => setForm({ ...form, iso2: e.target.value.toUpperCase() })}
              />
            </label>
            <label>
              Currency
              <input
                value={form.currency}
                onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })}
              />
            </label>
            <label>
              Regulator
              <input value={form.regulatorName} onChange={(e) => setForm({ ...form, regulatorName: e.target.value })} />
            </label>
            <div className="inline-edit-actions">
              <button className="button small" disabled={busy} onClick={save}>
                {busy ? "Saving…" : "Save"}
              </button>
              <button
                className="text-button"
                disabled={busy}
                onClick={() => {
                  setForm({
                    name: country.name,
                    iso2: country.iso2,
                    currency: country.currency,
                    regulatorName: country.regulator_name || "",
                  });
                  setEditing(false);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td>
        <button className="text-button" onClick={onOpen}>
          <b>{country.name}</b>
        </button>
        <small>
          {country.iso2} · {country.currency}
          {country.regulator_name ? ` · ${country.regulator_name}` : ""}
        </small>
      </td>
      <td>{country.bank_count}</td>
      <td>{country.source_count}</td>
      <td>{country.report_count}</td>
      <td>{country.last_scan_at ? new Date(country.last_scan_at).toLocaleString() : "Never"}</td>
      <td>
        <button
          className={`toggle ${country.enabled ? "on" : ""}`}
          aria-label={`${country.enabled ? "Disable" : "Enable"} ${country.name}`}
          aria-pressed={!!country.enabled}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api(`/api/admin/countries/${country.id}`, token, {
                method: "PATCH",
                body: JSON.stringify({ enabled: !country.enabled }),
              });
              await onChanged();
            } catch (err) {
              alert(errorText(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <span />
        </button>
      </td>
      <td>
        <div className="row-actions">
          <button className="text-button small" onClick={onOpen}>
            Banks
          </button>
          <button className="text-button small" onClick={() => setEditing(true)}>
            Edit
          </button>
          <button className="text-button small danger" disabled={busy} onClick={remove}>
            Delete
          </button>
        </div>
      </td>
    </tr>
  );
}

function CountryConfig({
  token,
  config,
  onClose,
  reload,
}: {
  token: string;
  config: any;
  onClose: () => void;
  reload: () => Promise<void>;
}) {
  const [bankForm, setBankForm] = useState({ name: "", sourceUrl: "" });
  const [portalBank, setPortalBank] = useState("");
  const [portalUrl, setPortalUrl] = useState("");
  const [showRemoved, setShowRemoved] = useState(false);
  const [productBank, setProductBank] = useState<Bank | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const banks: Bank[] = (config.banks || []).filter((b: Bank) => b.active);
  const sources: Source[] = config.sources || [];

  async function addBank(event: React.FormEvent) {
    event.preventDefault();
    if (!bankForm.name.trim()) return setError("Bank name is required.");
    setBusy(true);
    setError("");
    try {
      await api(`/api/admin/countries/${config.country.id}/banks`, token, {
        method: "POST",
        body: JSON.stringify(bankForm),
      });
      setBankForm({ name: "", sourceUrl: "" });
      await reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function addPortal(event: React.FormEvent) {
    event.preventDefault();
    if (!portalBank || !portalUrl.trim()) return setError("Select a bank and enter the portal URL.");
    setBusy(true);
    setError("");
    try {
      await api(`/api/admin/banks/${portalBank}/sources`, token, {
        method: "POST",
        body: JSON.stringify({ url: portalUrl }),
      });
      setPortalUrl("");
      await reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={`${config.country.name} configuration`}>
      <div className="modal-card shell">
        <div className="section-head">
          <div>
            <span className="kicker">Country configuration</span>
            <h2>{config.country.name}</h2>
            <p className="lead">
              Manage the commercial banks of interest and the exact official reporting portals the local collector is
              allowed to fetch.
            </p>
          </div>
          <button className="text-button" onClick={onClose}>
            Close
          </button>
        </div>

        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}

        <div className="panel">
          <h3>Add a bank</h3>
          <form className="admin-form bank-form" onSubmit={addBank}>
            <label>
              Bank name
              <input
                value={bankForm.name}
                onChange={(e) => setBankForm({ ...bankForm, name: e.target.value })}
                placeholder="GCB Bank PLC"
              />
            </label>
            <label>
              Financial report portal URL
              <input
                value={bankForm.sourceUrl}
                onChange={(e) => setBankForm({ ...bankForm, sourceUrl: e.target.value })}
                placeholder="https://www.gcbbank.com.gh/group-results-and-reporting"
              />
            </label>
            <button className="button" disabled={busy}>
              Add bank
            </button>
          </form>
        </div>

        <div className="panel">
          <h3>Add another reporting portal</h3>
          <p className="source-note">A bank may publish across more than one page. Add each one here.</p>
          <form className="admin-form bank-form" onSubmit={addPortal}>
            <label>
              Bank
              <select value={portalBank} onChange={(e) => setPortalBank(e.target.value)}>
                <option value="">Select bank</option>
                {banks.map((bank) => (
                  <option key={bank.id} value={bank.id}>
                    {bank.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Official financial-report page
              <input
                value={portalUrl}
                onChange={(e) => setPortalUrl(e.target.value)}
                placeholder="https://bank.example/investor-relations"
              />
            </label>
            <button className="button" disabled={busy}>
              Add portal
            </button>
          </form>
        </div>

        <div className="section-head">
          <div>
            <h3>Banks and portals</h3>
          </div>
          <label className="checkbox-inline">
            <input type="checkbox" checked={showRemoved} onChange={(e) => setShowRemoved(e.target.checked)} />
            Show removed portals
          </label>
        </div>

        {banks.length === 0 ? (
          <p className="empty-state">No banks configured for {config.country.name} yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Bank</th>
                  <th>Website</th>
                  <th>Score</th>
                  <th>Reporting portals</th>
                  <th>Manage</th>
                </tr>
              </thead>
              <tbody>
                {banks.map((bank) => (
                  <BankRow
                    key={bank.id}
                    token={token}
                    bank={bank}
                    sources={sources.filter((s) => s.bank_id === bank.id && (showRemoved || s.active))}
                    reload={reload}
                    onManageProducts={() => setProductBank(bank)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        <aside className="notice">
          <b>What deletion does</b>
          <p>
            Removing a portal stops future collection but keeps the reports and values already gathered from it, so
            existing figures stay citable. Purging a portal, or deleting a bank, permanently destroys those reports,
            their stored files and every extracted value.
          </p>
        </aside>

        {productBank && <ProductManager token={token} bank={productBank} onClose={() => setProductBank(null)} />}
      </div>
    </div>
  );
}

function BankRow({
  token,
  bank,
  sources,
  reload,
  onManageProducts,
}: {
  token: string;
  bank: Bank;
  sources: Source[];
  reload: () => Promise<void>;
  onManageProducts: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    name: bank.name,
    shortName: bank.short_name || "",
    website: bank.website || "",
  });
  const [busy, setBusy] = useState<string | null>(null);

  async function saveBank() {
    setBusy("bank");
    try {
      await api(`/api/admin/banks/${bank.id}`, token, { method: "PATCH", body: JSON.stringify(form) });
      setEditing(false);
      await reload();
    } catch (err) {
      alert(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  async function deleteBank() {
    if (
      !confirm(
        `DELETE ${bank.name}?\n\nThis permanently removes the bank and all BankLens data belonging to it: portals, reports, stored files, extracted values, product rates and analysis.`,
      )
    )
      return;
    const typed = prompt(`Type the bank name exactly to confirm:\n\n${bank.name}`);
    if (typed !== bank.name) return alert("Deletion cancelled.");
    setBusy("delete");
    try {
      const result = await api(`/api/admin/banks/${bank.id}`, token, { method: "DELETE" });
      alert(
        `Deleted ${result.bankName}.\nReports removed: ${result.documentsDeleted}\nValues removed: ${result.recordsDeleted}\nPortals removed: ${result.sourcesDeleted}\nProducts removed: ${result.productsDeleted}`,
      );
      await reload();
    } catch (err) {
      alert(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <tr>
      <td>
        {editing ? (
          <div className="inline-edit">
            <label>
              Name
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            <label>
              Short name
              <input value={form.shortName} onChange={(e) => setForm({ ...form, shortName: e.target.value })} />
            </label>
            <label>
              Website
              <input value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} />
            </label>
            <div className="inline-edit-actions">
              <button className="button small" disabled={busy === "bank"} onClick={saveBank}>
                {busy === "bank" ? "Saving…" : "Save"}
              </button>
              <button
                className="text-button"
                onClick={() => {
                  setForm({ name: bank.name, shortName: bank.short_name || "", website: bank.website || "" });
                  setEditing(false);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            <b>{bank.name}</b>
            <small>{bank.slug}</small>
          </>
        )}
      </td>
      <td>
        {bank.website ? (
          <a href={bank.website} target="_blank" rel="noreferrer">
            {bank.website.replace(/^https?:\/\//, "")}
          </a>
        ) : (
          <span className="muted">Not set</span>
        )}
      </td>
      <td>{bank.health_score ? Math.round(bank.health_score) : <span className="muted">Pending</span>}</td>
      <td>
        {sources.length === 0 ? (
          <span className="muted">No portal configured</span>
        ) : (
          sources.map((source) => <SourceRow key={source.id} token={token} source={source} reload={reload} />)
        )}
      </td>
      <td>
        <div className="row-actions">
          <button className="text-button small" onClick={() => setEditing(true)}>
            Edit
          </button>
          <button className="text-button small" onClick={onManageProducts}>
            Rates
          </button>
          <button className="text-button small danger" disabled={busy === "delete"} onClick={deleteBank}>
            {busy === "delete" ? "Deleting…" : "Delete"}
          </button>
        </div>
      </td>
    </tr>
  );
}

function SourceRow({ token, source, reload }: { token: string; source: Source; reload: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState(source.url);
  const [busy, setBusy] = useState<string | null>(null);

  async function save() {
    if (!url.trim()) return alert("Portal URL cannot be empty.");
    setBusy("save");
    try {
      await api(`/api/admin/sources/${source.id}`, token, { method: "PATCH", body: JSON.stringify({ url }) });
      setEditing(false);
      await reload();
    } catch (err) {
      alert(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  async function setActive(active: boolean) {
    setBusy("active");
    try {
      await api(`/api/admin/sources/${source.id}`, token, { method: "PATCH", body: JSON.stringify({ active }) });
      await reload();
    } catch (err) {
      alert(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!confirm(`Stop collecting from this portal?\n\n${source.url}\n\nReports and values already gathered are kept.`))
      return;
    setBusy("remove");
    try {
      await api(`/api/admin/sources/${source.id}`, token, { method: "DELETE" });
      await reload();
    } catch (err) {
      alert(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  async function purge() {
    if (
      !confirm(
        `PERMANENTLY delete this portal and everything collected from it?\n\n${source.url}\n\nThis destroys its reports, stored files and extracted values. This cannot be undone.`,
      )
    )
      return;
    setBusy("purge");
    try {
      const result = await api(`/api/admin/sources/${source.id}?purge=1`, token, { method: "DELETE" });
      alert(`Purged. Reports removed: ${result.documentsDeleted}; values removed: ${result.recordsDeleted}.`);
      await reload();
    } catch (err) {
      alert(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  if (editing) {
    return (
      <div className="portal-row">
        <div className="inline-edit-actions">
          <input value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Portal URL" />
          <button className="button small" disabled={busy === "save"} onClick={save}>
            {busy === "save" ? "Saving…" : "Save"}
          </button>
          <button
            className="text-button"
            onClick={() => {
              setUrl(source.url);
              setEditing(false);
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`portal-row ${source.active ? "" : "portal-removed"}`}>
      <a href={source.url} target="_blank" rel="noreferrer">
        {source.url}
      </a>
      {!source.active && <span className="pill">Removed</span>}
      <div className="row-actions">
        {source.active ? (
          <>
            <button className="text-button small" onClick={() => setEditing(true)}>
              Edit link
            </button>
            <button className="text-button small" disabled={!!busy} onClick={remove}>
              {busy === "remove" ? "Removing…" : "Remove"}
            </button>
          </>
        ) : (
          <button className="text-button small" disabled={!!busy} onClick={() => setActive(true)}>
            Restore
          </button>
        )}
        <button className="text-button small danger" disabled={!!busy} onClick={purge}>
          {busy === "purge" ? "Purging…" : "Purge"}
        </button>
      </div>
    </div>
  );
}

function ProductManager({ token, bank, onClose }: { token: string; bank: Bank; onClose: () => void }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const emptyForm = {
    productName: "",
    productType: "deposit",
    category: "",
    rate: "",
    fee: "",
    minAmount: "",
    tenorMonths: "",
    eligibility: "",
    sourceUrl: "",
    sourceTitle: "",
  };
  const [form, setForm] = useState(emptyForm);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const result = await api(`/api/admin/banks/${bank.id}/products`, token);
    setProducts(result.data);
  }, [bank.id, token]);

  useEffect(() => {
    load()
      .catch((err) => setError(errorText(err)))
      .finally(() => setLoading(false));
  }, [load]);

  const numeric = (value: string) => (value.trim() === "" ? null : Number(value));

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={`${bank.name} rates and products`}>
      <div className="modal-card shell">
        <div className="section-head">
          <div>
            <span className="kicker">Rates and products</span>
            <h2>{bank.name}</h2>
            <p className="lead">
              These are the deposit and credit terms shown to customers on the decision page. Statutory financial
              reports are collected automatically; product pricing is published outside the audited accounts, so it is
              maintained here. Always record the source page.
            </p>
          </div>
          <button className="text-button" onClick={onClose}>
            Close
          </button>
        </div>

        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}

        <div className="panel">
          <h3>Add a product</h3>
          <form
            className="admin-form product-form"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!form.productName.trim()) return setError("Product name is required.");
              setBusy(true);
              setError("");
              try {
                await api(`/api/admin/banks/${bank.id}/products`, token, {
                  method: "POST",
                  body: JSON.stringify({
                    ...form,
                    rate: numeric(form.rate),
                    fee: numeric(form.fee),
                    minAmount: numeric(form.minAmount),
                    tenorMonths: numeric(form.tenorMonths),
                  }),
                });
                setForm(emptyForm);
                await load();
              } catch (err) {
                setError(errorText(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              Product name
              <input
                value={form.productName}
                onChange={(e) => setForm({ ...form, productName: e.target.value })}
                placeholder="Premium Savings Account"
              />
            </label>
            <label>
              Type
              <select value={form.productType} onChange={(e) => setForm({ ...form, productType: e.target.value })}>
                <option value="deposit">Deposit / savings</option>
                <option value="credit">Credit / loan</option>
                <option value="account">Current account</option>
                <option value="transfer">Transfers</option>
              </select>
            </label>
            <label>
              Category
              <input
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
                placeholder="savings, fixed_deposit, personal_loan…"
              />
            </label>
            <label>
              Rate (% per year)
              <input
                value={form.rate}
                onChange={(e) => setForm({ ...form, rate: e.target.value })}
                inputMode="decimal"
              />
            </label>
            <label>
              Fee
              <input value={form.fee} onChange={(e) => setForm({ ...form, fee: e.target.value })} inputMode="decimal" />
            </label>
            <label>
              Minimum amount
              <input
                value={form.minAmount}
                onChange={(e) => setForm({ ...form, minAmount: e.target.value })}
                inputMode="decimal"
              />
            </label>
            <label>
              Tenor (months)
              <input
                value={form.tenorMonths}
                onChange={(e) => setForm({ ...form, tenorMonths: e.target.value })}
                inputMode="numeric"
              />
            </label>
            <label>
              Eligibility
              <input value={form.eligibility} onChange={(e) => setForm({ ...form, eligibility: e.target.value })} />
            </label>
            <label className="wide">
              Source URL
              <input
                value={form.sourceUrl}
                onChange={(e) => setForm({ ...form, sourceUrl: e.target.value })}
                placeholder="https://bank.example/rates"
              />
            </label>
            <label className="wide">
              Source title
              <input
                value={form.sourceTitle}
                onChange={(e) => setForm({ ...form, sourceTitle: e.target.value })}
                placeholder="Published rate card, July 2026"
              />
            </label>
            <button className="button" disabled={busy}>
              {busy ? "Adding…" : "Add product"}
            </button>
          </form>
        </div>

        {loading ? (
          <p className="loading">Loading products…</p>
        ) : products.length === 0 ? (
          <p className="empty-state">
            No products recorded for {bank.name}. Customers will not see this bank on the decision page until at least
            one rate is added.
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Type</th>
                  <th>Rate</th>
                  <th>Fee</th>
                  <th>Minimum</th>
                  <th>Source</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {products.map((product) => (
                  <tr key={product.id}>
                    <td>
                      <b>{product.product_name}</b>
                      <small>{product.category || "—"}</small>
                    </td>
                    <td>{product.product_type}</td>
                    <td>{product.rate == null ? <span className="muted">—</span> : `${product.rate}%`}</td>
                    <td>{product.fee == null ? <span className="muted">—</span> : product.fee}</td>
                    <td>{product.min_amount == null ? <span className="muted">—</span> : product.min_amount}</td>
                    <td>
                      {product.source_url ? (
                        <a href={product.source_url} target="_blank" rel="noreferrer">
                          {product.source_title || "Source"}
                        </a>
                      ) : (
                        <span className="muted">No source</span>
                      )}
                    </td>
                    <td>
                      <button
                        className="text-button small danger"
                        onClick={async () => {
                          if (!confirm(`Delete "${product.product_name}"?`)) return;
                          try {
                            await api(`/api/admin/products/${product.id}`, token, { method: "DELETE" });
                            await load();
                          } catch (err) {
                            alert(errorText(err));
                          }
                        }}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function AuditLog({ token, onBack }: { token: string; onBack: () => void }) {
  const [entries, setEntries] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    api("/api/admin/audit-log?limit=200", token)
      .then((result) => setEntries(result.data))
      .catch((err) => setError(errorText(err)))
      .finally(() => setLoading(false));
  }, [token]);

  return (
    <section className="shell page">
      <div className="section-head">
        <div>
          <span className="kicker">Activity</span>
          <h1>Administrative changes</h1>
          <p className="lead">Every create, amendment and deletion made through this console.</p>
        </div>
        <button className="button small" onClick={onBack}>
          Back
        </button>
      </div>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {loading ? (
        <p className="loading">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="empty-state">Nothing recorded yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>Action</th>
                <th>Entity</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td>{new Date(entry.created_at).toLocaleString()}</td>
                  <td>{entry.actor || "—"}</td>
                  <td>{entry.action}</td>
                  <td>
                    <b>{entry.entity_label || entry.entity_type}</b>
                    <small>{entry.entity_type}</small>
                  </td>
                  <td className="detail-cell">{entry.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
