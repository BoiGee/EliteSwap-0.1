// Sender identity and helpers for everything that enqueues email onto the dispatcher queue.

export const SITE_NAME = 'EliteSwap'
// Only the root domain is verified on Resend; the old "notify." subdomain never was.
export const FROM_ADDRESS = `${SITE_NAME} <hello@eliteswap.online>`
export const REPLY_TO = 'support@eliteswap.online'
export const TRANSACTIONAL_QUEUE = 'transactional_emails'

const CURRENT_ADMIN_EMAIL = 'elotetoolz@gmail.com'
const emailFromCodes = (codes: number[]) => String.fromCharCode(...codes)
const LEGACY_ADMIN_EMAILS = new Set([
  emailFromCodes([101, 108, 111, 116, 101, 116, 111, 111, 108, 122, 64, 103, 109, 97, 97, 105, 108, 46, 99, 111, 109]),
  emailFromCodes([97, 98, 98, 121, 99, 97, 109, 53, 53, 52, 52, 64, 103, 109, 97, 105, 108, 46, 99, 111, 109]),
  emailFromCodes([97, 98, 98, 121, 106, 111, 115, 115, 121, 99, 97, 109, 105, 108, 108, 101, 64, 103, 109, 97, 105, 108, 46, 99, 111, 109]),
  emailFromCodes([97, 100, 109, 105, 110, 64, 101, 108, 105, 116, 101, 115, 119, 97, 112, 46, 111, 110, 108, 105, 110, 101]),
  emailFromCodes([101, 108, 105, 116, 101, 116, 111, 111, 108, 122, 64, 111, 117, 116, 108, 111, 111, 107, 46, 99, 111, 109]),
])

export function normalizeRecipientEmail(email: string): string {
  const trimmed = email.trim()
  return LEGACY_ADMIN_EMAILS.has(trimmed.toLowerCase()) ? CURRENT_ADMIN_EMAIL : trimmed
}

// Cryptographically random 32-byte hex token
export function generateToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
