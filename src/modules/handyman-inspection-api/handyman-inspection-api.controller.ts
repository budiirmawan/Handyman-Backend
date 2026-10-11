import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import {
  handymanRequestInspectionAssignmentService,
} from '../handyman-requests';
import {
  parseInspectionAssignmentBody,
  parseInspectionHandymanRequestIdParam,
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
