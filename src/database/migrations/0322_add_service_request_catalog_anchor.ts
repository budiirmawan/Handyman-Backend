import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-SVC-01 PART 02 — Service Request Catalog Adoption.
 *
 * Adds a governed Service Catalog identity anchor to `service_requests`
 * (`docs/CR-BE-SVC-01_START_GOVERNANCE.md` §8). Purely additive adoption:
 *
 *   - `service_catalog_id` is NULLABLE. Existing / historical Service Requests
 *     keep working exactly as before (NULL anchor = free-text only).
 *   - The free-text `service_type` column is RETAINED, NOT NULL, unchanged.
 *     It is never rewritten, removed, renamed, or grammar-changed.
 *   - A composite Client-scoped FK `(service_catalog_id, client_id)`
 *     REFERENCES `service_catalog (id, client_id)` — the `0313`/`0319`
 *     scope-FK precedent — so a governed anchor proves Client scope
 *     structurally and a NULL anchor simply does not participate.
 *
 * The governed consistency rules (catalog same-Client + ACTIVE + code equals
 * the request's `service_type`) are enforced in the Service Request service
 * layer, never by a silent rewrite. No backfill, no inference, no auto-create.
 */
export const migration0322AddServiceRequestCatalogAnchor: Migration = {
  id: '0322_add_service_request_catalog_anchor',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE service_requests
        ADD COLUMN service_catalog_id UUID
    `);

    await client.query(`
      ALTER TABLE service_requests
        ADD CONSTRAINT service_requests_service_catalog_scope_fk
          FOREIGN KEY (service_catalog_id, client_id)
          REFERENCES service_catalog (id, client_id)
    `);

    await client.query(`
      CREATE INDEX service_requests_service_catalog_idx
        ON service_requests (service_catalog_id)
        WHERE service_catalog_id IS NOT NULL
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(
      `DROP INDEX IF EXISTS service_requests_service_catalog_idx`,
    );
    await client.query(
      `ALTER TABLE service_requests
         DROP CONSTRAINT IF EXISTS service_requests_service_catalog_scope_fk`,
    );
    await client.query(
      `ALTER TABLE service_requests DROP COLUMN IF EXISTS service_catalog_id`,
    );
  },
};
