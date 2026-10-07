import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  INVENTORY_WAREHOUSE_STATUSES,
  isInventoryWarehouseStatus,
  type InventoryWarehouseStatus,
  type CreateInventoryWarehouseInput,
  type UpdateInventoryWarehouseInput,
  type UpdateInventoryWarehouseStatusInput,
} from './inventory-warehouse.types';

const CODE_PATTERN = /^[A-Z][A-Z0-9_-]*$/;
const MAX_CODE_LENGTH = 64;
const MAX_NAME_LENGTH = 160;
const MAX_DESCRIPTION_LENGTH = 512;

export type ValidationDetail = {
  field: string;
  message: string;
};

export function normalizeWarehouseCode(code: string): string {
  return code.trim().toUpperCase();
}

export function isValidWarehouseCode(code: string): boolean {
  return (
    code.length >= 2 &&
    code.length <= MAX_CODE_LENGTH &&
    CODE_PATTERN.test(code)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseWarehouseIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'id', message: 'Warehouse id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseWarehouseBuildingIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'buildingId', message: 'Building id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseWarehouseClientIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'clientId', message: 'Client id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseCreateWarehouseBody(
  body: unknown,
): Omit<CreateInventoryWarehouseInput, 'buildingId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const code = readCode(body.code, details);
  const name = readName(body.name, details);
  const functionalLocationId = readOptionalFunctionalLocationId(
    body.functionalLocationId,
    details,
  );
  const description = readOptionalDescription(body.description, details);
  const status = readStatus(body.status, details);

  if (!code || !name || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    code,
    name,
    ...(functionalLocationId === undefined ? {} : { functionalLocationId }),
    ...(description === undefined ? {} : { description }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateWarehouseBody(body: unknown): UpdateInventoryWarehouseInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const name =
    body.name === undefined ? undefined : readName(body.name, details);
  const functionalLocationId =
    body.functionalLocationId === undefined
      ? undefined
      : readNullableFunctionalLocationId(body.functionalLocationId, details);
  const description =
    body.description === undefined
      ? undefined
      : readNullableDescription(body.description, details);
  const status =
    body.status === undefined ? undefined : readStatus(body.status, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(name === undefined ? {} : { name }),
    ...(functionalLocationId === undefined ? {} : { functionalLocationId }),
    ...(description === undefined ? {} : { description }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateWarehouseStatusBody(
  body: unknown,
): UpdateInventoryWarehouseStatusInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const status = readRequiredStatus(body.status);
  return { status };
}

function readCode(value: unknown, details: ValidationDetail[]): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'code', message: 'Warehouse code is required.' });
    return undefined;
  }
  const normalized = normalizeWarehouseCode(value);
  if (!isValidWarehouseCode(normalized)) {
    details.push({
      field: 'code',
      message:
        'Warehouse code must start with a letter and contain only uppercase letters, digits, hyphens, underscores (2-64).',
    });
    return undefined;
  }
  return normalized;
}

function readName(value: unknown, details: ValidationDetail[]): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'name', message: 'Warehouse name is required.' });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    details.push({ field: 'name', message: 'Warehouse name is required.' });
    return undefined;
  }
  if (trimmed.length > MAX_NAME_LENGTH) {
    details.push({
      field: 'name',
      message: `Warehouse name must be at most ${MAX_NAME_LENGTH} chars.`,
    });
    return undefined;
  }
  return trimmed;
}

function readOptionalFunctionalLocationId(
  value: unknown,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string') {
    details.push({
      field: 'functionalLocationId',
      message: 'functionalLocationId must be a valid UUID.',
    });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return undefined;
  }
  if (!isValidUuid(trimmed)) {
    details.push({
      field: 'functionalLocationId',
      message: 'functionalLocationId must be a valid UUID.',
    });
    return undefined;
  }
  return trimmed.toLowerCase();
}

function readNullableFunctionalLocationId(
  value: unknown,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    details.push({
      field: 'functionalLocationId',
      message: 'functionalLocationId must be a valid UUID or null.',
    });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  if (!isValidUuid(trimmed)) {
    details.push({
      field: 'functionalLocationId',
      message: 'functionalLocationId must be a valid UUID or null.',
    });
    return undefined;
  }
  return trimmed.toLowerCase();
}

function readOptionalDescription(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    details.push({ field: 'description', message: 'Description must be string.' });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return undefined;
  }
  if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
    details.push({
      field: 'description',
      message: `Description at most ${MAX_DESCRIPTION_LENGTH} chars.`,
    });
    return undefined;
  }
  return trimmed;
}

function readNullableDescription(
  value: unknown,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    details.push({ field: 'description', message: 'Description must be string or null.' });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
    details.push({
      field: 'description',
      message: `Description at most ${MAX_DESCRIPTION_LENGTH} chars.`,
    });
    return undefined;
  }
  return trimmed;
}

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): InventoryWarehouseStatus | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isInventoryWarehouseStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${INVENTORY_WAREHOUSE_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

function readRequiredStatus(value: unknown): InventoryWarehouseStatus {
  if (!isInventoryWarehouseStatus(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'status',
        message: `Status must be one of: ${INVENTORY_WAREHOUSE_STATUSES.join(', ')}.`,
      },
    ]);
  }
  return value;
}
