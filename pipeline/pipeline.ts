type PipelineRecord = {
  bank_name:string; country_name:string; country_iso2:string;
  source_url:string; source_title:string; report_type:string;
  content_hash:string; period_label:string; reporting_period_start:string;
  reporting_period_end:string; metric_key:string; metric_label:string;
  raw_value:string; value:number; unit:string; currency:string|null;
  local_path?:string;
};

function slug(s:string){return s.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");}

export async function syncPipelineRecords(db:D1Database, country:any, records:PipelineRecord[]){
  if(!Array.isArray(records) || records.length>100) throw new Error("records must be an array of at most 100 items");
  const now=new Date().toISOString();
  const c=await db.prepare("SELECT id FROM countries WHERE iso2=?").bind(String(country.iso2).toUpperCase()).first<any>();
  if(!c) throw new Error(`Country ${country.iso2} is not configured in BankLens`);
  let synced=0;
  const bankIds=new Set<number>();
  for(const r of records){
    const bank=await db.prepare("SELECT id FROM banks WHERE country_id=? AND name=?").bind(c.id,r.bank_name).first<any>();
    if(!bank) throw new Error(`Configured bank not found: ${r.bank_name}`);
    const source=await db.prepare("SELECT id FROM sources WHERE bank_id=? AND url=? AND source_type='financial_portal'").bind(bank.id,r.source_url).first<any>();
    if(!source) throw new Error(`Configured financial portal not found for ${r.bank_name}: ${r.source_url}`);
    bankIds.add(Number(bank.id));
    const existing=await db.prepare("SELECT id FROM financial_documents WHERE source_id=? AND report_url=? AND content_hash=?").bind(source.id,r.source_url,r.content_hash).first<any>();
    let documentId=existing?.id;
    if(documentId){
      await db.prepare(`UPDATE financial_documents SET bank_id=?,report_title=?,report_type=?,content_type='application/pdf',reporting_period_start=?,reporting_period_end=?,period_label=?,status='published',error=NULL,processed_at=?,updated_at=? WHERE id=?`)
        .bind(bank.id,r.source_title,r.report_type,r.reporting_period_start,r.reporting_period_end,r.period_label,now,now,documentId).run();
    } else {
      const ins=await db.prepare(`INSERT INTO financial_documents(bank_id,source_id,report_url,report_title,report_type,content_hash,content_type,r2_key,reporting_period_start,reporting_period_end,period_label,status,discovered_at,downloaded_at,processed_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(bank.id,source.id,r.source_url,r.source_title,r.report_type,r.content_hash,"application/pdf",null,r.reporting_period_start,r.reporting_period_end,r.period_label,"published",now,now,now,now,now).run();
      documentId=Number(ins.meta?.last_row_id||0);
    }
    await db.prepare(`DELETE FROM financial_records WHERE bank_id=? AND source_id=? AND source_url=? AND content_hash=? AND metric_key=?`)
      .bind(bank.id,source.id,r.source_url,r.content_hash,r.metric_key).run();
    await db.prepare(`INSERT INTO financial_records(bank_id,source_id,source_url,source_title,metric_key,metric_label,raw_value,value,unit,currency,reporting_period_start,reporting_period_end,period_label,statement_date,content_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(bank.id,source.id,r.source_url,r.source_title,r.metric_key,r.metric_label,r.raw_value,r.value,r.unit,r.currency,r.reporting_period_start,r.reporting_period_end,r.period_label,r.reporting_period_end,r.content_hash,"published",now,now).run();
    synced++;
  }
  return {synced,bankIds:[...bankIds]};
}

export async function finalizePipeline(db:D1Database, countryIso2:string, bankIds:number[]){
  const now=new Date().toISOString();
  const unique=[...new Set(bankIds.map(Number))];
  for(const bankId of unique){
    const rows=await db.prepare(`SELECT metric_key,value,unit,reporting_period_end,period_label,source_url,source_title FROM financial_records WHERE bank_id=? AND status='published' ORDER BY reporting_period_end DESC,id DESC`).bind(bankId).all<any>();
    const snapshot:any={bank_id:bankId,updated_at:now};
    for(const row of rows.results||[]) if(snapshot[row.metric_key]==null){
      snapshot[row.metric_key]=row.value;
      snapshot[`${row.metric_key}_source_url`]=row.source_url;
      snapshot[`${row.metric_key}_source_title`]=row.source_title;
      snapshot.reporting_period=row.period_label;
      snapshot.reporting_period_end=row.reporting_period_end;
    }
    const names=["bank_id","assets","deposits","profit","capital_adequacy","liquidity","npl","reporting_period","reporting_period_end","updated_at","assets_source_url","assets_source_title","deposits_source_url","deposits_source_title","profit_source_url","profit_source_title","capital_adequacy_source_url","capital_adequacy_source_title","liquidity_source_url","liquidity_source_title","npl_source_url","npl_source_title"];
    await db.prepare("DELETE FROM banklens_latest_metrics WHERE bank_id=?").bind(bankId).run();
    await db.prepare(`INSERT INTO banklens_latest_metrics(${names.join(",")}) VALUES(${names.map(()=>"?").join(",")})`).bind(...names.map(n=>snapshot[n]??null)).run();
    await rebuildAnalysis(db,bankId,now);
  }
  return {banksFinalized:unique.length};
}

async function rebuildAnalysis(db:D1Database,bankId:number,now:string){
  const rows=await db.prepare("SELECT metric_key,value,reporting_period_end FROM financial_records WHERE bank_id=? AND status='published' ORDER BY reporting_period_end DESC,id DESC").bind(bankId).all<any>();
  const latest:any={}; for(const r of rows.results||[]) if(latest[r.metric_key]==null) latest[r.metric_key]=Number(r.value);
  const strengths:string[]=[]; const weaknesses:string[]=[];
  if(Number.isFinite(latest.capital_adequacy)) (latest.capital_adequacy>=15?strengths:weaknesses).push(`Capital adequacy ${latest.capital_adequacy>=15?"is":"is below the configured reference level."}`);
  if(Number.isFinite(latest.liquidity)) (latest.liquidity>=20?strengths:weaknesses).push(`Liquidity indicator is ${latest.liquidity>=20?"strong":"a watch point"}.`);
  if(Number.isFinite(latest.npl)) (latest.npl<=5?strengths:weaknesses).push(`NPL ratio is ${latest.npl<=5?"relatively low":"a watch point"}.`);
  const vals=["capital_adequacy","liquidity","roe","roa"].map(k=>latest[k]).filter(Number.isFinite);
  const score=vals.length?Math.max(0,Math.min(100,Math.round(vals.reduce((a:number,b:number)=>a+b,0)/vals.length*4))):50;
  await db.prepare(`INSERT INTO bank_analysis(bank_id,strengths_json,weaknesses_json,generated_at) VALUES(?,?,?,?) ON CONFLICT(bank_id) DO UPDATE SET strengths_json=excluded.strengths_json,weaknesses_json=excluded.weaknesses_json,generated_at=excluded.generated_at`)
    .bind(bankId,JSON.stringify(strengths),JSON.stringify(weaknesses),now).run();
  await db.prepare("UPDATE banks SET health_score=?,summary=?,updated_at=? WHERE id=?").bind(score,strengths[0]||"Financial history is being built from configured official reports.",now,bankId).run();
}
