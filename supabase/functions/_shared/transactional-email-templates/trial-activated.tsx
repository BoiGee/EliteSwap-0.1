/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import { Heading, Text, Section } from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './registry.ts'
import { BrandFrame, BrandCta, BrandNote } from './_brand-frame.tsx'

interface Props {
  displayName?: string
  method?: string
  amountUsd?: number | string
  durationMinutes?: number
  reference?: string
  studioUrl?: string
}

const TrialActivatedEmail = ({
  displayName, method, amountUsd = 10, durationMinutes = 4, reference, studioUrl,
}: Props) => {
  const greet = displayName ? `Hi ${displayName},` : 'Hi there,'
  return (
    <BrandFrame preview="Your 4-minute EliteSwap trial is ready">
      <Heading style={h1}>Your trial is ready 🎁</Heading>
      <Text style={text}>{greet}</Text>
      <Text style={text}>
        We've confirmed your <strong>${typeof amountUsd === 'number' ? amountUsd.toFixed(0) : amountUsd} trial</strong> payment.
        Your <strong>{durationMinutes}-minute</strong> realtime face-swap session is unlocked and waiting in the studio.
      </Text>

      <Section style={detailBox}>
        <Text style={detailRow}><span style={detailLabel}>Amount:</span> <strong>${typeof amountUsd === 'number' ? amountUsd.toFixed(2) : amountUsd} USD</strong></Text>
        <Text style={detailRow}><span style={detailLabel}>Duration:</span> <strong>{durationMinutes} minutes</strong></Text>
        {method && (
          <Text style={detailRow}><span style={detailLabel}>Method:</span> <strong>{method}</strong></Text>
        )}
        {reference && (
          <Text style={detailRow}><span style={detailLabel}>Reference:</span> <span style={mono}>{reference}</span></Text>
        )}
      </Section>

      <BrandNote title="Heads up">
        Your timer only starts when you open the studio and begin your session — so set up your camera, lighting, and character first, then dive in.
      </BrandNote>

      <BrandCta href={studioUrl || 'https://eliteswap.online/studio'}>Open the Studio</BrandCta>

      <Text style={textMuted}>
        Need help? Reply to this email or reach us at support@eliteswap.online.
      </Text>
    </BrandFrame>
  )
}

export const template = {
  component: TrialActivatedEmail,
  subject: 'Your 4-minute EliteSwap trial is ready 🎁',
  displayName: 'Trial activated',
  previewData: {
    displayName: 'Alex',
    method: 'USDT (BEP-20)',
    amountUsd: 10,
    durationMinutes: 4,
    reference: '0xabc123def456...',
  },
} satisfies TemplateEntry

const h1 = { fontSize: '24px', fontWeight: 700 as const, color: '#1a1a1a', margin: '0 0 16px' }
const text = { fontSize: '15px', color: '#1a1a1a', lineHeight: '1.6', margin: '0 0 14px' }
const textMuted = { fontSize: '13px', color: '#55575d', lineHeight: '1.6', margin: '8px 0 0' }
const detailBox = { background: '#fafafa', border: '1px solid #eee', borderRadius: '6px', padding: '12px 16px', margin: '12px 0 20px' }
const detailRow = { fontSize: '14px', color: '#1a1a1a', margin: '4px 0' }
const detailLabel = { color: '#55575d', display: 'inline-block', minWidth: '88px' }
const mono = { fontFamily: 'monospace', fontSize: '13px' }
