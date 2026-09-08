import { getPool } from '../../database';
import { clientNotFoundError, clientRepository } from '../clients';
import { contextAccessService } from '../context-access';
import { buildingAccessDeniedError } from '../context-access/context-access.errors';
import { recordOperationalEvent } from '../operational-events';
import {
  tenantCompanyNotFoundError,
  tenantCompanyRepository,
} from '../tenant-companies';
import { utilityMeterConsumptionRepository } from '../utility-meter-consumptions/utility-meter-consumption.repository';
import type { UtilityMeterConsumptionRecord } from '../utility-meter-consumptions/utility-meter-consumption.types';
import { utilityMeterNotFoundError } from '../utility-meters/utility-meter.errors';
import { utilityMeterRepository } from '../utility-meters/utility-meter.repository';
import type { UtilityMeterRecord } from '../utility-meters/utility-meter.types';
import { utilityTariffNotFoundError } from '../utility-tariffs/utility-tariff.errors';
import { utilityTariffRepository } from '../utility-tariffs/utility-tariff.repository';
import type { UtilityTariffRecord } from '../utility-tariffs/utility-tariff.types';
import {
  utilityCalculationAlreadyExistsError,
  utilityCalculationAlreadyFinalizedError,
  utilityCalculationBasisInvalidError,
  utilityCalculationBasisNotFoundError,
  utilityCalculationConsumptionInvalidError,
  utilityCalculationNotFoundError,
  utilityCalculationNotRecalculableError,
} from './utility-calculation.errors';
import { utilityCalculationRepository } from './utility-calculation.repository';
import type {
  CalculateUtilityValueInput,
  CalculationConsumptionSummary,
  CalculationMeterSummary,
  CalculationUomSummary,
  CreateUtilityCalculationBasisInput,
  NewUtilityCalculation,
  NewUtilityCalculationBasis,
  PublicUtilityCalculation,
  PublicUtilityCalculationBasis,
  RecalculateUtilityValueInput,
  UtilityCalculationBasisFilters,
  UtilityCalculationBasisRecord,
  UtilityCalculationFilters,
  UtilityCalculationRecord,
} from './utility-calculation.types';

/**
 * BE-18I — Utility Calculation service.
 *
 * A calculated value is *derived*, never entered:
 *
 *   calculated amount = consumption value x applied rate
 *
 * The consumption operand comes from an authoritative BE-18G record. The
 * caller supplies a consumption reference, never a value or an amount —
 * there is deliberately no way to post a figure directly, because a
 * hand-entered amount would be a second source of truth that could silently
 * contradict the consumption behind it.
 *
 * Authorities reused, never re-derived:
 *   - consumption value, period, tenant snapshot → BE-18G
 *   - the readings behind that figure            → BE-18E (two hops, untouched)
 *   - Meter identity, Client / Building, UOM     → BE-18A
 *   - unit master                                → BE-07
 *   - Building access                            → BE-02G
 *
 * Calculation rules stay lightweight and data-driven: the rate lives in
 * `utility_calculation_bases` reference data, not in code, so changing a rate
 * is a data operation. There is exactly one arithmetic rule here
 * (value x rate) and no tiering, blocks, proration, taxes or surcharges.
 *
 * History is preserved. Recalculation never overwrites: it supersedes a DRAFT
 * with a NEW row linked by `supersedesCalculationId`. A FINALIZED result is
 * terminal and is protected from recalculation, re-finalization and
 * supersession alike.
 *
 * Out of scope, deliberately: invoicing, tax, payment, accounting, and
 * Abnormal Consumption (BE-18J). Billing never lives in BE-18.
 */

