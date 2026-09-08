import type { IncidentPriority, IncidentSeverity, IncidentStatus, IncidentType } from '../incidents';

/**
 * BE-21K — Incident Closure domain types.
 *
 * Closure is a STATE OF THE BE-21A INCIDENT, not an entity of its own, so
 * this module owns no table. It contributes:
 *   - the readiness rules (pure, testable without fixtures),
 *   - the fact-gathering projection those rules consume,
 *   - the closing operation itself.
 *
 * The readiness verdict is COMPUTED on every read, exactly like BE-21F
 * investigation readiness. Nothing about "can this be closed" is stored:
 * closure readiness changes whenever a corrective action or verification
 * changes, with no event to react to, so a persisted flag would be stale the
 * moment it was written.
 */

/** A machine-readable reason closure is blocked. */
export type ClosureBlockerCode =
  | 'INCIDENT_NOT_REPORTED'
  | 'INCIDENT_ALREADY_CLOSED'
  | 'INCIDENT_CANCELLED'
  | 'NO_CORRECTIVE_ACTION'
  | 'CORRECTIVE_ACTION_UNRESOLVED'
  | 'CORRECTIVE_ACTION_UNVERIFIED'
  | 'VERIFICATION_REWORK_REQUIRED'
  | 'VERIFICATION_NOT_APPROVED'
  | 'VERIFICATION_PENDING';

export type ClosureBlocker = {
  code: ClosureBlockerCode;
  message: string;
};

/**
 * The facts closure is judged from, gathered in ONE query.
 *
 * Counts rather than rows: the rules need to know how many corrective actions
 * are outstanding, not what they say, and listing closure status across a
 * Building must not become one query per Incident.
 */
export type IncidentClosureFacts = {
  incidentId: string;
  clientId: string;
  buildingId: string;
  incidentNumber: string;
  incidentType: IncidentType;
  title: string;
  severity: IncidentSeverity;
  priority: IncidentPriority;
  status: IncidentStatus;
  reportedAt: Date;
  closedAt: Date | null;
  closedByUserId: string | null;
  closureNotes: string | null;
  /**
   * REQUIRED corrective actions: every one that is still a live obligation.
   * REJECTED and CANCELLED proposals are excluded — a refused or called-off
   * remedy is not work anyone still owes, and demanding its completion would
   * make an Incident permanently uncloseable.
   */
  requiredActionCount: number;
  /** Required actions not yet at a settled outcome (PROPOSED/APPROVED/IN_PROGRESS). */
  unresolvedActionCount: number;
  /** Required actions completed but not yet VERIFIED. */
  unverifiedActionCount: number;
  /** Required actions at VERIFIED. */
  verifiedActionCount: number;
  /** Required actions whose LATEST verification decision was REWORK_REQUIRED. */
  reworkRequiredCount: number;
  /** Required actions whose LATEST verification decision was REJECTED. */
  rejectedVerificationCount: number;
  /** Required actions with a verification still open (PENDING). */
  pendingVerificationCount: number;
};

/** The computed closure verdict returned by the API. */
export type IncidentClosureStatus = {
  incidentId: string;
  clientId: string;
  buildingId: string;
  incidentNumber: string;
  incidentType: IncidentType;
  title: string;
  severity: IncidentSeverity;
  priority: IncidentPriority;
  incidentStatus: IncidentStatus;
  reportedAt: string;
  /** True only when the Incident can be closed RIGHT NOW. */
  closeable: boolean;
  /** Everything standing in the way; empty when `closeable`. */
  blockers: ClosureBlocker[];
  /** True once CLOSED — terminal. */
  closed: boolean;
  closedAt: string | null;
  closedByUserId: string | null;
  closureNotes: string | null;
  facts: {
    requiredActionCount: number;
    unresolvedActionCount: number;
    unverifiedActionCount: number;
    verifiedActionCount: number;
    reworkRequiredCount: number;
    rejectedVerificationCount: number;
    pendingVerificationCount: number;
  };
  evaluatedAt: string;
};

export type CloseIncidentInput = {
  closureNotes?: string | null;
};

export type IncidentClosureFilters = {
  buildingId?: string;
  incidentType?: IncidentType;
  status?: IncidentStatus;
  /** Post-evaluation filter: readiness is computed, not stored. */
  closeable?: boolean;
};
