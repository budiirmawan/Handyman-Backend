import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import type { DailyOperationsQuery } from './engineering-daily-operations.types';

export type ValidationDetail = {
  field: string;
  message: string;
};

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseBuildingIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'buildingId', message: 'Building id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

/**
 * Parses `?date=` (required, strict `YYYY-MM-DD` calendar date) and the
 * optional `?shiftId=` (UUID when supplied).
 */
export function parseDailyOperationsQuery(
  query: Record<string, unknown>,
): Pick<DailyOperationsQuery, 'operationalDate' | 'shiftId'> {
  const details: ValidationDetail[] = [];

  const dateRaw = readSingleParam(query.date);
  let operationalDate: string | null = null;
  if (dateRaw === undefined || dateRaw === '') {
    details.push({
      field: 'date',
      message: 'date is required and must be a valid YYYY-MM-DD date.',
    });
  } else if (!isValidOperationalDate(dateRaw.trim())) {
    details.push({
      field: 'date',
      message: 'date must be a valid YYYY-MM-DD date.',
    });
  } else {
    operationalDate = dateRaw.trim();
  }

  const shiftIdRaw = readSingleParam(query.shiftId);
  let shiftId: string | undefined;
  if (shiftIdRaw !== undefined && shiftIdRaw !== '') {
    if (!isValidUuid(shiftIdRaw.trim())) {
      details.push({
        field: 'shiftId',
        message: 'shiftId must be a valid UUID.',
      });
    } else {
      shiftId = shiftIdRaw.trim().toLowerCase();
    }
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    operationalDate: operationalDate as string,
    ...(shiftId === undefined ? {} : { shiftId }),
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

/** Rejects impossible calendar dates (e.g. 2026-02-30). */
function isValidOperationalDate(value: string): boolean {
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
