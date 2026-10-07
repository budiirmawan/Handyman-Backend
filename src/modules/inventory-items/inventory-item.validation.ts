import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  INVENTORY_ITEM_STATUSES,
  INVENTORY_ITEM_TYPES,
  isInventoryItemStatus,
  isInventoryItemType,
  type InventoryItemStatus,
  type InventoryItemType,
  type CreateInventoryItemInput,
  type UpdateInventoryItemInput,
  type UpdateInventoryItemStatusInput,
} from './inventory-item.types';

const ITEM_CODE_PATTERN = /^[A-Z][A-Z0-9_-]*$/;
const MAX_CODE_LENGTH = 64;
const MAX_NAME_LENGTH = 160;
const MAX_CATEGORY_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 512;

export type ValidationDetail = {
  field: string;
  message: string;
};

export function normalizeInventoryItemCode(code: string): string {
  return code.trim().toUpperCase();
}

export function isValidInventoryItemCode(code: string): boolean {
  return (
    code.length >= 2 &&
    code.length <= MAX_CODE_LENGTH &&
    ITEM_CODE_PATTERN.test(code)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseInventoryItemIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'id', message: 'Inventory item id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseInventoryItemClientIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'clientId', message: 'Client id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseInventoryItemUomIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'uomId', message: 'UOM id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseCreateInventoryItemBody(
  body: unknown,
): Omit<CreateInventoryItemInput, 'clientId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const code = readCode(body.code, details);
  const name = readName(body.name, details);
  const itemType = readItemType(body.itemType, details);
  const category = readOptionalCategory(body.category, details);
  const uomId = readOptionalUomId(body.uomId, details);
  const description = readOptionalDescription(body.description, details);
  const status = readStatus(body.status, details);

  if (!code || !name || !itemType || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    code,
    name,
    itemType,
    ...(category === undefined ? {} : { category }),
    ...(uomId === undefined ? {} : { uomId }),
    ...(description === undefined ? {} : { description }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateInventoryItemBody(body: unknown): UpdateInventoryItemInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const name =
    body.name === undefined ? undefined : readName(body.name, details);
  const itemType =
    body.itemType === undefined ? undefined : readItemType(body.itemType, details);
  const category =
    body.category === undefined ? undefined : readNullableCategory(body.category, details);
  const uomId =
    body.uomId === undefined ? undefined : readNullableUomId(body.uomId, details);
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
    ...(itemType === undefined ? {} : { itemType }),
    ...(category === undefined ? {} : { category }),
    ...(uomId === undefined ? {} : { uomId }),
    ...(description === undefined ? {} : { description }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateInventoryItemStatusBody(body: unknown): UpdateInventoryItemStatusInput {
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
    details.push({ field: 'code', message: 'Item code is required.' });
    return undefined;
  }
  const normalized = normalizeInventoryItemCode(value);
  if (!isValidInventoryItemCode(normalized)) {
    details.push({
      field: 'code',
      message:
        'Item code must start with a letter and contain only uppercase letters, digits, hyphens, and underscores (2-64 characters).',
    });
    return undefined;
  }
  return normalized;
}

function readName(value: unknown, details: ValidationDetail[]): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'name', message: 'Item name is required.' });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    details.push({ field: 'name', message: 'Item name is required.' });
    return undefined;
  }
  if (trimmed.length > MAX_NAME_LENGTH) {
    details.push({
      field: 'name',
      message: `Item name must be at most ${MAX_NAME_LENGTH} characters.`,
    });
    return undefined;
  }
  return trimmed;
}

function readItemType(
  value: unknown,
  details: ValidationDetail[],
): InventoryItemType | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'itemType', message: 'Item type is required.' });
    return undefined;
  }
  const normalized = value.trim().toUpperCase();
  if (!isInventoryItemType(normalized)) {
    details.push({
      field: 'itemType',
      message: `Item type must be one of: ${INVENTORY_ITEM_TYPES.join(', ')}.`,
    });
    return undefined;
  }
  return normalized;
}

function readOptionalCategory(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    details.push({ field: 'category', message: 'Category must be a string.' });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return undefined;
  }
  if (trimmed.length > MAX_CATEGORY_LENGTH) {
    details.push({
      field: 'category',
      message: `Category must be at most ${MAX_CATEGORY_LENGTH} characters.`,
    });
    return undefined;
  }
  return trimmed.toUpperCase();
}

function readNullableCategory(
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
    details.push({ field: 'category', message: 'Category must be a string or null.' });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  if (trimmed.length > MAX_CATEGORY_LENGTH) {
    details.push({
      field: 'category',
      message: `Category must be at most ${MAX_CATEGORY_LENGTH} characters.`,
    });
    return undefined;
  }
  return trimmed.toUpperCase();
}

function readOptionalUomId(
  value: unknown,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string') {
    details.push({ field: 'uomId', message: 'UOM id must be a valid UUID.' });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return undefined;
  }
  if (!isValidUuid(trimmed)) {
    details.push({ field: 'uomId', message: 'UOM id must be a valid UUID.' });
    return undefined;
  }
  return trimmed.toLowerCase();
}

function readNullableUomId(
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
    details.push({ field: 'uomId', message: 'UOM id must be a valid UUID or null.' });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  if (!isValidUuid(trimmed)) {
    details.push({ field: 'uomId', message: 'UOM id must be a valid UUID or null.' });
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
    details.push({ field: 'description', message: 'Description must be a string.' });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return undefined;
  }
  if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
    details.push({
      field: 'description',
      message: `Description must be at most ${MAX_DESCRIPTION_LENGTH} characters.`,
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
    details.push({
      field: 'description',
      message: 'Description must be a string or null.',
    });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
    details.push({
      field: 'description',
      message: `Description must be at most ${MAX_DESCRIPTION_LENGTH} characters.`,
    });
    return undefined;
  }
  return trimmed;
}

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): InventoryItemStatus | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isInventoryItemStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${INVENTORY_ITEM_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

function readRequiredStatus(value: unknown): InventoryItemStatus {
  if (!isInventoryItemStatus(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'status',
        message: `Status must be one of: ${INVENTORY_ITEM_STATUSES.join(', ')}.`,
      },
    ]);
  }
  return value;
}
