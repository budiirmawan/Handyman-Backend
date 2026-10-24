import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-SERVICE-CATALOG-01 PART 02 — variant-attribute lifecycle and the
 * access-complexity vocabulary.
 *
 * PART 01 created `handyman_service_variant_attributes` as the table that
 * makes a variant "configurable" (a variant carries the configured value of
 * a service attribute), and created it WITHOUT a lifecycle: a row could be
 * written but never retired, so an administrator had no governed way to stop
 * a stale variant choice from being administered. PART 02 gives that table
 * the SAME lifecycle vocabulary the rest of the catalogue already uses
 * (`ACTIVE` / `INACTIVE`) plus the deactivation audit columns.
 *
 * The second change is the ACCESS-COMPLEXITY vocabulary of the request item:
 * `SPECIAL_EQUIPMENT` joins `STANDARD`, `DIFFICULT`, `HIGH_FLOOR` and
 * `RESTRICTED`. A job that needs special equipment (a roof-crane lift, a
 * boom lift, a scaffold) is an access-complexity fact exactly like a high
 * ceiling or a difficult outdoor unit, and the price dimension that governs
 * it (PART 02 pricing) must be able to name it.
 *
 * Nothing here adds an amount, a price, a price rule, a quotation or a
 * lifecycle of its own. The amount authority stays `price_catalog_entries`
 * and the access complexity is priced by a governed price TIER that the
 * administrator authors in that authority — never by a computed surcharge.
 */
export const migration0479HandymanServiceVariantAttributeLifecycle: Migration = {
  id: '0479_handyman_service_variant_attribute_lifecycle',

  async up(client: PoolClient): Promise<void> {
    // ------------------------------------------------------------------
    // Variant attribute lifecycle.
    // ------------------------------------------------------------------
    await client.query(`
      ALTER TABLE handyman_service_variant_attributes
        ADD COLUMN status TEXT NOT NULL DEFAULT 'ACTIVE'
    `);
    await client.query(`
      ALTER TABLE handyman_service_variant_attributes
        ADD COLUMN deactivated_at TIMESTAMPTZ
    `);
    await client.query(`
      ALTER TABLE handyman_service_variant_attributes
        ADD COLUMN deactivated_by_user_id UUID REFERENCES users (id)
    `);
    await client.query(`
      ALTER TABLE handyman_service_variant_attributes
        ADD CONSTRAINT handyman_service_variant_attributes_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
    `);
    // A retired choice always records WHO retired it and WHEN; an ACTIVE
    // choice never carries a deactivation stamp. This is what makes the
    // retirement auditable instead of a silent UPDATE.
    await client.query(`
      ALTER TABLE handyman_service_variant_attributes
        ADD CONSTRAINT handyman_service_variant_attributes_deactivation_check
          CHECK (
            (status = 'ACTIVE'
              AND deactivated_at IS NULL
              AND deactivated_by_user_id IS NULL)
            OR
            (status = 'INACTIVE'
              AND deactivated_at IS NOT NULL
              AND deactivated_by_user_id IS NOT NULL)
          )
    `);
    await client.query(`
      CREATE INDEX handyman_service_variant_attributes_client_status_idx
        ON handyman_service_variant_attributes
          (client_id, status, service_variant_id)
    `);

    // ------------------------------------------------------------------
    // Access complexity vocabulary.
    // ------------------------------------------------------------------
    await client.query(`
      ALTER TABLE handyman_service_request_items
        DROP CONSTRAINT handyman_service_request_items_access_check
    `);
    await client.query(`
      ALTER TABLE handyman_service_request_items
        ADD CONSTRAINT handyman_service_request_items_access_check
          CHECK (access_condition IN
            ('STANDARD', 'DIFFICULT', 'HIGH_FLOOR', 'RESTRICTED',
             'SPECIAL_EQUIPMENT'))
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP INDEX IF EXISTS handyman_service_variant_attributes_client_status_idx
    `);
    await client.query(`
      ALTER TABLE handyman_service_request_items
        DROP CONSTRAINT IF EXISTS handyman_service_request_items_access_check
    `);
    await client.query(`
      ALTER TABLE handyman_service_request_items
        ADD CONSTRAINT handyman_service_request_items_access_check
          CHECK (access_condition IN
            ('STANDARD', 'DIFFICULT', 'HIGH_FLOOR', 'RESTRICTED'))
    `);
    await client.query(`
      ALTER TABLE handyman_service_variant_attributes
        DROP CONSTRAINT IF EXISTS handyman_service_variant_attributes_deactivation_check
    `);
    await client.query(`
      ALTER TABLE handyman_service_variant_attributes
        DROP CONSTRAINT IF EXISTS handyman_service_variant_attributes_status_check
    `);
    await client.query(`
      ALTER TABLE handyman_service_variant_attributes
        DROP COLUMN IF EXISTS deactivated_by_user_id
    `);
    await client.query(`
      ALTER TABLE handyman_service_variant_attributes
        DROP COLUMN IF EXISTS deactivated_at
    `);
    await client.query(`
      ALTER TABLE handyman_service_variant_attributes
        DROP COLUMN IF EXISTS status
    `);
  },
};
