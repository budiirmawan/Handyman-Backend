import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

type ValidationDetail = { field: string; message: string };

export type ManagementBuildingOperationalFinanceQuery = {
  buildingId: string;
  periodStart: string;
  periodEnd: string;
};

export function parseManagementBuildingOperationalFinanceQuery(
  rawBuildingId: string,
  query: Record<string, unknown>,
): ManagementBuildingOperationalFinanceQuery {
  const details: ValidationDetail[] = [];
  const buildingId = rawBuildingId.trim().toLowerCase();
  if (!isValidUuid(buildingId)) {
    details.push({ field: 'buildingId', message: 'buildingId must be a valid UUID.' });
  }

  const periodStart = readRequiredDate(query.periodStart, 'periodStart', details);
  const periodEnd = readRequiredDate(query.periodEnd, 'periodEnd', details);
  if (periodStart && periodEnd && periodEnd < periodStart) {
    details.push({
      field: 'periodEnd',
      message: 'periodEnd must be the same as or after periodStart.',
    });
  }

  if (details.length) {
    throw AppError.validation('Request validation failed.', details);
  }

  return { buildingId, periodStart: periodStart!, periodEnd: periodEnd! };
}

function readRequiredDate(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value) || !isCalendarDate(value)) {
    details.push({ field, message: `${field} must be a valid YYYY-MM-DD date.` });
    return undefined;
  }
  return value;
}

function isCalendarDate(value: string): boolean {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}
