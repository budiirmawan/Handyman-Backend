/**
 * CR-HM-INSPECTION-01 — pre-quotation Field inspection authority surface.
 *
 * PART A (assignment) ships here; the versioned report/review surface of
 * PART B extends this same module so the inspection authority never leaks
 * into the frozen CR-HM-03 lifecycle router.
 */
export { createHandymanInspectionApiRouter } from './handyman-inspection-api.routes';
export {
  getHandymanInspectionAssignmentHandler,
  getHandymanInspectionReportHandler,
  getHandymanInspectionReportsHandler,
  postHandymanInspectionAssignmentHandler,
  postHandymanInspectionReportHandler,
  postHandymanInspectionReportReviewHandler,
} from './handyman-inspection-api.controller';
export {
  parseInspectionAssignmentBody,
  parseInspectionHandymanRequestIdParam,
  parseInspectionReportBody,
  parseInspectionReportIdParam,
  parseInspectionReviewBody,
} from './handyman-inspection-api.validation';
