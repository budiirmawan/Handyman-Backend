import { getPool } from '../../database';
import { AppError } from '../../shared/errors';
import { contextAccessService } from '../context-access';
import { buildingAccessDeniedError } from '../context-access/context-access.errors';
import { recordOperationalEvent } from '../operational-events';
import {
  tenantCompanyNotFoundError,
  tenantCompanyRepository,
} from '../tenant-companies';
import { utilityMeterTenantRepository } from '../utility-meter-tenants/utility-meter-tenant.repository';
import {
  utilityMeterInactiveError,
  utilityMeterNotFoundError,
  utilityMeterUomClientMismatchError,
  utilityMeterUomInactiveError,
  utilityMeterUomNotFoundError,
} from '../utility-meters/utility-meter.errors';
import { utilityMeterRepository } from '../utility-meters/utility-meter.repository';
import type { UtilityMeterRecord } from '../utility-meters/utility-meter.types';
import { utilityTypeConfigurationRepository } from '../utility-type-configurations/utility-type-configuration.repository';
import {
  utilityMeterReadingAlreadyExistsError,
  utilityMeterReadingNotFoundError,
  utilityMeterReadingTenantMismatchError,
  utilityMeterReadingUomMismatchError,
  utilityMeterReadingValueInvalidError,
} from './utility-meter-reading.errors';
import {
  utilityMeterReadingRepository,
  type UtilityMeterReadingExecutor,
} from './utility-meter-reading.repository';
import type {
  NewUtilityMeterReading,
  PublicUtilityMeterReading,
  ReadingMeterSummary,
  ReadingUomSummary,
  RecordUtilityMeterReadingInput,
  UtilityMeterReadingFilters,
  UtilityMeterReadingRecord,
} from './utility-meter-reading.types';

/**
 * BE-18E — Meter Reading service. BE-18 is authoritative for reading data.
 *
 * Reuse, never duplicate:
 *   - Meter identity, Building / Client, and its configured unit → BE-18A
 *   - Allowed units per utility type (opt-in)                    → BE-18B
 *   - Main/Sub hierarchy                                          → BE-18C
 *     (untouched here — a sub meter's reading is just its own reading)
 *   - Tenant context at the time of reading                       → BE-18D
 *   - Unit of measure master                                      → BE-07
 *
 * BE-10C integration — one source of truth
 * ----------------------------------------
 * BE-10C owns the *engineering* meter-reading workflow: a BE-05 Asset plus a
 * BE-07 numeric form field, executed as a BE-07 Form Instance whose value is
 * stored in BE-07 `form_responses`. BE-18E does not re-implement, mirror, or
 * migrate that workflow, and it never writes to `form_responses`.
 *
 * Instead, a utility reading that originated from an engineering round LINKS
 * back to it (`meterReadingBindingId` / `formInstanceId`), which is validated
 * here against the real BE-10C rows. A database-level partial unique index
 * allows at most one utility reading per engineering execution, so the two
 * stores can never disagree about how many readings an execution produced.
 *
 * Append-only: no update or delete path exists, so a posted reading can never
 * be silently overwritten or removed. Corrections are new readings.
 *
 * Consumption (BE-18G) and Reading Evidence (BE-18F) are out of scope — this
 * service records measurements and calculates nothing.
 */

