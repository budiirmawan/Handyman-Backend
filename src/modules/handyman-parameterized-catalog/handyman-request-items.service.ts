import { AppError } from '../../shared/errors';
import { withTransaction } from '../../database';
import { isValidUuid } from '../clients';
import { assertBuildingScopedResourceAccess } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { serviceCatalogRepository } from '../service-catalog';
import {
  handymanServiceRequestRepository,
} from '../handyman-requests';
import {
  handymanParameterizedCatalogRepository,
} from './handyman-parameterized-catalog.repository';
import {
  handymanServiceRequestItemInvalidError,
  handymanServiceRequestItemNotFoundError,
} from './handyman-parameterized-catalog.errors';
import {
  isHandymanServiceAccessCondition,
  type HandymanServiceAccessCondition,
  type HandymanServiceRequestItemRecord,
  type PublicHandymanServiceRequestItem,
} from './handyman-parameterized-catalog.types';

/**
 * CR-HM-SERVICE-CATALOG-01 PART 01 — MIXED request items.
 *
 * ONE Handyman Service Request may carry SEVERAL services, several AC
 * types and several AC capacities at the same time. That is exactly what
 * these items are: one row per service / variant / attribute-combination
 * with its own quantity and access condition.
 *
 * Intake is deliberately PERMISSIVE about attribute VALUES: the customer or
 * the Care channel may not know the governed attribute vocabulary yet
 * (`capacity` reported as "1 PK", a size nobody configured, an attribute
 * nobody defined). The item therefore records WHAT WAS REPORTED, and the
 * pricing engine later refuses to price it when the reported facts do not
 * satisfy the governed definitions. Refusing at intake would push the
 * unknown-fact problem into a validation error instead of the governed
 * INSPECTION_REQUIRED / MANUAL_REVIEW lane — and the catalogue would then
 * be unable to explain WHY a quote is missing.
 *
 * What intake DOES validate is structure: a bounded set of string-valued
 * attributes with bounded keys and values. It never validates meaning.
 *
 * Scope law: the item is a Building-scoped resource (it inherits the
 * parent request's exact Building), so every read/write runs the BE-02G
 * building guard traced to the parent request.
 */

const ATTRIBUTE_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const MAX_ATTRIBUTES_PER_ITEM = 20;

/** Request states in which an item may still be authored. */
const ITEM_AUTHORABLE_STATUSES = new Set([
  'INTAKE',
  'TRIAGE',
  'INSPECTION_REQUIRED',
  'DIAGNOSIS',
  'READY_FOR_NEXT_STEP',
]);

function toPublic(
  record: HandymanServiceRequestItemRecord,
): PublicHandymanServiceRequestItem {
  return {
    ...record,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function normalizeAttributeValues(
  raw: unknown,
): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw handymanServiceRequestItemInvalidError(
      'attributeValues must be an object of attribute code to value.',
    );
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_ATTRIBUTES_PER_ITEM) {
    throw handymanServiceRequestItemInvalidError(
      `attributeValues may carry at most ${MAX_ATTRIBUTES_PER_ITEM} attributes.`,
    );
  }
  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    const code = key.trim().toUpperCase();
    if (!ATTRIBUTE_KEY_PATTERN.test(code) || code.length > 64) {
      throw handymanServiceRequestItemInvalidError(
        `attributeValues key "${key}" is not a valid attribute code.`,
      );
    }
    if (typeof value !== 'string') {
      throw handymanServiceRequestItemInvalidError(
        `attributeValues["${code}"] must be a string.`,
      );
    }
    const trimmed = value.trim();
    if (trimmed.length > 200) {
      throw handymanServiceRequestItemInvalidError(
        `attributeValues["${code}"] must be at most 200 characters.`,
      );
    }
    out[code] = trimmed;
  }
  return out;
}

function normalizeQuantity(raw: unknown): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw handymanServiceRequestItemInvalidError(
      'quantity must be a positive number.',
    );
  }
  return parsed;
}

/**
 * Resolve the parent request and prove the caller's exact-Building
 * authority over it (BE-02G: no same-Client shortcut).
 */
async function requireRequest(
  handymanRequestId: string,
  actorUserId: string,
): Promise<{
  id: string;
  clientId: string;
  buildingId: string;
  status: string;
}> {
  if (!isValidUuid(handymanRequestId)) {
    throw AppError.validation('Request item validation failed.', [
      {
        field: 'handymanRequestId',
        message: 'handymanRequestId must be a valid UUID.',
      },
    ]);
  }
  const request = await handymanServiceRequestRepository.findById(
    undefined,
    handymanRequestId,
  );
  if (!request) {
    throw handymanServiceRequestItemNotFoundError();
  }
  await assertBuildingScopedResourceAccess(actorUserId, {
    clientId: request.clientId,
    buildingId: request.buildingId,
  });
  return {
    id: request.id,
    clientId: request.clientId,
    buildingId: request.buildingId,
    status: request.status,
  };
}

