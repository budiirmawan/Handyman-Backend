import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { assetTypeService } from './asset-type.service';
import {
  parseAssetTypeCategoryIdParam,
  parseAssetTypeIdParam,
  parseCreateAssetTypeBody,
  parseUpdateAssetTypeBody,
} from './asset-type.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

export async function createAssetTypeHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const assetCategoryId = parseAssetTypeCategoryIdParam(
      paramString(req.params.categoryId),
    );
    const input = parseCreateAssetTypeBody(req.body);
    const assetType = await assetTypeService.createAssetType({
      ...input,
      assetCategoryId,
    });
    sendSuccess(res, assetType, 201);
  } catch (error) {
    next(error);
  }
}

export async function listCategoryAssetTypesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const assetCategoryId = parseAssetTypeCategoryIdParam(
      paramString(req.params.categoryId),
    );
    const assetTypes =
      await assetTypeService.listAssetTypesByCategory(assetCategoryId);
    sendSuccess(res, assetTypes);
  } catch (error) {
    next(error);
  }
}

export async function getAssetTypeHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseAssetTypeIdParam(paramString(req.params.id));
    const assetType = await assetTypeService.getAssetTypeById(id);
    sendSuccess(res, assetType);
  } catch (error) {
    next(error);
  }
}

export async function updateAssetTypeHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseAssetTypeIdParam(paramString(req.params.id));
    const input = parseUpdateAssetTypeBody(req.body);
    const assetType = await assetTypeService.updateAssetType(id, input);
    sendSuccess(res, assetType);
  } catch (error) {
    next(error);
  }
}
