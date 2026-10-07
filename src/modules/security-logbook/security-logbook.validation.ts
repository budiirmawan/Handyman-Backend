import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  SECURITY_LOGBOOK_CATEGORIES,
  SECURITY_LOGBOOK_STATUSES,
  type SecurityLogbookCategory,
  type SecurityLogbookListFilters,
  type SecurityLogbookStatus,
  type CreateSecurityLogbookEntryInput,
  type UpdateSecurityLogbookEntryInput,
} from './security-logbook.types';

/**
 * CR-BE-MOB-05 PART 03 — Security Logbook request validation.
 *
 * Identity and timestamps are never accepted from the client — identity is
 * resolved from the session and `recordedAt` is set by the backend. The
 * optional `shiftHandoverId` is validated as a UUID here; its existence and
 * same-Building rule are enforced in the service against the authoritative
 * `shift_handovers` row.
 */

export type ValidationDetail = {
  field: string;
  message: string;
};

const MAX_RANGE_DAYS = 366;

export function parseCreateSecurityLogbookBody(
  body: Record<string, unknown>,
): CreateSecurityLogbookEntryInput {
  const details: ValidationDetail[] = [];

  const buildingId = readRequiredUuid(body.buildingId, 'buildingId', details);
  const category = readRequiredCategory(body.category, details);
  const summary = readRequiredSummary(body.summary, details);
  const detail = readOptionalText(body.detail, 'detail', 4000, details);
  const shiftHandoverId = readOptionalUuid(
    body.shiftHandoverId,
    'shiftHandoverId',
    details,
  );

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    buildingId,
    category,
    summary,
    ...(detail === undefined ? {} : { detail }),
    ...(shiftHandoverId === undefined ? {} : { shiftHandoverId }),
  };
}

export function parseUpdateSecurityLogbookBody(
  body: Record<string, unknown>,
): UpdateSecurityLogbookEntryInput {
  const details: ValidationDetail[] = [];

  const category =
    body.category === undefined
      ? undefined
      : readRequiredCategory(body.category, details);
  const summary =
    body.summary === undefined
      ? undefined
      : readRequiredSummary(body.summary, details);
  const detail =
    body.detail === undefined
      ? undefined
      : readOptionalText(body.detail, 'detail', 4000, details);
  const status =
    body.status === undefined
      ? undefined
      : readRequiredStatus(body.status, details);
  const shiftHandoverId =
    body.shiftHandoverId === undefined
      ? undefined
      : readOptionalUuid(body.shiftHandoverId, 'shiftHandoverId', details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(category === undefined ? {} : { category }),
    ...(summary === undefined ? {} : { summary }),
    ...(detail === undefined ? {} : { detail }),
    ...(status === undefined ? {} : { status }),
    ...(shiftHandoverId === undefined ? {} : { shiftHandoverId }),
  };
}

export function parseSecurityLogbookListQuery(
  query: Record<string, unknown>,
): SecurityLogbookListFilters {
  const details: ValidationDetail[] = [];

  let status: SecurityLogbookStatus | undefined;
  const rawStatus = readSingleParam(query.status);
  if (rawStatus !== undefined && rawStatus !== '') {
    const normalized = rawStatus.trim().toUpperCase();
    if (!(SECURITY_LOGBOOK_STATUSES as readonly string[]).includes(normalized)) {
      details.push({
        field: 'status',
        message: `status must be one of: ${SECURITY_LOGBOOK_STATUSES.join(', ')}.`,
      });
    } else {
      status = normalized as SecurityLogbookStatus;
    }
  }

  let category: SecurityLogbookCategory | undefined;
  const rawCategory = readSingleParam(query.category);
  if (rawCategory !== undefined && rawCategory !== '') {
    const normalized = rawCategory.trim().toUpperCase();
    if (
      !(SECURITY_LOGBOOK_CATEGORIES as readonly string[]).includes(normalized)
    ) {
      details.push({
        field: 'category',
        message: `category must be one of: ${SECURITY_LOGBOOK_CATEGORIES.join(', ')}.`,
      });
    } else {
      category = normalized as SecurityLogbookCategory;
    }
  }

  const dateFromRaw = readSingleParam(query.dateFrom);
  const dateToRaw = readSingleParam(query.dateTo);
  const dateFrom = dateFromRaw
    ? readOptionalDate(dateFromRaw, 'dateFrom', details)
    : undefined;
  const dateTo = dateToRaw
    ? readOptionalDate(dateToRaw, 'dateTo', details)
    : undefined;

  if (dateFrom && dateTo && dateFrom > dateTo) {
    details.push({
      field: 'dateFrom',
      message: 'dateFrom must not exceed dateTo.',
    });
  }
  if (
    dateFrom &&
    dateTo &&
    (dateTo.getTime() - dateFrom.getTime()) / 86400000 > MAX_RANGE_DAYS
  ) {
    details.push({
      field: 'dateTo',
      message: `Logbook range must not exceed ${MAX_RANGE_DAYS} days.`,
    });
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(status === undefined ? {} : { status }),
    ...(category === undefined ? {} : { category }),
    ...(dateFromRaw ? { dateFrom: dateFromRaw.trim() } : {}),
    ...(dateToRaw ? { dateTo: dateToRaw.trim() } : {}),
  };
}

