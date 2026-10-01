import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-01 AMENDMENT 01 PART 09 — exchange actor provenance.
 *
 * Governance: docs/handyman/CR-HM-01_AMENDMENT_01_CUSTOMER_CARE_ACTOR_HANDOFF.md
 * (frozen D4/D5/D7/D8).
 *
 * `handyman_handoff_exchanges` gains the nullable, server-derived Customer Care
 * actor provenance carried by the one-time exchange snapshot:
 *
 *   actor_type       — NULL for legacy handoffs; 'CUSTOMER_CARE' when attested
 *   care_actor_id    — FK to the PART 07 registry (never a users/tenant_pics id)
 *   actor_reference  — the attested, integration-scoped opaque reference
 *
 * Legacy compatibility: pre-amendment rows keep NULL in all three columns and
 * remain valid; no backfill, no rewrite. The coherence constraint makes the
 * three columns all-or-nothing, so an exchange can never carry a partial or
 * fabricated actor identity, and `care_actor_id` can only reference a real
 * registry row. Token hashing, TTL, single-use status and replay semantics are
 * untouched.
 */
export const migration0426AddHandymanHandoffExchangeActorProvenance: Migration = {
  id: '0426_add_handyman_handoff_exchange_actor_provenance',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE handyman_handoff_exchanges
        ADD COLUMN actor_type TEXT,
        ADD COLUMN care_actor_id UUID REFERENCES handyman_handoff_care_actors (id),
        ADD COLUMN actor_reference TEXT,
        ADD CONSTRAINT handyman_handoff_exchanges_actor_type_check
          CHECK (actor_type IS NULL OR actor_type IN ('CUSTOMER_CARE')),
        ADD CONSTRAINT handyman_handoff_exchanges_actor_reference_length_check
          CHECK (
            actor_reference IS NULL
            OR char_length(actor_reference) BETWEEN 1 AND 128
          ),
        ADD CONSTRAINT handyman_handoff_exchanges_actor_coherence_check
          CHECK (
            (actor_type IS NULL AND care_actor_id IS NULL AND actor_reference IS NULL)
            OR (
              actor_type = 'CUSTOMER_CARE'
              AND care_actor_id IS NOT NULL
              AND actor_reference IS NOT NULL
            )
          )
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE handyman_handoff_exchanges
        DROP CONSTRAINT IF EXISTS handyman_handoff_exchanges_actor_coherence_check,
        DROP CONSTRAINT IF EXISTS handyman_handoff_exchanges_actor_reference_length_check,
        DROP CONSTRAINT IF EXISTS handyman_handoff_exchanges_actor_type_check,
        DROP COLUMN IF EXISTS actor_reference,
        DROP COLUMN IF EXISTS care_actor_id,
        DROP COLUMN IF EXISTS actor_type
    `);
  },
};
