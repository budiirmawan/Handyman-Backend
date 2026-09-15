/**
 * BE-08G — Work Order Evidence Binding domain types.
 *
 * Binds a Work Order to the existing BE-07 shared evidence engine
 * (`evidence_requirements` + `evidence_submissions`). No separate Work Order
 * evidence engine is created: Work Order requirements target
 * `target_type = 'WORK_ORDER'`, and submissions use
 * `execution_type = 'WORK_ORDER'` with `execution_id = work_order_id`.
 */
export const WORK_ORDER_EVIDENCE_TYPES = [
  'PHOTO',
  'DOCUMENT',
  'SIGNATURE',
] as const;

export type WorkOrderEvidenceType = (typeof WORK_ORDER_EVIDENCE_TYPES)[number];

export function isWorkOrderEvidenceType(
  value: unknown,
): value is WorkOrderEvidenceType {
  return (
    typeof value === 'string' &&
    (WORK_ORDER_EVIDENCE_TYPES as readonly string[]).includes(value)
  );
}

/** A BE-07 evidence requirement bound to a Work Order. */
export type PublicWorkOrderEvidenceRequirement = {
  id: string;
  clientId: string;
  workOrderId: string;
  evidenceType: WorkOrderEvidenceType;
  required: boolean;
  minimumCount: number;
  maximumCount: number | null;
  description: string | null;
  status: string;
};

/** A BE-07 evidence submission bound to a Work Order. */
export type PublicWorkOrderEvidence = {
  id: string;
  clientId: string;
  workOrderId: string;
  evidenceRequirementId: string | null;
  evidenceType: WorkOrderEvidenceType;
  fileReference: string;
  originalFileName: string;
  mimeType: string;
  fileSize: number;
  capturedAt: string | null;
  submittedByUserId: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
};

/** Input for submitting Work Order evidence. */
export type SubmitWorkOrderEvidenceInput = {
  workOrderId: string;
  /** Resolved by the service from the Work Order; callers may omit it. */
  clientId?: string;
  evidenceType: WorkOrderEvidenceType;
  evidenceRequirementId?: string;
  fileReference: string;
  originalFileName: string;
  mimeType: string;
  fileSize: number;
  capturedAt?: string;
  submittedByUserId: string;
};