function readRequiredUuid(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string {
  const raw = readSingleParam(value);
  if (raw === undefined || raw === '') {
    details.push({ field, message: `${field} is required.` });
    return '';
  }
  const trimmed = raw.trim();
  if (!isValidUuid(trimmed)) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return '';
  }
  return trimmed.toLowerCase();
}

function readOptionalUuid(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    // Explicit null clears an existing binding (update) / means no binding
    // (create).
    return null;
  }
  const raw = readSingleParam(value);
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'null') {
    return null;
  }
  if (!isValidUuid(trimmed)) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return trimmed.toLowerCase();
}

function readRequiredCategory(
  value: unknown,
  details: ValidationDetail[],
): SecurityLogbookCategory {
  const raw = readSingleParam(value);
  const normalized = raw?.trim().toUpperCase();
  if (!normalized || !(SECURITY_LOGBOOK_CATEGORIES as readonly string[]).includes(normalized)) {
    details.push({
      field: 'category',
      message: `category must be one of: ${SECURITY_LOGBOOK_CATEGORIES.join(', ')}.`,
    });
    return 'GENERAL';
  }
  return normalized as SecurityLogbookCategory;
}

function readRequiredStatus(
  value: unknown,
  details: ValidationDetail[],
): SecurityLogbookStatus {
  const raw = readSingleParam(value);
  const normalized = raw?.trim().toUpperCase();
  if (!normalized || !(SECURITY_LOGBOOK_STATUSES as readonly string[]).includes(normalized)) {
    details.push({
      field: 'status',
      message: `status must be one of: ${SECURITY_LOGBOOK_STATUSES.join(', ')}.`,
    });
    return 'OPEN';
  }
  return normalized as SecurityLogbookStatus;
}

function readRequiredSummary(
  value: unknown,
  details: ValidationDetail[],
): string {
  const raw = readSingleParam(value);
  const trimmed = raw?.trim() ?? '';
  if (trimmed.length === 0) {
    details.push({ field: 'summary', message: 'summary is required.' });
    return '';
  }
  if (trimmed.length > 500) {
    details.push({ field: 'summary', message: 'summary must not exceed 500 characters.' });
    return '';
  }
  return trimmed;
}

function readOptionalText(
  value: unknown,
  field: string,
  maxLength: number,
  details: ValidationDetail[],
): string | null | undefined {
  const raw = readSingleParam(value);
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    return null;
  }
  if (trimmed.length > maxLength) {
    details.push({
      field,
      message: `${field} must not exceed ${maxLength} characters.`,
    });
    return undefined;
  }
  return trimmed;
}

function readOptionalDate(
  raw: string,
  field: string,
  details: ValidationDetail[],
): Date | undefined {
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    details.push({
      field,
      message: `${field} must be a valid ISO-8601 date or datetime.`,
    });
    return undefined;
  }
  return parsed;
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
