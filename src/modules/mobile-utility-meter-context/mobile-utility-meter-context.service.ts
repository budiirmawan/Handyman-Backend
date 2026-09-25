import { getPool } from '../../database';
import {
  assertUtilityMeterFieldActor,
  type UtilityReadingDueRecord,
} from '../utility-reading-dues';
import {
  utilityMeterUomNotFoundError,
  type UtilityMeterRecord,
} from '../utility-meters';
import {
  utilityMeterReadingRepository,
  type ReadingUomSummary,
  type UtilityMeterReadingRecord,
} from '../utility-meter-readings';
import { utilityTypeConfigurationRepository } from '../utility-type-configurations';
import { toMobileUtilityMeterReading } from '../mobile-utility-meter-reading';
import type { MobileUtilityMeterReading } from '../mobile-utility-meter-reading';
import type {
  MobileMeterContextLatestReading,
  MobileMeterContextReadingDue,
  MobileUtilityMeterContext,
} from './mobile-utility-meter-context.types';

/**
 * CR-BE-RN12-METER-FIELD-01 PART 00 — mobile field meter-context service.
 *
 * Assembles the canonical BE-18 facts a field actor needs to identify the
 * meter they have been issued a Reading Due for. It WRITES NOTHING and
 * authorizes NO command.
 *
 * Authorities reused, never re-derived
 * ------------------------------------
 *   - field-actor authorization  → `assertUtilityMeterFieldActor` (PART 00 seam,
 *                                  itself composing the existing generated-task /
 *                                  task-assignment authority + BE-02G Building
 *                                  access)
 *   - meter identity             → BE-18A `utility_meters`
 *   - reading decimal precision  → BE-18B `utility_type_configurations`
 *   - unit of measure            → BE-07 `units_of_measure`
 *   - latest reading chronology  → BE-18E `utilityMeterReadingRepository
 *                                  .findLatestByMeter` — the SAME canonical query
 *                                  `GET /utility/meters/:id/readings/latest` uses
 *   - due status (incl. OVERDUE) → the existing reading-due repository projection
 *
 * Nothing here sorts readings, computes a delta, classifies an abnormality, or
 * infers an action. Those are BE-18G / BE-18J / later PARTs.
 */

/**
 * BE-18B precision, resolved server-side for the meter's (client, utilityType).
 *
 * Mirrors `assertConfiguredPrecision` in BE-18E exactly: when the Client has no
 * configuration for the utility type, or the configuration leaves
 * `decimal_precision` null, there is NO precision constraint — so this returns
 * null. No default is invented here; a fabricated `0` or `2` would silently
 * reject readings the authoritative BE-18E path accepts.
 */
async function resolveDecimalPrecision(
  meter: UtilityMeterRecord,
): Promise<number | null> {
  const configuration =
    await utilityTypeConfigurationRepository.findByClientAndType(
      meter.clientId,
      meter.utilityType,
    );
  if (!configuration || configuration.decimalPrecision === null) {
    return null;
  }
  return configuration.decimalPrecision;
}

async function resolveUom(uomId: string): Promise<ReadingUomSummary> {
  const result = await getPool().query<ReadingUomSummary>(
    'SELECT id, code, name, symbol FROM units_of_measure WHERE id = $1',
    [uomId],
  );
  const uom = result.rows[0];
  // `utility_meters.uom_id` is NOT NULL with a FK to BE-07, so this is
  // defensive only — but a missing unit must surface as the canonical BE-18A
  // error rather than as a null inside an otherwise complete context.
  if (!uom) {
    throw utilityMeterUomNotFoundError();
  }
  return uom;
}

function toContextReadingDue(
  due: UtilityReadingDueRecord,
): MobileMeterContextReadingDue {
  return {
    id: due.id,
    status: due.status,
    dueAt: due.dueAt.toISOString(),
    periodStart: due.periodStart.toISOString(),
    periodEnd: due.periodEnd.toISOString(),
    // Non-null: `assertUtilityMeterFieldActor` rejects a due with no generated
    // task before this point, because there would be no field authority to prove.
    generatedTaskId: due.generatedTaskId as string,
  };
}

