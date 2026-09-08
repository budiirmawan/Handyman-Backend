import type { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../../shared/api-response';
import {
  parseBuildingIdParam,
  parseClientIdParam,
  parseCreateTransferBody,
  parseItemIdParam,
  parseTransferIdParam,
  parseWarehouseIdParam,
} from './inventory-stock-transfer.validation';
import { inventoryStockTransferService } from './inventory-stock-transfer.service';

function paramString(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? '';
  return v ?? '';
}

export async function createTransferHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = parseCreateTransferBody(req.body);
    const performedByUserId = req.auth?.userId;
    if (!performedByUserId) {
      const { AppError } = await import('../../shared/errors');
      throw AppError.validation('Authentication required.');
    }
    const transfer = await inventoryStockTransferService.createTransfer({
      ...body,
      performedByUserId,
    });
    sendSuccess(res, transfer, 201);
  } catch (e) {
    next(e);
  }
}

export async function getTransferHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = parseTransferIdParam(paramString(req.params.id));
    const transfer = await inventoryStockTransferService.getTransferById(id, req.auth?.userId);
    sendSuccess(res, transfer);
  } catch (e) {
    next(e);
  }
}

export async function listTransfersHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const q = req.query as Record<string, string | undefined>;
    const filters: any = {};
    if (q.clientId) filters.clientId = parseClientIdParam(q.clientId);
    if (q.buildingId) filters.buildingId = parseBuildingIdParam(q.buildingId);
    if (q.sourceWarehouseId) filters.sourceWarehouseId = parseWarehouseIdParam(q.sourceWarehouseId);
    if (q.destinationWarehouseId) filters.destinationWarehouseId = parseWarehouseIdParam(q.destinationWarehouseId);
    if (q.warehouseId) filters.warehouseId = parseWarehouseIdParam(q.warehouseId);
    if (q.itemId) filters.itemId = parseItemIdParam(q.itemId);
    if (q.dateFrom) filters.dateFrom = q.dateFrom;
    if (q.dateTo) filters.dateTo = q.dateTo;
    if (q.reference) filters.reference = q.reference.trim();
    if (q.status) filters.status = q.status.trim().toUpperCase();
    if (q.performedByUserId) filters.performedByUserId = q.performedByUserId;

    const list = await inventoryStockTransferService.listTransfers(filters, req.auth?.userId);
    sendSuccess(res, list);
  } catch (e) {
    next(e);
  }
}

export async function listClientTransfersHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const clientId = parseClientIdParam(paramString(req.params.clientId));
    const q = req.query as Record<string, string | undefined>;
    const filters: any = { clientId };
    if (q.buildingId) filters.buildingId = parseBuildingIdParam(q.buildingId);
    if (q.sourceWarehouseId) filters.sourceWarehouseId = parseWarehouseIdParam(q.sourceWarehouseId);
    if (q.destinationWarehouseId) filters.destinationWarehouseId = parseWarehouseIdParam(q.destinationWarehouseId);
    if (q.warehouseId) filters.warehouseId = parseWarehouseIdParam(q.warehouseId);
    if (q.itemId) filters.itemId = parseItemIdParam(q.itemId);
    if (q.dateFrom) filters.dateFrom = q.dateFrom;
    if (q.dateTo) filters.dateTo = q.dateTo;
    if (q.reference) filters.reference = q.reference.trim();

    const list = await inventoryStockTransferService.listTransfers(filters, req.auth?.userId);
    sendSuccess(res, list);
  } catch (e) {
    next(e);
  }
}

export async function listWarehouseTransfersHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const warehouseId = parseWarehouseIdParam(paramString(req.params.warehouseId));
    const q = req.query as Record<string, string | undefined>;
    const filters: any = { warehouseId };
    if (q.itemId) filters.itemId = parseItemIdParam(q.itemId);
    if (q.clientId) filters.clientId = parseClientIdParam(q.clientId);
    if (q.buildingId) filters.buildingId = parseBuildingIdParam(q.buildingId);
    if (q.dateFrom) filters.dateFrom = q.dateFrom;
    if (q.dateTo) filters.dateTo = q.dateTo;

    const list = await inventoryStockTransferService.listTransfers(filters, req.auth?.userId);
    sendSuccess(res, list);
  } catch (e) {
    next(e);
  }
}
