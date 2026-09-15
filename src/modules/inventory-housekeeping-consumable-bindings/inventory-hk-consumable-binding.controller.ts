import type { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../../shared/api-response';
import {
  parseBindingIdParam,
  parseBuildingIdParam,
  parseCleaningAreaIdParam,
  parseClientIdParam,
  parseCreateBindingBody,
  parseCreateBindingBodyForRequirement,
  parseItemIdParam,
  parseRequirementIdParam,
  parseWarehouseIdParam,
} from './inventory-hk-consumable-binding.validation';
import { inventoryHkConsumableBindingService } from './inventory-hk-consumable-binding.service';
import { isHkBindingStatus, HK_READINESS } from './inventory-hk-consumable-binding.types';

function paramString(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? '';
  return v ?? '';
}

export async function bindConsumableHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const requirementId = parseRequirementIdParam(paramString(req.params.requirementId));
    const body = parseCreateBindingBodyForRequirement(req.body, requirementId);
    const binding = await inventoryHkConsumableBindingService.bindConsumable(body, req.auth?.userId);
    sendSuccess(res, binding, 201);
  } catch (e) {
    next(e);
  }
}

export async function getBindingHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = parseBindingIdParam(paramString(req.params.id));
    const binding = await inventoryHkConsumableBindingService.getBindingById(id, req.auth?.userId);
    sendSuccess(res, binding);
  } catch (e) {
    next(e);
  }
}

export async function listBindingsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const q = req.query as Record<string, string | undefined>;
    const filters: any = {};
    if (q.clientId) filters.clientId = parseClientIdParam(q.clientId);
    if (q.buildingId) filters.buildingId = parseBuildingIdParam(q.buildingId);
    if (q.cleaningAreaId) filters.cleaningAreaId = parseCleaningAreaIdParam(q.cleaningAreaId);
    if (q.consumableRequirementId) filters.consumableRequirementId = parseRequirementIdParam(q.consumableRequirementId);
    if (q.requirementId) filters.consumableRequirementId = parseRequirementIdParam(q.requirementId);
    if (q.itemId) filters.itemId = parseItemIdParam(q.itemId);
    if (q.warehouseId) filters.warehouseId = parseWarehouseIdParam(q.warehouseId);
    if (q.status && isHkBindingStatus(q.status)) filters.status = q.status;
    if (q.readiness && (HK_READINESS as readonly string[]).includes(q.readiness)) {
      filters.readiness = q.readiness;
    }

    const list = await inventoryHkConsumableBindingService.listBindings(filters, req.auth?.userId);
    sendSuccess(res, list);
  } catch (e) {
    next(e);
  }
}

export async function listRequirementBindingsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const requirementId = parseRequirementIdParam(paramString(req.params.requirementId));
    const q = req.query as Record<string, string | undefined>;
    const filters: any = { consumableRequirementId: requirementId };
    if (q.warehouseId) filters.warehouseId = parseWarehouseIdParam(q.warehouseId);
    if (q.itemId) filters.itemId = parseItemIdParam(q.itemId);
    if (q.status && isHkBindingStatus(q.status)) filters.status = q.status;
    if (q.readiness && (HK_READINESS as readonly string[]).includes(q.readiness)) {
      filters.readiness = q.readiness;
    }

    const list = await inventoryHkConsumableBindingService.listBindings(filters, req.auth?.userId);
    sendSuccess(res, list);
  } catch (e) {
    next(e);
  }
}

export async function listBuildingBindingsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const buildingId = parseBuildingIdParam(paramString(req.params.buildingId));
    const q = req.query as Record<string, string | undefined>;
    const filters: any = { buildingId };
    if (q.cleaningAreaId) filters.cleaningAreaId = parseCleaningAreaIdParam(q.cleaningAreaId);
    if (q.consumableRequirementId) filters.consumableRequirementId = parseRequirementIdParam(q.consumableRequirementId);
    if (q.itemId) filters.itemId = parseItemIdParam(q.itemId);
    if (q.warehouseId) filters.warehouseId = parseWarehouseIdParam(q.warehouseId);
    if (q.status && isHkBindingStatus(q.status)) filters.status = q.status;
    if (q.readiness && (HK_READINESS as readonly string[]).includes(q.readiness)) {
      filters.readiness = q.readiness;
    }

    const list = await inventoryHkConsumableBindingService.listBindings(filters, req.auth?.userId);
    sendSuccess(res, list);
  } catch (e) {
    next(e);
  }
}

