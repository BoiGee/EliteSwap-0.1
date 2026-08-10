// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const LANG_NAMES: Record<string, string> = {
  en: "English", es: "Spanish", fr: "French", pt: "Portuguese", de: "German",
  ru: "Russian", ar: "Arabic", zh: "Chinese (Simplified)", ja: "Japanese",
  ko: "Korean", hi: "Hindi", it: "Italian", tr: "Turkish", nl: "Dutch",
  pl: "Polish", sv: "Swedish", id: "Indonesian", vi: "Vietnamese",
  th: "Thai", uk: "Ukrainian", fa: "Persian", he: "Hebrew", ur: "Urdu",
  bn: "Bengali", ta: "Tamil", ms: "Malay", ro: "Romanian", el: "Greek",
  cs: "Czech", da: "Danish", fi: "Finnish", no: "Norwegian", hu: "Hungarian",
};

async function sha256(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const { texts, targetLang, sourceLang = "en" } = await req.json();
    if (!Array.isArray(texts) || !targetLang) {
      return new Response(JSON.stringify({ error: "texts[] and targetLang required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (targetLang === sourceLang) {
      return new Response(JSON.stringify({ translations: texts }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Hash each text; look up cache
    const hashes = await Promise.all(texts.map((t: string) => sha256(`${sourceLang}::${t}`)));
    const { data: cached } = await supabase
      .from("translation_cache")
      .select("source_hash, translated_text")
      .eq("target_lang", targetLang)
      .in("source_hash", hashes);
    const cacheMap = new Map<string, string>((cached || []).map((r: any) => [r.source_hash, r.translated_text]));

    const results: string[] = new Array(texts.length);
    const missingIdx: number[] = [];
    const missingTexts: string[] = [];
    texts.forEach((t: string, i: number) => {
      const hit = cacheMap.get(hashes[i]);
      if (hit !== undefined) results[i] = hit;
      else { missingIdx.push(i); missingTexts.push(t); }
    });

    if (missingTexts.length > 0) {
      const apiKey = Deno.env.get("LOVABLE_API_KEY");
      if (!apiKey) throw new Error("LOVABLE_API_KEY not set");

      const targetName = LANG_NAMES[targetLang] || targetLang;
      const sourceName = LANG_NAMES[sourceLang] || sourceLang;
      const numbered = missingTexts.map((t, i) => `${i + 1}. ${t.replace(/\n/g, " ")}`).join("\n");

      const sys = `You are a professional UI/UX translator for a live streaming app called Elite Swap.
Translate the numbered ${sourceName} strings below into ${targetName}.
Rules:
- Preserve emojis, punctuation, numbers, %, $, brand names (Elite Swap, OBS, Paystack, USDT), URLs, and code blocks exactly.
- Do NOT translate proper nouns or email addresses.
- Keep it concise — UI labels should stay short.
- Return ONLY a JSON array of strings in the SAME order and length as input. No commentary.`;

      const resp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [
            { role: "system", content: sys },
            { role: "user", content: numbered },
          ],
          response_format: { type: "json_object" },
        }),
      });

      if (!resp.ok) {
        const err = await resp.text();
        console.error("AI gateway error", resp.status, err);
        return new Response(JSON.stringify({ error: "translation_failed", status: resp.status, details: err }), {
          status: resp.status, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const j = await resp.json();
      const raw = j.choices?.[0]?.message?.content || "";
      let arr: string[] = [];
      try {
        const parsed = JSON.parse(raw);
        arr = Array.isArray(parsed) ? parsed : (parsed.translations || parsed.result || Object.values(parsed));
      } catch {
        // Best-effort line parse
        arr = raw.split("\n").map((l: string) => l.replace(/^\d+\.\s*/, "").trim()).filter(Boolean);
      }

      // Write results & cache
      const rowsToInsert: any[] = [];
      missingIdx.forEach((idx, k) => {
        const translated = (arr[k] ?? missingTexts[k]).toString();
        results[idx] = translated;
        rowsToInsert.push({
          source_hash: hashes[idx],
          target_lang: targetLang,
          source_lang: sourceLang,
          source_text: missingTexts[k],
          translated_text: translated,
        });
      });
      if (rowsToInsert.length) {
        await supabase.from("translation_cache").upsert(rowsToInsert, { onConflict: "source_hash,target_lang", ignoreDuplicates: true });
      }
    }

    return new Response(JSON.stringify({ translations: results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    console.error("translate-batch error", e);
    return new Response(JSON.stringify({ error: e.message || String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
