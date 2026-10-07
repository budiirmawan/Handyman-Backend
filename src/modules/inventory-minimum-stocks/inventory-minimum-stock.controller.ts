import type { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../../shared/api-response';
import {
  parseBuildingIdParam,
  parseClientIdParam,
  parseCreateMinimumStockBody,
  parseCreateMinimumStockBodyForWarehouse,
  parseItemIdParam,
  parseMinimumStockIdParam,
  parseUpdateMinimumStockBody,
  parseWarehouseIdParam,
} from './inventory-minimum-stock.validation';
import { inventoryMinimumStockService } from './inventory-minimum-stock.service';
import { STOCK_READINESS, isMinimumStockStatus } from './inventory-minimum-stock.types';

function paramString(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? '';
  return v ?? '';
}

export async function setWarehouseMinimumStockHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const warehouseId = parseWarehouseIdParam(paramString(req.params.warehouseId));
    const body = parseCreateMinimumStockBodyForWarehouse(req.body, warehouseId);
    const created = await inventoryMinimumStockService.setMinimumStock(body, req.auth?.userId);
    sendSuccess(res, created, 201);
  } catch (e) {
    next(e);
  }
}

export async function setClientMinimumStockHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const clientId = parseClientIdParam(paramString(req.params.clientId));
    const body = parseCreateMinimumStockBody(req.body);
    if (!body.warehouseId) {
      const { AppError } = await import('../../shared/errors');
      throw AppError.validation('Request validation failed.', [
        { field: 'warehouseId', message: 'warehouseId is required.' },
      ]);
    }
    const created = await inventoryMinimumStockService.setMinimumStock(
      {
        warehouseId: body.warehouseId,
        itemId: body.itemId,
        minimumQuantity: body.minimumQuantity,
        status: (body as any).status,
      },
      req.auth?.userId,
    );

    if (clientId && created.clientId !== clientId) {
      const { AppError, ERROR_CODES } = await import('../../shared/errors');
      throw new AppError({
        code: ERROR_CODES.INVENTORY_MINIMUM_STOCK_CLIENT_MISMATCH,
        message: 'Minimum stock client does not match path client.',
        statusCode: 400,
      });
    }

    sendSuccess(res, created, 201);
  } catch (e) {
    next(e);
  }
}

export async function updateMinimumStockHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = parseMinimumStockIdParam(paramString(req.params.id));
    const body = parseUpdateMinimumStockBody(req.body);
    const updated = await inventoryMinimumStockService.updateMinimumStock(id, body, req.auth?.userId);
    sendSuccess(res, updated);
  } catch (e) {
    next(e);
  }
}

export async function getMinimumStockHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = parseMinimumStockIdParam(paramString(req.params.id));
    const item = await inventoryMinimumStockService.getMinimumStockById(id, req.auth?.userId);
    sendSuccess(res, item);
  } catch (e) {
    next(e);
  }
}

export async function listWarehouseMinimumStocksHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const warehouseId = parseWarehouseIdParam(paramString(req.params.warehouseId));
    const q = req.query as Record<string, string | undefined>;
    const filters: any = { warehouseId };
    if (q.itemId) filters.itemId = parseItemIdParam(q.itemId);
    if (q.status && isMinimumStockStatus(q.status)) filters.status = q.status;
    if (q.readiness && (STOCK_READINESS as readonly string[]).includes(q.readiness)) {
      filters.readiness = q.readiness;
    }
    if (q.clientId) filters.clientId = parseClientIdParam(q.clientId);
    if (q.buildingId) filters.buildingId = parseBuildingIdParam(q.buildingId);

    const list = await inventoryMinimumStockService.listMinimumStocks(filters, req.auth?.userId);
    sendSuccess(res, list);
  } catch (e) {
    next(e);
  }
}

export async function listBuildingMinimumStocksHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const buildingId = parseBuildingIdParam(paramString(req.params.buildingId));
    const q = req.query as Record<string, string | undefined>;
    const filters: any = { buildingId };
    if (q.warehouseId) filters.warehouseId = parseWarehouseIdParam(q.warehouseId);
    if (q.itemId) filters.itemId = parseItemIdParam(q.itemId);
    if (q.status && isMinimumStockStatus(q.status)) filters.status = q.status;
    if (q.readiness && (STOCK_READINESS as readonly string[]).includes(q.readiness)) {
      filters.readiness = q.readiness;
    }
    if (q.clientId) filters.clientId = parseClientIdParam(q.clientId);

    const list = await inventoryMinimumStockService.listMinimumStocks(filters, req.auth?.userId);
    sendSuccess(res, list);
  } catch (e) {
    next(e);
  }
}

export async function listClientMinimumStocksHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const clientId = parseClientIdParam(paramString(req.params.clientId));
    const q = req.query as Record<string, string | undefined>;
    const filters: any = { clientId };
    if (q.buildingId) filters.buildingId = parseBuildingIdParam(q.buildingId);
    if (q.warehouseId) filters.warehouseId = parseWarehouseIdParam(q.warehouseId);
    if (q.itemId) filters.itemId = parseItemIdParam(q.itemId);
    if (q.status && isMinimumStockStatus(q.status)) filters.status = q.status;
    if (q.readiness && (STOCK_READINESS as readonly string[]).includes(q.readiness)) {
      filters.readiness = q.readiness;
    }

    const list = await inventoryMinimumStockService.listMinimumStocks(filters, req.auth?.userId);
    sendSuccess(res, list);
  } catch (e) {
    next(e);
  }
}
