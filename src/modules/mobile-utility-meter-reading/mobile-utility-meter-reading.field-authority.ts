import type { UtilityMeterRecord } from '../utility-meters';
import {
  utilityMeterReadingNotFoundError,
  utilityMeterReadingRepository,
  type UtilityMeterReadingRecord,
} from '../utility-meter-readings';
import { assertUtilityMeterFieldActor } from '../utility-reading-dues/utility-reading-due.field-authority';
import { utilityReadingDueRepository } from '../utility-reading-dues/utility-reading-due.repository';
import type { UtilityReadingDueRecord } from '../utility-reading-dues';

/**
 * CR-BE-RN12-METER-FIELD-01 PART 02 — READING-keyed field-actor authority seam.
 *
 * "Is this authenticated actor the field executor of the Reading Due that
 * produced THIS Meter Reading?"
 *
 * WHY A SECOND SEAM (AND WHY IT IS NOT A SECOND AUTHORITY)
 * -------------------------------------------------------
 * PART 00's `assertUtilityMeterFieldActor(readingDueId, actorUserId)` answers
 * the question for a FIELD EXECUTION, addressed by the Reading Due. PART 01
 * could use it directly: every one of its routes is addressed by
 * `:readingDueId`, which the client already holds.
 *
 * PART 02 cannot. Everything it governs hangs off the READING, not the due:
 *
 *   - BE-18F reading evidence      `evidence_submissions.execution_id` = reading id
 *   - OCR candidates               `utility_meter_ocr_candidates.accepted_reading_id`
 *                                  (and `evidence_id` → a reading's PHOTO)
 *   - BE-18G consumption           `utility_meter_consumptions.current_reading_id`
 *   - BE-18J abnormal consumption  `utility_abnormal_consumptions.consumption_id` →
 *                                  that consumption
 *
 * So this seam answers the same question addressed from the reading side. It
 * invents NO rule of its own: it resolves the reading's field execution and
 * then delegates verbatim to the PART 00 seam, which in turn delegates actor
 * executability to `isBoundTaskExecutableByUser` and Building isolation to
 * BE-02G. There is exactly one field authority in this repository; this is a
 * second ADDRESS for it, not a second authority.
 *
 * THE CARDINALITY THAT MAKES THE ADDRESS CANONICAL
 * ------------------------------------------------
 * `utility_reading_dues.meter_reading_id` is `UNIQUE`, and
 * `utility_reading_due_state_check` (0281) permits it to be non-null ONLY on a
 * `COMPLETED` due. Therefore:
 *
 *   - a reading resolves to AT MOST ONE due, and
 *   - that due is necessarily the one the reading completed.
 *
 * No tie-break, no "latest due", no ordering heuristic is needed or allowed.
 * This is the same invariant PART 01 relied on in the other direction (one due
 * ⇒ at most one field reading), and it is why a reading id is an unambiguous
 * field-execution address while a bare METER id never is.
 *
 * MANAGEMENT-ONLY READINGS STAY MANAGEMENT-ONLY
 * --------------------------------------------
 * A reading with no due behind it was posted by a management route
 * (`POST /utility/meters/:id/readings`), by the BE-10C engineering workflow, by
 * an import, or by an OCR acceptance that supplied `readingAt`. Such a reading
 * has no generated task, hence no assignment, hence nothing a field actor could
 * be authorized against. It is reported as 404 `UTILITY_METER_READING_NOT_FOUND`
 * — the reading is not reachable FROM THE FIELD — and never as a fall-back to
 * `utility_meter.manage`, `utility_meter.read`, a role name, or Building access
 * alone. Those are exactly the substitutes PART 00 rejected, and rejecting them
 * again here is what keeps the field surface from silently becoming a
 * building-wide reading surface.
 *
 * 404 rather than 403 follows the convention PART 01 pinned: a context that
 * does not resolve never confirms that a row exists which the caller has no
 * business knowing about.
 *
 * METER / BUILDING IDENTITY IS RE-ASSERTED, NEVER TRUSTED
 * ------------------------------------------------------
 * Step 4 re-checks that the due the PART 00 seam authorized is a due for the
 * SAME meter and the SAME Building as the reading being acted on. Both are
 * written together by BE-18E and by `completeUtilityReadingDue`, so a
 * divergence means the data no longer holds the invariant the field contract
 * depends on; it is refused rather than quietly trusted. This mirrors step 4 of
 * the PART 00 seam, which re-asserts on read what `createUtilityReadingDue`
 * asserted on write.
 */

/** What a field caller is authorized to act on, and through which execution. */
export type MobileUtilityMeterReadingFieldContext = {
  /** The authoritative BE-18E reading the caller addressed. */
  reading: UtilityMeterReadingRecord;
  /** The field execution that produced it (COMPLETED, uniquely linked). */
  due: UtilityReadingDueRecord;
  /** The authoritative BE-18A meter — the same meter the due was issued for. */
  meter: UtilityMeterRecord;
  /** The generated task the actor's assignment authority was proven against. */
  generatedTaskId: string;
};

/**
 * Proves the actor is the field executor of the Reading Due behind a reading.
 *
 * Validation order (pinned by tests):
 *   1. unknown reading                          → 404 UTILITY_METER_READING_NOT_FOUND
 *   2. reading has no field due (management /   → 404 UTILITY_METER_READING_NOT_FOUND
 *      engineering / import / OCR-`readingAt`)
 *   3. PART 00 authority over that due, in its  → the PART 00 error set, unchanged
 *      own pinned order (no field task, not the
 *      assignee, task re-pointed, no Building
 *      access, meter row missing)
 *   4. due and reading disagree on meter or     → 404 UTILITY_METER_READING_NOT_FOUND
 *      Building
 *
 * Step 3 is delegated, not restated: whatever PART 00 decides, this seam
 * decides the same, and a future change to the field authority has exactly one
 * place to change.
 */
export async function assertUtilityMeterReadingFieldActor(
  readingId: string,
  actorUserId: string,
): Promise<MobileUtilityMeterReadingFieldContext> {
  const reading = await utilityMeterReadingRepository.findById(readingId);
  if (!reading) {
    throw utilityMeterReadingNotFoundError();
  }

  // A reading that is not some due's `meter_reading_id` was never a field
  // execution. There is no assignment to check and no weaker gate is
  // substituted, so it is simply not field-accessible.
  const due =
    await utilityReadingDueRepository.findByMeterReadingId(readingId);
  if (!due) {
    throw utilityMeterReadingNotFoundError();
  }

  // THE authority. Assignment first, Building second, exactly as PART 00 pinned
  // it — including its own 404/403 distinctions and its refusal of a due with
  // no generated task.
  const fieldContext = await assertUtilityMeterFieldActor(due.id, actorUserId);

  // Identity re-assertion: the authorized execution must be an execution FOR
  // THIS reading's meter and Building.
  if (
    fieldContext.due.meterId !== reading.meterId ||
    fieldContext.due.buildingId !== reading.buildingId ||
    fieldContext.due.clientId !== reading.clientId
  ) {
    throw utilityMeterReadingNotFoundError();
  }

  return {
    reading,
    due: fieldContext.due,
    meter: fieldContext.meter,
    generatedTaskId: fieldContext.generatedTaskId,
  };
}

export const mobileUtilityMeterReadingFieldAuthority = {
  assertUtilityMeterReadingFieldActor,
};
