# Elite Swap - Agent Customization Guide

**Elite Swap** is a real-time AI face-swap SaaS platform with integrated streaming (OBS), subscription management, community forums, and comprehensive admin/moderation systems. This guide helps AI agents understand the codebase, architecture, and development workflows.

## Project Overview

**Core Business**: Subscription-based SaaS offering real-time facial replacement technology for video streaming and content creation, with:
- **DeepfakeStudio**: Real-time face swap using Decart AI API, integrated with OBS streaming software
- **Character Presets**: Pre-defined face/appearance templates users can apply
- **Subscription Tiers**: Free trial + premium plans with crypto payment support
- **Community Forum**: Moderated discussion platform with categories and thread management
- **Admin Dashboard**: Broadcasting, user management, analytics, content moderation
- **Compliance**: Terms of Service gating, activity tracking, content filtering, account management

**Tech Stack**:
- **Frontend**: React 18 + TypeScript, Vite, Tailwind CSS, shadcn/ui components, TanStack Query
- **Backend**: Supabase (PostgreSQL + Auth), Edge Functions, Real-time subscriptions
- **Media Processing**: Web Workers for H.264 encoding, Decart SDK for real-time video AI
- **Key Libraries**: @decartai/sdk, @supabase/supabase-js, react-router-dom, @hookform/react-hook-form

## Architecture & Key Patterns

### 1. Authentication & Authorization
- **Auth Flow**: Email/password via Supabase, with rate limiting protection
- **Multi-tab Awareness**: Detects concurrent logins across browser tabs (24h cooldown before warning)
- **Rate Limiting**: 429-aware fetch wrapper (`authRetry`) auto-retries failed auth requests
- **Role-Based Access**: Admin/staff roles with `/admin` protected routes requiring `useAdmin()` hook
- **Activity Tracking**: Anonymous client ID generation and session tracking for analytics

**Location**: [src/hooks/useAuth.tsx](src/hooks/useAuth.tsx), [src/integrations/supabase/authRetry.ts](src/integrations/supabase/authRetry.ts)

### 2. Safety & Governance System

#### Prompt Filtering (`lucyPromptGuard`)
- **Identity Preservation**: Automatically appends "preserve reference face identity" to protect user facial features from AI morphing
- **Negative Prompts**: Filters for common deepfake artifacts (extra limbs, merged faces, nudity, watermarks, etc.)
- **Prompt Sanitization**: Max 2200 char limit, whitespace normalization
- **Test Coverage**: Full unit tests validate guard behavior

**Location**: [src/lib/lucyPromptGuard.ts](src/lib/lucyPromptGuard.ts), [src/lib/lucyPromptGuard.test.ts](src/lib/lucyPromptGuard.test.ts)

#### Terms of Service Gate
- **Studio Access**: All users must accept current Terms before using `/studio` (real-time face swap)
- **Version Tracking**: `TERMS_VERSION` incremented when ToS changes; users re-agree on major updates
- **Fail-Open Logic**: If terms check times out (4s), access granted but audit logged
- **Profile Storage**: `terms_accepted_at` + `terms_version` stored in user profiles

**Location**: [src/components/StudioTermsGate.tsx](src/components/StudioTermsGate.tsx), [src/lib/termsContent.tsx](src/lib/termsContent.tsx)

### 3. Real-Time Video Processing Pipeline

#### DeepfakeStudio Component
1. **Webcam Capture**: Uses browser Media Devices API to capture video stream
2. **Worker Encoding**: Offloads H.264 encoding to [src/workers/obsEncoder.worker.ts](src/workers/obsEncoder.worker.ts)
3. **Decart API Integration**: `useDecartRealtime()` hooks handles authentication, frame submission, and inference response
4. **OBS Integration**: Streams encoded frames via HTTP to OBS for real-time broadcast
5. **Lite Mode**: Auto-detects low-end devices; `?hi=1` URL param forces full quality

