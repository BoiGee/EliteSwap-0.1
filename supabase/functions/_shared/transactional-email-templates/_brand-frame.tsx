/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'
import {
  Body, Container, Head, Heading, Html, Preview, Section, Text, Hr, Button, Link, Img,
} from 'npm:@react-email/components@0.0.22'

// Matches the web app's "refined dark studio" palette (src/index.css
// --primary: 255 85% 65%) — a single signature indigo-violet instead of
// the old cyan/magenta/purple trio, so emails no longer clash with the
// redesigned app. Email clients need literal hex, not CSS custom
// properties, so these are a one-time conversion of the same tokens.
export const BRAND = {
  name: 'EliteSwap',
  tagline: 'Realtime AI Face & Character Swap',
  url: 'https://eliteswap.online',
  supportEmail: 'support@eliteswap.online',
  logoUrl: 'https://eliteswap.online/email-logo.png',
  primary: '#8B5CF6',
  primaryDeep: '#6D3FE0',
  dark: '#15121F',
  textDark: '#1a1a1a',
  textMuted: '#55575d',
  textFooter: '#999999',
}

interface BrandFrameProps {
  preview: string
  children: React.ReactNode
}

export const BrandFrame = ({ preview, children }: BrandFrameProps) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>{preview}</Preview>
    <Body style={main}>
      <Container style={outer}>
        {/* Header bar */}
        <Section style={headerBar}>
          <Img src={BRAND.logoUrl} alt="EliteSwap" width="56" height="56" style={logoImg} />
          <Heading style={wordmark}>EliteSwap</Heading>
          <Text style={tagline}>{BRAND.tagline}</Text>
        </Section>

        {/* Content */}
        <Container style={contentContainer}>
          {children}
        </Container>

        {/* Footer */}
        <Hr style={hr} />
        <Section style={footerSection}>
          <Text style={footerCompany}>
            EliteSwap · <Link href={BRAND.url} style={footerLink}>eliteswap.online</Link> ·{' '}
            <Link href={`mailto:${BRAND.supportEmail}`} style={footerLink}>{BRAND.supportEmail}</Link>
          </Text>
          <Text style={footerLegal}>
            You are receiving this email because you have an EliteSwap account or interacted with our service.
          </Text>
        </Section>
      </Container>
    </Body>
  </Html>
)

interface CtaProps {
  href: string
  children: React.ReactNode
}

export const BrandCta = ({ href, children }: CtaProps) => (
  <Section style={{ textAlign: 'center' as const, padding: '8px 0 24px' }}>
    <Button href={href} style={ctaButton}>
      {children}
    </Button>
  </Section>
)

interface NoteProps {
  title: string
  children: React.ReactNode
}

export const BrandNote = ({ title, children }: NoteProps) => (
  <Section style={noteBox}>
    <Text style={noteTitle}>{title}</Text>
    <Text style={noteBody}>{children}</Text>
  </Section>
)

// ----- styles -----
const main = { backgroundColor: '#ffffff', fontFamily: 'Arial, Helvetica, sans-serif', margin: 0, padding: 0 }
const outer = { maxWidth: '600px', margin: '0 auto', padding: '0' }
const headerBar = {
  // Monochromatic depth (two shades of the same violet), not the old
  // three-hue cyan/purple/magenta rainbow — matches the "one confident
  // accent" rule the app redesign uses instead of gradient-as-decoration.
  background: `linear-gradient(135deg, ${BRAND.primaryDeep} 0%, ${BRAND.primary} 100%)`,
  padding: '28px 24px',
  textAlign: 'center' as const,
  borderRadius: '0 0 4px 4px',
}
const logoImg = { display: 'block', margin: '0 auto 10px', borderRadius: '12px' }
const wordmark = {
  color: BRAND.dark,
  fontSize: '32px',
  fontWeight: 800 as const,
  margin: '0 0 4px',
  letterSpacing: '-0.5px',
  fontFamily: 'Arial, Helvetica, sans-serif',
}
const tagline = {
  color: BRAND.dark,
  fontSize: '13px',
  margin: 0,
  opacity: 0.85,
  fontWeight: 600 as const,
}
const contentContainer = { padding: '32px 28px 8px' }
const ctaButton = {
  background: BRAND.primary,
  color: BRAND.dark,
  fontSize: '15px',
  fontWeight: 700 as const,
  textDecoration: 'none',
  padding: '14px 32px',
  borderRadius: '8px',
  display: 'inline-block',
}
const noteBox = {
  background: '#f6f3fe',
  border: '1px solid #e3d9fc',
  borderLeft: `4px solid ${BRAND.primary}`,
  borderRadius: '6px',
  padding: '14px 16px',
  margin: '16px 0 24px',
}
const noteTitle = {
  color: BRAND.primaryDeep,
  fontSize: '12px',
  fontWeight: 700 as const,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.5px',
  margin: '0 0 6px',
}
const noteBody = { color: '#1a1a1a', fontSize: '14px', lineHeight: '1.6', margin: 0, whiteSpace: 'pre-wrap' as const }
const hr = { borderColor: '#eaeaea', margin: '24px 28px 0' }
const footerSection = { padding: '16px 28px 28px', textAlign: 'center' as const }
const footerCompany = { fontSize: '12px', color: '#55575d', margin: '0 0 8px' }
const footerLink = { color: BRAND.primaryDeep, textDecoration: 'none' }
const footerLegal = { fontSize: '11px', color: '#999999', margin: 0, lineHeight: '1.5' }
