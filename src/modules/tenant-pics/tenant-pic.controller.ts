import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { tenantPicService } from './tenant-pic.service';
import {
  parseCreateTenantPicBody,
  parseTenantPicCompanyIdParam,
  parseTenantPicIdParam,
  parseUpdateTenantPicBody,
} from './tenant-pic.validation';

const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

export async function createTenantPicHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const tenantCompanyId = parseTenantPicCompanyIdParam(param(req.params.tenantCompanyId));
    const body = parseCreateTenantPicBody(req.body);
    const result = await tenantPicService.createTenantPic(
      { ...body, tenantCompanyId },
      req.auth.userId,
    );
    sendSuccess(res, result, 201);
  } catch (error) {
    next(error);
  }
}

export async function listTenantPicsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const tenantCompanyId = parseTenantPicCompanyIdParam(param(req.params.tenantCompanyId));
    sendSuccess(
      res,
      await tenantPicService.listTenantPics(tenantCompanyId, req.auth.userId),
    );
  } catch (error) {
    next(error);
  }
}

export async function getTenantPicHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const id = parseTenantPicIdParam(param(req.params.id));
    sendSuccess(res, await tenantPicService.getTenantPic(id, req.auth.userId));
  } catch (error) {
    next(error);
  }
}

export async function updateTenantPicHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const id = parseTenantPicIdParam(param(req.params.id));
    const body = parseUpdateTenantPicBody(req.body);
    sendSuccess(
      res,
      await tenantPicService.updateTenantPic(id, body, req.auth.userId),
    );
  } catch (error) {
    next(error);
  }
}
