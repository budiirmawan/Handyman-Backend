import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import {
  handymanRequestInspectionAssignmentService,
  handymanRequestInspectionReportService,
} from '../handyman-requests';
import {
  parseInspectionAssignmentBody,
  parseInspectionHandymanRequestIdParam,
  parseInspectionReportBody,
  parseInspectionReportIdParam,
  parseInspectionReviewBody,
} from './handyman-inspection-api.validation';

/**
 * CR-HM-INSPECTION-01 PART A — pre-quotation Field inspection assignment
 * handlers.
 *
 * Thin shells only: URL request id + whitelisted body + the authenticated
 * actor from `req.auth.userId` (never the body). The service remains the sole
 * authority for the inspection path, target eligibility, the single-active
 * rule and the supersession chain. No business rule exists in this layer.
 */

const p = (v: string | string[] | undefined) =>
  Array.isArray(v) ? v[0] : v;

/**
 * POST /handyman/requests/:handymanRequestId/inspection-assignment — assign
 * (201) or reassign (201) the Field inspector; an identical replay of the
 * current assignment creates no new fact (200).
 */
export async function postHandymanInspectionAssignmentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const handymanRequestId = parseInspectionHandymanRequestIdParam(
      p(req.params.handymanRequestId),
    );
    const input = parseInspectionAssignmentBody(req.body);
    const state = await handymanRequestInspectionAssignmentService
      .assignHandymanInspectionField(
        { ...input, handymanRequestId },
        req.auth.userId,
      );
    sendSuccess(res, state, state.changed ? 201 : 200);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /handyman/requests/:handymanRequestId/inspection-assignment — current
 * active assignment plus its immutable supersession history.
 */
export async function getHandymanInspectionAssignmentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const handymanRequestId = parseInspectionHandymanRequestIdParam(
      p(req.params.handymanRequestId),
    );
    const state = await handymanRequestInspectionAssignmentService
      .getHandymanInspectionAssignment(handymanRequestId, req.auth.userId);
    sendSuccess(res, state, 200);
  } catch (error) {
    next(error);
  }
}

/**
 * POST /handyman/requests/:handymanRequestId/inspection-reports — the
 * assigned Field inspector submits the next immutable report version.
 */
export async function postHandymanInspectionReportHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const handymanRequestId = parseInspectionHandymanRequestIdParam(
      p(req.params.handymanRequestId),
    );
    const input = parseInspectionReportBody(req.body);
    const report = await handymanRequestInspectionReportService
      .submitHandymanInspectionReport(
        { ...input, handymanRequestId },
        req.auth.userId,
      );
    sendSuccess(res, report, 201);
  } catch (error) {
    next(error);
  }
}

/** GET /handyman/requests/:handymanRequestId/inspection-reports — thread. */
export async function getHandymanInspectionReportsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const handymanRequestId = parseInspectionHandymanRequestIdParam(
      p(req.params.handymanRequestId),
    );
    const thread = await handymanRequestInspectionReportService
      .listHandymanInspectionReports(handymanRequestId, req.auth.userId);
    sendSuccess(res, thread, 200);
  } catch (error) {
    next(error);
  }
}

/** GET /handyman/requests/:handymanRequestId/inspection-reports/:reportId. */
export async function getHandymanInspectionReportHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const handymanRequestId = parseInspectionHandymanRequestIdParam(
      p(req.params.handymanRequestId),
    );
    const reportId = parseInspectionReportIdParam(p(req.params.reportId));
    const report = await handymanRequestInspectionReportService
      .getHandymanInspectionReport(
        handymanRequestId,
        reportId,
        req.auth.userId,
      );
    sendSuccess(res, report, 200);
  } catch (error) {
    next(error);
  }
}

/**
 * POST .../inspection-reports/:reportId/review — the ONE immutable
 * ACCEPTED/RETURNED decision for the latest version.
 */
export async function postHandymanInspectionReportReviewHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const handymanRequestId = parseInspectionHandymanRequestIdParam(
      p(req.params.handymanRequestId),
    );
    const reportId = parseInspectionReportIdParam(p(req.params.reportId));
    const input = parseInspectionReviewBody(req.body);
    const report = await handymanRequestInspectionReportService
      .reviewHandymanInspectionReport(
        { ...input, handymanRequestId, reportId },
        req.auth.userId,
      );
    sendSuccess(res, report, 201);
  } catch (error) {
    next(error);
  }
}
