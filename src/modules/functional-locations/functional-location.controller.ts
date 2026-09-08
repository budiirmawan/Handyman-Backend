import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import { functionalLocationService } from './functional-location.service';
import {
  parseCreateFunctionalLocationBody,
  parseFunctionalLocationBuildingIdParam,
  parseFunctionalLocationIdParam,
  parseSpaceIdQuery,
  parseUpdateFunctionalLocationBody,
} from './functional-location.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

export async function createFunctionalLocationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buildingId = parseFunctionalLocationBuildingIdParam(
      paramString(req.params.buildingId),
    );
    const input = parseCreateFunctionalLocationBody(req.body);
    const functionalLocation =
      await functionalLocationService.createFunctionalLocation({
        ...input,
        buildingId,
      });
    sendSuccess(res, functionalLocation, 201);
  } catch (error) {
    next(error);
  }
}

export async function listBuildingFunctionalLocationsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buildingId = parseFunctionalLocationBuildingIdParam(
      paramString(req.params.buildingId),
    );
    const spaceId = parseSpaceIdQuery(req.query.spaceId);
    const functionalLocations =
      await functionalLocationService.listFunctionalLocationsByBuilding(
        buildingId,
        spaceId,
      );
    sendSuccess(res, functionalLocations);
  } catch (error) {
    next(error);
  }
}

/**
 * `GET /functional-locations/:id` and `PATCH /functional-locations/:id`
 * carry no `buildingId` route parameter, so BE-02 Building isolation is
 * enforced here instead of via `requireBuildingAccess`: the Functional
 * Location is loaded first (unknown id → 404), then the caller must hold an
 * ACTIVE assignment to its Building (otherwise 403 BUILDING_ACCESS_DENIED).
 * Permission alone is never enough.
 */
export async function getFunctionalLocationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseFunctionalLocationIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const functionalLocation =
      await functionalLocationService.getFunctionalLocationById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      functionalLocation.buildingId,
    );

    sendSuccess(res, functionalLocation);
  } catch (error) {
    next(error);
  }
}

export async function updateFunctionalLocationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseFunctionalLocationIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const input = parseUpdateFunctionalLocationBody(req.body);

    const existing =
      await functionalLocationService.getFunctionalLocationById(id);
    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      existing.buildingId,
    );

    const functionalLocation =
      await functionalLocationService.updateFunctionalLocation(id, input);
    sendSuccess(res, functionalLocation);
  } catch (error) {
    next(error);
  }
}
