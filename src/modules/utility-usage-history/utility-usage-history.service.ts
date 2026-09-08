import { getPool } from '../../database';
import { contextAccessService } from '../context-access';
import { buildingAccessDeniedError } from '../context-access/context-access.errors';
import {
  tenantCompanyNotFoundError,
  tenantCompanyRepository,
} from '../tenant-companies';
import { utilityMeterNotFoundError } from '../utility-meters/utility-meter.errors';
import { utilityMeterRepository } from '../utility-meters/utility-meter.repository';
import type { UtilityMeterRecord } from '../utility-meters/utility-meter.types';
import {
  utilityUsageHistoryRepository,
  type UsageHistoryRow,
} from './utility-usage-history.repository';
import type {
  PublicUtilityUsageHistory,
  PublicUtilityUsageHistoryEntry,
  UsageHistoryMeterSummary,
  UsageHistoryScope,
  UsageHistoryUomSummary,
  UtilityUsageHistoryFilters,
} from './utility-usage-history.types';

/**
 * BE-18H — Usage History service.
 *
 * A read-only chronological projection over authoritative BE-18G
 * consumptions. This module writes nothing: it owns no table, exposes no
 * create/update/delete, and never re-derives a consumption figure.
 *
 * Why no storage of its own — every field in BE-18H's scope already exists on
 * the BE-18G row, which in turn references the BE-18E readings behind it.
 * Persisting a parallel copy would duplicate source data and allow the two to
 * drift; the append-oriented guarantee already holds upstream, because BE-18G
 * has no update or delete path and BE-18E readings are immutable.
 *
 * Authorities reused, never re-derived:
 *   - consumption values, periods, tenant snapshot → BE-18G
 *   - the readings behind each figure              → BE-18E (referenced only)
 *   - Meter identity, Client / Building, unit      → BE-18A
 *   - unit master                                  → BE-07
 *   - Building access                              → BE-02G
 *
 * Out of scope, deliberately: tariffs, rates, cost, invoicing and any Utility
 * Calculation. Billing never lives in BE-18.
 */

