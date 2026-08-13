import { Hono } from "hono";
import { cors } from "hono/cors";
import { demoBanks } from "./demo";
import { listBanks, findBank } from "./db";
import { processReport, reprocessStoredReports, runScan, runScanForCountry } from "./scanner";
import { digest, hashPassword, requireAdmin, token, verifyPassword } from "./auth";
import { ensureBankLensSchema, ensureLatestMetrics } from "./schema";
import { registerAdminCrud } from "./routes/admin-crud";
import { registerPublicApi } from "./routes/public-api";
import { registerPipelineApi } from "./routes/pipeline-api";
import type { Bindings } from "./env";

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

const GHANA_BANKS = [
  ["GCB Bank PLC", "gcb-bank", "https://www.gcbbank.com.gh/group-results-and-reporting"],
  ["Ecobank Ghana PLC", "ecobank-ghana", "https://www.ecobank.com/group/investor-relations/annual-reports/subsidiary-annual-reports"],
  ["Absa Bank Ghana", "absa-bank-ghana", "https://www.absa.com.gh/reports/"],
  ["Standard Chartered Bank Ghana PLC", "standard-chartered-ghana", "https://www.sc.com/gh/about-us/investor-relations/"],
  ["Stanbic Bank Ghana", "stanbic-bank-ghana", "https://www.stanbicbank.com.gh/gh/personal/about-us/financial-results"],
  ["Fidelity Bank Ghana", "fidelity-bank-ghana", "https://www.fidelitybank.com.gh/about-us/financial-reports"],
  ["CalBank PLC", "calbank", "https://ir.calbank.net/financials/results/"],
  ["Agricultural Development Bank (ADB) PLC", "adb-ghana", "https://www.agricbank.com/investor-relations/financial-reports/"],
  ["Societe Generale Ghana PLC", "societe-generale-ghana", "https://societegenerale.com.gh/en/your-bank/investor-relations/annual-reports/"],
  ["Zenith Bank Ghana", "zenith-bank-ghana", "https://www.zenithbank.com.gh/about-us/financial-report/"],
  ["Consolidated Bank Ghana (CBG)", "cbg-ghana", "https://www.cbg.com.gh/documents/annual-financial-reports"],
  ["Guaranty Trust Bank (GTBank) Ghana", "gtbank-ghana", "https://www.gtbankghana.com/about-us/financial-reports"],
  ["United Bank for Africa (UBA) Ghana", "uba-ghana", "https://www.ubaghana.com/about-us/financial-reports/"],
  ["Bank of Africa Ghana (BOA)", "boa-ghana", "https://boaghana.com/about-boa/financial-statements/"],
] as const;

app.get("/api/countries", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id,name,iso2,currency FROM countries WHERE enabled=1 ORDER BY name").all();
  return c.json({ data: results });
});

