import type { Bank, CompareBank } from "../types";

type BadgeBank = Pick<Bank, "name" | "shortName" | "color"> | Pick<CompareBank, "name" | "shortName" | "color">;

export default function BankBadge({ bank, meta }: { bank: BadgeBank; meta?: string }) {
  return (
    <div className="bank-id">
      <span className="bank-logo" style={{ background: bank.color || "#08715f" }} aria-hidden="true">{bank.shortName || initials(bank.name)}</span>
      <div><b>{bank.name}</b>{meta && <small>{meta}</small>}</div>
    </div>
  );
}

function initials(name: string) { return name.split(/\s+/).slice(0, 2).map((x) => x[0]).join("").toUpperCase(); }
