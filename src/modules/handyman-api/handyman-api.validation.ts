import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  isHandymanIntakeEvidenceKind,
  type HandymanIntakeEvidenceKind,
} from '../handyman-evidence';
import {
  isHandymanServiceRequestStatus,
  type CreateHandymanServiceRequestInput,
  type HandymanServiceRequestListFilters,
  type HandymanServiceRequestStatus,
} from '../handyman-requests';
import {
  isPriceCatalogCurrency,
  type PriceCatalogCurrency,
} from '../price-catalog-entries/price-catalog-entry.types';

/**
 * CR-HM-02 PART 05A — request/DTO parsing for the customer-facing Handyman
 * surface. Validation-only: the PART 01–04 services remain the sole business
 * authority (permission, scope, scope-matching, size/MIME policy, hashing).
 *
 * Authority rule (frozen D3): request intake accepts ONLY the provenance
 * handle plus catalogue selection and an optional free description — any
 * context keys smuggled into the body (clientId, tenantCompanyId,
 * buildingId, spaceId, origin*, createdByUserId, …) are IGNORED by contract
 * and can never become authoritative.
 */

type Detail = { field: string; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(details: Detail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

function readId(
  value: unknown,
  field: string,
  required: boolean,
  details: Detail[],
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({
      field,
      message: `${field} ${required ? 'is required and ' : ''}must be a valid UUID.`,
    });
    return undefined;
  }
  return value.trim().toLowerCase();
}

/** Catalog reads are Client-scoped list conventions — `clientId` is required. */
export function parseHandymanClientScopeQuery(query: unknown): string {
  const details: Detail[] = [];
  const clientId = readId(
    isRecord(query) ? query.clientId : undefined,
    'clientId',
    true,
    details,
  );
  if (!clientId || details.length) fail(details);
  return clientId;
}

export type HandymanMaterialProfileListQuery = {
  clientId: string;
  serviceCatalogId?: string;
  serviceVariantId?: string;
};

/** Material-profile catalogue list: Client scope + optional catalogue refinement. */
export function parseHandymanMaterialProfileListQuery(
  query: unknown,
): HandymanMaterialProfileListQuery {
  const source = isRecord(query) ? query : {};
  const details: Detail[] = [];
  const clientId = readId(source.clientId, 'clientId', true, details);
  const serviceCatalogId = readId(
    source.serviceCatalogId,
    'serviceCatalogId',
    false,
    details,
  );
  const serviceVariantId = readId(
    source.serviceVariantId,
    'serviceVariantId',
    false,
    details,
  );
  if (!clientId || details.length) fail(details);
  return {
    clientId,
    ...(serviceCatalogId ? { serviceCatalogId } : {}),
    ...(serviceVariantId ? { serviceVariantId } : {}),
  };
}

export type HandymanMaterialProfileDescribeQuery = {
  buildingId: string;
  currency: PriceCatalogCurrency;
  asOf?: string;
};

/**
 * Reference-price composition context (PART 02): the building anchors the
 * price-catalog lookup scope; the currency selects the governed price lane;
 * `asOf` pins the effective-date resolution time (default: now).
 */
export function parseHandymanMaterialProfileDescribeQuery(
  query: unknown,
): HandymanMaterialProfileDescribeQuery {
  const source = isRecord(query) ? query : {};
  const details: Detail[] = [];
  const buildingId = readId(source.buildingId, 'buildingId', true, details);
  let currency: PriceCatalogCurrency | undefined;
  if (typeof source.currency !== 'string' || !source.currency.trim()) {
    details.push({ field: 'currency', message: 'currency is required.' });
  } else {
    const candidate = source.currency.trim().toUpperCase();
    if (!isPriceCatalogCurrency(candidate)) {
      details.push({
        field: 'currency',
        message: 'currency is not a governed price currency.',
      });
    } else {
      currency = candidate;
    }
  }
  let asOf: string | undefined;
  if (source.asOf !== undefined && source.asOf !== null && source.asOf !== '') {
    if (typeof source.asOf !== 'string' || Number.isNaN(Date.parse(source.asOf))) {
      details.push({
        field: 'asOf',
        message: 'asOf must be an ISO-8601 date-time when provided.',
      });
    } else {
      asOf = new Date(source.asOf).toISOString();
    }
  }
  if (!buildingId || !currency || details.length) fail(details);
  return { buildingId, currency, ...(asOf !== undefined ? { asOf } : {}) };
}

export type CreateCareHandymanServiceRequestInput = {
  exchangeToken: string;
  serviceCatalogId: string;
  serviceVariantId?: string;
  description?: string;
};

/** Care-only intake uses an opaque single-use exchange credential, never an
 * attribution ID, caller-declared actor, tenant, property or unit. */
export function parseCreateCareHandymanServiceRequestBody(
  body: unknown,
): CreateCareHandymanServiceRequestInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const allowed = ['exchangeToken', 'serviceCatalogId', 'serviceVariantId', 'description'];
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    fail([{ field: 'body', message: 'Unexpected care request context field.' }]);
  }
  const details: Detail[] = [];
  const serviceCatalogId = readId(body.serviceCatalogId, 'serviceCatalogId', true, details);
  const serviceVariantId = readId(body.serviceVariantId, 'serviceVariantId', false, details);
  const exchangeToken = typeof body.exchangeToken === 'string' &&
    body.exchangeToken.length > 0 && body.exchangeToken.length <= 512
    ? body.exchangeToken : undefined;
  if (!exchangeToken) {
    details.push({ field: 'exchangeToken', message: 'A single-use exchange token is required.' });
  }
  let description: string | undefined;
  if (body.description !== undefined) {
    if (typeof body.description !== 'string' ||
        body.description.trim().length < 1 || body.description.trim().length > 1000) {
      details.push({ field: 'description', message: 'description must be 1-1000 characters.' });
    } else {
      description = body.description.trim();
    }
  }
  if (!exchangeToken || !serviceCatalogId || details.length) fail(details);
  return {
    exchangeToken,
    serviceCatalogId,
    ...(serviceVariantId ? { serviceVariantId } : {}),
    ...(description ? { description } : {}),
  };
}

