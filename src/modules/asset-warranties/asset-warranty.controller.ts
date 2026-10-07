import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { assetService } from '../assets';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import { assetWarrantyService } from './asset-warranty.service';
import {
  parseCreateAssetWarrantyBody,
  parseUpdateAssetWarrantyBody,
  parseWarrantyAssetIdParam,
  parseWarrantyIdParam,
  parseWarrantyStatusQuery,
} from './asset-warranty.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

/**
 * Every warranty route hangs off `/assets/:assetId/...`, which carries no
 * `buildingId`, so BE-02 isolation is enforced here: the Asset is resolved
 * first (unknown id → 404 ASSET_NOT_FOUND), then the caller must hold an
 * ACTIVE assignment to that Asset's Building. Client / Building context is
 * always taken from the stored Asset, never from the request body.
 */
async function requireAssetAccess(
  req: Request,
  assetId: string,
): Promise<void> {
  if (!req.auth) {
    throw authenticationRequiredError();
  }

  const asset = await assetService.getAssetById(assetId);
  await contextAccessService.assertBuildingAccess(
    req.auth.userId,
    asset.buildingId,
  );
}

export async function createAssetWarrantyHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const assetId = parseWarrantyAssetIdParam(paramString(req.params.assetId));
    const input = parseCreateAssetWarrantyBody(req.body);
    await requireAssetAccess(req, assetId);

    const warranty = await assetWarrantyService.createAssetWarranty(
      { ...input, assetId },
      req.auth?.userId ?? null,
    );
    sendSuccess(res, warranty, 201);
  } catch (error) {
    next(error);
  }
}

/** Warranty history of one Asset (`?status=` filter). */
export async function listAssetWarrantiesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const assetId = parseWarrantyAssetIdParam(paramString(req.params.assetId));
    const status = parseWarrantyStatusQuery(req.query.status);
    await requireAssetAccess(req, assetId);

    const warranties = await assetWarrantyService.listAssetWarranties(
      assetId,
      status,
    );
    sendSuccess(res, warranties);
  } catch (error) {
    next(error);
  }
}

/** The Asset's current (ACTIVE) coverage. */
export async function getCurrentAssetWarrantyHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const assetId = parseWarrantyAssetIdParam(paramString(req.params.assetId));
    await requireAssetAccess(req, assetId);

    const warranty =
      await assetWarrantyService.getCurrentAssetWarranty(assetId);
    sendSuccess(res, warranty);
  } catch (error) {
    next(error);
  }
}

export async function updateAssetWarrantyHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const assetId = parseWarrantyAssetIdParam(paramString(req.params.assetId));
    const warrantyId = parseWarrantyIdParam(paramString(req.params.warrantyId));
    const input = parseUpdateAssetWarrantyBody(req.body);
    await requireAssetAccess(req, assetId);

    const warranty = await assetWarrantyService.updateAssetWarranty(
      assetId,
      warrantyId,
      input,
      req.auth?.userId ?? null,
    );
    sendSuccess(res, warranty);
  } catch (error) {
    next(error);
  }
}
