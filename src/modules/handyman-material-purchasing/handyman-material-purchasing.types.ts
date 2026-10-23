export const HANDYMAN_MATERIAL_FUNDING_SOURCES = [
  'PETTY_CASH',
  'CASH_ADVANCE',
  'REIMBURSEMENT',
  'COMPANY_DIRECT',
  'WAREHOUSE_STOCK',
] as const;
export type HandymanMaterialFundingSource =
  (typeof HANDYMAN_MATERIAL_FUNDING_SOURCES)[number];

export const HANDYMAN_MATERIAL_PURCHASE_STATUSES = [
  'REQUEST',
  'APPROVAL',
  'ISSUED',
  'PURCHASED',
  'USAGE',
  'RETURN',
  'RECONCILIATION',
] as const;
export type HandymanMaterialPurchaseStatus =
  (typeof HANDYMAN_MATERIAL_PURCHASE_STATUSES)[number];

export const HANDYMAN_MATERIAL_PURCHASE_EVENT_TYPES = [
  'REQUEST',
  'APPROVAL',
  'ISSUED',
  'PURCHASED',
  'USAGE',
  'RETURN',
  'RECONCILIATION',
  'REIMBURSEMENT_APPROVED',
  'REIMBURSEMENT_REJECTED',
  'REIMBURSEMENT_DISBURSED',
] as const;
export type HandymanMaterialPurchaseEventType =
  (typeof HANDYMAN_MATERIAL_PURCHASE_EVENT_TYPES)[number];

export const HANDYMAN_MATERIAL_PURCHASE_ACTOR_ROLES = [
  'PIC_PEKERJAAN',
  'OPERATIONS_MANAGER',
  'FINANCE_MANAGER',
] as const;
export type HandymanMaterialPurchaseActorRole =
  (typeof HANDYMAN_MATERIAL_PURCHASE_ACTOR_ROLES)[number];

export const HANDYMAN_MATERIAL_RETURN_DESTINATIONS = [
  'WAREHOUSE',
  'SUPPLIER_RETURN',
  'COMPANY_CUSTODY',
] as const;
export type HandymanMaterialReturnDestination =
  (typeof HANDYMAN_MATERIAL_RETURN_DESTINATIONS)[number];

export const HANDYMAN_MATERIAL_REIMBURSEMENT_STATUSES = [
  'NOT_APPLICABLE',
  'PENDING_RECONCILIATION',
  'RECONCILED_PAYABLE',
  'FINANCE_APPROVED',
  'DISBURSED',
  'REJECTED',
] as const;
export type HandymanMaterialReimbursementStatus =
  (typeof HANDYMAN_MATERIAL_REIMBURSEMENT_STATUSES)[number];

export const HANDYMAN_REIMBURSEMENT_DISBURSEMENT_METHODS = [
  'BANK_TRANSFER',
  'PAYROLL_SETTLEMENT',
  'PETTY_CASH_PAYOUT',
] as const;
export type HandymanReimbursementDisbursementMethod =
  (typeof HANDYMAN_REIMBURSEMENT_DISBURSEMENT_METHODS)[number];

export interface HandymanMaterialPurchaseRecord {
  id: string;
  clientId: string;
  executionScopeId: string;
  workOrderId: string | null;
  handymanRequestId: string;
  tenantCompanyId: string;
  buildingId: string;
  materialExecutionLineId: string | null;
  sourceItemId: string | null;
  itemName: string;
  uomId: string;
  uomCode: string | null;
  fundingSource: HandymanMaterialFundingSource;
  status: HandymanMaterialPurchaseStatus;
  requestedQuantity: string;
  approvedQuantity: string;
  issuedQuantity: string;
  purchasedQuantity: string;
  usedQuantity: string;
  returnedQuantity: string;
  returnDestination: HandymanMaterialReturnDestination | null;
  supplierName: string | null;
  supplierReference: string | null;
  purchaseReference: string | null;
  purchaseDate: string | null;
  currency: string;
  approvedMaxUnitPrice: string | null;
  actualUnitPrice: string | null;
  actualTotalExpenseAmount: string;
  netUsedExpenseAmount: string;
  approvalReference: string | null;
  expenditureReference: string | null;
  cashAdvanceReference: string | null;
  receiptEvidenceReference: string | null;
  receiptSha256Checksum: string | null;
  latestEvidenceReference: string;
  reimbursementPayableAmount: string;
  reimbursementPayeeUserId: string | null;
  reimbursementStatus: HandymanMaterialReimbursementStatus;
  reimbursementFinanceApprovalReference: string | null;
  reimbursementFinanceApprovedByUserId: string | null;
  reimbursementFinanceApprovedAt: string | null;
  reimbursementDisbursementReference: string | null;
  reimbursementDisbursementMethod: HandymanReimbursementDisbursementMethod | null;
  reimbursementDisbursedAmount: string;
  reimbursementDisbursedByUserId: string | null;
  reimbursementDisbursedAt: string | null;
  reimbursementRejectedByUserId: string | null;
  reimbursementRejectedAt: string | null;
  reimbursementRejectionReason: string | null;
  tenantChargeEligible: boolean;
  tenantChargeEligibleQty: string;
  tenantInvoiced: boolean;
  requestedByUserId: string;
  approvedByUserId: string | null;
  reconciledByUserId: string | null;
  reconciledAt: string | null;
  createIdempotencyKey: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface HandymanMaterialPurchaseEventRecord {
  id: string;
  clientId: string;
  purchaseRecordId: string;
  executionScopeId: string;
  eventType: HandymanMaterialPurchaseEventType;
  fromStatus: HandymanMaterialPurchaseStatus | null;
  toStatus: HandymanMaterialPurchaseStatus;
  actorUserId: string;
  actorRole: HandymanMaterialPurchaseActorRole;
  quantityDelta: string;
  evidenceReference: string;
  notes: string | null;
  idempotencyKey: string;
  metadata: Record<string, unknown>;
  occurredAt: string;
}

export interface MaterialLedgerSeparationSummary {
  executionScopeId: string;
  operationalMaterialMovement: {
    totalRequestedQuantity: string;
    totalApprovedQuantity: string;
    totalIssuedQuantity: string;
    totalPurchasedQuantity: string;
    totalUsedQuantity: string;
    totalReturnedQuantity: string;
  };
  actualSupplierPurchasingExpense: {
    currency: string;
    totalPurchaseExpenseAmount: string;
    totalNetUsedExpenseAmount: string;
    purchasedRecordsCount: number;
  };
  workerAdvanceReimbursementPayable: {
    currency: string;
    totalReimbursementPayableAmount: string;
    totalDisbursedAmount: string;
    pendingReconciliationCount: number;
    reconciledPayableCount: number;
    financeApprovedCount: number;
    disbursedCount: number;
    rejectedCount: number;
  };
  tenantInvoiceChargeEligibility: {
    eligibleRecordsCount: number;
    totalEligibleUsedQuantity: string;
    anyTenantInvoiced: boolean;
  };
}
