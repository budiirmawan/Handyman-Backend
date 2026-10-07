/**
 * BE-21A — shared Incident foundation types.
 *
 * ONE Incident foundation serves Operational Incident (BE-21B), Asset Failure
 * / Defect (BE-21C), and Finding Escalation (BE-21D), distinguished only by
 * the `incidentType` discriminator. There is no second Incident engine and no
 * separate Defect or Corrective Action domain.
 *
 * BE-09 remains authoritative for Finding and workflow behaviour. BE-21C's
 * Asset / Equipment binding and BE-21D's BE-09 Finding binding are typed
 * bindings added by those PARTs — they are NOT part of this foundation, and
 * neither may copy the record it points at.
 *
 * Client ownership is DERIVED (Building → Property → Client) and never
 * accepted from the caller. Location is an OPTIONAL refinement of the BE-04
 * structure: only references are held, never names or hierarchy.
 */

/** The discriminator that keeps all three incident kinds on one foundation. */
export const INCIDENT_TYPES = [
  'OPERATIONAL',
  'ASSET_FAILURE',
  'FINDING_ESCALATION',
] as const;

export type IncidentType = (typeof INCIDENT_TYPES)[number];

export function isIncidentType(value: unknown): value is IncidentType {
  return (
    typeof value === 'string' &&
    (INCIDENT_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Severity is HOW BAD the incident is; priority is HOW SOON it is handled.
 * They are deliberately separate axes and reuse the BE-08C Work Order scale
 * so Engineering, Housekeeping, and Security read the same vocabulary.
 */
export const INCIDENT_SEVERITIES = [
  'LOW',
  'MEDIUM',
  'HIGH',
  'CRITICAL',
] as const;

export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

export function isIncidentSeverity(value: unknown): value is IncidentSeverity {
  return (
    typeof value === 'string' &&
    (INCIDENT_SEVERITIES as readonly string[]).includes(value)
  );
}

export const INCIDENT_PRIORITIES = [
  'LOW',
  'MEDIUM',
  'HIGH',
  'CRITICAL',
] as const;

export type IncidentPriority = (typeof INCIDENT_PRIORITIES)[number];

export function isIncidentPriority(value: unknown): value is IncidentPriority {
  return (
    typeof value === 'string' &&
    (INCIDENT_PRIORITIES as readonly string[]).includes(value)
  );
}

/**
 * BE-21A exposes only the minimal foundation lifecycle. Investigation,
 * immediate action, corrective action, verification, and closure are later
 * BE-21 PARTs and must extend this lifecycle rather than fork it.
 */
/**
 * The Incident lifecycle.
 *
 * BE-21K adds `CLOSED` — the resolved end state, reached only once the
 * remedy has been carried out and independently verified. It is TERMINAL and
 * mutually exclusive with `CANCELLED`: an Incident that was withdrawn was
 * never resolved, and one that was resolved was never withdrawn.
 *
 * Every BE-21 child gate is written as `status !== 'REPORTED'`, so adding a
 * value here automatically freezes children against a closed Incident.
 */
export const INCIDENT_STATUSES = ['REPORTED', 'CANCELLED', 'CLOSED'] as const;

export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export function isIncidentStatus(value: unknown): value is IncidentStatus {
  return (
    typeof value === 'string' &&
    (INCIDENT_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * An OPTIONAL refinement below the Building. `building_id` is always the
 * isolation context, so no BUILDING member exists here — omitting
 * `locationType` already means "Building level".
 */
export const INCIDENT_LOCATION_TYPES = [
  'FLOOR',
  'AREA',
  'ROOM',
  'SPACE',
  'FUNCTIONAL_LOCATION',
] as const;

export type IncidentLocationType = (typeof INCIDENT_LOCATION_TYPES)[number];

export function isIncidentLocationType(
  value: unknown,
): value is IncidentLocationType {
  return (
    typeof value === 'string' &&
    (INCIDENT_LOCATION_TYPES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type IncidentRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  incidentNumber: string;
  incidentType: IncidentType;
  title: string;
  description: string | null;
  severity: IncidentSeverity;
  priority: IncidentPriority;
  status: IncidentStatus;
  locationType: IncidentLocationType | null;
  floorId: string | null;
  areaId: string | null;
  roomId: string | null;
  spaceId: string | null;
  functionalLocationId: string | null;
  reportedByUserId: string;
  reportedAt: Date;
  cancelledAt: Date | null;
  cancelledByUserId: string | null;
  /** BE-21K. Present only when `status` is CLOSED. */
  closedAt: Date | null;
  closedByUserId: string | null;
  closureNotes: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicIncident = Omit<
  IncidentRecord,
  'reportedAt' | 'cancelledAt' | 'closedAt' | 'createdAt' | 'updatedAt'
> & {
  /** The BE-04 reference implied by `locationType`, or null at Building level. */
  locationId: string | null;
  reportedAt: string;
  cancelledAt: string | null;
  /** BE-21K. */
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * `clientId` is absent by design — it is derived from the Building. So is
 * `reportedByUserId`, which is always the authenticated actor.
 */
export type CreateIncidentInput = {
  buildingId: string;
  incidentNumber: string;
  incidentType: IncidentType;
  title: string;
  description?: string | null;
  severity?: IncidentSeverity;
  priority?: IncidentPriority;
  locationType?: IncidentLocationType | null;
  /** The BE-04 reference matching `locationType`. */
  locationId?: string | null;
  reportedAt?: Date;
};

export type NewIncident = Omit<
  IncidentRecord,
  | 'id'
  | 'status'
  | 'cancelledAt'
  | 'cancelledByUserId'
  | 'closedAt'
  | 'closedByUserId'
  | 'closureNotes'
  | 'createdAt'
  | 'updatedAt'
>;

/**
 * Only descriptive metadata is mutable in the foundation. Type, context,
 * number, and reporter are immutable: they are the identity of the incident,
 * and rewriting them would rewrite history.
 */
export type UpdateIncidentInput = {
  title?: string;
  description?: string | null;
  severity?: IncidentSeverity;
  priority?: IncidentPriority;
};

export type IncidentFilters = {
  buildingId?: string;
  incidentType?: IncidentType;
  severity?: IncidentSeverity;
  priority?: IncidentPriority;
  status?: IncidentStatus;
};
