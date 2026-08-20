---
name: auth-subscription-compliance
description: Guidelines for authentication, subscription management, and compliance workflows
applyTo:
  - "src/hooks/useAuth.tsx"
  - "src/components/StudioTermsGate.tsx"
  - "src/lib/termsContent.tsx"
  - "supabase/functions/*purchase*"
  - "supabase/functions/*payment*"
---

# Authentication, Subscription & Compliance Skill

This skill provides guidance for working with Elite Swap's user authentication, subscription management, Terms/Privacy compliance, and payment systems.

## Authentication System

### Auth Flow
1. **Signup**: Email + password → Supabase Auth creates user + JWT
2. **Session**: Browser stores JWT; refreshed automatically on token expiry
3. **Protected Routes**: Require `useAuth()` to check `user` before rendering
4. **Rate Limiting**: `authRetry` wrapper auto-retries 429 responses with exponential backoff

### Multi-Tab Coordination
Elite Swap detects concurrent logins across browser tabs to prevent accidental logout:
```typescript
const TAB_CHANNEL = "eliteswap-auth";  // Broadcast Channel name
const MULTI_TAB_COOLDOWN_MS = 24 * 60 * 60 * 1000;  // 24h warning cooldown

// On auth state change, sends message across tabs
// Only warns once per 24h to avoid UI spam
```

**Why?**: If user logs in on tab A, then tab B auto-logs out on token refresh, they get confused. Now: tab B shows warning instead of silent logout.

### Rate Limiting Protection
```typescript
// authRetry wrapper intercepts 429 responses
// Auto-retries with exponential backoff: 1s, 2s, 4s, 8s, etc.
installAuthRetry();  // Called in useAuth.tsx on mount
```

**Behavior**:
- Initial auth request fails with 429
- Client waits 1s, retries
- If retry succeeds: no user-visible error
- If all retries fail: shows rate limit toast (30m cooldown to avoid spam)

### Important Auth Hooks
```typescript
// Main auth context
const { user, session, loading } = useAuth();

// Admin role check
const { isStaff, isSuperAdmin, loading } = useAdmin();

// Activity tracking (anonymous, no user data)
useActivityTracker();
```

## Terms & Consent Management

### Terms of Service Gate (`StudioTermsGate`)
```
┌─ User accesses /studio
├─ Component checks: has user accepted current ToS version?
├─ If NO:
│  ├─ Show modal with full terms text
│  ├─ Require explicit checkbox acceptance
│  └─ On accept: save `terms_accepted_at` + `terms_version` to profile
└─ If YES: render children (DeepfakeStudio component)
```

**Version Tracking**:
- `TERMS_VERSION` incremented when ToS changes
- Users must re-accept on major updates
- Prevents legal disputes ("I didn't see the new terms")

**Fail-Open Logic** (important for UX):
- If terms check times out (4s), grant access anyway
- Still audit-log the access for legal compliance
- Prevents users from being stuck if DB is slow

### Terms Content Management
```typescript
// src/lib/termsContent.tsx
export const TERMS_VERSION = "1.0";

export const TermsContent = () => (
  <>
    <h2>Studio Terms</h2>
    <p>Users must agree they will not use for non-consensual deepfakes...</p>
    {/* Include full legal terms here */}
  </>
);

// Used in StudioTermsGate + Forum/Guidelines pages
```

**Best Practices**:
- Keep terms in `termsContent.tsx` (single source of truth)
- Link to Privacy Policy + Code of Conduct
- Include specific use case prohibitions (non-consensual content, etc.)
- Update version number when terms change materially
- Consider legal review before deploying changes

## Subscription & Payment System

### Trial Flow
1. **Signup**: `create-trial-purchase` Edge Function auto-creates 7-day free trial
2. **Dashboard**: User sees active trial expiry date
3. **Expiry**: On day 7, trial marked as `cancelled`, user prompted to upgrade
4. **Upgrade**: User selects plan (monthly/annual, crypto/fiat)

### Premium Plans
- **Free**: Limited to 5 minutes/day studio time
- **Premium**: Unlimited studio time, character presets, priority support
- **Studio+**: Everything + OBS integration, API access

### Payment Processing
```
User selects plan
    ↓
Choose payment method (Paystack/Stripe for fiat, crypto for crypto)
    ↓
Supabase Edge Function handles webhook
    ↓
Verify payment received
    ↓
Update subscription status in DB
    ↓
User sees upgraded plan immediately
```

**Key Functions**:
- `verify-trial-payment` - Confirm trial purchase succeeded
- `verify-crypto-payment` - Check blockchain for tx confirmation
- `reconcile-trial-purchases` - Nightly cron to fix missed payments; the $10 trial's Mobile Money leg is a manual paste-reference flow (no webhook), confirmed by an admin via `admin_manage_trial_purchase`

### Crypto Payment Integration
```typescript
<CryptoPayment
  amount={plan.price}
  currency="USDC"  // or USDT, ETH, etc
  onSuccess={() => /* update subscription */}
/>
```

**Workflow**:
1. User selects crypto payment
2. Component generates unique wallet address (per transaction)
3. User sends crypto to address
4. Blockchain monitored for confirmation (via API or webhook)
5. Payment confirmed → subscription activated

**Rate Feeds**: `useCryptoPrices()` and `useFiatRates()` keep prices current

