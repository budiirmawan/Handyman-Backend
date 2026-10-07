import type { PoolClient } from 'pg';
import type { UtilityType } from '../utility-meters';

export const UTILITY_EXCEPTION_TYPES = [
  'ABNORMAL_CONSUMPTION',
  'MISSING_OR_LATE_READING',
  'OCR_MANUAL_FOLLOW_UP',
  'RECONCILIATION_VARIANCE',
  'UNALLOCATED_CONSUMPTION',
  'OTHER',
  /**
   * CR-BE-RN12-METER-FIELD-01 PART 03 — a field recheck of one BE-18E Meter
   * Reading. The register's own lifecycle (OPEN → UNDER_REVIEW → RESOLVED,
   * terminal CANCELLED) carries it; this token only names the concern. The
   * recheck payload lives in the four additive columns below, so the ORIGINAL
   * reading is never edited, never deleted and never unlinked from its Reading
   * Due, and a replacement reading exists only once it is accepted.
   */
  'READING_RECHECK',
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
  /**
   * CR-BE-RN12-METER-FIELD-01 PART 03 — recheck payload (READING_RECHECK only).
   *
   * `proposed*` is the STAGED reread: a measurement the technician re-read, not
   * yet a reading. `replacementMeterReadingId` is the canonical BE-18E reading
   * that reread became when the replacement was ACCEPTED, written in the same
   * transaction as the reading itself. `meterReadingId` remains the ORIGINAL
   * reading, so the original ↔ replacement relation is auditable from this one
   * row in both directions. NUMERIC is carried as text, matching the register's
   * sibling repositories (OCR candidates, consumptions).
   */
  replacementMeterReadingId: string | null;
  proposedReadingValue: string | null;
  proposedReadingAt: Date | null;
  proposedReadingNotes: string | null;
  createdAt: Date;
  updatedAt: Date;
};
export type PublicUtilityOperationalException = Omit<
  UtilityOperationalExceptionRecord,
  | 'detectedAt'
  | 'reviewStartedAt'
  | 'resolvedAt'
  | 'cancelledAt'
  | 'createdAt'
  | 'updatedAt'
  | 'proposedReadingValue'
  | 'proposedReadingAt'
> & {
  detectedAt: string;
  reviewStartedAt: string | null;
  resolvedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** PART 03 — the staged reread value, as a number (null when not staged). */
  proposedReadingValue: number | null;
  proposedReadingAt: string | null;
};

/**
 * PART 03 — the reread a field actor stages against an OPEN `READING_RECHECK`.
 *
 * Measurement facts only, exactly the shape the online field submit accepts:
 * the value the technician read and the instant they read it, plus an optional
 * note that becomes the replacement reading's own note if the replacement is
 * accepted. The meter, UOM, decimal precision, source, readingType and actor
 * stay server-derived, and nothing here is a status: the lifecycle transition
 * is the register's own OPEN → UNDER_REVIEW.
 */
export type UtilityExceptionReadingReread = {
  readingValue: number;
  readingAt: Date;
  notes?: string | null;
};

/** A transaction-capable executor, matching the other BE-18 repositories. */
export type UtilityExceptionExecutor = Pick<PoolClient, 'query'>;

/**
 * PART 03 — additive resolution options. Omitted entirely by every existing
 * caller, whose behaviour is byte-identical: a plain resolve links no
 * replacement and runs on the pool.
 */
export type ResolveUtilityExceptionOptions = {
  /** The canonical reading the accepted reread became (READING_RECHECK only). */
  replacementMeterReadingId?: string | null;
  /** Present when the caller owns the transaction that created the reading. */
  executor?: UtilityExceptionExecutor;
};

/**
 * PART 03 — additive review-transition options. Omitted by every existing
 * caller, whose behaviour is byte-identical (the transition runs on the pool).
 *
 * It exists because one field command legitimately performs TWO of the
 * register's own transitions in one atomic step: resolving a `READING_RECHECK`
 * by CONFIRMING the original reading, from OPEN, opens the review and resolves
 * it. Both writes are the register's own guarded statements on the caller's
 * connection, so a command can never leave a row reviewed-but-unresolved
 * because of a failure between the two.
 */
export type StartUtilityExceptionReviewOptions = {
  /** Present when the caller owns the transaction this transition belongs to. */
  executor?: UtilityExceptionExecutor;
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
