import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-03C — Workforce Profile foundation.
 *
 * A Workforce Profile is the *operational personnel identity* of a person
 * inside the organizational structure. It is deliberately distinct from `users`:
 *
 *   User             → digital identity / authentication (BE-01)
 *   WorkforceProfile → operational personnel identity (BE-03C)
 *
 * A Workforce Profile therefore MUST be able to exist without a User account:
 * `user_id` is nullable. When it IS supplied it is unique (one profile per user)
 * but linking never creates credentials and never grants Role or Permission —
 * RBAC remains entirely owned by BE-01.
 *
 * Hierarchy (validated in the service layer, since the FKs alone cannot express
 * the cross-table consistency rules):
 *
 *   Client → Organization → Department → Team → Workforce Profile
 *                                             → Position
 *
 * - `organization_id` and `department_id` are required; the department must
 *   belong to the organization.
 * - `team_id` is optional; when present the team must belong to the department.
 * - `position_id` is required; the position must belong to the organization and,
 *   when the position is department-scoped, to the same department.
 *
 * `employee_code` is unique per Organization.
 */
export const migration0024CreateWorkforceProfiles: Migration = {
  id: '0024_create_workforce_profiles',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE workforce_profiles (
        id              UUID PRIMARY KEY,
        organization_id UUID NOT NULL,
        department_id   UUID NOT NULL,
        team_id         UUID,
        position_id     UUID NOT NULL,
        user_id         UUID,
        employee_code   TEXT NOT NULL,
        full_name       TEXT NOT NULL,
        workforce_type  TEXT NOT NULL DEFAULT 'INTERNAL',
        status          TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT workforce_profiles_organization_id_fkey
          FOREIGN KEY (organization_id) REFERENCES organizations (id),
        CONSTRAINT workforce_profiles_department_id_fkey
          FOREIGN KEY (department_id) REFERENCES departments (id),
        CONSTRAINT workforce_profiles_team_id_fkey
          FOREIGN KEY (team_id) REFERENCES teams (id),
        CONSTRAINT workforce_profiles_position_id_fkey
          FOREIGN KEY (position_id) REFERENCES positions (id),
        CONSTRAINT workforce_profiles_user_id_fkey
          FOREIGN KEY (user_id) REFERENCES users (id),
        CONSTRAINT workforce_profiles_employee_code_unique
          UNIQUE (organization_id, employee_code),
        CONSTRAINT workforce_profiles_user_id_unique
          UNIQUE (user_id),
        CONSTRAINT workforce_profiles_workforce_type_check
          CHECK (workforce_type IN ('INTERNAL', 'OUTSOURCED', 'CONTRACT')),
        CONSTRAINT workforce_profiles_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    await client.query(`
      CREATE INDEX workforce_profiles_organization_id_idx
        ON workforce_profiles (organization_id)
    `);

    await client.query(`
      CREATE INDEX workforce_profiles_department_id_idx
        ON workforce_profiles (department_id)
    `);

    await client.query(`
      CREATE INDEX workforce_profiles_team_id_idx
        ON workforce_profiles (team_id)
    `);

    await client.query(`
      CREATE INDEX workforce_profiles_position_id_idx
        ON workforce_profiles (position_id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS workforce_profiles');
  },
};
