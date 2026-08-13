import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import BankBadge from "../components/BankBadge";
import CountrySelect from "../components/CountrySelect";
import SourceLink from "../components/SourceLink";
import { EmptyState, ErrorState, LoadingBlock } from "../components/States";
import { api } from "../lib/api";
import { formatDate, formatValue } from "../lib/format";
import { useCountry } from "../hooks/useCountry";
import type { Recommendation } from "../types";

export default function Decide() {
  const { countries, country, setCountry } = useCountry();
  const [need, setNeed] = useState<"deposit" | "credit">("deposit");
  const [category, setCategory] = useState("");
  const [amount, setAmount] = useState("");
  const [tenor, setTenor] = useState("");
  const [rows, setRows] = useState<Recommendation[]>([]);
  const [message, setMessage] = useState("");
  const [methodology, setMethodology] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!country) return;
    const params = new URLSearchParams({ need, country });
    if (category) params.set("category", category);
    if (amount) params.set("amount", amount);
    if (tenor) params.set("tenor", tenor);
    setLoading(true); setError(null);
    api.recommend(params).then((r) => { setRows(r.data || []); setMessage(r.meta.message || ""); setMethodology(r.meta.methodology || ""); }).catch((err: Error) => setError(err.message)).finally(() => setLoading(false));
  }, [need, country, category, amount, tenor]);

  return <section className="shell page"><span className="kicker">Decision helper</span><h1>Choose a bank for what you need</h1><p className="lead">Tell BankLens whether you want to save or borrow. Recommendations show the trade-off between headline rate and bank strength, with source links for every rate.</p><div className="notice advice"><b>Information, not financial advice.</b><p>Use this as a shortlist. Confirm current terms, eligibility and suitability directly with the bank.</p></div><div className="decision-controls panel"><div className="segmented" role="tablist" aria-label="Customer need"><button className={need === "deposit" ? "on" : ""} onClick={() => setNeed("deposit")} aria-pressed={need === "deposit"}>Save / earn interest</button><button className={need === "credit" ? "on" : ""} onClick={() => setNeed("credit")} aria-pressed={need === "credit"}>Borrow / credit</button></div><CountrySelect countries={countries} value={country} onChange={setCountry} /><label className="field"><span>Category (optional)</span><input value={category} onChange={(e) => setCategory(e.target.value)} placeholder={need === "deposit" ? "savings" : "personal_loan"} /></label><label className="field"><span>Amount (optional)</span><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 5000" /></label><label className="field"><span>Tenor in months (optional)</span><input inputMode="numeric" value={tenor} onChange={(e) => setTenor(e.target.value)} placeholder="e.g. 24" /></label></div>{loading ? <LoadingBlock label="Ranking product options" /> : error ? <ErrorState message={error} /> : rows.length ? <div className="recommend-list">{rows.map((row) => <RecommendationCard key={row.productId} row={row} need={need} />)}</div> : <EmptyState title="No matching published rate cards" message={message || "An administrator has not added sourced product terms for these filters yet."} />}{methodology && <p className="source-note methodology-note"><b>Methodology:</b> {methodology}</p>}</section>;
}

function RecommendationCard({ row, need }: { row: Recommendation; need: "deposit" | "credit" }) {
  return <article className="product-card recommendation"><div className="between"><div><span className="pill">Rank #{row.rank}</span><h2>{row.productName}</h2></div><BankBadge bank={{ name: row.bankName, shortName: row.shortName, color: row.color }} meta={row.countryName} /></div><div className="tradeoff"><div><span>{need === "deposit" ? "Rate you earn" : "Rate you pay"}</span><b>{formatValue(row.rate, "percent")}</b></div><div><span>Rate score</span><b>{row.rateScore}/100</b></div><div><span>Strength score</span><b>{Math.round(row.strengthScore)}/100</b></div><div><span>Match score</span><b>{row.matchScore}/100</b></div></div><ul className="reason-list">{row.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul><div className="product-facts"><span>Fee: <b>{row.fee == null ? "Not reported" : `${row.currency || ""} ${row.fee}`}</b></span><span>Minimum: <b>{row.minAmount == null ? "Not reported" : `${row.currency || ""} ${row.minAmount}`}</b></span><span>Tenor: <b>{row.tenorMonths == null ? "Not reported" : `${row.tenorMonths} months`}</b></span><span>Effective: <b>{formatDate(row.effectiveDate)}</b></span></div>{row.eligibility && <p className="source-note"><b>Eligibility:</b> {row.eligibility}</p>}<SourceLink url={row.sourceUrl} title={row.sourceTitle} /><Link className="text-button" to={`/banks/${row.bankSlug}`}>Review bank profile →</Link></article>;
}
