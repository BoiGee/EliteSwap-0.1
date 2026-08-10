import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export const SUPPORTED_LANGUAGES = [
  { code: "en", name: "English", native: "English", flag: "🇺🇸", rtl: false },
  { code: "es", name: "Spanish", native: "Español", flag: "🇪🇸", rtl: false },
  { code: "fr", name: "French", native: "Français", flag: "🇫🇷", rtl: false },
  { code: "pt", name: "Portuguese", native: "Português", flag: "🇵🇹", rtl: false },
  { code: "de", name: "German", native: "Deutsch", flag: "🇩🇪", rtl: false },
  { code: "ru", name: "Russian", native: "Русский", flag: "🇷🇺", rtl: false },
  { code: "ar", name: "Arabic", native: "العربية", flag: "🇸🇦", rtl: true },
  { code: "zh", name: "Chinese", native: "中文", flag: "🇨🇳", rtl: false },
  { code: "ja", name: "Japanese", native: "日本語", flag: "🇯🇵", rtl: false },
  { code: "ko", name: "Korean", native: "한국어", flag: "🇰🇷", rtl: false },
  { code: "hi", name: "Hindi", native: "हिन्दी", flag: "🇮🇳", rtl: false },
  { code: "it", name: "Italian", native: "Italiano", flag: "🇮🇹", rtl: false },
  { code: "tr", name: "Turkish", native: "Türkçe", flag: "🇹🇷", rtl: false },
  { code: "nl", name: "Dutch", native: "Nederlands", flag: "🇳🇱", rtl: false },
  { code: "pl", name: "Polish", native: "Polski", flag: "🇵🇱", rtl: false },
  { code: "sv", name: "Swedish", native: "Svenska", flag: "🇸🇪", rtl: false },
  { code: "id", name: "Indonesian", native: "Bahasa Indonesia", flag: "🇮🇩", rtl: false },
  { code: "vi", name: "Vietnamese", native: "Tiếng Việt", flag: "🇻🇳", rtl: false },
  { code: "th", name: "Thai", native: "ไทย", flag: "🇹🇭", rtl: false },
  { code: "uk", name: "Ukrainian", native: "Українська", flag: "🇺🇦", rtl: false },
  { code: "fa", name: "Persian", native: "فارسی", flag: "🇮🇷", rtl: true },
  { code: "he", name: "Hebrew", native: "עברית", flag: "🇮🇱", rtl: true },
  { code: "ur", name: "Urdu", native: "اردو", flag: "🇵🇰", rtl: true },
];

const STORAGE_KEY = "elite_swap_lang";
const CACHE_PREFIX = "es_tr_v1_";

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "CODE", "PRE", "TEXTAREA", "INPUT", "SVG", "PATH", "IFRAME", "VIDEO", "AUDIO", "CANVAS"]);
const SKIP_ATTR = "data-no-translate";
const SKIP_RE = /^[\s\d\p{P}\p{S}]+$/u;

function detectBrowserLang(): string {
  if (typeof navigator === "undefined") return "en";
  const langs = [navigator.language, ...(navigator.languages || [])];
  for (const l of langs) {
    const code = (l || "").toLowerCase().split("-")[0];
    if (SUPPORTED_LANGUAGES.some((s) => s.code === code)) return code;
  }
  return "en";
}

function getInitialLang(): string {
  if (typeof window === "undefined") return "en";
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored && SUPPORTED_LANGUAGES.some((s) => s.code === stored)) return stored;
  const detected = detectBrowserLang();
  localStorage.setItem(STORAGE_KEY, detected);
  return detected;
}

interface Ctx {
  lang: string;
  setLang: (l: string) => void;
  isTranslating: boolean;
}
const TranslationContext = createContext<Ctx>({ lang: "en", setLang: () => {}, isTranslating: false });

export function useLanguage() {
  return useContext(TranslationContext);
}

