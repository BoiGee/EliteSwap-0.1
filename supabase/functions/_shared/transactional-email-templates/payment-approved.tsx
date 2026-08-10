/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import { Heading, Text, Section } from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './registry.ts'
import { BrandFrame, BrandCta, BrandNote } from './_brand-frame.tsx'

interface Props {
  displayName?: string
  amountUsd?: number | string
  planName?: string
  paymentMethod?: string
  reference?: string
  adminNote?: string
  dashboardUrl?: string
}

const PaymentApprovedEmail = ({
  displayName, amountUsd, planName, paymentMethod, reference, adminNote, dashboardUrl,
}: Props) => {
  const greet = displayName ? `Hi ${displayName},` : 'Hi there,'
  return (
    <BrandFrame preview="Your EliteSwap payment is confirmed">
      <Heading style={h1}>Payment confirmed ✅</Heading>
      <Text style={text}>{greet}</Text>
      <Text style={text}>
        Great news — we've received and confirmed your payment. Your EliteSwap access is now <strong>active</strong>.
      </Text>

      <Section style={detailBox}>
        {amountUsd != null && (
          <Text style={detailRow}><span style={detailLabel}>Amount:</span> <strong>${typeof amountUsd === 'number' ? amountUsd.toFixed(2) : amountUsd} USD</strong></Text>
        )}
        {planName && (
          <Text style={detailRow}><span style={detailLabel}>Plan:</span> <strong>{planName}</strong></Text>
        )}
        {paymentMethod && (
          <Text style={detailRow}><span style={detailLabel}>Method:</span> <strong>{paymentMethod}</strong></Text>
        )}
        {reference && (
          <Text style={detailRow}><span style={detailLabel}>Reference:</span> <span style={mono}>{reference}</span></Text>
        )}
      </Section>

      {adminNote && adminNote.trim().length > 0 && (
        <BrandNote title="Message from the EliteSwap team">{adminNote}</BrandNote>
      )}

      <Text style={text}>
        Head to your dashboard to start swapping faces in real time.
      </Text>

      <BrandCta href={dashboardUrl || 'https://eliteswap.online/dashboard'}>Open Dashboard</BrandCta>

      <Text style={textMuted}>
        Need help? Reply to this email or reach us at support@eliteswap.online — we're happy to help.
      </Text>
    </BrandFrame>
  )
}

export const template = {
  component: PaymentApprovedEmail,
  subject: 'Your EliteSwap payment is confirmed ✅',
  displayName: 'Payment approved',
  previewData: {
    displayName: 'Alex',
    amountUsd: 49,
    planName: 'Pro Monthly',
    paymentMethod: 'Crypto',
    reference: '0xabc123def456...',
    adminNote: 'Thanks for upgrading — your account is fully unlocked.',
  },
} satisfies TemplateEntry

const h1 = { fontSize: '24px', fontWeight: 700 as const, color: '#1a1a1a', margin: '0 0 16px' }
const text = { fontSize: '15px', color: '#1a1a1a', lineHeight: '1.6', margin: '0 0 14px' }
const textMuted = { fontSize: '13px', color: '#55575d', lineHeight: '1.6', margin: '8px 0 0' }
const detailBox = { background: '#fafafa', border: '1px solid #eee', borderRadius: '6px', padding: '12px 16px', margin: '12px 0 20px' }
const detailRow = { fontSize: '14px', color: '#1a1a1a', margin: '4px 0' }
const detailLabel = { color: '#55575d', display: 'inline-block', minWidth: '88px' }
const mono = { fontFamily: 'monospace', fontSize: '13px' }
