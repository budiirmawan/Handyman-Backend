/**
 * BE-12I — Security Incident Readiness domain types.
 *
 * Lightweight, configuration-only readiness records that tell a Security
 * operation whether a Building (or Building × Security Post) is
 * operationally prepared to report a particular category of incident.
 *
 * This is NOT an Incident master record, NOT a workflow / SLA /
 * dispatch / notification engine — it is a configuration / context
 * foundation. The actual Incident lifecycle will be added in a later
 * BE-12 PART; for now we only model the readiness configuration.
 *
 * The status enum (`ACTIVE` / `INACTIVE`) is the binding's own
 * lifecycle — independent of `readiness_status` (READY / PARTIAL /
 * NOT_READY) which is the operational readiness state. Both are
 * intentionally separate.
 */

export const SECURITY_INCIDENT_READINESS_CATEGORIES = [
  'SECURITY',
  'SAFETY',
  'FIRE',
  'MEDICAL',
  'ACCESS',
  'PROPERTY',
  'OTHER',
] as const;

export type SecurityIncidentReadinessCategory =
  (typeof SECURITY_INCIDENT_READINESS_CATEGORIES)[number];

export function isSecurityIncidentReadinessCategory(
  value: unknown,
): value is SecurityIncidentReadinessCategory {
  return (
    typeof value === 'string' &&
    (SECURITY_INCIDENT_READINESS_CATEGORIES as readonly string[]).includes(
      value,
    )
  );
}

export const SECURITY_INCIDENT_READINESS_STATUSES = [
  'READY',
  'PARTIAL',
  'NOT_READY',
] as const;

export type SecurityIncidentReadinessStatus =
  (typeof SECURITY_INCIDENT_READINESS_STATUSES)[number];

export function isSecurityIncidentReadinessStatus(
  value: unknown,
): value is SecurityIncidentReadinessStatus {
  return (
    typeof value === 'string' &&
    (SECURITY_INCIDENT_READINESS_STATUSES as readonly string[]).includes(
      value,
    )
  );
}

export const SECURITY_INCIDENT_READINESS_BINDING_STATUSES = [
  'ACTIVE',
  'INACTIVE',
] as const;

export type SecurityIncidentReadinessBindingStatus =
  (typeof SECURITY_INCIDENT_READINESS_BINDING_STATUSES)[number];

export function isSecurityIncidentReadinessBindingStatus(
  value: unknown,
): value is SecurityIncidentReadinessBindingStatus {
  return (
    typeof value === 'string' &&
    (SECURITY_INCIDENT_READINESS_BINDING_STATUSES as readonly string[]).includes(
      value,
    )
  );
}

/**
 * Lightweight deterministic evaluation result. Aggregated by the service
 * from the underlying authoritative records (Team / Workforce Building
 * Assignment / Security Post status). A Post / Building with a READY
 * readiness row + ACTIVE post + ACTIVE responsible Team / ACTIVE
 * responsible Workforce resolves to `READY`; otherwise `PARTIAL`.
 */
export type SecurityIncidentReadinessEvaluation = {
  readinessId: string;
  buildingId: string;
  securityPostId: string | null;
  category: SecurityIncidentReadinessCategory;
  reportedStatus: SecurityIncidentReadinessStatus;
  effectiveStatus: SecurityIncidentReadinessStatus;
  reasons: string[];
};

/** Full database record. */
export type SecurityIncidentReadinessRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  securityPostId: string | null;
  category: SecurityIncidentReadinessCategory;
  readinessStatus: SecurityIncidentReadinessStatus;
  status: SecurityIncidentReadinessBindingStatus;
  responsibleTeamId: string | null;
  responsibleWorkforceId: string | null;
  escalationContact: string | null;
  reportingInstructions: string | null;
  evidenceRequirementId: string | null;
  notes: string | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicSecurityIncidentReadiness = {
  id: string;
  clientId: string;
  buildingId: string;
  securityPostId: string | null;
  category: SecurityIncidentReadinessCategory;
  readinessStatus: SecurityIncidentReadinessStatus;
  status: SecurityIncidentReadinessBindingStatus;
  responsibleTeamId: string | null;
  responsibleWorkforceId: string | null;
  escalationContact: string | null;
  reportingInstructions: string | null;
  evidenceRequirementId: string | null;
  notes: string | null;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  effectiveReadiness: SecurityIncidentReadinessStatus;
  effectiveReasons: string[];
};

export type CreateSecurityIncidentReadinessInput = {
  buildingId: string;
  securityPostId?: string | null;
  category: SecurityIncidentReadinessCategory;
  readinessStatus?: SecurityIncidentReadinessStatus;
  status?: SecurityIncidentReadinessBindingStatus;
  responsibleTeamId?: string | null;
  responsibleWorkforceId?: string | null;
  escalationContact?: string | null;
  reportingInstructions?: string | null;
  evidenceRequirementId?: string | null;
  notes?: string | null;
  createdByUserId: string;
};

export type UpdateSecurityIncidentReadinessInput = {
  securityPostId?: string | null;
  category?: SecurityIncidentReadinessCategory;
  readinessStatus?: SecurityIncidentReadinessStatus;
  status?: SecurityIncidentReadinessBindingStatus;
  responsibleTeamId?: string | null;
  responsibleWorkforceId?: string | null;
  escalationContact?: string | null;
  reportingInstructions?: string | null;
  evidenceRequirementId?: string | null;
  notes?: string | null;
};

export type SecurityIncidentReadinessListFilters = {
  buildingId?: string;
  securityPostId?: string;
  category?: SecurityIncidentReadinessCategory;
  readinessStatus?: SecurityIncidentReadinessStatus;
  status?: SecurityIncidentReadinessBindingStatus;
};
