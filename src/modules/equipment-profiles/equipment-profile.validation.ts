import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  EQUIPMENT_PROFILE_STATUSES,
  isEquipmentProfileStatus,
  type CreateEquipmentProfileInput,
  type EquipmentProfileStatus,
  type UpdateEquipmentProfileInput,
  type UpdateEquipmentProfileStatusInput,
} from './equipment-profile.types';

/**
 * Equipment codes are the stable machine-readable technical identifier
 * (e.g. `EQP-AHU-01`). Normalized to uppercase, matching every other code in
 * the system: start with a letter; letters, digits, hyphens, underscores.
 */
const EQUIPMENT_CODE_PATTERN = /^[A-Z][A-Z0-9_-]*$/;
/** Calendar date, not an instant: installation / commissioning are days. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const MAX_CODE_LENGTH = 64;
const MAX_NAME_LENGTH = 160;
const MAX_MANUFACTURER_LENGTH = 120;
const MAX_MODEL_LENGTH = 120;
const MAX_SERIAL_NUMBER_LENGTH = 120;
const MAX_SPECIFICATION_LENGTH = 2048;
const MAX_UNIT_OF_MEASURE_LENGTH = 32;
/** Matches NUMERIC(18, 4): 14 integer digits, 4 decimal places. */
const MAX_CAPACITY = 99_999_999_999_999.9999;

export type ValidationDetail = {
  field: string;
  message: string;
};

export function normalizeEquipmentCode(code: string): string {
  return code.trim().toUpperCase();
}

export function isValidEquipmentCode(code: string): boolean {
  return (
    code.length >= 2 &&
    code.length <= MAX_CODE_LENGTH &&
    EQUIPMENT_CODE_PATTERN.test(code)
  );
}

/** True for a real `YYYY-MM-DD` calendar date (rejects 2024-02-31). */
export function isValidCalendarDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    return false;
  }

  return date.toISOString().slice(0, 10) === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseEquipmentProfileAssetIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'assetId', message: 'Asset id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseCreateEquipmentProfileBody(
  body: unknown,
): Omit<CreateEquipmentProfileInput, 'assetId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const equipmentCode = readEquipmentCode(body.equipmentCode, details);
  const equipmentName = readEquipmentName(body.equipmentName, details);
  const manufacturer = readOptionalText(
    body.manufacturer,
    'manufacturer',
    MAX_MANUFACTURER_LENGTH,
    details,
  );
  const model = readOptionalText(body.model, 'model', MAX_MODEL_LENGTH, details);
  const serialNumber = readOptionalText(
    body.serialNumber,
    'serialNumber',
    MAX_SERIAL_NUMBER_LENGTH,
    details,
  );
  const specification = readOptionalText(
    body.specification,
    'specification',
    MAX_SPECIFICATION_LENGTH,
    details,
  );
  const capacity = readOptionalCapacity(body.capacity, details);
  const unitOfMeasure = readOptionalText(
    body.unitOfMeasure,
    'unitOfMeasure',
    MAX_UNIT_OF_MEASURE_LENGTH,
    details,
  );
  const installationDate = readOptionalDate(
    body.installationDate,
    'installationDate',
    details,
  );
  const commissioningDate = readOptionalDate(
    body.commissioningDate,
    'commissioningDate',
    details,
  );
  const status = readStatus(body.status, details);

  assertCapacityHasUnit(capacity, unitOfMeasure, details);
  assertCommissioningAfterInstallation(
    installationDate,
    commissioningDate,
    details,
  );

  if (!equipmentCode || !equipmentName || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    equipmentCode,
    equipmentName,
    ...(manufacturer === undefined ? {} : { manufacturer }),
    ...(model === undefined ? {} : { model }),
    ...(serialNumber === undefined ? {} : { serialNumber }),
    ...(specification === undefined ? {} : { specification }),
    ...(capacity === undefined ? {} : { capacity }),
    ...(unitOfMeasure === undefined ? {} : { unitOfMeasure }),
    ...(installationDate === undefined ? {} : { installationDate }),
    ...(commissioningDate === undefined ? {} : { commissioningDate }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateEquipmentProfileBody(
  body: unknown,
): UpdateEquipmentProfileInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const equipmentName =
    body.equipmentName === undefined
      ? undefined
      : readEquipmentName(body.equipmentName, details);
  const manufacturer = readNullableText(
    body.manufacturer,
    'manufacturer',
    MAX_MANUFACTURER_LENGTH,
    details,
  );
  const model = readNullableText(body.model, 'model', MAX_MODEL_LENGTH, details);
  const serialNumber = readNullableText(
    body.serialNumber,
    'serialNumber',
    MAX_SERIAL_NUMBER_LENGTH,
    details,
  );
  const specification = readNullableText(
    body.specification,
    'specification',
    MAX_SPECIFICATION_LENGTH,
    details,
  );
  const capacity = readNullableCapacity(body.capacity, details);
  const unitOfMeasure = readNullableText(
    body.unitOfMeasure,
    'unitOfMeasure',
    MAX_UNIT_OF_MEASURE_LENGTH,
    details,
  );
  const installationDate = readNullableDate(
    body.installationDate,
    'installationDate',
    details,
  );
  const commissioningDate = readNullableDate(
    body.commissioningDate,
    'commissioningDate',
    details,
  );
  const status =
    body.status === undefined ? undefined : readStatus(body.status, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(equipmentName === undefined ? {} : { equipmentName }),
    ...(manufacturer === undefined ? {} : { manufacturer }),
    ...(model === undefined ? {} : { model }),
    ...(serialNumber === undefined ? {} : { serialNumber }),
    ...(specification === undefined ? {} : { specification }),
    ...(capacity === undefined ? {} : { capacity }),
    ...(unitOfMeasure === undefined ? {} : { unitOfMeasure }),
    ...(installationDate === undefined ? {} : { installationDate }),
    ...(commissioningDate === undefined ? {} : { commissioningDate }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateEquipmentProfileStatusBody(
  body: unknown,
): UpdateEquipmentProfileStatusInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const status = readStatus(body.status, []);
  if (!status) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'status',
        message: `Status must be one of: ${EQUIPMENT_PROFILE_STATUSES.join(', ')}.`,
      },
    ]);
  }

  return { status };
}

