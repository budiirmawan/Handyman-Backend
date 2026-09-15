import type {
  IncidentPriority,
  IncidentSeverity,
  IncidentStatus,
  IncidentType,
} from '../incidents';

/**
 * BE-21F — Investigation Readiness domain types.
 *
 * Readiness answers ONE question about a BE-21A Incident: may an
 * investigation begin on it yet, and if not, what is standing in the way?
 *
 * IT IS COMPUTED, NEVER STORED
 * ----------------------------
 * There is no `readiness_status` column, no `investigation_readiness` table,
 * and no migration in this PART. Readiness is derived on every request from
 * facts that already exist — the Incident itself (BE-21A), its type detail
 * (BE-21B/C/D), and its immediate actions (BE-21E).
 *
 * That is not a shortcut, it is the correctness requirement. A stored
 * readiness flag would be a cache of five other tables with no invalidation
 * path: completing an immediate action or filling in a description would
 * silently leave the flag stale, and the backend would start reporting a
 * readiness that contradicts its own data. A projection cannot go stale.
 *
 * WHAT THIS IS NOT
 * ----------------
 * This is NOT the investigation itself, and NOT Corrective Action (BE-21G).
 * Nothing here starts, records, or closes an investigation; there is no root
 * cause, no findings, no corrective plan. BE-21F only reports whether the
 * preconditions hold. Because nothing can be mutated, this PART exposes a
 * read permission and no manage permission at all.
 */

/**
 * The closed set of reasons an Incident is not investigable yet.
 *
 * Codes are stable identifiers so a frontend can branch on them or localize
 * them; the accompanying message is human-facing only and must never be
 * parsed.
 */
export const INVESTIGATION_BLOCKER_CODES = [
  'INCIDENT_CANCELLED',
  'TYPE_DETAIL_MISSING',
  'DESCRIPTION_MISSING',
  'NO_IMMEDIATE_ACTION_RECORDED',
  'IMMEDIATE_ACTION_UNSETTLED',
] as const;

export type InvestigationBlockerCode =
  (typeof INVESTIGATION_BLOCKER_CODES)[number];

export function isInvestigationBlockerCode(
  value: unknown,
): value is InvestigationBlockerCode {
  return (
    typeof value === 'string' &&
    (INVESTIGATION_BLOCKER_CODES as readonly string[]).includes(value)
  );
}

export type InvestigationBlocker = {
  code: InvestigationBlockerCode;
  message: string;
};

/**
 * The raw facts readiness is computed FROM, gathered in one query.
 *
 * Keeping these separate from the verdict is what makes the rules a pure,
 * exhaustively testable function: given facts, the blockers are fully
 * determined, with no database access and no clock involved.
 */
export type IncidentReadinessFacts = {
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
  /** Whether a narrative account exists — blank/whitespace does not count. */
  hasDescription: boolean;
  /**
   * Whether the BE-21B/C/D record matching `incidentType` exists. Those rows
   * carry the category and occurrence time an investigation starts from.
   */
  hasTypeDetail: boolean;
  /** BE-21E counts. `unsettled` = still PLANNED or IN_PROGRESS. */
  immediateActionCount: number;
  unsettledImmediateActionCount: number;
  completedImmediateActionCount: number;
};

/**
 * The evidence behind the verdict, echoed back so a caller can explain the
 * outcome without re-deriving it or issuing extra requests. Read-only.
 */
export type InvestigationReadinessFactSummary = {
  incidentStatus: IncidentStatus;
  hasDescription: boolean;
  hasTypeDetail: boolean;
  immediateActionCount: number;
  unsettledImmediateActionCount: number;
  completedImmediateActionCount: number;
};

/** The computed projection returned by the API. Never persisted. */
export type InvestigationReadiness = {
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
  /** True only when `blockers` is empty — the two can never disagree. */
  ready: boolean;
  blockers: InvestigationBlocker[];
  facts: InvestigationReadinessFactSummary;
  /**
   * When this verdict was computed. Present precisely BECAUSE readiness is
   * not stored: it is a snapshot, and completing an immediate action a second
   * later legitimately changes the answer.
   */
  evaluatedAt: string;
};

export type InvestigationReadinessFilters = {
  buildingId?: string;
  incidentType?: IncidentType;
  status?: IncidentStatus;
  /** Filters the COMPUTED verdict, applied after evaluation. */
  ready?: boolean;
};
