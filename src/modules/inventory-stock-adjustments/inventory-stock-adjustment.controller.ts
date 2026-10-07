import type { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../../shared/api-response';
import {
  parseBuildingIdParam,
  parseClientIdParam,
  parseAdjustmentIdParam,
  parseCreateAdjustmentBody,
  parseCreateAdjustmentBodyForWarehouse,
  parseItemIdParam,
  parseWarehouseIdParam,
} from './inventory-stock-adjustment.validation';
import { inventoryStockAdjustmentService } from './inventory-stock-adjustment.service';
import { isAdjustmentType } from './inventory-stock-adjustment.types';

function paramString(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? '';
  return v ?? '';
}

export async function postWarehouseAdjustmentHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const warehouseId = parseWarehouseIdParam(paramString(req.params.warehouseId));
    const body = parseCreateAdjustmentBodyForWarehouse(req.body, warehouseId);
    const performedByUserId = req.auth?.userId;
    if (!performedByUserId) {
      const { AppError } = await import('../../shared/errors');
      throw AppError.validation('Authentication required.');
    }
    const adj = await inventoryStockAdjustmentService.postAdjustment({
      ...body,
      performedByUserId,
    });
    sendSuccess(res, adj, 201);
  } catch (e) {
    next(e);
  }
}

export async function postClientAdjustmentHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const clientId = parseClientIdParam(paramString(req.params.clientId));
    const body = parseCreateAdjustmentBody(req.body);
    if (!body.warehouseId || body.warehouseId === '') {
      const { AppError } = await import('../../shared/errors');
      throw AppError.validation('Request validation failed.', [
        { field: 'warehouseId', message: 'warehouseId is required.' },
      ]);
    }
    const performedByUserId = req.auth?.userId!;
    const adj = await inventoryStockAdjustmentService.postAdjustment({
      warehouseId: body.warehouseId,
      itemId: body.itemId,
      adjustmentType: body.adjustmentType,
      quantity: body.quantity,
      reason: body.reason,
      adjustedAt: (body as any).adjustedAt,
      reference: (body as any).reference,
      notes: (body as any).notes,
      performedByUserId,
    });

    if (clientId && adj.clientId !== clientId) {
      const { AppError, ERROR_CODES } = await import('../../shared/errors');
      throw new AppError({
        code: ERROR_CODES.INVENTORY_ADJUSTMENT_CLIENT_MISMATCH,
        message: 'Adjustment client does not match path client.',
        statusCode: 400,
      });
    }

    sendSuccess(res, adj, 201);
  } catch (e) {
    next(e);
  }
}

export async function getAdjustmentHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = parseAdjustmentIdParam(paramString(req.params.id));
    const adj = await inventoryStockAdjustmentService.getAdjustmentById(id, req.auth?.userId);
    sendSuccess(res, adj);
  } catch (e) {
    next(e);
  }
}

export async function listWarehouseAdjustmentsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const warehouseId = parseWarehouseIdParam(paramString(req.params.warehouseId));
    const q = req.query as Record<string, string | undefined>;
    const filters: any = { warehouseId };
    if (q.itemId) filters.itemId = parseItemIdParam(q.itemId);
    if (q.adjustmentType && isAdjustmentType(q.adjustmentType.toUpperCase())) {
      filters.adjustmentType = q.adjustmentType.toUpperCase();
    }
    if (q.dateFrom) filters.dateFrom = q.dateFrom;
    if (q.dateTo) filters.dateTo = q.dateTo;
    if (q.reference) filters.reference = q.reference.trim();
    if (q.clientId) filters.clientId = parseClientIdParam(q.clientId);
    if (q.buildingId) filters.buildingId = parseBuildingIdParam(q.buildingId);

    const list = await inventoryStockAdjustmentService.listAdjustments(filters, req.auth?.userId);
    sendSuccess(res, list);
  } catch (e) {
    next(e);
  }
}

export async function listBuildingAdjustmentsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const buildingId = parseBuildingIdParam(paramString(req.params.buildingId));
    const q = req.query as Record<string, string | undefined>;
    const filters: any = { buildingId };
    if (q.warehouseId) filters.warehouseId = parseWarehouseIdParam(q.warehouseId);
    if (q.itemId) filters.itemId = parseItemIdParam(q.itemId);
    if (q.adjustmentType && isAdjustmentType(q.adjustmentType.toUpperCase())) {
      filters.adjustmentType = q.adjustmentType.toUpperCase();
    }
    if (q.dateFrom) filters.dateFrom = q.dateFrom;
    if (q.dateTo) filters.dateTo = q.dateTo;
    if (q.reference) filters.reference = q.reference.trim();
    if (q.clientId) filters.clientId = parseClientIdParam(q.clientId);

    const list = await inventoryStockAdjustmentService.listAdjustments(filters, req.auth?.userId);
    sendSuccess(res, list);
  } catch (e) {
    next(e);
  }
}

export async function listClientAdjustmentsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const clientId = parseClientIdParam(paramString(req.params.clientId));
    const q = req.query as Record<string, string | undefined>;
    const filters: any = { clientId };
    if (q.buildingId) filters.buildingId = parseBuildingIdParam(q.buildingId);
    if (q.warehouseId) filters.warehouseId = parseWarehouseIdParam(q.warehouseId);
    if (q.itemId) filters.itemId = parseItemIdParam(q.itemId);
    if (q.adjustmentType && isAdjustmentType(q.adjustmentType.toUpperCase())) {
      filters.adjustmentType = q.adjustmentType.toUpperCase();
    }
    if (q.dateFrom) filters.dateFrom = q.dateFrom;
    if (q.dateTo) filters.dateTo = q.dateTo;
    if (q.reference) filters.reference = q.reference.trim();

    const list = await inventoryStockAdjustmentService.listAdjustments(filters, req.auth?.userId);
    sendSuccess(res, list);
  } catch (e) {
    next(e);
  }
}
