import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  WORK_CONTRACT_STATUSES,
  isWorkContractStatus,
  type CreateWorkContractInput,
  type UpdateWorkContractInput,
  type WorkContractFilters,
  type WorkContractStatus,
} from './work-contract.types';

type Detail = { field: string; message: string };
export type ValidationDetail = Detail;

/**
 * SPK identity foundation. Same shape as the PO number pattern so commercial
 * documents share one numbering vocabulary; normalized uppercase and unique
 * per Client at the database level.
 */
const SPK_NUMBER_PATTERN = /^[A-Z0-9][A-Z0-9_\-/]{1,63}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TITLE_LENGTH = 255;
const MAX_SCOPE_LENGTH = 4000;
const MAX_NOTES_LENGTH = 2000;

/**
 * Inherited scope and lifecycle provenance may never be supplied by the
 * caller — accepting any of it would create a scope-widening side channel
 * around BE-02 isolation, or let a client forge lifecycle history.
 */
const DERIVED_FIELDS = [
  'clientId',
  'buildingId',
  'vendorId',
  'status',
  'activatedAt',
  'activatedByUserId',
  'completedAt',
  'completedByUserId',
  'cancelledAt',
  'cancelledByUserId',
  'createdByUserId',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(details: Detail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

function parseId(raw: string, field: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) {
    fail([{ field, message: `${field} must be a valid UUID.` }]);
  }
  return value;
}

export const parseWorkContractIdParam = (raw: string): string =>
  parseId(raw, 'workContractId');

export function parseCreateWorkContractBody(
  body: unknown,
): CreateWorkContractInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const details: Detail[] = [];

  // The Purchase Order reference is the ONLY context input: Client, Building
  // and Vendor are inherited from it.
  const purchaseOrderId = readId(
    body.purchaseOrderId,
    'purchaseOrderId',
    true,
    details,
  );
  const spkNumber = readSpkNumber(body.spkNumber, details);
  const spkDate = readDate(body.spkDate, 'spkDate', true, details);
  const title = readRequiredString(
    body.title,
    'title',
    MAX_TITLE_LENGTH,
    details,
  );
  const scopeDescription = readString(
    body.scopeDescription,
    'scopeDescription',
    MAX_SCOPE_LENGTH,
    details,
  );
  const startDate = readNullableDate(body.startDate, 'startDate', details);
  const endDate = readNullableDate(body.endDate, 'endDate', details);
  const notes = readString(body.notes, 'notes', MAX_NOTES_LENGTH, details);

  const derived = DERIVED_FIELDS.find((field) => body[field] !== undefined);
  if (derived) {
    details.push({
      field: derived,
      message:
        'This field is inherited from the Purchase Order and must not be supplied.',
    });
  }

  if (startDate && endDate && endDate < startDate) {
    details.push({
      field: 'endDate',
      message: 'endDate must be the same as or after startDate.',
    });
  }

  if (!purchaseOrderId || !spkNumber || !spkDate || !title || details.length) {
    fail(details);
  }

  return {
    purchaseOrderId,
    spkNumber,
    spkDate,
    title,
    ...(scopeDescription !== undefined ? { scopeDescription } : {}),
    ...(startDate !== undefined ? { startDate } : {}),
    ...(endDate !== undefined ? { endDate } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };
}

export function parseUpdateWorkContractBody(
  body: unknown,
): UpdateWorkContractInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  // A mandate is never silently re-pointed at another Purchase Order, vendor
  // or building, and its identity never changes.
  const immutable = [...DERIVED_FIELDS, 'purchaseOrderId', 'spkNumber'].find(
    (field) => body[field] !== undefined,
  );
  if (immutable) {
    fail([
      { field: immutable, message: 'This Work Contract field is immutable.' },
    ]);
  }

  const details: Detail[] = [];
  const spkDate =
    body.spkDate === undefined
      ? undefined
      : readDate(body.spkDate, 'spkDate', true, details);
  const title =
    body.title === undefined
      ? undefined
      : readRequiredString(body.title, 'title', MAX_TITLE_LENGTH, details);
  const scopeDescription =
    body.scopeDescription === undefined
      ? undefined
      : readString(
          body.scopeDescription,
          'scopeDescription',
          MAX_SCOPE_LENGTH,
          details,
        );
  const startDate =
    body.startDate === undefined
      ? undefined
      : readNullableDate(body.startDate, 'startDate', details);
  const endDate =
    body.endDate === undefined
      ? undefined
      : readNullableDate(body.endDate, 'endDate', details);
  const notes =
    body.notes === undefined
      ? undefined
      : readString(body.notes, 'notes', MAX_NOTES_LENGTH, details);

  if (startDate && endDate && endDate < startDate) {
    details.push({
      field: 'endDate',
      message: 'endDate must be the same as or after startDate.',
    });
  }

  const result: UpdateWorkContractInput = {
    ...(spkDate !== undefined ? { spkDate } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(scopeDescription !== undefined ? { scopeDescription } : {}),
    ...(startDate !== undefined ? { startDate } : {}),
    ...(endDate !== undefined ? { endDate } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };

  if (Object.keys(result).length === 0) {
    details.push({
      field: 'body',
      message: 'At least one draft field is required.',
    });
  }
  if (details.length) fail(details);
  return result;
}

export function parseWorkContractFilters(query: unknown): WorkContractFilters {
  if (!isRecord(query)) return {};
  const details: Detail[] = [];
  const purchaseOrderId = readId(
    query.purchaseOrderId,
    'purchaseOrderId',
    false,
    details,
  );
  const vendorId = readId(query.vendorId, 'vendorId', false, details);
  const buildingId = readId(query.buildingId, 'buildingId', false, details);
  const status = readStatus(query.status, details);
  const spkDateFrom = readDate(
    query.spkDateFrom,
    'spkDateFrom',
    false,
    details,
  );
  const spkDateTo = readDate(query.spkDateTo, 'spkDateTo', false, details);

  if (spkDateFrom && spkDateTo && spkDateTo < spkDateFrom) {
    details.push({
      field: 'spkDateTo',
      message: 'spkDateTo must be the same as or after spkDateFrom.',
    });
  }
  if (details.length) fail(details);

  return {
    ...(purchaseOrderId ? { purchaseOrderId } : {}),
    ...(vendorId ? { vendorId } : {}),
    ...(buildingId ? { buildingId } : {}),
    ...(status ? { status } : {}),
    ...(spkDateFrom ? { spkDateFrom } : {}),
    ...(spkDateTo ? { spkDateTo } : {}),
  };
}

function readId(
  value: unknown,
  field: string,
  required: boolean,
  details: Detail[],
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({
      field,
      message: `${field} ${required ? 'is required and ' : ''}must be a valid UUID.`,
    });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readSpkNumber(value: unknown, details: Detail[]): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'spkNumber', message: 'spkNumber is required.' });
    return undefined;
  }
  const normalized = value.trim().toUpperCase();
  if (!SPK_NUMBER_PATTERN.test(normalized)) {
    details.push({
      field: 'spkNumber',
      message: 'spkNumber has an invalid format.',
    });
    return undefined;
  }
  return normalized;
}

