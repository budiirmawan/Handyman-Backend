import { AppError, ERROR_CODES } from '../../shared/errors';
import { getPool, withTransaction } from '../../database';
import { resolvePermissionsForUser } from '../permissions/permission.service';
import { utilityMeterReadingAlreadyExistsError } from '../utility-meter-readings/utility-meter-reading.errors';
import { utilityMeterReadingRepository } from '../utility-meter-readings/utility-meter-reading.repository';
import { recordUtilityMeterReading } from '../utility-meter-readings/utility-meter-reading.service';
import type { UtilityMeterReadingRecord } from '../utility-meter-readings/utility-meter-reading.types';
import { utilityExceptionNotFoundError } from '../utility-operational-exceptions/utility-operational-exception.errors';
import { utilityOperationalExceptionRepository } from '../utility-operational-exceptions/utility-operational-exception.repository';
import {
  createUtilityOperationalException,
  resolveUtilityException,
  stageUtilityExceptionReadingReread,
  startUtilityExceptionReview,
} from '../utility-operational-exceptions/utility-operational-exception.service';
import type { UtilityOperationalExceptionRecord } from '../utility-operational-exceptions/utility-operational-exception.types';
import {
  MOBILE_FIELD_READING_SOURCE,
  MOBILE_FIELD_READING_TYPE,
  type MobileUtilityMeterReadingInput,
} from '../mobile-utility-meter-reading/mobile-utility-meter-reading.types';
import {
  authorizeFieldReading,
  getMobileUtilityMeterReadingDetail,
} from '../mobile-utility-meter-reading-verification/mobile-utility-meter-reading-verification.service';
import {
  MOBILE_READING_AVAILABLE_ACTIONS,
  MOBILE_READING_RECHECK_EXCEPTION_TYPE,
  MOBILE_READING_RECHECK_LIMIT,
  MOBILE_READING_RECHECK_SEVERITY,
  MOBILE_READING_RECHECK_SUMMARY,
  type MobileReadingAvailableAction,
  type MobileReadingRecheck,
  type MobileReadingRecheckRequestInput,
  type MobileReadingRecheckResolution,
  type MobileReadingRecheckResolveInput,
  type MobileReadingReplacement,
  type MobileUtilityMeterReadingLifecycleDetail,
} from './mobile-utility-meter-reading-lifecycle.types';

/**
 * CR-BE-RN12-METER-FIELD-01 PART 03 — field reading recheck / correction.
 *
 * ONE CONCERN: close the BE-18 field-reading lifecycle without weakening the
 * immutability of a reading. Three commands, one projection, one derived action
 * list — and NO new workflow engine, NO new lifecycle state, NO second reading
 * store and NO new permission.
 *
 * THE MODEL IS THE EXISTING EXCEPTION REGISTER
 * --------------------------------------------
 * A recheck is one `utility_operational_exceptions` row of type
 * `READING_RECHECK`. The register already references a Meter Reading AND its
 * Reading Due, already owns OPEN → UNDER_REVIEW → RESOLVED plus terminal
 * CANCELLED with database-enforced stamps, already forbids two active exceptions
 * per (type, source), and already writes canonical `UTILITY_EXCEPTION_*` events.
 * PART 03 adds a payload to it (migration 0351) and a field-safe door in front of
 * it — not a parallel lifecycle.
 *
 * WHY THE ORIGINAL READING IS NEVER TOUCHED
 * -----------------------------------------
 * BE-18E readings are append-only: no UPDATE or DELETE input exists anywhere in
 * the module, and `utilityMeterReadingImmutableError` is the canonical refusal.
 * A correction is therefore expressed as a RELATION between two immutable
 * readings, held by the register row: `meter_reading_id` is the original,
 * `replacement_meter_reading_id` is what the reread became. The original keeps
 * its value, its provenance, its audit event and its Reading Due link forever.
 *
 * WHY A REREAD IS STAGED BEFORE IT EXISTS
 * ---------------------------------------
 * An immutable reading can never be withdrawn, so a speculative one must never be
 * created. The reread is staged on the register row
 * (`proposed_reading_value` / `_at` / `_notes`) and becomes a canonical BE-18E
 * reading ONLY when a human accepts the replacement — in ONE transaction with the
 * resolve that links it, through the SAME `recordUtilityMeterReading` the
 * management and field surfaces use. Confirming the original creates nothing.
 *
 * WHAT IS REUSED, VERBATIM
 * ------------------------
 *   - field authority: PART 02's `authorizeFieldReading` (the reading-keyed seam
 *     over PART 00's due-keyed authority, plus the path-due agreement rule). One
 *     authority, one implementation, one pinned order.
 *   - permission: PART 01's `utility_meter.field.record` on the three commands.
 *     A recheck, a reread and its resolution are acts of recording and correcting
 *     a field reading, which is exactly what that code already grants; no new
 *     code is seeded and `utility_meter.field.read` still governs the detail.
 *   - lifecycle transitions, guards, stamps and events: the register's own
 *     service functions.
 *   - reading creation, UOM resolution, decimal precision, ACTIVE-meter rule,
 *     tenant snapshot, meter + instant uniqueness and the
 *     `UTILITY_METER_READING_RECORDED` event: canonical BE-18E.
 *   - provenance tokens: PART 01's `MANUAL` / `ACTUAL`. No new enum token.
 *   - errors: the register's and BE-18E's own codes. None invented.
 *
 * NOT DONE HERE
 * -------------
 * No consumption recalculation, no abnormality evaluation, no billing or tariff
 * involvement, no OCR, no QR, no recheck of a recheck beyond what the register
 * already allows, no BE-25H `METER_READING` change, and no client-side status or
 * action inference: `availableActions` is derived here, per caller, per request.
 */

