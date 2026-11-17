import { supabase } from "@/integrations/supabase/client";

// The generated client types (integrations/supabase/types.ts) lag behind the newer tables and
// functions (resellers, trial Mobile Money "I've sent it", ...). Those calls go through this one
// untyped handle; results are cast at each call site.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const untyped = supabase as any;
export type RpcError = { message: string } | null;
export const rpc = <T = unknown>(fn: string, args?: Record<string, unknown>): Promise<{ data: T | null; error: RpcError }> =>
  untyped.rpc(fn, args);
export const fromTable = (table: string) => untyped.from(table);

/** Postgres exceptions from our functions are written for users: show them, unless they're huge. */
export function rpcErrorMessage(error: { message?: string } | null | undefined, fallback = "Something went wrong") {
  const m = error?.message?.trim();
  return m && m.length < 300 ? m : fallback;
}
