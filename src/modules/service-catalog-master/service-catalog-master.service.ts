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
  computeRequestFingerprint,
  executeIdempotent,
} from '../request-idempotency';
import { resolveAuthorizedPriceCatalogEntry } from '../price-catalog-entries/price-catalog-lookup.service';
import type { PriceCatalogCurrency } from '../price-catalog-entries/price-catalog-entry.types';
import { serviceCatalogNotFoundError } from '../service-catalog';
import {
  STARTER_PACK_CATEGORIES,
  STARTER_PACK_OPERATION_KEY,
  STARTER_PACK_SERVICES,
} from './service-catalog-starter-catalog';
import {
  serviceCatalogAvailabilityAlreadyExistsError,
  serviceCatalogAvailabilityBuildingMismatchError,
  serviceCatalogAvailabilityInvalidStateError,
  serviceCatalogAvailabilityNotFoundError,
  serviceCategoryCodeAlreadyExistsError,
  serviceCategoryInUseError,
  serviceCategoryNotActiveError,
  serviceCategoryNotFoundError,
  starterPackClientInvalidError,
} from './service-catalog-master.errors';
import { serviceCatalogMasterRepository as repo } from './service-catalog-master.repository';
import type {
  CreateServiceCategoryInput,
  NewServiceCategory,
  NewServiceCatalogAvailability,
  ServiceCatalogCategoryLinkResult,
  ServiceCatalogItemView,
  ServiceCatalogReadModel,
  ServiceCatalogReferencePrice,
  ServiceCategoryFilters,
  ServiceCategoryRecord,
  StarterPackImportResult,
  UpdateServiceCategoryInput,
} from './service-catalog-master.types';

/**
 * CR-HM-SERVICE-CATALOG-01 PART 01 — Service Catalog Starter commands and reads.
 *
 * Two-level Service Catalog (Service Category → Service Item), Client/Building
 * availability grants and the governed starter-pack import. Pricing is
 * deliberately NOT owned here: it is composed at read time from the existing
 * `price_catalog_entries` SERVICE authority and is null whenever no governed
 * price resolves (no default, no nominal amount).
 *
 * Isolation follows the existing catalogue rule: a caller reaches a Client
 * only through their ACTIVE Building assignments (`contextAccessService`).
 */

async function assertClientAccess(
  actorUserId: string,
  clientId: string,
): Promise<void> {
  if (!(await contextAccessService.canAccessClient(actorUserId, clientId))) {
    throw buildingAccessDeniedError();
  }
}

async function loadActiveClient(clientId: string) {
  const client = await clientRepository.findById(clientId);
  if (!client) throw clientNotFoundError();
  if (client.status !== 'ACTIVE') throw clientInactiveError();
  return client;
}

function categoryMetadata(record: ServiceCategoryRecord): Record<string, unknown> {
  return {
    code: record.code,
    name: record.name,
    status: record.status,
    source: record.source,
    clientId: record.clientId,
  };
}

// ---------------------------------------------------------------------------
// Service Category master
// ---------------------------------------------------------------------------

export async function createServiceCategory(
  input: CreateServiceCategoryInput,
  actorUserId: string,
): Promise<ReturnType<typeof repo.toPublicCategory>> {
  await loadActiveClient(input.clientId);
  await assertClientAccess(actorUserId, input.clientId);

  const existing = await repo.findCategoryByCodeForClient(
    undefined,
    input.clientId,
    input.code,
  );
  if (existing) throw serviceCategoryCodeAlreadyExistsError();

  const newCategory: NewServiceCategory = {
    clientId: input.clientId,
    code: input.code,
    name: input.name,
    description: input.description?.trim() || null,
    source: 'MANUAL',
    createdByUserId: actorUserId,
  };

  try {
    return await withTransaction(async (tx) => {
      const created = await repo.insertCategory(tx, newCategory);
      await recordOperationalEvent(
        {
          clientId: created.clientId,
          eventType: 'SERVICE_CATEGORY_CREATED',
          entityType: 'SERVICE_CATEGORY',
          entityId: created.id,
          actorUserId,
          summary: `Service category ${created.code} created as ACTIVE.`,
          metadata: categoryMetadata(created),
        },
        tx,
      );
      return repo.toPublicCategory(created);
    });
  } catch (error) {
    if (isUniqueViolation(error, 'service_category_client_code_unique')) {
      throw serviceCategoryCodeAlreadyExistsError();
    }
    throw error;
  }
}

