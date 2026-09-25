import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  MOBILE_MATERIAL_REQUEST_BODY_FIELDS,
  MOBILE_MATERIAL_REQUEST_DERIVED_FIELDS,
  MOBILE_MATERIAL_USAGE_BODY_FIELDS,
  MOBILE_MATERIAL_USAGE_DERIVED_FIELDS,
  type MobileMaterialRequestInput,
  type MobileMaterialUsageInput,
} from './mobile-material-request.types';

const MAX_NOTES_LENGTH = 1000; // BE-17B bound

type ValidationDetail = { field: string; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(details: ValidationDetail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

/**
 * Strict field CREATE body: `{ itemId, quantity, uomId, notes? }`.
 *
 * Unknown keys are rejected (authority fields with an explicit reason), so a
 * client can never smuggle procurement / approval / scope facts.
 */
export function parseMobileMaterialRequestBody(
  body: unknown,
): MobileMaterialRequestInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const allowed = new Set<string>(MOBILE_MATERIAL_REQUEST_BODY_FIELDS);
  const rejected: ValidationDetail[] = [];
  for (const key of Object.keys(body)) {
    if (allowed.has(key)) continue;
    rejected.push({
      field: key,
      message:
        MOBILE_MATERIAL_REQUEST_DERIVED_FIELDS[key] ??
        `${key} is not accepted by this command.`,
    });
  }
  if (rejected.length > 0) fail(rejected);

  const details: ValidationDetail[] = [];

  let itemId: string | undefined;
  if (typeof body.itemId !== 'string' || !isValidUuid(body.itemId.trim())) {
    details.push({ field: 'itemId', message: 'itemId must be a valid UUID.' });
  } else {
    itemId = body.itemId.trim().toLowerCase();
  }

  let quantity: number | undefined;
  if (
    typeof body.quantity !== 'number' ||
    !Number.isFinite(body.quantity) ||
    body.quantity <= 0
  ) {
    details.push({ field: 'quantity', message: 'Quantity must be a positive number.' });
  } else {
    quantity = body.quantity;
  }

  let uomId: string | null | undefined;
  if (body.uomId === undefined) {
    details.push({ field: 'uomId', message: 'uomId is required (null only for a UOM-less item).' });
  } else if (body.uomId === null) {
    uomId = null;
  } else if (typeof body.uomId !== 'string' || !isValidUuid(body.uomId.trim())) {
    details.push({ field: 'uomId', message: 'uomId must be a valid UUID or null.' });
  } else {
    uomId = body.uomId.trim().toLowerCase();
  }

  let notes: string | undefined;
  if (body.notes !== undefined && body.notes !== null) {
    if (typeof body.notes !== 'string') {
      details.push({ field: 'notes', message: 'notes must be a string.' });
    } else {
      const trimmed = body.notes.trim();
      if (trimmed.length > MAX_NOTES_LENGTH) {
        details.push({
          field: 'notes',
          message: `notes must be at most ${MAX_NOTES_LENGTH} characters.`,
        });
      } else if (trimmed.length > 0) {
        notes = trimmed;
      }
    }
  }

  if (details.length > 0 || !itemId || quantity === undefined || uomId === undefined) {
    fail(details);
  }

  return { itemId, quantity, uomId, ...(notes === undefined ? {} : { notes }) };
}

/**
 * PART 03 — strict field USAGE body: `{ materialRequestId, reservationId?,
 * quantity, notes? }`. Warehouse / item / UOM / actor / cost / reference are
 * server-derived and explicitly rejected.
 */
export function parseMobileMaterialUsageBody(body: unknown): MobileMaterialUsageInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const allowed = new Set<string>(MOBILE_MATERIAL_USAGE_BODY_FIELDS);
  const rejected: ValidationDetail[] = [];
  for (const key of Object.keys(body)) {
    if (allowed.has(key)) continue;
    rejected.push({
      field: key,
      message:
        MOBILE_MATERIAL_USAGE_DERIVED_FIELDS[key] ?? `${key} is not accepted by this command.`,
    });
  }
  if (rejected.length > 0) fail(rejected);

  const details: ValidationDetail[] = [];

  let materialRequestId: string | undefined;
  if (typeof body.materialRequestId !== 'string' || !isValidUuid(body.materialRequestId.trim())) {
    details.push({ field: 'materialRequestId', message: 'materialRequestId must be a valid UUID.' });
  } else {
    materialRequestId = body.materialRequestId.trim().toLowerCase();
  }

  let reservationId: string | undefined;
  if (body.reservationId !== undefined && body.reservationId !== null) {
    if (typeof body.reservationId !== 'string' || !isValidUuid(body.reservationId.trim())) {
      details.push({ field: 'reservationId', message: 'reservationId must be a valid UUID.' });
    } else {
      reservationId = body.reservationId.trim().toLowerCase();
    }
  }

  let quantity: number | undefined;
  if (
    typeof body.quantity !== 'number' ||
    !Number.isFinite(body.quantity) ||
    body.quantity <= 0
  ) {
    details.push({ field: 'quantity', message: 'Quantity must be a positive number.' });
  } else {
    quantity = body.quantity;
  }

  let notes: string | undefined;
  if (body.notes !== undefined && body.notes !== null) {
    if (typeof body.notes !== 'string') {
      details.push({ field: 'notes', message: 'notes must be a string.' });
    } else {
      const trimmed = body.notes.trim();
      if (trimmed.length > MAX_NOTES_LENGTH) {
        details.push({ field: 'notes', message: `notes must be at most ${MAX_NOTES_LENGTH} characters.` });
      } else if (trimmed.length > 0) {
        notes = trimmed;
      }
    }
  }

  if (details.length > 0 || !materialRequestId || quantity === undefined) {
    fail(details);
  }

  return {
    materialRequestId,
    quantity,
    ...(reservationId === undefined ? {} : { reservationId }),
    ...(notes === undefined ? {} : { notes }),
  };
}
