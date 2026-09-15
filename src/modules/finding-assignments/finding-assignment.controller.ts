import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import { findingService, parseFindingIdParam } from '../findings';
import { assertFindingActionAllowed } from '../findings/finding-action.authority';
import { findingAssignmentService } from './finding-assignment.service';
import {
  parseAssignFindingBody,
  parseFindingAssignmentIdParam,
  parseUpdateFindingAssignmentBody,
} from './finding-assignment.validation';

const param = (value: string | string[]) => Array.isArray(value) ? '' : value;
async function authorized(req: Request): Promise<string> {
  if (!req.auth) throw authenticationRequiredError();
  const findingId = parseFindingIdParam(param(req.params.id));
  const finding = await findingService.getFindingById(findingId);
  await contextAccessService.assertBuildingAccess(req.auth.userId, finding.buildingId);
  return findingId;
}
export async function assignFindingHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const findingId = await authorized(req);
    await assertFindingActionAllowed(findingId, req.auth!.userId, 'ASSIGN');
    const input = parseAssignFindingBody(req.body);
    sendSuccess(res, await findingAssignmentService.assignFinding({
      ...input, findingId, assignedByUserId: req.auth!.userId,
    }), 201);
  } catch (error) { next(error); }
}
export async function listFindingAssignmentsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const findingId = await authorized(req);
    sendSuccess(res, await findingAssignmentService.listFindingAssignments(findingId));
  } catch (error) { next(error); }
}
export async function getCurrentFindingAssignmentHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const findingId = await authorized(req);
    sendSuccess(res, await findingAssignmentService.getCurrentFindingAssignment(findingId));
  } catch (error) { next(error); }
}
export async function updateFindingAssignmentHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const findingId = await authorized(req);
    await assertFindingActionAllowed(findingId, req.auth!.userId, 'ASSIGN');
    const assignmentId = parseFindingAssignmentIdParam(param(req.params.assignmentId));
    const body = parseUpdateFindingAssignmentBody(req.body);
    if ('deactivate' in body) {
      sendSuccess(
        res,
        await findingAssignmentService.deactivateFindingAssignment(
          findingId,
          assignmentId,
          req.auth!.userId,
        ),
      );
      return;
    }
    sendSuccess(res, await findingAssignmentService.reassignFinding(findingId, assignmentId, {
      ...body.reassign, findingId, assignedByUserId: req.auth!.userId,
    }));
  } catch (error) { next(error); }
}
