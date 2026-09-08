import { getPool } from '../../database';
import { contextAccessService } from '../context-access';
import { buildingAccessDeniedError } from '../context-access/context-access.errors';
import { recordOperationalEvent } from '../operational-events';
import {
  tenantCompanyNotFoundError,
  tenantCompanyRepository,
} from '../tenant-companies';
import { utilityMeterReadingRepository } from '../utility-meter-readings/utility-meter-reading.repository';
import type { UtilityMeterReadingRecord } from '../utility-meter-readings/utility-meter-reading.types';
import { utilityMeterNotFoundError } from '../utility-meters/utility-meter.errors';
import { utilityMeterRepository } from '../utility-meters/utility-meter.repository';
import type { UtilityMeterRecord } from '../utility-meters/utility-meter.types';
import {
  utilityMeterConsumptionAlreadyExistsError,
  utilityMeterConsumptionNegativeError,
  utilityMeterConsumptionNotFoundError,
  utilityMeterConsumptionPeriodInvalidError,
  utilityMeterConsumptionReadingInvalidError,
  utilityMeterConsumptionTenantMismatchError,
  utilityMeterConsumptionUomMismatchError,
} from './utility-meter-consumption.errors';
import { utilityMeterConsumptionRepository } from './utility-meter-consumption.repository';
import type {
  CalculateUtilityMeterConsumptionInput,
  ConsumptionMeterSummary,
  ConsumptionReadingSummary,
  ConsumptionUomSummary,
  NewUtilityMeterConsumption,
  PublicUtilityMeterConsumption,
  UtilityMeterConsumptionFilters,
  UtilityMeterConsumptionRecord,
} from './utility-meter-consumption.types';

/**
 * BE-18G — Consumption service.
 *
 * Consumption is *derived*, never entered:
 *
 *   consumption = current reading value - previous reading value
 *
 * Both operands come from authoritative BE-18E readings. The caller supplies
 * reading references, never values — there is deliberately no way to post a
 * consumption figure directly, because a hand-entered delta would be a second
 * source of truth that could silently contradict the readings behind it.
 *
 * Authorities reused, never re-derived:
 *   - reading values, instants, chronology → BE-18E `utility_meter_readings`
 *   - Meter identity, Client / Building, configured UOM → BE-18A
 *   - unit master                                       → BE-07
 *   - tenant context at the time of the period          → BE-18D snapshot
 *   - Building access                                   → BE-02G
 *
 * BE-18C Main/Sub hierarchy is untouched: a sub meter's consumption is simply
 * its own delta. No netting, aggregation, or allocation happens here.
 *
 * Out of scope, deliberately: tariffs, rates, cost, invoicing, and any
 * Utility Calculation. Billing never lives in BE-18.
 */

function meterSummary(record: UtilityMeterRecord): ConsumptionMeterSummary {
  return {
    id: record.id,
    code: record.code,
    name: record.name,
    utilityType: record.utilityType,
    uomId: record.uomId,
    buildingId: record.buildingId,
    status: record.status,
  };
}

function readingSummary(
  record: UtilityMeterReadingRecord,
): ConsumptionReadingSummary {
  return {
    id: record.id,
    readingValue: Number(record.readingValue),
    readingAt: record.readingAt.toISOString(),
    source: record.source,
    readingType: record.readingType,
  };
}

export function toPublicUtilityMeterConsumption(
  record: UtilityMeterConsumptionRecord,
  context: {
    meter?: UtilityMeterRecord | null;
    uom?: ConsumptionUomSummary | null;
    previousReading?: UtilityMeterReadingRecord | null;
    currentReading?: UtilityMeterReadingRecord | null;
  } = {},
): PublicUtilityMeterConsumption {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    meterId: record.meterId,
    previousReadingId: record.previousReadingId,
    currentReadingId: record.currentReadingId,
    uomId: record.uomId,
    consumptionValue: Number(record.consumptionValue),
    periodStart: record.periodStart.toISOString(),
    periodEnd: record.periodEnd.toISOString(),
    calculatedAt: record.calculatedAt.toISOString(),
    calculatedByUserId: record.calculatedByUserId,
    tenantAssignmentId: record.tenantAssignmentId,
    tenantCompanyId: record.tenantCompanyId,
    notes: record.notes,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    ...(context.meter === undefined
      ? {}
      : { meter: context.meter ? meterSummary(context.meter) : null }),
    ...(context.uom === undefined ? {} : { uom: context.uom }),
    ...(context.previousReading === undefined
      ? {}
      : {
          previousReading: context.previousReading
            ? readingSummary(context.previousReading)
            : null,
        }),
    ...(context.currentReading === undefined
      ? {}
      : {
          currentReading: context.currentReading
            ? readingSummary(context.currentReading)
            : null,
        }),
  };
}

