import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import type { Country } from "../types";

const STORAGE_KEY = "banklens.country";

export function useCountry() {
  const [countries, setCountries] = useState<Country[]>([]);
  const [country, setCountryState] = useState(() => localStorage.getItem(STORAGE_KEY) || "");
  const [loadingCountries, setLoadingCountries] = useState(true);
  const [countryError, setCountryError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoadingCountries(true);
    api.countries()
      .then((result) => {
        if (!alive) return;
        const list = result.data || [];
        setCountries(list);
        const saved = localStorage.getItem(STORAGE_KEY);
        const next = saved && list.some((c) => String(c.id) === saved) ? saved : list[0] ? String(list[0].id) : "";
        setCountryState(next);
        if (next) localStorage.setItem(STORAGE_KEY, next);
      })
      .catch((error: Error) => alive && setCountryError(error.message || "Could not load countries."))
      .finally(() => alive && setLoadingCountries(false));
    return () => { alive = false; };
  }, []);

  const setCountry = (value: string) => {
    setCountryState(value);
    if (value) localStorage.setItem(STORAGE_KEY, value);
  };

  const currentCountry = useMemo(() => countries.find((c) => String(c.id) === country), [countries, country]);
  return { countries, country, setCountry, currentCountry, loadingCountries, countryError };
}
