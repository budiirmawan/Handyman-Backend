import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-BE-04 RUN 1 — Handyman Work Crew authority.
 *
 * The minimum NEW crew model on top of the existing platform foundations:
 *
 *   Handyman Provider designation (CR-HM-BE-02 / 0349)
 *     → Work Crew (this table)
 *       → Crew Membership (LEAD_WORKER | HELPER)
 *         → Vendor Workforce Binding (BE-06F / 0060)
 *           → Workforce Profile (BE-03C / 0024, EXTERNAL via 0031)
 *
 * Governance decisions encoded here (CR-HM-BE-04):
 * - NO Handyman worker/person master is created. The person master stays
 *   `workforce_profiles`; the provider↔worker relationship stays
 *   `vendor_workforce_bindings`. Memberships reference an existing binding
 *   (the `permit_workers` idiom, 0209) and hold references only.
 * - NO second provider master: the crew points at the existing
 *   `handyman_providers` designation row, never at raw vendor/building or
 *   service data. Provider↔Building stays on BE-06D, Provider↔Service stays
 *   on BE-06E (the 0349 non-duplication doctrine).
 * - Deliberately NO request_id / work_order_id / building assignment /
 *   schedule / permit / WorkSession / attendance columns: BE-04 does not
 *   assign crews to requests or buildings — dispatch belongs to later CRs.
 * - A HELPER needs no login: nothing here touches `users`,
 *   `user_credentials`, `roles`, `permissions`, or Building access. The
 *   nullable `workforce_profiles.user_id` link (BE-03C) already supports a
 *   future authenticated mobile Lead Worker; BE-04 never requires it.
 * - Membership history is explicit and auditable: rows transition
 *   ACTIVE → INACTIVE with removal attribution and are never deleted or
 *   rewritten; an INACTIVE membership is immutable evidence.
 * - Database uniqueness guarantees AT MOST one ACTIVE membership per
 *   (crew, binding) and AT MOST one ACTIVE LEAD_WORKER per crew (partial
 *   unique indexes — the BE-03G/BE-06D/0349 idiom). The complementary
 *   invariant — an operational ACTIVE crew is never left with ZERO active
 *   leads — cannot be expressed as a uniqueness constraint and lives in the
 *   service lifecycle authority (lead required at creation, lead removal
 *   only through the atomic change-lead command, reactivation re-asserts a
 *   valid active lead).
 * - Crew code is unique per provider among ACTIVE crews; INACTIVE crew rows
 *   are preserved, so a deactivated code can be re-issued deliberately while
 *   history is never lost.
 *
 * Cross-table rules the FKs cannot express live in the service layer:
 *   - the provider designation must be ACTIVE and resolve to the same
 *     Client, its Vendor must be ACTIVE (BE-02 reactivation idiom),
 *   - a member's binding must be ACTIVE, belong to the crew's provider
 *     Vendor, and its profile must be ACTIVE and of type EXTERNAL
 *     (consuming the BE-06F personnel authority — never creating it),
 *   - an INACTIVE crew is frozen: it gains no operational ACTIVE membership
 *     (no preparation-before-activation convention exists in this repo).
 *
 * RBAC permissions: `handyman_work_crew.read`, `handyman_work_crew.manage`,
 * bootstrapped to PLATFORM_ADMIN (the CR-HM-BE-02 pattern).
 */
