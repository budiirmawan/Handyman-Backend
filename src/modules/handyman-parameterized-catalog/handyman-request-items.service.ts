import type { PoolClient } from 'pg';
import { AppError } from '../../shared/errors';
import { getPool, withTransaction } from '../../database';
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
  composeCorrectedItemAttributes,
  composeEffectiveItemAttributes,
  loadVariantAttributeValues,
  splitItemAttributes,
} from './handyman-variant-inheritance.service';
import {
  handymanServiceRequestItemInvalidError,
  handymanServiceRequestItemNotFoundError,
} from './handyman-parameterized-catalog.errors';
import {
  HANDYMAN_SERVICE_ACCESS_CONDITION_SELECTOR_KEY,
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
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 100_000_000_000_000 ||
      Math.round(parsed * 10_000) !== parsed * 10_000) {
    throw handymanServiceRequestItemInvalidError(
      'quantity must be positive and fit the Backend NUMERIC(18,4) quantity precision.',
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
  uomId?: string | null;
  itemDescription?: string | null;
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
  // CR-HM-SERVICE-CATALOG-01 PART 02 — the access complexity is a
  // RESERVED price-rule selector key, never a service attribute: an item
  // that tried to smuggle it in as an attribute would shadow the governed
  // access dimension.
  if (
    Object.keys(attributeValues).some(
      (key) => key.toUpperCase() === HANDYMAN_SERVICE_ACCESS_CONDITION_SELECTOR_KEY,
    )
  ) {
    throw handymanServiceRequestItemInvalidError(
      `${HANDYMAN_SERVICE_ACCESS_CONDITION_SELECTOR_KEY} is a reserved key; use accessCondition instead.`,
    );
  }
  const accessCondition: HandymanServiceAccessCondition =
    input.accessCondition ?? 'STANDARD';
  if (!isHandymanServiceAccessCondition(accessCondition)) {
    throw handymanServiceRequestItemInvalidError(
      'accessCondition must be STANDARD, DIFFICULT, HIGH_FLOOR, RESTRICTED or SPECIAL_EQUIPMENT.',
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

  let uomId: string | null = null;
  if (input.uomId !== undefined && input.uomId !== null) {
    if (!isValidUuid(input.uomId)) {
      throw handymanServiceRequestItemInvalidError('uomId must be a valid UUID.');
    }
    const uom = await getPool().query<{ id: string }>(
      `SELECT id FROM units_of_measure WHERE id = $1 AND client_id = $2 AND status = 'ACTIVE'`,
      [input.uomId, request.clientId],
    );
    if (!uom.rows[0]) {
      throw handymanServiceRequestItemInvalidError('uomId must reference an ACTIVE unit of measure for this client.');
    }
    uomId = uom.rows[0].id;
  }
  let itemDescription: string | null = null;
  if (input.itemDescription !== undefined && input.itemDescription !== null) {
    if (typeof input.itemDescription !== 'string' || input.itemDescription.trim().length < 1 || input.itemDescription.trim().length > 1000) {
      throw handymanServiceRequestItemInvalidError('itemDescription must be 1-1000 characters when provided.');
    }
    itemDescription = input.itemDescription.trim();
  }

  let serviceVariantId: string | null = null;
  let variantLabel: string | null = null;
  let variantValues: Record<string, string> = {};
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
    variantLabel = variant.code;
    // CR-HM-SERVICE-CATALOG-01 PART 03 — the variant's ACTIVE configured
    // values are read ONCE, here, and materialised on the item.
    variantValues = await loadVariantAttributeValues(
      request.clientId,
      variant.id,
    );
  }

  // CR-HM-SERVICE-CATALOG-01 PART 03 — the effective attribute set of the
  // item: the variant's values plus the caller's own values. An explicit
  // value that CONTRADICTS the variant is refused (never a silent
  // "last write wins").
  const effective = composeEffectiveItemAttributes({
    variantValues,
    ownValues: attributeValues,
    variantLabel,
  });

  return withTransaction(async (tx) => {
    const record = await handymanParameterizedCatalogRepository.insertRequestItem(
      tx as never,
      {
        clientId: request.clientId,
        handymanRequestId: request.id,
        serviceCatalogId: service.id,
        serviceVariantId,
        quantity,
        attributeValues: effective.attributeValues,
        inheritedAttributeValues: effective.inheritedAttributeValues,
        accessCondition,
        uomId,
        itemDescription,
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
          serviceVariantId: record.serviceVariantId,
          serviceVariantCode: variantLabel,
          inheritedAttributeCodes: effective.inheritedCodes,
          quantity: record.quantity,
          accessCondition: record.accessCondition,
        },
      },
      tx,
    );
    return toPublic(record);
  });
}

/** Care-only insert seam used inside the parent request-create transaction.
 * The workspace/exchange authorization is performed by the caller; actor
 * provenance remains on the immutable request attribution and audit event.
 */
export async function addCareHandymanServiceRequestItemInTransaction(
  executor: Pick<PoolClient, 'query'>,
  request: { id: string; clientId: string; buildingId: string; status: string },
  input: AddHandymanServiceRequestItemInput,
  careActorId: string,
): Promise<PublicHandymanServiceRequestItem> {
  if (!ITEM_AUTHORABLE_STATUSES.has(request.status)) {
    throw handymanServiceRequestItemInvalidError(`Items cannot be authored in request state ${request.status}.`);
  }
  if (!isValidUuid(input.serviceCatalogId)) {
    throw handymanServiceRequestItemInvalidError('serviceCatalogId must be a valid UUID.');
  }
  const quantity = normalizeQuantity(input.quantity);
  const ownValues = normalizeAttributeValues(input.attributeValues);
  if (Object.keys(ownValues).some(key => key.toUpperCase() === HANDYMAN_SERVICE_ACCESS_CONDITION_SELECTOR_KEY)) {
    throw handymanServiceRequestItemInvalidError(`${HANDYMAN_SERVICE_ACCESS_CONDITION_SELECTOR_KEY} is reserved; use accessCondition.`);
  }
  const accessCondition = input.accessCondition ?? 'STANDARD';
  if (!isHandymanServiceAccessCondition(accessCondition)) {
    throw handymanServiceRequestItemInvalidError('accessCondition is not supported.');
  }
  const service = await serviceCatalogRepository.findById(executor, input.serviceCatalogId);
  if (!service || service.clientId !== request.clientId || service.status !== 'ACTIVE') {
    throw handymanServiceRequestItemInvalidError('serviceCatalogId must reference an ACTIVE service in this client.');
  }
  let uomId: string | null = null;
  if (input.uomId !== undefined && input.uomId !== null) {
    if (!isValidUuid(input.uomId)) throw handymanServiceRequestItemInvalidError('uomId must be a valid UUID.');
    const uom = await executor.query<{ id: string }>(
      `SELECT id FROM units_of_measure WHERE id = $1 AND client_id = $2 AND status = 'ACTIVE'`,
      [input.uomId, request.clientId],
    );
    if (!uom.rows[0]) throw handymanServiceRequestItemInvalidError('uomId must reference an ACTIVE unit of measure for this client.');
    uomId = uom.rows[0].id;
  }
  let itemDescription: string | null = null;
  if (input.itemDescription !== undefined && input.itemDescription !== null) {
    if (typeof input.itemDescription !== 'string' || input.itemDescription.trim().length < 1 || input.itemDescription.trim().length > 1000) {
      throw handymanServiceRequestItemInvalidError('itemDescription must be 1-1000 characters when provided.');
    }
    itemDescription = input.itemDescription.trim();
  }
  let variantId: string | null = null;
  let variantLabel: string | null = null;
  let variantValues: Record<string, string> = {};
  if (input.serviceVariantId !== undefined && input.serviceVariantId !== null) {
    if (!isValidUuid(input.serviceVariantId)) throw handymanServiceRequestItemInvalidError('serviceVariantId must be a valid UUID.');
    const variant = await handymanParameterizedCatalogRepository.findVariantById(executor, input.serviceVariantId);
    if (!variant || variant.clientId !== request.clientId || variant.serviceCatalogId !== service.id) {
      throw handymanServiceRequestItemInvalidError('serviceVariantId must reference a variant of the selected service.');
    }
    if (variant.status !== 'ACTIVE') throw handymanServiceRequestItemInvalidError('The selected service variant is not ACTIVE.');
    variantId = variant.id;
    variantLabel = variant.code;
    variantValues = await loadVariantAttributeValues(request.clientId, variant.id);
  }
  const effective = composeEffectiveItemAttributes({ variantValues, ownValues, variantLabel });
  const attributeDefinitions = await handymanParameterizedCatalogRepository.listAttributes(
    executor, request.clientId, service.id, 'ACTIVE');
  const definitionsByCode = new Map(attributeDefinitions.map(attribute => [attribute.code, attribute]));
  for (const [code, rawValue] of Object.entries(effective.attributeValues)) {
    const attribute = definitionsByCode.get(code);
    // Existing item intake deliberately preserves unknown facts for the
    // inspection/manual-review lane; configured facts, however, must match
    // their authoritative data type and allowed-value definition.
    if (!attribute) continue;
    const value = rawValue.trim();
    if (!value || value.length > 200 ||
        (attribute.dataType === 'NUMBER' && (!Number.isFinite(Number(value)) || Number(value) <= 0)) ||
        (attribute.dataType === 'BOOLEAN' && value !== 'true' && value !== 'false') ||
        (attribute.allowedValues.length > 0 && !attribute.allowFreeValue &&
          !attribute.allowedValues.some(allowed => allowed.code === value))) {
      throw handymanServiceRequestItemInvalidError(`Configured attribute ${code} has an invalid type or value.`);
    }
  }
  const record = await handymanParameterizedCatalogRepository.insertRequestItem(executor, {
    clientId: request.clientId,
    handymanRequestId: request.id,
    serviceCatalogId: service.id,
    serviceVariantId: variantId,
    quantity,
    attributeValues: effective.attributeValues,
    inheritedAttributeValues: effective.inheritedAttributeValues,
    accessCondition,
    uomId,
    itemDescription,
    status: 'ACTIVE',
    createdByUserId: null,
  });
  await recordOperationalEvent({
    clientId: request.clientId,
    eventType: 'HANDYMAN_SERVICE_REQUEST_ITEM_ADDED',
    entityType: 'HANDYMAN_SERVICE_REQUEST',
    entityId: request.id,
    actorUserId: null,
    buildingId: request.buildingId,
    summary: `Care-authored Handyman request item added for ${service.code}.`,
    metadata: { requestItemId: record.id, serviceCatalogId: service.id,
      serviceVariantId: variantId, inheritedAttributeCodes: effective.inheritedCodes,
      quantity, uomId, careActorId },
  }, executor);
  return toPublic(record);
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
    inheritedAttributeValues?: Record<string, string>;
    accessCondition?: string;
  } = {};
  if (input.quantity !== undefined) {
    patch.quantity = normalizeQuantity(input.quantity);
  }
  if (input.accessCondition !== undefined) {
    if (!isHandymanServiceAccessCondition(input.accessCondition)) {
      throw handymanServiceRequestItemInvalidError(
        'accessCondition must be STANDARD, DIFFICULT, HIGH_FLOOR, RESTRICTED or SPECIAL_EQUIPMENT.',
      );
    }
    patch.accessCondition = input.accessCondition;
  }
  // CR-HM-SERVICE-CATALOG-01 PART 03 — the variant of an item may only be
  // re-selected to an ACTIVE variant of THIS service and THIS client.
  let variantReselected = false;
  let variantLabel: string | null = null;
  let variantValues: Record<string, string> = {};
  if (input.serviceVariantId !== undefined) {
    if (input.serviceVariantId === null) {
      patch.serviceVariantId = null;
      variantReselected = existing.serviceVariantId !== null;
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
      if (variant.status !== 'ACTIVE') {
        throw handymanServiceRequestItemInvalidError(
          'The referenced service variant is not ACTIVE.',
        );
      }
      patch.serviceVariantId = variant.id;
      variantLabel = variant.code;
      variantReselected = variant.id !== existing.serviceVariantId;
      if (variantReselected) {
        variantValues = await loadVariantAttributeValues(
          request.clientId,
          variant.id,
        );
      }
    }
  }

  // CR-HM-SERVICE-CATALOG-01 PART 03 — the effective attribute set of the
  // corrected item.
  //
  //   * the variant is RE-SELECTED -> the new variant's values are
  //     authoritative and an explicit contradiction is refused (the same
  //     contract as authoring);
  //   * the variant is UNCHANGED -> the values the item was authored with
  //     stay pinned (a catalogue change never rewrites an existing item)
  //     and the caller's explicit values are a GOVERNED CORRECTION.
  const stored = splitItemAttributes({
    attributeValues: existing.attributeValues,
    inheritedAttributeValues: existing.inheritedAttributeValues ?? {},
  });
  const statedValues =
    input.attributeValues === undefined
      ? {}
      : normalizeAttributeValues(input.attributeValues);
  const ownValues: Record<string, string> = { ...stored.ownValues };
  for (const [code, value] of Object.entries(statedValues)) {
    ownValues[code] = value;
  }

  const effective = variantReselected
    ? composeEffectiveItemAttributes({
        variantValues,
        ownValues,
        variantLabel,
      })
    : composeCorrectedItemAttributes({
        ownValues,
        pinnedInherited: stored.inherited,
      });
  patch.attributeValues = effective.attributeValues;
  patch.inheritedAttributeValues = effective.inheritedAttributeValues;

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
          serviceVariantId: updated.serviceVariantId,
          serviceVariantCode: variantLabel,
          inheritedAttributeCodes: effective.inheritedCodes,
          correctedAttributeCodes: Object.keys(statedValues).sort(),
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
