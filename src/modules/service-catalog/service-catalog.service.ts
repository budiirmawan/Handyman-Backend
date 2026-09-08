import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import {
  buildingAccessDeniedError,
  contextAccessService,
  getAccessibleClientIds,
} from '../context-access';
import {
  clientInactiveError,
  clientNotFoundError,
  clientRepository,
} from '../clients';
import { recordOperationalEvent } from '../operational-events';
import {
  serviceCatalogCodeAlreadyExistsError,
  serviceCatalogNotActiveError,
  serviceCatalogNotFoundError,
} from './service-catalog.errors';
import { serviceCatalogRepository } from './service-catalog.repository';
import type {
  CreateServiceCatalogEntryInput,
  NewServiceCatalogEntry,
  ServiceCatalogFilters,
  ServiceCatalogRecord,
  PublicServiceCatalogEntry,
  UpdateServiceCatalogEntryInput,
} from './service-catalog.types';

/**
 * CR-BE-SVC-01 PART 01 — Service Catalog commands and reads.
 *
 * Governed semantics (docs/CR-BE-SVC-01_START_GOVERNANCE.md):
 *   - ONE flat, Client-scoped reference master (the SERVICE analog of
 *     `inventory_items`). `code` is unique per Client, immutable once created.
 *   - Lifecycle ACTIVE → INACTIVE (terminal). No DRAFT state, no scheduler.
 *     Deactivation is the governed status transition; there is no reactivation
 *     lane in v1 (governance §11).
 *   - Classification is a free `category` column (skills precedent); no
 *     governed Service-Category master in v1.
 *   - This module creates no Service Request, RFQ, quotation, PO, price,
 *     quantity, UOM, or SERVICE-pricing behavior. It is identity only.
 */

const UNIQUE_VIOLATION = '23505';
const SERVICE_CATALOG_CLIENT_CODE_CONSTRAINT =
  'service_catalog_client_code_unique';

function toPublic(record: ServiceCatalogRecord): PublicServiceCatalogEntry {
  return {
    id: record.id,
    clientId: record.clientId,
    code: record.code,
    name: record.name,
    description: record.description,
    category: record.category,
    status: record.status,
    createdByUserId: record.createdByUserId,
    createdAt:
      record.createdAt instanceof Date
        ? record.createdAt.toISOString()
        : String(record.createdAt),
    updatedAt:
      record.updatedAt instanceof Date
        ? record.updatedAt.toISOString()
        : String(record.updatedAt),
  };
}

/** Catalog entries are Client-scoped (no building_id); isolation is per Client. */
async function assertClientAccess(
  actorUserId: string,
  clientId: string,
): Promise<void> {
  if (!(await contextAccessService.canAccessClient(actorUserId, clientId))) {
    throw buildingAccessDeniedError();
  }
}

function entryMetadata(
  record: ServiceCatalogRecord,
): Record<string, unknown> {
  return {
    code: record.code,
    name: record.name,
    category: record.category,
    status: record.status,
    clientId: record.clientId,
  };
}

function isCodeUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === UNIQUE_VIOLATION &&
    candidate.constraint === SERVICE_CATALOG_CLIENT_CODE_CONSTRAINT
  );
}

/**
 * Creates a Service Catalog entry (ACTIVE).
 *
 * Validation order:
 * 1. unknown Client → 404 SERVICE_CATALOG_CLIENT_INVALID
 * 2. INACTIVE Client → 400 CLIENT_INACTIVE
 * 3. caller cannot access Client → 403 BUILDING_ACCESS_DENIED
 * 4. duplicate code for Client → 409 SERVICE_CATALOG_CODE_ALREADY_EXISTS
 */
export async function createServiceCatalogEntry(
  input: CreateServiceCatalogEntryInput,
  actorUserId: string,
): Promise<PublicServiceCatalogEntry> {
  const client = await clientRepository.findById(input.clientId);
  if (!client) {
    throw clientNotFoundError();
  }
  if (client.status !== 'ACTIVE') {
    throw clientInactiveError();
  }

  await assertClientAccess(actorUserId, input.clientId);

  const existing = await serviceCatalogRepository.findByCodeForClient(
    undefined,
    input.clientId,
    input.code,
  );
  if (existing) {
    throw serviceCatalogCodeAlreadyExistsError();
  }

  const newEntry: NewServiceCatalogEntry = {
    clientId: input.clientId,
    code: input.code,
    name: input.name.trim(),
    category: input.category.trim(),
    description: input.description?.trim() || null,
    createdByUserId: actorUserId,
  };

  try {
    return await withTransaction(async (tx) => {
      const record = await serviceCatalogRepository.insertEntry(tx, newEntry);

      await recordOperationalEvent(
        {
          clientId: record.clientId,
          eventType: 'SERVICE_CATALOG_ENTRY_CREATED',
          entityType: 'SERVICE_CATALOG_ENTRY',
          entityId: record.id,
          actorUserId,
          summary: `Service catalog entry ${record.code} created as ACTIVE.`,
          metadata: entryMetadata(record),
        },
        tx,
      );

      return toPublic(record);
    });
  } catch (error) {
    if (isCodeUniqueViolation(error)) {
      throw serviceCatalogCodeAlreadyExistsError();
    }
    throw error;
  }
}

