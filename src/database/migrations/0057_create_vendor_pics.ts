import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-06C — Vendor PIC (person in charge / contact person) foundation.
 *
 * A Vendor PIC is CONTACT DATA belonging to one Vendor (Vendor → Vendor PIC).
 * A Vendor may hold multiple PICs; at most one of them is the primary
 * contact. Creating a PIC NEVER creates or modifies a User, Credential,
 * Role, Permission, or Workforce Profile — there is deliberately no
 * reference to any identity table here.
 *
 * Primary-PIC control follows the partial-unique-index idiom (BE-03D2/
 * BE-03H): at most one `is_primary` row per Vendor, enforced by the
 * database. The service layer keeps the flag consistent (promoting a new
 * primary demotes the old one; a primary PIC must be ACTIVE).
 *
 * Client isolation is inherited through the Vendor (PIC → Vendor → Client),
 * matching how Buildings inherit isolation through Properties.
 */
export const migration0057CreateVendorPics: Migration = {
  id: '0057_create_vendor_pics',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE vendor_pics (
        id         UUID PRIMARY KEY,
        vendor_id  UUID NOT NULL,
        name       TEXT NOT NULL,
        position   TEXT,
        email      TEXT,
        phone      TEXT,
        is_primary BOOLEAN NOT NULL DEFAULT FALSE,
        status     TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT vendor_pics_vendor_id_fkey
          FOREIGN KEY (vendor_id) REFERENCES vendors (id),
        CONSTRAINT vendor_pics_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    await client.query(
      `CREATE INDEX vendor_pics_vendor_id_idx ON vendor_pics (vendor_id)`,
    );
    await client.query(
      `CREATE INDEX vendor_pics_status_idx ON vendor_pics (status)`,
    );
    await client.query(
      `CREATE UNIQUE INDEX vendor_pics_primary_unique
         ON vendor_pics (vendor_id)
         WHERE is_primary`,
    );
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS vendor_pics');
  },
};
