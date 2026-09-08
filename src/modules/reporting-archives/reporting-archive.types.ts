import type { ReportingExportDataset } from '../reporting-export';

/** CR-BE-EXP-01 PART 01 — archive format identity (rendering is later work). */
export const REPORT_ARCHIVE_FORMATS = ['JSON', 'CSV', 'XLSX', 'PDF'] as const;
export type ReportArchiveFormat = (typeof REPORT_ARCHIVE_FORMATS)[number];

/** Generation lifecycle; retention is deliberately a separate state. */
export const REPORT_ARCHIVE_STATUSES = [
  'REQUESTED',
  'GENERATING',
  'COMPLETED',
  'FAILED',
] as const;
export type ReportArchiveStatus = (typeof REPORT_ARCHIVE_STATUSES)[number];

/** Reuses the existing evidence-retention lifecycle vocabulary. */
export const REPORT_ARCHIVE_RETENTION_STATES = [
  'ACTIVE',
  'RETENTION_DUE',
  'PURGED',
] as const;
export type ReportArchiveRetentionState =
  (typeof REPORT_ARCHIVE_RETENTION_STATES)[number];

export type ReportArchiveJsonObject = Record<string, unknown>;

/** Raw persisted archive/request record. Storage reference is internal only. */
export type ReportArchiveRecord = {
  id: string;
  clientId: string;
  buildingId: string | null;
  buildingIds: string[];
  dataset: ReportingExportDataset;
  format: ReportArchiveFormat;
  status: ReportArchiveStatus;
  filterSnapshot: ReportArchiveJsonObject;
  sourceProvenance: ReportArchiveJsonObject;
  asOf: Date | null;
  requestedByUserId: string;
  requestedAt: Date;
  generatedAt: Date | null;
  storageReference: string | null;
  filename: string | null;
  contentType: string | null;
  fileSize: number | string | null;
  checksum: string | null;
  checksumAlgorithm: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  failedAt: Date | null;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: Date | null;
  idempotencyKeyHash: string | null;
  requestFingerprint: string;
  supersedesArchiveId: string | null;
  retentionPolicyId: string | null;
  retentionPolicyCode: string | null;
  retentionDaysSnapshot: number | null;
  retentionAppliedAt: Date | null;
  retainedUntil: Date | null;
  retentionState: ReportArchiveRetentionState;
  retentionHold: boolean;
  retentionHoldReason: string | null;
  retentionHoldSetAt: Date | null;
  purgedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Public contract intentionally omits the internal storage reference/hash. */
export type PublicReportArchive = {
  id: string;
  clientId: string;
  buildingId: string | null;
  buildingIds: string[];
  dataset: ReportingExportDataset;
  format: ReportArchiveFormat;
  status: ReportArchiveStatus;
  filterSnapshot: ReportArchiveJsonObject;
  sourceProvenance: ReportArchiveJsonObject;
  asOf: string | null;
  requestedByUserId: string;
  requestedAt: string;
  generatedAt: string | null;
  artifact: {
    available: boolean;
    filename: string | null;
    contentType: string | null;
    fileSize: number | null;
    checksum: string | null;
    checksumAlgorithm: string | null;
  };
  failure: {
    code: string;
    message: string;
    failedAt: string;
  } | null;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  supersedesArchiveId: string | null;
  retention: {
    policyId: string | null;
    policyCode: string | null;
    daysSnapshot: number | null;
    appliedAt: string | null;
    retainedUntil: string | null;
    state: ReportArchiveRetentionState;
    hold: boolean;
    holdReason: string | null;
    purgedAt: string | null;
  };
  createdAt: string;
  updatedAt: string;
};

export type ReportArchiveRequestInput = {
  clientId: string;
  buildingId?: string;
  buildingIds?: string[];
  dataset: ReportingExportDataset;
  format: ReportArchiveFormat;
  filters: ReportArchiveJsonObject;
};

export type CreateReportArchiveInput = {
  clientId: string;
  buildingId: string | null;
  buildingIds: string[];
  dataset: ReportingExportDataset;
  format: ReportArchiveFormat;
  filters: ReportArchiveJsonObject;
  sourceProvenance: ReportArchiveJsonObject;
  requestedByUserId: string;
  idempotencyKeyHash: string | null;
  requestFingerprint: string;
};

export type ReportArchiveCompletionInput = {
  sourceProvenance: ReportArchiveJsonObject;
  asOf: Date;
  generatedAt: Date;
  storageReference: string;
  filename: string;
  contentType: string;
  fileSize: number;
  checksum: string;
  checksumAlgorithm: string;
};

export type ReportArchiveFailureInput = {
  failureCode: string;
  failureMessage: string;
  failedAt: Date;
};

export type ReportArchiveDownload = {
  buffer: Buffer;
  contentType: string;
  filename: string;
  fileSize: number;
};

export type ReportArchiveListFilters = {
  clientId?: string;
  buildingId?: string;
  dataset?: ReportingExportDataset;
  format?: ReportArchiveFormat;
  status?: ReportArchiveStatus;
};

export type ReportArchiveAccessibleScope = {
  buildingIds: string[];
  clientIds: string[];
};

export type ReportArchiveListPage = {
  items: ReportArchiveRecord[];
  total: number;
};