function meterSummary(record: UtilityMeterRecord): UsageHistoryMeterSummary {
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

async function loadUom(uomId: string): Promise<UsageHistoryUomSummary | null> {
  const result = await getPool().query<UsageHistoryUomSummary>(
    'SELECT id, code, name, symbol FROM units_of_measure WHERE id = $1',
    [uomId],
  );
  return result.rows[0] ?? null;
}

/**
 * Maps a BE-18G row to a usage entry.
 *
 * `usageId` deliberately mirrors `consumptionId`: the entry's identity *is*
 * the source consumption's identity, so the linkage can never be ambiguous.
 */
function toEntry(
  row: UsageHistoryRow,
  context: {
    meter?: UtilityMeterRecord | null;
    uom?: UsageHistoryUomSummary | null;
  } = {},
): PublicUtilityUsageHistoryEntry {
  return {
    usageId: row.id,
    consumptionId: row.id,
    clientId: row.clientId,
    buildingId: row.buildingId,
    meterId: row.meterId,
    previousReadingId: row.previousReadingId,
    currentReadingId: row.currentReadingId,
    uomId: row.uomId,
    consumptionValue: Number(row.consumptionValue),
    periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd.toISOString(),
    calculatedAt: row.calculatedAt.toISOString(),
    calculatedByUserId: row.calculatedByUserId,
    tenantAssignmentId: row.tenantAssignmentId,
    tenantCompanyId: row.tenantCompanyId,
    notes: row.notes,
    ...(context.meter === undefined
      ? {}
      : { meter: context.meter ? meterSummary(context.meter) : null }),
    ...(context.uom === undefined ? {} : { uom: context.uom }),
  };
}

/**
 * Wraps entries with chronological span and an aggregate total.
 *
 * The total is summed only when every entry shares one unit. A window that
 * spans a unit change reports `uomConsistent: false`, `uomId: null` and a
 * zero total, because adding kWh to m³ would produce a confidently wrong
 * number — better to refuse the sum than to publish a meaningless one.
 */
function toHistory(
  entries: PublicUtilityUsageHistoryEntry[],
): PublicUtilityUsageHistory {
  if (entries.length === 0) {
    return {
      entries,
      entryCount: 0,
      totalConsumption: 0,
      uomId: null,
      uomConsistent: true,
      periodStart: null,
      periodEnd: null,
    };
  }

  const units = new Set(entries.map((entry) => entry.uomId));
  const uomConsistent = units.size === 1;
  const starts = entries.map((entry) => entry.periodStart).sort();
  const ends = entries.map((entry) => entry.periodEnd).sort();

  return {
    entries,
    entryCount: entries.length,
    totalConsumption: uomConsistent
      ? entries.reduce((sum, entry) => sum + entry.consumptionValue, 0)
      : 0,
    uomId: uomConsistent ? (entries[0]?.uomId ?? null) : null,
    uomConsistent,
    periodStart: starts[0] ?? null,
    periodEnd: ends[ends.length - 1] ?? null,
  };
}

/** Batch-resolves meter and UOM context for a run of rows. */
async function enrich(
  rows: readonly UsageHistoryRow[],
  knownMeter?: UtilityMeterRecord,
): Promise<PublicUtilityUsageHistoryEntry[]> {
  if (rows.length === 0) {
    return [];
  }

  const meters = new Map<string, UtilityMeterRecord>();
  if (knownMeter) {
    meters.set(knownMeter.id, knownMeter);
  }
  for (const id of new Set(rows.map((row) => row.meterId))) {
    if (!meters.has(id)) {
      const meter = await utilityMeterRepository.findById(id);
      if (meter) {
        meters.set(id, meter);
      }
    }
  }

  const uoms = new Map<string, UsageHistoryUomSummary>();
  for (const id of new Set(rows.map((row) => row.uomId))) {
    const uom = await loadUom(id);
    if (uom) {
      uoms.set(id, uom);
    }
  }

  return rows.map((row) =>
    toEntry(row, {
      meter: meters.get(row.meterId) ?? null,
      uom: uoms.get(row.uomId) ?? null,
    }),
  );
}

/** Usage history of one Meter, chronological (ASC by default). */
export async function getUsageHistoryByMeter(
  meterId: string,
  filters: UtilityUsageHistoryFilters,
  actorUserId?: string,
): Promise<PublicUtilityUsageHistory> {
  const meter = await loadMeter(meterId);
  await assertBuildingAccess(actorUserId, meter.buildingId);

  const rows = await utilityUsageHistoryRepository.listByScope(
    { column: 'meter_id', value: meter.id },
    filters,
  );
  return toHistory(await enrich(rows, meter));
}

/** Usage history across one Building. */
export async function getUsageHistoryByBuilding(
  buildingId: string,
  filters: UtilityUsageHistoryFilters,
  actorUserId?: string,
): Promise<PublicUtilityUsageHistory> {
  await assertBuildingAccess(actorUserId, buildingId);

  const rows = await utilityUsageHistoryRepository.listByScope(
    { column: 'building_id', value: buildingId },
    filters,
  );
  return toHistory(await enrich(rows));
}

/**
 * Usage history for one Tenant Company, restricted at the database level to
 * the Buildings the actor can access.
 */
export async function getUsageHistoryByTenantCompany(
  tenantCompanyId: string,
  filters: UtilityUsageHistoryFilters,
  actorUserId?: string,
): Promise<PublicUtilityUsageHistory> {
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

  const rows = await utilityUsageHistoryRepository.listByScope(
    { column: 'tenant_company_id', value: tenantCompanyId },
    filters,
    buildingIds,
  );
  return toHistory(await enrich(rows));
}

/**
 * The latest usage entry for a Meter. `null` means no consumption has been
 * calculated yet — a valid state, not an error.
 */
export async function getLatestUsageHistoryForMeter(
  meterId: string,
  actorUserId?: string,
): Promise<PublicUtilityUsageHistoryEntry | null> {
  const meter = await loadMeter(meterId);
  await assertBuildingAccess(actorUserId, meter.buildingId);

  const row = await utilityUsageHistoryRepository.findLatestByScope({
    column: 'meter_id',
    value: meter.id,
  });
  if (!row) {
    return null;
  }
  const uom = await loadUom(row.uomId);
  return toEntry(row, { meter, uom });
}

/**
 * Chronological consumption history resolved across the caller's accessible
 * Buildings, narrowed by any combination of meter / tenant / building /
 * period. Used by the collection endpoint where no single scope is implied.
 */
export async function resolveUsageHistory(
  filters: UtilityUsageHistoryFilters,
  actorUserId?: string,
): Promise<PublicUtilityUsageHistory> {
  // Anchor to the most specific scope the caller supplied, so the query is
  // always bounded by an authoritative column rather than scanning globally.
  let scope: UsageHistoryScope | null = null;

  if (filters.meterId) {
    const meter = await loadMeter(filters.meterId);
    await assertBuildingAccess(actorUserId, meter.buildingId);
    scope = { column: 'meter_id', value: meter.id };
  } else if (filters.buildingId) {
    await assertBuildingAccess(actorUserId, filters.buildingId);
    scope = { column: 'building_id', value: filters.buildingId };
  } else if (filters.tenantCompanyId) {
    return getUsageHistoryByTenantCompany(
      filters.tenantCompanyId,
      filters,
      actorUserId,
    );
  }

  const buildingIds = actorUserId
    ? await contextAccessService.getAccessibleBuildingIds(actorUserId)
    : null;

  // An explicit meter/building scope was already access-checked above, so it
  // needs no second restriction. Without one, the query is bounded by the
  // caller's accessible Buildings instead of spanning the whole estate.
  const rows = await utilityUsageHistoryRepository.listByScope(
    scope,
    filters,
    scope ? null : buildingIds,
  );
  return toHistory(await enrich(rows));
}

export const utilityUsageHistoryService = {
  getLatestUsageHistoryForMeter,
  getUsageHistoryByBuilding,
  getUsageHistoryByMeter,
  getUsageHistoryByTenantCompany,
  resolveUsageHistory,
};
