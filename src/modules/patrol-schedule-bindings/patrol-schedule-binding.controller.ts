import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import { patrolRouteService } from '../patrol-routes';
import { patrolScheduleBindingService } from './patrol-schedule-binding.service';
import {
  parseCreatePatrolScheduleBindingBody,
  parsePatrolRouteIdParam,
  parsePatrolScheduleBindingFilter,
  parsePatrolScheduleBindingIdParam,
  parseUpdatePatrolScheduleBindingBody,
} from './patrol-schedule-binding.validation';

function paramString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

export async function createPatrolScheduleBindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const patrolRouteId = parsePatrolRouteIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const route = await patrolRouteService.getPatrolRouteById(patrolRouteId);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      route.buildingId,
    );

    const input = parseCreatePatrolScheduleBindingBody(req.body);
    const result =
      await patrolScheduleBindingService.createPatrolScheduleBinding({
        ...input,
        patrolRouteId,
        createdByUserId: req.auth.userId,
      });

    sendSuccess(res, result, 201);
  } catch (error) {
    next(error);
  }
}

export async function listRoutePatrolScheduleBindingsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const patrolRouteId = parsePatrolRouteIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const route = await patrolRouteService.getPatrolRouteById(patrolRouteId);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      route.buildingId,
    );

    const filter = parsePatrolScheduleBindingFilter(
      req.query as Record<string, unknown>,
    );
    const results =
      await patrolScheduleBindingService.listPatrolScheduleBindingsByRoute(
        patrolRouteId,
        filter,
      );

    sendSuccess(res, results);
  } catch (error) {
    next(error);
  }
}

export async function getPatrolScheduleBindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parsePatrolScheduleBindingIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const binding =
      await patrolScheduleBindingService.getPatrolScheduleBindingById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      binding.buildingId,
    );

    sendSuccess(res, binding);
  } catch (error) {
    next(error);
  }
}

export async function updatePatrolScheduleBindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parsePatrolScheduleBindingIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const existing =
      await patrolScheduleBindingService.getPatrolScheduleBindingById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      existing.buildingId,
    );

    const input = parseUpdatePatrolScheduleBindingBody(req.body);
    const updated =
      await patrolScheduleBindingService.updatePatrolScheduleBinding(
        id,
        input,
      );

    sendSuccess(res, updated);
  } catch (error) {
    next(error);
  }
}
