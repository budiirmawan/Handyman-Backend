import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  isAssetHistoryEventType,
  type AssetHistoryListFilters,
} from './asset-history.types';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export type ValidationDetail = {
  field: string;
  message: string;
};

export function parseHistoryAssetIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'assetId', message: 'Asset id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

/**
 * `?eventType=`, `?limit=`, `?offset=` — mirroring the BE-01H audit list
 * convention so history pagination behaves like every other paged read.
 */
export function parseAssetHistoryQuery(
  query: Record<string, unknown>,
): AssetHistoryListFilters {
  const details: ValidationDetail[] = [];

  const eventTypeRaw = readSingleParam(query.eventType);
  let eventType: string | undefined;
  if (eventTypeRaw !== undefined && eventTypeRaw !== '') {
    const normalized = eventTypeRaw.trim().toUpperCase();
    if (!isAssetHistoryEventType(normalized)) {
      details.push({
        field: 'eventType',
        message: 'eventType is not a known asset history event type.',
      });
    } else {
      eventType = normalized;
    }
  }

  const limit = readInt(query.limit, 'limit', DEFAULT_LIMIT, 1, MAX_LIMIT, details);
  const offset = readInt(
    query.offset,
    'offset',
    0,
    0,
    Number.MAX_SAFE_INTEGER,
    details,
  );

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(eventType === undefined ? {} : { eventType }),
    limit,
    offset,
  };
}

function readSingleParam(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return undefined;
  }
  return String(value);
}

function readInt(
  value: unknown,
  field: string,
  fallback: number,
  min: number,
  max: number,
  details: ValidationDetail[],
): number {
  const raw = readSingleParam(value);
  if (raw === undefined || raw === '') {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    details.push({
      field,
      message: `${field} must be an integer between ${min} and ${max}.`,
    });
    return fallback;
  }

  return parsed;
}
