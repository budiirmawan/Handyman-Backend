import type { AssetStatus } from '../assets';
import type {
  IncidentLocationType,
  IncidentPriority,
  IncidentSeverity,
  IncidentStatus,
} from '../incidents';

/**
 * BE-21C — Asset Failure / Defect domain types.
 *
 * An Asset Failure / Defect is a SPECIALIZATION of the BE-21A Incident
 * foundation with `incident_type = 'ASSET_FAILURE'`. BE-21A stays
 * authoritative for Incident identity (`incidentNumber`), Client / Building
 * context, Location, title, defect description, severity, priority, reporter,
 * and the record lifecycle. BE-05 stays authoritative for Asset master data.
 * Neither is stored again here — the public view composes all three.
 *
 * What is genuinely new: the typed Asset binding, the failure category, when
 * the failure occurred, its operational impact, the failure-handling status,
 * and notes.
 */

/**
 * The controlled failure / defect vocabulary. A closed list (mirrored by a DB
 * CHECK) rather than free text, so failure-mode reporting across an Asset
 * fleet stays meaningful; `OTHER` is the deliberate escape hatch.
 */
export const ASSET_FAILURE_CATEGORIES = [
  'MECHANICAL_FAILURE',
  'ELECTRICAL_FAILURE',
  'CONTROL_FAILURE',
  'STRUCTURAL_DEFECT',
  'LEAKAGE',
  'OVERHEATING',
  'VIBRATION_NOISE',
  'CORROSION',
  'WEAR_AND_TEAR',
  'CALIBRATION_DRIFT',
  'SOFTWARE_FAULT',
  'INSTALLATION_DEFECT',
  'MANUFACTURING_DEFECT',
  'OTHER',
] as const;

export type AssetFailureCategory = (typeof ASSET_FAILURE_CATEGORIES)[number];

export function isAssetFailureCategory(
  value: unknown,
): value is AssetFailureCategory {
  return (
    typeof value === 'string' &&
    (ASSET_FAILURE_CATEGORIES as readonly string[]).includes(value)
  );
}

/**
 * Operational impact — "where applicable", so it is genuinely optional rather
 * than defaulted. A closed scale beats free text because impact drives
 * triage; `NONE` is a real, distinct answer ("recorded defect, still in
 * service") and must not be confused with "not stated".
 */
export const ASSET_FAILURE_IMPACTS = [
  'NONE',
  'DEGRADED',
  'PARTIAL_OUTAGE',
  'FULL_OUTAGE',
  'SAFETY_RISK',
] as const;

export type AssetFailureImpact = (typeof ASSET_FAILURE_IMPACTS)[number];

export function isAssetFailureImpact(
  value: unknown,
): value is AssetFailureImpact {
  return (
    typeof value === 'string' &&
    (ASSET_FAILURE_IMPACTS as readonly string[]).includes(value)
  );
}

/**
 * Failure-handling progression — deliberately distinct from BOTH the BE-21A
 * record lifecycle (`REPORTED` / `CANCELLED`) and the BE-05E Asset lifecycle
 * (`ACTIVE` / `UNDER_MAINTENANCE` / ...). This says how far the failure
 * response has got; the foundation says whether the record stands; BE-05 says
 * whether the equipment is in service.
 *
 * Investigation, corrective action, verification, and closure are later BE-21
 * PARTs: `RESOLVED` here means "failure handling finished", NOT verified or
 * closed. Those must extend this progression, not fork it.
 */
export const ASSET_FAILURE_STATUSES = [
  'OPEN',
  'IN_PROGRESS',
  'RESOLVED',
] as const;

export type AssetFailureStatus = (typeof ASSET_FAILURE_STATUSES)[number];

