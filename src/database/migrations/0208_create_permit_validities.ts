import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-20G — Permit Validity.
 *
 * Validity rows bind to an approved BE-20C Application and retain each issued
 * validity period as history. Status is backend-controlled and lazily advanced
 * from PENDING → VALID → EXPIRED; REVOKED is terminal. Permit, Client,
 * Building, Contractor and approval context remain derived through existing
 * BE-20 records rather than copied.
 */
export const migration0208CreatePermitValidities: Migration = {
  id: '0208_create_permit_validities',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE permit_validities (
        id                    UUID PRIMARY KEY,
        permit_application_id UUID NOT NULL REFERENCES permit_applications (id),
        valid_from            TIMESTAMPTZ NOT NULL,
        valid_until           TIMESTAMPTZ NOT NULL,
        status                TEXT NOT NULL DEFAULT 'PENDING',
        activated_at          TIMESTAMPTZ,
        expired_at            TIMESTAMPTZ,
        revoked_at            TIMESTAMPTZ,
        revoked_by_user_id    UUID REFERENCES users (id),
        notes                 TEXT,
        revocation_notes      TEXT,
        created_by_user_id    UUID NOT NULL REFERENCES users (id),
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT permit_validity_range_check
          CHECK (valid_until > valid_from),
        CONSTRAINT permit_validity_status_check
          CHECK (status IN ('PENDING', 'VALID', 'EXPIRED', 'REVOKED')),
        CONSTRAINT permit_validity_state_check CHECK (
          (status = 'PENDING'
            AND activated_at IS NULL AND expired_at IS NULL
            AND revoked_at IS NULL AND revoked_by_user_id IS NULL)
          OR
          (status = 'VALID'
            AND activated_at IS NOT NULL AND expired_at IS NULL
            AND revoked_at IS NULL AND revoked_by_user_id IS NULL)
          OR
          (status = 'EXPIRED'
            AND activated_at IS NOT NULL AND expired_at IS NOT NULL
            AND revoked_at IS NULL AND revoked_by_user_id IS NULL)
          OR
          (status = 'REVOKED'
            AND expired_at IS NULL
            AND revoked_at IS NOT NULL AND revoked_by_user_id IS NOT NULL)
        )
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX permit_validity_open_unique
        ON permit_validities (permit_application_id)
        WHERE status IN ('PENDING', 'VALID');
      CREATE INDEX permit_validity_period_idx
        ON permit_validities (valid_from, valid_until);
      CREATE INDEX permit_validity_status_idx
        ON permit_validities (status, valid_until);
      CREATE INDEX permit_validity_application_idx
        ON permit_validities (permit_application_id, created_at DESC)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS permit_validities');
  },
};
