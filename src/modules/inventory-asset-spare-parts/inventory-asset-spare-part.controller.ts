import type { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../../shared/api-response';
import {
  parseAssetIdParam,
  parseAssetSparePartIdParam,
  parseCreateAssetSparePartBody,
  parseCreateAssetSparePartBodyForAsset,
  parseItemIdParam,
  parseUpdateAssetSparePartBody,
} from './inventory-asset-spare-part.validation';
import { inventoryAssetSparePartService } from './inventory-asset-spare-part.service';
import { isAssetSparePartStatus } from './inventory-asset-spare-part.types';

function paramString(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? '';
  return v ?? '';
}

export async function bindSparePartHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const assetId = parseAssetIdParam(paramString(req.params.assetId));
    const body = parseCreateAssetSparePartBodyForAsset(req.body, assetId);
    const binding = await inventoryAssetSparePartService.bindSparePartToAsset(body, req.auth?.userId);
    sendSuccess(res, binding, 201);
  } catch (e) {
    next(e);
  }
}

export async function getBindingHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = parseAssetSparePartIdParam(paramString(req.params.id));
    const binding = await inventoryAssetSparePartService.getBindingById(id, req.auth?.userId);
    sendSuccess(res, binding);
  } catch (e) {
    next(e);
  }
}

export async function listSparePartsByAssetHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const assetId = parseAssetIdParam(paramString(req.params.assetId));
    const q = req.query as Record<string, string | undefined>;
    const filters: any = {};
    if (q.itemId) filters.itemId = parseItemIdParam(q.itemId);
    if (q.status && isAssetSparePartStatus(q.status)) filters.status = q.status;
    if (q.clientId) filters.clientId = q.clientId;
    if (q.buildingId) filters.buildingId = q.buildingId;

    const list = await inventoryAssetSparePartService.listSparePartsByAsset(assetId, filters, req.auth?.userId);
    sendSuccess(res, list);
  } catch (e) {
    next(e);
  }
}

export async function listAssetsBySparePartHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const itemId = parseItemIdParam(paramString(req.params.itemId));
    const q = req.query as Record<string, string | undefined>;
    const filters: any = {};
    if (q.assetId) filters.assetId = parseAssetIdParam(q.assetId);
    if (q.status && isAssetSparePartStatus(q.status)) filters.status = q.status;
    if (q.clientId) filters.clientId = q.clientId;
    if (q.buildingId) filters.buildingId = q.buildingId;

    const list = await inventoryAssetSparePartService.listAssetsBySparePart(itemId, filters, req.auth?.userId);
    sendSuccess(res, list);
  } catch (e) {
    next(e);
  }
}

export async function updateBindingHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = parseAssetSparePartIdParam(paramString(req.params.id));
    const body = parseUpdateAssetSparePartBody(req.body);
    const updated = await inventoryAssetSparePartService.updateBinding(id, body, req.auth?.userId);
    sendSuccess(res, updated);
  } catch (e) {
    next(e);
  }
}
