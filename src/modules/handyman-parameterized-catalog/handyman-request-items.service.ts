import type { PoolClient } from 'pg';
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
    if (Object.prototype.hasOwnProperty.call(out, code)) {
      throw handymanServiceRequestItemInvalidError(
        `attributeValues contains the attribute code "${code}" more than once after normalization.`,
      );
    }
    out[code] = trimmed;
  }
  return out;
}

function normalizeQuantity(raw: unknown): number {
  return normalizeHandymanServiceRequestItemQuantity(raw);
}

/**
 * CR-HM-BE-CARE-CATALOG-STRUCTURED-01 — the ONE quantity rule of the
 * structured intake engine, exported so the Care Building-scoped create
 * edge validates the same bounds BEFORE its idempotency claim (no second
 * quantity grammar anywhere):
 *
 *   - a positive, finite number;
 *   - at most 4 decimal places — the exact precision of the
 *     `handyman_service_request_items.quantity NUMERIC(18, 4)` column, so
 *     a submitted quantity is never silently rounded (never silently
 *     dropped) on persist;
 *   - an integer part that fits NUMERIC(18, 4) (< 10^14).
 */
export function normalizeHandymanServiceRequestItemQuantity(
  raw: unknown,
): number {
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw handymanServiceRequestItemInvalidError(
      'quantity must be a positive number.',
    );
  }
  if (parsed >= 1e14) {
    throw handymanServiceRequestItemInvalidError(
      'quantity must be smaller than 100000000000000.',
    );
  }
  // Count the canonical decimal representation instead of multiplying by
  // 10,000 (binary floating-point multiplication can otherwise accept a
  // submitted fifth decimal that rounds away). Scientific notation is
  // expanded arithmetically: 1e-4 has four places; 1e-5 has five.
  const [mantissa = '', exponentText] = parsed.toString().toLowerCase().split('e');
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  const fractionalDigits = mantissa.split('.')[1]?.length ?? 0;
  const decimalPlaces = Math.max(0, fractionalDigits - exponent);
  if (decimalPlaces > 4) {
    throw handymanServiceRequestItemInvalidError(
      'quantity may carry at most 4 decimal places.',
    );
  }
  return parsed;
}

/** The bounded per-item note: trimmed, 1-1000 characters, never empty. */
export function normalizeHandymanServiceRequestItemDescription(
  raw: unknown,
): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') {
    throw handymanServiceRequestItemInvalidError(
      'itemDescription must be a string.',
    );
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > 1000) {
    throw handymanServiceRequestItemInvalidError(
      'itemDescription must be 1-1000 characters when provided.',
    );
  }
  return trimmed;
}

/**
 * CR-HM-BE-CARE-CATALOG-STRUCTURED-01 — the REPORTED UOM of one item must
 * reference an ACTIVE `units_of_measure` master of the request's Client
 * (the same client-scoped master idiom as the quotation-line engine). The
 * reported UOM is a work fact; it never selects or overrides the governed
 * price UOM of the later quotation.
 */
async function resolveReportedUom(
  executor: Parameters<
    typeof handymanParameterizedCatalogRepository.findUnitOfMeasureForClient
  >[0],
  uomId: string,
  clientId: string,
): Promise<string> {
  if (!isValidUuid(uomId)) {
    throw handymanServiceRequestItemInvalidError(
      'uomId must be a valid UUID.',
    );
  }
  const uom =
    await handymanParameterizedCatalogRepository.findUnitOfMeasureForClient(
      executor,
      uomId,
      clientId,
    );
  if (!uom) {
    throw handymanServiceRequestItemInvalidError(
      'uomId must reference a units_of_measure master of this client.',
    );
  }
  if (uom.status !== 'ACTIVE') {
    throw handymanServiceRequestItemInvalidError(
      'The referenced unit of measure is not ACTIVE.',
    );
  }
  return uom.id;
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
  /** CR-HM-BE-CARE-CATALOG-STRUCTURED-01 — optional reported UOM. */
  uomId?: string;
  /** CR-HM-BE-CARE-CATALOG-STRUCTURED-01 — optional per-item note. */
  itemDescription?: string;
  attributeValues?: Record<string, string>;
  accessCondition?: HandymanServiceAccessCondition;
};

