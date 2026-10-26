import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-CARE-CATALOG-DOCUMENT-01 — allow Care-authored structured request
 * items to retain their non-User actor provenance through the parent request
 * attribution, and persist item-scoped unit and complaint facts. Existing
 * item writers continue to set created_by_user_id; this only permits the
 * already-supported Customer Care actor path to leave it NULL.
 */
export const migration0484HandymanCareStructuredRequestItems: Migration = {
  id: '0484_handyman_care_structured_request_items',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE handyman_service_request_items
        ALTER COLUMN created_by_user_id DROP NOT NULL,
        ADD COLUMN uom_id UUID REFERENCES units_of_measure (id),
        ADD COLUMN item_description TEXT,
        ADD CONSTRAINT handyman_service_request_items_description_check
          CHECK (item_description IS NULL OR
            length(btrim(item_description)) BETWEEN 1 AND 1000)
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM handyman_service_request_items WHERE created_by_user_id IS NULL) THEN
          RAISE EXCEPTION 'Cannot roll back Care-authored request-item provenance while it exists'
            USING ERRCODE = '23514';
        END IF;
      END $$;
      ALTER TABLE handyman_service_request_items
        DROP CONSTRAINT IF EXISTS handyman_service_request_items_description_check,
        DROP COLUMN IF EXISTS item_description,
        DROP COLUMN IF EXISTS uom_id,
        ALTER COLUMN created_by_user_id SET NOT NULL
    `);
  },
};
