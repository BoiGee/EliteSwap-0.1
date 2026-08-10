import { Check } from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import type { FiatCurrency } from "@/hooks/useFiatRates";
import { useDisplayLocale } from "@/i18n/useDisplayLocale";

const CURRENCIES: { code: FiatCurrency; label: string; flag: string }[] = [
  { code: "USD", label: "USD", flag: "🇺🇸" },
  { code: "EUR", label: "EUR", flag: "🇪🇺" },
  { code: "GBP", label: "GBP", flag: "🇬🇧" },
  { code: "GHS", label: "GHS", flag: "🇬🇭" },
  { code: "NGN", label: "NGN", flag: "🇳🇬" },
  { code: "JPY", label: "JPY", flag: "🇯🇵" },
  { code: "CNY", label: "CNY", flag: "🇨🇳" },
  { code: "INR", label: "INR", flag: "🇮🇳" },
  { code: "BRL", label: "BRL", flag: "🇧🇷" },
  { code: "MXN", label: "MXN", flag: "🇲🇽" },
  { code: "KRW", label: "KRW", flag: "🇰🇷" },
  { code: "RUB", label: "RUB", flag: "🇷🇺" },
  { code: "TRY", label: "TRY", flag: "🇹🇷" },
  { code: "AED", label: "AED", flag: "🇦🇪" },
  { code: "SAR", label: "SAR", flag: "🇸🇦" },
  { code: "ILS", label: "ILS", flag: "🇮🇱" },
  { code: "PKR", label: "PKR", flag: "🇵🇰" },
  { code: "BDT", label: "BDT", flag: "🇧🇩" },
  { code: "IDR", label: "IDR", flag: "🇮🇩" },
  { code: "THB", label: "THB", flag: "🇹🇭" },
  { code: "VND", label: "VND", flag: "🇻🇳" },
  { code: "PHP", label: "PHP", flag: "🇵🇭" },
  { code: "MYR", label: "MYR", flag: "🇲🇾" },
  { code: "PLN", label: "PLN", flag: "🇵🇱" },
  { code: "SEK", label: "SEK", flag: "🇸🇪" },
  { code: "ZAR", label: "ZAR", flag: "🇿🇦" },
  { code: "KES", label: "KES", flag: "🇰🇪" },
  { code: "UAH", label: "UAH", flag: "🇺🇦" },
];

export const FIAT_SYMBOLS: Partial<Record<FiatCurrency, string>> = {
  USD: "$", EUR: "€", GBP: "£", GHS: "₵", NGN: "₦",
  JPY: "¥", CNY: "¥", INR: "₹", KRW: "₩", RUB: "₽",
};

export function formatFiat(amount: number, currency: FiatCurrency, locale?: string): string {
  try {
    return new Intl.NumberFormat(locale || "en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: ["JPY", "KRW", "VND", "IDR", "NGN", "HUF", "CLP"].includes(currency) ? 0 : 2,
    }).format(amount);
  } catch {
    const symbol = FIAT_SYMBOLS[currency] || `${currency} `;
    const decimals = ["JPY", "KRW", "VND", "IDR", "NGN"].includes(currency) ? 0 : 2;
    return `${symbol}${amount.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
  }
}

// Payment gateway can only handle these — used for actual charges, not display
const PAYMENT_SUPPORTED: FiatCurrency[] = ["USD", "NGN", "GHS", "GBP"];
export function toPaymentCurrency(display: FiatCurrency): FiatCurrency {
  return PAYMENT_SUPPORTED.includes(display) ? display : "USD";
}

// --- Back-compat shims (legacy call sites still import these) ---
export function getStoredCurrency(): FiatCurrency {
  if (typeof window === "undefined") return "USD";
  const stored = localStorage.getItem("elite_swap_currency") as FiatCurrency | null;
  if (stored && CURRENCIES.some((c) => c.code === stored)) return stored;
  return "USD";
}
export function setStoredCurrency(currency: FiatCurrency) {
  if (typeof window !== "undefined") localStorage.setItem("elite_swap_currency", currency);
}

interface Props {
  value?: FiatCurrency;
  onChange?: (c: FiatCurrency) => void;
  className?: string;
}

/**
 * CurrencySelector reads / writes the shared display locale (auto-matches language).
 * The optional `value`/`onChange` props remain for back-compat with legacy call sites,
 * but the source of truth is `useDisplayLocale`.
 */
export function CurrencySelector({ className = "" }: Props) {
  const { currency, setCurrency, isAuto } = useDisplayLocale();
  const current = CURRENCIES.find((c) => c.code === currency) || CURRENCIES[0];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          data-no-translate
          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-heading font-semibold bg-muted/30 hover:bg-muted/50 text-foreground transition-all ${className}`}
          title="Change currency"
        >
          <span>{current.flag}</span>
          <span>{current.label}</span>
          {isAuto && <span className="text-[9px] opacity-60">AUTO</span>}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-[60vh] overflow-y-auto w-52" data-no-translate>
        <DropdownMenuItem onClick={() => setCurrency(null)} className="cursor-pointer">
          <span className="flex-1">Auto (match language)</span>
          {isAuto && <Check className="h-3.5 w-3.5 text-primary" />}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {CURRENCIES.map((c) => (
          <DropdownMenuItem key={c.code} onClick={() => setCurrency(c.code)} className="cursor-pointer flex items-center gap-2">
            <span>{c.flag}</span>
            <span className="flex-1">{c.code}</span>
            {!isAuto && c.code === currency && <Check className="h-3.5 w-3.5 text-primary" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
