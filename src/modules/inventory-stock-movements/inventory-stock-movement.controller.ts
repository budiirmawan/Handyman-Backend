import type { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../../shared/api-response';
import {
  parseBuildingIdParam,
  parseClientIdParam,
  parseCreateMovementBody,
  parseCreateMovementBodyForWarehouse,
  parseItemIdParam,
  parseMovementIdParam,
  parseWarehouseIdParam,
} from './inventory-stock-movement.validation';
import { inventoryStockMovementService } from './inventory-stock-movement.service';
import { isStockMovementType } from './inventory-stock-movement.types';

function paramString(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? '';
  return v ?? '';
}

export async function postWarehouseStockMovementHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const warehouseId = parseWarehouseIdParam(paramString(req.params.warehouseId));
    const body = parseCreateMovementBodyForWarehouse(req.body, warehouseId);
    const performedByUserId = req.auth?.userId;
    if (!performedByUserId) {
      const { AppError } = await import('../../shared/errors');
      throw AppError.validation('Authentication required.');
    }
    const movement = await inventoryStockMovementService.postStockMovement({
      warehouseId,
      itemId: body.itemId,
      movementType: body.movementType,
      quantity: body.quantity,
      movementDate: (body as any).movementDate,
      reference: (body as any).reference,
      source: (body as any).source,
      notes: (body as any).notes,
      performedByUserId,
    });
    sendSuccess(res, movement, 201);
  } catch (e) {
    next(e);
  }
}

export async function postClientStockMovementHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const clientId = parseClientIdParam(paramString(req.params.clientId));
    const body = parseCreateMovementBody(req.body);
    if (!body.warehouseId) {
      const { AppError } = await import('../../shared/errors');
      throw AppError.validation('Request validation failed.', [
        { field: 'warehouseId', message: 'warehouseId is required.' },
      ]);
    }
    // Optional clientId in path is for isolation check; service will verify warehouse client matches
    const performedByUserId = req.auth?.userId!;
    const movement = await inventoryStockMovementService.postStockMovement({
      warehouseId: body.warehouseId,
      itemId: body.itemId,
      movementType: body.movementType,
      quantity: body.quantity,
      movementDate: (body as any).movementDate,
      reference: (body as any).reference,
      source: (body as any).source,
      notes: (body as any).notes,
      performedByUserId,
    });

    if (clientId && movement.clientId !== clientId) {
      const { AppError, ERROR_CODES } = await import('../../shared/errors');
      throw new AppError({
        code: ERROR_CODES.INVENTORY_STOCK_MOVEMENT_CLIENT_MISMATCH,
        message: 'Movement client does not match path client.',
        statusCode: 400,
      });
    }

    sendSuccess(res, movement, 201);
  } catch (e) {
    next(e);
  }
}

export async function getMovementHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = parseMovementIdParam(paramString(req.params.id));
    const movement = await inventoryStockMovementService.getMovementById(id, req.auth?.userId);
    sendSuccess(res, movement);
  } catch (e) {
    next(e);
  }
}

export async function listWarehouseMovementsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const warehouseId = parseWarehouseIdParam(paramString(req.params.warehouseId));
    const q = req.query as Record<string, string | undefined>;
    const filters: any = { warehouseId };
    if (q.itemId) filters.itemId = parseItemIdParam(q.itemId);
    if (q.movementType && isStockMovementType(q.movementType.toUpperCase())) {
      filters.movementType = q.movementType.toUpperCase();
    }
    if (q.dateFrom) filters.dateFrom = q.dateFrom;
    if (q.dateTo) filters.dateTo = q.dateTo;
    if (q.reference) filters.reference = q.reference.trim();
    if (q.clientId) filters.clientId = parseClientIdParam(q.clientId);
    if (q.buildingId) filters.buildingId = parseBuildingIdParam(q.buildingId);

    const list = await inventoryStockMovementService.listMovements(filters, req.auth?.userId);
    sendSuccess(res, list);
  } catch (e) {
    next(e);
  }
}

export async function listBuildingMovementsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const buildingId = parseBuildingIdParam(paramString(req.params.buildingId));
    const q = req.query as Record<string, string | undefined>;
    const filters: any = { buildingId };
    if (q.warehouseId) filters.warehouseId = parseWarehouseIdParam(q.warehouseId);
    if (q.itemId) filters.itemId = parseItemIdParam(q.itemId);
    if (q.movementType && isStockMovementType(q.movementType.toUpperCase())) {
      filters.movementType = q.movementType.toUpperCase();
    }
    if (q.dateFrom) filters.dateFrom = q.dateFrom;
    if (q.dateTo) filters.dateTo = q.dateTo;
    if (q.reference) filters.reference = q.reference.trim();
    if (q.clientId) filters.clientId = parseClientIdParam(q.clientId);

    const list = await inventoryStockMovementService.listMovements(filters, req.auth?.userId);
    sendSuccess(res, list);
  } catch (e) {
    next(e);
  }
}

export async function listClientMovementsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const clientId = parseClientIdParam(paramString(req.params.clientId));
    const q = req.query as Record<string, string | undefined>;
    const filters: any = { clientId };
    if (q.buildingId) filters.buildingId = parseBuildingIdParam(q.buildingId);
    if (q.warehouseId) filters.warehouseId = parseWarehouseIdParam(q.warehouseId);
    if (q.itemId) filters.itemId = parseItemIdParam(q.itemId);
    if (q.movementType && isStockMovementType(q.movementType.toUpperCase())) {
      filters.movementType = q.movementType.toUpperCase();
    }
    if (q.dateFrom) filters.dateFrom = q.dateFrom;
    if (q.dateTo) filters.dateTo = q.dateTo;
    if (q.reference) filters.reference = q.reference.trim();

    const list = await inventoryStockMovementService.listMovements(filters, req.auth?.userId);
    sendSuccess(res, list);
  } catch (e) {
    next(e);
  }
}
