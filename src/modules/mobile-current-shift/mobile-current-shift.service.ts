import { contextAccessService } from '../context-access';
import { workforceRepository } from '../workforce/workforce.repository';
import { getPool } from '../../database';
import type {
  MobileCurrentShift,
  MobileCurrentShiftContext,
  MobileUpcomingShift,
  MobileUpcomingShiftsContext,
  UpcomingShiftsFilter,
} from './mobile-current-shift.types';

/**
 * BE-25M — Mobile Current Shift service.
 *
 * Derives the authenticated user's effective current shift(s) from the
 * existing authorities only:
 *
 *   authenticated user  → `workforce_profiles.user_id` (BE-03C, unique)
 *   building assignment → `contextAccessService.getAccessibleBuildingIds`
 *                         (BE-02F/G — the same source data isolation uses)
 *   shift roster        → `workforce_shift_assignments` (BE-03E, ACTIVE +
 *                         optional `effective_from`/`effective_until`)
 *   current date/time   → the wall-clock window check below
 *   Shift lifecycle     → only ACTIVE Shifts; overnight windows (end < start)
 *                         are honoured
 *
 * A Shift is "current" only when ALL of the following hold:
 *   1. the caller has a linked ACTIVE Workforce Profile;
 *   2. that profile has an ACTIVE roster assignment whose absolute effective
 *      window (when set) contains `now`;
 *   3. the Shift is ACTIVE and its Building is in the caller's accessible set;
 *   4. the Building has an IANA `timezone` (otherwise the local wall-clock
 *      cannot be determined and "current" cannot be affirmed — the row is
 *      excluded, never guessed); and
 *   5. the current time-of-day in that timezone falls inside the Shift's
 *      `start_time`/`end_time` window (overnight-aware).
 *
 * No Shift CRUD is exposed here; only the caller's own roster is returned.
 * Identity is never accepted from the caller — `userId` comes from the
 * authenticated session.
 */

type CurrentShiftRow = {
  assignment_id: string;
  shift_id: string;
  effective_from: Date | null;
  effective_until: Date | null;
  client_id: string;
  building_id: string;
  building_code: string;
  building_name: string;
  building_timezone: string | null;
  shift_code: string;
  shift_name: string;
  start_time: string;
  end_time: string;
  shift_status: string;
};

const CURRENT_SHIFT_SELECT = `
  SELECT
    wsa.id           AS assignment_id,
    wsa.shift_id     AS shift_id,
    wsa.effective_from,
    wsa.effective_until,
    s.client_id,
    s.building_id,
    b.code           AS building_code,
    b.name           AS building_name,
    b.timezone       AS building_timezone,
    s.code           AS shift_code,
    s.name           AS shift_name,
    s.start_time,
    s.end_time,
    s.status         AS shift_status
  FROM workforce_shift_assignments wsa
  JOIN shifts s        ON s.id = wsa.shift_id
  JOIN buildings b     ON b.id = s.building_id
  WHERE wsa.workforce_profile_id = $1
    AND wsa.status = 'ACTIVE'
    AND s.status = 'ACTIVE'
    AND s.building_id = ANY($2::uuid[])
    AND (wsa.effective_from IS NULL OR wsa.effective_from <= $3)
    AND (wsa.effective_until IS NULL OR wsa.effective_until >= $3)
  ORDER BY b.code ASC, s.start_time ASC, s.code ASC
`;

async function listActiveRosterRows(
  workforceProfileId: string,
  buildingIds: string[],
  now: Date,
): Promise<CurrentShiftRow[]> {
  if (buildingIds.length === 0) {
    return [];
  }
  const result = await getPool().query<CurrentShiftRow>(CURRENT_SHIFT_SELECT, [
    workforceProfileId,
    buildingIds,
    now,
  ]);
  return result.rows;
}

/**
 * Resolves the effective current shifts for the authenticated user. `now` is
 * injectable only for deterministic tests; the route always uses the real
 * current instant.
 */