function meterSummary(record: UtilityMeterRecord): ReadingMeterSummary {
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

export function toPublicUtilityMeterReading(
  record: UtilityMeterReadingRecord,
  context: {
    meter?: UtilityMeterRecord | null;
    uom?: ReadingUomSummary | null;
  } = {},
): PublicUtilityMeterReading {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    meterId: record.meterId,
    uomId: record.uomId,
    readingValue: Number(record.readingValue),
    readingAt: record.readingAt.toISOString(),
    source: record.source,
    readingType: record.readingType,
    notes: record.notes,
    recordedByUserId: record.recordedByUserId,
    tenantAssignmentId: record.tenantAssignmentId,
    tenantCompanyId: record.tenantCompanyId,
    meterReadingBindingId: record.meterReadingBindingId,
    formInstanceId: record.formInstanceId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    ...(context.meter === undefined
      ? {}
      : { meter: context.meter ? meterSummary(context.meter) : null }),
    ...(context.uom === undefined ? {} : { uom: context.uom }),
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

async function loadUom(uomId: string): Promise<ReadingUomSummary | null> {
  const result = await getPool().query<ReadingUomSummary>(
    'SELECT id, code, name, symbol FROM units_of_measure WHERE id = $1',
    [uomId],
  );
  return result.rows[0] ?? null;
}

/**
 * Resolves the unit the reading is recorded in.
 *
 * The Meter's configured UOM is the default and the reference. A caller may
 * restate it explicitly, but may not substitute a different unit: a value in
 * an unexpected unit is indistinguishable from a wrong value once stored.
 */
async function resolveReadingUom(
  meter: UtilityMeterRecord,
  requestedUomId: string | undefined,
): Promise<ReadingUomSummary> {
  if (requestedUomId && requestedUomId !== meter.uomId) {
    // Report a genuinely unknown unit as 404 before the mismatch, so the
    // caller can tell a typo from a policy rejection.
    const candidate = await getPool().query<{ id: string; client_id: string; status: string }>(
      'SELECT id, client_id, status FROM units_of_measure WHERE id = $1',
      [requestedUomId],
    );
    const row = candidate.rows[0];
    if (!row) {
      throw utilityMeterUomNotFoundError();
    }
    if (row.client_id !== meter.clientId) {
      throw utilityMeterUomClientMismatchError();
    }
    if (row.status !== 'ACTIVE') {
      throw utilityMeterUomInactiveError();
    }
    throw utilityMeterReadingUomMismatchError();
  }

  const uom = await loadUom(meter.uomId);
  if (!uom) {
    throw utilityMeterUomNotFoundError();
  }
  return uom;
}

/**
 * BE-18B is opt-in: when the Client has configured this utility type, the
 * meter's unit must still be an allowed one. This catches a meter whose
 * configuration was tightened after the meter was created.
 */
async function assertConfiguredPrecision(
  meter: UtilityMeterRecord,
  readingValue: number,
): Promise<void> {
  const configuration =
    await utilityTypeConfigurationRepository.findByClientAndType(
      meter.clientId,
      meter.utilityType,
    );
  if (!configuration || configuration.decimalPrecision === null) {
    return;
  }
  if (countDecimals(readingValue) > configuration.decimalPrecision) {
    throw utilityMeterReadingValueInvalidError(
      `Reading exceeds the configured decimal precision (${configuration.decimalPrecision}) for ${meter.utilityType}.`,
    );
  }
}

/**
 * Validates an optional BE-10C linkage.
 *
 * The engineering binding and form instance must exist and belong to the same
 * Building / Client as the meter — a reading may not claim provenance from
 * another building's round. BE-18E only *references* these rows; the
 * engineering workflow and its `form_responses` value remain BE-10C's.
 */
async function assertEngineeringContext(
  meter: UtilityMeterRecord,
  meterReadingBindingId: string | null,
  formInstanceId: string | null,
): Promise<void> {
  if (meterReadingBindingId) {
    const result = await getPool().query<{
      client_id: string;
      building_id: string;
    }>(
      'SELECT client_id, building_id FROM meter_reading_bindings WHERE id = $1',
      [meterReadingBindingId],
    );
    const binding = result.rows[0];
    if (!binding) {
      throw AppError.validation('Request validation failed.', [
        {
          field: 'meterReadingBindingId',
          message: 'The referenced meter reading binding does not exist.',
        },
      ]);
    }
    if (
      binding.client_id !== meter.clientId ||
      binding.building_id !== meter.buildingId
    ) {
      throw AppError.validation('Request validation failed.', [
        {
          field: 'meterReadingBindingId',
          message:
            'The referenced meter reading binding belongs to a different building.',
        },
      ]);
    }
  }

  if (formInstanceId) {
    const result = await getPool().query<{ client_id: string }>(
      'SELECT client_id FROM form_instances WHERE id = $1',
      [formInstanceId],
    );
    const instance = result.rows[0];
    if (!instance) {
      throw AppError.validation('Request validation failed.', [
        {
          field: 'formInstanceId',
          message: 'The referenced form instance does not exist.',
        },
      ]);
    }
    if (instance.client_id !== meter.clientId) {
      throw AppError.validation('Request validation failed.', [
        {
          field: 'formInstanceId',
          message:
            'The referenced form instance belongs to a different client.',
        },
      ]);
    }
  }
}

/**
 * Records a reading against a Meter.
 *
 * Validation order:
 *   1. unknown Meter                → 404 UTILITY_METER_NOT_FOUND
 *   2. no Building access           → 403 BUILDING_ACCESS_DENIED
 *   3. INACTIVE Meter               → 400 UTILITY_METER_INACTIVE
 *   4. unknown / foreign / mismatched UOM → 404 / 400
 *   5. precision beyond BE-18B config     → 400 VALUE_INVALID
 *   6. bad BE-10C linkage           → 400 VALIDATION_ERROR
 *   7. duplicate instant            → 409 READING_ALREADY_EXISTS
 *
 * CR-BE-RN12-METER-FIELD-01 PART 01 — optional `executor`
 * -------------------------------------------------------
 * When supplied, the WRITE path (duplicate-instant lookup, reading INSERT and
 * the `UTILITY_METER_READING_RECORDED` event) runs on that connection instead
 * of the pool, so a caller inside `withTransaction` commits the reading and
 * its audit event atomically. Omitting it preserves the existing behaviour for
 * every management caller, and the read-only validation above (meter, UOM,
 * BE-18B precision, BE-18D tenancy, BE-10C linkage) still runs on the pool —
 * it mutates nothing, so it needs no transactional visibility.
 *
 * This closes the pre-existing gap where the reading INSERT and its event were
 * two separate pool statements: an event failure after a committed reading
 * could leave an unaudited measurement. It is strengthened for ALL callers,
 * not just the field path, and no second field-only event is introduced.
 */
export async function recordUtilityMeterReading(
  input: RecordUtilityMeterReadingInput,
  actorUserId?: string,
  executor: UtilityMeterReadingExecutor = getPool(),
): Promise<PublicUtilityMeterReading> {
  const meter = await loadMeter(input.meterId);
  await assertBuildingAccess(actorUserId, meter.buildingId);

  if (meter.status !== 'ACTIVE') {
    throw utilityMeterInactiveError(
      'Inactive meters cannot accept new readings.',
    );
  }

  const uom = await resolveReadingUom(meter, input.uomId);
  await assertConfiguredPrecision(meter, input.readingValue);

  const meterReadingBindingId = input.meterReadingBindingId ?? null;
  const formInstanceId = input.formInstanceId ?? null;
  await assertEngineeringContext(meter, meterReadingBindingId, formInstanceId);

  // Posted readings are never overwritten: a repeat at the same instant is a
  // duplicate submission, not a correction.
  const clash = await utilityMeterReadingRepository.findByMeterAndInstant(
    meter.id,
    input.readingAt,
    executor,
  );
  if (clash) {
    throw utilityMeterReadingAlreadyExistsError();
  }

  // BE-18D tenant context is captured as it stands NOW. After a tenancy
  // turnover it can no longer be re-derived, so the reading must carry it.
  const tenantAssignment = await utilityMeterTenantRepository.findActiveByMeter(
    meter.id,
  );

  // A caller may state which tenant it believes the meter serves. That is a
  // cross-check against BE-18D, never an override: attributing a reading to
  // the wrong tenant is a billing error nobody would notice later.
  if (
    input.tenantCompanyId &&
    input.tenantCompanyId !== tenantAssignment?.tenantCompanyId
  ) {
    throw utilityMeterReadingTenantMismatchError(
      tenantAssignment
        ? 'The supplied tenant does not match the current tenant assignment of this meter.'
        : 'This meter is not currently assigned to any tenant.',
    );
  }

  const newReading: NewUtilityMeterReading = {
    clientId: meter.clientId,
    buildingId: meter.buildingId,
    meterId: meter.id,
    uomId: uom.id,
    readingValue: input.readingValue,
    readingAt: input.readingAt,
    source: input.source ?? 'MANUAL',
    readingType: input.readingType ?? 'ACTUAL',
    notes: input.notes ?? null,
    recordedByUserId: input.recordedByUserId,
    tenantAssignmentId: tenantAssignment?.id ?? null,
    tenantCompanyId: tenantAssignment?.tenantCompanyId ?? null,
    meterReadingBindingId,
    formInstanceId,
  };

  let record: UtilityMeterReadingRecord;
  try {
    record = await utilityMeterReadingRepository.create(newReading, executor);
  } catch (error) {
    if (isUniqueViolation(error, 'utility_meter_readings_meter_instant_unique')) {
      throw utilityMeterReadingAlreadyExistsError();
    }
    if (isUniqueViolation(error, 'utility_meter_readings_form_instance_unique')) {
      throw utilityMeterReadingAlreadyExistsError();
    }
    throw error;
  }

  // Append-only operational trail, on the shared BE-07 event store used by
  // BE-10C — no parallel audit engine.
  await recordOperationalEvent({
    clientId: meter.clientId,
    eventType: 'UTILITY_METER_READING_RECORDED',
    entityType: 'UTILITY_METER_READING',
    entityId: record.id,
    actorUserId: input.recordedByUserId,
    buildingId: meter.buildingId,
    summary: `Meter reading recorded for meter ${meter.code}`,
    metadata: {
      meterId: meter.id,
      utilityType: meter.utilityType,
      uomId: uom.id,
      readingAt: record.readingAt.toISOString(),
      source: record.source,
      readingType: record.readingType,
      tenantCompanyId: record.tenantCompanyId,
      meterReadingBindingId: record.meterReadingBindingId,
      formInstanceId: record.formInstanceId,
    },
  }, executor);

  return toPublicUtilityMeterReading(record, { meter, uom });
}

export async function getUtilityMeterReadingById(
  id: string,
  actorUserId?: string,
): Promise<PublicUtilityMeterReading> {
  const record = await utilityMeterReadingRepository.findById(id);
  if (!record) {
    throw utilityMeterReadingNotFoundError();
  }
  await assertBuildingAccess(actorUserId, record.buildingId);
  return enrichOne(record);
}

/** Chronological reading history of a Meter, newest first. */
export async function listReadingsByMeter(
  meterId: string,
  filters: UtilityMeterReadingFilters,
  actorUserId?: string,
): Promise<PublicUtilityMeterReading[]> {
  const meter = await loadMeter(meterId);
  await assertBuildingAccess(actorUserId, meter.buildingId);

  const records = await utilityMeterReadingRepository.listByMeter(
    meterId,
    filters,
  );
  return enrich(records, meter);
}

export async function listReadingsByBuilding(
  buildingId: string,
  filters: UtilityMeterReadingFilters,
  actorUserId?: string,
): Promise<PublicUtilityMeterReading[]> {
  await assertBuildingAccess(actorUserId, buildingId);

  const records = await utilityMeterReadingRepository.listByBuilding(
    buildingId,
    filters,
  );
  return enrich(records);
}

/**
 * Tenant-scoped readings, restricted at the database level to the Buildings
 * the actor can access.
 */
export async function listReadingsByTenantCompany(
  tenantCompanyId: string,
  filters: UtilityMeterReadingFilters,
  actorUserId?: string,
): Promise<PublicUtilityMeterReading[]> {
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

  const records = await utilityMeterReadingRepository.listByTenantCompany(
    tenantCompanyId,
    buildingIds,
    filters,
  );
  return enrich(records);
}

/**
 * The latest reading of a Meter. `null` means the meter has never been read —
 * a valid state, not an error.
 */
export async function getLatestReadingForMeter(
  meterId: string,
  actorUserId?: string,
): Promise<PublicUtilityMeterReading | null> {
  const meter = await loadMeter(meterId);
  await assertBuildingAccess(actorUserId, meter.buildingId);

  const record = await utilityMeterReadingRepository.findLatestByMeter(meterId);
  if (!record) {
    return null;
  }
  const uom = await loadUom(record.uomId);
  return toPublicUtilityMeterReading(record, { meter, uom });
}

async function enrichOne(
  record: UtilityMeterReadingRecord,
): Promise<PublicUtilityMeterReading> {
  const [meter, uom] = await Promise.all([
    utilityMeterRepository.findById(record.meterId),
    loadUom(record.uomId),
  ]);
  return toPublicUtilityMeterReading(record, { meter, uom });
}

/** Batch-loads meter and UOM context for a list of readings. */
async function enrich(
  records: readonly UtilityMeterReadingRecord[],
  knownMeter?: UtilityMeterRecord,
): Promise<PublicUtilityMeterReading[]> {
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

  const uoms = new Map<string, ReadingUomSummary>();
  for (const id of new Set(records.map((record) => record.uomId))) {
    const uom = await loadUom(id);
    if (uom) {
      uoms.set(id, uom);
    }
  }

  return records.map((record) =>
    toPublicUtilityMeterReading(record, {
      meter: meters.get(record.meterId) ?? null,
      uom: uoms.get(record.uomId) ?? null,
    }),
  );
}

/** Decimal places of a plain-decimal number. */
function countDecimals(value: number): number {
  const text = String(value);
  const fraction = text.split('.')[1];
  return fraction ? fraction.length : 0;
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === '23505' && candidate.constraint === constraint;
}

export const utilityMeterReadingService = {
  getLatestReadingForMeter,
  getUtilityMeterReadingById,
  listReadingsByBuilding,
  listReadingsByMeter,
  listReadingsByTenantCompany,
  recordUtilityMeterReading,
  toPublicUtilityMeterReading,
};