/** The permission each derived action actually requires at its own route. */
const ACTION_PERMISSIONS: Readonly<Record<MobileReadingAvailableAction, string>> =
  {
    ADD_EVIDENCE: 'utility_meter.field.evidence',
    SUBMIT_RECHECK: 'utility_meter.field.record',
    SUBMIT_REREAD: 'utility_meter.field.record',
    CONFIRM_READING: 'utility_meter.field.record',
    ACCEPT_REPLACEMENT: 'utility_meter.field.record',
  };

function iso(value: Date | null | undefined): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

/** BE-18E reading row → the bounded replacement projection. */
function toMobileReadingReplacement(
  reading: UtilityMeterReadingRecord,
): MobileReadingReplacement {
  return {
    id: reading.id,
    readingValue: Number(reading.readingValue),
    readingAt: reading.readingAt.toISOString(),
    source: reading.source,
    readingType: reading.readingType,
    recordedByUserId: reading.recordedByUserId,
    createdAt: reading.createdAt.toISOString(),
  };
}

/**
 * Register row → the field recheck projection.
 *
 * Persisted columns only, plus ONE derived field: `outcome`, computed from
 * `status` and the replacement link so a field client never has to infer whether
 * a resolution confirmed the original or accepted the reread. Every state value
 * is the register's own; no PART 03 status exists.
 */