export function parseHandymanRequestIdParam(raw: string): string {
  const details: Detail[] = [];
  const id = readId(raw, 'handymanRequestId', true, details);
  if (!id || details.length) fail(details);
  return id;
}

/**
 * CR-HM-17 GAP PART 01 — Customer Care request list query parser.
 * `clientId` is required; optional `tenantCompanyId`, `buildingId`,
 * `spaceId`, `channelAttributionId`, and governed F1 `status` narrow the
 * Client-scoped query.
 */
export function parseHandymanServiceRequestListQuery(
  query: unknown,
): HandymanServiceRequestListFilters {
  const source = isRecord(query) ? query : {};
  const details: Detail[] = [];
  const clientId = readId(source.clientId, 'clientId', true, details);
  const tenantCompanyId = readId(
    source.tenantCompanyId,
    'tenantCompanyId',
    false,
    details,
  );
  const buildingId = readId(source.buildingId, 'buildingId', false, details);
  const spaceId = readId(source.spaceId, 'spaceId', false, details);
  const channelAttributionId = readId(
    source.channelAttributionId,
    'channelAttributionId',
    false,
    details,
  );
  let status: HandymanServiceRequestStatus | undefined;
  if (
    source.status !== undefined &&
    source.status !== null &&
    source.status !== ''
  ) {
    const normalized =
      typeof source.status === 'string' ? source.status.trim() : source.status;
    if (!isHandymanServiceRequestStatus(normalized)) {
      details.push({
        field: 'status',
        message: 'status is not a recognized Handyman request status.',
      });
    } else {
      status = normalized;
    }
  }
  if (!clientId || details.length) fail(details);
  return {
    clientId,
    ...(tenantCompanyId ? { tenantCompanyId } : {}),
    ...(buildingId ? { buildingId } : {}),
    ...(spaceId ? { spaceId } : {}),
    ...(channelAttributionId ? { channelAttributionId } : {}),
    ...(status ? { status } : {}),
  };
}

export function parseHandymanMaterialProfileIdParam(raw: string): string {
  const details: Detail[] = [];
  const id = readId(raw, 'profileId', true, details);
  if (!id || details.length) fail(details);
  return id;
}

/**
 * Request-intake body: ONLY the attribution provenance handle, the catalogue
 * selection and an optional free description are read. Every other body key —
 * context or otherwise — is ignored by contract (frozen D3); the PART 03
 * service derives the authoritative context from the immutable attribution.
 */
export function parseCreateHandymanServiceRequestBody(
  body: unknown,
): CreateHandymanServiceRequestInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const details: Detail[] = [];
  const channelAttributionId = readId(
    body.channelAttributionId,
    'channelAttributionId',
    true,
    details,
  );
  const serviceCatalogId = readId(
    body.serviceCatalogId,
    'serviceCatalogId',
    true,
    details,
  );
  const serviceVariantId = readId(
    body.serviceVariantId,
    'serviceVariantId',
    false,
    details,
  );
  let description: string | undefined;
  if (body.description !== undefined && body.description !== null) {
    if (typeof body.description !== 'string') {
      details.push({ field: 'description', message: 'description must be a string.' });
    } else if (body.description.trim().length > 0) {
      description = body.description;
    }
  }
  if (!channelAttributionId || !serviceCatalogId || details.length) {
    fail(details);
  }
  return {
    channelAttributionId,
    serviceCatalogId,
    ...(serviceVariantId ? { serviceVariantId } : {}),
    ...(description !== undefined ? { description } : {}),
  };
}

/** Multipart `evidenceKind` field — the bounded PHOTO/VIDEO kind only. */
export function parseHandymanIntakeEvidenceKindField(
  value: unknown,
): HandymanIntakeEvidenceKind {
  if (!isHandymanIntakeEvidenceKind(value)) {
    fail([
      {
        field: 'evidenceKind',
        message: 'evidenceKind is required and must be PHOTO or VIDEO.',
      },
    ]);
  }
  return value;
}
