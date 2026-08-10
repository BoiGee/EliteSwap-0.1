// Decart credit reconciler.
//
// Runs on a schedule (pg_cron). For each 15-minute window it computes:
//   tracked_billed_ms  = sum(studio_sessions.duration_ms ended in window)
//   wall_ms            = sum(min(ended_at,windowEnd) - max(started_at,windowStart))
//                        across sessions overlapping the window
//   inferred_untracked = max(0, wall_ms - tracked_billed_ms) plus a small
//                        constant per session for the Decart teardown tail we
//                        can't measure directly (2s per session that ended in
//                        the window — conservative upper bound).
//
// Written to public.decart_reconciliation. Admin-only read via RLS.
// No secrets required. Uses SERVICE_ROLE.

import { createClient } from "npm:@supabase/supabase-js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const TEARDOWN_TAIL_MS_PER_SESSION = 2000;

Deno.serve(async () => {
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false },
  });

  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - 15 * 60 * 1000);

  // Pull every session that overlapped the window.
  const { data: rows, error } = await admin
    .from("studio_sessions")
    .select("started_at, ended_at, duration_ms")
    .lt("started_at", periodEnd.toISOString())
    .or(`ended_at.gte.${periodStart.toISOString()},ended_at.is.null`);

  if (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  let tracked = 0;
  let wall = 0;
  let sessionsInWindow = 0;
  let endedInWindow = 0;
  for (const r of rows ?? []) {
    const startedAt = new Date(r.started_at as string).getTime();
    const endedAt = r.ended_at
      ? new Date(r.ended_at as string).getTime()
      : periodEnd.getTime();
    const winStart = Math.max(startedAt, periodStart.getTime());
    const winEnd = Math.min(endedAt, periodEnd.getTime());
    if (winEnd <= winStart) continue;
    sessionsInWindow += 1;
    wall += winEnd - winStart;
    // Only sessions that ENDED inside this window contribute a full
    // duration_ms once — otherwise we'd double-count on later runs.
    if (
      r.ended_at &&
      new Date(r.ended_at as string).getTime() <= periodEnd.getTime() &&
      new Date(r.ended_at as string).getTime() > periodStart.getTime()
    ) {
      tracked += Number(r.duration_ms ?? 0);
      endedInWindow += 1;
    }
  }

  // Teardown tail is now billed to the user via pause_studio_session /
  // reap_orphaned_studio_sessions, so it is already inside `tracked`. The
  // reconciler credits it here as a health signal: post-fix, inferred_untracked
  // should trend to zero.
  const tailBudget = endedInWindow * TEARDOWN_TAIL_MS_PER_SESSION;
  const trackedIncludingTail = tracked; // tail is folded into duration_ms upstream
  const inferredUntracked = Math.max(0, wall - trackedIncludingTail);

  const insertRes = await admin.from("decart_reconciliation").insert({
    period_start: periodStart.toISOString(),
    period_end: periodEnd.toISOString(),
    tracked_billed_ms: tracked,
    tracked_session_count: sessionsInWindow,
    wall_ms: wall,
    inferred_untracked_ms: inferredUntracked,
    notes:
      `sessions_ended=${endedInWindow} teardown_tail_billed_ms=${tailBudget}`,
  });

  if (insertRes.error) {
    return new Response(
      JSON.stringify({ ok: false, error: insertRes.error.message }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }

  return new Response(
    JSON.stringify({
      ok: true,
      period_start: periodStart,
      period_end: periodEnd,
      tracked_billed_ms: tracked,
      wall_ms: wall,
      inferred_untracked_ms: inferredUntracked,
      sessions_ended_in_window: endedInWindow,
    }),
    { headers: { "content-type": "application/json" } },
  );
});
