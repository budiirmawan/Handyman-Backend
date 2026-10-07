import type { UtilityExceptionSeverity, UtilityExceptionStatus } from '../utility-operational-exceptions/utility-operational-exception.types';
import type { MobileUtilityMeterReadingDetail } from '../mobile-utility-meter-reading-verification/mobile-utility-meter-reading-verification.types';

/**
 * CR-BE-RN12-METER-FIELD-01 PART 03 — field reading recheck / correction types.
 *
 * THE MODEL IS THE EXISTING EXCEPTION REGISTER
 * --------------------------------------------
 * A "recheck" is one `utility_operational_exceptions` row of type
 * `READING_RECHECK` (CR-BE-UTL-01 PART 15, extended by migration 0351). It is
 * NOT a new table, NOT a new lifecycle and NOT a second workflow engine:
 *
 *   status            the register's own OPEN → UNDER_REVIEW → RESOLVED, with
 *                     terminal CANCELLED. No state is added, renamed or
 *                     reinterpreted, and every transition runs through the
 *                     register's own guarded UPDATE and canonical event.
 *   meter_reading_id  the ORIGINAL reading, linked at request time and never
 *                     changed afterwards.
 *   proposed_*        the reread, STAGED at review time. A reread is not a
 *                     reading: BE-18E readings are immutable, so a speculative
 *                     one could never be withdrawn.
 *   replacement_meter_reading_id
 *                     the canonical BE-18E reading the staged reread became,
 *                     written by the same guarded UPDATE that resolves, in the
 *                     same transaction that creates it.
 *
 * The original reading is never edited, never deleted and never unlinked from
 * its Reading Due; the pair stays auditable from the one row that holds both
 * ids, plus the register's own operational events.
 */

/** The register's exception type a field recheck is filed under. */
export const MOBILE_READING_RECHECK_EXCEPTION_TYPE = 'READING_RECHECK';

/**
 * Server-derived severity of a field recheck.
 *
 * Never accepted from the client: a technician reporting "this value may be
 * wrong" is stating a fact about their own reading, not triaging operational
 * risk, and a client-chosen severity would make the register's own reporting
 * axis client-authoritative. `MEDIUM` is the register's middle band; a
 * supervisor re-triages through the management surface, which owns severity.
 */
export const MOBILE_READING_RECHECK_SEVERITY: UtilityExceptionSeverity = 'MEDIUM';

/** Server-derived summary; the technician's own words go to `details`. */
export const MOBILE_READING_RECHECK_SUMMARY =
  'Field meter reading recheck requested';

/** Bound on the rechecks projected into one reading detail. */
export const MOBILE_READING_RECHECK_LIMIT = 5;

/**
 * The two decisions the resolve command carries.
 *
 * Both are human decisions about the STAGED reread, exactly as BE-18's OCR
 * accept/reject are human decisions about a staged suggestion. Neither is a
 * status: the register's `status` becomes RESOLVED in both cases, and the
 * difference is whether a replacement reading was created and linked.
 */
export const MOBILE_READING_RECHECK_DECISIONS = [
  'CONFIRM_ORIGINAL',
  'ACCEPT_REPLACEMENT',
] as const;
export type MobileReadingRecheckDecision =
  (typeof MOBILE_READING_RECHECK_DECISIONS)[number];

