import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import type { ClockInInput } from './attendance.types';

/**
 * CR-BE-MOB-05 PART 02 — Attendance request validation.
 *
 * Clock-in accepts exactly one field: the authoritative `buildingId` (the
 * Building the authenticated profile is clocking into). Identity and
 * timestamps are never accepted from the client — the identity is resolved
 * from the session and the timestamps are set by the backend.
 */

export type ValidationDetail = {
  field: string;
  message: string;
};

export function parseClockInBody(body: Record<string, unknown>): ClockInInput {
  const details: ValidationDetail[] = [];

  const buildingId = readRequiredUuid(body.buildingId, 'buildingId', details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return { buildingId };
}

function readRequiredUuid(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string {
  if (value === undefined || value === null || value === '') {
    details.push({ field, message: `${field} is required.` });
    return '';
  }
  const raw = Array.isArray(value) ? undefined : String(value);
  if (raw === undefined) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return '';
  }
  const trimmed = raw.trim();
  if (!isValidUuid(trimmed)) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return '';
  }
  return trimmed.toLowerCase();
}
