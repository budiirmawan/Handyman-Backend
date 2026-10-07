/**
 * BE-25M — Mobile Current Shift Contract types.
 *
 * A self-service effective-context read: the authenticated mobile user's
 * effective current shift(s), resolved authoritatively from the existing
 * BE-03E Shift roster (`workforce_shift_assignments`) + the BE-03C Workforce
 * Profile linked to the authenticated user + the BE-02F/G Building access
 * authority. No separate shift/attendance engine, no Shift CRUD surface, and
 * no caller-supplied identity — the caller's profile is resolved from the
 * authenticated session, never accepted from the request.
 */

/**
 * MOB-C03 PART 03B — Minimal public-safe Security Post summary for mobile
 * shift read projection. Only the authoritative backend-assigned post for
 * this roster assignment is exposed; null means no valid assigned Security Post.
 * This does not grant authorization by itself and is not attendance/patrol/handover
 * state.
 */
export type MobileSecurityPostSummary = {
  id: string;
  code: string;
  name: string;
};

/** One Shift currently in effect for the authenticated user. */
export type MobileCurrentShift = {
  /** `workforce_shift_assignments.id` — the authoritative roster row. */
  assignmentId: string;
  /** `shifts.id` — the authoritative Shift id (never an invented id). */
  shiftId: string;
  /** `workforce_profiles.id` — resolved from the authenticated user. */
  workforceProfileId: string;
  employeeCode: string;
  /** `shifts.client_id` — authoritative (derived Building → Property → Client). */
  clientId: string;
  /** `shifts.building_id` — already inside the caller's accessible Building set. */
  buildingId: string;
  buildingCode: string;
  buildingName: string;
  /** Shift `code` / `name` (definition fields, unchanged). */
  code: string;
  name: string;
  /** Wall-clock `HH:MM:SS` in the Building timezone. Overnight shifts are valid. */
  startTime: string;
  endTime: string;
  /** Always `ACTIVE` here — inactive shifts/assignments are filtered out. */
  status: string;
  /** Roster effective window (absolute); null = undated, stands until deactivated. */
  effectiveFrom: string | null;
  effectiveUntil: string | null;
  /**
   * MOB-C03 PART 03B — Backend-assigned Security Post for this roster row.
   * Nullable: null means no valid assigned Security Post (no assignment,
   * inactive post, or cross-building legacy/corrupt relation). This does not
   * grant authorization by itself and is not attendance/patrol/handover state.
   */
  securityPost: MobileSecurityPostSummary | null;
};

export type MobileCurrentShiftContext = {
  /** Instant the derivation was evaluated at (ISO-8601). */
  asOf: string;
  /** Shifts currently in effect for the caller (empty = not on shift now). */
  shifts: MobileCurrentShift[];
};

/**
 * CR-BE-MOB-05 PART 01 — Mobile Upcoming Shifts.
 *
 * One current or future shift assignment of the authenticated user, resolved
 * from the same authorities as `MobileCurrentShift` (BE-03E roster row +
 * BE-03C profile + BE-02F/G Building access). The shape is deliberately the
 * same as `MobileCurrentShift` — a roster row — so the mobile client renders
 * the schedule with the same item model. No attendance, clock, roster, or
 * schedule state is invented: only ACTIVE roster assignments of ACTIVE
 * Shifts in accessible Buildings are ever returned.
 */
export type MobileUpcomingShift = MobileCurrentShift;

/** Optional effective-window query parameters (validated before the service). */
export type UpcomingShiftsFilter = {
  /** ISO-8601 date (YYYY-MM-DD, UTC day) or datetime; inclusive lower bound. */
  dateFrom?: string;
  /** ISO-8601 date (YYYY-MM-DD, UTC day, inclusive of that day) or datetime. */
  dateTo?: string;
};

export type MobileUpcomingShiftsContext = {
  /** Instant the derivation was evaluated at (ISO-8601). */
  asOf: string;
  /**
   * The effective inclusive lower bound applied to the roster window
   * (ISO-8601). Defaults to `asOf` when `dateFrom` is omitted.
   */
  dateFrom: string;
  /**
   * The effective exclusive upper bound applied to the roster window
   * (ISO-8601), or null when unbounded (`dateTo` omitted). A date-only
   * `dateTo` is inclusive of that whole UTC day, so the exclusive bound is
   * the start of the following day.
   */
  dateTo: string | null;
  /**
   * The caller's current/future ACTIVE roster assignments whose effective
   * window overlaps `[dateFrom, dateTo)` — empty when the caller has no
   * linked ACTIVE profile, no accessible Buildings, or no matching roster.
   */
  shifts: MobileUpcomingShift[];
};