/**
 * CR-HM-BE-CARE-CATALOG-STRUCTURED-01 — the request context an authorized
 * caller has ALREADY proven (existence, Client and exact Building
 * authority) before entering the in-transaction authoring lane. The Care
 * staff Building-scoped create gateway builds this context inside its
 * idempotency transaction, where the request row is not yet committed and
 * therefore cannot be re-read through the pool.
 */
export type HandymanServiceRequestItemAuthoringRequestContext = {
  id: string;
  clientId: string;
  buildingId: string;
  status: string;
};

/** Everything one item insert needs, resolved once, insertable anywhere. */
type PreparedServiceRequestItem = {
  serviceCatalogId: string;
  serviceVariantId: string | null;
  quantity: number;
  uomId: string | null;
  itemDescription: string | null;
  attributeValues: Record<string, string>;
  inheritedAttributeValues: Record<string, string>;
  accessCondition: HandymanServiceAccessCondition;
  service: { id: string; code: string };
  variantLabel: string | null;
  inheritedCodes: string[];
};

/**
 * Shared catalogue / variant / quantity / UOM / attribute validation for
 * ONE item. Pure read-path — no write happens here. `executor` is used for
 * every catalogue read so an in-transaction caller observes its own
 * uncommitted parent rows.
 */
async function prepareServiceRequestItem(
  request: Pick<
    HandymanServiceRequestItemAuthoringRequestContext,
    'id' | 'clientId' | 'status'
  >,
  input: AddHandymanServiceRequestItemInput,
  executor: Parameters<
    typeof handymanParameterizedCatalogRepository.findUnitOfMeasureForClient
  >[0],
): Promise<PreparedServiceRequestItem> {
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
  const itemDescription =
    normalizeHandymanServiceRequestItemDescription(input.itemDescription) ??
    null;
  // CR-HM-SERVICE-CATALOG-01 PART 02 — the access complexity is a
  // RESERVED price-rule selector key, never a service attribute: an item
  // that tried to smuggle it in as an attribute would shadow the governed
  // access dimension.
  if (
    Object.keys(attributeValues).some(
      (key) =>
        key.toUpperCase() === HANDYMAN_SERVICE_ACCESS_CONDITION_SELECTOR_KEY,
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
    executor as never,
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
        executor as never,
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

  // CR-HM-BE-CARE-CATALOG-STRUCTURED-01 — the reported UOM is resolved
  // against the request's Client master.
  const uomId =
    input.uomId === undefined || input.uomId === null
      ? null
      : await resolveReportedUom(executor, input.uomId, request.clientId);

  // CR-HM-SERVICE-CATALOG-01 PART 03 — the effective attribute set of the
  // item: the variant's values plus the caller's own values. An explicit
  // value that CONTRADICTS the variant is REFUSED (never a silent
  // "last write wins").
  const effective = composeEffectiveItemAttributes({
    variantValues,
    ownValues: attributeValues,
    variantLabel,
  });

  return {
    serviceCatalogId: service.id,
    serviceVariantId,
    quantity,
    uomId,
    itemDescription,
    attributeValues: effective.attributeValues,
    inheritedAttributeValues: effective.inheritedAttributeValues,
    accessCondition,
    service: { id: service.id, code: service.code },
    variantLabel,
    inheritedCodes: effective.inheritedCodes,
  };
}

/** Persist ONE prepared item + its operational event inside a caller
 * transaction (the single write seam of this engine — no second one). */
async function persistPreparedServiceRequestItem(
  request: Pick<
    HandymanServiceRequestItemAuthoringRequestContext,
    'id' | 'clientId' | 'buildingId'
  >,
  prepared: PreparedServiceRequestItem,
  actorUserId: string,
  client: Pick<PoolClient, 'query'>,
): Promise<PublicHandymanServiceRequestItem> {
  const record = await handymanParameterizedCatalogRepository.insertRequestItem(
    client as never,
    {
      clientId: request.clientId,
      handymanRequestId: request.id,
      serviceCatalogId: prepared.serviceCatalogId,
      serviceVariantId: prepared.serviceVariantId,
      quantity: prepared.quantity,
      uomId: prepared.uomId,
      itemDescription: prepared.itemDescription,
      attributeValues: prepared.attributeValues,
      inheritedAttributeValues: prepared.inheritedAttributeValues,
      accessCondition: prepared.accessCondition,
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
      summary: `Handyman service request item added for ${prepared.service.code}.`,
      metadata: {
        requestItemId: record.id,
        serviceCatalogId: prepared.service.id,
        serviceCode: prepared.service.code,
        serviceVariantId: record.serviceVariantId,
        serviceVariantCode: prepared.variantLabel,
        inheritedAttributeCodes: prepared.inheritedCodes,
        quantity: record.quantity,
        accessCondition: record.accessCondition,
      },
    },
    client,
  );
  return toPublic(record);
}

/**
 * CR-HM-BE-CARE-CATALOG-STRUCTURED-01 — the IN-TRANSACTION authoring lane.
 *
 * The CARE staff Building-scoped create gateway creates the canonical
 * request and its structured items inside ONE caller-owned transaction
 * (the generic idempotency claim). This function performs the exact same
 * frozen rules as `addHandymanServiceRequestItem` — authorable state,
 * catalogue/variant ACTIVE + Client scope, quantity grammar, reported UOM
 * membership, reserved-key and variant-contradiction walls — but accepts an
 * existing transaction client and a request context the caller has ALREADY
 * authorized (Building authority is the caller's own chain; it is never
 * re-derived here). All catalogue reads observe that transaction, so a
 * request row created earlier in the same transaction is visible.
 */
export async function authorHandymanServiceRequestItemInTransaction(
  request: HandymanServiceRequestItemAuthoringRequestContext,
  input: AddHandymanServiceRequestItemInput,
  actorUserId: string,
  client: PoolClient,
): Promise<PublicHandymanServiceRequestItem> {
  const prepared = await prepareServiceRequestItem(request, input, client);
  return persistPreparedServiceRequestItem(
    request,
    prepared,
    actorUserId,
    client,
  );
}

export async function addHandymanServiceRequestItem(
  handymanRequestId: string,
  input: AddHandymanServiceRequestItemInput,
  actorUserId: string,
): Promise<PublicHandymanServiceRequestItem> {
  const request = await requireRequest(handymanRequestId, actorUserId);
  return withTransaction((tx) =>
    authorHandymanServiceRequestItemInTransaction(
      request,
      input,
      actorUserId,
      tx,
    ),
  );
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
  /** CR-HM-BE-CARE-CATALOG-STRUCTURED-01 — re-state or clear (null) the
   * reported UOM; a stated UOM is revalidated against the Client master. */
  uomId?: string | null;
  /** CR-HM-BE-CARE-CATALOG-STRUCTURED-01 — re-state or clear (null) the
   * bounded per-item note. */
  itemDescription?: string | null;
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
    uomId?: string | null;
    itemDescription?: string | null;
    attributeValues?: Record<string, string>;
    inheritedAttributeValues?: Record<string, string>;
    accessCondition?: string;
  } = {};
  if (input.quantity !== undefined) {
    patch.quantity = normalizeQuantity(input.quantity);
  }
  // CR-HM-BE-CARE-CATALOG-STRUCTURED-01 — a re-stated UOM is revalidated
  // (ACTIVE client master); an explicit null CLEARS the reported UOM.
  if (input.uomId !== undefined) {
    patch.uomId =
      input.uomId === null
        ? null
        : await resolveReportedUom(undefined, input.uomId, request.clientId);
  }
  if (input.itemDescription !== undefined) {
    const normalizedDescription =
      input.itemDescription === null
        ? null
        : normalizeHandymanServiceRequestItemDescription(
            input.itemDescription,
          ) ?? null;
    if (input.itemDescription !== null && normalizedDescription === null) {
      throw handymanServiceRequestItemInvalidError(
        'itemDescription must be 1-1000 characters when provided.',
      );
    }
    patch.itemDescription = normalizedDescription;
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