export async function resolveCurrentShifts(
  userId: string,
  now: Date = new Date(),
): Promise<MobileCurrentShiftContext> {
  const profile = await workforceRepository.findByUserId(userId);
  if (!profile || profile.status !== 'ACTIVE') {
    return { asOf: now.toISOString(), shifts: [] };
  }

  const buildingIds = await contextAccessService.getAccessibleBuildingIds(
    userId,
  );
  if (buildingIds.length === 0) {
    return { asOf: now.toISOString(), shifts: [] };
  }

  const rows = await listActiveRosterRows(profile.id, buildingIds, now);

  const shifts: MobileCurrentShift[] = [];
  for (const row of rows) {
    const local = localTimeOfDay(now, row.building_timezone);
    if (local === null) {
      // No valid Building timezone → the local wall-clock cannot be
      // determined, so "current" cannot be affirmed. Exclude; never guess.
      continue;
    }
    if (!isWithinWindow(local, row.start_time, row.end_time)) {
      continue;
    }

    shifts.push(toMobileShift(row, profile));
  }

  return { asOf: now.toISOString(), shifts };
}

/* ---------------------------------------------------------------------- */
/*  CR-BE-MOB-05 PART 01 — Mobile Upcoming Shifts                          */
/* ---------------------------------------------------------------------- */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const UPCOMING_SHIFT_SELECT = `
  SELECT
    wsa.id           AS assignment_id,
    wsa.shift_id     AS shift_id,
    wsa.effective_from,
    wsa.effective_until,
    s.client_id,
    s.building_id,
    b.code           AS building_code,
    b.name           AS building_name,
    b.timezone       AS building_timezone,
    s.code           AS shift_code,
    s.name           AS shift_name,
    s.start_time,
    s.end_time,
    s.status         AS shift_status
  FROM workforce_shift_assignments wsa
  JOIN shifts s        ON s.id = wsa.shift_id
  JOIN buildings b     ON b.id = s.building_id
  WHERE wsa.workforce_profile_id = $1
    AND wsa.status = 'ACTIVE'
    AND s.status = 'ACTIVE'
    AND s.building_id = ANY($2::uuid[])
    AND (wsa.effective_from IS NULL OR $3::timestamptz IS NULL
         OR wsa.effective_from < $3)
    AND (wsa.effective_until IS NULL OR $4::timestamptz IS NULL
         OR wsa.effective_until >= $4)
  ORDER BY (wsa.effective_from IS NULL) DESC,
           wsa.effective_from ASC,
           b.code ASC,
           s.start_time ASC,
           s.code ASC
`;

/**
 * A roster assignment is "upcoming" when its absolute effective window
 * overlaps the half-open query window `[start, end)`:
 *
 *   (effective_from IS NULL OR effective_from < end)   -- not all past
 *   (effective_until IS NULL OR effective_until >= start) -- not yet ended
 *
 * A null roster bound or a null `end` is unbounded. With the default window
 * (`start` = now, `end` = null) this returns every ACTIVE assignment that has
 * not ended yet — the currently effective roster AND future-dated roster.
 * Expired assignments are excluded. The daily wall-clock window is NOT
 * evaluated here (that is the BE-25M current-shift authority, deliberately
 * not duplicated): the schedule lists the caller's rostered shifts, and
 * `getMobileCurrentShift` remains the single authority for "what is live
 * right now".
 */
async function listUpcomingRosterRows(
  workforceProfileId: string,
  buildingIds: string[],
  start: Date,
  end: Date | null,
): Promise<CurrentShiftRow[]> {
  if (buildingIds.length === 0) {
    return [];
  }
  const result = await getPool().query<CurrentShiftRow>(
    UPCOMING_SHIFT_SELECT,
    [workforceProfileId, buildingIds, end, start],
  );
  return result.rows;
}

/**
 * Resolves the caller's current/future shift assignments as an authoritative
 * read-only schedule. `now` is injectable only for deterministic tests; the
 * route always uses the real current instant. Identity is never accepted from
 * the caller — `userId` comes from the authenticated session.
 */
