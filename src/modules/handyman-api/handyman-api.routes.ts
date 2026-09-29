import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createHandymanServiceRequestHandler,
  describeHandymanMaterialProfileHandler,
  listHandymanCatalogueServicesHandler,
  listHandymanIntakeEvidenceHandler,
  listHandymanMaterialProfilesHandler,
  uploadHandymanIntakeEvidenceHandler,
} from './handyman-api.controller';

/**
 * CR-HM-02 PART 05A — customer-facing Handyman surface
 * (frozen CR-HM-02 governance, D1–D4).
 *
 *   GET  /handyman/catalogue/services                          read-only catalogue
 *   GET  /handyman/catalogue/material-profiles                 read-only catalogue
 *   GET  /handyman/catalogue/material-profiles/:profileId      profile + composed reference price
 *   POST /handyman/requests                                    attribution-bound intake
 *   GET  /handyman/requests/:handymanRequestId/intake-evidence bounded list
 *   POST /handyman/requests/:handymanRequestId/intake-evidence bounded PHOTO/VIDEO upload
 *
 * Bearer-session convention: the nearest customer-facing intake sibling
 * (`tenant-service-requests` — a Tenant PIC's own intake surface) gates
 * reads with `tenant_company.read` and writes with `tenant_company.manage`;
 * the same customer-side permissions gate this surface, and the PART 01–04
 * services additionally enforce the accessible-Client scope server-side
 * (cross-Client authority can never be smuggled through a session).
 *
 * Out of scope by frozen contract: catalogue/master mutation, request
 * lifecycle transitions (triage / diagnosis / quotation / work execution),
 * inventory mutation, catalogue media, QC/BAST, FM workflow, SaaS/financial
 * entitlement — none of those routes exist here.
 */
export function createHandymanApiRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('tenant_company.read');
  const manage = requirePermission('tenant_company.manage');

  router.get(
    '/handyman/catalogue/services',
    auth,
    read,
    listHandymanCatalogueServicesHandler,
  );
  router.get(
    '/handyman/catalogue/material-profiles',
    auth,
    read,
    listHandymanMaterialProfilesHandler,
  );
  router.get(
    '/handyman/catalogue/material-profiles/:profileId',
    auth,
    read,
    describeHandymanMaterialProfileHandler,
  );
  router.post(
    '/handyman/requests',
    auth,
    manage,
    createHandymanServiceRequestHandler,
  );
  router.get(
    '/handyman/requests/:handymanRequestId/intake-evidence',
    auth,
    read,
    listHandymanIntakeEvidenceHandler,
  );
  router.post(
    '/handyman/requests/:handymanRequestId/intake-evidence',
    auth,
    manage,
    uploadHandymanIntakeEvidenceHandler,
  );

  return router;
}
