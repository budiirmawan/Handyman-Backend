import type { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../../shared/api-response';
import {
  parseCreateInventoryItemBody,
  parseInventoryItemClientIdParam,
  parseInventoryItemIdParam,
  parseUpdateInventoryItemBody,
  parseUpdateInventoryItemStatusBody,
} from './inventory-item.validation';
import { inventoryItemService } from './inventory-item.service';
import type { InventoryItemFilters } from './inventory-item.types';
import { isInventoryItemStatus, isInventoryItemType } from './inventory-item.types';

function paramString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

export async function createInventoryItemHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const clientId = parseInventoryItemClientIdParam(paramString(req.params.clientId));
    const body = parseCreateInventoryItemBody(req.body);
    const actorUserId = req.auth?.userId;

    const item = await inventoryItemService.createInventoryItem(
      { ...body, clientId },
      actorUserId,
    );
    sendSuccess(res, item, 201);
  } catch (error) {
    next(error);
  }
}

export async function getInventoryItemHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseInventoryItemIdParam(paramString(req.params.id));
    const item = await inventoryItemService.getInventoryItemById(id, req.auth?.userId);
    sendSuccess(res, item);
  } catch (error) {
    next(error);
  }
}

export async function listClientInventoryItemsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const clientId = parseInventoryItemClientIdParam(paramString(req.params.clientId));
    const q = req.query as Record<string, string | undefined>;

    // Optional filters: ?status=ACTIVE&itemType=SPARE_PART&category=ELECTRICAL&search=bolt&uomId=uuid
    const filter: InventoryItemFilters = {
      clientId,
    };

    if (q.status && isInventoryItemStatus(q.status)) {
      filter.status = q.status;
    }
    if (q.itemType && isInventoryItemType(q.itemType.toUpperCase())) {
      filter.itemType = q.itemType.toUpperCase() as any;
    }
    if (q.category) {
      filter.category = q.category.trim().toUpperCase();
    }
    if (q.search) {
      filter.search = q.search.trim();
    }
    if (q.uomId) {
      filter.uomId = q.uomId.trim().toLowerCase();
    }

    const items = await inventoryItemService.listInventoryItems(filter, req.auth?.userId);
    sendSuccess(res, items);
  } catch (error) {
    next(error);
  }
}

export async function updateInventoryItemHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseInventoryItemIdParam(paramString(req.params.id));
    const body = parseUpdateInventoryItemBody(req.body);
    const item = await inventoryItemService.updateInventoryItem(id, body, req.auth?.userId);
    sendSuccess(res, item);
  } catch (error) {
    next(error);
  }
}

export async function updateInventoryItemStatusHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseInventoryItemIdParam(paramString(req.params.id));
    const body = parseUpdateInventoryItemStatusBody(req.body);
    const item = await inventoryItemService.updateInventoryItemStatus(id, body, req.auth?.userId);
    sendSuccess(res, item);
  } catch (error) {
    next(error);
  }
}
