import { parseOptionalHandymanRequestedWindow } from '../handyman-scheduling/handyman-scheduling.service';
import type { OptionalHandymanRequestedWindow } from '../handyman-scheduling/handyman-scheduling.types';
import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  HANDYMAN_SERVICE_ACCESS_CONDITIONS,
  type HandymanServiceAccessCondition,
} from '../handyman-parameterized-catalog';
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
  'items',
  'description',
  'preferredWindowStart',
  'preferredWindowEnd',
  // CR-HM-MASTER-IND-01 — approval / cost-responsibility parties. Both are
  // PARTY selections (individual or legal entity from the party master),
  // never actor identities: they are re-validated server-side against the
  // represented Tenant and the Unit's current party roles.
  'approvalTenantCompanyId',
  'costResponsibleTenantCompanyId',
] as const;

/**
 * CR-HM-BE-CARE-CATALOG-STRUCTURED-01 PART 04 — structured Building-session
 * selection.
 *
 * The legacy Building-session contract submits ONE `serviceCatalogId` (plus
 * an optional `serviceVariantId`) and the parent request records it. The
 * structured contract submits a bounded `items[]` list that the EXISTING
 * advanced item engine persists (quantity, UOM, attribute inheritance,
 * variant rules, access condition). The two are mutually exclusive
 * SELECTIONS: mixing them is ambiguous about which row owns the parent
 * request `service_catalog_id`, so it is rejected instead of silently
 * resolved.
 *
 * The item vocabulary mirrors the exchange-token structured intake
 * (`POST /handyman/requests/care`) with one deliberate spelling difference:
 * the per-item free text is `itemDescription` — the persisted column name —
 * so the request-level `description` and the item-level description can
 * never be confused.
 */
export const MAX_BUILDING_CARE_REQUEST_ITEMS = 50;

const ITEM_ALLOWED_KEYS = [
  'serviceCatalogId',
  'serviceVariantId',
  'quantity',
  'uomId',
  'attributeValues',
  'itemDescription',
  'accessCondition',
] as const;

const MAX_ATTRIBUTES_PER_ITEM = 20;
const MAX_ATTRIBUTE_VALUE_LENGTH = 200;

export type CreateBuildingCareRequestItem = {
  serviceCatalogId: string;
  serviceVariantId?: string;
  quantity: number;
  uomId?: string;
  attributeValues?: Record<string, string>;
  itemDescription?: string;
  accessCondition?: HandymanServiceAccessCondition;
};

