import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  HANDYMAN_INTERNAL_NOTE_MAX_CONTENT_LENGTH,
  HANDYMAN_INTERNAL_NOTE_MAX_IDEMPOTENCY_KEY_LENGTH,
  type CreateHandymanInternalNoteBody,
} from './handyman-internal-notes.types';

type ValidationDetail = {
  field: string;
  message: string;
};

const FORBIDDEN_OVERRIDES: readonly string[] = [
  'createdByUserId',
  'created_by_user_id',
  'createdByCareActorId',
  'created_by_care_actor_id',
  'recordedByUserId',
  'recorded_by_user_id',
  'recordedByCareActorId',
  'recorded_by_care_actor_id',
  'actorUserId',
  'actor_user_id',
  'careActorId',
  'care_actor_id',
  'authorId',
  'author_id',
  'authorRole',
  'author_role',
  'tenantPicId',
  'tenant_pic_id',
  'tenantId',
  'tenant_id',
  'clientId',
  'client_id',
  'buildingId',
  'building_id',
  'tenantCompanyId',
  'tenant_company_id',
  'spaceId',
  'space_id',
  'visibilityClassification',
  'visibility_classification',
  'handymanRequestId',
  'handyman_request_id',
  'unlistedIntakeCaseId',
  'unlisted_intake_case_id',
  'subjectType',
  'subject_type',
];

const ALLOWED_CREATE_KEYS = ['content', 'note', 'idempotencyKey'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(details: ValidationDetail[]): never {
  throw AppError.validation('Internal note validation failed.', details);
}

export function parseInternalNoteUuidParam(raw: unknown, field: string): string {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!isValidUuid(value)) {
    fail([{ field, message: `${field} must be a valid UUID.` }]);
  }
  return value;
}

export function parseCreateHandymanInternalNoteBody(
  body: unknown,
  headerIdempotencyKey?: string,
): CreateHandymanInternalNoteBody {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const details: ValidationDetail[] = [];

  for (const key of Object.keys(body)) {
    if (FORBIDDEN_OVERRIDES.includes(key)) {
      details.push({
        field: key,
        message: `${key} must not be supplied; actor identity and scope are derived by the Backend.`,
      });
    } else if (!(ALLOWED_CREATE_KEYS as readonly string[]).includes(key)) {
      details.push({
        field: key,
        message: `${key} is not a supported internal note field.`,
      });
    }
  }
  if (details.length > 0) {
    fail(details);
  }

  if (
    body.content !== undefined &&
    body.note !== undefined &&
    body.content !== body.note
  ) {
    fail([
      {
        field: 'content',
        message: 'content and note must not contradict each other when both are supplied.',
      },
    ]);
  }

  const rawContent = body.content !== undefined ? body.content : body.note;
  let content = '';
  if (typeof rawContent !== 'string') {
    details.push({
      field: 'content',
      message: 'content is required and must be a string.',
    });
  } else if (rawContent.includes('\0')) {
    details.push({
      field: 'content',
      message: 'content must not contain NUL characters.',
    });
  } else {
    const normalized = rawContent.replace(/\r\n?/g, '\n').trim();
    if (normalized.length < 1) {
      details.push({
        field: 'content',
        message: 'content is required and must not be blank.',
      });
    } else if (normalized.length > HANDYMAN_INTERNAL_NOTE_MAX_CONTENT_LENGTH) {
      details.push({
        field: 'content',
        message: `content must be at most ${HANDYMAN_INTERNAL_NOTE_MAX_CONTENT_LENGTH} characters.`,
      });
    } else {
      content = normalized;
    }
  }

  const bodyKey = body.idempotencyKey;
  const headerKey =
    typeof headerIdempotencyKey === 'string' && headerIdempotencyKey.trim().length > 0
      ? headerIdempotencyKey.trim()
      : undefined;

  if (
    bodyKey !== undefined &&
    typeof bodyKey === 'string' &&
    headerKey !== undefined &&
    bodyKey.trim() !== headerKey
  ) {
    details.push({
      field: 'idempotencyKey',
      message: 'Body idempotencyKey and Idempotency-Key header must match when both are provided.',
    });
  }

  const rawKey = bodyKey !== undefined ? bodyKey : headerKey;
  let idempotencyKey = '';
  if (typeof rawKey !== 'string') {
    details.push({
      field: 'idempotencyKey',
      message: 'idempotencyKey is required and must be a string.',
    });
  } else if (rawKey.includes('\0')) {
    details.push({
      field: 'idempotencyKey',
      message: 'idempotencyKey must not contain NUL characters.',
    });
  } else {
    const trimmedKey = rawKey.trim();
    if (
      trimmedKey.length < 1 ||
      trimmedKey.length > HANDYMAN_INTERNAL_NOTE_MAX_IDEMPOTENCY_KEY_LENGTH
    ) {
      details.push({
        field: 'idempotencyKey',
        message: `idempotencyKey must be between 1 and ${HANDYMAN_INTERNAL_NOTE_MAX_IDEMPOTENCY_KEY_LENGTH} characters.`,
      });
    } else {
      idempotencyKey = trimmedKey;
    }
  }

  if (details.length > 0) {
    fail(details);
  }

  return {
    content,
    idempotencyKey,
  };
}

export type OptionalCareWorkspaceScopeFilter = {
  propertyId?: string;
  tenantCompanyId?: string;
  buildingId?: string;
  spaceId?: string;
};

export function parseOptionalCareWorkspaceScopeQuery(
  query: unknown,
): OptionalCareWorkspaceScopeFilter {
  if (query === undefined || query === null) return {};
  if (!isRecord(query)) {
    fail([{ field: 'query', message: 'Query must be an object.' }]);
  }
  const allowed = ['propertyId', 'tenantCompanyId', 'buildingId', 'spaceId'];
  const details: ValidationDetail[] = [];
  for (const key of Object.keys(query)) {
    if (!allowed.includes(key)) {
      details.push({
        field: key,
        message: `${key} is not a supported query parameter.`,
      });
    }
  }
  const out: OptionalCareWorkspaceScopeFilter = {};
  for (const key of allowed as (keyof OptionalCareWorkspaceScopeFilter)[]) {
    const raw = query[key];
    if (raw === undefined) continue;
    if (typeof raw !== 'string' || !isValidUuid(raw.trim().toLowerCase())) {
      details.push({
        field: key,
        message: `${key} must be a valid UUID when provided.`,
      });
    } else {
      out[key] = raw.trim().toLowerCase();
    }
  }
  if (details.length > 0) {
    fail(details);
  }
  return out;
}
