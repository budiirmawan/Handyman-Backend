/**
 * BE-15G — Vendor Service Report domain types.
 *
 * A reporting layer over BE-15B Vendor Work, referencing the BE-08 Work Order
 * and (optionally) the BE-15F Completion Report. No separate service workflow
 * engine exists here.
 *
 * Lifecycle: DRAFT → FINALIZED (final). A FINALIZED report is immutable.
 */
export const SERVICE_REPORT_STATUSES = ['DRAFT', 'FINALIZED'] as const;

export type ServiceReportStatus = (typeof SERVICE_REPORT_STATUSES)[number];

export function isServiceReportStatus(value: unknown): value is ServiceReportStatus {
  return (
    typeof value === 'string' &&
    (SERVICE_REPORT_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type VendorServiceReportRecord = {
  id: string;
  clientId: string;
  vendorWorkId: string;
  completionReportId: string | null;
  workOrderId: string;
  buildingId: string;
  serviceReportNumber: string;
  serviceDate: string;
  summary: string | null;
  workPerformed: string | null;
  recommendation: string | null;
  preparedByUserId: string;
  status: ServiceReportStatus;
  finalizedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicVendorServiceReport = {
  id: string;
  clientId: string;
  vendorWorkId: string;
  completionReportId: string | null;
  workOrderId: string;
  buildingId: string;
  serviceReportNumber: string;
  serviceDate: string;
  summary: string | null;
  workPerformed: string | null;
  recommendation: string | null;
  preparedByUserId: string;
  status: ServiceReportStatus;
  finalizedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Input for creating a service report (starts as DRAFT). */
export type CreateVendorServiceReportInput = {
  vendorWorkId: string;
  serviceReportNumber: string;
  serviceDate: string;
  summary?: string | null;
  workPerformed?: string | null;
  recommendation?: string | null;
  preparedByUserId: string;
};

/** Input for updating a DRAFT service report. */
export type UpdateVendorServiceReportInput = {
  serviceDate?: string;
  summary?: string | null;
  workPerformed?: string | null;
  recommendation?: string | null;
};

/** List filters for GET /vendor-service-reports. */
export type VendorServiceReportFilters = {
  vendorWorkId?: string;
  vendorId?: string;
  buildingId?: string;
};
