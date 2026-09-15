/**
 * CR-BE-MOB-05 PART 02 — Workforce Attendance domain types.
 *
 * The authoritative attendance record for authenticated workforce
 * self-service clock-in / clock-out. The record binds the authenticated
 * Workforce Profile (BE-03C), the Building the profile clocked into
 * (BE-02F/G access-asserted), and — when an applicable ACTIVE roster
 * assignment exists — the authoritative `workforce_shift_assignments.id`
 * and `shifts.id`. `clockInAt` / `clockOutAt` are always backend-set;
 * client-supplied timestamps are never accepted.
 *
 * Lifecycle (minimal, backend-authoritative):
 *   CLOCKED_IN → CLOCKED_OUT
 * A closed record is terminal and preserved. At most one CLOCKED_IN record
 * exists per Workforce Profile at a time.
 *
 * Deliberately out of scope: payroll, timesheets, overtime, leave, absence
 * management, roster/shift redesign, supervisor attendance administration,
 * GPS/geofence, biometrics, QR attendance, offline attendance, mock
 * fallback.
 */

export const ATTENDANCE_STATUSES = ['CLOCKED_IN', 'CLOCKED_OUT'] as const;

export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

export function isAttendanceStatus(value: unknown): value is AttendanceStatus {
  return (
    typeof value === 'string' &&
    (ATTENDANCE_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record (raw, no display joins). */
export type AttendanceRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  workforceProfileId: string;
  workforceShiftAssignmentId: string | null;
  shiftId: string | null;
  clockInAt: Date;
  clockOutAt: Date | null;
  status: AttendanceStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicAttendanceRecord = {
  /** `attendance_records.id` — the authoritative attendance row. */
  id: string;
  /** `clients.id` — derived Building → Property → Client, never caller-supplied. */
  clientId: string;
  /** `buildings.id` — the Building the profile clocked into. */
  buildingId: string;
  buildingCode: string;
  buildingName: string;
  /** `workforce_profiles.id` — resolved from the authenticated session. */
  workforceProfileId: string;
  employeeCode: string;
  /** `workforce_shift_assignments.id` when an applicable roster row was bound. */
  workforceShiftAssignmentId: string | null;
  /** `shifts.id` when an applicable roster row was bound. */
  shiftId: string | null;
  shiftCode: string | null;
  shiftName: string | null;
  /** Backend-set server timestamp (ISO-8601). Never client-supplied. */
  clockInAt: string;
  /** Backend-set server timestamp (ISO-8601); null while CLOCKED_IN. */
  clockOutAt: string | null;
  status: AttendanceStatus;
  createdAt: string;
  updatedAt: string;
};

/** Input for clock-in: the Building the profile is clocking into. */
export type ClockInInput = {
  buildingId: string;
};

/** Clock-out takes no payload — the open record is resolved from the session. */
export type ClockOutInput = Record<string, never>;
