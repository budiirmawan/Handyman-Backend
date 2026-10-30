import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  NON_ACCEPTED_IDENTITY_FIELDS,
  assertNoSuppliedRecordingIdentity,
} from '../handyman-care-authority';
import { normalizeHandymanServiceRequestItemQuantity } from '../handyman-parameterized-catalog/handyman-request-items.service';

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
  // CR-HM-MASTER-IND-01 — approval / cost-responsibility parties. Both are
  // PARTY selections (individual or legal entity from the party master),
  // never actor identities: they are re-validated server-side against the
  // represented Tenant and the Unit's current party roles.
  'approvalTenantCompanyId',
  'costResponsibleTenantCompanyId',
  // CR-HM-BE-CARE-CATALOG-STRUCTURED-01 — the STRUCTURED catalogue intake.
  // Mutually exclusive with the legacy single-service selection
  // (serviceCatalogId/serviceVariantId): an AMBIGUOUS mixed payload is
  // rejected, never guessed.
  'items',
] as const;

/**
 * CR-HM-BE-CARE-CATALOG-STRUCTURED-01 — one structured catalogue item of
 * the Care Building-scoped create. Same field vocabulary as the existing
 * mixed-item engine (`POST /handyman/requests/{id}/items`), plus the
 * reported UOM and the bounded per-item note.
 */
export type CareStructuredRequestItemInput = {
  serviceCatalogId: string;
  serviceVariantId?: string;
  quantity: number;
  uomId?: string;
  attributeValues?: Record<string, string>;
  itemDescription?: string;
  accessCondition?: string;
};

export type CreateBuildingCareRequestBody = {
  tenantCompanyId: string;
  tenantPicId?: string;
  spaceId?: string;
  /** LEGACY single-service selection — mutually exclusive with `items`. */
  serviceCatalogId?: string;
  serviceVariantId?: string;
  description?: string;
  approvalTenantCompanyId?: string;
  costResponsibleTenantCompanyId?: string;
  /** STRUCTURED intake — mutually exclusive with the legacy selection. */
  items?: CareStructuredRequestItemInput[];
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
        message:
          'Unexpected request field; only tenant/unit/service selection, structured items and description are accepted.',
      },
    ]);
  }

  const details: { field: string; message: string }[] = [];
  const tenantCompanyId = readRequiredUuid(
    body.tenantCompanyId,
    'tenantCompanyId',
    details,
  );
  const tenantPicId = readOptionalUuid(body.tenantPicId, 'tenantPicId', details);
  const spaceId = readOptionalUuid(body.spaceId, 'spaceId', details);
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

  // CR-HM-BE-CARE-CATALOG-STRUCTURED-01 — legacy versus structured is an
  // EXCLUSIVE choice:
  //   * `items` present -> the STRUCTURED contract; the legacy single-
  //     service selection keys must be absent (an ambiguous mixed payload
  //     is rejected, never merged or guessed);
  //   * otherwise -> the LEGACY contract, unchanged: `serviceCatalogId`
  //     required, optional `serviceVariantId`.
  // The legacy payload is defined by the ABSENCE of `items`; an explicit
  // `items: null` is not an instruction to fall back to the legacy contract.
  const hasItems = body.items !== undefined;
  const hasLegacySelection =
    body.serviceCatalogId !== undefined ||
    body.serviceVariantId !== undefined;
  if (hasItems && hasLegacySelection) {
    fail([
      {
        field: 'items',
        message:
          'Ambiguous payload: submit either the legacy single-service selection (serviceCatalogId/serviceVariantId) or items[], never both.',
      },
    ]);
  }

  let serviceCatalogId: string | undefined;
  let serviceVariantId: string | undefined;
  let items: CareStructuredRequestItemInput[] | undefined;
  if (hasItems) {
    items = parseStructuredItems(body.items, details);
  } else {
    serviceCatalogId = readRequiredUuid(
      body.serviceCatalogId,
      'serviceCatalogId',
      details,
    );
    serviceVariantId = readOptionalUuid(
      body.serviceVariantId,
      'serviceVariantId',
      details,
    );
  }

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

  if (!tenantCompanyId || details.length) {
    fail(details);
  }
  if (!hasItems && !serviceCatalogId) {
    fail(details);
  }
  return {
    tenantCompanyId,
    ...(tenantPicId === undefined ? {} : { tenantPicId }),
    ...(spaceId === undefined ? {} : { spaceId }),
    ...(serviceCatalogId === undefined ? {} : { serviceCatalogId }),
    ...(serviceVariantId === undefined ? {} : { serviceVariantId }),
    ...(description === undefined ? {} : { description }),
    ...(approvalTenantCompanyId === undefined
      ? {}
      : { approvalTenantCompanyId }),
    ...(costResponsibleTenantCompanyId === undefined
      ? {}
      : { costResponsibleTenantCompanyId }),
    ...(items === undefined ? {} : { items }),
  };
}

const STRUCTURED_ITEM_KEYS = [
  'serviceCatalogId',
  'serviceVariantId',
  'quantity',
  'uomId',
  'attributeValues',
  'itemDescription',
  'accessCondition',
] as const;

/** The exact structured-access-condition vocabulary of the item engine. */
const STRUCTURED_ACCESS_CONDITIONS = [
  'STANDARD',
  'DIFFICULT',
  'HIGH_FLOOR',
  'RESTRICTED',
  'SPECIAL_EQUIPMENT',
] as const;

/** At most 50 structured items in ONE create — a bounded multi-item
 * submission (one request, one idempotency claim). */