app.get("/api/banks", async (c) => {
  try {
    const countryId = c.req.query("country") ? Number(c.req.query("country")) : undefined;
    const data = await listBanks(c.env.DB, countryId);
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

app.get("/api/banks/:slug/trends", async (c) => {
  const bank = await c.env.DB.prepare("SELECT id,name FROM banks WHERE slug=? AND active=1").bind(c.req.param("slug")).first<any>();
  if (!bank) return c.json({ error:"Bank not found" },404);
  const from=c.req.query("from")||"1900-01-01", to=c.req.query("to")||"2999-12-31";
  const {results}=await c.env.DB.prepare(`SELECT metric_key,metric_label,value,unit,currency,reporting_period_start,reporting_period_end,period_label,source_url,source_title FROM financial_records WHERE bank_id=? AND status='published' AND COALESCE(reporting_period_end,'9999-12-31') BETWEEN ? AND ? ORDER BY reporting_period_end ASC,metric_key ASC`).bind(bank.id,from,to).all();
  return c.json({data:results,meta:{bankId:bank.id,bankName:bank.name,from,to}});
});

app.get("/api/banks/:slug/analysis", async (c) => {
  const row=await c.env.DB.prepare(`SELECT b.id,b.name,b.health_score,b.summary,a.strengths_json,a.weaknesses_json,a.generated_at FROM banks b LEFT JOIN bank_analysis a ON a.bank_id=b.id WHERE b.slug=? AND b.active=1`).bind(c.req.param("slug")).first<any>();
  if(!row)return c.json({error:"Bank not found"},404);
  return c.json({data:{bankId:row.id,name:row.name,healthScore:row.health_score,summary:row.summary,strengths:JSON.parse(row.strengths_json||"[]"),weaknesses:JSON.parse(row.weaknesses_json||"[]"),generatedAt:row.generated_at||null}});
});

app.get("/api/compare/rankings", async (c) => {
  const countryId=c.req.query("country")?Number(c.req.query("country")):undefined;
  const metric=c.req.query("metric")||"health_score";
  const from=c.req.query("from")||"1900-01-01",to=c.req.query("to")||"2999-12-31";
  if(metric === "health_score") {
    const q=countryId?c.env.DB.prepare("SELECT b.id,b.slug,b.name,b.health_score value,c.name country_name FROM banks b JOIN countries c ON c.id=b.country_id WHERE b.active=1 AND b.country_id=? ORDER BY b.health_score DESC,b.name").bind(countryId):c.env.DB.prepare("SELECT b.id,b.slug,b.name,b.health_score value,c.name country_name FROM banks b JOIN countries c ON c.id=b.country_id WHERE b.active=1 ORDER BY b.health_score DESC,b.name");
    const {results}=await q.all(); return c.json({data:results.map((x:any,i:number)=>({...x,rank:i+1}))});
  }
  const params:any[]=[metric,from,to];
  let sql=`SELECT fr.bank_id,b.slug,b.name,c.name country_name,fr.value,fr.unit,fr.reporting_period_end,fr.period_label,fr.source_url FROM financial_records fr JOIN banks b ON b.id=fr.bank_id JOIN countries c ON c.id=b.country_id WHERE fr.status='published' AND fr.metric_key=? AND COALESCE(fr.reporting_period_end,'9999-12-31') BETWEEN ? AND ?`;
  if(countryId){sql+=" AND b.country_id=?";params.push(countryId);}
  sql+=" ORDER BY fr.reporting_period_end DESC,fr.id DESC";
  const {results}=await c.env.DB.prepare(sql).bind(...params).all<any>();
  const latest=new Map<number,any>(); for(const row of results){if(!latest.has(Number(row.bank_id)))latest.set(Number(row.bank_id),row);}
  const rows=[...latest.values()]; rows.sort((a,b)=>Number(b.value)-Number(a.value));
  return c.json({data:rows.map((x,i)=>({...x,rank:i+1}))});
});

app.get("/api/admin/countries", async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT c.*,
    (SELECT COUNT(DISTINCT b.id) FROM banks b JOIN sources s ON s.bank_id=b.id WHERE b.country_id=c.id AND b.active=1 AND s.active=1 AND s.source_type='financial_portal') bank_count,
    (SELECT COUNT(*) FROM banks b WHERE b.country_id=c.id AND b.active=1) bank_total,
    (SELECT COUNT(*) FROM sources s JOIN banks b ON b.id=s.bank_id WHERE b.country_id=c.id AND b.active=1 AND s.active=1 AND s.source_type='financial_portal') source_count,
    (SELECT COUNT(*) FROM financial_documents d JOIN banks b ON b.id=d.bank_id WHERE b.country_id=c.id AND d.status='published') report_count,
    (SELECT MAX(sr.checked_at) FROM source_checks sr JOIN sources s ON s.id=sr.source_id JOIN banks b ON b.id=s.bank_id WHERE b.country_id=c.id) last_scan_at
    FROM countries c ORDER BY name`).all();
  return c.json({ data: results });
});

app.post("/api/admin/countries", async (c) => {
  const x=await c.req.json();
  if(!x.name||!x.iso2||!x.currency)return c.json({error:"Country name, ISO2 and currency are required"},400);
  const existing=await c.env.DB.prepare("SELECT id FROM countries WHERE iso2=?").bind(String(x.iso2).toUpperCase()).first<any>();
  if(existing)return c.json({error:"Country already exists",id:existing.id},409);
  await c.env.DB.prepare("INSERT INTO countries(name,iso2,currency,regulator_name,regulator_url,bank_directory_url,enabled) VALUES(?,?,?,?,?,?,?)").bind(x.name,String(x.iso2).toUpperCase(),String(x.currency).toUpperCase(),x.regulatorName||`${x.name} central bank`,x.regulatorUrl||"",x.bankDirectoryUrl||"",x.enabled===false?0:1).run();
  const row=await c.env.DB.prepare("SELECT id FROM countries WHERE iso2=?").bind(String(x.iso2).toUpperCase()).first<any>();
  return c.json({ok:true,id:row?.id},201);
});

// Country updates are handled by registerAdminCrud (partial update + rename +
// delete). See worker/routes/admin-crud.ts.

app.get("/api/admin/countries/:id/config", async (c) => {
  const countryId=Number(c.req.param("id"));
  const country=await c.env.DB.prepare("SELECT * FROM countries WHERE id=?").bind(countryId).first<any>();
  if(!country)return c.json({error:"Country not found"},404);
  const {results:banks}=await c.env.DB.prepare("SELECT id,name,slug,website,short_name,color,health_score,active FROM banks WHERE country_id=? ORDER BY name").bind(countryId).all();
  const {results:sources}=await c.env.DB.prepare(`SELECT s.id,s.bank_id,s.url,s.source_type,s.active, b.name bank_name FROM sources s JOIN banks b ON b.id=s.bank_id WHERE b.country_id=? ORDER BY b.name,s.url`).bind(countryId).all();
  return c.json({country,banks,sources});
});

app.post("/api/admin/countries/:id/banks", async (c) => {
  const countryId=Number(c.req.param("id")); const x=await c.req.json();
  if(!x.name)return c.json({error:"Bank name is required"},400);
  const slug=String(x.slug||x.name).toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"");
  const existing=await c.env.DB.prepare("SELECT id FROM banks WHERE slug=?").bind(slug).first<any>(); if(existing)return c.json({error:"A bank with this slug already exists"},409);
  await c.env.DB.prepare("INSERT INTO banks(slug,name,short_name,color,health_score,summary,active,country_id,website,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(slug,x.name,x.shortName||String(x.name).slice(0,3).toUpperCase(),x.color||"hsl(210 55% 42%)",0,"Financial profile is being built from configured official reports.",1,countryId,x.website||null,new Date().toISOString()).run();
  const bank=await c.env.DB.prepare("SELECT id,slug,name FROM banks WHERE slug=?").bind(slug).first<any>();
  if(x.sourceUrl) await c.env.DB.prepare("INSERT INTO sources(bank_id,url,source_type,active) VALUES(?,?,?,1)").bind(bank.id,x.sourceUrl,"financial_portal").run();
  return c.json({ok:true,bank},201);
});

// Bank update/delete are handled by registerAdminCrud, which applies a partial
// update instead of overwriting every column with undefined.

app.post("/api/admin/banks/:id/sources", async (c) => {
  const bankId=Number(c.req.param("id")); const x=await c.req.json();
  if(!x.url)return c.json({error:"Financial reporting URL is required"},400);
  const bank=await c.env.DB.prepare("SELECT id FROM banks WHERE id=? AND active=1").bind(bankId).first<any>(); if(!bank)return c.json({error:"Bank not found"},404);
  const existing=await c.env.DB.prepare("SELECT id FROM sources WHERE bank_id=? AND url=?").bind(bankId,x.url).first<any>();
  if(existing){await c.env.DB.prepare("UPDATE sources SET active=1,source_type='financial_portal' WHERE id=?").bind(existing.id).run();return c.json({ok:true,id:existing.id});}
  await c.env.DB.prepare("INSERT INTO sources(bank_id,url,source_type,active) VALUES(?,?,?,1)").bind(bankId,x.url,"financial_portal").run();
  const row=await c.env.DB.prepare("SELECT id FROM sources WHERE bank_id=? AND url=?").bind(bankId,x.url).first<any>(); return c.json({ok:true,id:row?.id},201);
});

// Source amend/remove are handled by registerAdminCrud.

app.post("/api/admin/ghana-starter", async (c) => {
  const now=new Date().toISOString();
  let country=await c.env.DB.prepare("SELECT id FROM countries WHERE iso2='GH'").first<any>();
  if(!country){
    await c.env.DB.prepare("INSERT INTO countries(name,iso2,currency,regulator_name,regulator_url,bank_directory_url,enabled) VALUES(?,?,?,?,?,?,1)").bind("Ghana","GH","GHS","Bank of Ghana","https://www.bog.gov.gh/","",1).run();
    country=await c.env.DB.prepare("SELECT id FROM countries WHERE iso2='GH'").first<any>();
  }
  let banksAdded=0, sourcesAdded=0;
  for(const [name,slug,url] of GHANA_BANKS){
    let bank=await c.env.DB.prepare("SELECT id FROM banks WHERE slug=?").bind(slug).first<any>();
    if(!bank){
      await c.env.DB.prepare("INSERT INTO banks(slug,name,short_name,color,health_score,summary,active,country_id,website,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(slug,name,name.split(/\s+/).map((x:string)=>x[0]).join("").slice(0,3).toUpperCase(),"hsl(210 55% 42%)",0,"Financial profile is being built from configured official reports.",1,country.id,new URL(url).origin,now).run();
      bank=await c.env.DB.prepare("SELECT id FROM banks WHERE slug=?").bind(slug).first<any>(); banksAdded++;
    }
    const source=await c.env.DB.prepare("SELECT id FROM sources WHERE bank_id=? AND url=?").bind(bank.id,url).first<any>();
    if(!source){await c.env.DB.prepare("INSERT INTO sources(bank_id,url,source_type,active) VALUES(?,?,?,1)").bind(bank.id,url,"financial_portal").run(); sourcesAdded++;}
  }
  return c.json({ok:true,countryId:country.id,banksAdded,sourcesAdded});
});



async function repairCountryData(db: D1Database, countryId: number) {
  const { results: sources } = await db.prepare(
    `SELECT s.id,s.bank_id FROM sources s JOIN banks b ON b.id=s.bank_id
     WHERE b.country_id=? AND b.active=1 AND s.active=1 AND s.source_type='financial_portal'`
  ).bind(countryId).all<any>();

  let documentsReassigned=0, recordsReassigned=0, extractionsReassigned=0;
  for(const source of sources || []) {
    const doc=await db.prepare("SELECT COUNT(*) n FROM financial_documents WHERE source_id=? AND bank_id<>?").bind(source.id,source.bank_id).first<any>();
    const rec=await db.prepare("SELECT COUNT(*) n FROM financial_records WHERE source_id=? AND bank_id<>?").bind(source.id,source.bank_id).first<any>();
    const ext=await db.prepare("SELECT COUNT(*) n FROM financial_extractions WHERE source_id=? AND bank_id<>?").bind(source.id,source.bank_id).first<any>();
    documentsReassigned+=Number(doc?.n||0); recordsReassigned+=Number(rec?.n||0); extractionsReassigned+=Number(ext?.n||0);
    const now=new Date().toISOString();
    await db.batch([
      db.prepare("UPDATE financial_documents SET bank_id=?,updated_at=? WHERE source_id=?").bind(source.bank_id,now,source.id),
      db.prepare("UPDATE financial_records SET bank_id=?,updated_at=? WHERE source_id=?").bind(source.bank_id,now,source.id),
      db.prepare("UPDATE financial_extractions SET bank_id=? WHERE source_id=?").bind(source.bank_id,source.id),
    ]);
  }
  return {sourcesChecked:sources?.length||0,documentsReassigned,recordsReassigned,extractionsReassigned};
}

app.post("/api/admin/countries/:id/repair", async (c) => {
  const countryId = Number(c.req.param("id"));
  const { results: sources } = await c.env.DB.prepare(
    `SELECT s.id,s.bank_id,s.url,b.name bank_name
     FROM sources s JOIN banks b ON b.id=s.bank_id
     WHERE b.country_id=? AND b.active=1 AND s.active=1 AND s.source_type='financial_portal'`
  ).bind(countryId).all<any>();

  let documentsReassigned = 0;
  let recordsReassigned = 0;
  let extractionsReassigned = 0;

  for (const source of sources || []) {
    const doc = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM financial_documents WHERE source_id=? AND bank_id<>?`
    ).bind(source.id,source.bank_id).first<any>();
    const rec = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM financial_records WHERE source_id=? AND bank_id<>?`
    ).bind(source.id,source.bank_id).first<any>();
    const ext = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM financial_extractions WHERE source_id=? AND bank_id<>?`
    ).bind(source.id,source.bank_id).first<any>();

    documentsReassigned += Number(doc?.n || 0);
    recordsReassigned += Number(rec?.n || 0);
    extractionsReassigned += Number(ext?.n || 0);

    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE financial_documents SET bank_id=?,updated_at=? WHERE source_id=?")
        .bind(source.bank_id,new Date().toISOString(),source.id),
      c.env.DB.prepare("UPDATE financial_records SET bank_id=?,updated_at=? WHERE source_id=?")
        .bind(source.bank_id,new Date().toISOString(),source.id),
      c.env.DB.prepare("UPDATE financial_extractions SET bank_id=? WHERE source_id=?")
        .bind(source.bank_id,source.id),
    ]);
  }

  return c.json({
    ok:true,
    countryId,
    sourcesChecked:sources?.length || 0,
    documentsReassigned,
    recordsReassigned,
    extractionsReassigned,
  });
});