export type CreateBuildingCareRequestBody = OptionalHandymanRequestedWindow & {
  tenantCompanyId: string;
  tenantPicId?: string;
  spaceId?: string;
  /** Legacy single-service selection. Mutually exclusive with `items`. */
  serviceCatalogId?: string;
  /** Legacy single-service variant. Mutually exclusive with `items`. */
  serviceVariantId?: string;
  /** Structured selection; persisted by the advanced Care item engine. */
  items?: CreateBuildingCareRequestItem[];
  description?: string;
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

/**
 * Parse ONE structured selection item.
 *
 * Structural only: UUID shape, a positive finite quantity, a bounded string
 * attribute map and the governed access-condition vocabulary. Every
 * SEMANTIC rule — service/variant ACTIVE status, Client ownership, UOM
 * ACTIVE + Client ownership, quantity precision, variant contradiction and
 * configured attribute type/value — stays in the advanced Care item engine
 * so the Building session and the exchange-token intake answer identically.
 */
function parseStructuredItem(
  raw: unknown,
  index: number,
  details: { field: string; message: string }[],
): CreateBuildingCareRequestItem {
  const field = `items[${index}]`;
  if (!isRecord(raw)) {
    details.push({ field, message: 'Each item must be an object.' });
    return { serviceCatalogId: '', quantity: 0 };
  }
  const unknownKeys = Object.keys(raw).filter(
    (key) => !(ITEM_ALLOWED_KEYS as readonly string[]).includes(key),
  );
  if (unknownKeys.length > 0) {
    details.push({
      field: `${field}.${unknownKeys[0]}`,
      message: 'Unexpected item field.',
    });
  }

  const serviceCatalogId =
    readRequiredUuid(raw.serviceCatalogId, `${field}.serviceCatalogId`, details) ??
    '';
  const serviceVariantId = readOptionalUuid(
    raw.serviceVariantId,
    `${field}.serviceVariantId`,
    details,
  );
  const uomId = readOptionalUuid(raw.uomId, `${field}.uomId`, details);

  const quantity = raw.quantity;
  if (
    typeof quantity !== 'number' ||
    !Number.isFinite(quantity) ||
    quantity <= 0
  ) {
    details.push({
      field: `${field}.quantity`,
      message: 'quantity is required and must be a positive number.',
    });
  }

  let attributeValues: Record<string, string> | undefined;
  if (raw.attributeValues !== undefined && raw.attributeValues !== null) {
    if (!isRecord(raw.attributeValues)) {
      details.push({
        field: `${field}.attributeValues`,
        message: 'attributeValues must be an object of attribute code to value.',
      });
    } else {
      const entries = Object.entries(raw.attributeValues);
      if (entries.length > MAX_ATTRIBUTES_PER_ITEM) {
        details.push({
          field: `${field}.attributeValues`,
          message: `attributeValues may carry at most ${MAX_ATTRIBUTES_PER_ITEM} attributes.`,
        });
      } else if (
        entries.some(
          ([, value]) =>
            typeof value !== 'string' ||
            value.trim().length > MAX_ATTRIBUTE_VALUE_LENGTH,
        )
      ) {
        details.push({
          field: `${field}.attributeValues`,
          message: `attributeValues must be bounded strings of at most ${MAX_ATTRIBUTE_VALUE_LENGTH} characters.`,
        });
      } else {
        attributeValues = raw.attributeValues as Record<string, string>;
      }
    }
  }

  let accessCondition: HandymanServiceAccessCondition | undefined;
  if (raw.accessCondition !== undefined && raw.accessCondition !== null) {
    if (
      typeof raw.accessCondition !== 'string' ||
      !(HANDYMAN_SERVICE_ACCESS_CONDITIONS as readonly string[]).includes(
        raw.accessCondition,
      )
    ) {
      details.push({
        field: `${field}.accessCondition`,
        message: `accessCondition must be one of ${HANDYMAN_SERVICE_ACCESS_CONDITIONS.join(', ')}.`,
      });
    } else {
      accessCondition = raw.accessCondition as HandymanServiceAccessCondition;
    }
  }

  let itemDescription: string | undefined;
  if (raw.itemDescription !== undefined && raw.itemDescription !== null) {
    if (
      typeof raw.itemDescription !== 'string' ||
      raw.itemDescription.trim().length < 1 ||
      raw.itemDescription.trim().length > 1000
    ) {
      details.push({
        field: `${field}.itemDescription`,
        message: 'itemDescription must be 1-1000 characters when provided.',
      });
    } else {
      itemDescription = raw.itemDescription.trim();
    }
  }

  return {
    serviceCatalogId,
    ...(serviceVariantId === undefined ? {} : { serviceVariantId }),
    quantity: typeof quantity === 'number' ? quantity : 0,
    ...(uomId === undefined ? {} : { uomId }),
    ...(attributeValues === undefined ? {} : { attributeValues }),
    ...(itemDescription === undefined ? {} : { itemDescription }),
    ...(accessCondition === undefined ? {} : { accessCondition }),
  };
}

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
        message: 'Unexpected request field; only tenant/unit/service selection, description and the optional requested window are accepted.',
      },
    ]);
  }

  const details: { field: string; message: string }[] = [];
  const tenantCompanyId = readRequiredUuid(
    body.tenantCompanyId,
    'tenantCompanyId',
    details,
  );

  // PART 04 — the legacy single-service selection and the structured
  // `items[]` selection are mutually exclusive. Presenting both is a
  // rejected request, never a silent precedence rule.
  const structured = body.items !== undefined && body.items !== null;
  let items: CreateBuildingCareRequestItem[] | undefined;
  if (structured) {
    for (const legacyKey of ['serviceCatalogId', 'serviceVariantId'] as const) {
      if (body[legacyKey] !== undefined && body[legacyKey] !== null) {
        details.push({
          field: legacyKey,
          message: `${legacyKey} must not be combined with items; submit either the legacy single-service selection or the structured items list.`,
        });
      }
    }
    if (!Array.isArray(body.items)) {
      details.push({
        field: 'items',
        message: 'items must be an array of structured service items.',
      });
    } else if (
      body.items.length < 1 ||
      body.items.length > MAX_BUILDING_CARE_REQUEST_ITEMS
    ) {
      details.push({
        field: 'items',
        message: `items must contain between 1 and ${MAX_BUILDING_CARE_REQUEST_ITEMS} service items.`,
      });
    } else {
      items = body.items.map((raw, index) =>
        parseStructuredItem(raw, index, details),
      );
    }
  }

  const serviceCatalogId = structured
    ? undefined
    : readRequiredUuid(body.serviceCatalogId, 'serviceCatalogId', details);
  const tenantPicId = readOptionalUuid(body.tenantPicId, 'tenantPicId', details);
  const spaceId = readOptionalUuid(body.spaceId, 'spaceId', details);
  const serviceVariantId = structured
    ? undefined
    : readOptionalUuid(body.serviceVariantId, 'serviceVariantId', details);
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

  if (
    !tenantCompanyId ||
    (structured ? items === undefined : !serviceCatalogId) ||
    details.length
  ) {
    fail(details);
  }
  const dates = parseOptionalHandymanRequestedWindow(body.preferredWindowStart, body.preferredWindowEnd);
  return {
    ...dates,
    tenantCompanyId,
    ...(tenantPicId === undefined ? {} : { tenantPicId }),
    ...(spaceId === undefined ? {} : { spaceId }),
    ...(serviceCatalogId === undefined ? {} : { serviceCatalogId }),
    ...(serviceVariantId === undefined ? {} : { serviceVariantId }),
    ...(items === undefined ? {} : { items }),
    ...(description === undefined ? {} : { description }),
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
