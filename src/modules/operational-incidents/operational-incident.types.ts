import type {
  IncidentLocationType,
  IncidentPriority,
  IncidentSeverity,
  IncidentStatus,
} from '../incidents';

/**
 * BE-21B — Operational Incident domain types.
 *
 * An Operational Incident is a SPECIALIZATION of the BE-21A Incident
 * foundation with `incident_type = 'OPERATIONAL'`. BE-21A stays authoritative
 * for Incident identity (`incidentNumber`), Client / Building context,
 * Location, title, description, severity, priority, reporter, and the record
 * lifecycle. None of those are stored again here — the public view composes
 * them from the foundation.
 *
 * Only four things are genuinely new: the operational category, when the
 * incident actually occurred, the operational handling status, and notes.
 */

/**
 * The controlled operational vocabulary. Kept as a closed list (mirrored by a
 * DB CHECK) rather than free text so filtering and reporting stay meaningful;
 * `OTHER` is the deliberate escape hatch instead of an open string.
 */
export const OPERATIONAL_INCIDENT_CATEGORIES = [
  'UTILITY_FAILURE',
  'ELECTRICAL',
  'PLUMBING',
  'HVAC',
  'LIFT_ESCALATOR',
  'FIRE_SAFETY',
  'WATER_LEAK',
  'STRUCTURAL',
  'ENVIRONMENTAL',
  'HOUSEKEEPING',
  'SECURITY',
  'SAFETY',
  'ACCESS',
  'OTHER',
] as const;

export type OperationalIncidentCategory =
  (typeof OPERATIONAL_INCIDENT_CATEGORIES)[number];

export function isOperationalIncidentCategory(
  value: unknown,
): value is OperationalIncidentCategory {
  return (
    typeof value === 'string' &&
    (OPERATIONAL_INCIDENT_CATEGORIES as readonly string[]).includes(value)
  );
}

/**
 * Operational handling progression — deliberately distinct from the BE-21A
 * record lifecycle (`REPORTED` / `CANCELLED`). This says how far the response
 * has got; the foundation says whether the record stands at all.
 *
 * Investigation, corrective action, verification, and closure are later BE-21
 * PARTs: `RESOLVED` here means "operational handling finished", NOT verified
 * or closed. Those must extend this progression, not fork it.
 */
export const OPERATIONAL_INCIDENT_STATUSES = [
  'OPEN',
  'IN_PROGRESS',
  'RESOLVED',
] as const;

export type OperationalIncidentStatus =
  (typeof OPERATIONAL_INCIDENT_STATUSES)[number];

