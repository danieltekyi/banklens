import type { Hono } from "hono";
import type { AppEnv } from "../env";

type Env = AppEnv;

const nowIso = () => new Date().toISOString();

function slugify(value: string) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function actorOf(req: Request, db: D1Database) {
  const raw = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!raw) return null;
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(raw));
  const hash = [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
  const row = await db
    .prepare("SELECT u.username FROM admin_sessions s JOIN admin_users u ON u.id=s.user_id WHERE s.token_hash=?")
    .bind(hash)
    .first<any>();
  return row?.username ?? null;
}

async function audit(
  db: D1Database,
  actor: string | null,
  action: string,
  entityType: string,
  entityId: number | null,
  entityLabel: string,
  detail: unknown,
) {
  try {
    await db
      .prepare(
        "INSERT INTO admin_audit_log(actor,action,entity_type,entity_id,entity_label,detail,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .bind(actor, action, entityType, entityId, entityLabel, JSON.stringify(detail ?? {}), nowIso())
      .run();
  } catch {
    // The audit table is best-effort. Never fail an administrative action
    // because the log could not be written.
  }
}

async function countRows(db: D1Database, sql: string, ...bind: unknown[]) {
  try {
    const row = await db.prepare(sql).bind(...bind).first<any>();
    return Number(row?.n ?? 0);
  } catch {
    return 0;
  }
}

/**
 * Best-effort statement runner. A BankLens database that predates a given
 * migration may not have every table, and a missing optional table must not
 * abort a delete that has already removed other rows.
 */
async function runQuiet(db: D1Database, sql: string, ...bind: unknown[]) {
  try {
    await db.prepare(sql).bind(...bind).run();
    return true;
  } catch {
    return false;
  }
}

async function purgeR2ForBank(db: D1Database, bucket: R2Bucket | undefined, bankId: number) {
  if (!bucket) return 0;
  let removed = 0;
  try {
    const { results } = await db
      .prepare("SELECT r2_key FROM financial_documents WHERE bank_id=? AND r2_key IS NOT NULL")
      .bind(bankId)
      .all<any>();
    for (const row of results ?? []) {
      if (!row?.r2_key) continue;
      try {
        await bucket.delete(String(row.r2_key));
        removed++;
      } catch {
        // A missing object is not an error; the row is going away regardless.
      }
    }
  } catch {
    // financial_documents may not exist yet on a brand new database.
  }
  return removed;
}

/**
 * Remove a bank and every BankLens artefact that belongs to it.
 *
 * `sources` is deleted last because `source_checks` is keyed on it, and the
 * document/record tables are cleared first so nothing is left pointing at a
 * bank id that no longer resolves.
 */
async function deleteBankCascade(db: D1Database, bucket: R2Bucket | undefined, bankId: number) {
  const documentsDeleted = await countRows(db, "SELECT COUNT(*) n FROM financial_documents WHERE bank_id=?", bankId);
  const recordsDeleted = await countRows(db, "SELECT COUNT(*) n FROM financial_records WHERE bank_id=?", bankId);
  const sourcesDeleted = await countRows(db, "SELECT COUNT(*) n FROM sources WHERE bank_id=?", bankId);
  const productsDeleted = await countRows(db, "SELECT COUNT(*) n FROM bank_products WHERE bank_id=?", bankId);
  const objectsDeleted = await purgeR2ForBank(db, bucket, bankId);

  await runQuiet(db, "DELETE FROM source_checks WHERE source_id IN (SELECT id FROM sources WHERE bank_id=?)", bankId);
  await runQuiet(db, "DELETE FROM financial_records WHERE bank_id=?", bankId);
  await runQuiet(db, "DELETE FROM financial_documents WHERE bank_id=?", bankId);
  await runQuiet(db, "DELETE FROM financial_extractions WHERE bank_id=?", bankId);
  await runQuiet(db, "DELETE FROM financial_metrics WHERE bank_id=?", bankId);
  await runQuiet(db, "DELETE FROM banklens_latest_metrics WHERE bank_id=?", bankId);
  await runQuiet(db, "DELETE FROM bank_analysis WHERE bank_id=?", bankId);
  await runQuiet(db, "DELETE FROM bank_products WHERE bank_id=?", bankId);
  await runQuiet(db, "DELETE FROM products WHERE bank_id=?", bankId);
  await runQuiet(db, "DELETE FROM bank_context WHERE bank_id=?", bankId);
  await runQuiet(db, "DELETE FROM discovered_links WHERE bank_id=?", bankId);
  await runQuiet(db, "DELETE FROM sources WHERE bank_id=?", bankId);
  await runQuiet(db, "DELETE FROM banks WHERE id=?", bankId);

  return { documentsDeleted, recordsDeleted, sourcesDeleted, productsDeleted, objectsDeleted };
}

export function registerAdminCrud(app: Hono<Env>) {
  // ---------------------------------------------------------------- countries

  app.patch("/api/admin/countries/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const body = await c.req.json().catch(() => ({}) as any);
    const country = await c.env.DB.prepare("SELECT * FROM countries WHERE id=?").bind(id).first<any>();
    if (!country) return c.json({ error: "Country not found" }, 404);

    // Partial update: only overwrite the fields the caller actually sent, so a
    // toggle from the country list cannot blank out the regulator details.
    const next = {
      name: body.name ?? country.name,
      currency: String(body.currency ?? country.currency ?? "").toUpperCase(),
      regulator_name: body.regulatorName ?? body.regulator_name ?? country.regulator_name,
      regulator_url: body.regulatorUrl ?? body.regulator_url ?? country.regulator_url,
      bank_directory_url: body.bankDirectoryUrl ?? body.bank_directory_url ?? country.bank_directory_url,
      enabled: body.enabled === undefined ? country.enabled : body.enabled ? 1 : 0,
    };
    if (!String(next.name).trim()) return c.json({ error: "Country name cannot be empty" }, 400);

    if (body.iso2 && String(body.iso2).toUpperCase() !== country.iso2) {
      const iso2 = String(body.iso2).toUpperCase();
      if (iso2.length !== 2) return c.json({ error: "ISO2 must be exactly two characters" }, 400);
      const clash = await c.env.DB.prepare("SELECT id FROM countries WHERE iso2=? AND id<>?").bind(iso2, id).first<any>();
      if (clash) return c.json({ error: `Another country already uses ISO2 ${iso2}` }, 409);
      await c.env.DB.prepare("UPDATE countries SET iso2=? WHERE id=?").bind(iso2, id).run();
    }

    await c.env.DB.prepare(
      "UPDATE countries SET name=?,currency=?,regulator_name=?,regulator_url=?,bank_directory_url=?,enabled=? WHERE id=?",
    )
      .bind(next.name, next.currency, next.regulator_name, next.regulator_url, next.bank_directory_url, next.enabled, id)
      .run();

    const updated = await c.env.DB.prepare("SELECT * FROM countries WHERE id=?").bind(id).first<any>();
    await audit(c.env.DB, await actorOf(c.req.raw, c.env.DB), "update", "country", id, updated?.name ?? "", next);
    return c.json({ ok: true, country: updated });
  });

  app.delete("/api/admin/countries/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const country = await c.env.DB.prepare("SELECT * FROM countries WHERE id=?").bind(id).first<any>();
    if (!country) return c.json({ error: "Country not found" }, 404);

    // A country delete must be explicit about the banks it takes with it.
    const { results: banks } = await c.env.DB.prepare("SELECT id,name FROM banks WHERE country_id=?").bind(id).all<any>();
    const confirm = c.req.query("confirm");
    if ((banks?.length ?? 0) > 0 && confirm !== country.iso2) {
      return c.json(
        {
          error: `${country.name} still has ${banks.length} bank(s). Re-send with ?confirm=${country.iso2} to delete the country and all of its banks.`,
          bankCount: banks.length,
          banks: banks.map((b: any) => b.name),
        },
        409,
      );
    }

    let documentsDeleted = 0;
    let recordsDeleted = 0;
    for (const bank of banks ?? []) {
      const result = await deleteBankCascade(c.env.DB, c.env.REPORTS, Number(bank.id));
      documentsDeleted += result.documentsDeleted;
      recordsDeleted += result.recordsDeleted;
    }
    await runQuiet(c.env.DB, "DELETE FROM discovered_links WHERE country_id=?", id);
    await runQuiet(c.env.DB, "DELETE FROM scan_runs WHERE country_id=?", id);
    await c.env.DB.prepare("DELETE FROM countries WHERE id=?").bind(id).run();

    await audit(c.env.DB, await actorOf(c.req.raw, c.env.DB), "delete", "country", id, country.name, {
      banksDeleted: banks?.length ?? 0,
      documentsDeleted,
      recordsDeleted,
    });
    return c.json({
      ok: true,
      countryName: country.name,
      banksDeleted: banks?.length ?? 0,
      documentsDeleted,
      recordsDeleted,
    });
  });

  // -------------------------------------------------------------------- banks

  app.get("/api/admin/banks/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const bank = await c.env.DB.prepare(
      "SELECT b.*,c.name country_name,c.iso2 country_iso2 FROM banks b LEFT JOIN countries c ON c.id=b.country_id WHERE b.id=?",
    )
      .bind(id)
      .first<any>();
    if (!bank) return c.json({ error: "Bank not found" }, 404);
    const { results: sources } = await c.env.DB.prepare(
      "SELECT id,url,source_type,active FROM sources WHERE bank_id=? ORDER BY id",
    )
      .bind(id)
      .all<any>();
    const stats = {
      documents: await countRows(c.env.DB, "SELECT COUNT(*) n FROM financial_documents WHERE bank_id=?", id),
      records: await countRows(
        c.env.DB,
        "SELECT COUNT(*) n FROM financial_records WHERE bank_id=? AND status='published'",
        id,
      ),
      products: await countRows(c.env.DB, "SELECT COUNT(*) n FROM bank_products WHERE bank_id=?", id),
    };
    return c.json({ bank, sources, stats });
  });

  /**
   * Partial bank update. The previous implementation always wrote every column,
   * so a request that omitted `name` or `website` silently nulled them.
   */
  app.patch("/api/admin/banks/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const body = await c.req.json().catch(() => ({}) as any);
    const bank = await c.env.DB.prepare("SELECT * FROM banks WHERE id=?").bind(id).first<any>();
    if (!bank) return c.json({ error: "Bank not found" }, 404);

    if (body.name !== undefined && !String(body.name).trim()) {
      return c.json({ error: "Bank name cannot be empty" }, 400);
    }

    if (body.slug !== undefined && slugify(body.slug) !== bank.slug) {
      const slug = slugify(body.slug);
      if (!slug) return c.json({ error: "Slug cannot be empty" }, 400);
      const clash = await c.env.DB.prepare("SELECT id FROM banks WHERE slug=? AND id<>?").bind(slug, id).first<any>();
      if (clash) return c.json({ error: `Another bank already uses the slug "${slug}"` }, 409);
      await c.env.DB.prepare("UPDATE banks SET slug=? WHERE id=?").bind(slug, id).run();
    }

    const next = {
      name: body.name ?? bank.name,
      short_name: body.shortName ?? body.short_name ?? bank.short_name,
      website: body.website === undefined ? bank.website : body.website || null,
      color: body.color ?? bank.color,
      summary: body.summary ?? bank.summary,
      active: body.active === undefined ? bank.active : body.active ? 1 : 0,
      country_id: body.countryId ?? body.country_id ?? bank.country_id,
    };

    await c.env.DB.prepare(
      "UPDATE banks SET name=?,short_name=?,website=?,color=?,summary=?,active=?,country_id=?,updated_at=? WHERE id=?",
    )
      .bind(next.name, next.short_name, next.website, next.color, next.summary, next.active, next.country_id, nowIso(), id)
      .run();

    const updated = await c.env.DB.prepare("SELECT * FROM banks WHERE id=?").bind(id).first<any>();
    await audit(c.env.DB, await actorOf(c.req.raw, c.env.DB), "update", "bank", id, updated?.name ?? "", next);
    return c.json({ ok: true, bank: updated });
  });

  app.delete("/api/admin/banks/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const bank = await c.env.DB.prepare("SELECT id,name,slug FROM banks WHERE id=?").bind(id).first<any>();
    if (!bank) return c.json({ error: "Bank not found" }, 404);

    const result = await deleteBankCascade(c.env.DB, c.env.REPORTS, id);
    await audit(c.env.DB, await actorOf(c.req.raw, c.env.DB), "delete", "bank", id, bank.name, result);
    return c.json({ ok: true, bankId: id, bankName: bank.name, ...result });
  });

  // ------------------------------------------------------------------ sources

  app.get("/api/admin/sources/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const source = await c.env.DB.prepare(
      "SELECT s.*,b.name bank_name FROM sources s JOIN banks b ON b.id=s.bank_id WHERE s.id=?",
    )
      .bind(id)
      .first<any>();
    if (!source) return c.json({ error: "Source not found" }, 404);
    return c.json({ source });
  });

  /**
   * Amend a reporting portal. Supports changing the URL, moving the portal to a
   * different bank, and reactivating a previously removed portal.
   */
  app.patch("/api/admin/sources/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const body = await c.req.json().catch(() => ({}) as any);
    const source = await c.env.DB.prepare("SELECT * FROM sources WHERE id=?").bind(id).first<any>();
    if (!source) return c.json({ error: "Source not found" }, 404);

    let url = source.url;
    if (body.url !== undefined) {
      const candidate = String(body.url).trim();
      if (!candidate) return c.json({ error: "Portal URL cannot be empty" }, 400);
      let parsed: URL;
      try {
        parsed = new URL(candidate);
      } catch {
        return c.json({ error: "Enter a full URL including https://" }, 400);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return c.json({ error: "Portal URL must use http or https" }, 400);
      }
      url = parsed.toString();
    }

    const bankId = Number(body.bankId ?? body.bank_id ?? source.bank_id);
    if (bankId !== Number(source.bank_id)) {
      const target = await c.env.DB.prepare("SELECT id FROM banks WHERE id=?").bind(bankId).first<any>();
      if (!target) return c.json({ error: "Target bank not found" }, 404);
    }

    const clash = await c.env.DB.prepare("SELECT id FROM sources WHERE bank_id=? AND url=? AND id<>?")
      .bind(bankId, url, id)
      .first<any>();
    if (clash) return c.json({ error: "That bank already has this reporting portal" }, 409);

    const active = body.active === undefined ? source.active : body.active ? 1 : 0;
    const sourceType = body.sourceType ?? body.source_type ?? source.source_type;

    await c.env.DB.prepare("UPDATE sources SET url=?,bank_id=?,source_type=?,active=? WHERE id=?")
      .bind(url, bankId, sourceType, active, id)
      .run();

    // Documents and values are keyed to the source. If the portal moved to a
    // different bank, its history has to move with it or the audit trail breaks.
    if (bankId !== Number(source.bank_id)) {
      const stamp = nowIso();
      await runQuiet(
        c.env.DB,
        "UPDATE financial_documents SET bank_id=?,updated_at=? WHERE source_id=?",
        bankId,
        stamp,
        id,
      );
      await runQuiet(c.env.DB, "UPDATE financial_records SET bank_id=?,updated_at=? WHERE source_id=?", bankId, stamp, id);
      await runQuiet(c.env.DB, "UPDATE financial_extractions SET bank_id=? WHERE source_id=?", bankId, id);
    }

    const updated = await c.env.DB.prepare(
      "SELECT s.*,b.name bank_name FROM sources s JOIN banks b ON b.id=s.bank_id WHERE s.id=?",
    )
      .bind(id)
      .first<any>();
    await audit(c.env.DB, await actorOf(c.req.raw, c.env.DB), "update", "source", id, url, {
      from: source.url,
      to: url,
      movedToBank: bankId !== Number(source.bank_id) ? bankId : null,
    });
    return c.json({ ok: true, source: updated });
  });

  /**
   * Remove a reporting portal.
   *
   * Default is a soft removal: the portal stops being collected but the
   * documents and values already gathered from it stay readable and citable.
   * `?purge=1` additionally destroys those documents, their R2 objects and the
   * extracted values.
   */
  app.delete("/api/admin/sources/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const source = await c.env.DB.prepare("SELECT * FROM sources WHERE id=?").bind(id).first<any>();
    if (!source) return c.json({ error: "Source not found" }, 404);
    const purge = c.req.query("purge") === "1" || c.req.query("purge") === "true";

    const documents = await countRows(c.env.DB, "SELECT COUNT(*) n FROM financial_documents WHERE source_id=?", id);
    const records = await countRows(c.env.DB, "SELECT COUNT(*) n FROM financial_records WHERE source_id=?", id);

    if (!purge) {
      await c.env.DB.prepare("UPDATE sources SET active=0 WHERE id=?").bind(id).run();
      await audit(c.env.DB, await actorOf(c.req.raw, c.env.DB), "deactivate", "source", id, source.url, {
        documentsRetained: documents,
        recordsRetained: records,
      });
      return c.json({
        ok: true,
        mode: "deactivated",
        sourceId: id,
        documentsRetained: documents,
        recordsRetained: records,
      });
    }

    let objectsDeleted = 0;
    if (c.env.REPORTS) {
      const { results } = await c.env.DB.prepare(
        "SELECT r2_key FROM financial_documents WHERE source_id=? AND r2_key IS NOT NULL",
      )
        .bind(id)
        .all<any>();
      for (const row of results ?? []) {
        try {
          await c.env.REPORTS.delete(String(row.r2_key));
          objectsDeleted++;
        } catch {
          // Object already gone.
        }
      }
    }

    await runQuiet(c.env.DB, "DELETE FROM source_checks WHERE source_id=?", id);
    await runQuiet(c.env.DB, "DELETE FROM financial_records WHERE source_id=?", id);
    await runQuiet(c.env.DB, "DELETE FROM financial_documents WHERE source_id=?", id);
    await runQuiet(c.env.DB, "DELETE FROM financial_extractions WHERE source_id=?", id);
    await c.env.DB.prepare("DELETE FROM sources WHERE id=?").bind(id).run();

    await audit(c.env.DB, await actorOf(c.req.raw, c.env.DB), "purge", "source", id, source.url, {
      documentsDeleted: documents,
      recordsDeleted: records,
      objectsDeleted,
    });
    return c.json({
      ok: true,
      mode: "purged",
      sourceId: id,
      documentsDeleted: documents,
      recordsDeleted: records,
      objectsDeleted,
    });
  });

  // ----------------------------------------------------------------- products

  app.get("/api/admin/banks/:id/products", async (c) => {
    const bankId = Number(c.req.param("id"));
    const { results } = await c.env.DB.prepare(
      "SELECT * FROM bank_products WHERE bank_id=? ORDER BY product_type,category,product_name",
    )
      .bind(bankId)
      .all<any>();
    return c.json({ data: results ?? [] });
  });

  app.post("/api/admin/banks/:id/products", async (c) => {
    const bankId = Number(c.req.param("id"));
    const body = await c.req.json().catch(() => ({}) as any);
    const bank = await c.env.DB.prepare("SELECT id,name FROM banks WHERE id=?").bind(bankId).first<any>();
    if (!bank) return c.json({ error: "Bank not found" }, 404);
    const productName = body.productName ?? body.product_name;
    if (!productName) return c.json({ error: "Product name is required" }, 400);
    const productType = String(body.productType ?? body.product_type ?? "").toLowerCase();
    if (!["deposit", "credit", "account", "transfer"].includes(productType)) {
      return c.json({ error: "productType must be one of: deposit, credit, account, transfer" }, 400);
    }

    const stamp = nowIso();
    await c.env.DB.prepare(
      `INSERT INTO bank_products(bank_id,product_name,product_type,category,rate,rate_note,min_amount,max_amount,tenor_months,fee,fee_note,eligibility,currency,source_url,source_title,effective_date,status,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
      .bind(
        bankId,
        productName,
        productType,
        body.category ?? null,
        body.rate ?? null,
        body.rateNote ?? body.rate_note ?? null,
        body.minAmount ?? body.min_amount ?? null,
        body.maxAmount ?? body.max_amount ?? null,
        body.tenorMonths ?? body.tenor_months ?? null,
        body.fee ?? null,
        body.feeNote ?? body.fee_note ?? null,
        body.eligibility ?? null,
        body.currency ?? null,
        body.sourceUrl ?? body.source_url ?? null,
        body.sourceTitle ?? body.source_title ?? null,
        body.effectiveDate ?? body.effective_date ?? stamp.slice(0, 10),
        body.status ?? "published",
        stamp,
        stamp,
      )
      .run();

    const row = await c.env.DB.prepare("SELECT * FROM bank_products WHERE bank_id=? ORDER BY id DESC LIMIT 1")
      .bind(bankId)
      .first<any>();
    await audit(
      c.env.DB,
      await actorOf(c.req.raw, c.env.DB),
      "create",
      "product",
      row?.id ?? null,
      row?.product_name ?? "",
      { bank: bank.name },
    );
    return c.json({ ok: true, product: row }, 201);
  });

  app.patch("/api/admin/products/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const body = await c.req.json().catch(() => ({}) as any);
    const product = await c.env.DB.prepare("SELECT * FROM bank_products WHERE id=?").bind(id).first<any>();
    if (!product) return c.json({ error: "Product not found" }, 404);

    const next = {
      product_name: body.productName ?? body.product_name ?? product.product_name,
      product_type: String(body.productType ?? body.product_type ?? product.product_type).toLowerCase(),
      category: body.category === undefined ? product.category : body.category,
      rate: body.rate === undefined ? product.rate : body.rate,
      rate_note: body.rateNote === undefined ? product.rate_note : body.rateNote,
      min_amount: body.minAmount === undefined ? product.min_amount : body.minAmount,
      max_amount: body.maxAmount === undefined ? product.max_amount : body.maxAmount,
      tenor_months: body.tenorMonths === undefined ? product.tenor_months : body.tenorMonths,
      fee: body.fee === undefined ? product.fee : body.fee,
      fee_note: body.feeNote === undefined ? product.fee_note : body.feeNote,
      eligibility: body.eligibility === undefined ? product.eligibility : body.eligibility,
      currency: body.currency === undefined ? product.currency : body.currency,
      source_url: body.sourceUrl === undefined ? product.source_url : body.sourceUrl,
      source_title: body.sourceTitle === undefined ? product.source_title : body.sourceTitle,
      effective_date: body.effectiveDate === undefined ? product.effective_date : body.effectiveDate,
      status: body.status ?? product.status,
    };
    if (!["deposit", "credit", "account", "transfer"].includes(next.product_type)) {
      return c.json({ error: "productType must be one of: deposit, credit, account, transfer" }, 400);
    }

    await c.env.DB.prepare(
      `UPDATE bank_products SET product_name=?,product_type=?,category=?,rate=?,rate_note=?,min_amount=?,max_amount=?,
       tenor_months=?,fee=?,fee_note=?,eligibility=?,currency=?,source_url=?,source_title=?,effective_date=?,status=?,updated_at=? WHERE id=?`,
    )
      .bind(
        next.product_name,
        next.product_type,
        next.category,
        next.rate,
        next.rate_note,
        next.min_amount,
        next.max_amount,
        next.tenor_months,
        next.fee,
        next.fee_note,
        next.eligibility,
        next.currency,
        next.source_url,
        next.source_title,
        next.effective_date,
        next.status,
        nowIso(),
        id,
      )
      .run();

    const updated = await c.env.DB.prepare("SELECT * FROM bank_products WHERE id=?").bind(id).first<any>();
    await audit(c.env.DB, await actorOf(c.req.raw, c.env.DB), "update", "product", id, next.product_name, next);
    return c.json({ ok: true, product: updated });
  });

  app.delete("/api/admin/products/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const product = await c.env.DB.prepare("SELECT * FROM bank_products WHERE id=?").bind(id).first<any>();
    if (!product) return c.json({ error: "Product not found" }, 404);
    await c.env.DB.prepare("DELETE FROM bank_products WHERE id=?").bind(id).run();
    await audit(c.env.DB, await actorOf(c.req.raw, c.env.DB), "delete", "product", id, product.product_name, {});
    return c.json({ ok: true, productId: id, productName: product.product_name });
  });

  // -------------------------------------------------------------- audit trail

  app.get("/api/admin/audit-log", async (c) => {
    const limit = Math.min(500, Math.max(1, Number(c.req.query("limit") || 100)));
    const { results } = await c.env.DB.prepare("SELECT * FROM admin_audit_log ORDER BY id DESC LIMIT ?")
      .bind(limit)
      .all<any>();
    return c.json({ data: results ?? [] });
  });
}

export { deleteBankCascade };