function collectTextNodes(root: Node): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      if (parent.closest(`[${SKIP_ATTR}]`)) return NodeFilter.FILTER_REJECT;
      const raw = node.nodeValue || "";
      const text = raw.trim();
      if (!text || text.length < 2) return NodeFilter.FILTER_REJECT;
      if (SKIP_RE.test(text)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  } as any);
  let n: Node | null;
  while ((n = walker.nextNode())) out.push(n as Text);
  return out;
}

function collectAttrs(root: Element): Array<{ el: Element; attr: string }> {
  const out: Array<{ el: Element; attr: string }> = [];
  const scan = (el: Element) => {
    if (SKIP_TAGS.has(el.tagName)) return;
    if (el.hasAttribute(SKIP_ATTR)) return;
    for (const attr of ["placeholder", "title", "aria-label", "alt"]) {
      const v = el.getAttribute(attr);
      if (v && v.trim().length > 1 && !SKIP_RE.test(v.trim())) {
        out.push({ el, attr });
      }
    }
    for (const c of Array.from(el.children)) scan(c);
  };
  scan(root);
  return out;
}

function loadCache(lang: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + lang);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}
function saveCache(lang: string, cache: Record<string, string>) {
  try { localStorage.setItem(CACHE_PREFIX + lang, JSON.stringify(cache)); } catch { /* quota */ }
}

