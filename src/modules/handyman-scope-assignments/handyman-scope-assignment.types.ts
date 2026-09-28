/**
 * CR-HM-04 Execution Scope Assignment Activation PART B — types
 * (FROZEN `CR-HM-04_EXECUTION_SCOPE_ASSIGNMENT_ACTIVATION.md` §3–§5).
 *
 * Provider-authored crew assignment binding (CR-HM-04 F7) whose
 * ONLY target is `HANDYMAN_EXECUTION_SCOPE` (PART 06 §1/§3). Minimal
 * persistent model per §3; NO Lead snapshot (lead resolves from
 * CR-HM-04 crew authority dynamically, §5); NO caller/request fields;
 * NO scheduling/arrival/QR/geofence/work-session/FM surface (§7).
 */

export const HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_STATUSES = [
  'ACTIVE',
  'SUPERSEDED',
] as const;
export type HandymanExecutionScopeAssignmentStatus =
  (typeof HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_STATUSES)[number];

export function isHandymanExecutionScopeAssignmentStatus(
  value: unknown,
): value is HandymanExecutionScopeAssignmentStatus {
  const allowed =
    HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_STATUSES as readonly string[];
  return typeof value === 'string' && allowed.includes(value);
}

/** Full assignment database record (append-only facts + status). */
export type HandymanExecutionScopeAssignmentRecord = {
  id: string;
  clientId: string;
  executionScopeId: string;
  handymanProviderContextId: string;
  handymanCrewId: string;
  status: HandymanExecutionScopeAssignmentStatus;
  assignedByUserId: string;
  assignedAt: Date;
  supersedesAssignmentId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation (timestamps ISO). */
export type PublicHandymanExecutionScopeAssignment = Omit<
  HandymanExecutionScopeAssignmentRecord,
  'assignedAt' | 'createdAt' | 'updatedAt'
> & {
  assignedAt: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * Caller input: the three caller-established references ONLY.
 * clientId / status / leadWorkerId / leadUserId / assignedAt /
 * supersedesAssignmentId are NEVER caller input (server-derived;
 * smuggled keys never trusted).
 */
export type AssignHandymanExecutionScopeCrewInput = {
  executionScopeId: string;
  providerContextId: string;
  crewId: string;
};

/** Fully-resolved row ready for persistence (server-derived). */
export type NewHandymanExecutionScopeAssignment = {
  clientId: string;
  executionScopeId: string;
  handymanProviderContextId: string;
  handymanCrewId: string;
  status: 'ACTIVE';
  assignedByUserId: string;
  supersedesAssignmentId: string | null;
};

/**
 * Bounded Lead resolver result (§5): the authoritative field actor
 * chain for CR-HM-07. Dynamic — composed at read time from the
 * ACTIVE assignment + current CR-HM-04 crew Lead + ACTIVE worker
 * context + non-NULL workforce userId; never stored on the
 * assignment (no snapshot columns).
 */
export type HandymanAssignmentLeadResolution = {
  assignmentId: string;
  crewId: string;
  leadWorkerContextId: string;
  leadUserId: string;
};
