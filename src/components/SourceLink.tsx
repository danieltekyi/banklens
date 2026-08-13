import { sourceText } from "../lib/format";

export default function SourceLink({ url, title, compact = false }: { url?: string | null; title?: string | null; compact?: boolean }) {
  if (!url) return <span className="source-note">Source not reported</span>;
  return <a className="source-link" href={url} target="_blank" rel="noreferrer" title={sourceText(title)}>{compact ? "Source ↗" : `${sourceText(title)} ↗`}</a>;
}
