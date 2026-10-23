import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../../shared/errors';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { isValidUuid } from '../clients';
import { workerCompetencyEligibilityService } from './worker-competency-eligibility.service';

/**
 * CR-HM-WORKER-COMPETENCY-01 PART 03A — eligibility / candidates transport.
 *
 * Both handlers are READ-ONLY and take the actor from the authenticated session.
 * The building scope (`assertBuildingScopedResourceAccess`) is enforced inside
 * the service, so a broad `tenant_company.read` never reaches another Client's
 * crews — the same rule the assignment surface already follows.
 */

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

function uuidOrValidationError(value: string, field: string): string {
  const raw = value.trim();
  if (!isValidUuid(raw)) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${field} must be a UUID.` },
    ]);
  }
  return raw;
}

export async function getCrewCompetencyEligibilityHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const crewIdRaw =
      (Array.isArray(req.query.crewId) ? req.query.crewId[0] : req.query.crewId) ??
      '';
    sendSuccess(
      res,
      await workerCompetencyEligibilityService.getCrewCompetencyEligibility(
        uuidOrValidationError(
          param(req.params.executionScopeId),
          'executionScopeId',
        ),
        uuidOrValidationError(String(crewIdRaw), 'crewId'),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function listCompetencyCandidatesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await workerCompetencyEligibilityService.listCompetencyCandidates(
        uuidOrValidationError(
          param(req.params.executionScopeId),
          'executionScopeId',
        ),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}
