import {
  INCIDENT_STATUSES,
  INCIDENT_TYPES,
  failValidation,
  isIncidentStatus,
  isIncidentType,
  isRecord,
  readEnum,
  readNullableText,
  readText,
  readTimestamp,
  readUuid,
  rejectForbiddenFields,
  type ValidationDetail,
} from '../incidents';
import {
  CORRECTIVE_ACTION_STATUSES,
  CORRECTIVE_ACTION_TYPES,
  isCorrectiveActionStatus,
  isCorrectiveActionType,
  type CompleteCorrectiveActionInput,
  type CorrectiveActionFilters,
  type CreateCorrectiveActionInput,
  type RejectCorrectiveActionInput,
  type SetCorrectiveActionDueDateInput,
  type UpdateCorrectiveActionInput,
} from './corrective-action.types';

export type { ValidationDetail };

const MAX_DESCRIPTION_LENGTH = 4000;
const MAX_NOTES_LENGTH = 4000;
const MAX_REASON_LENGTH = 2000;
/** Ten years: beyond this a "deadline" is a data-entry error, not a plan. */
const MAX_DUE_DATE_HORIZON_MS = 10 * 365 * 24 * 60 * 60 * 1000;

/**
 * Fields the backend owns. Refused rather than ignored so a caller always
 * learns their intent was not honoured.
 *
 * `responsibleUserId`, `dueDate`, and `targetDate` are refused explicitly:
 * they belong to BE-21H and BE-21I, and silently dropping them would let a
 * client believe ownership or a deadline had been recorded when it had not.
 */
const DERIVED_FIELDS = [
  'clientId',
  'buildingId',
  'status',
  'incidentStatus',
  'incidentType',
  'proposedAt',
  'approvedAt',
  'approvedByUserId',
  'rejectedAt',
  'rejectedByUserId',
  'rejectionReason',
  'startedAt',
  'completedAt',
  'completedByUserId',
  'completionNotes',
  'cancelledAt',
  'cancelledByUserId',
  'statusChangedAt',
  'dueDateSetAt',
  'dueDateSetByUserId',
  'dueStatus',
  'isOverdue',
  'overdue',
  'createdByUserId',
  'createdAt',
  'updatedAt',
] as const;

/**
 * Fields this resource's create/update payload does NOT accept.
 *
 * `responsibleUserId` / `assignedToUserId`: BE-21H owns responsibility, and
 * it is assigned through its own sub-resource keyed by `workforceProfileId`.
 *
 * `dueDate` stays here even though BE-21I now implements it. The deadline is
 * set through the dedicated `/due-date` endpoint, exactly as status changes
 * go through dedicated verbs — so that setting it always captures its own
 * provenance and history entry, and so a general field update can never move
 * a deadline as a side effect. Refusing it is therefore still correct; the
 * message below explains where it moved to rather than claiming it does not
 * exist.
 *
 * `targetDate` remains unimplemented: a second competing deadline was
 * deliberately not introduced.
 */
const FUTURE_PART_FIELDS = [
  'responsibleUserId',
  'assignedToUserId',
  'dueDate',
  'targetDate',
] as const;

function describeForbidden(field: string): string {
  if (field === 'dueDate') {
    return 'Set the due date through POST /corrective-actions/:id/due-date.';
  }
  if (field === 'targetDate') {
    return 'A separate target date is not part of Corrective Action.';
  }
  if ((FUTURE_PART_FIELDS as readonly string[]).includes(field)) {
    return 'Assign a responsible person through POST /corrective-actions/:id/responsible-person.';
  }
  if (field === 'status') {
    return 'A new Corrective Action always starts PROPOSED; use the status endpoints.';
  }
  if (field === 'clientId' || field === 'buildingId') {
    return 'Context is derived from the referenced Incident.';
  }
  return 'This field is derived by the backend.';
}

export function parseCorrectiveActionIdParam(raw: string): string {
  const details: ValidationDetail[] = [];
  const value = readUuid(raw, 'correctiveActionId', true, details);
  if (!value || details.length > 0) failValidation(details);
  return value;
}

