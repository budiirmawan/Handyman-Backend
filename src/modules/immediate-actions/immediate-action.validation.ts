import {
  INCIDENT_STATUSES,
  INCIDENT_TYPES,
  failValidation,
  isIncidentStatus,
  isIncidentType,
  isRecord,
  readEnum,
  readNullableText,
  readNullableUuid,
  readText,
  readTimestamp,
  readUuid,
  rejectForbiddenFields,
  type ValidationDetail,
} from '../incidents';
import {
  IMMEDIATE_ACTION_STATUSES,
  IMMEDIATE_ACTION_TYPES,
  isImmediateActionStatus,
  isImmediateActionType,
  type CompleteImmediateActionInput,
  type CreateImmediateActionInput,
  type ImmediateActionFilters,
  type UpdateImmediateActionInput,
} from './immediate-action.types';

export type { ValidationDetail };

const MAX_DESCRIPTION_LENGTH = 4000;
const MAX_NOTES_LENGTH = 4000;

/**
 * Fields the backend owns. Refused rather than ignored so a caller always
 * learns their intent was not honoured.
 *
 * `status` is included deliberately: a new action always starts PLANNED and
 * completion is an explicit operation with its own metadata, so status is
 * never a plain field assignment.
 */
const DERIVED_FIELDS = [
  'clientId',
  'buildingId',
  'status',
  'incidentStatus',
  'incidentType',
  'completedAt',
  'completedByUserId',
  'completionNotes',
  'statusChangedAt',
  'createdByUserId',
  'createdAt',
  'updatedAt',
] as const;

export function parseImmediateActionIdParam(raw: string): string {
  const details: ValidationDetail[] = [];
  const value = readUuid(raw, 'immediateActionId', true, details);
  if (!value || details.length > 0) failValidation(details);
  return value;
}

