import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import { parseVendorWorkIdParam } from '../vendor-work';
import { workPermitReadinessService } from './work-permit-readiness.service';
import {
  parseCreateWorkPermitReadinessBody,
  parsePermitReadinessIdParam,
  parseUpdateWorkPermitReadinessBody,
  parseWorkPermitReadinessFilters,
} from './work-permit-readiness.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

/** POST /permit-readiness */
export async function createWorkPermitReadinessHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = parseCreateWorkPermitReadinessBody(req.body);
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const readiness =
      await workPermitReadinessService.createWorkPermitReadiness(
        {
          vendorWorkId: body.vendorWorkId,
          permitRequirementType: body.permitRequirementType,
          permitReference: body.permitReference,
          permitStatus: body.permitStatus,
          validFrom: body.validFrom,
          validUntil: body.validUntil,
          notes: body.notes,
          createdByUserId: req.auth.userId,
        },
        req.auth.userId,
      );
    sendSuccess(res, readiness, 201);
  } catch (error) {
    next(error);
  }
}

/** GET /permit-readiness/:readinessId */
export async function getWorkPermitReadinessHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const readinessId = parsePermitReadinessIdParam(
      paramString(req.params.readinessId),
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    sendSuccess(
      res,
      await workPermitReadinessService.getWorkPermitReadiness(
        readinessId,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}

/** GET /permit-readiness?vendorWorkId= & vendorId= & buildingId= */
export async function listWorkPermitReadinessHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const filters = parseWorkPermitReadinessFilters(
      req.query as Record<string, unknown>,
    );

    if (filters.buildingId) {
      await contextAccessService.assertBuildingAccess(
        req.auth.userId,
        filters.buildingId,
      );
    }
    const accessibleBuildingIds =
      await contextAccessService.getAccessibleBuildingIds(req.auth.userId);

    const readiness = await workPermitReadinessService.listWorkPermitReadiness(
      filters,
      req.auth.userId,
      accessibleBuildingIds,
    );
    sendSuccess(res, readiness);
  } catch (error) {
    next(error);
  }
}

/** GET /permit-readiness/current?vendorWorkId= */
export async function resolveVendorWorkPermitReadinessHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const raw = (req.query.vendorWorkId as string | string[] | undefined) ?? '';
    const vendorWorkId = parseVendorWorkIdParam(paramString(raw));

    sendSuccess(
      res,
      await workPermitReadinessService.resolveVendorWorkPermitReadiness(
        vendorWorkId,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}

/** PATCH /permit-readiness/:readinessId */
export async function updateWorkPermitReadinessHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const readinessId = parsePermitReadinessIdParam(
      paramString(req.params.readinessId),
    );
    const body = parseUpdateWorkPermitReadinessBody(req.body);
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    sendSuccess(
      res,
      await workPermitReadinessService.updateWorkPermitReadiness(
        readinessId,
        body,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}
