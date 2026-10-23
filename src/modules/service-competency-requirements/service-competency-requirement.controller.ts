import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { serviceCatalogRepository, serviceCatalogNotFoundError } from '../service-catalog';
import { serviceCompetencyRequirementService } from './service-competency-requirement.service';
import {
  parseRequirementIdParam,
  parseServiceCatalogIdParam,
  validateCreateCompetencyRequirementInput,
  validateListCompetencyRequirementsFilter,
  validateUpdateCompetencyRequirementInput,
} from './service-competency-requirement.validation';

/**
 * CR-HM-WORKER-COMPETENCY-01 PART 03A — competency requirement HTTP handlers.
 *
 * The transport does three things and nothing else: parse/validate the body,
 * take the actor from the authenticated session, and hand off to the service.
 * Client identity is NEVER read from the request — the service resolves it from
 * the catalog entry it authorises.
 */

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

async function entryClientId(serviceCatalogId: string): Promise<string> {
  const entry = await serviceCatalogRepository.findById(undefined, serviceCatalogId);
  if (!entry) throw serviceCatalogNotFoundError();
  return entry.clientId;
}

export async function createCompetencyRequirementHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const serviceCatalogId = parseServiceCatalogIdParam(param(req.params.id));
    const clientId = await entryClientId(serviceCatalogId);
    const input = validateCreateCompetencyRequirementInput(
      serviceCatalogId,
      clientId,
      req.body as Record<string, unknown>,
      actor(req),
    );
    sendSuccess(
      res,
      await serviceCompetencyRequirementService.createCompetencyRequirement(
        serviceCatalogId,
        input,
        actor(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function listCompetencyRequirementsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await serviceCompetencyRequirementService.listCompetencyRequirements(
        parseServiceCatalogIdParam(param(req.params.id)),
        validateListCompetencyRequirementsFilter(
          req.query as Record<string, unknown>,
        ),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getCompetencyRequirementHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await serviceCompetencyRequirementService.getCompetencyRequirement(
        parseServiceCatalogIdParam(param(req.params.id)),
        parseRequirementIdParam(param(req.params.requirementId)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function updateCompetencyRequirementHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const serviceCatalogId = parseServiceCatalogIdParam(param(req.params.id));
    const requirementId = parseRequirementIdParam(param(req.params.requirementId));
    const existing =
      await serviceCompetencyRequirementService.getCompetencyRequirement(
        serviceCatalogId,
        requirementId,
        actor(req),
      );
    sendSuccess(
      res,
      await serviceCompetencyRequirementService.updateCompetencyRequirement(
        serviceCatalogId,
        requirementId,
        validateUpdateCompetencyRequirementInput(
          existing.requirementType,
          req.body as Record<string, unknown>,
        ),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function deactivateCompetencyRequirementHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await serviceCompetencyRequirementService.deactivateCompetencyRequirement(
        parseServiceCatalogIdParam(param(req.params.id)),
        parseRequirementIdParam(param(req.params.requirementId)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}
