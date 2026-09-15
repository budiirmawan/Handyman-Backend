import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';

/**
 * CR-HM-BE-02 RUN 3 — Strict HTTP contract for Handyman Provider designation
 * endpoints. The transport layer accepts ONLY the allowlisted fields; every
 * other key — including protected server-derived fields — is rejected with
 * 400 VALIDATION_ERROR details. All business authority (client/vendor checks,
 * entitlement, duplicates, lifecycle guards) stays in the Run 1 service; this
 * module only governs the wire shape.
 */

type Detail = { field: string; message: string };

export const CREATE_HANDYMAN_PROVIDER_HTTP_BODY_FIELDS = ['vendorId'] as const;

export const UPDATE_HANDYMAN_PROVIDER_STATUS_HTTP_BODY_FIELDS = ['status'] as const;

/** Protected designation fields on create: server-derived, never accepted. */
const CREATE_HANDYMAN_PROVIDER_PROTECTED_FIELDS: Record<string, string> = {
  clientId: 'Client id comes from the route and is not accepted in the body.',
  createdByUserId: 'Created-by identity comes from the authenticated actor.',
  status: 'Status is server-managed and set to ACTIVE on designation.',
  id: 'Provider id is server-generated.',
  createdAt: 'Timestamps are server-generated.',
  updatedAt: 'Timestamps are server-generated.',
};

/** Protected fields on the status-transition endpoint (only `status` allowed). */
const UPDATE_HANDYMAN_PROVIDER_STATUS_PROTECTED_FIELDS: Record<string, string> = {
  vendorId: 'Vendor id is immutable after designation.',
  clientId: 'Client id is immutable after designation.',
  createdByUserId: 'Created-by identity is immutable after designation.',
  id: 'Provider id is server-generated.',
  createdAt: 'Timestamps are server-generated.',
  updatedAt: 'Timestamps are server-generated.',
};

const HANDYMAN_PROVIDER_STATUS_VALUES = new Set(['ACTIVE', 'INACTIVE']);

function fail(details: Detail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseUuidParam(raw: unknown, field: string, label: string): string {
  if (typeof raw !== 'string') {
    fail([{ field, message: `${label} must be a string.` }]);
  }
  const value = (raw as string).trim().toLowerCase();
  if (!isValidUuid(value)) {
    fail([{ field, message: `${label} must be a valid UUID.` }]);
  }
  return value;
}

/** `:providerId` path segment → normalized lowercase UUID. */
export function parseHandymanProviderIdParam(raw: string): string {
  return parseUuidParam(raw, 'providerId', 'Provider id');
}

/** `:clientId` path segment on designation routes → normalized UUID. */
export function parseHandymanProviderClientIdParam(raw: string): string {
  return parseUuidParam(raw, 'clientId', 'Client id');
}

/** `:buildingId` path segment on eligibility reads → normalized UUID. */
export function parseHandymanProviderBuildingIdParam(raw: string): string {
  return parseUuidParam(raw, 'buildingId', 'Building id');
}

/**
 * `POST /clients/:clientId/handyman-providers` body → `{ vendorId }`.
 * Only `vendorId` is accepted; UUID validity is checked here so the service
 * only ever receives governed input.
 */
export function parseCreateHandymanProviderHttpBody(body: unknown): {
  vendorId: string;
} {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const details: Detail[] = [];

  for (const field of Object.keys(body)) {
    const protectedMessage = CREATE_HANDYMAN_PROVIDER_PROTECTED_FIELDS[field];
    if (protectedMessage) {
      details.push({ field, message: protectedMessage });
      continue;
    }
    if (
      !(CREATE_HANDYMAN_PROVIDER_HTTP_BODY_FIELDS as readonly string[]).includes(
        field,
      )
    ) {
      details.push({ field, message: `${field} is not allowed.` });
    }
  }

  const vendorId = body.vendorId;
  if (typeof vendorId !== 'string' || vendorId.trim() === '') {
    details.push({ field: 'vendorId', message: 'Vendor id is required.' });
  } else if (!isValidUuid(vendorId.trim().toLowerCase())) {
    details.push({ field: 'vendorId', message: 'Vendor id must be a valid UUID.' });
  }

  if (details.length > 0) {
    fail(details);
  }

  return { vendorId: (vendorId as string).trim().toLowerCase() };
}

/**
 * `PATCH /handyman-providers/:providerId` body → `{ status }`. Only the
 * ACTIVE|INACTIVE enum is accepted at the edge; the Run 1 service still
 * re-asserts the full lifecycle guards (fail-safe deactivate, re-validated
 * reactivate) for programmatic callers.
 */
export function parseUpdateHandymanProviderStatusHttpBody(body: unknown): {
  status: 'ACTIVE' | 'INACTIVE';
} {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const details: Detail[] = [];

  for (const field of Object.keys(body)) {
    const protectedMessage = UPDATE_HANDYMAN_PROVIDER_STATUS_PROTECTED_FIELDS[field];
    if (protectedMessage) {
      details.push({ field, message: protectedMessage });
      continue;
    }
    if (
      !(
        UPDATE_HANDYMAN_PROVIDER_STATUS_HTTP_BODY_FIELDS as readonly string[]
      ).includes(field)
    ) {
      details.push({ field, message: `${field} is not allowed.` });
    }
  }

  const status = body.status;
  if (typeof status !== 'string' || status.trim() === '') {
    details.push({ field: 'status', message: 'Status is required.' });
  } else if (!HANDYMAN_PROVIDER_STATUS_VALUES.has(status.trim().toUpperCase())) {
    details.push({
      field: 'status',
      message: 'Status must be ACTIVE or INACTIVE.',
    });
  }

  if (details.length > 0) {
    fail(details);
  }

  return {
    status: (status as string).trim().toUpperCase() as 'ACTIVE' | 'INACTIVE',
  };
}
