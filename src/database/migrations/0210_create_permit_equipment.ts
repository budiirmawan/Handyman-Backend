import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-20I — Permit Equipment List.
 *
 * Each row binds an existing BE-05 Asset (and optional Equipment Profile,
 * Identifier, Certification and BE-10B inspection references) to a Permit
 * Application. Equipment identity and compliance masters remain authoritative
 * in their existing tables; only Permit-specific validity/status is stored.
 */
export const migration0210CreatePermitEquipment: Migration = {
  id: '0210_create_permit_equipment',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE permit_equipment (
        id                      UUID PRIMARY KEY,
        permit_application_id   UUID NOT NULL REFERENCES permit_applications (id),
        asset_id                UUID NOT NULL REFERENCES assets (id),
        equipment_profile_id    UUID REFERENCES equipment_profiles (id),
        asset_identifier_id     UUID REFERENCES asset_identifiers (id),
        asset_certification_id  UUID REFERENCES asset_certifications (id),
        inspection_binding_id   UUID REFERENCES inspection_bindings (id),
        inspection_execution_id UUID REFERENCES checklist_executions (id),
        status                  TEXT NOT NULL DEFAULT 'ACTIVE',
        valid_from              TIMESTAMPTZ NOT NULL,
        valid_until             TIMESTAMPTZ NOT NULL,
        notes                   TEXT,
        created_by_user_id      UUID NOT NULL REFERENCES users (id),
        updated_by_user_id      UUID NOT NULL REFERENCES users (id),
        deactivated_at          TIMESTAMPTZ,
        deactivated_by_user_id  UUID REFERENCES users (id),
        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT permit_equipment_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT permit_equipment_validity_check
          CHECK (valid_until > valid_from),
        CONSTRAINT permit_equipment_state_check CHECK (
          (status = 'ACTIVE'
            AND deactivated_at IS NULL AND deactivated_by_user_id IS NULL)
          OR
          (status = 'INACTIVE'
            AND deactivated_at IS NOT NULL AND deactivated_by_user_id IS NOT NULL)
        )
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX permit_equipment_active_unique
        ON permit_equipment (permit_application_id, asset_id)
        WHERE status = 'ACTIVE';
      CREATE INDEX permit_equipment_application_idx
        ON permit_equipment (permit_application_id, status, valid_from);
      CREATE INDEX permit_equipment_asset_idx
        ON permit_equipment (asset_id, status);
      CREATE INDEX permit_equipment_certification_idx
        ON permit_equipment (asset_certification_id);
      CREATE INDEX permit_equipment_inspection_idx
        ON permit_equipment (inspection_execution_id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS permit_equipment');
  },
};
