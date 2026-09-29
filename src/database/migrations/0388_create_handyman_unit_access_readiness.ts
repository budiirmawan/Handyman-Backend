import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-05 PART 02 — Handyman Unit Access Readiness (FROZEN
 * F5/F6/F7/F8/F9/F10 containment).
 *
 * Additive bounded table ONLY; ZERO changes to existing tables and ZERO
 * invented arrival/check-in concepts. This records AUTHORIZATION/
 * READINESS to access the request's authoritative building/unit-space —
 * NOT proof of presence: ARRIVED/CHECKED_IN/VERIFIED/ON_SITE/WORK_STARTED
 * states are FROZEN-forbidden (F6; CR-HM-07 owns physical arrival proof
 * exclusively).
 *
 *   handyman_unit_access_readiness  ready/authorized fact bound to an
 *     existing Handyman Service Request. ALL location references
 *     (building/floor/area/room/unit-space) are server-derived from the
 *     authoritative request snapshot + location-master chain — the
 *     caller can never redirect access to another building/unit (F5/F7).
 *     Status vocabulary is exactly ACTIVE | INACTIVE; exactly ONE ACTIVE
 *     row per request (partial UNIQUE index); material changes supersede
 *     rows (old becomes INACTIVE, never hard-deleted; F8 history).
 */
export const migration0388CreateHandymanUnitAccessReadiness: Migration = {
  id: '0388_create_handyman_unit_access_readiness',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_unit_access_readiness (
        id                          UUID PRIMARY KEY,
        client_id                   UUID NOT NULL REFERENCES clients (id),
        handyman_request_id         UUID NOT NULL
          REFERENCES handyman_service_requests (id),
        building_id                 UUID NOT NULL REFERENCES buildings (id),
        floor_id                    UUID REFERENCES floors (id),
        area_id                     UUID REFERENCES areas (id),
        room_id                     UUID REFERENCES rooms (id),
        space_id                    UUID NOT NULL REFERENCES spaces (id),
        access_window_start         TIMESTAMPTZ NOT NULL,
        access_window_end           TIMESTAMPTZ NOT NULL,
        authorization_note          TEXT NOT NULL,
        status                      TEXT NOT NULL DEFAULT 'ACTIVE',
        authorized_by_user_id       UUID NOT NULL REFERENCES users (id),
        created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_access_readiness_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT handyman_access_readiness_window_check
          CHECK (access_window_start < access_window_end),
        CONSTRAINT handyman_access_readiness_note_length_check
          CHECK (char_length(authorization_note) BETWEEN 1 AND 1000)
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX handyman_access_readiness_active_unique
        ON handyman_unit_access_readiness (handyman_request_id)
        WHERE status = 'ACTIVE'
    `);
    await client.query(`
      CREATE INDEX handyman_access_readiness_client_idx
        ON handyman_unit_access_readiness (client_id, created_at)
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(
      'DROP TABLE IF EXISTS handyman_unit_access_readiness',
    );
  },
};
