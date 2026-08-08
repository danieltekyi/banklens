import { Hono } from "hono";
import { cors } from "hono/cors";
import { demoBanks } from "./demo";
import { listBanks, findBank } from "./db";
import { runScan, runScanForCountry } from "./scanner";
import { discoverCountry, runDiscovery } from "./discovery";
import { digest, hashPassword, requireAdmin, token, verifyPassword } from "./auth";
import { ensureBankLensSchema, ensureLatestMetrics } from "./schema";

type Bindings = {
  DB: D1Database;
  REPORTS: R2Bucket;
  ASSETS: Fetcher;
  ADMIN_API_KEY?: string;
  RESEND_API_KEY?: string;
  SESSION_PEPPER?: string;
};

const app = new Hono<{ Bindings: Bindings }>();
let schemaReady: Promise<void> | null = null;
async function ensureRuntimeSchema(db: D1Database) {
  if (!schemaReady) {
    schemaReady = (async () => {
      await ensureBankLensSchema(db);
      await ensureLatestMetrics(db);
    })();
  }
  await schemaReady;
}
// Global error handler to ensure we return JSON for unexpected errors
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: String(err) }, 500);
});
app.use("/api/*", cors({ origin: "*" }));

app.use("/api/*", async (c, next) => {
  await ensureRuntimeSchema(c.env.DB);
  await next();
});

app.get("/api/health", (c) => c.json({ ok: true, time: new Date().toISOString() }));

app.get("/api/banks", async (c) => {
  try {
    const data = await listBanks(c.env.DB);
    return c.json({ data: data.length ? data : demoBanks, meta: { demo: !data.length, updatedAt: new Date().toISOString() } });
  } catch {
    return c.json({ data: demoBanks, meta: { demo: true, updatedAt: new Date().toISOString() } });
  }
});

app.get("/api/banks/:slug", async (c) => {
  try {
    const data = (await findBank(c.env.DB, c.req.param("slug"))) || demoBanks.find((x) => x.slug === c.req.param("slug"));
    return data ? c.json({ data, meta: { demo: false, updatedAt: new Date().toISOString() } }) : c.json({ error: "Not found" }, 404);
  } catch {
    const data = demoBanks.find((x) => x.slug === c.req.param("slug"));
    return data ? c.json({ data, meta: { demo: true, updatedAt: new Date().toISOString() } }) : c.json({ error: "Not found" }, 404);
  }
});

app.post("/api/auth/login", async (c) => {
  try {
    // be defensive: read raw text then parse JSON to avoid unexpected parser errors
    let body: any = {};
    try {
      const rawText = await c.req.text();
      // debug: log raw body for parsing failures
      console.log("RAW_BODY:", rawText);
      body = rawText ? JSON.parse(rawText) : {};
    } catch (parseErr) {
      console.log("RAW_BODY_PARSE_ERROR:", String(parseErr));
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const { username, password } = body;
    const u = await c.env.DB.prepare("SELECT * FROM admin_users WHERE username=?").bind(username).first<any>();
    if (!u || !(await verifyPassword(password, u.password_hash))) return c.json({ error: "Invalid credentials" }, 401);
    const raw = token();
    const id = crypto.randomUUID();
    const expires = new Date(Date.now() + 8 * 3600e3).toISOString();
    await c.env.DB.prepare("INSERT INTO admin_sessions(id,user_id,token_hash,expires_at) VALUES(?,?,?,?)").bind(id, u.id, await digest(raw), expires).run();
    return c.json({ token: raw, user: { username: u.username, email: u.email, mustChangePassword: !!u.must_change_password }, expiresAt: expires });
  } catch (err) {
    // return structured JSON error instead of plain 500 HTML
    return c.json({ error: String(err) }, 500);
  }
});

app.post("/api/auth/forgot", async (c) => {
  const { email } = await c.req.json();
  const u = await c.env.DB.prepare("SELECT * FROM admin_users WHERE email=?").bind(email).first<any>();
  if (u) {
    const raw = token();
    const resetUrl = new URL("/admin", c.req.url);
    resetUrl.searchParams.set("reset", raw);
    await c.env.DB.prepare("INSERT INTO password_resets(id,user_id,token_hash,expires_at) VALUES(?,?,?,?)").bind(crypto.randomUUID(), u.id, await digest(raw), new Date(Date.now() + 30 * 60e3).toISOString()).run();
    if (c.env.RESEND_API_KEY)
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${c.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "BankLens <admin@tiwaak.com>",
          to: [u.email],
          subject: "Reset your BankLens password",
          html: `<p>Use this one-time reset link:</p><p><a href="${resetUrl.toString()}">${resetUrl.toString()}</a></p><p>It expires in 30 minutes.</p>`,
        }),
      });
    else console.log("PASSWORD_RESET_URL", resetUrl.toString());
  }
  return c.json({ ok: true, message: "If the email is registered, a reset message will be sent." });
});