/** BE-02G — an actor may only operate inside an explicitly assigned Building. */
async function assertBuildingAccess(
  actorUserId: string | undefined,
  buildingId: string,
): Promise<void> {
  if (!actorUserId) {
    return;
  }
  if (!(await contextAccessService.canAccessBuilding(actorUserId, buildingId))) {
    throw buildingAccessDeniedError();
  }
}

async function loadMeter(id: string): Promise<UtilityMeterRecord> {
  const meter = await utilityMeterRepository.findById(id);
  if (!meter) {
    throw utilityMeterNotFoundError();
  }
  return meter;
}

async function loadUom(uomId: string): Promise<ConsumptionUomSummary | null> {
  const result = await getPool().query<ConsumptionUomSummary>(
    'SELECT id, code, name, symbol FROM units_of_measure WHERE id = $1',
    [uomId],
  );
  return result.rows[0] ?? null;
}

/**
 * Loads a reading and asserts it belongs to the given Meter. A reading from
 * another meter is not a usable endpoint: subtracting across meters would
 * produce a number with no physical meaning.
 */
async function loadReadingForMeter(
  readingId: string,
  meterId: string,
  label: 'previous' | 'current',
): Promise<UtilityMeterReadingRecord> {
  const reading = await utilityMeterReadingRepository.findById(readingId);
  if (!reading) {
    throw utilityMeterConsumptionReadingInvalidError(
      `The ${label} reading does not exist.`,
    );
  }
  if (reading.meterId !== meterId) {
    throw utilityMeterConsumptionReadingInvalidError(
      `The ${label} reading belongs to a different meter.`,
    );
  }
  return reading;
}

/**
 * Calculates and persists the consumption between two readings.
 *
 * Validation order:
 *   1. unknown Meter                      → 404 UTILITY_METER_NOT_FOUND
 *   2. no Building access                 → 403 BUILDING_ACCESS_DENIED
 *   3. unknown / foreign current reading  → 400 ..._READING_INVALID
 *   4. no preceding reading available     → 400 ..._READING_INVALID
 *   5. same reading as both endpoints     → 400 ..._READING_INVALID
 *   6. reversed / zero-length period      → 400 ..._PERIOD_INVALID
 *   7. readings disagree on unit          → 400 ..._UOM_MISMATCH
 *   8. tenant assignment changed mid-period → 400 ..._TENANT_MISMATCH
 *   9. negative delta                     → 400 ..._NEGATIVE
 *  10. already calculated                 → 409 ..._ALREADY_EXISTS
 */