function toMobileReadingRecheck(
  record: UtilityOperationalExceptionRecord,
  replacement: UtilityMeterReadingRecord | null,
): MobileReadingRecheck {
  return {
    id: record.id,
    status: record.status,
    severity: record.severity,
    summary: record.summary,
    reason: record.details,
    // Guaranteed non-null by both call sites: the projection is only ever built
    // from rows selected or verified by `meter_reading_id`.
    meterReadingId: record.meterReadingId ?? '',
    readingDueId: record.readingDueId,
    requestedByUserId: record.detectedByUserId,
    requestedAt: record.detectedAt.toISOString(),
    reviewerUserId: record.reviewerUserId,
    reviewStartedAt: iso(record.reviewStartedAt),
    proposedReadingValue:
      record.proposedReadingValue === null
        ? null
        : Number(record.proposedReadingValue),
    proposedReadingAt: iso(record.proposedReadingAt),
    proposedReadingNotes: record.proposedReadingNotes,
    outcome:
      record.status !== 'RESOLVED'
        ? null
        : record.replacementMeterReadingId
          ? 'ACCEPTED_REPLACEMENT'
          : 'CONFIRMED_ORIGINAL',
    replacementReading: replacement ? toMobileReadingReplacement(replacement) : null,
    resolvedByUserId: record.resolvedByUserId,
    resolvedAt: iso(record.resolvedAt),
    resolutionNotes: record.resolutionNotes,
    cancelledAt: iso(record.cancelledAt),
    cancellationReason: record.cancellationReason,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/** Re-reads one register row and projects it with its replacement reading. */
async function projectRecheck(recheckId: string): Promise<MobileReadingRecheck> {
  const record = await utilityOperationalExceptionRepository.findById(recheckId);
  if (!record) throw utilityExceptionNotFoundError();
  const replacement = record.replacementMeterReadingId
    ? await utilityMeterReadingRepository.findById(record.replacementMeterReadingId)
    : null;
  return toMobileReadingRecheck(record, replacement);
}

/**
 * This reading's rechecks, newest first and bounded.
 *
 * Read-only, from the register's own repository. Resolved and cancelled rechecks
 * are included: they ARE the audit trail of the correction, and hiding them would
 * make the original ↔ replacement relation invisible from the field surface.
 */
export async function buildMobileReadingRechecks(
  readingId: string,
): Promise<MobileReadingRecheck[]> {
  const rows = await utilityOperationalExceptionRepository.listByMeterReading(
    readingId,
    MOBILE_READING_RECHECK_EXCEPTION_TYPE,
  );
  const bounded = rows.slice(0, MOBILE_READING_RECHECK_LIMIT);
  const replacements = await Promise.all(
    bounded.map((row) =>
      row.replacementMeterReadingId
        ? utilityMeterReadingRepository.findById(row.replacementMeterReadingId)
        : Promise.resolve(null),
    ),
  );
  return bounded.map((row, index) => toMobileReadingRecheck(row, replacements[index]));
}

/**
 * The caller-specific, backend-derived action list.
 *
 * TWO GATES, BOTH SERVER-SIDE
 * ---------------------------
 *   1. STATE — an action is emitted only where its command's own guard would
 *      admit it right now: the register's unique-active-source rule for
 *      SUBMIT_RECHECK, its staging guard (OPEN or UNDER_REVIEW) for
 *      SUBMIT_REREAD, an ACTIVE recheck for CONFIRM_READING — whose command
 *      performs the register's own review transition when the recheck is still
 *      OPEN — and an UNDER_REVIEW recheck with a staged reread for
 *      ACCEPT_REPLACEMENT, which is the only decision that creates a reading.
 *   2. PERMISSION — the authenticated caller must hold the permission the
 *      command's own route enforces. The detail is reachable with
 *      `utility_meter.field.read` alone, so a read-only field actor sees
 *      ADD_EVIDENCE only if they also hold `utility_meter.field.evidence`, and no
 *      write action at all without `utility_meter.field.record`. An action this
 *      list emitted but the route would refuse with 403 would be a lie the client
 *      cannot detect.
 *
 * Field authority itself is not re-checked here: the caller reached this
 * projection through `authorizeFieldReading`, which is the same seam every
 * command runs, on the same reading. The order is the documented
 * MOBILE_READING_AVAILABLE_ACTIONS order, so the list is stable for a given
 * state and caller.
 */
export function deriveMobileReadingAvailableActions(
  rechecks: readonly MobileReadingRecheck[],
  permissions: readonly string[],
): MobileReadingAvailableAction[] {
  const active = rechecks.find(
    (recheck) => recheck.status === 'OPEN' || recheck.status === 'UNDER_REVIEW',
  );
  const executable = new Set<MobileReadingAvailableAction>();

  // BE-18F imposes no state gate on reading evidence: a reading that was
  // genuinely taken can always receive its photo.
  executable.add('ADD_EVIDENCE');

  if (!active) {
    // The register keeps resolved/cancelled history append-only and forbids only
    // a SECOND ACTIVE exception per source, so a fresh recheck is executable
    // again once the previous one is terminal.
    executable.add('SUBMIT_RECHECK');
  }
  if (active) {
    // Staging is admitted from OPEN and re-admitted while the review is open, so
    // a measurement the canonical reading rules would refuse can be corrected
    // without a management cancellation.
    executable.add('SUBMIT_REREAD');
    // Confirming the original is executable for the WHOLE active life of the
    // recheck, from OPEN as well as from UNDER_REVIEW: the command performs the
    // register's own OPEN → UNDER_REVIEW transition itself before resolving, so
    // a technician who checks the meter and finds the recorded value correct
    // never has to stage a reread they do not believe in.
    executable.add('CONFIRM_READING');
    if (active.status === 'UNDER_REVIEW' && active.proposedReadingValue !== null) {
      // Acceptance needs something staged: it is the ONLY path that turns a
      // proposal into a reading, and it is offered only where it can succeed.
      executable.add('ACCEPT_REPLACEMENT');
    }
  }

  return MOBILE_READING_AVAILABLE_ACTIONS.filter(
    (action) =>
      executable.has(action) && permissions.includes(ACTION_PERMISSIONS[action]),
  );
}

/**
 * Loads one register row and proves it is a recheck OF THIS READING.
 *
 * Fail-closed and 404-on-mismatch, on the PART 02 pattern: a recheck of another
 * reading — or any other exception type — is reported as not found, so this
 * surface can never be used to advance a lifecycle the caller has no business
 * touching and never confirms that one exists.
 */
async function loadRecheckForReading(
  recheckId: string,
  readingId: string,
): Promise<UtilityOperationalExceptionRecord> {
  const record = await utilityOperationalExceptionRepository.findById(recheckId);
  if (
    !record ||
    record.exceptionType !== MOBILE_READING_RECHECK_EXCEPTION_TYPE ||
    record.meterReadingId !== readingId
  ) {
    throw utilityExceptionNotFoundError();
  }
  return record;
}

/* -------------------------------------------------------------------------
 * Command 1 — request / open a recheck
 * ---------------------------------------------------------------------- */

/**
 * Files a `READING_RECHECK` against the reading the technician already recorded.
 *
 * The register's own create does the work: it resolves the reading and the due to
 * ONE authoritative Client / Building / utility type, asserts Building access,
 * writes OPEN with the requester stamped, records
 * `UTILITY_EXCEPTION_CREATED`, and refuses a second ACTIVE recheck of the same
 * source with its own 409 `UTILITY_EXCEPTION_ALREADY_OPEN`. Type, severity and
 * summary are server-derived; the caller contributes only an optional reason.
 *
 * The reading itself is untouched: requesting a recheck changes nothing about the
 * value, its provenance, its evidence or its completed due.
 */
export async function requestMobileReadingRecheck(
  readingDueId: string,
  readingId: string,
  actorUserId: string,
  input: MobileReadingRecheckRequestInput,
): Promise<{ recheck: MobileReadingRecheck }> {
  const context = await authorizeFieldReading(readingDueId, readingId, actorUserId);

  const created = await createUtilityOperationalException(
    {
      meterReadingId: context.reading.id,
      readingDueId: context.due.id,
      exceptionType: MOBILE_READING_RECHECK_EXCEPTION_TYPE,
      severity: MOBILE_READING_RECHECK_SEVERITY,
      summary: MOBILE_READING_RECHECK_SUMMARY,
      ...(input.reason === undefined ? {} : { details: input.reason }),
    },
    actorUserId,
  );

  return { recheck: await projectRecheck(created.id) };
}

/* -------------------------------------------------------------------------
 * Command 2 — submit the reread
 * ---------------------------------------------------------------------- */

/**
 * Stages the re-read measurement and opens the recheck's review.
 *
 * The measurement facts are validated by PART 01's own body parser, so a reread
 * states exactly what an online field submit states and is held to exactly the
 * same rule. Nothing else is accepted: the meter, UOM, source, readingType,
 * actor and every lifecycle stamp stay server-derived.
 *
 * NO READING IS CREATED HERE. BE-18E's own meter + instant uniqueness is checked
 * before staging rather than at acceptance, because a staged instant that already
 * exists on this meter could never become a reading: refusing it now, with the
 * canonical 409, keeps the recheck correctable instead of stranding it. Decimal
 * precision and every other canonical reading rule stay BE-18E's, enforced when
 * the replacement is actually created — and a refusal there is equally
 * correctable, because staging is admitted again while the review is open.
 */
export async function submitMobileReadingReread(
  readingDueId: string,
  readingId: string,
  recheckId: string,
  actorUserId: string,
  input: MobileUtilityMeterReadingInput,
): Promise<{ recheck: MobileReadingRecheck }> {
  const context = await authorizeFieldReading(readingDueId, readingId, actorUserId);
  await loadRecheckForReading(recheckId, context.reading.id);

  const collision = await getPool().query<{ id: string }>(
    `SELECT id FROM utility_meter_readings WHERE meter_id = $1 AND reading_at = $2`,
    [context.reading.meterId, input.readingAt],
  );
  if (collision.rowCount) {
    throw utilityMeterReadingAlreadyExistsError();
  }

  await stageUtilityExceptionReadingReread(
    recheckId,
    {
      readingValue: input.readingValue,
      readingAt: input.readingAt,
      ...(input.notes === undefined ? {} : { notes: input.notes }),
    },
    actorUserId,
  );

  return { recheck: await projectRecheck(recheckId) };
}

/* -------------------------------------------------------------------------
 * Command 3 — resolve: confirm the original, or accept the replacement
 * ---------------------------------------------------------------------- */

/**
 * Resolves the recheck with one of the two decisions.
 *
 * CONFIRM_ORIGINAL
 *   The register's own transitions, and NOTHING else: the technician's original
 *   reading stands, no reading is created, no value is changed, and the recheck
 *   closes RESOLVED with `resolution_notes` and the resolver stamped. The
 *   projection says so explicitly (`outcome: 'CONFIRMED_ORIGINAL'`,
 *   `replacementReading: null`) so a client never has to infer that a resolution
 *   produced no correction.
 *
 *   The register resolves only from UNDER_REVIEW, so confirming a recheck that is
 *   still OPEN performs the register's OWN OPEN → UNDER_REVIEW transition first
 *   and then resolves — two of its existing guarded statements on ONE connection,
 *   in ONE transaction, each writing its own canonical event
 *   (`UTILITY_EXCEPTION_REVIEW_STARTED`, then `UTILITY_EXCEPTION_RESOLVED`). No
 *   state, transition or event is invented for the field: a confirmation IS a
 *   review that concluded the recorded value was correct, and it is audited as
 *   such. Requiring a staged reread first would be the opposite — it would force
 *   a technician to propose a value they do not believe in order to say the
 *   original stands.
 *
 * ACCEPT_REPLACEMENT
 *   Creates the canonical replacement reading from the STAGED reread and links it,
 *   in ONE transaction:
 *
 *     1. `recordUtilityMeterReading` — the SAME BE-18E application service the
 *        management route, the PART 01 field submit and the offline sync kind all
 *        call, on the transaction's own connection. UOM resolution, decimal
 *        precision, the ACTIVE-meter rule, the tenant snapshot, the meter +
 *        instant uniqueness guard and the `UTILITY_METER_READING_RECORDED` event
 *        are enforced there, once, for every caller. Provenance is PART 01's
 *        `MANUAL` / `ACTUAL`; the actor is the session.
 *     2. the register's guarded resolve, with `replacement_meter_reading_id`
 *        written by the same UPDATE that transitions to RESOLVED.
 *
 *   The executor is shared, so the two writes commit or roll back together: a
 *   replacement reading can never commit without the row that makes it auditable,
 *   and a lost race on the resolution (`WHERE status='UNDER_REVIEW'` matching no
 *   row) rolls the reading back with it — which matters absolutely here, because
 *   an immutable reading can never be deleted afterwards.
 *
 *   The ORIGINAL reading is never edited, never deleted and never unlinked from
 *   its Reading Due: the due keeps pointing at the reading the field execution
 *   produced, and the correction lives in the relation between two readings.
 */
export async function resolveMobileReadingRecheck(
  readingDueId: string,
  readingId: string,
  recheckId: string,
  actorUserId: string,
  input: MobileReadingRecheckResolveInput,
): Promise<MobileReadingRecheckResolution> {
  const context = await authorizeFieldReading(readingDueId, readingId, actorUserId);
  const recheck = await loadRecheckForReading(recheckId, context.reading.id);

  if (input.decision === 'CONFIRM_ORIGINAL') {
    const needsReview = recheck.status === 'OPEN';
    await withTransaction(async (client) => {
      if (needsReview) {
        await startUtilityExceptionReview(recheckId, null, actorUserId, {
          executor: client,
        });
      }
      await resolveUtilityException(recheckId, input.resolutionNotes, actorUserId, {
        executor: client,
      });
    });
    return {
      recheck: await projectRecheck(recheckId),
      replacementReading: null,
    };
  }

  // Captured in locals before the transaction closure: the staged reread is the
  // ONLY source of the replacement's measurement, and a value supplied at resolve
  // time is refused by validation rather than silently substituted.
  const proposedValue = recheck.proposedReadingValue;
  const proposedAt = recheck.proposedReadingAt;
  const proposedNotes = recheck.proposedReadingNotes;
  if (proposedValue === null || proposedAt === null) {
    // The register's own transition code: there is nothing to accept yet.
    throw new AppError({
      code: ERROR_CODES.UTILITY_EXCEPTION_TRANSITION_INVALID,
      message:
        'A replacement can only be accepted after a reread has been staged for this recheck.',
      statusCode: 409,
      resource: { type: 'UTILITY_OPERATIONAL_EXCEPTION', id: recheckId },
    });
  }

  await withTransaction(async (client) => {
    const reading = await recordUtilityMeterReading(
      {
        meterId: context.reading.meterId,
        readingValue: Number(proposedValue),
        readingAt: proposedAt,
        recordedByUserId: actorUserId,
        source: MOBILE_FIELD_READING_SOURCE,
        readingType: MOBILE_FIELD_READING_TYPE,
        ...(proposedNotes === null ? {} : { notes: proposedNotes }),
      },
      actorUserId,
      client,
    );
    await resolveUtilityException(recheckId, input.resolutionNotes, actorUserId, {
      replacementMeterReadingId: reading.id,
      executor: client,
    });
  });

  const resolved = await projectRecheck(recheckId);
  return {
    recheck: resolved,
    replacementReading: resolved.replacementReading,
  };
}

/* -------------------------------------------------------------------------
 * Reading DETAIL — PART 02's detail plus the lifecycle projections
 * ---------------------------------------------------------------------- */

/**
 * The field reading DETAIL, PART 03.
 *
 * PART 02's detail (itself PART 01's bounded DTO plus four additive projections)
 * plus two more additive keys: this reading's `rechecks` and the caller-specific
 * `availableActions`. Authority is PART 01's, exercised once by PART 02's
 * function; nothing here re-derives it, and the LIST route stays on the
 * lightweight DTO.
 */
export async function getMobileUtilityMeterReadingLifecycleDetail(
  readingDueId: string,
  readingId: string,
  actorUserId: string,
): Promise<MobileUtilityMeterReadingLifecycleDetail> {
  const detail = await getMobileUtilityMeterReadingDetail(
    readingDueId,
    readingId,
    actorUserId,
  );
  const [rechecks, permissions] = await Promise.all([
    buildMobileReadingRechecks(readingId),
    resolvePermissionsForUser(actorUserId),
  ]);
  return {
    ...detail,
    rechecks,
    availableActions: deriveMobileReadingAvailableActions(rechecks, permissions),
  };
}

export const mobileUtilityMeterReadingLifecycleService = {
  buildMobileReadingRechecks,
  deriveMobileReadingAvailableActions,
  getMobileUtilityMeterReadingLifecycleDetail,
  requestMobileReadingRecheck,
  resolveMobileReadingRecheck,
  submitMobileReadingReread,
};
