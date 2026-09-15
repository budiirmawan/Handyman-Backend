import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-SVC-01 PART 03 — Vendor Capability Service Identity Adoption.
 *
 * Adopts the governed Service Catalog identity into Vendor capabilities and
 * Vendor Selection Readiness (`docs/CR-BE-SVC-01_START_GOVERNANCE.md` §7).
 * Purely additive adoption:
 *
 *   - `vendor_capabilities.service_catalog_id` is NULLABLE. Legacy
 *     capabilities keep working exactly as before (NULL link = code-only).
 *     The existing `code` column is retained, NOT NULL, unchanged — never
 *     removed, renamed, or rewritten.
 *   - `vendor_capabilities` carries no `client_id` (Client is derived through
 *     the Vendor), so the link uses a plain FK to `service_catalog(id)` and
 *     Client scope (catalog belongs to the Vendor's Client) is enforced in
 *     the service layer — consistent with how the module already validates
 *     Vendor relationships.
 *   - `vendor_selection_readiness.service_catalog_id` snapshots the request's
 *     governed demand identity at evaluation time (paralleling the existing
 *     `service_type` snapshot). This table DOES carry `client_id`, so the
 *     composite scope-FK precedent (`0313`/`0319`/`0322`) applies.
 *
 * The governed matching rule (governed-ID-only when both sides are governed)
 * is implemented in the Vendor Selection Readiness service. No backfill, no
 * auto-linking, no code rewriting.
 */
export const migration0323AddVendorCapabilityServiceIdentity: Migration = {
  id: '0323_add_vendor_capability_service_identity',

  async up(client: PoolClient): Promise<void> {
    // --- vendor_capabilities: governed service identity link (plain FK) ---
    await client.query(`
      ALTER TABLE vendor_capabilities
        ADD COLUMN service_catalog_id UUID REFERENCES service_catalog (id)
    `);

    await client.query(`
      CREATE INDEX vendor_capabilities_service_catalog_idx
        ON vendor_capabilities (service_catalog_id)
        WHERE service_catalog_id IS NOT NULL
    `);

    // --- vendor_selection_readiness: governed demand identity snapshot ---
    await client.query(`
      ALTER TABLE vendor_selection_readiness
        ADD COLUMN service_catalog_id UUID
    `);

    await client.query(`
      ALTER TABLE vendor_selection_readiness
        ADD CONSTRAINT vendor_selection_readiness_service_catalog_scope_fk
          FOREIGN KEY (service_catalog_id, client_id)
          REFERENCES service_catalog (id, client_id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(
      `ALTER TABLE vendor_selection_readiness
         DROP CONSTRAINT IF EXISTS vendor_selection_readiness_service_catalog_scope_fk`,
    );
    await client.query(
      `ALTER TABLE vendor_selection_readiness
         DROP COLUMN IF EXISTS service_catalog_id`,
    );
    await client.query(
      `DROP INDEX IF EXISTS vendor_capabilities_service_catalog_idx`,
    );
    await client.query(
      `ALTER TABLE vendor_capabilities
         DROP COLUMN IF EXISTS service_catalog_id`,
    );
  },
};