export async function calculateUtilityMeterConsumption(
  input: CalculateUtilityMeterConsumptionInput,
  actorUserId?: string,
): Promise<PublicUtilityMeterConsumption> {
  const meter = await loadMeter(input.meterId);
  await assertBuildingAccess(actorUserId, meter.buildingId);

  const currentReading = await loadReadingForMeter(
    input.currentReadingId,
    meter.id,
    'current',
  );

  // The opening reading defaults to whatever BE-18E says came immediately
  // before — chronology is resolved by the reading module, not re-derived.
  const previousReading = input.previousReadingId
    ? await loadReadingForMeter(input.previousReadingId, meter.id, 'previous')
    : await utilityMeterReadingRepository.findPreviousByMeter(
        meter.id,
        currentReading.readingAt,
      );

  if (!previousReading) {
    throw utilityMeterConsumptionReadingInvalidError(
      'No earlier reading exists for this meter, so consumption cannot be derived.',
    );
  }

  if (previousReading.id === currentReading.id) {
    throw utilityMeterConsumptionReadingInvalidError(
      'The previous and current readings must be different readings.',
    );
  }

  // Reversed or zero-length periods are rejected outright: a period that does
  // not move forward in time cannot describe consumption.
  if (previousReading.readingAt.getTime() >= currentReading.readingAt.getTime()) {
    throw utilityMeterConsumptionPeriodInvalidError();
  }

  // Both endpoints must share a unit, and it must be the meter's configured
  // one — otherwise the subtraction silently mixes scales.
  if (previousReading.uomId !== currentReading.uomId) {
    throw utilityMeterConsumptionUomMismatchError(
      'The previous and current readings use different units of measure.',
    );
  }
  if (currentReading.uomId !== meter.uomId) {
    throw utilityMeterConsumptionUomMismatchError(
      'The readings do not use the unit configured on the meter.',
    );
  }

  // A period that spans a change of tenant cannot be attributed to either
  // one, so it is refused rather than mis-assigned.
  if (previousReading.tenantCompanyId !== currentReading.tenantCompanyId) {
    throw utilityMeterConsumptionTenantMismatchError();
  }

  const previousValue = Number(previousReading.readingValue);
  const currentValue = Number(currentReading.readingValue);
  const consumptionValue = currentValue - previousValue;

  // Never silently accepted: a backwards meter needs an explicit decision.
  if (consumptionValue < 0) {
    throw utilityMeterConsumptionNegativeError();
  }

  const existing =
    await utilityMeterConsumptionRepository.findByCurrentReading(
      meter.id,
      currentReading.id,
    );
  if (existing) {
    throw utilityMeterConsumptionAlreadyExistsError();
  }

  const newConsumption: NewUtilityMeterConsumption = {
    clientId: meter.clientId,
    buildingId: meter.buildingId,
    meterId: meter.id,
    previousReadingId: previousReading.id,
    currentReadingId: currentReading.id,
    uomId: currentReading.uomId,
    consumptionValue,
    periodStart: previousReading.readingAt,
    periodEnd: currentReading.readingAt,
    calculatedByUserId: input.calculatedByUserId ?? null,
    // Tenant context is taken from the readings themselves (BE-18D snapshot),
    // so it reflects who the meter served across the period, not who it
    // serves now.
    tenantAssignmentId: currentReading.tenantAssignmentId,
    tenantCompanyId: currentReading.tenantCompanyId,
    notes: input.notes ?? null,
  };

  let record: UtilityMeterConsumptionRecord;
  try {
    record = await utilityMeterConsumptionRepository.create(newConsumption);
  } catch (error) {
    if (
      isUniqueViolation(
        error,
        'utility_meter_consumptions_current_reading_unique',
      )
    ) {
      throw utilityMeterConsumptionAlreadyExistsError();
    }
    throw error;
  }

  await recordOperationalEvent({
    clientId: meter.clientId,
    eventType: 'UTILITY_METER_CONSUMPTION_CALCULATED',
    entityType: 'UTILITY_METER_CONSUMPTION',
    entityId: record.id,
    ...(input.calculatedByUserId
      ? { actorUserId: input.calculatedByUserId }
      : {}),
    buildingId: meter.buildingId,
    summary: `Consumption calculated for meter ${meter.code}`,
    metadata: {
      meterId: meter.id,
      utilityType: meter.utilityType,
      uomId: record.uomId,
      consumptionValue: Number(record.consumptionValue),
      previousReadingId: record.previousReadingId,
      currentReadingId: record.currentReadingId,
      periodStart: record.periodStart.toISOString(),
      periodEnd: record.periodEnd.toISOString(),
      tenantCompanyId: record.tenantCompanyId,
    },
  });

  const uom = await loadUom(record.uomId);
  return toPublicUtilityMeterConsumption(record, {
    meter,
    uom,
    previousReading,
    currentReading,
  });
}

export async function getUtilityMeterConsumptionById(
  id: string,
  actorUserId?: string,
): Promise<PublicUtilityMeterConsumption> {
  const record = await utilityMeterConsumptionRepository.findById(id);
  if (!record) {
    throw utilityMeterConsumptionNotFoundError();
  }
  await assertBuildingAccess(actorUserId, record.buildingId);
  return enrichOne(record);
}

/** Consumption history of a Meter, newest period first. */
export async function listConsumptionsByMeter(
  meterId: string,
  filters: UtilityMeterConsumptionFilters,
  actorUserId?: string,
): Promise<PublicUtilityMeterConsumption[]> {
  const meter = await loadMeter(meterId);
  await assertBuildingAccess(actorUserId, meter.buildingId);

  const records = await utilityMeterConsumptionRepository.listByMeter(
    meterId,
    filters,
  );
  return enrich(records, meter);
}

export async function listConsumptionsByBuilding(
  buildingId: string,
  filters: UtilityMeterConsumptionFilters,
  actorUserId?: string,
): Promise<PublicUtilityMeterConsumption[]> {
  await assertBuildingAccess(actorUserId, buildingId);

  const records = await utilityMeterConsumptionRepository.listByBuilding(
    buildingId,
    filters,
  );
  return enrich(records);
}

