/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import { Heading, Text, Section, Link } from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './registry.ts'
import { BrandFrame, BrandCta, BrandNote, BRAND } from './_brand-frame.tsx'

interface Props {
  displayName?: string
  amountUsd?: number | string
  paymentMethod?: string
  reference?: string
  adminNote?: string
  retryUrl?: string
}

const PaymentRejectedEmail = ({
  displayName, amountUsd, paymentMethod, reference, adminNote, retryUrl,
}: Props) => {
  const greet = displayName ? `Hi ${displayName},` : 'Hi there,'
  return (
    <BrandFrame preview="Update on your EliteSwap payment">
      <Heading style={h1}>Update on your payment</Heading>
      <Text style={text}>{greet}</Text>
      <Text style={text}>
        Thanks for trying to upgrade your EliteSwap account. Unfortunately, we weren't able to confirm your most recent payment, so your access has not been activated yet.
      </Text>

      {(amountUsd != null || paymentMethod || reference) && (
        <Section style={detailBox}>
          {amountUsd != null && (
            <Text style={detailRow}><span style={detailLabel}>Amount:</span> <strong>${typeof amountUsd === 'number' ? amountUsd.toFixed(2) : amountUsd} USD</strong></Text>
          )}
          {paymentMethod && (
            <Text style={detailRow}><span style={detailLabel}>Method:</span> <strong>{paymentMethod}</strong></Text>
          )}
          {reference && (
            <Text style={detailRow}><span style={detailLabel}>Reference:</span> <span style={mono}>{reference}</span></Text>
          )}
        </Section>
      )}

      {adminNote && adminNote.trim().length > 0 && (
        <BrandNote title="Reason from the EliteSwap team">{adminNote}</BrandNote>
      )}

      <Text style={text}>What you can do next:</Text>
      <Text style={textListItem}>• Try a different payment method (we accept crypto and card / mobile money)</Text>
      <Text style={textListItem}>• Double-check the transaction reference and re-submit</Text>
      <Text style={textListItem}>• Reach out — we'll personally help you get sorted</Text>

      <BrandCta href={retryUrl || 'https://eliteswap.online/pricing'}>Try Again</BrandCta>

      <Text style={textMuted}>
        Questions? Reply to this email or contact{' '}
        <Link href="mailto:support@eliteswap.online" style={link}>support@eliteswap.online</Link>.
      </Text>
    </BrandFrame>
  )
}

export const template = {
  component: PaymentRejectedEmail,
  subject: 'Update on your EliteSwap payment',
  displayName: 'Payment rejected',
  previewData: {
    displayName: 'Alex',
    amountUsd: 49,
    paymentMethod: 'Crypto (USDT)',
    reference: '0xabc...def',
    adminNote: 'We could not verify the transaction on-chain. Please re-send with the correct hash.',
  },
} satisfies TemplateEntry

const h1 = { fontSize: '24px', fontWeight: 700 as const, color: '#1a1a1a', margin: '0 0 16px' }
const text = { fontSize: '15px', color: '#1a1a1a', lineHeight: '1.6', margin: '0 0 14px' }
const textListItem = { fontSize: '14px', color: '#1a1a1a', lineHeight: '1.6', margin: '4px 0', paddingLeft: '4px' }
const textMuted = { fontSize: '13px', color: '#55575d', lineHeight: '1.6', margin: '8px 0 0' }
const detailBox = { background: '#fafafa', border: '1px solid #eee', borderRadius: '6px', padding: '12px 16px', margin: '12px 0 20px' }
const detailRow = { fontSize: '14px', color: '#1a1a1a', margin: '4px 0' }
const detailLabel = { color: '#55575d', display: 'inline-block', minWidth: '88px' }
const mono = { fontFamily: 'monospace', fontSize: '13px' }
const link = { color: BRAND.primaryDeep, textDecoration: 'underline' }
