import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { assetService } from '../assets';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import { assetCertificationService } from './asset-certification.service';
import {
  parseCertificationAssetIdParam,
  parseCertificationIdParam,
  parseCertificationStatusQuery,
  parseCertificationTypeQuery,
  parseCreateAssetCertificationBody,
  parseUpdateAssetCertificationBody,
} from './asset-certification.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

/**
 * Every certification route hangs off `/assets/:assetId/...`, which carries
 * no `buildingId`, so BE-02 isolation is enforced here: the Asset is
 * resolved first (unknown id → 404 ASSET_NOT_FOUND), then the caller must
 * hold an ACTIVE assignment to that Asset's Building. Client / Building
 * context is always taken from the stored Asset, never from the request.
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

export async function createAssetCertificationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const assetId = parseCertificationAssetIdParam(
      paramString(req.params.assetId),
    );
    const input = parseCreateAssetCertificationBody(req.body);
    await requireAssetAccess(req, assetId);

    const certification =
      await assetCertificationService.createAssetCertification(
        { ...input, assetId },
        req.auth?.userId ?? null,
      );
    sendSuccess(res, certification, 201);
  } catch (error) {
    next(error);
  }
}

/** Certification history of one Asset (`?status=` and `?type=` filters). */
export async function listAssetCertificationsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const assetId = parseCertificationAssetIdParam(
      paramString(req.params.assetId),
    );
    const status = parseCertificationStatusQuery(req.query.status);
    const certificationType = parseCertificationTypeQuery(req.query.type);
    await requireAssetAccess(req, assetId);

    const certifications =
      await assetCertificationService.listAssetCertifications(assetId, {
        ...(status === undefined ? {} : { status }),
        ...(certificationType === undefined ? {} : { certificationType }),
      });
    sendSuccess(res, certifications);
  } catch (error) {
    next(error);
  }
}

/** The Asset's currently effective certifications (one per type at most). */
export async function listCurrentAssetCertificationsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const assetId = parseCertificationAssetIdParam(
      paramString(req.params.assetId),
    );
    await requireAssetAccess(req, assetId);

    const certifications =
      await assetCertificationService.listCurrentAssetCertifications(assetId);
    sendSuccess(res, certifications);
  } catch (error) {
    next(error);
  }
}

export async function updateAssetCertificationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const assetId = parseCertificationAssetIdParam(
      paramString(req.params.assetId),
    );
    const certificationId = parseCertificationIdParam(
      paramString(req.params.certificationId),
    );
    const input = parseUpdateAssetCertificationBody(req.body);
    await requireAssetAccess(req, assetId);

    const certification =
      await assetCertificationService.updateAssetCertification(
        assetId,
        certificationId,
        input,
        req.auth?.userId ?? null,
      );
    sendSuccess(res, certification);
  } catch (error) {
    next(error);
  }
}