app.post("/api/admin/countries/:id/reprocess", async (c) => {
  const countryId=Number(c.req.param("id")); const encoder=new TextEncoder(); const stream=new TransformStream(); const writer=stream.writable.getWriter();
  (async()=>{try{await writer.write(encoder.encode(JSON.stringify({status:"starting",countryId})+"\n")); const result=await reprocessStoredReports(c.env,countryId,async(info)=>{await writer.write(encoder.encode(JSON.stringify(info)+"\n"));}); await writer.write(encoder.encode(JSON.stringify({status:"done",result})+"\n"));}catch(error){await writer.write(encoder.encode(JSON.stringify({status:"error",message:String(error)})+"\n"));}finally{writer.close();}})();
  return new Response(stream.readable,{headers:{"Content-Type":"text/event-stream","Cache-Control":"no-cache","Connection":"keep-alive"}});
});

app.post("/api/admin/countries/:id/analyze", async (c) => {
  const id=Number(c.req.param("id")); const encoder=new TextEncoder(); const stream=new TransformStream(); const writer=stream.writable.getWriter();
  (async()=>{try{
    await writer.write(encoder.encode(JSON.stringify({status:"starting",countryId:id})+"\n"));
    const repair = await repairCountryData(c.env.DB,id);
    await writer.write(encoder.encode(JSON.stringify({status:"repaired",...repair})+"\n"));
    const result=await runScanForCountry(c.env,id,async(info)=>{await writer.write(encoder.encode(JSON.stringify(info)+"\n"));});
    await writer.write(encoder.encode(JSON.stringify({status:"done",result})+"\n"));
  }catch(error){await writer.write(encoder.encode(JSON.stringify({status:"error",message:String(error)})+"\n"));}finally{writer.close();}})();
  return new Response(stream.readable,{headers:{"Content-Type":"text/event-stream","Cache-Control":"no-cache"}});
});

