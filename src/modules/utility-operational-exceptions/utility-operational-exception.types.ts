import type { UtilityType } from '../utility-meters';

export const UTILITY_EXCEPTION_TYPES = [
  'ABNORMAL_CONSUMPTION',
  'MISSING_OR_LATE_READING',
  'OCR_MANUAL_FOLLOW_UP',
  'RECONCILIATION_VARIANCE',
  'UNALLOCATED_CONSUMPTION',
  'OTHER',
] as const;
export type UtilityExceptionType = (typeof UTILITY_EXCEPTION_TYPES)[number];
export const UTILITY_EXCEPTION_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type UtilityExceptionSeverity = (typeof UTILITY_EXCEPTION_SEVERITIES)[number];
export const UTILITY_EXCEPTION_STATUSES = ['OPEN', 'UNDER_REVIEW', 'RESOLVED', 'CANCELLED'] as const;
export type UtilityExceptionStatus = (typeof UTILITY_EXCEPTION_STATUSES)[number];

export type UtilityOperationalExceptionRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  utilityType: UtilityType;
  meterId: string | null;
  meterReadingId: string | null;
  readingDueId: string | null;
  consumptionId: string | null;
  abnormalConsumptionId: string | null;
  ocrCandidateId: string | null;
  reconciliationId: string | null;
  exceptionType: UtilityExceptionType;
  severity: UtilityExceptionSeverity;
  status: UtilityExceptionStatus;
  summary: string;
  details: string | null;
  detectedAt: Date;
  detectedByUserId: string;
  reviewerUserId: string | null;
  reviewNotes: string | null;
  reviewStartedAt: Date | null;
  resolvedByUserId: string | null;
  resolvedAt: Date | null;
  resolutionNotes: string | null;
  cancelledByUserId: string | null;
  cancelledAt: Date | null;
  cancellationReason: string | null;
  createdAt: Date;
  updatedAt: Date;
};
export type PublicUtilityOperationalException = Omit<
  UtilityOperationalExceptionRecord,
  'detectedAt' | 'reviewStartedAt' | 'resolvedAt' | 'cancelledAt' | 'createdAt' | 'updatedAt'
> & {
  detectedAt: string;
  reviewStartedAt: string | null;
  resolvedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
};
export type CreateUtilityOperationalExceptionInput = {
  meterId?: string;
  meterReadingId?: string;
  readingDueId?: string;
  consumptionId?: string;
  abnormalConsumptionId?: string;
  ocrCandidateId?: string;
  reconciliationId?: string;
  exceptionType: UtilityExceptionType;
  severity: UtilityExceptionSeverity;
  summary: string;
  details?: string | null;
};
export type UtilityExceptionFilters = {
  clientId?: string;
  buildingId?: string;
  utilityType?: UtilityType;
  exceptionType?: UtilityExceptionType;
  severity?: UtilityExceptionSeverity;
  status?: UtilityExceptionStatus;
  reconciliationId?: string;
};
export type ResolvedUtilityExceptionContext = {
  clientId: string;
  buildingId: string;
  utilityType: UtilityType;
  meterId: string | null;
  meterReadingId: string | null;
  readingDueId: string | null;
  consumptionId: string | null;
  abnormalConsumptionId: string | null;
  ocrCandidateId: string | null;
  reconciliationId: string | null;
};
