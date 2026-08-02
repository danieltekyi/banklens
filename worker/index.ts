import { Hono } from "hono";
import { cors } from "hono/cors";
import { demoBanks } from "./demo";
import { listBanks, findBank } from "./db";
import { runScan, runScanForCountry } from "./scanner";
import { discoverCountry, runDiscovery } from "./discovery";
import { digest, hashPassword, requireAdmin, token, verifyPassword } from "./auth";

type Bindings = {
  DB: D1Database;
  REPORTS: R2Bucket;
  ASSETS: Fetcher;
  ADMIN_API_KEY?: string;
  RESEND_API_KEY?: string;
  SESSION_PEPPER?: string;
};

const app = new Hono<{ Bindings: Bindings }>();
app.use("/api/*", cors({ origin: "*" }));

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
  const { username, password } = await c.req.json();
  const u = await c.env.DB.prepare("SELECT * FROM admin_users WHERE username=?").bind(username).first<any>();
  if (!u || !(await verifyPassword(password, u.password_hash))) return c.json({ error: "Invalid credentials" }, 401);
  const raw = token();
  const id = crypto.randomUUID();
  const expires = new Date(Date.now() + 8 * 3600e3).toISOString();
  await c.env.DB.prepare("INSERT INTO admin_sessions(id,user_id,token_hash,expires_at) VALUES(?,?,?,?)").bind(id, u.id, await digest(raw), expires).run();
  return c.json({ token: raw, user: { username: u.username, email: u.email, mustChangePassword: !!u.must_change_password }, expiresAt: expires });
});

app.post("/api/auth/forgot", async (c) => {
  const { email } = await c.req.json();
  const u = await c.env.DB.prepare("SELECT * FROM admin_users WHERE email=?").bind(email).first<any>();
  if (u) {
    const raw = token();
    await c.env.DB.prepare("INSERT INTO password_resets(id,user_id,token_hash,expires_at) VALUES(?,?,?,?)").bind(crypto.randomUUID(), u.id, await digest(raw), new Date(Date.now() + 30 * 60e3).toISOString()).run();
    if (c.env.RESEND_API_KEY)
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${c.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "BankLens <admin@tiwaak.com>",
          to: [u.email],
          subject: "Reset your BankLens password",
          html: `<p>Use this one-time reset token:</p><p><b>${raw}</b></p><p>It expires in 30 minutes.</p>`,
        }),
      });
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
      await writer.write(encoder.encode(JSON.stringify({ status: "discovered", linksFound: disc.linksFound }) + "\n"));
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

app.get("/api/admin/review", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT d.*,c.name country_name FROM discovered_links d JOIN countries c ON c.id=d.country_id ORDER BY d.discovered_at DESC LIMIT 200").all();
  return c.json({ data: results });
});

app.post("/api/admin/scan", async (c) => c.json(await runScan(c.env)));

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(Promise.all([runDiscovery(env), runScan(env)]));
  },
} satisfies ExportedHandler<Bindings>;
