import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { workforceBuildingAssignmentService } from './workforce-building-assignment.service';
import {
  parseAssignWorkforceBuildingBody,
  parseBuildingIdParam,
  parseUpdateWorkforceBuildingBody,
  parseWorkforceIdParam,
} from './workforce-building-assignment.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

export async function assignWorkforceBuildingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    // The Workforce Profile always comes from the route, never from the body.
    const workforceProfileId = parseWorkforceIdParam(
      paramString(req.params.workforceId),
    );
    const input = parseAssignWorkforceBuildingBody(req.body);
    const assignment =
      await workforceBuildingAssignmentService.assignBuildingToWorkforce({
        ...input,
        workforceProfileId,
      });
    sendSuccess(res, assignment, 201);
  } catch (error) {
    next(error);
  }
}

export async function listWorkforceBuildingsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const workforceProfileId = parseWorkforceIdParam(
      paramString(req.params.workforceId),
    );
    const assignments =
      await workforceBuildingAssignmentService.listWorkforceBuildings(
        workforceProfileId,
      );
    sendSuccess(res, assignments);
  } catch (error) {
    next(error);
  }
}

/**
 * The workforce roster of a Building. Not an access list — who may *read* the
 * Building's data is BE-02F's `user_building_assignments`, a separate concern.
 */
export async function listBuildingWorkforceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buildingId = parseBuildingIdParam(
      paramString(req.params.buildingId),
    );
    const assignments =
      await workforceBuildingAssignmentService.listBuildingWorkforce(
        buildingId,
      );
    sendSuccess(res, assignments);
  } catch (error) {
    next(error);
  }
}

/**
 * Updates an assignment. Deactivation is the same endpoint with
 * `{ "status": "INACTIVE" }` — the row is kept for auditability.
 */
export async function updateWorkforceBuildingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const workforceProfileId = parseWorkforceIdParam(
      paramString(req.params.workforceId),
    );
    const buildingId = parseBuildingIdParam(
      paramString(req.params.buildingId),
    );
    const input = parseUpdateWorkforceBuildingBody(req.body);
    const assignment =
      await workforceBuildingAssignmentService.updateWorkforceBuildingAssignment(
        workforceProfileId,
        buildingId,
        input,
      );
    sendSuccess(res, assignment);
  } catch (error) {
    next(error);
  }
}
