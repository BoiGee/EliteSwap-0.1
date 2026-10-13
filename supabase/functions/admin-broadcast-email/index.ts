import * as React from 'npm:react@18.3.1'
import { createClient } from 'npm:@supabase/supabase-js@2'
import { TEMPLATES } from '../_shared/transactional-email-templates/registry.ts'
import { FROM_ADDRESS, REPLY_TO, TRANSACTIONAL_QUEUE, generateToken, normalizeRecipientEmail } from '../_shared/email-sender.ts'
import { renderEmail } from '../_shared/render-email.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const MAX_RECIPIENTS = 5000
// Keeps `.in()` filters' URLs well under gateway limits (UUIDs and emails are ~36 chars each).
const IN_CHUNK = 200
const SUBJECT_MAX = 120
const BODY_MAX = 10000
const ALL_USERS_CONFIRM_THRESHOLD = 500
const COOLDOWN_SECONDS = 15 * 60

type InlineRun = { text: string; bold?: boolean; italic?: boolean; href?: string }
type Block =
  | { kind: 'paragraph'; runs: InlineRun[] }
  | { kind: 'list'; items: InlineRun[][] }
  | { kind: 'heading'; runs: InlineRun[] }

// --- Tiny safe markdown -> blocks parser ---
function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let paraBuf: string[] = []
  let listBuf: string[] = []

  const flushPara = () => {
    if (paraBuf.length) {
      const text = paraBuf.join(' ').trim()
      if (text) blocks.push({ kind: 'paragraph', runs: parseInline(text) })
      paraBuf = []
    }
  }
  const flushList = () => {
    if (listBuf.length) {
      blocks.push({ kind: 'list', items: listBuf.map(parseInline) })
      listBuf = []
    }
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    if (!line.trim()) {
      flushPara()
      flushList()
      continue
    }
    if (/^##\s+/.test(line)) {
      flushPara(); flushList()
      blocks.push({ kind: 'heading', runs: parseInline(line.replace(/^##\s+/, '')) })
      continue
    }
    const bullet = line.match(/^\s*[-*]\s+(.+)$/)
    if (bullet) {
      flushPara()
      listBuf.push(bullet[1])
      continue
    }
    flushList()
    paraBuf.push(line.trim())
  }
  flushPara()
  flushList()
  return blocks
}

function parseInline(text: string): InlineRun[] {
  const runs: InlineRun[] = []
  let rest = text
  const linkRe = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/
  while (rest.length) {
    const lm = rest.match(linkRe)
    if (lm && lm.index !== undefined) {
      const before = rest.slice(0, lm.index)
      if (before) runs.push(...splitEmphasis(before))
      runs.push({ text: lm[1], href: lm[2] })
      rest = rest.slice(lm.index + lm[0].length)
    } else {
      runs.push(...splitEmphasis(rest))
      rest = ''
    }
  }
  return runs.length ? runs : [{ text }]
}

function splitEmphasis(s: string): InlineRun[] {
  const out: InlineRun[] = []
  const parts: { t: string; b?: boolean; i?: boolean }[] = [{ t: s }]
  const expand = (re: RegExp, flag: 'b' | 'i') => {
    const next: typeof parts = []
    for (const p of parts) {
      if (p.b || p.i) { next.push(p); continue }
      let r = p.t
      let m: RegExpExecArray | null
      while ((m = re.exec(r))) {
        if (m.index > 0) next.push({ t: r.slice(0, m.index) })
        next.push({ t: m[1], [flag]: true } as any)
        r = r.slice(m.index + m[0].length)
        re.lastIndex = 0
      }
      if (r) next.push({ t: r })
    }
    parts.splice(0, parts.length, ...next)
  }
  expand(/\*\*([^*]+)\*\*/g, 'b')
  expand(/\*([^*]+)\*/g, 'i')
  for (const p of parts) {
    if (!p.t) continue
    out.push({ text: p.t, bold: p.b, italic: p.i })
  }
  return out
}

function getDisplayName(profile: { display_name: string | null; email: string | null }) {
  if (profile.display_name && profile.display_name.trim()) return profile.display_name.trim()
  if (profile.email) return profile.email.split('@')[0]
  return ''
}

function getFirstName(profile: { display_name: string | null; email: string | null }) {
  const dn = getDisplayName(profile)
  return dn.split(/\s+/)[0] || ''
}

// The email is rendered once with these placeholders and each copy is personalized by string
// replacement: rendering React per recipient exceeds the edge CPU limit on large lists, and
// calling send-transactional-email per recipient hits the 30-nested-calls-per-minute limit.
// Mixed case on purpose: the plain-text renderer uppercases headings, and the uppercased form
// must stay distinguishable so it can be filled with the uppercased value.
const PLACEHOLDERS = {
  display_name: '__esDisplayName__',
  first_name: '__esFirstName__',
  email: '__esEmail__',
} as const
// react-email pads the hidden inbox preview (the subject here) to 150 chars with this unit.
const PREVIEW_MAX_LENGTH = 150
const PREVIEW_PAD_UNIT = '\u00a0\u200c\u200b\u200d\u200e\u200f\ufeff'
const PREVIEW_PADDING_RE = /<div>(?:\u00a0\u200c\u200b\u200d\u200e\u200f\ufeff)+<\/div>/

type PersonalVars = { display_name: string; first_name: string; email: string }
type RenderedEmail = { html: string; text: string; subject: string }

function withPlaceholders(template: string): string {
  return template
    .replace(/\{\{\s*display_name\s*\}\}/gi, PLACEHOLDERS.display_name)
    .replace(/\{\{\s*first_name\s*\}\}/gi, PLACEHOLDERS.first_name)
    .replace(/\{\{\s*email\s*\}\}/gi, PLACEHOLDERS.email)
}

// Same escaping React applies to text and attribute values.
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')
}

function personalizeRendered(rendered: RenderedEmail, vars: PersonalVars): RenderedEmail {
  let { html, text, subject } = rendered
  for (const key of Object.keys(PLACEHOLDERS) as (keyof PersonalVars)[]) {
    const placeholder = PLACEHOLDERS[key]
    const value = vars[key]
    html = html.replaceAll(placeholder, escapeHtml(value))
    text = text.replaceAll(placeholder.toUpperCase(), value.toUpperCase()).replaceAll(placeholder, value)
    subject = subject.replaceAll(placeholder, value)
  }
  const padding = subject.length >= PREVIEW_MAX_LENGTH ? '' : `<div>${PREVIEW_PAD_UNIT.repeat(PREVIEW_MAX_LENGTH - subject.length)}</div>`
  html = html.replace(PREVIEW_PADDING_RE, padding)
  return { html, text, subject }
}

function personalVars(profile: { display_name: string | null; email: string | null }): PersonalVars {
  return {
    display_name: getDisplayName(profile) || 'there',
    first_name: getFirstName(profile) || 'there',
    email: profile.email ?? '',
  }
}

async function renderBroadcast(input: { subject: string; bodyMd: string; ctaLabel: string; ctaUrl: string }): Promise<RenderedEmail> {
  const template = TEMPLATES['admin-broadcast']
  const templateData = {
    displayName: PLACEHOLDERS.display_name,
    subject: withPlaceholders(input.subject),
    blocks: parseMarkdown(withPlaceholders(input.bodyMd)),
    ctaLabel: input.ctaLabel ? withPlaceholders(input.ctaLabel) : undefined,
    ctaUrl: input.ctaUrl ? withPlaceholders(input.ctaUrl) : undefined,
  }
  const { html, text } = await renderEmail(React.createElement(template.component, templateData))
  const subject = typeof template.subject === 'function' ? template.subject(templateData) : template.subject
  return { html, text, subject: subject as string }
}

// Bulk version of send-transactional-email's per-address token handling. A null entry means the
// address's token was already used (it unsubscribed), so it must not be emailed.
async function getUnsubscribeTokens(admin: any, emails: string[]): Promise<Map<string, string | null>> {
  const tokens = new Map<string, string | null>()
  const unique = Array.from(new Set(emails))
  const readChunk = async (chunk: string[]) => {
    const { data, error } = await admin.from('email_unsubscribe_tokens').select('email, token, used_at').in('email', chunk)
    if (error) throw new Error(`Unsubscribe token lookup failed: ${error.message}`)
    for (const row of (data ?? []) as { email: string; token: string; used_at: string | null }[]) {
      tokens.set(row.email, row.used_at ? null : row.token)
    }
  }
  for (let i = 0; i < unique.length; i += IN_CHUNK) await readChunk(unique.slice(i, i + IN_CHUNK))
  const missing = unique.filter((e) => !tokens.has(e))
  for (let i = 0; i < missing.length; i += 500) {
    const { error } = await admin.from('email_unsubscribe_tokens').upsert(
      missing.slice(i, i + 500).map((email) => ({ email, token: generateToken() })),
      { onConflict: 'email', ignoreDuplicates: true },
    )
    if (error) throw new Error(`Unsubscribe token creation failed: ${error.message}`)
  }
  // Re-read: a concurrent send may have created some of these first, making our upsert a no-op.
  for (let i = 0; i < missing.length; i += IN_CHUNK) await readChunk(missing.slice(i, i + IN_CHUNK))
  return tokens
}

interface Profile { user_id: string; email: string | null; display_name: string | null }

// Paginate past PostgREST's 1000-row default cap.
async function fetchAllRows<T = any>(
  builder: (from: number, to: number) => any,
  pageSize = 1000,
): Promise<T[]> {
  const out: T[] = []
  let from = 0
  // Hard ceiling so a runaway loop can't hang the function.
  for (let i = 0; i < 100; i++) {
    const { data, error } = await builder(from, from + pageSize - 1)
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as T[]
    out.push(...rows)
    if (rows.length < pageSize) break
    from += pageSize
  }
  return out
}

// payments.user_id is ON DELETE SET NULL, so deleted accounts leave NULL ids behind, and a
// single null in an in() list makes PostgREST reject the whole query.
async function profilesByIds(admin: any, ids: (string | null)[]): Promise<Profile[]> {
  const clean = Array.from(new Set(ids.filter((id): id is string => !!id)))
  const out: Profile[] = []
  for (let i = 0; i < clean.length; i += IN_CHUNK) {
    const { data, error } = await admin
      .from('profiles')
      .select('user_id, email, display_name')
      .in('user_id', clean.slice(i, i + IN_CHUNK))
    if (error) throw new Error(error.message)
    out.push(...((data ?? []) as Profile[]))
  }
  return out
}

async function resolveRecipients(
  admin: any,
  recipientMode: string,
  recipientUserIds: string[],
  filterPreset: string,
): Promise<Profile[]> {
  let recipientProfiles: Profile[] = []

  if (recipientMode === 'single' || recipientMode === 'multiple') {
    recipientProfiles = await profilesByIds(admin, recipientUserIds)
  } else if (recipientMode === 'all') {
    recipientProfiles = await fetchAllRows<Profile>((from, to) =>
      admin
        .from('profiles')
        .select('user_id, email, display_name')
        .not('email', 'is', null)
        .range(from, to),
    )
  } else if (recipientMode === 'filter') {
    if (filterPreset === 'paid') {
      const paidPayments = await fetchAllRows<{ user_id: string | null }>((from, to) =>
        admin.from('payments').select('user_id').eq('status', 'confirmed').range(from, to),
      )
      recipientProfiles = await profilesByIds(admin, paidPayments.map((p) => p.user_id))
    } else if (filterPreset === 'unpaid') {
      const paidPayments = await fetchAllRows<{ user_id: string }>((from, to) =>
        admin.from('payments').select('user_id').eq('status', 'confirmed').range(from, to),
      )
      const paidIds = new Set(paidPayments.map((p) => p.user_id))
      const all = await fetchAllRows<Profile>((from, to) =>
        admin
          .from('profiles')
          .select('user_id, email, display_name')
          .not('email', 'is', null)
          .range(from, to),
      )
      recipientProfiles = all.filter((p) => !paidIds.has(p.user_id))
    } else if (filterPreset === 'new_7d') {
      const since = new Date(Date.now() - 7 * 86400_000).toISOString()
      recipientProfiles = await fetchAllRows<Profile>((from, to) =>
        admin
          .from('profiles')
          .select('user_id, email, display_name')
          .gte('created_at', since)
          .range(from, to),
      )
    } else if (filterPreset === 'free_trial_used') {
      const assigns = await fetchAllRows<{ user_id: string | null }>((from, to) =>
        admin.from('free_trial_assignments').select('user_id').range(from, to),
      )
      recipientProfiles = await profilesByIds(admin, assigns.map((a) => a.user_id))
    }
  }

  // De-dupe + clean
  const seen = new Set<string>()
  return recipientProfiles.filter((p) => {
    if (!p.email) return false
    const e = p.email.toLowerCase().trim()
    if (seen.has(e)) return false
    seen.add(e)
    return true
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceKey) {
    return new Response(JSON.stringify({ error: 'Server configuration error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  // 1. Auth: must be admin
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
  const userClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  })
  const token = authHeader.replace('Bearer ', '')
  const { data: claimsData, error: claimsErr } = await userClient.auth.getClaims(token)
  if (claimsErr || !claimsData?.claims?.sub) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
  const callerId = claimsData.claims.sub as string

  const admin = createClient(supabaseUrl, supabaseServiceKey)
  const { data: roleRow } = await admin
    .from('user_roles')
    .select('id')
    .eq('user_id', callerId)
    .eq('role', 'admin')
    .maybeSingle()
  if (!roleRow) {
    return new Response(JSON.stringify({ error: 'Forbidden: admin only' }), {
      status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  // 2. Parse + validate input
  let body: any
  try { body = await req.json() } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const action = typeof body?.action === 'string' ? body.action : 'send' // 'preview' | 'send' | 'schedule' | 'cancel' | 'send_now' | 'fire_scheduled'

  // Cancel scheduled
  if (action === 'cancel') {
    const id = typeof body?.broadcastId === 'string' ? body.broadcastId : ''
    if (!id) {
      return new Response(JSON.stringify({ error: 'broadcastId required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    const { error } = await admin
      .from('broadcasts')
      .update({ status: 'canceled' })
      .eq('id', id)
      .eq('status', 'scheduled')
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ canceled: true }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const subject = typeof body?.subject === 'string' ? body.subject.trim() : ''
  const bodyMd = typeof body?.body === 'string' ? body.body : ''
  const ctaLabelRaw = typeof body?.ctaLabel === 'string' ? body.ctaLabel.trim() : ''
  const ctaUrlRaw = typeof body?.ctaUrl === 'string' ? body.ctaUrl.trim() : ''
  const recipientMode = body?.recipientMode as string
  const recipientUserIds: string[] = Array.isArray(body?.recipientUserIds)
    ? body.recipientUserIds.filter((x: any) => typeof x === 'string') : []
  const filterPreset = typeof body?.filterPreset === 'string' ? body.filterPreset : ''
  const scheduledForRaw = typeof body?.scheduledFor === 'string' ? body.scheduledFor : ''
  const confirmAll = body?.confirmAll === true
  const overrideCooldown = body?.overrideCooldown === true
  const existingBroadcastId = typeof body?.broadcastId === 'string' ? body.broadcastId : ''

  if (!subject || subject.length > SUBJECT_MAX) {
    return new Response(JSON.stringify({ error: `Subject must be 1-${SUBJECT_MAX} characters` }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
  if (!bodyMd.trim() || bodyMd.length > BODY_MAX) {
    return new Response(JSON.stringify({ error: `Body must be 1-${BODY_MAX} characters` }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
  if (ctaLabelRaw && !ctaUrlRaw) {
    return new Response(JSON.stringify({ error: 'CTA label requires a CTA URL' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
  if (ctaUrlRaw && !/^https:\/\//.test(ctaUrlRaw)) {
    return new Response(JSON.stringify({ error: 'CTA URL must start with https://' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
  if (!['single', 'multiple', 'filter', 'all'].includes(recipientMode)) {
    return new Response(JSON.stringify({ error: 'Invalid recipientMode' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  // 3. Resolve recipients
  let recipients: Profile[]
  try {
    recipients = await resolveRecipients(admin, recipientMode, recipientUserIds, filterPreset)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error('admin-broadcast recipient lookup failed', { recipientMode, filterPreset, error: message })
    return new Response(JSON.stringify({ error: `Recipient lookup failed: ${message}` }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  if (recipients.length === 0 && action !== 'fire_scheduled') {
    console.log('admin-broadcast resolved 0 recipients', { action, recipientMode, filterPreset })
    return new Response(JSON.stringify({ total: 0, suppressed: 0, sendable: 0, recipients: [] }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
  if (recipients.length > MAX_RECIPIENTS) {
    return new Response(JSON.stringify({
      error: `Recipient list exceeds ${MAX_RECIPIENTS}. Got ${recipients.length}. Narrow your selection.`,
    }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }

  // Suppression, fail-closed like send-transactional-email: if we can't verify, don't send.
  const emails = recipients.map((r) => r.email!.toLowerCase().trim())
  const suppressedSet = new Set<string>()
  for (let i = 0; i < emails.length; i += IN_CHUNK) {
    const chunk = emails.slice(i, i + IN_CHUNK)
    const { data: sup, error: supErr } = await admin
      .from('suppressed_emails')
      .select('email')
      .in('email', chunk)
    if (supErr) {
      console.error('suppressed_emails lookup failed', { error: supErr, chunkSize: chunk.length })
      return new Response(JSON.stringify({ error: `Could not check the unsubscribe list: ${supErr.message}` }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    for (const s of (sup ?? []) as { email: string }[]) suppressedSet.add(s.email)
  }
  const enriched = recipients.map((r) => ({
    user_id: r.user_id,
    email: r.email!,
    display_name: r.display_name,
    suppressed: suppressedSet.has(r.email!.toLowerCase().trim()),
  }))
  const sendable = enriched.filter((r) => !r.suppressed)

  console.log('admin-broadcast resolved', {
    action,
    recipientMode,
    filterPreset: recipientMode === 'filter' ? filterPreset : undefined,
    totalResolved: recipients.length,
    suppressed: suppressedSet.size,
    sendable: sendable.length,
  })

  // PREVIEW: return full recipient list for UI
  if (action === 'preview') {
    return new Response(JSON.stringify({
      total: recipients.length,
      suppressed: suppressedSet.size,
      sendable: sendable.length,
      recipients: enriched,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }

  // Safeguards (skip for fire_scheduled, already vetted at schedule time)
  if (action !== 'fire_scheduled') {
    // Require explicit confirm for "all" or for very large sends
    if ((recipientMode === 'all' || sendable.length >= ALL_USERS_CONFIRM_THRESHOLD) && !confirmAll) {
      return new Response(JSON.stringify({
        error: 'confirm_required',
        message: `This will email ${sendable.length} recipients. Re-submit with confirmAll=true to proceed.`,
        sendable: sendable.length,
      }), { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // Cooldown: only enforced for immediate sends
    if (action === 'send' && !overrideCooldown) {
      const { data: cd } = await admin.rpc('broadcast_cooldown_remaining_seconds')
      const remaining = typeof cd === 'number' ? cd : 0
      if (remaining > 0) {
        return new Response(JSON.stringify({
          error: 'cooldown_active',
          message: `Cooldown active. Please wait ${Math.ceil(remaining / 60)} more minute(s) before sending another broadcast, or override.`,
          remainingSeconds: remaining,
        }), { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
      }
    }
  }

  // SCHEDULE: store broadcast row + recipients, return
  if (action === 'schedule') {
    if (!scheduledForRaw) {
      return new Response(JSON.stringify({ error: 'scheduledFor required (ISO timestamp)' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    const scheduledForDate = new Date(scheduledForRaw)
    if (isNaN(scheduledForDate.getTime()) || scheduledForDate.getTime() < Date.now() + 30_000) {
      return new Response(JSON.stringify({ error: 'scheduledFor must be at least 30 seconds in the future' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    const { data: bRow, error: bErr } = await admin
      .from('broadcasts')
      .insert({
        created_by: callerId,
        subject, body_md: bodyMd, cta_label: ctaLabelRaw || null, cta_url: ctaUrlRaw || null,
        recipient_mode: recipientMode,
        recipient_user_ids: recipientMode === 'single' || recipientMode === 'multiple' ? recipientUserIds : null,
        filter_preset: recipientMode === 'filter' ? filterPreset : null,
        status: 'scheduled',
        scheduled_for: scheduledForDate.toISOString(),
        total_matched: recipients.length,
        suppressed_count: suppressedSet.size,
      })
      .select('id')
      .single()
    if (bErr || !bRow) {
      return new Response(JSON.stringify({ error: bErr?.message ?? 'Failed to schedule' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ scheduled: true, broadcastId: bRow.id, scheduledFor: scheduledForDate.toISOString() }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  // SEND (or fire_scheduled / send_now of existing broadcast)
  let broadcastId = existingBroadcastId
  if (!broadcastId) {
    const { data: bRow, error: bErr } = await admin
      .from('broadcasts')
      .insert({
        created_by: callerId,
        subject, body_md: bodyMd, cta_label: ctaLabelRaw || null, cta_url: ctaUrlRaw || null,
        recipient_mode: recipientMode,
        recipient_user_ids: recipientMode === 'single' || recipientMode === 'multiple' ? recipientUserIds : null,
        filter_preset: recipientMode === 'filter' ? filterPreset : null,
        status: 'sending',
        started_at: new Date().toISOString(),
        total_matched: recipients.length,
        suppressed_count: suppressedSet.size,
      })
      .select('id')
      .single()
    if (bErr || !bRow) {
      return new Response(JSON.stringify({ error: bErr?.message ?? 'Failed to create broadcast' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    broadcastId = bRow.id
  } else {
    await admin.from('broadcasts').update({ status: 'sending', started_at: new Date().toISOString() }).eq('id', broadcastId)
  }

  // Pre-insert recipient rows so progress is visible in History immediately.
  if (enriched.length) {
    // Chunk inserts to avoid request-size limits.
    for (let i = 0; i < enriched.length; i += 200) {
      const chunk = enriched.slice(i, i + 200).map((r) => ({
        broadcast_id: broadcastId,
        user_id: r.user_id,
        email: r.email,
        display_name: r.display_name,
        suppressed: r.suppressed,
        send_status: r.suppressed ? 'suppressed' : 'pending',
      }))
      const { error: insErr } = await admin.from('broadcast_recipients').insert(chunk)
      if (insErr) {
        console.error('Failed to insert broadcast_recipients chunk', { error: insErr, broadcastId, offset: i })
      }
    }
  }

  const CONCURRENCY = 8
  const LARGE_JOB_THRESHOLD = 200

  // Renders once, then queues every recipient's copy straight onto the dispatcher queue
  // (process-email-queue sends them, with Resend rate-limit backoff and retries).
  async function runSendLoop(): Promise<{ enqueued: number; failed: number; fatalError: string | null }> {
    let enqueued = 0
    let failed = 0
    let fatalError: string | null = null
    const markRecipients = async (recipientEmails: string[], update: Record<string, unknown>) => {
      for (let i = 0; i < recipientEmails.length; i += IN_CHUNK) {
        const { error } = await admin.from('broadcast_recipients').update(update)
          .eq('broadcast_id', broadcastId).in('email', recipientEmails.slice(i, i + IN_CHUNK))
        if (error) console.error('broadcast_recipients status update failed', { error, broadcastId })
      }
    }

    try {
      const rendered = await renderBroadcast({ subject, bodyMd, ctaLabel: ctaLabelRaw, ctaUrl: ctaUrlRaw })
      const jobs = sendable.map((r) => ({ r, to: normalizeRecipientEmail(r.email) }))
      const tokens = await getUnsubscribeTokens(admin, jobs.map((j) => j.to.toLowerCase()))

      const unsubscribed = jobs.filter((j) => tokens.get(j.to.toLowerCase()) === null)
      const tokenless = jobs.filter((j) => tokens.get(j.to.toLowerCase()) === undefined)
      const ready = jobs.filter((j) => tokens.get(j.to.toLowerCase()))
      failed += unsubscribed.length + tokenless.length
      await markRecipients(unsubscribed.map((j) => j.r.email), { send_status: 'failed', error_message: 'email_suppressed' })
      await markRecipients(tokenless.map((j) => j.r.email), { send_status: 'failed', error_message: 'Failed to prepare email' })

      const messages = ready.map(({ r, to }) => {
        const copy = personalizeRendered(rendered, personalVars(r))
        return {
          email: r.email,
          payload: {
            message_id: crypto.randomUUID(),
            to,
            from: FROM_ADDRESS,
            reply_to: REPLY_TO,
            subject: copy.subject,
            html: copy.html,
            text: copy.text,
            purpose: 'transactional',
            label: 'admin-broadcast',
            idempotency_key: `broadcast-${broadcastId}-${r.user_id}`,
            unsubscribe_token: tokens.get(to.toLowerCase()),
            queued_at: new Date().toISOString(),
          },
        }
      })

      // Log pending before enqueueing, as send-transactional-email does.
      for (let i = 0; i < messages.length; i += 500) {
        const { error } = await admin.from('email_send_log').insert(messages.slice(i, i + 500).map(({ payload }) => ({
          message_id: payload.message_id,
          template_name: 'admin-broadcast',
          recipient_email: payload.to,
          status: 'pending',
        })))
        if (error) console.error('email_send_log pending insert failed', { error, offset: i })
      }

      const queuedEmails: string[] = []
      let idx = 0
      const worker = async () => {
        while (idx < messages.length) {
          const { email, payload } = messages[idx++]
          const { error } = await admin.rpc('enqueue_email', { queue_name: TRANSACTIONAL_QUEUE, payload })
          if (!error) {
            enqueued++
            queuedEmails.push(email)
            continue
          }
          failed++
          console.error('enqueue_email failed', { email, error })
          await admin.from('email_send_log').insert({
            message_id: payload.message_id,
            template_name: 'admin-broadcast',
            recipient_email: payload.to,
            status: 'failed',
            error_message: 'Failed to enqueue email',
          })
          await admin.from('broadcast_recipients').update({ send_status: 'failed', error_message: error.message })
            .eq('broadcast_id', broadcastId).eq('email', email)
        }
      }
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, messages.length || 1) }, () => worker()))
      await markRecipients(queuedEmails, { send_status: 'sent' })
    } catch (e) {
      fatalError = e instanceof Error ? e.message : String(e)
      console.error('Fatal error in broadcast send loop', { error: fatalError, broadcastId })
    }

    // Finalize broadcast row
    const finalStatus =
      fatalError ? 'failed'
      : (failed === sendable.length && sendable.length > 0) ? 'failed'
      : 'sent'

    await admin.from('broadcasts').update({
      status: finalStatus,
      completed_at: new Date().toISOString(),
      enqueued_count: enqueued,
      failed_count: failed,
      error_message: fatalError,
    }).eq('id', broadcastId)

    return { enqueued, failed, fatalError }
  }

  // Large jobs run in the background and return immediately so the function
  // doesn't exceed its wall-clock limit. Progress is visible in History.
  if (sendable.length >= LARGE_JOB_THRESHOLD && typeof (globalThis as any).EdgeRuntime?.waitUntil === 'function') {
    (globalThis as any).EdgeRuntime.waitUntil(runSendLoop())
    return new Response(JSON.stringify({
      broadcastId,
      queued: true,
      total: recipients.length,
      sendable: sendable.length,
      suppressed: suppressedSet.size,
    }), { status: 202, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }

  const { enqueued, failed, fatalError } = await runSendLoop()

  if (fatalError) {
    return new Response(JSON.stringify({
      broadcastId, error: fatalError, enqueued, failed,
    }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }

  return new Response(JSON.stringify({
    broadcastId,
    total: recipients.length,
    enqueued,
    suppressed: suppressedSet.size,
    failed,
  }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
})
