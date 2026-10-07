import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-05 PART 01 — Handyman Scheduling Readiness (FROZEN
 * F1/F2/F7/F8/F9/F10 containment).
 *
 * Additive bounded table ONLY; ZERO changes to existing tables and ZERO
 * invented execution concepts. This is NOT an execution schedule: no
 * job, work order, executionScopeId, targetId, provider/crew binding,
 * recurrence execution, arrival verification, attendance, or work
 * session exists here (F2/F9/F10).
 *
 *   handyman_scheduling_readiness  readiness PREFERENCE fact bound to an
 *     existing Handyman Service Request: timezone is server-derived from
 *     the authoritative `buildings.timezone` at creation (never caller
 *     input), the preferred window is validated (start < end), and the
 *     status vocabulary is exactly ACTIVE | INACTIVE (no DRAFT and no
 *     execution states such as SCHEDULED/DISPATCHED/ASSIGNED/IN_PROGRESS
 *     — they are FROZEN-forbidden). Exactly ONE ACTIVE readiness row per
 *     request (partial UNIQUE index); material changes supersede rows
 *     (old becomes INACTIVE, never hard-deleted; F8 history preserved).
 */
export const migration0387CreateHandymanSchedulingReadiness: Migration = {
  id: '0387_create_handyman_scheduling_readiness',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_scheduling_readiness (
        id                          UUID PRIMARY KEY,
        client_id                   UUID NOT NULL REFERENCES clients (id),
        handyman_request_id         UUID NOT NULL
          REFERENCES handyman_service_requests (id),
        timezone                    TEXT NOT NULL,
        preferred_window_start      TIMESTAMPTZ NOT NULL,
        preferred_window_end        TIMESTAMPTZ NOT NULL,
        status                      TEXT NOT NULL DEFAULT 'ACTIVE',
        created_by_user_id          UUID NOT NULL REFERENCES users (id),
        created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_sched_readiness_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT handyman_sched_readiness_window_check
          CHECK (preferred_window_start < preferred_window_end),
        CONSTRAINT handyman_sched_readiness_timezone_length_check
          CHECK (char_length(timezone) BETWEEN 1 AND 64)
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX handyman_sched_readiness_active_unique
        ON handyman_scheduling_readiness (handyman_request_id)
        WHERE status = 'ACTIVE'
    `);
    await client.query(`
      CREATE INDEX handyman_sched_readiness_client_idx
        ON handyman_scheduling_readiness (client_id, created_at)
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(
      'DROP TABLE IF EXISTS handyman_scheduling_readiness',
    );
  },
};
