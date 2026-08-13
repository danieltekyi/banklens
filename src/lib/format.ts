export function formatDate(value?: string | null) {
  if (!value) return "Not reported";
  // A reporting period end such as "2026-12-31" is a calendar date, not an
  // instant. `new Date("2026-12-31")` is parsed as UTC midnight, which renders
  // as 30 December for anyone west of UTC. Build date-only values in local time
  // so a financial year end is never shown as the day before.
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  const date = dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    : new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function formatValue(value: number | null | undefined, unit?: string | null, currency?: string | null) {
  if (value == null || Number.isNaN(Number(value))) return "Not reported";
  const n = Number(value);
  if (unit === "percent") return `${trim(n)}%`;
  if (unit === "score") return `${trim(n)}/100`;
  if (unit?.includes("bn")) return `${currency || ""} ${trim(n)}bn`.trim();
  if (unit === "amount") return `${currency || ""} ${trim(n)}`.trim();
  return `${trim(n)}${unit ? ` ${unit}` : ""}`;
}

export function trim(value: number) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
}

export function sourceText(title?: string | null) {
  return title || "Published source";
}

export function directionCopy(direction?: string) {
  if (direction === "lower_is_better") return "Lower is better";
  if (direction === "higher_is_better") return "Higher is better";
  return "Context matters";
}