export const migration0353CreateHandymanWorkCrews: Migration = {
  id: '0353_create_handyman_work_crews',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_work_crews (
        id                   UUID PRIMARY KEY,
        client_id            UUID NOT NULL,
        handyman_provider_id UUID NOT NULL,
        crew_code            TEXT NOT NULL,
        crew_name            TEXT NOT NULL,
        status               TEXT NOT NULL DEFAULT 'ACTIVE',
        created_by_user_id   UUID NOT NULL,
        updated_by_user_id   UUID NOT NULL,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT handyman_work_crews_client_id_fkey
          FOREIGN KEY (client_id) REFERENCES clients (id),
        CONSTRAINT handyman_work_crews_handyman_provider_id_fkey
          FOREIGN KEY (handyman_provider_id) REFERENCES handyman_providers (id),
        CONSTRAINT handyman_work_crews_created_by_user_id_fkey
          FOREIGN KEY (created_by_user_id) REFERENCES users (id),
        CONSTRAINT handyman_work_crews_updated_by_user_id_fkey
          FOREIGN KEY (updated_by_user_id) REFERENCES users (id),
        CONSTRAINT handyman_work_crews_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT handyman_work_crews_crew_code_check
          CHECK (length(btrim(crew_code)) BETWEEN 1 AND 100),
        CONSTRAINT handyman_work_crews_crew_name_check
          CHECK (length(btrim(crew_name)) BETWEEN 1 AND 200)
      )
    `);

    // One ACTIVE crew per (provider, code); INACTIVE history is retained
    // (the 0349 partial-unique idiom).
    await client.query(`
      CREATE UNIQUE INDEX handyman_work_crews_one_active_code_per_provider
        ON handyman_work_crews (handyman_provider_id, crew_code)
        WHERE status = 'ACTIVE'
    `);
    await client.query(
      `CREATE INDEX handyman_work_crews_client_status_idx
         ON handyman_work_crews (client_id, status)`,
    );
    await client.query(
      `CREATE INDEX handyman_work_crews_provider_idx
         ON handyman_work_crews (handyman_provider_id, status)`,
    );

    await client.query(`
      CREATE TABLE handyman_work_crew_members (
        id                        UUID PRIMARY KEY,
        client_id                 UUID NOT NULL,
        crew_id                   UUID NOT NULL,
        vendor_workforce_binding_id UUID NOT NULL,
        crew_role                 TEXT NOT NULL,
        status                    TEXT NOT NULL DEFAULT 'ACTIVE',
        effective_from            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        effective_to              TIMESTAMPTZ,
        added_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        added_by_user_id          UUID NOT NULL,
        removed_at                TIMESTAMPTZ,
        removed_by_user_id        UUID,
        created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT handyman_work_crew_members_client_id_fkey
          FOREIGN KEY (client_id) REFERENCES clients (id),
        CONSTRAINT handyman_work_crew_members_crew_id_fkey
          FOREIGN KEY (crew_id) REFERENCES handyman_work_crews (id),
        CONSTRAINT handyman_work_crew_members_binding_id_fkey
          FOREIGN KEY (vendor_workforce_binding_id)
          REFERENCES vendor_workforce_bindings (id),
        CONSTRAINT handyman_work_crew_members_added_by_user_id_fkey
          FOREIGN KEY (added_by_user_id) REFERENCES users (id),
        CONSTRAINT handyman_work_crew_members_removed_by_user_id_fkey
          FOREIGN KEY (removed_by_user_id) REFERENCES users (id),
        CONSTRAINT handyman_work_crew_members_role_check
          CHECK (crew_role IN ('LEAD_WORKER', 'HELPER')),
        CONSTRAINT handyman_work_crew_members_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        -- State consistency: an ACTIVE membership carries no removal
        -- attribution; an INACTIVE membership is fully attributed, closed
        -- evidence (effective_to required so the history window is explicit).
        CONSTRAINT handyman_work_crew_members_active_state_check
          CHECK (
            status <> 'ACTIVE'
            OR (removed_at IS NULL AND removed_by_user_id IS NULL
              AND effective_to IS NULL)
          ),
        CONSTRAINT handyman_work_crew_members_inactive_state_check
          CHECK (
            status <> 'INACTIVE'
            OR (removed_at IS NOT NULL AND removed_by_user_id IS NOT NULL
              AND effective_to IS NOT NULL)
          ),
        CONSTRAINT handyman_work_crew_members_effective_range_check
          CHECK (effective_to IS NULL OR effective_to >= effective_from)
      )
    `);

    // One ACTIVE membership per (crew, binding) — a worker cannot be
    // double-seated on the same crew; INACTIVE rows preserve history.
    await client.query(`
      CREATE UNIQUE INDEX handyman_work_crew_members_one_active_per_crew_binding
        ON handyman_work_crew_members (crew_id, vendor_workforce_binding_id)
        WHERE status = 'ACTIVE'
    `);
    // AT MOST one ACTIVE LEAD_WORKER per crew. (The complementary
    // "at least one" invariant for operational ACTIVE crews is enforced by
    // the service lifecycle authority — a uniqueness index cannot express
    // existence.)
    await client.query(`
      CREATE UNIQUE INDEX handyman_work_crew_members_one_active_lead_per_crew
        ON handyman_work_crew_members (crew_id)
        WHERE status = 'ACTIVE' AND crew_role = 'LEAD_WORKER'
    `);
    await client.query(
      `CREATE INDEX handyman_work_crew_members_crew_idx
         ON handyman_work_crew_members (crew_id, status)`,
    );
    await client.query(
      `CREATE INDEX handyman_work_crew_members_binding_idx
         ON handyman_work_crew_members (vendor_workforce_binding_id, status)`,
    );

    // Bootstrap permissions (the 0349/0350 pattern).
    const perms: [string, string][] = [
      ['handyman_work_crew.read', 'Read Handyman Work Crews'],
      ['handyman_work_crew.manage', 'Manage Handyman Work Crews'],
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
    await client.query('DROP TABLE IF EXISTS handyman_work_crew_members');
    await client.query('DROP TABLE IF EXISTS handyman_work_crews');
    // Note: permissions and role assignments are preserved on downgrade per
    // Asentra migration convention.
  },
};
