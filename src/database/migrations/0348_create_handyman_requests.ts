import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-BE-01 RUN 1 — Handyman Request foundation.
 *
 * Establishes the dedicated `handyman_requests` aggregate for the Handyman
 * Apartment bounded context:
 * - Created by an authenticated Tenant Relation user on the BM Super App
 *   operational surface (`created_by_user_id`, `operational_surface`).
 * - Explicit customer/resident snapshot identity (`customer_name`,
 *   `customer_phone`, `customer_email`), distinct from the staff creator.
 * - Inbound channel attribution (`WHATSAPP`, `PHONE`, `WALK_IN`, `OTHER`).
 * - Authoritative spatial context (`client_id`, `building_id`, `space_id`).
 * - Optional existing-master links to `tenant_companies` and `tenant_pics`.
 * - Request content, priority, and phase-1 status (`SUBMITTED`, `CANCELLED`).
 * - Idempotency key and fingerprint uniqueness.
 * - RBAC permissions: `handyman_request.create`, `handyman_request.read`,
 *   `handyman_request.manage`, bootstrapped to PLATFORM_ADMIN.
 */
export const migration0348CreateHandymanRequests: Migration = {
  id: '0348_create_handyman_requests',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_requests (
        id                      UUID PRIMARY KEY,
        client_id               UUID NOT NULL REFERENCES clients (id),
        building_id             UUID NOT NULL REFERENCES buildings (id),
        space_id                UUID NOT NULL REFERENCES spaces (id),
        tenant_company_id       UUID REFERENCES tenant_companies (id),
        tenant_pic_id           UUID REFERENCES tenant_pics (id),
        customer_name           TEXT NOT NULL,
        customer_phone          TEXT,
        customer_email          TEXT,
        created_by_user_id      UUID NOT NULL REFERENCES users (id),
        operational_surface     TEXT NOT NULL,
        inbound_channel         TEXT NOT NULL,
        request_number          TEXT NOT NULL,
        title                   TEXT NOT NULL,
        description             TEXT,
        priority                TEXT NOT NULL DEFAULT 'MEDIUM',
        status                  TEXT NOT NULL DEFAULT 'SUBMITTED',
        idempotency_key         TEXT,
        idempotency_fingerprint TEXT,
        requested_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_requests_client_request_number_unique
          UNIQUE (client_id, request_number),
        CONSTRAINT handyman_requests_operational_surface_check
          CHECK (operational_surface IN ('BM_SUPER_APP')),
        CONSTRAINT handyman_requests_inbound_channel_check
          CHECK (inbound_channel IN ('WHATSAPP', 'PHONE', 'WALK_IN', 'OTHER')),
        CONSTRAINT handyman_requests_priority_check
          CHECK (priority IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
        CONSTRAINT handyman_requests_status_check
          CHECK (status IN ('SUBMITTED', 'CANCELLED')),
        CONSTRAINT handyman_requests_idempotency_key_check
          CHECK (idempotency_key IS NULL OR length(btrim(idempotency_key)) BETWEEN 1 AND 200),
        CONSTRAINT handyman_requests_idempotency_fingerprint_check
          CHECK (idempotency_fingerprint IS NULL OR idempotency_fingerprint ~ '^[0-9a-f]{64}$'),
        CONSTRAINT handyman_requests_idempotency_pair_check
          CHECK (
            (idempotency_key IS NULL AND idempotency_fingerprint IS NULL)
            OR (idempotency_key IS NOT NULL AND idempotency_fingerprint IS NOT NULL)
          )
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX handyman_requests_client_idempotency_unique
        ON handyman_requests (client_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
      CREATE INDEX handyman_requests_building_status_requested_idx
        ON handyman_requests (building_id, status, requested_at DESC);
      CREATE INDEX handyman_requests_space_status_idx
        ON handyman_requests (space_id, status);
      CREATE INDEX handyman_requests_created_by_user_idx
        ON handyman_requests (created_by_user_id);
      CREATE INDEX handyman_requests_tenant_company_idx
        ON handyman_requests (tenant_company_id)
        WHERE tenant_company_id IS NOT NULL;
    `);

    // Bootstrap permissions
    const perms: [string, string][] = [
      ['handyman_request.create', 'Create Handyman Request'],
      ['handyman_request.read', 'Read Handyman Requests'],
      ['handyman_request.manage', 'Manage Handyman Requests'],
    ];

    for (const [code, name] of perms) {
      await client.query(
        `INSERT INTO permissions (id, code, name, status)
         VALUES ($1, $2, $3, 'ACTIVE')
         ON CONFLICT (code) DO NOTHING`,
        [randomUUID(), code, name],
      );
    }

    const roleResult = await client.query<{ id: string }>(
      `SELECT id FROM roles WHERE code = 'PLATFORM_ADMIN'`,
    );
    const roleId = roleResult.rows[0]?.id;
    if (roleId) {
      for (const [code] of perms) {
        const permResult = await client.query<{ id: string }>(
          `SELECT id FROM permissions WHERE code = $1`,
          [code],
        );
        const permId = permResult.rows[0]?.id;
        if (permId) {
          await client.query(
            `INSERT INTO role_permission_assignments (id, role_id, permission_id, status)
             SELECT $1, $2, $3, 'ACTIVE'
             WHERE NOT EXISTS (
               SELECT 1 FROM role_permission_assignments
               WHERE role_id = $2 AND permission_id = $3 AND status = 'ACTIVE'
             )`,
            [randomUUID(), roleId, permId],
          );
        }
      }
    }
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS handyman_requests');
    // Note: permissions and role assignments are preserved on downgrade per Asentra migration convention
  },
};
