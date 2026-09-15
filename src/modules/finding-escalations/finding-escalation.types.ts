import type { FindingStatus } from '../findings';
import type {
  IncidentPriority,
  IncidentSeverity,
  IncidentStatus,
} from '../incidents';

/**
 * BE-21D — Finding Escalation domain types.
 *
 * A Finding Escalation is a SPECIALIZATION of the BE-21A Incident foundation
 * (`incident_type = 'FINDING_ESCALATION'`) that references an existing BE-09
 * Finding. BE-21A stays authoritative for Incident identity, Client/Building
 * context, severity, priority, reporter, and the record lifecycle. BE-09 stays
 * authoritative for the Finding itself: its state, workflow, assignment, and
 * history.
 *
 * Escalating raises INCIDENT-level visibility for a Finding. It does NOT move
 * the Finding through its own workflow, and nothing here writes Finding state.
 *
 * There is deliberately NO escalation status enum and NO transition table. The
 * two other BE-21 specializations (Operational, Asset Failure) each own a
 * handling progression because they describe work that is genuinely theirs.
 * An escalation owns no work of its own: its progress IS the Finding's
 * progress (BE-09) and its record lifecycle IS the Incident's (BE-21A).
 * Inventing a third status here would create precisely the duplicated Finding
 * state BE-21D forbids, and would immediately be able to disagree with BE-09.
 */

/**
 * Why the Finding was escalated. A closed list (mirrored by a DB CHECK) so
 * escalation reporting stays meaningful; `OTHER` is the escape hatch.
 */
export const FINDING_ESCALATION_REASONS = [
  'SLA_BREACH',
  'REPEAT_FINDING',
  'SAFETY_RISK',
  'HIGH_SEVERITY',
  'UNRESOLVED',
  'REGULATORY',
  'RESOURCE_CONSTRAINT',
  'OTHER',
] as const;

export type FindingEscalationReason =
  (typeof FINDING_ESCALATION_REASONS)[number];

export function isFindingEscalationReason(
  value: unknown,
): value is FindingEscalationReason {
  return (
    typeof value === 'string' &&
    (FINDING_ESCALATION_REASONS as readonly string[]).includes(value)
  );
}

/**
 * BE-09 states from which escalation is meaningless: the Finding is already
 * finished or withdrawn, so there is nothing left to escalate. Every other
 * state (including OPEN — an unassigned Finding may well need escalating) is
 * escalatable.
 *
 * This READS BE-09's status vocabulary; it does not redefine or extend it.
 */
export const NON_ESCALATABLE_FINDING_STATUSES: readonly FindingStatus[] = [
  'CLOSED',
  'CANCELLED',
];

export function isEscalatableFindingStatus(status: FindingStatus): boolean {
  return !NON_ESCALATABLE_FINDING_STATUSES.includes(status);
}

/**
 * Backend-authoritative actions. `UPDATE_DETAILS` is the only one: everything
 * else a user might do belongs to BE-09 (act on the Finding) or BE-21A
 * (cancel the Incident), and must be offered by those modules, not mirrored
 * here.
 */
export const FINDING_ESCALATION_ACTIONS = ['UPDATE_DETAILS'] as const;

export type FindingEscalationAction =
  (typeof FINDING_ESCALATION_ACTIONS)[number];

/** The specialization row exactly as persisted. */
export type FindingEscalationRecord = {
  id: string;
  incidentId: string;
  /** Typed FK to the BE-09 Finding. Never a copy of Finding state. */
  findingId: string;
  escalationReason: FindingEscalationReason;
  escalatedAt: Date;
  notes: string | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * The joined row: specialization + BE-21A foundation columns + the few BE-09
 * Finding columns it PROJECTS. Finding fields are prefixed `finding*` and are
 * read-only projections — BE-09 remains authoritative.
 */
export type FindingEscalationCompositeRecord = FindingEscalationRecord & {
  clientId: string;
  buildingId: string;
  incidentNumber: string;
  incidentType: 'FINDING_ESCALATION';
  title: string;
  description: string | null;
  severity: IncidentSeverity;
  priority: IncidentPriority;
  incidentStatus: IncidentStatus;
  reportedByUserId: string;
  reportedAt: Date;
  /** BE-09 projections (read-only, resolved live on every read). */
  findingClientId: string;
  findingBuildingId: string;
  findingNumber: string;
  findingTitle: string;
  findingStatus: FindingStatus;
  findingStateChangedAt: Date;
};

/** Safe public representation: one escalation, three tables, one id. */
export type PublicFindingEscalation = {
  /** The shared BE-21A Incident id — the specialization id is internal. */
  id: string;
  findingEscalationId: string;
  clientId: string;
  buildingId: string;
  incidentNumber: string;
  incidentType: 'FINDING_ESCALATION';
  title: string;
  description: string | null;
  severity: IncidentSeverity;
  priority: IncidentPriority;
  /** BE-21A record lifecycle — authoritative for whether the record stands. */
  incidentStatus: IncidentStatus;
  escalationReason: FindingEscalationReason;
  escalatedAt: string;
  notes: string | null;
  reportedByUserId: string;
  reportedAt: string;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  /**
   * The escalated BE-09 Finding, projected read-only. This is a VIEW of the
   * live Finding, never a copy: `status` always reflects BE-09's current
   * state, so the escalation cannot drift from the Finding workflow.
   */
  finding: {
    id: string;
    findingNumber: string;
    title: string;
    status: FindingStatus;
    buildingId: string;
    stateChangedAt: string;
  };
  /** Backend-resolved; the frontend must not recompute these. */
  availableActions: FindingEscalationAction[];
};

/**
 * Creation input.
 *
 * `incidentType` is absent by design (always FINDING_ESCALATION), and so are
 * `buildingId` / `clientId`: the Finding already knows its own Client and
 * Building, and re-accepting them would allow a caller to assert a context
 * that contradicts BE-09. They are DERIVED from the Finding instead.
 */
export type CreateFindingEscalationInput = {
  /** The existing BE-09 Finding being escalated. */
  findingId: string;
  incidentNumber: string;
  title: string;
  description?: string | null;
  severity?: IncidentSeverity;
  priority?: IncidentPriority;
  escalationReason: FindingEscalationReason;
  notes?: string | null;
};

export type NewFindingEscalation = {
  incidentId: string;
  findingId: string;
  escalationReason: FindingEscalationReason;
  notes: string | null;
  createdByUserId: string;
};

/**
 * `findingId` is absent by design: re-pointing an escalation at a different
 * Finding would rewrite history. Cancel the Incident (BE-21A) and escalate the
 * correct Finding instead.
 */
export type UpdateFindingEscalationInput = {
  title?: string;
  description?: string | null;
  severity?: IncidentSeverity;
  priority?: IncidentPriority;
  escalationReason?: FindingEscalationReason;
  notes?: string | null;
};

export type FindingEscalationFilters = {
  findingId?: string;
  buildingId?: string;
  escalationReason?: FindingEscalationReason;
  severity?: IncidentSeverity;
  priority?: IncidentPriority;
  /** BE-21A record lifecycle of the escalation Incident. */
  incidentStatus?: IncidentStatus;
  /** Filters on the LIVE BE-09 Finding state, projected through the JOIN. */
  findingStatus?: FindingStatus;
  escalatedFrom?: Date;
  escalatedTo?: Date;
};
