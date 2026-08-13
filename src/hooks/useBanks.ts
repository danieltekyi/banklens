import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { demoBanks } from "../data/demo";
import type { Bank } from "../types";

export function useBanks(country?: string) {
  const [banks, setBanks] = useState<Bank[]>([]);
  const [loading, setLoading] = useState(true);
  const [demo, setDemo] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.banks(country)
      .then((result) => {
        if (!alive) return;
        setBanks(result.data || []);
        setDemo(Boolean(result.meta?.demo));
      })
      .catch((err: Error) => {
        if (!alive) return;
        setBanks(demoBanks);
        setDemo(true);
        setError(err.message);
      })
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [country]);

  return { banks, loading, demo, error };
}