export async function getServiceCategory(
  id: string,
  actorUserId: string,
): Promise<ReturnType<typeof repo.toPublicCategory>> {
  const record = await repo.findCategoryById(undefined, id);
  if (!record) throw serviceCategoryNotFoundError();
  await assertClientAccess(actorUserId, record.clientId);
  return repo.toPublicCategory(record);
}

export async function listServiceCategories(
  filters: ServiceCategoryFilters,
  actorUserId: string,
): Promise<ReturnType<typeof repo.toPublicCategory>[]> {
  const accessibleClientIds = await getAccessibleClientIds(actorUserId);
  if (filters.clientId && !accessibleClientIds.includes(filters.clientId)) {
    return [];
  }
  const records = await repo.listCategories(
    undefined,
    accessibleClientIds,
    filters,
  );
  return records.map((record) => repo.toPublicCategory(record));
}

export async function updateServiceCategory(
  id: string,
  input: UpdateServiceCategoryInput,
  actorUserId: string,
): Promise<ReturnType<typeof repo.toPublicCategory>> {
  const existing = await repo.findCategoryById(undefined, id);
  if (!existing) throw serviceCategoryNotFoundError();
  await assertClientAccess(actorUserId, existing.clientId);

  return withTransaction(async (tx) => {
    const updated = await repo.updateCategory(tx, id, {
      name: input.name?.trim(),
      description:
        input.description === undefined
          ? undefined
          : input.description === null
            ? null
            : input.description.trim() || null,
    });
    if (!updated) throw serviceCategoryNotFoundError();
    await recordOperationalEvent(
      {
        clientId: updated.clientId,
        eventType: 'SERVICE_CATEGORY_UPDATED',
        entityType: 'SERVICE_CATEGORY',
        entityId: updated.id,
        actorUserId,
        summary: `Service category ${updated.code} updated.`,
        metadata: categoryMetadata(updated),
      },
      tx,
    );
    return repo.toPublicCategory(updated);
  });
}

export async function deactivateServiceCategory(
  id: string,
  actorUserId: string,
): Promise<ReturnType<typeof repo.toPublicCategory>> {
  const existing = await repo.findCategoryById(undefined, id);
  if (!existing) throw serviceCategoryNotFoundError();
  await assertClientAccess(actorUserId, existing.clientId);

  if (existing.status !== 'ACTIVE') {
    throw serviceCategoryNotActiveError();
  }

  const activeServices = await repo.countActiveServicesForCategory(
    undefined,
    id,
  );
  if (activeServices > 0) throw serviceCategoryInUseError();

  return withTransaction(async (tx) => {
    const deactivated = await repo.deactivateCategory(tx, id);
    if (!deactivated) throw serviceCategoryNotActiveError();
    await recordOperationalEvent(
      {
        clientId: deactivated.clientId,
        eventType: 'SERVICE_CATEGORY_DEACTIVATED',
        entityType: 'SERVICE_CATEGORY',
        entityId: deactivated.id,
        actorUserId,
        summary: `Service category ${deactivated.code} deactivated.`,
        metadata: categoryMetadata(deactivated),
      },
      tx,
    );
    return repo.toPublicCategory(deactivated);
  });
}

// ---------------------------------------------------------------------------
// Service Item ↔ Category link
// ---------------------------------------------------------------------------

