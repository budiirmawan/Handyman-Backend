import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createHandymanServiceRequestHandler,
  createCareHandymanServiceRequestHandler,
  describeHandymanMaterialProfileHandler,
  getHandymanServiceRequestDetailHandler,
  listHandymanCatalogueServicesHandler,
  listHandymanIntakeEvidenceHandler,
  listHandymanMaterialProfilesHandler,
  listHandymanServiceRequestsHandler,
  uploadHandymanIntakeEvidenceHandler,
} from './handyman-api.controller';

/**
 * CR-HM-02 PART 05A + CR-HM-17 GAP PART 01 — customer-facing & Customer Care
 * Handyman surface (frozen CR-HM-02 governance, D1–D4; CR-HM-17 GAP PART 01
 * B3 request reads).
 *
 *   GET  /handyman/catalogue/services                          read-only catalogue
 *   GET  /handyman/catalogue/material-profiles                 read-only catalogue
 *   GET  /handyman/catalogue/material-profiles/:profileId      profile + composed reference price
 *   POST /handyman/requests                                    local-User attribution-bound intake
 *   POST /handyman/requests/care                               care exchange-bound intake
 *   GET  /handyman/requests                                    bounded Customer Care request list
 *   GET  /handyman/requests/:handymanRequestId                 bounded Customer Care request detail
 *   GET  /handyman/requests/:handymanRequestId/intake-evidence bounded list
 *   POST /handyman/requests/:handymanRequestId/intake-evidence bounded PHOTO/VIDEO upload
 *
 * Bearer-session convention: the nearest customer-facing intake sibling
 * (`tenant-service-requests` — a Tenant PIC's own intake surface) gates
 * reads with `tenant_company.read` and writes with `tenant_company.manage`;
 * the same customer-side permissions gate the existing bearer-User surface.
 * The care-only POST instead consumes a signed-handoff-issued single-use
 * exchange and checks the attested actor/property/occupancy server-side;
 * it never borrows the represented PIC's local session.
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
  router.get(
    '/handyman/requests',
    auth,
    read,
    listHandymanServiceRequestsHandler,
  );
  router.post(
    '/handyman/requests',
    auth,
    manage,
    createHandymanServiceRequestHandler,
  );
  // PART 04: care-specific, exchange-token-only authority. Never apply the
  // local-User bearer/RBAC middleware here (no BM care User/session exists).
  router.post('/handyman/requests/care', createCareHandymanServiceRequestHandler);
  router.get(
    '/handyman/requests/:handymanRequestId',
    auth,
    read,
    getHandymanServiceRequestDetailHandler,
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
