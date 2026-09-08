import type { UtilityMeterPurpose } from '../utility-meters';
/**
 * Approval targets. BE-14H owns the first three; BE-18L adds
 * 'UTILITY_CALCULATION' so a Tenant utility charge can be bound to the same
 * approval primitive rather than a second engine.
 */
export const TENANT_APPROVAL_REQUEST_TYPES = [
  'SERVICE_REQUEST',
  'COMPLAINT',
  'UTILITY_REQUEST',
  'UTILITY_CALCULATION',
] as const;
export type TenantApprovalRequestType =
  (typeof TENANT_APPROVAL_REQUEST_TYPES)[number];
export const TENANT_APPROVAL_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
] as const;
export type TenantApprovalStatus = (typeof TENANT_APPROVAL_STATUSES)[number];
export const TENANT_APPROVAL_ACTIONS = ['APPROVE', 'REJECT'] as const;
export type TenantApprovalAction = (typeof TENANT_APPROVAL_ACTIONS)[number];

export const isTenantApprovalRequestType = (value: unknown): value is TenantApprovalRequestType =>
  typeof value === 'string' &&
  (TENANT_APPROVAL_REQUEST_TYPES as readonly string[]).includes(value);
export const isTenantApprovalStatus = (value: unknown): value is TenantApprovalStatus =>
  typeof value === 'string' &&
  (TENANT_APPROVAL_STATUSES as readonly string[]).includes(value);

export type TenantApprovalRecord = {
  id: string;
  clientId: string;
  tenantCompanyId: string;
  buildingId: string;
  requestType: TenantApprovalRequestType;
  serviceRequestId: string | null;
  complaintId: string | null;
  utilityRequestId: string | null;
  /** BE-18L — the exact finalized Utility Calculation under approval. */
  utilityCalculationId: string | null;
  utilitySnapshotVersion: number | null;
  utilitySpaceId: string | null;
  utilityMeterId: string | null;
  utilityMeterPurpose: UtilityMeterPurpose | null;
  utilityType: 'ELECTRICITY' | 'WATER' | null;
  utilityPeriodStart: Date | null;
  utilityPeriodEnd: Date | null;
  utilityConsumptionQuantity: string | null;
  utilityUomId: string | null;
  utilityTariffId: string | null;
  utilityTariffRate: string | null;
  utilityCalculatedAmount: string | null;
  utilityCurrency: string | null;
  approvalType: string;
  approverUserId: string;
  status: TenantApprovalStatus;
  decidedAt: Date | null;
  decisionNotes: string | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicTenantApproval = Omit<
  TenantApprovalRecord,
  'decidedAt' | 'createdAt' | 'updatedAt' | 'utilityPeriodStart' |
  'utilityPeriodEnd' | 'utilityConsumptionQuantity' | 'utilityTariffRate' |
  'utilityCalculatedAmount'
> & {
  requestId: string;
  decidedAt: string | null;
  utilityPeriodStart: string | null;
  utilityPeriodEnd: string | null;
  utilityConsumptionQuantity: number | null;
  utilityTariffRate: number | null;
  utilityCalculatedAmount: number | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateTenantApprovalInput = {
  requestType: TenantApprovalRequestType;
  requestId: string;
  approvalType: string;
  approverUserId: string;
};

export type NewTenantApproval = Omit<
  TenantApprovalRecord,
  'id' | 'status' | 'decidedAt' | 'decisionNotes' | 'utilitySnapshotVersion' | 'createdAt' | 'updatedAt'
>;

export type TenantApprovalDecisionInput = {
  decisionNotes?: string;
};

export type TenantApprovalPendingFilters = {
  buildingId?: string;
  tenantCompanyId?: string;
  requestType?: TenantApprovalRequestType;
  approvalType?: string;
  approverUserId?: string;
  /** BE-18L — narrow pending approvals to one utility calculation. */
  utilityCalculationId?: string;
};

export type TenantApprovalAvailableActions = {
  approvalId: string;
  state: TenantApprovalStatus;
  availableActions: TenantApprovalAction[];
};

/**
 * BE-18L — the Tenant utility approval context for one BE-18I calculation.
 * Assembled from authoritative records; nothing here is stored twice.
 */
export type UtilityCalculationApprovalContext = {
  utilityCalculationId: string;
  clientId: string;
  tenantCompanyId: string;
  buildingId: string;
  /** True when the calculation is FINALIZED and may still be bound. */
  approvable: boolean;
  pendingApprovals: PublicTenantApproval[];
  approvals: PublicTenantApproval[];
};