app.post("/api/auth/reset", async (c) => {
  const { token: raw, password } = await c.req.json();
  if (!raw || password?.length < 12) return c.json({ error: "A password of at least 12 characters is required" }, 400);
  const reset = await c.env.DB.prepare("SELECT * FROM password_resets WHERE token_hash=? AND used_at IS NULL AND expires_at>?").bind(await digest(raw), new Date().toISOString()).first<any>();
  if (!reset) return c.json({ error: "Invalid or expired token" }, 400);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE admin_users SET password_hash=?,must_change_password=0,updated_at=? WHERE id=?").bind(await hashPassword(password), new Date().toISOString(), reset.user_id),
    c.env.DB.prepare("UPDATE password_resets SET used_at=? WHERE id=?").bind(new Date().toISOString(), reset.id),
    c.env.DB.prepare("DELETE FROM admin_sessions WHERE user_id=?").bind(reset.user_id),
  ]);
  return c.json({ ok: true });
});

// Protect admin routes
app.use("/api/admin/*", async (c, next) => {
  const user = await requireAdmin(c.req.raw, c.env.DB);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  await next();
});

app.get("/api/admin/countries", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT c.*,(SELECT COUNT(*) FROM banks b WHERE b.country_id=c.id) bank_count,(SELECT COUNT(*) FROM discovered_links d WHERE d.country_id=c.id AND d.status='new') review_count FROM countries c ORDER BY name").all();
  return c.json({ data: results });
});

app.post("/api/admin/countries", async (c) => {
  const x = await c.req.json();
  if (!x.name || !x.iso2 || !x.currency || !x.regulatorUrl || !x.bankDirectoryUrl) return c.json({ error: "Missing required fields" }, 400);
  await c.env.DB.prepare("INSERT INTO countries(name,iso2,currency,regulator_name,regulator_url,bank_directory_url,enabled) VALUES(?,?,?,?,?,?,0)").bind(x.name, x.iso2.toUpperCase(), x.currency.toUpperCase(), x.regulatorName || `${x.name} central bank`, x.regulatorUrl, x.bankDirectoryUrl).run();
  return c.json({ ok: true }, 201);
});

app.patch("/api/admin/countries/:id", async (c) => {
  const { enabled } = await c.req.json();
  await c.env.DB.prepare("UPDATE countries SET enabled=? WHERE id=?").bind(enabled ? 1 : 0, c.req.param("id")).run();
  return c.json({ ok: true });
});

app.post("/api/admin/countries/:id/discover", async (c) => c.json(await discoverCountry(c.env, Number(c.req.param("id")))));

// Streaming endpoint to run discovery + country scan and emit progress lines (JSON per line)
app.post("/api/admin/countries/:id/run", async (c) => {
  const id = Number(c.req.param("id"));
  const encoder = new TextEncoder();
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();

  (async () => {
    try {
      await writer.write(encoder.encode(JSON.stringify({ status: "starting", countryId: id }) + "\n"));
      const disc = await discoverCountry(c.env, id);
      await writer.write(encoder.encode(JSON.stringify({ status: "discovered", linksFound: disc.linksFound, banksUpserted: disc.banksUpserted }) + "\n"));
      const scanResult = await runScanForCountry(c.env, id, async (info) => {
        await writer.write(encoder.encode(JSON.stringify({ status: "scanning", ...info }) + "\n"));
      });
      await writer.write(encoder.encode(JSON.stringify({ status: "done", scan: scanResult }) + "\n"));
    } catch (error) {
      await writer.write(encoder.encode(JSON.stringify({ status: "error", message: String(error) }) + "\n"));
    } finally {
      writer.close();
    }
  })();

  return new Response(stream.readable, { headers: { "Content-Type": "text/event-stream" } });
});

