import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-12E — Patrol Checklist Binding.
 *
 * The minimal Security binding that associates a BE-07 Checklist Template
 * with a Security operational context: a BE-12B Patrol Route plus an
 * optional BE-12A Security Start Post inside the same Building.
 *
 * This table holds references only — Checklist Template, Items, Executions,
 * Measurement, Evidence, Verification, and Finding workflow masters are
 * never duplicated. Executions stay BE-07's `checklist_executions` rows and
 * are linked back to this binding by the `patrol_checklist_binding_id`
 * column added in migration 0126.
 *
 * `client_id` is derived authoritatively from Building → Property → Client
 * and stored only for query convenience. At most one ACTIVE binding per
 * (checklist_template_id, patrol_route_id) is enforced by a partial unique
 * index — multiple bindings against the same template but different routes
 * are allowed (each route gets its own operational context).
 */
export const migration0125CreatePatrolChecklistBindings: Migration = {
  id: '0125_create_patrol_checklist_bindings',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE patrol_checklist_bindings (
        id                     UUID PRIMARY KEY,
        client_id              UUID NOT NULL REFERENCES clients (id),
        building_id            UUID NOT NULL REFERENCES buildings (id),
        patrol_route_id        UUID NOT NULL REFERENCES patrol_routes (id),
        start_security_post_id UUID REFERENCES security_posts (id),
        checklist_template_id  UUID NOT NULL REFERENCES checklist_templates (id),
        status                 TEXT NOT NULL DEFAULT 'ACTIVE',
        created_by_user_id     UUID NOT NULL REFERENCES users (id),
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT patrol_checklist_binding_status
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX patrol_checklist_binding_active_unique
        ON patrol_checklist_bindings (checklist_template_id, patrol_route_id)
        WHERE status = 'ACTIVE';
      CREATE INDEX patrol_checklist_bindings_building_idx
        ON patrol_checklist_bindings (building_id, status);
      CREATE INDEX patrol_checklist_bindings_route_idx
        ON patrol_checklist_bindings (patrol_route_id, status);
      CREATE INDEX patrol_checklist_bindings_template_idx
        ON patrol_checklist_bindings (checklist_template_id, status);
      CREATE INDEX patrol_checklist_bindings_start_post_idx
        ON patrol_checklist_bindings (start_security_post_id);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS patrol_checklist_bindings');
  },
};