export async function getServiceCatalogEntry(
  id: string,
  actorUserId: string,
): Promise<PublicServiceCatalogEntry> {
  const record = await serviceCatalogRepository.findById(undefined, id);
  if (!record) {
    throw serviceCatalogNotFoundError();
  }
  await assertClientAccess(actorUserId, record.clientId);
  return toPublic(record);
}

export async function listServiceCatalogEntries(
  filters: ServiceCatalogFilters,
  actorUserId: string,
): Promise<PublicServiceCatalogEntry[]> {
  const accessibleClientIds = await getAccessibleClientIds(actorUserId);

  // No-leak posture: a client filter outside the caller's reach yields an
  // empty page, not an existence oracle.
  if (filters.clientId && !accessibleClientIds.includes(filters.clientId)) {
    return [];
  }

  const records = await serviceCatalogRepository.listScoped(
    undefined,
    accessibleClientIds,
    filters,
  );
  return records.map(toPublic);
}

/**
 * Updates editable, non-identity fields (`name`, `description`, `category`).
 * `code` and `clientId` are immutable (governance §5/§11); `status` is not
 * editable here — deactivation is the governed lifecycle transition.
 */
export async function updateServiceCatalogEntry(
  id: string,
  input: UpdateServiceCatalogEntryInput,
  actorUserId: string,
): Promise<PublicServiceCatalogEntry> {
  const existing = await serviceCatalogRepository.findById(undefined, id);
  if (!existing) {
    throw serviceCatalogNotFoundError();
  }
  await assertClientAccess(actorUserId, existing.clientId);

  return withTransaction(async (tx) => {
    const updated = await serviceCatalogRepository.updateEntry(tx, id, {
      name: input.name?.trim(),
      category: input.category?.trim(),
      description:
        input.description === undefined
          ? undefined
          : input.description === null
            ? null
            : input.description.trim() || null,
    });

    if (!updated) {
      throw serviceCatalogNotFoundError();
    }

    await recordOperationalEvent(
      {
        clientId: updated.clientId,
        eventType: 'SERVICE_CATALOG_ENTRY_UPDATED',
        entityType: 'SERVICE_CATALOG_ENTRY',
        entityId: updated.id,
        actorUserId,
        summary: `Service catalog entry ${updated.code} updated.`,
        metadata: entryMetadata(updated),
      },
      tx,
    );

    return toPublic(updated);
  });
}

/**
 * Terminally deactivates an ACTIVE entry (ACTIVE → INACTIVE). Governance §11:
 * deactivation is terminal; INACTIVE rows are retained for history and there
 * is no reactivation lane in v1.
 */
export async function deactivateServiceCatalogEntry(
  id: string,
  actorUserId: string,
): Promise<PublicServiceCatalogEntry> {
  const existing = await serviceCatalogRepository.findById(undefined, id);
  if (!existing) {
    throw serviceCatalogNotFoundError();
  }
  await assertClientAccess(actorUserId, existing.clientId);

  if (existing.status !== 'ACTIVE') {
    throw serviceCatalogNotActiveError();
  }

  return withTransaction(async (tx) => {
    const deactivated = await serviceCatalogRepository.deactivate(tx, id);
    // Re-check inside the transaction: a concurrent deactivation could have
    // raced us; treat the absence of a returned row as already-inactive.
    if (!deactivated) {
      throw serviceCatalogNotActiveError();
    }

    await recordOperationalEvent(
      {
        clientId: deactivated.clientId,
        eventType: 'SERVICE_CATALOG_ENTRY_DEACTIVATED',
        entityType: 'SERVICE_CATALOG_ENTRY',
        entityId: deactivated.id,
        actorUserId,
        summary: `Service catalog entry ${deactivated.code} deactivated.`,
        metadata: entryMetadata(deactivated),
      },
      tx,
    );

    return toPublic(deactivated);
  });
}

export const serviceCatalogService = {
  createServiceCatalogEntry,
  getServiceCatalogEntry,
  listServiceCatalogEntries,
  updateServiceCatalogEntry,
  deactivateServiceCatalogEntry,
};
