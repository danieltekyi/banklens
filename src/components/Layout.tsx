import { BarChart3, GitCompare, Home, Landmark, LineChart, ShieldQuestion } from "lucide-react";
import { Link, NavLink, Outlet } from "react-router-dom";

const links = [
  { to: "/", label: "Overview", icon: Home },
  { to: "/rankings", label: "Rankings", icon: LineChart },
  { to: "/compare", label: "Compare", icon: GitCompare },
  { to: "/decide", label: "Decide", icon: ShieldQuestion },
  { to: "/methodology", label: "Method", icon: BarChart3 },
];

export default function Layout() {
  return (
    <div className="app">
      <header className="topbar">
        <div className="shell nav">
          <Link className="brand" to="/" aria-label="BankLens home">
            <span className="brandmark">BL</span>
            <span>BankLens<small>Traceable bank intelligence</small></span>
          </Link>
          <nav className="desktop-nav" aria-label="Primary navigation">
            {links.map(({ to, label }) => <NavLink key={to} to={to}>{label}</NavLink>)}
          </nav>
          <Link className="button small desktop-cta" to="/decide"><Landmark size={16} /> Choose a bank</Link>
        </div>
      </header>
      <main id="main-content"><Outlet /></main>
      <nav className="mobile-nav" aria-label="Primary navigation">
        {links.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to}><Icon aria-hidden="true" size={20} /><span>{label}</span></NavLink>)}
      </nav>
      <footer>
        <div className="shell foot">
          <div><b>BankLens</b><span>Figures remain traceable to bank-published source documents.</span></div>
          <p>Information only, not financial advice. Confirm current terms and suitability with each bank.</p>
        </div>
      </footer>
    </div>
  );
}
