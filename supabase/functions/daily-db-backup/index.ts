// Daily database backup — full-coverage edition
//
// Zip contents:
//   schema/ddl.sql                — CREATE TABLE / INDEX / VIEW / TYPE / FUNCTION / TRIGGER / POLICY for public schema
//   tables/*.csv                  — every table in the public schema (dynamic discovery)
//   auth_users.csv                — safe subset of auth.users (no password hashes)
//   auth_identities.csv           — OAuth identities (no tokens)
//   auth_mfa_factors.csv          — MFA factors metadata
//   auth_sessions.csv             — session summaries (id, user, timestamps, ip, ua)
//   config/cron_jobs.csv          — pg_cron scheduled jobs
//   config/cron_recent_runs.csv   — last 100 cron run details
//   config/realtime_publication.csv — tables in supabase_realtime publication
//   config/storage_buckets.csv    — bucket metadata (public flag, size/mime limits)
//   config/pgmq_queues.csv        — pgmq queue list (best-effort)
//   storage/<bucket>/…            — files in every non-backup storage bucket
//   storage/_manifest.csv         — index of copied storage files
//   MANIFEST.json                 — machine-readable summary of coverage
//   README.txt                    — human notes
//
// Triggered by:
//   - pg_cron daily at 02:00 UTC (service_role bearer)
//   - Admin "Run backup now" button (admin user JWT)

import { createClient } from 'npm:@supabase/supabase-js@2'
import {
  BlobWriter,
  TextReader,
  Uint8ArrayReader,
  ZipWriter,
} from 'https://deno.land/x/zipjs@v2.7.45/index.js'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const BUCKET = 'db-backups'
const SIGNED_URL_TTL_SECONDS = 60 * 60 * 48 // 48 hours (security policy max)
const STORAGE_TOTAL_BYTES_CAP = 500 * 1024 * 1024 // 500 MB safety cap
const PER_TABLE_ROW_CAP = 2_000_000
// Historical successful runs (schema + every table + auth + config +
// storage, combined) finished in under 90s. If schema/tables/auth/config
// alone already took longer than this, something is unusually slow —
// storage copying (the most I/O-heavy remaining step) is skipped rather
// than risk losing the whole run to whatever kills it past that point.
const STORAGE_STEP_TIME_BUDGET_MS = 2 * 60 * 1000

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return ''
  let s: string
  if (value instanceof Date) {
    s = value.toISOString()
  } else if (typeof value === 'object') {
    s = JSON.stringify(value)
  } else {
    s = String(value)
  }
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

function rowsToCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return ''
  const headers = Object.keys(rows[0])
  const lines: string[] = [headers.join(',')]
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(','))
  }
  return lines.join('\n')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!

  const authHeader = req.headers.get('Authorization') ?? ''
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  let triggeredBy = 'cron'

  if (!bearer) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  if (bearer !== serviceKey) {
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${bearer}` } },
    })
    const { data: claims, error: claimsErr } = await userClient.auth.getClaims(bearer)
    if (claimsErr || !claims?.claims?.sub) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    const admin = createClient(supabaseUrl, serviceKey)
    const { data: roleRow } = await admin
      .from('user_roles')
      .select('role')
      .eq('user_id', claims.claims.sub)
      .eq('role', 'admin')
      .maybeSingle()
    if (!roleRow) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    triggeredBy = 'manual'
  }

  const supabase = createClient(supabaseUrl, serviceKey)

  // Reap any prior run that crashed while `running` (>20min old). Every
  // successful run on record finished in under 2 minutes, so 20 minutes is
  // already a generous multiple of that with room for the data to grow —
  // no need for the original 1h grace period. Previously this only ever
  // ran at the START of the NEXT invocation — since this function is
  // normally only invoked once a day by cron, a crashed run could sit
  // showing "running" in the admin tab for up to 24 hours before anything
  // noticed. reap-watchdog (a separate cron job, every 15 min) calls this
  // exact same endpoint with mode=reap_only so stale rows are caught
  // within roughly 20-35 minutes instead of up to a day, without needing a
  // duplicate implementation of this query anywhere.
  const staleCutoff = new Date(Date.now() - 20 * 60 * 1000).toISOString()
  const { data: reaped } = await supabase.from('backup_runs')
    .update({ status: 'failed', error_message: 'timed_out_or_crashed', finished_at: new Date().toISOString() })
    .eq('status', 'running')
    .lt('started_at', staleCutoff)
    .select('id')

  let body: any = {}
  try { body = await req.json() } catch { /* no body is fine */ }
  if (body?.mode === 'reap_only') {
    return new Response(JSON.stringify({ ok: true, reaped: reaped?.length ?? 0 }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  // Signed URLs are capped at 48h (SIGNED_URL_TTL_SECONDS below, itself a
  // storage security-policy max) but backups are kept in private storage
  // indefinitely — "Download" on anything older than 2 days was a dead
  // link with no way to recover short of the Supabase dashboard. Re-sign
  // on demand instead of only ever signing once at creation time.
  if (body?.mode === 'resign' && typeof body?.run_id === 'string') {
    const { data: run, error: runLookupErr } = await supabase
      .from('backup_runs').select('storage_path').eq('id', body.run_id).maybeSingle()
    if (runLookupErr || !run?.storage_path) {
      return new Response(JSON.stringify({ error: 'run_not_found_or_no_file' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    const { data: signed, error: signErr } = await supabase.storage
      .from(BUCKET).createSignedUrl(run.storage_path, SIGNED_URL_TTL_SECONDS)
    if (signErr || !signed?.signedUrl) {
      return new Response(JSON.stringify({ error: signErr?.message ?? 'sign_failed' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    await supabase.from('backup_runs').update({ download_url: signed.signedUrl }).eq('id', body.run_id)
    return new Response(JSON.stringify({ ok: true, download_url: signed.signedUrl }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const startedAt = new Date()

  const { data: runRow, error: runErr } = await supabase
    .from('backup_runs')
    .insert({ status: 'running', triggered_by: triggeredBy })
    .select('id')
    .single()
  if (runErr || !runRow) {
    console.error('Failed to create backup_runs row', runErr)
    return new Response(JSON.stringify({ error: 'failed_to_log_run' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
  const runId = runRow.id as string

  // The actual backup (schema export, ~60+ table dumps, storage file
  // copying) is a long, highly variable-duration chain of sequential
  // network round-trips — normal runs finish in well under a minute, but
  // any hiccup anywhere in that chain has a real chance of pushing total
  // wall-clock time past this platform's synchronous-response ceiling,
  // which is exactly what the "timed_out_or_crashed" entries in
  // backup_runs' history show happening repeatedly (most recently:
  // stuck for 13+ hours with nothing to reap it until the next daily
  // tick). Running it via EdgeRuntime.waitUntil — the same mechanism
  // admin-broadcast-email already uses for large sends — frees it from
  // that synchronous ceiling entirely; the HTTP response returns
  // immediately once the run is recorded, and backup_runs is the source
  // of truth for whether it actually finished. Falls back to awaiting
  // inline if waitUntil isn't available (e.g. local dev).
  const work = runBackup(supabase, supabaseUrl, serviceKey, runId, triggeredBy, startedAt)
  if (typeof (globalThis as any).EdgeRuntime?.waitUntil === 'function') {
    (globalThis as any).EdgeRuntime.waitUntil(work)
    return new Response(JSON.stringify({ ok: true, queued: true, run_id: runId }), {
      status: 202, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
  return await work
})

async function runBackup(
  supabase: ReturnType<typeof createClient>,
  supabaseUrl: string,
  serviceKey: string,
  runId: string,
  triggeredBy: string,
  startedAt: Date,
): Promise<Response> {
  const extrasOk: Record<string, boolean> = {
    ddl: false, auth_identities: false, auth_mfa: false, auth_sessions: false,
    cron: false, realtime: false, storage_buckets: false, pgmq: false,
  }
  let schemaDdlBytes = 0

  try {
    const zipBlobWriter = new BlobWriter('application/zip')
    const zipWriter = new ZipWriter(zipBlobWriter)

    // Helper to add an RPC-backed CSV section, tolerating missing/failed RPCs
    const addRpcCsv = async (
      rpcName: string,
      zipPath: string,
      flagKey: string,
    ) => {
      try {
        const { data, error } = await supabase.rpc(rpcName as any)
        if (error) throw error
        const rows = (data ?? []) as Record<string, unknown>[]
        await zipWriter.add(zipPath, new TextReader(rowsToCsv(rows)))
        extrasOk[flagKey] = true
        return rows.length
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        console.warn(`${rpcName} failed:`, msg)
        await zipWriter.add(`${zipPath}.error.txt`, new TextReader(msg))
        return 0
      }
    }

    // 1) Schema DDL — the single most important addition
    try {
      const { data: ddlText, error: ddlErr } = await supabase.rpc('export_schema_ddl_for_backup' as any)
      if (ddlErr) throw ddlErr
      const ddl = String(ddlText ?? '')
      await zipWriter.add('schema/ddl.sql', new TextReader(ddl))
      schemaDdlBytes = new TextEncoder().encode(ddl).byteLength
      extrasOk.ddl = true
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.warn('schema ddl export failed:', msg)
      await zipWriter.add('schema/ddl.error.txt', new TextReader(msg))
    }

    // 2) Discover public tables
    const { data: tablesData, error: tablesErr } = await supabase
      .rpc('list_public_tables_for_backup')
    if (tablesErr) throw new Error(`list tables failed: ${tablesErr.message}`)
    const tableNames: string[] = ((tablesData ?? []) as Array<{ table_name: string }>)
      .map((r) => r.table_name)
    if (tableNames.length === 0) throw new Error('No tables discovered for backup')

    // 3) Dump tables
    let totalRows = 0
    const manifestTables: Array<{ name: string; rows: number; truncated: boolean }> = []
    for (const table of tableNames) {
      // 5000 rather than 1000: fewer sequential round-trips per table is a
      // meaningful chunk of what makes this function's total runtime so
      // variable — with 60+ tables, every extra page is another full
      // network round-trip multiplied across the whole run.
      const pageSize = 5000
      let from = 0
      let allRows: Record<string, unknown>[] = []
      let truncated = false
      while (true) {
        const { data, error } = await supabase
          .from(table)
          .select('*')
          .range(from, from + pageSize - 1)
        if (error) {
          console.warn(`Skipping table ${table}:`, error.message)
          break
        }
        if (!data || data.length === 0) break
        allRows = allRows.concat(data)
        if (data.length < pageSize) break
        from += pageSize
        if (allRows.length >= PER_TABLE_ROW_CAP) {
          console.warn(`Truncating ${table} at ${PER_TABLE_ROW_CAP} rows`)
          truncated = true
          break
        }
      }
      await zipWriter.add(`tables/${table}.csv`, new TextReader(rowsToCsv(allRows)))
      totalRows += allRows.length
      manifestTables.push({ name: table, rows: allRows.length, truncated })
      if (truncated) {
        await zipWriter.add(
          `tables/${table}._TRUNCATED.txt`,
          new TextReader(`Truncated at ${PER_TABLE_ROW_CAP} rows`),
        )
      }
    }

    // 4) auth.users (safe subset) + identities/mfa/sessions
    let authUserCount = 0
    try {
      const { data: authUsers, error: authErr } = await supabase
        .rpc('export_auth_users_for_backup')
      if (authErr) throw authErr
      const rows = (authUsers ?? []) as Record<string, unknown>[]
      authUserCount = rows.length
      await zipWriter.add('auth_users.csv', new TextReader(rowsToCsv(rows)))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.warn('auth users export failed:', msg)
      await zipWriter.add('auth_users.error.txt', new TextReader(msg))
    }
    const authIdentitiesCount = await addRpcCsv('export_auth_identities_for_backup', 'auth_identities.csv', 'auth_identities')
    const authMfaCount = await addRpcCsv('export_auth_mfa_factors_for_backup', 'auth_mfa_factors.csv', 'auth_mfa')
    const authSessionsCount = await addRpcCsv('export_auth_sessions_for_backup', 'auth_sessions.csv', 'auth_sessions')

    // 5) Config: cron / realtime / storage buckets / pgmq
    const cronJobsCount = await addRpcCsv('export_cron_jobs_for_backup', 'config/cron_jobs.csv', 'cron')
    await addRpcCsv('export_cron_recent_runs_for_backup', 'config/cron_recent_runs.csv', 'cron')
    const realtimeCount = await addRpcCsv('export_realtime_publication_for_backup', 'config/realtime_publication.csv', 'realtime')
    const bucketsMetaCount = await addRpcCsv('export_storage_buckets_for_backup', 'config/storage_buckets.csv', 'storage_buckets')
    const pgmqCount = await addRpcCsv('export_pgmq_queues_for_backup', 'config/pgmq_queues.csv', 'pgmq')

    // 6) Copy storage bucket contents
    let storageFileCount = 0
    let storageBytes = 0
    let storageCapped = false
    let storageSkippedOverBudget = false
    const storageManifest: Array<{ bucket: string; path: string; size: number }> = []
    const elapsedSoFarMs = Date.now() - startedAt.getTime()
    if (elapsedSoFarMs > STORAGE_STEP_TIME_BUDGET_MS) {
      // Schema + every table + auth + config already took longer than
      // usual (normal full runs finish in well under 2 minutes total) —
      // downloading storage files one at a time is the single most
      // I/O-heavy remaining step and the most likely thing to push an
      // already-slow run over whatever ceiling kills it. Skipping it here
      // means a database-only backup still completes and uploads instead
      // of the whole run being lost to a timeout with nothing to show for
      // it; storage files are the one thing not otherwise unrecoverable
      // (they still exist in their own bucket) if this happens.
      console.warn(`Skipping storage copy: already ${elapsedSoFarMs}ms into the run`)
      storageSkippedOverBudget = true
      await zipWriter.add(
        'storage/_SKIPPED.txt',
        new TextReader(`Storage copy skipped — backup was already ${Math.round(elapsedSoFarMs / 1000)}s in, over the ${STORAGE_STEP_TIME_BUDGET_MS / 1000}s budget for starting this step. Database contents above are unaffected.`),
      )
    } else {
    try {
      const { data: buckets, error: bucketsErr } = await supabase.storage.listBuckets()
      if (bucketsErr) throw bucketsErr
      const targetBuckets = (buckets ?? []).filter((b) => b.id !== BUCKET)

      for (const bucket of targetBuckets) {
        if (storageCapped) break
        const walk = async (prefix: string) => {
          if (storageCapped) return
          let offset = 0
          const limit = 100
          while (true) {
            const { data: entries, error: listErr } = await supabase.storage
              .from(bucket.id)
              .list(prefix, { limit, offset, sortBy: { column: 'name', order: 'asc' } })
            if (listErr) {
              console.warn(`list ${bucket.id}/${prefix} failed:`, listErr.message)
              break
            }
            if (!entries || entries.length === 0) break

            for (const entry of entries) {
              if (storageCapped) return
              const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name
              if (!entry.id) {
                await walk(fullPath)
                continue
              }
              const { data: fileBlob, error: dlErr } = await supabase.storage
                .from(bucket.id)
                .download(fullPath)
              if (dlErr || !fileBlob) {
                console.warn(`download ${bucket.id}/${fullPath} failed:`, dlErr?.message)
                continue
              }
              const bytes = new Uint8Array(await fileBlob.arrayBuffer())
              if (storageBytes + bytes.byteLength > STORAGE_TOTAL_BYTES_CAP) {
                console.warn(`Storage cap reached; stopping bucket copy`)
                storageCapped = true
                return
              }
              await zipWriter.add(
                `storage/${bucket.id}/${fullPath}`,
                new Uint8ArrayReader(bytes),
              )
              storageFileCount += 1
              storageBytes += bytes.byteLength
              storageManifest.push({ bucket: bucket.id, path: fullPath, size: bytes.byteLength })
            }

            if (entries.length < limit) break
            offset += entries.length
          }
        }
        await walk('')
      }

      await zipWriter.add(
        'storage/_manifest.csv',
        new TextReader(rowsToCsv(storageManifest)),
      )
      if (storageCapped) {
        await zipWriter.add(
          'storage/_TRUNCATED.txt',
          new TextReader(`Storage copy stopped at ${STORAGE_TOTAL_BYTES_CAP} bytes cap. Some files were not included.`),
        )
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.warn('storage backup failed:', msg)
      await zipWriter.add('storage/_error.txt', new TextReader(`Storage backup failed: ${msg}`))
    }
    }

    // 7) MANIFEST.json
    const manifest = {
      generated_at: startedAt.toISOString(),
      run_id: runId,
      triggered_by: triggeredBy,
      table_count: tableNames.length,
      total_rows: totalRows,
      tables: manifestTables,
      auth: {
        users: authUserCount,
        identities: authIdentitiesCount,
        mfa_factors: authMfaCount,
        sessions: authSessionsCount,
      },
      config: {
        cron_jobs: cronJobsCount,
        realtime_tables: realtimeCount,
        storage_buckets: bucketsMetaCount,
        pgmq_queues: pgmqCount,
      },
      storage: {
        file_count: storageFileCount,
        bytes: storageBytes,
        capped: storageCapped,
        skipped_over_time_budget: storageSkippedOverBudget,
      },
      schema_ddl_bytes: schemaDdlBytes,
      extras_ok: extrasOk,
      caps: {
        per_table_rows: PER_TABLE_ROW_CAP,
        storage_total_bytes: STORAGE_TOTAL_BYTES_CAP,
      },
    }
    await zipWriter.add('MANIFEST.json', new TextReader(JSON.stringify(manifest, null, 2)))

    // 8) README
    const readme = [
      `Eliteswap full backup ${startedAt.toISOString()}`,
      ``,
      `INCLUDED:`,
      `  schema/ddl.sql                — full public schema (tables, indexes, views, enums, functions, triggers, RLS + policies)`,
      `  tables/*.csv                  — every public table (row cap ${PER_TABLE_ROW_CAP.toLocaleString()})`,
      `  auth_users.csv                — safe subset of auth.users (no password hashes)`,
      `  auth_identities.csv           — OAuth identity links (no refresh tokens)`,
      `  auth_mfa_factors.csv          — MFA factor metadata`,
      `  auth_sessions.csv             — recent session summaries (no access tokens)`,
      `  config/cron_jobs.csv          — pg_cron scheduled jobs`,
      `  config/cron_recent_runs.csv   — last 100 cron run details`,
      `  config/realtime_publication.csv — realtime broadcast membership`,
      `  config/storage_buckets.csv    — storage bucket metadata (public, size/mime limits)`,
      `  config/pgmq_queues.csv        — pgmq queue list`,
      `  storage/<bucket>/...          — file bytes from every non-backup bucket`,
      `  storage/_manifest.csv         — index of copied storage files`,
      `  MANIFEST.json                 — machine-readable summary`,
      ``,
      `NOT INCLUDED (by design):`,
      `  - Password hashes and OAuth refresh tokens (security)`,
      `  - Project secrets and environment variables (Lovable-managed, out of DB)`,
      `  - Edge function source code (Lovable-managed)`,
      ``,
      `LIMITS:`,
      `  - Per-table cap: ${PER_TABLE_ROW_CAP.toLocaleString()} rows (truncation flagged in MANIFEST.json)`,
      `  - Total storage copy cap: ${STORAGE_TOTAL_BYTES_CAP} bytes (~500 MB)`,
      ``,
    ].join('\n')
    await zipWriter.add('README.txt', new TextReader(readme))

    await zipWriter.close()
    const zipBlob: Blob = await zipBlobWriter.getData()
    const zipBytes = new Uint8Array(await zipBlob.arrayBuffer())

    // Upload
    const d = startedAt
    const yyyy = d.getUTCFullYear()
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
    const dd = String(d.getUTCDate()).padStart(2, '0')
    const storagePath = `${yyyy}/${mm}/backup-${yyyy}-${mm}-${dd}.zip`

    const { error: uploadErr } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, zipBytes, {
        contentType: 'application/zip',
        upsert: true,
      })
    if (uploadErr) throw new Error(`upload failed: ${uploadErr.message}`)

    const { data: signed, error: signErr } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS)
    if (signErr || !signed?.signedUrl) {
      throw new Error(`sign failed: ${signErr?.message ?? 'no url'}`)
    }
    const downloadUrl = signed.signedUrl

    const finishedAt = new Date()
    const fileSizeBytes = zipBytes.byteLength
    const fileSizeMb = (fileSizeBytes / (1024 * 1024)).toFixed(2)

    await supabase.from('backup_runs').update({
      finished_at: finishedAt.toISOString(),
      status: 'success',
      table_count: tableNames.length,
      total_rows: totalRows,
      file_size_bytes: fileSizeBytes,
      storage_path: storagePath,
      download_url: downloadUrl,
      storage_file_count: storageFileCount,
      storage_bytes: storageBytes,
      auth_user_count: authUserCount,
      schema_ddl_bytes: schemaDdlBytes,
      extras_ok: extrasOk,
    }).eq('id', runId)

    // Email first admin
    const { data: adminProfile } = await supabase
      .from('profiles')
      .select('email, user_id, user_roles!inner(role)')
      .eq('user_roles.role', 'admin')
      .not('email', 'is', null)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()

    const recipient = adminProfile?.email
    if (recipient) {
      const emailRes = await fetch(`${supabaseUrl}/functions/v1/send-transactional-email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${serviceKey}`,
        },
        body: JSON.stringify({
          templateName: 'daily-backup-ready',
          recipientEmail: recipient,
          idempotencyKey: `daily-backup-${yyyy}-${mm}-${dd}`,
          templateData: {
            backupDate: `${yyyy}-${mm}-${dd}`,
            tableCount: tableNames.length,
            totalRows,
            fileSizeMb,
            downloadUrl,
            storagePath,
          },
        }),
      })
      if (!emailRes.ok) {
        console.error('email send failed', emailRes.status, await emailRes.text())
      }
    } else {
      console.warn('No admin recipient found; backup uploaded but no email sent')
    }

    return new Response(JSON.stringify({
      success: true,
      run_id: runId,
      table_count: tableNames.length,
      total_rows: totalRows,
      auth_user_count: authUserCount,
      storage_file_count: storageFileCount,
      storage_bytes: storageBytes,
      file_size_bytes: fileSizeBytes,
      schema_ddl_bytes: schemaDdlBytes,
      extras_ok: extrasOk,
      storage_path: storagePath,
      download_url: downloadUrl,
    }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('backup failed', msg)
    await supabase.from('backup_runs').update({
      finished_at: new Date().toISOString(),
      status: 'failed',
      error_message: msg.slice(0, 1000),
      schema_ddl_bytes: schemaDdlBytes,
      extras_ok: extrasOk,
    }).eq('id', runId)
    return new Response(JSON.stringify({ success: false, error: msg }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
}
