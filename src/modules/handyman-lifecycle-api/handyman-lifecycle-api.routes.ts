import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requireAnyPermission, requirePermission } from '../auth/rbac.middleware';
import {
  getHandymanDiagnosisHandler,
  getHandymanInspectionHandler,
  getHandymanReferralHandler,
  getHandymanTriageHandler,
  postHandymanDiagnosisHandler,
  postHandymanInspectionHandler,
  postHandymanReferralHandler,
  postHandymanTriageHandler,
} from './handyman-lifecycle-api.controller';

/**
 * CR-HM-03 PART 05A — Handyman lifecycle surface (FROZEN F8).
 *
 *   POST /handyman/requests/:handymanRequestId/triage     handyman.operations.request.triage (W02 PART 04A)
 *   GET  /handyman/requests/:handymanRequestId/triage     tenant_company.read | handyman.operations.request.read
 *   POST /handyman/requests/:handymanRequestId/inspection manage
 *   GET  /handyman/requests/:handymanRequestId/inspection read
 *   POST /handyman/requests/:handymanRequestId/diagnosis  manage
 *   GET  /handyman/requests/:handymanRequestId/diagnosis  read
 *   POST /handyman/requests/:handymanRequestId/referral   manage
 *   GET  /handyman/requests/:handymanRequestId/referral   read
 *
 * Permission token derivation (FROZEN F8 — closest EXISTING Handyman
 * read/manage convention): the only existing Handyman-gated surface is
 * the CR-HM-02 customer intake surface, which gates reads with
 * `tenant_company.read` and writes with `tenant_company.manage`; the same
 * tokens gate this surface, and the PART 01–04 services remain the sole
 * authority for state transitions, client/scope validation, discipline /
 * classification derivation and referral eligibility (the accessible-
 * Client scope can never be smuggled through a session).
 *
 * Out of scope by frozen contract: intake, evidence upload, quotation,
 * work execution, provider/vendor assignment, FM workflow — none of
 * those routes exist here (8 operations, no more).
 */
export function createHandymanLifecycleApiRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('tenant_company.read');
  const manage = requirePermission('tenant_company.manage');
  // W02 PART 04A — triage has its own Operations authority, not tenant_company.manage.
  // Its READ keeps the existing tenant_company.read admission and admits the
  // Operations queue read permission. Both paths apply the same Building scope
  // inside the service (assertBuildingScopedResourceAccess).
  const triageWrite = requirePermission('handyman.operations.request.triage');
  const triageRead = requireAnyPermission([
    'tenant_company.read',
    'handyman.operations.request.read',
  ]);

  router.post(
    '/handyman/requests/:handymanRequestId/triage',
    auth,
    triageWrite,
    postHandymanTriageHandler,
  );
  router.get(
    '/handyman/requests/:handymanRequestId/triage',
    auth,
    triageRead,
    getHandymanTriageHandler,
  );
  router.post(
    '/handyman/requests/:handymanRequestId/inspection',
    auth,
    manage,
    postHandymanInspectionHandler,
  );
  router.get(
    '/handyman/requests/:handymanRequestId/inspection',
    auth,
    read,
    getHandymanInspectionHandler,
  );
  router.post(
    '/handyman/requests/:handymanRequestId/diagnosis',
    auth,
    manage,
    postHandymanDiagnosisHandler,
  );
  router.get(
    '/handyman/requests/:handymanRequestId/diagnosis',
    auth,
    read,
    getHandymanDiagnosisHandler,
  );
  router.post(
    '/handyman/requests/:handymanRequestId/referral',
    auth,
    manage,
    postHandymanReferralHandler,
  );
  router.get(
    '/handyman/requests/:handymanRequestId/referral',
    auth,
    read,
    getHandymanReferralHandler,
  );

  return router;
}
