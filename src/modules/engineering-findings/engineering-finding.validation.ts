import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  FINDING_SOURCE_TYPES,
  isFindingSourceType,
} from '../findings/finding.types';
import { FINDING_STATUSES, isFindingStatus } from '../findings/finding.types';
import {
  ENGINEERING_FINDING_OPERATION_TYPES,
  isEngineeringFindingOperationType,
  type CreateEngineeringFindingInput,
  type EngineeringFindingListFilters,
  type EngineeringFindingOperationType,
} from './engineering-finding.types';

export type ValidationDetail = {
  field: string;
  message: string;
};

export function parseLinkIdParam(raw: string): string {
  return parseUuidParam(raw, 'id', 'Engineering finding id');
}

const ASSIGNEE_TYPES = ['WORKFORCE', 'TEAM', 'VENDOR', 'VENDOR_WORKFORCE'] as const;

export function parseCreateEngineeringFindingBody(
  body: Record<string, unknown>,
): Omit<CreateEngineeringFindingInput, 'createdByUserId'> {
  const details: ValidationDetail[] = [];

  const buildingId = readOptionalUuid(body.buildingId, 'buildingId', 'Building id', details);
  if (buildingId === undefined) {
    details.push({ field: 'buildingId', message: 'buildingId is required and must be a valid UUID.' });
  }

  let operationType: EngineeringFindingOperationType | undefined;
  const rawOperationType = readSingleParam(body.operationType);
  if (rawOperationType === undefined || rawOperationType === '') {
    details.push({ field: 'operationType', message: 'operationType is required.' });
  } else if (!isEngineeringFindingOperationType(rawOperationType.trim().toUpperCase())) {
    details.push({
      field: 'operationType',
      message: `operationType must be one of: ${ENGINEERING_FINDING_OPERATION_TYPES.join(', ')}.`,
    });
  } else {
    operationType = rawOperationType.trim().toUpperCase() as EngineeringFindingOperationType;
  }

  const findingId = readOptionalUuid(body.findingId, 'findingId', 'Finding id', details);
  const title = readOptionalText(body.title, 'title', 160, details);
  const description = readOptionalText(body.description, 'description', 2048, details);
  const assetId = readOptionalNullableUuid(body.assetId, 'assetId', 'Asset id', details);
  const functionalLocationId = readOptionalNullableUuid(
    body.functionalLocationId,
    'functionalLocationId',
    'Functional location id',
    details,
  );
  const classificationId = readOptionalUuid(
    body.classificationId,
    'classificationId',
    'Classification id',
    details,
  );
  const severityId = readOptionalUuid(body.severityId, 'severityId', 'Severity id', details);

  // BE-09 source binding (sourceType + sourceId must come together).
  let sourceType: CreateEngineeringFindingInput['sourceType'];
  const rawSourceType = readSingleParam(body.sourceType);
  if (rawSourceType !== undefined && rawSourceType !== '') {
    const normalized = rawSourceType.trim().toUpperCase();
    if (!isFindingSourceType(normalized)) {
      details.push({
        field: 'sourceType',
        message: `sourceType must be one of: ${FINDING_SOURCE_TYPES.join(', ')}.`,
      });
    } else {
      sourceType = normalized as CreateEngineeringFindingInput['sourceType'];
    }
  }
  const sourceId = readOptionalUuid(body.sourceId, 'sourceId', 'Source id', details);
  if (sourceType !== undefined && sourceId === undefined) {
    details.push({ field: 'sourceId', message: 'sourceId is required when sourceType is supplied.' });
  }
  if (sourceType === undefined && sourceId !== undefined) {
    details.push({ field: 'sourceType', message: 'sourceType is required when sourceId is supplied.' });
  }

  // BE-09 assignment (delegated to BE-09's own service).
  let assigneeType: CreateEngineeringFindingInput['assigneeType'];
  const rawAssigneeType = readSingleParam(body.assigneeType);
  if (rawAssigneeType !== undefined && rawAssigneeType !== '') {
    const normalized = rawAssigneeType.trim().toUpperCase();
    if (!(ASSIGNEE_TYPES as readonly string[]).includes(normalized)) {
      details.push({
        field: 'assigneeType',
        message: `assigneeType must be one of: ${ASSIGNEE_TYPES.join(', ')}.`,
      });
    } else {
      assigneeType = normalized as CreateEngineeringFindingInput['assigneeType'];
    }
  }
  const workforceProfileId = readOptionalUuid(
    body.workforceProfileId,
    'workforceProfileId',
    'Workforce profile id',
    details,
  );
  const teamId = readOptionalUuid(body.teamId, 'teamId', 'Team id', details);
  const vendorId = readOptionalUuid(body.vendorId, 'vendorId', 'Vendor id', details);

  if (findingId === undefined) {
    if (title === undefined) {
      details.push({ field: 'title', message: 'title is required when creating a new finding.' });
    }
  } else if (
    title !== undefined || description !== undefined ||
    classificationId !== undefined || severityId !== undefined ||
    sourceType !== undefined || sourceId !== undefined || assigneeType !== undefined
  ) {
    details.push({
      field: 'body',
      message: 'Finding lifecycle fields cannot be supplied when linking an existing finding.',
    });
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    buildingId: buildingId as string,
    operationType: operationType as EngineeringFindingOperationType,
    ...(findingId === undefined ? {} : { findingId }),
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(assetId === undefined ? {} : { assetId }),
    ...(functionalLocationId === undefined ? {} : { functionalLocationId }),
    ...(sourceType === undefined ? {} : { sourceType }),
    ...(sourceId === undefined ? {} : { sourceId }),
    ...(classificationId === undefined ? {} : { classificationId }),
    ...(severityId === undefined ? {} : { severityId }),
    ...(assigneeType === undefined ? {} : { assigneeType }),
    ...(workforceProfileId === undefined ? {} : { workforceProfileId }),
    ...(teamId === undefined ? {} : { teamId }),
    ...(vendorId === undefined ? {} : { vendorId }),
  };
}