### Handling Payment Failures
```typescript
// Payment webhook received but verification failed
if (!verifyPaymentSignature(payload, secret)) {
  console.error("Webhook signature mismatch");
  await logSecurityEvent("invalid_payment_webhook");
  return new Response("Invalid", { status: 403 });
}

// Payment verified but user not found
if (!user) {
  await queueRetry("process-email-queue", { userId, reason: "user_not_found" });
  return new Response("Queued", { status: 202 });
}
```

## Account Management & Deletion

### Account Deletion Request
```
User clicks "Delete account" in settings
    ↓
`request-account-deletion` Edge Function queued
    ↓
30-day recovery period begins
    ↓
User notified: "Account will be deleted on [date]"
    ↓
User can cancel deletion within 30 days
    ↓
After 30 days: `purge-deleted-accounts` cron deletes data
```

**What's deleted**:
- Auth record (email, password)
- Profile (name, settings)
- Activity logs (for privacy)
- Forum posts/threads (anonymized, not deleted)
- Subscription data (archived for tax)

**What's kept** (for legal compliance):
- Payment records (tax, fraud investigation)
- Admin action logs (audit trail)
- Anonymous activity events (analytics, no PII)

### Privacy & Data Export
```typescript
// User can request data export (GDPR right to data portability)
// Edge Function `export-user-data` creates JSON archive:
// {
//   "profile": { name, email, created_at, ... },
//   "subscriptions": [ { plan, start, end, ... } ],
//   "activity": [ { action, timestamp, ... } ],
//   "forum_posts": [ { content, created_at, ... } ]
// }
```

## Compliance Checklist

### Before Deployment
- [ ] Terms of Service reviewed by legal counsel
- [ ] Privacy Policy includes data retention policies
- [ ] GDPR/CCPA requirements documented
- [ ] Rate limiting configured per business requirements
- [ ] Audit logging enabled (all admin/payment actions)
- [ ] Data deletion procedures implemented + tested
- [ ] Payment webhook signatures verified

### Ongoing
- [ ] Review suspicious payment/auth activity (dashboard)
- [ ] Monitor rate limit violations
- [ ] Process account deletion requests within SLA
- [ ] Log admin actions for compliance
- [ ] Annual Terms review (legal + compliance team)

## Common Compliance Tasks

### Updating Terms of Service
1. **Draft** new terms in `src/lib/termsContent.tsx`
2. **Increment** `TERMS_VERSION` (e.g., "1.0" → "1.1")
3. **Test**: New users must accept; existing users see "Update available" notice
4. **Deploy**: Push to production
5. **Notify**: Send email to all users about changes
6. **Track**: Monitor acceptance rate via `profiles.terms_accepted_at`

### Processing GDPR Data Request
1. User requests personal data (via support form)
2. Staff triggers `export-user-data` Edge Function
3. JSON file sent to user email
4. Log action in audit trail

### Handling Rate Limit Complaints
1. **Check**: Review user's auth request history
2. **Analyze**: Was limit triggered legitimately (many failed logins) or false positive?
3. **Action**: If false positive, manually reset rate limit counter
4. **Communicate**: Notify user of resolution

## Testing Auth & Compliance

### Unit Tests
```bash
npm run test -- auth utils  # Test utility functions
```

### Integration Testing
1. **Signup**: Create new account, verify email
2. **Terms Gate**: Access studio, accept terms, verify DB updated
3. **Trial Expiry**: Fast-forward date in DB, verify user sees expiry notice
4. **Payment**: Use Stripe test credentials, verify webhook processed
5. **Data Export**: Request data, verify JSON returned
6. **Account Deletion**: Request deletion, verify 30-day wait timer

### Manual QA Checklist
- [ ] Signup → login → logout flow works
- [ ] Multi-tab warning shows on second login
- [ ] Terms gate blocks studio access until accepted
- [ ] Trial displays with expiry date
- [ ] Premium plan activation works
- [ ] Crypto payment address unique per transaction
- [ ] Account deletion request queued (no immediate delete)
- [ ] Rate limit toast appears on failed auth

## Important Notes

### Security Best Practices
- **Never log passwords**: Only log hashed attempts
- **JWT Expiry**: Set reasonable expiry (24h recommended, auto-refresh on load)
- **HTTPS Only**: Payment endpoints require HTTPS (no HTTP)
- **CORS**: Restrict to origin domain only
- **Webhook Signing**: Always verify payment webhook signatures (prevent replay attacks)

### Known Gotchas
- **Terms Gate Timeout**: If DB slow, user granted access but not audit-logged
- **Payment Webhook Delay**: Stripe/Paystack may take 5-10 min to send webhook
- **Trial Auto-Create**: Happens on signup; if fails silently, user confused why can't access studio
- **Rate Limit**: Per-IP, not per-user; VPN/proxy users may hit limit from shared IP

## References
- [Supabase Authentication](https://supabase.com/docs/guides/auth)
- [Payment Compliance (PCI-DSS)](https://www.pcisecuritystandards.org/)
- [GDPR Compliance](https://gdpr.eu/)
- [CCPA Privacy Rights](https://oag.ca.gov/privacy/ccpa)
- [Stripe/Paystack Webhook Documentation](https://stripe.com/docs/webhooks)
