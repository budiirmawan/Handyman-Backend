import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import {
  assetOperationalStateService,
} from './asset-operational-state.service';
import {
  parseOperationalStateAssetIdParam,
  parseReturnToServiceBody,
  parseTransitionOperationalStateBody,
} from './asset-operational-state.validation';

const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

/**
 * CR-BE-RN10-SAFE-EQUIPMENT-01 PART 02 — operational-state handlers.
 *
 * Neither route carries a `buildingId` path parameter, so BE-02G Building
 * isolation is enforced HERE after the Asset's Building is resolved — the same
 * posture the `/assets/:id` and `/assets/:assetId/status` routes take, rather
 * than `requireBuildingAccess`. Holding the permission is therefore never
 * sufficient to reach another Building.
 *
 * Order matters and is pinned by tests: unknown Asset → 404 first, then the
 * caller's Building access → 403. Nothing about the Asset is disclosed before
 * access is asserted.
 */
export async function getAssetOperationalStateHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();

    const assetId = parseOperationalStateAssetIdParam(
      param(req.params.assetId),
    );
    const buildingId =
      await assetOperationalStateService.resolveOperationalStateBuildingId(
        assetId,
      );
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      buildingId,
    );

    sendSuccess(
      res,
      await assetOperationalStateService.getAssetOperationalState(assetId),
    );
  } catch (error) {
    next(error);
  }
}

export async function transitionAssetOperationalStateHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();

    const assetId = parseOperationalStateAssetIdParam(
      param(req.params.assetId),
    );
    const input = parseTransitionOperationalStateBody(req.body);

    const buildingId =
      await assetOperationalStateService.resolveOperationalStateBuildingId(
        assetId,
      );
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      buildingId,
    );

    sendSuccess(
      res,
      await assetOperationalStateService.transitionAssetOperationalState(
        assetId,
        input,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}

/**
 * PART 03 — the governed return-to-service handler.
 *
 * Same Building-isolation posture as the two PART-02 handlers, in the same
 * order (404 for an unknown Asset BEFORE the caller's access is asserted, so
 * nothing about the Asset is disclosed to a caller who cannot reach it). The
 * actor is the session user and is passed to the service, where it becomes the
 * authorizing reviewer recorded in the audit entry — the request body can never
 * name an approver.
 */
export async function returnAssetToServiceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();

    const assetId = parseOperationalStateAssetIdParam(
      param(req.params.assetId),
    );
    const input = parseReturnToServiceBody(req.body);

    const buildingId =
      await assetOperationalStateService.resolveOperationalStateBuildingId(
        assetId,
      );
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      buildingId,
    );

    sendSuccess(
      res,
      await assetOperationalStateService.returnAssetToService(
        assetId,
        input,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}
