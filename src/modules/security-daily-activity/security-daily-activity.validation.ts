import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import type { SecurityDailyActivityFilter } from './security-daily-activity.types';

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type ValidationDetail = {
  field: string;
  message: string;
};

export function parseSecurityDailyActivityQuery(
  query: Record<string, unknown>,
): SecurityDailyActivityFilter {
  const details: ValidationDetail[] = [];

  let date: string | undefined;
  if (query.date !== undefined) {
    if (
      typeof query.date !== 'string' ||
      !ISO_DATE_PATTERN.test(query.date) ||
      !isRealCalendarDate(query.date)
    ) {
      details.push({
        field: 'date',
        message: 'date must be a valid ISO date (YYYY-MM-DD).',
      });
    } else {
      date = query.date;
    }
  }

  const shiftId = readOptionalUuid(query.shiftId, 'shiftId', details);
  const securityPostId = readOptionalUuid(
    query.securityPostId,
    'securityPostId',
    details,
  );

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(date !== undefined ? { date } : {}),
    ...(shiftId !== undefined ? { shiftId } : {}),
    ...(securityPostId !== undefined ? { securityPostId } : {}),
  };
}

function isRealCalendarDate(value: string): boolean {
  const [y, m, d] = value.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return (
    probe.getUTCFullYear() === y &&
    probe.getUTCMonth() === m - 1 &&
    probe.getUTCDate() === d
  );
}

function readOptionalUuid(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return value.trim().toLowerCase();
}
