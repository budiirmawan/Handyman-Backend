import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-SERVICE-CATALOG-01 PART 03 — the provenance of an inherited
 * request-item attribute.
 *
 * PART 02 completed the ADMINISTRATION of the variant choices
 * (`handyman_service_variant_attributes`), but the choices were still
 * decorative: a request item carried only the attribute values the caller
 * typed, so a variant that configured "1.5 PK, inverter" never reached the
 * price resolution.
 *
 * PART 03 makes the inheritance MATERIAL. The effective attribute set of an
 * item is written ONCE, on the item row, when the item is authored (or when
 * its variant is re-selected). This is what makes the inheritance
 * deterministic AND snapshot-safe:
 *
 *   - the price resolution and the quotation snapshot read the SAME values
 *     that were inherited (no second source of truth at quote time);
 *   - a later change of the variant can never rewrite an item that already
 *     exists, so it can never rewrite an issued quotation.
 *
 * To be able to recompute the effective set on a governed correction, the
 * item must remember WHICH values came from the variant. That provenance is
 * the only thing this migration adds:
 *
 *   handyman_service_request_items.inherited_attribute_values JSONB
 *     - the attribute values that the variant supplied;
 *     - '{}' for an item without a variant, or for an item whose values are
 *       all the caller's own;
 *     - a JSON object, never a scalar and never an array.
 *
 * `attribute_values` keeps its meaning: the EFFECTIVE set (inherited values
 * plus the caller's own values). No other table, column or engine changes.
 */
export const migration0480HandymanServiceRequestItemInheritedAttributes: Migration = {
  id: '0480_handyman_service_request_item_inherited_attributes',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE handyman_service_request_items
        ADD COLUMN inherited_attribute_values JSONB NOT NULL DEFAULT '{}'::jsonb
    `);
    await client.query(`
      ALTER TABLE handyman_service_request_items
        ADD CONSTRAINT handyman_service_request_items_inherited_attributes_check
          CHECK (jsonb_typeof(inherited_attribute_values) = 'object')
    `);
    await client.query(`
      CREATE INDEX handyman_service_request_items_inherited_idx
        ON handyman_service_request_items
          (client_id, handyman_request_id)
        WHERE inherited_attribute_values <> '{}'::jsonb
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(
      'DROP INDEX IF EXISTS handyman_service_request_items_inherited_idx',
    );
    await client.query(`
      ALTER TABLE handyman_service_request_items
        DROP CONSTRAINT IF EXISTS handyman_service_request_items_inherited_attributes_check
    `);
    await client.query(`
      ALTER TABLE handyman_service_request_items
        DROP COLUMN IF EXISTS inherited_attribute_values
    `);
  },
};
