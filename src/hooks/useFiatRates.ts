import { useState, useEffect } from "react";

export type FiatCurrency =
  | "USD" | "EUR" | "GBP" | "GHS" | "NGN" | "JPY" | "CNY" | "INR"
  | "BRL" | "MXN" | "KRW" | "RUB" | "TRY" | "AED" | "SAR" | "ILS"
  | "PKR" | "BDT" | "IDR" | "THB" | "VND" | "PHP" | "MYR" | "PLN"
  | "SEK" | "DKK" | "NOK" | "CZK" | "HUF" | "RON" | "UAH" | "ZAR" | "KES";

interface FiatRates {
  rates: Record<FiatCurrency, number>;
  loading: boolean;
  lastUpdated: Date | null;
  error: string | null;
  convert: (usd: number, currency: FiatCurrency) => number;
}

const DEFAULT_RATES: Record<FiatCurrency, number> = {
  USD: 1, EUR: 0.92, GBP: 0.79, GHS: 15.5, NGN: 1600,
  JPY: 155, CNY: 7.25, INR: 84, BRL: 5.8, MXN: 20,
  KRW: 1370, RUB: 92, TRY: 34, AED: 3.67, SAR: 3.75,
  ILS: 3.7, PKR: 278, BDT: 118, IDR: 15800, THB: 34,
  VND: 25000, PHP: 57, MYR: 4.7, PLN: 4, SEK: 10.5,
  DKK: 6.9, NOK: 10.9, CZK: 23, HUF: 360, RON: 4.6,
  UAH: 41, ZAR: 18, KES: 129,
};

const CODES = Object.keys(DEFAULT_RATES) as FiatCurrency[];

async function fetchFromOpenErApi(): Promise<Record<FiatCurrency, number> | null> {
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/USD");
    if (!res.ok) return null;
    const json = await res.json();
    if (json?.result !== "success" || !json?.rates) return null;
    const next = { ...DEFAULT_RATES };
    for (const code of CODES) {
      const v = Number(json.rates[code]);
      if (v && isFinite(v) && v > 0) next[code] = v;
    }
    next.USD = 1;
    return next;
  } catch {
    return null;
  }
}

async function fetchFromCoingecko(): Promise<Record<FiatCurrency, number> | null> {
  try {
    const vs = CODES.map((c) => c.toLowerCase()).join(",");
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=${vs}`
    );
    if (!res.ok) return null;
    const data = await res.json();
    const usdc = data["usd-coin"] ?? {};
    const next = { ...DEFAULT_RATES };
    for (const code of CODES) {
      const v = Number(usdc[code.toLowerCase()]);
      if (v && isFinite(v) && v > 0) next[code] = v;
    }
    next.USD = 1;
    return next;
  } catch {
    return null;
  }
}

export function useFiatRates(refreshInterval = 30 * 60 * 1000): FiatRates {
  const [rates, setRates] = useState<Record<FiatCurrency, number>>(DEFAULT_RATES);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    const fetchRates = async () => {
      // Primary: real FX feed (mid-market rates, ~161 currencies).
      let next = await fetchFromOpenErApi();
      // Fallback: CoinGecko USDC pricing (covers only some fiats).
      if (!next) next = await fetchFromCoingecko();
      if (!mounted) return;
      if (next) {
        setRates(next);
        setLastUpdated(new Date());
        setError(null);
      } else {
        setError("Using fallback rates");
      }
      setLoading(false);
    };

    fetchRates();
    const interval = setInterval(fetchRates, refreshInterval);
    return () => { mounted = false; clearInterval(interval); };
  }, [refreshInterval]);

  const convert = (usd: number, currency: FiatCurrency) => usd * (rates[currency] ?? 1);
  return { rates, loading, lastUpdated, error, convert };
}
