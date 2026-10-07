import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import { utilityMeterReadingEvidenceService } from './utility-meter-reading-evidence.service';
import {
  parseReadingEvidenceFilters,
  parseReadingEvidenceIdParam,
  parseReadingEvidenceReadingIdParam,
  parseSubmitReadingEvidenceBody,
} from './utility-meter-reading-evidence.validation';

/** BE-18F — Reading Evidence HTTP handlers. */

function paramString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

/** GET /utility/meter-readings/:id/evidence-requirements */
export async function listReadingEvidenceRequirementsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const meterReadingId = parseReadingEvidenceReadingIdParam(
      paramString(req.params.id),
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const requirements =
      await utilityMeterReadingEvidenceService.resolveReadingEvidenceRequirements(
        meterReadingId,
        req.auth.userId,
      );
    sendSuccess(res, requirements);
  } catch (error) {
    next(error);
  }
}

/** POST /utility/meter-readings/:id/evidence */
export async function submitReadingEvidenceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const meterReadingId = parseReadingEvidenceReadingIdParam(
      paramString(req.params.id),
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const input = parseSubmitReadingEvidenceBody(req.body);
    const evidence =
      await utilityMeterReadingEvidenceService.submitReadingEvidence({
        ...input,
        meterReadingId,
        submittedByUserId: req.auth.userId,
      });
    sendSuccess(res, evidence, 201);
  } catch (error) {
    next(error);
  }
}

/** GET /utility/meter-readings/:id/evidence (?includeRemoved=true) */
export async function listReadingEvidenceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const meterReadingId = parseReadingEvidenceReadingIdParam(
      paramString(req.params.id),
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const includeRemoved =
      String((req.query as Record<string, unknown>).includeRemoved ?? '') ===
      'true';

    const evidence = includeRemoved
      ? await utilityMeterReadingEvidenceService.listReadingEvidenceHistory(
          meterReadingId,
          req.auth.userId,
        )
      : await utilityMeterReadingEvidenceService.listReadingEvidence(
          meterReadingId,
          req.auth.userId,
        );
    sendSuccess(res, evidence);
  } catch (error) {
    next(error);
  }
}

/** GET /utility/meter-readings/:id/evidence-validation */
export async function validateReadingEvidenceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const meterReadingId = parseReadingEvidenceReadingIdParam(
      paramString(req.params.id),
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const readiness =
      await utilityMeterReadingEvidenceService.validateReadingEvidence(
        meterReadingId,
        req.auth.userId,
      );
    sendSuccess(res, readiness);
  } catch (error) {
    next(error);
  }
}

/** GET /utility/meter-reading-evidence?meterReadingId=&meterId=&buildingId= */
export async function listReadingEvidenceByFiltersHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const filters = parseReadingEvidenceFilters(
      req.query as Record<string, unknown>,
    );

    if (filters.buildingId) {
      await contextAccessService.assertBuildingAccess(
        req.auth.userId,
        filters.buildingId,
      );
    }
    const accessibleBuildingIds =
      await contextAccessService.getAccessibleBuildingIds(req.auth.userId);

    const evidence =
      await utilityMeterReadingEvidenceService.listReadingEvidenceByFilters(
        filters,
        req.auth.userId,
        accessibleBuildingIds,
      );
    sendSuccess(res, evidence);
  } catch (error) {
    next(error);
  }
}

/** GET /utility/meter-reading-evidence/:evidenceId */
export async function getReadingEvidenceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const evidenceId = parseReadingEvidenceIdParam(
      paramString(req.params.evidenceId),
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const evidence =
      await utilityMeterReadingEvidenceService.getReadingEvidence(
        evidenceId,
        req.auth.userId,
      );
    sendSuccess(res, evidence);
  } catch (error) {
    next(error);
  }
}

/** PATCH /utility/meter-reading-evidence/:evidenceId — BE-07 soft remove. */
export async function removeReadingEvidenceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const evidenceId = parseReadingEvidenceIdParam(
      paramString(req.params.evidenceId),
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const evidence =
      await utilityMeterReadingEvidenceService.removeReadingEvidence(
        evidenceId,
        req.auth.userId,
      );
    sendSuccess(res, evidence);
  } catch (error) {
    next(error);
  }
}
