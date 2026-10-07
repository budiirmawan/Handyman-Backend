import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';

export type ValidationDetail = {
  field: string;
  message: string;
};

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export type OverviewQuery = {
  date: string;
  shiftId?: string;
};

/**
 * Parses the optional `?date=` (defaults to today, UTC) and optional
 * `?shiftId=` (UUID when supplied). Follows BE-10A's date conventions.
 */
export function parseOverviewQuery(
  query: Record<string, unknown>,
): OverviewQuery {
  const details: ValidationDetail[] = [];

  let date: string;
  const rawDate = readSingleParam(query.date);
  if (rawDate === undefined || rawDate === '') {
    date = new Date().toISOString().slice(0, 10);
  } else if (!isValidCalendarDate(rawDate.trim())) {
    details.push({
      field: 'date',
      message: 'date must be a valid YYYY-MM-DD date.',
    });
    date = new Date().toISOString().slice(0, 10);
  } else {
    date = rawDate.trim();
  }

  let shiftId: string | undefined;
  const rawShiftId = readSingleParam(query.shiftId);
  if (rawShiftId !== undefined && rawShiftId !== '') {
    if (!isValidUuid(rawShiftId.trim())) {
      details.push({
        field: 'shiftId',
        message: 'shiftId must be a valid UUID.',
      });
    } else {
      shiftId = rawShiftId.trim().toLowerCase();
    }
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return { date, ...(shiftId === undefined ? {} : { shiftId }) };
}

function isValidCalendarDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
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