export function parseCreateImmediateActionBody(
  body: unknown,
): CreateImmediateActionInput {
  if (!isRecord(body)) {
    failValidation([
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  rejectForbiddenFields(body, DERIVED_FIELDS, (field) =>
    field === 'status'
      ? 'A new Immediate Action always starts PLANNED; use the status endpoints.'
      : field === 'clientId' || field === 'buildingId'
        ? 'Context is derived from the referenced Incident.'
        : 'This field is derived by the backend.',
  );

  const details: ValidationDetail[] = [];
  const incidentId = readUuid(body.incidentId, 'incidentId', true, details);
  const actionType = readEnum(
    body.actionType,
    'actionType',
    isImmediateActionType,
    IMMEDIATE_ACTION_TYPES,
    true,
    details,
  );
  const description = readText(
    body.description,
    'description',
    MAX_DESCRIPTION_LENGTH,
    true,
    details,
  );
  const takenAt = readTimestamp(body.takenAt, 'takenAt', true, details);
  const responsibleUserId = readNullableUuid(
    body.responsibleUserId,
    'responsibleUserId',
    details,
  );
  const notes = readNullableText(body.notes, 'notes', MAX_NOTES_LENGTH, details);

  if (!incidentId || !actionType || !description || !takenAt || details.length > 0) {
    failValidation(details);
  }

  return {
    incidentId,
    actionType,
    description,
    takenAt,
    ...(responsibleUserId !== undefined ? { responsibleUserId } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };
}

export function parseUpdateImmediateActionBody(
  body: unknown,
): UpdateImmediateActionInput {
  if (!isRecord(body)) {
    failValidation([
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  rejectForbiddenFields(
    body,
    // Re-parenting an action to another Incident would rewrite history.
    [...DERIVED_FIELDS, 'incidentId'],
    (field) =>
      field === 'incidentId'
        ? 'The Incident binding is immutable.'
        : field === 'status'
          ? 'Use the dedicated status endpoints to change status.'
          : 'This field is derived by the backend.',
  );

  const details: ValidationDetail[] = [];
  const actionType = readEnum(
    body.actionType,
    'actionType',
    isImmediateActionType,
    IMMEDIATE_ACTION_TYPES,
    false,
    details,
  );
  const description = body.description === undefined
    ? undefined
    : readText(
        body.description,
        'description',
        MAX_DESCRIPTION_LENGTH,
        true,
        details,
      );
  const takenAt = readTimestamp(body.takenAt, 'takenAt', false, details);
  const responsibleUserId = readNullableUuid(
    body.responsibleUserId,
    'responsibleUserId',
    details,
  );
  const notes = readNullableText(body.notes, 'notes', MAX_NOTES_LENGTH, details);

  const parsed: UpdateImmediateActionInput = {
    ...(actionType ? { actionType } : {}),
    ...(description ? { description } : {}),
    ...(takenAt ? { takenAt } : {}),
    ...(responsibleUserId !== undefined ? { responsibleUserId } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };
  if (Object.keys(parsed).length === 0 && details.length === 0) {
    details.push({
      field: 'body',
      message: 'At least one Immediate Action field is required.',
    });
  }
  if (details.length > 0) failValidation(details);
  return parsed;
}

export function parseCompleteImmediateActionBody(
  body: unknown,
): CompleteImmediateActionInput {
  // Completion with no body is valid: "done, now, by me".
  if (body === undefined || body === null) return {};
  if (!isRecord(body)) {
    failValidation([
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  rejectForbiddenFields(
    body,
    // The completer is always the authenticated actor — never claimed.
    ['completedByUserId', 'status'],
    () => 'This field is derived by the backend.',
  );

  const details: ValidationDetail[] = [];
  const completionNotes = readNullableText(
    body.completionNotes,
    'completionNotes',
    MAX_NOTES_LENGTH,
    details,
  );
  const completedAt = readTimestamp(
    body.completedAt,
    'completedAt',
    false,
    details,
  );
  if (details.length > 0) failValidation(details);

  return {
    ...(completionNotes !== undefined ? { completionNotes } : {}),
    ...(completedAt ? { completedAt } : {}),
  };
}

export function parseImmediateActionFilters(
  query: unknown,
): ImmediateActionFilters {
  if (!isRecord(query)) return {};
  const details: ValidationDetail[] = [];
  const incidentId = readUuid(query.incidentId, 'incidentId', false, details);
  const buildingId = readUuid(query.buildingId, 'buildingId', false, details);
  const actionType = readEnum(
    query.actionType,
    'actionType',
    isImmediateActionType,
    IMMEDIATE_ACTION_TYPES,
    false,
    details,
  );
  const status = readEnum(
    query.status,
    'status',
    isImmediateActionStatus,
    IMMEDIATE_ACTION_STATUSES,
    false,
    details,
  );
  const responsibleUserId = readUuid(
    query.responsibleUserId,
    'responsibleUserId',
    false,
    details,
  );
  const incidentStatus = readEnum(
    query.incidentStatus,
    'incidentStatus',
    isIncidentStatus,
    INCIDENT_STATUSES,
    false,
    details,
  );
  const incidentType = readEnum(
    query.incidentType,
    'incidentType',
    isIncidentType,
    INCIDENT_TYPES,
    false,
    details,
  );
  const takenFrom = readTimestamp(query.takenFrom, 'takenFrom', false, details);
  const takenTo = readTimestamp(query.takenTo, 'takenTo', false, details);
  if (takenFrom && takenTo && takenFrom.getTime() > takenTo.getTime()) {
    details.push({
      field: 'takenFrom',
      message: 'takenFrom must be earlier than or equal to takenTo.',
    });
  }
  if (details.length > 0) failValidation(details);

  return {
    ...(incidentId ? { incidentId } : {}),
    ...(buildingId ? { buildingId } : {}),
    ...(actionType ? { actionType } : {}),
    ...(status ? { status } : {}),
    ...(responsibleUserId ? { responsibleUserId } : {}),
    ...(incidentStatus ? { incidentStatus } : {}),
    ...(incidentType ? { incidentType } : {}),
    ...(takenFrom ? { takenFrom } : {}),
    ...(takenTo ? { takenTo } : {}),
  };
}
