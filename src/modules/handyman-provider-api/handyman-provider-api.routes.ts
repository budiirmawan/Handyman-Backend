import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  getHandymanProviderContextByVendorHandler,
  getHandymanWorkerContextHandler,
  getHandymanWorkCrewHandler,
  postHandymanCrewLeadHandler,
  postHandymanCrewMemberHandler,
  postHandymanCrewMembershipStatusHandler,
  postHandymanProviderContextHandler,
  postHandymanProviderContextStatusHandler,
  postHandymanWorkerContextHandler,
  postHandymanWorkerContextStatusHandler,
  postHandymanWorkCrewHandler,
  postHandymanWorkCrewStatusHandler,
} from './handyman-provider-api.controller';

/**
 * CR-HM-04 PART 05A — Handyman provider / worker / crew surface
 * (FROZEN F9): exactly the existing PART 01–03 public service operations,
 * nothing more.
 *
 *   POST /handyman/provider-contexts                              manage
 *   GET  /handyman/provider-contexts/by-vendor/:vendorId          read
 *   POST /handyman/provider-contexts/:providerContextId/status    manage
 *   POST /handyman/worker-contexts                                manage
 *   GET  /handyman/worker-contexts/:workerContextId               read
 *   POST /handyman/worker-contexts/:workerContextId/status        manage
 *   POST /handyman/work-crews                                     manage
 *   GET  /handyman/work-crews/:crewId                             read
 *   POST /handyman/work-crews/:crewId/status                      manage
 *   POST /handyman/work-crews/:crewId/members                     manage
 *   POST /handyman/work-crews/:crewId/lead                        manage
 *   POST /handyman/crew-memberships/:membershipId/status          manage
 *
 * Permission tokens (FROZEN F9 — closest EXISTING Handyman read/manage
 * convention): the same tokens that gate the CR-HM-02 intake and
 * CR-HM-03 lifecycle surfaces — reads `tenant_company.read`, mutations
 * `tenant_company.manage`. The actor is the authenticated session user
 * (`req.auth.userId`); Client scope is server-derived from the referenced
 * authority rows. NO assignment route exists: PART 04 freezes provider-
 * authored crew assignment as contract-only, deferred until the owning
 * CR creates an authoritative assignable target (CR-HM-06 scope), so no
 * assignment endpoint is exposed (12 operations, no more).
 */
export function createHandymanProviderApiRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('tenant_company.read');
  const manage = requirePermission('tenant_company.manage');

  router.post(
    '/handyman/provider-contexts',
    auth,
    manage,
    postHandymanProviderContextHandler,
  );
  router.get(
    '/handyman/provider-contexts/by-vendor/:vendorId',
    auth,
    read,
    getHandymanProviderContextByVendorHandler,
  );
  router.post(
    '/handyman/provider-contexts/:providerContextId/status',
    auth,
    manage,
    postHandymanProviderContextStatusHandler,
  );

  router.post(
    '/handyman/worker-contexts',
    auth,
    manage,
    postHandymanWorkerContextHandler,
  );
  router.get(
    '/handyman/worker-contexts/:workerContextId',
    auth,
    read,
    getHandymanWorkerContextHandler,
  );
  router.post(
    '/handyman/worker-contexts/:workerContextId/status',
    auth,
    manage,
    postHandymanWorkerContextStatusHandler,
  );

  router.post(
    '/handyman/work-crews',
    auth,
    manage,
    postHandymanWorkCrewHandler,
  );
  router.get(
    '/handyman/work-crews/:crewId',
    auth,
    read,
    getHandymanWorkCrewHandler,
  );
  router.post(
    '/handyman/work-crews/:crewId/status',
    auth,
    manage,
    postHandymanWorkCrewStatusHandler,
  );
  router.post(
    '/handyman/work-crews/:crewId/members',
    auth,
    manage,
    postHandymanCrewMemberHandler,
  );
  router.post(
    '/handyman/work-crews/:crewId/lead',
    auth,
    manage,
    postHandymanCrewLeadHandler,
  );
  router.post(
    '/handyman/crew-memberships/:membershipId/status',
    auth,
    manage,
    postHandymanCrewMembershipStatusHandler,
  );

  return router;
}
