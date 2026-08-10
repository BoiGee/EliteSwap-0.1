/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import { Heading, Text, Section, Link } from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './registry.ts'
import { BrandFrame, BrandCta } from './_brand-frame.tsx'

// Block types match the markdown parser in admin-broadcast-email/index.ts
type InlineRun = { text: string; bold?: boolean; italic?: boolean; href?: string }
type Block =
  | { kind: 'paragraph'; runs: InlineRun[] }
  | { kind: 'list'; items: InlineRun[][] }
  | { kind: 'heading'; runs: InlineRun[] }

interface Props {
  displayName?: string
  subject?: string
  blocks?: Block[]
  ctaLabel?: string
  ctaUrl?: string
}

const renderRuns = (runs: InlineRun[]) => (
  <>
    {runs.map((r, i) => {
      let node: React.ReactNode = r.text
      if (r.bold) node = <strong key={`b-${i}`}>{node}</strong>
      if (r.italic) node = <em key={`i-${i}`}>{node}</em>
      if (r.href) node = <Link key={`l-${i}`} href={r.href} style={inlineLink}>{node}</Link>
      return <React.Fragment key={i}>{node}</React.Fragment>
    })}
  </>
)

const AdminBroadcastEmail = ({ displayName, subject, blocks = [], ctaLabel, ctaUrl }: Props) => {
  const greet = displayName ? `Hi ${displayName},` : 'Hi there,'
  const previewText = subject || 'A message from EliteSwap'
  return (
    <BrandFrame preview={previewText}>
      {subject && <Heading style={h1}>{subject}</Heading>}
      <Text style={text}>{greet}</Text>

      {blocks.map((block, idx) => {
        if (block.kind === 'heading') {
          return <Heading key={idx} style={h2}>{renderRuns(block.runs)}</Heading>
        }
        if (block.kind === 'list') {
          return (
            <Section key={idx} style={{ margin: '6px 0 14px' }}>
              {block.items.map((item, i) => (
                <Text key={i} style={listItem}>• {renderRuns(item)}</Text>
              ))}
            </Section>
          )
        }
        return <Text key={idx} style={text}>{renderRuns(block.runs)}</Text>
      })}

      {ctaLabel && ctaUrl && <BrandCta href={ctaUrl}>{ctaLabel}</BrandCta>}

      <Text style={textMuted}>— The EliteSwap Team</Text>
    </BrandFrame>
  )
}

export const template = {
  component: AdminBroadcastEmail,
  subject: (data: Record<string, any>) => (typeof data?.subject === 'string' && data.subject) || 'A message from EliteSwap',
  displayName: 'Admin broadcast',
  previewData: {
    displayName: 'Alex',
    subject: 'New characters just dropped in EliteSwap',
    blocks: [
      { kind: 'paragraph', runs: [{ text: 'We just shipped ' }, { text: '12 new characters', bold: true }, { text: ' for you to swap into!' }] },
      { kind: 'list', items: [
        [{ text: 'Cyberpunk pack' }],
        [{ text: 'Anime classics' }],
        [{ text: 'Movie villains' }],
      ]},
    ],
    ctaLabel: 'Try them now',
    ctaUrl: 'https://eliteswap.online/dashboard',
  },
} satisfies TemplateEntry

const h1 = { fontSize: '24px', fontWeight: 700 as const, color: '#1a1a1a', margin: '0 0 16px' }
const h2 = { fontSize: '18px', fontWeight: 700 as const, color: '#1a1a1a', margin: '20px 0 8px' }
const text = { fontSize: '15px', color: '#1a1a1a', lineHeight: '1.6', margin: '0 0 14px' }
const listItem = { fontSize: '14px', color: '#1a1a1a', lineHeight: '1.6', margin: '4px 0', paddingLeft: '4px' }
const textMuted = { fontSize: '13px', color: '#55575d', lineHeight: '1.6', margin: '20px 0 0' }
const inlineLink = { color: '#A64DFF', textDecoration: 'underline' }
