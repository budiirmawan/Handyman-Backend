/**
 * CR-HM-INSPECTION-01 PART A — pre-quotation Field inspection assignment
 * types.
 *
 * The assignment is a request-scoped business fact about WHO may perform the
 * pre-quotation physical inspection and submit its Field reports. It is NOT
 * CR-HM-04 execution assignment (no provider/crew/Lead/Execution Scope) and
 * it carries no quotation, price, customer-approval or scheduling meaning.
 *
 * The target identity is the existing authenticated local `users.id`
 * (FROZEN F7) — never a PIC, attribution, BM or provider identity.
 */

export const HANDYMAN_INSPECTION_ASSIGNMENT_STATUSES = [
  'ACTIVE',
  'SUPERSEDED',
] as const;
export type HandymanInspectionAssignmentStatus =
  (typeof HANDYMAN_INSPECTION_ASSIGNMENT_STATUSES)[number];

/** Authoritative assignment fact (immutable except its supersession). */
export type HandymanInspectionAssignmentRecord = {
  id: string;
  /** Tenant-isolation root, snapshotted verbatim from the request row. */
  clientId: string;
  handymanRequestId: string;
  /** Provenance handle, snapshotted verbatim from the request row. */
  channelAttributionId: string;
  buildingId: string;
  /** The ONLY Field identity: an active local user id. */
  assignedFieldUserId: string;
  /** Operations actor that created this assignment fact. */
  assignedByUserId: string;
  assignedAt: Date;
  status: HandymanInspectionAssignmentStatus;
  supersededAt: Date | null;
  supersededByAssignmentId: string | null;
  supersedesAssignmentId: string | null;
  /** Mandatory on reassignment; never present on the first assignment. */
  supersessionReason: string | null;
};

/** Caller input — context/snapshot fields are NEVER input. */
export type AssignHandymanInspectionFieldInput = {
  handymanRequestId: string;
  /** Target local user id (validated: ACTIVE + report permission + scope). */
  assignedFieldUserId: string;
  /** Required only when the request already carries an active assignment. */
  reassignmentReason?: string;
};

/** Fully-resolved row ready for persistence (snapshot + actor applied). */
export type NewHandymanInspectionAssignmentRecord = Omit<
  HandymanInspectionAssignmentRecord,
  'id' | 'assignedAt' | 'status' | 'supersededAt' | 'supersededByAssignmentId'
  | 'supersedesAssignmentId' | 'supersessionReason'
> & {
  id: string;
  supersedesAssignmentId: string | null;
  supersessionReason: string | null;
};

/** Safe public representation (timestamps ISO). */
export type PublicHandymanInspectionAssignment = Omit<
  HandymanInspectionAssignmentRecord,
  'assignedAt' | 'supersededAt'
> & {
  assignedAt: string;
  supersededAt: string | null;
};

/**
 * Bounded read shape: the current active assignment plus the immutable
 * supersession history of the request (oldest first).
 */
export type PublicHandymanInspectionAssignmentState = {
  current: PublicHandymanInspectionAssignment | null;
  history: PublicHandymanInspectionAssignment[];
};
