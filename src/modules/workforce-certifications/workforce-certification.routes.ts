import { Router } from 'express';

import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { workforceCertificationController } from './workforce-certification.controller';

/**
 * CR-HM-WORKER-COMPETENCY-01 PART 02 — Workforce Certification routes.
 *
 * All routes require authentication (`authenticationMiddleware`), RBAC
 * permission checks (`requirePermission`), and Client isolation (enforced
 * inside `workforceCertificationService` via `contextAccessService.canAccessClient`
 * / `getAccessibleClientIds`).
 *
 * Permissions:
 *   `skill.read`   → GET    /workforce/certifications/expiring
 *                    GET    /workforce/:workforceId/certifications
 *                    GET    /workforce/:workforceId/certifications/:certificationId
 *   `skill.manage` → POST   /workforce/:workforceId/certifications
 *                    PATCH  /workforce/:workforceId/certifications/:certificationId
 *                    POST   /workforce/:workforceId/certifications/:certificationId/verify
 *                    POST   /workforce/:workforceId/certifications/:certificationId/deactivate
 */
export function createWorkforceCertificationRouter(): Router {
  const router = Router();

  router.get(
    '/workforce/certifications/expiring',
    authenticationMiddleware,
    requirePermission('skill.read'),
    workforceCertificationController.listExpiringWorkforceCertifications,
  );

  router.get(
    '/workforce/:workforceId/certifications',
    authenticationMiddleware,
    requirePermission('skill.read'),
    workforceCertificationController.listWorkforceCertifications,
  );

  router.get(
    '/workforce/:workforceId/certifications/:certificationId',
    authenticationMiddleware,
    requirePermission('skill.read'),
    workforceCertificationController.getWorkforceCertification,
  );

  router.post(
    '/workforce/:workforceId/certifications',
    authenticationMiddleware,
    requirePermission('skill.manage'),
    workforceCertificationController.createWorkforceCertification,
  );

  router.patch(
    '/workforce/:workforceId/certifications/:certificationId',
    authenticationMiddleware,
    requirePermission('skill.manage'),
    workforceCertificationController.updateWorkforceCertification,
  );

  router.post(
    '/workforce/:workforceId/certifications/:certificationId/verify',
    authenticationMiddleware,
    requirePermission('skill.manage'),
    workforceCertificationController.verifyWorkforceCertification,
  );

  router.post(
    '/workforce/:workforceId/certifications/:certificationId/deactivate',
    authenticationMiddleware,
    requirePermission('skill.manage'),
    workforceCertificationController.deactivateWorkforceCertification,
  );

  return router;
}
