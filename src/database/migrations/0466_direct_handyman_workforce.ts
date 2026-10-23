import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-WORKER-COMPETENCY-01 PART 03B2D — Direct Handyman Workforce.
 *
 * BUSINESS CORRECTION. Handyman is a direct service provider: Customer Care and
 * Operations are part of Handyman's own organization, and the field workers
 * (permanent, contract, or freelance) are managed by Handyman Operations.
 * Freelance status alone must never force the creation of a vendor company.
 *
 * Before this migration the only way to reach the Handyman assignment
 * authority was through `handyman_provider_contexts.vendor_id` (NOT NULL), so a
 * freelance worker needed: a `vendors` row → a provider context → an
 * `vendor_workforce_bindings` row → a worker context → a crew. That chain is
 * preserved unchanged as the LEGACY/VENDOR path (it is still a legitimate data
 * relation for real subcontractors and must not be removed), but it is no
 * longer the only one.
 *
 * What this migration adds (additive, backward compatible):
 *
 *   1. `handyman_provider_contexts.provider_type` — VENDOR | DIRECT.
 *      Existing rows default to VENDOR, so every pre-existing provider context,
 *      crew and assignment keeps exactly its current meaning.
 *   2. `handyman_provider_contexts.vendor_id` becomes NULLABLE with an identity
 *      CHECK: a VENDOR context must name its vendor, a DIRECT context must not
 *      name one (never a fake vendor row).
 *   3. A partial UNIQUE index keeps exactly ONE DIRECT context per Client: the
 *      Client's own workforce pool (`client_id` is the tenant root, unchanged).
 *      The existing `UNIQUE (vendor_id)` still allows many NULLs, so it keeps
 *      proving "one context per real vendor" without blocking DIRECT rows.
 *   4. `workforce_profiles.workforce_type` gains FREELANCE — the third field
 *      worker kind named by the business rule (permanent INTERNAL, CONTRACT,
 *      FREELANCE), so freelance is expressed as a workforce type instead of a
 *      vendor workaround.
 *
 * No table is created, no row is rewritten, and no vendor data is touched.
 */
export const migration0466DirectHandymanWorkforce: Migration = {
  id: '0466_direct_handyman_workforce',

  async up(client: PoolClient): Promise<void> {
    // 1. Provider context kind.
    await client.query(`
      ALTER TABLE handyman_provider_contexts
        ADD COLUMN provider_type TEXT NOT NULL DEFAULT 'VENDOR'
    `);
    await client.query(`
      ALTER TABLE handyman_provider_contexts
        ADD CONSTRAINT handyman_provider_contexts_type_check
          CHECK (provider_type IN ('VENDOR', 'DIRECT'))
    `);

    // 2. A DIRECT context carries no vendor; a VENDOR context must carry one.
    await client.query(`
      ALTER TABLE handyman_provider_contexts
        ALTER COLUMN vendor_id DROP NOT NULL
    `);
    await client.query(`
      ALTER TABLE handyman_provider_contexts
        ADD CONSTRAINT handyman_provider_contexts_identity_check
          CHECK (
            (provider_type = 'VENDOR' AND vendor_id IS NOT NULL)
            OR (provider_type = 'DIRECT' AND vendor_id IS NULL)
          )
    `);

    // 3. Exactly one direct workforce pool per Client.
    await client.query(`
      CREATE UNIQUE INDEX handyman_provider_contexts_direct_client_unique
        ON handyman_provider_contexts (client_id)
        WHERE provider_type = 'DIRECT'
    `);

    // 4. Freelance is a workforce type, not a vendor.
    await client.query(`
      ALTER TABLE workforce_profiles
        DROP CONSTRAINT workforce_profiles_workforce_type_check
    `);
    await client.query(`
      ALTER TABLE workforce_profiles
        ADD CONSTRAINT workforce_profiles_workforce_type_check
          CHECK (
            workforce_type IN (
              'INTERNAL', 'OUTSOURCED', 'CONTRACT', 'EXTERNAL', 'FREELANCE'
            )
          )
    `);
  },

  async down(client: PoolClient): Promise<void> {
    // Direct provider contexts cannot be represented by the old schema, so the
    // rollback refuses to guess instead of silently deleting workforce data.
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM handyman_provider_contexts
           WHERE provider_type = 'DIRECT'
        ) THEN
          RAISE EXCEPTION
            'cannot roll back 0466: DIRECT handyman provider contexts exist';
        END IF;
      END $$;
    `);

    await client.query(`
      ALTER TABLE workforce_profiles
        DROP CONSTRAINT workforce_profiles_workforce_type_check
    `);
    await client.query(`
      ALTER TABLE workforce_profiles
        ADD CONSTRAINT workforce_profiles_workforce_type_check
          CHECK (workforce_type IN ('INTERNAL', 'OUTSOURCED', 'CONTRACT', 'EXTERNAL'))
    `);

    await client.query(
      'DROP INDEX IF EXISTS handyman_provider_contexts_direct_client_unique',
    );
    await client.query(`
      ALTER TABLE handyman_provider_contexts
        DROP CONSTRAINT IF EXISTS handyman_provider_contexts_identity_check
    `);
    // The pre-existing `handyman_provider_contexts_vendor_fkey` and
    // `handyman_provider_contexts_vendor_unique` constraints were never
    // dropped, so the old shape returns as soon as the nullable column is
    // NOT NULL again.
    await client.query(`
      ALTER TABLE handyman_provider_contexts
        ALTER COLUMN vendor_id SET NOT NULL
    `);
    await client.query(`
      ALTER TABLE handyman_provider_contexts
        DROP CONSTRAINT IF EXISTS handyman_provider_contexts_type_check
    `);
    await client.query(`
      ALTER TABLE handyman_provider_contexts
        DROP COLUMN IF EXISTS provider_type
    `);
  },
};
