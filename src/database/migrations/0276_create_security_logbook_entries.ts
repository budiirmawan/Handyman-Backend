import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-MOB-05 PART 03 — Security Operational Logbook.
 *
 * The authoritative Security logbook entry for mobile Security
 * operations:
 *
 *   Workforce Profile → Security Logbook Entry → Building
 *                          ↳ optional Shift Handover reference
 *
 * Semantics (all backend-authoritative):
 *   - The entry binds the authenticated Workforce Profile (never a
 *     caller-supplied identity), the Building the entry belongs to
 *     (BE-02F/G access-asserted in the service), and — when supplied — a
 *     valid existing authoritative `shift_handovers.id` row. The handover
 *     reference is optional ("do not require handover linkage"); when
 *     present it must resolve to the SAME Building (service-enforced;
 *     cross-Building handovers are rejected). Outgoing/incoming Shift IDs
 *     are never invented — the reference is the handover row id only.
 *   - `recorded_at` is set ONLY by the backend (NOW() on INSERT) —
 *     client-supplied timestamps are never accepted anywhere.
 *   - Category is a fixed classification vocabulary only; the backend
 *     branches no behavior on it (no patrol / incident / finding engine
 *     is implied).
 *   - Lifecycle: OPEN → CLOSED. Updates are allowed only while OPEN;
 *     CLOSED is terminal and preserved (auditable history) — no delete,
 *     reopen, or edit.
 *
 * Deliberately out of scope (per CR-BE-MOB-05 PART 03): security patrol,
 * checkpoint, incident management, visitor management, attendance, QR,
 * GPS, push notification, offline synchronization, supervisor dashboard,
 * Management Read Models, mobile-specific duplicate endpoints, and any
 * mock fallback.
 */
export const migration0276CreateSecurityLogbookEntries: Migration = {
  id: '0276_create_security_logbook_entries',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE security_logbook_entries (
        id                   UUID PRIMARY KEY,
        client_id            UUID NOT NULL REFERENCES clients (id),
        building_id          UUID NOT NULL REFERENCES buildings (id),
        workforce_profile_id UUID NOT NULL REFERENCES workforce_profiles (id),
        shift_handover_id    UUID REFERENCES shift_handovers (id),
        category             TEXT NOT NULL,
        summary              TEXT NOT NULL,
        detail               TEXT,
        status               TEXT NOT NULL DEFAULT 'OPEN',
        recorded_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT security_logbook_entries_status_check
          CHECK (status IN ('OPEN', 'CLOSED')),
        CONSTRAINT security_logbook_entries_category_check
          CHECK (category IN ('GENERAL', 'INCIDENT', 'PATROL', 'HANDOVER', 'FINDING'))
      )
    `);

    await client.query(`
      CREATE INDEX security_logbook_entries_building_recorded_idx
        ON security_logbook_entries (building_id, recorded_at DESC)
    `);
    await client.query(`
      CREATE INDEX security_logbook_entries_workforce_profile_id_idx
        ON security_logbook_entries (workforce_profile_id)
    `);
    await client.query(`
      CREATE INDEX security_logbook_entries_status_idx
        ON security_logbook_entries (status)
    `);
    await client.query(`
      CREATE INDEX security_logbook_entries_handover_idx
        ON security_logbook_entries (shift_handover_id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS security_logbook_entries');
  },
};
