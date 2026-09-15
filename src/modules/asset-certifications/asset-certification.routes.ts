import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createAssetCertificationHandler,
  listAssetCertificationsHandler,
  listCurrentAssetCertificationsHandler,
  updateAssetCertificationHandler,
} from './asset-certification.controller';

/**
 * BE-05G — Asset Certification endpoints, protected by BE-01 RBAC and BE-02
 * Building isolation.
 *
 * Reads (`asset_certification.read`):
 *   GET   /assets/:assetId/certifications          (history; ?status= ?type=)
 *   GET   /assets/:assetId/certifications/current  (effective today)
 * Management (`asset_certification.manage`):
 *   POST  /assets/:assetId/certifications
 *   PATCH /assets/:assetId/certifications/:certificationId
 *
 * `/current` is declared BEFORE `/:certificationId` so the literal segment
 * is never swallowed by the UUID parameter route.
 *
 * Dedicated permissions because statutory / compliance certification is a
 * distinct capability from asset administration, engineering data, and
 * commercial warranty coverage.
 *
 * Status changes travel through the general PATCH (which accepts `status`).
 * No inspection execution, renewal workflow, or document repository endpoint
 * is exposed.
 */
export function createAssetCertificationRouter(): Router {
  const router = Router();

  router.post(
    '/assets/:assetId/certifications',
    authenticationMiddleware,
    requirePermission('asset_certification.manage'),
    createAssetCertificationHandler,
  );
  router.get(
    '/assets/:assetId/certifications',
    authenticationMiddleware,
    requirePermission('asset_certification.read'),
    listAssetCertificationsHandler,
  );
  router.get(
    '/assets/:assetId/certifications/current',
    authenticationMiddleware,
    requirePermission('asset_certification.read'),
    listCurrentAssetCertificationsHandler,
  );
  router.patch(
    '/assets/:assetId/certifications/:certificationId',
    authenticationMiddleware,
    requirePermission('asset_certification.manage'),
    updateAssetCertificationHandler,
  );

  return router;
}
