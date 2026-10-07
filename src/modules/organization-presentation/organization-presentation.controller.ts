import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { organizationPresentationService } from './organization-presentation.service';
import {
  parseCreateOrganizationPresentationBody,
  parseOrganizationPresentationBuildingId,
  parseOrganizationPresentationClientId,
  parseOrganizationPresentationId,
  parseUpdateOrganizationPresentationBody,
} from './organization-presentation.validation';

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function userId(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function createClientOrganizationPresentationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await organizationPresentationService.createClientOrganizationPresentation(
        parseOrganizationPresentationClientId(param(req.params.clientId)),
        parseCreateOrganizationPresentationBody(req.body),
        userId(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function getClientOrganizationPresentationForScopeHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await organizationPresentationService.getClientOrganizationPresentationForScope(
        parseOrganizationPresentationClientId(param(req.params.clientId)),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getEffectiveClientOrganizationPresentationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await organizationPresentationService.getEffectiveClientOrganizationPresentation(
        parseOrganizationPresentationClientId(param(req.params.clientId)),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getClientOrganizationPresentationByIdHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await organizationPresentationService.getClientOrganizationPresentationById(
        parseOrganizationPresentationId(param(req.params.id)),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function updateClientOrganizationPresentationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await organizationPresentationService.updateClientOrganizationPresentation(
        parseOrganizationPresentationId(param(req.params.id)),
        parseUpdateOrganizationPresentationBody(req.body),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function createBuildingOrganizationPresentationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await organizationPresentationService.createBuildingOrganizationPresentation(
        parseOrganizationPresentationBuildingId(param(req.params.buildingId)),
        parseCreateOrganizationPresentationBody(req.body),
        userId(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function getBuildingOrganizationPresentationForScopeHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await organizationPresentationService.getBuildingOrganizationPresentationForScope(
        parseOrganizationPresentationBuildingId(param(req.params.buildingId)),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getEffectiveBuildingOrganizationPresentationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await organizationPresentationService.getEffectiveBuildingOrganizationPresentation(
        parseOrganizationPresentationBuildingId(param(req.params.buildingId)),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getBuildingOrganizationPresentationByIdHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await organizationPresentationService.getBuildingOrganizationPresentationById(
        parseOrganizationPresentationId(param(req.params.id)),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function updateBuildingOrganizationPresentationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await organizationPresentationService.updateBuildingOrganizationPresentation(
        parseOrganizationPresentationId(param(req.params.id)),
        parseUpdateOrganizationPresentationBody(req.body),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}
