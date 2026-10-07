import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-06D — Vendor ↔ Building relationship.
 *
 * Records which Buildings a Vendor serves:
 *
 *   Vendor → Vendor Building Relationship → Building
 *
 * One Vendor may serve several Buildings and one Building may be served by
 * several Vendors (many-to-many through this table). The relationship is
 * master data only — it is NOT a service scope, workforce binding,
 * compliance document, certification, Work Order, or maintenance workflow.
 *
 * `effective_from` / `effective_until` are optional: a relationship with no
 * window is undated and stands until deactivated. The CHECK enforces
 * from <= until whenever both are present.
 *
 * Duplicate protection follows the BE-03G idiom — a *partial* unique index
 * over ACTIVE rows — so a Vendor holds a given Building at most once at a
 * time while deactivated history is preserved.
 *
 * Cross-table rules the FKs cannot express — the Vendor and the Building
 * must resolve to the same Client (vendor → client vs. building → property →
 * client), the Building must be ACTIVE, and an INACTIVE Vendor receives no
 * new ACTIVE relationship — live in the service layer.
 */
export const migration0058CreateVendorBuildingRelationships: Migration = {
  id: '0058_create_vendor_building_relationships',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE vendor_building_relationships (
        id              UUID PRIMARY KEY,
        vendor_id       UUID NOT NULL,
        building_id     UUID NOT NULL,
        effective_from  TIMESTAMPTZ,
        effective_until TIMESTAMPTZ,
        status          TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT vendor_building_relationships_vendor_id_fkey
          FOREIGN KEY (vendor_id) REFERENCES vendors (id),
        CONSTRAINT vendor_building_relationships_building_id_fkey
          FOREIGN KEY (building_id) REFERENCES buildings (id),
        CONSTRAINT vendor_building_relationships_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT vendor_building_relationships_effective_range_check
          CHECK (
            effective_from IS NULL
            OR effective_until IS NULL
            OR effective_until >= effective_from
          )
      )
    `);

    // One ACTIVE relationship per (vendor, building); INACTIVE history is
    // retained, and a Vendor may still serve several different Buildings.
    await client.query(`
      CREATE UNIQUE INDEX vendor_building_relationships_active_unique
        ON vendor_building_relationships (vendor_id, building_id)
        WHERE status = 'ACTIVE'
    `);

    await client.query(`
      CREATE INDEX vendor_building_relationships_vendor_id_idx
        ON vendor_building_relationships (vendor_id)
    `);
    await client.query(`
      CREATE INDEX vendor_building_relationships_building_id_idx
        ON vendor_building_relationships (building_id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS vendor_building_relationships');
  },
};
