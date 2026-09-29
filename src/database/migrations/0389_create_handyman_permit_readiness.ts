import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-05 PART 03 — Handyman Permit Readiness (FROZEN F4/F5/F7/F8).
 *
 * Additive bounded table ONLY; ZERO changes to existing tables and ZERO
 * FM Permit-to-Work linkage. This records AUTHORIZATION/READINESS for
 * tenant/unit service access — NOT FM PTW, NOT execution authorization:
 * IN_PROGRESS/WORKING/COMPLETED/CLOSED states and the FM approval
 * chain / state machine are FROZEN-forbidden (F4/F10).
 *
 *   handyman_permit_readiness  bounded permit fact bound to an existing
 *     Handyman Service Request. Location references are server-derived
 *     from the authoritative request/master chain (and must agree with
 *     any ACTIVE Unit Access Readiness); `permit_type` vocabulary is the
 *     bounded Handyman set (UNIT | BUILDING_COMMON_AREA) — derived from
 *     F4 tenant/unit service access needs, NOT the FM free-form
 *     permit_type list. Status is exactly ACTIVE | INACTIVE; one ACTIVE
 *     row per request (partial UNIQUE); material changes supersede rows
 *     (F8 history; never hard-deleted).
 */
export const migration0389CreateHandymanPermitReadiness: Migration = {
  id: '0389_create_handyman_permit_readiness',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_permit_readiness (
        id                          UUID PRIMARY KEY,
        client_id                   UUID NOT NULL REFERENCES clients (id),
        handyman_request_id         UUID NOT NULL
          REFERENCES handyman_service_requests (id),
        building_id                 UUID NOT NULL REFERENCES buildings (id),
        floor_id                    UUID REFERENCES floors (id),
        area_id                     UUID REFERENCES areas (id),
        room_id                     UUID REFERENCES rooms (id),
        space_id                    UUID NOT NULL REFERENCES spaces (id),
        permit_type                 TEXT NOT NULL,
        valid_from                  TIMESTAMPTZ NOT NULL,
        valid_until                 TIMESTAMPTZ NOT NULL,
        authorization_note          TEXT NOT NULL,
        status                      TEXT NOT NULL DEFAULT 'ACTIVE',
        authorized_by_user_id       UUID NOT NULL REFERENCES users (id),
        created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_permit_readiness_type_check
          CHECK (permit_type IN ('UNIT', 'BUILDING_COMMON_AREA')),
        CONSTRAINT handyman_permit_readiness_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT handyman_permit_readiness_validity_check
          CHECK (valid_from < valid_until),
        CONSTRAINT handyman_permit_readiness_note_length_check
          CHECK (char_length(authorization_note) BETWEEN 1 AND 1000)
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX handyman_permit_readiness_active_unique
        ON handyman_permit_readiness (handyman_request_id)
        WHERE status = 'ACTIVE'
    `);
    await client.query(`
      CREATE INDEX handyman_permit_readiness_client_idx
        ON handyman_permit_readiness (client_id, created_at)
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS handyman_permit_readiness');
  },
};
