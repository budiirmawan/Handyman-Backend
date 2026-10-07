import { buildingNotFoundError, buildingRepository } from '../buildings';
import { propertyNotFoundError, propertyRepository } from '../properties';
import { functionalLocationRepository } from '../functional-locations';
import {
  buildingAccessDeniedError,
} from '../context-access/context-access.errors';
import { contextAccessService } from '../context-access';
import {
  inventoryWarehouseCodeAlreadyExistsError,
  inventoryWarehouseLocationBuildingMismatchError,
  inventoryWarehouseLocationInactiveError,
  inventoryWarehouseNotFoundError,
} from './inventory-warehouse.errors';
import { inventoryWarehouseRepository } from './inventory-warehouse.repository';
import type {
  CreateInventoryWarehouseInput,
  InventoryWarehouseFilters,
  InventoryWarehouseRecord,
  NewInventoryWarehouse,
  PublicInventoryWarehouse,
  UpdateInventoryWarehouseInput,
  UpdateInventoryWarehouseStatusInput,
} from './inventory-warehouse.types';
import { functionalLocationNotFoundError } from '../functional-locations';

function toPublic(
  record: InventoryWarehouseRecord | any,
): PublicInventoryWarehouse {
  const isJoined = record.flId !== undefined || record.functionalLocationId !== undefined && record.flCode !== undefined;
  // Support both joined and simple
  const base: PublicInventoryWarehouse = {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    functionalLocationId: record.functionalLocationId ?? null,
    code: record.code,
    name: record.name,
    description: record.description ?? null,
    status: record.status,
    createdAt: record.createdAt instanceof Date ? record.createdAt.toISOString() : String(record.createdAt),
    updatedAt: record.updatedAt instanceof Date ? record.updatedAt.toISOString() : String(record.updatedAt),
    functionalLocation: null,
  };

  if (record.flId) {
    base.functionalLocation = {
      id: record.flId,
      code: record.flCode,
      name: record.flName,
      status: record.flStatus,
    };
  }

  return base;
}

function toPublicSimple(record: InventoryWarehouseRecord): PublicInventoryWarehouse {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    functionalLocationId: record.functionalLocationId,
    code: record.code,
    name: record.name,
    description: record.description,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    functionalLocation: null,
  };
}

async function resolveBuildingContext(buildingId: string): Promise<{ clientId: string; buildingStatus: string }> {
  const building = await buildingRepository.findById(buildingId);
  if (!building) {
    throw buildingNotFoundError();
  }
  const property = await propertyRepository.findById(building.propertyId);
  if (!property) {
    throw propertyNotFoundError();
  }
  return { clientId: property.clientId, buildingStatus: building.status };
}

async function assertFunctionalLocation(
  functionalLocationId: string,
  buildingId: string,
  warehouseStatus: string,
): Promise<void> {
  const fl = await functionalLocationRepository.findById(functionalLocationId);
  if (!fl) {
    throw functionalLocationNotFoundError();
  }
  if (fl.buildingId !== buildingId) {
    throw inventoryWarehouseLocationBuildingMismatchError();
  }
  if (fl.status !== 'ACTIVE' && warehouseStatus === 'ACTIVE') {
    throw inventoryWarehouseLocationInactiveError();
  }
}

async function assertBuildingAccess(actorUserId: string | undefined, buildingId: string): Promise<void> {
  if (!actorUserId) return;
  const allowed = await contextAccessService.canAccessBuilding(actorUserId, buildingId);
  if (!allowed) {
    throw buildingAccessDeniedError();
  }
}

async function assertClientAccess(actorUserId: string | undefined, clientId: string): Promise<void> {
  if (!actorUserId) return;
  const allowed = await contextAccessService.canAccessClient(actorUserId, clientId);
  if (!allowed) {
    throw buildingAccessDeniedError();
  }
}

/**
 * Create warehouse/store under a Building.
 * Validation order:
 * 1. unknown Building → 404 BUILDING_NOT_FOUND
 * 2. INACTIVE Building → 400 BUILDING_NOT_AVAILABLE (reusing existing code)
 * 3. duplicate code for Building → 409 INVENTORY_WAREHOUSE_CODE_ALREADY_EXISTS
 * 4. unknown Functional Location → 404 FUNCTIONAL_LOCATION_NOT_FOUND
 * 5. FL of different Building → 400 LOCATION_BUILDING_MISMATCH
 * 6. INACTIVE FL for ACTIVE warehouse → 400 LOCATION_INACTIVE
 */
export async function createWarehouse(
  input: CreateInventoryWarehouseInput,
  actorUserId?: string,
): Promise<PublicInventoryWarehouse> {
  const { clientId, buildingStatus } = await resolveBuildingContext(input.buildingId);
  if (buildingStatus !== 'ACTIVE') {
    // Reuse building not available via functional error — import lazily to avoid circular
    const { buildingNotFoundError: _unused, buildingRepository: __unused } = await import('../buildings');
    // Use AppError directly for BUILDING_NOT_AVAILABLE
    const { AppError, ERROR_CODES } = await import('../../shared/errors');
    throw new AppError({
      code: ERROR_CODES.BUILDING_NOT_AVAILABLE,
      message: 'Inactive buildings cannot register new warehouse/store.',
      statusCode: 400,
    });
  }

  if (actorUserId) {
    await assertBuildingAccess(actorUserId, input.buildingId);
  }

  const existing = await inventoryWarehouseRepository.findByCodeForBuilding(
    input.buildingId,
    input.code,
  );
  if (existing) {
    throw inventoryWarehouseCodeAlreadyExistsError();
  }

  const status = input.status ?? 'ACTIVE';

  if (input.functionalLocationId) {
    await assertFunctionalLocation(input.functionalLocationId, input.buildingId, status);
  }

  const newRec: NewInventoryWarehouse = {
    clientId,
    buildingId: input.buildingId,
    functionalLocationId: input.functionalLocationId ?? null,
    code: input.code,
    name: input.name,
    description: input.description?.trim() || null,
    status,
  };

  try {
    const record = await inventoryWarehouseRepository.create(newRec);
    const withLoc = await inventoryWarehouseRepository.findByIdWithLocation(record.id);
    return toPublic(withLoc ?? record);
  } catch (e) {
    if (isCodeUniqueViolation(e)) {
      throw inventoryWarehouseCodeAlreadyExistsError();
    }
    throw e;
  }
}

