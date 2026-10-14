import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  parseHandymanServiceRequestListQuery,
} from '../handyman-api/handyman-api.validation';
import { HANDYMAN_MATERIAL_PURCHASE_STATUSES } from '../handyman-material-purchasing';
import {
  HANDYMAN_SCOPE_VARIATION_STATUSES,
} from '../handyman-scope-variations';
import type { HandymanServiceRequestListFilters } from '../handyman-requests';
import {
  HANDYMAN_COMMERCIAL_INBOX_RECORD_TYPES,
  HANDYMAN_COMMERCIAL_INBOX_RESPONSIBLE_PERSONAS,
  type HandymanCommercialInboxQuery,
} from './handyman-operations-commercial-inbox.types';
import { handymanOperationsCommercialInboxCodec } from './handyman-operations-commercial-inbox.service';

export type HandymanOperationsQueueQuery = {
  filters: HandymanServiceRequestListFilters;
  limit: number;
  offset: number;
};

function readPageNumber(
  value: unknown,
  field: 'limit' | 'offset',
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value)
      ? Number(value)
      : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw AppError.validation('Request query validation failed.', [
      {
        field,
        message: `${field} must be an integer between ${minimum} and ${maximum}.`,
      },
    ]);
  }
  return parsed;
}

/**
 * Reuses the established Client-scoped Handyman request filters and adds only
 * bounded pagination. The existing request parser remains the authority for
 * Client, tenant, Building, space, attribution and lifecycle-status inputs.
 */
export function parseHandymanOperationsQueueQuery(
  query: unknown,
): HandymanOperationsQueueQuery {
  const filters = parseHandymanServiceRequestListQuery(query);
  const source = typeof query === 'object' && query !== null && !Array.isArray(query)
    ? query as Record<string, unknown>
    : {};
  return {
    filters,
    limit: readPageNumber(source.limit, 'limit', 20, 1, 50),
    offset: readPageNumber(source.offset, 'offset', 0, 0, 10000),
  };
}

function readOptionalUuid(
  source: Record<string, unknown>,
  field: string,
  details: Array<{ field: string; message: string }>,
): string | undefined {
  const value = source[field];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !isValidUuid(value)) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return value;
}

function readOptionalEnum<T extends string>(
  source: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
  details: Array<{ field: string; message: string }>,
): T | undefined {
  const value = source[field];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    details.push({
      field,
      message: `${field} is not a recognized value.`,
    });
    return undefined;
  }
  return value as T;
}

function readOptionalTimestamp(
  source: Record<string, unknown>,
  field: string,
  details: Array<{ field: string; message: string }>,
): Date | undefined {
  const value = source[field];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    details.push({
      field,
      message: `${field} must be an ISO-8601 timestamp.`,
    });
    return undefined;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    details.push({
      field,
      message: `${field} must be an ISO-8601 timestamp.`,
    });
    return undefined;
  }
  return parsed;
}

/**
 * CR-HM-OPS-INBOX-BE-01 P0-B — commercial inbox query contract.
 *
 * Filters (all validated against existing repository-native vocabularies):
 *   clientId (required), buildingId, tenantCompanyId, recordType, status
 *   (any actual Variation/Material Purchasing status), responsible persona,
 *   createdFrom/createdTo (authoritative record timestamps), includeCounts,
 *   limit and the opaque keyset `cursor`.
 */
export function parseHandymanOperationsCommercialInboxQuery(
  query: unknown,
): HandymanCommercialInboxQuery {
  const source = typeof query === 'object' && query !== null && !Array.isArray(query)
    ? query as Record<string, unknown>
    : {};
  const details: Array<{ field: string; message: string }> = [];

  const clientId = readOptionalUuid(source, 'clientId', details);
  if (!clientId) {
    details.push({ field: 'clientId', message: 'clientId is required.' });
  }
  const buildingId = readOptionalUuid(source, 'buildingId', details);
  const tenantCompanyId = readOptionalUuid(source, 'tenantCompanyId', details);
  const recordType = readOptionalEnum(
    source,
    'recordType',
    HANDYMAN_COMMERCIAL_INBOX_RECORD_TYPES,
    details,
  );

  let status: HandymanCommercialInboxQuery['status'] | undefined;
  const rawStatus = source.status;
  if (rawStatus !== undefined && rawStatus !== null && rawStatus !== '') {
    if (
      typeof rawStatus !== 'string' ||
      !((HANDYMAN_SCOPE_VARIATION_STATUSES as readonly string[]).includes(rawStatus) ||
        (HANDYMAN_MATERIAL_PURCHASE_STATUSES as readonly string[]).includes(rawStatus))
    ) {
      details.push({
        field: 'status',
        message:
          'status is not a recognized repository-native commercial status.',
      });
    } else {
      status = rawStatus as HandymanCommercialInboxQuery['status'];
    }
  }

  const responsible = readOptionalEnum(
    source,
    'responsible',
    HANDYMAN_COMMERCIAL_INBOX_RESPONSIBLE_PERSONAS,
    details,
  );
  const createdFrom = readOptionalTimestamp(source, 'createdFrom', details);
  const createdTo = readOptionalTimestamp(source, 'createdTo', details);
  if (
    createdFrom !== undefined &&
    createdTo !== undefined &&
    createdFrom.getTime() > createdTo.getTime()
  ) {
    details.push({
      field: 'createdFrom',
      message: 'createdFrom must not be later than createdTo.',
    });
  }

  const includeCounts = source.includeCounts === true || source.includeCounts === 'true';

  let cursor: HandymanCommercialInboxQuery['cursor'];
  const rawCursor = source.cursor;
  if (rawCursor !== undefined && rawCursor !== null && rawCursor !== '') {
    if (typeof rawCursor !== 'string') {
      details.push({
        field: 'cursor',
        message: 'cursor must be a continuation token string.',
      });
    } else {
      cursor = handymanOperationsCommercialInboxCodec.decodeCursor(rawCursor);
    }
  }

  if (details.length) {
    throw AppError.validation(
      'Commercial inbox query validation failed.',
      details,
    );
  }

  return {
    clientId: clientId as string,
    ...(buildingId ? { buildingId } : {}),
    ...(tenantCompanyId ? { tenantCompanyId } : {}),
    ...(recordType ? { recordType } : {}),
    ...(status ? { status } : {}),
    ...(responsible ? { responsible } : {}),
    ...(createdFrom ? { createdFrom } : {}),
    ...(createdTo ? { createdTo } : {}),
    includeCounts,
    limit: readPageNumber(source.limit, 'limit', 20, 1, 100),
    ...(cursor ? { cursor } : {}),
  };
}
