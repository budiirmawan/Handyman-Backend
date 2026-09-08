import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { tenantSpaceService } from './tenant-space.service';
import {
  parseAssignTenantSpaceBody,
  parseTenantSpaceBuildingIdParam,
  parseTenantSpaceCompanyIdParam,
  parseTenantSpaceRelationshipIdParam,
  parseUpdateTenantSpaceBody,
} from './tenant-space.validation';

const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

export async function assignTenantSpaceHandler(
  req: Request, res: Response, next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const tenantCompanyId = parseTenantSpaceCompanyIdParam(param(req.params.tenantCompanyId));
    const body = parseAssignTenantSpaceBody(req.body);
    sendSuccess(
      res,
      await tenantSpaceService.assignSpaceToTenant(
        { ...body, tenantCompanyId },
        req.auth.userId,
      ),
      201,
    );
  } catch (error) { next(error); }
}

export async function getTenantSpaceHandler(
  req: Request, res: Response, next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const id = parseTenantSpaceRelationshipIdParam(param(req.params.id));
    sendSuccess(res, await tenantSpaceService.getTenantSpaceRelationship(id, req.auth.userId));
  } catch (error) { next(error); }
}

export async function listTenantSpacesHandler(
  req: Request, res: Response, next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const tenantCompanyId = parseTenantSpaceCompanyIdParam(param(req.params.tenantCompanyId));
    sendSuccess(
      res,
      await tenantSpaceService.listTenantSpaceRelationships(
        tenantCompanyId,
        req.auth.userId,
      ),
    );
  } catch (error) { next(error); }
}

export async function listBuildingTenantSpacesHandler(
  req: Request, res: Response, next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const buildingId = parseTenantSpaceBuildingIdParam(param(req.params.buildingId));
    sendSuccess(
      res,
      await tenantSpaceService.listBuildingTenantSpaces(buildingId, req.auth.userId),
    );
  } catch (error) { next(error); }
}

export async function updateTenantSpaceHandler(
  req: Request, res: Response, next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const id = parseTenantSpaceRelationshipIdParam(param(req.params.id));
    const body = parseUpdateTenantSpaceBody(req.body);
    sendSuccess(
      res,
      await tenantSpaceService.updateTenantSpaceRelationship(
        id,
        body,
        req.auth.userId,
      ),
    );
  } catch (error) { next(error); }
}
