import {
  failValidation,
  isRecord,
  readEnum,
  readNullableText,
  readUuid,
  rejectForbiddenFields,
  type ValidationDetail,
} from '../incidents';
import {
  RESPONSIBILITY_STATUSES,
  isResponsibilityStatus,
  type AssignResponsiblePersonInput,
  type CorrectiveActionResponsibilityFilters,
  type ReleaseResponsiblePersonInput,
  type UpdateResponsiblePersonInput,
} from './corrective-action-responsibility.types';

export type { ValidationDetail };

const MAX_NOTE_LENGTH = 2000;
const MAX_REASON_LENGTH = 2000;

/**
 * Person ATTRIBUTES are refused outright.
 *
 * This is the validation-level expression of "do not duplicate user/person
 * data": a caller may name the person only by `workforceProfileId`. Accepting
 * a `fullName` or `email` — even to ignore it — would suggest this record can
 * describe a person independently of BE-03C, which is exactly the divergence
 * this PART must prevent.
 */
const PERSON_ATTRIBUTE_FIELDS = [
  'fullName',
  'name',
  'displayName',
  'email',
  'phone',
  'employeeCode',
  'positionId',
  'departmentId',
  'organizationId',
] as const;

/** Not yet implemented — see BE-21I. */
const FUTURE_PART_FIELDS = ['dueDate', 'targetDate', 'deadline'] as const;

const DERIVED_FIELDS = [
  'id',
  'correctiveActionId',
  'incidentId',
  'clientId',
  'buildingId',
  'status',
  'assignedByUserId',
  'assignedAt',
  'releasedAt',
  'releasedByUserId',
  'createdAt',
  'updatedAt',
] as const;

function describeForbidden(field: string): string {
  if ((PERSON_ATTRIBUTE_FIELDS as readonly string[]).includes(field)) {
    return 'Reference the person by workforceProfileId; person details are owned by the Workforce Profile.';
  }
  if ((FUTURE_PART_FIELDS as readonly string[]).includes(field)) {
    return 'Due date is not part of Responsible Person yet.';
  }
  if (field === 'status') {
    return 'Assignment status is managed through assign, reassign, and release.';
  }
  return 'This field is derived by the backend.';
}

export function parseCorrectiveActionIdParam(raw: string): string {
  const details: ValidationDetail[] = [];
  const value = readUuid(raw, 'correctiveActionId', true, details);
  if (!value || details.length > 0) failValidation(details);
  return value;
}

export function parseAssignResponsiblePersonBody(
  body: unknown,
): AssignResponsiblePersonInput {
  if (!isRecord(body)) {
    failValidation([
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  rejectForbiddenFields(
    body,
    [...PERSON_ATTRIBUTE_FIELDS, ...FUTURE_PART_FIELDS, ...DERIVED_FIELDS],
    describeForbidden,
  );

  const details: ValidationDetail[] = [];
  const workforceProfileId = readUuid(
    body.workforceProfileId,
    'workforceProfileId',
    true,
    details,
  );
  const responsibilityNote = readNullableText(
    body.responsibilityNote,
    'responsibilityNote',
    MAX_NOTE_LENGTH,
    details,
  );
  if (!workforceProfileId || details.length > 0) failValidation(details);

  return {
    workforceProfileId,
    ...(responsibilityNote !== undefined ? { responsibilityNote } : {}),
  };
}

export function parseUpdateResponsiblePersonBody(
  body: unknown,
): UpdateResponsiblePersonInput {
  if (!isRecord(body)) {
    failValidation([
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  rejectForbiddenFields(
    body,
    [...PERSON_ATTRIBUTE_FIELDS, ...FUTURE_PART_FIELDS, ...DERIVED_FIELDS],
    describeForbidden,
  );

  const details: ValidationDetail[] = [];
  const workforceProfileId = readUuid(
    body.workforceProfileId,
    'workforceProfileId',
    false,
    details,
  );
  const responsibilityNote = readNullableText(
    body.responsibilityNote,
    'responsibilityNote',
    MAX_NOTE_LENGTH,
    details,
  );
  const releaseReason = readNullableText(
    body.releaseReason,
    'releaseReason',
    MAX_REASON_LENGTH,
    details,
  );

  const parsed: UpdateResponsiblePersonInput = {
    ...(workforceProfileId ? { workforceProfileId } : {}),
    ...(responsibilityNote !== undefined ? { responsibilityNote } : {}),
    ...(releaseReason !== undefined ? { releaseReason } : {}),
  };
  if (
    workforceProfileId === undefined &&
    responsibilityNote === undefined &&
    details.length === 0
  ) {
    details.push({
      field: 'body',
      message:
        'Provide workforceProfileId to reassign, or responsibilityNote to edit the note.',
    });
  }
  if (details.length > 0) failValidation(details);
  return parsed;
}

export function parseReleaseResponsiblePersonBody(
  body: unknown,
): ReleaseResponsiblePersonInput {
  if (body === undefined || body === null) return {};
  if (!isRecord(body)) {
    failValidation([
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];
  const releaseReason = readNullableText(
    body.releaseReason,
    'releaseReason',
    MAX_REASON_LENGTH,
    details,
  );
  if (details.length > 0) failValidation(details);

  return { ...(releaseReason !== undefined ? { releaseReason } : {}) };
}

export function parseResponsibilityFilters(
  query: unknown,
): CorrectiveActionResponsibilityFilters {
  if (!isRecord(query)) return {};
  const details: ValidationDetail[] = [];

  const correctiveActionId = readUuid(
    query.correctiveActionId,
    'correctiveActionId',
    false,
    details,
  );
  const incidentId = readUuid(query.incidentId, 'incidentId', false, details);
  const buildingId = readUuid(query.buildingId, 'buildingId', false, details);
  const workforceProfileId = readUuid(
    query.workforceProfileId,
    'workforceProfileId',
    false,
    details,
  );
  const status = readEnum(
    query.status,
    'status',
    isResponsibilityStatus,
    RESPONSIBILITY_STATUSES,
    false,
    details,
  );
  if (details.length > 0) failValidation(details);

  return {
    ...(correctiveActionId ? { correctiveActionId } : {}),
    ...(incidentId ? { incidentId } : {}),
    ...(buildingId ? { buildingId } : {}),
    ...(workforceProfileId ? { workforceProfileId } : {}),
    ...(status ? { status } : {}),
  };
}
