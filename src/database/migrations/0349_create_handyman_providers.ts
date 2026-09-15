import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-BE-02 RUN 1 — Handyman Provider designation foundation.
 *
 * Establishes the dedicated role binding that designates an existing Vendor
 * (BE-06A registry — the organizational identity authority for external
 * service providers) as a Handyman Provider for that Vendor's Client:
 *
 *   Client → Handyman Provider Designation → Vendor
 *
 * Governance decisions encoded here (CR-HM-BE-02):
 * - Provider is NOT automatically Vendor: the `vendors` master is never
 *   modified, and no second provider master is created. This thin binding
 *   materializes the distinct Handyman Provider concept, mirroring the
 *   repo's non-duplication idiom (vendor_capabilities references a
 *   relationship instead of carrying building_id).
 * - Deliberately NO `building_id`: Provider ↔ Building authorization stays
 *   on the existing BE-06D `vendor_building_relationships` authority.
 * - Deliberately NO service/capability columns: Provider ↔ Service
 *   eligibility stays on the existing BE-06E `vendor_capabilities` (+ the
 *   CR-BE-SVC-01 `service_catalog_id` identity link).
 * - Deliberately NO pricing/commercial or workforce/crew fields: commerce
 *   belongs to CR-HM-BE-03 and later lifecycle CRs.
 *
 * Lifecycle: at most one ACTIVE designation per (client, vendor) — enforced
 * by a partial unique index over ACTIVE rows following the BE-03G/BE-06D
 * idiom — while deactivated rows are preserved, so designation history is
 * never lost and rows are never hard-deleted through normal lifecycle
 * handling.
 *
 * Cross-table rules the FKs cannot express — the Vendor must resolve to the
 * same Client, the Vendor must be ACTIVE at designation/reactivation, and
 * the Client must hold an effective HANDYMAN module entitlement under the
 * existing BE-02C resolver (module resolved by stable catalogue code, never
 * a hardcoded database id) — live in the service layer.
 *
 * RBAC permissions: `handyman_provider.read`, `handyman_provider.manage`,
 * bootstrapped to PLATFORM_ADMIN (the CR-HM-BE-01 pattern).
 */
export const migration0349CreateHandymanProviders: Migration = {
  id: '0349_create_handyman_providers',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_providers (
        id                 UUID PRIMARY KEY,
        client_id          UUID NOT NULL,
        vendor_id          UUID NOT NULL,
        status             TEXT NOT NULL DEFAULT 'ACTIVE',
        created_by_user_id UUID NOT NULL,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT handyman_providers_client_id_fkey
          FOREIGN KEY (client_id) REFERENCES clients (id),
        CONSTRAINT handyman_providers_vendor_id_fkey
          FOREIGN KEY (vendor_id) REFERENCES vendors (id),
        CONSTRAINT handyman_providers_created_by_user_id_fkey
          FOREIGN KEY (created_by_user_id) REFERENCES users (id),
        CONSTRAINT handyman_providers_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    // One ACTIVE designation per (client, vendor); INACTIVE history is
    // retained, and reactivation after deactivation creates no second
    // ACTIVE row (guarded in the service, enforced here structurally).
    await client.query(`
      CREATE UNIQUE INDEX handyman_providers_one_active_per_client_vendor
        ON handyman_providers (client_id, vendor_id)
        WHERE status = 'ACTIVE'
    `);

    await client.query(
      `CREATE INDEX handyman_providers_client_status_idx
         ON handyman_providers (client_id, status)`,
    );
    await client.query(
      `CREATE INDEX handyman_providers_vendor_id_idx
         ON handyman_providers (vendor_id)`,
    );

    // Bootstrap permissions
    const perms: [string, string][] = [
      ['handyman_provider.read', 'Read Handyman Providers'],
      ['handyman_provider.manage', 'Manage Handyman Providers'],
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
    await client.query('DROP TABLE IF EXISTS handyman_providers');
    // Note: permissions and role assignments are preserved on downgrade per Asentra migration convention
  },
};
