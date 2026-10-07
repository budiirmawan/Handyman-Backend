import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { isUtilityType, type UtilityType } from '../utility-meters/utility-meter.types';
import {
  UTILITY_CALCULATION_BASIS_STATUSES,
  UTILITY_CALCULATION_STATUSES,
  isUtilityCalculationBasisStatus,
  isUtilityCalculationStatus,
  type UtilityCalculationBasisStatus,
  type UtilityCalculationStatus,
} from './utility-calculation.types';

/** BE-18I — Utility Calculation request validation. */

const MAX_NOTES_LENGTH = 1024;
const MAX_NAME_LENGTH = 200;
const MAX_LABEL_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_LIMIT = 500;
const MAX_RATE_VALUE = 1_000_000_000;

export type ValidationDetail = {
  field: string;
  message: string;
};

export type CalculateUtilityValueBody = {
  calculationBasisId?: string;
  notes?: string | null;
};

export type RecalculateUtilityValueBody = {
  calculationBasisId?: string;
  notes?: string | null;
};

export type CreateUtilityCalculationBasisBody = {
  utilityType: UtilityType;
  name: string;
  description?: string | null;
  uomId?: string | null;
  rateValue: number;
  rateLabel?: string | null;
  effectiveFrom: Date;
  effectiveTo?: Date | null;
  status?: UtilityCalculationBasisStatus;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

export function parseUtilityCalculationIdParam(raw: string): string {
  return parseUuidParam(raw, 'id', 'Calculation id');
}

export function parseCalculationConsumptionIdParam(raw: string): string {
  return parseUuidParam(raw, 'id', 'Consumption id');
}

export function parseCalculationMeterIdParam(raw: string): string {
  return parseUuidParam(raw, 'id', 'Meter id');
}

export function parseCalculationBuildingIdParam(raw: string): string {
  return parseUuidParam(raw, 'buildingId', 'Building id');
}

export function parseCalculationTenantIdParam(raw: string): string {
  return parseUuidParam(raw, 'tenantCompanyId', 'Tenant company id');
}

export function parseCalculationClientIdParam(raw: string): string {
  return parseUuidParam(raw, 'clientId', 'Client id');
}

/**
 * Parses a calculation request.
 *
 * Only a consumption reference (from the path) and an optional basis are
 * accepted — never an amount or a rate. The value is always derived, so
 * there is no way to post a figure that contradicts the consumption behind
 * it, and no way to hand-pick a rate that is not registered reference data.
 */
export function parseCalculateUtilityValueBody(
  body: unknown,
): CalculateUtilityValueBody {
  const source = body === undefined || body === null ? {} : body;
  if (!isRecord(source)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const calculationBasisId = readOptionalUuid(
    source.calculationBasisId,
    'calculationBasisId',
    'Calculation basis id',
    details,
  );
  const notes = readNullableText(
    source.notes,
    'notes',
    'Notes',
    MAX_NOTES_LENGTH,
    details,
  );

  // A caller-supplied amount or rate would be a second source of truth.
  if (source.calculatedAmount !== undefined) {
    details.push({
      field: 'calculatedAmount',
      message:
        'Calculated amount is derived from the consumption and rate, and must not be supplied.',
    });
  }
  if (source.appliedRateValue !== undefined || source.rateValue !== undefined) {
    details.push({
      field: 'appliedRateValue',
      message:
        'The applied rate comes from the calculation basis and must not be supplied.',
    });
  }
  // The period always mirrors the consumption's own period.
  if (source.periodStart !== undefined || source.periodEnd !== undefined) {
    details.push({
      field: 'periodStart',
      message:
        'The calculation period is taken from the consumption and must not be supplied.',
    });
  }
  if (source.status !== undefined) {
    details.push({
      field: 'status',
      message:
        'A calculation is always created as DRAFT; finalize it explicitly instead.',
    });
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(calculationBasisId === undefined ? {} : { calculationBasisId }),
    ...(notes === undefined ? {} : { notes }),
  };
}

export function parseRecalculateUtilityValueBody(
  body: unknown,
): RecalculateUtilityValueBody {
  return parseCalculateUtilityValueBody(body);
}

/** Parses a calculation basis — the lightweight, data-driven rate rule. */
export function parseCreateUtilityCalculationBasisBody(
  body: unknown,
): CreateUtilityCalculationBasisBody {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  let utilityType: UtilityType | undefined;
  if (typeof body.utilityType !== 'string' || !isUtilityType(body.utilityType)) {
    details.push({
      field: 'utilityType',
      message: 'Utility type must be one of: ELECTRICITY, WATER, GAS.',
    });
  } else {
    utilityType = body.utilityType;
  }

  const name = readRequiredText(
    body.name,
    'name',
    'Name',
    MAX_NAME_LENGTH,
    details,
  );
  const description = readNullableText(
    body.description,
    'description',
    'Description',
    MAX_DESCRIPTION_LENGTH,
    details,
  );
  const rateLabel = readNullableText(
    body.rateLabel,
    'rateLabel',
    'Rate label',
    MAX_LABEL_LENGTH,
    details,
  );
  const uomId = readOptionalUuid(
    body.uomId,
    'uomId',
    'Unit of measure id',
    details,
  );

  // A rate must be a finite, non-negative number. A negative rate would turn
  // consumption into a credit, which is a billing concept BE-18 does not own.
  let rateValue: number | undefined;
  if (typeof body.rateValue !== 'number' || !Number.isFinite(body.rateValue)) {
    details.push({
      field: 'rateValue',
      message: 'Rate value is required and must be a finite number.',
    });
  } else if (body.rateValue < 0) {
    details.push({
      field: 'rateValue',
      message: 'Rate value must not be negative.',
    });
  } else if (body.rateValue > MAX_RATE_VALUE) {
    details.push({
      field: 'rateValue',
      message: `Rate value must be at most ${MAX_RATE_VALUE}.`,
    });
  } else {
    rateValue = body.rateValue;
  }

  const effectiveFrom = readRequiredDate(
    body.effectiveFrom,
    'effectiveFrom',
    'Effective from',
    details,
  );
  const effectiveTo = readNullableDate(
    body.effectiveTo,
    'effectiveTo',
    'Effective to',
    details,
  );

  // A window that does not move forward in time cannot describe a rate.
  if (
    effectiveFrom &&
    effectiveTo &&
    effectiveTo.getTime() <= effectiveFrom.getTime()
  ) {
    details.push({
      field: 'effectiveTo',
      message: 'Effective to must be later than effective from.',
    });
  }

  let status: UtilityCalculationBasisStatus | undefined;
  if (body.status !== undefined) {
    if (!isUtilityCalculationBasisStatus(body.status)) {
      details.push({
        field: 'status',
        message: `Status must be one of: ${UTILITY_CALCULATION_BASIS_STATUSES.join(', ')}.`,
      });
    } else {
      status = body.status;
    }
  }

  if (
    !utilityType ||
    !name ||
    rateValue === undefined ||
    !effectiveFrom ||
    details.length > 0
  ) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    utilityType,
    name,
    rateValue,
    effectiveFrom,
    ...(description === undefined ? {} : { description }),
    ...(uomId === undefined ? {} : { uomId }),
    ...(rateLabel === undefined ? {} : { rateLabel }),
    ...(effectiveTo === undefined ? {} : { effectiveTo }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseCalculationDateQuery(
  raw: string | undefined,
  field: string,
): Date | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const date = new Date(raw.trim());
  if (Number.isNaN(date.getTime())) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${field} must be a valid ISO-8601 date string.` },
    ]);
  }
  return date;
}

export function parseCalculationUuidQuery(
  raw: string | undefined,
  field: string,
  label: string,
): string | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${label} must be a valid UUID.` },
    ]);
  }
  return value.toLowerCase();
}

