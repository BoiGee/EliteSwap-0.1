import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useLanguage } from "@/i18n/TranslationProvider";
import type { FiatCurrency } from "@/hooks/useFiatRates";
import { supabase } from "@/integrations/supabase/client";

const MANUAL_KEY = "elite_swap_currency";
const MANUAL_LANG_KEY = "elite_swap_currency_lang";

// Language -> {currency, locale}
const LANG_MAP: Record<string, { currency: FiatCurrency; locale: string }> = {
  en: { currency: "USD", locale: "en-US" },
  es: { currency: "EUR", locale: "es-ES" },
  fr: { currency: "EUR", locale: "fr-FR" },
  pt: { currency: "BRL", locale: "pt-BR" },
  de: { currency: "EUR", locale: "de-DE" },
  ru: { currency: "RUB", locale: "ru-RU" },
  ar: { currency: "AED", locale: "ar-AE" },
  zh: { currency: "CNY", locale: "zh-CN" },
  ja: { currency: "JPY", locale: "ja-JP" },
  ko: { currency: "KRW", locale: "ko-KR" },
  hi: { currency: "INR", locale: "hi-IN" },
  it: { currency: "EUR", locale: "it-IT" },
  tr: { currency: "TRY", locale: "tr-TR" },
  nl: { currency: "EUR", locale: "nl-NL" },
  pl: { currency: "PLN", locale: "pl-PL" },
  sv: { currency: "SEK", locale: "sv-SE" },
  id: { currency: "IDR", locale: "id-ID" },
  vi: { currency: "VND", locale: "vi-VN" },
  th: { currency: "THB", locale: "th-TH" },
  uk: { currency: "UAH", locale: "uk-UA" },
  fa: { currency: "USD", locale: "fa-IR" },
  he: { currency: "ILS", locale: "he-IL" },
  ur: { currency: "PKR", locale: "ur-PK" },
  bn: { currency: "BDT", locale: "bn-BD" },
  ta: { currency: "INR", locale: "ta-IN" },
  ms: { currency: "MYR", locale: "ms-MY" },
  ro: { currency: "RON", locale: "ro-RO" },
  el: { currency: "EUR", locale: "el-GR" },
  cs: { currency: "CZK", locale: "cs-CZ" },
  da: { currency: "DKK", locale: "da-DK" },
  fi: { currency: "EUR", locale: "fi-FI" },
  no: { currency: "NOK", locale: "nb-NO" },
  hu: { currency: "HUF", locale: "hu-HU" },
};

const REGION_MAP: Record<string, FiatCurrency> = {
  NG: "NGN", GH: "GHS", GB: "GBP", US: "USD", CA: "USD",
  IN: "INR", ID: "IDR", BR: "BRL", MX: "MXN", KR: "KRW",
  JP: "JPY", CN: "CNY", RU: "RUB", TR: "TRY", AE: "AED",
  SA: "SAR", IL: "ILS", PK: "PKR", BD: "BDT", TH: "THB",
  VN: "VND", PH: "PHP", MY: "MYR", PL: "PLN", SE: "SEK",
  DK: "DKK", NO: "NOK", CZ: "CZK", HU: "HUF", RO: "RON",
  UA: "UAH", ZA: "ZAR", KE: "KES",
};

function autoFromLang(lang: string): { currency: FiatCurrency; locale: string } {
  const hit = LANG_MAP[lang];
  if (!hit) return { currency: "USD", locale: "en-US" };
  if (typeof navigator !== "undefined") {
    const region = (navigator.language || "").split("-")[1]?.toUpperCase();
    if (region && REGION_MAP[region]) {
      return { currency: REGION_MAP[region], locale: `${lang}-${region}` };
    }
  }
  return hit;
}

// -------- Shared reactive store for manual currency --------
type Snapshot = { currency: FiatCurrency | null; lang: string | null };

function readSnapshot(): Snapshot {
  if (typeof window === "undefined") return { currency: null, lang: null };
  return {
    currency: (localStorage.getItem(MANUAL_KEY) as FiatCurrency | null) ?? null,
    lang: localStorage.getItem(MANUAL_LANG_KEY),
  };
}

let currentSnapshot: Snapshot = readSnapshot();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function writeStore(next: Snapshot) {
  currentSnapshot = next;
  if (typeof window !== "undefined") {
    if (next.currency === null) {
      localStorage.removeItem(MANUAL_KEY);
      localStorage.removeItem(MANUAL_LANG_KEY);
    } else {
      localStorage.setItem(MANUAL_KEY, next.currency);
      if (next.lang) localStorage.setItem(MANUAL_LANG_KEY, next.lang);
    }
  }
  emit();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

// Cross-tab sync
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === MANUAL_KEY || e.key === MANUAL_LANG_KEY) {
      currentSnapshot = readSnapshot();
      emit();
    }
  });
}

export interface DisplayLocale {
  currency: FiatCurrency;
  locale: string;
  setCurrency: (c: FiatCurrency | null) => void;
  isAuto: boolean;
}

export function useDisplayLocale(): DisplayLocale {
  const { lang } = useLanguage();
  const snap = useSyncExternalStore(
    subscribe,
    () => currentSnapshot,
    () => currentSnapshot,
  );

  // If the stored manual currency was tied to a different language, ignore it
  const manual: FiatCurrency | null = snap.currency && snap.lang === lang ? snap.currency : null;

  // Reset manual override when language changes
  useEffect(() => {
    if (currentSnapshot.currency && currentSnapshot.lang !== lang) {
      writeStore({ currency: null, lang: null });
    }
  }, [lang]);

  const auto = useMemo(() => autoFromLang(lang), [lang]);
  const currency = manual ?? auto.currency;
  const locale = auto.locale;

  const setCurrency = useCallback((c: FiatCurrency | null) => {
    writeStore(c === null ? { currency: null, lang: null } : { currency: c, lang });
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) {
        void supabase.from("profiles").update({ preferred_currency: c }).eq("id", data.user.id);
      }
    });
  }, [lang]);

  return { currency, locale, setCurrency, isAuto: manual === null };
}
