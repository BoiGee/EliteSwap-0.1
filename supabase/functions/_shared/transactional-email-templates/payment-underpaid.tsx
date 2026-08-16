/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import { Heading, Text, Section, Row, Column } from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './registry.ts'
import { BrandFrame, BrandCta, BrandNote, BRAND } from './_brand-frame.tsx'

interface Props {
  displayName?: string
  currency?: string
  network?: string
  depositAddress?: string
  expectedUsd?: number
  receivedUsd?: number
  shortfallUsd?: number
  txHash?: string
  supportUrl?: string
}

const fmt = (n?: number) =>
  typeof n === 'number' && isFinite(n) ? `$${n.toFixed(2)}` : '—'

const PaymentUnderpaidEmail = ({
  displayName,
  currency,
  network,
  depositAddress,
  expectedUsd,
  receivedUsd,
  shortfallUsd,
  txHash,
  supportUrl,
}: Props) => {
  const greet = displayName ? `Hi ${displayName},` : 'Hi there,'
  const shortfallLabel = fmt(shortfallUsd)
  return (
    <BrandFrame preview={`Your payment is ${shortfallLabel} short — top up to unlock your key`}>
      <Heading style={h1}>Almost there — your payment is a little short</Heading>
      <Text style={text}>{greet}</Text>
      <Text style={text}>
        We received your crypto transaction, but the amount is below what's needed to
        activate your EliteSwap upgrade. Send the shortfall to the same address below
        and our verifier will pick it up automatically.
      </Text>

      <Section style={tableBox}>
        <Row>
          <Column style={tableLabel}>Expected</Column>
          <Column style={tableVal}>{fmt(expectedUsd)}</Column>
        </Row>
        <Row>
          <Column style={tableLabel}>Received</Column>
          <Column style={tableVal}>{fmt(receivedUsd)}</Column>
        </Row>
        <Row>
          <Column style={tableLabelStrong}>Shortfall</Column>
          <Column style={tableValStrong}>{shortfallLabel}</Column>
        </Row>
      </Section>

      <BrandNote title={`Send the top-up · ${currency || 'crypto'}`}>
        {`Network: ${network || '—'}\nAddress: ${depositAddress || '—'}\n\nSend at least ${shortfallLabel} worth of ${currency || 'the same asset'} on the same network. Do not send on a different chain.`}
      </BrandNote>

      {txHash && (
        <Text style={textMuted}>
          Original transaction: <span style={mono}>{txHash}</span>
        </Text>
      )}

      <BrandCta href={supportUrl || 'mailto:support@eliteswap.online'}>
        Contact support after sending
      </BrandCta>

      <Text style={textMuted}>
        Once your top-up confirms on-chain, reply to this email with the new transaction
        hash so we can finalize your order right away. If you'd rather cancel and get a
        refund of what was sent, just let us know.
      </Text>
    </BrandFrame>
  )
}

export const template = {
  component: PaymentUnderpaidEmail,
  subject: (data: Record<string, any>) => {
    const s = typeof data?.shortfallUsd === 'number' ? `$${data.shortfallUsd.toFixed(2)}` : ''
    return s
      ? `Action needed: top up your EliteSwap payment (${s} short)`
      : 'Action needed: top up your EliteSwap payment'
  },
  displayName: 'Payment Underpaid — Top Up',
  previewData: {
    displayName: 'Alex',
    currency: 'USDT-TRC20',
    network: 'Tron Network (TRC20)',
    depositAddress: 'TMzkn5dm1Ehzg5KUF8uNcB1N9Y5FjzadF8',
    expectedUsd: 49.0,
    receivedUsd: 42.5,
    shortfallUsd: 6.5,
    txHash: '0xabc…123',
    supportUrl: 'mailto:support@eliteswap.online',
  },
} satisfies TemplateEntry

const h1 = { color: '#1a1a1a', fontSize: '22px', fontWeight: 700 as const, margin: '0 0 16px' }
const text = { color: '#1a1a1a', fontSize: '15px', lineHeight: '1.6', margin: '0 0 14px' }
const textMuted = { color: '#55575d', fontSize: '13px', lineHeight: '1.6', margin: '8px 0 14px' }
const mono = { fontFamily: 'Menlo, Consolas, monospace', fontSize: '12px', color: '#1a1a1a', wordBreak: 'break-all' as const }
const tableBox = {
  background: '#f7f5ff',
  border: '1px solid #e6deff',
  borderRadius: '6px',
  padding: '12px 16px',
  margin: '8px 0 20px',
}
const tableLabel = { color: '#55575d', fontSize: '14px', padding: '6px 0' }
const tableVal = { color: '#1a1a1a', fontSize: '14px', padding: '6px 0', textAlign: 'right' as const, fontWeight: 600 as const }
const tableLabelStrong = { color: BRAND.primaryDeep, fontSize: '14px', padding: '8px 0 0', fontWeight: 700 as const, borderTop: '1px solid #e3d9fc' }
const tableValStrong = { color: BRAND.primaryDeep, fontSize: '16px', padding: '8px 0 0', textAlign: 'right' as const, fontWeight: 800 as const, borderTop: '1px solid #e3d9fc' }