/**
 * Tenant-scoped consumptions, restricted at the database level to the
 * Buildings the actor can access.
 */
export async function listConsumptionsByTenantCompany(
  tenantCompanyId: string,
  filters: UtilityMeterConsumptionFilters,
  actorUserId?: string,
): Promise<PublicUtilityMeterConsumption[]> {
  const tenantCompany = await tenantCompanyRepository.findById(tenantCompanyId);
  if (!tenantCompany) {
    throw tenantCompanyNotFoundError();
  }
  if (
    actorUserId &&
    !(await contextAccessService.canAccessClient(
      actorUserId,
      tenantCompany.clientId,
    ))
  ) {
    throw buildingAccessDeniedError();
  }

  const buildingIds = actorUserId
    ? await contextAccessService.getAccessibleBuildingIds(actorUserId)
    : null;

  const records = await utilityMeterConsumptionRepository.listByTenantCompany(
    tenantCompanyId,
    buildingIds,
    filters,
  );
  return enrich(records);
}

/**
 * The latest consumption of a Meter. `null` means nothing has been calculated
 * yet — a valid state, not an error.
 */
export async function getLatestConsumptionForMeter(
  meterId: string,
  actorUserId?: string,
): Promise<PublicUtilityMeterConsumption | null> {
  const meter = await loadMeter(meterId);
  await assertBuildingAccess(actorUserId, meter.buildingId);

  const record =
    await utilityMeterConsumptionRepository.findLatestByMeter(meterId);
  if (!record) {
    return null;
  }
  return enrichOne(record, meter);
}

async function enrichOne(
  record: UtilityMeterConsumptionRecord,
  knownMeter?: UtilityMeterRecord,
): Promise<PublicUtilityMeterConsumption> {
  const [meter, uom, previousReading, currentReading] = await Promise.all([
    knownMeter
      ? Promise.resolve(knownMeter)
      : utilityMeterRepository.findById(record.meterId),
    loadUom(record.uomId),
    utilityMeterReadingRepository.findById(record.previousReadingId),
    utilityMeterReadingRepository.findById(record.currentReadingId),
  ]);
  return toPublicUtilityMeterConsumption(record, {
    meter,
    uom,
    previousReading,
    currentReading,
  });
}

/**
 * Batch-loads meter, UOM and endpoint-reading context for a list of
 * consumptions. Reading values are read through from BE-18E rather than
 * stored on the consumption row.
 */
async function enrich(
  records: readonly UtilityMeterConsumptionRecord[],
  knownMeter?: UtilityMeterRecord,
): Promise<PublicUtilityMeterConsumption[]> {
  if (records.length === 0) {
    return [];
  }

  const meters = new Map<string, UtilityMeterRecord>();
  if (knownMeter) {
    meters.set(knownMeter.id, knownMeter);
  }
  for (const id of new Set(records.map((record) => record.meterId))) {
    if (!meters.has(id)) {
      const meter = await utilityMeterRepository.findById(id);
      if (meter) {
        meters.set(id, meter);
      }
    }
  }

  const uoms = new Map<string, ConsumptionUomSummary>();
  for (const id of new Set(records.map((record) => record.uomId))) {
    const uom = await loadUom(id);
    if (uom) {
      uoms.set(id, uom);
    }
  }

  const readings = new Map<string, UtilityMeterReadingRecord>();
  const readingIds = new Set<string>();
  for (const record of records) {
    readingIds.add(record.previousReadingId);
    readingIds.add(record.currentReadingId);
  }
  for (const id of readingIds) {
    const reading = await utilityMeterReadingRepository.findById(id);
    if (reading) {
      readings.set(id, reading);
    }
  }

  return records.map((record) =>
    toPublicUtilityMeterConsumption(record, {
      meter: meters.get(record.meterId) ?? null,
      uom: uoms.get(record.uomId) ?? null,
      previousReading: readings.get(record.previousReadingId) ?? null,
      currentReading: readings.get(record.currentReadingId) ?? null,
    }),
  );
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === '23505' && candidate.constraint === constraint;
}

export const utilityMeterConsumptionService = {
  calculateUtilityMeterConsumption,
  getLatestConsumptionForMeter,
  getUtilityMeterConsumptionById,
  listConsumptionsByBuilding,
  listConsumptionsByMeter,
  listConsumptionsByTenantCompany,
  toPublicUtilityMeterConsumption,
};