app.get("/api/admin/reviews", async (c) => {
  const status = c.req.query("status") || "pending";
  const { results } = await c.env.DB.prepare(
    `SELECT fr.*, b.name bank_name, c.name country_name
     FROM financial_records fr
     JOIN banks b ON b.id=fr.bank_id
     JOIN countries c ON c.id=b.country_id
     WHERE (?='all' OR fr.status=?)
     ORDER BY COALESCE(fr.reporting_period_end, fr.created_at) DESC, fr.bank_id, fr.metric_key
     LIMIT 1000`,
  ).bind(status, status).all();
  const { results: links } = await c.env.DB.prepare(
    `SELECT d.*, c.name country_name
     FROM discovered_links d
     JOIN countries c ON c.id=d.country_id
     WHERE (?='all' OR d.status=?)
     ORDER BY d.discovered_at DESC LIMIT 500`,
  ).bind(status === "pending" ? "new" : "all", status === "pending" ? "new" : "all").all();
  const { results: banks } = await c.env.DB.prepare(
    "SELECT id,name,country_id FROM banks WHERE active=1 ORDER BY name"
  ).all();
  return c.json({ data: results, sources: links, banks });
});

app.get("/api/admin/review", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT d.*,c.name country_name FROM discovered_links d JOIN countries c ON c.id=d.country_id ORDER BY d.discovered_at DESC LIMIT 200",
  ).all();
  return c.json({ data: results });
});

app.post("/api/admin/reviews/:id/:action", async (c) => {
  const id = Number(c.req.param("id"));
  const action = c.req.param("action");
  if (!Number.isFinite(id) || !["approve", "reject"].includes(action)) return c.json({ error: "Invalid review action" }, 400);
  const body = await c.req.json().catch(() => ({}));
  const user = await requireAdmin(c.req.raw, c.env.DB);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const record = await c.env.DB.prepare("SELECT * FROM financial_records WHERE id=?").bind(id).first<any>();
  if (!record) return c.json({ error: "Financial review item not found" }, 404);

  const now = new Date().toISOString();
  if (action === "reject") {
    await c.env.DB.prepare(
      "UPDATE financial_records SET status='rejected',review_note=?,reviewed_by=?,reviewed_at=?,updated_at=? WHERE id=?",
    ).bind(body.note || null, user.username || user.email || String(user.id), now, now, id).run();
    return c.json({ ok: true, status: "rejected" });
  }

  await c.env.DB.prepare(
    "UPDATE financial_records SET status='approved',review_note=?,reviewed_by=?,reviewed_at=?,updated_at=? WHERE id=?",
  ).bind(body.note || null, user.username || user.email || String(user.id), now, now, id).run();

  // Rebuild the public latest snapshot for this bank from approved records for
  // the newest reporting period. Historical records remain untouched.
  const latest = await c.env.DB.prepare(
    `SELECT metric_key,value,unit,reporting_period_end,period_label
     FROM financial_records
     WHERE bank_id=? AND status='approved'
     ORDER BY COALESCE(reporting_period_end,'0000-00-00') DESC, id DESC`,
  ).bind(record.bank_id).all<any>();

  const snapshot: any = { bank_id: record.bank_id, assets:null, deposits:null, profit:null, capital_adequacy:null, liquidity:null, npl:null, reporting_period:null, reporting_period_end:null, updated_at:now };
  for (const row of latest.results || []) {
    if (snapshot[row.metric_key] == null) {
      snapshot[row.metric_key] = row.value;
      snapshot.reporting_period = row.period_label;
      snapshot.reporting_period_end = row.reporting_period_end;
    }
  }

  const cols = await c.env.DB.prepare("PRAGMA table_info(latest_metrics)").all<any>();
  const available = new Set((cols.results || []).map((x: any) => x.name));
  const names = ["bank_id","assets","deposits","profit","capital_adequacy","liquidity","npl","reporting_period","reporting_period_end","updated_at"]
    .filter(name => available.has(name));
  const values: any = {
    bank_id:snapshot.bank_id, assets:snapshot.assets, deposits:snapshot.deposits, profit:snapshot.profit,
    capital_adequacy:snapshot.capital_adequacy, liquidity:snapshot.liquidity, npl:snapshot.npl,
    reporting_period:snapshot.reporting_period, reporting_period_end:snapshot.reporting_period_end, updated_at:now
  };
  await c.env.DB.prepare("DELETE FROM latest_metrics WHERE bank_id=?").bind(record.bank_id).run();
  const marks = names.map(() => "?").join(",");
  await c.env.DB.prepare(`INSERT INTO latest_metrics(${names.join(",")}) VALUES(${marks})`)
    .bind(...names.map(n => values[n])).run();

  return c.json({ ok: true, status: "approved", published: true, latest: snapshot });
});

