import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-01 AMENDMENT 01 PART 10 — immutable attribution actor provenance.
 *
 * Governance: docs/handyman/CR-HM-01_AMENDMENT_01_CUSTOMER_CARE_ACTOR_HANDOFF.md
 * (frozen D4/D8, §3.5).
 *
 * `handyman_channel_attributions` gains the nullable, server-derived Customer
 * Care actor provenance of the handoff that created it:
 *
 *   actor_type       — NULL for legacy handoffs; 'CUSTOMER_CARE' when attested
 *   care_actor_id    — FK to the PART 07 registry (never a users/tenant_pics id)
 *   actor_reference  — the attested, integration-scoped opaque reference
 *
 * Additive and backward compatible: pre-amendment rows keep NULL in all three
 * columns, the append-only contract is untouched (no new UPDATE/DELETE path),
 * and the represented context columns (tenant company/PIC, building, space)
 * keep their exact meaning — an attested actor ADDS the acting identity, it
 * never replaces or rewrites the represented customer.
 *
 * Two integrity guards are added at the storage layer:
 * 1. actor coherence — the three columns are all-or-nothing, so no attribution
 *    can carry a partial or fabricated actor identity;
 * 2. actor no-borrow — for an attested Customer Care attribution the acting
 *    `created_by_user_id` can never be the linked local user of the
 *    represented Tenant PIC (`tenant_pics.user_id`). The Customer Care actor
 *    is a distinct actor: it must not be recorded as the customer, and the
 *    customer must not be recorded as the acting user.
 */
export const migration0427HandymanAttributionActorProvenance: Migration = {
  id: '0427_handyman_attribution_actor_provenance',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE handyman_channel_attributions
        ADD COLUMN actor_type TEXT,
        ADD COLUMN care_actor_id UUID REFERENCES handyman_handoff_care_actors (id),
        ADD COLUMN actor_reference TEXT,
        ADD CONSTRAINT handyman_channel_attributions_actor_type_check
          CHECK (actor_type IS NULL OR actor_type IN ('CUSTOMER_CARE')),
        ADD CONSTRAINT handyman_channel_attributions_actor_reference_length_check
          CHECK (
            actor_reference IS NULL
            OR char_length(actor_reference) BETWEEN 1 AND 128
          ),
        ADD CONSTRAINT handyman_channel_attributions_actor_coherence_check
          CHECK (
            (actor_type IS NULL AND care_actor_id IS NULL AND actor_reference IS NULL)
            OR (
              actor_type = 'CUSTOMER_CARE'
              AND care_actor_id IS NOT NULL
              AND actor_reference IS NOT NULL
            )
          )
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_channel_attributions_actor_no_borrow()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $handyman_channel_attributions_actor_no_borrow$
      DECLARE
        pic_user_id UUID;
      BEGIN
        IF NEW.actor_type IS NOT NULL
           AND NEW.created_by_user_id IS NOT NULL
           AND NEW.tenant_pic_id IS NOT NULL THEN
          SELECT user_id INTO pic_user_id
            FROM tenant_pics WHERE id = NEW.tenant_pic_id;
          IF pic_user_id IS NOT NULL AND pic_user_id = NEW.created_by_user_id THEN
            RAISE EXCEPTION
              'handyman_channel_attributions must not record the represented customer user as the acting user of an attested Customer Care actor; % is not permitted.', TG_OP
              USING ERRCODE = '23514';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $handyman_channel_attributions_actor_no_borrow$;

      CREATE TRIGGER handyman_channel_attributions_actor_no_borrow
        BEFORE INSERT OR UPDATE ON handyman_channel_attributions
        FOR EACH ROW
        EXECUTE FUNCTION handyman_channel_attributions_actor_no_borrow();
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_channel_attributions_actor_no_borrow
        ON handyman_channel_attributions;
      DROP FUNCTION IF EXISTS handyman_channel_attributions_actor_no_borrow();
      ALTER TABLE handyman_channel_attributions
        DROP CONSTRAINT IF EXISTS handyman_channel_attributions_actor_coherence_check,
        DROP CONSTRAINT IF EXISTS handyman_channel_attributions_actor_reference_length_check,
        DROP CONSTRAINT IF EXISTS handyman_channel_attributions_actor_type_check,
        DROP COLUMN IF EXISTS actor_reference,
        DROP COLUMN IF EXISTS care_actor_id,
        DROP COLUMN IF EXISTS actor_type;
    `);
  },
};
