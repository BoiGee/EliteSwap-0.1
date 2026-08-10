/// <reference types="npm:@types/react@18.3.1" />
import * as React from 'npm:react@18.3.1'

export interface TemplateEntry {
  component: React.ComponentType<any>
  subject: string | ((data: Record<string, any>) => string)
  to?: string
  displayName?: string
  previewData?: Record<string, any>
}

import { template as paymentApproved } from './payment-approved.tsx'
import { template as paymentRejected } from './payment-rejected.tsx'
import { template as adminBroadcast } from './admin-broadcast.tsx'
import { template as paymentNudge } from './payment-nudge.tsx'

import { template as dailyBackupReady } from './daily-backup-ready.tsx'
import { template as paymentUnderpaid } from './payment-underpaid.tsx'
import { template as trialActivated } from './trial-activated.tsx'

export const TEMPLATES: Record<string, TemplateEntry> = {
  'payment-approved': paymentApproved,
  'payment-rejected': paymentRejected,
  'admin-broadcast': adminBroadcast,
  'payment-nudge': paymentNudge,
  
  'daily-backup-ready': dailyBackupReady,
  'payment-underpaid': paymentUnderpaid,
  'trial-activated': trialActivated,
}
