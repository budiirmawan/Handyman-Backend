import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import {
  dailyCleaningNotFoundError,
  dailyCleaningRepository,
  parseDailyCleaningFilter,
} from '../daily-cleaning';
import { cleaningAssignmentService } from './cleaning-assignment.service';
import {
  parseCreateCleaningAssignmentBody,
  parseDailyCleaningIdParam,
  parseTeamIdParam,
  parseWorkforceIdParam,
} from './cleaning-assignment.validation';

function paramString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

export async function createCleaningAssignmentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const taskId = parseDailyCleaningIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const task = await dailyCleaningRepository.findById(taskId);
    if (!task) {
      throw dailyCleaningNotFoundError();
    }

    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      task.building_id,
    );

    const input = parseCreateCleaningAssignmentBody(req.body);
    const result = await cleaningAssignmentService.assignDailyCleaning({
      ...input,
      taskId,
      assignedByUserId: req.auth.userId,
    });

    sendSuccess(res, result, 201);
  } catch (error) {
    next(error);
  }
}

export async function listCleaningAssignmentsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const taskId = parseDailyCleaningIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const task = await dailyCleaningRepository.findById(taskId);
    if (!task) {
      throw dailyCleaningNotFoundError();
    }

    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      task.building_id,
    );

    const results =
      await cleaningAssignmentService.listAssignmentsByTaskId(taskId);

    sendSuccess(res, results);
  } catch (error) {
    next(error);
  }
}

export async function listWorkforceDailyCleaningHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const workforceId = parseWorkforceIdParam(
      paramString(req.params.workforceId),
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const filter = parseDailyCleaningFilter(
      req.query as Record<string, unknown>,
    );
    const results =
      await cleaningAssignmentService.listDailyCleaningByWorkforce(
        workforceId,
        filter,
      );

    sendSuccess(res, results);
  } catch (error) {
    next(error);
  }
}

export async function listTeamDailyCleaningHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const teamId = parseTeamIdParam(paramString(req.params.teamId));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const filter = parseDailyCleaningFilter(
      req.query as Record<string, unknown>,
    );
    const results = await cleaningAssignmentService.listDailyCleaningByTeam(
      teamId,
      filter,
    );

    sendSuccess(res, results);
  } catch (error) {
    next(error);
  }
}
