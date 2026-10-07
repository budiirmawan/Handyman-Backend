import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  AttendanceStatus,
  PublicAttendanceRecord,
} from './attendance.types';

/**
 * CR-BE-MOB-05 PART 02 — Attendance repository.
 *
 * One CLOCKED_IN record per Workforce Profile (partial unique index is the
 * storage backstop). `clock_in_at` / `clock_out_at` are set ONLY here with
 * the database clock (NOW()) — client-supplied timestamps never reach the
 * storage layer. All access rules live in the service layer.
 */

type AttendanceDisplayRow = {
  id: string;
  client_id: string;
  building_id: string;
  building_code: string;
  building_name: string;
  workforce_profile_id: string;
  employee_code: string;
  workforce_shift_assignment_id: string | null;
  shift_id: string | null;
  shift_code: string | null;
  shift_name: string | null;
  clock_in_at: Date;
  clock_out_at: Date | null;
  status: AttendanceStatus;
  created_at: Date;
  updated_at: Date;
};

const ATTENDANCE_SELECT = `
  SELECT
    ar.id,
    ar.client_id,
    ar.building_id,
    b.code            AS building_code,
    b.name            AS building_name,
    ar.workforce_profile_id,
    wp.employee_code,
    ar.workforce_shift_assignment_id,
    ar.shift_id,
    s.code            AS shift_code,
    s.name            AS shift_name,
    ar.clock_in_at,
    ar.clock_out_at,
    ar.status,
    ar.created_at,
    ar.updated_at
  FROM attendance_records ar
  JOIN buildings b          ON b.id = ar.building_id
  JOIN workforce_profiles wp ON wp.id = ar.workforce_profile_id
  LEFT JOIN shifts s        ON s.id = ar.shift_id
`;

function mapPublicRow(row: AttendanceDisplayRow): PublicAttendanceRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    buildingId: row.building_id,
    buildingCode: row.building_code,
    buildingName: row.building_name,
    workforceProfileId: row.workforce_profile_id,
    employeeCode: row.employee_code,
    workforceShiftAssignmentId: row.workforce_shift_assignment_id,
    shiftId: row.shift_id,
    shiftCode: row.shift_code,
    shiftName: row.shift_name,
    clockInAt: row.clock_in_at.toISOString(),
    clockOutAt: row.clock_out_at ? row.clock_out_at.toISOString() : null,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function findByIdJoined(
  id: string,
): Promise<PublicAttendanceRecord | null> {
  const result = await getPool().query<AttendanceDisplayRow>(
    `${ATTENDANCE_SELECT} WHERE ar.id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? mapPublicRow(row) : null;
}

/**
 * Inserts a CLOCKED_IN record with the database clock. Returns the joined
 * public record. `workforceShiftAssignmentId` / `shiftId` are either both
 * set (an applicable roster row was bound) or both null.
 */
export async function createAttendanceRecord(input: {
  clientId: string;
  buildingId: string;
  workforceProfileId: string;
  workforceShiftAssignmentId: string | null;
  shiftId: string | null;
}): Promise<PublicAttendanceRecord> {
  const id = randomUUID();
  const insert = await getPool().query<{ id: string }>(
    `INSERT INTO attendance_records
       (id, client_id, building_id, workforce_profile_id,
        workforce_shift_assignment_id, shift_id,
        clock_in_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), 'CLOCKED_IN')
     RETURNING id`,
    [
      id,
      input.clientId,
      input.buildingId,
      input.workforceProfileId,
      input.workforceShiftAssignmentId,
      input.shiftId,
    ],
  );
  const record = await findByIdJoined(insert.rows[0].id);
  if (!record) {
    // The INSERT succeeded; the join can only fail on a data-integrity fault.
    throw new Error('Attendance record created but could not be resolved.');
  }
  return record;
}

/** The profile's open CLOCKED_IN record, or null. */
export async function findActiveByWorkforceProfileId(
  workforceProfileId: string,
): Promise<PublicAttendanceRecord | null> {
  const result = await getPool().query<AttendanceDisplayRow>(
    `${ATTENDANCE_SELECT}
     WHERE ar.workforce_profile_id = $1 AND ar.status = 'CLOCKED_IN'
     LIMIT 1`,
    [workforceProfileId],
  );
  const row = result.rows[0];
  return row ? mapPublicRow(row) : null;
}

/**
 * Closes the profile's open record with the database clock. Returns the
 * closed public record, or null when no CLOCKED_IN record existed (the
 * "no clock-out without active attendance" rule).
 */
export async function closeActiveAttendance(
  workforceProfileId: string,
): Promise<PublicAttendanceRecord | null> {
  const update = await getPool().query<{ id: string }>(
    `UPDATE attendance_records
     SET clock_out_at = NOW(), status = 'CLOCKED_OUT', updated_at = NOW()
     WHERE workforce_profile_id = $1 AND status = 'CLOCKED_IN'
     RETURNING id`,
    [workforceProfileId],
  );
  if (!update.rows[0]) {
    return null;
  }
  return findByIdJoined(update.rows[0].id);
}

export type ApplicableShiftAssignmentRow = {
  assignment_id: string;
  shift_id: string;
  start_time: string;
  end_time: string;
  timezone: string | null;
};

/**
 * The candidate ACTIVE roster assignments for a profile at a Building whose
 * effective window contains `now` — the raw material for the optional
 * shift binding ("when available"). The daily wall-clock narrowing is done
 * by the service (never guessed here).
 */
export async function findApplicableShiftAssignments(
  workforceProfileId: string,
  buildingId: string,
  now: Date,
): Promise<ApplicableShiftAssignmentRow[]> {
  const result = await getPool().query<ApplicableShiftAssignmentRow>(
    `SELECT
       wsa.id          AS assignment_id,
       wsa.shift_id    AS shift_id,
       s.start_time,
       s.end_time,
       b.timezone
     FROM workforce_shift_assignments wsa
     JOIN shifts s    ON s.id = wsa.shift_id
     JOIN buildings b ON b.id = s.building_id
     WHERE wsa.workforce_profile_id = $1
       AND wsa.status = 'ACTIVE'
       AND s.status = 'ACTIVE'
       AND s.building_id = $2
       AND (wsa.effective_from IS NULL OR wsa.effective_from <= $3)
       AND (wsa.effective_until IS NULL OR wsa.effective_until >= $3)
     ORDER BY s.start_time ASC, s.code ASC`,
    [workforceProfileId, buildingId, now],
  );
  return result.rows;
}

/** PostgreSQL unique-violation on the partial ACTIVE index — the race backstop. */
export function isActiveAttendanceUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505' &&
    'constraint' in error &&
    (error as { constraint?: unknown }).constraint ===
      'attendance_records_active_unique'
  );
}

export const attendanceRepository = {
  closeActiveAttendance,
  createAttendanceRecord,
  findActiveByWorkforceProfileId,
  findApplicableShiftAssignments,
  isActiveAttendanceUniqueViolation,
};
