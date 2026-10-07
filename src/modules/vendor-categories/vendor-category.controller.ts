import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { vendorCategoryService } from './vendor-category.service';
import {
  parseCreateVendorCategoryBody,
  parseUpdateVendorCategoryBody,
  parseVendorCategoryClientIdParam,
  parseVendorCategoryIdParam,
} from './vendor-category.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

export async function createVendorCategoryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const clientId = parseVendorCategoryClientIdParam(
      paramString(req.params.clientId),
    );
    const input = parseCreateVendorCategoryBody(req.body);
    const category = await vendorCategoryService.createVendorCategory({
      ...input,
      clientId,
    });
    sendSuccess(res, category, 201);
  } catch (error) {
    next(error);
  }
}

export async function listClientVendorCategoriesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const clientId = parseVendorCategoryClientIdParam(
      paramString(req.params.clientId),
    );
    const categories =
      await vendorCategoryService.listVendorCategoriesByClient(clientId);
    sendSuccess(res, categories);
  } catch (error) {
    next(error);
  }
}

export async function getVendorCategoryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseVendorCategoryIdParam(paramString(req.params.id));
    const category = await vendorCategoryService.getVendorCategoryById(id);
    sendSuccess(res, category);
  } catch (error) {
    next(error);
  }
}

export async function updateVendorCategoryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseVendorCategoryIdParam(paramString(req.params.id));
    const input = parseUpdateVendorCategoryBody(req.body);
    const category = await vendorCategoryService.updateVendorCategory(id, input);
    sendSuccess(res, category);
  } catch (error) {
    next(error);
  }
}
