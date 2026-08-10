import { Check, Globe, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SUPPORTED_LANGUAGES, useLanguage } from "@/i18n/TranslationProvider";

export default function LanguageSwitcher({ compact = false }: { compact?: boolean }) {
  const { lang, setLang, isTranslating } = useLanguage();
  const current = SUPPORTED_LANGUAGES.find((l) => l.code === lang) || SUPPORTED_LANGUAGES[0];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 font-heading"
          data-no-translate
          aria-label="Change language"
          title="Change language"
        >
          {isTranslating ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Globe className="h-4 w-4" />
          )}
          <span className="text-xs">{current.flag}</span>
          {!compact && <span className="text-xs">{current.code.toUpperCase()}</span>}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-h-[70vh] overflow-y-auto w-56"
        data-no-translate
      >
        {SUPPORTED_LANGUAGES.map((l) => (
          <DropdownMenuItem
            key={l.code}
            onClick={() => setLang(l.code)}
            className="flex items-center gap-2 cursor-pointer"
          >
            <span>{l.flag}</span>
            <span className="flex-1">{l.native}</span>
            <span className="text-xs text-muted-foreground">{l.code.toUpperCase()}</span>
            {l.code === lang && <Check className="h-3.5 w-3.5 text-primary" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