/**
 * The reading this due is linked to, from its canonical `meter_reading_id`.
 *
 * `null` is the normal pre-submission state. A non-null id whose row cannot be
 * found would violate the FK, so it degrades to `null` rather than throwing —
 * the context read must stay available even if a downstream row is missing.
 */
async function resolveSubmittedReading(
  due: UtilityReadingDueRecord,
): Promise<MobileUtilityMeterReading | null> {
  if (due.meterReadingId === null) {
    return null;
  }
  const record = await utilityMeterReadingRepository.findById(due.meterReadingId);
  return record ? toMobileUtilityMeterReading(record) : null;
}

function toContextLatestReading(
  reading: UtilityMeterReadingRecord,
): MobileMeterContextLatestReading {
  return {
    id: reading.id,
    // NUMERIC arrives as a string from PostgreSQL; the public shape is a number,
    // exactly as BE-18E's `toPublicUtilityMeterReading` already does.
    readingValue: Number(reading.readingValue),
    readingAt: reading.readingAt.toISOString(),
    readingType: reading.readingType,
    source: reading.source,
  };
}

/**
 * Resolves the mobile field meter context for one Reading Due.
 *
 * Authorization is entirely server-derived from the authenticated session plus
 * the due's own generated-task assignment chain. The caller supplies only the
 * due id — never a clientId, buildingId, meterId, or taskId, and never a
 * permission or role assertion.
 *
 * Denials, in order (all from `assertUtilityMeterFieldActor`):
 *   404 UTILITY_READING_DUE_NOT_FOUND
 *   403 UTILITY_READING_DUE_NO_FIELD_TASK
 *   403 UTILITY_READING_DUE_FIELD_UNAUTHORIZED
 *   403 UTILITY_READING_DUE_FIELD_TASK_MISMATCH
 *   403 BUILDING_ACCESS_DENIED
 *   404 UTILITY_METER_NOT_FOUND
 *   404 UTILITY_METER_UOM_NOT_FOUND
 *
 * Terminal dues are NOT excluded. A COMPLETED or CANCELLED due remains readable
 * here because the existing BE-18 read semantics already expose completed and
 * cancelled dues (`GET /utility/reading-dues/:id` filters nothing on status),
 * and a technician reviewing what was captured needs the same context. PART 00
 * derives NO command eligibility from due status — that belongs to PART 01.
 */
export async function getMobileUtilityMeterContext(
  readingDueId: string,
  actorUserId: string,
): Promise<MobileUtilityMeterContext> {
  const { due, meter } = await assertUtilityMeterFieldActor(
    readingDueId,
    actorUserId,
  );

  const [uom, decimalPrecision, latest, submitted] = await Promise.all([
    resolveUom(meter.uomId),
    resolveDecimalPrecision(meter),
    utilityMeterReadingRepository.findLatestByMeter(meter.id),
    resolveSubmittedReading(due),
  ]);

  return {
    readingDue: toContextReadingDue(due),
    meter: {
      id: meter.id,
      code: meter.code,
      name: meter.name,
      serialNumber: meter.serialNumber,
      utilityType: meter.utilityType,
      purpose: meter.purpose,
      status: meter.status,
      buildingId: meter.buildingId,
      spaceId: meter.spaceId,
      functionalLocationId: meter.functionalLocationId,
      uom,
      decimalPrecision,
    },
    // null means "never read" — a valid BE-18E state, not an error.
    latestReading: latest ? toContextLatestReading(latest) : null,
    // PART 01 — canonical correlation, independent of `latestReading`.
    submittedReading: submitted,
  };
}

export const mobileUtilityMeterContextService = {
  getMobileUtilityMeterContext,
};
