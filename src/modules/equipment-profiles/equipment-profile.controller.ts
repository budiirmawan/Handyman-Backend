import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { assetService } from '../assets';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import { equipmentProfileService } from './equipment-profile.service';
import {
  parseCreateEquipmentProfileBody,
  parseEquipmentProfileAssetIdParam,
  parseUpdateEquipmentProfileBody,
} from './equipment-profile.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

/**
 * Every Equipment Profile route hangs off `/assets/:assetId/...`, which
 * carries no `buildingId`, so BE-02 isolation is enforced here: the Asset is
 * resolved first (unknown id → 404 ASSET_NOT_FOUND), then the caller must
 * hold an ACTIVE assignment to that Asset's Building. Permission alone is
 * never enough, and Client / Building context is always taken from the
 * stored Asset — never from the request body.
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

export async function createEquipmentProfileHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const assetId = parseEquipmentProfileAssetIdParam(
      paramString(req.params.assetId),
    );
    const input = parseCreateEquipmentProfileBody(req.body);
    await requireAssetAccess(req, assetId);

    const profile = await equipmentProfileService.createEquipmentProfile(
      { ...input, assetId },
      req.auth?.userId ?? null,
    );
    sendSuccess(res, profile, 201);
  } catch (error) {
    next(error);
  }
}

export async function getEquipmentProfileHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const assetId = parseEquipmentProfileAssetIdParam(
      paramString(req.params.assetId),
    );
    await requireAssetAccess(req, assetId);

    const profile =
      await equipmentProfileService.getEquipmentProfileByAssetId(assetId);
    sendSuccess(res, profile);
  } catch (error) {
    next(error);
  }
}

export async function updateEquipmentProfileHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const assetId = parseEquipmentProfileAssetIdParam(
      paramString(req.params.assetId),
    );
    const input = parseUpdateEquipmentProfileBody(req.body);
    await requireAssetAccess(req, assetId);

    const profile = await equipmentProfileService.updateEquipmentProfile(
      assetId,
      input,
      req.auth?.userId ?? null,
    );
    sendSuccess(res, profile);
  } catch (error) {
    next(error);
  }
}
