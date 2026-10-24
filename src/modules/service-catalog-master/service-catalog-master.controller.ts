import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../../shared/errors';
import { sendSuccess } from '../../shared/api-response';
import { parseIdempotencyKeyRequired } from '../request-idempotency';
import { serviceCatalogMasterService } from './service-catalog-master.service';
import {
  parseAvailabilityGrantBody,
  parseCreateServiceCategoryBody,
  parseLinkCategoryBody,
  parseServiceCatalogAvailabilityIdParam,
  parseServiceCatalogReadQuery,
  parseServiceCategoryFilters,
  parseServiceCategoryIdParam,
  parseStarterPackImportBody,
  parseUpdateServiceCategoryBody,
} from './service-catalog-master.validation';

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

/**
 * CR-HM-SERVICE-CATALOG-01 PART 01 — thin transport shells. Every business
 * rule (Client access, duplicate protection, availability semantics, price
 * composition) stays in the service layer.
 */

export async function createServiceCategoryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await serviceCatalogMasterService.createServiceCategory(
        parseCreateServiceCategoryBody(req.body),
        req.auth.userId,
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function getServiceCategoryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await serviceCatalogMasterService.getServiceCategory(
        parseServiceCategoryIdParam(param(req.params.id)),
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function listServiceCategoriesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await serviceCatalogMasterService.listServiceCategories(
        parseServiceCategoryFilters(req.query),
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function updateServiceCategoryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await serviceCatalogMasterService.updateServiceCategory(
        parseServiceCategoryIdParam(param(req.params.id)),
        parseUpdateServiceCategoryBody(req.body),
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function deactivateServiceCategoryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await serviceCatalogMasterService.deactivateServiceCategory(
        parseServiceCategoryIdParam(param(req.params.id)),
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function linkServiceCategoryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = parseLinkCategoryBody(req.body);
    sendSuccess(
      res,
      await serviceCatalogMasterService.linkServiceItemCategory(
        parseServiceCategoryIdParam(param(req.params.serviceCatalogId)),
        body.serviceCategoryId,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function grantServiceAvailabilityHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = parseAvailabilityGrantBody(req.body);
    sendSuccess(
      res,
      await serviceCatalogMasterService.grantServiceAvailability(
        parseServiceCategoryIdParam(param(req.params.serviceCatalogId)),
        body.buildingId,
        req.auth.userId,
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function listServiceAvailabilityHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await serviceCatalogMasterService.listServiceAvailability(
        parseServiceCategoryIdParam(param(req.params.serviceCatalogId)),
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function deactivateServiceAvailabilityHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await serviceCatalogMasterService.deactivateServiceAvailability(
        parseServiceCategoryIdParam(param(req.params.serviceCatalogId)),
        parseServiceCatalogAvailabilityIdParam(
          param(req.params.availabilityId),
        ),
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function importStarterPackHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const idempotencyKey = parseIdempotencyKeyRequired(
      req.header('idempotency-key'),
    );
    const { clientId } = parseStarterPackImportBody(req.body);

    const result = await serviceCatalogMasterService.importStarterPack(
      clientId,
      req.auth.userId,
      idempotencyKey,
    );
    sendSuccess(res, result.data, result.replayed ? 200 : 201, {
      replayed: result.replayed,
    });
  } catch (error) {
    next(error);
  }
}

export async function getServiceCatalogReadModelHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const query = parseServiceCatalogReadQuery(req.query);
    sendSuccess(
      res,
      await serviceCatalogMasterService.getServiceCatalogReadModel(
        query,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}