app.post("/api/admin/source-reviews/:id/:action", async (c) => {
  const id = Number(c.req.param("id"));
  const action = c.req.param("action");
  if (!Number.isFinite(id) || !["approve", "reject"].includes(action)) return c.json({ error: "Invalid review action" }, 400);
  const row = await c.env.DB.prepare("SELECT * FROM discovered_links WHERE id=?").bind(id).first<any>();
  if (!row) return c.json({ error: "Discovered source not found" }, 404);
  if (action === "reject") {
    await c.env.DB.prepare("UPDATE discovered_links SET status='rejected' WHERE id=?").bind(id).run();
    return c.json({ ok: true, status: "rejected" });
  }

  await c.env.DB.prepare("UPDATE discovered_links SET status='approved' WHERE id=?").bind(id).run();

  let sourceAdded = false;
  let bankId: number | null = body.bankId ? Number(body.bankId) : null;
  try {
    const hostname = new URL(row.url).hostname.replace(/^www\./, "").toLowerCase();
    let bank: any = null;
    if (bankId) {
      bank = await c.env.DB.prepare("SELECT id FROM banks WHERE id=? AND country_id=? AND active=1")
        .bind(bankId, row.country_id).first<any>();
      if (!bank) bankId = null;
    }
    if (!bank) {
      const { results: banks } = await c.env.DB.prepare(
        "SELECT id,website FROM banks WHERE country_id=? AND active=1 AND website IS NOT NULL",
      ).bind(row.country_id).all<any>();
      bank = banks.find((b: any) => {
        try { return new URL(b.website).hostname.replace(/^www\./,"").toLowerCase() === hostname; }
        catch { return false; }
      });
      if (bank) bankId = bank.id;
    }
    if (bank) {
      const existing = await c.env.DB.prepare(
        "SELECT id FROM sources WHERE bank_id=? AND url=? LIMIT 1",
      ).bind(bank.id, row.url).first<any>();
      if (existing) {
        await c.env.DB.prepare("UPDATE sources SET active=1,source_type=? WHERE id=?")
          .bind(row.kind || "financial", existing.id).run();
      } else {
        await c.env.DB.prepare(
          "INSERT INTO sources(bank_id,url,source_type,active) VALUES(?,?,?,1)",
        ).bind(bank.id, row.url, row.kind || "financial").run();
      }
      sourceAdded = true;
    }
  } catch {}

  return c.json({ ok: true, status: "approved", sourceAdded, bankId });
});

app.get("/api/banks/:slug/trends", async (c) => {
  const slug = c.req.param("slug");
  const from = c.req.query("from") || "1900-01-01";
  const to = c.req.query("to") || "2999-12-31";
  const bank = await c.env.DB.prepare("SELECT id,name,slug FROM banks WHERE slug=? AND active=1").bind(slug).first<any>();
  if (!bank) return c.json({ error: "Bank not found" }, 404);
  const { results } = await c.env.DB.prepare(
    `SELECT metric_key,metric_label,value,unit,currency,reporting_period_start,reporting_period_end,period_label,source_url,source_title
     FROM financial_records
     WHERE bank_id=? AND status='approved'
       AND COALESCE(reporting_period_end,'9999-12-31') BETWEEN ? AND ?
     ORDER BY reporting_period_end ASC, metric_key ASC`,
  ).bind(bank.id, from, to).all();
  return c.json({ data: results, meta: { bankId: bank.id, bankName: bank.name, from, to } });
});

app.get("/api/compare/trends", async (c) => {
  const slugs = (c.req.query("banks") || "").split(",").map(x => x.trim()).filter(Boolean).slice(0,10);
  const from = c.req.query("from") || "1900-01-01";
  const to = c.req.query("to") || "2999-12-31";
  if (!slugs.length) return c.json({ data: [] });
  const placeholders = slugs.map(() => "?").join(",");
  const { results } = await c.env.DB.prepare(
    `SELECT b.slug,b.name,fr.metric_key,fr.metric_label,fr.value,fr.unit,fr.reporting_period_end,fr.period_label
     FROM financial_records fr JOIN banks b ON b.id=fr.bank_id
     WHERE fr.status='approved' AND b.slug IN (${placeholders})
       AND COALESCE(fr.reporting_period_end,'9999-12-31') BETWEEN ? AND ?
     ORDER BY fr.reporting_period_end ASC,b.name,fr.metric_key`,
  ).bind(...slugs, from, to).all();
  return c.json({ data: results, meta: { from, to } });
});

app.post("/api/admin/scan", async (c) => c.json(await runScan(c.env)));

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(Promise.all([runDiscovery(env), runScan(env)]));
  },
} satisfies ExportedHandler<Bindings>;
