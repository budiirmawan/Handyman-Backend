import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  cancelHandymanInspectionHandler,
  completeHandymanInspectionHandler,
  getHandymanInspectionHandler,
  getHandymanRequestServiceHandler,
  getHandymanRequestTriageHandler,
  listHandymanInspectionsHandler,
  listHandymanRequestServicesHandler,
  listHandymanRequestTriagesHandler,
  openHandymanInspectionHandler,
  selectHandymanRequestServiceHandler,
  supersedeHandymanRequestServiceSelectionHandler,
  triageHandymanRequestHandler,
} from './handyman-request-governance.controller';

/**
 * CR-HM-BE-03 RUN 4 — Handyman Request governance HTTP contract, registered
 * through the existing Asentra route composition (no separate server/runtime).
 * Every route requires an authenticated session; RBAC then gates per route
 * with the minimum correct permission:
 *
 * - `handyman_request.read`            → triage / selection / inspection reads
 * - `handyman_triage.manage`           → triage + re-triage
 * - `handyman_request_service.manage`  → service selection + supersede
 * - `handyman_inspection.manage`       → open / complete / cancel inspection
 *
 * Request scope comes from the route, the actor only from req.auth, and all
 * business authority (request lifecycle guards, tenant validation,
 * service-catalog governance, checklist binding, building access) stays in
 * the Run 1 governance services. There is deliberately NO free-text
 * service-classification endpoint.
 */
export function createHandymanRequestGovernanceRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('handyman_request.read');

  // Triage / re-triage + governed history reads.
  router.post(
    '/handyman-requests/:handymanRequestId/triages',
    auth,
    requirePermission('handyman_triage.manage'),
    triageHandymanRequestHandler,
  );
  router.get(
    '/handyman-requests/:handymanRequestId/triages',
    auth,
    read,
    listHandymanRequestTriagesHandler,
  );
  router.get(
    '/handyman-request-triages/:triageId',
    auth,
    read,
    getHandymanRequestTriageHandler,
  );

  // Request-service selection + history/current reads.
  router.post(
    '/handyman-requests/:handymanRequestId/services',
    auth,
    requirePermission('handyman_request_service.manage'),
    selectHandymanRequestServiceHandler,
  );
  router.get(
    '/handyman-requests/:handymanRequestId/services',
    auth,
    read,
    listHandymanRequestServicesHandler,
  );
  router.get(
    '/handyman-request-services/:selectionId',
    auth,
    read,
    getHandymanRequestServiceHandler,
  );
  router.post(
    '/handyman-request-services/:selectionId/supersede',
    auth,
    requirePermission('handyman_request_service.manage'),
    supersedeHandymanRequestServiceSelectionHandler,
  );

  // Inspection open / reads / complete / cancel.
  router.post(
    '/handyman-requests/:handymanRequestId/inspections',
    auth,
    requirePermission('handyman_inspection.manage'),
    openHandymanInspectionHandler,
  );
  router.get(
    '/handyman-requests/:handymanRequestId/inspections',
    auth,
    read,
    listHandymanInspectionsHandler,
  );
  router.get(
    '/handyman-inspections/:inspectionId',
    auth,
    read,
    getHandymanInspectionHandler,
  );
  router.post(
    '/handyman-inspections/:inspectionId/complete',
    auth,
    requirePermission('handyman_inspection.manage'),
    completeHandymanInspectionHandler,
  );
  router.post(
    '/handyman-inspections/:inspectionId/cancel',
    auth,
    requirePermission('handyman_inspection.manage'),
    cancelHandymanInspectionHandler,
  );

  return router;
}
