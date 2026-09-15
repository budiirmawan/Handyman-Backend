import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import { housekeepingEvidenceService } from './housekeeping-evidence.service';
import {
  parseHousekeepingEvidenceSourceIdParam,
  parseHousekeepingEvidenceSourceTypeParam,
  parseSubmitHousekeepingEvidenceBody,
} from './housekeeping-evidence.validation';

function paramString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

export async function listHousekeepingEvidenceRequirementsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const sourceType = parseHousekeepingEvidenceSourceTypeParam(
      paramString(req.params.sourceType),
    );
    const sourceId = parseHousekeepingEvidenceSourceIdParam(
      paramString(req.params.sourceId),
    );

    const source =
      await housekeepingEvidenceService.resolveHousekeepingEvidenceSource(
        sourceType,
        sourceId,
      );

    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      source.buildingId,
    );

    const requirements =
      await housekeepingEvidenceService.listEvidenceRequirements(
        sourceType,
        sourceId,
      );

    sendSuccess(res, requirements);
  } catch (error) {
    next(error);
  }
}

export async function listHousekeepingEvidenceSubmissionsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const sourceType = parseHousekeepingEvidenceSourceTypeParam(
      paramString(req.params.sourceType),
    );
    const sourceId = parseHousekeepingEvidenceSourceIdParam(
      paramString(req.params.sourceId),
    );

    const source =
      await housekeepingEvidenceService.resolveHousekeepingEvidenceSource(
        sourceType,
        sourceId,
      );

    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      source.buildingId,
    );

    const submissions =
      await housekeepingEvidenceService.listEvidenceSubmissions(
        sourceType,
        sourceId,
      );

    sendSuccess(res, submissions);
  } catch (error) {
    next(error);
  }
}

export async function submitHousekeepingEvidenceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const sourceType = parseHousekeepingEvidenceSourceTypeParam(
      paramString(req.params.sourceType),
    );
    const sourceId = parseHousekeepingEvidenceSourceIdParam(
      paramString(req.params.sourceId),
    );

    const source =
      await housekeepingEvidenceService.resolveHousekeepingEvidenceSource(
        sourceType,
        sourceId,
      );

    await contextAccessService.assertBuildingAccess(
      req.auth.userId,
      source.buildingId,
    );

    const input = parseSubmitHousekeepingEvidenceBody(req.body);
    const result = await housekeepingEvidenceService.submitEvidence({
      ...input,
      sourceType,
      sourceId,
      submittedByUserId: req.auth.userId,
    });

    sendSuccess(res, result, 201);
  } catch (error) {
    next(error);
  }
}
