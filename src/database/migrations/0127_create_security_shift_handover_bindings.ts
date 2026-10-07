import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-12G — Security Shift Handover binding.
 *
 * The Security binding row associates an existing BE-10J shift_handovers
 * record with a Security operational context — a BE-12A start Security
 * Post plus an optional BE-12B Patrol Route — under the same Building.
 *
 * The BE-10J lifecycle (DRAFT → READY → ACKNOWLEDGED) remains authoritative
 * on `shift_handovers.status`. This binding adds a Security-side join row
 * whose own ACTIVE/INACTIVE status is independent of the handover
 * lifecycle, so an INACTIVE binding does not affect the underlying
 * handover's progress.
 *
 * `client_id` and `building_id` are denormalized for fast listing, but
 * the service derives them authoritatively from Building → Property →
 * Client (BE-02) on every write, so isolation can never drift.
 *
 * One ACTIVE binding per handover (`unique active` partial index). An
 * INACTIVE binding can co-exist (history / supersession) but cannot be
 * reactivated if a same-handover ACTIVE binding already exists.
 */
export const migration0127CreateSecurityShiftHandoverBindings: Migration = {
  id: '0127_create_security_shift_handover_bindings',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE security_shift_handover_bindings (
        id                       UUID PRIMARY KEY,
        client_id                UUID NOT NULL REFERENCES clients (id),
        building_id              UUID NOT NULL REFERENCES buildings (id),
        shift_handover_id        UUID NOT NULL REFERENCES shift_handovers (id),
        start_security_post_id   UUID REFERENCES security_posts (id),
        patrol_route_id          UUID REFERENCES patrol_routes (id),
        status                   TEXT NOT NULL DEFAULT 'ACTIVE',
        created_by_user_id       UUID NOT NULL REFERENCES users (id),
        created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT security_shift_handover_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX security_shift_handover_binding_active_unique
        ON security_shift_handover_bindings (shift_handover_id)
        WHERE status = 'ACTIVE';
    `);

    await client.query(`
      CREATE INDEX security_shift_handover_bindings_building_idx
        ON security_shift_handover_bindings (building_id, status);
      CREATE INDEX security_shift_handover_bindings_handover_idx
        ON security_shift_handover_bindings (shift_handover_id);
      CREATE INDEX security_shift_handover_bindings_start_post_idx
        ON security_shift_handover_bindings (start_security_post_id);
      CREATE INDEX security_shift_handover_bindings_patrol_route_idx
        ON security_shift_handover_bindings (patrol_route_id);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS security_shift_handover_bindings');
  },
};
