import { useEffect, useMemo, useState } from "react";

type ReviewItem = {
  id: number | string;
  country_name?: string | null;
  country_iso2?: string | null;
  url?: string | null;
  kind?: string | null;
  title?: string | null;
  status?: string | null;
  discovered_at?: string | null;
  [key: string]: unknown;
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

  if (!response.ok) {
    const message =
      typeof body === "string" && body
        ? body
        : body?.error || body?.message || response.statusText || "Request failed";
    throw new Error(message);
  }
  return body;
}

function listFromResponse(body: any): ReviewItem[] {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.data)) return body.data;
  return [];
}

function text(item: ReviewItem, ...keys: string[]) {
  for (const key of keys) {
    const value = item[key];
    if (value !== null && value !== undefined && String(value).trim() !== "") {
      return String(value);
    }
  }
  return "—";
}

function formatDate(value: unknown) {
  if (!value) return "—";
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

export default function Review({ token, onBack }: Props) {
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | number>();
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<"pending" | "all">("pending");
  const [selected, setSelected] = useState<ReviewItem | null>(null);

  async function load(nextFilter = filter) {
    setLoading(true);
    setError("");

    try {
      const query = nextFilter === "pending" ? "?status=pending" : "?status=all";
      const body = await api(`/api/admin/reviews${query}`, token);
      setItems(listFromResponse(body));
    } catch (e) {
      setError(`The review queue could not be loaded. ${String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load("pending");
  }, []);

  const pendingCount = useMemo(
    () => items.filter((item) => text(item, "status").toLowerCase() === "new").length,
    [items]
  );

  async function changeStatus(item: ReviewItem, action: "approve" | "reject") {
    const verb = action === "approve" ? "approve this source" : "reject this source";
    if (!window.confirm(`Are you sure you want to ${verb}?\n\n${text(item, "title")}`)) {
      return;
    }

    setBusy(item.id);
    setError("");

    try {
      const id = encodeURIComponent(String(item.id));
      await api(`/api/admin/reviews/${id}/${action}`, token, {
        method: "POST",
        body: JSON.stringify({}),
      });
      setSelected(null);
      await load(filter);
    } catch (e) {
      setError(`Could not ${action} item ${item.id}. ${String(e)}`);
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <section className="shell page">
      <div className="section-head">
        <div>
          <span className="kicker">Secure administration</span>
          <h1>Review queue</h1>
          <p className="lead">
            Inspect discovered official sources before they are accepted into the BankLens collection pipeline.
          </p>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button className="text-button" onClick={onBack}>← Admin console</button>
          <button className="button small" onClick={() => load(filter)} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      <aside className="notice">
        <b>What approval does in the current worker</b>
        <p>
          The current backend reviews <b>discovered source links</b>, not extracted financial metric values.
          Approving a bank-specific link adds it to that bank's active scan sources. It does not by itself
          change the public assets, deposits, profit, capital, liquidity, NPL or product figures; those
          require an extraction/publication pipeline that is not present in the supplied worker code.
        </p>
      </aside>

      <div className="admin-stats">
        <div><b>{filter === "pending" ? items.length : pendingCount}</b><span>{filter === "pending" ? "Pending review" : "Pending in loaded items"}</span></div>
        <div><b>{items.length}</b><span>Loaded items</span></div>
      </div>

      {error && (
        <aside className="notice">
          <b>Review queue error</b>
          <p>{error}</p>
        </aside>
      )}

      <div className="panel">
        <div className="section-head">
          <div>
            <h2>Discovered sources</h2>
            <p>Review the URL and discovery classification before accepting it.</p>
          </div>

          <select
            value={filter}
            onChange={(e) => {
              const value = e.target.value as "pending" | "all";
              setFilter(value);
              load(value);
            }}
          >
            <option value="pending">Pending only</option>
            <option value="all">All</option>
          </select>
        </div>

        {loading ? (
          <div className="loading">Loading review queue…</div>
        ) : items.length === 0 ? (
          <div className="notice">
            <b>No items waiting for review.</b>
            <p>Run discovery or a country collection from the admin console to create new discovery candidates.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Country</th>
                  <th>Type</th>
                  <th>Title</th>
                  <th>Source</th>
                  <th>Discovered</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>

              <tbody>
                {items.map((item) => (
                  <tr key={String(item.id)}>
                    <td>
                      <b>{text(item, "country_name")}</b>
                      <small>{text(item, "country_iso2")}</small>
                    </td>
                    <td>{text(item, "kind")}</td>
                    <td>{text(item, "title")}</td>
                    <td>
                      {item.url ? (
                        <a href={String(item.url)} target="_blank" rel="noreferrer">
                          Open source ↗
                        </a>
                      ) : "—"}
                    </td>
                    <td>{formatDate(item.discovered_at)}</td>
                    <td>{text(item, "status")}</td>
                    <td>
                      <button
                        className="text-button"
                        onClick={() => setSelected(item)}
                      >
                        Inspect
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {selected && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,.35)",
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            padding: 20,
            zIndex: 1000,
          }}
        >
          <div
            className="panel"
            style={{
              width: "min(900px, 100%)",
              maxHeight: "90vh",
              overflow: "auto",
            }}
          >
            <div className="section-head">
              <div>
                <span className="kicker">Review item #{String(selected.id)}</span>
                <h2>{text(selected, "title")}</h2>
                <p>
                  {text(selected, "country_name")} · {text(selected, "kind")}
                </p>
              </div>
              <button className="text-button" onClick={() => setSelected(null)}>
                Close
              </button>
            </div>

            <div className="metric-cards">
              <div className="metric-card">
                <span>Country</span>
                <b>{text(selected, "country_name")}</b>
              </div>
              <div className="metric-card">
                <span>Classification</span>
                <b>{text(selected, "kind")}</b>
              </div>
              <div className="metric-card">
                <span>Status</span>
                <b>{text(selected, "status")}</b>
              </div>
              <div className="metric-card">
                <span>Discovered</span>
                <b>{formatDate(selected.discovered_at)}</b>
              </div>
            </div>

            <h3>Source URL</h3>
            <p style={{ wordBreak: "break-all" }}>
              {selected.url ? (
                <a href={String(selected.url)} target="_blank" rel="noreferrer">
                  {String(selected.url)}
                </a>
              ) : "No URL supplied."}
            </p>

            {String(selected.status).toLowerCase() === "new" && (
              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 20 }}>
                <button
                  className="text-button"
                  disabled={busy === selected.id}
                  onClick={() => changeStatus(selected, "reject")}
                >
                  {busy === selected.id ? "Saving…" : "Reject"}
                </button>
                <button
                  className="button"
                  disabled={busy === selected.id}
                  onClick={() => changeStatus(selected, "approve")}
                >
                  {busy === selected.id ? "Approving…" : "Approve source"}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
