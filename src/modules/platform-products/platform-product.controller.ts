import type { NextFunction, Request, Response } from 'express';
import {
  buildPaginationMeta,
  hasPaginationParams,
  parsePagination,
} from '../../shared/pagination';
import { sendSuccess } from '../../shared/api-response';
import {
  createSaasPackage,
  createSaasProduct,
  getSaasPackageDetail,
  getSaasProductDetail,
  listSaasPackages,
  listSaasProducts,
  updateSaasPackage,
  updateSaasProduct,
} from './platform-product.service';
import {
  parseCreateSaasPackageBody,
  parseCreateSaasProductBody,
  parseListSaasPackageFilters,
  parseListSaasProductFilters,
  parsePackageIdParam,
  parseProductIdParam,
  parseUpdateSaasPackageBody,
  parseUpdateSaasProductBody,
} from './platform-product.validation';

/**
 * CR-BE-SAAS-01 PART 02 — SaaS catalog controllers (SaaS Control Plane).
 *
 * Authority: explicit `platform.product.*` permission (router) + the
 * authenticated platform actor (`req.auth.userId`) recorded in canonical
 * audit. No building/client scoping, no caller-supplied actor.
 */

export async function listSaasProductsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const query = req.query as Record<string, unknown>;
    const filters = parseListSaasProductFilters(query);
    const pagination = parsePagination(query);
    const usePagination = hasPaginationParams(query);

    const result = await listSaasProducts({
      filters,
      withTotal: usePagination,
      page: pagination.page,
      pageSize: pagination.pageSize,
    });

    sendSuccess(
      res,
      result.records,
      200,
      usePagination
        ? buildPaginationMeta(pagination.page, pagination.pageSize, result.total ?? 0)
        : {},
    );
  } catch (error) {
    next(error);
  }
}

export async function getSaasProductHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseProductIdParam(req.params.id);
    const detail = await getSaasProductDetail(id);
    sendSuccess(res, detail, 200);
  } catch (error) {
    next(error);
  }
}

export async function createSaasProductHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = parseCreateSaasProductBody(req.body);
    const record = await createSaasProduct(
      req.auth.userId,
      'platform.product.manage',
      input,
    );
    sendSuccess(res, record, 201);
  } catch (error) {
    next(error);
  }
}

export async function updateSaasProductHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseProductIdParam(req.params.id);
    const input = parseUpdateSaasProductBody(req.body);
    const record = await updateSaasProduct(
      req.auth.userId,
      'platform.product.manage',
      id,
      input,
    );
    sendSuccess(res, record, 200);
  } catch (error) {
    next(error);
  }
}

export async function listSaasPackagesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const query = req.query as Record<string, unknown>;
    const filters = parseListSaasPackageFilters(query);
    const pagination = parsePagination(query);
    const usePagination = hasPaginationParams(query);

    const result = await listSaasPackages({
      filters,
      withTotal: usePagination,
      page: pagination.page,
      pageSize: pagination.pageSize,
    });

    sendSuccess(
      res,
      result.records,
      200,
      usePagination
        ? buildPaginationMeta(pagination.page, pagination.pageSize, result.total ?? 0)
        : {},
    );
  } catch (error) {
    next(error);
  }
}

export async function getSaasPackageHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parsePackageIdParam(req.params.id);
    const detail = await getSaasPackageDetail(id);
    sendSuccess(res, detail, 200);
  } catch (error) {
    next(error);
  }
}

export async function createSaasPackageHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = parseCreateSaasPackageBody(req.body);
    const detail = await createSaasPackage(
      req.auth.userId,
      'platform.product.manage',
      input,
    );
    sendSuccess(res, detail, 201);
  } catch (error) {
    next(error);
  }
}

export async function updateSaasPackageHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parsePackageIdParam(req.params.id);
    const input = parseUpdateSaasPackageBody(req.body);
    const detail = await updateSaasPackage(
      req.auth.userId,
      'platform.product.manage',
      id,
      input,
    );
    sendSuccess(res, detail, 200);
  } catch (error) {
    next(error);
  }
}
