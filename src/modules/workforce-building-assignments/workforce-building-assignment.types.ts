/**
 * BE-03G — Workforce Building Assignment domain types.
 *
 * Connects an existing Workforce Profile (BE-03C) to an existing Building
 * (BE-02E):
 *
 *   Workforce Profile → Workforce Building Assignment → Building
 *
 * This is an *operational* placement — where a workforce member works. It is
 * deliberately NOT the BE-02F `User → Building Access Assignment`, which
 * governs which data a system User may *read*. The two live in separate
 * tables, are written by separate slices, and neither is derived from the
 * other. Granting a User access to a Building creates no operational
 * assignment, and assigning a workforce member to a Building grants their User
 * login no access.
 *
 * Building placement is likewise never inferred from Role, Position, Team,
 * Shift, or Supervisor: it is persisted here explicitly or it does not exist.
 *
 * One Workforce Profile may hold several Buildings at the same time, so there
 * is no single permanent `building_id` on `workforce_profiles`.
 *
 * `effectiveFrom` / `effectiveUntil` are both optional: an assignment with no
 * window is simply undated and stands until deactivated.
 */
export const WORKFORCE_BUILDING_ASSIGNMENT_STATUSES = [
  'ACTIVE',
  'INACTIVE',
] as const;

export type WorkforceBuildingAssignmentStatus =
  (typeof WORKFORCE_BUILDING_ASSIGNMENT_STATUSES)[number];

export function isWorkforceBuildingAssignmentStatus(
  value: unknown,
): value is WorkforceBuildingAssignmentStatus {
  return (
    typeof value === 'string' &&
    (WORKFORCE_BUILDING_ASSIGNMENT_STATUSES as readonly string[]).includes(
      value,
    )
  );
}

/** Full database record. */
export type WorkforceBuildingAssignmentRecord = {
  id: string;
  workforceProfileId: string;
  buildingId: string;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  status: WorkforceBuildingAssignmentStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicWorkforceBuildingAssignment = {
  id: string;
  workforceProfileId: string;
  buildingId: string;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  status: WorkforceBuildingAssignmentStatus;
};

/** Input supplied by the API consumer when assigning a Building. */
export type AssignWorkforceBuildingInput = {
  workforceProfileId: string;
  buildingId: string;
  effectiveFrom?: Date | null;
  effectiveUntil?: Date | null;
  status?: WorkforceBuildingAssignmentStatus;
};

/** Fully-resolved data ready for persistence. */
export type NewWorkforceBuildingAssignment = {
  workforceProfileId: string;
  buildingId: string;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  status: WorkforceBuildingAssignmentStatus;
};

/** Partial update input. Deactivation is `status: 'INACTIVE'`. */
export type UpdateWorkforceBuildingAssignmentInput = {
  effectiveFrom?: Date | null;
  effectiveUntil?: Date | null;
  status?: WorkforceBuildingAssignmentStatus;
};

/**
 * One *effective* Building placement, as returned by
 * `resolveBuildingsForWorkforce`. Only ACTIVE assignments whose window covers
 * the evaluation instant, pointing at ACTIVE Buildings, appear here.
 */
export type WorkforceBuildingContext = {
  assignmentId: string;
  workforceProfileId: string;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  building: {
    id: string;
    code: string;
    name: string;
    propertyId: string;
  };
};