export async function linkServiceItemCategory(
  serviceCatalogId: string,
  serviceCategoryId: string,
  actorUserId: string,
): Promise<ServiceCatalogCategoryLinkResult> {
  const service = await repo.findServiceItemById(undefined, serviceCatalogId);
  if (!service) throw serviceCatalogNotFoundError();
  await assertClientAccess(actorUserId, service.clientId);

  const category = await repo.findCategoryById(undefined, serviceCategoryId);
  if (!category || category.clientId !== service.clientId) {
    throw serviceCategoryNotFoundError();
  }
  if (category.status !== 'ACTIVE') throw serviceCategoryNotActiveError();

  if (service.categoryId === category.id) {
    return {
      serviceCatalogId: service.id,
      clientId: service.clientId,
      code: service.code,
      name: service.name,
      categoryId: category.id,
      categoryCode: category.code,
      categoryName: category.name,
    };
  }

  return withTransaction(async (tx) => {
    const linked = await repo.linkServiceCategory(
      tx,
      service.id,
      category.id,
      category.code,
      category.name,
    );
    if (!linked) throw serviceCatalogNotFoundError();
    await recordOperationalEvent(
      {
        clientId: service.clientId,
        eventType: 'SERVICE_CATALOG_ENTRY_CATEGORY_LINKED',
        entityType: 'SERVICE_CATALOG_ENTRY',
        entityId: service.id,
        actorUserId,
        summary: `Service ${service.code} linked to category ${category.code}.`,
        metadata: {
          serviceCode: service.code,
          categoryId: category.id,
          categoryCode: category.code,
          categoryName: category.name,
          clientId: service.clientId,
        },
      },
      tx,
    );
    return {
      serviceCatalogId: linked.id,
      clientId: linked.clientId,
      code: linked.code,
      name: service.name,
      categoryId: category.id,
      categoryCode: category.code,
      categoryName: category.name,
    };
  });
}

// ---------------------------------------------------------------------------
// Availability grants
// ---------------------------------------------------------------------------

export async function grantServiceAvailability(
  serviceCatalogId: string,
  buildingId: string,
  actorUserId: string,
): Promise<ReturnType<typeof repo.toPublicAvailability>> {
  const service = await repo.findServiceItemById(undefined, serviceCatalogId);
  if (!service) throw serviceCatalogNotFoundError();
  await assertClientAccess(actorUserId, service.clientId);

  const buildingClientId = await repo.loadBuildingClientId(
    undefined,
    buildingId,
  );
  if (!buildingClientId || buildingClientId !== service.clientId) {
    throw serviceCatalogAvailabilityBuildingMismatchError();
  }

  const existing = await repo.findAvailabilityForServiceAndBuilding(
    undefined,
    serviceCatalogId,
    buildingId,
  );
  if (existing) throw serviceCatalogAvailabilityAlreadyExistsError();

  const newGrant: NewServiceCatalogAvailability = {
    clientId: service.clientId,
    serviceCatalogId,
    buildingId,
    createdByUserId: actorUserId,
  };

  try {
    return await withTransaction(async (tx) => {
      const created = await repo.insertAvailability(tx, newGrant);
      await recordOperationalEvent(
        {
          clientId: created.clientId,
          eventType: 'SERVICE_CATALOG_AVAILABILITY_CREATED',
          entityType: 'SERVICE_CATALOG_AVAILABILITY',
          entityId: created.id,
          actorUserId,
          summary: `Availability granted for service ${service.code} in building ${buildingId}.`,
          metadata: {
            serviceCatalogId,
            serviceCode: service.code,
            buildingId,
            status: created.status,
            clientId: created.clientId,
          },
        },
        tx,
      );
      return repo.toPublicAvailability(created);
    });
  } catch (error) {
    if (
      isUniqueViolation(
        error,
        'service_catalog_availability_service_building_unique',
      )
    ) {
      throw serviceCatalogAvailabilityAlreadyExistsError();
    }
    throw error;
  }
}

export async function listServiceAvailability(
  serviceCatalogId: string,
  actorUserId: string,
): Promise<ReturnType<typeof repo.toPublicAvailability>[]> {
  const service = await repo.findServiceItemById(undefined, serviceCatalogId);
  if (!service) throw serviceCatalogNotFoundError();
  await assertClientAccess(actorUserId, service.clientId);
  const records = await repo.listAvailabilityForService(
    undefined,
    serviceCatalogId,
  );
  return records.map((record) => repo.toPublicAvailability(record));
}

