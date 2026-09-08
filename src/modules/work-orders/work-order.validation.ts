import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  BAST_REQUIREMENTS,
  isBastRequirement,
  isWorkOrderPriority,
  isWorkOrderStatus,
  WORK_ORDER_PRIORITIES,
  WORK_ORDER_STATUSES,
  type CompleteWorkOrderInput,
  type CreateWorkOrderFromRequestInput,
  type CreateWorkOrderInput,
  type UpdateWorkOrderBastRequirementInput,
  type UpdateWorkOrderContextInput,
  type UpdateWorkOrderInput,
  type UpdateWorkOrderPriorityInput,
  type UpdateWorkOrderStatusInput,
  type WorkOrderFilters,
  type WorkOrderPriority,
  type WorkOrderStatus,
} from './work-order.types';

const WORK_ORDER_NUMBER_PATTERN = /^[A-Z][A-Z0-9_-]*$/;
const WORK_TYPE_PATTERN = /^[A-Z][A-Z0-9_-]*$/;
const MAX_WORK_ORDER_NUMBER_LENGTH = 64;
const MAX_WORK_TYPE_LENGTH = 64;
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 1000;

export type ValidationDetail = {
  field: string;
  message: string;
};

export function normalizeWorkOrderNumber(value: string): string {
  return value.trim().toUpperCase();
}

export function isValidWorkOrderNumber(value: string): boolean {
  return (
    value.length >= 2 &&
    value.length <= MAX_WORK_ORDER_NUMBER_LENGTH &&
    WORK_ORDER_NUMBER_PATTERN.test(value)
  );
}

export function normalizeWorkType(value: string): string {
  return value.trim().toUpperCase();
}

export function isValidWorkType(value: string): boolean {
  return (
    value.length >= 2 &&
    value.length <= MAX_WORK_TYPE_LENGTH &&
    WORK_TYPE_PATTERN.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseWorkOrderIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'workOrderId',
        message: 'Work order id must be a valid UUID.',
      },
    ]);
  }
  return value.toLowerCase();
}

export function parseWorkOrderBuildingIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'buildingId', message: 'Building id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseWorkRequestIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'workRequestId',
        message: 'Work request id must be a valid UUID.',
      },
    ]);
  }
  return value.toLowerCase();
}

/**
 * Parses list filters for `GET /buildings/:buildingId/work-orders`.
 * `?status=`, `?workType=`, and `?workRequestId=` filters are supported.
 */
export function parseWorkOrderFilters(query: unknown): WorkOrderFilters {
  if (!isRecord(query)) {
    return {};
  }

  const details: ValidationDetail[] = [];
  const status = readStatus(query.status, details);
  const workType =
    query.workType === undefined
      ? undefined
      : readWorkType(query.workType, details);
  const workRequestId =
    query.workRequestId === undefined
      ? undefined
      : readWorkRequestId(query.workRequestId, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(status === undefined ? {} : { status }),
    ...(workType === undefined ? {} : { workType }),
    ...(workRequestId === undefined ? {} : { workRequestId }),
  };
}

export function parseCreateWorkOrderBody(
  body: unknown,
): Omit<CreateWorkOrderInput, 'buildingId' | 'createdByUserId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const clientId = readClientId(body.clientId, details);
  const workOrderNumber = readWorkOrderNumber(body.workOrderNumber, details);
  const title = readTitle(body.title, details);
  const description = readOptionalString(
    body.description,
    'description',
    MAX_DESCRIPTION_LENGTH,
    details,
  );
  const workType = readWorkType(body.workType, details);

  if (
    !clientId ||
    !workOrderNumber ||
    !title ||
    !workType ||
    details.length > 0
  ) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    clientId,
    workOrderNumber,
    title,
    ...(description === undefined ? {} : { description }),
    workType,
  };
}

/**
 * Conversion body carries no clientId/buildingId: the Work Order inherits its
 * context from the source Work Request.
 */
export function parseCreateWorkOrderFromRequestBody(
  body: unknown,
): Omit<CreateWorkOrderFromRequestInput, 'workRequestId' | 'createdByUserId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const workOrderNumber = readWorkOrderNumber(body.workOrderNumber, details);
  const title = readTitle(body.title, details);
  const description = readOptionalString(
    body.description,
    'description',
    MAX_DESCRIPTION_LENGTH,
    details,
  );
  const workType = readWorkType(body.workType, details);

  if (!workOrderNumber || !title || !workType || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    workOrderNumber,
    title,
    ...(description === undefined ? {} : { description }),
    workType,
  };
}

export function parseUpdateWorkOrderBody(body: unknown): UpdateWorkOrderInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const title =
    body.title === undefined ? undefined : readTitle(body.title, details);
  const description =
    body.description === undefined
      ? undefined
      : readNullableOptionalString(
          body.description,
          'description',
          MAX_DESCRIPTION_LENGTH,
          details,
        );
  const workType =
    body.workType === undefined
      ? undefined
      : readWorkType(body.workType, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(workType === undefined ? {} : { workType }),
  };
}

