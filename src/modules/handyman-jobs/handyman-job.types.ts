/**
 * CR-HM-BE-05 RUN 1 — Handyman execution binding types.
 *
 * A Handyman Job is a THIN, immutable identity/commercial binding between an
 * APPROVED Handyman Request (with its exact APPROVED quotation revision) and
 * the EXISTING Work Order that carries the execution lifecycle. It has NO
 * status column of its own: execution state authority stays on the BE-08
 * work order, provider authority stays on the BE-15A vendor assignment, and
 * crew authority stays on the CR-HM-BE-04 handyman work crew.
 */

/** Composition lifecycle: exactly one ACTIVE per job; history is retained. */
export const HANDYMAN_JOB_ASSIGNMENT_STATUSES = ['ACTIVE', 'SUPERSEDED'] as const;

export type HandymanJobAssignmentStatus =
  (typeof HANDYMAN_JOB_ASSIGNMENT_STATUSES)[number];

export function isHandymanJobAssignmentStatus(
  value: unknown,
): value is HandymanJobAssignmentStatus {
  return (
    typeof value === 'string' &&
    (HANDYMAN_JOB_ASSIGNMENT_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record of the thin job binding. */
export type HandymanJobRecord = {
  id: string;
  clientId: string;
  handymanRequestId: string;
  handymanQuotationId: string;
  handymanQuotationRevisionId: string;
  workOrderId: string;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Full database record of one provider+crew composition. */
export type HandymanJobAssignmentRecord = {
  id: string;
  clientId: string;
  handymanJobId: string;
  vendorAssignmentId: string;
  handymanWorkCrewId: string;
  status: HandymanJobAssignmentStatus;
  assignedAt: Date;
  assignedByUserId: string;
  supersededAt: Date | null;
  supersededByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation (IDs and lifecycle facts only — no PII). */
export type PublicHandymanJob = {
  id: string;
  clientId: string;
  handymanRequestId: string;
  handymanQuotationId: string;
  handymanQuotationRevisionId: string;
  workOrderId: string;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

/** Safe public representation of one composition (append-only history). */
export type PublicHandymanJobAssignment = {
  id: string;
  clientId: string;
  handymanJobId: string;
  vendorAssignmentId: string;
  handymanWorkCrewId: string;
  status: HandymanJobAssignmentStatus;
  assignedAt: string;
  assignedByUserId: string;
  supersededAt: string | null;
  supersededByUserId: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Input for creating the job of an APPROVED request (business identity). */
export type CreateHandymanJobInput = {
  handymanRequestId: string;
};

/**
 * Input for the ONE governed assignment command. Business identity only:
 * the caller NEVER supplies a vendor_assignment_id — the BE-15A row is
 * composed by this module inside the assignment transaction.
 */
export type AssignHandymanJobInput = {
  handymanProviderId: string;
  handymanWorkCrewId: string;
};

/** Filters for job listing (client scope is always applied separately). */
export type HandymanJobFilters = {
  handymanRequestId?: string;
  workOrderId?: string;
};

/** Result of the job creation command (idempotent at business identity). */
export type HandymanJobCreationResult = {
  job: PublicHandymanJob;
  /** false when the call converged onto an already-existing job. */
  created: boolean;
};

/** Result of an assignment/reassignment command. */
export type HandymanJobAssignmentResult = {
  job: PublicHandymanJob;
  assignment: PublicHandymanJobAssignment;
  /** The composed BE-15A provider assignment row. */
  vendorAssignmentId: string;
  /** The composed BE-15B execution context row (NOT_STARTED). */
  vendorWorkId: string;
  /** Work order status after the post-commit OPEN→ASSIGNED seam. */
  workOrderStatus: string;
};

/** Internal persistence-ready shapes. */
export type NewHandymanJob = {
  clientId: string;
  handymanRequestId: string;
  handymanQuotationId: string;
  handymanQuotationRevisionId: string;
  workOrderId: string;
  createdByUserId: string;
};

export type NewHandymanJobAssignment = {
  clientId: string;
  handymanJobId: string;
  vendorAssignmentId: string;
  handymanWorkCrewId: string;
  assignedByUserId: string;
};
