/**
 * BE-03E — Workforce Shift Assignment domain types.
 *
 * Connects an existing Workforce Profile (BE-03C) to an existing Shift:
 *
 *   Workforce Profile → Workforce Shift Assignment → Shift
 *
 * The assignment is a rostering record only. It never implies or changes a
 * Role, Permission, Position, Team, Skill, or Building Assignment, and it
 * carries no attendance, payroll, overtime, leave, timesheet, or automatic
 * scheduling behaviour.
 *
 * `effectiveFrom` / `effectiveUntil` are both optional: an assignment with no
 * window is simply undated and stands until deactivated.
 */
export const WORKFORCE_SHIFT_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type WorkforceShiftStatus = (typeof WORKFORCE_SHIFT_STATUSES)[number];

export function isWorkforceShiftStatus(
  value: unknown,
): value is WorkforceShiftStatus {
  return (
    typeof value === 'string' &&
    (WORKFORCE_SHIFT_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type WorkforceShiftAssignmentRecord = {
  id: string;
  workforceProfileId: string;
  shiftId: string;
  /**
   * MOB-C03 PART 02 — optional Security Post bound to this roster row
   * (`workforce_shift_assignments.security_post_id` → `security_posts.id`).
   * Nullable: not every role (engineering/housekeeping) works a fixed post.
   * Read/written only by the domain service for now; not on the mobile DTO.
   */
  securityPostId: string | null;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  status: WorkforceShiftStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicWorkforceShiftAssignment = {
  id: string;
  workforceProfileId: string;
  shiftId: string;
  securityPostId: string | null;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  status: WorkforceShiftStatus;
};

/** Input supplied by the API consumer when assigning a Shift. */
export type AssignWorkforceShiftInput = {
  workforceProfileId: string;
  shiftId: string;
  effectiveFrom?: Date | null;
  effectiveUntil?: Date | null;
  status?: WorkforceShiftStatus;
};

/** Fully-resolved data ready for persistence. */
export type NewWorkforceShiftAssignment = {
  workforceProfileId: string;
  shiftId: string;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  status: WorkforceShiftStatus;
};

/** Partial update input. Deactivation is `status: 'INACTIVE'`. */
export type UpdateWorkforceShiftAssignmentInput = {
  effectiveFrom?: Date | null;
  effectiveUntil?: Date | null;
  status?: WorkforceShiftStatus;
};

/**
 * MOB-C03 PART 03A — assign / clear the Security Post on an existing roster
 * row. The id addresses the `workforce_shift_assignments` row directly; an
 * explicit `null` clears the post, `undefined` is not a valid value here (the
 * caller must choose assign vs. clear). Not yet accepted by any HTTP route.
 */
export type AssignWorkforceShiftPostInput = {
  workforceShiftAssignmentId: string;
  securityPostId: string | null;
};
