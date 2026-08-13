import { ArrowRight, BadgeCheck, Database, FileText, Globe2, LineChart, Search, ShieldAlert } from "lucide-react";
import { Link } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import BankBadge from "../components/BankBadge";
import CountrySelect from "../components/CountrySelect";
import Score from "../components/Score";
import SourceLink from "../components/SourceLink";
import { EmptyState, ErrorState, LoadingBlock } from "../components/States";
import { api } from "../lib/api";
import { formatDate, formatValue } from "../lib/format";
import { useCountry } from "../hooks/useCountry";
import type { Bank, Overview, RankingRow } from "../types";

export default function Home() {
  const { countries, country, setCountry, currentCountry } = useCountry();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [leaders, setLeaders] = useState<RankingRow[]>([]);
  const [banks, setBanks] = useState<Bank[]>([]);
  const [demo, setDemo] = useState(false);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!country) return;
    let alive = true;
    setLoading(true);
    setError(null);
    Promise.all([api.overview(country), api.rankings(new URLSearchParams({ country, metric: "overall" })), api.banks(country)])
      .then(([overviewResult, rankingResult, bankResult]) => {
        if (!alive) return;
        setOverview(overviewResult.data);
        setLeaders(rankingResult.data || []);
        setBanks(bankResult.data || []);
        setDemo(Boolean(bankResult.meta?.demo));
      })
      .catch((err: Error) => alive && setError(err.message || "Could not load the public overview."))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [country]);

  const shown = useMemo(() => banks.filter((bank) => bank.name.toLowerCase().includes(query.toLowerCase())).slice(0, 5), [banks, query]);
  const top = leaders[0];

  return (
    <>
      <section className="hero shell">
        <div>
          <span className="eyebrow">Published-source bank comparison</span>
          <h1>Understand which banks are actually strong.</h1>
          <p>BankLens turns audited reports into plain-English comparisons, rankings and trend charts. Every number links back to the bank's own published source.</p>
          <div className="hero-actions">
            <Link className="button" to="/rankings"><LineChart size={18} /> View rankings</Link>
            <Link className="button secondary" to="/decide">Choose a bank</Link>
          </div>
          <div className="search" role="search">
            <Search size={20} aria-hidden="true" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a bank in this country" aria-label="Search banks" />
          </div>
          {shown.length > 0 && <div className="quick-results">{shown.map((bank) => <Link key={bank.slug} to={`/banks/${bank.slug}`}>{bank.name}<ArrowRight size={14} /></Link>)}</div>}
        </div>
        <aside className="hero-card" aria-label="Market overview">
          <CountrySelect countries={countries} value={country} onChange={setCountry} label="Viewing" />
          {loading ? <LoadingBlock label="Loading market overview" /> : error ? <ErrorState message={error} /> : overview ? (
            <>
              {demo && <div className="demo-banner"><ShieldAlert size={18} /> Sample data is showing. These are not published results.</div>}
              <h2>{currentCountry?.name || "Selected market"}</h2>
              <div className="snapshot">
                <Stat value={overview.banks} label="Banks tracked" />
                <Stat value={overview.reports} label="Source reports" />
                <Stat value={overview.valuesPublished} label="Published values" />
                <Stat value={formatDate(overview.latestPeriod)} label="Latest period" />
              </div>
              {top ? <div className="hero-note"><b>Current leader:</b> {top.name} <Score value={top.value} coverage={top.coverage} /></div> : <p className="hero-note">No rankings yet. An administrator needs to publish bank figures for this country.</p>}
            </>
          ) : <EmptyState title="No country configured" message="Ask an administrator to add a country and its commercial banks." />}
        </aside>
      </section>

      <section className="shell section">
        <div className="section-head"><div><span className="kicker">Start here</span><h2>Answer practical questions quickly</h2></div></div>
        <div className="answer-grid">
          <Answer icon={<BadgeCheck />} title="Who looks strongest?" text="Rank by overall financial strength, with coverage caveats." to="/rankings" />
          <Answer icon={<Database />} title="Can I trust the number?" text="Open each source report beside each value." to="/methodology" />
          <Answer icon={<Globe2 />} title="How do peers compare?" text="Compare two to six banks side-by-side." to="/compare" />
          <Answer icon={<FileText />} title="Which product fits?" text="Weigh rates against bank strength before deciding." to="/decide" />
        </div>
      </section>

      <section className="shell section">
        <div className="panel">
          <div className="section-head"><div><span className="kicker">Leaderboard preview</span><h2>Top reported strength scores</h2></div><Link to="/rankings">See all <ArrowRight size={16} /></Link></div>
          {loading ? <LoadingBlock /> : leaders.length ? <div className="table-wrap"><table className="responsive-table"><thead><tr><th>Rank</th><th>Bank</th><th>Score</th><th>Coverage</th><th>Source evidence</th></tr></thead><tbody>{leaders.slice(0, 5).map((row) => <tr key={row.slug}><td data-label="Rank">#{row.rank}</td><td data-label="Bank"><BankBadge bank={{ name: row.name, shortName: row.shortName || row.name.slice(0, 2), color: row.color || "#08715f" }} /></td><td data-label="Score"><Score value={row.value} coverage={row.coverage} /></td><td data-label="Coverage">{row.coverage ?? 0}%</td><td data-label="Source evidence">{row.sources?.[0] ? <SourceLink url={row.sources[0].url} title={row.sources[0].title} /> : "Not reported"}</td></tr>)}</tbody></table></div> : <EmptyState title="No published rankings yet" message="Once reports are processed, the leaderboard will appear here with source links." />}
        </div>
      </section>
    </>
  );
}

function Stat({ value, label }: { value: number | string; label: string }) { return <div><b>{value}</b><span>{label}</span></div>; }
function Answer({ icon, title, text, to }: { icon: React.ReactNode; title: string; text: string; to: string }) { return <Link className="answer" to={to}>{icon}<h3>{title}</h3><p>{text}</p><b>Open <ArrowRight size={16} /></b></Link>; }
