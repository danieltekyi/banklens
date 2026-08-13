import type { Country } from "../types";

export default function CountrySelect({ countries, value, onChange, label = "Country" }: { countries: Country[]; value: string; onChange: (value: string) => void; label?: string }) {
  return (
    <label className="field compact"><span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} disabled={!countries.length} aria-label={label}>
        {!countries.length && <option value="">No countries configured</option>}
        {countries.map((country) => <option key={country.id} value={country.id}>{country.name} ({country.currency})</option>)}
      </select>
    </label>
  );
}