export function parseListEngineeringFindingsQuery(
  query: Record<string, unknown>,
): EngineeringFindingListFilters {
  const details: ValidationDetail[] = [];

  const buildingId = readOptionalUuid(query.buildingId, 'buildingId', 'Building id', details);
  const assetId = readOptionalUuid(query.assetId, 'assetId', 'Asset id', details);

  let sourceType: EngineeringFindingListFilters['sourceType'];
  const rawSourceType = readSingleParam(query.sourceType);
  if (rawSourceType !== undefined && rawSourceType !== '') {
    const normalized = rawSourceType.trim().toUpperCase();
    if (!isFindingSourceType(normalized)) {
      details.push({
        field: 'sourceType',
        message: `sourceType must be one of: ${FINDING_SOURCE_TYPES.join(', ')}.`,
      });
    } else {
      sourceType = normalized as EngineeringFindingListFilters['sourceType'];
    }
  }

  let status: string | undefined;
  const rawStatus = readSingleParam(query.status);
  if (rawStatus !== undefined && rawStatus !== '') {
    const normalized = rawStatus.trim().toUpperCase();
    if (!isFindingStatus(normalized)) {
      details.push({
        field: 'status',
        message: `status must be one of: ${FINDING_STATUSES.join(', ')}.`,
      });
    } else {
      status = normalized;
    }
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(buildingId === undefined ? {} : { buildingId }),
    ...(assetId === undefined ? {} : { assetId }),
    ...(sourceType === undefined ? {} : { sourceType }),
    ...(status === undefined ? {} : { status }),
  };
}

function readOptionalText(
  value: unknown,
  field: string,
  max: number,
  details: ValidationDetail[],
): string | undefined {
  const raw = readSingleParam(value);
  if (raw === undefined || raw === '') {
    return undefined;
  }
  const text = raw.trim();
  if (text.length > max) {
    details.push({ field, message: `${field} must be at most ${max} characters.` });
    return undefined;
  }
  return text;
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

function parseUuidParam(raw: string, field: string, label: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${label} must be a valid UUID.` },
    ]);
  }
  return value.toLowerCase();
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