// Legacy discovery endpoint is intentionally disabled. BankLens now scans only administrator-configured financial portals.
app.post("/api/admin/countries/:id/discover", async (c) => c.json({error:"Automatic discovery is disabled. Add each bank and its official financial-report portal in Admin."},410));


app.get("/api/admin/countries/:id/source-map", async (c) => {
  const countryId=Number(c.req.param("id"));
  const {results}=await c.env.DB.prepare(
    `SELECT s.id,s.url,s.source_type,s.active,s.bank_id,b.name bank_name,
      (SELECT COUNT(*) FROM financial_documents d WHERE d.source_id=s.id) report_count,
      (SELECT COUNT(*) FROM financial_records fr WHERE fr.source_id=s.id AND fr.status='published') value_count
     FROM sources s JOIN banks b ON b.id=s.bank_id
     WHERE b.country_id=? ORDER BY b.name,s.url`
  ).bind(countryId).all<any>();
  return c.json({data:results});
});

app.get("/api/admin/countries/:id/analysis-status", async (c) => {
  const countryId=Number(c.req.param("id"));
  const {results}=await c.env.DB.prepare(`SELECT b.id bank_id,b.name bank_name,(SELECT COUNT(*) FROM sources s WHERE s.bank_id=b.id AND s.active=1 AND s.source_type='financial_portal') portal_count,(SELECT COUNT(*) FROM financial_documents d WHERE d.bank_id=b.id AND d.status='published') report_count,(SELECT COUNT(*) FROM financial_records fr WHERE fr.bank_id=b.id AND fr.status='published') value_count,(SELECT COUNT(*) FROM financial_documents d WHERE d.bank_id=b.id AND d.status='published' AND NOT EXISTS (SELECT 1 FROM financial_records fr WHERE fr.source_id=d.source_id AND fr.source_url=d.report_url AND fr.content_hash=d.content_hash AND fr.status='published')) pending_reprocess FROM banks b WHERE b.country_id=? AND b.active=1 ORDER BY b.name`).bind(countryId).all<any>();
  return c.json({data:results});
});

