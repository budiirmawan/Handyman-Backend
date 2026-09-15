import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  DAILY_CLEANING_STATUSES,
  isDailyCleaningStatus,
  type DailyCleaningFilter,
  type DailyCleaningStatus,
} from './daily-cleaning.types';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type ValidationDetail = {
  field: string;
  message: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isValidDateFormat(date: string): boolean {
  if (!DATE_PATTERN.test(date)) {
    return false;
  }
  const [year, month, day] = date.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

export function parseDailyCleaningBuildingIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'buildingId', message: 'Building id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseDailyCleaningIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'id', message: 'Daily cleaning id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseDailyCleaningAreaIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'id', message: 'Cleaning area id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseDailyCleaningFilter(
  query: Record<string, unknown>,
): DailyCleaningFilter {
  const details: ValidationDetail[] = [];

  let date: string | undefined;
  if (query.date !== undefined && query.date !== null && query.date !== '') {
    if (typeof query.date !== 'string' || !isValidDateFormat(query.date.trim())) {
      details.push({
        field: 'date',
        message: 'Operational date must be a valid YYYY-MM-DD format.',
      });
    } else {
      date = query.date.trim();
    }
  }

  let cleaningAreaId: string | undefined;
  if (
    query.cleaningAreaId !== undefined &&
    query.cleaningAreaId !== null &&
    query.cleaningAreaId !== ''
  ) {
    if (
      typeof query.cleaningAreaId !== 'string' ||
      !isValidUuid(query.cleaningAreaId.trim())
    ) {
      details.push({
        field: 'cleaningAreaId',
        message: 'cleaningAreaId must be a valid UUID.',
      });
    } else {
      cleaningAreaId = query.cleaningAreaId.trim().toLowerCase();
    }
  }

  let status: DailyCleaningStatus | undefined;
  if (query.status !== undefined && query.status !== null && query.status !== '') {
    if (!isDailyCleaningStatus(query.status)) {
      details.push({
        field: 'status',
        message: `Status must be one of: ${DAILY_CLEANING_STATUSES.join(', ')}.`,
      });
    } else {
      status = query.status;
    }
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(date !== undefined ? { date } : {}),
    ...(cleaningAreaId !== undefined ? { cleaningAreaId } : {}),
    ...(status !== undefined ? { status } : {}),
  };
}
