import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  METER_READING_BINDING_STATUSES,
  isMeterReadingBindingStatus,
  type CreateMeterReadingBindingInput,
  type MeterReadingBindingStatus,
  type UpdateMeterReadingBindingInput,
} from './meter-reading-binding.types';

export type ValidationDetail = {
  field: string;
  message: string;
};

export function parseAssetIdParam(raw: string): string {
  return parseUuidParam(raw, 'assetId', 'Asset id');
}

export function parseBuildingIdParam(raw: string): string {
  return parseUuidParam(raw, 'buildingId', 'Building id');
}

export function parseBindingIdParam(raw: string): string {
  return parseUuidParam(raw, 'id', 'Meter reading binding id');
}

export function parseExecutionIdParam(raw: string): string {
  return parseUuidParam(raw, 'id', 'Meter reading execution id');
}

function parseUuidParam(raw: string, field: string, label: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${label} must be a valid UUID.` },
    ]);
  }
  return value.toLowerCase();
}

export function parseCreateMeterReadingBindingBody(
  body: Record<string, unknown>,
): Pick<
  CreateMeterReadingBindingInput,
  'formFieldId' | 'uomId' | 'functionalLocationId' | 'minimumValue' | 'maximumValue' | 'status'
> {
  const details: ValidationDetail[] = [];

  const formFieldId = readOptionalUuid(
    body.formFieldId,
    'formFieldId',
    'Form field id',
    details,
  );
  if (formFieldId === undefined) {
    details.push({
      field: 'formFieldId',
      message: 'formFieldId is required and must be a valid UUID.',
    });
  }

  const uomId = readOptionalUuid(body.uomId, 'uomId', 'UOM id', details);
  const functionalLocationId = readOptionalNullableUuid(
    body.functionalLocationId,
    'functionalLocationId',
    'Functional location id',
    details,
  );

  const minimumValue = readOptionalNumber(
    body.minimumValue,
    'minimumValue',
    details,
  );
  const maximumValue = readOptionalNumber(
    body.maximumValue,
    'maximumValue',
    details,
  );
  if (
    minimumValue !== undefined &&
    maximumValue !== undefined &&
    minimumValue > maximumValue
  ) {
    details.push({
      field: 'minimumValue',
      message: 'minimumValue must not exceed maximumValue.',
    });
  }

  const status = readOptionalStatus(body.status, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    formFieldId: formFieldId as string,
    ...(uomId === undefined ? {} : { uomId }),
    ...(functionalLocationId === undefined ? {} : { functionalLocationId }),
    ...(minimumValue === undefined ? {} : { minimumValue }),
    ...(maximumValue === undefined ? {} : { maximumValue }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateMeterReadingBindingBody(
  body: Record<string, unknown>,
): UpdateMeterReadingBindingInput {
  const details: ValidationDetail[] = [];
  const input: UpdateMeterReadingBindingInput = {};

  const uomId = readOptionalUuid(body.uomId, 'uomId', 'UOM id', details);
  if (uomId !== undefined) {
    input.uomId = uomId;
  }

  const functionalLocationId = readOptionalNullableUuid(
    body.functionalLocationId,
    'functionalLocationId',
    'Functional location id',
    details,
  );
  if (functionalLocationId !== undefined) {
    input.functionalLocationId = functionalLocationId;
  }

  const minimumValue = readOptionalNumber(
    body.minimumValue,
    'minimumValue',
    details,
  );
  if (minimumValue !== undefined) {
    input.minimumValue = minimumValue;
  }
  const maximumValue = readOptionalNumber(
    body.maximumValue,
    'maximumValue',
    details,
  );
  if (maximumValue !== undefined) {
    input.maximumValue = maximumValue;
  }
  if (
    input.minimumValue !== undefined &&
    input.maximumValue !== undefined &&
    input.minimumValue > input.maximumValue
  ) {
    details.push({
      field: 'minimumValue',
      message: 'minimumValue must not exceed maximumValue.',
    });
  }

  const status = readOptionalStatus(body.status, details);
  if (status !== undefined) {
    input.status = status;
  }

  if (Object.keys(input).length === 0) {
    details.push({
      field: 'body',
      message: 'At least one updatable field is required.',
    });
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return input;
}

/** PUT reading body: a finite numeric value plus optional notes. */
export function parseSubmitReadingBody(
  body: Record<string, unknown>,
): { value: number; notes: string | null } {
  const details: ValidationDetail[] = [];

  const rawValue = body.value;
  let value: number | undefined;
  if (typeof rawValue !== 'number' || !Number.isFinite(rawValue)) {
    details.push({
      field: 'value',
      message: 'value is required and must be a finite number.',
    });
  } else {
    value = rawValue;
  }

  let notes: string | null = null;
  const rawNotes = readSingleParam(body.notes);
  if (rawNotes !== undefined && rawNotes !== '') {
    if (rawNotes.length > 2048) {
      details.push({
        field: 'notes',
        message: 'notes must be at most 2048 characters.',
      });
    } else {
      notes = rawNotes;
    }
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return { value: value as number, notes };
}

function readOptionalNumber(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    details.push({ field, message: `${field} must be a finite number.` });
    return undefined;
  }
  return value;
}

function readOptionalStatus(
  value: unknown,
  details: ValidationDetail[],
): MeterReadingBindingStatus | undefined {
  const raw = readSingleParam(value);
  if (raw === undefined || raw === '') {
    return undefined;
  }
  if (!isMeterReadingBindingStatus(raw.trim().toUpperCase())) {
    details.push({
      field: 'status',
      message: `status must be one of: ${METER_READING_BINDING_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return raw.trim().toUpperCase() as MeterReadingBindingStatus;
}

function readOptionalUuid(
  value: unknown,
  field: string,
  label: string,
  details: ValidationDetail[],
): string | undefined {
  const raw = readSingleParam(value);
  if (raw === undefined || raw === '') {
    return undefined;
  }
  if (!isValidUuid(raw.trim())) {
    details.push({ field, message: `${label} must be a valid UUID.` });
    return undefined;
  }
  return raw.trim().toLowerCase();
}

function readOptionalNullableUuid(
  value: unknown,
  field: string,
  label: string,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === null) {
    return null;
  }
  return readOptionalUuid(value, field, label, details);
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