/**
 * Backend-derived field actions.
 *
 * Every token names a command that EXISTS on this surface and that the
 * AUTHENTICATED caller may execute NOW, on THIS reading. Nothing is emitted
 * speculatively, nothing is emitted for a command the caller would be refused
 * for, and nothing here is a status: the list is recomputed per request from
 * persisted state plus the caller's own authority.
 *
 *   ADD_EVIDENCE          POST .../readings/:readingId/evidence (PART 02). BE-18F
 *                         imposes no state gate on reading evidence — a reading
 *                         that was genuinely taken can always receive its photo —
 *                         so this is available whenever the detail is readable.
 *   SUBMIT_RECHECK        POST .../readings/:readingId/recheck. Available only
 *                         while NO recheck of this reading is active: the
 *                         register's unique-active-source rule would refuse a
 *                         second one with 409 UTILITY_EXCEPTION_ALREADY_OPEN.
 *   SUBMIT_REREAD         POST .../recheck/:recheckId/reread. Available while the
 *                         recheck is ACTIVE (OPEN or UNDER_REVIEW), which is
 *                         exactly the register's own staging guard: a staged
 *                         measurement can be corrected while the review is open.
 *   CONFIRM_READING       POST .../recheck/:recheckId/resolve with
 *                         CONFIRM_ORIGINAL. Available for the whole ACTIVE life of
 *                         the recheck. The register resolves only from
 *                         UNDER_REVIEW, so confirming an OPEN recheck performs the
 *                         register's OWN review transition first and then resolves,
 *                         atomically: a technician who finds the recorded value
 *                         correct never has to stage a reread to say so.
 *   ACCEPT_REPLACEMENT    The same resolve command with ACCEPT_REPLACEMENT: the
 *                         other half of the field actor's choice, and the only
 *                         path that creates a replacement reading. Emitted only
 *                         when a reread is actually staged, which is when the
 *                         command can succeed.
 *
 * A resolved or cancelled recheck removes SUBMIT_REREAD, CONFIRM_READING and
 * ACCEPT_REPLACEMENT. SUBMIT_RECHECK returns, because the register keeps
 * resolved history append-only and permits a fresh recheck of the same reading:
 * the action reappears only where the command genuinely succeeds again.
 */
export const MOBILE_READING_AVAILABLE_ACTIONS = [
  'ADD_EVIDENCE',
  'SUBMIT_RECHECK',
  'SUBMIT_REREAD',
  'CONFIRM_READING',
  'ACCEPT_REPLACEMENT',
] as const;
export type MobileReadingAvailableAction =
  (typeof MOBILE_READING_AVAILABLE_ACTIONS)[number];

/**
 * The resolution outcome, DERIVED server-side from persisted columns.
 *
 * `ACCEPTED_REPLACEMENT` when a RESOLVED recheck carries a replacement reading,
 * `CONFIRMED_ORIGINAL` when it resolved without one, and null while the recheck
 * is still open or was cancelled. A field client never infers this: it is
 * projected, so the correction is legible without reading two columns and
 * reasoning about their combination.
 */
export const MOBILE_READING_RECHECK_OUTCOMES = [
  'CONFIRMED_ORIGINAL',
  'ACCEPTED_REPLACEMENT',
] as const;
export type MobileReadingRecheckOutcome =
  (typeof MOBILE_READING_RECHECK_OUTCOMES)[number];

/** The replacement reading a staged reread became, projected from BE-18E. */
export type MobileReadingReplacement = {
  id: string;
  readingValue: number;
  readingAt: string;
  source: string;
  readingType: string;
  recordedByUserId: string;
  createdAt: string;
};

