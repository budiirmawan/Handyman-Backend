import type { CorrectiveActionStatus } from '../corrective-actions';
import type { IncidentStatus, IncidentType } from '../incidents';
import type { WorkforceStatus, WorkforceType } from '../workforce';

/**
 * BE-21H — Responsible Person domain types.
 *
 * Records WHO is accountable for a BE-21G Corrective Action, by REFERENCE to
 * an existing BE-03C Workforce Profile.
 *
 * NO PERSON DATA IS DUPLICATED. This module stores exactly one identity
 * field, `workforceProfileId`. Names, employee codes, and org placement are
 * READ through the FK and appear only in the projected `responsiblePerson`
 * view below — never in a column, never in an input.
 *
 * DELIBERATELY ABSENT: any due/target date. That is BE-21I, the next PART.
 */

/**
 * An assignment is ACTIVE or superseded. Reassignment deactivates and inserts
 * rather than mutating, so the chain of accountability stays auditable —
 * matching BE-09's `finding_assignments`.
 */
export const RESPONSIBILITY_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type ResponsibilityStatus = (typeof RESPONSIBILITY_STATUSES)[number];

export function isResponsibilityStatus(
  value: unknown,
): value is ResponsibilityStatus {
  return (
    typeof value === 'string' &&
    (RESPONSIBILITY_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Corrective Action states that may receive or change a responsible person.
 *
 * Assigning accountability for work that was refused, finished, or called off
 * is meaningless, so the terminal states are excluded. PROPOSED is included:
 * naming who would carry the work out is a normal part of putting a proposal
 * forward.
 */
export const ASSIGNABLE_CORRECTIVE_ACTION_STATUSES: readonly CorrectiveActionStatus[] =
  ['PROPOSED', 'APPROVED', 'IN_PROGRESS'];

export function isAssignableCorrectiveActionStatus(
  status: CorrectiveActionStatus,
): boolean {
  return ASSIGNABLE_CORRECTIVE_ACTION_STATUSES.includes(status);
}

/** The row exactly as persisted — one identity FK, no copied person data. */
export type CorrectiveActionResponsibilityRecord = {
  id: string;
  correctiveActionId: string;
  workforceProfileId: string;
  responsibilityNote: string | null;
  status: ResponsibilityStatus;
  assignedByUserId: string;
  assignedAt: Date;
  releasedAt: Date | null;
  releasedByUserId: string | null;
  releaseReason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * The joined row: the assignment plus the context it RESOLVES through its
 * foreign keys — the Corrective Action, its Incident, and the Workforce
 * Profile. Every one of these is read, never stored on the assignment.
 */
export type CorrectiveActionResponsibilityCompositeRecord =
  CorrectiveActionResponsibilityRecord & {
    // From corrective_actions → incidents (BE-21G / BE-21A).
    incidentId: string;
    clientId: string;
    buildingId: string;
    incidentNumber: string;
    incidentType: IncidentType;
    incidentStatus: IncidentStatus;
    correctiveActionStatus: CorrectiveActionStatus;
    // From workforce_profiles (BE-03C) — projected, never persisted here.
    workforceFullName: string;
    workforceEmployeeCode: string;
    workforceStatus: WorkforceStatus;
    workforceType: WorkforceType;
    workforceOrganizationId: string;
    workforceDepartmentId: string;
    workforceTeamId: string | null;
    workforceUserId: string | null;
  };

/**
 * The person, projected read-only from BE-03C at request time.
 *
 * This is a VIEW of `workforce_profiles`, not a copy: it is rebuilt on every
 * read, so a rename or transfer is reflected immediately and this record can
 * never disagree with the personnel record.
 */
export type ResponsiblePersonView = {
  workforceProfileId: string;
  fullName: string;
  employeeCode: string;
  status: WorkforceStatus;
  workforceType: WorkforceType;
  organizationId: string;
  departmentId: string;
  teamId: string | null;
  /** The linked BE-01 User, or null — a profile need not have an account. */
  userId: string | null;
};

/** Safe public representation. */
export type PublicCorrectiveActionResponsibility = {
  id: string;
  correctiveActionId: string;
  /** Resolved context, projected read-only from BE-21G / BE-21A. */
  incidentId: string;
  clientId: string;
  buildingId: string;
  incidentNumber: string;
  incidentType: IncidentType;
  incidentStatus: IncidentStatus;
  correctiveActionStatus: CorrectiveActionStatus;
  /** The referenced identity, resolved fresh on every read. */
  responsiblePerson: ResponsiblePersonView;
  responsibilityNote: string | null;
  status: ResponsibilityStatus;
  assignedByUserId: string;
  assignedAt: string;
  releasedAt: string | null;
  releasedByUserId: string | null;
  releaseReason: string | null;
  createdAt: string;
  updatedAt: string;
  /** Backend-resolved; the frontend must not recompute these. */
  availableActions: ResponsibilityAction[];
};

export const RESPONSIBILITY_ACTIONS = [
  'REASSIGN',
  'UPDATE_NOTE',
  'RELEASE',
] as const;

export type ResponsibilityAction = (typeof RESPONSIBILITY_ACTIONS)[number];

/**
 * Assignment input.
 *
 * `workforceProfileId` is the ONLY way to name the person. There is
 * deliberately no `fullName`, `email`, or `employeeCode` field: accepting one
 * would invite a caller to describe a person the system already knows, and
 * the two descriptions would eventually disagree.
 */
export type AssignResponsiblePersonInput = {
  workforceProfileId: string;
  responsibilityNote?: string | null;
};

export type NewCorrectiveActionResponsibility = {
  correctiveActionId: string;
  workforceProfileId: string;
  responsibilityNote: string | null;
  assignedByUserId: string;
};

/**
 * Update input.
 *
 * Supplying a different `workforceProfileId` is a REASSIGNMENT: the current
 * row is deactivated and a new one inserted, never edited in place. Omitting
 * it edits only the note on the existing assignment.
 */
export type UpdateResponsiblePersonInput = {
  workforceProfileId?: string;
  responsibilityNote?: string | null;
  /** Recorded on the superseded row when reassigning. */
  releaseReason?: string | null;
};

export type ReleaseResponsiblePersonInput = {
  releaseReason?: string | null;
};

export type CorrectiveActionResponsibilityFilters = {
  correctiveActionId?: string;
  incidentId?: string;
  buildingId?: string;
  workforceProfileId?: string;
  status?: ResponsibilityStatus;
};
