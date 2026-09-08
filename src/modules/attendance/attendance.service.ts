import { AppError } from '../../shared/errors';
import { resolveAssetBuildingContext } from '../assets';
import { buildingNotFoundError, buildingRepository } from '../buildings';
import { contextAccessService } from '../context-access';
import { isWithinWindow, localTimeOfDay } from '../mobile-current-shift';
import { organizationRepository } from '../organizations';
import {
  workforceProfileInactiveError,
  workforceProfileNotFoundError,
  workforceRepository,
} from '../workforce';
import type { WorkforceProfileRecord } from '../workforce';
import {
  attendanceActiveAlreadyExistsError,
  attendanceBuildingClientMismatchError,
  attendanceNotActiveError,
} from './attendance.errors';
import {
  attendanceRepository,
  type ApplicableShiftAssignmentRow,
} from './attendance.repository';
import type {
  ClockInInput,
  PublicAttendanceRecord,
} from './attendance.types';

/**
 * CR-BE-MOB-05 PART 02 — Workforce Attendance service.
 *
 * Backend-authoritative self-service clock-in / clock-out:
 *
 *   authenticated user  → `workforce_profiles.user_id` (BE-03C, unique)
 *   building context    → `contextAccessService.assertBuildingAccess`
 *                         (BE-02F/G — the same authority data isolation uses)
 *   client identity     → derived Building → Property → Client and
 *                         Profile → Organization → Client (never caller-supplied)
 *   shift binding       → the applicable ACTIVE BE-03E roster row "when
 *                         available" (optional; never invented, never derived
 *                         from Current Shift / task / handover / Team)
 *   timestamps          → database clock only (NOW()); client timestamps are
 *                         never accepted anywhere
 *
 * Validation order (pinned by tests):
 *   1. missing / invalid buildingId          → 400 VALIDATION_ERROR
 *   2. no linked Workforce Profile           → 404 WORKFORCE_PROFILE_NOT_FOUND
 *   3. INACTIVE Workforce Profile            → 400 WORKFORCE_PROFILE_INACTIVE
 *   4. unknown Building                      → 404 BUILDING_NOT_FOUND
 *   5. inaccessible Building                 → 403 BUILDING_ACCESS_DENIED
 *      (an INACTIVE Building is never in the BE-02F/G accessible set, so it
 *      is denied here; the explicit ACTIVE check below is defense-in-depth)
 *   6. cross-Client Building                 → 400 ATTENDANCE_BUILDING_CLIENT_MISMATCH
 *   7. duplicate active clock-in             → 409 ATTENDANCE_ACTIVE_ALREADY_EXISTS
 *      (pre-check + partial unique index backstop)
 *
 * Clock-out requires an open CLOCKED_IN record — no record → 409
 * ATTENDANCE_NOT_ACTIVE. Identity and timestamps never come from the client.
 */

/** The caller's linked ACTIVE Workforce Profile; unknown/inactive is an error. */
async function requireActiveProfile(userId: string): Promise<WorkforceProfileRecord> {
  const profile = await workforceRepository.findByUserId(userId);
  if (!profile) {
    throw workforceProfileNotFoundError();
  }
  if (profile.status !== 'ACTIVE') {
    throw workforceProfileInactiveError();
  }
  return profile;
}

/** The profile's own Client, resolved Profile → Organization → Client. */
async function resolveProfileClientId(
  profile: WorkforceProfileRecord,
): Promise<string> {
  const organization = await organizationRepository.findById(
    profile.organizationId,
  );
  if (!organization) {
    // A profile always points at a real organization (enforced by FK).
    throw workforceProfileNotFoundError();
  }
  return organization.clientId;
}

/**
 * Resolves the optional shift binding. Candidates are the profile's ACTIVE
 * roster assignments at the Building whose effective window contains `now`.
 * A single candidate is bound as-is; with several candidates the wall-clock
 * current shift (BE-25M semantics, reused — not re-derived) narrows the
 * choice; any remaining ambiguity yields no binding rather than a guess.
 */
async function resolveApplicableShiftAssignment(
  workforceProfileId: string,
  buildingId: string,
  now: Date,
): Promise<{ assignmentId: string; shiftId: string } | null> {
  const rows = await attendanceRepository.findApplicableShiftAssignments(
    workforceProfileId,
    buildingId,
    now,
  );
  if (rows.length === 0) {
    return null;
  }
  if (rows.length === 1) {
    return {
      assignmentId: rows[0].assignment_id,
      shiftId: rows[0].shift_id,
    };
  }
  const current = rows.filter((row) => isWallClockCurrent(row, now));
  if (current.length === 1) {
    return {
      assignmentId: current[0].assignment_id,
      shiftId: current[0].shift_id,
    };
  }
  return null;
}

/** The roster row's wall-clock window contains `now` in the Building zone. */
function isWallClockCurrent(
  row: ApplicableShiftAssignmentRow,
  now: Date,
): boolean {
  const local = localTimeOfDay(now, row.timezone);
  return local !== null && isWithinWindow(local, row.start_time, row.end_time);
}

/** Clocks the authenticated profile into the Building. */
export async function clockInAttendance(
  input: ClockInInput,
  userId: string,
  now: Date = new Date(),
): Promise<PublicAttendanceRecord> {
  const profile = await requireActiveProfile(userId);

  const building = await buildingRepository.findById(input.buildingId);
  if (!building) {
    throw buildingNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, building.id);
  if (building.status !== 'ACTIVE') {
    throw AppError.badRequest('Building is not active.');
  }

  const { clientId } = await resolveAssetBuildingContext(building.id);
  const profileClientId = await resolveProfileClientId(profile);
  if (profileClientId !== clientId) {
    throw attendanceBuildingClientMismatchError();
  }

  const existing =
    await attendanceRepository.findActiveByWorkforceProfileId(profile.id);
  if (existing) {
    throw attendanceActiveAlreadyExistsError();
  }

  const binding = await resolveApplicableShiftAssignment(
    profile.id,
    building.id,
    now,
  );

  try {
    return await attendanceRepository.createAttendanceRecord({
      clientId,
      buildingId: building.id,
      workforceProfileId: profile.id,
      workforceShiftAssignmentId: binding?.assignmentId ?? null,
      shiftId: binding?.shiftId ?? null,
    });
  } catch (error) {
    if (attendanceRepository.isActiveAttendanceUniqueViolation(error)) {
      throw attendanceActiveAlreadyExistsError();
    }
    throw error;
  }
}

/** Closes the authenticated profile's open clock-in; no record → 409. */
export async function clockOutAttendance(
  userId: string,
): Promise<PublicAttendanceRecord> {
  const profile = await requireActiveProfile(userId);
  const closed = await attendanceRepository.closeActiveAttendance(profile.id);
  if (!closed) {
    throw attendanceNotActiveError();
  }
  return closed;
}

/**
 * The authenticated profile's open clock-in, or null. Self-service: only the
 * caller's own record is ever returned, so no permission gate or scope
 * assertion is required beyond authentication (same posture as
 * `getMobileCurrentShift`).
 */
export async function getCurrentAttendance(
  userId: string,
): Promise<PublicAttendanceRecord | null> {
  const profile = await workforceRepository.findByUserId(userId);
  if (!profile || profile.status !== 'ACTIVE') {
    return null;
  }
  return attendanceRepository.findActiveByWorkforceProfileId(profile.id);
}

export const attendanceService = {
  clockInAttendance,
  clockOutAttendance,
  getCurrentAttendance,
};
