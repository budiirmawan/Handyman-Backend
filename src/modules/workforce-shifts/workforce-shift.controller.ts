import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { workforceShiftService } from './workforce-shift.service';
import {
  parseAssignWorkforceShiftBody,
  parseShiftIdParam,
  parseUpdateWorkforceShiftBody,
  parseWorkforceIdParam,
} from './workforce-shift.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

export async function assignWorkforceShiftHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    // The Workforce Profile always comes from the route, never from the body.
    const workforceProfileId = parseWorkforceIdParam(
      paramString(req.params.workforceId),
    );
    const input = parseAssignWorkforceShiftBody(req.body);
    const assignment = await workforceShiftService.assignShiftToWorkforce({
      ...input,
      workforceProfileId,
    });
    sendSuccess(res, assignment, 201);
  } catch (error) {
    next(error);
  }
}

export async function listWorkforceShiftsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const workforceProfileId = parseWorkforceIdParam(
      paramString(req.params.workforceId),
    );
    const assignments =
      await workforceShiftService.listWorkforceShifts(workforceProfileId);
    sendSuccess(res, assignments);
  } catch (error) {
    next(error);
  }
}

/**
 * Updates an assignment. Deactivation is the same endpoint with
 * `{ "status": "INACTIVE" }` — the row is kept for auditability.
 */
export async function updateWorkforceShiftHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const workforceProfileId = parseWorkforceIdParam(
      paramString(req.params.workforceId),
    );
    const shiftId = parseShiftIdParam(paramString(req.params.shiftId));
    const input = parseUpdateWorkforceShiftBody(req.body);
    const assignment =
      await workforceShiftService.updateWorkforceShiftAssignment(
        workforceProfileId,
        shiftId,
        input,
      );
    sendSuccess(res, assignment);
  } catch (error) {
    next(error);
  }
}
