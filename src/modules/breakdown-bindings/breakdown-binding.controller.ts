import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../../shared/errors';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { breakdownBindingService } from './breakdown-binding.service';
import {
  parseAssetIdParam,
  parseBreakdownIdParam,
  parseBuildingIdParam,
  parseCloseBreakdownBody,
  parseCreateBreakdownBody,
  parseLinkWorkOrderBody,
} from './breakdown-binding.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

/** POST /assets/:assetId/breakdowns */
export async function createBreakdownHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const assetId = parseAssetIdParam(paramString(req.params.assetId));
    const body = parseCreateBreakdownBody(req.body as Record<string, unknown>);
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const breakdown = await breakdownBindingService.createBreakdown(
      {
        assetId,
        category: body.category,
        description: body.description,
        functionalLocationId: body.functionalLocationId,
        reportedAt: body.reportedAt,
        reportedByUserId: req.auth.userId,
      },
      req.auth.userId,
    );

    sendSuccess(res, breakdown, 201);
  } catch (error) {
    next(error);
  }
}

/** GET /assets/:assetId/breakdowns */
export async function listAssetBreakdownsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const assetId = parseAssetIdParam(paramString(req.params.assetId));
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    sendSuccess(
      res,
      await breakdownBindingService.listBreakdownsByAsset(assetId, req.auth.userId),
    );
  } catch (error) {
    next(error);
  }
}

/** GET /buildings/:buildingId/engineering/breakdowns */
export async function listBuildingBreakdownsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buildingId = parseBuildingIdParam(paramString(req.params.buildingId));
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    sendSuccess(
      res,
      await breakdownBindingService.listBreakdownsByBuilding(
        buildingId,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}

/** GET /engineering/breakdowns/:id */
export async function getBreakdownHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseBreakdownIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    sendSuccess(res, await breakdownBindingService.getBreakdown(id, req.auth.userId));
  } catch (error) {
    next(error);
  }
}

/** POST /engineering/breakdowns/:id/work-order */
export async function linkCorrectiveWorkOrderHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseBreakdownIdParam(paramString(req.params.id));
    const body = parseLinkWorkOrderBody(req.body as Record<string, unknown>);
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const breakdown = await breakdownBindingService.linkCorrectiveWorkOrder(
      id,
      body,
      req.auth.userId,
    );
    sendSuccess(res, breakdown, 201);
  } catch (error) {
    next(error);
  }
}

/** PATCH /engineering/breakdowns/:id */
export async function closeBreakdownHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseBreakdownIdParam(paramString(req.params.id));
    const body = parseCloseBreakdownBody(req.body as Record<string, unknown>);
    if (body.status !== 'CLOSED') {
      return next(
        AppError.validation('Request validation failed.', [
          { field: 'status', message: 'Only CLOSED is a valid breakdown transition.' },
        ]),
      );
    }
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    sendSuccess(
      res,
      await breakdownBindingService.closeBreakdown(id, req.auth.userId),
    );
  } catch (error) {
    next(error);
  }
}
