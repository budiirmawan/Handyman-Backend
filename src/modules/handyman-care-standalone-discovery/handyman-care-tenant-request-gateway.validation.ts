import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  NON_ACCEPTED_IDENTITY_FIELDS,
  assertNoSuppliedRecordingIdentity,
} from '../handyman-care-authority';

/**
 * CR-HM-CC-TENANT-REQUEST-GATEWAY-01 — transport validation for
 * `POST /api/v1/handyman/care/buildings/{buildingId}/requests`.
 *
 * Authority rules at the edge:
 * - only the bounded selection/field keys below are accepted; any other
 *   context key (clientId, buildingId, originChannel, createdByUserId, ...)
 *   is rejected, never silently ignored — the service derives every one of
 *   them server-side;
 * - a supplied recording identity (`tenantPicId` is a REPRESENTED customer
 *   selection and stays accepted; actor/creator spellings such as
 *   `recordedByUserId`, `actorUserId`, `careActorId` are rejected) per the
 *   Care authority SD-19 rule — presenting one is a rejected request, not a
 *   silently-ignored one;
 * - malformed UUIDs are rejected here; unknown TENANT/UNIT/SERVICE ids are
 *   rejected by the service against the server-derived Building scope.
 */

const ALLOWED_BODY_KEYS = [
  'tenantCompanyId',
  'tenantPicId',
  'spaceId',
  'serviceCatalogId',
  'serviceVariantId',
  'description',
  // CR-HM-BE-CARE-NONCATALOG-E2E-01 — optional Care-only intake facts.
  'internalNote',
  'preferredWindowStart',
  'preferredWindowEnd',
  // CR-HM-MASTER-IND-01 — approval / cost-responsibility parties. Both are
  // PARTY selections (individual or legal entity from the party master),
  // never actor identities: they are re-validated server-side against the
  // represented Tenant and the Unit's current party roles.
  'approvalTenantCompanyId',
  'costResponsibleTenantCompanyId',
] as const;

