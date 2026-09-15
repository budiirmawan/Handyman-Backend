import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { patrolExecutionService } from './patrol-execution.service';
import {
  parseCompleteBody,
  parsePatrolExecutionBuildingIdParam,
  parsePatrolExecutionFilter,
  parsePatrolExecutionIdParam,
  parsePatrolExecutionPointIdParam,
  parsePatrolExecutionVisitIdParam,
  parseUpdateVisitBody,
  parseVisitBody,
} from './patrol-execution.validation';

function paramString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

function getActorUserId(req: Request): string {
  if (!req.auth) {
    throw authenticationRequiredError();
  }
  return req.auth.userId;
}

export async function listBuildingPatrolExecutionsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buildingId = parsePatrolExecutionBuildingIdParam(
      paramString(req.params.buildingId),
    );
    const actorUserId = getActorUserId(req);
    const filter = parsePatrolExecutionFilter(
      req.query as Record<string, unknown>,
    );
    const results =
      await patrolExecutionService.listPatrolExecutionsByBuilding(
        buildingId,
        actorUserId,
        filter,
      );
    sendSuccess(res, results);
  } catch (error) {
    next(error);
  }
}

export async function getPatrolExecutionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parsePatrolExecutionIdParam(paramString(req.params.id));
    const actorUserId = getActorUserId(req);
    const result =
      await patrolExecutionService.getPatrolExecutionById(id, actorUserId);
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

export async function startPatrolExecutionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parsePatrolExecutionIdParam(paramString(req.params.id));
    const actorUserId = getActorUserId(req);
    const result = await patrolExecutionService.startPatrolExecution(
      id,
      actorUserId,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

export async function completePatrolExecutionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parsePatrolExecutionIdParam(paramString(req.params.id));
    const actorUserId = getActorUserId(req);
    const { completionNotes } = parseCompleteBody(req.body);
    const result = await patrolExecutionService.completePatrolExecution(
      id,
      actorUserId,
      completionNotes,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

export async function visitPatrolPointHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parsePatrolExecutionIdParam(paramString(req.params.id));
    const pointId = parsePatrolExecutionPointIdParam(
      paramString(req.params.pointId),
    );
    const actorUserId = getActorUserId(req);
    const input = parseVisitBody({ ...req.body, patrolRoutePointId: pointId });
    const result = await patrolExecutionService.recordPatrolPointVisit(
      id,
      input,
      actorUserId,
    );
    sendSuccess(res, result, 201);
  } catch (error) {
    next(error);
  }
}

export async function listPatrolPointVisitsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parsePatrolExecutionIdParam(paramString(req.params.id));
    const actorUserId = getActorUserId(req);
    const results = await patrolExecutionService.listPatrolPointVisits(
      id,
      actorUserId,
    );
    sendSuccess(res, results);
  } catch (error) {
    next(error);
  }
}

export async function updatePatrolPointVisitHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const visitId = parsePatrolExecutionVisitIdParam(
      paramString(req.params.id),
    );
    const actorUserId = getActorUserId(req);
    const input = parseUpdateVisitBody(req.body);
    const result = await patrolExecutionService.updatePatrolPointVisit(
      visitId,
      input,
      actorUserId,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}
