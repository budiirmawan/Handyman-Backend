/**
 * BE-15D — Work Permit Readiness domain types.
 *
 * A readiness/binding layer only — NOT a Permit-to-Work engine. Each record
 * captures the permit-readiness of a BE-15B Vendor Work for one permit
 * requirement type. `readiness_status` is derived backend-side (never
 * trusted from the client) from the permit requirement type, permit status,
 * and validity window.
 *
 * Readiness values: READY, NOT_READY, EXPIRED, NOT_REQUIRED.
 */
export const PERMIT_READINESS_STATUSES = [
  'READY',
  'NOT_READY',
  'EXPIRED',
  'NOT_REQUIRED',
] as const;

export type PermitReadinessStatus = (typeof PERMIT_READINESS_STATUSES)[number];

export function isPermitReadinessStatus(
  value: unknown,
): value is PermitReadinessStatus {
  return (
    typeof value === 'string' &&
    (PERMIT_READINESS_STATUSES as readonly string[]).includes(value)
  );
}

export const PERMIT_STATUSES = [
  'DRAFT',
  'PENDING',
  'ISSUED',
  'SUSPENDED',
  'REJECTED',
  'REVOKED',
  'EXPIRED',
] as const;

export type PermitStatus = (typeof PERMIT_STATUSES)[number];

export function isPermitStatus(value: unknown): value is PermitStatus {
  return (
    typeof value === 'string' &&
    (PERMIT_STATUSES as readonly string[]).includes(value)
  );
}

/** Reserved permit requirement type meaning no permit is required. */
export const NOT_REQUIRED_TYPE = 'NOT_REQUIRED';

/** Full database record. */
export type WorkPermitReadinessRecord = {
  id: string;
  clientId: string;
  vendorWorkId: string;
  buildingId: string;
  workOrderId: string;
  permitRequirementType: string;
  permitReference: string | null;
  permitStatus: PermitStatus;
  validFrom: Date | null;
  validUntil: Date | null;
  readinessStatus: PermitReadinessStatus;
  notes: string | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicWorkPermitReadiness = {
  id: string;
  clientId: string;
  vendorWorkId: string;
  buildingId: string;
  workOrderId: string;
  permitRequirementType: string;
  permitReference: string | null;
  permitStatus: PermitStatus;
  validFrom: string | null;
  validUntil: string | null;
  readinessStatus: PermitReadinessStatus;
  notes: string | null;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

/** Input for creating a permit readiness record. */
export type CreateWorkPermitReadinessInput = {
  vendorWorkId: string;
  permitRequirementType: string;
  permitReference?: string;
  permitStatus?: PermitStatus;
  validFrom?: Date | null;
  validUntil?: Date | null;
  notes?: string;
  createdByUserId: string;
};

/** Fully-resolved readiness data ready for persistence. */
export type NewWorkPermitReadiness = {
  clientId: string;
  vendorWorkId: string;
  buildingId: string;
  workOrderId: string;
  permitRequirementType: string;
  permitReference: string | null;
  permitStatus: PermitStatus;
  validFrom: Date | null;
  validUntil: Date | null;
  readinessStatus: PermitReadinessStatus;
  notes: string | null;
  createdByUserId: string;
};

/** Input for updating a permit readiness record (identity is immutable). */
export type UpdateWorkPermitReadinessInput = {
  permitReference?: string | null;
  permitStatus?: PermitStatus;
  validFrom?: Date | null;
  validUntil?: Date | null;
  notes?: string | null;
};

/** List filters for GET /permit-readiness. */
export type WorkPermitReadinessFilters = {
  vendorWorkId?: string;
  vendorId?: string;
  buildingId?: string;
};

/** The time-aware resolved readiness of one permit requirement. */
export type ResolvedPermitReadiness = {
  id: string;
  permitRequirementType: string;
  permitReference: string | null;
  permitStatus: PermitStatus;
  validFrom: string | null;
  validUntil: string | null;
  readinessStatus: PermitReadinessStatus;
  notes: string | null;
};

/** The authoritative, time-aware current permit readiness of a Vendor Work. */
export type VendorWorkPermitReadiness = {
  vendorWorkId: string;
  buildingId: string;
  ready: boolean;
  readinessStatus: PermitReadinessStatus;
  permits: ResolvedPermitReadiness[];
};
