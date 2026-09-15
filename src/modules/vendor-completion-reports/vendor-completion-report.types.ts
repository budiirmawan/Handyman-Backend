/**
 * BE-15F — Vendor Completion Report domain types.
 *
 * A reporting layer over BE-15B Vendor Work, reusing BE-15E's evidence
 * readiness and referencing the BE-08 Work Order. No separate completion
 * workflow engine exists here: the Work Order's own completion lifecycle
 * remains BE-08's authority.
 *
 * Lifecycle: DRAFT → SUBMITTED (final). A SUBMITTED report is immutable and
 * carries `completed_by_user_id` / `completed_at` plus the BE-07
 * evidence-readiness result snapshot.
 */
export const COMPLETION_REPORT_STATUSES = ['DRAFT', 'SUBMITTED'] as const;

export type CompletionReportStatus =
  (typeof COMPLETION_REPORT_STATUSES)[number];

export function isCompletionReportStatus(
  value: unknown,
): value is CompletionReportStatus {
  return (
    typeof value === 'string' &&
    (COMPLETION_REPORT_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type VendorCompletionReportRecord = {
  id: string;
  clientId: string;
  vendorWorkId: string;
  workOrderId: string;
  buildingId: string;
  completionStatus: CompletionReportStatus;
  summary: string | null;
  notes: string | null;
  completedByUserId: string | null;
  completedAt: Date | null;
  evidenceReady: boolean;
  missingEvidenceTypes: string[];
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicVendorCompletionReport = {
  id: string;
  clientId: string;
  vendorWorkId: string;
  workOrderId: string;
  buildingId: string;
  completionStatus: CompletionReportStatus;
  summary: string | null;
  notes: string | null;
  completedByUserId: string | null;
  completedAt: string | null;
  evidenceReady: boolean;
  missingEvidenceTypes: string[];
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

/** Input for creating a completion report (starts as DRAFT). */
export type CreateVendorCompletionReportInput = {
  vendorWorkId: string;
  summary?: string | null;
  notes?: string | null;
  createdByUserId: string;
};

/** Input for updating a DRAFT completion report. */
export type UpdateVendorCompletionReportInput = {
  summary?: string | null;
  notes?: string | null;
};

/** List filters for GET /vendor-completion-reports. */
export type VendorCompletionReportFilters = {
  vendorWorkId?: string;
  vendorId?: string;
  buildingId?: string;
};

/** The BE-07 evidence-readiness result for a Vendor Work. */
export type VendorWorkEvidenceReadiness = {
  ready: boolean;
  missingEvidenceTypes: string[];
};
