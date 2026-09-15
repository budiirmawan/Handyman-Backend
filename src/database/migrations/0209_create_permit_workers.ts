import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-20H — Permit Worker List.
 *
 * A worker entry binds one existing BE-06F Vendor Workforce relationship to a
 * Permit Application. Person identity/name and vendor identification remain
 * authoritative in workforce_profiles/vendor_workforce_bindings; this table
 * stores only Permit-specific role, validity window and lifecycle history.
 */
export const migration0209CreatePermitWorkers: Migration = {
  id: '0209_create_permit_workers',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE permit_workers (
        id                          UUID PRIMARY KEY,
        permit_application_id       UUID NOT NULL REFERENCES permit_applications (id),
        vendor_workforce_binding_id UUID NOT NULL REFERENCES vendor_workforce_bindings (id),
        role_trade                  TEXT NOT NULL,
        status                      TEXT NOT NULL DEFAULT 'ACTIVE',
        valid_from                  TIMESTAMPTZ NOT NULL,
        valid_until                 TIMESTAMPTZ NOT NULL,
        notes                       TEXT,
        created_by_user_id          UUID NOT NULL REFERENCES users (id),
        updated_by_user_id          UUID NOT NULL REFERENCES users (id),
        deactivated_at              TIMESTAMPTZ,
        deactivated_by_user_id      UUID REFERENCES users (id),
        created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT permit_worker_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT permit_worker_validity_check
          CHECK (valid_until > valid_from),
        CONSTRAINT permit_worker_state_check CHECK (
          (status = 'ACTIVE'
            AND deactivated_at IS NULL AND deactivated_by_user_id IS NULL)
          OR
          (status = 'INACTIVE'
            AND deactivated_at IS NOT NULL AND deactivated_by_user_id IS NOT NULL)
        )
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX permit_worker_active_unique
        ON permit_workers
          (permit_application_id, vendor_workforce_binding_id)
        WHERE status = 'ACTIVE';
      CREATE INDEX permit_worker_application_idx
        ON permit_workers (permit_application_id, status, valid_from);
      CREATE INDEX permit_worker_binding_idx
        ON permit_workers (vendor_workforce_binding_id, status)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS permit_workers');
  },
};
