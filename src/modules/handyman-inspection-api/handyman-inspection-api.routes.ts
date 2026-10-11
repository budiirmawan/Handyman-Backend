import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requireAnyPermission, requirePermission } from '../auth/rbac.middleware';
import {
  getHandymanInspectionAssignmentHandler,
  getHandymanInspectionReportHandler,
  getHandymanInspectionReportsHandler,
  postHandymanInspectionAssignmentHandler,
  postHandymanInspectionReportHandler,
  postHandymanInspectionReportReviewHandler,
} from './handyman-inspection-api.controller';

/**
 * CR-HM-INSPECTION-01 PART A — pre-quotation Field inspection assignment
 * surface (owner-approved additive authority).
 *
 *   POST /handyman/requests/:handymanRequestId/inspection-assignment
 *        handyman.operations.inspection.assign            write
 *   GET  /handyman/requests/:handymanRequestId/inspection-assignment
 *        tenant_company.read | handyman.operations.request.read    read
 *
 * CR-HM-INSPECTION-01 PART B (same surface, still separate from the frozen
 * lifecycle router):
 *
 *   POST   .../inspection-reports
 *          handyman.field.inspection.report.submit                  write
 *   GET    .../inspection-reports          scoped read
 *   GET    .../inspection-reports/:reportId                        scoped read
 *   POST   .../inspection-reports/:reportId/review
 *          handyman.operations.inspection.report.review            write
 *
 * This is a SEPARATE surface from the frozen eight-operation CR-HM-03
 * lifecycle router: the lifecycle router keeps its exact paths and its reads,
 * while its in-scope `POST /inspection` write now requires the dedicated Field
 * authority AND the active assignment enforced by the service (one writer,
 * no `tenant_company.manage` bypass).
 *
 * Writes here are strictly additive to the frozen F8 boundary: no request
 * status changes, no Execution Scope, no provider/crew identity, no
 * quotation, price or PIC authority. Reads reuse the existing scoped
 * request-read admission and the service applies the exact-Building guard.
 */
export function createHandymanInspectionApiRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const assignWrite = requirePermission(
    'handyman.operations.inspection.assign',
  );
  const reportWrite = requirePermission(
    'handyman.field.inspection.report.submit',
  );
  const reportReview = requirePermission(
    'handyman.operations.inspection.report.review',
  );
  /**
   * Read admission: the existing scoped request-read codes PLUS this
   * surface's own dedicated codes, so the actor who must act (assigned Field
   * inspector, Operations assigner/reviewer) can read what they act on. The
   * real wall stays in the service: the exact-Building guard derived from
   * the request.
   */
  const read = requireAnyPermission([
    'tenant_company.read',
    'handyman.operations.request.read',
    'handyman.field.inspection.report.submit',
    'handyman.operations.inspection.assign',
    'handyman.operations.inspection.report.review',
  ]);

  router.post(
    '/handyman/requests/:handymanRequestId/inspection-assignment',
    auth,
    assignWrite,
    postHandymanInspectionAssignmentHandler,
  );
  router.get(
    '/handyman/requests/:handymanRequestId/inspection-assignment',
    auth,
    read,
    getHandymanInspectionAssignmentHandler,
  );

  // ---- PART B — versioned Field reports + Operations review ---------------
  router.post(
    '/handyman/requests/:handymanRequestId/inspection-reports',
    auth,
    reportWrite,
    postHandymanInspectionReportHandler,
  );
  router.get(
    '/handyman/requests/:handymanRequestId/inspection-reports',
    auth,
    read,
    getHandymanInspectionReportsHandler,
  );
  router.get(
    '/handyman/requests/:handymanRequestId/inspection-reports/:reportId',
    auth,
    read,
    getHandymanInspectionReportHandler,
  );
  router.post(
    '/handyman/requests/:handymanRequestId/inspection-reports/:reportId/review',
    auth,
    reportReview,
    postHandymanInspectionReportReviewHandler,
  );

  return router;
}
