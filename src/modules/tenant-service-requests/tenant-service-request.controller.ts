import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { tenantServiceRequestService } from './tenant-service-request.service';
import {
  parseCreateServiceRequestWorkOrderBody,
  parseCreateTenantServiceRequestBody,
  parseTenantServiceRequestBuildingIdParam,
  parseTenantServiceRequestCompanyIdParam,
  parseTenantServiceRequestFilters,
  parseTenantServiceRequestIdParam,
  parseUpdateTenantServiceRequestBody,
} from './tenant-service-request.validation';

const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function createTenantServiceRequestHandler(
  req: Request, res: Response, next: NextFunction,
): Promise<void> {
  try {
    const tenantCompanyId = parseTenantServiceRequestCompanyIdParam(
      param(req.params.tenantCompanyId),
    );
    const body = parseCreateTenantServiceRequestBody(req.body);
    sendSuccess(
      res,
      await tenantServiceRequestService.createTenantServiceRequest(
        { ...body, tenantCompanyId }, actor(req),
      ),
      201,
    );
  } catch (error) { next(error); }
}

export async function getTenantServiceRequestHandler(
  req: Request, res: Response, next: NextFunction,
): Promise<void> {
  try {
    const id = parseTenantServiceRequestIdParam(param(req.params.id));
    sendSuccess(res, await tenantServiceRequestService.getTenantServiceRequest(id, actor(req)));
  } catch (error) { next(error); }
}

export async function listTenantServiceRequestsHandler(
  req: Request, res: Response, next: NextFunction,
): Promise<void> {
  try {
    const tenantCompanyId = parseTenantServiceRequestCompanyIdParam(
      param(req.params.tenantCompanyId),
    );
    const filters = parseTenantServiceRequestFilters(req.query);
    sendSuccess(
      res,
      await tenantServiceRequestService.listTenantServiceRequests(
        tenantCompanyId, filters, actor(req),
      ),
    );
  } catch (error) { next(error); }
}

export async function listBuildingServiceRequestsHandler(
  req: Request, res: Response, next: NextFunction,
): Promise<void> {
  try {
    const buildingId = parseTenantServiceRequestBuildingIdParam(
      param(req.params.buildingId),
    );
    const filters = parseTenantServiceRequestFilters(req.query);
    sendSuccess(
      res,
      await tenantServiceRequestService.listBuildingServiceRequests(
        buildingId, filters, actor(req),
      ),
    );
  } catch (error) { next(error); }
}

export async function updateTenantServiceRequestHandler(
  req: Request, res: Response, next: NextFunction,
): Promise<void> {
  try {
    const id = parseTenantServiceRequestIdParam(param(req.params.id));
    const body = parseUpdateTenantServiceRequestBody(req.body);
    sendSuccess(
      res,
      await tenantServiceRequestService.updateTenantServiceRequest(
        id, body, actor(req),
      ),
    );
  } catch (error) { next(error); }
}

export async function cancelTenantServiceRequestHandler(
  req: Request, res: Response, next: NextFunction,
): Promise<void> {
  try {
    const id = parseTenantServiceRequestIdParam(param(req.params.id));
    sendSuccess(
      res,
      await tenantServiceRequestService.cancelTenantServiceRequest(id, actor(req)),
    );
  } catch (error) { next(error); }
}

export async function getTenantServiceRequestActionsHandler(
  req: Request, res: Response, next: NextFunction,
): Promise<void> {
  try {
    const id = parseTenantServiceRequestIdParam(param(req.params.id));
    sendSuccess(
      res,
      await tenantServiceRequestService.resolveTenantServiceRequestAvailableActions(
        id, actor(req),
      ),
    );
  } catch (error) { next(error); }
}

export async function createServiceRequestWorkRequestHandler(
  req: Request, res: Response, next: NextFunction,
): Promise<void> {
  try {
    const id = parseTenantServiceRequestIdParam(param(req.params.id));
    sendSuccess(
      res,
      await tenantServiceRequestService.createWorkRequestForTenantServiceRequest(
        id, actor(req),
      ),
      201,
    );
  } catch (error) { next(error); }
}

export async function createServiceRequestWorkOrderHandler(
  req: Request, res: Response, next: NextFunction,
): Promise<void> {
  try {
    const id = parseTenantServiceRequestIdParam(param(req.params.id));
    const body = parseCreateServiceRequestWorkOrderBody(req.body);
    sendSuccess(
      res,
      await tenantServiceRequestService.createWorkOrderForTenantServiceRequest(
        id, body, actor(req),
      ),
      201,
    );
  } catch (error) { next(error); }
}
