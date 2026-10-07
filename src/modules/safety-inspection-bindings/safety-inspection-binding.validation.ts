import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  isSafetyInspectionBindingStatus,
  SAFETY_INSPECTION_BINDING_STATUSES,
  type CreateSafetyInspectionBindingInput,
  type SafetyInspectionBindingStatus,
  type UpdateSafetyInspectionBindingInput,
} from './safety-inspection-binding.types';

type ValidationDetail = {
  field: string;
  message: string;
};

export function parseSafetyInspectionBindingIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'id',
        message: 'Safety Inspection binding id must be a valid UUID.',
      },
    ]);
  }
  return value.toLowerCase();
}

export function parseCreateSafetyInspectionBindingBody(
  body: Record<string, unknown>,
): CreateSafetyInspectionBindingInput {
  const details: ValidationDetail[] = [];
  const scheduleDefinitionId = readUuid(
    body.scheduleDefinitionId,
    'scheduleDefinitionId',
    'Schedule definition id',
    details,
  );
  const status = readStatus(body.status, details, false);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    scheduleDefinitionId: scheduleDefinitionId as string,
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateSafetyInspectionBindingBody(
  body: Record<string, unknown>,
): UpdateSafetyInspectionBindingInput {
  const details: ValidationDetail[] = [];
  const status = readStatus(body.status, details, true);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return { status: status as SafetyInspectionBindingStatus };
}

function readUuid(
  value: unknown,
  field: string,
  label: string,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({
      field,
      message: `${label} is required and must be a valid UUID.`,
    });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readStatus(
  value: unknown,
  details: ValidationDetail[],
  required: boolean,
): SafetyInspectionBindingStatus | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) {
      details.push({
        field: 'status',
        message: `status is required and must be one of: ${SAFETY_INSPECTION_BINDING_STATUSES.join(', ')}.`,
      });
    }
    return undefined;
  }

  if (
    typeof value !== 'string' ||
    !isSafetyInspectionBindingStatus(value.trim().toUpperCase())
  ) {
    details.push({
      field: 'status',
      message: `status must be one of: ${SAFETY_INSPECTION_BINDING_STATUSES.join(', ')}.`,
    });
    return undefined;
  }

  return value.trim().toUpperCase() as SafetyInspectionBindingStatus;
}
