import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { engineeringFindingService } from './engineering-finding.service';
import {
  parseCreateEngineeringFindingBody,
  parseLinkIdParam,
  parseListEngineeringFindingsQuery,
} from './engineering-finding.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

/** POST /engineering/findings — create/link a BE-09 Finding from an Engineering source. */
export async function createEngineeringFindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = parseCreateEngineeringFindingBody(
      req.body as Record<string, unknown>,
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const result = await engineeringFindingService.createEngineeringFinding(
      { ...body, createdByUserId: req.auth.userId },
      req.auth.userId,
    );

    sendSuccess(res, result, 201);
  } catch (error) {
    next(error);
  }
}

/** GET /engineering/findings?buildingId=&assetId=&sourceType=&status= */
export async function listEngineeringFindingsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const filters = parseListEngineeringFindingsQuery(
      req.query as Record<string, unknown>,
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    sendSuccess(
      res,
      await engineeringFindingService.listEngineeringFindings(
        filters,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}

/** GET /engineering/findings/:id */
export async function getEngineeringFindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseLinkIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    sendSuccess(
      res,
      await engineeringFindingService.getEngineeringFinding(id, req.auth.userId),
    );
  } catch (error) {
    next(error);
  }
}
