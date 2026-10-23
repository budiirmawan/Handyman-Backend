import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createWorkforceCertificationHandler,
  deactivateWorkforceCertificationHandler,
  getWorkforceCertificationHandler,
  listExpiringWorkforceCertificationsHandler,
  listWorkforceCertificationsHandler,
  updateWorkforceCertificationHandler,
  verifyWorkforceCertificationHandler,
} from './workforce-certification.controller';
import { WORKFORCE_CERTIFICATION_PERMISSIONS } from './workforce-certification.types';

/**
 * CR-HM-WORKER-COMPETENCY-01 PART 02 — Individual Worker Certification HTTP
 * surface.
 *
 * Authority (`workforce_certification.*`, migration 0462) is deliberately its
 * own namespace instead of reusing `skill.*` / `workforce.*` /
 * `tenant_company.*`:
 *
 *   read    (`workforce_certification.read`)
 *     GET  /workforce/certifications/expiring
 *     GET  /workforce/:workforceId/certifications
 *     GET  /workforce/:workforceId/certifications/:certificationId
 *
 *   manage  (`workforce_certification.manage`)
 *     POST   /workforce/:workforceId/certifications
 *     PATCH  /workforce/:workforceId/certifications/:certificationId
 *     POST   /workforce/:workforceId/certifications/:certificationId/deactivate
 *
 *   verify  (`workforce_certification.verify` — never granted by default)
 *     POST   /workforce/:workforceId/certifications/:certificationId/verify
 *
 * RBAC here is a necessary condition only. The service independently proves
 * (a) access to the workforce profile's Client, (b) the self-read / Crew Lead
 * read rules, and (c) that a verifier is never the certificate's own owner.
 * Deactivation is a lifecycle command (the row survives), never a DELETE.
 */
export function createWorkforceCertificationRouter(): Router {
  const router = Router();

  const read = requirePermission(WORKFORCE_CERTIFICATION_PERMISSIONS.read);
  const manage = requirePermission(WORKFORCE_CERTIFICATION_PERMISSIONS.manage);
  const verify = requirePermission(WORKFORCE_CERTIFICATION_PERMISSIONS.verify);

  // Literal segment first: `/workforce/certifications/expiring` can never be
  // captured as a `:workforceId` route.
  router.get(
    '/workforce/certifications/expiring',
    authenticationMiddleware,
    read,
    listExpiringWorkforceCertificationsHandler,
  );

  router.get(
    '/workforce/:workforceId/certifications',
    authenticationMiddleware,
    read,
    listWorkforceCertificationsHandler,
  );

  router.post(
    '/workforce/:workforceId/certifications',
    authenticationMiddleware,
    manage,
    createWorkforceCertificationHandler,
  );

  router.get(
    '/workforce/:workforceId/certifications/:certificationId',
    authenticationMiddleware,
    read,
    getWorkforceCertificationHandler,
  );

  router.patch(
    '/workforce/:workforceId/certifications/:certificationId',
    authenticationMiddleware,
    manage,
    updateWorkforceCertificationHandler,
  );

  router.post(
    '/workforce/:workforceId/certifications/:certificationId/verify',
    authenticationMiddleware,
    verify,
    verifyWorkforceCertificationHandler,
  );

  router.post(
    '/workforce/:workforceId/certifications/:certificationId/deactivate',
    authenticationMiddleware,
    manage,
    deactivateWorkforceCertificationHandler,
  );

  return router;
}
