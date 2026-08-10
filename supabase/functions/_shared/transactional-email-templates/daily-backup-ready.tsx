/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import { Heading, Text, Section } from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './registry.ts'
import { BrandFrame, BrandCta, BrandNote } from './_brand-frame.tsx'

interface Props {
  backupDate?: string
  tableCount?: number
  totalRows?: number
  fileSizeMb?: number | string
  downloadUrl?: string
  storagePath?: string
}

const formatNumber = (n?: number) =>
  typeof n === 'number' ? n.toLocaleString('en-US') : '—'

const DailyBackupReadyEmail = ({
  backupDate, tableCount, totalRows, fileSizeMb, downloadUrl, storagePath,
}: Props) => (
  <BrandFrame preview={`EliteSwap database backup ready — ${backupDate ?? 'today'}`}>
    <Heading style={h1}>Daily backup ready 💾</Heading>
    <Text style={text}>
      Your daily EliteSwap database backup completed successfully.
    </Text>

    <Section style={detailBox}>
      <Text style={detailRow}><span style={detailLabel}>Date:</span> <strong>{backupDate ?? '—'}</strong></Text>
      <Text style={detailRow}><span style={detailLabel}>Tables:</span> <strong>{formatNumber(tableCount)}</strong></Text>
      <Text style={detailRow}><span style={detailLabel}>Rows:</span> <strong>{formatNumber(totalRows)}</strong></Text>
      <Text style={detailRow}><span style={detailLabel}>File size:</span> <strong>{fileSizeMb ?? '—'} MB</strong></Text>
      {storagePath && (
        <Text style={detailRow}><span style={detailLabel}>Path:</span> <span style={mono}>{storagePath}</span></Text>
      )}
    </Section>

    {downloadUrl && (
      <BrandCta href={downloadUrl}>Download backup (.zip)</BrandCta>
    )}

    <BrandNote title="About this link">
      The download link is signed and valid for 1 year. The backup file itself is kept permanently in private storage — if the link ever expires, a new one can be re-issued from the admin panel.
    </BrandNote>

    <Text style={textMuted}>
      Inside the zip: one CSV per table in the public schema, including a header row.
    </Text>
  </BrandFrame>
)

export const template = {
  component: DailyBackupReadyEmail,
  subject: (d: Record<string, any>) =>
    `EliteSwap daily backup ready — ${d.backupDate ?? 'today'}`,
  displayName: 'Daily DB backup ready',
  previewData: {
    backupDate: '2026-06-15',
    tableCount: 36,
    totalRows: 12480,
    fileSizeMb: '4.2',
    downloadUrl: 'https://example.com/download',
    storagePath: '2026/06/backup-2026-06-15.zip',
  },
} satisfies TemplateEntry

const h1 = { fontSize: '24px', fontWeight: 700 as const, color: '#1a1a1a', margin: '0 0 16px' }
const text = { fontSize: '15px', color: '#1a1a1a', lineHeight: '1.6', margin: '0 0 14px' }
const textMuted = { fontSize: '13px', color: '#55575d', lineHeight: '1.6', margin: '8px 0 0' }
const detailBox = { background: '#fafafa', border: '1px solid #eee', borderRadius: '6px', padding: '12px 16px', margin: '12px 0 20px' }
const detailRow = { fontSize: '14px', color: '#1a1a1a', margin: '4px 0' }
const detailLabel = { color: '#55575d', display: 'inline-block', minWidth: '88px' }
const mono = { fontFamily: 'monospace', fontSize: '13px' }