**Key Files**:
- [src/components/DeepfakeStudio.tsx](src/components/DeepfakeStudio.tsx) (master component, ~400 lines)
- [src/hooks/useDecartRealtime.ts](src/hooks/useDecartRealtime.ts) (API integration)
- [src/workers/obsEncoder.worker.ts](src/workers/obsEncoder.worker.ts) (video encoding fallback logic)

### 4. State Management & Data Fetching
- **TanStack Query**: Centralized caching for Supabase queries, auto-retry logic with exponential backoff
- **React Context**: Authentication state (`AuthProvider`), translations (`TranslationProvider`)
- **Custom Hooks**: Most domain logic lives in hooks (`useAuth`, `useAdmin`, `useForum`, etc.) for reusability
- **Supabase Real-time**: WebSocket subscriptions for live updates (admin alerts, forum notifications)

### 5. Component Organization
```
src/components/
├── UI Components          (shadcn/ui wrappers)
├── Feature Components     (StudioTermsGate, DeepfakeStudio, etc.)
├── Account/               (Profile, settings, account mgmt)
├── Admin/                 (Dashboard, user management, analytics)
├── Dashboard/             (User stats, subscription info)
├── Forum/                 (Thread lists, post creation)
├── Partner/               (Referral program)
├── Studio/                (Video effects, character presets)
└── Page-level Components  (Auth, Landing, Reviews, etc.)
```

### 6. Subscription & Payments
- **Free Trial**: Initial subscription created on signup (`create-trial-purchase` function)
- **Crypto Support**: `CryptoPayment` component for non-fiat currency checkout
- **Fiat Rates**: Real-time conversion rates (`useFiatRates`)
- **Crypto Prices**: Live price feeds (`useCryptoPrices`)
- **Webhook Verification**: `paystack-webhook` + `verify-crypto-payment` Edge Functions handle payment callbacks

## Build & Deployment

### Available Commands
```bash
npm run dev              # Start Vite dev server on :8080 (HMR enabled, overlay disabled)
npm run build            # Production build (Vite)
npm run build:dev        # Dev-mode build (source maps, no minification)
npm run lint             # ESLint check
npm run test             # Run all Vitest unit tests
npm run test:watch       # Watch mode for development
npm run preview          # Preview production bundle locally
```

### Development Environment
- **HMR**: Hot Module Replacement enabled, overlay disabled for cleaner dev experience
- **Path Aliases**: `@/` resolves to `src/` directory
- **Dependency Deduping**: React, react-dom, @tanstack/react-query deduplicated in Vite config
- **Component Tagger**: `lovable-tagger` plugin active in development mode (tracks component usage)

### Production Considerations
- **Build Output**: Minified bundles in `dist/` directory
- **Supabase Migrations**: Run via `supabase/migrations/` (auto-applied on deploy)
- **Edge Functions**: Deploy from `supabase/functions/` directory
- **Environment Variables**: `.env.local` for local dev, CI/CD secrets for production

## Key Development Patterns & Conventions

### 1. Error Handling
- **Error Boundary**: Wraps entire app in [src/components/ErrorBoundary.tsx](src/components/ErrorBoundary.tsx) to catch unhandled React errors
- **Supabase Errors**: Logged to console, user-friendly toasts for common issues (rate limit, auth failure)
- **Worker Errors**: Fallback logic (e.g., H.264 encode fails → JPEG fallback)

### 2. Testing Strategy
- **Unit Tests**: Vitest + React Testing Library
- **Focus Areas**: Prompt guard logic ([lucyPromptGuard.test.ts](src/lib/lucyPromptGuard.test.ts)), utility functions ([utils.test.ts](src/lib/utils.test.ts))
- **Test Setup**: [src/test/setup.ts](src/test/setup.ts) configures environment

### 3. Internationalization (i18n)
- **Translation Provider**: Wraps app to enable multi-language UI
- **Hook**: `useDisplayLocale()` gets active locale
- **Scope**: Language switcher in header; primarily UI text (not prompt content)

