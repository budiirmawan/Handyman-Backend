import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-PUSH-01 PART 01 — Push Device Registration Foundation.
 *
 * GOVERNANCE: docs/CR-BE-PUSH-01_START_GOVERNANCE.md §6, §7, §8, §12.7, §15.
 *
 * ADDITIVE ONLY. This migration extends the EXISTING BE-25L device authority
 * (`mobile_push_tokens`, migration 0235). It creates no second device table,
 * no delivery table, no attempt history, no provider integration and no
 * scheduler hook. Nothing here sends anything.
 *
 * 1. Delivery-readiness evidence columns (all nullable / defaulted, all
 *    INTERNAL — none of them is exposed in the public registration
 *    response, see §6 and the boundary guard B-01c):
 *      provider, last_success_at, last_failure_at,
 *      consecutive_failure_count, invalidated_at, invalidation_reason.
 *    They are written by later PARTs (03/04); PART 01 only defines them and
 *    the transitions that maintain them.
 *
 * 2. `status` CHECK widened to ('ACTIVE','INACTIVE','INVALID').
 *    INACTIVE  = the user/app deliberately unregistered the device.
 *    INVALID   = the provider declared the registration unusable (§8).
 *    Collapsing the two would destroy the evidence needed to explain why a
 *    device stopped receiving notifications.
 *
 * 3. Uniqueness is re-expressed as the semantics §6/§7 actually freeze:
 *      - exactly ONE ACTIVE registration per (user, device);
 *      - exactly ONE ACTIVE registration per push token, GLOBALLY.
 *    The 0235 table constraint `UNIQUE (user_id, device_id, status)` could
 *    not carry those semantics once history accumulates: it permits only one
 *    row per status value, so a device that is deactivated twice (or
 *    deactivated and later invalidated) collides on its HISTORY rows. Since
 *    historical rows must be retained (no destructive cleanup, §7 #12), the
 *    constraint is replaced by a PARTIAL unique index restricted to ACTIVE
 *    rows, which enforces the frozen rule exactly and leaves history free.
 *    The per-user partial token index from 0235 is replaced by a GLOBAL one:
 *    a single provider token must never be ACTIVE for two users at once
 *    (§7 #11 — one token silently routing to two accounts is an isolation
 *    defect, not a convenience).
 *
 * Data handling: no row is ever deleted. Pre-existing rows that would violate
 * the global token rule (the same token ACTIVE for more than one owner) are
 * normalised by demoting all but the most recently registered ACTIVE row to
 * INACTIVE — the rows, their timestamps and their provenance are retained.
 *
 * Reversibility: `down` restores the 0235 shape. It demotes INVALID rows back
 * to INACTIVE (so the narrower CHECK holds) and re-adds the original table
 * constraint. If accumulated history genuinely violates that original
 * constraint, `down` fails loudly with the Postgres uniqueness error rather
 * than deleting rows to make itself succeed.
 */
export const migration0334ExtendMobilePushTokensForDelivery: Migration = {
  id: '0334_extend_mobile_push_tokens_for_delivery',

  async up(client: PoolClient): Promise<void> {
    // -----------------------------------------------------------------
    // 1. Internal delivery-readiness evidence columns.
    // -----------------------------------------------------------------
    await client.query(`
      ALTER TABLE mobile_push_tokens
        ADD COLUMN provider                  TEXT,
        ADD COLUMN last_success_at           TIMESTAMPTZ,
        ADD COLUMN last_failure_at           TIMESTAMPTZ,
        ADD COLUMN consecutive_failure_count INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN invalidated_at            TIMESTAMPTZ,
        ADD COLUMN invalidation_reason       TEXT
    `);

    await client.query(`
      ALTER TABLE mobile_push_tokens
        ADD CONSTRAINT mobile_push_tokens_failure_count_check
          CHECK (consecutive_failure_count >= 0),
        ADD CONSTRAINT mobile_push_tokens_invalidation_reason_length_check
          CHECK (
            invalidation_reason IS NULL
            OR char_length(invalidation_reason) <= 200
          )
    `);

    // -----------------------------------------------------------------
    // 2. Widen the lifecycle: ACTIVE | INACTIVE | INVALID.
    //    An INVALID row must always carry the moment it was invalidated —
    //    an invalidation without provenance is not evidence.
    // -----------------------------------------------------------------
    await client.query(`
      ALTER TABLE mobile_push_tokens
        DROP CONSTRAINT mobile_push_tokens_status_check
    `);
    await client.query(`
      ALTER TABLE mobile_push_tokens
        ADD CONSTRAINT mobile_push_tokens_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE', 'INVALID')),
        ADD CONSTRAINT mobile_push_tokens_invalidated_provenance_check
          CHECK (status <> 'INVALID' OR invalidated_at IS NOT NULL)
    `);

    // -----------------------------------------------------------------
    // 3a. One ACTIVE registration per (user, device) — as a partial index,
    //     so unlimited INACTIVE/INVALID history rows may be retained.
    // -----------------------------------------------------------------
    await client.query(`
      ALTER TABLE mobile_push_tokens
        DROP CONSTRAINT mobile_push_tokens_user_device_active_unique
    `);
    await client.query(`
      CREATE UNIQUE INDEX mobile_push_tokens_user_device_active_idx
        ON mobile_push_tokens (user_id, device_id)
        WHERE status = 'ACTIVE'
    `);

    // -----------------------------------------------------------------
    // 3b. One ACTIVE registration per push token, across ALL users.
    //     Normalise any pre-existing cross-owner duplicate first: keep the
    //     most recently registered ACTIVE row, retain the others as
    //     INACTIVE history. No row is deleted.
    // -----------------------------------------------------------------
    await client.query(`
      UPDATE mobile_push_tokens AS stale
         SET status = 'INACTIVE',
             updated_at = NOW()
       WHERE stale.status = 'ACTIVE'
         AND EXISTS (
           SELECT 1
             FROM mobile_push_tokens AS winner
            WHERE winner.push_token = stale.push_token
              AND winner.status = 'ACTIVE'
              AND (winner.registered_at, winner.id) > (stale.registered_at, stale.id)
         )
    `);

    await client.query(`
      DROP INDEX mobile_push_tokens_user_token_active_unique
    `);
    await client.query(`
      CREATE UNIQUE INDEX mobile_push_tokens_token_active_idx
        ON mobile_push_tokens (push_token)
        WHERE status = 'ACTIVE'
    `);

    // Lookup path for "the ACTIVE devices of user X" (used by the PART 01
    // accessor and, later, by the delivery fan-out). `mobile_push_tokens_user_idx`
    // from 0235 already covers (user_id, status); nothing further is needed.
  },

  async down(client: PoolClient): Promise<void> {
    // Restore the 0235 lifecycle vocabulary without losing rows: an INVALID
    // row becomes INACTIVE history again.
    await client.query(`
      UPDATE mobile_push_tokens
         SET status = 'INACTIVE',
             updated_at = NOW()
       WHERE status = 'INVALID'
    `);

    await client.query(`
      DROP INDEX IF EXISTS mobile_push_tokens_token_active_idx
    `);
    await client.query(`
      CREATE UNIQUE INDEX mobile_push_tokens_user_token_active_unique
        ON mobile_push_tokens (user_id, push_token)
        WHERE status = 'ACTIVE'
    `);

    await client.query(`
      DROP INDEX IF EXISTS mobile_push_tokens_user_device_active_idx
    `);
    await client.query(`
      ALTER TABLE mobile_push_tokens
        ADD CONSTRAINT mobile_push_tokens_user_device_active_unique
          UNIQUE (user_id, device_id, status)
    `);

    await client.query(`
      ALTER TABLE mobile_push_tokens
        DROP CONSTRAINT IF EXISTS mobile_push_tokens_invalidated_provenance_check,
        DROP CONSTRAINT IF EXISTS mobile_push_tokens_status_check
    `);
    await client.query(`
      ALTER TABLE mobile_push_tokens
        ADD CONSTRAINT mobile_push_tokens_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
    `);

    await client.query(`
      ALTER TABLE mobile_push_tokens
        DROP CONSTRAINT IF EXISTS mobile_push_tokens_invalidation_reason_length_check,
        DROP CONSTRAINT IF EXISTS mobile_push_tokens_failure_count_check
    `);

    await client.query(`
      ALTER TABLE mobile_push_tokens
        DROP COLUMN IF EXISTS invalidation_reason,
        DROP COLUMN IF EXISTS invalidated_at,
        DROP COLUMN IF EXISTS consecutive_failure_count,
        DROP COLUMN IF EXISTS last_failure_at,
        DROP COLUMN IF EXISTS last_success_at,
        DROP COLUMN IF EXISTS provider
    `);
  },
};
