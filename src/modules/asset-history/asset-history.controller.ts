import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { assetService } from '../assets';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import { assetHistoryService } from './asset-history.service';
import {
  parseAssetHistoryQuery,
  parseHistoryAssetIdParam,
} from './asset-history.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

/**
 * BE-05I — `GET /assets/:assetId/history`: read-only Asset timeline.
 *
 * The route carries no `buildingId`, so BE-02 isolation is enforced here:
 * the Asset is resolved first (unknown id → 404 ASSET_NOT_FOUND), then the
 * caller must hold an ACTIVE assignment to that Asset's Building.
 *
 * Read-only by design — no create, update, or delete endpoint exists for
 * history. Events are appended by the domain services themselves.
 */
export async function listAssetHistoryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const assetId = parseHistoryAssetIdParam(paramString(req.params.assetId));
    const filters = parseAssetHistoryQuery(
      req.query as Record<string, unknown>,
    );

    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const asset = await assetService.getAssetById(assetId);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      asset.buildingId,
    );

    const result = await assetHistoryService.listAssetHistory(
      assetId,
      filters,
    );

    sendSuccess(res, result.events, 200, {
      total: result.total,
      limit: result.limit,
      offset: result.offset,
    });
  } catch (error) {
    next(error);
  }
}