const MAX_STRUCTURED_ITEMS = 50;

/**
 * CR-HM-BE-CARE-CATALOG-STRUCTURED-01 — structural validation of the
 * `items[]` array at the transport edge (keys, types, UUID shapes, the
 * quantity grammar and the access-condition vocabulary). Semantic rules —
 * catalogue/variant scope, ACTIVE state, reported-UOM membership and the
 * variant-inheritance walls — belong to the SHARED item engine inside the
 * creation transaction.
 */
function parseStructuredItems(
  raw: unknown,
  details: { field: string; message: string }[],
): CareStructuredRequestItemInput[] | undefined {
  if (!Array.isArray(raw) || raw.length < 1) {
    details.push({
      field: 'items',
      message: 'items must be a non-empty array of structured items.',
    });
    return undefined;
  }
  if (raw.length > MAX_STRUCTURED_ITEMS) {
    details.push({
      field: 'items',
      message: `items may carry at most ${MAX_STRUCTURED_ITEMS} entries.`,
    });
    return undefined;
  }
  const items: CareStructuredRequestItemInput[] = [];
  raw.forEach((entry, index) => {
    const field = `items[${index}]`;
    if (!isRecord(entry)) {
      details.push({ field, message: `${field} must be a JSON object.` });
      return;
    }
    const unknown = Object.keys(entry).filter(
      (key) => !(STRUCTURED_ITEM_KEYS as readonly string[]).includes(key),
    );
    if (unknown.length > 0) {
      details.push({
        field: `${field}.${unknown[0]}`,
        message: `${field}.${unknown[0]} is not an accepted structured item field.`,
      });
      return;
    }
    const serviceCatalogId = readRequiredUuid(
      entry.serviceCatalogId,
      `${field}.serviceCatalogId`,
      details,
    );
    let serviceVariantId: string | undefined;
    if (entry.serviceVariantId === null) {
      details.push({
        field: `${field}.serviceVariantId`,
        message: `${field}.serviceVariantId must be a valid UUID when provided.`,
      });
    } else {
      serviceVariantId = readOptionalUuid(
        entry.serviceVariantId,
        `${field}.serviceVariantId`,
        details,
      );
    }
    let uomId: string | undefined;
    if (entry.uomId === null) {
      details.push({
        field: `${field}.uomId`,
        message: `${field}.uomId must be a valid UUID when provided.`,
      });
    } else {
      uomId = readOptionalUuid(entry.uomId, `${field}.uomId`, details);
    }
    let quantity: number | undefined;
    if (typeof entry.quantity !== 'number' || !Number.isFinite(entry.quantity)) {
      details.push({
        field: `${field}.quantity`,
        message: `${field}.quantity must be a positive number.`,
      });
    } else {
      // The ONE quantity grammar of the shared item engine (positive, at
      // most 4 decimal places, NUMERIC(18,4) bounds) — validated here so
      // a bad quantity never reaches the idempotency claim.
      try {
        quantity = normalizeHandymanServiceRequestItemQuantity(entry.quantity);
      } catch {
        details.push({
          field: `${field}.quantity`,
          message: `${field}.quantity must be a positive number with at most 4 decimal places, smaller than 100000000000000.`,
        });
      }
    }
    let attributeValues: Record<string, string> | undefined;
    if (entry.attributeValues !== undefined) {
      if (
        typeof entry.attributeValues !== 'object' ||
        entry.attributeValues === null ||
        Array.isArray(entry.attributeValues) ||
        Object.values(entry.attributeValues as Record<string, unknown>).some(
          (value) => typeof value !== 'string',
        )
      ) {
        details.push({
          field: `${field}.attributeValues`,
          message: `${field}.attributeValues must be an object of attribute code to string value.`,
        });
      } else {
        attributeValues = entry.attributeValues as Record<string, string>;
      }
    }
    let itemDescription: string | undefined;
    if (entry.itemDescription !== undefined) {
      if (typeof entry.itemDescription !== 'string') {
        details.push({
          field: `${field}.itemDescription`,
          message: `${field}.itemDescription must be a string.`,
        });
      } else {
        const trimmed = entry.itemDescription.trim();
        if (trimmed.length === 0 || trimmed.length > 1000) {
          details.push({
            field: `${field}.itemDescription`,
            message: `${field}.itemDescription must be 1-1000 characters when provided.`,
          });
        } else {
          itemDescription = trimmed;
        }
      }
    }
    let accessCondition: string | undefined;
    if (entry.accessCondition !== undefined) {
      if (
        typeof entry.accessCondition !== 'string' ||
        !(STRUCTURED_ACCESS_CONDITIONS as readonly string[]).includes(
          entry.accessCondition,
        )
      ) {
        details.push({
          field: `${field}.accessCondition`,
          message: `${field}.accessCondition must be STANDARD, DIFFICULT, HIGH_FLOOR, RESTRICTED or SPECIAL_EQUIPMENT.`,
        });
      } else {
        accessCondition = entry.accessCondition;
      }
    }
    if (!serviceCatalogId || quantity === undefined) return;
    items.push({
      serviceCatalogId,
      ...(serviceVariantId === undefined ? {} : { serviceVariantId }),
      quantity,
      ...(uomId === undefined ? {} : { uomId }),
      ...(attributeValues === undefined ? {} : { attributeValues }),
      ...(itemDescription === undefined ? {} : { itemDescription }),
      ...(accessCondition === undefined ? {} : { accessCondition }),
    });
  });
  return items;
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
