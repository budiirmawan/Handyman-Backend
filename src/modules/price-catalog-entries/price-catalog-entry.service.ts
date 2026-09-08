import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import { assertActiveAllowedCurrency } from '../client-monetary-contexts';
import {
  buildingAccessDeniedError,
  contextAccessService,
  getAccessibleBuildingIds,
  getAccessibleClientIds,
} from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import {
  priceCatalogAlreadyReplacedError,
  priceCatalogApproverInvalidError,
  priceCatalogBuildingInvalidError,
  priceCatalogBuildingNotFoundError,
  priceCatalogClientInvalidError,
  priceCatalogEffectiveWindowInvalidError,
  priceCatalogEntryNotFoundError,
  priceCatalogIdempotencyConflictError,
  priceCatalogItemInvalidError,
  priceCatalogItemNotFoundError,
  priceCatalogNotActiveError,
  priceCatalogNotDraftError,
  priceCatalogUomInvalidError,
  priceCatalogUomNotFoundError,
  priceCatalogVendorInvalidError,
  priceCatalogVendorNotFoundError,
  priceCatalogWindowOverlapError,
} from './price-catalog-entry.errors';
import { priceCatalogEntryRepository } from './price-catalog-entry.repository';
import type {
  CorrectPriceCatalogEntryInput,
  CreatePriceCatalogEntryInput,
  NewPriceCatalogEntry,
  PriceCatalogEntryFilters,
  PriceCatalogEntryRecord,
  PublicPriceCatalogEntry,
  ReplacePriceCatalogEntryInput,
  UpdatePriceCatalogEntryInput,
} from './price-catalog-entry.types';

/**
 * CR-BE-PRICE-01 PART 01 — Price Authority commands and reads.
 *
 * Governed semantics (docs/CR-BE-PRICE-01_START_GOVERNANCE.md):
 *   - v1 is MATERIAL-only; every entry prices exactly one Inventory Item per
 *     1 unit of an explicit UOM in one supported currency.
 *   - Scope tiers: Client-wide / Building / Vendor / Vendor+Building via
 *     nullable keys; overlap within one tier is rejected structurally by the
 *     ACTIVE-window exclusion constraint (mapped to a 409 overlap error).
 *   - Lifecycle DRAFT → ACTIVE → INACTIVE only. ACTIVE rows are never updated
 *     in place; change is replacement (predecessor closed + successor
 *     activated atomically, one successor per predecessor). No deletes.
 *   - v1 provenance is MANUAL only; no backfill, no adoption.
 *   - This module creates no RFQ, quotation, award, PO, commitment, or actual
 *     cost and is never a commitment origin.
 */

const EXCLUSION_VIOLATION = '23P01';
const UNIQUE_VIOLATION = '23505';
// CR-BE-SVC-01 PART 05: the single ACTIVE-window exclusion was split into two
// mode-scoped partials (MATERIAL keeps item/uom/currency; SERVICE uses
// service/currency with no UOM). Either tripping is a governed overlap.
const ACTIVE_WINDOW_EXCLUSIONS = new Set([
  'price_catalog_entries_active_window_exclusion',
  'price_catalog_entries_material_window_exclusion',
  'price_catalog_entries_service_window_exclusion',
]);
const SUCCESSOR_UNIQUE = 'price_catalog_entries_successor_unique';

type ReferenceContext = {
  clientId: string;
  buildingId: string | null;
  vendorId: string | null;
  sourceMode: PriceCatalogEntryRecord['sourceMode'];
  itemId: string | null;
  uomId: string | null;
  serviceId: string | null;
  currency: PriceCatalogEntryRecord['currency'];
  unitPrice: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  sourceReference: string | null;
  notes: string | null;
  approvedByUserId: string | null;
};

