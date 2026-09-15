import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-06E — Vendor Service Scope & Capability.
 *
 * Records what services a Vendor is qualified or intended to provide:
 *
 *   Vendor → Vendor Capability
 *
 * Examples (ELECTRICAL, MECHANICAL, HVAC, LIFT, FIRE_PROTECTION, PLUMBING,
 * SECURITY, HOUSEKEEPING) remain DATA — rows created per Vendor — never
 * hardcoded business logic. A Vendor may hold many capabilities.
 *
 * `code` is the stable machine-readable identifier, unique per Vendor
 * (`vendor_id + code`), following the Client-scoped-code idiom one level
 * down the chain.
 *
 * `vendor_building_relationship_id` optionally narrows a capability to one
 * existing Vendor ↔ Building relationship (BE-06D). It REFERENCES that
 * relationship rather than carrying its own `building_id`, so the
 * relationship is never duplicated: deactivating the relationship
 * de-scopes every capability pointing at it without touching these rows.
 * NULL means the capability applies vendor-wide.
 *
 * This table is a capability CATALOG only — it is NOT a workforce binding,
 * compliance document, license, certification, Work Order, service
 * execution, or maintenance workflow.
 */
export const migration0059CreateVendorCapabilities: Migration = {
  id: '0059_create_vendor_capabilities',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE vendor_capabilities (
        id                              UUID PRIMARY KEY,
        vendor_id                       UUID NOT NULL,
        code                            TEXT NOT NULL,
        name                            TEXT NOT NULL,
        description                     TEXT,
        vendor_building_relationship_id UUID,
        status                          TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT vendor_capabilities_vendor_id_fkey
          FOREIGN KEY (vendor_id) REFERENCES vendors (id),
        CONSTRAINT vendor_capabilities_relationship_fkey
          FOREIGN KEY (vendor_building_relationship_id)
          REFERENCES vendor_building_relationships (id),
        CONSTRAINT vendor_capabilities_vendor_code_unique
          UNIQUE (vendor_id, code),
        CONSTRAINT vendor_capabilities_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    await client.query(`
      CREATE INDEX vendor_capabilities_vendor_id_idx
        ON vendor_capabilities (vendor_id)
    `);
    await client.query(`
      CREATE INDEX vendor_capabilities_relationship_idx
        ON vendor_capabilities (vendor_building_relationship_id)
    `);
    await client.query(`
      CREATE INDEX vendor_capabilities_status_idx
        ON vendor_capabilities (status)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS vendor_capabilities');
  },
};
