import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-22A — Document Foundation.
 *
 * ONE shared Document foundation for INTERNAL, TENANT and VENDOR scenarios.
 * No separate Internal/Tenant/Vendor engines.
 *
 * Minimum scope: document_number, document_type, context/source type, title,
 * description, Client/Building context, status, created_by, created_at.
 *
 * Storage: opaque `file_reference` only (reuse BE-07 convention), never binary.
 * History preserved via append-only `operational_events` and audit; no hard delete.
 * Archive/version/expiry/approval deferred to later BE-22 parts — not modeled here.
 */
export const migration0224CreateDocuments: Migration = {
  id: '0224_create_documents',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE documents (
        id                  UUID PRIMARY KEY,
        client_id           UUID NOT NULL REFERENCES clients (id),
        building_id         UUID REFERENCES buildings (id),
        document_number     TEXT NOT NULL,
        document_type       TEXT NOT NULL,
        context_type        TEXT NOT NULL,
        source_type         TEXT,
        source_id           UUID,
        title               TEXT NOT NULL,
        description         TEXT,
        file_reference      TEXT,
        status              TEXT NOT NULL DEFAULT 'DRAFT',
        created_by_user_id  UUID NOT NULL REFERENCES users (id),
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT documents_context_check
          CHECK (context_type IN ('INTERNAL', 'TENANT', 'VENDOR')),
        CONSTRAINT documents_status_check
          CHECK (status IN ('DRAFT', 'ACTIVE', 'INACTIVE')),
        CONSTRAINT documents_source_pair_check
          CHECK (
            (source_type IS NULL AND source_id IS NULL)
            OR
            (source_type IS NOT NULL AND source_id IS NOT NULL)
          ),
        CONSTRAINT documents_client_number_unique
          UNIQUE (client_id, document_number)
      )
    `);

    await client.query(`
      CREATE INDEX documents_client_idx
        ON documents (client_id, status);
      CREATE INDEX documents_building_idx
        ON documents (building_id, status);
      CREATE INDEX documents_context_idx
        ON documents (context_type, status);
      CREATE INDEX documents_type_idx
        ON documents (document_type, status);
      CREATE INDEX documents_client_building_idx
        ON documents (client_id, building_id);
    `);

    // Seed document RBAC permissions idempotently (also in seed file).
    const perms: [string, string][] = [
      ['document.read', 'Read Documents'],
      ['document.manage', 'Manage Documents'],
    ];
    for (const [code, name] of perms) {
      await client.query(
        `INSERT INTO permissions (id, code, name, status)
         VALUES ($1, $2, $3, 'ACTIVE')
         ON CONFLICT (code) DO NOTHING`,
        [randomUUID(), code, name],
      );
    }

    // Ensure PLATFORM_ADMIN holds document permissions.
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
    await client.query('DROP TABLE IF EXISTS documents');
    // Permissions intentionally retained on downgrade (audit/history preserved).
  },
};