export function isOperationalIncidentStatus(
  value: unknown,
): value is OperationalIncidentStatus {
  return (
    typeof value === 'string' &&
    (OPERATIONAL_INCIDENT_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * The explicit, closed transition table. A small lookup — NOT a generic
 * workflow engine, and not a second copy of BE-09's engine. BE-09 remains
 * authoritative for Finding workflow; this governs only operational handling.
 *
 *   OPEN        → IN_PROGRESS, RESOLVED
 *   IN_PROGRESS → RESOLVED, OPEN (reopen while handling continues)
 *   RESOLVED    → IN_PROGRESS (reopen when the issue recurs)
 */
export const OPERATIONAL_INCIDENT_TRANSITIONS: Record<
  OperationalIncidentStatus,
  readonly OperationalIncidentStatus[]
> = {
  OPEN: ['IN_PROGRESS', 'RESOLVED'],
  IN_PROGRESS: ['RESOLVED', 'OPEN'],
  RESOLVED: ['IN_PROGRESS'],
};

export function canTransitionOperationalIncidentStatus(
  from: OperationalIncidentStatus,
  to: OperationalIncidentStatus,
): boolean {
  return OPERATIONAL_INCIDENT_TRANSITIONS[from].includes(to);
}

/**
 * Backend-authoritative actions, mirroring the BE-09 `available_actions`
 * convention. Always computed per request from state × permission × the
 * foundation lifecycle — never persisted, never derived by the client.
 */
export const OPERATIONAL_INCIDENT_ACTIONS = [
  'START_PROGRESS',
  'RESOLVE',
  'REOPEN',
  'UPDATE_DETAILS',
] as const;

export type OperationalIncidentAction =
  (typeof OPERATIONAL_INCIDENT_ACTIONS)[number];

/**
 * The single source of truth linking a legal transition to the action that
 * offers it. Deriving `availableActions` from this map (rather than a parallel
 * hand-written list) makes it impossible for a permitted transition to become
 * undiscoverable, or for an advertised action to be rejected on execution.
 */
export const OPERATIONAL_INCIDENT_TRANSITION_ACTIONS: {
  readonly [From in OperationalIncidentStatus]: {
    readonly [To in OperationalIncidentStatus]?: OperationalIncidentAction;
  };
} = {
  OPEN: { IN_PROGRESS: 'START_PROGRESS', RESOLVED: 'RESOLVE' },
  IN_PROGRESS: { RESOLVED: 'RESOLVE', OPEN: 'REOPEN' },
  RESOLVED: { IN_PROGRESS: 'REOPEN' },
};

/** Status-driven actions (permission and lifecycle gating happen upstream). */
export function operationalIncidentTransitionActions(
  from: OperationalIncidentStatus,
): OperationalIncidentAction[] {
  return OPERATIONAL_INCIDENT_TRANSITIONS[from].map((to) => {
    const action = OPERATIONAL_INCIDENT_TRANSITION_ACTIONS[from][to];
    if (!action) {
      throw new Error(
        `Operational Incident transition ${from} → ${to} has no action mapping`,
      );
    }
    return action;
  });
}

/** The specialization row exactly as persisted. */
export type OperationalIncidentRecord = {
  id: string;
  incidentId: string;
  operationalCategory: OperationalIncidentCategory;
  occurredAt: Date;
  operationalStatus: OperationalIncidentStatus;
  statusChangedAt: Date;
  notes: string | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
  /** CR-BE-RN17-SECURITY-INCIDENT-FIELD-01 — reporting-time field context. Nullable, only SECURITY derives it. */
  reportedShiftAssignmentId: string | null;
  reportedSecurityPostId: string | null;
};

/**
 * The joined row: specialization + the BE-21A foundation columns it reuses.
 * Foundation fields are READ from `incidents`, never stored here.
 */
export type OperationalIncidentCompositeRecord = OperationalIncidentRecord & {
  clientId: string;
  buildingId: string;
  incidentNumber: string;
  incidentType: 'OPERATIONAL';
  title: string;
  description: string | null;
  severity: IncidentSeverity;
  priority: IncidentPriority;
  incidentStatus: IncidentStatus;
  locationType: IncidentLocationType | null;
  floorId: string | null;
  areaId: string | null;
  roomId: string | null;
  spaceId: string | null;
  functionalLocationId: string | null;
  reportedByUserId: string;
  reportedAt: Date;
};

/** Safe public representation: one Operational Incident, two tables, one id. */
export type PublicOperationalIncident = {
  /** The shared BE-21A Incident id — the operational id is internal. */
  id: string;
  operationalIncidentId: string;
  clientId: string;
  buildingId: string;
  incidentNumber: string;
  incidentType: 'OPERATIONAL';
  title: string;
  description: string | null;
  severity: IncidentSeverity;
  priority: IncidentPriority;
  /** BE-21A record lifecycle — authoritative for whether the record stands. */
  incidentStatus: IncidentStatus;
  /** BE-21B operational handling progression. */
  operationalStatus: OperationalIncidentStatus;
  operationalCategory: OperationalIncidentCategory;
  occurredAt: string;
  statusChangedAt: string;
  notes: string | null;
  locationType: IncidentLocationType | null;
  locationId: string | null;
  floorId: string | null;
  areaId: string | null;
  roomId: string | null;
  spaceId: string | null;
  functionalLocationId: string | null;
  reportedByUserId: string;
  reportedAt: string;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  /** Backend-resolved; the frontend must not recompute these. */
  availableActions: OperationalIncidentAction[];
  /** CR-BE-RN17-SECURITY-INCIDENT-FIELD-01 — reporting-time field context, identifies REPORTING-TIME shift/post, not occurredAt-time history. */
  reportedShiftAssignmentId: string | null;
  reportedSecurityPostId: string | null;
};

/**
 * Creation input. `incidentType` is absent by design — BE-21B always pins it
 * to OPERATIONAL. `clientId` and `reportedByUserId` are likewise derived.
 */
export type CreateOperationalIncidentInput = {
  buildingId: string;
  incidentNumber: string;
  title: string;
  description?: string | null;
  severity?: IncidentSeverity;
  priority?: IncidentPriority;
  locationType?: IncidentLocationType | null;
  locationId?: string | null;
  operationalCategory: OperationalIncidentCategory;
  occurredAt: Date;
  notes?: string | null;
  /** Optional explicit reporter; defaults to the authenticated actor. */
  reportedByUserId?: string;
};

export type NewOperationalIncident = {
  incidentId: string;
  operationalCategory: OperationalIncidentCategory;
  occurredAt: Date;
  notes: string | null;
  createdByUserId: string;
  /** CR-BE-RN17-SECURITY-INCIDENT-FIELD-01 — nullable reporting context; only SECURITY populates. */
  reportedShiftAssignmentId?: string | null;
  reportedSecurityPostId?: string | null;
};

/**
 * Foundation metadata (title/description/severity/priority) is updated
 * through the BE-21A service; the operational fields are updated here. Both
 * are accepted on one request and applied atomically.
 */
export type UpdateOperationalIncidentInput = {
  title?: string;
  description?: string | null;
  severity?: IncidentSeverity;
  priority?: IncidentPriority;
  operationalCategory?: OperationalIncidentCategory;
  occurredAt?: Date;
  notes?: string | null;
  operationalStatus?: OperationalIncidentStatus;
};

export type OperationalIncidentFilters = {
  buildingId?: string;
  locationType?: IncidentLocationType;
  locationId?: string;
  operationalCategory?: OperationalIncidentCategory;
  severity?: IncidentSeverity;
  priority?: IncidentPriority;
  operationalStatus?: OperationalIncidentStatus;
  incidentStatus?: IncidentStatus;
  /** Inclusive `occurred_at` window. */
  occurredFrom?: Date;
  occurredTo?: Date;
};