export function parseCreateCorrectiveActionBody(
  body: unknown,
): CreateCorrectiveActionInput {
  if (!isRecord(body)) {
    failValidation([
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  rejectForbiddenFields(
    body,
    [...DERIVED_FIELDS, ...FUTURE_PART_FIELDS],
    describeForbidden,
  );

  const details: ValidationDetail[] = [];
  const incidentId = readUuid(body.incidentId, 'incidentId', true, details);
  const actionType = readEnum(
    body.actionType,
    'actionType',
    isCorrectiveActionType,
    CORRECTIVE_ACTION_TYPES,
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
  const notes = readNullableText(body.notes, 'notes', MAX_NOTES_LENGTH, details);

  if (!incidentId || !actionType || !description || details.length > 0) {
    failValidation(details);
  }

  return {
    incidentId,
    actionType,
    description,
    ...(notes !== undefined ? { notes } : {}),
  };
}

export function parseUpdateCorrectiveActionBody(
  body: unknown,
): UpdateCorrectiveActionInput {
  if (!isRecord(body)) {
    failValidation([
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  rejectForbiddenFields(
    body,
    // Re-parenting to another Incident would rewrite history.
    [...DERIVED_FIELDS, ...FUTURE_PART_FIELDS, 'incidentId'],
    (field) =>
      field === 'incidentId'
        ? 'The Incident binding is immutable.'
        : field === 'status'
          ? 'Use the dedicated status endpoints to change status.'
          : describeForbidden(field),
  );

  const details: ValidationDetail[] = [];
  const actionType = readEnum(
    body.actionType,
    'actionType',
    isCorrectiveActionType,
    CORRECTIVE_ACTION_TYPES,
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
  const notes = readNullableText(body.notes, 'notes', MAX_NOTES_LENGTH, details);

  const parsed: UpdateCorrectiveActionInput = {
    ...(actionType ? { actionType } : {}),
    ...(description ? { description } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };
  if (Object.keys(parsed).length === 0 && details.length === 0) {
    details.push({
      field: 'body',
      message: 'At least one Corrective Action field is required.',
    });
  }
  if (details.length > 0) failValidation(details);
  return parsed;
}

/** A refusal must be explainable later, so the reason is mandatory. */
export function parseRejectCorrectiveActionBody(
  body: unknown,
): RejectCorrectiveActionInput {
  if (!isRecord(body)) {
    failValidation([
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];
  const rejectionReason = readText(
    body.rejectionReason,
    'rejectionReason',
    MAX_REASON_LENGTH,
    true,
    details,
  );
  if (!rejectionReason || details.length > 0) failValidation(details);

  return { rejectionReason };
}

export function parseCompleteCorrectiveActionBody(
  body: unknown,
): CompleteCorrectiveActionInput {
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
    ['completedByUserId', 'completedAt', 'status'],
    () => 'This field is derived by the backend.',
  );

  const details: ValidationDetail[] = [];
  const completionNotes = readNullableText(
    body.completionNotes,
    'completionNotes',
    MAX_NOTES_LENGTH,
    details,
  );
  if (details.length > 0) failValidation(details);

  return {
    ...(completionNotes !== undefined ? { completionNotes } : {}),
  };
}

/**
 * BE-21I — the deadline payload.
 *
 * `dueDate` is REQUIRED and explicitly nullable: `null` clears the deadline,
 * and omitting it is an error rather than a silent no-op. A caller who sends
 * `{}` almost certainly meant something, and guessing which is worse than
 * refusing.
 *
 * The value must be an ISO-8601 timestamp WITH a timezone (enforced by the
 * shared `readTimestamp`). A bare local time like `2026-12-01T09:00:00` is
 * ambiguous across an estate that spans timezones, and a deadline is exactly
 * the kind of field where being a few hours out decides whether work counts
 * as late.
 *
 * A PAST due date is deliberately ACCEPTED. Backdating is legitimate — a
 * deadline agreed last week is often recorded today — and the derivation will
 * immediately, and correctly, report it as OVERDUE. Rejecting it would force
 * callers to falsify dates to record reality.
 */
export function parseSetCorrectiveActionDueDateBody(
  body: unknown,
): SetCorrectiveActionDueDateInput {
  if (!isRecord(body)) {
    failValidation([
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  rejectForbiddenFields(
    body,
    // The setter is always the authenticated actor, and the derived state is
    // never claimed by the client.
    ['dueDateSetAt', 'dueDateSetByUserId', 'dueStatus', 'isOverdue', 'status'],
    (field) =>
      field === 'status'
        ? 'Setting a due date does not change status.'
        : 'This field is derived by the backend.',
  );

  const details: ValidationDetail[] = [];

  if (body.dueDate === undefined) {
    failValidation([
      {
        field: 'dueDate',
        message:
          'dueDate is required; send null to clear the due date.',
      },
    ]);
  }

  const dueDate =
    body.dueDate === null
      ? null
      : (readTimestamp(body.dueDate, 'dueDate', true, details) ?? null);

  const reason = readNullableText(
    body.reason,
    'reason',
    MAX_REASON_LENGTH,
    details,
  );

  if (details.length > 0) failValidation(details);

  // An implausible far-future deadline is almost always a unit mistake
  // (milliseconds pasted as a year, a typo'd century) rather than an intent.
  if (dueDate && dueDate.getTime() > Date.now() + MAX_DUE_DATE_HORIZON_MS) {
    failValidation([
      {
        field: 'dueDate',
        message: 'dueDate must be within 10 years.',
      },
    ]);
  }

  return {
    dueDate,
    ...(reason !== undefined ? { reason } : {}),
  };
}

/** Query-string booleans arrive as strings; accept the usual spellings. */
function readBooleanFlag(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  details.push({ field, message: `${field} must be true or false.` });
  return undefined;
}

export function parseCorrectiveActionFilters(
  query: unknown,
): CorrectiveActionFilters {
  if (!isRecord(query)) return {};
  const details: ValidationDetail[] = [];

  const incidentId = readUuid(query.incidentId, 'incidentId', false, details);
  const buildingId = readUuid(query.buildingId, 'buildingId', false, details);
  const actionType = readEnum(
    query.actionType,
    'actionType',
    isCorrectiveActionType,
    CORRECTIVE_ACTION_TYPES,
    false,
    details,
  );
  const status = readEnum(
    query.status,
    'status',
    isCorrectiveActionStatus,
    CORRECTIVE_ACTION_STATUSES,
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
  const overdue = readBooleanFlag(query.overdue, 'overdue', details);
  const hasDueDate = readBooleanFlag(query.hasDueDate, 'hasDueDate', details);
  const dueBefore = readTimestamp(query.dueBefore, 'dueBefore', false, details);
  const dueAfter = readTimestamp(query.dueAfter, 'dueAfter', false, details);

  if (details.length > 0) failValidation(details);

  return {
    ...(incidentId ? { incidentId } : {}),
    ...(buildingId ? { buildingId } : {}),
    ...(actionType ? { actionType } : {}),
    ...(status ? { status } : {}),
    ...(incidentStatus ? { incidentStatus } : {}),
    ...(incidentType ? { incidentType } : {}),
    ...(overdue !== undefined ? { overdue } : {}),
    ...(hasDueDate !== undefined ? { hasDueDate } : {}),
    ...(dueBefore ? { dueBefore } : {}),
    ...(dueAfter ? { dueAfter } : {}),
  };
}
