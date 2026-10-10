import type { HandymanRequestContactInput } from '../handyman-requests/handyman-service-request.types';
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
  reporter?: HandymanRequestContactInput;
  contactPerson?: HandymanRequestContactInput;
};

/** W02 PART 03 — reporter/contact snapshot. Values are data only; they never
 * grant permission, approval authority, or a tenant PIC link. Field-level
 * errors never echo the submitted value. */
function readContactParty(
  value: unknown,
  field: 'reporter' | 'contactPerson',
  details: Detail[],
): HandymanRequestContactInput | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Array.isArray(value)) {
    details.push({ field, message: `${field} must be an object.` });
    return undefined;
  }
  const allowedKeys = ['name', 'phone', 'email'];
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) {
    details.push({ field, message: `${field} contains an unexpected field.` });
    return undefined;
  }
  let ok = true;
  let name = '';
  if (typeof value.name !== 'string') {
    ok = false;
    details.push({ field: `${field}.name`, message: `${field}.name is required.` });
  } else {
    name = value.name.trim();
    if (name.length < 1 || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) {
      ok = false;
      details.push({ field: `${field}.name`, message: `${field}.name must be 1-120 printable characters.` });
    }
  }
  let phone: string | undefined;
  if (value.phone !== undefined && value.phone !== null) {
    const normalized = typeof value.phone === 'string'
      ? value.phone.replace(/[\s().-]/g, '') : '';
    if (!/^[+]?[0-9]{6,15}$/.test(normalized)) {
      ok = false;
      details.push({ field: `${field}.phone`, message: `${field}.phone must be 6-15 digits with an optional leading +.` });
    } else {
      phone = normalized;
    }
  }
  let email: string | undefined;
  if (value.email !== undefined && value.email !== null) {
    const normalized = typeof value.email === 'string' ? value.email.trim().toLowerCase() : '';
    if (normalized.length < 3 || normalized.length > 254 ||
        !/^[^\s@]+@[^\s@]+[.][^\s@]+$/.test(normalized)) {
      ok = false;
      details.push({ field: `${field}.email`, message: `${field}.email must be a valid email address (max 254).` });
    } else {
      email = normalized;
    }
  }
  if (!ok) return undefined;
  return { name, ...(phone ? { phone } : {}), ...(email ? { email } : {}) };
}

function readContactSnapshot(body: Record<string, unknown>, details: Detail[]): {
  reporter?: HandymanRequestContactInput;
  contactPerson?: HandymanRequestContactInput;
} {
  const reporter = readContactParty(body.reporter, 'reporter', details);
  const contactPerson = readContactParty(body.contactPerson, 'contactPerson', details);
  if (body.contactPerson !== undefined && body.reporter === undefined) {
    details.push({ field: 'reporter', message: 'reporter is required when contactPerson is provided.' });
  }
  if (contactPerson && !contactPerson.phone && !contactPerson.email) {
    details.push({ field: 'contactPerson', message: 'contactPerson requires a phone or an email.' });
  }
  return {
    ...(reporter ? { reporter } : {}),
    ...(contactPerson && (contactPerson.phone || contactPerson.email) ? { contactPerson } : {}),
  };
}

/** Care-only intake uses an opaque single-use exchange credential, never an
 * attribution ID, caller-declared actor, tenant, property or unit. */
export function parseCreateCareHandymanServiceRequestBody(
  body: unknown,
): CreateCareHandymanServiceRequestInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const allowed = ['exchangeToken', 'serviceCatalogId', 'serviceVariantId', 'description', 'reporter', 'contactPerson'];
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
  const contacts = readContactSnapshot(body, details);
  if (!exchangeToken || !serviceCatalogId || details.length) fail(details);
  return {
    exchangeToken,
    serviceCatalogId,
    ...(serviceVariantId ? { serviceVariantId } : {}),
    ...(description ? { description } : {}),
    ...contacts,
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

/**
 * W02 PART 02 — Operations queue list query. Strict allowlist: no client or
 * tenant selector is accepted, because the queue scope is derived from the
 * caller's Building assignments only. The cursor is opaque base64url JSON
 * `{c, i}`; a tampered cursor can only pick a page inside the same SQL scope.
 */
export type HandymanOperationsRequestListQuery = {
  status: HandymanServiceRequestStatus | null;
  buildingId: string | null;
  limit: number;
  afterId: string | null;
  afterCreatedAt: string | null;
};

const OPERATIONS_CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export function parseHandymanOperationsRequestListQuery(
  query: unknown,
): HandymanOperationsRequestListQuery {
  const source = isRecord(query) ? query : {};
  const details: Detail[] = [];
  const allowed = ['status', 'buildingId', 'limit', 'cursor'];
  for (const key of Object.keys(source)) {
    if (!allowed.includes(key)) {
      details.push({ field: key, message: 'Unexpected query parameter.' });
    }
  }
  const buildingId = readId(source.buildingId, 'buildingId', false, details) ?? null;

  let status: HandymanServiceRequestStatus | null = null;
  if (source.status !== undefined && source.status !== '') {
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

  let limit = 20;
  if (source.limit !== undefined) {
    const raw = typeof source.limit === 'string' ? source.limit : '';
    if (!/^\d{1,3}$/.test(raw) || Number(raw) < 1 || Number(raw) > 100) {
      details.push({ field: 'limit', message: 'limit must be an integer from 1 to 100.' });
    } else {
      limit = Number(raw);
    }
  }

  let afterId: string | null = null;
  let afterCreatedAt: string | null = null;
  if (source.cursor !== undefined && source.cursor !== '') {
    const decoded = typeof source.cursor === 'string' && source.cursor.length <= 512
      ? decodeOperationsCursor(source.cursor)
      : null;
    if (!decoded) {
      details.push({ field: 'cursor', message: 'cursor is not valid.' });
    } else {
      afterId = decoded.i;
      afterCreatedAt = decoded.c;
    }
  }

  if (details.length) fail(details);
  return { status, buildingId, limit, afterId, afterCreatedAt };
}

function decodeOperationsCursor(
  raw: string,
): { c: string; i: string } | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!isRecord(parsed)) return null;
    if (typeof parsed.c !== 'string' || !OPERATIONS_CURSOR_TIME.test(parsed.c)) return null;
    if (typeof parsed.i !== 'string' || !isValidUuid(parsed.i)) return null;
    return { c: parsed.c, i: parsed.i.toLowerCase() };
  } catch {
    return null;
  }
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
