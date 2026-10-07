import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import type { WorkOrderHistoryFilters } from './work-order-history.types';

export type ValidationDetail = {
  field: string;
  message: string;
};

export function parseWorkOrderIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'workOrderId',
        message: 'Work order id must be a valid UUID.',
      },
    ]);
  }
  return value.toLowerCase();
}

/** Optional safe filters: `eventType`, `from`, `to` (ISO date/timestamps). */
export function parseHistoryFilters(query: unknown): WorkOrderHistoryFilters {
  if (typeof query !== 'object' || query === null) {
    return {};
  }
  const q = query as Record<string, unknown>;

  const details: ValidationDetail[] = [];
  const eventType = readOptionalString(q.eventType, 'eventType', 64, details);
  const from = readDate(q.from, 'from', details);
  const to = readDate(q.to, 'to', details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(eventType === undefined ? {} : { eventType }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
  };
}

function readOptionalString(
  value: unknown,
  field: string,
  maxLength: number,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const raw = Array.isArray(value) ? '' : String(value).trim();
  if (raw === '') {
    return undefined;
  }
  if (raw.length > maxLength) {
    details.push({
      field,
      message: `${field} must be at most ${maxLength} characters.`,
    });
    return undefined;
  }
  return raw;
}

function readDate(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const raw = Array.isArray(value) ? '' : String(value).trim();
  if (raw === '') {
    return undefined;
  }
  if (Number.isNaN(Date.parse(raw))) {
    details.push({ field, message: `${field} must be a valid date.` });
    return undefined;
  }
  return new Date(raw).toISOString();
}