**Location**: [src/i18n/TranslationProvider.tsx](src/i18n/TranslationProvider.tsx)

### 4. Forum Moderation
- **Guidelines**: [src/lib/termsContent.tsx](src/lib/termsContent.tsx) contains forum guidelines
- **Role Support**: Forum endpoints check user roles for moderation actions
- **Notification System**: Users notified on new replies, mentions, etc.

**Location**: [src/pages/Forum/](src/pages/Forum/)

### 5. Admin & Notifications
- **Broadcast System**: Admins send system-wide announcements or emails to users
- **Push Notifications**: Web push via Supabase with `send-admin-push` Edge Function
- **Activity Logging**: All admin actions audit-logged for compliance

## Working with Supabase

### Key Tables
- `profiles` (user metadata, terms acceptance, roles)
- `subscriptions` (active/trial plans, expiry)
- `forum_categories`, `forum_threads`, `forum_posts`
- `activities` (audit log for analytics + compliance)
- `announcements` (system-wide banners)

### Edge Functions (Serverless)
Run on Supabase infrastructure; handle async tasks:
- Email broadcasts, transactional emails
- Payment webhooks, crypto verification
- Account deletion requests, backups
- Batch translations, scheduled jobs

**Location**: [supabase/functions/](supabase/functions/)

## Common Tasks

### Adding a New Feature
1. **Define hooks** in `src/hooks/` for data/state logic
2. **Create components** in `src/components/` organized by domain
3. **Add routes** in `src/App.tsx` if page-level
4. **Test** with `npm run test:watch`
5. **Update** Terms/Guidelines if user-facing + compliance-sensitive

### Modifying Safety Features
- **Prompt Guards**: Edit `lucyPromptGuard.ts` and update tests
- **Terms/Policies**: Update `termsContent.tsx` and increment `TERMS_VERSION`
- **Rate Limits**: Adjust `authRetry.ts` retry logic or Supabase RLS policies
- **Admin Controls**: Add new admin endpoints in Edge Functions

### Debugging Real-Time Video
- **Check Console**: Worker logs, Decart API responses
- **URL Params**: `?debug=1` may enable verbose logging (if implemented)
- **Fallback Tracking**: Monitor browser console for H.264 → JPEG fallback messages
- **Device Detection**: Lite mode auto-detects low-end devices; test with `?hi=1` to force full quality

## Important Notes

### Rate Limiting & Compliance
- **Multi-Tab Prevention**: 24h cooldown before warning (avoids UX annoyance)
- **Auth Rate Limits**: Supabase enforces per-IP limits; client-side retry wrapper handles 429 responses
- **Activity Tracking**: Client ID + session data used for analytics; respects privacy regulations
- **GDPR/Data Deletion**: Account deletion available; purges data via `purge-deleted-accounts` Edge Function

### Known Gotchas
- **Terms Gate Timeout**: If terms check times out (network issues), user granted access but audit-logged
- **Crypto Payment Delay**: Webhook verification can take minutes; status reflects in dashboard after Supabase updates
- **OBS Stream URL**: DeepfakeStudio generates unique HTTP endpoint; ensure firewall allows inbound traffic from OBS machine
- **Worker Path**: Ensure `obsEncoder.worker.ts` path matches URL in `import.meta.url`

## Useful Links
- **Decart AI SDK Docs**: https://docs.decart.ai/
- **OBS Documentation**: https://obsproject.com/wiki/
- **Supabase Docs**: https://supabase.com/docs/
- **Vite Configuration**: https://vitejs.dev/config/
- **shadcn/ui Components**: https://ui.shadcn.com/

---

**Note**: This codebase includes safety features (prompt guards, ToS gating, content filtering) as part of the business model and legal compliance. Any modifications to these systems should preserve user privacy, consent, and prevent misuse.
