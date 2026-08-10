import { useState, useEffect } from "react";

interface CryptoPrices {
  bitcoin: number | null;
  binancecoin: number | null;
  lastUpdated: Date | null;
  loading: boolean;
  error: string | null;
}

export function useCryptoPrices(refreshInterval = 60000): CryptoPrices {
  const [prices, setPrices] = useState<CryptoPrices>({
    bitcoin: null,
    binancecoin: null,
    lastUpdated: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    let mounted = true;

    const fetchPrices = async () => {
      try {
        const res = await fetch(
          "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,binancecoin&vs_currencies=usd"
        );
        if (!res.ok) throw new Error("Failed to fetch prices");
        const data = await res.json();
        if (mounted) {
          setPrices({
            bitcoin: data.bitcoin?.usd ?? null,
            binancecoin: data.binancecoin?.usd ?? null,
            lastUpdated: new Date(),
            loading: false,
            error: null,
          });
        }
      } catch (err: any) {
        if (mounted) {
          setPrices((prev) => ({ ...prev, loading: false, error: err.message }));
        }
      }
    };

    fetchPrices();
    const interval = setInterval(fetchPrices, refreshInterval);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [refreshInterval]);

  return prices;
}
