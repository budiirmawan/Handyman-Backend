import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { UTILITY_TYPES, type UtilityType } from '../utility-meters/utility-meter.types';
import {
  UTILITY_AGGREGATION_GROUPINGS,
  UTILITY_AGGREGATION_INTERVALS,
  UTILITY_AGGREGATION_METER_SCOPES,
  isUtilityAggregationGrouping,
  isUtilityAggregationInterval,
  isUtilityAggregationMeterScope,
  type UtilityAggregationFilters,
  type UtilityAggregationGrouping,
  type UtilityAggregationInterval,
  type UtilityAggregationMeterScope,
  type UtilityAggregationScope,
} from './utility-aggregation.types';

/** BE-18M — request validation for Utility Aggregation. */

export type ValidationDetail = {
  field: string;
  message: string;
};

function fail(field: string, message: string): never {
  throw AppError.validation('Request validation failed.', [{ field, message }]);
}

function parseUuidQuery(
  raw: string | undefined,
  field: string,
  label: string,
): string | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const value = raw.trim();
  if (!isValidUuid(value)) {
    fail(field, `${label} must be a valid UUID.`);
  }
  return value.toLowerCase();
}

/** Reads the scope anchors from the query string. */
export function parseAggregationScopeQuery(query: {
  clientId?: string;
  buildingId?: string;
  meterId?: string;
  tenantCompanyId?: string;
}): UtilityAggregationScope {
  const clientId = parseUuidQuery(query.clientId, 'clientId', 'Client id');
  const buildingId = parseUuidQuery(
    query.buildingId,
    'buildingId',
    'Building id',
  );
  const meterId = parseUuidQuery(query.meterId, 'meterId', 'Meter id');
  const tenantCompanyId = parseUuidQuery(
    query.tenantCompanyId,
    'tenantCompanyId',
    'Tenant company id',
  );

  return {
    ...(clientId ? { clientId } : {}),
    ...(buildingId ? { buildingId } : {}),
    ...(meterId ? { meterId } : {}),
    ...(tenantCompanyId ? { tenantCompanyId } : {}),
  };
}

function parseDateQuery(
  raw: string | undefined,
  field: string,
): Date | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const date = new Date(raw.trim());
  if (Number.isNaN(date.getTime())) {
    fail(field, `${field} must be a valid ISO-8601 date string.`);
  }
  return date;
}

function parseUtilityTypeQuery(raw: string | undefined): UtilityType | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const value = raw.trim().toUpperCase();
  if (!(UTILITY_TYPES as readonly string[]).includes(value)) {
    fail('utilityType', `utilityType must be one of: ${UTILITY_TYPES.join(', ')}.`);
  }
  return value as UtilityType;
}

function parseMeterScopeQuery(
  raw: string | undefined,
): UtilityAggregationMeterScope | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const value = raw.trim().toUpperCase();
  if (!isUtilityAggregationMeterScope(value)) {
    fail(
      'meterScope',
      `meterScope must be one of: ${UTILITY_AGGREGATION_METER_SCOPES.join(', ')}.`,
    );
  }
  return value;
}

function parseIntervalQuery(
  raw: string | undefined,
): UtilityAggregationInterval | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const value = raw.trim().toUpperCase();
  if (!isUtilityAggregationInterval(value)) {
    fail(
      'interval',
      `interval must be one of: ${UTILITY_AGGREGATION_INTERVALS.join(', ')}.`,
    );
  }
  return value;
}

/** Reads the date / utility / hierarchy filters from the query string. */
export function parseAggregationFiltersQuery(query: {
  utilityType?: string;
  from?: string;
  to?: string;
  meterScope?: string;
  interval?: string;
}): UtilityAggregationFilters {
  const utilityType = parseUtilityTypeQuery(query.utilityType);
  const from = parseDateQuery(query.from, 'from');
  const to = parseDateQuery(query.to, 'to');
  const meterScope = parseMeterScopeQuery(query.meterScope);
  const interval = parseIntervalQuery(query.interval);

  return {
    ...(utilityType ? { utilityType } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(meterScope ? { meterScope } : {}),
    ...(interval ? { interval } : {}),
  };
}

export function parseAggregationGroupingQuery(
  raw: string | undefined,
): UtilityAggregationGrouping {
  if (raw === undefined || raw.trim() === '') {
    return 'UTILITY_TYPE';
  }
  const value = raw.trim().toUpperCase();
  if (!isUtilityAggregationGrouping(value)) {
    fail(
      'groupBy',
      `groupBy must be one of: ${UTILITY_AGGREGATION_GROUPINGS.join(', ')}.`,
    );
  }
  return value;
}
