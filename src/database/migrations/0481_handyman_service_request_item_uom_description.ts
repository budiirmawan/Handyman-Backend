import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-BE-CARE-CATALOG-STRUCTURED-01 PART 01 — reported UOM and
 * per-item description on a mixed request item.
 *
 * The parameterized catalogue (0477/0480) already persists the STRUCTURED
 * facts of one request line: service, variant, quantity, the effective
 * attribute set and its inherited provenance, and the access condition.
 * Two reported facts had nowhere to live:
 *
 *   handyman_service_request_items.uom_id UUID NULL
 *     - the unit of measure the CARE/tenant REPORTED for the quantity
 *       (e.g. "2 UNIT", "40 METER"); an ordinary nullable reference to the
 *       EXISTING `units_of_measure` master (0071) — no second UOM vocabulary;
 *     - the QUOTATION engine keeps its own governed UOM selection from the
 *       price basis (PART 01 pricing service); a reported uom_id is a work
 *       fact for intake/readback and never overrides the price fact.
 *
 *   handyman_service_request_items.item_description TEXT NULL
 *     - the bounded (1-1000, service-validated) free-text note of ONE item;
 *     - distinct from the request-level `description` (the overall problem
 *       statement) so multi-item intake never concatenates notes.
 *
 * Both columns are NULLABLE with no rewrite of existing rows: every current
 * item row keeps byte-identical semantics (uom unknown, no item note).
 * Client-scoped UOM membership is enforced by the service layer (same
 * `units_of_measure master of this client` idiom as the quotation line
 * engine); the plain FK here is a referential backstop only.
 */
export const migration0481HandymanServiceRequestItemUomDescription: Migration =
  {
    id: '0481_handyman_service_request_item_uom_description',

    async up(client: PoolClient): Promise<void> {
      await client.query(`
        ALTER TABLE handyman_service_request_items
          ADD COLUMN uom_id UUID REFERENCES units_of_measure (id),
          ADD COLUMN item_description TEXT
      `);
      await client.query(`
        ALTER TABLE handyman_service_request_items
          ADD CONSTRAINT handyman_service_request_items_item_description_check
            CHECK (
              item_description IS NULL
              OR char_length(item_description) BETWEEN 1 AND 1000
            )
      `);
    },

    async down(client: PoolClient): Promise<void> {
      await client.query(`
        ALTER TABLE handyman_service_request_items
          DROP CONSTRAINT IF EXISTS handyman_service_request_items_item_description_check
      `);
      await client.query(`
        ALTER TABLE handyman_service_request_items
          DROP COLUMN IF EXISTS item_description,
          DROP COLUMN IF EXISTS uom_id
      `);
    },
  };
