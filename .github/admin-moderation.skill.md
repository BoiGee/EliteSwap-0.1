---
name: admin-moderation-system
description: Guidelines for admin dashboard, moderation, and content governance
applyTo:
  - "src/pages/Admin.tsx"
  - "src/components/admin/*"
  - "src/hooks/useAdmin.ts"
  - "supabase/functions/*broadcast*"
  - "supabase/functions/*admin*"
---

# Admin & Moderation System Skill

This skill provides guidance for building and maintaining Elite Swap's admin dashboard, moderation tools, and compliance systems.

## Admin System Architecture

### Role-Based Access Control
```typescript
const { isStaff, isSuperAdmin, loading } = useAdmin();
if (!isStaff) return <Redirect to="/dashboard" />;
```

**Roles**:
- **User**: Regular authenticated user (default)
- **Staff**: Can access admin dashboard, moderate content
- **SuperAdmin**: Full access including user deletion, system broadcasts

**Storage**: `profiles.role` in Supabase; checked on auth state change

### Permission Matrix
| Action | User | Staff | SuperAdmin |
|--------|------|-------|-----------|
| View analytics | ✓ | ✓ | ✓ |
| Moderate forum | ✗ | ✓ | ✓ |
| Send broadcasts | ✗ | ✓ | ✓ |
| Delete users | ✗ | ✗ | ✓ |
| Access raw logs | ✗ | ✗ | ✓ |

## Core Admin Features

### 1. Announcements & Broadcasts
**UI Component**: `AdminAnnouncementBanner`
**Edge Functions**:
- `admin-broadcast-email` - Send bulk emails to user segments
- `process-scheduled-broadcasts` - Scheduled email delivery
- `send-admin-push` - Web push notifications

**Workflow**:
1. Admin drafts announcement (title, body, target audience)
2. System stores in `announcements` table with `created_at`, `expires_at`
3. Cron job runs Edge Function to deliver emails/push at scheduled time
4. Users see banner on next page load (if announcement not dismissed)

**Audit Trail**: All broadcasts logged with timestamp, admin ID, recipient count

### 2. Forum Moderation
**Tables**: `forum_categories`, `forum_threads`, `forum_posts`
**Moderation Actions**:
- Lock/unlock thread (prevent new replies)
- Delete post or entire thread
- Assign moderators to categories
- Mark posts as "hidden until review"

**Flow**:
1. User reports post (UI button on post)
2. Report created in `reports` table
3. Staff review queue shows flagged items
4. Staff action: delete, warn user, or dismiss

### 3. User Management
**Features**:
- View user profiles, subscription status, activity
- Disable/suspend accounts temporarily
- Initiate account deletion (via `request-account-deletion` Edge Function)
- View audit log of user actions

**Compliance**: All user actions audit-logged; deletions scheduled for 30 days (recovery window)

### 4. Analytics & Monitoring
**Dashboards**:
- Active user count, signup trends
- Subscription revenue (fiat + crypto)
- Peak usage times, feature usage heatmaps
- Rate limit violations, error rates

**Data Source**: `activities` table (anonymous client ID + action timestamp)

## Edge Functions for Admin Operations

### Key Functions
```
admin-broadcast-email/        - Bulk email delivery
send-admin-push/              - Web push notifications
notify-admin-event/           - Alert on critical events
notify-admin-payment-event/   - Payment-related alerts
notify-sec-admin-action/      - Security/compliance events
request-account-deletion/     - Initiate user deletion
purge-deleted-accounts/       - Execute scheduled deletions
```

### Adding a New Admin Endpoint
1. **Create** new function in `supabase/functions/my-admin-action/`
2. **Implement** role check (staff/superadmin only)
3. **Log** action to `admin_actions` audit table
4. **Create** corresponding API call in `src/lib/adminPush.ts` or `adminNotify.ts`
5. **Test** with `supabase functions serve`

