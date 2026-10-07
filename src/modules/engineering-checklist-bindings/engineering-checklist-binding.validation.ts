import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  ENGINEERING_CHECKLIST_BINDING_STATUSES,
  isEngineeringChecklistBindingStatus,
  type CreateEngineeringChecklistBindingInput,
  type EngineeringChecklistBindingStatus,
  type UpdateEngineeringChecklistBindingInput,
} from './engineering-checklist-binding.types';

export type ValidationDetail = {
  field: string;
  message: string;
};

export function parseBindingIdParam(raw: string): string {
  return parseUuidParam(raw, 'id', 'Engineering checklist binding id');
}

export function parseExecutionIdParam(raw: string): string {
  return parseUuidParam(raw, 'id', 'Engineering checklist execution id');
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

export function parseCreateEngineeringChecklistBindingBody(
  body: Record<string, unknown>,
): Pick<
  CreateEngineeringChecklistBindingInput,
  'buildingId' | 'checklistTemplateId' | 'assetId' | 'functionalLocationId' | 'status'
> {
  const details: ValidationDetail[] = [];

  const buildingId = readOptionalUuid(body.buildingId, 'buildingId', 'Building id', details);
  if (buildingId === undefined) {
    details.push({
      field: 'buildingId',
      message: 'buildingId is required and must be a valid UUID.',
    });
  }

  const checklistTemplateId = readOptionalUuid(
    body.checklistTemplateId,
    'checklistTemplateId',
    'Checklist template id',
    details,
  );
  if (checklistTemplateId === undefined) {
    details.push({
      field: 'checklistTemplateId',
      message: 'checklistTemplateId is required and must be a valid UUID.',
    });
  }

  const assetId = readOptionalNullableUuid(body.assetId, 'assetId', 'Asset id', details);
  const functionalLocationId = readOptionalNullableUuid(
    body.functionalLocationId,
    'functionalLocationId',
    'Functional location id',
    details,
  );
  if ((assetId ?? null) === null && (functionalLocationId ?? null) === null) {
    details.push({
      field: 'target',
      message: 'At least one of assetId or functionalLocationId is required.',
    });
  }

  const status = readOptionalStatus(body.status, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    buildingId: buildingId as string,
    checklistTemplateId: checklistTemplateId as string,
    ...(assetId === undefined ? {} : { assetId }),
    ...(functionalLocationId === undefined ? {} : { functionalLocationId }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateEngineeringChecklistBindingBody(
  body: Record<string, unknown>,
): UpdateEngineeringChecklistBindingInput {
  const details: ValidationDetail[] = [];
  const input: UpdateEngineeringChecklistBindingInput = {};

  const assetId = readOptionalNullableUuid(body.assetId, 'assetId', 'Asset id', details);
  if (assetId !== undefined) {
    input.assetId = assetId;
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

/** List query: optional buildingId / assetId UUID filters. */
export function parseListEngineeringChecklistQuery(
  query: Record<string, unknown>,
): { buildingId?: string; assetId?: string } {
  const details: ValidationDetail[] = [];
  const buildingId = readOptionalUuid(query.buildingId, 'buildingId', 'Building id', details);
  const assetId = readOptionalUuid(query.assetId, 'assetId', 'Asset id', details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(buildingId === undefined ? {} : { buildingId }),
    ...(assetId === undefined ? {} : { assetId }),
  };
}

function readOptionalStatus(
  value: unknown,
  details: ValidationDetail[],
): EngineeringChecklistBindingStatus | undefined {
  const raw = readSingleParam(value);
  if (raw === undefined || raw === '') {
    return undefined;
  }
  if (!isEngineeringChecklistBindingStatus(raw.trim().toUpperCase())) {
    details.push({
      field: 'status',
      message: `status must be one of: ${ENGINEERING_CHECKLIST_BINDING_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return raw.trim().toUpperCase() as EngineeringChecklistBindingStatus;
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
