import {
  computeRequestFingerprint,
  executeIdempotent,
} from '../request-idempotency';
import {
  utilityMeterReadingNotFoundError,
  utilityMeterReadingRepository,
  recordUtilityMeterReading,
  type PublicUtilityMeterReading,
  type UtilityMeterReadingRecord,
} from '../utility-meter-readings';
import {
  assertUtilityMeterFieldActor,
  utilityReadingDueRepository,
  utilityReadingDueService,
} from '../utility-reading-dues';
import { utilityReadingDueNotFoundError, utilityReadingDueTransitionError } from '../utility-reading-dues';
import {
  MOBILE_FIELD_READING_SOURCE,
  MOBILE_FIELD_READING_TYPE,
  RECORD_MOBILE_UTILITY_METER_READING_OPERATION_KEY,
  type MobileUtilityMeterReading,
  type MobileUtilityMeterReadingInput,
  type MobileUtilityMeterReadingResult,
} from './mobile-utility-meter-reading.types';

/**
 * CR-BE-RN12-METER-FIELD-01 PART 01 — mobile field meter-reading service.
 *
 * ONE CANONICAL WRITE, ADDRESSED FROM THE FIELD
 * ---------------------------------------------
 * A field submission calls the SAME `recordUtilityMeterReading` and the SAME
 * `completeUtilityReadingDue` a management or OCR caller uses. There is no
 * second reading store, no field-only event type and no field-only completion
 * semantic. What this module owns is addressing (readingDueId, never a bare
 * meter id), authority (the PART 00 field-actor seam), provenance (server-derived
 * source / readingType / actor / UOM), atomicity, and the concurrency invariant
 * that one Reading Due yields at most one field reading.
 *
 * ORDERING: AUTHORITY BEFORE THE CLAIM, BUSINESS STATE INSIDE IT
 * --------------------------------------------------------------
 * Authentication, `utility_meter.field.record`, Building access and
 * `assertUtilityMeterFieldActor` all run BEFORE `executeIdempotent`, so every
 * attempt — including a replay — revalidates authority and a foreign or
 * unauthorized id can never poison a key.
 *
 * The due-STATE guard runs INSIDE the idempotent execution, which is what makes
 * replay correct. A successful first execution completes the due; if the state
 * guard ran before the claim, the identical same-key retry would be rejected for
 * a due that is now COMPLETED — punishing a client for exactly the retry the
 * idempotency contract tells it to make. Inside the execution, a replay short-
 * circuits on the stored response and never reaches the guard, while a genuinely
 * new intent does. Authority is not weakened by this: it is still re-checked on
 * every single request.
 *
 * ATOMICITY
 * ---------
 * `executeIdempotent` owns ONE transaction and hands its `PoolClient` to `work`.
 * The reading INSERT, the `UTILITY_METER_READING_RECORDED` event, the Reading Due
 * `meter_reading_id` linkage + completion, the `UTILITY_READING_DUE_COMPLETED`
 * event and the idempotency completion all commit or roll back together, through
 * the optional executor seams added to BE-18E / BE-18F. No reading can commit
 * without its audit event and its field-execution link.
 *
 * CONCURRENCY
 * -----------
 * The Reading Due row is locked `FOR UPDATE` at the top of `work`, which
 * serializes concurrent field executions for the SAME due without polling and
 * without an advisory lock. Transaction-scoped row locking is used deliberately:
 * it is released by COMMIT/ROLLBACK, so it cannot leak when `work` throws, and it
 * needs no second pooled connection. Two different-key submissions race on the
 * lock; the winner commits, the loser re-reads a COMPLETED due and fails with the
 * canonical 409, rolling back its own claim — so its key stays unpoisoned and
 * retryable, and no orphan reading survives.
 *
 * The meter-level `UNIQUE (meter_id, reading_at)` guard is preserved untouched
 * and is NOT relied on as field-command idempotency: distinct `readingAt` values
 * remain distinct readings, and it is the due's cardinality — not the instant
 * index — that makes one due yield at most one field reading.
 *
 * NOT DONE HERE
 * -------------
 * No consumption row, no `current − previous` arithmetic, no abnormality rules,
 * no evidence, no OCR, no recheck, no `availableActions`, no QR, no mobile-sync
 * change. BE-18G consumption and every downstream signal remain backend concerns
 * outside PART 01.
 */

/**
 * Canonical BE-18E record → the bounded mobile DTO.
 *
 * Exported so the PART 00 meter context projects the due's linked reading with
 * the SAME mapper, rather than a second divergent definition of what a submitted
 * field reading looks like.
 */