const MAX_COMPLETION_SUMMARY_LENGTH = 2000;
const MAX_COMPLETION_NOTES_LENGTH = 2000;

export function parseCompleteWorkOrderBody(
  body: unknown,
): CompleteWorkOrderInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];
  const completionSummary =
    body.completionSummary === undefined
      ? undefined
      : readCompletionString(
          body.completionSummary,
          'completionSummary',
          MAX_COMPLETION_SUMMARY_LENGTH,
          details,
        );
  const completionNotes =
    body.completionNotes === undefined
      ? undefined
      : readCompletionString(
          body.completionNotes,
          'completionNotes',
          MAX_COMPLETION_NOTES_LENGTH,
          details,
        );

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(completionSummary === undefined ? {} : { completionSummary }),
    ...(completionNotes === undefined ? {} : { completionNotes }),
  };
}

function readCompletionString(
  value: unknown,
  field: string,
  maxLength: number,
  details: ValidationDetail[],
): string | undefined {
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

export function parseUpdateWorkOrderPriorityBody(
  body: unknown,
): UpdateWorkOrderPriorityInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const priority = readPriority(body.priority, []);
  if (!priority) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'priority',
        message: `Priority must be one of: ${WORK_ORDER_PRIORITIES.join(', ')}.`,
      },
    ]);
  }

  return { priority };
}

export function parseUpdateWorkOrderBastRequirementBody(
  body: unknown,
): UpdateWorkOrderBastRequirementInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }
  if (!isBastRequirement(body.bastRequirement)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'bastRequirement',
        message: `bastRequirement must be one of: ${BAST_REQUIREMENTS.join(', ')}.`,
      },
    ]);
  }
  return { bastRequirement: body.bastRequirement };
}

export function parseUpdateWorkOrderStatusBody(
  body: unknown,
): UpdateWorkOrderStatusInput {
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
        message: `Status must be one of: ${WORK_ORDER_STATUSES.join(', ')}.`,
      },
    ]);
  }

  return { status };
}

/**
 * Parses the BE-08D context binding body: `assetId` and `functionalLocationId`
 * are each optional, a UUID to bind, or an explicit `null` to clear.
 */
export function parseUpdateWorkOrderContextBody(
  body: unknown,
): UpdateWorkOrderContextInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];
  const assetId =
    body.assetId === undefined
      ? undefined
      : readNullableUuid(body.assetId, 'assetId', details);
  const functionalLocationId =
    body.functionalLocationId === undefined
      ? undefined
      : readNullableUuid(body.functionalLocationId, 'functionalLocationId', details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(assetId === undefined ? {} : { assetId }),
    ...(functionalLocationId === undefined
      ? {}
      : { functionalLocationId }),
  };
}

/** A UUID value or an explicit null (to clear a binding). */
function readNullableUuid(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({
      field,
      message: `${field} must be a valid UUID or null.`,
    });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readPriority(
  value: unknown,
  _details: ValidationDetail[],
): WorkOrderPriority | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isWorkOrderPriority(value)) {
    return undefined;
  }

  return value;
}

function readClientId(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({
      field: 'clientId',
      message: 'clientId is required and must be a valid UUID.',
    });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readWorkOrderNumber(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({
      field: 'workOrderNumber',
      message: 'Work order number is required.',
    });
    return undefined;
  }

  const normalized = normalizeWorkOrderNumber(value);
  if (!isValidWorkOrderNumber(normalized)) {
    details.push({
      field: 'workOrderNumber',
      message:
        'Work order number must start with a letter and contain only uppercase letters, digits, hyphens, and underscores (2-64 characters).',
    });
    return undefined;
  }

  return normalized;
}

function readTitle(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({
      field: 'title',
      message: 'Work order title is required.',
    });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    details.push({
      field: 'title',
      message: 'Work order title is required.',
    });
    return undefined;
  }

  if (trimmed.length > MAX_TITLE_LENGTH) {
    details.push({
      field: 'title',
      message: `Work order title must be at most ${MAX_TITLE_LENGTH} characters.`,
    });
    return undefined;
  }

  return trimmed;
}

function readWorkType(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({
      field: 'workType',
      message: 'Work type is required.',
    });
    return undefined;
  }

  const normalized = normalizeWorkType(value);
  if (!isValidWorkType(normalized)) {
    details.push({
      field: 'workType',
      message:
        'Work type must start with a letter and contain only uppercase letters, digits, hyphens, and underscores (2-64 characters).',
    });
    return undefined;
  }

  return normalized;
}

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): WorkOrderStatus | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isWorkOrderStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${WORK_ORDER_STATUSES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}

function readWorkRequestId(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({
      field: 'workRequestId',
      message: 'workRequestId must be a valid UUID.',
    });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readOptionalString(
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

/** Update-body optional string that can be explicitly cleared with null. */
function readNullableOptionalString(
  value: unknown,
  field: string,
  maxLength: number,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === null) {
    return null;
  }
  return readOptionalString(value, field, maxLength, details);
}
