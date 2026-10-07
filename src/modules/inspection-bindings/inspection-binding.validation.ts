import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  INSPECTION_BINDING_STATUSES,
  isInspectionBindingStatus,
  type CreateInspectionBindingInput,
  type InspectionBindingStatus,
  type UpdateInspectionBindingInput,
} from './inspection-binding.types';

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
  return parseUuidParam(raw, 'id', 'Inspection binding id');
}

export function parseExecutionIdParam(raw: string): string {
  return parseUuidParam(raw, 'id', 'Inspection execution id');
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

export function parseCreateInspectionBindingBody(
  body: Record<string, unknown>,
): Pick<
  CreateInspectionBindingInput,
  'checklistTemplateId' | 'functionalLocationId' | 'status'
> {
  const details: ValidationDetail[] = [];

  const templateId = readOptionalUuid(
    body.checklistTemplateId,
    'checklistTemplateId',
    'Checklist template id',
    details,
  );
  if (templateId === undefined) {
    details.push({
      field: 'checklistTemplateId',
      message: 'checklistTemplateId is required and must be a valid UUID.',
    });
  }

  const functionalLocationId = readOptionalNullableUuid(
    body.functionalLocationId,
    'functionalLocationId',
    'Functional location id',
    details,
  );

  let status: InspectionBindingStatus | undefined;
  const rawStatus = readSingleParam(body.status);
  if (rawStatus !== undefined && rawStatus !== '') {
    if (!isInspectionBindingStatus(rawStatus.trim().toUpperCase())) {
      details.push({
        field: 'status',
        message: `status must be one of: ${INSPECTION_BINDING_STATUSES.join(', ')}.`,
      });
    } else {
      status = rawStatus.trim().toUpperCase() as InspectionBindingStatus;
    }
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    checklistTemplateId: templateId as string,
    ...(functionalLocationId === undefined ? {} : { functionalLocationId }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateInspectionBindingBody(
  body: Record<string, unknown>,
): UpdateInspectionBindingInput {
  const details: ValidationDetail[] = [];
  const input: UpdateInspectionBindingInput = {};

  const functionalLocationId = readOptionalNullableUuid(
    body.functionalLocationId,
    'functionalLocationId',
    'Functional location id',
    details,
  );
  if (functionalLocationId !== undefined) {
    input.functionalLocationId = functionalLocationId;
  }

  const rawStatus = readSingleParam(body.status);
  if (rawStatus !== undefined && rawStatus !== '') {
    if (!isInspectionBindingStatus(rawStatus.trim().toUpperCase())) {
      details.push({
        field: 'status',
        message: `status must be one of: ${INSPECTION_BINDING_STATUSES.join(', ')}.`,
      });
    } else {
      input.status = rawStatus.trim().toUpperCase() as InspectionBindingStatus;
    }
  }

  if (Object.keys(input).length === 0) {
    details.push({
      field: 'body',
      message: 'At least one of functionalLocationId or status is required.',
    });
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return input;
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

/** Reads an optional UUID that may be explicitly `null` (clears the field). */
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
