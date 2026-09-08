import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import { patrolRouteService } from './patrol-route.service';
import {
  parseCreatePatrolRouteBody,
  parseCreatePatrolRoutePointBody,
  parsePatrolRouteBuildingIdParam,
  parsePatrolRouteIdParam,
  parsePatrolRoutePointIdParam,
  parseUpdatePatrolRouteBody,
  parseUpdatePatrolRoutePointBody,
} from './patrol-route.validation';

function paramString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

/* ------------------------------------------------------------------ */
/*  Patrol Route                                                       */
/* ------------------------------------------------------------------ */

export async function createPatrolRouteHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buildingId = parsePatrolRouteBuildingIdParam(
      paramString(req.params.buildingId),
    );
    const input = parseCreatePatrolRouteBody(req.body);
    const route = await patrolRouteService.createPatrolRoute({
      ...input,
      buildingId,
    });
    sendSuccess(res, route, 201);
  } catch (error) {
    next(error);
  }
}

export async function listBuildingPatrolRoutesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buildingId = parsePatrolRouteBuildingIdParam(
      paramString(req.params.buildingId),
    );
    const routes =
      await patrolRouteService.listPatrolRoutesByBuilding(buildingId);
    sendSuccess(res, routes);
  } catch (error) {
    next(error);
  }
}

export async function getPatrolRouteHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parsePatrolRouteIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const route = await patrolRouteService.getPatrolRouteById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      route.buildingId,
    );

    sendSuccess(res, route);
  } catch (error) {
    next(error);
  }
}

export async function updatePatrolRouteHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parsePatrolRouteIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const existing = await patrolRouteService.getPatrolRouteById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      existing.buildingId,
    );

    const input = parseUpdatePatrolRouteBody(req.body);
    const updated = await patrolRouteService.updatePatrolRoute(id, input);
    sendSuccess(res, updated);
  } catch (error) {
    next(error);
  }
}

/* ------------------------------------------------------------------ */
/*  Patrol Route Point                                                 */
/* ------------------------------------------------------------------ */

export async function addPatrolRoutePointHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const routeId = parsePatrolRouteIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const route = await patrolRouteService.getPatrolRouteById(routeId);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      route.buildingId,
    );

    const input = parseCreatePatrolRoutePointBody(req.body);
    const point = await patrolRouteService.addPatrolRoutePoint({
      ...input,
      patrolRouteId: routeId,
    });
    sendSuccess(res, point, 201);
  } catch (error) {
    next(error);
  }
}

export async function listPatrolRoutePointsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const routeId = parsePatrolRouteIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const route = await patrolRouteService.getPatrolRouteById(routeId);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      route.buildingId,
    );

    const points =
      await patrolRouteService.listPatrolRoutePoints(routeId);
    sendSuccess(res, points);
  } catch (error) {
    next(error);
  }
}

export async function updatePatrolRoutePointHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const pointId = parsePatrolRoutePointIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const updated = await patrolRouteService.updatePatrolRoutePoint(
      pointId,
      parseUpdatePatrolRoutePointBody(req.body),
    );
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      updated.buildingId,
    );

    sendSuccess(res, updated);
  } catch (error) {
    next(error);
  }
}
