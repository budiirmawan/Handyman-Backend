import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-13A — Visitor Identity / Registration foundation.
 *
 * The `visitors` table is the single shared Visitor identity master for
 * the whole BE-13 Front Desk domain. Invitation, Walk-In, Contractor and
 * Delivery/Courier flows all reference the SAME visitor identity row —
 * no per-flow visitor master is ever created.
 *
 * Scope: Client-scoped. A visitor identity is a person-level master
 * reference reusable across every Building of the same Client; the
 * operational Visit records (later BE-13 PARTs) are Building-scoped and
 * point back to this identity.
 *
 * Data minimization: only operationally necessary identity data is
 * stored — full name, identity document type + reference number, phone,
 * email and organization. No birthdate, address, photo binaries or other
 * sensitive personal data (photo/OCR readiness arrives in BE-13E as safe
 * storage references only).
 *
 * Duplicate avoidance: an identity document reference is unique per
 * Client (`client_id + identity_type + identity_number`, enforced only
 * when an identity number is present).
 */
export const migration0133CreateVisitors: Migration = {
  id: '0133_create_visitors',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE visitors (
        id                  UUID PRIMARY KEY,
        client_id           UUID NOT NULL REFERENCES clients (id),
        full_name           TEXT NOT NULL,
        identity_type       TEXT NOT NULL DEFAULT 'NONE',
        identity_number     TEXT,
        phone               TEXT,
        email               TEXT,
        organization_name   TEXT,
        notes               TEXT,
        status              TEXT NOT NULL DEFAULT 'ACTIVE',
        created_by_user_id  UUID REFERENCES users (id),
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT visitors_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE', 'BLOCKED')),
        CONSTRAINT visitors_identity_type_check
          CHECK (identity_type IN (
            'NATIONAL_ID', 'PASSPORT', 'DRIVER_LICENSE',
            'EMPLOYEE_BADGE', 'OTHER', 'NONE'
          )),
        CONSTRAINT visitors_identity_number_requires_type
          CHECK (identity_number IS NULL OR identity_type <> 'NONE')
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX visitors_client_identity_unique
        ON visitors (client_id, identity_type, identity_number)
        WHERE identity_number IS NOT NULL;
      CREATE INDEX visitors_client_id_idx
        ON visitors (client_id, status);
      CREATE INDEX visitors_full_name_idx
        ON visitors (client_id, LOWER(full_name));
      CREATE INDEX visitors_phone_idx
        ON visitors (client_id, phone);
      CREATE INDEX visitors_email_idx
        ON visitors (client_id, LOWER(email));
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS visitors');
  },
};