export async function deactivateServiceAvailability(
  serviceCatalogId: string,
  availabilityId: string,
  actorUserId: string,
): Promise<ReturnType<typeof repo.toPublicAvailability>> {
  const service = await repo.findServiceItemById(undefined, serviceCatalogId);
  if (!service) throw serviceCatalogNotFoundError();
  await assertClientAccess(actorUserId, service.clientId);

  const grant = await repo.findAvailabilityById(undefined, availabilityId);
  if (!grant || grant.serviceCatalogId !== serviceCatalogId) {
    throw serviceCatalogAvailabilityNotFoundError();
  }
  if (grant.status !== 'ACTIVE') {
    throw serviceCatalogAvailabilityInvalidStateError();
  }

  return withTransaction(async (tx) => {
    const deactivated = await repo.deactivateAvailability(tx, availabilityId);
    if (!deactivated) throw serviceCatalogAvailabilityInvalidStateError();
    await recordOperationalEvent(
      {
        clientId: deactivated.clientId,
        eventType: 'SERVICE_CATALOG_AVAILABILITY_DEACTIVATED',
        entityType: 'SERVICE_CATALOG_AVAILABILITY',
        entityId: deactivated.id,
        actorUserId,
        summary: `Availability revoked for service ${service.code} in building ${deactivated.buildingId}.`,
        metadata: {
          serviceCatalogId,
          serviceCode: service.code,
          buildingId: deactivated.buildingId,
          clientId: deactivated.clientId,
        },
      },
      tx,
    );
    return repo.toPublicAvailability(deactivated);
  });
}

// ---------------------------------------------------------------------------
// Starter pack import
// ---------------------------------------------------------------------------

export type StarterPackImportOutcome = {
  data: StarterPackImportResult;
  replayed: boolean;
};

export async function importStarterPack(
  clientId: string,
  actorUserId: string,
  idempotencyKey: string,
): Promise<StarterPackImportOutcome> {
  // Pre-flight (clean 404/403 before any idempotency claim is recorded).
  const client = await clientRepository.findById(clientId);
  if (!client || client.status !== 'ACTIVE') {
    throw starterPackClientInvalidError();
  }
  await assertClientAccess(actorUserId, clientId);

  const fingerprint = computeRequestFingerprint({
    operation: STARTER_PACK_OPERATION_KEY,
    clientId,
  });

  const result = await executeIdempotent({
    actorUserId,
    operationKey: STARTER_PACK_OPERATION_KEY,
    idempotencyKey,
    requestFingerprint: fingerprint,
    work: async (tx: PoolClient) => {
      // Re-check under the claim: a racing import for the same Client with a
      // different key loses here and rolls back cleanly.
      const raceClient = await clientRepository.findById(clientId);
      if (!raceClient || raceClient.status !== 'ACTIVE') {
        throw starterPackClientInvalidError();
      }

      const summary = await repo.runStarterPackImport(
        clientId,
        actorUserId,
        STARTER_PACK_CATEGORIES,
        STARTER_PACK_SERVICES,
        tx,
      );

      await recordOperationalEvent(
        {
          clientId,
          eventType: 'SERVICE_CATALOG_STARTER_PACK_IMPORTED',
          entityType: 'SERVICE_CATALOG_STARTER_PACK',
          entityId: clientId,
          actorUserId,
          summary: `Starter pack import completed for client ${clientId}.`,
          metadata: {
            ...summary,
            operationKey: STARTER_PACK_OPERATION_KEY,
          },
        },
        tx,
      );

      return {
        responseStatus: 201,
        responseBody: summary,
      };
    },
  });

  const summary = result.responseBody as Omit<
    StarterPackImportResult,
    'clientId' | 'operationKey' | 'replayed'
  >;
  return {
    data: {
      ...summary,
      clientId,
      operationKey: STARTER_PACK_OPERATION_KEY,
      replayed: result.replayed,
    },
    replayed: result.replayed,
  };
}

// ---------------------------------------------------------------------------
// Authoritative read model
// ---------------------------------------------------------------------------