export async function listCleaningAreaBindingsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const cleaningAreaId = parseCleaningAreaIdParam(paramString(req.params.cleaningAreaId));
    const q = req.query as Record<string, string | undefined>;
    const filters: any = { cleaningAreaId };
    if (q.buildingId) filters.buildingId = parseBuildingIdParam(q.buildingId);
    if (q.itemId) filters.itemId = parseItemIdParam(q.itemId);
    if (q.warehouseId) filters.warehouseId = parseWarehouseIdParam(q.warehouseId);
    if (q.consumableRequirementId) filters.consumableRequirementId = parseRequirementIdParam(q.consumableRequirementId);
    if (q.status && isHkBindingStatus(q.status)) filters.status = q.status;
    if (q.readiness && (HK_READINESS as readonly string[]).includes(q.readiness)) {
      filters.readiness = q.readiness;
    }

    const list = await inventoryHkConsumableBindingService.listBindings(filters, req.auth?.userId);
    sendSuccess(res, list);
  } catch (e) {
    next(e);
  }
}

export async function listClientBindingsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const clientId = parseClientIdParam(paramString(req.params.clientId));
    const q = req.query as Record<string, string | undefined>;
    const filters: any = { clientId };
    if (q.buildingId) filters.buildingId = parseBuildingIdParam(q.buildingId);
    if (q.cleaningAreaId) filters.cleaningAreaId = parseCleaningAreaIdParam(q.cleaningAreaId);
    if (q.consumableRequirementId) filters.consumableRequirementId = parseRequirementIdParam(q.consumableRequirementId);
    if (q.itemId) filters.itemId = parseItemIdParam(q.itemId);
    if (q.warehouseId) filters.warehouseId = parseWarehouseIdParam(q.warehouseId);
    if (q.status && isHkBindingStatus(q.status)) filters.status = q.status;
    if (q.readiness && (HK_READINESS as readonly string[]).includes(q.readiness)) {
      filters.readiness = q.readiness;
    }

    const list = await inventoryHkConsumableBindingService.listBindings(filters, req.auth?.userId);
    sendSuccess(res, list);
  } catch (e) {
    next(e);
  }
}

export async function listWarehouseBindingsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const warehouseId = parseWarehouseIdParam(paramString(req.params.warehouseId));
    const q = req.query as Record<string, string | undefined>;
    const filters: any = { warehouseId };
    if (q.itemId) filters.itemId = parseItemIdParam(q.itemId);
    if (q.consumableRequirementId) filters.consumableRequirementId = parseRequirementIdParam(q.consumableRequirementId);
    if (q.status && isHkBindingStatus(q.status)) filters.status = q.status;
    if (q.readiness && (HK_READINESS as readonly string[]).includes(q.readiness)) {
      filters.readiness = q.readiness;
    }

    const list = await inventoryHkConsumableBindingService.listBindings(filters, req.auth?.userId);
    sendSuccess(res, list);
  } catch (e) {
    next(e);
  }
}

export async function listItemBindingsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const itemId = parseItemIdParam(paramString(req.params.itemId));
    const q = req.query as Record<string, string | undefined>;
    const filters: any = { itemId };
    if (q.buildingId) filters.buildingId = parseBuildingIdParam(q.buildingId);
    if (q.cleaningAreaId) filters.cleaningAreaId = parseCleaningAreaIdParam(q.cleaningAreaId);
    if (q.warehouseId) filters.warehouseId = parseWarehouseIdParam(q.warehouseId);
    if (q.consumableRequirementId) filters.consumableRequirementId = parseRequirementIdParam(q.consumableRequirementId);
    if (q.status && isHkBindingStatus(q.status)) filters.status = q.status;
    if (q.readiness && (HK_READINESS as readonly string[]).includes(q.readiness)) {
      filters.readiness = q.readiness;
    }

    const list = await inventoryHkConsumableBindingService.listBindings(filters, req.auth?.userId);
    sendSuccess(res, list);
  } catch (e) {
    next(e);
  }
}

export async function updateBindingHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = parseBindingIdParam(paramString(req.params.id));
    const body = req.body as any;
    const input: any = {};
    if (body.requiredQuantity !== undefined) input.requiredQuantity = body.requiredQuantity;
    if (body.status !== undefined) input.status = body.status;
    if (body.notes !== undefined) input.notes = body.notes;

    // Use validation for update
    const { parseCreateBindingBody } = await import('./inventory-hk-consumable-binding.validation');
    // Simple validation via service will handle, but we call update service directly
    const updated = await inventoryHkConsumableBindingService.updateBinding(id, input, req.auth?.userId);
    sendSuccess(res, updated);
  } catch (e) {
    next(e);
  }
}
