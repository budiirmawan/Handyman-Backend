import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { buildingAssignmentService } from './building-assignment.service';
import {
  parseAssignmentBuildingIdParam,
  parseAssignmentUserIdParam,
  parseCreateAssignmentBody,
} from './building-assignment.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

export async function createAssignmentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId = parseAssignmentUserIdParam(paramString(req.params.userId));
    const input = parseCreateAssignmentBody(req.body);
    const assignment = await buildingAssignmentService.createAssignment(
      userId,
      input,
      req.auth.userId,
    );
    sendSuccess(res, assignment, 201);
  } catch (error) {
    next(error);
  }
}

export async function listUserBuildingsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId = parseAssignmentUserIdParam(paramString(req.params.userId));
    const assignments = await buildingAssignmentService.listUserAssignments(userId);
    sendSuccess(res, assignments);
  } catch (error) {
    next(error);
  }
}

export async function deactivateAssignmentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId = parseAssignmentUserIdParam(paramString(req.params.userId));
    const buildingId = parseAssignmentBuildingIdParam(
      paramString(req.params.buildingId),
    );
    const assignment = await buildingAssignmentService.deactivateAssignment(
      userId,
      buildingId,
    );
    sendSuccess(res, assignment);
  } catch (error) {
    next(error);
  }
}

export async function currentUserBuildingsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const contexts = await buildingAssignmentService.resolveBuildingsForUser(
      req.auth.userId,
    );
    sendSuccess(res, contexts);
  } catch (error) {
    next(error);
  }
}
