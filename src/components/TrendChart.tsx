import type { TrendPoint } from "../types";
import { formatValue } from "../lib/format";

type Props = { points: TrendPoint[]; label: string; currency?: string; description: string };

export default function TrendChart({ points, label, currency, description }: Props) {
  if (points.length < 2) return <div className="notice"><b>No trend yet.</b><p>At least two sourced reporting periods are needed to draw a trend.</p></div>;
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const w = 760;
  const h = 260;
  const pad = 42;
  const xy = points.map((point, index) => ({
    x: pad + (index / Math.max(1, points.length - 1)) * (w - pad * 2),
    y: h - pad - ((point.value - min) / span) * (h - pad * 2),
    point,
  }));
  const path = xy.map((p, index) => `${index ? "L" : "M"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  return (
    <figure className="chart" aria-label={description}>
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-labelledby="chart-title chart-desc">
        <title id="chart-title">{label} trend</title>
        <desc id="chart-desc">{description}</desc>
        <line x1={pad} x2={w - pad} y1={h - pad} y2={h - pad} />
        <line x1={pad} x2={pad} y1={pad} y2={h - pad} />
        <path d={path} />
        {xy.map(({ x, y, point }, index) => (
          <g key={`${point.periodLabel || point.periodEnd}-${index}`}>
            <circle cx={x} cy={y} r="5" />
            <text x={x} y={Math.max(18, y - 12)} textAnchor="middle">{formatValue(point.value, point.unit, currency)}</text>
            <text x={x} y={h - 14} textAnchor="middle">{point.periodLabel || point.periodEnd || `P${index + 1}`}</text>
          </g>
        ))}
      </svg>
      <figcaption>Each plotted point is linked to its source report in the table below.</figcaption>
    </figure>
  );
}
