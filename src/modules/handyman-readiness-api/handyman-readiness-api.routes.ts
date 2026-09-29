import { Router, type RequestHandler } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  getHandymanPermitReadinessHandler,
  getHandymanPermitReadinessHistoryHandler,
  getHandymanSchedulingReadinessHandler,
  getHandymanSchedulingReadinessHistoryHandler,
  getHandymanUnitAccessReadinessHandler,
  getHandymanUnitAccessReadinessHistoryHandler,
  postHandymanPermitReadinessHandler,
  postHandymanPermitReadinessSupersedeHandler,
  postHandymanSchedulingReadinessHandler,
  postHandymanSchedulingReadinessSupersedeHandler,
  postHandymanUnitAccessReadinessHandler,
  postHandymanUnitAccessReadinessSupersedeHandler,
} from './handyman-readiness-api.controller';

/**
 * CR-HM-05 PART 06A — Handyman readiness surface (FROZEN containment
 * F7): exactly the existing PART 01–04 public service operations,
 * nothing more (no list/search/dashboard; reads are exact/bounded).
 *
 *   POST /handyman/requests/:handymanRequestId/scheduling-readiness          manage
 *   GET  /handyman/requests/:handymanRequestId/scheduling-readiness          read
 *   GET  /handyman/requests/:handymanRequestId/scheduling-readiness/history  read
 *   POST /handyman/scheduling-readiness/:readinessId/supersede               manage
 *   POST /handyman/requests/:handymanRequestId/unit-access-readiness          manage
 *   GET  /handyman/requests/:handymanRequestId/unit-access-readiness          read
 *   GET  /handyman/requests/:handymanRequestId/unit-access-readiness/history  read
 *   POST /handyman/unit-access-readiness/:readinessId/supersede               manage
 *   POST /handyman/requests/:handymanRequestId/permit-readiness               manage
 *   GET  /handyman/requests/:handymanRequestId/permit-readiness               read
 *   GET  /handyman/requests/:handymanRequestId/permit-readiness/history       read
 *   POST /handyman/permit-readiness/:readinessId/supersede                    manage
 *
 * Permission tokens (CR-HM-04 PART 05A convention): reads incl. history
 * `tenant_company.read`; mutations (create + supersede/reschedule)
 * `tenant_company.manage`. Actor = authenticated session user;
 * Client/location/timezone/authorizer stay server-authoritative.
 * ZERO target-binding (PART 05 docs-only deferred), crew-assignment,
 * arrival-verification/QR/geofence/check-in, or FM permit/work-order
 * operations exist here (12 operations / 9 paths, no more).
 */
export function createHandymanReadinessApiRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('tenant_company.read');
  const manage = requirePermission('tenant_company.manage');

  const readinessRoutes = (
    name: 'scheduling' | 'unit-access' | 'permit',
    createHandler: RequestHandler,
    readHandler: RequestHandler,
    historyHandler: RequestHandler,
    supersedeHandler: RequestHandler,
  ) => {
    router.post(
      `/handyman/requests/:handymanRequestId/${name}-readiness`,
      auth,
      manage,
      createHandler,
    );
    router.get(
      `/handyman/requests/:handymanRequestId/${name}-readiness`,
      auth,
      read,
      readHandler,
    );
    router.get(
      `/handyman/requests/:handymanRequestId/${name}-readiness/history`,
      auth,
      read,
      historyHandler,
    );
    router.post(
      `/handyman/${name}-readiness/:readinessId/supersede`,
      auth,
      manage,
      supersedeHandler,
    );
  };

  readinessRoutes(
    'scheduling',
    postHandymanSchedulingReadinessHandler,
    getHandymanSchedulingReadinessHandler,
    getHandymanSchedulingReadinessHistoryHandler,
    postHandymanSchedulingReadinessSupersedeHandler,
  );
  readinessRoutes(
    'unit-access',
    postHandymanUnitAccessReadinessHandler,
    getHandymanUnitAccessReadinessHandler,
    getHandymanUnitAccessReadinessHistoryHandler,
    postHandymanUnitAccessReadinessSupersedeHandler,
  );
  readinessRoutes(
    'permit',
    postHandymanPermitReadinessHandler,
    getHandymanPermitReadinessHandler,
    getHandymanPermitReadinessHistoryHandler,
    postHandymanPermitReadinessSupersedeHandler,
  );

  return router;
}
