## Root cause (verified)

The RLS `WITH CHECK` on the `payments` policy **"Users can insert own payments"** requires:

```
commission_pct_snapshot IS NULL
AND commission_base_usd_snapshot IS NULL
AND discount_amount_usd IS NULL
```

But two `BEFORE INSERT` triggers on `payments` (`payments_sanitize_client_insert_trg` and `trg_payments_enforce_financials`) run before the RLS `WITH CHECK` is evaluated and **populate** those exact fields from `pricing_plans` and `discount_codes`:

- `payments_enforce_financials` sets `NEW.commission_base_usd_snapshot := v_plan_commission` for every non-admin insert with a `plan_id`.
- Both triggers set `discount_amount_usd` when a discount code is applied.

Because `WITH CHECK` is evaluated on the final row (after BEFORE triggers), the row now has non-NULL values in fields the policy demands be NULL → Postgres rejects the insert with a permission error. Every regular user hits this the moment they submit their tx hash for a plan (and especially for any plan with a discount).

This regression was introduced by the recent hardening for finding `payments_client_insert_unconstrained_fields`, which added the three `IS NULL` clauses without accounting for the server-side triggers that intentionally populate those fields.

## Fix

Relax the `WITH CHECK` back to the identity/status/method constraints and rely on the existing `BEFORE INSERT` triggers (`payments_sanitize_client_insert`, `payments_enforce_financials`) to enforce that `commission_pct_snapshot`, `commission_base_usd_snapshot`, and `discount_amount_usd` come from trusted server-side data, not from the client. This is what actually blocks client-controlled commissions — the earlier `IS NULL` guard was redundant with the triggers and, worse, made every legitimate user insert fail.

### Migration

Drop and recreate policy **"Users can insert own payments"** on `public.payments`:

```
WITH CHECK (
  auth.uid() = user_id
  AND status IN ('pending','pending_review')
  AND payment_method = 'crypto'
)
```

No other policies, triggers, or app code change. Admin / sec-admin / payment-manager inserts continue to use their own policy and remain unchanged.

### Verify after migration

1. Signed-in non-admin user submits a tx hash for a paid plan → payment row created, no permission error.
2. Same flow with a valid discount code → payment row created with `discount_amount_usd` correctly populated by the trigger.
3. Attempt to insert with a hand-crafted `commission_pct_snapshot = 100` → trigger nulls it out; final row has no client-controlled commission.

### Security note

I'll update the security memory so a future scanner run doesn't re-flag `payments_client_insert_unconstrained_fields`: the sensitive financial fields are sanitized by two `SECURITY DEFINER` `BEFORE INSERT` triggers that overwrite any client-supplied value from `pricing_plans` / `discount_codes`, which is the real (and working) defense.
