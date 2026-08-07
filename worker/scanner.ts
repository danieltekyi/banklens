type Source = { id: number; bank_id: number; url: string; source_type: string };

export async function runScan(env: Env) {
	const started = new Date().toISOString();
	let checked = 0, changed = 0, failed = 0;
	const { results } = await env.DB.prepare("SELECT id,bank_id,url,source_type FROM sources WHERE active=1").all<Source>();
	for (const source of results) {
		checked++;
		try {
			const response = await fetch(source.url, { headers: { "User-Agent": "BankLensBot/0.1 (+https://banklens.tiwaak.com/methodology)" } });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const body = await response.arrayBuffer();
			const hash = await crypto.subtle.digest("SHA-256", body);
			const hex = [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2, "0")).join("");
			const prior = await env.DB.prepare("SELECT content_hash FROM source_checks WHERE source_id=? ORDER BY checked_at DESC LIMIT 1").bind(source.id).first<{ content_hash: string }>();
			if (prior?.content_hash !== hex) {
				changed++;
				const key = `sources/${source.bank_id}/${Date.now()}-${source.id}`;
				await env.REPORTS.put(key, body, { httpMetadata: { contentType: response.headers.get("content-type") || "application/octet-stream" }, customMetadata: { sourceUrl: source.url, hash: hex } });
			}
			await env.DB.prepare("INSERT INTO source_checks(source_id,status,content_hash,checked_at,error) VALUES(?,?,?,?,NULL)").bind(source.id, "ok", hex, new Date().toISOString()).run();
		} catch (error) {
			failed++;
			await env.DB.prepare("INSERT INTO source_checks(source_id,status,checked_at,error) VALUES(?,?,?,?)").bind(source.id, "error", new Date().toISOString(), String(error)).run();
		}
	}
	await env.DB.prepare("INSERT INTO scan_runs(started_at,finished_at,checked,changed,failed,country_id) VALUES(?,?,?,?,?,NULL)").bind(started, new Date().toISOString(), checked, changed, failed).run();
	return { checked, changed, failed };
}

export async function runScanForCountry(env: Env, countryId: number, progress?: (info: { checked: number; total: number; changed: number; failed: number; currentSourceId: number | null; bankId: number | null }) => Promise<void> | void) {
	const started = new Date().toISOString();
	let checked = 0, changed = 0, failed = 0;
	const { results: sources } = await env.DB.prepare("SELECT s.id,s.bank_id,s.url,s.source_type FROM sources s JOIN banks b ON s.bank_id=b.id WHERE b.country_id=? AND s.active=1").bind(countryId).all<Source>();
	const total = sources.length;
	for (const source of sources) {
		checked++;
		try {
			if (progress) await progress({ checked, total, changed, failed, currentSourceId: source.id, bankId: source.bank_id });
			const response = await fetch(source.url, { headers: { "User-Agent": "BankLensBot/0.1 (+https://banklens.tiwaak.com/methodology)" } });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const body = await response.arrayBuffer();
			const hash = await crypto.subtle.digest("SHA-256", body);
			const hex = [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2, "0")).join("");
			const prior = await env.DB.prepare("SELECT content_hash FROM source_checks WHERE source_id=? ORDER BY checked_at DESC LIMIT 1").bind(source.id).first<{ content_hash: string }>();
			if (prior?.content_hash !== hex) {
				changed++;
				const key = `sources/${source.bank_id}/${Date.now()}-${source.id}`;
				await env.REPORTS.put(key, body, { httpMetadata: { contentType: response.headers.get("content-type") || "application/octet-stream" }, customMetadata: { sourceUrl: source.url, hash: hex } });
			}
			await env.DB.prepare("INSERT INTO source_checks(source_id,status,content_hash,checked_at,error) VALUES(?,?,?,?,NULL)").bind(source.id, "ok", hex, new Date().toISOString()).run();
		} catch (error) {
			failed++;
			await env.DB.prepare("INSERT INTO source_checks(source_id,status,checked_at,error) VALUES(?,?,?,?)").bind(source.id, "error", new Date().toISOString(), String(error)).run();
		}
		if (progress) await progress({ checked, total, changed, failed, currentSourceId: null, bankId: null });
	}
	await env.DB.prepare("INSERT INTO scan_runs(started_at,finished_at,checked,changed,failed,country_id) VALUES(?,?,?,?,?,?)").bind(started, new Date().toISOString(), checked, changed, failed, countryId).run();
	return { checked, changed, failed, total };
}