app.get("/api/admin/audit", async (c) => {
  const limit=Math.min(1000,Math.max(50,Number(c.req.query("limit")||500)));
  const {results:reports}=await c.env.DB.prepare(`SELECT d.id,d.report_title,d.report_url,d.reporting_period_end,d.period_label,d.processed_at,d.status,
    b.name bank_name,s.bank_id source_bank_id,sb.name source_bank_name,c.name country_name,
    CASE WHEN d.bank_id=s.bank_id THEN 0 ELSE 1 END bank_mismatch
    FROM financial_documents d
    JOIN banks b ON b.id=d.bank_id
    JOIN countries c ON c.id=b.country_id
    JOIN sources s ON s.id=d.source_id
    JOIN banks sb ON sb.id=s.bank_id
    ORDER BY d.processed_at DESC LIMIT ${limit}`).all();
  const {results:metrics}=await c.env.DB.prepare(`SELECT fr.bank_id,b.name bank_name,c.name country_name,fr.metric_label,fr.value,fr.unit,fr.period_label,fr.reporting_period_end,fr.source_url,fr.source_title FROM financial_records fr JOIN banks b ON b.id=fr.bank_id JOIN countries c ON c.id=b.country_id WHERE fr.status='published' ORDER BY fr.reporting_period_end DESC,fr.id DESC LIMIT ${limit}`).all();
  return c.json({reports,metrics});
});