Example:
```typescript
// supabase/functions/my-admin-action/index.ts
export async function handleRequest(req: Request) {
  const { userId } = await req.json();
  
  // 1. Verify admin role (via JWT)
  const user = await verifyAdminJWT(req);
  if (!user?.is_staff) throw new Error("Unauthorized");
  
  // 2. Perform action
  const { error } = await supabase.from("users").update(...);
  
  // 3. Audit log
  await supabase.from("admin_actions").insert({
    admin_id: user.id,
    action: "my-admin-action",
    target_id: userId,
    timestamp: new Date(),
  });
  
  return new Response(JSON.stringify({ success: true }));
}
```

## Content Moderation Policy

### Forbidden Content (Auto-Remove)
- Explicit sexual content
- Non-consensual imagery (deepfakes without permission)
- Violence, gore, illegal activity
- Hate speech, harassment
- Spam, scams, phishing links

### Enforcement Tools
- **Automatic Filtering**: Prompt guards prevent generation of forbidden content
- **User Reports**: Flagged posts escalated to moderators
- **Keyword Scanning**: Optional regex/heuristic scanning on post submission
- **Rate Limiting**: Users limited to X posts per hour (prevent spam)

### Appeal Process
1. User submits appeal for deleted/suspended content
2. Appeal routed to SuperAdmin queue
3. SuperAdmin reviews original post + appeal reason
4. Decision: upheld, overturned, or escalated to legal

## Important Notes

### Compliance & Legal
- **GDPR**: Users can request/delete personal data (right to be forgotten)
- **CCPA**: California residents notified of data practices
- **Terms Enforcement**: Admin actions must comply with Terms of Service
- **Audit Logging**: All admin actions must be logged for legal compliance (non-repudiation)

### Security Best Practices
- **JWT Validation**: Always verify admin role in Edge Functions (don't trust client)
- **Input Sanitization**: Sanitize all user-submitted content before display/storage
- **Rate Limiting**: Enforce per-IP limits on sensitive endpoints (password reset, etc.)
- **2FA Optional**: Consider enforcing 2FA for SuperAdmin accounts

### Known Gotchas
- **Soft Delete Delays**: Deleted content isn't immediately purged (30-day recovery window)
- **Broadcast Timing**: Scheduled broadcasts may have 5-10 minute latency (Cron timing)
- **Pagination**: Large datasets may timeout; implement cursor-based pagination for analytics
- **Real-Time Updates**: Admin dashboard doesn't auto-refresh; require manual refresh for latest

## Common Admin Tasks

### Broadcasting an Announcement
```typescript
// 1. Trigger from Admin dashboard UI
await fetch("/api/broadcast", {
  method: "POST",
  body: JSON.stringify({
    title: "Maintenance scheduled",
    body: "Studio will be down 2-4pm UTC",
    targetAudience: "all", // or "premium_only", etc
    scheduledFor: "2025-01-15T14:00:00Z",
  }),
});

// 2. Edge Function processes at scheduled time
// 3. Users receive email + see banner on next login
```

### Moderating a Forum Thread
1. **Detect**: Post reported by user (report created)
2. **Review**: Staff views post + context in moderation queue
3. **Action**: Delete, hide, or warn user
4. **Notify**: User receives notification of action + appeal instructions
5. **Log**: Action recorded for audit trail

### Suspending a User Account
1. **Navigate** to user profile in Admin dashboard
2. **Select** "Suspend account" (staff can suspend temp, superadmin can delete)
3. **Choose** duration (24h, 7d, 30d, permanent)
4. **Reason**: Select from predefined categories (spam, abuse, ToS violation)
5. **System**: Disables auth tokens, prevents login, notifies user

## Testing Admin Features

### Local Testing
1. **Create test admin**: Update user in Supabase (set `is_staff: true`)
2. **Login**: Test user auto-redirects to `/admin`
3. **Test actions**: Broadcast, moderate posts, etc.
4. **Check logs**: Verify audit entries created in `admin_actions` table

### Edge Function Testing
```bash
supabase start
supabase functions serve
# Navigate to http://localhost:54321/functions/v1/my-admin-action
```

## References
- [Supabase Row Level Security](https://supabase.com/docs/guides/auth/row-level-security)
- [Supabase Edge Functions](https://supabase.com/docs/guides/functions)
- [GDPR Compliance Guide](https://gdpr.eu/)
- [Content Moderation Best Practices](https://www.w3.org/TR/social-web-protocols/#content-moderation)
