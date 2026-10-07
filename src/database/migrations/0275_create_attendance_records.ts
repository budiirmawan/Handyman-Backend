import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-MOB-05 PART 02 — Workforce Attendance.
 *
 * The authoritative workforce attendance record for authenticated
 * self-service clock-in / clock-out:
 *
 *   Workforce Profile → Attendance Record → Building
 *                          ↳ optional Workforce Shift Assignment → Shift
 *
 * Semantics (all backend-authoritative):
 *   - `clock_in_at` / `clock_out_at` are set ONLY by the backend (NOW() in
 *     this slice's INSERT/UPDATE) — client-supplied timestamps are never
 *     accepted anywhere.
 *   - The record binds the authenticated Workforce Profile (never a
 *     caller-supplied identity), the Building the profile clocked into
 *     (BE-02F/G access-asserted in the service), and — when an applicable
 *     ACTIVE roster assignment exists — the authoritative
 *     `workforce_shift_assignments.id` and `shifts.id`. The shift binding
 *     is optional ("when available"): a worker may clock in without a
 *     roster row, but never with an invented one.
 *   - Lifecycle: CLOCKED_IN → CLOCKED_OUT. A closed record is terminal and
 *     preserved (auditable history); there is no delete, reopen, or edit.
 *   - At most one OPEN (CLOCKED_IN) record per Workforce Profile — the
 *     partial unique index is the storage backstop for the service-level
 *     duplicate pre-check, so a worker cannot hold two active clock-ins.
 *
 * Deliberately out of scope (per CR-BE-MOB-05 PART 02): payroll,
 * timesheets, overtime, leave, absence management, roster/shift redesign,
 * supervisor attendance administration, GPS/geofence, biometrics, QR
 * attendance, offline attendance, and any mock fallback.
 */
export const migration0275CreateAttendanceRecords: Migration = {
  id: '0275_create_attendance_records',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE attendance_records (
        id                            UUID PRIMARY KEY,
        client_id                     UUID NOT NULL REFERENCES clients (id),
        building_id                   UUID NOT NULL REFERENCES buildings (id),
        workforce_profile_id          UUID NOT NULL REFERENCES workforce_profiles (id),
        workforce_shift_assignment_id UUID REFERENCES workforce_shift_assignments (id),
        shift_id                      UUID REFERENCES shifts (id),
        clock_in_at                   TIMESTAMPTZ NOT NULL,
        clock_out_at                  TIMESTAMPTZ,
        status                        TEXT NOT NULL DEFAULT 'CLOCKED_IN',
        created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT attendance_records_status_check
          CHECK (status IN ('CLOCKED_IN', 'CLOCKED_OUT')),
        -- The shift binding is atomic: both halves present or both absent.
        CONSTRAINT attendance_records_shift_pair_check
          CHECK (
            (workforce_shift_assignment_id IS NULL) = (shift_id IS NULL)
          ),
        CONSTRAINT attendance_records_clock_out_order_check
          CHECK (clock_out_at IS NULL OR clock_out_at >= clock_in_at)
      )
    `);

    // At most one OPEN clock-in per Workforce Profile; closed history is
    // retained so attendance stays auditable.
    await client.query(`
      CREATE UNIQUE INDEX attendance_records_active_unique
        ON attendance_records (workforce_profile_id)
        WHERE status = 'CLOCKED_IN'
    `);

    await client.query(`
      CREATE INDEX attendance_records_workforce_profile_id_idx
        ON attendance_records (workforce_profile_id)
    `);
    await client.query(`
      CREATE INDEX attendance_records_building_id_idx
        ON attendance_records (building_id)
    `);
    await client.query(`
      CREATE INDEX attendance_records_status_idx
        ON attendance_records (status)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS attendance_records');
  },
};