export type AddHandymanServiceRequestItemInput = {
  serviceCatalogId: string;
  serviceVariantId?: string | null;
  quantity: number;
  attributeValues?: Record<string, string>;
  accessCondition?: HandymanServiceAccessCondition;
};

export async function addHandymanServiceRequestItem(
  handymanRequestId: string,
  input: AddHandymanServiceRequestItemInput,
  actorUserId: string,
): Promise<PublicHandymanServiceRequestItem> {
  const request = await requireRequest(handymanRequestId, actorUserId);
  if (!ITEM_AUTHORABLE_STATUSES.has(request.status)) {
    throw handymanServiceRequestItemInvalidError(
      `Items can no longer be authored on a request in state ${request.status}.`,
    );
  }
  if (!isValidUuid(input.serviceCatalogId)) {
    throw handymanServiceRequestItemInvalidError(
      'serviceCatalogId must be a valid UUID.',
    );
  }
  const quantity = normalizeQuantity(input.quantity);
  const attributeValues = normalizeAttributeValues(input.attributeValues);
  const accessCondition: HandymanServiceAccessCondition =
    input.accessCondition ?? 'STANDARD';
  if (!isHandymanServiceAccessCondition(accessCondition)) {
    throw handymanServiceRequestItemInvalidError(
      'accessCondition must be STANDARD, DIFFICULT, HIGH_FLOOR or RESTRICTED.',
    );
  }

  const service = await serviceCatalogRepository.findById(
    undefined,
    input.serviceCatalogId,
  );
  if (!service || service.clientId !== request.clientId) {
    throw handymanServiceRequestItemInvalidError(
      'serviceCatalogId must reference a catalogue service of this client.',
    );
  }
  if (service.status !== 'ACTIVE') {
    throw handymanServiceRequestItemInvalidError(
      'The referenced catalogue service is not ACTIVE.',
    );
  }

  let serviceVariantId: string | null = null;
  if (input.serviceVariantId !== undefined && input.serviceVariantId !== null) {
    if (!isValidUuid(input.serviceVariantId)) {
      throw handymanServiceRequestItemInvalidError(
        'serviceVariantId must be a valid UUID.',
      );
    }
    const variant =
      await handymanParameterizedCatalogRepository.findVariantById(
        undefined,
        input.serviceVariantId,
      );
    if (
      !variant ||
      variant.clientId !== request.clientId ||
      variant.serviceCatalogId !== service.id
    ) {
      throw handymanServiceRequestItemInvalidError(
        'serviceVariantId must reference a variant of this service.',
      );
    }
    if (variant.status !== 'ACTIVE') {
      throw handymanServiceRequestItemInvalidError(
        'The referenced service variant is not ACTIVE.',
      );
    }
    serviceVariantId = variant.id;
  }

  return withTransaction(async (tx) => {
    const record = await handymanParameterizedCatalogRepository.insertRequestItem(
      tx as never,
      {
        clientId: request.clientId,
        handymanRequestId: request.id,
        serviceCatalogId: service.id,
        serviceVariantId,
        quantity,
        attributeValues,
        accessCondition,
        status: 'ACTIVE',
        createdByUserId: actorUserId,
      },
    );
    await recordOperationalEvent(
      {
        clientId: request.clientId,
        eventType: 'HANDYMAN_SERVICE_REQUEST_ITEM_ADDED',
        entityType: 'HANDYMAN_SERVICE_REQUEST',
        entityId: request.id,
        actorUserId,
        buildingId: request.buildingId,
        summary: `Handyman service request item added for ${service.code}.`,
        metadata: {
          requestItemId: record.id,
          serviceCatalogId: service.id,
          serviceCode: service.code,
          quantity: record.quantity,
          accessCondition: record.accessCondition,
        },
      },
      tx,
    );
    return toPublic(record);
  });
}

export async function listHandymanServiceRequestItems(
  handymanRequestId: string,
  actorUserId: string,
  status?: 'ACTIVE' | 'REMOVED',
): Promise<PublicHandymanServiceRequestItem[]> {
  const request = await requireRequest(handymanRequestId, actorUserId);
  const records = await handymanParameterizedCatalogRepository.listRequestItems(
    undefined,
    request.clientId,
    request.id,
    status,
  );
  return records.map(toPublic);
}

export type UpdateHandymanServiceRequestItemInput = {
  serviceVariantId?: string | null;
  quantity?: number;
  attributeValues?: Record<string, string>;
  accessCondition?: HandymanServiceAccessCondition;
};

