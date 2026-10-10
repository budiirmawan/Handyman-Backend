import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * W03 PART 03B — actor-aware identity on the Execution Scope ledger, so a
 * `TENANT_PIC` decision is referenceable without creating a second ledger.
 *
 * Contract: A01 §7.1 (the ALTER) and §7.2 (E1–E5), as reconciled with
 * ADD-A §5 ("`handyman_execution_scopes` needs **no** binding column").
 *
 * WHY A TENANT_PIC SCOPE NEEDS NO NEW POINTER. `quotation_decision_id` is
 * already `NOT NULL` (`0395:34-35`), so every scope row chains to the decision
 * row that carries `approval_binding_id` and `decided_by_tenant_pic_id`: one
 * hop, always present, and no denormalised copy that could drift out of step
 * with the consent it records (E2). Adding a scope-side binding column would be
 * the second ledger in disguise that decision 9 forbids.
 *
 * ZERO BACKFILL, SAME MECHANISM AS 0438: the constant `DEFAULT 'USER'` is the
 * backfill (metadata-only, no UPDATE). Existing rows keep their user identity.
 *
 * READ COMPATIBILITY (E4) was verified in the contract: no consumer joins
 * `handyman_execution_scopes.created_by_user_id` to `users`
 * (`handyman-scope-assignments/`, `handyman-sla-status-api/`, `handyman-settlement/`,
 * `handyman-financial-entitlements/`, `handyman-customer-transactions/`,
 * `handyman-requests/handyman-service-request.repository.ts`), so relaxing the
 * column cannot silently drop downstream rows. Any future join on it must be
 * `LEFT` and actor-class aware.
 *
 * IMMUTABILITY IS INHERITED, NOT REPEATED. `handyman_execution_scope_no_write`
 * (`0395`) blocks every UPDATE and DELETE unconditionally, so the three new
 * columns are immutable from birth without touching that trigger — unlike the
 * decision ledger, which needed its timing list widened because it had no INSERT
 * branch to extend.
 *
 * DELIBERATELY NOT DONE IN THIS PART (each is a later ratified step, not an
 * oversight):
 *   - the `created_by_pic_session_id` column of A01 §7.1, because
 *     `handyman_pic_workspace_sessions` does not exist at this HEAD (created by
 *     the frozen session PART). The CHECK below is therefore the session-clause-
 *     free form and must be dropped/re-created in §7.1's full shape by that PART,
 *     mirroring the identical deferral recorded in 0438.
 *   - the `BEFORE INSERT` eligibility guard (E1: a scope may only be inserted by
 *     the APPROVE branch of a `TENANT_PIC` decision; E3: enforced in service and
 *     DB; the "forged scope must raise" exit test). A01 §13 assigns that
 *     trigger-timing widening to 03F, and §13's 03E row says explicitly
 *     "scope-creation guard changes (already covered by 03C's rules — verify,
 *     don't duplicate)". Shipping the columns here is what makes that 03F guard
 *     expressible at all; adding it now would also silently change behaviour for
 *     the still-live staff path, which this schema-only PART may not do.
 *   - any service, route, repository or projection change (03C's `insertScope`
 *     keeps writing `created_by_user_id`, which satisfies the `USER` branch).
 */
export const migration0439HandymanExecutionScopeActorIdentity: Migration = {
  id: '0439_handyman_execution_scope_actor_identity',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE handyman_execution_scopes
        ADD COLUMN IF NOT EXISTS created_by_actor_type TEXT NOT NULL DEFAULT 'USER',
        ADD COLUMN IF NOT EXISTS created_by_tenant_pic_id UUID
          REFERENCES tenant_pics (id),
        ALTER COLUMN created_by_user_id DROP NOT NULL;
    `);
    await client.query(`
      DO $handyman_execution_scopes_actor_checks$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'handyman_execution_scopes'::regclass
            AND conname = 'handyman_execution_scopes_actor_identity_check'
        ) THEN
          ALTER TABLE handyman_execution_scopes
            ADD CONSTRAINT handyman_execution_scopes_actor_identity_check
            CHECK (
              (created_by_actor_type = 'USER'
                AND created_by_user_id IS NOT NULL
                AND created_by_tenant_pic_id IS NULL)
              OR (created_by_actor_type = 'TENANT_PIC'
                AND created_by_user_id IS NULL
                AND created_by_tenant_pic_id IS NOT NULL)
            );
        END IF;
      END;
      $handyman_execution_scopes_actor_checks$;
    `);
  },
  async down(client: PoolClient): Promise<void> {
    // Same M3 posture as 0438: a PIC-attributed scope is history and cannot be
    // rolled back by deleting the columns that identify it.
    await client.query(`
      DO $handyman_execution_scopes_actor_down$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM handyman_execution_scopes
          WHERE created_by_actor_type <> 'USER'
             OR created_by_tenant_pic_id IS NOT NULL
        ) THEN
          RAISE EXCEPTION
            'Rollback refused: handyman_execution_scopes carries PIC-attributed rows (M3). Forward-fix only.'
            USING ERRCODE = '23514';
        END IF;
      END;
      $handyman_execution_scopes_actor_down$;
    `);
    await client.query(`
      ALTER TABLE handyman_execution_scopes
        ALTER COLUMN created_by_user_id SET NOT NULL,
        DROP CONSTRAINT IF EXISTS handyman_execution_scopes_actor_identity_check,
        DROP COLUMN IF EXISTS created_by_tenant_pic_id,
        DROP COLUMN IF EXISTS created_by_actor_type;
    `);
  },
};