export function TranslationProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<string>(() => getInitialLang());
  const [isTranslating, setIsTranslating] = useState(false);
  const cacheRef = useRef<Record<string, string>>({});
  // Track the last value WE wrote to each node — if the current nodeValue
  // no longer matches, React updated it and we must refresh the original.
  const appliedTextRef = useRef<WeakMap<Text, string>>(new WeakMap());
  const originalsRef = useRef<WeakMap<Text, string>>(new WeakMap());
  const appliedAttrRef = useRef<WeakMap<Element, Record<string, string>>>(new WeakMap());
  const originalAttrsRef = useRef<WeakMap<Element, Record<string, string>>>(new WeakMap());
  const pendingRef = useRef<Set<string>>(new Set());
  const scheduleTimer = useRef<number | null>(null);
  const userChangedLangRef = useRef(false);

  const setLang = useCallback((l: string) => {
    userChangedLangRef.current = true;
    localStorage.setItem(STORAGE_KEY, l);
    setLangState(l);
  }, []);

  // On sign-in, prefer the server-side saved language.
  // Only persist to the profile when the user explicitly changes language,
  // never on cold-load — otherwise the browser default overwrites the saved pref.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: userRes } = await supabase.auth.getUser();
      if (!userRes.user || cancelled) return;

      if (userChangedLangRef.current) {
        await supabase
          .from("profiles")
          .update({ preferred_language: lang })
          .eq("id", userRes.user.id);
        return;
      }

      // Cold load: read saved preference and adopt it if different.
      const { data: prof } = await supabase
        .from("profiles")
        .select("preferred_language")
        .eq("id", userRes.user.id)
        .maybeSingle();
      const saved = (prof as any)?.preferred_language as string | null | undefined;
      if (cancelled) return;
      if (saved && SUPPORTED_LANGUAGES.some((s) => s.code === saved) && saved !== lang) {
        localStorage.setItem(STORAGE_KEY, saved);
        setLangState(saved);
      }
    })();
    return () => { cancelled = true; };
  }, [lang]);

  useEffect(() => {
    const info = SUPPORTED_LANGUAGES.find((l) => l.code === lang);
    document.documentElement.lang = lang;
    document.documentElement.dir = info?.rtl ? "rtl" : "ltr";
  }, [lang]);

  useEffect(() => {
    if (lang === "en") {
      const nodes = collectTextNodes(document.body);
      for (const n of nodes) {
        const orig = originalsRef.current.get(n);
        if (orig !== undefined && n.nodeValue !== orig) n.nodeValue = orig;
      }
      document.querySelectorAll("[data-es-tr-attrs]").forEach((el) => {
        const saved = originalAttrsRef.current.get(el);
        if (saved) for (const [a, v] of Object.entries(saved)) el.setAttribute(a, v);
      });
      return;
    }

    cacheRef.current = loadCache(lang);

    const translatePending = async () => {
      if (pendingRef.current.size === 0) return;
      const batch = Array.from(pendingRef.current).slice(0, 80);
      batch.forEach((t) => pendingRef.current.delete(t));
      setIsTranslating(true);
      try {
        const { data, error } = await supabase.functions.invoke("translate-batch", {
          body: { texts: batch, targetLang: lang, sourceLang: "en" },
        });
        if (error) throw error;
        const translations: string[] = data?.translations || [];
        batch.forEach((src, i) => {
          const dst = translations[i] || src;
          cacheRef.current[src] = dst;
        });
        saveCache(lang, cacheRef.current);
        applyTranslations();
      } catch (e) {
        console.warn("translate-batch failed", e);
      } finally {
        setIsTranslating(false);
        if (pendingRef.current.size > 0) scheduleFlush();
      }
    };

    const scheduleFlush = () => {
      if (scheduleTimer.current) window.clearTimeout(scheduleTimer.current);
      scheduleTimer.current = window.setTimeout(translatePending, 200);
    };

    const applyTranslations = () => {
      const nodes = collectTextNodes(document.body);
      for (const n of nodes) {
        const currentRaw = n.nodeValue || "";
        // If React changed the node since we last wrote it, treat the current
        // value as the new English original. This unfreezes countdowns,
        // prices, status text, etc.
        const lastApplied = appliedTextRef.current.get(n);
        if (lastApplied === undefined || lastApplied !== currentRaw) {
          originalsRef.current.set(n, currentRaw);
        }
        const original = originalsRef.current.get(n) ?? currentRaw;
        const key = original.trim();
        if (!key) continue;
        const translated = cacheRef.current[key];
        if (translated) {
          const leading = original.match(/^\s*/)?.[0] || "";
          const trailing = original.match(/\s*$/)?.[0] || "";
          const newVal = leading + translated + trailing;
          if (n.nodeValue !== newVal) n.nodeValue = newVal;
          appliedTextRef.current.set(n, newVal);
        } else if (!pendingRef.current.has(key)) {
          pendingRef.current.add(key);
        }
      }

      const attrs = collectAttrs(document.body);
      for (const { el, attr } of attrs) {
        const currentVal = el.getAttribute(attr) || "";
        let savedApplied = appliedAttrRef.current.get(el);
        if (!savedApplied) { savedApplied = {}; appliedAttrRef.current.set(el, savedApplied); }
        let savedOrig = originalAttrsRef.current.get(el);
        if (!savedOrig) { savedOrig = {}; originalAttrsRef.current.set(el, savedOrig); }

        // If React changed the attr since our last write, refresh the original.
        if (savedApplied[attr] === undefined || savedApplied[attr] !== currentVal) {
          savedOrig[attr] = currentVal;
        }
        el.setAttribute("data-es-tr-attrs", "1");
        const key = (savedOrig[attr] || "").trim();
        if (!key) continue;
        const t = cacheRef.current[key];
        if (t) {
          if (el.getAttribute(attr) !== t) el.setAttribute(attr, t);
          savedApplied[attr] = t;
        } else if (!pendingRef.current.has(key)) {
          pendingRef.current.add(key);
        }
      }
      if (pendingRef.current.size > 0) scheduleFlush();
    };

    applyTranslations();

    const observer = new MutationObserver((muts) => {
      let dirty = false;
      for (const m of muts) {
        if (m.type === "characterData" || m.addedNodes.length || m.type === "attributes") {
          dirty = true; break;
        }
      }
      if (dirty) {
        if (scheduleTimer.current) window.clearTimeout(scheduleTimer.current);
        scheduleTimer.current = window.setTimeout(applyTranslations, 150);
      }
    });
    observer.observe(document.body, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ["placeholder", "title", "aria-label", "alt"],
    });

    return () => {
      observer.disconnect();
      if (scheduleTimer.current) window.clearTimeout(scheduleTimer.current);
    };
  }, [lang]);

  const value = useMemo(() => ({ lang, setLang, isTranslating }), [lang, setLang, isTranslating]);
  return <TranslationContext.Provider value={value}>{children}</TranslationContext.Provider>;
}
