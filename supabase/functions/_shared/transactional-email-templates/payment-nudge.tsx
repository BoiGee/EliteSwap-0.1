/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import { Heading, Text } from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './registry.ts'
import { BrandFrame, BrandCta, BrandNote } from './_brand-frame.tsx'

interface Props {
  displayName?: string
  headline?: string
  body?: string
  ctaLabel?: string
  ctaUrl?: string
  adminNote?: string
}

const PaymentNudgeEmail = ({
  displayName,
  headline,
  body,
  ctaLabel,
  ctaUrl,
  adminNote,
}: Props) => {
  const greet = displayName ? `Hi ${displayName},` : 'Hi there,'
  return (
    <BrandFrame preview={headline || 'Your EliteSwap upgrade is one step away'}>
      <Heading style={h1}>{headline || 'Finish unlocking EliteSwap'}</Heading>
      <Text style={text}>{greet}</Text>

      <Text style={text}>
        {body ||
          'We noticed you started upgrading your EliteSwap account but didn’t finish. Your spot is still saved — pick up right where you left off.'}
      </Text>

      {adminNote && adminNote.trim().length > 0 && (
        <BrandNote title="A note from the EliteSwap team">{adminNote}</BrandNote>
      )}

      <BrandCta href={ctaUrl || 'https://eliteswap.online/dashboard'}>
        {ctaLabel || 'Resume Upgrade'}
      </BrandCta>

      <Text style={textMuted}>
        Hit a snag with payment? Just reply to this email or message support@eliteswap.online —
        a real human will help you finish in under 5 minutes.
      </Text>
    </BrandFrame>
  )
}

export const template = {
  component: PaymentNudgeEmail,
  subject: 'Finish unlocking your EliteSwap access',
  displayName: 'Payment nudge',
  previewData: {
    displayName: 'Alex',
    headline: 'Your Pro upgrade is one click away',
    body: 'We saw you reached the payment screen but didn’t finish. The plan is still waiting — and we just dropped a small bonus in your cart to make it easier.',
    ctaLabel: 'Finish Upgrade',
    ctaUrl: 'https://eliteswap.online/dashboard',
    adminNote: 'Use code WELCOME10 at checkout for 10% off.',
  },
} satisfies TemplateEntry

const h1 = { fontSize: '24px', fontWeight: 700 as const, color: '#1a1a1a', margin: '0 0 16px' }
const text = { fontSize: '15px', color: '#1a1a1a', lineHeight: '1.6', margin: '0 0 14px' }
const textMuted = { fontSize: '13px', color: '#55575d', lineHeight: '1.6', margin: '8px 0 0' }