export function toPublicPriceCatalogEntry(record: PriceCatalogEntryRecord): PublicPriceCatalogEntry {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    vendorId: record.vendorId,
    sourceMode: record.sourceMode,
    entryKind: record.entryKind,
    itemId: record.itemId,
    uomId: record.uomId,
    serviceId: record.serviceId,
    currency: record.currency,
    unitPrice: record.unitPrice,
    effectiveFrom: record.effectiveFrom.toISOString(),
    effectiveTo: record.effectiveTo?.toISOString() ?? null,
    status: record.status,
    activatedAt: record.activatedAt?.toISOString() ?? null,
    activatedByUserId: record.activatedByUserId,
    deactivatedAt: record.deactivatedAt?.toISOString() ?? null,
    deactivatedByUserId: record.deactivatedByUserId,
    replacedByEntryId: record.replacedByEntryId,
    sourceType: record.sourceType,
    sourceReference: record.sourceReference,
    notes: record.notes,
    approvedByUserId: record.approvedByUserId,
    approvedAt: record.approvedAt?.toISOString() ?? null,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function createFingerprint(input: CreatePriceCatalogEntryInput): string {
  const canonical = JSON.stringify({
    clientId: input.clientId,
    buildingId: input.buildingId ?? null,
    vendorId: input.vendorId ?? null,
    sourceMode: input.sourceMode,
    itemId: input.sourceMode === 'MATERIAL' ? input.itemId ?? null : null,
    uomId: input.sourceMode === 'MATERIAL' ? input.uomId ?? null : null,
    serviceId: input.sourceMode === 'SERVICE' ? input.serviceId ?? null : null,
    currency: input.currency,
    unitPrice: input.unitPrice,
    effectiveFrom: new Date(input.effectiveFrom).toISOString(),
    effectiveTo: input.effectiveTo ? new Date(input.effectiveTo).toISOString() : null,
    sourceReference: input.sourceReference ?? null,
    notes: input.notes ?? null,
    approvedByUserId: input.approvedByUserId ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function replaceFingerprint(
  predecessorId: string,
  input: ReplacePriceCatalogEntryInput,
): string {
  const canonical = JSON.stringify({
    predecessorId,
    unitPrice: input.unitPrice,
    effectiveFrom: new Date(input.effectiveFrom).toISOString(),
    effectiveTo: input.effectiveTo ? new Date(input.effectiveTo).toISOString() : null,
    sourceReference: input.sourceReference ?? null,
    notes: input.notes ?? null,
    approvedByUserId: input.approvedByUserId ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function correctFingerprint(
  predecessorId: string,
  input: CorrectPriceCatalogEntryInput,
): string {
  // The reason is part of the governed act, so it joins the idempotency
  // fingerprint: a replayed key with a different reason is a conflict, never
  // a silent reuse of earlier evidence.
  const canonical = JSON.stringify({
    predecessorId,
    command: 'correct',
    unitPrice: input.unitPrice,
    effectiveFrom: new Date(input.effectiveFrom).toISOString(),
    effectiveTo: input.effectiveTo ? new Date(input.effectiveTo).toISOString() : null,
    sourceReference: input.sourceReference ?? null,
    notes: input.notes ?? null,
    approvedByUserId: input.approvedByUserId ?? null,
    reason: input.reason,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function isExclusionOverlap(error: unknown): boolean {
  const candidate = error as { code?: unknown; constraint?: unknown };
  return (
    candidate?.code === EXCLUSION_VIOLATION &&
    typeof candidate.constraint === 'string' &&
    ACTIVE_WINDOW_EXCLUSIONS.has(candidate.constraint)
  );
}

function isSuccessorConflict(error: unknown): boolean {
  const candidate = error as { code?: unknown; constraint?: unknown };
  return (
    candidate?.code === UNIQUE_VIOLATION &&
    candidate.constraint === SUCCESSOR_UNIQUE
  );
}

/** Scope gate: writes and single-row reads. Deny without leaking. */
async function assertEntryAccess(
  actorUserId: string,
  entry: Pick<PriceCatalogEntryRecord, 'clientId' | 'buildingId'>,
): Promise<void> {
  if (entry.buildingId !== null) {
    await contextAccessService.assertBuildingAccess(
      actorUserId,
      entry.buildingId,
    );
    return;
  }
  if (!(await contextAccessService.canAccessClient(actorUserId, entry.clientId))) {
    throw buildingAccessDeniedError();
  }
}

async function validateReferences(
  client: PoolClient,
  refs: {
    clientId: string;
    buildingId: string | null;
    vendorId: string | null;
    sourceMode: PriceCatalogEntryRecord['sourceMode'];
    itemId: string | null;
    uomId: string | null;
    serviceId: string | null;
    approvedByUserId: string | null;
  },
): Promise<void> {
  const subject = await priceCatalogEntryRepository.loadClient(
    client,
    refs.clientId,
  );
  if (!subject || subject.status !== 'ACTIVE') {
    throw priceCatalogClientInvalidError();
  }

  if (refs.buildingId !== null) {
    const building = await priceCatalogEntryRepository.loadBuilding(
      client,
      refs.buildingId,
    );
    if (!building) throw priceCatalogBuildingNotFoundError();
    if (
      building.clientId !== refs.clientId ||
      building.status !== 'ACTIVE'
    ) {
      throw priceCatalogBuildingInvalidError();
    }
  }

  if (refs.vendorId !== null) {
    const vendor = await priceCatalogEntryRepository.loadVendor(
      client,
      refs.vendorId,
    );
    if (!vendor) throw priceCatalogVendorNotFoundError();
    if (vendor.clientId !== refs.clientId || vendor.status !== 'ACTIVE') {
      throw priceCatalogVendorInvalidError();
    }
  }

  // Subject authority is mode-dispatched. MATERIAL ⇒ Inventory Item + UOM;
  // SERVICE ⇒ governed service_catalog (no UOM, no quantity).
  if (refs.sourceMode === 'SERVICE') {
    const service = await priceCatalogEntryRepository.loadService(
      client,
      refs.serviceId!,
    );
    if (!service) throw priceCatalogItemNotFoundError();
    if (service.clientId !== refs.clientId || service.status !== 'ACTIVE') {
      throw priceCatalogItemInvalidError();
    }
  } else {
    const item = await priceCatalogEntryRepository.loadItem(
      client,
      refs.itemId!,
    );
    if (!item) throw priceCatalogItemNotFoundError();
    if (item.clientId !== refs.clientId || item.status !== 'ACTIVE') {
      throw priceCatalogItemInvalidError();
    }

    const uom = await priceCatalogEntryRepository.loadUom(client, refs.uomId!);
    if (!uom) throw priceCatalogUomNotFoundError();
    if (uom.clientId !== refs.clientId || uom.status !== 'ACTIVE') {
      throw priceCatalogUomInvalidError();
    }
  }

  if (refs.approvedByUserId !== null) {
    const approver = await priceCatalogEntryRepository.loadUser(
      client,
      refs.approvedByUserId,
    );
    if (!approver || approver.status !== 'ACTIVE') {
      throw priceCatalogApproverInvalidError();
    }
  }
}

function assertValidWindow(effectiveFrom: Date, effectiveTo: Date | null): void {
  if (effectiveTo !== null && effectiveTo.getTime() <= effectiveFrom.getTime()) {
    throw priceCatalogEffectiveWindowInvalidError();
  }
}

type EventMetadata = Record<string, unknown>;

function entryMetadata(
  record: PriceCatalogEntryRecord,
  extra: EventMetadata = {},
): EventMetadata {
  return {
    sourceMode: record.sourceMode,
    entryKind: record.entryKind,
    itemId: record.itemId,
    uomId: record.uomId,
    serviceId: record.serviceId,
    currency: record.currency,
    unitPrice: record.unitPrice,
    buildingId: record.buildingId,
    vendorId: record.vendorId,
    effectiveFrom: record.effectiveFrom.toISOString(),
    effectiveTo: record.effectiveTo?.toISOString() ?? null,
    sourceType: record.sourceType,
    ...extra,
  };
}

/** Creates an idempotent DRAFT price entry. No other record is touched. */
export async function createPriceCatalogEntry(
  input: CreatePriceCatalogEntryInput,
  actorUserId: string,
): Promise<PublicPriceCatalogEntry> {
  return withTransaction(async (client) => {
    await assertEntryAccess(actorUserId, {
      clientId: input.clientId,
      buildingId: input.buildingId ?? null,
    });

    const existing = await priceCatalogEntryRepository.findByIdempotencyKey(
      client,
      input.clientId,
      input.idempotencyKey,
    );
    if (existing) {
      if (existing.idempotencyFingerprint !== createFingerprint(input)) {
        throw priceCatalogIdempotencyConflictError();
      }
      return toPublicPriceCatalogEntry(existing);
    }

    const context: ReferenceContext = {
      clientId: input.clientId,
      buildingId: input.buildingId ?? null,
      vendorId: input.vendorId ?? null,
      sourceMode: input.sourceMode,
      itemId: input.sourceMode === 'MATERIAL' ? input.itemId ?? null : null,
      uomId: input.sourceMode === 'MATERIAL' ? input.uomId ?? null : null,
      serviceId: input.sourceMode === 'SERVICE' ? input.serviceId ?? null : null,
      currency: input.currency,
      unitPrice: input.unitPrice,
      effectiveFrom: new Date(input.effectiveFrom),
      effectiveTo: input.effectiveTo ? new Date(input.effectiveTo) : null,
      sourceReference: input.sourceReference ?? null,
      notes: input.notes ?? null,
      approvedByUserId: input.approvedByUserId ?? null,
    };

    await assertActiveAllowedCurrency(input.clientId, input.currency);
    await validateReferences(client, context);
    assertValidWindow(context.effectiveFrom, context.effectiveTo);

    const entry: NewPriceCatalogEntry = {
      ...context,
      entryKind: context.vendorId === null ? 'REFERENCE' : 'VENDOR_CONTRACT',
      idempotencyKey: input.idempotencyKey,
      idempotencyFingerprint: createFingerprint(input),
      createdByUserId: actorUserId,
    };

    const result = await priceCatalogEntryRepository.insertEntry(
      client,
      entry,
      false,
    );
    if (!result.created) {
      if (result.record.idempotencyFingerprint !== entry.idempotencyFingerprint) {
        throw priceCatalogIdempotencyConflictError();
      }
      return toPublicPriceCatalogEntry(result.record);
    }

    await recordOperationalEvent(
      {
        clientId: result.record.clientId,
        buildingId: result.record.buildingId,
        eventType: 'PRICE_CATALOG_ENTRY_CREATED',
        entityType: 'PRICE_CATALOG_ENTRY',
        entityId: result.record.id,
        actorUserId,
        summary: 'Price catalog entry created as a DRAFT.',
        metadata: entryMetadata(result.record, {
          idempotencyReceived: true,
        }),
      },
      client,
    );
    return toPublicPriceCatalogEntry(result.record);
  });
}

export async function getPriceCatalogEntry(
  id: string,
  actorUserId: string,
): Promise<PublicPriceCatalogEntry> {
  const record = await priceCatalogEntryRepository.findById(id);
  if (!record) throw priceCatalogEntryNotFoundError();
  await assertEntryAccess(actorUserId, record);
  return toPublicPriceCatalogEntry(record);
}

export async function listPriceCatalogEntries(
  filters: PriceCatalogEntryFilters,
  actorUserId: string,
): Promise<PublicPriceCatalogEntry[]> {
  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(
      actorUserId,
      filters.buildingId,
    );
  }

  const accessibleClientIds = await getAccessibleClientIds(actorUserId);
  const accessibleBuildingIds = await getAccessibleBuildingIds(actorUserId);

  // No leak posture: a client filter outside the caller's reach yields an
  // empty page, not an existence oracle.
  if (filters.clientId && !accessibleClientIds.includes(filters.clientId)) {
    return [];
  }

  const records = await priceCatalogEntryRepository.listScoped(
    accessibleClientIds,
    accessibleBuildingIds,
    filters,
  );
  return records.map(toPublicPriceCatalogEntry);
}

/** DRAFT-only field update. Revalidates every changed reference or window. */
export async function updatePriceCatalogEntry(
  id: string,
  input: UpdatePriceCatalogEntryInput,
  actorUserId: string,
): Promise<PublicPriceCatalogEntry> {
  return withTransaction(async (client) => {
    const record = await priceCatalogEntryRepository.findByIdForUpdate(
      client,
      id,
    );
    if (!record) throw priceCatalogEntryNotFoundError();
    await assertEntryAccess(actorUserId, record);
    if (record.status !== 'DRAFT') throw priceCatalogNotDraftError();

    const merged = {
      buildingId:
        input.buildingId === undefined ? record.buildingId : input.buildingId,
      vendorId: input.vendorId === undefined ? record.vendorId : input.vendorId,
      sourceMode: record.sourceMode,
      itemId:
        input.itemId === undefined
          ? record.itemId
          : input.itemId === null
            ? null
            : input.itemId,
      uomId:
        input.uomId === undefined
          ? record.uomId
          : input.uomId === null
            ? null
            : input.uomId,
      serviceId:
        input.serviceId === undefined
          ? record.serviceId
          : input.serviceId === null
            ? null
            : input.serviceId,
      approvedByUserId:
        input.approvedByUserId === undefined
          ? record.approvedByUserId
          : input.approvedByUserId,
    };

    await validateReferences(client, {
      clientId: record.clientId,
      ...merged,
    });

    const effectiveFrom = input.effectiveFrom
      ? new Date(input.effectiveFrom)
      : record.effectiveFrom;
    const effectiveTo =
      input.effectiveTo === undefined
        ? record.effectiveTo
        : input.effectiveTo === null
          ? null
          : new Date(input.effectiveTo);
    assertValidWindow(effectiveFrom, effectiveTo);

    // Scope gate for a moved-in Building: the caller must also reach it.
    if (input.buildingId !== undefined && input.buildingId !== null) {
      await contextAccessService.assertBuildingAccess(
        actorUserId,
        input.buildingId,
      );
    }

    // PART 03 VENDOR_CONTRACT discipline: the kind is derived from the
    // final merged Vendor tier key, so a DRAFT that gains, changes, or
    // loses its Vendor never violates kind/vendor correlation (e.g. REFERENCE
    // storing vendor_id) — the failure mode is a validated 400/403, never a
    // raw constraint crash.
    const updated = await priceCatalogEntryRepository.updateDraft(
      client,
      id,
      input,
      merged.vendorId === null ? 'REFERENCE' : 'VENDOR_CONTRACT',
    );
    if (!updated) throw priceCatalogNotDraftError();

    await recordOperationalEvent(
      {
        clientId: updated.clientId,
        buildingId: updated.buildingId,
        eventType: 'PRICE_CATALOG_ENTRY_UPDATED',
        entityType: 'PRICE_CATALOG_ENTRY',
        entityId: updated.id,
        actorUserId,
        summary: 'DRAFT price catalog entry updated.',
        metadata: entryMetadata(updated, {
          changedFields: Object.keys(input),
        }),
      },
      client,
    );
    return toPublicPriceCatalogEntry(updated);
  });
}

/** DRAFT → ACTIVE. The exclusion constraint owns same-tier overlap. */
export async function activatePriceCatalogEntry(
  id: string,
  actorUserId: string,
): Promise<PublicPriceCatalogEntry> {
  try {
    return await withTransaction(async (client) => {
      const record = await priceCatalogEntryRepository.findByIdForUpdate(
        client,
        id,
      );
      if (!record) throw priceCatalogEntryNotFoundError();
      await assertEntryAccess(actorUserId, record);
      if (record.status !== 'DRAFT') throw priceCatalogNotDraftError();

      const activated = await priceCatalogEntryRepository.activate(
        client,
        id,
        actorUserId,
      );
      if (!activated) throw priceCatalogNotDraftError();

      await recordOperationalEvent(
        {
          clientId: activated.clientId,
          buildingId: activated.buildingId,
          eventType: 'PRICE_CATALOG_ENTRY_ACTIVATED',
          entityType: 'PRICE_CATALOG_ENTRY',
          entityId: activated.id,
          actorUserId,
          summary: 'Price catalog entry activated.',
          metadata: entryMetadata(activated),
        },
        client,
      );
      return toPublicPriceCatalogEntry(activated);
    });
  } catch (error) {
    if (isExclusionOverlap(error)) throw priceCatalogWindowOverlapError();
    throw error;
  }
}

/** ACTIVE → INACTIVE (terminal). The row and its window stay as history. */
export async function deactivatePriceCatalogEntry(
  id: string,
  actorUserId: string,
): Promise<PublicPriceCatalogEntry> {
  return withTransaction(async (client) => {
    const record = await priceCatalogEntryRepository.findByIdForUpdate(
      client,
      id,
    );
    if (!record) throw priceCatalogEntryNotFoundError();
    await assertEntryAccess(actorUserId, record);
    if (record.status !== 'ACTIVE') throw priceCatalogNotActiveError();

    const deactivated = await priceCatalogEntryRepository.deactivate(
      client,
      id,
      actorUserId,
    );
    if (!deactivated) throw priceCatalogNotActiveError();

    await recordOperationalEvent(
      {
        clientId: deactivated.clientId,
        buildingId: deactivated.buildingId,
        eventType: 'PRICE_CATALOG_ENTRY_DEACTIVATED',
        entityType: 'PRICE_CATALOG_ENTRY',
        entityId: deactivated.id,
        actorUserId,
        summary: 'Price catalog entry deactivated (terminal).',
        metadata: entryMetadata(deactivated),
      },
      client,
    );
    return toPublicPriceCatalogEntry(deactivated);
  });
}

/**
 * ACTIVE → closed + successor ACTIVE, atomically. The successor inherits the
 * predecessor's subject (item), tier keys (Building / Vendor), UOM, and
 * currency; only the price and window change, so a replacement can never
 * silently re-scope an authority (governance §11 — replace, never rewrite).
 */
export async function replacePriceCatalogEntry(
  id: string,
  input: ReplacePriceCatalogEntryInput,
  actorUserId: string,
): Promise<PublicPriceCatalogEntry> {
  const fingerprint = replaceFingerprint(id, input);
  try {
    return await withTransaction(async (client) => {
      const predecessor = await priceCatalogEntryRepository.findByIdForUpdate(
        client,
        id,
      );
      if (!predecessor) throw priceCatalogEntryNotFoundError();
      await assertEntryAccess(actorUserId, predecessor);

      // Idempotency replay first: a retried replace must return its own
      // successor even though the predecessor is already closed.
      const existing = await priceCatalogEntryRepository.findByIdempotencyKey(
        client,
        predecessor.clientId,
        input.idempotencyKey,
      );
      if (existing) {
        if (existing.idempotencyFingerprint !== fingerprint) {
          throw priceCatalogIdempotencyConflictError();
        }
        return toPublicPriceCatalogEntry(existing);
      }

      if (predecessor.status !== 'ACTIVE') throw priceCatalogNotActiveError();

      const effectiveFrom = new Date(input.effectiveFrom);
      const effectiveTo = input.effectiveTo ? new Date(input.effectiveTo) : null;
      assertValidWindow(effectiveFrom, effectiveTo);
      if (effectiveFrom.getTime() < predecessor.effectiveFrom.getTime()) {
        // Normal manage authority cannot write history earlier than the
        // predecessor's own window start (retroactive correction is a
        // PART 05 `price_catalog.override` concern, out of scope here).
        throw priceCatalogEffectiveWindowInvalidError();
      }

      const approver = input.approvedByUserId ?? null;
      if (approver !== null) {
        const user = await priceCatalogEntryRepository.loadUser(client, approver);
        if (!user || user.status !== 'ACTIVE') {
          throw priceCatalogApproverInvalidError();
        }
      }

      const successorId = priceCatalogEntryRepository.randomId();

      const closed = await priceCatalogEntryRepository.closeForReplacement(
        client,
        predecessor.id,
        successorId,
        actorUserId,
      );
      if (!closed) throw priceCatalogAlreadyReplacedError();

      const successor: NewPriceCatalogEntry = {
        clientId: predecessor.clientId,
        buildingId: predecessor.buildingId,
        vendorId: predecessor.vendorId,
        sourceMode: predecessor.sourceMode,
        entryKind: predecessor.entryKind,
        itemId: predecessor.itemId,
        uomId: predecessor.uomId,
        serviceId: predecessor.serviceId,
        currency: predecessor.currency,
        unitPrice: input.unitPrice,
        effectiveFrom,
        effectiveTo,
        sourceReference: input.sourceReference ?? null,
        notes: input.notes ?? null,
        approvedByUserId: approver,
        idempotencyKey: input.idempotencyKey,
        idempotencyFingerprint: fingerprint,
        createdByUserId: actorUserId,
      };

      const result = await priceCatalogEntryRepository.insertWithId(
        client,
        successorId,
        successor,
        true,
      );
      if (!result.created) {
        if (result.record.idempotencyFingerprint !== fingerprint) {
          throw priceCatalogIdempotencyConflictError();
        }
        return toPublicPriceCatalogEntry(result.record);
      }

      await recordOperationalEvent(
        {
          clientId: closed.clientId,
          buildingId: closed.buildingId,
          eventType: 'PRICE_CATALOG_ENTRY_REPLACED',
          entityType: 'PRICE_CATALOG_ENTRY',
          entityId: closed.id,
          actorUserId,
          summary: 'Price catalog entry closed and superseded by a replacement.',
          metadata: entryMetadata(closed, {
            successorEntryId: result.record.id,
          }),
        },
        client,
      );
      await recordOperationalEvent(
        {
          clientId: result.record.clientId,
          buildingId: result.record.buildingId,
          eventType: 'PRICE_CATALOG_ENTRY_CREATED',
          entityType: 'PRICE_CATALOG_ENTRY',
          entityId: result.record.id,
          actorUserId,
          summary: 'Replacement price catalog entry created.',
          metadata: entryMetadata(result.record, {
            predecessorEntryId: closed.id,
          }),
        },
        client,
      );
      await recordOperationalEvent(
        {
          clientId: result.record.clientId,
          buildingId: result.record.buildingId,
          eventType: 'PRICE_CATALOG_ENTRY_ACTIVATED',
          entityType: 'PRICE_CATALOG_ENTRY',
          entityId: result.record.id,
          actorUserId,
          summary: 'Replacement price catalog entry activated.',
          metadata: entryMetadata(result.record),
        },
        client,
      );
      return toPublicPriceCatalogEntry(result.record);
    });
  } catch (error) {
    if (isExclusionOverlap(error)) throw priceCatalogWindowOverlapError();
    if (isSuccessorConflict(error)) throw priceCatalogAlreadyReplacedError();
    throw error;
  }
}

/**
 * PART 05 — governed retroactive correction (`price_catalog.override`,
 * governance §11 mid-flight correction, §14 override authority).
 *
 * Semantics, all enforced inside one transaction:
 *   - The HTTP boundary has already demanded `price_catalog.override`; the
 *     mandatory non-blank reason is validated at the parser.
 *   - Target must be ACTIVE — DRAFT rows are freely editable under `.manage`
 *     and INACTIVE rows are terminal history, so any other state is an
 *     invalid lifecycle transition (409).
 *   - The predecessor is closed exactly like a replacement (status →
 *     INACTIVE, actor/time + `replaced_by_entry_id` linkage): its price,
 *     window, scope, UOM and currency facts are never mutated in place and
 *     the historical row stays queryable.
 *   - The successor is a NEW ACTIVE authority state inheriting the
 *     predecessor's subject/scope/UOM/currency — a correction can never
 *     silently re-scope or re-denominate an authority. Unlike `replace`,
 *     the successor window MAY start before the predecessor's window start;
 *     reaching into the already-entered past is precisely the exceptional
 *     authority this lane exists for (§11), and it becomes resolvable only
 *     under its own new effective window.
 *   - Same-tier overlap with any other ACTIVE window is still rejected
 *     structurally by the exclusion constraint (mapped to 409), so the
 *     fail-closed ambiguity posture is preserved on this lane as well.
 *   - Evidence: `PRICE_CATALOG_ENTRY_OVERRIDE_CORRECTED` on the predecessor
 *     carries reason, permission code, both windows and the successor link;
 *     the successor receives the ordinary CREATED + ACTIVATED trail.
 *     Nothing here touches RFQ comparison snapshots, quotations, awards,
 *     POs, commitments, or actual costs — existing snapshots that cite the
 *     predecessor remain byte-stable historical evidence (§12/§15).
 */
export async function correctPriceCatalogEntry(
  id: string,
  input: CorrectPriceCatalogEntryInput,
  actorUserId: string,
): Promise<PublicPriceCatalogEntry> {
  const fingerprint = correctFingerprint(id, input);
  try {
    return await withTransaction(async (client) => {
      const predecessor = await priceCatalogEntryRepository.findByIdForUpdate(
        client,
        id,
      );
      if (!predecessor) throw priceCatalogEntryNotFoundError();
      await assertEntryAccess(actorUserId, predecessor);

      // Idempotency replay first: a retried correction must return its own
      // successor even though the predecessor is already closed.
      const existing = await priceCatalogEntryRepository.findByIdempotencyKey(
        client,
        predecessor.clientId,
        input.idempotencyKey,
      );
      if (existing) {
        if (existing.idempotencyFingerprint !== fingerprint) {
          throw priceCatalogIdempotencyConflictError();
        }
        return toPublicPriceCatalogEntry(existing);
      }

      if (predecessor.status !== 'ACTIVE') throw priceCatalogNotActiveError();

      const effectiveFrom = new Date(input.effectiveFrom);
      const effectiveTo = input.effectiveTo ? new Date(input.effectiveTo) : null;
      assertValidWindow(effectiveFrom, effectiveTo);
      // Deliberately no "effectiveFrom >= predecessor.effectiveFrom" guard —
      // that guard belongs to the ordinary `.manage` replacement lane. The
      // override lane exists to repair an already-entered window, including
      // retroactively (§11), under reason + audit evidence.

      const approver = input.approvedByUserId ?? null;
      if (approver !== null) {
        const user = await priceCatalogEntryRepository.loadUser(client, approver);
        if (!user || user.status !== 'ACTIVE') {
          throw priceCatalogApproverInvalidError();
        }
      }

      const successorId = priceCatalogEntryRepository.randomId();

      const closed = await priceCatalogEntryRepository.closeForReplacement(
        client,
        predecessor.id,
        successorId,
        actorUserId,
      );
      if (!closed) throw priceCatalogAlreadyReplacedError();

      const successor: NewPriceCatalogEntry = {
        clientId: predecessor.clientId,
        buildingId: predecessor.buildingId,
        vendorId: predecessor.vendorId,
        sourceMode: predecessor.sourceMode,
        entryKind: predecessor.entryKind,
        itemId: predecessor.itemId,
        uomId: predecessor.uomId,
        serviceId: predecessor.serviceId,
        currency: predecessor.currency,
        unitPrice: input.unitPrice,
        effectiveFrom,
        effectiveTo,
        sourceReference: input.sourceReference ?? null,
        notes: input.notes ?? null,
        approvedByUserId: approver,
        idempotencyKey: input.idempotencyKey,
        idempotencyFingerprint: fingerprint,
        createdByUserId: actorUserId,
      };

      const result = await priceCatalogEntryRepository.insertWithId(
        client,
        successorId,
        successor,
        true,
      );
      if (!result.created) {
        if (result.record.idempotencyFingerprint !== fingerprint) {
          throw priceCatalogIdempotencyConflictError();
        }
        return toPublicPriceCatalogEntry(result.record);
      }

      await recordOperationalEvent(
        {
          clientId: closed.clientId,
          buildingId: closed.buildingId,
          eventType: 'PRICE_CATALOG_ENTRY_OVERRIDE_CORRECTED',
          entityType: 'PRICE_CATALOG_ENTRY',
          entityId: closed.id,
          actorUserId,
          summary: 'Price catalog entry retroactively corrected under override authority.',
          metadata: entryMetadata(closed, {
            reason: input.reason,
            permissionCode: 'price_catalog.override',
            successorEntryId: result.record.id,
            correctedUnitPrice: result.record.unitPrice,
            correctedEffectiveFrom: result.record.effectiveFrom.toISOString(),
            correctedEffectiveTo:
              result.record.effectiveTo?.toISOString() ?? null,
          }),
        },
        client,
      );
      await recordOperationalEvent(
        {
          clientId: result.record.clientId,
          buildingId: result.record.buildingId,
          eventType: 'PRICE_CATALOG_ENTRY_CREATED',
          entityType: 'PRICE_CATALOG_ENTRY',
          entityId: result.record.id,
          actorUserId,
          summary: 'Corrective price catalog entry created.',
          metadata: entryMetadata(result.record, {
            predecessorEntryId: closed.id,
          }),
        },
        client,
      );
      await recordOperationalEvent(
        {
          clientId: result.record.clientId,
          buildingId: result.record.buildingId,
          eventType: 'PRICE_CATALOG_ENTRY_ACTIVATED',
          entityType: 'PRICE_CATALOG_ENTRY',
          entityId: result.record.id,
          actorUserId,
          summary: 'Corrective price catalog entry activated.',
          metadata: entryMetadata(result.record),
        },
        client,
      );
      return toPublicPriceCatalogEntry(result.record);
    });
  } catch (error) {
    if (isExclusionOverlap(error)) throw priceCatalogWindowOverlapError();
    if (isSuccessorConflict(error)) throw priceCatalogAlreadyReplacedError();
    throw error;
  }
}

export const priceCatalogEntryService = {
  activatePriceCatalogEntry,
  correctPriceCatalogEntry,
  createPriceCatalogEntry,
  deactivatePriceCatalogEntry,
  getPriceCatalogEntry,
  listPriceCatalogEntries,
  replacePriceCatalogEntry,
  updatePriceCatalogEntry,
};