/** One recheck of this reading, as the field surface projects it. */
export type MobileReadingRecheck = {
  /** The exception register row id — the `recheckId` of the field commands. */
  id: string;
  /** The register's own status. No PART 03 state exists. */
  status: UtilityExceptionStatus;
  severity: UtilityExceptionSeverity;
  summary: string;
  /** The technician's stated reason (`details` on the register row). */
  reason: string | null;
  /** The ORIGINAL reading this recheck is linked to. Always this reading. */
  meterReadingId: string;
  readingDueId: string | null;
  requestedByUserId: string;
  requestedAt: string;
  reviewerUserId: string | null;
  reviewStartedAt: string | null;
  /** The STAGED reread, null until one is submitted. */
  proposedReadingValue: number | null;
  proposedReadingAt: string | null;
  proposedReadingNotes: string | null;
  /** Server-derived from persisted columns; see MOBILE_READING_RECHECK_OUTCOMES. */
  outcome: MobileReadingRecheckOutcome | null;
  /** The canonical BE-18E reading the accepted reread became, else null. */
  replacementReading: MobileReadingReplacement | null;
  resolvedByUserId: string | null;
  resolvedAt: string | null;
  resolutionNotes: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Body of the recheck request: the technician's reason, nothing else. */
export type MobileReadingRecheckRequestInput = {
  reason?: string | null;
};

/** Body of the resolve command. */
export type MobileReadingRecheckResolveInput = {
  decision: MobileReadingRecheckDecision;
  resolutionNotes: string;
};

/** The result of a resolve: the recheck plus what the decision produced. */
export type MobileReadingRecheckResolution = {
  recheck: MobileReadingRecheck;
  /**
   * The replacement reading created by ACCEPT_REPLACEMENT, and null for
   * CONFIRM_ORIGINAL — the explicit statement that confirming the original
   * created no reading at all.
   */
  replacementReading: MobileReadingReplacement | null;
};

/**
 * The field reading DETAIL, PART 03.
 *
 * Strictly additive over PART 02's detail (which is itself strictly additive
 * over PART 01's bounded DTO): every existing field keeps its name, type and
 * value, and the LIST route stays on the lightweight DTO.
 */
export type MobileUtilityMeterReadingLifecycleDetail =
  MobileUtilityMeterReadingDetail & {
    /** This reading's rechecks, newest first, bounded. */
    rechecks: MobileReadingRecheck[];
    /** Caller-specific, backend-derived, executable now. */
    availableActions: MobileReadingAvailableAction[];
  };

/**
 * Authority keys a field client must never supply on the recheck request. Each
 * is refused with the reason it is server-derived rather than silently dropped.
 */
export const MOBILE_READING_RECHECK_BODY_FIELDS = ['reason'] as const;
export const MOBILE_READING_RECHECK_DERIVED_FIELDS: Readonly<
  Record<string, string>
> = {
  meterReadingId:
    'meterReadingId comes from the route path; a recheck is always linked to the reading it is addressed on.',
  readingDueId:
    'readingDueId comes from the route path and is the field execution that produced the reading.',
  exceptionType:
    'exceptionType is READING_RECHECK for this command and is never chosen by the caller.',
  severity:
    'severity is server-derived; re-triage is a management act on the exception register.',
  status: 'status is the register’s own lifecycle and is never supplied.',
  summary: 'summary is server-derived from the command.',
  detectedByUserId: 'the requester is the authenticated session.',
  replacementMeterReadingId:
    'a replacement reading is created only by resolving with ACCEPT_REPLACEMENT.',
  proposedReadingValue:
    'the reread value belongs to the reread command, not to the recheck request.',
  proposedReadingAt:
    'the reread instant belongs to the reread command, not to the recheck request.',
  clientId: 'the Client is derived from the reading.',
  buildingId: 'the Building is derived from the reading.',
  meterId: 'the Meter is derived from the reading.',
};

/** The resolve body: a decision and the register's own resolution notes. */
export const MOBILE_READING_RECHECK_RESOLVE_BODY_FIELDS = [
  'decision',
  'resolutionNotes',
] as const;
export const MOBILE_READING_RECHECK_RESOLVE_DERIVED_FIELDS: Readonly<
  Record<string, string>
> = {
  meterReadingId:
    'meterReadingId comes from the route path; a decision never re-points the recheck.',
  readingDueId: 'readingDueId comes from the route path.',
  recheckId: 'the recheck comes from the route path.',
  status:
    'status is the register’s own lifecycle; a decision resolves, it never sets a state.',
  replacementMeterReadingId:
    'the replacement reading is created by the backend from the staged reread and is never supplied.',
  readingValue:
    'the value belongs to the reread command; a decision never restates or edits it.',
  readingAt:
    'the instant belongs to the reread command; a decision would otherwise create a reading the backend did not stage.',
  resolvedByUserId: 'the resolver is the authenticated session.',
  resolvedAt: 'the resolution timestamp is server time.',
};
