import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  LOG_SHEET_BINDING_STATUSES,
  isLogSheetBindingStatus,
  type CreateLogSheetBindingInput,
  type LogSheetBindingStatus,
  type UpdateLogSheetBindingInput,
} from './log-sheet-binding.types';

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
  return parseUuidParam(raw, 'id', 'Log sheet binding id');
}

export function parseExecutionIdParam(raw: string): string {
  return parseUuidParam(raw, 'id', 'Log sheet execution id');
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

export function parseCreateLogSheetBindingBody(
  body: Record<string, unknown>,
): Pick<
  CreateLogSheetBindingInput,
  'formTemplateId' | 'formTemplateVersionId' | 'functionalLocationId' | 'status'
> {
  const details: ValidationDetail[] = [];

  const formTemplateId = readOptionalUuid(
    body.formTemplateId,
    'formTemplateId',
    'Form template id',
    details,
  );
  if (formTemplateId === undefined) {
    details.push({
      field: 'formTemplateId',
      message: 'formTemplateId is required and must be a valid UUID.',
    });
  }

  const formTemplateVersionId = readOptionalNullableUuid(
    body.formTemplateVersionId,
    'formTemplateVersionId',
    'Form template version id',
    details,
  );
  const functionalLocationId = readOptionalNullableUuid(
    body.functionalLocationId,
    'functionalLocationId',
    'Functional location id',
    details,
  );

  const status = readOptionalStatus(body.status, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    formTemplateId: formTemplateId as string,
    ...(formTemplateVersionId === undefined ? {} : { formTemplateVersionId }),
    ...(functionalLocationId === undefined ? {} : { functionalLocationId }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateLogSheetBindingBody(
  body: Record<string, unknown>,
): UpdateLogSheetBindingInput {
  const details: ValidationDetail[] = [];
  const input: UpdateLogSheetBindingInput = {};

  const formTemplateVersionId = readOptionalNullableUuid(
    body.formTemplateVersionId,
    'formTemplateVersionId',
    'Form template version id',
    details,
  );
  if (formTemplateVersionId !== undefined) {
    input.formTemplateVersionId = formTemplateVersionId;
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

function readOptionalStatus(
  value: unknown,
  details: ValidationDetail[],
): LogSheetBindingStatus | undefined {
  const raw = readSingleParam(value);
  if (raw === undefined || raw === '') {
    return undefined;
  }
  if (!isLogSheetBindingStatus(raw.trim().toUpperCase())) {
    details.push({
      field: 'status',
      message: `status must be one of: ${LOG_SHEET_BINDING_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return raw.trim().toUpperCase() as LogSheetBindingStatus;
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