export function isAssetFailureStatus(
  value: unknown,
): value is AssetFailureStatus {
  return (
    typeof value === 'string' &&
    (ASSET_FAILURE_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * The explicit, closed transition table. A small lookup — NOT a generic
 * workflow engine, and not a second copy of BE-09's engine. BE-09 remains
 * authoritative for Finding workflow; this governs only failure handling.
 *
 *   OPEN        → IN_PROGRESS, RESOLVED
 *   IN_PROGRESS → RESOLVED, OPEN (reopen while handling continues)
 *   RESOLVED    → IN_PROGRESS (reopen when the failure recurs)
 */
export const ASSET_FAILURE_TRANSITIONS: Record<
  AssetFailureStatus,
  readonly AssetFailureStatus[]
> = {
  OPEN: ['IN_PROGRESS', 'RESOLVED'],
  IN_PROGRESS: ['RESOLVED', 'OPEN'],
  RESOLVED: ['IN_PROGRESS'],
};

export function canTransitionAssetFailureStatus(
  from: AssetFailureStatus,
  to: AssetFailureStatus,
): boolean {
  return ASSET_FAILURE_TRANSITIONS[from].includes(to);
}

/**
 * Backend-authoritative actions, mirroring the BE-09 `available_actions`
 * convention. Always computed per request from state × permission × the
 * foundation lifecycle — never persisted, never derived by the client.
 */
export const ASSET_FAILURE_ACTIONS = [
  'START_PROGRESS',
  'RESOLVE',
  'REOPEN',
  'UPDATE_DETAILS',
] as const;

export type AssetFailureAction = (typeof ASSET_FAILURE_ACTIONS)[number];

/**
 * The single source of truth linking a legal transition to the action that
 * offers it. Deriving `availableActions` from this map (rather than a parallel
 * hand-written list) makes it impossible for a permitted transition to become
 * undiscoverable, or for an advertised action to be rejected on execution.
 */
export const ASSET_FAILURE_TRANSITION_ACTIONS: {
  readonly [From in AssetFailureStatus]: {
    readonly [To in AssetFailureStatus]?: AssetFailureAction;
  };
} = {
  OPEN: { IN_PROGRESS: 'START_PROGRESS', RESOLVED: 'RESOLVE' },
  IN_PROGRESS: { RESOLVED: 'RESOLVE', OPEN: 'REOPEN' },
  RESOLVED: { IN_PROGRESS: 'REOPEN' },
};

/** Status-driven actions (permission and lifecycle gating happen upstream). */
export function assetFailureTransitionActions(
  from: AssetFailureStatus,
): AssetFailureAction[] {
  return ASSET_FAILURE_TRANSITIONS[from].map((to) => {
    const action = ASSET_FAILURE_TRANSITION_ACTIONS[from][to];
    if (!action) {
      throw new Error(
        `Asset Failure transition ${from} → ${to} has no action mapping`,
      );
    }
    return action;
  });
}

/** The specialization row exactly as persisted. */
export type AssetFailureRecord = {
  id: string;
  incidentId: string;
  /** Typed FK to the BE-05 Asset. Never a copy of Asset master data. */
  assetId: string;
  failureCategory: AssetFailureCategory;
  occurredAt: Date;
  operationalImpact: AssetFailureImpact | null;
  failureStatus: AssetFailureStatus;
  statusChangedAt: Date;
  notes: string | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * The joined row: specialization + the BE-21A foundation columns and the few
 * BE-05 Asset columns it PROJECTS. Asset fields are prefixed `asset*` and are
 * read-only projections for display — the Asset registry stays authoritative.
 */
export type AssetFailureCompositeRecord = AssetFailureRecord & {
  clientId: string;
  buildingId: string;
  incidentNumber: string;
  incidentType: 'ASSET_FAILURE';
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
  /** BE-05 projections (read-only). */
  assetClientId: string;
  assetBuildingId: string;
  assetCode: string;
  assetName: string;
  assetStatus: AssetStatus;
  assetFunctionalLocationId: string | null;
};

/** Safe public representation: one Asset Failure, three tables, one id. */
export type PublicAssetFailure = {
  /** The shared BE-21A Incident id — the specialization id is internal. */
  id: string;
  assetFailureId: string;
  clientId: string;
  buildingId: string;
  incidentNumber: string;
  incidentType: 'ASSET_FAILURE';
  title: string;
  description: string | null;
  severity: IncidentSeverity;
  priority: IncidentPriority;
  /** BE-21A record lifecycle — authoritative for whether the record stands. */
  incidentStatus: IncidentStatus;
  /** BE-21C failure-handling progression. */
  failureStatus: AssetFailureStatus;
  failureCategory: AssetFailureCategory;
  operationalImpact: AssetFailureImpact | null;
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
  /**
   * The bound BE-05 Asset, projected read-only. This is a VIEW of the Asset
   * registry, never a copy: BE-05 remains the only place Asset master data is
   * created or changed, and `assetStatus` reflects the live BE-05E lifecycle.
   */
  asset: {
    id: string;
    assetCode: string;
    assetName: string;
    status: AssetStatus;
    buildingId: string;
    functionalLocationId: string | null;
  };
  /** Backend-resolved; the frontend must not recompute these. */
  availableActions: AssetFailureAction[];
};

/**
 * Creation input. `incidentType` is absent by design — BE-21C always pins it
 * to ASSET_FAILURE. `clientId` is derived from the Building, and
 * `reportedByUserId` defaults to the authenticated actor.
 */
export type CreateAssetFailureInput = {
  buildingId: string;
  incidentNumber: string;
  title: string;
  description?: string | null;
  severity?: IncidentSeverity;
  priority?: IncidentPriority;
  locationType?: IncidentLocationType | null;
  locationId?: string | null;
  /** The existing BE-05 Asset this failure is recorded against. */
  assetId: string;
  failureCategory: AssetFailureCategory;
  occurredAt: Date;
  operationalImpact?: AssetFailureImpact | null;
  notes?: string | null;
  /** Optional explicit reporter; defaults to the authenticated actor. */
  reportedByUserId?: string;
};

export type NewAssetFailure = {
  incidentId: string;
  assetId: string;
  failureCategory: AssetFailureCategory;
  occurredAt: Date;
  operationalImpact: AssetFailureImpact | null;
  notes: string | null;
  createdByUserId: string;
};

/**
 * Foundation metadata (title/description/severity/priority) is updated
 * through the BE-21A repository; the failure fields are updated here. Both are
 * accepted on one request and applied atomically.
 *
 * `assetId` is absent by design: re-pointing a recorded failure at a different
 * Asset would rewrite history and corrupt per-Asset failure records. A failure
 * against the wrong Asset is cancelled (BE-21A) and re-reported.
 */
export type UpdateAssetFailureInput = {
  title?: string;
  description?: string | null;
  severity?: IncidentSeverity;
  priority?: IncidentPriority;
  failureCategory?: AssetFailureCategory;
  occurredAt?: Date;
  operationalImpact?: AssetFailureImpact | null;
  notes?: string | null;
  failureStatus?: AssetFailureStatus;
};

export type AssetFailureFilters = {
  assetId?: string;
  buildingId?: string;
  locationType?: IncidentLocationType;
  locationId?: string;
  failureCategory?: AssetFailureCategory;
  operationalImpact?: AssetFailureImpact;
  severity?: IncidentSeverity;
  priority?: IncidentPriority;
  failureStatus?: AssetFailureStatus;
  incidentStatus?: IncidentStatus;
  /** Inclusive `occurred_at` window. */
  occurredFrom?: Date;
  occurredTo?: Date;
};
