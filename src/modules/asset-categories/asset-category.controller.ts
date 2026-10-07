import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { assetCategoryService } from './asset-category.service';
import {
  parseAssetCategoryClientIdParam,
  parseAssetCategoryIdParam,
  parseCreateAssetCategoryBody,
  parseUpdateAssetCategoryBody,
} from './asset-category.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

export async function createAssetCategoryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const clientId = parseAssetCategoryClientIdParam(
      paramString(req.params.clientId),
    );
    const input = parseCreateAssetCategoryBody(req.body);
    const category = await assetCategoryService.createAssetCategory({
      ...input,
      clientId,
    });
    sendSuccess(res, category, 201);
  } catch (error) {
    next(error);
  }
}

export async function listClientAssetCategoriesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const clientId = parseAssetCategoryClientIdParam(
      paramString(req.params.clientId),
    );
    const categories =
      await assetCategoryService.listAssetCategoriesByClient(clientId);
    sendSuccess(res, categories);
  } catch (error) {
    next(error);
  }
}

export async function getAssetCategoryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseAssetCategoryIdParam(paramString(req.params.id));
    const category = await assetCategoryService.getAssetCategoryById(id);
    sendSuccess(res, category);
  } catch (error) {
    next(error);
  }
}

export async function updateAssetCategoryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseAssetCategoryIdParam(paramString(req.params.id));
    const input = parseUpdateAssetCategoryBody(req.body);
    const category = await assetCategoryService.updateAssetCategory(id, input);
    sendSuccess(res, category);
  } catch (error) {
    next(error);
  }
}
