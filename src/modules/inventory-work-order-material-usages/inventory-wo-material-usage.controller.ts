import type { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../../shared/api-response';
import {
  parseBuildingIdParam,
  parseClientIdParam,
  parseCreateUsageBody,
  parseCreateUsageBodyForWorkOrder,
  parseItemIdParam,
  parseMaterialRequestIdParam,
  parseReservationIdParam,
  parseUsageIdParam,
  parseWarehouseIdParam,
  parseWorkOrderIdParam,
} from './inventory-wo-material-usage.validation';
import { inventoryWorkOrderMaterialUsageService } from './inventory-wo-material-usage.service';

function paramString(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? '';
  return v ?? '';
}

export async function recordWorkOrderMaterialUsageHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const workOrderId = parseWorkOrderIdParam(paramString(req.params.workOrderId));
    const body = parseCreateUsageBodyForWorkOrder(req.body, workOrderId);
    const usedByUserId = req.auth?.userId;
    if (!usedByUserId) {
      const { AppError } = await import('../../shared/errors');
      throw AppError.validation('Authentication required.');
    }
    const usage = await inventoryWorkOrderMaterialUsageService.recordMaterialUsage({
      ...body,
      usedByUserId,
    });
    sendSuccess(res, usage, 201);
  } catch (e) {
    next(e);
  }
}

export async function getWorkOrderMaterialCostSummaryHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const workOrderId = parseWorkOrderIdParam(paramString(req.params.workOrderId));
    const summary = await inventoryWorkOrderMaterialUsageService.getWorkOrderMaterialCostSummary(
      workOrderId,
      req.auth?.userId,
    );
    sendSuccess(res, summary);
  } catch (e) {
    next(e);
  }
}

export async function getUsageHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = parseUsageIdParam(paramString(req.params.id));
    const usage = await inventoryWorkOrderMaterialUsageService.getUsageById(id, req.auth?.userId);
    sendSuccess(res, usage);
  } catch (e) {
    next(e);
  }
}

export async function listWorkOrderUsagesHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const workOrderId = parseWorkOrderIdParam(paramString(req.params.workOrderId));
    const q = req.query as Record<string, string | undefined>;
    const filters: any = { workOrderId };
    if (q.warehouseId) filters.warehouseId = parseWarehouseIdParam(q.warehouseId);
    if (q.itemId) filters.itemId = parseItemIdParam(q.itemId);
    if (q.materialRequestId) filters.materialRequestId = parseMaterialRequestIdParam(q.materialRequestId);
    if (q.reservationId) filters.reservationId = parseReservationIdParam(q.reservationId);
    if (q.clientId) filters.clientId = parseClientIdParam(q.clientId);
    if (q.buildingId) filters.buildingId = parseBuildingIdParam(q.buildingId);
    if (q.dateFrom) filters.dateFrom = q.dateFrom;
    if (q.dateTo) filters.dateTo = q.dateTo;

    const list = await inventoryWorkOrderMaterialUsageService.listUsages(filters, req.auth?.userId);
    sendSuccess(res, list);
  } catch (e) {
    next(e);
  }
}

export async function listClientUsagesHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const clientId = parseClientIdParam(paramString(req.params.clientId));
    const q = req.query as Record<string, string | undefined>;
    const filters: any = { clientId };
    if (q.buildingId) filters.buildingId = parseBuildingIdParam(q.buildingId);
    if (q.workOrderId) filters.workOrderId = parseWorkOrderIdParam(q.workOrderId);
    if (q.warehouseId) filters.warehouseId = parseWarehouseIdParam(q.warehouseId);
    if (q.itemId) filters.itemId = parseItemIdParam(q.itemId);
    if (q.materialRequestId) filters.materialRequestId = parseMaterialRequestIdParam(q.materialRequestId);
    if (q.reservationId) filters.reservationId = parseReservationIdParam(q.reservationId);
    if (q.dateFrom) filters.dateFrom = q.dateFrom;
    if (q.dateTo) filters.dateTo = q.dateTo;
    if (q.reference) filters.reference = q.reference.trim();

    const list = await inventoryWorkOrderMaterialUsageService.listUsages(filters, req.auth?.userId);
    sendSuccess(res, list);
  } catch (e) {
    next(e);
  }
}

export async function listBuildingUsagesHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const buildingId = parseBuildingIdParam(paramString(req.params.buildingId));
    const q = req.query as Record<string, string | undefined>;
    const filters: any = { buildingId };
    if (q.workOrderId) filters.workOrderId = parseWorkOrderIdParam(q.workOrderId);
    if (q.warehouseId) filters.warehouseId = parseWarehouseIdParam(q.warehouseId);
    if (q.itemId) filters.itemId = parseItemIdParam(q.itemId);
    if (q.materialRequestId) filters.materialRequestId = parseMaterialRequestIdParam(q.materialRequestId);
    if (q.reservationId) filters.reservationId = parseReservationIdParam(q.reservationId);
    if (q.clientId) filters.clientId = parseClientIdParam(q.clientId);
    if (q.dateFrom) filters.dateFrom = q.dateFrom;
    if (q.dateTo) filters.dateTo = q.dateTo;

    const list = await inventoryWorkOrderMaterialUsageService.listUsages(filters, req.auth?.userId);
    sendSuccess(res, list);
  } catch (e) {
    next(e);
  }
}
