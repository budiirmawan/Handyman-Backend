import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { externalWorkforceService } from './external-workforce.service';
import {
  parseCreateExternalWorkforceLinkBody,
  parseExternalOrganizationIdParam,
  parseUpdateExternalWorkforceLinkBody,
  parseWorkforceProfileIdParam,
} from './external-workforce.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

export async function createExternalWorkforceLinkHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    // The Workforce Profile always comes from the route, never from the body.
    const workforceProfileId = parseWorkforceProfileIdParam(
      paramString(req.params.workforceId),
    );
    const input = parseCreateExternalWorkforceLinkBody(req.body);
    const link = await externalWorkforceService.createExternalWorkforceLink({
      ...input,
      workforceProfileId,
    });
    sendSuccess(res, link, 201);
  } catch (error) {
    next(error);
  }
}

/** Returns the single affiliation for a (workforce, external organization) pair. */
export async function getExternalWorkforceLinkHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const workforceProfileId = parseWorkforceProfileIdParam(
      paramString(req.params.workforceId),
    );
    const externalOrganizationId = parseExternalOrganizationIdParam(
      paramString(req.params.externalOrganizationId),
    );
    const link = await externalWorkforceService.getExternalWorkforceLink(
      workforceProfileId,
      externalOrganizationId,
    );
    sendSuccess(res, link);
  } catch (error) {
    next(error);
  }
}

/** Lists every external affiliation held by one Workforce Profile. */
export async function listWorkforceAffiliationsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const workforceProfileId = parseWorkforceProfileIdParam(
      paramString(req.params.workforceId),
    );
    const links = await externalWorkforceService.listWorkforceAffiliations(
      workforceProfileId,
    );
    sendSuccess(res, links);
  } catch (error) {
    next(error);
  }
}

/**
 * Lists the external workforce affiliated with one External Organization —
 * the vendor's external personnel roster.
 */
export async function listExternalOrganizationWorkforceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const externalOrganizationId = parseExternalOrganizationIdParam(
      paramString(req.params.externalOrganizationId),
    );
    const links =
      await externalWorkforceService.listExternalOrganizationWorkforce(
        externalOrganizationId,
      );
    sendSuccess(res, links);
  } catch (error) {
    next(error);
  }
}

/**
 * Updates an affiliation. Deactivation is the same endpoint with
 * `{ "status": "INACTIVE" }` — the row is kept for auditability.
 */
export async function updateExternalWorkforceLinkHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const workforceProfileId = parseWorkforceProfileIdParam(
      paramString(req.params.workforceId),
    );
    const externalOrganizationId = parseExternalOrganizationIdParam(
      paramString(req.params.externalOrganizationId),
    );
    const input = parseUpdateExternalWorkforceLinkBody(req.body);
    const link = await externalWorkforceService.updateExternalWorkforceLink(
      workforceProfileId,
      externalOrganizationId,
      input,
    );
    sendSuccess(res, link);
  } catch (error) {
    next(error);
  }
}