function readDate(
  value: unknown,
  field: string,
  required: boolean,
  details: Detail[],
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (
    typeof value !== 'string' ||
    !DATE_PATTERN.test(value) ||
    !isCalendarDate(value)
  ) {
    details.push({
      field,
      message: `${field} ${required ? 'is required and ' : ''}must be a valid YYYY-MM-DD date.`,
    });
    return undefined;
  }
  return value;
}

function readNullableDate(
  value: unknown,
  field: string,
  details: Detail[],
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return readDate(value, field, true, details);
}

function isCalendarDate(value: string): boolean {
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

function readRequiredString(
  value: unknown,
  field: string,
  max: number,
  details: Detail[],
): string | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    details.push({ field, message: `${field} is required.` });
    return undefined;
  }
  const result = value.trim();
  if (result.length > max) {
    details.push({
      field,
      message: `${field} must be at most ${max} characters.`,
    });
    return undefined;
  }
  return result;
}

function readString(
  value: unknown,
  field: string,
  max: number,
  details: Detail[],
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be a string.` });
    return undefined;
  }
  const result = value.trim();
  if (!result) return null;
  if (result.length > max) {
    details.push({
      field,
      message: `${field} must be at most ${max} characters.`,
    });
    return undefined;
  }
  return result;
}

function readStatus(
  value: unknown,
  details: Detail[],
): WorkContractStatus | undefined {
  if (value === undefined) return undefined;
  if (!isWorkContractStatus(value)) {
    details.push({
      field: 'status',
      message: `status must be one of: ${WORK_CONTRACT_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}
