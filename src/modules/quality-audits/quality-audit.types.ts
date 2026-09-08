/**
 * BE-11K — Quality Audit domain types.
 *
 * Quality review and scoring layer across Housekeeping operations.
 */

export const QUALITY_AUDIT_SOURCE_TYPES = [
  'DAILY_CLEANING',
  'TOILET_INSPECTION',
  'PUBLIC_AREA_INSPECTION',
  'SUPERVISOR_INSPECTION',
  'CLEANING_AREA',
] as const;
export type QualityAuditSourceType =
  (typeof QUALITY_AUDIT_SOURCE_TYPES)[number];

export const QUALITY_AUDIT_STATUSES = ['DRAFT', 'COMPLETED'] as const;
export type QualityAuditStatus = (typeof QUALITY_AUDIT_STATUSES)[number];

export const QUALITY_AUDIT_RESULTS = [
  'PASS',
  'FAIL',
  'REWORK_REQUIRED',
] as const;
export type QualityAuditResult = (typeof QUALITY_AUDIT_RESULTS)[number];

export function isQualityAuditSourceType(
  value: unknown,
): value is QualityAuditSourceType {
  return (
    typeof value === 'string' &&
    (QUALITY_AUDIT_SOURCE_TYPES as readonly string[]).includes(value)
  );
}

export function isQualityAuditStatus(
  value: unknown,
): value is QualityAuditStatus {
  return (
    typeof value === 'string' &&
    (QUALITY_AUDIT_STATUSES as readonly string[]).includes(value)
  );
}

export function isQualityAuditResult(
  value: unknown,
): value is QualityAuditResult {
  return (
    typeof value === 'string' &&
    (QUALITY_AUDIT_RESULTS as readonly string[]).includes(value)
  );
}

export type QualityAuditRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  cleaningAreaId: string | null;
  sourceType: QualityAuditSourceType;
  sourceId: string;
  auditorUserId: string;
  score: number | null;
  result: QualityAuditResult | null;
  status: QualityAuditStatus;
  notes: string | null;
  auditedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicQualityAudit = {
  id: string;
  clientId: string;
  buildingId: string;
  cleaningAreaId: string | null;
  sourceType: QualityAuditSourceType;
  sourceId: string;
  auditorUserId: string;
  score: number | null;
  result: QualityAuditResult | null;
  status: QualityAuditStatus;
  notes: string | null;
  auditedAt: string | null;
  createdAt: string;
  updatedAt: string;
  cleaningArea?: {
    id: string;
    code: string;
    name: string;
    status: string;
  } | null;
};

export type CreateQualityAuditInput = {
  sourceType: QualityAuditSourceType;
  sourceId: string;
  score?: number | null;
  result?: QualityAuditResult | null;
  notes?: string | null;
  auditorUserId: string;
};

export type UpdateQualityAuditInput = {
  score?: number | null;
  result?: QualityAuditResult | null;
  notes?: string | null;
};

export type CompleteQualityAuditInput = {
  score?: number | null;
  result: QualityAuditResult;
  notes?: string | null;
};

export type QualityAuditFilter = {
  buildingId?: string;
  cleaningAreaId?: string;
  sourceType?: QualityAuditSourceType;
  result?: QualityAuditResult;
  status?: QualityAuditStatus;
};
