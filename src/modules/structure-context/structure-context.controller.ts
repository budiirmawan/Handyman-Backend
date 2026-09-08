import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { parseBuildingIdParam } from '../buildings';
import { contextAccessService } from '../context-access';
import { parseFunctionalLocationIdParam } from '../functional-locations';
import { functionalLocationRepository } from '../functional-locations';
import { functionalLocationNotFoundError } from '../functional-locations';
import { structureContextService } from './structure-context.service';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

export async function getBuildingHierarchyHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buildingId = parseBuildingIdParam(paramString(req.params.buildingId));
    const hierarchy =
      await structureContextService.resolveBuildingHierarchy(buildingId);
    sendSuccess(res, hierarchy);
  } catch (error) {
    next(error);
  }
}

/**
 * `GET /functional-locations/:id/context` carries no `buildingId` route
 * parameter, so BE-02 Building isolation is enforced here: the Functional
 * Location is loaded first (unknown id → 404), then the caller must hold an
 * ACTIVE assignment to its Building (403 BUILDING_ACCESS_DENIED otherwise).
 * The response is location hierarchy ONLY — never Asset/Equipment records.
 */
export async function getFunctionalLocationContextHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseFunctionalLocationIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const record = await functionalLocationRepository.findById(id);
    if (!record) {
      throw functionalLocationNotFoundError();
    }
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      record.buildingId,
    );

    const context =
      await structureContextService.resolveFunctionalLocationContext(id);
    sendSuccess(res, context);
  } catch (error) {
    next(error);
  }
}
