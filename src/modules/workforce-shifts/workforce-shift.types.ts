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
