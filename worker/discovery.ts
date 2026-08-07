const abs = (href: string, base: string) => {
	try {
		return new URL(href, base).href;
	} catch {
		return null;
	}
};

const clean = (value: string) => value.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&nbsp;|&#160;/g, " ").replace(/\s+/g, " ").trim();

const normalizeKey = (value: string) => clean(value).toLowerCase().replace(/\b(bank|ghana|limited|ltd|plc|the)\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");

const isBoilerplateLink = (title: string, url: string) => {
	const text = `${title} ${url}`.toLowerCase();
	return /\b(linkedin|youtube|facebook|twitter|instagram|sitemap|legal|cookies|contact us|search|external links|new bog internet banking|print|export|show|entries|first|previous|next|last)\b/.test(text) || text.includes("/cdn-cgi/") || text.startsWith("mailto:") || text.startsWith("tel:");
};

function deriveShortName(name: string) {
	const parts = clean(name).split(/[^A-Za-z0-9]+/).filter(Boolean);
	const initials = parts.map((part) => part[0]).join("").toUpperCase();
	return initials.slice(0, 3) || clean(name).slice(0, 3).toUpperCase();
}

function colorFromString(value: string) {
	let hash = 0;
	for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	const hue = hash % 360;
	return `hsl(${hue} 55% 42%)`;
}

function extractBankRows(html: string, baseUrl: string) {
	const rows: Array<{ name: string; website: string; summary: string }> = [];
	for (const rowMatch of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
		const rowHtml = rowMatch[1];
		const cells = [...rowHtml.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((match) => clean(match[1]));
		if (cells.length < 4) continue;
		const name = clean(cells[0]);
		const websiteText = clean(cells[3] || "");
		const websiteHref = [...rowHtml.matchAll(/href=["']([^"']+)["']/gi)].map((match) => match[1]).find((href) => /^https?:\/\//i.test(href));
		const website = websiteHref ? abs(websiteHref, baseUrl) : /^https?:\/\//i.test(websiteText) ? abs(websiteText, baseUrl) : null;
		if (!name || !website) continue;
		if (isBoilerplateLink(name, website)) continue;
		rows.push({ name, website, summary: clean(cells[1] || "") });
	}
	return rows;
}

async function syncBankDirectory(env: Env, country: any, html: string) {
	const directoryRows = extractBankRows(html, country.bank_directory_url);
	if (!directoryRows.length) return { banksUpserted: 0 };

	const { results: existingBanks } = await env.DB.prepare("SELECT id,slug,name,short_name,website,country_id,summary,health_score,color FROM banks").all<any>();
	const byKey = new Map<string, any>();
	const byWebsite = new Map<string, any>();

	for (const bank of existingBanks) {
		byKey.set(normalizeKey(bank.slug || bank.name || ""), bank);
		byKey.set(normalizeKey(bank.name || ""), bank);
		if (bank.website) byWebsite.set(new URL(bank.website).hostname.replace(/^www\./, ""), bank);
	}

	let upserted = 0;
	for (const row of directoryRows) {
		const key = normalizeKey(row.name);
		const websiteHost = new URL(row.website).hostname.replace(/^www\./, "");
		const existing = byKey.get(key) || byWebsite.get(websiteHost) || null;
		const slug = existing?.slug || clean(row.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || `bank-${upserted + 1}`;
		const shortName = existing?.short_name || deriveShortName(row.name);
		const color = existing?.color || colorFromString(row.name);
		const summary = existing?.summary || `${clean(row.name)} is listed in the central bank directory.`;
		const updatedAt = new Date().toISOString();

		if (existing) {
			await env.DB.prepare(
				"UPDATE banks SET name=?, short_name=?, color=?, summary=COALESCE(NULLIF(summary,''), ?), active=1, country_id=?, website=COALESCE(website, ?), updated_at=? WHERE id=?",
			)
				.bind(row.name, shortName, color, summary, country.id, row.website, updatedAt, existing.id)
				.run();
		} else {
			await env.DB.prepare(
				"INSERT INTO banks(slug,name,short_name,color,health_score,summary,active,country_id,website,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
			)
				.bind(slug, row.name, shortName, color, 0, summary, 1, country.id, row.website, updatedAt)
				.run();
		}

		const bank = existing || (await env.DB.prepare("SELECT id FROM banks WHERE slug=? LIMIT 1").bind(slug).first<any>());
		if (bank?.id) {
			const sourceExists = await env.DB.prepare("SELECT id FROM sources WHERE bank_id=? AND url=? LIMIT 1").bind(bank.id, row.website).first<any>();
			if (!sourceExists) {
				await env.DB.prepare("INSERT INTO sources(bank_id,url,source_type,active) VALUES(?,?,?,1)").bind(bank.id, row.website, "directory").run();
			}
		}

		upserted++;
	}

	return { banksUpserted: upserted };
}

export async function discoverCountry(env: Env, countryId: number) {
	const country = await env.DB.prepare("SELECT * FROM countries WHERE id=? AND enabled=1").bind(countryId).first<any>();
	if (!country) throw new Error("Country is not enabled");
	const res = await fetch(country.bank_directory_url, { headers: { "User-Agent": "BankLensBot/0.2 (+https://banklens.tiwaak.com/methodology)" } });
	if (!res.ok) throw new Error(`Regulator returned ${res.status}`);
	const html = await res.text();
	const bankSync = await syncBankDirectory(env, country, html);
	const links = [...html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
		.map((match) => ({ url: abs(match[1], country.bank_directory_url), title: clean(match[2]) }))
		.filter((link) => link.url && link.title && !isBoilerplateLink(link.title, link.url!));

	let found = 0;
	for (const link of links) {
		const u = new URL(link.url!);
		if (!/^https?:$/.test(u.protocol)) continue;
		const kind = /annual|report|financial|statement|investor/i.test(link.title + link.url) ? "financial" : /fee|tariff|rate|loan|saving|product/i.test(link.title + link.url) ? "product" : "candidate";
		await env.DB.prepare("INSERT OR IGNORE INTO discovered_links(country_id,url,kind,title) VALUES(?,?,?,?)").bind(countryId, link.url, kind, link.title.slice(0, 300)).run();
		found++;
	}

	await env.DB.prepare("UPDATE countries SET discovery_status='completed',last_discovered_at=? WHERE id=?").bind(new Date().toISOString(), countryId).run();
	return { country: country.name, linksFound: found, banksUpserted: bankSync.banksUpserted };
}

export async function runDiscovery(env: Env) {
	const { results } = await env.DB.prepare("SELECT id FROM countries WHERE enabled=1").all<{ id: number }>();
	const output = [];
	for (const c of results) {
		try {
			output.push(await discoverCountry(env, c.id));
		} catch (error) {
			output.push({ countryId: c.id, error: String(error) });
		}
	}
	return output;
}