import { Link } from "react-router-dom";

export default function NotFound() {
  return <section className="shell page not-found"><span className="kicker">404</span><h1>This page is not in BankLens</h1><p className="lead">The address may be wrong, or the bank/profile may not exist in the selected local database.</p><div className="hero-actions"><Link className="button" to="/">Return home</Link><Link className="button secondary" to="/rankings">View rankings</Link></div></section>;
}
