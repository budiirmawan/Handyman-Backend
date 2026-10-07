/**
 * BE-17D — Procurement Approval Binding domain types.
 *
 * An Approval Binding explicitly ties an approval decision to one existing
 * Procurement target (BE-17A Purchase Request, BE-17B Material Request,
 * BE-17C Service Request, or CR-BE-PRO-02 RFQ recommendation). It is deliberately NOT a new generic approval
 * engine — it reuses the authoritative available-actions / workflow pattern
 * established by the existing approval bindings.
 *
 * Decisions are append-only history: a row moves once from PENDING to a
 * terminal decision (APPROVED / REJECTED) and is never overwritten. Only the
 * assigned authorized approver may decide.
 */
export const PROCUREMENT_APPROVAL_REQUEST_TYPES = [
  'PURCHASE_REQUEST',
  'MATERIAL_REQUEST',
  'SERVICE_REQUEST',
  'RFQ',
] as const;
export type ProcurementApprovalRequestType =
  (typeof PROCUREMENT_APPROVAL_REQUEST_TYPES)[number];

export const PROCUREMENT_APPROVAL_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
] as const;
export type ProcurementApprovalStatus =
  (typeof PROCUREMENT_APPROVAL_STATUSES)[number];

export const PROCUREMENT_APPROVAL_ACTIONS = ['APPROVE', 'REJECT'] as const;
export type ProcurementApprovalAction =
  (typeof PROCUREMENT_APPROVAL_ACTIONS)[number];

export function isProcurementApprovalRequestType(
  value: unknown,
): value is ProcurementApprovalRequestType {
  return (
    typeof value === 'string' &&
    (PROCUREMENT_APPROVAL_REQUEST_TYPES as readonly string[]).includes(value)
  );
}

export function isProcurementApprovalStatus(
  value: unknown,
): value is ProcurementApprovalStatus {
  return (
    typeof value === 'string' &&
    (PROCUREMENT_APPROVAL_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type ProcurementApprovalRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  requestType: ProcurementApprovalRequestType;
  purchaseRequestId: string | null;
  materialRequestId: string | null;
  serviceRequestId: string | null;
  rfqId: string | null;
  recommendationId: string | null;
  approvalType: string;
  approverUserId: string;
  status: ProcurementApprovalStatus;
  decidedAt: Date | null;
  decisionNotes: string | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicProcurementApproval = Omit<
  ProcurementApprovalRecord,
  'decidedAt' | 'createdAt' | 'updatedAt'
> & {
  requestId: string;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Input supplied when creating a Procurement Approval binding. */
export type CreateProcurementApprovalInput = {
  requestType: ProcurementApprovalRequestType;
  requestId: string;
  approvalType: string;
  approverUserId: string;
  /** Required for the RFQ award target; null for legacy request targets. */
  recommendationId?: string;
};

export type NewProcurementApproval = Omit<
  ProcurementApprovalRecord,
  'id' | 'status' | 'decidedAt' | 'decisionNotes' | 'createdAt' | 'updatedAt'
>;

/** Input for an approve/reject decision. */
export type ProcurementApprovalDecisionInput = {
  decisionNotes?: string;
  /**
   * CR-BE-MAT-01 PART 02 — explicit approved quantity. Only valid when
   * APPROVING a MATERIAL_REQUEST binding; must be > 0 and must not exceed the
   * line's requested quantity. When omitted, approved quantity defaults to
   * the requested quantity.
   */
  approvedQuantity?: number;
};

/** Pending-approval list filters. */
export type ProcurementApprovalPendingFilters = {
  buildingId?: string;
  requestType?: ProcurementApprovalRequestType;
  approvalType?: string;
  approverUserId?: string;
};

/** Backend-authoritative available-actions result. */
export type ProcurementApprovalAvailableActions = {
  approvalId: string;
  state: ProcurementApprovalStatus;
  availableActions: ProcurementApprovalAction[];
};
