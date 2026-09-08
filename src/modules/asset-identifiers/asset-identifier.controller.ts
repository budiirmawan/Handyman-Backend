import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { assetService } from '../assets';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import { assetIdentifierNotResolvableError } from './asset-identifier.errors';
import { assetIdentifierService } from './asset-identifier.service';
import {
  parseCreateAssetIdentifierBody,
  parseIdentifierAssetIdParam,
  parseIdentifierIdParam,
  parseIdentifierValueParam,
  parseUpdateAssetIdentifierBody,
} from './asset-identifier.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

/**
 * Identifier routes hang off `/assets/:assetId/...`, which carries no
 * `buildingId`, so BE-02 isolation is enforced here: the Asset is resolved
 * first (unknown id → 404 ASSET_NOT_FOUND), then the caller must hold an
 * ACTIVE assignment to that Asset's Building.
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

export async function createAssetIdentifierHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const assetId = parseIdentifierAssetIdParam(
      paramString(req.params.assetId),
    );
    const input = parseCreateAssetIdentifierBody(req.body);
    await requireAssetAccess(req, assetId);

    const identifier = await assetIdentifierService.createAssetIdentifier(
      { ...input, assetId },
      req.auth?.userId ?? null,
    );
    sendSuccess(res, identifier, 201);
  } catch (error) {
    next(error);
  }
}

export async function listAssetIdentifiersHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const assetId = parseIdentifierAssetIdParam(
      paramString(req.params.assetId),
    );
    await requireAssetAccess(req, assetId);

    const identifiers =
      await assetIdentifierService.listAssetIdentifiers(assetId);
    sendSuccess(res, identifiers);
  } catch (error) {
    next(error);
  }
}

/**
 * BE-05H — `GET /assets/resolve/:identifier`: the QR-ready lookup.
 *
 * Resolution is authenticated and STILL subject to BE-02 isolation: scanning
 * a label belonging to a Building the user has no assignment to yields the
 * SAME 404 as an unknown value, deliberately — a 403 would confirm that the
 * scanned code exists somewhere in the platform, letting an outsider probe
 * another Client's estate. Isolation therefore hides existence rather than
 * merely denying access.
 *
 * The payload is the safe, minimal Asset context: no credentials, no
 * security data, no unrelated Client information.
 */
export async function resolveAssetIdentifierHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const identifierValue = parseIdentifierValueParam(
      paramString(req.params.identifier),
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const resolved =
      await assetIdentifierService.resolveAssetByIdentifier(identifierValue);

    const canAccess = await contextAccessService.canAccessBuilding(
      req.auth.userId,
      resolved.asset.buildingId,
    );
    if (!canAccess) {
      throw assetIdentifierNotResolvableError();
    }

    sendSuccess(res, resolved);
  } catch (error) {
    next(error);
  }
}

export async function updateAssetIdentifierHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const assetId = parseIdentifierAssetIdParam(
      paramString(req.params.assetId),
    );
    const identifierId = parseIdentifierIdParam(
      paramString(req.params.identifierId),
    );
    const input = parseUpdateAssetIdentifierBody(req.body);
    await requireAssetAccess(req, assetId);

    const identifier = await assetIdentifierService.updateAssetIdentifier(
      assetId,
      identifierId,
      input,
      req.auth?.userId ?? null,
    );
    sendSuccess(res, identifier);
  } catch (error) {
    next(error);
  }
}
