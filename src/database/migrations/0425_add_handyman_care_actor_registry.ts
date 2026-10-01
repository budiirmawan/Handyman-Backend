import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-01 AMENDMENT 01 PART 07 — Customer Care actor persistence.
 *
 * Governance: docs/handyman/CR-HM-01_AMENDMENT_01_CUSTOMER_CARE_ACTOR_HANDOFF.md
 * (frozen D4–D8). Two additive, backward-compatible changes — nothing existing
 * is rewritten and nothing is backfilled:
 *
 * 1. `handyman_handoff_integrations` gains an actor-capability scope. Legacy
 *    rows default to 'NONE', so a pre-amendment integration keeps exactly the
 *    rights it had before (the right to assert no actor at all). It cannot
 *    assert a Customer Care actor until operations explicitly grant
 *    'CUSTOMER_CARE'.
 * 2. `handyman_handoff_care_actors` — the Customer Care operator registry.
 *    An actor is an operational identity INSIDE one BM integration
 *    (`(integration_id, actor_reference)` unique) with an ACTIVE/INACTIVE
 *    lifecycle. The table intentionally stores NO local-user, Tenant PIC,
 *    tenant-company, session or RBAC linkage: actor identity stays separate
 *    from the represented tenant (D4), and represented context travels per
 *    assertion and is resolved server-side by the unchanged PART 02 rules.
 *    There is no delete lifecycle: deactivation is the terminal operation, so
 *    provenance can never be destroyed.
 */
export const migration0425AddHandymanCareActorRegistry: Migration = {
  id: '0425_add_handyman_care_actor_registry',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE handyman_handoff_integrations
        ADD COLUMN actor_capability TEXT NOT NULL DEFAULT 'NONE',
        ADD CONSTRAINT handyman_handoff_integrations_actor_capability_check
          CHECK (actor_capability IN ('NONE', 'CUSTOMER_CARE'))
    `);

    await client.query(`
      CREATE TABLE handyman_handoff_care_actors (
        id               UUID PRIMARY KEY,
        integration_id   UUID NOT NULL REFERENCES handyman_handoff_integrations (id),
        actor_reference  TEXT NOT NULL,
        display_name     TEXT NOT NULL,
        status           TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT handyman_handoff_care_actors_reference_unique
          UNIQUE (integration_id, actor_reference),
        CONSTRAINT handyman_handoff_care_actors_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT handyman_handoff_care_actors_reference_length_check
          CHECK (char_length(actor_reference) BETWEEN 1 AND 128),
        CONSTRAINT handyman_handoff_care_actors_display_name_length_check
          CHECK (char_length(display_name) BETWEEN 1 AND 160)
      )
    `);

    await client.query(`
      CREATE INDEX handyman_handoff_care_actors_integration_status_idx
        ON handyman_handoff_care_actors (integration_id, status)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS handyman_handoff_care_actors');
    await client.query(`
      ALTER TABLE handyman_handoff_integrations
        DROP CONSTRAINT IF EXISTS handyman_handoff_integrations_actor_capability_check,
        DROP COLUMN IF EXISTS actor_capability
    `);
  },
};