export async function resolveUpcomingShifts(
  userId: string,
  filters: UpcomingShiftsFilter = {},
  now: Date = new Date(),
): Promise<MobileUpcomingShiftsContext> {
  const range = upcomingShiftRange(filters, now);

  const empty: MobileUpcomingShiftsContext = {
    asOf: now.toISOString(),
    dateFrom: range.start.toISOString(),
    dateTo: range.end ? range.end.toISOString() : null,
    shifts: [],
  };

  const profile = await workforceRepository.findByUserId(userId);
  if (!profile || profile.status !== 'ACTIVE') {
    return empty;
  }

  const buildingIds = await contextAccessService.getAccessibleBuildingIds(
    userId,
  );
  if (buildingIds.length === 0) {
    return empty;
  }

  const rows = await listUpcomingRosterRows(
    profile.id,
    buildingIds,
    range.start,
    range.end,
  );

  const shifts: MobileUpcomingShift[] = rows
    .filter((row) => hasValidTimeZone(row.building_timezone))
    .map((row) => toMobileShift(row, profile));

  return {
    asOf: now.toISOString(),
    dateFrom: range.start.toISOString(),
    dateTo: range.end ? range.end.toISOString() : null,
    shifts,
  };
}

/**
 * Converts the validated filter into the effective half-open window. A
 * date-only `dateTo` is inclusive of that whole UTC day (the exclusive bound
 * is the start of the following day), matching the BE-23G reporting window
 * convention. `dateFrom` defaults to `now`.
 */
function upcomingShiftRange(
  filters: UpcomingShiftsFilter,
  now: Date,
): { start: Date; end: Date | null } {
  const start = filters.dateFrom ? new Date(filters.dateFrom) : now;
  let end: Date | null = null;
  if (filters.dateTo) {
    const to = new Date(filters.dateTo);
    end = DATE_ONLY.test(filters.dateTo)
      ? new Date(to.getTime() + 86400000)
      : to;
  }
  return { start, end };
}

/** A Building timezone must be present and a valid IANA zone to be exposed. */
function hasValidTimeZone(timeZone: string | null): boolean {
  if (!timeZone) {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format();
    return true;
  } catch {
    // Unknown/invalid IANA zone → wall-clock times cannot be interpreted.
    return false;
  }
}

/** Maps a roster row to the shared public shift shape (ids unchanged). */
function toMobileShift(
  row: CurrentShiftRow,
  profile: { id: string; employeeCode: string },
): MobileCurrentShift {
  return {
    assignmentId: row.assignment_id,
    shiftId: row.shift_id,
    workforceProfileId: profile.id,
    employeeCode: profile.employeeCode,
    clientId: row.client_id,
    buildingId: row.building_id,
    buildingCode: row.building_code,
    buildingName: row.building_name,
    code: row.shift_code,
    name: row.shift_name,
    startTime: row.start_time,
    endTime: row.end_time,
    status: row.shift_status,
    effectiveFrom: row.effective_from
      ? row.effective_from.toISOString()
      : null,
    effectiveUntil: row.effective_until
      ? row.effective_until.toISOString()
      : null,
  };
}

/** Wall-clock `HH:MM:SS` at `now` in the given IANA zone; null if not derivable. */
export function localTimeOfDay(
  now: Date,
  timeZone: string | null,
): string | null {
  if (!timeZone) {
    return null;
  }
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(now);
    const get = (type: Intl.DateTimeFormatPartTypes): string =>
      parts.find((part) => part.type === type)?.value ?? '00';
    return `${get('hour')}:${get('minute')}:${get('second')}`;
  } catch {
    // Unknown/invalid IANA zone → the wall-clock is not derivable.
    return null;
  }
}

function secondsOfDay(value: string): number {
  const [h, m, s] = value.split(':').map((part) => Number(part) || 0);
  return h * 3600 + m * 60 + s;
}

/**
 * `start`/`end` are wall-clock `HH:MM:SS`. `start < end` is a same-day window
 * (end exclusive); `start > end` is an overnight window (now >= start OR
 * now < end). A zero-length window never occurs (schema backstop) and is
 * treated as never-current.
 */
export function isWithinWindow(
  local: string,
  start: string,
  end: string,
): boolean {
  const now = secondsOfDay(local);
  const from = secondsOfDay(start);
  const to = secondsOfDay(end);
  if (from === to) {
    return false;
  }
  if (from < to) {
    return now >= from && now < to;
  }
  return now >= from || now < to;
}

export const mobileCurrentShiftService = {
  resolveCurrentShifts,
  resolveUpcomingShifts,
};
