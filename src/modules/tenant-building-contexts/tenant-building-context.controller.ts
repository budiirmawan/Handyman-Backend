import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { tenantBuildingContextService } from './tenant-building-context.service';
import {
  parseCreateTenantBuildingContextBody,
  parseTenantBuildingCompanyIdParam,
  parseTenantBuildingContextIdParam,
  parseTenantBuildingIdParam,
  parseUpdateTenantBuildingContextBody,
} from './tenant-building-context.validation';

const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

export async function createTenantBuildingContextHandler(
  req: Request, res: Response, next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const tenantCompanyId = parseTenantBuildingCompanyIdParam(
      param(req.params.tenantCompanyId),
    );
    const body = parseCreateTenantBuildingContextBody(req.body);
    sendSuccess(
      res,
      await tenantBuildingContextService.createTenantBuildingContext(
        { ...body, tenantCompanyId },
        req.auth.userId,
      ),
      201,
    );
  } catch (error) { next(error); }
}

export async function getTenantBuildingContextHandler(
  req: Request, res: Response, next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const id = parseTenantBuildingContextIdParam(param(req.params.id));
    sendSuccess(
      res,
      await tenantBuildingContextService.getTenantBuildingContext(id, req.auth.userId),
    );
  } catch (error) { next(error); }
}

export async function listTenantBuildingContextsHandler(
  req: Request, res: Response, next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const tenantCompanyId = parseTenantBuildingCompanyIdParam(
      param(req.params.tenantCompanyId),
    );
    sendSuccess(
      res,
      await tenantBuildingContextService.listTenantBuildingContexts(
        tenantCompanyId,
        req.auth.userId,
      ),
    );
  } catch (error) { next(error); }
}

export async function listBuildingTenantContextsHandler(
  req: Request, res: Response, next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const buildingId = parseTenantBuildingIdParam(param(req.params.buildingId));
    sendSuccess(
      res,
      await tenantBuildingContextService.listBuildingTenantContexts(
        buildingId,
        req.auth.userId,
      ),
    );
  } catch (error) { next(error); }
}

export async function updateTenantBuildingContextHandler(
  req: Request, res: Response, next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const id = parseTenantBuildingContextIdParam(param(req.params.id));
    const body = parseUpdateTenantBuildingContextBody(req.body);
    sendSuccess(
      res,
      await tenantBuildingContextService.updateTenantBuildingContext(
        id,
        body,
        req.auth.userId,
      ),
    );
  } catch (error) { next(error); }
}
