import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createExternalWorkforceLinkHandler,
  getExternalWorkforceLinkHandler,
  listExternalOrganizationWorkforceHandler,
  listWorkforceAffiliationsHandler,
  updateExternalWorkforceLinkHandler,
} from './external-workforce.controller';

/**
 * BE-03H — External / Vendor Workforce affiliation endpoints, protected by
 * BE-01 RBAC.
 *
 * Reuses the BE-03C workforce permissions rather than introducing new codes:
 *   `workforce.read`   → GET /workforce/:workforceId/external-affiliations
 *                        GET /workforce/:workforceId/external-affiliations/:externalOrganizationId
 *                        GET /external-organizations/:externalOrganizationId/workforce
 *   `workforce.manage` → POST /workforce/:workforceId/external-affiliations
 *                        PATCH /workforce/:workforceId/external-affiliations/:externalOrganizationId
 *
 * There are no Vendor workflow endpoints here: the External Organization
 * reference (0032) is created outside BE-03H, and these routes only record
 * and read the affiliation between an EXTERNAL Workforce Profile and that
 * reference.
 *
 * Deactivation is a PATCH with `{ "status": "INACTIVE" }`, not a DELETE, so
 * the affiliation history survives.
 */
export function createExternalWorkforceRouter(): Router {
  const router = Router();

  router.post(
    '/workforce/:workforceId/external-affiliations',
    authenticationMiddleware,
    requirePermission('workforce.manage'),
    createExternalWorkforceLinkHandler,
  );
  router.get(
    '/workforce/:workforceId/external-affiliations',
    authenticationMiddleware,
    requirePermission('workforce.read'),
    listWorkforceAffiliationsHandler,
  );
  router.get(
    '/workforce/:workforceId/external-affiliations/:externalOrganizationId',
    authenticationMiddleware,
    requirePermission('workforce.read'),
    getExternalWorkforceLinkHandler,
  );
  router.get(
    '/external-organizations/:externalOrganizationId/workforce',
    authenticationMiddleware,
    requirePermission('workforce.read'),
    listExternalOrganizationWorkforceHandler,
  );
  router.patch(
    '/workforce/:workforceId/external-affiliations/:externalOrganizationId',
    authenticationMiddleware,
    requirePermission('workforce.manage'),
    updateExternalWorkforceLinkHandler,
  );

  return router;
}