app.get("/api/admin/sources/:id/diagnostics", async (c) => {
  const id = Number(c.req.param("id"));
  const source = await c.env.DB.prepare(`SELECT s.id,s.bank_id,s.url,s.source_type,s.active,b.name bank_name,c.name country_name
    FROM sources s JOIN banks b ON b.id=s.bank_id JOIN countries c ON c.id=b.country_id WHERE s.id=?`).bind(id).first<any>();
  if (!source) return c.json({error:"Source not found"},404);
  const {results:checks} = await c.env.DB.prepare(`SELECT status,content_hash,checked_at,error FROM source_checks WHERE source_id=? ORDER BY checked_at DESC LIMIT 10`).bind(id).all<any>();
  const {results:reports} = await c.env.DB.prepare(`SELECT d.id,d.bank_id,d.report_title,d.report_url,d.report_type,d.reporting_period_start,d.reporting_period_end,d.period_label,d.status,d.error,d.downloaded_at,d.processed_at,
    (SELECT COUNT(*) FROM financial_records fr WHERE fr.source_id=d.source_id AND fr.source_url=d.report_url AND fr.content_hash=d.content_hash AND fr.status='published') metric_count
    FROM financial_documents d WHERE d.source_id=? ORDER BY d.created_at DESC LIMIT 100`).bind(id).all<any>();
  const summary=await c.env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM financial_documents WHERE source_id=?) reports,
      (SELECT COUNT(*) FROM financial_records WHERE source_id=? AND status='published') published_values,
      (SELECT COUNT(*) FROM financial_extractions WHERE source_id=? AND status='no_metrics') no_metric_reports
    `).bind(id,id,id).first<any>();
  return c.json({source,checks,reports,summary});
});

app.post("/api/admin/scan", async (c) => c.json(await runScan(c.env)));

// Feature route modules. These are registered after the `/api/admin/*` auth
// middleware above, so every admin and pipeline route they add is protected.
registerAdminCrud(app);
registerPipelineApi(app);
registerPublicApi(app);

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(runScan(env));
  },
} satisfies ExportedHandler<Bindings>;