export function toMobileUtilityMeterReading(
  record: UtilityMeterReadingRecord,
): MobileUtilityMeterReading {
  return {
    id: record.id,
    meterId: record.meterId,
    uomId: record.uomId,
    readingValue: Number(record.readingValue),
    readingAt: record.readingAt.toISOString(),
    source: record.source,
    readingType: record.readingType,
    notes: record.notes,
    recordedByUserId: record.recordedByUserId,
    createdAt: record.createdAt.toISOString(),
  };
}

/**
 * Records one field Meter Reading against a Reading Due and completes that due.
 *
 * Returns `replayed` so the controller can report whether this was a first
 * execution or a same-key replay of a stored success. Both return the identical
 * stored response body and the same 201 status.
 */
export async function recordMobileUtilityMeterReading(
  readingDueId: string,
  actorUserId: string,
  input: MobileUtilityMeterReadingInput,
  idempotencyKey: string,
): Promise<{ data: MobileUtilityMeterReadingResult; replayed: boolean }> {
  // ---------------------------------------------------------------------
  // AUTHORITY — before the idempotency claim, so it is revalidated on every
  // attempt including replays, and a foreign id never poisons a key.
  // Yields the due and its meter, so nothing about the target is re-derived
  // from the request body.
  // ---------------------------------------------------------------------
  const { due } = await assertUtilityMeterFieldActor(readingDueId, actorUserId);

  // ---------------------------------------------------------------------
  // FINGERPRINT — semantic field intent only. Every server-derived fact
  // (meter, UOM, actor, source, readingType, Building, generated ids, and any
  // timestamp the caller did not supply) is excluded, so two requests that mean
  // the same thing fingerprint identically and two that differ do not.
  // `notes` is normalized to null when absent so an omitted note and an
  // explicitly absent note cannot fingerprint differently.
  // ---------------------------------------------------------------------
  const requestFingerprint = computeRequestFingerprint({
    readingDueId: due.id,
    readingValue: input.readingValue,
    readingAt: input.readingAt.toISOString(),
    notes: input.notes ?? null,
  });

  const result = await executeIdempotent({
    actorUserId,
    operationKey: RECORD_MOBILE_UTILITY_METER_READING_OPERATION_KEY,
    idempotencyKey,
    requestFingerprint,
    work: async (client) => {
      // -------------------------------------------------------------------
      // LOCK THE FIELD EXECUTION, then re-read canonical state under it.
      // -------------------------------------------------------------------
      const locked = await utilityReadingDueRepository.findByIdForUpdate(
        due.id,
        client,
      );
      if (!locked) {
        throw utilityReadingDueNotFoundError();
      }

      // Executable states are derived from the EXISTING lifecycle, not invented:
      // stored status 'DUE' (surfaced as DUE, or as OVERDUE by the repository's
      // `status='DUE' AND due_at < NOW()` projection). COMPLETED and CANCELLED
      // are terminal and cannot accept a new first field reading.
      //
      // This is also the deterministic conflict for the concurrency loser: the
      // winner has already committed COMPLETED + meter_reading_id, so the loser
      // lands here and rolls back without ever inserting a reading.
      if (!['DUE', 'OVERDUE'].includes(locked.status) || locked.meterReadingId !== null) {
        throw utilityReadingDueTransitionError();
      }

      // -------------------------------------------------------------------
      // CANONICAL READING — same service management uses. Server derives the
      // meter (from the due), the UOM (the meter's own configured unit), the
      // actor (session) and provenance. BE-18B decimal precision, the ACTIVE
      // meter rule, the BE-18D tenant snapshot and the meter+instant duplicate
      // guard are all enforced there, once, for every caller.
      //
      // `source` is MANUAL and `readingType` is ACTUAL: a technician physically
      // reading a meter and entering the value is a human capture of an observed
      // value. ENGINEERING belongs to the BE-10C Asset + Form Instance workflow
      // this route does not touch, IMPORT to bulk loads, SYSTEM to generated
      // values, and ESTIMATED to a value nobody observed. No new enum token is
      // invented and none is accepted from the client.
      // -------------------------------------------------------------------
      const reading = await recordUtilityMeterReading(
        {
          meterId: locked.meterId,
          readingValue: input.readingValue,
          readingAt: input.readingAt,
          recordedByUserId: actorUserId,
          source: MOBILE_FIELD_READING_SOURCE,
          readingType: MOBILE_FIELD_READING_TYPE,
          ...(input.notes === undefined ? {} : { notes: input.notes }),
        },
        actorUserId,
        client,
      );

      // -------------------------------------------------------------------
      // CANONICAL COMPLETION — attaches `meter_reading_id`, transitions the due
      // to COMPLETED and writes `UTILITY_READING_DUE_COMPLETED`, on the same
      // connection. This is the field-execution correlation the reconciliation
      // read depends on, and it is the existing domain semantic, not a new one.
      //
      // It also owns the period check: a `readingAt` outside the due window is
      // rejected with the canonical 400 READING_MISMATCH. That check is left
      // single-sourced here rather than duplicated above; because the whole
      // transaction rolls back, no reading survives a rejected window and the
      // idempotency key stays unpoisoned and retryable.
      // -------------------------------------------------------------------
      await utilityReadingDueService.completeUtilityReadingDue(
        locked.id,
        reading.id,
        actorUserId,
        client,
      );

      return {
        responseStatus: 201,
        responseBody: { reading: toMobileReadingFromPublic(reading) },
      };
    },
  });

  return {
    data: result.responseBody as MobileUtilityMeterReadingResult,
    replayed: result.replayed,
  };
}

