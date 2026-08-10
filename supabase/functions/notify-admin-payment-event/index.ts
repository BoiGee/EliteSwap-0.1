// Allows authenticated users (and admins/service role) to trigger an admin
// payment alert without granting them the ability to send arbitrary emails.
// We validate the caller and the payment server-side, then call
// send-transactional-email with the service role key.
import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const ALLOWED_EVENTS = new Set([
  'pending_review', 'admin_confirmed', 'admin_rejected', 'auto_confirmed', 'auto_confirmed_key_pending',
  'tx_not_found_review', 'sec_admin_added',
  'binance_offchain_review', 'verifier_mismatch_review',
])

// Events that should ALSO trigger a user-facing payment confirmation/rejection email.
// Idempotency keys match the ones used by the admin UI / verifier, so duplicate
// invocations from those paths get deduped by send-transactional-email.
const USER_EMAIL_FOR_EVENT: Record<string, { template: string; action: string } | undefined> = {
  admin_confirmed: { template: 'payment-approved', action: 'confirmed' },
  auto_confirmed: { template: 'payment-approved', action: 'confirmed' },
  auto_confirmed_key_pending: { template: 'payment-approved', action: 'confirmed' },
  admin_rejected: { template: 'payment-rejected', action: 'rejected' },
}




Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!

  // Auth: must be a logged-in user (or service role)
  const authHeader = req.headers.get('Authorization') ?? ''
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!bearer) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
  let callerUserId: string | null = null
  let isServiceRole = bearer === serviceKey
  // NOTE: We intentionally do NOT decode the JWT and trust an unverified `role` claim.
  // Service-role access requires the literal service-role key match above; any other
  // bearer is verified as a user JWT below via supabase.auth.getClaims().
  if (!isServiceRole) {
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${bearer}` } },
    })
    const { data: claims, error } = await userClient.auth.getClaims(bearer)
    if (error || !claims?.claims?.sub) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    callerUserId = claims.claims.sub as string
  }

  let body: any
  try { body = await req.json() } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const paymentId: string = body?.paymentId
  const eventType: string = body?.eventType
  const actorEmail: string | null = typeof body?.actorEmail === 'string' ? body.actorEmail : null
  const actorRole: string | null = typeof body?.actorRole === 'string' ? body.actorRole : null
  if (!paymentId || !eventType || !ALLOWED_EVENTS.has(eventType)) {
    return new Response(JSON.stringify({ error: 'Invalid request' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const admin = createClient(supabaseUrl, serviceKey)

  // Look up the payment + owner profile from the trusted server side.
  const { data: payment, error: payErr } = await admin
    .from('payments')
    .select('id, user_id, amount_usd, currency, payment_method, tx_hash, plan_id, discount_code')
    .eq('id', paymentId)
    .maybeSingle()
  if (payErr || !payment) {
    return new Response(JSON.stringify({ error: 'Payment not found' }), {
      status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  // Authorization: caller must be the payment owner OR an admin/sec_admin OR service role.
  if (!isServiceRole) {
    const isOwner = callerUserId === payment.user_id
    let isPrivileged = false
    if (!isOwner) {
      const { data: roleRows } = await admin
        .from('user_roles')
        .select('role')
        .eq('user_id', callerUserId!)
        .in('role', ['admin', 'sec_admin'])
      isPrivileged = !!(roleRows && roleRows.length > 0)
    }
    if (!isOwner && !isPrivileged) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    // Non-privileged owners can only fire the user-initiated event.
    if (!isPrivileged && eventType !== 'pending_review') {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
  }

  // Owner profile (trusted)
  const { data: ownerProfile } = await admin
    .from('profiles')
    .select('email, display_name')
    .eq('user_id', payment.user_id)
    .maybeSingle()

  // Plan name
  let planName: string | null = null
  if (payment.plan_id) {
    const { data: plan } = await admin
      .from('pricing_plans').select('name').eq('id', payment.plan_id).maybeSingle()
    planName = plan?.name ?? null
  }

  // Admin real-time alerts now go through Web Push + in-app sound instead of
  // email. We no longer resolve admin email recipients here.
  const occurredAt = new Date().toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  })

  const reference = (payment as any).tx_hash ?? null

  // Fire-and-forget push notification to all subscribed admin devices.
  try {
    const amountLabel = payment.amount_usd != null ? `$${payment.amount_usd}` : ''
    const who = ownerProfile?.email || ownerProfile?.display_name || 'a user'
    const titleMap: Record<string, string> = {
      pending_review: 'New payment submitted',
      admin_confirmed: 'Payment confirmed',
      admin_rejected: 'Payment rejected',
      auto_confirmed: 'Payment auto-confirmed',
      auto_confirmed_key_pending: 'Payment confirmed (key pending)',
      tx_not_found_review: 'Payment needs manual review',
      sec_admin_added: 'New security admin added',
      binance_offchain_review: 'Off-chain payment needs review',
      verifier_mismatch_review: 'Payment mismatch needs review',
    }
    await admin.functions.invoke('send-admin-push', {
      body: {
        event: eventType,
        title: titleMap[eventType] ?? 'Payment event',
        body: `${amountLabel} • ${who} • ${planName ?? ''}`.trim(),
        url: '/admin',
        tag: `payment-${payment.id}`,
      },
    })
  } catch (e) {
    console.warn('[notify-admin-payment-event] push failed', e)
  }


  // Fan-out: user-facing payment-approved/rejected email for confirmation/rejection events.
  // Uses idempotency keys matching the admin UI and verifier paths so duplicate invocations
  // (e.g. UI + DB trigger) are deduped at the send layer.
  const userEmailSpec = USER_EMAIL_FOR_EVENT[eventType]
  if (userEmailSpec && ownerProfile?.email) {
    const isApproved = userEmailSpec.template === 'payment-approved'
    const adminNote = isApproved
      ? (eventType === 'auto_confirmed_key_pending'
          ? 'Your transaction was verified — your unique key is being assigned and will appear in your dashboard shortly.'
          : 'Your transaction has been confirmed — your account is fully unlocked. Welcome aboard!')
      : undefined
    try {
      await admin.functions.invoke('send-transactional-email', {
        body: {
          templateName: userEmailSpec.template,
          recipientEmail: ownerProfile.email,
          idempotencyKey: `payment-${payment.id}-${userEmailSpec.action}`,
          templateData: {
            displayName: ownerProfile.display_name || ownerProfile.email.split('@')[0],
            amountUsd: payment.amount_usd ?? null,
            planName,
            paymentMethod: (payment as any).payment_method ?? null,
            reference,
            ...(adminNote ? { adminNote } : {}),
          },
        },
      })
    } catch (e) {
      console.warn('Failed to send user payment email', { paymentId, error: e })
    }
  }

  return new Response(JSON.stringify({ success: true }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
})