export function parseCalculationStatusQuery(
  raw: string | undefined,
): UtilityCalculationStatus | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const value = raw.trim().toUpperCase();
  if (!isUtilityCalculationStatus(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'status',
        message: `status must be one of: ${UTILITY_CALCULATION_STATUSES.join(', ')}.`,
      },
    ]);
  }
  return value;
}

export function parseCalculationBasisStatusQuery(
  raw: string | undefined,
): UtilityCalculationBasisStatus | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const value = raw.trim().toUpperCase();
  if (!isUtilityCalculationBasisStatus(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'status',
        message: `status must be one of: ${UTILITY_CALCULATION_BASIS_STATUSES.join(', ')}.`,
      },
    ]);
  }
  return value;
}

export function parseCalculationUtilityTypeQuery(
  raw: string | undefined,
): UtilityType | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const value = raw.trim().toUpperCase();
  if (!isUtilityType(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'utilityType',
        message: 'utilityType must be one of: ELECTRICITY, WATER, GAS.',
      },
    ]);
  }
  return value;
}

export function parseCalculationLimitQuery(
  raw: string | undefined,
): number | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'limit',
        message: `limit must be an integer between 1 and ${MAX_LIMIT}.`,
      },
    ]);
  }
  return value;
}

function readRequiredText(
  value: unknown,
  field: string,
  label: string,
  maxLength: number,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    details.push({ field, message: `${label} is required.` });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    details.push({
      field,
      message: `${label} must be at most ${maxLength} characters.`,
    });
    return undefined;
  }
  return trimmed;
}

function readNullableText(
  value: unknown,
  field: string,
  label: string,
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
    details.push({ field, message: `${label} must be a string or null.` });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  if (trimmed.length > maxLength) {
    details.push({
      field,
      message: `${label} must be at most ${maxLength} characters.`,
    });
    return undefined;
  }
  return trimmed;
}

function readOptionalUuid(
  value: unknown,
  field: string,
  label: string,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field, message: `${label} must be a valid UUID.` });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readRequiredDate(
  value: unknown,
  field: string,
  label: string,
  details: ValidationDetail[],
): Date | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    details.push({
      field,
      message: `${label} is required and must be an ISO-8601 date string.`,
    });
    return undefined;
  }
  const date = new Date(value.trim());
  if (Number.isNaN(date.getTime())) {
    details.push({
      field,
      message: `${label} must be a valid ISO-8601 date string.`,
    });
    return undefined;
  }
  return date;
}

function readNullableDate(
  value: unknown,
  field: string,
  label: string,
  details: ValidationDetail[],
): Date | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    details.push({
      field,
      message: `${label} must be an ISO-8601 date string or null.`,
    });
    return undefined;
  }
  const date = new Date(value.trim());
  if (Number.isNaN(date.getTime())) {
    details.push({
      field,
      message: `${label} must be a valid ISO-8601 date string.`,
    });
    return undefined;
  }
  return date;
}
