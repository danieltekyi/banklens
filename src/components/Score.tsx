export default function Score({ value, coverage }: { value: number | null | undefined; coverage?: number }) {
  if (value == null || value <= 0) return <span className="score pending" title="No score is available because there is not enough sourced data.">Not scored<small>Missing data</small></span>;
  const label = value >= 75 ? "Strong" : value >= 55 ? "Watch" : "Weak";
  return <span className={`score ${value >= 75 ? "good" : value >= 55 ? "warn" : "bad"}`} title={`Financial strength score ${value} out of 100${coverage != null ? `, ${coverage}% coverage` : ""}`}>{Math.round(value)}<small>{label}</small></span>;
}
