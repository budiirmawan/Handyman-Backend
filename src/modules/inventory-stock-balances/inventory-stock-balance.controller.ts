import type { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../../shared/api-response';
import {
  parseBuildingIdParam,
  parseClientIdParam,
  parseCreateStockBalanceBody,
  parseCreateStockBalanceBodyForWarehouse,
  parseItemIdParam,
  parseStockBalanceIdParam,
  parseWarehouseIdParam,
} from './inventory-stock-balance.validation';
import { inventoryStockBalanceService } from './inventory-stock-balance.service';

function paramString(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? '';
  return v ?? '';
}

export async function initializeStockBalanceHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = parseCreateStockBalanceBody(req.body);
    // body must contain warehouseId when using client/global route, else missing → will be caught in service if empty
    if (!body.warehouseId || body.warehouseId === '') {
      // Try client/body path error — require warehouseId
      throw new Error('warehouseId required'); // will be caught as validation? Use AppError
    }
    const created = await inventoryStockBalanceService.initializeStockBalance(
      { warehouseId: body.warehouseId, itemId: body.itemId, quantityOnHand: body.quantityOnHand, reservedQuantity: body.reservedQuantity },
      req.auth?.userId,
    );
    sendSuccess(res, created, 201);
  } catch (e) {
    // Transform generic error for missing warehouseId into validation
    if (e instanceof Error && e.message === 'warehouseId required') {
      const { AppError } = await import('../../shared/errors');
      return next(
        AppError.validation('Request validation failed.', [
          { field: 'warehouseId', message: 'warehouseId is required.' },
        ]),
      );
    }
    next(e);
  }
}

export async function initializeWarehouseStockBalanceHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const warehouseId = parseWarehouseIdParam(paramString(req.params.warehouseId));
    const body = parseCreateStockBalanceBodyForWarehouse(req.body, warehouseId);
    const created = await inventoryStockBalanceService.initializeStockBalance(
      body,
      req.auth?.userId,
    );
    sendSuccess(res, created, 201);
  } catch (e) {
    next(e);
  }
}

export async function getStockBalanceHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = parseStockBalanceIdParam(paramString(req.params.id));
    const bal = await inventoryStockBalanceService.getStockBalanceById(id, req.auth?.userId);
    sendSuccess(res, bal);
  } catch (e) {
    next(e);
  }
}

export async function listClientStockBalancesHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const clientId = parseClientIdParam(paramString(req.params.clientId));
    const q = req.query as Record<string, string | undefined>;
    const filters: any = { clientId };
    if (q.buildingId) filters.buildingId = parseBuildingIdParam(q.buildingId);
    if (q.warehouseId) filters.warehouseId = parseWarehouseIdParam(q.warehouseId);
    if (q.itemId) filters.itemId = parseItemIdParam(q.itemId);

    const list = await inventoryStockBalanceService.listStockBalances(filters, req.auth?.userId);
    sendSuccess(res, list);
  } catch (e) {
    next(e);
  }
}

export async function listWarehouseStockBalancesHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const warehouseId = parseWarehouseIdParam(paramString(req.params.warehouseId));
    const q = req.query as Record<string, string | undefined>;
    const filters: any = { warehouseId };
    if (q.itemId) filters.itemId = parseItemIdParam(q.itemId);
    // Optional client/building not needed but allow building filter via query for consistency
    if (q.buildingId) filters.buildingId = parseBuildingIdParam(q.buildingId);
    if (q.clientId) filters.clientId = parseClientIdParam(q.clientId);

    const list = await inventoryStockBalanceService.listStockBalances(filters, req.auth?.userId);
    sendSuccess(res, list);
  } catch (e) {
    next(e);
  }
}

export async function listBuildingStockBalancesHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const buildingId = parseBuildingIdParam(paramString(req.params.buildingId));
    const q = req.query as Record<string, string | undefined>;
    const filters: any = { buildingId };
    if (q.warehouseId) filters.warehouseId = parseWarehouseIdParam(q.warehouseId);
    if (q.itemId) filters.itemId = parseItemIdParam(q.itemId);
    if (q.clientId) filters.clientId = parseClientIdParam(q.clientId);

    const list = await inventoryStockBalanceService.listStockBalances(filters, req.auth?.userId);
    sendSuccess(res, list);
  } catch (e) {
    next(e);
  }
}
