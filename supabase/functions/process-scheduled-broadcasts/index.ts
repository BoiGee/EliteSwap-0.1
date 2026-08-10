// Cron-driven dispatcher that fires any broadcast whose scheduled_for has arrived.
// Invoked every minute by pg_cron.
import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !supabaseServiceKey) {
    return new Response(JSON.stringify({ error: 'Server configuration error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  // In-function auth: require service_role key (pg_cron sends this).
  const authHeader = req.headers.get('Authorization') ?? ''
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (bearer !== supabaseServiceKey) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const admin = createClient(supabaseUrl, supabaseServiceKey)

  // Pick up any scheduled broadcast whose time has arrived.
  const { data: due, error } = await admin
    .from('broadcasts')
    .select('id, subject, body_md, cta_label, cta_url, recipient_mode, recipient_user_ids, filter_preset')
    .eq('status', 'scheduled')
    .lte('scheduled_for', new Date().toISOString())
    .limit(5)

  if (error) {
    console.error('process-scheduled-broadcasts: query failed', error)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const results: any[] = []
  for (const b of due ?? []) {
    // Mark as sending immediately to claim it and prevent double-fire next tick.
    const { error: claimErr } = await admin
      .from('broadcasts')
      .update({ status: 'sending', started_at: new Date().toISOString() })
      .eq('id', b.id)
      .eq('status', 'scheduled')
    if (claimErr) {
      console.error('Failed to claim broadcast', b.id, claimErr)
      continue
    }

    try {
      const resp = await fetch(`${supabaseUrl}/functions/v1/admin-broadcast-email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${supabaseServiceKey}`,
          'apikey': supabaseServiceKey,
        },
        body: JSON.stringify({
          action: 'fire_scheduled',
          broadcastId: b.id,
          subject: b.subject,
          body: b.body_md,
          ctaLabel: b.cta_label ?? '',
          ctaUrl: b.cta_url ?? '',
          recipientMode: b.recipient_mode,
          recipientUserIds: b.recipient_user_ids ?? [],
          filterPreset: b.filter_preset ?? '',
          confirmAll: true,
          overrideCooldown: true,
        }),
      })
      const json = await resp.json().catch(() => ({}))
      if (!resp.ok) {
        // admin-broadcast-email returned an error — record it on the broadcast
        // so the row doesn't stay stuck in 'sending' forever.
        const errMsg = String(json?.error ?? json?.message ?? `HTTP ${resp.status}`)
        console.error('admin-broadcast-email returned non-OK', { id: b.id, status: resp.status, error: errMsg })
        await admin
          .from('broadcasts')
          .update({ status: 'failed', error_message: errMsg, completed_at: new Date().toISOString() })
          .eq('id', b.id)
      }
      results.push({ id: b.id, ok: resp.ok, ...json })
    } catch (e: any) {
      console.error('Failed to fire broadcast', b.id, e)
      await admin
        .from('broadcasts')
        .update({ status: 'failed', error_message: String(e), completed_at: new Date().toISOString() })
        .eq('id', b.id)
      results.push({ id: b.id, ok: false, error: String(e) })
    }
  }

  return new Response(JSON.stringify({ processed: results.length, results }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
})
