import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { handymanProviderEligibilityService } from './handyman-provider-eligibility.service';
import { handymanProviderService } from './handyman-provider.service';
import {
  parseCreateHandymanProviderHttpBody,
  parseHandymanProviderBuildingIdParam,
  parseHandymanProviderClientIdParam,
  parseHandymanProviderIdParam,
  parseUpdateHandymanProviderStatusHttpBody,
} from './handyman-provider.validation';

/**
 * CR-HM-BE-02 RUN 3 — Thin HTTP handlers for Handyman Provider designation
 * and building-scoped eligibility reads. All authority lives in the Run 1
 * designation service and the Run 2 eligibility service; these handlers only
 * parse governed inputs, derive the actor from the authenticated session
 * (never from the body), and delegate. Errors flow to the shared Express
 * error pipeline via `next(error)`.
 */

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function createHandymanProviderHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const clientId = parseHandymanProviderClientIdParam(param(req.params.clientId));
    const body = parseCreateHandymanProviderHttpBody(req.body);
    const designation = await handymanProviderService.designateHandymanProvider(
      { clientId, vendorId: body.vendorId },
      actor(req),
    );
    sendSuccess(res, designation, 201);
  } catch (error) {
    next(error);
  }
}

export async function listClientHandymanProvidersHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const clientId = parseHandymanProviderClientIdParam(param(req.params.clientId));
    const designations = await handymanProviderService.listHandymanProviders(
      clientId,
      actor(req),
    );
    sendSuccess(res, designations);
  } catch (error) {
    next(error);
  }
}

export async function getHandymanProviderHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const providerId = parseHandymanProviderIdParam(param(req.params.providerId));
    const designation = await handymanProviderService.getHandymanProviderById(
      providerId,
      actor(req),
    );
    sendSuccess(res, designation);
  } catch (error) {
    next(error);
  }
}

export async function updateHandymanProviderStatusHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const providerId = parseHandymanProviderIdParam(param(req.params.providerId));
    const body = parseUpdateHandymanProviderStatusHttpBody(req.body);
    const designation = await handymanProviderService.updateHandymanProviderStatus(
      providerId,
      { status: body.status },
      actor(req),
    );
    sendSuccess(res, designation);
  } catch (error) {
    next(error);
  }
}

export async function listBuildingHandymanProvidersHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buildingId = parseHandymanProviderBuildingIdParam(
      param(req.params.buildingId),
    );
    const providers =
      await handymanProviderEligibilityService.listAuthorizedHandymanProvidersForBuilding(
        buildingId,
        actor(req),
      );
    sendSuccess(res, providers);
  } catch (error) {
    next(error);
  }
}

export async function listBuildingHandymanProviderServiceEligibilitiesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buildingId = parseHandymanProviderBuildingIdParam(
      param(req.params.buildingId),
    );
    const providerId = parseHandymanProviderIdParam(param(req.params.providerId));
    const eligibilities =
      await handymanProviderEligibilityService.listHandymanProviderServiceEligibilities(
        buildingId,
        providerId,
        actor(req),
      );
    sendSuccess(res, eligibilities);
  } catch (error) {
    next(error);
  }
}
