// PostgREST caps every response at 1,000 rows (this project's max_rows) whatever .limit() asks for.
export async function fetchAllRows<T>(build: () => any, pageSize = 1000): Promise<{ data: T[]; error: any }> {
  const out: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build().range(from, from + pageSize - 1);
    if (error) return { data: out, error };
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < pageSize) return { data: out, error: null };
  }
}

export const DATE_PRESETS: { label: string; days: number | "all" | "ytd" | "mtd" | "last" }[] = [
  { label: "All time", days: "all" },
  { label: "YTD", days: "ytd" },
  { label: "This month", days: "mtd" },
  { label: "Last 30d", days: 30 },
  { label: "Last 90d", days: 90 },
  { label: "Last month", days: "last" },
];

// Local-calendar boundaries as ISO instants; `to` is exclusive.
export function computeDateRange(preset: string, customFrom: string, customTo: string): { from: string | null; to: string | null } {
  const now = new Date();
  if (preset === "all") return { from: null, to: null };
  if (preset === "ytd") return { from: new Date(now.getFullYear(), 0, 1).toISOString(), to: null };
  if (preset === "mtd") return { from: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(), to: null };
  if (preset === "last") {
    const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const to = new Date(now.getFullYear(), now.getMonth(), 1);
    return { from: from.toISOString(), to: to.toISOString() };
  }
  if (preset === "custom") {
    // Both ends on the local calendar ("YYYY-MM-DD" alone parses as UTC midnight); `to` covers the whole day.
    const end = customTo ? new Date(`${customTo}T00:00:00`) : null;
    if (end) end.setDate(end.getDate() + 1);
    return {
      from: customFrom ? new Date(`${customFrom}T00:00:00`).toISOString() : null,
      to: end ? end.toISOString() : null,
    };
  }
  const n = Number(preset);
  if (Number.isFinite(n)) {
    const from = new Date(now.getTime() - n * 86400_000);
    return { from: from.toISOString(), to: null };
  }
  return { from: null, to: null };
}

// supabase.functions.invoke() reports any non-2xx as a generic "Edge Function returned a non-2xx
// status code"; the function's own message is in the response body.
export async function readFunctionError(error: any): Promise<{ message: string; body: any }> {
  const body = await error?.context?.json?.().catch(() => null);
  return { message: body?.message || body?.error || error?.message || "Unknown error", body };
}
