import {
  failValidation,
  isRecord,
  readEnum,
  readNullableText,
  readUuid,
  rejectForbiddenFields,
  type ValidationDetail,
} from '../incidents';
import { isReviewDecision, REVIEW_DECISIONS } from '../reviews';
import type {
  CorrectiveActionVerificationFilters,
  CorrectiveActionVerificationStatus,
  OpenCorrectiveActionVerificationInput,
  SubmitCorrectiveActionVerificationInput,
} from './corrective-action-verification.types';

export type { ValidationDetail };

const MAX_NOTES_LENGTH = 4000;

const VERIFICATION_STATUSES = ['PENDING', 'COMPLETED'] as const;

function isVerificationStatus(
  value: unknown,
): value is CorrectiveActionVerificationStatus {
  return (
    typeof value === 'string' &&
    (VERIFICATION_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Fields the backend owns. Refused rather than ignored, so a caller always
 * learns their intent was not honoured.
 *
 * `reviewerUserId` is refused specifically: the reviewer is the authenticated
 * actor. Allowing it to be supplied would let a caller record a decision
 * under someone else's name, which would destroy the accountability that
 * makes verification meaningful.
 *
 * `status` and `correctiveActionStatus` are refused because the backend
 * derives the lifecycle outcome from the decision — a client must never
 * assert the resulting status directly.
 */
const DERIVED_FIELDS = [
  'reviewerUserId',
  'clientId',
  'buildingId',
  'targetType',
  'targetId',
  'status',
  'correctiveActionStatus',
  'reviewedAt',
  'verifiedAt',
  'verifiedByUserId',
  'finalized',
  'createdAt',
  'updatedAt',
] as const;

function describeForbidden(field: string): string {
  if (field === 'reviewerUserId') {
    return 'The reviewer is always the authenticated user.';
  }
  if (field === 'status' || field === 'correctiveActionStatus') {
    return 'The lifecycle outcome is derived by the backend from the decision.';
  }
  return 'This field is derived by the backend.';
}

export function parseCorrectiveActionIdParam(raw: string): string {
  const details: ValidationDetail[] = [];
  const value = readUuid(raw, 'correctiveActionId', true, details);
  if (!value || details.length > 0) failValidation(details);
  return value;
}

/** Opening a verification takes an optional note and nothing else. */
export function parseOpenVerificationBody(
  body: unknown,
): Pick<OpenCorrectiveActionVerificationInput, 'notes'> {
  if (body === undefined || body === null) return {};
  if (!isRecord(body)) {
    failValidation([
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  rejectForbiddenFields(
    body,
    [...DERIVED_FIELDS, 'decision'],
    (field) =>
      field === 'decision'
        ? 'Opening a verification does not carry a decision; submit it separately.'
        : describeForbidden(field),
  );

  const details: ValidationDetail[] = [];
  const notes = readNullableText(body.notes, 'notes', MAX_NOTES_LENGTH, details);
  if (details.length > 0) failValidation(details);

  return { ...(notes !== undefined ? { notes } : {}) };
}

/**
 * The decision payload.
 *
 * `decision` is validated against the SHARED `REVIEW_DECISIONS` vocabulary
 * rather than a BE-21-local copy, so this endpoint and the shared reviews
 * primitive can never disagree about what a valid decision is.
 */
export function parseSubmitVerificationBody(
  body: unknown,
): Omit<SubmitCorrectiveActionVerificationInput, 'correctiveActionId'> {
  if (!isRecord(body)) {
    failValidation([
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  rejectForbiddenFields(body, DERIVED_FIELDS, describeForbidden);

  const details: ValidationDetail[] = [];
  const decision = readEnum(
    body.decision,
    'decision',
    isReviewDecision,
    REVIEW_DECISIONS,
    true,
    details,
  );
  const notes = readNullableText(body.notes, 'notes', MAX_NOTES_LENGTH, details);

  if (!decision || details.length > 0) failValidation(details);

  return {
    decision,
    ...(notes !== undefined ? { notes } : {}),
  };
}

export function parseVerificationFilters(
  query: unknown,
): CorrectiveActionVerificationFilters {
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
  const status = readEnum(
    query.status,
    'status',
    isVerificationStatus,
    VERIFICATION_STATUSES,
    false,
    details,
  );
  const decision = readEnum(
    query.decision,
    'decision',
    isReviewDecision,
    REVIEW_DECISIONS,
    false,
    details,
  );
  if (details.length > 0) failValidation(details);

  return {
    ...(correctiveActionId ? { correctiveActionId } : {}),
    ...(incidentId ? { incidentId } : {}),
    ...(buildingId ? { buildingId } : {}),
    ...(status ? { status } : {}),
    ...(decision ? { decision } : {}),
  };
}