export type CreateBuildingCareRequestBody = {
  tenantCompanyId: string;
  tenantPicId?: string;
  spaceId?: string;
  /** Omitted/null = genuine non-catalog intake; description is then required. */
  serviceCatalogId?: string;
  serviceVariantId?: string;
  description?: string;
  internalNote?: string;
  preferredWindowStart?: string;
  preferredWindowEnd?: string;
  approvalTenantCompanyId?: string;
  costResponsibleTenantCompanyId?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(details: { field: string; message: string }[]): never {
  throw AppError.validation('Request validation failed.', details);
}

function readRequiredUuid(
  value: unknown,
  field: string,
  details: { field: string; message: string }[],
): string | undefined {
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({
      field,
      message: `${field} is required and must be a valid UUID.`,
    });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readOptionalUuid(
  value: unknown,
  field: string,
  details: { field: string; message: string }[],
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return value.trim().toLowerCase();
}

/**
 * Actor-identity spellings that must never be supplied (SD-19): presenting
 * one is a rejected request, not a silently-ignored one.
 *
 * EXCEPTION for this gateway: `tenantPicId` / `tenant_pic_id` stay ACCEPTED
 * here as the REPRESENTED-customer selection — the staff picks an authorized
 * PIC of the selected Tenant exactly like they pick the Tenant/Unit, and the
 * service re-validates it (ACTIVE PIC of that Tenant) inside the creation
 * transaction. It can never become the acting identity: `createdByUserId`
 * is always the authenticated session user, and the represented PIC
 * persists in its own `tenant_pic_id` column. Every other recording/actor
 * spelling (including `tenantId`) remains rejected.
 */
const FORBIDDEN_ACTOR_IDENTITY_FIELDS: readonly string[] =
  NON_ACCEPTED_IDENTITY_FIELDS.filter(
    (field) => field !== 'tenantPicId' && field !== 'tenant_pic_id',
  );

export function parseCreateBuildingCareRequestBody(
  body: unknown,
): CreateBuildingCareRequestBody {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  // SD-19: a caller-supplied actor/creator identity is rejected outright.
  assertNoSuppliedRecordingIdentity(FORBIDDEN_ACTOR_IDENTITY_FIELDS, [body]);

  const unknown = Object.keys(body).filter(
    (key) => !(ALLOWED_BODY_KEYS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    fail([
      {
        field: unknown[0],
        message: 'Unexpected request field; only tenant/unit/service selection and description are accepted.',
      },
    ]);
  }

  const details: { field: string; message: string }[] = [];
  const tenantCompanyId = readRequiredUuid(
    body.tenantCompanyId,
    'tenantCompanyId',
    details,
  );
  const serviceCatalogId = readOptionalUuid(
    body.serviceCatalogId,
    'serviceCatalogId',
    details,
  );
  const tenantPicId = readOptionalUuid(body.tenantPicId, 'tenantPicId', details);
  const spaceId = readOptionalUuid(body.spaceId, 'spaceId', details);
  const serviceVariantId = readOptionalUuid(
    body.serviceVariantId,
    'serviceVariantId',
    details,
  );
  const approvalTenantCompanyId = readOptionalUuid(
    body.approvalTenantCompanyId,
    'approvalTenantCompanyId',
    details,
  );
  const costResponsibleTenantCompanyId = readOptionalUuid(
    body.costResponsibleTenantCompanyId,
    'costResponsibleTenantCompanyId',
    details,
  );

  let description: string | undefined;
  if (body.description !== undefined && body.description !== null) {
    if (typeof body.description !== 'string') {
      details.push({
        field: 'description',
        message: 'description must be a string.',
      });
    } else {
      const trimmed = body.description.trim();
      if (trimmed.length === 0) {
        description = undefined;
      } else if (trimmed.length > 1000) {
        details.push({
          field: 'description',
          message: 'description must be 1-1000 characters when provided.',
        });
      } else {
        description = trimmed;
      }
    }
  }

  let internalNote: string | undefined;
  if (body.internalNote !== undefined && body.internalNote !== null) {
    if (typeof body.internalNote !== 'string') {
      details.push({ field: 'internalNote', message: 'internalNote must be a string.' });
    } else {
      const trimmed = body.internalNote.trim();
      if (trimmed.length < 1 || trimmed.length > 4000) {
        details.push({
          field: 'internalNote',
          message: 'internalNote must be 1-4000 characters when provided.',
        });
      } else {
        internalNote = trimmed;
      }
    }
  }

  const readWindow = (value: unknown, field: string): string | undefined => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string' || value.trim().length === 0) {
      details.push({ field, message: `${field} must be an ISO-8601 date-time.` });
      return undefined;
    }
    const parsed = new Date(value.trim());
    if (Number.isNaN(parsed.getTime())) {
      details.push({ field, message: `${field} must be an ISO-8601 date-time.` });
      return undefined;
    }
    return parsed.toISOString();
  };
  const preferredWindowStart = readWindow(body.preferredWindowStart, 'preferredWindowStart');
  const preferredWindowEnd = readWindow(body.preferredWindowEnd, 'preferredWindowEnd');
  if ((preferredWindowStart === undefined) !== (preferredWindowEnd === undefined)) {
    details.push({
      field: 'preferredWindow',
      message: 'preferredWindowStart and preferredWindowEnd must be supplied together.',
    });
  } else if (preferredWindowStart !== undefined && preferredWindowEnd !== undefined &&
             Date.parse(preferredWindowStart) >= Date.parse(preferredWindowEnd)) {
    details.push({
      field: 'preferredWindow',
      message: 'preferredWindowStart must be strictly before preferredWindowEnd.',
    });
  }

  if (serviceCatalogId === undefined) {
    if (description === undefined) {
      details.push({
        field: 'description',
        message: 'description is required for a non-catalog request (1-1000 characters).',
      });
    }
    if (serviceVariantId !== undefined) {
      details.push({
        field: 'serviceVariantId',
        message: 'serviceVariantId is not accepted for a non-catalog request.',
      });
    }
  }

  if (!tenantCompanyId || details.length) {
    fail(details);
  }
  return {
    tenantCompanyId,
    ...(tenantPicId === undefined ? {} : { tenantPicId }),
    ...(spaceId === undefined ? {} : { spaceId }),
    ...(serviceCatalogId === undefined ? {} : { serviceCatalogId }),
    ...(serviceVariantId === undefined ? {} : { serviceVariantId }),
    ...(description === undefined ? {} : { description }),
    ...(internalNote === undefined ? {} : { internalNote }),
    ...(preferredWindowStart === undefined ? {} : { preferredWindowStart }),
    ...(preferredWindowEnd === undefined ? {} : { preferredWindowEnd }),
    ...(approvalTenantCompanyId === undefined
      ? {}
      : { approvalTenantCompanyId }),
    ...(costResponsibleTenantCompanyId === undefined
      ? {}
      : { costResponsibleTenantCompanyId }),
  };
}

/**
 * CR-HM-18 REQUEST-CANCEL-01 — `POST
 * /api/v1/handyman/care/buildings/{buildingId}/requests/{requestId}/cancel`.
 *
 * The Customer Care actor cancels a tenant request on the tenant's behalf
 * (the same Building Care Authority that created it). Only the two
 * caller-owned inputs are accepted; actor identities and every
 * context/authority key are rejected at the edge, exactly like the create
 * gateway.
 */
const CANCEL_ALLOWED_BODY_KEYS = ['reason', 'idempotencyKey'] as const;

export type CancelBuildingCareRequestBody = {
  reason: string;
  idempotencyKey: string;
};

export function parseCancelBuildingCareRequestBody(
  body: unknown,
): CancelBuildingCareRequestBody {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const source = body as Record<string, unknown>;
  const details: { field: string; message: string }[] = [];
  const unknownKeys = Object.keys(source).filter(
    (key) => !(CANCEL_ALLOWED_BODY_KEYS as readonly string[]).includes(key),
  );
  if (unknownKeys.length > 0) {
    fail(
      unknownKeys.sort().map((field) => ({
        field,
        message: `${field} is not an accepted cancellation field.`,
      })),
    );
  }
  const suppliedIdentity = Object.keys(source).filter((key) =>
    FORBIDDEN_ACTOR_IDENTITY_FIELDS.includes(key),
  );
  if (suppliedIdentity.length > 0) {
    fail(
      suppliedIdentity.map((field) => ({
        field,
        message: `${field} must never be supplied; the actor is the session.`,
      })),
    );
  }
  const reason =
    typeof source.reason === 'string' ? source.reason.trim() : '';
  if (reason.length < 1 || reason.length > 500) {
    details.push({
      field: 'reason',
      message: 'reason is required (1-500 characters).',
    });
  }
  const idempotencyKey =
    typeof source.idempotencyKey === 'string'
      ? source.idempotencyKey.trim()
      : '';
  if (idempotencyKey.length < 1 || idempotencyKey.length > 200) {
    details.push({
      field: 'idempotencyKey',
      message: 'idempotencyKey is required (1-200 characters).',
    });
  }
  if (details.length) fail(details);
  return { reason, idempotencyKey };
}
