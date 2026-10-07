import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import { vendorBastService } from './vendor-bast-binding.service';
import {
  parseBastDecisionBody,
  parseBastFilters,
  parseBastIdParam,
  parseSubmitBastBody,
} from './vendor-bast-binding.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

/** POST /vendor-basts */
export async function createBastHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    // The old body cannot express a canonical shared Document/Version. The
    // service returns a stable deprecation conflict without mutating state.
    await vendorBastService.createBast();
  } catch (error) {
    next(error);
  }
}

/** GET /vendor-basts/:bastId */
export async function getBastHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const bastId = parseBastIdParam(paramString(req.params.bastId));
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    sendSuccess(
      res,
      await vendorBastService.getBast(bastId, req.auth.userId),
    );
  } catch (error) {
    next(error);
  }
}

/** GET /vendor-basts?vendorWorkId= & vendorId= & buildingId= */
export async function listBastsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const filters = parseBastFilters(req.query as Record<string, unknown>);

    if (filters.buildingId) {
      await contextAccessService.assertBuildingAccess(
        req.auth.userId,
        filters.buildingId,
      );
    }
    const accessibleBuildingIds =
      await contextAccessService.getAccessibleBuildingIds(req.auth.userId);

    const basts = await vendorBastService.listBasts(
      filters,
      req.auth.userId,
      accessibleBuildingIds,
    );
    sendSuccess(res, basts);
  } catch (error) {
    next(error);
  }
}

/** POST /vendor-basts/:bastId/submit */
export async function submitBastHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const bastId = parseBastIdParam(paramString(req.params.bastId));
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const { documentVersionId } = parseSubmitBastBody(req.body);
    sendSuccess(
      res,
      await vendorBastService.submitBast(
        bastId,
        req.auth.userId,
        documentVersionId,
      ),
    );
  } catch (error) {
    next(error);
  }
}

/** POST /vendor-basts/:bastId/accept */
export async function acceptBastHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const bastId = parseBastIdParam(paramString(req.params.bastId));
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const { notes } = parseBastDecisionBody(req.body);
    sendSuccess(
      res,
      await vendorBastService.acceptBast(bastId, req.auth.userId, notes),
    );
  } catch (error) {
    next(error);
  }
}

/** POST /vendor-basts/:bastId/reject */
export async function rejectBastHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const bastId = parseBastIdParam(paramString(req.params.bastId));
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const { notes } = parseBastDecisionBody(req.body);
    sendSuccess(
      res,
      await vendorBastService.rejectBast(bastId, req.auth.userId, notes),
    );
  } catch (error) {
    next(error);
  }
}