export async function getServiceCatalogReadModel(
  query: {
    clientId?: string;
    buildingId?: string;
    currency?: PriceCatalogCurrency;
  },
  actorUserId: string,
): Promise<ServiceCatalogReadModel> {
  const accessibleClientIds = await getAccessibleClientIds(actorUserId);

  // No-leak posture: an out-of-reach or unspecified Client yields an empty
  // model rather than an existence oracle.
  const targetClientId = query.clientId ?? null;
  if (!targetClientId || !accessibleClientIds.includes(targetClientId)) {
    return emptyReadModel(targetClientId);
  }

  const buildingId = query.buildingId ?? null;
  if (buildingId) {
    await contextAccessService.assertBuildingAccess(actorUserId, buildingId);
    const buildingClientId = await repo.loadBuildingClientId(
      undefined,
      buildingId,
    );
    if (buildingClientId !== targetClientId) {
      // The Building exists but belongs to another Client: deny without
      // revealing which Client owns it.
      throw buildingAccessDeniedError();
    }
  }

  const rows = await repo.listActiveServiceItems(undefined, targetClientId);
  const serviceIds = rows.map((row) => row.id);
  const scoped = await repo.listServicesWithAvailability(
    undefined,
    targetClientId,
    serviceIds,
  );
  const activeBuildingGrants = buildingId
    ? await repo.listActiveBuildingGrants(
        undefined,
        targetClientId,
        serviceIds,
        buildingId,
      )
    : new Set<string>();

  const asOf = new Date();
  const items: ServiceCatalogItemView[] = [];
  for (const row of rows) {
    const hasAvailability = scoped.has(row.id);
    const availabilityScope = hasAvailability
      ? 'BUILDING_SCOPED'
      : 'CLIENT_WIDE';
    const availableInBuilding =
      buildingId === null
        ? null
        : hasAvailability
          ? activeBuildingGrants.has(row.id)
          : true;

    items.push({
      id: row.id,
      clientId: row.clientId,
      code: row.code,
      name: row.name,
      description: row.description,
      status: row.status,
      source: row.source,
      categoryId: row.categoryId,
      categoryCode: row.categoryCode,
      categoryName: row.categoryName,
      availableInBuilding,
      availabilityScope,
      referencePrice: null,
    });
  }

  // Compose reference prices only when a Building + currency are supplied;
  // fail-closed otherwise (no default price is ever invented).
  if (buildingId && query.currency) {
    for (const item of items) {
      item.referencePrice = await composeServiceReferencePrice(
        targetClientId,
        buildingId,
        query.currency,
        asOf,
        item.id,
        actorUserId,
      );
    }
  }

  const categories = await repo.listCategories(
    undefined,
    [targetClientId],
    { status: 'ACTIVE' },
  );
  const categoryViews = categories.map((category) => ({
    ...repo.toPublicCategory(category),
    services: items.filter((item) => item.categoryId === category.id),
  }));

  return {
    clientId: targetClientId,
    buildingId,
    currency: query.currency ?? null,
    asOf: asOf.toISOString(),
    categories: categoryViews,
    services: items,
  };
}

async function composeServiceReferencePrice(
  clientId: string,
  buildingId: string,
  currency: PriceCatalogCurrency,
  asOf: Date,
  serviceId: string,
  actorUserId: string,
): Promise<ServiceCatalogReferencePrice | null> {
  const result = await resolveAuthorizedPriceCatalogEntry(
    {
      buildingId,
      currency,
      asOf: asOf.toISOString(),
      sourceMode: 'SERVICE',
      serviceId,
    },
    clientId,
    actorUserId,
  );
  if (result.resolution !== 'MATCHED' || !result.entry) {
    return null;
  }
  return {
    unitPrice: result.entry.unitPrice,
    currency: result.entry.currency,
    effectiveFrom: result.entry.effectiveFrom,
    effectiveTo: result.entry.effectiveTo,
    scopeTier: result.scopeTier ?? 'CLIENT_WIDE',
  };
}

function emptyReadModel(clientId: string | null): ServiceCatalogReadModel {
  const asOf = new Date();
  return {
    clientId: clientId ?? '',
    buildingId: null,
    currency: null,
    asOf: asOf.toISOString(),
    categories: [],
    services: [],
  };
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === '23505' && candidate.constraint === constraint;
}

export const serviceCatalogMasterService = {
  createServiceCategory,
  getServiceCategory,
  listServiceCategories,
  updateServiceCategory,
  deactivateServiceCategory,
  linkServiceItemCategory,
  grantServiceAvailability,
  listServiceAvailability,
  deactivateServiceAvailability,
  importStarterPack,
  getServiceCatalogReadModel,
};
