import type { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../../shared/api-response';
import {
  parseCreateWarehouseBody,
  parseUpdateWarehouseBody,
  parseUpdateWarehouseStatusBody,
  parseWarehouseBuildingIdParam,
  parseWarehouseClientIdParam,
  parseWarehouseIdParam,
} from './inventory-warehouse.validation';
import { inventoryWarehouseService } from './inventory-warehouse.service';
import type { InventoryWarehouseFilters } from './inventory-warehouse.types';
import { isInventoryWarehouseStatus } from './inventory-warehouse.types';

function paramString(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? '';
  return v ?? '';
}

export async function createWarehouseHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const buildingId = parseWarehouseBuildingIdParam(paramString(req.params.buildingId));
    const body = parseCreateWarehouseBody(req.body);
    const item = await inventoryWarehouseService.createWarehouse(
      { ...body, buildingId },
      req.auth?.userId,
    );
    sendSuccess(res, item, 201);
  } catch (e) {
    next(e);
  }
}

export async function getWarehouseHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = parseWarehouseIdParam(paramString(req.params.id));
    const item = await inventoryWarehouseService.getWarehouseById(id, req.auth?.userId);
    sendSuccess(res, item);
  } catch (e) {
    next(e);
  }
}

export async function listBuildingWarehousesHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const buildingId = parseWarehouseBuildingIdParam(paramString(req.params.buildingId));
    const q = req.query as Record<string, string | undefined>;
    const filters: Omit<InventoryWarehouseFilters, 'buildingId' | 'clientId'> = {};

    if (q.status && isInventoryWarehouseStatus(q.status)) {
      filters.status = q.status;
    }
    if (q.search) {
      filters.search = q.search.trim();
    }
    if (q.functionalLocationId) {
      filters.functionalLocationId = q.functionalLocationId.trim().toLowerCase();
    }

    const items = await inventoryWarehouseService.listWarehousesByBuilding(buildingId, filters, req.auth?.userId);
    sendSuccess(res, items);
  } catch (e) {
    next(e);
  }
}

export async function listClientWarehousesHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const clientId = parseWarehouseClientIdParam(paramString(req.params.clientId));
    const q = req.query as Record<string, string | undefined>;
    const filters: Omit<InventoryWarehouseFilters, 'clientId'> = {};

    if (q.buildingId) {
      filters.buildingId = q.buildingId.trim().toLowerCase();
    }
    if (q.status && isInventoryWarehouseStatus(q.status)) {
      filters.status = q.status;
    }
    if (q.search) {
      filters.search = q.search.trim();
    }

    const items = await inventoryWarehouseService.listWarehousesByClient(clientId, filters, req.auth?.userId);
    sendSuccess(res, items);
  } catch (e) {
    next(e);
  }
}

export async function updateWarehouseHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = parseWarehouseIdParam(paramString(req.params.id));
    const body = parseUpdateWarehouseBody(req.body);
    const item = await inventoryWarehouseService.updateWarehouse(id, body, req.auth?.userId);
    sendSuccess(res, item);
  } catch (e) {
    next(e);
  }
}

export async function updateWarehouseStatusHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = parseWarehouseIdParam(paramString(req.params.id));
    const body = parseUpdateWarehouseStatusBody(req.body);
    const item = await inventoryWarehouseService.updateWarehouseStatus(id, body, req.auth?.userId);
    sendSuccess(res, item);
  } catch (e) {
    next(e);
  }
}
