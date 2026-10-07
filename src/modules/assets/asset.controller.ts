import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import { assetService } from './asset.service';
import {
  parseAssetBuildingIdParam,
  parseAssetIdParam,
  parseAssetStatusQuery,
  parseCreateAssetBody,
  parseUpdateAssetBody,
  parseUpdateAssetLocationBody,
  parseUpdateAssetStatusBody,
} from './asset.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

export async function createAssetHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buildingId = parseAssetBuildingIdParam(
      paramString(req.params.buildingId),
    );
    const input = parseCreateAssetBody(req.body);
    const asset = await assetService.createAsset(
      { ...input, buildingId },
      req.auth?.userId ?? null,
    );
    sendSuccess(res, asset, 201);
  } catch (error) {
    next(error);
  }
}

export async function listBuildingAssetsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buildingId = parseAssetBuildingIdParam(
      paramString(req.params.buildingId),
    );
    const status = parseAssetStatusQuery(req.query.status);
    const assets = await assetService.listAssetsByBuilding(buildingId, status);
    sendSuccess(res, assets);
  } catch (error) {
    next(error);
  }
}

/**
 * `GET /assets/:id` and `PATCH /assets/:id` carry no `buildingId` route
 * parameter, so BE-02 Building isolation is enforced here instead of via
 * `requireBuildingAccess`: the Asset is loaded first (unknown id → 404), then
 * the caller must hold an ACTIVE assignment to its Building (otherwise 403
 * BUILDING_ACCESS_DENIED). Permission alone is never enough.
 */
export async function getAssetHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseAssetIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const asset = await assetService.getAssetById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      asset.buildingId,
    );

    sendSuccess(res, asset);
  } catch (error) {
    next(error);
  }
}

export async function updateAssetHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseAssetIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const input = parseUpdateAssetBody(req.body);

    const existing = await assetService.getAssetById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      existing.buildingId,
    );

    const asset = await assetService.updateAsset(id, input, req.auth.userId);
    sendSuccess(res, asset);
  } catch (error) {
    next(error);
  }
}

/**
 * BE-05C — `PATCH /assets/:id/location`.
 *
 * A dedicated endpoint because binding returns the AUTHORITATIVE RESOLVED
 * location context (the BE-04H projection) alongside the asset, which the
 * general master-data PATCH does not. BE-02 isolation is enforced here on the
 * Asset's own Building, exactly as on the other `/assets/:id` routes.
 */
export async function updateAssetLocationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseAssetIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const input = parseUpdateAssetLocationBody(req.body);

    const existing = await assetService.getAssetById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      existing.buildingId,
    );

    const asset = await assetService.updateAssetLocation(
      id,
      input,
      req.auth.userId,
    );
    const location = await assetService.resolveAssetLocationContext(id);
    sendSuccess(res, { asset, location });
  } catch (error) {
    next(error);
  }
}

/**
 * BE-05C — `GET /assets/:id/location`: the authoritative resolved operational
 * location context of one Asset. Read-only projection over BE-04; it never
 * returns Equipment, Warranty, Certification, QR, or History data.
 */
export async function getAssetLocationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseAssetIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const asset = await assetService.getAssetById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      asset.buildingId,
    );

    const location = await assetService.resolveAssetLocationContext(id);
    sendSuccess(res, { asset, location });
  } catch (error) {
    next(error);
  }
}

/**
 * BE-05E — `GET /assets/:assetId/status`: the Asset's current lifecycle
 * state plus the backend-resolved available transitions.
 */
export async function getAssetStatusHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseAssetIdParam(paramString(req.params.assetId));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const asset = await assetService.getAssetById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      asset.buildingId,
    );

    const lifecycle = await assetService.getAssetLifecycleStatus(id);
    sendSuccess(res, lifecycle);
  } catch (error) {
    next(error);
  }
}

/**
 * BE-05E — `PATCH /assets/:assetId/status`: performs one controlled
 * lifecycle transition. Returns the updated asset together with its new
 * available actions, so the client never recreates the rules locally.
 *
 * BE-02 isolation is enforced on the Asset's own Building before any state
 * change is attempted.
 */
export async function updateAssetStatusHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseAssetIdParam(paramString(req.params.assetId));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const input = parseUpdateAssetStatusBody(req.body);

    const existing = await assetService.getAssetById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      existing.buildingId,
    );

    const asset = await assetService.updateAssetStatus(
      id,
      input,
      req.auth.userId,
    );
    const lifecycle = await assetService.getAssetLifecycleStatus(id);
    sendSuccess(res, { asset, lifecycle });
  } catch (error) {
    next(error);
  }
}