export async function getWarehouseById(
  id: string,
  actorUserId?: string,
): Promise<PublicInventoryWarehouse> {
  const withLoc = await inventoryWarehouseRepository.findByIdWithLocation(id);
  if (!withLoc) {
    throw inventoryWarehouseNotFoundError();
  }
  if (actorUserId) {
    await assertBuildingAccess(actorUserId, withLoc.buildingId);
  }
  return toPublic(withLoc);
}

export async function listWarehousesByBuilding(
  buildingId: string,
  filters: Omit<InventoryWarehouseFilters, 'buildingId' | 'clientId'>,
  actorUserId?: string,
): Promise<PublicInventoryWarehouse[]> {
  const { clientId } = await resolveBuildingContext(buildingId);
  if (actorUserId) {
    await assertBuildingAccess(actorUserId, buildingId);
  }
  const records = await inventoryWarehouseRepository.listByBuilding(buildingId, {
    status: filters.status,
    search: filters.search,
    functionalLocationId: filters.functionalLocationId,
  });
  // Enrich FLs batch
  const flIds = [...new Set(records.map(r => r.functionalLocationId).filter((v): v is string => Boolean(v)))];
  let flMap = new Map<string, { code: string; name: string; status: string }>();
  if (flIds.length) {
    const { getPool } = await import('../../database');
    const res = await getPool().query(
      'SELECT id, code, name, status FROM functional_locations WHERE id = ANY($1)',
      [flIds],
    );
    for (const row of res.rows) {
      flMap.set(row.id, { code: row.code, name: row.name, status: row.status });
    }
  }
  return records.map(r => {
    const base = toPublicSimple(r);
    if (r.functionalLocationId && flMap.has(r.functionalLocationId)) {
      const fl = flMap.get(r.functionalLocationId)!;
      base.functionalLocation = {
        id: r.functionalLocationId,
        code: fl.code,
        name: fl.name,
        status: fl.status,
      };
    }
    return base;
  });
}

export async function listWarehousesByClient(
  clientId: string,
  filters: Omit<InventoryWarehouseFilters, 'clientId'>,
  actorUserId?: string,
): Promise<PublicInventoryWarehouse[]> {
  // Validate client exists via building resolution? We'll check via buildingId if provided else check client table
  if (filters.buildingId) {
    const ctx = await resolveBuildingContext(filters.buildingId);
    if (ctx.clientId !== clientId) {
      // Cross-client building rejection
      const { AppError, ERROR_CODES } = await import('../../shared/errors');
      throw new AppError({
        code: ERROR_CODES.INVENTORY_WAREHOUSE_CLIENT_MISMATCH,
        message: 'Warehouse building must belong to same client.',
        statusCode: 400,
      });
    }
    if (actorUserId) {
      await assertBuildingAccess(actorUserId, filters.buildingId);
    }
  } else if (actorUserId) {
    await assertClientAccess(actorUserId, clientId);
  }

  const records = await inventoryWarehouseRepository.listByClient(clientId, {
    buildingId: filters.buildingId,
    status: filters.status,
    search: filters.search,
  });
  return records.map(toPublicSimple);
}

export async function updateWarehouse(
  id: string,
  input: UpdateInventoryWarehouseInput,
  actorUserId?: string,
): Promise<PublicInventoryWarehouse> {
  const existing = await inventoryWarehouseRepository.findById(id);
  if (!existing) {
    throw inventoryWarehouseNotFoundError();
  }
  if (actorUserId) {
    await assertBuildingAccess(actorUserId, existing.buildingId);
  }

  const nextStatus = input.status ?? existing.status;

  if (input.functionalLocationId !== undefined && input.functionalLocationId !== null) {
    await assertFunctionalLocation(input.functionalLocationId, existing.buildingId, nextStatus);
  }

  const updated = await inventoryWarehouseRepository.update(id, {
    name: input.name?.trim(),
    functionalLocationId: input.functionalLocationId,
    description:
      input.description === undefined
        ? undefined
        : input.description === null
          ? null
          : input.description.trim() || null,
    status: input.status,
  });

  if (!updated) {
    throw inventoryWarehouseNotFoundError();
  }

  const withLoc = await inventoryWarehouseRepository.findByIdWithLocation(id);
  return toPublic(withLoc ?? updated);
}

export async function updateWarehouseStatus(
  id: string,
  input: UpdateInventoryWarehouseStatusInput,
  actorUserId?: string,
): Promise<PublicInventoryWarehouse> {
  return updateWarehouse(id, { status: input.status }, actorUserId);
}

function isCodeUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const c = error as { code?: string; constraint?: string };
  return c.code === '23505' && c.constraint === 'inventory_warehouses_building_code_unique';
}

export const inventoryWarehouseService = {
  createWarehouse,
  getWarehouseById,
  listWarehousesByBuilding,
  listWarehousesByClient,
  updateWarehouse,
  updateWarehouseStatus,
};
