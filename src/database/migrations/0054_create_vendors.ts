import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-06A — Vendor Registry foundation.
 *
 * A Vendor is the core master record for an external organization / service
 * provider engaged by a Client (cleaning company, MEP contractor, security
 * provider, supplier, …). It is Client-scoped master data only:
 *
 *   Client → Vendor
 *
 * This PART deliberately carries NO classification, PIC, building
 * relationship, service scope, workforce binding, compliance document, or
 * license data — those are later BE-06 PARTs. It also carries no procurement,
 * billing, or operational workflow.
 *
 * `vendor_code` is the stable machine-readable identifier, normalized to
 * uppercase by the service layer, unique per Client (`client_id +
 * vendor_code`) following the BE-02D `properties` idiom. Inactive Vendors are
 * preserved for history — never hard-deleted through normal lifecycle
 * handling.
 *
 * Note: the BE-03H `external_organizations` table remains the minimal
 * reference used by external workforce affiliation; the Vendor registry is
 * the full master record. BE-06F will bind Vendor workforce explicitly.
 */
export const migration0054CreateVendors: Migration = {
  id: '0054_create_vendors',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE vendors (
        id                  UUID PRIMARY KEY,
        client_id           UUID NOT NULL,
        vendor_code         TEXT NOT NULL,
        vendor_name         TEXT NOT NULL,
        legal_name          TEXT,
        registration_number TEXT,
        tax_number          TEXT,
        email               TEXT,
        phone               TEXT,
        address             TEXT,
        status              TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT vendors_client_id_fkey
          FOREIGN KEY (client_id) REFERENCES clients (id),
        CONSTRAINT vendors_client_vendor_code_unique
          UNIQUE (client_id, vendor_code),
        CONSTRAINT vendors_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    await client.query(
      `CREATE INDEX vendors_client_id_idx ON vendors (client_id)`,
    );
    await client.query(
      `CREATE INDEX vendors_status_idx ON vendors (status)`,
    );
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS vendors');
  },
};