function meterSummary(record: UtilityMeterRecord): CalculationMeterSummary {
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

function consumptionSummary(
  record: UtilityMeterConsumptionRecord,
): CalculationConsumptionSummary {
  return {
    id: record.id,
    consumptionValue: Number(record.consumptionValue),
    uomId: record.uomId,
    periodStart: record.periodStart.toISOString(),
    periodEnd: record.periodEnd.toISOString(),
    meterId: record.meterId,
    tenantCompanyId: record.tenantCompanyId,
  };
}

export function toPublicUtilityCalculationBasis(
  record: UtilityCalculationBasisRecord,
): PublicUtilityCalculationBasis {
  return {
    id: record.id,
    clientId: record.clientId,
    utilityType: record.utilityType,
    name: record.name,
    description: record.description,
    uomId: record.uomId,
    rateValue: Number(record.rateValue),
    rateLabel: record.rateLabel,
    effectiveFrom: record.effectiveFrom.toISOString(),
    effectiveTo: record.effectiveTo ? record.effectiveTo.toISOString() : null,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export function toPublicUtilityCalculation(
  record: UtilityCalculationRecord,
  context: {
    meter?: UtilityMeterRecord | null;
    uom?: CalculationUomSummary | null;
    consumption?: UtilityMeterConsumptionRecord | null;
    basis?: UtilityCalculationBasisRecord | null;
  } = {},
): PublicUtilityCalculation {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    meterId: record.meterId,
    utilityType: record.utilityType,
    consumptionId: record.consumptionId,
    calculationBasisId: record.calculationBasisId,
    consumptionQuantity: Number(record.consumptionQuantity),
    tariffId: record.tariffId,
    tariffRate: record.tariffRate === null ? null : Number(record.tariffRate),
    currency: record.currency,
    appliedRateValue: Number(record.appliedRateValue),
    calculatedAmount: Number(record.calculatedAmount),
    uomId: record.uomId,
    periodStart: record.periodStart.toISOString(),
    periodEnd: record.periodEnd.toISOString(),
    status: record.status,
    calculatedAt: record.calculatedAt.toISOString(),
    calculatedByUserId: record.calculatedByUserId,
    finalizedAt: record.finalizedAt ? record.finalizedAt.toISOString() : null,
    finalizedByUserId: record.finalizedByUserId,
    supersedesCalculationId: record.supersedesCalculationId,
    tenantAssignmentId: record.tenantAssignmentId,
    tenantCompanyId: record.tenantCompanyId,
    notes: record.notes,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    ...(context.meter === undefined
      ? {}
      : { meter: context.meter ? meterSummary(context.meter) : null }),
    ...(context.uom === undefined ? {} : { uom: context.uom }),
    ...(context.consumption === undefined
      ? {}
      : {
          consumption: context.consumption
            ? consumptionSummary(context.consumption)
            : null,
        }),
    ...(context.basis === undefined
      ? {}
      : {
          basis: context.basis
            ? toPublicUtilityCalculationBasis(context.basis)
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

async function assertClientAccess(
  actorUserId: string | undefined,
  clientId: string,
): Promise<void> {
  if (!actorUserId) {
    return;
  }
  if (!(await contextAccessService.canAccessClient(actorUserId, clientId))) {
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

async function loadUom(uomId: string): Promise<CalculationUomSummary | null> {
  const result = await getPool().query<CalculationUomSummary>(
    'SELECT id, code, name, symbol FROM units_of_measure WHERE id = $1',
    [uomId],
  );
  return result.rows[0] ?? null;
}

async function loadConsumption(
  consumptionId: string,
): Promise<UtilityMeterConsumptionRecord> {
  const consumption =
    await utilityMeterConsumptionRepository.findById(consumptionId);
  if (!consumption) {
    throw utilityCalculationConsumptionInvalidError(
      'The referenced consumption does not exist.',
    );
  }
  return consumption;
}

/**
 * Resolves the basis to apply.
 *
 * An explicit basis is validated against the consumption it is being applied
 * to: same Client, same utility type, ACTIVE, and an effective window that
 * covers the whole period. Otherwise the ACTIVE basis covering that period is
 * looked up. A missing basis is an error rather than an implicit zero rate —
 * silently valuing consumption at nothing would look like a real result.
 */
async function resolveBasis(
  explicitBasisId: string | undefined,
  consumption: UtilityMeterConsumptionRecord,
  meter: UtilityMeterRecord,
): Promise<UtilityCalculationBasisRecord> {
  if (explicitBasisId) {
    const basis = await utilityCalculationRepository.findBasisById(
      explicitBasisId,
    );
    if (!basis) {
      throw utilityCalculationBasisNotFoundError();
    }
    if (basis.clientId !== consumption.clientId) {
      throw utilityCalculationBasisInvalidError(
        'The calculation basis belongs to a different client.',
      );
    }
    if (basis.utilityType !== meter.utilityType) {
      throw utilityCalculationBasisInvalidError(
        'The calculation basis applies to a different utility type.',
      );
    }
    if (basis.status !== 'ACTIVE') {
      throw utilityCalculationBasisInvalidError(
        'The calculation basis is not active.',
      );
    }
    // A rate that does not span the whole period cannot describe it.
    if (basis.effectiveFrom.getTime() > consumption.periodStart.getTime()) {
      throw utilityCalculationBasisInvalidError(
        'The calculation basis is not yet effective for this consumption period.',
      );
    }
    if (
      basis.effectiveTo &&
      basis.effectiveTo.getTime() < consumption.periodEnd.getTime()
    ) {
      throw utilityCalculationBasisInvalidError(
        'The calculation basis expired before the end of this consumption period.',
      );
    }
    // A basis bound to a unit must match the unit the consumption is in.
    if (basis.uomId && basis.uomId !== consumption.uomId) {
      throw utilityCalculationBasisInvalidError(
        'The calculation basis applies to a different unit of measure.',
      );
    }
    return basis;
  }

  const resolved = await utilityCalculationRepository.findApplicableBasis(
    consumption.clientId,
    meter.utilityType,
    consumption.periodStart,
    consumption.periodEnd,
  );
  if (!resolved) {
    throw utilityCalculationBasisNotFoundError(
      'No active calculation basis covers this consumption period.',
    );
  }
  if (resolved.uomId && resolved.uomId !== consumption.uomId) {
    throw utilityCalculationBasisInvalidError(
      'The applicable calculation basis uses a different unit of measure.',
    );
  }
  return resolved;
}

/** Resolve one Building tariff covering the complete authoritative period. */
async function findTariff(
  consumption: UtilityMeterConsumptionRecord,
  meter: UtilityMeterRecord,
): Promise<UtilityTariffRecord | null> {
  return utilityTariffRepository.resolveForPeriod({
    clientId: consumption.clientId,
    buildingId: consumption.buildingId,
    utilityType: meter.utilityType,
    uomId: consumption.uomId,
    periodStart: consumption.periodStart,
    periodEnd: consumption.periodEnd,
  });
}

async function resolveCalculationRule(
  explicitBasisId: string | undefined,
  consumption: UtilityMeterConsumptionRecord,
  meter: UtilityMeterRecord,
): Promise<{ basis: UtilityCalculationBasisRecord | null; tariff: UtilityTariffRecord | null }> {
  if (explicitBasisId || (meter.utilityType !== 'ELECTRICITY' && meter.utilityType !== 'WATER')) {
    return { basis: await resolveBasis(explicitBasisId, consumption, meter), tariff: null };
  }

  const tariff = await findTariff(consumption, meter);
  if (tariff) return { basis: null, tariff };

  // Existing Client-scoped BE-18I bases remain a compatibility path for
  // calculations configured before PART 10. New governed monetary charges
  // resolve the Building tariff above; no implicit zero or arbitrary rate is
  // ever introduced.
  const legacyBasis = await utilityCalculationRepository.findApplicableBasis(
    consumption.clientId, meter.utilityType,
    consumption.periodStart, consumption.periodEnd,
  );
  if (legacyBasis) {
    if (legacyBasis.uomId && legacyBasis.uomId !== consumption.uomId) {
      throw utilityCalculationBasisInvalidError(
        'The applicable legacy calculation basis uses a different unit of measure.',
      );
    }
    return { basis: legacyBasis, tariff: null };
  }

  throw utilityTariffNotFoundError(
    'No active Building tariff matches the consumption period, utility type, and UOM.',
  );
}

async function enrichOne(
  record: UtilityCalculationRecord,
): Promise<PublicUtilityCalculation> {
  const [meter, uom, consumption, basis] = await Promise.all([
    utilityMeterRepository.findById(record.meterId),
    loadUom(record.uomId),
    utilityMeterConsumptionRepository.findById(record.consumptionId),
    record.calculationBasisId
      ? utilityCalculationRepository.findBasisById(record.calculationBasisId)
      : Promise.resolve(null),
  ]);
  return toPublicUtilityCalculation(record, {
    meter,
    uom,
    consumption,
    basis,
  });
}

async function enrich(
  records: readonly UtilityCalculationRecord[],
): Promise<PublicUtilityCalculation[]> {
  const meters = new Map<string, UtilityMeterRecord | null>();
  const uoms = new Map<string, CalculationUomSummary | null>();

  for (const id of new Set(records.map((record) => record.meterId))) {
    meters.set(id, await utilityMeterRepository.findById(id));
  }
  for (const id of new Set(records.map((record) => record.uomId))) {
    uoms.set(id, await loadUom(id));
  }

  return records.map((record) =>
    toPublicUtilityCalculation(record, {
      meter: meters.get(record.meterId) ?? null,
      uom: uoms.get(record.uomId) ?? null,
    }),
  );
}

/* -------------------------------------------------------------------------
 * Calculation basis
 * ---------------------------------------------------------------------- */

/** Registers a lightweight, data-driven rate for a Client + utility type. */
export async function createUtilityCalculationBasis(
  input: CreateUtilityCalculationBasisInput,
  actorUserId?: string,
): Promise<PublicUtilityCalculationBasis> {
  const client = await clientRepository.findById(input.clientId);
  if (!client) {
    throw clientNotFoundError();
  }
  await assertClientAccess(actorUserId, input.clientId);

  const newBasis: NewUtilityCalculationBasis = {
    clientId: input.clientId,
    utilityType: input.utilityType,
    name: input.name,
    description: input.description ?? null,
    uomId: input.uomId ?? null,
    rateValue: input.rateValue,
    rateLabel: input.rateLabel ?? null,
    effectiveFrom: input.effectiveFrom,
    effectiveTo: input.effectiveTo ?? null,
    status: input.status ?? 'ACTIVE',
  };

  const record = await utilityCalculationRepository.createBasis(newBasis);
  return toPublicUtilityCalculationBasis(record);
}

export async function listUtilityCalculationBases(
  clientId: string,
  filters: UtilityCalculationBasisFilters,
  actorUserId?: string,
): Promise<PublicUtilityCalculationBasis[]> {
  const client = await clientRepository.findById(clientId);
  if (!client) {
    throw clientNotFoundError();
  }
  await assertClientAccess(actorUserId, clientId);

  const records = await utilityCalculationRepository.listBasesByClient(
    clientId,
    filters,
  );
  return records.map(toPublicUtilityCalculationBasis);
}

/* -------------------------------------------------------------------------
 * Calculation
 * ---------------------------------------------------------------------- */

/**
 * Calculates and persists a utility value from an authoritative consumption.
 *
 * Validation order:
 *   1. unknown consumption            → 400 ..._CONSUMPTION_INVALID
 *   2. no Building access             → 403 BUILDING_ACCESS_DENIED
 *   3. unknown Meter behind it        → 404 UTILITY_METER_NOT_FOUND
 *   4. basis unknown                  → 404 ..._BASIS_NOT_FOUND
 *   5. basis not applicable           → 400 ..._BASIS_INVALID
 *   6. live result already exists     → 409 ..._ALREADY_EXISTS
 */
export async function calculateUtilityValue(
  input: CalculateUtilityValueInput,
  actorUserId?: string,
): Promise<PublicUtilityCalculation> {
  const consumption = await loadConsumption(input.consumptionId);
  await assertBuildingAccess(actorUserId, consumption.buildingId);

  const meter = await loadMeter(consumption.meterId);
  const { basis, tariff } = await resolveCalculationRule(
    input.calculationBasisId, consumption, meter,
  );

  const existing = await utilityCalculationRepository.findLiveByConsumption(
    consumption.id,
  );
  if (existing) {
    throw utilityCalculationAlreadyExistsError();
  }

  const record = await persistCalculation({
    consumption,
    meter,
    basis,
    tariff,
    supersedesCalculationId: null,
    calculatedByUserId: input.calculatedByUserId ?? null,
    notes: input.notes ?? null,
  });

  const uom = await loadUom(record.uomId);
  const appliedBasis = basis ??
    (tariff ? await utilityCalculationRepository.findBasisById(tariff.id) : null);
  return toPublicUtilityCalculation(record, {
    meter,
    uom,
    consumption,
    basis: appliedBasis,
  });
}

/** Shared insert path for both first calculation and recalculation. */
async function persistCalculation(args: {
  consumption: UtilityMeterConsumptionRecord;
  meter: UtilityMeterRecord;
  basis: UtilityCalculationBasisRecord | null;
  tariff: UtilityTariffRecord | null;
  supersedesCalculationId: string | null;
  calculatedByUserId: string | null;
  notes: string | null;
}): Promise<UtilityCalculationRecord> {
  const { consumption, meter, basis, tariff } = args;
  const rateValue = tariff?.ratePerUom ?? basis?.rateValue;
  if (!rateValue) {
    throw utilityTariffNotFoundError();
  }

  const newCalculation: NewUtilityCalculation = {
    clientId: consumption.clientId,
    buildingId: consumption.buildingId,
    meterId: consumption.meterId,
    utilityType: meter.utilityType,
    consumptionId: consumption.id,
    calculationBasisId: tariff?.id ?? basis?.id ?? null,
    consumptionQuantity: consumption.consumptionValue,
    tariffId: tariff?.id ?? null,
    tariffRate: tariff?.ratePerUom ?? null,
    currency: tariff?.currency ?? null,
    // Frozen exact decimal rate. The repository multiplies NUMERIC operands.
    appliedRateValue: rateValue,
    uomId: consumption.uomId,
    // Mirrors the consumption's own period — never a caller-supplied one.
    periodStart: consumption.periodStart,
    periodEnd: consumption.periodEnd,
    status: 'DRAFT',
    calculatedByUserId: args.calculatedByUserId,
    supersedesCalculationId: args.supersedesCalculationId,
    // Tenant context is taken from the consumption (BE-18D snapshot), so it
    // reflects who the meter served across the period, not who it serves now.
    tenantAssignmentId: consumption.tenantAssignmentId,
    tenantCompanyId: consumption.tenantCompanyId,
    notes: args.notes,
  };

  let record: UtilityCalculationRecord;
  try {
    record = await utilityCalculationRepository.create(newCalculation);
  } catch (error) {
    if (
      isUniqueViolation(error, 'utility_calculations_live_consumption_unique')
    ) {
      throw utilityCalculationAlreadyExistsError();
    }
    throw error;
  }

  await recordOperationalEvent({
    clientId: record.clientId,
    eventType: args.supersedesCalculationId
      ? 'UTILITY_CALCULATION_RECALCULATED'
      : 'UTILITY_CALCULATION_CALCULATED',
    entityType: 'UTILITY_CALCULATION',
    entityId: record.id,
    ...(args.calculatedByUserId
      ? { actorUserId: args.calculatedByUserId }
      : {}),
    buildingId: record.buildingId,
    summary: `Utility value calculated for meter ${meter.code}`,
    metadata: {
      meterId: meter.id,
      utilityType: record.utilityType,
      consumptionId: record.consumptionId,
      calculationBasisId: record.calculationBasisId,
      consumptionQuantity: record.consumptionQuantity,
      tariffId: record.tariffId,
      tariffRate: record.tariffRate,
      currency: record.currency,
      appliedRateValue: Number(record.appliedRateValue),
      calculatedAmount: Number(record.calculatedAmount),
      periodStart: record.periodStart.toISOString(),
      periodEnd: record.periodEnd.toISOString(),
      tenantCompanyId: record.tenantCompanyId,
      ...(args.supersedesCalculationId
        ? { supersedesCalculationId: args.supersedesCalculationId }
        : {}),
    },
  });

  return record;
}

/**
 * Recalculates a DRAFT result.
 *
 * The prior result is NOT overwritten: it is marked SUPERSEDED and a new row
 * is written pointing back at it, so the history of what was calculated, when
 * and at which rate stays intact and auditable.
 *
 * A FINALIZED result is refused outright (409). A SUPERSEDED one is refused
 * too — history is not a working surface.
 */
export async function recalculateUtilityValue(
  input: RecalculateUtilityValueInput,
  actorUserId?: string,
): Promise<PublicUtilityCalculation> {
  const existing = await utilityCalculationRepository.findById(
    input.calculationId,
  );
  if (!existing) {
    throw utilityCalculationNotFoundError();
  }
  await assertBuildingAccess(actorUserId, existing.buildingId);

  // A finalized figure that could silently change would be worthless.
  if (existing.status === 'FINALIZED') {
    throw utilityCalculationAlreadyFinalizedError(
      'This calculation is finalized and cannot be recalculated.',
    );
  }
  if (existing.status === 'SUPERSEDED') {
    throw utilityCalculationNotRecalculableError();
  }

  const consumption = await loadConsumption(existing.consumptionId);
  const meter = await loadMeter(consumption.meterId);
  const { basis, tariff } = await resolveCalculationRule(
    input.calculationBasisId, consumption, meter,
  );

  // Retire the predecessor first, guarded on DRAFT in SQL: if a concurrent
  // request finalized it in the meantime, this returns null and we refuse
  // rather than superseding a finalized result.
  const superseded = await utilityCalculationRepository.markSuperseded(
    existing.id,
  );
  if (!superseded) {
    throw utilityCalculationAlreadyFinalizedError(
      'This calculation was finalized or superseded concurrently and cannot be recalculated.',
    );
  }

  const record = await persistCalculation({
    consumption,
    meter,
    basis,
    tariff,
    supersedesCalculationId: existing.id,
    calculatedByUserId: input.calculatedByUserId ?? null,
    notes: input.notes ?? existing.notes,
  });

  const uom = await loadUom(record.uomId);
  return toPublicUtilityCalculation(record, {
    meter,
    uom,
    consumption,
    basis,
  });
}

/**
 * Finalizes a DRAFT result, freezing it. Following the DRAFT → FINALIZED
 * convention already used by vendor service reports.
 */
export async function finalizeUtilityCalculation(
  calculationId: string,
  actorUserId?: string,
): Promise<PublicUtilityCalculation> {
  const existing = await utilityCalculationRepository.findById(calculationId);
  if (!existing) {
    throw utilityCalculationNotFoundError();
  }
  await assertBuildingAccess(actorUserId, existing.buildingId);

  if (existing.status === 'FINALIZED') {
    throw utilityCalculationAlreadyFinalizedError(
      'This calculation is already finalized.',
    );
  }
  if (existing.status === 'SUPERSEDED') {
    throw utilityCalculationNotRecalculableError(
      'This calculation has been superseded and cannot be finalized.',
    );
  }

  const record = await utilityCalculationRepository.markFinalized(
    existing.id,
    actorUserId ?? null,
  );
  if (!record) {
    throw utilityCalculationAlreadyFinalizedError(
      'This calculation was finalized or superseded concurrently.',
    );
  }

  await recordOperationalEvent({
    clientId: record.clientId,
    eventType: 'UTILITY_CALCULATION_FINALIZED',
    entityType: 'UTILITY_CALCULATION',
    entityId: record.id,
    ...(actorUserId ? { actorUserId } : {}),
    buildingId: record.buildingId,
    summary: 'Utility calculation finalized',
    metadata: {
      meterId: record.meterId,
      consumptionId: record.consumptionId,
      calculatedAmount: Number(record.calculatedAmount),
      periodStart: record.periodStart.toISOString(),
      periodEnd: record.periodEnd.toISOString(),
    },
  });

  return enrichOne(record);
}

export async function getUtilityCalculationById(
  id: string,
  actorUserId?: string,
): Promise<PublicUtilityCalculation> {
  const record = await utilityCalculationRepository.findById(id);
  if (!record) {
    throw utilityCalculationNotFoundError();
  }
  await assertBuildingAccess(actorUserId, record.buildingId);
  return enrichOne(record);
}

/** Full calculation history for one consumption, newest first. */
export async function listCalculationsByConsumption(
  consumptionId: string,
  actorUserId?: string,
): Promise<PublicUtilityCalculation[]> {
  const consumption = await loadConsumption(consumptionId);
  await assertBuildingAccess(actorUserId, consumption.buildingId);

  const records =
    await utilityCalculationRepository.listByConsumption(consumptionId);
  return enrich(records);
}

export async function listCalculationsByMeter(
  meterId: string,
  filters: UtilityCalculationFilters,
  actorUserId?: string,
): Promise<PublicUtilityCalculation[]> {
  const meter = await loadMeter(meterId);
  await assertBuildingAccess(actorUserId, meter.buildingId);

  const records = await utilityCalculationRepository.listByScope(
    { column: 'meter_id', value: meter.id },
    filters,
  );
  return enrich(records);
}

export async function listCalculationsByBuilding(
  buildingId: string,
  filters: UtilityCalculationFilters,
  actorUserId?: string,
): Promise<PublicUtilityCalculation[]> {
  await assertBuildingAccess(actorUserId, buildingId);

  const records = await utilityCalculationRepository.listByScope(
    { column: 'building_id', value: buildingId },
    filters,
  );
  return enrich(records);
}

/**
 * Tenant-scoped calculations, restricted at the database level to the
 * Buildings the actor can access.
 */
export async function listCalculationsByTenantCompany(
  tenantCompanyId: string,
  filters: UtilityCalculationFilters,
  actorUserId?: string,
): Promise<PublicUtilityCalculation[]> {
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

  const records = await utilityCalculationRepository.listByScope(
    { column: 'tenant_company_id', value: tenantCompanyId },
    filters,
    buildingIds,
  );
  return enrich(records);
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === '23505' && candidate.constraint === constraint;
}

export const utilityCalculationService = {
  calculateUtilityValue,
  createUtilityCalculationBasis,
  finalizeUtilityCalculation,
  getUtilityCalculationById,
  listCalculationsByBuilding,
  listCalculationsByConsumption,
  listCalculationsByMeter,
  listCalculationsByTenantCompany,
  listUtilityCalculationBases,
  recalculateUtilityValue,
  toPublicUtilityCalculation,
  toPublicUtilityCalculationBasis,
};
