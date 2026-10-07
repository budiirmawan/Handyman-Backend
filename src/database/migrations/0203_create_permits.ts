import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-20A — shared Permit to Work foundation.
 *
 * One Permit table serves both Vendor Contractors and Tenant Contractors.
 * Every contractor resolves to the existing BE-06 Vendor master; a Tenant
 * Contractor additionally retains its BE-14I relationship reference. This
 * PART deliberately contains only identity, context, basic metadata, and the
 * minimal DRAFT/CANCELLED lifecycle. Application workflow, safety controls,
 * approvals, validity, workers, equipment, evidence, and work execution are
 * deferred to later BE-20 parts.
 */
export const migration0203CreatePermits: Migration = {
  id: '0203_create_permits',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE permits (
        id                                UUID PRIMARY KEY,
        client_id                         UUID NOT NULL REFERENCES clients (id),
        building_id                       UUID NOT NULL REFERENCES buildings (id),
        permit_number                     TEXT NOT NULL,
        permit_type                       TEXT NOT NULL,
        title                             TEXT NOT NULL,
        work_description                  TEXT NOT NULL,
        applicant_reference               TEXT,
        contractor_context_type           TEXT NOT NULL,
        contractor_vendor_id              UUID NOT NULL REFERENCES vendors (id),
        tenant_contractor_relationship_id UUID REFERENCES tenant_contractor_relationships (id),
        status                            TEXT NOT NULL DEFAULT 'DRAFT',
        requested_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_by_user_id                UUID NOT NULL REFERENCES users (id),
        cancelled_at                      TIMESTAMPTZ,
        cancelled_by_user_id              UUID REFERENCES users (id),
        created_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT permits_number_unique
          UNIQUE (client_id, permit_number),
        CONSTRAINT permits_contractor_context_type_check
          CHECK (contractor_context_type IN
            ('VENDOR_CONTRACTOR', 'TENANT_CONTRACTOR')),
        CONSTRAINT permits_contractor_context_check
          CHECK (
            (contractor_context_type = 'VENDOR_CONTRACTOR'
              AND tenant_contractor_relationship_id IS NULL)
            OR
            (contractor_context_type = 'TENANT_CONTRACTOR'
              AND tenant_contractor_relationship_id IS NOT NULL)
          ),
        CONSTRAINT permits_status_check
          CHECK (status IN ('DRAFT', 'CANCELLED')),
        CONSTRAINT permits_state_check
          CHECK (
            (status = 'DRAFT'
              AND cancelled_at IS NULL AND cancelled_by_user_id IS NULL)
            OR
            (status = 'CANCELLED'
              AND cancelled_at IS NOT NULL AND cancelled_by_user_id IS NOT NULL)
          )
      )
    `);

    await client.query(`
      CREATE INDEX permits_building_idx
        ON permits (building_id, status, requested_at DESC);
      CREATE INDEX permits_contractor_vendor_idx
        ON permits (contractor_vendor_id, status, requested_at DESC);
      CREATE INDEX permits_tenant_contractor_idx
        ON permits (tenant_contractor_relationship_id, requested_at DESC);
      CREATE INDEX permits_type_idx
        ON permits (permit_type, status, requested_at DESC)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS permits');
  },
};
