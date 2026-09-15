import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-13B — Visitor Invitation.
 *
 * A visit-planning record: a known Visitor identity (BE-13A) is invited
 * to a Building for an expected date/time window by a host. It is an
 * operational front-desk record — NOT a marketing/messaging engine and
 * NOT the Visit lifecycle itself (Check-In / Pass / Check-Out arrive in
 * later BE-13 PARTs).
 *
 * Identity boundary: the invitation references the shared `visitors`
 * master — no visitor personal data is duplicated here.
 *
 * Host boundary: the repository has no authoritative Tenant domain, so
 * the invitation carries the smallest safe host reference — an optional
 * internal User, an optional Workforce profile, and/or a free-form host
 * name. At least one host reference is required (enforced by CHECK).
 *
 * Scope: Building-scoped; `client_id` is derived authoritatively from
 * Building → Property → Client, never caller-supplied.
 *
 * Lifecycle (minimal, backend-authoritative): PENDING → CANCELLED.
 * Later PARTs extend the visit flow (Expected Visitor, Host
 * Confirmation, Check-In) without mutating this planning record's
 * ownership.
 */
export const migration0134CreateVisitorInvitations: Migration = {
  id: '0134_create_visitor_invitations',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE visitor_invitations (
        id                     UUID PRIMARY KEY,
        client_id              UUID NOT NULL REFERENCES clients (id),
        building_id            UUID NOT NULL REFERENCES buildings (id),
        visitor_id             UUID NOT NULL REFERENCES visitors (id),
        host_user_id           UUID REFERENCES users (id),
        host_workforce_id      UUID REFERENCES workforce_profiles (id),
        host_name              TEXT,
        expected_arrival_at    TIMESTAMPTZ NOT NULL,
        expected_departure_at  TIMESTAMPTZ,
        purpose                TEXT NOT NULL,
        notes                  TEXT,
        status                 TEXT NOT NULL DEFAULT 'PENDING',
        created_by_user_id     UUID NOT NULL REFERENCES users (id),
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT visitor_invitations_status_check
          CHECK (status IN ('PENDING', 'CANCELLED')),
        CONSTRAINT visitor_invitations_host_required
          CHECK (
            host_user_id IS NOT NULL
            OR host_workforce_id IS NOT NULL
            OR host_name IS NOT NULL
          ),
        CONSTRAINT visitor_invitations_time_window
          CHECK (
            expected_departure_at IS NULL
            OR expected_departure_at > expected_arrival_at
          )
      )
    `);

    await client.query(`
      CREATE INDEX visitor_invitations_building_idx
        ON visitor_invitations (building_id, status, expected_arrival_at);
      CREATE INDEX visitor_invitations_client_idx
        ON visitor_invitations (client_id, status);
      CREATE INDEX visitor_invitations_visitor_idx
        ON visitor_invitations (visitor_id, status);
      CREATE INDEX visitor_invitations_host_user_idx
        ON visitor_invitations (host_user_id);
      CREATE INDEX visitor_invitations_host_workforce_idx
        ON visitor_invitations (host_workforce_id);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS visitor_invitations');
  },
};
