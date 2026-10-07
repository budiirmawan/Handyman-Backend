import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-06F — Vendor Workforce Binding.
 *
 * Binds an existing EXTERNAL Workforce Profile (BE-03C/BE-03H) to the
 * Vendor master registry (BE-06A):
 *
 *   Vendor → Vendor Workforce Binding → Workforce Profile
 *
 * This deliberately reuses the BE-03H external workforce foundation — the
 * person master remains `workforce_profiles`; NO second workforce/person
 * master is created here. The binding carries the vendor's own personnel
 * code, an ACTIVE/INACTIVE status, and an optional effective window.
 *
 * Creating a binding NEVER creates or modifies a User, Credential, Role,
 * Permission, User Building Access, Workforce Building Assignment, Shift,
 * Skill, or Supervisor row — nothing here touches those tables.
 *
 * Duplicate protection follows the BE-03H/BE-03G idiom — a *partial* unique
 * index over ACTIVE rows — so a profile holds one ACTIVE binding per Vendor
 * while deactivated history is preserved. The vendor's personnel code is
 * additionally unique within the Vendor (the BE-03H personnel-code rule,
 * applied to the Vendor registry).
 *
 * Cross-table rules the FKs cannot express live in the service layer:
 *   - the Workforce Profile must be of type EXTERNAL,
 *   - the Vendor and the Workforce Profile must resolve to the same Client
 *     (vendor → client vs. profile → organization → client),
 *   - an INACTIVE Vendor receives no new ACTIVE binding,
 *   - an INACTIVE Workforce Profile receives no new ACTIVE binding.
 */
export const migration0060CreateVendorWorkforceBindings: Migration = {
  id: '0060_create_vendor_workforce_bindings',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE vendor_workforce_bindings (
        id                    UUID PRIMARY KEY,
        vendor_id             UUID NOT NULL,
        workforce_profile_id  UUID NOT NULL,
        vendor_personnel_code TEXT NOT NULL,
        effective_from        TIMESTAMPTZ,
        effective_until       TIMESTAMPTZ,
        status                TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT vendor_workforce_bindings_vendor_id_fkey
          FOREIGN KEY (vendor_id) REFERENCES vendors (id),
        CONSTRAINT vendor_workforce_bindings_workforce_profile_id_fkey
          FOREIGN KEY (workforce_profile_id) REFERENCES workforce_profiles (id),
        CONSTRAINT vendor_workforce_bindings_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT vendor_workforce_bindings_effective_range_check
          CHECK (
            effective_from IS NULL
            OR effective_until IS NULL
            OR effective_until >= effective_from
          ),
        CONSTRAINT vendor_workforce_bindings_personnel_code_unique
          UNIQUE (vendor_id, vendor_personnel_code)
      )
    `);

    // One ACTIVE binding per (vendor, profile); INACTIVE history is retained.
    await client.query(`
      CREATE UNIQUE INDEX vendor_workforce_bindings_active_unique
        ON vendor_workforce_bindings (vendor_id, workforce_profile_id)
        WHERE status = 'ACTIVE'
    `);

    await client.query(`
      CREATE INDEX vendor_workforce_bindings_vendor_id_idx
        ON vendor_workforce_bindings (vendor_id)
    `);
    await client.query(`
      CREATE INDEX vendor_workforce_bindings_workforce_profile_id_idx
        ON vendor_workforce_bindings (workforce_profile_id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS vendor_workforce_bindings');
  },
};