export async function updateHandymanServiceRequestItem(
  handymanRequestId: string,
  itemId: string,
  input: UpdateHandymanServiceRequestItemInput,
  actorUserId: string,
): Promise<PublicHandymanServiceRequestItem> {
  const request = await requireRequest(handymanRequestId, actorUserId);
  if (!isValidUuid(itemId)) {
    throw AppError.validation('Request item validation failed.', [
      { field: 'itemId', message: 'itemId must be a valid UUID.' },
    ]);
  }
  const existing = await handymanParameterizedCatalogRepository.findRequestItemById(
    undefined,
    itemId,
  );
  if (
    !existing ||
    existing.clientId !== request.clientId ||
    existing.handymanRequestId !== request.id
  ) {
    throw handymanServiceRequestItemNotFoundError();
  }
  if (!ITEM_AUTHORABLE_STATUSES.has(request.status)) {
    throw handymanServiceRequestItemInvalidError(
      `Items can no longer be authored on a request in state ${request.status}.`,
    );
  }

  const patch: {
    serviceVariantId?: string | null;
    quantity?: number;
    attributeValues?: Record<string, string>;
    accessCondition?: string;
  } = {};
  if (input.quantity !== undefined) {
    patch.quantity = normalizeQuantity(input.quantity);
  }
  if (input.attributeValues !== undefined) {
    patch.attributeValues = normalizeAttributeValues(input.attributeValues);
  }
  if (input.accessCondition !== undefined) {
    if (!isHandymanServiceAccessCondition(input.accessCondition)) {
      throw handymanServiceRequestItemInvalidError(
        'accessCondition must be STANDARD, DIFFICULT, HIGH_FLOOR or RESTRICTED.',
      );
    }
    patch.accessCondition = input.accessCondition;
  }
  if (input.serviceVariantId !== undefined) {
    if (input.serviceVariantId === null) {
      patch.serviceVariantId = null;
    } else {
      if (!isValidUuid(input.serviceVariantId)) {
        throw handymanServiceRequestItemInvalidError(
          'serviceVariantId must be a valid UUID.',
        );
      }
      const variant =
        await handymanParameterizedCatalogRepository.findVariantById(
          undefined,
          input.serviceVariantId,
        );
      if (
        !variant ||
        variant.clientId !== request.clientId ||
        variant.serviceCatalogId !== existing.serviceCatalogId
      ) {
        throw handymanServiceRequestItemInvalidError(
          'serviceVariantId must reference a variant of this service.',
        );
      }
      patch.serviceVariantId = variant.id;
    }
  }

  return withTransaction(async (tx) => {
    const updated = await handymanParameterizedCatalogRepository.updateRequestItem(
      tx as never,
      itemId,
      patch,
    );
    if (!updated) throw handymanServiceRequestItemNotFoundError();
    await recordOperationalEvent(
      {
        clientId: request.clientId,
        eventType: 'HANDYMAN_SERVICE_REQUEST_ITEM_UPDATED',
        entityType: 'HANDYMAN_SERVICE_REQUEST',
        entityId: request.id,
        actorUserId,
        buildingId: request.buildingId,
        summary: `Handyman service request item updated (${updated.serviceCatalogId}).`,
        metadata: {
          requestItemId: updated.id,
          quantity: updated.quantity,
          accessCondition: updated.accessCondition,
        },
      },
      tx,
    );
    return toPublic(updated);
  });
}

/**
 * Removal is a soft removal: the row becomes REMOVED and is never deleted,
 * so an issued quotation keeps its provenance.
 */
export async function removeHandymanServiceRequestItem(
  handymanRequestId: string,
  itemId: string,
  actorUserId: string,
): Promise<PublicHandymanServiceRequestItem> {
  const request = await requireRequest(handymanRequestId, actorUserId);
  if (!isValidUuid(itemId)) {
    throw AppError.validation('Request item validation failed.', [
      { field: 'itemId', message: 'itemId must be a valid UUID.' },
    ]);
  }
  const existing = await handymanParameterizedCatalogRepository.findRequestItemById(
    undefined,
    itemId,
  );
  if (
    !existing ||
    existing.clientId !== request.clientId ||
    existing.handymanRequestId !== request.id
  ) {
    throw handymanServiceRequestItemNotFoundError();
  }
  if (!ITEM_AUTHORABLE_STATUSES.has(request.status)) {
    throw handymanServiceRequestItemInvalidError(
      `Items can no longer be authored on a request in state ${request.status}.`,
    );
  }

  return withTransaction(async (tx) => {
    const updated = await handymanParameterizedCatalogRepository.updateRequestItem(
      tx as never,
      itemId,
      { status: 'REMOVED' },
    );
    if (!updated) throw handymanServiceRequestItemNotFoundError();
    await recordOperationalEvent(
      {
        clientId: request.clientId,
        eventType: 'HANDYMAN_SERVICE_REQUEST_ITEM_REMOVED',
        entityType: 'HANDYMAN_SERVICE_REQUEST',
        entityId: request.id,
        actorUserId,
        buildingId: request.buildingId,
        summary: 'Handyman service request item removed.',
        metadata: { requestItemId: updated.id },
      },
      tx,
    );
    return toPublic(updated);
  });
}