/**
 * `recordUtilityMeterReading` returns the canonical public projection (dates
 * already ISO strings); narrow it to the bounded mobile DTO.
 */
function toMobileReadingFromPublic(
  reading: PublicUtilityMeterReading,
): MobileUtilityMeterReading {
  return {
    id: reading.id,
    meterId: reading.meterId,
    uomId: reading.uomId,
    readingValue: reading.readingValue,
    readingAt: reading.readingAt,
    source: reading.source,
    readingType: reading.readingType,
    notes: reading.notes,
    recordedByUserId: reading.recordedByUserId,
    createdAt: reading.createdAt,
  };
}

/**
 * Bounded canonical reading history for the due's meter, newest first.
 *
 * The meter comes from the Reading Due — a field caller can never supply an
 * arbitrary meter id. Sorting (`reading_at DESC, created_at DESC`) and the limit
 * bound are the EXISTING canonical BE-18E repository semantics, reused rather
 * than reimplemented, and no client-side sorting happens anywhere.
 */
export async function listMobileUtilityMeterReadings(
  readingDueId: string,
  actorUserId: string,
  limit?: number,
): Promise<MobileUtilityMeterReading[]> {
  const { due } = await assertUtilityMeterFieldActor(readingDueId, actorUserId);
  const records = await utilityMeterReadingRepository.listByMeter(
    due.meterId,
    limit === undefined ? {} : { limit },
  );
  return records.map(toMobileUtilityMeterReading);
}

/**
 * One canonical reading, under its Reading Due context.
 *
 * The reading must belong to the due's meter. A reading of another meter is
 * reported as 404 rather than 403, following the repository security convention
 * that a context mismatch never confirms the existence of a row the caller has
 * no business knowing about.
 */
export async function getMobileUtilityMeterReading(
  readingDueId: string,
  readingId: string,
  actorUserId: string,
): Promise<MobileUtilityMeterReading> {
  const { due } = await assertUtilityMeterFieldActor(readingDueId, actorUserId);
  const record = await utilityMeterReadingRepository.findById(readingId);
  if (!record || record.meterId !== due.meterId) {
    throw utilityMeterReadingNotFoundError();
  }
  return toMobileUtilityMeterReading(record);
}

/**
 * The reading a Reading Due is definitively linked to, or null.
 *
 * This is the RECONCILIATION read for an ambiguous submit outcome. It is derived
 * from the due's canonical `meter_reading_id`, never from "the latest reading":
 * another legitimate actor or an engineering round may post a later reading on
 * the same meter, which would change `latestReading` while leaving this exact.
 * A client therefore never has to infer success from a matching value or a
 * nearby timestamp.
 */
export async function findSubmittedReadingForDue(
  readingDueId: string,
): Promise<MobileUtilityMeterReading | null> {
  const due = await utilityReadingDueRepository.findById(readingDueId);
  if (!due || due.meterReadingId === null) {
    return null;
  }
  const record = await utilityMeterReadingRepository.findById(due.meterReadingId);
  return record ? toMobileUtilityMeterReading(record) : null;
}

export const mobileUtilityMeterReadingService = {
  recordMobileUtilityMeterReading,
  listMobileUtilityMeterReadings,
  getMobileUtilityMeterReading,
  findSubmittedReadingForDue,
};