/**
 * A capacity without its unit is meaningless, so the pair must stay
 * consistent. Mirrors the `equipment_profiles_capacity_uom_check` constraint.
 */
export function assertCapacityHasUnit(
  capacity: number | null | undefined,
  unitOfMeasure: string | null | undefined,
  details: ValidationDetail[],
): void {
  if (
    capacity !== undefined &&
    capacity !== null &&
    (unitOfMeasure === undefined || unitOfMeasure === null)
  ) {
    details.push({
      field: 'unitOfMeasure',
      message: 'unitOfMeasure is required when capacity is provided.',
    });
  }
}

/** Equipment cannot be commissioned before it is installed. */
export function assertCommissioningAfterInstallation(
  installationDate: string | null | undefined,
  commissioningDate: string | null | undefined,
  details: ValidationDetail[],
): void {
  if (
    installationDate !== undefined &&
    installationDate !== null &&
    commissioningDate !== undefined &&
    commissioningDate !== null &&
    commissioningDate < installationDate
  ) {
    details.push({
      field: 'commissioningDate',
      message: 'commissioningDate cannot be earlier than installationDate.',
    });
  }
}

function readEquipmentCode(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({
      field: 'equipmentCode',
      message: 'Equipment code is required.',
    });
    return undefined;
  }

  const normalized = normalizeEquipmentCode(value);
  if (!isValidEquipmentCode(normalized)) {
    details.push({
      field: 'equipmentCode',
      message:
        'Equipment code must start with a letter and contain only uppercase letters, digits, hyphens, and underscores (2-64 characters).',
    });
    return undefined;
  }

  return normalized;
}

function readEquipmentName(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({
      field: 'equipmentName',
      message: 'Equipment name is required.',
    });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    details.push({
      field: 'equipmentName',
      message: 'Equipment name is required.',
    });
    return undefined;
  }

  if (trimmed.length > MAX_NAME_LENGTH) {
    details.push({
      field: 'equipmentName',
      message: `Equipment name must be at most ${MAX_NAME_LENGTH} characters.`,
    });
    return undefined;
  }

  return trimmed;
}

/** Create-body optional text: omitted or null both mean "not provided". */
function readOptionalText(
  value: unknown,
  field: string,
  maxLength: number,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be a string.` });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    return undefined;
  }

  if (trimmed.length > maxLength) {
    details.push({
      field,
      message: `${field} must be at most ${maxLength} characters.`,
    });
    return undefined;
  }

  return trimmed;
}

/** Update-body text: explicit null (or empty string) clears the value. */
function readNullableText(
  value: unknown,
  field: string,
  maxLength: number,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be a string or null.` });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }

  if (trimmed.length > maxLength) {
    details.push({
      field,
      message: `${field} must be at most ${maxLength} characters.`,
    });
    return undefined;
  }

  return trimmed;
}

function isValidCapacity(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_CAPACITY
  );
}

function capacityMessage(field: string): string {
  return `${field} must be a non-negative finite number.`;
}

function readOptionalCapacity(
  value: unknown,
  details: ValidationDetail[],
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!isValidCapacity(value)) {
    details.push({ field: 'capacity', message: capacityMessage('capacity') });
    return undefined;
  }

  return value;
}

function readNullableCapacity(
  value: unknown,
  details: ValidationDetail[],
): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (!isValidCapacity(value)) {
    details.push({ field: 'capacity', message: capacityMessage('capacity') });
    return undefined;
  }

  return value;
}

function dateMessage(field: string): string {
  return `${field} must be a valid calendar date in YYYY-MM-DD format.`;
}

function readOptionalDate(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== 'string' || !isValidCalendarDate(value.trim())) {
    details.push({ field, message: dateMessage(field) });
    return undefined;
  }

  return value.trim();
}

function readNullableDate(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value !== 'string' || !isValidCalendarDate(value.trim())) {
    details.push({ field, message: dateMessage(field) });
    return undefined;
  }

  return value.trim();
}

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): EquipmentProfileStatus | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!isEquipmentProfileStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${EQUIPMENT_PROFILE_STATUSES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}
