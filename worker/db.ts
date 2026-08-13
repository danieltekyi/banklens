export async function listBanks(db:D1Database, countryId?:number){
  // A bank is publicly visible when it is either still configured for
  // collection (an active financial portal) or already has published values.
  // The second case matters because removing a portal is deliberately a soft
  // delete: the figures gathered from it stay citable, so the bank must not
  // vanish from the public site along with its history.
  const visible = `(EXISTS (SELECT 1 FROM sources fs WHERE fs.bank_id=b.id AND fs.active=1 AND fs.source_type='financial_portal')
      OR EXISTS (SELECT 1 FROM financial_records fr WHERE fr.bank_id=b.id AND fr.status='published'))`;
  const where = countryId
    ? `WHERE b.active=1 AND b.country_id=? AND ${visible}`
    : `WHERE b.active=1 AND ${visible}`;
  const stmt = countryId
    ? db.prepare(`SELECT b.*,c.name country_name,m.assets,m.deposits,m.profit,m.capital_adequacy,m.liquidity,m.npl,m.reporting_period,m.reporting_period_end,m.assets_source_url,m.deposits_source_url,m.profit_source_url,m.capital_adequacy_source_url,m.liquidity_source_url,m.npl_source_url,p.savings_rate,p.loan_rate,p.transfer_fee,p.minimum_balance FROM banks b JOIN countries c ON c.id=b.country_id LEFT JOIN banklens_latest_metrics m ON m.bank_id=b.id LEFT JOIN latest_products p ON p.bank_id=b.id ${where} ORDER BY b.health_score DESC,b.name`).bind(countryId)
    : db.prepare(`SELECT b.*,c.name country_name,m.assets,m.deposits,m.profit,m.capital_adequacy,m.liquidity,m.npl,m.reporting_period,m.reporting_period_end,m.assets_source_url,m.deposits_source_url,m.profit_source_url,m.capital_adequacy_source_url,m.liquidity_source_url,m.npl_source_url,p.savings_rate,p.loan_rate,p.transfer_fee,p.minimum_balance FROM banks b JOIN countries c ON c.id=b.country_id LEFT JOIN banklens_latest_metrics m ON m.bank_id=b.id LEFT JOIN latest_products p ON p.bank_id=b.id ${where} ORDER BY b.health_score DESC,b.name`);
  const {results}=await stmt.all();
  return results.map(mapBank);
}

export async function findBank(db:D1Database,slug:string){
  const row=await db.prepare(`SELECT b.*,c.name country_name,m.assets,m.deposits,m.profit,m.capital_adequacy,m.liquidity,m.npl,m.reporting_period,m.reporting_period_end,m.assets_source_url,m.deposits_source_url,m.profit_source_url,m.capital_adequacy_source_url,m.liquidity_source_url,m.npl_source_url,p.savings_rate,p.loan_rate,p.transfer_fee,p.minimum_balance FROM banks b JOIN countries c ON c.id=b.country_id LEFT JOIN banklens_latest_metrics m ON m.bank_id=b.id LEFT JOIN latest_products p ON p.bank_id=b.id WHERE b.slug=? AND b.active=1
    AND (EXISTS (SELECT 1 FROM sources fs WHERE fs.bank_id=b.id AND fs.active=1 AND fs.source_type='financial_portal')
      OR EXISTS (SELECT 1 FROM financial_records fr WHERE fr.bank_id=b.id AND fr.status='published'))`).bind(slug).first<any>();
  return row?mapBank(row):null;
}

function mapBank(x:any){return{
  id:String(x.id),slug:x.slug,name:x.name,shortName:x.short_name,color:x.color,healthScore:x.health_score,summary:x.summary,updatedAt:x.updated_at,countryName:x.country_name,
  metrics:{assets:x.assets??null,deposits:x.deposits??null,profit:x.profit??null,capitalAdequacy:x.capital_adequacy??null,liquidity:x.liquidity??null,npl:x.npl??null},
  metricSources:{assets:x.assets_source_url??null,deposits:x.deposits_source_url??null,profit:x.profit_source_url??null,capitalAdequacy:x.capital_adequacy_source_url??null,liquidity:x.liquidity_source_url??null,npl:x.npl_source_url??null},
  reportingPeriod:x.reporting_period??null,reportingPeriodEnd:x.reporting_period_end??null,
  products:{savingsRate:x.savings_rate??null,loanRate:x.loan_rate??null,transferFee:x.transfer_fee??null,minimumBalance:x.minimum_balance??null}
};}
